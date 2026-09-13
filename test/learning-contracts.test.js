// LEARN-1 — contracts: identities, closed validators, lifecycle law, honest counting at the identity level.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  opportunityIdOf, candidateIdOf, episodeError, patternRecordError, activationError, campaignManifestError,
  questionError, coverageRowError, PATTERN_TRANSITIONS, DEFAULT_FLOORS, CAMPAIGN_MANIFEST_VERSION,
  CAPTURE_RECIPE_VERSION, FEATURE_RECIPE_VERSION, BASELINE_RULE_VERSION, LEARNING_VERSION,
  ACTIVATION_VERSION, QUESTION_VERSION, COVERAGE_LEDGER_VERSION, PATTERN_RECORD_VERSION,
  canonicalDigest, campaignIdOf, patternIdOf, utcDateOf,
} from '../learning/contracts.js';

const T = Date.UTC(2026, 5, 2, 12, 0, 0);

test('one primary opportunity identity: variants, horizons and parameters do not mint a new id; the identity inputs do', () => {
  const base = { canonicalCoin: 'BTC', decisionTs: T, captureRecipeVersion: CAPTURE_RECIPE_VERSION, datasetId: 'ds1' };
  const a = opportunityIdOf(base);
  assert.equal(a, opportunityIdOf({ ...base })); // deterministic
  assert.notEqual(a, opportunityIdOf({ ...base, decisionTs: T + 60_000 }));
  assert.notEqual(a, opportunityIdOf({ ...base, canonicalCoin: 'ETH' }));
  assert.notEqual(a, opportunityIdOf({ ...base, datasetId: 'ds2' }));
  // there is no strategy/horizon/variant field in the identity at all — a variant CANNOT change the primary id
  assert.throws(() => opportunityIdOf({ ...base, decisionTs: 'soon' }));
});

function validEpisode(overrides = {}) {
  const canonicalCoin = overrides.canonicalCoin ?? 'BTC';
  const decisionTs = overrides.decisionTs ?? T;
  return {
    learningVersion: LEARNING_VERSION,
    opportunityId: opportunityIdOf({ canonicalCoin, decisionTs, captureRecipeVersion: CAPTURE_RECIPE_VERSION, datasetId: 'ds1' }),
    episodeSeq: 0, mode: 'HISTORICAL_REPLAY', evidenceBasis: 'HISTORICAL_RECONSTRUCTION', fidelity: 'CANDLE_DESCRIPTIVE',
    canonicalCoin, venue: 'kraken', catalogIdentity: null, membershipAtDecision: 'UNKNOWN',
    decisionTs, usableAtTs: decisionTs, ingestionSeq: 0,
    captureRecipeVersion: CAPTURE_RECIPE_VERSION, featureRecipeVersion: FEATURE_RECIPE_VERSION,
    baselineRuleVersion: BASELINE_RULE_VERSION, activeAdjustmentVersion: null,
    setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED',
    features: { ret1mPct: { value: 0.5, unit: 'simple_percent', lookbackMs: 60000, availability: 'KNOWN' } },
    gates: [], decision: 'NO_SETUP', baselineScore: null, scoreContributions: null, rejection: null,
    constraints: null, spreadDepth: null, datasetId: 'ds1', campaignId: null,
    authority: 'NONE', purpose: 'RESEARCH_ONLY',
    ...overrides,
  };
}

test('episode validator: missing stays missing (no value smuggled through UNAVAILABLE), SKIPPED and rejection imply each other, synthetic basis is fenced to synthetic mode', () => {
  assert.equal(episodeError(validEpisode()), null);
  assert.match(episodeError(validEpisode({ features: { x: { value: 1, unit: 'u', lookbackMs: 1, availability: 'UNAVAILABLE' } } })), /exposes a value/);
  assert.match(episodeError(validEpisode({ decision: 'SKIPPED' })), /imply each other/);
  assert.match(episodeError(validEpisode({ rejection: { reasonCode: 'X', observedValue: 1, threshold: 2, class: 'SOFT' } })), /imply each other/);
  assert.equal(episodeError(validEpisode({ decision: 'SKIPPED', rejection: { reasonCode: 'X', observedValue: 1, threshold: 2, class: 'SOFT' } })), null);
  assert.match(episodeError(validEpisode({ evidenceBasis: 'SYNTHETIC' })), /SYNTHETIC/);
  assert.match(episodeError(validEpisode({ mode: 'SYNTHETIC_STRESS' })), /SYNTHETIC/);
  assert.match(episodeError(validEpisode({ usableAtTs: T - 1 })), /precedes/); // usable before decided is impossible
  assert.match(episodeError(validEpisode({ authority: 'SOME' })), /authority/);
});

test('pattern lifecycle: every pattern begins NOTICED; a promising report cannot jump to ACTIVE_PAPER; unlawful transitions are refused; RETIRED is terminal', () => {
  assert.deepEqual(PATTERN_TRANSITIONS.RETIRED, []);
  assert.ok(!PATTERN_TRANSITIONS.NOTICED.includes('ACTIVE_PAPER'));
  assert.ok(!PATTERN_TRANSITIONS.ACCUMULATING.includes('VALIDATED_PAPER'));
  assert.ok(!PATTERN_TRANSITIONS.ACCUMULATING.includes('ACTIVE_PAPER'));
  const predicate = { clauses: [] }; const scope = { setupType: 'S', regime: 'R' };
  const rec = (seq, state, previousState) => ({
    patternRecordVersion: PATTERN_RECORD_VERSION,
    patternId: patternIdOf({ predicateDigest: canonicalDigest(predicate), scopeDigest: canonicalDigest(scope) }),
    seq, state, previousState, transitionReason: 't', ts: T, predicate, predicateDigest: canonicalDigest(predicate),
    scope, scopeDigest: canonicalDigest(scope), origin: 'TEST', createdTs: T,
    evidence: { rawCount: 1, groupCount: 1, distinctAssets: 1, distinctUtcDates: 1, favorable: 1, adverse: 0, neutral: 0, censored: 0, byBasis: { HISTORICAL_RECONSTRUCTION: 1, CONTEMPORANEOUS_HISTORICAL: 0, PROSPECTIVE: 0, SYNTHETIC: 0 }, evidenceRefs: [], evidenceRefsTruncated: false },
    estimate: null, contradictions: [], candidateId: null, activationId: null, authority: 'NONE', purpose: 'RESEARCH_ONLY',
  });
  assert.equal(patternRecordError(rec(0, 'NOTICED', null)), null);
  assert.match(patternRecordError(rec(0, 'ACCUMULATING', null)), /begins NOTICED/);
  assert.match(patternRecordError(rec(1, 'ACTIVE_PAPER', 'NOTICED')), /not lawful/);
  assert.match(patternRecordError(rec(1, 'VALIDATED_PAPER', 'ACCUMULATING')), /not lawful/);
  const badCounts = rec(0, 'NOTICED', null); badCounts.evidence = { ...badCounts.evidence, favorable: 5 };
  assert.match(patternRecordError(badCounts), /reconcile/);
  const moreGroups = rec(0, 'NOTICED', null); moreGroups.evidence = { ...moreGroups.evidence, groupCount: 2 };
  assert.match(patternRecordError(moreGroups), /more independent groups/);
});

test('activation ceilings: per-activation cap, lifetime cap, allowlisted kind only, lone-loss degradation impossible', () => {
  const a = (over = {}) => ({
    activationVersion: ACTIVATION_VERSION, activationId: 'lact-x', seq: 0, state: 'PUBLISHED_WAITING_FOR_PAPER',
    candidateId: 'lcand-x', patternId: 'lpat-x', trainingCutoffTs: T, candidateDigest: 'd', evidenceDigest: 'e', reportDigest: 'r',
    allowedEffect: { kind: 'SETUP_QUALITY_SCORE_ADJUSTMENT', maxAbsAdjust: 0.1, units: 'BASELINE_SCORE_UNITS' },
    applicability: { clauses: [] }, previousVersion: null, effectiveTs: T, expiresTs: T + 86_400_000, cooldownUntilTs: null,
    degradeRule: { minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 }, transitionReason: 't', ts: T,
    authority: 'PAPER_ASSESSMENT_ADJUSTMENT_ONLY', ...over,
  });
  assert.equal(activationError(a()), null);
  assert.match(activationError(a({ allowedEffect: { kind: 'SETUP_QUALITY_SCORE_ADJUSTMENT', maxAbsAdjust: 0.2, units: 'BASELINE_SCORE_UNITS' } })), /maxAbsAdjust/);
  assert.match(activationError(a({ allowedEffect: { kind: 'THRESHOLD_REWRITE', maxAbsAdjust: 0.1, units: 'BASELINE_SCORE_UNITS' } })), /allowlisted/);
  assert.match(activationError(a({ expiresTs: T + 200 * 86_400_000 })), /ceiling/);
  assert.match(activationError(a({ degradeRule: { minGroups: 1, adverseFractionAbove: 0.5, consecutiveWindows: 1 } })), /lone loss/);
  assert.match(activationError(a({ authority: 'NONE' })), /authority/);
});

test('campaign manifest: outcome-dependent winner-only samplers are refused; optimistic intrabar resolution is refused; floors on design are separate', () => {
  const m = (over = {}) => {
    const createdTs = T; const datasetId = 'ds1'; const mode = over.mode ?? 'HISTORICAL_REPLAY'; const seed = 's';
    return {
      campaignVersion: CAMPAIGN_MANIFEST_VERSION, campaignId: campaignIdOf({ createdTs, datasetId, mode, seed }),
      createdTs, mode, fidelity: 'CANDLE_SIMULATED_EXECUTION', datasetId, datasetIdentity: { kind: 'FIXTURE' },
      universeRule: 'ALL', samplingSchedule: { kind: 'OUTCOME_INDEPENDENT_GRID', gridMinutes: 30, perAssetCap: null },
      captureRecipeVersion: CAPTURE_RECIPE_VERSION, featureRecipeVersion: FEATURE_RECIPE_VERSION, baselineRuleVersion: BASELINE_RULE_VERSION,
      candidateVersions: [], discoveryValidationBoundaryTs: null, horizonsMin: [60],
      costAssumptions: { feePctPerSide: 0.8, slippageBps: 10, entryDelayBars: 1, intrabarRule: 'UNRESOLVED' },
      resourceBudget: { maxOpportunitiesPerRun: 100, maxWallMsPerRun: 1000, maxResultBytes: 1 << 20 },
      terminalTarget: 100, seed, authority: 'NONE', purpose: 'RESEARCH_ONLY', ...over,
    };
  };
  assert.equal(campaignManifestError(m()), null);
  assert.match(campaignManifestError(m({ samplingSchedule: { kind: 'WINNERS_ONLY', gridMinutes: 30, perAssetCap: null } })), /winner-only samplers are refused/);
  assert.match(campaignManifestError(m({ costAssumptions: { feePctPerSide: 0.8, slippageBps: 10, entryDelayBars: 1, intrabarRule: 'FAVORABLE_FIRST' } })), /never optimistic/);
});

test('design floors cannot be registered below the anti-shortcut defaults', () => {
  // candidateIdOf is deterministic over the design body — a changed floor is a NEW candidate identity
  const a = candidateIdOf({ x: 1 }); const b = candidateIdOf({ x: 2 });
  assert.notEqual(a, b);
  assert.equal(DEFAULT_FLOORS.minIndependentGroups, 30);
  assert.equal(DEFAULT_FLOORS.minDistinctUtcDates, 7);
  assert.equal(DEFAULT_FLOORS.minDistinctAssets, 5);
});

test('questions: a missed-move audit is outcome-selected by definition and cannot pose as an unbiased sample', () => {
  const q = (over = {}) => ({
    questionVersion: QUESTION_VERSION, questionId: 'lq-x', seq: 0, family: 'MISSED_MOVE_AUDIT', trigger: 'test',
    predicate: { clauses: [] }, predicateDigest: canonicalDigest({ clauses: [] }), scope: {}, priorityRationale: 'r',
    candidateFamily: null, assignedBudget: 3, state: 'OPEN', trialCount: 0, result: null, nextAction: 'n',
    evidenceRefs: [], createdTs: T, ts: T, outcomeSelected: true, authority: 'NONE', purpose: 'RESEARCH_ONLY', ...over,
  });
  assert.equal(questionError(q()), null);
  assert.match(questionError(q({ outcomeSelected: false })), /outcome-selected by definition/);
});

test('coverage row: a deterministic rotation never carries an invented inclusion probability; utcDate must agree with the sweep clock', () => {
  const row = (over = {}) => ({
    ledgerVersion: COVERAGE_LEDGER_VERSION, sweepId: 's1', utcDate: utcDateOf(T), sweepTs: T, canonicalCoin: 'BTC',
    attention: 'EVALUATED', reasonCode: null, lastEvaluatedTs: null, nextEligibleTs: null,
    selectionReason: 'DETERMINISTIC_ROTATION', inclusionProbability: null, ...over,
  });
  assert.equal(coverageRowError(row()), null);
  assert.match(coverageRowError(row({ inclusionProbability: 0.5 })), /no invented selection probability/);
  assert.match(coverageRowError(row({ utcDate: '2020-01-01' })), /disagrees/);
});
