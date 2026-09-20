// PUBLISH-FIX-84 (2026-09-20) — the night's "PERSISTENCE tx checkout failed after 6455ms: Error" lines. A transaction whose pool
// checkout fails with a connection-class error (a fresh connection to the managed Postgres that timed out) is retried ONCE after
// a short pause before it counts as a failure, flips `reachable` and engages the permission lock; a failure that survives the
// retry is logged with its message, not a bare "Error". Fake pool, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../persistence/db.js';

function flakyPool({ failFirst = 0, error = () => Object.assign(new Error('timeout exceeded when trying to connect'), {}) } = {}) {
  let connects = 0; const queries = [];
  const client = { query: async (sql) => { queries.push(String(sql)); return { rows: [{ ok: true }], rowCount: 1 }; }, release() {} };
  return {
    connects: () => connects, queries,
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => { connects += 1; if (connects <= failFirst) throw error(); return client; },
    on() {}, end: async () => {},
  };
}

test('FIX84-DB1. a checkout that times out once is retried and the transaction commits: no failure counted, reachable stays true, nothing logged', async () => {
  const pool = flakyPool({ failFirst: 1 }); const logs = [];
  const db = new Db({ url: 'postgresql://offline-fake/fix84', poolFactory: () => pool, log: (l) => logs.push(String(l)), retries: 1 });
  assert.equal(await db.connect(), true);
  const out = await db.tx(async (q) => { const r = await q('SELECT 1'); return r.rows[0].ok; });
  assert.equal(out, true);
  assert.equal(pool.connects(), 2, 'one failed checkout, one retry');
  assert.equal(db.reachable, true);
  const c = db.clocks(); assert.equal(c.checkoutFailures, 0); assert.equal(c.checkoutRetries, 1);
  assert.ok(!logs.some((l) => l.includes('checkout failed')), logs.join('\n'));
  assert.ok(pool.queries.includes('BEGIN') && pool.queries.includes('COMMIT'), 'the transaction ran on the retried client');
  await db.end();
});

test('FIX84-DB2. a checkout that fails twice is a failure: thrown, counted once, reachable false, logged with the attempt count and the message', async () => {
  const pool = flakyPool({ failFirst: 2 }); const logs = [];
  const db = new Db({ url: 'postgresql://offline-fake/fix84', poolFactory: () => pool, log: (l) => logs.push(String(l)), retries: 1 });
  await db.connect();
  await assert.rejects(db.tx(async () => 'never'), /timeout exceeded/);
  assert.equal(pool.connects(), 2);
  assert.equal(db.reachable, false);
  const c = db.clocks(); assert.equal(c.checkoutFailures, 1); assert.equal(c.checkoutRetries, 1);
  const line = logs.find((l) => l.includes('PERSISTENCE tx checkout failed'));
  assert.ok(line, logs.join('\n'));
  assert.match(line, /\(2 attempts\): Error: timeout exceeded when trying to connect/);
  await db.end();
});

test('FIX84-DB3. a checkout error that is NOT connection-class is never retried', async () => {
  const pool = flakyPool({ failFirst: 1, error: () => new Error('pool is ending') }); const logs = [];
  const db = new Db({ url: 'postgresql://offline-fake/fix84', poolFactory: () => pool, log: (l) => logs.push(String(l)), retries: 1 });
  await db.connect();
  await assert.rejects(db.tx(async () => 'never'), /pool is ending/);
  assert.equal(pool.connects(), 1, 'no retry for an ordinary error');
  assert.equal(db.clocks().checkoutRetries, 0);
  await db.end();
});
