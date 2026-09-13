import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivation, transitionActivation, applyLearnedAdjustment, degradationCheck } from '../learning/adapter.js';

const T = Date.UTC(2026, 8, 13);
const DAY = 86_400_000;
const KILL = { state: 'ARMED', reason: null, ts: T };
const VALIDATION = { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 0.4 };
const PREDICATE = { clauses: [{ feature: 'rv60', op: 'GTE', threshold: 1 }] };
const FEATURES = { features: {
  rv60: { value: 3, availability: 'KNOWN', ageMs: 10 },
  spreadBps: { value: 2, availability: 'KNOWN', ageMs: 10 },
  atrPct: { value: 1, availability: 'KNOWN', ageMs: 10 },
} };

function active(over = {}) {
  const published = buildActivation({
    candidateId: over.candidateId ?? 'lcand-review', patternId: over.patternId ?? 'lpat-review',
    trainingCutoffTs: T - DAY, candidateDigest: 'candidate-digest', evidenceDigest: 'evidence-digest', reportDigest: 'report-digest',
    maxAbsAdjust: over.maxAbsAdjust ?? 0.1, adjust: over.adjust ?? 0.02,
    scope: over.scope, eligibility: over.eligibility, axes: over.axes,
    validation: VALIDATION, applicability: PREDICATE, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T,
    degradeRule: over.degradeRule,
  });
  return transitionActivation(published, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T, cooldownUntilTs: over.cooldownUntilTs ?? null });
}

const apply = (head, extra = {}) => applyLearnedAdjustment({
  baselineScore: 1, activationHeads: new Map([[head.activationId, head]]), featureSet: FEATURES,
  adjustments: {}, nowTs: T + 1000, kill: KILL, ...extra,
});

test('override map may narrow a frozen effect but cannot widen, reverse, or inherit a prototype value', () => {
  const a = active();
  assert.equal(apply(a, { adjustments: { [a.activationId]: 0.01 } }).effectiveScore, 1.01);
  assert.equal(apply(a, { adjustments: { [a.activationId]: 0.08 } }).fallbackReason, 'ADJUSTMENT_WIDENS_OR_REVERSES_FROZEN_EFFECT');
  assert.equal(apply(a, { adjustments: { [a.activationId]: -0.01 } }).fallbackReason, 'ADJUSTMENT_WIDENS_OR_REVERSES_FROZEN_EFFECT');
  const inherited = Object.create({ [a.activationId]: 0.01 });
  assert.equal(apply(a, { adjustments: inherited }).effectiveScore, 1.02, 'only an own override property is consumed');
});

test('non-ranking and cooling activations do not contribute', () => {
  assert.deepEqual(apply(active({ axes: ['SIZING'] })).applied, []);
  assert.deepEqual(apply(active({ candidateId: 'lcand-cool', patternId: 'lpat-cool', cooldownUntilTs: T + DAY })).applied, []);
});

test('a constrained activation requires prepared context and enforces scope, coverage, freshness, and numeric ranges', () => {
  const a = active({
    scope: { setupType: 'RANGE', regime: 'CALM', assets: ['BTC'], venues: ['kraken'] },
    eligibility: { requiredFeatures: ['rv60'], maxFactAgeMs: 100, maxSpreadBps: 5, minAtrPct: 0.5, maxAtrPct: 2 },
  });
  assert.equal(apply(a).fallbackReason, 'PREPARED_CONTEXT_REQUIRED');
  const context = { setupType: 'RANGE', regime: 'CALM', asset: 'BTC', venue: 'kraken' };
  assert.equal(apply(a, { preparedFacts: context }).effectiveScore, 1.02);
  assert.deepEqual(apply(a, { preparedFacts: { ...context, asset: 'ETH' } }).applied, []);
  assert.deepEqual(apply(a, { preparedFacts: context, featureSet: { features: { ...FEATURES.features, rv60: { value: 3, availability: 'KNOWN', ageMs: 101 } } } }).applied, []);
  assert.deepEqual(apply(a, { preparedFacts: context, featureSet: { features: { ...FEATURES.features, spreadBps: { value: 'not-a-number', availability: 'KNOWN', ageMs: 10 } } } }).applied, []);
});

test('malformed degradation rules and windows fail closed; a valid consecutive sequence still degrades', () => {
  assert.deepEqual(degradationCheck({ head: active({ degradeRule: { minGroups: 2, adverseFractionAbove: 0.7, consecutiveWindows: 0 } }), windows: [] }), { degrade: false, reason: 'INVALID_DEGRADE_RULE' });
  assert.deepEqual(degradationCheck({ head: active(), windows: [{ groups: 10, adverseGroups: 11 }, { groups: 10, adverseGroups: 8 }] }), { degrade: false, reason: 'INVALID_WINDOW' });
  assert.deepEqual(degradationCheck({ head: active(), windows: [{ groups: 10, adverseGroups: 8 }, { groups: 12, adverseGroups: 9 }] }), { degrade: true, reason: 'PREDECLARED_DEGRADATION_RULE_MET' });
});
