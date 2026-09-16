// B-9 POOL-SLOT ACCOUNTING — the PostgreSQL pool has five slots. A session/advisory-lock HOLDER checks out exactly one
// slot for the lock's lifetime (deliberately long-lived, so the server releases the lock when the session dies). A
// caller that LOSES the advisory lock releases its client immediately, so the bounded wait helper
// (acquireSessionLockWithWait) sleeps holding NO slot — a waiter never consumes one of the five while it is only
// waiting. This drives the real Db over a checkout-counting fake pool (no PostgreSQL, injected sleep).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../persistence/db.js';

// A fake pg pool that counts concurrent checkouts and simulates ONE named advisory lock. `lockState.held` is the
// server-side lock; pg_try_advisory_lock wins only when it is free. Each client.release() decrements exactly once.
function countingPool(opts, lockState, captured) {
  captured.max = opts.max;
  let checkedOut = 0; let peak = 0;
  const mkClient = () => {
    let released = false;
    return {
      query: async (sql) => {
        if (/pg_try_advisory_lock/.test(sql)) { const ok = !lockState.held; if (ok) lockState.held = true; return { rows: [{ ok }] }; }
        if (/pg_advisory_unlock/.test(sql)) { lockState.held = false; return { rows: [{ ok: true }] }; }
        return { rows: [], rowCount: 0 };
      },
      release: () => { if (!released) { released = true; checkedOut -= 1; } },
      on() {}, once() {}, removeListener() {},
    };
  };
  return {
    query: async () => ({ rows: [{ one: 1 }], rowCount: 1 }),
    connect: async () => { checkedOut += 1; peak = Math.max(peak, checkedOut); return mkClient(); },
    on() {}, once() {}, end: async () => {},
    stats: () => ({ checkedOut, peak }),
  };
}

async function mkDb() {
  const lockState = { held: false };
  const captured = {};
  let pool;
  const db = new Db({ url: 'postgresql://offline-fake/pool-slots', log: () => {}, retries: 1, poolFactory: (opts) => (pool = countingPool(opts, lockState, captured)) });
  assert.equal(await db.connect(), true, 'the fake pool connects');
  return { db, lockState, captured, pool: () => pool };
}

test('B-9. the pool is sized to five slots (POOL_MAX)', async () => {
  const { captured } = await mkDb();
  assert.equal(captured.max, 5, 'one personal app, one small pool — exactly five connections');
});

test('B-9. a lock HOLDER checks out exactly one slot; a LOSER holds none; release returns the slot', async (t) => {
  const { db, pool } = await mkDb();
  t.after(() => db.end());
  const winner = await db.acquireSessionLock('owner');
  assert.ok(winner && winner.held(), 'first caller wins the advisory lock');
  assert.equal(pool().stats().checkedOut, 1, 'the holder occupies exactly one of the five slots');

  const loser = await db.acquireSessionLock('owner'); // lock already held
  assert.equal(loser, null, 'a second caller fails safely (try-once), no busy loop');
  assert.equal(pool().stats().checkedOut, 1, 'the loser released its client immediately — still only the holder occupies a slot');

  await winner.release();
  assert.equal(pool().stats().checkedOut, 0, 'release() returns the slot to the pool');
  assert.ok(pool().stats().peak <= 5, 'concurrent checkouts never exceeded the five-slot pool');
});

test('B-9. the bounded wait helper holds NO slot while sleeping (a waiter never consumes one of the five)', async () => {
  const { db, lockState, pool } = await mkDb();
  lockState.held = true; // an external holder never frees it: the waiter times out
  const duringSleep = [];
  const sleep = async () => { duringSleep.push(pool().stats().checkedOut); };
  const lock = await db.acquireSessionLockWithWait('owner', { timeoutMs: 20_000, intervalMs: 5_000, sleep });
  assert.equal(lock, null, 'budget spent -> null (caller fail-closes)');
  assert.ok(duringSleep.length >= 1, 'it actually waited');
  assert.deepEqual([...new Set(duringSleep)], [0], 'every sleep happened with ZERO clients checked out — the waiter holds no slot');
  assert.equal(pool().stats().checkedOut, 0, 'no slot leaked across the whole wait');
});

test('B-9. the wait helper takes exactly one slot the moment it wins, not before', async () => {
  const { db, lockState, pool } = await mkDb();
  lockState.held = true; // held for the first attempt, then freed before the retry
  const sleep = async () => { lockState.held = false; }; // the outgoing owner exits during the overlap
  const lock = await db.acquireSessionLockWithWait('owner', { timeoutMs: 20_000, intervalMs: 5_000, sleep });
  assert.ok(lock && lock.held(), 'it acquires once the lock frees');
  assert.equal(pool().stats().checkedOut, 1, 'exactly one slot held, only after winning');
  await lock.release();
  assert.equal(pool().stats().checkedOut, 0);
});
