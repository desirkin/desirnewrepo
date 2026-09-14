import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_RANKING_MEASUREMENT_ID, ADAPTIVE_RANKING_PORT_VERSION,
  ADAPTIVE_RANKING_UNITS, adaptiveRankingPortInputError,
  adaptiveRankingPortResultError, createAdaptiveRankingPort,
} from '../judge/adaptive-ranking-port.js';
import { prepareAdaptiveJudgeFacts } from '../judge/adaptive-facts-source.js';
import {
  buildJudgeLearningConsumerContract, judgeLearningPreparedFactsError,
} from '../judge/learning-recipe.js';
import { COST_MODEL_VERSION, evaluateEntry } from '../judge/cost.js';
import {
  adaptiveStateDigestOf, initialAdaptiveState, sealAdaptiveProcedure,
} from '../learning/adaptive-registry.js';
import {
  resolveQualifiedAdaptiveProcedureRanking, sealAdaptiveProcedureConsumerContract,
  sealAdaptiveProcedurePublicationV2,
} from '../learning/adaptive-qualified-procedure.js';
import { digestOf, feeContract, instrumentSpec } from '../execution/contract.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 8, 1, 12);
const D = T0 + 3 * 60 * MIN;
const POLICY = 'a'.repeat(64);
const clone = (value) => structuredClone(value);

function spec() {
  return instrumentSpec({
    venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'BTC/USD',
    base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online',
    priceIncrement: '0.01', qtyIncrement: '0.00000001', orderMin: '0.01',
    costMin: '0.5', priceDecimals: 2, qtyDecimals: 8,
    observedTs: T0, source: 'FIXTURE',
  });
}

function book(instrument, decisionTs = D) {
  const snapshot = {
    snapshotVersion: 'execution-book-snapshot-1', symbol: 'BTC/USD', canonicalCoin: 'BTC',
    feedEpoch: 7, receiptSequence: 900, nativeSequence: null,
    sourceTs: decisionTs - 300, receiptTs: decisionTs - 250,
    crc: 1, crcVerified: true, crcComputed: 1, synced: true,
    instrumentDigest: instrument.specDigest, priceDecimals: 2, qtyDecimals: 8,
    bids: [['99.95', '1000']], asks: [['100.05', '1000']],
    levelsCap: 100, truncated: false, kind: 'UPDATE', digest: '0'.repeat(64),
  };
  snapshot.digest = digestOf({ ...snapshot, digest: null });
  return snapshot;
}

function staticConsumer() {
  return buildJudgeLearningConsumerContract({
    policyDigest: POLICY,
    eligibility: {
      maxSpreadBps: 20, minBidDepthUsd10bps: null, minAtrPct: null,
      maxAtrPct: null, maxFactAgeMs: 60_000, requiredFeatures: ['spreadBps'],
    },
    effectMagnitude: 0.01, activationLifetimeMs: 30 * DAY,
    degradeRule: { minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 },
  });
}

function stateWithSignedOffsets(procedure) {
  const state = clone(initialAdaptiveState(procedure));
  state.sequence = 1;
  state.updatedTs = D - 5 * MIN;
  const rows = new Map(state.strategies.map((row) => [row.strategyId, row]));
  Object.assign(rows.get('IGNITION'), {
    observations: 1, positive60mProbability: 0.55, rankOffsetRrPoints: 0.015,
  });
  Object.assign(rows.get('PULLBACK'), {
    observations: 1, positive60mProbability: 0.45, rankOffsetRrPoints: -0.015,
  });
  state.influencedEpisodes = 1;
  state.influenceLedgerDigest = 'd'.repeat(64);
  state.totalRankMovementRrPoints = 0.03;
  state.stateDigest = adaptiveStateDigestOf(state);
  return state;
}

function qualification(publication) {
  const body = {
    qualificationVersion: 'adaptive-ranking-procedure-qualification-1',
    publicationId: publication.publicationId,
    publicationDigest: publication.publicationDigest,
    procedureId: publication.procedure.procedureId,
    procedureDigest: publication.procedure.procedureDigest,
    initialStateDigest: publication.initialState.stateDigest,
    consumerContractDigest: publication.consumerContract.consumerContractDigest,
    stateEffect: clone(publication.consumerContract.stateEffect),
    scope: clone(publication.scope), applicability: clone(publication.applicability),
    candidateId: 'candidate-synthetic-prequalified', candidateDigest: '1'.repeat(64),
    activationId: 'activation-synthetic-prequalified', terminalReportDigest: '2'.repeat(64),
    qualifiedTs: D - 12 * MIN, effectiveTs: D - 10 * MIN, expiresTs: D + DAY,
    authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    purpose: 'EXACT_EVOLVING_PROCEDURE_AFTER_TYPED_PAIRED_PROSPECTIVE_PROMOTION',
  };
  const qualificationDigest = digestOf(body);
  return {
    ...body, qualificationId: `arprocq-${qualificationDigest.slice(0, 40)}`,
    qualificationDigest,
  };
}

function fixture() {
  const preparedFactsContract = staticConsumer();
  const consumerContract = sealAdaptiveProcedureConsumerContract({ preparedFactsContract });
  const procedure = sealAdaptiveProcedure({
    parentPolicyDigest: consumerContract.policyDigest,
    consumerContractDigest: consumerContract.consumerContractDigest,
    featureRecipeDigest: consumerContract.featureRecipeDigest,
    strategyIds: ['IGNITION', 'PULLBACK', 'RANGE'], createdTs: T0,
  });
  const initialState = initialAdaptiveState(procedure);
  const publication = sealAdaptiveProcedurePublicationV2({
    procedure, initialState, consumerContract,
    scope: { setupType: 'ANY', regime: 'ANY', assets: 'ANY', venues: ['kraken'] },
    applicability: { clauses: [{ feature: 'spreadBps', op: 'LTE', threshold: 20 }] },
    sealedTs: T0 + MIN,
  });
  const currentState = stateWithSignedOffsets(procedure);
  const qualified = qualification(publication);
  const stateSource = {
    opportunityId: 'lop-synthetic-settlement', horizonMs: 60 * MIN,
    predictionId: 'aprd-synthetic', outcomeId: 'aout-synthetic', updateId: 'aupd-synthetic',
    receiptDigest: '3'.repeat(64), stateDigest: currentState.stateDigest,
    eventSequence: 8, eventDigest: '4'.repeat(64),
    durableAcknowledgment: {
      ackVersion: 'adaptive-durable-ack-1', sequence: 8,
      eventDigest: '4'.repeat(64), headDigest: '5'.repeat(64),
      acknowledgedTs: D - 4 * MIN,
    },
  };
  const snapshot = {
    decisionVersion: 'adaptive-ranking-procedure-decision-2', preparedTs: D - 1_000,
    mode: 'PAPER', kill: { state: 'ARMED' },
    adaptiveRankingProcedure: {
      consumerContractDigest: consumerContract.consumerContractDigest,
      procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
      currentState, stateSource, qualification: qualified, publication,
      legacyActivationEffectReinterpreted: false,
      authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    },
    withheld: [], authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
  };
  const instrument = spec();
  const snapshotBook = book(instrument);
  const factsEnvelope = prepareAdaptiveJudgeFacts({
    decisionTs: D,
    requestedMarket: { venue: 'kraken', symbol: 'BTC/USD', canonicalCoin: 'BTC', quote: 'USD' },
    instrumentSpec: instrument, bookSnapshot: snapshotBook,
    frozenIndicator: null, historicalBars: null, flowWindow: null,
  });
  assert.equal(judgeLearningPreparedFactsError(factsEnvelope.facts, {
    consumerContract: preparedFactsContract,
  }), null);
  const fee = feeContract({
    venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001',
    rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.0001',
    roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL',
    scheduleId: 'synthetic-port-only', observedTs: T0,
  });
  const postCostEvaluation = evaluateEntry({
    snapshot: snapshotBook, q: '1', spec: instrument, fee, atr14: '0.5',
    structuralStop: '95', targetPrice: '110', maxEntryLevel: null,
  });
  assert.equal(postCostEvaluation.status, 'OK', postCostEvaluation.reasons?.join(','));
  const context = { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: 'BTC', venue: 'kraken' };
  return {
    snapshot, factsEnvelope, consumerContract, context, strategyId: 'IGNITION',
    postCostEvaluation, mode: 'PAPER', decisionTs: D,
  };
}

test('actual qualified resolver changes only the PAPER RR rank and returns full bounded evidence identity', () => {
  const input = fixture();
  const port = createAdaptiveRankingPort({
    resolveQualifiedRanking: resolveQualifiedAdaptiveProcedureRanking,
  });
  const result = port.resolve(input);
  assert.equal(port.version, ADAPTIVE_RANKING_PORT_VERSION);
  assert.equal(adaptiveRankingPortResultError(result), null);
  assert.equal(result.applied, true);
  assert.equal(result.disposition, 'APPLIED');
  assert.equal(result.adjustmentRrPoints, 0.015);
  assert.equal(result.effectiveRewardRiskRatio, Number((Number(input.postCostEvaluation.rewardRiskRatio) + 0.015).toFixed(9)));
  assert.equal(result.units, ADAPTIVE_RANKING_UNITS);
  assert.deepEqual(result.measurement, {
    id: ADAPTIVE_RANKING_MEASUREMENT_ID, ok: true, value: 0.015,
    threshold: 0.15, unit: ADAPTIVE_RANKING_UNITS,
    note: result.measurement.note,
  });
  assert.equal(result.evidence.preparedFactsDigest, input.factsEnvelope.facts.factsDigest);
  assert.equal(result.evidence.sourceDigest, input.factsEnvelope.sourceBinding.sourceDigest);
  assert.equal(result.evidence.consumerContractDigest, input.consumerContract.consumerContractDigest);
  assert.equal(result.evidence.costModelVersion, COST_MODEL_VERSION);
  assert.equal(result.evidence.costEvaluationDigest, digestOf(input.postCostEvaluation));
  assert.equal(result.evidence.stateEventDigest, input.snapshot.adaptiveRankingProcedure.stateSource.eventDigest);
  assert.equal(result.evidence.qualificationId, input.snapshot.adaptiveRankingProcedure.qualification.qualificationId);
  assert.ok(result.measurement.note.length <= 300);

  input.snapshot.adaptiveRankingProcedure.currentState.strategies[0].rankOffsetRrPoints = 0.15;
  assert.equal(result.adjustmentRrPoints, 0.015, 'the returned result is immutable and detached from caller inputs');
});

test('signed and zero registered effects stay RR points and never become the legacy rank-score influence', () => {
  const port = createAdaptiveRankingPort({ resolveQualifiedRanking: resolveQualifiedAdaptiveProcedureRanking });
  const negative = fixture(); negative.strategyId = 'PULLBACK';
  const down = port.resolve(negative);
  assert.equal(down.applied, true); assert.equal(down.adjustmentRrPoints, -0.015);
  assert.equal(down.measurement.unit, 'REWARD_RISK_RATIO_POINTS');
  assert.notEqual(down.measurement.unit, 'RANK_SCORE_UNITS');

  const zero = fixture(); zero.strategyId = 'RANGE';
  const flat = port.resolve(zero);
  assert.equal(flat.applied, true); assert.equal(flat.adjustmentRrPoints, 0);
  assert.equal(flat.effectiveRewardRiskRatio, flat.baselineRewardRiskRatio);

  const legacyExtra = fixture(); legacyExtra.legacyLearningResult = { adjust: 100, unit: 'RANK_SCORE_UNITS' };
  const refused = port.resolve(legacyExtra);
  assert.equal(refused.applied, false); assert.equal(refused.reason, 'INPUT_SCHEMA_NOT_CLOSED');
});

test('future/stale/wrong-market facts and wrong recipe or consumer preserve the post-cost baseline', () => {
  const port = createAdaptiveRankingPort({ resolveQualifiedRanking: resolveQualifiedAdaptiveProcedureRanking });
  const cases = [];
  const future = fixture(); future.decisionTs -= 1; cases.push([future, 'FACTS_CONTEXT_OR_CLOCK_MISMATCH']);
  const stale = fixture(); stale.snapshot.preparedTs = D - 16 * MIN; cases.push([stale, 'SNAPSHOT_INVALID_OR_STALE']);
  const asset = fixture(); asset.context.asset = 'ETH'; cases.push([asset, 'FACTS_CONTEXT_OR_CLOCK_MISMATCH']);
  const venue = fixture(); venue.context.venue = 'coinbase'; cases.push([venue, 'FACTS_CONTEXT_OR_CLOCK_MISMATCH']);
  const recipe = fixture(); recipe.consumerContract = clone(recipe.consumerContract);
  recipe.consumerContract.featureRecipeDigest = 'f'.repeat(64); cases.push([recipe, 'CONSUMER_PARENT_INVALID']);
  const effect = fixture(); effect.consumerContract = clone(effect.consumerContract);
  effect.consumerContract.stateEffect.units = 'RANK_SCORE_UNITS'; cases.push([effect, 'CONSUMER_EFFECT_INVALID']);
  for (const [input, reason] of cases) {
    const result = port.resolve(input);
    assert.equal(result.applied, false); assert.equal(result.reason, reason);
    assert.equal(result.effectiveRewardRiskRatio, Number(input.postCostEvaluation.rewardRiskRatio));
    assert.equal(result.adjustmentRrPoints, 0); assert.equal(result.measurement.value, null);
  }
});

test('post-cost identity and arithmetic must match the full facts source before the resolver is called', () => {
  let calls = 0;
  const port = createAdaptiveRankingPort({ resolveQualifiedRanking: (...args) => {
    calls += 1; return resolveQualifiedAdaptiveProcedureRanking(...args);
  } });
  const wrongBook = fixture(); wrongBook.postCostEvaluation = { ...wrongBook.postCostEvaluation, snapshotDigest: 'f'.repeat(64) };
  assert.equal(port.resolve(wrongBook).reason, 'POST_COST_EVALUATION_INVALID');
  const wrongRatio = fixture(); wrongRatio.postCostEvaluation = { ...wrongRatio.postCostEvaluation, rewardRiskRatio: '9' };
  assert.equal(port.resolve(wrongRatio).reason, 'POST_COST_RATIO_INVALID');
  const nonfinite = fixture(); nonfinite.postCostEvaluation = { ...nonfinite.postCostEvaluation, rewardRiskRatio: Infinity };
  assert.equal(port.resolve(nonfinite).reason, 'INPUT_NON_JSON_VALUE_REFUSED');
  assert.equal(calls, 0, 'invalid cost evidence never reaches the qualification resolver');
});

test('throwing, asynchronous, malformed and out-of-envelope resolver outputs fail baseline', async () => {
  const throwing = createAdaptiveRankingPort({ resolveQualifiedRanking() { throw new Error('boom secret'); } });
  assert.equal(throwing.resolve(fixture()).reason, 'RESOLVER_THROW');

  const asynchronous = createAdaptiveRankingPort({ resolveQualifiedRanking: async () => ({ applied: true }) });
  assert.equal(asynchronous.resolve(fixture()).reason, 'RESOLVER_ASYNC_REFUSED');
  await Promise.resolve();

  const malformed = createAdaptiveRankingPort({ resolveQualifiedRanking: () => ({ applied: true }) });
  assert.equal(malformed.resolve(fixture()).reason, 'RESOLVER_RESULT_INVALID');

  const outside = createAdaptiveRankingPort({ resolveQualifiedRanking: (args) => ({
    ...resolveQualifiedAdaptiveProcedureRanking(args), adjustmentRrPoints: 0.2,
    effectiveRewardRiskRatio: Number((Number(args.baselineRewardRiskRatio) + 0.2).toFixed(9)),
  }) });
  const result = outside.resolve(fixture());
  assert.equal(result.applied, false); assert.equal(result.reason, 'RESOLVER_RESULT_INVALID');
  assert.equal(result.adjustmentRrPoints, 0);

  const longReason = createAdaptiveRankingPort({ resolveQualifiedRanking: (args) => ({
    applied: false, reason: 'A'.repeat(120), strategyId: args.strategyId,
    baselineRewardRiskRatio: args.baselineRewardRiskRatio,
    effectiveRewardRiskRatio: args.baselineRewardRiskRatio, adjustmentRrPoints: 0,
    stateSequence: null, stateDigest: null, qualificationId: null,
  }) });
  const bounded = longReason.resolve(fixture());
  assert.equal(bounded.applied, false);
  assert.equal(bounded.reason, 'QUALIFIED_RESOLVER_BASELINE');
  assert.equal(adaptiveRankingPortResultError(bounded), null);
});

test('qualified resolver baseline and revoked/withheld snapshot remain one typed no-effect measurement', () => {
  const port = createAdaptiveRankingPort({ resolveQualifiedRanking: resolveQualifiedAdaptiveProcedureRanking });
  const inapplicable = fixture(); inapplicable.context.setupType = 'OTHER';
  // The publication scope is ANY, but the predicate still sees valid facts; use an unknown strategy instead.
  inapplicable.strategyId = 'UNKNOWN';
  const baseline = port.resolve(inapplicable);
  assert.equal(baseline.applied, false);
  assert.equal(baseline.reason, 'QUALIFIED_RESOLVER_STRATEGY_NOT_REGISTERED');
  assert.equal(baseline.measurement.id, ADAPTIVE_RANKING_MEASUREMENT_ID);
  assert.equal(baseline.measurement.unit, ADAPTIVE_RANKING_UNITS);
  assert.ok(baseline.evidence, 'valid source and qualification identities remain available for the audit capture');

  const revoked = fixture(); revoked.snapshot.kill.state = 'KILLED';
  const stopped = port.resolve(revoked);
  assert.equal(stopped.applied, false); assert.equal(stopped.reason, 'SNAPSHOT_INVALID_OR_STALE');
  assert.equal(stopped.evidence, null);
});

test('accessors, hidden values and source/context relabeling are rejected before resolver invocation', () => {
  let calls = 0;
  const port = createAdaptiveRankingPort({ resolveQualifiedRanking: () => { calls += 1; return null; } });
  const accessor = fixture();
  Object.defineProperty(accessor.context, 'asset', { enumerable: true, get: () => 'BTC' });
  assert.equal(port.resolve(accessor).reason, 'INPUT_ACCESSOR_OR_HIDDEN_PROPERTY_REFUSED');

  let accessorCalls = 0;
  const rootAccessor = fixture();
  Object.defineProperty(rootAccessor, 'strategyId', {
    enumerable: true, get: () => { accessorCalls += 1; return 'IGNITION'; },
  });
  assert.equal(port.resolve(rootAccessor).reason, 'INPUT_ACCESSOR_OR_HIDDEN_PROPERTY_REFUSED');
  assert.equal(accessorCalls, 0, 'baseline construction must not invoke a refused root accessor');

  const costAccessor = fixture();
  costAccessor.postCostEvaluation = clone(costAccessor.postCostEvaluation);
  Object.defineProperty(costAccessor.postCostEvaluation, 'rewardRiskRatio', {
    enumerable: true, get: () => { accessorCalls += 1; return '1'; },
  });
  const refusedCost = port.resolve(costAccessor);
  assert.equal(refusedCost.reason, 'INPUT_ACCESSOR_OR_HIDDEN_PROPERTY_REFUSED');
  assert.equal(refusedCost.baselineRewardRiskRatio, null);
  assert.equal(accessorCalls, 0, 'baseline construction must not invoke a refused nested accessor');

  const hidden = fixture(); Object.defineProperty(hidden, 'secret', { enumerable: false, value: 'x' });
  assert.equal(port.resolve(hidden).reason, 'INPUT_ACCESSOR_OR_HIDDEN_PROPERTY_REFUSED');

  const relabeled = fixture(); relabeled.factsEnvelope = clone(relabeled.factsEnvelope);
  relabeled.factsEnvelope.sourceBinding.market.canonicalCoin = 'ETH';
  assert.equal(port.resolve(relabeled).reason, 'FACTS_ENVELOPE_INVALID');
  assert.equal(calls, 0);
  assert.equal(adaptiveRankingPortInputError(fixture()), null);
});
