// D17 — BITSTAMP public market data (read-only reference book for Strategy 6 / IFR). The public v2 REST endpoints only:
// trading-pairs-info (the instrument catalog) and order_book (the L2 book). No trading credentials are used or required.
// Bitstamp quotes USD directly (btcusd, ethusd, …), so — unlike Binance's USDT quote — its mid is already a USD basis and
// needs no stablecoin-health gate; it is a clean third reference alongside Coinbase (also USD-direct) and Binance. Reachable
// from this environment (no geo-block), which is exactly why it is the fallback reference when Binance answers 451.
import { createClientBase, num, int, str, tsFromSeconds, arr, obj, marketSubject } from './base.js';
import { quality, deepFreeze, isCoin } from '../contracts.js';

export const BITSTAMP_VENUE = 'bitstamp';
export const BITSTAMP_MAPPING_ID = 'bitstamp-trading-pairs-v2';
export const BITSTAMP_USD_ALIAS_GROUP = 'BITSTAMP_USD';
const decimalsToIncrement = (d) => (Number.isSafeInteger(d) && d >= 0 && d <= 18 ? Number(`1e-${d}`) : null);

export function createBitstampClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'BITSTAMP_SPOT', transport, clock, log });
  let products = null;
  // trading-pairs-info: [{ name: "BTC/USD", url_symbol: "btcusd", base_decimals, counter_decimals, trading: "Enabled", ... }]
  async function loadProducts({ signal } = {}) {
    const r = await base.call({ endpointId: 'rest-trading-pairs-info', query: {}, signal });
    if (!r.ok) return r;
    const rows = arr(r.json); if (!rows) return { ok: false, failure: { kind: 'SCHEMA', reason: 'trading-pairs-info not an array', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    const list = [];
    for (const raw of rows) {
      const p = obj(raw); if (!p) continue;
      const name = str(p.name, 40); const urlSymbol = str(p.url_symbol, 40); const trading = str(p.trading, 20);
      if (!name || !urlSymbol || !trading) continue;
      const parts = name.split('/'); if (parts.length !== 2) continue;
      const b = str(parts[0], 20); const q = str(parts[1], 20); if (!b || !q) continue;
      const priceDecimals = int(p.counter_decimals); const qtyDecimals = int(p.base_decimals);
      list.push({ urlSymbol, base: b, quote: q, trading, pricePrecision: priceDecimals, qtyPrecision: qtyDecimals, priceIncrement: decimalsToIncrement(priceDecimals), qtyIncrement: decimalsToIncrement(qtyDecimals) });
    }
    products = deepFreeze({ list, observedTs: r.receivedTs, requestId: r.requestId, sha256: r.sha256 });
    return { ok: true, products };
  }
  function resolveProduct({ canonicalCoin, urlSymbol = null, quote = 'USD' }) {
    if (!products) return { ok: false, reason: 'CATALOG_NOT_LOADED' };
    if (!isCoin(canonicalCoin)) return { ok: false, reason: 'COIN_MALFORMED' };
    const c = products.list.filter((p) => p.base === canonicalCoin && p.trading === 'Enabled' && (urlSymbol !== null ? p.urlSymbol === urlSymbol : p.quote === quote));
    if (c.length === 0) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (c.length > 1) return { ok: false, reason: 'AMBIGUOUS_MAPPING', candidates: c.map((p) => p.urlSymbol) };
    const p = c[0];
    return { ok: true, market: deepFreeze({ subject: marketSubject({ canonicalCoin, providerAssetId: p.base, venue: BITSTAMP_VENUE, nativeSymbol: p.urlSymbol, base: p.base, quote: p.quote, marketType: 'SPOT', quoteAliasGroup: p.quote === 'USD' ? BITSTAMP_USD_ALIAS_GROUP : null }), urlSymbol: p.urlSymbol, precision: { pricePrecision: p.pricePrecision, qtyPrecision: p.qtyPrecision, priceIncrement: p.priceIncrement, qtyIncrement: p.qtyIncrement }, mappingKnownAtTs: products.observedTs }) };
  }
  function instrumentObservation(market, receivedTs) {
    return base.tryEmit({ endpointId: 'rest-trading-pairs-info', subject: market.subject, kind: 'INSTRUMENT', sourceKey: market.urlSymbol, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: BITSTAMP_MAPPING_ID }), provenance: base.provenance({ requestId: products?.requestId, sha256: products?.sha256 }, { nativeLocator: market.urlSymbol, mappingId: BITSTAMP_MAPPING_ID }),
      payload: { status: 'online', base: market.subject.base, quote: market.subject.quote, marketType: 'SPOT', pricePrecision: market.precision.pricePrecision, qtyPrecision: market.precision.qtyPrecision, priceIncrement: market.precision.priceIncrement, qtyIncrement: market.precision.qtyIncrement, contractSize: null, linearity: 'NOT_APPLICABLE', settlementCurrency: market.subject.quote, underlying: null, expiryTs: null, strike: null, optionType: null, quoteAliasGroup: market.subject.quoteAliasGroup, tradeable: true, fundingIntervalMs: null, fundingUnit: 'UNKNOWN' } });
  }
  // order_book: { timestamp (epoch s), microtimestamp, bids: [[price, amount], ...], asks: [...] } — full L2 aggregated book.
  async function book({ market, signal }) {
    const r = await base.call({ endpointId: 'rest-order-book', pathParams: { url_symbol: market.urlSymbol }, query: {}, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-order-book', subject: market.subject, family: 'DISPLAYED_LIQUIDITY', kind: 'BOOK_SNAPSHOT', startTs: base.clock() })] };
    const j = obj(r.json);
    const lv = (side) => (arr(j?.[side]) ?? []).map((l) => [num(arr(l)?.[0]), num(arr(l)?.[1])]).filter((l) => l[0] !== null && l[1] !== null && l[0] > 0 && l[1] >= 0).slice(0, 200);
    const bids = lv('bids'); const asks = lv('asks');
    const ob = base.tryEmit({ endpointId: 'rest-order-book', subject: market.subject, kind: 'BOOK_SNAPSHOT', sourceKey: null, sourceEventTs: tsFromSeconds(j?.timestamp), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: 'bitstamp-order-book-v2', originalUnit: market.subject.quote }), provenance: base.provenance(r, { nativeLocator: market.urlSymbol, mappingId: BITSTAMP_MAPPING_ID }),
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
  return { ...base, loadProducts, resolveProduct, instrumentObservation, book, executableBid, products: () => products };
}
