// PAPER-FLIP-PREP (a) — the PostgreSQL execution journal writer lock waits out a Republish overlap
// on the boot path only. acquireWriter is try-once by default (a runtime writer fence fails fast on
// real contention — every CLI, REPLAY and test caller keeps that); when the paper boot creator injects
// lockWait { waitMs, intervalMs } the acquisition polls db.acquireSessionLockWithWait until it wins the
// lock or the budget is spent, then returns null unchanged. Pure: the lock is stubbed, sleep is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgJournal } from '../execution/journal.js';

// A fake lock session: its query answers the epoch INSERT ... RETURNING epoch and the UPDATE, and it
// reports held. release() is a no-op. This is enough for acquireWriter to establish the writer epoch.
const fakeLock = () => ({ query: async () => ({ rows: [{ epoch: 1 }] }), held: () => true, release: async () => {} });

// A fake Db: try-once acquireSessionLock always fails (the lock is held elsewhere); the waiting variant
// wins on the configured attempt. Both record how they were called so the test can prove which path ran.
function fakeDb({ winOnAttempt = 1 } = {}) {
  const calls = { tryOnce: 0, waited: 0, waitOpts: null };
  return {
    calls,
    schema: 'app',
    async acquireSessionLock() { calls.tryOnce += 1; return null; },
    async acquireSessionLockWithWait(name, opts) {
      calls.waited += 1; calls.waitOpts = opts; calls.name = name;
      // emulate the real wait: poll try-once until the budget is spent, sleeping between attempts
      const attempts = Math.max(1, Math.floor(opts.timeoutMs / Math.max(1, opts.intervalMs)));
      for (let i = 1; i <= attempts; i += 1) { if (i >= winOnAttempt) return fakeLock(); if (opts.sleep) await opts.sleep(opts.intervalMs); }
      return null;
    },
  };
}

test('acquireWriter default is try-once: no lockWait means one attempt, null on contention, the waiting variant is never called', async () => {
  const db = fakeDb();
  const jr = createPgJournal({ db, log: () => {} });
  const w = await jr.acquireWriter('paper:david');
  assert.equal(w, null, 'a held lock fails fast with no wait');
  assert.equal(db.calls.tryOnce, 1, 'exactly one try-once acquisition');
  assert.equal(db.calls.waited, 0, 'the waiting variant is never used without lockWait');
});

test('acquireWriter with lockWait waits out the overlap: it polls the waiting variant and returns the writer once the lock frees', async () => {
  const sleeps = [];
  const db = fakeDb({ winOnAttempt: 3 });
  const jr = createPgJournal({ db, log: () => {}, lockWait: { waitMs: 180_000, intervalMs: 5_000, sleep: async (ms) => { sleeps.push(ms); } } });
  const w = await jr.acquireWriter('paper:david');
  assert.ok(w && w.epoch === 1, 'the writer is established after the wait');
  assert.equal(db.calls.tryOnce, 0, 'the boot path uses the waiting variant, not the bare try-once');
  assert.equal(db.calls.waited, 1);
  assert.deepEqual(db.calls.waitOpts && { timeoutMs: db.calls.waitOpts.timeoutMs, intervalMs: db.calls.waitOpts.intervalMs }, { timeoutMs: 180_000, intervalMs: 5_000 });
  assert.equal(db.calls.name, 'serpent_execution_writer:app:paper:david');
  assert.deepEqual(sleeps, [5_000, 5_000], 'it slept the interval between the two losing attempts before winning on the third');
});

test('acquireWriter with lockWait still returns null (fail-closed) when the budget is spent without winning', async () => {
  const db = fakeDb({ winOnAttempt: Number.POSITIVE_INFINITY });
  const jr = createPgJournal({ db, log: () => {}, lockWait: { waitMs: 10_000, intervalMs: 5_000, sleep: async () => {} } });
  const w = await jr.acquireWriter('paper:david');
  assert.equal(w, null, 'a lock held for the whole budget still fails closed');
  assert.equal(db.calls.waited, 1);
});

test('lockWait is ignored when the Db has no acquireSessionLockWithWait (older backend / mock): falls back to try-once', async () => {
  const db = fakeDb(); delete db.acquireSessionLockWithWait;
  const jr = createPgJournal({ db, log: () => {}, lockWait: { waitMs: 180_000, intervalMs: 5_000 } });
  const w = await jr.acquireWriter('paper:david');
  assert.equal(w, null);
  assert.equal(db.calls.tryOnce, 1, 'without the waiting variant the writer fence stays try-once');
});
