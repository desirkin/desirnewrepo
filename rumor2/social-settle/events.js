import { CURRENT_REQUEST_TYPE, currentRequestError } from '../social-current-meter.js';
import { FARCASTER_REQUEST_TYPE, farcasterRequestError } from '../social-farcaster-meter.js';
import { contentHash, canonicalJson } from '../truth.js';
import {
  socialSourceIdentity, socialAuthorIdentity, socialVersionIdentity, socialMetaHash,
  normalizeSocialText, SOCIAL_RELATION_KINDS, ECHO_RELATIONS, SOCIAL_LIFECYCLE_STATES,
  R2SS_RE, R2SA_RE, R2SV_RE, MAX_SOCIAL_TEXT_CHARS, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_HANDLE_CHARS,
  SOURCE_CLOCK_STATES, SOURCE_CLOCK_STATES_V2, classifySourceClock, classifyWitnessedSourceClock, socialWitnessHash,
  canonicalIngressTags, MAX_INGRESS_TAGS, MAX_INGRESS_TAG_CHARS,
  socialRetentionRefusal,
} from '../social.js';
import { socialProviderById } from '../social-registry.js';
import { validateTemporalWitness, witnessesEquivalent, TEMPORAL_POLICY_VERSION } from '../social-time.js';
import { validateCatalogContent, SOCIAL_CATALOG_MARKET_KEYS } from '../social-catalog.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, replayResearchDossierEvent } from '../social-research-dossier.js';
import { RESEARCH_SHADOW_EVENT_TYPE, replayResearchShadowEvent, emptyShadowState } from '../social-research-shadow.js';
import { socialAdmissionFilterId, SOCIAL_ADMISSION_POLICY_VERSION, SOCIAL_ADMISSION_MODES, SOCIAL_BASE_RE, SOCIAL_SCOPE_MAX_STATIC_TERMS, SOCIAL_SCOPE_MAX_ALIASES, SOCIAL_SCOPE_MAX_WATCH_AUTHORS } from '../social-scope.js';
import { MAX_RECONCILIATION_CANDIDATE_IDS, PROVIDER_EVENT_SEQ_PROVIDERS, R2CG_RE, R2CV_RE, R2SC_RE, R2SI_RE, R2SP_RE, R2SQ_RE, SOCIAL_CATALOG_EVENT_KEYS, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_KEYS, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_CLOCK_INTERPRETATION_KEYS, SOCIAL_CLOCK_INTERPRETATION_KEYS_V2, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_CLOCK_POLICY_BY_PROVIDER, SOCIAL_CLOCK_PROVENANCE, SOCIAL_CLOCK_ROLES, SOCIAL_CURSOR_EVENT_KEYS, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_SCHEMA_VERSION, SOCIAL_EVENT_TYPE, SOCIAL_EVENT_TYPES, SOCIAL_EVENT_V2_KEYS, SOCIAL_EVENT_V2_TYPE, SOCIAL_INTERPRETATION_BASES, SOCIAL_OBSERVATION_TYPES, SOCIAL_RECONCILIATION_PENDING_KEYS, SOCIAL_RECONCILIATION_PENDING_KEYS_V2, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_RECONCILIATION_REASONS, SOCIAL_RECORD_SCHEMA_VERSION, SOCIAL_RECORD_SCHEMA_VERSIONS, SOCIAL_SCOPE_EVENT_KEYS, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_SCOPE_REASONS, X_GAP_EVENT_KEYS, X_GAP_EVENT_TYPE, X_GAP_REASONS, X_METER_EVENT_KEYS, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_KEYS, X_PROGRESS_EVENT_TYPE, X_RULESET_EVENT_KEYS, X_RULESET_EVENT_TYPE, X_SMOKE_EVENT_KEYS, X_SMOKE_EVENT_TYPE, X_SMOKE_EXTRA_REASONS, X_SMOKE_RUN_ID_RE, X_SMOKE_STATUSES, X_SMOKE_TERMINAL_STATUSES, X_STATE_PROVIDERS, exactKeys, isSocialEventType, isStr, isTs, iso, socialCatalogIdentity, socialCatalogVerifiedIdentity, socialCursorIdentity, socialScopeIdentity, xGapIdentity, xMeterIdentity, xProgressIdentity, xRuleSetIdentity, xSmokeIdentity } from './common.js';

// Build the durable event from a normalized observation. sourceEventId is the
// version identity, so the journal collapses exact re-appends and rejects an
// altered re-delivery of the same version, while an edit is a new version.
export function socialObservationToEvent(observation) {
  // SOCIAL-3: never build durable truth for a retention-prohibited provider
  const refusal = socialRetentionRefusal(observation?.provider);
  if (refusal) return { event: null, refused: `RETENTION_NOT_APPROVED: ${refusal}`, socialSourceId: null, socialAuthorId: null, versionId: null };
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
  // SOCIAL-4D COMPLETION: a witnessed (schema-version-2) observation becomes the
  // discriminated v2 event; the identity recipe is UNCHANGED (sourceEventId binds the
  // same provenance facts), so a valid exact instant keeps its legacy identity and the
  // witnesses ride alongside, bound by witnessHash.
  if (observation.schemaVersion === SOCIAL_EVENT_SCHEMA_VERSION) {
    event.type = SOCIAL_EVENT_V2_TYPE;
    event.schemaVersion = SOCIAL_EVENT_SCHEMA_VERSION;
    event.sourceClockWitness = observation.sourceClockWitness;
    event.providerEventWitness = observation.providerEventWitness ?? null;
    event.witnessHash = observation.witnessHash;
  }
  return { event, socialSourceId: observation.socialSourceId, socialAuthorId: observation.socialAuthorId, versionId: observation.socialVersionId };
}

// ---- SOCIAL-4D COMPLETION: native-event identity + immutable non-clock facts -------------
// The ONE provider-native event key shared by settlement and replay. It names the exact
// provider occurrence this route can identify: post + author + lifecycle + native version
// (X current Post id / Bluesky CID) + provider sequence (Bluesky seq). Two Bluesky commits
// with different seq are DIFFERENT keys whatever their CID/text; a Farcaster recast edge
// carries no occurrence identity beyond reactor+target (see the reconciler).
export const socialNativeKey = (e) => ({ provider: e.provider, nativePostId: e.nativePostId, nativeAuthorId: e.nativeAuthorId, lifecycle: e.lifecycle, nativeVersionId: e.nativeVersionId ?? null, providerEventSeq: e.providerEventSeq ?? null });
export const socialNativeKeyDigest = (e) => contentHash(canonicalJson(socialNativeKey(e)));
// EXACT retained text and every immutable non-clock content fact — never the folded
// similarity textHash alone, never handle/engagement/followers
export const socialImmutableDigest = (e) => contentHash(canonicalJson({ providerKind: e.providerKind, nativePostId: e.nativePostId, nativeAuthorId: e.nativeAuthorId, lifecycle: e.lifecycle, relation: e.relation, parentNativePostId: e.parentNativePostId ?? null, threadId: e.threadId ?? null, nativeVersionId: e.nativeVersionId ?? null, providerEventSeq: e.providerEventSeq ?? null, text: e.text }));
// SOCIAL-4D CLOSEOUT — the COARSE occurrence key: the native key WITHOUT its provider
// sequence discriminator. Used ONLY to detect uncertainty when a required discriminator is
// absent on either side (missing a discriminator is not proof of a distinct occurrence);
// never to merge two commits that both carry distinct sequences.
export const socialCoarseKey = (e) => ({ provider: e.provider, nativePostId: e.nativePostId, nativeAuthorId: e.nativeAuthorId, lifecycle: e.lifecycle, nativeVersionId: e.nativeVersionId ?? null });
export const socialCoarseKeyDigest = (e) => contentHash(canonicalJson(socialCoarseKey(e)));
// SOCIAL-4D CLOSEOUT — THE ONE semantic equivalence assessment shared by every route that may
// conclude "already known / terminal duplicate": the process-local intake cache, the durable
// fast check, the exact-identity branch of the reconciler, same-batch dedupe, and restart /
// eviction paths. A sourceEventId alone (or id + witnessHash) never suffices:
//   1. EXACT immutable non-clock facts must agree (exact text, ids, lifecycle, relation, parent,
//      thread, native version, sequence) — the folded similarity fingerprint that feeds the
//      version id cannot authenticate exact text;              else CONFLICT / IMMUTABLE_FACT_CONFLICT
//   2. an unwitnessed (legacy-shaped) candidate follows the legacy version law;   EQUIVALENT
//   3. a legacy durable record retained no declaration: the fast paths cannot decide;
//                                                        UNDETERMINED / LEGACY_DECLARATION_NOT_RETAINED
//   4. retained source declarations must be equal or equivalent under the policy
//      (same projection AND remainder);                        else CONFLICT / DECLARATION_CONFLICT
//   5. a differing provider EVENT clock (delivery diagnostics) follows the first-known policy —
//      never a new content identity, never a conflict record.  EQUIVALENT
// Mutable handle / engagement / profile data and acquisition clocks are not consulted (keep-first).
export const SOCIAL_EQUIVALENCE_VERDICTS = Object.freeze(['EQUIVALENT', 'CONFLICT', 'UNDETERMINED']);
export function assessSocialEquivalence(existing, candidate) {
  if (existing === null || typeof existing !== 'object' || candidate === null || typeof candidate !== 'object') return { verdict: 'UNDETERMINED', reason: 'NO_RETAINED_FACTS' };
  if (typeof existing.immutableDigest !== 'string') return { verdict: 'UNDETERMINED', reason: 'IMMUTABLE_FACTS_UNKNOWN' };
  if (existing.immutableDigest !== socialImmutableDigest(candidate)) return { verdict: 'CONFLICT', reason: 'IMMUTABLE_FACT_CONFLICT' };
  if (candidate.schemaVersion !== SOCIAL_EVENT_SCHEMA_VERSION) return { verdict: 'EQUIVALENT', reason: 'LEGACY_VERSION_LAW' };
  if (existing.format !== 2) return { verdict: 'UNDETERMINED', reason: 'LEGACY_DECLARATION_NOT_RETAINED' };
  if (existing.witnessHash === candidate.witnessHash) return { verdict: 'EQUIVALENT', reason: 'SAME_WITNESSES' };
  if (!sameDeclaration(existing.sourceClockWitness, candidate.sourceClockWitness)) return { verdict: 'CONFLICT', reason: 'DECLARATION_CONFLICT' };
  return { verdict: 'EQUIVALENT', reason: 'PROVIDER_EVENT_FIRST_KNOWN' };
}
// two retained declarations name the same instant (equivalent under the policy) or are the
// same declaration bytes under the same policy (a non-instant declaration redelivered exactly)
export const sameDeclaration = (a, b) => witnessesEquivalent(a, b) || (!!a && !!b && a.declared === b.declared && a.declaredStatus === b.declaredStatus && a.policy === b.policy && a.policyVersion === b.policyVersion);
// the compact first-seen record a bounded process-local cache keeps per version id
export const socialSeenRecord = (o) => Object.freeze({ format: o.schemaVersion === SOCIAL_EVENT_SCHEMA_VERSION ? 2 : 1, immutableDigest: socialImmutableDigest(o), witnessHash: o.witnessHash ?? null, sourceClockWitness: o.sourceClockWitness ?? null, providerEventWitness: o.providerEventWitness ?? null });
// SOCIAL-4D RECORD INTEGRITY — the immutable FIRST-KNOWN SNAPSHOT binding of a version-2
// correction/conflict record: a locally re-derived hash over EVERY field the settled record
// states (its clocks, target membership, matching basis, witnesses) except the hash itself. The
// semantic identity (sourceEventId) says WHICH correction/conflict this is and dedupes
// redelivery keep-first; the snapshot says exactly what the durable record stated when it was
// settled. It detects an altered payload that retains its prior binding and enforces internal
// consistency. It is NOT a signature, NOT an external timestamp attestation, and proves nothing
// against an adversary able to rewrite authoritative history and every hash consistently.
export const socialRecordSnapshotHash = (ev) => { const { snapshotHash: _omit, ...rest } = ev; return contentHash(canonicalJson(rest)); };
// the bounded temporal interpretation of ONE clock role, derived deterministically from a
// witness and the TARGET's recorded acquisition clock (never a wall clock)
export function deriveClockInterpretation({ witness, clockRole, retrievedTs }) {
  if (witness === null) return { established: false, projectionMs: null, sourceCreatedTs: null, sourceClockStatus: null, reason: 'NO_WITNESS' };
  if (clockRole === 'PROVIDER_EVENT') return { established: witness.outcome === 'INSTANT', projectionMs: witness.projectionMs, sourceCreatedTs: null, sourceClockStatus: null, reason: witness.outcome === 'INSTANT' ? 'WITNESSED_DECLARATION' : witness.outcome };
  const c = classifyWitnessedSourceClock({ witness, retrievedTs });
  return { established: witness.outcome === 'INSTANT', projectionMs: witness.projectionMs, sourceCreatedTs: c.sourceCreatedTs, sourceClockStatus: c.sourceClockStatus, reason: witness.outcome === 'INSTANT' ? 'WITNESSED_DECLARATION' : witness.outcome };
}
// the ONE derived-index entry recipe shared by replay and live adoption (never a second truth)
export const socialIndexEntry = (e) => Object.freeze({ id: e.sourceEventId, type: e.type, format: e.type === SOCIAL_EVENT_V2_TYPE ? 2 : 1, provider: e.provider, nativeKeyDigest: socialNativeKeyDigest(e), coarseKeyDigest: socialCoarseKeyDigest(e), immutableDigest: socialImmutableDigest(e), providerEventSeq: e.providerEventSeq ?? null, retrievedTs: e.retrievedTs, knownAtTs: e.knownAtTs, sourceDeclaredTs: e.sourceDeclaredTs, sourceCreatedTs: e.sourceCreatedTs, sourceClockStatus: e.sourceClockStatus, providerEventTs: e.providerEventTs, witnessHash: e.type === SOCIAL_EVENT_V2_TYPE ? e.witnessHash : null, sourceClockWitness: e.type === SOCIAL_EVENT_V2_TYPE ? e.sourceClockWitness : null, providerEventWitness: e.type === SOCIAL_EVENT_V2_TYPE ? (e.providerEventWitness ?? null) : null, relation: e.relation });
export const socialInterpretationIdentity = ({ targetType, targetEventId, clockRole, witness, interpretation }) => `r2si-${contentHash(canonicalJson({ targetType, targetEventId, clockRole, policy: witness.policy, policyVersion: witness.policyVersion, interpretationDigest: contentHash(canonicalJson({ witness, interpretation })) }))}`;
// Build the annotation for an already-durable TARGET event. `evidence` is the witnessed
// candidate observation that carries the new declaration (basis NEW_DELIVERY_SAME_EVENT),
// or the target itself when its own retained declaration is re-read under a newer policy
// (basis RETAINED_ORIGINAL_DECLARATION). knownAtTs is when THIS interpretation became known.
export function socialClockInterpretationEvent({ target, clockRole, basis, witness, evidenceRetrievedTs, knownAtTs }) {
  const legacy = target.type === SOCIAL_EVENT_TYPE;
  const priorInterpretation = clockRole === 'SOURCE_DECLARATION'
    ? { sourceDeclaredTs: target.sourceDeclaredTs ?? null, sourceCreatedTs: target.sourceCreatedTs ?? null, sourceClockStatus: target.sourceClockStatus ?? 'UNKNOWN', provenance: legacy ? 'LEGACY_NUMERIC_UNVERIFIED' : 'WITNESSED_DECLARATION' }
    : { sourceDeclaredTs: target.providerEventTs ?? null, sourceCreatedTs: null, sourceClockStatus: null, provenance: legacy ? 'LEGACY_NUMERIC_UNVERIFIED' : 'WITNESSED_DECLARATION' };
  const interpretation = deriveClockInterpretation({ witness, clockRole, retrievedTs: target.retrievedTs });
  const ev = {
    type: SOCIAL_CLOCK_INTERPRETATION_TYPE, ts: iso(knownAtTs), sourceEventId: null, provider: target.provider, schemaVersion: SOCIAL_RECORD_SCHEMA_VERSION,
    targetType: target.type, targetEventId: target.sourceEventId, targetDigest: contentHash(canonicalJson(target)),
    nativeKey: socialNativeKey(target), immutableDigest: socialImmutableDigest(target),
    clockRole, basis, witness, priorInterpretation, interpretation, evidenceRetrievedTs, knownAtTs, snapshotHash: null,
  };
  ev.sourceEventId = socialInterpretationIdentity({ targetType: ev.targetType, targetEventId: ev.targetEventId, clockRole, witness, interpretation });
  ev.snapshotHash = socialRecordSnapshotHash(ev);
  return ev;
}
// Validate an annotation AGAINST ITS TARGET (the caller supplies the durable target event
// from the validated index or replay): target existence/type/provider, exact digest
// binding, native key + immutable digest agreement, witness re-derivation under the
// provider's role policy, interpretation re-derivation, clocks, identity.
export function validateSocialClockInterpretation(ev, { target = null } = {}) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'clock interpretation: not an object';
  if (!SOCIAL_RECORD_SCHEMA_VERSIONS.includes(ev.schemaVersion)) return 'clock interpretation: unsupported schema version';
  const sealed = ev.schemaVersion === 2;
  const kErr = exactKeys(ev, sealed ? SOCIAL_CLOCK_INTERPRETATION_KEYS_V2 : SOCIAL_CLOCK_INTERPRETATION_KEYS); if (kErr) return `clock interpretation: ${kErr}`;
  if (ev.type !== SOCIAL_CLOCK_INTERPRETATION_TYPE) return 'clock interpretation: wrong type';
  const meta = isStr(ev.provider, 100) ? socialProviderById(ev.provider) : null;
  if (!meta) return 'clock interpretation: provider not in the authoritative social registry';
  if (meta.retentionProhibited || socialRetentionRefusal(ev.provider)) return `clock interpretation: RETENTION_NOT_APPROVED: ${ev.provider}`;
  if (!SOCIAL_OBSERVATION_TYPES.includes(ev.targetType)) return 'clock interpretation: target type is not a social observation';
  if (!R2SV_RE.test(ev.targetEventId)) return 'clock interpretation: target id malformed';
  if (!SOCIAL_CLOCK_ROLES.includes(ev.clockRole)) return 'clock interpretation: unknown clock role';
  if (!SOCIAL_INTERPRETATION_BASES.includes(ev.basis)) return 'clock interpretation: unknown basis';
  const policies = SOCIAL_CLOCK_POLICY_BY_PROVIDER[ev.provider];
  if (!policies) return 'clock interpretation: provider has no witnessed clock policy';
  const expectedPolicy = ev.clockRole === 'SOURCE_DECLARATION' ? policies.source : policies.event;
  if (!expectedPolicy) return 'clock interpretation: this provider has no clock of that role';
  const werr = validateTemporalWitness(ev.witness, { expectedPolicyId: expectedPolicy }); if (werr) return `clock interpretation: ${werr}`;
  if (!isTs(ev.evidenceRetrievedTs) || !isTs(ev.knownAtTs)) return 'clock interpretation: clock invalid';
  if (ev.evidenceRetrievedTs > ev.knownAtTs) return 'clock interpretation: evidence acquired after the interpretation became known';
  if (ev.ts !== iso(ev.knownAtTs)) return 'clock interpretation: ts disagrees with knownAtTs';
  if (target === null) return 'clock interpretation: target not durable (unknown, unsettled, or later than this record)';
  if (target.type !== ev.targetType || target.sourceEventId !== ev.targetEventId) return 'clock interpretation: target does not match';
  if (target.provider !== ev.provider) return 'clock interpretation: cross-provider target';
  if (contentHash(canonicalJson(target)) !== ev.targetDigest) return 'clock interpretation: target digest does not bind the durable target';
  if (canonicalJson(ev.nativeKey) !== canonicalJson(socialNativeKey(target))) return 'clock interpretation: native key does not match the target';
  if (ev.immutableDigest !== socialImmutableDigest(target)) return 'clock interpretation: immutable facts do not match the target';
  if (ev.knownAtTs < target.knownAtTs) return 'clock interpretation: known before its target';
  if (ev.basis === 'RETAINED_ORIGINAL_DECLARATION') {
    if (target.type !== SOCIAL_EVENT_V2_TYPE) return 'clock interpretation: a legacy target retained no declaration';
    const retained = ev.clockRole === 'SOURCE_DECLARATION' ? target.sourceClockWitness : target.providerEventWitness;
    if (!retained || retained.declared !== ev.witness.declared || retained.declaredStatus !== ev.witness.declaredStatus) return 'clock interpretation: the retained declaration differs';
  }
  const expected = socialClockInterpretationEvent({ target, clockRole: ev.clockRole, basis: ev.basis, witness: ev.witness, evidenceRetrievedTs: ev.evidenceRetrievedTs, knownAtTs: ev.knownAtTs });
  if (canonicalJson(expected.priorInterpretation) !== canonicalJson(ev.priorInterpretation)) return 'clock interpretation: prior interpretation is not the target\'s recorded interpretation';
  if (canonicalJson(expected.interpretation) !== canonicalJson(ev.interpretation)) return 'clock interpretation: interpretation is not the re-derived one';
  if (!R2SI_RE.test(ev.sourceEventId) || ev.sourceEventId !== expected.sourceEventId) return 'clock interpretation: sourceEventId is not the derived identity';
  // version 2: the first-known snapshot (clocks included) must be exactly what was settled
  if (sealed && ev.snapshotHash !== socialRecordSnapshotHash(ev)) return 'clock interpretation: snapshotHash is not the re-derived first-known snapshot (altered clocks or fields under an existing identity)';
  return null;
}
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
  // SOCIAL-4D COMPLETION: the witnessed format has its own closed validator; the legacy
  // branch below is the UNCHANGED historical validator for the shape it represents
  if (event.type === SOCIAL_EVENT_V2_TYPE) return validateSocialEventV2(event, { socialProviderIds });
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
  // SOCIAL-3 retention firewall: BOTH the closed code constant and the registry
  // flag refuse — neither a caller list nor a registry edit alone can open it
  if (meta.retentionProhibited || socialRetentionRefusal(event.provider)) return `social event: RETENTION_NOT_APPROVED: ${socialRetentionRefusal(event.provider) ?? `${event.provider} durable content is not approved`}`;
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

// SOCIAL-4D COMPLETION — the witnessed (v2) validator. Every legacy check applies (the
// legacy validator is invoked on a projection of this event with the witness fields
// removed and the legacy type restored, so the shared identity/diagnostic recipes are
// re-derived by ONE code path), plus: closed v2 keys, schema version, both witnesses
// re-derived under the provider's ROLE policy, numeric clocks equal to their projections,
// the binding witnessHash, and the WITNESSED verdict (which may be ORDER_UNRESOLVED).
export function validateSocialEventV2(event, { socialProviderIds = null } = {}) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return 'social event v2: not an object';
  const kErr = exactKeys(event, SOCIAL_EVENT_V2_KEYS); if (kErr) return `social event v2: ${kErr}`;
  if (event.type !== SOCIAL_EVENT_V2_TYPE) return 'social event v2: wrong type';
  if (event.schemaVersion !== SOCIAL_EVENT_SCHEMA_VERSION) return 'social event v2: unsupported schema version';
  if (!isStr(event.provider, 100)) return 'social event v2: provider invalid';
  const metaV2 = socialProviderById(event.provider);
  if (!metaV2) return `social event v2: ${event.provider} is not in the authoritative social registry`;
  if (metaV2.retentionProhibited || socialRetentionRefusal(event.provider)) return `social event v2: RETENTION_NOT_APPROVED: ${socialRetentionRefusal(event.provider) ?? `${event.provider} durable content is not approved`}`;
  const policies = SOCIAL_CLOCK_POLICY_BY_PROVIDER[event.provider];
  if (!policies) return `social event v2: ${event.provider} has no witnessed clock policy`;
  const werr = validateTemporalWitness(event.sourceClockWitness, { expectedPolicyId: policies.source }); if (werr) return `social event v2: ${werr}`;
  if (event.providerEventWitness !== null) {
    if (!policies.event) return 'social event v2: this provider has no provider event clock';
    const perr = validateTemporalWitness(event.providerEventWitness, { expectedPolicyId: policies.event }); if (perr) return `social event v2: ${perr}`;
  }
  if ((event.sourceClockWitness.projectionMs ?? null) !== event.sourceDeclaredTs) return 'social event v2: sourceDeclaredTs is not the witness projection';
  if ((event.providerEventWitness?.projectionMs ?? null) !== event.providerEventTs) return 'social event v2: providerEventTs is not the witness projection';
  if (event.witnessHash !== socialWitnessHash({ sourceClockWitness: event.sourceClockWitness, providerEventWitness: event.providerEventWitness })) return 'social event v2: witnessHash is not the re-derived binding';
  if (!SOURCE_CLOCK_STATES_V2.includes(event.sourceClockStatus)) return 'social event v2: sourceClockStatus unknown';
  if (!isTs(event.retrievedTs)) return 'social event v2: clock invalid';
  const c = classifyWitnessedSourceClock({ witness: event.sourceClockWitness, retrievedTs: event.retrievedTs });
  if (c.sourceClockStatus !== event.sourceClockStatus) return 'social event v2: sourceClockStatus is not the re-derived witnessed verdict';
  if (c.sourceCreatedTs !== event.sourceCreatedTs) return 'social event v2: sourceCreatedTs disagrees with the witnessed clock law';
  if (c.sourceClockSkewMs !== event.sourceClockSkewMs) return 'social event v2: sourceClockSkewMs is not the re-derived skew';
  // every remaining law is the legacy law, re-derived by the legacy validator over the
  // legacy projection of this event (the verdict fields are re-set to a legacy-admissible
  // shape ONLY for that shared structural/identity check — the witnessed verdict above is
  // the one that binds this event)
  const legacyView = {}; for (const k of SOCIAL_EVENT_KEYS) legacyView[k] = event[k];
  legacyView.type = SOCIAL_EVENT_TYPE;
  const lc = classifySourceClock({ sourceDeclaredTs: event.sourceDeclaredTs, retrievedTs: event.retrievedTs });
  legacyView.sourceCreatedTs = lc.sourceCreatedTs; legacyView.sourceClockStatus = lc.sourceClockStatus; legacyView.sourceClockSkewMs = lc.sourceClockSkewMs;
  legacyView.metaHash = socialMetaHash({ ...legacyView, socialSourceId: event.socialSourceId });
  const lerr = validateSocialEvent(legacyView, { socialProviderIds });
  if (lerr) return lerr.replace('social event:', 'social event v2:');
  // the diagnostic hash of the v2 event binds ITS witnessed verdict
  const facts = { ...legacyView, sourceClockStatus: event.sourceClockStatus, sourceClockSkewMs: event.sourceClockSkewMs, socialSourceId: event.socialSourceId };
  if (event.metaHash !== socialMetaHash(facts)) return 'social event v2: metaHash is not the re-derived diagnostic hash';
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
    // SOCIAL-4D COMPLETION: the format and the retained temporal witnesses. A legacy row
    // holds only a parsed number: its clock provenance is UNVERIFIED (the declaration was
    // never retained), never "precision-verified"; a v2 row retains the declaration itself.
    schemaVersion: event.type === SOCIAL_EVENT_V2_TYPE ? event.schemaVersion : 1,
    clockProvenance: event.type === SOCIAL_EVENT_V2_TYPE ? 'WITNESSED_DECLARATION' : 'LEGACY_NUMERIC_UNVERIFIED',
    sourceClockWitness: event.type === SOCIAL_EVENT_V2_TYPE ? event.sourceClockWitness : null,
    providerEventWitness: event.type === SOCIAL_EVENT_V2_TYPE ? (event.providerEventWitness ?? null) : null,
  };
}
