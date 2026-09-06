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
// Version/lifecycle identity. Basis is the provider-native IMMUTABLE version id
// (e.g. a Bluesky record CID) when present, else the content hash. So a
// legitimate EDIT (new cid / new content) is a NEW version, while an altered
// re-delivery of the SAME version (same cid, different payload) collapses to
// the same version id and is caught as corruption by the journal / ear. This
// is deterministic and replay-stable — it never uses wall-clock. (§10/§19/§22)
export function socialVersionIdentity({ socialSourceId, lifecycle, nativeVersionId, textHash }) {
  const basis = typeof nativeVersionId === 'string' && nativeVersionId.length > 0 ? `cid:${nativeVersionId}` : `txt:${textHash ?? ''}`;
  return `r2sv-${contentHash(canonicalJson({ socialSourceId, lifecycle, basis }))}`;
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
const REQUIRED_RAW = ['provider', 'providerKind', 'nativePostId', 'nativeAuthorId', 'text', 'sourceCreatedTs'];
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
  // an echo/reply/quote must name the parent it derives from
  const parentNativePostId = raw.parentNativePostId ?? null;
  if (parentNativePostId !== null && !isNonEmptyStr(parentNativePostId, MAX_NATIVE_ID_CHARS)) return { reject: true, reason: 'parentNativePostId invalid' };
  if ((relation === 'REPOST' || relation === 'QUOTE' || relation === 'REPLY' || relation === 'CROSSPOST') && parentNativePostId === null)
    return { reject: true, reason: `${relation} without a parent native id` };
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
  // point-in-time: creation must be a finite ms; future creation (beyond now)
  // fails closed — a source clock cannot postdate our retrieval. (§7/§42)
  const created = raw.sourceCreatedTs;
  if (!Number.isFinite(created)) return { reject: true, reason: 'sourceCreatedTs not finite' };
  const clocks = socialClocks({ sourceCreatedTs: created, nowMs });
  if (clocks.sourceCreatedTs > clocks.retrievedTs) return { reject: true, reason: 'sourceCreatedTs after retrieval — future clock' };
  // engagement is PROPAGATION metadata only (never confirmation) — bounded ints or null
  const engagement = normalizeEngagement(raw.engagement);
  if (engagement === undefined) return { reject: true, reason: 'engagement invalid' };
  // author metadata where legitimately available — else null; never fabricated
  const authorMeta = normalizeAuthorMeta(raw.authorMeta, clocks.retrievedTs);
  if (authorMeta === undefined) return { reject: true, reason: 'authorMeta invalid' };
  const { normalized, hash } = textFingerprint(raw.text);
  const socialSourceId = socialSourceIdentity({ provider, nativePostId });
  const socialAuthorId = socialAuthorIdentity({ provider, nativeAuthorId });
  if (!socialSourceId || !socialAuthorId) return { reject: true, reason: 'identity derivation failed' };
  // a bounded deterministic hash of the immutable native metadata — lets a
  // re-delivery with altered facts be detected as corruption downstream
  const metaHash = contentHash(canonicalJson({
    provider, providerKind, nativePostId, nativeAuthorId, relation, parentNativePostId,
    sourceCreatedTs: clocks.sourceCreatedTs, textHash: hash, editState, nativeVersionId,
  }));
  const lifecycle = lifecycleForEditState(editState);
  const socialVersionId = socialVersionIdentity({ socialSourceId, lifecycle, nativeVersionId, textHash: hash });
  return {
    ok: true,
    observation: Object.freeze({
      provider, providerKind, nativePostId, nativeAuthorId,
      socialSourceId, socialAuthorId, handle, displayName,
      text: raw.text, normalizedText: normalized, textHash: hash,
      canonicalUrl, threadId, parentNativePostId, relation, editState, lifecycle,
      nativeVersionId, socialVersionId,
      sourceCreatedTs: clocks.sourceCreatedTs, retrievedTs: clocks.retrievedTs, knownAtTs: clocks.knownAtTs,
      engagement, authorMeta, metaHash,
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

function normalizeAuthorMeta(m, retrievedTs) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object' || Array.isArray(m)) return undefined;
  const followerCount = m.followerCount ?? null;
  if (followerCount !== null && (!Number.isSafeInteger(followerCount) || followerCount < 0)) return undefined;
  const accountCreatedTs = m.accountCreatedTs ?? null;
  if (accountCreatedTs !== null && (!Number.isFinite(accountCreatedTs) || accountCreatedTs > retrievedTs)) return undefined;
  const verified = m.verified ?? null;
  if (verified !== null && typeof verified !== 'boolean') return undefined;
  return Object.freeze({ followerCount, accountCreatedTs, verified });
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
