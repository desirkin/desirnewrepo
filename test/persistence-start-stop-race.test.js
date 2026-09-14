// A shutdown that begins while startup is restoring durable state must win.
// All database behavior is an injected in-memory fake; no database connects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { getPersistence, startPersistence } from '../persistence/runtime.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function heldFinalLedgerPool({ entered, release, onEnd }) {
  let held = false; let runtimeStateReads = 0;
  const query = async (sql) => {
    const text = String(sql);
    if (text.includes('SELECT version FROM serpent_schema_migrations')) {
      return {
        rows: Array.from({ length: SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })),
        rowCount: SCHEMA_VERSION,
      };
    }
    // (lean trim step 1) the legacy ledger restore is gone; the FINAL restore query is now the second runtime-state read
    // (posture, then sim_pnl) — hold that one
    if (!held && text.includes('FROM serpent_runtime_state') && ++runtimeStateReads === 2) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    connect: async () => ({ query, release() {} }),
    on() {},
    end: async () => { onEnd(); },
  };
}

test('stop during final restore query cannot resurrect pump, restored state, or signal handlers', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-start-stop-race-'));
  const keys = ['COBRA_DATA_DIR', 'DATABASE_URL', 'SERPENT_DURABLE_REQUIRED', 'REPLIT_DEPLOYMENT'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.COBRA_DATA_DIR = dir;
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const entered = deferred();
  const release = deferred();
  const logs = [];
  let ends = 0;
  let retained;
  let starting;
  let stopping;

  t.after(async () => {
    release.resolve();
    try { await starting; } catch { /* assertion reports the primary failure */ }
    try { await retained?.stop(); } catch { /* injected pool is cleanup-safe */ }
    assert.equal(process.listenerCount('SIGINT'), beforeInt, 'test leaves no SIGINT listener behind');
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'test leaves no SIGTERM listener behind');
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  starting = startPersistence({
    registerSignals: true,
    log: (message) => logs.push(String(message)),
    dbOverrides: {
      url: 'postgresql://offline-fake/start-stop-race',
      poolFactory: () => heldFinalLedgerPool({ entered, release, onEnd: () => { ends += 1; } }),
      retries: 1,
    },
  });
  await entered.promise;
  retained = getPersistence();
  stopping = retained.stop();
  assert.equal(retained.stop(), stopping, 'shutdown remains one shared operation during startup');
  release.resolve();
  const started = await starting;
  await stopping;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(started, retained);
  assert.equal(retained._internal.stopped, true);
  assert.equal(retained._internal.restored, false, 'a stopped owner cannot report successful restore');
  assert.equal(retained._internal.pumpTimer, null, 'startup cannot install a pump after shutdown');
  assert.equal(retained._internal.retryTimer, null, 'startup cannot arm a retry after shutdown');
  assert.equal(retained._internal.signalHandlers, null, 'startup cannot resurrect signal ownership');
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  assert.equal(ends, 1, 'the pool closes exactly once');
  assert.equal(logs.some((line) => line.includes('restore complete; pump running')), false);
  assert.equal(logs.some((line) => line.includes('PERSISTENCE recovered')), false);
  assert.equal(retained.health().permissionLock, true);
  assert.equal(retained.health().status, 'UNAVAILABLE');
  assert.equal(retained.health().failureCategory, 'STOPPED');
  assert.deepEqual(await retained.pumpOnce(), { ran: false, refused: 'STOPPED' });
});
