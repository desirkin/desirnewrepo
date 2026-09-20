// PUBLISH-FIX-83 — full review items 7, 8, 10, 12 (the rulers) and the feed's liveness law. Nothing here reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flowImbalance, relativeVolume60, bidDepthWithinBps, FI_MIN_TRADES, RV60_COVERAGE_LAG_MS, BAR_MS } from '../judge/features.js';
import { createExecutionFeed } from '../execution/feed.js';

const T = Date.UTC(2026, 8, 19, 12);
const trade = ({ eventTs, receiptTs = eventTs, side = 'buy', quoteNotional = '100', id = `t-${eventTs}-${side}-${quoteNotional}` }) => ({ tradeVersion: 'execution-trade-1', symbol: 'XBT/USD', canonicalCoin: 'BTC', feedEpoch: 1, receiptSequence: Math.max(1, eventTs - (T - 60 * BAR_MS)), nativeTradeId: id, side, price: '1', qty: quoteNotional, quoteNotional, eventTs, receiptTs, fromSubscriptionSnapshot: false });

test('FIX83-7. RV60 measures the TRAILING 60 s ending at the decision, so the burst that caused the crossing is the numerator (it used to be the empty minute before it)', () => {
  const D = T + 20_000; // 20 s into the minute
  const rows = []; for (let k = 1; k <= 21; k += 1) rows.push(trade({ eventTs: D - k * BAR_MS - 5_000, quoteNotional: '100' })); // one quiet print per trailing baseline window
  for (let i = 0; i < 5; i += 1) rows.push(trade({ eventTs: T + 2_000 + i * 1_000, quoteNotional: '200' })); // the ignition: 5 prints in [E, D)
  const coverage = { continuous: true, epoch: 1, startTs: D - 25 * BAR_MS, endTs: D - 1000, gapTs: null };
  const r = relativeVolume60(rows, D, coverage); assert.equal(r.state, 'KNOWN', JSON.stringify(r)); assert.equal(r.window, 'TRAILING'); assert.equal(r.E, D);
  assert.equal(r.numerator, '1000', 'the ignition prints inside [D-60s, D) are the numerator'); assert.equal(r.numeratorCount, 5); assert.equal(r.baseline, '100'); assert.equal(r.rv60, 10);
  // the old completed-minute law would have read the minute BEFORE the move: exactly one quiet print -> rv60 1 (asserted as the counterfactual)
  const E = Math.floor(D / BAR_MS) * BAR_MS; const inLastCompleteMinute = rows.filter((t) => t.eventTs >= E - BAR_MS && t.eventTs < E); assert.equal(inLastCompleteMinute.length, 1);
  // coverage may end a few seconds before D (the feed's coverage clock ends at its last message), never more than the lag allowance
  assert.equal(relativeVolume60(rows, D, { ...coverage, endTs: D - RV60_COVERAGE_LAG_MS }).state, 'KNOWN'); assert.equal(relativeVolume60(rows, D, { ...coverage, endTs: D - RV60_COVERAGE_LAG_MS - 1 }).reason, 'COVERAGE_INCOMPLETE');
  assert.equal(relativeVolume60(rows, D, { ...coverage, startTs: D - 21 * BAR_MS + 1 }).reason, 'COVERAGE_INCOMPLETE', '21 minutes of continuous coverage before D are still required');
});

test('FIX83-8. flow imbalance below the trade-count floor widens its window (x2, x4, up to the cap) and is UNKNOWN TOO_FEW_TRADES when even the widest window is thin; the reading carries count / windowMs / widened', () => {
  const D = T; const rows = [trade({ eventTs: D - 3_000, side: 'sell', quoteNotional: '3' })]; // ONE $3 taker sell in the last 15 s
  const plain = flowImbalance(rows, D - 15_000, D, { asOfTs: D, feedEpoch: 1 }); assert.equal(plain.state, 'KNOWN'); assert.equal(plain.fi, -1, 'without the floor the old coin flip: one print reads -1');
  const floored = flowImbalance(rows, D - 15_000, D, { asOfTs: D, feedEpoch: 1, minTrades: FI_MIN_TRADES, maxWindowMs: 60_000 });
  assert.equal(floored.state, 'UNKNOWN'); assert.equal(floored.reason, 'TOO_FEW_TRADES'); assert.equal(floored.count, 1); assert.equal(floored.windowMs, 60_000); assert.equal(floored.widened, true); assert.equal(floored.minTrades, FI_MIN_TRADES);
  // enough prints inside 30 s: the window widens once (15 -> 30 s) and reads the real balance of those prints
  for (let i = 0; i < 7; i += 1) rows.push(trade({ eventTs: D - 16_000 - i * 1_500, side: 'buy', quoteNotional: '10' }));
  const widened = flowImbalance(rows, D - 15_000, D, { asOfTs: D, feedEpoch: 1, minTrades: FI_MIN_TRADES, maxWindowMs: 60_000 });
  assert.equal(widened.state, 'KNOWN'); assert.equal(widened.windowMs, 30_000); assert.equal(widened.widened, true); assert.equal(widened.count, 8); assert.equal(widened.startTs, D - 30_000); assert.ok(widened.fi > 0.9, `buying dominates once the window holds real prints: ${widened.fi}`);
  // enough prints inside the base window: nothing widens
  const rich = []; for (let i = 0; i < 10; i += 1) rich.push(trade({ eventTs: D - 1_000 - i * 1_000, side: i % 2 ? 'sell' : 'buy', quoteNotional: '10' }));
  const base = flowImbalance(rich, D - 15_000, D, { asOfTs: D, feedEpoch: 1, minTrades: FI_MIN_TRADES, maxWindowMs: 60_000 }); assert.equal(base.widened, false); assert.equal(base.windowMs, 15_000); assert.equal(base.count, 10); assert.equal(base.fi, 0);
  // a widened window still respects the as-of clock (a print received after D is not evidence)
  rows.push(trade({ eventTs: D - 20_000, receiptTs: D + 1, side: 'sell', quoteNotional: '1000', id: 'future' })); assert.equal(flowImbalance(rows, D - 15_000, D, { asOfTs: D, feedEpoch: 1, minTrades: FI_MIN_TRADES, maxWindowMs: 60_000 }).count, 8);
});

test('FIX83-10. a receipt gap is only SUSPECTED: a >5 s processing stall whose messages carry a continuous venue clock is absorbed; real silence (venue clock jumped, or no timestamped message for another window) breaks coverage where messages resumed', () => {
  const feed = createExecutionFeed({ clock: () => T }); feed.admit('XBT/USD', { priority: 'CANDIDATE' }); feed.onConnect(T - 60_000);
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), T - 60_000);
  const tradeMsg = (ts, receipt = ts) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side: 'buy', price: '1', qty: '1', ord_type: 'market', trade_id: ts, timestamp: new Date(ts).toISOString() }] }), receipt);
  const hb = (receipt) => feed.ingest(JSON.stringify({ channel: 'heartbeat' }), receipt);
  for (let t = T - 59_000; t <= T - 10_000; t += 1000) { hb(t); if (t % 5000 === 0) tradeMsg(t); }
  const startBefore = feed.coverage('XBT/USD', T - 10_000).startTs; assert.equal(startBefore, T - 60_000);
  // a 7 s main-thread stall: the venue kept sending; its messages are processed together at T-3000 with venue clocks 1 s apart
  for (let k = 9; k >= 3; k -= 1) tradeMsg(T - k * 1000, T - 3000);
  assert.equal(feed.coverage('XBT/USD', T).startTs, T - 60_000, 'coverage survives the stall'); assert.equal(feed.status().counters.stallsAbsorbed, 1); assert.equal(feed.status().counters.gapsSuspected, 1); assert.equal(feed.status().counters.coverageGaps, 0);
  // real silence: nothing for 8 s, then a trade whose venue clock also jumped 8 s -> the coverage restarts where messages resumed
  tradeMsg(T + 6_000, T + 6_000); assert.equal(feed.status().counters.coverageGaps, 1); assert.equal(feed.coverage('XBT/USD', T + 6_000).startTs, T + 6_000);
  // silence followed only by heartbeats: suspected, then confirmed after another impaired window with no venue clock to vouch
  for (let t = T + 7_000; t <= T + 10_000; t += 1000) hb(t); hb(T + 20_000); assert.equal(feed.status().counters.coverageGaps, 1, 'suspected, not yet broken'); hb(T + 26_000); assert.equal(feed.status().counters.coverageGaps, 2, 'confirmed silence'); assert.equal(feed.coverage('XBT/USD', T + 26_000).startTs, T + 20_000);
});

test('FIX83-12. the 10 bps liquidity band is measured from the best bid, not the mid: a 30 bps spread no longer reads zero bid liquidity', () => {
  const snap = { bids: [['99700', '2'], ['99650', '3']], asks: [['100000', '1']] }; // spread 30 bps
  const depth = bidDepthWithinBps(snap, 10); assert.equal(depth, '498350', 'both bids inside 10 bps of the best bid count'); // 99700*2 + 99650*3 (99650 >= 99700*0.999 = 99600.3)
  const wide = { bids: [['99700', '2'], ['99500', '3']], asks: [['100000', '1']] }; assert.equal(bidDepthWithinBps(wide, 10), '199400', 'a bid 20 bps under the best bid is outside the band');
  assert.equal(bidDepthWithinBps({ bids: [], asks: [['1', '1']] }, 10), null);
});

test('FIX83-27. a book / trade message that names no admitted symbol is not lexeme-parsed (skipped on a substring check), yet its venue clock still vouches for liveness', () => {
  const feed = createExecutionFeed({ clock: () => T }); feed.admit('XBT/USD', { priority: 'CANDIDATE' }); feed.onConnect(T - 60_000);
  feed.ingest(JSON.stringify({ method: 'subscribe', success: true, result: { channel: 'trade', symbol: 'XBT/USD' } }), T - 60_000);
  const other = (ts, receipt = ts) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'ETH/USD', side: 'buy', price: '1', qty: '1', ord_type: 'market', trade_id: ts, timestamp: new Date(ts).toISOString() }] }), receipt);
  const mine = (ts, receipt = ts) => feed.ingest(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'XBT/USD', side: 'buy', price: '1', qty: '1', ord_type: 'market', trade_id: ts, timestamp: new Date(ts).toISOString() }] }), receipt);
  for (let t = T - 59_000; t <= T - 10_000; t += 1000) other(t);
  assert.equal(feed.status().counters.skippedParse, 50); assert.equal(feed.status().counters.trades, 0, 'nothing applied for a symbol nobody holds');
  mine(T - 9_000); assert.equal(feed.status().counters.trades, 1, 'the admitted symbol is parsed and applied');
  // a 7 s stall vouched for only by ETH prints (never admitted): coverage survives
  for (let k = 8; k >= 2; k -= 1) other(T - k * 1000, T - 2000);
  assert.equal(feed.status().counters.stallsAbsorbed, 1); assert.equal(feed.status().counters.coverageGaps, 0); assert.equal(feed.coverage('XBT/USD', T).startTs, T - 60_000);
});
