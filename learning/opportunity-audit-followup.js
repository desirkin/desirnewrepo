// Bounded maturation owner for the prospective opportunity audit.
//
// Sampling and decision-time custody are owned by opportunity-audit.js and the
// WideEye port. This module only follows already-selected, durably annotated
// opportunities. It never selects from outcomes and never grants training,
// promotion, or trading authority.
import {
  attachAuditOutcome, auditFrameError, auditOutcomeError,
  OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION_V2, OPPORTUNITY_AUDIT_FRAME_VERSION_V2,
  OPPORTUNITY_AUDIT_MAX_LABEL_DELAY_MS, OPPORTUNITY_AUDIT_MAX_TARGET_HORIZON_MS_V2,
  OPPORTUNITY_AUDIT_MIN_LABEL_DELAY_MS, OPPORTUNITY_AUDIT_TARGET_VERSION_V2,
  opportunityAuditTargetTiming,
} from './opportunity-audit.js';
import {
  canonicalDigest, canonicalJson, deepFreeze, exactKeys, isCoin, isId, isPlainObject, isTs,
} from './contracts.js';

export const OPPORTUNITY_AUDIT_FOLLOWUP_VERSION = 'opportunity-audit-followup-1';
export const OPPORTUNITY_AUDIT_FOLLOWUP_VERSION_V2 = 'opportunity-audit-followup-2';
export const OPPORTUNITY_AUDIT_CANDLE_EVIDENCE_VERSION = 'opportunity-audit-candle-window-1';
export const OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS = 1_500;
export const OPPORTUNITY_AUDIT_FOLLOWUP_MAX_PER_STEP = 100;
export const OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2 = 'opportunity-audit-pending-item-2';
export const OPPORTUNITY_AUDIT_BROAD_DAY_SOURCE_RECEIPT_VERSION = 'opportunity-audit-broad-day-source-receipt-1';
export const OPPORTUNITY_AUDIT_SETTLEMENT_RECEIPT_VERSION_V2 = 'opportunity-audit-settlement-receipt-2';

const MINUTE_MS = 60_000;
const HEX64_RE = /^[a-f0-9]{64}$/;
const BAR_KEYS = Object.freeze(['openTs', 'close', 'knownAtTs']);
const EVIDENCE_KEYS = Object.freeze([
  'evidenceVersion', 'canonicalCoin', 'intervalMs', 'sourceKind', 'sourceId',
  'archiveDigest', 'archiveCreatedTs', 'bars', 'evidenceDigest',
]);
const RESOLUTION_KEYS = Object.freeze({
  AVAILABLE: ['state', 'evidence'],
  PENDING: ['state', 'reasonCode'],
  REFUSED: ['state', 'reasonCode'],
  TERMINAL: ['state', 'reasonCode', 'knownAtTs', 'sourceReference'],
});
const V2_RESOLUTION_KEYS = Object.freeze(['state', 'reasonCode', 'preparedTs', 'sourceReceipt', 'evidence']);
const SOURCE_KEYS = Object.freeze(['sourceKind', 'sourceId', 'sourceDigest']);
const MARKET_KEYS = Object.freeze(['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status']);
const PENDING_ITEM_V1_KEYS = Object.freeze([
  'cursor', 'frameId', 'frameDigest', 'opportunityId', 'canonicalCoin', 'horizonMs', 'dueTs',
  'lastOutcomeId', 'lastStatus', 'annotationPresent', 'observationInclusionProbability', 'actionPropensity',
]);
const PENDING_ITEM_V2_KEYS = Object.freeze([
  'itemVersion', 'cursor', 'frameVersion', 'frameId', 'frameDigest', 'frameTs', 'captureRecipeVersion',
  'targetVersion', 'targetDigest', 'opportunityId', 'marketIdentityDigest', 'market', 'horizonMs',
  'dueTs', 'maxLabelDelayMs', 'deadlineTs', 'lastOutcomeId', 'lastStatus', 'annotationPresent',
  'observationInclusionProbability', 'actionPropensity',
]);
const SOURCE_BINDING_KEYS = Object.freeze([
  'bindingVersion', 'sourceId', 'sourceRootDigest', 'archiveVersion', 'durability', 'republishSafe',
]);
const SOURCE_RECEIPT_KEYS = Object.freeze([
  'receiptVersion', 'receiptId', 'receiptDigest', 'requestDigest', 'frameId', 'frameDigest',
  'targetDigest', 'opportunityId', 'marketIdentityDigest', 'market', 'horizonMs', 'dueTs',
  'maxLabelDelayMs', 'deadlineTs', 'anchorOpenTs', 'terminalOpenTs', 'terminalCloseTs',
  'asOfTs', 'preparedTs', 'resolutionState', 'resolutionReason', 'sourceBinding',
  'archiveManifest', 'recordCount', 'recordInventoryDigest', 'anchorRecord', 'terminalRecord',
  'evidenceDigest', 'valueLaw', 'authority', 'trainingAuthority',
]);
const MANIFEST_KEYS = Object.freeze([
  'manifestVersion', 'manifestId', 'manifestDigest', 'sourceBindingDigest', 'readerDatasets',
  'requestedWindowStartTs', 'requestedWindowEndTs', 'sourceMarketIdentityDigest',
  'catalogMembershipDigest', 'recordCount', 'recordInventoryDigest',
]);
const DATASET_KEYS = Object.freeze([
  'datasetVersion', 'datasetId', 'datasetDigest', 'dayStartTs', 'dayEndTs', 'asOfTs',
  'sourceRootDigest', 'catalogEpochDigest', 'sourceMarketIdentityDigest',
]);
const RECORD_KEYS = Object.freeze(['recordId', 'recordDigest', 'periodStartTs', 'periodEndTs', 'knownAtTs', 'close']);
const SETTLEMENT_RECEIPT_KEYS = Object.freeze([
  'receiptVersion', 'receiptId', 'receiptDigest', 'requestDigest', 'itemDigest', 'resolutionDigest',
  'frameId', 'frameDigest', 'opportunityId', 'horizonMs', 'dueTs', 'deadlineTs', 'recordedTs',
  'state', 'sourceReceipt', 'outcome', 'readback', 'durableOutcome', 'authority', 'trainingAuthority',
]);
const READBACK_KEYS = Object.freeze(['frameId', 'frameDigest', 'storeRevision', 'outcomeId', 'outcomeDigest']);
const TERMINAL_STATES = new Set(['MISSING', 'CENSORED', 'DELISTED_OR_UNAVAILABLE', 'UNSUPPORTED']);
const TRANSIENT_CUSTODY_CODES = new Set(['WORKER_BUSY', 'QUEUE_FULL']);
const clone = (value) => structuredClone(value);
const exact = (value, keys) => isPlainObject(value) && exactKeys(value, keys) === null;
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const digest40 = (prefix, value) => `${prefix}-${canonicalDigest(value).slice(0, 40)}`;

export class OpportunityAuditFollowupError extends Error {
  constructor(code, detail = code) {
    super(`opportunity audit follow-up: ${code}: ${String(detail).slice(0, 500)}`);
    this.name = 'OpportunityAuditFollowupError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new OpportunityAuditFollowupError(code, detail); };

function sourceReferenceError(value) {
  return !exact(value, SOURCE_KEYS)
    || !['CLOSED_CANDLE_ARCHIVE', 'OTHER_VERIFIED_ARCHIVE'].includes(value.sourceKind)
    || !isId(value.sourceId) || !HEX64_RE.test(value.sourceDigest ?? '');
}

function evidenceCore(value) {
  const copy = clone(value); delete copy.evidenceDigest; return copy;
}

export function opportunityAuditCandleEvidenceError(value, { nowTs = null, maxBars = OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS } = {}) {
  if (!exact(value, EVIDENCE_KEYS) || value.evidenceVersion !== OPPORTUNITY_AUDIT_CANDLE_EVIDENCE_VERSION
      || !isCoin(value.canonicalCoin) || value.intervalMs !== MINUTE_MS
      || !['CLOSED_CANDLE_ARCHIVE', 'OTHER_VERIFIED_ARCHIVE'].includes(value.sourceKind)
      || !isId(value.sourceId) || !HEX64_RE.test(value.archiveDigest ?? '')
      || !isTs(value.archiveCreatedTs) || !Number.isSafeInteger(maxBars) || maxBars < 1
      || maxBars > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS || !Array.isArray(value.bars)
      || value.bars.length < 1 || value.bars.length > maxBars || !HEX64_RE.test(value.evidenceDigest ?? '')) {
    return 'candle evidence shape, source or bound malformed';
  }
  let previous = null; let knownAtCeiling = 0;
  for (const bar of value.bars) {
    if (!exact(bar, BAR_KEYS) || !isTs(bar.openTs) || bar.openTs % MINUTE_MS !== 0
        || typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0
        || !isTs(bar.knownAtTs) || bar.knownAtTs < bar.openTs + MINUTE_MS
        || (nowTs !== null && bar.knownAtTs > nowTs)
        || (previous !== null && bar.openTs !== previous + MINUTE_MS)) {
      return 'candle evidence contains an invalid, future, duplicate, reordered or non-contiguous bar';
    }
    previous = bar.openTs; knownAtCeiling = Math.max(knownAtCeiling, bar.knownAtTs);
  }
  if (value.archiveCreatedTs < knownAtCeiling || (nowTs !== null && value.archiveCreatedTs > nowTs)) {
    return 'archive creation clock is before its bars or in the future';
  }
  if (value.evidenceDigest !== canonicalDigest(evidenceCore(value))) return 'candle evidence digest mismatch';
  return null;
}

export function sealOpportunityAuditCandleEvidence(input = {}) {
  if (!isPlainObject(input) || exactKeys(input, [
    'canonicalCoin', 'sourceKind', 'sourceId', 'archiveDigest', 'archiveCreatedTs', 'bars',
  ]) !== null) fail('EVIDENCE_INVALID', 'input shape malformed');
  const core = {
    evidenceVersion: OPPORTUNITY_AUDIT_CANDLE_EVIDENCE_VERSION,
    canonicalCoin: input.canonicalCoin, intervalMs: MINUTE_MS,
    sourceKind: input.sourceKind, sourceId: input.sourceId,
    archiveDigest: input.archiveDigest, archiveCreatedTs: input.archiveCreatedTs,
    bars: clone(input.bars),
  };
  const evidence = { ...core, evidenceDigest: canonicalDigest(core) };
  const error = opportunityAuditCandleEvidenceError(evidence);
  if (error) fail('EVIDENCE_INVALID', error);
  return deepFreeze(evidence);
}

function actionPropensityError(value) {
  return !exact(value, ['state', 'value', 'policyVersion']) || value.state !== 'NOT_LOGGED'
    || value.value !== null || value.policyVersion !== null;
}

function marketError(value) {
  return !exact(value, MARKET_KEYS) || !text(value.pairKey, 40) || !text(value.nativeBase, 20)
    || !text(value.nativeQuote, 20) || !text(value.wsname, 40) || !isCoin(value.base)
    || value.quote !== 'USD' || value.status !== 'online';
}

export function opportunityAuditPendingItemV2Error(item) {
  if (!exact(item, PENDING_ITEM_V2_KEYS) || item.itemVersion !== OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2
      || item.frameVersion !== OPPORTUNITY_AUDIT_FRAME_VERSION_V2 || !text(item.cursor, 2_000)
      || !/^oaf-[a-f0-9]{40}$/.test(item.frameId ?? '') || !HEX64_RE.test(item.frameDigest ?? '')
      || !isTs(item.frameTs) || item.captureRecipeVersion !== OPPORTUNITY_AUDIT_CAPTURE_RECIPE_VERSION_V2
      || item.targetVersion !== OPPORTUNITY_AUDIT_TARGET_VERSION_V2
      || !HEX64_RE.test(item.targetDigest ?? '') || !/^lop-[a-f0-9]{40}$/.test(item.opportunityId ?? '')
      || !HEX64_RE.test(item.marketIdentityDigest ?? '') || marketError(item.market)
      || item.marketIdentityDigest !== canonicalDigest({ venue: 'kraken', quote: 'USD', policyVersion: 1, market: item.market })
      || !Number.isSafeInteger(item.horizonMs) || item.horizonMs <= 0
      || item.horizonMs > OPPORTUNITY_AUDIT_MAX_TARGET_HORIZON_MS_V2 || !isTs(item.dueTs)
      || !Number.isSafeInteger(item.maxLabelDelayMs) || item.maxLabelDelayMs < OPPORTUNITY_AUDIT_MIN_LABEL_DELAY_MS
      || item.maxLabelDelayMs > OPPORTUNITY_AUDIT_MAX_LABEL_DELAY_MS || !isTs(item.deadlineTs)
      || item.dueTs !== item.frameTs + item.horizonMs
      || item.deadlineTs !== item.dueTs + item.maxLabelDelayMs
      || !(item.lastOutcomeId === null || /^oao-[a-f0-9]{40}$/.test(item.lastOutcomeId ?? ''))
      || !(item.lastStatus === null || item.lastStatus === 'PENDING') || typeof item.annotationPresent !== 'boolean'
      || typeof item.observationInclusionProbability !== 'number' || item.observationInclusionProbability <= 0
      || item.observationInclusionProbability > 1 || actionPropensityError(item.actionPropensity)) {
    return 'V2 pending item shape, identity, timing or probability malformed';
  }
  return null;
}

export function opportunityAuditPendingItemV2(frame, item) {
  if (auditFrameError(frame) || frame.frameVersion !== OPPORTUNITY_AUDIT_FRAME_VERSION_V2
      || !exact(item, PENDING_ITEM_V1_KEYS) || item.frameId !== frame.frameId
      || item.frameDigest !== frame.frameDigest) fail('SETTLEMENT_INVALID', 'cannot enrich a non-V2 pending target');
  const entry = frame.population.find((row) => row.selected && row.opportunityId === item.opportunityId) ?? null;
  const timing = opportunityAuditTargetTiming(frame, item.horizonMs);
  if (!entry || !timing || item.canonicalCoin !== entry.market.base || item.dueTs !== timing.dueTs
      || item.observationInclusionProbability !== entry.observationInclusionProbability
      || !same(item.actionPropensity, entry.actionPropensity)) fail('SETTLEMENT_INVALID', 'pending target disagrees with its V2 frame');
  const enriched = {
    itemVersion: OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2,
    cursor: item.cursor, frameVersion: frame.frameVersion, frameId: frame.frameId, frameDigest: frame.frameDigest,
    frameTs: frame.frameTs, captureRecipeVersion: frame.captureRecipeVersion,
    targetVersion: frame.target.targetVersion, targetDigest: canonicalDigest(frame.target),
    opportunityId: item.opportunityId, marketIdentityDigest: entry.marketIdentityDigest, market: clone(entry.market),
    horizonMs: item.horizonMs, dueTs: timing.dueTs, maxLabelDelayMs: timing.maxLabelDelayMs,
    deadlineTs: timing.deadlineTs, lastOutcomeId: item.lastOutcomeId, lastStatus: item.lastStatus,
    annotationPresent: item.annotationPresent,
    observationInclusionProbability: item.observationInclusionProbability, actionPropensity: clone(item.actionPropensity),
  };
  const error = opportunityAuditPendingItemV2Error(enriched);
  if (error) fail('SETTLEMENT_INVALID', error);
  return deepFreeze(enriched);
}

function recordError(record) {
  return !exact(record, RECORD_KEYS) || !isId(record.recordId) || !HEX64_RE.test(record.recordDigest ?? '')
    || !isTs(record.periodStartTs) || record.periodStartTs % MINUTE_MS !== 0
    || record.periodEndTs !== record.periodStartTs + MINUTE_MS || !isTs(record.knownAtTs)
    || record.knownAtTs < record.periodEndTs || typeof record.close !== 'number'
    || !Number.isFinite(record.close) || record.close <= 0;
}

function datasetError(row, item, asOfTs) {
  return !exact(row, DATASET_KEYS) || row.datasetVersion !== 'broad-day-dataset-v1'
    || !isId(row.datasetId) || !HEX64_RE.test(row.datasetDigest ?? '') || !isTs(row.dayStartTs)
    || !isTs(row.dayEndTs) || row.dayEndTs <= row.dayStartTs || !isTs(row.asOfTs) || row.asOfTs > asOfTs
    || !HEX64_RE.test(row.sourceRootDigest ?? '') || !HEX64_RE.test(row.catalogEpochDigest ?? '')
    || row.sourceMarketIdentityDigest !== item.marketIdentityDigest;
}

function manifestError(value, item, sourceBinding, records, asOfTs) {
  const window = expectedWindow({ frameTs: item.frameTs }, item.horizonMs);
  if (!exact(value, MANIFEST_KEYS) || value.manifestVersion !== 'opportunity-audit-broad-day-manifest-1'
      || !/^oabdm-[a-f0-9]{40}$/.test(value.manifestId ?? '') || !HEX64_RE.test(value.manifestDigest ?? '')
      || value.sourceBindingDigest !== canonicalDigest(sourceBinding) || !Array.isArray(value.readerDatasets)
      || value.readerDatasets.length < 1 || value.readerDatasets.length > 2
      || !isTs(value.requestedWindowStartTs) || !isTs(value.requestedWindowEndTs)
      || window === null || value.requestedWindowStartTs !== window.anchorOpenTs
      || value.requestedWindowEndTs !== window.terminalOpenTs + MINUTE_MS
      || value.sourceMarketIdentityDigest !== item.marketIdentityDigest
      || !HEX64_RE.test(value.catalogMembershipDigest ?? '') || value.recordCount !== records.length
      || value.recordInventoryDigest !== canonicalDigest(records)) return 'broad-day manifest shape or content binding malformed';
  for (let index = 0; index < value.readerDatasets.length; index += 1) {
    if (datasetError(value.readerDatasets[index], item, asOfTs)) return 'broad-day manifest dataset malformed';
    if (value.readerDatasets[index].sourceRootDigest !== sourceBinding.sourceRootDigest) return 'broad-day dataset belongs to another source root';
    if (index > 0 && canonicalJson(value.readerDatasets[index - 1]) >= canonicalJson(value.readerDatasets[index])) return 'broad-day manifest datasets are not canonically ordered';
  }
  const core = clone(value); delete core.manifestId; delete core.manifestDigest;
  if (value.manifestId !== digest40('oabdm', core)
      || value.manifestDigest !== canonicalDigest({ ...core, manifestId: value.manifestId })) return 'broad-day manifest digest mismatch';
  return null;
}

function sourceReceiptCore(value) {
  const copy = clone(value); delete copy.receiptId; delete copy.receiptDigest; return copy;
}

export function sealOpportunityAuditBroadDayManifest({ item, sourceBinding, readerDatasets, catalogMembershipDigest, records } = {}) {
  if (opportunityAuditPendingItemV2Error(item) || !exact(sourceBinding, SOURCE_BINDING_KEYS)
      || !Array.isArray(readerDatasets) || readerDatasets.length < 1 || readerDatasets.length > 2
      || !HEX64_RE.test(catalogMembershipDigest ?? '') || !Array.isArray(records)
      || records.length > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS || records.some(recordError)) {
    fail('SOURCE_RECEIPT_INVALID', 'broad-day manifest input malformed');
  }
  const datasets = clone(readerDatasets).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const window = expectedWindow({ frameTs: item.frameTs }, item.horizonMs);
  const inventory = clone(records);
  const core = {
    manifestVersion: 'opportunity-audit-broad-day-manifest-1', sourceBindingDigest: canonicalDigest(sourceBinding),
    readerDatasets: datasets, requestedWindowStartTs: window.anchorOpenTs,
    requestedWindowEndTs: window.terminalOpenTs + MINUTE_MS,
    sourceMarketIdentityDigest: item.marketIdentityDigest, catalogMembershipDigest,
    recordCount: inventory.length, recordInventoryDigest: canonicalDigest(inventory),
  };
  const manifestId = digest40('oabdm', core);
  const manifest = { ...core, manifestId, manifestDigest: canonicalDigest({ ...core, manifestId }) };
  const error = manifestError(manifest, item, sourceBinding, inventory, Math.max(...datasets.map((row) => row.asOfTs)));
  if (error) fail('SOURCE_RECEIPT_INVALID', error);
  return deepFreeze(manifest);
}

export function opportunityAuditBroadDaySourceReceiptError(value, { item, asOfTs, evidence = null } = {}) {
  const itemError = opportunityAuditPendingItemV2Error(item); if (itemError) return itemError;
  if (!exact(value, SOURCE_RECEIPT_KEYS) || value.receiptVersion !== OPPORTUNITY_AUDIT_BROAD_DAY_SOURCE_RECEIPT_VERSION
      || !/^oasrc-[a-f0-9]{40}$/.test(value.receiptId ?? '') || !HEX64_RE.test(value.receiptDigest ?? '')
      || value.requestDigest !== canonicalDigest({ requestVersion: 'opportunity-audit-source-request-2', item, asOfTs })
      || value.frameId !== item.frameId || value.frameDigest !== item.frameDigest || value.targetDigest !== item.targetDigest
      || value.opportunityId !== item.opportunityId || value.marketIdentityDigest !== item.marketIdentityDigest
      || !same(value.market, item.market) || value.horizonMs !== item.horizonMs || value.dueTs !== item.dueTs
      || value.maxLabelDelayMs !== item.maxLabelDelayMs || value.deadlineTs !== item.deadlineTs
      || !isTs(value.anchorOpenTs) || !isTs(value.terminalOpenTs)
      || value.terminalCloseTs !== value.terminalOpenTs + MINUTE_MS || !isTs(asOfTs)
      || value.asOfTs !== asOfTs || !isTs(value.preparedTs) || value.preparedTs < asOfTs
      || !['AVAILABLE', 'MISSING', 'DELISTED_OR_UNAVAILABLE'].includes(value.resolutionState)
      || !(value.resolutionReason === null || text(value.resolutionReason))
      || !exact(value.sourceBinding, SOURCE_BINDING_KEYS)
      || value.sourceBinding.bindingVersion !== 'broad-day-local-source-binding-1'
      || !isId(value.sourceBinding.sourceId) || !HEX64_RE.test(value.sourceBinding.sourceRootDigest ?? '')
      || value.sourceBinding.archiveVersion !== 'broad-day-archive-v2'
      || value.sourceBinding.durability !== 'LOCAL_FILESYSTEM_ONLY' || value.sourceBinding.republishSafe !== false
      || !Number.isSafeInteger(value.recordCount) || value.recordCount < 0 || value.recordCount > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS
      || !HEX64_RE.test(value.recordInventoryDigest ?? '')
      || !(value.anchorRecord === null || !recordError(value.anchorRecord))
      || !(value.terminalRecord === null || !recordError(value.terminalRecord))
      || value.valueLaw !== 'SIMPLE_RETURN_PCT_FROM_FIRST_AND_LAST_VERIFIED_CLOSED_1M_CLOSES'
      || value.authority !== 'NONE' || value.trainingAuthority !== 'NONE') return 'broad-day source receipt shape, request or timing malformed';
  if (value.resolutionState === 'AVAILABLE') {
    const evidenceError = opportunityAuditCandleEvidenceError(evidence, { nowTs: value.preparedTs });
    if (evidenceError || value.resolutionReason !== null || value.archiveManifest === null
        || value.recordCount !== evidence.bars.length || value.evidenceDigest !== evidence.evidenceDigest
        || value.anchorRecord === null || value.terminalRecord === null
        || value.anchorOpenTs !== evidence.bars[0].openTs || value.terminalOpenTs !== evidence.bars.at(-1).openTs
        || value.anchorRecord.periodStartTs !== value.anchorOpenTs || value.terminalRecord.periodStartTs !== value.terminalOpenTs
        || value.anchorRecord.close !== evidence.bars[0].close || value.terminalRecord.close !== evidence.bars.at(-1).close
        || value.anchorRecord.knownAtTs !== evidence.bars[0].knownAtTs || value.terminalRecord.knownAtTs !== evidence.bars.at(-1).knownAtTs) {
      return 'available source receipt disagrees with exact candle evidence';
    }
  } else if (!text(value.resolutionReason) || value.evidenceDigest !== null
      || value.asOfTs <= item.deadlineTs || value.preparedTs <= item.deadlineTs) {
    return 'terminal missingness lacks a post-deadline source receipt';
  }
  if (value.archiveManifest === null) {
    if (value.resolutionState === 'AVAILABLE' || value.recordCount !== 0 || value.recordInventoryDigest !== canonicalDigest([])
        || value.anchorRecord !== null || value.terminalRecord !== null) return 'missing manifest invents retained records';
  } else {
    // The manifest binds the full retained inventory. The compact receipt keeps
    // only its count/digest and boundary records; independent replay requires
    // the named LOCAL_FILESYSTEM_ONLY datasets.
    const window = expectedWindow({ frameTs: item.frameTs }, item.horizonMs);
    if (!exact(value.archiveManifest, MANIFEST_KEYS) || !Array.isArray(value.archiveManifest.readerDatasets)
        || value.archiveManifest.readerDatasets.length < 1 || value.archiveManifest.readerDatasets.length > 2
        || window === null || value.archiveManifest.requestedWindowStartTs !== window.anchorOpenTs
        || value.archiveManifest.requestedWindowEndTs !== window.terminalOpenTs + MINUTE_MS
        || value.archiveManifest.recordCount !== value.recordCount
        || value.archiveManifest.recordInventoryDigest !== value.recordInventoryDigest
        || value.archiveManifest.sourceMarketIdentityDigest !== item.marketIdentityDigest
        || value.archiveManifest.sourceBindingDigest !== canonicalDigest(value.sourceBinding)) return 'source receipt manifest binding malformed';
    const manifestCore = clone(value.archiveManifest); delete manifestCore.manifestId; delete manifestCore.manifestDigest;
    if (value.archiveManifest.manifestId !== digest40('oabdm', manifestCore)
        || value.archiveManifest.manifestDigest !== canonicalDigest({ ...manifestCore, manifestId: value.archiveManifest.manifestId })) return 'source receipt manifest digest mismatch';
    for (let index = 0; index < value.archiveManifest.readerDatasets.length; index += 1) {
      const row = value.archiveManifest.readerDatasets[index];
      if (datasetError(row, item, asOfTs)
          || row.sourceRootDigest !== value.sourceBinding.sourceRootDigest
          || (index > 0 && canonicalJson(value.archiveManifest.readerDatasets[index - 1]) >= canonicalJson(row))) return 'source receipt manifest dataset malformed';
    }
  }
  const core = sourceReceiptCore(value);
  if (value.receiptId !== digest40('oasrc', core)
      || value.receiptDigest !== canonicalDigest({ ...core, receiptId: value.receiptId })) return 'broad-day source receipt digest mismatch';
  return null;
}

export function sealOpportunityAuditBroadDaySourceReceipt(input = {}) {
  const keys = ['item', 'asOfTs', 'preparedTs', 'resolutionState', 'resolutionReason', 'sourceBinding', 'archiveManifest', 'records', 'evidence'];
  if (!exact(input, keys) || opportunityAuditPendingItemV2Error(input.item) || !isTs(input.asOfTs)
      || !isTs(input.preparedTs) || input.preparedTs < input.asOfTs || !Array.isArray(input.records)
      || input.records.length > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS || input.records.some(recordError)) fail('SOURCE_RECEIPT_INVALID', 'source receipt input malformed');
  for (let index = 1; index < input.records.length; index += 1) {
    if (input.records[index].periodStartTs <= input.records[index - 1].periodStartTs) fail('SOURCE_RECEIPT_INVALID', 'source records duplicated or reordered');
  }
  const records = clone(input.records); const item = clone(input.item); const sourceBinding = clone(input.sourceBinding);
  if (input.archiveManifest !== null) {
    const error = manifestError(input.archiveManifest, item, sourceBinding, records, input.asOfTs);
    if (error) fail('SOURCE_RECEIPT_INVALID', error);
  }
  const window = expectedWindow({ frameTs: item.frameTs }, item.horizonMs);
  if (window === null) fail('SOURCE_RECEIPT_INVALID', 'target window malformed');
  const core = {
    receiptVersion: OPPORTUNITY_AUDIT_BROAD_DAY_SOURCE_RECEIPT_VERSION,
    requestDigest: canonicalDigest({ requestVersion: 'opportunity-audit-source-request-2', item, asOfTs: input.asOfTs }),
    frameId: item.frameId, frameDigest: item.frameDigest, targetDigest: item.targetDigest,
    opportunityId: item.opportunityId, marketIdentityDigest: item.marketIdentityDigest, market: clone(item.market),
    horizonMs: item.horizonMs, dueTs: item.dueTs, maxLabelDelayMs: item.maxLabelDelayMs, deadlineTs: item.deadlineTs,
    anchorOpenTs: window.anchorOpenTs, terminalOpenTs: window.terminalOpenTs,
    terminalCloseTs: window.terminalOpenTs + MINUTE_MS, asOfTs: input.asOfTs, preparedTs: input.preparedTs,
    resolutionState: input.resolutionState, resolutionReason: input.resolutionReason,
    sourceBinding, archiveManifest: input.archiveManifest === null ? null : clone(input.archiveManifest),
    recordCount: records.length, recordInventoryDigest: canonicalDigest(records),
    anchorRecord: records.length === 0 ? null : clone(records[0]), terminalRecord: records.length === 0 ? null : clone(records.at(-1)),
    evidenceDigest: input.evidence === null ? null : input.evidence.evidenceDigest,
    valueLaw: 'SIMPLE_RETURN_PCT_FROM_FIRST_AND_LAST_VERIFIED_CLOSED_1M_CLOSES',
    authority: 'NONE', trainingAuthority: 'NONE',
  };
  const receiptId = digest40('oasrc', core);
  const receipt = { ...core, receiptId, receiptDigest: canonicalDigest({ ...core, receiptId }) };
  const error = opportunityAuditBroadDaySourceReceiptError(receipt, { item, asOfTs: input.asOfTs, evidence: input.evidence });
  if (error) fail('SOURCE_RECEIPT_INVALID', error);
  return deepFreeze(receipt);
}

function expectedWindow(frame, horizonMs) {
  const anchorOpenTs = Math.ceil(frame.frameTs / MINUTE_MS) * MINUTE_MS;
  const dueTs = frame.frameTs + horizonMs;
  const terminalOpenTs = Math.floor(dueTs / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  if (!Number.isSafeInteger(dueTs) || terminalOpenTs < anchorOpenTs) return null;
  const count = ((terminalOpenTs - anchorOpenTs) / MINUTE_MS) + 1;
  return Number.isSafeInteger(count) && count > 0 && count <= OPPORTUNITY_AUDIT_FOLLOWUP_MAX_BARS
    ? { anchorOpenTs, terminalOpenTs, dueTs, count } : null;
}

function entryOf(frame, opportunityId) {
  return frame.population.find((entry) => entry.selected && entry.opportunityId === opportunityId) ?? null;
}

function resolutionError(resolution, frame, entry, horizonMs, recordedTs, { item = null, asOfTs = null } = {}) {
  if (!isPlainObject(resolution) || !text(resolution.state, 40)) return 'resolution shape malformed';
  if (frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2) {
    if (opportunityAuditPendingItemV2Error(item) || !isTs(asOfTs) || !exact(resolution, V2_RESOLUTION_KEYS)
        || !['AVAILABLE', 'PENDING', 'REFUSED', 'MISSING', 'DELISTED_OR_UNAVAILABLE'].includes(resolution.state)
        || !(resolution.reasonCode === null || text(resolution.reasonCode))
        || !isTs(resolution.preparedTs) || resolution.preparedTs < asOfTs || resolution.preparedTs > recordedTs) {
      return 'V2 resolution shape, state or prepared clock malformed';
    }
    if (resolution.state === 'PENDING' || resolution.state === 'REFUSED') {
      return text(resolution.reasonCode) && resolution.sourceReceipt === null && resolution.evidence === null
        ? null : 'V2 pending/refused resolution invents source custody';
    }
    if (resolution.sourceReceipt === null) return 'V2 terminal/available resolution lacks its exact source receipt';
    const receiptError = opportunityAuditBroadDaySourceReceiptError(resolution.sourceReceipt, {
      item, asOfTs, evidence: resolution.evidence,
    });
    if (receiptError || resolution.sourceReceipt.preparedTs !== resolution.preparedTs
        || resolution.sourceReceipt.resolutionState !== resolution.state
        || resolution.sourceReceipt.resolutionReason !== resolution.reasonCode) return receiptError ?? 'V2 resolution disagrees with source receipt';
    if (resolution.state === 'AVAILABLE') {
      const error = opportunityAuditCandleEvidenceError(resolution.evidence, { nowTs: resolution.preparedTs });
      if (error) return error;
      if (resolution.reasonCode !== null || resolution.evidence.canonicalCoin !== entry.market.base) return 'V2 available evidence identity malformed';
      const window = expectedWindow(frame, horizonMs);
      if (window === null || resolution.evidence.bars.length !== window.count
          || resolution.evidence.bars[0].openTs !== window.anchorOpenTs
          || resolution.evidence.bars.at(-1).openTs !== window.terminalOpenTs) return 'V2 candle evidence does not exactly cover the target window';
      return null;
    }
    return resolution.evidence === null && asOfTs > item.deadlineTs && resolution.preparedTs > item.deadlineTs
      ? null : 'V2 missingness is premature or invents outcome evidence';
  }
  if (resolution.state === 'AVAILABLE') {
    if (!exact(resolution, RESOLUTION_KEYS.AVAILABLE)) return 'available resolution shape malformed';
    const error = opportunityAuditCandleEvidenceError(resolution.evidence, { nowTs: recordedTs });
    if (error) return error;
    if (resolution.evidence.canonicalCoin !== entry.market.base) return 'outcome evidence belongs to another market';
    const window = expectedWindow(frame, horizonMs);
    if (window === null || resolution.evidence.bars.length !== window.count
        || resolution.evidence.bars[0].openTs !== window.anchorOpenTs
        || resolution.evidence.bars.at(-1).openTs !== window.terminalOpenTs) {
      return 'candle evidence does not exactly cover the predeclared target window';
    }
    return null;
  }
  if (resolution.state === 'PENDING' || resolution.state === 'REFUSED') {
    return exact(resolution, RESOLUTION_KEYS[resolution.state]) && text(resolution.reasonCode)
      ? null : `${resolution.state.toLowerCase()} resolution shape malformed`;
  }
  if (!TERMINAL_STATES.has(resolution.state) || !exact(resolution, RESOLUTION_KEYS.TERMINAL)
      || !text(resolution.reasonCode) || !isTs(resolution.knownAtTs)
      || resolution.knownAtTs < frame.frameTs + horizonMs || resolution.knownAtTs > recordedTs
      || sourceReferenceError(resolution.sourceReference)) return 'terminal missingness resolution malformed or unbound';
  return null;
}

export function buildOpportunityAuditFollowup({ frame, opportunityId, horizonMs, resolution, recordedTs, supersedes = null, item = null, asOfTs = null } = {}) {
  if (auditFrameError(frame) || !isTs(recordedTs) || !Number.isSafeInteger(horizonMs)
      || !frame.horizonsMs.includes(horizonMs)) fail('SETTLEMENT_INVALID', 'frame, horizon or recorded clock malformed');
  const entry = entryOf(frame, opportunityId);
  if (entry === null) fail('SETTLEMENT_INVALID', 'opportunity is not selected by this frame');
  let requestItem = item;
  if (frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2 && opportunityAuditPendingItemV2Error(requestItem)) {
    fail('SETTLEMENT_INVALID', 'V2 settlement requires its exact enriched pending request');
  }
  const copied = clone(resolution);
  const error = resolutionError(copied, frame, entry, horizonMs, recordedTs, { item: requestItem, asOfTs });
  if (error) fail('SETTLEMENT_INVALID', error);
  if (copied.state === 'PENDING' || copied.state === 'REFUSED') {
    return deepFreeze({ state: copied.state, reasonCode: copied.reasonCode, outcome: null });
  }
  let status = copied.state; let outcomeKnownAtTs; let outcome = null; let missingReason = null; let sourceReference;
  if (copied.state === 'AVAILABLE') {
    status = 'MATURED';
    const bars = copied.evidence.bars;
    const returnPct = ((bars.at(-1).close / bars[0].close) - 1) * 100;
    outcomeKnownAtTs = frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2
      ? copied.preparedTs : Math.max(copied.evidence.archiveCreatedTs, ...bars.map((bar) => bar.knownAtTs));
    sourceReference = frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2
      ? { sourceKind: copied.evidence.sourceKind, sourceId: copied.sourceReceipt.sourceBinding.sourceId, sourceDigest: copied.sourceReceipt.receiptDigest }
      : { sourceKind: copied.evidence.sourceKind, sourceId: copied.evidence.sourceId, sourceDigest: copied.evidence.evidenceDigest };
    outcome = {
      outcomeClass: returnPct > frame.target.neutralBandPct ? 'FAVORABLE'
        : returnPct < -frame.target.neutralBandPct ? 'ADVERSE' : 'NEUTRAL',
      returnPct, evidenceDigest: copied.evidence.evidenceDigest,
    };
  } else {
    outcomeKnownAtTs = frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2 ? copied.preparedTs : copied.knownAtTs;
    missingReason = copied.reasonCode;
    sourceReference = frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2
      ? { sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: copied.sourceReceipt.sourceBinding.sourceId, sourceDigest: copied.sourceReceipt.receiptDigest }
      : copied.sourceReference;
  }
  const attachment = attachAuditOutcome({
    frame, opportunityId, horizonMs, status, recordedTs, outcomeKnownAtTs,
    outcome, missingReason, sourceReference, supersedes,
    ...(frame.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2 ? { settlementSourceReceipt: copied.sourceReceipt } : {}),
  });
  const attachmentError = auditOutcomeError(attachment, frame);
  if (attachmentError) fail('SETTLEMENT_INVALID', attachmentError);
  return deepFreeze({ state: status, reasonCode: null, outcome: attachment });
}

function outcomeDigestError(outcome, item, state, recordedTs) {
  if (!isPlainObject(outcome) || outcome.frameId !== item.frameId || outcome.frameDigest !== item.frameDigest
      || outcome.opportunityId !== item.opportunityId || outcome.horizonMs !== item.horizonMs
      || outcome.status !== state || outcome.recordedTs !== recordedTs
      || !/^oao-[a-f0-9]{40}$/.test(outcome.outcomeId ?? '') || !HEX64_RE.test(outcome.outcomeDigest ?? '')) return 'settlement outcome identity malformed';
  const core = clone(outcome); delete core.outcomeId; delete core.outcomeDigest;
  return outcome.outcomeId === digest40('oao', core)
    && outcome.outcomeDigest === canonicalDigest({ ...core, outcomeId: outcome.outcomeId })
    ? null : 'settlement outcome digest mismatch';
}

function settlementReceiptCore(value) {
  const copy = clone(value); delete copy.receiptId; delete copy.receiptDigest; return copy;
}

export function opportunityAuditSettlementReceiptV2Error(receipt, { item, resolution, recordedTs } = {}) {
  const itemError = opportunityAuditPendingItemV2Error(item); if (itemError) return itemError;
  if (!exact(receipt, SETTLEMENT_RECEIPT_KEYS) || receipt.receiptVersion !== OPPORTUNITY_AUDIT_SETTLEMENT_RECEIPT_VERSION_V2
      || !/^oasr-[a-f0-9]{40}$/.test(receipt.receiptId ?? '') || !HEX64_RE.test(receipt.receiptDigest ?? '')
      || receipt.requestDigest !== canonicalDigest({ requestVersion: 'opportunity-audit-settlement-request-2', item, resolution, recordedTs })
      || receipt.itemDigest !== canonicalDigest(item) || receipt.resolutionDigest !== canonicalDigest(resolution)
      || receipt.frameId !== item.frameId || receipt.frameDigest !== item.frameDigest
      || receipt.opportunityId !== item.opportunityId || receipt.horizonMs !== item.horizonMs
      || receipt.dueTs !== item.dueTs || receipt.deadlineTs !== item.deadlineTs || receipt.recordedTs !== recordedTs
      || !isTs(recordedTs) || !isTs(resolution?.preparedTs) || resolution.preparedTs > recordedTs
      || !['MATURED', 'MISSING', 'DELISTED_OR_UNAVAILABLE', 'PENDING', 'REFUSED'].includes(receipt.state)
      || !exact(receipt.readback, READBACK_KEYS) || receipt.readback.frameId !== item.frameId
      || receipt.readback.frameDigest !== item.frameDigest || !Number.isSafeInteger(receipt.readback.storeRevision)
      || receipt.readback.storeRevision < 0 || typeof receipt.durableOutcome !== 'boolean'
      || receipt.authority !== 'NONE' || receipt.trainingAuthority !== 'NONE') return 'V2 settlement receipt shape, request or readback malformed';
  if (!same(receipt.sourceReceipt, resolution?.sourceReceipt ?? null)) return 'settlement receipt lost exact source content';
  if (receipt.state === 'PENDING' || receipt.state === 'REFUSED') {
    if (receipt.state !== resolution?.state || receipt.outcome !== null || receipt.sourceReceipt !== null
        || receipt.durableOutcome !== false || receipt.readback.outcomeId !== null
        || receipt.readback.outcomeDigest !== null) return 'nonterminal settlement receipt invents durable outcome custody';
  } else {
    const expected = resolution?.state === 'AVAILABLE' ? 'MATURED' : resolution?.state;
    const outcomeError = outcomeDigestError(receipt.outcome, item, receipt.state, recordedTs);
    if (receipt.state !== expected || outcomeError || receipt.durableOutcome !== true
        || receipt.readback.outcomeId !== receipt.outcome.outcomeId
        || receipt.readback.outcomeDigest !== receipt.outcome.outcomeDigest) return outcomeError ?? 'terminal settlement receipt/readback mismatch';
    const sourceError = opportunityAuditBroadDaySourceReceiptError(receipt.sourceReceipt, {
      item, asOfTs: receipt.sourceReceipt?.asOfTs, evidence: resolution.evidence,
    });
    if (sourceError) return sourceError;
  }
  const core = settlementReceiptCore(receipt);
  if (receipt.receiptId !== digest40('oasr', core)
      || receipt.receiptDigest !== canonicalDigest({ ...core, receiptId: receipt.receiptId })) return 'V2 settlement receipt digest mismatch';
  return null;
}

export function sealOpportunityAuditSettlementReceiptV2({ item, resolution, recordedTs, outcome, readback } = {}) {
  if (opportunityAuditPendingItemV2Error(item) || !isTs(recordedTs) || !exact(readback, READBACK_KEYS)) {
    fail('DURABLE_ACK_INVALID', 'settlement receipt input malformed');
  }
  const state = resolution.state === 'AVAILABLE' ? 'MATURED' : resolution.state;
  const core = {
    receiptVersion: OPPORTUNITY_AUDIT_SETTLEMENT_RECEIPT_VERSION_V2,
    requestDigest: canonicalDigest({ requestVersion: 'opportunity-audit-settlement-request-2', item, resolution, recordedTs }),
    itemDigest: canonicalDigest(item), resolutionDigest: canonicalDigest(resolution),
    frameId: item.frameId, frameDigest: item.frameDigest, opportunityId: item.opportunityId,
    horizonMs: item.horizonMs, dueTs: item.dueTs, deadlineTs: item.deadlineTs, recordedTs,
    state, sourceReceipt: resolution.sourceReceipt === null ? null : clone(resolution.sourceReceipt),
    outcome: outcome === null ? null : clone(outcome), readback: clone(readback),
    durableOutcome: outcome !== null, authority: 'NONE', trainingAuthority: 'NONE',
  };
  const receiptId = digest40('oasr', core);
  const receipt = { ...core, receiptId, receiptDigest: canonicalDigest({ ...core, receiptId }) };
  const error = opportunityAuditSettlementReceiptV2Error(receipt, { item, resolution, recordedTs });
  if (error) fail('DURABLE_ACK_INVALID', error);
  return deepFreeze(receipt);
}

function validateOwner({ store, outcomeSource, clock, maxPerStep }) {
  if (!store || typeof store !== 'object') fail('CONFIG_INVALID', 'store missing');
  const workerCustody = typeof store.settle === 'function';
  for (const method of workerCustody ? ['pending', 'settle', 'status'] : ['pending', 'loadFrame', 'appendOutcome', 'status']) {
    if (typeof store[method] !== 'function') fail('CONFIG_INVALID', `store.${method} missing`);
  }
  if (typeof outcomeSource !== 'function' || typeof clock !== 'function'
      || !Number.isSafeInteger(maxPerStep) || maxPerStep < 1 || maxPerStep > OPPORTUNITY_AUDIT_FOLLOWUP_MAX_PER_STEP) {
    fail('CONFIG_INVALID', 'source, clock or work bound malformed');
  }
}

async function boundedSourceCall(outcomeSource, request, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OpportunityAuditFollowupError('SOURCE_TIMEOUT')), timeoutMs);
  });
  const call = Promise.resolve().then(() => outcomeSource(request));
  // A timed-out source is untrusted and receives only immutable detached input.
  // Consume any late rejection; its late success is never submitted to custody.
  call.catch(() => {});
  try { return await Promise.race([call, timeout]); }
  finally { clearTimeout(timer); }
}

export function createOpportunityAuditFollowup({
  store, outcomeSource, clock = () => Date.now(), maxPerStep = 32, sourceTimeoutMs = 5_000,
} = {}) {
  validateOwner({ store, outcomeSource, clock, maxPerStep });
  if (!Number.isSafeInteger(sourceTimeoutMs) || sourceTimeoutMs < 1 || sourceTimeoutMs > 60_000) fail('CONFIG_INVALID', 'source timeout malformed');
  const workerCustody = typeof store.settle === 'function';
  let cursor = null; let inFlight = null; let closing = false; let closed = false; let closePromise = null;
  let steps = 0; let matured = 0; let terminalMissing = 0; let pending = 0; let refused = 0; let deferred = 0;
  let last = null; let failed = null;

  const run = async (nowTs) => {
    const page = await store.pending({ asOfTs: nowTs, limit: maxPerStep, cursor });
    if (!page || !Array.isArray(page.items) || typeof page.truncated !== 'boolean') fail('STORE_VIEW_INVALID', 'pending page malformed');
    const report = { state: 'COMPLETE', considered: page.items.length, matured: 0, terminalMissing: 0, pending: 0, refused: 0, deferred: 0 };
    for (const original of page.items) {
      if (closing) { report.state = 'INTERRUPTED'; break; }
      const item = deepFreeze(clone(original));
      let view = null; let annotation = null;
      if (!workerCustody) {
        view = await store.loadFrame(item.frameId);
        if (!view || view.frame?.frameDigest !== item.frameDigest || auditFrameError(view.frame)) fail('STORE_VIEW_INVALID', 'pending target lost its frame');
        annotation = view.annotations.find((row) => row.opportunityId === item.opportunityId) ?? null;
        if (annotation === null) { report.refused += 1; continue; }
      }
      const requestItem = view?.frame?.frameVersion === OPPORTUNITY_AUDIT_FRAME_VERSION_V2
        ? opportunityAuditPendingItemV2(view.frame, item) : item;
      let resolution;
      try {
        resolution = await boundedSourceCall(outcomeSource, deepFreeze({
          followupVersion: requestItem.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2
            ? OPPORTUNITY_AUDIT_FOLLOWUP_VERSION_V2 : OPPORTUNITY_AUDIT_FOLLOWUP_VERSION,
          item: clone(requestItem), frame: view === null ? null : clone(view.frame),
          annotation: annotation === null ? null : clone(annotation), asOfTs: nowTs,
        }), sourceTimeoutMs);
      } catch {
        report.refused += 1; continue;
      }
      const recordedTs = clock();
      if (!isTs(recordedTs) || recordedTs < nowTs) fail('CLOCK_INVALID', 'settlement receipt clock predates its source request');
      if (workerCustody) {
        let receipt;
        try {
          receipt = await store.settle({
            item: clone(requestItem), resolution: clone(resolution),
            ...(requestItem.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2 ? { asOfTs: nowTs } : {}),
            recordedTs,
          });
        }
        catch (error) {
          if (TRANSIENT_CUSTODY_CODES.has(error?.code)) { report.deferred += 1; continue; }
          throw error;
        }
        if (requestItem.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2) {
          const receiptError = opportunityAuditSettlementReceiptV2Error(receipt, {
            item: requestItem, resolution, recordedTs,
          });
          if (receiptError) fail('DURABLE_ACK_INVALID', receiptError);
        } else if (!exact(receipt, ['state', 'outcomeId', 'outcomeDigest', 'storeRevision', 'durable'])
            || !['MATURED', 'MISSING', 'CENSORED', 'DELISTED_OR_UNAVAILABLE', 'UNSUPPORTED', 'PENDING', 'REFUSED'].includes(receipt.state)
            || !Number.isSafeInteger(receipt.storeRevision) || receipt.storeRevision < 0
            || typeof receipt.durable !== 'boolean'
            || (receipt.durable && (!/^oao-[a-f0-9]{40}$/.test(receipt.outcomeId ?? '') || !HEX64_RE.test(receipt.outcomeDigest ?? '')))
            || (!receipt.durable && !(receipt.outcomeId === null && receipt.outcomeDigest === null
              && ['PENDING', 'REFUSED'].includes(receipt.state)))) {
          fail('DURABLE_ACK_INVALID', 'worker custody returned an invalid legacy settlement receipt');
        }
        if (receipt.state === 'PENDING') report.pending += 1;
        else if (receipt.state === 'REFUSED') report.refused += 1;
        else if (receipt.state === 'MATURED') report.matured += 1;
        else report.terminalMissing += 1;
        continue;
      }
      let built;
      try {
        built = buildOpportunityAuditFollowup({
          frame: view.frame, opportunityId: item.opportunityId, horizonMs: item.horizonMs,
          resolution: clone(resolution), recordedTs, supersedes: item.lastOutcomeId,
          item: requestItem.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2 ? requestItem : null,
          asOfTs: requestItem.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2 ? nowTs : null,
        });
      } catch {
        report.refused += 1; continue;
      }
      if (built.state === 'PENDING') { report.pending += 1; continue; }
      if (built.state === 'REFUSED') { report.refused += 1; continue; }
      const acknowledged = await store.appendOutcome({
        frameId: view.frame.frameId, frameDigest: view.frame.frameDigest,
        expectedRevision: view.revision, outcome: built.outcome,
      });
      const durable = await store.loadFrame(view.frame.frameId);
      const stored = durable?.outcomes?.find((row) => row.outcomeId === built.outcome.outcomeId) ?? null;
      if (!stored || !same(stored, built.outcome) || acknowledged?.revision !== durable.revision) {
        fail('DURABLE_ACK_INVALID', 'outcome was not returned by exact durable readback');
      }
      if (built.state === 'MATURED') report.matured += 1; else report.terminalMissing += 1;
    }
    cursor = page.nextCursor ?? null;
    steps += 1; matured += report.matured; terminalMissing += report.terminalMissing;
    pending += report.pending; refused += report.refused; deferred += report.deferred;
    last = deepFreeze({ ...report, asOfTs: nowTs });
    return last;
  };

  const step = ({ nowTs = clock() } = {}) => {
    if (closing || closed) return Promise.reject(new OpportunityAuditFollowupError('FOLLOWUP_CLOSED'));
    if (failed) return Promise.reject(new OpportunityAuditFollowupError(failed.code, failed.message));
    if (!isTs(nowTs) || nowTs > clock()) return Promise.reject(new OpportunityAuditFollowupError('CLOCK_INVALID'));
    if (inFlight !== null) return Promise.resolve(deepFreeze({ state: 'BUSY', considered: 0, matured: 0, terminalMissing: 0, pending: 0, refused: 0, deferred: 1, asOfTs: nowTs }));
    const task = run(nowTs).catch((error) => {
      if (TRANSIENT_CUSTODY_CODES.has(error?.code)) {
        deferred += 1;
        last = deepFreeze({ state: 'BUSY', considered: 0, matured: 0, terminalMissing: 0, pending: 0, refused: 0, deferred: 1, asOfTs: nowTs });
        return last;
      }
      const stopped = error instanceof OpportunityAuditFollowupError
        ? error : new OpportunityAuditFollowupError('CUSTODY_FAILED', error?.code ?? error?.message ?? error);
      failed ??= stopped;
      throw stopped;
    }).finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task; return task;
  };

  const status = () => deepFreeze({
    followupVersion: OPPORTUNITY_AUDIT_FOLLOWUP_VERSION,
    state: closed ? 'STOPPED' : closing ? 'CLOSING' : failed ? 'FAILED' : inFlight ? 'RUNNING' : 'READY',
    inFlight: inFlight !== null, steps, matured, terminalMissing, pending, refused, deferred, last,
    failed: failed === null ? null : { code: failed.code, detail: String(failed.message).slice(0, 500) },
    maxPerStep, sourceTimeoutMs, authority: 'NONE', trainingAuthority: 'NONE',
    durability: 'INJECTED_STORE_ACK_AND_EXACT_READBACK', republishSafe: false,
  });

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => { try { if (inFlight) await inFlight; } finally { closed = true; } })();
    return closePromise;
  };
  return Object.freeze({ step, status, close });
}
