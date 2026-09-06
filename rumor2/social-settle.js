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
  'lifecycle', 'relation', 'parentNativePostId', 'threadId', 'nativeVersionId', 'handle',
  'text', 'textHash', 'metaHash', 'engagement', 'authorMeta',
  'sourceCreatedTs', 'retrievedTs', 'knownAtTs',
]);

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
    sourceCreatedTs: observation.sourceCreatedTs,
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
  // point-in-time (§8/§10): sourceCreatedTs is EITHER a safe-integer ms OR null
  // (UNKNOWN — a provider that supplied no source-created time, never fabricated
  // from local wall clock). retrieved/known are always present. When source time
  // is known enforce created <= retrieved <= known; when unknown enforce only
  // retrieved <= known.
  if (!isTs(event.retrievedTs) || !isTs(event.knownAtTs)) return 'social event: clock invalid';
  if (event.sourceCreatedTs !== null && !isTs(event.sourceCreatedTs)) return 'social event: sourceCreatedTs invalid';
  if (event.sourceCreatedTs !== null && event.sourceCreatedTs > event.retrievedTs) return 'social event: created after retrieved';
  if (event.retrievedTs > event.knownAtTs) return 'social event: retrieved after known';
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
    textHash: event.textHash, sourceCreatedTs: event.sourceCreatedTs,
    handle: event.handle, authorMeta: event.authorMeta, engagement: event.engagement,
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
    versionId: event.sourceEventId,
    handle: event.handle,
    text: event.text,
    sourceCreatedTs: event.sourceCreatedTs,
    retrievedTs: event.retrievedTs,
    knownAtTs: event.knownAtTs,
    engagement: event.engagement,
    // first-known author metadata survives the journal exactly (§20/§21) —
    // information-only research context, never identity or trade authority
    authorMeta: event.authorMeta ?? null,
  };
}
