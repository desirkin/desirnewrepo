// SIM-2 — bounded, resumable daily simulation SCHEDULER (component only).
//
// This module SCHEDULES work; it does NOT execute simulations, read markets,
// call providers, write ledgers/orders, or invent result fields. It drives an
// INJECTED executor (the SIM-1 daily-simulation-executor, owned elsewhere) and
// persists progress through an INJECTED atomic store. Everything market-shaped
// is opaque to the scheduler.
//
// Ownership boundary (SIM-2): this file + its focused tests only. The executor
// result schema is consumed through injected selectors (statusOf / identityOf)
// so the scheduler never hard-codes or invents executor fields.
//
// Core laws enforced here:
//   * Single-flight ticks — never two overlapping executions.
//   * Deterministic fair rotation — round-robin over ready jobs; a stalled job
//     never starves the others.
//   * Daily budget — a default 100,000 completed evaluations/day target, in
//     UTC accounting that is explicitly labeled.
//   * Atomic commit before credit — a batch's completed results and its cursor
//     advance ONLY on an exact store ACK. No ACK => no advance, no count.
//   * Idempotent retry — a batch has a deterministic batchId; a lost ACK is
//     retried and the store applies it at most once, so restart/retry never
//     double-counts. Completed totals never reset on restart.
//   * Honest tallies — pending/missing/invalid are tracked but NEVER counted as
//     completed. Exhausted input surfaces a visible shortfall, never fake
//     repeated results.
//   * Fail-closed storage — a missing/corrupt/unavailable store aborts; the
//     scheduler never silently resets to an empty day.

export const SCHEDULER_PORT_VERSION = 'daily-sim-scheduler-1';
export const DEFAULT_DAILY_TARGET = 100_000;
export const DEFAULT_MAX_EVALS_PER_TICK = 500;
export const DEFAULT_MAX_JOB_ATTEMPTS = 8; // per job, per day, before it is parked as STALLED

const RESULT_STATES = Object.freeze(['completed', 'pending', 'missing', 'invalid']);

export class SchedulerStorageError extends Error {
  constructor(message) { super(`SCHEDULER_STORAGE: ${message}`); this.name = 'SchedulerStorageError'; }
}
export class SchedulerContractError extends Error {
  constructor(message) { super(`SCHEDULER_CONTRACT: ${message}`); this.name = 'SchedulerContractError'; }
}

// UTC day key (YYYY-MM-DD) — the accounting boundary, explicitly UTC.
export function utcDayKey(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new SchedulerContractError('clock must return a non-negative safe integer (UTC ms)');
  return new Date(ms).toISOString().slice(0, 10);
}

const isFn = (v) => typeof v === 'function';

// A fresh, zeroed day ledger. Completed is the ONLY budget-bearing tally.
function emptyDay(dayKey, target) {
  return {
    port: SCHEDULER_PORT_VERSION,
    dayKey,
    target,
    rotationIndex: 0,
    totals: { attempted: 0, completed: 0, valid: 0, pending: 0, missing: 0, invalid: 0, duplicates: 0, batchesApplied: 0 },
    jobs: {},                 // jobId -> { cursor, done, completed, attempts, lastStatus, stalled }
    completedIds: [],         // unique completed evaluation identities (dedupe key set, persisted)
    appliedBatchIds: [],      // idempotency ledger for commits
    shortfall: null,          // set when input is exhausted before target
  };
}

export function createDailySimulationScheduler({
  store,
  jobSource,
  executor,
  outcomePathSource,
  statusOf,
  identityOf,
  clock = () => Date.now(),
  monotonic = () => performance.now(),
  dailyTarget = DEFAULT_DAILY_TARGET,
  maxEvalsPerTick = DEFAULT_MAX_EVALS_PER_TICK,
  maxJobAttempts = DEFAULT_MAX_JOB_ATTEMPTS,
  log = () => {},
} = {}) {
  // ---- dependency contract (fail fast, never invent) -----------------------
  if (!store || !isFn(store.loadDay) || !isFn(store.commitBatch)) throw new SchedulerContractError('store must expose loadDay() and commitBatch()');
  if (!jobSource || !isFn(jobSource.readyJobs)) throw new SchedulerContractError('jobSource must expose readyJobs()');
  if (!executor || !isFn(executor.executeDailySimulationBatch)) throw new SchedulerContractError('executor must expose executeDailySimulationBatch()');
  if (!outcomePathSource || !isFn(outcomePathSource.pathsFor)) throw new SchedulerContractError('outcomePathSource must expose pathsFor()');
  if (!isFn(statusOf)) throw new SchedulerContractError('statusOf(result) selector is required (scheduler never hard-codes executor fields)');
  if (!isFn(identityOf)) throw new SchedulerContractError('identityOf(result) selector is required');
  if (!Number.isSafeInteger(dailyTarget) || dailyTarget <= 0) throw new SchedulerContractError('dailyTarget must be a positive integer');
  if (!Number.isSafeInteger(maxEvalsPerTick) || maxEvalsPerTick <= 0) throw new SchedulerContractError('maxEvalsPerTick must be a positive integer');

  let day = null;            // in-memory mirror of the persisted day ledger
  let ticking = false;       // single-flight guard
  let draining = false;      // stop() requested; finish in-flight, start no new tick
  let drainWaiters = [];
  const metrics = { ticks: 0, batches: 0, execMsTotal: 0, commitMsTotal: 0, lastTickMs: 0 };

  function resolveDrainIfIdle() {
    if (draining && !ticking) { const w = drainWaiters; drainWaiters = []; w.forEach((r) => r()); }
  }

  // Load (or fail-closed) the day ledger for the given UTC day. A store that is
  // missing/corrupt/unavailable ABORTS — never a silent empty-day reset.
  async function ensureDay(dayKey) {
    if (day && day.dayKey === dayKey) return day;
    let loaded;
    try { loaded = await store.loadDay(dayKey); }
    catch (err) { throw new SchedulerStorageError(`loadDay failed for ${dayKey}: ${err && err.message}`); }
    if (loaded === undefined) throw new SchedulerStorageError(`loadDay returned undefined for ${dayKey} (unavailable); refusing empty reset`);
    if (loaded === null) { day = emptyDay(dayKey, dailyTarget); return day; }
    validateLoadedDay(loaded, dayKey);
    // Restart safety: completed totals and cursors are adopted verbatim; they
    // are never reset. completedIds/appliedBatchIds rehydrate the dedupe sets.
    day = normalizeLoadedDay(loaded, dayKey);
    return day;
  }

  function validateLoadedDay(loaded, dayKey) {
    if (typeof loaded !== 'object' || Array.isArray(loaded)) throw new SchedulerStorageError('day ledger is not an object');
    if (loaded.dayKey !== dayKey) throw new SchedulerStorageError(`day ledger key ${loaded.dayKey} != requested ${dayKey}`);
    if (!loaded.totals || !Number.isSafeInteger(loaded.totals.completed) || loaded.totals.completed < 0) throw new SchedulerStorageError('day ledger totals.completed corrupt');
    if (!Array.isArray(loaded.completedIds)) throw new SchedulerStorageError('day ledger completedIds corrupt');
    if (!Array.isArray(loaded.appliedBatchIds)) throw new SchedulerStorageError('day ledger appliedBatchIds corrupt');
    if (loaded.completedIds.length !== loaded.totals.completed) {
      throw new SchedulerStorageError(`day ledger inconsistent: ${loaded.completedIds.length} completedIds vs completed=${loaded.totals.completed}`);
    }
  }

  function normalizeLoadedDay(loaded, dayKey) {
    const base = emptyDay(dayKey, dailyTarget);
    return {
      ...base,
      ...loaded,
      dayKey,
      target: dailyTarget,
      totals: { ...base.totals, ...loaded.totals },
      jobs: { ...(loaded.jobs || {}) },
      completedIds: [...loaded.completedIds],
      appliedBatchIds: [...loaded.appliedBatchIds],
      shortfall: loaded.shortfall ?? null,
      rotationIndex: Number.isSafeInteger(loaded.rotationIndex) ? loaded.rotationIndex : 0,
    };
  }

  function jobState(jobId) {
    if (!day.jobs[jobId]) day.jobs[jobId] = { cursor: null, done: false, completed: 0, attempts: 0, lastStatus: 'NEW', stalled: false };
    return day.jobs[jobId];
  }

  function remainingToday() { return Math.max(0, day.target - day.totals.completed); }

  // Deterministic batchId — the idempotency key. Same (day, job, cursorBefore)
  // always maps to the same batch, so a retried lost-ACK commit is a no-op.
  function batchIdOf(jobId, cursorBefore) {
    return `${day.dayKey}|${jobId}|${cursorBefore === null || cursorBefore === undefined ? 'INIT' : String(cursorBefore)}`;
  }

  // Choose the next ready job by fair round-robin, skipping done/stalled jobs.
  // Returns { job, jobId } or null when nothing is runnable this tick.
  function pickJob(readyJobs) {
    const runnable = readyJobs.filter((j) => {
      const st = day.jobs[j.jobId];
      return !st || (!st.done && !st.stalled);
    });
    if (runnable.length === 0) return null;
    // Stable order by jobId, then rotate by persisted rotationIndex for fairness.
    runnable.sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    const idx = day.rotationIndex % runnable.length;
    return { job: runnable[idx], jobId: runnable[idx].jobId };
  }

  function validateExecResult(res, expectJobId) {
    if (!res || typeof res !== 'object') throw new SchedulerContractError('executor returned a non-object result');
    if (res.jobId !== expectJobId) throw new SchedulerContractError(`executor jobId ${res.jobId} != scheduled ${expectJobId}`);
    if (!Array.isArray(res.results)) throw new SchedulerContractError('executor result.results must be an array');
    if (typeof res.done !== 'boolean') throw new SchedulerContractError('executor result.done must be boolean');
    // nextCursor may be null (done) but must be present as a key.
    if (!('nextCursor' in res)) throw new SchedulerContractError('executor result must carry nextCursor');
    return res;
  }

  // One unit of work: pick a job, run a bounded batch, atomically persist, then
  // credit ONLY on ACK. Returns a short outcome tag for tests/telemetry.
  async function tick({ nowTs = clock() } = {}) {
    if (ticking) return { tick: 'SKIPPED_INFLIGHT' };
    if (draining) return { tick: 'DRAINING' };
    ticking = true;
    const startedMono = monotonic();
    try {
      const dayKey = utcDayKey(nowTs);
      await ensureDay(dayKey);
      metrics.ticks += 1;

      if (remainingToday() === 0) return { tick: 'TARGET_MET', dayKey, completed: day.totals.completed };

      let readyJobs;
      try { readyJobs = await jobSource.readyJobs({ dayKey, max: 64 }); }
      catch (err) { throw new SchedulerStorageError(`jobSource.readyJobs failed: ${err && err.message}`); }
      if (!Array.isArray(readyJobs)) throw new SchedulerContractError('readyJobs() must return an array');

      const picked = pickJob(readyJobs);
      if (!picked) {
        // Nothing runnable. If every known job is done/stalled and we are under
        // target, surface a VISIBLE shortfall — never fabricate results.
        const knownJobIds = new Set([...readyJobs.map((j) => j.jobId), ...Object.keys(day.jobs)]);
        const anyOpen = [...knownJobIds].some((id) => { const st = day.jobs[id]; return !st || (!st.done && !st.stalled); });
        if (!anyOpen && remainingToday() > 0) {
          day.shortfall = { dayKey, target: day.target, completed: day.totals.completed, shortfall: remainingToday(), reason: 'INPUT_EXHAUSTED', observedUtcMs: nowTs };
          await persistShortfall(day.shortfall);
          return { tick: 'SHORTFALL', ...day.shortfall };
        }
        return { tick: 'NO_READY_JOBS', dayKey };
      }

      const { job, jobId } = picked;
      // advance rotation now so the NEXT tick prefers a different job (fairness)
      day.rotationIndex = (day.rotationIndex + 1) >>> 0;

      const st = jobState(jobId);
      const cursorBefore = st.cursor ?? null;
      const batchId = batchIdOf(jobId, cursorBefore);

      // If this batch was already applied (lost-ACK on a prior run), adopt its
      // recorded advance without re-crediting.
      if (day.appliedBatchIds.includes(batchId)) {
        return { tick: 'BATCH_ALREADY_APPLIED', jobId, batchId };
      }

      const maxEvaluations = Math.min(maxEvalsPerTick, remainingToday());
      let outcomePaths;
      try { outcomePaths = await outcomePathSource.pathsFor({ job, cursor: cursorBefore, maxEvaluations }); }
      catch (err) { st.attempts += 1; st.lastStatus = 'PATHS_FAILED'; parkIfExhausted(st); return { tick: 'PATHS_FAILED', jobId, error: String(err && err.message) }; }

      let res;
      const execStart = monotonic();
      try {
        res = await executor.executeDailySimulationBatch({ job, outcomePaths, cursor: cursorBefore, maxEvaluations });
        validateExecResult(res, jobId);
      } catch (err) {
        st.attempts += 1; st.lastStatus = 'EXEC_FAILED'; parkIfExhausted(st);
        return { tick: 'EXEC_FAILED', jobId, attempts: st.attempts, stalled: st.stalled, error: String(err && err.message) };
      } finally {
        metrics.execMsTotal += monotonic() - execStart;
      }

      // Tally the batch WITHOUT crediting completed yet — dedupe completed by
      // identity; pending/missing/invalid never count as completed.
      const tally = { completed: 0, pending: 0, missing: 0, invalid: 0, duplicates: 0, other: 0 };
      const newCompletedIds = [];
      const completedResults = [];
      const seen = new Set(day.completedIds);
      for (const r of res.results) {
        const status = statusOf(r);
        if (!RESULT_STATES.includes(status)) { tally.other += 1; continue; }
        if (status !== 'completed') { tally[status] += 1; continue; }
        const idv = identityOf(r);
        if (idv === undefined || idv === null || idv === '') throw new SchedulerContractError('completed result has no stable identity');
        const idk = String(idv);
        if (seen.has(idk) || newCompletedIds.includes(idk)) { tally.duplicates += 1; continue; }
        newCompletedIds.push(idk);
        completedResults.push(r);
        tally.completed += 1;
      }

      // Build the receipt (the scheduler->store contract). completedResults and
      // the cursor advance are ONE atomic unit.
      const receipt = {
        port: SCHEDULER_PORT_VERSION,
        batchId,
        dayKey: day.dayKey,
        jobId,
        cursorBefore,
        nextCursor: res.nextCursor ?? null,
        done: res.done === true,
        completedResults,          // only 'completed', deduped
        newCompletedIds,           // identity ledger delta
        tally,                     // scheduler-derived (completed/pending/missing/invalid/duplicates)
        executorCounters: res.counters ?? null, // executor's own counters, verbatim (not invented)
        executorLaws: res.laws ?? null,          // executor's own laws, verbatim
        observedUtcMs: nowTs,
      };

      let ack;
      const commitStart = monotonic();
      try { ack = await store.commitBatch(receipt); }
      catch (err) {
        // Lost/failed ACK: do NOT advance, do NOT count. The same batchId will
        // be retried on a later tick and the store applies it at most once.
        st.attempts += 1; st.lastStatus = 'COMMIT_UNACKED'; parkIfExhausted(st);
        return { tick: 'COMMIT_UNACKED', jobId, batchId, retriable: true, error: String(err && err.message) };
      } finally { metrics.commitMsTotal += monotonic() - commitStart; }

      if (!ack || ack.ok !== true || ack.batchId !== batchId) {
        st.attempts += 1; st.lastStatus = 'COMMIT_REJECTED'; parkIfExhausted(st);
        return { tick: 'COMMIT_REJECTED', jobId, batchId, ack: ack ?? null };
      }

      // EXACT ACK received — now, and only now, credit the batch in memory.
      metrics.batches += 1;
      day.appliedBatchIds.push(batchId);
      day.totals.attempted += res.results.length;
      day.totals.completed += tally.completed;
      day.totals.valid += tally.completed; // a completed evaluation is a valid episode
      day.totals.pending += tally.pending;
      day.totals.missing += tally.missing;
      day.totals.invalid += tally.invalid;
      day.totals.duplicates += tally.duplicates;
      day.totals.batchesApplied += 1;
      for (const idk of newCompletedIds) day.completedIds.push(idk);
      st.cursor = receipt.nextCursor;
      st.completed += tally.completed;
      st.attempts = 0;         // progress resets the stall counter
      st.lastStatus = 'APPLIED';
      if (receipt.done) st.done = true;

      return {
        tick: 'APPLIED', jobId, batchId, done: st.done,
        credited: tally.completed, tally,
        completedToday: day.totals.completed, remaining: remainingToday(),
      };
    } finally {
      metrics.lastTickMs = monotonic() - startedMono;
      ticking = false;
      resolveDrainIfIdle();
    }
  }

  function parkIfExhausted(st) {
    if (st.attempts >= maxJobAttempts) { st.stalled = true; st.lastStatus = 'STALLED'; }
  }

  async function persistShortfall(shortfall) {
    // Persist the shortfall marker via a zero-completed receipt so a restart
    // still sees the day as under-target for the right reason. Idempotent.
    const batchId = `${day.dayKey}|__shortfall__|${shortfall.completed}`;
    if (day.appliedBatchIds.includes(batchId)) return;
    const receipt = {
      port: SCHEDULER_PORT_VERSION, batchId, dayKey: day.dayKey, jobId: '__shortfall__',
      cursorBefore: null, nextCursor: null, done: true, completedResults: [], newCompletedIds: [],
      tally: { completed: 0, pending: 0, missing: 0, invalid: 0, duplicates: 0, other: 0 },
      executorCounters: null, executorLaws: null, observedUtcMs: shortfall.observedUtcMs, shortfall,
    };
    try {
      const ack = await store.commitBatch(receipt);
      if (ack && ack.ok === true) day.appliedBatchIds.push(batchId);
    } catch (err) { log(`shortfall persist unacked: ${err && err.message}`); }
  }

  // Run ticks until the day target is met, input is exhausted (shortfall), or a
  // stop() is requested. Single-flight is preserved; each tick yields the event
  // loop so this never monopolizes the CPU (backpressure bound).
  async function runToIdle({ nowTs = null, maxTicks = Infinity } = {}) {
    let n = 0;
    const outcomes = [];
    while (n < maxTicks && !draining) {
      const t = await tick(nowTs === null ? {} : { nowTs });
      outcomes.push(t.tick);
      n += 1;
      if (['TARGET_MET', 'SHORTFALL', 'NO_READY_JOBS', 'DRAINING'].includes(t.tick)) break;
      await new Promise((resolve) => setImmediate(resolve)); // yield — CPU/backpressure bound
    }
    return { ticks: n, outcomes, last: outcomes[outcomes.length - 1] ?? null };
  }

  function stop() {
    draining = true;
    return new Promise((resolve) => { if (!ticking) resolve(); else drainWaiters.push(resolve); });
  }
  function resume() { draining = false; }

  function status(nowTs = clock()) {
    return {
      port: SCHEDULER_PORT_VERSION,
      utcDayKey: day ? day.dayKey : utcDayKey(nowTs),
      target: dailyTarget,
      draining, ticking,
      totals: day ? { ...day.totals } : null,
      remaining: day ? remainingToday() : null,
      shortfall: day ? day.shortfall : null,
      jobs: day ? Object.fromEntries(Object.entries(day.jobs).map(([k, v]) => [k, { ...v }])) : {},
      metrics: { ...metrics, avgExecMs: metrics.batches ? metrics.execMsTotal / metrics.batches : 0, avgCommitMs: metrics.batches ? metrics.commitMsTotal / metrics.batches : 0 },
    };
  }

  return Object.freeze({ SCHEDULER_PORT_VERSION, tick, runToIdle, stop, resume, status });
}
