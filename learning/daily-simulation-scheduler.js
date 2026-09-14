// SIM-2 — bounded, resumable daily simulation SCHEDULER (component only).
//
// This module SCHEDULES work; it does NOT execute simulations, read markets,
// call providers, write ledgers/orders, or invent result fields. It drives an
// INJECTED executor (the SIM-1 daily-simulation-executor, owned elsewhere) and
// persists progress through an INJECTED atomic store. Everything market-shaped
// is opaque to the scheduler and consumed through injected selectors, so no
// executor field is ever hard-coded here.
//
// Ownership boundary (SIM-2): this file + its focused tests only. Do NOT add a
// production store here; the store is injected and its contract is published
// (SCHEDULER_PORT_VERSION) for coordination.
//
// Integrity laws enforced (SIM-2 hardening):
//   * Commissioned/new-day proof — loadDay MUST return a discriminated
//     {status:'NEW'|'RESUME'|'LOST', ledger?}. A bare null/undefined can NOT
//     reset a day: it is ambiguous and fails closed. Only an explicit NEW
//     commissions a fresh day; LOST (prior custody, ledger unrecoverable)
//     aborts.
//   * Receipt binding — every receipt is bound to the exact jobDigest, the
//     raw-page payloadDigest, the parent day revision (CAS), the job cursor,
//     and a fixed policy/port version. A payload-conflicting batch therefore
//     gets a different batchId and can never masquerade as an applied one.
//   * ACK confirms identity — an ACK must echo the exact payloadDigest AND the
//     resulting revision (parent+1), not merely the batchId; otherwise no
//     credit.
//   * All evidence persisted — the receipt carries every result's status
//     evidence and pending/retry custody, not only completed rows. A pending
//     horizon stays revisitable and is credited at most once when it matures.
//   * Bounded pages, honest overshoot — a page is hard-capped (<=64, the
//     executor cap). Results are NEVER truncated to hit the daily target; the
//     final bounded page may overshoot and the overshoot is recorded. The
//     target only gates STARTING new pages.
//   * completed != valid learning — completed simulations and validModeled
//     outcomes are separate tallies; neither is qualified learning.
//   * Single-flight, fair rotation, CPU yield, fail-closed storage, idempotent
//     lost-ACK retry, restart without double-count.
//   * Outcome-body handoff — when a bodyOf(result) selector is injected, a
//     credited result's outcome body is forwarded into the receipt and its
//     result-row digest is bound to the store's EXACT SHA-256 canonical law
//     (imported encodeOutcomeBody), so the durable store can retain a verifiable
//     replay body. No body means metadata-only (unchanged); the store is still
//     the authority on body byte bounds.

import { encodeOutcomeBody, DEFAULT_MAX_OUTCOME_BODY_BYTES } from './daily-simulation-body.js';

export const SCHEDULER_PORT_VERSION = 'daily-sim-scheduler-2';
export const DEFAULT_POLICY_VERSION = 'sim2-policy-1';
export const DEFAULT_DAILY_TARGET = 100_000;
// UNIT LAW: maxEvaluations counts DECISION FRAMES (SIM-1 hard cap 64/frames per
// page). Each frame may emit up to 64 variant RESULT ROWS, so one page can hold
// up to 64*64 = 4096 raw result rows. One evaluation != one result. The daily
// target is measured in completed RESULT ROWS (raw simulations/evaluations),
// deduped by simulation identity. Pages are bounded by rows and frames; the
// last bounded page may overshoot the target honestly — results are never
// truncated then advanced past.
export const HARD_MAX_EVALS_PER_BATCH = 64;      // DECISION FRAMES per page (executor hard cap)
export const MAX_RESULT_ROWS_PER_PAGE = 4096;    // 64 frames * up to 64 variant rows
export const DEFAULT_MAX_EVALS_PER_TICK = 1;     // frames; default 1 => <=64 result rows until larger pages are tested
export const DEFAULT_MAX_JOB_ATTEMPTS = 8;
export const MAX_IDENTITY_BYTES = 256;
// sim2-revisit-1 (additive): bounded persisted revisit/backoff for UNCHANGED
// PENDING_HORIZON pages so a never-maturing job cannot spin. An unchanged
// pending page (same job+cursor+payloadDigest, zero new completed) is NOT
// re-committed; the job is delayed until next_eligible_ts (a source maturity
// hint if present, else capped exponential backoff) and other candidates rotate
// in the meantime. Backoff timing/counters persist across restart. Nothing here
// fabricates completed/zero outcomes or expires evidence.
export const REVISIT_CONTRACT_VERSION = 'sim2-revisit-1';
export const DEFAULT_PENDING_BACKOFF = Object.freeze({ baseMs: 60_000, maxMs: 3_600_000, maxAttempts: 32 });
// Finite hard ceiling for the outcome-body handoff. The scheduler encodes a
// credited body with a bounded max (default 16 KiB) so an oversized body is
// refused BEFORE full canonicalization/allocation here — never encoded with an
// unbounded cap and only rejected later at the store. A caller may lower the
// bound but never raise it past this ceiling.
export const HARD_MAX_OUTCOME_BODY_BYTES = 64 * 1024;

export class SchedulerStorageError extends Error { constructor(m) { super(`SCHEDULER_STORAGE: ${m}`); this.name = 'SchedulerStorageError'; } }
export class SchedulerContractError extends Error { constructor(m) { super(`SCHEDULER_CONTRACT: ${m}`); this.name = 'SchedulerContractError'; } }
export class SchedulerIntegrityError extends Error { constructor(m) { super(`SCHEDULER_INTEGRITY: ${m}`); this.name = 'SchedulerIntegrityError'; } }

const isFn = (v) => typeof v === 'function';

export function utcDayKey(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new SchedulerContractError('clock must return a non-negative safe integer (UTC ms)');
  return new Date(ms).toISOString().slice(0, 10);
}

// ---- structural content digest (NOT cryptographic) --------------------------
// Zero-import FNV-1a/64 over a stable JSON encoding. Sufficient to bind a
// receipt to its exact payload and to detect ACK/payload mismatch within this
// trust boundary. An integrator may inject a stronger `digest`.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
function fnv1a64Hex(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i += 1) { h ^= BigInt(str.charCodeAt(i)); h = (h * prime) & mask; }
  return h.toString(16).padStart(16, '0');
}
function defaultDigest(value) { return `fnv1a64:${fnv1a64Hex(stableStringify(value))}`; }

const REVISITABLE_DEFAULT = new Set(['PENDING_HORIZON', 'OUTCOME_PATH_INCOMPLETE', 'OUTCOME_PATH_MISSING']);

function emptyDay(dayKey, target, policyVersion) {
  return {
    port: SCHEDULER_PORT_VERSION, policyVersion, dayKey, target,
    revision: 0, commissioned: true, rotationIndex: 0,
    totals: { attempted: 0, completed: 0, validModeled: 0, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, batchesApplied: 0, overshoot: 0 },
    byStatus: {},
    jobs: {},                 // jobId -> { cursor, done, completed, attempts, lastStatus, stalled }
    completedIds: [],         // unique completed simulation identities (dedupe + budget)
    completedSet: new Set(),  // hot-path dedupe: O(page)/tick, NOT rebuilt from full history each tick
    pendingCustody: {},       // simulationId -> { status, digest, firstSeenRev, lastSeenRev, attempts }
    appliedBatchIds: [],      // idempotency ledger
    shortfall: null,
    shortfallPersisted: false,
  };
}

export function createDailySimulationScheduler({
  store, jobSource, executor, outcomePathSource,
  statusOf, identityOf, completedOf, validOf,
  prospectiveOf = () => false, // distinct from completed/validModeled; injected when known
  bodyOf = () => undefined, // optional: the credited result's replayable outcome body (opaque); forwarded to the store bound to the SHA-256 canonical law
  maxOutcomeBodyBytes = DEFAULT_MAX_OUTCOME_BODY_BYTES, // finite per-body encode bound (<= HARD_MAX_OUTCOME_BODY_BYTES); the store still enforces its own byte ceilings
  maturityOf = () => undefined, // optional: source-provided availability/maturity ts (ms) for a pending result
  pendingBackoff = DEFAULT_PENDING_BACKOFF,
  isRevisitable = (r) => !completedOf(r) && REVISITABLE_DEFAULT.has(statusOf(r)),
  digest = defaultDigest,
  jobDigestOf = (job) => defaultDigest(job),
  policyVersion = DEFAULT_POLICY_VERSION,
  clock = () => Date.now(),
  monotonic = () => performance.now(),
  dailyTarget = DEFAULT_DAILY_TARGET,
  maxEvalsPerTick = DEFAULT_MAX_EVALS_PER_TICK,
  maxJobAttempts = DEFAULT_MAX_JOB_ATTEMPTS,
  log = () => {},
} = {}) {
  if (!store || !isFn(store.loadDay) || !isFn(store.commitBatch)) throw new SchedulerContractError('store must expose loadDay() and commitBatch()');
  if (!jobSource || !isFn(jobSource.readyJobs)) throw new SchedulerContractError('jobSource must expose readyJobs()');
  if (!executor || !isFn(executor.executeDailySimulationBatch)) throw new SchedulerContractError('executor must expose executeDailySimulationBatch()');
  if (!outcomePathSource || !isFn(outcomePathSource.pathsFor)) throw new SchedulerContractError('outcomePathSource must expose pathsFor()');
  for (const [name, fn] of [['statusOf', statusOf], ['identityOf', identityOf], ['completedOf', completedOf], ['validOf', validOf]]) {
    if (!isFn(fn)) throw new SchedulerContractError(`${name}(result) selector is required (scheduler never hard-codes executor fields)`);
  }
  if (!Number.isSafeInteger(dailyTarget) || dailyTarget <= 0) throw new SchedulerContractError('dailyTarget must be a positive integer');
  if (!Number.isSafeInteger(maxEvalsPerTick) || maxEvalsPerTick <= 0) throw new SchedulerContractError('maxEvalsPerTick must be a positive integer');
  if (!Number.isSafeInteger(maxOutcomeBodyBytes) || maxOutcomeBodyBytes <= 0 || maxOutcomeBodyBytes > HARD_MAX_OUTCOME_BODY_BYTES) throw new SchedulerContractError(`maxOutcomeBodyBytes must be a positive integer <= ${HARD_MAX_OUTCOME_BODY_BYTES}`);
  const perBatchCap = Math.min(maxEvalsPerTick, HARD_MAX_EVALS_PER_BATCH);

  let day = null;
  let ticking = false;
  let draining = false;
  let drainWaiters = [];
  const metrics = { ticks: 0, batches: 0, execMsTotal: 0, commitMsTotal: 0, lastTickMs: 0 };

  function resolveDrainIfIdle() { if (draining && !ticking) { const w = drainWaiters; drainWaiters = []; w.forEach((r) => r()); } }

  // Commissioned/new-day proof. A bare null/undefined is NOT a fresh day.
  async function ensureDay(dayKey) {
    if (day && day.dayKey === dayKey) return day;
    let res;
    try { res = await store.loadDay(dayKey); }
    catch (err) { throw new SchedulerStorageError(`loadDay failed for ${dayKey}: ${err && err.message}`); }
    if (res === null || res === undefined || typeof res !== 'object' || typeof res.status !== 'string') {
      throw new SchedulerStorageError(`loadDay for ${dayKey} must return {status:'NEW'|'RESUME'|'LOST'}; a bare ${res === null ? 'null' : typeof res} cannot commission or reset a day`);
    }
    if (res.status === 'LOST') throw new SchedulerStorageError(`day ${dayKey} had prior custody but its ledger is unrecoverable (LOST) — refusing to reset`);
    if (res.status === 'NEW') { day = emptyDay(dayKey, dailyTarget, policyVersion); return day; }
    if (res.status === 'RESUME') { validateLoadedDay(res.ledger, dayKey); day = normalizeLoadedDay(res.ledger, dayKey); return day; }
    throw new SchedulerStorageError(`unknown loadDay status ${res.status}`);
  }

  function validateLoadedDay(l, dayKey) {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw new SchedulerStorageError('RESUME ledger is not an object');
    if (l.dayKey !== dayKey) throw new SchedulerStorageError(`ledger day ${l.dayKey} != requested ${dayKey}`);
    if (!Number.isSafeInteger(l.revision) || l.revision < 0) throw new SchedulerStorageError('ledger revision corrupt');
    if (!l.totals || !Number.isSafeInteger(l.totals.completed) || l.totals.completed < 0) throw new SchedulerStorageError('ledger totals.completed corrupt');
    if (!Array.isArray(l.completedIds)) throw new SchedulerStorageError('ledger completedIds corrupt');
    if (!Array.isArray(l.appliedBatchIds)) throw new SchedulerStorageError('ledger appliedBatchIds corrupt');
    if (l.pendingCustody === null || typeof l.pendingCustody !== 'object') throw new SchedulerStorageError('ledger pendingCustody corrupt');
    if (l.completedIds.length !== l.totals.completed) throw new SchedulerStorageError(`ledger inconsistent: ${l.completedIds.length} completedIds vs completed=${l.totals.completed}`);
  }

  function normalizeLoadedDay(l, dayKey) {
    const base = emptyDay(dayKey, dailyTarget, policyVersion);
    return {
      ...base, ...l, dayKey, target: dailyTarget, policyVersion,
      totals: { ...base.totals, ...l.totals },
      byStatus: { ...(l.byStatus || {}) },
      jobs: { ...(l.jobs || {}) },
      completedIds: [...l.completedIds],
      completedSet: new Set(l.completedIds), // rebuilt ONCE at load/restart, not per tick
      pendingCustody: { ...l.pendingCustody },
      appliedBatchIds: [...l.appliedBatchIds],
      shortfall: l.shortfall ?? null,
      shortfallPersisted: !!l.shortfall,
      revision: l.revision,
      rotationIndex: Number.isSafeInteger(l.rotationIndex) ? l.rotationIndex : 0,
    };
  }

  function jobState(jobId) {
    if (!day.jobs[jobId]) day.jobs[jobId] = { cursor: null, done: false, completed: 0, attempts: 0, lastStatus: 'NEW', stalled: false, lastPayloadDigest: null, lastCursor: undefined, backoffAttempts: 0, nextEligibleTs: 0 };
    const st = day.jobs[jobId];
    if (st.backoffAttempts === undefined) st.backoffAttempts = 0;
    if (st.nextEligibleTs === undefined) st.nextEligibleTs = 0;
    if (!('lastPayloadDigest' in st)) st.lastPayloadDigest = null;
    if (!('lastCursor' in st)) st.lastCursor = undefined;
    return st;
  }
  function completedTotal() { return day.totals.completed; }
  function targetMet() { return completedTotal() >= day.target; }

  function batchIdOf({ jobDigest, cursorBefore, parentRevision, payloadDigest }) {
    // canonical cursor serialization (never String()) so object-valued cursors
    // don't collide (String({}) === '[object Object]') and structurally-equal
    // cursors map to one batchId.
    const cur = cursorBefore === null || cursorBefore === undefined ? 'INIT' : `c:${stableStringify(cursorBefore)}`;
    return [SCHEDULER_PORT_VERSION, policyVersion, day.dayKey, jobDigest, cur, `r${parentRevision}`, payloadDigest].join('|');
  }

  function jobRunnable(st, nowTs) { return !st || (!st.done && !st.stalled && !(st.nextEligibleTs > nowTs)); }
  function pickJob(readyJobs, nowTs) {
    const runnable = readyJobs.filter((j) => jobRunnable(day.jobs[j.jobId], nowTs));
    if (runnable.length === 0) return null;
    runnable.sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    const idx = day.rotationIndex % runnable.length;
    return { job: runnable[idx], jobId: runnable[idx].jobId };
  }

  function validateExecResult(res, expectJobId) {
    if (!res || typeof res !== 'object') throw new SchedulerContractError('executor returned a non-object result');
    if (res.jobId !== expectJobId) throw new SchedulerContractError(`executor jobId ${res.jobId} != scheduled ${expectJobId}`);
    if (!Array.isArray(res.results)) throw new SchedulerContractError('executor result.results must be an array');
    // results are RESULT ROWS (frames * variants), bounded by the row cap; the
    // frame count is bounded separately by the maxEvaluations we requested.
    if (res.results.length > MAX_RESULT_ROWS_PER_PAGE) throw new SchedulerIntegrityError(`page of ${res.results.length} result rows exceeds hard cap ${MAX_RESULT_ROWS_PER_PAGE} — refusing to truncate`);
    if (typeof res.done !== 'boolean') throw new SchedulerContractError('executor result.done must be boolean');
    if (!('nextCursor' in res)) throw new SchedulerContractError('executor result must carry nextCursor');
    return res;
  }

  async function tick({ nowTs = clock() } = {}) {
    if (ticking) return { tick: 'SKIPPED_INFLIGHT' };
    if (draining) return { tick: 'DRAINING' };
    ticking = true;
    const startedMono = monotonic();
    try {
      const dayKey = utcDayKey(nowTs);
      await ensureDay(dayKey);
      metrics.ticks += 1;

      if (targetMet()) return { tick: 'TARGET_MET', dayKey, completed: completedTotal(), overshoot: day.totals.overshoot };

      let readyJobs;
      try { readyJobs = await jobSource.readyJobs({ dayKey, max: 64 }); }
      catch (err) { throw new SchedulerStorageError(`jobSource.readyJobs failed: ${err && err.message}`); }
      if (!Array.isArray(readyJobs)) throw new SchedulerContractError('readyJobs() must return an array');

      const picked = pickJob(readyJobs, nowTs);
      if (!picked) {
        const knownJobIds = new Set([...readyJobs.map((j) => j.jobId), ...Object.keys(day.jobs)]);
        // A job that is neither done nor stalled but is waiting on a backoff
        // window is NOT exhausted input — it may still mature.
        const backedOff = [...knownJobIds].filter((id) => { const st = day.jobs[id]; return st && !st.done && !st.stalled && st.nextEligibleTs > nowTs; });
        const anyOpenNow = [...knownJobIds].some((id) => jobRunnable(day.jobs[id], nowTs));
        if (!anyOpenNow && backedOff.length > 0) {
          const earliest = Math.min(...backedOff.map((id) => day.jobs[id].nextEligibleTs));
          return { tick: 'ALL_BACKED_OFF', dayKey, earliestNextEligibleTs: earliest, backedOff: backedOff.length };
        }
        const anyOpenEver = [...knownJobIds].some((id) => { const st = day.jobs[id]; return !st || (!st.done && !st.stalled); });
        if (!anyOpenEver && !targetMet()) {
          day.shortfall = { dayKey, target: day.target, completed: completedTotal(), shortfall: day.target - completedTotal(), pending: Object.keys(day.pendingCustody).length, reason: 'INPUT_EXHAUSTED', observedUtcMs: nowTs };
          await persistShortfall(day.shortfall);
          return { tick: 'SHORTFALL', ...day.shortfall };
        }
        return { tick: 'NO_READY_JOBS', dayKey };
      }

      const { job, jobId } = picked;
      day.rotationIndex = (day.rotationIndex + 1) >>> 0;
      const st = jobState(jobId);
      const cursorBefore = st.cursor ?? null;
      const parentRevision = day.revision;
      const jobDigest = jobDigestOf(job);
      const maxEvaluations = perBatchCap; // NOT clamped to remaining — never truncate to hit target

      let outcomePaths;
      try { outcomePaths = await outcomePathSource.pathsFor({ job, cursor: cursorBefore, maxEvaluations }); }
      catch (err) { st.attempts += 1; st.lastStatus = 'PATHS_FAILED'; parkIfExhausted(st); return { tick: 'PATHS_FAILED', jobId, error: String(err && err.message) }; }

      let res;
      const execStart = monotonic();
      try { res = await executor.executeDailySimulationBatch({ job, outcomePaths, cursor: cursorBefore, maxEvaluations }); validateExecResult(res, jobId); }
      catch (err) { st.attempts += 1; st.lastStatus = 'EXEC_FAILED'; parkIfExhausted(st); return { tick: 'EXEC_FAILED', jobId, attempts: st.attempts, stalled: st.stalled, error: String(err && err.message) }; }
      finally { metrics.execMsTotal += monotonic() - execStart; }

      // Bounded outcome-body preflight — BEFORE the raw page digest. Each credited
      // body is canonicalized with the FINITE maxOutcomeBodyBytes so an oversized
      // or non-canonical body is refused before the page is canonicalized and
      // before a large string is allocated (here or in the store). A rejected
      // body fails the batch (no commit, bounded retries); the store re-validates
      // and re-bounds on commit. Cached for reuse in the evidence loop below.
      const bodyEnc = new Map(); // idk -> { digest, body }
      for (const r of res.results) {
        if (!completedOf(r)) continue;
        const b = bodyOf(r);
        if (b === undefined) continue;
        const idk = String(identityOf(r));
        if (bodyEnc.has(idk)) continue;
        let enc;
        try { enc = encodeOutcomeBody(b, maxOutcomeBodyBytes); }
        catch (err) {
          st.attempts += 1; st.lastStatus = 'BODY_REJECTED'; parkIfExhausted(st);
          return { tick: 'BODY_REJECTED', jobId, sim: idk, reason: err && err.code === 'BODY_TOO_LARGE' ? 'OUTCOME_BODY_BYTES_LIMIT' : 'OUTCOME_BODY_NONCANONICAL', detail: String(err && err.message) };
        }
        bodyEnc.set(idk, { digest: enc.digest, body: b });
      }

      const payloadDigest = digest(res.results); // raw page digest — deterministic, retry-stable (bodies already bounded)
      const batchId = batchIdOf({ jobDigest, cursorBefore, parentRevision, payloadDigest });
      if (day.appliedBatchIds.includes(batchId)) return { tick: 'BATCH_ALREADY_APPLIED', jobId, batchId };

      // Tally the page. Credit completed ONLY (deduped); validModeled tracked
      // separately; pending/terminal recorded as evidence + custody.
      const byStatus = {};
      const newCompletedIds = [];
      const completedResults = [];
      const resultEvidence = [];
      const pendingDelta = [];
      let tCompleted = 0; let tValid = 0; let tProspective = 0; let tPending = 0; let tTerminal = 0; let tDup = 0;
      const seen = day.completedSet; // persistent set — O(page) per tick, not O(history)
      for (const r of res.results) {
        const status = statusOf(r);
        const idv = identityOf(r);
        if (idv === undefined || idv === null || idv === '') throw new SchedulerContractError('result has no stable identity');
        const idk = String(idv);
        if (idk.length > MAX_IDENTITY_BYTES) throw new SchedulerIntegrityError('result identity exceeds byte bound');
        byStatus[status] = (byStatus[status] || 0) + 1;
        const isCompleted = !!completedOf(r);
        const ev = { id: idk, status, completed: isCompleted, valid: !!validOf(r), prospective: !!prospectiveOf(r), digest: digest(r) };
        // Outcome-body handoff: for a CREDITED result whose (bounded, validated)
        // body was accepted in the preflight, forward the opaque body and bind
        // THIS row's digest to the store's exact SHA-256 canonical law. No body
        // => metadata-only (digest stays the structural page digest).
        if (isCompleted) {
          const m = bodyEnc.get(idk);
          if (m) { ev.digest = m.digest; ev.outcomeBody = m.body; } // credited row digest == body content digest (store binds body<->result)
        }
        resultEvidence.push(ev);
        if (completedOf(r)) {
          if (seen.has(idk) || newCompletedIds.includes(idk)) { tDup += 1; continue; }
          newCompletedIds.push(idk); completedResults.push(r); tCompleted += 1;
          if (validOf(r)) tValid += 1;             // valid modeled outcome — subset of completed
          if (prospectiveOf(r)) tProspective += 1; // prospective-eligible — DISTINCT from completed/valid
        } else if (isRevisitable(r)) {
          pendingDelta.push({ id: idk, status, digest: digest(r) }); tPending += 1;
        } else { tTerminal += 1; }
      }

      // sim2-revisit-1: a NO-PROGRESS pending page is NOT re-committed — no
      // duplicate evidence, no manufactured completed/prospective. "Progress" is
      // a new completed OR a new pending sim (custody not seen before); a page
      // with neither, whose content is unchanged from the last committed page
      // (same payload digest), backs off. This is cursor-agnostic: a rescan that
      // merely ADVANCES the cursor while re-emitting the same sims still backs
      // off (finding #2). The first occurrence of any page has a changed digest,
      // so terminal/pending evidence is always recorded once before backoff.
      const newPendingCount = pendingDelta.reduce((n, p) => n + (day.pendingCustody[p.id] ? 0 : 1), 0);
      const madeProgress = tCompleted > 0 || newPendingCount > 0;
      const contentUnchanged = st.lastPayloadDigest === payloadDigest;
      if (!madeProgress && contentUnchanged && res.results.length > 0) {
        st.backoffAttempts = (st.backoffAttempts || 0) + 1;
        const capExp = Math.min(st.backoffAttempts - 1, 30);
        const expDelay = Math.min(pendingBackoff.maxMs, pendingBackoff.baseMs * Math.pow(2, capExp));
        let nextEligibleTs = nowTs + expDelay;
        const hints = [];
        for (const r of res.results) { const m = maturityOf(r); if (Number.isFinite(m) && m > nowTs) hints.push(m); }
        if (hints.length) nextEligibleTs = Math.min(nowTs + pendingBackoff.maxMs, Math.max(...hints)); // source-provided maturity, capped
        const stalled = st.backoffAttempts > pendingBackoff.maxAttempts;
        if (stalled) st.stalled = true;
        st.nextEligibleTs = nextEligibleTs; st.lastStatus = stalled ? 'PENDING_STALLED' : 'PENDING_BACKOFF';
        if (typeof store.recordPendingBackoff === 'function') {
          const w = await store.recordPendingBackoff({ dayKey: day.dayKey, jobId, nextEligibleTs, backoffAttempts: st.backoffAttempts });
          if (!w || w.ok !== true) log(`pending backoff persist refused (${w && w.reason})`);
        }
        return { tick: stalled ? 'PENDING_STALLED' : 'PENDING_BACKOFF', jobId, backoffAttempts: st.backoffAttempts, nextEligibleTs, pending: tPending, credited: 0 };
      }

      const receipt = {
        port: SCHEDULER_PORT_VERSION, policyVersion, batchId, dayKey: day.dayKey, jobId, jobDigest,
        cursorBefore, nextCursor: res.nextCursor ?? null, done: res.done === true,
        parentRevision, expectedRevision: parentRevision + 1, payloadDigest, rotationIndex: day.rotationIndex,
        completedResults, newCompletedIds, pendingDelta, resultEvidence, byStatus,
        tally: { completed: tCompleted, validModeled: tValid, prospectiveEligible: tProspective, pending: tPending, terminalNonCompleted: tTerminal, duplicates: tDup, pageSize: res.results.length },
        executorCounters: res.counters ?? null, executorLaws: res.laws ?? null, observedUtcMs: nowTs,
      };

      let ack;
      const commitStart = monotonic();
      try { ack = await store.commitBatch(receipt); }
      catch (err) { st.attempts += 1; st.lastStatus = 'COMMIT_UNACKED'; parkIfExhausted(st); return { tick: 'COMMIT_UNACKED', jobId, batchId, retriable: true, error: String(err && err.message) }; }
      finally { metrics.commitMsTotal += monotonic() - commitStart; }

      // CAS / stale-writer rejection — reload and retry against fresh revision.
      if (ack && ack.ok === false) {
        st.attempts += 1; st.lastStatus = `COMMIT_REJECTED:${ack.reason || 'UNKNOWN'}`; parkIfExhausted(st);
        day = null; // force reload so a stale parentRevision refreshes
        return { tick: 'COMMIT_REJECTED', jobId, batchId, reason: ack.reason || 'UNKNOWN', retriable: true, storeRevision: ack.revision ?? null };
      }
      // ACK must confirm EXACT payload identity AND resulting revision.
      if (!ack || ack.ok !== true) { st.attempts += 1; st.lastStatus = 'COMMIT_NO_ACK'; parkIfExhausted(st); return { tick: 'COMMIT_NO_ACK', jobId, batchId }; }
      if (ack.batchId !== batchId) throw new SchedulerIntegrityError(`ACK batchId ${ack.batchId} != ${batchId}`);
      if (ack.payloadDigest !== payloadDigest) throw new SchedulerIntegrityError('ACK payloadDigest does not match receipt');
      if (ack.revision !== parentRevision + 1) throw new SchedulerIntegrityError(`ACK revision ${ack.revision} != expected ${parentRevision + 1}`);

      // EXACT ACK — credit now.
      metrics.batches += 1;
      day.revision = ack.revision;
      day.appliedBatchIds.push(batchId);
      day.totals.attempted += res.results.length;
      day.totals.completed += tCompleted;
      day.totals.validModeled += tValid;   // separate; NOT summed into completed as "valid learning"
      day.totals.prospectiveEligible += tProspective; // distinct again from completed/validModeled
      day.totals.pending += tPending;
      day.totals.terminalNonCompleted += tTerminal;
      day.totals.duplicates += tDup;
      day.totals.batchesApplied += 1;
      for (const [s, n] of Object.entries(byStatus)) day.byStatus[s] = (day.byStatus[s] || 0) + n;
      for (const idk of newCompletedIds) { day.completedIds.push(idk); day.completedSet.add(idk); if (day.pendingCustody[idk]) delete day.pendingCustody[idk]; } // matured pending removed
      for (const p of pendingDelta) {
        const prev = day.pendingCustody[p.id];
        day.pendingCustody[p.id] = { status: p.status, digest: p.digest, firstSeenRev: prev ? prev.firstSeenRev : ack.revision, lastSeenRev: ack.revision, attempts: (prev ? prev.attempts : 0) + 1 };
      }
      st.cursor = receipt.nextCursor; st.completed += tCompleted; st.attempts = 0; st.lastStatus = 'APPLIED';
      // A committed batch means progress or a CHANGED page — record it and reset
      // the pending backoff so a later genuine change is retried promptly. If the
      // job had a persisted backoff, clear it durably too (a stale future
      // next_eligible_ts must not hold it after a restart).
      const hadBackoff = st.backoffAttempts > 0 || st.nextEligibleTs > 0;
      st.lastPayloadDigest = payloadDigest; st.lastCursor = cursorBefore; st.backoffAttempts = 0; st.nextEligibleTs = 0;
      if (hadBackoff && typeof store.recordPendingBackoff === 'function') { const w = await store.recordPendingBackoff({ dayKey: day.dayKey, jobId, nextEligibleTs: 0, backoffAttempts: 0 }); if (!w || w.ok !== true) log(`backoff reset persist refused (${w && w.reason})`); }
      if (receipt.done) st.done = true;
      if (completedTotal() > day.target) day.totals.overshoot = completedTotal() - day.target;

      return {
        tick: 'APPLIED', jobId, batchId, revision: day.revision, done: st.done,
        credited: tCompleted, validModeled: tValid, pending: tPending, duplicates: tDup,
        completedToday: completedTotal(), overshoot: day.totals.overshoot, targetMet: targetMet(),
      };
    } finally { metrics.lastTickMs = monotonic() - startedMono; ticking = false; resolveDrainIfIdle(); }
  }

  function parkIfExhausted(st) { if (st.attempts >= maxJobAttempts) { st.stalled = true; st.lastStatus = 'STALLED'; } }

  async function persistShortfall(shortfall) {
    // Record the shortfall marker WITHOUT advancing the revision (a shortfall is
    // not progress). Persist once per day so repeated post-exhaustion ticks
    // cannot inflate the revision or spam rows (finding #1).
    if (day.shortfallPersisted) return;
    if (typeof store.recordShortfall !== 'function') { day.shortfallPersisted = true; return; }
    try { const w = await store.recordShortfall({ dayKey: day.dayKey, shortfall }); if (w && w.ok === true) day.shortfallPersisted = true; else log(`shortfall persist refused (${w && w.reason})`); }
    catch (err) { log(`shortfall persist unacked: ${err && err.message}`); }
  }

  async function runToIdle({ nowTs = null, maxTicks = Infinity } = {}) {
    let n = 0; const outcomes = [];
    while (n < maxTicks && !draining) {
      const t = await tick(nowTs === null ? {} : { nowTs });
      outcomes.push(t.tick); n += 1;
      if (['TARGET_MET', 'SHORTFALL', 'NO_READY_JOBS', 'DRAINING', 'ALL_BACKED_OFF'].includes(t.tick)) break;
      await new Promise((resolve) => setImmediate(resolve)); // CPU/backpressure yield
    }
    return { ticks: n, outcomes, last: outcomes[outcomes.length - 1] ?? null };
  }

  function stop() { draining = true; return new Promise((resolve) => { if (!ticking) resolve(); else drainWaiters.push(resolve); }); }
  function resume() { draining = false; }

  function status(nowTs = clock()) {
    return {
      port: SCHEDULER_PORT_VERSION, policyVersion, utcDayKey: day ? day.dayKey : utcDayKey(nowTs),
      target: dailyTarget, draining, ticking, revision: day ? day.revision : null,
      totals: day ? { ...day.totals } : null, byStatus: day ? { ...day.byStatus } : null,
      completed: day ? completedTotal() : null, targetMet: day ? targetMet() : null,
      pendingCustodyCount: day ? Object.keys(day.pendingCustody).length : null,
      shortfall: day ? day.shortfall : null,
      jobs: day ? Object.fromEntries(Object.entries(day.jobs).map(([k, v]) => [k, { ...v }])) : {},
      metrics: { ...metrics, avgExecMs: metrics.batches ? metrics.execMsTotal / metrics.batches : 0, avgCommitMs: metrics.batches ? metrics.commitMsTotal / metrics.batches : 0 },
    };
  }

  return Object.freeze({ SCHEDULER_PORT_VERSION, POLICY_VERSION: policyVersion, tick, runToIdle, stop, resume, status, _digest: digest });
}
