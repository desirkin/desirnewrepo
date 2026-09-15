import { MAX_TITLE_CHARS, MAX_SUMMARY_CHARS } from './truth-core.js';

// ---- coin resolution -------------------------------------------------------
// NEVER fuzzy. A ticker binds only as an exact standalone UPPERCASE token;
// a name binds only through the approved unique alias table. Ambiguity is
// recorded and withheld, never guessed. The registry is built from the
// canonical universe Serpent already trades against.
export const APPROVED_COIN_ALIASES = Object.freeze({
  BITCOIN: 'BTC',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
  DOGECOIN: 'DOGE',
  // XRP has no approved full-name alias: "Ripple" names a company, not
  // unambiguously the asset — only the explicit ticker binds.
});
// Tickers that collide with ordinary English or otherwise cannot be safely
// matched even uppercase-standalone would go here; none of the current
// canonical five qualify, but the refusal path is real and tested.
export const AMBIGUOUS_TICKERS = Object.freeze([]);

export function buildCoinRegistry(universe) {
  const tickers = new Set();
  for (const c of Array.isArray(universe) ? universe : []) {
    if (typeof c === 'string' && /^[A-Z0-9]{2,15}$/.test(c) && !AMBIGUOUS_TICKERS.includes(c)) tickers.add(c);
  }
  const aliases = new Map();
  for (const [alias, coin] of Object.entries(APPROVED_COIN_ALIASES)) if (tickers.has(coin)) aliases.set(alias, coin);
  return { tickers, aliases };
}

// Resolve every UNAMBIGUOUS canonical coin explicitly named in bounded
// official text. Tokens are split on non-alphanumerics; a ticker must
// appear as that exact uppercase token (BTC, not btc, not SUBTC); an alias
// matches case-insensitively as a standalone word. Returns a sorted unique
// list — possibly empty, which is an honest answer.
export function resolveCoins(text, registry) {
  const coins = new Set();
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = text.slice(0, MAX_TITLE_CHARS + MAX_SUMMARY_CHARS).split(/[^A-Za-z0-9]+/);
  for (const raw of tokens) {
    if (!raw) continue;
    if (registry.tickers.has(raw)) {
      coins.add(raw); // exact uppercase standalone ticker — never a substring
      continue;
    }
    const alias = registry.aliases.get(raw.toUpperCase());
    if (alias) coins.add(alias);
  }
  return [...coins].sort();
}

// ---- deterministic claim classification ------------------------------------
// Closed pattern tables only. If no pattern establishes a type, NO typed
// claim exists — the source observation is still stored, classification is
// honestly withheld. Nothing here infers sentiment, likelihood, or intent.
const KRAKEN_LISTING_RE = /\b(trading (?:for .{1,80} )?(?:starts|begins|is (?:now )?live)|now available for trading|lists? .{0,60}\b(?:on kraken)|available on kraken|launches? on kraken)\b/i;
const KRAKEN_SUPPORT_RE = /\b(adds? support for|support for .{1,60}\b(?:is|now) (?:live|enabled)|deposits? and withdrawals? .{0,40}\b(?:enabled|live|open))\b/i;
const REG_ENFORCEMENT_RE = /\b(charges?|charged|settle[sd]?|enforcement action|files? (?:a )?(?:complaint|charges|action)|fraud action|obtains? .{0,30}judgment)\b/i;
const REG_ACTION_RE = /\b(approv(?:es|ed|al)|final rule|order granting|adopts? (?:a )?rule|grants? .{0,30}(?:relief|registration)|proposes? (?:a )?rule)\b/i;

export function classifyOfficialItem({ providerKind, title, summary }) {
  const text = `${title ?? ''}\n${summary ?? ''}`.slice(0, MAX_TITLE_CHARS + MAX_SUMMARY_CHARS);
  if (providerKind === 'EXCHANGE_OFFICIAL') {
    if (KRAKEN_LISTING_RE.test(text)) return 'EXCHANGE_LISTING';
    if (KRAKEN_SUPPORT_RE.test(text)) return 'EXCHANGE_ASSET_SUPPORT';
    return null; // no deterministic structure — no typed claim, no guessing
  }
  if (providerKind === 'REGULATOR') {
    if (REG_ENFORCEMENT_RE.test(text)) return 'REGULATORY_ENFORCEMENT';
    if (REG_ACTION_RE.test(text)) return 'REGULATORY_ACTION';
    return null;
  }
  return null;
}

// ---- bounded HTML/entity stripping for feed summaries ----------------------
// Deterministic, bounded, non-interpreting: tags become spaces, the five
// XML entities and numeric references decode, everything else stays the
// literal characters a source emitted. Output is DATA, never instruction.
export function stripMarkup(text, max = MAX_SUMMARY_CHARS) {
  if (typeof text !== 'string') return '';
  let t = text.slice(0, max * 4); // bounded work even before stripping
  t = t.replace(/<[^>]{0,500}>/g, ' ');
  t = t
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const code = Number(n);
      return code > 31 && code < 1_114_112 ? String.fromCodePoint(code) : ' ';
    });
  return t.replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---- point-in-time timestamps ----------------------------------------------
// publishedTs = the publisher's stated clock; retrievedTs = when Serpent
// fetched; knownAtTs = when Serpent actually knew. knownAtTs is NEVER
// backdated to publication — a bootstrap that reads last month's archive
// learned about it tonight, period.
export function itemClocks({ publishedTs, nowMs }) {
  const pub = Number.isSafeInteger(publishedTs) && publishedTs > 0 ? publishedTs : null;
  const retrieved = nowMs;
  if (pub !== null && pub > retrieved) return { error: 'future publication timestamp rejected' };
  return { publishedTs: pub, retrievedTs: retrieved, knownAtTs: retrieved };
}

// ---- provider coverage -----------------------------------------------------
export const PROVIDER_COVERAGE_STATES = Object.freeze([
  'OBSERVED',
  'NOT_QUERIED',
  'UNAVAILABLE',
  'FAILED',
  'STALE',
  'NOT_SUPPORTED',
]);
