// SOCIAL-4D COMPLETION — the narrow, pure, validated AS-OF temporal view.
//   ORIGINAL_RECORDED : exactly the immutable durable event and its first-known facts
//   EFFECTIVE_AS_OF   : that event plus ONLY the supported interpretation annotations whose
//                       own knownAtTs is no later than the requested as-of time
// Nothing here mutates the event or an annotation; a correction known at T1 is invisible
// to any view asked for asOf < T1 (no hindsight leakage), and the first-known post time
// never moves. A legacy numeric-only clock is labelled UNVERIFIED (its declaration was not
// retained) — never "precision-verified". This is the record/view contract later
// consumers may use; it is not a dashboard, a model, or a decision rule.
import { validateSocialEvent, validateSocialClockInterpretation, SOCIAL_EVENT_V2_TYPE } from './social-settle.js';
import { compareWitnessToReference, TEMPORAL_ORDER } from './social-time.js';

export const SOCIAL_VIEW_MODES = Object.freeze(['ORIGINAL_RECORDED', 'EFFECTIVE_AS_OF']);
export const SOCIAL_CLOCK_PROVENANCE_VIEW = Object.freeze(['LEGACY_NUMERIC_UNVERIFIED', 'WITNESSED_DECLARATION', 'LATER_EVIDENCE_SAME_EVENT']);

const clockOf = (event) => Object.freeze({
  sourceDeclaredTs: event.sourceDeclaredTs ?? null, sourceCreatedTs: event.sourceCreatedTs ?? null, sourceClockStatus: event.sourceClockStatus ?? 'UNKNOWN', sourceClockSkewMs: event.sourceClockSkewMs ?? null,
  providerEventTs: event.providerEventTs ?? null,
  sourceClockWitness: event.type === SOCIAL_EVENT_V2_TYPE ? event.sourceClockWitness : null,
  providerEventWitness: event.type === SOCIAL_EVENT_V2_TYPE ? (event.providerEventWitness ?? null) : null,
  provenance: event.type === SOCIAL_EVENT_V2_TYPE ? 'WITNESSED_DECLARATION' : 'LEGACY_NUMERIC_UNVERIFIED',
  precisionVerified: event.type === SOCIAL_EVENT_V2_TYPE,
});

export function socialTemporalView({ event, annotations = [], asOfTs } = {}) {
  if (!Number.isSafeInteger(asOfTs)) return { ok: false, error: 'asOfTs must be a safe-integer millisecond clock' };
  const verr = validateSocialEvent(event);
  if (verr) return { ok: false, error: verr };
  const valid = [];
  for (const a of Array.isArray(annotations) ? annotations : []) {
    const aerr = validateSocialClockInterpretation(a, { target: event });
    if (aerr) return { ok: false, error: aerr };
    valid.push(a);
  }
  const original = Object.freeze({ mode: 'ORIGINAL_RECORDED', firstKnownAtTs: event.knownAtTs, retrievedTs: event.retrievedTs, ...clockOf(event) });
  // deterministic selection per clock role: the latest interpretation known no later than asOf; ties by id
  const pick = (role) => valid.filter((a) => a.clockRole === role && a.knownAtTs <= asOfTs).sort((x, y) => (y.knownAtTs - x.knownAtTs) || (x.sourceEventId < y.sourceEventId ? -1 : 1))[0] ?? null;
  const src = pick('SOURCE_DECLARATION'); const pev = pick('PROVIDER_EVENT');
  const withheld = valid.filter((a) => a.knownAtTs > asOfTs).map((a) => a.sourceEventId).sort();
  const eff = { ...original, mode: 'EFFECTIVE_AS_OF', asOfTs, appliedSourceInterpretationId: null, appliedProviderEventInterpretationId: null, interpretationKnownAtTs: null, basis: null };
  if (src) {
    eff.sourceDeclaredTs = src.interpretation.projectionMs; eff.sourceCreatedTs = src.interpretation.sourceCreatedTs; eff.sourceClockStatus = src.interpretation.sourceClockStatus ?? 'UNKNOWN'; eff.sourceClockSkewMs = null;
    eff.sourceClockWitness = src.witness; eff.provenance = src.basis === 'RETAINED_ORIGINAL_DECLARATION' ? 'WITNESSED_DECLARATION' : 'LATER_EVIDENCE_SAME_EVENT'; eff.precisionVerified = src.witness.declaredComplete;
    eff.appliedSourceInterpretationId = src.sourceEventId; eff.interpretationKnownAtTs = src.knownAtTs; eff.basis = src.basis;
  }
  if (pev) { eff.providerEventTs = pev.interpretation.projectionMs; eff.providerEventWitness = pev.witness; eff.appliedProviderEventInterpretationId = pev.sourceEventId; eff.interpretationKnownAtTs = Math.max(eff.interpretationKnownAtTs ?? 0, pev.knownAtTs); }
  return Object.freeze({ ok: true, asOfTs, original, effective: Object.freeze(eff), availableAnnotations: valid.length, appliedAnnotations: [src?.sourceEventId, pev?.sourceEventId].filter(Boolean).sort(), withheldAnnotations: withheld });
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
