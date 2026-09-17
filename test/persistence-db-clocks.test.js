// PUBLISH-FIX-50 — the DATABASE CLOCKS. The fix47 journal-commit clock (p50 2.2 s in production) starts when commit() is
// called, so it cannot separate the dispatcher chain wait from the pool checkout wait from the transaction itself. These
// tests pin the split: per transaction the checkout wait, the transaction duration, the statement count and the parameter
// bytes carried (the whole account state travels twice per journal commit); per query() its duration; the pool gauge;
// failed transactions still sampled; the ring is bounded; nothing in the clocks names the URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db, clockStats } from '../persistence/db.js';

const ok = () => ({ rows: [], rowCount: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ checkoutDelayMs = 0, queryDelayMs = 0, failOn = null, gauges = null } = {}) {
  const queries = [];
  const client = {
    async query(text, params) { queries.push({ text, params }); if (queryDelayMs) await sleep(queryDelayMs); if (failOn && String(text).startsWith(failOn)) { const e = new Error('boom'); e.code = '23505'; throw e; } return ok(); },
    release() {},
  };
  const pool = { async query() { return ok(); }, async connect() { if (checkoutDelayMs) await sleep(checkoutDelayMs); return client; }, on() {}, async end() {}, ...(gauges ?? {}) };
  const db = new Db({ url: 'postgresql://user:SECRET@offline/fixture', poolFactory: () => pool, retries: 1 });
  return { db, queries };
}

test('DBC-01. a transaction is clocked: checkout wait, its own duration, statements (BEGIN/COMMIT included) and the parameter bytes it carried; the slowest is named by its first real statement', async () => {
  const { db } = harness({ checkoutDelayMs: 30, queryDelayMs: 5 });
  assert.equal(await db.connect(), true);
  const state = JSON.stringify({ hypotheses: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`d${i}`, { decisionId: `d${i}`, triggerTs: i }])) });
  await db.tx(async (q) => { await q('SELECT revision, state FROM serpent_execution_accounts WHERE account_id = $1 FOR UPDATE', ['acct']); await q('INSERT INTO serpent_execution_events (event) VALUES ($1)', ['{"type":"HYPOTHESIS_LOCKED"}']); await q('UPDATE serpent_execution_accounts SET state = $2 WHERE account_id = $1', ['acct', state]); });
  const c = db.clocks();
  assert.equal(c.tx.count, 1); assert.equal(c.tx.total, 1);
  assert.ok(c.checkoutWait.p50 >= 25, `checkout wait ${c.checkoutWait.p50} should include the 30 ms pool wait`);
  assert.ok(c.tx.p50 >= 20 && c.tx.p50 < 1000, `tx ${c.tx.p50} ms should be the five statements, not the checkout`);
  assert.equal(c.txStatements.p50, 5, 'BEGIN + 3 statements + COMMIT');
  assert.ok(c.txParamBytes.p50 >= state.length + 4 + 26, `bytes carried ${c.txParamBytes.p50} include the state JSON`);
  assert.equal(c.slowestTx.statements, 5); assert.ok(c.slowestTx.first.startsWith('SELECT revision, state'), c.slowestTx.first);
  assert.equal(c.query.count, 0, 'no plain queries yet');
  assert.ok(!JSON.stringify(c).includes('SECRET'), 'the clocks never carry the URL');
});

test('DBC-02. plain query() is clocked separately; a failed transaction is still sampled (it held the connection); the pool gauge reads pg counts when present and null otherwise', async () => {
  const { db } = harness({ queryDelayMs: 2, failOn: 'INSERT', gauges: { totalCount: 5, idleCount: 1, waitingCount: 3 } });
  assert.equal(await db.connect(), true);
  await db.query('SELECT 1'); await db.query('SELECT 2');
  await assert.rejects(db.tx(async (q) => { await q('INSERT INTO serpent_x VALUES (1)'); }), /boom/);
  const c = db.clocks();
  assert.equal(c.query.count, 2); assert.equal(c.query.total, 2);
  assert.equal(c.tx.count, 1, 'the failed transaction is sampled'); assert.equal(c.txStatements.p50, 3, 'BEGIN + INSERT + ROLLBACK');
  assert.deepEqual(c.pool, { max: 5, total: 5, idle: 1, waiting: 3, lockSessions: 0 });
  const bare = harness(); await bare.db.connect(); assert.deepEqual(bare.db.clocks().pool, { max: 5, total: null, idle: null, waiting: null, lockSessions: 0 });
});

test('DBC-03. the ring is bounded at 2048 samples per clock and the totals keep counting; clockStats percentiles are nearest-rank', async () => {
  const { db } = harness();
  assert.equal(await db.connect(), true);
  for (let i = 0; i < 2100; i += 1) await db.tx(async () => null);
  const c = db.clocks(); assert.equal(c.tx.count, 2048); assert.equal(c.tx.total, 2100); assert.equal(c.txStatements.count, 2048);
  assert.deepEqual(clockStats([]), { count: 0, p50: null, p95: null, max: null });
  assert.deepEqual(clockStats([5, 1, 3, 2, 4]), { count: 5, p50: 3, p95: 5, max: 5 });
  assert.equal(clockStats(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
});
