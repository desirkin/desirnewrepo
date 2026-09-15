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
import { SOCIAL_EQUIVALENCE_VERDICTS, assessSocialEquivalence, deriveClockInterpretation, reconstructSocialWitness, sameDeclaration, socialClockInterpretationEvent, socialCoarseKey, socialCoarseKeyDigest, socialImmutableDigest, socialIndexEntry, socialInterpretationIdentity, socialNativeKey, socialNativeKeyDigest, socialObservationToEvent, socialRecordSnapshotHash, socialSeenRecord, validateSocialClockInterpretation, validateSocialEvent, validateSocialEventV2 } from './events.js';

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
// ---- SOCIAL-4D EQUAL-CLOCK CAUSAL CONTEXT: the precedence contract -----------------------------
// Whether an annotation was AVAILABLE to a pending record is decided by knowledge time first and,
// for the same recorded millisecond, by the settled journal order — never by array presentation
// order, ids/hashes, source or provider clocks, or an invented extra millisecond:
//   true   — the annotation's knownAtTs is strictly earlier, or equal AND it settled before the record
//   false  — strictly later, or equal AND it settled after the record
//   null   — equal millisecond with no settled order available (a standalone array view)
// A null precedence is admitted NEITHER as the basis of a conflict (a later annotation cannot
// retrospectively supply the only missing basis) NOR as its invalidator (a conflict established by
// the accepted causal prefix is never retroactively invalidated). `settledOrder` is the canonical
// journal order (sourceEventId -> position) that replaySocialHistory exports; the view passes it
// through so the canonical full-history path and replay judge the SAME context.
// CONSOLIDATED CAUSAL-ORDER LAW: availability requires BOTH (1) knowledge-time admissibility —
// the annotation's knownAtTs is no later than the record's (equality inclusive) — AND (2) membership
// of the record's PRECEDING SETTLED CONTEXT — it settled before the record in the journal. With the
// canonical settled order both are checked for earlier, equal, and later clocks alike: a later
// append can never retroactively invalidate (or supply) the reason for an earlier conflict merely
// because it carries an earlier or equal recorded clock. A verified prefix reader establishes (2)
// from the actual prefix (socialPrefixPrecedes); an arbitrary full-list caller may not claim it by
// assumption, so without a settled position for BOTH records the answer is null (unknown).
export const socialSettledPosition = (settledOrder, id) => { const p = settledOrder instanceof Map ? settledOrder.get(id) : Array.isArray(settledOrder) ? settledOrder.indexOf(id) : undefined; return Number.isSafeInteger(p) && p >= 0 ? p : null; };
// SOCIAL-4D STANDALONE ORDER-CONTEXT VALIDATION: a supplied settled order is a CONTEXT, never an
// authority — this pure check only establishes its INTERNAL CONSISTENCY: every position is a safe
// non-negative integer, no two DISTINCT record ids claim the same settled position, and the id-list
// representation carries no id twice as a competing settlement entry. Holes are legitimate: the
// canonical order also holds unrelated sources and operationally irrelevant records, and a subset
// Map is valid input. A coherent but fabricated map is NOT thereby authenticated; canonical usage
// remains the order derived from validated journal replay.
export const SOCIAL_SETTLED_ORDER_INVALID = 'settledOrder is malformed — it cannot fall back to timestamp, id, or array order';
export function socialSettledOrderError(settledOrder) {
  if (settledOrder === null || settledOrder === undefined) return null;
  const entries = settledOrder instanceof Map ? [...settledOrder.entries()] : Array.isArray(settledOrder) ? settledOrder.map((id, i) => [id, i]) : null;
  if (entries === null) return 'settledOrder must be the Map (or id list) exported by replaySocialHistory';
  const seenIds = new Set(); const byPosition = new Map();
  for (const [id, pos] of entries) {
    if (typeof id !== 'string' || id.length === 0) return `${SOCIAL_SETTLED_ORDER_INVALID}: a record id is not a non-empty string`;
    if (!Number.isSafeInteger(pos) || pos < 0) return `${SOCIAL_SETTLED_ORDER_INVALID}: the position of ${id} is not a safe non-negative integer`;
    if (seenIds.has(id)) return `${SOCIAL_SETTLED_ORDER_INVALID}: ${id} appears twice as a competing settlement entry`;
    seenIds.add(id);
    const other = byPosition.get(pos);
    if (other !== undefined) return `${SOCIAL_SETTLED_ORDER_INVALID}: ${other} and ${id} claim the same settled position ${pos}`;
    byPosition.set(pos, id);
  }
  return null;
}
export function socialCausalPrecedes(settledOrder = null) {
  return (a, ev) => {
    if (!Number.isSafeInteger(a?.knownAtTs) || !Number.isSafeInteger(ev?.knownAtTs)) return false;
    if (a.knownAtTs > ev.knownAtTs) return false; // knowledge-time admissibility fails whatever the order
    const pa = socialSettledPosition(settledOrder, a?.sourceEventId); const pe = socialSettledPosition(settledOrder, ev?.sourceEventId);
    if (pa !== null && pe !== null) return pa < pe; // admissible AND settled before
    return null; // prefix membership cannot be established from this context
  };
}
// the precedence a CAUSAL PREFIX reader may assert: every annotation it holds settled before the
// record it is checking, so knowledge time alone (equality inclusive) decides
export const socialPrefixPrecedes = (a, ev) => Number.isSafeInteger(a?.knownAtTs) && Number.isSafeInteger(ev?.knownAtTs) && a.knownAtTs <= ev.knownAtTs;
export const SOCIAL_CONTEXT_ORDER_REQUIRED = 'the settled order of a retained declaration is unknown in this context — the canonical journal order (settledOrder from replaySocialHistory) is required to establish the basis';

export function socialPendingLinkError(ev, target, annotations = [], { precedes = socialCausalPrecedes(null) } = {}) {
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
    // CAUSAL-CONTEXT LAW (SOCIAL-4D UNRESOLVED-CACHE + CAUSAL-CONTEXT CLOSEOUT): the record's reason is
    // judged with the target facts available NO LATER than the record's own knownAtTs. Annotations
    // known later can neither justify an earlier conflict nor retroactively invalidate one; the
    // millisecond clock contract admits equality. Integrity validation of those later records is a
    // separate concern (they are validated on their own, never ignored).
    const ofRole = (Array.isArray(annotations) ? annotations : []).filter((a) => a && a.clockRole === 'SOURCE_DECLARATION' && a.targetEventId === target.sourceEventId);
    const available = ofRole.filter((a) => precedes(a, ev) === true).map((a) => a.witness);
    const orderUnknown = ofRole.filter((a) => precedes(a, ev) === null);
    const retained = [...(target.type === SOCIAL_EVENT_V2_TYPE ? [target.sourceClockWitness] : []), ...available];
    if (retained.length === 0) return orderUnknown.length > 0 ? SOCIAL_CONTEXT_ORDER_REQUIRED : 'target retained no original declaration to conflict with (a legacy numeric clock is not one)';
    if (retained.some((w) => sameDeclaration(w, ev.sourceClockWitness))) return 'the candidate declaration is equivalent to a retained declaration — no conflict';
    return null;
  }
  return null; // MULTIPLE_CANDIDATES: the same native occurrence suffices
}
// the whole asserted target SET against actual history: targetOf(id) -> durable observation event
// or null; annotationsOf(id) -> that target's retained annotations. null when every link holds.
export function validateSocialPendingContext(ev, { targetOf, annotationsOf = () => [], precedes = socialCausalPrecedes(null) } = {}) {
  if (typeof targetOf !== 'function') return 'reconciliation pending: no target context supplied';
  const shape = socialPendingShapeError(ev); if (shape) return `reconciliation pending: ${shape}`;
  for (const id of ev.candidateIds) {
    const target = targetOf(id) ?? null;
    const err = socialPendingLinkError(ev, target, annotationsOf(id), { precedes });
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
