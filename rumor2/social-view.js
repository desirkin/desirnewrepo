// SOCIAL-4D COMPLETION / CLOSEOUT — the narrow, pure, validated AS-OF temporal view.
//   ORIGINAL_RECORDED : exactly the immutable durable event and its first-known facts
//   EFFECTIVE_AS_OF   : that event plus ONLY the supported interpretation annotations whose
//                       own knownAtTs is no later than the requested as-of time
// Laws (SOCIAL-4D CLOSEOUT):
//   * BASE-EVENT ADMISSIBILITY PRECEDES ANNOTATION SELECTION: before the event's own
//     first-known time the result is NOT_YET_KNOWN with no original/effective data — source,
//     declaration, and provider clocks never grant earlier admissibility; firstKnownAtTs is
//     never backdated. (An unrestricted forensic record viewer is a different API.)
//   * a correction known at T1 is invisible to any view asked for asOf < T1 (no hindsight
//     leakage); nothing about withheld future records — ids, counts — is exposed.
//   * LATER ARRIVAL IS NOT PROOF: when the eligible retained declarations of one clock role
//     disagree (non-equivalent annotations, or an eligible DECLARATION_CONFLICT pending record
//     against this event), the effective clock of that role is UNRESOLVED_CONFLICT with no
//     winning declaration; the conflict is exposed with the time it became known.
//   * DETACHED, DEEP-FROZEN SNAPSHOTS: no nested object reachable from a view aliases the
//     caller's input; the caller's input is never frozen or mutated; original and effective
//     cannot contaminate each other.
// A legacy numeric-only clock is labelled UNVERIFIED (its declaration was not retained) —
// never "precision-verified". This is the record/view contract later consumers may use; it
// is not a dashboard, a model, or a decision rule.
import { validateSocialEvent, validateSocialClockInterpretation, validateSocialReconciliationPending, socialPendingLinkError, socialCausalPrecedes, socialSettledPosition, socialSettledOrderError, sameDeclaration, SOCIAL_EVENT_V2_TYPE } from './social-settle.js';
import { compareWitnessToReference, TEMPORAL_ORDER } from './social-time.js';
import { canonicalJson } from './truth.js';

export const SOCIAL_VIEW_MODES = Object.freeze(['ORIGINAL_RECORDED', 'EFFECTIVE_AS_OF']);
export const SOCIAL_VIEW_STATUSES = Object.freeze(['NOT_YET_KNOWN', 'EFFECTIVE']);
export const SOCIAL_CLOCK_PROVENANCE_VIEW = Object.freeze(['LEGACY_NUMERIC_UNVERIFIED', 'WITNESSED_DECLARATION', 'LATER_EVIDENCE_SAME_EVENT', 'CONFLICTING_DECLARATIONS']);
export const SOCIAL_VIEW_CONFLICT_STATE = 'UNRESOLVED_CONFLICT';
export const SOCIAL_VIEW_CLOCK_INTEGRITY = Object.freeze(['ORIGINAL_ONLY', 'SEALED', 'LEGACY_UNSEALED']);

const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };
const detach = (v) => structuredClone(v); // a caller-owned object is never aliased, frozen, or mutated
// FIRST-KNOWN SELECTION (SOCIAL-4D STANDALONE ORDER-CONTEXT VALIDATION): the applied record of a
// role is the earliest-known one. When the DISTINCT records sharing that earliest knownAt
// millisecond number more than one, the actual settled order decides — and EVERY member of that
// tied group must carry a valid position, or the selection is refused in every input permutation
// and no member is silently discarded. A unique earliest record is answerable with no order at
// all, whatever later-known or unrelated records lack positions. Record ids, hashes, caller list
// order and guessed positions never decide.
const firstKnownOf = (records, settledOrder) => {
  if (records.length === 0) return { record: null };
  const earliest = Math.min(...records.map((r) => r.knownAtTs));
  const tied = records.filter((r) => r.knownAtTs === earliest);
  if (tied.length === 1) return { record: tied[0] };
  const positioned = tied.map((r) => ({ r, pos: socialSettledPosition(settledOrder, r.sourceEventId) }));
  if (positioned.some((x) => x.pos === null)) return { error: SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED }; // the WHOLE tied group must be positioned (a duplicate position is already refused as malformed order)
  return { record: positioned.sort((x, y) => x.pos - y.pos)[0].r };
};
// exact duplicate copies of ONE record are one record; a repeated id whose payload differs is
// contradictory input and is refused — an altered duplicate is never harmless
const dedupeById = (records, kind) => {
  const byId = new Map();
  for (const r of records) {
    const prior = byId.get(r.sourceEventId);
    if (prior === undefined) { byId.set(r.sourceEventId, r); continue; }
    if (canonicalJson(prior) !== canonicalJson(r)) return { error: `${kind}: ${r.sourceEventId} supplied twice with an altered payload` };
  }
  return { records: [...byId.values()] };
};
export const SOCIAL_VIEW_FIRST_KNOWN_ORDER_REQUIRED = 'first-known selection among records known at the same millisecond requires the canonical settled order (settledOrder from replaySocialHistory)';

const clockOf = (event) => ({
  sourceDeclaredTs: event.sourceDeclaredTs ?? null, sourceCreatedTs: event.sourceCreatedTs ?? null, sourceClockStatus: event.sourceClockStatus ?? 'UNKNOWN', sourceClockSkewMs: event.sourceClockSkewMs ?? null,
  providerEventTs: event.providerEventTs ?? null,
  sourceClockWitness: event.type === SOCIAL_EVENT_V2_TYPE ? event.sourceClockWitness : null,
  providerEventWitness: event.type === SOCIAL_EVENT_V2_TYPE ? (event.providerEventWitness ?? null) : null,
  provenance: event.type === SOCIAL_EVENT_V2_TYPE ? 'WITNESSED_DECLARATION' : 'LEGACY_NUMERIC_UNVERIFIED',
  precisionVerified: event.type === SOCIAL_EVENT_V2_TYPE,
});

// pending: reconciliation-pending records that name this event among their candidates (the
// narrow conflict context; validated here, never trusted by shape).
// settledOrder: the canonical journal order exported by replaySocialHistory (sourceEventId ->
// position). SUPPORTED CANONICAL USAGE passes it: it is the only lawful tie-breaker for records
// that share a millisecond knownAt. Without it, an equal-clock annotation has UNKNOWN precedence
// and is admitted neither as a conflict's basis (an honest context-required refusal when it would
// be the only basis) nor as its invalidator (no retroactive invalidation); array order is never
// consulted.
export function socialTemporalView({ event, annotations = [], pending = [], asOfTs, settledOrder = null } = {}) {
  if (!Number.isSafeInteger(asOfTs)) return { ok: false, error: 'asOfTs must be a safe-integer millisecond acquisition clock' };
  const oerr = socialSettledOrderError(settledOrder); if (oerr) return { ok: false, error: oerr };
  const verr = validateSocialEvent(event);
  if (verr) return { ok: false, error: verr };
  const ev = detach(event);
  const anns = [];
  for (const a of Array.isArray(annotations) ? annotations : [null]) {
    const aerr = validateSocialClockInterpretation(a, { target: event });
    if (aerr) return { ok: false, error: aerr };
    anns.push(detach(a));
  }
  const annDedupe = dedupeById(anns, 'clock interpretation'); if (annDedupe.error) return { ok: false, error: annDedupe.error };
  anns.length = 0; anns.push(...annDedupe.records);
  const pends = [];
  for (const p of Array.isArray(pending) ? pending : [null]) {
    const perr = validateSocialReconciliationPending(p);
    if (perr) return { ok: false, error: perr };
    if (p.provider !== ev.provider || !p.candidateIds.includes(ev.sourceEventId)) return { ok: false, error: 'reconciliation pending: record does not name this event as a candidate' };
    // SOCIAL-4D RECORD INTEGRITY: the ONE target-context law — a record affects this event only when
    // its asserted relation to THIS event actually holds against the event and its retained
    // annotations; a caller-supplied object saying DECLARATION_CONFLICT proves nothing by itself
    const lerr = socialPendingLinkError(p, event, anns, { precedes: socialCausalPrecedes(settledOrder) });
    if (lerr) return { ok: false, error: `reconciliation pending: context invalid for ${p.reason} against this event: ${lerr}` };
    pends.push(detach(p));
  }
  const pendDedupe = dedupeById(pends, 'reconciliation pending'); if (pendDedupe.error) return { ok: false, error: pendDedupe.error };
  pends.length = 0; pends.push(...pendDedupe.records);
  // base-event admissibility precedes everything else
  if (asOfTs < ev.knownAtTs) return deepFreeze({ ok: true, status: 'NOT_YET_KNOWN', admissible: false, asOfTs, firstKnownAtTs: ev.knownAtTs, original: null, effective: null, appliedAnnotations: [], conflict: null });
  const original = { mode: 'ORIGINAL_RECORDED', firstKnownAtTs: ev.knownAtTs, retrievedTs: ev.retrievedTs, ...clockOf(ev) };
  // selection is decided by firstKnownOf, never by this listing order (kept only for determinism)
  const byKnown = (x, y) => x.knownAtTs - y.knownAtTs;
  const eligibleAnns = anns.filter((a) => a.knownAtTs <= asOfTs).sort(byKnown);
  const eligibleConflicts = pends.filter((p) => p.knownAtTs <= asOfTs && p.reason === 'DECLARATION_CONFLICT').sort(byKnown);
  const eff = { ...detach(original), mode: 'EFFECTIVE_AS_OF', asOfTs, appliedSourceInterpretationId: null, appliedProviderEventInterpretationId: null, interpretationKnownAtTs: null, basis: null };
  // SOURCE DECLARATION role: every eligible retained declaration (the event's own witness for a
  // v2 record, plus eligible annotations) and every eligible conflicting candidate declaration
  // must agree; otherwise no winner is selected
  const srcAnns = eligibleAnns.filter((a) => a.clockRole === 'SOURCE_DECLARATION');
  const retainedSrc = [...(ev.type === SOCIAL_EVENT_V2_TYPE ? [{ witness: ev.sourceClockWitness, id: ev.sourceEventId, knownAtTs: ev.knownAtTs }] : []), ...srcAnns.map((a) => ({ witness: a.witness, id: a.sourceEventId, knownAtTs: a.knownAtTs }))];
  const disputes = [...retainedSrc, ...eligibleConflicts.map((p) => ({ witness: p.sourceClockWitness, id: p.sourceEventId, knownAtTs: p.knownAtTs }))];
  // the disagreement became known the first moment two non-equivalent declarations were BOTH known:
  // an order-independent quantity — no record is picked as "first" by id or by anything else
  let knownAtTs = null;
  for (let i = 0; i < disputes.length; i++) for (let k = i + 1; k < disputes.length; k++) if (!sameDeclaration(disputes[i].witness, disputes[k].witness)) { const both = Math.max(disputes[i].knownAtTs, disputes[k].knownAtTs); if (knownAtTs === null || both < knownAtTs) knownAtTs = both; }
  let conflict = null;
  if (knownAtTs !== null) {
    conflict = { clockRole: 'SOURCE_DECLARATION', knownAtTs, retainedAnnotationIds: srcAnns.map((a) => a.sourceEventId).sort(), pendingIds: eligibleConflicts.map((p) => p.sourceEventId).sort() }; // sorted for DISPLAY only
    Object.assign(eff, { sourceDeclaredTs: null, sourceCreatedTs: null, sourceClockStatus: SOCIAL_VIEW_CONFLICT_STATE, sourceClockSkewMs: null, sourceClockWitness: null, provenance: 'CONFLICTING_DECLARATIONS', precisionVerified: false, interpretationKnownAtTs: knownAtTs, basis: null });
  } else if (srcAnns.length > 0) {
    const srcPick = firstKnownOf(srcAnns, settledOrder); // equivalent values, but the applied RECORD is a historical pointer: never chosen by id
    if (srcPick.error) return { ok: false, error: srcPick.error };
    const src = srcPick.record; // all eligible declarations are equivalent: the first-known (first-settled) one is applied
    Object.assign(eff, { sourceDeclaredTs: src.interpretation.projectionMs, sourceCreatedTs: src.interpretation.sourceCreatedTs, sourceClockStatus: src.interpretation.sourceClockStatus ?? 'UNKNOWN', sourceClockSkewMs: null, sourceClockWitness: src.witness, provenance: src.basis === 'RETAINED_ORIGINAL_DECLARATION' ? 'WITNESSED_DECLARATION' : 'LATER_EVIDENCE_SAME_EVENT', precisionVerified: src.witness.declaredComplete, appliedSourceInterpretationId: src.sourceEventId, interpretationKnownAtTs: src.knownAtTs, basis: src.basis });
  }
  // PROVIDER EVENT role: delivery diagnostics follow the first-known policy — the first eligible
  // retained provider-event witness applies; there is no conflict state for this role
  const pevPick = firstKnownOf(eligibleAnns.filter((a) => a.clockRole === 'PROVIDER_EVENT'), settledOrder);
  if (pevPick.error) return { ok: false, error: pevPick.error };
  const pev = pevPick.record;
  if (pev) { eff.providerEventTs = pev.interpretation.projectionMs; eff.providerEventWitness = pev.witness; eff.appliedProviderEventInterpretationId = pev.sourceEventId; eff.interpretationKnownAtTs = Math.max(eff.interpretationKnownAtTs ?? 0, pev.knownAtTs); }
  eff.conflict = conflict;
  // which later records shaped this effective answer, and whether each carries the version-2
  // first-known snapshot seal; a legacy (version-1) record is applied under its own contract and is
  // labelled UNSEALED — its clocks were never bound, and no seal is manufactured for it
  const applied = [...srcAnns.filter((a) => a.sourceEventId === eff.appliedSourceInterpretationId), ...(pev ? [pev] : []), ...(conflict ? [...srcAnns, ...eligibleConflicts] : [])];
  eff.clockIntegrity = applied.length === 0 ? 'ORIGINAL_ONLY' : applied.every((r) => r.schemaVersion === 2) ? 'SEALED' : 'LEGACY_UNSEALED';
  return deepFreeze({ ok: true, status: 'EFFECTIVE', admissible: true, asOfTs, original, effective: eff, appliedAnnotations: [eff.appliedSourceInterpretationId, eff.appliedProviderEventInterpretationId].filter(Boolean).sort(), conflict });
}

// SUPPORTED CANONICAL USAGE: the view of one event over a validated replay result — the target,
// its retained annotations, the pending records whose links hold, and the settled journal order
// all come from ONE replaySocialHistory call; nothing is sorted into an invented order.
export function socialCanonicalTemporalView({ replay, sourceEventId, asOfTs } = {}) {
  if (!replay || replay.ok !== true || !(replay.targets instanceof Map) || !(replay.settledOrder instanceof Map)) return { ok: false, error: 'a validated replaySocialHistory result is required' };
  const event = replay.targets.get(sourceEventId) ?? null;
  if (!event) return { ok: false, error: 'the event is not a durable social observation of this history' };
  return socialTemporalView({ event, annotations: replay.annotations.get(sourceEventId) ?? [], pending: replay.pendingByTarget.get(sourceEventId) ?? [], asOfTs, settledOrder: replay.settledOrder });
}

// Precision-aware ordering of two witnessed instants (EXACT: both carry a millisecond
// projection and an exact bounded remainder) — or of one witness against an integer
// reference clock (UNRESOLVED when the declaration falls inside the reference's own
// millisecond). Inconclusive => UNRESOLVED/UNKNOWN, never a guessed earlier time.
export function compareSocialInstants(a, b) {
  if (Number.isSafeInteger(b)) return compareWitnessToReference(a, b);
  if (Number.isSafeInteger(a)) { const r = compareWitnessToReference(b, a); return r === 'BEFORE' ? 'AFTER' : r === 'AFTER' ? 'BEFORE' : r; }
  if (!a || !b || a.outcome !== 'INSTANT' || b.outcome !== 'INSTANT') return 'UNKNOWN';
  if (a.projectionMs !== b.projectionMs) return a.projectionMs < b.projectionMs ? 'BEFORE' : 'AFTER';
  const ra = a.subMillisecondRemainder ?? ''; const rb = b.subMillisecondRemainder ?? '';
  const n = Math.max(ra.length, rb.length); const pa = ra.padEnd(n, '0'); const pb = rb.padEnd(n, '0');
  return pa === pb ? 'EQUAL' : pa < pb ? 'BEFORE' : 'AFTER';
}
export { TEMPORAL_ORDER };
