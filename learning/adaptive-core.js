// Orchestrates saved forecasts, delayed outcome scoring, and exactly-once
// bounded state updates. This core is deliberately state-only: it never grants
// its own PAPER qualification and has no Judge, account, order, or provider
// dependency.
import { canonicalDigest, deepFreeze, exactKeys, isPlainObject, isTs } from './contracts.js';
import {
  ADAPTIVE_EFFECT_REGISTRY, ADAPTIVE_HORIZON_MS, ADAPTIVE_SNAPSHOT_VERSION,
  adaptiveProcedureError, applyAdaptiveUpdate, buildAdaptiveOutcome,
  buildAdaptivePrediction, scoreAdaptiveOutcome,
} from './adaptive-registry.js';
import {
  adaptiveCandleOutcomeSubmissionError,
  adaptiveCandleSettlementError,
} from './adaptive-candle-outcome.js';

export const ADAPTIVE_CORE_VERSION = 'adaptive-core-2';
export const ADAPTIVE_CORE_MODES = Object.freeze(['SHADOW', 'OBSERVE', 'PAPER']);

const PREDICTION_INPUT_KEYS = Object.freeze([
  'opportunityId', 'identity', 'catalogContentId', 'predictionTs', 'horizonMs',
  'featureRecipeDigest', 'factsDigest', 'strategyAssessments', 'selection',
]);
const OUTCOME_INPUT_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'state', 'logReturnPct', 'sourceEventTs',
  'knownAtTs', 'sourceDigest', 'reasonCode',
]);
const PENDING_INPUT_KEYS = OUTCOME_INPUT_KEYS;
const OUTCOME_SUBMISSION_KEYS = Object.freeze(['outcomeInput', 'provenanceReceipt']);

export class AdaptiveCoreError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${String(detail).slice(0, 500)}` : code);
    this.name = 'AdaptiveCoreError';
    this.code = code;
  }
}

const fail = (code, detail) => { throw new AdaptiveCoreError(code, detail); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => canonicalDigest(a) === canonicalDigest(b);

function predictionInputProjection(prediction) {
  return {
    opportunityId: prediction.opportunityId,
    identity: prediction.identity,
    catalogContentId: prediction.catalogContentId,
    predictionTs: prediction.predictionTs,
    horizonMs: prediction.horizonMs,
    featureRecipeDigest: prediction.featureRecipeDigest,
    factsDigest: prediction.factsDigest,
    strategyAssessments: prediction.strategyAssessments.map((row) => ({
      strategyId: row.strategyId, eligibility: row.eligibility, reasonCode: row.reasonCode,
    })),
    selection: prediction.selection,
  };
}

function outcomeInputProjection(outcome) {
  return {
    opportunityId: outcome.opportunityId,
    horizonMs: outcome.horizonMs,
    state: outcome.state,
    logReturnPct: outcome.logReturnPct,
    sourceEventTs: outcome.sourceEventTs,
    knownAtTs: outcome.knownAtTs,
    sourceDigest: outcome.sourceDigest,
    reasonCode: outcome.reasonCode,
  };
}

function storeError(store) {
  const required = [
    'procedure', 'state', 'prediction', 'outcome', 'settlement', 'appendPrediction',
    'appendOutcomeOnly', 'appendOutcomeUpdate', 'status',
  ];
  if (!store || typeof store !== 'object' || Array.isArray(store)) return 'store is not an object';
  for (const name of required) if (typeof store[name] !== 'function') return `store.${name} is required`;
  return null;
}

export function createAdaptiveCore({ store, procedure, clock = Date.now } = {}) {
  const procedureError = adaptiveProcedureError(procedure); if (procedureError) fail('PROCEDURE_INVALID', procedureError);
  const storageError = storeError(store); if (storageError) fail('STORE_INVALID', storageError);
  if (typeof clock !== 'function') fail('CLOCK_INVALID', 'clock must be a function');
  let storedProcedure;
  try { storedProcedure = store.procedure(); } catch (error) { fail('STORE_INVALID', error.message); }
  if (!storedProcedure || storedProcedure.procedureDigest !== procedure.procedureDigest) fail('PROCEDURE_CONFLICT', 'store procedure does not match core procedure');

  let predictionCalls = 0; let outcomeCalls = 0; let pendingOutcomes = 0;
  let idempotentPredictions = 0; let idempotentOutcomes = 0;

  const now = () => {
    const value = clock(); if (!isTs(value)) fail('CLOCK_INVALID', 'clock returned an invalid timestamp'); return value;
  };

  function recordPrediction(input) {
    predictionCalls += 1;
    const keys = exactKeys(input, PREDICTION_INPUT_KEYS); if (keys) fail('PREDICTION_INVALID', keys);
    let existing;
    try { existing = store.prediction({ opportunityId: input.opportunityId, horizonMs: input.horizonMs }); }
    catch (error) { throw error; }
    if (existing) {
      if (!same(predictionInputProjection(existing), input)) fail('PREDICTION_CONFLICT', 'primary opportunity/horizon already binds different pre-outcome content');
      idempotentPredictions += 1;
      return deepFreeze({ status: 'EXISTING', prediction: clone(existing), updateAuthority: 'NONE' });
    }
    const recordedTs = now();
    const state = store.state();
    let prediction;
    try { prediction = buildAdaptivePrediction({ procedure, state, input, recordedTs }); }
    catch (error) { fail('PREDICTION_INVALID', error.message); }
    const result = store.appendPrediction(prediction);
    return deepFreeze({ ...result, updateAuthority: 'NONE' });
  }

  function recordOutcome(submission) {
    outcomeCalls += 1;
    const submissionKeys = exactKeys(submission, OUTCOME_SUBMISSION_KEYS);
    if (submissionKeys) fail('OUTCOME_PROVENANCE_INVALID', submissionKeys);
    const input = submission.outcomeInput;
    const keys = exactKeys(input, OUTCOME_INPUT_KEYS); if (keys) fail('OUTCOME_INVALID', keys);
    if (!['PENDING', 'MATURED', 'MISSING'].includes(input.state)) fail('OUTCOME_INVALID', 'state must be PENDING, MATURED, or MISSING');
    const prediction = store.prediction({ opportunityId: input.opportunityId, horizonMs: input.horizonMs });
    if (!prediction) fail('PREDICTION_NOT_FOUND', 'outcome cannot precede its saved forecast');
    const provenanceError = adaptiveCandleOutcomeSubmissionError(submission, procedure, prediction);
    if (provenanceError) fail('OUTCOME_PROVENANCE_INVALID', provenanceError);
    if (input.state === 'PENDING') {
      const pendingKeys = exactKeys(input, PENDING_INPUT_KEYS); if (pendingKeys) fail('OUTCOME_INVALID', pendingKeys);
      if (input.logReturnPct !== null || input.sourceEventTs !== null || input.knownAtTs !== null
          || input.sourceDigest !== null || typeof input.reasonCode !== 'string' || input.reasonCode.length === 0) fail('OUTCOME_INVALID', 'pending outcome may contain no future label or source claim');
      pendingOutcomes += 1;
      return deepFreeze({ status: 'PENDING_NO_DURABLE_OUTCOME', reason: input.reasonCode, update: null, updateAuthority: 'NONE' });
    }
    const existing = store.settlement({ opportunityId: input.opportunityId, horizonMs: input.horizonMs });
    if (existing) {
      if (!same(outcomeInputProjection(existing.outcome), input)
          || !same(existing.provenanceReceipt, submission.provenanceReceipt)) fail('OUTCOME_CONFLICT', 'primary opportunity/horizon already binds a different outcome or provenance receipt');
      idempotentOutcomes += 1;
      return deepFreeze({
        status: 'EXISTING', outcome: clone(existing.outcome),
        provenanceReceipt: clone(existing.provenanceReceipt),
        update: existing.update ? clone(existing.update) : null,
        custody: clone(existing.custody), updateAuthority: 'NONE',
      });
    }
    const recordedTs = now();
    let outcome;
    try { outcome = buildAdaptiveOutcome({ procedure, prediction, input, recordedTs }); }
    catch (error) { fail('OUTCOME_INVALID', error.message); }
    const settlementError = adaptiveCandleSettlementError({ outcome, provenanceReceipt: submission.provenanceReceipt }, procedure, prediction);
    if (settlementError) fail('OUTCOME_PROVENANCE_INVALID', settlementError);
    if (outcome.updateEligibility !== 'ELIGIBLE') {
      const result = store.appendOutcomeOnly({ outcome, provenanceReceipt: submission.provenanceReceipt });
      const durable = store.settlement({ opportunityId: input.opportunityId, horizonMs: input.horizonMs });
      return deepFreeze({
        ...result, provenanceReceipt: clone(durable.provenanceReceipt), custody: clone(durable.custody),
        reason: outcome.updateEligibility, update: null, updateAuthority: 'NONE',
      });
    }
    // The score is constructed first from the immutable saved probability.
    // Only then is the transition computed from the current model state.
    let scores; let transition;
    try {
      scores = scoreAdaptiveOutcome({ procedure, prediction, outcome, scoredTs: recordedTs });
      transition = applyAdaptiveUpdate({ procedure, state: store.state(), prediction, outcome, scores, appliedTs: recordedTs });
    } catch (error) { fail('UPDATE_INVALID', error.message); }
    const result = store.appendOutcomeUpdate({ outcome, provenanceReceipt: submission.provenanceReceipt, scores, update: transition.update, nextState: transition.nextState });
    const durable = store.settlement({ opportunityId: input.opportunityId, horizonMs: input.horizonMs });
    return deepFreeze({
      ...result, provenanceReceipt: clone(durable.provenanceReceipt), custody: clone(durable.custody),
      updateAuthority: 'NONE',
    });
  }

  function snapshot({ mode, nowTs, qualification = null } = {}) {
    if (!ADAPTIVE_CORE_MODES.includes(mode)) fail('SNAPSHOT_INVALID', 'mode must be SHADOW, OBSERVE, or PAPER');
    if (!isTs(nowTs)) fail('SNAPSHOT_INVALID', 'nowTs invalid');
    const state = store.state();
    if (state.updatedTs > nowTs) fail('SNAPSHOT_INVALID', 'state is from the future');
    const qualificationStatus = qualification === null ? 'EXTERNAL_QUALIFICATION_REQUIRED' : 'PRESENT_BUT_NOT_VERIFIED_BY_STATE_CORE';
    const body = {
      snapshotVersion: ADAPTIVE_SNAPSHOT_VERSION,
      coreVersion: ADAPTIVE_CORE_VERSION,
      procedureId: procedure.procedureId,
      procedureDigest: procedure.procedureDigest,
      parentPolicyDigest: procedure.parent.policyDigest,
      preparedTs: nowTs,
      mode,
      state,
      rankOffsets: state.strategies.map((row) => ({ strategyId: row.strategyId, rankOffsetRrPoints: row.rankOffsetRrPoints })),
      application: {
        enabled: false,
        authority: 'NONE',
        qualificationStatus,
        reason: 'CORE_STATE_REQUIRES_EXISTING_PROMOTION_MANAGER_AND_AFTER_COST_POLICY_QUALIFICATION',
      },
      effectRegistry: ADAPTIVE_EFFECT_REGISTRY,
      durability: store.status().durability,
      snapshotDigest: '',
    };
    body.snapshotDigest = canonicalDigest(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'snapshotDigest')));
    return deepFreeze(body);
  }

  function status() {
    const state = store.state(); const storage = store.status();
    return deepFreeze({
      coreVersion: ADAPTIVE_CORE_VERSION,
      procedureId: procedure.procedureId,
      stateSequence: state.sequence,
      predictions: storage.predictionCount,
      outcomes: storage.outcomeCount,
      updates: storage.updateCount,
      calls: { predictions: predictionCalls, outcomes: outcomeCalls, pendingOutcomes, idempotentPredictions, idempotentOutcomes },
      movement: {
        usedRrPoints: state.totalRankMovementRrPoints,
        capRrPoints: procedure.algorithm.maxCumulativeRankMovementRrPoints,
        exhausted: state.totalRankMovementRrPoints >= procedure.algorithm.maxCumulativeRankMovementRrPoints,
      },
      applicationAuthority: 'NONE',
      store: storage,
    });
  }

  return Object.freeze({ recordPrediction, recordOutcome, snapshot, status });
}
