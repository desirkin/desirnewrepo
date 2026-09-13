import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opportunityIdOf } from '../learning/contracts.js';
import { createAdaptiveCore, AdaptiveCoreError } from '../learning/adaptive-core.js';
import { createAdaptiveStore } from '../learning/adaptive-store.js';
import {
  ADAPTIVE_EFFECT_REGISTRY, ADAPTIVE_HORIZON_MS, adaptiveProcedureError,
  sealAdaptiveProcedure,
} from '../learning/adaptive-registry.js';

const T0 = Date.UTC(2026, 8, 13, 12);
const DIGEST = (char) => char.repeat(64);

function procedure(overrides = {}) {
  return sealAdaptiveProcedure({
    parentPolicyDigest: DIGEST('a'),
    consumerContractDigest: DIGEST('b'),
    featureRecipeDigest: DIGEST('c'),
    strategyIds: ['PULLBACK', 'MOMENTUM'],
    createdTs: T0,
    ...overrides,
  });
}

function harness(t, overrides = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adaptive-core-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let current = T0 + 10_100;
  const clock = () => current;
  const p = procedure(overrides);
  const store = createAdaptiveStore({ rootDir, procedure: p, clock });
  t.after(() => { try { store.close(); } catch {} });
  const core = createAdaptiveCore({ store, procedure: p, clock });
  return { rootDir, procedure: p, store, core, setNow: (value) => { current = value; } };
}

function predictionInput(p, n, states = { MOMENTUM: 'ELIGIBLE', PULLBACK: 'INELIGIBLE' }) {
  const decisionTs = T0 + n * 10_000;
  const identity = { canonicalCoin: `A${n}A`, decisionTs, captureRecipeVersion: 'adaptive-test-capture-1', datasetId: 'adaptive-test-data' };
  return {
    opportunityId: opportunityIdOf(identity), identity,
    catalogContentId: 'catalog-test-1', predictionTs: decisionTs,
    horizonMs: ADAPTIVE_HORIZON_MS, featureRecipeDigest: p.parent.featureRecipeDigest, factsDigest: DIGEST('e'),
    strategyAssessments: p.strategies.map((strategyId) => ({
      strategyId,
      eligibility: states[strategyId],
      reasonCode: states[strategyId] === 'ELIGIBLE' ? null : 'SETUP_NOT_ELIGIBLE',
    })),
    selection: { strategyId: states.MOMENTUM === 'ELIGIBLE' ? 'MOMENTUM' : null, reasonCode: states.MOMENTUM === 'ELIGIBLE' ? 'BASELINE_SELECTED' : 'ABSTAINED' },
  };
}

function matureInput(prediction, { logReturnPct = 1, knownDelayMs = 1_000 } = {}) {
  return {
    opportunityId: prediction.opportunityId,
    horizonMs: prediction.horizonMs,
    state: 'MATURED', logReturnPct,
    sourceEventTs: prediction.targetEndTs,
    knownAtTs: prediction.targetEndTs + knownDelayMs,
    sourceDigest: DIGEST('f'), reasonCode: null,
  };
}

test('registry seals an actual binary 60m probability forecast and only rank selection is supported', () => {
  const p = procedure();
  assert.equal(adaptiveProcedureError(p), null);
  assert.equal(p.target.name, 'POSITIVE_60M_LOG_RETURN');
  assert.equal(p.target.score, 'BRIER_LOSS');
  assert.equal(p.target.horizonMs, ADAPTIVE_HORIZON_MS);
  assert.equal(p.target.maxPredictionPersistenceDelayMs, 5_000);
  assert.equal(p.effectRegistry.RANKING_SELECTION.state, 'SUPPORTED_AFTER_EXTERNAL_QUALIFICATION');
  assert.deepEqual(p.effectRegistry, ADAPTIVE_EFFECT_REGISTRY);
  for (const field of ['ENTRY', 'EXIT', 'SIZING']) assert.match(p.effectRegistry[field].state, /^UNSUPPORTED_/);
  assert.throws(() => sealAdaptiveProcedure({
    parentPolicyDigest: DIGEST('a'), consumerContractDigest: DIGEST('b'), featureRecipeDigest: DIGEST('c'),
    strategyIds: ['ONLY_ONE'], createdTs: T0,
  }), /strategy registry size/);
  assert.throws(() => sealAdaptiveProcedure({
    parentPolicyDigest: DIGEST('a'), consumerContractDigest: DIGEST('b'), featureRecipeDigest: DIGEST('c'),
    strategyIds: ['MOMENTUM', 'PULLBACK'], createdTs: T0, maxPredictionPersistenceDelayMs: 60_001,
  }), /target contract malformed/);
});

test('prediction seals the existing ceil-minute candle-label anchor before its reference price can be known', (t) => {
  const h = harness(t);
  const input = predictionInput(h.procedure, 1);
  input.identity.decisionTs += 12_345;
  input.predictionTs = input.identity.decisionTs;
  input.opportunityId = opportunityIdOf(input.identity);
  h.setNow(input.predictionTs + 100);
  const prediction = h.core.recordPrediction(input).prediction;
  const anchorTs = Math.ceil(input.predictionTs / 60_000) * 60_000;
  assert.equal(prediction.targetEndTs, anchorTs + ADAPTIVE_HORIZON_MS);
  assert.ok(prediction.recordedTs < anchorTs, 'forecast is fixed before the anchor reference close exists');
  assert.equal(Object.hasOwn(prediction, 'referencePrice'), false);
  assert.equal(h.procedure.target.labelRecipeVersion, 'learning-candle-labels-1');
  const wrongRecipe = predictionInput(h.procedure, 500);
  wrongRecipe.featureRecipeDigest = DIGEST('d');
  h.setNow(wrongRecipe.predictionTs + 100);
  assert.throws(() => h.core.recordPrediction(wrongRecipe), /differs from sealed procedure/);
  const delayed = predictionInput(h.procedure, 600);
  h.setNow(delayed.predictionTs + h.procedure.target.maxPredictionPersistenceDelayMs + 1);
  assert.throws(() => h.core.recordPrediction(delayed), /persistence was delayed/);
});

test('saved forecast is scored before one bounded update and changes a later immutable state forecast', (t) => {
  const h = harness(t);
  const firstInput = predictionInput(h.procedure, 1);
  h.setNow(firstInput.predictionTs + 100);
  const first = h.core.recordPrediction(firstInput);
  const momentum = first.prediction.strategyAssessments.find((row) => row.strategyId === 'MOMENTUM');
  assert.equal(momentum.forecastProbability, 0.5);
  assert.equal(momentum.calibration, 'UNCALIBRATED_UNTIL_PROSPECTIVE_EVALUATION');
  assert.equal(first.prediction.modelStateRef.sequence, 0);

  const matured = matureInput(first.prediction);
  h.setNow(matured.knownAtTs);
  const learned = h.core.recordOutcome(matured);
  assert.equal(learned.status, 'UPDATED');
  assert.equal(learned.scores[0].forecastProbability, 0.5);
  assert.equal(learned.scores[0].targetValue, 1);
  assert.equal(learned.scores[0].brierLoss, 0.25);
  assert.equal(learned.update.previousSequence, 0);
  assert.equal(learned.state.sequence, 1);
  assert.ok(learned.state.strategies.find((row) => row.strategyId === 'MOMENTUM').positive60mProbability > 0.5);
  assert.equal(learned.state.strategies.find((row) => row.strategyId === 'PULLBACK').positive60mProbability, 0.5);

  const backdated = predictionInput(h.procedure, 2);
  h.setNow(learned.state.updatedTs + 100);
  assert.throws(() => h.core.recordPrediction(backdated), /state is from the future/);

  const laterInput = predictionInput(h.procedure, 500, { MOMENTUM: 'ELIGIBLE', PULLBACK: 'ELIGIBLE' });
  h.setNow(laterInput.predictionTs + 100);
  const later = h.core.recordPrediction(laterInput).prediction;
  const byId = Object.fromEntries(later.strategyAssessments.map((row) => [row.strategyId, row.forecastProbability]));
  assert.ok(byId.MOMENTUM > byId.PULLBACK, 'later saved probabilities reflect the prior update');
  assert.equal(later.modelStateRef.stateDigest, learned.state.stateDigest);
});

test('primary opportunity/horizon is exactly once across retries, accounts, and variant attempts', (t) => {
  const h = harness(t);
  const input = predictionInput(h.procedure, 2);
  h.setNow(input.predictionTs + 100);
  const saved = h.core.recordPrediction(input).prediction;
  assert.equal(h.core.recordPrediction(input).status, 'EXISTING');
  assert.throws(() => h.core.recordPrediction({ ...input, accountId: 'household-2' }), /PREDICTION_INVALID/);
  assert.throws(() => h.core.recordPrediction({ ...input, variantId: 'COPY-999' }), /PREDICTION_INVALID/);

  const outcome = matureInput(saved);
  h.setNow(outcome.knownAtTs);
  const first = h.core.recordOutcome(outcome);
  const sequence = first.state.sequence;
  h.setNow(outcome.knownAtTs + 50_000);
  const retry = h.core.recordOutcome(outcome);
  assert.equal(retry.status, 'EXISTING');
  assert.equal(h.store.state().sequence, sequence);
  assert.throws(() => h.core.recordOutcome({ ...outcome, logReturnPct: -1 }), /OUTCOME_CONFLICT/);
});

test('future and missing labels never update; valid delayed label updates and over-limit late label is retained without update', (t) => {
  const h = harness(t, { maxLabelDelayMs: 5_000 });
  const pendingInput = predictionInput(h.procedure, 3);
  h.setNow(pendingInput.predictionTs + 100);
  const pendingPrediction = h.core.recordPrediction(pendingInput).prediction;
  assert.throws(() => h.core.recordOutcome({
    opportunityId: 'lop-0000000000000000000000000000000000000000', horizonMs: ADAPTIVE_HORIZON_MS,
    state: 'PENDING', logReturnPct: null, sourceEventTs: null, knownAtTs: null,
    sourceDigest: null, reasonCode: 'HORIZON_NOT_MATURE',
  }), /PREDICTION_NOT_FOUND/);
  const pending = h.core.recordOutcome({
    opportunityId: pendingPrediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
    state: 'PENDING', logReturnPct: null, sourceEventTs: null, knownAtTs: null,
    sourceDigest: null, reasonCode: 'HORIZON_NOT_MATURE',
  });
  assert.equal(pending.status, 'PENDING_NO_DURABLE_OUTCOME');
  assert.equal(h.store.state().sequence, 0);
  assert.throws(() => h.core.recordOutcome({ ...matureInput(pendingPrediction), knownAtTs: pendingPrediction.targetEndTs + 2_000 }), /OUTCOME_INVALID/, 'knownAt in the future is refused');
  h.setNow(pendingPrediction.targetEndTs + 120_000);
  assert.throws(() => h.core.recordOutcome({
    ...matureInput(pendingPrediction), sourceEventTs: pendingPrediction.targetEndTs + 60_000,
    knownAtTs: pendingPrediction.targetEndTs + 120_000,
  }), /OUTCOME_INVALID/, 'a different source horizon cannot be scored as the sealed 60m target');

  const missingInput = predictionInput(h.procedure, 400);
  h.setNow(missingInput.predictionTs + 100);
  const missingPrediction = h.core.recordPrediction(missingInput).prediction;
  h.setNow(missingPrediction.targetEndTs + 1_000);
  const missing = h.core.recordOutcome({
    opportunityId: missingPrediction.opportunityId, horizonMs: ADAPTIVE_HORIZON_MS,
    state: 'MISSING', logReturnPct: null, sourceEventTs: null,
    knownAtTs: missingPrediction.targetEndTs + 1_000, sourceDigest: DIGEST('1'), reasonCode: 'SOURCE_GAP',
  });
  assert.equal(missing.status, 'APPENDED_NO_UPDATE');
  assert.equal(h.store.state().sequence, 0);

  const validInput = predictionInput(h.procedure, 800);
  h.setNow(validInput.predictionTs + 100);
  const validPrediction = h.core.recordPrediction(validInput).prediction;
  const valid = matureInput(validPrediction, { knownDelayMs: 4_999 });
  h.setNow(valid.knownAtTs);
  assert.equal(h.core.recordOutcome(valid).status, 'UPDATED');
  assert.equal(h.store.state().sequence, 1);

  const lateInput = predictionInput(h.procedure, 1_200);
  h.setNow(lateInput.predictionTs + 100);
  const latePrediction = h.core.recordPrediction(lateInput).prediction;
  const late = matureInput(latePrediction, { knownDelayMs: 5_001 });
  h.setNow(late.knownAtTs);
  const lateResult = h.core.recordOutcome(late);
  assert.equal(lateResult.status, 'APPENDED_NO_UPDATE');
  assert.equal(lateResult.reason, 'INELIGIBLE_LATE');
  assert.equal(h.store.state().sequence, 1);
});

test('one primary episode has a hard aggregate influence cap and cap exhaustion is visible', (t) => {
  const h = harness(t, {
    maxEpisodeRankMovementRrPoints: 0.005,
    maxCumulativeRankMovementRrPoints: 0.005,
  });
  const input = predictionInput(h.procedure, 7, { MOMENTUM: 'ELIGIBLE', PULLBACK: 'ELIGIBLE' });
  h.setNow(input.predictionTs + 100);
  const prediction = h.core.recordPrediction(input).prediction;
  const outcome = matureInput(prediction);
  h.setNow(outcome.knownAtTs);
  const result = h.core.recordOutcome(outcome);
  const movement = result.update.deltas.reduce((sum, row) => sum + Math.abs(row.rankDeltaRrPoints), 0);
  assert.ok(movement <= 0.005 + 1e-9);
  assert.equal(result.update.episodeInfluenceAfter, movement);
  assert.equal(result.state.totalRankMovementRrPoints, movement);
  const retry = h.core.recordOutcome(outcome);
  assert.equal(retry.status, 'EXISTING');
  assert.equal(h.core.status().movement.exhausted, true);
});

test('state-only PAPER snapshot cannot self-qualify and exposes all unsupported axes', (t) => {
  const h = harness(t);
  const snapshot = h.core.snapshot({ mode: 'PAPER', nowTs: T0 + 20_000, qualification: { qualified: true, signature: 'looks-trusted' } });
  assert.equal(snapshot.application.enabled, false);
  assert.equal(snapshot.application.authority, 'NONE');
  assert.equal(snapshot.application.qualificationStatus, 'PRESENT_BUT_NOT_VERIFIED_BY_STATE_CORE');
  assert.equal(snapshot.effectRegistry.ENTRY.state, 'UNSUPPORTED_REQUIRES_SEPARATE_REGISTRY_AND_QUALIFICATION');
  assert.equal(snapshot.state.sequence, 0);
  assert.match(snapshot.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => h.core.snapshot({ mode: 'LIVE', nowTs: T0 + 20_000 }), AdaptiveCoreError);
});
