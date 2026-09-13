// Local, offline persistence for the bounded retrospective daily-study planner.
//
// This store persists only immutable job descriptors, monotonic planning
// progress, and deterministic result receipts. It does NOT archive raw market data,
// prove catalog-epoch continuity, run simulations, adopt learning, or grant any
// Judge/order authority. Its files are deliberately labelled local-only because a
// Replit publish can replace the deployment filesystem.
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  DAILY_BROAD_HARD_LIMITS, DAILY_BROAD_INPUT_VERSION, prepareDailyBroadInput,
} from './daily-broad-input.js';
import {
  DAILY_MOVE_STUDY_VERSION, buildDailyMoveStudy, dailyMoveStudyManifestError,
} from './daily-move-study.js';
import {
  AUTHORITY, PURPOSE, canonicalDigest, deepFreeze, exactKeys, isPlainObject,
  isTs, stableStringify,
} from './shadow-contracts.js';

export const DAILY_STUDY_STORE_VERSION = 'daily-study-store-1';
export const DAILY_STUDY_INPUT_DESCRIPTOR_VERSION = 'daily-study-input-descriptor-1';
export const DAILY_STUDY_CAPTURE_CONTENT_VERSION = 'daily-study-capture-content-1';
export const DAILY_STUDY_JOB_VERSION = 'daily-study-job-1';
export const DAILY_STUDY_PROGRESS_VERSION = 'daily-study-progress-1';
export const DAILY_STUDY_RESULT_VERSION = 'daily-study-result-receipt-1';
export const DAILY_STUDY_DURABILITY = Object.freeze({
  scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN',
});
export const DAILY_STUDY_STORE_LIMITS = Object.freeze({
  maxJobs: 64,
  maxDirectoryEntries: 256,
  maxStateBytes: 256 * 1024,
  maxDescriptorBytes: 64 * 1024,
  maxProgressBytes: 16 * 1024,
  maxResultBytes: 64 * 1024,
  maxTotalReadBytes: 16 * 1024 * 1024,
  maxStudyDigestBytes: 32 * 1024 * 1024,
  maxRevisionsPerJob: 10_000,
});

const HEX40_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const JOB_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,95})\.json$/;
const TEMP_FILE_RE = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,95})\.json\.[a-f0-9]{24}\.tmp$/;
const LOCK_REPLACEMENT_RE = /^\.writer-lock-replacement-[a-f0-9]{24}\.tmp$/;
const INPUT_KEYS = Object.freeze([
  'descriptorVersion', 'descriptorDigest', 'captureContentVersion', 'sourceId',
  'sourceDigest', 'preparedInputDigest', 'catalogContentId', 'catalogSnapshotDigest', 'recordCount',
  'inputBytes', 'dayStartTs', 'dayEndTs', 'finalizedTs', 'captureStartTs',
  'captureEndTs', 'truncated', 'mode', 'fullDayCatalogEpochUnionVerified',
  'persistedRecordContinuityVerified', 'authority',
]);
const JOB_MANIFEST_KEYS = Object.freeze([
  'manifestId', 'manifestDigest', 'createdTs', 'catalogSnapshotDigest', 'recipeDigests',
  'rulesDigest', 'timeZone', 'localDay', 'dayStartTs', 'dayEndTs',
]);
const JOB_KEYS = Object.freeze([
  'jobVersion', 'jobId', 'jobDigest', 'analysisBasis', 'declaredTs', 'manifest',
  'inputDescriptor', 'durability', 'authority', 'purpose',
]);
const PROGRESS_UPDATE_KEYS = Object.freeze([
  'phase', 'completedSteps', 'totalSteps', 'plannedDecisionMoments',
  'grossPlannedRecipeVariantSlots', 'attemptedSimulations',
  'completedSimulations', 'validSimulationOutcomes', 'cancelled', 'note',
]);
const PROGRESS_KEYS = Object.freeze([
  'progressVersion', ...PROGRESS_UPDATE_KEYS, 'updatedTs',
]);
const RESULT_KEYS = Object.freeze([
  'resultVersion', 'resultId', 'resultDigest', 'jobId', 'jobDigest',
  'manifestId', 'manifestDigest', 'studyVersion', 'studyDigest', 'studyBytes',
  'caseCount', 'plannedDecisionMoments', 'grossPlannedRecipeVariantSlots',
  'attemptedSimulations', 'completedSimulations', 'validSimulationOutcomes',
  'fullDetailCasesClaimed', 'resultMode', 'externalArchive', 'authority', 'purpose',
]);
const STATE_KEYS = Object.freeze([
  'storeVersion', 'revision', 'job', 'progress', 'result', 'durability', 'stateDigest',
]);
const DURABILITY_KEYS = Object.freeze(['scope', 'republishSafe', 'externalArchive']);
const PHASES = Object.freeze([
  'DECLARED', 'INPUT_VALIDATED', 'STUDY_BUILT', 'PLAN_COMPLETE', 'CANCELLED', 'FINALIZED',
]);
const PHASE_RANK = new Map(PHASES.map((phase, index) => [phase, index]));
const CATALOG_MARKET_KEYS = Object.freeze([
  'pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status',
]);
const STUDY_COUNTER_KEYS = Object.freeze([
  'acceptedMarketDays', 'exclusiveDispositionRows', 'dispositions',
  'surgeMarketDayEpisodes', 'marketDayDependenceGroupsWithObservedData',
  'statisticallyIndependentEvidenceGroups', 'plannedDecisionMoments',
  'grossPlannedRecipeVariantSlots', 'inputEligibleSimulationSlots',
  'horizonMaturedSimulationSlots', 'attemptedSimulations', 'completedSimulations',
  'validSimulationOutcomes', 'censoredOrAmbiguous', 'completeSupportMatrixCases',
  'fullDetailCasesClaimed', 'missingControlMatches', 'unacceptedInputCount',
]);

const clone = (value) => JSON.parse(stableStringify(value));
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const sameDurability = (value) => exact(value, DURABILITY_KEYS)
  && value.scope === DAILY_STUDY_DURABILITY.scope
  && value.republishSafe === false
  && value.externalArchive === 'UNKNOWN';

export class DailyStudyStoreError extends Error {
  constructor(code, detail = code) {
    super(`daily study store: ${code}: ${String(detail).slice(0, 500)}`);
    this.name = 'DailyStudyStoreError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new DailyStudyStoreError(code, detail); };

function digestWithout(value, omitted) {
  return canonicalDigest(Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key))));
}

// Same canonical token law as shadow-contracts.stableStringify, but streamed so
// the digest operation has a hard UTF-8 ceiling and never constructs one second
// giant serialization in memory.
function boundedCanonicalDigest(value, maxBytes) {
  const hash = createHash('sha256');
  let bytes = 0;
  const ancestors = new Set();
  const token = (part) => {
    const size = Buffer.byteLength(part, 'utf8');
    if (bytes + size > maxBytes) fail('DIGEST_BYTE_LIMIT', `canonical content exceeds ${maxBytes} bytes`);
    bytes += size; hash.update(part);
  };
  const visit = (node, depth) => {
    if (depth > 64) fail('DIGEST_SHAPE_INVALID', 'canonical content nesting exceeds 64');
    if (node === null || typeof node === 'number' || typeof node === 'boolean') {
      const encoded = JSON.stringify(node);
      if (encoded === undefined) fail('DIGEST_SHAPE_INVALID', 'unsupported scalar');
      token(encoded); return;
    }
    if (typeof node === 'string') { token(JSON.stringify(node)); return; }
    if (typeof node !== 'object') fail('DIGEST_SHAPE_INVALID', `unsupported ${typeof node}`);
    if (ancestors.has(node)) fail('DIGEST_SHAPE_INVALID', 'cyclic content');
    ancestors.add(node);
    if (Array.isArray(node)) {
      token('[');
      for (let i = 0; i < node.length; i += 1) { if (i) token(','); visit(node[i], depth + 1); }
      token(']');
    } else if (isPlainObject(node)) {
      token('{'); let first = true;
      for (const key of Object.keys(node).sort().filter((key) => node[key] !== undefined)) {
        if (!first) token(','); first = false;
        token(JSON.stringify(key)); token(':'); visit(node[key], depth + 1);
      }
      token('}');
    } else fail('DIGEST_SHAPE_INVALID', 'non-plain canonical content');
    ancestors.delete(node);
  };
  visit(value, 0);
  return { digest: hash.digest('hex'), bytes };
}

function captureProjection(capture) {
  const catalog = capture.catalog;
  return {
    inputVersion: DAILY_STUDY_CAPTURE_CONTENT_VERSION,
    catalog: {
      venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion,
      observedTs: catalog.observedTs, contentId: catalog.contentId,
      markets: catalog.markets.map((market) => Object.fromEntries(
        CATALOG_MARKET_KEYS.map((key) => [key, market[key]]),
      )),
    },
    records: capture.records,
    dayStartTs: capture.dayStartTs, dayEndTs: capture.dayEndTs,
    finalizedTs: capture.finalizedTs, captureStartTs: capture.captureStartTs,
    captureEndTs: capture.captureEndTs, truncated: capture.truncated ?? false,
  };
}

export function dailyStudyInputDescriptorError(value) {
  if (!exact(value, INPUT_KEYS)) return 'input descriptor shape malformed';
  if (value.descriptorVersion !== DAILY_STUDY_INPUT_DESCRIPTOR_VERSION
      || value.captureContentVersion !== DAILY_STUDY_CAPTURE_CONTENT_VERSION
      || !SAFE_ID_RE.test(value.sourceId ?? '') || !HEX64_RE.test(value.sourceDigest ?? '')
      || !HEX64_RE.test(value.preparedInputDigest ?? '')
      || !HEX40_RE.test(value.catalogContentId ?? '') || !HEX64_RE.test(value.catalogSnapshotDigest ?? '')
      || !count(value.recordCount, DAILY_BROAD_HARD_LIMITS.maxRecords)
      || !count(value.inputBytes, DAILY_BROAD_HARD_LIMITS.maxInputBytes)
      || !isTs(value.dayStartTs) || !isTs(value.dayEndTs) || value.dayEndTs <= value.dayStartTs
      || !isTs(value.finalizedTs) || value.finalizedTs < value.dayEndTs
      || !isTs(value.captureStartTs) || !isTs(value.captureEndTs) || value.captureEndTs < value.captureStartTs
      || value.captureEndTs > value.finalizedTs || value.truncated !== false
      || value.mode !== 'BOUNDED_PARTIAL_CAPTURE_ONLY'
      || value.fullDayCatalogEpochUnionVerified !== false
      || value.persistedRecordContinuityVerified !== false
      || value.authority !== AUTHORITY) return 'input descriptor fields violate bounded partial-capture law';
  if (value.descriptorDigest !== digestWithout(value, ['descriptorDigest'])) return 'input descriptor digest forged';
  return null;
}

export function sealDailyStudyInputDescriptor({ sourceId, capture, preparedInput } = {}) {
  if (!SAFE_ID_RE.test(sourceId ?? '') || !isPlainObject(capture)) fail('INPUT_DESCRIPTOR_INVALID', 'sourceId/capture malformed');
  const independentlyPrepared = prepareDailyBroadInput(capture);
  if (independentlyPrepared.ok !== true) fail('INPUT_DESCRIPTOR_INVALID', `${independentlyPrepared.reason}: ${independentlyPrepared.detail}`);
  if (!isPlainObject(preparedInput) || preparedInput.ok !== true
      || preparedInput.version !== independentlyPrepared.version
      || preparedInput.acceptedCatalogSnapshot?.contentDigest !== independentlyPrepared.acceptedCatalogSnapshot.contentDigest
      || canonicalDigest(preparedInput.diagnostics) !== canonicalDigest(independentlyPrepared.diagnostics)) {
    fail('INPUT_DESCRIPTOR_INVALID', 'supplied prepared input does not match independent bounded preparation');
  }
  const suppliedPreparedDigest = boundedCanonicalDigest(preparedInput, DAILY_BROAD_HARD_LIMITS.maxInputBytes);
  const independentPreparedDigest = boundedCanonicalDigest(independentlyPrepared, DAILY_BROAD_HARD_LIMITS.maxInputBytes);
  if (suppliedPreparedDigest.digest !== independentPreparedDigest.digest) {
    fail('INPUT_DESCRIPTOR_INVALID', 'supplied prepared market-day content differs from independent bounded preparation');
  }
  const source = boundedCanonicalDigest(captureProjection(capture), DAILY_BROAD_HARD_LIMITS.maxInputBytes);
  const value = {
    descriptorVersion: DAILY_STUDY_INPUT_DESCRIPTOR_VERSION, descriptorDigest: '',
    captureContentVersion: DAILY_STUDY_CAPTURE_CONTENT_VERSION, sourceId,
    sourceDigest: source.digest, preparedInputDigest: independentPreparedDigest.digest,
    catalogContentId: capture.catalog.contentId,
    catalogSnapshotDigest: independentlyPrepared.acceptedCatalogSnapshot.contentDigest,
    recordCount: capture.records.length, inputBytes: independentlyPrepared.diagnostics.inputBytes,
    dayStartTs: capture.dayStartTs, dayEndTs: capture.dayEndTs,
    finalizedTs: capture.finalizedTs, captureStartTs: capture.captureStartTs,
    captureEndTs: capture.captureEndTs, truncated: false,
    mode: independentlyPrepared.diagnostics.mode,
    fullDayCatalogEpochUnionVerified: independentlyPrepared.diagnostics.fullDayCatalogEpochUnionVerified,
    persistedRecordContinuityVerified: independentlyPrepared.diagnostics.persistedRecordContinuityVerified,
    authority: AUTHORITY,
  };
  value.descriptorDigest = digestWithout(value, ['descriptorDigest']);
  const error = dailyStudyInputDescriptorError(value); if (error) fail('INPUT_DESCRIPTOR_INVALID', error);
  return deepFreeze(value);
}

export function dailyStudyJobDescriptorError(value) {
  if (!exact(value, JOB_KEYS)) return 'job descriptor shape malformed';
  if (value.jobVersion !== DAILY_STUDY_JOB_VERSION || !JOB_ID_RE.test(value.jobId ?? '')
      || value.analysisBasis !== 'RETROSPECTIVE_COHORT_STUDY' || !isTs(value.declaredTs)
      || value.authority !== AUTHORITY || value.purpose !== PURPOSE || !sameDurability(value.durability)) return 'job descriptor fields malformed';
  const inputError = dailyStudyInputDescriptorError(value.inputDescriptor); if (inputError) return `job ${inputError}`;
  const manifest = value.manifest;
  if (!exact(manifest, JOB_MANIFEST_KEYS) || !boundedString(manifest.manifestId, 80)
      || !HEX64_RE.test(manifest.manifestDigest ?? '') || !HEX64_RE.test(manifest.catalogSnapshotDigest ?? '')
      || !isTs(manifest.createdTs) || value.declaredTs !== manifest.createdTs
      || !Array.isArray(manifest.recipeDigests) || manifest.recipeDigests.length > 64
      || manifest.recipeDigests.some((digest) => !HEX64_RE.test(digest))
      || new Set(manifest.recipeDigests).size !== manifest.recipeDigests.length
      || manifest.recipeDigests.join('\n') !== [...manifest.recipeDigests].sort().join('\n')
      || !HEX64_RE.test(manifest.rulesDigest ?? '') || !boundedString(manifest.timeZone, 80)
      || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.localDay ?? '')
      || !isTs(manifest.dayStartTs) || !isTs(manifest.dayEndTs) || manifest.dayEndTs <= manifest.dayStartTs) return 'job manifest binding malformed';
  if (manifest.catalogSnapshotDigest !== value.inputDescriptor.catalogSnapshotDigest
      || manifest.dayStartTs !== value.inputDescriptor.dayStartTs
      || manifest.dayEndTs !== value.inputDescriptor.dayEndTs) return 'job manifest/input binding disagrees';
  if (value.jobDigest !== digestWithout(value, ['jobDigest'])) return 'job descriptor digest forged';
  return null;
}

export function sealDailyStudyJobDescriptor({ jobId, manifest, inputDescriptor } = {}) {
  const manifestError = dailyMoveStudyManifestError(manifest);
  if (manifestError) fail('JOB_INVALID', manifestError);
  const inputError = dailyStudyInputDescriptorError(inputDescriptor);
  if (inputError) fail('JOB_INVALID', inputError);
  if (!JOB_ID_RE.test(jobId ?? '')) fail('JOB_INVALID', 'jobId must be one bounded path-free identifier');
  const value = {
    jobVersion: DAILY_STUDY_JOB_VERSION, jobId, jobDigest: '',
    analysisBasis: manifest.analysisBasis, declaredTs: manifest.createdTs,
    manifest: {
      manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest,
      createdTs: manifest.createdTs,
      catalogSnapshotDigest: manifest.catalogSnapshot.contentDigest,
      recipeDigests: manifest.recipeSeals.map((seal) => seal.recipeDigest).sort(),
      rulesDigest: canonicalDigest(manifest.rules), timeZone: manifest.timeZone,
      localDay: manifest.localDay, dayStartTs: manifest.dayStartTs, dayEndTs: manifest.dayEndTs,
    },
    inputDescriptor: clone(inputDescriptor), durability: clone(DAILY_STUDY_DURABILITY),
    authority: AUTHORITY, purpose: PURPOSE,
  };
  value.jobDigest = digestWithout(value, ['jobDigest']);
  const error = dailyStudyJobDescriptorError(value); if (error) fail('JOB_INVALID', error);
  return deepFreeze(value);
}

export function dailyStudyProgressUpdateError(value) {
  if (!exact(value, PROGRESS_UPDATE_KEYS) || !PHASE_RANK.has(value.phase)
      || value.phase === 'FINALIZED' || !count(value.completedSteps) || !count(value.totalSteps)
      || value.completedSteps > value.totalSteps || !count(value.plannedDecisionMoments)
      || !count(value.grossPlannedRecipeVariantSlots)
      || value.attemptedSimulations !== 0 || value.completedSimulations !== 0
      || value.validSimulationOutcomes !== 0 || typeof value.cancelled !== 'boolean'
      || value.cancelled !== (value.phase === 'CANCELLED')
      || !(value.note === null || (boundedString(value.note, 500)))) return 'progress update malformed or claims unexecuted simulations';
  return null;
}

function progressError(value) {
  if (!exact(value, PROGRESS_KEYS) || value.progressVersion !== DAILY_STUDY_PROGRESS_VERSION
      || !isTs(value.updatedTs)) return 'stored progress malformed';
  const update = Object.fromEntries(PROGRESS_UPDATE_KEYS.map((key) => [key, value[key]]));
  if (value.phase === 'FINALIZED') {
    update.phase = 'PLAN_COMPLETE';
    if (dailyStudyProgressUpdateError(update)) return 'stored finalized progress malformed';
  } else if (dailyStudyProgressUpdateError(update)) return 'stored progress malformed';
  return null;
}

function transitionError(previous, next) {
  if (previous.phase === 'FINALIZED' || previous.phase === 'CANCELLED') return `terminal phase ${previous.phase} cannot checkpoint`;
  if (PHASE_RANK.get(next.phase) < PHASE_RANK.get(previous.phase)) return 'progress phase regressed';
  if (next.completedSteps < previous.completedSteps || next.totalSteps < previous.totalSteps
      || next.plannedDecisionMoments < previous.plannedDecisionMoments
      || next.grossPlannedRecipeVariantSlots < previous.grossPlannedRecipeVariantSlots) return 'progress counters regressed';
  return null;
}

export function dailyStudyResultReceiptError(value, job = null) {
  if (!exact(value, RESULT_KEYS) || value.resultVersion !== DAILY_STUDY_RESULT_VERSION
      || !boundedString(value.resultId, 80) || !HEX64_RE.test(value.resultDigest ?? '')
      || !JOB_ID_RE.test(value.jobId ?? '') || !HEX64_RE.test(value.jobDigest ?? '')
      || !boundedString(value.manifestId, 80) || !HEX64_RE.test(value.manifestDigest ?? '')
      || value.studyVersion !== DAILY_MOVE_STUDY_VERSION || !HEX64_RE.test(value.studyDigest ?? '')
      || !count(value.studyBytes, DAILY_STUDY_STORE_LIMITS.maxStudyDigestBytes)
      || !count(value.caseCount, DAILY_BROAD_HARD_LIMITS.maxMarkets)
      || !count(value.plannedDecisionMoments) || !count(value.grossPlannedRecipeVariantSlots)
      || value.attemptedSimulations !== 0 || value.completedSimulations !== 0
      || value.validSimulationOutcomes !== 0 || value.fullDetailCasesClaimed !== 0
      || value.resultMode !== 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY'
      || value.externalArchive !== 'UNKNOWN' || value.authority !== AUTHORITY || value.purpose !== PURPOSE) return 'result receipt malformed or overclaims planning evidence';
  if (value.resultDigest !== digestWithout(value, ['resultId', 'resultDigest'])
      || value.resultId !== `dailyresult-${value.resultDigest.slice(0, 32)}`) return 'result receipt identity forged';
  if (job && (dailyStudyJobDescriptorError(job) || value.jobId !== job.jobId
      || value.jobDigest !== job.jobDigest || value.manifestId !== job.manifest.manifestId
      || value.manifestDigest !== job.manifest.manifestDigest)) return 'result receipt does not match its immutable job';
  return null;
}

export function sealDailyStudyResultReceipt({ jobDescriptor, study, preparedInput } = {}) {
  const jobError = dailyStudyJobDescriptorError(jobDescriptor); if (jobError) fail('RESULT_INVALID', jobError);
  if (!isPlainObject(preparedInput) || preparedInput.ok !== true
      || preparedInput.version !== DAILY_BROAD_INPUT_VERSION
      || preparedInput.acceptedCatalogSnapshot?.contentDigest !== jobDescriptor.inputDescriptor.catalogSnapshotDigest) {
    fail('RESULT_INVALID', 'prepared input does not match the immutable job');
  }
  const preparedDigest = boundedCanonicalDigest(preparedInput, DAILY_BROAD_HARD_LIMITS.maxInputBytes);
  if (preparedDigest.digest !== jobDescriptor.inputDescriptor.preparedInputDigest) {
    fail('RESULT_INVALID', 'prepared input content differs from the immutable job');
  }
  if (!exact(study, ['studyVersion', 'manifest', 'cases', 'counters', 'laws'])
      || study.studyVersion !== DAILY_MOVE_STUDY_VERSION
      || dailyMoveStudyManifestError(study.manifest)
      || study.manifest.manifestId !== jobDescriptor.manifest.manifestId
      || study.manifest.manifestDigest !== jobDescriptor.manifest.manifestDigest
      || !Array.isArray(study.cases) || study.cases.length > DAILY_BROAD_HARD_LIMITS.maxMarkets
      || !exact(study.counters, STUDY_COUNTER_KEYS)
      || study.counters.acceptedMarketDays !== study.cases.length
      || study.counters.attemptedSimulations !== 0 || study.counters.completedSimulations !== 0
      || study.counters.validSimulationOutcomes !== 0 || study.counters.fullDetailCasesClaimed !== 0) {
    fail('RESULT_INVALID', 'study does not match the bounded non-executing planner contract');
  }
  let expectedStudy;
  try {
    expectedStudy = buildDailyMoveStudy({
      manifest: study.manifest,
      acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
      marketDays: preparedInput.marketDays,
    });
  } catch (error) { fail('RESULT_INVALID', `independent planner recomputation refused: ${error.message}`); }
  const suppliedStudy = boundedCanonicalDigest(study, DAILY_STUDY_STORE_LIMITS.maxStudyDigestBytes);
  const sealedStudy = boundedCanonicalDigest(expectedStudy, DAILY_STUDY_STORE_LIMITS.maxStudyDigestBytes);
  if (suppliedStudy.digest !== sealedStudy.digest) fail('RESULT_INVALID', 'study differs from independent planner recomputation');
  const value = {
    resultVersion: DAILY_STUDY_RESULT_VERSION, resultId: '', resultDigest: '',
    jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
    manifestId: jobDescriptor.manifest.manifestId,
    manifestDigest: jobDescriptor.manifest.manifestDigest,
    studyVersion: study.studyVersion, studyDigest: sealedStudy.digest, studyBytes: sealedStudy.bytes,
    caseCount: study.cases.length,
    plannedDecisionMoments: study.counters.plannedDecisionMoments,
    grossPlannedRecipeVariantSlots: study.counters.grossPlannedRecipeVariantSlots,
    attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
    fullDetailCasesClaimed: 0, resultMode: 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY',
    externalArchive: 'UNKNOWN', authority: AUTHORITY, purpose: PURPOSE,
  };
  value.resultDigest = digestWithout(value, ['resultId', 'resultDigest']);
  value.resultId = `dailyresult-${value.resultDigest.slice(0, 32)}`;
  const error = dailyStudyResultReceiptError(value, jobDescriptor); if (error) fail('RESULT_INVALID', error);
  return deepFreeze(value);
}

function initialProgress(ts) {
  return {
    progressVersion: DAILY_STUDY_PROGRESS_VERSION, phase: 'DECLARED',
    completedSteps: 0, totalSteps: 0, plannedDecisionMoments: 0,
    grossPlannedRecipeVariantSlots: 0, attemptedSimulations: 0,
    completedSimulations: 0, validSimulationOutcomes: 0,
    cancelled: false, note: null, updatedTs: ts,
  };
}

function stateDigestOf(value) { return digestWithout(value, ['stateDigest']); }
function stateError(value, limits = DAILY_STUDY_STORE_LIMITS) {
  if (!exact(value, STATE_KEYS) || value.storeVersion !== DAILY_STUDY_STORE_VERSION
      || !count(value.revision, limits.maxRevisionsPerJob)
      || !sameDurability(value.durability)) return 'state envelope malformed';
  const jobError = dailyStudyJobDescriptorError(value.job); if (jobError) return jobError;
  const pError = progressError(value.progress); if (pError) return pError;
  if (!(value.result === null || isPlainObject(value.result))) return 'state result malformed';
  if (value.result === null && value.progress.phase === 'FINALIZED') return 'finalized state lacks a result receipt';
  if (value.result !== null) {
    const resultError = dailyStudyResultReceiptError(value.result, value.job); if (resultError) return resultError;
    if (value.progress.phase !== 'FINALIZED') return 'result receipt exists before FINALIZED progress';
  }
  if (!HEX64_RE.test(value.stateDigest ?? '') || value.stateDigest !== stateDigestOf(value)) return 'state digest forged';
  return null;
}

function frozenView(state, status = null) {
  return deepFreeze({
    ...(status === null ? {} : { status }), jobDigest: state.job.jobDigest,
    revision: state.revision, job: clone(state.job), progress: clone(state.progress),
    result: state.result === null ? null : clone(state.result),
  });
}

function normalizeLimits(supplied) {
  if (supplied === undefined) return DAILY_STUDY_STORE_LIMITS;
  if (!isPlainObject(supplied)) fail('LIMITS_INVALID', 'limits must be a record');
  const out = { ...DAILY_STUDY_STORE_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!(key in out) || !Number.isSafeInteger(value) || value < 1 || value > DAILY_STUDY_STORE_LIMITS[key]) fail('LIMITS_INVALID', key);
    out[key] = value;
  }
  if (out.maxJobs > out.maxDirectoryEntries) fail('LIMITS_INVALID', 'maxJobs exceeds maxDirectoryEntries');
  return Object.freeze(out);
}

function samePath(a, b) {
  const left = path.normalize(a); const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertDedicatedRoot(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) fail('PATH_INVALID', 'rootDir must be an absolute dedicated directory');
  const resolved = path.resolve(rootDir);
  if (samePath(resolved, path.parse(resolved).root)) fail('PATH_INVALID', 'filesystem root is never a store directory');
  mkdirSync(resolved, { recursive: true });
  if (lstatSync(resolved).isSymbolicLink()) fail('PATH_ESCAPE', 'store root cannot be a symlink');
  const real = realpathSync(resolved);
  if (!samePath(real, resolved)) fail('PATH_ESCAPE', 'store root resolves outside its declared path');
  return real;
}

function assertDirectory(directory, expected) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(directory), expected)) fail('PATH_ESCAPE', 'store directory custody changed');
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, 'r'); fsyncSync(fd);
  } catch (error) {
    if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function atomicWrite(file, value, jobsDir, limits) {
  assertDirectory(jobsDir, jobsDir);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail('PATH_ESCAPE', 'job state cannot be a symlink');
  const encoded = `${stableStringify(value)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxStateBytes) fail('STATE_BYTE_LIMIT', `state exceeds ${limits.maxStateBytes}`);
  const temp = path.join(jobsDir, `.${path.basename(file)}.${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    writeFileSync(temp, encoded, { flag: 'wx', mode: 0o600 });
    fd = openSync(temp, 'r+'); fsyncSync(fd); closeSync(fd); fd = undefined;
    assertDirectory(jobsDir, jobsDir);
    renameSync(temp, file); fsyncDirectory(jobsDir);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temp); } catch {}
    if (error instanceof DailyStudyStoreError) throw error;
    fail('STORE_IO', error.message);
  }
}

function readStateFile(file, limits) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) fail('PATH_ESCAPE', 'job state is not one regular file');
  if (st.size < 2 || st.size > limits.maxStateBytes) fail('STORE_CORRUPT', `state size ${st.size} outside limits`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { fail('STORE_CORRUPT', error.message); }
  const error = stateError(parsed, limits); if (error) fail('STORE_CORRUPT', error);
  return parsed;
}

function assertSmall(value, maximum, code) {
  let bytes;
  try { bytes = Buffer.byteLength(stableStringify(value), 'utf8'); }
  catch (error) { fail(code, error.message); }
  if (bytes > maximum) fail(code, `${bytes} exceeds ${maximum}`);
}

export async function openDailyStudyStore({ rootDir, clock = () => Date.now(), limits: suppliedLimits, recoverStaleLock = null } = {}) {
  if (typeof clock !== 'function') fail('CLOCK_INVALID', 'clock must be a function');
  if (!(recoverStaleLock === null || (exact(recoverStaleLock, ['expectedToken', 'confirmedBy'])
      && /^[a-f0-9]{24}$/.test(recoverStaleLock.expectedToken ?? '')
      && boundedString(recoverStaleLock.confirmedBy, 120)))) fail('LOCK_RECOVERY_INVALID', 'recovery requires exact expectedToken and confirmedBy');
  const limits = normalizeLimits(suppliedLimits);
  const root = assertDedicatedRoot(rootDir);
  const jobsDir = path.join(root, 'jobs');
  if (!existsSync(jobsDir)) mkdirSync(jobsDir, { mode: 0o700 });
  assertDirectory(jobsDir, jobsDir);
  const rootEntries = readdirSync(root, { withFileTypes: true });
  if (rootEntries.length > limits.maxDirectoryEntries
      || rootEntries.some((entry) => entry.name !== 'jobs' && entry.name !== 'writer.lock'
        && entry.name !== 'writer-recovery.lock' && !LOCK_REPLACEMENT_RE.test(entry.name))) fail('PATH_INVALID', 'store root is not dedicated or exceeds entry limit');

  const lockFile = path.join(root, 'writer.lock');
  const recoveryFile = path.join(root, 'writer-recovery.lock');
  const writerToken = randomBytes(12).toString('hex');
  const acquiredTs = clock(); if (!isTs(acquiredTs)) fail('CLOCK_INVALID', 'clock returned an invalid timestamp');
  const mutexToken = randomBytes(12).toString('hex');
  const replacementFile = path.join(root, `.writer-lock-replacement-${writerToken}.tmp`);
  const readLock = () => {
    let value;
    try { value = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return null; }
    return exact(value, ['storeVersion', 'writerToken', 'pid', 'acquiredTs'])
      && value.storeVersion === DAILY_STUDY_STORE_VERSION && /^[a-f0-9]{24}$/.test(value.writerToken)
      && Number.isSafeInteger(value.pid) && value.pid > 0 && isTs(value.acquiredTs) ? value : null;
  };
  let mutexOwned = false; let lockInstalled = false; let lockRecovered = null;
  try {
    try {
      writeFileSync(recoveryFile, stableStringify({ storeVersion: DAILY_STUDY_STORE_VERSION, mutexToken, pid: process.pid, acquiredTs }), { flag: 'wx', mode: 0o600 });
      mutexOwned = true;
    } catch (error) {
      if (error?.code === 'EEXIST') fail('DAILY_STUDY_LOCK_HELD', 'writer acquisition/recovery mutex exists; no age-based takeover is permitted');
      throw error;
    }
    try {
      writeFileSync(lockFile, stableStringify({ storeVersion: DAILY_STUDY_STORE_VERSION, writerToken, pid: process.pid, acquiredTs }), { flag: 'wx', mode: 0o600 });
      lockInstalled = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = readLock();
      if (recoverStaleLock === null) fail('DAILY_STUDY_LOCK_HELD', 'writer.lock exists; no age-based takeover is permitted');
      if (!held) fail('LOCK_RECOVERY_REFUSED', 'held writer lock is malformed');
      if (held.writerToken !== recoverStaleLock.expectedToken) fail('LOCK_RECOVERY_REFUSED', 'writer lock custody changed before recovery');
      writeFileSync(replacementFile, stableStringify({ storeVersion: DAILY_STUDY_STORE_VERSION, writerToken, pid: process.pid, acquiredTs }), { flag: 'wx', mode: 0o600 });
      const fd = openSync(replacementFile, 'r+'); fsyncSync(fd); closeSync(fd);
      const current = readLock();
      if (!current || current.writerToken !== recoverStaleLock.expectedToken) fail('LOCK_RECOVERY_REFUSED', 'writer lock custody changed before atomic replacement');
      renameSync(replacementFile, lockFile); lockInstalled = true;
      lockRecovered = { previousToken: current.writerToken, confirmedBy: recoverStaleLock.confirmedBy };
    }
    const fd = openSync(lockFile, 'r+'); fsyncSync(fd); closeSync(fd); fsyncDirectory(root);
  } catch (error) {
    if (lockInstalled && lockRecovered === null && readLock()?.writerToken === writerToken) { try { unlinkSync(lockFile); } catch {} }
    if (error instanceof DailyStudyStoreError) throw error;
    fail('STORE_IO', error.message);
  } finally {
    try { if (existsSync(replacementFile)) unlinkSync(replacementFile); } catch {}
    if (mutexOwned) {
      try {
        const mutex = JSON.parse(readFileSync(recoveryFile, 'utf8'));
        if (mutex?.mutexToken === mutexToken) { unlinkSync(recoveryFile); fsyncDirectory(root); }
      } catch { /* never remove a recovery mutex whose identity is not ours */ }
    }
  }

  let lockOwned = true;
  const releaseLock = () => {
    if (!lockOwned) return;
    let held;
    try { held = readLock(); }
    catch { lockOwned = false; fail('LOCK_LOST', 'writer lock unreadable at close'); }
    if (!held || held.writerToken !== writerToken) { lockOwned = false; fail('LOCK_LOST', 'writer lock custody changed'); }
    unlinkSync(lockFile); fsyncDirectory(root); lockOwned = false;
  };
  const assertLock = () => {
    let held;
    try { held = readLock(); }
    catch { fail('LOCK_LOST', 'writer lock unreadable'); }
    if (!lockOwned || !held || held.writerToken !== writerToken) fail('LOCK_LOST', 'writer lock custody changed');
  };

  const states = new Map();
  try {
    const entries = readdirSync(jobsDir, { withFileTypes: true });
    if (entries.length > limits.maxDirectoryEntries) fail('READ_LIMIT', 'jobs directory entry limit exceeded');
    let totalReadBytes = 0; let jobFiles = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('PATH_ESCAPE', `unsupported jobs entry ${entry.name}`);
      const match = entry.name.match(JOB_FILE_RE);
      if (!match) {
        if (entry.isFile() && TEMP_FILE_RE.test(entry.name)) continue; // an unrenamed temp was never committed
        fail('STORE_CORRUPT', `unexpected jobs entry ${entry.name}`);
      }
      if (!entry.isFile()) fail('PATH_ESCAPE', `job state ${entry.name} is not a file`);
      jobFiles += 1; if (jobFiles > limits.maxJobs) fail('READ_LIMIT', 'job count exceeds configured limit');
      const file = path.join(jobsDir, entry.name); const size = statSync(file).size;
      totalReadBytes += size;
      if (totalReadBytes > limits.maxTotalReadBytes) fail('READ_LIMIT', 'bounded store read budget exceeded');
      const state = readStateFile(file, limits);
      if (state.job.jobId !== match[1] || states.has(state.job.jobId)) fail('STORE_CORRUPT', 'job filename/identity mismatch or duplicate');
      states.set(state.job.jobId, state);
    }
  } catch (error) {
    try { releaseLock(); } catch {}
    throw error;
  }

  let tail = Promise.resolve(); let closing = false; let closed = false; let latched = null; let closePromise = null;
  const fatalCodes = new Set(['STORE_IO', 'STORE_CORRUPT', 'LOCK_LOST', 'PATH_ESCAPE', 'READ_LIMIT', 'DISK_CUSTODY_CONFLICT']);
  const enqueue = (operation) => {
    if (closing || closed) return Promise.reject(new DailyStudyStoreError('STORE_CLOSED'));
    if (latched) return Promise.reject(new DailyStudyStoreError('STORE_LATCHED', latched.code));
    const current = tail.then(async () => {
      if (latched) fail('STORE_LATCHED', latched.code);
      return operation();
    });
    tail = current.catch((error) => {
      if (error instanceof DailyStudyStoreError && fatalCodes.has(error.code) && latched === null) latched = error;
    });
    return current;
  };
  const stateFile = (jobId) => path.join(jobsDir, `${jobId}.json`);
  const persist = (state, expectedPrior = null) => {
    const error = stateError(state, limits); if (error) fail('STORE_CORRUPT', error);
    assertLock();
    const file = stateFile(state.job.jobId);
    if (expectedPrior === null) {
      if (existsSync(file)) fail('DISK_CUSTODY_CONFLICT', 'new job target already exists');
    } else {
      if (!existsSync(file)) fail('DISK_CUSTODY_CONFLICT', 'committed job state disappeared after open');
      const disk = readStateFile(file, limits);
      if (disk.stateDigest !== expectedPrior.stateDigest || disk.revision !== expectedPrior.revision
          || disk.job.jobDigest !== expectedPrior.job.jobDigest) {
        fail('DISK_CUSTODY_CONFLICT', 'committed job state changed outside this store');
      }
    }
    atomicWrite(file, state, jobsDir, limits);
  };

  const createJob = ({ jobDescriptor } = {}) => {
    const error = dailyStudyJobDescriptorError(jobDescriptor); if (error) return Promise.reject(new DailyStudyStoreError('JOB_INVALID', error));
    assertSmall(jobDescriptor, limits.maxDescriptorBytes, 'JOB_BYTE_LIMIT');
    return enqueue(() => {
      const existing = states.get(jobDescriptor.jobId);
      if (existing) {
        if (existing.job.jobDigest !== jobDescriptor.jobDigest) fail('JOB_ID_CONFLICT', 'jobId already names different manifest/recipe/input content');
        return frozenView(existing, 'EXISTING');
      }
      if (states.size >= limits.maxJobs) fail('JOB_LIMIT', `store already has ${states.size} jobs`);
      const ts = clock(); if (!isTs(ts) || ts < jobDescriptor.declaredTs) fail('CLOCK_INVALID', 'store clock precedes the declared retrospective job');
      const state = {
        storeVersion: DAILY_STUDY_STORE_VERSION, revision: 0, job: clone(jobDescriptor),
        progress: initialProgress(ts), result: null, durability: clone(DAILY_STUDY_DURABILITY), stateDigest: '',
      };
      state.stateDigest = stateDigestOf(state); persist(state); states.set(jobDescriptor.jobId, state);
      return frozenView(state, 'CREATED');
    });
  };

  const loadJob = (jobId) => {
    if (!JOB_ID_RE.test(jobId ?? '')) return Promise.reject(new DailyStudyStoreError('JOB_ID_INVALID'));
    return enqueue(() => {
      const state = states.get(jobId); return state ? frozenView(state) : null;
    });
  };

  const checkpoint = ({ jobId, jobDigest, expectedRevision, progress } = {}) => {
    if (!JOB_ID_RE.test(jobId ?? '') || !HEX64_RE.test(jobDigest ?? '') || !count(expectedRevision, limits.maxRevisionsPerJob)) return Promise.reject(new DailyStudyStoreError('CHECKPOINT_INVALID', 'identity/revision malformed'));
    const updateError = dailyStudyProgressUpdateError(progress); if (updateError) return Promise.reject(new DailyStudyStoreError('CHECKPOINT_INVALID', updateError));
    assertSmall(progress, limits.maxProgressBytes, 'PROGRESS_BYTE_LIMIT');
    return enqueue(() => {
      const prior = states.get(jobId); if (!prior) fail('JOB_NOT_FOUND', jobId);
      if (prior.job.jobDigest !== jobDigest) fail('JOB_DIGEST_CONFLICT', jobId);
      if (prior.revision !== expectedRevision) fail('REVISION_CONFLICT', `expected ${expectedRevision}, current ${prior.revision}`);
      if (prior.revision >= limits.maxRevisionsPerJob) fail('REVISION_LIMIT', `job reached revision ${prior.revision}`);
      const transition = transitionError(prior.progress, progress); if (transition) fail('PROGRESS_CONFLICT', transition);
      const ts = clock(); if (!isTs(ts) || ts < prior.progress.updatedTs) fail('CLOCK_INVALID', 'store clock regressed');
      const next = {
        ...clone(prior), revision: prior.revision + 1,
        progress: { progressVersion: DAILY_STUDY_PROGRESS_VERSION, ...clone(progress), updatedTs: ts }, stateDigest: '',
      };
      next.stateDigest = stateDigestOf(next); persist(next, prior); states.set(jobId, next);
      return frozenView(next, 'CHECKPOINTED');
    });
  };

  const finalize = ({ jobId, jobDigest, expectedRevision, resultReceipt, study = null, preparedInput = null } = {}) => {
    if (!JOB_ID_RE.test(jobId ?? '') || !HEX64_RE.test(jobDigest ?? '') || !count(expectedRevision, limits.maxRevisionsPerJob)) return Promise.reject(new DailyStudyStoreError('FINALIZE_INVALID', 'identity/revision malformed'));
    // The caller may supply its own proposed receipt for compatibility. A
    // missing receipt is constructed here through the same independent build,
    // never by trusting a caller hash or skipping semantic verification.
    if (resultReceipt !== undefined) assertSmall(resultReceipt, limits.maxResultBytes, 'RESULT_BYTE_LIMIT');
    return enqueue(() => {
      const prior = states.get(jobId); if (!prior) fail('JOB_NOT_FOUND', jobId);
      if (prior.job.jobDigest !== jobDigest) fail('JOB_DIGEST_CONFLICT', jobId);
      const independentlySealed = resultReceipt === undefined
        ? sealDailyStudyResultReceipt({ jobDescriptor: prior.job, study, preparedInput }) : null;
      const candidateReceipt = resultReceipt ?? independentlySealed;
      assertSmall(candidateReceipt, limits.maxResultBytes, 'RESULT_BYTE_LIMIT');
      const resultError = dailyStudyResultReceiptError(candidateReceipt, prior.job); if (resultError) fail('RESULT_INVALID', resultError);
      if (candidateReceipt.studyBytes > limits.maxStudyDigestBytes) fail('RESULT_BYTE_LIMIT', `study digest input exceeds ${limits.maxStudyDigestBytes}`);
      if (prior.result !== null) {
        if (prior.result.resultDigest !== candidateReceipt.resultDigest) fail('RESULT_CONFLICT', 'job already has a different completed result');
        return frozenView(prior, 'EXISTING');
      }
      if (prior.revision !== expectedRevision) fail('REVISION_CONFLICT', `expected ${expectedRevision}, current ${prior.revision}`);
      if (prior.revision >= limits.maxRevisionsPerJob) fail('REVISION_LIMIT', `job reached revision ${prior.revision}`);
      if (prior.progress.phase !== 'PLAN_COMPLETE') fail('PROGRESS_CONFLICT', 'result cannot finalize before PLAN_COMPLETE');
      if (prior.progress.plannedDecisionMoments !== candidateReceipt.plannedDecisionMoments
          || prior.progress.grossPlannedRecipeVariantSlots !== candidateReceipt.grossPlannedRecipeVariantSlots) fail('RESULT_CONFLICT', 'result counters disagree with durable progress');
      const verifiedReceipt = independentlySealed ?? sealDailyStudyResultReceipt({ jobDescriptor: prior.job, study, preparedInput });
      if (verifiedReceipt.resultDigest !== candidateReceipt.resultDigest) {
        fail('RESULT_INVALID', 'receipt differs from independently recomputed planner output');
      }
      const ts = clock(); if (!isTs(ts) || ts < prior.progress.updatedTs) fail('CLOCK_INVALID', 'store clock regressed');
      const next = {
        ...clone(prior), revision: prior.revision + 1, result: clone(candidateReceipt),
        progress: { ...clone(prior.progress), phase: 'FINALIZED', updatedTs: ts }, stateDigest: '',
      };
      next.stateDigest = stateDigestOf(next); persist(next, prior); states.set(jobId, next);
      return frozenView(next, 'FINALIZED');
    });
  };

  const status = () => deepFreeze({
    storeVersion: DAILY_STUDY_STORE_VERSION, open: !closing && !closed,
    jobCount: states.size, finalizedJobs: [...states.values()].filter((state) => state.result !== null).length,
    failed: latched === null ? null : { code: latched.code, detail: String(latched.message).slice(0, 500) },
    writerRecovery: lockRecovered === null ? null : clone(lockRecovered),
    durability: clone(DAILY_STUDY_DURABILITY),
    emptyStoreMeaning: 'NO_JOBS_IS_NOT_A_COMPLETION_RECEIPT',
  });

  const close = async () => {
    if (closed) return;
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await tail;
      try { releaseLock(); } finally { closed = true; }
    })();
    return closePromise;
  };

  return Object.freeze({ rootDir: root, createJob, loadJob, checkpoint, finalize, status, close });
}
