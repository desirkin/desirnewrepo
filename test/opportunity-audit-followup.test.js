import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as auditContract from '../learning/opportunity-audit.js';
import { sealAuditFrame, annotateAuditOpportunity, sealAuditObservationEvidence } from '../learning/opportunity-audit.js';
import { openOpportunityAuditStore } from '../learning/opportunity-audit-store.js';
import {
  buildOpportunityAuditFollowup, createOpportunityAuditFollowup,
  opportunityAuditPendingItemV2, opportunityAuditSettlementReceiptV2Error,
  sealOpportunityAuditBroadDayManifest, sealOpportunityAuditBroadDaySourceReceipt,
  sealOpportunityAuditCandleEvidence, sealOpportunityAuditSettlementReceiptV2,
} from '../learning/opportunity-audit-followup.js';
import { startLearning } from '../learning/service.js';
import { canonicalDigest, canonicalJson } from '../learning/contracts.js';
import { createOpportunityAuditWorkerPort } from '../lib/opportunity-audit-worker-port.js';

const T0 = Date.UTC(2026, 8, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const hex = (value) => createHash('sha256').update(value).digest('hex');
const temp = () => mkdtempSync(path.join(tmpdir(), 'cobra-opportunity-followup-'));
const catalog = (coins = ['BTC', 'ETH', 'QUIET', 'FAILED']) => {
  const markets = coins.map((base) => ({ pairKey: `${base}USD`, nativeBase: base === 'BTC' ? 'XXBT' : base, nativeQuote: 'ZUSD', wsname: `${base}/USD`, base, quote: 'USD', status: 'online' }));
  const body = { venue: 'kraken', quote: 'USD', policyVersion: 1, markets };
  return { ...body, observedTs: T0, contentId: createHash('sha1').update(canonicalJson(body)).digest('hex') };
};
const frameOf = (coins = ['BTC', 'ETH', 'QUIET', 'FAILED']) => sealAuditFrame({
  catalog: catalog(coins), frameTs: T0, knownAtTs: T0, sampleSize: coins.length,
  horizonsMs: [HOUR], seedHex: '31'.repeat(32),
});
const evidence = () => sealAuditObservationEvidence({
  sourceId: 'sweep-1', sourceDigest: hex('sweep'), featureRecipeVersion: 'wideeye-audit-features-1',
  features: [{ name: 'zRet', value: 0, unit: 'ZSCORE', availability: 'KNOWN' }],
});
const annotationOf = (frame, entry, observedState = 'EVALUATED') => annotateAuditOpportunity({
  frame, opportunityId: entry.opportunityId, recordedTs: T0,
  observation: { state: observedState, reasonCode: observedState === 'EVALUATED' ? null : 'INSUFFICIENT_SERIES', knownAtTs: T0, evidence: observedState === 'EVALUATED' ? evidence() : null },
  nomination: { state: 'NOT_NOMINATED', reasonCode: 'NO_SETUP' },
  decision: { state: 'NOT_REACHED', reasonCode: 'NO_NOMINATION' },
  components: [{ componentId: 'wideeye', version: 'wideeye-1', configDigest: hex('wideeye'), state: 'OBSERVED' }],
});
const barsFor = (frame, horizonMs, first, last) => {
  const anchor = Math.ceil(frame.frameTs / 60_000) * 60_000;
  const terminal = Math.floor((frame.frameTs + horizonMs) / 60_000) * 60_000 - 60_000;
  const count = ((terminal - anchor) / 60_000) + 1;
  return Array.from({ length: count }, (_, index) => ({
    openTs: anchor + index * 60_000,
    close: index === 0 ? first : index === count - 1 ? last : first,
    knownAtTs: anchor + (index + 1) * 60_000 + 5_000,
  }));
};
const candleEvidence = (frame, coin, first, last, late = 5_000) => {
  const bars = barsFor(frame, HOUR, first, last);
  return sealOpportunityAuditCandleEvidence({
    canonicalCoin: coin, sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: `archive-${coin.toLowerCase()}`,
    archiveDigest: hex(`archive-${coin}`), archiveCreatedTs: frame.frameTs + HOUR + late, bars,
  });
};

async function readyStore(root, frame, nowRef) {
  const later = nowRef.value; nowRef.value = frame.frameTs;
  const store = openOpportunityAuditStore({ rootDir: root, clock: () => nowRef.value });
  let view = await store.createFrame({ frame });
  for (const entry of frame.population.filter((row) => row.selected)) {
    const annotation = annotationOf(frame, entry, ['QUIET'].includes(entry.market.base) ? 'INSUFFICIENT_SERIES' : 'EVALUATED');
    view = await store.appendAnnotation({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: view.revision, annotation });
  }
  nowRef.value = later;
  return store;
}

test('matures no-nomination, quiet and failed-breakout samples from exact closed windows, with source-bound missingness', async () => {
  const root = temp(); const frame = frameOf(); const nowRef = { value: T0 + HOUR + 10_000 };
  try {
    const store = await readyStore(root, frame, nowRef);
    const source = async ({ item }) => {
      if (item.canonicalCoin === 'BTC') return { state: 'AVAILABLE', evidence: candleEvidence(frame, 'BTC', 100, 109) };
      if (item.canonicalCoin === 'FAILED') return { state: 'AVAILABLE', evidence: candleEvidence(frame, 'FAILED', 100, 92) };
      if (item.canonicalCoin === 'QUIET') return { state: 'AVAILABLE', evidence: candleEvidence(frame, 'QUIET', 100, 100.1) };
      return { state: 'MISSING', reasonCode: 'ARCHIVE_TRACK_ABSENT', knownAtTs: nowRef.value, sourceReference: { sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: 'archive-manifest', sourceDigest: hex('missing') } };
    };
    const owner = createOpportunityAuditFollowup({ store, outcomeSource: source, clock: () => nowRef.value, maxPerStep: 8 });
    const report = await owner.step({ nowTs: nowRef.value });
    assert.deepEqual({ matured: report.matured, missing: report.terminalMissing, pending: report.pending, refused: report.refused, deferred: report.deferred }, { matured: 3, missing: 1, pending: 0, refused: 0, deferred: 0 });
    const view = await store.loadFrame(frame.frameId);
    assert.equal(view.outcomes.length, 4);
    assert.deepEqual(view.outcomes.filter((row) => row.status === 'MATURED').map((row) => row.outcome.outcomeClass).sort(), ['ADVERSE', 'FAVORABLE', 'NEUTRAL']);
    assert.ok(view.annotations.every((row) => row.nomination.state === 'NOT_NOMINATED'));
    assert.ok(frame.population.every((row) => row.observationInclusionProbability === 1 && row.actionPropensity.state === 'NOT_LOGGED'));
    await owner.close(); await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pending does not become missing, future/gapped/cross-market evidence is refused, and input custody is immutable', async () => {
  const root = temp(); const frame = frameOf(['BTC', 'ETH']); const nowRef = { value: T0 + HOUR + 10_000 };
  try {
    const store = await readyStore(root, frame, nowRef); let mutationBlocked = false;
    const source = async (request) => {
      try { request.item.canonicalCoin = 'SOL'; } catch { mutationBlocked = true; }
      if (request.item.canonicalCoin === 'BTC') return { state: 'PENDING', reasonCode: 'ARCHIVE_NOT_YET_AVAILABLE' };
      const wrong = structuredClone(candleEvidence(frame, 'BTC', 100, 102));
      return { state: 'AVAILABLE', evidence: wrong };
    };
    const owner = createOpportunityAuditFollowup({ store, outcomeSource: source, clock: () => nowRef.value });
    const report = await owner.step({ nowTs: nowRef.value });
    assert.equal(mutationBlocked, true); assert.equal(report.pending, 1); assert.equal(report.refused, 1);
    assert.equal((await store.loadFrame(frame.frameId)).outcomes.length, 0);
    const entry = frame.population.find((row) => row.market.base === 'BTC');
    const bad = structuredClone(candleEvidence(frame, 'BTC', 100, 102)); bad.bars[2].openTs += 60_000;
    assert.throws(() => buildOpportunityAuditFollowup({ frame, opportunityId: entry.opportunityId, horizonMs: HOUR, resolution: { state: 'AVAILABLE', evidence: bad }, recordedTs: nowRef.value }), /SETTLEMENT_INVALID/);
    await owner.close(); await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reports success only after append ACK plus exact readback, and restart never duplicates a settled target', async () => {
  const root = temp(); const frame = frameOf(['BTC']); const nowRef = { value: T0 + HOUR + 10_000 };
  try {
    let store = await readyStore(root, frame, nowRef); const realAppend = store.appendOutcome; let release; let reached = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const delayed = Object.freeze({ ...store, appendOutcome: async (input) => { reached = true; await gate; return realAppend(input); } });
    const source = async () => ({ state: 'AVAILABLE', evidence: candleEvidence(frame, 'BTC', 100, 101) });
    const owner = createOpportunityAuditFollowup({ store: delayed, outcomeSource: source, clock: () => nowRef.value });
    let settled = false; const task = owner.step({ nowTs: nowRef.value }).then((value) => { settled = true; return value; });
    while (!reached) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(owner.status().matured, 0);
    release(); assert.equal((await task).matured, 1); assert.equal(owner.status().matured, 1);
    await owner.close(); await store.close();
    store = openOpportunityAuditStore({ rootDir: root, clock: () => nowRef.value });
    const restarted = createOpportunityAuditFollowup({ store, outcomeSource: source, clock: () => nowRef.value });
    assert.equal((await restarted.step({ nowTs: nowRef.value })).considered, 0);
    assert.equal((await store.loadFrame(frame.frameId)).outcomes.length, 1);
    await restarted.close(); await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('learning service invokes optional audit follow-up without granting authority or blocking its synchronous tick', async () => {
  const dir = temp(); let called = 0; let resolveStep; const stepPromise = new Promise((resolve) => { resolveStep = resolve; });
  const timers = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
  const port = {
    step: async ({ nowTs }) => { called += 1; await stepPromise; return { state: 'COMPLETE', nowTs }; },
    status: () => ({ state: called ? 'RUNNING' : 'READY', authority: 'NONE' }),
  };
  try {
    const service = startLearning({ dataDir: dir, env: { LEARNING_ENABLED: 'true' }, clock: () => T0, timers, opportunityAuditFollowup: port });
    const report = service.tick();
    assert.deepEqual(report.opportunityAudit, { state: 'STARTED', authority: 'NONE' });
    assert.equal(called, 1); assert.equal(service.state(), 'RUNNING');
    resolveStep(); await stepPromise; service.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixed worker owns the store and returns only a durable terminal receipt to the follow-up owner', { timeout: 15_000 }, async () => {
  const root = temp(); const frameTs = Date.now(); const accepted = catalog(['BTC', 'QUIET']);
  accepted.observedTs = frameTs;
  const body = { venue: accepted.venue, quote: accepted.quote, policyVersion: accepted.policyVersion, markets: accepted.markets };
  accepted.contentId = createHash('sha1').update(canonicalJson(body)).digest('hex');
  accepted.counts = { supported: accepted.markets.length };
  const port = createOpportunityAuditWorkerPort({
    enabled: true, rootDir: root, sampleSize: 2, horizonsMs: [1], minFrameIntervalMs: 60_000,
    wideEyeComponent: { componentId: 'wideeye', version: 'wideeye-1', configDigest: hex('worker-wideeye') },
  });
  try {
    const token = await port.beforeSweep({ catalogSnapshot: { status: 'ACCEPTED', fresh: true, contentId: accepted.contentId, catalog: accepted }, frameTs });
    const observedTs = Date.now();
    await port.afterSweep({
      auditToken: token, recordedTs: observedTs,
      observation: {
        sweepId: `worker-sweep-${observedTs}`, catalogContentId: accepted.contentId, observedTs,
        rows: accepted.markets.map((market) => market.base === 'QUIET'
          ? { coin: market.base, evaluated: false, reason: 'INSUFFICIENT_SERIES' }
          : { coin: market.base, evaluated: true, zVol: 0, zRet: 0, extension: 0, preCooldownVerdict: null, cooldownSuppressed: false, noticeEmitted: false, usdVol24h: null, inDeepTape: false }),
      },
    });
    const deadline = Date.now() + 5_000;
    while (port.status().lastCommittedBatch === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(port.status().lastCommittedBatch, 'annotation custody must be confirmed before follow-up');
    const owner = createOpportunityAuditFollowup({
      store: port, maxPerStep: 8,
      outcomeSource: async ({ asOfTs }) => ({
        state: 'UNSUPPORTED', reasonCode: 'HORIZON_SHORTER_THAN_CLOSED_CANDLE', knownAtTs: asOfTs,
        sourceReference: { sourceKind: 'CLOSED_CANDLE_ARCHIVE', sourceId: 'archive-policy', sourceDigest: hex('short-horizon') },
      }),
    });
    const report = await owner.step({ nowTs: Date.now() });
    assert.equal(report.terminalMissing, 2); assert.equal(report.matured, 0);
    assert.equal((await port.pending({ asOfTs: Date.now(), limit: 8, cursor: null })).items.length, 0);
    await owner.close();
    const stopped = await port.close(); assert.equal(stopped.physicalExit, true);
    const reopened = openOpportunityAuditStore({ rootDir: root });
    try {
      const view = await reopened.loadFrame(token.frameId);
      assert.equal(view.outcomes.length, 2); assert.ok(view.outcomes.every((row) => row.status === 'UNSUPPORTED'));
    } finally { await reopened.close(); }
  } finally { await port.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test('lost post-commit ACK latches ambiguity; restart observes the one terminal outcome and cannot learn it twice', async () => {
  const root = temp(); const frame = frameOf(['BTC']); const nowRef = { value: T0 + HOUR + 10_000 };
  try {
    let store = await readyStore(root, frame, nowRef); const realAppend = store.appendOutcome;
    const ambiguous = Object.freeze({
      ...store,
      appendOutcome: async (input) => { await realAppend(input); throw Object.assign(new Error('ACK_LOST_AFTER_FSYNC'), { code: 'ACK_LOST' }); },
    });
    const source = async () => ({ state: 'AVAILABLE', evidence: candleEvidence(frame, 'BTC', 100, 103) });
    const owner = createOpportunityAuditFollowup({ store: ambiguous, outcomeSource: source, clock: () => nowRef.value });
    await assert.rejects(owner.step({ nowTs: nowRef.value }), { code: 'CUSTODY_FAILED' });
    assert.equal(owner.status().state, 'FAILED'); assert.equal(owner.status().matured, 0);
    await assert.rejects(owner.step({ nowTs: nowRef.value }), { code: 'CUSTODY_FAILED' });
    await owner.close().catch(() => {}); await store.close();
    store = openOpportunityAuditStore({ rootDir: root, clock: () => nowRef.value });
    assert.equal((await store.loadFrame(frame.frameId)).outcomes.length, 1);
    const recovered = createOpportunityAuditFollowup({ store, outcomeSource: source, clock: () => nowRef.value });
    assert.equal((await recovered.step({ nowTs: nowRef.value })).considered, 0);
    assert.equal((await store.loadFrame(frame.frameId)).outcomes.length, 1);
    await recovered.close(); await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one in-flight source call bounds the queue; timeout refuses evidence and close drains without a late write', async () => {
  const root = temp(); const frame = frameOf(['BTC']); const nowRef = { value: T0 + HOUR + 10_000 };
  try {
    const store = await readyStore(root, frame, nowRef); let lateResolve;
    const neverOnTime = new Promise((resolve) => { lateResolve = resolve; });
    const owner = createOpportunityAuditFollowup({
      store, outcomeSource: () => neverOnTime, clock: () => nowRef.value, sourceTimeoutMs: 10,
    });
    const first = owner.step({ nowTs: nowRef.value });
    assert.equal((await owner.step({ nowTs: nowRef.value })).state, 'BUSY');
    const report = await first; assert.equal(report.refused, 1); assert.equal(report.matured, 0);
    const closing = owner.close();
    lateResolve({ state: 'AVAILABLE', evidence: candleEvidence(frame, 'BTC', 100, 120) });
    await closing; await new Promise((resolve) => setImmediate(resolve));
    assert.equal(owner.status().state, 'STOPPED');
    assert.equal((await store.loadFrame(frame.frameId)).outcomes.length, 0, 'late source success has no custody capability');
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cadence and sample ceilings provide a deterministic daily work bound without changing equal inclusion', () => {
  const maxFramesPerDayAtWorkerMinimumCadence = 86_400_000 / 60_000;
  assert.equal(maxFramesPerDayAtWorkerMinimumCadence, 1_440);
  assert.equal(maxFramesPerDayAtWorkerMinimumCadence * 8, 11_520);
  const frame = frameOf(Array.from({ length: 64 }, (_, index) => `C${index}`));
  assert.equal(frame.sampling.inclusionProbability, 1);
  assert.ok(frame.population.every((row) => row.observationInclusionProbability === 1));
});

test('the shared worker port overlap is deferred without latching; write ambiguity still is not', async () => {
  const now = T0 + HOUR; let pendingCalls = 0; let settleCalls = 0;
  const item = {
    cursor: 'cursor', frameId: `oaf-${'a'.repeat(40)}`, frameDigest: 'b'.repeat(64),
    opportunityId: `lop-${'c'.repeat(40)}`, canonicalCoin: 'BTC', horizonMs: HOUR,
    dueTs: now, lastOutcomeId: null, lastStatus: null, annotationPresent: true,
    observationInclusionProbability: 0.5, actionPropensity: { state: 'NOT_LOGGED', value: null, policyVersion: null },
  };
  const busy = Object.assign(new Error('busy'), { code: 'WORKER_BUSY' });
  const port = {
    pending: async () => { pendingCalls += 1; if (pendingCalls === 1) throw busy; return { asOfTs: now, items: [item], nextCursor: null, truncated: false }; },
    settle: async () => { settleCalls += 1; throw Object.assign(new Error('queue'), { code: 'QUEUE_FULL' }); },
    status: () => ({ state: 'READY' }),
  };
  const owner = createOpportunityAuditFollowup({
    store: port, clock: () => now,
    outcomeSource: async () => ({ state: 'PENDING', reasonCode: 'ARCHIVE_NOT_READY' }),
  });
  assert.equal((await owner.step({ nowTs: now })).state, 'BUSY');
  const second = await owner.step({ nowTs: now });
  assert.equal(second.pending, 0); assert.equal(second.deferred, 1); assert.equal(settleCalls, 1, 'PENDING still traverses worker validation');
  assert.equal(owner.status().state, 'READY'); assert.equal(owner.status().deferred, 2);
  await owner.close();
});

test('V2 worker returns an exact request-bound nonterminal receipt without inventing durable outcome custody', { timeout: 15_000 }, async () => {
  const root = temp();
  const frameTs = Date.now();
  const accepted = catalog(['BTC']); accepted.observedTs = frameTs;
  const body = { venue: accepted.venue, quote: accepted.quote, policyVersion: accepted.policyVersion, markets: accepted.markets };
  accepted.contentId = createHash('sha1').update(canonicalJson(body)).digest('hex'); accepted.counts = { supported: 1 };
  const port = createOpportunityAuditWorkerPort({
    enabled: true, rootDir: root, sampleSize: 1, horizonsMs: [1], maxLabelDelayMs: 60_000,
    minFrameIntervalMs: 60_000,
    wideEyeComponent: { componentId: 'wideeye', version: 'wideeye-1', configDigest: hex('v2-wideeye') },
  });
  try {
    const token = await port.beforeSweep({ catalogSnapshot: { status: 'ACCEPTED', fresh: true, contentId: accepted.contentId, catalog: accepted }, frameTs });
    const observedTs = Date.now();
    await port.afterSweep({
      auditToken: token, recordedTs: observedTs,
      observation: { sweepId: `v2-sweep-${observedTs}`, catalogContentId: accepted.contentId, observedTs, rows: [] },
    });
    const waitUntil = Date.now() + 5_000;
    while (port.status().lastCommittedBatch === null && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 5));
    const asOfTs = Date.now();
    const page = await port.pending({ asOfTs, limit: 2, cursor: null });
    assert.equal(page.items.length, 1); assert.equal(page.items[0].itemVersion, 'opportunity-audit-pending-item-2');
    assert.deepEqual(page.items[0].market, accepted.markets[0]);
    const recordedTs = Date.now();
    const resolution = { state: 'PENDING', reasonCode: 'ARCHIVE_NOT_READY', preparedTs: recordedTs, sourceReceipt: null, evidence: null };
    const receipt = await port.settle({ item: page.items[0], resolution, asOfTs, recordedTs });
    assert.equal(opportunityAuditSettlementReceiptV2Error(receipt, { item: page.items[0], resolution, recordedTs }), null);
    assert.equal(receipt.state, 'PENDING'); assert.equal(receipt.durableOutcome, false);
    assert.equal(receipt.outcome, null); assert.equal(receipt.readback.outcomeId, null);
    await port.close();
    const reopened = openOpportunityAuditStore({ rootDir: root });
    try {
      const view = await reopened.loadFrame(token.frameId);
      assert.equal(view.frame.frameVersion, 'opportunity-audit-frame-2');
      assert.equal(view.outcomes.length, 0);
    } finally { await reopened.close(); }
  } finally { await port.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
const frameV2Of = (coins = ['BTC'], maxLabelDelayMs = 60_000) => auditContract.sealAuditFrameV2({
  catalog: catalog(coins), frameTs: T0, knownAtTs: T0, sampleSize: coins.length,
  horizonsMs: [HOUR], maxLabelDelayMs, seedHex: '32'.repeat(32),
});
const pendingV2Of = (frame, coin = 'BTC') => {
  const entry = frame.population.find((row) => row.market.base === coin);
  return opportunityAuditPendingItemV2(frame, {
    cursor: 'cursor-v2', frameId: frame.frameId, frameDigest: frame.frameDigest,
    opportunityId: entry.opportunityId, canonicalCoin: coin, horizonMs: HOUR,
    dueTs: frame.frameTs + HOUR, lastOutcomeId: null, lastStatus: null, annotationPresent: true,
    observationInclusionProbability: entry.observationInclusionProbability,
    actionPropensity: entry.actionPropensity,
  });
};
const sourceBinding = () => ({
  bindingVersion: 'broad-day-local-source-binding-1', sourceId: 'broad-day-local-source',
  sourceRootDigest: hex('source-root'), archiveVersion: 'broad-day-archive-local-v2',
  durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
});
const sourceRecords = (evidenceValue) => evidenceValue.bars.map((bar, index) => ({
  recordId: `broad-row-${index}`, recordDigest: hex(`broad-row-${index}-${bar.openTs}-${bar.close}`),
  periodStartTs: bar.openTs, periodEndTs: bar.openTs + 60_000, knownAtTs: bar.knownAtTs, close: bar.close,
}));
const datasetOf = (item, asOfTs) => ({
  datasetVersion: 'broad-day-dataset-v1', datasetId: 'broad-day-dataset', datasetDigest: hex('dataset'),
  dayStartTs: T0 - 12 * HOUR, dayEndTs: T0 + 12 * HOUR, asOfTs,
  sourceRootDigest: hex('source-root'), catalogEpochDigest: hex('catalog-epoch'),
  sourceMarketIdentityDigest: item.marketIdentityDigest,
});

test('independent liveness review: timing out does not launch overlapping unresolved source calls', async () => {
  const root = temp(); const frame = frameOf(['BTC', 'ETH']); const nowRef = { value: T0 + HOUR + 10_000 };
  let resolveLate; let calls = 0;
  const delayed = new Promise((resolve) => { resolveLate = resolve; });
  let store; let owner;
  try {
    store = await readyStore(root, frame, nowRef);
    owner = createOpportunityAuditFollowup({ store, clock: () => nowRef.value, sourceTimeoutMs: 10,
      outcomeSource: () => { calls += 1; return calls === 1 ? delayed : { state: 'PENDING', reasonCode: 'WAITING' }; } });
    const first = await owner.step({ nowTs: nowRef.value });
    assert.equal(calls, 1, 'later items in the same page must not overlap the unresolved source');
    assert.equal(first.considered, 1);
    assert.equal((await owner.step({ nowTs: nowRef.value })).state, 'BUSY');
    assert.equal(calls, 1, 'a fresh step cannot pretend timeout proves cancellation');
    resolveLate({ state: 'AVAILABLE', evidence: candleEvidence(frame, 'BTC', 100, 120) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await store.loadFrame(frame.frameId)).outcomes.length, 0);
    const recovered = await owner.step({ nowTs: nowRef.value });
    assert.equal(recovered.pending, 2, 'deferred page targets remain eligible for later honest followup');
  } finally {
    resolveLate?.({ state: 'PENDING', reasonCode: 'WAITING' });
    await owner?.close(); await store?.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('independent V2 review: every retained row must match evidence and be known at the requested cutoff', () => {
  const frame = frameV2Of(); const item = pendingV2Of(frame); const asOfTs = item.dueTs + 10_000;
  const evidence = candleEvidence(frame, 'BTC', 100, 105, 10_000);
  for (const kind of ['interior-close', 'future-known-at']) {
    const records = sourceRecords(evidence);
    if (kind === 'interior-close') records[1].close += 20;
    else records[1].knownAtTs = asOfTs + 1;
    const manifest = sealOpportunityAuditBroadDayManifest({ item, sourceBinding: sourceBinding(),
      readerDatasets: [datasetOf(item, asOfTs)], catalogMembershipDigest: hex('catalog-membership'), records });
    assert.throws(() => sealOpportunityAuditBroadDaySourceReceipt({ item, asOfTs, preparedTs: asOfTs + 2,
      resolutionState: 'AVAILABLE', resolutionReason: null, sourceBinding: sourceBinding(),
      archiveManifest: manifest, records, evidence }), /SOURCE_RECEIPT_INVALID/, kind);
  }
});

test('independent V2 review: pure followup rejects a well-formed pending item from a different frame', () => {
  const frame = frameV2Of(); const other = frameV2Of(['BTC'], 120_000); const item = pendingV2Of(other);
  const now = item.dueTs + 1;
  assert.throws(() => buildOpportunityAuditFollowup({ frame,
    opportunityId: frame.population[0].opportunityId, horizonMs: HOUR, item, asOfTs: now, recordedTs: now,
    resolution: { state: 'PENDING', reasonCode: 'ARCHIVE_NOT_READY', preparedTs: now, sourceReceipt: null, evidence: null },
  }), /SETTLEMENT_INVALID/);
});

test('independent V2 review: a rehashed settlement cannot invent return values inconsistent with its source', () => {
  const frame = frameV2Of(); const item = pendingV2Of(frame); const now = item.dueTs + 10_000;
  const evidence = candleEvidence(frame, 'BTC', 100, 105, 10_000); const records = sourceRecords(evidence);
  const manifest = sealOpportunityAuditBroadDayManifest({ item, sourceBinding: sourceBinding(),
    readerDatasets: [datasetOf(item, now)], catalogMembershipDigest: hex('catalog-membership'), records });
  const sourceReceipt = sealOpportunityAuditBroadDaySourceReceipt({ item, asOfTs: now, preparedTs: now,
    resolutionState: 'AVAILABLE', resolutionReason: null, sourceBinding: sourceBinding(), archiveManifest: manifest, records, evidence });
  const resolution = { state: 'AVAILABLE', reasonCode: null, preparedTs: now, sourceReceipt, evidence };
  const built = buildOpportunityAuditFollowup({ frame, opportunityId: item.opportunityId,
    horizonMs: HOUR, item, asOfTs: now, resolution, recordedTs: now });
  const outcome = structuredClone(built.outcome); outcome.outcome.returnPct = 999;
  const core = structuredClone(outcome); delete core.outcomeId; delete core.outcomeDigest;
  outcome.outcomeId = `oao-${canonicalDigest(core).slice(0, 40)}`;
  outcome.outcomeDigest = canonicalDigest({ ...core, outcomeId: outcome.outcomeId });
  assert.throws(() => sealOpportunityAuditSettlementReceiptV2({ item, resolution, recordedTs: now, outcome,
    readback: { frameId: item.frameId, frameDigest: item.frameDigest, storeRevision: 4,
      outcomeId: outcome.outcomeId, outcomeDigest: outcome.outcomeDigest } }), /DURABLE_ACK_INVALID/);
});

test('V2 predeclares a finite label delay and refuses terminal missingness through the deadline', () => {
  const frame = frameV2Of(); const item = pendingV2Of(frame); const atDeadline = item.deadlineTs;
  assert.equal(frame.target.maxLabelDelayMs, 60_000);
  assert.equal(item.deadlineTs, T0 + HOUR + 60_000);
  assert.throws(() => sealOpportunityAuditBroadDaySourceReceipt({
    item, asOfTs: atDeadline, preparedTs: atDeadline, resolutionState: 'MISSING',
    resolutionReason: 'LOCAL_ARCHIVE_UNAVAILABLE_AFTER_DEADLINE', sourceBinding: sourceBinding(),
    archiveManifest: null, records: [], evidence: null,
  }), /SOURCE_RECEIPT_INVALID/);
  const pending = buildOpportunityAuditFollowup({
    frame, opportunityId: item.opportunityId, horizonMs: item.horizonMs, item, asOfTs: atDeadline,
    resolution: { state: 'PENDING', reasonCode: 'ARCHIVE_NOT_READY', preparedTs: atDeadline, sourceReceipt: null, evidence: null },
    recordedTs: atDeadline,
  });
  assert.deepEqual(pending, { state: 'PENDING', reasonCode: 'ARCHIVE_NOT_READY', outcome: null });
  const after = atDeadline + 1;
  const sourceReceipt = sealOpportunityAuditBroadDaySourceReceipt({
    item, asOfTs: after, preparedTs: after, resolutionState: 'MISSING',
    resolutionReason: 'LOCAL_ARCHIVE_UNAVAILABLE_AFTER_DEADLINE', sourceBinding: sourceBinding(),
    archiveManifest: null, records: [], evidence: null,
  });
  const missing = buildOpportunityAuditFollowup({
    frame, opportunityId: item.opportunityId, horizonMs: item.horizonMs, item, asOfTs: after,
    resolution: { state: 'MISSING', reasonCode: 'LOCAL_ARCHIVE_UNAVAILABLE_AFTER_DEADLINE', preparedTs: after, sourceReceipt, evidence: null },
    recordedTs: after,
  });
  assert.equal(missing.state, 'MISSING');
  assert.equal(missing.outcome.outcomeKnownAtTs, after);
  assert.equal(missing.outcome.sourceReference.sourceDigest, sourceReceipt.receiptDigest);
});

test('V2 available receipt binds the exact market, retained records, prepared clock and settlement readback', () => {
  const frame = frameV2Of(); const item = pendingV2Of(frame); const preparedTs = item.dueTs + 10_000;
  const evidenceValue = candleEvidence(frame, 'BTC', 100, 105, 10_000);
  const records = sourceRecords(evidenceValue); const binding = sourceBinding();
  const manifest = sealOpportunityAuditBroadDayManifest({
    item, sourceBinding: binding, readerDatasets: [datasetOf(item, preparedTs)],
    catalogMembershipDigest: hex('catalog-membership'), records,
  });
  const sourceReceipt = sealOpportunityAuditBroadDaySourceReceipt({
    item, asOfTs: preparedTs, preparedTs, resolutionState: 'AVAILABLE', resolutionReason: null,
    sourceBinding: binding, archiveManifest: manifest, records, evidence: evidenceValue,
  });
  const resolution = { state: 'AVAILABLE', reasonCode: null, preparedTs, sourceReceipt, evidence: evidenceValue };
  const built = buildOpportunityAuditFollowup({
    frame, opportunityId: item.opportunityId, horizonMs: item.horizonMs, item,
    asOfTs: preparedTs, resolution, recordedTs: preparedTs,
  });
  const receipt = sealOpportunityAuditSettlementReceiptV2({
    item, resolution, recordedTs: preparedTs, outcome: built.outcome,
    readback: { frameId: item.frameId, frameDigest: item.frameDigest, storeRevision: 4, outcomeId: built.outcome.outcomeId, outcomeDigest: built.outcome.outcomeDigest },
  });
  assert.equal(opportunityAuditSettlementReceiptV2Error(receipt, { item, resolution, recordedTs: preparedTs }), null);
  const wrongItem = structuredClone(item); wrongItem.market.base = 'ETH';
  assert.notEqual(opportunityAuditSettlementReceiptV2Error(receipt, { item: wrongItem, resolution, recordedTs: preparedTs }), null);
  const wrongReceipt = structuredClone(receipt); wrongReceipt.readback.outcomeDigest = hex('other');
  assert.notEqual(opportunityAuditSettlementReceiptV2Error(wrongReceipt, { item, resolution, recordedTs: preparedTs }), null);
});

test('V2 terminal source content survives durable restart and an exact retry cannot duplicate the outcome', async () => {
  const root = temp(); const frame = frameV2Of(); const item = pendingV2Of(frame);
  const nowRef = { value: item.deadlineTs + 1 };
  try {
    let store = await readyStore(root, frame, nowRef);
    const sourceReceipt = sealOpportunityAuditBroadDaySourceReceipt({
      item, asOfTs: nowRef.value, preparedTs: nowRef.value, resolutionState: 'MISSING',
      resolutionReason: 'LOCAL_ARCHIVE_UNAVAILABLE_AFTER_DEADLINE', sourceBinding: sourceBinding(),
      archiveManifest: null, records: [], evidence: null,
    });
    const built = buildOpportunityAuditFollowup({
      frame, opportunityId: item.opportunityId, horizonMs: item.horizonMs, item, asOfTs: nowRef.value,
      resolution: { state: 'MISSING', reasonCode: 'LOCAL_ARCHIVE_UNAVAILABLE_AFTER_DEADLINE', preparedTs: nowRef.value, sourceReceipt, evidence: null },
      recordedTs: nowRef.value,
    });
    let view = await store.loadFrame(frame.frameId);
    view = await store.appendOutcome({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: view.revision, outcome: built.outcome });
    const firstRevision = view.revision;
    await store.close();
    store = openOpportunityAuditStore({ rootDir: root, clock: () => nowRef.value });
    view = await store.loadFrame(frame.frameId);
    assert.deepEqual(view.outcomes[0].settlementSourceReceipt, sourceReceipt);
    assert.equal(view.outcomes[0].outcomeDigest, built.outcome.outcomeDigest);
    const retried = await store.appendOutcome({ frameId: frame.frameId, frameDigest: frame.frameDigest, expectedRevision: view.revision, outcome: built.outcome });
    assert.equal(retried.status, 'EXISTING'); assert.equal(retried.revision, firstRevision); assert.equal(retried.outcomes.length, 1);
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worker custody cannot promote a bare state label into a durable settlement acknowledgment', async () => {
  const now = T0 + HOUR + 1;
  const item = {
    cursor: 'cursor', frameId: `oaf-${'a'.repeat(40)}`, frameDigest: 'b'.repeat(64),
    opportunityId: `lop-${'c'.repeat(40)}`, canonicalCoin: 'BTC', horizonMs: HOUR,
    dueTs: T0 + HOUR, lastOutcomeId: null, lastStatus: null, annotationPresent: true,
    observationInclusionProbability: 1, actionPropensity: { state: 'NOT_LOGGED', value: null, policyVersion: null },
  };
  const port = {
    pending: async () => ({ asOfTs: now, items: [item], nextCursor: null, truncated: false }),
    settle: async () => ({ state: 'MATURED' }),
    status: () => ({ state: 'READY' }),
  };
  const owner = createOpportunityAuditFollowup({
    store: port, clock: () => now,
    outcomeSource: async () => ({ state: 'PENDING', reasonCode: 'ARCHIVE_NOT_READY' }),
  });
  await assert.rejects(owner.step({ nowTs: now }), { code: 'DURABLE_ACK_INVALID' });
  assert.equal(owner.status().matured, 0);
  await owner.close().catch(() => {});
});
