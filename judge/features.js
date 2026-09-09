// JUDGE — fast features over point-in-time windows (ticket §4.3-4.5, §5.1). Pure functions over closed inputs plus a
// bounded incremental tracker whose outputs are tested against the independent batch functions here. Exact quantities
// (notional, counts, support) are decimals; indicator statistics are finite doubles with a declared tolerance. The
// indicator block is computed ONCE per changed 61-bar input (identity = digest of the bars), never per book message; the
// latest-60-closes EMA seed RESTARTS with each new block (a streaming EMA would change the strategy and is forbidden).
import * as M from '../execution/money.js';
import { digestOf } from '../execution/contract.js';

export const FEATURE_VERSION = 'judge-features-paper-reference-1';
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
// confirmed swing high: strictly above two bars on either side, all five closed before the reference; nearest strictly above `entry`
export function nearestResistanceAbove(bars, entry, { referenceTs = null } = {}) {
  const swings = []; for (let i = 2; i < bars.length - 2; i += 1) { const h = num(bars[i].high); if (referenceTs !== null && bars[i + 2].periodEndTs > referenceTs) continue; if (h > num(bars[i - 1].high) && h > num(bars[i - 2].high) && h > num(bars[i + 1].high) && h > num(bars[i + 2].high)) swings.push({ price: h, periodStartTs: bars[i].periodStartTs }); }
  const above = swings.filter((s) => s.price > entry).sort((a, b) => a.price - b.price); return above.length ? above[0] : null;
}
// ---- trade windows: half-open [start, end), native id dedup, taker side verbatim, unknown fraction retained ------------------
export function dedupTrades(trades) { const seen = new Set(); const out = []; let dropped = 0; for (const t of trades) { const k = t.nativeTradeId ?? `${t.eventTs}|${t.price}|${t.qty}|${t.side}`; if (seen.has(k)) { dropped += 1; continue; } seen.add(k); out.push(t); } return { trades: out, duplicatesDropped: dropped }; }
export function flowImbalance(trades, startTs, endTs) {
  let buy = '0'; let sell = '0'; let unknown = '0'; let n = 0; for (const t of trades) { if (t.eventTs < startTs || t.eventTs >= endTs || t.fromSubscriptionSnapshot) continue; n += 1; if (t.side === 'buy') buy = M.add(buy, t.quoteNotional); else if (t.side === 'sell') sell = M.add(sell, t.quoteNotional); else unknown = M.add(unknown, t.quoteNotional); }
  const known = M.add(buy, sell); const total = M.add(known, unknown); const classified = M.isZero(total) ? null : M.toStatistic(M.div(known, total, 6, 'DOWN'));
  if (M.isZero(known) || n === 0) return { state: 'UNKNOWN', reason: 'ZERO_DENOMINATOR', fi: null, buy, sell, unknown, count: n, classifiedFraction: classified, startTs, endTs };
  if (classified !== null && classified < FI_MIN_CLASSIFIED) return { state: 'UNKNOWN', reason: 'CLASSIFIED_BELOW_95PCT', fi: null, buy, sell, unknown, count: n, classifiedFraction: classified, startTs, endTs };
  return { state: 'KNOWN', reason: null, fi: M.toStatistic(M.div(M.sub(buy, sell), known, 8, 'HALF_UP')), buy, sell, unknown, count: n, classifiedFraction: classified, startTs, endTs };
}
export function windowNotional(trades, startTs, endTs) { let q = '0'; let n = 0; for (const t of trades) { if (t.eventTs < startTs || t.eventTs >= endTs || t.fromSubscriptionSnapshot) continue; q = M.add(q, t.quoteNotional); n += 1; } return { notional: q, count: n, startTs, endTs }; }
// RV60: last complete 60s traded quote notional / median of the 20 preceding non-overlapping complete 60s windows; E = floor(D/60000)*60000
export function relativeVolume60(trades, decisionTs, coverage) {
  const E = Math.floor(decisionTs / BAR_MS) * BAR_MS; const need = { startTs: E - 21 * BAR_MS, endTs: E };
  if (!coverage || !coverage.continuous || coverage.startTs > need.startTs || coverage.endTs < need.endTs) return { state: 'UNKNOWN', reason: 'COVERAGE_INCOMPLETE', rv60: null, E, numerator: null, baseline: null, completedMinuteDelayMs: decisionTs - E };
  const numerator = windowNotional(trades, E - BAR_MS, E); const base = []; for (let k = 1; k <= 20; k += 1) base.push(windowNotional(trades, E - (k + 1) * BAR_MS, E - k * BAR_MS).notional);
  const sorted = [...base].sort((a, b) => M.cmp(a, b)); const median = M.div(M.add(sorted[9], sorted[10]), '2', 8, 'HALF_UP');
  if (M.isZero(median)) return { state: 'UNKNOWN', reason: 'ZERO_MEDIAN', rv60: null, E, numerator: numerator.notional, baseline: median, completedMinuteDelayMs: decisionTs - E };
  return { state: 'KNOWN', reason: null, rv60: M.toStatistic(M.div(numerator.notional, median, 8, 'HALF_UP')), E, numerator: numerator.notional, baseline: median, baselineWindows: 20, completedMinuteDelayMs: decisionTs - E };
}
export function vwap(trades, startTs, endTs) { let q = '0'; let b = '0'; for (const t of trades) { if (t.eventTs < startTs || t.eventTs >= endTs || t.fromSubscriptionSnapshot) continue; q = M.add(q, t.quoteNotional); b = M.add(b, t.qty); } return M.isZero(b) ? null : M.div(q, b, 8, 'HALF_UP'); }
// ---- book features on an exact snapshot ---------------------------------------------------------------------------------------
export function bookFacts(snapshot) { if (!snapshot || !snapshot.bids.length || !snapshot.asks.length) return null; const bid = snapshot.bids[0][0]; const ask = snapshot.asks[0][0]; const mid = M.div(M.add(bid, ask), '2', 9, 'HALF_UP'); return { bestBid: bid, bestAsk: ask, mid, spread: M.sub(ask, bid) }; }
export function bidDepthWithinBps(snapshot, bps) { const f = bookFacts(snapshot); if (!f) return null; const floor = M.mul(f.mid, M.sub('1', M.div(String(bps), '10000', 8, 'DOWN'))); let notional = '0'; for (const [p, q] of snapshot.bids) { if (M.lt(p, floor)) break; notional = M.add(notional, M.mul(p, q)); } return notional; }
export const medianDecimal = (list) => { if (!list.length) return null; const s = [...list].sort((a, b) => M.cmp(a, b)); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : M.div(M.add(s[mid - 1], s[mid]), '2', 8, 'HALF_UP'); };
// ---- bounded incremental tracker: trades expire on time advance even without a new trade; a coverage change invalidates ----------
export function createFlowTracker({ retentionMs = 22 * BAR_MS, maxTrades = 50_000 } = {}) {
  const trades = []; const ids = new Set(); let dropped = 0; let overflow = 0; let epoch = null; let epochChanges = 0; let lastTs = 0;
  return {
    add(t) { if (t.fromSubscriptionSnapshot) return false; if (epoch !== null && t.feedEpoch !== epoch) { epochChanges += 1; } epoch = t.feedEpoch; const k = t.nativeTradeId ?? `${t.eventTs}|${t.price}|${t.qty}|${t.side}`; if (ids.has(k)) { dropped += 1; return false; } ids.add(k); trades.push(t); lastTs = Math.max(lastTs, t.eventTs); if (trades.length > maxTrades) { const gone = trades.shift(); ids.delete(gone.nativeTradeId ?? `${gone.eventTs}|${gone.price}|${gone.qty}|${gone.side}`); overflow += 1; } return true; },
    advance(now) { const cut = now - retentionMs; while (trades.length && trades[0].eventTs < cut) { const gone = trades.shift(); ids.delete(gone.nativeTradeId ?? `${gone.eventTs}|${gone.price}|${gone.qty}|${gone.side}`); } },
    fi(startTs, endTs) { return flowImbalance(trades, startTs, endTs); }, notional(startTs, endTs) { return windowNotional(trades, startTs, endTs); }, vwap(startTs, endTs) { return vwap(trades, startTs, endTs); }, rv60(decisionTs, coverage) { return relativeVolume60(trades, decisionTs, coverage); },
    // the trades inside [startTs, endTs) in receipt order: the challengers' window input (focused completion §5), never a copy of the whole tape
    window(startTs, endTs) { return trades.filter((t) => t.eventTs >= startTs && t.eventTs < endTs); },
    snapshot: () => trades.slice(), status: () => ({ trades: trades.length, duplicatesDropped: dropped, overflow, epoch, epochChanges, lastTs }),
  };
}
// ---- bounded feature cache keyed by input identity (digest + coverage + recipe version + reference endpoints) --------------------
export function createFeatureCache({ max = 256 } = {}) { const map = new Map(); let hits = 0; let misses = 0; const keyOf = (parts) => digestOf({ v: FEATURE_VERSION, ...parts }); return { get(parts, compute) { const k = keyOf(parts); if (map.has(k)) { hits += 1; const v = map.get(k); map.delete(k); map.set(k, v); return { value: v, hit: true }; } misses += 1; const value = compute(); map.set(k, value); if (map.size > max) map.delete(map.keys().next().value); return { value, hit: false }; }, status: () => ({ size: map.size, hits, misses }) }; }
