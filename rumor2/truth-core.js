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
export const RUMOR2_VERSION = 'RUMOR-2A2';
// Event-root seal (closeout #4): checkpoint v4 — the authoritative event
// journal moved into the durable core (PostgreSQL), source events carry
// their COMPLETE identity-bearing facts, and the checkpoint names how far
// settled truth extends in that journal (lastSettledEventSeq). This is a
// materially different authority model, so it gets a new version rather
// than forcing v3 to mean two things. RUMOR-2 has never been published, so
// there is no production truth to migrate: an old/incompatible checkpoint
// (v3 included) fails closed (WITHHELD) pending explicit operator
// migration, never silently reinterpreted.
export const RUMOR2_CHECKPOINT_VERSION = 4;
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

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isTs = (v) => Number.isSafeInteger(v) && v > 0;

export const CLAIM_CAPABLE_PROVIDER_KINDS = Object.freeze(['EXCHANGE_OFFICIAL', 'REGULATOR']);

// ---- prepared-transaction trust (A2) ---------------------------------------
// The only truth-bearing event types a transaction may owe. Arbitrary
// uppercase strings that merely look like event names fail closed.
export const RUMOR2_TXN_EVENT_TYPES = Object.freeze([
  'RUMOR2_SOURCE_OBSERVED',
  'RUMOR2_CLAIM_OBSERVED',
  'RUMOR2_PACKET',
  'RUMOR2_WITHHELD',
]);

export const exactKeys = (obj, allowed, label) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${label}: undeclared field '${k}'`;
  for (const k of allowed) if (!(k in obj)) return `${label}: missing field '${k}'`;
  return null;
};
export const R2S_RE = /^r2s-[0-9a-f]{40}$/;
export const R2C_RE = /^r2c-[0-9a-f]{40}$/;
export const isBounded = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// A2R exact-key schemas for the four truth-bearing event types — the ONLY
// records a transaction may owe, each a closed shape: every required field
// present, no undeclared field, ever. RUMOR2_WITHHELD has two legitimate
// variants (coin-resolution vs proposition/packet withholding), each its
// own exact schema — never a permissive union.
export const EVENT_KEYS = Object.freeze({
  RUMOR2_SOURCE_OBSERVED: ['type', 'ts', 'sourceEventId', 'provider', 'title', 'summary', 'link', 'guid', 'publishedTs', 'retrievedTs', 'knownAtTs'],
  RUMOR2_CLAIM_OBSERVED: ['type', 'ts', 'sourceEventId', 'provider', 'symbol', 'propositionId', 'claimKey', 'claimType', 'status', 'title'],
  RUMOR2_PACKET: ['type', 'ts', 'sourceEventId', 'provider', 'symbol', 'propositionId', 'claimType', 'packetId', 'packet'],
  RUMOR2_WITHHELD_COIN: ['type', 'ts', 'sourceEventId', 'provider', 'reason', 'claimType', 'title'],
  RUMOR2_WITHHELD_PROP: ['type', 'ts', 'sourceEventId', 'provider', 'symbol', 'propositionId', 'claimType', 'reasons'],
  // event-root seal (closeout #4): the non-truth-bearing stream events are
  // part of the CLOSED durable event world too — validated shapes, never
  // silently skippable blobs
  RUMOR2_WITHHELD_CLOCK: ['type', 'ts', 'provider', 'reason', 'title'],
  RUMOR2_PROVIDER_FAILURE: ['type', 'ts', 'provider', 'reason', 'httpStatus', 'consecutiveFailures'],
  RUMOR2_STARTED: ['type', 'ts', 'lifecycle', 'durability', 'checkpointRevision'],
});
export const COIN_SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
export const NODE_STATUSES = Object.freeze(['UNVERIFIED', 'CORROBORATED', 'PRIMARY_CONFIRMED', 'CONTRADICTED', 'RETRACTED']);

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
    lastSettledEventSeq: 0, // settled truth extends this far in the authoritative event journal
  };
}

// bounded FIFO advance for a provider's recent-seen identity set
export function rememberSeen(seenIds, id) {
  if (seenIds.includes(id)) return seenIds;
  const next = [...seenIds, id];
  return next.length > MAX_SEEN_IDS ? next.slice(next.length - MAX_SEEN_IDS) : next;
}

export const OBS_PER_CLAIM = 6; // bounded packet-building observations kept per claim
