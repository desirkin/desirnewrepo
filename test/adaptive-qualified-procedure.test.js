import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest, canonicalJson, opportunityIdOf } from '../learning/contracts.js';
import {
  ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION,
  ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2,
  ADAPTIVE_RANKING_TRIAL_COMPARATOR, ADAPTIVE_RANKING_TRIAL_COST_MODEL,
  ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC, adaptiveRankingTrialRecordValidator,
  adaptiveRankingExecutionSourceIdentity,
  readQualifiedAdaptiveProcedureDecision, resolveQualifiedAdaptiveProcedureRanking,
  sealAdaptiveProcedureConsumerContract, sealAdaptiveProcedurePublication,
  sealAdaptiveProcedurePublicationV2, sealAdaptiveRankingAbstainExecutionArm,
  sealAdaptiveRankingTrialDecision, sealAdaptiveRankingTrialExecution,
  sealAdaptiveRankingTrialDecisionV2, sealAdaptiveRankingTrialExecutionV2,
} from '../learning/adaptive-qualified-procedure.js';
import { buildShadowCapture } from '../learning/shadow-capture.js';
import { matureShadowCapture } from '../learning/shadow-outcome.js';
import { evaluateShadowExecutionEvidence, SHADOW_EXECUTION_EVIDENCE_VERSION } from '../learning/shadow-execution-evidence.js';
import {
  ADAPTIVE_DURABLE_ACK_VERSION, ADAPTIVE_DURABLE_STREAM_VERSION,
  openDurableAdaptiveStore,
} from '../learning/adaptive-durable-store.js';
import { createAdaptiveProspectiveOwner } from '../learning/adaptive-prospective-owner.js';
import {
  ADAPTIVE_HORIZON_MS, adaptiveStateDigestOf, initialAdaptiveState, sealAdaptiveProcedure,
} from '../learning/adaptive-registry.js';
import {
  ADAPTIVE_JOURNAL_EVENT_VERSION, ADAPTIVE_STORE_VERSION,
  createAdaptiveStore, validateAdaptiveStoreSnapshot,
} from '../learning/adaptive-store.js';
import { adaptiveSettlementSubmission } from './helpers/adaptive-outcome-fixture.js';
import {
  buildJudgeLearningConsumerContract, buildJudgeLearningPreparedFacts,
  judgeLearningPreparedFactsError,
} from '../judge/learning-recipe.js';
import { digestOf } from '../execution/contract.js';
import { buildEvidence, buildPatternRecord, estimateFromEvidence } from '../learning/patterns.js';
import { freezeCandidate, settleCandidate } from '../learning/promotion.js';
import { transitionActivation } from '../learning/adapter.js';
import { createLearningStore } from '../learning/store.js';
import { evaluateTerminal, interimView, replayProspective } from '../learning/prospective.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 1, 12);
const POLICY = 'a'.repeat(64);
const COST = { costPolicyVersion: 'adaptive-rank-trial-cost-1', feePctPerSide: 0.1, assumedHalfSpreadBps: 2, assumedLatencyMs: 500 };
const clone = (value) => structuredClone(value);

function tempRoot(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
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

function bookAt(receiptTs, coin) {
  const snapshot = {
    snapshotVersion: 'execution-book-snapshot-1', symbol: `${coin}/USD`, canonicalCoin: coin,
    feedEpoch: 7, receiptSequence: 99, nativeSequence: null,
    sourceTs: receiptTs, receiptTs, crc: 1, crcVerified: true, crcComputed: 1,
    synced: true, instrumentDigest: 'c'.repeat(64), priceDecimals: 2, qtyDecimals: 8,
    bids: [['99.95', '250']], asks: [['100.05', '250']], levelsCap: 100,
    truncated: false, kind: 'UPDATE', digest: 'x'.repeat(64),
  };
  snapshot.digest = digestOf({ ...snapshot, digest: null });
  return snapshot;
}

function preparedFacts(consumer, decisionTs, coin) {
  const facts = buildJudgeLearningPreparedFacts({
    frozen: null, decisionTs, bookSnapshot: bookAt(decisionTs - 250, coin),
    barEvidence: null, tradeEvidence: null,
  });
  assert.equal(judgeLearningPreparedFactsError(facts, { consumerContract: consumer }), null);
  return facts;
}

function initialStream(t, procedure) {
  const root = tempRoot(t, 'adaptive-procedure-origin-');
  const local = createAdaptiveStore({ rootDir: root, procedure, clock: () => T0 });
  local.close();
  const journalText = readFileSync(path.join(root, 'journal.jsonl'), 'utf8');
  const acknowledgedHead = JSON.parse(readFileSync(path.join(root, 'head.json'), 'utf8'));
  const snapshot = validateAdaptiveStoreSnapshot({ journalText, acknowledgedHead, procedure });
  return {
    outcome: 'LOADED', streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
    storeVersion: ADAPTIVE_STORE_VERSION, eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
    procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
    revision: snapshot.eventCount, journalText, acknowledgedHead,
    acknowledgments: snapshot.events.map((event, sequence) => ({
      ackVersion: ADAPTIVE_DURABLE_ACK_VERSION, sequence,
      eventDigest: event.eventDigest, headDigest: snapshot.eventHeadDigests[sequence],
      acknowledgedTs: event.recordedTs,
    })),
  };
}

class MemoryPort {
  constructor(stream, clock) { this.stream = clone(stream); this.clock = clock; }
  async load() { return clone(this.stream); }
  async append(request) {
    assert.equal(request.expectedRevision, this.stream.revision);
    assert.equal(request.expectedHeadDigest, this.stream.acknowledgedHead.headDigest);
    const acknowledgedTs = this.clock();
    this.stream.journalText += `${canonicalJson(request.event)}\n`;
    this.stream.acknowledgedHead = clone(request.nextAcknowledgedHead);
    this.stream.revision += 1;
    this.stream.acknowledgments.push({
      ackVersion: ADAPTIVE_DURABLE_ACK_VERSION, sequence: request.event.sequence,
      eventDigest: request.event.eventDigest, headDigest: request.nextAcknowledgedHead.headDigest,
      acknowledgedTs,
    });
    return {
      outcome: 'APPENDED', ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
      storeVersion: ADAPTIVE_STORE_VERSION, eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
      procedureId: request.identity.procedureId, procedureDigest: request.identity.procedureDigest,
      revision: this.stream.revision, eventDigest: request.event.eventDigest,
      headDigest: request.nextAcknowledgedHead.headDigest, acknowledgedTs,
    };
  }
}

function predictionInput(procedure, facts, decisionTs, coin, selection, eligible = procedure.strategies) {
  const identity = {
    canonicalCoin: coin, decisionTs,
    captureRecipeVersion: 'adaptive-ranking-trial-input-1', datasetId: 'adaptive-ranking-trial-fixture',
  };
  return {
    opportunityId: opportunityIdOf(identity), identity, catalogContentId: 'catalog-ranking-trial-1',
    predictionTs: decisionTs, horizonMs: ADAPTIVE_HORIZON_MS,
    featureRecipeDigest: procedure.parent.featureRecipeDigest, factsDigest: facts,
    strategyAssessments: procedure.strategies.map((strategyId) => ({
      strategyId, eligibility: eligible.includes(strategyId) ? 'ELIGIBLE' : 'UNAVAILABLE',
      reasonCode: eligible.includes(strategyId) ? null : 'FIXTURE_NOT_ASSESSED',
    })),
    selection: { strategyId: selection, reasonCode: 'DETERMINISTIC_RANK_SELECTION' },
  };
}

function shadowRecipe(strategyId) {
  return {
    recipeVersion: `adaptive-${strategyId.toLowerCase()}-execution-1`, styleId: strategyId,
    requiredInputs: ['CANDLES_1M', 'VOLUME'], contextualInputs: [],
    candleWindowMin: 5, candlePeriodMs: MIN, maxInputAgeMs: 2 * MIN,
    horizonMin: 60, costPolicy: COST,
    variants: [
      { variantId: `${strategyId.toLowerCase()}-take`, decision: 'TAKE', sizeTier: 'S', intendedAllocation: { kind: 'QUOTE_NOTIONAL', quoteCurrency: 'USD', amount: 600 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'STOP_TARGET_OR_HORIZON', stopPct: 50, targetPct: 50 },
      { variantId: `${strategyId.toLowerCase()}-abstain`, decision: 'ABSTAIN', sizeTier: 'S', intendedAllocation: { kind: 'NONE', quoteCurrency: null, amount: 0 }, entryRule: 'NEXT_CANDLE_OPEN', limitOffsetBps: null, exitRule: 'NONE', stopPct: null, targetPct: null },
    ],
  };
}

function shadowCapture(strategyId, decisionTs, coin) {
  const candles = Array.from({ length: 5 }, (_, index) => ({
    periodStartTs: decisionTs - (5 - index) * MIN,
    periodEndTs: decisionTs - (4 - index) * MIN,
    open: 100, high: 100.2, low: 99.8, close: 100,
    volumeBase: 10, volumeQuote: 1_000, tradeFlow: 0,
    closed: true, knownAtTs: decisionTs - (4 - index) * MIN,
  }));
  const built = buildShadowCapture({
    recipe: shadowRecipe(strategyId), venue: 'KRAKEN', assetId: coin, decisionTs,
    inputs: { candles, depth: { bids: [[99.9, 10]], asks: [[100.1, 10]], knownAtTs: decisionTs - 500 } },
  });
  assert.equal(built.ineligible.length, 0);
  return built.eligible.find((row) => row.variant.decision === 'TAKE');
}

function point(side, signalKnownAtTs, price, epochId) {
  return {
    side, signalKnownAtTs, executionTs: signalKnownAtTs + COST.assumedLatencyMs,
    snapshot: {
      bids: [[price, 10], [price - 0.1, 10]], asks: [[price + 0.2, 10], [price + 0.3, 10]],
      receivedTs: signalKnownAtTs + 100, knownAtTs: signalKnownAtTs + 200,
      sourceEventTs: signalKnownAtTs + 50, epochId,
      synchronized: true, checksumVerified: true, truncated: false,
    },
    coverage: {
      state: 'CONTINUOUS', startTs: signalKnownAtTs - 1_000,
      endTs: signalKnownAtTs + 600, epochId, droppedUpdates: 0,
    },
  };
}

function executionArm(decisionArm, decisionTs, exitBid) {
  const capture = decisionArm.executionCapture;
  const path = Array.from({ length: 60 }, (_, index) => ({
    periodStartTs: decisionTs + index * MIN, periodEndTs: decisionTs + (index + 1) * MIN,
    open: 100, high: 100.3, low: 99.7, close: 100,
    volumeBase: 5, closed: true, knownAtTs: decisionTs + (index + 1) * MIN + 200,
  }));
  const depthPath = {
    evidenceVersion: SHADOW_EXECUTION_EVIDENCE_VERSION,
    captureId: capture.captureId, variantId: capture.variantId, sizeTier: capture.variant.sizeTier,
    intended: { quoteNotional: 600, baseQty: null },
    entry: point('BUY', decisionTs, 99.9, `entry-${capture.captureId}`),
    exit: point('SELL', decisionTs + HOUR, exitBid, `exit-${capture.captureId}`),
  };
  const asOfTs = decisionTs + HOUR + 1_000;
  const evidence = evaluateShadowExecutionEvidence({
    capture, costPolicy: COST, depthPath, entrySignalTs: decisionTs,
    exitSignalTs: decisionTs + HOUR, asOfTs,
  });
  assert.equal(evidence.state, 'COMPLETE', evidence.reason);
  const outcome = matureShadowCapture({ capture, path, depthPath, asOfTs });
  assert.equal(outcome.sizeEvidence, 'DEPTH_SUPPORTED_OBSERVED', JSON.stringify(outcome));
  const accounting = evidence.accounting;
  const feeFraction = COST.feePctPerSide / 100;
  assert.equal(
    accounting.roundTripFeesQuote,
    Number(((accounting.entryQuote + accounting.exitQuote) * feeFraction).toFixed(6)),
    'the round-trip fee is one entry charge plus one exit charge',
  );
  assert.equal(outcome.netPct, accounting.netPct, 'the matured outcome reuses, rather than re-deducts, exact cost accounting');
  return {
    selectedStrategyId: decisionArm.selectedStrategyId,
    sourceIdentity: adaptiveRankingExecutionSourceIdentity({ decisionArm, depthPath }),
    path, depthPath, asOfTs, outcome,
  };
}

function appendAccumulatingPattern(store, publication) {
  const observations = Array.from({ length: 8 }, (_, index) => ({
    opportunityId: `lop-dynamic-history-${index}`, canonicalCoin: `H${index % 5}`,
    decisionTs: T0 - 20 * DAY + index * DAY, evidenceBasis: 'HISTORICAL_RECONSTRUCTION',
    outcomeClass: index % 4 === 3 ? 'ADVERSE' : 'FAVORABLE',
  }));
  const base = buildEvidence(observations);
  const evidence = { ...base, evidenceRefs: [publication.publicationId], evidenceRefsTruncated: false };
  const estimate = estimateFromEvidence(observations, evidence, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 - DAY });
  store.appendPattern(buildPatternRecord({
    predicate: publication.applicability, scope: publication.scope, origin: 'ADAPTIVE_PROCEDURE_PROPOSAL',
    createdTs: T0 - 20 * DAY, ts: T0 - 20 * DAY, seq: 0, state: 'NOTICED',
    previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence, estimate, contradictions: [],
  }));
  const noticed = store.patternHeads().values().next().value;
  store.appendPattern(buildPatternRecord({
    predicate: noticed.predicate, scope: noticed.scope, origin: noticed.origin,
    createdTs: noticed.createdTs, ts: T0 - 10 * DAY, seq: 1, state: 'ACCUMULATING',
    previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE',
    evidence, estimate, contradictions: [],
  }));
  return store.patternHeads().values().next().value;
}

async function fixture(t, {
  sameSelection = false, sameCohortPair = false, trialVersion = 'V1', abstainGroups = new Set(),
} = {}) {
  const base = staticConsumer();
  const consumer = sealAdaptiveProcedureConsumerContract({ preparedFactsContract: base });
  const procedure = sealAdaptiveProcedure({
    parentPolicyDigest: consumer.policyDigest, consumerContractDigest: consumer.consumerContractDigest,
    featureRecipeDigest: consumer.featureRecipeDigest, strategyIds: ['IGNITION', 'PULLBACK', 'RANGE'], createdTs: T0,
  });
  const now = { value: T0 + MIN };
  const port = new MemoryPort(initialStream(t, procedure), () => now.value);
  const rootDir = tempRoot(t, 'adaptive-qualified-procedure-state-');
  let durable = await openDurableAdaptiveStore({ rootDir, procedure, durablePort: port, clock: () => now.value, portTimeoutMs: 1_000 });
  let owner = createAdaptiveProspectiveOwner({ store: durable, procedure, clock: () => now.value });

  const bootstrapInput = predictionInput(procedure, 'b'.repeat(64), now.value, 'BTC', 'IGNITION', ['IGNITION']);
  const bootstrap = await owner.recordPrediction(bootstrapInput);
  now.value = bootstrap.prediction.targetEndTs + 1_000;
  const bootstrapSettlement = adaptiveSettlementSubmission(procedure, bootstrap.prediction, {
    opportunityId: bootstrap.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
    state: 'MATURED', logReturnPct: 1, sourceEventTs: bootstrap.prediction.targetEndTs,
    knownAtTs: now.value, sourceDigest: 'c'.repeat(64), reasonCode: null,
  });
  assert.equal((await owner.recordOutcome(bootstrapSettlement)).status, 'UPDATED');
  now.value += MIN;
  const adverseSeed = await owner.recordPrediction(predictionInput(procedure, 'e'.repeat(64), now.value, 'ETH', 'PULLBACK', ['PULLBACK']));
  now.value = adverseSeed.prediction.targetEndTs + 1_000;
  const adverseSeedSubmission = adaptiveSettlementSubmission(procedure, adverseSeed.prediction, {
    opportunityId: adverseSeed.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
    state: 'MATURED', logReturnPct: -1, sourceEventTs: adverseSeed.prediction.targetEndTs,
    knownAtTs: now.value, sourceDigest: 'f'.repeat(64), reasonCode: null,
  });
  assert.equal((await owner.recordOutcome(adverseSeedSubmission)).status, 'UPDATED');
  const signedState = owner.state();
  assert.equal(signedState.strategies.find((row) => row.strategyId === 'IGNITION').rankOffsetRrPoints, 0.015);
  assert.equal(signedState.strategies.find((row) => row.strategyId === 'PULLBACK').rankOffsetRrPoints, -0.015);
  assert.equal(signedState.strategies.find((row) => row.strategyId === 'RANGE').rankOffsetRrPoints, 0);

  const publication = (trialVersion === 'V2' ? sealAdaptiveProcedurePublicationV2 : sealAdaptiveProcedurePublication)({
    procedure, initialState: initialAdaptiveState(procedure),
    consumerContract: consumer,
    scope: { setupType: 'ANY', regime: 'ANY', assets: 'ANY', venues: ['KRAKEN'] },
    applicability: { clauses: [{ feature: 'spreadBps', op: 'LTE', threshold: 20 }] },
    sealedTs: now.value,
  });
  const learningDir = tempRoot(t, 'adaptive-procedure-promotion-');
  const learning = createLearningStore({ dataDir: learningDir });
  const pattern = appendAccumulatingPattern(learning, publication);
  const design = freezeCandidate({
    store: learning, pattern, costModel: ADAPTIVE_RANKING_TRIAL_COST_MODEL,
    primaryMetric: ADAPTIVE_RANKING_TRIAL_PRIMARY_METRIC,
    comparator: ADAPTIVE_RANKING_TRIAL_COMPARATOR,
    consumerBinding: {
      featureRecipeVersion: base.featureRecipe.featureRecipeVersion,
      policyDigest: consumer.policyDigest,
    }, nowTs: publication.sealedTs + 1_000,
  });
  const validator = adaptiveRankingTrialRecordValidator({
    publications: [publication],
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    adaptiveStore: durable,
  });
  const trial = [];
  const trialBaseTs = sameCohortPair
    ? Math.ceil((design.sealedTs + HOUR) / (4 * HOUR)) * (4 * HOUR) + MIN
    : null;
  for (let group = 0; group < 34; group += 1) {
    const decisionTs = sameCohortPair
      ? (group === 1 ? trialBaseTs + 3 * HOUR + 2 * MIN : trialBaseTs + group * 6 * HOUR)
      : Math.ceil((design.sealedTs + HOUR + group * 6 * HOUR) / MIN) * MIN;
    now.value = decisionTs;
    const coin = sameCohortPair && group === 1 ? 'A0' : `A${group % 6}`;
    const facts = preparedFacts(base, decisionTs, coin);
    const abstain = trialVersion === 'V2' && abstainGroups.has(group);
    const eligible = trialVersion === 'V2' ? (abstain ? [] : ['IGNITION', 'PULLBACK']) : procedure.strategies;
    const savedInput = predictionInput(
      procedure, facts.factsDigest, decisionTs, coin, abstain ? null : 'IGNITION', eligible,
    );
    if (trialVersion === 'V2') {
      savedInput.strategyAssessments[2] = {
        strategyId: 'RANGE', eligibility: 'INELIGIBLE', reasonCode: 'FIXTURE_RISK_GATE',
      };
    }
    const saved = await owner.recordPrediction(savedInput);
    const context = { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: coin, venue: 'KRAKEN' };
    const candidateArm = abstain
      ? { selectedStrategyId: null, executionCapture: null }
      : { selectedStrategyId: 'IGNITION', executionCapture: shadowCapture('IGNITION', decisionTs, coin) };
    const baselineArm = abstain
      ? candidateArm
      : sameSelection
      ? candidateArm
      : { selectedStrategyId: 'PULLBACK', executionCapture: shadowCapture('PULLBACK', decisionTs, coin) };
    const decisionSeal = trialVersion === 'V2' ? sealAdaptiveRankingTrialDecisionV2 : sealAdaptiveRankingTrialDecision;
    const rankCandidates = trialVersion === 'V2' ? [
      { strategyId: 'IGNITION', eligibility: abstain ? 'UNAVAILABLE' : 'ELIGIBLE', reasonCode: abstain ? 'FIXTURE_NOT_ASSESSED' : null, baselineRewardRiskRatio: abstain ? null : (sameSelection ? 1.02 : 1) },
      { strategyId: 'PULLBACK', eligibility: abstain ? 'UNAVAILABLE' : 'ELIGIBLE', reasonCode: abstain ? 'FIXTURE_NOT_ASSESSED' : null, baselineRewardRiskRatio: abstain ? null : 1.01 },
      { strategyId: 'RANGE', eligibility: 'INELIGIBLE', reasonCode: 'FIXTURE_RISK_GATE', baselineRewardRiskRatio: null },
    ] : [
      { strategyId: 'IGNITION', baselineRewardRiskRatio: sameSelection ? 1.02 : 1 },
      { strategyId: 'PULLBACK', baselineRewardRiskRatio: 1.01 },
      { strategyId: 'RANGE', baselineRewardRiskRatio: 0.5 },
    ];
    const decisionReceipt = decisionSeal({
      publication, candidateId: design.candidateId, opportunityId: saved.prediction.opportunityId,
      adaptiveState: owner.state(), prediction: saved.prediction,
      predictionAck: saved.durableAcknowledgment, preparedFacts: facts, context,
      rankCandidates, baselineArm, candidateArm, recordedTs: now.value,
      validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
      adaptiveStore: durable,
    });
    const capture = {
      kind: 'ADAPTIVE_RANKING_TRIAL_CAPTURE', candidateId: design.candidateId,
      opportunityId: saved.prediction.opportunityId, publicationId: publication.publicationId,
      decisionReceipt,
    };
    learning.appendProspective(capture);
    const candidate = abstain
      ? sealAdaptiveRankingAbstainExecutionArm({ asOfTs: decisionTs + HOUR + 1_000 })
      : executionArm(candidateArm, decisionTs, 103);
    const baseline = abstain ? candidate : sameSelection ? candidate : executionArm(baselineArm, decisionTs, 100);
    now.value = decisionTs + HOUR + 1_000;
    const executionSeal = trialVersion === 'V2' ? sealAdaptiveRankingTrialExecutionV2 : sealAdaptiveRankingTrialExecution;
    const executionReceipt = executionSeal({
      publication, decisionReceipt, candidate, baseline, recordedTs: now.value,
      validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
      adaptiveStore: durable,
    });
    const outcome = {
      kind: 'ADAPTIVE_RANKING_TRIAL_OUTCOME', candidateId: design.candidateId,
      opportunityId: saved.prediction.opportunityId, publicationId: publication.publicationId,
      executionReceipt,
    };
    learning.appendProspective(outcome);
    trial.push({ capture, outcome, decisionReceipt, executionReceipt, saved, facts, context });
    const auxiliaryTs = decisionTs + 2 * HOUR;
    now.value = auxiliaryTs;
    const auxiliaryStrategy = group % 2 === 0 ? 'IGNITION' : 'PULLBACK';
    const auxiliary = await owner.recordPrediction(predictionInput(
      procedure, canonicalDigest({ auxiliary: group }), auxiliaryTs, `Z${group % 6}`,
      auxiliaryStrategy, [auxiliaryStrategy],
    ));
    now.value = auxiliary.prediction.targetEndTs + 1_000;
    const auxiliarySubmission = adaptiveSettlementSubmission(procedure, auxiliary.prediction, {
      opportunityId: auxiliary.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
      state: 'MATURED', logReturnPct: auxiliaryStrategy === 'IGNITION' ? 1 : -1,
      sourceEventTs: auxiliary.prediction.targetEndTs, knownAtTs: now.value,
      sourceDigest: canonicalDigest({ auxiliarySource: group }), reasonCode: null,
    });
    assert.equal((await owner.recordOutcome(auxiliarySubmission)).status, 'UPDATED');
    trial[group].stateSettlement = durable.settlement({
      opportunityId: auxiliary.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
    });
  }
  const replay = replayProspective(learning.readProspective(), { adaptiveRankingTrialValidator: validator });
  assert.deepEqual(replay.errors, []);
  const settled = settleCandidate({
    store: learning, candidateId: design.candidateId, nowTs: now.value + 1_000,
    adaptiveRankingTrialValidator: validator,
  });
  assert.equal(settled.terminal.verdict, sameSelection ? 'FORWARD_NOT_SUPPORTED' : 'FORWARD_SUPPORTED');
  if (sameSelection) {
    return { base, consumer, procedure, publication, learning, learningDir, design, trial, settled, owner, durable, port, now, validator, bootstrap, rootDir };
  }
  const active = transitionActivation(settled.activation, {
    state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: settled.activation.ts + 1,
  });
  learning.appendActivation(active);
  const validated = learning.patternHeads().get(pattern.patternId);
  learning.appendPattern(buildPatternRecord({
    predicate: validated.predicate, scope: validated.scope, origin: validated.origin,
    createdTs: validated.createdTs, ts: active.ts, seq: validated.seq + 1,
    state: 'ACTIVE_PAPER', previousState: validated.state,
    transitionReason: 'PAPER_RUNTIME_ADOPTED', evidence: validated.evidence,
    estimate: validated.estimate, contradictions: validated.contradictions,
    candidateId: validated.candidateId, activationId: active.activationId,
  }));
  now.value = active.ts + MIN;
  return { base, consumer, procedure, publication, learning, learningDir, design, trial, settled, active, owner, durable, port, now, validator, bootstrap, adverseSeed, rootDir };
}

test('whole frozen procedure earns one typed qualification from independent per-arm executions and later ACKed state evolves without requalification', async (t) => {
  const f = await fixture(t);
  assert.equal(f.trial[0].decisionReceipt.candidateSelectedStrategyId, 'IGNITION');
  assert.equal(f.trial[0].decisionReceipt.baselineSelectedStrategyId, 'PULLBACK');
  assert.notEqual(f.trial[0].executionReceipt.candidate.outcome.netPct, f.trial[0].executionReceipt.baseline.outcome.netPct, 'each selected strategy has its own recomputed after-cost outcome');
  const settlement = f.durable.settlement({
    opportunityId: f.trial[0].saved.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
  });
  assert.equal(settlement, null, 'trial forecasts do not silently become adaptive outcomes');
  const initialSettlement = f.trial.at(-1).stateSettlement;
  assert.ok(initialSettlement, 'a genuinely matured scored update has durable readback');
  let snapshot = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: initialSettlement,
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(snapshot.withheld.length, 0);
  assert.equal(snapshot.adaptiveRankingProcedure.qualification.qualificationVersion, 'adaptive-ranking-procedure-qualification-1');
  const qualificationId = snapshot.adaptiveRankingProcedure.qualification.qualificationId;
  const historicalFacts = preparedFacts(f.base, f.trial[0].facts.decisionTs, 'BTC');
  const context = { ...f.trial[0].context, asset: 'BTC' };
  const facts = preparedFacts(f.base, f.now.value, 'BTC');
  const historical = resolveQualifiedAdaptiveProcedureRanking({
    snapshot, consumerContract: f.consumer, preparedFacts: historicalFacts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context, strategyId: 'IGNITION', baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: f.now.value,
  });
  assert.equal(historical.applied, false, 'a current learned state cannot be projected onto an old decision frame');
  assert.equal(historical.reason, 'PREPARED_FACTS_CLOCK_OR_STATE_ASOF_MISMATCH');
  const positive = resolveQualifiedAdaptiveProcedureRanking({
    snapshot, consumerContract: f.consumer, preparedFacts: facts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context, strategyId: 'IGNITION', baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: f.now.value,
  });
  const preChangeState = snapshot.adaptiveRankingProcedure.currentState;
  assert.equal(positive.applied, true);
  assert.equal(positive.adjustmentRrPoints, preChangeState.strategies.find((row) => row.strategyId === 'IGNITION').rankOffsetRrPoints);
  assert.ok(preChangeState.sequence > f.trial[0].decisionReceipt.adaptiveState.sequence, 'the prospective trial consumed later lawful procedure states');
  assert.ok(preChangeState.strategies.find((row) => row.strategyId === 'IGNITION').rankOffsetRrPoints > 0);
  assert.ok(preChangeState.strategies.find((row) => row.strategyId === 'PULLBACK').rankOffsetRrPoints < 0);
  assert.equal(resolveQualifiedAdaptiveProcedureRanking({
    snapshot, consumerContract: f.consumer, preparedFacts: facts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context, strategyId: 'RANGE', baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: f.now.value,
  }).adjustmentRrPoints, 0, 'the registered zero state remains an exact qualified no-op');
  const stale = resolveQualifiedAdaptiveProcedureRanking({
    snapshot: { ...clone(snapshot), preparedTs: snapshot.preparedTs - 16 * MIN },
    consumerContract: f.consumer, preparedFacts: facts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context, strategyId: 'IGNITION', baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: f.now.value,
  });
  assert.equal(stale.applied, false); assert.equal(stale.effectiveRewardRiskRatio, 1);

  const laterDecisionTs = f.now.value + MIN;
  f.now.value = laterDecisionTs;
  const laterFacts = preparedFacts(f.base, laterDecisionTs, 'BTC');
  const laterPrediction = await f.owner.recordPrediction(predictionInput(f.procedure, laterFacts.factsDigest, laterDecisionTs, 'BTC', 'IGNITION'));
  f.now.value = laterPrediction.prediction.targetEndTs + 1_000;
  const adverse = adaptiveSettlementSubmission(f.procedure, laterPrediction.prediction, {
    opportunityId: laterPrediction.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
    state: 'MATURED', logReturnPct: -1, sourceEventTs: laterPrediction.prediction.targetEndTs,
    knownAtTs: f.now.value, sourceDigest: 'd'.repeat(64), reasonCode: null,
  });
  assert.equal((await f.owner.recordOutcome(adverse)).status, 'UPDATED');
  assert.equal((await f.owner.recordOutcome(adverse)).status, 'EXISTING', 'duplicate outcome cannot update the procedure twice');
  await f.owner.close();
  f.durable = await openDurableAdaptiveStore({ rootDir: f.rootDir, procedure: f.procedure, durablePort: f.port, clock: () => f.now.value, portTimeoutMs: 1_000 });
  f.owner = createAdaptiveProspectiveOwner({ store: f.durable, procedure: f.procedure, clock: () => f.now.value });
  f.learning = createLearningStore({ dataDir: f.learningDir });
  const laterSettlement = f.durable.settlement({ opportunityId: laterPrediction.prediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS });
  const beforeStateWasKnown = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: laterSettlement,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: laterSettlement.update.appliedTs - 1, mode: 'PAPER',
  });
  assert.equal(beforeStateWasKnown.adaptiveRankingProcedure, null, 'a later state cannot influence an earlier snapshot');
  assert.match(beforeStateWasKnown.withheld[0].reason, /CURRENT_ACK_LINEAGE_INVALID/);
  const futureAcknowledgment = clone(laterSettlement);
  futureAcknowledgment.custody.durableAcknowledgment.acknowledgedTs = f.now.value + 1;
  const beforeDurableAck = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: futureAcknowledgment,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(beforeDurableAck.adaptiveRankingProcedure, null, 'a future durable ACK cannot authorize a current snapshot');
  assert.match(beforeDurableAck.withheld[0].reason, /CURRENT_ACK_LINEAGE_INVALID/);
  const acknowledgmentBeforeState = clone(laterSettlement);
  acknowledgmentBeforeState.custody.durableAcknowledgment.acknowledgedTs = laterSettlement.update.appliedTs - 1;
  const invalidAckOrder = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: acknowledgmentBeforeState,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(invalidAckOrder.adaptiveRankingProcedure, null, 'the durable ACK cannot precede the state it acknowledges');
  const staleStateSettlement = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: initialSettlement,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(staleStateSettlement.adaptiveRankingProcedure, null, 'a prior ACK cannot authorize the latest learned state');
  snapshot = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: laterSettlement,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(snapshot.adaptiveRankingProcedure.qualification.qualificationId, qualificationId, 'state evolution does not mint another approval');
  const postUpdateFacts = preparedFacts(f.base, f.now.value, 'BTC');
  const zero = resolveQualifiedAdaptiveProcedureRanking({
    snapshot, consumerContract: f.consumer, preparedFacts: postUpdateFacts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context: { ...context, asset: 'BTC' }, strategyId: 'IGNITION', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: f.now.value,
  });
  const negative = resolveQualifiedAdaptiveProcedureRanking({
    snapshot, consumerContract: f.consumer, preparedFacts: postUpdateFacts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context: { ...context, asset: 'BTC' }, strategyId: 'PULLBACK', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: f.now.value,
  });
  assert.equal(zero.applied, true);
  assert.ok(zero.adjustmentRrPoints < preChangeState.strategies.find((row) => row.strategyId === 'IGNITION').rankOffsetRrPoints, 'new adverse evidence deteriorates the positive influence under the frozen update law');
  assert.equal(negative.applied, true); assert.ok(negative.adjustmentRrPoints < 0);
  assert.ok(negative.effectiveRewardRiskRatio < 1);
  const outsideEnvelope = clone(snapshot);
  outsideEnvelope.adaptiveRankingProcedure.currentState.strategies[0].rankOffsetRrPoints = 0.151;
  outsideEnvelope.adaptiveRankingProcedure.currentState.stateDigest = adaptiveStateDigestOf(
    outsideEnvelope.adaptiveRankingProcedure.currentState,
  );
  const refusedOutsideEnvelope = resolveQualifiedAdaptiveProcedureRanking({
    snapshot: outsideEnvelope, consumerContract: f.consumer, preparedFacts: postUpdateFacts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context: { ...context, asset: 'BTC' }, strategyId: 'IGNITION', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: f.now.value,
  });
  assert.equal(refusedOutsideEnvelope.applied, false, 'a rehashed state outside the qualified envelope is refused');
  const mismatchedStateSource = clone(snapshot);
  mismatchedStateSource.adaptiveRankingProcedure.currentState.strategies[0].rankOffsetRrPoints += 0.001;
  mismatchedStateSource.adaptiveRankingProcedure.currentState.stateDigest = adaptiveStateDigestOf(
    mismatchedStateSource.adaptiveRankingProcedure.currentState,
  );
  const refusedMismatchedSource = resolveQualifiedAdaptiveProcedureRanking({
    snapshot: mismatchedStateSource, consumerContract: f.consumer, preparedFacts: postUpdateFacts,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    context: { ...context, asset: 'BTC' }, strategyId: 'IGNITION', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: f.now.value,
  });
  assert.equal(refusedMismatchedSource.applied, false, 'a rehashed state without its matching durable source is refused');
  await f.owner.close();
});

test('same selected strategy uses one exact control arm and cannot manufacture an improvement', async (t) => {
  const f = await fixture(t, { sameSelection: true });
  assert.equal(f.settled.terminal.effect.pairedMeanDiff, 0);
  assert.equal(f.settled.terminal.verdict, 'FORWARD_NOT_SUPPORTED');
  assert.equal(f.settled.activation, null);
  assert.equal(f.learning.activationHeads().size, 0);
  await f.owner.close();
});

test('V2 ranks the exact eligible subset, includes explicit no-eligible abstentions in the denominator, and can qualify through the sole promoter', async (t) => {
  const f = await fixture(t, { trialVersion: 'V2', abstainGroups: new Set([5]) });
  assert.equal(f.publication.publicationVersion, 'adaptive-ranking-procedure-publication-2');
  const selected = f.trial[0].decisionReceipt;
  assert.equal(selected.decisionVersion, ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION_V2);
  assert.deepEqual(selected.rankCandidates.map((row) => [row.strategyId, row.eligibility]), [
    ['IGNITION', 'ELIGIBLE'], ['PULLBACK', 'ELIGIBLE'], ['RANGE', 'INELIGIBLE'],
  ]);
  assert.equal(selected.rankCandidates[2].baselineRewardRiskRatio, null);
  assert.equal(selected.candidateSelectedStrategyId, 'IGNITION');
  assert.equal(selected.baselineSelectedStrategyId, 'PULLBACK');

  const abstained = f.trial[5];
  assert.equal(abstained.decisionReceipt.candidateSelectedStrategyId, null);
  assert.equal(abstained.decisionReceipt.baselineSelectedStrategyId, null);
  for (const arm of [abstained.executionReceipt.candidate, abstained.executionReceipt.baseline]) {
    assert.equal(arm.outcome.netPct, 0);
    assert.equal(arm.outcome.label, 'ABSTAINED_NO_ELIGIBLE_STRATEGY');
    assert.equal(arm.outcome.actualFillObserved, false);
    assert.equal(arm.outcome.sizeEvidence, 'NONE');
    assert.equal(arm.sourceIdentity, null);
    assert.equal(arm.path, null);
    assert.equal(arm.depthPath, null);
    assert.equal(arm.outcome.entry, null);
    assert.equal(arm.outcome.exit, null);
  }
  const replay = replayProspective(f.learning.readProspective(), { adaptiveRankingTrialValidator: f.validator });
  assert.deepEqual(replay.errors, []);
  const view = interimView(replay, f.design.candidateId);
  assert.equal(view.captured, 34);
  assert.equal(view.matured, 34, 'the abstention remains in the exact paired denominator');
  assert.equal(f.settled.terminal.maturedGroups, 30);
  assert.equal(f.settled.terminal.verdict, 'FORWARD_SUPPORTED');
  assert.ok(f.active, 'V2 evidence uses the existing promotion and activation manager');
  await f.owner.close();
});

test('V2 refuses rehashed status scores and forged abstain fills while missing outcomes remain denominator failures, not zeros', async (t) => {
  const f = await fixture(t, { trialVersion: 'V2', abstainGroups: new Set([5]) });
  const selected = clone(f.trial[0].capture);
  selected.decisionReceipt.rankCandidates[2].baselineRewardRiskRatio = 9;
  selected.decisionReceipt.decisionDigest = canonicalDigest(Object.fromEntries(
    Object.entries(selected.decisionReceipt).filter(([key]) => !['decisionId', 'decisionDigest'].includes(key)),
  ));
  selected.decisionReceipt.decisionId = `artriald2-${selected.decisionReceipt.decisionDigest.slice(0, 40)}`;
  assert.match(
    f.validator(selected, { stage: 'CAPTURE', design: f.design, capture: null }).error,
    /unavailable\/ineligible values malformed/,
  );

  const forgedAbstain = clone(f.trial[5].outcome);
  forgedAbstain.executionReceipt.candidate.outcome.netPct = 1;
  forgedAbstain.executionReceipt.candidate.path = [];
  forgedAbstain.executionReceipt.executionDigest = canonicalDigest(Object.fromEntries(
    Object.entries(forgedAbstain.executionReceipt).filter(([key]) => !['executionId', 'executionDigest'].includes(key)),
  ));
  forgedAbstain.executionReceipt.executionId = `artriale2-${forgedAbstain.executionReceipt.executionDigest.slice(0, 40)}`;
  assert.match(
    f.validator(forgedAbstain, { stage: 'OUTCOME', design: f.design, capture: f.trial[5].capture }).error,
    /exact zero with no fill/,
  );

  const omitted = new Set(f.trial.slice(0, 8).map((row) => row.outcome.opportunityId));
  const incompleteRecords = f.learning.readProspective().filter((row) => row.kind !== 'TERMINAL_EVALUATED'
    && !(row.kind === 'ADAPTIVE_RANKING_TRIAL_OUTCOME' && omitted.has(row.opportunityId)));
  const incomplete = replayProspective(incompleteRecords, { adaptiveRankingTrialValidator: f.validator });
  assert.deepEqual(incomplete.errors, []);
  const view = interimView(incomplete, f.design.candidateId);
  assert.equal(view.captured, 34);
  assert.equal(view.matured, 26);
  const terminal = evaluateTerminal(incomplete, f.design.candidateId, { nowTs: f.now.value + 1 });
  assert.equal(terminal.verdict, 'INSUFFICIENT_COMPARISON');
  assert.ok(terminal.reasons.includes('TERMINAL_SAMPLE_NOT_REACHED'));

  const duplicate = replayProspective([
    { kind: 'DESIGN_SEALED', design: f.design }, f.trial[0].capture, f.trial[0].capture,
  ], { adaptiveRankingTrialValidator: f.validator });
  assert.match(duplicate.errors[0], /duplicate capture/);
  await f.owner.close();
});

test('V2 exact same-arm control earns zero and no promotion', async (t) => {
  const f = await fixture(t, { trialVersion: 'V2', sameSelection: true });
  assert.equal(f.trial[0].decisionReceipt.candidateSelectedStrategyId, 'IGNITION');
  assert.equal(f.trial[0].decisionReceipt.baselineSelectedStrategyId, 'IGNITION');
  assert.deepEqual(f.trial[0].executionReceipt.candidate, f.trial[0].executionReceipt.baseline);
  assert.equal(f.settled.terminal.effect.pairedMeanDiff, 0);
  assert.equal(f.settled.terminal.verdict, 'FORWARD_NOT_SUPPORTED');
  assert.equal(f.settled.activation, null);
  await f.owner.close();
});

test('same-asset captures in one predeclared episode remain two records but one dependence group', async (t) => {
  const f = await fixture(t, { sameCohortPair: true });
  const replay = replayProspective(f.learning.readProspective(), { adaptiveRankingTrialValidator: f.validator });
  assert.deepEqual(replay.errors, []);
  const view = interimView(replay, f.design.candidateId);
  assert.equal(view.matured, 34);
  assert.equal(view.maturedGroups, 33, 'the nearby same-asset capture does not add independent evidence');
  assert.equal(f.settled.terminal.maturedGroups, 30, 'the terminal remains frozen to its predeclared group target');
  assert.equal(f.settled.terminal.verdict, 'FORWARD_SUPPORTED');
  await f.owner.close();
});

test('typed trial refuses shared metrics, caller-edited costs/path, lookahead, duplicate/mixed records and unqualified fallbacks', async (t) => {
  const f = await fixture(t);
  const original = f.trial[0];
  const sharedMetric = {
    kind: 'OUTCOME', candidateId: f.design.candidateId,
    opportunityId: original.capture.opportunityId, outcomeClass: 'FAVORABLE', metricValue: 99,
    outcomeKnownAtTs: original.decisionReceipt.labelEndTs,
    recordedTs: original.decisionReceipt.labelEndTs + 1,
  };
  const mixed = replayProspective([
    { kind: 'DESIGN_SEALED', design: f.design }, original.capture, sharedMetric,
  ], { adaptiveRankingTrialValidator: f.validator });
  assert.match(mixed.errors[0], /legacy outcome cannot settle an adaptive capture/);
  const edited = clone(original.outcome);
  edited.executionReceipt.candidate.outcome.netPct += 1;
  edited.executionReceipt.executionDigest = canonicalDigest(Object.fromEntries(
    Object.entries(edited.executionReceipt).filter(([key]) => !['executionId', 'executionDigest'].includes(key)),
  ));
  edited.executionReceipt.executionId = `artriale-${edited.executionReceipt.executionDigest.slice(0, 40)}`;
  const checked = f.validator(edited, { stage: 'OUTCOME', design: f.design, capture: original.capture });
  assert.match(checked.error, /deterministic replay/);
  const future = clone(original.outcome);
  future.executionReceipt.candidate.path[0].knownAtTs = future.executionReceipt.candidate.asOfTs + 1;
  assert.match(f.validator(future, { stage: 'OUTCOME', design: f.design, capture: original.capture }).error, /future evidence/);
  const partialDepth = clone(original.outcome);
  partialDepth.executionReceipt.candidate.depthPath.intended.quoteNotional = 1_000_000;
  assert.match(f.validator(partialDepth, { stage: 'OUTCOME', design: f.design, capture: original.capture }).error, /deterministic replay/);
  const swappedArms = clone(original.outcome);
  [swappedArms.executionReceipt.candidate, swappedArms.executionReceipt.baseline] = [
    swappedArms.executionReceipt.baseline, swappedArms.executionReceipt.candidate,
  ];
  swappedArms.executionReceipt.executionDigest = canonicalDigest(Object.fromEntries(
    Object.entries(swappedArms.executionReceipt).filter(([key]) => !['executionId', 'executionDigest'].includes(key)),
  ));
  swappedArms.executionReceipt.executionId = `artriale-${swappedArms.executionReceipt.executionDigest.slice(0, 40)}`;
  assert.match(
    f.validator(swappedArms, { stage: 'OUTCOME', design: f.design, capture: original.capture }).error,
    /shape or identity malformed/,
    'candidate-selected A and baseline-selected B executions cannot be swapped after the label',
  );
  const mixedSource = clone(original.outcome);
  mixedSource.executionReceipt.candidate.sourceIdentity.assetId = 'ETH';
  mixedSource.executionReceipt.executionDigest = canonicalDigest(Object.fromEntries(
    Object.entries(mixedSource.executionReceipt).filter(([key]) => !['executionId', 'executionDigest'].includes(key)),
  ));
  mixedSource.executionReceipt.executionId = `artriale-${mixedSource.executionReceipt.executionDigest.slice(0, 40)}`;
  assert.match(
    f.validator(mixedSource, { stage: 'OUTCOME', design: f.design, capture: original.capture }).error,
    /source identity differs/,
    'rehashed cross-market execution identity is refused',
  );
  const wrongArm = clone(original.capture);
  wrongArm.decisionReceipt.candidateArm.executionCapture.assetId = 'ETH';
  assert.match(f.validator(wrongArm, { stage: 'CAPTURE', design: f.design, capture: null }).error, /capture\/strategy\/market mismatch/);
  const preLabel = clone(original.outcome);
  preLabel.executionReceipt.outcomeKnownAtTs = original.decisionReceipt.labelEndTs - 1;
  assert.match(f.validator(preLabel, { stage: 'OUTCOME', design: f.design, capture: original.capture }).error, /clock/);
  const duplicate = replayProspective([
    { kind: 'DESIGN_SEALED', design: f.design }, original.capture, original.capture,
  ], { adaptiveRankingTrialValidator: f.validator });
  assert.match(duplicate.errors[0], /duplicate capture/);

  const noValidator = replayProspective([{ kind: 'DESIGN_SEALED', design: f.design }, original.capture]);
  assert.match(noValidator.errors[0], /validator absent/);
  assert.throws(() => settleCandidate({
    store: f.learning, candidateId: f.design.candidateId, nowTs: f.now.value + 1,
  }), /prospective journal invalid/);
  const missingCustody = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: null,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(missingCustody.adaptiveRankingProcedure, null);
  assert.match(missingCustody.withheld[0].reason, /CURRENT_ACK_LINEAGE_INVALID/);
  const wrongAcknowledgment = clone(f.trial.at(-1).stateSettlement);
  wrongAcknowledgment.custody.durableAcknowledgment.eventDigest = '9'.repeat(64);
  const mismatchedCustody = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: wrongAcknowledgment,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  assert.equal(mismatchedCustody.adaptiveRankingProcedure, null);
  assert.match(mismatchedCustody.withheld[0].reason, /CURRENT_ACK_LINEAGE_INVALID/);
  const currentBtcFacts = preparedFacts(f.base, f.now.value, 'BTC');
  const wrongAssetFacts = preparedFacts(f.base, f.now.value, 'ETH');
  const futureFacts = preparedFacts(f.base, f.now.value + MIN, 'BTC');
  for (const [value, expectedReason] of [
    [wrongAssetFacts, 'PREPARED_FACTS_ASSET_MISMATCH'],
    [futureFacts, 'PREPARED_FACTS_CLOCK_OR_STATE_ASOF_MISMATCH'],
  ]) {
    const result = resolveQualifiedAdaptiveProcedureRanking({
      snapshot: readQualifiedAdaptiveProcedureDecision({
        qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
        currentConsumerContract: f.consumer, currentStateSettlement: f.trial.at(-1).stateSettlement,
        validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
        nowTs: f.now.value, mode: 'PAPER',
      }),
      consumerContract: f.consumer, preparedFacts: value,
      validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
      context: { ...original.context, asset: 'BTC' }, strategyId: 'IGNITION',
      baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: f.now.value,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, expectedReason);
  }
  const wrongVenue = resolveQualifiedAdaptiveProcedureRanking({
    snapshot: readQualifiedAdaptiveProcedureDecision({
      qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
      currentConsumerContract: f.consumer, currentStateSettlement: f.trial.at(-1).stateSettlement,
      validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
      nowTs: f.now.value, mode: 'PAPER',
    }),
    consumerContract: f.consumer, preparedFacts: currentBtcFacts,
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    context: { ...original.context, asset: 'BTC', venue: 'COINBASE' }, strategyId: 'IGNITION',
    baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: f.now.value,
  });
  assert.equal(wrongVenue.applied, false);
  assert.equal(wrongVenue.reason, 'PREPARED_FACTS_VENUE_NOT_SINGLE_QUALIFIED_SOURCE');
  const cachedSnapshot = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: f.trial.at(-1).stateSettlement,
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    nowTs: f.now.value, mode: 'PAPER',
  });
  const laterDecisionTs = f.now.value + 30_000;
  const laterFreshFacts = preparedFacts(f.base, laterDecisionTs, 'BTC');
  const cachedForLaterDecision = resolveQualifiedAdaptiveProcedureRanking({
    snapshot: cachedSnapshot, consumerContract: f.consumer, preparedFacts: laterFreshFacts,
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    context: { ...original.context, asset: 'BTC' }, strategyId: 'IGNITION',
    baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: laterDecisionTs,
  });
  assert.equal(cachedForLaterDecision.applied, true, 'a fresh later decision may consume a still-fresh cached state snapshot whose state/ACK existed first');
  const freshnessNow = f.now.value + 2 * MIN;
  const freshnessSnapshot = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer, currentStateSettlement: f.trial.at(-1).stateSettlement,
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    nowTs: freshnessNow, mode: 'PAPER',
  });
  const resolveAtFreshnessTime = (value) => resolveQualifiedAdaptiveProcedureRanking({
    snapshot: freshnessSnapshot, consumerContract: f.consumer, preparedFacts: value,
    validatePreparedFacts: (facts, contract) => judgeLearningPreparedFactsError(facts, { consumerContract: contract }),
    context: { ...original.context, asset: 'BTC' }, strategyId: 'IGNITION',
    baselineRewardRiskRatio: 1, mode: 'PAPER', nowTs: freshnessNow,
  });
  const internallyFreshButNowOld = resolveAtFreshnessTime(preparedFacts(f.base, f.now.value, 'BTC'));
  assert.equal(internallyFreshButNowOld.applied, false);
  assert.equal(internallyFreshButNowOld.reason, 'PREPARED_FACTS_STALE_AT_CONSUMPTION');
  assert.equal(resolveAtFreshnessTime(preparedFacts(f.base, freshnessNow, 'BTC')).applied, true);
  assert.equal(currentBtcFacts.decisionTs, f.now.value);
  const observe = resolveQualifiedAdaptiveProcedureRanking({
    snapshot: missingCustody, consumerContract: f.consumer, preparedFacts: original.facts,
    validatePreparedFacts: () => null, context: original.context,
    strategyId: 'IGNITION', baselineRewardRiskRatio: 1, mode: 'OBSERVE', nowTs: f.now.value,
  });
  assert.equal(observe.applied, false); assert.equal(observe.effectiveRewardRiskRatio, 1);
  const rolledBack = transitionActivation(f.active, {
    state: 'ROLLED_BACK', transitionReason: 'ADVERSE_PAPER_EVIDENCE', ts: f.now.value + 1,
  });
  f.learning.appendActivation(rolledBack);
  const revoked = readQualifiedAdaptiveProcedureDecision({
    qualificationStore: f.learning, adaptiveStore: f.durable, publications: [f.publication],
    currentConsumerContract: f.consumer,
    currentStateSettlement: f.trial.at(-1).stateSettlement,
    validatePreparedFacts: (value, contract) => judgeLearningPreparedFactsError(value, { consumerContract: contract }),
    nowTs: rolledBack.ts + 1, mode: 'PAPER',
  });
  assert.equal(revoked.adaptiveRankingProcedure, null, 'rollback revokes the evolving procedure immediately');
  assert.equal(revoked.withheld[0].reason, 'EXACT_ACTIVE_QUALIFICATION_MISSING');
  await f.owner.close();
});

test('promotion defaults preserve the existing design identity and arbitrary metric/comparator pairs are closed', () => {
  const store = { appendProspective() {}, appendPattern() {} };
  const observations = [{
    opportunityId: 'lop-default-design', canonicalCoin: 'BTC', decisionTs: T0,
    evidenceBasis: 'HISTORICAL_RECONSTRUCTION', outcomeClass: 'FAVORABLE',
  }];
  const evidence = buildEvidence(observations);
  const pattern = {
    patternId: 'lpat-fixture', state: 'ACCUMULATING', predicate: { clauses: [{ feature: 'x', op: 'GT', threshold: 0 }] },
    scope: { setupType: 'ANY', regime: 'ANY' }, evidence, createdTs: T0,
    seq: 1, origin: 'TEST', estimate: estimateFromEvidence(observations, evidence, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 }), contradictions: [],
  };
  const consumerBinding = { featureRecipeVersion: 'recipe-1', policyDigest: POLICY };
  assert.throws(() => freezeCandidate({
    store, pattern, costModel: {}, consumerBinding, primaryMetric: 'CALLER_DEFINED',
    comparator: 'CALLER_DEFINED', nowTs: T0,
  }), /unsupported primary metric\/comparator pair/);
  const a = freezeCandidate({ store, pattern, costModel: {}, consumerBinding, nowTs: T0 });
  const b = freezeCandidate({
    store, pattern, costModel: {}, consumerBinding,
    primaryMetric: 'NET_LOG_RETURN_60M_PCT', comparator: 'BASELINE_RULE_SAME_STREAM', nowTs: T0,
  });
  assert.equal(a.candidateId, b.candidateId);
  assert.equal(ADAPTIVE_PROCEDURE_TRIAL_DECISION_VERSION, 'adaptive-ranking-trial-decision-1');
});
