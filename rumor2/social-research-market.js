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

// =============================== OWNER SNAPSHOT (passive read-only bridge, §36.7) ===============================
// The deep tape ALREADY computes per-coin book/trade-flow features and (since SOCIAL-5) re-exposes
// the SAME computed snapshot as an atomically replaced current file (tape/store.js
// writeCurrentFeatureSnapshot / readCurrentFeatureSnapshot). The composition root injects only the
// READ accessor. This section validates one such owner snapshot and derives DESCRIPTIVE facts from
// what the owner exposed — it never recomputes book or flow features, never invents a freshness
// threshold (exact owner age/clock is exposed instead), and never converts displayed depth bands into
// exit capacity: executability stays UNASSESSED because the owner exposes bands, not a walkable book.
export const RESEARCH_OWNER_SNAPSHOT_VERSIONS = Object.freeze(['tape-feature-snapshot-1']);
export const RESEARCH_OWNER_SNAPSHOT_STATES = Object.freeze(['NOT_PRESENT', 'PRESENT_WITH_AGE', 'STALE_SESSION', 'NOT_YET_KNOWN', 'INVALID']);
export const RESEARCH_OWNER_TAPE_STATES = Object.freeze(['LIVE', 'DEGRADED', 'OFFLINE']);
const OWNER_BANDS = Object.freeze(['top', '5bps', '10bps', '25bps']);
const unitOrNull = (v) => v === null || (Number.isFinite(v) && v >= -1 && v <= 1);

// Validate ONE owner snapshot for `canonicalCoin` as of `asOfTs` under `currentSession` (the ET
// session date the research tick runs in; null => session identity cannot be checked and is disclosed).
export function validateOwnerMarketSnapshot(raw, { canonicalCoin, asOfTs, currentSession = null } = {}) {
  if (raw === null || raw === undefined) return { state: 'NOT_PRESENT', snapshot: null, error: null };
  if (!isPlainObject(raw)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: not an object' };
  if (!RESEARCH_OWNER_SNAPSHOT_VERSIONS.includes(raw.version)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: unsupported version' };
  if (raw.coin !== canonicalCoin) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: coin disagrees with the research subject' };
  if (!isTs(raw.tsMs) || raw.ts !== new Date(raw.tsMs).toISOString()) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: captured clock malformed (ts must derive from tsMs)' };
  if (typeof raw.session !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.session)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: session identity malformed' };
  if (!RESEARCH_OWNER_TAPE_STATES.includes(raw.tapeState)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: tape state malformed' };
  if (raw.symbol !== null && (typeof raw.symbol !== 'string' || raw.symbol.length === 0 || raw.symbol.length > 40)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: symbol malformed' };
  if (!isPrice(raw.bestBid) || !isPrice(raw.bestAsk) || raw.bestBid >= raw.bestAsk) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: no valid uncrossed touch' };
  if (!Number.isFinite(raw.bestBidQty) || !Number.isFinite(raw.bestAskQty) || raw.bestBidQty < 0 || raw.bestAskQty < 0 || !isPrice(raw.mid) || !Number.isFinite(raw.spreadBps) || raw.spreadBps < 0) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: touch quantities / mid / spread malformed' };
  if (!isPlainObject(raw.depthUsd) || !isPlainObject(raw.obi)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: depth/imbalance bands missing' };
  const depth = {}; const obi = {};
  for (const band of OWNER_BANDS) {
    const d = raw.depthUsd[band];
    if (!isPlainObject(d) || !isUsd(d.bid) || !isUsd(d.ask)) return { state: 'INVALID', snapshot: null, error: `owner snapshot: depth band ${band} malformed` };
    if (!(band in raw.obi) || !unitOrNull(raw.obi[band])) return { state: 'INVALID', snapshot: null, error: `owner snapshot: imbalance band ${band} malformed` };
    depth[band] = { bidUsd: round(d.bid, 2), askUsd: round(d.ask, 2) }; obi[band] = raw.obi[band] === null ? null : round(raw.obi[band], 4);
  }
  for (const k of ['tradeImbalance15s', 'tradeImbalance1m', 'tradeImbalance5m']) if (!(k in raw) || !unitOrNull(raw[k])) return { state: 'INVALID', snapshot: null, error: `owner snapshot: ${k} malformed` };
  if (!Number.isFinite(raw.cvd)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: cvd malformed' };
  if (!isTs(asOfTs)) return { state: 'INVALID', snapshot: null, error: 'owner snapshot: asOfTs required' };
  if (raw.tsMs > asOfTs) return { state: 'NOT_YET_KNOWN', snapshot: null, error: 'owner snapshot: captured after the research derivation clock — it cannot enter this dossier' };
  const closed = {
    version: raw.version, coin: raw.coin, symbol: raw.symbol ?? null, tsMs: raw.tsMs, session: raw.session, tapeState: raw.tapeState,
    bestBid: raw.bestBid, bestAsk: raw.bestAsk, bestBidQty: raw.bestBidQty, bestAskQty: raw.bestAskQty, mid: raw.mid, spreadBps: round(raw.spreadBps, 4), depthUsd: depth, obi,
    tradeImbalance15s: raw.tradeImbalance15s === null ? null : round(raw.tradeImbalance15s, 4), tradeImbalance1m: raw.tradeImbalance1m === null ? null : round(raw.tradeImbalance1m, 4), tradeImbalance5m: raw.tradeImbalance5m === null ? null : round(raw.tradeImbalance5m, 4), cvd: round(raw.cvd, 8),
  };
  const snapshot = deepFreeze({ ...closed, snapshotId: `r2os-${contentHash(canonicalJson(closed))}` });
  const stale = typeof currentSession === 'string' && currentSession !== raw.session;
  return { state: stale ? 'STALE_SESSION' : 'PRESENT_WITH_AGE', snapshot, error: null };
}

// DESCRIPTIVE facts from one validated owner snapshot. `ownerHealth` is the tape's own current status
// record (state/tsMs) when the accessor supplies it — exposed verbatim, never converted into quality.
export function ownerMarketFeatures({ state, snapshot }, { asOfTs, ownerHealth = null, sessionChecked = true } = {}) {
  if (state === 'NOT_PRESENT' || !snapshot) return { state: state === 'NOT_PRESENT' ? 'NOT_PRESENT' : state, snapshotId: null, note: 'missing owner snapshot != zero market activity: the tape has not written a current feature snapshot for this coin (not subscribed, not yet synchronized, or not running)' };
  const s = snapshot;
  const health = isPlainObject(ownerHealth) && RESEARCH_OWNER_TAPE_STATES.includes(ownerHealth.state) ? { state: ownerHealth.state, tsMs: isTs(ownerHealth.tsMs) ? ownerHealth.tsMs : null, ageMs: isTs(ownerHealth.tsMs) && isTs(asOfTs) ? Math.max(0, asOfTs - ownerHealth.tsMs) : null } : null;
  const quality = state === 'STALE_SESSION' ? 'STALE_SESSION' : s.tapeState !== 'LIVE' ? `OWNER_${s.tapeState}_AT_CAPTURE` : health && health.state !== 'LIVE' ? `OWNER_${health.state}_NOW` : 'OWNER_LIVE_AT_CAPTURE';
  return deepFreeze({
    state, quality, snapshotId: s.snapshotId, ownerVersion: s.version, venue: 'kraken', symbol: s.symbol, ownerTsMs: s.tsMs, ownerTs: new Date(s.tsMs).toISOString(), ageMs: Math.max(0, asOfTs - s.tsMs), session: s.session, sessionChecked, tapeStateAtCapture: s.tapeState, ownerHealth: health,
    book: { state: 'DISPLAYED_BANDS', bestBid: s.bestBid, bestAsk: s.bestAsk, mid: s.mid, spreadBps: s.spreadBps, displayedDepthUsd: s.depthUsd, imbalance: s.obi, attribution: RESEARCH_L2_ATTRIBUTION, note: 'displayed liquidity within the owner\'s measurement bands only — never guaranteed future liquidity; aggregate L2, unattributed' },
    flow: { state: 'TAKER_SIDE_RATIOS', tradeImbalance15s: s.tradeImbalance15s, tradeImbalance1m: s.tradeImbalance1m, tradeImbalance5m: s.tradeImbalance5m, cvdBaseUnits: s.cvd, takerSideKnown: true, notionalsUsd: null, note: 'executed taker-side imbalance ratios of base quantity from the authoritative trade feed (explicit side) — distinct from any ticker / candle proxy; USD notionals and trade counts are not exposed by the owner snapshot and are not inferred' },
    executability: { state: 'UNASSESSED', reason: 'the owner snapshot exposes displayed depth BANDS, not a walkable per-level book: no reference-notional fill can be measured; displayed bands are not exit capacity', value: null },
    note: 'age is the exact owner clock difference; no universal freshness threshold is applied here — the owner\'s own tape state/health is exposed beside it',
  });
}
