// DECISION YARDSTICK (Ticket 3, 2026-09-15). The pure 5-minute bite + 15-minute continuation scorer. No I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDecisionYardstick, decisionYardstickError, DECISION_YARDSTICK_VERSION, BITE_WINDOW_MIN, CONTINUATION_MIN, RESEARCH_HORIZONS_MIN, RESEARCH_HORIZON_LABEL } from '../learning/decision-yardstick.js';

// Build a validated-shape 1m series (as learning/labels.js validateCandleSeriesRow returns) from a list of closes,
// starting at openSec0. Each bar is [openSec, open, high, low, close, vol]; here high/low bracket open/close.
function series(openSec0, closes, { retrievedSec = null, coverageEndSec = null } = {}) {
  const candles = closes.map((c, i) => { const open = openSec0 + i * 60; const prev = i === 0 ? c : closes[i - 1]; const hi = Math.max(prev, c) + 1; const lo = Math.min(prev, c) - 1; return [open, prev, hi, lo, c, 10]; });
  const index = new Map(candles.map((c, i) => [c[0], i]));
  const lastOpen = openSec0 + (closes.length - 1) * 60;
  const rSec = retrievedSec ?? lastOpen + 60;
  return { symbol: 'BTC', intervalSec: 60, retrievedSec: rSec, retrievedTsMs: rSec * 1000, coverageEndSec: coverageEndSec ?? rSec, candles, index, count: candles.length, firstOpenSec: candles[0][0], lastOpenSec: lastOpen };
}

// anchor for a decision at exactly a grid boundary T is T (ceil keeps it); the reference bar OPENS at T-60 and closes at T.
// So with reference bar opening at refOpenSec, the decision sits at (refOpenSec+60)*1000.
const decisionAtAnchorSec = (anchorSec) => anchorSec * 1000;

test('DY-1. a complete series scores both horizons: 5m and 15m log returns off the bar closing at the anchor', () => {
  const refOpenSec = 1_000_000 * 60; // arbitrary grid-aligned minute
  const anchorSec = refOpenSec + 60;
  // reference close = 100 (the bar opening at refOpenSec). Then 15 forward bars from anchorSec.
  const closes = [100]; for (let i = 1; i <= 15; i += 1) closes.push(100 + i); // ref 100, then 101..115
  const s = series(refOpenSec, closes);
  const asOfTs = (anchorSec + 15 * 60) * 1000 + 60_000; // well after the 15m horizon end
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: s, asOfTs });
  assert.equal(r.yardstickVersion, DECISION_YARDSTICK_VERSION);
  assert.equal(r.reference.price, 100); assert.equal(r.reference.state, 'KNOWN');
  assert.equal(r.bite.horizonMin, BITE_WINDOW_MIN); assert.equal(r.continuation.horizonMin, CONTINUATION_MIN);
  assert.equal(r.bite.state, 'KNOWN'); assert.equal(r.continuation.state, 'KNOWN');
  // 5th forward bar close is 105; 15th is 115
  assert.equal(r.bite.logReturnPct, Number((100 * Math.log(105 / 100)).toFixed(4)));
  assert.equal(r.continuation.logReturnPct, Number((100 * Math.log(115 / 100)).toFixed(4)));
  assert.ok(r.bite.mfePct > 0 && r.bite.maePct <= 0);
  assert.equal(decisionYardstickError(r), null);
});

test('DY-2. a series retrieved just past the bite: the bite is KNOWN while the continuation is NOT_YET_KNOWN with null values', () => {
  const refOpenSec = 2_000_000 * 60; const anchorSec = refOpenSec + 60;
  // ref close 100 then only 6 forward bars; the series was retrieved at the 6th minute past the anchor
  const closes = [100, 101, 102, 103, 104, 105, 106];
  const s = series(refOpenSec, closes, { retrievedSec: anchorSec + 6 * 60 });
  const asOfTs = (anchorSec + 6 * 60) * 1000; // knowledge clock = when the 6-minute series was retrieved
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: s, asOfTs });
  assert.equal(r.bite.state, 'KNOWN'); assert.ok(r.bite.logReturnPct !== null);
  assert.equal(r.continuation.state, 'NOT_YET_KNOWN'); assert.equal(r.continuation.logReturnPct, null); assert.equal(r.continuation.mfePct, null);
  assert.equal(r.availability.state, 'AVAILABLE', 'KNOWN + NOT_YET_KNOWN is AVAILABLE (no data loss); only CENSORED/UNAVAILABLE degrade it');
});

test('DY-3. a missing interior bar CENSORS the horizon that needs it (never a fabricated zero return)', () => {
  const refOpenSec = 3_000_000 * 60; const anchorSec = refOpenSec + 60;
  const closes = [100]; for (let i = 1; i <= 15; i += 1) closes.push(100 + i);
  const s = series(refOpenSec, closes);
  // drop the 3rd forward bar (index for anchorSec + 2*60) so the 5m window is incomplete but the ref stays
  s.index.delete(anchorSec + 2 * 60);
  s.candles.splice(s.candles.findIndex((c) => c[0] === anchorSec + 2 * 60), 1);
  s.index.clear(); s.candles.forEach((c, i) => s.index.set(c[0], i)); s.count = s.candles.length;
  const asOfTs = (anchorSec + 15 * 60) * 1000 + 60_000;
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: s, asOfTs });
  assert.equal(r.bite.state, 'CENSORED'); assert.equal(r.bite.reason, 'INTERIOR_BAR_MISSING'); assert.equal(r.bite.logReturnPct, null);
  assert.equal(r.continuation.state, 'CENSORED');
});

test('DY-4. no series / no overlap / missing reference bar are OUTCOME_UNAVAILABLE', () => {
  const anchorSec = 4_000_000 * 60 + 60;
  const asOfTs = (anchorSec + 15 * 60) * 1000 + 60_000;
  const none = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: null, asOfTs });
  assert.equal(none.availability.state, 'OUTCOME_UNAVAILABLE'); assert.equal(none.bite.state, 'OUTCOME_UNAVAILABLE'); assert.equal(none.reference.price, null);
  // a series that does not reach back to the reference bar
  const far = series(anchorSec + 600, [1, 2, 3]);
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: far, asOfTs });
  assert.equal(r.availability.reason, 'NO_TEMPORAL_OVERLAP');
});

test('DY-5. coverage ending before a horizon CENSORS it; identity/clock breaches throw', () => {
  const refOpenSec = 5_000_000 * 60; const anchorSec = refOpenSec + 60;
  const closes = [100]; for (let i = 1; i <= 15; i += 1) closes.push(100 + i);
  // coverage ends after the 5m window but before the 15m window
  const s = series(refOpenSec, closes, { coverageEndSec: anchorSec + 6 * 60 });
  const asOfTs = (anchorSec + 15 * 60) * 1000 + 60_000;
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: s, asOfTs });
  assert.equal(r.bite.state, 'KNOWN'); assert.equal(r.continuation.state, 'CENSORED'); assert.equal(r.continuation.reason, 'SOURCE_COVERAGE_ENDS_BEFORE_HORIZON');
  assert.throws(() => scoreDecisionYardstick({ canonicalCoin: 'btc', decisionKnownAtTs: 1, series: null, asOfTs: 1 }), /identity \/ clocks malformed/);
});

// ---- L-2: the 1h / 4h / 24h research columns -------------------------------------------------
test('L2-1. every graded decision carries the 1h/4h/24h research columns; a horizon the series has not reached is NaN (never a fabricated zero), and it never touches the authority bite/continuation', () => {
  const refOpenSec = 6_000_000 * 60; const anchorSec = refOpenSec + 60;
  // ref 100, then only 15 forward bars: the 15m continuation matures but 1h/4h/24h do not
  const closes = [100]; for (let i = 1; i <= 15; i += 1) closes.push(100 + i);
  const s = series(refOpenSec, closes);
  const asOfTs = (anchorSec + 15 * 60) * 1000 + 60_000; // just past the 15m continuation, far before 1h
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: s, asOfTs });
  assert.equal(r.bite.state, 'KNOWN'); assert.equal(r.continuation.state, 'KNOWN', 'the authority yardstick is unaffected');
  assert.ok(r.researchHorizons && typeof r.researchHorizons === 'object', 'research columns are present');
  assert.deepEqual(Object.keys(r.researchHorizons).sort(), ['1h', '24h', '4h'], 'exactly the three research columns');
  for (const m of RESEARCH_HORIZONS_MIN) {
    const c = r.researchHorizons[RESEARCH_HORIZON_LABEL[m]];
    assert.equal(c.horizonMin, m);
    assert.equal(c.state, 'NOT_YET_KNOWN', `${RESEARCH_HORIZON_LABEL[m]} has not matured yet`);
    assert.ok(Number.isNaN(c.logReturnPct), `${RESEARCH_HORIZON_LABEL[m]} is NaN when the series has not reached it — never 0/null`);
  }
  assert.equal(decisionYardstickError(r), null, 'the record with NaN research columns validates');
  // the durable JSON shadow: NaN serializes to null; the validator still accepts it on re-read
  const roundTripped = JSON.parse(JSON.stringify(r));
  assert.equal(roundTripped.researchHorizons['1h'].logReturnPct, null, 'NaN becomes null through JSONL');
  assert.equal(decisionYardstickError(roundTripped), null, 'a re-read record (null research columns) still validates');
});

test('L2-2. once the series reaches 24h, all three research columns are KNOWN finite log returns, computed off the same reference bar as the bite', () => {
  const refOpenSec = 7_000_000 * 60; const anchorSec = refOpenSec + 60;
  const closes = [100]; for (let i = 1; i <= 1440; i += 1) closes.push(100 + i * 0.01); // ref 100, 1440 forward bars (24h)
  const s = series(refOpenSec, closes);
  const asOfTs = (anchorSec + 1440 * 60) * 1000 + 60_000; // past the 24h horizon
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: s, asOfTs });
  for (const m of RESEARCH_HORIZONS_MIN) {
    const c = r.researchHorizons[RESEARCH_HORIZON_LABEL[m]];
    assert.equal(c.state, 'KNOWN', `${RESEARCH_HORIZON_LABEL[m]} matured`);
    assert.ok(Number.isFinite(c.logReturnPct), `${RESEARCH_HORIZON_LABEL[m]} is a finite log return`);
  }
  // the 1h column is the log return of the 60th forward bar close vs the reference (100), same recipe as the bite
  assert.equal(r.researchHorizons['1h'].logReturnPct, Number((100 * Math.log((100 + 60 * 0.01) / 100)).toFixed(4)));
  assert.equal(decisionYardstickError(r), null);
});

test('L2-3. an OUTCOME_UNAVAILABLE decision still carries the three research columns, each NaN', () => {
  const anchorSec = 8_000_000 * 60 + 60;
  const asOfTs = (anchorSec + 1440 * 60) * 1000;
  const r = scoreDecisionYardstick({ canonicalCoin: 'BTC', decisionKnownAtTs: decisionAtAnchorSec(anchorSec), series: null, asOfTs });
  assert.equal(r.availability.state, 'OUTCOME_UNAVAILABLE');
  assert.deepEqual(Object.keys(r.researchHorizons).sort(), ['1h', '24h', '4h']);
  for (const m of RESEARCH_HORIZONS_MIN) assert.ok(Number.isNaN(r.researchHorizons[RESEARCH_HORIZON_LABEL[m]].logReturnPct));
  assert.equal(decisionYardstickError(r), null);
});
