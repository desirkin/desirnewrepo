// D02 — COINBASE EXCHANGE public market data: products, trades, level-2 book, candles (REST) and the public
// `matches` + `level2_batch` WebSocket channels. The documented `side` of a match / trade is the MAKER order side
// (a "buy" side is a down-tick); the taker side recorded here is the OPPOSITE, under the explicit convention
// MAKER_NATIVE_INVERTED. USD and USDC quoted products on Coinbase are ONE quote alias group — never two venues, never
// two trades, never a stablecoin conversion measurement. No trading credentials are used or required.
import { OrderBook } from '../../tape/book.js';
import { createClientBase, num, int, str, tsFromIso, tsFromSeconds, arr, obj, bool, marketSubject } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze, isCoin } from '../contracts.js';

export const COINBASE_VENUE = 'coinbase';
export const COINBASE_MAPPING_ID = 'coinbase-exchange-products-v1';
export const COINBASE_USD_ALIAS_GROUP = 'COINBASE_USD_USDC';
export const COINBASE_GRANULARITIES_SEC = Object.freeze([60, 300, 900, 3600, 21600, 86400]);
export const COINBASE_CANDLE_MAX_ROWS = 300;
const invertMaker = (side) => (side === 'buy' ? 'SELL' : side === 'sell' ? 'BUY' : 'UNKNOWN');
const decimalsOfIncrement = (s) => { const n = num(s); if (n === null || n <= 0) return null; const t = String(s); const i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };

export function createCoinbaseClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'COINBASE_SPOT', transport, clock, log });
  let products = null;
  async function loadProducts({ signal } = {}) {
    const r = await base.call({ endpointId: 'rest-products', query: {}, signal });
    if (!r.ok) return r;
    const rows = arr(r.json); if (!rows) return { ok: false, failure: { kind: 'SCHEMA', reason: 'products not an array', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    const list = [];
    for (const raw of rows) {
      const p = obj(raw); if (!p) continue;
      const id = str(p.id, 40); const b = str(p.base_currency, 20); const q = str(p.quote_currency, 20); const status = str(p.status, 20);
      if (!id || !b || !q || !status || id !== `${b}-${q}`) continue;
      list.push({ id, base: b, quote: q, status, tradingDisabled: bool(p.trading_disabled) ?? null, fxStablecoin: bool(p.fx_stablecoin) ?? null, pricePrecision: decimalsOfIncrement(p.quote_increment), qtyPrecision: decimalsOfIncrement(p.base_increment), priceIncrement: num(p.quote_increment), qtyIncrement: num(p.base_increment) });
    }
    products = deepFreeze({ list, observedTs: r.receivedTs, requestId: r.requestId, sha256: r.sha256 });
    return { ok: true, products };
  }
  function resolveProduct({ canonicalCoin, productId = null, quote = 'USD' }) {
    if (!products) return { ok: false, reason: 'CATALOG_NOT_LOADED' };
    if (!isCoin(canonicalCoin)) return { ok: false, reason: 'COIN_MALFORMED' };
    const c = products.list.filter((p) => p.base === canonicalCoin && p.status === 'online' && (productId !== null ? p.id === productId : p.quote === quote));
    if (c.length === 0) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (c.length > 1) return { ok: false, reason: 'AMBIGUOUS_MAPPING', candidates: c.map((p) => p.id) };
    const p = c[0];
    return { ok: true, market: deepFreeze({ subject: marketSubject({ canonicalCoin, providerAssetId: p.base, venue: COINBASE_VENUE, nativeSymbol: p.id, base: p.base, quote: p.quote, marketType: 'SPOT', quoteAliasGroup: p.quote === 'USD' || p.quote === 'USDC' ? COINBASE_USD_ALIAS_GROUP : null }), productId: p.id, precision: { pricePrecision: p.pricePrecision, qtyPrecision: p.qtyPrecision, priceIncrement: p.priceIncrement, qtyIncrement: p.qtyIncrement }, mappingKnownAtTs: products.observedTs, tradingDisabled: p.tradingDisabled, fxStablecoin: p.fxStablecoin }) };
  }
  function instrumentObservation(market, receivedTs) {
    return base.tryEmit({ endpointId: 'rest-products', subject: market.subject, kind: 'INSTRUMENT', sourceKey: market.productId, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: COINBASE_MAPPING_ID }), provenance: base.provenance({ requestId: products?.requestId, sha256: products?.sha256 }, { nativeLocator: market.productId, mappingId: COINBASE_MAPPING_ID }),
      payload: { status: 'online', base: market.subject.base, quote: market.subject.quote, marketType: 'SPOT', pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision, priceIncrement: market.precision.priceIncrement, qtyIncrement: market.precision.qtyIncrement, contractSize: null, linearity: 'NOT_APPLICABLE', settlementCurrency: market.subject.quote, underlying: null, expiryTs: null, strike: null, optionType: null, quoteAliasGroup: market.subject.quoteAliasGroup, tradeable: market.tradingDisabled === true ? false : true, fundingIntervalMs: null, fundingUnit: 'UNKNOWN' } });
  }
  async function trades({ market, limit = 100, signal }) {
    const r = await base.call({ endpointId: 'rest-trades', pathParams: { product_id: market.productId }, query: { limit: Math.min(1000, Math.max(1, limit)) }, signal });
    const startTs = base.clock();
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-trades', subject: market.subject, family: 'SPOT_FLOW', kind: 'TRADE', startTs })] };
    const rows = arr(r.json) ?? []; const out = []; let rejected = 0;
    for (const raw of rows) {
      const t = obj(raw); const price = num(t?.price); const qty = num(t?.size); const ts = tsFromIso(t?.time); const tid = int(t?.trade_id); const maker = str(t?.side, 8);
      if (price === null || qty === null || ts === null || tid === null) { rejected += 1; continue; }
      const taker = invertMaker(maker);
      const ob = base.tryEmit({ endpointId: 'rest-trades', subject: market.subject, kind: 'TRADE', sourceKey: String(tid), sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: 'coinbase-exchange-trades-maker-side-v1', originalUnit: market.subject.quote }), provenance: base.provenance(r, { nativeLocator: String(tid), mappingId: COINBASE_MAPPING_ID }),
        payload: { price, qty, quoteNotional: price * qty, takerSide: taker, sideConvention: taker === 'UNKNOWN' ? 'UNKNOWN' : 'MAKER_NATIVE_INVERTED', nativeTradeId: String(tid), orderType: null } });
      if (ob) out.push(ob); else rejected += 1;
    }
    out.sort((a, b) => a.sourceEventTs - b.sourceEventTs);
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'rest-trades', subject: market.subject, family: 'SPOT_FLOW', kind: 'TRADE', state: out.length ? 'OBSERVED' : 'GAP', reasonCodes: rows.length >= limit ? ['PAGINATION_INCOMPLETE'] : [], startTs: out.length ? out[0].sourceEventTs : startTs, endTs: out.length ? out[out.length - 1].sourceEventTs : r.receivedTs, observationCount: out.length, droppedCount: rejected })], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function book({ market, level = 2, signal }) {
    const r = await base.call({ endpointId: 'rest-book', pathParams: { product_id: market.productId }, query: { level }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-book', subject: market.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_SNAPSHOT', startTs: base.clock() })] };
    const j = obj(r.json); const lv = (side) => (arr(j?.[side]) ?? []).map((l) => [num(arr(l)?.[0]), num(arr(l)?.[1])]).filter((l) => l[0] !== null && l[1] !== null && l[0] > 0 && l[1] >= 0).slice(0, 200);
    const bids = lv('bids'); const asks = lv('asks');
    const ob = base.tryEmit({ endpointId: 'rest-book', subject: market.subject, kind: 'BOOK_SNAPSHOT', sourceKey: null, sourceEventTs: tsFromIso(j?.time), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(level === 2 ? 'PARTIAL' : 'KNOWN', { reasonCodes: level === 2 ? ['PAGINATION_INCOMPLETE'] : [], completeness: null, methodologyId: `coinbase-exchange-book-level${level}-v1`, originalUnit: market.subject.quote }), provenance: base.provenance(r, { nativeLocator: market.productId, mappingId: COINBASE_MAPPING_ID }),
      payload: { bids, asks, levelsPerSideCap: 200, synchronized: true, checksumVerified: null, bookAgeMs: 0, sampleReason: 'REST_SNAPSHOT', pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision } });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'book rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  async function candles({ market, granularitySec, startTs = null, endTs = null, signal }) {
    if (!COINBASE_GRANULARITIES_SEC.includes(granularitySec)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'unsupported granularity', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() }, coverage: [] };
    const q = { granularity: granularitySec }; if (startTs !== null) q.start = new Date(startTs).toISOString(); if (endTs !== null) q.end = new Date(endTs).toISOString();
    const r = await base.call({ endpointId: 'rest-candles', pathParams: { product_id: market.productId }, query: q, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-candles', subject: market.subject, family: 'SPOT_PRICE_CHART', kind: 'CANDLE', startTs: base.clock() })] };
    const rows = arr(r.json) ?? []; const intervalMs = granularitySec * 1000; const out = []; let rejected = 0;
    for (const raw of rows) {
      const a = arr(raw); if (!a || a.length < 6) { rejected += 1; continue; }
      const open = tsFromSeconds(a[0]); const l = num(a[1]); const h = num(a[2]); const o = num(a[3]); const c = num(a[4]); const v = num(a[5]);
      if (open === null) { rejected += 1; continue; }
      const closeTs = open + intervalMs; const provisional = closeTs > r.receivedTs;
      const ob = base.tryEmit({ endpointId: 'rest-candles', subject: market.subject, kind: 'CANDLE', sourceKey: `${market.productId}:${granularitySec}:${a[0]}`, sourceEventTs: provisional ? null : closeTs, periodStartTs: open, periodEndTs: closeTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs,
        quality: quality(provisional ? 'PROVISIONAL' : 'KNOWN', { reasonCodes: provisional ? ['UNCOMMITTED_BAR'] : [], coverageStartTs: open, coverageEndTs: provisional ? r.receivedTs : closeTs, completeness: provisional ? null : 1, methodologyId: 'coinbase-exchange-candles-v1', originalUnit: market.subject.quote }), provenance: base.provenance(r, { nativeLocator: `${market.productId}:${a[0]}`, mappingId: COINBASE_MAPPING_ID }),
        payload: { intervalMs, open: o, high: h, low: l, close: c, volumeBase: v, volumeQuote: null, tradeCount: null, vwap: null, closed: !provisional, provisional } });
      if (ob) out.push(ob); else rejected += 1;
    }
    out.sort((a, b) => a.periodStartTs - b.periodStartTs);
    const closed = out.filter((o) => o.payload.closed);
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'rest-candles', subject: market.subject, family: 'SPOT_PRICE_CHART', kind: 'CANDLE', state: closed.length ? 'OBSERVED' : 'GAP', reasonCodes: rows.length >= COINBASE_CANDLE_MAX_ROWS ? ['PAGINATION_INCOMPLETE'] : [], startTs: closed.length ? closed[0].periodStartTs : r.receivedTs, endTs: closed.length ? closed[closed.length - 1].periodEndTs : r.receivedTs, observationCount: out.length, droppedCount: rejected })], meta: { requestId: r.requestId, receivedTs: r.receivedTs, rows: rows.length } };
  }
  // WebSocket: matches (maker side) + level2_batch (public). Book without checksum: sequence gaps force a resubscribe.
  function createStream({ markets, depth = 200, onTrade = () => {}, onBook = () => {}, onCoverage = () => {}, WebSocketImpl, url = null }) {
    const byId = new Map(markets.map((m) => [m.productId, m])); const books = new Map(markets.map((m) => [m.productId, new OrderBook(m.productId, depth)])); const lastSeq = new Map();
    const stats = { trades: 0, bookUpdates: 0, resyncs: 0, unknownSymbols: 0 }; let ws = null; let currentEpoch = null; const subscribed = new Set();
    const endSubscription = (pid, reasonCodes, ts) => { if (!subscribed.has(pid)) return; subscribed.delete(pid); onCoverage(base.coverage({ endpointId: 'ws-feed', subject: byId.get(pid).subject, family: 'SPOT_FLOW', kind: 'TRADE', state: 'GAP', reasonCodes, startTs: ts, endTs: null, epochId: currentEpoch })); };
    const resync = (pid, receivedTs) => { books.get(pid).desync(); stats.resyncs += 1; onCoverage(base.coverage({ endpointId: 'ws-feed', subject: byId.get(pid).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: ['EPOCH_GAP'], startTs: receivedTs, epochId: currentEpoch })); ws.send({ type: 'unsubscribe', product_ids: [pid], channels: ['level2_batch'] }); ws.send({ type: 'subscribe', product_ids: [pid], channels: ['level2_batch'] }); };
    function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
      const type = str(msg.type, 24); const pid = str(msg.product_id, 40);
      if (type === 'error') { onCoverage(base.coverage({ endpointId: 'ws-feed', subject: markets[0].subject, family: 'SPOT_FLOW', kind: 'TRADE', state: 'FAILED', reasonCodes: ['PROVIDER_ERROR'], startTs: receivedTs, endTs: receivedTs, epochId })); return; }
      // closeout R02: the feed's subscriptions confirmation for the matches channel opens the observed trade interval per product
      if (type === 'subscriptions') { for (const ch of arr(msg.channels) ?? []) { const chan = obj(ch); if (str(chan?.name, 24) !== 'matches') continue; for (const p of arr(chan.product_ids) ?? []) { const id = str(p, 40); if (id && byId.has(id) && !subscribed.has(id)) { subscribed.add(id); onCoverage(base.coverage({ endpointId: 'ws-feed', subject: byId.get(id).subject, family: 'SPOT_FLOW', kind: 'TRADE', state: 'SUBSCRIBED', startTs: receivedTs, endTs: null, epochId })); } } } return; }
      if (!pid || !byId.has(pid)) { if (type === 'match' || type === 'snapshot' || type === 'l2update') stats.unknownSymbols += 1; return; }
      const m = byId.get(pid);
      if (type === 'match' || type === 'last_match') {
        if (type === 'last_match') return; // the initial last_match is history we did not witness live
        const price = num(msg.price); const qty = num(msg.size); const ts = tsFromIso(msg.time); const tid = int(msg.trade_id); const seqn = int(msg.sequence);
        if (price === null || qty === null || ts === null || tid === null) return;
        const taker = invertMaker(str(msg.side, 8));
        const ob = base.tryEmit({ endpointId: 'ws-feed', subject: m.subject, kind: 'TRADE', sourceKey: String(tid), sourceEventTs: ts, receivedTs, knownAtTs: receivedTs, epochId, quality: quality('KNOWN', { methodologyId: 'coinbase-exchange-matches-maker-side-v1', originalUnit: m.subject.quote }), provenance: { requestId: null, bytesSha256, nativeLocator: String(tid), mappingId: COINBASE_MAPPING_ID, specificationId: null, vintage: seqn !== null ? String(seqn) : null }, payload: { price, qty, quoteNotional: price * qty, takerSide: taker, sideConvention: taker === 'UNKNOWN' ? 'UNKNOWN' : 'MAKER_NATIVE_INVERTED', nativeTradeId: String(tid), orderType: null } });
        if (ob) { stats.trades += 1; onTrade(ob); }
        return;
      }
      const b = books.get(pid);
      if (type === 'snapshot') { const lv = (side) => (arr(msg[side]) ?? []).map((l) => ({ price: num(arr(l)?.[0]), qty: num(arr(l)?.[1]) })).filter((l) => l.price !== null && l.qty !== null); b.applySnapshot({ bids: lv('bids'), asks: lv('asks') }); lastSeq.set(pid, null); onCoverage(base.coverage({ endpointId: 'ws-feed', subject: m.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'OBSERVED', observationCount: 1, startTs: receivedTs, epochId })); }
      else if (type === 'l2update') {
        if (!b.synced) return;
        const bids = []; const asks = [];
        for (const ch of arr(msg.changes) ?? []) { const a = arr(ch); const side = str(a?.[0], 4); const price = num(a?.[1]); const qty = num(a?.[2]); if (price === null || qty === null) continue; (side === 'buy' ? bids : asks).push({ price, qty }); }
        b.applyUpdate({ bids, asks });
      } else return;
      const bb = b.bestBid(); const ba = b.bestAsk(); if (bb && ba && bb.price >= ba.price) { resync(pid, receivedTs); return; }
      stats.bookUpdates += 1;
      onBook({ market: m, receivedTs, epochId, synced: b.synced, checksumOk: null, pricePrecision: m.precision.pricePrecision, qtyPrecision: m.precision.qtyPrecision, levels: () => ({ bids: b.sortedBids().slice(0, depth).map((l) => [l.price, l.qty]), asks: b.sortedAsks().slice(0, depth).map((l) => [l.price, l.qty]) }) });
    }
    ws = createWsClient({ providerId: 'COINBASE_SPOT', endpointId: 'ws-feed', WebSocketImpl, clock: base.clock, log: base.log, url, onMessage, onOpen: ({ epochId, send }) => { currentEpoch = epochId; for (const b of books.values()) b.desync(); base.setRuntime('ACTIVE'); send({ type: 'subscribe', product_ids: [...byId.keys()], channels: ['matches', 'level2_batch'] }); }, onClose: ({ epochId }) => { const closeTs = base.clock(); for (const pid of [...subscribed]) endSubscription(pid, ['EPOCH_GAP', 'SUBSCRIPTION_ENDED'], closeTs); for (const [pid, b] of books) { if (b.synced) onCoverage(base.coverage({ endpointId: 'ws-feed', subject: byId.get(pid).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: ['EPOCH_GAP', 'DESYNCHRONIZED'], startTs: base.clock(), epochId })); b.desync(); } if (base.status().runtime === 'ACTIVE') base.setRuntime('DEGRADED'); } });
    return { start: () => { base.start(); ws.start(); }, stop: async () => { await ws.stop(); base.stop(); }, status: () => ({ ...ws.status(), ...stats, synced: [...books.values()].filter((b) => b.synced).length, subscribed: [...subscribed].sort() }), books };
  }
  function bookSnapshotObservation({ market, levels, receivedTs, epochId = null, synced, sampleReason = 'INTERVAL', bytesSha256 = null, bookAgeMs = 0 }) {
    return base.tryEmit({ endpointId: 'ws-feed', subject: market.subject, kind: 'BOOK_SNAPSHOT', sourceKey: null, receivedTs, knownAtTs: receivedTs, epochId, quality: quality(synced ? 'KNOWN' : 'PARTIAL', { reasonCodes: synced ? ['CHECKSUM_UNVERIFIED'] : ['DESYNCHRONIZED'], methodologyId: 'coinbase-exchange-level2-batch-v1', originalUnit: market.subject.quote }), provenance: { requestId: null, bytesSha256, nativeLocator: market.productId, mappingId: COINBASE_MAPPING_ID, specificationId: null, vintage: null }, payload: { bids: levels.bids.slice(0, 200), asks: levels.asks.slice(0, 200), levelsPerSideCap: 200, synchronized: synced, checksumVerified: null, bookAgeMs, sampleReason, pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision } });
  }
  return { ...base, loadProducts, resolveProduct, instrumentObservation, trades, book, candles, createStream, bookSnapshotObservation, products: () => products };
}
