import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createWatch, WATCH_REFERENCE } from '../watch/watch.js';
import { createJudge } from '../judge/judge.js';
import { createScheduler } from '../judge/scheduler.js';
import { evaluateEntry, sizeSearch } from '../judge/cost.js';
import { evaluateStyleExecutionGate } from '../judge/setups.js';
import {
  EDGE_STATE_VERSION, EDGE_WATCH_VERSION, OPERATIONAL_EDGE_STRATEGY_VERSION,
  edgePositionManagement, evaluatePositionEdgeState, executableEdgeFromEvaluation,
} from '../judge/edge-state.js';
import { SETUP_SELECTION_VERSION, STRATEGY_FAMILIES, strategyFamilyOf } from '../judge/setup-selection.js';
import { JUDGE_EDGE_POLICY_VERSION, strategyRuntimePorts, validateJudgePolicy } from '../judge/policy.js';
import { eventsFor, fakeClock, SPEC, TAKER_FEE } from './helpers/judge.js';
import { feeContract } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';

const EDGE_PORT = Object.freeze({ version: EDGE_STATE_VERSION });
const HARD_MAX_MS = 4 * 3_600_000;
const ENTRY_FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'edge-operational-test-only', observedTs: 1 });

async function edgeRig({ accountId = 'edge-paper', setupId = 'MICRO_BITE', management = 'EXACT', restoreWatch = false, dispatch = true } = {}) {
  const clock = fakeClock();
  const journal = createMemoryJournal();
  await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId);
  const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now });
  feed.admit('XBT/USD', { coin: 'BTC', priority: 'PENDING', reason: 'edge operational test', specDigest: SPEC.specDigest });
  feed.onConnect(clock.now());
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TAKER_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC });
  await dispatcher.load();
  await dispatcher.commit(F.init());
  const watchOf = () => createWatch({ accountId, dispatcher, adapter, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TAKER_FEE, policy: WATCH_REFERENCE, edgeState: EDGE_PORT });
  let watch = restoreWatch ? null : watchOf();
  const exact = edgePositionManagement({ setupId, hardMaxDurationMs: HARD_MAX_MS, selectionVersion: SETUP_SELECTION_VERSION });
  const positionOverride = management === 'EXACT' ? { management: exact } : {};
  await dispatcher.commit([
    F.hypothesis('edge-d1', { setupId }),
    F.decision('edge-d1', { setupId, strategyVersion: OPERATIONAL_EDGE_STRATEGY_VERSION }),
    F.reserve('edge-r1', 'edge-d1'),
    F.position('p1', 'edge-d1', { targetPrice: '110000', maxDurationMs: HARD_MAX_MS, ...positionOverride }),
    F.pin(),
    F.intent('edge-o1', 'p1', 'edge-r1'),
  ]);
  let tradeId = 0;
  const book = ({ ask = 99990, bid = 99980, askQty = 5, bidQty = 5 } = {}) => feed.ingest(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'XBT/USD', asks: [{ price: ask, qty: askQty }], bids: [{ price: bid, qty: bidQty }], timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const trade = ({ price = 100000, qty = 0.01, side = 'buy' } = {}) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tradeId, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  book();
  if (dispatch) {
    await dispatcher.dispatchEntry('edge-o1');
    clock.advance(300);
    book();
    await dispatcher.idle();
  }
  if (restoreWatch) watch = watchOf();
  const settle = async () => { await dispatcher.idle(); await watch.onTick(clock.now()); await dispatcher.idle(); };
  if (dispatch && !restoreWatch) await settle();
  return { clock, journal, dispatcher, feed, adapter, watch, F, book, trade, settle, state: () => dispatcher.state() };
}

function emitHealthyWindow(r, { seconds = 31, advancing = true } = {}) {
  for (let i = 0; i < seconds; i += 1) {
    r.clock.advance(1_000);
    const recent = i >= seconds - 15;
    const price = advancing && recent ? 100000 + (i - (seconds - 15) + 1) : 100000;
    r.book({ ask: price + 10, bid: price - 10, askQty: 5, bidQty: 5 });
    r.trade({ price, side: 'buy', qty: recent ? 0.02 : 0.001 });
  }
}

function edgePolicy() {
  const p = JSON.parse(readFileSync(new URL('../config/judge.paper.json', import.meta.url), 'utf8'));
  return {
    ...p,
    policyVersion: JUDGE_EDGE_POLICY_VERSION,
    strategyVersion: OPERATIONAL_EDGE_STRATEGY_VERSION,
    watchVersion: EDGE_WATCH_VERSION,
    setups: {
      ...p.setups,
      enabled: ['MOMENTUM_CONTINUATION', 'RANGE_IGNITION', 'TREND_PULLBACK_CONTINUATION', 'ABSORPTION_RECLAIM', 'CATALYST_TRANSMISSION', 'MICRO_BITE'],
      selectionVersion: SETUP_SELECTION_VERSION,
      edgeStateVersion: EDGE_STATE_VERSION,
    },
  };
}

const fmt = (v, digits) => Number(v).toFixed(digits).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
function operationalBars(setupId, endTs) {
  const values = setupId === 'MICRO_BITE'
    ? Array.from({ length: 61 }, (_, i) => (i < 41 ? { close: 99500, high: 99550, low: 99450 } : i === 41 ? { close: 100000, high: 101200, low: 99950 } : { close: 100000, high: 100050, low: 99950 }))
    : Array.from({ length: 61 }, (_, i) => (i < 41 ? { close: 99000, high: 99050, low: 98950 } : i === 41 ? { close: 99500, high: 99550, low: 98000 } : (() => { const close = 99500 + (i - 41) * 25; return { close, high: close + 50, low: close - 50 }; })()));
  return values.map((v, i) => ({ periodStartTs: endTs - (values.length - i) * 60_000, periodEndTs: endTs - (values.length - i - 1) * 60_000, open: v.close, high: v.high, low: v.low, close: v.close, volumeQuote: 1000, volumeBase: 0.01, closed: true }));
}

async function operationalJudgeRig(setupId) {
  const accountId = `judge-${setupId.toLowerCase()}`;
  const raw = edgePolicy(); raw.setups.enabled = [setupId];
  const loaded = validateJudgePolicy(raw); assert.equal(loaded.ok, true, loaded.error);
  const clock = fakeClock(); const journal = createMemoryJournal();
  await journal.create(accountId, { accountKind: 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: ENTRY_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC }); await dispatcher.load();
  await dispatcher.commit(F.init({ policyDigest: loaded.digest, policyVersion: JUDGE_EDGE_POLICY_VERSION }));
  const scheduler = createScheduler({ monotonic: clock.monotonic }); const ports = strategyRuntimePorts(loaded.policy);
  const history = { bars: (_symbol, nowTs) => operationalBars(setupId, Math.floor(nowTs / 60_000) * 60_000) };
  const judge = createJudge({ accountId, policy: loaded.policy, policyDigest: loaded.digest, dispatcher, feed, clock: pclock, specOf: () => SPEC, feeOf: () => ENTRY_FEE, history, controls: () => ({ kill: false, cage: false, vetoes: [] }), scheduler, mode: 'PAPER', setupSelection: ports.setupSelection, edgeState: ports.edgeState });
  const watch = createWatch({ accountId, dispatcher, adapter, feed, clock: pclock, specOf: () => SPEC, feeOf: () => ENTRY_FEE, edgeState: ports.edgeState });
  judge.admit('XBT/USD', { assetId: 'BTC', source: 'EDGE_OPERATIONAL_TEST' });
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  let tradeId = 0;
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tradeId, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now());
  const advance = (ms) => { for (let t = 0; t < ms; t += 1_000) { clock.advance(Math.min(1_000, ms - t)); heartbeat(); } };
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); await watch.onTick(clock.now()); await dispatcher.idle(); };
  book([[100010, 5]], [[99990, 5]]);
  for (let minute = 0; minute < 22; minute += 1) {
    for (let k = 0; k < 4; k += 1) { advance(15_000); trade(100001, 'buy'); trade(99999, 'sell'); book([[100010, 5]], [[99990, 5]]); }
  }
  await settle();
  const nextMinute = Math.floor(clock.now() / 60_000) * 60_000 + 60_000;
  while (clock.now() < nextMinute - 40_000) advance(1_000);
  for (let i = 0; i < 20; i += 1) { advance(2_000); trade(100020, 'buy', 0.2); }
  while (clock.now() % 60_000 !== 0) advance(1_000);
  clock.advance(500);
  const level = setupId === 'MICRO_BITE' ? 100060 : 100050;
  for (let i = 0; i < 3; i += 1) { book([[level + 1, 5]], [[level - 1, 5]]); trade(level, 'buy', 0.1); await settle(); if (i < 2) clock.advance(1_050); }
  await settle();
  // PAPER latency is an observation delay, not an instant fill. The first
  // accepted post-arrival book supplies the executable fill evidence.
  clock.advance(300); book([[level + 1, 5]], [[level - 1, 5]]); await settle();
  return { accountId, clock, journal, dispatcher, feed, adapter, judge, watch, loaded };
}

test('EDGE-P01. an explicit PAPER-only v2 policy composes all five families while the current v1 policy and default ports stay unchanged', () => {
  const current = JSON.parse(readFileSync(new URL('../config/judge.paper.json', import.meta.url), 'utf8'));
  const v1 = validateJudgePolicy(current);
  assert.equal(v1.ok, true, v1.error);
  assert.deepEqual(strategyRuntimePorts(v1.policy), { setupSelection: null, edgeState: null });
  const v2 = validateJudgePolicy(edgePolicy());
  assert.equal(v2.ok, true, v2.error);
  assert.deepEqual(strategyRuntimePorts(v2.policy), { setupSelection: { version: SETUP_SELECTION_VERSION }, edgeState: EDGE_PORT });
  assert.deepEqual([...new Set(v2.policy.setups.enabled.map(strategyFamilyOf))], STRATEGY_FAMILIES);
  assert.throws(() => createJudge({
    accountId: 'edge-port-alone', policy: { ...v2.policy, policyVersion: 'judge-policy-1' }, policyDigest: 'a'.repeat(64),
    dispatcher: { ev: () => null, onCommit: () => {}, state: () => ({}) }, feed: null,
    clock: { now: () => 1, monotonic: () => 1 }, specOf: () => null, feeOf: () => null,
    enabledSetups: ['MICRO_BITE'], setupSelection: { version: SETUP_SELECTION_VERSION }, edgeState: EDGE_PORT,
  }), /NEW_SETUP_NOT_OPERATIONAL/, 'ports and a strategy label cannot activate EDGE_STATE under a non-v2 policy');
  const live = edgePolicy(); live.mode = 'LIVE'; live.execution.adapter = 'KRAKEN'; live.live = { allocationCeiling: '500', reinvestment: 'NONE', ownerLimits: live.limits, armExpiryMs: 60_000, canaryMaxBuyConsiderationWithFees: null, keyEnv: 'KEY', secretEnv: 'SECRET' };
  const refused = validateJudgePolicy(live);
  assert.equal(refused.ok, false); assert.match(refused.error, /PAPER\/REPLAY only/);
});

test('EDGE-P02. entry-time management is exact and an unfilled position shell cannot be exited by missing post-fill edge evidence', async () => {
  const r = await edgeRig({ dispatch: false });
  const pos = r.state().positions.p1;
  const reason = r.watch.evaluateReasons(pos);
  assert.equal(reason.edge.state, 'UNKNOWN');
  assert.equal(reason.edge.reason, 'ENTRY_NOT_FILLED');
  assert.equal(reason.edge.shouldExit, false);
  assert.equal(reason.primary, null);
  assert.throws(() => r.F.position('bad', 'edge-d1', { maxDurationMs: HARD_MAX_MS, management: { ...pos.management, hardMaxDurationMs: HARD_MAX_MS - 1 } }), /hard maximum differs/);
  assert.throws(() => r.F.position('bad-watch', 'edge-d1', { maxDurationMs: HARD_MAX_MS, management: { ...pos.management, watchVersion: 'watch-paper-edge-state-future' } }), /management.watchVersion: invalid/);
});

test('EDGE-P03. the actual intended-size two-sided walk is the only input to the post-size execution gate', () => {
  const snap = {
    digest: 'e'.repeat(64), bids: [['100', '5'], ['99.9', '5']], asks: [['100.1', '5'], ['100.2', '5']],
  };
  const evaluation = evaluateEntry({ snapshot: snap, q: '0.01', spec: SPEC, fee: TAKER_FEE, atr14: '2', structuralStop: '98', targetPrice: '120' });
  assert.equal(evaluation.status, 'OK', evaluation.reasons?.join(','));
  const facts = executableEdgeFromEvaluation({ setupId: 'MICRO_BITE', evaluation, decisionTs: 1_000 });
  assert.equal(facts.basis, 'UNVALIDATED_SCENARIO_NOT_FORECAST');
  assert.ok(Number(facts.estimatedRemainingEdgeAfterCostsAndRiskBps) > 0);
  assert.equal(evaluateStyleExecutionGate({ setupId: 'MICRO_BITE', executableEdge: facts, decisionTs: 1_000 }).state, 'ELIGIBLE');
  assert.equal(evaluateStyleExecutionGate({ setupId: 'MICRO_BITE', executableEdge: { ...facts, exitDepthSufficient: false }, decisionTs: 1_000 }).state, 'REFUSED');

  const roundedFeeBook = { digest: 'f'.repeat(64), bids: [['100049', '5']], asks: [['100051', '5']] };
  const atMinimum = evaluateEntry({ snapshot: roundedFeeBook, q: SPEC.orderMin, spec: SPEC, fee: ENTRY_FEE, atr14: '127.95651054', structuralStop: '99937.204348946', targetPrice: '101200' });
  assert.equal(atMinimum.status, 'REFUSED'); assert.ok(atMinimum.reasons.includes('REWARD_RISK_BELOW_1_5'));
  const searched = sizeSearch({ snapshot: roundedFeeBook, spec: SPEC, fee: ENTRY_FEE, atr14: '127.95651054', structuralStop: '99937.204348946', targetPrice: '101200', cashAvailable: '500', riskBudget: '5' });
  assert.equal(searched.status, 'OK', JSON.stringify(searched));
  assert.ok(Number(searched.q) > Number(SPEC.orderMin), 'bounded search reaches the viable interval above fixed fee rounding at the minimum lot');
  assert.equal(searched.searchLaw, 'BOUNDED_VERIFIED_GEOMETRIC_NON_MONOTONE');

  const riskBounded = sizeSearch({ snapshot: roundedFeeBook, spec: SPEC, fee: ENTRY_FEE, atr14: '127.95651054', structuralStop: '99937.204348946', targetPrice: '101200', cashAvailable: '500', riskBudget: '0.5' });
  assert.equal(riskBounded.status, 'OK', JSON.stringify(riskBounded));
  assert.ok(Number(riskBounded.evaluation.scenarioStressedLoss) <= 0.5, 'the interior pass remains inside the risk ceiling when upper probes fail');

  const steppedBook = { digest: '1'.repeat(64), bids: [['100049', '0.0005'], ['100048', '0.0005']], asks: [['100051', '0.001'], ['100052', '0.001']] };
  const depthBounded = sizeSearch({ snapshot: steppedBook, spec: SPEC, fee: ENTRY_FEE, atr14: '127.95651054', structuralStop: '99937.204348946', targetPrice: '101200', cashAvailable: '500', riskBudget: '5' });
  assert.equal(depthBounded.status, 'OK', JSON.stringify(depthBounded));
  assert.ok(Number(depthBounded.q) <= 0.0005, 'half-depth scenario steps cap the largest actually verified fallback candidate');

  const none = sizeSearch({ snapshot: roundedFeeBook, spec: SPEC, fee: ENTRY_FEE, atr14: '127.95651054', structuralStop: '99937.204348946', targetPrice: '101200', cashAvailable: '500', riskBudget: '0.001' });
  assert.equal(none.status, 'NO_TRADE_SIZE'); assert.equal(none.reason, 'NO_BOUNDED_FEASIBLE_LOT');
  assert.ok(none.binding.includes('RISK_BUDGET'));
});

test('EDGE-P04. Micro-Bite can remain open beyond 300 seconds on reaccelerating evidence, but the independent operator hard maximum remains mandatory', async () => {
  const r = await edgeRig();
  const pos = r.state().positions.p1;
  r.clock.advance(270_000);
  emitHealthyWindow(r);
  let evaluated = r.watch.evaluateReasons(r.state().positions.p1);
  assert.equal(evaluated.edge.state, 'EDGE_REACCELERATING', JSON.stringify(evaluated.edge));
  assert.equal(evaluated.primary, null, JSON.stringify(evaluated));
  assert.ok(r.clock.now() - pos.firstFillTs > 300_000, 'the 60-300 second Micro intent is not a forced exit timer');

  const toDeadline = pos.firstFillTs + HARD_MAX_MS - r.clock.now() - 2_000;
  r.clock.advance(toDeadline);
  emitHealthyWindow(r, { seconds: 3, advancing: false });
  evaluated = r.watch.evaluateReasons(r.state().positions.p1);
  assert.ok(evaluated.reasons.includes('MAX_DURATION'), JSON.stringify(evaluated));
  assert.equal(evaluated.primary, 'MAX_DURATION', JSON.stringify(evaluated));

  await r.dispatcher.commit(r.F.restriction('KILL'));
  evaluated = r.watch.evaluateReasons(r.state().positions.p1);
  assert.ok(evaluated.reasons.includes('MAX_DURATION'), 'the lower-priority hard maximum remains supported evidence');
  assert.ok(evaluated.reasons.includes('OWNER_KILL'), 'the independently latched owner kill remains visible');
  assert.equal(evaluated.primary, 'OWNER_KILL', 'new edge-state handling cannot outrank or mask an owner kill');
  assert.equal(evaluated.priority, 'P1_KILL_OR_INVALID_PROTECTION');
});

test('EDGE-P05. confirmed distribution/exhaustion exits immediately through the one Watch coordinator, while restart never infers v2 semantics from a setup name', async () => {
  const r = await edgeRig({ setupId: 'MOMENTUM_CONTINUATION' });
  for (let i = 0; i < 31; i += 1) {
    r.clock.advance(1_000);
    const recent = i >= 16;
    r.book(recent ? { ask: 100005, bid: 99975, askQty: 5, bidQty: 0.1 } : { ask: 100010, bid: 99990, askQty: 5, bidQty: 5 });
    r.trade(recent ? { price: 99980, side: 'sell', qty: 0.001 } : { price: 100000, side: 'buy', qty: 0.02 });
  }
  const evaluated = r.watch.evaluateReasons(r.state().positions.p1);
  assert.equal(evaluated.primary, 'DISTRIBUTION_EXHAUSTION', JSON.stringify(evaluated));
  assert.equal(evaluated.priority, 'P2_STRUCTURAL_INVALIDATION');
  await r.settle();
  assert.equal(r.watch.positions()[0].exit.reason, 'DISTRIBUTION_EXHAUSTION');
  for (let i = 0; i < 8 && r.state().positions.p1.state !== 'FLAT'; i += 1) { r.clock.advance(300); r.book({ ask: 100005, bid: 99975, bidQty: 5 }); await r.settle(); }
  assert.equal(r.state().positions.p1.state, 'FLAT');

  const restored = await edgeRig({ accountId: 'edge-restored', restoreWatch: true });
  restored.book();
  const exact = restored.watch.evaluateReasons(restored.state().positions.p1);
  assert.equal(exact.edgeManagement, 'VERIFIED_ENTRY_TIME_V2');
  assert.equal(exact.edge.reason, 'BOOK_OBSERVATION_SUPPORT_INCOMPLETE');
  assert.equal(exact.edge.warmup, false, 'a restart cannot invent a fresh observation grace period');
  assert.equal(exact.primary, 'EDGE_STATE_UNKNOWN');

  const legacy = await edgeRig({ accountId: 'edge-legacy', management: 'OMIT', restoreWatch: true });
  legacy.book();
  const old = legacy.watch.evaluateReasons(legacy.state().positions.p1);
  assert.equal(old.edgeManagement, 'LEGACY');
  assert.equal(old.edge, null);
  assert.equal(old.reasons.includes('EDGE_STATE_UNKNOWN'), false, 'setup name alone never opts an old position into new management');
});

test('EDGE-P06. direct edge classification fails closed on stale or malformed evidence without asserting a forecast', () => {
  const management = edgePositionManagement({ setupId: 'MICRO_BITE', hardMaxDurationMs: HARD_MAX_MS, selectionVersion: SETUP_SELECTION_VERSION });
  const r = evaluatePositionEdgeState({ position: { management, firstFillTs: 1, confirmedBase: '1', soldBase: '0', baseFees: '0' }, tracker: {}, nowTs: 20_000, bookAgeMs: Infinity, spec: SPEC, fee: TAKER_FEE });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.shouldExit, true); assert.equal(r.exitReason, 'EDGE_STATE_UNKNOWN');
});

for (const setupId of ['MOMENTUM_CONTINUATION', 'MICRO_BITE']) test(`EDGE-P07. ${setupId} traverses the real PAPER Judge, post-size gate, durable v2 shell, dispatch, fill, and Watch`, async () => {
  const r = await operationalJudgeRig(setupId);
  const decision = r.judge.decisions().find((row) => row.setupId === setupId && row.status === 'ENTRY_RESERVED');
  assert.ok(decision, JSON.stringify({ decisions: r.judge.decisions(), candidate: r.judge.candidates()[0], status: r.judge.status() }));
  assert.equal(decision.strategyVersion, OPERATIONAL_EDGE_STRATEGY_VERSION);
  assert.ok(decision.measurements.some((row) => row.id === 'EXECUTABLE_BOTH_DIRECTIONS' && row.ok === true));
  const position = Object.values(r.dispatcher.state().positions)[0];
  assert.ok(position, 'one durable position shell');
  assert.equal(position.management.setupId, setupId);
  assert.equal(position.management.managementVersion, 'judge-position-edge-state-1');
  assert.equal(position.management.policyVersion, JUDGE_EDGE_POLICY_VERSION);
  assert.equal(position.management.executionGateVersion, 'judge-post-size-execution-gate-1');
  assert.equal(position.management.watchVersion, EDGE_WATCH_VERSION);
  assert.equal(position.management.hardMaxDurationMs, position.maxDurationMs);
  assert.equal(position.state, 'OPEN');
  assert.equal(position.protection.state, 'ACTIVE');
  assert.equal(r.watch.status().watchVersion, EDGE_WATCH_VERSION);
  const replay = await r.journal.replayVerify(r.accountId); assert.equal(replay.ok, true, replay.reason);
});
