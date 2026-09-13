// Optional WideEye -> prospective opportunity-audit adapter.
//
// The two-phase boundary is intentional: beforeSweep durably seals the random
// frame before the caller fetches Ticker; afterSweep can only annotate that
// frame. Notices and verdicts are observations, never inferred nominations.
import {
  annotateAuditOpportunity, auditFrameError, sealAuditFrame, sealAuditObservationEvidence,
} from './opportunity-audit.js';
import { canonicalDigest, deepFreeze, exactKeys, isCoin, isId, isPlainObject, isTs } from './contracts.js';

export const OPPORTUNITY_AUDIT_WIDEEYE_PORT_VERSION = 'opportunity-audit-wideeye-port-1';
export const OPPORTUNITY_AUDIT_WIDEEYE_FEATURE_RECIPE_VERSION = 'wideeye-audit-features-1';
export const OPPORTUNITY_AUDIT_WIDEEYE_MAX_SAMPLE_SIZE = 8;
export const OPPORTUNITY_AUDIT_WIDEEYE_MAX_ROWS = 5_000;

const TOKEN_VERSION = 'opportunity-audit-wideeye-token-1';
const TOKEN_KEYS = Object.freeze(['tokenVersion', 'tokenDigest', 'frameId', 'frameDigest', 'catalogContentId', 'frameTs']);
const UNEVALUATED_ROW_KEYS = Object.freeze(['coin', 'evaluated', 'reason']);
const EVALUATED_ROW_KEYS = Object.freeze([
  'coin', 'evaluated', 'zVol', 'zRet', 'extension', 'preCooldownVerdict',
  'cooldownSuppressed', 'noticeEmitted', 'usdVol24h', 'inDeepTape',
]);
const OBSERVATION_KEYS = Object.freeze(['sweepId', 'catalogContentId', 'observedTs', 'rows']);
const COMPONENT_KEYS = Object.freeze(['componentId', 'version', 'configDigest']);
const HEX64_RE = /^[a-f0-9]{64}$/;
const UNEVALUATED_REASONS = Object.freeze(['NO_TICKER_ROW', 'PRICE_INVALID', 'INSUFFICIENT_SERIES']);
const REASON_TO_STATE = Object.freeze({
  NO_TICKER_ROW: 'MISSING_TICKER', PRICE_INVALID: 'PRICE_INVALID', INSUFFICIENT_SERIES: 'INSUFFICIENT_SERIES',
});
const clone = (value) => structuredClone(value);
const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const safePositive = (value) => Number.isSafeInteger(value) && value > 0;

export class OpportunityAuditWideEyePortError extends Error {
  constructor(code, detail = code) {
    super(`opportunity audit WideEye port: ${code}: ${String(detail).slice(0, 500)}`);
    this.name = 'OpportunityAuditWideEyePortError'; this.code = code;
  }
}
const fail = (code, detail) => { throw new OpportunityAuditWideEyePortError(code, detail); };

function tokenCore(token) { const copy = clone(token); delete copy.tokenDigest; return copy; }
function tokenError(token) {
  if (!exact(token, TOKEN_KEYS) || token.tokenVersion !== TOKEN_VERSION || !HEX64_RE.test(token.tokenDigest ?? '')
      || !/^oaf-[a-f0-9]{40}$/.test(token.frameId ?? '') || !HEX64_RE.test(token.frameDigest ?? '')
      || !/^[a-f0-9]{40}$/.test(token.catalogContentId ?? '') || !isTs(token.frameTs)) return 'token shape malformed';
  return token.tokenDigest === canonicalDigest(tokenCore(token)) ? null : 'token digest mismatch';
}
function tokenOf(frame) {
  const core = {
    tokenVersion: TOKEN_VERSION, frameId: frame.frameId, frameDigest: frame.frameDigest,
    catalogContentId: frame.catalog.contentId, frameTs: frame.frameTs,
  };
  return deepFreeze({ ...core, tokenDigest: canonicalDigest(core) });
}

function catalogFromSnapshot(catalogSnapshot, frameTs) {
  if (!isPlainObject(catalogSnapshot) || catalogSnapshot.status !== 'ACCEPTED'
      || catalogSnapshot.fresh !== true || !isPlainObject(catalogSnapshot.catalog)
      || catalogSnapshot.contentId !== catalogSnapshot.catalog.contentId
      || !isTs(catalogSnapshot.catalog.observedTs) || catalogSnapshot.catalog.observedTs > frameTs) {
    fail('CATALOG_UNAVAILABLE', 'beforeSweep requires one fresh accepted catalog snapshot');
  }
  return catalogSnapshot.catalog;
}

function evaluatedRowError(row) {
  if (!exact(row, EVALUATED_ROW_KEYS) || row.evaluated !== true || !isCoin(row.coin)
      || ![row.zVol, row.zRet, row.extension].every((value) => value === null || (typeof value === 'number' && Number.isFinite(value)))
      || !(row.preCooldownVerdict === null || ['RIPPLE', 'MISSED'].includes(row.preCooldownVerdict))
      || typeof row.cooldownSuppressed !== 'boolean' || typeof row.noticeEmitted !== 'boolean'
      || !(row.usdVol24h === null || (typeof row.usdVol24h === 'number' && Number.isFinite(row.usdVol24h) && row.usdVol24h >= 0))
      || typeof row.inDeepTape !== 'boolean') return 'evaluated row malformed';
  if (row.noticeEmitted && row.preCooldownVerdict === null) return 'notice cannot exist without its pre-cooldown verdict';
  if (row.noticeEmitted && row.cooldownSuppressed) return 'a cooldown-suppressed verdict cannot be emitted';
  return null;
}
function unevaluatedRowError(row) {
  return !exact(row, UNEVALUATED_ROW_KEYS) || row.evaluated !== false || !isCoin(row.coin)
    || !UNEVALUATED_REASONS.includes(row.reason) ? 'unevaluated row malformed' : null;
}

function observationRows(observation, frame, recordedTs) {
  if (!exact(observation, OBSERVATION_KEYS) || !isId(observation.sweepId)
      || observation.catalogContentId !== frame.catalog.contentId || !isTs(observation.observedTs)
      || observation.observedTs < frame.frameTs || observation.observedTs > recordedTs
      || !Array.isArray(observation.rows) || observation.rows.length > OPPORTUNITY_AUDIT_WIDEEYE_MAX_ROWS) {
    fail('SWEEP_OBSERVATION_INVALID', 'sweep identity, clocks, catalog or row bound malformed');
  }
  const catalogCoins = new Set(frame.population.map((entry) => entry.market.base)); const rows = new Map();
  for (const row of observation.rows) {
    const error = row?.evaluated === true ? evaluatedRowError(row) : unevaluatedRowError(row);
    if (error) fail('SWEEP_OBSERVATION_INVALID', error);
    if (!catalogCoins.has(row.coin)) fail('SWEEP_OBSERVATION_INVALID', `row ${row.coin} is outside the sealed catalog`);
    if (rows.has(row.coin)) fail('SWEEP_OBSERVATION_INVALID', `row ${row.coin} is duplicated`);
    rows.set(row.coin, row);
  }
  return rows;
}

function feature(name, value, unit, unavailable = 'WARMUP') {
  return value === null
    ? { name, value: null, unit, availability: unavailable }
    : { name, value, unit, availability: 'KNOWN' };
}

function evidenceFor(observation, row) {
  const sourceDigest = canonicalDigest({
    evidenceSourceVersion: 'wideeye-audit-row-source-1', sweepId: observation.sweepId,
    catalogContentId: observation.catalogContentId, observedTs: observation.observedTs, row,
  });
  return sealAuditObservationEvidence({
    sourceId: observation.sweepId, sourceDigest,
    featureRecipeVersion: OPPORTUNITY_AUDIT_WIDEEYE_FEATURE_RECIPE_VERSION,
    features: [
      feature('cooldownSuppressed', row.cooldownSuppressed, 'BOOLEAN'),
      feature('extension', row.extension, 'PERCENT'),
      feature('inDeepTape', row.inDeepTape, 'BOOLEAN'),
      feature('noticeEmitted', row.noticeEmitted, 'BOOLEAN'),
      feature('preCooldownVerdict', row.preCooldownVerdict ?? 'NONE', 'CATEGORY'),
      feature('usdVol24h', row.usdVol24h, 'USD', 'UNAVAILABLE'),
      feature('zRet', row.zRet, 'ZSCORE'),
      feature('zVol', row.zVol, 'ZSCORE'),
    ],
  });
}

function annotationFor(frame, entry, observation, row, component) {
  const observed = row === undefined ? {
    state: 'UNAVAILABLE', reasonCode: 'SWEEP_ROW_MISSING', knownAtTs: observation.observedTs, evidence: null,
  } : row.evaluated ? {
    state: 'EVALUATED', reasonCode: null, knownAtTs: observation.observedTs, evidence: evidenceFor(observation, row),
  } : {
    state: REASON_TO_STATE[row.reason], reasonCode: row.reason, knownAtTs: observation.observedTs, evidence: null,
  };
  return annotateAuditOpportunity({
    frame, opportunityId: entry.opportunityId,
    // observedTs is the stable completion clock of this sweep. Using a later
    // retry clock would turn the same evidence into conflicting annotation.
    recordedTs: observation.observedTs,
    observation: observed,
    nomination: { state: 'UNAVAILABLE', reasonCode: 'NO_DOWNSTREAM_NOMINATION_SOURCE' },
    decision: { state: 'UNAVAILABLE', reasonCode: 'NO_DOWNSTREAM_DECISION_SOURCE' },
    components: [{ ...component, state: 'OBSERVED' }],
  });
}

function validateConfiguration({ store, sampleSize, horizonsMs, minFrameIntervalMs, wideEyeComponent, maxRememberedFrames, clock }) {
  if (!isPlainObject(store) && (typeof store !== 'object' || store === null)) fail('CONFIG_INVALID', 'store malformed');
  for (const method of ['createFrame', 'loadFrame', 'appendAnnotation', 'status']) if (typeof store[method] !== 'function') fail('CONFIG_INVALID', `store.${method} missing`);
  if (!safePositive(sampleSize) || sampleSize > OPPORTUNITY_AUDIT_WIDEEYE_MAX_SAMPLE_SIZE) fail('CONFIG_INVALID', `sampleSize must be 1..${OPPORTUNITY_AUDIT_WIDEEYE_MAX_SAMPLE_SIZE}`);
  if (!Array.isArray(horizonsMs) || horizonsMs.length < 1) fail('CONFIG_INVALID', 'horizonsMs missing');
  if (!safePositive(minFrameIntervalMs) || minFrameIntervalMs < 60_000 || minFrameIntervalMs > 86_400_000) fail('CONFIG_INVALID', 'minFrameIntervalMs must be 1 minute..1 day');
  if (!exact(wideEyeComponent, COMPONENT_KEYS) || wideEyeComponent.componentId !== 'wideeye'
      || !isId(wideEyeComponent.version) || !HEX64_RE.test(wideEyeComponent.configDigest ?? '')) fail('CONFIG_INVALID', 'sealed WideEye component identity required');
  if (!safePositive(maxRememberedFrames) || maxRememberedFrames > 256 || typeof clock !== 'function') fail('CONFIG_INVALID', 'memory/clock bound malformed');
}

export function createOpportunityAuditWideEyePort({
  store, sampleSize = 4, horizonsMs = [60 * 60 * 1000], minFrameIntervalMs = 15 * 60 * 1000,
  wideEyeComponent, maxRememberedFrames = 256, clock = () => Date.now(),
} = {}) {
  validateConfiguration({ store, sampleSize, horizonsMs, minFrameIntervalMs, wideEyeComponent, maxRememberedFrames, clock });
  const component = deepFreeze(clone(wideEyeComponent)); const remembered = new Map();
  const initialStoreStatus = store.status();
  if (!isPlainObject(initialStoreStatus) || !(initialStoreStatus.latestFrameTs === null || isTs(initialStoreStatus.latestFrameTs))) fail('CONFIG_INVALID', 'store status lacks a valid durable latestFrameTs');
  let lastFrameTs = initialStoreStatus.latestFrameTs; let beforeInFlight = null; let beforeSlot = null; const afterInFlight = new Map();
  let framesCreated = 0; let cadenceSkips = 0; let annotationsWritten = 0; let lastError = null;

  const beforeSweep = ({ catalogSnapshot, frameTs } = {}) => {
    if (!isTs(frameTs) || frameTs > clock()) return Promise.reject(new OpportunityAuditWideEyePortError('FRAME_CLOCK_INVALID'));
    let catalog;
    try { catalog = catalogFromSnapshot(catalogSnapshot, frameTs); }
    catch (error) { lastError = error; return Promise.reject(error); }
    const slot = `${catalog.contentId}|${frameTs}`;
    if (remembered.has(slot)) {
      const token = remembered.get(slot);
      return store.loadFrame(token.frameId).then((view) => {
        if (!view || view.frame.frameDigest !== token.frameDigest) fail('DURABLE_FRAME_MISSING', 'remembered frame lost durable custody');
        return token;
      });
    }
    if (beforeInFlight !== null) {
      if (beforeSlot === slot) return beforeInFlight;
      return Promise.reject(new OpportunityAuditWideEyePortError('FRAME_CREATE_IN_FLIGHT'));
    }
    if (lastFrameTs !== null) {
      if (frameTs < lastFrameTs) return Promise.reject(new OpportunityAuditWideEyePortError('FRAME_CLOCK_REGRESSION'));
      if (frameTs - lastFrameTs < minFrameIntervalMs) { cadenceSkips += 1; return Promise.resolve(null); }
    }
    if (remembered.size >= maxRememberedFrames) return Promise.reject(new OpportunityAuditWideEyePortError('FRAME_MEMORY_LIMIT', 'no remembered frame is silently evicted'));
    const task = (async () => {
      const frame = sealAuditFrame({
        catalog, frameTs, knownAtTs: catalog.observedTs, sampleSize, horizonsMs,
      });
      let view;
      try { view = await store.createFrame({ frame }); }
      catch (error) {
        if (error?.code === 'FRAME_SLOT_CONFLICT') fail('DURABLE_FRAME_COLLISION', 'a prior process already sealed this slot; refusing to redraw without its token');
        throw error;
      }
      if (!view || view.frame?.frameDigest !== frame.frameDigest || auditFrameError(view.frame)) fail('STORE_VIEW_INVALID', 'store did not return the exact durable frame');
      const token = tokenOf(view.frame); remembered.set(slot, token); lastFrameTs = frameTs; framesCreated += view.status === 'CREATED' ? 1 : 0;
      return token;
    })();
    beforeSlot = slot;
    beforeInFlight = task.catch((error) => { lastError = error; throw error; }).finally(() => { beforeInFlight = null; beforeSlot = null; });
    return beforeInFlight;
  };

  const afterSweep = ({ auditToken, observation, recordedTs } = {}) => {
    const problem = tokenError(auditToken);
    if (problem) return Promise.reject(new OpportunityAuditWideEyePortError('TOKEN_INVALID', problem));
    if (!isTs(recordedTs) || recordedTs > clock()) return Promise.reject(new OpportunityAuditWideEyePortError('RECEIPT_CLOCK_INVALID'));
    const existingTask = afterInFlight.get(auditToken.tokenDigest); if (existingTask) return existingTask;
    const task = (async () => {
      let view = await store.loadFrame(auditToken.frameId);
      if (!view || view.frame.frameDigest !== auditToken.frameDigest || view.frame.catalog.contentId !== auditToken.catalogContentId
          || view.frame.frameTs !== auditToken.frameTs || auditFrameError(view.frame)) fail('DURABLE_FRAME_MISSING', 'token does not resolve to its exact durable frame');
      const rows = observationRows(observation, view.frame, recordedTs);
      let missingRows = 0; let unevaluatedRows = 0; let appended = 0;
      const selected = view.frame.population.filter((entry) => entry.selected);
      const planned = selected.map((entry) => {
        const row = rows.get(entry.market.base); if (row === undefined) missingRows += 1; else if (!row.evaluated) unevaluatedRows += 1;
        return annotationFor(view.frame, entry, observation, row, component);
      });
      // Whole sweep validation and deterministic annotation construction occur
      // before the first write. A later write fault can leave an honest partial
      // frame; retrying this exact token/sweep resumes idempotently.
      for (const annotation of planned) {
        const prior = view.annotations.find((row) => row.opportunityId === annotation.opportunityId);
        if (prior) {
          if (prior.annotationDigest !== annotation.annotationDigest) fail('ANNOTATION_CONFLICT', 'durable annotation differs from exact sweep evidence');
          continue;
        }
        view = await store.appendAnnotation({
          frameId: view.frame.frameId, frameDigest: view.frame.frameDigest,
          expectedRevision: view.revision, annotation,
        });
        appended += 1; annotationsWritten += 1;
      }
      return deepFreeze({
        portVersion: OPPORTUNITY_AUDIT_WIDEEYE_PORT_VERSION, status: appended === 0 ? 'EXISTING_COMPLETE' : 'ANNOTATED',
        frameId: view.frame.frameId, frameDigest: view.frame.frameDigest, storeRevision: view.revision,
        selectedOpportunities: selected.length, annotationsPresent: view.annotations.length,
        missingSelectedRows: missingRows, unevaluatedSelectedRows: unevaluatedRows,
        observationInclusionProbability: view.frame.sampling.inclusionProbability,
        actionPropensity: { state: 'NOT_LOGGED', value: null, policyVersion: null },
        authority: 'NONE', trainingAuthority: 'NONE',
      });
    })();
    const joined = task.catch((error) => { lastError = error; throw error; }).finally(() => afterInFlight.delete(auditToken.tokenDigest));
    afterInFlight.set(auditToken.tokenDigest, joined); return joined;
  };

  const status = () => deepFreeze({
    portVersion: OPPORTUNITY_AUDIT_WIDEEYE_PORT_VERSION, framesCreated, cadenceSkips, annotationsWritten,
    rememberedFrames: remembered.size, beforeInFlight: beforeInFlight !== null, afterInFlight: afterInFlight.size,
    lastFrameTs, failed: lastError === null ? null : { code: lastError.code ?? 'ERROR', detail: String(lastError.message).slice(0, 500) },
    maxSampleSize: OPPORTUNITY_AUDIT_WIDEEYE_MAX_SAMPLE_SIZE,
    directCollectorSafe: false, requiresWorkerIsolation: true,
    authority: 'NONE', trainingAuthority: 'NONE',
  });

  return Object.freeze({ beforeSweep, afterSweep, status });
}
