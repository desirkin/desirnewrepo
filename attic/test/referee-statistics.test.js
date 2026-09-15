// RESEARCH REFEREE — C. splits, D. PSR / DSR against independent reference calculations, E. PBO, F. block null /
// placebo. The reference values are computed here with methods independent of the implementation (numerical
// integration of the normal density, bisection on that integral, the published formulas written out longhand).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalCdf, normalInv, probabilisticSharpe, expectedMaxSharpe, deflatedSharpe, effectiveTrialCount, expectedMaxUnitSharpe, skewness, kurtosis, sharpe, ranks, spearman, auroc, prAuc, averageUniqueness, blockPermutationNull, circularShiftPlacebo, blockBootstrap, describe, EULER_GAMMA } from '../research/referee/statistics.js';
import { contiguousGroups, buildDesign, buildCscv, purgeAndEmbargo, blockLengthRows } from '../research/referee/splits.js';
import { createRng, binomial, combinations, LIMITS } from '../research/referee/contracts.js';
import { refereeEvaluate } from '../research/referee/evaluate.js';
import { realEffectData, noiseData, bundleFor, feature, condition, synth, mix, MIN, HOUR } from './helpers/referee.js';

// an independent Phi: Simpson integration of the standard normal density from -12 to x
function phiRef(x) { const a = -12; const n = 20000; const h = (x - a) / n; let s = 0; for (let i = 0; i <= n; i += 1) { const t = a + i * h; const f = Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI); s += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * f; } return (s * h) / 3; }
function phiInvRef(p) { let lo = -8; let hi = 8; for (let i = 0; i < 80; i += 1) { const mid = (lo + hi) / 2; if (phiRef(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; }
const rowsOf = (n, { spacing = 5 * MIN, horizon = HOUR, symbols = 1 } = {}) => { const rows = []; for (let t = 0; t < n; t += 1) for (let s = 0; s < symbols; s += 1) rows.push({ idx: rows.length, ts: 1_000_000 + t * spacing, symbol: `S${s}`, labelStartTs: 1_000_000 + t * spacing, labelEndTs: 1_000_000 + t * spacing + horizon, state: 'KNOWN', outcome: 0 }); return rows; };

test('C1. purged k-fold: no training row\'s label interval overlaps its test span, the embargo removes exactly the rows inside the declared window after each test span, group boundaries never split one instant, and the design is deterministic', () => {
  const rows = rowsOf(120, { symbols: 2 }); const split = { method: 'PURGED_KFOLD', groups: 6, testGroups: 1, embargoMs: 3 * 5 * MIN, purge: true, minTestObservations: 4, cscvGroups: 4 };
  const d = buildDesign(rows, split); assert.equal(d.ok, true); assert.equal(d.folds.length, 6); assert.equal(d.validFolds, 6); assert.equal(d.pathCount, 1); assert.equal(d.validPaths, 1);
  for (const f of d.folds) { const span = f.spans[0]; for (const i of f.train) { const r = rows[i]; assert.ok(!(r.ts <= span.endTs && r.labelEndTs >= span.startTs), `fold ${f.fold}: train row ${i} overlaps the test span`); assert.ok(!(r.ts > span.endTs && r.ts <= span.endTs + split.embargoMs), 'embargoed rows are not in train'); } }
  const middle = d.folds[2]; assert.equal(middle.purged, 2 * 12 * 2, 'twelve overlapping instants on each side, two symbols'); assert.equal(middle.embargoed, 3 * 2, 'three instants after the span, two symbols');
  assert.equal(d.folds[5].embargoed, 0, 'nothing after the last fold'); assert.equal(d.folds[0].purged, 24, 'only the trailing side before the first fold');
  const g = contiguousGroups(rows, 6); for (let i = 1; i < rows.length; i += 1) if (rows[i].ts === rows[i - 1].ts) assert.equal(g.groupOf[i], g.groupOf[i - 1], 'one instant, one group');
  assert.equal(JSON.stringify(buildDesign(rows, split)), JSON.stringify(d), 'deterministic');
  const noPurge = buildDesign(rows, { ...split, purge: false, embargoMs: 0 }); assert.equal(noPurge.purgedTotal, 0); assert.equal(noPurge.embargoedTotal, 0);
  const pe = purgeAndEmbargo(rows, [10, 11], [{ lo: rows[10].ts, hi: rows[11].labelEndTs }], { purge: true, embargoMs: 0 }); assert.ok(!pe.train.includes(10) && !pe.train.includes(11)); assert.ok(pe.purged > 0);
});

test('C2. CPCV: C(N, k) combinations, C(N-1, k-1) reconstructed paths each covering every row exactly once, purge / embargo per test group, a deterministic resource bound (CPCV_NOT_PRACTICAL) instead of a silently reduced design, and skipped folds reported with their reason', () => {
  const rows = rowsOf(120, { horizon: 15 * MIN }); const d = buildDesign(rows, { method: 'CPCV', groups: 6, testGroups: 2, embargoMs: 15 * MIN, purge: true, minTestObservations: 4, cscvGroups: 4 });
  assert.equal(d.ok, true); assert.equal(d.combinations, binomial(6, 2)); assert.equal(d.folds.length, 15); assert.equal(d.pathCount, binomial(5, 1)); assert.equal(d.validPaths, 5);
  for (const p of d.paths) { assert.equal(p.rows.length, rows.length); assert.deepEqual(p.rows.map((r) => r.idx), rows.map((r) => r.idx)); }
  for (const f of d.folds) for (const span of f.spans) for (const i of f.train) assert.ok(!(rows[i].ts <= span.endTs && rows[i].labelEndTs >= span.startTs));
  const big = buildDesign(rows, { method: 'CPCV', groups: 40, testGroups: 20, embargoMs: 0, purge: true, minTestObservations: 4, cscvGroups: 4 }); assert.equal(big.ok, false); assert.equal(big.reason, 'CPCV_NOT_PRACTICAL'); assert.ok(big.combinations > LIMITS.maxCpcvCombinations);
  const tiny = buildDesign(rowsOf(12), { method: 'CPCV', groups: 4, testGroups: 2, embargoMs: 0, purge: true, minTestObservations: 4, cscvGroups: 4 }); assert.ok(tiny.skippedFolds > 0); assert.ok(tiny.folds.some((f) => f.skipped === 'TOO_FEW_TEST_OBSERVATIONS' || f.skipped === 'TOO_FEW_OBSERVATIONS'));
  assert.deepEqual(combinations(4, 2), [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]); assert.equal(binomial(52, 5), 2598960);
});

test('C3. the CSCV substrate: S even groups, C(S, S/2) symmetric in-sample / out-of-sample halves, the in-sample half purged at the seam; the block length rule exceeds the maximum label overlap in rows', () => {
  const rows = rowsOf(120, { horizon: 15 * MIN }); const c = buildCscv(rows, { cscvGroups: 6, embargoMs: 0, purge: true, minTestObservations: 4 });
  assert.equal(c.ok, true); assert.equal(c.combinations, 20); assert.equal(c.validSets, 20);
  for (const s of c.sets) { assert.equal(s.inSampleGroups.length, 3); assert.equal(s.outOfSampleGroups.length, 3); const oos = new Set(s.outOfSample); for (const i of s.inSample) assert.ok(!oos.has(i)); assert.ok(s.purged > 0, 'seams are purged'); }
  const bl = blockLengthRows(rows, { blockLengthRule: 'MAX_OVERLAP_PLUS_ONE', blockLengthRows: null }); assert.equal(bl.blockLen, 4); assert.equal(bl.maxOverlapRows, 3); const bl2 = blockLengthRows(rowsOf(50), { blockLengthRule: 'MAX_OVERLAP_PLUS_ONE', blockLengthRows: null }); assert.equal(bl2.blockLen, 13); assert.equal(bl2.maxOverlapRows, 12);
  assert.deepEqual(blockLengthRows(rows, { blockLengthRule: 'DECLARED', blockLengthRows: 7 }), { blockLen: 7, rule: 'DECLARED' });
  const over = buildCscv(rows, { cscvGroups: 40, embargoMs: 0, purge: true, minTestObservations: 4 }); assert.equal(over.ok, false); assert.equal(over.reason, 'RESOURCE_LIMIT_EXCEEDED');
});

test('D1. the normal distribution and its inverse agree with numerical integration; PSR reproduces the published formula on a normal-ish fixture and on a skewed / kurtotic one; positive skew helps and fat tails hurt a positive Sharpe', () => {
  for (const x of [-3, -1.5, -0.3, 0, 0.5, 1, 1.96, 2.5, 4]) assert.ok(Math.abs(normalCdf(x) - phiRef(x)) < 1e-9, `Phi(${x})`);
  for (const p of [0.001, 0.05, 0.5, 0.8413, 0.975, 0.999]) assert.ok(Math.abs(normalInv(p) - phiInvRef(p)) < 1e-9, `Phi^-1(${p})`);
  assert.ok(Math.abs(normalInv(0.975) - 1.959963985) < 1e-8);
  // normal-ish: skew 0, kurtosis 3 -> PSR = Phi(SR sqrt(n-1) / sqrt(1 + SR^2 / 2))
  const sr = 0.15; const n = 120; const ref = phiRef((sr * Math.sqrt(n - 1)) / Math.sqrt(1 - 0 * sr + ((3 - 1) / 4) * sr * sr));
  const psr = probabilisticSharpe({ sharpe: sr, benchmark: 0, n, skewness: 0, kurtosis: 3 }); assert.equal(psr.applicable, true); assert.ok(Math.abs(psr.psr - ref) < 1e-6, `${psr.psr} vs ${ref}`);
  // skewed / kurtotic: the longhand formula with g3 = -0.8, g4 = 6
  const g3 = -0.8; const g4 = 6; const ref2 = phiRef((sr * Math.sqrt(n - 1)) / Math.sqrt(1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  const psr2 = probabilisticSharpe({ sharpe: sr, benchmark: 0, n, skewness: g3, kurtosis: g4 }); assert.ok(Math.abs(psr2.psr - ref2) < 1e-6); assert.ok(psr2.psr < psr.psr, 'negative skew and fat tails lower the PSR');
  const psr3 = probabilisticSharpe({ sharpe: sr, benchmark: 0, n, skewness: 0.8, kurtosis: 3 }); assert.ok(psr3.psr > psr.psr, 'positive skew raises it');
  assert.ok(probabilisticSharpe({ sharpe: sr, benchmark: 0.1, n, skewness: 0, kurtosis: 3 }).psr < psr.psr, 'a higher benchmark lowers it');
  assert.equal(probabilisticSharpe({ sharpe: sr, benchmark: 0, n: 3, skewness: 0, kurtosis: 3 }).applicable, false, 'below the structural minimum');
  // moments on a known sample
  const xs = [1, 2, 3, 4, 10]; assert.ok(skewness(xs) > 0); assert.ok(kurtosis(xs) > 0); assert.ok(Math.abs(sharpe([1, 1, 1, 1, 3]) - (1.4 / Math.sqrt(0.8))) < 1e-9);
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]); assert.equal(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1); assert.equal(auroc([0.2, 0.8, 0.5, 0.9], [0, 1, 0, 1]), 1); assert.ok(prAuc([0.2, 0.8, 0.5, 0.9], [0, 1, 0, 1]) === 1);
});

test('D2. DSR: one trial deflates nothing (DSR = PSR); the expected maximum matches the published formula longhand; more independent trials monotonically lower the DSR; correlated trials count as fewer but never fewer than one nor more than the raw count; an unknown trial variance with more than one trial is NOT applicable rather than favourable', () => {
  const sr = 0.2; const n = 200; const V = 0.01;
  const one = deflatedSharpe({ sharpe: sr, n, skewness: 0, kurtosis: 3, effectiveTrials: 1, trialVariance: V }); assert.equal(one.applicable, true); assert.equal(one.benchmarkSharpe, 0); assert.equal(one.dsr, probabilisticSharpe({ sharpe: sr, benchmark: 0, n, skewness: 0, kurtosis: 3 }).psr);
  for (const N of [2, 5, 10, 50, 500]) { const ref = Math.sqrt(V) * ((1 - EULER_GAMMA) * phiInvRef(1 - 1 / N) + EULER_GAMMA * phiInvRef(1 - 1 / (N * Math.E))); assert.ok(Math.abs(expectedMaxSharpe({ trials: N, trialVariance: V }) - ref) < 1e-7, `E[max] N=${N}`); }
  let prev = 1; for (const N of [1, 2, 4, 8, 16, 32, 64]) { const d = deflatedSharpe({ sharpe: sr, n, skewness: 0, kurtosis: 3, effectiveTrials: N, trialVariance: V }); assert.ok(d.dsr <= prev, `DSR non-increasing at N=${N}`); prev = d.dsr; }
  assert.ok(deflatedSharpe({ sharpe: sr, n, skewness: 0, kurtosis: 3, effectiveTrials: 64, trialVariance: V }).dsr < one.dsr - 0.05, 'a real burden is a real penalty');
  const unknown = deflatedSharpe({ sharpe: sr, n, skewness: 0, kurtosis: 3, effectiveTrials: 5, trialVariance: null }); assert.equal(unknown.applicable, false); assert.equal(unknown.reason, 'TRIAL_VARIANCE_UNAVAILABLE');
  // effective trials
  const rng = createRng('eff'); const base = Array.from({ length: 300 }, () => rng.normal());
  const indep = Array.from({ length: 10 }, () => Array.from({ length: 300 }, () => rng.normal()));
  const e1 = effectiveTrialCount({ rawTrialCount: 10, insideSeries: indep }); assert.ok(e1.effectiveTrialCount > 8 && e1.effectiveTrialCount <= 10, `independent series stay close to raw: ${e1.effectiveTrialCount}`);
  const corr = Array.from({ length: 10 }, () => base.map((x) => 0.9 * x + 0.1 * rng.normal()));
  const e2 = effectiveTrialCount({ rawTrialCount: 10, insideSeries: corr }); assert.ok(e2.effectiveTrialCount < e1.effectiveTrialCount && e2.effectiveTrialCount >= 1, `correlated trials count as fewer: ${e2.effectiveTrialCount}`);
  const same = Array.from({ length: 10 }, () => base.slice()); const e3 = effectiveTrialCount({ rawTrialCount: 10, insideSeries: same }); assert.ok(e3.effectiveTrialCount >= 1 && e3.effectiveTrialCount < 1.05, 'identical trials are one trial');
  const e4 = effectiveTrialCount({ rawTrialCount: 40, insideSeries: same }); assert.ok(Math.abs(e4.effectiveTrialCount - 31) < 0.05, 'thirty outside trials count raw on top');
  assert.equal(effectiveTrialCount({ rawTrialCount: 0, insideSeries: [] }).effectiveTrialCount, 1);
  assert.ok(Math.abs(expectedMaxUnitSharpe(10) - 1.5745983) < 1e-6);
});

test('E1. PBO: a stable synthetic signal among noise candidates has a low PBO while a pure-noise candidate search shows high overfitting across seeds; one candidate is NOT_APPLICABLE; the in-sample half alone selects (structurally)', () => {
  const stable = synth({ seed: 'pbo-stable', steps: 300, features: (rng, y) => ({ REAL: mix(rng, y, 0.45), N1: rng.normal(), N2: rng.normal(), N3: rng.normal(), N4: rng.normal() }) });
  const feats = ['REAL', 'N1', 'N2', 'N3', 'N4']; const cands = feats.map((f) => ({ candidateId: f, params: { f }, signal: { feature: f, condition: condition('GT', 0) } }));
  const rs = refereeEvaluate(bundleFor({ data: stable, manifestOver: { features: feats.map((f) => feature(f)), signal: { feature: 'REAL', condition: condition('GT', 0) }, candidates: cands, primaryCandidateId: 'REAL' } }).bundle);
  assert.equal(rs.overfitting.pbo.applicable, true); assert.ok(rs.overfitting.pbo.pbo <= 0.25, `stable signal PBO ${rs.overfitting.pbo.pbo}`); assert.deepEqual(rs.overfitting.pbo.selectedCandidates, ['REAL']);
  let sum = 0; const seeds = ['n1', 'n2', 'n3'];
  for (const s of seeds) { const nd = noiseData(20, `pbo-${s}`); const fs = Array.from({ length: 20 }, (_, i) => `F${i + 1}`); const cs = fs.map((f) => ({ candidateId: f, params: { f }, signal: { feature: f, condition: condition('GT', 0) } })); const r = refereeEvaluate(bundleFor({ data: nd, manifestOver: { features: fs.map((f) => feature(f)), signal: { feature: 'F1', condition: condition('GT', 0) }, candidates: cs, primaryCandidateId: 'F1' } }).bundle); assert.equal(r.overfitting.pbo.applicable, true); sum += r.overfitting.pbo.pbo; assert.ok(r.overfitting.pbo.lambda.n >= 10); }
  assert.ok(sum / seeds.length >= 0.35, `pure-noise selection overfits: mean PBO ${sum / seeds.length}`);
  const single = refereeEvaluate(bundleFor({ data: realEffectData('pbo-single') }).bundle); assert.equal(single.overfitting.pbo.applicable, false); assert.equal(single.overfitting.pbo.reason, 'SINGLE_CANDIDATE');
  const src = readFileSync('research/referee/evaluate.js', 'utf8'); const sel = src.indexOf('IS ONLY decides the selection'); const oosAt = src.indexOf('const oosVals'); assert.ok(sel > 0 && oosAt > sel, 'the selection is computed from in-sample values before any out-of-sample value exists');
  assert.ok(/let best = 0; for \(let i = 1; i < isVals\.length; i \+= 1\) if \(isVals\[i\] > isVals\[best\]\) best = i;/.test(src));
});

test('F1. block nulls: the time shift destroys a timing-specific synthetic signal; the block permutation rejects it; naive row shuffling is not offered; the bootstrap interval contains the point estimate; the blocks and seed are recorded', () => {
  const r = refereeEvaluate(bundleFor({ data: realEffectData('null-1') }).bundle); const c = r.overfitting.negativeControls;
  assert.equal(c.blockLengthRule, 'MAX_OVERLAP_PLUS_ONE'); assert.ok(c.blockLen > 12); assert.equal(c.permutation.method, 'BLOCK_PERMUTATION'); assert.equal(c.timeShift.method, 'CIRCULAR_TIME_SHIFT'); assert.ok(typeof c.seed === 'string');
  assert.ok(c.permutation.p <= 0.05, `permutation p ${c.permutation.p}`); assert.ok(c.timeShift.p <= 0.05, `shift p ${c.timeShift.p}`); assert.ok(c.timeShift.placeboDistribution.mean < r.primaryResult.value, 'the placebo weakens the effect');
  assert.ok(c.timeShift.shifts.every((s) => s >= c.blockLen)); assert.ok(c.nullFeature.p <= 0.05);
  assert.ok(r.primaryResult.uncertainty.lower <= r.primaryResult.value && r.primaryResult.value <= r.primaryResult.uncertainty.upper); assert.equal(r.primaryResult.uncertainty.method, 'CIRCULAR_BLOCK_BOOTSTRAP');
  const src = readFileSync('research/referee/statistics.js', 'utf8'); assert.ok(!/shuffle\(scores\)/.test(src), 'no naive row shuffle of the score vector');
  const rng = createRng('unit'); const xs = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : -1)); const st = (v) => v.reduce((a, b) => a + b, 0);
  const perm = blockPermutationNull(xs, { blockLen: 2, iterations: 50, rng, statistic: st, observed: 0, direction: 'POSITIVE' }); assert.equal(perm.applicable, true); assert.equal(perm.blocks, 30); assert.equal(perm.p, 1, 'block permutation of a zero-sum series never exceeds zero... it always equals it');
  const shift = circularShiftPlacebo(xs, { blockLen: 2, shiftCount: 5, statistic: st, observed: 0, direction: 'POSITIVE' }); assert.equal(shift.applicable, true); assert.ok(shift.shifts.every((s) => s >= 2));
  assert.equal(blockPermutationNull(xs.slice(0, 2), { blockLen: 2, iterations: 10, rng, statistic: st, observed: 0, direction: 'POSITIVE' }).applicable, false, 'too few blocks');
  const bb = blockBootstrap(xs, { blockLen: 4, iterations: 100, rng, statistic: (v) => v.reduce((a, b) => a + b, 0) / v.length }); assert.equal(bb.applicable, true); assert.ok(bb.lower <= 0 && bb.upper >= 0);
  assert.equal(describe([]).n, 0); assert.equal(averageUniqueness([]).effective, 0);
});

test('F2. pure noise does not pass beyond tolerance: over twenty seeded single-candidate noise experiments the referee marks at most a small fraction HISTORICALLY_INTERESTING, and the leak canary always fails', () => {
  let interesting = 0; const verdicts = {};
  for (let s = 0; s < 20; s += 1) { const nd = synth({ seed: `noise-solo-${s}`, steps: 120, features: (rng) => ({ SIG: rng.normal() }) }); const r = refereeEvaluate(bundleFor({ data: nd, manifestOver: { controls: { blockLengthRule: 'MAX_OVERLAP_PLUS_ONE', blockLengthRows: null, shiftCount: 20, permutationIterations: 100, bootstrapIterations: 50, nullFeatureTrials: 20, symbolPlacebo: false, horizonProfile: false } } }).bundle); verdicts[r.verdict.verdict] = (verdicts[r.verdict.verdict] ?? 0) + 1; if (r.verdict.verdict === 'HISTORICALLY_INTERESTING') interesting += 1; }
  assert.ok(interesting <= 2, `noise passed ${interesting}/20 ${JSON.stringify(verdicts)}`);
  for (const s of ['a', 'b', 'c']) { const ld = synth({ seed: `leak-${s}`, steps: 100, features: (rng, y) => ({ SIG: rng.normal(), LEAK: y }) }); const r = refereeEvaluate(bundleFor({ data: ld, manifestOver: { features: [feature('SIG'), feature('LEAK')] } }).bundle); assert.equal(r.verdict.verdict, 'LEAKAGE_DETECTED'); assert.deepEqual(r.verdict.reasons, ['FEATURE_REPRODUCES_OUTCOME']); assert.equal(r.primaryResult, null); }
});
