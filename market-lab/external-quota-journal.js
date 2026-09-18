// Market quota journal backed by the generic external-checkpoint binding. This module owns no database connection and
// no provider transport. It imports the existing stopped filesystem journal once, strictly replays every transition,
// and exposes the synchronous read mirror + promise mutations expected by createDispatchGuard. A mutation becomes
// visible in the mirror only after binding.update confirms the durable CAS.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { canonicalDigest, isCount, isFiniteNum, isId, parseStrictJson, PROVIDER_IDS } from './contracts.js';
import {
  CHARGE_UNITS,
  DISPATCH_PURPOSES,
  MAX_QUOTA_JOURNAL_BYTES,
  MAX_QUOTA_ROW_BYTES,
  QUOTA_JOURNAL_VERSION,
  compactQuotaRecords,
  createQuotaMirror,
  planIdentity,
  validateQuotaRecords,
} from './quota.js';

export const MARKET_QUOTA_CHECKPOINT_VERSION = 'market-external-quota-checkpoint-1';
// PUBLISH-FIX-60: self-compaction threshold (a quarter of the journal bound) and its minimum spacing
export const COMPACT_AT_BYTES = MAX_QUOTA_JOURNAL_BYTES / 4;
export const COMPACT_MIN_INTERVAL_MS = 60 * 60 * 1000;
const CHECKPOINT_KEYS = Object.freeze(['journalVersion', 'rows', 'version']);
const BILLING_VALUES = new Set(['FREE', 'INCLUDED_QUOTA', 'METERED', 'UNKNOWN']);
const clone = (value) => structuredClone(value);
const bounded = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);

export class ExternalMarketQuotaError extends Error {
  constructor(code, message) { super(`${code}: ${bounded(message)}`); this.name = 'ExternalMarketQuotaError'; this.code = code; }
}

const checkpoint = (rows) => ({ version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: clone(rows) });
// PUBLISH-FIX-3 birth commissioning: the zero market-quota checkpoint (no reservations). Used to commission an ABSENT
// checkpoint at zero on a fresh deployment — the market lane carries no paid budget, so zero is the honest starting truth.
export const emptyMarketQuotaCheckpoint = () => checkpoint([]);
const exactKeys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort(); return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
};

export function validateMarketQuotaCheckpoint(value) {
  if (!exactKeys(value, CHECKPOINT_KEYS)) return { ok: false, errors: ['checkpoint must be a plain object with exactly journalVersion, rows, version'] };
  if (value.version !== MARKET_QUOTA_CHECKPOINT_VERSION) return { ok: false, errors: ['market checkpoint version mismatch'] };
  if (value.journalVersion !== QUOTA_JOURNAL_VERSION) return { ok: false, errors: ['quota journal version mismatch'] };
  const valid = validateQuotaRecords(value.rows);
  return valid.ok ? { ok: true, rows: valid.rows, bytes: valid.bytes } : { ok: false, errors: [valid.error] };
}

function assertValidCheckpoint(value, code = 'CHECKPOINT_INVALID') {
  const valid = validateMarketQuotaCheckpoint(value);
  if (!valid.ok) throw new ExternalMarketQuotaError(code, valid.errors.join('; '));
  return value;
}

// Commissioning import is intentionally read-only. The caller must first stop the filesystem writer; a lock seen
// before or after the bounded read refuses the migration. Missing means null so the generic store blocks absent state.
export function loadMarketQuotaCheckpoint(accountingDir) {
  if (!(typeof accountingDir === 'string' && accountingDir.length)) throw new ExternalMarketQuotaError('ACCOUNTING_DIR_INVALID', 'accounting directory is required');
  const dir = path.resolve(accountingDir); const lockFile = path.join(dir, 'quota.lock'); const journalFile = path.join(dir, 'quota.jsonl');
  if (existsSync(lockFile)) throw new ExternalMarketQuotaError('WRITER_ACTIVE', 'quota.lock exists; stop the current market writer before commissioning');
  if (!existsSync(journalFile)) return null;
  let size; try { size = statSync(journalFile).size; } catch (error) { throw new ExternalMarketQuotaError('CHECKPOINT_READ_FAILED', error?.code ?? error); }
  if (size > MAX_QUOTA_JOURNAL_BYTES) throw new ExternalMarketQuotaError('CHECKPOINT_TOO_LARGE', 'quota.jsonl exceeds its declared bound');
  let bytes; try { bytes = readFileSync(journalFile); } catch (error) { throw new ExternalMarketQuotaError('CHECKPOINT_READ_FAILED', error?.code ?? error); }
  if (existsSync(lockFile)) throw new ExternalMarketQuotaError('WRITER_ACTIVE', 'quota writer appeared during commissioning read');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ExternalMarketQuotaError('CHECKPOINT_INVALID', 'quota.jsonl is not valid UTF-8'); }
  const rows = []; const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) { if (i !== lines.length - 1) throw new ExternalMarketQuotaError('CHECKPOINT_INVALID', `quota.jsonl has an empty line at ${i + 1}`); continue; }
    if (Buffer.byteLength(line) + 1 > MAX_QUOTA_ROW_BYTES) throw new ExternalMarketQuotaError('CHECKPOINT_INVALID', `quota.jsonl row ${i + 1} exceeds its bound`);
    const parsed = parseStrictJson(Buffer.from(line), { maxBytes: MAX_QUOTA_ROW_BYTES });
    if (!parsed.ok) throw new ExternalMarketQuotaError('CHECKPOINT_INVALID', `quota.jsonl row ${i + 1}: ${parsed.error}`);
    rows.push(parsed.value);
  }
  const imported = checkpoint(rows); assertValidCheckpoint(imported, 'COMMISSIONING_CHECKPOINT_INVALID'); return imported;
}

function requiredBinding(binding) {
  if (!binding || typeof binding.snapshot !== 'function' || typeof binding.update !== 'function' || typeof binding.failed !== 'function') throw new ExternalMarketQuotaError('BINDING_INVALID', 'external checkpoint binding must provide snapshot, update, and failed');
  return binding;
}

// PUBLISH-FIX-59 note: the durable store still validates every persisted checkpoint with the full strict replay
// (validateMarketQuotaCheckpoint) — measured, a canonical digest of the rows costs MORE than the replay, so an
// "incremental" validator keyed on a prefix digest would be slower; the store's per-append cost is bounded by keeping
// the journal SMALL (PUBLISH-FIX-60 compaction), not by a cleverer validator.
export function createExternalQuotaJournal({ binding, clock = () => Date.now() } = {}) {
  const durable = requiredBinding(binding); let current = clone(durable.snapshot()); assertValidCheckpoint(current);
  // PUBLISH-FIX-59: one strict replay at birth builds the live mirror; every append is prepared against it (validated
  // without changing it), written durably, then committed — never a replay of every row again. Conflict detection uses
  // the binding's revision (the store passes the reducer exactly the state at that revision) instead of a canonical
  // digest of the whole checkpoint; the confirmed write is adopted only when it is exactly the proposed rows.
  let mirror = createQuotaMirror(current.rows, { clock }); let closed = false; let latchedFailure = null; let sequence = 0; let tail = Promise.resolve(); const pending = new Set();
  const counters = { appends: 0, replays: 1, compactions: 0, compactionsRefused: 0 }; let lastCompactAttemptTs = 0; let lastCompactDay = null;
  const failed = () => durable.failed() ?? (latchedFailure ? { ...latchedFailure } : null);
  const latch = (error) => { if (!latchedFailure) latchedFailure = { code: error?.code ?? 'CHECKPOINT_WRITE_FAILED', message: bounded(error?.message ?? error), ts: clock() }; return error; };
  const assertLive = () => { if (closed) throw new ExternalMarketQuotaError('JOURNAL_CLOSED', 'external market quota journal is closed'); const failure = failed(); if (failure) throw new ExternalMarketQuotaError('ACCOUNTING_UNAVAILABLE', `${failure.code}: ${failure.message}`); };
  const now = () => Math.max(clock(), mirror.now());
  const enqueue = (operation) => {
    const task = tail.then(async () => { assertLive(); return operation(); }); tail = task.catch(() => {});
    pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task;
  };
  const revisionOf = () => (typeof durable.revision === 'function' ? durable.revision() : null);
  async function persistRow(row, meta) {
    let commit; try { commit = mirror.prepare(row); } catch (error) { throw new ExternalMarketQuotaError(error?.code === 'RESOURCE_LIMIT_EXCEEDED' ? 'RESOURCE_LIMIT_EXCEEDED' : 'INVALID_REQUEST', error?.message ?? error); }
    const expectedRows = current.rows.length; const expectedRevision = revisionOf();
    let saved;
    try {
      saved = await durable.update((stored) => {
        // the store passes exactly its state at the owned revision; a moved revision or a different row count is another writer
        if ((expectedRevision !== null && revisionOf() !== expectedRevision) || !Array.isArray(stored?.rows) || stored.rows.length !== expectedRows) throw new ExternalMarketQuotaError('CHECKPOINT_MIRROR_CONFLICT', 'binding state changed outside this journal instance');
        if (expectedRevision === null && canonicalDigest(stored) !== canonicalDigest(current)) throw new ExternalMarketQuotaError('CHECKPOINT_MIRROR_CONFLICT', 'binding state changed outside this journal instance');
        return { version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: [...stored.rows, row] };
      }, meta);
    } catch (error) { throw latch(error); }
    // the confirmed checkpoint must be exactly the proposal: the same count and the same last row; anything else is refused
    if (!exactKeys(saved, CHECKPOINT_KEYS) || saved.version !== MARKET_QUOTA_CHECKPOINT_VERSION || saved.journalVersion !== QUOTA_JOURNAL_VERSION || !Array.isArray(saved.rows) || saved.rows.length !== expectedRows + 1 || canonicalDigest(saved.rows[expectedRows]) !== canonicalDigest(row)) {
      throw latch(new ExternalMarketQuotaError('CHECKPOINT_CONFIRMATION_INVALID', 'database confirmed a checkpoint that is not the proposed append'));
    }
    current = saved; commit(); counters.appends += 1;
    // PUBLISH-FIX-60: a journal past a quarter of its bound compacts itself (at most once an hour; never on the caller's path)
    // PUBLISH-FIX-65: and once per UTC day (yesterday's settled rows fold into CARRY rows the morning after)
    const today = new Date(clock()).toISOString().slice(0, 10);
    if ((mirror.bytes() > COMPACT_AT_BYTES && clock() - lastCompactAttemptTs > COMPACT_MIN_INTERVAL_MS) || (lastCompactDay !== null && today !== lastCompactDay)) { lastCompactAttemptTs = clock(); lastCompactDay = today; compact().catch(() => {}); }
    return row;
  }
  // PUBLISH-FIX-60: fold away what the admission law can no longer ask about (market-lab/quota.js compactQuotaRecords); the
  // compacted rows replace the checkpoint in ONE durable write under the same conflict law, then the mirror is rebuilt once
  function compact({ nowTs = null } = {}) { return enqueue(async () => {
    const at = nowTs ?? now(); lastCompactAttemptTs = clock(); lastCompactDay = new Date(at).toISOString().slice(0, 10);
    const plan = compactQuotaRecords(current.rows, { nowTs: at });
    if (!plan.ok) { counters.compactionsRefused += 1; return { ok: false, reason: plan.reason, before: null }; }
    if (!plan.changed) return { ok: true, changed: false, before: plan.before, after: plan.after };
    const expectedRows = current.rows.length; const expectedRevision = revisionOf(); const nextRows = plan.rows.map((r) => ({ ...r }));
    let saved;
    try {
      saved = await durable.update((stored) => {
        if ((expectedRevision !== null && revisionOf() !== expectedRevision) || !Array.isArray(stored?.rows) || stored.rows.length !== expectedRows) throw new ExternalMarketQuotaError('CHECKPOINT_MIRROR_CONFLICT', 'binding state changed outside this journal instance');
        return { version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: nextRows };
      }, { operation: 'COMPACT', droppedRows: plan.droppedRows });
    } catch (error) { throw latch(error); }
    if (!exactKeys(saved, CHECKPOINT_KEYS) || !Array.isArray(saved.rows) || saved.rows.length !== nextRows.length || canonicalDigest(saved.rows) !== canonicalDigest(nextRows)) throw latch(new ExternalMarketQuotaError('CHECKPOINT_CONFIRMATION_INVALID', 'database confirmed a checkpoint that is not the proposed compaction'));
    current = saved; mirror = createQuotaMirror(current.rows, { clock }); counters.replays += 1; counters.compactions += 1;
    return { ok: true, changed: true, droppedRows: plan.droppedRows, droppedReservations: plan.droppedReservations, carries: plan.carries, mergedCarries: plan.mergedCarries, retainFromTs: plan.retainFromTs, before: plan.before, after: plan.after };
  }); }
  function recordTs() { return now(); }
  function reservation(id) { return mirror.reservation(id); }
  function loadPlan(providerId, plan) { return enqueue(async () => {
    if (!PROVIDER_IDS.includes(providerId) || !plan || typeof plan !== 'object') throw new ExternalMarketQuotaError('INVALID_REQUEST', 'provider plan is malformed');
    const digest = planIdentity(plan); const prior = mirror.plans()[providerId];
    if (prior?.planDigest === digest) return { ok: true, planDigest: digest, fresh: false };
    if (!(isCount(plan.remainingCalls) && typeof plan.verifiedDate === 'string')) return { ok: false, reason: 'ENTITLEMENT_UNKNOWN', planDigest: digest };
    if (prior && !(typeof prior.verifiedDate === 'string' && plan.verifiedDate > prior.verifiedDate)) return { ok: false, reason: 'PLAN_CONFLICT', planDigest: digest };
    if (typeof plan.billing !== 'string' || !BILLING_VALUES.has(plan.billing)) throw new ExternalMarketQuotaError('INVALID_REQUEST', 'provider billing class is malformed');
    const row = { type: 'PLAN', providerId, planDigest: digest, billing: plan.billing, remainingCalls: plan.remainingCalls, includedCallsPerMonth: plan.includedCallsPerMonth, verifiedDate: plan.verifiedDate, ts: recordTs() };
    await persistRow(row, { operation: 'PLAN', providerId }); return { ok: true, planDigest: digest, fresh: true };
  }); }
  function reserve({ providerId, endpointId, unit, credits, chargedOn, purpose, requestKey, estimatedUsd } = {}) { return enqueue(async () => {
    if (!PROVIDER_IDS.includes(providerId) || !isId(endpointId) || !CHARGE_UNITS.includes(unit) || !isCount(credits) || credits === 0 || !['DISPATCH', 'SUCCESS'].includes(chargedOn) || !DISPATCH_PURPOSES.includes(purpose) || typeof requestKey !== 'string' || requestKey.length > 512 || !(isFiniteNum(estimatedUsd) && estimatedUsd >= 0)) throw new ExternalMarketQuotaError('INVALID_REQUEST', 'reservation is malformed');
    const ts = recordTs(); sequence += 1; const reservationId = `qr-${canonicalDigest({ providerId, endpointId, requestKey, ts, sequence, revision: durable.revision?.() ?? null, pid: process.pid }).slice(0, 40)}`;
    const row = { type: 'RESERVE', reservationId, providerId, endpointId, calls: 1, credits, unit, chargedOn, purpose, requestKey: String(requestKey).slice(0, 512), estimatedUsd, ts };
    await persistRow(row, { operation: 'RESERVE', providerId, reservationId }); return reservationId;
  }); }
  function settle(reservationId, { ok, status = null, credits = null } = {}) { return enqueue(async () => {
    const prior = reservation(reservationId); if (!prior || prior.state !== 'RESERVED') throw new ExternalMarketQuotaError('INVALID_REQUEST', 'settlement requires one open reservation');
    if (credits !== null && (!isCount(credits) || credits > prior.credits)) throw new ExternalMarketQuotaError('INVALID_REQUEST', 'settled credits are malformed');
    const charged = credits === null ? (prior.chargedOn === 'SUCCESS' && ok !== true ? 0 : prior.credits) : credits;
    const row = { type: 'SETTLE', reservationId, ok: ok === true, status: isCount(status) ? status : null, credits: charged, ts: recordTs() };
    await persistRow(row, { operation: 'SETTLE', providerId: prior.providerId, reservationId });
  }); }
  const terminal = (type, reservationId, reason) => enqueue(async () => {
    const prior = reservation(reservationId); if (!prior || prior.state !== 'RESERVED') throw new ExternalMarketQuotaError('INVALID_REQUEST', `${type.toLowerCase()} requires one open reservation`);
    if (!(typeof reason === 'string' && reason.length > 0 && reason.length <= 64)) throw new ExternalMarketQuotaError('INVALID_REQUEST', `${type.toLowerCase()} reason is malformed`);
    const row = { type, reservationId, reason: String(reason).slice(0, 64), ts: recordTs() };
    await persistRow(row, { operation: type, providerId: prior.providerId, reservationId });
  });
  const drained = async () => { await tail; while (pending.size) await Promise.allSettled([...pending]); };
  const close = async () => { if (closed) return; await drained(); closed = true; };
  return Object.freeze({
    journalVersion: QUOTA_JOURNAL_VERSION,
    durable: true,
    files: null,
    loadPlan,
    reserve,
    settle,
    unresolved: (reservationId, reason) => terminal('UNRESOLVED', reservationId, reason),
    release: (reservationId, reason) => terminal('RELEASE', reservationId, reason),
    totals: (providerId, nowTs) => mirror.totals(providerId, nowTs),
    entitlementRemaining: (providerId) => mirror.entitlementRemaining(providerId),
    reservations: () => mirror.reservations(),
    plans: () => mirror.plans(),
    rows: () => clone(current.rows),
    size: () => ({ rows: mirror.rows(), bytes: mirror.bytes(), maxBytes: MAX_QUOTA_JOURNAL_BYTES, appends: counters.appends, compactions: counters.compactions, compactionsRefused: counters.compactionsRefused }),
    compact,
    now,
    failed,
    drained,
    close,
    isClosed: () => closed,
  });
}
