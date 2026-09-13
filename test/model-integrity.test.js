// ADDENDUM-2 §12 — the pure provenance contract: cutoff honesty, forward-vs-retrospective timing, dependency
// propagation, ancestry-vs-runtime distinction, producer self-approval refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateModelProvenance, classifyTemporalEvidence, propagateIntegrityFindings, permittedUseClass,
  MODEL_PROVENANCE_VERSION, VERSION_UNPINNED,
} from '../learning/model-integrity.js';

const T = Date.UTC(2026, 8, 13, 12, 0, 0);
const prov = (over = {}) => ({
  provenanceVersion: MODEL_PROVENANCE_VERSION, provider: 'anthropic', requestedModel: 'claude-sonnet-5',
  responseModel: 'claude-sonnet-5', snapshotVersion: VERSION_UNPINNED, systemFingerprint: null, invocationTs: T,
  cutoff: { state: 'UNKNOWN', boundaryTs: null, docRef: null, retrievedTs: null },
  promptDigest: 'p'.repeat(16), evidenceDigest: 'e'.repeat(16), asOfTs: T - 1000, retrievalConfig: null,
  sampling: { temperature: 0, seed: 's1', determinismClaim: false },
  outputDigest: 'o'.repeat(16), parsedAssessmentDigest: null, declaredUncertainty: null, evidenceRefs: [],
  requestId: 'req-1', usage: null, errorState: null, callClass: 'HISTORICAL_RECONSTRUCTION', ...over,
});

test('12.1 an unknown cutoff or floating alias can never silently become verified historical purity', () => {
  assert.equal(validateModelProvenance(prov()), null);
  const c = classifyTemporalEvidence({ hasLlmDependency: true, provenance: prov(), periodStartTs: T - 30 * 86_400_000 });
  assert.equal(c.class, 'HISTORICAL_LLM_AT_RISK');
  assert.ok(c.reasons.includes('CUTOFF_UNKNOWN'));
  assert.ok(c.limitations.includes('CONTAMINATION_NOT_EXCLUDED'));
  // a supplied seed never becomes a determinism claim
  assert.match(validateModelProvenance(prov({ sampling: { temperature: 0, seed: 's1', determinismClaim: true } })), /never claimed/);
  // a cutoff value cannot be smuggled without documentation reference + retrieval clock
  assert.match(validateModelProvenance(prov({ cutoff: { state: 'DOCUMENTED_ADVERTISED', boundaryTs: T - 90 * 86_400_000, docRef: null, retrievedTs: null } })), /documentation reference/);
});

test('a vendor-advertised cutoff earns DOCUMENTED_PIT_RECONSTRUCTION with its vendor-claim limitation retained — never equated with an independent audit', () => {
  const documented = prov({ cutoff: { state: 'DOCUMENTED_ADVERTISED', boundaryTs: T - 90 * 86_400_000, docRef: 'https://docs/provider', retrievedTs: T } });
  const c = classifyTemporalEvidence({ hasLlmDependency: true, provenance: documented, periodStartTs: T - 30 * 86_400_000 });
  assert.equal(c.class, 'DOCUMENTED_PIT_RECONSTRUCTION');
  assert.ok(c.limitations.includes('VENDOR_CLAIMED_CUTOFF_NOT_INDEPENDENTLY_AUDITED'));
  // a boundary OVERLAPPING the evaluated period stays at risk
  const overlapping = classifyTemporalEvidence({ hasLlmDependency: true, provenance: documented, periodStartTs: T - 120 * 86_400_000 });
  assert.equal(overlapping.class, 'HISTORICAL_LLM_AT_RISK');
});

test('12.9/12.20 a response created after the evaluated outcome (or without a sealed pre-outcome decision) is never prospective', () => {
  const p = prov({ callClass: 'PROSPECTIVE_SHADOW', invocationTs: T });
  const good = classifyTemporalEvidence({ hasLlmDependency: true, provenance: p, decisionRecordedTs: T + 1000, outcomeStartTs: T + 3_600_000 });
  assert.equal(good.class, 'PROSPECTIVE_SHADOW');
  const late = classifyTemporalEvidence({ hasLlmDependency: true, provenance: p, decisionRecordedTs: T + 7_200_000, outcomeStartTs: T + 3_600_000 });
  assert.equal(late.class, 'HISTORICAL_LLM_AT_RISK', 'decision sealed after the outcome started');
  const backdated = classifyTemporalEvidence({ hasLlmDependency: true, provenance: prov({ callClass: 'PROSPECTIVE_SHADOW', invocationTs: T + 5000 }), decisionRecordedTs: T + 1000, outcomeStartTs: T + 3_600_000 });
  assert.equal(backdated.class, 'HISTORICAL_LLM_AT_RISK', 'a late response cannot be backdated to an earlier simulated action');
  const unsealed = classifyTemporalEvidence({ hasLlmDependency: true, provenance: p });
  assert.equal(unsealed.class, 'HISTORICAL_LLM_AT_RISK');
});

test('12.2 an LLM-derived historical feature propagates its risk into a downstream deterministic scorer; ancestry is disclosed, never a ban', () => {
  const g = propagateIntegrityFindings({
    nodes: [
      { id: 'llm-sentiment', class: 'HISTORICAL_LLM_AT_RISK' },
      { id: 'det-scorer', class: 'DETERMINISTIC_REPLAY' },
      { id: 'hypothesis', class: 'DETERMINISTIC_REPLAY' },
      { id: 'clean-scorer', class: 'DETERMINISTIC_REPLAY' },
    ],
    edges: [
      { from: 'llm-sentiment', to: 'det-scorer', role: 'RUNTIME_INPUT' },
      { from: 'llm-sentiment', to: 'hypothesis', role: 'HYPOTHESIS_ANCESTRY' },
    ],
  });
  const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(by['det-scorer'].effectiveClass, 'HISTORICAL_LLM_AT_RISK', 'a deterministic scorer over an at-risk feature is not LLM-free');
  assert.equal(by.hypothesis.effectiveClass, 'DETERMINISTIC_REPLAY', 'ancestry does not contaminate the candidate itself');
  assert.equal(by.hypothesis.ancestryAtRisk, true, 'but the ancestry stays visible');
  assert.equal(by['clean-scorer'].effectiveClass, 'DETERMINISTIC_REPLAY');
});

test('missing/undeclared provenance fields are refused — a producer cannot approve itself with a trusted flag', () => {
  assert.match(validateModelProvenance({ ...prov(), trusted: true }), /undeclared key/);
  assert.match(validateModelProvenance({ ...prov(), approved: 'yes' }), /undeclared key/);
  const c = classifyTemporalEvidence({ hasLlmDependency: true, provenance: null });
  assert.equal(c.class, 'HISTORICAL_LLM_AT_RISK');
  assert.ok(c.limitations.includes('UNKNOWN_IS_AT_RISK_NOT_TRUSTED'));
});

test('host use classes: at-risk/synthetic never reach DECISION_ELIGIBLE; reconstruction is SHADOW_ONLY; prospective is eligible only under PAPER', () => {
  assert.equal(permittedUseClass({ effectiveClass: 'HISTORICAL_LLM_AT_RISK', consumerMode: 'PAPER' }), 'ANNOTATION_ONLY');
  assert.equal(permittedUseClass({ effectiveClass: 'SYNTHETIC_DIAGNOSTIC', consumerMode: 'PAPER' }), 'ANNOTATION_ONLY');
  assert.equal(permittedUseClass({ effectiveClass: 'DOCUMENTED_PIT_RECONSTRUCTION', consumerMode: 'PAPER' }), 'SHADOW_ONLY');
  assert.equal(permittedUseClass({ effectiveClass: 'PROSPECTIVE_SHADOW', consumerMode: 'PAPER' }), 'DECISION_ELIGIBLE');
  assert.equal(permittedUseClass({ effectiveClass: 'PROSPECTIVE_SHADOW', consumerMode: 'RESEARCH' }), 'SHADOW_ONLY');
  assert.equal(permittedUseClass({ effectiveClass: 'DETERMINISTIC_REPLAY', consumerMode: 'LIVE' }), 'SHADOW_ONLY', 'LIVE never gains learned eligibility in this ticket');
});
