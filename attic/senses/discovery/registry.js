// Account-free, read-only discovery sources. These routes expose public metadata only;
// none grants trading, posting, wallet, identity, or licensed-publisher authority.
export const DISCOVERY_REGISTRY_VERSION = 'serpent-public-discovery-registry-1';
export const DISCOVERY_SOURCE_IDS = Object.freeze(['GDELT_NEWS_DISCOVERY', 'POLYMARKET_PUBLIC_DATA', 'KALSHI_PUBLIC_DATA']);
const ACCESSED = '2026-09-12';
const doc = (url, note) => Object.freeze({ url, accessedOn: ACCESSED, note });
const PINNED_SOURCE_TRANSPORT = Object.freeze({
  GDELT_NEWS_DISCOVERY: Object.freeze({ kind: 'NEWS_INDEX', route: 'GDELT_DOC_JSON', baseUrl: 'https://api.gdeltproject.org/api/v2/doc/doc', host: 'api.gdeltproject.org' }),
  POLYMARKET_PUBLIC_DATA: Object.freeze({ kind: 'PREDICTION_MARKET', route: 'KEYSET_JSON', baseUrl: 'https://gamma-api.polymarket.com/markets/keyset', host: 'gamma-api.polymarket.com' }),
  KALSHI_PUBLIC_DATA: Object.freeze({ kind: 'PREDICTION_MARKET', route: 'CURSOR_JSON', baseUrl: 'https://external-api.kalshi.com/trade-api/v2/markets', host: 'external-api.kalshi.com' }),
});

export const DISCOVERY_SOURCES = Object.freeze([
  Object.freeze({
    id: 'GDELT_NEWS_DISCOVERY', kind: 'NEWS_INDEX', route: 'GDELT_DOC_JSON', host: 'api.gdeltproject.org',
    baseUrl: 'https://api.gdeltproject.org/api/v2/doc/doc', cadenceSec: 5400, maxDailyEnv: 'DISCOVERY_GDELT_MAX_DAILY_REQUESTS',
    pageLimitEnv: 'DISCOVERY_GDELT_RESULT_LIMIT', assetsPerQueryEnv: 'DISCOVERY_GDELT_ASSETS_PER_QUERY',
    coverage: 'INDEXED_DISCOVERY_LINK_METADATA_ONLY',
    docs: Object.freeze([doc('https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/', 'DOC 2.0 supports ArticleList JSON, bounded result counts, timespans, and domain filters.')]),
  }),
  Object.freeze({
    id: 'POLYMARKET_PUBLIC_DATA', kind: 'PREDICTION_MARKET', route: 'KEYSET_JSON', host: 'gamma-api.polymarket.com',
    baseUrl: 'https://gamma-api.polymarket.com/markets/keyset', cadenceSec: 3600, maxDailyEnv: 'DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS',
    pageLimitEnv: 'DISCOVERY_POLYMARKET_PAGE_LIMIT', coverage: 'PUBLIC_READ_ONLY_MARKET_METADATA',
    docs: Object.freeze([doc('https://docs.polymarket.com/api-reference/markets/list-markets-keyset-pagination', 'Public keyset market listing; cursor pagination; no trading route used.'), doc('https://docs.polymarket.com/market-data/overview', 'Public market data needs no key, authentication, or wallet.')]),
  }),
  Object.freeze({
    id: 'KALSHI_PUBLIC_DATA', kind: 'PREDICTION_MARKET', route: 'CURSOR_JSON', host: 'external-api.kalshi.com',
    baseUrl: 'https://external-api.kalshi.com/trade-api/v2/markets', cadenceSec: 3600, maxDailyEnv: 'DISCOVERY_KALSHI_MAX_DAILY_REQUESTS',
    pageLimitEnv: 'DISCOVERY_KALSHI_PAGE_LIMIT', coverage: 'PUBLIC_READ_ONLY_MARKET_METADATA',
    docs: Object.freeze([doc('https://docs.kalshi.com/getting_started/quick_start_market_data', 'Public market metadata endpoints need no authentication.'), doc('https://docs.kalshi.com/api-reference/market/get-markets', 'Open-market cursor pagination; maximum documented page size 1000.')]),
  }),
]);

export const discoverySource = (id) => DISCOVERY_SOURCES.find((source) => source.id === id) ?? null;

export function discoveryRegistryError(sources = DISCOVERY_SOURCES) {
  const ids = new Set();
  for (const source of sources) {
    if (!DISCOVERY_SOURCE_IDS.includes(source.id) || ids.has(source.id)) return `bad or duplicate source ${source.id}`;
    ids.add(source.id);
    const pinned = PINNED_SOURCE_TRANSPORT[source.id];
    if (source.kind !== pinned.kind) return `${source.id}: kind`;
    if (source.route !== pinned.route) return `${source.id}: route`;
    let url; try { url = new URL(source.baseUrl); } catch { return `${source.id}: URL`; }
    if (source.baseUrl !== pinned.baseUrl || source.host !== pinned.host || url.protocol !== 'https:' || url.hostname !== pinned.host || url.username || url.password || url.port || url.search || url.hash || !Number.isSafeInteger(source.cadenceSec) || source.cadenceSec < 900) return `${source.id}: transport`;
    if (!Array.isArray(source.docs) || source.docs.length === 0 || source.docs.some((d) => d.accessedOn !== ACCESSED || !d.url.startsWith('https://'))) return `${source.id}: docs`;
  }
  return ids.size === DISCOVERY_SOURCE_IDS.length ? null : 'registry is incomplete';
}
