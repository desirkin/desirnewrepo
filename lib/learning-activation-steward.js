// lib/learning-activation-steward.js — PUBLISH-FIX-14 (2026-09-17, independent review F5): the ONE place a validated
// learned adjustment goes live for PAPER, and the ONE place it expires.
//
// Promotion (learning/promotion.js) publishes an activation as PUBLISHED_WAITING_FOR_PAPER and leaves the pattern in
// VALIDATED_PAPER; nothing in the runtime ever moved either to ACTIVE_PAPER, so the Judge's decision memory (which
// requires BOTH heads to be ACTIVE_PAPER and bound to each other) could never hold an active adjustment. This steward
// runs inside an authorized PAPER runtime on the maintenance cadence and appends the two lawful transitions:
//   PUBLISHED_WAITING_FOR_PAPER -> ACTIVE_PAPER  (reason PAPER_RUNTIME_ADOPTED)   pattern VALIDATED_PAPER -> ACTIVE_PAPER
//   ACTIVE_PAPER past expiresTs -> EXPIRED       (reason LIFETIME_ELAPSED)       pattern ACTIVE_PAPER -> RETIRED
// It creates nothing, validates nothing, scores nothing: it only advances records the promotion law already validated.
// Rollback / suspension stay operator or degrade-rule acts (learning kill / arm, transitionActivation). Authority NONE
// beyond the bounded rank-order nudge the activation itself carries. Every failure is contained and logged.
import { transitionActivation } from '../learning/adapter.js';
import { buildPatternRecord } from '../learning/patterns.js';

export const STEWARD_VERSION = 'learning-activation-steward-1';

export function stewardActivations({ store, nowTs, paperActive = true, log = () => {} }) {
  const out = { activated: [], expired: [], skipped: [] };
  let heads; let patterns;
  try {
    heads = store.activationHeads(); const ph = store.patternHeads();
    patterns = new Map((ph instanceof Map ? [...ph.values()] : Array.isArray(ph) ? ph : []).map((p) => [p.patternId, p]));
  }
  catch (err) { log(`learning steward: journals unreadable (contained): ${String(err?.message ?? err).slice(0, 120)}`); return out; }
  const list = heads instanceof Map ? [...heads.values()] : Array.isArray(heads) ? heads : [];
  for (const a of list) {
    try {
      const pattern = patterns.get(a.patternId) ?? null;
      if (a.state === 'PUBLISHED_WAITING_FOR_PAPER') {
        if (!paperActive) { out.skipped.push({ activationId: a.activationId, reason: 'PAPER_NOT_ACTIVE' }); continue; }
        if (nowTs >= a.expiresTs) { expire(a, pattern, 'LIFETIME_ELAPSED_BEFORE_ACTIVATION'); continue; }
        if (!pattern || pattern.state !== 'VALIDATED_PAPER' || pattern.candidateId !== a.candidateId || pattern.activationId !== a.activationId) { out.skipped.push({ activationId: a.activationId, reason: 'PATTERN_NOT_VALIDATED_FOR_THIS_ACTIVATION' }); continue; }
        // the activation first (its head is what the memory view reads), then the pattern binding
        store.appendActivation(transitionActivation(a, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: nowTs }));
        store.appendPattern(buildPatternRecord({ predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs, ts: nowTs, seq: pattern.seq + 1, state: 'ACTIVE_PAPER', previousState: pattern.state, transitionReason: 'PAPER_RUNTIME_ADOPTED', evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions, candidateId: pattern.candidateId, activationId: a.activationId }));
        out.activated.push({ activationId: a.activationId, patternId: a.patternId, expiresTs: a.expiresTs });
        log(`LEARNING activation ${a.activationId} is ACTIVE_PAPER (pattern ${a.patternId}; ranking-only, max |effect| ${a.allowedEffect?.maxAbsAdjust ?? '?'}; expires ${new Date(a.expiresTs).toISOString()})`);
        continue;
      }
      if (a.state === 'ACTIVE_PAPER' && nowTs >= a.expiresTs) { expire(a, pattern, 'LIFETIME_ELAPSED'); continue; }
    } catch (err) { out.skipped.push({ activationId: a?.activationId ?? 'UNKNOWN', reason: `TRANSITION_FAILED: ${String(err?.message ?? err).slice(0, 100)}` }); log(`learning steward: ${a?.activationId ?? '?'} not advanced (contained): ${String(err?.message ?? err).slice(0, 120)}`); }
  }
  return out;
  function expire(a, pattern, reason) {
    store.appendActivation(transitionActivation(a, { state: 'EXPIRED', transitionReason: reason, ts: nowTs }));
    if (pattern && pattern.state === 'ACTIVE_PAPER' && pattern.activationId === a.activationId) store.appendPattern(buildPatternRecord({ predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs, ts: nowTs, seq: pattern.seq + 1, state: 'RETIRED', previousState: pattern.state, transitionReason: reason, evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions, candidateId: pattern.candidateId, activationId: a.activationId }));
    out.expired.push({ activationId: a.activationId, reason });
    log(`LEARNING activation ${a.activationId} EXPIRED (${reason})`);
  }
}
