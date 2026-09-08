// D04 — DERIBIT public: complete instrument census (one response, no pagination — the census is complete only when
// the whole response parsed), book summaries per currency (mark IV in documented PERCENT -> fraction), and per-instrument
// tickers (Greeks, bid/ask IV). Options exist where Deribit lists them (BTC/ETH and a few others), never synthesized.
import { createClientBase, num, int, str, bool, tsFromMs, arr, obj, derivativeSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';

export const DERIBIT_VENUE = 'deribit';
export const DERIBIT_MAPPING_ID = 'deribit-instruments-v2';
const FUNDING_8H_MS = 8 * 3_600_000;
export function createDeribitClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'DERIBIT', transport, clock, log });
  const census = new Map(); // currency -> { instruments: Map(name -> spec), receivedTs, complete }
  const specOf = (i) => {
    const name = str(i?.instrument_name, 60); const kind = str(i?.kind, 20); const base_ = str(i?.base_currency, 20); const quoteCcy = str(i?.quote_currency ?? i?.counter_currency, 20); const settle = str(i?.settlement_currency, 20);
    if (!name || !kind || !base_ || !settle) return null;
    const optionType = str(i.option_type, 8); const strike = num(i.strike); const expiry = tsFromMs(i.expiration_timestamp); const contractSize = num(i.contract_size);
    const marketType = kind === 'option' ? 'OPTION' : /PERPETUAL/.test(name) ? 'PERPETUAL' : 'FUTURE';
    if (marketType === 'OPTION' && (!optionType || strike === null || expiry === null)) return null;
    return { name, kind, base: base_, quote: quoteCcy ?? 'USD', settle, optionType: optionType === 'call' ? 'CALL' : optionType === 'put' ? 'PUT' : null, strike, expiry, contractSize, marketType, active: bool(i.is_active), linearity: str(i.instrument_type, 16) === 'linear' ? 'LINEAR' : 'INVERSE', specificationId: `${name}:${settle}:${contractSize ?? 'na'}`, priceIndex: str(i.price_index, 40) };
  };
  const subjectFor = (s) => derivativeSubject({ canonicalCoin: s.base, providerAssetId: s.priceIndex, venue: DERIBIT_VENUE, instrumentId: s.name, specificationId: s.specificationId, marketType: s.marketType });
  async function loadInstruments({ currency, kind = 'option', signal }) {
    const r = await base.call({ endpointId: 'get-instruments', query: { currency, kind, expired: 'false' }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [] };
    const list = arr(obj(r.json)?.result); if (!list) return { ok: false, failure: { kind: 'SCHEMA', reason: 'result missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const map = new Map(); const observations = []; let rejected = 0;
    for (const raw of list) { const s = specOf(obj(raw)); if (!s) { rejected += 1; continue; } map.set(s.name, s);
      const ob = base.tryEmit({ endpointId: 'get-instruments', subject: subjectFor(s), kind: 'INSTRUMENT', sourceKey: s.name, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: DERIBIT_MAPPING_ID }), provenance: base.provenance(r, { nativeLocator: s.name, mappingId: DERIBIT_MAPPING_ID, specificationId: s.specificationId }),
        payload: { status: s.active === false ? 'inactive' : 'open', base: s.base, quote: s.quote, marketType: s.marketType, pricePrecision: null, qtyPrecision: null, priceIncrement: num(raw.tick_size), qtyIncrement: num(raw.min_trade_amount), contractSize: s.contractSize, linearity: s.linearity, settlementCurrency: s.settle, underlying: s.priceIndex, expiryTs: s.marketType === 'PERPETUAL' ? null : s.expiry, strike: s.strike, optionType: s.optionType, quoteAliasGroup: null, tradeable: s.active, fundingIntervalMs: s.marketType === 'PERPETUAL' ? FUNDING_8H_MS : null, fundingUnit: s.marketType === 'PERPETUAL' ? 'FRACTION_PER_INTERVAL' : 'UNKNOWN' } });
      if (ob) observations.push(ob); }
    const complete = rejected === 0;
    census.set(`${currency}:${kind}`, deepFreeze({ instruments: map, receivedTs: r.receivedTs, complete, total: list.length, rejected, requestId: r.requestId, sha256: r.sha256 }));
    return { ok: true, observations, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs, total: list.length, rejected, complete } };
  }
  const censusOf = (currency, kind = 'option') => census.get(`${currency}:${kind}`) ?? null;
  async function bookSummaries({ currency, kind = 'option', signal }) {
    const c = censusOf(currency, kind); if (!c) return { ok: false, failure: { kind: 'SCHEMA', reason: 'census required before aggregates', coverageState: 'NOT_QUERIED', reasonCode: 'CENSUS_INCOMPLETE', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'get-book-summary-by-currency', query: { currency, kind }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [] };
    const out = []; let rejected = 0;
    for (const raw of arr(obj(r.json)?.result) ?? []) {
      const x = obj(raw); const s = x ? c.instruments.get(str(x.instrument_name, 60)) : null; if (!s) { rejected += 1; continue; }
      const ts = tsFromMs(x.creation_timestamp);
      if (s.marketType === 'OPTION') {
        const markIv = num(x.mark_iv); const oi = num(x.open_interest); const ob = base.tryEmit({ endpointId: 'get-book-summary-by-currency', subject: subjectFor(s), kind: 'OPTION_TICK', sourceKey: s.name, sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'deribit-book-summary-v2', originalUnit: 'iv percent' }), provenance: base.provenance(r, { nativeLocator: s.name, mappingId: DERIBIT_MAPPING_ID, specificationId: s.specificationId }),
          payload: { markIv: markIv === null ? null : markIv / 100, bidIv: null, askIv: null, delta: null, gamma: null, vega: null, theta: null, markPrice: num(x.mark_price), underlyingPrice: num(x.underlying_price), underlyingIndex: str(x.underlying_index, 40) ?? s.priceIndex ?? 'unknown', openInterest: oi, volume24h: num(x.volume), bid: num(x.bid_price), ask: num(x.ask_price), ivUnit: 'FRACTION', strike: s.strike, expiryTs: s.expiry, optionType: s.optionType, settlementCurrency: s.settle } });
        if (ob) out.push(ob); else rejected += 1;
      } else {
        const ob = base.tryEmit({ endpointId: 'get-book-summary-by-currency', subject: subjectFor(s), kind: 'DERIVATIVE_TICK', sourceKey: s.name, sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'deribit-book-summary-v2', originalUnit: s.settle }), provenance: base.provenance(r, { nativeLocator: s.name, mappingId: DERIBIT_MAPPING_ID, specificationId: s.specificationId }),
          payload: { markPrice: num(x.mark_price), indexPrice: num(x.estimated_delivery_price), lastPrice: num(x.last), bid: num(x.bid_price), ask: num(x.ask_price), openInterest: num(x.open_interest), openInterestUnit: s.linearity === 'INVERSE' ? 'USD' : 'BASE', fundingRateNative: s.marketType === 'PERPETUAL' ? num(x.funding_8h) : null, fundingUnit: s.marketType === 'PERPETUAL' && num(x.funding_8h) !== null ? 'FRACTION_PER_INTERVAL' : 'UNKNOWN', fundingIntervalMs: s.marketType === 'PERPETUAL' && num(x.funding_8h) !== null ? FUNDING_8H_MS : null, fundingRelative: null, fundingPredictedNative: s.marketType === 'PERPETUAL' ? num(x.current_funding) : null, nextFundingTs: null, volume24hBase: num(x.volume), volume24hQuote: num(x.volume_usd), contractMultiplier: s.contractSize, settlementCurrency: s.settle, linearity: s.linearity } });
        if (ob) out.push(ob); else rejected += 1;
      }
    }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs, rejected, censusComplete: c.complete } };
  }
  async function ticker({ instrumentName, signal }) {
    const s = [...census.values()].map((c) => c.instruments.get(instrumentName)).find(Boolean); if (!s) return { ok: false, failure: { kind: 'SCHEMA', reason: 'instrument not in census', coverageState: 'NOT_SUPPORTED', reasonCode: 'NOT_IN_CATALOG', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'ticker', query: { instrument_name: instrumentName }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'ticker', subject: subjectFor(s), family: s.marketType === 'OPTION' ? 'OPTIONS_TERM_SKEW' : 'DERIVATIVES_FUNDING_OI', startTs: base.clock() })] };
    const x = obj(obj(r.json)?.result); if (!x) return { ok: false, failure: { kind: 'SCHEMA', reason: 'result missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const g = obj(x.greeks) ?? {}; const ts = tsFromMs(x.timestamp);
    const ob = s.marketType === 'OPTION'
      ? base.tryEmit({ endpointId: 'ticker', subject: subjectFor(s), kind: 'OPTION_TICK', sourceKey: s.name, sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(num(x.mark_iv) !== null && num(g.delta) !== null ? 'KNOWN' : 'PARTIAL', { reasonCodes: num(x.mark_iv) !== null && num(g.delta) !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'deribit-ticker-v2', originalUnit: 'iv percent' }), provenance: base.provenance(r, { nativeLocator: s.name, mappingId: DERIBIT_MAPPING_ID, specificationId: s.specificationId }),
          payload: { markIv: num(x.mark_iv) === null ? null : num(x.mark_iv) / 100, bidIv: num(x.bid_iv) === null ? null : num(x.bid_iv) / 100, askIv: num(x.ask_iv) === null ? null : num(x.ask_iv) / 100, delta: num(g.delta), gamma: num(g.gamma), vega: num(g.vega), theta: num(g.theta), markPrice: num(x.mark_price), underlyingPrice: num(x.underlying_price), underlyingIndex: str(x.underlying_index, 40) ?? s.priceIndex ?? 'unknown', openInterest: num(x.open_interest), volume24h: num(obj(x.stats)?.volume), bid: num(x.best_bid_price), ask: num(x.best_ask_price), ivUnit: 'FRACTION', strike: s.strike, expiryTs: s.expiry, optionType: s.optionType, settlementCurrency: s.settle } })
      : base.tryEmit({ endpointId: 'ticker', subject: subjectFor(s), kind: 'DERIVATIVE_TICK', sourceKey: s.name, sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(num(x.mark_price) !== null && num(x.index_price) !== null ? 'KNOWN' : 'PARTIAL', { reasonCodes: num(x.mark_price) !== null && num(x.index_price) !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'deribit-ticker-v2', originalUnit: s.settle }), provenance: base.provenance(r, { nativeLocator: s.name, mappingId: DERIBIT_MAPPING_ID, specificationId: s.specificationId }),
          payload: { markPrice: num(x.mark_price), indexPrice: num(x.index_price), lastPrice: num(x.last_price), bid: num(x.best_bid_price), ask: num(x.best_ask_price), openInterest: num(x.open_interest), openInterestUnit: s.linearity === 'INVERSE' ? 'USD' : 'BASE', fundingRateNative: s.marketType === 'PERPETUAL' ? num(x.funding_8h) : null, fundingUnit: s.marketType === 'PERPETUAL' && num(x.funding_8h) !== null ? 'FRACTION_PER_INTERVAL' : 'UNKNOWN', fundingIntervalMs: s.marketType === 'PERPETUAL' && num(x.funding_8h) !== null ? FUNDING_8H_MS : null, fundingRelative: null, fundingPredictedNative: s.marketType === 'PERPETUAL' ? num(x.current_funding) : null, nextFundingTs: null, volume24hBase: num(obj(x.stats)?.volume), volume24hQuote: num(obj(x.stats)?.volume_usd), contractMultiplier: s.contractSize, settlementCurrency: s.settle, linearity: s.linearity } });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'ticker rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  return { ...base, loadInstruments, censusOf, bookSummaries, ticker, subjectFor };
}
