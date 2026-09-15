import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import {
  adaptivePredictionError, adaptiveStateError,
} from './adaptive-registry.js';
import { evaluatePredicate } from './features.js';
import { adaptiveProcedurePublicationError } from './adaptive-qualified-procedure-publication.js';
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
export function sealAdaptiveRankingTrialDecision({
  publication, candidateId, opportunityId, adaptiveState, prediction,
  predictionAck, preparedFacts, context, rankCandidates, baselineArm,
  candidateArm, recordedTs, validatePreparedFacts, adaptiveStore,
} = {}) {
  if (publication?.publicationVersion !== ADAPTIVE_PROCEDURE_PUBLICATION_VERSION
      || adaptiveProcedurePublicationError(publication)) throw new TypeError('V1 publication invalid');
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
  if (publication?.publicationVersion !== ADAPTIVE_PROCEDURE_PUBLICATION_VERSION
      || adaptiveProcedurePublicationError(publication)
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

function rankEligibleSubset(procedure, state, rows, adaptive) {
  const byState = new Map(state.strategies.map((row) => [row.strategyId, row]));
  const ranked = rows.flatMap((row, index) => {
    if (row.eligibility !== 'ELIGIBLE') return [];
    const offset = adaptive ? byState.get(row.strategyId)?.rankOffsetRrPoints : 0;
    return [{ strategyId: row.strategyId, value: row.baselineRewardRiskRatio + offset, index }];
  });
  ranked.sort((a, b) => b.value - a.value || a.index - b.index);
  return ranked[0]?.strategyId ?? null;
}

function canonicalSubsetRanks(publication, prediction, rankCandidates) {
  if (!Array.isArray(rankCandidates) || rankCandidates.length !== publication.procedure.strategies.length) {
    throw new TypeError('every registered strategy requires one canonical eligibility row');
  }
  return rankCandidates.map((row, index) => {
    const assessment = prediction.strategyAssessments[index];
    if (exactKeys(row, RANK_V2_KEYS)
        || row.strategyId !== publication.procedure.strategies[index]
        || row.strategyId !== assessment?.strategyId
        || !['ELIGIBLE', 'INELIGIBLE', 'UNAVAILABLE'].includes(row.eligibility)
        || row.eligibility !== assessment?.eligibility
        || row.reasonCode !== assessment?.reasonCode) {
      throw new TypeError(`rank candidate ${index} eligibility differs from the saved forecast`);
    }
    if (row.eligibility === 'ELIGIBLE') {
      if (row.reasonCode !== null || !isFiniteNum(row.baselineRewardRiskRatio)
          || row.baselineRewardRiskRatio < -100 || row.baselineRewardRiskRatio > 100) {
        throw new TypeError(`rank candidate ${index} eligible score malformed`);
      }
    } else if (!boundedId(row.reasonCode) || row.baselineRewardRiskRatio !== null) {
      throw new TypeError(`rank candidate ${index} unavailable/ineligible values malformed`);
    }
    return clone(row);
  });
}

function subsetDecisionArmError(arm, selectedStrategyId, publication, decisionTs, context) {
  if (selectedStrategyId === null) {
    return exactKeys(arm, ARM_KEYS) || arm.selectedStrategyId !== null || arm.executionCapture !== null
      ? 'abstain decision arm must contain no execution capture'
      : null;
  }
  return armCaptureError(arm, selectedStrategyId, publication, decisionTs, context);
}

function subsetLabelEnd(prediction, ...arms) {
  return Math.max(prediction.targetEndTs, ...arms.flatMap((arm) => (
    arm.executionCapture === null ? [] : [
      arm.executionCapture.decisionTs + arm.executionCapture.recipeSeal.recipe.horizonMin * 60_000,
    ]
  )));
}

export function sealAdaptiveRankingTrialDecisionV2({
  publication, candidateId, opportunityId, adaptiveState, prediction,
  predictionAck, preparedFacts, context, rankCandidates, baselineArm,
  candidateArm, recordedTs, validatePreparedFacts, adaptiveStore,
} = {}) {
  if (publication?.publicationVersion !== ADAPTIVE_PROCEDURE_PUBLICATION_VERSION_V2
      || adaptiveProcedurePublicationError(publication)) throw new TypeError('V2 publication invalid');
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
  const ranks = canonicalSubsetRanks(publication, prediction, rankCandidates);
  const baselineSelectedStrategyId = rankEligibleSubset(publication.procedure, adaptiveState, ranks, false);
  const candidateSelectedStrategyId = rankEligibleSubset(publication.procedure, adaptiveState, ranks, true);
  if (prediction.selection.strategyId !== candidateSelectedStrategyId) {
    throw new TypeError('saved adaptive selection differs from recomputed eligible-subset rank');
  }
  const baselineError = subsetDecisionArmError(baselineArm, baselineSelectedStrategyId, publication, prediction.decisionTs, context);
  const candidateError = subsetDecisionArmError(candidateArm, candidateSelectedStrategyId, publication, prediction.decisionTs, context);
  if (baselineError || candidateError) throw new TypeError(baselineError ?? candidateError);
  if (baselineSelectedStrategyId === candidateSelectedStrategyId && !same(baselineArm, candidateArm)) {
    throw new TypeError('unchanged selection requires the exact same decision arm');
  }
  const body = {
    decisionVersion: ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2,
    publicationId: publication.publicationId, candidateId, opportunityId,
    canonicalCoin: context.asset, decisionTs: prediction.decisionTs,
    labelEndTs: subsetLabelEnd(prediction, baselineArm, candidateArm), recordedTs,
    procedureId: publication.procedure.procedureId,
    procedureDigest: publication.procedure.procedureDigest,
    adaptiveState: clone(adaptiveState), prediction: clone(prediction),
    predictionAck: clone(predictionAck), preparedFacts: clone(preparedFacts),
    preparedFactsDigest: canonicalDigest(preparedFacts), context: clone(context),
    rankCandidates: ranks, baselineSelectedStrategyId, candidateSelectedStrategyId,
    baselineArm: clone(baselineArm), candidateArm: clone(candidateArm),
    authority: 'NONE', purpose: 'PRE_LABEL_ELIGIBLE_SUBSET_EVOLVING_RANKING_TRIAL_DECISION',
  };
  const decisionDigest = canonicalDigest(body);
  const out = { ...body, decisionId: `artriald2-${decisionDigest.slice(0, 40)}`, decisionDigest };
  const error = adaptiveRankingTrialDecisionV2Error(out, {
    publication, validatePreparedFacts, adaptiveStore,
  });
  if (error) throw new TypeError(error);
  if (bytes(out) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) throw new TypeError('trial decision exceeds record byte limit');
  return deepFreeze(out);
}

export function adaptiveRankingTrialDecisionV2Error(receipt, {
  publication, validatePreparedFacts, adaptiveStore, requireCurrentState = true,
} = {}) {
  if (exactKeys(receipt, TRIAL_CAPTURE_KEYS)) return 'V2 trial decision shape malformed';
  if (publication?.publicationVersion !== ADAPTIVE_PROCEDURE_PUBLICATION_VERSION_V2
      || adaptiveProcedurePublicationError(publication)
      || receipt.decisionVersion !== ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2
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
    return 'V2 trial decision identity/state/clock malformed';
  }
  const ackError = predictionAckError(receipt.predictionAck, receipt.prediction, receipt.recordedTs);
  if (ackError) return ackError;
  if (typeof validatePreparedFacts !== 'function'
      || validatePreparedFacts(receipt.preparedFacts, publication.consumerContract.preparedFactsContract) !== null
      || bytes(receipt.preparedFacts) > MAX_ADAPTIVE_DECISION_INPUT_BYTES
      || receipt.preparedFacts.decisionTs !== receipt.decisionTs
      || receipt.preparedFacts.factsDigest !== receipt.prediction.factsDigest
      || receipt.preparedFacts.featureRecipeDigest !== publication.consumerContract.featureRecipeDigest
      || receipt.preparedFactsDigest !== canonicalDigest(receipt.preparedFacts)) return 'V2 trial prepared facts invalid or unbound';
  if (exactKeys(receipt.context, CONTEXT_KEYS)
      || receipt.preparedFacts.marketIdentity?.canonicalCoin !== receipt.context.asset
      || !scopeAllows(publication.scope, receipt.context)
      || evaluatePredicate(publication.applicability, receipt.preparedFacts) !== 'TRUE') return 'V2 trial context/applicability mismatch';
  let ranks;
  try { ranks = canonicalSubsetRanks(publication, receipt.prediction, receipt.rankCandidates); }
  catch (error) { return error.message; }
  const baseline = rankEligibleSubset(publication.procedure, receipt.adaptiveState, ranks, false);
  const candidate = rankEligibleSubset(publication.procedure, receipt.adaptiveState, ranks, true);
  if (receipt.baselineSelectedStrategyId !== baseline || receipt.candidateSelectedStrategyId !== candidate
      || receipt.prediction.selection.strategyId !== candidate) return 'V2 trial selected strategy was not recomputed';
  const baselineError = subsetDecisionArmError(receipt.baselineArm, baseline, publication, receipt.decisionTs, receipt.context);
  const candidateError = subsetDecisionArmError(receipt.candidateArm, candidate, publication, receipt.decisionTs, receipt.context);
  if (baselineError || candidateError) return baselineError ?? candidateError;
  if (baseline === candidate && !same(receipt.baselineArm, receipt.candidateArm)) return 'same selection decision arm mismatch';
  if (receipt.labelEndTs !== subsetLabelEnd(receipt.prediction, receipt.baselineArm, receipt.candidateArm)
      || receipt.authority !== 'NONE'
      || receipt.purpose !== 'PRE_LABEL_ELIGIBLE_SUBSET_EVOLVING_RANKING_TRIAL_DECISION'
      || !HEX64.test(receipt.decisionDigest ?? '')
      || digestWithout(receipt, ['decisionId', 'decisionDigest']) !== receipt.decisionDigest
      || receipt.decisionId !== `artriald2-${receipt.decisionDigest.slice(0, 40)}`
      || bytes(receipt) > MAX_ADAPTIVE_TRIAL_RECORD_BYTES) return 'V2 trial decision digest, horizon, authority, or bound malformed';
  if (!adaptiveStore || typeof adaptiveStore.prediction !== 'function' || typeof adaptiveStore.state !== 'function') return 'ACK-backed adaptive reader absent';
  try {
    const stored = adaptiveStore.prediction({ opportunityId: receipt.opportunityId, horizonMs: receipt.prediction.horizonMs });
    if (!stored || !same(stored, receipt.prediction)
        || (requireCurrentState && !same(adaptiveStore.state(), receipt.adaptiveState))) return 'V2 trial state/prediction not ACK-backed content';
  } catch { return 'ACK-backed adaptive reader unavailable'; }
  return null;
}
