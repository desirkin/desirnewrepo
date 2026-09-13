// LEARN-1 / ADDENDUM-2 §01 — the shared, pure provenance and temporal-integrity contract.
//
// PLACEMENT NOTE (a flagged, documented deviation from the addendum's proposed path): the addendum proposed
// research/model-integrity.js consumed by production, but the repository's operational fence
// (test/social-5b-fences.test.js F2) forbids ANY operational module from importing research/*. Per the addendum's
// own allowance ("a renamed module is acceptable"), the neutral contract lives HERE, importable by learning and by
// the Judge's consumer seam alike. It is PURE: explicit inputs (time included), no filesystem, network, environment,
// scheduler, model, account or execution operation, and it imports nothing beyond learning/contracts.js primitives.
//
// The contract is NEUTRAL: model/packet identity, clocks, dependency roles, temporal origin, findings. Trading
// eligibility, position sizes and activation state stay with the consuming host policy — a producer cannot set its
// own trusted flag and thereby pass (undeclared keys are refused; there is no such field to set). Passing integrity
// establishes NO edge: integrity eligibility and predictive usefulness are separate checks, and a black-box test
// cannot prove an opaque model's weights contain no future information. Nothing here labels anything 'bias-free'.
import { isPlainObject, isTs, isFiniteNum, exactKeys, deepFreeze } from './contracts.js';

export const MODEL_PROVENANCE_VERSION = 'learning-model-provenance-1';
export const CALL_CLASSES = Object.freeze(['HISTORICAL_RECONSTRUCTION', 'CONTAMINATION_DIAGNOSTIC', 'PROSPECTIVE_SHADOW', 'RETROSPECTIVE_EXPLANATION']);
// provenance classifications, not performance grades
export const TEMPORAL_CLASSES = Object.freeze(['DETERMINISTIC_REPLAY', 'HISTORICAL_LLM_AT_RISK', 'DOCUMENTED_PIT_RECONSTRUCTION', 'PROSPECTIVE_SHADOW', 'SYNTHETIC_DIAGNOSTIC']);
export const DEPENDENCY_ROLES = Object.freeze(['RUNTIME_INPUT', 'FITTED_PARAMETER', 'VALIDATION_EVIDENCE', 'HYPOTHESIS_ANCESTRY']);
// host-validated dispositions (the consuming host computes these; they are never producer fields)
export const USE_CLASSES = Object.freeze(['ANNOTATION_ONLY', 'SHADOW_ONLY', 'DECISION_ELIGIBLE']);
export const CUTOFF_STATES = Object.freeze(['DOCUMENTED_ADVERTISED', 'INDEPENDENTLY_AUDITED', 'UNKNOWN']);
export const VERSION_UNPINNED = 'VERSION_UNPINNED'; // a floating alias is not a pinned version

export const MODEL_PROVENANCE_KEYS = Object.freeze([
  'provenanceVersion', 'provider', 'requestedModel', 'responseModel', 'snapshotVersion', 'systemFingerprint', 'invocationTs',
  'cutoff', 'promptDigest', 'evidenceDigest', 'asOfTs', 'retrievalConfig', 'sampling', 'outputDigest', 'parsedAssessmentDigest',
  'declaredUncertainty', 'evidenceRefs', 'requestId', 'usage', 'errorState', 'callClass',
]);
export const CUTOFF_KEYS = Object.freeze(['state', 'boundaryTs', 'docRef', 'retrievedTs']);
export const SAMPLING_KEYS = Object.freeze(['temperature', 'seed', 'determinismClaim']);

export function validateModelProvenance(r) {
  const k = exactKeys(r, MODEL_PROVENANCE_KEYS); if (k) return `model provenance: ${k}`;
  if (r.provenanceVersion !== MODEL_PROVENANCE_VERSION) return 'model provenance: unsupported version';
  for (const f of ['provider', 'requestedModel', 'promptDigest', 'evidenceDigest']) if (typeof r[f] !== 'string' || r[f].length === 0 || r[f].length > 200) return `model provenance: ${f} malformed`;
  if (r.responseModel !== null && (typeof r.responseModel !== 'string' || r.responseModel.length === 0)) return 'model provenance: responseModel malformed (null = provider did not expose it — never invented)';
  if (typeof r.snapshotVersion !== 'string' || r.snapshotVersion.length === 0) return `model provenance: snapshotVersion malformed (use '${VERSION_UNPINNED}' honestly)`;
  if (r.systemFingerprint !== null && typeof r.systemFingerprint !== 'string') return 'model provenance: systemFingerprint malformed';
  if (!isTs(r.invocationTs) || !isTs(r.asOfTs)) return 'model provenance: clocks malformed';
  const ck = exactKeys(r.cutoff, CUTOFF_KEYS); if (ck) return `model provenance: cutoff ${ck}`;
  if (!CUTOFF_STATES.includes(r.cutoff.state)) return 'model provenance: unknown cutoff state';
  if (r.cutoff.state === 'UNKNOWN') { if (r.cutoff.boundaryTs !== null) return 'model provenance: an UNKNOWN cutoff carries no boundary'; }
  else if (!isTs(r.cutoff.boundaryTs) || typeof r.cutoff.docRef !== 'string' || !isTs(r.cutoff.retrievedTs)) return 'model provenance: a documented cutoff needs its boundary, documentation reference and retrieval time';
  const sk = exactKeys(r.sampling, SAMPLING_KEYS); if (sk) return `model provenance: sampling ${sk}`;
  if (r.sampling.temperature !== null && !isFiniteNum(r.sampling.temperature)) return 'model provenance: temperature malformed';
  if (r.sampling.determinismClaim !== false) return 'model provenance: determinism is never claimed merely because a seed was supplied';
  if (!CALL_CLASSES.includes(r.callClass)) return 'model provenance: unknown call class';
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length > 128) return 'model provenance: evidence refs malformed';
  if (r.errorState !== null && typeof r.errorState !== 'string') return 'model provenance: error state malformed';
  return null;
}

// classify ONE evidence record's temporal integrity. explicitContext:
//   { synthetic, hasLlmDependency, provenance|null, decisionRecordedTs|null, outcomeStartTs|null, periodStartTs|null }
// Returns { class, reasons, limitations } — honest labels, never a purity certificate.
export function classifyTemporalEvidence({ synthetic = false, hasLlmDependency = false, provenance = null, decisionRecordedTs = null, outcomeStartTs = null, periodStartTs = null } = {}) {
  const out = (cls, reasons, limitations = []) => deepFreeze({ class: cls, reasons, limitations });
  if (synthetic) return out('SYNTHETIC_DIAGNOSTIC', ['DECLARED_SYNTHETIC'], ['NOT_REAL_INVESTMENT_EVIDENCE']);
  if (!hasLlmDependency) return out('DETERMINISTIC_REPLAY', ['NO_LLM_DECISION_FEATURE_OR_LABEL_IN_PATH']);
  if (provenance === null || validateModelProvenance(provenance) !== null) return out('HISTORICAL_LLM_AT_RISK', ['PROVENANCE_MISSING_OR_INVALID'], ['UNKNOWN_IS_AT_RISK_NOT_TRUSTED']);
  if (provenance.callClass === 'PROSPECTIVE_SHADOW') {
    // an actual pre-outcome seal is the ONLY thing that makes a record prospective: a response created after the
    // evaluated outcome, or with no sealed decision clock, is not prospective however its prompt was worded
    if (isTs(decisionRecordedTs) && isTs(outcomeStartTs) && decisionRecordedTs < outcomeStartTs && provenance.invocationTs <= decisionRecordedTs) {
      return out('PROSPECTIVE_SHADOW', ['RECORDED_BEFORE_OUTCOME'], provenance.snapshotVersion === VERSION_UNPINNED ? ['MODEL_VERSION_UNPINNED'] : []);
    }
    return out('HISTORICAL_LLM_AT_RISK', ['CLAIMED_PROSPECTIVE_WITHOUT_PRE_OUTCOME_SEAL']);
  }
  if (provenance.callClass === 'CONTAMINATION_DIAGNOSTIC') return out('SYNTHETIC_DIAGNOSTIC', ['DIAGNOSTIC_CALL_CLASS'], ['NOT_REAL_INVESTMENT_EVIDENCE']);
  // historical evaluation: only an INDEPENDENTLY AUDITED boundary strictly before the evaluated period supports a
  // documented reconstruction; an advertised cutoff keeps the vendor-claim limitation; UNKNOWN/overlap stays at risk
  if (provenance.cutoff.state !== 'UNKNOWN' && isTs(periodStartTs) && provenance.cutoff.boundaryTs < periodStartTs) {
    const limitations = ['RECONSTRUCTION_NOT_ORIGINAL_FORWARD_DECISION'];
    if (provenance.cutoff.state === 'DOCUMENTED_ADVERTISED') limitations.push('VENDOR_CLAIMED_CUTOFF_NOT_INDEPENDENTLY_AUDITED');
    return out('DOCUMENTED_PIT_RECONSTRUCTION', ['DOCUMENTED_BOUNDARY_BEFORE_PERIOD'], limitations);
  }
  return out('HISTORICAL_LLM_AT_RISK', [provenance.cutoff.state === 'UNKNOWN' ? 'CUTOFF_UNKNOWN' : 'CUTOFF_OVERLAPS_OR_FOLLOWS_PERIOD'], ['CONTAMINATION_NOT_EXCLUDED']);
}

// Transitive risk propagation over an explicit dependency graph.
//   nodes: [{ id, class }] (class from TEMPORAL_CLASSES)
//   edges: [{ from, to, role }] — `to` consumes `from` under `role`
// Risk (HISTORICAL_LLM_AT_RISK / SYNTHETIC_DIAGNOSTIC-as-evidence) propagates through RUNTIME_INPUT,
// FITTED_PARAMETER and VALIDATION_EVIDENCE: a deterministic scorer over an at-risk feature is not LLM-free.
// HYPOTHESIS_ANCESTRY propagates VISIBILITY ONLY: historical inspiration is disclosed, never a permanent ban.
export function propagateIntegrityFindings({ nodes, edges }) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('propagateIntegrityFindings: graph malformed');
  const byId = new Map();
  for (const n of nodes) {
    if (!isPlainObject(n) || typeof n.id !== 'string' || !TEMPORAL_CLASSES.includes(n.class)) throw new Error('propagateIntegrityFindings: node malformed');
    if (byId.has(n.id)) throw new Error('propagateIntegrityFindings: duplicate node');
    byId.set(n.id, { id: n.id, declaredClass: n.class, atRisk: n.class === 'HISTORICAL_LLM_AT_RISK', syntheticTaint: n.class === 'SYNTHETIC_DIAGNOSTIC', ancestryAtRisk: false });
  }
  for (const e of edges) {
    if (!isPlainObject(e) || !byId.has(e.from) || !byId.has(e.to) || !DEPENDENCY_ROLES.includes(e.role)) throw new Error('propagateIntegrityFindings: edge malformed');
    if (e.from === e.to) throw new Error('propagateIntegrityFindings: self-dependency');
  }
  // fixed-point propagation (cycle-safe: monotone flags)
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const from = byId.get(e.from); const to = byId.get(e.to);
      if (e.role === 'HYPOTHESIS_ANCESTRY') {
        if ((from.atRisk || from.ancestryAtRisk) && !to.ancestryAtRisk) { to.ancestryAtRisk = true; changed = true; }
        continue;
      }
      if (from.atRisk && !to.atRisk) { to.atRisk = true; changed = true; }
      if (from.syntheticTaint && !to.syntheticTaint) { to.syntheticTaint = true; changed = true; }
      if (from.ancestryAtRisk && !to.ancestryAtRisk) { to.ancestryAtRisk = true; changed = true; }
    }
  }
  return deepFreeze({
    law: 'RISK_PROPAGATES_THROUGH_INPUTS_PARAMETERS_AND_VALIDATION; ANCESTRY_IS_DISCLOSED_NOT_BANNED',
    nodes: [...byId.values()].map((n) => deepFreeze({
      id: n.id, declaredClass: n.declaredClass,
      effectiveClass: n.syntheticTaint && n.declaredClass !== 'SYNTHETIC_DIAGNOSTIC' ? 'SYNTHETIC_DIAGNOSTIC'
        : n.atRisk && n.declaredClass !== 'HISTORICAL_LLM_AT_RISK' ? 'HISTORICAL_LLM_AT_RISK' : n.declaredClass,
      ancestryAtRisk: n.ancestryAtRisk,
    })),
  });
}

// The host-side use-class law, stated once: at-risk / synthetic / reconstruction evidence never reaches
// DECISION_ELIGIBLE; prospective evidence is eligible only when the consuming mode is separately authorized.
export function permittedUseClass({ effectiveClass, consumerMode = 'RESEARCH' }) {
  if (!TEMPORAL_CLASSES.includes(effectiveClass)) throw new Error('permittedUseClass: unknown class');
  if (effectiveClass === 'SYNTHETIC_DIAGNOSTIC' || effectiveClass === 'HISTORICAL_LLM_AT_RISK') return 'ANNOTATION_ONLY';
  if (effectiveClass === 'DOCUMENTED_PIT_RECONSTRUCTION') return 'SHADOW_ONLY';
  if (effectiveClass === 'DETERMINISTIC_REPLAY' || effectiveClass === 'PROSPECTIVE_SHADOW') return consumerMode === 'PAPER' ? 'DECISION_ELIGIBLE' : 'SHADOW_ONLY';
  return 'ANNOTATION_ONLY';
}
