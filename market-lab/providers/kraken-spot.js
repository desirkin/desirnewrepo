// D01 — KRAKEN SPOT research client: public REST (AssetPairs, Ticker, OHLC, Trades) and the public WebSocket v2 stream
// (instrument / trade / book) reusing the tape's pure OrderBook + checksum engine. Standalone research capture has its
// OWN socket, isolated from execution stores; integrated mode attaches to accepted Tape observations instead (owner.js).
// USD remains actual USD. The OHLC endpoint returns at most 720 recent bars per interval; the last entry is the current
// uncommitted candle and is emitted PROVISIONAL, never as a completed bar.
import { OrderBook, decimalsOf } from '../../tape/book.js';
import { normalizeKrakenAssetPairs, KRAKEN_BASE_ALIASES } from '../../survey/catalog.js';
import { createClientBase, num, int, str, tsFromSeconds, tsFromIso, arr, obj, marketSubject } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze, isCoin } from '../contracts.js';
import { BAR_INTERVALS_MIN, MINUTE_MS } from '../time.js';

export const KRAKEN_VENUE = 'kraken';
export const KRAKEN_TRADE_SIDES = Object.freeze({ b: 'BUY', s: 'SELL', buy: 'BUY', sell: 'SELL' }); // documented: side of the taker
export const KRAKEN_MAPPING_ID = 'kraken-assetpairs-wsname-v1';
export const KRAKEN_OHLC_MAX_BARS = 720;

export function createKrakenSpotClient({ transport, clock, log, limits } = {}) {
  const base = createClientBase({ providerId: 'KRAKEN_SPOT', transport, clock, log });
  let catalog = null; // { markets, observedTs, refusal }
  const pairKeyOf = new Map(); // wsname -> pairKey

  // ---- catalog / identity ----------------------------------------------------------------------------------------
  async function loadCatalog({ signal } = {}) {
    const r = await base.call({ endpointId: 'rest-asset-pairs', query: {}, signal });
    if (!r.ok) return r;
    const res = obj(r.json)?.result;
    const norm = normalizeKrakenAssetPairs(res, { observedTs: r.receivedTs, maxMarkets: limits?.catalogMaxMarkets ?? 5000 });
    if (!norm.ok) return { ok: false, failure: { kind: 'SCHEMA', reason: `catalog refused: ${norm.reason ?? norm.refusal ?? 'malformed'}`, coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    pairKeyOf.clear();
    for (const m of norm.catalog.markets) pairKeyOf.set(m.wsname, m.pairKey);
    const precision = new Map();
    for (const [pairKey, raw] of Object.entries(obj(res) ?? {})) { const o = obj(raw); if (!o) continue; precision.set(pairKey, { pricePrecision: int(o.pair_decimals), qtyPrecision: int(o.lot_decimals), priceIncrement: num(o.tick_size), qtyIncrement: num(o.ordermin) !== null ? null : null, status: str(o.status, 20) }); }
    catalog = deepFreeze({ markets: norm.catalog.markets, observedTs: r.receivedTs, contentId: norm.catalog.contentId ?? null, precision: Object.fromEntries(precision), requestId: r.requestId, sha256: r.sha256, counts: norm.catalog.counts });
    return { ok: true, catalog };
  }
  // Resolve ONE requested subject against the real catalog. Ambiguity or absence rejects — never string-suffix matching.
  function resolveMarket({ canonicalCoin, nativeSymbol = null }) {
    if (!catalog) return { ok: false, reason: 'CATALOG_NOT_LOADED' };
    if (!isCoin(canonicalCoin)) return { ok: false, reason: 'COIN_MALFORMED' };
    // WS v2 names the market `${base}/USD` (alias applied: BTC/USD); REST AssetPairs keeps the venue wsname (XBT/USD) and the pair key
    const candidates = catalog.markets.filter((m) => m.base === canonicalCoin && m.quote === 'USD' && (nativeSymbol === null || m.wsname === nativeSymbol || `${m.base}/USD` === nativeSymbol));
    if (candidates.length === 0) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (candidates.length > 1) return { ok: false, reason: 'AMBIGUOUS_MAPPING', candidates: candidates.map((c) => c.wsname) };
    const m = candidates[0];
    return { ok: true, market: deepFreeze({ subject: marketSubject({ canonicalCoin, providerAssetId: m.nativeBase, venue: KRAKEN_VENUE, nativeSymbol: `${m.base}/USD`, base: m.base, quote: 'USD', marketType: 'SPOT' }), pairKey: m.pairKey, wsname: `${m.base}/USD`, restWsname: m.wsname, precision: catalog.precision[m.pairKey] ?? null, mappingKnownAtTs: catalog.observedTs }) };
  }
  function instrumentObservation(market, receivedTs) {
    const p = market.precision ?? {};
    return base.tryEmit({ endpointId: 'rest-asset-pairs', subject: market.subject, kind: 'INSTRUMENT', sourceKey: market.pairKey, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: KRAKEN_MAPPING_ID }), provenance: base.provenance({ requestId: catalog?.requestId, sha256: catalog?.sha256 }, { nativeLocator: market.pairKey, mappingId: KRAKEN_MAPPING_ID }),
      payload: { status: p.status ?? 'online', base: market.subject.base, quote: 'USD', marketType: 'SPOT', pricePrecision: p.pricePrecision ?? null, qtyPrecision: p.qtyPrecision ?? null, priceIncrement: p.priceIncrement ?? null, qtyIncrement: null, contractSize: null, linearity: 'NOT_APPLICABLE', settlementCurrency: 'USD', underlying: null, expiryTs: null, strike: null, optionType: null, quoteAliasGroup: null, tradeable: (p.status ?? 'online') === 'online', fundingIntervalMs: null, fundingUnit: 'UNKNOWN' } });
  }

  // ---- OHLC (720-bar cap; last entry uncommitted) ------------------------------------------------------------------
  // sinceTs bounds the history depth (Kraken `since` = committed bars since that instant); without it Kraken returns the
  // 720 most recent bars per interval — 21 MB per subject sweep, which is not a research window but a data dump
  async function ohlc({ market, intervalMin, sinceTs = null, signal }) {
    if (!BAR_INTERVALS_MIN.includes(intervalMin)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'unsupported interval', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() } };
    const r = await base.call({ endpointId: 'rest-ohlc', query: { pair: market.pairKey, interval: intervalMin, ...(sinceTs !== null ? { since: Math.floor(sinceTs / 1000) } : {}) }, signal });
    const startTs = base.clock();
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-ohlc', subject: market.subject, family: 'SPOT_PRICE_CHART', kind: 'CANDLE', startTs })] };
    const res = obj(r.json)?.result; const rows = arr(obj(res)?.[market.pairKey]) ?? arr(obj(res)?.[Object.keys(obj(res) ?? {}).find((k) => k !== 'last') ?? '']);
    const lastCommitted = tsFromSeconds(obj(res)?.last);
    if (!rows) return { ok: false, failure: { kind: 'SCHEMA', reason: 'ohlc rows missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const intervalMs = intervalMin * MINUTE_MS; const out = []; let rejected = 0;
    for (const row of rows.slice(-KRAKEN_OHLC_MAX_BARS)) {
      const a = arr(row); if (!a || a.length < 8) { rejected += 1; continue; }
      const open = tsFromSeconds(a[0]); const o = num(a[1]); const h = num(a[2]); const l = num(a[3]); const c = num(a[4]); const vwap = num(a[5]); const vol = num(a[6]); const count = int(a[7]);
      if (open === null) { rejected += 1; continue; }
      const closeTs = open + intervalMs;
      const provisional = closeTs > r.receivedTs || (lastCommitted !== null && open > lastCommitted);
      const noTrade = vol === 0 && count === 0;
      const ob = base.tryEmit({ endpointId: 'rest-ohlc', subject: market.subject, kind: 'CANDLE', sourceKey: `${market.pairKey}:${intervalMin}:${a[0]}`, sourceEventTs: provisional ? null : closeTs, periodStartTs: open, periodEndTs: closeTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs,
        quality: quality(provisional ? 'PROVISIONAL' : noTrade ? 'MISSING' : 'KNOWN', { reasonCodes: provisional ? ['UNCOMMITTED_BAR'] : noTrade ? ['NO_TRADES_IN_PERIOD'] : [], coverageStartTs: open, coverageEndTs: provisional ? r.receivedTs : closeTs, completeness: provisional ? null : 1, methodologyId: 'kraken-ohlc-v1', originalUnit: 'USD' }), // Kraken repeats the previous close for a tradeless interval: that is a carried price, not an observed one
        provenance: base.provenance(r, { nativeLocator: `${market.pairKey}:${a[0]}`, mappingId: KRAKEN_MAPPING_ID }),
        payload: { intervalMs, open: noTrade ? null : o, high: noTrade ? null : h, low: noTrade ? null : l, close: noTrade ? null : c, volumeBase: vol, volumeQuote: vwap !== null && vol !== null ? vwap * vol : null, tradeCount: count, vwap: noTrade ? null : vwap, closed: !provisional, provisional } });
      if (ob) out.push(ob); else rejected += 1;
    }
    const closed = out.filter((o) => o.payload.closed);
    const cov = base.coverage({ endpointId: 'rest-ohlc', subject: market.subject, family: 'SPOT_PRICE_CHART', kind: 'CANDLE', state: closed.length ? 'OBSERVED' : 'GAP', reasonCodes: rows.length >= KRAKEN_OHLC_MAX_BARS ? ['PAGINATION_INCOMPLETE'] : [], startTs: closed.length ? closed[0].periodStartTs : r.receivedTs, endTs: closed.length ? closed[closed.length - 1].periodEndTs : r.receivedTs, observationCount: out.length, droppedCount: rejected });
    return { ok: true, observations: out, coverage: [cov], meta: { requestId: r.requestId, receivedTs: r.receivedTs, bars: rows.length, capReached: rows.length >= KRAKEN_OHLC_MAX_BARS, lastCommittedTs: lastCommitted } };
  }

  // ---- recent trades (bounded pages; side = taker) --------------------------------------------------------------------
  async function trades({ market, sinceTs = null, maxPages = 3, signal }) {
    const out = []; let cursor = sinceTs !== null ? String(Math.floor(sinceTs / 1000)) : null; let pages = 0; let rejected = 0; let lastMeta = null; let failure = null;
    while (pages < maxPages) {
      const r = await base.call({ endpointId: 'rest-trades', query: { pair: market.pairKey, ...(cursor ? { since: cursor } : {}) }, signal });
      if (!r.ok) { failure = r.failure; break; }
      pages += 1; lastMeta = r;
      const res = obj(r.json)?.result; const rows = arr(obj(res)?.[market.pairKey]) ?? [];
      for (const row of rows) {
        const a = arr(row); if (!a || a.length < 4) { rejected += 1; continue; }
        const price = num(a[0]); const qty = num(a[1]); const ts = tsFromSeconds(a[2]); const side = KRAKEN_TRADE_SIDES[a[3]] ?? 'UNKNOWN'; const tradeId = a.length >= 7 ? int(a[6]) : null;
        if (price === null || qty === null || ts === null) { rejected += 1; continue; }
        const ob = base.tryEmit({ endpointId: 'rest-trades', subject: market.subject, kind: 'TRADE', sourceKey: tradeId !== null ? String(tradeId) : `${a[2]}:${a[0]}:${a[1]}`, sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: 'kraken-trades-v1', originalUnit: 'USD' }), provenance: base.provenance(r, { nativeLocator: tradeId !== null ? String(tradeId) : null, mappingId: KRAKEN_MAPPING_ID }),
          payload: { price, qty, quoteNotional: price * qty, takerSide: side, sideConvention: side === 'UNKNOWN' ? 'UNKNOWN' : 'TAKER_NATIVE', nativeTradeId: tradeId !== null ? String(tradeId) : null, orderType: a[4] === 'm' ? 'market' : a[4] === 'l' ? 'limit' : null } });
        if (ob) out.push(ob); else rejected += 1;
      }
      const last = str(obj(res)?.last, 40); if (!last || rows.length < 1000) break; cursor = last;
    }
    const startTs = out.length ? out[0].sourceEventTs : base.clock();
    const cov = failure && !out.length ? base.failureCoverage(failure, { endpointId: 'rest-trades', subject: market.subject, family: 'SPOT_FLOW', kind: 'TRADE', startTs }) : base.coverage({ endpointId: 'rest-trades', subject: market.subject, family: 'SPOT_FLOW', kind: 'TRADE', state: out.length ? 'OBSERVED' : 'GAP', reasonCodes: pages >= maxPages ? ['PAGINATION_INCOMPLETE'] : [], startTs, endTs: out.length ? out[out.length - 1].sourceEventTs : base.clock(), observationCount: out.length, droppedCount: rejected });
    return failure && !out.length ? { ok: false, failure, coverage: [cov] } : { ok: true, observations: out, coverage: [cov], meta: { pages, requestId: lastMeta?.requestId ?? null, pagesExhausted: pages >= maxPages, failure } };
  }

  // ---- ticker ------------------------------------------------------------------------------------------------------
  async function ticker({ markets, signal }) {
    const r = await base.call({ endpointId: 'rest-ticker', query: { pair: markets.map((m) => m.pairKey).join(',') }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: markets.map((m) => base.failureCoverage(r.failure, { endpointId: 'rest-ticker', subject: m.subject, family: 'CROSS_VENUE', startTs: base.clock() })) };
    const res = obj(r.json)?.result ?? {}; const out = [];
    for (const m of markets) {
      const t = obj(res[m.pairKey]); if (!t) continue;
      const bid = num(arr(t.b)?.[0]); const ask = num(arr(t.a)?.[0]); const bidQty = num(arr(t.b)?.[2]); const askQty = num(arr(t.a)?.[2]);
      if (bid === null || ask === null || bid >= ask) continue;
      const ob = base.tryEmit({ endpointId: 'rest-ticker', subject: m.subject, kind: 'BOOK_SNAPSHOT', sourceKey: null, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['FIELD_MISSING_AT_SOURCE'], completeness: null, methodologyId: 'kraken-ticker-top-of-book-v1', originalUnit: 'USD' }), provenance: base.provenance(r, { nativeLocator: m.pairKey, mappingId: KRAKEN_MAPPING_ID }),
        payload: { bids: [[bid, bidQty ?? 0]], asks: [[ask, askQty ?? 0]], levelsPerSideCap: 1, synchronized: true, checksumVerified: null, bookAgeMs: null, sampleReason: 'REST_SNAPSHOT', pricePrecision: m.precision?.pricePrecision ?? null, qtyPrecision: m.precision?.qtyPrecision ?? null } });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }

  // ---- WebSocket v2 stream: instrument / trade / book with checksum + resync --------------------------------------------
  // onTrade(observation), onBook({ market, receivedTs, epochId, synced, checksumOk, levels() }), onCoverage(record)
  function createStream({ markets, depth = 100, onTrade = () => {}, onBook = () => {}, onCoverage = () => {}, WebSocketImpl, url = null }) {
    const byWs = new Map(markets.map((m) => [m.wsname, m]));
    const books = new Map(markets.map((m) => [m.wsname, new OrderBook(m.wsname, depth)]));
    const stats = { trades: 0, bookUpdates: 0, resyncs: 0, snapshotTradesSkipped: 0, unknownSymbols: 0 };
    let ws = null; let currentEpoch = null; const subscribed = new Set();
    const endSubscription = (wsname, reasonCodes, ts) => { if (!subscribed.has(wsname)) return; subscribed.delete(wsname); onCoverage(base.coverage({ endpointId: 'ws-v2', subject: byWs.get(wsname).subject, family: 'SPOT_FLOW', kind: 'TRADE', state: 'GAP', reasonCodes, startTs: ts, endTs: null, epochId: currentEpoch })); };
    const subscribeAll = (send) => { const symbols = [...byWs.keys()]; send({ method: 'subscribe', params: { channel: 'instrument' } }); send({ method: 'subscribe', params: { channel: 'trade', symbol: symbols, snapshot: false } }); send({ method: 'subscribe', params: { channel: 'book', symbol: symbols, depth, snapshot: true } }); };
    const resync = (wsname, reason, receivedTs) => { const b = books.get(wsname); b.desync(); stats.resyncs += 1; onCoverage(base.coverage({ endpointId: 'ws-v2', subject: byWs.get(wsname).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: [reason], startTs: receivedTs, endTs: null, epochId: currentEpoch })); ws.send({ method: 'unsubscribe', params: { channel: 'book', symbol: [wsname], depth } }); ws.send({ method: 'subscribe', params: { channel: 'book', symbol: [wsname], depth, snapshot: true } }); };
    function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
      if (msg.method === 'subscribe' && msg.success === false) { const sym = str(obj(msg.result)?.symbol, 40); if (sym && byWs.has(sym)) onCoverage(base.coverage({ endpointId: 'ws-v2', subject: byWs.get(sym).subject, family: 'SPOT_FLOW', kind: 'TRADE', state: 'FAILED', reasonCodes: ['PROVIDER_ERROR'], startTs: receivedTs, endTs: receivedTs, epochId })); return; }
      // closeout R02: the provider's trade-channel acknowledgement is the POSITIVE continuity fact that opens an observed interval
      if (msg.method === 'subscribe' && msg.success === true) { const res = obj(msg.result); const sym = str(res?.symbol, 40); if (res?.channel === 'trade' && sym && byWs.has(sym)) { subscribed.add(sym); onCoverage(base.coverage({ endpointId: 'ws-v2', subject: byWs.get(sym).subject, family: 'SPOT_FLOW', kind: 'TRADE', state: 'SUBSCRIBED', startTs: receivedTs, endTs: null, epochId })); } return; }
      const channel = msg.channel;
      if (channel === 'instrument') { for (const p of arr(obj(msg.data)?.pairs) ?? []) { const sym = str(obj(p)?.symbol, 40); const b = sym ? books.get(sym) : null; if (!b) continue; const pp = int(p.price_precision) ?? decimalsOf(num(p.price_increment)); const qp = int(p.qty_precision) ?? decimalsOf(num(p.qty_increment)); if (pp !== null && qp !== null) b.setPrecision(pp, qp); } return; }
      if (channel === 'trade') {
        for (const t of arr(msg.data) ?? []) {
          const sym = str(obj(t)?.symbol, 40); const m = sym ? byWs.get(sym) : null; if (!m) { stats.unknownSymbols += 1; continue; }
          if (msg.type === 'snapshot') { stats.snapshotTradesSkipped += 1; continue; } // no duplicate initial trades: the snapshot is history we did not witness
          const price = num(t.price); const qty = num(t.qty); const ts = tsFromIso(t.timestamp); const side = KRAKEN_TRADE_SIDES[t.side] ?? 'UNKNOWN'; const tradeId = int(t.trade_id);
          if (price === null || qty === null || ts === null) continue;
          const ob = base.tryEmit({ endpointId: 'ws-v2', subject: m.subject, kind: 'TRADE', sourceKey: tradeId !== null ? String(tradeId) : null, sourceEventTs: ts, receivedTs, knownAtTs: receivedTs, epochId, quality: quality('KNOWN', { methodologyId: 'kraken-ws-trade-v2', originalUnit: 'USD' }), provenance: { requestId: null, bytesSha256, nativeLocator: tradeId !== null ? String(tradeId) : null, mappingId: KRAKEN_MAPPING_ID, specificationId: null, vintage: null },
            payload: { price, qty, quoteNotional: price * qty, takerSide: side, sideConvention: side === 'UNKNOWN' ? 'UNKNOWN' : 'TAKER_NATIVE', nativeTradeId: tradeId !== null ? String(tradeId) : null, orderType: str(t.ord_type, 16) } });
          if (ob) { stats.trades += 1; onTrade(ob); }
        }
        return;
      }
      if (channel === 'book') {
        for (const d of arr(msg.data) ?? []) {
          const sym = str(obj(d)?.symbol, 40); const b = sym ? books.get(sym) : null; if (!b) { stats.unknownSymbols += 1; continue; }
          const levels = (side) => (arr(d[side]) ?? []).map((l) => ({ price: num(obj(l)?.price), qty: num(obj(l)?.qty) })).filter((l) => l.price !== null && l.qty !== null && l.price > 0 && l.qty >= 0);
          let checksumOk = null;
          if (msg.type === 'snapshot') { b.applySnapshot({ bids: levels('bids'), asks: levels('asks') }); onCoverage(base.coverage({ endpointId: 'ws-v2', subject: byWs.get(sym).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'OBSERVED', observationCount: 1, startTs: receivedTs, epochId })); }
          else { if (!b.synced) continue; const check = b.applyUpdate({ bids: levels('bids'), asks: levels('asks'), checksum: int(d.checksum) ?? undefined }); checksumOk = check.ok; if (check.ok === false) { resync(sym, 'DESYNCHRONIZED', receivedTs); continue; } }
          const bb = b.bestBid(); const ba = b.bestAsk();
          if (bb && ba && bb.price >= ba.price) { resync(sym, 'DESYNCHRONIZED', receivedTs); continue; } // a crossed book is never admitted
          stats.bookUpdates += 1;
          onBook({ market: byWs.get(sym), receivedTs, epochId, synced: b.synced, checksumOk, pricePrecision: b.pricePrecision, qtyPrecision: b.qtyPrecision, levels: () => ({ bids: b.sortedBids().slice(0, depth).map((l) => [l.price, l.qty]), asks: b.sortedAsks().slice(0, depth).map((l) => [l.price, l.qty]) }) });
        }
      }
    }
    ws = createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', WebSocketImpl, clock: base.clock, log: base.log, url, onMessage, onOpen: ({ epochId, send }) => { currentEpoch = epochId; for (const b of books.values()) b.desync(); base.setRuntime('ACTIVE'); subscribeAll(send); }, onClose: ({ epochId }) => { const ts = base.clock(); for (const [wsname, b] of books) { if (b.synced) onCoverage(base.coverage({ endpointId: 'ws-v2', subject: byWs.get(wsname).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: ['EPOCH_GAP', 'DESYNCHRONIZED'], startTs: ts, epochId })); b.desync(); endSubscription(wsname, ['EPOCH_GAP', 'SUBSCRIPTION_ENDED'], ts); } if (base.status().runtime === 'ACTIVE') base.setRuntime('DEGRADED'); } });
    const add = (market) => { if (byWs.has(market.wsname)) return false; byWs.set(market.wsname, market); books.set(market.wsname, new OrderBook(market.wsname, depth)); ws.send({ method: 'subscribe', params: { channel: 'trade', symbol: [market.wsname], snapshot: false } }); ws.send({ method: 'subscribe', params: { channel: 'book', symbol: [market.wsname], depth, snapshot: true } }); return true; };
    const remove = (wsname) => { if (!byWs.has(wsname)) return false; endSubscription(wsname, ['SUBSCRIPTION_ENDED'], base.clock()); ws.send({ method: 'unsubscribe', params: { channel: 'trade', symbol: [wsname] } }); ws.send({ method: 'unsubscribe', params: { channel: 'book', symbol: [wsname], depth } }); byWs.delete(wsname); books.delete(wsname); return true; };
    return { start: () => { base.start(); ws.start(); }, stop: async () => { await ws.stop(); base.stop(); }, status: () => ({ ...ws.status(), ...stats, synced: [...books.values()].filter((b) => b.synced).length, subscribed: [...subscribed].sort(), members: [...byWs.keys()] }), books, add, remove };
  }

  // one accepted book sample -> BOOK_SNAPSHOT observation (integrated tape observer or the standalone stream)
  function bookSnapshotObservation({ market, levels, receivedTs, epochId = null, synced, checksumOk = null, sampleReason = 'INTERVAL', endpointId = 'ws-v2', pricePrecision = null, qtyPrecision = null, bytesSha256 = null, bookAgeMs = 0 }) {
    const bids = levels.bids.slice(0, 200); const asks = levels.asks.slice(0, 200);
    return base.tryEmit({ endpointId, subject: market.subject, kind: 'BOOK_SNAPSHOT', sourceKey: null, receivedTs, knownAtTs: receivedTs, epochId, quality: quality(synced ? 'KNOWN' : 'PARTIAL', { reasonCodes: synced ? (checksumOk === null ? ['CHECKSUM_UNVERIFIED'] : []) : ['DESYNCHRONIZED'], methodologyId: 'kraken-ws-book-v2', originalUnit: 'USD' }), provenance: { requestId: null, bytesSha256, nativeLocator: market.wsname, mappingId: KRAKEN_MAPPING_ID, specificationId: null, vintage: null }, payload: { bids, asks, levelsPerSideCap: 200, synchronized: synced, checksumVerified: checksumOk, bookAgeMs, sampleReason, pricePrecision: pricePrecision ?? market.precision?.pricePrecision ?? null, qtyPrecision: qtyPrecision ?? market.precision?.qtyPrecision ?? null } });
  }
  // an accepted Tape trade (already parsed by the tape) -> TRADE observation; values are COPIED, never shared
  function tapeTradeObservation({ market, side, qty, price, eventTs, receivedTs, tradeId = null, ordType = null }) {
    const taker = KRAKEN_TRADE_SIDES[side] ?? 'UNKNOWN';
    return base.tryEmit({ endpointId: 'ws-v2', subject: market.subject, kind: 'TRADE', sourceKey: tradeId !== null ? String(tradeId) : null, sourceEventTs: eventTs, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: 'kraken-ws-trade-v2-tape-accepted', originalUnit: 'USD' }), provenance: { requestId: null, bytesSha256: null, nativeLocator: tradeId !== null ? String(tradeId) : null, mappingId: KRAKEN_MAPPING_ID, specificationId: null, vintage: 'TAPE_ACCEPTED' }, payload: { price, qty, quoteNotional: price * qty, takerSide: taker, sideConvention: taker === 'UNKNOWN' ? 'UNKNOWN' : 'TAKER_NATIVE', nativeTradeId: tradeId !== null ? String(tradeId) : null, orderType: ordType } });
  }
  return { ...base, loadCatalog, resolveMarket, instrumentObservation, ohlc, trades, ticker, createStream, bookSnapshotObservation, tapeTradeObservation, catalog: () => catalog, aliases: KRAKEN_BASE_ALIASES };
}
