// SIM-2 scheduler — focused mechanics tests. All fixtures are EXPLICITLY
// labeled deterministic stand-ins for the SIM-1 executor / store / sources
// (owned elsewhere). No market data, providers, ledgers, or orders here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDailySimulationScheduler, utcDayKey, SCHEDULER_PORT_VERSION,
  SchedulerStorageError, SchedulerContractError,
} from '../learning/daily-simulation-scheduler.js';

const DAY_MS = Date.UTC(2026, 8, 14, 12, 0, 0); // fixed UTC instant for all tests

// ---- FIXTURE: atomic, idempotent day store (labeled stand-in) ---------------
function makeStore() {
  const days = {};
  let failCommits = 0;
  const emptyLedger = (dayKey) => ({
    port: SCHEDULER_PORT_VERSION, dayKey, target: 0, rotationIndex: 0,
    totals: { attempted: 0, completed: 0, valid: 0, pending: 0, missing: 0, invalid: 0, duplicates: 0, batchesApplied: 0 },
    jobs: {}, completedIds: [], appliedBatchIds: [], shortfall: null,
  });
  return {
    _peek: (dayKey) => days[dayKey] ? structuredClone(days[dayKey]) : null,
    failNextCommits(n) { failCommits = n; },
    async loadDay(dayKey) { return days[dayKey] ? structuredClone(days[dayKey]) : null; },
    async commitBatch(receipt) {
      if (failCommits > 0) { failCommits -= 1; throw new Error('SIMULATED store commit failure (lost ACK)'); }
      const led = days[receipt.dayKey] || (days[receipt.dayKey] = emptyLedger(receipt.dayKey));
      if (led.appliedBatchIds.includes(receipt.batchId)) return { ok: true, batchId: receipt.batchId, idempotent: true };
      led.appliedBatchIds.push(receipt.batchId);
      const t = receipt.tally;
      const attempted = t.completed + t.pending + t.missing + t.invalid + t.duplicates + (t.other || 0);
      led.totals.attempted += attempted;
      led.totals.completed += t.completed;
      led.totals.valid += t.completed;
      led.totals.pending += t.pending;
      led.totals.missing += t.missing;
      led.totals.invalid += t.invalid;
      led.totals.duplicates += t.duplicates;
      led.totals.batchesApplied += 1;
      for (const idk of receipt.newCompletedIds) led.completedIds.push(idk);
      if (receipt.jobId && receipt.jobId !== '__shortfall__') {
        const js = led.jobs[receipt.jobId] || (led.jobs[receipt.jobId] = { cursor: null, done: false, completed: 0, attempts: 0, lastStatus: 'NEW', stalled: false });
        js.cursor = receipt.nextCursor; js.completed += t.completed; js.done = receipt.done === true; js.lastStatus = 'APPLIED';
      }
      if (receipt.shortfall) led.shortfall = receipt.shortfall;
      return { ok: true, batchId: receipt.batchId };
    },
  };
}

// ---- FIXTURE: deterministic executor over a job's evaluation list -----------
// A job: { jobId, evals: [{ id, status }] }. Pure function of (job, cursor).
function makeExecutor({ throwForJob = null } = {}) {
  return {
    async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
      if (throwForJob && job.jobId === throwForJob) throw new Error(`SIMULATED executor failure for ${job.jobId}`);
      const start = cursor ?? 0;
      const take = Math.max(0, Math.min(maxEvaluations, job.evals.length - start));
      const slice = job.evals.slice(start, start + take);
      const done = start + take >= job.evals.length;
      return {
        jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done,
        results: slice.map((e) => ({ evaluationId: e.id, status: e.status })),
        counters: { returned: take }, laws: ['fixture-executor'],
      };
    },
  };
}
const statusOf = (r) => r.status;
const identityOf = (r) => r.evaluationId;
const outcomePathSource = { async pathsFor() { return { label: 'FIXTURE_OUTCOME_PATHS', arrivesSeparately: true }; } };
const makeJobSource = (jobs) => ({ async readyJobs() { return jobs.map((j) => ({ jobId: j.jobId, ...j })); } });

function completedEvals(jobId, n) { return { jobId, evals: Array.from({ length: n }, (_, i) => ({ id: `${jobId}#${i}`, status: 'completed' })) }; }
const baseDeps = (jobs, store, execOpts) => ({
  store, jobSource: makeJobSource(jobs), executor: makeExecutor(execOpts), outcomePathSource,
  statusOf, identityOf, clock: () => DAY_MS,
});

// ---------------------------------------------------------------------------

test('UTC day accounting is explicit and stable', () => {
  assert.equal(utcDayKey(DAY_MS), '2026-09-14');
  assert.throws(() => utcDayKey(-1), SchedulerContractError);
});

test('contract: missing selectors/deps are rejected up front', () => {
  const store = makeStore();
  assert.throws(() => createDailySimulationScheduler({ store }), SchedulerContractError);
  assert.throws(() => createDailySimulationScheduler({ ...baseDeps([], store), statusOf: null }), SchedulerContractError);
});

test('happy path: completes a job and reconciles store totals', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 3)], store), dailyTarget: 3, maxEvalsPerTick: 10 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET'); // 3 available, target 3 — met exactly
  const st = s.status();
  assert.equal(st.totals.completed, 3);
  assert.equal(st.totals.valid, 3);
  const led = store._peek('2026-09-14');
  assert.equal(led.totals.completed, 3);
  assert.equal(led.completedIds.length, 3, 'store completedIds reconcile with completed total');
  assert.deepEqual([...led.completedIds].sort(), ['A#0', 'A#1', 'A#2']);
});

test('daily budget caps evaluations per day (no overrun)', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 100)], store), dailyTarget: 5, maxEvalsPerTick: 50 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  assert.equal(s.status().totals.completed, 5, 'exactly the daily target, not the 50-per-tick or 100 available');
});

test('single-flight: an overlapping tick is skipped, not run concurrently', async () => {
  const store = makeStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowExec = { async executeDailySimulationBatch(args) { await gate; return makeExecutor().executeDailySimulationBatch(args); } };
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 2)], store), executor: slowExec, dailyTarget: 100, maxEvalsPerTick: 10 });
  const first = s.tick();
  const second = await s.tick(); // returns immediately while first is in-flight
  assert.equal(second.tick, 'SKIPPED_INFLIGHT');
  release();
  const firstOut = await first;
  assert.equal(firstOut.tick, 'APPLIED');
});

test('stop/drain: in-flight tick finishes, new ticks refuse', async () => {
  const store = makeStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowExec = { async executeDailySimulationBatch(args) { await gate; return makeExecutor().executeDailySimulationBatch(args); } };
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 2)], store), executor: slowExec, dailyTarget: 100, maxEvalsPerTick: 10 });
  const first = s.tick();
  const drained = s.stop();
  release();
  await first;
  await drained; // resolves once in-flight tick completed
  const after = await s.tick();
  assert.equal(after.tick, 'DRAINING');
});

test('restart after ACK: totals persist and do not reset or double-count', async () => {
  const store = makeStore();
  const jobs = [completedEvals('A', 6)];
  const s1 = createDailySimulationScheduler({ ...baseDeps(jobs, store), dailyTarget: 6, maxEvalsPerTick: 2 });
  await s1.runToIdle({ maxTicks: 1 });               // exactly one committed batch
  const mid = store._peek('2026-09-14');
  assert.equal(mid.totals.completed, 2, 'first batch persisted 2');

  // fresh scheduler, same store — simulates a process restart
  const s2 = createDailySimulationScheduler({ ...baseDeps(jobs, store), dailyTarget: 6, maxEvalsPerTick: 2 });
  const boot = s2.status();
  assert.equal(boot.utcDayKey, '2026-09-14');
  const run = await s2.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const led = store._peek('2026-09-14');
  assert.equal(led.totals.completed, 6, 'resumed to full target, no reset');
  assert.equal(led.completedIds.length, 6);
  assert.equal(new Set(led.completedIds).size, 6, 'no duplicate completed identities across restart');
});

test('lost ACK is retried idempotently — no double count', async () => {
  const store = makeStore();
  store.failNextCommits(1); // first commit throws (ACK lost)
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 3)], store), dailyTarget: 3, maxEvalsPerTick: 10 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'COMMIT_UNACKED');
  assert.equal(s.status().totals.completed, 0, 'no credit without ACK');
  assert.equal(store._peek('2026-09-14'), null, 'store untouched by the failed commit');
  const run = await s.runToIdle();
  assert.equal(s.status().totals.completed, 3, 'retry credited exactly once');
  assert.equal(store._peek('2026-09-14').totals.completed, 3);
  assert.equal(run.last, 'TARGET_MET');
});

test('store commit is idempotent for a replayed receipt', async () => {
  const store = makeStore();
  const receipt = {
    port: SCHEDULER_PORT_VERSION, batchId: 'D|A|INIT', dayKey: '2026-09-14', jobId: 'A',
    cursorBefore: null, nextCursor: null, done: true,
    completedResults: [{ evaluationId: 'A#0', status: 'completed' }], newCompletedIds: ['A#0'],
    tally: { completed: 1, pending: 0, missing: 0, invalid: 0, duplicates: 0, other: 0 },
    executorCounters: null, executorLaws: null, observedUtcMs: DAY_MS,
  };
  const a = await store.commitBatch(receipt);
  const b = await store.commitBatch(receipt);
  assert.equal(a.ok, true); assert.equal(b.idempotent, true);
  assert.equal(store._peek('2026-09-14').totals.completed, 1, 'replay did not double-count');
});

test('malformed executor result fails the batch without crediting', async () => {
  const store = makeStore();
  const badExec = { async executeDailySimulationBatch() { return { jobId: 'A', results: 'not-an-array', done: false, nextCursor: 1 }; } };
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 3)], store), executor: badExec, dailyTarget: 100, maxEvalsPerTick: 10, maxJobAttempts: 2 });
  const t1 = await s.tick();
  assert.equal(t1.tick, 'EXEC_FAILED');
  assert.equal(s.status().totals.completed, 0);
});

test('a failing job is parked (stalled) and does not starve a healthy job', async () => {
  const store = makeStore();
  const jobs = [completedEvals('A', 4), completedEvals('B', 4)];
  // executor throws only for A; B is healthy. Target = B's full output.
  const s = createDailySimulationScheduler({ ...baseDeps(jobs, store, { throwForJob: 'A' }), dailyTarget: 4, maxEvalsPerTick: 1, maxJobAttempts: 3 });
  const run = await s.runToIdle();
  const st = s.status();
  assert.equal(st.totals.completed, 4, 'healthy job B completed despite A failing');
  assert.equal(st.jobs.A.stalled, true, 'A parked after exhausting attempts');
  assert.equal(run.last, 'TARGET_MET');
});

test('pending/missing/invalid never count as completed', async () => {
  const store = makeStore();
  const job = { jobId: 'M', evals: [
    { id: 'M#0', status: 'completed' }, { id: 'M#1', status: 'pending' },
    { id: 'M#2', status: 'missing' }, { id: 'M#3', status: 'invalid' }, { id: 'M#4', status: 'completed' },
  ] };
  const s = createDailySimulationScheduler({ ...baseDeps([job], store), dailyTarget: 100, maxEvalsPerTick: 10 });
  await s.runToIdle();
  const t = s.status().totals;
  assert.equal(t.completed, 2);
  assert.equal(t.pending, 1); assert.equal(t.missing, 1); assert.equal(t.invalid, 1);
  assert.equal(t.attempted, 5);
});

test('duplicate completed identities are counted once', async () => {
  const store = makeStore();
  const job = { jobId: 'D', evals: [
    { id: 'D#0', status: 'completed' }, { id: 'D#0', status: 'completed' }, { id: 'D#1', status: 'completed' },
  ] };
  const s = createDailySimulationScheduler({ ...baseDeps([job], store), dailyTarget: 100, maxEvalsPerTick: 10 });
  await s.runToIdle();
  const t = s.status().totals;
  assert.equal(t.completed, 2, 'unique completed only');
  assert.equal(t.duplicates, 1);
  assert.equal(store._peek('2026-09-14').completedIds.length, 2);
});

test('exhausted input surfaces a visible shortfall, never fabricated results', async () => {
  const store = makeStore();
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 3)], store), dailyTarget: 10, maxEvalsPerTick: 10 });
  const run = await s.runToIdle();
  assert.equal(run.last, 'SHORTFALL');
  const sf = s.status().shortfall;
  assert.equal(sf.completed, 3); assert.equal(sf.shortfall, 7); assert.equal(sf.reason, 'INPUT_EXHAUSTED');
  const led = store._peek('2026-09-14');
  assert.equal(led.totals.completed, 3, 'no fake results added to reach target');
  assert.ok(led.shortfall, 'shortfall persisted for restart visibility');
});

test('fail-closed storage: corrupt day ledger aborts, no empty reset', async () => {
  const store = makeStore();
  const badStore = {
    ...store,
    async loadDay() { return { dayKey: '2026-09-14', totals: { completed: 5 }, completedIds: ['x'], appliedBatchIds: [] }; },
  };
  const s = createDailySimulationScheduler({ ...baseDeps([completedEvals('A', 3)], badStore), dailyTarget: 100 });
  await assert.rejects(s.tick(), SchedulerStorageError); // completedIds(1) != completed(5)
});

test('fair rotation alternates between two ready jobs', async () => {
  const store = makeStore();
  const jobs = [completedEvals('A', 4), completedEvals('B', 4)];
  const s = createDailySimulationScheduler({ ...baseDeps(jobs, store), dailyTarget: 100, maxEvalsPerTick: 1 });
  const seen = [];
  for (let i = 0; i < 4; i += 1) { const t = await s.tick(); if (t.jobId) seen.push(t.jobId); }
  assert.ok(seen.includes('A') && seen.includes('B'), 'both jobs progress within the first ticks (no starvation)');
});
