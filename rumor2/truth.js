// RUMOR-2A — the pure truth core of the multi-source rumor intelligence
// layer. No network, no filesystem, no configuration reads: exact identity,
// deterministic classification, strict validation over explicit inputs.
//
// WIDE EARS. NARROW TEETH. RUMOR-2 observes; it does not trade. A claim is
// not a fact; an echo is not corroboration; one source is one source; and
// nothing here may ever grant attention, stalking, eligibility, or
// execution authority. Existing StockTwits RUMINT is NOT this module and
// is not touched by it.
import { createHash } from 'node:crypto';

export const RUMOR2_VERSION = 'RUMOR-2A1';
// A1: checkpoint v2 — graph keyed by proposition identities and a
// write-ahead item transaction slot. RUMOR-2 has never been published, so
// there is no production v1 truth to migrate: an old/incompatible
// checkpoint fails closed (WITHHELD), never silently reinterpreted.
export const RUMOR2_CHECKPOINT_VERSION = 2;
export const MAX_TXN_EVENTS = 32; // 1 source + <=5 coins x (claim+packet/withheld) fits far below
// bounded source reconciliation: recovery proves an owed event present by
// scanning ONLY the trailing bytes of the event stream — a transaction is
// always settled within a tick of its creation, so its events live at the
// tail; an unprovable event is re-appended and canonical Memory's semantic
// dedupe makes the exact replay harmless.
export const RECONCILE_TAIL_BYTES = 1_048_576;

// ---- hard bounds -----------------------------------------------------------
export const MAX_FEED_BYTES = 1_048_576; // 1 MiB response body cap
export const MAX_FEED_ITEMS = 100; // items parsed per response
export const MAX_BOOTSTRAP_ITEMS = 50; // first observation of a provider
export const MAX_TITLE_CHARS = 300;
export const MAX_SUMMARY_CHARS = 4_000; // provider summary before contract excerpt
export const MAX_SEEN_IDS = 512; // recent item identities per provider
export const MAX_ACTIVE_CLAIMS = 64; // bounded claim graph
export const MAX_SOURCES_PER_CLAIM = 16;
export const MAX_ERROR_CHARS = 200;
export const HTTP_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 2; // same-provider https redirects only
export const FRESHNESS_BOUND_MS = 24 * 3_600_000; // beyond this, coverage is STALE
// producer sub-bounds — deliberately far below the contract's outer caps
export const PACKET_MAX_CLAIMS = 6;
export const PACKET_MAX_SOURCES = 12;
export const PACKET_MAX_EVIDENCE = 24;
export const PACKET_MAX_CLAIM_LINKS = 32;
export const PACKET_MAX_CONTRADICTIONS = 8;
export const PACKET_MAX_MISSING = 8;
export const PACKET_MAX_RAW_CHARS = 3_000;

export const boundedError = (msg) => String(msg ?? 'unknown').slice(0, MAX_ERROR_CHARS);

// bounded exponential cooldown ladder for transient provider failures
export const COOLDOWN_LADDER_MS = Object.freeze([60_000, 120_000, 240_000, 480_000, 900_000]);
export const MAX_COOLDOWN_MS = 1_800_000; // 30 minutes
export const cooldownMs = (consecutiveFailures) =>
  Math.min(COOLDOWN_LADDER_MS[Math.min(Math.max(consecutiveFailures, 1) - 1, COOLDOWN_LADDER_MS.length - 1)], MAX_COOLDOWN_MS);
// Retry-After honored only within honest bounds — never a week of silence
export const RETRY_AFTER_MIN_MS = 60_000;
export const RETRY_AFTER_MAX_MS = 3_600_000;
export const boundedRetryAfterMs = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return RETRY_AFTER_MIN_MS;
  return Math.min(Math.max(n * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
};

// ---- canonical identity ----------------------------------------------------
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`))
    .filter(Boolean)
    .join(',')}}`;
};
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
export const contentHash = (text) => sha1(String(text));

// Source observation identity — IMMUTABLE provider facts only. The same
// official item fetched tomorrow is the SAME source observation; a
// retrieval timestamp is when WE looked, never who/what/when it was said,
// so it can never be part of identity.
export function sourceObservationIdentity({ provider, guid, link, publishedTs, title, summary }) {
  const basis = {
    provider,
    guid: guid ?? null,
    link: link ?? null,
    publishedTs: publishedTs ?? null,
    contentHash: contentHash(`${title ?? ''}\n${summary ?? ''}`),
  };
  return `r2s-${sha1(canonicalJson(basis))}`;
}

// ---- proposition identity (A1) ---------------------------------------------
// A CLAIM TYPE IS A CATEGORY, NOT A PROPOSITION. Two unrelated enforcement
// actions about the same coin are two different claims. A RUMOR-2A
// proposition is anchored to the specific official assertion that
// originated it: (claimType, canonicalCoin, origin sourceObservationId).
// The same official item — repeated retrieval, crash replay, restart —
// always yields the SAME proposition; distinct official items are never
// merged merely for sharing a category and a coin. RUMOR-2B may attach a
// later source to an EXISTING proposition only through explicit proven
// relation targeting, never by type+coin search.
export function propositionIdentity({ claimType, canonicalCoin, originSourceObservationId }) {
  return `r2c-${sha1(canonicalJson({ claimType, canonicalCoin, originSourceObservationId }))}`;
}

// ---- claim vocabulary (closed for 2A) --------------------------------------
export const RUMOR2_CLAIM_TYPES = Object.freeze([
  'EXCHANGE_LISTING',
  'EXCHANGE_ASSET_SUPPORT',
  'REGULATORY_ACTION',
  'REGULATORY_ENFORCEMENT',
  'OTHER_OFFICIAL_CRYPTO_CLAIM',
]);

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

// ---- checkpoint validation -------------------------------------------------
// Strict, fail-closed: a corrupt durable checkpoint is WITHHELD, never
// silently replaced by a fresh start over rewritten history.
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTs = (v) => Number.isSafeInteger(v) && v > 0;

export function validateRumor2Checkpoint(cp, { providerIds }) {
  if (!isPlainObject(cp)) return 'checkpoint: not an object';
  if (cp.checkpointVersion !== RUMOR2_CHECKPOINT_VERSION) return `checkpoint: unsupported version ${cp.checkpointVersion}`;
  if (!Number.isSafeInteger(cp.revision) || cp.revision < 0) return 'checkpoint: invalid revision';
  if (!isTs(cp.savedTs)) return 'checkpoint: invalid savedTs';
  if (!isPlainObject(cp.providers)) return 'checkpoint: providers missing';
  for (const [id, p] of Object.entries(cp.providers)) {
    if (!providerIds.includes(id)) return `checkpoint: unknown provider ${id}`;
    if (!isPlainObject(p)) return `checkpoint: provider ${id} not an object`;
    if (!Array.isArray(p.seenIds) || p.seenIds.length > MAX_SEEN_IDS) return `checkpoint: provider ${id} seenIds invalid`;
    for (const s of p.seenIds) if (typeof s !== 'string' || !/^r2s-[0-9a-f]{40}$/.test(s)) return `checkpoint: provider ${id} bad seen id`;
    if (new Set(p.seenIds).size !== p.seenIds.length) return `checkpoint: provider ${id} duplicate seen ids`;
    if (p.etag !== null && typeof p.etag !== 'string') return `checkpoint: provider ${id} etag invalid`;
    if (p.lastModified !== null && typeof p.lastModified !== 'string') return `checkpoint: provider ${id} lastModified invalid`;
    if (p.backoffUntil !== null && !isTs(p.backoffUntil)) return `checkpoint: provider ${id} backoffUntil invalid`;
    if (!Number.isSafeInteger(p.consecutiveFailures) || p.consecutiveFailures < 0)
      return `checkpoint: provider ${id} consecutiveFailures invalid`;
    if (p.lastSuccessTs !== null && !isTs(p.lastSuccessTs)) return `checkpoint: provider ${id} lastSuccessTs invalid`;
    if (p.bootstrapped !== true && p.bootstrapped !== false) return `checkpoint: provider ${id} bootstrapped invalid`;
  }
  if (!isPlainObject(cp.counters)) return 'checkpoint: counters missing';
  for (const k of ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld', 'duplicates'])
    if (!Number.isSafeInteger(cp.counters[k]) || cp.counters[k] < 0) return `checkpoint: counter ${k} invalid`;
  if (!isPlainObject(cp.graph) || !isPlainObject(cp.graph.claims)) return 'checkpoint: graph missing';
  if (Object.keys(cp.graph.claims).length > MAX_ACTIVE_CLAIMS) return 'checkpoint: graph exceeds active-claim bound';
  // A1: graph nodes are keyed by proposition identity, never by category
  for (const k of Object.keys(cp.graph.claims)) if (!/^r2c-[0-9a-f]{40}$/.test(k)) return `checkpoint: graph key ${k.slice(0, 24)} is not a proposition identity`;
  // A1: the write-ahead item transaction slot — explicitly null, or a
  // bounded prepared transaction the collector must settle before polling
  if (cp.txn === undefined) return 'checkpoint: txn slot missing (must be null or a prepared transaction)';
  if (cp.txn !== null) {
    const t = cp.txn;
    if (!isPlainObject(t)) return 'checkpoint: txn invalid';
    if (t.txnVersion !== 1) return 'checkpoint: txn unsupported version';
    if (!providerIds.includes(t.provider)) return 'checkpoint: txn unknown provider';
    if (typeof t.sourceObservationId !== 'string' || !/^r2s-[0-9a-f]{40}$/.test(t.sourceObservationId)) return 'checkpoint: txn bad source id';
    if (!Array.isArray(t.events) || t.events.length === 0 || t.events.length > MAX_TXN_EVENTS) return 'checkpoint: txn events invalid';
    for (const e of t.events)
      if (!isPlainObject(e) || typeof e.type !== 'string' || typeof e.sourceEventId !== 'string') return 'checkpoint: txn event malformed';
    if (!isPlainObject(t.candidate)) return 'checkpoint: txn candidate missing';
    if (!Array.isArray(t.candidate.seenIds) || t.candidate.seenIds.length > MAX_SEEN_IDS) return 'checkpoint: txn candidate seenIds invalid';
    if (!isPlainObject(t.candidate.graphClaims)) return 'checkpoint: txn candidate graphClaims invalid';
    if (!isPlainObject(t.candidate.counterDeltas)) return 'checkpoint: txn candidate counterDeltas invalid';
  }
  return null;
}

export function emptyProviderState() {
  return {
    seenIds: [],
    etag: null,
    lastModified: null,
    backoffUntil: null,
    consecutiveFailures: 0,
    lastSuccessTs: null,
    bootstrapped: false,
  };
}

export function emptyCheckpoint(providerIds, nowMs) {
  const providers = {};
  for (const id of providerIds) providers[id] = emptyProviderState();
  return {
    checkpointVersion: RUMOR2_CHECKPOINT_VERSION,
    revision: 0,
    savedTs: nowMs,
    providers,
    counters: { sourcesObserved: 0, claimsObserved: 0, packetsProduced: 0, packetsWithheld: 0, duplicates: 0 },
    graph: { claims: {} },
    txn: null, // write-ahead item transaction slot — one at a time, settled before new polling
  };
}

// bounded FIFO advance for a provider's recent-seen identity set
export function rememberSeen(seenIds, id) {
  if (seenIds.includes(id)) return seenIds;
  const next = [...seenIds, id];
  return next.length > MAX_SEEN_IDS ? next.slice(next.length - MAX_SEEN_IDS) : next;
}
