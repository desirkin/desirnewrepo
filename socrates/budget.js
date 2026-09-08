// SOCRATES V2 — spend policy and the single-owner budget journal (§11.3). Reservations are persisted BEFORE any paid
// dispatch under an exclusive lock; a crash after dispatch but before the response leaves the reservation UNRESOLVED
// (counted as spent, never refunded automatically); failed persistence blocks dispatch. Estimates are estimates:
// reservation assumes uncached pricing and the configured max output; actual usage (including cache tokens) is
// recorded after completion. This journal is a research-process control only — never a second authority over the
// application's trading cost / ledger truth.
import { openSync, closeSync, writeSync, fsyncSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseStrictJson, fail, deepFreeze, isFiniteNum } from '../market-lab/contracts.js';
import { writeAll } from '../market-lab/store.js';

export const BUDGET_JOURNAL_VERSION = 'socrates-budget-journal-1';
export const RESERVATION_STATES = Object.freeze(['RESERVED', 'SETTLED', 'UNRESOLVED', 'RELEASED']);
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);

// uncached reservation: input tokens (actual count when available, else conservative estimate) + configured max output
export const estimateCostUsd = ({ inputTokens, maxOutputTokens, pricing }) => Number(((inputTokens * pricing.inputUsdPerMTok + maxOutputTokens * pricing.outputUsdPerMTok) / 1e6).toFixed(6));
export const actualCostUsd = ({ usage, pricing }) => { const u = usage ?? {}; const inp = Math.max(0, (u.inputTokens ?? 0)); const cw = u.cacheCreationInputTokens ?? 0; const cr = u.cacheReadInputTokens ?? 0; const out = u.outputTokens ?? 0; return Number(((inp * pricing.inputUsdPerMTok + cw * pricing.cacheWriteUsdPerMTok + cr * pricing.cacheReadUsdPerMTok + out * pricing.outputUsdPerMTok) / 1e6).toFixed(6)); };

export function openBudgetJournal({ dir, clock = () => Date.now(), pid = process.pid }) {
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'budget.lock'); const journalFile = path.join(dir, 'journal.jsonl');
  let lockFd = null;
  try { lockFd = openSync(lockFile, 'wx'); writeAll(lockFd, Buffer.from(`${JSON.stringify({ pid, openedTs: clock(), version: BUDGET_JOURNAL_VERSION })}\n`), 'budget.lock'); fsyncSync(lockFd); }
  catch (err) { if (err?.code === 'EEXIST') fail('PERMISSION_FAILURE', 'the budget journal is locked by another owner (single-owner law)'); fail('IO_FAILURE', `cannot lock the budget journal (${err?.code ?? 'error'})`); }
  const records = []; const byId = new Map();
  const apply = (r) => { records.push(r); if (r.type === 'RESERVE') byId.set(r.reservationId, { ...r, state: 'RESERVED', actualUsd: null, usage: null }); else if (r.type === 'SETTLE' && byId.has(r.reservationId)) Object.assign(byId.get(r.reservationId), { state: 'SETTLED', actualUsd: r.actualUsd, usage: r.usage, settledTs: r.ts }); else if (r.type === 'RELEASE' && byId.has(r.reservationId)) Object.assign(byId.get(r.reservationId), { state: 'RELEASED', releasedTs: r.ts, reason: r.reason }); else if (r.type === 'UNRESOLVED' && byId.has(r.reservationId)) Object.assign(byId.get(r.reservationId), { state: 'UNRESOLVED', unresolvedTs: r.ts, reason: r.reason }); };
  if (existsSync(journalFile)) { const buf = readFileSync(journalFile); if (buf.length > MAX_JOURNAL_BYTES) { release(); fail('RESOURCE_LIMIT_EXCEEDED', 'budget journal too large'); } const lines = buf.toString('utf8').split('\n'); for (let i = 0; i < lines.length; i += 1) { const l = lines[i]; if (!l) { if (i !== lines.length - 1) { release(); fail('INVALID_INPUT', `budget journal: empty line ${i + 1}`); } continue; } const p = parseStrictJson(l, { maxBytes: 65_536 }); if (!p.ok) { release(); fail('INVALID_INPUT', `budget journal: line ${i + 1} ${p.error}`); } apply(p.value); } }
  // restart law: a RESERVED entry with no settle/release is UNRESOLVED (a crash after dispatch may still have been charged)
  for (const r of byId.values()) if (r.state === 'RESERVED') { const u = { type: 'UNRESOLVED', reservationId: r.reservationId, ts: clock(), reason: 'RESERVED_AT_RESTART' }; append(u); apply(u); }
  function append(rec) { let fd = null; try { fd = openSync(journalFile, 'a'); writeAll(fd, Buffer.from(`${JSON.stringify(rec)}\n`), 'journal.jsonl'); fsyncSync(fd); } catch (err) { fail('IO_FAILURE', `budget journal append failed (${err?.code ?? 'error'}) — dispatch blocked`); } finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } } }
  function release() { if (lockFd !== null) { try { closeSync(lockFd); } catch { /* ignore */ } lockFd = null; try { unlinkSync(lockFile); } catch { /* ignore */ } } }
  const spent = (r) => (r.state === 'SETTLED' ? r.actualUsd : r.state === 'RELEASED' ? 0 : r.estimatedUsd); // RESERVED + UNRESOLVED count as spent
  function totals(nowTs) { let day = 0; let month = 0; let smoke = 0; let unresolved = 0; for (const r of byId.values()) { const v = spent(r); if (dayKey(r.ts) === dayKey(nowTs)) day += v; if (monthKey(r.ts) === monthKey(nowTs)) month += v; if (r.smoke) smoke += v; if (r.state === 'UNRESOLVED') unresolved += r.estimatedUsd; } return { dayUsd: Number(day.toFixed(6)), monthUsd: Number(month.toFixed(6)), smokeUsd: Number(smoke.toFixed(6)), unresolvedUsd: Number(unresolved.toFixed(6)) }; }
  function caseTotal(caseId) { let t = 0; for (const r of byId.values()) if (r.caseId === caseId) t += spent(r); return Number(t.toFixed(6)); }
  // reserve BEFORE dispatch: every cap must hold with this reservation included, or BUDGET_BLOCKED
  function reserve({ reservationId, caseId, attemptId, estimatedUsd, inputTokens, maxOutputTokens, pricing, caps, smoke = false }) {
    if (!isFiniteNum(estimatedUsd) || estimatedUsd < 0) fail('INVALID_REQUEST', 'estimated cost malformed');
    const now = clock(); const t = totals(now); const reasons = [];
    if (!(caps.maxEstimatedUsdPerCase > 0)) reasons.push('CASE_CAP_ZERO'); else if (caseTotal(caseId) + estimatedUsd > caps.maxEstimatedUsdPerCase) reasons.push('CASE_CAP');
    if (!(caps.maxEstimatedUsdPerDay > 0) || t.dayUsd + estimatedUsd > caps.maxEstimatedUsdPerDay) reasons.push('DAY_CAP');
    if (!(caps.maxEstimatedUsdPerMonth > 0) || t.monthUsd + estimatedUsd > caps.maxEstimatedUsdPerMonth) reasons.push('MONTH_CAP');
    if (smoke && (!(caps.totalSmokeMaxEstimatedUsd > 0) || t.smokeUsd + estimatedUsd > caps.totalSmokeMaxEstimatedUsd)) reasons.push('SMOKE_CAP');
    if (reasons.length) return { ok: false, state: 'BUDGET_BLOCKED', reasons, totals: t };
    const rec = { type: 'RESERVE', reservationId, caseId, attemptId, estimatedUsd, inputTokens, maxOutputTokens, pricing: { inputUsdPerMTok: pricing.inputUsdPerMTok, outputUsdPerMTok: pricing.outputUsdPerMTok, cacheReadUsdPerMTok: pricing.cacheReadUsdPerMTok, cacheWriteUsdPerMTok: pricing.cacheWriteUsdPerMTok }, smoke, ts: now };
    append(rec); apply(rec); return { ok: true, state: 'RESERVED', reservationId, totals: totals(now) };
  }
  function settle({ reservationId, usage, pricing }) { const r = byId.get(reservationId); if (!r || r.state !== 'RESERVED') fail('INVALID_REQUEST', 'reservation not open'); const rec = { type: 'SETTLE', reservationId, actualUsd: actualCostUsd({ usage, pricing }), usage, ts: clock() }; append(rec); apply(rec); return byId.get(reservationId); }
  function markUnresolved({ reservationId, reason }) { const r = byId.get(reservationId); if (!r || r.state !== 'RESERVED') fail('INVALID_REQUEST', 'reservation not open'); const rec = { type: 'UNRESOLVED', reservationId, reason, ts: clock() }; append(rec); apply(rec); return byId.get(reservationId); }
  // a release is lawful ONLY when the provider provably never received the request (refused before dispatch)
  function releaseReservation({ reservationId, reason }) { const r = byId.get(reservationId); if (!r || r.state !== 'RESERVED') fail('INVALID_REQUEST', 'reservation not open'); const rec = { type: 'RELEASE', reservationId, reason, ts: clock() }; append(rec); apply(rec); return byId.get(reservationId); }
  return { reserve, settle, markUnresolved, releaseReservation, totals: () => totals(clock()), caseTotal, reservations: () => deepFreeze([...byId.values()].map((r) => ({ ...r }))), close: release, files: { lockFile, journalFile } };
}
