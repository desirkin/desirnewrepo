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
// FULL-BALANCE PREREQUISITES: the fraction-1 candidate may even COMPETE only when every required prepared input is
// present and fresh — the unchanged admission law, the freshness law, a protective exit that survives the deepest
// recorded depth haircut, and (under allInEvidence 'REQUIRED', the default) a validated candidate's declared maximum
// supported size (maxSizeUsd; candle-fidelity validation declares null, so evidence-gated full-balance can never cite
// it). Under allInEvidence 'RISK_BOUNDED' the max-size-evidence prerequisite is dropped: full-balance is instead
// bounded by the risk law (scenarioStressedLoss <= riskBudget, enforced inside sizeSearch for EVERY fraction) plus the
// absorption/sustainability objective — this is the LIVE paper "depth-capped whole-nut" law (David's decision: the
// whole nut goes in whenever the structural stop is within the loss cap, the bite shrinks on wider stops, upside is
// never capped). 'REQUIRED' stays the default so the REPLAY "pure all-in" arm remains learning-gated until SIZING
// qualifies. Any absent or stale prerequisite still makes full-balance INELIGIBLE and the ladder falls back to the
// smaller supported sizes. Nothing is ever invented to fill a gap.
import * as M from '../execution/money.js';
import { scenarioExit, sizeSearch } from './cost.js';

export const SIZE_LADDER_VERSION = 'judge-size-ladder-4';
export const SIZING_OBJECTIVE = 'MAX_BUFFERED_NET_PROFIT_WITH_SUSTAINABLE_NET_RETURN_TIE_TO_SMALLER_FRACTION';
export const DEFAULT_FRACTIONS = Object.freeze(['0.25', '0.5', '0.75', '1']);
// The decision contract holds at most 64 measurements. Sixteen leaves room
// for the largest existing setup clause set (13), the learned-candidate log
// (24), and both summary rows: 13 + 24 + 1 + 16 + 1 = 55. Thus every
// accepted fraction remains durable; buildDecision's final contract slice
// cannot silently discard a sizing row.
export const MAX_FRACTIONS = 16;
// a larger size must keep at least (1 - tolerance) of the smaller size's net return % to displace it
export const SUSTAINABILITY_TOLERANCE = 0.1;
// what the fraction-1 candidate requires before it may even compete (each absence is recorded by name)
export const ALL_IN_PREREQUISITES = Object.freeze(['ADMISSION_LAW', 'CANDIDATE_MAX_SIZE_EVIDENCE', 'FRESHNESS_LAW', 'FRESH_BOOK']);

const num = (v) => (v === null || v === undefined ? null : Number(v));

function normalizedFraction(raw) {
  let lexeme;
  if (typeof raw === 'string') lexeme = raw;
  else if (typeof raw === 'number' && Number.isFinite(raw)) {
    try { lexeme = M.fromNumberLexeme(String(raw)); } catch { return { fraction: null, reason: 'FRACTION_MALFORMED' }; }
  } else return { fraction: null, reason: 'FRACTION_MALFORMED' };
  let fraction;
  try { fraction = M.add('0', lexeme); } catch { return { fraction: null, reason: 'FRACTION_MALFORMED' }; }
  if (!M.isPositive(fraction) || M.gt(fraction, '1')) return { fraction, reason: 'FRACTION_OUTSIDE_UNIT_INTERVAL' };
  return { fraction, reason: null };
}

function fractionForRecord(raw, normalized) {
  if (normalized !== null) return normalized;
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw).slice(0, 40) : null;
}

function cmpScaled(left, leftScale, right, rightScale) {
  if (leftScale < rightScale) left *= 10n ** BigInt(rightScale - leftScale);
  else if (rightScale < leftScale) right *= 10n ** BigInt(leftScale - rightScale);
  return left < right ? -1 : left > right ? 1 : 0;
}

// Compare the exact decimal return ratios in two rows. Display rounding must never decide eligibility.
function compareNetReturn(a, b) {
  const ap = M.parseDecimal(a.bufferedScenarioNetProfit); const ac = M.parseDecimal(a.entryCashOut);
  const bp = M.parseDecimal(b.bufferedScenarioNetProfit); const bc = M.parseDecimal(b.entryCashOut);
  return cmpScaled(ap.int * bc.int, ap.scale + bc.scale, bp.int * ac.int, bp.scale + ac.scale);
}

// a.return >= 90% of b.return, expressed as exact cross-products (no division or floating point)
function sustainableAgainst(a, b) {
  const ap = M.parseDecimal(a.bufferedScenarioNetProfit); const ac = M.parseDecimal(a.entryCashOut);
  const bp = M.parseDecimal(b.bufferedScenarioNetProfit); const bc = M.parseDecimal(b.entryCashOut);
  return cmpScaled(ap.int * bc.int * 10n, ap.scale + bc.scale, bp.int * ac.int * 9n, bp.scale + ac.scale) >= 0;
}

function positiveDecimal(value) {
  try { return typeof value === 'string' && M.isPositive(value); } catch { return false; }
}

function missingPrerequisites({ prepared, snapshot, nowTs, allInEvidence = 'REQUIRED' }) {
  const missing = [];
  if (!prepared || typeof prepared.admissible !== 'function') missing.push('ADMISSION_LAW');
  // 'RISK_BOUNDED' drops the learning max-size gate: the risk law inside sizeSearch bounds full-balance instead.
  if (allInEvidence !== 'RISK_BOUNDED' && (!prepared || !Number.isFinite(prepared.candidateMaxSizeUsd) || prepared.candidateMaxSizeUsd <= 0)) missing.push('CANDIDATE_MAX_SIZE_EVIDENCE');
  if (!prepared || !Number.isFinite(prepared.maxBookAgeMs) || prepared.maxBookAgeMs < 0 || !Number.isFinite(nowTs)) missing.push('FRESHNESS_LAW');
  else if (!Number.isFinite(snapshot?.receiptTs) || snapshot.receiptTs > nowTs || nowTs - snapshot.receiptTs > prepared.maxBookAgeMs) missing.push('FRESH_BOOK');
  return missing;
}

export function evaluateSizeLadder({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel = null, cashAvailable, riskBudget, fractions = DEFAULT_FRACTIONS, prepared = null, nowTs = null, allInEvidence = 'REQUIRED' }) {
  const allInMissing = missingPrerequisites({ prepared, snapshot, nowTs, allInEvidence });
  const candidates = [];
  if (!Array.isArray(fractions) || fractions.length > MAX_FRACTIONS) {
    candidates.push({ fraction: null, status: 'REFUSED', reason: Array.isArray(fractions) ? 'FRACTION_COUNT_EXCEEDS_LIMIT' : 'FRACTIONS_NOT_ARRAY' });
    return Object.freeze({ sizeLadderVersion: SIZE_LADDER_VERSION, objective: SIZING_OBJECTIVE, sustainabilityTolerance: SUSTAINABILITY_TOLERANCE, selected: null, allInEligible: false, allInMissing, candidates, reason: 'NO_ELIGIBLE_SIZE' });
  }
  const normalized = fractions.map((raw, index) => ({ raw, index, ...normalizedFraction(raw) }));
  normalized.sort((a, b) => a.fraction !== null && b.fraction !== null ? M.cmp(a.fraction, b.fraction) : a.fraction !== null ? -1 : b.fraction !== null ? 1 : a.index - b.index);
  const seen = new Set();
  for (const item of normalized) {
    const f = fractionForRecord(item.raw, item.fraction);
    if (item.reason !== null) { candidates.push({ fraction: f, status: 'REFUSED', reason: item.reason }); continue; }
    if (seen.has(f)) { candidates.push({ fraction: f, status: 'REFUSED', reason: 'DUPLICATE_FRACTION' }); continue; }
    seen.add(f);
    const cash = M.mul(cashAvailable, f);
    const found = sizeSearch({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel, cashAvailable: cash, riskBudget });
    if (found.status !== 'OK') { candidates.push({ fraction: f, status: found.status, reason: found.reason, binding: found.binding ?? [] }); continue; }
    const e = found.evaluation;
    const entryCash = num(e.entryCashOut);
    const netReturnPct = entryCash > 0 ? num(e.bufferedScenarioNetProfit) / entryCash * 100 : null;
    // Target-exit deterioration and protective-close feasibility are distinct: prove the latter at the stop-stress mid.
    const sens = Object.fromEntries(Object.entries(e.sensitivities ?? {}).map(([k, v]) => [k, v.cashIn === null ? null : v.net]));
    const protective = scenarioExit({ snapshot, q: e.netBase, scenarioMid: e.stressMid, spec, fee, haircut: '0.25' });
    const protectiveExitOk = protective.status === 'OK' && positiveDecimal(protective.cashIn);
    const protectiveExitAtDepth25pct = protective.status === 'OK'
      ? { cashIn: protective.cashIn, net: M.sub(protective.cashIn, e.entryCashOut), scenarioMid: e.stressMid, haircut: '0.25' }
      : { cashIn: null, reason: protective.reason ?? 'PROTECTIVE_EXIT_UNKNOWN', scenarioMid: e.stressMid, haircut: '0.25' };
    const row = {
      fraction: f, status: 'OK', q: found.q,
      entryLimitPrice: e.entryLimitPrice, entryCashOut: e.entryCashOut, scenarioExitCashIn: e.scenarioExitCashIn,
      entryFeeBound: e.entryFeeBound, spreadCost: e.attribution?.spread ?? null, slippageCost: e.attribution?.slippage ?? null,
      executionUncertaintyBuffer: e.executionUncertaintyBuffer,
      bufferedScenarioNetProfit: e.bufferedScenarioNetProfit, netReturnPct: netReturnPct === null ? null : Math.round(netReturnPct * 10_000) / 10_000,
      scenarioStressedLoss: e.scenarioStressedLoss, rewardRiskRatio: e.rewardRiskRatio,
      depthExitSensitivities: sens, protectiveExitAtDepth25pct, protectiveExitOk,
      opportunityCostVsStayOut: e.bufferedScenarioNetProfit, // STAY_OUT nets exactly 0: the recorded comparison basis
      binding: found.binding ?? [], admission: null, found,
    };
    // full-balance prerequisites: fraction 1 may not even compete while any required prepared input is missing/stale
    if (f === '1' && allInMissing.length) { candidates.push({ ...row, status: 'REFUSED', reason: `ALL_IN_PREREQUISITES_MISSING:${allInMissing.join('+')}` }); continue; }
    // a validated candidate's declared maximum supported size binds every fraction it covers (never invented)
    if (prepared && Number.isFinite(prepared.candidateMaxSizeUsd) && entryCash > prepared.candidateMaxSizeUsd) { candidates.push({ ...row, status: 'REFUSED', reason: 'ABOVE_CANDIDATE_MAX_SUPPORTED_SIZE' }); continue; }
    // the UNCHANGED admission law per size (cash/risk/cluster caps, concentration, open reservations/positions)
    if (prepared && typeof prepared.admissible === 'function') {
      let adm;
      try { adm = prepared.admissible(e); }
      catch { row.admission = { ok: false, reasons: ['CHECK_FAILED'] }; candidates.push({ ...row, status: 'REFUSED', reason: 'ADMISSION_CHECK_FAILED' }); continue; }
      const reasons = Array.isArray(adm?.reasons) ? adm.reasons.filter((reason) => typeof reason === 'string' && reason.length > 0) : [];
      row.admission = { ok: adm?.ok === true, reasons };
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
  let bestReturnSeen = ok[0];
  const losses = new Map();
  for (const c of ok.slice(1)) {
    const anchor = bestReturnSeen;
    if (compareNetReturn(c, bestReturnSeen) > 0) bestReturnSeen = c;
    if (!M.gt(c.bufferedScenarioNetProfit, best.bufferedScenarioNetProfit)) { losses.set(c, M.gt(best.bufferedScenarioNetProfit, c.bufferedScenarioNetProfit) ? 'LOWER_BUFFERED_NET_PROFIT' : 'TIE_BROKEN_TO_SMALLER_FRACTION'); continue; }
    const sustainable = sustainableAgainst(c, anchor);
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

function finiteFractionValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !M.isCanonicalDecimal(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// the bounded measurement rows recording the ladder inside the existing closed decision vocabulary (a decision
// note is capped at 300 chars): a summary row with the selection and the ladder-level reason, plus ONE durable
// row per candidate size carrying its outcome (buffered profit + net return %) or its exact refusal reason
export function sizingMeasurement(ladder) {
  return {
    id: 'DYNAMIC_SIZE_SELECTION', ok: ladder.selected !== null,
    value: ladder.selected ? finiteFractionValue(ladder.selected.fraction) : null, threshold: 1,
    unit: 'FRACTION_OF_RISK_BOUNDED_SPENDABLE',
    note: `${ladder.sizeLadderVersion}:${ladder.reason}:sizes=${ladder.candidates.length}`.slice(0, 300),
  };
}
export function sizingCandidateLog(ladder) {
  return ladder.candidates.slice(0, MAX_FRACTIONS).map((c) => ({
    id: 'SIZE_CANDIDATE', ok: c.status === 'OK', value: finiteFractionValue(c.fraction), threshold: 1, unit: 'FRACTION_OF_RISK_BOUNDED_SPENDABLE',
    note: (c.status === 'OK'
      ? `p=${c.bufferedScenarioNetProfit};r=${c.netReturnPct}%;risk=${c.scenarioStressedLoss};${c.selected ? 'SELECTED' : c.whyNotSelected ?? 'NOT_SELECTED'}`
      : String(c.reason)).slice(0, 300),
  }));
}
