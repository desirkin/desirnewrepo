// D11 — COIN METRICS COMMUNITY API v4 (free, keyless at community-api.coinmetrics.io): catalog of community
// asset metrics (frequency / min / max time) and daily timeseries. Community data is narrower than Pro and never a
// substitute for proprietary exchange entity labels. Documented limit: 10 requests / 6 seconds — enforced here with a
// minimum spacing between requests (injectable sleep for tests).
import { createClientBase, num, str, tsFromIso, arr, obj, assetSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';
import { DAY_MS } from '../time.js';

export const COINMETRICS_MAPPING_ID = 'coinmetrics-community-catalog-v4';
export const COINMETRICS_MIN_SPACING_MS = 600;
export const COINMETRICS_METRICS = deepFreeze({
  active_addresses: { native: 'AdrActCnt', unit: 'COUNT' }, transaction_count: { native: 'TxCnt', unit: 'COUNT' }, transfer_volume: { native: 'TxTfrValNtv', unit: 'NATIVE' }, fees_total: { native: 'FeeTotNtv', unit: 'NATIVE' }, supply_circulating: { native: 'SplyCur', unit: 'NATIVE' }, realized_price: { native: 'CapRealUSD', unit: 'USD' }, mvrv: { native: 'CapMVRVCur', unit: 'RATIO' },
});
export function createCoinMetricsClient({ transport, clock, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const base = createClientBase({ providerId: 'COINMETRICS', transport, clock, log });
  let lastRequestTs = 0; const catalog = new Map();
  const spaced = async (fn) => { const wait = lastRequestTs + COINMETRICS_MIN_SPACING_MS - base.clock(); if (wait > 0) await sleep(wait); lastRequestTs = base.clock(); return fn(); };
  async function loadCatalog({ asset, signal }) {
    const r = await spaced(() => base.call({ endpointId: 'catalog-asset-metrics', query: { assets: asset }, signal }));
    if (!r.ok) return r;
    const row = (arr(obj(r.json)?.data) ?? []).map(obj).find((x) => x && x.asset === asset); if (!row) return { ok: false, failure: { kind: 'SCHEMA', reason: 'asset not in community catalog', coverageState: 'NOT_SUPPORTED', reasonCode: 'NOT_IN_CATALOG', ts: r.receivedTs } };
    const metrics = new Map();
    for (const m of (arr(row.metrics) ?? []).map(obj).filter(Boolean)) { const name = str(m.metric, 40); if (!name) continue; const f = (arr(m.frequencies) ?? []).map(obj).find((x) => x && x.frequency === '1d'); if (f) metrics.set(name, { minTs: tsFromIso(f.min_time), maxTs: tsFromIso(f.max_time), community: f.community === true }); }
    catalog.set(asset, deepFreeze({ metrics, receivedTs: r.receivedTs, requestId: r.requestId }));
    return { ok: true, metrics: [...metrics.keys()], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  const supports = (asset, metricId) => { const c = catalog.get(asset); const m = COINMETRICS_METRICS[metricId]; return !!(c && m && c.metrics.get(m.native)?.community === true); };
  async function series({ asset, canonicalCoin, metricIds, startTs = null, endTs = null, pageSize = 100, maxPages = 3, signal }) {
    const subject = assetSubject({ canonicalCoin, providerAssetId: asset });
    const wanted = metricIds.filter((id) => COINMETRICS_METRICS[id]); const supported = wanted.filter((id) => supports(asset, id)); const unsupported = wanted.filter((id) => !supports(asset, id));
    const coverage = unsupported.map(() => base.coverage({ endpointId: 'timeseries-asset-metrics', subject, family: 'NETWORK_ACTIVITY', kind: 'ONCHAIN_METRIC', state: 'NOT_SUPPORTED', reasonCodes: ['NOT_IN_CATALOG'], startTs: base.clock(), endTs: base.clock() }));
    if (!supported.length) return { ok: true, observations: [], coverage, meta: { unsupported } };
    const out = []; let token = null; let pages = 0; let lastR = null; let failure = null;
    while (pages < maxPages) {
      const query = { assets: asset, metrics: supported.map((id) => COINMETRICS_METRICS[id].native).join(','), frequency: '1d', page_size: Math.min(1000, pageSize), paging_from: 'end' }; if (startTs !== null) query.start_time = new Date(startTs).toISOString(); if (endTs !== null) query.end_time = new Date(endTs).toISOString(); if (token) query.next_page_token = token;
      const r = await spaced(() => base.call({ endpointId: 'timeseries-asset-metrics', query, signal })); if (!r.ok) { failure = r.failure; break; }
      pages += 1; lastR = r;
      for (const raw of arr(obj(r.json)?.data) ?? []) { const row = obj(raw); const start = tsFromIso(row?.time); if (start === null) continue;
        for (const id of supported) { const m = COINMETRICS_METRICS[id]; const v = num(row[m.native]);
          const ob = base.tryEmit({ endpointId: 'timeseries-asset-metrics', subject, kind: 'ONCHAIN_METRIC', sourceKey: `${asset}:${m.native}:1d:${start}`, periodStartTs: start, periodEndTs: start + DAY_MS, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(v === null ? 'MISSING' : 'KNOWN', { reasonCodes: v === null ? ['FIELD_MISSING_AT_SOURCE'] : [], coverageStartTs: start, coverageEndTs: start + DAY_MS, methodologyId: `coinmetrics-${m.native}-v4`, originalUnit: m.unit }), provenance: base.provenance(r, { nativeLocator: `${asset}/${m.native}/${start}`, mappingId: COINMETRICS_MAPPING_ID }), payload: { metricId: id, value: v, unit: m.unit, entitySet: null, chain: asset === 'btc' ? 'bitcoin' : asset === 'eth' ? 'ethereum' : asset, window: 'day', methodologyId: `coinmetrics-${m.native}-v4`, labelVintage: null } });
          if (ob) out.push(ob); } }
      token = str(obj(r.json)?.next_page_token, 200); if (!token) break;
    }
    out.sort((a, b) => a.periodStartTs - b.periodStartTs || (a.payload.metricId < b.payload.metricId ? -1 : 1));
    if (failure && !out.length) return { ok: false, failure, coverage: [...coverage, base.failureCoverage(failure, { endpointId: 'timeseries-asset-metrics', subject, family: 'NETWORK_ACTIVITY', kind: 'ONCHAIN_METRIC', startTs: base.clock() })] };
    coverage.push(base.coverage({ endpointId: 'timeseries-asset-metrics', subject, family: 'NETWORK_ACTIVITY', kind: 'ONCHAIN_METRIC', state: out.length ? 'OBSERVED' : 'GAP', reasonCodes: pages >= maxPages && token ? ['PAGINATION_INCOMPLETE'] : [], startTs: out.length ? out[0].periodStartTs : base.clock(), endTs: out.length ? out[out.length - 1].periodEndTs : base.clock(), observationCount: out.length }));
    return { ok: true, observations: out, coverage, meta: { requestId: lastR?.requestId ?? null, receivedTs: lastR?.receivedTs ?? null, pages, unsupported, failure } };
  }
  return { ...base, loadCatalog, supports, series, metrics: COINMETRICS_METRICS };
}
