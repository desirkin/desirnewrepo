// LEARN-1 — the explicit statistical estimator. Regularized setup/regime estimates with shrinkage toward the pooled
// applicable baseline and honest uncertainty; NEVER 'confidence += 0.1 on a win'. Evidence enters at GROUP level
// (one aggregated observation per dependence group), so replays, duplicate posts, overlapping ticks and common-shock
// clusters cannot inflate support. Censored / not-yet-known / unavailable outcomes are excluded and counted — they
// are never losses and never zero returns. Estimates are non-monotonic by construction: contradictory groups pull
// the posterior down exactly as supporting groups pull it up. A posterior over a defined outcome is not certainty
// that any narrative explanation is correct.
import { isFiniteNum, round4, deepFreeze } from './contracts.js';

export const ESTIMATOR_VERSION = 'learning-estimator-1';
export const DEFAULT_PRIOR_STRENGTH = 8; // pseudo-groups of shrinkage toward the pooled mean (an engineering default, documented)

// groups: [{ favorable, adverse, neutral, censored }] — per-group outcome counts (already deduplicated by grouping).
// A group contributes ONE fractional observation: favorable/(favorable+adverse) over its informative members.
// pooled: { mean } — the pooled applicable setup/regime baseline rate; sparse cells shrink toward it.
export function betaBinomialGrouped({ groups, pooledMean, priorStrength = DEFAULT_PRIOR_STRENGTH }) {
  if (!isFiniteNum(pooledMean) || pooledMean < 0 || pooledMean > 1) throw new Error('estimator: pooled mean malformed');
  if (!Number.isSafeInteger(priorStrength) || priorStrength < 1) throw new Error('estimator: prior strength malformed');
  let g = 0; let favorableGroups = 0; let excluded = 0;
  for (const grp of groups) {
    const informative = grp.favorable + grp.adverse;
    if (informative === 0) { excluded += 1; continue; } // neutral-only / censored-only groups inform nothing directionally
    g += 1; favorableGroups += grp.favorable / informative;
  }
  const alpha0 = pooledMean * priorStrength; const beta0 = (1 - pooledMean) * priorStrength;
  const alpha = alpha0 + favorableGroups; const beta = beta0 + (g - favorableGroups);
  const mean = alpha / (alpha + beta);
  // normal approximation of the Beta posterior, clamped to [0,1] — documented approximation, not an exact quantile
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  return deepFreeze({
    method: 'BETA_BINOMIAL_SHRINKAGE_GROUPED', estimatorVersion: ESTIMATOR_VERSION,
    pooledMean: round4(pooledMean), posteriorMean: round4(mean),
    lower95: round4(Math.max(0, mean - 1.96 * sd)), upper95: round4(Math.min(1, mean + 1.96 * sd)),
    effectiveGroups: g, excludedGroups: excluded, priorStrength,
    intervalLaw: 'NORMAL_APPROXIMATION_OF_BETA_POSTERIOR',
  });
}

// continuous outcomes (e.g. 60m log-return %): per-group means shrunk toward the pooled mean with weight g/(g+k).
export function normalShrinkageGrouped({ groupMeans, pooledMean, priorStrength = DEFAULT_PRIOR_STRENGTH }) {
  const xs = groupMeans.filter(isFiniteNum);
  const g = xs.length;
  if (!isFiniteNum(pooledMean)) throw new Error('estimator: pooled mean malformed');
  if (g === 0) return deepFreeze({ method: 'NORMAL_SHRINKAGE_GROUPED', estimatorVersion: ESTIMATOR_VERSION, pooledMean: round4(pooledMean), posteriorMean: round4(pooledMean), lower95: null, upper95: null, effectiveGroups: 0, priorStrength, intervalLaw: 'NO_GROUPS_FALLS_BACK_TO_POOLED' });
  const cellMean = xs.reduce((a, b) => a + b, 0) / g;
  const w = g / (g + priorStrength);
  const mean = w * cellMean + (1 - w) * pooledMean;
  const sd = g > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - cellMean) ** 2, 0) / (g - 1)) : null;
  const se = sd !== null ? sd / Math.sqrt(g) : null;
  return deepFreeze({
    method: 'NORMAL_SHRINKAGE_GROUPED', estimatorVersion: ESTIMATOR_VERSION,
    pooledMean: round4(pooledMean), posteriorMean: round4(mean),
    lower95: se !== null ? round4(mean - 1.96 * se) : null, upper95: se !== null ? round4(mean + 1.96 * se) : null,
    effectiveGroups: g, priorStrength, intervalLaw: g > 1 ? 'NORMAL_SE_OVER_GROUP_MEANS' : 'SINGLE_GROUP_NO_INTERVAL',
  });
}
