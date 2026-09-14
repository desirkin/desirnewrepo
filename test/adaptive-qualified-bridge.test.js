import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest, canonicalJson, opportunityIdOf } from '../learning/contracts.js';
import {
  adaptiveRankingPublicationError,
  readQualifiedAdaptiveDecision,
  resolveQualifiedAdaptiveRanking,
  sealAdaptiveRankingPublication,
} from '../learning/adaptive-qualified-bridge.js';
import { createAdaptiveProspectiveOwner } from '../learning/adaptive-prospective-owner.js';
import {
  ADAPTIVE_DURABLE_ACK_VERSION,
  ADAPTIVE_DURABLE_STREAM_VERSION,
  openDurableAdaptiveStore,
} from '../learning/adaptive-durable-store.js';
import {
  ADAPTIVE_HORIZON_MS,
  initialAdaptiveState,
  sealAdaptiveProcedure,
} from '../learning/adaptive-registry.js';
import {
  ADAPTIVE_JOURNAL_EVENT_VERSION,
  ADAPTIVE_STORE_VERSION,
  createAdaptiveStore,
  validateAdaptiveStoreSnapshot,
} from '../learning/adaptive-store.js';
import { adaptiveSettlementSubmission } from './helpers/adaptive-outcome-fixture.js';
import {
  buildJudgeLearningConsumerContract,
  buildJudgeLearningPreparedFacts,
  judgeLearningPreparedFactsError,
} from '../judge/learning-recipe.js';
import { digestOf } from '../execution/contract.js';
import { buildEvidence, buildPatternRecord, estimateFromEvidence } from '../learning/patterns.js';
import { freezeCandidate, settleCandidate } from '../learning/promotion.js';
import { transitionActivation } from '../learning/adapter.js';
import { createLearningStore } from '../learning/store.js';

const T0 = Date.UTC(2026, 8, 13, 15);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const POLICY_DIGEST = 'a'.repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));

function tempRoot(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function contract(effectMagnitude = 0.015) {
  return buildJudgeLearningConsumerContract({
    policyDigest: POLICY_DIGEST,
    eligibility: {
      maxSpreadBps: 20,
      minBidDepthUsd10bps: null,
      minAtrPct: null,
      maxAtrPct: null,
      maxFactAgeMs: 60_000,
      requiredFeatures: ['spreadBps'],
    },
    effectMagnitude,
    activationLifetimeMs: 30 * DAY,
    degradeRule: { minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 },
  });
}

function procedure(consumer) {
  return sealAdaptiveProcedure({
    parentPolicyDigest: consumer.policyDigest,
    consumerContractDigest: consumer.consumerContractDigest,
    featureRecipeDigest: consumer.featureRecipeDigest,
    strategyIds: ['IGNITION', 'PULLBACK'],
    createdTs: T0,
  });
}

function predictionInput(p) {
  const decisionTs = T0 + 10_000;
  const identity = {
    canonicalCoin: 'BTC', decisionTs,
    captureRecipeVersion: 'adaptive-qualified-e2e-1',
    datasetId: 'adaptive-qualified-e2e',
  };
  return {
    opportunityId: opportunityIdOf(identity), identity,
    catalogContentId: 'catalog-adaptive-qualified-e2e',
    predictionTs: decisionTs, horizonMs: ADAPTIVE_HORIZON_MS,
    featureRecipeDigest: p.parent.featureRecipeDigest,
    factsDigest: 'e'.repeat(64),
    strategyAssessments: p.strategies.map((strategyId) => ({
      strategyId, eligibility: 'ELIGIBLE', reasonCode: null,
    })),
    selection: { strategyId: 'IGNITION', reasonCode: 'BASELINE_SELECTED' },
  };
}

function initialStream(t, p) {
  const root = tempRoot(t, 'adaptive-qualified-origin-');
  const local = createAdaptiveStore({ rootDir: root, procedure: p, clock: () => T0 });
  local.close();
  const journalText = readFileSync(path.join(root, 'journal.jsonl'), 'utf8');
  const acknowledgedHead = JSON.parse(readFileSync(path.join(root, 'head.json'), 'utf8'));
  const snapshot = validateAdaptiveStoreSnapshot({ journalText, acknowledgedHead, procedure: p });
  return {
    outcome: 'LOADED', streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
    storeVersion: ADAPTIVE_STORE_VERSION, eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
    procedureId: p.procedureId, procedureDigest: p.procedureDigest,
    revision: snapshot.eventCount, journalText, acknowledgedHead,
    acknowledgments: snapshot.events.map((event, sequence) => ({
      ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      sequence, eventDigest: event.eventDigest,
      headDigest: snapshot.eventHeadDigests[sequence],
      acknowledgedTs: event.recordedTs,
    })),
  };
}

class MemoryPort {
  constructor(stream, clock) { this.stream = clone(stream); this.clock = clock; this.appendCalls = 0; }
  async load() { return clone(this.stream); }
  async append(request) {
    this.appendCalls += 1;
    assert.equal(request.expectedRevision, this.stream.revision);
    assert.equal(request.expectedHeadDigest, this.stream.acknowledgedHead.headDigest);
    const acknowledgedTs = this.clock();
    this.stream.journalText += `${canonicalJson(request.event)}\n`;
    this.stream.acknowledgedHead = clone(request.nextAcknowledgedHead);
    this.stream.revision += 1;
    this.stream.acknowledgments.push({
      ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      sequence: request.event.sequence,
      eventDigest: request.event.eventDigest,
      headDigest: request.nextAcknowledgedHead.headDigest,
      acknowledgedTs,
    });
    return {
      outcome: 'APPENDED', ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
      storeVersion: ADAPTIVE_STORE_VERSION,
      eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
      procedureId: request.identity.procedureId,
      procedureDigest: request.identity.procedureDigest,
      revision: this.stream.revision,
      eventDigest: request.event.eventDigest,
      headDigest: request.nextAcknowledgedHead.headDigest,
      acknowledgedTs,
    };
  }
}

async function learnedState(t, p) {
  const now = { value: T0 + 10_100 };
  const rootDir = tempRoot(t, 'adaptive-qualified-state-');
  const port = new MemoryPort(initialStream(t, p), () => now.value);
  let durable = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: port,
    clock: () => now.value, portTimeoutMs: 1_000,
  });
  let owner = createAdaptiveProspectiveOwner({ store: durable, procedure: p, clock: () => now.value });
  const prediction = (await owner.recordPrediction(predictionInput(p))).prediction;
  now.value = prediction.targetEndTs + 1_000;
  const submission = adaptiveSettlementSubmission(p, prediction, {
    opportunityId: prediction.opportunityId,
    horizonMs: prediction.horizonMs,
    state: 'MATURED', logReturnPct: 1,
    sourceEventTs: prediction.targetEndTs,
    knownAtTs: now.value, sourceDigest: 'f'.repeat(64), reasonCode: null,
  });
  const updated = await owner.recordOutcome(submission);
  assert.equal(updated.status, 'UPDATED');
  const appendCalls = port.appendCalls;
  assert.equal((await owner.recordOutcome(submission)).status, 'EXISTING');
  assert.equal(port.appendCalls, appendCalls, 'duplicate settlement cannot learn twice');
  await owner.close();

  now.value += 1;
  durable = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: port,
    clock: () => now.value, portTimeoutMs: 1_000,
  });
  owner = createAdaptiveProspectiveOwner({ store: durable, procedure: p, clock: () => now.value });
  assert.equal(owner.state().sequence, 1, 'ACKed state survives restart exactly once');
  return {
    owner, durable, port, now,
    prediction,
    state: owner.state(),
    settlement: durable.settlement({ opportunityId: prediction.opportunityId, horizonMs: prediction.horizonMs }),
  };
}

function appendAccumulatingPattern(store, publication, atTs) {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    opportunityId: `lop-qualified-history-${index}`,
    canonicalCoin: `A${index % 5}A`,
    decisionTs: atTs - 20 * DAY + index * DAY,
    evidenceBasis: 'HISTORICAL_RECONSTRUCTION',
    outcomeClass: index % 4 === 3 ? 'ADVERSE' : 'FAVORABLE',
  }));
  const baseEvidence = buildEvidence(rows);
  const evidence = {
    ...baseEvidence,
    evidenceRefs: [publication.publicationId],
    evidenceRefsTruncated: false,
  };
  const estimate = estimateFromEvidence(rows, evidence, {
    pooledMean: 0.5, priorStrength: 8, updatedTs: atTs - DAY,
  });
  const predicate = publication.applicability;
  const scope = publication.scope;
  store.appendPattern(buildPatternRecord({
    predicate, scope, origin: 'ADAPTIVE_STATE_PROPOSAL',
    createdTs: atTs - 20 * DAY, ts: atTs - 20 * DAY, seq: 0,
    state: 'NOTICED', previousState: null,
    transitionReason: 'FIRST_OBSERVATION', evidence,
    estimate, contradictions: [],
  }));
  const first = store.patternHeads().values().next().value;
  store.appendPattern(buildPatternRecord({
    predicate, scope, origin: first.origin, createdTs: first.createdTs,
    ts: atTs - 10 * DAY, seq: 1, state: 'ACCUMULATING',
    previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE',
    evidence, estimate, contradictions: [],
  }));
  return store.patternHeads().values().next().value;
}

function appendForwardEvidence(store, design) {
  for (let group = 0; group < 34; group += 1) {
    const decisionTs = design.sealedTs + HOUR + (group % 8) * DAY + Math.floor(group / 8) * 5 * HOUR;
    const opportunityId = `lop-adaptive-forward-${group}`;
    const labelEndTs = decisionTs + HOUR;
    store.appendProspective({
      kind: 'CAPTURE', candidateId: design.candidateId, opportunityId,
      canonicalCoin: `A${group % 6}A`, decisionTs,
      candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED',
      recordedTs: decisionTs + 1_000, labelEndTs,
    });
    store.appendProspective({
      kind: 'OUTCOME', candidateId: design.candidateId, opportunityId,
      outcomeClass: 'FAVORABLE', metricValue: 1.5,
      outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1_000,
    });
  }
}

function activateQualifiedCandidate(store, publication) {
  const pattern = appendAccumulatingPattern(store, publication, publication.sealedTs + 2);
  const design = freezeCandidate({
    store, pattern,
    costModel: { feePctPerSide: 0.8, slippageBps: 10 },
    consumerBinding: {
      featureRecipeVersion: publication.consumerContract.featureRecipe.featureRecipeVersion,
      policyDigest: publication.consumerContract.policyDigest,
    },
    nowTs: publication.sealedTs + 3,
  });
  assert.equal(design.evidenceDigest, publication.publicationId, 'typed publication is sealed before any forward capture');
  appendForwardEvidence(store, design);
  const settledTs = design.sealedTs + 40 * DAY;
  const result = settleCandidate({
    store, candidateId: design.candidateId,
    nowTs: settledTs, maxAbsAdjust: 0.015,
  });
  assert.equal(result.terminal.verdict, 'FORWARD_SUPPORTED');
  assert.equal(result.activation.state, 'PUBLISHED_WAITING_FOR_PAPER');
  const active = transitionActivation(result.activation, {
    state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: settledTs + 1,
  });
  store.appendActivation(active);
  const validated = store.patternHeads().get(pattern.patternId);
  store.appendPattern(buildPatternRecord({
    predicate: validated.predicate, scope: validated.scope,
    origin: validated.origin, createdTs: validated.createdTs,
    ts: settledTs + 1, seq: validated.seq + 1,
    state: 'ACTIVE_PAPER', previousState: validated.state,
    transitionReason: 'PAPER_RUNTIME_ADOPTED', evidence: validated.evidence,
    estimate: validated.estimate, contradictions: validated.contradictions,
    candidateId: validated.candidateId, activationId: active.activationId,
  }));
  return { design, active, nowTs: settledTs + 2 };
}

function bookAt(receiptTs) {
  const snapshot = {
    snapshotVersion: 'execution-book-snapshot-1', symbol: 'XBT/USD', canonicalCoin: 'BTC',
    feedEpoch: 7, receiptSequence: 99, nativeSequence: null,
    sourceTs: receiptTs, receiptTs, crc: 1, crcVerified: true, crcComputed: 1,
    synced: true, instrumentDigest: 'c'.repeat(64), priceDecimals: 2, qtyDecimals: 8,
    bids: [['99.95', '250']], asks: [['100.05', '250']], levelsCap: 100,
    truncated: false, kind: 'UPDATE', digest: 'x'.repeat(64),
  };
  snapshot.digest = digestOf({ ...snapshot, digest: null });
  return snapshot;
}

test('ACKed adaptive state changes one PAPER rank only after its exact typed proposal passes the existing prospective promoter', async (t) => {
  const consumer = contract(); const p = procedure(consumer);
  const adaptive = await learnedState(t, p);
  const predicate = { clauses: [{ feature: 'spreadBps', op: 'LTE', threshold: 20 }] };
  const scope = { setupType: 'IGNITION', regime: 'UNCLASSIFIED', assets: ['BTC'], venues: ['KRAKEN'] };
  const publication = sealAdaptiveRankingPublication({
    procedure: p, state: adaptive.state, settlement: adaptive.settlement,
    strategyId: 'IGNITION', consumerContract: consumer, scope, applicability: predicate,
  });
  assert.equal(publication.strategy.rankOffsetRrPoints, 0.015);
  assert.equal(publication.stateSource.durableAcknowledgment.eventDigest, publication.stateSource.eventDigest);
  assert.equal(adaptiveRankingPublicationError(publication, {
    procedure: p, state: adaptive.owner.state(), settlement: adaptive.durable.settlement({
      opportunityId: adaptive.prediction.opportunityId, horizonMs: adaptive.prediction.horizonMs,
    }), currentConsumerContract: consumer,
  }), null);

  const learningDir = tempRoot(t, 'adaptive-qualified-promotion-');
  const qualificationStore = createLearningStore({ dataDir: learningDir });
  const pattern = appendAccumulatingPattern(qualificationStore, publication, publication.sealedTs + 2);
  const design = freezeCandidate({
    store: qualificationStore, pattern,
    costModel: { feePctPerSide: 0.8, slippageBps: 10 },
    consumerBinding: {
      featureRecipeVersion: consumer.featureRecipe.featureRecipeVersion,
      policyDigest: consumer.policyDigest,
    }, nowTs: publication.sealedTs + 3,
  });
  appendForwardEvidence(qualificationStore, design);
  const settled = settleCandidate({
    store: qualificationStore, candidateId: design.candidateId,
    nowTs: design.sealedTs + 40 * DAY, maxAbsAdjust: 0.015,
  });
  const beforeAdoption = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: adaptive.durable, publications: [publication],
    currentConsumerContract: consumer, nowTs: design.sealedTs + 40 * DAY,
    mode: 'PAPER',
  });
  assert.equal(beforeAdoption.adaptiveRanking.publications.length, 0, 'published-waiting is not approval');

  const active = transitionActivation(settled.activation, {
    state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED',
    ts: design.sealedTs + 40 * DAY + 1,
  });
  qualificationStore.appendActivation(active);
  const validated = qualificationStore.patternHeads().get(pattern.patternId);
  qualificationStore.appendPattern(buildPatternRecord({
    predicate: validated.predicate, scope: validated.scope,
    origin: validated.origin, createdTs: validated.createdTs,
    ts: active.ts, seq: validated.seq + 1,
    state: 'ACTIVE_PAPER', previousState: validated.state,
    transitionReason: 'PAPER_RUNTIME_ADOPTED', evidence: validated.evidence,
    estimate: validated.estimate, contradictions: validated.contradictions,
    candidateId: validated.candidateId, activationId: active.activationId,
  }));
  const nowTs = active.ts + 1;
  const snapshot = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: adaptive.durable, publications: [publication],
    currentConsumerContract: consumer, nowTs, mode: 'PAPER',
  });
  assert.equal(snapshot.view, 'DECISION', 'existing decision-memory accessor shape is preserved');
  assert.equal(snapshot.adaptiveRanking.publications.length, 1);
  assert.equal(snapshot.adaptiveRanking.legacyActivationEffectReinterpreted, false);
  assert.equal(snapshot.adaptiveRanking.publications[0].effect.units, 'REWARD_RISK_RATIO_POINTS');
  assert.equal(snapshot.adaptiveRanking.publications[0].qualificationVersion, 'adaptive-ranking-qualification-1');

  const decisionTs = nowTs;
  const facts = buildJudgeLearningPreparedFacts({
    frozen: null, decisionTs, bookSnapshot: bookAt(decisionTs - 250),
    barEvidence: null, tradeEvidence: null,
  });
  const validate = (prepared, exactConsumer) => judgeLearningPreparedFactsError(prepared, { consumerContract: exactConsumer });
  assert.equal(validate(facts, consumer), null);
  const baselineIgnition = 1;
  const baselinePullback = 1.01;
  const resolution = resolveQualifiedAdaptiveRanking({
    snapshot, consumerContract: consumer, preparedFacts: facts,
    validatePreparedFacts: validate,
    context: { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: 'BTC', venue: 'KRAKEN' },
    strategyId: 'IGNITION', baselineRewardRiskRatio: baselineIgnition,
    mode: 'PAPER', nowTs,
  });
  assert.equal(resolution.applied, true);
  assert.equal(resolution.effectiveRewardRiskRatio, 1.015);
  assert.ok(resolution.effectiveRewardRiskRatio > baselinePullback, 'the qualified exact effect can change the later rank decision');
  assert.equal(resolveQualifiedAdaptiveRanking({
    snapshot, consumerContract: consumer, preparedFacts: facts,
    validatePreparedFacts: validate,
    context: { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: 'BTC', venue: 'KRAKEN' },
    strategyId: 'IGNITION', baselineRewardRiskRatio: baselineIgnition,
    mode: 'OBSERVE', nowTs,
  }).applied, false);

  await adaptive.owner.close();
});

test('missing typed binding, stale parent, changed envelope, missing custody, revocation and invalid facts all preserve baseline', async (t) => {
  const consumer = contract(); const p = procedure(consumer);
  const adaptive = await learnedState(t, p);
  const predicate = { clauses: [{ feature: 'spreadBps', op: 'LTE', threshold: 20 }] };
  const publication = sealAdaptiveRankingPublication({
    procedure: p, state: adaptive.state, settlement: adaptive.settlement,
    strategyId: 'IGNITION', consumerContract: consumer,
    scope: { setupType: 'IGNITION', regime: 'UNCLASSIFIED', assets: ['BTC'], venues: ['KRAKEN'] },
    applicability: predicate,
  });
  const learningDir = tempRoot(t, 'adaptive-qualified-failclosed-');
  const qualificationStore = createLearningStore({ dataDir: learningDir });
  const active = activateQualifiedCandidate(qualificationStore, publication);
  const good = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: adaptive.durable, publications: [publication],
    currentConsumerContract: consumer, nowTs: active.nowTs, mode: 'PAPER',
  });
  assert.equal(good.adaptiveRanking.publications.length, 1);

  const noTypedBinding = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: adaptive.durable, publications: [],
    currentConsumerContract: consumer, nowTs: active.nowTs, mode: 'PAPER',
  });
  assert.equal(noTypedBinding.adaptiveRanking.publications.length, 0);

  const changedConsumer = contract(0.02);
  const changedEnvelope = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: adaptive.durable, publications: [publication],
    currentConsumerContract: changedConsumer, nowTs: active.nowTs, mode: 'PAPER',
  });
  assert.equal(changedEnvelope.adaptiveRanking.publications.length, 0);
  assert.match(changedEnvelope.adaptiveRanking.withheld[0].reason, /PUBLICATION_INVALID/);

  const staleStore = {
    ...adaptive.durable,
    procedure: () => p,
    state: () => initialAdaptiveState(p),
    status: () => adaptive.durable.status(),
    settlement: (query) => adaptive.durable.settlement(query),
  };
  const stale = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: staleStore, publications: [publication],
    currentConsumerContract: consumer, nowTs: active.nowTs, mode: 'PAPER',
  });
  assert.equal(stale.adaptiveRanking.publications.length, 0);
  assert.match(stale.adaptiveRanking.withheld[0].reason, /not current/);

  const custodyMissing = {
    ...adaptive.durable,
    procedure: () => p,
    state: () => adaptive.state,
    status: () => adaptive.durable.status(),
    settlement: () => null,
  };
  const noCustody = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: custodyMissing, publications: [publication],
    currentConsumerContract: consumer, nowTs: active.nowTs, mode: 'PAPER',
  });
  assert.equal(noCustody.adaptiveRanking.publications.length, 0);
  assert.match(noCustody.adaptiveRanking.withheld[0].reason, /settlement absent/);

  const decisionTs = active.nowTs;
  const facts = buildJudgeLearningPreparedFacts({
    frozen: null, decisionTs, bookSnapshot: bookAt(decisionTs - 250),
    barEvidence: null, tradeEvidence: null,
  });
  const invalidFacts = clone(facts);
  invalidFacts.features.spreadBps.value = 999;
  const denied = resolveQualifiedAdaptiveRanking({
    snapshot: good, consumerContract: consumer, preparedFacts: invalidFacts,
    validatePreparedFacts: (prepared, exactConsumer) => judgeLearningPreparedFactsError(prepared, { consumerContract: exactConsumer }),
    context: { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: 'BTC', venue: 'KRAKEN' },
    strategyId: 'IGNITION', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: active.nowTs,
  });
  assert.equal(denied.applied, false);
  assert.equal(denied.effectiveRewardRiskRatio, 1);
  assert.equal(denied.reason, 'PREPARED_FACTS_INVALID');

  const staleSnapshot = resolveQualifiedAdaptiveRanking({
    snapshot: good, consumerContract: consumer, preparedFacts: facts,
    validatePreparedFacts: (prepared, exactConsumer) => judgeLearningPreparedFactsError(prepared, { consumerContract: exactConsumer }),
    context: { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: 'BTC', venue: 'KRAKEN' },
    strategyId: 'IGNITION', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: good.preparedTs + 15 * 60_000 + 1,
  });
  assert.equal(staleSnapshot.applied, false);
  assert.equal(staleSnapshot.reason, 'SNAPSHOT_STALE');

  const forgedSnapshot = clone(good);
  const forgedQualification = forgedSnapshot.adaptiveRanking.publications[0];
  forgedQualification.effect.magnitude = 0.1;
  const qualificationBody = { ...forgedQualification };
  delete qualificationBody.qualificationId;
  delete qualificationBody.qualificationDigest;
  forgedQualification.qualificationDigest = canonicalDigest(qualificationBody);
  forgedQualification.qualificationId = `arqual-${forgedQualification.qualificationDigest.slice(0, 40)}`;
  const forged = resolveQualifiedAdaptiveRanking({
    snapshot: forgedSnapshot, consumerContract: consumer, preparedFacts: facts,
    validatePreparedFacts: (prepared, exactConsumer) => judgeLearningPreparedFactsError(prepared, { consumerContract: exactConsumer }),
    context: { setupType: 'IGNITION', regime: 'UNCLASSIFIED', asset: 'BTC', venue: 'KRAKEN' },
    strategyId: 'IGNITION', baselineRewardRiskRatio: 1,
    mode: 'PAPER', nowTs: active.nowTs,
  });
  assert.equal(forged.applied, false, 'self-rehashing a typed qualification cannot widen its sealed consumer effect');
  assert.equal(forged.reason, 'QUALIFICATION_INVALID');

  const suspended = transitionActivation(active.active, {
    state: 'SUSPENDED', transitionReason: 'OPERATOR_SUSPENDED', ts: active.nowTs + 1,
  });
  qualificationStore.appendActivation(suspended);
  const revoked = readQualifiedAdaptiveDecision({
    qualificationStore, adaptiveStore: adaptive.durable, publications: [publication],
    currentConsumerContract: consumer, nowTs: active.nowTs + 2, mode: 'PAPER',
  });
  assert.equal(revoked.adaptiveRanking.publications.length, 0);
  assert.equal(revoked.adaptiveRanking.withheld[0].reason, 'EXACT_ACTIVE_QUALIFICATION_MISSING');

  await adaptive.owner.close();
});
