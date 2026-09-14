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

function adaptiveFixture() {
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
    scope: { setupType: 'ANY', regime: 'ANY', assets: 'ANY', venues: ['kraken'] },
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

function captureReceipt(input) {
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
      storeId: 'synthetic-fixed-reader-store', storeVersion: 'synthetic-store-1', sequence: 11,
      eventDigest: captureEventDigest, headDigest: '6'.repeat(64), acknowledgedTs: input.decisionTs,
    },
    authority: 'NONE',
  };
  const receiptDigest = digestOf(body);
  return {
    ...body, receiptId: `jarcap-${receiptDigest.slice(0, 40)}`, receiptDigest,
  };
}

function qualifiedInputAtFactory(snapshots, { missing = false, corruptReceipt = false, resolverCalls }) {
  const fixed = adaptiveFixture();
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
        instrumentSpec: SPEC, bookSnapshot,
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
        decisionVersion: 'adaptive-ranking-procedure-decision-2', preparedTs: query.decisionTs,
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
      const receipt = captureReceipt(partial);
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
