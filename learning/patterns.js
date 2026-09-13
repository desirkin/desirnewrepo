// LEARN-1 — provisional pattern memory. A pattern is a closed, versioned record: predicate + scope + evidence +
// estimate + contradictions + lifecycle state, updated by APPEND-ONLY transitions (learning/store.js enforces the
// seq/previousState chain). One observation may create NOTICED and update descriptive memory; only the sealed
// prospective gate (learning/prospective.js) can carry a pattern past CANDIDATE_FROZEN. Contradictions are stored,
// shown and never erased; a failed candidate returns to ACCUMULATING as history, not as a silent reset.
import {
  PATTERN_RECORD_VERSION, AUTHORITY, PURPOSE, EVIDENCE_BASES, LIMITS,
  patternIdOf, patternRecordError, canonicalDigest, utcDateOf, deepFreeze,
} from './contracts.js';
import { assignGroups } from './grouping.js';
import { betaBinomialGrouped } from './estimator.js';
import { classifyOutcome } from './maturation.js';

// evidenceItems: [{ opportunityId, canonicalCoin, decisionTs, evidenceBasis, outcomeClass }] — outcomeClass from
// classifyOutcome over the matured primary horizon. Builds the closed evidence block with grouped counts.
export function buildEvidence(evidenceItems, { commonShockDates = new Set() } = {}) {
  const counts = { FAVORABLE: 'favorable', ADVERSE: 'adverse', NEUTRAL: 'neutral', CENSORED: 'censored', NOT_YET_KNOWN: 'censored', UNAVAILABLE: 'censored' };
  const ev = { rawCount: evidenceItems.length, favorable: 0, adverse: 0, neutral: 0, censored: 0 };
  const byBasis = Object.fromEntries(EVIDENCE_BASES.map((b) => [b, 0]));
  for (const it of evidenceItems) { ev[counts[it.outcomeClass]] += 1; byBasis[it.evidenceBasis] += 1; }
  const grouping = assignGroups(evidenceItems, { commonShockDates });
  const refs = evidenceItems.map((it) => it.opportunityId);
  return deepFreeze({
    rawCount: ev.rawCount, groupCount: grouping.groupCount, distinctAssets: grouping.distinctAssets, distinctUtcDates: grouping.distinctUtcDates,
    favorable: ev.favorable, adverse: ev.adverse, neutral: ev.neutral, censored: ev.censored,
    byBasis, evidenceRefs: refs.slice(0, LIMITS.maxEvidenceRefs), evidenceRefsTruncated: refs.length > LIMITS.maxEvidenceRefs,
    _grouping: grouping, // internal (stripped before persistence)
  });
}

function evidenceForRecord(ev) { const { _grouping, ...rest } = ev; return rest; }

export function estimateFromEvidence(evidenceItems, evidence, { pooledMean, priorStrength, updatedTs, baselineComparator = 'POOLED_SETUP_REGIME_RATE' }) {
  const groups = evidence._grouping.groups.map((g) => {
    const grp = { favorable: 0, adverse: 0, neutral: 0, censored: 0 };
    for (const i of g.members) {
      const cls = evidenceItems[i].outcomeClass;
      if (cls === 'FAVORABLE') grp.favorable += 1; else if (cls === 'ADVERSE') grp.adverse += 1; else if (cls === 'NEUTRAL') grp.neutral += 1; else grp.censored += 1;
    }
    return grp;
  });
  const est = betaBinomialGrouped({ groups, pooledMean, priorStrength });
  return deepFreeze({
    method: est.method, pooledMean: est.pooledMean, posteriorMean: est.posteriorMean, lower95: est.lower95, upper95: est.upper95,
    effectiveGroups: est.effectiveGroups, priorStrength: est.priorStrength, baselineComparator, updatedTs,
  });
}

export function buildPatternRecord({
  predicate, scope, origin, createdTs, ts, seq, state, previousState, transitionReason,
  evidence, estimate = null, contradictions = [], candidateId = null, activationId = null,
}) {
  const predicateDigest = canonicalDigest(predicate);
  const scopeDigest = canonicalDigest(scope);
  const record = {
    patternRecordVersion: PATTERN_RECORD_VERSION, patternId: patternIdOf({ predicateDigest, scopeDigest }), seq, state, previousState,
    transitionReason, ts, predicate, predicateDigest, scope, scopeDigest, origin, createdTs,
    evidence: evidenceForRecord(evidence), estimate, contradictions, candidateId, activationId,
    authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = patternRecordError(record); if (err) throw new Error(`buildPatternRecord: ${err}`);
  return deepFreeze(record);
}

// The learning update for ONE pattern after new matured evidence. Pure decision of the next lifecycle step:
// - first evidence -> NOTICED (seq 0)
// - more evidence  -> ACCUMULATING (descriptive estimate refreshed; contradictions carried, never erased)
// State never advances past ACCUMULATING here — freezing a candidate is an explicit separate act.
export function nextPatternStep({ head, evidenceItems, pooledMean, priorStrength, nowTs, commonShockDates }) {
  const evidence = buildEvidence(evidenceItems, { commonShockDates });
  const estimate = estimateFromEvidence(evidenceItems, evidence, { pooledMean, priorStrength, updatedTs: nowTs });
  const contradictions = evidenceItems.filter((it) => it.outcomeClass === 'ADVERSE').slice(-LIMITS.maxContradictionExamples).map((it) => ({ opportunityId: it.opportunityId, utcDate: utcDateOf(it.decisionTs) }));
  if (!head) {
    return { state: 'NOTICED', previousState: null, seq: 0, transitionReason: 'FIRST_OBSERVATION', evidence, estimate, contradictions };
  }
  if (['CANDIDATE_FROZEN', 'PROSPECTIVE_PENDING', 'VALIDATED_PAPER', 'ACTIVE_PAPER', 'DEGRADED', 'RETIRED'].includes(head.state)) {
    // an active or frozen pattern's own record is immutable from the evidence side: descriptive evidence keeps
    // accruing in the journal but cannot mutate a frozen candidate or an active model in place
    return null;
  }
  return { state: 'ACCUMULATING', previousState: head.state, seq: head.seq + 1, transitionReason: evidenceItems.length > head.evidence.rawCount ? 'NEW_MATURED_EVIDENCE' : 'EVIDENCE_REVISED', evidence, estimate, contradictions };
}

export { classifyOutcome };
