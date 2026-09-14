// SIM-2 scheduler — focused integrity + mechanics tests. All fixtures are
// EXPLICITLY labeled deterministic stand-ins for the SIM-1 executor / store /
// sources (owned elsewhere). No market data, providers, ledgers, or orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDailySimulationScheduler, utcDayKey, SCHEDULER_PORT_VERSION, DEFAULT_POLICY_VERSION,
  HARD_MAX_EVALS_PER_BATCH, SchedulerStorageError, SchedulerContractError, SchedulerIntegrityError,
} from '../learning/daily-simulation-scheduler.js';

const DAY_MS = Date.UTC(2026, 8, 14, 12, 0, 0);

// ---- FIXTURE: atomic, idempotent, CAS day store (labeled stand-in) ----------
function makeStore() {
  const days = {};
  const acks = {};                 // batchId -> { payloadDigest, revision }
  let failCommits = 0;             // throw BEFORE apply (pure lost ACK)
  let applyThenThrow = 0;          // apply THEN throw (held ACK)
  let staleOnce = false;           // reject next commit ok:false STALE (no apply)
  let corruptAck = false;          // return ok:true but wrong payloadDigest
  let loadOverride = null;         // e.g. () => null  (ambiguous) or {status:'LOST'} or {status:'RESUME', ledger:bad}
  const emptyLedger = (dayKey) => ({
    port: SCHEDULER_PORT_VERSION, policyVersion: DEFAULT_POLICY_VERSION, dayKey, target: 0, revision: 0, commissioned: true, rotationIndex: 0,
    totals: { attempted: 0, completed: 0, validModeled: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, batchesApplied: 0, overshoot: 0 },
    byStatus: {}, jobs: {}, completedIds: [], pendingCustody: {}, appliedBatchIds: [], shortfall: null,
  });
  function apply(led, r) {
    led.appliedBatchIds.push(r.batchId);
    led.revision += 1;
    const t = r.tally;
    led.totals.attempted += t.pageSize;
    led.totals.completed += t.completed;
    led.totals.validModeled += t.validModeled;
    led.totals.pending += t.pending;
    led.totals.terminalNonCompleted += t.terminalNonCompleted;
    led.totals.duplicates += t.duplicates;
    led.totals.batchesApplied += 1;
    for (const [s, n] of Object.entries(r.byStatus)) led.byStatus[s] = (led.byStatus[s] || 0) + n;
    for (const idk of r.newCompletedIds) { led.completedIds.push(idk); if (led.pendingCustody[idk]) delete led.pendingCustody[idk]; }
    for (const p of r.pendingDelta) led.pendingCustody[p.id] = { status: p.status, digest: p.digest, lastSeenRev: led.revision };
    if (r.jobId && r.jobId !== '__shortfall__') {
      const js = led.jobs[r.jobId] || (led.jobs[r.jobId] = { cursor: null, done: false, completed: 0, attempts: 0, lastStatus: 'NEW', stalled: false });
      js.cursor = r.nextCursor; js.completed += t.completed; js.done = r.done === true; js.lastStatus = 'APPLIED';
    }
    if (r.shortfall) led.shortfall = r.shortfall;
    acks[r.batchId] = { payloadDigest: r.payloadDigest, revision: led.revision };
  }
  return {
    _peek: (dayKey) => days[dayKey] ? structuredClone(days[dayKey]) : null,
    failNextCommits(n) { failCommits = n; },
    applyThenThrowNext(n) { applyThenThrow = n; },
    forceStaleOnce() { staleOnce = true; },
    corruptNextAck() { corruptAck = true; },
    setLoadOverride(fn) { loadOverride = fn; },
    async loadDay(dayKey) {
      if (loadOverride) return loadOverride(dayKey);
      if (!days[dayKey]) return { status: 'NEW' };
      return { status: 'RESUME', ledger: structuredClone(days[dayKey]) };
    },
    async commitBatch(receipt) {
      if (failCommits > 0) { failCommits -= 1; throw new Error('SIMULATED store commit failure (pure lost ACK)'); }
      const existing = days[receipt.dayKey] || null;
      if (existing && existing.appliedBatchIds.includes(receipt.batchId)) { const a = acks[receipt.batchId]; return { ok: true, batchId: receipt.batchId, payloadDigest: a.payloadDigest, revision: a.revision, idempotent: true }; }
      const currentRev = existing ? existing.revision : 0;
      if (staleOnce) { staleOnce = false; return { ok: false, reason: 'STALE_PARENT_REVISION', revision: currentRev }; }
      if (receipt.parentRevision !== currentRev) return { ok: false, reason: 'STALE_PARENT_REVISION', revision: currentRev };
      const led = existing || (days[receipt.dayKey] = emptyLedger(receipt.dayKey)); // materialize only on real apply
      if (applyThenThrow > 0) { applyThenThrow -= 1; apply(led, receipt); throw new Error('SIMULATED held ACK (applied then connection lost)'); }
      apply(led, receipt);
      const payloadDigest = corruptAck ? (corruptAck = false, 'fnv1a64:deadbeefdeadbeef') : receipt.payloadDigest;
      return { ok: true, batchId: receipt.batchId, payloadDigest, revision: led.revision };
    },
  };
}

// ---- FIXTURE: deterministic executor over a job's eval list -----------------
// Job: { jobId, evals:[{ id, status, completed, valid }] }. maxEvaluations
// respected (<=64). Pure function of (job, cursor) unless a controllable
// override is supplied (pending->mature test).
function makeExecutor({ throwForJob = null, override = null } = {}) {
  return {
    async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
      if (throwForJob && job.jobId === throwForJob) throw new Error(`SIMULATED executor failure for ${job.jobId}`);
      if (override) return override({ job, cursor, maxEvaluations });
      const start = cursor ?? 0;
      const take = Math.max(0, Math.min(maxEvaluations, HARD_MAX_EVALS_PER_BATCH, job.evals.length - start));
      const slice = job.evals.slice(start, start + take);
      const done = start + take >= job.evals.length;
      return {
        jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done,
        results: slice.map((e) => ({ simulationId: e.id, status: e.status, completed: e.completed === true, validModeledOutcome: e.valid === true, promotionEligible: false, prospectiveQualificationEligible: false })),
        counters: { returned: take }, laws: ['fixture-executor'],
      };
    },
  };
}
const statusOf = (r) => r.status;
const identityOf = (r) => r.simulationId;
const completedOf = (r) => r.completed === true;
const validOf = (r) => r.validModeledOutcome === true;
const outcomePathSource = { async pathsFor() { return { label: 'FIXTURE_OUTCOME_PATHS', arrivesSeparately: true }; } };
const makeJobSource = (jobs) => ({ async readyJobs() { return jobs.map((j) => ({ jobId: j.jobId, ...j })); } });

const modeled = (jobId, n) => ({ jobId, evals: Array.from({ length: n }, (_, i) => ({ id: `${jobId}#${i}`, status: 'COMPLETED_MODELED', completed: true, valid: true })) });
const deps = (jobs, store, execOpts) => ({
  store, jobSource: makeJobSource(jobs), executor: makeExecutor(execOpts), outcomePathSource,
  statusOf, identityOf, completedOf, validOf, clock: () => DAY_MS,
});

// ---------------------------------------------------------------------------

test('UTC day accounting is explicit and stable', () => {
  assert.equal(utcDayKey(DAY_MS), '2026-09-14');
  assert.throws(() => utcDayKey(-1), SchedulerContractError);
});

test('contract: missing selectors/deps rejected up front', () => {
  const store = makeStore();
  assert.throws(() => createDailySimulationScheduler({ store }), SchedulerContractError);
  assert.throws(() => createDailySimulationScheduler({ ...deps([], store), completedOf: null }), SchedulerContractError);
});

test('happy path: completes a job and reconciles store totals', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 3)], store), dailyTarget: 3, maxEvalsPerTick: 10 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const st = s.status();
  assert.equal(st.totals.completed, 3);
  assert.equal(st.totals.validModeled, 3);
  const led = store._peek('2026-09-14');
  assert.equal(led.totals.completed, 3);
  assert.equal(led.completedIds.length, 3);
  assert.equal(led.revision, 1);
});

test('completed is NOT collapsed into valid learning', async () => {
  const store = makeStore();
  const job = { jobId: 'V', evals: [
    { id: 'V#0', status: 'COMPLETED_MODELED', completed: true, valid: true },
    { id: 'V#1', status: 'COMPLETED_AMBIGUOUS', completed: true, valid: false },
    { id: 'V#2', status: 'COMPLETED_EVIDENCE_INELIGIBLE', completed: true, valid: false },
  ] };
  const s = createDailySimulationScheduler({ ...deps([job], store), dailyTarget: 3, maxEvalsPerTick: 10 });
  await s.runToIdle();
  const t = s.status().totals;
  assert.equal(t.completed, 3, 'all three are completed simulations');
  assert.equal(t.validModeled, 1, 'only one is a valid modeled outcome — separate tally');
  assert.deepEqual(s.status().byStatus, { COMPLETED_MODELED: 1, COMPLETED_AMBIGUOUS: 1, COMPLETED_EVIDENCE_INELIGIBLE: 1 });
});

test('honest bounded-page overshoot — never truncate to hit target', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 100)], store), dailyTarget: 5, maxEvalsPerTick: 10 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const t = s.status().totals;
  assert.equal(t.completed, 10, 'the full bounded page of 10 is credited, not truncated to 5');
  assert.equal(t.overshoot, 5, 'overshoot recorded honestly');
  assert.equal(store._peek('2026-09-14').totals.completed, 10);
});

test('per-batch page is hard-capped at 64; an oversized page is refused (not truncated)', async () => {
  const store = makeStore();
  const bigExec = { async executeDailySimulationBatch({ job }) { return { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: Array.from({ length: 65 }, (_, i) => ({ simulationId: `X#${i}`, status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: true })), counters: {}, laws: [] }; } };
  const s = createDailySimulationScheduler({ ...deps([modeled('X', 1)], store), executor: bigExec, dailyTarget: 100, maxEvalsPerTick: 64 });
  const t = await s.tick();
  assert.equal(t.tick, 'EXEC_FAILED');
  assert.equal(s.status().totals.completed, 0);
});

test('single-flight: overlapping tick is skipped', async () => {
  const store = makeStore();
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { async executeDailySimulationBatch(a) { await gate; return makeExecutor().executeDailySimulationBatch(a); } };
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 2)], store), executor: slow, dailyTarget: 100, maxEvalsPerTick: 10 });
  const first = s.tick();
  const second = await s.tick();
  assert.equal(second.tick, 'SKIPPED_INFLIGHT');
  release(); assert.equal((await first).tick, 'APPLIED');
});

test('stop/drain: in-flight finishes, new ticks refuse', async () => {
  const store = makeStore();
  let release; const gate = new Promise((r) => { release = r; });
  const slow = { async executeDailySimulationBatch(a) { await gate; return makeExecutor().executeDailySimulationBatch(a); } };
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 2)], store), executor: slow, dailyTarget: 100, maxEvalsPerTick: 10 });
  const first = s.tick(); const drained = s.stop(); release(); await first; await drained;
  assert.equal((await s.tick()).tick, 'DRAINING');
});

test('restart after ACK: totals/revision persist, no reset or double-count', async () => {
  const store = makeStore();
  const jobs = [modeled('A', 6)];
  const s1 = createDailySimulationScheduler({ ...deps(jobs, store), dailyTarget: 6, maxEvalsPerTick: 2 });
  await s1.runToIdle({ maxTicks: 1 });
  assert.equal(store._peek('2026-09-14').totals.completed, 2);
  const s2 = createDailySimulationScheduler({ ...deps(jobs, store), dailyTarget: 6, maxEvalsPerTick: 2 });
  const run = await s2.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const led = store._peek('2026-09-14');
  assert.equal(led.totals.completed, 6);
  assert.equal(new Set(led.completedIds).size, 6);
  assert.equal(led.revision, 3);
});

test('pure lost ACK is retried idempotently — no double count', async () => {
  const store = makeStore();
  store.failNextCommits(1);
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 3)], store), dailyTarget: 3, maxEvalsPerTick: 10 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'COMMIT_UNACKED');
  assert.equal(s.status().totals.completed, 0);
  assert.equal(store._peek('2026-09-14'), null, 'nothing applied on pure lost ACK');
  await s.runToIdle();
  assert.equal(s.status().totals.completed, 3);
  assert.equal(store._peek('2026-09-14').totals.completed, 3);
});

test('held ACK (applied then connection lost) credits exactly once on retry', async () => {
  const store = makeStore();
  store.applyThenThrowNext(1);
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 2)], store), dailyTarget: 2, maxEvalsPerTick: 10 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'COMMIT_UNACKED');
  assert.equal(store._peek('2026-09-14').totals.completed, 2, 'store applied once');
  assert.equal(s.status().totals.completed, 0, 'scheduler withheld credit until ACK');
  await s.runToIdle();
  assert.equal(s.status().totals.completed, 2, 'idempotent replay credited exactly once');
  assert.equal(store._peek('2026-09-14').totals.completed, 2, 'store still exactly once');
  assert.equal(store._peek('2026-09-14').revision, 1);
});

test('stale writer / CAS rejection: no credit, reload, then succeed', async () => {
  const store = makeStore();
  store.forceStaleOnce();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 2)], store), dailyTarget: 2, maxEvalsPerTick: 10 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'COMMIT_REJECTED');
  assert.equal(t1.reason, 'STALE_PARENT_REVISION');
  assert.equal(store._peek('2026-09-14'), null, 'nothing credited/persisted on stale rejection');
  await s.runToIdle();
  assert.equal(s.status().totals.completed, 2, 'recovered after reload');
});

test('store CAS rejects a stale parentRevision at the store level', async () => {
  const store = makeStore();
  const base = { port: SCHEDULER_PORT_VERSION, policyVersion: DEFAULT_POLICY_VERSION, dayKey: '2026-09-14', done: true, byStatus: {}, pendingDelta: [], newCompletedIds: [], resultEvidence: [], completedResults: [], tally: { completed: 0, validModeled: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 0 } };
  const a = await store.commitBatch({ ...base, batchId: 'B1', jobId: 'A', nextCursor: null, parentRevision: 0, payloadDigest: 'p1' });
  assert.equal(a.ok, true); assert.equal(a.revision, 1);
  const b = await store.commitBatch({ ...base, batchId: 'B2', jobId: 'B', nextCursor: null, parentRevision: 0, payloadDigest: 'p2' });
  assert.equal(b.ok, false); assert.equal(b.reason, 'STALE_PARENT_REVISION'); assert.equal(b.revision, 1);
});

test('ACK payload mismatch is an integrity failure', async () => {
  const store = makeStore();
  store.corruptNextAck();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 1)], store), dailyTarget: 1, maxEvalsPerTick: 10 });
  await assert.rejects(s.tick(), SchedulerIntegrityError);
});

test('commissioned/new-day proof: bare null is ambiguous and fails closed', async () => {
  const store = makeStore();
  store.setLoadOverride(() => null);
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 1)], store), dailyTarget: 1 });
  await assert.rejects(s.tick(), SchedulerStorageError);
});

test('LOST custody fails closed (no empty reset)', async () => {
  const store = makeStore();
  store.setLoadOverride(() => ({ status: 'LOST', detail: 'ledger unreadable' }));
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 1)], store), dailyTarget: 1 });
  await assert.rejects(s.tick(), SchedulerStorageError);
});

test('corrupt RESUME ledger (completedIds != completed) fails closed', async () => {
  const store = makeStore();
  store.setLoadOverride(() => ({ status: 'RESUME', ledger: { dayKey: '2026-09-14', revision: 1, totals: { completed: 5 }, completedIds: ['x'], appliedBatchIds: [], pendingCustody: {} } }));
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 1)], store), dailyTarget: 1 });
  await assert.rejects(s.tick(), SchedulerStorageError);
});

test('pending/terminal never count as completed; pending held in custody', async () => {
  const store = makeStore();
  const job = { jobId: 'M', evals: [
    { id: 'M#0', status: 'COMPLETED_MODELED', completed: true, valid: true },
    { id: 'M#1', status: 'PENDING_HORIZON', completed: false, valid: false },
    { id: 'M#2', status: 'OUTCOME_PATH_MISSING', completed: false, valid: false },
    { id: 'M#3', status: 'INPUT_REJECTED', completed: false, valid: false },
  ] };
  const s = createDailySimulationScheduler({ ...deps([job], store), dailyTarget: 1, maxEvalsPerTick: 10 });
  await s.runToIdle();
  const t = s.status().totals;
  assert.equal(t.completed, 1);
  assert.equal(t.pending, 2, 'PENDING_HORIZON + OUTCOME_PATH_MISSING held as revisitable');
  assert.equal(t.terminalNonCompleted, 1, 'INPUT_REJECTED terminal, not pending, not completed');
  assert.equal(s.status().pendingCustodyCount, 2);
  const led = store._peek('2026-09-14');
  assert.deepEqual(Object.keys(led.pendingCustody).sort(), ['M#1', 'M#2']);
});

test('a pending horizon matures later, credited once, no ID reuse conflict', async () => {
  const store = makeStore();
  let matured = false;
  const override = ({ job }) => (!matured
    ? { jobId: job.jobId, cursor: 0, nextCursor: 0, done: false, results: [{ simulationId: 'PM#0', status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false }], counters: {}, laws: [] }
    : { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: [{ simulationId: 'PM#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: true }], counters: {}, laws: [] });
  const s = createDailySimulationScheduler({ ...deps([{ jobId: 'PM', evals: [] }], store, { override }), dailyTarget: 1, maxEvalsPerTick: 10 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'APPLIED'); assert.equal(t1.pending, 1); assert.equal(t1.credited, 0);
  assert.equal(s.status().pendingCustodyCount, 1);
  matured = true;
  const t2 = await s.tick();
  assert.equal(t2.tick, 'APPLIED'); assert.equal(t2.credited, 1);
  assert.notEqual(t1.batchId, t2.batchId, 'mature revisit uses a different batchId (no payload-conflicting reuse)');
  assert.equal(s.status().totals.completed, 1);
  assert.equal(s.status().pendingCustodyCount, 0, 'matured simulation removed from pending custody');
  assert.equal(store._peek('2026-09-14').completedIds.length, 1, 'credited exactly once');
});

test('duplicate completed identities counted once', async () => {
  const store = makeStore();
  const job = { jobId: 'D', evals: [
    { id: 'D#0', status: 'COMPLETED_MODELED', completed: true, valid: true },
    { id: 'D#0', status: 'COMPLETED_MODELED', completed: true, valid: true },
    { id: 'D#1', status: 'COMPLETED_MODELED', completed: true, valid: true },
  ] };
  const s = createDailySimulationScheduler({ ...deps([job], store), dailyTarget: 2, maxEvalsPerTick: 10 });
  await s.runToIdle();
  const t = s.status().totals;
  assert.equal(t.completed, 2); assert.equal(t.duplicates, 1);
  assert.equal(store._peek('2026-09-14').completedIds.length, 2);
});

test('exhausted input surfaces a visible shortfall, never fabricated results', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 3)], store), dailyTarget: 10, maxEvalsPerTick: 10 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'SHORTFALL');
  const sf = s.status().shortfall;
  assert.equal(sf.completed, 3); assert.equal(sf.shortfall, 7); assert.equal(sf.reason, 'INPUT_EXHAUSTED');
  assert.equal(store._peek('2026-09-14').totals.completed, 3);
  assert.ok(store._peek('2026-09-14').shortfall, 'shortfall persisted for restart visibility');
});

test('failing job is parked (STALLED) and does not starve a healthy job', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 4), modeled('B', 4)], store, { throwForJob: 'A' }), dailyTarget: 4, maxEvalsPerTick: 1, maxJobAttempts: 3 });
  const run = await s.runToIdle();
  assert.equal(s.status().totals.completed, 4);
  assert.equal(s.status().jobs.A.stalled, true);
  assert.equal(run.last, 'TARGET_MET');
});

test('fair rotation alternates between two ready jobs', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...deps([modeled('A', 4), modeled('B', 4)], store), dailyTarget: 100, maxEvalsPerTick: 1 });
  const seen = [];
  for (let i = 0; i < 4; i += 1) { const t = await s.tick(); if (t.jobId) seen.push(t.jobId); }
  assert.ok(seen.includes('A') && seen.includes('B'));
});
