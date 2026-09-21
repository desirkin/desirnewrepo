// PUBLISH-FIX-111 (2026-09-21). The flow windows were the main thread.
//
// Production 2b2047d0 at 04:19, the sampled minute at 100% busy, twenty candidates on the stage:
//     CPU PROFILE 60s: busy 60026ms idle 178ms · top: cmp 13% · parseDecimal 8% · (garbage collector) 7% · fromNumberLexeme 6%
//                      · canonicalJson 6% · windowFacts 5% · parseDecimalUncached 4% · onBook 3% · parseLexemes 3%
// and the consequences, in the same minutes:
//     re-armed after an infrastructure refusal: NEAR/USD ... (hypothesis lock not durable within 10 s)   x6
//     RESOURCE_WARNING heap=737MB lag=3101ms (LAG_SUSTAINED) — shedding 7 ... ZETA RARI UAI NIL CFG CELR PTB
//
// Every window query scanned the WHOLE retained trade array (25 minutes of prints) to find a 15-second window — twice, with
// decimal-string arithmetic per print — up to four times a second per candidate. The cost rose with the trade rate: the
// Judge was slowest on exactly the coins that were running.
//
// The fix is a lower bound, and it is EXACT: validTradeClock (enforced at insertion) guarantees eventTs <= receiptTs, so any
// print inside [startTs, endTs) by eventTs has receiptTs >= startTs; the tracker's array is in receipt order; so a binary
// search on receiptTs skips only prints that could never be in the window. The tracker turns the hint off for good the moment a
// print arrives out of receipt order. A plain array without the hint is scanned from the start exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowTracker, flowImbalance, vwap, windowNotional, relativeVolume60 } from '../judge/features.js';

const T0 = 1_789_000_000_000; const MIN = 60_000;
// deterministic pseudo-random prints across 25 minutes, receipt a few ms after event, mixed sides
function makeTrades(n, seed = 7) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const eventTs = T0 + Math.floor(rnd() * 25 * MIN); const receiptTs = eventTs + Math.floor(rnd() * 40);
    out.push({ fromSubscriptionSnapshot: false, feedEpoch: 3, eventTs, receiptTs, nativeTradeId: `t${i}`, side: rnd() < 0.5 ? 'buy' : 'sell', price: '1.5', qty: (1 + rnd() * 10).toFixed(4), quoteNotional: (1.5 * (1 + rnd() * 10)).toFixed(6) });
  }
  return out.sort((a, b) => a.receiptTs - b.receiptTs || a.eventTs - b.eventTs); // receipt order, as the feed delivers
}
const D = T0 + 25 * MIN;

test('FIX111-1: the bounded scan returns EXACTLY what the full scan returns, window for window', () => {
  const trades = makeTrades(6000);
  const cov = { continuous: true, startTs: T0 - MIN, endTs: D, gapTs: null, epoch: 3 };
  for (const [s, e] of [[D - 15_000, D], [D - 60_000, D], [D - 75_000, D - 15_000], [D - 3 * MIN, D - MIN], [T0 + MIN, T0 + 2 * MIN]]) {
    const full = flowImbalance(trades, s, e, { asOfTs: D, feedEpoch: 3 });
    const fast = flowImbalance(trades, s, e, { asOfTs: D, feedEpoch: 3, sortedByReceipt: true });
    assert.deepEqual(fast, full, `flowImbalance [${s - T0}, ${e - T0})`);
    assert.deepEqual(vwap(trades, s, e, { asOfTs: D, feedEpoch: 3, sortedByReceipt: true }), vwap(trades, s, e, { asOfTs: D, feedEpoch: 3 }), 'vwap');
    assert.deepEqual(windowNotional(trades, s, e, { asOfTs: D, feedEpoch: 3, sortedByReceipt: true }), windowNotional(trades, s, e, { asOfTs: D, feedEpoch: 3 }), 'notional');
  }
  assert.deepEqual(relativeVolume60(trades, D, { ...cov, sortedByReceipt: true }), relativeVolume60(trades, D, cov), 'rv60, all twenty-one windows');
});

test('FIX111-2: the tracker passes the hint, and every reading matches a hint-less computation over its own prints', () => {
  const tr = createFlowTracker({ retentionMs: 25 * MIN });
  const trades = makeTrades(4000, 11); for (const t of trades) tr.add(t);
  assert.equal(tr.status().sortedByReceipt, true); assert.equal(tr.status().disorder, 0);
  const own = tr.snapshot();
  assert.deepEqual(tr.fi(D - 15_000, D), flowImbalance(own, D - 15_000, D, { asOfTs: D, feedEpoch: 3 }));
  assert.deepEqual(tr.fi(D - 60_000, D, { minTrades: 6, maxWindowMs: 4 * MIN }), flowImbalance(own, D - 60_000, D, { asOfTs: D, feedEpoch: 3, minTrades: 6, maxWindowMs: 4 * MIN }), 'a widened window (PUBLISH-FIX-83 item 8) is bounded correctly for its WIDEST start');
  assert.deepEqual(tr.vwap(D - 60_000, D), vwap(own, D - 60_000, D, { asOfTs: D, feedEpoch: 3 }));
  assert.deepEqual(tr.window(D - 3 * MIN, D), own.filter((t) => t.eventTs >= D - 3 * MIN && t.eventTs < D && t.receiptTs <= D));
});

test('FIX111-3: a print out of receipt order turns the hint OFF for good — correctness first', () => {
  const tr = createFlowTracker({ retentionMs: 25 * MIN });
  const trades = makeTrades(500, 5); for (const t of trades) tr.add(t);
  assert.equal(tr.status().sortedByReceipt, true);
  // a late print whose receipt clock is EARLIER than the last one seen
  const late = { ...trades[10], nativeTradeId: 'late-1', receiptTs: trades[10].receiptTs, eventTs: trades[10].eventTs };
  assert.equal(tr.add(late), true);
  assert.equal(tr.status().sortedByReceipt, false); assert.equal(tr.status().disorder, 1);
  // and from then on every reading is the plain full scan, still correct
  const own = tr.snapshot();
  assert.deepEqual(tr.fi(D - 60_000, D), flowImbalance(own, D - 60_000, D, { asOfTs: D, feedEpoch: 3 }));
});

test('FIX111-4: an epoch change restarts the order — the hint comes back with the fresh array', () => {
  const tr = createFlowTracker({ retentionMs: 25 * MIN });
  for (const t of makeTrades(200, 9)) tr.add(t);
  assert.equal(tr.add({ ...makeTrades(1, 21)[0], nativeTradeId: 'dis', eventTs: T0, receiptTs: T0 }), true); // disorder: receipt clock earlier than the last
  assert.equal(tr.status().sortedByReceipt, false);
  tr.add({ ...makeTrades(1, 22)[0], nativeTradeId: 'e4', feedEpoch: 4, receiptTs: D + 1000, eventTs: D + 999 }); // new epoch clears
  assert.equal(tr.status().epochChanges, 1); assert.equal(tr.status().sortedByReceipt, true);
});

test('FIX111-5: it is actually faster — a 15-second window over 25 minutes of prints no longer costs the whole array', () => {
  const trades = makeTrades(40_000, 13);
  const time = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < 20; i += 1) fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const slow = time(() => flowImbalance(trades, D - 15_000, D, { asOfTs: D, feedEpoch: 3 }));
  const fast = time(() => flowImbalance(trades, D - 15_000, D, { asOfTs: D, feedEpoch: 3, sortedByReceipt: true }));
  assert.ok(fast * 4 < slow, `bounded ${fast.toFixed(1)}ms vs full ${slow.toFixed(1)}ms for 20 calls — expected at least 4x`);
});
