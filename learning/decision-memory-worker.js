// Authoritative decision-memory reader. All learning-store filesystem work stays
// in this worker thread; the Judge-facing port receives only a bounded,
// structured-cloneable snapshot. A missing learning directory is NOT
// commissioned here: the decision consumer is read-only and fails closed.
import { createHash } from 'node:crypto';
import { isMainThread, parentPort, workerData, resourceLimits } from 'node:worker_threads';
import { readDecisionSourceSnapshot } from './decision-read-snapshot.js';
import { createDecisionSnapshotStore } from './decision-snapshot-store.js';
import { readDecisionMemory } from './memory-view.js';

export const DECISION_MEMORY_WORKER_PROTOCOL = 'learning-decision-memory-worker-2';
export const DECISION_MEMORY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const UNSEALED_ACTIVATION_REASON = 'ACTIVATION_V1_EFFECT_AND_FEATURE_RECIPE_BODY_UNSEALED';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const safeId = (value) => (typeof value === 'string' && value.length > 0 && value.length <= 200 && !/\s/.test(value));
const safeTs = (value) => Number.isSafeInteger(value) && value >= 0;

// Activation v1 prospectively bound a policy digest and a feature recipe name,
// but not the feature recipe body/digest or the rank-effect transform/units.
// Those durable rows remain readable history; they are never retrofitted after
// their outcomes and cannot enter a decision snapshot through this boundary.
export function withholdUnsealedDecisionEffects(memory, sourceProvenance) {
  const activations = Array.isArray(memory?.activations) ? memory.activations : [];
  const prior = Array.isArray(memory?.withheld) ? memory.withheld : [];
  const withheld = [...prior];
  for (const activation of activations) {
    withheld.push({
      activationId: safeId(activation?.activationId) ? activation.activationId : 'UNKNOWN',
      reason: activation?.activationVersion === 'learning-activation-1'
        ? UNSEALED_ACTIVATION_REASON
        : 'ACTIVATION_CONSUMER_CONTRACT_NOT_SUPPORTED',
    });
  }
  return {
    view: memory?.view,
    version: memory?.version,
    law: memory?.law,
    preparedTs: memory?.preparedTs,
    sourceProvenance,
    activations: [],
    withheld,
    kill: memory?.kill,
  };
}

function failure(requestId, code) {
  return { protocol: DECISION_MEMORY_WORKER_PROTOCOL, requestId, ok: false, code };
}

function runRequest(request) {
  const requestId = safeId(request?.requestId) ? request.requestId : 'INVALID';
  if (request?.protocol !== DECISION_MEMORY_WORKER_PROTOCOL || !safeId(request?.requestId)
      || typeof request?.dataDir !== 'string' || request.dataDir.length === 0 || request.dataDir.length > 4096
      || !safeTs(request?.nowTs)) return failure(requestId, 'REQUEST_INVALID');
  try {
    const source = readDecisionSourceSnapshot({ dataDir: request.dataDir });
    if (!source.ok) return failure(requestId, source.code === 'STORE_NOT_COMMISSIONED' ? source.code : 'MEMORY_SOURCE_REFUSED');
    let store;
    try { store = createDecisionSnapshotStore(source, { nowTs: request.nowTs }); }
    catch { return failure(requestId, 'MEMORY_SOURCE_REFUSED'); }
    const snapshot = withholdUnsealedDecisionEffects(
      readDecisionMemory({ store, nowTs: request.nowTs }),
      store.sourceProvenance,
    );
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, 'utf8') > DECISION_MEMORY_MAX_RESPONSE_BYTES) {
      return failure(requestId, 'RESPONSE_TOO_LARGE');
    }
    return {
      protocol: DECISION_MEMORY_WORKER_PROTOCOL,
      requestId,
      ok: true,
      preparedTs: request.nowTs,
      snapshotDigest: sha256(serialized),
      snapshot,
    };
  } catch {
    return failure(requestId, 'MEMORY_READ_FAILED');
  }
}

if (!isMainThread && parentPort) {
  let response;
  // Node CLI V8 heap settings can override constructor resourceLimits. Refuse
  // those ambient overrides and check reported limits before source reads.
  // Native buffers still require the separate physical reader byte caps.
  const heapFlag = /^--(?:max[-_]old[-_]space[-_]size(?:[-_]percentage)?|max[-_]semi[-_]space[-_]size)(?:=|$)/;
  const optionHeapFlag = /(?:^|[\s"'])--(?:max[-_]old[-_]space[-_]size(?:[-_]percentage)?|max[-_]semi[-_]space[-_]size)(?:[=\s"']|$)/;
  const ambientOverride = process.execArgv.some((arg) => heapFlag.test(arg))
    || optionHeapFlag.test(process.env.NODE_OPTIONS ?? '');
  const budgetValid = !ambientOverride && [
    ['maxOldGenerationSizeMb', 64], ['maxYoungGenerationSizeMb', 16], ['stackSizeMb', 4],
  ].every(([key, maximum]) => Number.isFinite(resourceLimits[key]) && resourceLimits[key] > 0 && resourceLimits[key] <= maximum);
  try { response = budgetValid ? runRequest(workerData) : failure(safeId(workerData?.requestId) ? workerData.requestId : 'INVALID', 'WORKER_RESOURCE_LIMIT_INVALID'); }
  catch { response = failure(safeId(workerData?.requestId) ? workerData.requestId : 'INVALID', 'MEMORY_READ_FAILED'); }
  parentPort.postMessage(response);
}
