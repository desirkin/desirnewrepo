// Contract-only durable owner for the adaptive v2 journal.
//
// This is deliberately NOT a schema-10 store-anchor adapter: the adaptive
// journal is allowed to reach 32 MiB, while that snapshot substrate stops at
// 1 MiB. A future PostgreSQL implementation must provide the append-only port
// below. Until then status remains republishSafe:false and this module is not
// wired into createAdaptiveCore or any runtime.
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  ADAPTIVE_HEAD_VERSION,
  ADAPTIVE_JOURNAL_EVENT_VERSION,
  ADAPTIVE_LOCAL_COMMIT_RECEIPT,
  ADAPTIVE_STORE_VERSION,
  ADAPTIVE_STORE_LIMITS,
  AdaptiveStoreError,
  createAdaptiveStore,
  validateAdaptiveStoreSnapshot,
} from './adaptive-store.js';
import {
  applyAdaptiveUpdate,
  adaptivePredictionKeyOf,
  adaptiveProcedureError,
} from './adaptive-registry.js';
import { canonicalDigest, deepFreeze, isPlainObject, isTs } from './contracts.js';

export const ADAPTIVE_DURABLE_STREAM_VERSION = 'adaptive-durable-stream-port-1';
export const ADAPTIVE_DURABLE_ACK_VERSION = 'adaptive-durable-event-ack-1';
export const ADAPTIVE_DURABLE_ADAPTER_VERSION = 'adaptive-durable-owner-adapter-1';
const MAX_QUEUED_OPERATIONS = 64;

// Injected durablePort contract (there is intentionally no implementation in
// this module):
//   load(identity) -> LOADED exact journal/head/per-event ACK census, or an
//                     exact NOT_FOUND/UNAVAILABLE refusal.
//   append({ identity, expectedRevision, expectedHeadDigest, event,
//            nextAcknowledgedHead }) -> exact APPENDED/EXISTING ACK.
// The adapter is the sole local writer. The port remains caller-owned.

const LOAD_KEYS = Object.freeze([
  'outcome', 'streamVersion', 'storeVersion', 'eventVersion', 'procedureId',
  'procedureDigest', 'revision', 'journalText', 'acknowledgedHead', 'acknowledgments',
]);
const LOAD_REFUSAL_KEYS = Object.freeze(['outcome', 'reason']);
const EVENT_ACK_KEYS = Object.freeze(['ackVersion', 'sequence', 'eventDigest', 'headDigest', 'acknowledgedTs']);
const APPEND_ACK_KEYS = Object.freeze([
  'outcome', 'ackVersion', 'streamVersion', 'storeVersion', 'eventVersion', 'procedureId',
  'procedureDigest', 'revision', 'eventDigest', 'headDigest', 'acknowledgedTs',
]);
const LOAD_OUTCOMES = new Set(['LOADED', 'NOT_FOUND', 'UNAVAILABLE']);
const APPEND_OUTCOMES = new Set(['APPENDED', 'EXISTING']);
const HEX64 = /^[a-f0-9]{64}$/;

export class AdaptiveDurableStoreError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300)}` : code);
    this.name = 'AdaptiveDurableStoreError';
    this.code = code;
  }
}

const fail = (code, detail) => { throw new AdaptiveDurableStoreError(code, detail); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const exactKeys = (value, keys) => isPlainObject(value)
  && Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));
const same = (left, right) => canonicalDigest(left) === canonicalDigest(right);

function normalizeOptions(input) {
  if (!isPlainObject(input)) fail('INPUT_INVALID', 'options must be a plain object');
  const allowed = ['rootDir', 'procedure', 'durablePort', 'clock', 'limits', 'portTimeoutMs'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail('INPUT_INVALID', 'unknown option');
  const procedureError = adaptiveProcedureError(input.procedure); if (procedureError) fail('PROCEDURE_INVALID', procedureError);
  if (typeof input.rootDir !== 'string' || !path.isAbsolute(input.rootDir)) fail('PATH_INVALID', 'rootDir must be absolute');
  if (!input.durablePort || typeof input.durablePort !== 'object' || Array.isArray(input.durablePort)
      || typeof input.durablePort.load !== 'function' || typeof input.durablePort.append !== 'function') {
    fail('DURABLE_PORT_INVALID', 'load and append functions are required');
  }
  const clock = input.clock ?? Date.now;
  if (typeof clock !== 'function') fail('CLOCK_INVALID', 'clock must be a function');
  const portTimeoutMs = input.portTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(portTimeoutMs) || portTimeoutMs < 1 || portTimeoutMs > 60_000) fail('TIMEOUT_INVALID', 'portTimeoutMs outside [1,60000]');
  const limits = input.limits ?? ADAPTIVE_STORE_LIMITS;
  // Base validation remains authoritative. Calling the pure snapshot validator
  // later also proves supplied narrowed limits; here we only bound copies.
  const maxInputBytes = Math.min(512 * 1024, (limits?.maxEventBytes ?? ADAPTIVE_STORE_LIMITS.maxEventBytes) * 2);
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 2) fail('LIMITS_INVALID', 'maxEventBytes malformed');
  const durablePort = Object.freeze({
    load: input.durablePort.load.bind(input.durablePort),
    append: input.durablePort.append.bind(input.durablePort),
  });
  return Object.freeze({
    rootDir: input.rootDir.slice(0), procedure: deepFreeze(clone(input.procedure)),
    durablePort, clock, limits: clone(limits), portTimeoutMs, maxInputBytes,
  });
}

function immutableJson(value, maxBytes, label) {
  if (!isPlainObject(value)) fail('INPUT_INVALID', `${label} must be a plain object`);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('INPUT_INVALID', `${label} is not JSON serializable`); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > maxBytes) fail('INPUT_INVALID', `${label} exceeds bounded JSON input`);
  let copied;
  try { copied = JSON.parse(encoded); } catch { fail('INPUT_INVALID', `${label} is not lossless JSON`); }
  return deepFreeze(copied);
}

function withTimeout(operation, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AdaptiveDurableStoreError(code)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function validateLoadResponse(response, procedure, limits, observedTs) {
  if (!isPlainObject(response) || !LOAD_OUTCOMES.has(response.outcome)) fail('DURABLE_LOAD_INVALID', 'load outcome malformed');
  if (response.outcome !== 'LOADED') {
    if (!exactKeys(response, LOAD_REFUSAL_KEYS) || typeof response.reason !== 'string' || response.reason.length < 1 || response.reason.length > 160) {
      fail('DURABLE_LOAD_INVALID', 'refusal shape malformed');
    }
    return deepFreeze(clone(response));
  }
  if (!exactKeys(response, LOAD_KEYS)) fail('DURABLE_LOAD_INVALID', 'loaded response keys are not exact');
  if (response.streamVersion !== ADAPTIVE_DURABLE_STREAM_VERSION
      || response.storeVersion !== ADAPTIVE_STORE_VERSION
      || response.eventVersion !== ADAPTIVE_JOURNAL_EVENT_VERSION
      || response.procedureId !== procedure.procedureId
      || response.procedureDigest !== procedure.procedureDigest
      || !Number.isSafeInteger(response.revision) || response.revision < 1) fail('DURABLE_LOAD_INVALID', 'loaded identity/revision mismatch');
  const snapshot = validateAdaptiveStoreSnapshot({
    journalText: response.journalText,
    acknowledgedHead: response.acknowledgedHead,
    procedure,
    limits,
  });
  if (response.revision !== snapshot.eventCount || !Array.isArray(response.acknowledgments)
      || response.acknowledgments.length !== snapshot.eventCount) fail('DURABLE_LOAD_INVALID', 'acknowledgment census mismatch');
  let priorAcknowledgedTs = null;
  const acknowledgments = response.acknowledgments.map((ack, index) => {
    if (!exactKeys(ack, EVENT_ACK_KEYS) || ack.ackVersion !== ADAPTIVE_DURABLE_ACK_VERSION
        || ack.sequence !== index || ack.eventDigest !== snapshot.events[index].eventDigest
        || ack.headDigest !== snapshot.eventHeadDigests[index]
        || !isTs(ack.acknowledgedTs) || ack.acknowledgedTs < snapshot.events[index].recordedTs
        || ack.acknowledgedTs > observedTs
        || (priorAcknowledgedTs !== null && ack.acknowledgedTs < priorAcknowledgedTs)) {
      fail('DURABLE_LOAD_INVALID', `acknowledgment ${index} malformed`);
    }
    const event = snapshot.events[index];
    if (event.eventType === 'PREDICTION_RECORDED'
        && ack.acknowledgedTs - event.body.prediction.predictionTs > procedure.target.maxPredictionPersistenceDelayMs) {
      fail('DURABLE_PREDICTION_ACK_LATE', `prediction event ${index} exceeded its sealed persistence deadline`);
    }
    priorAcknowledgedTs = ack.acknowledgedTs;
    return clone(ack);
  });
  return deepFreeze({
    outcome: 'LOADED', streamVersion: response.streamVersion,
    storeVersion: response.storeVersion, eventVersion: response.eventVersion,
    procedureId: response.procedureId, procedureDigest: response.procedureDigest,
    revision: response.revision, snapshot, acknowledgments,
  });
}

function validateAppendAck(ack, { procedure, expectedRevision, event, nextHead, receivedTs }) {
  if (!exactKeys(ack, APPEND_ACK_KEYS) || !APPEND_OUTCOMES.has(ack.outcome)
      || ack.ackVersion !== ADAPTIVE_DURABLE_ACK_VERSION
      || ack.streamVersion !== ADAPTIVE_DURABLE_STREAM_VERSION
      || ack.storeVersion !== ADAPTIVE_STORE_VERSION || ack.eventVersion !== ADAPTIVE_JOURNAL_EVENT_VERSION
      || ack.procedureId !== procedure.procedureId || ack.procedureDigest !== procedure.procedureDigest
      || ack.revision !== expectedRevision + 1 || ack.revision !== nextHead.eventCount
      || ack.eventDigest !== event.eventDigest || ack.headDigest !== nextHead.headDigest
      || !isTs(ack.acknowledgedTs) || ack.acknowledgedTs < event.recordedTs
      || ack.acknowledgedTs > receivedTs) {
    fail('DURABLE_ACK_INVALID', 'append acknowledgment does not bind the exact next event/head');
  }
  return deepFreeze(clone(ack));
}

function pendingFromEvents(events, revision) {
  const predictions = new Map(); const settled = new Set();
  for (const event of events) {
    if (event.eventType === 'PREDICTION_RECORDED') {
      const prediction = event.body.prediction;
      predictions.set(adaptivePredictionKeyOf(prediction), prediction);
    } else if (event.eventType === 'OUTCOME_RECORDED' || event.eventType === 'OUTCOME_UPDATED') {
      settled.add(adaptivePredictionKeyOf(event.body.outcome));
    }
  }
  const items = [...predictions].filter(([key]) => !settled.has(key)).map(([, prediction]) => clone(prediction));
  return deepFreeze({ revision, count: items.length, truncated: false, items });
}

function pendingCountFromEvents(events) {
  const predictions = new Set(); const settled = new Set();
  for (const event of events) {
    if (event.eventType === 'PREDICTION_RECORDED') predictions.add(adaptivePredictionKeyOf(event.body.prediction));
    else if (event.eventType === 'OUTCOME_RECORDED' || event.eventType === 'OUTCOME_UPDATED') {
      settled.add(adaptivePredictionKeyOf(event.body.outcome));
    }
  }
  let count = 0;
  for (const key of predictions) if (!settled.has(key)) count += 1;
  return count;
}

// This projection is rebuilt only from the exact stream accepted by
// validateLoadResponse, then advanced only after validateAppendAck succeeds.
// The local store may be one event ahead while a port call is unresolved; no
// value from that speculative local state is reachable through this view.
function createAcknowledgedProjection({ events, acknowledgments, procedure }) {
  let state = null;
  const predictions = new Map();
  const outcomes = new Map();
  const settlements = new Map();
  let eventCount = 0;

  const apply = (event, acknowledgment) => {
    if (!event || event.sequence !== eventCount || !acknowledgment
        || acknowledgment.sequence !== event.sequence
        || acknowledgment.eventDigest !== event.eventDigest) {
      fail('ACKNOWLEDGED_VIEW_INVALID', 'event/acknowledgment sequence differs from the validated durable stream');
    }
    if (event.eventType === 'PROCEDURE_REGISTERED') {
      if (eventCount !== 0) fail('ACKNOWLEDGED_VIEW_INVALID', 'procedure registration is not the origin event');
      state = clone(event.body.state);
    } else if (event.eventType === 'PREDICTION_RECORDED') {
      predictions.set(adaptivePredictionKeyOf(event.body.prediction), clone(event.body.prediction));
    } else {
      const key = adaptivePredictionKeyOf(event.body.outcome);
      outcomes.set(key, clone(event.body.outcome));
      let nextStateDigest = null;
      if (event.eventType === 'OUTCOME_UPDATED') {
        const prediction = predictions.get(key);
        const transition = applyAdaptiveUpdate({
          procedure,
          state,
          prediction,
          outcome: event.body.outcome,
          scores: event.body.scores,
          appliedTs: event.body.update.appliedTs,
        });
        if (transition.nextState.stateDigest !== event.body.nextStateDigest) {
          fail('ACKNOWLEDGED_VIEW_INVALID', 'recomputed state differs from the validated durable event');
        }
        state = clone(transition.nextState);
        nextStateDigest = event.body.nextStateDigest;
      }
      settlements.set(key, {
        outcome: clone(event.body.outcome),
        provenanceReceipt: clone(event.body.provenanceReceipt),
        scores: event.eventType === 'OUTCOME_UPDATED' ? clone(event.body.scores) : null,
        update: event.eventType === 'OUTCOME_UPDATED' ? clone(event.body.update) : null,
        nextStateDigest,
        eventSequence: event.sequence,
        eventDigest: event.eventDigest,
        durableAcknowledgment: clone(acknowledgment),
      });
    }
    eventCount += 1;
  };

  for (let index = 0; index < events.length; index += 1) apply(events[index], acknowledgments[index]);
  if (state === null) fail('ACKNOWLEDGED_VIEW_INVALID', 'validated durable stream has no procedure state');

  const keyOf = ({ opportunityId, horizonMs } = {}) => adaptivePredictionKeyOf({
    procedureId: procedure.procedureId,
    opportunityId,
    horizonMs,
  });
  return {
    apply,
    procedure: () => deepFreeze(clone(procedure)),
    state: () => deepFreeze(clone(state)),
    prediction: (query) => {
      const row = predictions.get(keyOf(query));
      return row ? deepFreeze(clone(row)) : null;
    },
    outcome: (query) => {
      const row = outcomes.get(keyOf(query));
      return row ? deepFreeze(clone(row)) : null;
    },
    settlement: (query, acknowledgedHead) => {
      const row = settlements.get(keyOf(query));
      if (!row) return null;
      const { nextStateDigest: _internalNextStateDigest, durableAcknowledgment, ...publicRow } = clone(row);
      return deepFreeze({
        ...publicRow,
        custody: {
          storeVersion: ADAPTIVE_STORE_VERSION,
          eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
          streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
          durableAcknowledgment,
          acknowledgedHead: clone(acknowledgedHead),
          receiptContentBound: true,
          declaredArchiveIdentityBound: true,
          externalSourceAuthenticityVerified: false,
          firstWriteCustodyVerified: false,
          afterCostQualificationVerified: false,
          externalImplementationVerified: false,
          republishSafe: false,
          authority: 'NONE',
        },
      });
    },
  };
}

export function openDurableAdaptiveStore(input = {}) {
  // All caller-controlled options are validated/copied before the first await.
  const options = normalizeOptions(input);
  const identity = deepFreeze({
    streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
    storeVersion: ADAPTIVE_STORE_VERSION,
    eventVersion: ADAPTIVE_JOURNAL_EVENT_VERSION,
    headVersion: ADAPTIVE_HEAD_VERSION,
    procedureId: options.procedure.procedureId,
    procedureDigest: options.procedure.procedureDigest,
  });

  return (async () => {
    let loadResponse;
    try {
      loadResponse = await withTimeout(() => options.durablePort.load(identity), options.portTimeoutMs, 'DURABLE_LOAD_TIMEOUT');
    } catch (error) {
      if (error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_LOAD_TIMEOUT') throw error;
      fail('DURABLE_LOAD_FAILED', error?.code ?? error?.name ?? 'PORT_FAILURE');
    }
    const openedTs = options.clock(); if (!isTs(openedTs)) fail('CLOCK_INVALID', 'clock invalid after durable load');
    const loaded = validateLoadResponse(loadResponse, options.procedure, options.limits, openedTs);
    if (loaded.outcome === 'NOT_FOUND') fail('DURABLE_NOT_COMMISSIONED', loaded.reason);
    if (loaded.outcome === 'UNAVAILABLE') fail('DURABLE_UNAVAILABLE', loaded.reason);

    const journalFile = path.join(options.rootDir, 'journal.jsonl');
    const headFile = path.join(options.rootDir, 'head.json');
    const bothAbsent = !existsSync(journalFile) && !existsSync(headFile);
    let localStore;
    try {
      localStore = createAdaptiveStore({
        rootDir: options.rootDir,
        procedure: options.procedure,
        clock: options.clock,
        limits: options.limits,
        durableBootstrap: bothAbsent ? {
          journalText: loaded.snapshot.journalText,
          acknowledgedHead: loaded.snapshot.acknowledgedHead,
        } : null,
      });
      const local = localStore[ADAPTIVE_LOCAL_COMMIT_RECEIPT]();
      if (!same(local.acknowledgedHead, loaded.snapshot.acknowledgedHead)
          || local.event.eventDigest !== loaded.snapshot.events.at(-1).eventDigest) {
        localStore.close();
        fail('DURABLE_LOCAL_DIVERGENCE', 'local acknowledged head differs from durable stream');
      }
    } catch (error) {
      if (error instanceof AdaptiveDurableStoreError) throw error;
      if (error instanceof AdaptiveStoreError) fail('LOCAL_STORE_REFUSED', error.code);
      fail('LOCAL_STORE_REFUSED', error?.name ?? 'LOCAL_FAILURE');
    }

    let durableRevision = loaded.revision;
    let durableHead = clone(loaded.snapshot.acknowledgedHead);
    const acknowledgedEvents = loaded.snapshot.events.map((event) => clone(event));
    const acknowledgedAcks = loaded.acknowledgments.map((ack) => clone(ack));
    const acknowledgedView = createAcknowledgedProjection({
      events: acknowledgedEvents,
      acknowledgments: acknowledgedAcks,
      procedure: options.procedure,
    });
    let lastReceivedTs = openedTs;
    let failed = null; let closing = false; let closed = false; let localAhead = false;
    let tail = Promise.resolve(); let closePromise = null; let inFlight = 0; let queued = 0;

    const latch = (error) => {
      if (failed === null) failed = error instanceof AdaptiveDurableStoreError
        ? error : new AdaptiveDurableStoreError('DURABLE_ACK_AMBIGUOUS', error?.code ?? error?.name ?? 'PORT_FAILURE');
      throw failed;
    };
    const assertOpen = () => {
      if (closing || closed) fail('ADAPTER_CLOSED');
      if (failed) throw failed;
    };
    const queue = (operation) => {
      assertOpen();
      if (queued >= MAX_QUEUED_OPERATIONS) fail('ADAPTER_QUEUE_FULL');
      queued += 1;
      const pending = tail.then(async () => {
        if (failed) throw failed;
        if (closed) fail('ADAPTER_CLOSED');
        inFlight += 1;
        try { return await operation(); } finally { inFlight -= 1; }
      });
      pending.finally(() => { queued -= 1; }).catch(() => {});
      tail = pending.catch(() => {});
      return pending;
    };

    const appendAndAcknowledge = (localOperation) => queue(async () => {
      let localResult;
      try { localResult = localOperation(); }
      catch (error) {
        let localFailed = true;
        try { localFailed = localStore.status().failed !== null; } catch { /* fail closed */ }
        if (localFailed) return latch(new AdaptiveDurableStoreError('LOCAL_STORE_FAILED', error?.code ?? error?.name ?? 'LOCAL_FAILURE'));
        throw error;
      }
      if (localResult.status === 'EXISTING') return deepFreeze({ ...clone(localResult), durable: true, durableRevision, authority: 'NONE' });
      const receipt = localStore[ADAPTIVE_LOCAL_COMMIT_RECEIPT]();
      const event = receipt.event; const nextHead = receipt.acknowledgedHead;
      if (event.sequence !== durableRevision || event.previousDigest !== durableHead.lastEventDigest
          || nextHead.eventCount !== durableRevision + 1 || nextHead.lastEventDigest !== event.eventDigest) {
        localAhead = true;
        return latch(new AdaptiveDurableStoreError('LOCAL_DURABLE_SEQUENCE_CONFLICT'));
      }
      localAhead = true;
      const request = deepFreeze({
        identity: clone(identity), expectedRevision: durableRevision,
        expectedHeadDigest: durableHead.headDigest,
        event: clone(event),
        nextAcknowledgedHead: clone(nextHead),
      });
      let rawAck;
      try {
        rawAck = await withTimeout(() => options.durablePort.append(request), options.portTimeoutMs, 'DURABLE_ACK_TIMEOUT');
      } catch (error) {
        return latch(error instanceof AdaptiveDurableStoreError && error.code === 'DURABLE_ACK_TIMEOUT'
          ? error
          : new AdaptiveDurableStoreError('DURABLE_ACK_AMBIGUOUS', error?.code ?? error?.name ?? 'PORT_FAILURE'));
      }
      const receivedTs = options.clock();
      if (!isTs(receivedTs) || receivedTs < lastReceivedTs || receivedTs < event.recordedTs) {
        return latch(new AdaptiveDurableStoreError('CLOCK_INVALID', 'clock invalid after durable acknowledgment'));
      }
      let ack;
      try { ack = validateAppendAck(rawAck, { procedure: options.procedure, expectedRevision: durableRevision, event, nextHead, receivedTs }); }
      catch (error) { return latch(error); }
      const eventAcknowledgment = {
        ackVersion: ack.ackVersion,
        sequence: event.sequence,
        eventDigest: ack.eventDigest,
        headDigest: ack.headDigest,
        acknowledgedTs: ack.acknowledgedTs,
      };
      try { acknowledgedView.apply(event, eventAcknowledgment); }
      catch (error) { return latch(error); }
      durableRevision = ack.revision; durableHead = clone(nextHead);
      acknowledgedEvents.push(clone(event)); acknowledgedAcks.push(clone(eventAcknowledgment));
      lastReceivedTs = receivedTs; localAhead = false;
      if (event.eventType === 'PREDICTION_RECORDED') {
        const deadline = event.body.prediction.predictionTs + options.procedure.target.maxPredictionPersistenceDelayMs;
        if (ack.acknowledgedTs > deadline || receivedTs > deadline) {
          return latch(new AdaptiveDurableStoreError('DURABLE_PREDICTION_ACK_LATE', 'durable acknowledgment missed the sealed forecast deadline'));
        }
      }
      return deepFreeze({
        ...clone(localResult),
        durable: true,
        durableAcknowledgment: { ...clone(ack), receivedTs },
        authority: 'NONE',
      });
    });

    const api = {
      procedure() {
        assertOpen();
        return acknowledgedView.procedure();
      },
      state() {
        assertOpen();
        return acknowledgedView.state();
      },
      prediction(query) {
        assertOpen();
        return acknowledgedView.prediction(query);
      },
      outcome(query) {
        assertOpen();
        return acknowledgedView.outcome(query);
      },
      settlement(query) {
        assertOpen();
        return acknowledgedView.settlement(query, durableHead);
      },
      appendPrediction(prediction) {
        const copied = immutableJson(prediction, options.maxInputBytes, 'prediction');
        return appendAndAcknowledge(() => localStore.appendPrediction(copied));
      },
      appendOutcomeOnly(inputValue) {
        const copied = immutableJson(inputValue, options.maxInputBytes, 'outcome');
        return appendAndAcknowledge(() => localStore.appendOutcomeOnly(copied));
      },
      appendOutcomeUpdate(inputValue) {
        const copied = immutableJson(inputValue, options.maxInputBytes, 'outcome update');
        return appendAndAcknowledge(() => localStore.appendOutcomeUpdate(copied));
      },
      pending() {
        assertOpen();
        return pendingFromEvents(acknowledgedEvents, durableRevision);
      },
      status() {
        return deepFreeze({
          adapterVersion: ADAPTIVE_DURABLE_ADAPTER_VERSION,
          streamVersion: ADAPTIVE_DURABLE_STREAM_VERSION,
          storeVersion: ADAPTIVE_STORE_VERSION,
          procedureId: options.procedure.procedureId,
          state: closed ? 'CLOSED' : closing ? 'CLOSING' : failed ? 'FAILED' : 'OPEN',
          failed: failed ? { code: failed.code } : null,
          durableRevision,
          acknowledgedEvents: acknowledgedEvents.length,
          pendingPredictions: pendingCountFromEvents(acknowledgedEvents),
          inFlight, queuedOperations: queued, maxQueuedOperations: MAX_QUEUED_OPERATIONS,
          localAheadUnacknowledged: localAhead,
          durability: {
            externalPort: 'INJECTED_CONTRACT_ONLY',
            externalPortImplementation: 'NOT_PROVIDED_BY_THIS_MODULE',
            externalImplementationVerified: false,
            republishSafe: false,
            runtimeIntegration: 'UNCOMMISSIONED',
            commissioningPerformedByAdapter: false,
            loadedStreamPresentedByPort: true,
          },
          coreCompatible: false,
          requiredCoordinator: 'ASYNC_OWNER_BEFORE_CREATE_ADAPTIVE_CORE_INTEGRATION',
          authority: 'NONE',
        });
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = tail.then(() => {
          localStore.close(); closed = true; closing = false;
          return deepFreeze({ closed: true, drained: !localAhead, durableRevision, authority: 'NONE' });
        });
        return closePromise;
      },
    };
    return Object.freeze(api);
  })();
}
