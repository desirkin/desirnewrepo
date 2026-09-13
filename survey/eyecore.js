// THE SHARED EYE CORE (B-0B §5): one pure calculation module used by BOTH
// the live wide eye and historical parity replay, so their semantics cannot
// drift apart. LIVE BEHAVIOR IS THE SOURCE OF TRUTH — this file was
// extracted from survey/wideeye.js verbatim; no statistical choice was
// redesigned here. No network, no disk, no thresholds of its own.

// ---- FEATURE DERIVATION (B-0B.1 §6): the definitions of the wide eye's
// features live HERE, once, and are consumed by both the live sweep and
// historical parity replay. What differs between the two is only WHICH
// samples they hand in (live selects trailing sweeps on a wall-clock ~60s
// cadence; replay walks a true calendar-minute grid) — the math cannot
// drift. That residual sampling-phase difference is documented as
// SEMANTIC_PARITY_ON_60S_SAMPLING_GRID, never claimed as tick-for-tick
// reproduction.

// Log return between two prices; null when either side is unusable.
export function logReturn(pNow, pThen) {
  if (!pNow || !pThen || pNow <= 0 || pThen <= 0) return null;
  return Math.log(pNow / pThen);
}

// Percentage extension between two prices (the 15m extension feature).
export function extensionPct(pNow, pThen) {
  if (!pNow || !pThen || pNow <= 0 || pThen <= 0) return null;
  return (pNow / pThen - 1) * 100;
}

// Volume-rate feature: non-negative delta of a rolling-24h volume figure
// between consecutive samples (live: the venue's own 24h field; replay: a
// ring-reconstructed 24h sum). null when either side is not a finite number.
export function volumeRate(cum, prevCum) {
  if (!Number.isFinite(cum) || !Number.isFinite(prevCum)) return null;
  return Math.max(0, cum - prevCum);
}

// Welford-style pooled aggregates per ET-hour bucket: {n, sum, sumSq}.
export function bucketAdd(bucket, x) {
  bucket.n += 1;
  bucket.sum += x;
  bucket.sumSq += x * x;
  return bucket;
}

export function pooledStats(buckets) {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (const b of Object.values(buckets)) {
    n += b.n;
    sum += b.sum;
    sumSq += b.sumSq;
  }
  if (n < 2) return { n, mean: null, std: null };
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { n, mean, std: Math.sqrt(variance) };
}

export function zScore(x, stats, minSamples) {
  if (x === null || stats.n < minSamples || !stats.std || stats.std <= 0) return null;
  return (x - stats.mean) / stats.std;
}

// RIPPLE vs MISSED vs null — identical to live.
export function classifyRipple({ zVol, zRet5, ret15Pct }, cfg) {
  if (zVol === null || zRet5 === null || ret15Pct === null) return null;
  const cofire = zVol >= cfg.zVolThreshold && Math.abs(zRet5) >= cfg.zRetThreshold;
  if (!cofire) return null;
  return Math.abs(ret15Pct) <= cfg.extensionCapPct ? 'RIPPLE' : 'MISSED';
}

// One evaluation tick, in EXACTLY the live order: the current sample joins
// its baseline FIRST, then the z-scores are computed against the pooled
// stats that include it, then the verdict. (If that ordering should ever
// change, it changes in live first — replay only mirrors.)
export function evaluateTick({ ret1, ret5, ret15Pct, volRate }, baselines, cfg, hourKey) {
  if (ret1 !== null) bucketAdd((baselines.ret1[hourKey] ??= { n: 0, sum: 0, sumSq: 0 }), ret1);
  if (ret5 !== null) bucketAdd((baselines.ret5[hourKey] ??= { n: 0, sum: 0, sumSq: 0 }), ret5);
  if (volRate !== null) bucketAdd((baselines.volRate[hourKey] ??= { n: 0, sum: 0, sumSq: 0 }), volRate);
  const zVol = zScore(volRate, pooledStats(baselines.volRate), cfg.minSamples);
  const zRet5 = zScore(ret5, pooledStats(baselines.ret5), cfg.minSamples);
  const verdict = classifyRipple({ zVol, zRet5, ret15Pct }, cfg);
  return { zVol, zRet5, verdict };
}

// Seven-day trailing retention, identical semantics to the live pruner:
// buckets keyed "YYYY-MM-DDTHH" (ET); drop keys whose date part is older
// than the cutoff date. sessionDateOf is injected to avoid a time-lib cycle.
export function pruneBaselineBuckets(buckets, nowMs, sessionDateOf, days = 7) {
  const cutoff = sessionDateOf(new Date(nowMs - days * 86_400_000));
  for (const key of Object.keys(buckets)) {
    if (key.slice(0, 10) < cutoff) delete buckets[key];
  }
  return buckets;
}
