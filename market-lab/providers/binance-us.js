// D18 — BINANCE.US public market data (read-only reference book for Strategy 6 / IFR). The public v3 REST endpoints only:
// exchangeInfo (the instrument catalog) and depth (the L2 book). No trading credentials are used or required. Binance.US is
// a US-domiciled venue that quotes USD directly (BTCUSD, ETHUSD, …), so — unlike Binance global's USDT quote — its mid is
// already a USD basis and needs no stablecoin-health gate. It answers HTTP 200 from this environment (api.binance.us is not
// geo-blocked here, where api.binance.com returns 451), which makes it a third clean USD-direct reference alongside Coinbase
// and Bitstamp: whichever answer at boot back the IFR isolation, ≥1 reachable. Same REST shapes as Binance global (symbol ==
// baseAsset+quoteAsset, filters PRICE_FILTER.tickSize / LOT_SIZE.stepSize; depth == { lastUpdateId, bids, asks }).
import { createClientBase, num, int, str, arr, obj, bool, marketSubject } from './base.js';
import { quality, deepFreeze, isCoin } from '../contracts.js';

export const BINANCE_US_VENUE = 'binanceus';
export const BINANCE_US_MAPPING_ID = 'binance-us-exchangeinfo-symbol-v1';
export const BINANCE_US_USD_ALIAS_GROUP = 'BINANCE_US_USD';
const decimalsOfIncrement = (s) => { const n = num(s); if (n === null || n <= 0) return null; const t = String(s); const i = t.indexOf('.'); if (i < 0) return 0; const frac = t.slice(i + 1).replace(/0+$/, ''); return frac.length; };

export function createBinanceUsClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'BINANCE_US_SPOT', transport, clock, log });
  let catalog = null; // { list, observedTs, requestId, sha256 }
  // exchangeInfo: { symbols: [{ symbol, status "TRADING", baseAsset, quoteAsset, filters [PRICE_FILTER.tickSize, LOT_SIZE.stepSize] }] }
  async function loadProducts({ symbols = null, signal } = {}) {
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
  // Resolve ONE requested subject against the real catalog. USD quote only (native USD basis); ambiguity or absence rejects.
  function resolveProduct({ canonicalCoin, nativeSymbol = null, quote = 'USD' }) {
    if (!catalog) return { ok: false, reason: 'CATALOG_NOT_LOADED' };
    if (!isCoin(canonicalCoin)) return { ok: false, reason: 'COIN_MALFORMED' };
    const c = catalog.list.filter((m) => m.base === canonicalCoin && m.status === 'TRADING' && (nativeSymbol !== null ? m.symbol === nativeSymbol : m.quote === quote));
    if (c.length === 0) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (c.length > 1) return { ok: false, reason: 'AMBIGUOUS_MAPPING', candidates: c.map((m) => m.symbol) };
    const m = c[0];
    return { ok: true, market: deepFreeze({ subject: marketSubject({ canonicalCoin, providerAssetId: m.base, venue: BINANCE_US_VENUE, nativeSymbol: m.symbol, base: m.base, quote: m.quote, marketType: 'SPOT', quoteAliasGroup: m.quote === 'USD' ? BINANCE_US_USD_ALIAS_GROUP : null }), symbol: m.symbol, precision: { pricePrecision: m.pricePrecision, qtyPrecision: m.qtyPrecision, priceIncrement: m.priceIncrement, qtyIncrement: m.qtyIncrement }, mappingKnownAtTs: catalog.observedTs, spotTradingAllowed: m.spotTradingAllowed }) };
  }
  function instrumentObservation(market, receivedTs) {
    return base.tryEmit({ endpointId: 'rest-exchange-info', subject: market.subject, kind: 'INSTRUMENT', sourceKey: market.symbol, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: BINANCE_US_MAPPING_ID }), provenance: base.provenance({ requestId: catalog?.requestId, sha256: catalog?.sha256 }, { nativeLocator: market.symbol, mappingId: BINANCE_US_MAPPING_ID }),
      payload: { status: 'online', base: market.subject.base, quote: market.subject.quote, marketType: 'SPOT', pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision, priceIncrement: market.precision.priceIncrement, qtyIncrement: market.precision.qtyIncrement, contractSize: null, linearity: 'NOT_APPLICABLE', settlementCurrency: market.subject.quote, underlying: null, expiryTs: null, strike: null, optionType: null, quoteAliasGroup: market.subject.quoteAliasGroup, tradeable: market.spotTradingAllowed === false ? false : true, fundingIntervalMs: null, fundingUnit: 'UNKNOWN' } });
  }
  // depth: { lastUpdateId, bids: [[price, qty], ...], asks: [...] } — aggregated L2 snapshot (no event clock; receipt time is
  // the only knowable time, so bookAgeMs = 0 and sourceEventTs = null: a REST snapshot is never given a fabricated event ts).
  async function book({ market, limit = 200, signal }) {
    const r = await base.call({ endpointId: 'rest-order-book', query: { symbol: market.symbol, limit }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-order-book', subject: market.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_SNAPSHOT', startTs: base.clock() })] };
    const j = obj(r.json);
    const lv = (side) => (arr(j?.[side]) ?? []).map((l) => [num(arr(l)?.[0]), num(arr(l)?.[1])]).filter((l) => l[0] !== null && l[1] !== null && l[0] > 0 && l[1] >= 0).slice(0, 200);
    const bids = lv('bids'); const asks = lv('asks');
    const ob = base.tryEmit({ endpointId: 'rest-order-book', subject: market.subject, kind: 'BOOK_SNAPSHOT', sourceKey: int(j?.lastUpdateId) !== null ? String(j.lastUpdateId) : null, sourceEventTs: null, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: 'binance-us-depth-v3', originalUnit: market.subject.quote }), provenance: base.provenance(r, { nativeLocator: market.symbol, mappingId: BINANCE_US_MAPPING_ID }),
      payload: { bids, asks, levelsPerSideCap: 200, synchronized: true, checksumVerified: null, bookAgeMs: 0, sampleReason: 'REST_SNAPSHOT', pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision } });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'book rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  // the size-aware executable bid: walk the bid side for the requested quote notional (the IFR recovery reference).
  function executableBid({ observation, quoteNotional }) {
    const bids = observation?.payload?.bids; if (!Array.isArray(bids) || !bids.length || !(quoteNotional > 0)) return null;
    let remaining = quoteNotional; let lastPrice = null;
    for (const [price, qty] of bids) { if (!(price > 0) || !(qty > 0)) continue; lastPrice = price; const value = price * qty; if (value >= remaining) return price; remaining -= value; }
    return lastPrice; // the book was too thin to fill the whole size; the deepest touched price is the honest floor
  }
  return { ...base, loadProducts, resolveProduct, instrumentObservation, book, executableBid, catalog: () => catalog };
}
