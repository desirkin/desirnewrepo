// SOCIAL-4F — THE DISCOVERY CATALOG normalization. ONE pure module shared by the
// wide eye's existing AssetPairs acquisition (the only upstream catalog fetch)
// and consumed, as a detached read-only snapshot, by the Social research scope.
//
//   DISCOVERY_CATALOG = the markets current venue evidence lets us observe /
//   research. It is NOT execution eligibility, NOT account/jurisdiction
//   authorization, NOT a profitability list, and NOT the deep-tape selection
//   (tape/universe.js keeps its own volume floors, cap, and major preferences).
//
// Membership law: an online Kraken USD spot pair that passes the existing
// stable/fiat base exclusions is in discovery REGARDLESS of volume, market cap,
// sample count, deep-tape membership, price extension, or alias availability.
// Those facts limit later interpretation or execution; they never erase
// catalog membership. Unknown volume stays unknown here (this module carries
// no ticker data at all).
//
// Identity law: venue-native identifiers are preserved and distinguished from
// display aliases. Only the two documented legacy aliases (XBT->BTC, XDG->DOGE)
// are applied; no asset identity is ever derived by stripping leading X/Z
// letters. Contradictory native-id / symbol associations REFUSE the candidate
// catalog (never last-row-wins); coherent duplicate keys for one market dedupe.
//
// No network, no disk, no clock: the observation clock is a caller input.
import { createHash } from 'node:crypto';

// Same canonical form + sha1-hex as rumor2/truth.js (the survey tier imports
// nothing from the rumor layer; rumor2/social-catalog.js re-derives the same
// content id with the rumor helpers and a test pins the two derivations equal).
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`)).filter(Boolean).join(',')}}`;
};
const sha1 = (text) => createHash('sha1').update(String(text)).digest('hex');

export const KRAKEN_CATALOG_POLICY_VERSION = 1;
export const KRAKEN_CATALOG_VENUE = 'kraken';
export const KRAKEN_CATALOG_QUOTE = 'USD';
export const KRAKEN_BASE_ALIASES = Object.freeze({ XBT: 'BTC', XDG: 'DOGE' }); // the ONLY display-alias rewrites (the same two the deep selection and the wide eye apply)
export const CATALOG_MARKET_KEYS = Object.freeze(['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status']);
export const CATALOG_MARKET_STATUSES = Object.freeze(['online']); // supported statuses — every other documented status is an explicit exclusion
export const CATALOG_EXCLUSION_REASONS = Object.freeze(['STATUS_NOT_ONLINE', 'QUOTE_NOT_USD', 'WSNAME_NOT_USD_SPOT', 'BASE_EXCLUDED_STABLE_OR_FIAT']);
export const CATALOG_UNRESOLVED_REASONS = Object.freeze(['ROW_MALFORMED', 'BASE_UNRESOLVABLE', 'NATIVE_ID_MISSING', 'DUPLICATE_COHERENT_ALIAS']);
export const CATALOG_REFUSAL_REASONS = Object.freeze(['RESPONSE_MALFORMED', 'RESPONSE_EMPTY', 'OBSERVED_CLOCK_INVALID', 'ZERO_SUPPORTED', 'CATALOG_OVERFLOW', 'CONTRADICTORY_NATIVE_MAPPING', 'CONTRADICTORY_BASE_ASSOCIATION', 'SUSPECTED_INCOMPLETE', 'OBSERVED_CLOCK_REGRESSION']);
export const CATALOG_MAX_MARKETS_DEFAULT = 5000;
export const CATALOG_MAX_DROP_FRACTION_DEFAULT = 0.5;
const BASE_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/; // a canonical research base: uppercase venue symbol (digit-prefixed tickers such as 1INCH included)
const PAIR_KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;
// SOCIAL-4F CLOSEOUT — the EXACT supported wsname grammar: ONE base segment, ONE `/USD` quote
// segment, nothing else. A suffix check alone (`endsWith('/USD')`) is not a base/quote locator:
// `LINK/OTHER/USD` names no supported spot market and must never become LINK.
export const KRAKEN_WSNAME_USD_RE = /^([A-Z0-9][A-Z0-9.]{0,14})\/USD$/;
// a retained venue-native asset identifier (Kraken `base`, e.g. XXBT, XETH, 1INCH): required
// for a SUPPORTED row — a row without one is UNRESOLVED, never a verified supported market
export const KRAKEN_NATIVE_ID_RE = /^[A-Z0-9.]{1,20}$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- the shared per-row primitive (wide eye sweep + catalog use the SAME rule) ----------
// Returns { base } for an online USD spot pair whose base is not excluded, or a typed
// { excluded } / { unresolved } outcome. Never throws.
export function krakenUsdSpotBase(pair, excluded = new Set()) {
  if (!isPlainObject(pair)) return { unresolved: 'ROW_MALFORMED' };
  if (pair.status !== 'online') return { excluded: 'STATUS_NOT_ONLINE' };
  if (pair.quote !== 'ZUSD' && pair.quote !== 'USD') return { excluded: 'QUOTE_NOT_USD' };
  if (typeof pair.wsname !== 'string' || pair.wsname.length > 40) return { excluded: 'WSNAME_NOT_USD_SPOT' };
  if (!pair.wsname.endsWith('/USD')) return { excluded: 'WSNAME_NOT_USD_SPOT' };
  const m = pair.wsname.match(KRAKEN_WSNAME_USD_RE);
  if (!m) return pair.wsname.split('/').length !== 2 ? { excluded: 'WSNAME_NOT_USD_SPOT' } : { unresolved: 'BASE_UNRESOLVABLE' }; // three segments: not a spot locator; two segments with a non-canonical base: unresolvable
  const raw = m[1];
  const base = KRAKEN_BASE_ALIASES[raw] ?? raw;
  if (!BASE_RE.test(base)) return { unresolved: 'BASE_UNRESOLVABLE' };
  if (excluded.has(base.toUpperCase())) return { excluded: 'BASE_EXCLUDED_STABLE_OR_FIAT' };
  return { base };
}

export const catalogContentId = ({ venue, quote, policyVersion, markets }) => sha1(canonicalJson({ venue, quote, policyVersion, markets: markets.map((m) => { const o = {}; for (const k of CATALOG_MARKET_KEYS) o[k] = m[k]; return o; }) }));

// Normalize ONE complete AssetPairs result map into the closed discovery catalog, or refuse.
// A refusal never destroys previously accepted truth (the caller keeps it) and never
// invents a mass delisting.
export function normalizeKrakenAssetPairs(result, { excludeBases = [], observedTs, maxMarkets = CATALOG_MAX_MARKETS_DEFAULT } = {}) {
  if (!Number.isSafeInteger(observedTs) || observedTs <= 0) return { ok: false, reason: 'OBSERVED_CLOCK_INVALID', detail: 'the acquisition clock must be a positive safe-integer epoch-ms value' };
  if (!isPlainObject(result)) return { ok: false, reason: 'RESPONSE_MALFORMED', detail: 'AssetPairs result is not an object map' };
  const keys = Object.keys(result);
  if (keys.length === 0) return { ok: false, reason: 'RESPONSE_EMPTY', detail: 'AssetPairs result carries no pairs — not an authoritative empty universe' };
  const excluded = new Set((Array.isArray(excludeBases) ? excludeBases : []).filter((b) => typeof b === 'string').map((b) => b.toUpperCase()));
  const supported = []; const excludedRows = []; const unresolved = []; const responseOrder = [];
  const byWsname = new Map(); // wsname -> nativeBase (contradiction check)
  const byNative = new Map(); // nativeBase -> research base (contradiction check)
  const byBase = new Map(); // canonical base -> { nativeBase, pairKey, wsname }
  const duplicates = [];
  for (const pairKey of keys) {
    if (!PAIR_KEY_RE.test(pairKey)) { unresolved.push({ pairKey: String(pairKey).slice(0, 40), reason: 'ROW_MALFORMED' }); continue; }
    const pair = result[pairKey];
    const r = krakenUsdSpotBase(pair, excluded);
    if (r.unresolved) { unresolved.push({ pairKey, reason: r.unresolved }); continue; }
    if (r.excluded) { excludedRows.push({ pairKey, reason: r.excluded, status: typeof pair.status === 'string' ? pair.status.slice(0, 20) : null }); continue; }
    // a SUPPORTED row retains its venue-native identifiers; a row whose native base is missing or
    // malformed is classified UNRESOLVED (never silently a verified supported market)
    if (typeof pair.base !== 'string' || !KRAKEN_NATIVE_ID_RE.test(pair.base)) { unresolved.push({ pairKey, reason: 'NATIVE_ID_MISSING' }); continue; }
    const nativeBase = pair.base;
    const nativeQuote = pair.quote; // already ZUSD | USD
    const prevWs = byWsname.get(pair.wsname);
    if (prevWs !== undefined && prevWs !== nativeBase) return { ok: false, reason: 'CONTRADICTORY_NATIVE_MAPPING', detail: `wsname ${pair.wsname} is associated with native bases ${prevWs} and ${nativeBase}` };
    byWsname.set(pair.wsname, nativeBase);
    // ONE native asset identifies ONE supported USD spot market: the same native base under two
    // different research bases is a contradiction, never last-row-wins
    const prevNative = byNative.get(nativeBase);
    if (prevNative !== undefined && prevNative !== r.base) return { ok: false, reason: 'CONTRADICTORY_NATIVE_MAPPING', detail: `native base ${nativeBase} is associated with research bases ${prevNative} and ${r.base}` };
    byNative.set(nativeBase, r.base);
    const prevBase = byBase.get(r.base);
    if (prevBase !== undefined) {
      if (prevBase.nativeBase !== nativeBase || prevBase.wsname !== pair.wsname) return { ok: false, reason: 'CONTRADICTORY_BASE_ASSOCIATION', detail: `research base ${r.base} is claimed by ${prevBase.pairKey} (${prevBase.wsname}/${prevBase.nativeBase}) and ${pairKey} (${pair.wsname}/${nativeBase})` };
      // coherent alias key for the same market: keep the lexicographically smallest pair key, deterministic
      if (cmp(pairKey, prevBase.pairKey) < 0) { duplicates.push({ pairKey: prevBase.pairKey, keptPairKey: pairKey }); const i = supported.findIndex((m) => m.pairKey === prevBase.pairKey); supported[i] = { pairKey, nativeBase, nativeQuote, wsname: pair.wsname, base: r.base, quote: KRAKEN_CATALOG_QUOTE, status: 'online' }; byBase.set(r.base, { nativeBase, pairKey, wsname: pair.wsname }); }
      else duplicates.push({ pairKey, keptPairKey: prevBase.pairKey });
      unresolved.push({ pairKey: cmp(pairKey, prevBase.pairKey) < 0 ? prevBase.pairKey : pairKey, reason: 'DUPLICATE_COHERENT_ALIAS' });
      continue;
    }
    byBase.set(r.base, { nativeBase, pairKey, wsname: pair.wsname });
    supported.push({ pairKey, nativeBase, nativeQuote, wsname: pair.wsname, base: r.base, quote: KRAKEN_CATALOG_QUOTE, status: 'online' });
    responseOrder.push(pairKey);
  }
  if (supported.length === 0) return { ok: false, reason: 'ZERO_SUPPORTED', detail: `no online USD spot pair survived normalization (${excludedRows.length} excluded, ${unresolved.length} unresolved) — not an authoritative empty universe` };
  if (supported.length > maxMarkets) return { ok: false, reason: 'CATALOG_OVERFLOW', detail: `${supported.length} supported markets exceed the hard bound ${maxMarkets}; previous accepted truth is retained and scope promotion stops`, counts: { observed: keys.length, supported: supported.length } };
  const markets = [...supported].sort((a, b) => cmp(a.base, b.base) || cmp(a.pairKey, b.pairKey));
  excludedRows.sort((a, b) => cmp(a.pairKey, b.pairKey)); unresolved.sort((a, b) => cmp(a.pairKey, b.pairKey) || cmp(a.reason, b.reason)); duplicates.sort((a, b) => cmp(a.pairKey, b.pairKey));
  const catalog = {
    venue: KRAKEN_CATALOG_VENUE, quote: KRAKEN_CATALOG_QUOTE, policyVersion: KRAKEN_CATALOG_POLICY_VERSION, observedTs,
    contentId: catalogContentId({ venue: KRAKEN_CATALOG_VENUE, quote: KRAKEN_CATALOG_QUOTE, policyVersion: KRAKEN_CATALOG_POLICY_VERSION, markets }),
    counts: { observed: keys.length, supported: markets.length, excluded: excludedRows.length, unresolved: unresolved.length },
    markets, excluded: excludedRows, unresolved, duplicates,
    aliasesApplied: { ...KRAKEN_BASE_ALIASES }, excludeBases: [...excluded].sort(),
    // the supported pair keys in RESPONSE order: the wide eye's sweep map keeps its historical first-key behaviour from this
    responseOrder,
    source: 'kraken REST AssetPairs',
  };
  return { ok: true, catalog: deepFreeze(catalog) };
}

// Adoption law between a previously ACCEPTED catalog and a new candidate: a large drop in
// supported markets is a suspected incomplete response, never an authoritative mass
// delisting; an acquisition clock behind the accepted one is refused.
export function acceptCatalogCandidate(previous, candidate, { maxDropFraction = CATALOG_MAX_DROP_FRACTION_DEFAULT } = {}) {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'RESPONSE_MALFORMED' };
  if (!previous) return { ok: true, change: 'INITIAL' };
  if (candidate.observedTs < previous.observedTs) return { ok: false, reason: 'OBSERVED_CLOCK_REGRESSION', detail: `candidate observed ${candidate.observedTs} before the accepted catalog ${previous.observedTs}` };
  const floor = Math.ceil(previous.counts.supported * (1 - maxDropFraction));
  if (candidate.counts.supported < floor) return { ok: false, reason: 'SUSPECTED_INCOMPLETE', detail: `${candidate.counts.supported} supported markets versus ${previous.counts.supported} accepted (floor ${floor}) — retaining previous truth` };
  return { ok: true, change: candidate.contentId === previous.contentId ? 'UNCHANGED' : 'CHANGED' };
}

export const catalogBases = (catalog) => (catalog && Array.isArray(catalog.markets) ? [...new Set(catalog.markets.map((m) => m.base))].sort() : []);
