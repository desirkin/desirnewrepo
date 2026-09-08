// D08 — COINGLASS V4 (paid): token vesting / unlock list (STARTUP plan or above per the inspected endpoint tables),
// economic calendar (STARTUP+), BTC / ETH ETF flow history, aggregated OI / funding / liquidations, headline
// references, and the supported coin / exchange census. Every route is pinned in the registry with its plan tier.
// ETF flows are periodic reported estimates; calendar forecast / actual / revision clocks stay separate; article
// bodies are never persisted — a bounded untrusted headline reference only.
import { createClientBase, num, int, str, tsFromMs, arr, obj, assetSubject, derivativeSubject, seriesSubject, providerSubject } from './base.js';
import { quality } from '../contracts.js';
import { DAY_MS, HOUR_MS } from '../time.js';

export const COINGLASS_MAPPING_ID = 'coinglass-v4-symbol-v1';
export const COINGLASS_AGG_VENUE = 'coinglass-aggregate';
const parseSignedPercent = (raw) => { const s = str(raw, 40); if (!s) return { value: null, unit: null }; const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*(%|K|M|B|T)?\s*$/i.exec(s); if (!m) return { value: null, unit: null }; const n = Number(m[1]); if (!Number.isFinite(n)) return { value: null, unit: null }; const suf = (m[2] ?? '').toUpperCase(); if (suf === '%') return { value: n, unit: 'PERCENT' }; const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[suf] ?? 1; return { value: n * mult, unit: 'NATIVE' }; };
const dayPrecision = (ts) => (ts !== null && ts % DAY_MS === 0 ? 'DAY' : 'MILLISECOND');
export function createCoinGlassClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'COINGLASS', transport, clock, log, credential });
  const rejected = (r) => { const code = str(obj(r.json)?.code, 16); if (code === '0') return null; return { kind: 'SCHEMA', reason: `provider code ${code ?? 'missing'}`, coverageState: /^(4|5)0/.test(code ?? '') ? 'ACCESS_BLOCKED' : 'FAILED', reasonCode: /^(4|5)0/.test(code ?? '') ? 'ENTITLEMENT_DENIED' : 'PROVIDER_ERROR', ts: r.receivedTs, status: r.status }; };
  async function get(endpointId, { query = {}, signal, subject, family, kind }) {
    const r = await base.call({ endpointId, query, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: subject ? [base.failureCoverage(r.failure, { endpointId, subject, family, kind, startTs: base.clock() })] : [] };
    const rj = rejected(r); if (rj) return { ok: false, failure: rj, coverage: subject ? [base.failureCoverage(rj, { endpointId, subject, family, kind, startTs: r.receivedTs })] : [] };
    return { ok: true, r, data: obj(r.json)?.data };
  }
  async function supportedCoins({ signal } = {}) { const g = await get('supported-coins', { signal }); if (!g.ok) return g; return { ok: true, coins: (arr(g.data) ?? []).filter((x) => typeof x === 'string' && /^[A-Z0-9]{1,15}$/.test(x)), meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } }; }
  async function supportedExchanges({ signal } = {}) { const g = await get('supported-exchanges', { signal }); if (!g.ok) return g; return { ok: true, exchanges: (arr(g.data) ?? []).map((x) => str(typeof x === 'string' ? x : obj(x)?.exchange, 40)).filter(Boolean), meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } }; }
  async function vesting({ symbol, canonicalCoin, signal }) {
    const subject = assetSubject({ canonicalCoin, providerAssetId: symbol });
    const g = await get('coin-vesting', { query: { symbol }, signal, subject, family: 'SUPPLY_UNLOCKS', kind: 'UNLOCK_EVENT' }); if (!g.ok) return g;
    const d = obj(g.data); if (!d) return { ok: false, failure: { kind: 'SCHEMA', reason: 'vesting data missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: g.r.receivedTs }, coverage: [] };
    const out = []; const totals = { totalLocked: num(d.total_locked), totalUnlocked: num(d.total_unlocked), totalUntracked: num(d.total_untracked), circulatingSupply: num(d.circulating_supply) };
    const allocations = (arr(d.allocations) ?? []).map(obj).filter(Boolean).slice(0, 64);
    for (let i = 0; i < allocations.length; i += 1) {
      const a = allocations[i]; const untracked = a.is_untracked === true; const nu = obj(a.next_unlock); const ts = nu ? tsFromMs(nu.date) : null; const amt = nu ? num(nu.next_unlock_token_amount) : null; const name = str(a.name, 120);
      const ob = base.tryEmit({ endpointId: 'coin-vesting', subject, kind: 'UNLOCK_EVENT', sourceKey: `${symbol}:alloc:${i}`, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality(untracked ? 'PARTIAL' : ts !== null ? 'KNOWN' : 'MISSING', { reasonCodes: untracked ? ['FIELD_MISSING_AT_SOURCE'] : ts !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'coinglass-vesting-v4', originalUnit: 'token' }), provenance: base.provenance(g.r, { nativeLocator: `${symbol}:${i}`, mappingId: COINGLASS_MAPPING_ID }),
        payload: { eventId: `${symbol}:alloc:${i}:${ts ?? 'na'}`, scheduledTs: ts, timePrecision: ts === null ? 'UNKNOWN' : dayPrecision(ts), amountToken: untracked ? null : amt, amountUsd: null, recipientCategory: name, unlockType: untracked ? 'UNKNOWN' : str(a.unlock_type, 20) === 'linear' ? 'LINEAR' : str(a.unlock_type, 20) === 'nonlinear' ? 'CLIFF' : 'NATIVE_OTHER', tracked: !untracked, allocationName: name, ...totals, scheduleVersion: `coinglass-v4:${g.r.receivedTs}` } });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'coin-vesting', subject, family: 'SUPPLY_UNLOCKS', kind: 'UNLOCK_EVENT', state: out.length ? 'OBSERVED' : 'GAP', startTs: g.r.receivedTs, endTs: g.r.receivedTs, observationCount: out.length })], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs, totals } };
  }
  async function unlockList({ symbols, signal }) {
    const g = await get('coin-unlock-list', { signal }); if (!g.ok) return g;
    const rows = (arr(g.data) ?? []).map(obj).filter(Boolean); const out = [];
    for (const { symbol, canonicalCoin } of symbols) { const row = rows.find((x) => str(x.symbol, 20) === symbol); if (!row) continue; const ts = tsFromMs(row.next_unlock_date); const subject = assetSubject({ canonicalCoin, providerAssetId: symbol });
      const ob = base.tryEmit({ endpointId: 'coin-unlock-list', subject, kind: 'UNLOCK_EVENT', sourceKey: `${symbol}:next`, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality(ts !== null ? 'KNOWN' : 'MISSING', { reasonCodes: ts !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'coinglass-unlock-list-v4', originalUnit: 'token' }), provenance: base.provenance(g.r, { nativeLocator: symbol, mappingId: COINGLASS_MAPPING_ID }), payload: { eventId: `${symbol}:next:${ts ?? 'na'}`, scheduledTs: ts, timePrecision: ts === null ? 'UNKNOWN' : dayPrecision(ts), amountToken: num(row.next_unlock_tokens), amountUsd: null, recipientCategory: null, unlockType: 'UNKNOWN', tracked: true, allocationName: null, totalLocked: num(row.total_locked), totalUnlocked: num(row.total_unlocked), totalUntracked: null, circulatingSupply: num(row.circulating_supply), scheduleVersion: `coinglass-v4:${g.r.receivedTs}` } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs, rows: rows.length } };
  }
  async function economicCalendar({ startTs, endTs, signal }) {
    const subject = seriesSubject({ seriesId: 'coinglass-economic-calendar' });
    const g = await get('economic-data', { query: { start_time: startTs, end_time: endTs }, signal, subject, family: 'MACRO_RELEASES', kind: 'ECONOMIC_EVENT' }); if (!g.ok) return g;
    const out = [];
    for (const raw of (arr(g.data) ?? []).slice(0, 500)) {
      const e = obj(raw); const name = str(e?.calendar_name, 300); const cc = str(e?.country_code, 8); const ts = tsFromMs(e?.publish_timestamp); if (!name || !cc) continue;
      const exact = int(e.has_exact_publish_time) === 1; const f = parseSignedPercent(e.forecast_value); const a = parseSignedPercent(e.published_value); const p = parseSignedPercent(e.previous_value); const rp = parseSignedPercent(e.revised_previous_value);
      const published = a.value !== null; const unit = f.unit ?? a.unit ?? p.unit ?? null;
      const ob = base.tryEmit({ endpointId: 'economic-data', subject: seriesSubject({ seriesId: `coinglass:${cc}:${name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 80)}` }), kind: 'ECONOMIC_EVENT', sourceKey: `${cc}:${name.replace(/[^A-Za-z0-9._:@/+-]+/g, '-')}:${ts ?? 'na'}`.slice(0, 200), sourceEventTs: published && ts !== null && ts <= g.r.receivedTs ? ts : null, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality(ts !== null ? (published ? 'KNOWN' : 'PARTIAL') : 'MISSING', { reasonCodes: [...(exact ? [] : ['DATE_ONLY_PRECISION']), ...(published ? [] : ['FIELD_MISSING_AT_SOURCE'])], methodologyId: 'coinglass-economic-data-v4', originalUnit: unit }), provenance: base.provenance(g.r, { nativeLocator: `${cc}:${ts ?? 'na'}`, mappingId: COINGLASS_MAPPING_ID }),
        payload: { eventName: name, countryCode: cc, scheduledTs: ts, timePrecision: ts === null ? 'UNKNOWN' : exact ? 'MILLISECOND' : 'DAY', forecastRaw: str(e.forecast_value, 40), actualRaw: str(e.published_value, 40), previousRaw: str(e.previous_value, 40), revisedPreviousRaw: str(e.revised_previous_value, 40), forecastValue: f.value, actualValue: a.value, previousValue: p.value, unit: unit === 'PERCENT' ? 'PERCENT' : unit === 'NATIVE' ? 'NATIVE' : null, importance: int(e.importance_level), forecastKnownAtTs: f.value !== null ? g.r.receivedTs : null, actualKnownAtTs: published ? g.r.receivedTs : null } });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'economic-data', subject, family: 'MACRO_RELEASES', kind: 'ECONOMIC_EVENT', state: out.length ? 'OBSERVED' : 'GAP', startTs, endTs, observationCount: out.length })], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } };
  }
  async function etfFlows({ asset = 'BTC', canonicalCoin = 'BTC', signal, maxDays = 90 }) {
    const endpointId = asset === 'ETH' ? 'etf-ethereum-flow-history' : 'etf-bitcoin-flow-history'; const subject = assetSubject({ canonicalCoin, providerAssetId: asset });
    const g = await get(endpointId, { signal, subject, family: 'ETF_FLOWS', kind: 'ETF_FLOW' }); if (!g.ok) return g;
    const rows = (arr(g.data) ?? []).map(obj).filter(Boolean).slice(-maxDays); const out = [];
    for (const row of rows) { const day = tsFromMs(row.timestamp); if (day === null) continue; const flow = num(row.flow_usd); const price = num(row.price_usd);
      const emit = (fund, v) => base.tryEmit({ endpointId, subject, kind: 'ETF_FLOW', sourceKey: `${asset}:${fund ?? 'ALL'}:${day}`, periodStartTs: day, periodEndTs: day + DAY_MS, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality(v === null ? 'MISSING' : 'KNOWN', { reasonCodes: v === null ? ['FIELD_MISSING_AT_SOURCE'] : ['ESTIMATE'], methodologyId: 'coinglass-etf-flow-history-v4', originalUnit: 'USD' }), provenance: base.provenance(g.r, { nativeLocator: `${asset}:${day}`, mappingId: COINGLASS_MAPPING_ID, vintage: String(g.r.receivedTs) }), payload: { fund, asset, flowUsd: v, reportingPeriodStartTs: day, reportingPeriodEndTs: day + DAY_MS, estimate: true, revision: null, priceUsd: price } });
      const all = emit(null, flow); if (all) out.push(all);
      for (const f of (arr(row.etf_flows) ?? []).map(obj).filter(Boolean).slice(0, 32)) { const t = str(f.etf_ticker, 12); if (!t) continue; const o = emit(t, num(f.flow_usd)); if (o) out.push(o); } }
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId, subject, family: 'ETF_FLOWS', kind: 'ETF_FLOW', state: out.length ? 'OBSERVED' : 'GAP', startTs: out.length ? out[0].periodStartTs : g.r.receivedTs, endTs: out.length ? out[out.length - 1].periodEndTs : g.r.receivedTs, observationCount: out.length })], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs, days: rows.length } };
  }
  const aggSubject = (symbol, canonicalCoin, exchange) => derivativeSubject({ canonicalCoin, providerAssetId: symbol, venue: COINGLASS_AGG_VENUE, instrumentId: `${symbol}:${exchange}`, specificationId: `coinglass-aggregate:${symbol}:${exchange}`, marketType: 'PERPETUAL' });
  async function openInterest({ symbol, canonicalCoin, signal }) {
    const subject = aggSubject(symbol, canonicalCoin, 'All');
    const g = await get('oi-exchange-list', { query: { symbol }, signal, subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK' }); if (!g.ok) return g;
    const out = [];
    for (const row of (arr(g.data) ?? []).map(obj).filter(Boolean).slice(0, 32)) { const ex = str(row.exchange, 40); if (!ex) continue; const oi = num(row.open_interest_usd);
      const ob = base.tryEmit({ endpointId: 'oi-exchange-list', subject: aggSubject(symbol, canonicalCoin, ex), kind: 'DERIVATIVE_TICK', sourceKey: `${symbol}:${ex}:oi`, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality(oi === null ? 'MISSING' : 'PARTIAL', { reasonCodes: oi === null ? ['FIELD_MISSING_AT_SOURCE'] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'coinglass-oi-exchange-list-v4', originalUnit: 'USD' }), provenance: base.provenance(g.r, { nativeLocator: `${symbol}:${ex}`, mappingId: COINGLASS_MAPPING_ID }), payload: { markPrice: null, indexPrice: null, lastPrice: null, bid: null, ask: null, openInterest: oi, openInterestUnit: oi === null ? 'UNKNOWN' : 'USD', fundingRateNative: null, fundingUnit: 'UNKNOWN', fundingIntervalMs: null, fundingRelative: null, fundingPredictedNative: null, nextFundingTs: null, volume24hBase: null, volume24hQuote: null, contractMultiplier: null, settlementCurrency: null, linearity: 'UNKNOWN' } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } };
  }
  async function funding({ symbol, canonicalCoin, signal }) {
    const subject = aggSubject(symbol, canonicalCoin, 'All');
    const g = await get('funding-exchange-list', { signal, subject, family: 'DERIVATIVES_FUNDING_OI', kind: 'DERIVATIVE_TICK' }); if (!g.ok) return g;
    const row = (arr(g.data) ?? []).map(obj).find((x) => x && str(x.symbol, 20) === symbol); const out = [];
    for (const [margin, list] of [['stablecoin', row?.stablecoin_margin_list], ['token', row?.token_margin_list]]) for (const e of (arr(list) ?? []).map(obj).filter(Boolean).slice(0, 32)) { const ex = str(e.exchange, 40); const fr = num(e.funding_rate); const hours = num(e.funding_rate_interval); if (!ex || fr === null || hours === null) continue;
      const ob = base.tryEmit({ endpointId: 'funding-exchange-list', subject: aggSubject(symbol, canonicalCoin, `${ex}:${margin}`), kind: 'DERIVATIVE_TICK', sourceKey: `${symbol}:${ex}:${margin}:funding`, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'coinglass-funding-exchange-list-v4', originalUnit: 'fraction per interval' }), provenance: base.provenance(g.r, { nativeLocator: `${symbol}:${ex}:${margin}`, mappingId: COINGLASS_MAPPING_ID }), payload: { markPrice: null, indexPrice: null, lastPrice: null, bid: null, ask: null, openInterest: null, openInterestUnit: 'UNKNOWN', fundingRateNative: fr, fundingUnit: 'FRACTION_PER_INTERVAL', fundingIntervalMs: hours * HOUR_MS, fundingRelative: null, fundingPredictedNative: null, nextFundingTs: tsFromMs(e.next_funding_time) || null, volume24hBase: null, volume24hQuote: null, contractMultiplier: null, settlementCurrency: margin === 'token' ? canonicalCoin : null, linearity: margin === 'token' ? 'INVERSE' : 'LINEAR' } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } };
  }
  async function liquidations({ symbol, canonicalCoin, interval = '1h', exchangeList = 'ALL', limit = 24, signal }) {
    const subject = aggSubject(symbol, canonicalCoin, exchangeList); const intervalMs = { '1h': HOUR_MS, '4h': 4 * HOUR_MS, '1d': DAY_MS }[interval] ?? HOUR_MS;
    const g = await get('liquidation-aggregated-history', { query: { exchange_list: exchangeList, symbol, interval, limit }, signal, subject, family: 'LIQUIDATIONS', kind: 'LIQUIDATION' }); if (!g.ok) return g;
    const out = [];
    for (const row of (arr(g.data) ?? []).map(obj).filter(Boolean)) { const t = tsFromMs(row.time); if (t === null) continue; const L = num(row.aggregated_long_liquidation_usd); const S = num(row.aggregated_short_liquidation_usd); const closed = t + intervalMs <= g.r.receivedTs;
      const ob = base.tryEmit({ endpointId: 'liquidation-aggregated-history', subject, kind: 'LIQUIDATION', sourceKey: `${symbol}:${exchangeList}:${interval}:${t}`, periodStartTs: t, periodEndTs: t + intervalMs, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality(L === null && S === null ? 'MISSING' : closed ? 'KNOWN' : 'PARTIAL', { reasonCodes: L === null && S === null ? ['FIELD_MISSING_AT_SOURCE'] : closed ? [] : ['UNCOMMITTED_BAR'], methodologyId: 'coinglass-aggregated-liquidation-v4', originalUnit: 'USD', completeness: closed ? null : null }), provenance: base.provenance(g.r, { nativeLocator: `${symbol}:${t}`, mappingId: COINGLASS_MAPPING_ID }), payload: { forcedOrderSide: 'UNKNOWN', liquidatedPositionSide: 'UNKNOWN', qtyBase: null, price: null, notional: L !== null && S !== null ? L + S : null, notionalUnit: 'USD', aggregated: true, aggregationIntervalMs: intervalMs, longNotional: L, shortNotional: S, venueScope: exchangeList } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'liquidation-aggregated-history', subject, family: 'LIQUIDATIONS', kind: 'LIQUIDATION', state: out.length ? 'OBSERVED' : 'GAP', startTs: out.length ? out[0].periodStartTs : g.r.receivedTs, endTs: out.length ? out[out.length - 1].periodEndTs : g.r.receivedTs, observationCount: out.length })], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } };
  }
  async function headlines({ signal, max = 50 }) {
    const subject = providerSubject('COINGLASS');
    const g = await get('article-list', { signal, subject, family: 'OFFICIAL_SOCIAL_EVENTS', kind: 'EVENT_REFERENCE' }); if (!g.ok) return g;
    const out = [];
    for (const row of (arr(g.data) ?? []).map(obj).filter(Boolean).slice(0, max)) { const title = str(row.article_title, 300); const ts = tsFromMs(row.article_release_time); const src = str(row.source_name, 40); if (!title || ts === null) continue;
      const ob = base.tryEmit({ endpointId: 'article-list', subject, kind: 'EVENT_REFERENCE', sourceKey: `${src ?? 'unknown'}:${ts}`, sourceEventTs: ts, publishedTs: ts <= g.r.receivedTs ? ts : null, receivedTs: g.r.receivedTs, knownAtTs: g.r.receivedTs, quality: quality('KNOWN', { methodologyId: 'coinglass-article-list-v4' }), provenance: base.provenance(g.r, { nativeLocator: `${src ?? 'unknown'}:${ts}`, mappingId: COINGLASS_MAPPING_ID }), payload: { eventKind: 'NEWS_HEADLINE', sourceProvider: (src ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '-'), nativeRef: `${ts}`, sourceEventTs: ts, headline: title, untrusted: true, status: null } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [], meta: { requestId: g.r.requestId, receivedTs: g.r.receivedTs } };
  }
  return { ...base, supportedCoins, supportedExchanges, vesting, unlockList, economicCalendar, etfFlows, openInterest, funding, liquidations, headlines };
}
