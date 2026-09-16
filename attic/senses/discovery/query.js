// Pure catalog-backed planning. Every admitted Kraken USD base receives the same
// canonical ordering, window width, and wraparound rule; no named seed list exists.
import { validateCatalogContent, catalogBases, aliasFactsFor } from '../rumor2/social-catalog.js';
import { compileAdmissionScope, admitSocialText } from '../rumor2/social-scope.js';

export const DISCOVERY_ASSETS_PER_QUERY_DEFAULT = 8;
export const DISCOVERY_ASSETS_PER_QUERY_MAX = 12;
const BASE_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;

export function discoveryCatalogContext(snapshot, { nowTs = Date.now() } = {}) {
  const fail = (reason) => ({ error: `DISCOVERY_CATALOG_REQUIRED: ${reason}` });
  if (!snapshot || snapshot.status !== 'ACCEPTED' || !snapshot.catalog) return fail('an accepted WideEye catalog snapshot is required');
  if (snapshot.fresh !== true) return fail('the accepted catalog must be explicitly fresh');
  const checked = validateCatalogContent(snapshot.catalog);
  if (checked.error) return fail(checked.error);
  if (!Number.isSafeInteger(nowTs) || checked.catalog.observedTs > nowTs) return fail('catalog clock is invalid or in the future');
  const bases = catalogBases(checked.catalog);
  const compiled = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: checked.catalog.contentId, terms: bases, aliases: aliasFactsFor(bases) });
  if (compiled.error) return fail(compiled.error);
  return Object.freeze({ catalog: checked.catalog, bases: Object.freeze(bases), scope: compiled.scope });
}

export function gdeltCatalogQuery(context, { requestOrdinal = 0, assetsPerQuery = DISCOVERY_ASSETS_PER_QUERY_DEFAULT } = {}) {
  const fail = (reason) => ({ error: `GDELT_QUERY_SCOPE_REQUIRED: ${reason}` });
  if (!context?.catalog || !Array.isArray(context.bases) || context.bases.length === 0) return fail('catalog context missing');
  if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal < 0) return fail('request ordinal');
  if (!Number.isSafeInteger(assetsPerQuery) || assetsPerQuery < 1 || assetsPerQuery > DISCOVERY_ASSETS_PER_QUERY_MAX) return fail(`assetsPerQuery must be in 1..${DISCOVERY_ASSETS_PER_QUERY_MAX}`);
  if (context.bases.some((base) => !BASE_RE.test(base))) return fail('malformed catalog base');
  const take = Math.min(assetsPerQuery, context.bases.length);
  const start = (requestOrdinal * assetsPerQuery) % context.bases.length;
  const bases = Array.from({ length: take }, (_, index) => context.bases[(start + index) % context.bases.length]);
  const assetBlock = `(${bases.map((base) => `"${base}"`).join(' OR ')})`;
  const query = `${assetBlock} (crypto OR cryptocurrency OR token OR blockchain)`;
  if (query.length > 512) return fail('query exceeds 512 characters');
  return Object.freeze({ query, bases: Object.freeze(bases), start, requestOrdinal, assetsPerQuery, population: context.bases.length, catalogContentId: context.catalog.contentId, sweepRequests: Math.ceil(context.bases.length / assetsPerQuery) });
}

export function matchCatalogText(context, text) {
  if (!context?.scope) return Object.freeze({ assets: Object.freeze([]), evidence: Object.freeze([]), unresolved: Object.freeze([]) });
  const result = admitSocialText(context.scope, { text: String(text ?? '').slice(0, 6000) });
  return Object.freeze({
    assets: Object.freeze(result.candidates.map((candidate) => candidate.base)),
    evidence: Object.freeze(result.candidates.map((candidate) => `${candidate.base}:${candidate.evidence}`)),
    unresolved: Object.freeze(result.unresolved.slice(0, 16)),
  });
}
