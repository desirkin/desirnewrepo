// SIM-2 — REAL PostgreSQL adversarial integrity. PG-gated (attested throwaway
// only; never app/production/remote). Whole-batch rollback, concurrent stale
// writers, exact-duplicate lost ACK, and corrupt/cursor/pending readback — all
// reconciled from full durable evidence. Synthetic prospective flags are
// fixture-only and never qualify learning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { PROPOSED_DDL } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const RUN = TEST_URL && process.env.PERSIST_TEST_DATABASE_ISOLATED === 'THROWAWAY_SCHEMA_ONLY' && !process.env.DATABASE_URL;
const SCHEMA = `dsim_adv_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const DAY = '2026-09-14';

function receipt(over = {}) {
  const evidence = over.resultEvidence || [{ id: 'A#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'd0' }];
  const completed = evidence.filter((e) => e.completed);
  return {
    port: 'daily-sim-scheduler-2', policyVersion: 'sim2-policy-1', batchId: over.batchId || 'B1', dayKey: over.dayKey || DAY,
    jobId: over.jobId || 'J', jobDigest: 'jd', payloadDigest: over.payloadDigest || 'pd1',
    cursorBefore: over.cursorBefore ?? null, nextCursor: over.nextCursor ?? null, done: over.done ?? true, parentRevision: over.parentRevision ?? 0, expectedRevision: (over.parentRevision ?? 0) + 1,
    completedResults: [], newCompletedIds: over.newCompletedIds || completed.map((e) => e.id), pendingDelta: over.pendingDelta || [], resultEvidence: evidence, byStatus: {},
    tally: { completed: completed.length, validModeled: completed.filter((e) => e.valid).length, prospectiveEligible: completed.filter((e) => e.prospective).length, pending: (over.pendingDelta || []).length, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length, ...(over.tally || {}) },
    executorCounters: null, executorLaws: null, observedUtcMs: 1,
  };
}
// Wrap the real Db so the Nth statement inside a tx throws — to exercise a REAL
// PostgreSQL ROLLBACK of a partially-written batch.
function failingTxDb(realDb, failPredicate) {
  let n = 0;
  return { schema: realDb.schema, query: (t, p) => realDb.query(t, p), tx: (fn) => realDb.tx(async (q) => fn((t, p) => { n += 1; if (failPredicate(t, n)) throw new Error('SIMULATED mid-batch failure'); return q(t, p); })) };
}

if (!RUN) {
  test('SIM-2 real-PG adversarial', (t) => t.skip('needs attested throwaway PERSIST_TEST_DATABASE_URL'));
} else {
  test('SIM-2 real-PG adversarial integrity', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    try {
      assert.equal(await db.connect(), true);
      for (const ddl of PROPOSED_DDL) await db.query(ddl);
      const id = `adv:${SCHEMA}`;
      await createDailySimulationStore({ db, storeIdentity: id }).commissionStore();
      const store = createDailySimulationStore({ db, storeIdentity: id, dailyTarget: 100 });

      await t.test('whole-batch rollback on a real mid-transaction failure', async () => {
        const evidence = Array.from({ length: 500 }, (_, i) => ({ id: `RB#${i}`, status: 'COMPLETED_MODELED', completed: true, valid: false, prospective: false, digest: `d${i}` }));
        // fail on the 2nd result-insert statement (chunked at 400 => 2 statements)
        let resultStmts = 0;
        const failDb = failingTxDb(db, (t2) => { if (t2.includes('serpent_dsim_result') && t2.includes('VALUES')) { resultStmts += 1; return resultStmts === 2; } return false; });
        const failStore = createDailySimulationStore({ db: failDb, storeIdentity: id, dailyTarget: 100 });
        await assert.rejects(failStore.commitBatch(receipt({ batchId: 'RB', dayKey: '2026-09-20', resultEvidence: evidence })));
        const { rows } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2', [id, '2026-09-20']);
        assert.equal(rows[0].n, 0, 'PostgreSQL rolled the whole partial batch back');
        const { rows: d } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_day WHERE identity = $1 AND day_key = $2', [id, '2026-09-20']);
        assert.equal(d[0].n, 0, 'day row not created by the rolled-back batch');
      });

      await t.test('concurrent stale writers — one advances, the other is fenced', async () => {
        const A = await store.commitBatch(receipt({ batchId: 'CW-A', dayKey: '2026-09-21', parentRevision: 0, resultEvidence: [{ id: 'CW#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'a' }] }));
        assert.equal(A.revision, 1);
        const B = await store.commitBatch(receipt({ batchId: 'CW-B', dayKey: '2026-09-21', parentRevision: 0, resultEvidence: [{ id: 'CW#1', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'b' }] }));
        assert.equal(B.ok, false); assert.equal(B.reason, 'STALE_PARENT_REVISION'); assert.equal(B.revision, 1);
        const { rows } = await db.query('SELECT revision FROM serpent_dsim_day WHERE identity = $1 AND day_key = $2', [id, '2026-09-21']);
        assert.equal(Number(rows[0].revision), 1, 'revision advanced exactly once');
      });

      await t.test('exact-duplicate lost ACK returns first ACK, no duplicate evidence', async () => {
        const r = receipt({ batchId: 'DUP', dayKey: '2026-09-22', resultEvidence: [{ id: 'D#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'x' }] });
        const a = await store.commitBatch(r); assert.equal(a.revision, 1);
        const b = await store.commitBatch(r); assert.equal(b.idempotent, true); assert.equal(b.revision, 1);
        const { rows } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2', [id, '2026-09-22']);
        assert.equal(rows[0].n, 1, 'replay added no evidence rows');
      });

      await t.test('restart through pending backoff on real PG (no duplicate evidence, then matures once)', async () => {
        const bid = `advbo:${SCHEMA}`; const bday = '2026-09-24';
        await createDailySimulationStore({ db, storeIdentity: bid }).commissionStore();
        let now = Date.UTC(2026, 8, 24, 0, 0, 0); let matured = false;
        const st2 = () => ({ status: (r) => r.status, id: (r) => r.simulationId });
        const sel = { statusOf: (r) => r.status, identityOf: (r) => r.simulationId, completedOf: (r) => r.completed === true, validOf: (r) => r.validModeledOutcome === true, prospectiveOf: (r) => r.prospectiveQualificationEligible === true };
        const exec = { async executeDailySimulationBatch({ job, cursor }) { return matured
          ? { jobId: job.jobId, cursor: cursor ?? 0, nextCursor: null, done: true, results: [{ simulationId: 'BO#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: true, prospectiveQualificationEligible: false }], counters: {}, laws: [] }
          : { jobId: job.jobId, cursor: cursor ?? 0, nextCursor: cursor ?? null, done: false, results: [{ simulationId: 'BO#0', status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false, prospectiveQualificationEligible: false }], counters: {}, laws: [] }; } };
        const src = { async readyJobs() { return [{ jobId: 'BO' }]; } };
        const paths = { async pathsFor() { return { label: 'S' }; } };
        const mk = () => createDailySimulationScheduler({ store: createDailySimulationStore({ db, storeIdentity: bid, dailyTarget: 1 }), jobSource: src, executor: exec, outcomePathSource: paths, ...sel, dailyTarget: 1, maxEvalsPerTick: 1, pendingBackoff: { baseMs: 1000, maxMs: 60000, maxAttempts: 5 }, clock: () => now });
        const s1 = mk();
        await s1.tick(); const b = await s1.tick(); assert.equal(b.tick, 'PENDING_BACKOFF');
        const { rows: ev1 } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2', [bid, bday]);
        assert.equal(ev1[0].n, 1, 'pending evidence recorded once, not per revisit');
        // restart after the window; outcome matured
        now += 5000; matured = true;
        const s2 = mk(); await s2.runToIdle();
        assert.equal(s2.status().totals.completed, 1);
        const { rows: comp } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_completed WHERE identity = $1 AND day_key = $2', [bid, bday]);
        assert.equal(comp[0].n, 1, 'matured and credited exactly once across the restart');
      });

      await t.test('cursor + pending readback survive; corrupt evidence => LOST', async () => {
        await store.commitBatch(receipt({ batchId: 'CP', dayKey: '2026-09-23', nextCursor: 42, done: false,
          resultEvidence: [{ id: 'CP#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'c' }, { id: 'CP#1', status: 'PENDING_HORIZON', completed: false, valid: false, prospective: false, digest: 'p' }],
          pendingDelta: [{ id: 'CP#1', status: 'PENDING_HORIZON', digest: 'p' }] }));
        const led = (await store.loadDay('2026-09-23')).ledger;
        assert.equal(led.jobs.J.cursor, 42, 'cursor read back from durable batch row');
        assert.ok(led.pendingCustody['CP#1'], 'pending custody read back');
        assert.equal(led.totals.completed, 1);
        // corrupt: delete the completed evidence row but leave the completed index
        await db.query('DELETE FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2 AND sim_id = $3', [id, '2026-09-23', 'CP#0']);
        const load = await store.loadDay('2026-09-23');
        assert.equal(load.status, 'LOST', 'durable corruption detected on readback');
      });
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
