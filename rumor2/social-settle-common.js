import { CURRENT_REQUEST_TYPE, currentRequestError } from './social-current-meter.js';
import { FARCASTER_REQUEST_TYPE, farcasterRequestError } from './social-farcaster-meter.js';
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
import { RESEARCH_DOSSIER_EVENT_TYPE, replayResearchDossierEvent } from './social-research-dossier.js';
import { RESEARCH_SHADOW_EVENT_TYPE, replayResearchShadowEvent, emptyShadowState } from './social-research-shadow.js';

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
// SOCIAL-4F: the CLOSED operational records of the DISCOVERY CATALOG and the
// SOCIAL_ADMISSION_SCOPE — operational evidence only (never a source, never a claim,
// never a logical social count, independence group, packet, or velocity input):
//   RUMOR2_SOCIAL_CATALOG          — ONE accepted catalog CONTENT (written only when the
//                                    content changes; identity = venue + content id)
//   RUMOR2_SOCIAL_CATALOG_VERIFIED — a small freshness record: an unchanged successful refresh
//                                    re-verified that content at a later acquisition clock
//   RUMOR2_SOCIAL_SCOPE            — ONE activation occurrence of an admission scope for ONE
//                                    provider (identity = provider + monotonic revision, so a
//                                    retry is byte-stable and A->B->A stays three occurrences)
export const SOCIAL_CATALOG_EVENT_TYPE = 'RUMOR2_SOCIAL_CATALOG';
export const SOCIAL_CATALOG_VERIFIED_EVENT_TYPE = 'RUMOR2_SOCIAL_CATALOG_VERIFIED';
export const SOCIAL_SCOPE_EVENT_TYPE = 'RUMOR2_SOCIAL_SCOPE';
export const SOCIAL_CATALOG_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'venue', 'quote', 'policyVersion', 'contentId', 'source', 'observedTs', 'counts', 'markets', 'acceptedKnownAtTs']);
export const SOCIAL_CATALOG_VERIFIED_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'venue', 'contentId', 'observedTs', 'knownAtTs']);
export const SOCIAL_SCOPE_EVENT_KEYS = Object.freeze(['type', 'ts', 'sourceEventId', 'provider', 'scopeRevision', 'mode', 'termsFrom', 'catalogContentId', 'catalogObservedTs', 'policyVersion', 'filterId', 'termCount', 'terms', 'aliases', 'watchAuthorIds', 'previousScopeRevision', 'previousFilterId', 'activatedKnownAtTs', 'reason']);
export const SOCIAL_SCOPE_REASONS = Object.freeze(['INITIAL_ACTIVATION', 'CATALOG_CHANGED', 'MODE_CHANGED', 'STALE_RESTORED_SCOPE_REPLACED', 'POLICY_CHANGED']);
export const R2CG_RE = /^r2cg-[0-9a-f]{40}$/;
export const R2CV_RE = /^r2cv-[0-9a-f]{40}$/;
export const R2SQ_RE = /^r2sq-[0-9a-f]{40}$/;
export const socialCatalogIdentity = ({ venue, contentId }) => `r2cg-${contentHash(canonicalJson({ venue, contentId }))}`;
export const socialCatalogVerifiedIdentity = ({ venue, contentId, observedTs }) => `r2cv-${contentHash(canonicalJson({ venue, contentId, observedTs }))}`;
export const socialScopeIdentity = ({ provider, scopeRevision }) => `r2sq-${contentHash(canonicalJson({ provider, scopeRevision }))}`;
// SOCIAL-5A: RUMOR2_RESEARCH_DOSSIER is a Social-side DERIVED research record (authority NONE); it is
// filtered from the frozen-core replay exactly like every other Social truth and replayed strictly here
// SOCIAL-5 §36.6: RUMOR2_RESEARCH_SHADOW_SAMPLE is the bounded research-control (false-negative denominator)
// record — one per sampled completed wide-eye sweep; same fence/replay law, no outcome, authority NONE
export { RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_SHADOW_EVENT_TYPE };
export const SOCIAL_EVENT_TYPES = Object.freeze([CURRENT_REQUEST_TYPE, FARCASTER_REQUEST_TYPE, SOCIAL_EVENT_TYPE, SOCIAL_EVENT_V2_TYPE, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE, X_GAP_EVENT_TYPE, X_SMOKE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE, RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_SHADOW_EVENT_TYPE]);
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

export const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isTs = (v) => Number.isSafeInteger(v);
export const iso = (ms) => new Date(ms).toISOString();

export const exactKeys = (obj, allowed) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `undeclared field '${k}'`;
  for (const k of allowed) if (!(k in obj)) return `missing field '${k}'`;
  return null;
};
