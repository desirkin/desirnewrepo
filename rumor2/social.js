// SOCIAL-1 — the SHARED SOCIAL SOURCE CONTRACT. One bounded normalization
// shape that every social provider adapter (Bluesky, Farcaster, and later X,
// Reddit, StockTwits, …) converges on, so the frozen RUMOR-2 event root gains
// social EVIDENCE without a parallel engine and without per-platform truth
// schemas. This module is PURE and DETERMINISTIC: no network, no clock of its
// own (callers pass nowMs), no model calls, no side effects. It defines
// identity, point-in-time clocks, echo/repost relationships, a deterministic
// (non-LLM) near-duplicate foundation, propagation-vs-independence accounting,
// and the pump/coordination FEATURE foundation + a non-authoritative research
// stage contract.
//
// DOCTRINE (do not "fix" these — they are deliberate):
//   * Social is DARK / SOURCE-ONLY. A social post is EVIDENCE. It is never a
//     claim, never corroboration of an official claim, and has NO path to
//     Attention/HYPED/eligibility/score/sizing/execution. (§20/§45)
//   * PUMPS ARE NOT REJECTED. Coordinated behaviour is INFORMATION, not a
//     veto. Early coordinated ignition may be the most interesting event of
//     all; late coordinated distribution may be dangerous. This layer records
//     stage/coordination FEATURES; it never emits BUY/SELL/REJECT. (§4/§14/§15)
//   * VOLUME != INDEPENDENCE. 10,000 reposts are one information family, not
//     10,000 confirmations. Engagement (likes/reposts/upvotes/views) is
//     attention metadata, never factual confirmation. (§13)
//   * POINT-IN-TIME: sourceCreatedTs (when posted) < retrievedTs (when we
//     fetched) <= knownAtTs (when Serpent actually knew). knownAt is NEVER
//     backdated to the post's creation. (§7)
//   * IDENTITY is provider-native and immutable: a post is (provider,
//     nativePostId); an author is (provider, nativeAuthorId). Handles change;
//     they are never the durable identity. (§8/§9)
import { canonicalJson, contentHash } from './truth.js';

// ---- bounds (closed; no unbounded provider blobs ever enter durable truth) --
export const MAX_SOCIAL_TEXT_CHARS = 4_000; // preserved original post text
export const MAX_SOCIAL_HANDLE_CHARS = 200;
export const MAX_SOCIAL_DISPLAY_CHARS = 200;
export const MAX_NATIVE_ID_CHARS = 500; // at:// URIs, cast hashes, t3_ fullnames
export const MAX_SOCIAL_URL_CHARS = 2_000;
export const MAX_SHINGLES = 64; // bounded similarity feature set per post
export const SHINGLE_K = 3; // token shingle width
export const NEAR_DUP_THRESHOLD = 0.82; // Jaccard >= this => candidate echo (deterministic; not identity)
export const MAX_WINDOW_OBSERVATIONS = 4_096; // bound on a coordination-feature window
export const MAX_INGRESS_TAGS = 16; // SOCIAL-2B: bounded provider-side admission tags (X matching_rules)
export const MAX_INGRESS_TAG_CHARS = 64;

// ---- provider kinds (ALL source-only; none claim-capable) ------------------
// A social providerKind must NEVER appear in RUMOR-2's CLAIM_CAPABLE_PROVIDER_
// KINDS. This list is the closed set of social ear kinds; the frozen graph
// validator already refuses claims from any kind not on its official list, so
// social evidence can never mint a typed claim. (§20)
export const SOCIAL_PROVIDER_KINDS = Object.freeze([
  'SOCIAL_MICROBLOG', // X, Bluesky, Farcaster, Threads-like short posts
  'SOCIAL_FORUM', // Reddit-like threaded communities
  'SOCIAL_FINANCE', // StockTwits-like finance-native streams
]);

// ---- relationship model (original vs echo) — §10 ---------------------------
// Provider-native relationships are strongest. An explicit repost/recast/
// crosspost is an ECHO and must NEVER count as independent corroboration.
export const SOCIAL_RELATION_KINDS = Object.freeze([
  'ORIGINAL', // a first-party post with no native parent
  'REPLY', // a reply in a thread
  'REPOST', // retweet / recast / repost — explicit echo of another post
  'QUOTE', // quote-post — echo that adds commentary
  'CROSSPOST', // reposted into another community (Reddit crosspost)
  'POSSIBLE_COPY', // no native relation, but text near-duplicates a known post (deterministic candidate)
  'UNKNOWN',
]);
// Which relations are EXPLICIT echoes (provider-native) — these can never be
// independent provenance families on their own.
export const ECHO_RELATIONS = Object.freeze(['REPOST', 'QUOTE', 'CROSSPOST']);

// ---- edit / deletion observation kinds — §17 -------------------------------
// Content changes are appended as NEW observations; original knowledge is
// never rewritten. A deletion may itself be informative later.
export const SOCIAL_EDIT_STATES = Object.freeze(['ORIGINAL', 'EDITED', 'DELETED', 'TOMBSTONED']);

// ---- pump/coordination stage (RESEARCH LABEL ONLY, non-authoritative) — §15 -
// This is a SOCIAL stage estimate. It is NOT BUY/SELL/TRADE/REJECT and has no
// execution authority. The classifier stays DARK until SOCIAL-5 calibrates
// thresholds against real history — arbitrary thresholds are forbidden (§15).
export const SOCIAL_STAGE_STATES = Object.freeze([
  'QUIET', 'IGNITION', 'ACCELERATION', 'CROWDED', 'POSSIBLE_DISTRIBUTION', 'DECAY', 'UNKNOWN',
]);

// ---- provenance family membership — §12 ------------------------------------
export const PROVENANCE_FAMILY_KINDS = Object.freeze([
  'ORIGIN_CANDIDATE', 'UPSTREAM_PARENT', 'ECHO', 'INDEPENDENT', 'UNRESOLVED',
]);

// Doctrine string embedded for any later reader/UI — pumps are information.
export const SOCIAL_PUMP_DOCTRINE =
  'DETECT EARLY. TAKE THE TRADABLE SLICE. DO NOT BECOME EXIT LIQUIDITY. ' +
  'Social RUMOR records pump/coordination stage and provenance as INFORMATION; ' +
  'it never converts COORDINATED into REJECT and makes no trade decision.';

// ---- deterministic identity ------------------------------------------------
const isNonEmptyStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// A social POST identity is IMMUTABLE and provider-native: (provider,
// nativePostId) ONLY. Content is deliberately NOT part of identity, so a
// re-delivery of the same native id carrying an ALTERED payload collapses to
// the SAME sourceEventId and is caught by the journal's duplicate-identity /
// altered-payload corruption law — never silently accepted as a new post. (§8/§41)
export function socialSourceIdentity({ provider, nativePostId }) {
  if (!isNonEmptyStr(provider, 100) || !isNonEmptyStr(nativePostId, MAX_NATIVE_ID_CHARS)) return null;
  return `r2ss-${contentHash(canonicalJson({ provider, nativePostId }))}`;
}

// A social AUTHOR identity is provider-scoped and immutable: (provider,
// nativeAuthorId). Never the handle (handles change). Never merged across
// platforms — @fred on X is not fred on Reddit; cross-platform linkage needs
// separate strong evidence and is NOT part of SOCIAL-1. (§9)
export function socialAuthorIdentity({ provider, nativeAuthorId }) {
  if (!isNonEmptyStr(provider, 100) || !isNonEmptyStr(nativeAuthorId, MAX_NATIVE_ID_CHARS)) return null;
  return `r2sa-${contentHash(canonicalJson({ provider, nativeAuthorId }))}`;
}

export const R2SS_RE = /^r2ss-[0-9a-f]{40}$/;
export const R2SA_RE = /^r2sa-[0-9a-f]{40}$/;

// ---- lifecycle & version identity (post identity vs post version) — §10 ----
// A native post keeps a STABLE post identity (socialSourceId) across its life,
// while each CREATE / EDIT / DELETE / TOMBSTONE is a distinct VERSION event.
export const SOCIAL_LIFECYCLE_STATES = Object.freeze(['CREATE', 'EDIT', 'DELETE', 'TOMBSTONE']);
const LIFECYCLE_BY_EDIT = Object.freeze({ ORIGINAL: 'CREATE', EDITED: 'EDIT', DELETED: 'DELETE', TOMBSTONED: 'TOMBSTONE' });
export const lifecycleForEditState = (e) => LIFECYCLE_BY_EDIT[e] ?? 'CREATE';
// CONTENT / VERSION FACTS (§4/§26). The ONE canonical set of IMMUTABLE provider
// content/provenance/lifecycle facts. These — and ONLY these — bind the content
// version identity (via socialVersionHash -> socialVersionIdentity -> the
// durable sourceEventId). MUTABLE first-known diagnostics (handle, authorMeta,
// engagement) are DELIBERATELY excluded: a handle rename, a follower-count
// change, or engagement growth on an unchanged provider-native post must NOT
// manufacture a new content version (§3/§17/§22/§23/§24). sourceCreatedTs is a
// provider-supplied source clock OR null/UNKNOWN — never Serpent's processing
// time (§8) — canonicalized to a stable null so an unknown source time stays
// deterministic across redelivery/replay (§11). retrieved/known are Serpent's
// acquisition clocks, validated by the point-in-time law, never part of
// immutable post truth.
export function socialProvenanceFacts(f) {
  return {
    provider: f.provider, providerKind: f.providerKind,
    nativePostId: f.nativePostId, nativeAuthorId: f.nativeAuthorId,
    lifecycle: f.lifecycle, relation: f.relation,
    parentNativePostId: f.parentNativePostId ?? null,
    threadId: f.threadId ?? null,
    nativeVersionId: f.nativeVersionId ?? null,
    // SOCIAL-2A: the provider-native lifecycle/commit event identity (Bluesky
    // Jetstream `seq`) — closed, bounded, provider-supplied, replay-stable,
    // never wall-clock. It distinguishes genuinely distinct commits on ONE
    // stable post identity (CREATE / DELETE / RECREATE / DELETE) so two distinct
    // deletes can never collapse into one tombstone, while an at-least-once
    // redelivery of the SAME commit (same seq) stays one truth. null for
    // providers with no such concept. NOT part of socialSourceId. (§9-§13)
    providerEventSeq: f.providerEventSeq ?? null,
    textHash: f.textHash,
    // SOURCE-CLOCK QUARANTINE SEAL (§13): the version binds the SOURCE-DECLARED
    // clock — the exact provider-record createdAt, immutable record content —
    // never the acquisition-derived trusted sourceCreatedTs (which is null when
    // quarantined and would otherwise make the same immutable record a
    // different version depending on when Serpent happened to fetch it).
    sourceDeclaredTs: f.sourceDeclaredTs ?? null,
  };
}
// canonical bounded engagement snapshot (first-known) — a stable 6-key shape so
// the diagnostic metaHash re-derivation is order/shape independent
export function canonicalEngagement(e) {
  if (e === null || e === undefined) return null;
  return { likes: e.likes ?? null, reposts: e.reposts ?? null, replies: e.replies ?? null, quotes: e.quotes ?? null, views: e.views ?? null, upvotes: e.upvotes ?? null };
}
// canonical bounded first-known author metadata — a stable CLOSED 5-key shape
// (§16) so the diagnostic metaHash re-derivation is order/shape independent.
// Unavailable fields are null/UNKNOWN, never fabricated. authorMeta is NEVER
// author identity (§17) and never content-version identity — it is a first-known
// diagnostic snapshot, bound by the diagnostic hash so it cannot be silently
// rewritten once stored (§18), yet free to differ on a later live redelivery
// without forking a version (§6).
export function canonicalAuthorMeta(m) {
  if (m === null || m === undefined) return null;
  return {
    accountCreatedTs: m.accountCreatedTs ?? null,
    followerCount: m.followerCount ?? null,
    followingCount: m.followingCount ?? null,
    verified: m.verified ?? null,
    powerBadge: m.powerBadge ?? null,
  };
}
// DIAGNOSTIC / META FACTS (§5/§26). Serpent's FIRST-KNOWN mutable diagnostic
// snapshot for a historical event: handle, author metadata, and the first-known
// engagement snapshot. These do NOT define the content version, but once stored
// they are bound by the diagnostic hash and re-verified in validation, so no
// stored diagnostic can be silently altered later (§18/§25).
export function socialDiagnosticFacts(f) {
  return {
    handle: f.handle ?? null,
    authorMeta: canonicalAuthorMeta(f.authorMeta),
    engagement: canonicalEngagement(f.engagement),
    // SOURCE-CLOCK QUARANTINE SEAL (§8/§9/§13/§15): the acquisition-dependent
    // clock verdict is a FIRST-KNOWN historical diagnostic — bound here so a
    // stored verdict cannot be silently rewritten, but never part of the content
    // version, so a later redelivery (after wall time caught up) dedupes instead
    // of forking. providerEventTs is provider transport timing evidence, kept
    // out of the content identity for replay safety and bound here first-known.
    sourceClockStatus: f.sourceClockStatus ?? 'UNKNOWN',
    sourceClockSkewMs: f.sourceClockSkewMs ?? null,
    providerEventTs: f.providerEventTs ?? null,
    // FIRST-KNOWN ACQUISITION CLOCK LAW (SOCIAL-2B Job A): retrievedTs/knownAtTs
    // are Serpent's first-known acquisition truth — NOT provider content
    // identity (a later redelivery of the same immutable version derives the
    // SAME socialVersionId and is absorbed keep-first), but once stored they are
    // bound here so a durable event's acquisition clock can never be silently
    // rewritten under the same first-known integrity hash. The FIRST durable
    // acquisition clock stands.
    retrievedTs: f.retrievedTs ?? null,
    knownAtTs: f.knownAtTs ?? null,
    // SOCIAL-2B: WHY the provider admitted this post (X server-side rule tags) —
    // bounded, sorted, unique, first-known, diagnostic only; never identity,
    // never authority. A later redelivery matching more rules never rewrites it.
    ingressTags: canonicalIngressTags(f.ingressTags),
  };
}
export function canonicalIngressTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = new Set();
  for (const t of tags) if (typeof t === 'string' && t.length > 0 && t.length <= MAX_INGRESS_TAG_CHARS) out.add(t);
  return [...out].sort().slice(0, MAX_INGRESS_TAGS);
}
// ---- SOURCE-CLOCK QUARANTINE SEAL — the three clocks ------------------------
// A. sourceDeclaredTs — the exact parsed provider-record creation time (Bluesky
//    record.createdAt, Farcaster cast timestamp): CLIENT-SUPPLIED, useful, but
//    not an authoritative synchronized clock. Immutable record content.
// B. providerEventTs — the transport/provider event clock (Jetstream payload.time):
//    provider timing evidence, NOT original creation, NOT knowledge time.
// C. retrievedTs / knownAtTs — Serpent's acquisition clocks: the ONLY causal
//    truth. Serpent NEVER knew an event before knownAtTs; knownAt is never
//    backdated by any source or provider clock.
// sourceCreatedTs is the TRUSTED source clock: equal to sourceDeclaredTs when
// the declared clock is causally possible (<= retrievedTs), else null — the
// declared value is preserved as evidence but QUARANTINED from causal ordering,
// lead-time, and any authority. A bad client clock never discards the post and
// never makes Serpent believe it knew something earlier than it did. (§4-§11)
export const SOURCE_CLOCK_STATES = Object.freeze(['TRUSTED', 'FUTURE_QUARANTINED', 'UNKNOWN']);
// bound on the recorded skew diagnostic (safe-integer ms; ±10 years) — an absurd
// client clock is recorded as a clamped, bounded number, never an overflow
export const MAX_SOURCE_CLOCK_SKEW_MS = 10 * 365 * 24 * 3_600_000;
export function classifySourceClock({ sourceDeclaredTs, retrievedTs }) {
  if (!Number.isFinite(sourceDeclaredTs)) return { sourceCreatedTs: null, sourceClockStatus: 'UNKNOWN', sourceClockSkewMs: null };
  const declared = Math.floor(sourceDeclaredTs);
  if (declared <= retrievedTs) return { sourceCreatedTs: declared, sourceClockStatus: 'TRUSTED', sourceClockSkewMs: null };
  // sourceClockSkewMs = sourceDeclaredTs - retrievedTs: exactly why Serpent
  // quarantined the source clock at acquisition (ONE definition, never a
  // different reference clock). Diagnostic only.
  const skew = Math.min(MAX_SOURCE_CLOCK_SKEW_MS, declared - retrievedTs);
  return { sourceCreatedTs: null, sourceClockStatus: 'FUTURE_QUARANTINED', sourceClockSkewMs: skew };
}
// CONTENT / VERSION HASH — binds the immutable content/provenance facts only.
export const socialVersionHash = (f) => contentHash(canonicalJson(socialProvenanceFacts(f)));
// DIAGNOSTIC / META HASH — binds the first-known mutable diagnostic snapshot
// (handle + authorMeta + engagement). Re-derived and verified in validation so a
// stored diagnostic cannot be silently altered; NOT part of content identity, so
// a legitimate later redelivery with changed diagnostics is neither a new
// version nor corruption (§5/§6/§26).
export const socialMetaHash = (f) => contentHash(canonicalJson(socialDiagnosticFacts(f)));

// Version/lifecycle identity. It BINDS the stable post identity plus EVERY
// immutable CONTENT/provenance fact (via socialVersionHash): a change to
// lifecycle, relation, parent, thread, native version id, text, or a KNOWN
// source time yields a DIFFERENT version. MUTABLE diagnostics (handle,
// authorMeta, engagement) are NOT bound here, so they can never manufacture a
// fake version (§4/§17). "same sourceEventId + changed immutable content fact"
// is impossible; keeping the old id makes validation reject (§6). Deterministic
// and replay-stable — never wall-clock, and stable when the source time is
// UNKNOWN (§11). A legitimate edit (new content/CID) is a new version; a delete
// is a new lifecycle version.
export function socialVersionIdentity(f) {
  return `r2sv-${contentHash(canonicalJson({ socialSourceId: f.socialSourceId, versionHash: socialVersionHash(f) }))}`;
}
export const R2SV_RE = /^r2sv-[0-9a-f]{40}$/;

// ---- point-in-time clocks — §7 ---------------------------------------------
// knownAtTs is ALWAYS the moment Serpent actually held the record (retrieval),
// NEVER the post's creation time. In replay the caller supplies the replay
// acquisition nowMs; the original sourceCreatedTs is preserved untouched.
export function socialClocks({ sourceCreatedTs, nowMs }) {
  const retrieved = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const created = Number.isFinite(sourceCreatedTs) ? Math.floor(sourceCreatedTs) : null;
  return { sourceCreatedTs: created, retrievedTs: retrieved, knownAtTs: retrieved };
}

// ---- deterministic near-duplicate foundation (NON-LLM) — §11 ---------------
// Recognise obviously copied/templated posts without a model. Normalisation is
// conservative: we lower-case, NFKC-fold, strip URL tracking params, collapse
// whitespace and runaway punctuation, and normalise mention/cashtag spacing —
// while ALWAYS preserving the original text separately. This yields a CANDIDATE
// echo signal, never final identity, and never collapses two DIFFERENT
// meaningful claims merely for surface similarity.
const TRACKING_PARAM_RE = /\b(utm_[a-z]+|ref|ref_src|ref_url|s|t|fbclid|gclid|igshid|cid|mc_[a-z]+)=[^\s&]*/gi;
export function normalizeSocialText(text) {
  let s = typeof text === 'string' ? text : '';
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/https?:\/\/\S+/g, (u) => u.replace(TRACKING_PARAM_RE, '').replace(/[?&#]+$/, ''));
  s = s.replace(/[​-‍﻿]/g, ''); // zero-width
  s = s.replace(/([!?.,#@$])\1{2,}/g, '$1$1'); // collapse runaway punctuation (keep <=2)
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
export function textFingerprint(text) {
  const normalized = normalizeSocialText(text);
  return { normalized, hash: contentHash(normalized) };
}

// Bounded token shingles (k-gram over whitespace tokens). Empty/short text
// yields the token set itself. The returned set is capped at MAX_SHINGLES.
export function textShingles(normalized, k = SHINGLE_K) {
  const toks = String(normalized ?? '').split(' ').filter(Boolean);
  const out = new Set();
  if (toks.length === 0) return out;
  if (toks.length < k) { out.add(toks.join(' ')); return out; }
  for (let i = 0; i + k <= toks.length && out.size < MAX_SHINGLES; i++) out.add(toks.slice(i, i + k).join(' '));
  return out;
}

// Jaccard similarity of two shingle sets, in [0,1]. Two empty sets are NOT
// similar (0) — absence of text is not evidence of copying.
export function shingleSimilarity(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set) || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Deterministic near-duplicate candidate between two ORIGINAL texts. Identical
// normalized text is an exact-copy candidate (1.0). This is an echo SIGNAL, not
// identity, and never merges distinct meaningful claims by itself.
export function nearDuplicate(textA, textB, threshold = NEAR_DUP_THRESHOLD) {
  const na = normalizeSocialText(textA);
  const nb = normalizeSocialText(textB);
  if (na.length === 0 || nb.length === 0) return { candidate: false, score: 0, exact: false };
  if (na === nb) return { candidate: true, score: 1, exact: true };
  const score = shingleSimilarity(textShingles(na), textShingles(nb));
  return { candidate: score >= threshold, score, exact: false };
}

// ---- shared normalized observation — §6 ------------------------------------
// The one shape every provider adapter converges on. Adapters parse different
// APIs; their normalized result is this. Bounded, closed, no raw API blob.
// Returns { ok, observation } or { reject, reason }. Callers still gate on the
// frozen event-root validator before anything becomes durable truth.
const REQUIRED_RAW = ['provider', 'providerKind', 'nativePostId', 'nativeAuthorId', 'text'];
export function normalizeSocialObservation(raw, { nowMs } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { reject: true, reason: 'observation not an object' };
  for (const k of REQUIRED_RAW) if (!(k in raw)) return { reject: true, reason: `missing field ${k}` };
  const { provider, providerKind, nativePostId, nativeAuthorId } = raw;
  if (!isNonEmptyStr(provider, 100)) return { reject: true, reason: 'provider invalid' };
  if (!SOCIAL_PROVIDER_KINDS.includes(providerKind)) return { reject: true, reason: 'providerKind not a social kind' };
  if (!isNonEmptyStr(nativePostId, MAX_NATIVE_ID_CHARS)) return { reject: true, reason: 'nativePostId invalid' };
  if (!isNonEmptyStr(nativeAuthorId, MAX_NATIVE_ID_CHARS)) return { reject: true, reason: 'nativeAuthorId invalid' };
  // text may be empty for a pure repost/tombstone, but must be a bounded string
  if (typeof raw.text !== 'string' || raw.text.length > MAX_SOCIAL_TEXT_CHARS) return { reject: true, reason: 'text invalid' };
  const relation = raw.relation ?? 'UNKNOWN';
  if (!SOCIAL_RELATION_KINDS.includes(relation)) return { reject: true, reason: 'relation not a known kind' };
  const editState = raw.editState ?? 'ORIGINAL';
  if (!SOCIAL_EDIT_STATES.includes(editState)) return { reject: true, reason: 'editState not a known kind' };
  const parentNativePostId = raw.parentNativePostId ?? null;
  if (parentNativePostId !== null && !isNonEmptyStr(parentNativePostId, MAX_NATIVE_ID_CHARS)) return { reject: true, reason: 'parentNativePostId invalid' };
  // LIFECYCLE-AWARE relationship law (§19): a CREATE/EDIT echo (repost/quote/
  // reply/crosspost) must name its parent, and an ORIGINAL must not carry one
  // (contradictory relationship data is never silently ignored). A DELETE/
  // TOMBSTONE may legitimately omit prior relationship data — the provider
  // deletion payload need not repeat it (relation UNKNOWN, parent null) — so it
  // is NOT held to the create-time invariants and its tombstone is never dropped.
  const isDeletion = editState === 'DELETED' || editState === 'TOMBSTONED';
  if (!isDeletion) {
    if ((relation === 'REPOST' || relation === 'QUOTE' || relation === 'REPLY' || relation === 'CROSSPOST') && parentNativePostId === null)
      return { reject: true, reason: `${relation} without a parent native id` };
    if (relation === 'ORIGINAL' && parentNativePostId !== null)
      return { reject: true, reason: 'ORIGINAL relation cannot carry a parent — contradictory relationship data' };
  }
  const handle = raw.handle ?? null;
  if (handle !== null && !isNonEmptyStr(handle, MAX_SOCIAL_HANDLE_CHARS)) return { reject: true, reason: 'handle invalid' };
  const displayName = raw.displayName ?? null;
  if (displayName !== null && (typeof displayName !== 'string' || displayName.length > MAX_SOCIAL_DISPLAY_CHARS)) return { reject: true, reason: 'displayName invalid' };
  const canonicalUrl = raw.canonicalUrl ?? null;
  if (canonicalUrl !== null && !isNonEmptyStr(canonicalUrl, MAX_SOCIAL_URL_CHARS)) return { reject: true, reason: 'canonicalUrl invalid' };
  const threadId = raw.threadId ?? null;
  if (threadId !== null && !isNonEmptyStr(threadId, MAX_NATIVE_ID_CHARS)) return { reject: true, reason: 'threadId invalid' };
  // a provider-native IMMUTABLE version identifier (e.g. a Bluesky record CID)
  // where the platform supplies one — it distinguishes an EDIT (a new version
  // of the same post) from an altered re-delivery of the SAME version (§10).
  // null when the provider has no version concept (e.g. Farcaster casts).
  const nativeVersionId = raw.nativeVersionId ?? null;
  if (nativeVersionId !== null && !isNonEmptyStr(nativeVersionId, MAX_NATIVE_ID_CHARS)) return { reject: true, reason: 'nativeVersionId invalid' };
  // provider-native commit/event sequence (Jetstream seq) — a non-negative safe
  // integer supplied by the provider, or null/UNKNOWN. Never invented. (§9/§13)
  const providerEventSeq = raw.providerEventSeq ?? null;
  if (providerEventSeq !== null && (!Number.isSafeInteger(providerEventSeq) || providerEventSeq < 0)) return { reject: true, reason: 'providerEventSeq invalid' };
  // SOURCE-CLOCK QUARANTINE SEAL (§4-§11). The adapter supplies the exact
  // parsed provider-record creation time as `sourceDeclaredTs` (raw
  // `sourceCreatedTs` is accepted as the same declared clock for adapters/
  // fixtures on the older field name) — a finite ms or null/UNKNOWN, NEVER
  // Date.now(). Serpent then CLASSIFIES it against its own acquisition clock:
  // causally possible => TRUSTED (sourceCreatedTs = declared); ahead of
  // retrieval => FUTURE_QUARANTINED (sourceCreatedTs = null, declared value
  // preserved, skew recorded) — the observation is NOT discarded; absent =>
  // UNKNOWN. A malformed provider timestamp is the adapter's to map to null
  // (never fabricated); a non-number here is a raw-contract violation.
  const rawDeclared = raw.sourceDeclaredTs !== undefined ? raw.sourceDeclaredTs : raw.sourceCreatedTs;
  let sourceDeclaredTs;
  if (rawDeclared === null || rawDeclared === undefined) sourceDeclaredTs = null;
  else if (Number.isFinite(rawDeclared)) sourceDeclaredTs = Math.floor(rawDeclared);
  else return { reject: true, reason: 'sourceDeclaredTs must be a finite ms or null (UNKNOWN)' };
  // provider transport/event clock (Jetstream payload.time): finite ms or null;
  // never fabricated, never copied into sourceCreatedTs or knownAtTs
  const rawProviderTs = raw.providerEventTs ?? null;
  if (rawProviderTs !== null && !Number.isFinite(rawProviderTs)) return { reject: true, reason: 'providerEventTs must be a finite ms or null' };
  const providerEventTs = rawProviderTs === null ? null : Math.floor(rawProviderTs);
  const retrievedTs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const knownAtTs = retrievedTs; // NEVER backdated to any source/provider clock
  if (retrievedTs > knownAtTs) return { reject: true, reason: 'retrieved after known' };
  const { sourceCreatedTs, sourceClockStatus, sourceClockSkewMs } = classifySourceClock({ sourceDeclaredTs, retrievedTs });
  // provider admission tags (X matching_rules) — bounded closed strings only
  const rawTags = raw.ingressTags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > MAX_INGRESS_TAGS || rawTags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_INGRESS_TAG_CHARS)) return { reject: true, reason: 'ingressTags invalid' };
  const ingressTags = canonicalIngressTags(rawTags);
  // engagement is PROPAGATION metadata only (never confirmation) — bounded ints or null
  const engagement = normalizeEngagement(raw.engagement);
  if (engagement === undefined) return { reject: true, reason: 'engagement invalid' };
  // author metadata where legitimately available — else null; never fabricated
  const authorMeta = normalizeAuthorMeta(raw.authorMeta, retrievedTs);
  if (authorMeta === undefined) return { reject: true, reason: 'authorMeta invalid' };
  const { normalized, hash } = textFingerprint(raw.text);
  const socialSourceId = socialSourceIdentity({ provider, nativePostId });
  const socialAuthorId = socialAuthorIdentity({ provider, nativeAuthorId });
  if (!socialSourceId || !socialAuthorId) return { reject: true, reason: 'identity derivation failed' };
  // a bounded deterministic hash of the immutable native metadata — lets a
  // re-delivery with altered facts be detected as corruption downstream
  const lifecycle = lifecycleForEditState(editState);
  // ONE canonical fact set feeds BOTH hashes (§4/§26): socialVersionHash reads
  // only the immutable CONTENT facts (no handle/authorMeta/engagement), while
  // socialMetaHash reads only the first-known DIAGNOSTIC snapshot (handle +
  // authorMeta + engagement). Neither recipe is duplicated across
  // mapper/settle/validator.
  const facts = {
    provider, providerKind, nativePostId, nativeAuthorId, lifecycle, relation, parentNativePostId,
    threadId, nativeVersionId, providerEventSeq, textHash: hash, sourceDeclaredTs,
    handle, authorMeta, engagement, sourceClockStatus, sourceClockSkewMs, providerEventTs, retrievedTs, knownAtTs, ingressTags, socialSourceId,
  };
  const metaHash = socialMetaHash(facts);
  const socialVersionId = socialVersionIdentity(facts);
  return {
    ok: true,
    observation: Object.freeze({
      provider, providerKind, nativePostId, nativeAuthorId,
      socialSourceId, socialAuthorId, handle, displayName,
      text: raw.text, normalizedText: normalized, textHash: hash,
      canonicalUrl, threadId, parentNativePostId, relation, editState, lifecycle,
      nativeVersionId, providerEventSeq, socialVersionId,
      sourceDeclaredTs, sourceCreatedTs, sourceClockStatus, sourceClockSkewMs, providerEventTs,
      retrievedTs, knownAtTs,
      engagement, authorMeta, ingressTags: Object.freeze(ingressTags), metaHash,
    }),
  };
}

function normalizeEngagement(e) {
  if (e === null || e === undefined) return null;
  if (typeof e !== 'object' || Array.isArray(e)) return undefined;
  const out = {};
  for (const k of ['likes', 'reposts', 'replies', 'quotes', 'views', 'upvotes']) {
    const v = e[k];
    if (v === undefined || v === null) { out[k] = null; continue; }
    if (!Number.isSafeInteger(v) || v < 0) return undefined;
    out[k] = v;
  }
  return Object.freeze(out);
}

// CLOSED bounded first-known author metadata (§16). Only provider-normalizable,
// safely bounded facts; unavailable fields are null/UNKNOWN, NEVER a fake zero
// or a default false. No provider-specific unbounded blob ever enters here.
// This is INFORMATION ONLY — it is not author identity (§17) and carries no
// claim/trade authority (§30). Returns null (no metadata), a frozen 5-key shape,
// or undefined (invalid → the caller rejects the observation).
function normalizeAuthorMeta(m, retrievedTs) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object' || Array.isArray(m)) return undefined;
  const followerCount = m.followerCount ?? null;
  if (followerCount !== null && (!Number.isSafeInteger(followerCount) || followerCount < 0)) return undefined;
  const followingCount = m.followingCount ?? null;
  if (followingCount !== null && (!Number.isSafeInteger(followingCount) || followingCount < 0)) return undefined;
  const accountCreatedTs = m.accountCreatedTs ?? null;
  if (accountCreatedTs !== null && (!Number.isFinite(accountCreatedTs) || accountCreatedTs > retrievedTs)) return undefined;
  const verified = m.verified ?? null;
  if (verified !== null && typeof verified !== 'boolean') return undefined;
  const powerBadge = m.powerBadge ?? null;
  if (powerBadge !== null && typeof powerBadge !== 'boolean') return undefined;
  return Object.freeze({
    accountCreatedTs: accountCreatedTs === null ? null : Math.floor(accountCreatedTs),
    followerCount, followingCount, verified, powerBadge,
  });
}

// account age in ms at retrieval, or null when creation is unknown (UNKNOWN,
// never fabricated) — §14 "Where platform metadata is unavailable: UNKNOWN."
export function authorAgeMs(observation) {
  const created = observation?.authorMeta?.accountCreatedTs;
  if (!Number.isFinite(created)) return null;
  return Math.max(0, observation.retrievedTs - created);
}

// ---- propagation vs independence — §13 -------------------------------------
// Given a set of normalized observations about ONE topic, separate RAW
// propagation (every post) from INDEPENDENT provenance families. An explicit
// echo (repost/quote/crosspost) is NEVER an independent family. Posts that
// near-duplicate an earlier post's text are POSSIBLE_COPY and collapse into
// that text family (a candidate echo, not a confirmation). Everything else is
// a distinct potential origin — we do NOT auto-merge genuinely different
// accounts stating similar claims (that is SOCIAL-5 reasoning). (§12/§13/§43)
export function propagationVsIndependence(observations, { nearDupThreshold = NEAR_DUP_THRESHOLD } = {}) {
  const obs = Array.isArray(observations) ? observations.slice(0, MAX_WINDOW_OBSERVATIONS) : [];
  const rawPropagationCount = obs.length;
  // sort by knowledge time so "earlier" text families anchor later copies
  const ordered = [...obs].sort((a, b) => (a.knownAtTs ?? 0) - (b.knownAtTs ?? 0));
  const families = []; // { anchorSourceId, kind, authorIds:Set, memberSourceIds:[], normalizedText }
  const byNativeId = new Map();
  for (const o of ordered) if (o?.nativePostId) byNativeId.set(o.nativePostId, o);
  for (const o of ordered) {
    // explicit native echo → attach to the parent's family if we have it
    if (ECHO_RELATIONS.includes(o.relation) && o.parentNativePostId && byNativeId.has(o.parentNativePostId)) {
      const parent = byNativeId.get(o.parentNativePostId);
      const fam = families.find((f) => f.memberSourceIds.includes(parent.socialSourceId));
      if (fam) { fam.memberSourceIds.push(o.socialSourceId); fam.echoCount += 1; continue; }
    }
    // deterministic near-duplicate of an existing family anchor → POSSIBLE_COPY
    let matched = null;
    if (o.normalizedText && o.normalizedText.length > 0) {
      for (const f of families) {
        if (!f.normalizedText) continue;
        const nd = nearDuplicate(o.normalizedText, f.normalizedText, nearDupThreshold);
        if (nd.candidate) { matched = f; break; }
      }
    }
    if (matched) {
      matched.memberSourceIds.push(o.socialSourceId);
      matched.copyCount += 1;
      matched.authorIds.add(o.socialAuthorId);
      continue;
    }
    // otherwise a new potential origin family
    families.push({
      anchorSourceId: o.socialSourceId,
      normalizedText: o.normalizedText ?? '',
      authorIds: new Set([o.socialAuthorId]),
      memberSourceIds: [o.socialSourceId],
      echoCount: 0,
      copyCount: 0,
    });
  }
  const independentProvenanceCount = families.length;
  return {
    rawPropagationCount,
    independentProvenanceCount,
    families: families.map((f) => ({
      anchorSourceId: f.anchorSourceId,
      memberCount: f.memberSourceIds.length,
      distinctAuthors: f.authorIds.size,
      echoCount: f.echoCount,
      copyCount: f.copyCount,
      kind: f.memberSourceIds.length === 1 ? 'INDEPENDENT'
        : f.echoCount > 0 && f.copyCount === 0 ? 'ECHO'
        : 'UNRESOLVED',
    })),
  };
}

// ---- pump / coordination FEATURE foundation — §14 --------------------------
// Deterministic, measurable features over a bounded window of observations
// about one topic. These are INPUTS for later reasoning (SOCIAL-5 / Socrates),
// never a decision. Anything requiring absent platform metadata is null
// (UNKNOWN), never fabricated. Ratios are in [0,1]; velocities are per-minute.
export function coordinationFeatures(observations) {
  const obs = (Array.isArray(observations) ? observations : []).slice(0, MAX_WINDOW_OBSERVATIONS);
  const n = obs.length;
  const base = {
    messageCount: n,
    uniqueAuthorCount: 0,
    messageVelocityPerMin: null,
    uniqueAuthorVelocityPerMin: null,
    repostRatio: null,
    nearDuplicateRatio: null,
    independentOriginRatio: null,
    burstConcentration: null,
    originatorConcentration: null,
    newAccountRatio: null, // null when account ages are unknown
    verifiedRatio: null, // null when verification metadata absent
    windowMs: 0,
  };
  if (n === 0) return base;
  const authors = new Set(obs.map((o) => o.socialAuthorId));
  base.uniqueAuthorCount = authors.size;
  const times = obs.map((o) => o.knownAtTs ?? o.retrievedTs ?? 0).filter(Number.isFinite);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const windowMs = Math.max(0, tMax - tMin);
  base.windowMs = windowMs;
  const windowMin = windowMs > 0 ? windowMs / 60_000 : null;
  base.messageVelocityPerMin = windowMin ? +(n / windowMin).toFixed(4) : null;
  base.uniqueAuthorVelocityPerMin = windowMin ? +(authors.size / windowMin).toFixed(4) : null;
  const reposts = obs.filter((o) => ECHO_RELATIONS.includes(o.relation)).length;
  base.repostRatio = +(reposts / n).toFixed(4);
  const prov = propagationVsIndependence(obs);
  base.independentOriginRatio = +(prov.independentProvenanceCount / n).toFixed(4);
  const copies = prov.families.reduce((s, f) => s + f.copyCount, 0);
  base.nearDuplicateRatio = +(copies / n).toFixed(4);
  // burst concentration: max share of messages landing in any 60s bucket
  if (times.length > 0) {
    const buckets = new Map();
    for (const t of times) { const b = Math.floor(t / 60_000); buckets.set(b, (buckets.get(b) ?? 0) + 1); }
    base.burstConcentration = +(Math.max(...buckets.values()) / n).toFixed(4);
  }
  // originator concentration: max share of messages from any single author
  const perAuthor = new Map();
  for (const o of obs) perAuthor.set(o.socialAuthorId, (perAuthor.get(o.socialAuthorId) ?? 0) + 1);
  base.originatorConcentration = +(Math.max(...perAuthor.values()) / n).toFixed(4);
  // new-account and verified ratios — only when the metadata is present for
  // EVERY observation; otherwise UNKNOWN (null), never a partial fabrication
  const ages = obs.map(authorAgeMs);
  if (ages.every((a) => a !== null)) {
    const NEW_ACCOUNT_MS = 7 * 24 * 3_600_000; // 7 days — a structural descriptor, not a trade threshold
    base.newAccountRatio = +(ages.filter((a) => a <= NEW_ACCOUNT_MS).length / n).toFixed(4);
  }
  const verifiedFlags = obs.map((o) => o.authorMeta?.verified);
  if (verifiedFlags.every((v) => typeof v === 'boolean')) {
    base.verifiedRatio = +(verifiedFlags.filter(Boolean).length / n).toFixed(4);
  }
  return base;
}

// ---- non-authoritative stage classifier (DARK until SOCIAL-5) — §15 --------
// The stage CONTRACT and its deterministic feature INPUTS exist now; the
// classifier itself stays UNKNOWN because calibrating IGNITION/ACCELERATION/
// CROWDED/DISTRIBUTION/DECAY thresholds requires real history. Emitting a
// stage from arbitrary uncalibrated thresholds is explicitly forbidden (§15).
// This returns a research label with calibrated:false so no downstream layer
// can mistake it for an authoritative signal — and it is NEVER BUY/SELL/REJECT.
export function estimateSocialStage(features) {
  return Object.freeze({
    stage: 'UNKNOWN',
    calibrated: false,
    reason: 'social stage thresholds are not calibrated (deferred to SOCIAL-5); features preserved as inputs only',
    features: features ?? null,
  });
}

// ---- bounded, deterministic, observable universe filter — §24 --------------
// A social stream must NEVER ingest the whole network into durable RUMOR. The
// filter is derived from configured interest terms (coin tickers, cashtags,
// project aliases, exchange names) and an optional watch list of author native
// ids. Matching is deterministic and case-insensitive on whole tokens; a
// cashtag ($BTC) or ticker (BTC) binds only as a standalone token, never a
// substring. The filter is data, so status can report exactly what Serpent was
// listening for. An empty filter matches NOTHING (fail-closed: no silent
// all-network intake).
export function buildSocialFilter({ terms = [], watchAuthorIds = [] } = {}) {
  const tokenTerms = new Set();
  for (const t of Array.isArray(terms) ? terms : []) {
    if (typeof t !== 'string') continue;
    const clean = t.trim().replace(/^\$/, '').toLowerCase();
    if (clean.length >= 2 && clean.length <= 40 && /^[a-z0-9][a-z0-9._-]*$/.test(clean)) tokenTerms.add(clean);
  }
  const watch = new Set((Array.isArray(watchAuthorIds) ? watchAuthorIds : []).filter((a) => isNonEmptyStr(a, MAX_NATIVE_ID_CHARS)));
  return Object.freeze({ tokenTerms: Object.freeze([...tokenTerms]), watchAuthorIds: Object.freeze([...watch]) });
}

// Deterministic match: an author on the watch list always matches; otherwise
// the post text must contain one configured term as a standalone token (a
// leading $ cashtag is normalised away first). Returns { match, reasons }.
export function socialFilterMatches(filter, { text, nativeAuthorId } = {}) {
  const reasons = [];
  if (filter && filter.watchAuthorIds.includes(nativeAuthorId)) reasons.push('watch-author');
  const terms = filter ? filter.tokenTerms : [];
  if (terms.length > 0 && typeof text === 'string' && text.length > 0) {
    const tokens = new Set(text.slice(0, MAX_SOCIAL_TEXT_CHARS).toLowerCase().split(/[^a-z0-9._$-]+/).map((t) => t.replace(/^\$/, '')).filter(Boolean));
    for (const term of terms) if (tokens.has(term)) reasons.push(`term:${term}`);
  }
  return { match: reasons.length > 0, reasons };
}

// ---- author reputation foundation (objective histories only) — §16 ---------
// A durable-friendly, closed record of OBJECTIVE author histories. No "good/
// bad" score, no social-credit — those are learned later (SOCIAL-6) from these
// counts. Provided as a contract shape; SOCIAL-1 does not yet wire it into
// durable checkpoint truth (see doctrine/SOCIAL.md remaining-work).
export function emptyAuthorRecord({ provider, nativeAuthorId }) {
  const socialAuthorId = socialAuthorIdentity({ provider, nativeAuthorId });
  if (!socialAuthorId) return null;
  return {
    socialAuthorId,
    provider,
    firstSeenCount: 0,
    independentOriginCount: 0,
    laterConfirmedCount: 0,
    laterContradictedCount: 0,
    deletedCount: 0,
    copiedCount: 0,
  };
}
