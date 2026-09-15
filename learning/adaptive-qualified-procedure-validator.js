import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import { adaptiveProcedurePublicationError } from './adaptive-qualified-procedure-publication.js';
import {
  adaptiveRankingTrialDecisionError, adaptiveRankingTrialDecisionV2Error,
} from './adaptive-qualified-procedure-trial-decision.js';
import {
  adaptiveRankingTrialExecutionError, adaptiveRankingTrialExecutionV2Error,
} from './adaptive-qualified-procedure-execution.js';
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
        const v2 = record.decisionReceipt?.decisionVersion === ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2;
        const error = v2
          ? adaptiveRankingTrialDecisionV2Error(record.decisionReceipt, {
            publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
          })
          : adaptiveRankingTrialDecisionError(record.decisionReceipt, {
            publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
          });
        if (error || record.candidateId !== design.candidateId
            || record.opportunityId !== record.decisionReceipt?.opportunityId
            || record.decisionReceipt?.candidateId !== design.candidateId) return { error: error ?? 'typed capture wrapper mismatch', projection: null };
        const d = record.decisionReceipt;
        return { error: null, projection: {
          canonicalCoin: d.canonicalCoin, decisionTs: d.decisionTs, recordedTs: d.recordedTs,
          labelEndTs: d.labelEndTs,
          candidateDecision: d.candidateSelectedStrategyId === null ? 'SKIPPED' : 'SELECTED_FOR_SHADOW',
          baselineDecision: d.baselineSelectedStrategyId === null ? 'SKIPPED' : 'SELECTED_FOR_SHADOW',
        } };
      }
      if (stage === 'OUTCOME') {
        if (!capture || record.candidateId !== design.candidateId
            || record.opportunityId !== capture.opportunityId
            || record.publicationId !== capture.publicationId) return { error: 'typed outcome wrapper mismatch', projection: null };
        const decisionReceipt = capture.decisionReceipt;
        const v2 = decisionReceipt?.decisionVersion === ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2;
        const error = v2
          ? adaptiveRankingTrialExecutionV2Error(record.executionReceipt, {
            publication, decisionReceipt, validatePreparedFacts, adaptiveStore,
          })
          : adaptiveRankingTrialExecutionError(record.executionReceipt, {
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
