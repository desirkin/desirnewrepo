// RESEARCH REFEREE — THE STATISTICAL CORE. Pure deterministic functions over plain arrays: distributional moments, a
// normal CDF and its inverse, the Probabilistic Sharpe Ratio (PSR) and the Deflated Sharpe Ratio (DSR) of Bailey &
// López de Prado, rank / classification metrics, average-uniqueness effective sample sizes, and the BLOCK resampling
// nulls (circular block bootstrap, block permutation, circular time-shift placebo) that respect serial structure.
// Nothing here knows what an experiment is; nothing here reads a clock or Math.random. Scaling conventions are always
// explicit: every Sharpe-type value produced here is PER OBSERVATION, never annualized, and says so.
import { fail, isFiniteNum, round6, clamp, STRUCTURAL_MIN } from './contracts.js';

export const SHARPE_SCALE = 'PER_OBSERVATION';
export const MOMENT_CONVENTION = 'POPULATION_MOMENTS_SAMPLE_SD'; // skew / kurtosis from population central moments (as PSR's derivation), sd with n-1
export const EULER_GAMMA = 0.5772156649015329;

// ---- basic moments ------------------------------------------------------------------------------------------------
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function variance(xs) { const n = xs.length; if (n < 2) return null; const m = mean(xs); return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1); }
export const sd = (xs) => { const v = variance(xs); return v === null ? null : Math.sqrt(v); };
export function median(xs) { const s = xs.slice().sort((a, b) => a - b); const n = s.length; if (!n) return null; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
export function quantile(xs, p) { const s = xs.slice().sort((a, b) => a - b); const n = s.length; if (!n) return null; if (n === 1) return s[0]; const idx = (n - 1) * p; const lo = Math.floor(idx); const hi = Math.ceil(idx); return s[lo] + (s[hi] - s[lo]) * (idx - lo); }
export function centralMoments(xs) {
  const n = xs.length; if (!n) return null; const m = mean(xs);
  let m2 = 0; let m3 = 0; let m4 = 0; for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  return { m: m, m2: m2 / n, m3: m3 / n, m4: m4 / n };
}
// population skewness m3 / m2^1.5 and NON-excess kurtosis m4 / m2^2 (a normal has 3) — the inputs the PSR formula expects
export function skewness(xs) { const c = centralMoments(xs); if (!c || xs.length < 3 || c.m2 === 0) return null; return c.m3 / c.m2 ** 1.5; }
export function kurtosis(xs) { const c = centralMoments(xs); if (!c || xs.length < 4 || c.m2 === 0) return null; return c.m4 / (c.m2 * c.m2); }
export function downsideDeviation(xs, target = 0) { const n = xs.length; if (n < 2) return null; return Math.sqrt(xs.reduce((a, x) => a + Math.min(0, x - target) ** 2, 0) / (n - 1)); }
export function sharpe(xs) { const s = sd(xs); if (s === null || s === 0) return null; return mean(xs) / s; }
export const hitRate = (xs) => (xs.length ? xs.filter((x) => x > 0).length / xs.length : null);
export function maxDrawdown(pathReturns) { let peak = 0; let cum = 0; let mdd = 0; for (const r of pathReturns) { cum += r; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum; } return mdd; }

// the descriptive block of a return / effect series (sequential = the values are one ordered path so a drawdown is meaningful)
export function describe(xs, { sequential = false } = {}) {
  const n = xs.length;
  return {
    n, mean: round6(mean(xs)), median: round6(median(xs)), sd: round6(sd(xs)), downsideDeviation: round6(downsideDeviation(xs)), skewness: round6(skewness(xs)), kurtosis: round6(kurtosis(xs)),
    sharpe: round6(sharpe(xs)), sharpeScale: SHARPE_SCALE, momentConvention: MOMENT_CONVENTION, hitRate: round6(hitRate(xs)),
    quantiles: { p05: round6(quantile(xs, 0.05)), p25: round6(quantile(xs, 0.25)), p50: round6(quantile(xs, 0.5)), p75: round6(quantile(xs, 0.75)), p95: round6(quantile(xs, 0.95)) },
    maxDrawdown: sequential && n ? round6(maxDrawdown(xs)) : null, maxDrawdownBasis: sequential ? 'CUMULATIVE_SUM_OF_PER_OBSERVATION_RETURNS' : null,
  };
}

// ---- the normal distribution ---------------------------------------------------------------------------------------
// Marsaglia (2004) series for Phi(x): converges to double precision for |x| <= 8; independent of any erf approximation.
export function normalCdf(x) {
  if (!isFiniteNum(x)) fail('INTERNAL_FAILURE', 'normalCdf needs a finite argument');
  if (x < -8) return 0; if (x > 8) return 1;
  let s = x; let t = 0; let b = x; const q = x * x; let i = 1;
  while (s !== t) { t = s; i += 2; b *= q / i; s = t + b; }
  return clamp(0.5 + s * Math.exp(-0.5 * q - 0.91893853320467274178), 0, 1);
}
// Acklam's rational approximation refined by one Newton step against normalCdf (relative error well below 1e-12)
export function normalInv(p) {
  if (!isFiniteNum(p) || p <= 0 || p >= 1) fail('INTERNAL_FAILURE', 'normalInv needs p in (0, 1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425; let x;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= 1 - pl) { const q = p - 0.5; const r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  for (let k = 0; k < 2; k += 1) { const e = normalCdf(x) - p; const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2); x -= u / (1 + (x * u) / 2); }
  return x;
}

// ---- PSR / DSR (Bailey & López de Prado, JPM 2014, DOI 10.3905/jpm.2014.40.5.094) -------------------------------------
// PSR(SR*) = Phi( (SR - SR*) * sqrt(n - 1) / sqrt(1 - g3 * SR + (g4 - 1) / 4 * SR^2) ), SR per observation, g3 skewness,
// g4 NON-excess kurtosis. Every intermediate value is exposed so the calculation is auditable.
export function probabilisticSharpe({ sharpe: sr, benchmark = 0, n, skewness: g3, kurtosis: g4 }) {
  if (!isFiniteNum(sr) || !isFiniteNum(benchmark) || !Number.isSafeInteger(n) || n < STRUCTURAL_MIN.seriesForSharpe || !isFiniteNum(g3) || !isFiniteNum(g4)) return { applicable: false, psr: null, z: null, denominator: null, inputs: { sharpe: sr ?? null, benchmark, n: n ?? null, skewness: g3 ?? null, kurtosis: g4 ?? null }, scale: SHARPE_SCALE };
  const inner = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (!(inner > 0)) return { applicable: false, psr: null, z: null, denominator: round6(inner), inputs: { sharpe: sr, benchmark, n, skewness: g3, kurtosis: g4 }, scale: SHARPE_SCALE };
  const denominator = Math.sqrt(inner); const z = ((sr - benchmark) * Math.sqrt(n - 1)) / denominator;
  return { applicable: true, psr: round6(normalCdf(z)), z: round6(z), denominator: round6(denominator), inputs: { sharpe: round6(sr), benchmark: round6(benchmark), n, skewness: round6(g3), kurtosis: round6(g4) }, scale: SHARPE_SCALE };
}
// E[max SR_n] over N independent trials with SR variance V:  sqrt(V) * ( (1 - gamma) Z^-1(1 - 1/N) + gamma Z^-1(1 - 1/(N e)) )
// (the published approximation is for integer N >= 2; between one and two trials it is interpolated linearly from zero so
// the function is monotone from a single trial, which the effective-trial matching below relies on)
export function expectedMaxSharpe({ trials, trialVariance }) {
  if (!isFiniteNum(trials) || trials <= 1 || !isFiniteNum(trialVariance) || trialVariance < 0) return 0;
  const unit = (N) => { const z1 = normalInv(1 - 1 / N); const z2 = normalInv(1 - 1 / (N * Math.E)); return (1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2; };
  const e = trials >= 2 ? unit(trials) : (trials - 1) * unit(2);
  return Math.sqrt(trialVariance) * e;
}
// DSR = PSR evaluated at SR* = E[max SR] of the trial family: the more (effectively independent) trials the family
// burned, the higher the bar. Trials <= 1 deflates nothing (SR* = 0). An unknown trial variance with more than one
// trial is reported as NOT applicable rather than assumed favourable.
export function deflatedSharpe({ sharpe: sr, n, skewness: g3, kurtosis: g4, effectiveTrials, trialVariance }) {
  const trials = isFiniteNum(effectiveTrials) ? Math.max(1, effectiveTrials) : null;
  if (trials === null) return { applicable: false, dsr: null, benchmarkSharpe: null, effectiveTrials: null, trialVariance: trialVariance ?? null, psrAtBenchmark: null, reason: 'DSR_NOT_APPLICABLE' };
  if (trials > 1 && !isFiniteNum(trialVariance)) return { applicable: false, dsr: null, benchmarkSharpe: null, effectiveTrials: round6(trials), trialVariance: null, psrAtBenchmark: null, reason: 'TRIAL_VARIANCE_UNAVAILABLE' };
  const benchmark = trials > 1 ? expectedMaxSharpe({ trials, trialVariance }) : 0;
  const psr = probabilisticSharpe({ sharpe: sr, benchmark, n, skewness: g3, kurtosis: g4 });
  if (!psr.applicable) return { applicable: false, dsr: null, benchmarkSharpe: round6(benchmark), effectiveTrials: round6(trials), trialVariance: round6(trialVariance ?? 0), psrAtBenchmark: psr, reason: 'DSR_NOT_APPLICABLE' };
  return { applicable: true, dsr: psr.psr, benchmarkSharpe: round6(benchmark), effectiveTrials: round6(trials), trialVariance: round6(trialVariance ?? 0), psrAtBenchmark: psr, reason: null };
}
// EFFECTIVE independent trials. Inside the bundle every candidate has a return series, so their average pairwise
// correlation rho is known. Correlated trials raise the expected maximum Sharpe LESS than independent ones: for k
// equicorrelated standard normals the maximum is sqrt(rho) Z + sqrt(1 - rho) max(k independent), so E[max] scales by
// sqrt(1 - rho). The effective inside count is the number of INDEPENDENT trials whose expected maximum (under the same
// Bailey / Lopez de Prado approximation the DSR uses) equals that reduced value — found by bisection, bounded [1, k].
// Trials outside the bundle (registered family members whose series are not here) are counted RAW, i.e. as
// independent, the more skeptical assumption. The total is bounded [1, rawTrialCount] by construction.
export function expectedMaxUnitSharpe(trials) { return expectedMaxSharpe({ trials, trialVariance: 1 }); }
export function effectiveTrialCount({ rawTrialCount, insideSeries }) {
  const raw = Math.max(1, rawTrialCount | 0); const k = Math.min(insideSeries.length, raw);
  let rho = null; let insideEff = k;
  if (k >= 2) {
    const cs = []; for (let i = 0; i < insideSeries.length; i += 1) for (let j = i + 1; j < insideSeries.length; j += 1) { const c = pearson(insideSeries[i], insideSeries[j]); if (c !== null) cs.push(c); }
    rho = cs.length ? clamp(mean(cs), 0, 0.999999) : 0;
    const target = Math.sqrt(1 - rho) * expectedMaxUnitSharpe(k);
    let lo = 1; let hi = k; for (let it = 0; it < 60; it += 1) { const mid = (lo + hi) / 2; if (expectedMaxUnitSharpe(mid) < target) lo = mid; else hi = mid; }
    insideEff = clamp((lo + hi) / 2, 1, k);
  }
  const outside = Math.max(0, raw - k); const eff = clamp(insideEff + outside, 1, raw);
  return { rawTrialCount: raw, effectiveTrialCount: round6(eff), insideCandidates: k, insideEffective: round6(insideEff), outsideTrials: outside, averagePairwiseCorrelation: rho === null ? null : round6(rho), method: k >= 2 ? 'EQUICORRELATED_EXPECTED_MAX_MATCHING_PLUS_RAW_OUTSIDE' : 'RAW_COUNT_NO_CORRELATION_DATA' };
}

// ---- rank / association / classification metrics ------------------------------------------------------------------
export function ranks(xs) { const idx = xs.map((v, i) => i).sort((a, b) => xs[a] - xs[b]); const r = new Array(xs.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j += 1; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k += 1) r[idx[k]] = avg; i = j + 1; } return r; }
export function pearson(x, y) { const n = Math.min(x.length, y.length); if (n < 3) return null; const mx = mean(x.slice(0, n)); const my = mean(y.slice(0, n)); let sxy = 0; let sxx = 0; let syy = 0; for (let i = 0; i < n; i += 1) { const dx = x[i] - mx; const dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; } if (sxx === 0 || syy === 0) return null; return sxy / Math.sqrt(sxx * syy); }
export const spearman = (x, y) => (x.length < 3 ? null : pearson(ranks(x), ranks(y)));
// AUROC via the Mann-Whitney statistic with tie-aware average ranks; labels are 0/1
export function auroc(scores, labels) { const pos = labels.filter((l) => l === 1).length; const neg = labels.length - pos; if (pos === 0 || neg === 0) return null; const r = ranks(scores); let sum = 0; for (let i = 0; i < labels.length; i += 1) if (labels[i] === 1) sum += r[i]; return (sum - (pos * (pos + 1)) / 2) / (pos * neg); }
// average precision (step-wise area under the precision-recall curve), ties broken by stable descending order
export function prAuc(scores, labels) { const pos = labels.filter((l) => l === 1).length; if (pos === 0 || pos === labels.length) return null; const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a] || a - b); let tp = 0; let ap = 0; for (let k = 0; k < order.length; k += 1) { if (labels[order[k]] === 1) { tp += 1; ap += tp / (k + 1); } } return ap / pos; }
export function precisionAtK(scores, labels, k) { if (!k || k > scores.length) return null; const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a] || a - b).slice(0, k); return order.filter((i) => labels[i] === 1).length / k; }

// ---- effective sample size: average uniqueness of overlapping label intervals --------------------------------------
// Each interval [start, end] (end >= start) shares every instant it covers with the other intervals covering that
// instant; a row's uniqueness is the mean of 1 / concurrency over its own interval; n_eff = sum of uniqueness.
export function averageUniqueness(intervals) {
  const n = intervals.length; if (!n) return { n: 0, effective: 0, meanUniqueness: null };
  const pts = new Set(); for (const iv of intervals) { pts.add(iv.start); pts.add(iv.end); }
  const xs = [...pts].sort((a, b) => a - b);
  const starts = intervals.map((iv, i) => i).sort((a, b) => intervals[a].start - intervals[b].start);
  const pointRows = new Map(); // point intervals (start === end) grouped by instant
  const uniq = new Array(n).fill(0); const len = intervals.map((iv) => iv.end - iv.start);
  for (let i = 0; i < n; i += 1) if (len[i] === 0) { const k = intervals[i].start; if (!pointRows.has(k)) pointRows.set(k, []); pointRows.get(k).push(i); }
  const active = new Set(); let si = 0;
  for (let p = 0; p + 1 < xs.length; p += 1) {
    const a = xs[p]; const b = xs[p + 1];
    while (si < starts.length && intervals[starts[si]].start <= a) { const r = starts[si]; if (len[r] > 0) active.add(r); si += 1; }
    for (const r of [...active]) if (intervals[r].end <= a) active.delete(r);
    const c = active.size; if (c === 0) continue;
    const seg = b - a; for (const r of active) uniq[r] += (seg / c) / len[r];
  }
  for (const [k, rowsAt] of pointRows) { let c = rowsAt.length; for (let i = 0; i < n; i += 1) if (len[i] > 0 && intervals[i].start <= k && intervals[i].end > k) c += 1; for (const r of rowsAt) uniq[r] = 1 / c; }
  const effective = uniq.reduce((s, u) => s + u, 0);
  return { n, effective: round6(effective), meanUniqueness: round6(effective / n) };
}

// ---- block resampling ----------------------------------------------------------------------------------------------
// circular block bootstrap of a statistic over an ordered series: blocks of `blockLen` consecutive rows drawn with wrap-around
export function blockBootstrap(values, { blockLen, iterations, rng, statistic, lower = 0.025, upper = 0.975 }) {
  const n = values.length; if (n < 2 * blockLen || iterations < 1) return { applicable: false, lower: null, upper: null, iterations: 0, blockLen, method: 'CIRCULAR_BLOCK_BOOTSTRAP' };
  const stats = []; const blocks = Math.ceil(n / blockLen);
  for (let it = 0; it < iterations; it += 1) {
    const sample = new Array(n); let k = 0;
    for (let b = 0; b < blocks && k < n; b += 1) { const start = rng.int(n); for (let j = 0; j < blockLen && k < n; j += 1) sample[k++] = values[(start + j) % n]; }
    const s = statistic(sample); if (isFiniteNum(s)) stats.push(s);
  }
  if (stats.length < 2) return { applicable: false, lower: null, upper: null, iterations: stats.length, blockLen, method: 'CIRCULAR_BLOCK_BOOTSTRAP' };
  return { applicable: true, lower: round6(quantile(stats, lower)), upper: round6(quantile(stats, upper)), iterations: stats.length, blockLen, method: 'CIRCULAR_BLOCK_BOOTSTRAP', level: round6(upper - lower) };
}
// block permutation null: the SCORE side is permuted in contiguous blocks (the outcome side and its serial structure stay
// fixed), the statistic is recomputed; p = (1 + #{null >= observed}) / (1 + iterations) in the declared direction
export function blockPermutationNull(scores, { blockLen, iterations, rng, statistic, observed, direction }) {
  const n = scores.length; const blocks = Math.ceil(n / blockLen);
  if (blocks < STRUCTURAL_MIN.blocksForNull || iterations < 1 || !isFiniteNum(observed)) return { applicable: false, p: null, iterations: 0, blockLen, blocks, method: 'BLOCK_PERMUTATION', nullDistribution: null };
  const idx = Array.from({ length: blocks }, (_, b) => b); const dist = []; let ge = 0;
  for (let it = 0; it < iterations; it += 1) {
    const order = rng.shuffle(idx); const perm = new Array(n); let k = 0;
    for (const b of order) for (let j = b * blockLen; j < Math.min(n, (b + 1) * blockLen); j += 1) perm[k++] = scores[j];
    const s = statistic(perm.slice(0, n)); if (!isFiniteNum(s)) continue; dist.push(s); if (exceeds(s, observed, direction)) ge += 1;
  }
  if (dist.length < 1) return { applicable: false, p: null, iterations: 0, blockLen, blocks, method: 'BLOCK_PERMUTATION', nullDistribution: null };
  return { applicable: true, p: round6((1 + ge) / (1 + dist.length)), iterations: dist.length, blockLen, blocks, method: 'BLOCK_PERMUTATION', nullDistribution: describe(dist) };
}
// circular time-shift placebo: the score series is rotated by shifts at least one block away from true alignment (and at
// least one block short of a full rotation); a genuinely timed edge should materially weaken under every such shift
export function circularShiftPlacebo(scores, { blockLen, shiftCount, statistic, observed, direction }) {
  const n = scores.length; const shifts = [];
  for (let j = 1; j <= shiftCount; j += 1) { const s = Math.round((j * n) / (shiftCount + 1)); if (s >= blockLen && n - s >= blockLen && !shifts.includes(s)) shifts.push(s); }
  if (!shifts.length || !isFiniteNum(observed)) return { applicable: false, p: null, shifts: [], values: null, method: 'CIRCULAR_TIME_SHIFT', blockLen };
  const values = []; let ge = 0;
  for (const s of shifts) { const rotated = scores.map((_, i) => scores[(i + s) % n]); const v = statistic(rotated); if (!isFiniteNum(v)) continue; values.push(round6(v)); if (exceeds(v, observed, direction)) ge += 1; }
  if (!values.length) return { applicable: false, p: null, shifts, values: null, method: 'CIRCULAR_TIME_SHIFT', blockLen };
  return { applicable: true, p: round6((1 + ge) / (1 + values.length)), shifts, values, placeboDistribution: describe(values), method: 'CIRCULAR_TIME_SHIFT', blockLen };
}
// "at least as extreme as the observed value" in the declared direction (two-sided when UNDECLARED)
export function exceeds(v, observed, direction) { if (direction === 'POSITIVE') return v >= observed; if (direction === 'NEGATIVE') return v <= observed; return Math.abs(v) >= Math.abs(observed); }
export function signedEffect(v, direction) { if (v === null) return null; return direction === 'NEGATIVE' ? -v : v; }
