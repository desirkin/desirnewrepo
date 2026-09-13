// Fixed persistent worker for the prospective opportunity-audit store.
// This file has no CLI mode and no provider/network imports.
import { createHash } from 'node:crypto';
import { isMainThread, parentPort, resourceLimits, workerData } from 'node:worker_threads';
import { openOpportunityAuditStore } from '../learning/opportunity-audit-store.js';
import { createOpportunityAuditWideEyePort } from '../learning/opportunity-audit-wideeye-port.js';

const PROTOCOL = 'opportunity-audit-worker-1';
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_TREE_NODES = 60_000;
const CONFIG_KEYS = Object.freeze([
  'protocol', 'rootDir', 'sampleSize', 'horizonsMs', 'minFrameIntervalMs', 'wideEyeComponent',
]);
const REQUEST_KEYS = Object.freeze(['protocol', 'requestId', 'operation', 'payload']);
const COMPONENT_KEYS = Object.freeze(['componentId', 'version', 'configDigest']);
const HEX64_RE = /^[a-f0-9]{64}$/;
const REQUEST_ID_RE = /^oaw-[0-9]+-[a-z0-9]+$/;
const QUEUE_ID_RE = /^oaq-[a-f0-9]{40}$/;

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function boundedTree(value) {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop(); nodes += 1;
    if (nodes > MAX_TREE_NODES || current.depth > 12) return false;
    const item = current.value;
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item === 'string') { if (item.length > 4_096) return false; continue; }
    if (Array.isArray(item)) {
      if (item.length > 5_000) return false;
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!plain(item) || Object.keys(item).length > 32) return false;
    for (const child of Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
  }
  try { return Buffer.byteLength(canonicalJson(value), 'utf8') <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}

function configError(config) {
  if (!exact(config, CONFIG_KEYS) || config.protocol !== PROTOCOL
      || typeof config.rootDir !== 'string' || config.rootDir.length === 0 || config.rootDir.length > 4_096
      || !positive(config.sampleSize) || config.sampleSize > 8
      || !Array.isArray(config.horizonsMs) || config.horizonsMs.length < 1 || config.horizonsMs.length > 16
      || config.horizonsMs.some((value) => !positive(value))
      || !positive(config.minFrameIntervalMs) || config.minFrameIntervalMs < 60_000
      || config.minFrameIntervalMs > 86_400_000
      || !exact(config.wideEyeComponent, COMPONENT_KEYS)
      || config.wideEyeComponent.componentId !== 'wideeye'
      || typeof config.wideEyeComponent.version !== 'string' || config.wideEyeComponent.version.length === 0
      || config.wideEyeComponent.version.length > 200
      || !HEX64_RE.test(config.wideEyeComponent.configDigest ?? '')) return 'REQUEST_INVALID';
  return null;
}

function resourceError() {
  const heapFlag = /^--(?:max[-_]old[-_]space[-_]size(?:[-_]percentage)?|max[-_]semi[-_]space[-_]size)(?:=|$)/;
  if (process.execArgv.some((arg) => heapFlag.test(arg))) return 'WORKER_RESOURCE_LIMIT_INVALID';
  const expected = [['maxOldGenerationSizeMb', 96], ['maxYoungGenerationSizeMb', 16], ['stackSizeMb', 4]];
  if (!expected.every(([key, maximum]) => Number.isFinite(resourceLimits[key])
      && resourceLimits[key] > 0 && resourceLimits[key] <= maximum)) return 'WORKER_RESOURCE_LIMIT_INVALID';
  // The production parent supplies env: {}. No ambient credential or option is
  // part of this worker's authority.
  if (Object.keys(process.env).length !== 0) return 'WORKER_ENV_INVALID';
  return null;
}

function response(request, result) {
  parentPort.postMessage({ protocol: PROTOCOL, requestId: request.requestId, ok: true, operation: request.operation, result });
}
function failure(request, code) {
  parentPort.postMessage({
    protocol: PROTOCOL,
    requestId: REQUEST_ID_RE.test(request?.requestId ?? '') ? request.requestId : 'oaw-0-invalid',
    ok: false,
    operation: typeof request?.operation === 'string' ? request.operation.slice(0, 40) : 'INVALID',
    code,
  });
}
function operationFailure(request, error) {
  const code = ['WORKER_RESOURCE_LIMIT_INVALID', 'WORKER_ENV_INVALID', 'STORE_UNAVAILABLE', 'QUEUE_FULL']
    .includes(error?.code) ? error.code : 'OPERATION_FAILED';
  failure(request, code);
}

if (!isMainThread && parentPort) {
  let store = null; let adapter = null; let startupFailure = resourceError() ?? configError(workerData);
  if (startupFailure === null) {
    try {
      store = openOpportunityAuditStore({ rootDir: workerData.rootDir });
      adapter = createOpportunityAuditWideEyePort({
        store,
        sampleSize: workerData.sampleSize,
        horizonsMs: workerData.horizonsMs,
        minFrameIntervalMs: workerData.minFrameIntervalMs,
        wideEyeComponent: workerData.wideEyeComponent,
      });
    } catch {
      startupFailure = 'STORE_UNAVAILABLE';
    }
  }

  let closing = false; let failed = startupFailure;
  let pendingBatch = null; let operationTail = Promise.resolve();

  const processBatch = async (queued) => {
    try {
      const result = await adapter.afterSweep(queued.batch);
      parentPort.postMessage({
        protocol: PROTOCOL, event: 'BATCH_COMMITTED', queueId: queued.queueId,
        result: {
          frameId: result.frameId, storeRevision: result.storeRevision,
          annotationsPresent: result.annotationsPresent,
        },
      });
    } catch (error) {
      failed = 'OPERATION_FAILED';
      parentPort.postMessage({ protocol: PROTOCOL, event: 'BATCH_FAILED', queueId: queued.queueId, code: error?.code ?? 'OPERATION_FAILED' });
    } finally {
      if (pendingBatch?.queueId === queued.queueId) pendingBatch = null;
    }
  };

  parentPort.on('message', (request) => {
    if (!exact(request, REQUEST_KEYS) || request.protocol !== PROTOCOL
        || !REQUEST_ID_RE.test(request.requestId ?? '') || !boundedTree(request)) {
      failure(request, 'REQUEST_INVALID'); return;
    }
    if (closing) { failure(request, 'PORT_STOPPED'); return; }

    // CLOSE is always accepted through the serialized tail, including after a
    // semantic/store failure, so a responsive worker releases its lock. Only a
    // watchdog/physical failure forces termination without cleanup.
    if (request.operation === 'CLOSE') {
      if (!exact(request.payload, [])) { failure(request, 'REQUEST_INVALID'); return; }
      closing = true;
      operationTail = operationTail.then(async () => {
        try {
          if (store !== null) await store.close();
          response(request, { status: 'CLOSED' });
        } catch { failure(request, 'OPERATION_FAILED'); }
        finally { parentPort.close(); }
      }).catch(() => { parentPort.close(); });
      return;
    }

    if (failed !== null) { failure(request, failed); return; }

    if (request.operation === 'QUEUE_AFTER_SWEEP') {
      if (!exact(request.payload, ['queueId', 'batch']) || !QUEUE_ID_RE.test(request.payload.queueId ?? '')
          || request.payload.queueId !== `oaq-${sha256(request.payload.batch).slice(0, 40)}`) {
        failure(request, 'REQUEST_INVALID'); return;
      }
      if (pendingBatch !== null) { failure(request, 'QUEUE_FULL'); return; }
      pendingBatch = { queueId: request.payload.queueId, batch: request.payload.batch };
      const queued = pendingBatch;
      operationTail = operationTail
        .then(() => new Promise((resolve) => setImmediate(resolve)))
        .then(() => processBatch(queued))
        .catch(() => { failed = 'OPERATION_FAILED'; });
      // This receipt is intentionally sent before processBatch performs any
      // store mutation. It is queue custody, not a durability receipt.
      response(request, {
        status: 'QUEUED_NOT_COMMITTED', queueId: queued.queueId,
        queuedRows: queued.batch.observation.rows.length,
        persistence: 'WORKER_MEMORY_PENDING',
      });
      return;
    }

    if (request.operation === 'BEFORE_SWEEP') {
      if (!exact(request.payload, ['catalogSnapshot', 'frameTs']) || pendingBatch !== null) {
        failure(request, pendingBatch !== null ? 'WORKER_BUSY' : 'REQUEST_INVALID'); return;
      }
      operationTail = operationTail.then(async () => {
        try {
          const token = await adapter.beforeSweep(request.payload);
          response(request, token === null
            ? { status: 'CADENCE_SKIPPED', token: null }
            : { status: 'DURABLE_FRAME', token });
        } catch (error) { operationFailure(request, error); }
      }).catch(() => { failed = 'OPERATION_FAILED'; });
      return;
    }

    failure(request, 'REQUEST_INVALID');
  });
}
