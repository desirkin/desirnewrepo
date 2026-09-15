import {
  canonicalDigest, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import { captureError } from './shadow-contracts.js';

export const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
export const clone = (value) => structuredClone(value);
export const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);
export const boundedId = (value) => typeof value === 'string' && ID.test(value);
export const digestWithout = (value, omitted) => canonicalDigest(Object.fromEntries(
  Object.entries(value).filter(([key]) => !omitted.includes(key)),
));
export const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

export const DYNAMIC_CONSUMER_KEYS = Object.freeze([
  'consumerContractVersion', 'consumerId', 'policyDigest', 'preparedFactsContract',
  'preparedFactsContractDigest', 'featureRecipeDigest', 'eligibility', 'stateEffect',
  'validationSemantics', 'activationLifetimeMs', 'degradeRule', 'authority',
  'consumerContractDigest',
]);
export const STATE_EFFECT_KEYS = Object.freeze([
  'effectVersion', 'axis', 'target', 'targetProducerVersion', 'rankingLawVersion',
  'transform', 'statePath', 'units', 'minimum', 'maximum', 'precision',
  'zeroEffectLaw', 'qualificationUnit',
]);
export const PUBLICATION_KEYS = Object.freeze([
  'publicationVersion', 'publicationId', 'publicationDigest', 'procedure',
  'initialState', 'consumerContract', 'scope', 'applicability', 'trialLaw',
  'sealedTs', 'authority', 'purpose',
]);
const SCOPE_KEYS = Object.freeze(['setupType', 'regime', 'assets', 'venues']);
export const TRIAL_LAW_KEYS = Object.freeze([
  'captureVersion', 'executionVersion', 'primaryMetric', 'comparator',
  'decisionInputLaw', 'stateLaw', 'armOutcomeLaw', 'actualFillClaim',
]);
export const TRIAL_CAPTURE_KEYS = Object.freeze([
  'decisionVersion', 'decisionId', 'decisionDigest', 'publicationId', 'candidateId',
  'opportunityId', 'canonicalCoin', 'decisionTs', 'labelEndTs', 'recordedTs',
  'procedureId', 'procedureDigest', 'adaptiveState', 'prediction', 'predictionAck',
  'preparedFacts', 'preparedFactsDigest', 'context', 'rankCandidates',
  'baselineSelectedStrategyId', 'candidateSelectedStrategyId', 'baselineArm',
  'candidateArm', 'authority', 'purpose',
]);
const ACK_KEYS = Object.freeze([
  'outcome', 'ackVersion', 'streamVersion', 'storeVersion', 'eventVersion',
  'procedureId', 'procedureDigest', 'revision', 'eventDigest', 'headDigest',
  'acknowledgedTs', 'receivedTs',
]);
export const CONTEXT_KEYS = Object.freeze(['setupType', 'regime', 'asset', 'venue']);
export const RANK_KEYS = Object.freeze(['strategyId', 'baselineRewardRiskRatio']);
export const RANK_V2_KEYS = Object.freeze(['strategyId', 'eligibility', 'reasonCode', 'baselineRewardRiskRatio']);
export const ARM_KEYS = Object.freeze(['selectedStrategyId', 'executionCapture']);
export const TRIAL_EXECUTION_KEYS = Object.freeze([
  'executionVersion', 'executionId', 'executionDigest', 'publicationId',
  'candidateId', 'opportunityId', 'decisionId', 'candidate', 'baseline',
  'outcomeKnownAtTs', 'recordedTs', 'authority', 'purpose',
]);
export const EXECUTION_ARM_KEYS = Object.freeze([
  'selectedStrategyId', 'sourceIdentity', 'path', 'depthPath', 'asOfTs', 'outcome',
]);
export const EXECUTION_SOURCE_KEYS = Object.freeze(['venue', 'assetId', 'entryEpochId', 'exitEpochId']);
export const ABSTAIN_OUTCOME_KEYS = Object.freeze([
  'outcomeVersion', 'label', 'netPct', 'actualFillObserved', 'sizeEvidence',
  'entry', 'exit', 'reasonCode',
]);
export const ADAPTIVE_RANKING_ABSTAIN_OUTCOME_VERSION = 'adaptive-ranking-abstain-outcome-1';
export const QUALIFICATION_KEYS = Object.freeze([
  'qualificationVersion', 'qualificationId', 'qualificationDigest',
  'publicationId', 'publicationDigest', 'procedureId', 'procedureDigest',
  'initialStateDigest', 'consumerContractDigest', 'stateEffect', 'scope',
  'applicability', 'candidateId', 'candidateDigest', 'activationId',
  'terminalReportDigest', 'qualifiedTs', 'effectiveTs', 'expiresTs',
  'authority', 'purpose',
]);
export const STATE_SOURCE_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'predictionId', 'outcomeId', 'updateId',
  'receiptDigest', 'stateDigest', 'eventSequence', 'eventDigest', 'durableAcknowledgment',
]);
export const SETTLEMENT_ACK_KEYS = Object.freeze(['ackVersion', 'sequence', 'eventDigest', 'headDigest', 'acknowledgedTs']);
export const DECISION_KEYS = Object.freeze([
  'decisionVersion', 'preparedTs', 'mode', 'kill', 'adaptiveRankingProcedure',
  'withheld', 'authority',
]);
export const ADAPTIVE_SECTION_KEYS = Object.freeze([
  'consumerContractDigest', 'procedureId', 'procedureDigest', 'currentState',
  'stateSource', 'qualification', 'publication', 'legacyActivationEffectReinterpreted',
  'authority',
]);

export function scopeError(scope) {
  if (exactKeys(scope, SCOPE_KEYS)) return 'shape malformed';
  for (const key of ['setupType', 'regime']) if (typeof scope[key] !== 'string' || scope[key].length < 1 || scope[key].length > 48) return `${key} malformed`;
  for (const key of ['assets', 'venues']) {
    const list = scope[key];
    if (list === 'ANY') continue;
    if (!Array.isArray(list) || list.length < 1 || list.length > 64
        || list.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 48)
        || new Set(list).size !== list.length) return `${key} malformed`;
  }
  return null;
}

export function applicabilityError(value) {
  if (!isPlainObject(value) || exactKeys(value, ['clauses']) || !Array.isArray(value.clauses)
      || value.clauses.length < 1 || value.clauses.length > 32) return 'shape malformed';
  for (const clause of value.clauses) if (exactKeys(clause, ['feature', 'op', 'threshold'])
      || !boundedId(clause.feature) || !['GT', 'GTE', 'LT', 'LTE'].includes(clause.op)
      || !isFiniteNum(clause.threshold)) return 'clause malformed';
  return null;
}

export function scopeAllows(scope, context) {
  const field = (declared, value) => declared === 'ANY' || declared === value;
  const listed = (declared, value) => declared === 'ANY' || declared.includes(value);
  return field(scope.setupType, context.setupType) && field(scope.regime, context.regime)
    && listed(scope.assets, context.asset) && listed(scope.venues, context.venue);
}
export function predictionAckError(ack, prediction, recordedTs) {
  if (exactKeys(ack, ACK_KEYS)) return 'prediction acknowledgment shape malformed';
  if (!['APPENDED', 'EXISTING'].includes(ack.outcome)
      || !boundedId(ack.ackVersion) || !boundedId(ack.streamVersion)
      || !boundedId(ack.storeVersion) || !boundedId(ack.eventVersion)
      || ack.procedureId !== prediction.procedureId
      || ack.procedureDigest !== prediction.procedureDigest
      || !Number.isSafeInteger(ack.revision) || ack.revision < 2
      || !HEX64.test(ack.eventDigest ?? '') || !HEX64.test(ack.headDigest ?? '')
      || !isTs(ack.acknowledgedTs) || !isTs(ack.receivedTs)
      || ack.acknowledgedTs < prediction.recordedTs
      || ack.receivedTs < ack.acknowledgedTs || ack.receivedTs > recordedTs) {
    return 'prediction acknowledgment identity or chronology malformed';
  }
  return null;
}
export function armCaptureError(arm, selectedStrategyId, publication, decisionTs, context) {
  if (exactKeys(arm, ARM_KEYS)) return 'trial arm shape malformed';
  const capture = arm.executionCapture;
  if (arm.selectedStrategyId !== selectedStrategyId || captureError(capture)
      || capture.variant.decision !== 'TAKE'
      || capture.recipeSeal.recipe.styleId !== selectedStrategyId
      || capture.decisionTs !== decisionTs || capture.assetId !== context.asset
      || capture.venue !== context.venue
      || capture.recipeSeal.recipe.horizonMin * 60_000 !== publication.procedure.target.horizonMs
      || capture.inputFidelity !== 'DEPTH_SUPPORTED') return 'trial arm capture/strategy/market mismatch';
  return null;
}
