// LEARN-1 — grouping and estimation: dependent repeats never inflate support; contradictions reduce estimates;
// censored is never a loss; confidence is non-monotonic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assignGroups, EPISODE_WINDOW_MS } from '../learning/grouping.js';
import { betaBinomialGrouped, normalShrinkageGrouped } from '../learning/estimator.js';
import { buildEvidence, estimateFromEvidence } from '../learning/patterns.js';

const T = Date.UTC(2026, 5, 2, 12, 0, 0);
const obs = (coin, offsetMs) => ({ canonicalCoin: coin, decisionTs: T + offsetMs });

test('B. one rally is one group: 100 adjacent observations of one asset collapse to a single dependence group', () => {
  const g = assignGroups(Array.from({ length: 100 }, (_, i) => obs('DOGE', i * 60_000)));
  assert.equal(g.rawCount, 100);
  assert.equal(g.groupCount, 1);
  assert.equal(g.independenceClaim, 'APPROXIMATE_GROUPING_NOT_EXACT_INDEPENDENCE');
});

test('B. a common-shock date fuses different assets into one group; a quiet date keeps them independent', () => {
  const rows = [obs('AAA', 0), obs('BBB', 60_000), obs('CCC', 120_000)];
  const quiet = assignGroups(rows);
  assert.equal(quiet.groupCount, 3);
  const shock = assignGroups(rows, { commonShockDates: new Set([new Date(T).toISOString().slice(0, 10)]) });
  assert.equal(shock.groupCount, 1);
});

test('B. observations in different episode windows of one asset are different groups', () => {
  const g = assignGroups([obs('AAA', 0), obs('AAA', EPISODE_WINDOW_MS + 60_000)]);
  assert.equal(g.groupCount, 2);
});

test('C. contradictory groups reduce the posterior; supporting groups raise it (non-monotonic by construction)', () => {
  const pooled = 0.5;
  const up = betaBinomialGrouped({ groups: [{ favorable: 1, adverse: 0, neutral: 0, censored: 0 }, { favorable: 1, adverse: 0, neutral: 0, censored: 0 }], pooledMean: pooled });
  const thenDown = betaBinomialGrouped({ groups: [{ favorable: 1, adverse: 0, neutral: 0, censored: 0 }, { favorable: 1, adverse: 0, neutral: 0, censored: 0 }, { favorable: 0, adverse: 1, neutral: 0, censored: 0 }, { favorable: 0, adverse: 1, neutral: 0, censored: 0 }], pooledMean: pooled });
  assert.ok(up.posteriorMean > pooled);
  assert.ok(thenDown.posteriorMean < up.posteriorMean, 'new contradictions must pull the estimate DOWN');
});

test('C. censored / neutral-only groups are excluded and counted — never converted into losses', () => {
  const withCensored = betaBinomialGrouped({ groups: [{ favorable: 2, adverse: 0, neutral: 0, censored: 0 }, { favorable: 0, adverse: 0, neutral: 0, censored: 5 }], pooledMean: 0.5 });
  const without = betaBinomialGrouped({ groups: [{ favorable: 2, adverse: 0, neutral: 0, censored: 0 }], pooledMean: 0.5 });
  assert.equal(withCensored.posteriorMean, without.posteriorMean, 'a censored group must not move the estimate');
  assert.equal(withCensored.excludedGroups, 1);
  assert.equal(withCensored.effectiveGroups, 1);
});

test('sparse cells shrink toward the pooled applicable estimate; dense cells dominate their prior', () => {
  const sparse = betaBinomialGrouped({ groups: [{ favorable: 1, adverse: 0, neutral: 0, censored: 0 }], pooledMean: 0.2, priorStrength: 8 });
  assert.ok(Math.abs(sparse.posteriorMean - 0.2) < 0.15, `sparse stays near pooled (got ${sparse.posteriorMean})`);
  const dense = betaBinomialGrouped({ groups: Array.from({ length: 60 }, () => ({ favorable: 1, adverse: 0, neutral: 0, censored: 0 })), pooledMean: 0.2, priorStrength: 8 });
  assert.ok(dense.posteriorMean > 0.8, `dense evidence overcomes the prior (got ${dense.posteriorMean})`);
  assert.ok(dense.upper95 <= 1 && dense.lower95 >= 0);
});

test('normal shrinkage: no groups falls back to pooled with no invented interval; one group has no interval', () => {
  const none = normalShrinkageGrouped({ groupMeans: [], pooledMean: 1.5 });
  assert.equal(none.posteriorMean, 1.5); assert.equal(none.lower95, null);
  const one = normalShrinkageGrouped({ groupMeans: [3], pooledMean: 0 });
  assert.equal(one.intervalLaw, 'SINGLE_GROUP_NO_INTERVAL'); assert.equal(one.lower95, null);
});

test('A/B. buildEvidence + estimateFromEvidence: replayed duplicates share groups; raw and effective counts both reported', () => {
  const items = [
    { opportunityId: 'lop-1', canonicalCoin: 'AAA', decisionTs: T, evidenceBasis: 'PROSPECTIVE', outcomeClass: 'FAVORABLE' },
    { opportunityId: 'lop-2', canonicalCoin: 'AAA', decisionTs: T + 60_000, evidenceBasis: 'PROSPECTIVE', outcomeClass: 'FAVORABLE' },
    { opportunityId: 'lop-3', canonicalCoin: 'BBB', decisionTs: T, evidenceBasis: 'HISTORICAL_RECONSTRUCTION', outcomeClass: 'ADVERSE' },
    { opportunityId: 'lop-4', canonicalCoin: 'CCC', decisionTs: T, evidenceBasis: 'PROSPECTIVE', outcomeClass: 'CENSORED' },
  ];
  const ev = buildEvidence(items);
  assert.equal(ev.rawCount, 4);
  assert.equal(ev.groupCount, 3, 'two same-asset adjacent observations share one group');
  assert.equal(ev.favorable, 2); assert.equal(ev.adverse, 1); assert.equal(ev.censored, 1);
  assert.deepEqual(ev.byBasis, { HISTORICAL_RECONSTRUCTION: 1, CONTEMPORANEOUS_HISTORICAL: 0, PROSPECTIVE: 3, SYNTHETIC: 0 });
  const est = estimateFromEvidence(items, ev, { pooledMean: 0.5, priorStrength: 8, updatedTs: T });
  assert.equal(est.effectiveGroups, 2, 'the censored-only group informs nothing directionally');
  assert.ok(est.posteriorMean > 0 && est.posteriorMean < 1);
});
