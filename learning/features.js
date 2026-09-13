// LEARN-1 — decision-time features over PAST-ONLY closed 1m bars (learning-features-1), and the frozen engineering
// baseline rule (learning-baseline-rule-1) used by replay and shadow capture.
//
// Pure, no I/O, no clock. Every function receives a candle window that must already END at or before the decision
// time; buildFeatures additionally re-checks the wall and refuses a bar closing after T rather than filtering it —
// a future bar in the input is a caller bug, not data. Missing inputs stay missing (availability, not zeros).
// The small interpretable family is fixed by version; adding a feature is a new recipe version, never a silent edit.
//
// The baseline rule is an ENGINEERING baseline for counterfactual research: it is NOT the live Judge (which needs
// book/flow evidence that history does not carry), claims no calibration, and is documented as such everywhere its
// version string appears.
import { FEATURE_RECIPE_VERSION, BASELINE_RULE_VERSION, isFiniteNum, round4, deepFreeze } from './contracts.js';

export const FEATURE_NAMES = Object.freeze([
  'ret1mPct', 'ret5mPct', 'ret15mPct', 'ret60mPct', 'accel5mPct', 'relVolume60m', 'volumePersistence',
  'range5mPct', 'compression5m', 'breakout20mPct', 'rsi14', 'relStrength60mPct',
]);
export const WARMUP_BARS = 61 + 14; // 61 closed bars for the 60m family + RSI-14 warm-up
const known = (value, unit, lookbackMs) => ({ value, unit, lookbackMs, availability: 'KNOWN' });
const missing = (unit, lookbackMs, availability = 'UNAVAILABLE') => ({ value: null, unit, lookbackMs, availability });

// bars: [[openSec, o, h, l, c, v], ...] strictly ascending 60s grid, every bar CLOSED at or before decisionTsMs.
// peerCloses: optional map coin -> {closeAtT, closeAt60mAgo} for relative strength (median of peers), or null.
export function buildFeatures({ bars, decisionTsMs, peerMedianRet60mPct = null }) {
  if (!Array.isArray(bars)) throw new Error('buildFeatures: bars malformed');
  const decisionSec = Math.floor(decisionTsMs / 1000);
  for (const b of bars) if (b[0] + 60 > decisionSec) throw new Error('buildFeatures: a bar closes after the decision clock (wall violation)');
  const n = bars.length;
  const f = {};
  const closeAt = (k) => bars[n - 1 - k][4]; // k bars back from the last closed bar
  const retPct = (k) => round4((closeAt(0) / closeAt(k) - 1) * 100);
  const contiguous = (k) => n > k && bars[n - 1][0] - bars[n - 1 - k][0] === k * 60;
  f.ret1mPct = contiguous(1) ? known(retPct(1), 'simple_percent', 60_000) : missing('simple_percent', 60_000, n > 1 ? 'UNAVAILABLE' : 'WARMUP');
  f.ret5mPct = contiguous(5) ? known(retPct(5), 'simple_percent', 300_000) : missing('simple_percent', 300_000, 'WARMUP');
  f.ret15mPct = contiguous(15) ? known(retPct(15), 'simple_percent', 900_000) : missing('simple_percent', 900_000, 'WARMUP');
  f.ret60mPct = contiguous(60) ? known(retPct(60), 'simple_percent', 3_600_000) : missing('simple_percent', 3_600_000, 'WARMUP');
  f.accel5mPct = contiguous(10) ? known(round4(retPct(5) - ((closeAt(5) / closeAt(10) - 1) * 100)), 'simple_percent', 600_000) : missing('simple_percent', 600_000, 'WARMUP');
  if (contiguous(60)) {
    const recent = bars.slice(n - 5).reduce((a, b) => a + b[5], 0) / 5;
    const trailing = bars.slice(n - 60, n - 5).reduce((a, b) => a + b[5], 0) / 55;
    f.relVolume60m = trailing > 0 ? known(round4(recent / trailing), 'ratio', 3_600_000) : missing('ratio', 3_600_000);
    let persist = 0; for (let k = 0; k < 5; k += 1) if (bars[n - 1 - k][5] > trailing) persist += 1;
    f.volumePersistence = trailing > 0 ? known(persist, 'bars_above_trailing_mean_of_5', 3_600_000) : missing('bars_above_trailing_mean_of_5', 3_600_000);
  } else { f.relVolume60m = missing('ratio', 3_600_000, 'WARMUP'); f.volumePersistence = missing('bars_above_trailing_mean_of_5', 3_600_000, 'WARMUP'); }
  if (contiguous(5)) {
    const w = bars.slice(n - 5); const hi = Math.max(...w.map((b) => b[2])); const lo = Math.min(...w.map((b) => b[3]));
    f.range5mPct = known(round4((hi / lo - 1) * 100), 'simple_percent', 300_000);
    if (contiguous(20)) {
      const w20 = bars.slice(n - 20); const r20 = Math.max(...w20.map((b) => b[2])) / Math.min(...w20.map((b) => b[3])) - 1;
      f.compression5m = r20 > 0 ? known(round4((hi / lo - 1) / r20), 'ratio_5m_to_20m_range', 1_200_000) : missing('ratio_5m_to_20m_range', 1_200_000);
    } else f.compression5m = missing('ratio_5m_to_20m_range', 1_200_000, 'WARMUP');
  } else { f.range5mPct = missing('simple_percent', 300_000, 'WARMUP'); f.compression5m = missing('ratio_5m_to_20m_range', 1_200_000, 'WARMUP'); }
  if (contiguous(21)) {
    // distance from the PAST-ONLY prior 20-bar high (excluding the current bar) — positive = above it
    const prior = bars.slice(n - 21, n - 1); const h20 = Math.max(...prior.map((b) => b[2]));
    f.breakout20mPct = known(round4((closeAt(0) / h20 - 1) * 100), 'simple_percent', 1_260_000);
  } else f.breakout20mPct = missing('simple_percent', 1_260_000, 'WARMUP');
  // RSI-14, Wilder smoothing, exact formula: warm-up = 14 closed deltas seeded by simple average, then recursive.
  if (contiguous(15)) {
    const closes = bars.slice(n - 15).map((b) => b[4]);
    let gain = 0; let loss = 0;
    for (let i = 1; i < closes.length; i += 1) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
    const avgGain = gain / 14; const avgLoss = loss / 14;
    f.rsi14 = avgLoss === 0 ? known(100, 'rsi_0_100', 900_000) : known(round4(100 - 100 / (1 + avgGain / avgLoss)), 'rsi_0_100', 900_000);
  } else f.rsi14 = missing('rsi_0_100', 900_000, 'WARMUP');
  f.relStrength60mPct = f.ret60mPct.availability === 'KNOWN' && isFiniteNum(peerMedianRet60mPct)
    ? known(round4(f.ret60mPct.value - peerMedianRet60mPct), 'simple_percent_vs_peer_median', 3_600_000)
    : missing('simple_percent_vs_peer_median', 3_600_000, f.ret60mPct.availability === 'KNOWN' ? 'UNAVAILABLE' : 'WARMUP');
  return deepFreeze({ featureRecipeVersion: FEATURE_RECIPE_VERSION, features: f });
}

// The frozen engineering baseline decision rule over the features above. Returns the decision plus every gate,
// with observed value and threshold — a soft rejection names exactly what refused it.
export const BASELINE_RULE = deepFreeze({
  version: BASELINE_RULE_VERSION,
  law: 'ENGINEERING_BASELINE_FOR_REPLAY_NOT_THE_LIVE_JUDGE',
  gates: [
    { id: 'BREAKOUT_ABOVE_PRIOR_20M_HIGH', feature: 'breakout20mPct', op: 'GT', threshold: 0, class: 'SOFT' },
    { id: 'RELATIVE_VOLUME_3X', feature: 'relVolume60m', op: 'GTE', threshold: 3, class: 'SOFT' },
    { id: 'NOT_ALREADY_EXTENDED_15M', feature: 'ret15mPct', op: 'LTE', threshold: 3, class: 'SOFT' },
  ],
});
export function baselineDecision(featureSet) {
  const gates = [];
  for (const g of BASELINE_RULE.gates) {
    const f = featureSet.features[g.feature];
    if (!f || f.availability !== 'KNOWN') { gates.push({ id: g.id, ok: false, observed: null, threshold: g.threshold, class: 'MISSING_DATA' }); continue; }
    const ok = g.op === 'GT' ? f.value > g.threshold : g.op === 'GTE' ? f.value >= g.threshold : f.value <= g.threshold;
    gates.push({ id: g.id, ok, observed: f.value, threshold: g.threshold, class: g.class });
  }
  const refused = gates.filter((g) => !g.ok);
  const firstRefusal = refused.find((g) => g.class !== 'MISSING_DATA') ?? null;
  // all gates pass -> selected for shadow; a real refusal on KNOWN data -> SKIPPED (soft, named); refusals that are
  // only missing data -> UNEVALUABLE (a coverage fact, never a rejection verdict)
  const decision = refused.length === 0 ? 'SELECTED_FOR_SHADOW' : firstRefusal ? 'SKIPPED' : 'UNEVALUABLE';
  return deepFreeze({
    baselineRuleVersion: BASELINE_RULE_VERSION, decision, gates,
    rejection: decision === 'SKIPPED' ? { reasonCode: firstRefusal.id, observedValue: firstRefusal.observed, threshold: firstRefusal.threshold, class: 'SOFT' } : null,
  });
}

// A predicate over a frozen feature snapshot — the ONLY predicate language pattern candidates may use. Clauses
// reference features by name in the CONSUMER's prepared fact vocabulary (the learning recipe's names in learning,
// the Judge's prepared-fact names at its consumer seam); a name absent from the supplied set, or an unavailable
// feature, makes the predicate UNKNOWN (never true, never false — no extrapolated confidence).
export function evaluatePredicate(predicate, featureSet) {
  if (!predicate || !Array.isArray(predicate.clauses) || predicate.clauses.length === 0) return 'UNKNOWN';
  for (const c of predicate.clauses) {
    if (typeof c.feature !== 'string') return 'UNKNOWN';
    const f = featureSet.features[c.feature];
    if (!f || f.availability !== 'KNOWN') return 'UNKNOWN';
    const ok = c.op === 'GT' ? f.value > c.threshold : c.op === 'GTE' ? f.value >= c.threshold : c.op === 'LT' ? f.value < c.threshold : c.op === 'LTE' ? f.value <= c.threshold : null;
    if (ok === null) return 'UNKNOWN';
    if (!ok) return 'FALSE';
  }
  return 'TRUE';
}
