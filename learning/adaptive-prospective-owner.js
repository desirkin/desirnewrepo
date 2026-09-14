// Serialized async owner for the acknowledged adaptive v2 store contract.
//
// This module is deliberately not injected into createAdaptiveCore: that core
// has a synchronous store interface. Every mutation here resolves only after
// the durable adapter has accepted an exact acknowledgment, and every read is
// taken from that adapter's acknowledged projection. It grants no promotion,
// Judge, account, order, or runtime authority.
import { canonicalDigest, deepFreeze, exactKeys, isPlainObject, isTs } from './contracts.js';
import {
  adaptiveProcedureError,
  applyAdaptiveUpdate,
  buildAdaptiveOutcome,
  buildAdaptivePrediction,
  scoreAdaptiveOutcome,
} from './adaptive-registry.js';
import {
  adaptiveCandleOutcomeSubmissionError,
  adaptiveCandleSettlementError,
} from './adaptive-candle-outcome.js';
import { ADAPTIVE_DURABLE_ADAPTER_VERSION } from './adaptive-durable-store.js';

export const ADAPTIVE_PROSPECTIVE_OWNER_VERSION = 'adaptive-prospective-owner-1';
export const MAX_ADAPTIVE_OWNER_QUEUE = 64;
export const MAX_ADAPTIVE_FOLLOW_UPS = 256;
const MAX_INPUT_BYTES = 512 * 1024;

const PREDICTION_INPUT_KEYS = Object.freeze([
  'opportunityId', 'identity', 'catalogContentId', 'predictionTs', 'horizonMs',
  'featureRecipeDigest', 'factsDigest', 'strategyAssessments', 'selection',
]);
const OUTCOME_INPUT_KEYS = Object.freeze([
  'opportunityId', 'horizonMs', 'state', 'logReturnPct', 'sourceEventTs',
  'knownAtTs', 'sourceDigest', 'reasonCode',
]);
const OUTCOME_SUBMISSION_KEYS = Object.freeze(['outcomeInput', 'provenanceReceipt']);

export class AdaptiveProspectiveOwnerError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${String(detail).replace(/[\r\n]+/g, ' ').slice(0, 400)}` : code);
    this.name = 'AdaptiveProspectiveOwnerError';
    this.code = code;
  }
}

const fail = (code, detail) => { throw new AdaptiveProspectiveOwnerError(code, detail); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (left, right) => canonicalDigest(left) === canonicalDigest(right);

function immutableJson(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('INPUT_INVALID', `${label} is not JSON serializable`); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_INPUT_BYTES) {
    fail('INPUT_INVALID', `${label} exceeds the bounded JSON input limit`);
  }
  let copied;
  try { copied = JSON.parse(encoded); } catch { fail('INPUT_INVALID', `${label} is not lossless JSON`); }
  if (!isPlainObject(copied)) fail('INPUT_INVALID', `${label} must be a plain object`);
  return deepFreeze(copied);
}

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
      strategyId: row.strategyId,
      eligibility: row.eligibility,
      reasonCode: row.reasonCode,
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
    'procedure', 'state', 'prediction', 'outcome', 'settlement', 'pending',
    'appendPrediction', 'appendOutcomeOnly', 'appendOutcomeUpdate', 'status', 'close',
  ];
  if (!store || typeof store !== 'object' || Array.isArray(store)) return 'store is not an object';
  for (const name of required) if (typeof store[name] !== 'function') return `store.${name} is required`;
  let status;
  try { status = store.status(); } catch (error) { return `store status unavailable: ${error.message}`; }
  if (status?.adapterVersion !== ADAPTIVE_DURABLE_ADAPTER_VERSION
      || status?.authority !== 'NONE' || status?.coreCompatible !== false) {
    return 'store is not the acknowledged durable adaptive adapter';
  }
  return null;
}

export function createAdaptiveProspectiveOwner({ store, procedure, clock = Date.now } = {}) {
  const procedureError = adaptiveProcedureError(procedure);
  if (procedureError) fail('PROCEDURE_INVALID', procedureError);
  const storageError = storeError(store);
  if (storageError) fail('STORE_INVALID', storageError);
  if (typeof clock !== 'function') fail('CLOCK_INVALID', 'clock must be a function');
  let storedProcedure;
  try { storedProcedure = store.procedure(); } catch (error) { fail('STORE_INVALID', error.message); }
  if (!storedProcedure || storedProcedure.procedureDigest !== procedure.procedureDigest) {
    fail('PROCEDURE_CONFLICT', 'store procedure does not match owner procedure');
  }

  let tail = Promise.resolve();
  let closePromise = null;
  let closing = false;
  let closed = false;
  let failed = null;
  let queued = 0;
  let inFlight = 0;
  const calls = {
    predictions: 0,
    outcomes: 0,
    pendingOutcomes: 0,
    idempotentPredictions: 0,
    idempotentOutcomes: 0,
  };

  const now = () => {
    const value = clock();
    if (!isTs(value)) fail('CLOCK_INVALID', 'clock returned an invalid timestamp');
    return value;
  };
  const assertOpen = () => {
    if (closing || closed) fail('OWNER_CLOSED');
    if (failed) throw failed;
  };
  const rememberStoreFailure = (error) => {
    if (error instanceof AdaptiveProspectiveOwnerError
        && error.code === 'ACKNOWLEDGED_READ_MISMATCH') {
      if (failed === null) failed = error;
      return;
    }
    let storage = null;
    try { storage = store.status(); } catch { /* unavailable is itself fail-closed */ }
    if (!storage || storage.state === 'FAILED') {
      if (failed === null) failed = error;
    }
  };
  const queue = (operation) => {
    assertOpen();
    if (queued >= MAX_ADAPTIVE_OWNER_QUEUE) fail('OWNER_QUEUE_FULL');
    queued += 1;
    const pending = tail.then(async () => {
      if (failed) throw failed;
      if (closed) fail('OWNER_CLOSED');
      inFlight += 1;
      try {
        return await operation();
      } catch (error) {
        rememberStoreFailure(error);
        throw error;
      } finally {
        inFlight -= 1;
      }
    });
    pending.finally(() => { queued -= 1; }).catch(() => {});
    tail = pending.catch(() => {});
    return pending;
  };

  function recordPrediction(inputValue) {
    const input = immutableJson(inputValue, 'prediction input');
    return queue(async () => {
      calls.predictions += 1;
      const keys = exactKeys(input, PREDICTION_INPUT_KEYS);
      if (keys) fail('PREDICTION_INVALID', keys);
      const query = { opportunityId: input.opportunityId, horizonMs: input.horizonMs };
      const existing = store.prediction(query);
      if (existing) {
        if (!same(predictionInputProjection(existing), input)) {
          fail('PREDICTION_CONFLICT', 'primary opportunity/horizon already binds different pre-outcome content');
        }
        calls.idempotentPredictions += 1;
        return deepFreeze({
          status: 'EXISTING', prediction: clone(existing),
          durable: true, updateAuthority: 'NONE',
        });
      }
      const recordedTs = now();
      let prediction;
      try {
        prediction = buildAdaptivePrediction({ procedure, state: store.state(), input, recordedTs });
      } catch (error) { fail('PREDICTION_INVALID', error.message); }
      const result = await store.appendPrediction(prediction);
      const acknowledged = store.prediction(query);
      if (!acknowledged || acknowledged.predictionDigest !== prediction.predictionDigest) {
        fail('ACKNOWLEDGED_READ_MISMATCH', 'durable prediction acknowledgment is not visible in the reader');
      }
      return deepFreeze({
        ...clone(result), prediction: clone(acknowledged), updateAuthority: 'NONE',
      });
    });
  }

  function recordOutcome(submissionValue) {
    const submission = immutableJson(submissionValue, 'outcome submission');
    return queue(async () => {
      calls.outcomes += 1;
      const submissionKeys = exactKeys(submission, OUTCOME_SUBMISSION_KEYS);
      if (submissionKeys) fail('OUTCOME_PROVENANCE_INVALID', submissionKeys);
      const input = submission.outcomeInput;
      const keys = exactKeys(input, OUTCOME_INPUT_KEYS);
      if (keys) fail('OUTCOME_INVALID', keys);
      if (!['PENDING', 'MATURED', 'MISSING'].includes(input.state)) {
        fail('OUTCOME_INVALID', 'state must be PENDING, MATURED, or MISSING');
      }
      const query = { opportunityId: input.opportunityId, horizonMs: input.horizonMs };
      const prediction = store.prediction(query);
      if (!prediction) fail('PREDICTION_NOT_FOUND', 'outcome cannot precede its acknowledged forecast');
      const provenanceError = adaptiveCandleOutcomeSubmissionError(submission, procedure, prediction);
      if (provenanceError) fail('OUTCOME_PROVENANCE_INVALID', provenanceError);
      const recordedTs = now();
      if (submission.provenanceReceipt.preparedTs > recordedTs) {
        fail('OUTCOME_PROVENANCE_INVALID', 'provenance receipt was prepared in the future');
      }
      if (input.state === 'PENDING') {
        if (input.logReturnPct !== null || input.sourceEventTs !== null || input.knownAtTs !== null
            || input.sourceDigest !== null || typeof input.reasonCode !== 'string' || input.reasonCode.length === 0) {
          fail('OUTCOME_INVALID', 'pending outcome may contain no future label or source claim');
        }
        calls.pendingOutcomes += 1;
        return deepFreeze({
          status: 'PENDING_NO_DURABLE_OUTCOME',
          reason: input.reasonCode,
          update: null,
          durableMutation: false,
          updateAuthority: 'NONE',
        });
      }
      const existing = store.settlement(query);
      if (existing) {
        if (!same(outcomeInputProjection(existing.outcome), input)
            || !same(existing.provenanceReceipt, submission.provenanceReceipt)) {
          fail('OUTCOME_CONFLICT', 'primary opportunity/horizon already binds a different outcome or provenance receipt');
        }
        calls.idempotentOutcomes += 1;
        return deepFreeze({
          status: 'EXISTING', outcome: clone(existing.outcome),
          provenanceReceipt: clone(existing.provenanceReceipt),
          scores: existing.scores ? clone(existing.scores) : null,
          update: existing.update ? clone(existing.update) : null,
          state: clone(store.state()), custody: clone(existing.custody),
          durable: true, updateAuthority: 'NONE',
        });
      }
      let outcome;
      try { outcome = buildAdaptiveOutcome({ procedure, prediction, input, recordedTs }); }
      catch (error) { fail('OUTCOME_INVALID', error.message); }
      const settlementError = adaptiveCandleSettlementError(
        { outcome, provenanceReceipt: submission.provenanceReceipt },
        procedure,
        prediction,
      );
      if (settlementError) fail('OUTCOME_PROVENANCE_INVALID', settlementError);

      let result;
      if (outcome.updateEligibility === 'ELIGIBLE') {
        let scores; let transition;
        try {
          // The original saved probabilities are scored before the state moves.
          scores = scoreAdaptiveOutcome({ procedure, prediction, outcome, scoredTs: recordedTs });
          transition = applyAdaptiveUpdate({
            procedure,
            state: store.state(),
            prediction,
            outcome,
            scores,
            appliedTs: recordedTs,
          });
        } catch (error) { fail('UPDATE_INVALID', error.message); }
        result = await store.appendOutcomeUpdate({
          outcome,
          provenanceReceipt: submission.provenanceReceipt,
          scores,
          update: transition.update,
          nextState: transition.nextState,
        });
      } else {
        result = await store.appendOutcomeOnly({
          outcome,
          provenanceReceipt: submission.provenanceReceipt,
        });
      }
      const acknowledged = store.settlement(query);
      if (!acknowledged || acknowledged.outcome.outcomeDigest !== outcome.outcomeDigest
          || !same(acknowledged.provenanceReceipt, submission.provenanceReceipt)) {
        fail('ACKNOWLEDGED_READ_MISMATCH', 'durable settlement acknowledgment is not visible in the reader');
      }
      return deepFreeze({
        ...clone(result),
        outcome: clone(acknowledged.outcome),
        provenanceReceipt: clone(acknowledged.provenanceReceipt),
        scores: acknowledged.scores ? clone(acknowledged.scores) : null,
        update: acknowledged.update ? clone(acknowledged.update) : null,
        state: clone(store.state()),
        custody: clone(acknowledged.custody),
        reason: outcome.updateEligibility,
        updateAuthority: 'NONE',
      });
    });
  }

  function pending({ limit = 64, nowTs = null } = {}) {
    assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ADAPTIVE_FOLLOW_UPS) {
      fail('PENDING_LIMIT_INVALID', `limit must be within [1,${MAX_ADAPTIVE_FOLLOW_UPS}]`);
    }
    const observedTs = nowTs === null ? now() : nowTs;
    if (!isTs(observedTs)) fail('CLOCK_INVALID', 'pending nowTs is invalid');
    const source = store.pending();
    const items = source.items.slice(0, limit).map((prediction) => {
      const deadlineTs = prediction.targetEndTs + procedure.target.maxLabelDelayMs;
      const followUpState = observedTs < prediction.targetEndTs
        ? 'AWAIT_TARGET'
        : observedTs <= deadlineTs ? 'AWAIT_LABEL_OR_DEADLINE' : 'FINAL_POLL_DUE';
      return {
        prediction: clone(prediction),
        targetEndTs: prediction.targetEndTs,
        missingnessDeadlineTs: deadlineTs,
        followUpState,
      };
    });
    return deepFreeze({
      revision: source.revision,
      total: source.count,
      returned: items.length,
      truncated: source.count > items.length,
      items,
      automaticArchivePolling: false,
      archiveReader: 'NOT_PROVIDED_BY_THIS_MODULE',
      authority: 'NONE',
    });
  }

  function state() {
    assertOpen();
    return store.state();
  }

  function status() {
    let storage;
    try { storage = store.status(); } catch (error) { storage = { state: 'UNAVAILABLE', failed: { code: error.code ?? error.name } }; }
    let stateSequence = null;
    if (!closed && !closing && !failed && storage.state === 'OPEN') {
      try { stateSequence = store.state().sequence; } catch { stateSequence = null; }
    }
    return deepFreeze({
      ownerVersion: ADAPTIVE_PROSPECTIVE_OWNER_VERSION,
      procedureId: procedure.procedureId,
      procedureDigest: procedure.procedureDigest,
      state: closed ? 'CLOSED' : closing ? 'CLOSING' : failed ? 'FAILED' : 'OPEN',
      failed: failed ? { code: failed.code ?? failed.name ?? 'OWNER_FAILURE' } : null,
      stateSequence,
      inFlight,
      queuedOperations: queued,
      maxQueuedOperations: MAX_ADAPTIVE_OWNER_QUEUE,
      maxReturnedFollowUps: MAX_ADAPTIVE_FOLLOW_UPS,
      pendingSourceMemoryBound: 'ACKNOWLEDGED_STREAM_WITHIN_FIXED_32_MIB_STORE_JOURNAL_LIMIT',
      calls: clone(calls),
      mutationCompletionLaw: 'RETURNS_ONLY_AFTER_EXACT_DURABLE_ACK',
      pendingFollowUpLaw: 'BOUNDED_CALLER_DRIVEN_NO_BACKGROUND_ARCHIVE_POLLING',
      runtimeIntegration: 'UNCOMMISSIONED',
      applicationAuthority: 'NONE',
      store: storage,
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = tail.then(async () => {
      const storeResult = await store.close();
      closed = true;
      closing = false;
      return deepFreeze({
        closed: true,
        drained: storeResult.drained === true,
        durableRevision: storeResult.durableRevision,
        authority: 'NONE',
      });
    });
    return closePromise;
  }

  return Object.freeze({ recordPrediction, recordOutcome, pending, state, status, close });
}
