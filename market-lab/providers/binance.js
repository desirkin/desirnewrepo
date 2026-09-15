// D16 — BINANCE public spot market data (read-only reference sense for Strategy 6 / IFR): the public combined WebSocket
// stream (partial book depth + matched trades) and one REST catalog read (exchangeInfo). Binance spot is USDT-QUOTED; the
// quote recorded is the honest native USDT. A separate FROZEN-BASIS normalizer expresses a USDT price on a USD basis by
// holding USDT ≡ 1 USD as a FROZEN CONSTANT — never a live-tracked peg, so a moving USDT/USD rate can never leak into the
// cross-venue microstructure comparison. That frozen assumption is only trustworthy while the peg holds, so every USD-basis
// value passes a STABLECOIN-HEALTH GATE: without a fresh, near-peg USDT health reading the USD basis is UNKNOWN (fail-closed,
// never assumed 1). No trading credentials are used or required; nothing here can reach an order. Geographic restrictions
// apply to Binance from some regions (a 451/403 is ACCESS_BLOCKED, reported honestly and never evaded).
import { OrderBook } from '../../tape/book.js';
import { createClientBase, num, int, str, tsFromMs, arr, obj, bool, marketSubject } from './base.js';
import { createWsClient } from '../transport.js';
import { quality, deepFreeze, isCoin } from '../contracts.js';

export const BINANCE_VENUE = 'binance';
export const BINANCE_MAPPING_ID = 'binance-exchangeinfo-symbol-v1';
export const BINANCE_QUOTE = 'USDT';
// the FROZEN USD basis: USDT is held at exactly one USD, as a constant, forever. This is NOT a peg reading and never moves;
// the stablecoin-health gate — not this number — is what refuses the basis when the real peg is visibly broken.
export const FROZEN_USDT_USD_BASIS = 1;
export const BINANCE_BASIS_METHODOLOGY = 'USDT_FROZEN_AT_ONE_USD';
export const BINANCE_DEPTH_LEVELS = 20; // the partial-book depth stream ships the top 20 levels per side, self-contained
// the stablecoin-health gate defaults: the frozen USD basis is trusted only while the USDT peg is fresh and near parity
export const USDT_HEALTH_DEFAULTS = Object.freeze({ maxPegDeviationBps: 50, maxPegAgeMs: 6 * 3_600_000 });

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// PURE: does a USDT health reading permit the frozen USD basis? A missing / stale / off-peg reading fails CLOSED — the basis
// is UNKNOWN, never silently 1. health: { pegPrice, pegDeviationBps, ageMs } | null.
export function stablecoinHealthGate(health, cfg = USDT_HEALTH_DEFAULTS) {
  if (!health || typeof health !== 'object') return { healthy: false, reason: 'STABLECOIN_HEALTH_UNKNOWN' };
  const { pegDeviationBps = null, ageMs = null } = health;
  if (!finite(pegDeviationBps)) return { healthy: false, reason: 'STABLECOIN_HEALTH_UNKNOWN' };
  if (!finite(ageMs) || ageMs > cfg.maxPegAgeMs) return { healthy: false, reason: 'STABLECOIN_HEALTH_STALE' };
  if (Math.abs(pegDeviationBps) > cfg.maxPegDeviationBps) return { healthy: false, reason: 'STABLECOIN_DEPEGGED' };
  return { healthy: true, reason: null };
}

// PURE: a native USDT price expressed on the frozen USD basis, gated by stablecoin health. Unhealthy -> usd is null (UNKNOWN),
// never a guessed conversion. Healthy -> usd = usdt * FROZEN_USDT_USD_BASIS (== usdt; the frozen constant is exactly one).
export function usdBasisFromUsdt(usdtPrice, health, cfg = USDT_HEALTH_DEFAULTS) {
  const gate = stablecoinHealthGate(health, cfg);
  if (!finite(usdtPrice) || usdtPrice <= 0) return { usd: null, healthy: gate.healthy, reason: gate.healthy ? 'PRICE_UNAVAILABLE' : gate.reason, basis: FROZEN_USDT_USD_BASIS };
  if (!gate.healthy) return { usd: null, healthy: false, reason: gate.reason, basis: FROZEN_USDT_USD_BASIS };
  return { usd: usdtPrice * FROZEN_USDT_USD_BASIS, healthy: true, reason: null, basis: FROZEN_USDT_USD_BASIS };
}

export function createBinanceClient({ transport, clock, log, stablecoinHealth = () => null } = {}) {
  const base = createClientBase({ providerId: 'BINANCE_SPOT', transport, clock, log });
  let catalog = null; // { list, observedTs, requestId, sha256 }

  // ---- catalog / identity (exchangeInfo; one symbol per call to bound the body) --------------------------------------
  async function loadCatalog({ symbols = null, signal } = {}) {
    const query = Array.isArray(symbols) && symbols.length ? { symbols: JSON.stringify(symbols) } : {};
    const r = await base.call({ endpointId: 'rest-exchange-info', query, signal });
    if (!r.ok) return r;
    const rows = arr(obj(r.json)?.symbols);
    if (!rows) return { ok: false, failure: { kind: 'SCHEMA', reason: 'exchangeInfo symbols missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    const list = [];
    for (const raw of rows) {
      const s = obj(raw); const symbol = str(s?.symbol, 40); const b = str(s?.baseAsset, 20); const q = str(s?.quoteAsset, 20); const status = str(s?.status, 20);
      if (!symbol || !b || !q || !status || symbol !== `${b}${q}`) continue;
      const filters = arr(s.filters) ?? [];
      const price = filters.map(obj).find((f) => f && f.filterType === 'PRICE_FILTER');
      const lot = filters.map(obj).find((f) => f && f.filterType === 'LOT_SIZE');
      list.push({ symbol, base: b, quote: q, status, spotTradingAllowed: bool(s.isSpotTradingAllowed) ?? null, pricePrecision: decimalsOfIncrement(price?.tickSize), qtyPrecision: decimalsOfIncrement(lot?.stepSize), priceIncrement: num(price?.tickSize), qtyIncrement: num(lot?.stepSize) });
    }
    catalog = deepFreeze({ list, observedTs: r.receivedTs, requestId: r.requestId, sha256: r.sha256 });
    return { ok: true, catalog };
  }
  // Resolve ONE requested subject against the real catalog. USDT quote only; ambiguity or absence rejects — never suffix matching.
  function resolveMarket({ canonicalCoin, nativeSymbol = null }) {
    if (!catalog) return { ok: false, reason: 'CATALOG_NOT_LOADED' };
    if (!isCoin(canonicalCoin)) return { ok: false, reason: 'COIN_MALFORMED' };
    const c = catalog.list.filter((m) => m.base === canonicalCoin && m.quote === BINANCE_QUOTE && m.status === 'TRADING' && (nativeSymbol === null || m.symbol === nativeSymbol));
    if (c.length === 0) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (c.length > 1) return { ok: false, reason: 'AMBIGUOUS_MAPPING', candidates: c.map((m) => m.symbol) };
    const m = c[0];
    return { ok: true, market: deepFreeze({ subject: marketSubject({ canonicalCoin, providerAssetId: m.base, venue: BINANCE_VENUE, nativeSymbol: m.symbol, base: m.base, quote: BINANCE_QUOTE, marketType: 'SPOT', quoteAliasGroup: null }), symbol: m.symbol, streamSymbol: m.symbol.toLowerCase(), precision: { pricePrecision: m.pricePrecision, qtyPrecision: m.qtyPrecision, priceIncrement: m.priceIncrement, qtyIncrement: m.qtyIncrement }, mappingKnownAtTs: catalog.observedTs, spotTradingAllowed: m.spotTradingAllowed }) };
  }
  function instrumentObservation(market, receivedTs) {
    return base.tryEmit({ endpointId: 'rest-exchange-info', subject: market.subject, kind: 'INSTRUMENT', sourceKey: market.symbol, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: BINANCE_MAPPING_ID }), provenance: base.provenance({ requestId: catalog?.requestId, sha256: catalog?.sha256 }, { nativeLocator: market.symbol, mappingId: BINANCE_MAPPING_ID }),
      payload: { status: 'online', base: market.subject.base, quote: BINANCE_QUOTE, marketType: 'SPOT', pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision, priceIncrement: market.precision.priceIncrement, qtyIncrement: market.precision.qtyIncrement, contractSize: null, linearity: 'NOT_APPLICABLE', settlementCurrency: BINANCE_QUOTE, underlying: null, expiryTs: null, strike: null, optionType: null, quoteAliasGroup: null, tradeable: market.spotTradingAllowed === false ? false : true, fundingIntervalMs: null, fundingUnit: 'UNKNOWN' } });
  }

  // ---- WebSocket (combined stream: <symbol>@depth20@100ms self-contained top-of-book + <symbol>@trade) -----------------
  // The partial-book depth stream ships a COMPLETE top-N book every push, so there is no diff/sequence state to keep and no
  // REST snapshot to reconcile: each message REPLACES the book. A crossed book is never admitted. onTrade(observation),
  // onBook({ market, receivedTs, epochId, synced, levels() }), onCoverage(record). USDT prices are the native truth here;
  // the frozen USD basis is applied by the reader through usdBasisMid, never baked into the recorded observation.
  function combinedStreamUrl(markets) {
    const streams = markets.flatMap((m) => [`${m.streamSymbol}@depth${BINANCE_DEPTH_LEVELS}@100ms`, `${m.streamSymbol}@trade`]);
    return `wss://stream.binance.com/stream?streams=${streams.join('/')}`;
  }
  function createStream({ markets, depth = BINANCE_DEPTH_LEVELS, onTrade = () => {}, onBook = () => {}, onCoverage = () => {}, WebSocketImpl, url = null }) {
    const bySym = new Map(markets.map((m) => [m.streamSymbol, m]));
    const books = new Map(markets.map((m) => [m.streamSymbol, new OrderBook(m.symbol, depth)]));
    for (const m of markets) if (m.precision) books.get(m.streamSymbol).setPrecision(m.precision.pricePrecision, m.precision.qtyPrecision);
    const stats = { trades: 0, bookUpdates: 0, resyncs: 0, unknownSymbols: 0 }; let ws = null; let currentEpoch = null; const seen = new Set();
    const streamOf = (name) => { const i = String(name ?? '').indexOf('@'); return i < 0 ? { sym: null, channel: null } : { sym: name.slice(0, i), channel: name.slice(i + 1) }; };
    function onMessage(msg, { receivedTs, epochId, bytesSha256 }) {
      const env = obj(msg); const streamName = str(env?.stream, 80); const data = obj(env?.data);
      if (!streamName || !data) return; // combined-stream envelope only; a method-ack / error carries no stream+data
      const { sym, channel } = streamOf(streamName); const m = sym ? bySym.get(sym) : null;
      if (!m) { stats.unknownSymbols += 1; return; }
      if (channel && channel.startsWith('trade')) {
        const price = num(data.p); const qty = num(data.q); const ts = tsFromMs(data.T); const tid = int(data.t); const buyerMaker = bool(data.m);
        if (price === null || qty === null || ts === null) return;
        const taker = buyerMaker === true ? 'SELL' : buyerMaker === false ? 'BUY' : 'UNKNOWN'; // m = buyer is maker -> the aggressor (taker) is the seller
        const ob = base.tryEmit({ endpointId: 'ws-combined', subject: m.subject, kind: 'TRADE', sourceKey: tid !== null ? String(tid) : null, sourceEventTs: ts, receivedTs, knownAtTs: receivedTs, epochId, quality: quality('KNOWN', { methodologyId: 'binance-ws-trade-v1', originalUnit: BINANCE_QUOTE }), provenance: { requestId: null, bytesSha256, nativeLocator: tid !== null ? String(tid) : null, mappingId: BINANCE_MAPPING_ID, specificationId: null, vintage: null },
          payload: { price, qty, quoteNotional: price * qty, takerSide: taker, sideConvention: taker === 'UNKNOWN' ? 'UNKNOWN' : 'MAKER_NATIVE_INVERTED', nativeTradeId: tid !== null ? String(tid) : null, orderType: null } });
        if (ob) { stats.trades += 1; onTrade(ob); }
        return;
      }
      if (channel && channel.startsWith(`depth${depth}`)) {
        const b = books.get(sym);
        const lv = (side) => (arr(data[side]) ?? []).map((l) => ({ price: num(arr(l)?.[0]), qty: num(arr(l)?.[1]) })).filter((x) => x.price !== null && x.qty !== null && x.price > 0 && x.qty >= 0);
        b.applySnapshot({ bids: lv('bids'), asks: lv('asks') });
        const bb = b.bestBid(); const ba = b.bestAsk();
        if (bb && ba && bb.price >= ba.price) { b.desync(); stats.resyncs += 1; onCoverage(base.coverage({ endpointId: 'ws-combined', subject: m.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: ['DESYNCHRONIZED'], startTs: receivedTs, epochId: currentEpoch })); return; } // a crossed book is never admitted
        if (!seen.has(sym)) { seen.add(sym); onCoverage(base.coverage({ endpointId: 'ws-combined', subject: m.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'OBSERVED', observationCount: 1, startTs: receivedTs, epochId: currentEpoch })); }
        stats.bookUpdates += 1;
        onBook({ market: m, receivedTs, epochId, synced: b.synced, checksumOk: null, pricePrecision: b.pricePrecision, qtyPrecision: b.qtyPrecision, levels: () => ({ bids: b.sortedBids().slice(0, depth).map((l) => [l.price, l.qty]), asks: b.sortedAsks().slice(0, depth).map((l) => [l.price, l.qty]) }) });
      }
    }
    ws = createWsClient({ providerId: 'BINANCE_SPOT', endpointId: 'ws-combined', WebSocketImpl, clock: base.clock, log: base.log, url: url ?? combinedStreamUrl(markets), onMessage,
      onOpen: ({ epochId }) => { currentEpoch = epochId; for (const b of books.values()) b.desync(); seen.clear(); base.setRuntime('ACTIVE'); },
      onClose: ({ epochId }) => { const ts = base.clock(); for (const [sym, b] of books) { if (b.synced) onCoverage(base.coverage({ endpointId: 'ws-combined', subject: bySym.get(sym).subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_COVERAGE', state: 'GAP', reasonCodes: ['EPOCH_GAP', 'DESYNCHRONIZED'], startTs: ts, epochId })); b.desync(); } seen.clear(); if (base.status().runtime === 'ACTIVE') base.setRuntime('DEGRADED'); } });
    return { start: () => { base.start(); ws.start(); }, stop: async () => { await ws.stop(); base.stop(); }, status: () => ({ ...ws.status(), ...stats, synced: [...books.values()].filter((b) => b.synced).length, members: [...bySym.keys()] }), books, streamUrl: () => combinedStreamUrl(markets) };
  }

  function bookSnapshotObservation({ market, levels, receivedTs, epochId = null, synced, sampleReason = 'INTERVAL', bytesSha256 = null, bookAgeMs = 0 }) {
    return base.tryEmit({ endpointId: 'ws-combined', subject: market.subject, kind: 'BOOK_SNAPSHOT', sourceKey: null, receivedTs, knownAtTs: receivedTs, epochId, quality: quality(synced ? 'KNOWN' : 'PARTIAL', { reasonCodes: synced ? [] : ['DESYNCHRONIZED'], methodologyId: 'binance-ws-partial-depth-v1', originalUnit: BINANCE_QUOTE }), provenance: { requestId: null, bytesSha256, nativeLocator: market.symbol, mappingId: BINANCE_MAPPING_ID, specificationId: null, vintage: null }, payload: { bids: levels.bids.slice(0, 200), asks: levels.asks.slice(0, 200), levelsPerSideCap: 200, synchronized: synced, checksumVerified: null, bookAgeMs, sampleReason, pricePrecision: market.precision?.pricePrecision ?? null, qtyPrecision: market.precision?.qtyPrecision ?? null } });
  }

  // The FROZEN-BASIS reference reader: the current mid on the USD basis, gated by stablecoin health. This is a plain fact
  // object (NOT an observation) for the cross-venue episode assembler — the native USDT mid is always given; the usd field
  // is null when the health gate refuses. The health reading comes from the injected accessor, never from this module.
  function usdBasisMid({ market, book, health = stablecoinHealth(), cfg = USDT_HEALTH_DEFAULTS } = {}) {
    const b = book ?? null; const bb = b?.bestBid?.() ?? null; const ba = b?.bestAsk?.() ?? null;
    const usdtMid = bb && ba ? (bb.price + ba.price) / 2 : null;
    const g = usdBasisFromUsdt(usdtMid, health, cfg);
    return deepFreeze({ venue: BINANCE_VENUE, symbol: market?.symbol ?? null, quote: BINANCE_QUOTE, usdtMid, usdMid: g.usd, basis: FROZEN_USDT_USD_BASIS, basisMethodology: BINANCE_BASIS_METHODOLOGY, stablecoinHealthy: g.healthy, stablecoinReason: g.reason, synced: b?.synced ?? false });
  }

  return { ...base, loadCatalog, resolveMarket, instrumentObservation, createStream, bookSnapshotObservation, usdBasisMid, stablecoinHealthGate: (h, cfg) => stablecoinHealthGate(h, cfg), usdBasisFromUsdt: (p, h, cfg) => usdBasisFromUsdt(p, h, cfg), catalog: () => catalog };
}

const decimalsOfIncrement = (s) => { const n = num(s); if (n === null || n <= 0) return null; const t = String(s); const i = t.indexOf('.'); if (i < 0) return 0; const frac = t.slice(i + 1).replace(/0+$/, ''); return frac.length; };
