// Bounded, offline orchestration for one immutable retrospective daily-study
// job. This runner has no scheduler, filesystem, provider, Judge, promotion,
// simulation, or order authority. Persistence is supplied by the caller and
// stores only the local planning receipt/progress defined by daily-study-store.
import {
  buildDailyMoveStudy, sealDailyMoveStudyManifest,
} from './daily-move-study.js';
import { prepareDailyBroadInput } from './daily-broad-input.js';
import {
  DAILY_STUDY_PROGRESS_VERSION, dailyStudyJobDescriptorError,
  dailyStudyProgressUpdateError, dailyStudyResultReceiptError,
  sealDailyStudyInputDescriptor, sealDailyStudyJobDescriptor,
} from './daily-study-store.js';
import {
  AUTHORITY, PURPOSE, deepFreeze, exactKeys, isPlainObject, isTs,
  recipeSealError, stableStringify,
} from './shadow-contracts.js';

export const DAILY_STUDY_RUNNER_VERSION = 'daily-study-runner-1';
export const DAILY_STUDY_RUNNER_JOB_VERSION = 'daily-study-runner-job-1';
export const DAILY_STUDY_RUNNER_TOTAL_STEPS = 3;

const DECLARATION_KEYS = Object.freeze([
  'runnerJobVersion', 'jobId', 'sourceId', 'declaredTs', 'timeZone', 'localDay',
  'dayStartTs', 'dayEndTs', 'recipeSeals', 'rules', 'authority', 'purpose',
]);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const PHASE_RANK = new Map([
  ['DECLARED', 0], ['INPUT_VALIDATED', 1], ['STUDY_BUILT', 2],
  ['PLAN_COMPLETE', 3], ['CANCELLED', 4], ['FINALIZED', 5],
]);
const STORED_PROGRESS_KEYS = Object.freeze([
  'progressVersion', 'phase', 'completedSteps', 'totalSteps',
  'plannedDecisionMoments', 'grossPlannedRecipeVariantSlots',
  'attemptedSimulations', 'completedSimulations', 'validSimulationOutcomes',
  'cancelled', 'note', 'updatedTs',
]);
const PROGRESS_UPDATE_KEYS = Object.freeze(STORED_PROGRESS_KEYS.filter(
  (key) => !['progressVersion', 'updatedTs'].includes(key),
));

const clone = (value) => JSON.parse(stableStringify(value));
const bounded = (value, max = 500) => String(value ?? '').slice(0, max);
const abortError = (detail = 'daily study cancelled') => Object.assign(new Error(bounded(detail)), {
  name: 'AbortError', code: 'DAILY_STUDY_CANCELLED',
});

export function dailyStudyRunnerJobError(value) {
  if (!isPlainObject(value) || exactKeys(value, DECLARATION_KEYS)) return 'runner job declaration shape malformed';
  if (value.runnerJobVersion !== DAILY_STUDY_RUNNER_JOB_VERSION
      || !JOB_ID_RE.test(value.jobId ?? '') || !SAFE_ID_RE.test(value.sourceId ?? '')
      || !isTs(value.declaredTs) || typeof value.timeZone !== 'string' || value.timeZone.length < 1 || value.timeZone.length > 80
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.localDay ?? '')
      || !isTs(value.dayStartTs) || !isTs(value.dayEndTs) || value.dayEndTs <= value.dayStartTs
      || !Array.isArray(value.recipeSeals) || value.recipeSeals.length > 64
      || value.recipeSeals.some((seal) => recipeSealError(seal))
      || !isPlainObject(value.rules) || value.authority !== AUTHORITY || value.purpose !== PURPOSE) {
    return 'runner job declaration violates bounded retrospective planning law';
  }
  let bytes;
  try { bytes = Buffer.byteLength(stableStringify(value), 'utf8'); }
  catch { return 'runner job declaration is not canonically serializable'; }
  if (bytes > 64 * 1024) return 'runner job declaration exceeds 64 KiB';
  return null;
}

export function sealDailyStudyRunnerJob({
  jobId, sourceId, declaredTs, timeZone = 'America/New_York', localDay,
  dayStartTs, dayEndTs, recipeSeals = [], rules = {},
} = {}) {
  const value = {
    runnerJobVersion: DAILY_STUDY_RUNNER_JOB_VERSION, jobId, sourceId, declaredTs,
    timeZone, localDay, dayStartTs, dayEndTs, recipeSeals: clone(recipeSeals),
    rules: clone(rules), authority: AUTHORITY, purpose: PURPOSE,
  };
  const error = dailyStudyRunnerJobError(value);
  if (error) throw Object.assign(new Error(`daily study runner: ${error}`), { code: 'RUNNER_JOB_INVALID' });
  return deepFreeze(value);
}

function validatePorts(inputLoader, outputStore, yieldControl) {
  if (typeof inputLoader !== 'function') throw new TypeError('daily study runner: inputLoader must be an async function');
  if (!isPlainObject(outputStore) && (typeof outputStore !== 'object' || outputStore === null)) throw new TypeError('daily study runner: outputStore malformed');
  for (const method of ['createJob', 'loadJob', 'checkpoint', 'finalize']) {
    if (typeof outputStore[method] !== 'function') throw new TypeError(`daily study runner: outputStore.${method} missing`);
  }
  if (typeof yieldControl !== 'function') throw new TypeError('daily study runner: yieldControl must be a function');
}

function checkedPreparedCapture(capture, declaration) {
  if (!isPlainObject(capture)) throw Object.assign(new Error('daily study runner: loader returned a malformed capture'), { code: 'INPUT_LOAD_INVALID' });
  if (capture.dayStartTs !== declaration.dayStartTs || capture.dayEndTs !== declaration.dayEndTs) {
    throw Object.assign(new Error('daily study runner: loaded capture does not match the declared civil day'), { code: 'INPUT_DAY_MISMATCH' });
  }
  const prepared = prepareDailyBroadInput(capture);
  if (prepared.ok !== true) {
    throw Object.assign(new Error(`daily study runner: bounded input refused: ${prepared.reason}: ${prepared.detail}`), {
      code: 'INPUT_REFUSED', inputReason: prepared.reason,
    });
  }
  if (prepared.diagnostics.mode !== 'BOUNDED_PARTIAL_CAPTURE_ONLY'
      || prepared.diagnostics.fullDayCatalogEpochUnionVerified !== false
      || prepared.diagnostics.persistedRecordContinuityVerified !== false) {
    throw Object.assign(new Error('daily study runner: input overstates bounded partial-capture proof'), { code: 'INPUT_PROOF_INVALID' });
  }
  return prepared;
}

function progressUpdate(phase, completedSteps, counters = null, { cancelled = false, note = null } = {}) {
  const progress = {
    phase, completedSteps, totalSteps: DAILY_STUDY_RUNNER_TOTAL_STEPS,
    plannedDecisionMoments: counters?.plannedDecisionMoments ?? 0,
    grossPlannedRecipeVariantSlots: counters?.grossPlannedRecipeVariantSlots ?? 0,
    attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
    cancelled, note,
  };
  const error = dailyStudyProgressUpdateError(progress);
  if (error) throw Object.assign(new Error(`daily study runner: ${error}`), { code: 'RUNNER_PROGRESS_INVALID' });
  return progress;
}

function assertStoredView(view, jobId) {
  const progress = view?.progress;
  const projected = isPlainObject(progress)
    ? Object.fromEntries(PROGRESS_UPDATE_KEYS.map((key) => [key, progress[key]])) : null;
  if (projected?.phase === 'FINALIZED') projected.phase = 'PLAN_COMPLETE';
  const resultValid = view?.result !== null && view?.result !== undefined
    && dailyStudyResultReceiptError(view.result, view.job) === null;
  if (!isPlainObject(view) || view.job?.jobId !== jobId || dailyStudyJobDescriptorError(view.job)
      || view.jobDigest !== view.job.jobDigest
      || !Number.isSafeInteger(view.revision) || view.revision < 0 || !isPlainObject(progress)
      || exactKeys(progress, STORED_PROGRESS_KEYS) || progress.progressVersion !== DAILY_STUDY_PROGRESS_VERSION
      || !isTs(progress.updatedTs) || !PHASE_RANK.has(progress.phase)
      || dailyStudyProgressUpdateError(projected)
      || (progress.phase === 'FINALIZED') !== resultValid
      || (progress.phase !== 'FINALIZED' && view.result !== null)) {
    throw Object.assign(new Error('daily study runner: output store returned an invalid job view'), { code: 'STORE_VIEW_INVALID' });
  }
  return view;
}

function publicOutcome(status, view, study = null) {
  return deepFreeze({
    runnerVersion: DAILY_STUDY_RUNNER_VERSION, status,
    jobId: view.job.jobId, jobDigest: view.job.jobDigest, revision: view.revision,
    progress: clone(view.progress), result: view.result === null ? null : clone(view.result),
    study,
    detailedStudyPersistedByReceiptStore: false,
    durability: clone(view.job.durability), authority: AUTHORITY, purpose: PURPOSE,
  });
}

export function createDailyStudyRunner({
  declaredJob, inputLoader, outputStore,
  yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
  const declarationError = dailyStudyRunnerJobError(declaredJob);
  if (declarationError) throw Object.assign(new Error(`daily study runner: ${declarationError}`), { code: 'RUNNER_JOB_INVALID' });
  validatePorts(inputLoader, outputStore, yieldControl);
  const declaration = deepFreeze(clone(declaredJob));
  let inFlight = null;
  let cancelled = false;
  let cancelDetail = 'operator cancellation requested';

  const isCancelled = (signal) => cancelled || signal?.aborted === true;
  const cancellationDetail = (signal) => bounded(signal?.reason ?? cancelDetail);
  const checkpointCancelled = async (view, counters, signal) => {
    if (view.progress.phase === 'CANCELLED') return view;
    if (view.progress.phase === 'FINALIZED') return view;
    const truthfulCounters = counters ?? view.progress;
    const completed = Math.max(view.progress.completedSteps, Math.min(DAILY_STUDY_RUNNER_TOTAL_STEPS, PHASE_RANK.get(view.progress.phase) ?? 0));
    return assertStoredView(await outputStore.checkpoint({
      jobId: declaration.jobId, jobDigest: view.job.jobDigest, expectedRevision: view.revision,
      progress: progressUpdate('CANCELLED', completed, truthfulCounters, { cancelled: true, note: cancellationDetail(signal) }),
    }), declaration.jobId);
  };

  const execute = async ({ maxSteps = DAILY_STUDY_RUNNER_TOTAL_STEPS, signal } = {}) => {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > DAILY_STUDY_RUNNER_TOTAL_STEPS) {
      throw Object.assign(new Error('daily study runner: maxSteps must be 1..3'), { code: 'RUNNER_STEP_LIMIT_INVALID' });
    }
    let view = await outputStore.loadJob(declaration.jobId);
    if (view !== null) view = assertStoredView(view, declaration.jobId);
    // A terminal jobId is not enough to prove that this declaration names the
    // same source/day/recipes/rules. Recompute the bounded content-bound job
    // below before honoring any prior terminal state.
    if (isCancelled(signal)) throw abortError(cancellationDetail(signal));

    const capture = await inputLoader({ declaredJob: declaration, signal });
    if (isCancelled(signal)) throw abortError(cancellationDetail(signal));
    const prepared = checkedPreparedCapture(capture, declaration);
    const inputDescriptor = sealDailyStudyInputDescriptor({ sourceId: declaration.sourceId, capture, preparedInput: prepared });
    const manifest = sealDailyMoveStudyManifest({
      createdTs: declaration.declaredTs, timeZone: declaration.timeZone,
      localDay: declaration.localDay, dayStartTs: declaration.dayStartTs,
      dayEndTs: declaration.dayEndTs, acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot,
      recipeSeals: declaration.recipeSeals, rules: declaration.rules,
    });
    const jobDescriptor = sealDailyStudyJobDescriptor({ jobId: declaration.jobId, manifest, inputDescriptor });
    const created = assertStoredView(await outputStore.createJob({ jobDescriptor }), declaration.jobId);
    if (created.job.jobDigest !== jobDescriptor.jobDigest) {
      throw Object.assign(new Error('daily study runner: durable job differs from recomputed immutable content'), { code: 'JOB_CONTENT_CONFLICT' });
    }
    view = created;
    if (view.result !== null || view.progress.phase === 'FINALIZED') return publicOutcome('EXISTING_FINALIZED', view);
    if (view.progress.phase === 'CANCELLED') return publicOutcome('CANCELLED', view);
    if (isCancelled(signal)) return publicOutcome('CANCELLED', await checkpointCancelled(view, null, signal));

    let usedSteps = 0;
    if (PHASE_RANK.get(view.progress.phase) < PHASE_RANK.get('INPUT_VALIDATED')) {
      view = assertStoredView(await outputStore.checkpoint({
        jobId: declaration.jobId, jobDigest: jobDescriptor.jobDigest, expectedRevision: view.revision,
        progress: progressUpdate('INPUT_VALIDATED', 1, null, { note: 'bounded partial capture validated; no full-day continuity claim' }),
      }), declaration.jobId);
      usedSteps += 1; await yieldControl();
      if (isCancelled(signal)) return publicOutcome('CANCELLED', await checkpointCancelled(view, null, signal));
      if (usedSteps >= maxSteps) return publicOutcome('CHECKPOINTED', view);
    }

    const study = buildDailyMoveStudy({
      manifest, acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot,
      marketDays: prepared.marketDays,
    });
    const counters = study.counters;
    if (counters.attemptedSimulations !== 0 || counters.completedSimulations !== 0
        || counters.validSimulationOutcomes !== 0 || counters.fullDetailCasesClaimed !== 0
        || counters.acceptedMarketDays !== prepared.acceptedCatalogSnapshot.acceptedMarketCount) {
      throw Object.assign(new Error('daily study runner: planner output violates zero-credit/full-denominator law'), { code: 'PLAN_OUTPUT_INVALID' });
    }

    if (PHASE_RANK.get(view.progress.phase) < PHASE_RANK.get('STUDY_BUILT')) {
      view = assertStoredView(await outputStore.checkpoint({
        jobId: declaration.jobId, jobDigest: jobDescriptor.jobDigest, expectedRevision: view.revision,
        progress: progressUpdate('STUDY_BUILT', 2, counters, { note: 'retrospective cohort and prefix-only decision frames built' }),
      }), declaration.jobId);
      usedSteps += 1; await yieldControl();
      if (isCancelled(signal)) return publicOutcome('CANCELLED', await checkpointCancelled(view, counters, signal));
      if (usedSteps >= maxSteps) return publicOutcome('CHECKPOINTED', view, study);
    }

    if (PHASE_RANK.get(view.progress.phase) < PHASE_RANK.get('PLAN_COMPLETE')) {
      view = assertStoredView(await outputStore.checkpoint({
        jobId: declaration.jobId, jobDigest: jobDescriptor.jobDigest, expectedRevision: view.revision,
        progress: progressUpdate('PLAN_COMPLETE', 3, counters, { note: 'planning complete; no simulation was attempted or completed' }),
      }), declaration.jobId);
      usedSteps += 1; await yieldControl();
      if (isCancelled(signal)) return publicOutcome('CANCELLED', await checkpointCancelled(view, counters, signal));
    }

    // The authoritative store independently rebuilds this study and seals its
    // receipt. Do not perform a redundant third build here. The caller's study
    // and all input/recipe identity checks still cross that verification wall.
    view = assertStoredView(await outputStore.finalize({
      jobId: declaration.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, study, preparedInput: prepared,
    }), declaration.jobId);
    return publicOutcome(view.status === 'EXISTING' ? 'EXISTING_FINALIZED' : 'FINALIZED', view, study);
  };

  const run = (options) => {
    if (inFlight) return inFlight;
    const task = execute(options);
    inFlight = task.finally(() => { if (inFlight === task || inFlight === wrapped) inFlight = null; });
    const wrapped = inFlight;
    return inFlight;
  };
  const cancel = (reason) => {
    if (!cancelled) { cancelled = true; cancelDetail = bounded(reason ?? cancelDetail); }
  };
  const status = () => deepFreeze({
    runnerVersion: DAILY_STUDY_RUNNER_VERSION, jobId: declaration.jobId,
    inFlight: inFlight !== null, cancellationRequested: cancelled,
    authority: AUTHORITY, purpose: PURPOSE,
  });
  return Object.freeze({ run, cancel, status });
}
