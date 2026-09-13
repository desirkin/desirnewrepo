// D03 — KRAKEN DERIVATIVES public: instrument specifications, tickers (mark / index / OI / funding), hourly funding
// history. Native funding is preserved exactly as documented: `fundingRate` is an ABSOLUTE amount per contract per
// hour; `relativeFundingRate` (history) or fundingRate / markPrice (ticker, documented derivation) is the dimensionless
// form. Nothing here pretends an absolute native number is already a percentage.
import { createClientBase, num, int, str, bool, tsFromIso, arr, obj, derivativeSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';
import { HOUR_MS } from '../time.js';

export const KRAKEN_FUTURES_VENUE = 'kraken-futures';
export const KRAKEN_FUTURES_MAPPING_ID = 'kraken-futures-symbol-v1';
const SYMBOL_RE = /^(P[FI]|F[FI])_([A-Z0-9]+?)(USD|USDT|EUR)(?:_(\d{6}))?$/;
const ALIASES = { XBT: 'BTC', XDG: 'DOGE' };
export function parseKrakenFuturesSymbol(symbol) {
  const m = SYMBOL_RE.exec(symbol ?? ''); if (!m) return null;
  const family = m[1]; const base = ALIASES[m[2]] ?? m[2];
  return { base, quote: m[3], perpetual: family === 'PF' || family === 'PI', linearity: family === 'PF' || family === 'FF' ? 'LINEAR' : 'INVERSE', expiry: m[4] ?? null };
}
export function createKrakenDerivativesClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'KRAKEN_DERIVATIVES', transport, clock, log });
  let specs = null; // symbol -> spec
  const subjectFor = (symbol, spec) => derivativeSubject({ canonicalCoin: spec.base, providerAssetId: spec.pair ?? null, venue: KRAKEN_FUTURES_VENUE, instrumentId: symbol, specificationId: spec.specificationId, marketType: spec.perpetual ? 'PERPETUAL' : 'FUTURE' });
  async function loadInstruments({ signal } = {}) {
    const r = await base.call({ endpointId: 'rest-instruments', query: {}, signal });
    if (!r.ok) return r;
    const j = obj(r.json); if (str(j?.result, 16) !== 'success' || !arr(j?.instruments)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'instruments malformed', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    const out = {}; const observations = [];
    for (const raw of j.instruments) {
      const i = obj(raw); const symbol = str(i?.symbol, 40); const parsed = symbol ? parseKrakenFuturesSymbol(symbol) : null; if (!parsed) continue;
      const contractSize = num(i.contractSize); const tickSize = num(i.tickSize); const tradeable = bool(i.tradeable); const type = str(i.type, 32);
      const spec = { symbol, type, contractSize, tickSize, tradeable, ...parsed, specificationId: `${symbol}:${type ?? 'unknown'}:${contractSize ?? 'na'}`, pair: null, lastTradingTime: tsFromIso(i.lastTradingTime) };
      out[symbol] = spec;
      const ob = base.tryEmit({ endpointId: 'rest-instruments', subject: subjectFor(symbol, spec), kind: 'INSTRUMENT', sourceKey: symbol, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: KRAKEN_FUTURES_MAPPING_ID }), provenance: base.provenance(r, { nativeLocator: symbol, mappingId: KRAKEN_FUTURES_MAPPING_ID, specificationId: spec.specificationId }),
        payload: { status: tradeable === false ? 'suspended' : 'tradeable', base: parsed.base, quote: parsed.quote, marketType: parsed.perpetual ? 'PERPETUAL' : 'FUTURE', pricePrecision: null, qtyPrecision: null, priceIncrement: tickSize, qtyIncrement: null, contractSize, linearity: parsed.linearity, settlementCurrency: parsed.linearity === 'INVERSE' ? parsed.base : parsed.quote, underlying: `${parsed.base}:${parsed.quote}`, expiryTs: spec.lastTradingTime, strike: null, optionType: null, quoteAliasGroup: null, tradeable, fundingIntervalMs: parsed.perpetual ? HOUR_MS : null, fundingUnit: parsed.perpetual ? 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL' : 'UNKNOWN' } });
      if (ob) observations.push(ob);
    }
    specs = deepFreeze(out);
    return { ok: true, observations, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs, count: observations.length } };
  }
  const resolveInstrument = (symbol) => (specs && specs[symbol] ? { ok: true, spec: specs[symbol], subject: subjectFor(symbol, specs[symbol]) } : { ok: false, reason: specs ? 'NOT_IN_CATALOG' : 'CATALOG_NOT_LOADED' });
  async function tickers({ symbols, signal }) {
    const out = []; const coverage = [];
    for (const symbol of symbols) {
      const res = resolveInstrument(symbol); if (!res.ok) continue;
      const r = await base.call({ endpointId: 'rest-tickers', query: { symbol }, signal });
      if (!r.ok) { coverage.push(base.failureCoverage(r.failure, { endpointId: 'rest-tickers', subject: res.subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK', startTs: base.clock() })); continue; }
      const t = (arr(obj(r.json)?.tickers) ?? []).map(obj).find((x) => x && x.symbol === symbol);
      if (!t) { coverage.push(base.coverage({ endpointId: 'rest-tickers', subject: res.subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK', state: 'GAP', reasonCodes: ['FIELD_MISSING_AT_SOURCE'], startTs: r.receivedTs, endTs: r.receivedTs })); continue; }
      const mark = num(t.markPrice); const index = num(t.indexPrice); const fr = num(t.fundingRate); const oi = num(t.openInterest);
      const ob = base.tryEmit({ endpointId: 'rest-tickers', subject: res.subject, kind: 'DERIVATIVE_TICK', sourceKey: symbol, sourceEventTs: tsFromIso(t.lastTime), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(mark !== null && index !== null ? 'KNOWN' : 'PARTIAL', { reasonCodes: mark !== null && index !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'kraken-futures-ticker-v3', originalUnit: `absolute ${res.spec.quote} per contract per hour` }), provenance: base.provenance(r, { nativeLocator: symbol, mappingId: KRAKEN_FUTURES_MAPPING_ID, specificationId: res.spec.specificationId }),
        payload: { markPrice: mark, indexPrice: index, lastPrice: num(t.last), bid: num(t.bid), ask: num(t.ask), openInterest: oi, openInterestUnit: oi === null ? 'UNKNOWN' : 'CONTRACTS', fundingRateNative: res.spec.perpetual ? fr : null, fundingUnit: res.spec.perpetual && fr !== null ? 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL' : 'UNKNOWN', fundingIntervalMs: res.spec.perpetual && fr !== null ? HOUR_MS : null, fundingRelative: res.spec.perpetual && fr !== null && mark !== null && mark > 0 ? fr / mark : null, fundingPredictedNative: res.spec.perpetual ? num(t.fundingRatePrediction) : null, nextFundingTs: null, volume24hBase: num(t.vol24h), volume24hQuote: num(t.volumeQuote), contractMultiplier: res.spec.contractSize, settlementCurrency: res.spec.linearity === 'INVERSE' ? res.spec.base : res.spec.quote, linearity: res.spec.linearity } });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage, meta: {} };
  }
  async function fundingHistory({ symbol, signal, maxRates = 720 }) {
    const res = resolveInstrument(symbol); if (!res.ok) return { ok: false, failure: { kind: 'SCHEMA', reason: res.reason, coverageState: 'NOT_SUPPORTED', reasonCode: 'NOT_IN_CATALOG', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'rest-funding-history', query: { symbol }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'rest-funding-history', subject: res.subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK', startTs: base.clock() })] };
    const rates = (arr(obj(r.json)?.rates) ?? []).slice(-maxRates); const out = [];
    for (const raw of rates) {
      const x = obj(raw); const ts = tsFromIso(x?.timestamp); const fr = num(x?.fundingRate); const rel = num(x?.relativeFundingRate); if (ts === null || fr === null) continue;
      const ob = base.tryEmit({ endpointId: 'rest-funding-history', subject: res.subject, kind: 'DERIVATIVE_TICK', sourceKey: `${symbol}:${x.timestamp}`, sourceEventTs: ts, periodStartTs: ts - HOUR_MS, periodEndTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'kraken-futures-funding-history-v4', originalUnit: `absolute ${res.spec.quote} per contract per hour` }), provenance: base.provenance(r, { nativeLocator: `${symbol}:${x.timestamp}`, mappingId: KRAKEN_FUTURES_MAPPING_ID, specificationId: res.spec.specificationId }),
        payload: { markPrice: null, indexPrice: null, lastPrice: null, bid: null, ask: null, openInterest: null, openInterestUnit: 'UNKNOWN', fundingRateNative: fr, fundingUnit: 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL', fundingIntervalMs: HOUR_MS, fundingRelative: rel, fundingPredictedNative: null, nextFundingTs: null, volume24hBase: null, volume24hQuote: null, contractMultiplier: res.spec.contractSize, settlementCurrency: res.spec.linearity === 'INVERSE' ? res.spec.base : res.spec.quote, linearity: res.spec.linearity } });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'rest-funding-history', subject: res.subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK', state: out.length ? 'OBSERVED' : 'GAP', startTs: out.length ? out[0].periodStartTs : r.receivedTs, endTs: out.length ? out[out.length - 1].periodEndTs : r.receivedTs, observationCount: out.length })], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  return { ...base, loadInstruments, resolveInstrument, tickers, fundingHistory, specs: () => specs };
}
