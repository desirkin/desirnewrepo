// Fixed child entry point for daily-study-process.js. This module imports only
// the bounded offline runner/store graph. It has no provider, application,
// database, model, Judge, promotion, order, or trading startup authority.
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  createDailyStudyRunner, dailyStudyRunnerJobError,
} from '../learning/daily-study-runner.js';
import { openDailyStudyStore } from '../learning/daily-study-store.js';
import {
  DAILY_STUDY_PROCESS_HARD_LIMITS, DAILY_STUDY_PROCESS_PROTOCOL_VERSION,
} from './daily-study-process.js';

const REQUEST_KEYS = Object.freeze([
  'type', 'protocolVersion', 'jobToken', 'captureFile', 'declarationFile',
  'captureIdentity', 'declarationIdentity', 'outputDir', 'limits',
]);
const LIMIT_KEYS = Object.freeze([
  'maxCaptureFileBytes', 'maxDeclarationFileBytes', 'maxTotalInputFileBytes',
  'maxDecodedWorkingBytes', 'maxSummaryBytes', 'maxOldSpaceMb',
]);
const SAFE_CHILD_ENV_KEYS = new Set([
  'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
  'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'DAILY_STUDY_PROCESS_CHILD',
  // Windows injects these exact process-account/OS keys even when CreateProcess
  // receives a narrower environment block. They carry no provider credentials.
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN',
  'USERNAME', 'USERPROFILE',
]);
const OFFLINE_GUARD_ENV_KEYS = new Set([
  'NODE_OPTIONS', 'COBRA_OFFLINE_GUARD_LOG', 'COBRA_OFFLINE_GUARD_RUN',
]);
const TOKEN_RE = /^dailyproc-[a-f0-9]{24}$/;
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']);
const decoder = new TextDecoder('utf-8', { fatal: true });

const bounded = (value, max = 500) => String(value ?? '').slice(0, max);
const exact = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const samePath = (a, b) => {
  const left = path.normalize(a); const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const boundedInteger = (value, maximum) => Number.isSafeInteger(value) && value >= 1 && value <= maximum;

class ChildRequestError extends Error {
  constructor(code, detail) { super(bounded(detail)); this.name = 'ChildRequestError'; this.code = code; }
}
function fail(code, detail) { throw new ChildRequestError(code, detail); }

function validateLimits(value) {
  if (!exact(value, LIMIT_KEYS)) fail('CHILD_REQUEST_INVALID', 'limits shape malformed');
  for (const key of LIMIT_KEYS) {
    if (!boundedInteger(value[key], DAILY_STUDY_PROCESS_HARD_LIMITS[key])) {
      fail('CHILD_REQUEST_INVALID', `${key} outside process hard limit`);
    }
  }
  if (value.maxCaptureFileBytes > value.maxTotalInputFileBytes
      || value.maxDeclarationFileBytes > value.maxTotalInputFileBytes) {
    fail('CHILD_REQUEST_INVALID', 'individual input cap exceeds total input cap');
  }
  return Object.freeze({ ...value });
}

function validateRequest(value) {
  if (!exact(value, REQUEST_KEYS) || value.type !== 'RUN'
      || value.protocolVersion !== DAILY_STUDY_PROCESS_PROTOCOL_VERSION
      || !TOKEN_RE.test(value.jobToken ?? '')) fail('CHILD_REQUEST_INVALID', 'request envelope malformed');
  const limits = validateLimits(value.limits);
  for (const [key, maximum] of [
    ['captureFile', limits.maxCaptureFileBytes],
    ['declarationFile', limits.maxDeclarationFileBytes],
  ]) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) fail('PATH_INVALID', `${key} must be absolute`);
    const resolved = path.resolve(value[key]);
    let stat;
    try { stat = lstatSync(resolved); } catch { fail('PATH_INVALID', `${key} does not exist`); }
    if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync(resolved), resolved)) {
      fail('PATH_ESCAPE', `${key} must remain one regular non-symlink file`);
    }
    if (stat.size < 2 || stat.size > maximum) fail('INPUT_BYTE_LIMIT', `${key} outside byte limit`);
  }
  for (const key of ['captureIdentity', 'declarationIdentity']) {
    if (!exact(value[key], IDENTITY_KEYS)
        || Object.values(value[key]).some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      fail('CHILD_REQUEST_INVALID', `${key} malformed`);
    }
  }
  if (typeof value.outputDir !== 'string' || !path.isAbsolute(value.outputDir)) fail('PATH_INVALID', 'outputDir must be absolute');
  return { ...value, limits };
}

function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readStableFile(file, maximum, expectedIdentity) {
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | noFollow); }
  catch (error) { fail(error?.code === 'ELOOP' ? 'PATH_ESCAPE' : 'INPUT_READ_FAILED', error.message); }
  try {
    const before = fstatSync(fd);
    if (!sameFileStat(before, expectedIdentity)) fail('INPUT_CUSTODY_CHANGED', `${path.basename(file)} changed after parent admission`);
    if (!before.isFile() || before.size < 2 || before.size > maximum) {
      fail('INPUT_BYTE_LIMIT', `${path.basename(file)} outside byte limit at descriptor read`);
    }
    const raw = Buffer.allocUnsafe(Math.min(maximum + 1, before.size + 1));
    let offset = 0;
    while (offset < raw.length) {
      const amount = readSync(fd, raw, offset, raw.length - offset, null);
      if (amount === 0) break;
      offset += amount;
    }
    const after = fstatSync(fd);
    const pathStat = lstatSync(file);
    if (offset > maximum) fail('INPUT_BYTE_LIMIT', `${path.basename(file)} grew beyond its byte limit`);
    if (offset !== before.size || !sameFileStat(before, after)
        || pathStat.isSymbolicLink() || pathStat.dev !== after.dev || pathStat.ino !== after.ino
        || !samePath(realpathSync(file), path.resolve(file))) {
      fail('INPUT_CUSTODY_CHANGED', `${path.basename(file)} changed during bounded read`);
    }
    return raw.subarray(0, offset);
  } finally { try { closeSync(fd); } catch {} }
}

function decodeJson(raw, file) {
  let text;
  try { text = decoder.decode(raw); } catch { fail('INPUT_ENCODING_INVALID', `${path.basename(file)} is not strict UTF-8`); }
  let value;
  try { value = JSON.parse(text); } catch { fail('INPUT_JSON_INVALID', `${path.basename(file)} is not valid JSON`); }
  return { value, decodedStringBytesUpperBound: text.length * 2 };
}

function prepareOutputDir(value) {
  const resolved = path.resolve(value);
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(resolved), resolved)) {
      fail('PATH_ESCAPE', 'outputDir custody changed before child store open');
    }
  } else {
    const parent = path.dirname(resolved);
    if (!existsSync(parent)) fail('PATH_INVALID', 'outputDir parent no longer exists');
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(parent), parent)) {
      fail('PATH_ESCAPE', 'outputDir parent custody changed before creation');
    }
    try { mkdirSync(resolved, { mode: 0o700 }); }
    catch (error) { fail('OUTPUT_CREATE_FAILED', error.message); }
    if (lstatSync(resolved).isSymbolicLink() || !samePath(realpathSync(resolved), resolved)) {
      fail('PATH_ESCAPE', 'created outputDir custody mismatch');
    }
  }
  return resolved;
}

function safeProgress(progress) {
  if (progress === null || typeof progress !== 'object') return null;
  return {
    phase: progress.phase, completedSteps: progress.completedSteps,
    totalSteps: progress.totalSteps,
    plannedDecisionMoments: progress.plannedDecisionMoments,
    grossPlannedRecipeVariantSlots: progress.grossPlannedRecipeVariantSlots,
    attemptedSimulations: progress.attemptedSimulations,
    completedSimulations: progress.completedSimulations,
    validSimulationOutcomes: progress.validSimulationOutcomes,
    cancelled: progress.cancelled, note: progress.note, updatedTs: progress.updatedTs,
  };
}

function safeResult(result) {
  if (result === null || typeof result !== 'object') return null;
  return {
    resultVersion: result.resultVersion, resultId: result.resultId,
    resultDigest: result.resultDigest, jobId: result.jobId,
    jobDigest: result.jobDigest, manifestId: result.manifestId,
    manifestDigest: result.manifestDigest, studyVersion: result.studyVersion,
    studyDigest: result.studyDigest, studyBytes: result.studyBytes,
    caseCount: result.caseCount,
    plannedDecisionMoments: result.plannedDecisionMoments,
    grossPlannedRecipeVariantSlots: result.grossPlannedRecipeVariantSlots,
    attemptedSimulations: result.attemptedSimulations,
    completedSimulations: result.completedSimulations,
    validSimulationOutcomes: result.validSimulationOutcomes,
    fullDetailCasesClaimed: result.fullDetailCasesClaimed,
    resultMode: result.resultMode, externalArchive: result.externalArchive,
    authority: result.authority, purpose: result.purpose,
  };
}

function environmentSummary() {
  const keys = Object.keys(process.env).sort();
  const nodeOptions = process.env.NODE_OPTIONS ?? '';
  const testOfflineGuardActive = /--import="?file:\/\/\/.+\/test\/helpers\/offline-guard\.mjs"?/i.test(nodeOptions)
    && /--title="?.+[\\/]test[\\/]helpers[\\/]offline-guard\.mjs"?/i.test(nodeOptions)
    && typeof process.env.COBRA_OFFLINE_GUARD_LOG === 'string'
    && typeof process.env.COBRA_OFFLINE_GUARD_RUN === 'string';
  const permitted = (key) => {
    if (SAFE_CHILD_ENV_KEYS.has(key) || (testOfflineGuardActive && OFFLINE_GUARD_ENV_KEYS.has(key))) return true;
    if (process.platform !== 'win32') return false;
    const upper = key.toUpperCase();
    return [...SAFE_CHILD_ENV_KEYS].some((candidate) => candidate.toUpperCase() === upper)
      || (testOfflineGuardActive && [...OFFLINE_GUARD_ENV_KEYS].some((candidate) => candidate.toUpperCase() === upper));
  };
  return {
    inheritedKeys: keys,
    fixedAllowlistOnly: keys.every(permitted),
    nodeOptionsPresent: Object.prototype.hasOwnProperty.call(process.env, 'NODE_OPTIONS'),
    nodePathPresent: Object.prototype.hasOwnProperty.call(process.env, 'NODE_PATH'),
    testOfflineGuardActive,
    unapprovedNodeOptionsPresent: nodeOptions.length > 0 && !testOfflineGuardActive,
    providerLikeKeyCount: keys.filter((key) => /(API|TOKEN|SECRET|PASSWORD|PRIVATE|KRAKEN|COINBASE|FRED|TWELVE)/i.test(key)).length,
  };
}

function responseBytes(response) { return Buffer.byteLength(JSON.stringify(response), 'utf8'); }

export async function runDailyStudyProcessChild(request, { signal = null } = {}) {
  const checked = validateRequest(request);
  const captureRaw = readStableFile(checked.captureFile, checked.limits.maxCaptureFileBytes, checked.captureIdentity);
  const declarationRaw = readStableFile(checked.declarationFile, checked.limits.maxDeclarationFileBytes, checked.declarationIdentity);
  const physicalBytes = captureRaw.length + declarationRaw.length;
  if (physicalBytes > checked.limits.maxTotalInputFileBytes) {
    fail('INPUT_BYTE_LIMIT', 'input files exceed whole-job physical byte limit');
  }
  // UTF-16 strings can occupy at most two bytes per input byte. Refuse the
  // worst-case encoded+decoded budget before decoding or JSON.parse allocates
  // an object graph. The fixed child V8 old-space ceiling is an additional
  // boundary; it is not a whole-process RSS hard cap.
  if (physicalBytes + (physicalBytes * 2) > checked.limits.maxDecodedWorkingBytes) {
    fail('INPUT_DECODE_BUDGET', 'worst-case encoded plus decoded input exceeds whole-job working byte budget');
  }
  const capture = decodeJson(captureRaw, checked.captureFile);
  const declaration = decodeJson(declarationRaw, checked.declarationFile);
  const decodedStringBytesUpperBound = capture.decodedStringBytesUpperBound + declaration.decodedStringBytesUpperBound;
  const declarationError = dailyStudyRunnerJobError(declaration.value);
  if (declarationError) fail('RUNNER_JOB_INVALID', declarationError);
  const outputDir = prepareOutputDir(checked.outputDir);
  let store = null; let runner = null; let outcome = null; let runError = null;
  try {
    store = await openDailyStudyStore({ rootDir: outputDir });
    runner = createDailyStudyRunner({
      declaredJob: declaration.value,
      inputLoader: async () => capture.value,
      outputStore: store,
      yieldControl: () => new Promise((resolve) => setImmediate(resolve)),
    });
    if (signal?.aborted) runner.cancel(signal.reason ?? 'child cancellation requested');
    outcome = await runner.run({ signal });
  } catch (error) { runError = error; }
  let closeError = null;
  if (store !== null) {
    try { await store.close(); } catch (error) { closeError = error; }
  }
  if (closeError !== null) {
    fail('STORE_CLOSE_FAILED', `store close failed after ${runError ? 'run failure' : 'run'}: ${closeError.message}`);
  }
  if (runError !== null) throw runError;

  const summary = {
    processVersion: 'daily-study-process-1',
    executionModel: 'ONE_CHILD_PROCESS_PER_JOB', spawnOverheadPerJob: true,
    status: outcome.status, jobId: outcome.jobId, jobDigest: outcome.jobDigest,
    revision: outcome.revision, progress: safeProgress(outcome.progress),
    result: safeResult(outcome.result), detailedStudyReturned: false,
    detailedStudyPersistedByReceiptStore: false,
    durability: outcome.durability, authority: outcome.authority,
    purpose: outcome.purpose,
    inputAccounting: {
      physicalBytes, decodedStringBytesUpperBound, boundedPartialCaptureOnly: true,
    },
    resourceBoundary: {
      v8OldSpaceLimitMb: checked.limits.maxOldSpaceMb,
      wholeProcessRssHardCap: false, inputPreflightBeforeJsonParse: true,
    },
    environment: environmentSummary(),
    claims: {
      fullDayCatalogContinuityVerified: false, fullDayStudyComplete: false,
      simulationsAttempted: 0, simulationsCompleted: 0,
      validSimulationOutcomes: 0, learningAdopted: false,
      tradingAuthority: false,
    },
  };
  const response = {
    protocolVersion: DAILY_STUDY_PROCESS_PROTOCOL_VERSION,
    jobToken: checked.jobToken, ok: true, summary,
  };
  if (responseBytes(response) > checked.limits.maxSummaryBytes) fail('SUMMARY_BYTE_LIMIT', 'truthful child summary exceeds IPC cap');
  return response;
}

function boundedError(error) {
  return {
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code) ? error.code : 'CHILD_JOB_FAILED',
    detail: bounded(error?.message ?? error), phase: 'OFFLINE_DAILY_STUDY_CHILD',
    operatorAction: /LOCK|STORE_CLOSE|INTERRUPT/.test(error?.code ?? '')
      ? 'inspect writer.lock and the dedicated output directory; never use timed lock takeover'
      : 'correct the bounded offline input or output custody before retry',
  };
}

if (typeof process.send === 'function') {
  let started = false; let controller = null; let pendingCancelReason = null;
  const sendAndExit = (response, exitCode) => {
    const maximum = response?.summary?.inputAccounting ? null : DAILY_STUDY_PROCESS_HARD_LIMITS.maxSummaryBytes;
    let safe = response;
    if ((maximum !== null && responseBytes(response) > maximum)) {
      safe = {
        protocolVersion: DAILY_STUDY_PROCESS_PROTOCOL_VERSION,
        jobToken: response?.jobToken ?? 'dailyproc-000000000000000000000000', ok: false,
        error: boundedError(new ChildRequestError('SUMMARY_BYTE_LIMIT', 'child error response exceeded IPC cap')),
      };
    }
    process.send(safe, () => {
      try { process.disconnect(); } catch {}
      process.exit(exitCode);
    });
  };
  process.on('message', async (message) => {
    if (message?.type === 'CANCEL') {
      pendingCancelReason = bounded(message.reason);
      if (controller !== null && !controller.signal.aborted) controller.abort(pendingCancelReason);
      return;
    }
    if (started) return;
    started = true; controller = new AbortController();
    if (pendingCancelReason !== null) controller.abort(pendingCancelReason);
    try {
      const response = await runDailyStudyProcessChild(message, { signal: controller.signal });
      sendAndExit(response, 0);
    } catch (error) {
      sendAndExit({
        protocolVersion: DAILY_STUDY_PROCESS_PROTOCOL_VERSION,
        jobToken: TOKEN_RE.test(message?.jobToken ?? '') ? message.jobToken : 'dailyproc-000000000000000000000000',
        ok: false, error: boundedError(error),
      }, 1);
    }
  });
  process.on('disconnect', () => {
    if (controller !== null && !controller.signal.aborted) controller.abort('parent IPC disconnected');
  });
}
