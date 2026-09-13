// Bounded adaptive ranking procedure and its closed, pure record contracts.
//
// This module grants no decision authority. It defines one initial numerical
// learner: an account-independent probability estimate for a positive 60m log
// return, maintained separately for each already-existing strategy. A rank
// offset is a deterministic, bounded projection of that estimate. Whether that
// projection may influence PAPER is decided outside this module by the existing
// promotion/activation owner after both forecast and after-cost policy review.
import {
  canonicalDigest, deepFreeze, exactKeys, isCoin, isFiniteNum, isPlainObject,
  isTs, opportunityIdOf,
} from './contracts.js';
import { LEARNING_LABEL_RECIPE_VERSION, anchorOf } from './labels.js';

export const ADAPTIVE_PROCEDURE_VERSION = 'adaptive-ranking-procedure-1';
export const ADAPTIVE_STATE_VERSION = 'adaptive-ranking-state-1';
export const ADAPTIVE_PREDICTION_VERSION = 'adaptive-ranking-prediction-1';
export const ADAPTIVE_OUTCOME_VERSION = 'adaptive-ranking-outcome-1';
export const ADAPTIVE_SCORE_VERSION = 'adaptive-brier-score-1';
export const ADAPTIVE_UPDATE_VERSION = 'adaptive-ranking-update-1';
export const ADAPTIVE_SNAPSHOT_VERSION = 'adaptive-state-snapshot-1';
export const ADAPTIVE_TARGET_VERSION = 'positive-60m-log-return-target-1';
export const ADAPTIVE_ALGORITHM_VERSION = 'bounded-residual-rank-offset-1';
export const ADAPTIVE_HORIZON_MS = 60 * 60_000;
export const ADAPTIVE_PRECISION = 1e-9;

export const ADAPTIVE_LIMITS = deepFreeze({
  maxStrategies: 32,
  maxStrategyIdBytes: 100,
  maxReasonBytes: 160,
  maxDatasetIdBytes: 200,
  maxCaptureRecipeBytes: 160,
  maxCatalogIdBytes: 200,
});

export const ADAPTIVE_EFFECT_REGISTRY = deepFreeze({
  RANKING_SELECTION: {
    state: 'SUPPORTED_AFTER_EXTERNAL_QUALIFICATION',
    value: 'rankOffsetRrPoints',
    units: 'REWARD_RISK_RATIO_POINTS',
    owner: 'EXISTING_JUDGE_ADMISSION_RANKING',
  },
  ENTRY: { state: 'UNSUPPORTED_REQUIRES_SEPARATE_REGISTRY_AND_QUALIFICATION' },
  EXIT: { state: 'UNSUPPORTED_REQUIRES_SEPARATE_REGISTRY_AND_QUALIFICATION' },
  SIZING: { state: 'UNSUPPORTED_REQUIRES_SEPARATE_REGISTRY_AND_QUALIFICATION' },
});

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const STRATEGY_ID = /^[A-Z0-9][A-Z0-9_]{0,99}$/;
const REASON = /^[A-Z0-9][A-Z0-9_:.\-]{0,159}$/;
const ELIGIBILITY = new Set(['ELIGIBLE', 'INELIGIBLE', 'UNAVAILABLE']);
const OUTCOME_STATES = new Set(['MATURED', 'MISSING']);
const UPDATE_ELIGIBILITY = new Set(['ELIGIBLE', 'INELIGIBLE_MISSING', 'INELIGIBLE_LATE', 'INELIGIBLE_NO_FORECAST']);

const PROCEDURE_KEYS = Object.freeze([
  'procedureVersion', 'procedureId', 'procedureDigest', 'parent', 'strategies',
  'target', 'algorithm', 'effectRegistry', 'createdTs', 'authority', 'purpose',
]);
const PARENT_KEYS = Object.freeze(['policyDigest', 'consumerContractDigest', 'featureRecipeDigest']);
const TARGET_KEYS = Object.freeze([
  'targetVersion', 'labelRecipeVersion', 'name', 'horizonMs', 'anchorLaw',
  'referenceLaw', 'sourceValue', 'sourceUnits', 'eventLaw', 'knownAtLaw',
  'forecastUnits', 'score', 'maxLabelDelayMs', 'maxPredictionPersistenceDelayMs',
]);
const ALGORITHM_KEYS = Object.freeze([
  'algorithmVersion', 'initialProbability', 'minProbability', 'maxProbability',
  'learningRate', 'rankScaleRrPoints', 'maxProbabilityDeltaPerOutcome',
  'maxRankDeltaPerStrategyPerOutcome', 'maxEpisodeRankMovementRrPoints',
  'maxCumulativeRankMovementRrPoints', 'maxAbsRankOffsetRrPoints', 'precision',
]);
const STATE_KEYS = Object.freeze([
  'stateVersion', 'procedureId', 'procedureDigest', 'sequence', 'updatedTs',
  'strategies', 'influencedEpisodes', 'influenceLedgerDigest',
  'totalRankMovementRrPoints', 'stateDigest',
]);
const STRATEGY_STATE_KEYS = Object.freeze([
  'strategyId', 'observations', 'positive60mProbability', 'rankOffsetRrPoints',
]);
const PREDICTION_KEYS = Object.freeze([
  'predictionVersion', 'predictionId', 'predictionDigest', 'procedureId',
  'procedureDigest', 'opportunityId', 'identity', 'catalogContentId', 'decisionTs',
  'predictionTs', 'recordedTs', 'horizonMs', 'targetEndTs', 'featureRecipeDigest',
  'factsDigest', 'modelStateRef', 'strategyAssessments', 'selection', 'authority',
  'purpose',
]);
const IDENTITY_KEYS = Object.freeze(['canonicalCoin', 'decisionTs', 'captureRecipeVersion', 'datasetId']);
const STATE_REF_KEYS = Object.freeze(['stateVersion', 'sequence', 'stateDigest']);
const ASSESSMENT_INPUT_KEYS = Object.freeze(['strategyId', 'eligibility', 'reasonCode']);
const ASSESSMENT_KEYS = Object.freeze([
  'strategyId', 'eligibility', 'forecastProbability', 'calibration', 'reasonCode',
]);
const SELECTION_KEYS = Object.freeze(['strategyId', 'reasonCode']);
const OUTCOME_KEYS = Object.freeze([
  'outcomeVersion', 'outcomeId', 'outcomeDigest', 'procedureId', 'procedureDigest',
  'predictionId', 'opportunityId', 'horizonMs', 'targetEndTs', 'state',
  'updateEligibility', 'logReturnPct', 'targetValue', 'sourceEventTs', 'knownAtTs',
  'recordedTs', 'sourceDigest', 'reasonCode', 'authority', 'purpose',
]);
const SCORE_KEYS = Object.freeze([
  'scoreVersion', 'scoreId', 'scoreDigest', 'procedureId', 'predictionId',
  'outcomeId', 'opportunityId', 'horizonMs', 'strategyId',
  'forecastProbability', 'targetValue', 'brierLoss', 'scoredTs',
]);
const UPDATE_KEYS = Object.freeze([
  'updateVersion', 'updateId', 'updateDigest', 'procedureId', 'procedureDigest',
  'predictionId', 'outcomeId', 'opportunityId', 'horizonMs',
  'previousStateDigest', 'previousSequence', 'deltas', 'episodeInfluenceBefore',
  'episodeInfluenceAfter', 'totalMovementBefore', 'totalMovementAfter',
  'nextStateDigest', 'appliedTs', 'movementStatus',
]);
const DELTA_KEYS = Object.freeze([
  'strategyId', 'previousProbability', 'nextProbability', 'previousRankOffsetRrPoints',
  'rankDeltaRrPoints', 'nextRankOffsetRrPoints',
]);

const finiteIn = (value, min, max) => isFiniteNum(value) && value >= min && value <= max;
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const bounded = (value, max) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= max;
const reason = (value) => value === null || (typeof value === 'string' && REASON.test(value));
const q = (value) => {
  if (!isFiniteNum(value)) throw new Error('adaptive registry: non-finite numerical value');
  const rounded = Math.round(value / ADAPTIVE_PRECISION) * ADAPTIVE_PRECISION;
  const clean = Number(rounded.toFixed(9));
  return Object.is(clean, -0) ? 0 : clean;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);
const digestWithout = (value, omitted) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key))));

const procedureDigestOf = (value) => digestWithout(value, ['procedureId', 'procedureDigest']);
export const adaptiveStateDigestOf = (value) => digestWithout(value, ['stateDigest']);
export const adaptivePredictionDigestOf = (value) => digestWithout(value, ['predictionId', 'predictionDigest']);
export const adaptiveOutcomeDigestOf = (value) => digestWithout(value, ['outcomeId', 'outcomeDigest']);
export const adaptiveScoreDigestOf = (value) => digestWithout(value, ['scoreId', 'scoreDigest']);
export const adaptiveUpdateDigestOf = (value) => digestWithout(value, ['updateId', 'updateDigest']);
export const adaptiveUpdateKeyOf = ({ procedureId, opportunityId, horizonMs }) => (
  `aupd-${canonicalDigest({ procedureId, opportunityId, horizonMs }).slice(0, 40)}`
);
export const adaptivePredictionKeyOf = ({ procedureId, opportunityId, horizonMs }) => (
  `${procedureId}|${opportunityId}|${horizonMs}`
);

function throwIf(error, where) {
  if (error) throw new Error(`${where}: ${error}`);
}

export function sealAdaptiveProcedure({
  parentPolicyDigest,
  consumerContractDigest,
  featureRecipeDigest,
  strategyIds,
  createdTs,
  maxLabelDelayMs = 24 * 60 * 60_000,
  maxPredictionPersistenceDelayMs = 5_000,
  initialProbability = 0.5,
  minProbability = 0.05,
  maxProbability = 0.95,
  learningRate = 0.1,
  rankScaleRrPoints = 0.3,
  maxProbabilityDeltaPerOutcome = 0.05,
  maxRankDeltaPerStrategyPerOutcome = 0.015,
  maxEpisodeRankMovementRrPoints = 0.03,
  maxCumulativeRankMovementRrPoints = 2,
  maxAbsRankOffsetRrPoints = 0.15,
} = {}) {
  const strategies = Array.isArray(strategyIds) ? [...strategyIds].sort() : strategyIds;
  const body = {
    procedureVersion: ADAPTIVE_PROCEDURE_VERSION,
    parent: { policyDigest: parentPolicyDigest, consumerContractDigest, featureRecipeDigest },
    strategies,
    target: {
      targetVersion: ADAPTIVE_TARGET_VERSION,
      labelRecipeVersion: LEARNING_LABEL_RECIPE_VERSION,
      name: 'POSITIVE_60M_LOG_RETURN',
      horizonMs: ADAPTIVE_HORIZON_MS,
      anchorLaw: 'CEIL_DECISION_TS_TO_NEXT_60000MS_GRID_BOUNDARY',
      referenceLaw: 'CLOSE_OF_1M_BAR_ENDING_AT_ANCHOR',
      sourceValue: 'MATURED_LOG_RETURN_PCT',
      sourceUnits: 'LOG_RETURN_PERCENT',
      eventLaw: 'ONE_IFF_LOG_RETURN_PCT_GT_ZERO_OTHERWISE_ZERO',
      knownAtLaw: 'MAX_HORIZON_END_ARCHIVE_CREATED_SERIES_RETRIEVED',
      forecastUnits: 'PROBABILITY_0_TO_1',
      score: 'BRIER_LOSS',
      maxLabelDelayMs,
      maxPredictionPersistenceDelayMs,
    },
    algorithm: {
      algorithmVersion: ADAPTIVE_ALGORITHM_VERSION,
      initialProbability, minProbability, maxProbability, learningRate,
      rankScaleRrPoints, maxProbabilityDeltaPerOutcome,
      maxRankDeltaPerStrategyPerOutcome, maxEpisodeRankMovementRrPoints,
      maxCumulativeRankMovementRrPoints, maxAbsRankOffsetRrPoints,
      precision: ADAPTIVE_PRECISION,
    },
    effectRegistry: ADAPTIVE_EFFECT_REGISTRY,
    createdTs,
    authority: 'NONE',
    purpose: 'RESEARCH_AND_EXTERNALLY_QUALIFIED_PAPER_STATE',
  };
  const procedureDigest = canonicalDigest(body);
  const procedure = {
    ...body,
    procedureId: `adp-${procedureDigest.slice(0, 40)}`,
    procedureDigest,
  };
  throwIf(adaptiveProcedureError(procedure), 'sealAdaptiveProcedure');
  return deepFreeze(procedure);
}

export function adaptiveProcedureError(procedure) {
  const keys = exactKeys(procedure, PROCEDURE_KEYS); if (keys) return `procedure ${keys}`;
  if (procedure.procedureVersion !== ADAPTIVE_PROCEDURE_VERSION) return 'unsupported procedure version';
  const parentKeys = exactKeys(procedure.parent, PARENT_KEYS); if (parentKeys) return `parent ${parentKeys}`;
  if (!Object.values(procedure.parent).every((value) => HEX64.test(value ?? ''))) return 'parent digests malformed';
  if (!Array.isArray(procedure.strategies) || procedure.strategies.length < 2 || procedure.strategies.length > ADAPTIVE_LIMITS.maxStrategies) return 'strategy registry size outside [2,32]';
  if (procedure.strategies.some((value) => !STRATEGY_ID.test(value)) || new Set(procedure.strategies).size !== procedure.strategies.length) return 'strategy registry malformed or duplicated';
  if (procedure.strategies.some((value, index) => index > 0 && procedure.strategies[index - 1] >= value)) return 'strategy registry not canonical sorted';
  const targetKeys = exactKeys(procedure.target, TARGET_KEYS); if (targetKeys) return `target ${targetKeys}`;
  if (procedure.target.targetVersion !== ADAPTIVE_TARGET_VERSION || procedure.target.labelRecipeVersion !== LEARNING_LABEL_RECIPE_VERSION
      || procedure.target.name !== 'POSITIVE_60M_LOG_RETURN'
      || procedure.target.horizonMs !== ADAPTIVE_HORIZON_MS || procedure.target.sourceValue !== 'MATURED_LOG_RETURN_PCT'
      || procedure.target.anchorLaw !== 'CEIL_DECISION_TS_TO_NEXT_60000MS_GRID_BOUNDARY'
      || procedure.target.referenceLaw !== 'CLOSE_OF_1M_BAR_ENDING_AT_ANCHOR'
      || procedure.target.sourceUnits !== 'LOG_RETURN_PERCENT'
      || procedure.target.eventLaw !== 'ONE_IFF_LOG_RETURN_PCT_GT_ZERO_OTHERWISE_ZERO'
      || procedure.target.knownAtLaw !== 'MAX_HORIZON_END_ARCHIVE_CREATED_SERIES_RETRIEVED'
      || procedure.target.forecastUnits !== 'PROBABILITY_0_TO_1' || procedure.target.score !== 'BRIER_LOSS'
      || !count(procedure.target.maxLabelDelayMs, 30 * 24 * 60 * 60_000)
      || !count(procedure.target.maxPredictionPersistenceDelayMs, 60_000)) return 'target contract malformed';
  const algorithmKeys = exactKeys(procedure.algorithm, ALGORITHM_KEYS); if (algorithmKeys) return `algorithm ${algorithmKeys}`;
  const a = procedure.algorithm;
  if (a.algorithmVersion !== ADAPTIVE_ALGORITHM_VERSION || a.precision !== ADAPTIVE_PRECISION) return 'algorithm version or precision mismatch';
  if (!finiteIn(a.initialProbability, 0, 1) || !finiteIn(a.minProbability, 0, 1)
      || !finiteIn(a.maxProbability, 0, 1) || a.minProbability >= a.initialProbability
      || a.initialProbability >= a.maxProbability) return 'probability envelope malformed';
  if (!finiteIn(a.learningRate, ADAPTIVE_PRECISION, 1)
      || !finiteIn(a.rankScaleRrPoints, ADAPTIVE_PRECISION, 1)
      || !finiteIn(a.maxProbabilityDeltaPerOutcome, ADAPTIVE_PRECISION, 0.25)
      || !finiteIn(a.maxRankDeltaPerStrategyPerOutcome, ADAPTIVE_PRECISION, 0.05)
      || !finiteIn(a.maxEpisodeRankMovementRrPoints, ADAPTIVE_PRECISION, 0.25)
      || !finiteIn(a.maxCumulativeRankMovementRrPoints, ADAPTIVE_PRECISION, 100)
      || !finiteIn(a.maxAbsRankOffsetRrPoints, ADAPTIVE_PRECISION, 0.15)) return 'algorithm bounds malformed';
  if (a.maxEpisodeRankMovementRrPoints > a.maxCumulativeRankMovementRrPoints) return 'episode movement exceeds cumulative movement';
  if (!same(procedure.effectRegistry, ADAPTIVE_EFFECT_REGISTRY)) return 'effect registry changed';
  if (!isTs(procedure.createdTs) || procedure.authority !== 'NONE' || procedure.purpose !== 'RESEARCH_AND_EXTERNALLY_QUALIFIED_PAPER_STATE') return 'procedure clock or authority malformed';
  if (!HEX64.test(procedure.procedureDigest ?? '') || procedure.procedureDigest !== procedureDigestOf(procedure)
      || procedure.procedureId !== `adp-${procedure.procedureDigest.slice(0, 40)}`) return 'procedure identity mismatch';
  return null;
}

function rankOffsetOf(probability, procedure) {
  const a = procedure.algorithm;
  return q(clamp(
    a.rankScaleRrPoints * (probability - a.initialProbability),
    -a.maxAbsRankOffsetRrPoints,
    a.maxAbsRankOffsetRrPoints,
  ));
}

function stateBody(procedure, sequence, updatedTs, strategies, influencedEpisodes, influenceLedgerDigest, totalMovement) {
  const state = {
    stateVersion: ADAPTIVE_STATE_VERSION,
    procedureId: procedure.procedureId,
    procedureDigest: procedure.procedureDigest,
    sequence,
    updatedTs,
    strategies,
    influencedEpisodes,
    influenceLedgerDigest,
    totalRankMovementRrPoints: q(totalMovement),
    stateDigest: '',
  };
  state.stateDigest = adaptiveStateDigestOf(state);
  return state;
}

export function initialAdaptiveState(procedure, { initializedTs = procedure?.createdTs } = {}) {
  throwIf(adaptiveProcedureError(procedure), 'initialAdaptiveState');
  const strategies = procedure.strategies.map((strategyId) => ({
    strategyId,
    observations: 0,
    positive60mProbability: q(procedure.algorithm.initialProbability),
    rankOffsetRrPoints: 0,
  }));
  const state = stateBody(
    procedure, 0, initializedTs, strategies, 0,
    canonicalDigest({ version: 'adaptive-influence-ledger-1', entries: [] }), 0,
  );
  throwIf(adaptiveStateError(state, procedure), 'initialAdaptiveState');
  return deepFreeze(state);
}

export function adaptiveStateError(state, procedure) {
  const keys = exactKeys(state, STATE_KEYS); if (keys) return `state ${keys}`;
  if (adaptiveProcedureError(procedure)) return 'procedure invalid';
  if (state.stateVersion !== ADAPTIVE_STATE_VERSION || state.procedureId !== procedure.procedureId
      || state.procedureDigest !== procedure.procedureDigest || !count(state.sequence)
      || !isTs(state.updatedTs)) return 'state identity, sequence, or clock malformed';
  if (!Array.isArray(state.strategies) || state.strategies.length !== procedure.strategies.length) return 'state strategies malformed';
  for (let i = 0; i < state.strategies.length; i += 1) {
    const row = state.strategies[i]; const rowKeys = exactKeys(row, STRATEGY_STATE_KEYS); if (rowKeys) return `state strategy ${rowKeys}`;
    if (row.strategyId !== procedure.strategies[i] || !count(row.observations)
        || !finiteIn(row.positive60mProbability, procedure.algorithm.minProbability, procedure.algorithm.maxProbability)
        || !finiteIn(row.rankOffsetRrPoints, -procedure.algorithm.maxAbsRankOffsetRrPoints, procedure.algorithm.maxAbsRankOffsetRrPoints)
        || row.rankOffsetRrPoints !== rankOffsetOf(row.positive60mProbability, procedure)) return `state strategy ${i} mismatch`;
  }
  if (!count(state.influencedEpisodes) || state.influencedEpisodes > state.sequence
      || !HEX64.test(state.influenceLedgerDigest ?? '')) return 'influence ledger summary malformed';
  if (!finiteIn(state.totalRankMovementRrPoints, 0, procedure.algorithm.maxCumulativeRankMovementRrPoints)) return 'total movement malformed';
  if (!HEX64.test(state.stateDigest ?? '') || state.stateDigest !== adaptiveStateDigestOf(state)) return 'state digest mismatch';
  return null;
}

function identityError(identity) {
  const keys = exactKeys(identity, IDENTITY_KEYS); if (keys) return keys;
  if (!isCoin(identity.canonicalCoin) || !isTs(identity.decisionTs)
      || !bounded(identity.captureRecipeVersion, ADAPTIVE_LIMITS.maxCaptureRecipeBytes)
      || !bounded(identity.datasetId, ADAPTIVE_LIMITS.maxDatasetIdBytes)) return 'values malformed';
  return null;
}

function predictionIdOf(record) {
  return `aprd-${adaptivePredictionDigestOf(record).slice(0, 40)}`;
}

export function buildAdaptivePrediction({ procedure, state, input, recordedTs }) {
  throwIf(adaptiveProcedureError(procedure), 'buildAdaptivePrediction');
  throwIf(adaptiveStateError(state, procedure), 'buildAdaptivePrediction');
  const inputKeys = exactKeys(input, [
    'opportunityId', 'identity', 'catalogContentId', 'predictionTs', 'horizonMs',
    'featureRecipeDigest', 'factsDigest', 'strategyAssessments', 'selection',
  ]);
  throwIf(inputKeys && `input ${inputKeys}`, 'buildAdaptivePrediction');
  const identityErr = identityError(input.identity); throwIf(identityErr && `identity ${identityErr}`, 'buildAdaptivePrediction');
  let expectedOpportunityId;
  try { expectedOpportunityId = opportunityIdOf(input.identity); } catch (error) { throw new Error(`buildAdaptivePrediction: ${error.message}`); }
  if (input.opportunityId !== expectedOpportunityId) throw new Error('buildAdaptivePrediction: opportunity identity mismatch');
  const anchorTs = anchorOf(input.predictionTs).anchorTsMs;
  const targetEndTs = anchorTs + input.horizonMs;
  if (input.horizonMs !== procedure.target.horizonMs || input.predictionTs !== input.identity.decisionTs
      || state.updatedTs > input.predictionTs || !isTs(recordedTs) || recordedTs < input.predictionTs
      || recordedTs - input.predictionTs > procedure.target.maxPredictionPersistenceDelayMs
      || recordedTs >= targetEndTs) throw new Error('buildAdaptivePrediction: prediction clock/horizon malformed, state is from the future, or persistence was delayed');
  if (!ID.test(input.catalogContentId ?? '') || input.featureRecipeDigest !== procedure.parent.featureRecipeDigest
      || !HEX64.test(input.factsDigest ?? '')) throw new Error('buildAdaptivePrediction: catalog/feature identity malformed or differs from sealed procedure');
  if (!Array.isArray(input.strategyAssessments) || input.strategyAssessments.length !== procedure.strategies.length) throw new Error('buildAdaptivePrediction: every registered strategy needs one assessment');
  const byState = new Map(state.strategies.map((row) => [row.strategyId, row]));
  const strategyAssessments = input.strategyAssessments.map((assessment, index) => {
    const keys = exactKeys(assessment, ASSESSMENT_INPUT_KEYS); throwIf(keys && `assessment ${index} ${keys}`, 'buildAdaptivePrediction');
    if (assessment.strategyId !== procedure.strategies[index] || !ELIGIBILITY.has(assessment.eligibility) || !reason(assessment.reasonCode)) throw new Error(`buildAdaptivePrediction: assessment ${index} malformed or not canonical`);
    if (assessment.eligibility === 'ELIGIBLE' && assessment.reasonCode !== null) throw new Error(`buildAdaptivePrediction: eligible assessment ${index} has a reason`);
    if (assessment.eligibility !== 'ELIGIBLE' && assessment.reasonCode === null) throw new Error(`buildAdaptivePrediction: unavailable assessment ${index} lacks a reason`);
    return {
      strategyId: assessment.strategyId,
      eligibility: assessment.eligibility,
      forecastProbability: assessment.eligibility === 'ELIGIBLE' ? byState.get(assessment.strategyId).positive60mProbability : null,
      calibration: assessment.eligibility === 'ELIGIBLE' ? 'UNCALIBRATED_UNTIL_PROSPECTIVE_EVALUATION' : null,
      reasonCode: assessment.reasonCode,
    };
  });
  const selectionKeys = exactKeys(input.selection, SELECTION_KEYS); throwIf(selectionKeys && `selection ${selectionKeys}`, 'buildAdaptivePrediction');
  if (!reason(input.selection.reasonCode) || input.selection.reasonCode === null) throw new Error('buildAdaptivePrediction: selection reason required');
  if (input.selection.strategyId !== null) {
    const selected = strategyAssessments.find((row) => row.strategyId === input.selection.strategyId);
    if (!selected || selected.eligibility !== 'ELIGIBLE') throw new Error('buildAdaptivePrediction: selected strategy was not eligible');
  }
  const prediction = {
    predictionVersion: ADAPTIVE_PREDICTION_VERSION,
    predictionId: '', predictionDigest: '',
    procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
    opportunityId: input.opportunityId, identity: { ...input.identity },
    catalogContentId: input.catalogContentId, decisionTs: input.identity.decisionTs,
    predictionTs: input.predictionTs, recordedTs, horizonMs: input.horizonMs,
    targetEndTs,
    featureRecipeDigest: input.featureRecipeDigest, factsDigest: input.factsDigest,
    modelStateRef: { stateVersion: state.stateVersion, sequence: state.sequence, stateDigest: state.stateDigest },
    strategyAssessments,
    selection: { ...input.selection },
    authority: 'NONE', purpose: 'PRE_OUTCOME_ADAPTIVE_FORECAST',
  };
  prediction.predictionDigest = adaptivePredictionDigestOf(prediction);
  prediction.predictionId = predictionIdOf(prediction);
  throwIf(adaptivePredictionError(prediction, procedure, state), 'buildAdaptivePrediction');
  return deepFreeze(prediction);
}

export function adaptivePredictionError(prediction, procedure, expectedState = null) {
  const keys = exactKeys(prediction, PREDICTION_KEYS); if (keys) return `prediction ${keys}`;
  if (adaptiveProcedureError(procedure)) return 'procedure invalid';
  if (prediction.predictionVersion !== ADAPTIVE_PREDICTION_VERSION || prediction.procedureId !== procedure.procedureId
      || prediction.procedureDigest !== procedure.procedureDigest || prediction.horizonMs !== procedure.target.horizonMs) return 'prediction procedure/target mismatch';
  const identityErr = identityError(prediction.identity); if (identityErr) return `prediction identity ${identityErr}`;
  let expectedOpportunityId;
  try { expectedOpportunityId = opportunityIdOf(prediction.identity); } catch { return 'prediction opportunity identity malformed'; }
  if (prediction.opportunityId !== expectedOpportunityId || prediction.decisionTs !== prediction.identity.decisionTs
      || prediction.predictionTs !== prediction.decisionTs || prediction.targetEndTs !== anchorOf(prediction.predictionTs).anchorTsMs + prediction.horizonMs
      || !isTs(prediction.recordedTs) || prediction.recordedTs < prediction.predictionTs
      || prediction.recordedTs - prediction.predictionTs > procedure.target.maxPredictionPersistenceDelayMs
      || prediction.recordedTs >= prediction.targetEndTs) return 'prediction identity or chronology mismatch';
  if (!ID.test(prediction.catalogContentId ?? '') || prediction.featureRecipeDigest !== procedure.parent.featureRecipeDigest
      || !HEX64.test(prediction.factsDigest ?? '')) return 'prediction source identity malformed';
  const stateRefKeys = exactKeys(prediction.modelStateRef, STATE_REF_KEYS); if (stateRefKeys) return `model state ref ${stateRefKeys}`;
  if (prediction.modelStateRef.stateVersion !== ADAPTIVE_STATE_VERSION || !count(prediction.modelStateRef.sequence) || !HEX64.test(prediction.modelStateRef.stateDigest ?? '')) return 'model state ref malformed';
  if (expectedState && (prediction.modelStateRef.sequence !== expectedState.sequence || prediction.modelStateRef.stateDigest !== expectedState.stateDigest)) return 'prediction does not bind current model state';
  if (expectedState && expectedState.updatedTs > prediction.predictionTs) return 'prediction references model state not available at its decision';
  if (!Array.isArray(prediction.strategyAssessments) || prediction.strategyAssessments.length !== procedure.strategies.length) return 'prediction assessments malformed';
  for (let i = 0; i < prediction.strategyAssessments.length; i += 1) {
    const row = prediction.strategyAssessments[i]; const rowKeys = exactKeys(row, ASSESSMENT_KEYS); if (rowKeys) return `assessment ${i} ${rowKeys}`;
    if (row.strategyId !== procedure.strategies[i] || !ELIGIBILITY.has(row.eligibility) || !reason(row.reasonCode)) return `assessment ${i} malformed`;
    if (row.eligibility === 'ELIGIBLE') {
      if (!finiteIn(row.forecastProbability, procedure.algorithm.minProbability, procedure.algorithm.maxProbability)
          || row.calibration !== 'UNCALIBRATED_UNTIL_PROSPECTIVE_EVALUATION' || row.reasonCode !== null) return `assessment ${i} forecast malformed`;
      if (expectedState && row.forecastProbability !== expectedState.strategies[i].positive60mProbability) return `assessment ${i} did not use referenced state`;
    } else if (row.forecastProbability !== null || row.calibration !== null || row.reasonCode === null) return `assessment ${i} unavailable values malformed`;
  }
  const selectionKeys = exactKeys(prediction.selection, SELECTION_KEYS); if (selectionKeys) return `selection ${selectionKeys}`;
  if (!reason(prediction.selection.reasonCode) || prediction.selection.reasonCode === null) return 'selection reason malformed';
  if (prediction.selection.strategyId !== null && !prediction.strategyAssessments.some((row) => row.strategyId === prediction.selection.strategyId && row.eligibility === 'ELIGIBLE')) return 'selection is not eligible';
  if (prediction.authority !== 'NONE' || prediction.purpose !== 'PRE_OUTCOME_ADAPTIVE_FORECAST') return 'prediction authority malformed';
  if (!HEX64.test(prediction.predictionDigest ?? '') || prediction.predictionDigest !== adaptivePredictionDigestOf(prediction)
      || prediction.predictionId !== predictionIdOf(prediction)) return 'prediction digest mismatch';
  return null;
}

function outcomeIdOf(outcome) {
  return `aout-${adaptiveOutcomeDigestOf(outcome).slice(0, 40)}`;
}

export function buildAdaptiveOutcome({ procedure, prediction, input, recordedTs }) {
  throwIf(adaptiveProcedureError(procedure), 'buildAdaptiveOutcome');
  throwIf(adaptivePredictionError(prediction, procedure), 'buildAdaptiveOutcome');
  const keys = exactKeys(input, [
    'opportunityId', 'horizonMs', 'state', 'logReturnPct', 'sourceEventTs',
    'knownAtTs', 'sourceDigest', 'reasonCode',
  ]);
  throwIf(keys && `input ${keys}`, 'buildAdaptiveOutcome');
  if (input.opportunityId !== prediction.opportunityId || input.horizonMs !== prediction.horizonMs
      || !OUTCOME_STATES.has(input.state) || !isTs(recordedTs)) throw new Error('buildAdaptiveOutcome: identity, state, or record clock malformed');
  if (!HEX64.test(input.sourceDigest ?? '') || !reason(input.reasonCode)) throw new Error('buildAdaptiveOutcome: source digest/reason malformed');
  let updateEligibility;
  let targetValue = null;
  if (input.state === 'MATURED') {
    if (!isFiniteNum(input.logReturnPct) || Math.abs(input.logReturnPct) > 10_000
        || !isTs(input.sourceEventTs) || !isTs(input.knownAtTs)
        || input.sourceEventTs !== prediction.targetEndTs || input.sourceEventTs > input.knownAtTs
        || input.knownAtTs > recordedTs || input.reasonCode !== null) throw new Error('buildAdaptiveOutcome: matured value or clocks malformed');
    targetValue = input.logReturnPct > 0 ? 1 : 0;
    updateEligibility = input.knownAtTs - prediction.targetEndTs > procedure.target.maxLabelDelayMs
      ? 'INELIGIBLE_LATE'
      : prediction.strategyAssessments.some((row) => row.eligibility === 'ELIGIBLE') ? 'ELIGIBLE' : 'INELIGIBLE_NO_FORECAST';
  } else {
    if (input.logReturnPct !== null || input.sourceEventTs !== null || !isTs(input.knownAtTs)
        || input.knownAtTs < prediction.targetEndTs || input.knownAtTs > recordedTs || input.reasonCode === null) throw new Error('buildAdaptiveOutcome: missing outcome values malformed');
    updateEligibility = 'INELIGIBLE_MISSING';
  }
  const outcome = {
    outcomeVersion: ADAPTIVE_OUTCOME_VERSION, outcomeId: '', outcomeDigest: '',
    procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
    predictionId: prediction.predictionId, opportunityId: prediction.opportunityId,
    horizonMs: prediction.horizonMs, targetEndTs: prediction.targetEndTs,
    state: input.state, updateEligibility, logReturnPct: input.logReturnPct,
    targetValue, sourceEventTs: input.sourceEventTs, knownAtTs: input.knownAtTs,
    recordedTs, sourceDigest: input.sourceDigest, reasonCode: input.reasonCode,
    authority: 'NONE', purpose: 'MATURED_TARGET_FOR_SAVED_PREDICTION',
  };
  outcome.outcomeDigest = adaptiveOutcomeDigestOf(outcome);
  outcome.outcomeId = outcomeIdOf(outcome);
  throwIf(adaptiveOutcomeError(outcome, procedure, prediction), 'buildAdaptiveOutcome');
  return deepFreeze(outcome);
}

export function adaptiveOutcomeError(outcome, procedure, prediction) {
  const keys = exactKeys(outcome, OUTCOME_KEYS); if (keys) return `outcome ${keys}`;
  if (adaptiveProcedureError(procedure) || adaptivePredictionError(prediction, procedure)) return 'procedure or prediction invalid';
  if (outcome.outcomeVersion !== ADAPTIVE_OUTCOME_VERSION || outcome.procedureId !== procedure.procedureId
      || outcome.procedureDigest !== procedure.procedureDigest || outcome.predictionId !== prediction.predictionId
      || outcome.opportunityId !== prediction.opportunityId || outcome.horizonMs !== prediction.horizonMs
      || outcome.targetEndTs !== prediction.targetEndTs || !OUTCOME_STATES.has(outcome.state)
      || !UPDATE_ELIGIBILITY.has(outcome.updateEligibility) || !isTs(outcome.knownAtTs)
      || !isTs(outcome.recordedTs) || outcome.knownAtTs > outcome.recordedTs || !HEX64.test(outcome.sourceDigest ?? '')
      || !reason(outcome.reasonCode)) return 'outcome identity, clocks, or source malformed';
  if (outcome.state === 'MATURED') {
    if (!isFiniteNum(outcome.logReturnPct) || Math.abs(outcome.logReturnPct) > 10_000
        || ![0, 1].includes(outcome.targetValue) || outcome.targetValue !== (outcome.logReturnPct > 0 ? 1 : 0)
        || !isTs(outcome.sourceEventTs) || outcome.sourceEventTs !== prediction.targetEndTs
        || outcome.sourceEventTs > outcome.knownAtTs || outcome.reasonCode !== null) return 'matured outcome malformed';
    const expectedEligibility = outcome.knownAtTs - prediction.targetEndTs > procedure.target.maxLabelDelayMs
      ? 'INELIGIBLE_LATE'
      : prediction.strategyAssessments.some((row) => row.eligibility === 'ELIGIBLE') ? 'ELIGIBLE' : 'INELIGIBLE_NO_FORECAST';
    if (outcome.updateEligibility !== expectedEligibility) return 'matured outcome delay eligibility mismatch';
  } else if (outcome.logReturnPct !== null || outcome.targetValue !== null || outcome.sourceEventTs !== null
      || outcome.knownAtTs < prediction.targetEndTs || outcome.reasonCode === null
      || outcome.updateEligibility !== 'INELIGIBLE_MISSING') return 'missing outcome malformed';
  if (outcome.authority !== 'NONE' || outcome.purpose !== 'MATURED_TARGET_FOR_SAVED_PREDICTION') return 'outcome authority malformed';
  if (!HEX64.test(outcome.outcomeDigest ?? '') || outcome.outcomeDigest !== adaptiveOutcomeDigestOf(outcome)
      || outcome.outcomeId !== outcomeIdOf(outcome)) return 'outcome digest mismatch';
  return null;
}

function scoreIdOf(score) {
  return `ascr-${adaptiveScoreDigestOf(score).slice(0, 40)}`;
}

export function scoreAdaptiveOutcome({ procedure, prediction, outcome, scoredTs }) {
  throwIf(adaptiveOutcomeError(outcome, procedure, prediction), 'scoreAdaptiveOutcome');
  if (outcome.updateEligibility !== 'ELIGIBLE') return deepFreeze([]);
  if (!isTs(scoredTs) || scoredTs < outcome.knownAtTs) throw new Error('scoreAdaptiveOutcome: scoring precedes label knowledge');
  const scores = prediction.strategyAssessments.filter((row) => row.eligibility === 'ELIGIBLE').map((row) => {
    const score = {
      scoreVersion: ADAPTIVE_SCORE_VERSION, scoreId: '', scoreDigest: '',
      procedureId: procedure.procedureId, predictionId: prediction.predictionId,
      outcomeId: outcome.outcomeId, opportunityId: prediction.opportunityId,
      horizonMs: prediction.horizonMs, strategyId: row.strategyId,
      forecastProbability: row.forecastProbability, targetValue: outcome.targetValue,
      brierLoss: q((row.forecastProbability - outcome.targetValue) ** 2), scoredTs,
    };
    score.scoreDigest = adaptiveScoreDigestOf(score); score.scoreId = scoreIdOf(score);
    return score;
  });
  throwIf(adaptiveScoresError(scores, procedure, prediction, outcome), 'scoreAdaptiveOutcome');
  return deepFreeze(scores);
}

export function adaptiveScoresError(scores, procedure, prediction, outcome) {
  if (!Array.isArray(scores)) return 'scores not an array';
  if (adaptiveOutcomeError(outcome, procedure, prediction)) return 'outcome invalid';
  const expected = prediction.strategyAssessments.filter((row) => row.eligibility === 'ELIGIBLE');
  if (outcome.updateEligibility !== 'ELIGIBLE') return scores.length === 0 ? null : 'ineligible outcome has scores';
  if (scores.length !== expected.length) return 'score count does not match eligible strategies';
  for (let i = 0; i < scores.length; i += 1) {
    const score = scores[i]; const keys = exactKeys(score, SCORE_KEYS); if (keys) return `score ${i} ${keys}`;
    if (score.scoreVersion !== ADAPTIVE_SCORE_VERSION || score.procedureId !== procedure.procedureId
        || score.predictionId !== prediction.predictionId || score.outcomeId !== outcome.outcomeId
        || score.opportunityId !== prediction.opportunityId || score.horizonMs !== prediction.horizonMs
        || score.strategyId !== expected[i].strategyId || score.forecastProbability !== expected[i].forecastProbability
        || score.targetValue !== outcome.targetValue || score.brierLoss !== q((score.forecastProbability - score.targetValue) ** 2)
        || !isTs(score.scoredTs) || score.scoredTs < outcome.knownAtTs) return `score ${i} content mismatch`;
    if (!HEX64.test(score.scoreDigest ?? '') || score.scoreDigest !== adaptiveScoreDigestOf(score)
        || score.scoreId !== scoreIdOf(score)) return `score ${i} digest mismatch`;
  }
  return null;
}

function updateIdOf(update) {
  return adaptiveUpdateKeyOf(update);
}

function stateStrategyMap(state) {
  return new Map(state.strategies.map((row) => [row.strategyId, row]));
}

export function applyAdaptiveUpdate({ procedure, state, prediction, outcome, scores, appliedTs }) {
  throwIf(adaptiveStateError(state, procedure), 'applyAdaptiveUpdate');
  throwIf(adaptivePredictionError(prediction, procedure), 'applyAdaptiveUpdate');
  throwIf(adaptiveOutcomeError(outcome, procedure, prediction), 'applyAdaptiveUpdate');
  throwIf(adaptiveScoresError(scores, procedure, prediction, outcome), 'applyAdaptiveUpdate');
  if (outcome.updateEligibility !== 'ELIGIBLE') throw new Error('applyAdaptiveUpdate: outcome is not update eligible');
  if (!isTs(appliedTs) || appliedTs < Math.max(outcome.knownAtTs, ...scores.map((row) => row.scoredTs))) throw new Error('applyAdaptiveUpdate: update precedes score or label');
  const { update, nextState } = computeAdaptiveTransition({ procedure, state, prediction, outcome, scores, appliedTs });
  throwIf(adaptiveStateError(nextState, procedure), 'applyAdaptiveUpdate next state');
  throwIf(adaptiveUpdateError(update, procedure, state, prediction, outcome, scores, nextState), 'applyAdaptiveUpdate');
  return deepFreeze({ update, nextState });
}

export function adaptiveUpdateError(update, procedure, previousState, prediction, outcome, scores, nextState) {
  const keys = exactKeys(update, UPDATE_KEYS); if (keys) return `update ${keys}`;
  if (adaptiveStateError(previousState, procedure) || adaptiveStateError(nextState, procedure)
      || adaptiveScoresError(scores, procedure, prediction, outcome)) return 'update dependencies invalid';
  if (update.updateVersion !== ADAPTIVE_UPDATE_VERSION || update.procedureId !== procedure.procedureId
      || update.procedureDigest !== procedure.procedureDigest || update.predictionId !== prediction.predictionId
      || update.outcomeId !== outcome.outcomeId || update.opportunityId !== prediction.opportunityId
      || update.horizonMs !== prediction.horizonMs || update.previousStateDigest !== previousState.stateDigest
      || update.previousSequence !== previousState.sequence || update.nextStateDigest !== nextState.stateDigest
      || update.appliedTs !== nextState.updatedTs || nextState.sequence !== previousState.sequence + 1
      || !['APPLIED_WITHIN_BOUNDS', 'SCORED_NO_NUMERIC_MOVEMENT'].includes(update.movementStatus)) return 'update identity/state transition mismatch';
  if (!Array.isArray(update.deltas) || update.deltas.length !== scores.length) return 'update deltas malformed';
  for (let i = 0; i < update.deltas.length; i += 1) {
    const delta = update.deltas[i]; const deltaKeys = exactKeys(delta, DELTA_KEYS); if (deltaKeys) return `delta ${i} ${deltaKeys}`;
    if (delta.strategyId !== scores[i].strategyId || !isFiniteNum(delta.previousProbability)
        || !isFiniteNum(delta.nextProbability) || !isFiniteNum(delta.previousRankOffsetRrPoints)
        || !isFiniteNum(delta.rankDeltaRrPoints) || !isFiniteNum(delta.nextRankOffsetRrPoints)
        || Math.abs(delta.rankDeltaRrPoints) > procedure.algorithm.maxRankDeltaPerStrategyPerOutcome + ADAPTIVE_PRECISION) return `delta ${i} malformed or exceeds per-event cap`;
  }
  if (!finiteIn(update.episodeInfluenceBefore, 0, procedure.algorithm.maxEpisodeRankMovementRrPoints)
      || !finiteIn(update.episodeInfluenceAfter, update.episodeInfluenceBefore, procedure.algorithm.maxEpisodeRankMovementRrPoints)
      || !finiteIn(update.totalMovementBefore, 0, procedure.algorithm.maxCumulativeRankMovementRrPoints)
      || !finiteIn(update.totalMovementAfter, update.totalMovementBefore, procedure.algorithm.maxCumulativeRankMovementRrPoints)
      || update.totalMovementAfter !== nextState.totalRankMovementRrPoints) return 'update movement accounting malformed';
  if (!HEX64.test(update.updateDigest ?? '') || update.updateDigest !== adaptiveUpdateDigestOf(update)
      || update.updateId !== updateIdOf(update)) return 'update digest mismatch';
  const expected = computeAdaptiveTransition({ procedure, state: previousState, prediction, outcome, scores, appliedTs: update.appliedTs });
  if (!same(expected.update, update) || !same(expected.nextState, nextState)) return 'update does not match frozen algorithm';
  return null;
}

function computeAdaptiveTransition({ procedure, state, prediction, outcome, scores, appliedTs }) {
  const algorithm = procedure.algorithm;
  const previous = stateStrategyMap(state);
  const scoreByStrategy = new Map(scores.map((row) => [row.strategyId, row]));
  const raw = [];
  for (const strategyId of procedure.strategies) {
    const prior = previous.get(strategyId); const score = scoreByStrategy.get(strategyId); if (!score) continue;
    const dp = clamp(algorithm.learningRate * (score.targetValue - score.forecastProbability), -algorithm.maxProbabilityDeltaPerOutcome, algorithm.maxProbabilityDeltaPerOutcome);
    const candidate = clamp(prior.positive60mProbability + dp, algorithm.minProbability, algorithm.maxProbability);
    const dr = clamp(rankOffsetOf(candidate, procedure) - prior.rankOffsetRrPoints, -algorithm.maxRankDeltaPerStrategyPerOutcome, algorithm.maxRankDeltaPerStrategyPerOutcome);
    raw.push({ strategyId, prior, rankDelta: dr });
  }
  // V1 has exactly one horizon and the store permits exactly one outcome for a
  // primary opportunity. Variants and household accounts are not identities,
  // so this is the complete per-primary episode budget rather than a growing
  // in-state map. The append-only outcome/update indexes enforce the one use.
  const episodeBefore = 0;
  const rawMovement = raw.reduce((sum, row) => sum + Math.abs(row.rankDelta), 0);
  const allowedMovement = Math.min(rawMovement, Math.max(0, algorithm.maxEpisodeRankMovementRrPoints - episodeBefore), Math.max(0, algorithm.maxCumulativeRankMovementRrPoints - state.totalRankMovementRrPoints));
  const scale = rawMovement > 0 ? allowedMovement / rawMovement : 0;
  const deltas = raw.map(({ strategyId, prior, rankDelta }) => {
    const nextRank = q(clamp(prior.rankOffsetRrPoints + q(rankDelta * scale), -algorithm.maxAbsRankOffsetRrPoints, algorithm.maxAbsRankOffsetRrPoints));
    const nextProbability = q(clamp(algorithm.initialProbability + nextRank / algorithm.rankScaleRrPoints, algorithm.minProbability, algorithm.maxProbability));
    return { strategyId, previousProbability: prior.positive60mProbability, nextProbability, previousRankOffsetRrPoints: prior.rankOffsetRrPoints, rankDeltaRrPoints: q(nextRank - prior.rankOffsetRrPoints), nextRankOffsetRrPoints: rankOffsetOf(nextProbability, procedure) };
  });
  const actualMovement = q(deltas.reduce((sum, row) => sum + Math.abs(row.rankDeltaRrPoints), 0));
  const episodeAfter = q(episodeBefore + actualMovement); const totalAfter = q(state.totalRankMovementRrPoints + actualMovement);
  const dm = new Map(deltas.map((row) => [row.strategyId, row]));
  const strategies = state.strategies.map((prior) => dm.has(prior.strategyId) ? { strategyId: prior.strategyId, observations: prior.observations + 1, positive60mProbability: dm.get(prior.strategyId).nextProbability, rankOffsetRrPoints: dm.get(prior.strategyId).nextRankOffsetRrPoints } : { ...prior });
  const influenceLedgerDigest = canonicalDigest({
    version: 'adaptive-influence-ledger-1', previous: state.influenceLedgerDigest,
    predictionId: prediction.predictionId, outcomeId: outcome.outcomeId,
    usedRrPoints: episodeAfter,
  });
  const nextState = stateBody(
    procedure, state.sequence + 1, appliedTs, strategies,
    state.influencedEpisodes + 1, influenceLedgerDigest, totalAfter,
  );
  const update = { updateVersion: ADAPTIVE_UPDATE_VERSION, updateId: '', updateDigest: '', procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest, predictionId: prediction.predictionId, outcomeId: outcome.outcomeId, opportunityId: prediction.opportunityId, horizonMs: prediction.horizonMs, previousStateDigest: state.stateDigest, previousSequence: state.sequence, deltas, episodeInfluenceBefore: episodeBefore, episodeInfluenceAfter: episodeAfter, totalMovementBefore: state.totalRankMovementRrPoints, totalMovementAfter: totalAfter, nextStateDigest: nextState.stateDigest, appliedTs, movementStatus: actualMovement > 0 ? 'APPLIED_WITHIN_BOUNDS' : 'SCORED_NO_NUMERIC_MOVEMENT' };
  update.updateId = updateIdOf(update); update.updateDigest = adaptiveUpdateDigestOf(update);
  return { update, nextState };
}
