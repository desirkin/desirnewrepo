import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import { adaptiveConsumerContractEnvelopeError } from './adaptive-qualified-bridge.js';
import {
  ADAPTIVE_PROCEDURE_CONSUMER_VERSION, ADAPTIVE_PROCEDURE_PUBLICATION_VERSION,
  ADAPTIVE_PROCEDURE_PUBLICATION_VERSION_V2, ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION,
  ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION, ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2,
  ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION_V2, ADAPTIVE_PROCEDURE_QUALIFICATION_VERSION,
  ADAPTIVE_PROCEDURE_DECISION_VERSION, MAX_ADAPTIVE_PROCEDURE_PUBLICATIONS,
  MAX_ADAPTIVE_TRIAL_RECORD_BYTES, MAX_ADAPTIVE_DECISION_INPUT_BYTES,
  MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS, ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC,
  ADAPTIVE_RANKING_TRIAL_COMPARATOR, ADAPTIVE_RANKING_TRIAL_COST_MODEL,
} from './adaptive-qualified-procedure-constants.js';
import {
  HEX64, clone, same, boundedId, digestWithout, bytes,
  DYNAMIC_CONSUMER_KEYS, STATE_EFFECT_KEYS, PUBLICATION_KEYS, TRIAL_LAW_KEYS,
  TRIAL_CAPTURE_KEYS, CONTEXT_KEYS, RANK_KEYS, RANK_V2_KEYS, ARM_KEYS,
  TRIAL_EXECUTION_KEYS, EXECUTION_ARM_KEYS, EXECUTION_SOURCE_KEYS, ABSTAIN_OUTCOME_KEYS,
  ADAPTIVE_RANKING_ABSTAIN_OUTCOME_VERSION, QUALIFICATION_KEYS, STATE_SOURCE_KEYS,
  SETTLEMENT_ACK_KEYS, DECISION_KEYS, ADAPTIVE_SECTION_KEYS,
  scopeError, applicabilityError, scopeAllows, predictionAckError, armCaptureError,
} from './adaptive-qualified-procedure-core.js';

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
      currentFactFreshnessLaw: 'REQUIRED_OR_CONSTRAINED_FACT_AGE_AT_DECISION_PLUS_ELAPSED_TO_CONSUMPTION_LTE_PARENT_MAX_FACT_AGE',
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
    currentFactFreshnessLaw: 'REQUIRED_OR_CONSTRAINED_FACT_AGE_AT_DECISION_PLUS_ELAPSED_TO_CONSUMPTION_LTE_PARENT_MAX_FACT_AGE',
  }) || contract.activationLifetimeMs !== contract.preparedFactsContract.activationLifetimeMs
      || !same(contract.degradeRule, contract.preparedFactsContract.degradeRule)
      || contract.authority !== 'NONE' || !HEX64.test(contract.consumerContractDigest ?? '')
      || digestWithout(contract, ['consumerContractDigest']) !== contract.consumerContractDigest) return 'dynamic consumer semantics or digest malformed';
  return null;
}
