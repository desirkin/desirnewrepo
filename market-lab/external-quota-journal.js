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
  planIdentity,
  replayQuotaRecords,
  validateQuotaRecords,
} from './quota.js';

export const MARKET_QUOTA_CHECKPOINT_VERSION = 'market-external-quota-checkpoint-1';
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

export function createExternalQuotaJournal({ binding, clock = () => Date.now() } = {}) {
  const durable = requiredBinding(binding); let current = clone(durable.snapshot()); assertValidCheckpoint(current);
  let mirror = replayQuotaRecords(current.rows, { clock }); let closed = false; let latchedFailure = null; let sequence = 0; let tail = Promise.resolve(); const pending = new Set();
  const failed = () => durable.failed() ?? (latchedFailure ? { ...latchedFailure } : null);
  const latch = (error) => { if (!latchedFailure) latchedFailure = { code: error?.code ?? 'CHECKPOINT_WRITE_FAILED', message: bounded(error?.message ?? error), ts: clock() }; return error; };
  const assertLive = () => { if (closed) throw new ExternalMarketQuotaError('JOURNAL_CLOSED', 'external market quota journal is closed'); const failure = failed(); if (failure) throw new ExternalMarketQuotaError('ACCOUNTING_UNAVAILABLE', `${failure.code}: ${failure.message}`); };
  const now = () => Math.max(clock(), mirror.now());
  const enqueue = (operation) => {
    const task = tail.then(async () => { assertLive(); return operation(); }); tail = task.catch(() => {});
    pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task;
  };
  async function persistRow(row, meta) {
    const expectedDigest = canonicalDigest(current);
    let saved;
    try {
      saved = await durable.update((stored) => {
        assertValidCheckpoint(stored);
        if (canonicalDigest(stored) !== expectedDigest) throw new ExternalMarketQuotaError('CHECKPOINT_MIRROR_CONFLICT', 'binding state changed outside this journal instance');
        const next = checkpoint([...stored.rows, row]); assertValidCheckpoint(next); return next;
      }, meta);
    } catch (error) { throw latch(error); }
    try { assertValidCheckpoint(saved, 'CHECKPOINT_CONFIRMATION_INVALID'); }
    catch (error) { throw latch(error); }
    current = clone(saved); mirror = replayQuotaRecords(current.rows, { clock }); return row;
  }
  function recordTs() { return now(); }
  function reservation(id) { return mirror.reservations().find((row) => row.reservationId === id) ?? null; }
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
    now,
    failed,
    drained,
    close,
    isClosed: () => closed,
  });
}
