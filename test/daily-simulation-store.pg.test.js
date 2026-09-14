// SIM-2 durable store — REAL PostgreSQL engine verification. PG-gated: it skips
// unless an explicitly attested throwaway test database is supplied. It NEVER
// falls back to DATABASE_URL, never touches an application/production DB, and
// applies ONLY the proposed daily-simulation DDL (not root's migrations) inside
// a generated schema it drops afterward. Drives the REAL scheduler/store via
// the injected existing Db (persistence/db.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { PROPOSED_DDL } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const ISOLATION = 'THROWAWAY_SCHEMA_ONLY';
const SCHEMA = `dsim_pg_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

function authorityError() {
  if (!TEST_URL) return null;
  if (process.env.PERSIST_TEST_DATABASE_ISOLATED !== ISOLATION) return `PERSIST_TEST_DATABASE_ISOLATED must equal ${ISOLATION}`;
  if (process.env.DATABASE_URL) return 'ambient DATABASE_URL must be absent';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(SCHEMA)) return 'generated schema unsafe';
  return null;
}

const statusOf = (r) => r.status;
const identityOf = (r) => r.simulationId;
const completedOf = (r) => r.completed === true;
const validOf = (r) => r.validModeledOutcome === true;
const prospectiveOf = (r) => r.prospectiveQualificationEligible === true;
const outcomePathSource = { async pathsFor() { return { label: 'FIXTURE' }; } };
const row = (id, o = {}) => ({ simulationId: id, status: o.status ?? 'COMPLETED_MODELED', completed: o.completed ?? true, validModeledOutcome: o.valid ?? true, prospectiveQualificationEligible: o.prospective ?? false });
const modeledFrames = (jobId, n) => ({ jobId, frames: Array.from({ length: n }, (_, i) => [row(`${jobId}#${i}`)]) });
const jobSource = (jobs) => ({ async readyJobs() { return jobs.map((j) => ({ jobId: j.jobId, ...j })); } });
const executor = { async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
  const start = cursor ?? 0; const take = Math.max(0, Math.min(maxEvaluations, 64, job.frames.length - start));
  const frames = job.frames.slice(start, start + take); const done = start + take >= job.frames.length;
  const results = []; for (const f of frames) for (const v of f) results.push(v);
  return { jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done, results, counters: { frames: take, rows: results.length }, laws: ['pg-fixture'] };
} };

const err = authorityError();
if (!TEST_URL) {
  test('SIM-2 store real-PG integration', (t) => t.skip('PERSIST_TEST_DATABASE_URL absent: attested throwaway DB required'));
} else if (err) {
  test('SIM-2 store refuses an unattested PG target', () => assert.fail(err));
} else {
  test('SIM-2 store + scheduler on real PostgreSQL (proposed DDL only, in a dropped schema)', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    try {
      assert.equal(await db.connect(), true, 'attested throwaway DB reachable');
      // Apply ONLY the proposed daily-simulation DDL (schema-qualified by Db). No root migration.
      for (const ddl of PROPOSED_DDL) await db.query(ddl);

      const identity = `pg:iso:${SCHEMA}`;
      const store = createDailySimulationStore({ db, storeIdentity: identity, dailyTarget: 6 });
      assert.equal((await store.loadDay('2026-09-14')).status, 'LOST', 'uncommissioned store is LOST, not NEW');
      await store.commissionStore();
      assert.equal((await store.loadDay('2026-09-14')).status, 'NEW', 'commissioned + empty day is NEW');

      const s = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('A', 6)]), executor, outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 6, maxEvalsPerTick: 2, clock: () => Date.UTC(2026, 8, 14, 12, 0, 0) });

      await t.test('drives to target with durable evidence', async () => {
        const run = await s.runToIdle();
        assert.equal(run.last, 'TARGET_MET');
        const led = (await store.loadDay('2026-09-14')).ledger;
        assert.equal(led.totals.completed, 6);
        assert.equal(led.completedIds.length, 6);
        const { rows: ev } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1', [identity]);
        assert.equal(ev[0].n, 6, 'all result rows durable');
        const { rows: comp } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_completed WHERE identity = $1', [identity]);
        assert.equal(comp[0].n, 6);
      });

      await t.test('idempotent duplicate + altered-payload conflict on real PG', async () => {
        const rec = { port: 'daily-sim-scheduler-2', policyVersion: 'sim2-policy-1', batchId: 'PGDUP', dayKey: '2026-09-15', jobId: 'Z', jobDigest: 'jd', payloadDigest: 'pgpd1', cursorBefore: null, nextCursor: null, done: true, parentRevision: 0, expectedRevision: 1, completedResults: [], newCompletedIds: ['Z#0'], pendingDelta: [], resultEvidence: [{ id: 'Z#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'zd' }], byStatus: {}, tally: { completed: 1, validModeled: 1, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 1 }, executorCounters: null, executorLaws: null, observedUtcMs: 1 };
        const a = await store.commitBatch(rec); assert.equal(a.ok, true); assert.equal(a.revision, 1);
        const b = await store.commitBatch(rec); assert.equal(b.idempotent, true); assert.equal(b.revision, 1);
        const c = await store.commitBatch({ ...rec, payloadDigest: 'pgpd2-ALTERED' }); assert.equal(c.ok, false); assert.equal(c.reason, 'BATCH_ID_PAYLOAD_CONFLICT');
      });

      await t.test('forged completed claim refused on real PG (evidence-derived truth)', async () => {
        const rec = { port: 'daily-sim-scheduler-2', policyVersion: 'sim2-policy-1', batchId: 'PGFORGE', dayKey: '2026-09-16', jobId: 'Z', jobDigest: 'jd', payloadDigest: 'fp', cursorBefore: null, nextCursor: null, done: true, parentRevision: 0, expectedRevision: 1, completedResults: [], newCompletedIds: ['Q#0', 'Q#FORGED'], pendingDelta: [], resultEvidence: [{ id: 'Q#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'q' }], byStatus: {}, tally: { completed: 2, validModeled: 1, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 1 }, executorCounters: null, executorLaws: null, observedUtcMs: 1 };
        const res = await store.commitBatch(rec);
        assert.equal(res.ok, false); assert.equal(res.reason, 'FORGED_COMPLETED_MISMATCH');
        const { rows } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1 AND day_key = $2', [identity, '2026-09-16']);
        assert.equal(rows[0].n, 0, 'forged receipt persisted nothing');
      });
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
