// SIM-2 durable store — tested against the REAL scheduler-2 with a fake
// transactional Db that emulates the exact SQL_BODY statements (snapshot /
// rollback). Optional throwaway PostgreSQL is intentionally NOT run here (root
// owns migration 11 that creates the tables); the fake Db exercises the store's
// atomicity/CAS/idempotency/evidence logic and the scheduler<->store contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore, DsimStoreError } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX } from '../persistence/daily-simulation-schema.js';

const DAY1 = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY2 = Date.UTC(2026, 8, 15, 12, 0, 0);

// ---- FAKE transactional Db: emulates SQL_BODY by exact-string match ----------
function makeFakeDb() {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [], jobsched: new Map() };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  let preCommitFail = null;
  const dkey = (a, b) => `${a}|${b}`;
  const bkey = (a, b, c) => `${a}|${b}|${c}`;
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) { const n = p.length / 10; for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ identity: p[b], day_key: p[b + 1], batch_id: p[b + 2], row_ordinal: p[b + 3], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8], digest: p[b + 9] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; const k = bkey(p[b], p[b + 1], p[b + 2]); if (t.completed.has(k)) throw new Error('duplicate completed pk'); t.completed.set(k, { batch_id: p[b + 3] }); } return { rows: [], rowCount: n }; }
    const tok = B2T.get(body);
    if (!tok) throw new Error(`fake Db: unknown statement: ${body}`);
    switch (tok) {
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0], policy_version: p[1], store_version: p[2], commissioned_at: p[3] }); return { rows: [], rowCount: 1 }; }
      case SQL.DAY_GET: { const r = t.day.get(dkey(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: r.rotation_index, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { t.day.set(dkey(p[0], p[1]), { revision: 0, target: p[2], rotation_index: 0, shortfall: null }); return { rows: [], rowCount: 1 }; }
      case SQL.DAY_UPDATE_CAS: { const r = t.day.get(dkey(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; return { rows: [], rowCount: 1 }; } return { rows: [], rowCount: 0 }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dkey(p[0], p[1])); if (r) { r.shortfall = typeof p[2] === 'string' ? JSON.parse(p[2]) : p[2]; return { rows: [], rowCount: 1 }; } return { rows: [], rowCount: 0 }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bkey(p[0], p[1], p[2])); return { rows: r ? [{ batch_id: r.batch_id, payload_digest: r.payload_digest, resulting_revision: r.resulting_revision, tally: r.tally }] : [] }; }
      case SQL.BATCH_INSERT: { const r = { identity: p[0], day_key: p[1], batch_id: p[2], job_id: p[3], job_digest: p[4], payload_digest: p[5], parent_revision: p[6], resulting_revision: p[7], cursor_before: p[8], next_cursor: p[9], done: p[10], tally: p[11], executor_counters: p[12], observed_utc_ms: p[13] }; if (t.batch.has(bkey(p[0], p[1], p[2]))) throw new Error('duplicate batch pk'); t.batch.set(bkey(p[0], p[1], p[2]), r); return { rows: [], rowCount: 1 }; }
      case SQL.RESULT_INSERT: { t.result.push({ identity: p[0], day_key: p[1], batch_id: p[2], row_ordinal: p[3], sim_id: p[4], status: p[5], completed: p[6], valid_modeled: p[7], prospective_eligible: p[8], digest: p[9] }); return { rows: [], rowCount: 1 }; }
      case SQL.RESULT_COUNT_FOR_BATCH: { const n = t.result.filter((r) => r.identity === p[0] && r.day_key === p[1] && r.batch_id === p[2]).length; return { rows: [{ n }] }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1]) continue; const e = g.get(r.status) || { status: r.status, n: 0, completed: 0, valid_modeled: 0, prospective_eligible: 0 }; e.n += 1; e.completed += r.completed ? 1 : 0; e.valid_modeled += r.valid_modeled ? 1 : 0; e.prospective_eligible += r.prospective_eligible ? 1 : 0; g.set(r.status, e); } return { rows: [...g.values()] }; }
      case SQL.COMPLETED_HAS: { return { rows: t.completed.has(bkey(p[0], p[1], p[2])) ? [{ one: 1 }] : [] }; }
      case SQL.COMPLETED_INSERT: { const k = bkey(p[0], p[1], p[2]); if (t.completed.has(k)) throw new Error('duplicate completed pk'); t.completed.set(k, { batch_id: p[3] }); return { rows: [], rowCount: 1 }; }
      case SQL.COMPLETED_LIST: { const out = []; for (const [k] of t.completed) { const [id, dk, sim] = k.split('|'); if (id === p[0] && dk === p[1]) out.push(sim); } out.sort(); return { rows: out.map((sim_id) => ({ sim_id })) }; }
      case SQL.COMPLETED_COUNT: { let n = 0; for (const [k] of t.completed) { const [id, dk] = k.split('|'); if (id === p[0] && dk === p[1]) n += 1; } return { rows: [{ n }] }; }
      case SQL.PENDING_LIST: { const out = []; for (const [k, v] of t.pending) { const [id, dk, sim] = k.split('|'); if (id === p[0] && dk === p[1]) out.push({ sim_id: sim, status: v.status, digest: v.digest, first_seen_rev: v.first_seen_rev, last_seen_rev: v.last_seen_rev, attempts: v.attempts }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out }; }
      case SQL.PENDING_UPSERT: { const k = bkey(p[0], p[1], p[2]); const prev = t.pending.get(k); t.pending.set(k, { status: p[3], digest: p[4], first_seen_rev: prev ? prev.first_seen_rev : p[5], last_seen_rev: p[6], attempts: p[7] }); return { rows: [], rowCount: 1 }; }
      case SQL.PENDING_DELETE: { t.pending.delete(bkey(p[0], p[1], p[2])); return { rows: [], rowCount: 1 }; }
      case SQL.BATCH_LIST_DAY: { const out = []; for (const [, v] of t.batch) { if (v.identity === p[0] && v.day_key === p[1]) out.push({ batch_id: v.batch_id, job_id: v.job_id, next_cursor: v.next_cursor, cursor_before: v.cursor_before, payload_digest: v.payload_digest, done: v.done, resulting_revision: v.resulting_revision }); } out.sort((a, b) => a.resulting_revision - b.resulting_revision); return { rows: out.map(({ batch_id, job_id, next_cursor, cursor_before, payload_digest, done }) => ({ batch_id, job_id, next_cursor, cursor_before, payload_digest, done })) }; }
      case SQL.JOBSCHED_LIST: { const out = []; for (const [k, v] of t.jobsched) { const [id, d, job] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ job_id: job, next_eligible_ts: v.next_eligible_ts, backoff_attempts: v.backoff_attempts }); } return { rows: out }; }
      case SQL.JOBSCHED_UPSERT: { t.jobsched.set(bkey(p[0], p[1], p[2]), { next_eligible_ts: p[3], backoff_attempts: p[4] }); return { rows: [], rowCount: 1 }; }
      default: throw new Error(`fake Db: unhandled token ${tok}`);
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map([...t.batch].map(([k, v]) => [k, { ...v }])), completed: new Map([...t.completed].map(([k, v]) => [k, { ...v }])), pending: new Map([...t.pending].map(([k, v]) => [k, { ...v }])), result: t.result.map((r) => ({ ...r })), jobsched: new Map([...t.jobsched].map(([k, v]) => [k, { ...v }])) });
  const restore = (s) => { t.store = s.store; t.day = s.day; t.batch = s.batch; t.completed = s.completed; t.pending = s.pending; t.result = s.result; t.jobsched = s.jobsched; };
  return {
    _t: t,
    setPreCommitFail(fn) { preCommitFail = fn; },
    async query(body, params) { return run(body, params); },
    async tx(fn) {
      const s = snap();
      const q = (body, params) => Promise.resolve(run(body, params));
      const helpers = { raw: (body, params) => Promise.resolve(run(body, params)) };
      try { await q('BEGIN'); const r = await fn(q, helpers); if (preCommitFail && preCommitFail()) throw new Error('SIMULATED crash before COMMIT'); await q('COMMIT'); return r; }
      catch (e) { restore(s); throw e; }
    },
  };
}

// ---- executor + selectors (SIM-1 shape) -------------------------------------
function makeExecutor({ throwForJob = null, override = null } = {}) {
  return {
    async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
      if (throwForJob && job.jobId === throwForJob) throw new Error(`SIMULATED executor failure ${job.jobId}`);
      if (override) return override({ job, cursor, maxEvaluations });
      const start = cursor ?? 0;
      const take = Math.max(0, Math.min(maxEvaluations, 64, job.frames.length - start));
      const frames = job.frames.slice(start, start + take);
      const done = start + take >= job.frames.length;
      const results = [];
      for (const f of frames) for (const v of f) results.push(v); // each frame -> 1..64 variant rows
      return { jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done, results, counters: { frames: take, rows: results.length }, laws: ['fixture'] };
    },
  };
}
const statusOf = (r) => r.status;
const identityOf = (r) => r.simulationId;
const completedOf = (r) => r.completed === true;
const validOf = (r) => r.validModeledOutcome === true;
const prospectiveOf = (r) => r.prospectiveQualificationEligible === true;
const outcomePathSource = { async pathsFor() { return { label: 'FIXTURE', arrivesSeparately: true }; } };
const jobSource = (jobs) => ({ async readyJobs() { return jobs.map((j) => ({ jobId: j.jobId, ...j })); } });
const row = (id, { status = 'COMPLETED_MODELED', completed = true, valid = true, prospective = false } = {}) => ({ simulationId: id, status, completed, validModeledOutcome: valid, prospectiveQualificationEligible: prospective });
// a job of N single-variant completed frames
const modeledFrames = (jobId, n) => ({ jobId, frames: Array.from({ length: n }, (_, i) => [row(`${jobId}#${i}`)]) });

function build({ jobs, db, target = 100, maxEvalsPerTick = 1, execOpts, identity = 'store-test:iso' }) {
  const store = createDailySimulationStore({ db, storeIdentity: identity, dailyTarget: target });
  const scheduler = createDailySimulationScheduler({
    store, jobSource: jobSource(jobs), executor: makeExecutor(execOpts), outcomePathSource,
    statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: target, maxEvalsPerTick,
    clock: (typeof arguments[0].clock === 'function' ? arguments[0].clock : () => DAY1),
  });
  return { store, scheduler };
}

// ---------------------------------------------------------------------------

test('store: uncommissioned -> loadDay LOST (cannot prove NEW); commission -> NEW', async () => {
  const db = makeFakeDb();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:1', dailyTarget: 10 });
  assert.equal((await store.loadDay('2026-09-14')).status, 'LOST');
  await store.commissionStore();
  assert.equal((await store.loadDay('2026-09-14')).status, 'NEW');
});

test('scheduler+store: happy path persists durable evidence and reconciles', async () => {
  const db = makeFakeDb();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:2', dailyTarget: 3 });
  await store.commissionStore();
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('A', 3)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 3, maxEvalsPerTick: 1, clock: () => DAY1 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  assert.equal(s.status().completed, 3);
  const led = (await store.loadDay('2026-09-14'));
  assert.equal(led.status, 'RESUME');
  assert.equal(led.ledger.totals.completed, 3);
  assert.equal(led.ledger.completedIds.length, 3);
  assert.equal(db._t.result.length, 3, 'all result rows retained as evidence');
  assert.equal(led.ledger.revision, 3);
});

test('scheduler+store: restart resumes durable state, no double-count', async () => {
  const db = makeFakeDb();
  const mk = () => createDailySimulationScheduler({ store: createDailySimulationStore({ db, storeIdentity: 'iso:3', dailyTarget: 6 }), jobSource: jobSource([modeledFrames('A', 6)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 6, maxEvalsPerTick: 1, clock: () => DAY1 });
  await createDailySimulationStore({ db, storeIdentity: 'iso:3' }).commissionStore();
  const s1 = mk();
  await s1.runToIdle({ maxTicks: 2 });
  const mid = (await createDailySimulationStore({ db, storeIdentity: 'iso:3' }).loadDay('2026-09-14')).ledger.totals.completed;
  assert.equal(mid, 2);
  const s2 = mk();
  await s2.runToIdle();
  const led = (await createDailySimulationStore({ db, storeIdentity: 'iso:3' }).loadDay('2026-09-14')).ledger;
  assert.equal(led.totals.completed, 6);
  assert.equal(new Set(led.completedIds).size, 6);
});

test('scheduler+store: multi-variant frame — every variant row is evidence + counted', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:mv' }).commissionStore();
  // one frame -> three variant rows (distinct simulationIds); one is valid+prospective
  const job = { jobId: 'MV', frames: [[row('MV#0a'), row('MV#0b', { valid: false }), row('MV#0c', { valid: true, prospective: true })]] };
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:mv', dailyTarget: 3 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([job]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 3, maxEvalsPerTick: 1, clock: () => DAY1 });
  await s.runToIdle();
  const t = s.status().totals;
  assert.equal(t.completed, 3, 'three variant rows from one frame all count');
  assert.equal(t.validModeled, 2);
  assert.equal(t.prospectiveEligible, 1, 'prospectiveEligible is a distinct tally');
  assert.equal(db._t.result.length, 3);
});

test('scheduler+store: pending horizon matures exactly once, durable', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:pm' }).commissionStore();
  let matured = false;
  const override = ({ job }) => (!matured
    ? { jobId: job.jobId, cursor: 0, nextCursor: 0, done: false, results: [{ simulationId: 'PM#0', status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false, prospectiveQualificationEligible: false }], counters: {}, laws: [] }
    : { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: [{ simulationId: 'PM#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: true, prospectiveQualificationEligible: false }], counters: {}, laws: [] });
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:pm', dailyTarget: 1 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([{ jobId: 'PM', frames: [] }]), executor: makeExecutor({ override }), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 1, maxEvalsPerTick: 1, clock: () => DAY1 });
  const t1 = await s.tick();
  assert.equal(t1.pending, 1); assert.equal(t1.credited, 0);
  assert.equal(db._t.pending.size, 1, 'pending custody durable');
  matured = true;
  const t2 = await s.tick();
  assert.equal(t2.credited, 1);
  assert.equal(db._t.pending.size, 0, 'matured pending removed');
  assert.equal(db._t.completed.size, 1);
  assert.notEqual(t1.batchId, t2.batchId);
});

test('scheduler+store: no completed counter ahead of durable evidence (crash before COMMIT)', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:crash' }).commissionStore();
  let fired = false;
  db.setPreCommitFail(() => { if (fired) return false; fired = true; return true; });
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:crash', dailyTarget: 2 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('A', 2)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 2, maxEvalsPerTick: 1, clock: () => DAY1 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'COMMIT_UNACKED');
  assert.equal(s.status().totals.completed, 0, 'scheduler credited nothing');
  assert.equal(db._t.result.length, 0, 'nothing persisted after rollback');
  assert.equal(db._t.completed.size, 0);
  await s.runToIdle();
  assert.equal(s.status().totals.completed, 2, 'recovers after the one-shot crash');
  assert.equal(db._t.completed.size, 2);
});

test('scheduler+store: exhausted input persists a visible shortfall', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:sf' }).commissionStore();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:sf', dailyTarget: 10 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('A', 3)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 10, maxEvalsPerTick: 1, clock: () => DAY1 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'SHORTFALL');
  const day = db._t.day.get('iso:sf|2026-09-14');
  assert.ok(day.shortfall && day.shortfall.reason === 'INPUT_EXHAUSTED');
});

test('scheduler+store: two-candidate fairness, both progress', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:fair' }).commissionStore();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:fair', dailyTarget: 100 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('A', 4), modeledFrames('B', 4)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 100, maxEvalsPerTick: 1, clock: () => DAY1 });
  const seen = [];
  for (let i = 0; i < 4; i += 1) { const t = await s.tick(); if (t.jobId) seen.push(t.jobId); }
  assert.ok(seen.includes('A') && seen.includes('B'));
});

test('scheduler+store: daily rollover keeps separate ledgers', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:roll' }).commissionStore();
  let now = DAY1;
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:roll', dailyTarget: 2 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('A', 2)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 2, maxEvalsPerTick: 1, clock: () => now });
  await s.runToIdle();
  assert.equal(s.status().completed, 2);
  now = DAY2; // rollover
  const s2 = createDailySimulationScheduler({ store, jobSource: jobSource([modeledFrames('C', 2)]), executor: makeExecutor(), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 2, maxEvalsPerTick: 1, clock: () => now });
  await s2.runToIdle();
  assert.equal(db._t.day.get('iso:roll|2026-09-14').revision, 2);
  assert.equal(db._t.day.get('iso:roll|2026-09-15').revision, 2);
});

// ---- sim2-revisit-1: bounded pending backoff --------------------------------
function pendingOverride(getMatured) {
  // a stuck pending does NOT advance the cursor: nextCursor === cursorBefore
  return ({ job, cursor }) => (!getMatured()
    ? { jobId: job.jobId, cursor: cursor ?? 0, nextCursor: cursor ?? null, done: false, results: [{ simulationId: 'PP#0', status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false, prospectiveQualificationEligible: false }], counters: {}, laws: [] }
    : { jobId: job.jobId, cursor: cursor ?? 0, nextCursor: null, done: true, results: [{ simulationId: 'PP#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: true, prospectiveQualificationEligible: false }], counters: {}, laws: [] });
}

test('backoff: an unchanged pending page is not re-committed; job backs off, no spin', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:pp' }).commissionStore();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:pp', dailyTarget: 5 });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([{ jobId: 'PP', frames: [] }]), executor: makeExecutor({ override: pendingOverride(() => false) }), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 5, maxEvalsPerTick: 1, pendingBackoff: { baseMs: 1000, maxMs: 60000, maxAttempts: 3 }, clock: () => DAY1 });
  const t1 = await s.tick(); assert.equal(t1.tick, 'APPLIED'); assert.equal(t1.credited, 0); // first pending committed once
  assert.equal(db._t.result.length, 1, 'pending evidence recorded once');
  const t2 = await s.tick(); assert.equal(t2.tick, 'PENDING_BACKOFF'); assert.equal(t2.backoffAttempts, 1);
  assert.equal(db._t.result.length, 1, 'unchanged pending page did NOT add duplicate evidence');
  const t3 = await s.tick(); assert.equal(t3.tick, 'ALL_BACKED_OFF'); // no spin — job waits, no other candidate
  assert.equal(s.status().totals.completed, 0);
  assert.ok(db._t.jobsched.size >= 1, 'backoff persisted');
});

test('backoff: survives restart, then matures and credits once', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:mb' }).commissionStore();
  let now = DAY1; let matured = false;
  const mk = () => createDailySimulationScheduler({ store: createDailySimulationStore({ db, storeIdentity: 'iso:mb', dailyTarget: 1 }), jobSource: jobSource([{ jobId: 'PP', frames: [] }]), executor: makeExecutor({ override: pendingOverride(() => matured) }), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 1, maxEvalsPerTick: 1, pendingBackoff: { baseMs: 1000, maxMs: 60000, maxAttempts: 5 }, clock: () => now });
  const s1 = mk();
  await s1.tick();                 // APPLIED (pending)
  const b = await s1.tick(); assert.equal(b.tick, 'PENDING_BACKOFF');
  const persistedNext = [...db._t.jobsched.values()][0].next_eligible_ts;
  assert.ok(persistedNext > DAY1, 'next_eligible_ts persisted in the future');
  // restart: fresh scheduler+store reads persisted backoff
  now = DAY1 + 5000; matured = true; // window passed + outcome matured
  const s2 = mk();
  const r = await s2.runToIdle();
  assert.equal(s2.status().totals.completed, 1, 'matured and credited exactly once after restart');
  assert.equal(db._t.completed.size, 1);
  assert.equal(new Set([...db._t.completed.keys()]).size, 1, 'no double credit');
});

test('backoff: a backed-off pending job does not block a ready candidate (fairness)', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:fair2' }).commissionStore();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:fair2', dailyTarget: 4 });
  // PP is perpetually pending; RDY has 4 completed frames.
  const execByJob = { async executeDailySimulationBatch(args) {
    if (args.job.jobId === 'PP') return pendingOverride(() => false)(args);
    return makeExecutor().executeDailySimulationBatch(args);
  } };
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([{ jobId: 'PP', frames: [] }, modeledFrames('RDY', 4)]), executor: execByJob, outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, dailyTarget: 4, maxEvalsPerTick: 1, pendingBackoff: { baseMs: 1000, maxMs: 60000, maxAttempts: 3 }, clock: () => DAY1 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  assert.equal(s.status().totals.completed, 4, 'ready job completed despite PP backing off');
});

test('backoff: source maturity hint sets the revisit time', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: 'iso:mat' }).commissionStore();
  const store = createDailySimulationStore({ db, storeIdentity: 'iso:mat', dailyTarget: 5 });
  const HINT = DAY1 + 123456;
  const override = ({ job, cursor }) => ({ jobId: job.jobId, cursor: cursor ?? 0, nextCursor: cursor ?? null, done: false, results: [{ simulationId: 'PP#0', status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false, prospectiveQualificationEligible: false, availableAtTs: HINT }], counters: {}, laws: [] });
  const s = createDailySimulationScheduler({ store, jobSource: jobSource([{ jobId: 'PP', frames: [] }]), executor: makeExecutor({ override }), outcomePathSource, statusOf, identityOf, completedOf, validOf, prospectiveOf, maturityOf: (r) => r.availableAtTs, dailyTarget: 5, maxEvalsPerTick: 1, pendingBackoff: { baseMs: 1000, maxMs: 10_000_000, maxAttempts: 3 }, clock: () => DAY1 });
  await s.tick(); // APPLIED
  const b = await s.tick(); assert.equal(b.tick, 'PENDING_BACKOFF');
  assert.equal(b.nextEligibleTs, HINT, 'source maturity hint used as revisit time (within cap)');
});

// ---- direct store integrity --------------------------------------------------
function receipt(over = {}) {
  const evidence = over.resultEvidence || [{ id: 'S#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'd0' }];
  const completed = evidence.filter((e) => e.completed);
  const newCompletedIds = over.newCompletedIds || completed.map((e) => e.id);
  // tallies consistent with evidence (what the real scheduler always sends)
  const validModeled = completed.filter((e) => e.valid).length;
  const prospectiveEligible = completed.filter((e) => e.prospective).length;
  return {
    port: 'daily-sim-scheduler-2', policyVersion: 'sim2-policy-1', batchId: over.batchId || 'B1', dayKey: over.dayKey || '2026-09-14',
    jobId: over.jobId || 'A', jobDigest: 'jd', payloadDigest: over.payloadDigest || 'pd1',
    cursorBefore: null, nextCursor: null, done: true, parentRevision: over.parentRevision ?? 0, expectedRevision: (over.parentRevision ?? 0) + 1,
    completedResults: [], newCompletedIds, pendingDelta: over.pendingDelta || [], resultEvidence: evidence, byStatus: {},
    tally: { completed: completed.length, validModeled, prospectiveEligible, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length, ...(over.tally || {}) },
    executorCounters: null, executorLaws: null, observedUtcMs: DAY1, shortfall: over.shortfall,
  };
}
async function commissioned(identity = 'iso:d') { const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: identity, dailyTarget: 10 }); await store.commissionStore(); return { db, store }; }

test('store: exact duplicate batch returns the FIRST ack (idempotent)', async () => {
  const { store } = await commissioned();
  const a = await store.commitBatch(receipt());
  assert.equal(a.ok, true); assert.equal(a.revision, 1);
  const b = await store.commitBatch(receipt());
  assert.equal(b.ok, true); assert.equal(b.idempotent, true); assert.equal(b.revision, 1);
});

test('store: same batchId with altered payload is refused', async () => {
  const { store } = await commissioned();
  await store.commitBatch(receipt({ payloadDigest: 'pd1' }));
  const c = await store.commitBatch(receipt({ payloadDigest: 'pd2-ALTERED' }));
  assert.equal(c.ok, false); assert.equal(c.reason, 'BATCH_ID_PAYLOAD_CONFLICT');
});

test('store: stale parentRevision refused', async () => {
  const { store } = await commissioned();
  await store.commitBatch(receipt({ batchId: 'B1', parentRevision: 0 }));
  const stale = await store.commitBatch(receipt({ batchId: 'B2', parentRevision: 0, resultEvidence: [{ id: 'S#9', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'd9' }] }));
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'STALE_PARENT_REVISION'); assert.equal(stale.revision, 1);
});

test('store: forged newCompletedIds are refused (totals derived from evidence)', async () => {
  const { db, store } = await commissioned();
  const r = receipt({ newCompletedIds: ['S#0', 'S#FORGED'] }); // claims 2, evidence has 1 completed
  const res = await store.commitBatch(r);
  assert.equal(res.ok, false); assert.equal(res.reason, 'FORGED_COMPLETED_MISMATCH');
  assert.equal(db._t.result.length, 0, 'nothing persisted on forged receipt');
});

test('store: forged validModeled tally is refused (recomputed from evidence)', async () => {
  const { db, store } = await commissioned('iso:fv');
  const evidence = [{ id: 'V#0', status: 'COMPLETED_MODELED', completed: true, valid: false, prospective: false, digest: 'a' }];
  const r = receipt({ resultEvidence: evidence, tally: { completed: 1, validModeled: 1, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 1 } });
  const res = await store.commitBatch(r);
  assert.equal(res.ok, false); assert.equal(res.reason, 'FORGED_TALLY_MISMATCH'); assert.equal(res.field, 'validModeled');
  assert.equal(db._t.result.length, 0);
});

test('store: forged prospectiveEligible tally is refused (recomputed from evidence)', async () => {
  const { store } = await commissioned('iso:fp');
  const evidence = [{ id: 'P#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'a' }];
  const r = receipt({ resultEvidence: evidence, tally: { completed: 1, validModeled: 1, prospectiveEligible: 1, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 1 } });
  const res = await store.commitBatch(r);
  assert.equal(res.ok, false); assert.equal(res.reason, 'FORGED_TALLY_MISMATCH'); assert.equal(res.field, 'prospectiveEligible');
});

test('store: idempotent replay does not duplicate evidence or advance revision', async () => {
  const { db, store } = await commissioned('iso:idem');
  await store.commitBatch(receipt({ batchId: 'B1' }));
  const rowsAfter1 = db._t.result.length;
  const rev1 = db._t.day.get('iso:idem|2026-09-14').revision;
  const b = await store.commitBatch(receipt({ batchId: 'B1' }));
  assert.equal(b.idempotent, true);
  assert.equal(db._t.result.length, rowsAfter1, 'replay added no evidence rows');
  assert.equal(db._t.day.get('iso:idem|2026-09-14').revision, rev1, 'replay did not advance revision');
});

test('store: two-writer CAS — only one advances from the same parent revision', async () => {
  const { db, store } = await commissioned('iso:cas2');
  const A = await store.commitBatch(receipt({ batchId: 'A1', parentRevision: 0, resultEvidence: [{ id: 'C#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'a' }] }));
  assert.equal(A.revision, 1);
  const B = await store.commitBatch(receipt({ batchId: 'B1', parentRevision: 0, resultEvidence: [{ id: 'C#1', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'b' }] }));
  assert.equal(B.ok, false); assert.equal(B.reason, 'STALE_PARENT_REVISION'); assert.equal(B.revision, 1);
  assert.equal(db._t.day.get('iso:cas2|2026-09-14').revision, 1, 'revision advanced exactly once');
});

test('store: result-rows limit refuses (no truncation)', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: 'iso:lim', dailyTarget: 10, maxResultRows: 4 }); await store.commissionStore();
  const evidence = Array.from({ length: 5 }, (_, i) => ({ id: `L#${i}`, status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: `d${i}` }));
  const res = await store.commitBatch(receipt({ resultEvidence: evidence }));
  assert.equal(res.ok, false); assert.equal(res.reason, 'RESULT_ROWS_LIMIT');
});

test('store: retains ALL statuses as evidence, not only completed', async () => {
  const { db, store } = await commissioned('iso:allstatus');
  const evidence = [
    { id: 'X#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'a' },
    { id: 'X#1', status: 'PENDING_HORIZON', completed: false, valid: false, prospective: false, digest: 'b' },
    { id: 'X#2', status: 'INPUT_REJECTED', completed: false, valid: false, prospective: false, digest: 'c' },
  ];
  const res = await store.commitBatch(receipt({ resultEvidence: evidence, pendingDelta: [{ id: 'X#1', status: 'PENDING_HORIZON', digest: 'b' }] }));
  assert.equal(res.ok, true);
  assert.equal(db._t.result.length, 3, 'every status row retained');
  const statuses = db._t.result.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['COMPLETED_MODELED', 'INPUT_REJECTED', 'PENDING_HORIZON']);
});

test('store: corrupt day (completed index without evidence) loads as LOST', async () => {
  const { db, store } = await commissioned('iso:corrupt');
  await store.commitBatch(receipt({ batchId: 'B1' })); // 1 completed, 1 evidence row
  db._t.completed.set('iso:corrupt|2026-09-14|GHOST', { batch_id: 'B1' }); // completed index entry with no evidence
  const load = await store.loadDay('2026-09-14');
  assert.equal(load.status, 'LOST');
});
