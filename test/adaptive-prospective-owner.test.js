import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson, opportunityIdOf } from '../learning/contracts.js';
import {
  createAdaptiveProspectiveOwner,
  MAX_ADAPTIVE_FOLLOW_UPS,
} from '../learning/adaptive-prospective-owner.js';
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

function tempRoot(t, prefix = 'adaptive-prospective-owner-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function predictionInput(p, n = 1) {
  const decisionTs = T0 + n * 10_000;
  const identity = {
    canonicalCoin: n % 2 ? 'BTC' : 'ETH',
    decisionTs,
    captureRecipeVersion: 'prospective-owner-test-1',
    datasetId: 'prospective-owner-test',
  };
  return {
    opportunityId: opportunityIdOf(identity), identity,
    catalogContentId: 'catalog-prospective-owner',
    predictionTs: decisionTs, horizonMs: ADAPTIVE_HORIZON_MS,
    featureRecipeDigest: p.parent.featureRecipeDigest,
    factsDigest: hex('e'),
    strategyAssessments: p.strategies.map((strategyId) => ({
      strategyId, eligibility: 'ELIGIBLE', reasonCode: null,
    })),
    selection: { strategyId: 'IGNITION', reasonCode: 'BASELINE_SELECTED' },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function initialStream(t, p) {
  const root = tempRoot(t, 'adaptive-owner-stream-');
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
  constructor(stream, clock) {
    this.stream = copy(stream);
    this.clock = clock;
    this.appendCalls = [];
    this.nextGate = null;
  }

  async load() { return copy(this.stream); }

  holdNext() {
    const gate = { started: deferred(), release: deferred() };
    this.nextGate = gate;
    return gate;
  }

  async append(request) {
    this.appendCalls.push(copy(request));
    const gate = this.nextGate; this.nextGate = null;
    if (gate) { gate.started.resolve(); await gate.release.promise; }
    assert.equal(request.expectedRevision, this.stream.revision);
    assert.equal(request.expectedHeadDigest, this.stream.acknowledgedHead.headDigest);
    const acknowledgedTs = this.clock();
    this.stream.journalText += `${canonicalJson(request.event)}\n`;
    this.stream.acknowledgedHead = copy(request.nextAcknowledgedHead);
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

async function openHarness(t, p, nowRef, rootDir = tempRoot(t), port = null) {
  const durablePort = port ?? new MemoryPort(initialStream(t, p), () => nowRef.value);
  const store = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort,
    clock: () => nowRef.value, portTimeoutMs: 1_000,
  });
  const owner = createAdaptiveProspectiveOwner({ store, procedure: p, clock: () => nowRef.value });
  return { owner, store, port: durablePort, rootDir };
}

test('original forecast uses the last ACKed state and is invisible until its durable ACK', async (t) => {
  const p = procedure(); const nowRef = { value: T0 + 10_100 };
  const h = await openHarness(t, p, nowRef);
  const gate = h.port.holdNext();
  const input = predictionInput(p);
  let resolved = false;
  const pendingWrite = h.owner.recordPrediction(input).then((value) => { resolved = true; return value; });
  input.selection.reasonCode = 'MUTATED_AFTER_CALL';
  await gate.started.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(h.owner.state(), initialAdaptiveState(p));
  assert.equal(h.owner.pending({ nowTs: nowRef.value }).total, 0);
  gate.release.resolve();
  const saved = await pendingWrite;
  assert.equal(saved.status, 'APPENDED');
  assert.equal(saved.durable, true);
  assert.equal(saved.prediction.selection.reasonCode, 'BASELINE_SELECTED');
  assert.deepEqual(saved.prediction.modelStateRef, {
    stateVersion: initialAdaptiveState(p).stateVersion,
    sequence: 0,
    stateDigest: initialAdaptiveState(p).stateDigest,
  });

  const beforeTarget = h.owner.pending({ limit: 1, nowTs: saved.prediction.targetEndTs - 1 });
  assert.equal(beforeTarget.total, 1);
  assert.equal(beforeTarget.returned, 1);
  assert.equal(beforeTarget.items[0].followUpState, 'AWAIT_TARGET');
  assert.equal(beforeTarget.automaticArchivePolling, false);
  assert.equal(h.owner.pending({ nowTs: saved.prediction.targetEndTs }).items[0].followUpState, 'AWAIT_LABEL_OR_DEADLINE');
  assert.equal(
    h.owner.pending({ nowTs: saved.prediction.targetEndTs + p.target.maxLabelDelayMs + 1 }).items[0].followUpState,
    'FINAL_POLL_DUE',
  );
  assert.throws(() => h.owner.pending({ limit: MAX_ADAPTIVE_FOLLOW_UPS + 1 }), /PENDING_LIMIT_INVALID/);
  assert.equal(h.owner.status().applicationAuthority, 'NONE');
  assert.equal(h.owner.status().runtimeIntegration, 'UNCOMMISSIONED');
  assert.deepEqual(await h.owner.close(), {
    closed: true, drained: true, durableRevision: 2, authority: 'NONE',
  });
  assert.throws(() => h.owner.state(), /OWNER_CLOSED/);
});

test('matured candle settlement scores the saved forecast before one ACKed update and restart cannot learn twice', async (t) => {
  const p = procedure(); const nowRef = { value: T0 + 10_100 };
  const rootDir = tempRoot(t); const h = await openHarness(t, p, nowRef, rootDir);
  const saved = (await h.owner.recordPrediction(predictionInput(p))).prediction;
  nowRef.value = saved.targetEndTs + 1_000;
  const submission = adaptiveSettlementSubmission(p, saved, {
    opportunityId: saved.opportunityId, horizonMs: saved.horizonMs,
    state: 'MATURED', logReturnPct: 1,
    sourceEventTs: saved.targetEndTs, knownAtTs: nowRef.value,
    sourceDigest: hex('f'), reasonCode: null,
  });
  const gate = h.port.holdNext();
  const requestedSubmission = copy(submission);
  const firstPromise = h.owner.recordOutcome(requestedSubmission);
  requestedSubmission.outcomeInput.logReturnPct = 999;
  await gate.started.promise;
  assert.equal(h.owner.state().sequence, 0);
  assert.equal(h.store.settlement({ opportunityId: saved.opportunityId, horizonMs: saved.horizonMs }), null);
  gate.release.resolve();
  const first = await firstPromise;
  assert.equal(first.status, 'UPDATED');
  assert.equal(first.outcome.logReturnPct, 1);
  assert.equal(first.state.sequence, 1);
  assert.equal(first.scores.length, 2);
  assert.equal(first.scores[0].forecastProbability, saved.strategyAssessments[0].forecastProbability);
  assert.equal(first.update.previousSequence, 0);
  assert.equal(first.update.nextStateDigest, first.state.stateDigest);
  assert.equal(first.custody.authority, 'NONE');
  const callsAfterFirst = h.port.appendCalls.length;
  assert.equal((await h.owner.recordOutcome(submission)).status, 'EXISTING');
  assert.equal(h.port.appendCalls.length, callsAfterFirst);
  await h.owner.close();

  nowRef.value += 1;
  const reopenedStore = await openDurableAdaptiveStore({
    rootDir, procedure: p, durablePort: h.port,
    clock: () => nowRef.value, portTimeoutMs: 1_000,
  });
  const reopened = createAdaptiveProspectiveOwner({ store: reopenedStore, procedure: p, clock: () => nowRef.value });
  assert.equal(reopened.state().sequence, 1);
  const callsBeforeRetry = h.port.appendCalls.length;
  const retry = await reopened.recordOutcome(submission);
  assert.equal(retry.status, 'EXISTING');
  assert.equal(retry.update.updateDigest, first.update.updateDigest);
  assert.equal(reopened.state().sequence, 1);
  assert.equal(h.port.appendCalls.length, callsBeforeRetry);
  await reopened.close();
});

test('future and pending receipts cannot update, while deadline-missing is durably retained without movement', async (t) => {
  const p = procedure(); const nowRef = { value: T0 + 10_100 };
  const h = await openHarness(t, p, nowRef);
  const saved = (await h.owner.recordPrediction(predictionInput(p))).prediction;
  const pendingSubmission = adaptiveSettlementSubmission(p, saved, {
    opportunityId: saved.opportunityId, horizonMs: saved.horizonMs,
    state: 'PENDING', logReturnPct: null, sourceEventTs: null,
    knownAtTs: null, sourceDigest: null, reasonCode: 'ARCHIVE_ABSENT',
  });
  const revisionBefore = h.store.status().durableRevision;
  nowRef.value = saved.targetEndTs - 1;
  await assert.rejects(h.owner.recordOutcome(pendingSubmission), /provenance receipt was prepared in the future/);
  assert.equal(h.store.status().durableRevision, revisionBefore);
  assert.equal(h.owner.state().sequence, 0);

  nowRef.value = saved.targetEndTs;
  const pending = await h.owner.recordOutcome(pendingSubmission);
  assert.equal(pending.status, 'PENDING_NO_DURABLE_OUTCOME');
  assert.equal(pending.durableMutation, false);
  assert.equal(h.store.status().durableRevision, revisionBefore);
  assert.equal(h.owner.state().sequence, 0);

  nowRef.value = saved.targetEndTs + p.target.maxLabelDelayMs + 1;
  const missingSubmission = adaptiveSettlementSubmission(p, saved, {
    opportunityId: saved.opportunityId, horizonMs: saved.horizonMs,
    state: 'MISSING', logReturnPct: null, sourceEventTs: null,
    knownAtTs: nowRef.value, sourceDigest: hex('f'), reasonCode: 'ARCHIVE_ABSENT',
  });
  const missing = await h.owner.recordOutcome(missingSubmission);
  assert.equal(missing.status, 'APPENDED_NO_UPDATE');
  assert.equal(missing.reason, 'INELIGIBLE_MISSING');
  assert.equal(missing.update, null);
  assert.equal(missing.state.sequence, 0);
  assert.equal(h.owner.pending({ nowTs: nowRef.value }).total, 0);
  await h.owner.close();
});

test('owner serializes accepted work, close drains it, and fences new issuance', async (t) => {
  const p = procedure(); const nowRef = { value: T0 + 20_100 };
  const h = await openHarness(t, p, nowRef);
  const gate = h.port.holdNext();
  const firstInput = predictionInput(p, 2);
  const secondInput = copy(firstInput);
  secondInput.identity.canonicalCoin = 'SOL';
  secondInput.opportunityId = opportunityIdOf(secondInput.identity);
  const thirdInput = copy(firstInput);
  thirdInput.identity.canonicalCoin = 'DOGE';
  thirdInput.opportunityId = opportunityIdOf(thirdInput.identity);
  const first = h.owner.recordPrediction(firstInput);
  await gate.started.promise;
  const second = h.owner.recordPrediction(secondInput);
  const close = h.owner.close();
  assert.throws(() => h.owner.recordPrediction(thirdInput), /OWNER_CLOSED/);
  assert.equal(h.port.appendCalls.length, 1);
  gate.release.resolve();
  assert.equal((await first).durable, true);
  assert.equal((await second).durable, true);
  assert.deepEqual(await close, {
    closed: true, drained: true, durableRevision: 3, authority: 'NONE',
  });
  assert.equal(h.port.appendCalls.length, 2);
});
