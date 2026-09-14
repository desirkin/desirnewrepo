// Typed qualification and PAPER decision projection for an evolving adaptive
// ranking PROCEDURE. Qualification binds the immutable procedure, initial
// state, update law, consumer law, scope and prospective trial. Later numerical
// states do not require requalification, but every decision uses one immutable
// ACK-backed state and remains inside the qualified procedure envelope.
//
// This grants no order, sizing, entry or exit authority. Trial execution is a
// hypothetical walk through subsequently observed depth, never an actual fill.
import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import {
  ADAPTIVE_HORIZON_MS, adaptivePredictionError, adaptiveProcedureError,
  adaptiveStateError, initialAdaptiveState,
} from './adaptive-registry.js';
import { adaptiveConsumerContractEnvelopeError } from './adaptive-qualified-bridge.js';
import {
  ADAPTIVE_RANKING_TRIAL_CAPTURE, ADAPTIVE_RANKING_TRIAL_OUTCOME,
  replayProspective,
} from './prospective.js';
import { evaluatePredicate } from './features.js';
import { captureError } from './shadow-contracts.js';
import { matureShadowCapture } from './shadow-outcome.js';

export const ADAPTIVE_PROCEDURE_CONSUMER_VERSION = 'adaptive-ranking-procedure-consumer-1';
export const ADAPTIVE_PROCEDURE_PUBLICATION_VERSION = 'adaptive-ranking-procedure-publication-1';
export const ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION = 'adaptive-ranking-trial-decision-1';
export const ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION = 'adaptive-ranking-trial-execution-1';
export const ADAPTIVE_PROCEDURE_QUALIFICATION_VERSION = 'adaptive-ranking-procedure-qualification-1';
export const ADAPTIVE_PROCEDURE_DECISION_VERSION = 'adaptive-ranking-procedure-decision-1';
export const MAX_ADAPTIVE_PROCEDURE_PUBLICATIONS = 32;
export const MAX_ADAPTIVE_TRIAL_RECORD_BYTES = 1_048_576;
export const MAX_ADAPTIVE_DECISION_INPUT_BYTES = 262_144;
export const MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS = 15 * 60_000;
export const ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC = 'PAIRED_EXECUTABLE_NET_RETURN_PCT';
export const ADAPTIVE_RANKING_TRIAL_COMPARATOR = 'EVOLVING_ADAPTIVE_RANKING_VS_UNADJUSTED_SAME_BATCH';
export const ADAPTIVE_RANKING_TRIAL_COST_MODEL = deepFreeze({
  modelVersion: 'adaptive-ranking-paired-shadow-execution-1',
  eachArmOwnSealedCostAndDepthPath: true,
  actualFillObserved: false,
});

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const clone = (value) => structuredClone(value);
const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);
const boundedId = (value) => typeof value === 'string' && ID.test(value);
const digestWithout = (value, omitted) => canonicalDigest(Object.fromEntries(
  Object.entries(value).filter(([key]) => !omitted.includes(key)),
));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

const DYNAMIC_CONSUMER_KEYS = Object.freeze([
  'consumerContractVersion', 'consumerId', 'policyDigest', 'preparedFactsContract',
  'preparedFactsContractDigest', 'featureRecipeDigest', 'eligibility', 'stateEffect',
  'validationSemantics', 'activationLifetimeMs', 'degradeRule', 'authority',
  'consumerContractDigest',
]);
const STATE_EFFECT_KEYS = Object.freeze([
  'effectVersion', 'axis', 'target', 'targetProducerVersion', 'rankingLawVersion',
  'transform', 'statePath', 'units', 'minimum', 'maximum', 'precision',
  'zeroEffectLaw', 'qualificationUnit',
]);
const PUBLICATION_KEYS = Object.freeze([
  'publicationVersion', 'publicationId', 'publicationDigest', 'procedure',
  'initialState', 'consumerContract', 'scope', 'applicability', 'trialLaw',
  'sealedTs', 'authority', 'purpose',
]);
const SCOPE_KEYS = Object.freeze(['setupType', 'regime', 'assets', 'venues']);
const TRIAL_LAW_KEYS = Object.freeze([
  'captureVersion', 'executionVersion', 'primaryMetric', 'comparator',
  'decisionInputLaw', 'stateLaw', 'armOutcomeLaw', 'actualFillClaim',
]);
const TRIAL_CAPTURE_KEYS = Object.freeze([
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
const CONTEXT_KEYS = Object.freeze(['setupType', 'regime', 'asset', 'venue']);
const RANK_KEYS = Object.freeze(['strategyId', 'baselineRewardRiskRatio']);
const ARM_KEYS = Object.freeze(['selectedStrategyId', 'executionCapture']);
const TRIAL_EXECUTION_KEYS = Object.freeze([
  'executionVersion', 'executionId', 'executionDigest', 'publicationId',
  'candidateId', 'opportunityId', 'decisionId', 'candidate', 'baseline',
  'outcomeKnownAtTs', 'recordedTs', 'authority', 'purpose',
]);
const EXECUTION_ARM_KEYS = Object.freeze(['selectedStrategyId', 'path', 'depthPath', 'asOfTs', 'outcome']);
const QUALIFICATION_KEYS = Object.freeze([
  'qualificationVersion', 'qualificationId', 'qualificationDigest',
  'publicationId', 'publicationDigest', 'procedureId', 'procedureDigest',
  'initialStateDigest', 'consumerContractDigest', 'stateEffect', 'scope',
  'applicability', 'candidateId', 'candidateDigest', 'activationId',
  'terminalReportDigest', 'qualifiedTs', 'effectiveTs', 'expiresTs',
  'authority', 'purpose',
]);
const STATE_SOURCE_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'predictionId', 'outcomeId', 'updateId',
  'receiptDigest', 'eventSequence', 'eventDigest', 'durableAcknowledgment',
]);
const SETTLEMENT_ACK_KEYS = Object.freeze(['ackVersion', 'sequence', 'eventDigest', 'headDigest', 'acknowledgedTs']);
const DECISION_KEYS = Object.freeze([
  'decisionVersion', 'preparedTs', 'mode', 'kill', 'adaptiveRankingProcedure',
  'withheld', 'authority',
]);
const ADAPTIVE_SECTION_KEYS = Object.freeze([
  'consumerContractDigest', 'procedureId', 'procedureDigest', 'currentState',
  'stateSource', 'qualification', 'publication', 'legacyActivationEffectReinterpreted',
  'authority',
]);

function scopeError(scope) {
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

function applicabilityError(value) {
  if (!isPlainObject(value) || exactKeys(value, ['clauses']) || !Array.isArray(value.clauses)
      || value.clauses.length < 1 || value.clauses.length > 32) return 'shape malformed';
  for (const clause of value.clauses) if (exactKeys(clause, ['feature', 'op', 'threshold'])
      || !boundedId(clause.feature) || !['GT', 'GTE', 'LT', 'LTE'].includes(clause.op)
      || !isFiniteNum(clause.threshold)) return 'clause malformed';
  return null;
}

export function sealAdaptiveProcedureConsumerContract({ preparedFactsContract } = {}) {
  const baseError = adaptiveConsumerContractEnvelopeError(preparedFactsContract);
  if (baseError) throw new TypeError(`prepared facts contract: ${baseError}`);
  const body = {
    consumerContractVersion: ADAPTIVE_PROCEDURE_CONSUMER_VERSION,
    consumerId: 'COBRA_JUDGE_ADMISSION_BATCH_EVOLVING_RANK',
    policyDigest: preparedFactsContract.policyDigest,
    preparedFactsContract: clone(preparedFactsContract),
    preparedFactsContractDigest: preparedFactsContract.consumerContractDigest,
    featureRecipeDigest: preparedFactsContract.featureRecipeDigest,
    eligibility: clone(preparedFactsContract.eligibility),
    stateEffect: {
      effectVersion: 'adaptive-current-state-rank-effect-1', axis: 'RANKING',
      target: 'REWARD_RISK_RATIO', targetProducerVersion: 'judge-cost-paper-reference-1',
      rankingLawVersion: 'judge-risk-paper-reference-1',
      transform: 'ADD_CURRENT_ACKED_STATE_OFFSET_IF_APPLICABLE',
      statePath: 'strategies[strategyId].rankOffsetRrPoints',
      units: 'REWARD_RISK_RATIO_POINTS', minimum: -0.15, maximum: 0.15,
      precision: 1e-9, zeroEffectLaw: 'QUALIFIED_ZERO_PRESERVES_BASELINE',
      qualificationUnit: 'WHOLE_FROZEN_ADAPTIVE_PROCEDURE_NOT_ONE_NUMERIC_STATE',
    },
    validationSemantics: {
      experimentalUnit: 'ADMISSION_BATCH',
      baselineArm: 'SAME_BATCH_UNADJUSTED_REWARD_RISK_RATIO',
      candidateArm: 'SAME_BATCH_CURRENT_ACKED_ADAPTIVE_STATE',
      decisionOutput: 'SELECTED_STRATEGY_ID', noOrderAuthority: true,
    },
    activationLifetimeMs: preparedFactsContract.activationLifetimeMs,
    degradeRule: clone(preparedFactsContract.degradeRule), authority: 'NONE',
  };
  const consumerContractDigest = canonicalDigest(body);
  const out = { ...body, consumerContractDigest };
  const error = adaptiveProcedureConsumerContractError(out);
  if (error) throw new TypeError(error);
  return deepFreeze(out);
}

export function adaptiveProcedureConsumerContractError(contract) {
  if (exactKeys(contract, DYNAMIC_CONSUMER_KEYS)) return 'dynamic consumer shape malformed';
  if (contract.consumerContractVersion !== ADAPTIVE_PROCEDURE_CONSUMER_VERSION
      || contract.consumerId !== 'COBRA_JUDGE_ADMISSION_BATCH_EVOLVING_RANK'
      || !HEX64.test(contract.policyDigest ?? '') || !HEX64.test(contract.featureRecipeDigest ?? '')
      || !HEX64.test(contract.preparedFactsContractDigest ?? '')
      || adaptiveConsumerContractEnvelopeError(contract.preparedFactsContract)
      || contract.preparedFactsContract.consumerContractDigest !== contract.preparedFactsContractDigest
      || contract.preparedFactsContract.policyDigest !== contract.policyDigest
      || contract.preparedFactsContract.featureRecipeDigest !== contract.featureRecipeDigest
      || !same(contract.eligibility, contract.preparedFactsContract.eligibility)) return 'dynamic consumer parent mismatch';
  const effect = contract.stateEffect;
  if (exactKeys(effect, STATE_EFFECT_KEYS) || effect.effectVersion !== 'adaptive-current-state-rank-effect-1'
      || effect.axis !== 'RANKING' || effect.target !== 'REWARD_RISK_RATIO'
      || effect.targetProducerVersion !== 'judge-cost-paper-reference-1'
      || effect.rankingLawVersion !== 'judge-risk-paper-reference-1'
      || effect.transform !== 'ADD_CURRENT_ACKED_STATE_OFFSET_IF_APPLICABLE'
      || effect.statePath !== 'strategies[strategyId].rankOffsetRrPoints'
      || effect.units !== 'REWARD_RISK_RATIO_POINTS' || effect.minimum !== -0.15
      || effect.maximum !== 0.15 || effect.precision !== 1e-9
      || effect.zeroEffectLaw !== 'QUALIFIED_ZERO_PRESERVES_BASELINE'
      || effect.qualificationUnit !== 'WHOLE_FROZEN_ADAPTIVE_PROCEDURE_NOT_ONE_NUMERIC_STATE') return 'dynamic state effect malformed';
  if (!same(contract.validationSemantics, {
    experimentalUnit: 'ADMISSION_BATCH', baselineArm: 'SAME_BATCH_UNADJUSTED_REWARD_RISK_RATIO',
    candidateArm: 'SAME_BATCH_CURRENT_ACKED_ADAPTIVE_STATE', decisionOutput: 'SELECTED_STRATEGY_ID', noOrderAuthority: true,
  }) || contract.activationLifetimeMs !== contract.preparedFactsContract.activationLifetimeMs
      || !same(contract.degradeRule, contract.preparedFactsContract.degradeRule)
      || contract.authority !== 'NONE' || !HEX64.test(contract.consumerContractDigest ?? '')
      || digestWithout(contract, ['consumerContractDigest']) !== contract.consumerContractDigest) return 'dynamic consumer semantics or digest malformed';
  return null;
}

function trialLaw() {
  return {
    captureVersion: ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION,
    executionVersion: ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION,
    primaryMetric: ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC,
    comparator: ADAPTIVE_RANKING_TRIAL_COMPARATOR,
    decisionInputLaw: 'FULL_PREPARED_FACTS_PLUS_ACKED_ORIGINAL_PREDICTION_BEFORE_LABEL',
    stateLaw: 'INITIAL_STATE_AND_UPDATE_EQUATIONS_FROZEN_AT_LEAST_TWO_ACKED_STATE_DIGESTS_AND_POSITIVE_NEGATIVE_ZERO_EFFECTS_OBSERVED',
    armOutcomeLaw: 'EACH_SELECTED_STRATEGY_RECOMPUTED_FROM_OWN_SUBSEQUENT_OBSERVED_DEPTH_PATH_AFTER_COSTS',
    actualFillClaim: false,
  };
}

export function sealAdaptiveProcedurePublication({
  procedure, initialState, consumerContract, scope, applicability, sealedTs,
} = {}) {
  if (adaptiveProcedureError(procedure)) throw new TypeError('procedure invalid');
  if (adaptiveProcedureConsumerContractError(consumerContract)) throw new TypeError('dynamic consumer invalid');
  const expectedInitial = initialAdaptiveState(procedure, { initializedTs: procedure.createdTs });
  if (adaptiveStateError(initialState, procedure) || !same(initialState, expectedInitial)) throw new TypeError('exact initial procedure state required');
  if (procedure.parent.policyDigest !== consumerContract.policyDigest
      || procedure.parent.consumerContractDigest !== consumerContract.consumerContractDigest
      || procedure.parent.featureRecipeDigest !== consumerContract.featureRecipeDigest
      || procedure.algorithm.maxAbsRankOffsetRrPoints > consumerContract.stateEffect.maximum) throw new TypeError('procedure parent/envelope differs from dynamic consumer');
  if (scopeError(scope) || applicabilityError(applicability) || !isTs(sealedTs)
      || sealedTs < procedure.createdTs || sealedTs < initialState.updatedTs) throw new TypeError('publication scope, applicability or clock malformed');
  const body = {
    publicationVersion: ADAPTIVE_PROCEDURE_PUBLICATION_VERSION,
    procedure: clone(procedure), initialState: clone(initialState), consumerContract: clone(consumerContract),
    scope: clone(scope), applicability: clone(applicability), trialLaw: trialLaw(), sealedTs,
    authority: 'NONE', purpose: 'EXACT_EVOLVING_PROCEDURE_REQUIRING_PROSPECTIVE_PROMOTION',
  };
  const publicationDigest = canonicalDigest(body);
  const out = { ...body, publicationId: `arproc-${publicationDigest.slice(0, 40)}`, publicationDigest };
  const error = adaptiveProcedurePublicationError(out);
  if (error) throw new TypeError(error);
  return deepFreeze(out);
}

export function adaptiveProcedurePublicationError(publication, { currentConsumerContract = null } = {}) {
  if (exactKeys(publication, PUBLICATION_KEYS)) return 'procedure publication shape malformed';
  if (publication.publicationVersion !== ADAPTIVE_PROCEDURE_PUBLICATION_VERSION
      || adaptiveProcedureError(publication.procedure)
      || adaptiveStateError(publication.initialState, publication.procedure)
      || !same(publication.initialState, initialAdaptiveState(publication.procedure, { initializedTs: publication.procedure.createdTs }))
      || adaptiveProcedureConsumerContractError(publication.consumerContract)
      || publication.procedure.parent.consumerContractDigest !== publication.consumerContract.consumerContractDigest
      || publication.procedure.parent.policyDigest !== publication.consumerContract.policyDigest
      || publication.procedure.parent.featureRecipeDigest !== publication.consumerContract.featureRecipeDigest
      || publication.procedure.algorithm.maxAbsRankOffsetRrPoints > publication.consumerContract.stateEffect.maximum
      || scopeError(publication.scope) || applicabilityError(publication.applicability)
      || exactKeys(publication.trialLaw, TRIAL_LAW_KEYS) || !same(publication.trialLaw, trialLaw())
      || !isTs(publication.sealedTs) || publication.sealedTs < publication.procedure.createdTs
      || publication.authority !== 'NONE'
      || publication.purpose !== 'EXACT_EVOLVING_PROCEDURE_REQUIRING_PROSPECTIVE_PROMOTION'
      || !HEX64.test(publication.publicationDigest ?? '')
      || digestWithout(publication, ['publicationId', 'publicationDigest']) !== publication.publicationDigest
      || publication.publicationId !== `arproc-${publication.publicationDigest.slice(0, 40)}`) return 'procedure publication semantics or digest malformed';
  if (currentConsumerContract !== null && !same(publication.consumerContract, currentConsumerContract)) return 'current dynamic consumer differs';
  return null;
}

function scopeAllows(scope, context) {
  const field = (declared, value) => declared === 'ANY' || declared === value;
  const listed = (declared, value) => declared === 'ANY' || declared.includes(value);
  return field(scope.setupType, context.setupType) && field(scope.regime, context.regime)
    && listed(scope.assets, context.asset) && listed(scope.venues, context.venue);
}

function predictionAckError(ack, prediction, recordedTs) {
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

function rankDecision(procedure, state, rows, adaptive) {
  const byState = new Map(state.strategies.map((row) => [row.strategyId, row]));
  const eligible = new Set();
  const ranked = rows.map((row, index) => {
    const assessment = procedure.strategies[index];
    const predicted = assessment === row.strategyId;
    if (!predicted) return null;
    eligible.add(row.strategyId);
    const offset = adaptive ? byState.get(row.strategyId)?.rankOffsetRrPoints : 0;
    return { strategyId: row.strategyId, value: row.baselineRewardRiskRatio + offset, index };
  });
  if (ranked.some((row) => row === null) || eligible.size !== procedure.strategies.length) return null;
  ranked.sort((a, b) => b.value - a.value || a.index - b.index);
  return ranked[0]?.strategyId ?? null;
}

function armCaptureError(arm, selectedStrategyId, publication, decisionTs, context) {
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

export function sealAdaptiveRankingTrialDecision({
  publication, candidateId, opportunityId, adaptiveState, prediction,
  predictionAck, preparedFacts, context, rankCandidates, baselineArm,
  candidateArm, recordedTs, validatePreparedFacts, adaptiveStore,
} = {}) {
  if (adaptiveProcedurePublicationError(publication)) throw new TypeError('publication invalid');
  if (!boundedId(candidateId) || opportunityId !== prediction?.opportunityId
      || adaptiveStateError(adaptiveState, publication.procedure)
      || adaptivePredictionError(prediction, publication.procedure, adaptiveState)) {
    throw new TypeError('trial identity, state, or prediction invalid');
  }
  if (!adaptiveStore || typeof adaptiveStore.prediction !== 'function'
      || typeof adaptiveStore.state !== 'function') throw new TypeError('ACK-backed adaptive reader required');
  let storedPrediction; let storedState;
  try {
    storedPrediction = adaptiveStore.prediction({ opportunityId, horizonMs: prediction.horizonMs });
    storedState = adaptiveStore.state();
  } catch { throw new TypeError('ACK-backed adaptive reader unavailable'); }
  if (!storedPrediction || !same(storedPrediction, prediction) || !same(storedState, adaptiveState)) {
    throw new TypeError('prediction or state is not the current ACK-backed content');
  }
  if (!isTs(recordedTs) || recordedTs < prediction.recordedTs
      || recordedTs >= prediction.targetEndTs || recordedTs - prediction.decisionTs > MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS) {
    throw new TypeError('trial decision clock malformed or stale');
  }
  const ackError = predictionAckError(predictionAck, prediction, recordedTs);
  if (ackError) throw new TypeError(ackError);
  if (typeof validatePreparedFacts !== 'function'
      || validatePreparedFacts(preparedFacts, publication.consumerContract.preparedFactsContract) !== null
      || bytes(preparedFacts) > MAX_ADAPTIVE_DECISION_INPUT_BYTES
      || preparedFacts.decisionTs !== prediction.decisionTs
      || preparedFacts.factsDigest !== prediction.factsDigest
      || preparedFacts.featureRecipeDigest !== publication.consumerContract.featureRecipeDigest) {
    throw new TypeError('full prepared decision facts invalid or differ from prediction');
  }
  if (exactKeys(context, CONTEXT_KEYS) || context.asset !== prediction.identity.canonicalCoin
      || preparedFacts.marketIdentity?.canonicalCoin !== context.asset
      || !scopeAllows(publication.scope, context)
      || evaluatePredicate(publication.applicability, preparedFacts) !== 'TRUE') {
    throw new TypeError('trial context is outside publication scope/applicability');
  }
  if (!Array.isArray(rankCandidates) || rankCandidates.length !== publication.procedure.strategies.length) {
    throw new TypeError('every registered strategy requires one baseline rank input');
  }
  const ranks = rankCandidates.map((row, index) => {
    if (exactKeys(row, RANK_KEYS) || row.strategyId !== publication.procedure.strategies[index]
        || !isFiniteNum(row.baselineRewardRiskRatio) || row.baselineRewardRiskRatio < -100
        || row.baselineRewardRiskRatio > 100) throw new TypeError(`rank candidate ${index} malformed`);
    if (prediction.strategyAssessments[index].eligibility !== 'ELIGIBLE') {
      throw new TypeError('trial rank candidate lacks an eligible saved forecast');
    }
    return clone(row);
  });
  const baselineSelectedStrategyId = rankDecision(publication.procedure, adaptiveState, ranks, false);
  const candidateSelectedStrategyId = rankDecision(publication.procedure, adaptiveState, ranks, true);
  if (!baselineSelectedStrategyId || !candidateSelectedStrategyId
      || prediction.selection.strategyId !== candidateSelectedStrategyId) {
    throw new TypeError('saved adaptive selection differs from recomputed current-state rank');
  }
  const baselineError = armCaptureError(baselineArm, baselineSelectedStrategyId, publication, prediction.decisionTs, context);
  const candidateError = armCaptureError(candidateArm, candidateSelectedStrategyId, publication, prediction.decisionTs, context);
  if (baselineError || candidateError) throw new TypeError(baselineError ?? candidateError);
  if (baselineSelectedStrategyId === candidateSelectedStrategyId && !same(baselineArm, candidateArm)) {
    throw new TypeError('unchanged selection requires the exact same execution arm');
  }
  const expectedLabelEnd = Math.max(
    baselineArm.executionCapture.decisionTs
      + baselineArm.executionCapture.recipeSeal.recipe.horizonMin * 60_000,
    candidateArm.executionCapture.decisionTs
      + candidateArm.executionCapture.recipeSeal.recipe.horizonMin * 60_000,
    prediction.targetEndTs,
  );
  const body = {
    decisionVersion: ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION,
    publicationId: publication.publicationId, candidateId, opportunityId,
    canonicalCoin: context.asset, decisionTs: prediction.decisionTs,
    labelEndTs: expectedLabelEnd, recordedTs,
    procedureId: publication.procedure.procedureId,
    procedureDigest: publication.procedure.procedureDigest,
    adaptiveState: clone(adaptiveState), prediction: clone(prediction),
    predictionAck: clone(predictionAck), preparedFacts: clone(preparedFacts),
    preparedFactsDigest: canonicalDigest(preparedFacts), context: clone(context),
    rankCandidates: ranks, baselineSelectedStrategyId, candidateSelectedStrategyId,
    baselineArm: clone(baselineArm), candidateArm: clone(candidateArm),
    authority: 'NONE', purpose: 'PRE_LABEL_EVOLVING_RANKING_TRIAL_DECISION',
  };
  const decisionDigest = canonicalDigest(body);
  const out = { ...body, decisionId: `artriald-${decisionDigest.slice(0, 40)}`, decisionDigest };
  const error = adaptiveRankingTrialDecisionError(out, {
    publication, validatePreparedFacts, adaptiveStore,
  });
  if (error) throw new TypeError(error);
  if (bytes(out) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) throw new TypeError('trial decision exceeds record byte limit');
  return deepFreeze(out);
}

export function adaptiveRankingTrialDecisionError(receipt, {
  publication, validatePreparedFacts, adaptiveStore, requireCurrentState = true,
} = {}) {
  if (exactKeys(receipt, TRIAL_CAPTURE_KEYS)) return 'trial decision shape malformed';
  if (adaptiveProcedurePublicationError(publication)
      || receipt.decisionVersion !== ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION
      || receipt.publicationId !== publication.publicationId
      || receipt.procedureId !== publication.procedure.procedureId
      || receipt.procedureDigest !== publication.procedure.procedureDigest
      || !boundedId(receipt.candidateId) || receipt.opportunityId !== receipt.prediction?.opportunityId
      || receipt.canonicalCoin !== receipt.context?.asset
      || adaptiveStateError(receipt.adaptiveState, publication.procedure)
      || adaptivePredictionError(receipt.prediction, publication.procedure, receipt.adaptiveState)
      || receipt.decisionTs !== receipt.prediction.decisionTs
      || !isTs(receipt.recordedTs) || !isTs(receipt.labelEndTs)
      || receipt.recordedTs < receipt.prediction.recordedTs
      || receipt.recordedTs >= receipt.labelEndTs
      || receipt.recordedTs - receipt.decisionTs > MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS) {
    return 'trial decision identity/state/clock malformed';
  }
  const ackError = predictionAckError(receipt.predictionAck, receipt.prediction, receipt.recordedTs);
  if (ackError) return ackError;
  if (typeof validatePreparedFacts !== 'function'
      || validatePreparedFacts(receipt.preparedFacts, publication.consumerContract.preparedFactsContract) !== null
      || bytes(receipt.preparedFacts) > MAX_ADAPTIVE_DECISION_INPUT_BYTES
      || receipt.preparedFacts.decisionTs !== receipt.decisionTs
      || receipt.preparedFacts.factsDigest !== receipt.prediction.factsDigest
      || receipt.preparedFacts.featureRecipeDigest !== publication.consumerContract.featureRecipeDigest
      || receipt.preparedFactsDigest !== canonicalDigest(receipt.preparedFacts)) return 'trial prepared facts invalid or unbound';
  if (exactKeys(receipt.context, CONTEXT_KEYS)
      || receipt.preparedFacts.marketIdentity?.canonicalCoin !== receipt.context.asset
      || !scopeAllows(publication.scope, receipt.context)
      || evaluatePredicate(publication.applicability, receipt.preparedFacts) !== 'TRUE') return 'trial context/applicability mismatch';
  if (!Array.isArray(receipt.rankCandidates)
      || receipt.rankCandidates.length !== publication.procedure.strategies.length) return 'trial rank candidates malformed';
  for (let index = 0; index < receipt.rankCandidates.length; index += 1) {
    const row = receipt.rankCandidates[index];
    if (exactKeys(row, RANK_KEYS) || row.strategyId !== publication.procedure.strategies[index]
        || !isFiniteNum(row.baselineRewardRiskRatio) || row.baselineRewardRiskRatio < -100
        || row.baselineRewardRiskRatio > 100
        || receipt.prediction.strategyAssessments[index].eligibility !== 'ELIGIBLE') return 'trial rank candidate invalid';
  }
  const baseline = rankDecision(publication.procedure, receipt.adaptiveState, receipt.rankCandidates, false);
  const candidate = rankDecision(publication.procedure, receipt.adaptiveState, receipt.rankCandidates, true);
  if (receipt.baselineSelectedStrategyId !== baseline || receipt.candidateSelectedStrategyId !== candidate
      || receipt.prediction.selection.strategyId !== candidate) return 'trial selected strategy was not recomputed';
  const baselineError = armCaptureError(receipt.baselineArm, baseline, publication, receipt.decisionTs, receipt.context);
  const candidateError = armCaptureError(receipt.candidateArm, candidate, publication, receipt.decisionTs, receipt.context);
  if (baselineError || candidateError) return baselineError ?? candidateError;
  if (baseline === candidate && !same(receipt.baselineArm, receipt.candidateArm)) return 'same selection arm mismatch';
  const expectedLabelEnd = Math.max(
    receipt.baselineArm.executionCapture.decisionTs
      + receipt.baselineArm.executionCapture.recipeSeal.recipe.horizonMin * 60_000,
    receipt.candidateArm.executionCapture.decisionTs
      + receipt.candidateArm.executionCapture.recipeSeal.recipe.horizonMin * 60_000,
    receipt.prediction.targetEndTs,
  );
  if (receipt.labelEndTs !== expectedLabelEnd || receipt.authority !== 'NONE'
      || receipt.purpose !== 'PRE_LABEL_EVOLVING_RANKING_TRIAL_DECISION'
      || !HEX64.test(receipt.decisionDigest ?? '')
      || digestWithout(receipt, ['decisionId', 'decisionDigest']) !== receipt.decisionDigest
      || receipt.decisionId !== `artriald-${receipt.decisionDigest.slice(0, 40)}`
      || bytes(receipt) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) return 'trial decision digest, horizon, authority, or bound malformed';
  if (!adaptiveStore || typeof adaptiveStore.prediction !== 'function' || typeof adaptiveStore.state !== 'function') return 'ACK-backed adaptive reader absent';
  try {
    const stored = adaptiveStore.prediction({ opportunityId: receipt.opportunityId, horizonMs: receipt.prediction.horizonMs });
    if (!stored || !same(stored, receipt.prediction)
        || (requireCurrentState && !same(adaptiveStore.state(), receipt.adaptiveState))) return 'trial state/prediction not ACK-backed content';
  } catch { return 'ACK-backed adaptive reader unavailable'; }
  return null;
}

function recomputeExecutionArm(arm, decisionArm) {
  if (exactKeys(arm, EXECUTION_ARM_KEYS)
      || arm.selectedStrategyId !== decisionArm.selectedStrategyId
      || !isTs(arm.asOfTs)) return { error: 'execution arm shape or identity malformed' };
  const capture = decisionArm.executionCapture;
  const expectedRows = capture.recipeSeal.recipe.horizonMin * 60_000
    / capture.recipeSeal.recipe.candlePeriodMs;
  if (!Number.isSafeInteger(expectedRows) || !Array.isArray(arm.path)
      || arm.path.length !== expectedRows || bytes(arm) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES / 2) {
    return { error: 'execution arm path/byte bound malformed' };
  }
  let expected;
  try {
    expected = matureShadowCapture({
      capture: decisionArm.executionCapture,
      path: arm.path,
      depthPath: arm.depthPath,
      asOfTs: arm.asOfTs,
    });
  } catch (error) { return { error: `execution arm cannot be recomputed (${error.message})` }; }
  if (!same(expected, arm.outcome)) return { error: 'execution arm outcome differs from deterministic replay' };
  if (!String(expected.label).startsWith('MATURED')
      || expected.fidelity !== 'DEPTH_SUPPORTED'
      || expected.sizeEvidence !== 'DEPTH_SUPPORTED_OBSERVED'
      || !isFiniteNum(expected.netPct)
      || expected.entry?.executionEvidence?.actualFillObserved !== false
      || expected.exit?.executionEvidence?.actualFillObserved !== false) {
    return { error: 'execution arm lacks matured complete hypothetical depth accounting' };
  }
  return { error: null, outcome: expected };
}

export function sealAdaptiveRankingTrialExecution({
  publication, decisionReceipt, candidate, baseline, recordedTs,
  validatePreparedFacts, adaptiveStore,
} = {}) {
  const decisionError = adaptiveRankingTrialDecisionError(decisionReceipt, {
    publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
  });
  if (decisionError) throw new TypeError(decisionError);
  const candidateResult = recomputeExecutionArm(candidate, decisionReceipt.candidateArm);
  const baselineResult = recomputeExecutionArm(baseline, decisionReceipt.baselineArm);
  if (candidateResult.error || baselineResult.error) throw new TypeError(candidateResult.error ?? baselineResult.error);
  if (decisionReceipt.candidateSelectedStrategyId === decisionReceipt.baselineSelectedStrategyId
      && !same(candidate, baseline)) throw new TypeError('unchanged selection requires identical execution evidence');
  const outcomeKnownAtTs = Math.max(candidate.asOfTs, baseline.asOfTs);
  if (!isTs(recordedTs) || recordedTs < outcomeKnownAtTs
      || outcomeKnownAtTs < decisionReceipt.labelEndTs) throw new TypeError('trial execution clock precedes maturity');
  const body = {
    executionVersion: ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION,
    publicationId: publication.publicationId, candidateId: decisionReceipt.candidateId,
    opportunityId: decisionReceipt.opportunityId, decisionId: decisionReceipt.decisionId,
    candidate: clone(candidate), baseline: clone(baseline), outcomeKnownAtTs,
    recordedTs, authority: 'NONE', purpose: 'POST_LABEL_PAIRED_HYPOTHETICAL_DEPTH_EXECUTION',
  };
  const executionDigest = canonicalDigest(body);
  const out = { ...body, executionId: `artriale-${executionDigest.slice(0, 40)}`, executionDigest };
  const error = adaptiveRankingTrialExecutionError(out, {
    publication, decisionReceipt, validatePreparedFacts, adaptiveStore,
  });
  if (error) throw new TypeError(error);
  if (bytes(out) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) throw new TypeError('trial execution exceeds record byte limit');
  return deepFreeze(out);
}

export function adaptiveRankingTrialExecutionError(receipt, {
  publication, decisionReceipt, validatePreparedFacts, adaptiveStore,
} = {}) {
  if (exactKeys(receipt, TRIAL_EXECUTION_KEYS)) return 'trial execution shape malformed';
  const decisionError = adaptiveRankingTrialDecisionError(decisionReceipt, {
    publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
  });
  if (decisionError) return `trial execution decision invalid (${decisionError})`;
  if (receipt.executionVersion !== ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION
      || receipt.publicationId !== publication.publicationId
      || receipt.candidateId !== decisionReceipt.candidateId
      || receipt.opportunityId !== decisionReceipt.opportunityId
      || receipt.decisionId !== decisionReceipt.decisionId) return 'trial execution identity mismatch';
  const candidate = recomputeExecutionArm(receipt.candidate, decisionReceipt.candidateArm);
  const baseline = recomputeExecutionArm(receipt.baseline, decisionReceipt.baselineArm);
  if (candidate.error || baseline.error) return candidate.error ?? baseline.error;
  if (decisionReceipt.candidateSelectedStrategyId === decisionReceipt.baselineSelectedStrategyId
      && !same(receipt.candidate, receipt.baseline)) return 'unchanged selection execution differs';
  const knownAt = Math.max(receipt.candidate.asOfTs, receipt.baseline.asOfTs);
  if (receipt.outcomeKnownAtTs !== knownAt || receipt.outcomeKnownAtTs < decisionReceipt.labelEndTs
      || !isTs(receipt.recordedTs) || receipt.recordedTs < knownAt
      || receipt.authority !== 'NONE'
      || receipt.purpose !== 'POST_LABEL_PAIRED_HYPOTHETICAL_DEPTH_EXECUTION'
      || !HEX64.test(receipt.executionDigest ?? '')
      || digestWithout(receipt, ['executionId', 'executionDigest']) !== receipt.executionDigest
      || receipt.executionId !== `artriale-${receipt.executionDigest.slice(0, 40)}`
      || bytes(receipt) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) return 'trial execution clock, digest, authority, or bound malformed';
  return null;
}

export function adaptiveRankingTrialRecordValidator({
  publications, validatePreparedFacts, adaptiveStore,
} = {}) {
  if (!Array.isArray(publications) || publications.length > MAX_ADAPTIVE_PROCEDURE_PUBLICATIONS
      || typeof validatePreparedFacts !== 'function' || !adaptiveStore) {
    throw new TypeError('bounded publications, prepared-facts validator and adaptive store are required');
  }
  const byId = new Map();
  for (const publication of publications) {
    const error = adaptiveProcedurePublicationError(publication);
    if (error || byId.has(publication.publicationId)) throw new TypeError(error ?? 'duplicate publication');
    byId.set(publication.publicationId, publication);
  }
  return (record, { stage, design, capture } = {}) => {
    try {
      const publication = byId.get(record?.publicationId);
      if (!publication || design.evidenceDigest !== publication.publicationId
          || design.primaryMetric !== ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC
          || design.comparator !== ADAPTIVE_RANKING_TRIAL_COMPARATOR
          || !same(design.costModel, ADAPTIVE_RANKING_TRIAL_COST_MODEL)
          || design.primaryHorizonMin * 60_000 !== publication.procedure.target.horizonMs
          || design.consumerBinding?.featureRecipeVersion
            !== publication.consumerContract.preparedFactsContract.featureRecipe.featureRecipeVersion
          || design.consumerBinding?.policyDigest !== publication.consumerContract.policyDigest) {
        return { error: 'typed design/publication binding mismatch', projection: null };
      }
      if (stage === 'CAPTURE') {
        const error = adaptiveRankingTrialDecisionError(record.decisionReceipt, {
          publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
        });
        if (error || record.candidateId !== design.candidateId
            || record.opportunityId !== record.decisionReceipt?.opportunityId
            || record.decisionReceipt?.candidateId !== design.candidateId) return { error: error ?? 'typed capture wrapper mismatch', projection: null };
        const d = record.decisionReceipt;
        return { error: null, projection: {
          canonicalCoin: d.canonicalCoin, decisionTs: d.decisionTs, recordedTs: d.recordedTs,
          labelEndTs: d.labelEndTs, candidateDecision: 'SELECTED_FOR_SHADOW',
          baselineDecision: 'SELECTED_FOR_SHADOW',
        } };
      }
      if (stage === 'OUTCOME') {
        if (!capture || record.candidateId !== design.candidateId
            || record.opportunityId !== capture.opportunityId
            || record.publicationId !== capture.publicationId) return { error: 'typed outcome wrapper mismatch', projection: null };
        const decisionReceipt = capture.decisionReceipt;
        const error = adaptiveRankingTrialExecutionError(record.executionReceipt, {
          publication, decisionReceipt, validatePreparedFacts, adaptiveStore,
        });
        if (error) return { error, projection: null };
        const e = record.executionReceipt;
        return { error: null, projection: {
          outcomeKnownAtTs: e.outcomeKnownAtTs, recordedTs: e.recordedTs,
          candidateMetricValue: e.candidate.outcome.netPct,
          baselineMetricValue: e.baseline.outcome.netPct,
        } };
      }
      return { error: 'unknown validation stage', projection: null };
    } catch (error) { return { error: error.message, projection: null }; }
  };
}

function normalizedDesignScope(scope) {
  return {
    setupType: String(scope?.setupType ?? 'ANY'), regime: String(scope?.regime ?? 'ANY'),
    assets: Array.isArray(scope?.assets) && scope.assets.length ? [...scope.assets] : 'ANY',
    venues: Array.isArray(scope?.venues) && scope.venues.length ? [...scope.venues] : 'ANY',
  };
}

function stateSourceOf(settlement) {
  return {
    opportunityId: settlement.outcome.opportunityId,
    horizonMs: settlement.outcome.horizonMs,
    predictionId: settlement.outcome.predictionId,
    outcomeId: settlement.outcome.outcomeId,
    updateId: settlement.update.updateId,
    receiptDigest: settlement.provenanceReceipt.receiptDigest,
    eventSequence: settlement.eventSequence,
    eventDigest: settlement.eventDigest,
    durableAcknowledgment: clone(settlement.custody.durableAcknowledgment),
  };
}

function currentStateSourceError(source, settlement, state, procedure) {
  if (exactKeys(source, STATE_SOURCE_KEYS) || !settlement?.outcome || !settlement?.update
      || !settlement?.provenanceReceipt || !settlement?.custody) return 'current state settlement absent or malformed';
  if (exactKeys(source.durableAcknowledgment, SETTLEMENT_ACK_KEYS)
      || !same(source, stateSourceOf(settlement))) return 'current state source differs from settlement';
  const ack = source.durableAcknowledgment;
  if (!boundedId(source.opportunityId) || source.horizonMs !== ADAPTIVE_HORIZON_MS
      || !boundedId(source.predictionId) || !boundedId(source.outcomeId)
      || !boundedId(source.updateId) || !HEX64.test(source.receiptDigest ?? '')
      || !Number.isSafeInteger(source.eventSequence) || source.eventSequence < 1
      || !HEX64.test(source.eventDigest ?? '') || !boundedId(ack.ackVersion)
      || ack.sequence !== source.eventSequence || ack.eventDigest !== source.eventDigest
      || !HEX64.test(ack.headDigest ?? '') || !isTs(ack.acknowledgedTs)
      || settlement.update.nextStateDigest !== state.stateDigest
      || settlement.update.previousSequence + 1 !== state.sequence
      || settlement.update.appliedTs !== state.updatedTs
      || settlement.update.procedureId !== procedure.procedureId
      || settlement.custody.receiptContentBound !== true
      || settlement.custody.declaredArchiveIdentityBound !== true
      || settlement.custody.authority !== 'NONE') return 'current state ACK lineage/content binding malformed';
  return null;
}

function qualificationOf(publication, activation, design, terminal) {
  const body = {
    qualificationVersion: ADAPTIVE_PROCEDURE_QUALIFICATION_VERSION,
    publicationId: publication.publicationId,
    publicationDigest: publication.publicationDigest,
    procedureId: publication.procedure.procedureId,
    procedureDigest: publication.procedure.procedureDigest,
    initialStateDigest: publication.initialState.stateDigest,
    consumerContractDigest: publication.consumerContract.consumerContractDigest,
    stateEffect: clone(publication.consumerContract.stateEffect),
    scope: clone(publication.scope), applicability: clone(publication.applicability),
    candidateId: design.candidateId, candidateDigest: activation.candidateDigest,
    activationId: activation.activationId, terminalReportDigest: activation.reportDigest,
    qualifiedTs: activation.ts, effectiveTs: activation.effectiveTs,
    expiresTs: activation.expiresTs,
    authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    purpose: 'EXACT_EVOLVING_PROCEDURE_AFTER_TYPED_PAIRED_PROSPECTIVE_PROMOTION',
  };
  const qualificationDigest = canonicalDigest(body);
  return deepFreeze({
    ...body, qualificationId: `arprocq-${qualificationDigest.slice(0, 40)}`,
    qualificationDigest,
  });
}

export function adaptiveProcedureQualificationError(qualification, publication) {
  if (exactKeys(qualification, QUALIFICATION_KEYS)
      || qualification.qualificationVersion !== ADAPTIVE_PROCEDURE_QUALIFICATION_VERSION
      || adaptiveProcedurePublicationError(publication)
      || qualification.publicationId !== publication.publicationId
      || qualification.publicationDigest !== publication.publicationDigest
      || qualification.procedureId !== publication.procedure.procedureId
      || qualification.procedureDigest !== publication.procedure.procedureDigest
      || qualification.initialStateDigest !== publication.initialState.stateDigest
      || qualification.consumerContractDigest !== publication.consumerContract.consumerContractDigest
      || !same(qualification.stateEffect, publication.consumerContract.stateEffect)
      || !same(qualification.scope, publication.scope)
      || !same(qualification.applicability, publication.applicability)
      || !boundedId(qualification.candidateId) || !HEX64.test(qualification.candidateDigest ?? '')
      || !boundedId(qualification.activationId) || !HEX64.test(qualification.terminalReportDigest ?? '')
      || !isTs(qualification.qualifiedTs) || !isTs(qualification.effectiveTs)
      || !isTs(qualification.expiresTs) || qualification.expiresTs <= qualification.effectiveTs
      || qualification.authority !== 'PAPER_RANKING_ADJUSTMENT_ONLY'
      || qualification.purpose !== 'EXACT_EVOLVING_PROCEDURE_AFTER_TYPED_PAIRED_PROSPECTIVE_PROMOTION'
      || !HEX64.test(qualification.qualificationDigest ?? '')
      || digestWithout(qualification, ['qualificationId', 'qualificationDigest']) !== qualification.qualificationDigest
      || qualification.qualificationId !== `arprocq-${qualification.qualificationDigest.slice(0, 40)}`) {
    return 'procedure qualification malformed or differs from publication';
  }
  return null;
}

function activationBindingError({ activation, pattern, design, terminal, records, publication, nowTs }) {
  if (activationError(activation) || activation.state !== 'ACTIVE_PAPER'
      || activation.ts > nowTs || nowTs < activation.effectiveTs || nowTs >= activation.expiresTs
      || (activation.cooldownUntilTs !== null && nowTs < activation.cooldownUntilTs)) return 'EXACT_ACTIVE_QUALIFICATION_MISSING';
  if (!pattern || pattern.state !== 'ACTIVE_PAPER' || pattern.activationId !== activation.activationId
      || pattern.candidateId !== activation.candidateId || pattern.ts > nowTs) return 'ACTIVE_PATTERN_BINDING_MISSING';
  const evidence = records.filter((row) => (row.candidateId ?? row.design?.candidateId) === design.candidateId
    && row.kind !== 'TERMINAL_EVALUATED');
  const validation = {
    evidenceBasis: 'PROSPECTIVE', groupCount: terminal.maturedGroups,
    assetCount: terminal.distinctAssets, dateCount: terminal.distinctUtcDates,
    netAfterCostsPct: terminal.effect?.pairedMeanDiff,
  };
  const trialCaptures = records.filter((row) => row.kind === ADAPTIVE_RANKING_TRIAL_CAPTURE
    && row.candidateId === design.candidateId).map((row) => row.decisionReceipt);
  const stateDigests = new Set(trialCaptures.map((row) => row.adaptiveState.stateDigest));
  const observedSigns = new Set(trialCaptures.flatMap((row) => row.adaptiveState.strategies.map((strategy) => (
    strategy.rankOffsetRrPoints > 0 ? 'POSITIVE' : strategy.rankOffsetRrPoints < 0 ? 'NEGATIVE' : 'ZERO'
  ))));
  let lastDecisionTs = null; let lastStateSequence = null;
  const statePathMalformed = trialCaptures.some((row) => {
    const bad = lastDecisionTs !== null && (row.decisionTs <= lastDecisionTs
      || row.adaptiveState.sequence < lastStateSequence);
    lastDecisionTs = row.decisionTs; lastStateSequence = row.adaptiveState.sequence;
    return bad;
  });
  if (design.evidenceDigest !== publication.publicationId
      || design.primaryMetric !== ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC
      || design.comparator !== ADAPTIVE_RANKING_TRIAL_COMPARATOR
      || !same(design.costModel, ADAPTIVE_RANKING_TRIAL_COST_MODEL)
      || design.predicateDigest !== canonicalDigest(publication.applicability)
      || !same(design.scope, publication.scope)
      || design.consumerBinding.featureRecipeVersion
        !== publication.consumerContract.preparedFactsContract.featureRecipe.featureRecipeVersion
      || design.consumerBinding.policyDigest !== publication.consumerContract.policyDigest
      || terminal.verdict !== 'FORWARD_SUPPORTED' || terminal.recordedTs > activation.effectiveTs
      || activation.patternId !== design.patternId
      || activation.trainingCutoffTs !== design.sealedTs
      || activation.candidateDigest !== canonicalDigest(design)
      || activation.evidenceDigest !== canonicalDigest(evidence)
      || activation.reportDigest !== canonicalDigest(terminal)
      || activation.featureRecipeVersion !== design.consumerBinding.featureRecipeVersion
      || activation.policyVersion !== design.consumerBinding.policyDigest
      || !same(activation.applicability, design.predicate)
      || !same(activation.scope, normalizedDesignScope(design.scope))
      || !same(activation.validation, validation)
      || stateDigests.size < 2 || statePathMalformed
      || !['POSITIVE', 'NEGATIVE', 'ZERO'].every((sign) => observedSigns.has(sign))
      || activation.maxSizeUsd !== null) return 'TYPED_PROCEDURE_PROMOTION_BINDING_MISMATCH';
  return null;
}

export function readQualifiedAdaptiveProcedureDecision({
  qualificationStore, adaptiveStore, publications, currentConsumerContract,
  currentStateSettlement, validatePreparedFacts, nowTs, mode,
} = {}) {
  const withheld = []; const qualified = [];
  let kill = { state: 'KILLED', reason: 'QUALIFICATION_STORE_UNAVAILABLE', ts: null };
  if (!isTs(nowTs) || mode !== 'PAPER') {
    return deepFreeze({
      decisionVersion: ADAPTIVE_PROCEDURE_DECISION_VERSION, preparedTs: isTs(nowTs) ? nowTs : null,
      mode: mode ?? null, kill, adaptiveRankingProcedure: null,
      withheld: [{ publicationId: 'UNKNOWN', reason: mode === 'PAPER' ? 'CLOCK_INVALID' : 'MODE_NOT_PAPER_AUTHORIZED' }],
      authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    });
  }
  if (!Array.isArray(publications) || publications.length > MAX_ADAPTIVE_PROCEDURE_PUBLICATIONS
      || adaptiveProcedureConsumerContractError(currentConsumerContract)
      || typeof validatePreparedFacts !== 'function') {
    return deepFreeze({
      decisionVersion: ADAPTIVE_PROCEDURE_DECISION_VERSION, preparedTs: nowTs, mode, kill,
      adaptiveRankingProcedure: null,
      withheld: [{ publicationId: 'UNKNOWN', reason: 'INPUT_CONTRACT_INVALID' }],
      authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    });
  }
  let records; let history; let patterns; let procedure; let state; let status;
  try {
    records = qualificationStore.readProspective(); history = qualificationStore.activationHistory();
    patterns = qualificationStore.patternHeads(); kill = qualificationStore.readKill();
    procedure = adaptiveStore.procedure(); state = adaptiveStore.state(); status = adaptiveStore.status();
  } catch {
    records = null;
  }
  if (!records || history?.globalErrors?.length || history?.invalid?.size
      || status?.state !== 'OPEN' || status.failed !== null
      || status.localAheadUnacknowledged !== false || status.authority !== 'NONE'
      || adaptiveProcedureError(procedure) || adaptiveStateError(state, procedure)
      || adaptiveProcedureConsumerContractError(currentConsumerContract)) {
    for (const publication of publications) withheld.push({ publicationId: publication?.publicationId ?? 'UNKNOWN', reason: 'ACKED_STATE_OR_QUALIFICATION_HISTORY_UNAVAILABLE' });
  } else {
    let validator; let prospective;
    try {
      validator = adaptiveRankingTrialRecordValidator({ publications, validatePreparedFacts, adaptiveStore });
      prospective = replayProspective(records, { adaptiveRankingTrialValidator: validator });
    } catch { prospective = null; }
    if (!prospective || prospective.errors.length) {
      for (const publication of publications) withheld.push({ publicationId: publication?.publicationId ?? 'UNKNOWN', reason: 'TYPED_PROSPECTIVE_HISTORY_INVALID' });
    } else {
      for (const publication of publications) {
        const id = publication?.publicationId ?? 'UNKNOWN';
        const publicationError = adaptiveProcedurePublicationError(publication, { currentConsumerContract });
        if (publicationError || publication.procedure.procedureDigest !== procedure.procedureDigest) {
          withheld.push({ publicationId: id, reason: `PUBLICATION_INVALID:${publicationError ?? 'procedure mismatch'}` }); continue;
        }
        const matches = [...history.heads.values()].filter((activation) => {
          const design = prospective.designs.get(activation.candidateId);
          return design?.evidenceDigest === publication.publicationId;
        });
        if (matches.length !== 1) { withheld.push({ publicationId: id, reason: 'EXACT_ACTIVE_QUALIFICATION_MISSING' }); continue; }
        const activation = matches[0]; const design = prospective.designs.get(activation.candidateId);
        const terminal = prospective.terminals.get(activation.candidateId);
        const bindingError = activationBindingError({
          activation, pattern: patterns.get(activation.patternId), design, terminal,
          records, publication, nowTs,
        });
        if (bindingError) { withheld.push({ publicationId: id, reason: bindingError }); continue; }
        let source;
        try { source = stateSourceOf(currentStateSettlement); } catch { source = null; }
        const sourceError = source ? currentStateSourceError(source, currentStateSettlement, state, procedure) : 'current state source absent';
        if (sourceError) { withheld.push({ publicationId: id, reason: `CURRENT_ACK_LINEAGE_INVALID:${sourceError}` }); continue; }
        qualified.push({ publication, qualification: qualificationOf(publication, activation, design, terminal), stateSource: source });
      }
    }
  }
  let adaptiveRankingProcedure = null;
  if (qualified.length === 1 && withheld.length === 0 && kill?.state === 'ARMED') {
    adaptiveRankingProcedure = {
      consumerContractDigest: currentConsumerContract.consumerContractDigest,
      procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
      currentState: clone(state), stateSource: clone(qualified[0].stateSource),
      qualification: clone(qualified[0].qualification), publication: clone(qualified[0].publication),
      legacyActivationEffectReinterpreted: false,
      authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    };
  }
  const out = {
    decisionVersion: ADAPTIVE_PROCEDURE_DECISION_VERSION, preparedTs: nowTs, mode, kill: clone(kill),
    adaptiveRankingProcedure: adaptiveRankingProcedure ? deepFreeze(adaptiveRankingProcedure) : null,
    withheld, authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
  };
  if (exactKeys(out, DECISION_KEYS) || (out.adaptiveRankingProcedure && exactKeys(out.adaptiveRankingProcedure, ADAPTIVE_SECTION_KEYS))) {
    throw new TypeError('internal procedure decision shape malformed');
  }
  return deepFreeze(out);
}

export function resolveQualifiedAdaptiveProcedureRanking({
  snapshot, consumerContract, preparedFacts, validatePreparedFacts, context,
  strategyId, baselineRewardRiskRatio, mode, nowTs,
} = {}) {
  const baseline = (reason) => deepFreeze({
    applied: false, reason, strategyId: strategyId ?? null, baselineRewardRiskRatio,
    effectiveRewardRiskRatio: baselineRewardRiskRatio, adjustmentRrPoints: 0,
    stateSequence: null, stateDigest: null, qualificationId: null,
  });
  if (!isFiniteNum(baselineRewardRiskRatio)) return baseline('BASELINE_INVALID');
  if (mode !== 'PAPER') return baseline('MODE_NOT_PAPER_AUTHORIZED');
  if (!isTs(nowTs) || snapshot?.decisionVersion !== ADAPTIVE_PROCEDURE_DECISION_VERSION
      || snapshot.mode !== 'PAPER' || !isTs(snapshot.preparedTs)
      || snapshot.preparedTs > nowTs
      || nowTs - snapshot.preparedTs > MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS) return baseline('SNAPSHOT_INVALID_OR_STALE');
  if (snapshot.kill?.state !== 'ARMED') return baseline('LEARNED_INFLUENCE_KILLED');
  if (snapshot.withheld?.length || !snapshot.adaptiveRankingProcedure) return baseline('QUALIFICATION_WITHHELD');
  const section = snapshot.adaptiveRankingProcedure;
  if (exactKeys(section, ADAPTIVE_SECTION_KEYS)
      || adaptiveProcedureConsumerContractError(consumerContract)
      || section.consumerContractDigest !== consumerContract.consumerContractDigest
      || adaptiveProcedurePublicationError(section.publication, { currentConsumerContract: consumerContract })
      || adaptiveProcedureQualificationError(section.qualification, section.publication)
      || adaptiveStateError(section.currentState, section.publication.procedure)
      || section.currentState.procedureDigest !== section.procedureDigest
      || section.qualification.procedureDigest !== section.procedureDigest
      || nowTs < section.qualification.effectiveTs || nowTs >= section.qualification.expiresTs
      || section.legacyActivationEffectReinterpreted !== false) return baseline('QUALIFICATION_INVALID');
  if (typeof validatePreparedFacts !== 'function') return baseline('PREPARED_FACT_VALIDATOR_MISSING');
  let factsError;
  try { factsError = validatePreparedFacts(preparedFacts, consumerContract.preparedFactsContract); }
  catch { return baseline('PREPARED_FACTS_INVALID'); }
  if (factsError !== null || preparedFacts.featureRecipeDigest !== consumerContract.featureRecipeDigest) return baseline('PREPARED_FACTS_INVALID');
  if (!context || !scopeAllows(section.qualification.scope, context)) return baseline('SCOPE_MISMATCH');
  if (evaluatePredicate(section.qualification.applicability, preparedFacts) !== 'TRUE') return baseline('APPLICABILITY_FALSE_OR_UNKNOWN');
  const row = section.currentState.strategies.find((entry) => entry.strategyId === strategyId);
  if (!row) return baseline('STRATEGY_NOT_REGISTERED');
  const effect = consumerContract.stateEffect;
  if (row.rankOffsetRrPoints < effect.minimum || row.rankOffsetRrPoints > effect.maximum
      || Math.abs(row.rankOffsetRrPoints) > section.publication.procedure.algorithm.maxAbsRankOffsetRrPoints) return baseline('STATE_EFFECT_OUTSIDE_QUALIFIED_ENVELOPE');
  const adjustmentRrPoints = row.rankOffsetRrPoints;
  return deepFreeze({
    applied: true, reason: null, strategyId,
    baselineRewardRiskRatio,
    effectiveRewardRiskRatio: Number((baselineRewardRiskRatio + adjustmentRrPoints).toFixed(9)),
    adjustmentRrPoints,
    stateSequence: section.currentState.sequence,
    stateDigest: section.currentState.stateDigest,
    qualificationId: section.qualification.qualificationId,
  });
}
