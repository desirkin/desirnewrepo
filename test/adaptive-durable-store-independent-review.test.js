import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAdaptiveCore } from '../learning/adaptive-core.js';
import { canonicalJson, opportunityIdOf } from '../learning/contracts.js';
import {
  ADAPTIVE_DURABLE_ACK_VERSION,
  ADAPTIVE_DURABLE_STREAM_VERSION,
  AdaptiveDurableStoreError,
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

const T0 = Date.UTC(2026, 8, 13, 15);
const hex = (char) => char.repeat(64);
const copy = (value) => JSON.parse(JSON.stringify(value));

function procedure() {
  return sealAdaptiveProcedure({
    parentPolicyDigest: hex('a'),
    consumerContractDigest: hex('b'),
    featureRecipeDigest: hex('c'),
    strategyIds: ['IGNITION', 'PULLBACK'],
    createdTs: T0,
  });
}

function tempRoot(t, prefix = 'adaptive-durable-independent-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function predictionInput(p) {
  const decisionTs = T0 + 10_000;
  const identity = {
    canonicalCoin: 'BTC', decisionTs,
    captureRecipeVersion: 'durable-independent-capture-1',
    datasetId: 'durable-independent',
  };
  return {
    opportunityId: opportunityIdOf(identity), identity,
    catalogContentId: 'catalog-durable-independent',
    predictionTs: decisionTs, horizonMs: ADAPTIVE_HORIZON_MS,
    featureRecipeDigest: p.parent.featureRecipeDigest,
    factsDigest: hex('e'),
    strategyAssessments: p.strategies.map((strategyId) => ({
      strategyId, eligibility: 'ELIGIBLE', reasonCode: null,
    })),
    selection: { strategyId: 'IGNITION', reasonCode: 'BASELINE_SELECTED' },
  };
}

function streamFromLocal(t, p, predictions = []) {
  const root = tempRoot(t, 'adaptive-durable-stream-');
  const local = createAdaptiveStore({ rootDir: root, procedure: p, clock: () => T0 });
  for (const prediction of predictions) local.appendPrediction(prediction);
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

function settlementFixture(t, p) {
  const root = tempRoot(t, 'adaptive-durable-settlement-');
  let now = T0 + 10_100;
  const local = createAdaptiveStore({ rootDir: root, procedure: p, clock: () => now });
  const core = createAdaptiveCore({ store: local, procedure: p, clock: () => now });
  const prediction = core.recordPrediction(predictionInput(p)).prediction;
  now = prediction.targetEndTs + 1_000;
  const submission = adaptiveSettlementSubmission(p, prediction, {
    opportunityId: prediction.opportunityId,
    horizonMs: prediction.horizonMs,
    state: 'MATURED', logReturnPct: 1,
    sourceEventTs: prediction.targetEndTs,
    knownAtTs: now, sourceDigest: hex('f'), reasonCode: null,
  });
  const result = core.recordOutcome(submission);
  const settlement = local.settlement({
    opportunityId: prediction.opportunityId,
    horizonMs: prediction.horizonMs,
  });
  local.close();
  return {
    prediction,
    appendInput: {
      outcome: settlement.outcome,
      provenanceReceipt: settlement.provenanceReceipt,
      scores: settlement.scores,
      update: settlement.update,
      nextState: result.state,
    },
    nextState: result.state,
    now,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class MemoryPort {
  constructor(stream, clock) {
    this.stream = copy(stream);
    this.clock = clock;
    this.appendCalls = [];
    this.started = deferred();
    this.hold = null;
    this.alterReturnedAck = null;
  }

  async load() { return copy(this.stream); }

  holdNext() { this.hold = deferred(); return this.hold; }

  async append(request) {
    this.appendCalls.push(copy(request));
    this.started.resolve();
    const hold = this.hold; this.hold = null;
    if (hold) await hold.promise;
    const acknowledgedTs = this.clock();
    this.stream.journalText += `${canonicalJson(request.event)}\n`;
    this.stream.acknowledgedHead = copy(request.nextAcknowledgedHead);
    this.stream.revision += 1;
    const eventAck = {
      ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      sequence: request.event.sequence,
      eventDigest: request.event.eventDigest,
      headDigest: request.nextAcknowledgedHead.headDigest,
      acknowledgedTs,
    };
    this.stream.acknowledgments.push(eventAck);
    const ack = {
      outcome: 'APPENDED', ackVersion: eventAck.ackVersion,
      streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
      storeVersion: ADAPTIVE_STORE_VERSION,
      eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
      procedureId: request.identity.procedureId,
      procedureDigest: request.identity.procedureDigest,
      revision: this.stream.revision,
      eventDigest: eventAck.eventDigest,
      headDigest: eventAck.headDigest,
      acknowledgedTs: eventAck.acknowledgedTs,
    };
    return this.alterReturnedAck ? this.alterReturnedAck(copy(ack)) : ack;
  }
}

function query(prediction) {
  return { opportunityId: prediction.opportunityId, horizonMs: prediction.horizonMs };
}

test('reader exposes immutable values reconstructed from the loaded acknowledged stream and fences after close', async (t) => {
  const p = procedure();
  const fixture = settlementFixture(t, p);
  const stream = streamFromLocal(t, p, [fixture.prediction]);
  const port = new MemoryPort(stream, () => fixture.now);
  const store = await openDurableAdaptiveStore({
    rootDir: tempRoot(t), procedure: p, durablePort: port,
    clock: () => fixture.now, portTimeoutMs: 1_000,
  });

  assert.deepEqual(store.procedure(), p);
  assert.deepEqual(store.state(), initialAdaptiveState(p));
  assert.deepEqual(store.prediction(query(fixture.prediction)), fixture.prediction);
  assert.equal(store.outcome(query(fixture.prediction)), null);
  assert.equal(store.settlement(query(fixture.prediction)), null);
  const read = store.prediction(query(fixture.prediction));
  assert.throws(() => { read.selection.reasonCode = 'MUTATED'; }, TypeError);
  assert.equal(store.prediction(query(fixture.prediction)).selection.reasonCode, 'BASELINE_SELECTED');

  await store.close();
  for (const operation of [
    () => store.procedure(), () => store.state(),
    () => store.prediction(query(fixture.prediction)),
    () => store.outcome(query(fixture.prediction)),
    () => store.settlement(query(fixture.prediction)),
  ]) assert.throws(operation, /ADAPTER_CLOSED/);
});

test('held durable ACK cannot leak an updated state or settlement and exact ACK advances all readers atomically', async (t) => {
  const p = procedure(); const fixture = settlementFixture(t, p);
  const port = new MemoryPort(streamFromLocal(t, p, [fixture.prediction]), () => fixture.now);
  const rootDir = tempRoot(t);
  let store = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: port,
    clock: () => fixture.now, portTimeoutMs: 1_000,
  });
  const hold = port.holdNext();
  const requested = copy(fixture.appendInput);
  const append = store.appendOutcomeUpdate(requested);
  requested.nextState.sequence = 999;
  await port.started.promise;

  assert.deepEqual(store.state(), initialAdaptiveState(p));
  assert.equal(store.outcome(query(fixture.prediction)), null);
  assert.equal(store.settlement(query(fixture.prediction)), null);
  assert.equal(store.pending().count, 1);
  hold.resolve();
  const result = await append;
  assert.equal(result.durable, true);
  assert.deepEqual(store.state(), fixture.nextState);
  assert.deepEqual(store.outcome(query(fixture.prediction)), fixture.appendInput.outcome);
  const settlement = store.settlement(query(fixture.prediction));
  assert.deepEqual(settlement.outcome, fixture.appendInput.outcome);
  assert.deepEqual(settlement.provenanceReceipt, fixture.appendInput.provenanceReceipt);
  assert.deepEqual(settlement.scores, fixture.appendInput.scores);
  assert.deepEqual(settlement.update, fixture.appendInput.update);
  assert.equal(settlement.custody.durableAcknowledgment.eventDigest, settlement.eventDigest);
  assert.equal(settlement.custody.acknowledgedHead.stateDigest, fixture.nextState.stateDigest);
  assert.equal(settlement.custody.externalImplementationVerified, false);
  assert.equal(settlement.custody.republishSafe, false);
  assert.equal(settlement.custody.authority, 'NONE');
  assert.equal(store.pending().count, 0);
  const appendCount = port.appendCalls.length;
  assert.equal((await store.appendOutcomeUpdate(fixture.appendInput)).status, 'EXISTING');
  assert.equal(port.appendCalls.length, appendCount, 'an exact retry performs no second durable update');
  await store.close();

  store = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: port,
    clock: () => fixture.now + 1, portTimeoutMs: 1_000,
  });
  assert.deepEqual(store.state(), fixture.nextState);
  assert.deepEqual(store.settlement(query(fixture.prediction)).update, fixture.appendInput.update);
  assert.equal((await store.appendOutcomeUpdate(fixture.appendInput)).status, 'EXISTING');
  assert.equal(store.status().durableRevision, port.stream.revision);
  await store.close();
});

test('ambiguous returned ACK latches every reader, while a later exact reload recovers the acknowledged event once', async (t) => {
  const p = procedure(); const fixture = settlementFixture(t, p);
  const port = new MemoryPort(streamFromLocal(t, p, [fixture.prediction]), () => fixture.now);
  const rootDir = tempRoot(t);
  let store = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: port,
    clock: () => fixture.now, portTimeoutMs: 1_000,
  });
  port.alterReturnedAck = (ack) => ({ ...ack, headDigest: hex('9'), outcome: 'EXISTING' });
  await assert.rejects(
    store.appendOutcomeUpdate(fixture.appendInput),
    (error) => error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_ACK_INVALID',
  );
  assert.equal(store.status().localAheadUnacknowledged, true);
  for (const operation of [
    () => store.procedure(), () => store.state(),
    () => store.prediction(query(fixture.prediction)),
    () => store.outcome(query(fixture.prediction)),
    () => store.settlement(query(fixture.prediction)),
  ]) assert.throws(operation, /DURABLE_ACK_INVALID/);
  assert.equal((await store.close()).drained, false);

  port.alterReturnedAck = null;
  store = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: port,
    clock: () => fixture.now + 1, portTimeoutMs: 1_000,
  });
  assert.deepEqual(store.state(), fixture.nextState);
  assert.deepEqual(store.settlement(query(fixture.prediction)).outcome, fixture.appendInput.outcome);
  const priorCalls = port.appendCalls.length;
  assert.equal((await store.appendOutcomeUpdate(fixture.appendInput)).status, 'EXISTING');
  assert.equal(port.appendCalls.length, priorCalls, 'recovered exact stream cannot learn twice');
  await store.close();
});
