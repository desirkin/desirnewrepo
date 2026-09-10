// MARKET-EDGE-KRAKEN-1 (A) — KRAKEN FUTURES CHARTS / MARKET ANALYTICS, a DARK research sense on the EXISTING
// KRAKEN_DERIVATIVES provider (no duplicate provider). Documented 2026-09-10:
//   GET https://futures.kraken.com/api/charts/v1/analytics/{symbol}/{analytics_type}?since=<epoch s>&interval=<s>[&to=<epoch s>]
//   -> { result: { timestamp: int[] (epoch s), data: <per type>, more: bool }, errors: [] }
// Laws: closed per-type value schemas (the nested types are NOT_SUPPORTED_WITH_CURRENT_SCHEMA); the provider bucket
// timestamp is the period start and periodEndTs = bucketTs + interval; a bucket whose end lies after receipt is
// PROVISIONAL (in progress), never FINAL; knownAtTs = receivedTs for EVERY vintage — a HISTORICAL_FETCH is known when it
// was fetched, never at the bucket's own time; pagination follows result.more with an advancing cursor and fails closed
// on a non-advancing page; a page cap yields PAGINATION_INCOMPLETE; units are NATIVE with UNIT_UNVERIFIED because the
// Charts documentation states none (never inferred from magnitude, never converted without a contract specification).
// Authority: NONE. Nothing here is a signal; manipulation risk is documentation.
import { createClientBase, num, int, bool, arr, obj } from './base.js';
import { quality, deepFreeze, fail, isTs, ANALYTICS_TYPES, ANALYTICS_TYPES_UNSUPPORTED, ANALYTICS_VALUE_KEYS, ANALYTICS_INTERVALS_S, ANALYTICS_MANIPULATION_RISK, VINTAGES } from '../contracts.js';
import { CHARTS_DEFAULTS } from '../policy.js';
import { DAY_MS } from '../time.js';

export const KRAKEN_CHARTS_METHODOLOGY = 'kraken-charts-analytics-v1';
export const CHARTS_ENDPOINT_ID = 'charts-analytics';
export const FORWARD_CAPTURE_BUCKETS = 3; // a LIVE_FORWARD_CAPTURE poll looks back at most this many buckets
export const CHARTS_DOCS_CHECKED = '2026-09-10';
// per-type documentation notes (units are NOT stated on the Charts page; the labels below name the native series only)
export const CHARTS_NATIVE_UNIT_LABELS = deepFreeze({ 'open-interest': 'kraken-charts:open-interest (undocumented unit)', 'aggressor-differential': 'kraken-charts:aggressor-differential (undocumented unit)', 'trade-volume': 'kraken-charts:trade-volume (undocumented unit)', 'trade-count': 'kraken-charts:trade-count (count)', 'liquidation-volume': 'kraken-charts:liquidation-volume (undocumented unit)', 'rolling-volatility': 'kraken-charts:rolling-volatility (undocumented unit)', 'long-short-ratio': 'kraken-charts:long-short-ratio (ratio)', cvd: 'kraken-charts:cvd (undocumented unit)', 'future-basis': 'kraken-charts:future-basis (undocumented unit)', funding: 'kraken-charts:funding rate / relativeRate OHLC (undocumented unit)' });

const scalar = (data, n) => { const a = arr(data); if (!a || a.length !== n) return null; return a.map((v) => ({ value: v === null ? null : num(v) })); };
const columns = (data, keys, n) => { const o = obj(data); if (!o) return null; const cols = keys.map((k) => arr(o[k])); if (cols.some((c) => !c || c.length !== n)) return null; return Array.from({ length: n }, (_, i) => Object.fromEntries(keys.map((k, j) => [k, cols[j][i] === null ? null : num(cols[j][i])]))); };
const ohlcColumns = (data, n) => { const o = obj(data); if (!o) return null; const rate = arr(o.rate); const rel = arr(o.relativeRate); if (!rate || !rel || rate.length !== n || rel.length !== n) return null; const four = (row) => { const r = arr(row); if (r === null) return [null, null, null, null]; if (r.length !== 4) return null; return r.map((v) => (v === null ? null : num(v))); }; const out = []; for (let i = 0; i < n; i += 1) { const a = four(rate[i]); const b = four(rel[i]); if (!a || !b) return null; out.push({ rateOpen: a[0], rateHigh: a[1], rateLow: a[2], rateClose: a[3], relativeRateOpen: b[0], relativeRateHigh: b[1], relativeRateLow: b[2], relativeRateClose: b[3] }); } return out; };

// ---- pure page parser: fails closed on any shape the documentation does not describe -----------------------------------
export function parseAnalyticsPage(json, { analyticsType, intervalS }) {
  if (ANALYTICS_TYPES_UNSUPPORTED.includes(analyticsType)) return { ok: false, reason: 'NOT_SUPPORTED_WITH_CURRENT_SCHEMA' };
  if (!ANALYTICS_TYPES.includes(analyticsType) || !ANALYTICS_INTERVALS_S.includes(intervalS)) return { ok: false, reason: 'INVALID_REQUEST' };
  const j = obj(json); const result = obj(j?.result); const errors = arr(j?.errors);
  if (!j || !result) return { ok: false, reason: 'SCHEMA' };
  if (errors && errors.length) return { ok: false, reason: 'PROVIDER_ERRORS', errorCount: errors.length }; // never echoed
  const ts = arr(result.timestamp); const more = bool(result.more);
  if (!ts || more === null) return { ok: false, reason: 'SCHEMA' };
  const n = ts.length; const intervalMs = intervalS * 1000;
  const keys = ANALYTICS_VALUE_KEYS[analyticsType];
  const rows = analyticsType === 'cvd' ? columns(result.data, keys, n) : analyticsType === 'future-basis' ? columns(result.data, keys, n) : analyticsType === 'funding' ? ohlcColumns(result.data, n) : scalar(result.data, n);
  if (!rows) return { ok: false, reason: 'SCHEMA' };
  const buckets = []; let misaligned = 0; let prev = null;
  for (let i = 0; i < n; i += 1) {
    const s = int(ts[i]); if (s === null || s <= 0) return { ok: false, reason: 'SCHEMA' };
    const bucketTs = s * 1000;
    if (prev !== null && bucketTs <= prev) return { ok: false, reason: 'NON_ADVANCING_TIMESTAMPS' };
    prev = bucketTs;
    if (bucketTs % intervalMs !== 0) { misaligned += 1; continue; }
    const values = rows[i]; const allNull = keys.every((k) => values[k] === null);
    buckets.push({ bucketTs, values: allNull ? null : values });
  }
  return { ok: true, buckets, more, misaligned, count: n };
}

export function createKrakenChartsClient({ transport, clock, log, resolveInstrument, charts = CHARTS_DEFAULTS } = {}) {
  if (typeof resolveInstrument !== 'function') fail('INVALID_REQUEST', 'the charts client needs the derivatives catalog resolver');
  const base = createClientBase({ providerId: 'KRAKEN_DERIVATIVES', transport, clock, log });
  const daily = { day: null, calls: 0 };
  const dayOf = (ts) => Math.floor(ts / DAY_MS);
  const chargeDay = () => { const d = dayOf(base.clock()); if (daily.day !== d) { daily.day = d; daily.calls = 0; } if (daily.calls >= charts.maxCallsPerDay) return false; daily.calls += 1; return true; };
  const refusal = (kind, reason, subject, startTs, coverageState = 'NOT_QUERIED', reasonCode = 'QUOTA_REFUSED') => ({ ok: false, failure: { kind, reason, coverageState, reasonCode, ts: startTs }, observations: [], coverage: subject ? [base.coverage({ endpointId: CHARTS_ENDPOINT_ID, subject, family: 'DERIVATIVES_PRESSURE', kind: 'DERIVATIVE_ANALYTIC_BUCKET', state: coverageState, reasonCodes: reasonCode === 'NONE' ? [] : [reasonCode], startTs, endTs: startTs })] : [], meta: { pages: 0 } });

  // one bounded, paginated acquisition of one analytics series over [sinceTs, toTs] for one instrument
  async function fetchAnalytics({ symbol, analyticsType, intervalS, sinceTs, toTs = null, vintage, maxPages = charts.maxPagesPerRequest, signal = null }) {
    const startTs = base.clock();
    if (!VINTAGES.includes(vintage)) fail('INVALID_REQUEST', 'vintage must be LIVE_FORWARD_CAPTURE or HISTORICAL_FETCH');
    if (!isTs(sinceTs) || (toTs !== null && (!isTs(toTs) || toTs < sinceTs))) fail('INVALID_REQUEST', 'since/to malformed');
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > charts.maxPagesPerRequest) fail('INVALID_REQUEST', 'maxPages outside the policy bound');
    const res = resolveInstrument(symbol);
    if (!res.ok) return refusal('NOT_IN_CATALOG', res.reason, null, startTs, 'NOT_SUPPORTED', 'NOT_IN_CATALOG');
    if (ANALYTICS_TYPES_UNSUPPORTED.includes(analyticsType)) return refusal('NOT_SUPPORTED_WITH_CURRENT_SCHEMA', 'nested analytics type', res.subject, startTs, 'NOT_SUPPORTED', 'AMBIGUOUS_MAPPING');
    if (!ANALYTICS_TYPES.includes(analyticsType) || !charts.analyticsTypes.includes(analyticsType)) return refusal('TYPE_NOT_PERMITTED', 'analytics type outside the policy', res.subject, startTs, 'NOT_QUERIED', 'QUOTA_REFUSED');
    if (!ANALYTICS_INTERVALS_S.includes(intervalS) || !charts.intervalsS.includes(intervalS)) return refusal('INTERVAL_NOT_PERMITTED', 'interval outside the policy', res.subject, startTs, 'NOT_QUERIED', 'QUOTA_REFUSED');
    const intervalMs = intervalS * 1000;
    if (startTs - sinceTs > charts.maxLookbackMs) return refusal('LOOKBACK_EXCEEDED', 'since older than the policy lookback', res.subject, startTs, 'NOT_QUERIED', 'QUOTA_REFUSED');
    if (vintage === 'LIVE_FORWARD_CAPTURE' && startTs - sinceTs > FORWARD_CAPTURE_BUCKETS * intervalMs) return refusal('VINTAGE_MISMATCH', 'a forward capture never reaches back into history', res.subject, startTs, 'NOT_QUERIED', 'NONE');
    const observations = []; const requestIds = []; let pages = 0; let more = false; let cursorTs = sinceTs; let failure = null; let nonAdvancing = false; let misaligned = 0; let firstReceipt = null; let lastReceipt = null;
    for (;;) {
      if (!chargeDay()) { failure = { kind: 'CHARTS_DAILY_CAP', reason: 'policy maxCallsPerDay reached', coverageState: 'NOT_QUERIED', reasonCode: 'QUOTA_REFUSED', ts: base.clock() }; break; }
      const query = { since: Math.floor(cursorTs / 1000), interval: intervalS, ...(toTs === null ? {} : { to: Math.floor(toTs / 1000) }) };
      const r = await base.call({ endpointId: CHARTS_ENDPOINT_ID, pathParams: { symbol, analyticsType }, query, signal, share: false });
      if (!r.ok) { failure = r.failure; break; }
      pages += 1; requestIds.push(r.requestId ?? null); firstReceipt = firstReceipt ?? r.receivedTs; lastReceipt = r.receivedTs;
      const page = parseAnalyticsPage(r.json, { analyticsType, intervalS });
      if (!page.ok) { failure = { kind: page.reason === 'NON_ADVANCING_TIMESTAMPS' ? 'NON_ADVANCING_TIMESTAMPS' : 'SCHEMA', reason: page.reason, coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }; break; }
      misaligned += page.misaligned;
      for (const b of page.buckets) {
        if (b.bucketTs < cursorTs) continue; // a provider that hands back buckets before the cursor never rewinds our clock
        const periodEndTs = b.bucketTs + intervalMs; const provisional = periodEndTs > r.receivedTs;
        const ob = base.tryEmit({ endpointId: CHARTS_ENDPOINT_ID, subject: res.subject, kind: 'DERIVATIVE_ANALYTIC_BUCKET', sourceKey: `${symbol}:${analyticsType}:${intervalS}:${b.bucketTs}`, sourceRevision: `${vintage}:${r.receivedTs}`, sourceEventTs: b.bucketTs, periodStartTs: b.bucketTs, periodEndTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs,
          quality: b.values === null ? quality('MISSING', { reasonCodes: ['FIELD_MISSING_AT_SOURCE', 'UNIT_UNVERIFIED'], methodologyId: KRAKEN_CHARTS_METHODOLOGY, originalUnit: CHARTS_NATIVE_UNIT_LABELS[analyticsType].slice(0, 40) }) : provisional ? quality('PROVISIONAL', { reasonCodes: ['UNCOMMITTED_BAR', 'UNIT_UNVERIFIED'], coverageStartTs: b.bucketTs, coverageEndTs: r.receivedTs, methodologyId: KRAKEN_CHARTS_METHODOLOGY, originalUnit: CHARTS_NATIVE_UNIT_LABELS[analyticsType].slice(0, 40) }) : quality('KNOWN', { reasonCodes: ['UNIT_UNVERIFIED'], coverageStartTs: b.bucketTs, coverageEndTs: periodEndTs, completeness: 1, methodologyId: KRAKEN_CHARTS_METHODOLOGY, originalUnit: CHARTS_NATIVE_UNIT_LABELS[analyticsType].slice(0, 40) }),
          provenance: base.provenance(r, { nativeLocator: `${symbol}/${analyticsType}`, mappingId: KRAKEN_CHARTS_METHODOLOGY, specificationId: res.spec.specificationId, vintage }),
          payload: { analyticsType, intervalMs, bucketTs: b.bucketTs, values: b.values, nativeUnit: CHARTS_NATIVE_UNIT_LABELS[analyticsType], normalizedUnit: 'NATIVE', normalization: 'NONE', finality: provisional ? 'PROVISIONAL' : 'FINAL', manipulationRisk: ANALYTICS_MANIPULATION_RISK[analyticsType], vintage, pageIndex: pages - 1, more: page.more } });
        if (ob) observations.push(ob);
      }
      more = page.more;
      if (!more) break;
      const last = page.buckets.length ? page.buckets[page.buckets.length - 1].bucketTs : null;
      const next = last === null ? null : last + intervalMs;
      if (next === null || next <= cursorTs) { nonAdvancing = true; break; } // fail closed: a page that does not advance is never re-requested
      if (pages >= maxPages) break;
      cursorTs = next;
    }
    const reasonCodes = []; if (failure) reasonCodes.push(failure.reasonCode ?? 'PROVIDER_ERROR'); if (nonAdvancing || (more && pages >= maxPages)) reasonCodes.push('PAGINATION_INCOMPLETE');
    const first = observations[0]; const lastOb = observations[observations.length - 1];
    const state = observations.length ? 'OBSERVED' : failure ? failure.coverageState : 'GAP';
    const coverage = base.coverage({ endpointId: CHARTS_ENDPOINT_ID, subject: res.subject, family: 'DERIVATIVES_PRESSURE', kind: 'DERIVATIVE_ANALYTIC_BUCKET', state, reasonCodes: [...new Set(reasonCodes.filter((c) => c !== 'NONE'))], startTs: first ? first.periodStartTs : startTs, endTs: lastOb ? lastOb.periodEndTs : (lastReceipt ?? base.clock()), observationCount: observations.length });
    return { ok: !failure || observations.length > 0, failure, observations, coverage: [coverage], meta: { pages, more, truncated: more && pages >= maxPages, nonAdvancing, misaligned, requestIds, vintage, firstReceiptTs: firstReceipt, lastReceiptTs: lastReceipt, dailyCalls: daily.calls } };
  }
  // the forward poll: the last FORWARD_CAPTURE_BUCKETS buckets up to now, vintage LIVE_FORWARD_CAPTURE
  const pollForward = ({ symbol, analyticsType, intervalS, signal = null }) => fetchAnalytics({ symbol, analyticsType, intervalS, sinceTs: Math.floor(base.clock() / (intervalS * 1000)) * intervalS * 1000 - (FORWARD_CAPTURE_BUCKETS - 1) * intervalS * 1000, vintage: 'LIVE_FORWARD_CAPTURE', maxPages: 1, signal });
  return { ...base, fetchAnalytics, pollForward, charts: () => charts, dailyCalls: () => daily.calls, docsChecked: CHARTS_DOCS_CHECKED };
}
