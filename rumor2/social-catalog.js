// SOCIAL-4F — the RUMOR side of the DISCOVERY CATALOG: closed research configuration,
// validation of an INJECTED read-only survey snapshot (never fetched here), freshness
// law, and the research scope SOURCE the Bluesky runtime consults each settle.
//
//   * Social receives a detached snapshot accessor from application composition
//     (fly.js retains the wide-eye handle). It holds no mutable survey map, no
//     callback that changes survey posture, and no authority to start the wide eye
//     or any other market-data collection.
//   * Without an injected source the answer is CATALOG_UNAVAILABLE — never an invented
//     broad universe, never a silent fallback to the five legacy config assets.
//   * A snapshot is adopted only after its closed shape and content id re-derive here;
//     a stale accepted catalog may continue to describe an already-active scope but
//     never grants NEW scope; a future-dated observation is refused.
//   * EXPLICIT_STATIC is a labelled, intentionally configured bounded mode (tests /
//     smoke); it is never a production fallback for a missing catalog.
import { contentHash, canonicalJson, buildCoinRegistry } from './truth.js';
import { compileAdmissionScope, SOCIAL_ADMISSION_POLICY_VERSION, SOCIAL_BASE_RE, SOCIAL_SCOPE_MAX_STATIC_TERMS } from './social-scope.js';

export const SOCIAL_RESEARCH_CONFIG_VERSION = 1;
export const SOCIAL_CATALOG_SOURCES = Object.freeze(['WIDEEYE_ASSET_PAIRS']);
export const SOCIAL_LOCAL_ADMISSION_MODES = Object.freeze(['NOT_CONFIGURED', 'CATALOG_BACKED', 'EXPLICIT_STATIC']);
export const SOCIAL_X_WATCH_MODES = Object.freeze(['NOT_CONFIGURED', 'EXPLICIT_STATIC']);
export const SOCIAL_CATALOG_REFRESH_MIN_SEC = 300;
export const SOCIAL_CATALOG_MAX_AGE_MAX_SEC = 900;
export const SOCIAL_CATALOG_MAX_MARKETS = 5000;
export const SOCIAL_X_WATCH_MAX_ASSETS = 25;
export const SOCIAL_CATALOG_MARKET_KEYS = Object.freeze(['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status']);
export const SOCIAL_CATALOG_STATES = Object.freeze(['CATALOG_BACKED', 'EXPLICIT_STATIC', 'STALE', 'UNAVAILABLE']);
export const SOCIAL_CATALOG_FRESHNESS = Object.freeze(['FRESH', 'STALE', 'FUTURE']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const TICKER_RE = /^[A-Z0-9]{2,15}$/;

// ---- closed research configuration (fail closed: an invalid section is NOT_CONFIGURED with a reason) ----
export const SOCIAL_RESEARCH_DEFAULTS = deepFreeze({
  catalog: { source: 'WIDEEYE_ASSET_PAIRS', refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 },
  localAdmission: { mode: 'NOT_CONFIGURED', policyVersion: SOCIAL_ADMISSION_POLICY_VERSION, staticTerms: [] },
  xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: SOCIAL_X_WATCH_MAX_ASSETS },
  watchPlan: { maxXAssets: SOCIAL_X_WATCH_MAX_ASSETS },
});
export function parseSocialResearchConfig(config) {
  const section = config?.socialResearch;
  if (section === undefined) return { ok: true, present: false, research: SOCIAL_RESEARCH_DEFAULTS, reason: 'SOCIAL_RESEARCH_SECTION_ABSENT' };
  const bad = (reason) => ({ ok: false, present: true, research: SOCIAL_RESEARCH_DEFAULTS, reason: `CONFIG_INVALID: ${reason}` });
  if (!isPlainObject(section)) return bad('socialResearch is not an object');
  for (const k of Object.keys(section)) if (!['catalog', 'localAdmission', 'xWatch', 'watchPlan'].includes(k)) return bad(`undeclared key '${k}'`);
  const c = { ...SOCIAL_RESEARCH_DEFAULTS.catalog, ...(isPlainObject(section.catalog) ? section.catalog : {}) };
  if (section.catalog !== undefined && !isPlainObject(section.catalog)) return bad('catalog is not an object');
  for (const k of Object.keys(c)) if (!['source', 'refreshSec', 'maxAgeSec', 'maxMarkets'].includes(k)) return bad(`catalog: undeclared key '${k}'`);
  if (!SOCIAL_CATALOG_SOURCES.includes(c.source)) return bad(`catalog.source '${c.source}' is not a closed source`);
  if (!posInt(c.refreshSec) || c.refreshSec < SOCIAL_CATALOG_REFRESH_MIN_SEC) return bad(`catalog.refreshSec must be an integer >= ${SOCIAL_CATALOG_REFRESH_MIN_SEC}`);
  if (!posInt(c.maxAgeSec) || c.maxAgeSec < c.refreshSec || c.maxAgeSec > SOCIAL_CATALOG_MAX_AGE_MAX_SEC) return bad(`catalog.maxAgeSec must be an integer between refreshSec and ${SOCIAL_CATALOG_MAX_AGE_MAX_SEC}`);
  if (!posInt(c.maxMarkets) || c.maxMarkets > SOCIAL_CATALOG_MAX_MARKETS) return bad(`catalog.maxMarkets must be an integer between 1 and ${SOCIAL_CATALOG_MAX_MARKETS}`);
  const l = { ...SOCIAL_RESEARCH_DEFAULTS.localAdmission, ...(isPlainObject(section.localAdmission) ? section.localAdmission : {}) };
  if (section.localAdmission !== undefined && !isPlainObject(section.localAdmission)) return bad('localAdmission is not an object');
  for (const k of Object.keys(l)) if (!['mode', 'policyVersion', 'staticTerms'].includes(k)) return bad(`localAdmission: undeclared key '${k}'`);
  if (!SOCIAL_LOCAL_ADMISSION_MODES.includes(l.mode)) return bad(`localAdmission.mode '${l.mode}' is not a closed mode`);
  if (l.policyVersion !== SOCIAL_ADMISSION_POLICY_VERSION) return bad(`localAdmission.policyVersion must be ${SOCIAL_ADMISSION_POLICY_VERSION}`);
  if (!Array.isArray(l.staticTerms) || l.staticTerms.length > SOCIAL_SCOPE_MAX_STATIC_TERMS || l.staticTerms.some((t) => typeof t !== 'string' || !SOCIAL_BASE_RE.test(t))) return bad('localAdmission.staticTerms must be a bounded list of canonical bases');
  if (l.mode === 'EXPLICIT_STATIC' && l.staticTerms.length === 0) return bad('localAdmission EXPLICIT_STATIC requires explicit staticTerms');
  if (l.mode !== 'EXPLICIT_STATIC' && l.staticTerms.length > 0) return bad('localAdmission.staticTerms is only meaningful in EXPLICIT_STATIC mode');
  const x = { ...SOCIAL_RESEARCH_DEFAULTS.xWatch, ...(isPlainObject(section.xWatch) ? section.xWatch : {}) };
  if (section.xWatch !== undefined && !isPlainObject(section.xWatch)) return bad('xWatch is not an object');
  for (const k of Object.keys(x)) if (!['mode', 'tickers', 'maxAssets'].includes(k)) return bad(`xWatch: undeclared key '${k}'`);
  if (!SOCIAL_X_WATCH_MODES.includes(x.mode)) return bad(`xWatch.mode '${x.mode}' is not a closed mode`);
  if (!posInt(x.maxAssets) || x.maxAssets > SOCIAL_X_WATCH_MAX_ASSETS) return bad(`xWatch.maxAssets must be an integer between 1 and ${SOCIAL_X_WATCH_MAX_ASSETS} (an operator cap may only be stricter)`);
  if (!Array.isArray(x.tickers) || x.tickers.some((t) => typeof t !== 'string' || !TICKER_RE.test(t))) return bad('xWatch.tickers must be a list of uppercase tickers');
  if (new Set(x.tickers).size !== x.tickers.length) return bad('xWatch.tickers repeats a ticker');
  if (x.tickers.length > x.maxAssets) return bad(`xWatch.tickers (${x.tickers.length}) exceed maxAssets ${x.maxAssets} — never truncated silently`);
  if (x.mode === 'EXPLICIT_STATIC' && x.tickers.length === 0) return bad('xWatch EXPLICIT_STATIC requires explicit tickers');
  if (x.mode === 'NOT_CONFIGURED' && x.tickers.length > 0) return bad('xWatch.tickers require xWatch.mode EXPLICIT_STATIC (no implicit paid scope)');
  const w = { ...SOCIAL_RESEARCH_DEFAULTS.watchPlan, ...(isPlainObject(section.watchPlan) ? section.watchPlan : {}) };
  if (section.watchPlan !== undefined && !isPlainObject(section.watchPlan)) return bad('watchPlan is not an object');
  for (const k of Object.keys(w)) if (!['maxXAssets'].includes(k)) return bad(`watchPlan: undeclared key '${k}'`);
  if (!posInt(w.maxXAssets) || w.maxXAssets > SOCIAL_X_WATCH_MAX_ASSETS) return bad(`watchPlan.maxXAssets must be an integer between 1 and ${SOCIAL_X_WATCH_MAX_ASSETS}`);
  return { ok: true, present: true, research: deepFreeze({ catalog: c, localAdmission: { ...l, staticTerms: [...l.staticTerms].sort() }, xWatch: { ...x, tickers: [...x.tickers].sort() }, watchPlan: w }), reason: null };
}

// ---- injected snapshot validation (closed shape; content id re-derived with the rumor helpers) ----
export const socialCatalogContentId = ({ venue, quote, policyVersion, markets }) => contentHash(canonicalJson({ venue, quote, policyVersion, markets: markets.map((m) => { const o = {}; for (const k of SOCIAL_CATALOG_MARKET_KEYS) o[k] = m[k]; return o; }) }));
export function validateCatalogContent(c, { maxMarkets = SOCIAL_CATALOG_MAX_MARKETS } = {}) {
  if (!isPlainObject(c)) return { error: 'catalog: not an object' };
  if (c.venue !== 'kraken' || c.quote !== 'USD') return { error: 'catalog: venue/quote outside the supported set' };
  if (c.policyVersion !== 1) return { error: `catalog: unsupported normalization policy ${c.policyVersion}` };
  if (!posInt(c.observedTs)) return { error: 'catalog: observedTs must be a positive safe integer' };
  if (typeof c.contentId !== 'string' || !/^[0-9a-f]{40}$/.test(c.contentId)) return { error: 'catalog: contentId malformed' };
  if (!Array.isArray(c.markets) || c.markets.length === 0) return { error: 'catalog: no markets (an empty catalog is never accepted as a universe)' };
  if (c.markets.length > maxMarkets) return { error: `catalog: ${c.markets.length} markets exceed the bound ${maxMarkets}` };
  const bases = new Set(); const keys = new Set();
  let prev = null;
  for (const m of c.markets) {
    if (!isPlainObject(m)) return { error: 'catalog: market row malformed' };
    for (const k of Object.keys(m)) if (!SOCIAL_CATALOG_MARKET_KEYS.includes(k)) return { error: `catalog: market row carries undeclared key '${k}'` };
    for (const k of SOCIAL_CATALOG_MARKET_KEYS) if (!(k in m)) return { error: `catalog: market row misses '${k}'` };
    if (typeof m.pairKey !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(m.pairKey) || keys.has(m.pairKey)) return { error: 'catalog: pairKey malformed or repeated' };
    if (typeof m.base !== 'string' || !SOCIAL_BASE_RE.test(m.base) || bases.has(m.base)) return { error: `catalog: base '${String(m.base).slice(0, 20)}' malformed or repeated` };
    if (m.quote !== 'USD' || m.status !== 'online') return { error: 'catalog: only online USD markets are supported rows' };
    if (typeof m.wsname !== 'string' || !m.wsname.endsWith('/USD') || m.wsname.length > 40) return { error: 'catalog: wsname malformed' };
    if (m.nativeBase !== null && (typeof m.nativeBase !== 'string' || m.nativeBase.length === 0 || m.nativeBase.length > 20)) return { error: 'catalog: nativeBase malformed' };
    if (m.nativeQuote !== null && typeof m.nativeQuote !== 'string') return { error: 'catalog: nativeQuote malformed' };
    if (prev !== null && !(cmp(prev.base, m.base) < 0 || (prev.base === m.base && cmp(prev.pairKey, m.pairKey) < 0))) return { error: 'catalog: markets are not in canonical order' };
    keys.add(m.pairKey); bases.add(m.base); prev = m;
  }
  if (!isPlainObject(c.counts) || c.counts.supported !== c.markets.length || !Number.isSafeInteger(c.counts.observed) || c.counts.observed < c.markets.length) return { error: 'catalog: counts disagree with content' };
  for (const k of ['excluded', 'unresolved']) if (!Number.isSafeInteger(c.counts[k]) || c.counts[k] < 0) return { error: `catalog: counts.${k} malformed` };
  if (socialCatalogContentId(c) !== c.contentId) return { error: 'catalog: contentId does not re-derive from the markets' };
  const markets = c.markets.map((m) => ({ pairKey: m.pairKey, nativeBase: m.nativeBase, nativeQuote: m.nativeQuote, wsname: m.wsname, base: m.base, quote: m.quote, status: m.status }));
  return { catalog: deepFreeze({ venue: c.venue, quote: c.quote, policyVersion: c.policyVersion, observedTs: c.observedTs, contentId: c.contentId, counts: { observed: c.counts.observed, supported: c.counts.supported, excluded: c.counts.excluded, unresolved: c.counts.unresolved }, markets, source: typeof c.source === 'string' ? c.source.slice(0, 80) : 'UNKNOWN' }) };
}
export const catalogBases = (catalog) => (catalog ? [...new Set(catalog.markets.map((m) => m.base))].sort() : []);

export function catalogFreshness(catalog, nowMs, maxAgeSec) {
  if (!catalog || !Number.isSafeInteger(nowMs)) return 'STALE';
  if (catalog.observedTs > nowMs + 60_000) return 'FUTURE'; // a minute of tolerance for clock skew between the acquisition and evaluation clocks
  return nowMs - catalog.observedTs <= maxAgeSec * 1000 ? 'FRESH' : 'STALE';
}

// Validated unique alias facts for the bases in scope: the SAME approved facts the official
// resolver holds, read only — never widened here, never derived from social prose.
export function aliasFactsFor(bases) {
  const reg = buildCoinRegistry(bases);
  return [...reg.aliases].map(([alias, base]) => ({ alias: alias.toLowerCase(), base })).sort((a, b) => cmp(a.alias, b.alias));
}

// ---- the research scope SOURCE the Bluesky runtime consults each settle ------------------
// source = { snapshot(): frozen accepted-catalog snapshot | null, notices(): bounded list } or null.
// `now` is an INJECTED clock (the collector's) — this module never reads a wall clock of its own.
export function createResearchScopeSource({ research = SOCIAL_RESEARCH_DEFAULTS, configReason = null, source = null, now = null } = {}) {
  const local = research.localAdmission;
  let lastSnapshot = null; let lastValidation = null;
  const unavailable = (reason, extra = {}) => ({ status: 'UNAVAILABLE', reason, catalog: null, scope: null, freshness: null, ...extra });
  function candidate({ knownAtTs = typeof now === 'function' ? now() : null } = {}) {
    if (!Number.isSafeInteger(knownAtTs)) return unavailable('CLOCK_UNAVAILABLE: the evaluation clock must be injected');
    if (configReason) return unavailable(configReason);
    if (local.mode === 'NOT_CONFIGURED') return unavailable('LOCAL_ADMISSION_NOT_CONFIGURED');
    if (local.mode === 'EXPLICIT_STATIC') {
      const c = compileAdmissionScope({ mode: 'EXPLICIT_STATIC', terms: local.staticTerms, aliases: aliasFactsFor(local.staticTerms) });
      if (c.error) return unavailable(`STATIC_SCOPE_INVALID: ${c.error}`);
      return { status: 'EXPLICIT_STATIC', reason: 'EXPLICIT_STATIC_MODE_CONFIGURED (labelled; not a production catalog)', catalog: null, scope: c.scope, freshness: null };
    }
    if (!source || typeof source.snapshot !== 'function') return unavailable('CATALOG_SOURCE_NOT_INJECTED: no wide-eye snapshot accessor at composition (Social never starts the wide eye)');
    let snap = null;
    try { snap = source.snapshot(); } catch (err) { return unavailable(`CATALOG_SNAPSHOT_THREW: ${String(err?.message ?? err).slice(0, 120)}`); }
    lastSnapshot = snap;
    if (!isPlainObject(snap)) return unavailable('CATALOG_SNAPSHOT_MALFORMED');
    if (snap.status !== 'ACCEPTED' || !snap.catalog) return unavailable(`CATALOG_NOT_ACCEPTED: ${typeof snap.lastError === 'string' ? snap.lastError.slice(0, 160) : snap.status ?? 'no accepted catalog yet'}`);
    const v = validateCatalogContent(snap.catalog, { maxMarkets: research.catalog.maxMarkets });
    lastValidation = v.error ?? null;
    if (v.error) return unavailable(`CATALOG_INVALID: ${v.error}`);
    const freshness = catalogFreshness(v.catalog, knownAtTs, research.catalog.maxAgeSec);
    if (freshness === 'FUTURE') return unavailable('CATALOG_OBSERVED_IN_FUTURE: the acquisition clock is ahead of the evaluation clock', { catalog: v.catalog, freshness });
    const bases = catalogBases(v.catalog);
    const c = compileAdmissionScope({ mode: 'CATALOG_BACKED', catalogContentId: v.catalog.contentId, terms: bases, aliases: aliasFactsFor(bases) });
    if (c.error) return unavailable(`SCOPE_COMPILE_FAILED: ${c.error}`, { catalog: v.catalog, freshness });
    return { status: freshness === 'FRESH' ? 'CATALOG_BACKED' : 'STALE', reason: freshness === 'FRESH' ? null : `CATALOG_STALE: observed ${knownAtTs - v.catalog.observedTs} ms ago exceeds maxAgeSec ${research.catalog.maxAgeSec} — no new scope from stale data`, catalog: v.catalog, scope: c.scope, freshness };
  }
  function notices() {
    if (!source || typeof source.notices !== 'function') return [];
    try { const n = source.notices(); return Array.isArray(n) ? n.slice(0, 500) : []; } catch { return []; }
  }
  function status(knownAtTs = typeof now === 'function' ? now() : null) {
    const c = candidate({ knownAtTs });
    return {
      configPresent: research !== SOCIAL_RESEARCH_DEFAULTS, configReason,
      mode: local.mode, state: c.status, reason: c.reason ?? null,
      catalog: c.catalog ? { source: c.catalog.source, contentId: c.catalog.contentId, observedTs: c.catalog.observedTs, freshness: c.freshness, counts: c.catalog.counts, maxAgeSec: research.catalog.maxAgeSec, refreshSec: research.catalog.refreshSec } : null,
      snapshot: isPlainObject(lastSnapshot) ? { status: lastSnapshot.status ?? null, lastError: typeof lastSnapshot.lastError === 'string' ? lastSnapshot.lastError.slice(0, 160) : null, lastSuccessTs: lastSnapshot.lastSuccessTs ?? null, lastAttemptTs: lastSnapshot.lastAttemptTs ?? null, validation: lastValidation } : null,
      scope: c.scope ? { filterId: c.scope.filterId, termCount: c.scope.termCount, aliasCount: c.scope.aliases.length, policyVersion: c.scope.policyVersion, mode: c.scope.mode } : null,
    };
  }
  return { candidate, notices, status, research };
}
