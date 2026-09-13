// RAM-only Judge boundary for authoritative learning decision memory.
//
// The production constructor has one fixed worker implementation and accepts no
// store, snapshot, loader, callback, or transport. snapshot() is deliberately
// synchronous and never starts I/O. Refresh is explicit and intended for an
// out-of-admission maintenance lane. Nothing composes this port yet.
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export const DECISION_MEMORY_PORT_VERSION = 'decision-memory-port-2';
export const DECISION_MEMORY_WORKER_PROTOCOL = 'learning-decision-memory-worker-2';
export const DECISION_MEMORY_REFRESH_MS = 60_000;
export const DECISION_MEMORY_MAX_AGE_MS = 15 * 60_000;
export const DECISION_MEMORY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DECISION_MEMORY_WORKER_TIMEOUT_MS = 30_000;
// Bound the worker's V8 heap/stack as well as its byte reader. These limits do
// not cap native buffers or replace the reader's physical byte limits.
export const DECISION_MEMORY_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
});
const ALLOWED_MODES = Object.freeze(['OBSERVE', 'PAPER']);
const SNAPSHOT_KEYS = Object.freeze(['view', 'version', 'law', 'preparedTs', 'activations', 'withheld', 'kill', 'sourceProvenance']);
const SOURCE_PROVENANCE_KEYS = Object.freeze([
  'snapshotStoreVersion', 'sourceSnapshotVersion', 'sourceProvenanceVersion', 'trustBasis',
  'canonicalStoreId', 'sourceDigest', 'totalBytes', 'totalRows',
]);
const ENVELOPE_KEYS = Object.freeze(['protocol', 'requestId', 'ok', 'preparedTs', 'snapshotDigest', 'snapshot']);
const FAILURE_KEYS = Object.freeze(['protocol', 'requestId', 'ok', 'code']);
const FAILURE_CODES = new Set([
  'REQUEST_INVALID', 'STORE_NOT_COMMISSIONED', 'STORE_NOT_DIRECTORY', 'MEMORY_READ_FAILED',
  'RESPONSE_TOO_LARGE', 'WORKER_TIMEOUT', 'WORKER_ERROR', 'WORKER_EXITED',
  'RESPONSE_INVALID', 'CLOCK_INVALID', 'CLOCK_ROLLBACK', 'SNAPSHOT_FUTURE', 'SNAPSHOT_STALE',
  'STOPPED', 'DISABLED', 'REFRESH_RATE_LIMITED', 'WORKER_RESOURCE_LIMIT_INVALID', 'MEMORY_SOURCE_REFUSED',
]);

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeTs = (value) => Number.isSafeInteger(value) && value >= 0;
const safeText = (value, max = 300) => typeof value === 'string' && value.length > 0 && value.length <= max;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
};

function snapshotError(snapshot, expectedTs) {
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)) return 'RESPONSE_INVALID';
  if (snapshot.view !== 'DECISION' || snapshot.version !== 'learning-memory-view-1'
      || snapshot.law !== 'IMMUTABLE_VERSION_BOUND_VALIDATED_CONTENT_ONLY') return 'RESPONSE_INVALID';
  if (!safeTs(snapshot.preparedTs) || snapshot.preparedTs !== expectedTs) return 'RESPONSE_INVALID';
  const source = snapshot.sourceProvenance;
  if (!exactKeys(source, SOURCE_PROVENANCE_KEYS)
      || source.snapshotStoreVersion !== 'learning-decision-snapshot-store-1'
      || source.sourceSnapshotVersion !== 'learning-decision-raw-snapshot-1'
      || source.sourceProvenanceVersion !== 'learning-decision-read-provenance-1'
      || source.trustBasis !== 'FIXED_BOUNDED_READER_COMPLETE_RAW_BYTES'
      || !/^sha256:[a-f0-9]{64}$/.test(source.canonicalStoreId ?? '')
      || !/^[a-f0-9]{64}$/.test(source.sourceDigest ?? '')
      || !Number.isSafeInteger(source.totalBytes) || source.totalBytes < 0 || source.totalBytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(source.totalRows) || source.totalRows < 0 || source.totalRows > 10_000) return 'RESPONSE_INVALID';
  // Until a future activation schema seals the feature body and rank-effect
  // transform before capture, the authoritative worker must pass no activation.
  if (!Array.isArray(snapshot.activations) || snapshot.activations.length !== 0) return 'RESPONSE_INVALID';
  if (!Array.isArray(snapshot.withheld) || snapshot.withheld.length > 2_000) return 'RESPONSE_INVALID';
  for (const row of snapshot.withheld) {
    if (!exactKeys(row, ['activationId', 'reason']) || !safeText(row.activationId, 200) || !safeText(row.reason, 1_000)) return 'RESPONSE_INVALID';
  }
  if (!exactKeys(snapshot.kill, ['state', 'reason', 'ts']) || !['ARMED', 'KILLED'].includes(snapshot.kill.state)
      || (snapshot.kill.reason !== null && !safeText(snapshot.kill.reason, 1_000))
      || (snapshot.kill.ts !== null && (!safeTs(snapshot.kill.ts) || snapshot.kill.ts > expectedTs))) return 'RESPONSE_INVALID';
  return null;
}

function envelopeError(response, requestId, requestTs) {
  if (response?.ok === false) {
    if (!exactKeys(response, FAILURE_KEYS) || response.protocol !== DECISION_MEMORY_WORKER_PROTOCOL
        || response.requestId !== requestId || !FAILURE_CODES.has(response.code)) return 'RESPONSE_INVALID';
    return response.code;
  }
  if (!exactKeys(response, ENVELOPE_KEYS) || response.protocol !== DECISION_MEMORY_WORKER_PROTOCOL
      || response.requestId !== requestId || response.ok !== true || response.preparedTs !== requestTs
      || !/^[a-f0-9]{64}$/.test(response.snapshotDigest ?? '')) return 'RESPONSE_INVALID';
  let serialized;
  try { serialized = JSON.stringify(response.snapshot); } catch { return 'RESPONSE_INVALID'; }
  if (Buffer.byteLength(serialized, 'utf8') > DECISION_MEMORY_MAX_RESPONSE_BYTES
      || digest(response.snapshot) !== response.snapshotDigest) return 'RESPONSE_INVALID';
  return snapshotError(response.snapshot, requestTs);
}

function fixedWorkerTask(request) {
  let worker;
  let responseSettled = false;
  let workerClosed = false;
  let timer = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const markClosed = () => {
    if (workerClosed) return;
    workerClosed = true;
    if (timer) clearTimeout(timer);
    resolveClosed();
  };
  const promise = new Promise((resolve) => {
    const done = (value) => {
      if (responseSettled) return;
      responseSettled = true;
      resolve(value);
    };
    try {
      worker = new Worker(new URL('../learning/decision-memory-worker.js', import.meta.url), {
        workerData: request,
        resourceLimits: DECISION_MEMORY_WORKER_RESOURCE_LIMITS,
      });
    } catch {
      done({ protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId: request.requestId, ok: false, code: 'WORKER_ERROR' });
      markClosed();
      return;
    }
    timer = setTimeout(() => {
      done({ protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId: request.requestId, ok: false, code: 'WORKER_TIMEOUT' });
      worker.terminate().catch(() => {});
    }, DECISION_MEMORY_WORKER_TIMEOUT_MS);
    // A posted result is not worker closure. Keep the lifetime watchdog armed
    // until exit so a result followed by a stuck worker cannot live forever.
    timer.unref?.();
    worker.once('message', done);
    worker.once('error', () => done({ protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId: request.requestId, ok: false, code: 'WORKER_ERROR' }));
    worker.once('exit', (code) => {
      if (!responseSettled) done({ protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId: request.requestId, ok: false, code: code === 0 ? 'WORKER_EXITED' : 'WORKER_ERROR' });
      markClosed();
    });
  });
  return {
    promise,
    closed,
    cancel: () => {
      if (worker && !workerClosed) worker.terminate().catch(() => {});
      return closed;
    },
  };
}

function createPort({ enabled = false, mode = null, dataDir = null, clock = Date.now, log = () => {} } = {}, startTask) {
  if (typeof enabled !== 'boolean') throw new Error('decision memory port: enabled must be boolean');
  if (!enabled) {
    const disabledStatus = Object.freeze({ portVersion: DECISION_MEMORY_PORT_VERSION, enabled: false, mode: null, state: 'DISABLED', preparedTs: null, ageMs: null, withheldCount: 0, lastAttemptTs: null, lastSuccessTs: null, lastFailure: null, refreshInFlight: false });
    return Object.freeze({ snapshot: () => null, refresh: () => Promise.resolve({ ok: false, reason: 'DISABLED' }), refreshIfDue: () => Promise.resolve({ ok: false, reason: 'DISABLED' }), stop: () => Promise.resolve({ stopped: true }), status: () => disabledStatus });
  }
  // This check precedes worker construction or any filesystem activity.
  if (!ALLOWED_MODES.includes(mode)) throw new Error(`decision memory port: enabled mode ${mode ?? 'MISSING'} is not OBSERVE/PAPER`);
  if (typeof dataDir !== 'string' || dataDir.length === 0 || dataDir.length > 4096) throw new Error('decision memory port: dataDir required');
  if (typeof clock !== 'function' || typeof log !== 'function') throw new Error('decision memory port: clock/log malformed');

  let cached = null;
  let lastObservedTs = null;
  let lastAttemptTs = null;
  let lastSuccessTs = null;
  let lastFailure = null;
  let inFlight = null;
  const openTasks = new Set();
  let stopPromise = null;
  let stopped = false;

  const clear = (reason) => { cached = null; lastFailure = reason; };
  const observeClock = () => {
    let nowTs;
    try { nowTs = clock(); } catch { clear('CLOCK_INVALID'); return null; }
    if (!safeTs(nowTs)) { clear('CLOCK_INVALID'); return null; }
    if (lastObservedTs !== null && nowTs < lastObservedTs) { lastObservedTs = nowTs; clear('CLOCK_ROLLBACK'); return null; }
    lastObservedTs = nowTs;
    return nowTs;
  };
  const usableSnapshot = () => {
    if (stopped || !cached) return null;
    const nowTs = observeClock();
    if (nowTs === null) return null;
    if (cached.preparedTs > nowTs) { clear('SNAPSHOT_FUTURE'); return null; }
    if (nowTs - cached.preparedTs > DECISION_MEMORY_MAX_AGE_MS) { clear('SNAPSHOT_STALE'); return null; }
    return cached;
  };

  function refresh() {
    if (stopped) return Promise.resolve({ ok: false, reason: 'STOPPED' });
    if (inFlight) return inFlight;
    const requestTs = observeClock();
    if (requestTs === null) return Promise.resolve({ ok: false, reason: lastFailure });
    if (lastAttemptTs !== null && requestTs - lastAttemptTs < DECISION_MEMORY_REFRESH_MS) {
      const current = usableSnapshot();
      return Promise.resolve(current
        ? { ok: true, preparedTs: current.preparedTs, withheldCount: current.withheld.length, cached: true }
        : { ok: false, reason: lastFailure ?? 'REFRESH_RATE_LIMITED' });
    }
    lastAttemptTs = requestTs;
    const requestId = `dm-${requestTs.toString(36)}-${randomBytes(8).toString('hex')}`;
    const request = { protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId, dataDir, nowTs: requestTs };
    let task;
    try { task = startTask(request); }
    catch { clear('WORKER_ERROR'); return Promise.resolve({ ok: false, reason: 'WORKER_ERROR' }); }
    if (!task || !(task.promise instanceof Promise) || !(task.closed instanceof Promise) || typeof task.cancel !== 'function') {
      clear('WORKER_ERROR'); return Promise.resolve({ ok: false, reason: 'WORKER_ERROR' });
    }
    openTasks.add(task);
    task.closed.catch(() => {}).finally(() => { openTasks.delete(task); });
    const cycle = task.promise.then((response) => {
      if (stopped) return { ok: false, reason: 'STOPPED' };
      const err = envelopeError(response, requestId, requestTs);
      if (err) { clear(err); return { ok: false, reason: err }; }
      const nowTs = observeClock();
      if (nowTs === null) return { ok: false, reason: lastFailure };
      if (response.snapshot.preparedTs > nowTs) { clear('SNAPSHOT_FUTURE'); return { ok: false, reason: 'SNAPSHOT_FUTURE' }; }
      if (nowTs - response.snapshot.preparedTs > DECISION_MEMORY_MAX_AGE_MS) { clear('SNAPSHOT_STALE'); return { ok: false, reason: 'SNAPSHOT_STALE' }; }
      cached = deepFreeze(response.snapshot);
      lastSuccessTs = nowTs;
      lastFailure = null;
      return { ok: true, preparedTs: cached.preparedTs, withheldCount: cached.withheld.length };
    }).catch(() => {
      clear('WORKER_ERROR');
      return { ok: false, reason: 'WORKER_ERROR' };
    });
    inFlight = cycle;
    // The response may be consumed promptly, but the single-flight slot is not
    // released until the worker has also exited. Repeated refresh calls during
    // that interval receive this same response promise and cannot fan out more
    // workers behind an already-settled result.
    Promise.allSettled([cycle, task.closed]).then(() => {
      if (inFlight === cycle) inFlight = null;
    });
    return cycle;
  }

  function refreshIfDue() {
    if (stopped) return Promise.resolve({ ok: false, reason: 'STOPPED' });
    if (inFlight) return inFlight;
    const nowTs = observeClock();
    if (nowTs === null) return Promise.resolve({ ok: false, reason: lastFailure });
    if (lastAttemptTs !== null && nowTs - lastAttemptTs < DECISION_MEMORY_REFRESH_MS) {
      const current = usableSnapshot();
      return Promise.resolve(current ? { ok: true, preparedTs: current.preparedTs, withheldCount: current.withheld.length, cached: true } : { ok: false, reason: lastFailure ?? 'REFRESH_RATE_LIMITED' });
    }
    return refresh();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    cached = null;
    const pending = inFlight;
    const tasks = [...openTasks];
    const closures = tasks.map((task) => {
      try { return Promise.resolve(task.cancel()).catch(() => task.closed); }
      catch { return task.closed; }
    });
    // Response processing and physical worker closure are separate obligations:
    // stop never reports completion merely because a worker posted its result.
    stopPromise = Promise.allSettled([Promise.resolve(pending), ...closures, ...tasks.map((task) => task.closed)])
      .then(() => ({ stopped: true }));
    return stopPromise;
  }

  function status() {
    const nowTs = stopped ? null : observeClock();
    const snap = nowTs === null ? null : usableSnapshot();
    return Object.freeze({
      portVersion: DECISION_MEMORY_PORT_VERSION, enabled: true, mode,
      state: stopped ? 'STOPPED' : snap ? 'READY' : lastFailure ? 'WITHHELD' : 'EMPTY',
      preparedTs: snap?.preparedTs ?? null,
      ageMs: snap && nowTs !== null ? nowTs - snap.preparedTs : null,
      withheldCount: snap?.withheld.length ?? 0,
      lastAttemptTs, lastSuccessTs, lastFailure,
      refreshInFlight: Boolean(inFlight),
    });
  }

  return Object.freeze({ snapshot: usableSnapshot, refresh, refreshIfDue, stop, status });
}

export function createDecisionMemoryPort(options = {}) {
  return createPort(options, fixedWorkerTask);
}

// TEST ONLY. Production composition must use createDecisionMemoryPort, whose
// fixed worker URL cannot be replaced by a caller-supplied source.
export function createDecisionMemoryPortForTest(options = {}, startTask) {
  if (typeof startTask !== 'function') throw new Error('decision memory port test constructor: startTask required');
  return createPort(options, startTask);
}
