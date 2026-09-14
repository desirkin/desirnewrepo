// SIM-2 — REAL PostgreSQL 100k throughput + restart. Double-gated: runs only
// when PERSIST_TEST_DATABASE_URL (attested throwaway) AND SIM2_STRESS=1 are set.
// Never touches an application/production/remote DB; applies ONLY the proposed
// DDL in a generated schema it drops. Synthetic rows only — NOT real learning
// or prospective qualification. Measures true PG wall time, event-loop max/p95
// and memory at the DEFAULT frame page (64 rows) AND the 4096-row upper bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { PROPOSED_DDL } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const RUN = TEST_URL && process.env.SIM2_STRESS && process.env.PERSIST_TEST_DATABASE_ISOLATED === 'THROWAWAY_SCHEMA_ONLY' && !process.env.DATABASE_URL;
const SCHEMA = `dsim_pgstress_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

const statusOf = (r) => r.status; const identityOf = (r) => r.simulationId;
const completedOf = (r) => r.completed === true; const validOf = (r) => r.validModeledOutcome === true;
const prospectiveOf = (r) => r.prospectiveQualificationEligible === true;
const outcomePathSource = { async pathsFor() { return { label: 'SYNTHETIC' }; } };
const jobSource = { async readyJobs() { return [{ jobId: 'PGSTRESS' }]; } };
function syntheticExecutor(totalFrames, tag) {
  return { async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
    const start = cursor ?? 0; const take = Math.max(0, Math.min(maxEvaluations, 64, totalFrames - start));
    const results = [];
    for (let f = start; f < start + take; f++) for (let v = 0; v < 64; v++) { const idx = f * 64 + v; results.push({ simulationId: `${tag}#${idx}`, status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: idx % 8 === 0, prospectiveQualificationEligible: idx % 32 === 0 }); }
    const done = start + take >= totalFrames;
    return { jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done, results, counters: { frames: take }, laws: ['synthetic'] };
  } };
}

if (!RUN) {
  test('SIM-2 real-PG 100k stress', (t) => t.skip('needs PERSIST_TEST_DATABASE_URL + PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY + SIM2_STRESS=1, no DATABASE_URL'));
} else {
  test('SIM-2 real-PG 100,032-row throughput at 64-row and 4096-row pages, with restart', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    const TARGET = 100_000; const FRAMES = Math.ceil(TARGET / 64); // 1563 -> 100032 rows
    try {
      assert.equal(await db.connect(), true);
      for (const ddl of PROPOSED_DDL) await db.query(ddl);

      async function runConfig({ dayTag, identity, maxEvalsPerTick, dayMs, withRestart }) {
        await createDailySimulationStore({ db, storeIdentity: identity }).commissionStore();
        const mk = () => createDailySimulationScheduler({ store: createDailySimulationStore({ db, storeIdentity: identity, dailyTarget: TARGET }), jobSource, executor: syntheticExecutor(FRAMES, dayTag), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: TARGET, maxEvalsPerTick, clock: () => dayMs });
        const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
        const rss0 = process.memoryUsage().rss; const t0 = Date.now();
        if (withRestart) { const s1 = mk(); await s1.runToIdle({ maxTicks: 5 }); }
        const s2 = mk(); const run = await s2.runToIdle();
        const wallMs = Date.now() - t0; h.disable();
        const dayKey = new Date(dayMs).toISOString().slice(0, 10);
        const led = (await createDailySimulationStore({ db, storeIdentity: identity }).loadDay(dayKey)).ledger;
        const { rows: ev } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity = $1', [identity]);
        return {
          last: run.last, dayKey, wallMs, eloopMaxMs: h.max / 1e6, eloopP95Ms: h.percentile(95) / 1e6,
          rssPeakMb: process.memoryUsage().rss / 1048576, rssDeltaMb: (process.memoryUsage().rss - rss0) / 1048576,
          evidenceRows: ev[0].n, completed: led.totals.completed, valid: led.totals.validModeled, prospective: led.totals.prospectiveEligible,
          unique: new Set(led.completedIds).size, overshoot: led.totals.overshoot, batches: led.totals.batchesApplied,
        };
      }

      const expectedRows = FRAMES * 64; // 100032
      await t.test('4096-row upper-bound pages, with mid-run restart', async () => {
        const r = await runConfig({ dayTag: 'U', identity: `pgs:up:${SCHEMA}`, maxEvalsPerTick: 64, dayMs: Date.UTC(2026, 8, 14, 12, 0, 0), withRestart: true });
        assert.equal(r.last, 'TARGET_MET');
        assert.equal(r.evidenceRows, expectedRows); assert.equal(r.completed, expectedRows); assert.equal(r.unique, expectedRows);
        assert.equal(r.valid, Math.floor(expectedRows / 8)); assert.equal(r.prospective, Math.floor(expectedRows / 32));
        assert.ok(r.overshoot <= 4096);
        // eslint-disable-next-line no-console
        console.log(`PGSTRESS[4096-page,restart] rows=${r.evidenceRows} completed=${r.completed} valid=${r.valid} prosp=${r.prospective} unique=${r.unique} overshoot=${r.overshoot} batches=${r.batches} | REAL-PG wallMs=${r.wallMs} eloopMaxMs=${r.eloopMaxMs.toFixed(2)} eloopP95Ms=${r.eloopP95Ms.toFixed(2)} rssPeakMb=${r.rssPeakMb.toFixed(1)} rssDeltaMb=${r.rssDeltaMb.toFixed(1)}`);
      });

      await t.test('64-row default-frame pages', async () => {
        const r = await runConfig({ dayTag: 'D', identity: `pgs:def:${SCHEMA}`, maxEvalsPerTick: 1, dayMs: Date.UTC(2026, 8, 15, 12, 0, 0), withRestart: false });
        assert.equal(r.last, 'TARGET_MET');
        assert.equal(r.evidenceRows, expectedRows); assert.equal(r.completed, expectedRows); assert.equal(r.unique, expectedRows);
        // eslint-disable-next-line no-console
        console.log(`PGSTRESS[64-page] rows=${r.evidenceRows} completed=${r.completed} overshoot=${r.overshoot} batches=${r.batches} | REAL-PG wallMs=${r.wallMs} eloopMaxMs=${r.eloopMaxMs.toFixed(2)} eloopP95Ms=${r.eloopP95Ms.toFixed(2)} rssPeakMb=${r.rssPeakMb.toFixed(1)} rssDeltaMb=${r.rssDeltaMb.toFixed(1)}`);
      });
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
