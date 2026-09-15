// DECISION YARDSTICK (Ticket 3, 2026-09-15). David's decided learning target: score every PAPER decision — a strike OR
// a refusal — on TWO horizons from the decision moment: the BITE window (5-minute log return, "did the move we were
// hunting actually happen in the 4-6 minutes we would have held it") and a CONTINUATION (15-minute log return, "did it
// keep going after we would have sold"). This replaces the wrong 60-minute yardstick for 4-6 minute bites.
//
// This module is PURE and DORMANT: it computes the two scores from a decision moment and a 1-minute candle series and
// NOTHING else. It grants no authority, reads no clock/network/disk, and never touches entry/exit/sizing. It mirrors the
// repository's candle-label discipline (learning/labels.js) EXACTLY so Serpent cannot score under one definition and
// hunt under another: anchor = ceil(decisionKnownAtTs / 60000ms) to the next 60s grid boundary; reference = the CLOSE of
// the 1m bar ending AT the anchor; a horizon of H minutes closes at anchor + H*60000 over H closed bars on the exact 60s
// grid; logReturnPct = 100 * ln(finalClose / reference); mfePct >= 0, maePct <= 0; a missing bar is CENSORED (never a
// zero return); a horizon not yet mature at the as-of is NOT_YET_KNOWN with null values; a missing/short series is
// OUTCOME_UNAVAILABLE. outcomeKnownAtTs = max(horizonEndTs, series.retrievedTsMs) — a series retrieved later makes
// nothing learnable earlier.
import { isTs, isCoin, isFiniteNum, round4, deepFreeze } from './contracts.js';
import { anchorOf } from './labels.js';

export const DECISION_YARDSTICK_VERSION = 'decision-yardstick-1';
export const BITE_WINDOW_MIN = 5;        // the bite window (David: "average maybe 4 to 6 minutes")
export const CONTINUATION_MIN = 15;      // the minutes after ("it kept going after I sold")
export const DECISION_YARDSTICK_HORIZONS_MIN = Object.freeze([BITE_WINDOW_MIN, CONTINUATION_MIN]);

const HORIZON_STATES = Object.freeze(['KNOWN', 'CENSORED', 'NOT_YET_KNOWN', 'OUTCOME_UNAVAILABLE']);

// One horizon result. logReturnPct / mfePct / maePct are null unless the state is KNOWN.
const horizon = (horizonMin, state, reason, horizonEndTs, outcomeKnownAtTs, values = {}) => ({
  horizonMin, state, reason, horizonEndTs, outcomeKnownAtTs,
  logReturnPct: values.logReturnPct ?? null, mfePct: values.mfePct ?? null, maePct: values.maePct ?? null,
});

// Score one decision against a validated 1-minute candle series (the shape learning/labels.js validateCandleSeriesRow
// returns: { retrievedTsMs, coverageEndSec, candles:[[openSec,o,h,l,c,v]...], index:Map<openSec,i>, count, firstOpenSec,
// lastOpenSec }). `asOfTs` is the knowledge clock: a horizon whose outcome is not yet known at asOfTs is NOT_YET_KNOWN.
// `series` null (no data for the asset) yields OUTCOME_UNAVAILABLE on both horizons. This never throws on data gaps;
// it throws only on a caller identity/clock contract breach, exactly like labelOpportunity.
export function scoreDecisionYardstick({ canonicalCoin, decisionKnownAtTs, series = null, asOfTs }) {
  if (!isCoin(canonicalCoin) || !isTs(decisionKnownAtTs) || !isTs(asOfTs)) throw new Error('scoreDecisionYardstick: identity / clocks malformed');
  const { anchorTsMs, anchorLagMs } = anchorOf(decisionKnownAtTs);
  const base = { yardstickVersion: DECISION_YARDSTICK_VERSION, canonicalCoin, decisionKnownAtTs, anchorTsMs, anchorLagMs };
  const unavailable = (reason) => deepFreeze({
    ...base, availability: { state: 'OUTCOME_UNAVAILABLE', reason }, reference: { state: 'OUTCOME_UNAVAILABLE', barOpenSec: null, price: null, knownAtTs: null },
    bite: horizon(BITE_WINDOW_MIN, 'OUTCOME_UNAVAILABLE', reason, anchorTsMs + BITE_WINDOW_MIN * 60_000, null),
    continuation: horizon(CONTINUATION_MIN, 'OUTCOME_UNAVAILABLE', reason, anchorTsMs + CONTINUATION_MIN * 60_000, null),
  });
  if (!series) return unavailable('SERIES_ABSENT_FOR_ASSET');
  if (!isTs(series.retrievedTsMs) || !(series.index instanceof Map) || !Array.isArray(series.candles)) return unavailable('SERIES_MALFORMED');
  const anchorSec = anchorTsMs / 1000; const refOpenSec = anchorSec - 60;
  if (series.firstOpenSec === null || refOpenSec < series.firstOpenSec || refOpenSec > series.lastOpenSec) return unavailable('NO_TEMPORAL_OVERLAP');
  const refIdx = series.index.get(refOpenSec);
  if (refIdx === undefined) return unavailable('REFERENCE_BAR_MISSING');
  const p = series.candles[refIdx][4];
  if (!isFiniteNum(p) || p <= 0) return unavailable('REFERENCE_PRICE_INVALID');
  const referenceKnownAtTs = Math.max(anchorTsMs, series.retrievedTsMs);

  const scoreHorizon = (horizonMin) => {
    const horizonEndTs = anchorTsMs + horizonMin * 60_000;
    const outcomeKnownAtTs = Math.max(horizonEndTs, series.retrievedTsMs);
    if (asOfTs < outcomeKnownAtTs) return horizon(horizonMin, 'NOT_YET_KNOWN', 'NOT_YET_KNOWN_AT_AS_OF', horizonEndTs, outcomeKnownAtTs);
    if (series.coverageEndSec < anchorSec + horizonMin * 60) return horizon(horizonMin, 'CENSORED', 'SOURCE_COVERAGE_ENDS_BEFORE_HORIZON', horizonEndTs, outcomeKnownAtTs);
    const start = series.index.get(anchorSec);
    let complete = start !== undefined && start + horizonMin - 1 < series.count;
    if (complete) for (let k = 0; k < horizonMin; k += 1) if (series.candles[start + k][0] !== anchorSec + 60 * k) { complete = false; break; }
    if (!complete) return horizon(horizonMin, 'CENSORED', 'INTERIOR_BAR_MISSING', horizonEndTs, outcomeKnownAtTs);
    let hi = -Infinity; let lo = Infinity;
    for (let k = 0; k < horizonMin; k += 1) { const c = series.candles[start + k]; if (c[2] > hi) hi = c[2]; if (c[3] < lo) lo = c[3]; }
    const finalClose = series.candles[start + horizonMin - 1][4];
    if (!isFiniteNum(finalClose) || finalClose <= 0 || !isFiniteNum(hi) || !isFiniteNum(lo)) return horizon(horizonMin, 'CENSORED', 'HORIZON_PRICE_INVALID', horizonEndTs, outcomeKnownAtTs);
    return horizon(horizonMin, 'KNOWN', 'COMPLETE', horizonEndTs, outcomeKnownAtTs, {
      logReturnPct: round4(100 * Math.log(finalClose / p)),
      mfePct: round4(Math.max(0, (hi / p - 1) * 100)),
      maePct: round4(Math.min(0, (lo / p - 1) * 100)),
    });
  };

  const bite = scoreHorizon(BITE_WINDOW_MIN);
  const continuation = scoreHorizon(CONTINUATION_MIN);
  const reference = asOfTs < referenceKnownAtTs
    ? { state: 'NOT_YET_KNOWN', barOpenSec: null, price: null, knownAtTs: referenceKnownAtTs }
    : { state: 'KNOWN', barOpenSec: refOpenSec, price: p, knownAtTs: referenceKnownAtTs };
  const states = [bite.state, continuation.state];
  const availability = states.some((s) => s === 'KNOWN' || s === 'NOT_YET_KNOWN')
    ? { state: states.every((s) => s === 'KNOWN' || s === 'NOT_YET_KNOWN') ? 'AVAILABLE' : 'PARTIAL', reason: 'COMPLETE' }
    : { state: 'PARTIAL', reason: 'INTERIOR_BAR_MISSING' };
  return deepFreeze({ ...base, availability, reference, bite, continuation });
}

// A cheap validator for a scored yardstick record (used by the recorder before it durably stores an outcome).
export function decisionYardstickError(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'record must be an object';
  if (record.yardstickVersion !== DECISION_YARDSTICK_VERSION) return 'unsupported yardstick version';
  if (!isCoin(record.canonicalCoin) || !isTs(record.decisionKnownAtTs) || !isTs(record.anchorTsMs)) return 'identity / clocks malformed';
  for (const [field, horizonMin] of [['bite', BITE_WINDOW_MIN], ['continuation', CONTINUATION_MIN]]) {
    const h = record[field];
    if (!h || typeof h !== 'object' || h.horizonMin !== horizonMin || !HORIZON_STATES.includes(h.state)) return `${field} horizon malformed`;
    if (h.state === 'KNOWN') { if (!isFiniteNum(h.logReturnPct) || !isFiniteNum(h.mfePct) || !isFiniteNum(h.maePct) || h.mfePct < 0 || h.maePct > 0) return `${field} KNOWN values malformed`; }
    else if (h.logReturnPct !== null || h.mfePct !== null || h.maePct !== null) return `${field} non-KNOWN carries values`;
  }
  return null;
}
