import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opportunityIdOf, canonicalJson } from '../learning/contracts.js';
import {
  ADAPTIVE_HORIZON_MS, buildAdaptivePrediction, initialAdaptiveState, sealAdaptiveProcedure,
} from '../learning/adaptive-registry.js';
import {
  ADAPTIVE_DURABLE_ACK_VERSION, ADAPTIVE_DURABLE_STREAM_VERSION,
  AdaptiveDurableStoreError, openDurableAdaptiveStore,
} from '../learning/adaptive-durable-store.js';
import {
  ADAPTIVE_HEAD_VERSION, ADAPTIVE_JOURNAL_EVENT_VERSION, ADAPTIVE_STORE_VERSION,
  createAdaptiveStore, validateAdaptiveStoreSnapshot,
} from '../learning/adaptive-store.js';

const T0 = Date.UTC(2026, 8, 13, 15);
const hex = (char) => char.repeat(64);
const copy = (value) => JSON.parse(JSON.stringify(value));

function procedure() {
  return sealAdaptiveProcedure({
    parentPolicyDigest: hex('a'), consumerContractDigest: hex('b'), featureRecipeDigest: hex('c'),
    strategyIds: ['IGNITION', 'PULLBACK'], createdTs: T0,
  });
}

function tempRoot(t, prefix = 'adaptive-durable-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function prediction(p, n = 1) {
  const decisionTs = T0 + 10_000 + n * 10;
  const identity = {
    canonicalCoin: n % 2 ? 'BTC' : 'ETH', decisionTs,
    captureRecipeVersion: 'durable-test-capture-1', datasetId: 'durable-test',
  };
  return buildAdaptivePrediction({
    procedure: p,
    state: initialAdaptiveState(p),
    recordedTs: decisionTs + 100,
    input: {
      opportunityId: opportunityIdOf(identity), identity,
      catalogContentId: 'catalog-durable-test', predictionTs: decisionTs,
      horizonMs: ADAPTIVE_HORIZON_MS, featureRecipeDigest: p.parent.featureRecipeDigest,
      factsDigest: hex('e'),
      strategyAssessments: p.strategies.map((strategyId) => ({
        strategyId, eligibility: 'ELIGIBLE', reasonCode: null,
      })),
      selection: { strategyId: 'IGNITION', reasonCode: 'BASELINE_SELECTED' },
    },
  });
}

function seedStream(t, p, predictions = []) {
  const root = tempRoot(t, 'adaptive-durable-seed-');
  const local = createAdaptiveStore({ rootDir: root, procedure: p, clock: () => T0 });
  for (const row of predictions) local.appendPrediction(row);
  local.close();
  const journalText = readFileSync(path.join(root, 'journal.jsonl'), 'utf8');
  const acknowledgedHead = JSON.parse(readFileSync(path.join(root, 'head.json'), 'utf8'));
  const snapshot = validateAdaptiveStoreSnapshot({ journalText, acknowledgedHead, procedure: p });
  return {
    outcome: 'LOADED', streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
    storeVersion: ADAPTIVE_STORE_VERSION, eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
    procedureId: p.procedureId, procedureDigest: p.procedureDigest,
    revision: snapshot.eventCount, journalText, acknowledgedHead,
    acknowledgments: snapshot.events.map((event, index) => ({
      ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      sequence: index, eventDigest: event.eventDigest,
      headDigest: snapshot.eventHeadDigests[index],
      acknowledgedTs: event.recordedTs,
    })),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class MemoryDurablePort {
  constructor(stream, { clock, alterAck = null } = {}) {
    this.stream = copy(stream); this.clock = clock; this.alterAck = alterAck;
    this.loadCalls = []; this.appendCalls = []; this.hold = null;
    this.appendStarted = deferred(); this.closeCalls = 0;
  }

  async load(identity) {
    this.loadCalls.push(copy(identity));
    return copy(this.stream);
  }

  holdNextAppend() { this.hold = deferred(); return this.hold; }

  async append(request) {
    this.appendCalls.push(copy(request));
    this.appendStarted.resolve();
    const hold = this.hold; this.hold = null;
    if (hold) await hold.promise;
    assert.deepEqual(Object.keys(request).sort(), [
      'event', 'expectedHeadDigest', 'expectedRevision', 'identity', 'nextAcknowledgedHead',
    ].sort());
    assert.equal(Object.isFrozen(request), true);
    assert.equal(request.expectedRevision, this.stream.revision);
    assert.equal(request.expectedHeadDigest, this.stream.acknowledgedHead.headDigest);
    assert.equal(request.event.sequence, this.stream.revision);
    assert.equal(request.event.previousDigest, this.stream.acknowledgedHead.lastEventDigest);
    assert.equal(request.nextAcknowledgedHead.eventCount, this.stream.revision + 1);
    assert.equal(request.nextAcknowledgedHead.lastEventDigest, request.event.eventDigest);

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
    let ack = {
      outcome: 'APPENDED', ackVersion: ADAPTIVE_DURABLE_ACK_VERSION,
      streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
      storeVersion: ADAPTIVE_STORE_VERSION, eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
      procedureId: request.identity.procedureId, procedureDigest: request.identity.procedureDigest,
      revision: this.stream.revision, eventDigest: request.event.eventDigest,
      headDigest: request.nextAcknowledgedHead.headDigest, acknowledgedTs,
    };
    if (this.alterAck) ack = this.alterAck(copy(ack), copy(request));
    return ack;
  }
}

function openOptions(rootDir, p, port, clock) {
  return { rootDir, procedure: p, durablePort: port, clock, portTimeoutMs: 1_000 };
}

test('NOT_FOUND and invalid durable bootstrap refuse before creating local journal state', async (t) => {
  const p = procedure(); const rootA = tempRoot(t); const rootB = tempRoot(t);
  const missing = {
    load: async () => ({ outcome: 'NOT_FOUND', reason: 'EXPLICIT_COMMISSIONING_REQUIRED' }),
    append: async () => { throw new Error('not called'); },
  };
  await assert.rejects(
    openDurableAdaptiveStore(openOptions(rootA, p, missing, () => T0 + 1)),
    (error) => error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_NOT_COMMISSIONED',
  );
  assert.deepEqual(readdirSync(rootA), []);

  const corrupt = seedStream(t, p);
  corrupt.journalText = corrupt.journalText.slice(0, -1);
  const corruptPort = new MemoryDurablePort(corrupt, { clock: () => T0 + 1 });
  await assert.rejects(openDurableAdaptiveStore(openOptions(rootB, p, corruptPort, () => T0 + 1)));
  assert.deepEqual(readdirSync(rootB), []);
});

test('durable replay bootstraps a wiped local directory and enumerates pending work without duplication', async (t) => {
  const p = procedure(); const saved = prediction(p); let now = saved.recordedTs + 10;
  const port = new MemoryDurablePort(seedStream(t, p, [saved]), { clock: () => now });
  const root = tempRoot(t);
  let store = await openDurableAdaptiveStore(openOptions(root, p, port, () => now));
  assert.deepEqual(store.pending(), {
    revision: 2, count: 1, truncated: false, items: [saved],
  });
  const retry = await store.appendPrediction(saved);
  assert.equal(retry.status, 'EXISTING');
  assert.equal(retry.durable, true);
  assert.equal(port.appendCalls.length, 0);
  assert.equal(store.status().durability.republishSafe, false);
  assert.equal(store.status().durability.externalImplementationVerified, false);
  assert.equal(store.status().coreCompatible, false);
  assert.equal(store.status().authority, 'NONE');
  await store.close();

  now += 1;
  store = await openDurableAdaptiveStore(openOptions(root, p, port, () => now));
  assert.equal(store.pending().count, 1);
  assert.equal(store.status().durableRevision, 2);
  await store.close();
});

test('append copies synchronously, serializes callers, and exposes no pending event before exact ACK', async (t) => {
  const p = procedure(); let now = T0 + 12_000;
  const port = new MemoryDurablePort(seedStream(t, p), { clock: () => now });
  const store = await openDurableAdaptiveStore(openOptions(tempRoot(t), p, port, () => now));
  const first = copy(prediction(p, 1)); const second = copy(prediction(p, 2));
  const hold = port.holdNextAppend();
  let settled = false;
  const firstPromise = store.appendPrediction(first).then((value) => { settled = true; return value; });
  first.selection.reasonCode = 'MUTATED_AFTER_CALL';
  await port.appendStarted.promise;
  const secondPromise = store.appendPrediction(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(port.appendCalls.length, 1, 'the second append remains behind the first ACK');
  assert.equal(store.status().localAheadUnacknowledged, true);
  assert.equal(store.status().acknowledgedEvents, 1);
  assert.equal(store.pending().count, 0);

  hold.resolve();
  const firstResult = await firstPromise; const secondResult = await secondPromise;
  assert.equal(firstResult.status, 'APPENDED');
  assert.equal(firstResult.durable, true);
  assert.equal(firstResult.prediction.selection.reasonCode, 'BASELINE_SELECTED');
  assert.equal(secondResult.durable, true);
  assert.equal(port.appendCalls.length, 2);
  assert.equal(store.pending().count, 2);
  assert.equal(store.status().durableRevision, 3);
  assert.equal(store.status().localAheadUnacknowledged, false);
  await store.close();
});

test('an altered ACK head latches ambiguity and never exposes the local-ahead prediction', async (t) => {
  const p = procedure(); let now = T0 + 12_000;
  const port = new MemoryDurablePort(seedStream(t, p), {
    clock: () => now,
    alterAck: (ack) => ({ ...ack, headDigest: hex('f') }),
  });
  const store = await openDurableAdaptiveStore(openOptions(tempRoot(t), p, port, () => now));
  await assert.rejects(
    store.appendPrediction(prediction(p)),
    (error) => error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_ACK_INVALID',
  );
  assert.equal(store.status().state, 'FAILED');
  assert.equal(store.status().localAheadUnacknowledged, true);
  assert.throws(() => store.pending(), /DURABLE_ACK_INVALID/);
  assert.throws(() => store.appendPrediction(prediction(p, 2)), /DURABLE_ACK_INVALID/);
  assert.deepEqual(await store.close(), { closed: true, drained: false, durableRevision: 1, authority: 'NONE' });
});

test('close fences new work and waits for an in-flight durable acknowledgment', async (t) => {
  const p = procedure(); let now = T0 + 12_000;
  const port = new MemoryDurablePort(seedStream(t, p), { clock: () => now });
  const store = await openDurableAdaptiveStore(openOptions(tempRoot(t), p, port, () => now));
  const hold = port.holdNextAppend();
  const append = store.appendPrediction(prediction(p));
  await port.appendStarted.promise;
  const queuedAppend = store.appendPrediction(prediction(p, 2));
  let closed = false;
  const closePromise = store.close();
  const closing = closePromise.then((value) => { closed = true; return value; });
  assert.throws(() => store.appendPrediction(prediction(p, 3)), /ADAPTER_CLOSED/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  hold.resolve();
  assert.equal((await append).durable, true);
  assert.equal((await queuedAppend).durable, true, 'work accepted before close drains in order');
  assert.deepEqual(await closing, { closed: true, drained: true, durableRevision: 3, authority: 'NONE' });
  assert.strictEqual(store.close(), closePromise, 'close is idempotent and owns no external-port close');
  assert.equal(port.closeCalls, 0);
});

test('a timed-out port operation cannot resurrect acknowledged adapter state after close', async (t) => {
  const p = procedure(); const now = T0 + 12_000;
  const port = new MemoryDurablePort(seedStream(t, p), { clock: () => now });
  const store = await openDurableAdaptiveStore({
    ...openOptions(tempRoot(t), p, port, () => now), portTimeoutMs: 10,
  });
  const hold = port.holdNextAppend();
  const append = store.appendPrediction(prediction(p));
  await port.appendStarted.promise;
  await assert.rejects(
    append,
    (error) => error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_ACK_TIMEOUT',
  );
  assert.deepEqual(await store.close(), {
    closed: true, drained: false, durableRevision: 1, authority: 'NONE',
  });
  hold.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(port.stream.revision, 2, 'the late external result is ambiguous, not silently erased');
  assert.equal(store.status().state, 'CLOSED');
  assert.equal(store.status().durableRevision, 1, 'late response cannot mutate the closed adapter');
  assert.equal(store.status().localAheadUnacknowledged, true);
});

test('the trusted post-ACK clock rejects a late forecast even when the port backdates its ACK', async (t) => {
  const p = procedure(); const row = prediction(p); let now = row.recordedTs;
  const port = new MemoryDurablePort(seedStream(t, p), { clock: () => row.recordedTs });
  const store = await openDurableAdaptiveStore(openOptions(tempRoot(t), p, port, () => now));
  const hold = port.holdNextAppend(); const append = store.appendPrediction(row);
  await port.appendStarted.promise;
  now = row.predictionTs + p.target.maxPredictionPersistenceDelayMs + 1;
  hold.resolve();
  await assert.rejects(
    append,
    (error) => error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_PREDICTION_ACK_LATE',
  );
  assert.equal(store.status().durableRevision, 2, 'the exact ACK is retained as a fact');
  assert.equal(store.status().localAheadUnacknowledged, false);
  assert.throws(() => store.pending(), /DURABLE_PREDICTION_ACK_LATE/);
  assert.equal((await store.close()).drained, true);
});

test('local-ahead history and a held writer lock are preserved and never adopted or taken over', async (t) => {
  const p = procedure(); const durable = seedStream(t, p); const now = T0 + 12_000;
  const localAheadRoot = tempRoot(t); const local = createAdaptiveStore({
    rootDir: localAheadRoot, procedure: p, clock: () => now,
  });
  local.appendPrediction(prediction(p)); local.close();
  const beforeJournal = readFileSync(path.join(localAheadRoot, 'journal.jsonl'), 'utf8');
  const beforeHead = readFileSync(path.join(localAheadRoot, 'head.json'), 'utf8');
  await assert.rejects(
    openDurableAdaptiveStore(openOptions(
      localAheadRoot, p, new MemoryDurablePort(durable, { clock: () => now }), () => now,
    )),
    (error) => error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_LOCAL_DIVERGENCE',
  );
  assert.equal(readFileSync(path.join(localAheadRoot, 'journal.jsonl'), 'utf8'), beforeJournal);
  assert.equal(readFileSync(path.join(localAheadRoot, 'head.json'), 'utf8'), beforeHead);

  const lockedRoot = tempRoot(t); const lock = path.join(lockedRoot, 'writer.lock');
  writeFileSync(lock, 'operator-owned-lock');
  await assert.rejects(openDurableAdaptiveStore(openOptions(
    lockedRoot, p, new MemoryDurablePort(durable, { clock: () => now }), () => now,
  )));
  assert.equal(readFileSync(lock, 'utf8'), 'operator-owned-lock');
  assert.equal(existsSync(path.join(lockedRoot, 'journal.jsonl')), false);
  assert.equal(existsSync(path.join(lockedRoot, 'head.json')), false);
});

test('loaded acknowledgments bind every exact event head and reject future or late claims before bootstrap', async (t) => {
  const p = procedure(); const saved = prediction(p); const now = saved.recordedTs + 10;
  for (const mutate of [
    (stream) => { stream.acknowledgments[0].headDigest = hex('f'); },
    (stream) => { stream.acknowledgments[0].acknowledgedTs = now + 1; },
    (stream) => { stream.acknowledgments[1].acknowledgedTs = saved.predictionTs + p.target.maxPredictionPersistenceDelayMs + 1; },
  ]) {
    const stream = seedStream(t, p, [saved]); mutate(stream);
    const root = tempRoot(t);
    await assert.rejects(openDurableAdaptiveStore(openOptions(
      root, p, new MemoryDurablePort(stream, { clock: () => now }), () => now,
    )));
    assert.deepEqual(readdirSync(root), []);
  }
  assert.equal(ADAPTIVE_HEAD_VERSION, 'adaptive-acknowledged-head-2');
});
