// PAPER BITE DRILL (PUBLISH-FIX-84, 2026-09-20 — the owner: "every day you tell me it's green and every day it hasn't been fixed").
// 420 test files proved every part; none asked the only question the owner has: given a clean, textbook setup, does the whole
// animal BUY under the PRODUCTION paper policy (config/judge.paper.starting-styles-fee080.json: USD 500, 0.80% taker each way (Kraken Pro Tier 1, PUBLISH-FIX-87),
// 3% risk budget)? This drill feeds the real Judge, real cost law, real dispatcher and paper adapter a textbook RANGE_IGNITION on a
// synthetic pair — 22 minutes of two-sided prints inside a range, then a burst of buying, then a clean break above the range
// with a fillable book — and demands an ENTRY. When it cannot, it prints every decision's status and reasons so the rule that
// stops even a perfect setup is named. It runs under the reference policy too (the fixture the other suites use) as the control.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMemoryJournal } from '../execution/journal.js';
import { createDispatcher } from '../execution/dispatcher.js';
import { createPaperAdapter } from '../execution/paper-adapter.js';
import { createExecutionFeed } from '../execution/feed.js';
import { createJudge } from '../judge/judge.js';
import { createScheduler } from '../judge/scheduler.js';
import { loadJudgePolicy, strategyRuntimePorts } from '../judge/policy.js';
import { feeContract, instrumentSpec } from '../execution/contract.js';
import { crc32 } from '../lib/crc32.js';
import { eventsFor, fakeClock, T0 } from './helpers/judge.js';

const MIN = 60_000;
const SPEC = instrumentSpec({ venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'BTC/USD', base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online', priceIncrement: '0.1', qtyIncrement: '0.00000001', orderMin: '0.00005', costMin: '0.5', priceDecimals: 1, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE' });
const feeAt = (rate) => feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate, rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'bite-drill', observedTs: T0 });
const fmt = (value, decimals) => value.toFixed(decimals).replace('.', '').replace(/^0+/, '');
const crcFor = (asks, bids) => crc32([...asks.slice(0, 10), ...bids.slice(0, 10)].map(([price, qty]) => fmt(price, 1) + fmt(qty, 8)).join(''));
// the 20-bar range: one deep bar 41 minutes back sets l20; RANGE_IGNITION's target is h20 + (h20 - l20), so `rangeDip` is the measured move
const bars = (endTs, close = 100000, rangeDip = 4000) => Array.from({ length: 61 }, (_, index) => ({ periodStartTs: endTs - (61 - index) * MIN, periodEndTs: endTs - (60 - index) * MIN, open: close, high: close + 200, low: index === 41 ? close - rangeDip : close - 200, close, volumeQuote: 1000, volumeBase: 0.01, closed: true }));

async function rig({ policyFile, feeRate, limits = null, logs = [], production = false, rangeDip = 4000 }) {
  const POLICY = loadJudgePolicy(path.resolve(policyFile)); const FEE = feeAt(feeRate);
  const accountId = `bite-drill-${Math.random().toString(36).slice(2)}`; const clock = fakeClock();
  const journal = createMemoryJournal(); await journal.create(accountId, { accountKind: 'PAPER' });
  const writer = await journal.acquireWriter(accountId); const F = eventsFor(accountId, clock);
  const feed = createExecutionFeed({ clock: clock.now }); feed.onConnect(clock.now());
  const adapter = createPaperAdapter({ accountId, clock: clock.now, feed, fee: FEE, specOf: () => SPEC });
  const pclock = { now: clock.now, monotonic: clock.monotonic, status: () => ({ trusted: true }) };
  const dispatcher = createDispatcher({ accountId, journal, writer, adapter, clock: pclock, specOf: () => SPEC });
  await dispatcher.load(); await dispatcher.commit(F.init({ initialCapital: '500', ...(limits ? { limits } : {}) }));
  const scheduler = createScheduler({ monotonic: clock.monotonic });
  // exactly as fly.js composes the paper run: the strategy ports come from the policy; PAPER sizing is the risk-bounded ladder
  const ports = strategyRuntimePorts(POLICY.policy); const paperSizing = { fractions: ['0.25', '0.5', '0.75', '1'], allInEvidence: 'RISK_BOUNDED' };
  const judge = createJudge({ accountId, policy: POLICY.policy, policyDigest: POLICY.digest, dispatcher, feed, clock: pclock, specOf: () => SPEC, feeOf: () => FEE, history: { bars: (symbol, nowTs) => bars(Math.floor(nowTs / MIN) * MIN, 100000, rangeDip) }, caseSource: { consumed: () => null }, controls: () => ({ kill: false, cage: false, vetoes: [] }), scheduler, mode: 'PAPER', log: (m) => logs.push(String(m)), dynamicSizing: production ? paperSizing : null, setupSelection: ports.setupSelection, edgeState: ports.edgeState });
  judge.admit('BTC/USD', { assetId: 'BTC', source: 'TEST' });
  feed.ingest(JSON.stringify({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } }), clock.now());
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'BTC/USD' } }), clock.now());
  const book = (asks, bids, type = 'snapshot') => feed.ingest(JSON.stringify({ channel: 'book', type, data: [{ symbol: 'BTC/USD', asks: asks.map(([price, qty]) => ({ price, qty })), bids: bids.map(([price, qty]) => ({ price, qty })), checksum: crcFor(asks, bids), timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  let tradeId = 0;
  const trade = (price, side = 'buy', qty = 0.05) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side, price, qty, ord_type: 'market', trade_id: ++tradeId, timestamp: new Date(clock.now()).toISOString() }] }), clock.now());
  const heartbeat = () => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), clock.now());
  const advance = (ms) => { for (let elapsed = 0; elapsed < ms; elapsed += 1000) { clock.advance(Math.min(1000, ms - elapsed)); heartbeat(); } };
  const settle = async () => { await judge.onTick(clock.now()); await scheduler.drain(); await dispatcher.idle(); };
  // the textbook: a two-sided range for 22 minutes, a burst of buying, then a clean break with a fillable book on both sides
  async function textbook({ finalDepth = 5 } = {}) {
    book([[100010, 5]], [[99990, 5]], 'snapshot');
    for (let minute = 0; minute < 22; minute += 1) for (let part = 0; part < 4; part += 1) { advance(15_000); trade(100001, 'buy'); trade(99999, 'sell'); book([[100010, 5]], [[99990, 5]]); }
    await settle();
    const start = Math.floor(clock.now() / MIN) * MIN + MIN; while (clock.now() < start) advance(Math.min(1000, start - clock.now()));
    for (let index = 0; index < 20; index += 1) { advance(2000); trade(100050, 'buy', 0.2); }
    while (clock.now() % MIN !== 0) advance(1000); clock.advance(500);
    for (let index = 0; index < 3; index += 1) { book([[100420, finalDepth], [100430, finalDepth]], [[100400, finalDepth], [100390, finalDepth]]); trade(100410, 'buy', 0.1); await settle(); if (index < 2) clock.advance(1050); }
    await settle();
  }
  const report = () => judge.decisions().map((d) => `${new Date(d.decisionKnownAtTs).toISOString().slice(11, 19)} ${d.setupId} ${d.status} [${(d.reasonCodes ?? []).join(', ')}]${d.sizing ? ` size q=${d.sizing.q} cashOut=${d.sizing.entryCashOut}` : ''}`).join('\n');
  return { judge, dispatcher, textbook, report, logs };
}
const ENTRY = new Set(['ENTRY_PROPOSED', 'ENTRY_RESERVED']);

test('BITE-0 (control). under the reference policy fixture the textbook setup ends in an ENTRY — the drill itself works', async () => {
  const r = await rig({ policyFile: 'judge/samples/policy.paper-reference.json', feeRate: '0.001' });
  await r.textbook();
  assert.ok(r.judge.decisions().some((d) => ENTRY.has(d.status)), `no entry under the reference fixture:\n${r.report()}`);
});

test('BITE-1 (the owner\'s question). under the PRODUCTION paper policy (USD 500, 0.80% taker each way — Kraken Pro Tier 1, the real fee for a $500 account buying at market) a textbook setup whose measured move is ~6% ends in an ENTRY; if it cannot, the rule that refuses it is named here', async () => {
  const r = await rig({ policyFile: 'config/judge.paper.starting-styles-fee080.json', feeRate: '0.008', production: true, rangeDip: 6000 });
  await r.textbook();
  const entry = r.judge.decisions().find((d) => ENTRY.has(d.status));
  console.log(`BITE DRILL (production policy, 0.80%/side, ~6% measured move) decisions:\n${r.report()}\nCLOSE CALLS:\n${r.logs.filter((l) => l.startsWith('CLOSE CALL')).join('\n')}`);
  assert.ok(entry, `NO BITE under the production policy. Every decision:\n${r.report()}\n\nCLOSE CALL lines:\n${r.logs.filter((l) => l.startsWith('CLOSE CALL')).join('\n') || '(none)'}`);
  assert.ok(Number(entry.sizing?.entryCashOut) > 0 && Number(entry.sizing?.entryCashOut) <= 500, `a real size inside the account: ${JSON.stringify(entry.sizing)}`);
});

test('BITE-2 (what the real fee costs). the SAME textbook with a ~4% measured move buys at 0.40% a side and is refused at 0.80% a side — REWARD_RISK_BELOW_1_5 — so at Kraken Tier 1 a setup needs roughly a 5%+ measured move against a 0.6% stop before the Judge can size it', async () => {
  const cheap = await rig({ policyFile: 'config/judge.paper.starting-styles-fee080.json', feeRate: '0.004', production: true, rangeDip: 4000 });
  await cheap.textbook();
  assert.ok(cheap.judge.decisions().some((d) => ENTRY.has(d.status)), `at 0.40%/side the 4% move buys:\n${cheap.report()}`);
  const real = await rig({ policyFile: 'config/judge.paper.starting-styles-fee080.json', feeRate: '0.008', production: true, rangeDip: 4000 });
  await real.textbook();
  assert.ok(!real.judge.decisions().some((d) => ENTRY.has(d.status)), 'at 0.80%/side the same 4% move does not size');
  const call = real.logs.find((l) => l.startsWith('CLOSE CALL') && l.includes('RANGE_IGNITION'));
  assert.ok(call, `the refusal is a CLOSE CALL, named:\n${real.logs.filter((l) => l.startsWith('CLOSE CALL')).join('\n')}`);
  console.log(`BITE-2 at 0.80%/side, 4% move: ${call}`);
});
