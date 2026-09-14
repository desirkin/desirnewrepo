import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createJudge } from '../judge/judge.js';
import { createScheduler } from '../judge/scheduler.js';
import { loadJudgePolicy } from '../judge/policy.js';
import {
  ADAPTIVE_RANKING_CAPTURE_ACK_VERSION, ADAPTIVE_RANKING_CAPTURE_VERSION,
  ADAPTIVE_RANKING_MEASUREMENT_ID, ADAPTIVE_RANKING_PORT_VERSION,
  adaptiveRankingInputCaptureEventDigest, createAdaptiveRankingPort,
} from '../judge/adaptive-ranking-port.js';
import { prepareAdaptiveJudgeFacts } from '../judge/adaptive-facts-source.js';
import { buildJudgeLearningConsumerContract } from '../judge/learning-recipe.js';
import { JUDGE_FACT_RECIPE_VERSION } from '../judge/learning-intake.js';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import {
  adaptiveStateDigestOf, initialAdaptiveState, sealAdaptiveProcedure,
} from '../learning/adaptive-registry.js';
import {
  resolveQualifiedAdaptiveProcedureRanking, sealAdaptiveProcedureConsumerContract,
  sealAdaptiveProcedurePublicationV2,
} from '../learning/adaptive-qualified-procedure.js';
import { digestOf, feeContract, instrumentSpec } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';
import { eventsFor, fakeClock, T0 } from './helpers/judge.js';

const DAY = 86_400_000;
const MIN = 60_000;
const POLICY = loadJudgePolicy(path.resolve('judge/samples/policy.paper-reference.json'));
const SPEC = instrumentSpec({
  venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'BTC/USD',
  base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online',
  priceIncrement: '0.1', qtyIncrement: '0.00000001', orderMin: '0.00005',
  costMin: '0.5', priceDecimals: 1, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE',
});
const SOL_SPEC = instrumentSpec({
  venue: 'kraken', pairKey: 'SOLUSD', altname: 'SOLUSD', wsname: 'SOL/USD',
  base: 'SOL', quote: 'ZUSD', canonicalCoin: 'SOL', status: 'online',
  priceIncrement: '0.01', qtyIncrement: '0.00000001', orderMin: '0.02',
  costMin: '0.5', priceDecimals: 2, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE',
});
const TEST_FEE = feeContract({
  venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001',
  rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01',
  roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL',
  scheduleId: 'adaptive-ranking-hook-fixture', observedTs: T0,
});
const clone = (value) => structuredClone(value);
const fmt = (value, decimals) => value.toFixed(decimals).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)]
  .map(([price, qty]) => fmt(price, 1) + fmt(qty, 8)).join(''));

function bars(endTs, close = 100000) {
  return Array.from({ length: 61 }, (_, index) => ({
    periodStartTs: endTs - (61 - index) * MIN,
    periodEndTs: endTs - (60 - index) * MIN,
    open: close, high: close + 200, low: index === 41 ? close - 4000 : close - 200,
    close, volumeQuote: 1000, volumeBase: 0.01, closed: true,
  }));
}

function scaleInvariantBars(endTs, close, wickFraction = 0.96) {
  return Array.from({ length: 61 }, (_, index) => ({
    periodStartTs: endTs - (61 - index) * MIN,
    periodEndTs: endTs - (60 - index) * MIN,
    open: close, high: close * 1.002, low: index === 41 ? close * wickFraction : close * 0.998,
    close, volumeQuote: 1000, volumeBase: 0.01, closed: true,
  }));
}

function adaptiveFixture({ scope = { setupType: 'ANY', regime: 'ANY', assets: 'ANY', venues: ['kraken'] } } = {}) {
  const preparedFactsContract = buildJudgeLearningConsumerContract({
    policyDigest: POLICY.digest,
    eligibility: {
      maxSpreadBps: 20, minBidDepthUsd10bps: null, minAtrPct: null,
      maxAtrPct: null, maxFactAgeMs: 60_000, requiredFeatures: ['spreadBps'],
    },
    effectMagnitude: 0.01, activationLifetimeMs: 30 * DAY,
    degradeRule: { minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 },
  });
  const consumerContract = sealAdaptiveProcedureConsumerContract({ preparedFactsContract });
  const procedure = sealAdaptiveProcedure({
    parentPolicyDigest: consumerContract.policyDigest,
    consumerContractDigest: consumerContract.consumerContractDigest,
    featureRecipeDigest: consumerContract.featureRecipeDigest,
    strategyIds: ['RANGE_IGNITION', 'TREND_PULLBACK_CONTINUATION'], createdTs: T0,
  });
  const initialState = initialAdaptiveState(procedure);
  const publication = sealAdaptiveProcedurePublicationV2({
    procedure, initialState, consumerContract,
    scope,
    applicability: { clauses: [{ feature: 'spreadBps', op: 'LTE', threshold: 20 }] },
    sealedTs: T0 + 1,
  });
  const currentState = clone(initialState);
  currentState.sequence = 1; currentState.updatedTs = T0 + 2;
  Object.assign(currentState.strategies.find((row) => row.strategyId === 'RANGE_IGNITION'), {
    observations: 1, positive60mProbability: 0.55, rankOffsetRrPoints: 0.015,
  });
  currentState.influencedEpisodes = 1;
  currentState.influenceLedgerDigest = 'd'.repeat(64);
  currentState.totalRankMovementRrPoints = 0.015;
  currentState.stateDigest = adaptiveStateDigestOf(currentState);
  const qualificationBody = {
    qualificationVersion: 'adaptive-ranking-procedure-qualification-1',
    publicationId: publication.publicationId, publicationDigest: publication.publicationDigest,
    procedureId: procedure.procedureId, procedureDigest: procedure.procedureDigest,
    initialStateDigest: publication.initialState.stateDigest,
    consumerContractDigest: consumerContract.consumerContractDigest,
    stateEffect: clone(consumerContract.stateEffect), scope: clone(publication.scope),
    applicability: clone(publication.applicability), candidateId: 'candidate-synthetic-prequalified',
    candidateDigest: '1'.repeat(64), activationId: 'activation-synthetic-prequalified',
    terminalReportDigest: '2'.repeat(64), qualifiedTs: T0 + 3, effectiveTs: T0 + 4,
    expiresTs: T0 + DAY, authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
    purpose: 'EXACT_EVOLVING_PROCEDURE_AFTER_TYPED_PAIRED_PROSPECTIVE_PROMOTION',
  };
  const qualificationDigest = digestOf(qualificationBody);
  const qualification = {
    ...qualificationBody, qualificationId: `arprocq-${qualificationDigest.slice(0, 40)}`,
    qualificationDigest,
  };
  return { consumerContract, procedure, publication, currentState, qualification };
}

function captureReceipt(input, { storeId = 'synthetic-fixed-reader-store', sequence = 11 } = {}) {
  const captureEventDigest = adaptiveRankingInputCaptureEventDigest(input);
  const body = {
    receiptVersion: ADAPTIVE_RANKING_CAPTURE_VERSION,
    captureEventDigest, decisionTs: input.decisionTs, capturedTs: input.decisionTs,
    snapshotDigest: digestOf(input.snapshot), factsEnvelopeDigest: digestOf(input.factsEnvelope),
    preparedFactsDigest: input.factsEnvelope.facts.factsDigest,
    sourceDigest: input.factsEnvelope.sourceBinding.sourceDigest,
    consumerContractDigest: input.consumerContract.consumerContractDigest,
    contextDigest: digestOf(input.context), strategyId: input.strategyId,
    marketIdentityDigest: digestOf(input.factsEnvelope.sourceBinding.market),
    durableAcknowledgment: {
      ackVersion: ADAPTIVE_RANKING_CAPTURE_ACK_VERSION,
      storeId, storeVersion: 'synthetic-store-1', sequence,
      eventDigest: captureEventDigest, headDigest: '6'.repeat(64), acknowledgedTs: input.decisionTs,
    },
    authority: 'NONE',
  };
  const receiptDigest = digestOf(body);
  return {
    ...body, receiptId: `jarcap-${receiptDigest.slice(0, 40)}`, receiptDigest,
  };
}

function qualifiedInputAtFactory(snapshots, {
  missing = false, corruptReceipt = false, resolverCalls,
  specOf = () => SPEC,
  scope = { setupType: 'ANY', regime: 'ANY', assets: 'ANY', venues: ['kraken'] },
  snapshotAgeMs = 0,
} = {}) {
  const fixed = adaptiveFixture({ scope });
  const port = createAdaptiveRankingPort({
    resolveQualifiedRanking(args) {
      resolverCalls.count += 1;
      return resolveQualifiedAdaptiveProcedureRanking(args);
    },
  });
  return {
    version: 'judge-adaptive-ranking-hook-1', port,
    preparedInputAt(query) {
      resolverCalls.readerCalls = (resolverCalls.readerCalls ?? 0) + 1;
      if (missing) return null;
      try {
      const bookSnapshot = snapshots.get(query.bookSnapshotDigest);
      assert.ok(bookSnapshot, 'the fixture reader is keyed by the exact accepted book digest');
      const factsEnvelope = prepareAdaptiveJudgeFacts({
        decisionTs: query.decisionTs,
        requestedMarket: {
          venue: query.context.venue, symbol: query.pair,
          canonicalCoin: query.context.asset, quote: 'USD',
        },
        instrumentSpec: specOf(query.pair), bookSnapshot,
        frozenIndicator: null, historicalBars: null, flowWindow: null,
      });
      const stateSource = {
        opportunityId: 'lop-synthetic-settlement', horizonMs: 60 * MIN,
        predictionId: 'aprd-synthetic', outcomeId: 'aout-synthetic', updateId: 'aupd-synthetic',
        receiptDigest: '3'.repeat(64), stateDigest: fixed.currentState.stateDigest,
        eventSequence: 8, eventDigest: '4'.repeat(64),
        durableAcknowledgment: {
          ackVersion: 'adaptive-durable-ack-1', sequence: 8,
          eventDigest: '4'.repeat(64), headDigest: '5'.repeat(64), acknowledgedTs: T0 + 5,
        },
      };
      const snapshot = {
        decisionVersion: 'adaptive-ranking-procedure-decision-2', preparedTs: query.decisionTs - snapshotAgeMs,
        mode: 'PAPER', kill: { state: 'ARMED' },
        adaptiveRankingProcedure: {
          consumerContractDigest: fixed.consumerContract.consumerContractDigest,
          procedureId: fixed.procedure.procedureId, procedureDigest: fixed.procedure.procedureDigest,
          currentState: fixed.currentState, stateSource, qualification: fixed.qualification,
          publication: fixed.publication, legacyActivationEffectReinterpreted: false,
          authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
        },
        withheld: [], authority: 'PAPER_RANKING_ADJUSTMENT_ONLY',
      };
      const partial = {
        snapshot, factsEnvelope, consumerContract: fixed.consumerContract,
        context: query.context, strategyId: query.strategyId, decisionTs: query.decisionTs,
      };
      const receipt = captureReceipt(partial, {
        storeId: `synthetic-fixed-reader-${query.context.asset.toLowerCase()}`,
        sequence: query.context.asset === 'BTC' ? 11 : 12,
      });
      if (corruptReceipt) receipt.durableAcknowledgment.headDigest = '7'.repeat(64);
      return {
        snapshot, factsEnvelope, consumerContract: fixed.consumerContract,
        captureReceipt: receipt,
      };
      } catch (error) {
        resolverCalls.readerError = error?.stack ?? String(error);
        throw error;
      }
    },
  };
}

async function rig({ adaptiveRanking = null, snapshotSink = null, controls = () => ({ kill: false, cage: false, vetoes: [] }) } = {}) {
  const accountId = `adaptive-hook-${Math.random().toString(36).slice(2)}`;
  const clock = fakeClock();
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TEST_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC });
  await dispatcher.load(); await dispatcher.commit(F.init());
  const scheduler = createScheduler({ monotonic: clock.monotonic });
  const snapshots = new Map(); feed.subscribe((event) => {
    if (event.kind === 'BOOK') {
      snapshots.set(event.snapshot.digest, event.snapshot);
      if (snapshotSink) snapshotSink.set(event.snapshot.digest, event.snapshot);
    }
  });
  const judge = createJudge({
    accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock,
    specOf: () => SPEC, feeOf: () => TEST_FEE,
    history: { bars: (symbol, nowTs) => bars(Math.floor(nowTs / MIN) * MIN) },
    caseSource: { consumed: () => null }, controls, scheduler, mode: 'PAPER', adaptiveRanking,
  });
  judge.admit('BTC/USD', { assetId: 'BTC', source: 'TEST' });
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'BTC/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({
    channel: 'book', type, data: [{
      symbol: 'BTC/USD', asks: asks.map(([price, qty]) => ({ price, qty })),
      bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids),
      timestamp: new Date(clock.now()).toISOString(),
    }],
  }), clock.now());
  let tradeId = 0;
  const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({
    channel: 'trade', type: 'update', data: [{
      symbol: 'BTC/USD', side, price, qty, ord_type: 'market', trade_id: ++tradeId,
      timestamp: new Date(clock.now()).toISOString(),
    }],
  }), clock.now());
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now());
  const advance = (milliseconds) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
      clock.advance(Math.min(1000, milliseconds - elapsed)); heartbeat();
    }
  };
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); };
  async function run({ finalDepth = 5 } = {}) {
    book([[100010, 5]], [[99990, 5]], 'snapshot');
    for (let minute = 0; minute < 22; minute += 1) for (let part = 0; part < 4; part += 1) {
      advance(15_000); trade(100001, 'buy'); trade(99999, 'sell'); book([[100010, 5]], [[99990, 5]]);
    }
    await settle();
    const start = Math.floor(clock.now() / MIN) * MIN + MIN;
    while (clock.now() < start) advance(Math.min(1000, start - clock.now()));
    for (let index = 0; index < 20; index += 1) { advance(2000); trade(100050, 'buy', 0.2); }
    while (clock.now() % MIN !== 0) advance(1000);
    clock.advance(500);
    for (let index = 0; index < 3; index += 1) {
      book([[100420, finalDepth], [100430, finalDepth]], [[100400, finalDepth], [100390, finalDepth]]);
      trade(100410, 'buy', 0.1); await settle(); if (index < 2) clock.advance(1050);
    }
    await settle();
  }
  return { judge, dispatcher, snapshots, run };
}

function legacySolRanking(clock) {
  const published = buildActivation({
    candidateId: 'lcand-legacy-sol', patternId: 'lpat-legacy-sol',
    trainingCutoffTs: T0 - DAY, candidateDigest: 'legacy-candidate',
    evidenceDigest: 'legacy-evidence', reportDigest: 'legacy-report',
    maxAbsAdjust: 0.1, adjust: 0.1,
    scope: {
      setupType: 'RANGE_IGNITION', regime: 'ANY', assets: ['SOL'], venues: ['kraken'],
    },
    validation: {
      evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5,
      dateCount: 7, netAfterCostsPct: 0.4,
    },
    featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyVersion: POLICY.digest,
    applicability: { clauses: [{ feature: 'rv60', op: 'GTE', threshold: 0 }] },
    effectiveTs: T0, expiresTs: T0 + 30 * DAY, ts: T0,
  });
  const active = transitionActivation(published, {
    state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T0,
  });
  return {
    snapshot: () => ({
      view: 'DECISION', preparedTs: clock.now(), activations: [active],
      kill: { state: 'ARMED', reason: null, ts: T0 },
    }),
  };
}

async function dualCandidateRig({ adaptiveRanking = null, snapshotSink = null, legacyFavorSol = false } = {}) {
  const accountId = `adaptive-dual-${Math.random().toString(36).slice(2)}`;
  const clock = fakeClock();
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const specOf = (symbol) => symbol === 'SOL/USD' ? SOL_SPEC : SPEC;
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TEST_FEE, specOf });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf });
  await dispatcher.load(); await dispatcher.commit(F.init());
  const scheduler = createScheduler({ monotonic: clock.monotonic });
  feed.subscribe((event) => {
    if (event.kind === 'BOOK' && snapshotSink) snapshotSink.set(event.snapshot.digest, event.snapshot);
  });
  const judge = createJudge({
    accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock,
    specOf, feeOf: () => TEST_FEE,
    history: { bars: (symbol, nowTs) => scaleInvariantBars(
      Math.floor(nowTs / MIN) * MIN,
      symbol === 'SOL/USD' ? 1000 : 100000,
      symbol === 'SOL/USD' ? 0.95996 : 0.96,
    ) },
    caseSource: { consumed: () => null }, controls: () => ({ kill: false, cage: false, vetoes: [] }),
    scheduler, mode: 'PAPER', adaptiveRanking,
    learning: legacyFavorSol ? legacySolRanking(clock) : null,
  });
  const symbols = ['SOL/USD', 'BTC/USD'];
  judge.admit('SOL/USD', { assetId: 'SOL', source: 'TEST' });
  clock.advance(1);
  judge.admit('BTC/USD', { assetId: 'BTC', source: 'TEST' });
  for (const symbol of symbols) {
    feed.ingest(JSON.stringify({
      channel: 'instrument', type: 'snapshot',
      data: { pairs: [{ symbol, price_precision: symbol === 'SOL/USD' ? 2 : 1, qty_precision: 8 }] },
    }), clock.now());
    feed.ingest(JSON.stringify({
      method: 'subscribe', success: true, result: { channel: 'trade', symbol },
    }), clock.now());
  }
  const decimals = (symbol) => symbol === 'SOL/USD' ? 2 : 1;
  const scaled = (symbol, value) => symbol === 'SOL/USD' ? value / 100 : value;
  const book = (symbol, asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({
    channel: 'book', type, data: [{
      symbol,
      asks: asks.map(([price, qty]) => ({ price: scaled(symbol, price), qty })),
      bids: bids.map(([price, qty]) => ({ price: scaled(symbol, price), qty })),
      checksum: crc32([...asks.slice(0, 10), ...bids.slice(0, 10)]
        .map(([price, qty]) => fmt(scaled(symbol, price), decimals(symbol)) + fmt(qty, 8)).join('')),
      timestamp: new Date(clock.now()).toISOString(),
    }],
  }), clock.now());
  let tradeId = 0;
  const trade = (symbol, price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({
    channel: 'trade', type: 'update', data: [{
      symbol, side, price: scaled(symbol, price), qty: symbol === 'SOL/USD' ? qty * 100 : qty,
      ord_type: 'market', trade_id: ++tradeId, timestamp: new Date(clock.now()).toISOString(),
    }],
  }), clock.now());
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now());
  const advance = (milliseconds) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
      clock.advance(Math.min(1000, milliseconds - elapsed)); heartbeat();
    }
  };
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); };
  async function run() {
    for (const symbol of symbols) book(symbol, [[100010, 5]], [[99990, 5]]);
    for (let minute = 0; minute < 22; minute += 1) for (let part = 0; part < 4; part += 1) {
      advance(15_000);
      for (const symbol of symbols) {
        trade(symbol, 100001, 'buy'); trade(symbol, 99999, 'sell');
        book(symbol, [[100010, 5]], [[99990, 5]]);
      }
    }
    await settle();
    const start = Math.floor(clock.now() / MIN) * MIN + MIN;
    while (clock.now() < start) advance(Math.min(1000, start - clock.now()));
    for (let index = 0; index < 20; index += 1) {
      advance(2000); for (const symbol of symbols) trade(symbol, 100050, 'buy', 0.2);
    }
    while (clock.now() % MIN !== 0) advance(1000);
    clock.advance(500);
    for (let index = 0; index < 3; index += 1) {
      for (const symbol of symbols) {
        book(symbol, [[100420, 5], [100430, 5]], [[100400, 5], [100390, 5]]);
        trade(symbol, 100410, 'buy', 0.1);
      }
      await settle(); if (index < 2) clock.advance(1050);
    }
    await settle(); await settle();
  }
  return { clock, judge, dispatcher, run };
}

test('normal Judge uses the actual qualified port only after legal post-cost admission and preserves baseline valuation', async () => {
  const resolverCalls = { count: 0 }; const snapshots = new Map();
  const adaptiveRanking = qualifiedInputAtFactory(snapshots, { resolverCalls });
  const fixture = await rig({ adaptiveRanking, snapshotSink: snapshots });
  await fixture.run();
  const decision = fixture.judge.decisions().find((row) => row.status === 'ENTRY_RESERVED');
  assert.ok(decision, JSON.stringify(fixture.judge.decisions().map((row) => [row.status, row.reasonCodes])));
  const measurement = decision.measurements.find((row) => row.id === ADAPTIVE_RANKING_MEASUREMENT_ID);
  assert.equal(measurement?.ok, true, resolverCalls.readerError ?? measurement?.note);
  assert.equal(measurement?.value, 0.015);
  assert.equal(measurement?.unit, 'REWARD_RISK_RATIO_POINTS');
  assert.match(measurement.note, /jaranke-/);
  assert.equal(typeof decision.valuationRef.rewardRiskRatio, 'string');
  assert.equal(Object.hasOwn(decision.valuationRef, 'adaptiveRewardRiskRatio'), false,
    'the learned rank stays a measurement and never rewrites the executable valuation');
  assert.equal(resolverCalls.count, 1);
  assert.equal(resolverCalls.readerCalls, 1);
  assert.equal(adaptiveRanking.port.version, ADAPTIVE_RANKING_PORT_VERSION);
});

test('missing or corrupt pre-decision custody is a typed no-effect and never reaches the qualified resolver', async () => {
  for (const corruptReceipt of [false, true]) {
    const resolverCalls = { count: 0 }; const snapshots = new Map();
    const adaptiveRanking = qualifiedInputAtFactory(snapshots, {
      missing: !corruptReceipt, corruptReceipt, resolverCalls,
    });
    const fixture = await rig({ adaptiveRanking, snapshotSink: snapshots });
    await fixture.run();
    const decision = fixture.judge.decisions().find((row) => row.status === 'ENTRY_RESERVED');
    assert.ok(decision);
    const measurement = decision.measurements.find((row) => row.id === ADAPTIVE_RANKING_MEASUREMENT_ID);
    assert.equal(measurement?.ok, false);
    assert.match(measurement.note, /PRE_DECISION_(INPUT_UNAVAILABLE|DURABLE_CAPTURE_INVALID)/);
    assert.equal(resolverCalls.count, 0);
    assert.equal(resolverCalls.readerCalls, 1);
  }
});

test('entry gates and rejected executable costs cannot be bypassed or invoke the adaptive input reader', async () => {
  const blockedCalls = { count: 0 }; const blockedSnapshots = new Map();
  const blockedPort = qualifiedInputAtFactory(blockedSnapshots, { resolverCalls: blockedCalls });
  const blocked = await rig({ adaptiveRanking: blockedPort, controls: () => ({ kill: true, cage: false, vetoes: [] }) });
  await blocked.run();
  assert.equal(blockedCalls.count, 0);
  assert.equal(blockedCalls.readerCalls ?? 0, 0, 'a blocked entry never reads adaptive evidence');
  assert.equal(blocked.judge.decisions().some((row) => row.status === 'ENTRY_RESERVED'), false);

  const costCalls = { count: 0 }; const costSnapshots = new Map();
  const costPort = qualifiedInputAtFactory(costSnapshots, { resolverCalls: costCalls });
  const rejected = await rig({ adaptiveRanking: costPort });
  await rejected.run({ finalDepth: 0.000001 });
  assert.equal(costCalls.count, 0);
  assert.equal(costCalls.readerCalls ?? 0, 0, 'an executable-cost refusal never reads adaptive evidence');
  assert.equal(rejected.judge.decisions().some((row) => row.status === 'ENTRY_RESERVED'), false);
  assert.ok(rejected.judge.decisions().some((row) => row.reasonCodes.includes('NO_TRADE_SIZE')));
});

test('actual normal batch ordering reverses a small baseline lead with one typed adaptive RR influence, never adds the legacy rank unit, and is deterministic across restart', async () => {
  const baseline = await dualCandidateRig(); await baseline.run();
  assert.deepEqual(baseline.judge.admissionGate().lastBatch.order, ['SOL', 'BTC'],
    `SOL's deliberately small post-cost baseline lead wins without adaptive ranking: ${JSON.stringify(baseline.judge.decisions().map((row) => [row.asset.canonicalCoin, row.status, row.valuationRef?.rewardRiskRatio, row.reasonCodes]))}`);

  async function adaptiveRun() {
    const snapshots = new Map(); const calls = { count: 0 };
    const specOf = (symbol) => symbol === 'SOL/USD' ? SOL_SPEC : SPEC;
    const adaptiveRanking = qualifiedInputAtFactory(snapshots, {
      resolverCalls: calls, specOf,
      scope: { setupType: 'ANY', regime: 'ANY', assets: ['BTC'], venues: ['kraken'] },
    });
    const fixture = await dualCandidateRig({
      adaptiveRanking, snapshotSink: snapshots, legacyFavorSol: true,
    });
    await fixture.run();
    return { fixture, calls };
  }

  const first = await adaptiveRun();
  assert.deepEqual(first.fixture.judge.admissionGate().lastBatch.order, ['BTC', 'SOL'],
    `the BTC-only qualified +0.015 RR-point state reverses the small baseline ordering: ${JSON.stringify(first.fixture.judge.decisions().map((row) => [row.asset.canonicalCoin, row.status, row.valuationRef?.rewardRiskRatio, row.measurements.filter((m) => [ADAPTIVE_RANKING_MEASUREMENT_ID, 'LEARNED_RANK_ADJUSTMENT'].includes(m.id))]))}`);
  const btc = first.fixture.judge.decisions().find((row) => row.asset.canonicalCoin === 'BTC' && row.valuationRef);
  const sol = first.fixture.judge.decisions().find((row) => row.asset.canonicalCoin === 'SOL' && row.valuationRef);
  assert.ok(btc && sol);
  assert.equal(btc.measurements.find((row) => row.id === ADAPTIVE_RANKING_MEASUREMENT_ID)?.value, 0.015);
  assert.equal(sol.measurements.find((row) => row.id === 'LEARNED_RANK_ADJUSTMENT')?.value, 0.1,
    'the legacy selector genuinely favors SOL in its distinct RANK_SCORE_UNITS');
  assert.equal(sol.measurements.find((row) => row.id === ADAPTIVE_RANKING_MEASUREMENT_ID)?.ok, false);
  assert.equal(first.calls.count, 2, 'both fully qualified candidates reach the actual resolver');

  const restarted = await adaptiveRun();
  assert.deepEqual(restarted.fixture.judge.admissionGate().lastBatch.order, ['BTC', 'SOL']);
  const notes = (run) => Object.fromEntries(run.fixture.judge.decisions().filter((decision) => decision.valuationRef).map((decision) => [
    decision.asset.canonicalCoin,
    decision.measurements.find((row) => row.id === ADAPTIVE_RANKING_MEASUREMENT_ID)?.note,
  ]));
  assert.deepEqual(notes(restarted), notes(first),
    'a restarted fixed reader over the same ACKed state and exact inputs produces the same evidence identities');
});

test('a stale fixed-reader snapshot is measured as baseline in the normal caller and cannot reorder a batch', async () => {
  const snapshots = new Map(); const calls = { count: 0 };
  const adaptiveRanking = qualifiedInputAtFactory(snapshots, {
    resolverCalls: calls, specOf: (symbol) => symbol === 'SOL/USD' ? SOL_SPEC : SPEC,
    scope: { setupType: 'ANY', regime: 'ANY', assets: ['BTC'], venues: ['kraken'] },
    snapshotAgeMs: 16 * MIN,
  });
  const fixture = await dualCandidateRig({ adaptiveRanking, snapshotSink: snapshots });
  await fixture.run();
  assert.deepEqual(fixture.judge.admissionGate().lastBatch.order, ['SOL', 'BTC']);
  assert.equal(calls.count, 0, 'stale state is refused before the qualified resolver');
  for (const decision of fixture.judge.decisions().filter((row) => row.valuationRef)) {
    const measurement = decision.measurements.find((row) => row.id === ADAPTIVE_RANKING_MEASUREMENT_ID);
    assert.equal(measurement?.ok, false);
    assert.match(measurement?.note ?? '', /PRE_DECISION_DURABLE_CAPTURE_INVALID/);
  }
});
