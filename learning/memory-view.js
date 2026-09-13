// LEARN-1 / ADDENDUM-2 §04 — two SEPARATE logical retrieval views over the one durable learning store.
//
// RESEARCH memory may contain noticed, contradicted and unvalidated patterns for hypothesis generation. DECISION
// memory resolves ONLY immutable, validated activation artifacts with their exact permitted scope. They are two
// functions, not one function with a mode flag: no query parameter can switch a provisional record into approved
// content, there is no write-on-read, and neighbor/pattern selection is never outcome-aware here. Merely tagging a
// prompt 'research only' is not isolation — isolation is that a decision-influencing consumer is HANDED the
// decision view and cannot reach the research one through it.
import { activationError, canonicalDigest, deepFreeze } from './contracts.js';
import { replayProspective } from './prospective.js';

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
  const history = typeof store.activationHistory === 'function'
    ? store.activationHistory()
    : { heads: new Map(), invalid: new Map(), globalErrors: ['ACTIVATION_HISTORY_UNAVAILABLE'] };
  const heads = [...history.heads.values()];
  const activations = [];
  const withheld = [
    ...[...history.invalid.entries()].map(([activationId, reason]) => ({ activationId, reason: `ACTIVATION_HISTORY_INVALID:${reason}` })),
    ...history.globalErrors.map((reason) => ({ activationId: 'UNKNOWN', reason: `ACTIVATION_HISTORY_INVALID:${reason}` })),
  ];
  if (history.globalErrors.length) {
    return deepFreeze({ view: 'DECISION', version: MEMORY_VIEW_VERSION, law: 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY', preparedTs: nowTs, activations: [], withheld, kill: store.readKill() });
  }
  const patterns = store.patternHeads();
  let records = []; let prospective = null;
  try {
    if (heads.length) {
      records = store.readProspective();
      prospective = replayProspective(records);
      if (prospective.errors.length) throw new Error('prospective evidence invalid');
    }
  } catch {
    return deepFreeze({ view: 'DECISION', version: MEMORY_VIEW_VERSION, law: 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY', preparedTs: nowTs, activations: [], withheld: [...withheld, ...heads.map((a) => ({ activationId: a?.activationId ?? 'UNKNOWN', reason: 'PROSPECTIVE_EVIDENCE_INVALID' }))], kill: store.readKill() });
  }
  for (const a of heads) {
    const err = activationError(a);
    if (err) { withheld.push({ activationId: a?.activationId ?? 'UNKNOWN', reason: 'ACTIVATION_RECORD_INVALID' }); continue; }
    if (a.state === 'ACTIVE_PAPER') {
      const pattern = patterns.get(a.patternId);
      if (!pattern || pattern.state !== 'ACTIVE_PAPER' || pattern.activationId !== a.activationId || pattern.candidateId !== a.candidateId) {
        // Adoption spans two append-only journals.  Until both exact heads are
        // present, the partial write has no decision authority and remains
        // visible for deterministic operator recovery.
        withheld.push({ activationId: a.activationId, reason: 'ACTIVE_PATTERN_BINDING_MISSING' }); continue;
      }
      if (!Number.isSafeInteger(pattern.ts) || pattern.ts > nowTs) {
        withheld.push({ activationId: a.activationId, reason: 'ACTIVE_PATTERN_NOT_EFFECTIVE' }); continue;
      }
    }
    const design = prospective?.designs.get(a.candidateId);
    const terminal = prospective?.terminals.get(a.candidateId);
    if (!design || !terminal || terminal.verdict !== 'FORWARD_SUPPORTED' || terminal.recordedTs > a.effectiveTs || a.ts > nowTs) {
      withheld.push({ activationId: a.activationId, reason: 'VALIDATED_EVIDENCE_MISSING' }); continue;
    }
    const evidence = records.filter((r) => (r.candidateId ?? r.design?.candidateId) === a.candidateId && r.kind !== 'TERMINAL_EVALUATED');
    const scope = { setupType: String(design.scope?.setupType ?? 'ANY'), regime: String(design.scope?.regime ?? 'ANY'), assets: Array.isArray(design.scope?.assets) && design.scope.assets.length ? design.scope.assets : 'ANY', venues: Array.isArray(design.scope?.venues) && design.scope.venues.length ? design.scope.venues : 'ANY' };
    const validation = { evidenceBasis: 'PROSPECTIVE', groupCount: terminal.maturedGroups, assetCount: terminal.distinctAssets, dateCount: terminal.distinctUtcDates, netAfterCostsPct: terminal.effect?.pairedMeanDiff };
    if (a.patternId !== design.patternId || a.trainingCutoffTs !== design.sealedTs
        || a.candidateDigest !== canonicalDigest(design) || a.evidenceDigest !== canonicalDigest(evidence) || a.reportDigest !== canonicalDigest(terminal)
        || !design.consumerBinding || a.featureRecipeVersion !== design.consumerBinding.featureRecipeVersion
        || a.policyVersion !== design.consumerBinding.policyDigest
        || canonicalDigest(a.applicability) !== canonicalDigest(design.predicate)
        || canonicalDigest(a.scope) !== canonicalDigest(scope) || canonicalDigest(a.validation) !== canonicalDigest(validation)
        || a.maxSizeUsd !== null) {
      // This prospective producer has no depth-supported sizing study. A supplied size limit cannot invent one.
      withheld.push({ activationId: a.activationId, reason: 'ACTIVATION_EVIDENCE_MISMATCH' }); continue;
    }
    activations.push(a);
  }
  return deepFreeze({
    view: 'DECISION', version: MEMORY_VIEW_VERSION,
    law: 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY',
    preparedTs: nowTs, activations, withheld, kill: store.readKill(),
  });
}
