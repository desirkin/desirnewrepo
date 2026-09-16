// Durable checkpoint authority for external request budgets. PostgreSQL is
// authoritative; filesystem checkpoints are accepted only once as explicit
// commissioning input when no durable row exists. A missing checkpoint never
// means zero usage.
import { canonicalJson } from './schema.js';

export const EXTERNAL_CHECKPOINT_STORE_VERSION = 'external-checkpoint-store-1';
export const EXTERNAL_CHECKPOINT_RECORD_VERSION = 'external-checkpoint-record-1';
export const MAX_EXTERNAL_CHECKPOINT_BYTES = 20 * 1024 * 1024;
export const EXTERNAL_CHECKPOINT_LOCK = 'serpent:data-only-external-checkpoint:v1';
export const EXTERNAL_CHECKPOINT_IDS = Object.freeze({
  // PUBLISH-FIX-4: bumped v1 -> v2 (as discovery was in PF1-4). A previous app's
  // v1 row is a different-shape / different-generation account; it is left
  // untouched and ignored, and the v2 namespace commissions fresh at zero
  // (BIRTH_ZERO_BUDGET) rather than rejecting the old row as CHECKPOINT_INVALID.
  // These carry a ZERO ceiling (no paid calls), so a fresh namespace loses no
  // spend authority. Paid namespaces stay v1 and explicit.
  DATA_ONLY: 'external_quota:data-only:v2',
  MARKET: 'external_quota:market:v2',
});

const ID_RE = /^external_quota:[a-z0-9][a-z0-9_-]{0,63}:v[1-9][0-9]*$/;
const bounded = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const clone = (value) => structuredClone(value);
const isTs = (value) => Number.isSafeInteger(value) && value >= 0;

export class ExternalCheckpointError extends Error {
  constructor(code, message, checkpointId = null) {
    super(`${code}: ${bounded(message)}`);
    this.name = 'ExternalCheckpointError';
    this.code = code;
    this.checkpointId = checkpointId;
  }
}

function validationError(validate, value) {
  let result;
  try { result = validate(clone(value)); }
  catch (error) { return bounded(error?.message ?? error) || 'validator threw'; }
  if (result === true || result === null || result?.ok === true) return null;
  if (typeof result === 'string' && result.length) return bounded(result);
  if (result?.ok === false) {
    const detail = Array.isArray(result.errors) ? result.errors.join('; ') : result.error ?? 'invalid checkpoint';
    return bounded(detail);
  }
  return 'validator did not explicitly accept the checkpoint';
}

function jsonValueError(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return 'checkpoint is not a JSON value';
    if (Buffer.byteLength(encoded) > MAX_EXTERNAL_CHECKPOINT_BYTES) return 'checkpoint exceeds the durable size bound';
    const roundTrip = JSON.parse(encoded);
    if (canonicalJson(roundTrip) !== canonicalJson(value)) return 'checkpoint is not lossless JSON';
    return null;
  } catch {
    return 'checkpoint is not serializable JSON';
  }
}

function commissioningError(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'commissioning metadata is required';
  if (typeof meta.reason !== 'string' || !meta.reason.trim() || meta.reason.length > 180) return 'commissioning reason must be 1..180 characters';
  if (!isTs(meta.ts)) return 'commissioning timestamp must be a non-negative integer';
  return null;
}

function recordError(record, id) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'durable checkpoint record is not an object';
  if (record.v !== EXTERNAL_CHECKPOINT_RECORD_VERSION || record.id !== id) return 'durable checkpoint record identity/version mismatch';
  if (!['FILESYSTEM_IMPORT', 'EXPLICIT_COMMISSION'].includes(record.commissioning?.mode)) return 'durable checkpoint commissioning mode invalid';
  return commissioningError(record.commissioning);
}

const makeRecord = (id, checkpoint, commissioning) => ({
  v: EXTERNAL_CHECKPOINT_RECORD_VERSION,
  id,
  checkpoint: clone(checkpoint),
  commissioning: { mode: commissioning.mode, reason: commissioning.reason.trim(), ts: commissioning.ts },
});

export async function openExternalCheckpointStore({
  persistence,
  lockName = EXTERNAL_CHECKPOINT_LOCK,
  log = () => {},
  // PUBLISH-FIX-1: production PostgreSQL times out intermittently (ETIMEDOUT), which was latching a checkpoint on the first
  // failure and killing the sweep. Retry the durable write with bounded backoff before declaring it failed; the underlying
  // error code rides into the CHECKPOINT_WRITE_FAILED message. The fail-closed law is unchanged: after the last attempt the
  // checkpoint latches and no further mutations are permitted (authority is DATA_ONLY, collectors only). `sleep` is injected
  // so tests exercise the retries without real delay.
  writeRetries = 3,
  writeRetryBackoffMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!persistence || typeof persistence.health !== 'function' || !persistence.db || !persistence.repo) {
    throw new ExternalCheckpointError('PERSISTENCE_INVALID', 'a started persistence runtime is required');
  }
  const health = persistence.health();
  if (health?.databaseConfigured !== true || health?.restored !== true) {
    throw new ExternalCheckpointError('PERSISTENCE_RESTORE_REQUIRED', `PostgreSQL restore is not complete (${health?.failureCategory ?? 'UNAVAILABLE'})`);
  }
  if (typeof persistence.db.acquireSessionLock !== 'function') {
    throw new ExternalCheckpointError('LOCK_UNAVAILABLE', 'the persistence database has no session-lock API');
  }
  let lock;
  try { lock = await persistence.db.acquireSessionLock(lockName); }
  catch (error) { throw new ExternalCheckpointError('LOCK_FAILED', error?.code ?? error?.message ?? error); }
  if (!lock) throw new ExternalCheckpointError('LOCK_HELD_ELSEWHERE', 'another external-checkpoint owner is active');

  const entries = new Map();
  let closed = false;
  let closing = false;
  let closePromise = null;
  let globalFailure = null;
  const failures = new Map();

  const latch = (error, checkpointId = null, { global = false } = {}) => {
    const safe = error instanceof ExternalCheckpointError
      ? error
      : new ExternalCheckpointError('CHECKPOINT_IO_FAILED', error?.code ?? error?.message ?? error, checkpointId);
    const failure = Object.freeze({ code: safe.code, message: bounded(safe.message), checkpointId: safe.checkpointId ?? checkpointId, ts: Date.now() });
    if (global || checkpointId === null) {
      if (!globalFailure) globalFailure = failure;
    } else if (!failures.has(checkpointId)) {
      failures.set(checkpointId, failure);
    }
    log(`EXTERNAL CHECKPOINT BLOCKED: ${failure.code} ${failure.checkpointId ?? ''}`.trim());
    return safe;
  };
  const assertLive = (checkpointId = null, { acceptedBeforeClose = false } = {}) => {
    if (closed) throw new ExternalCheckpointError('STORE_CLOSED', 'external checkpoint store is closed', checkpointId);
    if (closing && !acceptedBeforeClose) throw new ExternalCheckpointError('STORE_CLOSING', 'external checkpoint store is draining accepted mutations', checkpointId);
    if (globalFailure) throw new ExternalCheckpointError('STORE_LATCHED', `${globalFailure.code}; no further checkpoint mutations permitted`, checkpointId);
    const checkpointFailure = checkpointId === null ? null : failures.get(checkpointId);
    if (checkpointFailure) throw new ExternalCheckpointError('CHECKPOINT_LATCHED', `${checkpointFailure.code}; no further mutations permitted for this checkpoint`, checkpointId);
    if (typeof lock.held !== 'function' || !lock.held()) throw latch(new ExternalCheckpointError('LOCK_LOST', 'external checkpoint owner lock was lost', checkpointId), checkpointId, { global: true });
  };

  // Retry a durable write up to `writeRetries` times with linear backoff; on every failed attempt but the last, log the
  // underlying error code and retry. After the last attempt the raw error is re-thrown (carrying `.attempts`) so the caller
  // latches CHECKPOINT_WRITE_FAILED fail-closed. Only the WRITE call is retried — a CAS/content conflict is a separate,
  // non-retried verdict below.
  async function saveWithRetry(id, doSave) {
    let lastError = null;
    for (let attempt = 1; attempt <= writeRetries; attempt += 1) {
      try { return await doSave(); }
      catch (error) {
        lastError = error;
        if (attempt < writeRetries) {
          log(`external checkpoint ${id}: durable write attempt ${attempt}/${writeRetries} failed (${bounded(error?.code ?? error?.message ?? error)}); retrying`);
          await sleep(writeRetryBackoffMs * attempt);
        }
      }
    }
    throw Object.assign(lastError instanceof Error ? lastError : new Error(String(lastError)), { attempts: writeRetries });
  }
  const writeFailureDetail = (error) => `${bounded(error?.code ?? error?.message ?? error)} after ${error?.attempts ?? writeRetries} attempt(s)`;

  async function persist(entry, next, { acceptedBeforeClose = false } = {}) {
    assertLive(entry.id, { acceptedBeforeClose });
    const jsonError = jsonValueError(next);
    if (jsonError) throw latch(new ExternalCheckpointError('CHECKPOINT_INVALID', jsonError, entry.id), entry.id);
    const invalid = validationError(entry.validate, next);
    if (invalid) throw latch(new ExternalCheckpointError('CHECKPOINT_INVALID', invalid, entry.id), entry.id);
    const record = makeRecord(entry.id, next, entry.commissioning);
    let saved;
    try { saved = await saveWithRetry(entry.id, () => persistence.repo.saveRuntimeState(entry.id, record, entry.revision)); }
    catch (error) { throw latch(new ExternalCheckpointError('CHECKPOINT_WRITE_FAILED', writeFailureDetail(error), entry.id), entry.id); }
    if (!saved || saved.conflict === true || saved.revision !== entry.revision + 1) {
      throw latch(new ExternalCheckpointError('CHECKPOINT_CAS_CONFLICT', 'durable revision did not advance exactly from the owned revision', entry.id), entry.id);
    }
    if (canonicalJson(saved.state) !== canonicalJson(record)) {
      throw latch(new ExternalCheckpointError('CHECKPOINT_CONTENT_CONFLICT', 'database did not confirm the proposed checkpoint', entry.id), entry.id);
    }
    entry.revision = saved.revision;
    entry.state = clone(saved.state.checkpoint);
    if (!lock.held()) throw latch(new ExternalCheckpointError('LOCK_LOST', 'owner lock was lost after the durable write; reservation stays charged and dispatch is blocked', entry.id), entry.id, { global: true });
    return clone(entry.state);
  }

  function enqueue(entry, operation) {
    // Admission is decided synchronously. Work accepted before close() owns a
    // place in this entry's tail and is allowed to finish while the store is
    // draining; work submitted after close begins is refused.
    try { assertLive(entry.id); }
    catch (error) { return Promise.reject(error); }
    const pending = entry.tail.then(operation);
    entry.tail = pending.catch(() => {});
    return pending;
  }

  async function restore({ id, validate, loadLocal, importMeta = null, commission = null } = {}) {
    assertLive(id ?? null);
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ExternalCheckpointError('CHECKPOINT_ID_INVALID', 'checkpoint id is outside the closed namespace', id ?? null);
    if (typeof validate !== 'function') throw new ExternalCheckpointError('VALIDATOR_REQUIRED', 'a strict validator is required', id);
    if (entries.has(id)) return entries.get(id).binding;

    let durable;
    try { durable = await persistence.repo.loadRuntimeState(id); }
    catch (error) { throw latch(new ExternalCheckpointError('CHECKPOINT_READ_FAILED', error?.code ?? error?.message ?? error, id), id); }
    if (durable?.invalid) throw latch(new ExternalCheckpointError('CHECKPOINT_INVALID', 'repository marked the durable checkpoint invalid', id), id);

    let state;
    let revision;
    let commissioning;
    if (durable) {
      const recError = recordError(durable.state, id);
      if (recError) throw latch(new ExternalCheckpointError('CHECKPOINT_INVALID', recError, id), id);
      state = durable.state.checkpoint;
      revision = durable.revision;
      commissioning = durable.state.commissioning;
    } else {
      let local;
      if (typeof loadLocal === 'function') {
        try { local = await loadLocal(); }
        catch (error) { throw latch(new ExternalCheckpointError('COMMISSIONING_CHECKPOINT_INVALID', error?.message ?? error, id), id); }
      }
      if (local === null || local === undefined) {
        if (commission?.allowCreate !== true) {
          throw latch(new ExternalCheckpointError('CHECKPOINT_ABSENT', 'neither PostgreSQL nor the commissioning filesystem has a checkpoint; explicit commissioning is required and zero is not assumed', id), id);
        }
        const metaError = commissioningError(commission);
        if (metaError) throw latch(new ExternalCheckpointError('COMMISSIONING_INVALID', metaError, id), id);
        local = commission.state;
        commissioning = { mode: 'EXPLICIT_COMMISSION', reason: commission.reason, ts: commission.ts };
      } else {
        const metaError = commissioningError(importMeta);
        if (metaError) throw latch(new ExternalCheckpointError('COMMISSIONING_INVALID', `filesystem import: ${metaError}`, id), id);
        commissioning = { mode: 'FILESYSTEM_IMPORT', reason: importMeta.reason, ts: importMeta.ts };
      }
      const jsonError = jsonValueError(local);
      const invalid = jsonError ?? validationError(validate, local);
      if (invalid) throw latch(new ExternalCheckpointError('COMMISSIONING_CHECKPOINT_INVALID', invalid, id), id);
      const record = makeRecord(id, local, commissioning);
      let saved;
      try { saved = await saveWithRetry(id, () => persistence.repo.saveRuntimeState(id, record, null)); }
      catch (error) { throw latch(new ExternalCheckpointError('COMMISSIONING_WRITE_FAILED', writeFailureDetail(error), id), id); }
      if (!saved || saved.conflict === true || !Number.isSafeInteger(saved.revision) || canonicalJson(saved.state) !== canonicalJson(record)) {
        throw latch(new ExternalCheckpointError('COMMISSIONING_CONFLICT', 'filesystem checkpoint was not adopted exactly', id), id);
      }
      state = saved.state.checkpoint;
      revision = saved.revision;
    }
    if (!Number.isSafeInteger(revision) || revision < 1) throw latch(new ExternalCheckpointError('CHECKPOINT_REVISION_INVALID', 'durable checkpoint revision is invalid', id), id);
    const jsonError = jsonValueError(state);
    const invalid = jsonError ?? validationError(validate, state);
    if (invalid) throw latch(new ExternalCheckpointError('CHECKPOINT_INVALID', invalid, id), id);
    if (!lock.held()) throw latch(new ExternalCheckpointError('LOCK_LOST', 'owner lock was lost during checkpoint restore', id), id, { global: true });

    const entry = { id, validate, state: clone(state), commissioning: clone(commissioning), revision, tail: Promise.resolve(), binding: null };
    const binding = Object.freeze({
      id,
      snapshot: () => clone(entry.state),
      revision: () => entry.revision,
      commissioning: () => clone(entry.commissioning),
      commit: (next, _meta = null) => enqueue(entry, () => persist(entry, clone(next), { acceptedBeforeClose: true })),
      update: (reducer, _meta = null) => {
        if (typeof reducer !== 'function') return Promise.reject(new ExternalCheckpointError('REDUCER_REQUIRED', 'checkpoint update requires a synchronous reducer', id));
        return enqueue(entry, async () => {
          assertLive(id, { acceptedBeforeClose: true });
          const next = reducer(clone(entry.state));
          if (next && typeof next.then === 'function') throw latch(new ExternalCheckpointError('ASYNC_REDUCER_REFUSED', 'checkpoint reducers must be synchronous and side-effect free', id), id);
          return persist(entry, next, { acceptedBeforeClose: true });
        });
      },
      failed: () => {
        const failure = globalFailure ?? failures.get(id) ?? null;
        return failure ? { ...failure } : null;
      },
    });
    entry.binding = binding;
    entries.set(id, entry);
    return binding;
  }

  function close() {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try {
        await Promise.all([...entries.values()].map((entry) => entry.tail));
      } finally {
        try { await lock.release?.(); } catch { /* a dead session already released the lock */ }
        closed = true;
        closing = false;
      }
    })();
    return closePromise;
  }

  return Object.freeze({
    version: EXTERNAL_CHECKPOINT_STORE_VERSION,
    restore,
    failed: (id = null) => {
      const failure = globalFailure ?? (id === null ? failures.values().next().value ?? null : failures.get(id) ?? null);
      return failure ? { ...failure } : null;
    },
    status: () => Object.freeze({ version: EXTERNAL_CHECKPOINT_STORE_VERSION, closed, closing, lockHeld: !closed && lock.held?.() === true, failure: globalFailure ? { ...globalFailure } : null, checkpointFailures: Object.fromEntries([...failures].map(([id, failure]) => [id, { ...failure }])), checkpoints: Object.fromEntries([...entries].map(([id, entry]) => [id, { revision: entry.revision }])) }),
    close,
  });
}
