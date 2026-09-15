// SIM-1 (2026-09-15). The simulator half of the ≥10%-mover daily study (DATA-1 is the archive sink). The daily-move
// study already classifies each archived civil day into SURGE_CASE / FAILED_BREAKOUT_CONTROL / FALLING_CONTROL /
// FLAT_CONTROL and materializes prefix-only decision frames whose reserved simulation counters it leaves hard-zeroed.
// SIM-1 is the missing driver: over those decision frames it runs a bounded, pure PRICE-GEOMETRY detector on ONLY the
// evidence known by each decision clock (the prefix), records where the detector would have fired, and scores the
// forward "bite" outcome SEPARATELY from the retrospective label — never letting the day's outcome enter the decision.
// It answers the wide end of the funnel: over every mover in the archived day, what would a price-geometry entry have
// caught, and how does its firing split across surges vs the matched controls.
//
// Authority NONE, purpose RESEARCH_ONLY. It reads the study + the archived candles and emits its OWN simulation record;
// it never mutates the study (whose counters stay zero-credit), never touches the Judge / Watch / execution / a model /
// a provider, and is pure and deterministic (no clock, no I/O, no randomness) so an offline run reproduces exactly.
export const DAILY_MOVE_SIMULATOR_VERSION = 'daily-move-simulator-1';
export const DEFAULT_BITE_HORIZON_MS = 5 * 60_000; // the 5-minute bite window (the decision-yardstick horizon)

// A prefix is the closed candles a decision clock could know: knownAtTs at/before the decision, sorted by period end.
function prefixCandles(candles, decisionTs) {
  return candles.filter((c) => Number.isSafeInteger(c?.knownAtTs) && c.knownAtTs <= decisionTs && Number.isSafeInteger(c.periodEndTs) && c.periodEndTs <= decisionTs)
    .sort((a, b) => a.periodEndTs - b.periodEndTs);
}

// The default detector: a pure price-geometry breakout over 1m OHLC — fires when the latest known close has risen
// STRICTLY more than riseThresholdPct above the lowest close in the prefix AND is the prefix's highest close (a fresh
// high, not a bounce on the way down). Computable from the archive's candles alone (no book / flow / depth), so it is a
// faithful proxy for the price geometry of an ignition breakout, never a claim to the full setup law.
export function priceGeometryBreakoutDetector({ riseThresholdPct = 8 } = {}) {
  const detect = (prefix) => {
    const closes = prefix.map((c) => c.close).filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
    if (closes.length < 2) return { fire: false, reason: 'INSUFFICIENT_PREFIX' };
    const min = Math.min(...closes); const max = Math.max(...closes); const last = closes[closes.length - 1];
    const risePct = 100 * (last - min) / min;
    const fire = risePct > riseThresholdPct && last === max;
    return { fire, risePct: Number(risePct.toFixed(4)), reason: fire ? null : (last !== max ? 'NOT_A_FRESH_HIGH' : 'RISE_BELOW_THRESHOLD') };
  };
  detect.id = 'PRICE_GEOMETRY_BREAKOUT';
  detect.params = { riseThresholdPct };
  return detect;
}

// The forward bite, kept strictly separate from the decision: entry = the open of the first candle that OPENS at or
// after the fire clock (a conservative post-decision fill), exit = the close of the last candle ending at or before the
// fire clock + horizon. log return in %. Missing entry/exit candles => an honest UNAVAILABLE, never a fabricated zero.
function biteOutcome(candles, fireTs, horizonMs) {
  const entryCandle = candles.filter((c) => c.periodStartTs >= fireTs).sort((a, b) => a.periodStartTs - b.periodStartTs)[0] ?? null;
  if (!entryCandle || typeof entryCandle.open !== 'number' || !(entryCandle.open > 0)) return { state: 'OUTCOME_UNAVAILABLE', reason: 'NO_POST_DECISION_ENTRY_CANDLE' };
  const horizonEndTs = fireTs + horizonMs;
  const matured = candles.filter((c) => c.periodEndTs <= horizonEndTs && c.periodEndTs > entryCandle.periodStartTs).sort((a, b) => a.periodEndTs - b.periodEndTs);
  const exit = matured[matured.length - 1] ?? null;
  if (!exit || typeof exit.close !== 'number' || !(exit.close > 0)) return { state: 'NOT_YET_KNOWN', reason: 'HORIZON_NOT_COVERED', entryPrice: entryCandle.open };
  return { state: 'KNOWN', entryPrice: entryCandle.open, exitPrice: exit.close, entryTs: entryCandle.periodStartTs, exitTs: exit.periodEndTs, logReturnPct: Number((100 * Math.log(exit.close / entryCandle.open)).toFixed(4)) };
}

const freeze = (o) => { if (o && typeof o === 'object') { for (const v of Object.values(o)) freeze(v); Object.freeze(o); } return o; };

// simulateDailyMoves({ study, marketDays, detector?, horizonMs? }) -> a frozen simulation record. study is the output of
// buildDailyMoveStudy (its cases carry retrospectiveReplay.decisionFrames + retrospectiveLabels); marketDays supplies the
// per-market candle series (the same array buildDailyMoveStudy consumed). Only cases with materialized decision frames
// are simulated (the surges and their matched controls). One bite per case: the FIRST frame the detector fires on.
export function simulateDailyMoves({ study, marketDays, detector = priceGeometryBreakoutDetector(), horizonMs = DEFAULT_BITE_HORIZON_MS } = {}) {
  if (!study || !Array.isArray(study.cases)) throw new Error('daily-move-simulator: a built daily-move study with cases is required');
  if (typeof detector !== 'function') throw new Error('daily-move-simulator: detector must be a function');
  const candlesByDigest = new Map((Array.isArray(marketDays) ? marketDays : []).map((d) => [d?.marketIdentityDigest, Array.isArray(d?.candles) ? d.candles : []]));
  const cases = [];
  const counters = { casesWithFrames: 0, framesEvaluated: 0, attemptedSimulations: 0, firedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0 };
  const firedByDisposition = {}; const casesByDisposition = {};
  for (const c of study.cases) {
    const frames = c?.retrospectiveReplay?.decisionFrames ?? [];
    const disposition = c?.retrospectiveLabels?.disposition ?? 'UNKNOWN';
    casesByDisposition[disposition] = (casesByDisposition[disposition] ?? 0) + 1;
    if (!frames.length) continue;
    counters.casesWithFrames += 1;
    counters.attemptedSimulations += 1; // one bite attempt per case with frames
    const candles = candlesByDigest.get(c.marketIdentityDigest) ?? [];
    let fired = null;
    for (const frame of frames) {
      counters.framesEvaluated += 1;
      const verdict = detector(prefixCandles(candles, frame.decisionTs), { decisionTs: frame.decisionTs });
      if (verdict?.fire) { fired = { decisionTs: frame.decisionTs, detector: verdict }; break; } // first fire wins; one bite per case
    }
    const row = { caseId: c.caseId, marketIdentityDigest: c.marketIdentityDigest, disposition, fired: Boolean(fired), firedAtTs: fired?.decisionTs ?? null, framesEvaluated: frames.length };
    if (fired) {
      counters.firedSimulations += 1;
      firedByDisposition[disposition] = (firedByDisposition[disposition] ?? 0) + 1;
      const outcome = biteOutcome(candles, fired.decisionTs, horizonMs);
      row.bite = outcome;
      if (outcome.state === 'KNOWN') { counters.completedSimulations += 1; counters.validSimulationOutcomes += 1; }
    }
    cases.push(row);
  }
  return freeze({
    simulatorVersion: DAILY_MOVE_SIMULATOR_VERSION,
    detector: { id: detector.id ?? 'CUSTOM', params: detector.params ?? null },
    horizonMs,
    manifestId: study.manifest?.manifestId ?? null,
    cases,
    counters,
    // the detector's split across the day's cohort: how firing lands on surges vs the matched controls (precision proxy)
    confusion: { casesByDisposition, firedByDisposition },
    authority: 'NONE', purpose: 'RESEARCH_ONLY',
    law: 'the detector sees ONLY the decision-clock prefix; the forward bite is scored separately and NEVER enters the decision; this record is the simulator\'s own — the daily-move study\'s counters stay zero-credit',
  });
}
