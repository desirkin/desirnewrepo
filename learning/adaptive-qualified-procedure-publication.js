import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import {
  adaptiveProcedureError, adaptiveStateError, initialAdaptiveState,
} from './adaptive-registry.js';
import { adaptiveProcedureConsumerContractError } from './adaptive-qualified-procedure-consumer.js';
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

function trialLawV2() {
  return {
    captureVersion: ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2,
    executionVersion: ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION_V2,
    primaryMetric: ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC,
    comparator: ADAPTIVE_RANKING_TRIAL_COMPARATOR,
    decisionInputLaw: 'FULL_REGISTERED_ELIGIBLE_INELIGIBLE_UNAVAILABLE_ROWS_PLUS_ACKED_ORIGINAL_PREDICTION_BEFORE_LABEL',
    stateLaw: 'INITIAL_STATE_AND_UPDATE_EQUATIONS_FROZEN_AT_LEAST_TWO_ACKED_STATE_DIGESTS_AND_POSITIVE_NEGATIVE_ZERO_EFFECTS_OBSERVED',
    armOutcomeLaw: 'EACH_SELECTED_STRATEGY_RECOMPUTED_FROM_OWN_SUBSEQUENT_OBSERVED_DEPTH_PATH_AFTER_COSTS_OR_NO_ELIGIBLE_STRATEGY_ABSTAINS_WITH_ZERO_AND_NO_FILL_EVIDENCE',
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

export function sealAdaptiveProcedurePublicationV2({
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
    publicationVersion: ADAPTIVE_PROCEDURE_PUBLICATION_VERSION_V2,
    procedure: clone(procedure), initialState: clone(initialState), consumerContract: clone(consumerContract),
    scope: clone(scope), applicability: clone(applicability), trialLaw: trialLawV2(), sealedTs,
    authority: 'NONE', purpose: 'EXACT_EVOLVING_PROCEDURE_REQUIRING_PROSPECTIVE_PROMOTION',
  };
  const publicationDigest = canonicalDigest(body);
  const out = { ...body, publicationId: `arproc-${publicationDigest.slice(0, 40)}`, publicationDigest };
  const error = adaptiveProcedurePublicationError(out);
  if (error) throw new TypeError(error);
  return deepFreeze(out);
}

export function adaptiveProcedurePublicationError(publication, { currentConsumerContract = null } = {}) {
  const expectedTrialLaw = publication?.publicationVersion === ADAPTIVE_PROCEDURE_PUBLICATION_VERSION
    ? trialLaw()
    : publication?.publicationVersion === ADAPTIVE_PROCEDURE_PUBLICATION_VERSION_V2
      ? trialLawV2()
      : null;
  if (exactKeys(publication, PUBLICATION_KEYS)) return 'procedure publication shape malformed';
  if (expectedTrialLaw === null
      || adaptiveProcedureError(publication.procedure)
      || adaptiveStateError(publication.initialState, publication.procedure)
      || !same(publication.initialState, initialAdaptiveState(publication.procedure, { initializedTs: publication.procedure.createdTs }))
      || adaptiveProcedureConsumerContractError(publication.consumerContract)
      || publication.procedure.parent.consumerContractDigest !== publication.consumerContract.consumerContractDigest
      || publication.procedure.parent.policyDigest !== publication.consumerContract.policyDigest
      || publication.procedure.parent.featureRecipeDigest !== publication.consumerContract.featureRecipeDigest
      || publication.procedure.algorithm.maxAbsRankOffsetRrPoints > publication.consumerContract.stateEffect.maximum
      || scopeError(publication.scope) || applicabilityError(publication.applicability)
      || exactKeys(publication.trialLaw, TRIAL_LAW_KEYS) || !same(publication.trialLaw, expectedTrialLaw)
      || !isTs(publication.sealedTs) || publication.sealedTs < publication.procedure.createdTs
      || publication.authority !== 'NONE'
      || publication.purpose !== 'EXACT_EVOLVING_PROCEDURE_REQUIRING_PROSPECTIVE_PROMOTION'
      || !HEX64.test(publication.publicationDigest ?? '')
      || digestWithout(publication, ['publicationId', 'publicationDigest']) !== publication.publicationDigest
      || publication.publicationId !== `arproc-${publication.publicationDigest.slice(0, 40)}`) return 'procedure publication semantics or digest malformed';
  if (currentConsumerContract !== null && !same(publication.consumerContract, currentConsumerContract)) return 'current dynamic consumer differs';
  return null;
}
