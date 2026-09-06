// SOCIAL-1 closeout — the durable social event bridge. A normalized social
// observation settles as a CLOSED, VALIDATED RUMOR2_SOCIAL_OBSERVED event that
// rides the SAME frozen PostgreSQL RUMOR journal, under the SAME advisory-lock
// writer + database writer epoch (§6/§34/§35). No parallel engine, no parallel
// table, no social-specific checkpoint.
//
// Why a dedicated social event and not the generic RUMOR2_SOURCE_OBSERVED:
// the generic source event is a CLOSED 11-key schema that would silently drop
// author identity, repost/reply/quote relationships, thread identity, native
// version/CID, and lifecycle (edit/delete) — exactly the provenance SOCIAL-5
// will need. Rather than loosen the frozen non-social event (which would touch
// frozen semantics), social evidence gets its OWN closed, versioned event and
// its OWN closed validator, living entirely in the social layer. The frozen
// truth.js validators are untouched. This event is EVIDENCE ONLY: it carries a
// non-claim-capable providerKind and can never mint a claim, packet, or trade.
//
// Post identity vs version (§10): socialSourceId is the STABLE post identity;
// sourceEventId is the VERSION identity (a distinct CREATE/EDIT/DELETE/TOMBSTONE
// event). A legitimate edit is a new version; an altered re-delivery of the same
// version is corruption (caught by the journal's identity/payload law).
import { contentHash, canonicalJson } from './truth.js';
import {
  socialSourceIdentity, socialAuthorIdentity, socialVersionIdentity, socialMetaHash,
  normalizeSocialText, SOCIAL_RELATION_KINDS, ECHO_RELATIONS, SOCIAL_LIFECYCLE_STATES,
  R2SS_RE, R2SA_RE, R2SV_RE, MAX_SOCIAL_TEXT_CHARS, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_HANDLE_CHARS,
  SOURCE_CLOCK_STATES, classifySourceClock, canonicalIngressTags, MAX_INGRESS_TAGS, MAX_INGRESS_TAG_CHARS,
} from './social.js';
import { socialProviderById } from './social-registry.js';

export const SOCIAL_EVENT_TYPE = 'RUMOR2_SOCIAL_OBSERVED';

// the CLOSED durable schema — no undeclared field ever enters the journal.
// handle + authorMeta + engagement are Serpent's FIRST-KNOWN mutable DIAGNOSTIC
// snapshot (bound by metaHash, §5/§18/§26); every other field is immutable
// content/provenance (bound by sourceEventId, §4/§26).
export const SOCIAL_EVENT_KEYS = Object.freeze([
  'type', 'ts', 'sourceEventId', 'provider', 'providerKind',
  'socialSourceId', 'nativePostId', 'nativeAuthorId', 'socialAuthorId',
  'lifecycle', 'relation', 'parentNativePostId', 'threadId', 'nativeVersionId', 'providerEventSeq', 'handle',
  'text', 'textHash', 'metaHash', 'engagement', 'authorMeta',
  // SOURCE-CLOCK QUARANTINE SEAL (§14): declared vs trusted source clock, the
  // closed clock verdict + bounded skew diagnostic, and the provider event clock
  'sourceDeclaredTs', 'sourceCreatedTs', 'sourceClockStatus', 'sourceClockSkewMs', 'providerEventTs',
  'ingressTags', // SOCIAL-2B: bounded first-known provider admission tags (diagnostic only)
  'retrievedTs', 'knownAtTs',
]);

// SOCIAL-2A: providers whose adapter supplies a native commit/event sequence.
// Any other social provider MUST carry providerEventSeq = null — a seq is never
// invented, and a caller-created integer cannot authenticate a foreign event.
export const PROVIDER_EVENT_SEQ_PROVIDERS = Object.freeze(['BLUESKY_OFFICIAL']);

// SOCIAL-2A: the CLOSED source-only operational progress event that rides the
// SAME journal — the durable Social resume cursor. It is appended LAST in the
// same atomic batch as the evidence it follows, so the cursor can never outrun
// settled evidence (§14-§16). Deterministic identity per (provider, cursor):
// a legitimate re-append after a crash is byte-identical (the batch is
// retained whole and retried), never a new payload under the same identity.
export const SOCIAL_CURSOR_EVENT_TYPE = 'RUMOR2_SOCIAL_CURSOR';
export const SOCIAL_CURSOR_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'durableCursor', 'knownAtTs']);
export const R2SC_RE = /^r2sc-[0-9a-f]{40}$/;
// SOCIAL-2B: the CLOSED source-only X operational events — all ride the SAME
// journal under the SAME writer epoch, none carries authority:
//   RUMOR2_SOCIAL_X_RULESET  — which Serpent-owned rule set (hash) was active from
//                              activatedKnownAtTs, under which coverage epoch
//   RUMOR2_SOCIAL_X_METER    — the conservative local cost meter: cumulative
//                              delivered Post reads per UTC day + month, at the
//                              pinned unit price, plus the latest server usage
//   RUMOR2_SOCIAL_X_PROGRESS — the durable continuity watermark: every stream
//                              line received through throughKnownAtTs reached a
//                              terminal state under this coverage epoch
//   RUMOR2_SOCIAL_X_GAP      — an explicit coverage gap (budget stop, operator
//                              stop, unexplained gap, writer loss …): coverage
//                              was ABSENT from gapStartTs; never false continuity
export const X_RULESET_EVENT_TYPE = 'RUMOR2_SOCIAL_X_RULESET';
export const X_METER_EVENT_TYPE = 'RUMOR2_SOCIAL_X_METER';
export const X_PROGRESS_EVENT_TYPE = 'RUMOR2_SOCIAL_X_PROGRESS';
export const X_GAP_EVENT_TYPE = 'RUMOR2_SOCIAL_X_GAP';
export const X_RULESET_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'ruleSetHash', 'ruleTags', 'ruleCount', 'coverageEpoch', 'activatedKnownAtTs', 'knownAtTs']);
export const X_METER_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'period', 'deliveredPostReads', 'monthPeriod', 'monthDeliveredPostReads', 'unitPriceUsd', 'estimatedUsd', 'serverUsage', 'knownAtTs']);
export const X_PROGRESS_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'ruleSetHash', 'coverageEpoch', 'throughKnownAtTs', 'knownAtTs']);
export const X_GAP_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'ruleSetHash', 'coverageEpoch', 'gapStartTs', 'reason', 'knownAtTs']);
export const X_GAP_REASONS = Object.freeze(['BUDGET_DAILY', 'BUDGET_MONTHLY', 'BUDGET_USD', 'BUDGET_SESSION', 'NO_CREDITS', 'OPERATOR_DISABLED', 'USAGE_PREFLIGHT_FAILED', 'RULE_RECONCILE_FAILED', 'UNEXPLAINED_GAP', 'WRITER_LOST', 'CONNECTION_LIMIT', 'AUTH_REJECTED', 'TRANSPORT_FAILED']);
export const X_STATE_PROVIDERS = Object.freeze(['X_OFFICIAL']);
export const SOCIAL_EVENT_TYPES = Object.freeze([SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE, X_GAP_EVENT_TYPE]);
export const xRuleSetIdentity = ({ provider, ruleSetHash, coverageEpoch }) => `r2xr-${contentHash(canonicalJson({ provider, ruleSetHash, coverageEpoch }))}`;
// a meter snapshot is identified by its counts AND its knowledge clock: two
// snapshots with equal counts but a newer server-usage observation are distinct
// observations, while a byte-identical crash retry keeps the same clock
export const xMeterIdentity = ({ provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, knownAtTs }) => `r2xm-${contentHash(canonicalJson({ provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, knownAtTs }))}`;
export const xProgressIdentity = ({ provider, coverageEpoch, throughKnownAtTs }) => `r2xp-${contentHash(canonicalJson({ provider, coverageEpoch, throughKnownAtTs }))}`;
export const xGapIdentity = ({ provider, coverageEpoch, gapStartTs, reason }) => `r2xg-${contentHash(canonicalJson({ provider, coverageEpoch, gapStartTs, reason }))}`;
export const isSocialEventType = (t) => SOCIAL_EVENT_TYPES.includes(t);
export const socialCursorIdentity = ({ provider, durableCursor }) => `r2sc-${contentHash(canonicalJson({ provider, durableCursor }))}`;

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isTs = (v) => Number.isSafeInteger(v);
const iso = (ms) => new Date(ms).toISOString();

// Build the durable event from a normalized observation. sourceEventId is the
// version identity, so the journal collapses exact re-appends and rejects an
// altered re-delivery of the same version, while an edit is a new version.
export function socialObservationToEvent(observation) {
  const event = {
    type: SOCIAL_EVENT_TYPE,
    ts: iso(observation.knownAtTs),
    sourceEventId: observation.socialVersionId,
    provider: observation.provider,
    providerKind: observation.providerKind,
    socialSourceId: observation.socialSourceId,
    nativePostId: observation.nativePostId,
    nativeAuthorId: observation.nativeAuthorId,
    socialAuthorId: observation.socialAuthorId,
    lifecycle: observation.lifecycle,
    relation: observation.relation,
    parentNativePostId: observation.parentNativePostId ?? null,
    threadId: observation.threadId ?? null,
    nativeVersionId: observation.nativeVersionId ?? null,
    providerEventSeq: observation.providerEventSeq ?? null,
    handle: observation.handle ?? null,
    text: observation.text,
    textHash: observation.textHash,
    metaHash: observation.metaHash,
    // §13: FIRST-KNOWN engagement snapshot only — diagnostic propagation
    // metadata, never confirmation, never trade authority. Later mutation is a
    // separate concern (a future versioned SOCIAL_METRICS event), never a
    // mutation of this immutable observation.
    engagement: observation.engagement ?? null,
    // §16-§21: FIRST-KNOWN closed author metadata — information-only research
    // context (new-account/follower/coordination analysis), never identity,
    // never claim/trade authority. Retained through the journal + witness so
    // SOCIAL-5/6 need not reconstruct facts SOCIAL-1 already knew.
    authorMeta: observation.authorMeta ?? null,
    sourceDeclaredTs: observation.sourceDeclaredTs ?? null,
    sourceCreatedTs: observation.sourceCreatedTs,
    sourceClockStatus: observation.sourceClockStatus ?? 'UNKNOWN',
    sourceClockSkewMs: observation.sourceClockSkewMs ?? null,
    providerEventTs: observation.providerEventTs ?? null,
    ingressTags: canonicalIngressTags(observation.ingressTags),
    retrievedTs: observation.retrievedTs,
    knownAtTs: observation.knownAtTs,
  };
  return { event, socialSourceId: observation.socialSourceId, socialAuthorId: observation.socialAuthorId, versionId: observation.socialVersionId };
}

const exactKeys = (obj, allowed) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `undeclared field '${k}'`;
  for (const k of allowed) if (!(k in obj)) return `missing field '${k}'`;
  return null;
};

const okEngagement = (e) => {
  if (e === null) return true;
  if (typeof e !== 'object' || Array.isArray(e)) return false;
  for (const [k, v] of Object.entries(e)) {
    if (!['likes', 'reposts', 'replies', 'quotes', 'views', 'upvotes'].includes(k)) return false;
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) return false;
  }
  return true;
};

// CLOSED author-metadata shape (§16): null, or an object whose keys are a subset
// of the five bounded diagnostic fields, each null or the right bounded type. No
// unbounded provider blob, no fake zero/false. accountCreatedTs (when known)
// cannot postdate retrieval. The stored snapshot's integrity is additionally
// bound by metaHash, so a silent post-storage rewrite is rejected (§18/§25).
const okAuthorMeta = (m, retrievedTs) => {
  if (m === null) return true;
  if (typeof m !== 'object' || Array.isArray(m)) return false;
  for (const [k, v] of Object.entries(m)) {
    if (!['accountCreatedTs', 'followerCount', 'followingCount', 'verified', 'powerBadge'].includes(k)) return false;
    if (v === null) continue;
    if (k === 'verified' || k === 'powerBadge') { if (typeof v !== 'boolean') return false; continue; }
    if (!Number.isSafeInteger(v) || v < 0) return false;
    if (k === 'accountCreatedTs' && v > retrievedTs) return false;
  }
  return true;
};

// CLOSED validation of a durable social event. Every derivable identity is
// RE-DERIVED (never trusted from its shape): a syntactically valid but forged
// r2ss-/r2sa-/r2sv- id dies here. `socialProviderIds` (from the social
// registry) pins the provider set; providerKind must match the registry so a
// social event can never claim a claim-capable kind. (§9/§15/§22)
export function validateSocialEvent(event, { socialProviderIds = null } = {}) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return 'social event: not an object';
  const kErr = exactKeys(event, SOCIAL_EVENT_KEYS);
  if (kErr) return `social event: ${kErr}`;
  if (event.type !== SOCIAL_EVENT_TYPE) return 'social event: wrong type';
  if (!isStr(event.provider, 100)) return 'social event: provider invalid';
  // AUTHORITATIVE registry, CLOSED BY DEFAULT (§13): the provider MUST exist in
  // the social registry and its kind MUST match — validation never depends on a
  // caller remembering to pass an allowlist. An optional caller list may only
  // NARROW this authoritative set; it can NEVER authorize an unregistered
  // provider (authoritative ∩ optional, never optional-replaces-authoritative).
  const meta = socialProviderById(event.provider);
  if (!meta) return `social event: ${event.provider} is not in the authoritative social registry`;
  if (event.providerKind !== meta.providerKind) return 'social event: providerKind disagrees with the social registry';
  if (socialProviderIds && !socialProviderIds.includes(event.provider)) return `social event: ${event.provider} excluded by the caller narrowing allowlist`;
  if (!isStr(event.nativePostId, MAX_NATIVE_ID_CHARS)) return 'social event: nativePostId invalid';
  if (!isStr(event.nativeAuthorId, MAX_NATIVE_ID_CHARS)) return 'social event: nativeAuthorId invalid';
  // identities RE-DERIVED from immutable facts — forged ids die here
  if (!R2SS_RE.test(event.socialSourceId) || event.socialSourceId !== socialSourceIdentity({ provider: event.provider, nativePostId: event.nativePostId }))
    return 'social event: socialSourceId is not the derived post identity';
  if (!R2SA_RE.test(event.socialAuthorId) || event.socialAuthorId !== socialAuthorIdentity({ provider: event.provider, nativeAuthorId: event.nativeAuthorId }))
    return 'social event: socialAuthorId is not the derived author identity';
  if (!SOCIAL_LIFECYCLE_STATES.includes(event.lifecycle)) return 'social event: unknown lifecycle';
  if (event.nativeVersionId !== null && !isStr(event.nativeVersionId, MAX_NATIVE_ID_CHARS)) return 'social event: nativeVersionId invalid';
  // SOCIAL-2A provider event sequence (§13): null, or a non-negative safe
  // integer ONLY for a provider whose adapter supplies one; never invented.
  if (event.providerEventSeq !== null) {
    if (!Number.isSafeInteger(event.providerEventSeq) || event.providerEventSeq < 0) return 'social event: providerEventSeq invalid';
    if (!PROVIDER_EVENT_SEQ_PROVIDERS.includes(event.provider)) return 'social event: providerEventSeq not applicable to this provider';
  }
  if (typeof event.text !== 'string' || event.text.length > MAX_SOCIAL_TEXT_CHARS) return 'social event: text invalid';
  if (event.textHash !== contentHash(normalizeSocialText(event.text))) return 'social event: textHash is not the derived content hash';
  if (!SOCIAL_RELATION_KINDS.includes(event.relation)) return 'social event: unknown relation';
  if (event.parentNativePostId !== null && !isStr(event.parentNativePostId, MAX_NATIVE_ID_CHARS)) return 'social event: parentNativePostId invalid';
  // lifecycle-aware relationship law (§19): CREATE/EDIT echoes need a parent and
  // an ORIGINAL forbids one; a DELETE/TOMBSTONE may legitimately omit both.
  const deletion = event.lifecycle === 'DELETE' || event.lifecycle === 'TOMBSTONE';
  if (!deletion) {
    if ((ECHO_RELATIONS.includes(event.relation) || event.relation === 'REPLY') && event.parentNativePostId === null)
      return `social event: ${event.relation} without a parent`;
    if (event.relation === 'ORIGINAL' && event.parentNativePostId !== null) return 'social event: ORIGINAL relation cannot carry a parent';
  }
  if (event.threadId !== null && !isStr(event.threadId, MAX_NATIVE_ID_CHARS)) return 'social event: threadId invalid';
  if (event.handle !== null && !isStr(event.handle, MAX_SOCIAL_HANDLE_CHARS)) return 'social event: handle invalid';
  // SOURCE-CLOCK QUARANTINE LAW (§5-§11): retrieved/known are Serpent's
  // acquisition truth (knownAt never backdated); sourceDeclaredTs is the exact
  // provider-record clock or null; the stored verdict must be EXACTLY what
  // re-classifying the declared clock against retrievedTs yields — a forged
  // TRUSTED over a future clock, a fabricated sourceCreatedTs, or a rewritten
  // skew all die here. providerEventTs is a separate finite ms or null.
  if (!isTs(event.retrievedTs) || !isTs(event.knownAtTs)) return 'social event: clock invalid';
  if (event.retrievedTs > event.knownAtTs) return 'social event: retrieved after known';
  if (event.sourceDeclaredTs !== null && !isTs(event.sourceDeclaredTs)) return 'social event: sourceDeclaredTs invalid';
  if (event.sourceCreatedTs !== null && !isTs(event.sourceCreatedTs)) return 'social event: sourceCreatedTs invalid';
  if (!SOURCE_CLOCK_STATES.includes(event.sourceClockStatus)) return 'social event: sourceClockStatus unknown';
  if (event.sourceClockSkewMs !== null && (!isTs(event.sourceClockSkewMs) || event.sourceClockSkewMs <= 0)) return 'social event: sourceClockSkewMs invalid';
  {
    const c = classifySourceClock({ sourceDeclaredTs: event.sourceDeclaredTs, retrievedTs: event.retrievedTs });
    if (c.sourceClockStatus !== event.sourceClockStatus) return 'social event: sourceClockStatus is not the re-derived verdict for the declared clock';
    if (c.sourceCreatedTs !== event.sourceCreatedTs) return 'social event: sourceCreatedTs disagrees with the trusted-clock law';
    if (c.sourceClockSkewMs !== event.sourceClockSkewMs) return 'social event: sourceClockSkewMs is not the re-derived skew';
  }
  if (event.providerEventTs !== null && !isTs(event.providerEventTs)) return 'social event: providerEventTs invalid';
  // SOCIAL-2B ingress tags: a bounded, sorted, unique closed list — canonical form only
  if (!Array.isArray(event.ingressTags) || event.ingressTags.length > MAX_INGRESS_TAGS) return 'social event: ingressTags invalid';
  for (const t of event.ingressTags) if (typeof t !== 'string' || t.length === 0 || t.length > MAX_INGRESS_TAG_CHARS) return 'social event: ingressTags invalid';
  if (canonicalJson(canonicalIngressTags(event.ingressTags)) !== canonicalJson(event.ingressTags)) return 'social event: ingressTags not in canonical sorted-unique form';
  if (event.ts !== iso(event.knownAtTs)) return 'social event: ts disagrees with knownAtTs';
  if (!okEngagement(event.engagement)) return 'social event: engagement invalid';
  if (!okAuthorMeta(event.authorMeta, event.retrievedTs)) return 'social event: authorMeta invalid';
  if (!/^[0-9a-f]{40}$/.test(event.metaHash)) return 'social event: metaHash malformed';
  // TWO hashes, re-derived from the ONE canonical fact set (§4/§5/§6/§26):
  //   sourceEventId  = CONTENT/VERSION identity — immutable content/provenance
  //     facts ONLY (relation, parent, thread, native version, text, lifecycle,
  //     source time). A change there produces a legitimately re-derived NEW
  //     version id or is rejected here.
  //   metaHash       = DIAGNOSTIC/META hash — the first-known mutable snapshot
  //     (handle, authorMeta, engagement). A silent post-storage rewrite of any
  //     stored diagnostic is rejected here, but a later live redelivery with
  //     changed diagnostics is neither a new version nor corruption.
  const facts = {
    provider: event.provider, providerKind: event.providerKind, nativePostId: event.nativePostId,
    nativeAuthorId: event.nativeAuthorId, lifecycle: event.lifecycle, relation: event.relation,
    parentNativePostId: event.parentNativePostId, threadId: event.threadId, nativeVersionId: event.nativeVersionId,
    providerEventSeq: event.providerEventSeq, textHash: event.textHash, sourceDeclaredTs: event.sourceDeclaredTs,
    handle: event.handle, authorMeta: event.authorMeta, engagement: event.engagement,
    sourceClockStatus: event.sourceClockStatus, sourceClockSkewMs: event.sourceClockSkewMs, providerEventTs: event.providerEventTs,
    retrievedTs: event.retrievedTs, knownAtTs: event.knownAtTs, // first-known acquisition clocks are diagnostic-bound (Job A)
    ingressTags: event.ingressTags,
    socialSourceId: event.socialSourceId,
  };
  if (event.metaHash !== socialMetaHash(facts)) return 'social event: metaHash is not the re-derived diagnostic hash';
  if (!R2SV_RE.test(event.sourceEventId) || event.sourceEventId !== socialVersionIdentity(facts))
    return 'social event: sourceEventId is not the derived version identity';
  return null;
}

// Reconstruct the canonical social provenance witness from a durable event —
// what replay hands SOCIAL-5. No important identity/relationship/version/
// lifecycle fact is lost across the journal boundary. (§16)
export function reconstructSocialWitness(event) {
  return {
    socialSourceId: event.socialSourceId,
    socialAuthorId: event.socialAuthorId,
    provider: event.provider,
    providerKind: event.providerKind,
    nativePostId: event.nativePostId,
    nativeAuthorId: event.nativeAuthorId,
    lifecycle: event.lifecycle,
    relation: event.relation,
    parentNativePostId: event.parentNativePostId,
    threadId: event.threadId,
    nativeVersionId: event.nativeVersionId,
    providerEventSeq: event.providerEventSeq ?? null,
    versionId: event.sourceEventId,
    handle: event.handle,
    text: event.text,
    // the three clocks, explicit (SOURCE-CLOCK QUARANTINE SEAL): declared
    // (provider record), trusted (null when quarantined/unknown), verdict + skew,
    // provider event clock, and Serpent's acquisition clocks
    sourceDeclaredTs: event.sourceDeclaredTs ?? null,
    sourceCreatedTs: event.sourceCreatedTs,
    sourceClockStatus: event.sourceClockStatus ?? 'UNKNOWN',
    sourceClockSkewMs: event.sourceClockSkewMs ?? null,
    providerEventTs: event.providerEventTs ?? null,
    ingressTags: event.ingressTags ?? [],
    retrievedTs: event.retrievedTs,
    knownAtTs: event.knownAtTs,
    engagement: event.engagement,
    // first-known author metadata survives the journal exactly (§20/§21) —
    // information-only research context, never identity or trade authority
    authorMeta: event.authorMeta ?? null,
  };
}

// ---- SOCIAL-2A durable cursor event + social history replay ---------------
// Build the cursor event for a settled batch. ts is the batch's knowledge
// clock, fixed when the batch is formed and retained verbatim on retry.
export function socialCursorEvent({ provider, durableCursor, knownAtTs }) {
  return {
    type: SOCIAL_CURSOR_EVENT_TYPE,
    ts: iso(knownAtTs),
    sourceEventId: socialCursorIdentity({ provider, durableCursor }),
    provider,
    durableCursor,
    knownAtTs,
  };
}

export function validateSocialCursorEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return 'social cursor: not an object';
  const kErr = exactKeys(event, SOCIAL_CURSOR_EVENT_KEYS);
  if (kErr) return `social cursor: ${kErr}`;
  if (event.type !== SOCIAL_CURSOR_EVENT_TYPE) return 'social cursor: wrong type';
  if (!isStr(event.provider, 100) || !socialProviderById(event.provider)) return 'social cursor: provider not in the authoritative social registry';
  if (!PROVIDER_EVENT_SEQ_PROVIDERS.includes(event.provider)) return 'social cursor: provider has no cursor domain';
  if (!Number.isSafeInteger(event.durableCursor) || event.durableCursor < 0) return 'social cursor: durableCursor invalid';
  if (!isTs(event.knownAtTs)) return 'social cursor: clock invalid';
  if (event.ts !== iso(event.knownAtTs)) return 'social cursor: ts disagrees with knownAtTs';
  if (!R2SC_RE.test(event.sourceEventId) || event.sourceEventId !== socialCursorIdentity({ provider: event.provider, durableCursor: event.durableCursor }))
    return 'social cursor: sourceEventId is not the derived cursor identity';
  return null;
}

// ---- SOCIAL-2B X operational events ----------------------------------------
const okHash = (h) => typeof h === 'string' && /^[0-9a-f]{40}$/.test(h);
const okEpoch = (e) => Number.isSafeInteger(e) && e >= 1;
const okPeriod = (p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p);
const okMonth = (p) => typeof p === 'string' && /^\d{4}-\d{2}$/.test(p);
const xProvider = (ev) => (X_STATE_PROVIDERS.includes(ev.provider) && socialProviderById(ev.provider) ? null : 'provider is not an X-state provider');

export function xRuleSetEvent({ provider, ruleSetHash, ruleTags, coverageEpoch, activatedKnownAtTs, knownAtTs }) {
  const tags = [...new Set(ruleTags)].sort();
  return { type: X_RULESET_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xRuleSetIdentity({ provider, ruleSetHash, coverageEpoch }), provider, ruleSetHash, ruleTags: tags, ruleCount: tags.length, coverageEpoch, activatedKnownAtTs, knownAtTs };
}
export function validateXRuleSetEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x ruleset: not an object';
  const k = exactKeys(ev, X_RULESET_EVENT_KEYS); if (k) return `x ruleset: ${k}`;
  if (ev.type !== X_RULESET_EVENT_TYPE) return 'x ruleset: wrong type';
  const pe = xProvider(ev); if (pe) return `x ruleset: ${pe}`;
  if (!okHash(ev.ruleSetHash)) return 'x ruleset: ruleSetHash malformed';
  if (!Array.isArray(ev.ruleTags) || ev.ruleTags.length > 1000 || ev.ruleTags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_INGRESS_TAG_CHARS)) return 'x ruleset: ruleTags invalid';
  if (canonicalJson([...new Set(ev.ruleTags)].sort()) !== canonicalJson(ev.ruleTags)) return 'x ruleset: ruleTags not canonical';
  if (ev.ruleCount !== ev.ruleTags.length) return 'x ruleset: ruleCount disagrees';
  if (!okEpoch(ev.coverageEpoch)) return 'x ruleset: coverageEpoch invalid';
  if (!isTs(ev.activatedKnownAtTs) || !isTs(ev.knownAtTs) || ev.activatedKnownAtTs > ev.knownAtTs) return 'x ruleset: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x ruleset: ts disagrees with knownAtTs';
  if (ev.sourceEventId !== xRuleSetIdentity(ev)) return 'x ruleset: sourceEventId is not the derived identity';
  return null;
}
export function xMeterEvent({ provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, unitPriceUsd, serverUsage = null, knownAtTs }) {
  const estimatedUsd = Math.round(monthDeliveredPostReads * unitPriceUsd * 1e6) / 1e6;
  return { type: X_METER_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xMeterIdentity({ provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, knownAtTs }), provider, period, deliveredPostReads, monthPeriod, monthDeliveredPostReads, unitPriceUsd, estimatedUsd, serverUsage, knownAtTs };
}
const okServerUsage = (u) => {
  if (u === null) return true;
  if (u === undefined || typeof u !== 'object' || Array.isArray(u)) return false;
  const k = exactKeys(u, ['projectUsage', 'projectCap', 'capResetDay', 'dailyProjectUsage', 'observedTs']); if (k) return false;
  for (const f of ['projectUsage', 'projectCap']) if (!Number.isSafeInteger(u[f]) || u[f] < 0) return false;
  if (u.capResetDay !== null && (!Number.isSafeInteger(u.capResetDay) || u.capResetDay < 1 || u.capResetDay > 31)) return false;
  if (u.dailyProjectUsage !== null && (!Number.isSafeInteger(u.dailyProjectUsage) || u.dailyProjectUsage < 0)) return false;
  return isTs(u.observedTs);
};
export function validateXMeterEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x meter: not an object';
  const k = exactKeys(ev, X_METER_EVENT_KEYS); if (k) return `x meter: ${k}`;
  if (ev.type !== X_METER_EVENT_TYPE) return 'x meter: wrong type';
  const pe = xProvider(ev); if (pe) return `x meter: ${pe}`;
  if (!okPeriod(ev.period) || !okMonth(ev.monthPeriod) || !ev.period.startsWith(ev.monthPeriod)) return 'x meter: period invalid';
  for (const f of ['deliveredPostReads', 'monthDeliveredPostReads']) if (!Number.isSafeInteger(ev[f]) || ev[f] < 0) return `x meter: ${f} invalid`;
  if (ev.deliveredPostReads > ev.monthDeliveredPostReads) return 'x meter: day exceeds month';
  if (!Number.isFinite(ev.unitPriceUsd) || ev.unitPriceUsd < 0) return 'x meter: unitPriceUsd invalid';
  if (ev.estimatedUsd !== Math.round(ev.monthDeliveredPostReads * ev.unitPriceUsd * 1e6) / 1e6) return 'x meter: estimatedUsd is not the re-derived estimate';
  if (!okServerUsage(ev.serverUsage)) return 'x meter: serverUsage invalid';
  if (!isTs(ev.knownAtTs) || ev.ts !== iso(ev.knownAtTs)) return 'x meter: clock invalid';
  if (ev.sourceEventId !== xMeterIdentity(ev)) return 'x meter: sourceEventId is not the derived identity';
  return null;
}
export function xProgressEvent({ provider, ruleSetHash, coverageEpoch, throughKnownAtTs, knownAtTs }) {
  return { type: X_PROGRESS_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xProgressIdentity({ provider, coverageEpoch, throughKnownAtTs }), provider, ruleSetHash, coverageEpoch, throughKnownAtTs, knownAtTs };
}
export function validateXProgressEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x progress: not an object';
  const k = exactKeys(ev, X_PROGRESS_EVENT_KEYS); if (k) return `x progress: ${k}`;
  if (ev.type !== X_PROGRESS_EVENT_TYPE) return 'x progress: wrong type';
  const pe = xProvider(ev); if (pe) return `x progress: ${pe}`;
  if (!okHash(ev.ruleSetHash) || !okEpoch(ev.coverageEpoch)) return 'x progress: ruleSetHash/coverageEpoch invalid';
  if (!isTs(ev.throughKnownAtTs) || !isTs(ev.knownAtTs) || ev.throughKnownAtTs > ev.knownAtTs) return 'x progress: watermark cannot exceed its own knowledge clock';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x progress: ts disagrees with knownAtTs';
  if (ev.sourceEventId !== xProgressIdentity(ev)) return 'x progress: sourceEventId is not the derived identity';
  return null;
}
export function xGapEvent({ provider, ruleSetHash, coverageEpoch, gapStartTs, reason, knownAtTs }) {
  return { type: X_GAP_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xGapIdentity({ provider, coverageEpoch, gapStartTs, reason }), provider, ruleSetHash, coverageEpoch, gapStartTs, reason, knownAtTs };
}
export function validateXGapEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x gap: not an object';
  const k = exactKeys(ev, X_GAP_EVENT_KEYS); if (k) return `x gap: ${k}`;
  if (ev.type !== X_GAP_EVENT_TYPE) return 'x gap: wrong type';
  const pe = xProvider(ev); if (pe) return `x gap: ${pe}`;
  if (!okHash(ev.ruleSetHash) || !okEpoch(ev.coverageEpoch)) return 'x gap: ruleSetHash/coverageEpoch invalid';
  if (!X_GAP_REASONS.includes(ev.reason)) return 'x gap: unknown reason';
  if (!isTs(ev.gapStartTs) || !isTs(ev.knownAtTs) || ev.gapStartTs > ev.knownAtTs) return 'x gap: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x gap: ts disagrees with knownAtTs';
  if (ev.sourceEventId !== xGapIdentity(ev)) return 'x gap: sourceEventId is not the derived identity';
  return null;
}
export const emptyXState = () => ({ ruleSetHash: null, coverageEpoch: 0, activatedKnownAtTs: null, ruleTags: [], progressThroughTs: null, meter: null, lastGap: null, events: 0 });

// Replay the Social layer of one journal history (§22-§24). SOURCE-ONLY: this
// pass rebuilds ONLY (a) the durable version index — every settled
// RUMOR2_SOCIAL_OBSERVED sourceEventId, the authority for keep-first dedupe
// across restarts and local eviction — and (b) the durable resume cursor per
// provider. It feeds no graph, claim, packet, Attention, or trade state.
// Fail-closed: every social event is re-validated (unknown provider, kind
// mismatch, forged identity, tampered diagnostics), the duplicate law holds
// inside social history (same identity + altered payload = corruption), and a
// cursor regression (500, 600, 550) is refused; an inclusive repeat of the
// SAME cursor is lawful at-least-once replay. Non-social events are ignored
// here — the frozen replay owns them.
export function replaySocialHistory(events) {
  const fail = (msg) => ({ ok: false, error: String(msg).slice(0, 300) });
  if (!Array.isArray(events)) return fail('SOCIAL_HISTORY_INVALID: history is not a list');
  const durableIds = new Set();
  const digests = new Map(); // sourceEventId -> canonical digest (duplicate law)
  const cursors = {}; // provider -> durableCursor
  let observed = 0;
  let cursorEvents = 0;
  const x = emptyXState(); // SOCIAL-2B X operational state (source-only)
  const xDigests = new Map();
  const xDup = (e, err) => {
    if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
    const d = contentHash(canonicalJson(e));
    const prior = xDigests.get(`${e.type}|${e.sourceEventId}`);
    if (prior !== undefined) return prior === d ? 'dup' : fail('SOCIAL_HISTORY_INVALID: duplicate X event identity with an altered payload — corruption, not replay');
    xDigests.set(`${e.type}|${e.sourceEventId}`, d);
    return null;
  };
  for (const e of events) {
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string') return fail('SOCIAL_HISTORY_INVALID: malformed event record');
    if (e.type === SOCIAL_EVENT_TYPE) {
      const err = validateSocialEvent(e);
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const digest = contentHash(canonicalJson(e));
      const prior = digests.get(e.sourceEventId);
      if (prior !== undefined) {
        if (prior !== digest) return fail('SOCIAL_HISTORY_INVALID: duplicate social event identity with an altered payload — corruption, not replay');
        continue; // exact crash re-append — the same knowledge event
      }
      digests.set(e.sourceEventId, digest);
      durableIds.add(e.sourceEventId);
      observed += 1;
      continue;
    }
    if (e.type === SOCIAL_CURSOR_EVENT_TYPE) {
      const err = validateSocialCursorEvent(e);
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const prev = cursors[e.provider];
      if (prev !== undefined && e.durableCursor < prev) return fail(`SOCIAL_HISTORY_INVALID: cursor regression for ${e.provider} (${prev} -> ${e.durableCursor})`);
      cursors[e.provider] = e.durableCursor;
      cursorEvents += 1;
      continue;
    }
    if (e.type === X_RULESET_EVENT_TYPE) {
      const r = xDup(e, validateXRuleSetEvent(e)); if (r === 'dup') continue; if (r) return r;
      if (e.coverageEpoch < x.coverageEpoch) return fail(`SOCIAL_HISTORY_INVALID: X coverage epoch regression (${x.coverageEpoch} -> ${e.coverageEpoch})`);
      x.ruleSetHash = e.ruleSetHash; x.coverageEpoch = e.coverageEpoch; x.activatedKnownAtTs = e.activatedKnownAtTs; x.ruleTags = e.ruleTags; x.progressThroughTs = null; x.events += 1;
      continue;
    }
    if (e.type === X_METER_EVENT_TYPE) {
      const r = xDup(e, validateXMeterEvent(e)); if (r === 'dup') continue; if (r) return r;
      const m = x.meter;
      if (m && e.period === m.period && e.deliveredPostReads < m.deliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X meter regression within a period');
      if (m && e.monthPeriod === m.monthPeriod && e.monthDeliveredPostReads < m.monthDeliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X monthly meter regression');
      if (m && e.period < m.period) return fail('SOCIAL_HISTORY_INVALID: X meter period regression');
      x.meter = { period: e.period, deliveredPostReads: e.deliveredPostReads, monthPeriod: e.monthPeriod, monthDeliveredPostReads: e.monthDeliveredPostReads, unitPriceUsd: e.unitPriceUsd, estimatedUsd: e.estimatedUsd, serverUsage: e.serverUsage, knownAtTs: e.knownAtTs };
      x.events += 1;
      continue;
    }
    if (e.type === X_PROGRESS_EVENT_TYPE) {
      const r = xDup(e, validateXProgressEvent(e)); if (r === 'dup') continue; if (r) return r;
      if (e.coverageEpoch !== x.coverageEpoch || e.ruleSetHash !== x.ruleSetHash) return fail('SOCIAL_HISTORY_INVALID: X progress outside the active coverage epoch');
      if (x.progressThroughTs !== null && e.throughKnownAtTs < x.progressThroughTs) return fail(`SOCIAL_HISTORY_INVALID: X progress regression (${x.progressThroughTs} -> ${e.throughKnownAtTs})`);
      x.progressThroughTs = e.throughKnownAtTs; x.events += 1;
      continue;
    }
    if (e.type === X_GAP_EVENT_TYPE) {
      const r = xDup(e, validateXGapEvent(e)); if (r === 'dup') continue; if (r) return r;
      if (e.coverageEpoch !== x.coverageEpoch) return fail('SOCIAL_HISTORY_INVALID: X gap outside the active coverage epoch');
      x.lastGap = { gapStartTs: e.gapStartTs, reason: e.reason, knownAtTs: e.knownAtTs, coverageEpoch: e.coverageEpoch }; x.events += 1;
      continue;
    }
    // any other type belongs to the frozen core's own replay/validator
  }
  return { ok: true, durableIds, cursors, observed, cursorEvents, x };
}
