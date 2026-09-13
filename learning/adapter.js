// LEARN-1 — the ONE bounded paper-assessment adapter. This is the single declared boundary through which a
// VALIDATED, versioned, allowlisted learned adjustment may influence PAPER setup-quality assessment — and nothing
// else. It cannot touch hard eligibility, liquidity/exitability safeguards, fee treatment, position/risk limits,
// leverage, order mechanics, source permissions, budgets, trading mode or The Watch: none of those inputs even
// reach this function. Learned adjustments cannot place orders. Publishing a validated candidate while PAPER is
// stopped records PUBLISHED_WAITING_FOR_PAPER, never ACTIVE_PAPER.
//
// Active learned parameters are FROZEN: the adapter reads only immutable activation records; updating provisional
// evidence cannot mutate an active version in place — a replacement version requires its own registered validation
// and a new activation record. On invalid / stale / expired / killed / corrupt adaptive state the adapter answers
// the BASELINE score with the reason exposed; rollback is an appended state transition, atomic through the store,
// with a cooldown so one ordinary loss cannot flip behavior back and forth.
import {
  ACTIVATION_VERSION, ADJUSTMENT_CEILINGS, AUTHORITY_PAPER_ADJUSTMENT, FEATURE_RECIPE_VERSION, BASELINE_RULE_VERSION,
  activationError, activationIdOf, isFiniteNum, isTs, round4, deepFreeze,
} from './contracts.js';
import { evaluatePredicate } from './features.js';

export const DEFAULT_DEGRADE_RULE = Object.freeze({ minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 });
export const DEFAULT_COOLDOWN_MS = 24 * 3_600_000;
// the full declared eligibility envelope with every dimension EXPLICITLY unbounded and no required facts — a
// builder default is still a declaration recorded in the artifact, never something the selector invents later
export const UNBOUNDED_ELIGIBILITY = Object.freeze({ maxSpreadBps: null, minDepthUsd10bps: null, minAtrPct: null, maxAtrPct: null, requiredFeatures: Object.freeze([]), maxFactAgeMs: null });

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const scalarScopeMatches = (declared, actual) => declared === 'ANY' || declared === actual;
const listScopeMatches = (declared, actual) => declared === 'ANY' || (typeof actual === 'string' && Array.isArray(declared) && declared.includes(actual));
const hasPreparedConstraint = (head) => (
  head.scope.setupType !== 'ANY' || head.scope.regime !== 'ANY' || head.scope.assets !== 'ANY' || head.scope.venues !== 'ANY'
  || head.eligibility.requiredFeatures.length > 0
  || ['maxSpreadBps', 'minDepthUsd10bps', 'minAtrPct', 'maxAtrPct'].some((k) => head.eligibility[k] !== null)
);
const factUsable = (f, maxAgeMs, { numeric = false } = {}) => Boolean(
  f && f.availability === 'KNOWN'
  && (!numeric || isFiniteNum(f.value))
  && (maxAgeMs === null || (isFiniteNum(f.ageMs) && f.ageMs >= 0 && f.ageMs <= maxAgeMs))
);
const rangeMatches = (f, min, max, maxAgeMs) => {
  if (min === null && max === null) return true;
  if (!factUsable(f, maxAgeMs, { numeric: true })) return false;
  return (min === null || f.value >= min) && (max === null || f.value <= max);
};

export function buildActivation({
  candidateId, patternId, trainingCutoffTs, candidateDigest, evidenceDigest, reportDigest,
  maxAbsAdjust, adjust = maxAbsAdjust, scope = {}, eligibility = UNBOUNDED_ELIGIBILITY, axes = ['RANKING'],
  featureRecipeVersion = FEATURE_RECIPE_VERSION, policyVersion = BASELINE_RULE_VERSION,
  validation, maxSizeUsd = null, // candle-fidelity validation carries NO size evidence: null is that explicit declaration
  applicability, previousVersion = null, effectiveTs, expiresTs,
  degradeRule = DEFAULT_DEGRADE_RULE, state = 'PUBLISHED_WAITING_FOR_PAPER', seq = 0, ts, transitionReason = 'FORWARD_GATE_PASSED', cooldownUntilTs = null,
}) {
  const identity = { candidateId, patternId, candidateDigest, effectiveTs };
  const fullScope = { setupType: 'ANY', regime: 'ANY', assets: 'ANY', venues: 'ANY', ...scope };
  const record = {
    activationVersion: ACTIVATION_VERSION, activationId: activationIdOf(identity), seq, state, candidateId, patternId,
    trainingCutoffTs, candidateDigest, evidenceDigest, reportDigest, scope: fullScope,
    eligibility: { ...UNBOUNDED_ELIGIBILITY, ...eligibility, requiredFeatures: [...(eligibility?.requiredFeatures ?? [])] },
    featureRecipeVersion, policyVersion, validation, maxSizeUsd,
    allowedEffect: { kind: 'SETUP_QUALITY_SCORE_ADJUSTMENT', axes, adjust, maxAbsAdjust, units: 'BASELINE_SCORE_UNITS' },
    applicability, previousVersion, effectiveTs, expiresTs, cooldownUntilTs, degradeRule, transitionReason, ts,
    authority: AUTHORITY_PAPER_ADJUSTMENT,
  };
  const err = activationError(record); if (err) throw new Error(`buildActivation: ${err}`);
  return deepFreeze(record);
}

export function transitionActivation(head, { state, transitionReason, ts, cooldownUntilTs = null }) {
  const record = { ...head, seq: head.seq + 1, state, transitionReason, ts, cooldownUntilTs: cooldownUntilTs ?? head.cooldownUntilTs };
  const err = activationError(record); if (err) throw new Error(`transitionActivation: ${err}`);
  return deepFreeze(record);
}

// The pure application. baselineScore stays beside effectiveScore always; several correlated patterns cannot each
// add a full boost (the aggregate ceiling binds); anything wrong answers baseline with the reason.
export function applyLearnedAdjustment({ baselineScore, activationHeads, featureSet, adjustments, nowTs, kill, preparedFacts = null }) {
  const fallback = (reason) => deepFreeze({ baselineScore, effectiveScore: baselineScore, applied: [], fallbackReason: reason });
  if (!isFiniteNum(baselineScore)) return fallback('BASELINE_SCORE_INVALID');
  if (!kill || kill.state !== 'ARMED') return fallback(kill?.reason ?? 'LEARNED_INFLUENCE_KILLED');
  if (!isTs(nowTs)) return fallback('CLOCK_INVALID');
  const applied = [];
  let total = 0;
  for (const head of activationHeads.values()) {
    if (activationError(head)) return fallback('ACTIVATION_RECORD_INVALID'); // one corrupt record suspends learned influence entirely
    if (head.state !== 'ACTIVE_PAPER') continue;
    if (nowTs < head.effectiveTs || nowTs >= head.expiresTs) continue;
    if (head.cooldownUntilTs !== null) {
      if (!isTs(head.cooldownUntilTs)) return fallback('ACTIVATION_RECORD_INVALID');
      if (nowTs < head.cooldownUntilTs) continue;
    }
    if (!head.allowedEffect.axes.includes('RANKING')) continue;
    // No decision context is inferred here. Constrained artifacts require the caller's prepared facts.
    if (hasPreparedConstraint(head) && !preparedFacts) return fallback('PREPARED_CONTEXT_REQUIRED');
    if (preparedFacts) {
      if (!scalarScopeMatches(head.scope.setupType, preparedFacts.setupType)
        || !scalarScopeMatches(head.scope.regime, preparedFacts.regime)
        || !listScopeMatches(head.scope.assets, preparedFacts.asset)
        || !listScopeMatches(head.scope.venues, preparedFacts.venue)) continue;
      if (preparedFacts.featureRecipeVersion !== undefined && preparedFacts.featureRecipeVersion !== head.featureRecipeVersion) continue;
      if (preparedFacts.policyVersion !== undefined && preparedFacts.policyVersion !== head.policyVersion) continue;
      const maxAge = head.eligibility.maxFactAgeMs;
      if (head.eligibility.requiredFeatures.some((name) => !factUsable(featureSet?.features?.[name], maxAge))) continue;
      if (!rangeMatches(featureSet?.features?.spreadBps, null, head.eligibility.maxSpreadBps, maxAge)) continue;
      if (!rangeMatches(featureSet?.features?.depthUsd10bps, head.eligibility.minDepthUsd10bps, null, maxAge)) continue;
      if (!rangeMatches(featureSet?.features?.atrPct, head.eligibility.minAtrPct, head.eligibility.maxAtrPct, maxAge)) continue;
    }
    // the frozen learned parameter lives in the artifact; an explicit adjustments map may only NARROW it (shadow
    // experiments) — an absent map applies the frozen value, never an external retune
    const adjust = own(adjustments, head.activationId) ? adjustments[head.activationId] : head.allowedEffect.adjust;
    if (!isFiniteNum(adjust)) continue;
    if (Math.abs(adjust) > head.allowedEffect.maxAbsAdjust + 1e-12) return fallback('ADJUSTMENT_EXCEEDS_ALLOWED_EFFECT');
    const frozen = head.allowedEffect.adjust;
    if (adjust !== 0 && (frozen === 0 || Math.sign(adjust) !== Math.sign(frozen) || Math.abs(adjust) > Math.abs(frozen) + 1e-12)) return fallback('ADJUSTMENT_WIDENS_OR_REVERSES_FROZEN_EFFECT');
    // applicability: a pattern outside its validated domain answers UNKNOWN/OUT_OF_DOMAIN and contributes nothing —
    // it never extrapolates confidence
    const domain = evaluatePredicate(head.applicability, featureSet);
    if (domain !== 'TRUE') continue;
    applied.push({ activationId: head.activationId, patternId: head.patternId, adjust: round4(adjust) });
    total += adjust;
  }
  if (Math.abs(total) > ADJUSTMENT_CEILINGS.maxAbsAggregate) {
    const scale = ADJUSTMENT_CEILINGS.maxAbsAggregate / Math.abs(total);
    total *= scale;
    for (const a of applied) a.adjust = round4(a.adjust * scale); // proportional squeeze under the aggregate ceiling, disclosed per pattern
  }
  return deepFreeze({ baselineScore, effectiveScore: round4(baselineScore + total), applied, fallbackReason: null });
}

// Predeclared statistical degradation: the rule fires only over >= minGroups matured post-activation groups with an
// adverse fraction above the threshold for consecutiveWindows successive evaluation windows. One ordinary loss can
// never trip it (minGroups >= 2 is enforced at the contract).
export function degradationCheck({ head, windows }) {
  if (activationError(head)) return { degrade: false, reason: 'ACTIVATION_RECORD_INVALID' };
  const rule = head.degradeRule;
  if (!Number.isSafeInteger(rule.consecutiveWindows) || rule.consecutiveWindows < 1
    || !Number.isSafeInteger(rule.minGroups) || rule.minGroups < 2
    || !isFiniteNum(rule.adverseFractionAbove) || rule.adverseFractionAbove < 0 || rule.adverseFractionAbove > 1) return { degrade: false, reason: 'INVALID_DEGRADE_RULE' };
  if (!Array.isArray(windows)) return { degrade: false, reason: 'INVALID_WINDOWS' };
  if (windows.length < rule.consecutiveWindows) return { degrade: false, reason: 'INSUFFICIENT_WINDOWS' };
  const recent = windows.slice(-rule.consecutiveWindows);
  for (const w of recent) {
    if (!w || !Number.isSafeInteger(w.groups) || !Number.isSafeInteger(w.adverseGroups)
      || w.groups < 0 || w.adverseGroups < 0 || w.adverseGroups > w.groups) return { degrade: false, reason: 'INVALID_WINDOW' };
    if (w.groups < rule.minGroups) return { degrade: false, reason: 'WINDOW_BELOW_MIN_GROUPS' };
    const frac = w.adverseGroups / w.groups;
    if (!(frac > rule.adverseFractionAbove)) return { degrade: false, reason: 'ADVERSE_FRACTION_WITHIN_RULE' };
  }
  return { degrade: true, reason: 'PREDECLARED_DEGRADATION_RULE_MET' };
}
