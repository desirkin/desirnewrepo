// RESEARCH REFEREE — NEGATIVE CONTROLS. A candidate that performs as well under a meaningless placebo as under its own
// alignment has explained nothing. Every control here is deterministic (a named sub-seed of the bundle seed), block-
// aware (never a naive row shuffle over serially dependent labels) and reported SEPARATELY from the primary result:
//   BLOCK PERMUTATION NULL   the score side is permuted in contiguous blocks longer than the label overlap
//   TIME-SHIFT PLACEBO       the score series is rotated at least one block away from its true alignment
//   NULL FEATURE             seeded noise features scored by the same metric on the same out-of-sample rows
//   SYMBOL PLACEBO           scores permuted across symbols inside one decision instant (cross-sections only)
//   HORIZON PROFILE          the same metric at every declared horizon: an edge should have a coherent profile
import { round6, STRUCTURAL_MIN } from './contracts.js';
import { blockPermutationNull, circularShiftPlacebo, describe, exceeds, mean } from './statistics.js';
import { metricValue, positionOf } from './metrics.js';

// a statistic over a permuted / rotated SCORE vector: positions are recomputed from the sealed fit, outcomes stay fixed
function statisticFactory(scoredOos, rows, fit, name, parameters) {
  return (scores) => { const s = scoredOos.map((row, i) => { const v = scores[i]; const p = positionOf(v, fit); const y = row.outcome; return { idx: row.idx, score: v, position: p, outcome: y, gross: y === null ? null : p * y, r: y === null ? null : p * y }; }); return metricValue(name, s, rows, { parameters }); };
}
export function runNegativeControls({ scoredOos, rows, fit, name, parameters, observed, direction, controls, blockLen, rng, evaluationType, horizonMs }) {
  const statistic = statisticFactory(scoredOos, rows, fit, name, parameters); const scores = scoredOos.map((s) => s.score);
  const permutation = blockPermutationNull(scores, { blockLen, iterations: controls.permutationIterations, rng: rng.child('block-permutation'), statistic, observed, direction });
  const shift = circularShiftPlacebo(scores, { blockLen, shiftCount: controls.shiftCount, statistic, observed, direction });
  // NULL FEATURES: seeded standard-normal noise takes the place of the score; the sealed condition still applies (a
  // quantile-fitted threshold is refitted on the noise itself so the positioning rate is comparable)
  const nullRng = rng.child('null-feature'); const nullValues = [];
  for (let t = 0; t < controls.nullFeatureTrials; t += 1) {
    const noise = scores.map(() => nullRng.normal()); let f = fit;
    if (fit.fitted && fit.threshold !== null) { const sorted = noise.slice().sort((a, b) => a - b); const q = fit.quantile ?? null; f = { ...fit, threshold: q === null ? fit.threshold : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] }; }
    const v = statisticFactory(scoredOos, rows, f, name, parameters)(noise); if (Number.isFinite(v)) nullValues.push(round6(v));
  }
  const nullExceed = nullValues.length ? nullValues.filter((v) => exceeds(v, observed, direction)).length : 0;
  const nullFeature = nullValues.length ? { applicable: true, trials: nullValues.length, p: round6((1 + nullExceed) / (1 + nullValues.length)), distribution: describe(nullValues) } : { applicable: false, trials: 0, p: null, distribution: null };
  // SYMBOL PLACEBO: only where a cross-section exists (>= 2 symbols at one instant on enough instants)
  let symbolPlacebo = { applicable: false, reason: 'SYMBOL_PLACEBO_NOT_APPLICABLE', p: null, iterations: 0 };
  if (controls.symbolPlacebo) {
    const byTs = new Map(); scoredOos.forEach((s, i) => { const t = rows[s.idx].ts; if (!byTs.has(t)) byTs.set(t, []); byTs.get(t).push(i); });
    const sections = [...byTs.values()].filter((g) => g.length >= 2);
    if (sections.length >= STRUCTURAL_MIN.blocksForNull && controls.permutationIterations > 0) {
      const srng = rng.child('symbol-placebo'); const dist = []; let ge = 0;
      for (let it = 0; it < controls.permutationIterations; it += 1) { const perm = scores.slice(); for (const g of sections) { const vals = srng.shuffle(g.map((i) => scores[i])); g.forEach((i, j) => { perm[i] = vals[j]; }); } const v = statistic(perm); if (Number.isFinite(v)) { dist.push(v); if (exceeds(v, observed, direction)) ge += 1; } }
      symbolPlacebo = dist.length ? { applicable: true, reason: null, p: round6((1 + ge) / (1 + dist.length)), iterations: dist.length, crossSections: sections.length, distribution: describe(dist) } : symbolPlacebo;
    }
  }
  // HORIZON PROFILE: the same metric with the outcome swapped for each declared horizon value (coherence = the
  // declared-direction sign holds on the primary horizon's neighbours, not only on one isolated bucket)
  let horizonProfile = { applicable: false, reason: 'HORIZON_PROFILE_NOT_AVAILABLE', horizons: [], coherent: null };
  if (controls.horizonProfile && evaluationType !== 'LEAD_TIME') {
    const keys = new Set(); for (const s of scoredOos) for (const k of Object.keys(rows[s.idx].horizonValues ?? {})) keys.add(k);
    const hs = [...keys].map(Number).sort((a, b) => a - b);
    if (hs.length >= 2) {
      const values = hs.map((h) => { const swapped = scoredOos.map((s) => { const y = rows[s.idx].horizonValues?.[String(h)] ?? null; return { ...s, outcome: y, gross: y === null ? null : s.position * y, r: y === null ? null : s.position * y }; }); const v = metricValue(name, swapped, rows, { parameters }); return { horizonMs: h, value: v === null ? null : round6(v), primary: h === horizonMs }; });
      const signed = values.filter((v) => v.value !== null).map((v) => (direction === 'NEGATIVE' ? -v.value : direction === 'POSITIVE' ? v.value : Math.abs(v.value)));
      const i = values.findIndex((v) => v.primary); const neighbours = [values[i - 1], values[i + 1]].filter((v) => v && v.value !== null);
      const coherent = i < 0 ? null : neighbours.length === 0 ? null : neighbours.every((v) => (direction === 'NEGATIVE' ? -v.value : direction === 'POSITIVE' ? v.value : Math.abs(v.value)) > 0);
      horizonProfile = { applicable: true, reason: null, horizons: values, coherent, meanSignedEffect: signed.length ? round6(mean(signed)) : null };
    }
  }
  return { blockLen, permutation, timeShift: shift, nullFeature, symbolPlacebo, horizonProfile };
}
