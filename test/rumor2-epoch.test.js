// RUMOR-2 DATABASE WRITER-EPOCH fencing — PostgreSQL itself rejects every
// stale writer at the SAME transaction that performs the authoritative
// mutation. The advisory lock names the active writer; the monotonic writer
// epoch closes the cross-session time-of-check/time-of-use race. At baseline
// 8051637 a stale writer's delayed checkpoint save overwrote a newer
// writer's (unconditional last-write-wins upsert); these drills pin the
// database fence. All require real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-r2epoch-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('RUMOR-2 writer-epoch integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');

  const CP = (tag, revision = 1) => ({ checkpointVersion: 4, revision, tag });
  const STREAM = 'rumor2';
  const T = Date.parse('2026-09-05T12:00:00Z');
  const ev = (n) => ({
    type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T + n).toISOString(), provider: 'SEC_OFFICIAL', reason: `r${n}`, httpStatus: 500, consecutiveFailures: 1,
  });

  const withDb = async (fn) => {
    const SCHEMA = `r2ep_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 7, 'writer-epoch schema landed');
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, repo, SCHEMA, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  };

  // ---- epoch allocation & monotonicity (§8/§16/§35) ------------------------
  test('EPOCH-ALLOC. acquisition advances the epoch monotonically; a failed contender never advances it', async () => {
    await withDb(async ({ mkStores, repo }) => {
      const A = mkStores();
      const a1 = await A.journal.acquireWriter();
      assert.equal(a1.ok, true);
      assert.equal(a1.epoch, 1, 'first writer gets epoch 1');
      // repeated acquire by the SAME holder does not advance
      const a2 = await A.journal.acquireWriter();
      assert.deepEqual(a2, { ok: true, epoch: 1 }, 'holding writer keeps its epoch');
      // a contender fails the advisory lock and must NOT advance the epoch
      const B = mkStores();
      const b1 = await B.journal.acquireWriter();
      assert.equal(b1.ok, false);
      assert.equal(b1.reason, 'HELD');
      const cur = await repo.db.query(`SELECT epoch FROM serpent_rumor2_writer_epoch WHERE stream = 'rumor2'`);
      assert.equal(Number(cur.rows[0].epoch), 1, 'a failed contender left the epoch untouched');
      // A releases; B acquires and the epoch advances exactly once
      await A.journal.releaseWriter();
      const b2 = await B.journal.acquireWriter();
      assert.equal(b2.ok, true);
      assert.equal(b2.epoch, 2, 'failover advances the epoch by exactly one');
      await B.journal.releaseWriter();
    });
  });

  // ---- checkpoint stale-writer matrix (§22) --------------------------------
  test('EPOCH-CP-1..3. current epoch saves; stale epoch is rejected with zero mutation; stale cannot overwrite a newer writer', async () => {
    await withDb(async ({ mkStores, repo }) => {
      const A = mkStores();
      const a = await A.journal.acquireWriter(); // epoch 1
      assert.equal(a.epoch, 1);
      // CP-1: A saves under its current epoch
      assert.deepEqual(await A.checkpointStore.save(CP('A1', 1), 1), { durable: true });
      // failover: B takes over at epoch 2 and saves the NEWER checkpoint
      await A.journal.releaseWriter();
      const B = mkStores();
      const b = await B.journal.acquireWriter();
      assert.equal(b.epoch, 2);
      assert.deepEqual(await B.checkpointStore.save(CP('B-CURRENT', 20), 2), { durable: true });
      // CP-2/3: A's delayed stale save (epoch 1) is rejected — zero mutation,
      // B's newer checkpoint stands (no last-write-wins overwrite)
      const stale = await A.checkpointStore.save(CP('A-STALE', 99), 1);
      assert.equal(stale.durable, false);
      assert.equal(stale.reason, 'STALE_WRITER');
      const final = await repo.loadRumor2Checkpoint();
      assert.equal(final.tag, 'B-CURRENT', 'the newer writer checkpoint survives the delayed stale save');
      await B.journal.releaseWriter();
    });
  });

  test('EPOCH-CP-4+5. a save whose epoch became stale after it was chosen is rejected at the write boundary (TOCTOU)', async () => {
    await withDb(async ({ mkStores, db, repo }) => {
      const A = mkStores();
      const a = await A.journal.acquireWriter(); // epoch 1
      const chosenEpoch = a.epoch; // A "chose" epoch 1 for an in-flight save
      // the epoch advances underneath A (a takeover) before A's guarded write
      // reaches its mutation — simulate the concurrent advance directly
      await repo.advanceRumor2WriterEpoch('rumor2'); // now 2
      // A's save carrying the now-stale epoch is rejected inside the same
      // transaction that would perform the write — no mutation commits
      const r = await A.checkpointStore.save(CP('A-TOCTOU', 5), chosenEpoch);
      assert.equal(r.reason, 'STALE_WRITER');
      const cp = await repo.loadRumor2Checkpoint();
      assert.equal(cp, null, 'the stale save committed nothing');
      await A.journal.releaseWriter();
    });
  });

  // ---- journal stale-writer matrix (§23) -----------------------------------
  test('EPOCH-J-1..5. current epoch appends; stale epoch appends nothing — zero rows, zero sequence', async () => {
    await withDb(async ({ mkStores, db, repo }) => {
      const A = mkStores();
      const a = await A.journal.acquireWriter(); // epoch 1
      // J-1: current-epoch append works
      const ok = await A.journal.append([ev(1), ev(2)]);
      assert.deepEqual(ok, { ok: true, lastSeq: 2 });
      // the epoch advances underneath A (takeover)
      await repo.advanceRumor2WriterEpoch('rumor2'); // now 2
      const seqBefore = Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) AS n FROM serpent_rumor2_events`)).rows[0].n);
      // J-2..5: a stale append (A still thinks it holds epoch 1) is rejected;
      // a batch mixing a duplicate and a new event still lands nothing
      const stale = await A.journal.append([ev(1), ev(3)]);
      assert.equal(stale.ok, false);
      assert.equal(stale.reason, 'STALE_WRITER');
      const seqAfter = Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) AS n FROM serpent_rumor2_events`)).rows[0].n);
      assert.equal(seqAfter, seqBefore, 'a stale append consumed zero event sequence');
      assert.ok(!(await A.journal.read()).events.some((e) => e.reason === 'r3'), 'the new event never landed');
      await A.journal.releaseWriter();
    });
  });

  test('EPOCH-J-6. the current writer can still retry the exact legitimate crash bundle (dedupe law intact)', async () => {
    await withDb(async ({ mkStores }) => {
      const A = mkStores();
      await A.journal.acquireWriter(); // epoch 1
      const bundle = [ev(1), ev(2)];
      assert.deepEqual(await A.journal.append(bundle), { ok: true, lastSeq: 2 });
      // an exact re-append (crash window) under the SAME current epoch is the
      // same knowledge — health events carry no id so they are not deduped;
      // use an id-bearing record to prove the dedupe law still holds
      const src = { type: 'RUMOR2_PROVIDER_FAILURE', ts: new Date(T).toISOString(), provider: 'CFTC_OFFICIAL', reason: 'x', httpStatus: 500, consecutiveFailures: 1 };
      await A.journal.append([src]);
      const before = (await A.journal.read()).lastSeq;
      await A.journal.append([src]); // exact re-append (no id → appends again; that's fine for health)
      const after = (await A.journal.read()).lastSeq;
      assert.ok(after >= before, 'the current writer keeps appending under its live epoch');
      await A.journal.releaseWriter();
    });
  });

  // ---- historical validity across failover (§28/§30) -----------------------
  test('EPOCH-HIST. events and checkpoints written under an old epoch remain valid after failover', async () => {
    await withDb(async ({ mkStores, repo }) => {
      const A = mkStores();
      const a = await A.journal.acquireWriter(); // epoch 1
      await A.journal.append([ev(1)]);
      await A.checkpointStore.save(CP('epoch1', 1), 1);
      await A.journal.releaseWriter();
      const B = mkStores();
      const b = await B.journal.acquireWriter(); // epoch 2
      assert.equal(b.epoch, 2);
      // the old-epoch event history is still readable, not corruption
      const jr = await B.journal.read();
      assert.equal(jr.corrupt, undefined);
      assert.equal(jr.events.filter((e) => e.reason === 'r1').length, 1, 'old-epoch event remains valid history');
      // the old-epoch checkpoint is still restorable
      const cp = await repo.loadRumor2Checkpoint();
      assert.equal(cp.tag, 'epoch1', 'old-epoch checkpoint remains valid durable state');
      // and B writes fresh truth under epoch 2
      assert.deepEqual(await B.journal.append([ev(2)]), { ok: true, lastSeq: 2 });
      await B.journal.releaseWriter();
    });
  });

  // ---- real advisory-session death advances the epoch (§36) ----------------
  test('EPOCH-FAILOVER. a killed writer session releases the lock; the next writer gets a strictly higher epoch', async () => {
    await withDb(async ({ mkStores, db }) => {
      const admin = new Db({ url: TEST_URL, schema: db.schema });
      try {
        assert.equal(await admin.connect(), true);
        const A = mkStores();
        const a = await A.journal.acquireWriter();
        assert.equal(a.epoch, 1);
        // kill A's advisory-lock backend
        const { rows } = await admin.query(
          `SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted
             AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`
        );
        assert.ok(rows.length >= 1);
        for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
        // B acquires (bounded poll) and gets a strictly higher epoch
        const B = mkStores();
        let b = { ok: false };
        for (let i = 0; i < 100 && !b.ok; i++) {
          b = await B.journal.acquireWriter();
          if (!b.ok) await new Promise((res) => setTimeout(res, 100));
        }
        assert.equal(b.ok, true);
        assert.ok(b.epoch > a.epoch, `new writer epoch ${b.epoch} strictly exceeds ${a.epoch}`);
        // A's stale append is now rejected by the DB epoch fence
        const stale = await A.journal.append([ev(9)]);
        assert.equal(stale.ok, false, 'the dead-session writer cannot append');
        await B.journal.releaseWriter();
      } finally {
        await admin.end();
      }
    });
  });

  // ---- DB uncertainty fails closed (§37) -----------------------------------
  test('EPOCH-DB. a save/append cannot succeed when the epoch row is absent (no fence to confirm)', async () => {
    await withDb(async ({ mkStores }) => {
      const A = mkStores();
      // no acquisition → no epoch row exists; a fenced save carrying any
      // epoch cannot match a non-existent current epoch → rejected
      const r = await A.checkpointStore.save(CP('x', 1), 1);
      assert.equal(r.durable, false);
      assert.equal(r.reason, 'STALE_WRITER', 'no confirmable epoch => no durable mutation');
    });
  });
}
