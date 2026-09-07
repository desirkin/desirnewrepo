// SOCIAL-5A — the PURE injected deep-market evidence contract for the research strainer.
//
// THE STRAINER IS A CONSUMER OF MARKET TRUTH, NEVER AN ACQUIRER. This module opens no
// socket, reads no file, imports no tape module and starts no second collector: it
// validates a CLOSED deep-market window that an authoritative owner (a later market-
// evidence ticket, or a test) injects, and derives DESCRIPTIVE measurements from it.
// When no window is injected the strainer says MARKET_DEEP_OBSERVATION: NOT_CONNECTED
// and EXECUTABILITY: UNASSESSED — it never synthesizes depth, spread, taker flow,
// slippage or capacity from the wide eye's rolling 24h Ticker proxy.
//
// Every number below is a MEASUREMENT of supplied inputs, not a prediction:
//   * executed buy/sell notional exists ONLY when the authoritative trade feed supplied
//     an explicit taker side (no side => no inferred aggression);
//   * spread / displayed depth / imbalance exist ONLY from a synchronized, fresh book;
//     displayed liquidity is displayed liquidity, never guaranteed future liquidity;
//     aggregate L2 changes are unattributed — never identified orders or whales;
//   * hypothetical slippage needs an explicit reference notional and the book snapshot
//     that supported it; insufficient depth is disclosed as PARTIAL, never extrapolated.
import { contentHash, canonicalJson } from './truth.js';

export const RESEARCH_MARKET_CONTRACT_VERSION = 1;
export const RESEARCH_MARKET_STATES = Object.freeze(['SYNCHRONIZED', 'STALE', 'UNSYNCHRONIZED', 'UNAVAILABLE']);
export const RESEARCH_MARKET_WINDOW_KEYS = Object.freeze(['contractVersion', 'venue', 'canonicalCoin', 'symbol', 'windowStartTs', 'windowEndTs', 'observedTs', 'knownAtTs', 'state', 'priceStart', 'priceEnd', 'trades', 'book', 'referenceNotionalsUsd']);
export const RESEARCH_MARKET_TRADES_KEYS = Object.freeze(['source', 'count', 'takerSideKnown', 'buyNotionalUsd', 'sellNotionalUsd', 'totalNotionalUsd']);
export const RESEARCH_MARKET_BOOK_KEYS = Object.freeze(['source', 'synchronized', 'observedTs', 'bids', 'asks']);
export const RESEARCH_DEPTH_BANDS = Object.freeze(['top', '5bps', '10bps', '25bps']); // the same band vocabulary the deep tape uses
export const RESEARCH_L2_ATTRIBUTION = 'AGGREGATE_L2_UNATTRIBUTED';
export const RESEARCH_EXECUTABILITY_STATES = Object.freeze(['ASSESSED', 'STALE', 'UNASSESSED']);
export const RESEARCH_MARKET_MAX_LEVELS = 200;
export const RESEARCH_MARKET_MAX_REFERENCE_NOTIONALS = 8;
export const RESEARCH_MARKET_BOOK_MAX_AGE_MS = 15_000; // a book observed longer ago than this within the window is STALE for executability (a freshness bound, not a trade rule)
const BAND_BPS = Object.freeze({ top: 0, '5bps': 5, '10bps': 10, '25bps': 25 });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
const isPrice = (v) => Number.isFinite(v) && v > 0;
const isUsd = (v) => Number.isFinite(v) && v >= 0;
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const exactKeys = (o, keys) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `undeclared key '${k}'`; for (const k of keys) if (!(k in o)) return `missing key '${k}'`; return null; };

function validateLevels(levels, side) {
  if (!Array.isArray(levels) || levels.length > RESEARCH_MARKET_MAX_LEVELS) return `${side}: levels malformed or over ${RESEARCH_MARKET_MAX_LEVELS}`;
  let prev = null;
  for (const l of levels) {
    if (!Array.isArray(l) || l.length !== 2 || !isPrice(l[0]) || !Number.isFinite(l[1]) || l[1] < 0) return `${side}: level malformed`;
    if (prev !== null && (side === 'bids' ? l[0] >= prev : l[0] <= prev)) return `${side}: levels not strictly ordered from the touch`;
    prev = l[0];
  }
  return null;
}

// Validate ONE injected deep-market window. Returns { ok:true, window } (deep-frozen, closed)
// or { ok:false, error }. Nothing is clamped, defaulted, or inferred.
export function validateDeepMarketWindow(input) {
  if (!isPlainObject(input)) return { ok: false, error: 'deep market window: not an object' };
  const k = exactKeys(input, RESEARCH_MARKET_WINDOW_KEYS); if (k) return { ok: false, error: `deep market window: ${k}` };
  if (input.contractVersion !== RESEARCH_MARKET_CONTRACT_VERSION) return { ok: false, error: 'deep market window: unsupported contract version' };
  if (typeof input.venue !== 'string' || input.venue.length === 0 || input.venue.length > 40) return { ok: false, error: 'deep market window: venue malformed' };
  if (typeof input.canonicalCoin !== 'string' || !/^[A-Z0-9][A-Z0-9.]{0,14}$/.test(input.canonicalCoin)) return { ok: false, error: 'deep market window: canonicalCoin malformed' };
  if (typeof input.symbol !== 'string' || input.symbol.length === 0 || input.symbol.length > 40) return { ok: false, error: 'deep market window: symbol malformed' };
  if (!isTs(input.windowStartTs) || !isTs(input.windowEndTs) || input.windowEndTs < input.windowStartTs) return { ok: false, error: 'deep market window: window clocks invalid' };
  if (!isTs(input.observedTs) || !isTs(input.knownAtTs) || input.observedTs > input.knownAtTs) return { ok: false, error: 'deep market window: observation cannot be known before it was observed' };
  if (input.observedTs < input.windowEndTs) return { ok: false, error: 'deep market window: observed before the window closed (a window is complete only after its end)' };
  if (!RESEARCH_MARKET_STATES.includes(input.state)) return { ok: false, error: 'deep market window: unknown state' };
  if (input.priceStart !== null && !isPrice(input.priceStart)) return { ok: false, error: 'deep market window: priceStart malformed' };
  if (input.priceEnd !== null && !isPrice(input.priceEnd)) return { ok: false, error: 'deep market window: priceEnd malformed' };
  let trades = null;
  if (input.trades !== null) {
    const t = input.trades;
    if (!isPlainObject(t)) return { ok: false, error: 'deep market window: trades malformed' };
    const tk = exactKeys(t, RESEARCH_MARKET_TRADES_KEYS); if (tk) return { ok: false, error: `deep market window: trades ${tk}` };
    if (typeof t.source !== 'string' || t.source.length === 0 || t.source.length > 80) return { ok: false, error: 'deep market window: trades.source required (the authoritative trade feed)' };
    if (!Number.isSafeInteger(t.count) || t.count < 0) return { ok: false, error: 'deep market window: trades.count malformed' };
    if (typeof t.takerSideKnown !== 'boolean') return { ok: false, error: 'deep market window: trades.takerSideKnown must be boolean' };
    if (!isUsd(t.totalNotionalUsd)) return { ok: false, error: 'deep market window: trades.totalNotionalUsd malformed' };
    if (t.takerSideKnown) {
      if (!isUsd(t.buyNotionalUsd) || !isUsd(t.sellNotionalUsd)) return { ok: false, error: 'deep market window: explicit taker sides require buy and sell notionals' };
      if (Math.abs(t.buyNotionalUsd + t.sellNotionalUsd - t.totalNotionalUsd) > 1e-6 * Math.max(1, t.totalNotionalUsd)) return { ok: false, error: 'deep market window: buy + sell notional disagrees with total' };
    } else if (t.buyNotionalUsd !== null || t.sellNotionalUsd !== null) return { ok: false, error: 'deep market window: no taker side => buy/sell notionals must be null (never inferred)' };
    trades = { source: t.source, count: t.count, takerSideKnown: t.takerSideKnown, buyNotionalUsd: t.buyNotionalUsd, sellNotionalUsd: t.sellNotionalUsd, totalNotionalUsd: t.totalNotionalUsd };
  }
  let book = null;
  if (input.book !== null) {
    const b = input.book;
    if (!isPlainObject(b)) return { ok: false, error: 'deep market window: book malformed' };
    const bk = exactKeys(b, RESEARCH_MARKET_BOOK_KEYS); if (bk) return { ok: false, error: `deep market window: book ${bk}` };
    if (typeof b.source !== 'string' || b.source.length === 0 || b.source.length > 80) return { ok: false, error: 'deep market window: book.source required' };
    if (typeof b.synchronized !== 'boolean') return { ok: false, error: 'deep market window: book.synchronized must be boolean' };
    if (!isTs(b.observedTs) || b.observedTs > input.knownAtTs) return { ok: false, error: 'deep market window: book.observedTs invalid' };
    const be = validateLevels(b.bids, 'bids') ?? validateLevels(b.asks, 'asks'); if (be) return { ok: false, error: `deep market window: book ${be}` };
    if (b.bids.length > 0 && b.asks.length > 0 && b.bids[0][0] >= b.asks[0][0]) return { ok: false, error: 'deep market window: crossed book (best bid >= best ask)' };
    book = { source: b.source, synchronized: b.synchronized, observedTs: b.observedTs, bids: b.bids.map((l) => [l[0], l[1]]), asks: b.asks.map((l) => [l[0], l[1]]) };
  }
  if (!Array.isArray(input.referenceNotionalsUsd) || input.referenceNotionalsUsd.length > RESEARCH_MARKET_MAX_REFERENCE_NOTIONALS || input.referenceNotionalsUsd.some((n) => !Number.isFinite(n) || n <= 0)) return { ok: false, error: 'deep market window: referenceNotionalsUsd must be a bounded list of positive notionals' };
  if (input.state === 'SYNCHRONIZED' && (!book || !book.synchronized)) return { ok: false, error: 'deep market window: SYNCHRONIZED state requires a synchronized book' };
  const window = { contractVersion: 1, venue: input.venue, canonicalCoin: input.canonicalCoin, symbol: input.symbol, windowStartTs: input.windowStartTs, windowEndTs: input.windowEndTs, observedTs: input.observedTs, knownAtTs: input.knownAtTs, state: input.state, priceStart: input.priceStart, priceEnd: input.priceEnd, trades, book, referenceNotionalsUsd: [...new Set(input.referenceNotionalsUsd)].sort((a, b) => a - b) };
  return { ok: true, window: deepFreeze({ ...window, windowId: `r2mw-${contentHash(canonicalJson(window))}` }) };
}

// Walk one side of a displayed book for a hypothetical marketable order of `notionalUsd`.
// Returns the volume-weighted fill price, the slippage versus the touch in bps, and whether the
// displayed depth covered the notional (FULL) or ran out (PARTIAL — disclosed, never extrapolated).
export function walkBook(levels, notionalUsd) {
  if (!Array.isArray(levels) || levels.length === 0 || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  const touch = levels[0][0];
  let remaining = notionalUsd; let qty = 0; let spent = 0;
  for (const [price, size] of levels) {
    const levelUsd = price * size;
    if (levelUsd <= 0) continue;
    const take = Math.min(remaining, levelUsd);
    qty += take / price; spent += take; remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (spent <= 0) return null;
  const vwap = spent / qty;
  return { touch, vwap: round(vwap, 8), filledUsd: round(spent, 2), coverage: remaining <= 1e-9 ? 'FULL' : 'PARTIAL_DEPTH', slippageBps: round((Math.abs(vwap - touch) / touch) * 1e4, 2), levelsUsed: levels.length };
}

function bandDepthUsd(levels, mid, bps) {
  let usd = 0;
  for (const [price, size] of levels) { if (Math.abs(price - mid) / mid * 1e4 <= bps + 1e-9) usd += price * size; else break; }
  return round(usd, 2);
}

// DESCRIPTIVE features of one validated window. Absent inputs stay null; nothing is inferred.
export function deepMarketFeatures(window) {
  const w = window && typeof window === 'object' && window.windowId ? window : null;
  if (!w) return { state: 'NOT_CONNECTED', executability: { state: 'UNASSESSED', reason: 'no deep-market window supplied by an authoritative owner', value: null } };
  const priceChangePct = isPrice(w.priceStart) && isPrice(w.priceEnd) ? round(((w.priceEnd - w.priceStart) / w.priceStart) * 100, 4) : null;
  const t = w.trades;
  const flow = t === null ? { state: 'NOT_SUPPLIED', count: null, totalNotionalUsd: null, buyNotionalUsd: null, sellNotionalUsd: null, netTakerNotionalUsd: null, takerSideKnown: null }
    : { state: 'KNOWN', count: t.count, totalNotionalUsd: round(t.totalNotionalUsd, 2), buyNotionalUsd: t.takerSideKnown ? round(t.buyNotionalUsd, 2) : null, sellNotionalUsd: t.takerSideKnown ? round(t.sellNotionalUsd, 2) : null, netTakerNotionalUsd: t.takerSideKnown ? round(t.buyNotionalUsd - t.sellNotionalUsd, 2) : null, takerSideKnown: t.takerSideKnown };
  // price progress per unit of net taker notional: bps of price change per 1,000 USD of net taker
  // notional; null unless BOTH the price change and an explicit non-zero net taker side exist
  const progress = priceChangePct !== null && flow.netTakerNotionalUsd !== null && Math.abs(flow.netTakerNotionalUsd) >= 1
    ? { value: round((priceChangePct * 100) / (flow.netTakerNotionalUsd / 1000), 4), units: 'bps_per_1k_usd_net_taker_notional' } : { value: null, units: 'bps_per_1k_usd_net_taker_notional' };
  const b = w.book;
  const bookFresh = b !== null && b.synchronized && w.state === 'SYNCHRONIZED' && (w.windowEndTs - b.observedTs) <= RESEARCH_MARKET_BOOK_MAX_AGE_MS && b.bids.length > 0 && b.asks.length > 0;
  let bookF = { state: b === null ? 'NOT_SUPPLIED' : !b.synchronized ? 'UNSYNCHRONIZED' : w.state !== 'SYNCHRONIZED' ? w.state : bookFresh ? 'SYNCHRONIZED' : 'STALE', observedTs: b ? b.observedTs : null, spreadBps: null, displayedDepthUsd: null, imbalance10bps: null, attribution: RESEARCH_L2_ATTRIBUTION, note: 'displayed liquidity only — never guaranteed future liquidity' };
  const slippage = [];
  if (bookFresh) {
    const bid = b.bids[0][0]; const ask = b.asks[0][0]; const mid = (bid + ask) / 2;
    bookF.spreadBps = round(((ask - bid) / mid) * 1e4, 2);
    const depth = {};
    for (const band of RESEARCH_DEPTH_BANDS) depth[band] = { bidUsd: band === 'top' ? round(bid * b.bids[0][1], 2) : bandDepthUsd(b.bids, mid, BAND_BPS[band]), askUsd: band === 'top' ? round(ask * b.asks[0][1], 2) : bandDepthUsd(b.asks, mid, BAND_BPS[band]) };
    bookF.displayedDepthUsd = depth;
    const d10 = depth['10bps']; const tot = d10.bidUsd + d10.askUsd;
    bookF.imbalance10bps = tot > 0 ? round((d10.bidUsd - d10.askUsd) / tot, 4) : null; // aggregate-book semantics: displayed USD within 10 bps, unattributed
    for (const n of w.referenceNotionalsUsd) slippage.push({ referenceNotionalUsd: n, marketSell: walkBook(b.bids, n), marketBuy: walkBook(b.asks, n), bookObservedTs: b.observedTs, hypothetical: true });
  }
  const executability = bookFresh
    ? { state: 'ASSESSED', reason: 'measured from a synchronized displayed book at the stated reference notionals (hypothetical marketable fills; displayed depth is not guaranteed)', value: { spreadBps: bookF.spreadBps, slippage, bookObservedTs: b.observedTs } }
    : b !== null && (bookF.state === 'STALE' || bookF.state === 'UNSYNCHRONIZED') ? { state: 'STALE', reason: `book ${bookF.state}: a stale or unsynchronized book is not executable depth`, value: null }
      : { state: 'UNASSESSED', reason: 'no synchronized book supplied — entry/exit capacity unknown', value: null };
  return deepFreeze({ state: w.state, windowId: w.windowId, venue: w.venue, symbol: w.symbol, windowStartTs: w.windowStartTs, windowEndTs: w.windowEndTs, observedTs: w.observedTs, knownAtTs: w.knownAtTs, priceStart: w.priceStart, priceEnd: w.priceEnd, priceChangePct, flow, priceProgressPerNetTaker: progress, book: bookF, slippage, executability });
}
