// Pure Judge-side bridge to the externally qualified adaptive procedure resolver.
//
// This module has no import from the learning package and owns no qualification or state. It accepts
// one already prepared immutable snapshot, the V3 raw-fact envelope, and the exact
// post-cost Judge evaluation. Its only possible effect is an RR-point change to the
// rank key of an already qualified PAPER candidate. It cannot admit, size, dispatch,
// alter Watch, or reinterpret the legacy RANK_SCORE_UNITS selector.
import { digestOf } from '../execution/contract.js';
import * as M from '../execution/money.js';
import { adaptiveJudgeFactsEnvelopeError } from './adaptive-facts-source.js';
import { COST_MODEL_VERSION, REFERENCE_HAIRCUT } from './cost.js';
import { judgeLearningConsumerContractError, judgeLearningPreparedFactsError } from './learning-recipe.js';

export const ADAPTIVE_RANKING_PORT_VERSION = 'judge-adaptive-ranking-port-1';
export const ADAPTIVE_RANKING_RESULT_VERSION = 'judge-adaptive-ranking-result-1';
export const ADAPTIVE_RANKING_EVIDENCE_VERSION = 'judge-adaptive-ranking-evidence-1';
export const ADAPTIVE_RANKING_MEASUREMENT_ID = 'QUALIFIED_ADAPTIVE_RANKING_RR_POINTS';
export const ADAPTIVE_RANKING_UNITS = 'REWARD_RISK_RATIO_POINTS';
export const ADAPTIVE_RANKING_CAPTURE_VERSION = 'judge-adaptive-ranking-input-capture-1';
export const ADAPTIVE_RANKING_CAPTURE_ACK_VERSION = 'judge-adaptive-ranking-input-durable-ack-1';
export const MAX_ADAPTIVE_RANKING_INPUT_BYTES = 9 * 1024 * 1024;
export const MAX_ADAPTIVE_RANKING_INPUT_NODES = 300_000;
export const MAX_ADAPTIVE_RANKING_INPUT_DEPTH = 20;

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const REASON = /^[A-Z0-9][A-Z0-9_]{0,119}$/;
const INPUT_KEYS = Object.freeze([
  'snapshot', 'factsEnvelope', 'consumerContract', 'context', 'strategyId',
  'postCostEvaluation', 'mode', 'decisionTs',
]);
const CONTEXT_KEYS = Object.freeze(['setupType', 'regime', 'asset', 'venue']);
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
const SNAPSHOT_KEYS = Object.freeze([
  'decisionVersion', 'preparedTs', 'mode', 'kill', 'adaptiveRankingProcedure',
  'withheld', 'authority',
]);
const SECTION_KEYS = Object.freeze([
  'consumerContractDigest', 'procedureId', 'procedureDigest', 'currentState',
  'stateSource', 'qualification', 'publication', 'legacyActivationEffectReinterpreted',
  'authority',
]);
const STATE_SOURCE_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'predictionId', 'outcomeId', 'updateId',
  'receiptDigest', 'stateDigest', 'eventSequence', 'eventDigest', 'durableAcknowledgment',
]);
const ACK_KEYS = Object.freeze(['ackVersion', 'sequence', 'eventDigest', 'headDigest', 'acknowledgedTs']);
const CAPTURE_KEYS = Object.freeze([
  'receiptVersion', 'receiptId', 'receiptDigest', 'captureEventDigest', 'decisionTs',
  'capturedTs', 'snapshotDigest', 'factsEnvelopeDigest', 'preparedFactsDigest',
  'sourceDigest', 'consumerContractDigest', 'contextDigest', 'strategyId',
  'marketIdentityDigest', 'durableAcknowledgment', 'authority',
]);
const CAPTURE_ACK_KEYS = Object.freeze([
  'ackVersion', 'storeId', 'storeVersion', 'sequence', 'eventDigest',
  'headDigest', 'acknowledgedTs',
]);
const COST_KEYS = Object.freeze([
  'status', 'reasons', 'costModelVersion', 'q', 'netBase', 'entryLimitPrice',
  'capped', 'maxEntryLevel', 'entryCashOut', 'entryNotionalBound', 'entryFeeBound',
  'feeBasis', 'entryBookEstimate', 'actualEntryCashOut', 'scenarioExitCashIn',
  'scenarioNetProfit', 'executionUncertaintyBuffer', 'bufferedScenarioNetProfit',
  'scenarioStressedLoss', 'stressMid', 'rewardRiskRatio', 'sensitivities',
  'attribution', 'expectancyState', 'feeDigest', 'specDigest', 'snapshotDigest', 'units',
]);
const COST_KEYS_WITH_EXIT_DETAIL = Object.freeze([
  ...COST_KEYS.slice(0, COST_KEYS.indexOf('scenarioExitCashIn') + 1),
  'scenarioExitDetail',
  ...COST_KEYS.slice(COST_KEYS.indexOf('scenarioExitCashIn') + 1),
]);
const EXIT_DETAIL_KEYS = Object.freeze([
  'avgPrice', 'proceeds', 'fees', 'slippage', 'haircut', 'levels',
]);
const RESOLVER_RESULT_KEYS = Object.freeze([
  'applied', 'reason', 'strategyId', 'baselineRewardRiskRatio',
  'effectiveRewardRiskRatio', 'adjustmentRrPoints', 'stateSequence',
  'stateDigest', 'qualificationId',
]);
const RESULT_KEYS = Object.freeze([
  'resultVersion', 'portVersion', 'disposition', 'applied', 'reason', 'strategyId',
  'baselineRewardRiskRatio', 'effectiveRewardRiskRatio', 'adjustmentRrPoints',
  'units', 'measurement', 'evidence', 'authority',
]);
const MEASUREMENT_KEYS = Object.freeze(['id', 'ok', 'value', 'threshold', 'unit', 'note']);
const EVIDENCE_KEYS = Object.freeze([
  'evidenceVersion', 'evidenceId', 'evidenceDigest', 'decisionTs', 'strategyId',
  'context', 'factsEnvelopeVersion', 'preparedFactsDigest', 'featureRecipeDigest',
  'sourceVersion', 'sourceId', 'sourceDigest', 'consumerContractDigest',
  'preparedFactsContractDigest', 'procedureId', 'procedureDigest', 'stateSequence',
  'stateDigest', 'stateEventSequence', 'stateEventDigest', 'stateHeadDigest',
  'stateAcknowledgedTs', 'qualificationId', 'qualificationDigest',
  'costEvaluationDigest', 'costModelVersion', 'feeDigest', 'specDigest',
  'snapshotDigest', 'authority',
]);
const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const isTs = (value) => Number.isSafeInteger(value) && value > 0;
const finite = (value) => (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && M.isCanonicalDecimal(value) && Number.isFinite(Number(value)));
const clone = (value) => structuredClone(value);
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};
const same = (a, b) => digestOf(a) === digestOf(b);
const digestWithout = (value, keys) => {
  const body = { ...value };
  for (const key of keys) delete body[key];
  return digestOf(body);
};

// Count the exact JSON string escape size before allocating the encoded string.
function jsonStringBytes(value, limit) {
  if (value.length + 2 > limit) return limit + 1;
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function boundedPlainDataError(root) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0; let bytes = 0;
  while (stack.length) {
    const { value, depth, leave = false } = stack.pop();
    if (leave) { seen.delete(value); continue; }
    nodes += 1;
    if (nodes > MAX_ADAPTIVE_RANKING_INPUT_NODES) return 'INPUT_NODE_LIMIT_EXCEEDED';
    if (depth > MAX_ADAPTIVE_RANKING_INPUT_DEPTH) return 'INPUT_DEPTH_LIMIT_EXCEEDED';
    if (typeof value === 'string') {
      bytes += jsonStringBytes(value, MAX_ADAPTIVE_RANKING_INPUT_BYTES - bytes);
      if (bytes > MAX_ADAPTIVE_RANKING_INPUT_BYTES) return 'INPUT_BYTE_LIMIT_EXCEEDED';
      continue;
    }
    if (value === null || typeof value === 'boolean') { bytes += 5; continue; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'INPUT_NON_JSON_VALUE_REFUSED';
      bytes += String(value).length;
      if (bytes > MAX_ADAPTIVE_RANKING_INPUT_BYTES) return 'INPUT_BYTE_LIMIT_EXCEEDED';
      continue;
    }
    if (typeof value !== 'object') return 'INPUT_NON_JSON_VALUE_REFUSED';
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) {
      return 'INPUT_NON_PLAIN_OBJECT_REFUSED';
    }
    if (seen.has(value)) return 'INPUT_CYCLE_REFUSED';
    seen.add(value);
    stack.push({ value, leave: true });
    const keys = Reflect.ownKeys(value);
    if (nodes + stack.length + keys.length > MAX_ADAPTIVE_RANKING_INPUT_NODES) return 'INPUT_NODE_LIMIT_EXCEEDED';
    if (array && (value.length > MAX_ADAPTIVE_RANKING_INPUT_NODES || keys.length !== value.length + 1)) {
      return 'INPUT_ARRAY_NOT_DENSE';
    }
    bytes += 2 + Math.max(0, keys.length - (array ? 2 : 1));
    if (bytes > MAX_ADAPTIVE_RANKING_INPUT_BYTES) return 'INPUT_BYTE_LIMIT_EXCEEDED';
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return 'INPUT_SYMBOL_PROPERTY_REFUSED';
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        return 'INPUT_ARRAY_EXTRA_PROPERTY';
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return 'INPUT_ACCESSOR_OR_HIDDEN_PROPERTY_REFUSED';
      if (!array) bytes += jsonStringBytes(key, MAX_ADAPTIVE_RANKING_INPUT_BYTES - bytes) + 1;
      if (bytes > MAX_ADAPTIVE_RANKING_INPUT_BYTES) return 'INPUT_BYTE_LIMIT_EXCEEDED';
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  let text;
  try { text = JSON.stringify(root); } catch { return 'INPUT_NOT_JSON_SERIALIZABLE'; }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_ADAPTIVE_RANKING_INPUT_BYTES) return 'INPUT_BYTE_LIMIT_EXCEEDED';
  return null;
}

export function adaptiveRankingInputCaptureEventDigest({
  snapshot, factsEnvelope, consumerContract, context, strategyId, decisionTs,
} = {}) {
  return digestOf({
    captureVersion: ADAPTIVE_RANKING_CAPTURE_VERSION,
    decisionTs, snapshot, factsEnvelope, consumerContract, context, strategyId,
  });
}

export function adaptiveRankingInputCaptureError(receipt, input) {
  const inputError = adaptiveRankingPortInputError(input); if (inputError) return `CAPTURE_INPUT_INVALID:${inputError}`;
  const bounded = boundedPlainDataError(receipt); if (bounded) return bounded;
  if (!exactKeys(receipt, CAPTURE_KEYS)
      || receipt.receiptVersion !== ADAPTIVE_RANKING_CAPTURE_VERSION
      || !isTs(receipt.decisionTs) || receipt.decisionTs !== input?.decisionTs
      || !isTs(receipt.capturedTs) || receipt.capturedTs > receipt.decisionTs
      || !ID.test(receipt.strategyId ?? '') || receipt.strategyId !== input?.strategyId
      || receipt.authority !== 'NONE') return 'CAPTURE_RECEIPT_SHAPE_OR_IDENTITY_INVALID';
  const expectedEventDigest = adaptiveRankingInputCaptureEventDigest(input);
  const market = input?.factsEnvelope?.sourceBinding?.market;
  if (!HEX64.test(receipt.captureEventDigest ?? '') || receipt.captureEventDigest !== expectedEventDigest
      || receipt.snapshotDigest !== digestOf(input.snapshot)
      || receipt.factsEnvelopeDigest !== digestOf(input.factsEnvelope)
      || receipt.preparedFactsDigest !== input.factsEnvelope.facts.factsDigest
      || receipt.sourceDigest !== input.factsEnvelope.sourceBinding.sourceDigest
      || receipt.consumerContractDigest !== input.consumerContract.consumerContractDigest
      || receipt.contextDigest !== digestOf(input.context)
      || receipt.marketIdentityDigest !== digestOf(market)) return 'CAPTURE_CONTENT_BINDING_INVALID';
  const ack = receipt.durableAcknowledgment;
  if (!exactKeys(ack, CAPTURE_ACK_KEYS)
      || ack.ackVersion !== ADAPTIVE_RANKING_CAPTURE_ACK_VERSION
      || !ID.test(ack.storeId ?? '') || !ID.test(ack.storeVersion ?? '')
      || !Number.isSafeInteger(ack.sequence) || ack.sequence < 1
      || ack.eventDigest !== receipt.captureEventDigest || !HEX64.test(ack.headDigest ?? '')
      || !isTs(ack.acknowledgedTs) || ack.acknowledgedTs < receipt.capturedTs
      || ack.acknowledgedTs > receipt.decisionTs) return 'CAPTURE_DURABLE_ACK_INVALID';
  const body = { ...receipt }; delete body.receiptId; delete body.receiptDigest;
  if (!HEX64.test(receipt.receiptDigest ?? '') || digestOf(body) !== receipt.receiptDigest
      || receipt.receiptId !== `jarcap-${receipt.receiptDigest.slice(0, 40)}`) {
    return 'CAPTURE_RECEIPT_DIGEST_INVALID';
  }
  return null;
}

function dynamicConsumerError(contract) {
  if (!exactKeys(contract, DYNAMIC_CONSUMER_KEYS)) return 'CONSUMER_SHAPE_INVALID';
  if (contract.consumerContractVersion !== 'adaptive-ranking-procedure-consumer-2'
      || contract.consumerId !== 'COBRA_JUDGE_ADMISSION_BATCH_EVOLVING_RANK'
      || !HEX64.test(contract.policyDigest ?? '')
      || !HEX64.test(contract.preparedFactsContractDigest ?? '')
      || !HEX64.test(contract.featureRecipeDigest ?? '')
      || judgeLearningConsumerContractError(contract.preparedFactsContract)
      || contract.preparedFactsContract.consumerContractDigest !== contract.preparedFactsContractDigest
      || contract.preparedFactsContract.policyDigest !== contract.policyDigest
      || contract.preparedFactsContract.featureRecipeDigest !== contract.featureRecipeDigest
      || !same(contract.eligibility, contract.preparedFactsContract.eligibility)) return 'CONSUMER_PARENT_INVALID';
  const effect = contract.stateEffect;
  if (!exactKeys(effect, STATE_EFFECT_KEYS)
      || effect.effectVersion !== 'adaptive-current-state-rank-effect-1'
      || effect.axis !== 'RANKING' || effect.target !== 'REWARD_RISK_RATIO'
      || effect.targetProducerVersion !== COST_MODEL_VERSION
      || effect.rankingLawVersion !== 'judge-risk-paper-reference-1'
      || effect.transform !== 'ADD_CURRENT_ACKED_STATE_OFFSET_IF_APPLICABLE'
      || effect.statePath !== 'strategies[strategyId].rankOffsetRrPoints'
      || effect.units !== ADAPTIVE_RANKING_UNITS
      || effect.minimum !== -0.15 || effect.maximum !== 0.15
      || effect.precision !== 1e-9
      || effect.zeroEffectLaw !== 'QUALIFIED_ZERO_PRESERVES_BASELINE'
      || effect.qualificationUnit !== 'WHOLE_FROZEN_ADAPTIVE_PROCEDURE_NOT_ONE_NUMERIC_STATE') {
    return 'CONSUMER_EFFECT_INVALID';
  }
  if (!same(contract.validationSemantics, {
    experimentalUnit: 'ADMISSION_BATCH',
    baselineArm: 'SAME_BATCH_UNADJUSTED_REWARD_RISK_RATIO',
    candidateArm: 'SAME_BATCH_CURRENT_ACKED_ADAPTIVE_STATE',
    decisionOutput: 'SELECTED_STRATEGY_ID', noOrderAuthority: true,
    currentFactFreshnessLaw: 'REQUIRED_OR_CONSTRAINED_FACT_AGE_AT_DECISION_PLUS_ELAPSED_TO_CONSUMPTION_LTE_PARENT_MAX_FACT_AGE',
  }) || contract.activationLifetimeMs !== contract.preparedFactsContract.activationLifetimeMs
      || !same(contract.degradeRule, contract.preparedFactsContract.degradeRule)
      || contract.authority !== 'NONE'
      || !HEX64.test(contract.consumerContractDigest ?? '')
      || digestWithout(contract, ['consumerContractDigest']) !== contract.consumerContractDigest) {
    return 'CONSUMER_SEMANTICS_OR_DIGEST_INVALID';
  }
  return null;
}

function snapshotIdentityError(snapshot, contract, decisionTs) {
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)
      || snapshot.decisionVersion !== 'adaptive-ranking-procedure-decision-2'
      || snapshot.mode !== 'PAPER' || snapshot.authority !== 'PAPER_RANKING_ADJUSTMENT_ONLY'
      || !isTs(snapshot.preparedTs) || snapshot.preparedTs > decisionTs
      || decisionTs - snapshot.preparedTs > MAX_SNAPSHOT_AGE_MS
      || snapshot.kill?.state !== 'ARMED'
      || !Array.isArray(snapshot.withheld) || snapshot.withheld.length !== 0
      || !exactKeys(snapshot.adaptiveRankingProcedure, SECTION_KEYS)) return 'SNAPSHOT_INVALID_OR_STALE';
  const section = snapshot.adaptiveRankingProcedure;
  const state = section.currentState;
  const source = section.stateSource;
  const ack = source?.durableAcknowledgment;
  const qualification = section.qualification;
  const publication = section.publication;
  if (section.consumerContractDigest !== contract.consumerContractDigest
      || section.authority !== 'PAPER_RANKING_ADJUSTMENT_ONLY'
      || section.legacyActivationEffectReinterpreted !== false
      || !ID.test(section.procedureId ?? '') || !HEX64.test(section.procedureDigest ?? '')
      || state?.procedureId !== section.procedureId || state?.procedureDigest !== section.procedureDigest
      || !Number.isSafeInteger(state?.sequence) || state.sequence < 0
      || !isTs(state?.updatedTs) || state.updatedTs > decisionTs
      || !HEX64.test(state?.stateDigest ?? '')
      || !Array.isArray(state?.strategies)
      || !exactKeys(source, STATE_SOURCE_KEYS) || source.stateDigest !== state.stateDigest
      || !Number.isSafeInteger(source.eventSequence) || source.eventSequence < 1
      || !HEX64.test(source.eventDigest ?? '') || !exactKeys(ack, ACK_KEYS)
      || ack.sequence !== source.eventSequence || ack.eventDigest !== source.eventDigest
      || !HEX64.test(ack.headDigest ?? '') || !isTs(ack.acknowledgedTs)
      || ack.acknowledgedTs > snapshot.preparedTs || ack.acknowledgedTs > decisionTs
      || qualification?.consumerContractDigest !== contract.consumerContractDigest
      || qualification?.procedureId !== section.procedureId
      || qualification?.procedureDigest !== section.procedureDigest
      || !ID.test(qualification?.qualificationId ?? '')
      || !HEX64.test(qualification?.qualificationDigest ?? '')
      || publication?.consumerContract?.consumerContractDigest !== contract.consumerContractDigest
      || publication?.procedure?.procedureId !== section.procedureId
      || publication?.procedure?.procedureDigest !== section.procedureDigest) return 'SNAPSHOT_QUALIFIED_IDENTITY_INVALID';
  return null;
}

function postCostError(evaluation, envelope) {
  const legacyShape = exactKeys(evaluation, COST_KEYS);
  const detailedShape = exactKeys(evaluation, COST_KEYS_WITH_EXIT_DETAIL);
  if ((!legacyShape && !detailedShape)
      || evaluation.status !== 'OK' || !Array.isArray(evaluation.reasons) || evaluation.reasons.length
      || evaluation.costModelVersion !== COST_MODEL_VERSION
      || evaluation.actualEntryCashOut !== null
      || evaluation.expectancyState !== 'UNCALIBRATED'
      || !HEX64.test(evaluation.feeDigest ?? '')
      || evaluation.specDigest !== envelope.sourceBinding.instrument.specDigest
      || evaluation.snapshotDigest !== envelope.sourceBinding.book.snapshotDigest
      || evaluation.units?.money !== 'USD'
      || evaluation.units?.base !== envelope.sourceBinding.market.canonicalCoin
      || evaluation.attribution?.note !== 'already inside walked cash flows; displayed, never deducted twice') {
    return 'POST_COST_EVALUATION_INVALID';
  }
  try {
    if (detailedShape) {
      const detail = evaluation.scenarioExitDetail;
      if (!exactKeys(detail, EXIT_DETAIL_KEYS)
          || !M.isCanonicalDecimal(detail.avgPrice) || !M.isPositive(detail.avgPrice)
          || !M.isCanonicalDecimal(detail.proceeds) || !M.isPositive(detail.proceeds)
          || !M.isCanonicalDecimal(detail.fees) || M.isNegative(detail.fees)
          || !M.isCanonicalDecimal(detail.slippage) || M.isNegative(detail.slippage)
          || detail.haircut !== REFERENCE_HAIRCUT
          || !Number.isSafeInteger(detail.levels) || detail.levels < 1
          || M.sub(detail.proceeds, detail.fees) !== evaluation.scenarioExitCashIn) {
        return 'POST_COST_EXIT_DETAIL_INVALID';
      }
    }
    if (!M.isPositive(evaluation.bufferedScenarioNetProfit)
        || !M.isPositive(evaluation.scenarioStressedLoss)
        || !M.isPositive(evaluation.rewardRiskRatio)
        || M.div(evaluation.bufferedScenarioNetProfit, evaluation.scenarioStressedLoss, 6, 'DOWN') !== evaluation.rewardRiskRatio) {
      return 'POST_COST_RATIO_INVALID';
    }
  } catch { return 'POST_COST_RATIO_INVALID'; }
  return null;
}

export function adaptiveRankingPortInputError(input) {
  const bounded = boundedPlainDataError(input); if (bounded) return bounded;
  if (!exactKeys(input, INPUT_KEYS)) return 'INPUT_SCHEMA_NOT_CLOSED';
  if (!isTs(input.decisionTs)) return 'DECISION_CLOCK_INVALID';
  if (input.mode !== 'PAPER') return 'MODE_NOT_PAPER_AUTHORIZED';
  if (!exactKeys(input.context, CONTEXT_KEYS)
      || Object.values(input.context).some((value) => !ID.test(value ?? ''))
      || !ID.test(input.strategyId ?? '')) return 'CONTEXT_OR_STRATEGY_INVALID';
  if (adaptiveJudgeFactsEnvelopeError(input.factsEnvelope)) return 'FACTS_ENVELOPE_INVALID';
  const envelope = input.factsEnvelope;
  if (envelope.facts.decisionTs !== input.decisionTs
      || envelope.facts.marketIdentity?.symbol !== envelope.sourceBinding.market.symbol
      || envelope.facts.marketIdentity?.canonicalCoin !== input.context.asset
      || envelope.sourceBinding.market.canonicalCoin !== input.context.asset
      || envelope.sourceBinding.market.venue !== input.context.venue) return 'FACTS_CONTEXT_OR_CLOCK_MISMATCH';
  const consumerError = dynamicConsumerError(input.consumerContract); if (consumerError) return consumerError;
  if (input.consumerContract.featureRecipeDigest !== envelope.facts.featureRecipeDigest
      || judgeLearningPreparedFactsError(envelope.facts, {
        consumerContract: input.consumerContract.preparedFactsContract,
      })) return 'FACTS_CONSUMER_MISMATCH';
  const snapshotError = snapshotIdentityError(input.snapshot, input.consumerContract, input.decisionTs);
  if (snapshotError) return snapshotError;
  return postCostError(input.postCostEvaluation, envelope);
}

function evidenceOf(input) {
  const section = input.snapshot.adaptiveRankingProcedure;
  const source = section.stateSource;
  const body = {
    evidenceVersion: ADAPTIVE_RANKING_EVIDENCE_VERSION,
    decisionTs: input.decisionTs, strategyId: input.strategyId, context: clone(input.context),
    factsEnvelopeVersion: input.factsEnvelope.envelopeVersion,
    preparedFactsDigest: input.factsEnvelope.facts.factsDigest,
    featureRecipeDigest: input.factsEnvelope.facts.featureRecipeDigest,
    sourceVersion: input.factsEnvelope.sourceBinding.sourceVersion,
    sourceId: input.factsEnvelope.sourceBinding.sourceId,
    sourceDigest: input.factsEnvelope.sourceBinding.sourceDigest,
    consumerContractDigest: input.consumerContract.consumerContractDigest,
    preparedFactsContractDigest: input.consumerContract.preparedFactsContractDigest,
    procedureId: section.procedureId, procedureDigest: section.procedureDigest,
    stateSequence: section.currentState.sequence, stateDigest: section.currentState.stateDigest,
    stateEventSequence: source.eventSequence, stateEventDigest: source.eventDigest,
    stateHeadDigest: source.durableAcknowledgment.headDigest,
    stateAcknowledgedTs: source.durableAcknowledgment.acknowledgedTs,
    qualificationId: section.qualification.qualificationId,
    qualificationDigest: section.qualification.qualificationDigest,
    costEvaluationDigest: digestOf(input.postCostEvaluation),
    costModelVersion: input.postCostEvaluation.costModelVersion,
    feeDigest: input.postCostEvaluation.feeDigest,
    specDigest: input.postCostEvaluation.specDigest,
    snapshotDigest: input.postCostEvaluation.snapshotDigest,
    authority: 'NONE',
  };
  const evidenceDigest = digestOf(body);
  return deepFreeze({
    ...body, evidenceId: `jaranke-${evidenceDigest.slice(0, 40)}`, evidenceDigest,
  });
}

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function safeBaseline(input) {
  const evaluation = ownDataValue(input, 'postCostEvaluation');
  const value = ownDataValue(evaluation, 'rewardRiskRatio');
  return finite(value) ? Number(value) : null;
}

function safeStrategyId(input) {
  const value = ownDataValue(input, 'strategyId');
  return typeof value === 'string' && ID.test(value) ? value : null;
}

function resultOf({ input, applied, reason, effective, adjustment, evidence, threshold }) {
  const baseline = safeBaseline(input);
  const evidenceIdentity = evidence ? `${evidence.evidenceId}:${evidence.evidenceDigest}` : 'NO_EVIDENCE';
  const note = `${ADAPTIVE_RANKING_PORT_VERSION}:${applied ? 'APPLIED' : reason}:${evidenceIdentity}`.slice(0, 300);
  return deepFreeze({
    resultVersion: ADAPTIVE_RANKING_RESULT_VERSION,
    portVersion: ADAPTIVE_RANKING_PORT_VERSION,
    disposition: applied ? 'APPLIED' : 'BASELINE', applied, reason,
    strategyId: safeStrategyId(input),
    baselineRewardRiskRatio: baseline,
    effectiveRewardRiskRatio: applied ? effective : baseline,
    adjustmentRrPoints: applied ? adjustment : 0,
    units: ADAPTIVE_RANKING_UNITS,
    measurement: {
      id: ADAPTIVE_RANKING_MEASUREMENT_ID, ok: applied,
      value: applied ? adjustment : null, threshold: threshold ?? null,
      unit: ADAPTIVE_RANKING_UNITS, note,
    },
    evidence: evidence ?? null,
    authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
  });
}

function validAppliedResolverResult(result, input) {
  if (!exactKeys(result, RESOLVER_RESULT_KEYS) || result.applied !== true || result.reason !== null
      || result.strategyId !== input.strategyId) return false;
  const section = input.snapshot.adaptiveRankingProcedure;
  const row = section.currentState.strategies.find((entry) => entry?.strategyId === input.strategyId);
  const baseline = Number(input.postCostEvaluation.rewardRiskRatio);
  if (!row || !finite(row.rankOffsetRrPoints)
      || result.baselineRewardRiskRatio !== baseline
      || result.adjustmentRrPoints !== row.rankOffsetRrPoints
      || result.effectiveRewardRiskRatio !== Number((baseline + row.rankOffsetRrPoints).toFixed(9))
      || result.stateSequence !== section.currentState.sequence
      || result.stateDigest !== section.currentState.stateDigest
      || result.qualificationId !== section.qualification.qualificationId) return false;
  const effect = input.consumerContract.stateEffect;
  return result.adjustmentRrPoints >= effect.minimum
    && result.adjustmentRrPoints <= effect.maximum
    && Math.abs(result.adjustmentRrPoints) <= section.publication.procedure.algorithm.maxAbsRankOffsetRrPoints;
}

function validBaselineResolverResult(result, input) {
  const baseline = Number(input.postCostEvaluation.rewardRiskRatio);
  return exactKeys(result, RESOLVER_RESULT_KEYS) && result.applied === false
    && REASON.test(result.reason ?? '') && result.strategyId === input.strategyId
    && result.baselineRewardRiskRatio === baseline
    && result.effectiveRewardRiskRatio === baseline && result.adjustmentRrPoints === 0
    && result.stateSequence === null && result.stateDigest === null && result.qualificationId === null;
}

export function adaptiveRankingPortResultError(result) {
  if (!exactKeys(result, RESULT_KEYS)
      || result.resultVersion !== ADAPTIVE_RANKING_RESULT_VERSION
      || result.portVersion !== ADAPTIVE_RANKING_PORT_VERSION
      || !['APPLIED', 'BASELINE'].includes(result.disposition)
      || result.disposition !== (result.applied ? 'APPLIED' : 'BASELINE')
      || result.units !== ADAPTIVE_RANKING_UNITS
      || result.authority !== 'PAPER_RANKING_ADJUSTMENT_ONLY'
      || !exactKeys(result.measurement, MEASUREMENT_KEYS)
      || result.measurement.id !== ADAPTIVE_RANKING_MEASUREMENT_ID
      || result.measurement.ok !== result.applied
      || result.measurement.unit !== ADAPTIVE_RANKING_UNITS
      || typeof result.measurement.note !== 'string' || result.measurement.note.length > 300) return 'RESULT_SHAPE_OR_IDENTITY_INVALID';
  if (result.applied) {
    if (result.reason !== null || !finite(result.baselineRewardRiskRatio)
        || !finite(result.effectiveRewardRiskRatio) || !finite(result.adjustmentRrPoints)
        || result.adjustmentRrPoints < -0.15 || result.adjustmentRrPoints > 0.15
        || result.measurement.value !== result.adjustmentRrPoints
        || !finite(result.measurement.threshold)) return 'APPLIED_RESULT_INVALID';
  } else if (!REASON.test(result.reason ?? '') || result.adjustmentRrPoints !== 0
      || result.effectiveRewardRiskRatio !== result.baselineRewardRiskRatio
      || result.measurement.value !== null) return 'BASELINE_RESULT_INVALID';
  if (result.evidence !== null) {
    if (!exactKeys(result.evidence, EVIDENCE_KEYS)
        || result.evidence.evidenceVersion !== ADAPTIVE_RANKING_EVIDENCE_VERSION
        || !HEX64.test(result.evidence.evidenceDigest ?? '')
        || result.evidence.evidenceId !== `jaranke-${result.evidence.evidenceDigest.slice(0, 40)}`
        || digestWithout(result.evidence, ['evidenceId', 'evidenceDigest']) !== result.evidence.evidenceDigest
        || result.evidence.authority !== 'NONE') return 'RESULT_EVIDENCE_INVALID';
  }
  return null;
}

export function createAdaptiveRankingPort({ resolveQualifiedRanking } = {}) {
  if (typeof resolveQualifiedRanking !== 'function') throw new TypeError('resolveQualifiedRanking must be a synchronous pure function');
  function resolve(input) {
    const inputError = adaptiveRankingPortInputError(input);
    if (inputError) return resultOf({ input, applied: false, reason: inputError, evidence: null, threshold: null });
    const evidence = evidenceOf(input);
    const threshold = Math.max(Math.abs(input.consumerContract.stateEffect.minimum), input.consumerContract.stateEffect.maximum);
    let resolved;
    try {
      resolved = resolveQualifiedRanking({
        snapshot: input.snapshot, consumerContract: input.consumerContract,
        preparedFacts: input.factsEnvelope.facts,
        validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
        context: input.context, strategyId: input.strategyId,
        baselineRewardRiskRatio: Number(input.postCostEvaluation.rewardRiskRatio),
        mode: input.mode, nowTs: input.decisionTs,
      });
    } catch {
      return resultOf({ input, applied: false, reason: 'RESOLVER_THROW', evidence, threshold });
    }
    try {
      if (resolved instanceof Promise) {
        Promise.resolve(resolved).catch(() => {});
        return resultOf({ input, applied: false, reason: 'RESOLVER_ASYNC_REFUSED', evidence, threshold });
      }
    } catch {
      return resultOf({ input, applied: false, reason: 'RESOLVER_RESULT_INVALID', evidence, threshold });
    }
    if (boundedPlainDataError(resolved)) {
      return resultOf({ input, applied: false, reason: 'RESOLVER_RESULT_INVALID', evidence, threshold });
    }
    if (validAppliedResolverResult(resolved, input)) {
      const out = resultOf({
        input, applied: true, reason: null,
        effective: resolved.effectiveRewardRiskRatio,
        adjustment: resolved.adjustmentRrPoints,
        evidence, threshold,
      });
      if (adaptiveRankingPortResultError(out)) throw new Error('internal adaptive ranking result invalid');
      return out;
    }
    if (validBaselineResolverResult(resolved, input)) {
      const qualifiedReason = `QUALIFIED_RESOLVER_${resolved.reason}`;
      return resultOf({
        input, applied: false,
        reason: REASON.test(qualifiedReason) ? qualifiedReason : 'QUALIFIED_RESOLVER_BASELINE',
        evidence, threshold,
      });
    }
    return resultOf({ input, applied: false, reason: 'RESOLVER_RESULT_INVALID', evidence, threshold });
  }
  return Object.freeze({ version: ADAPTIVE_RANKING_PORT_VERSION, resolve });
}
