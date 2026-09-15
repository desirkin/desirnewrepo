import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import { matureShadowCapture } from './shadow-outcome.js';
import {
  adaptiveRankingTrialDecisionError, adaptiveRankingTrialDecisionV2Error,
} from './adaptive-qualified-procedure-trial-decision.js';
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

export function adaptiveRankingExecutionSourceIdentity({ decisionArm, depthPath } = {}) {
  const capture = decisionArm?.executionCapture;
  const identity = {
    venue: capture?.venue ?? null,
    assetId: capture?.assetId ?? null,
    entryEpochId: depthPath?.entry?.snapshot?.epochId ?? null,
    exitEpochId: depthPath?.exit?.snapshot?.epochId ?? null,
  };
  if (exactKeys(identity, EXECUTION_SOURCE_KEYS)
      || !boundedId(identity.venue) || !boundedId(identity.assetId)
      || !boundedId(identity.entryEpochId) || !boundedId(identity.exitEpochId)) {
    throw new TypeError('execution source identity malformed');
  }
  return deepFreeze(identity);
}

function recomputeExecutionArm(arm, decisionArm) {
  if (exactKeys(arm, EXECUTION_ARM_KEYS)
      || arm.selectedStrategyId !== decisionArm.selectedStrategyId
      || !isTs(arm.asOfTs)) return { error: 'execution arm shape or identity malformed' };
  const capture = decisionArm.executionCapture;
  let expectedSourceIdentity;
  try {
    expectedSourceIdentity = adaptiveRankingExecutionSourceIdentity({ decisionArm, depthPath: arm.depthPath });
  } catch (error) { return { error: error.message }; }
  if (exactKeys(arm.sourceIdentity, EXECUTION_SOURCE_KEYS)
      || !same(arm.sourceIdentity, expectedSourceIdentity)) {
    return { error: 'execution arm source identity differs from decision/depth evidence' };
  }
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

function abstainOutcome() {
  return {
    outcomeVersion: ADAPTIVE_RANKING_ABSTAIN_OUTCOME_VERSION,
    label: 'ABSTAINED_NO_ELIGIBLE_STRATEGY', netPct: 0,
    actualFillObserved: false, sizeEvidence: 'NONE', entry: null, exit: null,
    reasonCode: 'NO_ELIGIBLE_STRATEGY',
  };
}

export function sealAdaptiveRankingAbstainExecutionArm({ asOfTs } = {}) {
  if (!isTs(asOfTs)) throw new TypeError('abstain evidence clock malformed');
  return deepFreeze({
    selectedStrategyId: null, sourceIdentity: null, path: null, depthPath: null,
    asOfTs, outcome: abstainOutcome(),
  });
}

function recomputeExecutionArmV2(arm, decisionArm) {
  if (decisionArm.selectedStrategyId === null) {
    if (exactKeys(arm, EXECUTION_ARM_KEYS) || arm.selectedStrategyId !== null
        || arm.sourceIdentity !== null || arm.path !== null || arm.depthPath !== null
        || !isTs(arm.asOfTs) || exactKeys(arm.outcome, ABSTAIN_OUTCOME_KEYS)
        || !same(arm.outcome, abstainOutcome())) {
      return { error: 'abstain execution must be exact zero with no fill, path, depth, or source evidence' };
    }
    return { error: null, outcome: arm.outcome };
  }
  return recomputeExecutionArm(arm, decisionArm);
}

export function sealAdaptiveRankingTrialExecutionV2({
  publication, decisionReceipt, candidate, baseline, recordedTs,
  validatePreparedFacts, adaptiveStore,
} = {}) {
  const decisionError = adaptiveRankingTrialDecisionV2Error(decisionReceipt, {
    publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
  });
  if (decisionError) throw new TypeError(decisionError);
  const candidateResult = recomputeExecutionArmV2(candidate, decisionReceipt.candidateArm);
  const baselineResult = recomputeExecutionArmV2(baseline, decisionReceipt.baselineArm);
  if (candidateResult.error || baselineResult.error) throw new TypeError(candidateResult.error ?? baselineResult.error);
  if (decisionReceipt.candidateSelectedStrategyId === decisionReceipt.baselineSelectedStrategyId
      && !same(candidate, baseline)) throw new TypeError('unchanged selection requires identical execution evidence');
  const outcomeKnownAtTs = Math.max(candidate.asOfTs, baseline.asOfTs);
  if (!isTs(recordedTs) || recordedTs < outcomeKnownAtTs
      || outcomeKnownAtTs < decisionReceipt.labelEndTs) throw new TypeError('trial execution clock precedes maturity');
  const body = {
    executionVersion: ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION_V2,
    publicationId: publication.publicationId, candidateId: decisionReceipt.candidateId,
    opportunityId: decisionReceipt.opportunityId, decisionId: decisionReceipt.decisionId,
    candidate: clone(candidate), baseline: clone(baseline), outcomeKnownAtTs,
    recordedTs, authority: 'NONE', purpose: 'POST_LABEL_ELIGIBLE_SUBSET_PAIRED_HYPOTHETICAL_EXECUTION',
  };
  const executionDigest = canonicalDigest(body);
  const out = { ...body, executionId: `artriale2-${executionDigest.slice(0, 40)}`, executionDigest };
  const error = adaptiveRankingTrialExecutionV2Error(out, {
    publication, decisionReceipt, validatePreparedFacts, adaptiveStore,
  });
  if (error) throw new TypeError(error);
  if (bytes(out) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) throw new TypeError('trial execution exceeds record byte limit');
  return deepFreeze(out);
}

export function adaptiveRankingTrialExecutionV2Error(receipt, {
  publication, decisionReceipt, validatePreparedFacts, adaptiveStore,
} = {}) {
  if (exactKeys(receipt, TRIAL_EXECUTION_KEYS)) return 'V2 trial execution shape malformed';
  const decisionError = adaptiveRankingTrialDecisionV2Error(decisionReceipt, {
    publication, validatePreparedFacts, adaptiveStore, requireCurrentState: false,
  });
  if (decisionError) return `V2 trial execution decision invalid (${decisionError})`;
  if (receipt.executionVersion !== ADAPTIVE_PROCEDURE_TRIAL_EXECUTION_VERSION_V2
      || receipt.publicationId !== publication.publicationId
      || receipt.candidateId !== decisionReceipt.candidateId
      || receipt.opportunityId !== decisionReceipt.opportunityId
      || receipt.decisionId !== decisionReceipt.decisionId) return 'V2 trial execution identity mismatch';
  const candidate = recomputeExecutionArmV2(receipt.candidate, decisionReceipt.candidateArm);
  const baseline = recomputeExecutionArmV2(receipt.baseline, decisionReceipt.baselineArm);
  if (candidate.error || baseline.error) return candidate.error ?? baseline.error;
  if (decisionReceipt.candidateSelectedStrategyId === decisionReceipt.baselineSelectedStrategyId
      && !same(receipt.candidate, receipt.baseline)) return 'unchanged selection execution differs';
  const knownAt = Math.max(receipt.candidate.asOfTs, receipt.baseline.asOfTs);
  if (receipt.outcomeKnownAtTs !== knownAt || receipt.outcomeKnownAtTs < decisionReceipt.labelEndTs
      || !isTs(receipt.recordedTs) || receipt.recordedTs < knownAt
      || receipt.authority !== 'NONE'
      || receipt.purpose !== 'POST_LABEL_ELIGIBLE_SUBSET_PAIRED_HYPOTHETICAL_EXECUTION'
      || !HEX64.test(receipt.executionDigest ?? '')
      || digestWithout(receipt, ['executionId', 'executionDigest']) !== receipt.executionDigest
      || receipt.executionId !== `artriale2-${receipt.executionDigest.slice(0, 40)}`
      || bytes(receipt) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) return 'V2 trial execution clock, digest, authority, or bound malformed';
  return null;
}
