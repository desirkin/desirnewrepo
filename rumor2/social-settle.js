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
// SOCIAL-1 closeout barrel (LEAN PASS 3) — the implementation is split by concern into the
// sibling modules ./social-settle-{common,events,reconciliation,operational,replay}.js.
// This module re-exports the exact same public surface; every importer is unchanged.
export {
  MAX_RECONCILIATION_CANDIDATE_IDS, PROVIDER_EVENT_SEQ_PROVIDERS, R2CG_RE, R2CV_RE, R2SC_RE, R2SI_RE, R2SP_RE, R2SQ_RE, RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_SHADOW_EVENT_TYPE, SOCIAL_CATALOG_EVENT_KEYS, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_KEYS, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_CLOCK_INTERPRETATION_KEYS, SOCIAL_CLOCK_INTERPRETATION_KEYS_V2, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_CLOCK_POLICY_BY_PROVIDER, SOCIAL_CLOCK_PROVENANCE, SOCIAL_CLOCK_ROLES, SOCIAL_CURSOR_EVENT_KEYS, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_SCHEMA_VERSION, SOCIAL_EVENT_TYPE, SOCIAL_EVENT_TYPES, SOCIAL_EVENT_V2_KEYS, SOCIAL_EVENT_V2_TYPE, SOCIAL_INTERPRETATION_BASES, SOCIAL_OBSERVATION_TYPES, SOCIAL_RECONCILIATION_PENDING_KEYS, SOCIAL_RECONCILIATION_PENDING_KEYS_V2, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_RECONCILIATION_REASONS, SOCIAL_RECORD_SCHEMA_VERSION, SOCIAL_RECORD_SCHEMA_VERSIONS, SOCIAL_SCOPE_EVENT_KEYS, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_SCOPE_REASONS, X_GAP_EVENT_KEYS, X_GAP_EVENT_TYPE, X_GAP_REASONS, X_METER_EVENT_KEYS, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_KEYS, X_PROGRESS_EVENT_TYPE, X_RULESET_EVENT_KEYS, X_RULESET_EVENT_TYPE, X_SMOKE_EVENT_KEYS, X_SMOKE_EVENT_TYPE, X_SMOKE_EXTRA_REASONS, X_SMOKE_RUN_ID_RE, X_SMOKE_STATUSES, X_SMOKE_TERMINAL_STATUSES, X_STATE_PROVIDERS, isSocialEventType, socialCatalogIdentity, socialCatalogVerifiedIdentity, socialCursorIdentity, socialScopeIdentity, xGapIdentity, xMeterIdentity, xProgressIdentity, xRuleSetIdentity, xSmokeIdentity,
} from './social-settle-common.js';
export {
  SOCIAL_EQUIVALENCE_VERDICTS, assessSocialEquivalence, deriveClockInterpretation, reconstructSocialWitness, sameDeclaration, socialClockInterpretationEvent, socialCoarseKey, socialCoarseKeyDigest, socialImmutableDigest, socialIndexEntry, socialInterpretationIdentity, socialNativeKey, socialNativeKeyDigest, socialObservationToEvent, socialRecordSnapshotHash, socialSeenRecord, validateSocialClockInterpretation, validateSocialEvent, validateSocialEventV2,
} from './social-settle-events.js';
export {
  SOCIAL_CONTEXT_ORDER_REQUIRED, SOCIAL_SETTLED_ORDER_INVALID, socialCausalPrecedes, socialPendingLinkError, socialPrefixPrecedes, socialReconciliationIdentity, socialReconciliationPendingEvent, socialSettledOrderError, socialSettledPosition, validateSocialPendingContext, validateSocialReconciliationPending,
} from './social-settle-reconciliation.js';
export {
  emptyXState, socialCatalogEvent, socialCatalogVerifiedEvent, socialCursorEvent, socialScopeEvent, validateSocialCatalogEvent, validateSocialCatalogVerifiedEvent, validateSocialCursorEvent, validateSocialScopeEvent, validateXGapEvent, validateXMeterEvent, validateXProgressEvent, validateXRuleSetEvent, validateXSmokeEvent, xGapEvent, xMeterEvent, xProgressEvent, xRuleSetEvent, xSmokeEvent,
} from './social-settle-operational.js';
export {
  replaySocialHistory,
} from './social-settle-replay.js';
