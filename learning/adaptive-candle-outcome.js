// Exact adapter from the repository's existing candle-label recipe to the
// adaptive core's one sealed 60m target. This module prepares a provenance
// receipt but does not persist it and does not call the adaptive store.
import {
  canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import { labelOpportunity } from './labels.js';
import {
  ADAPTIVE_CANDLE_OUTCOME_ADAPTER_VERSION,
  ADAPTIVE_CANDLE_RECEIPT_VERSION,
  ADAPTIVE_HORIZON_MS,
  adaptiveOutcomeError,
  adaptivePredictionError,
  adaptiveProcedureError,
} from './adaptive-registry.js';

export { ADAPTIVE_CANDLE_OUTCOME_ADAPTER_VERSION, ADAPTIVE_CANDLE_RECEIPT_VERSION };
export const ADAPTIVE_CANDLE_RECEIPT_DURABILITY = 'CALLER_MUST_ATOMICALLY_PERSIST_WITH_OUTCOME';

const HEX64 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const REASON = /^[A-Z0-9][A-Z0-9_:.-]{0,159}$/;
const RECEIPT_KEYS = Object.freeze([
  'receiptVersion', 'adapterVersion', 'receiptId', 'receiptDigest', 'procedureId',
  'procedureDigest', 'predictionId', 'predictionDigest', 'opportunityId',
  'targetEndTs', 'missingnessDeadlineTs', 'preparedTs', 'disposition',
  'dispositionReason', 'sourceIdentity', 'label', 'labelDigest', 'durability',
  'authority', 'purpose',
]);
const SOURCE_KEYS = Object.freeze([
  'state', 'manifestSha256', 'schemaVersion', 'childhoodVersion',
  'archiveCreatedTsMs', 'limitations',
]);
const LABEL_KEYS = Object.freeze([
  'rowId', 'labelRecipeVersion', 'canonicalCoin', 'decisionKnownAtTs',
  'anchorTsMs', 'anchorLagMs', 'sourceTrack', 'availability', 'reference',
  'horizon60m',
]);
const AVAILABILITY_KEYS = Object.freeze(['state', 'reason']);
const REFERENCE_KEYS = Object.freeze(['state', 'barOpenSec', 'price', 'knownAtTs']);
const HORIZON_KEYS = Object.freeze([
  'state', 'reason', 'horizonEndTs', 'outcomeKnownAtTs', 'mfePct', 'maePct',
  'logReturnPct', 'logReturnUnit',
]);
const SUBMISSION_KEYS = Object.freeze(['outcomeInput', 'provenanceReceipt']);
const OUTCOME_INPUT_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'state', 'logReturnPct', 'sourceEventTs',
  'knownAtTs', 'sourceDigest', 'reasonCode',
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (left, right) => canonicalDigest(left) === canonicalDigest(right);
const digestWithout = (value, omitted) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key))));
const receiptDigestOf = (receipt) => digestWithout(receipt, ['receiptId', 'receiptDigest']);
const receiptIdOf = (receipt) => `aclr-${receiptDigestOf(receipt).slice(0, 40)}`;
const boundedToken = (value) => typeof value === 'string' && TOKEN.test(value);

function sourceIdentityOf(archive) {
  if (archive === null || archive === undefined) {
    return {
      state: 'ABSENT_AT_POLL', manifestSha256: null, schemaVersion: null,
      childhoodVersion: null, archiveCreatedTsMs: null,
      limitations: ['ARCHIVE_ABSENT'],
    };
  }
  if (!isPlainObject(archive) || !(archive.oneMinute instanceof Map)
      || !isPlainObject(archive.census) || !isPlainObject(archive.census.identity)) {
    throw new Error('prepareAdaptiveCandleOutcome: archive is not a readLearningArchive result');
  }
  const identity = archive.census.identity;
  const identityKeys = exactKeys(identity, ['manifestSha256', 'schemaVersion', 'childhoodVersion']);
  if (identityKeys || !HEX64.test(identity.manifestSha256 ?? '')
      || !boundedToken(identity.schemaVersion) || !boundedToken(identity.childhoodVersion)) {
    throw new Error('prepareAdaptiveCandleOutcome: archive identity malformed');
  }
  if (archive.archiveCreatedTsMs !== null && !isTs(archive.archiveCreatedTsMs)) {
    throw new Error('prepareAdaptiveCandleOutcome: archive creation clock malformed');
  }
  if (!Array.isArray(archive.limitations) || archive.limitations.length > 32
      || archive.limitations.some((value) => typeof value !== 'string' || !REASON.test(value))) {
    throw new Error('prepareAdaptiveCandleOutcome: archive limitations malformed');
  }
  return {
    state: 'PRESENT_MANIFEST_BOUND',
    manifestSha256: identity.manifestSha256,
    schemaVersion: identity.schemaVersion,
    childhoodVersion: identity.childhoodVersion,
    archiveCreatedTsMs: archive.archiveCreatedTsMs,
    limitations: [...new Set(archive.limitations)].sort(),
  };
}

function projectLabel(label) {
  const horizon60m = label?.horizons?.['60m'];
  if (!isPlainObject(label) || !isPlainObject(label.availability)
      || !isPlainObject(label.reference) || !isPlainObject(horizon60m)) {
    throw new Error('prepareAdaptiveCandleOutcome: existing label recipe returned malformed output');
  }
  return {
    rowId: label.rowId,
    labelRecipeVersion: label.labelRecipeVersion,
    canonicalCoin: label.canonicalCoin,
    decisionKnownAtTs: label.decisionKnownAtTs,
    anchorTsMs: label.anchorTsMs,
    anchorLagMs: label.anchorLagMs,
    sourceTrack: label.sourceTrack,
    availability: clone(label.availability),
    reference: clone(label.reference),
    horizon60m: clone(horizon60m),
  };
}

function sourceIdentityError(source) {
  const keys = exactKeys(source, SOURCE_KEYS); if (keys) return `source ${keys}`;
  if (!['ABSENT_AT_POLL', 'PRESENT_MANIFEST_BOUND'].includes(source.state)
      || !Array.isArray(source.limitations) || source.limitations.length > 32
      || source.limitations.some((value) => typeof value !== 'string' || !REASON.test(value))) return 'source state/limitations malformed';
  if (source.state === 'ABSENT_AT_POLL') {
    if (source.manifestSha256 !== null || source.schemaVersion !== null || source.childhoodVersion !== null
        || source.archiveCreatedTsMs !== null || source.limitations.length !== 1
        || source.limitations[0] !== 'ARCHIVE_ABSENT') return 'absent source claims archive identity';
  } else if (!HEX64.test(source.manifestSha256 ?? '') || !boundedToken(source.schemaVersion)
      || !boundedToken(source.childhoodVersion)
      || (source.archiveCreatedTsMs !== null && !isTs(source.archiveCreatedTsMs))) return 'present source identity malformed';
  return null;
}

function labelProjectionError(label, procedure, prediction) {
  const keys = exactKeys(label, LABEL_KEYS); if (keys) return `label ${keys}`;
  const availabilityKeys = exactKeys(label.availability, AVAILABILITY_KEYS); if (availabilityKeys) return `availability ${availabilityKeys}`;
  const referenceKeys = exactKeys(label.reference, REFERENCE_KEYS); if (referenceKeys) return `reference ${referenceKeys}`;
  const horizonKeys = exactKeys(label.horizon60m, HORIZON_KEYS); if (horizonKeys) return `horizon ${horizonKeys}`;
  const expectedAnchor = Math.ceil(prediction.predictionTs / 60_000) * 60_000;
  if (label.rowId !== prediction.opportunityId || label.labelRecipeVersion !== procedure.target.labelRecipeVersion
      || label.canonicalCoin !== prediction.identity.canonicalCoin || label.decisionKnownAtTs !== prediction.predictionTs
      || label.anchorTsMs !== expectedAnchor || label.anchorLagMs !== expectedAnchor - prediction.predictionTs
      || label.sourceTrack !== '1m' || label.horizon60m.horizonEndTs !== prediction.targetEndTs
      || typeof label.availability.state !== 'string' || typeof label.availability.reason !== 'string'
      || typeof label.reference.state !== 'string' || typeof label.horizon60m.state !== 'string'
      || typeof label.horizon60m.reason !== 'string') return 'label identity/target malformed';
  if (label.reference.state === 'KNOWN') {
    if (!Number.isSafeInteger(label.reference.barOpenSec) || label.reference.barOpenSec <= 0
        || !isFiniteNum(label.reference.price) || label.reference.price <= 0
        || !isTs(label.reference.knownAtTs)) return 'known reference malformed';
  } else if (label.reference.price !== null || label.reference.barOpenSec !== null
      || (label.reference.knownAtTs !== null && !isTs(label.reference.knownAtTs))) return 'unknown reference exposes values';
  const h = label.horizon60m;
  if (h.state === 'KNOWN') {
    if (label.reference.state !== 'KNOWN' || !isTs(h.outcomeKnownAtTs)
        || !isFiniteNum(h.logReturnPct) || h.logReturnUnit !== 'LOG_RETURN_PERCENT'
        || !isFiniteNum(h.mfePct) || h.mfePct < 0 || !isFiniteNum(h.maePct) || h.maePct > 0) return 'known 60m label malformed';
  } else if (h.logReturnPct !== null || h.mfePct !== null || h.maePct !== null
      || h.logReturnUnit !== 'LOG_RETURN_PERCENT'
      || (h.outcomeKnownAtTs !== null && !isTs(h.outcomeKnownAtTs))) return 'unavailable 60m label exposes values';
  return null;
}

export function adaptiveCandleOutcomeReceiptError(receipt, procedure, prediction, { archive = undefined } = {}) {
  const keys = exactKeys(receipt, RECEIPT_KEYS); if (keys) return `receipt ${keys}`;
  if (adaptiveProcedureError(procedure) || adaptivePredictionError(prediction, procedure)) return 'procedure or prediction invalid';
  const sourceError = sourceIdentityError(receipt.sourceIdentity); if (sourceError) return sourceError;
  const labelError = labelProjectionError(receipt.label, procedure, prediction); if (labelError) return labelError;
  if (receipt.receiptVersion !== ADAPTIVE_CANDLE_RECEIPT_VERSION
      || receipt.adapterVersion !== ADAPTIVE_CANDLE_OUTCOME_ADAPTER_VERSION
      || receipt.procedureId !== procedure.procedureId || receipt.procedureDigest !== procedure.procedureDigest
      || receipt.predictionId !== prediction.predictionId || receipt.predictionDigest !== prediction.predictionDigest
      || receipt.opportunityId !== prediction.opportunityId || receipt.targetEndTs !== prediction.targetEndTs
      || receipt.missingnessDeadlineTs !== prediction.targetEndTs + procedure.target.maxLabelDelayMs
      || !isTs(receipt.preparedTs) || receipt.preparedTs < prediction.recordedTs
      || !['MATURED', 'PENDING', 'MISSING'].includes(receipt.disposition)
      || !REASON.test(receipt.dispositionReason ?? '')
      || receipt.labelDigest !== canonicalDigest(receipt.label)
      || receipt.durability !== ADAPTIVE_CANDLE_RECEIPT_DURABILITY
      || receipt.authority !== 'NONE' || receipt.purpose !== 'ADAPTIVE_CANDLE_TARGET_PROVENANCE') return 'receipt identity/content malformed';
  const h = receipt.label.horizon60m;
  if (receipt.disposition === 'MATURED') {
    if (h.state !== 'KNOWN' || h.outcomeKnownAtTs > receipt.preparedTs || receipt.dispositionReason !== 'LABEL_KNOWN') return 'matured receipt is not an available exact label';
  } else if (h.state === 'KNOWN') return 'non-matured receipt contains a known label';
  else if (receipt.disposition === 'PENDING' && receipt.preparedTs > receipt.missingnessDeadlineTs) return 'pending receipt is after its deadline';
  else if (receipt.disposition === 'MISSING' && receipt.preparedTs <= receipt.missingnessDeadlineTs) return 'missing receipt is not after its deadline';
  if (!HEX64.test(receipt.receiptDigest ?? '') || receipt.receiptDigest !== receiptDigestOf(receipt)
      || receipt.receiptId !== receiptIdOf(receipt)) return 'receipt digest mismatch';
  if (archive !== undefined) {
    let expectedSource; let expectedLabel;
    try {
      expectedSource = sourceIdentityOf(archive);
      expectedLabel = projectLabel(labelOpportunity({
        rowId: prediction.opportunityId,
        canonicalCoin: prediction.identity.canonicalCoin,
        decisionKnownAtTs: prediction.predictionTs,
      }, { archive, asOfTs: receipt.preparedTs }));
    } catch (error) { return `source replay failed: ${error.message}`; }
    if (!same(receipt.sourceIdentity, expectedSource) || !same(receipt.label, expectedLabel)) return 'receipt does not match supplied archive and label recipe';
  }
  return null;
}

function outcomeInputOfReceipt(receipt, prediction) {
  const common = { opportunityId: prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS };
  if (receipt.disposition === 'MATURED') {
    return {
      ...common, state: 'MATURED', logReturnPct: receipt.label.horizon60m.logReturnPct,
      sourceEventTs: receipt.label.horizon60m.horizonEndTs,
      knownAtTs: receipt.label.horizon60m.outcomeKnownAtTs,
      sourceDigest: receipt.receiptDigest, reasonCode: null,
    };
  }
  if (receipt.disposition === 'PENDING') {
    return {
      ...common, state: 'PENDING', logReturnPct: null, sourceEventTs: null,
      knownAtTs: null, sourceDigest: null, reasonCode: receipt.dispositionReason,
    };
  }
  return {
    ...common, state: 'MISSING', logReturnPct: null, sourceEventTs: null,
    knownAtTs: receipt.preparedTs, sourceDigest: receipt.receiptDigest,
    reasonCode: receipt.dispositionReason,
  };
}

// This validator proves that the submitted scalar outcome is an exact
// projection of the supplied candle-label receipt. Unless `archive` is also
// supplied, it does not authenticate the external archive or prove first-write
// chronology. It never grants after-cost qualification or decision authority.
export function adaptiveCandleOutcomeSubmissionError(
  submission,
  procedure,
  prediction,
  { archive = undefined } = {},
) {
  const keys = exactKeys(submission, SUBMISSION_KEYS); if (keys) return `submission ${keys}`;
  const outcomeKeys = exactKeys(submission.outcomeInput, OUTCOME_INPUT_KEYS); if (outcomeKeys) return `outcome input ${outcomeKeys}`;
  const receiptError = adaptiveCandleOutcomeReceiptError(
    submission.provenanceReceipt,
    procedure,
    prediction,
    { archive },
  );
  if (receiptError) return `provenance receipt ${receiptError}`;
  if (!same(submission.outcomeInput, outcomeInputOfReceipt(submission.provenanceReceipt, prediction))) {
    return 'outcome input does not exactly project the provenance receipt';
  }
  return null;
}

export function adaptiveCandleSettlementError(
  settlement,
  procedure,
  prediction,
  { archive = undefined } = {},
) {
  const keys = exactKeys(settlement, ['outcome', 'provenanceReceipt']); if (keys) return `settlement ${keys}`;
  const receiptError = adaptiveCandleOutcomeReceiptError(
    settlement.provenanceReceipt,
    procedure,
    prediction,
    { archive },
  );
  if (receiptError) return `provenance receipt ${receiptError}`;
  const outcomeError = adaptiveOutcomeError(settlement.outcome, procedure, prediction);
  if (outcomeError) return `outcome ${outcomeError}`;
  if (settlement.provenanceReceipt.disposition === 'PENDING') return 'pending receipt cannot back a durable outcome';
  if (settlement.provenanceReceipt.preparedTs > settlement.outcome.recordedTs) return 'receipt was prepared after the outcome was recorded';
  const projected = outcomeInputOfReceipt(settlement.provenanceReceipt, prediction);
  const outcomeInput = Object.fromEntries(OUTCOME_INPUT_KEYS.map((key) => [key, settlement.outcome[key]]));
  if (!same(outcomeInput, projected)) return 'durable outcome does not exactly project the provenance receipt';
  return null;
}

export function prepareAdaptiveCandleOutcome({ procedure, prediction, archive = null, asOfTs } = {}) {
  const procedureError = adaptiveProcedureError(procedure); if (procedureError) throw new Error(`prepareAdaptiveCandleOutcome: ${procedureError}`);
  const predictionError = adaptivePredictionError(prediction, procedure); if (predictionError) throw new Error(`prepareAdaptiveCandleOutcome: ${predictionError}`);
  if (!isTs(asOfTs) || asOfTs < prediction.recordedTs) throw new Error('prepareAdaptiveCandleOutcome: asOfTs precedes the saved prediction');
  const sourceIdentity = sourceIdentityOf(archive);
  const rawLabel = labelOpportunity({
    rowId: prediction.opportunityId,
    canonicalCoin: prediction.identity.canonicalCoin,
    decisionKnownAtTs: prediction.predictionTs,
  }, { archive, asOfTs });
  const label = projectLabel(rawLabel);
  const labelError = labelProjectionError(label, procedure, prediction); if (labelError) throw new Error(`prepareAdaptiveCandleOutcome: ${labelError}`);
  const deadlineTs = prediction.targetEndTs + procedure.target.maxLabelDelayMs;
  const known = label.horizon60m.state === 'KNOWN';
  const disposition = known ? 'MATURED' : asOfTs <= deadlineTs ? 'PENDING' : 'MISSING';
  const dispositionReason = known ? 'LABEL_KNOWN'
    : disposition === 'PENDING' ? `LABEL_PENDING:${label.horizon60m.reason}`
      : `LABEL_DEADLINE_EXPIRED:${label.horizon60m.reason}`;
  if (!REASON.test(dispositionReason)) throw new Error('prepareAdaptiveCandleOutcome: label reason cannot fit the closed outcome contract');
  const receipt = {
    receiptVersion: ADAPTIVE_CANDLE_RECEIPT_VERSION,
    adapterVersion: ADAPTIVE_CANDLE_OUTCOME_ADAPTER_VERSION,
    receiptId: '', receiptDigest: '',
    procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
    predictionId: prediction.predictionId, predictionDigest: prediction.predictionDigest,
    opportunityId: prediction.opportunityId, targetEndTs: prediction.targetEndTs,
    missingnessDeadlineTs: deadlineTs, preparedTs: asOfTs,
    disposition, dispositionReason, sourceIdentity, label,
    labelDigest: canonicalDigest(label), durability: ADAPTIVE_CANDLE_RECEIPT_DURABILITY,
    authority: 'NONE', purpose: 'ADAPTIVE_CANDLE_TARGET_PROVENANCE',
  };
  receipt.receiptDigest = receiptDigestOf(receipt); receipt.receiptId = receiptIdOf(receipt);
  const receiptError = adaptiveCandleOutcomeReceiptError(receipt, procedure, prediction, { archive });
  if (receiptError) throw new Error(`prepareAdaptiveCandleOutcome: ${receiptError}`);
  const outcomeInput = outcomeInputOfReceipt(receipt, prediction);
  const submission = { outcomeInput, provenanceReceipt: receipt };
  const submissionError = adaptiveCandleOutcomeSubmissionError(submission, procedure, prediction, { archive });
  if (submissionError) throw new Error(`prepareAdaptiveCandleOutcome: ${submissionError}`);
  return deepFreeze({ status: disposition, ...submission });
}
