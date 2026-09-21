// JUDGE — fast features over point-in-time windows (ticket §4.3-4.5, §5.1). Pure functions over closed inputs plus a
// bounded incremental tracker whose outputs are tested against the independent batch functions here. Exact quantities
// (notional, counts, support) are decimals; indicator statistics are finite doubles with a declared tolerance. The
// indicator block is computed ONCE per changed 61-bar input (identity = digest of the bars), never per book message; the
// latest-60-closes EMA seed RESTARTS with each new block (a streaming EMA would change the strategy and is forbidden).
import * as M from '../execution/money.js';
import { digestOf } from '../execution/contract.js';

export const FEATURE_VERSION = 'judge-features-paper-reference-2';
export const BAR_MS = 60_000; export const BARS_REQUIRED = 61; export const FI_MIN_CLASSIFIED = 0.95; export const TOLERANCE = Object.freeze({ price: 1e-9, ratio: 1e-9 });
export class FeatureError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const num = (v) => (typeof v === 'string' ? Number(v) : v);
// ---- 61 contiguous COMPLETE closed 1m bars (oldest = prior-close support) --------------------------------------------------
export function validateBarBlock(bars, { referenceTs = null } = {}) {
  if (!Array.isArray(bars) || bars.length !== BARS_REQUIRED) return { ok: false, reason: `BARS_${Array.isArray(bars) ? bars.length : 0}_OF_${BARS_REQUIRED}` };
  for (let i = 0; i < bars.length; i += 1) { const b = bars[i]; if (!b || !Number.isSafeInteger(b.periodStartTs) || b.periodEndTs !== b.periodStartTs + BAR_MS || b.closed !== true) return { ok: false, reason: `BAR_${i}_NOT_COMPLETE` }; for (const k of ['open', 'high', 'low', 'close']) if (!(Number.isFinite(num(b[k])) && num(b[k]) > 0)) return { ok: false, reason: `BAR_${i}_${k.toUpperCase()}_MISSING` }; if (num(b.high) < num(b.low) || num(b.close) > num(b.high) || num(b.close) < num(b.low)) return { ok: false, reason: `BAR_${i}_OHLC_INCONSISTENT` }; if (i > 0 && b.periodStartTs !== bars[i - 1].periodEndTs) return { ok: false, reason: `BAR_${i}_GAP` }; if (referenceTs !== null && b.periodEndTs > referenceTs) return { ok: false, reason: `BAR_${i}_AFTER_REFERENCE` }; }
  return { ok: true };
}
export const barBlockDigest = (bars) => digestOf(bars.map((b) => [b.periodStartTs, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volumeQuote ?? ''), String(b.volumeBase ?? '')]));
// Wilder ATR14 seeded on the first 14 of 60 true ranges then updated to the latest bar; EMA5 / EMA20 seeded on the first
// N-close mean of the latest 60 closes then alpha = 2 / (N + 1); H20 / L20 over the latest 20 closed bars; prior-5 envelope
export function indicatorBlock(bars, { referenceTs = null } = {}) {
  const v = validateBarBlock(bars, { referenceTs }); if (!v.ok) throw new FeatureError('BAR_BLOCK_INVALID', v.reason);
  const trs = []; for (let i = 1; i < bars.length; i += 1) { const b = bars[i]; const pc = num(bars[i - 1].close); trs.push(Math.max(num(b.high) - num(b.low), Math.abs(num(b.high) - pc), Math.abs(num(b.low) - pc))); }
  let atr = trs.slice(0, 14).reduce((a, x) => a + x, 0) / 14; for (let i = 14; i < trs.length; i += 1) atr = (atr * 13 + trs[i]) / 14;
  const closes = bars.slice(1).map((b) => num(b.close)); const ema = (n) => { let e = closes.slice(0, n).reduce((a, x) => a + x, 0) / n; const alpha = 2 / (n + 1); for (let i = n; i < closes.length; i += 1) e = closes[i] * alpha + e * (1 - alpha); return e; };
  const last20 = bars.slice(-20); const h20 = Math.max(...last20.map((b) => num(b.high))); const l20 = Math.min(...last20.map((b) => num(b.low))); const last5 = bars.slice(-5); const envelope5 = Math.max(...last5.map((b) => num(b.high))) - Math.min(...last5.map((b) => num(b.low)));
  const prior20Ret = closes[closes.length - 1] / closes[closes.length - 21] - 1; const prior20HighIdx = last20.reduce((best, b, i) => (num(b.high) > num(last20[best].high) ? i : best), 0);
  const last3 = bars.slice(-3); const last3Low = Math.min(...last3.map((b) => num(b.low))); const last2High = Math.max(...bars.slice(-2).map((b) => num(b.high))); const low5 = Math.min(...last5.map((b) => num(b.low)));
  return Object.freeze({ featureVersion: FEATURE_VERSION, blockDigest: barBlockDigest(bars), referenceTs: bars[bars.length - 1].periodEndTs, atr14: atr, ema5: ema(5), ema20: ema(20), h20, l20, envelope5, low5, prior20Return: prior20Ret, prior20High: num(last20[prior20HighIdx].high), prior20HighBarsFromEnd: 19 - prior20HighIdx, prior20Low: l20, last3Low, last2High, lastClose: closes[closes.length - 1], bars: bars.length, trueRanges: trs.length });
}
// confirmed swing high: strictly above two bars on either side, all five closed before the reference; nearest strictly above `entry`.
// PUBLISH-FIX-85 (2026-09-20): `minAbove` — a swing high closer to the entry than this distance is noise, not a target: the nearest
// swing AT LEAST minAbove above the entry is returned. The Judge sets it from the setup's own stop (REWARD_RISK_MIN × the stop
// distance): a target nearer than that can never clear the reward-to-risk law, so capping to it only threw the whole setup away
// (ARB/USD MICRO_BITE 2026-09-20: every gate passed, target 0.2125 capped by a swing one tick above the entry, no size).
export function nearestResistanceAbove(bars, entry, { referenceTs = null, minAbove = 0 } = {}) {
  const swings = []; for (let i = 2; i < bars.length - 2; i += 1) { const h = num(bars[i].high); if (referenceTs !== null && bars[i + 2].periodEndTs > referenceTs) continue; if (h > num(bars[i - 1].high) && h > num(bars[i - 2].high) && h > num(bars[i + 1].high) && h > num(bars[i + 2].high)) swings.push({ price: h, periodStartTs: bars[i].periodStartTs }); }
  const floor = entry + (Number.isFinite(minAbove) && minAbove > 0 ? minAbove : 0);
  const above = swings.filter((s) => s.price > floor).sort((a, b) => a.price - b.price); return above.length ? above[0] : null;
}
// ---- trade windows: half-open [start, end), native id dedup, taker side verbatim, unknown fraction retained ------------------
export function dedupTrades(trades) { const seen = new Set(); const out = []; let dropped = 0; for (const t of trades) { const k = t.nativeTradeId ?? `${t.eventTs}|${t.price}|${t.qty}|${t.side}`; if (seen.has(k)) { dropped += 1; continue; } seen.add(k); out.push(t); } return { trades: out, duplicatesDropped: dropped }; }
const validEpoch = (v) => Number.isSafeInteger(v) && v >= 0;
const validTradeClock = (t) => Number.isSafeInteger(t?.eventTs) && t.eventTs >= 0 && Number.isSafeInteger(t?.receiptTs) && t.receiptTs >= 0 && t.eventTs <= t.receiptTs;
// PUBLISH-FIX-111 (2026-09-21): every window query scanned the WHOLE retained trade array — 25 minutes of prints — to find a
// 15-second window, twice (queryEpoch, then the filter), with decimal-string arithmetic per print. windowFacts asks for four
// imbalance windows, a vwap and RV60's twenty-one trailing windows, up to four times a second per candidate, for twenty
// candidates. Production 2b2047d0 at 04:19, the sampled minute at 100% busy: `cmp 13% · parseDecimal 8% · fromNumberLexeme 6%
// · windowFacts 5% · parseDecimalUncached 4% · onBook 3%` — the flow windows were the main thread, and the cost rose with the
// trade rate, i.e. exactly when a runner runs. The lower bound is EXACT, not approximate: validTradeClock (enforced by
// add() at insertion) guarantees eventTs <= receiptTs, so a print with eventTs >= startTs has receiptTs >= startTs, and the
// tracker's array is in receipt order (appended as received, trimmed from the front). Skipping every print whose receiptTs is
// below startTs therefore skips only prints that could never be in the window. The tracker says so with `sortedByReceipt`;
// a plain array without the hint is scanned from the start exactly as before, so every other caller is unchanged.
function lowerBoundByReceipt(trades, startTs) {
  let lo = 0; let hi = trades.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; const r = trades[mid]?.receiptTs; if (Number.isSafeInteger(r) && r < startTs) lo = mid + 1; else hi = mid; }
  return lo;
}
function queryEpoch(trades, startTs, endTs, asOfTs, requested, fromIndex = 0) {
  const epochs = new Set();
  for (let i = fromIndex; i < trades.length; i += 1) { const t = trades[i];
    if (t?.fromSubscriptionSnapshot === true) continue;
    if (t?.fromSubscriptionSnapshot !== false || !Number.isSafeInteger(t.eventTs) || t.eventTs < 0) return { ok: false, epoch: null, reason: 'TRADE_INVALID' };
    if (t.eventTs < startTs || t.eventTs >= endTs) continue;
    if (!validTradeClock(t) || !validEpoch(t.feedEpoch)) return { ok: false, epoch: null, reason: 'TRADE_INVALID' };
    if (t.receiptTs <= asOfTs) epochs.add(t.feedEpoch);
  }
  if (requested !== null && requested !== undefined) return validEpoch(requested) ? { ok: true, epoch: requested } : { ok: false, epoch: null, reason: 'EPOCH_INVALID' };
  return epochs.size <= 1 ? { ok: true, epoch: epochs.size ? epochs.values().next().value : null } : { ok: false, epoch: null, reason: 'EPOCH_AMBIGUOUS' };
}
function tradesAsOf(trades, startTs, endTs, { asOfTs = endTs, feedEpoch = null, sortedByReceipt = false } = {}) {
  if (!Array.isArray(trades) || !Number.isSafeInteger(startTs) || !Number.isSafeInteger(endTs) || !Number.isSafeInteger(asOfTs) || startTs > endTs) return { ok: false, trades: [] };
  const from = sortedByReceipt === true ? lowerBoundByReceipt(trades, startTs) : 0; // PUBLISH-FIX-111: exact, see above
  const resolved = queryEpoch(trades, startTs, endTs, asOfTs, feedEpoch, from); if (!resolved.ok) return { ok: false, trades: [] };
  const out = [];
  for (let i = from; i < trades.length; i += 1) { const t = trades[i]; if (t?.fromSubscriptionSnapshot === false && validTradeClock(t) && validEpoch(t.feedEpoch) && t.receiptTs <= asOfTs && t.eventTs >= startTs && t.eventTs < endTs && (resolved.epoch === null || t.feedEpoch === resolved.epoch)) out.push(t); }
  return { ok: true, trades: out };
}
// PUBLISH-FIX-83 (full review item 8): a flow imbalance over 1-3 prints is a coin flip (one $3 taker sell -> -1 -> refused; 369 scored
// looks showed zero separation). With { minTrades, maxWindowMs } the window is widened backwards (x2, x4 ... up to maxWindowMs) until
// it holds minTrades classified prints; below that at the widest window the reading is UNKNOWN 'TOO_FEW_TRADES', never a number.
// The result always carries count, windowMs and widened so the ledger and the gate study see what was measured.
export const FI_MIN_TRADES = 6;
export function flowImbalance(trades, startTs, endTs, query = {}) {
  const { minTrades = 0, maxWindowMs = null, ...q } = query ?? {}; const baseWindow = endTs - startTs;
  const measure = (from) => { const selected = tradesAsOf(trades, from, endTs, q); let buy = '0'; let sell = '0'; let unknown = '0'; let n = 0; for (const t of selected.trades) { n += 1; if (t.side === 'buy') buy = M.add(buy, t.quoteNotional); else if (t.side === 'sell') sell = M.add(sell, t.quoteNotional); else unknown = M.add(unknown, t.quoteNotional); } return { selected, buy, sell, unknown, n, from }; };
  let m = measure(startTs); let widened = false;
  if (minTrades > 0 && Number.isFinite(maxWindowMs) && maxWindowMs > baseWindow) { let w = baseWindow; while (m.selected.ok && m.n < minTrades && w < maxWindowMs) { w = Math.min(maxWindowMs, w * 2); m = measure(endTs - w); widened = true; } }
  const { selected, buy, sell, unknown, n, from } = m; const windowMs = endTs - from;
  const known = M.add(buy, sell); const total = M.add(known, unknown); const classified = M.isZero(total) ? null : M.toStatistic(M.div(known, total, 6, 'DOWN'));
  const out = (state, reason, fi) => ({ state, reason, fi, buy, sell, unknown, count: n, classifiedFraction: classified, startTs: from, endTs, windowMs, widened, minTrades });
  if (!selected.ok) return out('UNKNOWN', 'AS_OF_OR_EPOCH_INVALID', null);
  if (M.isZero(known) || n === 0) return out('UNKNOWN', 'ZERO_DENOMINATOR', null);
  if (classified !== null && classified < FI_MIN_CLASSIFIED) return out('UNKNOWN', 'CLASSIFIED_BELOW_95PCT', null);
  if (minTrades > 0 && n < minTrades) return out('UNKNOWN', 'TOO_FEW_TRADES', null);
  return out('KNOWN', null, M.toStatistic(M.div(M.sub(buy, sell), known, 8, 'HALF_UP')));
}
export function windowNotional(trades, startTs, endTs, query = {}) { const selected = tradesAsOf(trades, startTs, endTs, query); let q = '0'; let n = 0; for (const t of selected.trades) { q = M.add(q, t.quoteNotional); n += 1; } return { notional: q, count: n, startTs, endTs }; }
// RV60 — PUBLISH-FIX-83 (full review item 7). Before: numerator = the last COMPLETE clock minute [E-60s, E), E = floor(D/60s)*60s; the
// burst that caused the crossing lives in [E, D) and was discarded, so on an igniting thin coin the numerator was the empty minute
// BEFORE the move -> rv60 = 0 KNOWN -> refused (300 of 335 RV60 refusals on 2026-09-19 read exactly 0). Now: numerator = the trailing
// 60 s ending at the decision, [D-60s, D), against the median of the 20 preceding trailing-aligned 60 s windows. Coverage must be
// continuous from D-21min to within RV60_COVERAGE_LAG_MS of D (the feed's coverage clock ends at its last message / heartbeat).
export const RV60_COVERAGE_LAG_MS = 5000;
export function relativeVolume60(trades, decisionTs, coverage) {
  const validDecision = Number.isSafeInteger(decisionTs) && decisionTs >= 0; const E = validDecision ? decisionTs : null; const unknown = (reason) => ({ state: 'UNKNOWN', reason, rv60: null, E, window: 'TRAILING', numerator: null, baseline: null, completedMinuteDelayMs: 0 });
  if (!Array.isArray(trades) || !validDecision) return unknown('INPUT_INVALID');
  const historicalGap = !coverage || !Object.hasOwn(coverage, 'gapTs') || coverage.gapTs === null || (Number.isSafeInteger(coverage.gapTs) && coverage.gapTs >= 0 && Number.isSafeInteger(coverage.startTs) && coverage.gapTs <= coverage.startTs);
  const coverageClockValid = coverage && coverage.continuous === true && Number.isSafeInteger(coverage.startTs) && coverage.startTs >= 0 && Number.isSafeInteger(coverage.endTs) && coverage.endTs >= 0 && coverage.startTs <= coverage.endTs && coverage.endTs <= decisionTs && historicalGap;
  const need = { startTs: E - 21 * BAR_MS, endTs: E };
  if (!coverageClockValid || coverage.startTs > need.startTs || coverage.endTs < need.endTs - RV60_COVERAGE_LAG_MS) return unknown('COVERAGE_INCOMPLETE');
  const sortedByReceipt = coverage.sortedByReceipt === true; const from = sortedByReceipt ? lowerBoundByReceipt(trades, need.startTs) : 0; // PUBLISH-FIX-111
  const resolved = queryEpoch(trades, need.startTs, need.endTs, decisionTs, coverage.epoch, from); if (!resolved.ok) return unknown(resolved.reason === 'TRADE_INVALID' ? 'INPUT_INVALID' : 'EPOCH_AMBIGUOUS');
  // PUBLISH-FIX-83 (full review item 26): the 21 windows are summed in ONE pass over the selected trades (it was 21 full passes with
  // BigInt adds, ~18 ms per call at 20k trades — ~430 ms/s once liquid coins sit in the slots); same windows, same law, same values
  const query = { asOfTs: decisionTs, feedEpoch: resolved.epoch, sortedByReceipt }; const selected = tradesAsOf(trades, need.startTs, need.endTs, query); const sums = new Array(21).fill('0'); const counts = new Array(21).fill(0);
  for (const t of selected.trades) { const k = Math.floor((E - t.eventTs - 1) / BAR_MS); if (k < 0 || k > 20) continue; sums[k] = M.add(sums[k], t.quoteNotional); counts[k] += 1; }
  const numerator = { notional: sums[0], count: counts[0] }; const base = sums.slice(1);
  const sorted = [...base].sort((a, b) => M.cmp(a, b)); const median = M.div(M.add(sorted[9], sorted[10]), '2', 8, 'HALF_UP');
  if (M.isZero(median)) return { state: 'UNKNOWN', reason: 'ZERO_MEDIAN', rv60: null, E, window: 'TRAILING', numerator: numerator.notional, numeratorCount: numerator.count, baseline: median, completedMinuteDelayMs: 0 };
  return { state: 'KNOWN', reason: null, rv60: M.toStatistic(M.div(numerator.notional, median, 8, 'HALF_UP')), E, window: 'TRAILING', numerator: numerator.notional, numeratorCount: numerator.count, baseline: median, baselineWindows: 20, completedMinuteDelayMs: 0 };
}
export function vwap(trades, startTs, endTs, query = {}) { const selected = tradesAsOf(trades, startTs, endTs, query); let q = '0'; let b = '0'; for (const t of selected.trades) { q = M.add(q, t.quoteNotional); b = M.add(b, t.qty); } return M.isZero(b) ? null : M.div(q, b, 8, 'HALF_UP'); }
// ---- book features on an exact snapshot ---------------------------------------------------------------------------------------
export function bookFacts(snapshot) { if (!snapshot || !snapshot.bids.length || !snapshot.asks.length) return null; const bid = snapshot.bids[0][0]; const ask = snapshot.asks[0][0]; const mid = M.div(M.add(bid, ask), '2', 9, 'HALF_UP'); return { bestBid: bid, bestAsk: ask, mid, spread: M.sub(ask, bid) }; }
// PUBLISH-FIX-83 (full review item 12): the band is measured from the BEST BID, not the mid. From the mid, any spread wider than
// 2 x bps put even the best bid below the floor -> depth 0 -> LIQUIDITY_PRESENT refused on every thin mover; the best bid IS
// the liquidity a sell would hit, so the band starts there.
export function bidDepthWithinBps(snapshot, bps) { const f = bookFacts(snapshot); if (!f) return null; const floor = M.mul(f.bestBid, M.sub('1', M.div(String(bps), '10000', 8, 'DOWN'))); let notional = '0'; for (const [p, q] of snapshot.bids) { if (M.lt(p, floor)) break; notional = M.add(notional, M.mul(p, q)); } return notional; }
// PUBLISH-FIX-10: the exact median with a numeric fast path. Correctly rounded Number() is monotonic for lexemes of at
// most 20 significant digits, so ordering by double is the exact ordering wherever the doubles differ; the exact BigInt
// sort is used whenever any lexeme is long/non-plain or when the doubles around the middle collide (a tie could hide a
// different exact order). Same value either way; the double is a sort key only.
const MEDIAN_FAST_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const medianExact = (list) => { const s = [...list].sort((a, b) => M.cmp(a, b)); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : M.div(M.add(s[mid - 1], s[mid]), '2', 8, 'HALF_UP'); };
export const medianDecimal = (list) => {
  if (!list.length) return null;
  const n = list.length; const keys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) { const v = list[i]; if (typeof v !== 'string' || v.length > 20 || !MEDIAN_FAST_RE.test(v)) return medianExact(list); keys[i] = Number(v); }
  const sorted = keys.slice().sort(); // native numeric sort — the double is a sort key only
  // the exact lexeme at sorted position `pos`: everything with a smaller double is exactly smaller (monotonic rounding);
  // within the run of equal doubles, identical strings need no ordering, differing strings are ordered exactly
  const at = (pos) => {
    const m = sorted[pos]; let less = 0; const run = [];
    for (let i = 0; i < n; i += 1) { const k = keys[i]; if (k < m) less += 1; else if (k === m) run.push(list[i]); }
    const first = run[0]; let same = true; for (let i = 1; i < run.length && same; i += 1) if (run[i] !== first) same = false;
    if (same) return first;
    run.sort((a, b) => M.cmp(a, b)); return run[pos - less];
  };
  const mid = Math.floor(n / 2);
  if (n % 2) return at(mid);
  return M.div(M.add(at(mid - 1), at(mid)), '2', 8, 'HALF_UP');
};
// ---- bounded incremental tracker: trades expire on time advance even without a new trade; a coverage change invalidates ----------
export function createFlowTracker({ retentionMs = 22 * BAR_MS, maxTrades = 50_000 } = {}) {
  const trades = []; const ids = new Set(); let dropped = 0; let overflow = 0; let epoch = null; let epochChanges = 0; let lastTs = 0;
  // PUBLISH-FIX-111: true while every print was appended in receipt order (the feed's receipt clock is monotone; a print that
  // arrives with an EARLIER receiptTs than its predecessor turns the hint off for good — correctness first, speed second)
  let sortedByReceipt = true; let lastReceiptTs = -1; let disorder = 0;
  return {
    add(t) { if (t?.fromSubscriptionSnapshot !== false || !validTradeClock(t) || !validEpoch(t.feedEpoch)) return false; if (epoch !== null && t.feedEpoch < epoch) return false; if (epoch !== null && t.feedEpoch > epoch) { epochChanges += 1; trades.length = 0; ids.clear(); lastTs = 0; lastReceiptTs = -1; sortedByReceipt = true; } epoch = t.feedEpoch; const k = t.nativeTradeId ?? `${t.eventTs}|${t.price}|${t.qty}|${t.side}`; if (ids.has(k)) { dropped += 1; return false; } ids.add(k); if (t.receiptTs < lastReceiptTs) { sortedByReceipt = false; disorder += 1; } lastReceiptTs = Math.max(lastReceiptTs, t.receiptTs); trades.push(t); lastTs = Math.max(lastTs, t.eventTs); if (trades.length > maxTrades) { const gone = trades.shift(); ids.delete(gone.nativeTradeId ?? `${gone.eventTs}|${gone.price}|${gone.qty}|${gone.side}`); overflow += 1; } return true; },
    advance(now) { const cut = now - retentionMs; while (trades.length && trades[0].eventTs < cut) { const gone = trades.shift(); ids.delete(gone.nativeTradeId ?? `${gone.eventTs}|${gone.price}|${gone.qty}|${gone.side}`); } },
    fi(startTs, endTs, query = {}) { return flowImbalance(trades, startTs, endTs, { ...query, asOfTs: query.asOfTs ?? endTs, feedEpoch: query.feedEpoch ?? epoch, sortedByReceipt }); }, notional(startTs, endTs, query = {}) { return windowNotional(trades, startTs, endTs, { asOfTs: query.asOfTs ?? endTs, feedEpoch: query.feedEpoch ?? epoch, sortedByReceipt }); }, vwap(startTs, endTs, query = {}) { return vwap(trades, startTs, endTs, { asOfTs: query.asOfTs ?? endTs, feedEpoch: query.feedEpoch ?? epoch, sortedByReceipt }); }, rv60(decisionTs, coverage) { return relativeVolume60(trades, decisionTs, { ...coverage, epoch: coverage?.epoch ?? epoch, sortedByReceipt }); },
    // the trades inside [startTs, endTs) in receipt order: the challengers' window input (focused completion §5), never a copy of the whole tape
    window(startTs, endTs, query = {}) { return tradesAsOf(trades, startTs, endTs, { asOfTs: query.asOfTs ?? endTs, feedEpoch: query.feedEpoch ?? epoch, sortedByReceipt }).trades; },
    snapshot: () => trades.slice(), status: () => ({ trades: trades.length, duplicatesDropped: dropped, overflow, epoch, epochChanges, lastTs, sortedByReceipt, disorder }),
  };
}
// ---- bounded feature cache keyed by input identity (digest + coverage + recipe version + reference endpoints) --------------------
export function createFeatureCache({ max = 256 } = {}) { const map = new Map(); let hits = 0; let misses = 0; const keyOf = (parts) => digestOf({ v: FEATURE_VERSION, ...parts }); return { get(parts, compute) { const k = keyOf(parts); if (map.has(k)) { hits += 1; const v = map.get(k); map.delete(k); map.set(k, v); return { value: v, hit: true }; } misses += 1; const value = compute(); map.set(k, value); if (map.size > max) map.delete(map.keys().next().value); return { value, hit: false }; }, status: () => ({ size: map.size, hits, misses }) }; }
