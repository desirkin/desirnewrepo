// Learning-side bridge from one ACK-backed adaptive state proposal to the
// existing prospective promotion owner and, only after that exact proposal
// passes, to a typed PAPER ranking contribution.
//
// The legacy activation artifact is deliberately not reinterpreted here. Its
// numeric effect is denominated in BASELINE_SCORE_UNITS. An adaptive
// publication is separately denominated in REWARD_RISK_RATIO_POINTS and is
// usable only when its complete content was the sole evidence reference of a
// prospectively sealed candidate whose existing promotion/activation history
// still replays as ACTIVE_PAPER. This module creates no second promotion path.
import {
  canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './contracts.js';
import { evaluatePredicate } from './features.js';
import {
  adaptiveProcedureError, adaptiveStateError,
} from './adaptive-registry.js';
import { readDecisionMemory } from './memory-view.js';
import { replayProspective } from './prospective.js';

export const ADAPTIVE_RANKING_PUBLICATION_VERSION = 'adaptive-ranking-publication-1';
export const ADAPTIVE_RANKING_QUALIFICATION_VERSION = 'adaptive-ranking-qualification-1';
export const ADAPTIVE_QUALIFIED_DECISION_VERSION = 'adaptive-qualified-decision-1';
export const MAX_ADAPTIVE_PUBLICATIONS = 64;
export const MAX_ADAPTIVE_DECISION_AGE_MS = 15 * 60_000;

const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;
const STRATEGY = /^[A-Z0-9][A-Z0-9_]{0,99}$/;
const PUBLICATION_KEYS = Object.freeze([
  'publicationVersion', 'publicationId', 'publicationDigest', 'procedureRef',
  'adaptiveState', 'stateSource', 'strategy', 'consumerContract', 'scope',
  'applicability', 'sealedTs', 'authority', 'purpose',
]);
const PROCEDURE_REF_KEYS = Object.freeze([
  'procedureVersion', 'procedureId', 'procedureDigest', 'policyDigest',
  'consumerContractDigest', 'featureRecipeDigest',
]);
const STATE_SOURCE_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'predictionId', 'outcomeId', 'updateId',
  'receiptDigest', 'eventSequence', 'eventDigest', 'durableAcknowledgment',
]);
const ACK_KEYS = Object.freeze([
  'ackVersion', 'sequence', 'eventDigest', 'headDigest', 'acknowledgedTs',
]);
const STRATEGY_KEYS = Object.freeze([
  'strategyId', 'observations', 'rankOffsetRrPoints', 'units',
]);
const SCOPE_KEYS = Object.freeze(['setupType', 'regime', 'assets', 'venues']);
const CONTRACT_KEYS = Object.freeze([
  'consumerContractVersion', 'consumerId', 'policyDigest', 'featureRecipe',
  'featureRecipeDigest', 'eligibility', 'effect', 'validationSemantics',
  'maxSizeUsd', 'activationLifetimeMs', 'degradeRule', 'consumerContractDigest',
]);
const EFFECT_KEYS = Object.freeze([
  'effectVersion', 'axis', 'target', 'targetProducerVersion',
  'rankingLawVersion', 'transform', 'magnitude', 'units', 'magnitudeRounding',
]);
const VALIDATION_KEYS = Object.freeze([
  'experimentalUnit', 'baselineArm', 'candidateArm', 'decisionOutput',
  'noOrderAuthority',
]);
const QUALIFICATION_KEYS = Object.freeze([
  'qualificationVersion', 'qualificationId', 'qualificationDigest',
  'publicationId', 'publicationDigest', 'procedureId', 'procedureDigest',
  'stateSequence', 'stateDigest', 'strategyId', 'effect', 'scope',
  'applicability', 'consumerContractDigest', 'candidateId', 'candidateDigest',
  'activationId', 'terminalReportDigest', 'qualifiedTs', 'effectiveTs',
  'expiresTs', 'authority', 'purpose',
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (left, right) => canonicalDigest(left) === canonicalDigest(right);
const digestWithout = (value, omitted) => canonicalDigest(Object.fromEntries(
  Object.entries(value).filter(([key]) => !omitted.includes(key)),
));
const publicationDigestOf = (value) => digestWithout(value, ['publicationId', 'publicationDigest']);
const qualificationDigestOf = (value) => digestWithout(value, ['qualificationId', 'qualificationDigest']);
const boundedId = (value) => typeof value === 'string' && ID.test(value);

function normalizedScope(scope) {
  return {
    setupType: String(scope?.setupType ?? 'ANY'),
    regime: String(scope?.regime ?? 'ANY'),
    assets: Array.isArray(scope?.assets) && scope.assets.length ? [...scope.assets] : 'ANY',
    venues: Array.isArray(scope?.venues) && scope.venues.length ? [...scope.venues] : 'ANY',
  };
}

function scopeError(scope) {
  const keys = exactKeys(scope, SCOPE_KEYS); if (keys) return keys;
  for (const name of ['setupType', 'regime']) {
    if (typeof scope[name] !== 'string' || scope[name].length < 1 || scope[name].length > 48) return `${name} malformed`;
  }
  for (const name of ['assets', 'venues']) {
    const value = scope[name];
    if (value === 'ANY') continue;
    if (!Array.isArray(value) || value.length < 1 || value.length > 64
        || value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 48)
        || new Set(value).size !== value.length) return `${name} malformed`;
  }
  return null;
}

function applicabilityError(applicability) {
  if (!isPlainObject(applicability) || exactKeys(applicability, ['clauses'])) return 'shape malformed';
  if (!Array.isArray(applicability.clauses) || applicability.clauses.length < 1 || applicability.clauses.length > 32) return 'clauses malformed';
  for (const clause of applicability.clauses) {
    if (exactKeys(clause, ['feature', 'op', 'threshold'])
        || !boundedId(clause.feature) || !['GT', 'GTE', 'LT', 'LTE'].includes(clause.op)
        || !isFiniteNum(clause.threshold)) return 'clause malformed';
  }
  return null;
}

// This validates the closed cross-package envelope consumed by the bridge. The
// Judge remains responsible for validating its complete feature derivations at
// construction and at each decision. Exact digest equality to the current
// Judge contract prevents this envelope check from substituting another body.
export function adaptiveConsumerContractEnvelopeError(contract) {
  const keys = exactKeys(contract, CONTRACT_KEYS); if (keys) return `contract ${keys}`;
  if (contract.consumerContractVersion !== 'judge-prospective-consumer-1'
      || contract.consumerId !== 'COBRA_JUDGE_ADMISSION_BATCH_RANK'
      || !HEX64.test(contract.policyDigest ?? '')
      || !isPlainObject(contract.featureRecipe)
      || contract.featureRecipe.featureRecipeVersion !== 'judge-prepared-market-features-3'
      || !HEX64.test(contract.featureRecipeDigest ?? '')
      || canonicalDigest(contract.featureRecipe) !== contract.featureRecipeDigest
      || !isPlainObject(contract.eligibility)) return 'contract identity or feature recipe malformed';
  const effectKeys = exactKeys(contract.effect, EFFECT_KEYS); if (effectKeys) return `contract effect ${effectKeys}`;
  if (contract.effect.effectVersion !== 'judge-rank-effect-1'
      || contract.effect.axis !== 'RANKING'
      || contract.effect.target !== 'REWARD_RISK_RATIO'
      || contract.effect.targetProducerVersion !== 'judge-cost-paper-reference-1'
      || contract.effect.rankingLawVersion !== 'judge-risk-paper-reference-1'
      || contract.effect.transform !== 'ADD_FIXED_IF_APPLICABLE_AND_FORWARD_SUPPORTED'
      || contract.effect.units !== 'REWARD_RISK_RATIO_POINTS'
      || contract.effect.magnitudeRounding !== 'ECMASCRIPT_TO_FIXED_4_NORMALIZE_NEGATIVE_ZERO'
      || !isFiniteNum(contract.effect.magnitude) || contract.effect.magnitude <= 0
      || contract.effect.magnitude > 0.15
      || Number(contract.effect.magnitude.toFixed(4)) !== contract.effect.magnitude) return 'contract effect malformed';
  const validationKeys = exactKeys(contract.validationSemantics, VALIDATION_KEYS);
  if (validationKeys) return `contract validation ${validationKeys}`;
  if (contract.validationSemantics.experimentalUnit !== 'ADMISSION_BATCH'
      || contract.validationSemantics.baselineArm !== 'SAME_BATCH_UNADJUSTED_REWARD_RISK_RATIO'
      || contract.validationSemantics.candidateArm !== 'SAME_BATCH_SEALED_EFFECT'
      || contract.validationSemantics.decisionOutput !== 'RANK_ORDER'
      || contract.validationSemantics.noOrderAuthority !== true
      || contract.maxSizeUsd !== null
      || !Number.isSafeInteger(contract.activationLifetimeMs)
      || contract.activationLifetimeMs < 1 || contract.activationLifetimeMs > 90 * 86_400_000
      || !isPlainObject(contract.degradeRule)
      || !HEX64.test(contract.consumerContractDigest ?? '')
      || digestWithout(contract, ['consumerContractDigest']) !== contract.consumerContractDigest) return 'contract validation, lifetime, degradation, or digest malformed';
  return null;
}

function sourceOfSettlement(settlement) {
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

function settlementSourceError(source, settlement, state) {
  const keys = exactKeys(source, STATE_SOURCE_KEYS); if (keys) return `state source ${keys}`;
  if (!settlement || !settlement.outcome || !settlement.update || !settlement.provenanceReceipt
      || !Array.isArray(settlement.scores) || !settlement.custody) return 'state source settlement absent';
  const ackKeys = exactKeys(source.durableAcknowledgment, ACK_KEYS); if (ackKeys) return `state source acknowledgment ${ackKeys}`;
  const expected = sourceOfSettlement(settlement);
  if (!same(source, expected)) return 'state source differs from acknowledged settlement';
  const ack = source.durableAcknowledgment;
  if (!boundedId(source.opportunityId) || !Number.isSafeInteger(source.horizonMs) || source.horizonMs < 1
      || !boundedId(source.predictionId) || !boundedId(source.outcomeId) || !boundedId(source.updateId)
      || !HEX64.test(source.receiptDigest ?? '') || !Number.isSafeInteger(source.eventSequence) || source.eventSequence < 1
      || !HEX64.test(source.eventDigest ?? '') || !boundedId(ack.ackVersion)
      || ack.sequence !== source.eventSequence || ack.eventDigest !== source.eventDigest
      || !HEX64.test(ack.headDigest ?? '') || !isTs(ack.acknowledgedTs)
      || settlement.update.nextStateDigest !== state.stateDigest
      || settlement.update.appliedTs !== state.updatedTs
      || settlement.update.previousSequence + 1 !== state.sequence
      || settlement.outcome.outcomeId !== source.outcomeId
      || settlement.outcome.predictionId !== source.predictionId
      || settlement.provenanceReceipt.receiptDigest !== source.receiptDigest
      || settlement.custody.receiptContentBound !== true
      || settlement.custody.declaredArchiveIdentityBound !== true
      || settlement.custody.authority !== 'NONE') return 'state source acknowledgment/content binding malformed';
  return null;
}

export function sealAdaptiveRankingPublication({
  procedure, state, settlement, strategyId, consumerContract, scope, applicability,
} = {}) {
  const procedureError = adaptiveProcedureError(procedure); if (procedureError) throw new TypeError(`procedure: ${procedureError}`);
  const stateError = adaptiveStateError(state, procedure); if (stateError) throw new TypeError(`state: ${stateError}`);
  const contractError = adaptiveConsumerContractEnvelopeError(consumerContract); if (contractError) throw new TypeError(contractError);
  const strategy = state.strategies.find((row) => row.strategyId === strategyId);
  if (!strategy || strategy.observations < 1 || strategy.rankOffsetRrPoints <= 0
      || strategy.rankOffsetRrPoints !== consumerContract.effect.magnitude) throw new TypeError('strategy is absent, unevaluated, non-positive, or differs from sealed effect magnitude');
  if (procedure.parent.policyDigest !== consumerContract.policyDigest
      || procedure.parent.consumerContractDigest !== consumerContract.consumerContractDigest
      || procedure.parent.featureRecipeDigest !== consumerContract.featureRecipeDigest) throw new TypeError('procedure parent differs from consumer contract');
  const fullScope = normalizedScope(scope);
  const scopeFailure = scopeError(fullScope); if (scopeFailure) throw new TypeError(`scope: ${scopeFailure}`);
  const predicateFailure = applicabilityError(applicability); if (predicateFailure) throw new TypeError(`applicability: ${predicateFailure}`);
  if (!settlement || !settlement.outcome || !settlement.update || !settlement.provenanceReceipt
      || !settlement.custody) throw new TypeError('state source settlement absent');
  const stateSource = sourceOfSettlement(settlement);
  const sourceFailure = settlementSourceError(stateSource, settlement, state); if (sourceFailure) throw new TypeError(sourceFailure);
  const sealedTs = Math.max(state.updatedTs, stateSource.durableAcknowledgment.acknowledgedTs);
  const body = {
    publicationVersion: ADAPTIVE_RANKING_PUBLICATION_VERSION,
    procedureRef: {
      procedureVersion: procedure.procedureVersion,
      procedureId: procedure.procedureId,
      procedureDigest: procedure.procedureDigest,
      policyDigest: procedure.parent.policyDigest,
      consumerContractDigest: procedure.parent.consumerContractDigest,
      featureRecipeDigest: procedure.parent.featureRecipeDigest,
    },
    adaptiveState: clone(state),
    stateSource,
    strategy: {
      strategyId: strategy.strategyId,
      observations: strategy.observations,
      rankOffsetRrPoints: strategy.rankOffsetRrPoints,
      units: 'REWARD_RISK_RATIO_POINTS',
    },
    consumerContract: clone(consumerContract),
    scope: fullScope,
    applicability: clone(applicability),
    sealedTs,
    authority: 'NONE',
    purpose: 'EXACT_PROPOSAL_REQUIRING_EXISTING_PROSPECTIVE_PROMOTION',
  };
  const publicationDigest = publicationDigestOf(body);
  const publication = {
    ...body,
    publicationId: `arpub-${publicationDigest.slice(0, 40)}`,
    publicationDigest,
  };
  const error = adaptiveRankingPublicationError(publication, {
    procedure, state, settlement, currentConsumerContract: consumerContract,
  });
  if (error) throw new TypeError(error);
  return deepFreeze(publication);
}

export function adaptiveRankingPublicationError(publication, {
  procedure, state = null, settlement = null, currentConsumerContract = null,
} = {}) {
  const keys = exactKeys(publication, PUBLICATION_KEYS); if (keys) return `publication ${keys}`;
  if (adaptiveProcedureError(procedure)) return 'procedure invalid';
  const refKeys = exactKeys(publication.procedureRef, PROCEDURE_REF_KEYS); if (refKeys) return `procedure ref ${refKeys}`;
  const expectedRef = {
    procedureVersion: procedure.procedureVersion, procedureId: procedure.procedureId,
    procedureDigest: procedure.procedureDigest, policyDigest: procedure.parent.policyDigest,
    consumerContractDigest: procedure.parent.consumerContractDigest,
    featureRecipeDigest: procedure.parent.featureRecipeDigest,
  };
  if (!same(publication.procedureRef, expectedRef)) return 'procedure ref mismatch';
  if (adaptiveStateError(publication.adaptiveState, procedure)) return 'published adaptive state invalid';
  if (state !== null && (!same(publication.adaptiveState, state) || publication.adaptiveState.stateDigest !== state.stateDigest)) return 'published adaptive state is not current';
  const strategyKeys = exactKeys(publication.strategy, STRATEGY_KEYS); if (strategyKeys) return `strategy ${strategyKeys}`;
  const row = publication.adaptiveState.strategies.find((entry) => entry.strategyId === publication.strategy.strategyId);
  if (!row || !STRATEGY.test(publication.strategy.strategyId)
      || publication.strategy.observations !== row.observations || row.observations < 1
      || publication.strategy.rankOffsetRrPoints !== row.rankOffsetRrPoints
      || publication.strategy.rankOffsetRrPoints <= 0
      || publication.strategy.units !== 'REWARD_RISK_RATIO_POINTS') return 'published strategy/state mismatch';
  const contractError = adaptiveConsumerContractEnvelopeError(publication.consumerContract); if (contractError) return contractError;
  if (publication.consumerContract.consumerContractDigest !== procedure.parent.consumerContractDigest
      || publication.consumerContract.policyDigest !== procedure.parent.policyDigest
      || publication.consumerContract.featureRecipeDigest !== procedure.parent.featureRecipeDigest
      || publication.consumerContract.effect.magnitude !== publication.strategy.rankOffsetRrPoints) return 'published contract/procedure/effect mismatch';
  if (currentConsumerContract !== null && !same(publication.consumerContract, currentConsumerContract)) return 'current consumer contract mismatch';
  const scopeFailure = scopeError(publication.scope); if (scopeFailure) return `scope ${scopeFailure}`;
  const predicateFailure = applicabilityError(publication.applicability); if (predicateFailure) return `applicability ${predicateFailure}`;
  if (settlement === null) return 'state source settlement absent';
  const sourceFailure = settlementSourceError(publication.stateSource, settlement, publication.adaptiveState);
  if (sourceFailure) return sourceFailure;
  const ackTs = publication.stateSource?.durableAcknowledgment?.acknowledgedTs;
  if (!isTs(publication.sealedTs) || publication.sealedTs !== Math.max(publication.adaptiveState.updatedTs, ackTs)
      || publication.authority !== 'NONE'
      || publication.purpose !== 'EXACT_PROPOSAL_REQUIRING_EXISTING_PROSPECTIVE_PROMOTION'
      || !HEX64.test(publication.publicationDigest ?? '')
      || publication.publicationDigest !== publicationDigestOf(publication)
      || publication.publicationId !== `arpub-${publication.publicationDigest.slice(0, 40)}`) return 'publication clock, authority, or digest mismatch';
  return null;
}

function qualificationOf(publication, activation, design, terminal) {
  const body = {
    qualificationVersion: ADAPTIVE_RANKING_QUALIFICATION_VERSION,
    publicationId: publication.publicationId,
    publicationDigest: publication.publicationDigest,
    procedureId: publication.procedureRef.procedureId,
    procedureDigest: publication.procedureRef.procedureDigest,
    stateSequence: publication.adaptiveState.sequence,
    stateDigest: publication.adaptiveState.stateDigest,
    strategyId: publication.strategy.strategyId,
    effect: clone(publication.consumerContract.effect),
    scope: clone(publication.scope),
    applicability: clone(publication.applicability),
    consumerContractDigest: publication.consumerContract.consumerContractDigest,
    candidateId: design.candidateId,
    candidateDigest: activation.candidateDigest,
    activationId: activation.activationId,
    terminalReportDigest: activation.reportDigest,
    qualifiedTs: activation.ts,
    effectiveTs: activation.effectiveTs,
    expiresTs: activation.expiresTs,
    authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    purpose: 'EXACT_TYPED_EFFECT_AFTER_EXISTING_PROSPECTIVE_PROMOTION',
  };
  const qualificationDigest = qualificationDigestOf(body);
  return deepFreeze({
    ...body,
    qualificationId: `arqual-${qualificationDigest.slice(0, 40)}`,
    qualificationDigest,
  });
}

function qualificationChainError(publication, activation, design, terminal) {
  if (!activation || activation.state !== 'ACTIVE_PAPER') return 'EXACT_ACTIVE_QUALIFICATION_MISSING';
  if (!design || !terminal || terminal.verdict !== 'FORWARD_SUPPORTED') return 'FORWARD_EVIDENCE_MISSING';
  if (design.evidenceDigest !== publication.publicationId
      || design.sealedTs < publication.sealedTs
      || !same(design.predicate, publication.applicability)
      || !same(normalizedScope(design.scope), publication.scope)
      || design.consumerBinding?.featureRecipeVersion !== publication.consumerContract.featureRecipe.featureRecipeVersion
      || design.consumerBinding?.policyDigest !== publication.consumerContract.policyDigest) return 'PRE_CAPTURE_TYPED_BINDING_MISMATCH';
  if (activation.candidateId !== design.candidateId
      || activation.featureRecipeVersion !== publication.consumerContract.featureRecipe.featureRecipeVersion
      || activation.policyVersion !== publication.consumerContract.policyDigest
      || !same(activation.scope, publication.scope)
      || !same(activation.applicability, publication.applicability)
      || activation.maxSizeUsd !== null
      || activation.expiresTs - activation.effectiveTs !== publication.consumerContract.activationLifetimeMs
      || !same(activation.degradeRule, publication.consumerContract.degradeRule)) return 'ACTIVATION_TYPED_BINDING_MISMATCH';
  return null;
}

export function readQualifiedAdaptiveDecision({
  qualificationStore, adaptiveStore, publications, currentConsumerContract,
  nowTs, mode,
} = {}) {
  const memory = readDecisionMemory({ store: qualificationStore, nowTs });
  const withheld = [];
  const qualified = [];
  const contractError = adaptiveConsumerContractEnvelopeError(currentConsumerContract);
  if (contractError) withheld.push({ publicationId: 'UNKNOWN', reason: 'CURRENT_CONSUMER_CONTRACT_INVALID' });
  if (!Array.isArray(publications) || publications.length > MAX_ADAPTIVE_PUBLICATIONS) {
    withheld.push({ publicationId: 'UNKNOWN', reason: 'PUBLICATION_SET_INVALID' });
  } else if (memory.withheld.length > 0) {
    for (const publication of publications) withheld.push({ publicationId: publication?.publicationId ?? 'UNKNOWN', reason: 'QUALIFICATION_MEMORY_WITHHELD' });
  } else if (mode === 'PAPER' && contractError === null) {
    let prospective;
    try {
      prospective = replayProspective(qualificationStore.readProspective());
      if (prospective.errors.length) throw new Error('invalid prospective history');
    } catch {
      prospective = null;
    }
    let procedure; let state; let status;
    try {
      procedure = adaptiveStore.procedure(); state = adaptiveStore.state(); status = adaptiveStore.status();
    } catch {
      procedure = null; state = null; status = null;
    }
    for (const candidate of publications) {
      const id = candidate?.publicationId ?? 'UNKNOWN';
      if (!procedure || !state || !status || status.state !== 'OPEN' || status.failed !== null
          || status.localAheadUnacknowledged !== false || status.authority !== 'NONE') {
        withheld.push({ publicationId: id, reason: 'ACKNOWLEDGED_ADAPTIVE_STATE_UNAVAILABLE' }); continue;
      }
      let settlement = null;
      try {
        settlement = adaptiveStore.settlement({
          opportunityId: candidate?.stateSource?.opportunityId,
          horizonMs: candidate?.stateSource?.horizonMs,
        });
      } catch { /* fail closed below */ }
      if (settlement === null) {
        withheld.push({ publicationId: id, reason: 'PUBLICATION_INVALID:state source settlement absent' }); continue;
      }
      const error = adaptiveRankingPublicationError(candidate, {
        procedure, state, settlement, currentConsumerContract,
      });
      if (error) { withheld.push({ publicationId: id, reason: `PUBLICATION_INVALID:${error}` }); continue; }
      if (!prospective) { withheld.push({ publicationId: id, reason: 'PROSPECTIVE_HISTORY_INVALID' }); continue; }
      const matches = memory.activations.filter((activation) => {
        const design = prospective.designs.get(activation.candidateId);
        return design?.evidenceDigest === candidate.publicationId;
      });
      if (matches.length !== 1) { withheld.push({ publicationId: id, reason: 'EXACT_ACTIVE_QUALIFICATION_MISSING' }); continue; }
      const activation = matches[0];
      const design = prospective.designs.get(activation.candidateId);
      const terminal = prospective.terminals.get(activation.candidateId);
      const chainError = qualificationChainError(candidate, activation, design, terminal);
      if (chainError) { withheld.push({ publicationId: id, reason: chainError }); continue; }
      qualified.push(qualificationOf(candidate, activation, design, terminal));
    }
  } else if (Array.isArray(publications)) {
    for (const publication of publications) withheld.push({ publicationId: publication?.publicationId ?? 'UNKNOWN', reason: mode === 'PAPER' ? 'CURRENT_CONSUMER_CONTRACT_INVALID' : 'MODE_NOT_PAPER_AUTHORIZED' });
  }
  return deepFreeze({
    ...clone(memory),
    adaptiveRanking: {
      decisionVersion: ADAPTIVE_QUALIFIED_DECISION_VERSION,
      consumerContractDigest: contractError === null ? currentConsumerContract.consumerContractDigest : null,
      mode: mode ?? null,
      publications: qualified,
      withheld,
      legacyActivationEffectReinterpreted: false,
      authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
      law: 'EXACT_TYPED_PUBLICATION_PREBOUND_THEN_EXISTING_PROSPECTIVE_PROMOTION',
    },
  });
}

const scalarScopeMatches = (declared, actual) => declared === 'ANY' || declared === actual;
const listScopeMatches = (declared, actual) => declared === 'ANY' || (typeof actual === 'string' && declared.includes(actual));

// The future Judge-side seam: the Judge supplies its own exact prepared-facts
// validator. A missing/throwing/non-null validator result is baseline. This
// function only returns the typed RR-point contribution; it does not rank,
// size, enter, exit, or send an order.
export function resolveQualifiedAdaptiveRanking({
  snapshot, consumerContract, preparedFacts, validatePreparedFacts,
  context, strategyId, baselineRewardRiskRatio, mode, nowTs,
} = {}) {
  const baseline = (reason) => deepFreeze({
    applied: false, reason, strategyId: strategyId ?? null,
    baselineRewardRiskRatio,
    effectiveRewardRiskRatio: baselineRewardRiskRatio,
    adjustmentRrPoints: 0,
    qualificationId: null,
  });
  if (!isFiniteNum(baselineRewardRiskRatio)) return baseline('BASELINE_INVALID');
  if (mode !== 'PAPER') return baseline('MODE_NOT_PAPER_AUTHORIZED');
  if (!isTs(nowTs) || !snapshot?.adaptiveRanking || snapshot.adaptiveRanking.mode !== 'PAPER') return baseline('SNAPSHOT_INVALID');
  if (!isTs(snapshot.preparedTs) || snapshot.preparedTs > nowTs
      || nowTs - snapshot.preparedTs > MAX_ADAPTIVE_DECISION_AGE_MS) return baseline('SNAPSHOT_STALE');
  if (snapshot.kill?.state !== 'ARMED') return baseline('LEARNED_INFLUENCE_KILLED');
  if (snapshot.adaptiveRanking.withheld.length > 0) return baseline('QUALIFICATION_WITHHELD');
  if (adaptiveConsumerContractEnvelopeError(consumerContract)
      || snapshot.adaptiveRanking.consumerContractDigest !== consumerContract.consumerContractDigest) return baseline('CONSUMER_CONTRACT_MISMATCH');
  if (typeof validatePreparedFacts !== 'function') return baseline('PREPARED_FACT_VALIDATOR_MISSING');
  let factError;
  try { factError = validatePreparedFacts(preparedFacts, consumerContract); } catch { return baseline('PREPARED_FACTS_INVALID'); }
  if (factError !== null) return baseline('PREPARED_FACTS_INVALID');
  const matches = snapshot.adaptiveRanking.publications.filter((entry) => entry.strategyId === strategyId);
  if (matches.length !== 1) return baseline(matches.length ? 'CONFLICTING_QUALIFICATIONS' : 'NO_MATCHING_QUALIFICATION');
  const qualification = matches[0];
  if (exactKeys(qualification, QUALIFICATION_KEYS)
      || qualification.qualificationVersion !== ADAPTIVE_RANKING_QUALIFICATION_VERSION
      || qualification.qualificationDigest !== qualificationDigestOf(qualification)
      || qualification.qualificationId !== `arqual-${qualification.qualificationDigest.slice(0, 40)}`
      || qualification.consumerContractDigest !== consumerContract.consumerContractDigest
      || !same(qualification.effect, consumerContract.effect)
      || qualification.effect.units !== 'REWARD_RISK_RATIO_POINTS'
      || qualification.effect.magnitude <= 0
      || nowTs < qualification.effectiveTs || nowTs >= qualification.expiresTs) return baseline('QUALIFICATION_INVALID');
  if (!context || !scalarScopeMatches(qualification.scope.setupType, context.setupType)
      || !scalarScopeMatches(qualification.scope.regime, context.regime)
      || !listScopeMatches(qualification.scope.assets, context.asset)
      || !listScopeMatches(qualification.scope.venues, context.venue)) return baseline('SCOPE_MISMATCH');
  if (evaluatePredicate(qualification.applicability, preparedFacts) !== 'TRUE') return baseline('APPLICABILITY_FALSE_OR_UNKNOWN');
  const adjustmentRrPoints = qualification.effect.magnitude;
  return deepFreeze({
    applied: true,
    reason: null,
    strategyId,
    baselineRewardRiskRatio,
    effectiveRewardRiskRatio: Number((baselineRewardRiskRatio + adjustmentRrPoints).toFixed(4)),
    adjustmentRrPoints,
    qualificationId: qualification.qualificationId,
  });
}
