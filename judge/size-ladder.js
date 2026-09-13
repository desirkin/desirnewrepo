// JUDGE — the dynamic purchase-size ladder (FINAL DYNAMIC-SIZING ADDENDUM), default-off and PURE.
//
// For one already fully qualified opportunity it evaluates MULTIPLE candidate purchase amounts — fractions of the
// spendable budget up to 1.0 — each through the EXISTING execution-fidelity cost law (judge/cost.js sizeSearch:
// real book walking, both-side fees, stress, reward/risk screen, lot/min/precision, depth exhaustion). Nothing here
// invents a price, weakens a control, or touches risk arithmetic: "spendable" arrives ALREADY bounded by the
// unchanged cash/risk/cluster caps (riskBudgetFor + admitCandidate stay final), so an "all-in" candidate is 100%
// of the risk-bounded spendable budget — never a bypass of the existing limits. This reconciliation toward the
// stricter safety rule is deliberate and documented (doctrine/LEARNING.md).
//
// Declared objective: MAX_BUFFERED_SCENARIO_NET_PROFIT — the size with the best buffered expected account outcome
// (equivalently, best expected % return on the account) — with a predeclared conservative tie-break to the SMALLER
// fraction. Walking a book makes marginal fills worse, so a larger size wins only while its marginal depth still
// carries the advantage; when spread/slippage/depth consumption destroy it, the ladder selects a smaller supported
// amount or reports none. Every candidate size is recorded with why it won or lost. The full-budget fraction is
// flagged eligible ONLY when it outperforms every smaller candidate under this objective on this book.
import * as M from '../execution/money.js';
import { sizeSearch } from './cost.js';

export const SIZE_LADDER_VERSION = 'judge-size-ladder-1';
export const SIZING_OBJECTIVE = 'MAX_BUFFERED_SCENARIO_NET_PROFIT_TIE_TO_SMALLER_FRACTION';
export const DEFAULT_FRACTIONS = Object.freeze(['0.25', '0.5', '0.75', '1']);

export function evaluateSizeLadder({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel = null, cashAvailable, riskBudget, fractions = DEFAULT_FRACTIONS }) {
  const candidates = [];
  for (const fraction of [...fractions].sort((a, b) => Number(a) - Number(b))) {
    const f = String(fraction);
    if (!(Number(f) > 0) || Number(f) > 1) { candidates.push({ fraction: f, status: 'REFUSED', reason: 'FRACTION_OUTSIDE_UNIT_INTERVAL' }); continue; }
    const cash = M.mul(cashAvailable, f);
    const found = sizeSearch({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel, cashAvailable: cash, riskBudget });
    if (found.status !== 'OK') { candidates.push({ fraction: f, status: found.status, reason: found.reason, binding: found.binding ?? [] }); continue; }
    const e = found.evaluation;
    candidates.push({
      fraction: f, status: 'OK', q: found.q, entryCashOut: e.entryCashOut, entryLimitPrice: e.entryLimitPrice,
      bufferedScenarioNetProfit: e.bufferedScenarioNetProfit, scenarioStressedLoss: e.scenarioStressedLoss,
      rewardRiskRatio: e.rewardRiskRatio, binding: found.binding ?? [], found,
    });
  }
  const ok = candidates.filter((c) => c.status === 'OK');
  if (ok.length === 0) {
    return Object.freeze({ sizeLadderVersion: SIZE_LADDER_VERSION, objective: SIZING_OBJECTIVE, selected: null, allInEligible: false, candidates: candidates.map(publicRow), reason: 'NO_ELIGIBLE_SIZE' });
  }
  // best buffered net profit; a TIE goes to the smaller fraction (candidates iterate ascending, so strict-greater keeps the smaller)
  let best = ok[0];
  for (const c of ok.slice(1)) if (M.gt(c.bufferedScenarioNetProfit, best.bufferedScenarioNetProfit)) best = c;
  const allInEligible = best.fraction === '1' && ok.some((c) => c.fraction === '1');
  const rows = candidates.map((c) => ({ ...publicRow(c), selected: c === best, whyNotSelected: c === best ? null : c.status !== 'OK' ? c.reason : M.gt(best.bufferedScenarioNetProfit, c.bufferedScenarioNetProfit) ? 'LOWER_BUFFERED_NET_PROFIT' : 'TIE_BROKEN_TO_SMALLER_FRACTION' }));
  return Object.freeze({
    sizeLadderVersion: SIZE_LADDER_VERSION, objective: SIZING_OBJECTIVE,
    selected: { fraction: best.fraction, q: best.q, found: best.found },
    allInEligible, candidates: rows,
    reason: allInEligible ? 'FULL_BUDGET_OUTPERFORMED_EVERY_SMALLER_CANDIDATE' : 'SMALLER_SIZE_WON_OR_FULL_BUDGET_UNSUPPORTED',
  });
}

function publicRow(c) {
  const { found, ...rest } = c; // the internal evaluation handle is not part of the record
  return rest;
}

// the bounded measurement row recording the ladder inside the existing closed decision vocabulary
export function sizingMeasurement(ladder) {
  const per = ladder.candidates.map((c) => `${c.fraction}:${c.status === 'OK' ? `p=${c.bufferedScenarioNetProfit}` : c.reason}`).join(';');
  return {
    id: 'DYNAMIC_SIZE_SELECTION', ok: ladder.selected !== null,
    value: ladder.selected ? Number(ladder.selected.fraction) : null, threshold: 1,
    unit: 'FRACTION_OF_RISK_BOUNDED_SPENDABLE',
    note: `${ladder.sizeLadderVersion}:${ladder.reason}:${per}`.slice(0, 400),
  };
}
