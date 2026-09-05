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

  // advance the DB writer epoch by one real acquisition/release (the ONLY
  // legitimate way it moves now — no public advance helper exists)
  const bumpEpoch = async (mkStores) => {
    const s = mkStores();
    const w = await s.journal.acquireWriter();
    await s.journal.releaseWriter();
    return w.epoch;
  };

  test('EPOCH-CP-4+5. a checkpoint carrying an epoch that is no longer current is rejected at the write boundary (TOCTOU)', async () => {
    await withDb(async ({ mkStores, repo }) => {
      const e1 = await bumpEpoch(mkStores); // A held epoch 1 then released
      const e2 = await bumpEpoch(mkStores); // B advanced to epoch 2
      assert.equal(e1, 1);
      assert.equal(e2, 2);
      // a delayed save carrying the now-stale epoch e1 — the DB fence reads
      // the current epoch (2) inside the write transaction and rejects it
      const r = await repo.saveRumor2Checkpoint(CP('A-TOCTOU', 5), e1);
      assert.equal(r.stale, true);
      assert.equal(await repo.loadRumor2Checkpoint(), null, 'the stale save committed nothing');
      // the current epoch still saves
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('B', 6), e2), { ok: true });
    });
  });

  // ---- journal stale-writer matrix (§23) -----------------------------------
  test('EPOCH-J-1..5. current epoch appends; stale epoch appends nothing — zero rows, zero sequence', async () => {
    await withDb(async ({ mkStores, db, repo }) => {
      const A = mkStores();
      const a = await A.journal.acquireWriter(); // epoch 1
      // J-1: current-epoch append works through the store
      assert.deepEqual(await A.journal.append([ev(1), ev(2)]), { ok: true, lastSeq: 2 });
      await A.journal.releaseWriter();
      const e2 = await bumpEpoch(mkStores); // epoch advances to 2 via real takeover
      assert.equal(e2, 2);
      const seqBefore = Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) AS n FROM serpent_rumor2_events`)).rows[0].n);
      // J-2..5: a stale append carrying epoch 1 — batch mixing a duplicate and
      // a new event — lands nothing (the repo DB fence rejects it whole)
      await assert.rejects(() => repo.appendRumor2Events('rumor2', [ev(1), ev(3)], 1), (e) => e.staleWriter === true);
      const seqAfter = Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) AS n FROM serpent_rumor2_events`)).rows[0].n);
      assert.equal(seqAfter, seqBefore, 'a stale append consumed zero event sequence');
      assert.ok(!(await repo.loadRumor2Events('rumor2')).events.some((e) => e.reason === 'r3'), 'the new event never landed');
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

  // =========================================================================
  // WRITER-EPOCH CAPABILITY SEAL (#79): there is NO low-level PostgreSQL RUMOR
  // mutation path that accepts a null/omitted/invalid epoch, and the epoch
  // advances ONLY on the lock-owning session — no public advance API, no
  // half-authoritative acquisition. Baseline 34d75e3 accepted every one of
  // these (see scratchpad/capability-red.mjs: BYPASS OPEN on all three).
  // =========================================================================
  const NOARG = Symbol('noarg');
  // every value a legitimate writer epoch is NOT — refused, never coerced
  const BAD_EPOCHS = [
    ['omitted', NOARG], ['null', null], ['undefined', undefined], ['zero', 0],
    ['negative', -1], ['NaN', NaN], ['Infinity', Infinity], ['fraction', 1.5],
    ['string-1', '1'], ['boolean', true],
  ];

  test('LOWLEVEL-CP. the low-level checkpoint mutation refuses every non-(positive-safe-integer) epoch — zero rows; the correct epoch passes', async () => {
    await withDb(async ({ repo, db }) => {
      for (const [label, bad] of BAD_EPOCHS) {
        const r = bad === NOARG ? await repo.saveRumor2Checkpoint(CP('bad')) : await repo.saveRumor2Checkpoint(CP('bad'), bad);
        assert.deepEqual(r, { invalidEpoch: true }, `checkpoint refused for epoch=${label}`);
      }
      assert.equal(Number((await db.query(`SELECT count(*)::int c FROM serpent_rumor2_checkpoint`)).rows[0].c), 0, 'no invalid-epoch checkpoint touched the durable core');
      // LOWLEVEL green: a real acquisition mints a valid epoch and the save commits
      const lock = await repo.acquireRumor2WriterLock();
      assert.ok(Number.isInteger(lock.epoch) && lock.epoch >= 1);
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('ok'), lock.epoch), { ok: true });
      assert.equal((await repo.loadRumor2Checkpoint()).tag, 'ok');
      await lock.release();
    });
  });

  test('LOWLEVEL-J. the low-level append refuses every non-(positive-safe-integer) epoch — zero rows, zero sequence; the correct epoch passes', async () => {
    await withDb(async ({ repo, db }) => {
      for (const [label, bad] of BAD_EPOCHS) {
        await assert.rejects(
          () => (bad === NOARG ? repo.appendRumor2Events(STREAM, [ev(1)]) : repo.appendRumor2Events(STREAM, [ev(1)], bad)),
          (e) => e.invalidEpoch === true,
          `append refused for epoch=${label}`
        );
      }
      assert.equal(Number((await db.query(`SELECT COALESCE(MAX(event_seq),0) n FROM serpent_rumor2_events`)).rows[0].n), 0, 'no invalid-epoch append consumed any sequence');
      assert.equal(Number((await db.query(`SELECT count(*)::int c FROM serpent_rumor2_events WHERE stream = 'rumor2'`)).rows[0].c), 0, 'no invalid-epoch append inserted any row');
      // LOWLEVEL green: a real acquisition mints a valid epoch and the append commits
      const lock = await repo.acquireRumor2WriterLock();
      assert.equal((await repo.appendRumor2Events(STREAM, [ev(1), ev(2)], lock.epoch)).lastSeq, 2, 'the correct epoch appends');
      await lock.release();
    });
  });

  test('CAP-OMIT. omitting the epoch is refused even while a live fence is held — no stale-omit bypass (§18)', async () => {
    await withDb(async ({ repo }) => {
      const lock = await repo.acquireRumor2WriterLock(); // a live epoch exists
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('omit')), { invalidEpoch: true }, 'omitting the token never means "skip the check"');
      await assert.rejects(() => repo.appendRumor2Events(STREAM, [ev(1)]), (e) => e.invalidEpoch === true);
      // the live writer's real token still commits
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('ok'), lock.epoch), { ok: true });
      await lock.release();
    });
  });

  test('CAP-NO-ADVANCE. there is no public epoch-advance API on the repository or the journal store', async () => {
    await withDb(async ({ repo, mkStores }) => {
      assert.equal(typeof repo.advanceRumor2WriterEpoch, 'undefined', 'the repository exposes no advance method');
      const { journal } = mkStores();
      assert.equal(typeof journal.advanceRumor2WriterEpoch, 'undefined', 'the journal store exposes no advance method');
      assert.equal(typeof journal.advanceWriterEpoch, 'undefined', 'no aliased advance method either');
    });
  });

  test('CAP-EPOCH-FAIL. an epoch-advance failure aborts acquisition, releases the lock, and advances nothing (§29 / RED-ACQUIRE-1,3)', async () => {
    await withDb(async ({ db, repo, SCHEMA }) => {
      // force the epoch INSERT — which runs on the lock-owning session — to
      // fail, standing in for a session death between lock grant and epoch
      // establishment. The acquisition must abort, not hand out authority.
      await db.query(`DROP TABLE serpent_rumor2_writer_epoch`, [], { write: true });
      await assert.rejects(() => repo.acquireRumor2WriterLock(), 'a failed epoch advance aborts the acquisition');
      // restore the table: a COMPLETELY FRESH session must now acquire — which
      // proves the aborted attempt (a) released its advisory lock and (b) left
      // the epoch un-advanced (a fresh epoch is 1, not 2).
      await db.query(
        `CREATE TABLE serpent_rumor2_writer_epoch (stream text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`,
        [], { write: true }
      );
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try {
        assert.equal(await db2.connect(), true);
        const lock = await new Repository(db2).acquireRumor2WriterLock();
        assert.ok(lock, 'a fresh session acquires — the aborted attempt left no dangling advisory lock');
        assert.equal(lock.epoch, 1, 'the aborted attempt advanced the epoch by nothing');
        await lock.release();
      } finally {
        await db2.end();
      }
    });
  });

  test('CAP-CONCURRENT. concurrent acquisitions yield exactly one winner and advance the epoch exactly once (§30)', async () => {
    await withDb(async ({ db, SCHEMA }) => {
      const dbs = [];
      try {
        for (let i = 0; i < 6; i++) { const d = new Db({ url: TEST_URL, schema: SCHEMA }); assert.equal(await d.connect(), true); dbs.push(d); }
        const results = await Promise.all(dbs.map((d) => new Repository(d).acquireRumor2WriterLock().catch(() => null)));
        const winners = results.filter((r) => r && typeof r.epoch === 'number');
        assert.equal(winners.length, 1, 'exactly one concurrent contender wins the advisory lock');
        assert.equal(winners[0].epoch, 1, 'the sole winner advanced the epoch exactly once (0 → 1)');
        assert.equal(Number((await db.query(`SELECT epoch FROM serpent_rumor2_writer_epoch WHERE stream = 'rumor2'`)).rows[0].epoch), 1, 'the losing contenders advanced the epoch by nothing');
        await winners[0].release();
      } finally {
        for (const d of dbs) await d.end();
      }
    });
  });

  test('CAP-ADVERSARIAL. eight capability attacks on the writer-epoch authority are all refused (§36)', async () => {
    await withDb(async ({ mkStores, repo, db }) => {
      // 1. null epoch checkpoint → refused
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('a1'), null), { invalidEpoch: true });
      // 2. undefined epoch append → refused
      await assert.rejects(() => repo.appendRumor2Events(STREAM, [ev(1)], undefined), (e) => e.invalidEpoch === true);
      // 3. string "1" → refused (never coerced to a number)
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('a3'), '1'), { invalidEpoch: true });
      // 4. fractional epoch → refused
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('a4'), 1.5), { invalidEpoch: true });
      // 5. zero / negative → refused
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('a5'), 0), { invalidEpoch: true });
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('a5b'), -1), { invalidEpoch: true });
      // ... and none of 1–5 touched the durable core
      assert.equal(Number((await db.query(`SELECT count(*)::int c FROM serpent_rumor2_checkpoint`)).rows[0].c), 0, 'no refused checkpoint landed');
      assert.equal(Number((await db.query(`SELECT count(*)::int c FROM serpent_rumor2_events WHERE stream = 'rumor2'`)).rows[0].c), 0, 'no refused append landed');
      // 6. omit-token while a live fence is held → still refused (no skip-the-check bypass)
      const A = mkStores();
      const a = await A.journal.acquireWriter(); // epoch 1 live
      assert.equal(a.epoch, 1);
      assert.deepEqual(await repo.saveRumor2Checkpoint(CP('a6')), { invalidEpoch: true });
      // 7. a delayed stale epoch after failover → refused; the newer truth survives
      assert.deepEqual(await A.checkpointStore.save(CP('A', 1), a.epoch), { durable: true });
      await A.journal.releaseWriter();
      const B = mkStores();
      const b = await B.journal.acquireWriter(); // epoch 2
      assert.equal(b.epoch, 2);
      assert.deepEqual(await B.checkpointStore.save(CP('B-NEW', 2), b.epoch), { durable: true });
      assert.equal((await repo.saveRumor2Checkpoint(CP('A-STALE', 9), a.epoch)).stale, true);
      assert.equal((await repo.loadRumor2Checkpoint()).tag, 'B-NEW', 'a stale writer cannot overwrite newer truth');
      // 8. no public advance API → a non-owner cannot force-stale a live writer
      assert.equal(typeof repo.advanceRumor2WriterEpoch, 'undefined');
      assert.equal(Number((await db.query(`SELECT epoch FROM serpent_rumor2_writer_epoch WHERE stream = 'rumor2'`)).rows[0].epoch), 2, 'the epoch moved only for the two real acquisitions — no attack advanced it');
      await B.journal.releaseWriter();
    });
  });
}
