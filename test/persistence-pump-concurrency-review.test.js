// Two pumpOnce calls must never share/advance one Tail concurrently. All
// database behavior is an in-memory fake; no provider or database is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'persist-pump-overlap-'));
process.env.COBRA_DATA_DIR = dataDir;

const { SCHEMA_VERSION } = await import('../persistence/schema.js');
const { startPersistence } = await import('../persistence/runtime.js');

function fakePool({ onEnd = () => {} } = {}) {
  const empty = async (sql) => {
    if (String(sql).includes('SELECT version FROM serpent_schema_migrations')) {
      return { rows: Array.from({ length: SCHEMA_VERSION }, (_, i) => ({ version: i + 1 })), rowCount: SCHEMA_VERSION };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: empty, release() {} };
  return {
    query: empty,
    connect: async () => client,
    on() {},
    end: async () => { onEnd(); },
  };
}

test('overlapping pumpOnce cannot publish a cursor beyond an unconfirmed durable write', async () => {
  let persistence;
  let releaseWrite;
  let firstPump;
  let dbEnded = false;
  const sigintBefore = process.listenerCount('SIGINT');
  const sigtermBefore = process.listenerCount('SIGTERM');
  try {
    persistence = await startPersistence({
      log: () => {},
      dbOverrides: {
        url: 'postgresql://offline-fake/pump-overlap',
        poolFactory: () => fakePool({ onEnd: () => { dbEnded = true; } }),
        retries: 1,
      },
      registerSignals: false,
    });
    assert.equal(persistence.health().restored, true);
    assert.equal(process.listenerCount('SIGINT'), sigintBefore);
    assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);

    const memoryDir = path.join(dataDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const memoryFile = path.join(memoryDir, 'events.jsonl');
    writeFileSync(memoryFile, `${JSON.stringify({ id: 'pending-durable-write' })}\n`, 'utf8');

    // Keep protective-state sync deterministic and offline. The first pump
    // advances its shared Tail in readNew(), then blocks before DB ack.
    persistence.repo.loadControlState = async () => ({
      revision: 1,
      state: { kill: null, cage: null, vetoes: [] },
    });
    let markWriteStarted;
    const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
    const heldWrite = new Promise((resolve) => { releaseWrite = resolve; });
    persistence.repo.insertMemoryEvent = async () => {
      markWriteStarted();
      await heldWrite;
      throw Object.assign(new Error('injected unconfirmed write'), { code: 'ECONNRESET' });
    };

    firstPump = persistence.pumpOnce();
    await writeStarted;

    // Without an in-flight guard, a second pump observes the already-advanced
    // shared Tail, sees no record, and publishes EOF while the first write is
    // still unconfirmed. A crash in this window would restart after evidence
    // that never became durable.
    const coalescedPump = persistence.pumpOnce();
    assert.equal(coalescedPump, firstPump, 'every ordinary caller receives the one in-flight cycle');
    const cursorFile = path.join(dataDir, 'persistence', 'cursors.json');
    assert.equal(existsSync(cursorFile), false, 'no cursor is published while its durable write is unresolved');
    assert.equal(statSync(memoryFile).size > 0, true);

    releaseWrite();
    await Promise.all([firstPump, coalescedPump]);
    firstPump = null;
    assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8')).offsets.memory, 0, 'a failed write rolls the cursor back');

    const durableIds = [];
    persistence.repo.insertMemoryEvent = async (row) => {
      durableIds.push(row.id);
      return { durable: true, outcome: 'INSERTED' };
    };
    await persistence.pumpOnce();
    assert.deepEqual(durableIds, ['pending-durable-write'], 'the rolled-back row retries exactly once');
    assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8')).offsets.memory, statSync(memoryFile).size);

    let releaseShutdownWrite;
    let markShutdownWriteStarted;
    const shutdownWriteStarted = new Promise((resolve) => { markShutdownWriteStarted = resolve; });
    const heldShutdownWrite = new Promise((resolve) => { releaseShutdownWrite = resolve; });
    releaseWrite = releaseShutdownWrite;
    persistence.repo.insertMemoryEvent = async (row) => {
      if (row.id === 'active-before-stop') {
        markShutdownWriteStarted();
        await heldShutdownWrite;
      }
      durableIds.push(row.id);
      return { durable: true, outcome: 'INSERTED' };
    };
    appendFileSync(memoryFile, `${JSON.stringify({ id: 'active-before-stop' })}\n`, 'utf8');
    firstPump = persistence.pumpOnce();
    await shutdownWriteStarted;
    appendFileSync(memoryFile, `${JSON.stringify({ id: 'late-during-stop' })}\n`, 'utf8');

    const stopping = persistence.stop();
    const repeatedStop = persistence.stop();
    assert.equal(repeatedStop, stopping, 'every stop caller awaits the exact same shutdown/drain promise');
    assert.equal(dbEnded, false, 'the database stays open while the ordered final drain is waiting');
    const refused = await persistence.pumpOnce();
    assert.deepEqual(refused, { ran: false, refused: 'STOPPED' }, 'new ordinary pump calls refuse after shutdown fences the runtime');
    releaseShutdownWrite();
    await stopping;
    firstPump = null;
    assert.equal(dbEnded, true, 'the database closes only after active and final pump drains settle');
    assert.deepEqual(durableIds, ['pending-durable-write', 'active-before-stop', 'late-during-stop']);
    assert.equal(JSON.parse(readFileSync(cursorFile, 'utf8')).offsets.memory, statSync(memoryFile).size, 'the one final drain captures bytes appended after the active Tail read');
  } finally {
    releaseWrite?.();
    await firstPump?.catch(() => {});
    await persistence?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('standalone persistence owns exactly one signal handler per signal and removes both during its shared stop', async () => {
  const standaloneDir = mkdtempSync(path.join(tmpdir(), 'persist-signal-owner-'));
  process.env.COBRA_DATA_DIR = standaloneDir;
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  let persistence;
  try {
    persistence = await startPersistence({
      log: () => {},
      dbOverrides: {
        url: 'postgresql://offline-fake/signal-owner',
        poolFactory: () => fakePool(),
        retries: 1,
      },
    });
    assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
    const stopping = persistence.stop();
    assert.equal(persistence.stop(), stopping);
    await stopping;
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  } finally {
    await persistence?.stop();
    rmSync(standaloneDir, { recursive: true, force: true });
  }
});
