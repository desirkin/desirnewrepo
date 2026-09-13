// LEARN-1 — delayed outcome maturation. REUSES the existing predetermined candle-only label recipe
// (research/outcomes.js, social-research-candle-labels-1) rather than wiring a second labeler: the same anchor
// arithmetic, the same censoring vocabulary, the same knowledge floors. An episode's outcome is attached as a
// SEPARATE record; the snapshot is never rewritten. Readiness is judged by the label's own outcomeKnownAtTs against
// the caller's as-of clock — elapsed wall time alone matures nothing, and computation cannot make tomorrow's
// outcome known today.
//
// The executable counterfactual is a THIRD dimension beside decision quality and market outcome: it is ESTABLISHED
// only under CANDLE_SIMULATED_EXECUTION with explicit both-side fees and a conservative or unresolved intrabar rule.
// A candle-descriptive excursion is descriptive movement, never captured or missed profit. An untradeable asset's
// favorable path stays UNPROVEN_UNTRADEABLE; no liquidity safeguard is weakened to claim capture.
import { labelRow } from '../research/outcomes.js';
import { LABEL_RECIPE_VERSION } from '../research/contracts.js';
import { LEARNING_VERSION, AUTHORITY, PURPOSE, OUTCOME_CLASSES, outcomeAttachError, isFiniteNum, round4, deepFreeze } from './contracts.js';

export { LABEL_RECIPE_VERSION };
export const NEUTRAL_BAND_PCT = 0.25; // |60m log return| inside this band is NEUTRAL, not a win or a loss

// classify ONE matured horizon into the closed outcome classes. CENSORED / NOT_YET_KNOWN / UNAVAILABLE are kept
// distinct and are never forced into wins or losses.
export function classifyOutcome(horizon) {
  if (!horizon) return 'UNAVAILABLE';
  if (horizon.state === 'OUTCOME_UNAVAILABLE') return 'UNAVAILABLE';
  if (horizon.state === 'NOT_YET_KNOWN') return 'NOT_YET_KNOWN';
  if (horizon.state === 'CENSORED') return 'CENSORED';
  const v = horizon.logReturnPct;
  if (!isFiniteNum(v)) return 'CENSORED';
  if (v > NEUTRAL_BAND_PCT) return 'FAVORABLE';
  if (v < -NEUTRAL_BAND_PCT) return 'ADVERSE';
  return 'NEUTRAL';
}

// simulate a conservative long round trip from the label anchor: enter at the NEXT bar's open after an entry delay,
// exit at the horizon's final close, fees charged on both sides, slippage against the trader on both sides.
// Intrabar stop/target ordering is NOT resolved here (rule UNRESOLVED); a caller wanting stops must predeclare
// ADVERSE_FIRST and gets the pessimistic reading.
export function simulateExecution({ series, anchorTsMs, horizonMin, feePctPerSide, slippageBps, entryDelayBars = 1 }) {
  const reasons = [];
  if (!series) return { state: 'UNPROVEN_NO_EXECUTION_SUPPORT', grossPct: null, netPct: null, entryPrice: null, reasons: ['SERIES_ABSENT'] };
  const anchorSec = anchorTsMs / 1000;
  const entryOpenSec = anchorSec + 60 * (entryDelayBars - 1);
  const entryIdx = series.index.get(entryOpenSec + 60); // the bar AFTER the delay window opens the position at its open
  const exitOpenSec = anchorSec + horizonMin * 60 - 60;
  const exitIdx = series.index.get(exitOpenSec);
  if (entryIdx === undefined || exitIdx === undefined) return { state: 'UNPROVEN_NO_EXECUTION_SUPPORT', grossPct: null, netPct: null, entryPrice: null, reasons: ['ENTRY_OR_EXIT_BAR_MISSING'] };
  if (series.coverageEndSec < anchorSec + horizonMin * 60) return { state: 'UNPROVEN_NO_EXECUTION_SUPPORT', grossPct: null, netPct: null, entryPrice: null, reasons: ['COVERAGE_ENDS_BEFORE_HORIZON'] };
  const slip = slippageBps / 10_000;
  const entryPrice = series.candles[entryIdx][1] * (1 + slip); // buy at open, slipped against us
  const exitPrice = series.candles[exitIdx][4] * (1 - slip); // sell at final close, slipped against us
  if (!(entryPrice > 0) || !(exitPrice > 0)) return { state: 'UNPROVEN_NO_EXECUTION_SUPPORT', grossPct: null, netPct: null, entryPrice: null, reasons: ['PRICE_INVALID'] };
  const grossPct = round4((exitPrice / entryPrice - 1) * 100);
  const fee = feePctPerSide / 100;
  const netPct = round4(((exitPrice * (1 - fee)) / (entryPrice * (1 + fee)) - 1) * 100);
  return { state: 'ESTABLISHED', grossPct, netPct, entryPrice: round4(entryPrice), reasons };
}

// Label one episode against the archive at asOfTs and, when execution fidelity is requested, attach the simulated
// round trip. Returns null when nothing new is knowable yet (the episode stays pending — an honest state).
export function matureEpisode({ episode, archive, asOfTs, attachedTs, costAssumptions = null, supersedes = null }) {
  const row = labelRow(
    { rowId: episode.opportunityId, cohort: 'PRIMARY', canonicalCoin: episode.canonicalCoin, decisionKnownAtTs: episode.usableAtTs },
    { archive, asOfTs },
  );
  const anyKnowable = Object.values(row.horizons).some((h) => h.state !== 'NOT_YET_KNOWN');
  if (!anyKnowable && row.availability.state !== 'UNAVAILABLE') return null; // nothing matured; do not write a record that says nothing
  let counterfactual = null;
  if (costAssumptions && episode.fidelity === 'CANDLE_SIMULATED_EXECUTION') {
    const series = archive?.oneMinute?.get(episode.canonicalCoin) ?? null;
    const sim = simulateExecution({ series, anchorTsMs: row.anchorTsMs, horizonMin: 60, feePctPerSide: costAssumptions.feePctPerSide, slippageBps: costAssumptions.slippageBps, entryDelayBars: costAssumptions.entryDelayBars });
    counterfactual = {
      state: sim.state, fidelity: 'CANDLE_SIMULATED_EXECUTION', entryDelayBars: costAssumptions.entryDelayBars,
      entryPrice: sim.entryPrice, exitRule: 'HORIZON_60M_FINAL_CLOSE', grossPct: sim.state === 'ESTABLISHED' ? sim.grossPct : null,
      feePctPerSide: costAssumptions.feePctPerSide, slippageBps: costAssumptions.slippageBps,
      netPct: sim.state === 'ESTABLISHED' ? sim.netPct : null, reasons: sim.reasons,
    };
  } else if (episode.fidelity === 'CANDLE_DESCRIPTIVE') {
    counterfactual = { state: 'NOT_COMPUTED', fidelity: 'CANDLE_DESCRIPTIVE', entryDelayBars: 0, entryPrice: null, exitRule: 'NONE', grossPct: null, feePctPerSide: 0, slippageBps: 0, netPct: null, reasons: ['DESCRIPTIVE_ONLY_NO_EXECUTION_CLAIM'] };
  }
  const attach = {
    learningVersion: LEARNING_VERSION, opportunityId: episode.opportunityId, labelRecipeVersion: LABEL_RECIPE_VERSION,
    outcomeRow: row, counterfactual, attachedTs, supersedes, authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = outcomeAttachError(attach); if (err) throw new Error(`matureEpisode: ${err}`);
  return deepFreeze(attach);
}

// The maturation sweep over pending episodes: returns { matured, pending, unavailable } — distinct daily counts,
// never one blended number. Only episodes WITHOUT a current attachment are considered pending.
export function maturationSweep({ episodes, latestOutcomes, archive, asOfTs, attachedTs, costAssumptions = null, maxPerSweep = 500 }) {
  const matured = []; let pending = 0; let unavailable = 0;
  for (const e of episodes) {
    if (matured.length >= maxPerSweep) break;
    const existing = latestOutcomes.get(e.opportunityId);
    if (existing && existing.outcomeRow.availability.state !== 'UNAVAILABLE') {
      const allSettled = Object.values(existing.outcomeRow.horizons).every((h) => h.state !== 'NOT_YET_KNOWN');
      if (allSettled) continue; // fully matured already
    }
    const attach = matureEpisode({ episode: e, archive, asOfTs, attachedTs, costAssumptions, supersedes: existing ? existing.attachedTs : null });
    if (attach === null) { pending += 1; continue; }
    if (attach.outcomeRow.availability.state === 'UNAVAILABLE') { unavailable += 1; if (existing) continue; }
    if (existing && JSON.stringify(existing.outcomeRow.horizons) === JSON.stringify(attach.outcomeRow.horizons)) continue; // nothing new matured
    matured.push(attach);
  }
  return { matured, pending, unavailable };
}

export const OUTCOME_CLASS_SET = OUTCOME_CLASSES;
