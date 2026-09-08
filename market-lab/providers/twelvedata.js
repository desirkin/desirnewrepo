// D13 — TWELVE DATA (paid-capable): symbol search (real instrument / exchange resolution), quotes and closed bars for
// the declared cross-asset proxies. SPY / QQQ / TLT / EUR/USD / XAU/USD are PROXIES named as such by the subjects file;
// none is relabelled as a futures index, a cash yield or DXY. Delayed data, pre/post-market, closed sessions and a real
// real-time entitlement are recorded separately; a plan that does not include an instrument yields NOT_SUPPORTED.
import { createClientBase, num, str, bool, tsFromSeconds, arr, obj, seriesSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';

export const TWELVEDATA_MAPPING_ID = 'twelvedata-symbol-search-v1';
const INTERVALS = deepFreeze({ '1min': 60_000, '5min': 300_000, '15min': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1day': 86_400_000 });
const providerError = (j, receivedTs) => { const o = obj(j); if (!o || o.status !== 'error') return null; const code = num(o.code); const denied = code === 401 || code === 403 || /plan|upgrade|not available|grow|pro plan/i.test(str(o.message, 300) ?? ''); return { kind: 'SCHEMA', reason: `provider status error ${code ?? ''}`.trim(), coverageState: denied ? 'ACCESS_BLOCKED' : code === 429 ? 'FAILED' : 'FAILED', reasonCode: denied ? 'ENTITLEMENT_DENIED' : code === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR', ts: receivedTs }; };
const parseDt = (s) => { if (typeof s !== 'string') return null; const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`); return Number.isFinite(ms) ? ms : null; };
export function createTwelveDataClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'TWELVEDATA', transport, clock, log, credential });
  const resolved = new Map();
  async function resolve({ symbol, exchange = null, proxyFor, signal }) {
    const r = await base.call({ endpointId: 'symbol-search', query: { symbol, outputsize: 30 }, signal });
    if (!r.ok) return r;
    const pe = providerError(r.json, r.receivedTs); if (pe) return { ok: false, failure: pe };
    const rows = (arr(obj(r.json)?.data) ?? []).map(obj).filter((x) => x && str(x.symbol, 40) === symbol && (exchange === null || str(x.exchange, 40) === exchange));
    if (!rows.length) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (exchange === null && new Set(rows.map((x) => str(x.exchange, 40))).size > 1 && !rows.every((x) => str(x.instrument_type, 40) === 'Physical Currency' || str(x.instrument_type, 40) === 'Forex')) return { ok: false, reason: 'AMBIGUOUS_MAPPING', candidates: rows.map((x) => `${x.symbol}@${x.exchange}`).slice(0, 8) };
    const x = rows[0]; const inst = deepFreeze({ symbol, exchange: str(x.exchange, 40), micCode: str(x.mic_code, 12), instrumentType: str(x.instrument_type, 40), currency: str(x.currency, 8) ?? 'USD', name: str(x.instrument_name, 120), proxyFor, subject: seriesSubject({ instrumentId: `${symbol}@${str(x.exchange, 40) ?? 'na'}`, providerAssetId: symbol }), mappingKnownAtTs: r.receivedTs });
    resolved.set(symbol, inst);
    return { ok: true, instrument: inst, meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function quote({ symbol, signal }) {
    const inst = resolved.get(symbol); if (!inst) return { ok: false, failure: { kind: 'SCHEMA', reason: 'instrument not resolved', coverageState: 'NOT_QUERIED', reasonCode: 'NONE', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'quote', query: { symbol, ...(inst.exchange ? { exchange: inst.exchange } : {}), timezone: 'UTC' }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'quote', subject: inst.subject, family: 'CROSS_ASSET', kind: 'CROSS_ASSET_BAR', startTs: base.clock() })] };
    const pe = providerError(r.json, r.receivedTs); if (pe) return { ok: false, failure: pe, coverage: [base.failureCoverage(pe, { endpointId: 'quote', subject: inst.subject, family: 'CROSS_ASSET', kind: 'CROSS_ASSET_BAR', startTs: r.receivedTs })] };
    const q = obj(r.json); const ts = tsFromSeconds(q?.timestamp); const open = bool(q?.is_market_open); const forex = /Forex|Currency/i.test(inst.instrumentType ?? '');
    const ob = base.tryEmit({ endpointId: 'quote', subject: inst.subject, kind: 'CROSS_ASSET_BAR', sourceKey: `${symbol}:quote:${ts ?? 'na'}`, sourceEventTs: ts, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(num(q?.close) !== null ? (open === false && !forex ? 'STALE' : 'KNOWN') : 'MISSING', { reasonCodes: num(q?.close) !== null ? (open === false && !forex ? ['SESSION_CLOSED', 'DELAYED_DATA'] : ['DELAYED_DATA']) : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'twelvedata-quote-v1', originalUnit: inst.currency }), provenance: base.provenance(r, { nativeLocator: `${symbol}@${inst.exchange ?? 'na'}`, mappingId: TWELVEDATA_MAPPING_ID }), payload: { instrument: symbol, exchange: inst.exchange, intervalMs: 86_400_000, open: num(q?.open), high: num(q?.high), low: num(q?.low), close: num(q?.close), volume: num(q?.volume), sessionState: forex ? 'CONTINUOUS' : open === true ? 'REGULAR' : open === false ? 'CLOSED' : 'UNKNOWN', delayed: null, proxyFor: inst.proxyFor, currency: inst.currency } });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'quote rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  async function bars({ symbol, interval = '1h', outputsize = 100, signal }) {
    const inst = resolved.get(symbol); const intervalMs = INTERVALS[interval];
    if (!inst || !intervalMs) return { ok: false, failure: { kind: 'SCHEMA', reason: 'instrument not resolved or interval unsupported', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'time-series', query: { symbol, interval, outputsize: Math.min(5000, outputsize), timezone: 'UTC', ...(inst.exchange ? { exchange: inst.exchange } : {}) }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'time-series', subject: inst.subject, family: 'CROSS_ASSET', kind: 'CROSS_ASSET_BAR', startTs: base.clock() })] };
    const pe = providerError(r.json, r.receivedTs); if (pe) return { ok: false, failure: pe, coverage: [base.failureCoverage(pe, { endpointId: 'time-series', subject: inst.subject, family: 'CROSS_ASSET', kind: 'CROSS_ASSET_BAR', startTs: r.receivedTs })] };
    const j = obj(r.json); const values = (arr(j?.values) ?? []).map(obj).filter(Boolean); const forex = /Forex|Currency/i.test(str(obj(j?.meta)?.type, 40) ?? inst.instrumentType ?? ''); const out = [];
    for (const v of values) { const open = parseDt(v.datetime); if (open === null) continue; const closeTs = open + intervalMs; const provisional = closeTs > r.receivedTs;
      const ob = base.tryEmit({ endpointId: 'time-series', subject: inst.subject, kind: 'CROSS_ASSET_BAR', sourceKey: `${symbol}:${interval}:${open}`, sourceEventTs: provisional ? null : closeTs, periodStartTs: open, periodEndTs: closeTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(provisional ? 'PARTIAL' : 'KNOWN', { reasonCodes: provisional ? ['UNCOMMITTED_BAR', 'DELAYED_DATA'] : ['DELAYED_DATA'], coverageStartTs: open, coverageEndTs: provisional ? r.receivedTs : closeTs, methodologyId: 'twelvedata-time-series-v1', originalUnit: inst.currency }), provenance: base.provenance(r, { nativeLocator: `${symbol}@${inst.exchange ?? 'na'}/${open}`, mappingId: TWELVEDATA_MAPPING_ID }), payload: { instrument: symbol, exchange: inst.exchange, intervalMs, open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close), volume: num(v.volume), sessionState: forex ? 'CONTINUOUS' : 'REGULAR', delayed: null, proxyFor: inst.proxyFor, currency: inst.currency } });
      if (ob) out.push(ob); }
    out.sort((a, b) => a.periodStartTs - b.periodStartTs);
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'time-series', subject: inst.subject, family: 'CROSS_ASSET', kind: 'CROSS_ASSET_BAR', state: out.length ? 'OBSERVED' : 'GAP', startTs: out.length ? out[0].periodStartTs : r.receivedTs, endTs: out.length ? out[out.length - 1].periodEndTs : r.receivedTs, observationCount: out.length })], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  return { ...base, resolve, quote, bars, instruments: () => deepFreeze(Object.fromEntries(resolved)), INTERVALS };
}
