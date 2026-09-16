// PUBLISH-FIX-5 — Db.acquireSessionLockWithWait: a bounded acquisition wait for a boot-time
// owner lock. Replit keeps the previous deployment container alive briefly after a Republish, so
// the outgoing process can still hold the external-checkpoint owner lock or the RUMOR-2 writer
// lock when the new boot tries to take it. The wait polls the try-once acquireSessionLock until it
// returns a handle or the budget is spent; on timeout it returns null and the caller's fail-closed
// path is unchanged. Pure: acquireSessionLock is stubbed, sleep is injected — no PostgreSQL, no delay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../persistence/db.js';

const withWait = Db.prototype.acquireSessionLockWithWait;

// A fake `this`: a scripted acquireSessionLock (shifts a queue of results), a log sink, and a sleep
// that records the intervals it was asked to wait (never a real timer).
function ctx(results) {
  const logs = [];
  const sleeps = [];
  const self = {
    log: (m) => logs.push(String(m)),
    acquireSessionLock: async () => (results.length ? results.shift() : null),
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  return { self, logs, sleeps, sleep };
}

test('PF5-1. acquires on the 3rd attempt: two waited retries, then the handle', async () => {
  const handle = { held: () => true, release: async () => {} };
  const { self, logs, sleeps, sleep } = ctx([null, null, handle]);
  const lock = await withWait.call(self, 'lock-a', { timeoutMs: 180_000, intervalMs: 5_000, sleep });
  assert.equal(lock, handle, 'returns the handle from the third attempt');
  assert.equal(logs.length, 2, 'one waited-attempt log per failed try before the win');
  assert.deepEqual(sleeps, [5_000, 5_000], 'waited the interval twice, then acquired');
  for (const l of logs) assert.match(l, /lock lock-a held elsewhere; waiting \d+\/\d+/);
});

test('PF5-2. times out and returns null when the lock is never free; the caller fail-closes', async () => {
  const { self, logs, sleeps, sleep } = ctx([]); // acquireSessionLock always returns null
  const lock = await withWait.call(self, 'lock-b', { timeoutMs: 15_000, intervalMs: 5_000, sleep });
  assert.equal(lock, null, 'budget spent -> null, so the caller keeps its existing fail-closed behaviour');
  // attempts = floor(15000/5000) = 3: two waited retries logged + slept, the third fails and returns null
  assert.equal(logs.length, 2, 'log lines are bounded to attempts - 1');
  assert.deepEqual(sleeps, [5_000, 5_000], 'never sleeps after the final attempt');
});

test('PF5-3. the waited-attempt log is bounded and names n/N; a zero budget is a single try-once with no wait', async () => {
  const { self, logs, sleeps, sleep } = ctx([]);
  const lock = await withWait.call(self, 'lock-c', { timeoutMs: 0, intervalMs: 5_000, sleep });
  assert.equal(lock, null);
  assert.equal(logs.length, 0, 'timeoutMs 0 -> exactly one attempt, no wait, no log (try-once)');
  assert.equal(sleeps.length, 0);

  // and a first-attempt success never waits or logs
  const handle = { held: () => true, release: async () => {} };
  const s2 = ctx([handle]);
  const got = await withWait.call(s2.self, 'lock-d', { timeoutMs: 180_000, intervalMs: 5_000, sleep: s2.sleep });
  assert.equal(got, handle); assert.equal(s2.logs.length, 0); assert.equal(s2.sleeps.length, 0);
});
