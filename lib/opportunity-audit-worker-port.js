// Fixed-worker boundary for the prospective WideEye opportunity audit.
//
// The parent never opens the audit store. beforeSweep waits for a durable
// frame receipt from the worker; afterSweep only acknowledges bounded in-memory
// queue custody. The later fsync result is asynchronous status, never implied
// by QUEUED_NOT_COMMITTED. Bounded schema projection, cloning and hashing still
// run synchronously in the parent; this boundary isolates durable store I/O,
// not every byte of admission work.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2,
  opportunityAuditPendingItemV2Error,
  opportunityAuditSettlementReceiptV2Error,
} from '../learning/opportunity-audit-followup.js';

export const OPPORTUNITY_AUDIT_WORKER_PORT_VERSION = 'opportunity-audit-worker-port-2';
export const OPPORTUNITY_AUDIT_WORKER_PROTOCOL = 'opportunity-audit-worker-2';
export const OPPORTUNITY_AUDIT_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 96,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
});
export const OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const OPPORTUNITY_AUDIT_WORKER_MAX_MARKETS = 5_000;
export const OPPORTUNITY_AUDIT_WORKER_MAX_ROWS = 5_000;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 35_000;
const MAX_TIMEOUT_MS = 60_000;
const TOKEN_KEYS = Object.freeze(['tokenVersion', 'tokenDigest', 'frameId', 'frameDigest', 'catalogContentId', 'frameTs']);
const MARKET_KEYS = Object.freeze(['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status']);
const COMPONENT_KEYS = Object.freeze(['componentId', 'version', 'configDigest']);
const UNEVALUATED_ROW_KEYS = Object.freeze(['coin', 'evaluated', 'reason']);
const EVALUATED_ROW_KEYS = Object.freeze([
  'coin', 'evaluated', 'zVol', 'zRet', 'extension', 'preCooldownVerdict',
  'cooldownSuppressed', 'noticeEmitted', 'usdVol24h', 'inDeepTape',
]);
const PENDING_ITEM_KEYS = Object.freeze([
  'cursor', 'frameId', 'frameDigest', 'opportunityId', 'canonicalCoin', 'horizonMs', 'dueTs',
  'lastOutcomeId', 'lastStatus', 'annotationPresent', 'observationInclusionProbability', 'actionPropensity',
]);
const HEX64_RE = /^[a-f0-9]{64}$/;
const CONTENT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const FAILURE_CODES = new Set([
  'REQUEST_INVALID', 'MESSAGE_TOO_LARGE', 'WORKER_TIMEOUT', 'BATCH_TIMEOUT',
  'WORKER_ERROR', 'WORKER_EXITED', 'WORKER_EXIT_TIMEOUT', 'WORKER_RESOURCE_LIMIT_INVALID',
  'WORKER_ENV_INVALID', 'STORE_UNAVAILABLE', 'OPERATION_FAILED', 'QUEUE_FULL',
  'RESPONSE_INVALID', 'PORT_STOPPED', 'PORT_LATCHED', 'WORKER_BUSY',
]);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const safeTs = (value) => Number.isSafeInteger(value) && value >= 0;
const safePositive = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;
const contentId = (value) => typeof value === 'string' && CONTENT_ID_RE.test(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const clone = (value) => structuredClone(value);
const bytes = (value) => Buffer.byteLength(canonicalJson(value), 'utf8');

export class OpportunityAuditWorkerPortError extends Error {
  constructor(code, detail = code) {
    super(`opportunity audit worker port: ${code}: ${String(detail).slice(0, 300)}`);
    this.name = 'OpportunityAuditWorkerPortError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new OpportunityAuditWorkerPortError(code, detail); };

function boundedTimeout(value, fallback, name) {
  const timeout = value === undefined ? fallback : value;
  if (!safePositive(timeout) || timeout > MAX_TIMEOUT_MS) fail('CONFIG_INVALID', `${name} must be 1..${MAX_TIMEOUT_MS}ms`);
  return timeout;
}

function componentError(value) {
  return !exact(value, COMPONENT_KEYS) || value.componentId !== 'wideeye'
    || !text(value.version) || !HEX64_RE.test(value.configDigest ?? '')
    ? 'sealed WideEye component identity required' : null;
}

function marketError(market) {
  if (!exact(market, MARKET_KEYS)) return 'catalog market shape malformed';
  if (!text(market.pairKey, 40) || !text(market.nativeBase, 20) || !text(market.nativeQuote, 20)
      || !text(market.wsname, 40) || typeof market.base !== 'string' || !COIN_RE.test(market.base)
      || market.quote !== 'USD' || market.status !== 'online') return 'catalog market identity malformed';
  return null;
}

function projectCatalogSnapshot(value, frameTs) {
  if (!plain(value) || value.status !== 'ACCEPTED' || value.fresh !== true
      || !contentId(value.contentId) || !plain(value.catalog)) {
    fail('REQUEST_INVALID', 'fresh accepted catalog snapshot required');
  }
  const catalog = value.catalog;
  if (catalog.venue !== 'kraken' || catalog.quote !== 'USD' || catalog.policyVersion !== 1
      || !safeTs(catalog.observedTs) || catalog.observedTs > frameTs
      || catalog.contentId !== value.contentId || !Array.isArray(catalog.markets)
      || catalog.markets.length < 1 || catalog.markets.length > OPPORTUNITY_AUDIT_WORKER_MAX_MARKETS
      || !plain(catalog.counts) || catalog.counts.supported !== catalog.markets.length) {
    fail('REQUEST_INVALID', 'catalog identity, clock, count or market bound malformed');
  }
  if (Object.hasOwn(value, 'observedTs') && value.observedTs !== catalog.observedTs) {
    fail('REQUEST_INVALID', 'catalog wrapper clock mismatch');
  }
  const markets = [];
  const bases = new Set(); const pairs = new Set();
  for (const market of catalog.markets) {
    const problem = marketError(market); if (problem) fail('REQUEST_INVALID', problem);
    if (bases.has(market.base) || pairs.has(market.pairKey)) fail('REQUEST_INVALID', 'catalog identity duplicated');
    bases.add(market.base); pairs.add(market.pairKey);
    markets.push(Object.fromEntries(MARKET_KEYS.map((key) => [key, market[key]])));
  }
  const projected = {
    status: 'ACCEPTED', fresh: true, contentId: value.contentId,
    catalog: {
      venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion,
      observedTs: catalog.observedTs, contentId: catalog.contentId,
      counts: { supported: markets.length }, markets,
    },
  };
  if (bytes(projected) > OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES) fail('MESSAGE_TOO_LARGE');
  return projected;
}

function tokenError(token) {
  if (!exact(token, TOKEN_KEYS) || token.tokenVersion !== 'opportunity-audit-wideeye-token-1'
      || typeof token.tokenDigest !== 'string' || !HEX64_RE.test(token.tokenDigest)
      || typeof token.frameId !== 'string' || !/^oaf-[a-f0-9]{40}$/.test(token.frameId)
      || typeof token.frameDigest !== 'string' || !HEX64_RE.test(token.frameDigest)
      || !contentId(token.catalogContentId)
      || !safeTs(token.frameTs)) return 'token malformed';
  const core = clone(token); delete core.tokenDigest;
  return token.tokenDigest === sha256(core) ? null : 'token digest mismatch';
}

function rowError(row) {
  if (!plain(row) || typeof row.coin !== 'string' || !COIN_RE.test(row.coin) || typeof row.evaluated !== 'boolean') return 'row identity malformed';
  if (!row.evaluated) {
    return exact(row, UNEVALUATED_ROW_KEYS)
      && ['NO_TICKER_ROW', 'PRICE_INVALID', 'INSUFFICIENT_SERIES'].includes(row.reason)
      ? null : 'unevaluated row malformed';
  }
  if (!exact(row, EVALUATED_ROW_KEYS)
      || ![row.zVol, row.zRet, row.extension].every((item) => item === null || finite(item))
      || !(row.preCooldownVerdict === null || ['RIPPLE', 'MISSED'].includes(row.preCooldownVerdict))
      || typeof row.cooldownSuppressed !== 'boolean' || typeof row.noticeEmitted !== 'boolean'
      || !(row.usdVol24h === null || (finite(row.usdVol24h) && row.usdVol24h >= 0))
      || typeof row.inDeepTape !== 'boolean') return 'evaluated row malformed';
  if (row.noticeEmitted && (row.preCooldownVerdict === null || row.cooldownSuppressed)) return 'notice state malformed';
  return null;
}

function projectAfterInput({ auditToken, observation, recordedTs } = {}) {
  const tokenProblem = tokenError(auditToken); if (tokenProblem) fail('REQUEST_INVALID', tokenProblem);
  if (!safeTs(recordedTs) || !exact(observation, ['sweepId', 'catalogContentId', 'observedTs', 'rows'])
      || !text(observation.sweepId) || observation.catalogContentId !== auditToken.catalogContentId
      || !safeTs(observation.observedTs) || observation.observedTs < auditToken.frameTs
      || observation.observedTs > recordedTs || !Array.isArray(observation.rows)
      || observation.rows.length > OPPORTUNITY_AUDIT_WORKER_MAX_ROWS) {
    fail('REQUEST_INVALID', 'sweep envelope malformed');
  }
  const rows = []; const seen = new Set();
  for (const row of observation.rows) {
    const problem = rowError(row); if (problem) fail('REQUEST_INVALID', problem);
    if (seen.has(row.coin)) fail('REQUEST_INVALID', 'sweep row duplicated');
    seen.add(row.coin); rows.push(clone(row));
  }
  const projected = { auditToken: clone(auditToken), observation: { ...clone(observation), rows }, recordedTs };
  if (bytes(projected) > OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES) fail('MESSAGE_TOO_LARGE');
  return projected;
}

function pendingItemError(item) {
  if (item?.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2) return opportunityAuditPendingItemV2Error(item);
  return !exact(item, PENDING_ITEM_KEYS) || !text(item.cursor, 2_000)
    || !/^oaf-[a-f0-9]{40}$/.test(item.frameId ?? '') || !HEX64_RE.test(item.frameDigest ?? '')
    || !/^lop-[a-f0-9]{40}$/.test(item.opportunityId ?? '') || !COIN_RE.test(item.canonicalCoin ?? '')
    || !safePositive(item.horizonMs) || !safeTs(item.dueTs)
    || !(item.lastOutcomeId === null || /^oao-[a-f0-9]{40}$/.test(item.lastOutcomeId ?? ''))
    || !(item.lastStatus === null || item.lastStatus === 'PENDING') || typeof item.annotationPresent !== 'boolean'
    || typeof item.observationInclusionProbability !== 'number' || item.observationInclusionProbability <= 0
    || item.observationInclusionProbability > 1
    || !exact(item.actionPropensity, ['state', 'value', 'policyVersion'])
    || item.actionPropensity.state !== 'NOT_LOGGED' || item.actionPropensity.value !== null
    || item.actionPropensity.policyVersion !== null;
}

function requestEnvelope(requestId, operation, payload) {
  return { protocol: OPPORTUNITY_AUDIT_WORKER_PROTOCOL, requestId, operation, payload };
}

function workerFactory(workerData) {
  return new Worker(new URL('../tools/opportunity-audit-worker.mjs', import.meta.url), {
    workerData,
    resourceLimits: OPPORTUNITY_AUDIT_WORKER_RESOURCE_LIMITS,
    env: {},
  });
}

function createPort(options = {}, startWorker = workerFactory) {
  const optionKeys = new Set([
    'enabled', 'rootDir', 'sampleSize', 'horizonsMs', 'minFrameIntervalMs',
    'maxLabelDelayMs', 'wideEyeComponent', 'requestTimeoutMs', 'batchTimeoutMs', 'closeTimeoutMs',
  ]);
  if (!plain(options) || Object.keys(options).some((key) => !optionKeys.has(key))) {
    fail('CONFIG_INVALID', 'unknown option');
  }
  const {
    enabled = false, rootDir = null, sampleSize = 4, horizonsMs = [60 * 60 * 1000],
    minFrameIntervalMs = 15 * 60 * 1000, maxLabelDelayMs = null, wideEyeComponent = null,
    requestTimeoutMs: suppliedRequestTimeoutMs, batchTimeoutMs: suppliedBatchTimeoutMs,
    closeTimeoutMs: suppliedCloseTimeoutMs,
  } = options;
  if (typeof enabled !== 'boolean') fail('CONFIG_INVALID', 'enabled must be boolean');
  if (!enabled) {
    const disabled = Object.freeze({
      portVersion: OPPORTUNITY_AUDIT_WORKER_PORT_VERSION, enabled: false, state: 'DISABLED',
      workerLive: false, workerStarts: 0, workerExits: 0, pendingRequest: false,
      pendingAnnotation: null, lastDurableFrameId: null, lastCommittedBatch: null,
      lastFailedBatch: null, lastUnknownBatch: null, failed: null, forcedTermination: false,
      authority: 'NONE', trainingAuthority: 'NONE', runtimeWired: false,
    });
    return Object.freeze({
      beforeSweep: async () => null,
      afterSweep: async () => fail('DISABLED'),
      pending: async () => fail('DISABLED'),
      settle: async () => fail('DISABLED'),
      status: () => disabled,
      close: async () => ({
        stopped: true, physicalExit: true, drained: true, annotationOutcome: 'NONE',
      }),
    });
  }
  if (typeof startWorker !== 'function' || typeof rootDir !== 'string' || rootDir.length === 0
      || rootDir.length > 4096 || !path.isAbsolute(rootDir) || path.resolve(rootDir) === path.parse(path.resolve(rootDir)).root
      || !safePositive(sampleSize) || sampleSize > 8 || !Array.isArray(horizonsMs)
      || horizonsMs.length < 1 || horizonsMs.length > 16 || horizonsMs.some((item) => !safePositive(item))
      || !(maxLabelDelayMs === null || (safePositive(maxLabelDelayMs) && maxLabelDelayMs >= 60_000
        && maxLabelDelayMs <= 30 * 24 * 60 * 60 * 1000))
      || !safePositive(minFrameIntervalMs) || minFrameIntervalMs < 60_000 || minFrameIntervalMs > 86_400_000
      || componentError(wideEyeComponent)) fail('CONFIG_INVALID');
  const requestTimeoutMs = boundedTimeout(suppliedRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
  const batchTimeoutMs = boundedTimeout(suppliedBatchTimeoutMs, DEFAULT_BATCH_TIMEOUT_MS, 'batchTimeoutMs');
  const closeTimeoutMs = boundedTimeout(suppliedCloseTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 'closeTimeoutMs');
  const workerConfig = Object.freeze({
    protocol: OPPORTUNITY_AUDIT_WORKER_PROTOCOL, rootDir: path.resolve(rootDir), sampleSize,
    horizonsMs: [...horizonsMs], maxLabelDelayMs, minFrameIntervalMs, wideEyeComponent: clone(wideEyeComponent),
  });

  let worker = null; let workerLive = false; let resolveClosed = null; let closedPromise = Promise.resolve();
  let workerStarts = 0; let workerExits = 0; let requestCounter = 0; let pendingRequest = null;
  let pendingAnnotation = null; let batchTimer = null; let lastDurableFrameId = null;
  let lastCommittedBatch = null; let lastFailedBatch = null; let lastUnknownBatch = null; let failed = null;
  let closing = false; let stopped = false; let closePromise = null;
  let forcedTermination = false;

  const markPendingUnknown = () => {
    if (pendingAnnotation === null) return;
    lastUnknownBatch = Object.freeze({
      queueId: pendingAnnotation.queueId, frameId: pendingAnnotation.frameId,
      queuedRows: pendingAnnotation.queuedRows,
      reason: 'WORKER_EXITED_BEFORE_CONFIRMATION',
    });
    pendingAnnotation = null;
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  };
  const closeView = (isStopped, physicalExit, reason = null) => {
    const annotationOutcome = lastUnknownBatch ? 'UNKNOWN'
      : lastFailedBatch ? 'FAILED' : lastCommittedBatch ? 'COMMITTED' : 'NONE';
    const view = {
      stopped: isStopped, physicalExit,
      drained: physicalExit && annotationOutcome !== 'UNKNOWN' && annotationOutcome !== 'FAILED',
      annotationOutcome,
    };
    return reason === null ? view : { ...view, reason };
  };

  const latch = (code, terminate = true) => {
    if (failed === null) failed = { code: FAILURE_CODES.has(code) ? code : 'WORKER_ERROR' };
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (pendingRequest) {
      const current = pendingRequest; pendingRequest = null; clearTimeout(current.timer);
      current.reject(new OpportunityAuditWorkerPortError(failed.code));
      current.resolveSettled();
    }
    if (terminate && worker && workerLive) {
      forcedTermination = true;
      worker.terminate().catch(() => {});
    }
  };

  const handleMessage = (message) => {
    if (stopped || (failed && pendingRequest?.operation !== 'CLOSE')) return;
    if (message?.protocol !== OPPORTUNITY_AUDIT_WORKER_PROTOCOL) { latch('RESPONSE_INVALID'); return; }
    if (message.event === 'BATCH_COMMITTED') {
      if (!exact(message, ['protocol', 'event', 'queueId', 'result'])
          || !pendingAnnotation || message.queueId !== pendingAnnotation.queueId
          || !plain(message.result) || message.result.frameId !== pendingAnnotation.frameId
          || !Number.isSafeInteger(message.result.storeRevision) || message.result.storeRevision < 0
          || message.result.annotationsPresent !== sampleSize) {
        latch('RESPONSE_INVALID'); return;
      }
      if (batchTimer) clearTimeout(batchTimer); batchTimer = null;
      lastCommittedBatch = Object.freeze({
        queueId: message.queueId, frameId: message.result.frameId,
        storeRevision: message.result.storeRevision, annotationsPresent: message.result.annotationsPresent,
      });
      pendingAnnotation = null;
      return;
    }
    if (message.event === 'BATCH_FAILED') {
      if (!exact(message, ['protocol', 'event', 'queueId', 'code'])
          || !pendingAnnotation || message.queueId !== pendingAnnotation.queueId || !text(message.code, 100)) {
        latch('RESPONSE_INVALID'); return;
      }
      if (batchTimer) clearTimeout(batchTimer); batchTimer = null;
      lastFailedBatch = Object.freeze({ queueId: message.queueId, code: 'OPERATION_FAILED' });
      pendingAnnotation = null;
      if (failed === null) failed = { code: 'OPERATION_FAILED' };
      return;
    }
    if (!pendingRequest || !exact(message, ['protocol', 'requestId', 'ok', 'operation', ...(message?.ok === true ? ['result'] : ['code'])])
        || message.requestId !== pendingRequest.requestId || message.operation !== pendingRequest.operation) {
      latch('RESPONSE_INVALID'); return;
    }
    const current = pendingRequest; pendingRequest = null; clearTimeout(current.timer);
    if (message.ok !== true) {
      const code = FAILURE_CODES.has(message.code) ? message.code : 'OPERATION_FAILED';
      failed = { code }; current.reject(new OpportunityAuditWorkerPortError(code)); current.resolveSettled();
      return;
    }
    current.resolve(message.result); current.resolveSettled();
  };

  const ensureWorker = (allowClosing = false, allowFailed = false) => {
    if (stopped || (closing && !allowClosing)) fail('PORT_STOPPED');
    if (failed && !allowFailed) fail('PORT_LATCHED', failed.code);
    if (workerLive) return;
    try {
      worker = startWorker(workerConfig);
      if (!worker || typeof worker.on !== 'function' || typeof worker.postMessage !== 'function'
          || typeof worker.terminate !== 'function') fail('WORKER_ERROR');
    } catch (error) {
      failed = { code: error?.code === 'CONFIG_INVALID' ? error.code : 'WORKER_ERROR' };
      throw new OpportunityAuditWorkerPortError(failed.code);
    }
    workerLive = true; workerStarts += 1;
    closedPromise = new Promise((resolve) => { resolveClosed = resolve; });
    worker.on('message', handleMessage);
    worker.once('error', () => latch('WORKER_ERROR'));
    worker.once('exit', (code) => {
      if (!workerLive) return;
      markPendingUnknown();
      workerLive = false; workerExits += 1; resolveClosed?.(); resolveClosed = null;
      if (closing) stopped = true;
      if (pendingRequest) {
        const current = pendingRequest; pendingRequest = null; clearTimeout(current.timer);
        const exitCode = code === 0 ? 'WORKER_EXITED' : 'WORKER_ERROR';
        if (failed === null) failed = { code: exitCode };
        current.reject(new OpportunityAuditWorkerPortError(exitCode)); current.resolveSettled();
      } else if (!closing && !stopped && failed === null) {
        failed = { code: code === 0 ? 'WORKER_EXITED' : 'WORKER_ERROR' };
      }
    });
  };

  const rpc = (operation, payload, timeoutMs = requestTimeoutMs, allowClosing = false, allowFailed = false, requireExisting = false) => {
    if (requireExisting) {
      if (stopped || (closing && !allowClosing)) fail('PORT_STOPPED');
      if (failed && !allowFailed) fail('PORT_LATCHED', failed.code);
      if (!workerLive || worker === null) fail('WORKER_EXITED');
    } else {
      ensureWorker(allowClosing, allowFailed);
    }
    if (pendingRequest) return Promise.reject(new OpportunityAuditWorkerPortError('WORKER_BUSY'));
    const requestId = `oaw-${process.pid}-${(++requestCounter).toString(36)}`;
    const message = requestEnvelope(requestId, operation, payload);
    if (bytes(message) > OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES) return Promise.reject(new OpportunityAuditWorkerPortError('MESSAGE_TOO_LARGE'));
    let resolveSettled;
    const settled = new Promise((resolve) => { resolveSettled = resolve; });
    const task = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { latch('WORKER_TIMEOUT'); }, timeoutMs); timer.unref?.();
      pendingRequest = { requestId, operation, resolve, reject, timer, settled, resolveSettled };
      try { worker.postMessage(message); } catch { latch('WORKER_ERROR'); }
    });
    return task;
  };

  const beforeSweep = async ({ catalogSnapshot, frameTs } = {}) => {
    if (!safeTs(frameTs)) fail('REQUEST_INVALID', 'frameTs malformed');
    const projected = projectCatalogSnapshot(catalogSnapshot, frameTs);
    const result = await rpc('BEFORE_SWEEP', { catalogSnapshot: projected, frameTs });
    if (exact(result, ['status', 'token']) && result.status === 'CADENCE_SKIPPED' && result.token === null) return null;
    if (!exact(result, ['status', 'token']) || result.status !== 'DURABLE_FRAME' || tokenError(result.token)
        || result.token.frameTs !== frameTs || result.token.catalogContentId !== projected.contentId) {
      latch('RESPONSE_INVALID'); fail('RESPONSE_INVALID');
    }
    lastDurableFrameId = result.token.frameId;
    return Object.freeze(clone(result.token));
  };

  const afterSweep = async (input = {}) => {
    if (pendingAnnotation) fail('QUEUE_FULL', 'one durable annotation batch is already pending');
    const projected = projectAfterInput(input);
    const queueId = `oaq-${sha256(projected).slice(0, 40)}`;
    const result = await rpc('QUEUE_AFTER_SWEEP', { queueId, batch: projected });
    if (!exact(result, ['status', 'queueId', 'queuedRows', 'persistence'])
        || result.status !== 'QUEUED_NOT_COMMITTED' || result.queueId !== queueId
        || !Number.isSafeInteger(result.queuedRows) || result.queuedRows !== projected.observation.rows.length
        || result.persistence !== 'WORKER_MEMORY_PENDING') {
      latch('RESPONSE_INVALID'); fail('RESPONSE_INVALID');
    }
    pendingAnnotation = Object.freeze({
      queueId, frameId: projected.auditToken.frameId,
      queuedRows: result.queuedRows, acceptedTs: Date.now(),
    });
    batchTimer = setTimeout(() => latch('BATCH_TIMEOUT'), batchTimeoutMs); batchTimer.unref?.();
    return Object.freeze({
      portVersion: OPPORTUNITY_AUDIT_WORKER_PORT_VERSION,
      status: 'QUEUED_NOT_COMMITTED', queueId, queuedRows: result.queuedRows,
      persistence: 'WORKER_MEMORY_PENDING', authority: 'NONE', trainingAuthority: 'NONE',
    });
  };

  const pending = async ({ asOfTs, limit = 32, cursor = null } = {}) => {
    if (!safeTs(asOfTs) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || !(cursor === null || (typeof cursor === 'string' && cursor.length <= 2_000))) fail('REQUEST_INVALID');
    const result = await rpc('PENDING', { asOfTs, limit, cursor });
    if (!plain(result) || result.asOfTs !== asOfTs || !Array.isArray(result.items)
        || result.items.length > limit || typeof result.truncated !== 'boolean'
        || result.items.some(pendingItemError)
        || !(result.nextCursor === null || (typeof result.nextCursor === 'string' && result.nextCursor.length <= 2_000))) {
      latch('RESPONSE_INVALID'); fail('RESPONSE_INVALID');
    }
    return Object.freeze(clone(result));
  };

  const settle = async ({ item, resolution, asOfTs = null, recordedTs } = {}) => {
    const v2 = item?.itemVersion === OPPORTUNITY_AUDIT_PENDING_ITEM_VERSION_V2;
    if (pendingItemError(item) || !safeTs(recordedTs) || !plain(resolution)
        || (v2 ? !safeTs(asOfTs) || asOfTs > recordedTs : asOfTs !== null)) fail('REQUEST_INVALID');
    const payload = { item: clone(item), resolution: clone(resolution), ...(v2 ? { asOfTs } : {}), recordedTs };
    if (bytes(payload) > OPPORTUNITY_AUDIT_WORKER_MAX_MESSAGE_BYTES) fail('MESSAGE_TOO_LARGE');
    const result = await rpc('SETTLE', payload, batchTimeoutMs);
    if (v2) {
      const problem = opportunityAuditSettlementReceiptV2Error(result, { item, resolution, recordedTs });
      if (problem) { latch('RESPONSE_INVALID'); fail('RESPONSE_INVALID', problem); }
      return Object.freeze(clone(result));
    }
    const validState = ['MATURED', 'MISSING', 'CENSORED', 'DELISTED_OR_UNAVAILABLE', 'UNSUPPORTED', 'PENDING', 'REFUSED'].includes(result?.state);
    if (!exact(result, ['state', 'outcomeId', 'outcomeDigest', 'storeRevision', 'durable']) || !validState
        || !Number.isSafeInteger(result.storeRevision) || result.storeRevision < 0
        || typeof result.durable !== 'boolean'
        || (result.durable && (!/^oao-[a-f0-9]{40}$/.test(result.outcomeId ?? '') || !HEX64_RE.test(result.outcomeDigest ?? '')))
        || (!result.durable && !(result.outcomeId === null && result.outcomeDigest === null && ['PENDING', 'REFUSED'].includes(result.state)))) {
      latch('RESPONSE_INVALID'); fail('RESPONSE_INVALID');
    }
    return Object.freeze(clone(result));
  };

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (!workerLive) { stopped = true; return closeView(true, true); }
      const deadline = performance.now() + closeTimeoutMs;
      const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
      const boundedWait = (promise) => new Promise((resolve) => {
        const waitMs = remaining();
        if (waitMs <= 0) { resolve(false); return; }
        const timer = setTimeout(() => resolve(false), waitMs);
        Promise.resolve(promise).then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
      });
      const physicalTimeout = async () => {
        if (!workerLive) { stopped = true; return closeView(true, true); }
        markPendingUnknown();
        failed = { code: 'WORKER_EXIT_TIMEOUT' }; forcedTermination = true;
        try { worker.terminate().catch(() => {}); } catch {}
        await Promise.resolve();
        // terminate() normally resolves on exit. If a test double or broken
        // runtime does not physically exit, never claim that it did.
        if (workerLive) return closeView(false, false, 'WORKER_EXIT_TIMEOUT');
        stopped = true; return closeView(true, true);
      };
      const requestAtClose = pendingRequest;
      if (requestAtClose && !(await boundedWait(requestAtClose.settled))) return physicalTimeout();
      // The worker may exit while close waits for an earlier request. Closing
      // must never call ensureWorker and silently construct a replacement.
      if (!workerLive) { await closedPromise; stopped = true; return closeView(true, true); }
      if (failed && forcedTermination) {
        if (!(await boundedWait(closedPromise))) return physicalTimeout();
        stopped = true; return closeView(true, true);
      }
      try {
        const result = await rpc('CLOSE', {}, Math.max(1, remaining()), true, true, true);
        if (!exact(result, ['status']) || result.status !== 'CLOSED') latch('RESPONSE_INVALID');
      }
      catch {
        if (workerLive) { forcedTermination = true; worker.terminate().catch(() => {}); }
      }
      if (!(await boundedWait(closedPromise))) return physicalTimeout();
      stopped = true;
      return closeView(true, true);
    })();
    return closePromise;
  };

  const status = () => Object.freeze({
    portVersion: OPPORTUNITY_AUDIT_WORKER_PORT_VERSION, enabled: true,
    state: stopped ? 'STOPPED' : closing ? 'CLOSING' : failed ? 'FAILED' : workerLive ? 'READY' : 'IDLE',
    workerLive, workerStarts, workerExits, pendingRequest: pendingRequest !== null,
    pendingAnnotation: pendingAnnotation === null ? null : clone(pendingAnnotation),
    lastDurableFrameId, lastCommittedBatch, lastFailedBatch, lastUnknownBatch,
    failed: failed === null ? null : { ...failed },
    forcedTermination,
    authority: 'NONE', trainingAuthority: 'NONE', runtimeWired: false,
  });

  return Object.freeze({ beforeSweep, afterSweep, pending, settle, status, close });
}

export function createOpportunityAuditWorkerPort(options = {}) {
  return createPort(options, workerFactory);
}

// TEST ONLY: production always uses the fixed URL above. The factory cannot be
// supplied through createOpportunityAuditWorkerPort.
export function createOpportunityAuditWorkerPortForTest(options = {}, startWorker) {
  if (typeof startWorker !== 'function') fail('CONFIG_INVALID', 'test worker factory required');
  return createPort(options, startWorker);
}
