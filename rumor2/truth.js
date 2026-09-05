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
import { providerById } from './registry.js';

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

// The CLOSED provider-state schema (B1 closeout): exactly these base
// fields, no undeclared extras; ONLY the OFAC snapshot/diff ear may carry
// the additional validated `snapshot` anchor. And the provider-key SET is
// itself closed: either the complete current registry, or EXACTLY the
// pre-B1 legacy trio (the one historically legitimate elder shape — new
// ears are then born fresh on restore). Any other subset lost a provider's
// durable truth and fails closed.
const PROVIDER_STATE_KEYS = Object.freeze(['seenIds', 'etag', 'lastModified', 'backoffUntil', 'consecutiveFailures', 'lastSuccessTs', 'bootstrapped']);
const SNAPSHOT_PROVIDER_IDS = Object.freeze(['OFAC_OFFICIAL']);
export const LEGACY_PRE_B1_PROVIDERS = Object.freeze(['CFTC_OFFICIAL', 'KRAKEN_OFFICIAL', 'SEC_OFFICIAL']);

export function validateRumor2Checkpoint(cp, { providerIds }) {
  if (!isPlainObject(cp)) return 'checkpoint: not an object';
  if (cp.checkpointVersion !== RUMOR2_CHECKPOINT_VERSION) return `checkpoint: unsupported version ${cp.checkpointVersion}`;
  if (!Number.isSafeInteger(cp.revision) || cp.revision < 0) return 'checkpoint: invalid revision';
  if (!isTs(cp.savedTs)) return 'checkpoint: invalid savedTs';
  if (!isPlainObject(cp.providers)) return 'checkpoint: providers missing';
  for (const [id, p] of Object.entries(cp.providers)) {
    if (!providerIds.includes(id)) return `checkpoint: unknown provider ${id}`;
    if (!isPlainObject(p)) return `checkpoint: provider ${id} not an object`;
    const allowedKeys = SNAPSHOT_PROVIDER_IDS.includes(id) ? [...PROVIDER_STATE_KEYS, 'snapshot'] : PROVIDER_STATE_KEYS;
    for (const k of Object.keys(p)) if (!allowedKeys.includes(k)) return `checkpoint: provider ${id} carries undeclared field '${k}'`;
    for (const k of PROVIDER_STATE_KEYS) if (!(k in p)) return `checkpoint: provider ${id} missing field '${k}'`;
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
    // RUMOR-2B1: the ONLY additional provider-state field — an explicitly
    // validated dataset-snapshot anchor, permitted on the OFAC snapshot/
    // diff ear ALONE (the key-closure above already refuses it anywhere
    // else). It is a bounded truth anchor, never a blob: the bulky snapshot
    // detail lives outside the checkpoint and must re-derive this exact
    // hash before it may serve as a diff basis; seq is the monotonic causal
    // clock of accepted snapshots that keeps recurrent dataset states
    // distinct temporal transitions.
    if (p.snapshot !== undefined && p.snapshot !== null) {
      const s = p.snapshot;
      if (!isPlainObject(s)) return `checkpoint: provider ${id} snapshot invalid`;
      const keys = Object.keys(s).sort();
      if (keys.join(',') !== 'acceptedTs,hash,recordCount,seq') return `checkpoint: provider ${id} snapshot carries undeclared or missing fields`;
      if (typeof s.hash !== 'string' || !/^[0-9a-f]{40}$/.test(s.hash)) return `checkpoint: provider ${id} snapshot hash invalid`;
      if (!isTs(s.acceptedTs)) return `checkpoint: provider ${id} snapshot acceptedTs invalid`;
      if (!Number.isSafeInteger(s.recordCount) || s.recordCount < 0) return `checkpoint: provider ${id} snapshot recordCount invalid`;
      if (!Number.isSafeInteger(s.seq) || s.seq < 0) return `checkpoint: provider ${id} snapshot seq invalid`;
    }
  }
  // CLOSED provider-key SET: the complete current registry, or exactly the
  // pre-B1 legacy trio. A checkpoint that lost one provider's durable
  // truth — or gained a partial B1 shape that never legitimately existed —
  // is corrupt and fails closed rather than being silently repaired over.
  const idSet = Object.keys(cp.providers).sort().join(',');
  const fullSet = [...providerIds].sort().join(',');
  const legacySet = [...LEGACY_PRE_B1_PROVIDERS].sort().join(',');
  if (idSet !== fullSet && idSet !== legacySet)
    return 'checkpoint: provider set is neither the complete current registry nor the exact pre-B1 legacy set';
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
    const txnErr = validateRumor2Txn(cp.txn, {
      providerIds,
      graph: cp.graph,
      priorSeenIds: cp.providers?.[cp.txn?.provider]?.seenIds ?? [],
    });
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

// A2R exact-key schemas for the four truth-bearing event types — the ONLY
// records a transaction may owe, each a closed shape: every required field
// present, no undeclared field, ever. RUMOR2_WITHHELD has two legitimate
// variants (coin-resolution vs proposition/packet withholding), each its
// own exact schema — never a permissive union.
const EVENT_KEYS = Object.freeze({
  RUMOR2_SOURCE_OBSERVED: ['type', 'ts', 'sourceEventId', 'provider', 'title', 'summary', 'link', 'guid', 'publishedTs', 'retrievedTs', 'knownAtTs'],
  RUMOR2_CLAIM_OBSERVED: ['type', 'ts', 'sourceEventId', 'provider', 'symbol', 'propositionId', 'claimKey', 'claimType', 'status', 'title'],
  RUMOR2_PACKET: ['type', 'ts', 'sourceEventId', 'provider', 'symbol', 'propositionId', 'claimType', 'packetId', 'packet'],
  RUMOR2_WITHHELD_COIN: ['type', 'ts', 'sourceEventId', 'provider', 'reason', 'claimType', 'title'],
  RUMOR2_WITHHELD_PROP: ['type', 'ts', 'sourceEventId', 'provider', 'symbol', 'propositionId', 'claimType', 'reasons'],
});
const COIN_SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const NODE_STATUSES = Object.freeze(['UNVERIFIED', 'CORROBORATED', 'PRIMARY_CONFIRMED', 'CONTRADICTED', 'RETRACTED']);

// Closed semantic validation of one prepared item transaction (A2R). A
// persisted transaction is replayed VERBATIM on restart, so restart may
// trust it only when everything proves out:
//   - the source identity is RECOMPUTED from durably preserved immutable
//     identity facts — a syntactically valid forged r2s id dies here;
//   - every event matches its exact closed schema and its semantic
//     bindings (proposition identities recomputed, packets re-validated
//     under serpent-evidence-1);
//   - candidate seen state is EXACTLY rememberSeen(prior, source) — the
//     causal transition from prior durable truth, never an assertion;
//   - the candidate graph delta is EXACTLY re-derived by the same pure
//     transition used at preparation over the actual prior graph.
export function validateRumor2Txn(t, { providerIds, graph, priorSeenIds = [] }) {
  if (!isPlainObject(t)) return 'txn: not an object';
  const keyErr = exactKeys(t, ['txnVersion', 'provider', 'sourceObservationId', 'identityFacts', 'clocks', 'events', 'candidate', 'preparedTs'], 'txn');
  if (keyErr) return keyErr;
  if (t.txnVersion !== 1) return 'txn: unsupported version';
  if (!providerIds.includes(t.provider)) return 'txn: unknown provider';
  const providerMeta = providerById(t.provider);
  if (!providerMeta) return 'txn: provider not in the registry';
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

  // BLOCKER-1 repair: the immutable identity facts are preserved in the
  // transaction in closed bounded form, and the source identity must be
  // the RECOMPUTED semantic hash of exactly those facts — never trusted
  // from its shape, never proven by a self-asserted expected id.
  if (!isPlainObject(t.identityFacts)) return 'txn: identityFacts missing';
  const fErr = exactKeys(t.identityFacts, ['provider', 'guid', 'link', 'publishedTs', 'title', 'summary'], 'txn.identityFacts');
  if (fErr) return fErr;
  const facts = t.identityFacts;
  if (facts.provider !== t.provider) return 'txn: identityFacts provider disagrees with transaction provider';
  if (facts.publishedTs !== publishedTs) return 'txn: identityFacts publication clock disagrees with transaction clocks';
  if (!isBounded(facts.title, MAX_TITLE_CHARS)) return 'txn: identityFacts title invalid';
  if (typeof facts.summary !== 'string' || facts.summary.length > MAX_SUMMARY_CHARS) return 'txn: identityFacts summary invalid';
  if (facts.guid !== null && !isBounded(facts.guid, 500)) return 'txn: identityFacts guid invalid';
  if (facts.link !== null && !isBounded(facts.link, 2000)) return 'txn: identityFacts link invalid';
  if (sourceObservationIdentity(facts) !== t.sourceObservationId)
    return 'txn: source identity is not the semantic hash of the preserved facts — forged provenance';
  // RUMOR-2B1 tightening: the claim TYPE is itself the deterministic
  // consequence of the preserved facts (the same closed pattern tables the
  // preparer ran), never an assertion. An unclassifiable item — every
  // EDGAR filing and OFAC record by construction — can therefore never
  // smuggle a typed claim or a coin-resolution withholding into its bundle.
  const derivedClaimType = classifyOfficialItem({ providerKind: providerMeta.providerKind, title: facts.title, summary: facts.summary });

  if (!Array.isArray(t.events) || t.events.length === 0 || t.events.length > MAX_TXN_EVENTS) return 'txn: events invalid';
  // Bundle law: the prepared events are a semantic SET, not a list of
  // individually plausible records. Each proposition may be claimed at most
  // once, each packet identity may appear at most once, each withholding is
  // unique, and outcomes are mutually exclusive — enforced here, at the one
  // shared trust gate, so a duplicate (byte-identical or cosmetically
  // altered around the same recomputed identity) can never be legitimized
  // by adjusting the counters to match the malformed bundle. Memory
  // deduplication downstream is a safety net, never permission to append
  // duplicate or mutually contradictory raw truth.
  let sourceEvents = 0;
  let coinResolutionWithheld = 0;
  const claimSpecs = [];
  const packetsByProp = new Map();
  const claimStatusByProp = new Map();
  const packetIds = new Set();
  const withheldProps = new Set();
  for (const e of t.events) {
    if (!isPlainObject(e)) return 'txn: event not an object';
    if (!RUMOR2_TXN_EVENT_TYPES.includes(e.type)) return `txn: event type ${String(e.type).slice(0, 40)} not allowed`;
    if (e.provider !== t.provider) return 'txn: event provider disagrees with transaction provider';
    if (e.ts !== expectedTs) return 'txn: event clock disagrees with the prepared knowledge clock';
    if (typeof e.sourceEventId !== 'string' || e.sourceEventId.length === 0) return 'txn: event missing sourceEventId';
    if (e.type === 'RUMOR2_SOURCE_OBSERVED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_SOURCE_OBSERVED, 'txn.sourceEvent');
      if (kErr) return kErr;
      sourceEvents += 1;
      if (e.sourceEventId !== t.sourceObservationId) return 'txn: source event identity disagrees with transaction source';
      if (e.publishedTs !== publishedTs || e.retrievedTs !== retrievedTs || e.knownAtTs !== knownAtTs)
        return 'txn: source event clocks disagree with immutable transaction clocks';
      // BLOCKER-1: the source event must carry exactly the preserved facts
      // (the event summary is the bounded 1,000-char excerpt of them)
      if (e.title !== facts.title) return 'txn: source event title disagrees with identity facts';
      if (e.summary !== facts.summary.slice(0, 1000)) return 'txn: source event summary disagrees with identity facts';
      if (e.guid !== facts.guid) return 'txn: source event guid disagrees with identity facts';
      if (e.link !== facts.link) return 'txn: source event link disagrees with identity facts';
    } else if (e.type === 'RUMOR2_CLAIM_OBSERVED') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_CLAIM_OBSERVED, 'txn.claimEvent');
      if (kErr) return kErr;
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: claim event lacks a valid proposition identity';
      if (e.claimKey !== e.propositionId) return 'txn: claim event claimKey/propositionId disagree';
      if (e.sourceEventId !== `${t.sourceObservationId}|claim|${e.propositionId}`)
        return 'txn: claim event identity not bound to source and proposition';
      if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: claim event carries unknown claimType';
      if (e.claimType !== derivedClaimType) return 'txn: claim event claimType is not the deterministic classification of the preserved facts';
      if (typeof e.symbol !== 'string' || !COIN_SYMBOL_RE.test(e.symbol)) return 'txn: claim event symbol invalid';
      // the proposition identity must itself be the recomputed semantic hash
      if (propositionIdentity({ claimType: e.claimType, canonicalCoin: e.symbol, originSourceObservationId: t.sourceObservationId }) !== e.propositionId)
        return 'txn: claim event proposition identity is not the semantic hash of its content';
      // the recomputed identity IS the claim's semantic identity, so any
      // second claim for one proposition — byte-identical or altered in a
      // non-identity field — is the same duplicate, rejected the same way
      if (claimStatusByProp.has(e.propositionId)) return 'txn: duplicate claim event for one proposition — the bundle must be true';
      if (!NODE_STATUSES.includes(e.status)) return 'txn: claim event status invalid';
      if (e.title !== facts.title) return 'txn: claim event title disagrees with identity facts';
      claimSpecs.push({ propositionId: e.propositionId, claimType: e.claimType, symbol: e.symbol });
      claimStatusByProp.set(e.propositionId, e.status);
    } else if (e.type === 'RUMOR2_PACKET') {
      const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_PACKET, 'txn.packetEvent');
      if (kErr) return kErr;
      if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: packet event lacks a valid proposition identity';
      if (packetsByProp.has(e.propositionId)) return 'txn: duplicate packet event for one proposition — the bundle must be true';
      if (!isPlainObject(e.packet)) return 'txn: packet event lacks a packet';
      // the accepted evidence contract validator runs over every prepared
      // packet — the contract itself recomputes packetId against semantic
      // content, so a forged identity dies here too.
      const check = validateEvidencePacket(e.packet);
      if (!check.valid) return boundedError(`txn: prepared packet fails serpent-evidence-1 (${check.reasons[0] ?? 'invalid'})`);
      if (e.packetId !== e.packet.packetId) return 'txn: packet event packetId disagrees with the packet itself';
      if (e.sourceEventId !== `${t.sourceObservationId}|packet|${e.packetId}`)
        return 'txn: packet event identity not bound to source and packet';
      if (packetIds.has(e.packetId)) return 'txn: duplicate packet identity in one bundle — the bundle must be true';
      packetIds.add(e.packetId);
      if (typeof e.symbol !== 'string' || e.packet.subject?.canonicalCoin !== e.symbol) return 'txn: packet event symbol/packet subject disagree';
      packetsByProp.set(e.propositionId, e.packet);
    } else {
      if (!e.sourceEventId.startsWith(`${t.sourceObservationId}|withheld|`)) return 'txn: withheld event not bound to the transaction source';
      const suffix = e.sourceEventId.slice(`${t.sourceObservationId}|withheld|`.length);
      if (suffix === 'coin-resolution') {
        const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_COIN, 'txn.withheldEvent');
        if (kErr) return kErr;
        if (coinResolutionWithheld > 0) return 'txn: duplicate coin-resolution withholding — the bundle must be true';
        coinResolutionWithheld += 1;
        if (e.reason !== 'COIN_RESOLUTION_WITHHELD') return 'txn: coin-resolution withholding carries the wrong reason';
        if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: withheld event carries unknown claimType';
        if (e.claimType !== derivedClaimType) return 'txn: coin-resolution withholding claimType is not the deterministic classification of the preserved facts';
        if (e.title !== facts.title) return 'txn: withheld event title disagrees with identity facts';
      } else {
        const kErr = exactKeys(e, EVENT_KEYS.RUMOR2_WITHHELD_PROP, 'txn.withheldEvent');
        if (kErr) return kErr;
        if (typeof e.propositionId !== 'string' || !R2C_RE.test(e.propositionId)) return 'txn: withheld event proposition invalid';
        if (suffix !== e.propositionId) return 'txn: withheld event identity/proposition disagree';
        if (!RUMOR2_CLAIM_TYPES.includes(e.claimType)) return 'txn: withheld event carries unknown claimType';
        if (typeof e.symbol !== 'string' || !COIN_SYMBOL_RE.test(e.symbol)) return 'txn: withheld event symbol invalid';
        if (propositionIdentity({ claimType: e.claimType, canonicalCoin: e.symbol, originSourceObservationId: t.sourceObservationId }) !== e.propositionId)
          return 'txn: withheld event proposition identity is not the semantic hash of its content';
        if (withheldProps.has(e.propositionId)) return 'txn: duplicate withheld event for one proposition — the bundle must be true';
        withheldProps.add(e.propositionId);
        if (!Array.isArray(e.reasons) || e.reasons.length === 0 || e.reasons.length > 8 || !e.reasons.every((x) => isBounded(x, MAX_ERROR_CHARS)))
          return 'txn: withheld event lacks bounded reasons';
      }
    }
  }
  if (sourceEvents !== 1) return 'txn: exactly one source-observed event is required';

  // Outcome exclusivity — one truthful terminal outcome per proposition and
  // per source item. A packet asserts "valid evidence was produced"; a
  // proposition withholding asserts "no valid evidence could be produced"
  // for that SAME proposition — both cannot be true at once. A
  // coin-resolution withholding asserts the source item resolved to NO
  // coin, so it cannot coexist with any resolved claim path. Internally
  // consistent contradiction is still contradiction.
  for (const spec of claimSpecs) {
    const hasPacket = packetsByProp.has(spec.propositionId);
    const hasWithheld = withheldProps.has(spec.propositionId);
    if (hasPacket && hasWithheld) return 'txn: proposition carries both a packet and a withholding — contradictory outcomes';
    if (!hasPacket && !hasWithheld) return 'txn: claim event lacks its one packet-or-withheld outcome';
  }
  for (const propId of withheldProps)
    if (!claimStatusByProp.has(propId)) return 'txn: withheld event has no corresponding claim event';
  if (coinResolutionWithheld > 0 && claimSpecs.length > 0)
    return 'txn: coin-resolution withholding contradicts a resolved claim path for the same source';

  // candidate — closed schema, and CAUSALLY DERIVED, never asserted
  if (!isPlainObject(t.candidate)) return 'txn: candidate missing';
  const candErr = exactKeys(t.candidate, ['seenIds', 'graphClaims', 'graphRemovals', 'counterDeltas', 'lastNewItemTs'], 'txn.candidate');
  if (candErr) return candErr;
  const cand = t.candidate;
  // BLOCKER-3 repair: the ONLY valid seen set is the deterministic
  // rememberSeen transition from the actual prior durable provider state —
  // membership, ordering, and truncation included.
  if (!Array.isArray(cand.seenIds)) return 'txn: candidate seenIds invalid';
  const expectedSeen = rememberSeen(Array.isArray(priorSeenIds) ? priorSeenIds : [], t.sourceObservationId);
  if (JSON.stringify(cand.seenIds) !== JSON.stringify(expectedSeen))
    return 'txn: candidate seenIds is not the causal rememberSeen transition from prior durable state';
  if (!isPlainObject(cand.graphClaims)) return 'txn: candidate graphClaims invalid';
  for (const [k, node] of Object.entries(cand.graphClaims)) {
    if (!R2C_RE.test(k)) return 'txn: candidate graph key is not a proposition identity';
    if (!isPlainObject(node) || node.propositionId !== k || node.claimKey !== k) return 'txn: candidate node disagrees with its proposition key';
  }
  if (!Array.isArray(cand.graphRemovals) || cand.graphRemovals.length > MAX_ACTIVE_CLAIMS) return 'txn: candidate graphRemovals invalid';
  for (const k of cand.graphRemovals) if (typeof k !== 'string' || !R2C_RE.test(k)) return 'txn: candidate removal is not a proposition identity';
  // BLOCKER-4 repair: re-derive the exact graph delta from the actual
  // prior graph + the validated claim events, through the SAME pure
  // transition used at preparation — node contents, pruning and all.
  const priorGraph = isPlainObject(graph) && isPlainObject(graph.claims) ? graph : { claims: {} };
  let derived;
  try {
    derived = deriveTxnGraphDelta({
      graph: priorGraph,
      providerId: t.provider,
      sourceType: providerMeta.sourceType,
      authorityClass: providerMeta.authorityClass,
      sourceObservationId: t.sourceObservationId,
      clocks: t.clocks,
      identityFacts: facts,
      claims: claimSpecs,
    });
  } catch (err) {
    return boundedError(`txn: graph derivation rejected (${err.message})`);
  }
  if (canonicalJson(cand.graphClaims) !== canonicalJson(derived.graphClaims))
    return 'txn: candidate graph state is not the deterministic consequence of prior truth plus this bundle';
  if (canonicalJson([...cand.graphRemovals].sort()) !== canonicalJson([...derived.graphRemovals].sort()))
    return 'txn: candidate graph removals are not the deterministic pruning of prior truth plus this bundle';
  // every claim event's stated status and every packet's claim must match
  // the derived node truth exactly
  for (const spec of claimSpecs) {
    const node = derived.graphClaims[spec.propositionId];
    if (!node) return 'txn: claim event proposition missing from the derived graph delta';
    if (claimStatusByProp.get(spec.propositionId) !== node.status) return 'txn: claim event status disagrees with derived node truth';
    const packet = packetsByProp.get(spec.propositionId);
    if (packet) {
      const pc = Array.isArray(packet.claims) ? packet.claims[0] : null;
      if (
        !pc ||
        pc.claimText !== node.claimText ||
        pc.status !== node.status ||
        pc.normalizedSubject !== node.normalizedSubject ||
        pc.firstObservedTs !== node.firstKnownTs ||
        packet.subject?.canonicalCoin !== node.canonicalCoin
      )
        return 'txn: prepared packet claim disagrees with derived node truth';
    }
  }
  for (const propId of packetsByProp.keys())
    if (!claimSpecs.some((s) => s.propositionId === propId)) return 'txn: packet event has no corresponding claim event';
  // the adopted graph may never exceed the accepted bound
  const after = new Set(Object.keys(priorGraph.claims));
  for (const k of cand.graphRemovals) after.delete(k);
  for (const k of Object.keys(cand.graphClaims)) after.add(k);
  if (after.size > MAX_ACTIVE_CLAIMS) return 'txn: candidate adoption exceeds the active-claim bound';
  // counters — EXACT keys, nonnegative safe integers, DERIVED from the
  // proven-unique validated bundle (never from raw event-array length):
  // never a decrement, never a manufactured counter, never an increment
  // for a duplicate or unowed event. A delta can never legitimize a
  // malformed bundle, because uniqueness was proven before it is compared.
  const dErr = exactKeys(cand.counterDeltas, ['sourcesObserved', 'claimsObserved', 'packetsProduced', 'packetsWithheld'], 'txn.counterDeltas');
  if (dErr) return dErr;
  for (const [k, v] of Object.entries(cand.counterDeltas))
    if (!Number.isSafeInteger(v) || v < 0) return `txn: counter delta ${k} must be a nonnegative safe integer`;
  if (cand.counterDeltas.sourcesObserved !== sourceEvents) return 'txn: sourcesObserved delta disagrees with the prepared bundle';
  if (cand.counterDeltas.claimsObserved !== claimStatusByProp.size) return 'txn: claimsObserved delta disagrees with the prepared bundle';
  if (cand.counterDeltas.packetsProduced !== packetsByProp.size) return 'txn: packetsProduced delta disagrees with the prepared bundle';
  if (cand.counterDeltas.packetsWithheld !== withheldProps.size + coinResolutionWithheld) return 'txn: packetsWithheld delta disagrees with the prepared bundle';
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

// ---- deterministic graph transition (A2R: ONE authoritative path) ----------
// observeClaim is the ONLY way a proposition node changes. It lives here —
// beside the transaction trust validator — so preparation and validation
// literally share the same pure function, never two subtly different
// algorithms. graph.js re-exports this surface unchanged.
export const OBS_PER_CLAIM = 6; // bounded packet-building observations kept per claim

export const independenceGroupFor = (providerId) => `org:${providerId}`;

export function emptyGraph() {
  return { claims: {} };
}

export function observeClaim(
  graph,
  { propositionId, claimType, canonicalCoin, providerId, sourceObservationId, title, relationKinds, knownAtTs }
) {
  const prior = graph.claims[propositionId];
  const node = prior
    ? { ...prior }
    : {
        propositionId,
        claimKey: propositionId, // stable node key — the proposition, never a category
        claimType,
        canonicalCoin,
        originSourceObservationId: sourceObservationId,
        normalizedSubject: `${canonicalCoin}:${claimType}:${sourceObservationId}`,
        claimText: String(title ?? '').slice(0, MAX_TITLE_CHARS),
        firstKnownTs: knownAtTs,
        status: 'UNVERIFIED',
        originSourceIds: [],
        supportSourceIds: [],
        echoSourceIds: [],
        primaryConfirmationSourceIds: [],
        contradictionSourceIds: [],
        retractionSourceIds: [],
        independenceGroups: [],
        observations: [],
        lastUpdateTs: knownAtTs,
      };
  const addOnce = (arr, v) => (arr.includes(v) || arr.length >= MAX_SOURCES_PER_CLAIM ? arr : [...arr, v]);
  for (const kind of relationKinds) {
    if (kind === 'ORIGIN') node.originSourceIds = addOnce(node.originSourceIds, sourceObservationId);
    else if (kind === 'PRIMARY_CONFIRMATION')
      node.primaryConfirmationSourceIds = addOnce(node.primaryConfirmationSourceIds, sourceObservationId);
    else if (kind === 'INDEPENDENT_SUPPORT') node.supportSourceIds = addOnce(node.supportSourceIds, sourceObservationId);
    else if (kind === 'ECHO') node.echoSourceIds = addOnce(node.echoSourceIds, sourceObservationId);
    else if (kind === 'CONTRADICTION') node.contradictionSourceIds = addOnce(node.contradictionSourceIds, sourceObservationId);
    else if (kind === 'RETRACTION') node.retractionSourceIds = addOnce(node.retractionSourceIds, sourceObservationId);
  }
  node.independenceGroups = addOnce(node.independenceGroups, independenceGroupFor(providerId));
  // Structural status, honestly: an OFFICIAL primary assertion is
  // PRIMARY_CONFIRMED; contradiction/retraction relations flip the status
  // the contract can prove; nothing here ever claims CORROBORATED — one
  // organization is one provenance family, and one family can never
  // corroborate itself.
  if (node.retractionSourceIds.length > 0) node.status = 'RETRACTED';
  else if (node.contradictionSourceIds.length > 0) node.status = 'CONTRADICTED';
  else if (node.primaryConfirmationSourceIds.length > 0) node.status = 'PRIMARY_CONFIRMED';
  else node.status = 'UNVERIFIED';
  node.lastUpdateTs = knownAtTs;

  const claims = { ...graph.claims, [propositionId]: node };
  // bounded: beyond the cap, the stalest node is dropped deterministically
  const keys = Object.keys(claims);
  const prunedKeys = [];
  if (keys.length > MAX_ACTIVE_CLAIMS) {
    const oldest = keys.sort((a, b) => claims[a].lastUpdateTs - claims[b].lastUpdateTs || (a < b ? -1 : 1))[0];
    delete claims[oldest];
    prunedKeys.push(oldest);
  }
  return { graph: { claims }, node, prunedKeys, pruned: prunedKeys.length };
}

// The shared item→graph delta: given the prior graph, the item's immutable
// identity facts and clocks, and the claim specs (proposition, type, coin),
// derive the EXACT candidate graph mutation — nodes with their bounded
// packet-building observations, plus any deterministic pruning. Used
// verbatim by transaction preparation AND by transaction trust validation:
// candidate graph state must be the deterministic consequence of prior
// durable truth plus this exact bundle, never an assertion.
export function deriveTxnGraphDelta({ graph, providerId, sourceType, authorityClass, sourceObservationId, clocks, identityFacts, claims }) {
  let work = graph;
  const graphClaims = {};
  const graphRemovals = [];
  const relationKinds = ['ORIGIN', 'PRIMARY_CONFIRMATION']; // an official publication directly asserting the claim
  for (const spec of claims) {
    const res = observeClaim(work, {
      propositionId: spec.propositionId,
      claimType: spec.claimType,
      canonicalCoin: spec.symbol,
      providerId,
      sourceObservationId,
      title: identityFacts.title,
      relationKinds,
      knownAtTs: clocks.knownAtTs,
    });
    work = res.graph;
    const node = res.node;
    const obs = {
      sourceObservationId,
      providerId,
      sourceType,
      authorityClass,
      publishedTs: clocks.publishedTs,
      retrievedTs: clocks.retrievedTs,
      knownAtTs: clocks.knownAtTs,
      title: identityFacts.title,
      summary: identityFacts.summary.slice(0, 1000),
      link: identityFacts.link,
      relationKinds,
    };
    node.observations = [...(node.observations ?? []).filter((o) => o.sourceObservationId !== sourceObservationId), obs].slice(-OBS_PER_CLAIM);
    work.claims[spec.propositionId] = node;
    graphClaims[spec.propositionId] = node;
    for (const k of res.prunedKeys) if (!(k in graphClaims)) graphRemovals.push(k);
  }
  return { graphClaims, graphRemovals };
}
