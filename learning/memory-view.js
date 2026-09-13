// LEARN-1 / ADDENDUM-2 §04 — two SEPARATE logical retrieval views over the one durable learning store.
//
// RESEARCH memory may contain noticed, contradicted and unvalidated patterns for hypothesis generation. DECISION
// memory resolves ONLY immutable, validated activation artifacts with their exact permitted scope. They are two
// functions, not one function with a mode flag: no query parameter can switch a provisional record into approved
// content, there is no write-on-read, and neighbor/pattern selection is never outcome-aware here. Merely tagging a
// prompt 'research only' is not isolation — isolation is that a decision-influencing consumer is HANDED the
// decision view and cannot reach the research one through it.
import { activationError, deepFreeze } from './contracts.js';

export const MEMORY_VIEW_VERSION = 'learning-memory-view-1';

// hypothesis generation: provisional patterns WITH their contradictions, clearly labelled; zero decision authority
export function readResearchMemory({ store, limit = 200 }) {
  const heads = [...store.patternHeads().values()].slice(0, limit);
  return deepFreeze({
    view: 'RESEARCH', version: MEMORY_VIEW_VERSION, authority: 'NONE',
    law: 'PROVISIONAL_HYPOTHESIS_MATERIAL_NEVER_DECISION_CONTENT',
    patterns: heads.map((p) => ({
      patternId: p.patternId, state: p.state, scope: p.scope, predicate: p.predicate,
      evidence: p.evidence, estimate: p.estimate, contradictions: p.contradictions,
    })),
  });
}

// decision-influencing consumers: immutable validated activation artifacts only. Every head re-earns its way
// through the closed validator at read time; an invalid record is EXCLUDED and reported, never repaired.
export function readDecisionMemory({ store, nowTs }) {
  const heads = [...store.activationHeads().values()];
  const activations = []; const withheld = [];
  for (const a of heads) {
    const err = activationError(a);
    if (err) { withheld.push({ activationId: a?.activationId ?? 'UNKNOWN', reason: 'ACTIVATION_RECORD_INVALID' }); continue; }
    activations.push(a);
  }
  return deepFreeze({
    view: 'DECISION', version: MEMORY_VIEW_VERSION,
    law: 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY',
    preparedTs: nowTs, activations, withheld, kill: store.readKill(),
  });
}
