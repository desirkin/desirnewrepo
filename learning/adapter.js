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
  ACTIVATION_VERSION, ADJUSTMENT_CEILINGS, AUTHORITY_PAPER_ADJUSTMENT,
  activationError, activationIdOf, isFiniteNum, isTs, round4, deepFreeze,
} from './contracts.js';
import { evaluatePredicate } from './features.js';

export const DEFAULT_DEGRADE_RULE = Object.freeze({ minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 });
export const DEFAULT_COOLDOWN_MS = 24 * 3_600_000;

export function buildActivation({
  candidateId, patternId, trainingCutoffTs, candidateDigest, evidenceDigest, reportDigest,
  maxAbsAdjust, adjust = maxAbsAdjust, scope = { setupType: 'ANY', regime: 'ANY' }, eligibility = null, axes = ['RANKING'], applicability, previousVersion = null, effectiveTs, expiresTs,
  degradeRule = DEFAULT_DEGRADE_RULE, state = 'PUBLISHED_WAITING_FOR_PAPER', seq = 0, ts, transitionReason = 'FORWARD_GATE_PASSED', cooldownUntilTs = null,
}) {
  const identity = { candidateId, patternId, candidateDigest, effectiveTs };
  const record = {
    activationVersion: ACTIVATION_VERSION, activationId: activationIdOf(identity), seq, state, candidateId, patternId,
    trainingCutoffTs, candidateDigest, evidenceDigest, reportDigest, scope, eligibility,
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
export function applyLearnedAdjustment({ baselineScore, activationHeads, featureSet, adjustments, nowTs, kill }) {
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
    // the frozen learned parameter lives in the artifact; an explicit adjustments map may only NARROW it (shadow
    // experiments) — an absent map applies the frozen value, never an external retune
    const adjust = adjustments && head.activationId in adjustments ? adjustments[head.activationId] : head.allowedEffect.adjust;
    if (!isFiniteNum(adjust)) continue;
    if (Math.abs(adjust) > head.allowedEffect.maxAbsAdjust + 1e-12) return fallback('ADJUSTMENT_EXCEEDS_ALLOWED_EFFECT');
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
  const rule = head.degradeRule;
  if (!Array.isArray(windows) || windows.length < rule.consecutiveWindows) return { degrade: false, reason: 'INSUFFICIENT_WINDOWS' };
  const recent = windows.slice(-rule.consecutiveWindows);
  for (const w of recent) {
    if (!w || !Number.isSafeInteger(w.groups) || w.groups < rule.minGroups) return { degrade: false, reason: 'WINDOW_BELOW_MIN_GROUPS' };
    const frac = w.adverseGroups / w.groups;
    if (!(frac > rule.adverseFractionAbove)) return { degrade: false, reason: 'ADVERSE_FRACTION_WITHIN_RULE' };
  }
  return { degrade: true, reason: 'PREDECLARED_DEGRADATION_RULE_MET' };
}
