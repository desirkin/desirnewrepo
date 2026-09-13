// D07 — DEFILLAMA open routes: protocol / chain TVL, fees and revenue, DEX volume, stablecoin circulation and peg
// prices, lending / supply APY. Provider methodology, currency, period and chain mapping are preserved: TVL changes
// include price effects and are not automatically capital flows; yield APY is not a funding rate; bridged balances
// are recorded per chain and never counted twice. The paid Pro API is a distinct product and is not called here.
import { createClientBase, num, int, str, tsFromSeconds, arr, obj, protocolSubject, assetSubject } from './base.js';
import { quality } from '../contracts.js';
import { DAY_MS } from '../time.js';

export const DEFILLAMA_METHODOLOGY = 'defillama-open-v1';
export function createDefiLlamaClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'DEFILLAMA', transport, clock, log });
  const metric = ({ endpointId, subject, metricId, value, unit, chain, protocol, periodKind, r, locator, periodStartTs = null, periodEndTs = null, methodologyId = DEFILLAMA_METHODOLOGY, family = 'DEX_DEFI', sourceEventTs = null }) => base.tryEmit({ endpointId, subject, kind: 'DEFI_METRIC', sourceKey: locator, sourceEventTs, periodStartTs, periodEndTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(value === null ? 'MISSING' : 'KNOWN', { reasonCodes: value === null ? ['FIELD_MISSING_AT_SOURCE'] : [], methodologyId, originalUnit: unit }), provenance: base.provenance(r, { nativeLocator: locator, mappingId: 'defillama-slug-v1' }), payload: { metricId, value, unit, chain, protocol, periodKind, methodologyId } });
  async function protocol({ slug, canonicalCoin = null, chains = [], signal }) {
    const subj = protocolSubject({ protocolId: slug, canonicalCoin });
    const r = await base.call({ endpointId: 'tvl', pathParams: { slug }, query: {}, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'tvl', subject: subj, family: 'DEX_DEFI', kind: 'DEFI_METRIC', startTs: base.clock() })] };
    const out = []; const total = num(r.json);
    const ob = metric({ endpointId: 'tvl', subject: subj, metricId: 'protocol_tvl', value: total, unit: 'USD', chain: null, protocol: slug, periodKind: 'POINT', r, locator: slug }); if (ob) out.push(ob);
    let chainMeta = null;
    if (chains.length) {
      const rc = await base.call({ endpointId: 'protocol', pathParams: { slug }, query: {}, signal, maxBytes: 32 * 1024 * 1024 });
      if (!rc.ok) out.push(...[]), chainMeta = { failure: rc.failure };
      else { const cur = obj(obj(rc.json)?.currentChainTvls) ?? {}; for (const chain of chains) { const v = num(cur[chain]); const cob = metric({ endpointId: 'protocol', subject: protocolSubject({ protocolId: slug, chain, canonicalCoin }), metricId: 'protocol_tvl', value: v, unit: 'USD', chain, protocol: slug, periodKind: 'POINT', r: rc, locator: `${slug}:${chain}` }); if (cob) out.push(cob); } chainMeta = { requestId: rc.requestId }; }
    }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs, chains: chainMeta } };
  }
  async function summary({ slug, kind, canonicalCoin = null, signal }) {
    const endpointId = kind === 'dexs' ? 'dexs-summary' : 'fees-summary'; const dataType = kind === 'revenue' ? 'dailyRevenue' : kind === 'fees' ? 'dailyFees' : null;
    const subj = protocolSubject({ protocolId: slug, canonicalCoin });
    const r = await base.call({ endpointId, pathParams: { slug }, query: dataType ? { dataType } : {}, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId, subject: subj, family: 'DEX_DEFI', kind: 'DEFI_METRIC', startTs: base.clock() })] };
    const j = obj(r.json); const v = num(j?.total24h); const dayEnd = Math.floor(r.receivedTs / DAY_MS) * DAY_MS;
    const ob = metric({ endpointId, subject: subj, metricId: kind === 'dexs' ? 'dex_volume' : kind === 'revenue' ? 'protocol_revenue' : 'protocol_fees', value: v, unit: 'USD', chain: null, protocol: slug, periodKind: 'DAILY', r, locator: `${slug}:${kind}`, periodStartTs: dayEnd - DAY_MS, periodEndTs: dayEnd, methodologyId: `defillama-${dataType ?? 'dexs'}-total24h-v1` });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'summary rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  async function chains({ names, signal }) {
    const r = await base.call({ endpointId: 'chains', query: {}, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [] };
    const rows = (arr(r.json) ?? []).map(obj).filter(Boolean); const out = [];
    for (const name of names) { const row = rows.find((x) => str(x.name, 60) === name); const v = row ? num(row.tvl) : null; const ob = metric({ endpointId: 'chains', subject: protocolSubject({ protocolId: `chain:${name}`, chain: name }), metricId: 'chain_tvl', value: v, unit: 'USD', chain: name, protocol: null, periodKind: 'POINT', r, locator: `chain:${name}` }); if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function stablecoins({ wanted, signal }) {
    const r = await base.call({ endpointId: 'stablecoins', query: { includePrices: 'true' }, signal, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: wanted.map((w) => base.failureCoverage(r.failure, { endpointId: 'stablecoins', subject: assetSubject({ canonicalCoin: w.stablecoinId, providerAssetId: w.defillamaId }), family: 'STABLECOIN_LIQUIDITY', kind: 'STABLECOIN_METRIC', startTs: base.clock() })) };
    const rows = (arr(obj(r.json)?.peggedAssets) ?? []).map(obj).filter(Boolean); const out = [];
    for (const w of wanted) {
      const row = rows.find((x) => str(x.id, 20) === w.defillamaId); const subj = assetSubject({ canonicalCoin: w.stablecoinId, providerAssetId: w.defillamaId });
      const peg = `pegged${w.pegCurrency}`; const circ = row ? num(obj(row.circulating)?.[peg]) : null; const price = row ? num(row.price) : null;
      const em = (metricId, value, unit) => base.tryEmit({ endpointId: 'stablecoins', subject: subj, kind: 'STABLECOIN_METRIC', sourceKey: `${w.defillamaId}:${metricId}`, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(value === null ? 'MISSING' : 'KNOWN', { reasonCodes: value === null ? ['FIELD_MISSING_AT_SOURCE'] : [], methodologyId: 'defillama-stablecoins-v1', originalUnit: unit }), provenance: base.provenance(r, { nativeLocator: w.defillamaId, mappingId: 'defillama-stablecoin-id-v1' }), payload: { metricId, value, unit, chain: null, stablecoinId: w.stablecoinId, pegCurrency: w.pegCurrency } });
      const a = em('circulating_supply', circ, 'NATIVE'); if (a) out.push(a); const b = em('peg_price', price, 'USD'); if (b) out.push(b);
      for (const [chain, cc] of Object.entries(obj(row?.chainCirculating) ?? {}).slice(0, 32)) { const v = num(obj(obj(cc)?.current)?.[peg]); if (v === null || !/^[A-Za-z0-9 .-]{1,40}$/.test(chain)) continue; const c = base.tryEmit({ endpointId: 'stablecoins', subject: subj, kind: 'STABLECOIN_METRIC', sourceKey: `${w.defillamaId}:bridged:${chain.replace(/[^A-Za-z0-9.-]/g, '-')}`, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('KNOWN', { methodologyId: 'defillama-stablecoins-chain-circulating-v1', originalUnit: 'NATIVE' }), provenance: base.provenance(r, { nativeLocator: `${w.defillamaId}:${chain.replace(/[^A-Za-z0-9.-]/g, '-')}`, mappingId: 'defillama-stablecoin-id-v1' }), payload: { metricId: 'bridged_supply', value: v, unit: 'NATIVE', chain: chain.replace(/[^A-Za-z0-9.-]/g, '-'), stablecoinId: w.stablecoinId, pegCurrency: w.pegCurrency } }); if (c) out.push(c); }
    }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function yields({ protocolSlug, chain, symbol, canonicalCoin = null, signal }) {
    const r = await base.call({ endpointId: 'yields-pools', query: {}, signal, maxBytes: 8 * 1024 * 1024 });
    const subj = protocolSubject({ protocolId: protocolSlug, chain, canonicalCoin });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'yields-pools', subject: subj, family: 'DEX_DEFI', kind: 'DEFI_METRIC', startTs: base.clock() })] };
    const rows = (arr(obj(r.json)?.data) ?? []).map(obj).filter((x) => x && str(x.project, 60) === protocolSlug && str(x.chain, 40) === chain && str(x.symbol, 40) === symbol).slice(0, 4); const out = [];
    for (const p of rows) { const a = metric({ endpointId: 'yields-pools', subject: subj, metricId: 'pool_supply_apy', value: num(p.apyBase) ?? num(p.apy), unit: 'PERCENT', chain, protocol: protocolSlug, periodKind: 'POINT', r, locator: str(p.pool, 120) ?? `${protocolSlug}:${chain}:${symbol}`, methodologyId: 'defillama-yields-apyBase-v1' }); if (a) out.push(a); const b = num(p.apyBaseBorrow); if (b !== null) { const bo = metric({ endpointId: 'yields-pools', subject: subj, metricId: 'pool_borrow_apy', value: b, unit: 'PERCENT', chain, protocol: protocolSlug, periodKind: 'POINT', r, locator: `${str(p.pool, 120) ?? symbol}:borrow`, methodologyId: 'defillama-yields-apyBaseBorrow-v1' }); if (bo) out.push(bo); } }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs, matched: rows.length } };
  }
  return { ...base, protocol, summary, chains, stablecoins, yields };
}
