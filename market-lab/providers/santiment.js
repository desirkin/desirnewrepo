// D10 — SANTIMENT SanAPI (alternative paid client): GraphQL getMetric timeseries for the explicitly mapped on-chain
// families (exchange flows / balance, active addresses, transaction volume, development activity, supply cohorts),
// usable ONLY under the supplied entitlement. It is not an automatic second subscription and never substitutes for
// missing Social connectivity; pre-aggregated sentiment is a different source and is not requested here.
import { createClientBase, num, str, tsFromIso, arr, obj, assetSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';
import { DAY_MS, HOUR_MS } from '../time.js';

export const SANTIMENT_MAPPING_ID = 'santiment-slug-v1';
export const SANTIMENT_METRICS = deepFreeze({
  exchange_inflow: { metric: 'exchange_inflow', unit: 'NATIVE', family: 'ONCHAIN_ENTITY_FLOW', entity: 'santiment-exchange-labels' },
  exchange_outflow: { metric: 'exchange_outflow', unit: 'NATIVE', family: 'ONCHAIN_ENTITY_FLOW', entity: 'santiment-exchange-labels' },
  exchange_reserve: { metric: 'exchange_balance', unit: 'NATIVE', family: 'ONCHAIN_ENTITY_FLOW', entity: 'santiment-exchange-labels' },
  active_addresses: { metric: 'daily_active_addresses', unit: 'COUNT', family: 'NETWORK_ACTIVITY', entity: null },
  transfer_volume: { metric: 'transaction_volume', unit: 'NATIVE', family: 'NETWORK_ACTIVITY', entity: null },
  dev_activity: { metric: 'dev_activity', unit: 'COUNT', family: 'NETWORK_ACTIVITY', entity: null },
  holder_age_cohort: { metric: 'circulation_1d', unit: 'NATIVE', family: 'ONCHAIN_ENTITY_FLOW', entity: null },
});
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
export function createSantimentClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'SANTIMENT', transport, clock, log, credential });
  async function series({ slug, canonicalCoin, metricId, fromTs, toTs, interval = '1d', signal }) {
    const m = SANTIMENT_METRICS[metricId]; const subject = assetSubject({ canonicalCoin, providerAssetId: slug });
    if (!m || !SLUG_RE.test(slug ?? '') || !['1d', '1h'].includes(interval)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'unsupported slug/metric/interval', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() }, coverage: [] };
    // the query text is built by CODE from fixed pieces; the slug is validated against a closed grammar and passed as a variable
    const query = 'query($metric:String!,$slug:String!,$from:DateTime!,$to:DateTime!,$interval:interval!){getMetric(metric:$metric){timeseriesData(slug:$slug,from:$from,to:$to,interval:$interval){datetime value}}}';
    const body = { query, variables: { metric: m.metric, slug, from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString(), interval } };
    const r = await base.call({ endpointId: 'graphql-get-metric', method: 'POST', body, query: {}, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'graphql-get-metric', subject, family: m.family, kind: 'ONCHAIN_METRIC', startTs: base.clock() })] };
    const j = obj(r.json); const errors = arr(j?.errors); const rows = arr(obj(obj(obj(j?.data)?.getMetric))?.timeseriesData);
    if (errors && errors.length) { const msg = str(obj(errors[0])?.message, 200) ?? ''; const denied = /restricted|plan|upgrade|not allowed|unauthorized/i.test(msg); const f = { kind: 'SCHEMA', reason: denied ? 'entitlement denied by provider' : 'provider graphql error', coverageState: denied ? 'ACCESS_BLOCKED' : 'FAILED', reasonCode: denied ? 'ENTITLEMENT_DENIED' : 'PROVIDER_ERROR', ts: r.receivedTs }; return { ok: false, failure: f, coverage: [base.failureCoverage(f, { endpointId: 'graphql-get-metric', subject, family: m.family, kind: 'ONCHAIN_METRIC', startTs: r.receivedTs })] }; }
    if (!rows) return { ok: false, failure: { kind: 'SCHEMA', reason: 'timeseriesData missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const step = interval === '1d' ? DAY_MS : HOUR_MS; const out = [];
    for (const raw of rows) { const row = obj(raw); const start = tsFromIso(row?.datetime); const v = num(row?.value); if (start === null) continue; const end = start + step;
      const ob = base.tryEmit({ endpointId: 'graphql-get-metric', subject, kind: 'ONCHAIN_METRIC', sourceKey: `${slug}:${m.metric}:${interval}:${start}`, periodStartTs: start, periodEndTs: end, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(v === null ? 'MISSING' : end > r.receivedTs ? 'PARTIAL' : 'KNOWN', { reasonCodes: v === null ? ['FIELD_MISSING_AT_SOURCE'] : end > r.receivedTs ? ['UNCOMMITTED_BAR'] : [], coverageStartTs: start, coverageEndTs: Math.min(end, r.receivedTs), methodologyId: `santiment-${m.metric}-v1`, originalUnit: m.unit }), provenance: base.provenance(r, { nativeLocator: `${slug}/${m.metric}/${start}`, mappingId: SANTIMENT_MAPPING_ID, vintage: String(r.receivedTs) }), payload: { metricId, value: v, unit: m.unit, entitySet: m.entity, chain: slug === 'bitcoin' ? 'bitcoin' : slug === 'ethereum' ? 'ethereum' : slug, window: interval === '1d' ? 'day' : 'hour', methodologyId: `santiment-${m.metric}-v1`, labelVintage: m.entity ? `santiment-labels:${new Date(r.receivedTs).toISOString().slice(0, 10)}` : null } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'graphql-get-metric', subject, family: m.family, kind: 'ONCHAIN_METRIC', state: out.length ? 'OBSERVED' : 'GAP', startTs: fromTs, endTs: toTs, observationCount: out.length })], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  return { ...base, series, metrics: SANTIMENT_METRICS };
}
