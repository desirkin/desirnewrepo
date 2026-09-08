// D06 — COINGECKO (keyless public / Demo key) and GECKOTERMINAL (public on-chain DEX). Canonical provider ids come
// from the real coins list; a supplied id must agree with the canonical symbol or the join is refused. The two API
// brands belong to one team and are labelled as ONE provenance group (never independent corroboration). Pool
// `reserve_in_usd` is total pool value — recorded as liquidity, never as executable depth; rolling volume is activity,
// never new flow.
import { createClientBase, num, int, str, tsFromIso, tsFromSeconds, arr, obj, assetSubject, poolSubject, marketSubject } from './base.js';
import { quality, deepFreeze, isCoin } from '../contracts.js';

export const COINGECKO_MAPPING_ID = 'coingecko-coins-list-v3';
export const GECKOTERMINAL_MAPPING_ID = 'geckoterminal-pools-v2';
export const COINGECKO_PROVENANCE_GROUP = 'coingecko-team'; // CoinGecko + GeckoTerminal share it
export function createCoinGeckoClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'COINGECKO', transport, clock, log, credential });
  let list = null;
  async function loadCoinsList({ signal } = {}) {
    const r = await base.call({ endpointId: 'coins-list', query: { include_platform: 'true' }, signal, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) return r;
    const rows = arr(r.json); if (!rows) return { ok: false, failure: { kind: 'SCHEMA', reason: 'coins list malformed', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    const byId = new Map();
    for (const raw of rows) { const c = obj(raw); const id = str(c?.id, 120); const sym = str(c?.symbol, 40); if (!id || !sym) continue; const platforms = {}; for (const [chain, addr] of Object.entries(obj(c.platforms) ?? {})) { if (/^[a-z0-9-]{1,40}$/.test(chain) && (addr === '' || (typeof addr === 'string' && /^[A-Za-z0-9:_.-]{1,120}$/.test(addr)))) platforms[chain] = addr === '' ? null : addr; } byId.set(id, { id, symbol: sym.toUpperCase(), name: str(c.name, 120), platforms }); }
    list = deepFreeze({ byId, observedTs: r.receivedTs, requestId: r.requestId, sha256: r.sha256, count: byId.size });
    return { ok: true, count: byId.size, meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  function resolveAsset({ canonicalCoin, coingeckoId }) {
    if (!list) return { ok: false, reason: 'CATALOG_NOT_LOADED' };
    if (!isCoin(canonicalCoin) || !coingeckoId) return { ok: false, reason: 'COIN_MALFORMED' };
    const c = list.byId.get(coingeckoId); if (!c) return { ok: false, reason: 'NOT_IN_CATALOG' };
    if (c.symbol !== canonicalCoin) return { ok: false, reason: 'AMBIGUOUS_MAPPING', detail: 'provider symbol disagrees with the canonical coin' };
    return { ok: true, asset: deepFreeze({ subject: assetSubject({ canonicalCoin, providerAssetId: c.id }), coingeckoId: c.id, platforms: c.platforms, mappingKnownAtTs: list.observedTs }) };
  }
  async function markets({ assets, signal }) {
    const r = await base.call({ endpointId: 'coins-markets', query: { vs_currency: 'usd', ids: assets.map((a) => a.coingeckoId).join(','), per_page: Math.min(250, assets.length), page: 1 }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: assets.map((a) => base.failureCoverage(r.failure, { endpointId: 'coins-markets', subject: a.subject, family: 'SUPPLY_UNLOCKS', kind: 'ASSET_REFERENCE', startTs: base.clock() })) };
    const rows = (arr(r.json) ?? []).map(obj).filter(Boolean); const out = [];
    for (const a of assets) {
      const m = rows.find((x) => x.id === a.coingeckoId); if (!m) continue;
      const ob = base.tryEmit({ endpointId: 'coins-markets', subject: a.subject, kind: 'ASSET_REFERENCE', sourceKey: a.coingeckoId, sourceEventTs: tsFromIso(m.last_updated), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(num(m.current_price) !== null ? 'KNOWN' : 'MISSING', { reasonCodes: num(m.current_price) !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'coingecko-coins-markets-v3', originalUnit: 'USD' }), provenance: base.provenance(r, { nativeLocator: a.coingeckoId, mappingId: COINGECKO_MAPPING_ID, vintage: str(m.last_updated, 40) }),
        payload: { providerAssetId: a.coingeckoId, name: str(m.name, 120), symbolNative: a.subject.canonicalCoin, marketCapUsd: num(m.market_cap), fdvUsd: num(m.fully_diluted_valuation), circulatingSupply: num(m.circulating_supply), totalSupply: num(m.total_supply), maxSupply: num(m.max_supply), priceUsd: num(m.current_price), volume24hUsd: num(m.total_volume), categories: [], platforms: a.platforms, capMethodologyId: 'coingecko-market-cap-v3', lastUpdatedTs: tsFromIso(m.last_updated) } });
      if (ob) out.push(ob);
    }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function detail({ asset, signal }) {
    const r = await base.call({ endpointId: 'coin-detail', pathParams: { id: asset.coingeckoId }, query: { localization: 'false', tickers: 'false', market_data: 'true', community_data: 'false', developer_data: 'false' }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'coin-detail', subject: asset.subject, family: 'SUPPLY_UNLOCKS', kind: 'ASSET_REFERENCE', startTs: base.clock() })] };
    const c = obj(r.json); const md = obj(c?.market_data) ?? {}; const usd = (k) => num(obj(md[k])?.usd);
    const categories = (arr(c?.categories) ?? []).filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 32);
    const ob = base.tryEmit({ endpointId: 'coin-detail', subject: asset.subject, kind: 'ASSET_REFERENCE', sourceKey: asset.coingeckoId, sourceEventTs: tsFromIso(c?.last_updated), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(usd('current_price') !== null ? 'KNOWN' : 'MISSING', { reasonCodes: usd('current_price') !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'coingecko-coin-detail-v3', originalUnit: 'USD' }), provenance: base.provenance(r, { nativeLocator: asset.coingeckoId, mappingId: COINGECKO_MAPPING_ID, vintage: str(c?.last_updated, 40) }),
      payload: { providerAssetId: asset.coingeckoId, name: str(c?.name, 120), symbolNative: asset.subject.canonicalCoin, marketCapUsd: usd('market_cap'), fdvUsd: usd('fully_diluted_valuation'), circulatingSupply: num(md.circulating_supply), totalSupply: num(md.total_supply), maxSupply: num(md.max_supply), priceUsd: usd('current_price'), volume24hUsd: usd('total_volume'), categories: [...new Set(categories)], platforms: asset.platforms, capMethodologyId: 'coingecko-market-cap-v3', lastUpdatedTs: tsFromIso(c?.last_updated) } });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'detail rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  return { ...base, loadCoinsList, resolveAsset, markets, detail, list: () => list, provenanceGroup: COINGECKO_PROVENANCE_GROUP };
}

export function createGeckoTerminalClient({ transport, clock, log } = {}) {
  const base = createClientBase({ providerId: 'GECKOTERMINAL', transport, clock, log });
  const poolFromAttributes = (network, address, x, canonicalCoin) => {
    const a = obj(x?.attributes) ?? {}; const rel = obj(x?.relationships) ?? {};
    const quoteId = str(obj(obj(rel.quote_token)?.data)?.id, 120); const baseId = str(obj(obj(rel.base_token)?.data)?.id, 120); const dex = str(obj(obj(rel.dex)?.data)?.id, 60);
    const quoteToken = quoteId ? quoteId.replace(`${network}_`, '') : 'unknown'; const baseToken = baseId ? baseId.replace(`${network}_`, '') : 'unknown';
    const vol = obj(a.volume_usd) ?? {}; const tx = obj(obj(a.transactions)?.h24) ?? {};
    return { subject: poolSubject({ canonicalCoin, providerAssetId: str(x?.id, 160), chain: network, poolAddress: address, quoteToken }), payload: { chain: network, poolAddress: address, dex, baseToken, quoteToken, priceUsd: num(a.base_token_price_usd), priceQuote: num(a.base_token_price_quote_token), liquidityUsd: num(a.reserve_in_usd), volume24hUsd: num(vol.h24), volume1hUsd: num(vol.h1), txCount24h: int(tx.buys) !== null && int(tx.sells) !== null ? int(tx.buys) + int(tx.sells) : null, poolCreatedTs: tsFromIso(a.pool_created_at), feePct: num(a.pool_fee_percentage) } };
  };
  async function pool({ network, address, canonicalCoin, signal }) {
    const r = await base.call({ endpointId: 'pool', pathParams: { network, address }, query: {}, signal });
    const subj = poolSubject({ canonicalCoin, chain: network, poolAddress: address, quoteToken: 'unknown' });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'pool', subject: subj, family: 'DEX_DEFI', kind: 'DEX_POOL', startTs: base.clock() })] };
    const d = obj(obj(r.json)?.data); if (!d) return { ok: false, failure: { kind: 'SCHEMA', reason: 'pool data missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const p = poolFromAttributes(network, address, d, canonicalCoin);
    const ob = base.tryEmit({ endpointId: 'pool', subject: p.subject, kind: 'DEX_POOL', sourceKey: `${network}:${address}`, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(p.payload.priceUsd !== null ? 'KNOWN' : 'MISSING', { reasonCodes: p.payload.priceUsd !== null ? ['DELAYED_DATA'] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'geckoterminal-pool-v2', originalUnit: 'USD' }), provenance: base.provenance(r, { nativeLocator: `${network}:${address}`, mappingId: GECKOTERMINAL_MAPPING_ID }), payload: p.payload });
    return ob ? { ok: true, observations: [ob], coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } } : { ok: false, failure: { kind: 'SCHEMA', reason: 'pool rejected', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
  }
  async function tokenPools({ network, tokenAddress, canonicalCoin, signal, max = 20 }) {
    const r = await base.call({ endpointId: 'token-pools', pathParams: { network, address: tokenAddress }, query: { page: 1 }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [], pools: [] };
    const pools = (arr(obj(r.json)?.data) ?? []).slice(0, max).map((d) => { const addr = str(obj(obj(d)?.attributes)?.address, 120); return addr ? poolFromAttributes(network, addr, d, canonicalCoin) : null; }).filter(Boolean);
    return { ok: true, pools, meta: { requestId: r.requestId, receivedTs: r.receivedTs, count: pools.length } };
  }
  async function poolOhlcv({ network, address, canonicalCoin, quoteToken = 'unknown', timeframe = 'hour', aggregate = 1, limit = 100, signal }) {
    if (!['day', 'hour', 'minute'].includes(timeframe)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'timeframe', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() }, coverage: [] };
    const subject = marketSubject({ canonicalCoin, providerAssetId: null, venue: `geckoterminal-${network}`, nativeSymbol: address, base: canonicalCoin, quote: quoteToken, marketType: 'SPOT' });
    const r = await base.call({ endpointId: 'pool-ohlcv', pathParams: { network, address, timeframe }, query: { aggregate, limit: Math.min(1000, limit), currency: 'usd' }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'pool-ohlcv', subject, family: 'DEX_DEFI', kind: 'CANDLE', startTs: base.clock() })] };
    const rows = arr(obj(obj(obj(r.json)?.data)?.attributes)?.ohlcv_list) ?? []; const intervalMs = (timeframe === 'day' ? 86_400 : timeframe === 'hour' ? 3_600 : 60) * aggregate * 1000; const out = [];
    for (const raw of rows) { const a = arr(raw); if (!a || a.length < 6) continue; const open = tsFromSeconds(a[0]); if (open === null) continue; const closeTs = open + intervalMs; const provisional = closeTs > r.receivedTs;
      const ob = base.tryEmit({ endpointId: 'pool-ohlcv', subject, kind: 'CANDLE', sourceKey: `${network}:${address}:${timeframe}:${a[0]}`, sourceEventTs: provisional ? null : closeTs, periodStartTs: open, periodEndTs: closeTs, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(provisional ? 'PROVISIONAL' : 'KNOWN', { reasonCodes: provisional ? ['UNCOMMITTED_BAR'] : ['DELAYED_DATA'], coverageStartTs: open, coverageEndTs: provisional ? r.receivedTs : closeTs, methodologyId: 'geckoterminal-pool-ohlcv-usd-v2', originalUnit: 'USD' }), provenance: base.provenance(r, { nativeLocator: `${network}:${address}:${a[0]}`, mappingId: GECKOTERMINAL_MAPPING_ID }), payload: { intervalMs, open: num(a[1]), high: num(a[2]), low: num(a[3]), close: num(a[4]), volumeBase: null, volumeQuote: num(a[5]), tradeCount: null, vwap: null, closed: !provisional, provisional } });
      if (ob) out.push(ob); }
    out.sort((x, y) => x.periodStartTs - y.periodStartTs);
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'pool-ohlcv', subject, family: 'DEX_DEFI', kind: 'CANDLE', state: out.length ? 'OBSERVED' : 'GAP', startTs: out.length ? out[0].periodStartTs : r.receivedTs, endTs: out.length ? out[out.length - 1].periodEndTs : r.receivedTs, observationCount: out.length })], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  return { ...base, pool, tokenPools, poolOhlcv, provenanceGroup: COINGECKO_PROVENANCE_GROUP };
}
