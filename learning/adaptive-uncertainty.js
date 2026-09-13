// SHADOW-ONLY adaptive uncertainty diagnostics. This module has no execution, Judge,
// Watch, paper-account, or activation imports. It defines one numerical target and one
// published online conformal update; it does not turn existing heuristic scores into forecasts.
import {
  canonicalDigest, deepFreeze, isCoin, isPlainObject, isTs,
} from './contracts.js';

export const ADAPTIVE_UNCERTAINTY_VERSION = 'adaptive-uncertainty-shadow-1';
export const SCALE_FREE_OGD_VERSION = 'bhatnagar-et-al-sfogd-algorithm-2-2023';
export const TARGET = deepFreeze({
  kind: 'LOG_RETURN_PERCENT_60M',
  unit: 'PERCENT',
  horizonMs: 60 * 60_000,
  labelRecipeVersion: 'learning-candle-labels-1',
});
export const AUTHORITY = 'NONE';
export const PURPOSE = 'RESEARCH_ONLY';
export const MAX_SCALE_D = 1_000_000;
export const MAX_ABS_FORECAST_PERCENT = 1_000_000;

const nonempty = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n\0]/.test(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const digest64 = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exactKeys = (value, keys) => isPlainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

function sealed(kind, body) {
  const base = { version: ADAPTIVE_UNCERTAINTY_VERSION, kind, ...body };
  return deepFreeze({ ...base, digest: canonicalDigest(base) });
}

export function buildUncertaintyProcedure({ targetCoverage, scaleD, fixedBaselineRadius = null }) {
  if (!finite(targetCoverage) || targetCoverage <= 0 || targetCoverage >= 1) {
    throw new Error('adaptive uncertainty: targetCoverage must be finite and strictly between zero and one');
  }
  if (!finite(scaleD) || scaleD <= 0 || scaleD > MAX_SCALE_D) {
    throw new Error(`adaptive uncertainty: scaleD must be positive, finite, and <= ${MAX_SCALE_D}`);
  }
  if (fixedBaselineRadius !== null
      && (!finite(fixedBaselineRadius) || fixedBaselineRadius < 0 || fixedBaselineRadius > MAX_SCALE_D)) {
    throw new Error('adaptive uncertainty: fixedBaselineRadius must be null (unbounded) or a finite nonnegative declared radius');
  }
  return sealed('PROCEDURE', {
    authority: AUTHORITY,
    purpose: PURPOSE,
    shadowOnly: true,
    target: TARGET,
    pointPredictors: ['SHADOW_ZERO_RETURN_BASELINE', 'EXTERNAL_NUMERIC_FORECAST'],
    adaptiveMethod: {
      id: 'SCALE_FREE_OGD_DIRECT_RADIUS',
      version: SCALE_FREE_OGD_VERSION,
      targetCoverage,
      scaleD,
      initialRadius: 0,
      score: 'ABSOLUTE_RESIDUAL',
      paper: 'BhatnagarEtAl2023Algorithm2',
      officialCodeRelease: 'salesforce/online_conformal@v1.0.2',
    },
    comparator: fixedBaselineRadius === null
      ? { id: 'DECLARED_UNBOUNDED_BASELINE', state: 'UNBOUNDED', radius: null }
      : { id: 'DECLARED_FIXED_RADIUS_BASELINE', state: 'BOUNDED', radius: fixedBaselineRadius },
    delayedFeedbackLaw: 'ISSUE_FORECAST_THEN_SCORE_THEN_UPDATE_CONTIGUOUS_ISSUE_PREFIX',
    statisticalGuarantee: 'NONE_FOR_DELAYED_MISSING_OR_CENSORED_IMPLEMENTATION',
    paperInfluence: false,
    sizingInfluence: false,
    vetoInfluence: false,
  });
}

export function initialScaleFreeOgdState(procedure) {
  assertProcedure(procedure);
  return stateSeal({
    procedureDigest: procedure.digest,
    revision: 0,
    updateCount: 0,
    radius: procedure.adaptiveMethod.initialRadius,
    gradientNormSquared: 0,
    boundAssumptionViolations: 0,
  });
}

function stateSeal(body) {
  return sealed('SCALE_FREE_OGD_STATE', body);
}

export function assertProcedure(procedure) {
  if (!isPlainObject(procedure) || procedure.kind !== 'PROCEDURE'
      || procedure.version !== ADAPTIVE_UNCERTAINTY_VERSION
      || procedure.authority !== AUTHORITY || procedure.purpose !== PURPOSE
      || procedure.shadowOnly !== true || procedure.target?.kind !== TARGET.kind
      || procedure.target?.horizonMs !== TARGET.horizonMs
      || procedure.adaptiveMethod?.id !== 'SCALE_FREE_OGD_DIRECT_RADIUS'
      || procedure.adaptiveMethod?.version !== SCALE_FREE_OGD_VERSION
      || !finite(procedure.adaptiveMethod?.targetCoverage)
      || procedure.adaptiveMethod.targetCoverage <= 0 || procedure.adaptiveMethod.targetCoverage >= 1
      || !finite(procedure.adaptiveMethod?.scaleD)
      || procedure.adaptiveMethod.scaleD <= 0 || procedure.adaptiveMethod.scaleD > MAX_SCALE_D
      || !['BOUNDED', 'UNBOUNDED'].includes(procedure.comparator?.state)
      || (procedure.comparator.state === 'BOUNDED'
        && (!finite(procedure.comparator.radius) || procedure.comparator.radius < 0 || procedure.comparator.radius > MAX_SCALE_D))
      || (procedure.comparator.state === 'UNBOUNDED' && procedure.comparator.radius !== null)
      || procedure.statisticalGuarantee !== 'NONE_FOR_DELAYED_MISSING_OR_CENSORED_IMPLEMENTATION'
      || procedure.digest !== canonicalDigest(Object.fromEntries(Object.entries(procedure).filter(([key]) => key !== 'digest')))) {
    throw new Error('adaptive uncertainty: invalid or altered procedure');
  }
  return procedure;
}

export function assertScaleFreeOgdState(state, procedure) {
  assertProcedure(procedure);
  if (!isPlainObject(state) || state.kind !== 'SCALE_FREE_OGD_STATE'
      || state.version !== ADAPTIVE_UNCERTAINTY_VERSION
      || state.procedureDigest !== procedure.digest
      || !Number.isSafeInteger(state.revision) || state.revision < 0
      || !Number.isSafeInteger(state.updateCount) || state.updateCount < 0
      || state.revision !== state.updateCount
      || !finite(state.radius) || state.radius < 0
      || !finite(state.gradientNormSquared) || state.gradientNormSquared < 0
      || !Number.isSafeInteger(state.boundAssumptionViolations) || state.boundAssumptionViolations < 0
      || state.digest !== canonicalDigest(Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'digest')))) {
    throw new Error('adaptive uncertainty: invalid or altered Scale-Free OGD state');
  }
  return state;
}

function normalizePredictor(predictor, informationCutoffTs) {
  if (!isPlainObject(predictor)) throw new Error('adaptive uncertainty: predictor contract required');
  if (predictor.kind === 'SHADOW_ZERO_RETURN_BASELINE') {
    if (!exactKeys(predictor, ['kind'])) throw new Error('adaptive uncertainty: zero baseline has no caller-supplied score/value');
    return {
      kind: predictor.kind,
      value: 0,
      predictorVersion: 'shadow-zero-log-return-percent-1',
      predictorStateDigest: canonicalDigest({ kind: predictor.kind, value: 0, target: TARGET }),
      knownAtTs: informationCutoffTs,
      claim: 'EXPLICIT_NEW_NULL_PREDICTOR_NOT_MARKET_ALPHA',
    };
  }
  if (predictor.kind !== 'EXTERNAL_NUMERIC_FORECAST'
      || !exactKeys(predictor, ['kind', 'value', 'predictorVersion', 'predictorStateDigest', 'knownAtTs'])) {
    throw new Error('adaptive uncertainty: only the explicit zero baseline or an exact external numeric forecast is accepted');
  }
  if (!finite(predictor.value) || Math.abs(predictor.value) > MAX_ABS_FORECAST_PERCENT
      || !nonempty(predictor.predictorVersion) || !digest64(predictor.predictorStateDigest)
      || !isTs(predictor.knownAtTs) || predictor.knownAtTs > informationCutoffTs) {
    throw new Error('adaptive uncertainty: external numeric forecast is malformed or not known by the information cutoff');
  }
  return { ...predictor, claim: 'CALLER_SUPPLIED_NUMERIC_FORECAST_NO_ALPHA_CLAIM' };
}

export function intervalOf(point, radius) {
  if (!finite(point) || Math.abs(point) > MAX_ABS_FORECAST_PERCENT) throw new Error('adaptive uncertainty: invalid point forecast');
  if (radius === null) return deepFreeze({ state: 'UNBOUNDED', lower: null, upper: null, radius: null, width: null });
  if (!finite(radius) || radius < 0) throw new Error('adaptive uncertainty: invalid interval radius');
  const lower = point - radius;
  const upper = point + radius;
  if (!finite(lower) || !finite(upper)) throw new Error('adaptive uncertainty: interval bounds are non-finite; refusing instead of clipping');
  return deepFreeze({ state: 'BOUNDED', lower, upper, radius, width: 2 * radius });
}

export function buildShadowForecast({ procedure, state, input, issuedTs, issueSequence }) {
  assertProcedure(procedure);
  assertScaleFreeOgdState(state, procedure);
  const required = ['opportunityId', 'episodeId', 'canonicalCoin', 'catalogContentId', 'catalogDigest', 'decisionTs', 'informationCutoffTs', 'horizonEndTs', 'predictor'];
  if (!exactKeys(input, required) || !nonempty(input.opportunityId) || !nonempty(input.episodeId)
      || !isCoin(input.canonicalCoin) || !nonempty(input.catalogContentId) || !digest64(input.catalogDigest)
      || !isTs(input.decisionTs) || !isTs(input.informationCutoffTs) || !isTs(input.horizonEndTs)
      || input.informationCutoffTs > input.decisionTs
      || input.horizonEndTs - input.decisionTs !== TARGET.horizonMs
      || !isTs(issuedTs) || issuedTs < input.decisionTs
      || !Number.isSafeInteger(issueSequence) || issueSequence <= 0) {
    throw new Error('adaptive uncertainty: forecast identity/clocks/60-minute target are malformed');
  }
  const predictor = normalizePredictor(input.predictor, input.informationCutoffTs);
  const adaptiveInterval = intervalOf(predictor.value, state.radius);
  const comparatorInterval = intervalOf(predictor.value, procedure.comparator.radius);
  const body = {
    authority: AUTHORITY,
    purpose: PURPOSE,
    shadowOnly: true,
    issueSequence,
    opportunityId: input.opportunityId,
    episodeId: input.episodeId,
    canonicalCoin: input.canonicalCoin,
    catalogContentId: input.catalogContentId,
    catalogDigest: input.catalogDigest,
    decisionTs: input.decisionTs,
    informationCutoffTs: input.informationCutoffTs,
    issuedTs,
    horizonEndTs: input.horizonEndTs,
    target: TARGET,
    predictor,
    sourceInputDigest: canonicalDigest(input),
    procedureDigest: procedure.digest,
    calibratorStateDigest: state.digest,
    calibratorRevision: state.revision,
    adaptiveInterval,
    comparatorInterval,
    learningEligible: false,
    paperInfluence: false,
  };
  const forecastId = `auf-${canonicalDigest(body).slice(0, 40)}`;
  return sealed('FORECAST', { forecastId, ...body });
}

function intervalMetrics(interval, target, alpha) {
  if (interval.state === 'UNBOUNDED') {
    return { state: 'UNBOUNDED', covered: true, width: null, intervalScore: null };
  }
  const below = target < interval.lower;
  const above = target > interval.upper;
  const penalty = below ? (2 / alpha) * (interval.lower - target)
    : above ? (2 / alpha) * (target - interval.upper) : 0;
  return { state: 'BOUNDED', covered: !below && !above, width: interval.width, intervalScore: interval.width + penalty };
}

function normalizeOutcome(outcome, forecast) {
  if (!isPlainObject(outcome) || !['KNOWN', 'CENSORED', 'UNAVAILABLE'].includes(outcome.status)
      || outcome.targetKind !== TARGET.kind || outcome.labelRecipeVersion !== TARGET.labelRecipeVersion
      || !digest64(outcome.labelDigest) || !isTs(outcome.outcomeKnownAtTs)
      || outcome.outcomeKnownAtTs < forecast.horizonEndTs) {
    throw new Error('adaptive uncertainty: terminal 60-minute outcome is malformed or premature');
  }
  if (outcome.status === 'KNOWN') {
    if (!exactKeys(outcome, ['status', 'targetKind', 'value', 'outcomeKnownAtTs', 'labelRecipeVersion', 'labelDigest'])
        || !finite(outcome.value) || Math.abs(outcome.value) > MAX_ABS_FORECAST_PERCENT) {
      throw new Error('adaptive uncertainty: known outcome must contain one bounded finite numerical target');
    }
    return { ...outcome };
  }
  if (!exactKeys(outcome, ['status', 'targetKind', 'reasonCode', 'outcomeKnownAtTs', 'labelRecipeVersion', 'labelDigest'])
      || !nonempty(outcome.reasonCode)) {
    throw new Error('adaptive uncertainty: censored/unavailable outcome requires an explicit reason and no numeric substitute');
  }
  return { ...outcome };
}

export function scoreShadowForecast({ procedure, forecast, outcome, scoredTs }) {
  assertProcedure(procedure);
  if (!isPlainObject(forecast) || forecast.kind !== 'FORECAST' || forecast.procedureDigest !== procedure.digest
      || forecast.digest !== canonicalDigest(Object.fromEntries(Object.entries(forecast).filter(([key]) => key !== 'digest')))) {
    throw new Error('adaptive uncertainty: altered or incompatible forecast');
  }
  const normalized = normalizeOutcome(outcome, forecast);
  if (!isTs(scoredTs) || scoredTs < normalized.outcomeKnownAtTs) throw new Error('adaptive uncertainty: score time precedes outcome knowledge');
  if (normalized.status !== 'KNOWN') {
    return sealed('SCORE', {
      forecastId: forecast.forecastId,
      forecastDigest: forecast.digest,
      procedureDigest: procedure.digest,
      issueSequence: forecast.issueSequence,
      scoredTs,
      target: normalized,
      residual: null,
      adaptive: null,
      comparator: null,
      updateEligible: false,
      updateReason: normalized.status,
      paperInfluence: false,
    });
  }
  const residual = Math.abs(normalized.value - forecast.predictor.value);
  if (!finite(residual)) throw new Error('adaptive uncertainty: residual is non-finite');
  const alpha = 1 - procedure.adaptiveMethod.targetCoverage;
  return sealed('SCORE', {
    forecastId: forecast.forecastId,
    forecastDigest: forecast.digest,
    procedureDigest: procedure.digest,
    issueSequence: forecast.issueSequence,
    scoredTs,
    target: normalized,
    residual,
    adaptive: intervalMetrics(forecast.adaptiveInterval, normalized.value, alpha),
    comparator: intervalMetrics(forecast.comparatorInterval, normalized.value, alpha),
    updateEligible: true,
    updateReason: 'KNOWN_TARGET',
    paperInfluence: false,
  });
}

export function updateScaleFreeOgd({ procedure, state, score }) {
  assertProcedure(procedure);
  assertScaleFreeOgdState(state, procedure);
  if (!isPlainObject(score) || score.kind !== 'SCORE' || score.version !== ADAPTIVE_UNCERTAINTY_VERSION
      || score.procedureDigest !== procedure.digest
      || score.digest !== canonicalDigest(Object.fromEntries(Object.entries(score).filter(([key]) => key !== 'digest')))) {
    throw new Error('adaptive uncertainty: invalid score');
  }
  if (!score.updateEligible) {
    return { state, applied: false, reason: score.updateReason, gradient: null, boundAssumptionViolated: false };
  }
  if (!finite(score.residual) || score.residual < 0) throw new Error('adaptive uncertainty: update residual is invalid');
  const coverage = procedure.adaptiveMethod.targetCoverage;
  // Salesforce online_conformal v1.0.2 utils.pinball_loss_grad(abs(residual), delta, coverage).
  const gradient = score.residual > state.radius ? -coverage
    : score.residual < state.radius ? 1 - coverage : 0;
  const gradientNormSquared = state.gradientNormSquared + gradient ** 2;
  let radius = state.radius;
  if (gradientNormSquared !== 0) {
    radius = Math.max(0, state.radius
      - (procedure.adaptiveMethod.scaleD / Math.sqrt(3 * gradientNormSquared)) * gradient);
  }
  if (!finite(radius) || !finite(gradientNormSquared)) {
    throw new Error('adaptive uncertainty: Scale-Free OGD numeric state overflow; refusing instead of clipping');
  }
  const violated = score.residual > procedure.adaptiveMethod.scaleD;
  const next = stateSeal({
    procedureDigest: procedure.digest,
    revision: state.revision + 1,
    updateCount: state.updateCount + 1,
    radius,
    gradientNormSquared,
    boundAssumptionViolations: state.boundAssumptionViolations + (violated ? 1 : 0),
  });
  return { state: next, applied: true, reason: 'KNOWN_TARGET', gradient, boundAssumptionViolated: violated };
}

export function summarizeUncertaintyScores(scores) {
  if (!Array.isArray(scores)) throw new Error('adaptive uncertainty: scores must be an array');
  const known = scores.filter((score) => score?.kind === 'SCORE' && score.updateEligible === true);
  const boundedAdaptive = known.filter((score) => score.adaptive?.state === 'BOUNDED');
  const boundedComparator = known.filter((score) => score.comparator?.state === 'BOUNDED');
  const aggregate = (rows, field) => rows.length === 0 ? {
    support: 0, empiricalCoverage: null, meanWidth: null, meanIntervalScore: null,
  } : {
    support: rows.length,
    empiricalCoverage: rows.filter((row) => row[field].covered).length / rows.length,
    meanWidth: rows.reduce((sum, row) => sum + row[field].width, 0) / rows.length,
    meanIntervalScore: rows.reduce((sum, row) => sum + row[field].intervalScore, 0) / rows.length,
  };
  return deepFreeze({
    authority: AUTHORITY,
    purpose: PURPOSE,
    knownSupport: known.length,
    missingOrCensored: scores.length - known.length,
    adaptive: aggregate(boundedAdaptive, 'adaptive'),
    comparator: aggregate(boundedComparator, 'comparator'),
    guarantee: 'DESCRIPTIVE_ONLY_NO_DELAYED_OR_MISSING_LABEL_COVERAGE_GUARANTEE',
    profitGuarantee: false,
  });
}
