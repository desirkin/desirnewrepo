// LEARN-1 — delayed outcome maturation over the one learning label recipe (learning/labels.js), which MIRRORS the
// repository's predetermined offline candle-label law without importing the offline pipeline (the operational
// fence keeps offline research modules out of operational reach — see labels.js): the same anchor arithmetic, the
// same censoring vocabulary, the same knowledge floors. An episode's outcome is attached as a SEPARATE record; the
// snapshot is never rewritten. Readiness is judged by the label's own outcomeKnownAtTs against the caller's as-of
// clock — elapsed wall time alone matures nothing, and computation cannot make tomorrow's outcome known today.
//
// The executable counterfactual is a THIRD dimension beside decision quality and market outcome: it is ESTABLISHED
// only under CANDLE_SIMULATED_EXECUTION with explicit both-side fees and a conservative or unresolved intrabar rule.
// A candle-descriptive excursion is descriptive movement, never captured or missed profit. An untradeable asset's
// favorable path stays UNPROVEN_UNTRADEABLE; no liquidity safeguard is weakened to claim capture.
import { labelOpportunity, LEARNING_LABEL_RECIPE_VERSION } from './labels.js';
import { LEARNING_VERSION, AUTHORITY, PURPOSE, OUTCOME_CLASSES, outcomeAttachError, isFiniteNum, round4, deepFreeze } from './contracts.js';

export { LEARNING_LABEL_RECIPE_VERSION };
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
  const row = labelOpportunity(
    { rowId: episode.opportunityId, canonicalCoin: episode.canonicalCoin, decisionKnownAtTs: episode.usableAtTs },
    { archive, asOfTs },
  );
  const anyKnowable = Object.values(row.horizons).some((h) => h.state !== 'NOT_YET_KNOWN');
  if (!anyKnowable && row.availability.state !== 'UNAVAILABLE') return null; // nothing matured; do not write a record that says nothing
  let counterfactual = null;
  // PUBLISH-FIX-86 (2026-09-20): the simulated round trip (entry at the next bar's open, exit at the 60-minute close, taker fee both
  // sides, slippage against us) had only ever run for the offline childhood campaign (fidelity CANDLE_SIMULATED_EXECUTION): the live
  // service never passed costAssumptions and every live episode is PROSPECTIVE_SHADOW, so 14,623 of 14,707 attaches in production
  // carried counterfactual null. A live episode labelled from the live 1-minute capture is the same candle simulation — it runs.
  if (costAssumptions && (episode.fidelity === 'CANDLE_SIMULATED_EXECUTION' || episode.fidelity === 'PROSPECTIVE_SHADOW')) {
    const series = archive?.oneMinute?.get(episode.canonicalCoin) ?? null;
    // PUBLISH-FIX-86: the round trip obeys the same knowledge floor as the 60m label — a series that already holds the exit bar
    // (a historical archive) never lets an as-of before the horizon claim the result
    const h60 = row.horizons?.['60m'];
    const sim = h60 && h60.state === 'NOT_YET_KNOWN' ? { state: 'UNPROVEN_NO_EXECUTION_SUPPORT', grossPct: null, netPct: null, entryPrice: null, reasons: ['NOT_YET_KNOWN_AT_AS_OF'] } : simulateExecution({ series, anchorTsMs: row.anchorTsMs, horizonMin: 60, feePctPerSide: costAssumptions.feePctPerSide, slippageBps: costAssumptions.slippageBps, entryDelayBars: costAssumptions.entryDelayBars });
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
    learningVersion: LEARNING_VERSION, opportunityId: episode.opportunityId, labelRecipeVersion: LEARNING_LABEL_RECIPE_VERSION,
    outcomeRow: row, counterfactual, attachedTs, supersedes, authority: AUTHORITY, purpose: PURPOSE,
  };
  const err = outcomeAttachError(attach); if (err) throw new Error(`matureEpisode: ${err}`);
  return deepFreeze(attach);
}

// The maturation sweep over pending episodes: returns { attachments, matured, pending, unavailable } — DISTINCT
// counts, never one blended number: `matured` counts attachments carrying real label states, while an honest
// UNAVAILABLE recording (missing series/archive for that asset) is written once but counted apart. Only episodes
// without a settled attachment are considered pending.
// PUBLISH-FIX-83 (full review item 25). Before: every horizon landed on a different sweep, so one episode grew 5-7 outcome rows
// (~40-50k rows for 8,002 episodes, a 290 MB cache); an episode whose data could never arrive (window rolled off, series absent)
// was re-labelled on every sweep forever. Now an episode is written at TWO stages — SHORT (the 1/3/5/15-minute horizons all
// settled: the bite and the continuation) and FULL (every horizon settled) — plus the one UNAVAILABLE row; and past the
// settle deadline (the longest horizon plus a grace window) whatever is still NOT_YET_KNOWN is settled CENSORED so the
// episode leaves the pending set for good. An UNAVAILABLE row is re-tried at most every 15 minutes, never every sweep.
export const SETTLE_GRACE_MS = 60 * 60_000; export const UNAVAILABLE_RETRY_MS = 15 * 60_000; const SHORT_HORIZONS = ['1m', '3m', '5m', '15m'];
const settled = (h) => h && h.state !== 'NOT_YET_KNOWN';
export const outcomeStage = (row) => { if (!row || !row.horizons) return 0; const hs = row.horizons; if (Object.values(hs).every(settled)) return 2; if (SHORT_HORIZONS.every((k) => settled(hs[k]))) return 1; return 0; };
const longestHorizonMs = (row) => Math.max(...Object.keys(row?.horizons ?? {}).map((k) => Number.parseInt(k, 10) * 60_000).filter(Number.isFinite), 240 * 60_000);
function settleAtDeadline(attach) {
  const horizons = {}; let changed = false;
  for (const [k, h] of Object.entries(attach.outcomeRow.horizons)) { if (h.state === 'NOT_YET_KNOWN') { horizons[k] = { ...h, state: 'CENSORED', reason: 'SETTLED_AT_DEADLINE' }; changed = true; } else horizons[k] = h; }
  if (!changed) return attach;
  return deepFreeze({ ...attach, outcomeRow: { ...attach.outcomeRow, horizons } });
}
export function maturationSweep({ episodes, latestOutcomes, archive, asOfTs, attachedTs, costAssumptions = null, maxPerSweep = 500 }) {
  const attachments = []; let matured = 0; let pending = 0; let unavailable = 0; let settledAtDeadline = 0; let skippedRecent = 0;
  for (const e of episodes) {
    if (attachments.length >= maxPerSweep) break;
    const existing = latestOutcomes.get(e.opportunityId);
    const deadlineTs = e.usableAtTs + longestHorizonMs(existing?.outcomeRow) + SETTLE_GRACE_MS; const pastDeadline = asOfTs >= deadlineTs;
    if (existing && existing.outcomeRow.availability.state !== 'UNAVAILABLE') {
      if (outcomeStage(existing.outcomeRow) === 2) continue; // fully matured already
    } else if (existing) {
      if (pastDeadline) continue; // UNAVAILABLE and the data can never arrive: settled as it stands
      if (asOfTs - existing.attachedTs < UNAVAILABLE_RETRY_MS) { skippedRecent += 1; continue; }
    }
    let attach = matureEpisode({ episode: e, archive, asOfTs, attachedTs, costAssumptions, supersedes: existing ? existing.attachedTs : null });
    if (attach === null) { if (pastDeadline && existing) { attach = settleAtDeadline(existing); } else if (pastDeadline) { pending += 1; continue; } else { pending += 1; continue; } }
    if (attach.outcomeRow.availability.state === 'UNAVAILABLE') { unavailable += 1; if (existing && pastDeadline && existing.outcomeRow.availability.state !== 'UNAVAILABLE') { attachments.push(settleAtDeadline(existing)); settledAtDeadline += 1; continue; } /* review finding: a SHORT-stage row whose data then left the window settles, instead of being re-labelled every sweep */ if (existing) continue; attachments.push(attach); continue; }
    if (pastDeadline && outcomeStage(attach.outcomeRow) < 2) { attach = settleAtDeadline(attach); settledAtDeadline += 1; }
    const stageNow = outcomeStage(attach.outcomeRow); const stageBefore = existing ? outcomeStage(existing.outcomeRow) : -1;
    if (stageNow === 0) { pending += 1; continue; } // the bite and the continuation are not both in yet: no row that says half a thing
    const cfEstablished = attach.counterfactual?.state === 'ESTABLISHED' && existing?.counterfactual?.state !== 'ESTABLISHED'; // PUBLISH-FIX-86: the 60-minute round trip landing is worth a row of its own
    if (stageNow <= stageBefore && !cfEstablished) continue; // nothing new matured at a stage that is written
    if (attach.supersedes !== (existing ? existing.attachedTs : null)) attach = deepFreeze({ ...attach, supersedes: existing ? existing.attachedTs : null });
    attachments.push(attach); matured += 1;
  }
  return { attachments, matured, pending, unavailable, settledAtDeadline, skippedRecent };
}

export const OUTCOME_CLASS_SET = OUTCOME_CLASSES;
