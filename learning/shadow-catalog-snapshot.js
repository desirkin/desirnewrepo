// FORWARD-SHADOW accepted-catalog boundary. The bundle inventory is NOT the market denominator: a trusted
// composition supplies one full accepted parent catalog, this module seals every exact MARKET identity, and
// the runner persists that seal plus the explicit bundle-to-market mapping before it reads any bundle.
import { canonicalDigest, deepFreeze, exactKeys, isPlainObject, isTs, stableStringify } from './shadow-contracts.js';

export const SHADOW_CATALOG_SNAPSHOT_VERSION = 'shadow-accepted-catalog-1';
export const SHADOW_CATALOG_CONTROL_VERSION = 'shadow-catalog-control-1';
export const SHADOW_CATALOG_CONTROL = 'ACCEPTED_CATALOG_DENOMINATOR';
export const MAX_ACCEPTED_CATALOG_AGE_MS = 24 * 60 * 60_000;
export const MAX_ACCEPTED_MARKETS = 25_000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const MARKET_TYPES = Object.freeze(['SPOT', 'PERPETUAL', 'FUTURE', 'OPTION']);
const MARKET_KEYS = Object.freeze(['subjectKind', 'canonicalCoin', 'providerAssetId', 'venue', 'nativeSymbol', 'base', 'quote', 'marketType', 'quoteAliasGroup']);
const SNAPSHOT_KEYS = Object.freeze(['snapshotVersion', 'contentId', 'contentDigest', 'parentCatalogDigest', 'acceptedMarketCount', 'observedTs', 'knownAtTs', 'maxAgeMs', 'markets']);
const MAPPING_KEYS = Object.freeze(['mappingDigest', 'mappings', 'failures']);
const MAPPING_ROW_KEYS = Object.freeze(['marketIdentityDigest', 'state', 'sourceCount', 'sourceDigests']);
const FAILURE_KEYS = Object.freeze(['sourceDigest', 'reason', 'marketIdentityDigest']);
const CONTROL_KEYS = Object.freeze(['controlVersion', 'control', 'recipeVersion', 'recipeDigest', 'snapshot', 'mapping']);
const MAPPING_STATES = Object.freeze(['VISIBLE', 'MISSING']);
const MAPPING_FAILURES = Object.freeze(['SOURCE_DESCRIPTOR_MALFORMED', 'SOURCE_IDENTITY_NOT_ACCEPTED', 'SOURCE_IDENTITY_FIELDS_DISAGREE', 'DUPLICATE_SOURCE_DESCRIPTOR']);

const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isIdOrNull = (v) => v === null || isId(v);

export function acceptedMarketIdentityError(market, where = 'market') {
  const keys = exactKeys(market, MARKET_KEYS); if (keys) return `${where}: ${keys}`;
  if (market.subjectKind !== 'MARKET') return `${where}: subjectKind must be MARKET`;
  if (typeof market.canonicalCoin !== 'string' || !COIN_RE.test(market.canonicalCoin)) return `${where}: canonicalCoin malformed`;
  if (!isId(market.providerAssetId)) return `${where}: providerAssetId required`;
  for (const key of ['venue', 'nativeSymbol', 'base', 'quote']) if (!isId(market[key])) return `${where}: ${key} malformed`;
  if (!MARKET_TYPES.includes(market.marketType)) return `${where}: marketType outside vocabulary`;
  if (!isIdOrNull(market.quoteAliasGroup)) return `${where}: quoteAliasGroup malformed`;
  return null;
}

export function marketIdentityDigest(market) {
  const err = acceptedMarketIdentityError(market); if (err) throw new Error(`shadow catalog: ${err}`);
  return canonicalDigest({ identityVersion: 'market-subject-1', market });
}

const parentDigestOf = (markets) => canonicalDigest({ snapshotVersion: SHADOW_CATALOG_SNAPSHOT_VERSION, markets });
const contentDigestOf = (snapshot) => canonicalDigest({
  snapshotVersion: snapshot.snapshotVersion,
  parentCatalogDigest: snapshot.parentCatalogDigest,
  acceptedMarketCount: snapshot.acceptedMarketCount,
  observedTs: snapshot.observedTs,
  knownAtTs: snapshot.knownAtTs,
  maxAgeMs: snapshot.maxAgeMs,
  markets: snapshot.markets,
});

export function sealAcceptedCatalogSnapshot({ observedTs, knownAtTs, maxAgeMs, markets }) {
  if (!Array.isArray(markets)) throw new Error('shadow catalog: markets must be an array');
  const cloned = markets.map((market) => JSON.parse(stableStringify(market)));
  for (let i = 0; i < cloned.length; i += 1) {
    const err = acceptedMarketIdentityError(cloned[i], `markets[${i}]`); if (err) throw new Error(`shadow catalog: ${err}`);
  }
  cloned.sort((a, b) => marketIdentityDigest(a).localeCompare(marketIdentityDigest(b)));
  const snapshot = {
    snapshotVersion: SHADOW_CATALOG_SNAPSHOT_VERSION,
    contentId: '', contentDigest: '',
    parentCatalogDigest: parentDigestOf(cloned), acceptedMarketCount: cloned.length,
    observedTs, knownAtTs, maxAgeMs, markets: cloned,
  };
  snapshot.contentDigest = contentDigestOf(snapshot);
  snapshot.contentId = `asc-${snapshot.contentDigest}`;
  const err = acceptedCatalogSnapshotError(snapshot); if (err) throw new Error(`shadow catalog: ${err}`);
  return deepFreeze(snapshot);
}

// When `nowTs` is supplied, freshness is part of validity. Structure/digests can also be checked without a
// clock when constructing a control; the runner always supplies its own step clock before bundle discovery.
export function acceptedCatalogSnapshotError(snapshot, { nowTs = null } = {}) {
  const keys = exactKeys(snapshot, SNAPSHOT_KEYS); if (keys) return `snapshot: ${keys}`;
  if (snapshot.snapshotVersion !== SHADOW_CATALOG_SNAPSHOT_VERSION) return 'snapshot: unsupported version';
  if (!isTs(snapshot.observedTs) || !isTs(snapshot.knownAtTs) || snapshot.knownAtTs < snapshot.observedTs) return 'snapshot: observation clocks malformed';
  if (!Number.isSafeInteger(snapshot.maxAgeMs) || snapshot.maxAgeMs < 1 || snapshot.maxAgeMs > MAX_ACCEPTED_CATALOG_AGE_MS) return 'snapshot: maxAgeMs outside bounded law';
  if (!Array.isArray(snapshot.markets) || snapshot.markets.length < 1 || snapshot.markets.length > MAX_ACCEPTED_MARKETS) return 'snapshot: accepted market inventory malformed';
  if (snapshot.acceptedMarketCount !== snapshot.markets.length) return 'snapshot: acceptedMarketCount differs from inventory';
  const digests = [];
  const learningKeys = [];
  for (let i = 0; i < snapshot.markets.length; i += 1) {
    const err = acceptedMarketIdentityError(snapshot.markets[i], `snapshot.markets[${i}]`); if (err) return err;
    digests.push(marketIdentityDigest(snapshot.markets[i]));
    learningKeys.push(`${snapshot.markets[i].venue}:${snapshot.markets[i].canonicalCoin}`);
  }
  if (new Set(digests).size !== digests.length) return 'snapshot: duplicate market identity';
  // Captures currently key a learning market as venue+canonicalCoin. Two accepted pair identities under that
  // same key would collide downstream even though their full catalog identities differ, so refuse the whole
  // snapshot rather than silently merge USD/USDT (or two listings) into one alleged market.
  if (new Set(learningKeys).size !== learningKeys.length) return 'snapshot: duplicate downstream learning market identity';
  if (digests.join('\n') !== [...digests].sort().join('\n')) return 'snapshot: market inventory is not canonical-sorted';
  if (!SHA256_RE.test(String(snapshot.parentCatalogDigest)) || snapshot.parentCatalogDigest !== parentDigestOf(snapshot.markets)) return 'snapshot: parent catalog digest forged';
  if (!SHA256_RE.test(String(snapshot.contentDigest)) || snapshot.contentDigest !== contentDigestOf(snapshot)) return 'snapshot: content digest forged';
  if (snapshot.contentId !== `asc-${snapshot.contentDigest}`) return 'snapshot: contentId forged';
  if (nowTs !== null) {
    if (!isTs(nowTs)) return 'snapshot: validation clock malformed';
    if (snapshot.observedTs > nowTs || snapshot.knownAtTs > nowTs) return 'snapshot: future catalog clock';
    if (nowTs - snapshot.observedTs > snapshot.maxAgeMs || nowTs - snapshot.knownAtTs > snapshot.maxAgeMs) return 'snapshot: catalog stale';
  }
  return null;
}

const sourceDigestOf = (source) => canonicalDigest({
  sourceVersion: 'shadow-bundle-source-1',
  dir: typeof source?.dir === 'string' ? source.dir : null,
  venue: source?.venue ?? null, canonicalCoin: source?.canonicalCoin ?? null,
  marketIdentityDigest: source?.marketIdentityDigest ?? null,
});

// Every readable source needs an EXPLICIT sealed-market digest. venue/coin are retained only as redundant
// checks; they can never infer an identity when a venue lists multiple quote pairs for one coin.
export function buildAcceptedCatalogMapping(snapshot, sources) {
  const serr = acceptedCatalogSnapshotError(snapshot); if (serr) throw new Error(`shadow catalog mapping: ${serr}`);
  if (!Array.isArray(sources)) throw new Error('shadow catalog mapping: sources must be an array');
  const marketByDigest = new Map(snapshot.markets.map((market) => [marketIdentityDigest(market), market]));
  const admitted = []; const failures = []; const sourceDigestsByMarket = new Map(); const seenSources = new Set();
  sources.forEach((source) => {
    const sourceDigest = sourceDigestOf(source);
    const fail = (reason, marketDigest = null) => failures.push({ sourceDigest, reason, marketIdentityDigest: marketDigest });
    if (!isPlainObject(source) || typeof source.dir !== 'string' || source.dir.length < 1 || !isId(source.venue)
        || typeof source.canonicalCoin !== 'string' || !COIN_RE.test(source.canonicalCoin) || !SHA256_RE.test(String(source.marketIdentityDigest))) {
      fail('SOURCE_DESCRIPTOR_MALFORMED'); return;
    }
    if (seenSources.has(sourceDigest)) { fail('DUPLICATE_SOURCE_DESCRIPTOR', source.marketIdentityDigest); return; }
    seenSources.add(sourceDigest);
    const market = marketByDigest.get(source.marketIdentityDigest);
    if (!market) { fail('SOURCE_IDENTITY_NOT_ACCEPTED', source.marketIdentityDigest); return; }
    if (source.venue !== market.venue || source.canonicalCoin !== market.canonicalCoin) { fail('SOURCE_IDENTITY_FIELDS_DISAGREE', source.marketIdentityDigest); return; }
    if (!sourceDigestsByMarket.has(source.marketIdentityDigest)) sourceDigestsByMarket.set(source.marketIdentityDigest, []);
    sourceDigestsByMarket.get(source.marketIdentityDigest).push(sourceDigest);
    admitted.push({ dir: source.dir, venue: source.venue, canonicalCoin: source.canonicalCoin, marketIdentityDigest: source.marketIdentityDigest, sourceDigest, market });
  });
  const mappings = snapshot.markets.map((market) => {
    const digest = marketIdentityDigest(market); const sourceDigests = [...(sourceDigestsByMarket.get(digest) ?? [])].sort();
    return { marketIdentityDigest: digest, state: sourceDigests.length ? 'VISIBLE' : 'MISSING', sourceCount: sourceDigests.length, sourceDigests };
  });
  failures.sort((a, b) => a.sourceDigest.localeCompare(b.sourceDigest) || a.reason.localeCompare(b.reason));
  const publicMapping = { mappingDigest: '', mappings, failures };
  publicMapping.mappingDigest = canonicalDigest({ mappings, failures });
  return { mapping: deepFreeze(publicMapping), admitted: deepFreeze(admitted), rejectedSourceCount: failures.length };
}

export function acceptedCatalogMappingError(mapping, snapshot) {
  const keys = exactKeys(mapping, MAPPING_KEYS); if (keys) return `mapping: ${keys}`;
  if (!Array.isArray(mapping.mappings) || mapping.mappings.length !== snapshot.acceptedMarketCount) return 'mapping: rows do not reconcile to accepted catalog';
  if (!Array.isArray(mapping.failures)) return 'mapping: failures malformed';
  const accepted = snapshot.markets.map(marketIdentityDigest);
  for (let i = 0; i < mapping.mappings.length; i += 1) {
    const row = mapping.mappings[i]; const rk = exactKeys(row, MAPPING_ROW_KEYS); if (rk) return `mapping[${i}]: ${rk}`;
    if (row.marketIdentityDigest !== accepted[i]) return `mapping[${i}]: market identity/order differs from accepted catalog`;
    if (!MAPPING_STATES.includes(row.state) || !Number.isSafeInteger(row.sourceCount) || row.sourceCount < 0 || !Array.isArray(row.sourceDigests)
        || row.sourceDigests.length !== row.sourceCount || row.sourceDigests.some((x) => !SHA256_RE.test(String(x)))
        || new Set(row.sourceDigests).size !== row.sourceDigests.length || row.sourceDigests.join('\n') !== [...row.sourceDigests].sort().join('\n')
        || (row.state === 'VISIBLE') !== (row.sourceCount > 0)) return `mapping[${i}]: source inventory malformed`;
  }
  for (let i = 0; i < mapping.failures.length; i += 1) {
    const failure = mapping.failures[i]; const fk = exactKeys(failure, FAILURE_KEYS); if (fk) return `mapping failure[${i}]: ${fk}`;
    if (!SHA256_RE.test(String(failure.sourceDigest)) || !MAPPING_FAILURES.includes(failure.reason)
        || !(failure.marketIdentityDigest === null || SHA256_RE.test(String(failure.marketIdentityDigest)))) return `mapping failure[${i}]: malformed`;
  }
  if (!SHA256_RE.test(String(mapping.mappingDigest)) || mapping.mappingDigest !== canonicalDigest({ mappings: mapping.mappings, failures: mapping.failures })) return 'mapping: digest forged';
  return null;
}

export function catalogControlBody({ snapshot, mapping, recipeVersion, recipeDigest }) {
  const serr = acceptedCatalogSnapshotError(snapshot); if (serr) throw new Error(`shadow catalog control: ${serr}`);
  const merr = acceptedCatalogMappingError(mapping, snapshot); if (merr) throw new Error(`shadow catalog control: ${merr}`);
  if (!isId(recipeVersion) || !SHA256_RE.test(String(recipeDigest))) throw new Error('shadow catalog control: recipe identity malformed');
  const control = `${SHADOW_CATALOG_CONTROL}:${recipeVersion}:${recipeDigest}:${snapshot.contentDigest}:${mapping.mappingDigest}`;
  return deepFreeze({ controlVersion: SHADOW_CATALOG_CONTROL_VERSION, control, recipeVersion, recipeDigest, snapshot, mapping });
}

export function catalogControlError(body, { nowTs = null } = {}) {
  const keys = exactKeys(body, CONTROL_KEYS); if (keys) return `catalog control: ${keys}`;
  if (body.controlVersion !== SHADOW_CATALOG_CONTROL_VERSION || !isId(body.recipeVersion) || !SHA256_RE.test(String(body.recipeDigest))) return 'catalog control: identity malformed';
  const serr = acceptedCatalogSnapshotError(body.snapshot, { nowTs }); if (serr) return `catalog control: ${serr}`;
  const merr = acceptedCatalogMappingError(body.mapping, body.snapshot); if (merr) return `catalog control: ${merr}`;
  const expected = `${SHADOW_CATALOG_CONTROL}:${body.recipeVersion}:${body.recipeDigest}:${body.snapshot.contentDigest}:${body.mapping.mappingDigest}`;
  if (body.control !== expected) return 'catalog control: control key forged';
  return null;
}
