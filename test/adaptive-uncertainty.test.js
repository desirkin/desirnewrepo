import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SCALE_FREE_OGD_VERSION,
  MAX_FORECAST_PERSISTENCE_LAG_MS,
  TARGET,
  buildShadowForecast,
  buildUncertaintyProcedure,
  initialScaleFreeOgdState,
  intervalOf,
  scoreShadowForecast,
  summarizeUncertaintyScores,
  targetHorizonEndTs,
  updateScaleFreeOgd,
} from '../learning/adaptive-uncertainty.js';
import { openAdaptiveUncertaintyStore } from '../learning/adaptive-uncertainty-store.js';
import { canonicalDigest } from '../learning/contracts.js';

const BASE_TS = 1_800_000_000_000;
const digest = (tag) => canonicalDigest({ tag });
const procedure = (fixedBaselineRadius = 1.5) => buildUncertaintyProcedure({
  targetCoverage: 0.9,
  scaleD: 5,
  fixedBaselineRadius,
});
const inputAt = (tag, decisionTs, predictor = { kind: 'SHADOW_ZERO_RETURN_BASELINE' }) => ({
  opportunityId: 'opp-' + tag,
  episodeId: 'episode-' + tag,
  canonicalCoin: Number.parseInt(String(tag).replace(/\D/g, ''), 10) % 2 ? 'BTC' : 'ETH',
  catalogContentId: 'catalog-epoch-1',
  catalogDigest: digest('catalog'),
  decisionTs,
  informationCutoffTs: decisionTs,
  horizonEndTs: targetHorizonEndTs(decisionTs),
  predictor,
});
const input = (n, predictor = { kind: 'SHADOW_ZERO_RETURN_BASELINE' }) => ({
  ...inputAt(n, BASE_TS + n * 10_000, predictor),
  opportunityId: 'opp-' + n,
  episodeId: 'episode-' + n,
  canonicalCoin: n % 2 ? 'BTC' : 'ETH',
});
const knownOutcome = (forecast, value) => ({
  status: 'KNOWN',
  targetKind: TARGET.kind,
  value,
  outcomeKnownAtTs: forecast.horizonEndTs + 1,
  labelRecipeVersion: TARGET.labelRecipeVersion,
  labelDigest: digest('label-' + forecast.forecastId + '-' + value),
});
const makeClock = (start = BASE_TS + 10_000_000) => {
  let now = start;
  const clock = () => { now += 1; return now; };
  clock.set = (next) => { if (!Number.isSafeInteger(next) || next < now) throw new Error('test clock regression'); now = next; };
  return clock;
};
const temp = () => mkdtempSync(path.join(tmpdir(), 'adaptive-uncertainty-'));

test('R01 procedure freezes one explicit numerical target and carries no behavioral authority', () => {
  const p = procedure();
  assert.equal(p.target.kind, 'LOG_RETURN_PERCENT_60M');
  assert.equal(p.target.horizonMs, 3_600_000);
  assert.equal(p.target.referenceAnchor, 'CEIL_DECISION_TO_1M_CANDLE_CLOSE');
  assert.equal(MAX_FORECAST_PERSISTENCE_LAG_MS, 5_000);
  assert.equal(targetHorizonEndTs(BASE_TS + 10_001), BASE_TS + 60_000 + 3_600_000);
  assert.equal(p.adaptiveMethod.version, SCALE_FREE_OGD_VERSION);
  assert.equal(p.authority, 'NONE');
  assert.equal(p.purpose, 'RESEARCH_ONLY');
  assert.equal(p.paperInfluence, false);
  assert.equal(p.sizingInfluence, false);
  assert.equal(p.statisticalGuarantee, 'NONE_FOR_DELAYED_MISSING_OR_CENSORED_IMPLEMENTATION');
  assert.throws(() => buildUncertaintyProcedure({ targetCoverage: 1, scaleD: 5 }), /targetCoverage/);
  assert.throws(() => buildUncertaintyProcedure({ targetCoverage: 0.9, scaleD: Infinity }), /scaleD/);
});

test('R02 zero-return baseline is explicit; heuristic scores and loose external values are refused', () => {
  const p = procedure();
  const state = initialScaleFreeOgdState(p);
  const f = buildShadowForecast({ procedure: p, state, input: input(1), issuedTs: input(1).decisionTs + 1, issueSequence: 1 });
  assert.equal(f.predictor.value, 0);
  assert.equal(f.predictor.claim, 'EXPLICIT_NEW_NULL_PREDICTOR_NOT_MARKET_ALPHA');
  assert.equal(f.learningEligible, false);
  assert.throws(() => buildShadowForecast({
    procedure: p, state,
    input: input(2, { kind: 'SHADOW_ZERO_RETURN_BASELINE', baselineScore: 9.2 }),
    issuedTs: input(2).decisionTs + 1, issueSequence: 1,
  }), /no caller-supplied score/);
  assert.throws(() => buildShadowForecast({
    procedure: p, state,
    input: input(2, { kind: 'HEURISTIC_SETUP_SCORE', value: 9.2 }),
    issuedTs: input(2).decisionTs + 1, issueSequence: 1,
  }), /only the explicit zero baseline/);
  assert.throws(() => buildShadowForecast({
    procedure: p, state,
    input: { ...input(2), horizonEndTs: input(2).horizonEndTs + 1 },
    issuedTs: input(2).decisionTs + 1, issueSequence: 1,
  }), /60-minute target/);
});

test('R03 external numeric forecast binds version, state digest, and point-in-time knowledge', () => {
  const p = procedure();
  const state = initialScaleFreeOgdState(p);
  const external = {
    kind: 'EXTERNAL_NUMERIC_FORECAST', value: -0.25, predictorVersion: 'external-model-7',
    predictorStateDigest: digest('model-state'), knownAtTs: input(3).informationCutoffTs,
  };
  const f = buildShadowForecast({ procedure: p, state, input: input(3, external), issuedTs: input(3).decisionTs + 1, issueSequence: 1 });
  assert.equal(f.predictor.value, -0.25);
  assert.equal(f.predictor.predictorVersion, 'external-model-7');
  assert.throws(() => buildShadowForecast({
    procedure: p, state,
    input: input(3, { ...external, knownAtTs: input(3).informationCutoffTs + 1 }),
    issuedTs: input(3).decisionTs + 1, issueSequence: 1,
  }), /not known by the information cutoff/);
  assert.throws(() => buildShadowForecast({
    procedure: p, state,
    input: input(3, { ...external, value: Number.NaN }),
    issuedTs: input(3).decisionTs + 1, issueSequence: 1,
  }), /malformed/);
});

test('R03b late issue and backdated learned state are refused', () => {
  const p = procedure();
  const initial = initialScaleFreeOgdState(p);
  const firstInput = inputAt('custody-first', BASE_TS + 50_000);
  assert.throws(() => buildShadowForecast({
    procedure: p, state: initial, input: firstInput,
    issuedTs: firstInput.decisionTs + MAX_FORECAST_PERSISTENCE_LAG_MS + 1, issueSequence: 1,
  }), /malformed or late/);
  assert.throws(() => buildShadowForecast({
    procedure: p, state: initial, input: firstInput,
    issuedTs: firstInput.horizonEndTs, issueSequence: 1,
  }), /malformed or late/);

  const first = buildShadowForecast({
    procedure: p, state: initial, input: firstInput, issuedTs: firstInput.decisionTs + 1, issueSequence: 1,
  });
  const firstScore = scoreShadowForecast({
    procedure: p, forecast: first, outcome: knownOutcome(first, 1), scoredTs: first.horizonEndTs + 2,
  });
  const learned = updateScaleFreeOgd({
    procedure: p, state: initial, score: firstScore, appliedTs: firstScore.scoredTs + 1,
  }).state;
  const backdatedInput = inputAt('backdated-after-learning', learned.availableAtTs - 1_000);
  assert.throws(() => buildShadowForecast({
    procedure: p, state: learned, input: backdatedInput,
    issuedTs: backdatedInput.decisionTs + 1, issueSequence: 2,
  }), /state availability/);
});

test('R04 Scale-Free OGD is in parity with Salesforce online_conformal v1.0.2', () => {
  // Frozen from online_conformal/ogd.py ScaleFreeOGD and utils.py pinball_loss_grad:
  // grad=-q*(s>delta)+(1-q)*(s<delta); G+=grad^2;
  // delta=max(0,delta-D/sqrt(3G)*grad). q=.9, D=5, initial delta=0.
  const residuals = [0, 1, 0.5, 2, 0.25, 3, 3, 0, 1.5];
  const expectedAfter = [
    0, 2.886751345948129, 2.56796298941646, 2.251100864154221,
    1.9361304699798652, 3.958730057369591, 3.7346746998954807,
    3.5112911740910957, 3.2885734724974087,
  ];
  const p = procedure();
  let state = initialScaleFreeOgdState(p);
  residuals.forEach((residual, index) => {
    const request = inputAt(`parity-${index}`, state.availableAtTs === null ? BASE_TS + 100_000 : state.availableAtTs + 1_000);
    const f = buildShadowForecast({ procedure: p, state, input: request, issuedTs: request.decisionTs + 1, issueSequence: index + 1 });
    const score = scoreShadowForecast({ procedure: p, forecast: f, outcome: knownOutcome(f, residual), scoredTs: f.horizonEndTs + 2 });
    const result = updateScaleFreeOgd({ procedure: p, state, score, appliedTs: score.scoredTs + 1 });
    state = result.state;
    assert.ok(Math.abs(state.radius - expectedAfter[index]) < 1e-12, String(index) + ': ' + state.radius);
  });
  assert.equal(state.updateCount, residuals.length);
});

test('R05 interval scoring is proper and an unbounded comparator stays unbounded, never clipped', () => {
  assert.deepEqual(intervalOf(0, 1), { state: 'BOUNDED', lower: -1, upper: 1, radius: 1, width: 2 });
  assert.deepEqual(intervalOf(0, null), { state: 'UNBOUNDED', lower: null, upper: null, radius: null, width: null });
  const p = procedure(null);
  const state = initialScaleFreeOgdState(p);
  const f = buildShadowForecast({ procedure: p, state, input: input(30), issuedTs: input(30).decisionTs + 1, issueSequence: 1 });
  const score = scoreShadowForecast({ procedure: p, forecast: f, outcome: knownOutcome(f, 2), scoredTs: f.horizonEndTs + 2 });
  assert.ok(Math.abs(score.adaptive.intervalScore - 40) < 1e-12);
  assert.equal(score.comparator.state, 'UNBOUNDED');
  assert.equal(score.comparator.width, null);
  assert.equal(score.comparator.intervalScore, null);
});

test('R06 out-of-D residual is recorded without clipping; censored labels never update', () => {
  const p = procedure();
  let state = initialScaleFreeOgdState(p);
  const f = buildShadowForecast({ procedure: p, state, input: input(40), issuedTs: input(40).decisionTs + 1, issueSequence: 1 });
  const score = scoreShadowForecast({ procedure: p, forecast: f, outcome: knownOutcome(f, 8), scoredTs: f.horizonEndTs + 2 });
  const result = updateScaleFreeOgd({ procedure: p, state, score, appliedTs: score.scoredTs + 1 });
  assert.equal(score.residual, 8);
  assert.equal(result.boundAssumptionViolated, true);
  assert.equal(result.state.boundAssumptionViolations, 1);
  assert.notEqual(result.state.radius, 5, 'the observed radius must not be clipped to declared D');
  state = result.state;

  const secondInput = inputAt('censored-after-known', state.availableAtTs + 1_000);
  const f2 = buildShadowForecast({ procedure: p, state, input: secondInput, issuedTs: secondInput.decisionTs + 1, issueSequence: 2 });
  const censored = {
    status: 'CENSORED', targetKind: TARGET.kind, reasonCode: 'PATH_GAP',
    outcomeKnownAtTs: f2.horizonEndTs + 1, labelRecipeVersion: TARGET.labelRecipeVersion,
    labelDigest: digest('censored'),
  };
  const score2 = scoreShadowForecast({ procedure: p, forecast: f2, outcome: censored, scoredTs: f2.horizonEndTs + 2 });
  const skipped = updateScaleFreeOgd({ procedure: p, state, score: score2, appliedTs: score2.scoredTs + 1 });
  assert.equal(score2.residual, null);
  assert.equal(skipped.applied, false);
  assert.equal(skipped.state.digest, state.digest);
  assert.throws(() => scoreShadowForecast({
    procedure: p, forecast: f2, outcome: { ...knownOutcome(f2, 1), value: Infinity }, scoredTs: f2.horizonEndTs + 2,
  }), /finite numerical target/);
  assert.throws(() => scoreShadowForecast({
    procedure: p, forecast: f2,
    outcome: { ...knownOutcome(f2, 1), outcomeKnownAtTs: f2.horizonEndTs + 50 },
    scoredTs: f2.horizonEndTs + 2,
  }), /precedes outcome knowledge/);
  const otherProcedure = buildUncertaintyProcedure({ targetCoverage: 0.8, scaleD: 5, fixedBaselineRadius: 1.5 });
  assert.throws(() => updateScaleFreeOgd({ procedure: otherProcedure, state: initialScaleFreeOgdState(otherProcedure), score, appliedTs: score.scoredTs + 1 }), /invalid score/);
});

test('R07 store saves forecast before label and applies delayed scores only in issue order', () => {
  const dir = temp();
  try {
    const p = procedure();
    const clock = makeClock(input(50).decisionTs);
    const store = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock });
    const first = store.issueForecast(input(50));
    clock.set(input(51).decisionTs);
    const second = store.issueForecast(input(51));
    clock.set(second.horizonEndTs + 10);
    store.recordOutcome({ forecastId: second.forecastId, outcome: knownOutcome(second, 2) });
    assert.equal(store.applyReadyUpdates(), 0);
    assert.equal(store.status().updates, 0);
    assert.equal(store.status().blockedOnForecastId, first.forecastId);

    const settled = store.settleForecast({ forecastId: first.forecastId, outcome: knownOutcome(first, 1) });
    assert.equal(settled.appliedCount, 2);
    const snap = store.snapshot();
    assert.deepEqual([...snap.updates.values?.() ?? snap.updates].map((u) => u.issueSequence), [1, 2]);
    assert.equal(snap.calibratorState.updateCount, 2);

    const journal = readFileSync(path.join(dir, 'adaptive-uncertainty-shadow', 'journal.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const kinds = journal.map((row) => row.kind);
    assert.deepEqual(kinds, ['FORECAST', 'FORECAST', 'SCORE', 'SCORE', 'UPDATE', 'UPDATE']);
    assert.ok(journal.findIndex((row) => row.kind === 'SCORE') < journal.findIndex((row) => row.kind === 'UPDATE'));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R08 missing first label head-of-line blocks future feedback rather than imputing or reordering', () => {
  const dir = temp();
  try {
    const p = procedure();
    const clock = makeClock(input(60).decisionTs);
    const store = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock });
    const first = store.issueForecast(input(60));
    clock.set(input(61).decisionTs);
    const second = store.issueForecast(input(61));
    clock.set(second.horizonEndTs + 10);
    store.recordOutcome({ forecastId: second.forecastId, outcome: knownOutcome(second, 4) });
    assert.equal(store.status().blockedOnForecastId, first.forecastId);
    assert.equal(store.status().calibratorState.updateCount, 0);
    assert.equal(store.status().guarantee, 'NONE_FOR_DELAYED_MISSING_OR_CENSORED_IMPLEMENTATION');
    assert.equal(store.status().authority, 'NONE');
    assert.equal(store.status().paperInfluence, false);
    assert.equal(store.status().republishSafe, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R09 primary opportunity is account-independent and exact retries are idempotent', () => {
  const dir = temp();
  try {
    const p = procedure();
    const store = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock(input(70).decisionTs) });
    const request = input(70);
    const first = store.issueForecast(request);
    const retry = store.issueForecast(request);
    assert.equal(retry.forecastId, first.forecastId);
    assert.equal(store.status().forecasts, 1);
    assert.throws(() => store.issueForecast({ ...request, episodeId: 'account-specific-variant' }), /cannot be duplicated/);
    assert.throws(() => store.issueForecast({ ...request, accountId: 'David' }), /cannot be duplicated/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R10 exact outcome retry is idempotent, conflicting labels are rejected, and graceful replay is exact', () => {
  const dir = temp();
  const p = procedure();
  try {
    const clock = makeClock(input(80).decisionTs);
    const store = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock });
    const forecast = store.issueForecast(input(80));
    clock.set(forecast.horizonEndTs + 10);
    const outcome = knownOutcome(forecast, 1.25);
    const first = store.settleForecast({ forecastId: forecast.forecastId, outcome });
    const retry = store.settleForecast({ forecastId: forecast.forecastId, outcome });
    assert.equal(retry.score.digest, first.score.digest);
    assert.equal(store.status().updates, 1);
    assert.throws(() => store.settleForecast({ forecastId: forecast.forecastId, outcome: knownOutcome(forecast, 9) }), /conflicting outcome/);
    const stateDigest = store.status().calibratorState.digest;
    store.close();

    const reopened = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock(BASE_TS + 20_000_000) });
    assert.equal(reopened.status().calibratorState.digest, stateDigest);
    assert.equal(reopened.status().updates, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R11 a writer lock is never taken over by age and corrupt/partial journals fail closed', () => {
  const dir = temp();
  const p = procedure();
  try {
    const store = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock(input(90).decisionTs) });
    store.issueForecast(input(90));
    assert.throws(() => openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock() }), /EEXIST|exist/i);
    store.close();
    const journal = path.join(dir, 'adaptive-uncertainty-shadow', 'journal.jsonl');
    appendFileSync(journal, '{"partial":', 'utf8');
    assert.throws(() => openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock() }), /partial journal tail/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R12 manifest and head prevent procedure substitution and suffix truncation', () => {
  const dir = temp();
  try {
    const p = procedure();
    const store = openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock(input(100).decisionTs) });
    store.issueForecast(input(100));
    store.close();
    assert.throws(() => openAdaptiveUncertaintyStore({
      dataDir: dir,
      procedure: buildUncertaintyProcedure({ targetCoverage: 0.8, scaleD: 5, fixedBaselineRadius: 1.5 }),
      clock: makeClock(),
    }), /manifest mismatch/);

    const journal = path.join(dir, 'adaptive-uncertainty-shadow', 'journal.jsonl');
    writeFileSync(journal, '', 'utf8');
    assert.throws(() => openAdaptiveUncertaintyStore({ dataDir: dir, procedure: p, clock: makeClock() }), /truncation\/head mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R13 diagnostics report support/width/interval score without profit or conditional claims', () => {
  const p = procedure();
  const state = initialScaleFreeOgdState(p);
  const forecasts = [110, 111].map((n, i) => buildShadowForecast({
    procedure: p, state, input: input(n), issuedTs: input(n).decisionTs + 1, issueSequence: i + 1,
  }));
  const scores = forecasts.map((forecast, i) => scoreShadowForecast({
    procedure: p, forecast, outcome: knownOutcome(forecast, i ? 3 : 0), scoredTs: forecast.horizonEndTs + 2,
  }));
  const summary = summarizeUncertaintyScores(scores);
  assert.equal(summary.adaptive.support, 2);
  assert.equal(summary.adaptive.empiricalCoverage, 0.5);
  assert.equal(summary.adaptive.meanWidth, 0);
  assert.ok(Math.abs(summary.adaptive.meanIntervalScore - 30) < 1e-12);
  assert.equal(summary.comparator.empiricalCoverage, 0.5);
  assert.equal(summary.profitGuarantee, false);
  assert.match(summary.guarantee, /NONE|DELAYED/);
});
