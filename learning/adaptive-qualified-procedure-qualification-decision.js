import {
  activationError, canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import {
  ADAPTIVE_HORIZON_MS, adaptiveProcedureError, adaptiveStateError,
} from './adaptive-registry.js';
import {
  ADAPTIVE_RANKING_TRIAL_CAPTURE, ADAPTIVE_RANKING_TRIAL_OUTCOME, replayProspective,
} from './prospective.js';
import { evaluatePredicate } from './features.js';
import { adaptiveProcedureConsumerContractError } from './adaptive-qualified-procedure-consumer.js';
import { adaptiveProcedurePublicationError } from './adaptive-qualified-procedure-publication.js';
import { adaptiveRankingTrialRecordValidator } from './adaptive-qualified-procedure-validator.js';
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
    stateDigest: settlement.update.nextStateDigest,
    eventSequence: settlement.eventSequence,
    eventDigest: settlement.eventDigest,
    durableAcknowledgment: clone(settlement.custody.durableAcknowledgment),
  };
}

function currentStateSourceError(source, settlement, state, procedure, nowTs) {
  if (exactKeys(source, STATE_SOURCE_KEYS) || !settlement?.outcome || !settlement?.update
      || !settlement?.provenanceReceipt || !settlement?.custody) return 'current state settlement absent or malformed';
  if (exactKeys(source.durableAcknowledgment, SETTLEMENT_ACK_KEYS)
      || !same(source, stateSourceOf(settlement))) return 'current state source differs from settlement';
  const ack = source.durableAcknowledgment;
  if (!boundedId(source.opportunityId) || source.horizonMs !== ADAPTIVE_HORIZON_MS
      || !boundedId(source.predictionId) || !boundedId(source.outcomeId)
      || !boundedId(source.updateId) || !HEX64.test(source.receiptDigest ?? '')
      || source.stateDigest !== state.stateDigest
      || !Number.isSafeInteger(source.eventSequence) || source.eventSequence < 1
      || !HEX64.test(source.eventDigest ?? '') || !boundedId(ack.ackVersion)
      || ack.sequence !== source.eventSequence || ack.eventDigest !== source.eventDigest
      || !HEX64.test(ack.headDigest ?? '') || !isTs(ack.acknowledgedTs)
      || state.updatedTs > nowTs || ack.acknowledgedTs > nowTs
      || ack.acknowledgedTs < state.updatedTs
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
        const sourceError = source
          ? currentStateSourceError(source, currentStateSettlement, state, procedure, nowTs)
          : 'current state source absent';
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
  const ack = section?.stateSource?.durableAcknowledgment;
  if (exactKeys(section, ADAPTIVE_SECTION_KEYS)
      || adaptiveProcedureConsumerContractError(consumerContract)
      || section.consumerContractDigest !== consumerContract.consumerContractDigest
      || adaptiveProcedurePublicationError(section.publication, { currentConsumerContract: consumerContract })
      || adaptiveProcedureQualificationError(section.qualification, section.publication)
      || adaptiveStateError(section.currentState, section.publication.procedure)
      || section.currentState.procedureDigest !== section.procedureDigest
      || section.qualification.procedureDigest !== section.procedureDigest
      || exactKeys(section.stateSource, STATE_SOURCE_KEYS)
      || exactKeys(ack, SETTLEMENT_ACK_KEYS)
      || section.stateSource.stateDigest !== section.currentState.stateDigest
      || ack.sequence !== section.stateSource.eventSequence
      || ack.eventDigest !== section.stateSource.eventDigest
      || ack.acknowledgedTs > snapshot.preparedTs
      || ack.acknowledgedTs < section.currentState.updatedTs
      || nowTs < section.qualification.effectiveTs || nowTs >= section.qualification.expiresTs
      || section.legacyActivationEffectReinterpreted !== false) return baseline('QUALIFICATION_INVALID');
  if (typeof validatePreparedFacts !== 'function') return baseline('PREPARED_FACT_VALIDATOR_MISSING');
  let factsError;
  try { factsError = validatePreparedFacts(preparedFacts, consumerContract.preparedFactsContract); }
  catch { return baseline('PREPARED_FACTS_INVALID'); }
  if (factsError !== null || preparedFacts.featureRecipeDigest !== consumerContract.featureRecipeDigest) return baseline('PREPARED_FACTS_INVALID');
  if (!isTs(preparedFacts.decisionTs)
      || preparedFacts.decisionTs > nowTs
      || nowTs - preparedFacts.decisionTs > MAX_ADAPTIVE_PROCEDURE_DECISION_AGE_MS
      || section.currentState.updatedTs > preparedFacts.decisionTs
      || section.stateSource.durableAcknowledgment.acknowledgedTs > preparedFacts.decisionTs) {
    return baseline('PREPARED_FACTS_CLOCK_OR_STATE_ASOF_MISMATCH');
  }
  const elapsedMs = nowTs - preparedFacts.decisionTs;
  const freshnessFeatures = new Set(consumerContract.eligibility.requiredFeatures);
  if (consumerContract.eligibility.maxSpreadBps !== null) freshnessFeatures.add('spreadBps');
  if (consumerContract.eligibility.minBidDepthUsd10bps !== null) freshnessFeatures.add('bidDepthUsd10bps');
  if (consumerContract.eligibility.minAtrPct !== null || consumerContract.eligibility.maxAtrPct !== null) freshnessFeatures.add('atrPct');
  for (const name of freshnessFeatures) {
    const fact = preparedFacts.features?.[name];
    if (fact?.availability !== 'KNOWN' || !Number.isSafeInteger(fact.ageMs)
        || fact.ageMs + elapsedMs > consumerContract.eligibility.maxFactAgeMs) {
      return baseline('PREPARED_FACTS_STALE_AT_CONSUMPTION');
    }
  }
  if (preparedFacts.marketIdentity?.canonicalCoin !== context?.asset) {
    return baseline('PREPARED_FACTS_ASSET_MISMATCH');
  }
  if (!Array.isArray(section.qualification.scope.venues)
      || section.qualification.scope.venues.length !== 1
      || section.qualification.scope.venues[0] !== context?.venue) {
    return baseline('PREPARED_FACTS_VENUE_NOT_SINGLE_QUALIFIED_SOURCE');
  }
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
