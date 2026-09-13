// Bounded process isolation for the offline retrospective daily-study planner.
//
// The parent never imports the planner/store graph. It launches one fixed child
// module per job with a fixed Node executable, no shell, no caller-selected
// module, and a minimal environment. Per-job processes deliberately trade spawn
// overhead for a fresh heap and a hard kill boundary around synchronous planner
// work.
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DAILY_STUDY_PROCESS_VERSION = 'daily-study-process-1';
export const DAILY_STUDY_PROCESS_PROTOCOL_VERSION = 'daily-study-process-protocol-1';

export const DAILY_STUDY_PROCESS_HARD_LIMITS = Object.freeze({
  maxConcurrency: 2,
  maxQueue: 64,
  maxCaptureFileBytes: 32 * 1024 * 1024,
  maxDeclarationFileBytes: 64 * 1024,
  maxTotalInputFileBytes: 32 * 1024 * 1024,
  maxDecodedWorkingBytes: 96 * 1024 * 1024,
  maxSummaryBytes: 64 * 1024,
  maxOldSpaceMb: 512,
  maxQueueWaitMs: 10 * 60 * 1000,
  maxRunMs: 10 * 60 * 1000,
  maxKillGraceMs: 10 * 1000,
});

export const DAILY_STUDY_PROCESS_DEFAULTS = Object.freeze({
  maxConcurrency: 1,
  maxQueue: 8,
  maxCaptureFileBytes: DAILY_STUDY_PROCESS_HARD_LIMITS.maxCaptureFileBytes,
  maxDeclarationFileBytes: DAILY_STUDY_PROCESS_HARD_LIMITS.maxDeclarationFileBytes,
  maxTotalInputFileBytes: DAILY_STUDY_PROCESS_HARD_LIMITS.maxTotalInputFileBytes,
  maxDecodedWorkingBytes: DAILY_STUDY_PROCESS_HARD_LIMITS.maxDecodedWorkingBytes,
  maxSummaryBytes: DAILY_STUDY_PROCESS_HARD_LIMITS.maxSummaryBytes,
  maxOldSpaceMb: 256,
  maxQueueWaitMs: 2 * 60 * 1000,
  maxRunMs: 2 * 60 * 1000,
  killGraceMs: 2 * 1000,
});

const CHILD_FILE = fileURLToPath(new URL('./daily-study-process-child.js', import.meta.url));
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE_GUARD_FILE = path.join(PROJECT_ROOT, 'test', 'helpers', 'offline-guard.mjs');
const OUTPUT_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SPEC_KEYS = Object.freeze(['captureFile', 'declarationFile', 'outputDir', 'timeoutMs']);
const SUMMARY_KEYS = Object.freeze([
  'processVersion', 'executionModel', 'spawnOverheadPerJob', 'status', 'jobId',
  'jobDigest', 'revision', 'progress', 'result', 'detailedStudyReturned',
  'detailedStudyPersistedByReceiptStore', 'durability', 'authority', 'purpose',
  'inputAccounting', 'resourceBoundary', 'environment', 'claims',
]);
const PROGRESS_KEYS = Object.freeze([
  'phase', 'completedSteps', 'totalSteps', 'plannedDecisionMoments',
  'grossPlannedRecipeVariantSlots', 'attemptedSimulations',
  'completedSimulations', 'validSimulationOutcomes', 'cancelled', 'note', 'updatedTs',
]);
const RESULT_KEYS = Object.freeze([
  'resultVersion', 'resultId', 'resultDigest', 'jobId', 'jobDigest', 'manifestId',
  'manifestDigest', 'studyVersion', 'studyDigest', 'studyBytes', 'caseCount',
  'plannedDecisionMoments', 'grossPlannedRecipeVariantSlots',
  'attemptedSimulations', 'completedSimulations', 'validSimulationOutcomes',
  'fullDetailCasesClaimed', 'resultMode', 'externalArchive', 'authority', 'purpose',
]);
const RESPONSE_KEYS = Object.freeze(['protocolVersion', 'jobToken', 'ok', 'summary']);
const ERROR_RESPONSE_KEYS = Object.freeze(['protocolVersion', 'jobToken', 'ok', 'error']);
const CHILD_ERROR_KEYS = Object.freeze(['code', 'detail', 'phase', 'operatorAction']);
const SAFE_ENV_KEYS = Object.freeze([
  'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
  'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
]);

// Snapshot the repository's already-active TEST guard when this module is
// initialized. A caller may mutate NODE_OPTIONS later (the hostile-env test
// deliberately does); that must neither erase the known guard from a child nor
// cause arbitrary later loader text to cross the process boundary.
const STARTUP_OFFLINE_GUARD = (() => {
  const nativePath = OFFLINE_GUARD_FILE;
  const fileUrl = pathToFileURL(OFFLINE_GUARD_FILE).href;
  const startupOptions = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' ');
  const active = (startupOptions.includes(nativePath) || startupOptions.includes(fileUrl))
    && typeof process.env.COBRA_OFFLINE_GUARD_LOG === 'string'
    && typeof process.env.COBRA_OFFLINE_GUARD_RUN === 'string';
  return Object.freeze({
    active,
    log: active ? process.env.COBRA_OFFLINE_GUARD_LOG : null,
    run: active ? process.env.COBRA_OFFLINE_GUARD_RUN : null,
  });
})();

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const bounded = (value, max = 500) => String(value ?? '').slice(0, max);
const samePath = (a, b) => {
  const left = path.normalize(a); const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const comparablePath = (value) => {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export class DailyStudyProcessError extends Error {
  constructor(code, detail = code, metadata = null) {
    super(bounded(detail));
    this.name = 'DailyStudyProcessError'; this.code = code;
    if (metadata !== null) this.metadata = Object.freeze({ ...metadata });
  }
}

function fail(code, detail, metadata) { throw new DailyStudyProcessError(code, detail, metadata); }

function exactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedInteger(value, fallback, maximum, name, minimum = 1) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    fail('PROCESS_LIMIT_INVALID', `${name} must be ${minimum}..${maximum}`);
  }
  return selected;
}

function canonicalRoot(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('PATH_INVALID', `${name} must be absolute`);
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) fail('PATH_INVALID', `${name} does not exist`);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PATH_ESCAPE', `${name} must be one real directory`);
  const real = realpathSync(resolved);
  if (!samePath(real, resolved)) fail('PATH_ESCAPE', `${name} contains a symbolic-link path`);
  return real;
}

function checkedInputFile(value, root, maximum, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('PATH_INVALID', `${label} must be absolute`);
  const resolved = path.resolve(value);
  if (!isWithin(root, resolved)) fail('PATH_ESCAPE', `${label} is outside its configured input root`);
  if (path.extname(resolved).toLowerCase() !== '.json') fail('PATH_INVALID', `${label} must be a .json file`);
  let stat;
  try { stat = lstatSync(resolved); } catch { fail('PATH_INVALID', `${label} does not exist`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('PATH_ESCAPE', `${label} must be one regular non-symlink file`);
  const real = realpathSync(resolved);
  if (!samePath(real, resolved)) fail('PATH_ESCAPE', `${label} resolves through a symbolic link`);
  if (stat.size < 2 || stat.size > maximum) fail('INPUT_BYTE_LIMIT', `${label} size ${stat.size} is outside 2..${maximum}`);
  return Object.freeze({
    path: real, bytes: stat.size,
    identity: Object.freeze({
      dev: stat.dev, ino: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    }),
  });
}

function checkedOutputDir(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('PATH_INVALID', 'outputDir must be absolute');
  const resolved = path.resolve(value);
  if (!isWithin(root, resolved)) fail('PATH_ESCAPE', 'outputDir is outside its configured output root');
  const relative = path.relative(root, resolved);
  const segments = relative.split(path.sep);
  if (segments.some((segment) => !OUTPUT_SEGMENT_RE.test(segment))) {
    fail('PATH_INVALID', 'outputDir path segments must be bounded safe identifiers');
  }
  let current = root; let missingSeen = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) { missingSeen = true; continue; }
    if (missingSeen) fail('PATH_ESCAPE', 'outputDir ancestry changed during validation');
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(current), current)) {
      fail('PATH_ESCAPE', 'outputDir ancestry must contain only real directories');
    }
  }
  if (!existsSync(path.dirname(resolved))) fail('PATH_INVALID', 'outputDir immediate parent must already exist');
  return resolved;
}

function pathsOverlap(left, right) {
  const a = comparablePath(left); const b = comparablePath(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function safeChildEnvironment() {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  env.DAILY_STUDY_PROCESS_CHILD = '1';
  // The repository's test harness monkeypatches fork and otherwise reinjects a
  // Windows path that Node cannot parse as an ESM URL. Preserve only this exact
  // known guard (never arbitrary NODE_OPTIONS) using a file URL. The harmless
  // title marker contains the guard's native path, so its wrapper recognizes
  // that the guard is already present and does not append a second loader.
  if (STARTUP_OFFLINE_GUARD.active) {
    env.NODE_OPTIONS = `--import="${pathToFileURL(OFFLINE_GUARD_FILE).href}" --title="${OFFLINE_GUARD_FILE}"`;
    env.COBRA_OFFLINE_GUARD_LOG = STARTUP_OFFLINE_GUARD.log;
    env.COBRA_OFFLINE_GUARD_RUN = STARTUP_OFFLINE_GUARD.run;
  }
  return env;
}

function childError(message) {
  const code = typeof message?.error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(message.error.code)
    ? message.error.code : 'CHILD_REPORTED_FAILURE';
  return new DailyStudyProcessError(code, bounded(message?.error?.detail ?? code), {
    phase: bounded(message?.error?.phase ?? 'UNKNOWN', 80),
    operatorAction: bounded(message?.error?.operatorAction ?? 'inspect the dedicated output directory before retry', 300),
  });
}

function count(value) { return Number.isSafeInteger(value) && value >= 0; }
export function isDailyStudyProcessSummary(value) {
  if (!exactKeys(value, SUMMARY_KEYS)
      || value.processVersion !== DAILY_STUDY_PROCESS_VERSION
      || value.executionModel !== 'ONE_CHILD_PROCESS_PER_JOB'
      || value.spawnOverheadPerJob !== true
      || !['FINALIZED', 'EXISTING_FINALIZED', 'CANCELLED'].includes(value.status)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.jobId ?? '')
      || !/^[a-f0-9]{64}$/.test(value.jobDigest ?? '') || !count(value.revision)
      || !exactKeys(value.progress, PROGRESS_KEYS)
      || !count(value.progress.completedSteps) || !count(value.progress.totalSteps)
      || value.progress.totalSteps !== 3 || value.progress.completedSteps > 3
      || !count(value.progress.plannedDecisionMoments)
      || !count(value.progress.grossPlannedRecipeVariantSlots)
      || value.progress.attemptedSimulations !== 0
      || value.progress.completedSimulations !== 0
      || value.progress.validSimulationOutcomes !== 0
      || typeof value.progress.cancelled !== 'boolean'
      || !Number.isSafeInteger(value.progress.updatedTs) || value.progress.updatedTs < 0
      || !(value.progress.note === null || (typeof value.progress.note === 'string' && value.progress.note.length <= 500))
      || value.detailedStudyReturned !== false
      || value.detailedStudyPersistedByReceiptStore !== false
      || !exactKeys(value.durability, ['scope', 'republishSafe', 'externalArchive'])
      || value.durability.scope !== 'LOCAL_FILESYSTEM_ONLY'
      || value.durability.republishSafe !== false || value.durability.externalArchive !== 'UNKNOWN'
      || value.authority !== 'NONE' || value.purpose !== 'RESEARCH_ONLY'
      || !exactKeys(value.inputAccounting, ['physicalBytes', 'decodedStringBytesUpperBound', 'boundedPartialCaptureOnly'])
      || !count(value.inputAccounting.physicalBytes) || value.inputAccounting.physicalBytes < 4
      || !count(value.inputAccounting.decodedStringBytesUpperBound) || value.inputAccounting.decodedStringBytesUpperBound < 4
      || value.inputAccounting.boundedPartialCaptureOnly !== true
      || !exactKeys(value.resourceBoundary, ['v8OldSpaceLimitMb', 'wholeProcessRssHardCap', 'inputPreflightBeforeJsonParse'])
      || !Number.isSafeInteger(value.resourceBoundary.v8OldSpaceLimitMb)
      || value.resourceBoundary.v8OldSpaceLimitMb < 128
      || value.resourceBoundary.v8OldSpaceLimitMb > DAILY_STUDY_PROCESS_HARD_LIMITS.maxOldSpaceMb
      || value.resourceBoundary.wholeProcessRssHardCap !== false
      || value.resourceBoundary.inputPreflightBeforeJsonParse !== true
      || !exactKeys(value.environment, ['inheritedKeys', 'fixedAllowlistOnly', 'nodeOptionsPresent', 'nodePathPresent', 'testOfflineGuardActive', 'unapprovedNodeOptionsPresent', 'providerLikeKeyCount'])
      || !Array.isArray(value.environment.inheritedKeys) || value.environment.inheritedKeys.length > 32
      || value.environment.inheritedKeys.some((key) => typeof key !== 'string' || key.length > 80)
      || value.environment.fixedAllowlistOnly !== true
      || typeof value.environment.nodeOptionsPresent !== 'boolean'
      || typeof value.environment.testOfflineGuardActive !== 'boolean'
      || value.environment.unapprovedNodeOptionsPresent !== false
      || (value.environment.nodeOptionsPresent !== value.environment.testOfflineGuardActive)
      || value.environment.nodePathPresent !== false
      || value.environment.providerLikeKeyCount !== 0
      || !exactKeys(value.claims, ['fullDayCatalogContinuityVerified', 'fullDayStudyComplete', 'simulationsAttempted', 'simulationsCompleted', 'validSimulationOutcomes', 'learningAdopted', 'tradingAuthority'])
      || value.claims.fullDayCatalogContinuityVerified !== false
      || value.claims.fullDayStudyComplete !== false
      || value.claims.simulationsAttempted !== 0 || value.claims.simulationsCompleted !== 0
      || value.claims.validSimulationOutcomes !== 0 || value.claims.learningAdopted !== false
      || value.claims.tradingAuthority !== false) return false;
  if (value.status === 'CANCELLED') {
    if (value.result !== null || value.progress.cancelled !== true || value.progress.phase !== 'CANCELLED') return false;
  } else {
    if (!exactKeys(value.result, RESULT_KEYS) || value.progress.phase !== 'FINALIZED'
        || value.progress.cancelled !== false || value.result.jobId !== value.jobId
        || value.result.jobDigest !== value.jobDigest
        || value.result.resultVersion !== 'daily-study-result-receipt-1'
        || value.result.studyVersion !== 'daily-move-study-1'
        || !/^[a-f0-9]{64}$/.test(value.result.resultDigest ?? '')
        || !/^[a-f0-9]{64}$/.test(value.result.manifestDigest ?? '')
        || !/^[a-f0-9]{64}$/.test(value.result.studyDigest ?? '')
        || value.result.resultId !== `dailyresult-${value.result.resultDigest.slice(0, 32)}`
        || value.result.manifestId !== `dmstudy-${value.result.manifestDigest.slice(0, 24)}`
        || !count(value.result.studyBytes) || value.result.studyBytes > 32 * 1024 * 1024
        || !count(value.result.caseCount) || value.result.caseCount > 5_000
        || value.result.plannedDecisionMoments !== value.progress.plannedDecisionMoments
        || value.result.grossPlannedRecipeVariantSlots !== value.progress.grossPlannedRecipeVariantSlots
        || value.result.attemptedSimulations !== 0 || value.result.completedSimulations !== 0
        || value.result.validSimulationOutcomes !== 0 || value.result.fullDetailCasesClaimed !== 0
        || value.result.resultMode !== 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY'
        || value.result.externalArchive !== 'UNKNOWN'
        || value.result.authority !== 'NONE' || value.result.purpose !== 'RESEARCH_ONLY') return false;
  }
  return true;
}

export function isDailyStudyProcessResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, [...SUMMARY_KEYS, 'cancelRequested'])
      || value.cancelRequested !== false) return false;
  const { cancelRequested: _cancelRequested, ...summary } = value;
  return isDailyStudyProcessSummary(summary);
}

export function createDailyStudyProcessHost({
  inputRoot = process.cwd(), outputRoot = process.cwd(),
  maxConcurrency, maxQueue, maxCaptureFileBytes, maxDeclarationFileBytes,
  maxTotalInputFileBytes, maxDecodedWorkingBytes, maxSummaryBytes,
  maxOldSpaceMb, maxQueueWaitMs, maxRunMs, killGraceMs, canStart = null,
} = {}) {
  if (!(canStart === null || typeof canStart === 'function')) fail('PROCESS_LIMIT_INVALID', 'canStart must be a function or null');
  const roots = Object.freeze({
    input: canonicalRoot(inputRoot, 'inputRoot'), output: canonicalRoot(outputRoot, 'outputRoot'),
  });
  const limits = Object.freeze({
    maxConcurrency: boundedInteger(maxConcurrency, DAILY_STUDY_PROCESS_DEFAULTS.maxConcurrency, DAILY_STUDY_PROCESS_HARD_LIMITS.maxConcurrency, 'maxConcurrency'),
    maxQueue: boundedInteger(maxQueue, DAILY_STUDY_PROCESS_DEFAULTS.maxQueue, DAILY_STUDY_PROCESS_HARD_LIMITS.maxQueue, 'maxQueue'),
    maxCaptureFileBytes: boundedInteger(maxCaptureFileBytes, DAILY_STUDY_PROCESS_DEFAULTS.maxCaptureFileBytes, DAILY_STUDY_PROCESS_HARD_LIMITS.maxCaptureFileBytes, 'maxCaptureFileBytes'),
    maxDeclarationFileBytes: boundedInteger(maxDeclarationFileBytes, DAILY_STUDY_PROCESS_DEFAULTS.maxDeclarationFileBytes, DAILY_STUDY_PROCESS_HARD_LIMITS.maxDeclarationFileBytes, 'maxDeclarationFileBytes'),
    maxTotalInputFileBytes: boundedInteger(maxTotalInputFileBytes, DAILY_STUDY_PROCESS_DEFAULTS.maxTotalInputFileBytes, DAILY_STUDY_PROCESS_HARD_LIMITS.maxTotalInputFileBytes, 'maxTotalInputFileBytes'),
    maxDecodedWorkingBytes: boundedInteger(maxDecodedWorkingBytes, DAILY_STUDY_PROCESS_DEFAULTS.maxDecodedWorkingBytes, DAILY_STUDY_PROCESS_HARD_LIMITS.maxDecodedWorkingBytes, 'maxDecodedWorkingBytes'),
    maxSummaryBytes: boundedInteger(maxSummaryBytes, DAILY_STUDY_PROCESS_DEFAULTS.maxSummaryBytes, DAILY_STUDY_PROCESS_HARD_LIMITS.maxSummaryBytes, 'maxSummaryBytes', 1024),
    maxOldSpaceMb: boundedInteger(maxOldSpaceMb, DAILY_STUDY_PROCESS_DEFAULTS.maxOldSpaceMb, DAILY_STUDY_PROCESS_HARD_LIMITS.maxOldSpaceMb, 'maxOldSpaceMb', 128),
    maxQueueWaitMs: boundedInteger(maxQueueWaitMs, DAILY_STUDY_PROCESS_DEFAULTS.maxQueueWaitMs, DAILY_STUDY_PROCESS_HARD_LIMITS.maxQueueWaitMs, 'maxQueueWaitMs', 10),
    maxRunMs: boundedInteger(maxRunMs, DAILY_STUDY_PROCESS_DEFAULTS.maxRunMs, DAILY_STUDY_PROCESS_HARD_LIMITS.maxRunMs, 'maxRunMs', 10),
    killGraceMs: boundedInteger(killGraceMs, DAILY_STUDY_PROCESS_DEFAULTS.killGraceMs, DAILY_STUDY_PROCESS_HARD_LIMITS.maxKillGraceMs, 'killGraceMs', 10),
  });
  if (limits.maxCaptureFileBytes > limits.maxTotalInputFileBytes
      || limits.maxDeclarationFileBytes > limits.maxTotalInputFileBytes) {
    fail('PROCESS_LIMIT_INVALID', 'individual input limits cannot exceed the whole-job input limit');
  }

  const queued = [];
  const jobs = new Map();
  const reservedOutputs = new Map();
  let activeCount = 0; let peakActive = 0; let closing = false; let closed = false;
  let paused = false; let pauseReason = null; let closePromise = null; let closeResolve = null;
  let admissionBlocked = false; let admissionBlockReason = null;

  const releaseReservation = (job) => { reservedOutputs.delete(job.jobToken); };
  const maybeClose = () => {
    if (closing && activeCount === 0 && queued.length === 0 && closeResolve) {
      closed = true; const resolve = closeResolve; closeResolve = null; resolve();
    }
  };

  const finalizeJob = (job, error, value) => {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.queueTimer); clearTimeout(job.runTimer);
    clearTimeout(job.termTimer); clearTimeout(job.killTimer); clearTimeout(job.terminalExitTimer);
    jobs.delete(job.jobToken); releaseReservation(job);
    if (error) job.reject(error); else job.resolve(value);
  };

  const interrupt = (job, kind, detail) => {
    if (job.settled || job.stopKind || job.terminalReceived) return false;
    job.stopKind = kind; job.stopDetail = bounded(detail);
    if (job.state === 'QUEUED') {
      const index = queued.indexOf(job); if (index >= 0) queued.splice(index, 1);
      finalizeJob(job, new DailyStudyProcessError(kind === 'TIMEOUT' ? 'QUEUE_TIMEOUT' : 'JOB_CANCELLED', job.stopDetail));
      maybeClose(); return true;
    }
    if (!job.child) return true;
    try {
      if (job.child.connected) job.child.send({ type: 'CANCEL', reason: job.stopDetail });
    } catch { /* termination below remains authoritative */ }
    job.termTimer = setTimeout(() => {
      if (job.exited) return;
      job.forced = true;
      try { job.child.kill('SIGTERM'); } catch {}
      job.killTimer = setTimeout(() => {
        if (job.exited) return;
        try { job.child.kill('SIGKILL'); } catch {}
      }, limits.killGraceMs);
    }, limits.killGraceMs);
    return true;
  };

  const start = (job) => {
    clearTimeout(job.queueTimer); job.state = 'RUNNING';
    activeCount += 1; peakActive = Math.max(peakActive, activeCount);
    let response = null; let protocolFailure = null;
    const stderr = []; let stderrBytes = 0;
    let child;
    try {
      child = fork(CHILD_FILE, [], {
        cwd: PROJECT_ROOT, env: safeChildEnvironment(),
        execArgv: [`--max-old-space-size=${limits.maxOldSpaceMb}`],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', windowsHide: true,
      });
    } catch (error) {
      activeCount -= 1;
      finalizeJob(job, new DailyStudyProcessError('CHILD_SPAWN_FAILED', error.message));
      queueMicrotask(() => { pump(); maybeClose(); });
      return;
    }
    job.child = child;
    const captureDiagnostic = (chunk) => {
      if (stderrBytes >= 16 * 1024) return;
      const text = String(chunk); const remaining = (16 * 1024) - stderrBytes;
      const kept = text.slice(0, remaining); stderr.push(kept); stderrBytes += Buffer.byteLength(kept, 'utf8');
    };
    child.stdout?.on('data', captureDiagnostic); child.stderr?.on('data', captureDiagnostic);
    child.on('message', (message) => {
      if (response !== null || protocolFailure !== null) {
        protocolFailure = new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', 'child sent more than one terminal response');
        return;
      }
      try {
        if (byteLength(message) > limits.maxSummaryBytes) throw new DailyStudyProcessError('SUMMARY_BYTE_LIMIT', 'child response exceeded the configured IPC cap');
        if (message?.protocolVersion !== DAILY_STUDY_PROCESS_PROTOCOL_VERSION
            || message?.jobToken !== job.jobToken || typeof message?.ok !== 'boolean'
            || (message.ok === true ? !exactKeys(message, RESPONSE_KEYS) : !exactKeys(message, ERROR_RESPONSE_KEYS))) {
          throw new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', 'child response envelope malformed');
        }
        if (message.ok === true && !isDailyStudyProcessSummary(message.summary)) {
          throw new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', 'child success summary violates the exact zero-authority schema');
        }
        if (message.ok === true && message.summary.resourceBoundary.v8OldSpaceLimitMb !== limits.maxOldSpaceMb) {
          throw new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', 'child resource boundary differs from the launched heap limit');
        }
        if (message.ok === true && (message.summary.resourceBoundary.v8OldSpaceLimitMb !== limits.maxOldSpaceMb
            || message.summary.inputAccounting.physicalBytes !== job.capture.bytes + job.declaration.bytes
            || message.summary.inputAccounting.physicalBytes > limits.maxTotalInputFileBytes
            || message.summary.inputAccounting.decodedStringBytesUpperBound > limits.maxDecodedWorkingBytes)) {
          throw new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', 'child resource/input accounting differs from the admitted job');
        }
        if (message.ok === false && (!exactKeys(message.error, CHILD_ERROR_KEYS)
            || !/^[A-Z0-9_]{2,80}$/.test(message.error.code ?? '')
            || typeof message.error.detail !== 'string' || message.error.detail.length > 500
            || typeof message.error.phase !== 'string' || message.error.phase.length > 80
            || typeof message.error.operatorAction !== 'string' || message.error.operatorAction.length > 300)) {
          throw new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', 'child error envelope malformed');
        }
        response = message;
        job.terminalReceived = true; job.terminalReceivedAt = Date.now();
        clearTimeout(job.runTimer);
        if (job.stopKind === null) {
          job.terminalExitTimer = setTimeout(() => {
            if (job.exited) return;
            job.forced = true; job.stopKind = 'TERMINAL_EXIT_TIMEOUT';
            job.stopDetail = 'child reported a terminal result but did not physically exit';
            try { child.kill('SIGTERM'); } catch {}
            job.killTimer = setTimeout(() => {
              if (!job.exited) { try { child.kill('SIGKILL'); } catch {} }
            }, limits.killGraceMs);
          }, limits.killGraceMs);
        }
      } catch (error) { protocolFailure = error; }
    });
    child.on('error', (error) => {
      protocolFailure ??= new DailyStudyProcessError('CHILD_SPAWN_FAILED', bounded(error.message));
    });
    child.on('spawn', () => {
      const request = {
        type: 'RUN', protocolVersion: DAILY_STUDY_PROCESS_PROTOCOL_VERSION,
        jobToken: job.jobToken, captureFile: job.capture.path,
        captureIdentity: job.capture.identity,
        declarationFile: job.declaration.path,
        declarationIdentity: job.declaration.identity, outputDir: job.outputDir,
        limits: {
          maxCaptureFileBytes: limits.maxCaptureFileBytes,
          maxDeclarationFileBytes: limits.maxDeclarationFileBytes,
          maxTotalInputFileBytes: limits.maxTotalInputFileBytes,
          maxDecodedWorkingBytes: limits.maxDecodedWorkingBytes,
          maxSummaryBytes: limits.maxSummaryBytes,
          maxOldSpaceMb: limits.maxOldSpaceMb,
        },
      };
      try { child.send(request); }
      catch (error) { protocolFailure = new DailyStudyProcessError('CHILD_PROTOCOL_INVALID', bounded(error.message)); }
    });
    child.on('exit', (code, signal) => {
      job.exited = true; clearTimeout(job.termTimer); clearTimeout(job.killTimer);
      activeCount -= 1;
      let error = protocolFailure; let value = null;
      if (!error && job.forced) {
        error = new DailyStudyProcessError('INTERRUPTED_UNKNOWN', 'child was forcibly terminated; durable job state and writer.lock require operator inspection before retry', {
          interruption: job.stopKind ?? 'UNKNOWN', exitCode: code, signal,
          outputDir: job.outputDir, operatorLockRecoveryRequired: true,
        });
      } else if (!error && response === null) {
        error = new DailyStudyProcessError('CHILD_EXITED_WITHOUT_RESULT', `child exited ${code ?? 'null'}/${signal ?? 'none'} without a bounded result`, {
          outputDir: job.outputDir, operatorLockInspectionRequired: true,
          stderr: bounded(stderr.join(''), 500),
        });
      } else if (!error && response.ok !== true) {
        if (job.stopKind === 'TIMEOUT') {
          error = new DailyStudyProcessError('RUN_TIMEOUT', job.stopDetail, {
            childCode: bounded(response?.error?.code ?? 'UNKNOWN', 80), outputDir: job.outputDir,
          });
        } else if (job.stopKind === 'CANCEL') {
          error = new DailyStudyProcessError('JOB_CANCELLED', job.stopDetail, {
            childCode: bounded(response?.error?.code ?? 'UNKNOWN', 80), outputDir: job.outputDir,
          });
        } else error = childError(response);
      } else if (!error && code !== 0) {
        error = new DailyStudyProcessError('CHILD_EXIT_NONZERO', `child reported success but exited ${code}/${signal ?? 'none'}`);
      } else if (!error && job.stopKind !== null) {
        if (response.summary?.status === 'CANCELLED') {
          error = new DailyStudyProcessError(job.stopKind === 'TIMEOUT' ? 'RUN_TIMEOUT' : 'JOB_CANCELLED', job.stopDetail, {
            outputDir: job.outputDir, durablyCancelled: true,
          });
        } else {
          error = new DailyStudyProcessError('INTERRUPTED_UNKNOWN', 'a terminal result arrived after cancellation/timeout was accepted; inspect the durable store before retry', {
            outputDir: job.outputDir, operatorLockInspectionRequired: true,
          });
        }
      } else if (!error) {
        value = Object.freeze({ ...response.summary, cancelRequested: false });
      }
      finalizeJob(job, error, value);
      pump(); maybeClose();
    });
    job.runTimer = setTimeout(() => interrupt(job, 'TIMEOUT', `daily study exceeded ${job.timeoutMs} ms`), job.timeoutMs);
  };

  function pump() {
    if (paused && !closing) return;
    while (activeCount < limits.maxConcurrency && queued.length > 0) {
      if (canStart !== null && !closing) {
        let decision;
        try {
          decision = canStart({
            status: status(),
            queuedJob: Object.freeze({ jobToken: queued[0].jobToken, queuedAt: queued[0].queuedAt }),
          });
        } catch (error) {
          admissionBlocked = true; admissionBlockReason = `canStart threw: ${bounded(error.message)}`; return;
        }
        const allowed = decision === true || (decision?.allowed === true);
        if (!allowed) {
          admissionBlocked = true;
          admissionBlockReason = bounded(decision?.reason ?? 'external canStart gate refused admission');
          return;
        }
      }
      admissionBlocked = false; admissionBlockReason = null;
      start(queued.shift());
    }
    maybeClose();
  }

  const submit = (spec = {}) => {
    if (closing || closed) fail('HOST_CLOSED', 'daily-study process host is closing');
    if (!exactKeys(spec, SPEC_KEYS) && !exactKeys(spec, SPEC_KEYS.slice(0, 3))) {
      fail('JOB_SPEC_INVALID', 'job spec accepts only captureFile, declarationFile, outputDir, and optional timeoutMs');
    }
    if (queued.length >= limits.maxQueue) fail('QUEUE_FULL', `waiting queue reached ${limits.maxQueue}`);
    const capture = checkedInputFile(spec.captureFile, roots.input, limits.maxCaptureFileBytes, 'captureFile');
    const declaration = checkedInputFile(spec.declarationFile, roots.input, limits.maxDeclarationFileBytes, 'declarationFile');
    if (capture.bytes + declaration.bytes > limits.maxTotalInputFileBytes) {
      fail('INPUT_BYTE_LIMIT', 'capture and declaration exceed the whole-job byte cap');
    }
    const outputDir = checkedOutputDir(spec.outputDir, roots.output);
    for (const reserved of reservedOutputs.values()) {
      if (pathsOverlap(reserved, outputDir)) fail('OUTPUT_DIR_BUSY', 'outputDir overlaps a queued or active store owner');
    }
    const timeoutMs = boundedInteger(spec.timeoutMs, limits.maxRunMs, limits.maxRunMs, 'timeoutMs', 10);
    const jobToken = `dailyproc-${randomBytes(12).toString('hex')}`;
    let resolve; let reject;
    const result = new Promise((res, rej) => { resolve = res; reject = rej; });
    // Rejections belong to the ticket consumer, but cancellation can happen in
    // the same tick before that consumer installs handlers.
    result.catch(() => {});
    const job = {
      jobToken, capture, declaration, outputDir, timeoutMs, resolve, reject,
      result, state: 'QUEUED', child: null, settled: false, exited: false,
      queuedAt: Date.now(), terminalReceived: false, terminalReceivedAt: null,
      stopKind: null, stopDetail: null, forced: false,
      queueTimer: null, runTimer: null, termTimer: null, killTimer: null,
      terminalExitTimer: null,
    };
    jobs.set(jobToken, job); reservedOutputs.set(jobToken, outputDir); queued.push(job);
    job.queueTimer = setTimeout(() => interrupt(job, 'TIMEOUT', `daily study waited more than ${limits.maxQueueWaitMs} ms`), limits.maxQueueWaitMs);
    const cancel = (reason = 'operator cancellation requested') => interrupt(job, 'CANCEL', reason);
    const ticket = Object.freeze({ jobToken, result, cancel });
    pump(); return ticket;
  };

  const cancel = (jobToken, reason) => {
    const job = jobs.get(jobToken); if (!job) return false;
    return interrupt(job, 'CANCEL', reason ?? 'operator cancellation requested');
  };
  const pauseAdmissions = (reason = 'external pressure gate paused admissions') => {
    if (closing || closed) return false;
    paused = true; pauseReason = bounded(reason); return true;
  };
  const resumeAdmissions = () => {
    if (closing || closed) return false;
    paused = false; pauseReason = null; admissionBlocked = false; admissionBlockReason = null; pump(); return true;
  };
  const status = () => Object.freeze({
    processVersion: DAILY_STUDY_PROCESS_VERSION,
    model: 'ONE_CHILD_PROCESS_PER_JOB', spawnOverheadPerJob: true,
    maxConcurrency: limits.maxConcurrency, active: activeCount, peakActive,
    queued: queued.length, maxQueue: limits.maxQueue,
    paused, pauseReason, admissionBlocked, admissionBlockReason, closing, closed,
    authority: 'NONE', tradingAuthority: false, providerStartup: false,
    fullDayStudyClaimed: false, simulationsExecuted: 0, learningAdopted: false,
  });
  const close = ({ cancelQueued = true, cancelRunning = true } = {}) => {
    if (closePromise) return closePromise;
    closing = true; paused = false;
    closePromise = new Promise((resolve) => { closeResolve = resolve; });
    if (cancelQueued) for (const job of [...queued]) interrupt(job, 'CANCEL', 'host closing before job start');
    if (cancelRunning) for (const job of jobs.values()) if (job.state === 'RUNNING') interrupt(job, 'CANCEL', 'host closing during job');
    pump(); maybeClose(); return closePromise;
  };

  return Object.freeze({ submit, cancel, pauseAdmissions, resumeAdmissions, status, close });
}
