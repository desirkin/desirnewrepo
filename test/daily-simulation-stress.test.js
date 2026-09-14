// SIM-2 — bounded SYNTHETIC 100k-result reconciliation + restart/rollover
// stress. Gated behind SIM2_STRESS=1 (skips otherwise). This exercises the
// scheduler/store MECHANICS at scale with deterministic synthetic result rows.
// It is NOT real market data, NOT real learning, and NOT prospective
// qualification — every row is a labelled synthetic fixture. No provider
// traffic. 64 variant rows per decision frame; pages are bounded and never
// truncated-then-advanced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX } from '../persistence/daily-simulation-schema.js';

// compact in-memory transactional fake Db (same emulation as the store suite)
function makeFakeDb() {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [], jobsched: new Map() };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  const dk = (a, b) => `${a}|${b}`; const bk = (a, b, c) => `${a}|${b}|${c}`;
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) { const n = p.length / 10; for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ identity: p[b], day_key: p[b + 1], batch_id: p[b + 2], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; const k = bk(p[b], p[b + 1], p[b + 2]); if (t.completed.has(k)) throw new Error('dup completed'); t.completed.set(k, { batch_id: p[b + 3] }); } return { rows: [], rowCount: n }; }
    switch (B2T.get(body)) {
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0] }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_GET: { const r = t.day.get(dk(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: 0, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { t.day.set(dk(p[0], p[1]), { revision: 0, target: p[2], shortfall: null }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_UPDATE_CAS: { const r = t.day.get(dk(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; if (p[4] !== undefined) r.rotation_index = p[4]; return { rowCount: 1, rows: [] }; } return { rowCount: 0, rows: [] }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dk(p[0], p[1])); if (r) r.shortfall = JSON.parse(p[2]); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bk(p[0], p[1], p[2])); return { rows: r ? [{ batch_id: r.batch_id, payload_digest: r.payload_digest, resulting_revision: r.resulting_revision, tally: r.tally }] : [] }; }
      case SQL.BATCH_INSERT: { const k = bk(p[0], p[1], p[2]); if (t.batch.has(k)) throw new Error('dup batch'); t.batch.set(k, { identity: p[0], day_key: p[1], batch_id: p[2], job_id: p[3], payload_digest: p[5], resulting_revision: p[7], cursor_before: p[8], next_cursor: p[9], done: p[10] }); return { rowCount: 1, rows: [] }; }
      case SQL.RESULT_INSERT: { t.result.push({ identity: p[0], day_key: p[1], batch_id: p[2], sim_id: p[4], status: p[5], completed: p[6], valid_modeled: p[7], prospective_eligible: p[8] }); return { rowCount: 1, rows: [] }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1]) continue; const e = g.get(r.status) || { status: r.status, n: 0, completed: 0, valid_modeled: 0, prospective_eligible: 0 }; e.n++; e.completed += r.completed ? 1 : 0; e.valid_modeled += r.valid_modeled ? 1 : 0; e.prospective_eligible += r.prospective_eligible ? 1 : 0; g.set(r.status, e); } return { rows: [...g.values()] }; }
      case SQL.CREDITED_AGGREGATE: { let valid = 0; let prospective = 0; for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1] || !r.completed) continue; const c = t.completed.get(bk(p[0], p[1], r.sim_id)); if (c && c.batch_id === r.batch_id) { valid += r.valid_modeled ? 1 : 0; prospective += r.prospective_eligible ? 1 : 0; } } return { rows: [{ valid, prospective }] }; }
      case SQL.EVIDENCE_DISTINCT_COMPLETED: { const s = new Set(); for (const r of t.result) { if (r.identity === p[0] && r.day_key === p[1] && r.completed) s.add(r.sim_id); } return { rows: [{ n: s.size }] }; }
      case SQL.COMPLETED_HAS: return { rows: t.completed.has(bk(p[0], p[1], p[2])) ? [{ one: 1 }] : [] };
      case SQL.COMPLETED_INSERT: { const k = bk(p[0], p[1], p[2]); if (t.completed.has(k)) throw new Error('dup completed'); t.completed.set(k, 1); return { rowCount: 1, rows: [] }; }
      case SQL.COMPLETED_LIST: { const out = []; for (const k of t.completed.keys()) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push(sim); } out.sort(); return { rows: out.map((sim_id) => ({ sim_id })) }; }
      case SQL.COMPLETED_COUNT: { let n = 0; for (const k of t.completed.keys()) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) n++; } return { rows: [{ n }] }; }
      case SQL.PENDING_LIST: { const out = []; for (const [k, v] of t.pending) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ sim_id: sim, ...v }); } return { rows: out }; }
      case SQL.PENDING_UPSERT: { t.pending.set(bk(p[0], p[1], p[2]), { status: p[3], digest: p[4], first_seen_rev: p[5], last_seen_rev: p[6], attempts: p[7] }); return { rowCount: 1, rows: [] }; }
      case SQL.PENDING_DELETE: { t.pending.delete(bk(p[0], p[1], p[2])); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_LIST_DAY: { const out = []; for (const v of t.batch.values()) if (v.identity === p[0] && v.day_key === p[1]) out.push({ batch_id: v.batch_id, job_id: v.job_id, next_cursor: v.next_cursor, cursor_before: v.cursor_before, payload_digest: v.payload_digest, done: v.done, resulting_revision: v.resulting_revision }); out.sort((a, b) => a.resulting_revision - b.resulting_revision); return { rows: out.map(({ batch_id, job_id, next_cursor, cursor_before, payload_digest, done }) => ({ batch_id, job_id, next_cursor, cursor_before, payload_digest, done })) }; }
      case SQL.JOBSCHED_LIST: { const out = []; for (const [k, v] of t.jobsched) { const [id, d, job] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ job_id: job, next_eligible_ts: v.next_eligible_ts, backoff_attempts: v.backoff_attempts }); } return { rows: out }; }
      case SQL.JOBSCHED_UPSERT: { t.jobsched.set(bk(p[0], p[1], p[2]), { next_eligible_ts: p[3], backoff_attempts: p[4] }); return { rowCount: 1, rows: [] }; }
      default: throw new Error('fake: ' + body);
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map(t.batch), completed: new Map(t.completed), pending: new Map(t.pending), result: t.result.slice() });
  const rest = (s) => { Object.assign(t, s); };
  return { _t: t, async query(b, p) { return run(b, p); }, async tx(fn) { const s = snap(); try { const r = await fn((b, p) => Promise.resolve(run(b, p)), {}); return r; } catch (e) { rest(s); throw e; } } };
}

const statusOf = (r) => r.status; const identityOf = (r) => r.simulationId;
const completedOf = (r) => r.completed === true; const validOf = (r) => r.validModeledOutcome === true;
const prospectiveOf = (r) => r.prospectiveQualificationEligible === true;
const outcomePathSource = { async pathsFor() { return { label: 'SYNTHETIC' }; } };

// A synthetic job of `frames` decision frames; each frame emits 64 variant rows.
// Every 8th variant is valid; every 32nd is prospective-eligible. All completed.
function syntheticExecutor(totalFrames) {
  return { async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
    const start = cursor ?? 0; const take = Math.max(0, Math.min(maxEvaluations, 64, totalFrames - start));
    const results = [];
    for (let f = start; f < start + take; f++) for (let v = 0; v < 64; v++) {
      const idx = f * 64 + v;
      results.push({ simulationId: `S#${idx}`, status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: idx % 8 === 0, prospectiveQualificationEligible: idx % 32 === 0 });
    }
    const done = start + take >= totalFrames;
    return { jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done, results, counters: { frames: take, rows: results.length }, laws: ['synthetic'] };
  } };
}

test('SIM-2 synthetic 100k reconciliation + restart (SIM2_STRESS=1)', async (t) => {
  if (!process.env.SIM2_STRESS) { t.skip('set SIM2_STRESS=1 to run the bounded 100k synthetic stress'); return; }
  const TARGET = 100_000; const FRAMES = Math.ceil(TARGET / 64); // 1563 frames -> 100032 rows
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'stress:iso' }).commissionStore();
  const jobSource = { async readyJobs() { return [{ jobId: 'STRESS' }]; } };
  const mkExec = () => syntheticExecutor(FRAMES);

  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const rss0 = process.memoryUsage().rss; const wall0 = Date.now();

  // Phase A: run partway, then simulate a restart on the same durable db.
  const s1 = createDailySimulationScheduler({ store: createDailySimulationStore({ db, storeIdentity: 'stress:iso', dailyTarget: TARGET }), jobSource, executor: mkExec(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: TARGET, maxEvalsPerTick: 64, clock: () => Date.UTC(2026, 8, 14, 12, 0, 0) });
  await s1.runToIdle({ maxTicks: 10 });
  const mid = (await createDailySimulationStore({ db, storeIdentity: 'stress:iso' }).loadDay('2026-09-14')).ledger.totals.completed;

  const s2 = createDailySimulationScheduler({ store: createDailySimulationStore({ db, storeIdentity: 'stress:iso', dailyTarget: TARGET }), jobSource, executor: mkExec(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: TARGET, maxEvalsPerTick: 64, clock: () => Date.UTC(2026, 8, 14, 12, 0, 0) });
  const run = await s2.runToIdle();

  const wallMs = Date.now() - wall0; h.disable();
  const rssPeakMb = (process.memoryUsage().rss) / 1048576; const rssDeltaMb = (process.memoryUsage().rss - rss0) / 1048576;
  const eloopMaxMs = h.max / 1e6;

  const led = (await createDailySimulationStore({ db, storeIdentity: 'stress:iso' }).loadDay('2026-09-14')).ledger;
  const st = s2.status();

  // Reconcile from DURABLE evidence, not scheduler memory.
  const evidenceRows = db._t.result.length;
  const completedIndex = db._t.completed.size;
  const uniqueCompleted = new Set(led.completedIds).size;
  const expectedRows = FRAMES * 64;                 // 100032, no truncation
  const expectedValid = Math.floor(expectedRows / 8);
  const expectedProspective = Math.floor(expectedRows / 32);

  assert.equal(run.last, 'TARGET_MET');
  assert.ok(mid > 0 && mid < expectedRows, `restart happened mid-run (mid=${mid})`);
  assert.equal(evidenceRows, expectedRows, 'every synthetic result row retained as durable evidence (no truncation)');
  assert.equal(completedIndex, expectedRows, 'completed dedupe index equals unique completed rows');
  assert.equal(uniqueCompleted, expectedRows, 'no double-count across the restart');
  assert.equal(led.totals.completed, expectedRows);
  assert.equal(led.totals.validModeled, expectedValid, 'validModeled reconciled from evidence');
  assert.equal(led.totals.prospectiveEligible, expectedProspective, 'prospectiveEligible reconciled from evidence — distinct tally');
  assert.ok(led.totals.completed >= TARGET, 'target met');
  assert.ok(led.totals.overshoot <= 4096, `bounded honest overshoot (${led.totals.overshoot})`);

  // eslint-disable-next-line no-console
  console.log(`SIM2_STRESS reconciliation: frames=${FRAMES} rows=${evidenceRows} completed=${led.totals.completed} valid=${led.totals.validModeled} prospective=${led.totals.prospectiveEligible} unique=${uniqueCompleted} duplicates=${st.totals.duplicates} overshoot=${led.totals.overshoot} batches=${led.totals.batchesApplied} | wallMs=${wallMs} rssPeakMb=${rssPeakMb.toFixed(1)} rssDeltaMb=${rssDeltaMb.toFixed(1)} eloopMaxMs=${eloopMaxMs.toFixed(2)}`);
});
