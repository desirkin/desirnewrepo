// SOCRATES V2 — spend policy and the single-owner budget journal (§11.3). Reservations are persisted BEFORE any paid
// dispatch under an exclusive lock; a crash after dispatch but before the response leaves the reservation UNRESOLVED
// (counted as spent, never refunded automatically); failed persistence blocks dispatch. Estimates are estimates:
// reservation assumes uncached pricing and the configured max output; actual usage (including cache tokens) is
// recorded after completion. This journal is a research-process control only — never a second authority over the
// application's trading cost / ledger truth.
import { openSync, closeSync, writeSync, fsyncSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseStrictJson, fail, deepFreeze, isFiniteNum, isCount, isTs, isPlainObject } from '../market-lab/contracts.js';
import { writeAll } from '../market-lab/store.js';

export const BUDGET_JOURNAL_VERSION = 'socrates-budget-journal-1';
export const RESERVATION_STATES = Object.freeze(['RESERVED', 'SETTLED', 'UNRESOLVED', 'RELEASED']);
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);

// closeout R01 (Q07): the reservation covers the WORST billed input class ENABLED IN THE EXACT REQUEST plus the configured
// maximum billed output. A request carrying cache_control enables prompt-cache creation, so its input tokens may be billed
// at the cache-write rate (2.5 > 2.0 in the shipped fixture rates); a cache hit is never assumed. Classes are never summed.
export const INPUT_CLASSES = Object.freeze(['INPUT', 'CACHE_WRITE', 'CACHE_READ']);
const rateOf = (pricing, cls) => (cls === 'CACHE_WRITE' ? pricing.cacheWriteUsdPerMTok : cls === 'CACHE_READ' ? pricing.cacheReadUsdPerMTok : pricing.inputUsdPerMTok);
// the input classes a request body enables: INPUT always; CACHE_WRITE (and CACHE_READ) when any block carries cache_control
export function enabledInputClasses(body) { const hasCache = (v) => { if (Array.isArray(v)) return v.some(hasCache); if (v && typeof v === 'object') return 'cache_control' in v || Object.values(v).some(hasCache); return false; }; return hasCache(body) ? ['INPUT', 'CACHE_WRITE', 'CACHE_READ'] : ['INPUT']; }
export function estimateCostUsd({ inputTokens, maxOutputTokens, pricing, inputClasses = ['INPUT'] }) {
  if (!isCount(inputTokens) || !isCount(maxOutputTokens)) fail('INVALID_REQUEST', 'token counts must be non-negative safe integers');
  const classes = [...new Set(inputClasses)]; if (!classes.length || classes.some((c) => !INPUT_CLASSES.includes(c))) fail('INVALID_REQUEST', 'unknown input class');
  const rates = classes.map((c) => rateOf(pricing, c)); if (rates.some((r) => !isFiniteNum(r) || r < 0) || !isFiniteNum(pricing.outputUsdPerMTok) || pricing.outputUsdPerMTok < 0) fail('INVALID_REQUEST', 'price metadata missing for an enabled billed class — dispatch blocked');
  const worst = Math.max(...rates); // never rounded downward at a limit: round half away only after the sum
  return Number(((inputTokens * worst + maxOutputTokens * pricing.outputUsdPerMTok) / 1e6).toFixed(6));
}
export const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']);
// actual usage must be non-negative safe integers for EVERY billed category; anything else is not settleable (stays unresolved)
export const usageError = (u) => { if (!u || typeof u !== 'object' || Array.isArray(u)) return 'usage must be an object'; for (const k of USAGE_KEYS) if (!isCount(u[k])) return `usage.${k} is not a non-negative safe integer`; return null; };
export const actualCostUsd = ({ usage, pricing }) => { const e = usageError(usage); if (e) fail('INVALID_REQUEST', e); const u = usage; return Number(((u.inputTokens * pricing.inputUsdPerMTok + u.cacheCreationInputTokens * pricing.cacheWriteUsdPerMTok + u.cacheReadInputTokens * pricing.cacheReadUsdPerMTok + u.outputTokens * pricing.outputUsdPerMTok) / 1e6).toFixed(6)); };

export function openBudgetJournal({ dir, clock = () => Date.now(), pid = process.pid }) {
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'budget.lock'); const journalFile = path.join(dir, 'journal.jsonl');
  let lockFd = null;
  try { lockFd = openSync(lockFile, 'wx'); writeAll(lockFd, Buffer.from(`${JSON.stringify({ pid, openedTs: clock(), version: BUDGET_JOURNAL_VERSION })}\n`), 'budget.lock'); fsyncSync(lockFd); }
  catch (err) { if (lockFd !== null) { const owned = lockFd; lockFd = null; try { closeSync(owned); } catch { /* released once */ } try { unlinkSync(lockFile); } catch { /* our own partial lock */ } } if (err?.code === 'EEXIST') fail('PERMISSION_FAILURE', 'the budget journal is locked by another owner (single-owner law)'); fail('IO_FAILURE', `cannot lock the budget journal (${err?.code ?? 'error'})`); } // correction C: a failed initialization holds neither descriptor nor lock; another process's lock is never deleted
  const records = []; const byId = new Map(); let lastTs = 0; let closed = false; let bytes = 0;
  // every row is validated (types, ids, quantities) and every transition is lawful; a malformed or impossible row rejects the journal
  const rowError = (r, i) => { const w = `budget journal row ${i}`; if (!isPlainObject(r) || !['RESERVE', 'SETTLE', 'UNRESOLVED', 'RELEASE'].includes(r.type) || !isTs(r.ts) || typeof r.reservationId !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(r.reservationId)) return `${w}: type/ts/id malformed`; if (r.type === 'RESERVE') { if (typeof r.caseId !== 'string' || typeof r.attemptId !== 'string' || !(isFiniteNum(r.estimatedUsd) && r.estimatedUsd >= 0) || !isCount(r.inputTokens) || !isCount(r.maxOutputTokens) || !isPlainObject(r.pricing) || typeof r.smoke !== 'boolean') return `${w}: reservation malformed`; } else if (r.type === 'SETTLE') { if (!(isFiniteNum(r.actualUsd) && r.actualUsd >= 0) || usageError(r.usage)) return `${w}: settlement malformed`; } else if (typeof r.reason !== 'string' || !r.reason.length || r.reason.length > 64) return `${w}: reason malformed`; return null; };
  // closeout P2: VALIDATE the row and its transition first (pure), then the caller persists the bytes, then the already-validated
  // transition is COMMITTED without any further check — a rejected transition or a failed durable write leaves live state untouched
  const prepare = (r, i, strict) => {
    const e = rowError(r, i); if (e) fail('INVALID_INPUT', e); if (strict && r.ts < lastTs) fail('INVALID_INPUT', `budget journal row ${i}: clock runs backwards`);
    if (r.type === 'RESERVE') { if (byId.has(r.reservationId)) fail('INVALID_INPUT', `budget journal row ${i}: duplicate reservation id`); return () => { lastTs = Math.max(lastTs, r.ts); records.push(r); byId.set(r.reservationId, { ...r, state: 'RESERVED', actualUsd: null, usage: null }); }; }
    const x = byId.get(r.reservationId); if (!x) fail('INVALID_INPUT', `budget journal row ${i}: unknown reservation`); if (x.state !== 'RESERVED') fail('INVALID_INPUT', `budget journal row ${i}: impossible transition from ${x.state}`);
    const patch = r.type === 'SETTLE' ? { state: 'SETTLED', actualUsd: r.actualUsd, usage: r.usage, settledTs: r.ts } : r.type === 'RELEASE' ? { state: 'RELEASED', releasedTs: r.ts, reason: r.reason } : { state: 'UNRESOLVED', unresolvedTs: r.ts, reason: r.reason };
    return () => { lastTs = Math.max(lastTs, r.ts); records.push(r); Object.assign(x, patch); };
  };
  const apply = (r, i, strict) => prepare(r, i, strict)();
  try { if (existsSync(journalFile)) { const buf = readFileSync(journalFile); bytes = buf.length; if (buf.length > MAX_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'budget journal too large — stopped explicitly, never cleared to regain budget'); const lines = buf.toString('utf8').split('\n'); for (let i = 0; i < lines.length; i += 1) { const l = lines[i]; if (!l) { if (i !== lines.length - 1) fail('INVALID_INPUT', `budget journal: empty line ${i + 1}`); continue; } const p = parseStrictJson(l, { maxBytes: 65_536 }); if (!p.ok) fail('INVALID_INPUT', `budget journal: line ${i + 1} ${p.error}`); apply(p.value, i + 1, true); } } }
  catch (err) { release(); throw err; }
  const now = () => Math.max(clock(), lastTs); // clock rollback never regains a consumed bucket
  // closeout P2: a failed or uncertain durable write LATCHES accounting failure (first error kept); no new allowance until a safe reopen
  let failure = null;
  const guard = () => { if (closed) fail('PERMISSION_FAILURE', 'budget journal closed — no mutation after the lock is released'); if (failure) fail('IO_FAILURE', `budget journal accounting failure latched (${failure.code}: ${failure.message}) — no new allowance until a safe reopen`); };
  function append(rec) { guard(); const line = Buffer.from(`${JSON.stringify(rec)}\n`); if (bytes + line.length > MAX_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'budget journal at its bound — dispatch stopped explicitly'); let fd = null; let primary = null;
    // correction C: a successful append is open + write-all + fsync + the ONE primary close; the first failure is kept and surfaced as
    // IO_FAILURE. The descriptor is closed exactly once (the caller never retries a close that may already have released it);
    // a close error after a successful fsync is still an accounting failure — the row may be on disk while live state is not committed.
    try { fd = openSync(journalFile, 'a'); writeAll(fd, line, 'journal.jsonl'); fsyncSync(fd); } catch (err) { primary = err; }
    if (fd !== null) { const owned = fd; fd = null; try { closeSync(owned); } catch (err) { if (!primary) primary = err; } }
    if (primary) { if (primary?.code === 'RESOURCE_LIMIT_EXCEEDED') throw primary; fail('IO_FAILURE', `budget journal append failed (${primary?.code ?? 'error'}: ${String(primary?.message ?? primary).slice(0, 120)}) — dispatch blocked`); }
    bytes += line.length; }
  // validate -> persist -> commit: memory changes only after the bytes are durable; an IO failure latches and the transition is dropped
  const write = (rec) => { guard(); const commit = prepare(rec, records.length + 1, false); try { append(rec); } catch (err) { if (err?.code !== 'RESOURCE_LIMIT_EXCEEDED' && !failure) failure = { code: err?.code ?? 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) }; throw err; } commit(); };
  // restart law: a RESERVED entry with no settle/release is UNRESOLVED (a crash after dispatch may still have been charged); a failed
  // initialization releases the startup lock (no owned writer remains) and reports the error
  try { for (const r of [...byId.values()]) if (r.state === 'RESERVED') write({ type: 'UNRESOLVED', reservationId: r.reservationId, ts: now(), reason: 'RESERVED_AT_RESTART' }); } catch (err) { release(); throw err; }
  function release() { if (lockFd !== null) { try { closeSync(lockFd); } catch { /* ignore */ } lockFd = null; try { unlinkSync(lockFile); } catch { /* ignore */ } } closed = true; }
  const spent = (r) => (r.state === 'SETTLED' ? r.actualUsd : r.state === 'RELEASED' ? 0 : r.estimatedUsd); // RESERVED + UNRESOLVED count as spent
  function totals(nowTs = now()) { if (!isTs(nowTs)) fail('INVALID_REQUEST', 'totals need a clock'); let day = 0; let month = 0; let smoke = 0; let unresolved = 0; for (const r of byId.values()) { const v = spent(r); if (dayKey(r.ts) === dayKey(nowTs)) day += v; if (monthKey(r.ts) === monthKey(nowTs)) month += v; if (r.smoke) smoke += v; if (r.state === 'UNRESOLVED') unresolved += r.estimatedUsd; } return { dayUsd: Number(day.toFixed(6)), monthUsd: Number(month.toFixed(6)), smokeUsd: Number(smoke.toFixed(6)), unresolvedUsd: Number(unresolved.toFixed(6)), reserved: [...byId.values()].filter((r) => r.state === 'RESERVED').length }; }
  function caseTotal(caseId) { if (typeof caseId !== 'string') fail('INVALID_REQUEST', 'caseId required'); let t = 0; for (const r of byId.values()) if (r.caseId === caseId) t += spent(r); return Number(t.toFixed(6)); }
  // reserve BEFORE dispatch: every cap must hold with this reservation included, or BUDGET_BLOCKED
  function reserve({ reservationId, caseId, attemptId, estimatedUsd, inputTokens, maxOutputTokens, pricing, caps, smoke = false }) {
    guard(); if (!isFiniteNum(estimatedUsd) || estimatedUsd < 0) fail('INVALID_REQUEST', 'estimated cost malformed');
    if (typeof reservationId !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(reservationId) || byId.has(reservationId)) fail('INVALID_REQUEST', 'reservation id malformed or already used');
    if (typeof caseId !== 'string' || typeof attemptId !== 'string' || !isCount(inputTokens) || !isCount(maxOutputTokens) || !isPlainObject(caps) || !isPlainObject(pricing)) fail('INVALID_REQUEST', 'reservation arguments malformed');
    const nowTs = now(); const t = totals(nowTs); const reasons = [];
    if (!(caps.maxEstimatedUsdPerCase > 0)) reasons.push('CASE_CAP_ZERO'); else if (caseTotal(caseId) + estimatedUsd > caps.maxEstimatedUsdPerCase) reasons.push('CASE_CAP');
    if (!(caps.maxEstimatedUsdPerDay > 0) || t.dayUsd + estimatedUsd > caps.maxEstimatedUsdPerDay) reasons.push('DAY_CAP');
    if (!(caps.maxEstimatedUsdPerMonth > 0) || t.monthUsd + estimatedUsd > caps.maxEstimatedUsdPerMonth) reasons.push('MONTH_CAP');
    if (smoke && (!(caps.totalSmokeMaxEstimatedUsd > 0) || t.smokeUsd + estimatedUsd > caps.totalSmokeMaxEstimatedUsd)) reasons.push('SMOKE_CAP');
    if (reasons.length) return { ok: false, state: 'BUDGET_BLOCKED', reasons, totals: t };
    write({ type: 'RESERVE', reservationId, caseId, attemptId, estimatedUsd, inputTokens, maxOutputTokens, pricing: { inputUsdPerMTok: pricing.inputUsdPerMTok, outputUsdPerMTok: pricing.outputUsdPerMTok, cacheReadUsdPerMTok: pricing.cacheReadUsdPerMTok, cacheWriteUsdPerMTok: pricing.cacheWriteUsdPerMTok }, smoke, ts: nowTs });
    return { ok: true, state: 'RESERVED', reservationId, totals: totals(nowTs) };
  }
  const open = (reservationId) => { const r = byId.get(reservationId); if (!r || r.state !== 'RESERVED') fail('INVALID_REQUEST', 'reservation not open'); return r; };
  // settlement needs VALID usage (non-negative safe integers in every billed category); invalid usage is not zero — it stays unresolved
  function settle({ reservationId, usage, pricing }) { guard(); open(reservationId); const e = usageError(usage); if (e) fail('INVALID_REQUEST', `cannot settle: ${e}`); write({ type: 'SETTLE', reservationId, actualUsd: actualCostUsd({ usage, pricing }), usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens }, ts: now() }); return byId.get(reservationId); }
  function markUnresolved({ reservationId, reason }) { guard(); open(reservationId); write({ type: 'UNRESOLVED', reservationId, reason: String(reason).slice(0, 64), ts: now() }); return byId.get(reservationId); }
  // a release is lawful ONLY when the provider provably never received the request (refused before dispatch)
  function releaseReservation({ reservationId, reason }) { guard(); open(reservationId); write({ type: 'RELEASE', reservationId, reason: String(reason).slice(0, 64), ts: now() }); return byId.get(reservationId); }
  // closing under the lock: every still-open reservation may have been dispatched — mark it UNRESOLVED BEFORE the lock goes
  function close({ openReason = 'OPEN_AT_CLOSE' } = {}) { if (closed) return; for (const r of [...byId.values()]) if (r.state === 'RESERVED') { try { write({ type: 'UNRESOLVED', reservationId: r.reservationId, reason: openReason, ts: now() }); } catch { /* the lock still goes; the row stays RESERVED on disk and becomes UNRESOLVED at the next open */ } } release(); }
  return { reserve, settle, markUnresolved, releaseReservation, totals: () => totals(now()), caseTotal, reservations: () => deepFreeze([...byId.values()].map((r) => ({ ...r }))), close, isClosed: () => closed, isOpen: (id) => byId.get(id)?.state === 'RESERVED', failed: () => (failure ? { ...failure } : null), files: { lockFile, journalFile } };
}
