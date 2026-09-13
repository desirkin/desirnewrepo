// JUDGE — the ONE learned-contribution consumer seam (ADDENDUM-2 §07/§08; multiple frozen validated candidates).
//
// This is the cheap, PURE consumer of an already prepared decision-memory snapshot (learning/memory-view.js
// readDecisionMemory, refreshed OUTSIDE the decision loop). It supports MULTIPLE frozen, validated candidates,
// each declaring its exact setup/regime scope, applicability predicate, frozen bounded effect and expiry. At
// decision time only a forward-validated candidate whose declared scope matches the CURRENT already-prepared facts
// may contribute; otherwise the unchanged baseline. A candidate is never selected from its eventual outcome, a
// recent win, a familiar ticker or unvalidated history — no such input exists in this function's signature, and an
// artifact carrying undeclared fields fails its closed validator outright.
//
// The selector is deterministic, versioned and logged: it returns every eligible candidate, the selected one and
// the exact reason. Predeclared conservative tie-break when several validated candidates match: smallest permitted
// absolute effect first, then earliest effectiveTs, then lexicographic activationId. Candidates remain separate —
// one candidate's success promotes nothing else, and one loss rewrites nothing here (degradation is the activation
// journal's own predeclared rule). Insufficient feature coverage, conflicting active versions of one pattern,
// stale/expired/killed/invalid state: BASELINE, with the reason.
//
// It performs no LLM call, no network request, no research run, no training, no filesystem read, no risk/capital/
// account/execution change: it computes a bounded RANK-ONLY score adjustment that judge/judge.js may apply to the
// admission-gate ordering of ALREADY fully qualified candidates. Hard gates, sizing, risk and The Watch are not
// inputs and not outputs. The import fence for this file is explicit and tested (test/integrity-boundary.test.js):
// it imports ONLY the two named pure learning modules below.
import { activationError, ADJUSTMENT_CEILINGS, isFiniteNum, isTs, round4, deepFreeze } from '../learning/contracts.js';
import { evaluatePredicate } from '../learning/features.js';

export const LEARNING_INTAKE_VERSION = 'judge-learning-intake-1';
export const SELECTOR_VERSION = 'learning-selector-1';
export const TIE_BREAK_LAW = 'SMALLEST_ABS_EFFECT_THEN_EARLIEST_EFFECTIVE_THEN_LEXICOGRAPHIC_ID';
export const DISPOSITIONS = Object.freeze(['DECISION_ELIGIBLE', 'SHADOW_ONLY', 'BASELINE_ONLY']);
export const NO_CONTRIBUTION_REASONS = Object.freeze([
  'NO_SNAPSHOT', 'SNAPSHOT_STALE', 'LEARNED_INFLUENCE_KILLED', 'ACTIVATION_RECORD_INVALID', 'NO_MATCHING_VALIDATED_CANDIDATE',
  'CONFLICTING_ACTIVE_VERSIONS', 'MODE_NOT_PAPER_AUTHORIZED', 'ZERO_FROZEN_EFFECT',
]);
export const SNAPSHOT_MAX_AGE_MS = 15 * 60_000; // a cache hit never refreshes old evidence: a stale snapshot is baseline

// validate ONE artifact for consumption at nowTs (closed record + lifecycle + window). Returns { ok, reasons }.
export function validateLearningActivation(artifact, { nowTs }) {
  const reasons = [];
  const err = activationError(artifact);
  if (err) return deepFreeze({ ok: false, reasons: ['ACTIVATION_RECORD_INVALID'] });
  if (artifact.state !== 'ACTIVE_PAPER') reasons.push(`NOT_ACTIVE:${artifact.state}`);
  if (!isTs(nowTs) || nowTs < artifact.effectiveTs) reasons.push('NOT_YET_EFFECTIVE');
  if (isTs(nowTs) && nowTs >= artifact.expiresTs) reasons.push('EXPIRED');
  if (artifact.cooldownUntilTs !== null && isTs(nowTs) && nowTs < artifact.cooldownUntilTs) reasons.push('IN_COOLDOWN');
  return deepFreeze({ ok: reasons.length === 0, reasons });
}

const scopeMatches = (declared, actual) => declared === 'ANY' || declared === actual;

// The deterministic selector. Inputs are the prepared snapshot and the prepared facts of THIS decision — nothing else.
//   snapshot: readDecisionMemory output ({ activations, kill, preparedTs })
//   facts: { setupType, regime, features } — features in the learning shape { name: { value, availability, ... } }
//   mode: the consuming run mode; only PAPER may reach DECISION_ELIGIBLE (LIVE never, in this ticket)
export function resolveLearningContribution({ snapshot, facts, mode, nowTs }) {
  const baseline = (reason, extra = {}) => deepFreeze({
    selectorVersion: SELECTOR_VERSION, tieBreakLaw: TIE_BREAK_LAW, disposition: 'BASELINE_ONLY', applied: false,
    selected: null, adjust: 0, eligible: [], rejected: extra.rejected ?? [], reason,
  });
  if (!snapshot || !Array.isArray(snapshot.activations)) return baseline('NO_SNAPSHOT');
  if (!isTs(snapshot.preparedTs) || !isTs(nowTs) || nowTs - snapshot.preparedTs > SNAPSHOT_MAX_AGE_MS) return baseline('SNAPSHOT_STALE');
  if (!snapshot.kill || snapshot.kill.state !== 'ARMED') return baseline('LEARNED_INFLUENCE_KILLED');
  const rejected = []; const eligible = [];
  for (const a of [...snapshot.activations].sort((x, y) => (String(x?.activationId) < String(y?.activationId) ? -1 : 1))) {
    if (activationError(a)) return baseline('ACTIVATION_RECORD_INVALID'); // one corrupt artifact suspends learned influence entirely (fail toward baseline)
    const v = validateLearningActivation(a, { nowTs });
    if (!v.ok) { rejected.push({ activationId: a.activationId, reason: v.reasons[0] }); continue; }
    if (!scopeMatches(a.scope.setupType, facts.setupType)) { rejected.push({ activationId: a.activationId, reason: 'SCOPE_SETUP_MISMATCH' }); continue; }
    if (!scopeMatches(a.scope.regime, facts.regime)) { rejected.push({ activationId: a.activationId, reason: 'SCOPE_REGIME_MISMATCH' }); continue; }
    if (!a.allowedEffect.axes.includes('RANKING')) { rejected.push({ activationId: a.activationId, reason: 'AXIS_NOT_CONSUMABLE' }); continue; } // only the RANKING axis is consumable in this release
    if (a.eligibility !== null) {
      // declared liquidity eligibility must be PROVEN by the current prepared facts; a missing fact is out of
      // coverage, never an optimistic pass
      const spread = facts.features?.spreadBps; const depth = facts.features?.depthUsd10bps;
      if (a.eligibility.maxSpreadBps !== null) {
        if (!spread || spread.availability !== 'KNOWN') { rejected.push({ activationId: a.activationId, reason: 'OUT_OF_DOMAIN_OR_COVERAGE' }); continue; }
        if (spread.value > a.eligibility.maxSpreadBps) { rejected.push({ activationId: a.activationId, reason: 'LIQUIDITY_OUT_OF_RANGE' }); continue; }
      }
      if (a.eligibility.minDepthUsd10bps !== null) {
        if (!depth || depth.availability !== 'KNOWN') { rejected.push({ activationId: a.activationId, reason: 'OUT_OF_DOMAIN_OR_COVERAGE' }); continue; }
        if (depth.value < a.eligibility.minDepthUsd10bps) { rejected.push({ activationId: a.activationId, reason: 'LIQUIDITY_OUT_OF_RANGE' }); continue; }
      }
    }
    const domain = evaluatePredicate(a.applicability, { features: facts.features ?? {} });
    if (domain !== 'TRUE') { rejected.push({ activationId: a.activationId, reason: domain === 'UNKNOWN' ? 'OUT_OF_DOMAIN_OR_COVERAGE' : 'APPLICABILITY_FALSE' }); continue; }
    eligible.push(a);
  }
  if (eligible.length === 0) return baseline('NO_MATCHING_VALIDATED_CANDIDATE', { rejected });
  const patternIds = new Set(eligible.map((a) => a.patternId));
  if (patternIds.size !== eligible.length) return baseline('CONFLICTING_ACTIVE_VERSIONS', { rejected }); // two active versions of one pattern is an integrity conflict, never a choice
  // predeclared conservative tie-break: smallest permitted absolute effect, then earliest effect, then id
  const ordered = [...eligible].sort((x, y) => (
    Math.abs(x.allowedEffect.adjust) - Math.abs(y.allowedEffect.adjust)
    || x.allowedEffect.maxAbsAdjust - y.allowedEffect.maxAbsAdjust
    || x.effectiveTs - y.effectiveTs
    || (x.activationId < y.activationId ? -1 : 1)
  ));
  const selected = ordered[0];
  const adjust = selected.allowedEffect.adjust;
  if (!isFiniteNum(adjust) || adjust === 0) return baseline('ZERO_FROZEN_EFFECT', { rejected });
  const clamped = Math.max(-ADJUSTMENT_CEILINGS.maxAbsPerActivation, Math.min(ADJUSTMENT_CEILINGS.maxAbsPerActivation, adjust));
  const disposition = mode === 'PAPER' ? 'DECISION_ELIGIBLE' : 'SHADOW_ONLY'; // OBSERVE/REPLAY record without applying; LIVE never applies in this ticket
  return deepFreeze({
    selectorVersion: SELECTOR_VERSION, tieBreakLaw: TIE_BREAK_LAW, disposition, applied: disposition === 'DECISION_ELIGIBLE',
    selected: { activationId: selected.activationId, patternId: selected.patternId, candidateId: selected.candidateId, scope: selected.scope, maxAbsAdjust: selected.allowedEffect.maxAbsAdjust },
    adjust: round4(clamped),
    eligible: ordered.map((a) => ({ activationId: a.activationId, patternId: a.patternId, adjust: a.allowedEffect.adjust })),
    rejected, reason: disposition === 'DECISION_ELIGIBLE' ? 'SELECTED_BY_TIE_BREAK_LAW' : 'MODE_NOT_PAPER_AUTHORIZED',
  });
}

// the bounded measurement row recording consumption inside the EXISTING closed decision vocabulary
export function contributionMeasurement(resolution) {
  return {
    id: 'LEARNED_RANK_ADJUSTMENT', ok: resolution.applied === true,
    value: resolution.applied ? resolution.adjust : null,
    threshold: resolution.selected ? resolution.selected.maxAbsAdjust : null,
    unit: 'RANK_SCORE_UNITS',
    note: `${resolution.selectorVersion}:${resolution.applied ? resolution.selected.activationId : resolution.reason}${resolution.eligible.length > 1 ? `:eligible=${resolution.eligible.length}` : ''}`.slice(0, 400),
  };
}
