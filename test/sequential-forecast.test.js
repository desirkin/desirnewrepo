import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDigest } from '../learning/contracts.js';
import { brierLoss, normalMixtureBoundary, forecastConfidenceSequence, replayForecastComparison, trialAlpha } from '../learning/sequential-forecast.js';

test('published two-sided normal-mixture formula parity and score bounds', () => {
  for (const variance of [0, 1, 10, 100, 10000]) for (const alpha of [0.05, 0.01]) for (const rho of [1, 10]) {
    const expected = Math.sqrt((variance + rho) * Math.log((variance + rho) / (alpha * alpha * rho)));
    assert.ok(Math.abs(normalMixtureBoundary({ variance, alpha, rho }) - expected) < 1e-10);
  }
  assert.equal(brierLoss(0.75, 1), 0.0625);
  for (const bad of [-1, 1.01, NaN, Infinity, '0.5']) assert.throws(() => brierLoss(bad, 1));
  assert.throws(() => brierLoss(0.5, null));
  assert.equal(forecastConfidenceSequence({ count: 0, sum: 0, alpha: .05, rho: 1 }).mean, null);
});

function row(i, candidatePrediction = .9, referencePrediction = .5, label = 1) {
  const original = { opportunityId: `ep-${i}`, capturedTs: 1000 + i * 100, horizonEndTs: 1050 + i * 100, referencePrediction, candidatePrediction };
  return { ...original, outcomeKnownAtTs: original.horizonEndTs + 10, label, predictionDigest: canonicalDigest(original) };
}

test('saved predictions, duplicated episodes, late and overlapping outcomes cannot be relabelled into support', () => {
  const settings = { alpha: .025, rho: 10, minimumImprovement: .01 };
  const records = Array.from({ length: 1000 }, (_, i) => row(i));
  const result = replayForecastComparison({ records, ...settings });
  assert.equal(result.predictiveSupport, true);
  assert.equal(result.policyQualified, false);
  assert.equal(result.authority, 'NONE');
  assert.throws(() => replayForecastComparison({ records: [row(0), row(0)], ...settings }), /DUPLICATE/);
  assert.throws(() => replayForecastComparison({ records: [{ ...row(0), candidatePrediction: 1 }], ...settings }), /PREDICTION_MISMATCH/);
  assert.throws(() => replayForecastComparison({ records: [{ ...row(0), outcomeKnownAtTs: 1200 }, row(1)], ...settings }), /ORDER_OR_DELAY/);
  assert.throws(() => replayForecastComparison({ records: [{ ...row(0), label: null }], ...settings }));
  assert.throws(() => replayForecastComparison({ records: [{ ...row(0), capturedTs: 1100 }], ...settings }), /ORDER_OR_DELAY/);
});

test('per-trial allocations are summable; a new ordinal cannot reset the family budget', () => {
  let total = 0;
  for (let i = 1; i <= 10000; i++) total += trialAlpha({ familyAlpha: .05, trialOrdinal: i });
  assert.ok(total < .05 && total > .04999);
  assert.throws(() => trialAlpha({ familyAlpha: .05, trialOrdinal: 0 }));
});

test('declared no-improvement experiment: repeated monitoring, independent runs and uncertainty', (t) => {
  // Frozen engineering test design: 400 independent PRNG streams x 2000
  // bounded null observations; check EACH prefix. This is a falsification
  // diagnostic, not a proof or substitute for the published theorem.
  const runs = 400; const steps = 2000; const alpha = .05; const rho = 10;
  let crossings = 0;
  for (let run = 1; run <= runs; run++) {
    let seed = (0x9e3779b9 ^ run * 2654435761) >>> 0; let sum = 0; let crossed = false;
    for (let n = 1; n <= steps; n++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      sum += (seed / 2 ** 32) < .5 ? -1 : 1;
      const ci = forecastConfidenceSequence({ count: n, sum, alpha, rho });
      if (ci.lower > 0 || ci.upper < 0) crossed = true;
    }
    if (crossed) crossings++;
  }
  // Wilson interval describes Monte Carlo uncertainty; it is NOT used as a
  // sequential qualification confidence sequence.
  const p = crossings / runs; const z = 1.959963984540054; const d = 1 + z*z/runs;
  const center = (p + z*z/(2*runs))/d;
  const width = z*Math.sqrt(p*(1-p)/runs + z*z/(4*runs*runs))/d;
  t.diagnostic(JSON.stringify({ design: 'NULL_SYMMETRIC_BOUNDED_FIXED_V1', runs, steps, alpha, rho, crossings, rate: p, monteCarloWilson95: [Math.max(0, center-width), Math.min(1, center+width)] }));
  assert.ok(p <= .09, `null crossing diagnostic unexpectedly high: ${p}`);
});
