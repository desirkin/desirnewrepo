// JUDGE — strategy-family identity and deterministic selection metadata.
//
// A family is a label for an already-qualified setup, never a confidence
// score or permission. Executable reward/risk and cost remain the admission
// order in risk.js; these identifiers provide only a deterministic final tie
// for two setups of the same underlying and an auditable mutual-exclusion
// record. The risk and reducer one-position-per-underlying laws remain the
// final hard backstops.

export const SETUP_SELECTION_VERSION = 'judge-setup-selection-1';

export const STRATEGY_FAMILIES = Object.freeze([
  'MOMENTUM_CONTINUATION',
  'EARLY_IGNITION_BREAKOUT',
  'PULLBACK_REENTRY',
  'RUMOR_CATALYST',
  'MICRO_BITE',
]);

export const SETUP_FAMILY = Object.freeze({
  MOMENTUM_CONTINUATION: 'MOMENTUM_CONTINUATION',
  RANGE_IGNITION: 'EARLY_IGNITION_BREAKOUT',
  TREND_PULLBACK_CONTINUATION: 'PULLBACK_REENTRY',
  ABSORPTION_RECLAIM: 'PULLBACK_REENTRY',
  CATALYST_TRANSMISSION: 'RUMOR_CATALYST',
  MICRO_BITE: 'MICRO_BITE',
});

export function strategyFamilyOf(setupId) {
  return typeof setupId === 'string' ? SETUP_FAMILY[setupId] ?? null : null;
}

// rankCandidates owns the economic order. JavaScript sorting is stable, so
// pre-ordering only supplies its otherwise-equal same-asset/setup tie. It
// cannot override reward/risk, cost, first-known time, or asset order.
export function deterministicSetupTieOrder(entries) {
  return [...entries].sort((left, right) => {
    const a = left?.rank ?? {}; const b = right?.rank ?? {};
    const aa = String(a.assetId ?? ''); const ba = String(b.assetId ?? '');
    if (aa !== ba) return aa < ba ? -1 : 1;
    const af = strategyFamilyOf(a.setupId) ?? 'UNKNOWN'; const bf = strategyFamilyOf(b.setupId) ?? 'UNKNOWN';
    if (af !== bf) return af < bf ? -1 : 1;
    const as = String(a.setupId ?? ''); const bs = String(b.setupId ?? '');
    if (as !== bs) return as < bs ? -1 : 1;
    const ad = String(a.decisionId ?? ''); const bd = String(b.decisionId ?? '');
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
}

export function selectionMeasurement({ setupId, selected, winnerSetupId = null, rank = null, of = null }) {
  const family = strategyFamilyOf(setupId);
  const winnerFamily = strategyFamilyOf(winnerSetupId);
  return {
    id: 'STRATEGY_FAMILY_SELECTION',
    ok: selected === true,
    value: family,
    threshold: selected === true ? family : winnerFamily,
    unit: 'STRATEGY_FAMILY',
    note: selected === true
      ? `${SETUP_SELECTION_VERSION}:selected_for_commit_attempt:rank=${rank ?? 'n/a'}/${of ?? 'n/a'}:setup=${setupId}`
      : `${SETUP_SELECTION_VERSION}:same_underlying_claimed:winner=${winnerSetupId ?? 'UNKNOWN'}:setup=${setupId}`,
  };
}

export function createUnderlyingClaimLedger() {
  const claims = new Map();
  return Object.freeze({
    offer({ assetId, setupId }) {
      if (typeof assetId !== 'string' || !assetId || typeof setupId !== 'string' || !setupId) return Object.freeze({ selected: false, winnerSetupId: null, reason: 'SELECTION_IDENTITY_INVALID' });
      const winnerSetupId = claims.get(assetId) ?? null;
      return Object.freeze(winnerSetupId === null
        ? { selected: true, winnerSetupId: null, reason: null }
        : { selected: false, winnerSetupId, reason: 'STRATEGY_NOT_SELECTED_SAME_UNDERLYING' });
    },
    settle({ assetId, setupId, claimed }) {
      if (claimed === true) {
        const prior = claims.get(assetId);
        if (prior && prior !== setupId) throw new Error(`underlying ${assetId} already claimed by ${prior}`);
        claims.set(assetId, setupId);
      }
      return claims.get(assetId) ?? null;
    },
    snapshot: () => Object.freeze(Object.fromEntries([...claims.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))),
  });
}

// A setup may shorten the policy horizon but can never lengthen it. Null is
// intentional for a setup whose Watch semantics are not operational yet; it
// refuses instead of silently inheriting the generic four-hour horizon.
export function setupDurationBound({ policyMaxDurationMs, setupMaxDurationMs }) {
  if (!Number.isSafeInteger(policyMaxDurationMs) || policyMaxDurationMs <= 0) return Object.freeze({ ok: false, maxDurationMs: null, reason: 'POLICY_DURATION_INVALID' });
  if (setupMaxDurationMs === null || setupMaxDurationMs === undefined) return Object.freeze({ ok: false, maxDurationMs: null, reason: 'HORIZON_NOT_OPERATIONAL' });
  if (!Number.isSafeInteger(setupMaxDurationMs) || setupMaxDurationMs <= 0) return Object.freeze({ ok: false, maxDurationMs: null, reason: 'SETUP_DURATION_INVALID' });
  return Object.freeze({ ok: true, maxDurationMs: Math.min(policyMaxDurationMs, setupMaxDurationMs), reason: null });
}
