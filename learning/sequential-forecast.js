// Pure, authority-free sequential forecast comparison.
// Choe & Ramdas, Comparing Sequential Forecasters, theorem 1, eqs.14 and17:
// https://arxiv.org/html/2110.00115v6
// For a difference of bounded [0,1] scores, delta is in [-1,1]. Hoeffding's
// lemma gives conditional sub-Gaussian variance proxy 1 per comparison unit.
// This is the two-sided NORMAL mixture, not an empirical Bernstein method.
// An observation must satisfy the declared filtration/order. Calling this
// arithmetic on arbitrarily overlapping/delayed labels proves no such fact.
import { canonicalDigest, deepFreeze } from './contracts.js';

export const SEQUENTIAL_FORECAST_VERSION = 'hoeffding-normal-mixture-1';
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const probability = (x) => finite(x) && x >= 0 && x <= 1;

export function brierLoss(prediction, label) {
  if (!probability(prediction) || (label !== 0 && label !== 1)) throw new TypeError('BRIER_INPUT_INVALID');
  return (prediction - label) ** 2;
}

export function normalMixtureBoundary({ variance, alpha, rho }) {
  if (!finite(variance) || variance < 0 || !finite(alpha) || alpha <= 0 || alpha >= 1 || !finite(rho) || rho <= 0) throw new TypeError('CS_SETTINGS_INVALID');
  // log1p avoids unstable ratio arithmetic. Eq.17 is already TWO-SIDED:
  // alpha is not halved again and repeated monitoring does not spend alpha.
  const boundary = Math.sqrt((variance + rho) * (Math.log1p(variance / rho) - 2 * Math.log(alpha)));
  // Exotic but finite inputs can still overflow intermediate IEEE arithmetic.
  // Refuse unsupported numeric settings instead of serializing Infinity as null.
  if (!finite(boundary)) throw new RangeError('CS_NUMERIC_RANGE_UNSUPPORTED');
  return boundary;
}

export function forecastConfidenceSequence({ count, sum, alpha, rho }) {
  if (!Number.isSafeInteger(count) || count < 0 || !finite(sum) || Math.abs(sum) > count + 1e-10 || (count === 0 && sum !== 0)) throw new TypeError('CS_STATE_INVALID');
  const boundary = normalMixtureBoundary({ variance: count, alpha, rho });
  if (count === 0) return deepFreeze({ version: SEQUENTIAL_FORECAST_VERSION, count, mean: null, lower: -1, upper: 1, radius: null, alpha, rho, authority: 'NONE' });
  const mean = sum / count; const radius = boundary / count;
  return deepFreeze({ version: SEQUENTIAL_FORECAST_VERSION, count, mean, lower: Math.max(-1, mean - radius), upper: Math.min(1, mean + radius), radius, alpha, rho, authority: 'NONE' });
}

// Summable per-trial allocation: alpha_j = familyAlpha / (j*(j+1)).
// A durable owner must allocate trialOrdinal BEFORE capture, preserve every
// ordinal across restart/renaming, and never issue two claims for one ordinal.
export function trialAlpha({ familyAlpha, trialOrdinal }) {
  if (!finite(familyAlpha) || familyAlpha <= 0 || familyAlpha >= 1 || !Number.isSafeInteger(trialOrdinal) || trialOrdinal < 1 || trialOrdinal > 1_000_000) throw new TypeError('TRIAL_BUDGET_INVALID');
  const alpha = familyAlpha / (trialOrdinal * (trialOrdinal + 1));
  if (!finite(alpha) || alpha <= 0) throw new RangeError('TRIAL_ALPHA_UNREPRESENTABLE');
  return alpha;
}

// Each unit is sealed before observing its label. This first supported method
// accepts SERIAL_NONOVERLAPPING units only; the next capture must follow the
// preceding unit's actual outcome availability, not merely its nominal end.
// Within a unit, compare the same prospectively chosen opportunity. Arbitrary
// correlated/overlapping rows are not silently treated as independent trials.
export function replayForecastComparison({ records, alpha, rho, minimumImprovement }) {
  if (!Array.isArray(records) || records.length > 100_000 || !finite(minimumImprovement) || minimumImprovement <= 0 || minimumImprovement >= 1) throw new TypeError('COMPARISON_SETTINGS_INVALID');
  normalMixtureBoundary({ variance: 0, alpha, rho });
  const ids = new Set(); let priorKnownAt = -1; let sum = 0; let count = 0;
  for (const row of records) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('COMPARISON_ROW_INVALID');
    const keys = ['opportunityId', 'capturedTs', 'horizonEndTs', 'outcomeKnownAtTs', 'referencePrediction', 'candidatePrediction', 'label', 'predictionDigest'];
    if (Object.keys(row).length !== keys.length || keys.some((k) => !Object.hasOwn(row, k))) throw new TypeError('COMPARISON_ROW_SCHEMA');
    if (typeof row.opportunityId !== 'string' || !row.opportunityId || ids.has(row.opportunityId)) throw new TypeError('COMPARISON_EPISODE_DUPLICATE_OR_INVALID');
    if (![row.capturedTs, row.horizonEndTs, row.outcomeKnownAtTs].every((t) => Number.isSafeInteger(t) && t > 0)
      || row.capturedTs >= row.horizonEndTs || row.outcomeKnownAtTs < row.horizonEndTs || row.capturedTs <= priorKnownAt) throw new TypeError('COMPARISON_ORDER_OR_DELAY_UNSUPPORTED');
    const original = { opportunityId: row.opportunityId, capturedTs: row.capturedTs, horizonEndTs: row.horizonEndTs, referencePrediction: row.referencePrediction, candidatePrediction: row.candidatePrediction };
    if (row.predictionDigest !== canonicalDigest(original)) throw new TypeError('COMPARISON_SAVED_PREDICTION_MISMATCH');
    const delta = brierLoss(row.referencePrediction, row.label) - brierLoss(row.candidatePrediction, row.label);
    sum += delta; count += 1; ids.add(row.opportunityId); priorKnownAt = row.outcomeKnownAtTs;
  }
  const interval = forecastConfidenceSequence({ count, sum, alpha, rho });
  return deepFreeze({ ...interval, minimumImprovement, predictiveSupport: count > 0 && interval.lower > minimumImprovement,
    comparisonOrder: 'SERIAL_NONOVERLAPPING', evidenceDigest: canonicalDigest(records),
    estimand: 'AVERAGE_CONDITIONAL_EXPECTED_REFERENCE_MINUS_CANDIDATE_BRIER_LOSS',
    policyQualified: false, note: 'FORECAST_COMPARISON_ONLY_REQUIRES_SEPARATE_AFTER_COST_POLICY_EVIDENCE' });
}
