// SOCIAL-4F — SOCIAL_ADMISSION_SCOPE: the closed, bounded research-filter policy
// that decides what an already-authorized local Social ear ADMITS. Pure: no
// network, no clock, no storage, no authority.
//
// WHY NOT the legacy case-insensitive token filter over hundreds of terms: a
// broad venue catalog contains symbols that collide with ordinary language
// (ONE, GAS, AI, LINK, NEAR, FLOW ...). Feeding them all into a bare-token
// filter would replace a five-coin blind spot with a noisy false map.
//
// THE POLICY (v1), applied per post to ASCII tokens only (no Unicode folding:
// a lookalike never casually becomes an asset match; URLs and @handles are
// removed before tokenizing so a term inside them never matches):
//   CASHTAG          $BASE                       -> research-mention candidate for a catalog market
//   HASHTAG          #BASE (non-ambiguous only)  -> candidate
//   VENUE_PAIR       BASE/USD or BASE-USD        -> candidate
//   UNIQUE_ALIAS     an explicitly validated unique full-name alias (whole word, case-insensitive)
//   BARE_TICKER_CONTEXT  an UPPERCASE standalone non-ambiguous ticker of >= 3 chars WITH a
//                    bounded crypto-context term in the same text (catalog-backed mode)
//   EXPLICIT_TERM    in EXPLICIT_STATIC mode the operator's few explicit terms keep the legacy
//                    case-insensitive standalone-token behaviour (explicit intent, bounded list)
//   WATCH_AUTHOR     an author on the watch list (a separate lane; never asset proof)
//   Bare ordinary words / ambiguous short tickers never establish identity: they are
//   returned as UNRESOLVED (AMBIGUOUS_TICKER_REQUIRES_CASHTAG / BARE_TICKER_NO_CONTEXT); an
//   unknown cashtag is UNRESOLVED (UNKNOWN_CASHTAG) — research information, never a market.
// Admission is a venue-market RESEARCH CANDIDATE, never factual confirmation, never proof of
// the source's intended chain asset, never execution eligibility.
import { contentHash, canonicalJson } from './truth.js';
import { MAX_SOCIAL_TEXT_CHARS, MAX_NATIVE_ID_CHARS } from './social.js';

export const SOCIAL_ADMISSION_POLICY_VERSION = 1;
export const SOCIAL_ADMISSION_MODES = Object.freeze(['CATALOG_BACKED', 'EXPLICIT_STATIC']);
export const SOCIAL_TERMS_FROM = Object.freeze(['CATALOG', 'STATIC']);
export const SOCIAL_MATCH_EVIDENCE = Object.freeze(['CASHTAG', 'HASHTAG', 'VENUE_PAIR', 'UNIQUE_ALIAS', 'BARE_TICKER_CONTEXT', 'EXPLICIT_TERM', 'WATCH_AUTHOR', 'LIFECYCLE_CONTINUITY']);
export const SOCIAL_UNRESOLVED_REASONS = Object.freeze(['UNKNOWN_CASHTAG', 'AMBIGUOUS_TICKER_REQUIRES_CASHTAG', 'BARE_TICKER_NO_CONTEXT']);
export const SOCIAL_SCOPE_MAX_TERMS = 5000;
export const SOCIAL_SCOPE_MAX_STATIC_TERMS = 200;
export const SOCIAL_SCOPE_MAX_ALIASES = 64;
export const SOCIAL_SCOPE_MAX_WATCH_AUTHORS = 64;
const MAX_TOKENS = 512;
export const SOCIAL_BASE_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
// Tickers that are also ordinary words / abbreviations. A bare mention of these never
// identifies the asset: an explicit cashtag, venue pair, or validated alias is required.
// Bounded, closed, versioned with the policy — never learned, never derived from prose.
export const SOCIAL_AMBIGUOUS_TICKERS = Object.freeze([
  'ONE', 'GAS', 'AI', 'LINK', 'NEAR', 'FLOW', 'DOT', 'ATOM', 'SAND', 'MANA', 'APE', 'BAT', 'OP', 'ARB', 'SUN', 'MOON', 'LUNA', 'CORE', 'BAND', 'BOND', 'BLUR', 'PEOPLE', 'GOD', 'JUP', 'RAY', 'ROSE', 'STORJ', 'SUSHI', 'CAKE', 'RUNE', 'WAVES', 'ZERO', 'SUPER', 'STRK', 'BEAM', 'TRU', 'ALPHA', 'BETA', 'OMEGA', 'GRT', 'ARK', 'LIT', 'ACE', 'ACT', 'ADD', 'AGE', 'AIR', 'ALL', 'ANT', 'ARC', 'ART', 'AUTO', 'BAR', 'BIT', 'BOX', 'BUS', 'CAP', 'CAT', 'CITY', 'COW', 'CUBE', 'DASH', 'DATA', 'DAY', 'DOG', 'EGG', 'EDGE', 'FAR', 'FIRE', 'FLIP', 'FUN', 'GAME', 'GEM', 'GET', 'GIGA', 'GLM', 'GO', 'HAT', 'HOT', 'ICE', 'ID', 'IQ', 'JOE', 'KEY', 'LAND', 'LEO', 'LIFE', 'LOOM', 'LUCK', 'MAGIC', 'MASK', 'MATH', 'MAX', 'META', 'MOVE', 'MYTH', 'NOTE', 'OCEAN', 'OM', 'PAY', 'PEN', 'PIN', 'POL', 'POND', 'POWER', 'PRO', 'PUMP', 'RARE', 'REAL', 'RED', 'REN', 'ROOT', 'SAFE', 'SEA', 'SEI', 'SKY', 'SPACE', 'SPELL', 'STAR', 'STEP', 'STORM', 'SUI', 'SWEAT', 'TIME', 'TON', 'TOP', 'TRAC', 'TRAC', 'TRUMP', 'UNI', 'UNIT', 'USD', 'VITAL', 'WELL', 'WEN', 'WIN', 'WOO', 'YES', 'ZEN',
]);
// Bounded crypto-context vocabulary: its presence lets an UPPERCASE non-ambiguous bare ticker
// count as a research mention. Never an anchor on its own.
export const SOCIAL_CONTEXT_TERMS = Object.freeze([
  'crypto', 'cryptocurrency', 'coin', 'coins', 'token', 'tokens', 'altcoin', 'altcoins', 'listing', 'listed', 'listings', 'delist', 'delisted', 'delisting',
  'kraken', 'binance', 'coinbase', 'okx', 'bybit', 'exchange', 'chart', 'charts', 'price', 'pump', 'pumping', 'dump', 'dumping', 'moon', 'mooning', 'hodl', 'bullish', 'bearish', 'ath',
  'mcap', 'marketcap', 'airdrop', 'mainnet', 'testnet', 'wallet', 'defi', 'nft', 'web3', 'blockchain', 'onchain', 'staking', 'stake', 'whale', 'whales', 'breakout', 'rally', 'dip',
  'long', 'short', 'leverage', 'spot', 'perp', 'perps', 'usdt', 'usdc', 'satoshi', 'sats', 'dex', 'cex', 'tvl', 'rug', 'rugpull', 'launch', 'presale', 'tokenomics', 'halving', 'etf', 'fork', 'upgrade', 'news', 'trading', 'trade', 'buy', 'sell', 'volume', 'market', 'markets', 'momentum',
]);
const AMBIGUOUS = new Set(SOCIAL_AMBIGUOUS_TICKERS);
const CONTEXT = new Set(SOCIAL_CONTEXT_TERMS);
const ASCII_RE = /^[\x21-\x7e]+$/;
const CASHTAG_RE = /^\$([A-Za-z][A-Za-z0-9.]{0,14}|[0-9][A-Za-z0-9.]*[A-Za-z][A-Za-z0-9.]*)$/; // never a bare number ($100)
const HASHTAG_RE = /^#([A-Za-z0-9][A-Za-z0-9.]{0,14})$/;
const PAIR_RE = /^([A-Za-z0-9][A-Za-z0-9.]{0,14})[/-](USD|usd)$/;
const BARE_RE = /^[A-Za-z0-9][A-Za-z0-9.]{0,14}$/;
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9]{2,20}$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };

// The ONE filter identity derivation. Catalog-backed terms are content-addressed through the
// catalog content id (never repeated in the scope record); static terms are listed.
export const socialAdmissionFilterId = ({ policyVersion, mode, termsFrom, catalogContentId, terms, aliases, watchAuthorIds }) =>
  contentHash(canonicalJson({ policyVersion, mode, termsFrom, catalogContentId: catalogContentId ?? null, terms: termsFrom === 'STATIC' ? [...terms].sort() : null, aliases: [...aliases].map((a) => ({ alias: a.alias, base: a.base })).sort((x, y) => cmp(x.alias, y.alias)), watchAuthorIds: [...watchAuthorIds].sort() }));

// Compile a closed admission scope, or return { error }. `terms` are canonical research bases
// (catalog bases, or the operator's explicit static terms); `aliases` are validated unique
// alias facts ({ alias, base } — alias unique, base among the terms).
export function compileAdmissionScope({ mode, catalogContentId = null, terms = [], aliases = [], watchAuthorIds = [], policyVersion = SOCIAL_ADMISSION_POLICY_VERSION } = {}) {
  if (policyVersion !== SOCIAL_ADMISSION_POLICY_VERSION) return { error: `admission scope: unsupported policy version ${policyVersion}` };
  if (!SOCIAL_ADMISSION_MODES.includes(mode)) return { error: `admission scope: unknown mode '${mode}'` };
  const termsFrom = mode === 'CATALOG_BACKED' ? 'CATALOG' : 'STATIC';
  if (mode === 'CATALOG_BACKED' && (typeof catalogContentId !== 'string' || !/^[0-9a-f]{40}$/.test(catalogContentId))) return { error: 'admission scope: catalog-backed mode requires the catalog content id' };
  if (mode === 'EXPLICIT_STATIC' && catalogContentId !== null) return { error: 'admission scope: explicit-static mode carries no catalog content id' };
  if (!Array.isArray(terms)) return { error: 'admission scope: terms must be a list' };
  const max = mode === 'CATALOG_BACKED' ? SOCIAL_SCOPE_MAX_TERMS : SOCIAL_SCOPE_MAX_STATIC_TERMS;
  if (terms.length > max) return { error: `admission scope: ${terms.length} terms exceed the bound ${max}` };
  const bases = new Set();
  for (const t of terms) { if (typeof t !== 'string' || !SOCIAL_BASE_RE.test(t)) return { error: `admission scope: term '${String(t).slice(0, 20)}' is not a canonical research base` }; bases.add(t); }
  if (bases.size === 0) return { error: 'admission scope: no terms (an empty scope admits nothing and is never activated)' };
  if (!Array.isArray(aliases) || aliases.length > SOCIAL_SCOPE_MAX_ALIASES) return { error: 'admission scope: aliases malformed or over bound' };
  const aliasMap = new Map();
  for (const a of aliases) {
    if (!a || typeof a !== 'object' || typeof a.alias !== 'string' || !ALIAS_RE.test(a.alias) || typeof a.base !== 'string' || !bases.has(a.base)) return { error: 'admission scope: alias fact malformed or names a base outside the scope' };
    const key = a.alias.toLowerCase();
    if (aliasMap.has(key) && aliasMap.get(key) !== a.base) return { error: `admission scope: alias '${key}' is not unique` };
    aliasMap.set(key, a.base);
  }
  if (!Array.isArray(watchAuthorIds) || watchAuthorIds.length > SOCIAL_SCOPE_MAX_WATCH_AUTHORS) return { error: 'admission scope: watch authors malformed or over bound' };
  const watch = new Set();
  for (const w of watchAuthorIds) { if (typeof w !== 'string' || w.length === 0 || w.length > MAX_NATIVE_ID_CHARS) return { error: 'admission scope: watch author id malformed' }; watch.add(w); }
  const aliasFacts = [...aliasMap].map(([alias, base]) => ({ alias, base })).sort((x, y) => cmp(x.alias, y.alias));
  const sortedTerms = [...bases].sort();
  const filterId = socialAdmissionFilterId({ policyVersion, mode, termsFrom, catalogContentId, terms: sortedTerms, aliases: aliasFacts, watchAuthorIds: [...watch] });
  return { scope: deepFreeze({
    policyVersion, mode, termsFrom, catalogContentId, filterId, termCount: bases.size,
    terms: sortedTerms, aliases: aliasFacts, watchAuthorIds: [...watch].sort(),
    staticBareTokens: mode === 'EXPLICIT_STATIC', // legacy standalone-token behaviour for the operator's explicit few terms
  }) };
}

const stripNoise = (text) => text.replace(/https?:\/\/[^\s]+/g, ' ').replace(/\bwww\.[^\s]+/g, ' ').replace(/(^|[^A-Za-z0-9])@[A-Za-z0-9_.-]+/g, '$1 ');

// Deterministic admission of ONE post text under ONE scope. Returns { match, reasons,
// candidates, unresolved }. `reasons` is the bounded string list the intake records as
// `matchedBy`; candidates are sorted by base; unresolved tokens are bounded research notes.
export function admitSocialText(scope, { text, nativeAuthorId = null } = {}) {
  const reasons = []; const candidates = new Map(); const unresolved = new Map();
  if (scope && nativeAuthorId !== null && scope.watchAuthorIds.includes(nativeAuthorId)) reasons.push('watch-author');
  if (scope && typeof text === 'string' && text.length > 0) {
    const bases = new Set(scope.terms);
    const aliasMap = new Map(scope.aliases.map((a) => [a.alias, a.base]));
    const raw = stripNoise(text.slice(0, MAX_SOCIAL_TEXT_CHARS)).split(/[^A-Za-z0-9$#./-]+/).filter(Boolean).slice(0, MAX_TOKENS);
    const tokens = raw.map((t) => t.replace(/^[./-]+|[./-]+$/g, '')).filter((t) => t.length > 0 && ASCII_RE.test(t));
    const lower = tokens.map((t) => t.toLowerCase());
    let context = lower.some((t) => CONTEXT.has(t));
    const add = (base, evidence, token) => { const prev = candidates.get(base); if (!prev || SOCIAL_MATCH_EVIDENCE.indexOf(evidence) < SOCIAL_MATCH_EVIDENCE.indexOf(prev.evidence)) candidates.set(base, { base, evidence, token }); };
    const note = (token, reason) => { if (unresolved.size < 16 && !unresolved.has(token)) unresolved.set(token, { token: token.slice(0, 20), reason }); };
    const bare = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      let m;
      if ((m = t.match(CASHTAG_RE))) { const b = m[1].toUpperCase(); if (bases.has(b)) { add(b, 'CASHTAG', t); context = true; } else note(t, 'UNKNOWN_CASHTAG'); continue; }
      if ((m = t.match(HASHTAG_RE))) { const b = m[1].toUpperCase(); if (bases.has(b) && !AMBIGUOUS.has(b)) { add(b, 'HASHTAG', t); context = true; } continue; }
      if ((m = t.match(PAIR_RE))) { const b = m[1].toUpperCase(); if (bases.has(b)) { add(b, 'VENUE_PAIR', t); context = true; } continue; }
      if (aliasMap.has(lower[i])) { add(aliasMap.get(lower[i]), 'UNIQUE_ALIAS', t); continue; }
      if (BARE_RE.test(t)) bare.push({ t, i });
    }
    for (const { t, i } of bare) {
      if (scope.staticBareTokens) { const b = t.toUpperCase(); if (bases.has(b)) add(b, 'EXPLICIT_TERM', t); continue; }
      const b = t; // catalog-backed: the ORIGINAL token must be the uppercase ticker itself
      if (!bases.has(b) || lower[i] === b) continue; // lowercase / mixed case never binds a catalog ticker
      if (b.length < 3 || AMBIGUOUS.has(b)) { note(t, 'AMBIGUOUS_TICKER_REQUIRES_CASHTAG'); continue; }
      if (!context) { note(t, 'BARE_TICKER_NO_CONTEXT'); continue; }
      add(b, 'BARE_TICKER_CONTEXT', t);
    }
    for (const c of [...candidates.values()].sort((a, b) => cmp(a.base, b.base))) reasons.push(`term:${c.base.toLowerCase()}`);
  }
  return { match: reasons.length > 0, reasons, candidates: [...candidates.values()].sort((a, b) => cmp(a.base, b.base)), unresolved: [...unresolved.values()] };
}

// AS-OF LAW over scope activations: the scope that governed admission at `knownAtTs` is the
// latest activation with activatedKnownAtTs <= knownAtTs; before the first activation the
// scope is LEGACY_SCOPE_UNKNOWN — never backfilled with a later catalog.
export function socialScopeAt(history, knownAtTs) {
  if (!Array.isArray(history) || !Number.isSafeInteger(knownAtTs)) return { state: 'LEGACY_SCOPE_UNKNOWN', scope: null };
  let best = null;
  for (const s of history) { if (s && Number.isSafeInteger(s.activatedKnownAtTs) && s.activatedKnownAtTs <= knownAtTs && (best === null || s.scopeRevision > best.scopeRevision)) best = s; }
  return best ? { state: 'SCOPED', scope: best } : { state: 'LEGACY_SCOPE_UNKNOWN', scope: null };
}
