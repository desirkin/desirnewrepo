// RESERVATION SETTLEMENT (2026-09-14) — through the REAL Judge + dispatcher + paper adapter + Watch rig.
// Found during the full read-through: a normally FILLED paper entry left its RESERVATION_OPENED hold OPEN forever, because
// the only settlement paths were pre-send refusals and the restart reconciliation of DISPATCH_UNCERTAIN orders. Effect on a
// USD 500 account after ONE trade: cash 65.96 but availableCash -368.27 (the spent cash was still reserved), the asset stayed
// "held" after FLAT and the slot never returned. Every later entry refused CASH_INSUFFICIENT / ASSET_ALREADY_HELD.
// The dispatcher now settles the hold exactly once when the venue reports the entry order terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createJudge } from '../judge/judge.js';
import { createWatch } from '../watch/watch.js';
import { createScheduler } from '../judge/scheduler.js';
import { loadJudgePolicy } from '../judge/policy.js';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import { JUDGE_FACT_RECIPE_VERSION } from '../judge/learning-intake.js';
import { eventsFor, fakeClock, SPEC, T0 } from './helpers/judge.js';
import { availableCash, slotsUsed } from '../execution/reducer.js';
import * as M from '../execution/money.js';
import { feeContract } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';

const POLICY = loadJudgePolicy(path.resolve('judge/samples/policy.paper-reference.json'));
const TEST_FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'synthetic-test-fee', observedTs: T0 });
const KILL = { state: 'ARMED', reason: null, ts: T0 };
const APPLIC = { clauses: [{ feature: 'rv60', op: 'GTE', threshold: 0 }] };
const DAY = 86_400_000;
const fmt = (v, d) => v.toFixed(d).replace('.', '').replace(/^0+/, ''); const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([p, q]) => fmt(p, 1) + fmt(q, 8)).join(''));
function bars({ n = 61, endTs, close = 100000, range = 400, wickAt = 41, wickLow = 96000 } = {}) { const out = []; for (let i = 0; i < n; i += 1) out.push({ periodStartTs: endTs - (n - i) * 60_000, periodEndTs: endTs - (n - i - 1) * 60_000, open: close, high: close + range / 2, low: i === wickAt ? wickLow : close - range / 2, close, volumeQuote: 1000, volumeBase: 0.01, closed: true }); return out; }

function validated({ maxSizeUsd = null, adjust = 0.05 } = {}) {
  const pub = buildActivation({ candidateId: 'lcand-e2e', patternId: 'lpat-e2e', trainingCutoffTs: T0 - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: 0.1, adjust, scope: { setupType: 'RANGE_IGNITION', regime: 'ANY' }, validation: { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 0.4 }, maxSizeUsd, featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyVersion: POLICY.digest, applicability: APPLIC, effectiveTs: T0, expiresTs: T0 + 30 * DAY, ts: T0 });
  return transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T0 });
}
const snapOf = (activations, { preparedTs = T0 + 24 * 60_000, kill = KILL } = {}) => ({ view: 'DECISION', preparedTs, activations, kill });

async function rig({ accountId, learning = null, dynamicSizing = null, caseSource = null, clock = fakeClock() } = {}) {
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' }); const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now()); const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: TEST_FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) }; const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC }); await dispatcher.load(); await dispatcher.commit(F.init({ accountKind: 'PAPER' }));
  const scheduler = createScheduler({ monotonic: clock.monotonic }); const hist = { bars: (symbol, nowTs) => bars({ endTs: Math.floor(nowTs / 60_000) * 60_000 }) };
  const judge = createJudge({ accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TEST_FEE, history: hist, caseSource: caseSource ?? { consumed: () => null }, controls: () => ({ kill: false, cage: false, vetoes: [] }), scheduler, mode: 'PAPER', learning, dynamicSizing });
  const watch = createWatch({ accountId, dispatcher, adapter, feed, clock: pclock, specOf: () => SPEC, feeOf: () => TEST_FEE, controls: () => ({ kill: false, cage: false }) });
  judge.admit('XBT/USD', { assetId: 'BTC', source: 'TEST' }); feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'XBT/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now()); feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'XBT/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tid = 0; const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side, price, qty, ord_type: 'market', trade_id: ++tid, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); await watch.onTick(clock.now()); await dispatcher.idle(); };
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now()); const adv = (ms) => { for (let t = 0; t < ms; t += 1000) { clock.advance(Math.min(1000, ms - t)); heartbeat(); } };
  async function warm({ minutes = 22, price = 100000 } = {}) { book([[price + 10, 5]], [[price - 10, 5]], 'snapshot'); for (let m = 0; m < minutes; m += 1) { for (let k = 0; k < 4; k += 1) { adv(15_000); trade(price + 1, 'buy'); trade(price - 1, 'sell'); book([[price + 10, 5]], [[price - 10, 5]]); } } await settle(); }
  async function ignite({ price = 100000, level = 100400, books = 3, spanMs = 2100 } = {}) { const start = Math.floor(clock.now() / 60_000) * 60_000 + 60_000; while (clock.now() < start) { adv(Math.min(1000, start - clock.now())); } for (let k = 0; k < 20; k += 1) { adv(2000); trade(price + 50, 'buy', 0.2); } if (clock.now() % 60_000 !== 0) adv(60_000 - clock.now() % 60_000); clock.advance(500); for (let i = 0; i < books; i += 1) { book([[level + 20, 5], [level + 30, 5]], [[level, 5], [level - 10, 5]]); trade(level + 10, 'buy', 0.1); await settle(); if (i < books - 1) clock.advance(Math.ceil(spanMs / (books - 1))); } await settle(); }
  async function fill({ level = 100400 } = {}) { clock.advance(300); book([[level + 20, 5]], [[level, 5]]); await settle(); }
  return { clock, journal, F, feed, adapter, dispatcher, judge, watch, scheduler, book, trade, settle, warm, ignite, fill, state: () => dispatcher.state() };
}
const reserved = (r) => r.judge.decisions().find((d) => d.status === 'ENTRY_RESERVED');

test('RESERVATION SETTLEMENT (2026-09-14). a normally FILLED paper entry consumes its hold exactly once: no double-debited cash, the slot and asset free on FLAT, and a second hold on the same asset opens', async () => {
  const r = await rig({ accountId: 'repro-res' }); await r.warm(); await r.ignite(); await r.fill();
  const d = reserved(r); assert.ok(d, 'a decision reserved');
  const s = r.state();
  const pos = Object.values(s.positions)[0]; assert.ok(pos && pos.state === 'OPEN', `position OPEN: ${JSON.stringify(Object.values(s.orders).map((o) => [o.orderId, o.state]))}`);
  const entry = Object.values(s.orders).find((o) => o.kind === 'ENTRY'); assert.equal(entry.state, 'FILLED');
  const res = Object.values(s.reservations)[0];
  console.log(JSON.stringify({ reservationState: res.state, cashReserved: res.cashReserved, cash: s.cash, availableCash: availableCash(s), slotsUsed: slotsUsed(s), filledQuote: entry.filledQuote, feesQuote: entry.feesQuote }));
  assert.equal(res.state, 'CONSUMED', 'the reservation is CONSUMED exactly once when its entry order is terminal');
  assert.equal(availableCash(s), s.cash, 'no double debit: available cash equals cash once the hold is consumed');
  // the position stops out -> FLAT -> the slot and asset are free and a SECOND entry on the same asset can reserve again
  const stop = Math.floor(Number(pos.structuralStop)); // integer prices keep the synthetic checksum exact
  const advance = async (ms, step = 250) => { for (let t = 0; t < ms; t += step) { r.clock.advance(Math.min(step, ms - t)); r.book([[stop + 10, 5]], [[stop - 2, 50]]); await r.settle(); } };
  r.clock.advance(100); r.trade(stop - 1, 'sell'); r.clock.advance(50); await r.settle();
  assert.equal(r.state().positions[pos.positionId].protection.state, 'TRIGGERED');
  r.clock.advance(300); r.book([[stop + 10, 5]], [[stop - 2, 50]]); await r.settle(); await advance(300);
  let s2 = r.state(); let pos2 = s2.positions[pos.positionId];
  if (pos2.state !== 'FLAT') { r.clock.advance(300); r.book([[stop + 10, 5]], [[stop - 2, 50]]); await r.settle(); await advance(2000); s2 = r.state(); pos2 = s2.positions[pos.positionId]; }
  assert.equal(pos2.state, 'FLAT', `position exits after the stop: ${JSON.stringify(Object.values(s2.orders).map((o) => [o.kind, o.state, o.reason]))} exit=${JSON.stringify(r.watch.positions()[0]?.exit)} restrictions=${JSON.stringify(Object.keys(s2.restrictions))}`);
  assert.equal(slotsUsed(s2), 0, 'the slot is free once FLAT and the hold is settled');
  assert.equal(availableCash(s2), s2.cash);
  // a SECOND hold on the same asset is admitted by the reducer once the first is consumed and the position is FLAT
  // (before the fix this refused ASSET_ALREADY_HELD / CASH_INSUFFICIENT because the stale OPEN hold still counted)
  await r.dispatcher.commit([r.F.hypothesis('d-second', { assetId: 'BTC', pair: 'XBT/USD' }), r.F.decision('d-second', { assetId: 'BTC', pair: 'XBT/USD', sizing: { q: '0.0004', entryLimitPrice: '100000', entryCashOut: '41', riskUsd: '2', bufferedScenarioNetProfit: '1' } }), r.F.reserve('r-second', 'd-second', { assetId: 'BTC', pair: 'XBT/USD', cashReserved: '41', riskReserved: '2' })]);
  const s3 = r.state(); const holds = Object.values(s3.reservations).map((h) => h.state);
  assert.deepEqual(holds, ['CONSUMED', 'OPEN'], 'the first hold is consumed exactly once; a second hold on the same asset opens after FLAT');
  assert.equal(availableCash(s3), M.sub(s3.cash, '41'));
});
