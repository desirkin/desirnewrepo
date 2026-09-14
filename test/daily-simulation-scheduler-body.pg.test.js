// SIM-2 DIRECT scheduler->store outcome-body handoff on REAL PostgreSQL. No
// body-attaching shim: the real scheduler forwards bodyOf into the real store
// over a real Db, exercising the actual SQL binding + streaming verify. Gated
// like the other *.pg tests; applies ONLY the proposed DDL in a dropped schema.
// Deterministic TEST-ONLY executor with explicit SYNTHETIC labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { PROPOSED_DDL } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const RUN = TEST_URL && process.env.PERSIST_TEST_DATABASE_ISOLATED === 'THROWAWAY_SCHEMA_ONLY' && !process.env.DATABASE_URL;
const SCHEMA = `dsim_pgsbody_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const DAYMS = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY = '2026-09-14';

function stableStringify(v) { if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'; if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`; const k = Object.keys(v).sort(); return `{${k.map((x) => `${JSON.stringify(x)}:${stableStringify(v[x])}`).join(',')}}`; }
const bodyDigest = (b) => `sha256:${createHash('sha256').update(stableStringify(b), 'utf8').digest('hex')}`;

function syntheticExecutor(frames, { tag = 'S', variants = 4, dupEvery = 0 } = {}) {
  return { async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
    const start = cursor ?? 0; const take = Math.max(0, Math.min(maxEvaluations, 64, frames - start));
    const results = [];
    for (let f = start; f < start + take; f++) for (let v = 0; v < variants; v++) {
      const idx = f * variants + v; const row = { simulationId: `${tag}#${idx}`, status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: idx % 8 === 0, prospectiveQualificationEligible: idx % 32 === 0, body: { idx, tag, label: 'SYNTHETIC' } };
      results.push(row); if (dupEvery && idx % dupEvery === 0) results.push({ ...row });
    }
    const done = start + take >= frames;
    return { jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done, results, counters: { frames: take }, laws: ['synthetic'] };
  } };
}
const statusOf = (r) => r.status; const identityOf = (r) => r.simulationId; const completedOf = (r) => r.completed === true;
const validOf = (r) => r.validModeledOutcome === true; const prospectiveOf = (r) => r.prospectiveQualificationEligible === true; const bodyOf = (r) => r.body;
const outcomePathSource = { async pathsFor() { return { label: 'SYNTHETIC' }; } };
const oneJob = (jobId) => ({ async readyJobs() { return [{ jobId }]; } });

if (!RUN) {
  test('SIM-2 direct scheduler-body on real PG', (t) => t.skip('needs PERSIST_TEST_DATABASE_URL + PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY, no DATABASE_URL'));
} else {
  test('SIM-2 direct scheduler->store body handoff on real PostgreSQL', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    assert.equal(await db.connect(), true);
    for (const ddl of PROPOSED_DDL) await db.query(ddl);
    const mkStore = (id) => createDailySimulationStore({ db, storeIdentity: id, dailyTarget: 100000 });
    const mkSched = (id, exec, target) => createDailySimulationScheduler({ store: mkStore(id), jobSource: oneJob('J'), executor: exec, outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, bodyOf, dailyTarget: target, maxEvalsPerTick: 64, clock: () => DAYMS });
    try {
      await t.test('run -> restart -> replayable + single/paged verify; duplicates credit once', async () => {
        const ID = `pgsb:${SCHEMA}:a`; await mkStore(ID).commissionStore();
        const FRAMES = 40, VARIANTS = 4; const N = FRAMES * VARIANTS;
        const run = await mkSched(ID, syntheticExecutor(FRAMES, { tag: 'S', variants: VARIANTS, dupEvery: 5 }), N).runToIdle();
        assert.equal(run.last, 'TARGET_MET');
        const store = mkStore(ID);
        const led = (await store.loadDay(DAY)).ledger;
        assert.equal(led.totals.completed, N);
        assert.equal(led.totals.replayable, N, 'one replayable body per credited sim (duplicates credited once)');
        const got = await store.readOutcomeBody({ dayKey: DAY, simId: 'S#0' });
        assert.equal(got.verified, true); assert.deepEqual(got.body, { idx: 0, tag: 'S', label: 'SYNTHETIC' });
        // credited row digest == stored content_digest == sha256(canonical(body)) on real PG.
        const expect = bodyDigest({ idx: 0, tag: 'S', label: 'SYNTHETIC' });
        const { rows: rr } = await db.query('SELECT digest FROM serpent_dsim_result WHERE identity=$1 AND sim_id=$2 AND completed ORDER BY row_ordinal LIMIT 1', [ID, 'S#0']);
        assert.equal(rr[0].digest, expect);
        const { rows: br } = await db.query('SELECT content_digest FROM serpent_dsim_result_body WHERE identity=$1 AND sim_id=$2', [ID, 'S#0']);
        assert.equal(br[0].content_digest, expect);
        const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 16 });
        assert.equal(v.verified, true); assert.equal(v.checked, N); assert.ok(v.pages > 1);
      });

      await t.test('adversarial: tamper a scheduler-committed body on disk -> rebuild LOST + verify catches', async () => {
        const ID = `pgsb:${SCHEMA}:b`; await mkStore(ID).commissionStore();
        const FRAMES = 12, VARIANTS = 4; const N = FRAMES * VARIANTS;
        await mkSched(ID, syntheticExecutor(FRAMES, { tag: 'T', variants: VARIANTS }), N).runToIdle();
        // Tamper one body's jsonb so it no longer matches its content_digest.
        await db.query(`UPDATE serpent_dsim_result_body SET body = '{"tampered":true}'::jsonb WHERE identity=$1 AND sim_id=$2`, [ID, 'T#17']);
        const store = mkStore(ID);
        const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 10 });
        assert.equal(v.verified, false); assert.equal(v.corruptSim, 'T#17');
        await assert.rejects(() => store.readOutcomeBody({ dayKey: DAY, simId: 'T#17' }), /content_digest/);
        // Detach the crediting completion for another sim -> orphan body -> rebuild LOST.
        await db.query('DELETE FROM serpent_dsim_completed WHERE identity=$1 AND sim_id=$2', [ID, 'T#0']);
        assert.equal((await store.loadDay(DAY)).status, 'LOST', 'orphaned scheduler-committed body forces LOST');
      });
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
