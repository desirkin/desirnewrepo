// LEARN-1 / FINAL SIZING ADDENDUM — the joint strategy-and-size comparison over ONE recorded opportunity.
//
// Pure. Every cell (strategy x size, plus STAY_OUT and the unchanged baseline) is computed INDEPENDENTLY from the
// recorded decision-time inputs: no cell reuses another's fills, outcome, or account state. Only information
// available at the recorded decision time enters a cell; losing trades, skipped winners, tied-up capital and
// costs stay visible in the outputs.
//
// FIDELITY LAW (the honest core): candle-fidelity inputs carry NO order-book depth, so per-size execution
// deterioration cannot be measured from candles — a larger size can never legitimately look better OR worse from
// candle data alone. Therefore, at CANDLE fidelity this study can rank sizes ONLY through an explicitly supplied
// depth-cost curve (an assumption, labelled as such), and the ALL-IN cell can NEVER be validated eligible from
// candle-only inputs: allInEligible is structurally false unless the cost curve is DEPTH_SUPPORTED (built from
// genuine book observations). This prevents a fake sizing validation long before any live sizing exists.
import { isFiniteNum, round4, deepFreeze } from './contracts.js';

export const SIZING_STUDY_VERSION = 'learning-sizing-study-1';
export const COST_CURVE_KINDS = Object.freeze(['ASSUMED_CANDLE_FIDELITY', 'DEPTH_SUPPORTED']);

// opportunity: { grossPct (candle-observed move over the horizon), feePctPerSide, spendableUsd }
// strategies: [{ id, decision: 'ENTER' | 'SKIP' }] — each strategy's own recorded-time decision on this opportunity
// costCurve: { kind, extraSlippageBpsAt: (fraction) => bps } — the per-size execution penalty; at candle fidelity
//            this is an ASSUMPTION and is labelled in every cell it touched
export function compareStrategySizeGrid({ opportunity, strategies, fractions = [0.25, 0.5, 0.75, 1], costCurve }) {
  if (!opportunity || !isFiniteNum(opportunity.grossPct) || !isFiniteNum(opportunity.spendableUsd) || opportunity.spendableUsd <= 0) throw new Error('sizing study: opportunity malformed');
  if (!costCurve || !COST_CURVE_KINDS.includes(costCurve.kind) || typeof costCurve.extraSlippageBpsAt !== 'function') throw new Error('sizing study: a declared cost curve is required');
  const cells = [];
  cells.push(deepFreeze({ strategyId: 'STAY_OUT', fraction: 0, cashUsed: 0, netPct: 0, netUsd: 0, tiedUpUsd: 0, assumptionLabel: null }));
  for (const s of strategies) {
    for (const fraction of fractions) {
      if (s.decision !== 'ENTER') { cells.push(deepFreeze({ strategyId: s.id, fraction, cashUsed: 0, netPct: 0, netUsd: 0, tiedUpUsd: 0, skipped: true, assumptionLabel: null })); continue; }
      // each cell computes its OWN round trip from the recorded inputs — nothing shared between cells
      const cashUsed = opportunity.spendableUsd * fraction;
      const slipBps = costCurve.extraSlippageBpsAt(fraction);
      if (!isFiniteNum(slipBps) || slipBps < 0) throw new Error('sizing study: cost curve must answer a finite non-negative penalty');
      const fee = opportunity.feePctPerSide / 100;
      const slip = slipBps / 10_000;
      const netFactor = (1 + opportunity.grossPct / 100) * (1 - fee) * (1 - slip) / ((1 + fee) * (1 + slip));
      const netPct = round4((netFactor - 1) * 100);
      cells.push(deepFreeze({
        strategyId: s.id, fraction, cashUsed: round4(cashUsed), netPct, netUsd: round4(cashUsed * netPct / 100), tiedUpUsd: round4(cashUsed),
        assumptionLabel: costCurve.kind === 'ASSUMED_CANDLE_FIDELITY' ? 'SIZE_PENALTY_IS_AN_ASSUMPTION_NOT_OBSERVED_DEPTH' : null,
      }));
    }
  }
  // best cell by net USD account outcome; tie to the SMALLER cash commitment (conservative)
  let best = cells[0];
  for (const c of cells) if (c.netUsd > best.netUsd || (c.netUsd === best.netUsd && c.cashUsed < best.cashUsed)) best = c;
  const allInCells = cells.filter((c) => c.fraction === 1 && !c.skipped);
  const allInWins = allInCells.some((c) => c === best);
  const allInEligible = allInWins && costCurve.kind === 'DEPTH_SUPPORTED';
  return deepFreeze({
    sizingStudyVersion: SIZING_STUDY_VERSION, costCurveKind: costCurve.kind,
    cells, best: { strategyId: best.strategyId, fraction: best.fraction, netUsd: best.netUsd },
    allInEligible,
    allInReason: !allInWins ? 'ALL_IN_DID_NOT_WIN_THE_OBJECTIVE'
      : allInEligible ? 'ALL_IN_WON_UNDER_DEPTH_SUPPORTED_COSTS'
        : 'SIZING_NOT_DIFFERENTIABLE_AT_CANDLE_FIDELITY_ALL_IN_CANNOT_VALIDATE',
    law: 'EACH_CELL_INDEPENDENT; ONLY_DECISION_TIME_INPUTS; CANDLE_FIDELITY_NEVER_VALIDATES_ALL_IN',
  });
}
