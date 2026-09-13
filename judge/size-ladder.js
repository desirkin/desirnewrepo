// JUDGE — the dynamic purchase-size ladder (FINAL DYNAMIC-SIZING ADDENDUM), default-off and PURE.
//
// For one already fully qualified opportunity it evaluates MULTIPLE candidate purchase amounts — fractions of the
// spendable budget up to 1.0 — each through the EXISTING execution-fidelity cost law (judge/cost.js sizeSearch:
// real book walking, both-side fees, stress, reward/risk screen, lot/min/precision, depth exhaustion). Nothing here
// invents a price, weakens a control, or touches risk arithmetic: "spendable" arrives ALREADY bounded by the
// unchanged cash/risk/cluster caps (riskBudgetFor: caps.cashAvailable is net of open reservations; admitCandidate
// stays final), so an "all-in" candidate is 100% of the risk-bounded spendable budget — never a bypass of the
// existing limits. This reconciliation toward the stricter safety rule is deliberate and documented
// (doctrine/LEARNING.md).
//
// DECLARED OBJECTIVE (sustainable account outcome, not raw absolute profit): among supported sizes, the best
// buffered scenario net profit wins ONLY while its net RETURN (profit per cash committed) has not degraded beyond
// the predeclared tolerance relative to the best smaller supported size. A larger purchase whose marginal fills
// destroy the percentage return is NOT a better account outcome even when its absolute profit is nominally higher:
// it ties up more capital, worsens the exit, and concentrates risk. Ties go to the SMALLER fraction.
//
// EVERY candidate size is recorded: executable entry price and cash, scenario exit, entry fee bound, spread and
// slippage attribution (already inside the walked cash flows), buffered profit, net return %, stressed loss,
// reward/risk, depth-haircut exit sensitivities (the recorded exit deterioration), the unchanged admission verdict
// (concentration / cluster / reservations / risk caps via the injected admitCandidate law), and why it won or lost.
//
// FULL-BALANCE PREREQUISITES (conservative by construction): the fraction-1 candidate may even COMPETE only when
// every required prepared input is present and fresh — the unchanged admission law, a validated candidate's
// declared maximum supported size (maxSizeUsd; candle-fidelity validation declares null, so full-balance can never
// cite it), the freshness law, and a protective exit that survives the deepest recorded depth haircut. Any absent
// or stale prerequisite makes full-balance INELIGIBLE and the ladder falls back to the smaller supported sizes —
// which is conservative relative to the unchanged baseline (baseline sizeSearch may use the whole budget).
// Nothing is ever invented to fill a gap.
import * as M from '../execution/money.js';
import { sizeSearch } from './cost.js';

export const SIZE_LADDER_VERSION = 'judge-size-ladder-2';
export const SIZING_OBJECTIVE = 'MAX_BUFFERED_NET_PROFIT_WITH_SUSTAINABLE_NET_RETURN_TIE_TO_SMALLER_FRACTION';
export const DEFAULT_FRACTIONS = Object.freeze(['0.25', '0.5', '0.75', '1']);
// a larger size must keep at least (1 - tolerance) of the smaller size's net return % to displace it
export const SUSTAINABILITY_TOLERANCE = 0.1;
// what the fraction-1 candidate requires before it may even compete (each absence is recorded by name)
export const ALL_IN_PREREQUISITES = Object.freeze(['ADMISSION_LAW', 'CANDIDATE_MAX_SIZE_EVIDENCE', 'FRESHNESS_LAW', 'FRESH_BOOK']);

const num = (v) => (v === null || v === undefined ? null : Number(v));

function missingPrerequisites({ prepared, snapshot, nowTs }) {
  const missing = [];
  if (!prepared || typeof prepared.admissible !== 'function') missing.push('ADMISSION_LAW');
  if (!prepared || !Number.isFinite(prepared.candidateMaxSizeUsd) || prepared.candidateMaxSizeUsd <= 0) missing.push('CANDIDATE_MAX_SIZE_EVIDENCE');
  if (!prepared || !Number.isFinite(prepared.maxBookAgeMs) || !Number.isFinite(nowTs)) missing.push('FRESHNESS_LAW');
  else if (!Number.isFinite(snapshot?.receiptTs) || nowTs - snapshot.receiptTs > prepared.maxBookAgeMs) missing.push('FRESH_BOOK');
  return missing;
}

export function evaluateSizeLadder({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel = null, cashAvailable, riskBudget, fractions = DEFAULT_FRACTIONS, prepared = null, nowTs = null }) {
  const allInMissing = missingPrerequisites({ prepared, snapshot, nowTs });
  const candidates = [];
  for (const fraction of [...fractions].sort((a, b) => Number(a) - Number(b))) {
    const f = String(fraction);
    if (!(Number(f) > 0) || Number(f) > 1) { candidates.push({ fraction: f, status: 'REFUSED', reason: 'FRACTION_OUTSIDE_UNIT_INTERVAL' }); continue; }
    const cash = M.mul(cashAvailable, f);
    const found = sizeSearch({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel, cashAvailable: cash, riskBudget });
    if (found.status !== 'OK') { candidates.push({ fraction: f, status: found.status, reason: found.reason, binding: found.binding ?? [] }); continue; }
    const e = found.evaluation;
    const entryCash = num(e.entryCashOut);
    const netReturnPct = entryCash > 0 ? num(e.bufferedScenarioNetProfit) / entryCash * 100 : null;
    // exit deterioration record + protective-close feasibility: the deepest recorded haircut must still answer an exit
    const sens = Object.fromEntries(Object.entries(e.sensitivities ?? {}).map(([k, v]) => [k, v.cashIn === null ? null : v.net]));
    const protectiveExitOk = e.sensitivities?.depth_25pct ? e.sensitivities.depth_25pct.cashIn !== null : false;
    const row = {
      fraction: f, status: 'OK', q: found.q,
      entryLimitPrice: e.entryLimitPrice, entryCashOut: e.entryCashOut, scenarioExitCashIn: e.scenarioExitCashIn,
      entryFeeBound: e.entryFeeBound, spreadCost: e.attribution?.spread ?? null, slippageCost: e.attribution?.slippage ?? null,
      executionUncertaintyBuffer: e.executionUncertaintyBuffer,
      bufferedScenarioNetProfit: e.bufferedScenarioNetProfit, netReturnPct: netReturnPct === null ? null : Math.round(netReturnPct * 10_000) / 10_000,
      scenarioStressedLoss: e.scenarioStressedLoss, rewardRiskRatio: e.rewardRiskRatio,
      depthExitSensitivities: sens, protectiveExitOk,
      opportunityCostVsStayOut: e.bufferedScenarioNetProfit, // STAY_OUT nets exactly 0: the recorded comparison basis
      binding: found.binding ?? [], admission: null, found,
    };
    // full-balance prerequisites: fraction 1 may not even compete while any required prepared input is missing/stale
    if (f === '1' && allInMissing.length) { candidates.push({ ...row, status: 'REFUSED', reason: `ALL_IN_PREREQUISITES_MISSING:${allInMissing.join('+')}` }); continue; }
    // a validated candidate's declared maximum supported size binds every fraction it covers (never invented)
    if (prepared && Number.isFinite(prepared.candidateMaxSizeUsd) && entryCash > prepared.candidateMaxSizeUsd) { candidates.push({ ...row, status: 'REFUSED', reason: 'ABOVE_CANDIDATE_MAX_SUPPORTED_SIZE' }); continue; }
    // the UNCHANGED admission law per size (cash/risk/cluster caps, concentration, open reservations/positions)
    if (prepared && typeof prepared.admissible === 'function') {
      const adm = prepared.admissible(e);
      row.admission = { ok: adm.ok === true, reasons: adm.reasons ?? [] };
      if (!row.admission.ok) { candidates.push({ ...row, status: 'REFUSED', reason: `ADMISSION_${row.admission.reasons[0] ?? 'REFUSED'}` }); continue; }
    }
    if (!protectiveExitOk) { candidates.push({ ...row, status: 'REFUSED', reason: 'PROTECTIVE_EXIT_UNSUPPORTED_AT_DEPTH' }); continue; }
    candidates.push(row);
  }
  const ok = candidates.filter((c) => c.status === 'OK');
  if (ok.length === 0) {
    return Object.freeze({ sizeLadderVersion: SIZE_LADDER_VERSION, objective: SIZING_OBJECTIVE, sustainabilityTolerance: SUSTAINABILITY_TOLERANCE, selected: null, allInEligible: false, allInMissing, candidates: candidates.map(publicRow), reason: 'NO_ELIGIBLE_SIZE' });
  }
  // ascending fractions: a larger size displaces the incumbent only with STRICTLY better buffered profit AND a
  // net return that has not degraded beyond the predeclared tolerance versus the BEST return among the smaller
  // supported sizes (anchoring to the best, not the incumbent, so degradation can never creep in by steps)
  let best = ok[0];
  let bestPctSeen = ok[0].netReturnPct ?? null;
  const losses = new Map();
  for (const c of ok.slice(1)) {
    const anchor = bestPctSeen;
    if (c.netReturnPct !== null && (bestPctSeen === null || c.netReturnPct > bestPctSeen)) bestPctSeen = c.netReturnPct;
    if (!M.gt(c.bufferedScenarioNetProfit, best.bufferedScenarioNetProfit)) { losses.set(c, M.gt(best.bufferedScenarioNetProfit, c.bufferedScenarioNetProfit) ? 'LOWER_BUFFERED_NET_PROFIT' : 'TIE_BROKEN_TO_SMALLER_FRACTION'); continue; }
    const sustainable = anchor === null || anchor <= 0 || (c.netReturnPct !== null && c.netReturnPct >= anchor * (1 - SUSTAINABILITY_TOLERANCE));
    if (!sustainable) { losses.set(c, 'NET_RETURN_DEGRADATION_BEYOND_TOLERANCE'); continue; }
    losses.set(best, 'LOWER_BUFFERED_NET_PROFIT'); best = c;
  }
  const allInEligible = best.fraction === '1' && allInMissing.length === 0;
  const rows = candidates.map((c) => ({ ...publicRow(c), selected: c === best, whyNotSelected: c === best ? null : c.status !== 'OK' ? c.reason : losses.get(c) ?? 'LOWER_BUFFERED_NET_PROFIT' }));
  return Object.freeze({
    sizeLadderVersion: SIZE_LADDER_VERSION, objective: SIZING_OBJECTIVE, sustainabilityTolerance: SUSTAINABILITY_TOLERANCE,
    selected: { fraction: best.fraction, q: best.q, found: best.found },
    allInEligible, allInMissing, candidates: rows,
    reason: allInEligible ? 'FULL_BUDGET_OUTPERFORMED_EVERY_SMALLER_CANDIDATE_WITH_PREREQUISITES_MET'
      : allInMissing.length ? `SMALLER_SIZE_SELECTED_ALL_IN_PREREQUISITES_MISSING:${allInMissing.join('+')}`
        : 'SMALLER_SIZE_WON_OR_FULL_BUDGET_UNSUPPORTED',
  });
}

function publicRow(c) {
  const { found, ...rest } = c; // the internal evaluation handle is not part of the record
  return rest;
}

// the bounded measurement rows recording the ladder inside the existing closed decision vocabulary (a decision
// note is capped at 300 chars): a summary row with the selection and the ladder-level reason, plus ONE durable
// row per candidate size carrying its outcome (buffered profit + net return %) or its exact refusal reason
export function sizingMeasurement(ladder) {
  return {
    id: 'DYNAMIC_SIZE_SELECTION', ok: ladder.selected !== null,
    value: ladder.selected ? Number(ladder.selected.fraction) : null, threshold: 1,
    unit: 'FRACTION_OF_RISK_BOUNDED_SPENDABLE',
    note: `${ladder.sizeLadderVersion}:${ladder.reason}:sizes=${ladder.candidates.length}`.slice(0, 300),
  };
}
export function sizingCandidateLog(ladder) {
  return ladder.candidates.slice(0, 16).map((c) => ({
    id: 'SIZE_CANDIDATE', ok: c.status === 'OK', value: Number(c.fraction), threshold: 1, unit: 'FRACTION_OF_RISK_BOUNDED_SPENDABLE',
    note: (c.status === 'OK'
      ? `p=${c.bufferedScenarioNetProfit};r=${c.netReturnPct}%;risk=${c.scenarioStressedLoss};${c.selected ? 'SELECTED' : c.whyNotSelected ?? 'NOT_SELECTED'}`
      : String(c.reason)).slice(0, 300),
  }));
}
