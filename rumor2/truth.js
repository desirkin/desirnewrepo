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
import { validateEvidencePacket } from '../evidence/contract.js';

export const RUMOR2_VERSION = 'RUMOR-2A2';
// A2: checkpoint v3 — the prepared-transaction slot is a CLOSED semantic
// schema, proven (packets re-validated under serpent-evidence-1, every
// event bound to its source item and proposition, counters exact) before
// restart may trust and replay it. RUMOR-2 has never been published, so
// there is no production v1/v2 truth to migrate: an old/incompatible
// checkpoint fails closed (WITHHELD), never silently reinterpreted.
export const RUMOR2_CHECKPOINT_VERSION = 3;
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
  // A2: the write-ahead item transaction slot — explicitly null, or a
  // prepared transaction that passes the CLOSED semantic schema below.
  // A persisted transaction is TRUSTED and replayed verbatim on restart,
  // so nothing may ride in it that has not been proven.
  if (cp.txn === undefined) return 'checkpoint: txn slot missing (must be null or a prepared transaction)';
  if (cp.txn !== null) {
    const txnErr = validateRumor2Txn(cp.txn, { providerIds, graph: cp.graph });
    if (txnErr) return txnErr;
  }
  return null;
}

// ---- prepared-transaction trust (A2) ---------------------------------------
// The only truth-bearing event types a transaction may owe. Arbitrary
// uppercase strings that merely look like event names fail closed.
export const RUMOR2_TXN_EVENT_TYPES = Object.freeze([
  'RUMOR2_SOURCE_OBSERVED',
  'RUMOR2_CLAIM_OBSERVED',
  'RUMOR2_PACKET',
  'RUMOR2_WITHHELD',
]);

const exactKeys = (obj, allowed, label) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${label}: undeclared field '${k}'`;
  for (const k of allowed) if (!(k in obj)) return `${label}: missing field '${k}'`;
  return null;
};
const R2S_RE = /^r2s-[0-9a-f]{40}$/;
const R2C_RE = /^r2c-[0-9a-f]{40}$/;
const isBounded = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// Closed semantic validation of one prepared item transaction. Restart may
// replay a transaction ONLY when every field, clock, identity binding,
// packet, and counter delta here proves out — a malformed packet is never
// appended merely because its outer record says RUMOR2_PACKET.
export function validateRumor2Txn(t, { providerIds, graph }) {
  if (!isPlainObject(t)) return 'txn: not an object';
  const keyErr = exactKeys(t, ['txnVersion', 'provider', 'sourceObservationId', 'clocks', 'events', 'candidate', 'preparedTs'], 'txn');
  if (keyErr) return keyErr;
  if (t.txnVersion !== 1) return 'txn: unsupported version';
  if (!providerIds.includes(t.provider)) return 'txn: unknown provider';
  if (typeof t.sourceObservationId !== 'string' || !R2S_RE.test(t.sourceObservationId)) return 'txn: bad source observation id';
  // exact clocks with causal coherence — published <= retrieved <= knownAt
  if (!isPlainObject(t.clocks)) return 'txn: clocks missing';
  const cErr = exactKeys(t.clocks, ['publishedTs', 'retrievedTs', 'knownAtTs'], 'txn.clocks');
  if (cErr) return cErr;
  const { publishedTs, retrievedTs, knownAtTs } = t.clocks;
  if (publishedTs !== null && !isTs(publishedTs)) return 'txn: publishedTs invalid';
  if (!isTs(retrievedTs) || !isTs(knownAtTs)) return 'txn: retrieval/knowledge clock invalid';
  if (publishedTs !== null && publishedTs > retrievedTs) return 'txn: publishedTs after retrievedTs — causally impossible';
  if (retrievedTs > knownAtTs) return 'txn: retrievedTs after knownAtTs — causally impossible';
  if (t.preparedTs !== knownAtTs) return 'txn: preparedTs disagrees with the prepared knowledge clock';
  const expectedTs = new Date(knownAtTs).toISOString();

  if (!Array.isArray(t.events) || t.events.length === 0 || t.events.length > MAX_TXN_EVENTS) return 'txn: events invalid';
  let sourceEvents = 0;
  let claimEvents = 0;
  let packetEvents = 0;
  let withheldEvents = 0;
  for (const e of t.events) {
    if (!isPlainObject(e)) return 'txn: event not an object';
    if (!RUMOR2_TXN_EVENT_TYPES.includes(e.type)) return `txn: event type ${String(e.type).slice(0, 40)} not allowed`;
    if (e.provider !== t.provider) return 'txn: event provider disagrees with transaction provider';
    if (e.ts !== expectedTs) return 'txn: event clock disagrees with the prepared knowledge clock';
    if (typeof e.sourceEventId !== 'string' || e.sourceEventId.length === 0) return 'txn: event missing sourceEventId';
    if (e.type === 'RUMOR2_SOURCE_OBSERVED') {
      sourceEvents += 1;
      if (e.sourceEventId !== t.sourceObservationId) return 'txn: source event identity disagrees with transaction source';
      if (e.publishedTs !== publishedTs || e.retrievedTs !== retrievedTs || e.knownAtTs !== knownAtTs)
        return 'txn: source event clocks disagree with immutable transaction clocks';
    } else if (e.type === 'RUMOR2_CLAIM_OBSERVED') {
      claimEvents += 1;
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: claim event lacks a valid proposition identity';
      if (e.claimKey !== e.propositionId) return 'txn: claim event claimKey/propositionId disagree';
      if (e.sourceEventId !== `${t.sourceObservationId}|claim|${e.propositionId}`)
        return 'txn: claim event identity not bound to source and proposition';
      if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: claim event carries unknown claimType';
    } else if (e.type === 'RUMOR2_PACKET') {
      packetEvents += 1;
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: packet event lacks a valid proposition identity';
      if (!isPlainObject(e.packet)) return 'txn: packet event lacks a packet';
      // THE trust gate: the accepted evidence contract validator runs over
      // every prepared packet — the contract itself recomputes packetId
      // against semantic content, so a forged identity dies here too.
      const check = validateEvidencePacket(e.packet);
      if (!check.valid) return boundedError(`txn: prepared packet fails serpent-evidence-1 (${check.reasons[0] ?? 'invalid'})`);
      if (e.packetId !== e.packet.packetId) return 'txn: packet event packetId disagrees with the packet itself';
      if (e.sourceEventId !== `${t.sourceObservationId}|packet|${e.packetId}`)
        return 'txn: packet event identity not bound to source and packet';
    } else {
      withheldEvents += 1;
      const hasReason = isBounded(e.reason, MAX_ERROR_CHARS);
      const hasReasons = Array.isArray(e.reasons) && e.reasons.length > 0 && e.reasons.length <= 8 && e.reasons.every((x) => isBounded(x, MAX_ERROR_CHARS));
      if (!hasReason && !hasReasons) return 'txn: withheld event lacks a bounded reason';
      if (!e.sourceEventId.startsWith(`${t.sourceObservationId}|withheld|`)) return 'txn: withheld event not bound to the transaction source';
      const suffix = e.sourceEventId.slice(`${t.sourceObservationId}|withheld|`.length);
      if (e.propositionId !== undefined) {
        if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: withheld event proposition invalid';
        if (suffix !== e.propositionId) return 'txn: withheld event identity/proposition disagree';
      } else if (suffix !== 'coin-resolution') return 'txn: withheld event has an unrecognized binding';
    }
  }
  if (sourceEvents !== 1) return 'txn: exactly one source-observed event is required';

  // candidate — closed schema, consistent with settling THIS source item
  if (!isPlainObject(t.candidate)) return 'txn: candidate missing';
  const candErr = exactKeys(t.candidate, ['seenIds', 'graphClaims', 'graphRemovals', 'counterDeltas', 'lastNewItemTs'], 'txn.candidate');
  if (candErr) return candErr;
  const cand = t.candidate;
  if (!Array.isArray(cand.seenIds) || cand.seenIds.length === 0 || cand.seenIds.length > MAX_SEEN_IDS) return 'txn: candidate seenIds invalid';
  for (const s of cand.seenIds) if (typeof s !== 'string' || !R2S_RE.test(s)) return 'txn: candidate seenIds carry a bad id';
  if (new Set(cand.seenIds).size !== cand.seenIds.length) return 'txn: candidate seenIds duplicated';
  if (!cand.seenIds.includes(t.sourceObservationId)) return 'txn: candidate does not settle this source item';
  if (!isPlainObject(cand.graphClaims)) return 'txn: candidate graphClaims invalid';
  for (const [k, node] of Object.entries(cand.graphClaims)) {
    if (!R2C_RE.test(k)) return 'txn: candidate graph key is not a proposition identity';
    if (!isPlainObject(node) || node.propositionId !== k || node.claimKey !== k) return 'txn: candidate node disagrees with its proposition key';
  }
  if (!Array.isArray(cand.graphRemovals) || cand.graphRemovals.length > MAX_ACTIVE_CLAIMS) return 'txn: candidate graphRemovals invalid';
  for (const k of cand.graphRemovals) if (typeof k !== 'string' || !R2C_RE.test(k)) return 'txn: candidate removal is not a proposition identity';
  // adoption may never push the graph beyond its accepted bound
  if (isPlainObject(graph) && isPlainObject(graph.claims)) {
    const after = new Set(Object.keys(graph.claims));
    for (const k of cand.graphRemovals) after.delete(k);
    for (const k of Object.keys(cand.graphClaims)) after.add(k);
    if (after.size > MAX_ACTIVE_CLAIMS) return 'txn: candidate adoption exceeds the active-claim bound';
  }
  // counters — EXACT keys, nonnegative safe integers, corresponding
  // one-for-one to the actual prepared bundle: never a decrement, never a
  // manufactured counter, never an increment for an unowed event
  const dErr = exactKeys(cand.counterDeltas, ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld'], 'txn.counterDeltas');
  if (dErr) return dErr;
  for (const [k, v] of Object.entries(cand.counterDeltas))
    if (!Number.isSafeInteger(v) || v < 0) return `txn: counter delta ${k} must be a nonnegative safe integer`;
  if (cand.counterDeltas.sourcesObserved !== sourceEvents) return 'txn: sourcesObserved delta disagrees with the prepared bundle';
  if (cand.counterDeltas.claimsObserved !== claimEvents) return 'txn: claimsObserved delta disagrees with the prepared bundle';
  if (cand.counterDeltas.packetsProduced !== packetEvents) return 'txn: packetsProduced delta disagrees with the prepared bundle';
  if (cand.counterDeltas.packetsWithheld !== withheldEvents) return 'txn: packetsWithheld delta disagrees with the prepared bundle';
  if (cand.lastNewItemTs !== knownAtTs) return 'txn: candidate lastNewItemTs disagrees with the knowledge clock';
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
