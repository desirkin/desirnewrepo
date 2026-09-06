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
  SOURCE_CLOCK_STATES, SOURCE_CLOCK_STATES_V2, classifySourceClock, classifyWitnessedSourceClock, socialWitnessHash,
  canonicalIngressTags, MAX_INGRESS_TAGS, MAX_INGRESS_TAG_CHARS,
  socialRetentionRefusal,
} from './social.js';
import { socialProviderById } from './social-registry.js';
import { validateTemporalWitness, witnessesEquivalent, TEMPORAL_POLICY_VERSION } from './social-time.js';

export const SOCIAL_EVENT_TYPE = 'RUMOR2_SOCIAL_OBSERVED';
// SOCIAL-4D COMPLETION — the explicitly discriminated WITNESSED observation format.
// The legacy RUMOR2_SOCIAL_OBSERVED shape, its identity recipe, and its diagnostic-hash
// recipe stay EXACTLY as they were for the history they represent. New ingestion from
// the strict adapters emits RUMOR2_SOCIAL_OBSERVED_V2: the legacy keys PLUS a schema
// version, the two bounded temporal witnesses, and their binding hash. A v2 event can
// never lose its witness fields and pass as legacy (closed keys, per-type validators).
export const SOCIAL_EVENT_V2_TYPE = 'RUMOR2_SOCIAL_OBSERVED_V2';
export const SOCIAL_EVENT_SCHEMA_VERSION = 2;

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
export const SOCIAL_EVENT_V2_KEYS = Object.freeze([...SOCIAL_EVENT_KEYS, 'schemaVersion', 'sourceClockWitness', 'providerEventWitness', 'witnessHash']);
// the FIELD-ROLE parser policy each provider's witnesses must carry (pinned here so a
// forged or mismatched policy dies in validation; adapters read the same map)
export const SOCIAL_CLOCK_POLICY_BY_PROVIDER = Object.freeze({
  BLUESKY_OFFICIAL: Object.freeze({ source: 'AT_DATETIME', event: 'JETSTREAM_EVENT_TIME' }),
  FARCASTER_OFFICIAL: Object.freeze({ source: 'RFC3339', event: null }),
  X_OFFICIAL: Object.freeze({ source: 'ISO8601_PROFILE', event: null }),
});
// SOCIAL-4D COMPLETION — the dated TIME-INTERPRETATION annotation: a closed, non-source
// record that says "this later-known, supported interpretation applies to that exact
// durable observation", carrying its own knowledge clock. It changes no stored row and
// counts as no social source, origin, author, or propagation.
export const SOCIAL_CLOCK_INTERPRETATION_TYPE = 'RUMOR2_SOCIAL_CLOCK_INTERPRETATION';
export const SOCIAL_CLOCK_INTERPRETATION_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'schemaVersion', 'targetType', 'targetEventId', 'targetDigest', 'nativeKey', 'immutableDigest', 'clockRole', 'basis', 'witness', 'priorInterpretation', 'interpretation', 'evidenceRetrievedTs', 'knownAtTs']);
// SOCIAL-4D RECORD INTEGRITY: version-2 records add the closed first-known SNAPSHOT binding
export const SOCIAL_CLOCK_INTERPRETATION_KEYS_V2 = Object.freeze([...SOCIAL_CLOCK_INTERPRETATION_KEYS, 'snapshotHash']);
export const SOCIAL_RECORD_SCHEMA_VERSION = 2; // annotations + pending records emitted now
export const SOCIAL_RECORD_SCHEMA_VERSIONS = Object.freeze([1, 2]); // 1 = legacy unsealed (accepted under its own contract), 2 = sealed
export const SOCIAL_CLOCK_ROLES = Object.freeze(['SOURCE_DECLARATION', 'PROVIDER_EVENT']);
export const SOCIAL_INTERPRETATION_BASES = Object.freeze(['RETAINED_ORIGINAL_DECLARATION', 'NEW_DELIVERY_SAME_EVENT']);
export const SOCIAL_CLOCK_PROVENANCE = Object.freeze(['LEGACY_NUMERIC_UNVERIFIED', 'WITNESSED_DECLARATION']);
export const R2SI_RE = /^r2si-[0-9a-f]{40}$/;
// SOCIAL-4D COMPLETION — the explicit RECONCILIATION-PENDING record: relevant, structurally
// valid input whose identity/time match against durable history is genuinely unresolved.
// Retained in the same journal, clearly NOT an accepted source, version, corroboration,
// or propagation event; never a reason to guess, discard, or stop other providers.
export const SOCIAL_RECONCILIATION_PENDING_TYPE = 'RUMOR2_SOCIAL_RECONCILIATION_PENDING';
export const SOCIAL_RECONCILIATION_PENDING_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'schemaVersion', 'reason', 'nativeKey', 'immutableDigest', 'candidateVersionId', 'candidateIds', 'witnessHash', 'sourceClockWitness', 'providerEventWitness', 'candidate', 'knownAtTs']);
export const SOCIAL_RECONCILIATION_PENDING_KEYS_V2 = Object.freeze([...SOCIAL_RECONCILIATION_PENDING_KEYS, 'candidateTotal', 'snapshotHash']);
export const SOCIAL_RECONCILIATION_REASONS = Object.freeze(['MULTIPLE_CANDIDATES', 'OCCURRENCE_IDENTITY_INSUFFICIENT', 'IMMUTABLE_FACT_CONFLICT', 'DECLARATION_CONFLICT']);
export const MAX_RECONCILIATION_CANDIDATE_IDS = 16;
export const R2SP_RE = /^r2sp-[0-9a-f]{40}$/;

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
export const X_GAP_REASONS = Object.freeze(['BUDGET_DAILY', 'BUDGET_MONTHLY', 'BUDGET_USD', 'BUDGET_SESSION', 'BUDGET_SMOKE_MAX', 'SMOKE_TARGET_REACHED', 'SMOKE_HEADROOM_OVERRUN', 'SMOKE_PERIOD_ROLLOVER', 'NO_CREDITS', 'OPERATOR_DISABLED', 'USAGE_PREFLIGHT_FAILED', 'RULE_RECONCILE_FAILED', 'UNEXPLAINED_GAP', 'WRITER_LOST', 'CONNECTION_LIMIT', 'AUTH_REJECTED', 'TRANSPORT_FAILED']);
// SOCIAL-2B DURABLE PAID-SMOKE AUTHORIZATION: one closed operational event
// family records each operator-authorized paid smoke RUN — ACTIVE (with its
// durable baseline) BEFORE the paid stream opens, then exactly one terminal
// status. The journal stays the ONE event root; no smoke store exists.
export const X_SMOKE_EVENT_TYPE = 'RUMOR2_SOCIAL_X_SMOKE';
export const X_SMOKE_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'smokeRunId', 'status', 'targetPostReads', 'maxPostReads', 'headroomPosts', 'unitPriceUsd', 'ruleSetHash', 'coverageEpoch', 'baselinePeriod', 'baselineDailyDeliveredPostReads', 'baselineMonthlyDeliveredPostReads', 'baselineServerProjectUsage', 'activatedKnownAtTs', 'deliveredPostReadsForRun', 'overrunPosts', 'terminalReason', 'completedKnownAtTs', 'knownAtTs']);
export const X_SMOKE_STATUSES = Object.freeze(['ACTIVE', 'COMPLETE', 'HEADROOM_OVERRUN', 'ABORTED']);
export const X_SMOKE_TERMINAL_STATUSES = Object.freeze(['COMPLETE', 'HEADROOM_OVERRUN', 'ABORTED']);
// non-gap terminal reasons a run may end with (besides every X_GAP_REASONS entry)
export const X_SMOKE_EXTRA_REASONS = Object.freeze(['SMOKE_RUN_RULESET_MISMATCH', 'SMOKE_RUN_PRICING_CHANGED', 'SMOKE_USAGE_RESET', 'SMOKE_RUN_SUPERSEDED']);
export const X_SMOKE_RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
export const X_STATE_PROVIDERS = Object.freeze(['X_OFFICIAL']);
export const SOCIAL_EVENT_TYPES = Object.freeze([SOCIAL_EVENT_TYPE, SOCIAL_EVENT_V2_TYPE, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE, X_GAP_EVENT_TYPE, X_SMOKE_EVENT_TYPE]);
// the SOURCE observation types (legacy + witnessed) — the only types that count as social sources
export const SOCIAL_OBSERVATION_TYPES = Object.freeze([SOCIAL_EVENT_TYPE, SOCIAL_EVENT_V2_TYPE]);
export const xSmokeIdentity = ({ provider, smokeRunId, status }) => `r2xk-${contentHash(canonicalJson({ provider, smokeRunId, status }))}`;
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
// ---- SOCIAL-4D RECORD INTEGRITY: the ONE target-context / reason law -------------------------
// A pending record's candidateIds are ASSERTED relationships. This law — shared by live
// settlement (the reconciler self-checks every record it emits), replay (before a record may be
// applied to any target), and the standalone temporal view (before a record may affect the
// event it is asked about) — verifies each assertion against the ACTUAL already-known target(s)
// and their preserved immutable facts, per reason:
//   DECLARATION_CONFLICT        exactly one target; the same native occurrence; immutable facts
//                               agree; the target RETAINED a declaration (a v2 source witness or an
//                               earlier valid SOURCE_DECLARATION annotation — a legacy numeric clock
//                               is NOT one) and the candidate's declaration disagrees with all of them
//   IMMUTABLE_FACT_CONFLICT     exactly one target; the same native occurrence; immutable facts DIFFER
//   OCCURRENCE_IDENTITY_INSUFFICIENT  ≥1 target; each shares the documented COARSE key with the
//                               candidate and at least one side lacks its sequence discriminator (or
//                               the candidate is a Farcaster recast edge); never a merge of sequences
//   MULTIPLE_CANDIDATES         ≥2 targets, each the same native occurrence
// Shape-level constraints (counts) are checked by the validator; link-level constraints need the
// targets and are checked here. A target id alone is never evidence of a relation.
const socialPendingShapeError = (ev) => {
  const n = ev.candidateIds.length;
  if ((ev.reason === 'DECLARATION_CONFLICT' || ev.reason === 'IMMUTABLE_FACT_CONFLICT') && n !== 1) return `${ev.reason} names exactly one target`;
  if (ev.reason === 'MULTIPLE_CANDIDATES' && n < 2) return 'MULTIPLE_CANDIDATES names at least two targets';
  if (ev.reason === 'OCCURRENCE_IDENTITY_INSUFFICIENT' && n < 1) return 'OCCURRENCE_IDENTITY_INSUFFICIENT names at least one potential occurrence';
  return null;
};
// the relation between ONE pending record and ONE asserted target; `annotations` are the target's
// own retained interpretation annotations (needed only for DECLARATION_CONFLICT)
export function socialPendingLinkError(ev, target, annotations = []) {
  if (!target || typeof target !== 'object') return 'target not durable (unknown, unsettled, or later than this record)';
  if (!SOCIAL_OBSERVATION_TYPES.includes(target.type)) return 'target is not a social observation';
  if (target.provider !== ev.provider) return 'cross-provider target';
  if (target.knownAtTs > ev.knownAtTs) return 'target known after this record (causally later target)';
  const c = { ...ev.candidate, provider: ev.provider };
  const nativeKeyDigest = contentHash(canonicalJson(ev.nativeKey));
  if (ev.reason === 'OCCURRENCE_IDENTITY_INSUFFICIENT') {
    if (socialCoarseKeyDigest(target) !== socialCoarseKeyDigest(c)) return 'target is not a coarse-key occurrence of the candidate';
    const recast = ev.provider === 'FARCASTER_OFFICIAL' && c.relation === 'REPOST';
    if (!recast && c.providerEventSeq !== null && (target.providerEventSeq ?? null) !== null) return 'both sides carry their sequence discriminator — not an insufficient-identity relation';
    return null;
  }
  if (socialNativeKeyDigest(target) !== nativeKeyDigest) return 'target is not the same native occurrence';
  if (ev.reason === 'IMMUTABLE_FACT_CONFLICT') return socialImmutableDigest(target) === ev.immutableDigest ? 'immutable facts agree — no immutable conflict' : null;
  if (ev.reason === 'DECLARATION_CONFLICT') {
    if (socialImmutableDigest(target) !== ev.immutableDigest) return 'immutable facts differ — not a declaration conflict';
    const retained = [...(target.type === SOCIAL_EVENT_V2_TYPE ? [target.sourceClockWitness] : []), ...(Array.isArray(annotations) ? annotations : []).filter((a) => a && a.clockRole === 'SOURCE_DECLARATION' && a.targetEventId === target.sourceEventId).map((a) => a.witness)];
    if (retained.length === 0) return 'target retained no original declaration to conflict with (a legacy numeric clock is not one)';
    if (retained.some((w) => sameDeclaration(w, ev.sourceClockWitness))) return 'the candidate declaration is equivalent to a retained declaration — no conflict';
    return null;
  }
  return null; // MULTIPLE_CANDIDATES: the same native occurrence suffices
}
// the whole asserted target SET against actual history: targetOf(id) -> durable observation event
// or null; annotationsOf(id) -> that target's retained annotations. null when every link holds.
export function validateSocialPendingContext(ev, { targetOf, annotationsOf = () => [] } = {}) {
  if (typeof targetOf !== 'function') return 'reconciliation pending: no target context supplied';
  const shape = socialPendingShapeError(ev); if (shape) return `reconciliation pending: ${shape}`;
  for (const id of ev.candidateIds) {
    const target = targetOf(id) ?? null;
    const err = socialPendingLinkError(ev, target, annotationsOf(id));
    if (err) return `reconciliation pending: ${ev.reason} link to ${id}: ${err}`;
  }
  return null;
}
// ---- SOCIAL-4D COMPLETION: the reconciliation-pending record --------------------------------
// SEMANTIC identity. Version 1 (legacy) bound provider / native key / immutable digest / witness
// hash / reason only. Version 2 ALSO binds the canonical (bounded, sorted) target set and its
// true size, so a later association over a grown candidate set is a NEW immutable record with
// its own knownAt (never a rewrite of the earlier one), and a substituted or erased target set
// can never keep an existing identity.
export const socialReconciliationIdentity = ({ provider, nativeKeyDigest, immutableDigest, witnessHash, reason, candidateIds, candidateTotal }) => (candidateIds === undefined
  ? `r2sp-${contentHash(canonicalJson({ provider, nativeKeyDigest, immutableDigest, witnessHash, reason }))}`
  : `r2sp-${contentHash(canonicalJson({ v: 2, provider, nativeKeyDigest, immutableDigest, witnessHash, reason, candidateIds, candidateTotal }))}`);
const PENDING_CANDIDATE_KEYS = Object.freeze(['providerKind', 'nativePostId', 'nativeAuthorId', 'lifecycle', 'relation', 'parentNativePostId', 'threadId', 'nativeVersionId', 'providerEventSeq', 'text', 'textHash', 'sourceDeclaredTs', 'sourceCreatedTs', 'sourceClockStatus', 'sourceClockSkewMs', 'providerEventTs', 'retrievedTs']);
export function socialReconciliationPendingEvent({ observation, reason, candidateIds, knownAtTs }) {
  const o = observation;
  const candidate = {}; for (const k of PENDING_CANDIDATE_KEYS) candidate[k] = o[k] ?? null;
  const all = [...new Set(candidateIds)].sort();
  const ev = {
    type: SOCIAL_RECONCILIATION_PENDING_TYPE, ts: iso(knownAtTs), sourceEventId: null, provider: o.provider, schemaVersion: SOCIAL_RECORD_SCHEMA_VERSION, reason,
    nativeKey: socialNativeKey(o), immutableDigest: socialImmutableDigest(o), candidateVersionId: o.socialVersionId,
    candidateIds: all.slice(0, MAX_RECONCILIATION_CANDIDATE_IDS), candidateTotal: all.length, // a bounded list never claims completeness: candidateTotal > candidateIds.length reports truncation
    witnessHash: o.witnessHash, sourceClockWitness: o.sourceClockWitness, providerEventWitness: o.providerEventWitness ?? null, candidate, knownAtTs, snapshotHash: null,
  };
  ev.sourceEventId = socialReconciliationIdentity({ provider: ev.provider, nativeKeyDigest: contentHash(canonicalJson(ev.nativeKey)), immutableDigest: ev.immutableDigest, witnessHash: ev.witnessHash, reason, candidateIds: ev.candidateIds, candidateTotal: ev.candidateTotal });
  ev.snapshotHash = socialRecordSnapshotHash(ev);
  return ev;
}
export function validateSocialReconciliationPending(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'reconciliation pending: not an object';
  if (!SOCIAL_RECORD_SCHEMA_VERSIONS.includes(ev.schemaVersion)) return 'reconciliation pending: unsupported schema version';
  const sealed = ev.schemaVersion === 2;
  const kErr = exactKeys(ev, sealed ? SOCIAL_RECONCILIATION_PENDING_KEYS_V2 : SOCIAL_RECONCILIATION_PENDING_KEYS); if (kErr) return `reconciliation pending: ${kErr}`;
  if (ev.type !== SOCIAL_RECONCILIATION_PENDING_TYPE) return 'reconciliation pending: wrong type';
  const meta = isStr(ev.provider, 100) ? socialProviderById(ev.provider) : null;
  if (!meta) return 'reconciliation pending: provider not in the authoritative social registry';
  if (meta.retentionProhibited || socialRetentionRefusal(ev.provider)) return `reconciliation pending: RETENTION_NOT_APPROVED: ${ev.provider}`;
  if (!SOCIAL_RECONCILIATION_REASONS.includes(ev.reason)) return 'reconciliation pending: unknown reason';
  const c = ev.candidate;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'reconciliation pending: candidate invalid';
  const cErr = exactKeys(c, PENDING_CANDIDATE_KEYS); if (cErr) return `reconciliation pending: candidate ${cErr}`;
  if (c.providerKind !== meta.providerKind) return 'reconciliation pending: providerKind disagrees with the social registry';
  if (!isStr(c.nativePostId, MAX_NATIVE_ID_CHARS) || !isStr(c.nativeAuthorId, MAX_NATIVE_ID_CHARS)) return 'reconciliation pending: native identity invalid';
  if (!SOCIAL_LIFECYCLE_STATES.includes(c.lifecycle) || !SOCIAL_RELATION_KINDS.includes(c.relation)) return 'reconciliation pending: lifecycle/relation invalid';
  if (typeof c.text !== 'string' || c.text.length > MAX_SOCIAL_TEXT_CHARS || c.textHash !== contentHash(normalizeSocialText(c.text))) return 'reconciliation pending: text invalid';
  if (c.providerEventSeq !== null && (!Number.isSafeInteger(c.providerEventSeq) || !PROVIDER_EVENT_SEQ_PROVIDERS.includes(ev.provider))) return 'reconciliation pending: providerEventSeq invalid';
  if (!isTs(c.retrievedTs) || !isTs(ev.knownAtTs) || c.retrievedTs > ev.knownAtTs) return 'reconciliation pending: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'reconciliation pending: ts disagrees with knownAtTs';
  const policies = SOCIAL_CLOCK_POLICY_BY_PROVIDER[ev.provider]; if (!policies) return 'reconciliation pending: provider has no witnessed clock policy';
  const werr = validateTemporalWitness(ev.sourceClockWitness, { expectedPolicyId: policies.source }); if (werr) return `reconciliation pending: ${werr}`;
  if (ev.providerEventWitness !== null) { if (!policies.event) return 'reconciliation pending: provider has no event clock'; const perr = validateTemporalWitness(ev.providerEventWitness, { expectedPolicyId: policies.event }); if (perr) return `reconciliation pending: ${perr}`; }
  if ((ev.sourceClockWitness.projectionMs ?? null) !== c.sourceDeclaredTs) return 'reconciliation pending: sourceDeclaredTs disagrees with its witness';
  if ((ev.providerEventWitness?.projectionMs ?? null) !== c.providerEventTs) return 'reconciliation pending: providerEventTs disagrees with its witness';
  const cl = classifyWitnessedSourceClock({ witness: ev.sourceClockWitness, retrievedTs: c.retrievedTs });
  if (cl.sourceClockStatus !== c.sourceClockStatus || cl.sourceCreatedTs !== c.sourceCreatedTs || cl.sourceClockSkewMs !== c.sourceClockSkewMs) return 'reconciliation pending: clock verdict is not the re-derived one';
  if (ev.witnessHash !== socialWitnessHash({ sourceClockWitness: ev.sourceClockWitness, providerEventWitness: ev.providerEventWitness })) return 'reconciliation pending: witnessHash is not the re-derived binding';
  const keyOf = { ...c, provider: ev.provider };
  if (canonicalJson(ev.nativeKey) !== canonicalJson(socialNativeKey(keyOf))) return 'reconciliation pending: native key does not match the candidate';
  if (ev.immutableDigest !== socialImmutableDigest(keyOf)) return 'reconciliation pending: immutable digest does not match the candidate';
  const facts = { ...keyOf, socialSourceId: socialSourceIdentity({ provider: ev.provider, nativePostId: c.nativePostId }) };
  if (!R2SV_RE.test(ev.candidateVersionId) || ev.candidateVersionId !== socialVersionIdentity(facts)) return 'reconciliation pending: candidateVersionId is not the derived identity';
  if (!Array.isArray(ev.candidateIds) || ev.candidateIds.length > MAX_RECONCILIATION_CANDIDATE_IDS || ev.candidateIds.some((id) => !R2SV_RE.test(id))) return 'reconciliation pending: candidateIds invalid';
  if (canonicalJson([...new Set(ev.candidateIds)].sort()) !== canonicalJson(ev.candidateIds)) return 'reconciliation pending: candidateIds not canonical';
  const shape = socialPendingShapeError(ev); if (shape) return `reconciliation pending: ${shape}`;
  if (sealed) {
    if (!Number.isSafeInteger(ev.candidateTotal) || ev.candidateTotal < ev.candidateIds.length || (ev.candidateTotal > ev.candidateIds.length && ev.candidateIds.length !== MAX_RECONCILIATION_CANDIDATE_IDS)) return 'reconciliation pending: candidateTotal does not describe the bounded target set';
  }
  const expectedId = sealed
    ? socialReconciliationIdentity({ provider: ev.provider, nativeKeyDigest: contentHash(canonicalJson(ev.nativeKey)), immutableDigest: ev.immutableDigest, witnessHash: ev.witnessHash, reason: ev.reason, candidateIds: ev.candidateIds, candidateTotal: ev.candidateTotal })
    : socialReconciliationIdentity({ provider: ev.provider, nativeKeyDigest: contentHash(canonicalJson(ev.nativeKey)), immutableDigest: ev.immutableDigest, witnessHash: ev.witnessHash, reason: ev.reason });
  if (!R2SP_RE.test(ev.sourceEventId) || ev.sourceEventId !== expectedId) return 'reconciliation pending: sourceEventId is not the derived identity';
  if (sealed && ev.snapshotHash !== socialRecordSnapshotHash(ev)) return 'reconciliation pending: snapshotHash is not the re-derived first-known snapshot (altered clocks, targets, or fields under an existing identity)';
  return null;
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
export function xSmokeEvent({ provider, smokeRunId, status, targetPostReads, maxPostReads, headroomPosts, unitPriceUsd, ruleSetHash, coverageEpoch, baselinePeriod, baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads, baselineServerProjectUsage, activatedKnownAtTs, deliveredPostReadsForRun = null, overrunPosts = null, terminalReason = null, completedKnownAtTs = null, knownAtTs }) {
  return {
    type: X_SMOKE_EVENT_TYPE, ts: iso(knownAtTs), sourceEventId: xSmokeIdentity({ provider, smokeRunId, status }), provider, smokeRunId, status,
    targetPostReads, maxPostReads, headroomPosts, unitPriceUsd, ruleSetHash, coverageEpoch,
    baselinePeriod, baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads, baselineServerProjectUsage, activatedKnownAtTs,
    deliveredPostReadsForRun, overrunPosts, terminalReason, completedKnownAtTs, knownAtTs,
  };
}
export function validateXSmokeEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'x smoke: not an object';
  const k = exactKeys(ev, X_SMOKE_EVENT_KEYS); if (k) return `x smoke: ${k}`;
  if (ev.type !== X_SMOKE_EVENT_TYPE) return 'x smoke: wrong type';
  const pe = xProvider(ev); if (pe) return `x smoke: ${pe}`;
  if (typeof ev.smokeRunId !== 'string' || !X_SMOKE_RUN_ID_RE.test(ev.smokeRunId)) return 'x smoke: smokeRunId malformed';
  if (!X_SMOKE_STATUSES.includes(ev.status)) return 'x smoke: unknown status';
  const nn = (v) => Number.isSafeInteger(v) && v >= 0;
  for (const f of ['targetPostReads', 'maxPostReads', 'headroomPosts']) if (!Number.isSafeInteger(ev[f]) || ev[f] <= 0) return `x smoke: ${f} invalid`;
  if (ev.targetPostReads + ev.headroomPosts > ev.maxPostReads) return 'x smoke: target + headroom exceeds max';
  if (!Number.isFinite(ev.unitPriceUsd) || ev.unitPriceUsd < 0) return 'x smoke: unitPriceUsd invalid';
  if (!okHash(ev.ruleSetHash) || !okEpoch(ev.coverageEpoch)) return 'x smoke: ruleSetHash/coverageEpoch invalid';
  if (!okPeriod(ev.baselinePeriod)) return 'x smoke: baselinePeriod invalid';
  for (const f of ['baselineDailyDeliveredPostReads', 'baselineMonthlyDeliveredPostReads', 'baselineServerProjectUsage']) if (!nn(ev[f])) return `x smoke: ${f} invalid`;
  if (ev.baselineDailyDeliveredPostReads > ev.baselineMonthlyDeliveredPostReads) return 'x smoke: baseline day exceeds month';
  if (!isTs(ev.activatedKnownAtTs) || !isTs(ev.knownAtTs) || ev.activatedKnownAtTs > ev.knownAtTs) return 'x smoke: clock invalid';
  if (ev.ts !== iso(ev.knownAtTs)) return 'x smoke: ts disagrees with knownAtTs';
  if (ev.status === 'ACTIVE') {
    if (ev.deliveredPostReadsForRun !== null || ev.overrunPosts !== null || ev.terminalReason !== null || ev.completedKnownAtTs !== null) return 'x smoke: ACTIVE carries terminal fields';
  } else {
    if (!nn(ev.deliveredPostReadsForRun) || !nn(ev.overrunPosts)) return 'x smoke: terminal counts invalid';
    if (!X_GAP_REASONS.includes(ev.terminalReason) && !X_SMOKE_EXTRA_REASONS.includes(ev.terminalReason)) return 'x smoke: unknown terminal reason';
    if (!isTs(ev.completedKnownAtTs) || ev.completedKnownAtTs < ev.activatedKnownAtTs || ev.completedKnownAtTs > ev.knownAtTs) return 'x smoke: completion clock invalid';
    if (ev.status === 'COMPLETE' && ev.terminalReason !== 'SMOKE_TARGET_REACHED') return 'x smoke: COMPLETE requires SMOKE_TARGET_REACHED';
    if (ev.status === 'HEADROOM_OVERRUN' && (ev.terminalReason !== 'SMOKE_HEADROOM_OVERRUN' || ev.overrunPosts < 1 || ev.deliveredPostReadsForRun !== ev.maxPostReads + ev.overrunPosts)) return 'x smoke: HEADROOM_OVERRUN counts disagree';
    if (ev.status === 'COMPLETE' && ev.deliveredPostReadsForRun < ev.targetPostReads) return 'x smoke: COMPLETE below target';
    if (ev.status !== 'HEADROOM_OVERRUN' && ev.overrunPosts !== 0) return 'x smoke: overrun without HEADROOM_OVERRUN';
    if (ev.status === 'ABORTED' && (ev.terminalReason === 'SMOKE_TARGET_REACHED' || ev.terminalReason === 'SMOKE_HEADROOM_OVERRUN')) return 'x smoke: ABORTED with a completion reason';
  }
  if (ev.sourceEventId !== xSmokeIdentity(ev)) return 'x smoke: sourceEventId is not the derived identity';
  return null;
}
export const emptyXState = () => ({ ruleSetHash: null, coverageEpoch: 0, activatedKnownAtTs: null, ruleTags: [], progressThroughTs: null, meter: null, lastGap: null, events: 0, smoke: { runs: {}, activeRunId: null, latestRunId: null } });

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
  // SOCIAL-4D COMPLETION: the version-aware DERIVED index, rooted only in validated durable
  // history — per source id the facts the reconciler needs; per native key the ids that
  // share it; annotations per target; pending ids. Never a second source of truth.
  const index = new Map(); // sourceEventId -> entry
  const byNativeKey = new Map(); // nativeKeyDigest -> Set(sourceEventId)
  const targets = new Map(); // sourceEventId -> the durable observation event (for annotation binding)
  const annotations = new Map(); // targetEventId -> [annotation]
  const annotationIds = new Set();
  const pendingIds = new Set();
  const pendingDigests = new Map();
  const pendingByTarget = new Map(); // candidate target id -> [pending record] whose links HOLD (the as-of view's conflict context)
  const pendingRecords = new Map(); // sourceEventId -> pending record (every retained one, linked or not)
  const pendingUnlinked = []; // legacy (unsealed) pending records whose asserted links do not hold against actual history: retained, never applied
  const recordVersions = { annotations: { 1: 0, 2: 0 }, pending: { 1: 0, 2: 0 } };
  let annotated = 0; let pending = 0;
  const indexObservation = (e) => {
    const entry = socialIndexEntry(e);
    index.set(e.sourceEventId, entry);
    if (!byNativeKey.has(entry.nativeKeyDigest)) byNativeKey.set(entry.nativeKeyDigest, new Set());
    byNativeKey.get(entry.nativeKeyDigest).add(e.sourceEventId);
    targets.set(e.sourceEventId, e);
  };
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
    if (e.type === SOCIAL_EVENT_TYPE || e.type === SOCIAL_EVENT_V2_TYPE) {
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
      indexObservation(e);
      observed += 1;
      continue;
    }
    if (e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE) {
      // an annotation binds an ALREADY-DURABLE target that precedes it in history
      const err = validateSocialClockInterpretation(e, { target: targets.get(e.targetEventId) ?? null });
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const digest = contentHash(canonicalJson(e));
      const prior = digests.get(e.sourceEventId);
      if (prior !== undefined) { if (prior !== digest) return fail('SOCIAL_HISTORY_INVALID: duplicate clock interpretation identity with an altered payload — corruption, not replay'); continue; }
      digests.set(e.sourceEventId, digest);
      annotationIds.add(e.sourceEventId);
      if (!annotations.has(e.targetEventId)) annotations.set(e.targetEventId, []);
      annotations.get(e.targetEventId).push(e);
      recordVersions.annotations[e.schemaVersion] += 1;
      annotated += 1;
      continue;
    }
    if (e.type === SOCIAL_RECONCILIATION_PENDING_TYPE) {
      const err = validateSocialReconciliationPending(e);
      if (err) return fail(`SOCIAL_HISTORY_INVALID: ${err}`);
      const digest = contentHash(canonicalJson(e));
      const prior = pendingDigests.get(e.sourceEventId);
      if (prior !== undefined) { if (prior !== digest) return fail('SOCIAL_HISTORY_INVALID: duplicate reconciliation-pending identity with an altered payload — corruption, not replay'); continue; }
      pendingDigests.set(e.sourceEventId, digest);
      pendingIds.add(e.sourceEventId); // NOT a durable source id — never a social source
      pendingRecords.set(e.sourceEventId, e);
      recordVersions.pending[e.schemaVersion] += 1;
      // SOCIAL-4D RECORD INTEGRITY: every asserted target link is checked against the ACTUAL
      // already-durable targets (they precede this record). A sealed record whose links do not hold
      // is corruption/forgery: the history fails closed. A legacy (unsealed) record whose links do not
      // hold is retained as an unlinked unresolved observation — never applied to any target.
      const ctx = validateSocialPendingContext(e, { targetOf: (id) => targets.get(id) ?? null, annotationsOf: (id) => annotations.get(id) ?? [] });
      if (ctx) {
        if (e.schemaVersion === 2) return fail(`SOCIAL_HISTORY_INVALID: ${ctx}`);
        pendingUnlinked.push({ sourceEventId: e.sourceEventId, reason: ctx.slice(0, 300) });
        pending += 1;
        continue;
      }
      for (const cid of e.candidateIds) { if (!pendingByTarget.has(cid)) pendingByTarget.set(cid, []); pendingByTarget.get(cid).push(e); }
      pending += 1;
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
    if (e.type === X_SMOKE_EVENT_TYPE) {
      const r = xDup(e, validateXSmokeEvent(e)); if (r === 'dup') continue; if (r) return r;
      const runs = x.smoke.runs; const prior = runs[e.smokeRunId];
      if (e.status === 'ACTIVE') {
        if (prior) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} activated twice`);
        if (x.smoke.activeRunId !== null) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} activated while ${x.smoke.activeRunId} is still ACTIVE`);
        if (e.ruleSetHash !== x.ruleSetHash || e.coverageEpoch !== x.coverageEpoch) return fail('SOCIAL_HISTORY_INVALID: X smoke run activated outside the active coverage epoch');
        // the baseline is the meter at activation: never ahead of durable truth
        if (x.meter && x.meter.period === e.baselinePeriod) { if (e.baselineDailyDeliveredPostReads > x.meter.deliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X smoke baseline ahead of the durable meter'); }
        else if (e.baselineDailyDeliveredPostReads !== 0) return fail('SOCIAL_HISTORY_INVALID: X smoke baseline claims reads in a period without a durable meter');
        if (x.meter && x.meter.monthPeriod === e.baselinePeriod.slice(0, 7) && e.baselineMonthlyDeliveredPostReads > x.meter.monthDeliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X smoke monthly baseline ahead of the durable meter');
        runs[e.smokeRunId] = { smokeRunId: e.smokeRunId, status: 'ACTIVE', targetPostReads: e.targetPostReads, maxPostReads: e.maxPostReads, headroomPosts: e.headroomPosts, unitPriceUsd: e.unitPriceUsd, ruleSetHash: e.ruleSetHash, coverageEpoch: e.coverageEpoch, baselinePeriod: e.baselinePeriod, baselineDailyDeliveredPostReads: e.baselineDailyDeliveredPostReads, baselineMonthlyDeliveredPostReads: e.baselineMonthlyDeliveredPostReads, baselineServerProjectUsage: e.baselineServerProjectUsage, activatedKnownAtTs: e.activatedKnownAtTs, deliveredPostReadsForRun: 0, overrunPosts: 0, terminalReason: null, completedKnownAtTs: null };
        x.smoke.activeRunId = e.smokeRunId; x.smoke.latestRunId = e.smokeRunId; x.events += 1;
        continue;
      }
      if (!prior) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} terminal state before activation`);
      if (prior.status !== 'ACTIVE') return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} terminal state after terminal state`);
      for (const f of ['targetPostReads', 'maxPostReads', 'headroomPosts', 'unitPriceUsd', 'ruleSetHash', 'coverageEpoch', 'baselinePeriod', 'baselineDailyDeliveredPostReads', 'baselineMonthlyDeliveredPostReads', 'baselineServerProjectUsage', 'activatedKnownAtTs']) if (e[f] !== prior[f]) return fail(`SOCIAL_HISTORY_INVALID: X smoke run ${e.smokeRunId} terminal ${f} disagrees with its activation`);
      // the terminal count can never be below what the durable meter already attributed to the run
      if (x.meter && x.meter.period === e.baselinePeriod && e.deliveredPostReadsForRun < x.meter.deliveredPostReads - e.baselineDailyDeliveredPostReads) return fail('SOCIAL_HISTORY_INVALID: X smoke terminal delivered count below the durable meter delta');
      runs[e.smokeRunId] = { ...prior, status: e.status, deliveredPostReadsForRun: e.deliveredPostReadsForRun, overrunPosts: e.overrunPosts, terminalReason: e.terminalReason, completedKnownAtTs: e.completedKnownAtTs };
      if (x.smoke.activeRunId === e.smokeRunId) x.smoke.activeRunId = null;
      x.smoke.latestRunId = e.smokeRunId; x.events += 1;
      continue;
    }
    // any other type belongs to the frozen core's own replay/validator
  }
  // SOCIAL-4D CLOSEOUT diagnostic: targets whose retained SOURCE declarations disagree (two
  // non-equivalent annotations of one role). Each record is individually valid and stays; the
  // conflict is surfaced here and by the as-of view — never resolved by arrival order.
  const annotationConflicts = [];
  for (const [targetEventId, list] of annotations) {
    for (const clockRole of SOCIAL_CLOCK_ROLES) {
      const ofRole = list.filter((a) => a.clockRole === clockRole);
      if (ofRole.length > 1 && ofRole.some((a) => !sameDeclaration(a.witness, ofRole[0].witness))) annotationConflicts.push({ targetEventId, clockRole, annotationIds: ofRole.map((a) => a.sourceEventId).sort() });
    }
  }
  return { ok: true, durableIds, cursors, observed, cursorEvents, x, index, byNativeKey, targets, annotations, annotationIds, pendingIds, pendingRecords, pendingByTarget, pendingUnlinked, recordVersions, annotationConflicts, annotated, pending };
}
