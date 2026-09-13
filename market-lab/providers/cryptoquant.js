// D09 — CRYPTOQUANT v1 (paid, Bearer): exchange flows / reserves, network data, market indicators (MVRV, SOPR,
// realized price, stablecoin supply ratio), stablecoin exchange flows and miner flows, through the cataloged
// asset / metric / window support. Native BTC/ETH/ERC20/stablecoin support does not imply identical coverage for
// every alt: an unsupported asset/metric pair is NOT_SUPPORTED, never a zero. Provider exchange labels carry
// coverage and revision limitations, recorded as the entity set and a label vintage.
import { createClientBase, num, str, arr, obj, assetSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';
import { DAY_MS, HOUR_MS } from '../time.js';

export const CRYPTOQUANT_MAPPING_ID = 'cryptoquant-catalog-v1';
export const CRYPTOQUANT_ASSETS = Object.freeze(['btc', 'eth', 'xrp', 'ltc', 'bch', 'stablecoin']);
// our metric id -> { endpointId, metric (path segment), field (documented result field), unit, entity param }
export const CRYPTOQUANT_METRICS = deepFreeze({
  exchange_inflow: { endpointId: 'exchange-flows', metric: 'inflow', field: 'inflow_total', unit: 'NATIVE', entity: 'exchange' },
  exchange_outflow: { endpointId: 'exchange-flows', metric: 'outflow', field: 'outflow_total', unit: 'NATIVE', entity: 'exchange' },
  exchange_netflow: { endpointId: 'exchange-flows', metric: 'netflow', field: 'netflow_total', unit: 'NATIVE', entity: 'exchange' },
  exchange_reserve: { endpointId: 'exchange-flows', metric: 'reserve', field: 'reserve', unit: 'NATIVE', entity: 'exchange' },
  active_addresses: { endpointId: 'network-data', metric: 'addresses-count', field: 'addresses_count_active', unit: 'COUNT', entity: null },
  transaction_count: { endpointId: 'network-data', metric: 'transactions-count', field: 'transactions_count_total', unit: 'COUNT', entity: null },
  transfer_volume: { endpointId: 'network-data', metric: 'tokens-transferred', field: 'tokens_transferred_total', unit: 'NATIVE', entity: null },
  supply_circulating: { endpointId: 'network-data', metric: 'supply', field: 'supply_total', unit: 'NATIVE', entity: null },
  mvrv: { endpointId: 'market-indicator', metric: 'mvrv', field: 'mvrv', unit: 'RATIO', entity: null },
  sopr: { endpointId: 'market-indicator', metric: 'sopr', field: 'sopr', unit: 'RATIO', entity: null },
  realized_price: { endpointId: 'market-indicator', metric: 'realized-price', field: 'realized_price', unit: 'USD', entity: null },
  stablecoin_supply_ratio: { endpointId: 'market-indicator', metric: 'stablecoin-supply-ratio', field: 'stablecoin_supply_ratio', unit: 'RATIO', entity: null },
  miner_reserve: { endpointId: 'miner-flows', metric: 'reserve', field: 'reserve', unit: 'NATIVE', entity: 'miner' },
});
const parseDate = (d, window) => { if (typeof d !== 'string') return null; if (window === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(d)) { const s = Date.parse(`${d}T00:00:00Z`); return Number.isFinite(s) ? { startTs: s, endTs: s + DAY_MS } : null; } const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(d); if (!m) return null; const s = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`); return Number.isFinite(s) ? { startTs: s, endTs: s + HOUR_MS } : null; };
const fmt = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').slice(0, 15);
export function createCryptoQuantClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'CRYPTOQUANT', transport, clock, log, credential });
  async function series({ asset, canonicalCoin, metricId, entity = 'all_exchange', window = 'day', fromTs = null, toTs = null, limit = 100, signal }) {
    const m = CRYPTOQUANT_METRICS[metricId]; const subject = assetSubject({ canonicalCoin, providerAssetId: asset });
    if (!m || !CRYPTOQUANT_ASSETS.includes(asset) || !['day', 'hour', 'block'].includes(window)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'unsupported asset/metric/window', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() }, coverage: [base.coverage({ endpointId: m?.endpointId ?? 'exchange-flows', subject, family: 'ONCHAIN_ENTITY_FLOW', kind: 'ONCHAIN_METRIC', state: 'NOT_SUPPORTED', startTs: base.clock(), endTs: base.clock() })] };
    const query = { window, limit: Math.min(1000, Math.max(1, limit)) }; if (m.entity) query[m.entity] = entity; if (fromTs !== null) query.from = fmt(fromTs); if (toTs !== null) query.to = fmt(toTs);
    const family = m.endpointId === 'exchange-flows' || m.endpointId === 'miner-flows' ? 'ONCHAIN_ENTITY_FLOW' : 'NETWORK_ACTIVITY';
    const r = await base.call({ endpointId: m.endpointId, pathParams: { asset, metric: m.metric }, query, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: m.endpointId, subject, family, kind: 'ONCHAIN_METRIC', startTs: base.clock() })] };
    const j = obj(r.json); const code = obj(j?.status)?.code; const result = obj(j?.result);
    if (code !== 200 || !result) { const f = { kind: 'SCHEMA', reason: `provider status ${typeof code === 'number' ? code : 'missing'}`, coverageState: code === 403 || code === 402 ? 'ACCESS_BLOCKED' : 'FAILED', reasonCode: code === 403 || code === 402 ? 'ENTITLEMENT_DENIED' : 'PROVIDER_ERROR', ts: r.receivedTs }; return { ok: false, failure: f, coverage: [base.failureCoverage(f, { endpointId: m.endpointId, subject, family, kind: 'ONCHAIN_METRIC', startTs: r.receivedTs })] }; }
    const out = []; let rejected = 0;
    for (const raw of arr(result.data) ?? []) { const row = obj(raw); const p = parseDate(row?.date ?? row?.datetime, window); const v = num(row?.[m.field]); if (!p) { rejected += 1; continue; }
      const ob = base.tryEmit({ endpointId: m.endpointId, subject, kind: 'ONCHAIN_METRIC', sourceKey: `${asset}:${metricId}:${entity}:${window}:${p.startTs}`, periodStartTs: p.startTs, periodEndTs: p.endTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(v === null ? 'MISSING' : p.endTs > r.receivedTs ? 'PARTIAL' : 'KNOWN', { reasonCodes: v === null ? ['FIELD_MISSING_AT_SOURCE'] : p.endTs > r.receivedTs ? ['UNCOMMITTED_BAR'] : [], coverageStartTs: p.startTs, coverageEndTs: Math.min(p.endTs, r.receivedTs), methodologyId: `cryptoquant-${m.metric}-v1`, originalUnit: m.unit }), provenance: base.provenance(r, { nativeLocator: `${asset}/${m.metric}/${entity}/${p.startTs}`, mappingId: CRYPTOQUANT_MAPPING_ID, vintage: String(r.receivedTs) }), payload: { metricId, value: v, unit: m.unit, entitySet: m.entity ? `${m.entity}:${entity}` : null, chain: asset === 'stablecoin' ? 'other' : asset === 'btc' ? 'bitcoin' : asset === 'eth' ? 'ethereum' : asset, window, methodologyId: `cryptoquant-${m.metric}-v1`, labelVintage: m.entity ? `cryptoquant-labels:${new Date(r.receivedTs).toISOString().slice(0, 10)}` : null } });
      if (ob) out.push(ob); else rejected += 1; }
    out.sort((a, b) => a.periodStartTs - b.periodStartTs);
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: m.endpointId, subject, family, kind: 'ONCHAIN_METRIC', state: out.length ? 'OBSERVED' : 'GAP', startTs: out.length ? out[0].periodStartTs : r.receivedTs, endTs: out.length ? out[out.length - 1].periodEndTs : r.receivedTs, observationCount: out.length, droppedCount: rejected })], meta: { requestId: r.requestId, receivedTs: r.receivedTs, window: str(result.window, 8) } };
  }
  return { ...base, series, metrics: CRYPTOQUANT_METRICS };
}
