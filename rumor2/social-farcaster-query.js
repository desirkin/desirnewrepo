// Deterministic, catalog-backed query planning for Neynar cast search.
// This module is pure: it performs no network request and holds no credentials.
// Every accepted catalog base receives the same lexicographic rotation rule.
export const FARCASTER_QUERY_MODES = Object.freeze(['NOT_CONFIGURED', 'EXPLICIT_STATIC', 'CATALOG_ROTATION']);
export const FARCASTER_CATALOG_ASSETS_PER_QUERY_DEFAULT = 8;
export const FARCASTER_CATALOG_ASSETS_PER_QUERY_MAX = 8;

const BASE_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const CASHTAG_BASE_RE = /^(?:[A-Z][A-Z0-9.]{0,14}|[0-9][A-Z0-9.]*[A-Z][A-Z0-9.]*)$/;
const CONTENT_ID_RE = /^[0-9a-f]{40}$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const literalFor = (base) => CASHTAG_BASE_RE.test(base) ? `$${base}` : `"${base}/USD"`;

export function buildFarcasterCatalogQuery({ candidate, requestOrdinal = 0, assetsPerQuery = FARCASTER_CATALOG_ASSETS_PER_QUERY_DEFAULT } = {}) {
  const fail = (reason) => ({ error: `CATALOG_QUERY_SCOPE_REQUIRED: ${reason}` });
  if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal < 0) return fail('requestOrdinal must be a non-negative safe integer');
  if (!Number.isSafeInteger(assetsPerQuery) || assetsPerQuery < 1 || assetsPerQuery > FARCASTER_CATALOG_ASSETS_PER_QUERY_MAX) return fail(`assetsPerQuery must be in 1..${FARCASTER_CATALOG_ASSETS_PER_QUERY_MAX}`);
  if (!candidate || candidate.status !== 'CATALOG_BACKED') return fail('a fresh accepted catalog candidate is required');
  const { catalog, scope } = candidate;
  if (!catalog || !scope || scope.mode !== 'CATALOG_BACKED') return fail('catalog-backed scope is missing');
  if (!CONTENT_ID_RE.test(catalog.contentId ?? '') || scope.catalogContentId !== catalog.contentId) return fail('catalog and scope content ids disagree');
  if (!Array.isArray(catalog.markets) || !Array.isArray(scope.terms) || catalog.markets.length === 0) return fail('catalog bases are unavailable');

  const bases = catalog.markets.map((market) => market?.base);
  if (bases.some((base) => typeof base !== 'string' || !BASE_RE.test(base))) return fail('catalog carries a malformed base');
  if (new Set(bases).size !== bases.length || bases.some((base, index) => index > 0 && cmp(bases[index - 1], base) >= 0)) return fail('catalog bases are not unique canonical order');
  if (scope.terms.length !== bases.length || bases.some((base, index) => scope.terms[index] !== base)) return fail('query bases do not exactly match the admitted scope');

  const take = Math.min(assetsPerQuery, bases.length);
  const start = (requestOrdinal * assetsPerQuery) % bases.length;
  const selected = Array.from({ length: take }, (_, index) => bases[(start + index) % bases.length]);
  const query = selected.map(literalFor).join(' OR ');
  if (query.length === 0 || query.length > 256) return fail('generated query is outside the runtime bound');
  return Object.freeze({
    query,
    bases: Object.freeze(selected),
    catalogContentId: catalog.contentId,
    requestOrdinal,
    start,
    assetsPerQuery,
    population: bases.length,
  });
}
