// Runtime shutdown must revoke permission before its asynchronous final drain.
// Every database operation is an injected in-memory fake; no database connects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { getPersistence, startPersistence } from '../persistence/runtime.js';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fakePool({ onEnd = () => {} } = {}) {
  const query = async (sql) => String(sql).includes('SELECT version FROM serpent_schema_migrations')
    ? { rows: Array.from({ length: SCHEMA_VERSION }, (_, i) => ({ version: i + 1 })), rowCount: SCHEMA_VERSION }
    : { rows: [], rowCount: 0 };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => onEnd() };
}
async function fixture(t, { configured = true, onEnd } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'persist-stopped-health-'));
  const keys = ['COBRA_DATA_DIR', 'DATABASE_URL', 'SERPENT_DURABLE_REQUIRED', 'REPLIT_DEPLOYMENT'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.COBRA_DATA_DIR = dir;
  const p = await startPersistence({ registerSignals: false, log: () => {}, dbOverrides: {
    url: configured ? 'postgresql://offline-fake/stopped-health' : '',
    poolFactory: () => fakePool({ onEnd }), retries: 1,
  } });
  t.after(async () => {
    try { await p.stop(); } catch { /* a test may deliberately fail pool shutdown */ }
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    rmSync(dir, { recursive: true, force: true });
  });
  return { p, dir };
}

test('stop immediately locks retained and singleton health while the final durability drain still owns the database', async (t) => {
  let ends = 0;
  const { p, dir } = await fixture(t, { onEnd: () => { ends += 1; } });
  assert.equal(p.health().permissionLock, false, 'positive control: actual fake-DB startup restored healthy state');
  const entered = deferred(); const release = deferred();
  p.repo.insertMemoryEvent = async () => { entered.resolve(); await release.promise; return { durable: true }; };
  mkdirSync(path.join(dir, 'memory'), { recursive: true });
  writeFileSync(path.join(dir, 'memory', 'events.jsonl'), '{"id":"held-before-stop"}\n');
  const active = p.pumpOnce(); await entered.promise;
  let stop;
  try {
    stop = p.stop();
    assert.equal(p.stop(), stop, 'repeated shutdown shares the exact promise');
    assert.equal(ends, 0, 'no database end until the active/final drain settles');
    assert.equal(p.health().permissionLock, true);
    assert.equal(p.health().stopped, true);
    assert.equal(p.health().status, 'UNAVAILABLE');
    assert.equal(p.health().failureCategory, 'STOPPED');
    assert.equal(getPersistence(), p, 'a retained singleton must not masquerade as an active authority');
    assert.equal(getPersistence().health().permissionLock, true);
    assert.deepEqual(await p.pumpOnce(), { ran: false, refused: 'STOPPED' });
  } finally { release.resolve(); await active; await stop; }
  assert.equal(ends, 1);
  assert.equal(p.health().permissionLock, true, 'pool completion cannot restore permission');
});

test('stopped local-only runtime cannot grant CLEAR or reopen database work for a restrictive snapshot', async (t) => {
  const { p } = await fixture(t, { configured: false });
  assert.equal(p.health().permissionLock, false, 'explicit unconfigured local development remains unchanged while running');
  assert.deepEqual(await p.durableClearOrRefuse(), { allow: true, mode: 'LOCAL_ONLY_UNCONFIGURED' });
  await p.stop();
  assert.equal(p.health().permissionLock, true);
  p.repo.durableClear = async () => assert.fail('stopped CLEAR must not touch the repository');
  p.repo.saveControlState = async () => assert.fail('stopped runtime must not reopen persistence after pool close');
  assert.deepEqual(await p.durableClearOrRefuse(), { allow: false, reason: 'STOPPED' });
  assert.deepEqual(await p.persistControlSnapshot({ kill: { active: true }, cage: null, vetoes: [] }), { durable: false, reason: 'STOPPED' });
});

test('CLEAR that was already awaiting its durable acknowledgement cannot grant local permission after shutdown', async (t) => {
  const { p } = await fixture(t);
  const entered = deferred(); const release = deferred();
  p.repo.durableClear = async () => { entered.resolve(); await release.promise; return { revision: 7, refused: false }; };
  const clearing = p.durableClearOrRefuse(); await entered.promise;
  try { await p.stop(); } finally { release.resolve(); }
  assert.deepEqual(await clearing, { allow: false, reason: 'STOPPED' });
  assert.equal(p.health().permissionLock, true);
});

test('failed pool shutdown never resurrects healthy permission and is not repeated', async (t) => {
  let ends = 0;
  const { p } = await fixture(t, { onEnd: () => { ends += 1; throw new Error('injected pool shutdown failure'); } });
  assert.equal(p.health().permissionLock, false);
  const stop = p.stop();
  await stop; // Db.end currently contains pool shutdown errors; permission must still stay locked.
  assert.equal(p.stop(), stop);
  assert.equal(ends, 1);
  assert.equal(p.health().permissionLock, true);
  assert.equal(p.health().failureCategory, 'STOPPED');
});
