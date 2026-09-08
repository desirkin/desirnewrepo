// MARKET LAB — THE RESEARCH ACCOUNTING AUTHORITY (closeout R01). One pre-dispatch admission law for every production
// HTTP request: enablement, registered / permitted endpoint, credential presence, replay / lifecycle state, local day
// and month call caps, provider concurrency, native charge units, remaining entitlement, probe / smoke ceilings and the
// billing class. The reservation is written atomically (append + fsync under an exclusive lock) BEFORE the wire is
// touched; only a proven non-dispatch releases it; a timeout, lost response or crash keeps it UNRESOLVED (spent).
// Zero means zero. Unknown entitlement or charge means denial. An included plan is not unlimited. Calls and native
// credits are different counters. This journal is a RESEARCH process control only — never a trading authority.
import { openSync, closeSync, fsyncSync, mkdirSync, readFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseStrictJson, fail, deepFreeze, isTs, isCount, isFiniteNum, isId, isPlainObject, canonicalDigest, PROVIDER_IDS } from './contracts.js';
import { writeAll } from './store.js';
import { endpointOf, PROVIDERS } from './registry.js';
import { credentialPresence, endpointPermitted } from './policy.js';

export const QUOTA_JOURNAL_VERSION = 'market-provider-quota-1';
export const QUOTA_RECORD_TYPES = Object.freeze(['PLAN', 'RESERVE', 'SETTLE', 'UNRESOLVED', 'RELEASE']);
export const QUOTA_RESERVATION_STATES = Object.freeze(['RESERVED', 'SETTLED', 'UNRESOLVED', 'RELEASED']);
export const DISPATCH_PURPOSES = Object.freeze(['ACQUIRE', 'CATALOG', 'BROKER', 'PROBE', 'SMOKE']);
export const CHARGE_UNITS = Object.freeze(['CALL', 'CREDIT']);
export const QUOTA_REFUSAL_REASONS = Object.freeze(['NETWORK_OFF', 'OWNER_STOPPED', 'PROVIDER_DISABLED', 'ENDPOINT_UNKNOWN', 'ENDPOINT_NOT_PERMITTED', 'CREDENTIAL_MISSING', 'CONCURRENCY_ZERO', 'CHARGE_UNKNOWN', 'DAY_CAP_ZERO', 'DAY_CAP', 'MONTH_CAP_ZERO', 'MONTH_CAP', 'BILLING_UNKNOWN', 'ENTITLEMENT_UNKNOWN', 'ENTITLEMENT_EXHAUSTED', 'OVERAGE_NOT_AUTHORIZED', 'PLAN_CONFLICT', 'METERED_AUTHORIZATION_ABSENT', 'METERED_CALL_CAP', 'METERED_USD_CAP', 'SMOKE_NOT_AUTHORIZED', 'SMOKE_CALL_CAP', 'SMOKE_USD_CAP', 'ACCOUNTING_UNAVAILABLE', 'JOURNAL_LIMIT']);
export const MAX_QUOTA_JOURNAL_BYTES = 16 * 1024 * 1024;
export const MAX_QUOTA_ROW_BYTES = 4096;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);

// ---- the native charge of one actual request (documented accounting unit per request type) ------------------------------
// CALL providers: every HTTP request is one call and one unit. CREDIT providers: Twelve Data bills one credit per symbol
// per request (symbol-search / quote / time-series), Tokenomist bills one credit per SUCCESSFUL request (chargedOn SUCCESS).
// WebSocket handshakes and messages are never HTTP calls or native credits. An unknown unit is null (denial), never 1.
const CREDIT_PROVIDERS = deepFreeze({ TWELVEDATA: 'PER_SYMBOL', TOKENOMIST: 'PER_SUCCESS' });
export function nativeCharge({ providerId, endpointId, query = null }) {
  const e = endpointOf(providerId, endpointId); if (!e || e.method === 'WS') return null;
  const rule = CREDIT_PROVIDERS[providerId];
  if (!rule) return { unit: 'CALL', calls: 1, credits: 1, chargedOn: 'DISPATCH' };
  if (rule === 'PER_SYMBOL') { const sym = query && typeof query.symbol === 'string' ? query.symbol : null; const n = sym ? sym.split(',').filter((s) => s.length).length : 1; return { unit: 'CREDIT', calls: 1, credits: Math.max(1, Math.min(64, n)), chargedOn: 'DISPATCH' }; }
  return { unit: 'CREDIT', calls: 1, credits: 1, chargedOn: 'SUCCESS' };
}
export const planIdentity = (plan) => canonicalDigest({ name: plan.name, billing: plan.billing, includedCallsPerMonth: plan.includedCallsPerMonth, remainingCalls: plan.remainingCalls, incrementalUsdPerCall: plan.incrementalUsdPerCall, attestation: plan.attestation, verifiedDate: plan.verifiedDate });

// ---- journal rows ------------------------------------------------------------------------------------------------------
function rowError(r, i) {
  const w = `quota journal row ${i}`;
  if (!isPlainObject(r) || !QUOTA_RECORD_TYPES.includes(r.type) || !isTs(r.ts)) return `${w}: type/ts malformed`;
  if (r.type === 'PLAN') { if (!PROVIDER_IDS.includes(r.providerId) || typeof r.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.planDigest) || !(r.remainingCalls === null || isCount(r.remainingCalls)) || !(r.includedCallsPerMonth === null || isCount(r.includedCallsPerMonth)) || !(r.verifiedDate === null || typeof r.verifiedDate === 'string') || typeof r.billing !== 'string') return `${w}: plan malformed`; return null; }
  if (typeof r.reservationId !== 'string' || !/^qr-[0-9a-f]{24,64}$/.test(r.reservationId)) return `${w}: reservationId malformed`;
  if (r.type === 'RESERVE') { if (!PROVIDER_IDS.includes(r.providerId) || !isId(r.endpointId) || r.calls !== 1 || !isCount(r.credits) || r.credits === 0 || !CHARGE_UNITS.includes(r.unit) || !DISPATCH_PURPOSES.includes(r.purpose) || typeof r.requestKey !== 'string' || r.requestKey.length > 512 || !(isFiniteNum(r.estimatedUsd) && r.estimatedUsd >= 0) || !['DISPATCH', 'SUCCESS'].includes(r.chargedOn)) return `${w}: reservation malformed`; return null; }
  if (r.type === 'SETTLE') { if (typeof r.ok !== 'boolean' || !isCount(r.credits) || !(r.status === null || isCount(r.status))) return `${w}: settlement malformed`; return null; }
  if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > 64) return `${w}: reason malformed`;
  return null;
}
function createState() {
  const byId = new Map(); const plans = new Map(); let lastTs = 0; let rows = 0;
  const apply = (r, i, strict) => {
    const e = rowError(r, i); if (e) fail('INVALID_INPUT', e);
    if (r.ts < lastTs && strict) fail('INVALID_INPUT', `quota journal row ${i}: clock runs backwards`);
    lastTs = Math.max(lastTs, r.ts); rows += 1;
    if (r.type === 'PLAN') { plans.set(r.providerId, { ...r }); return; }
    if (r.type === 'RESERVE') { if (byId.has(r.reservationId)) fail('INVALID_INPUT', `quota journal row ${i}: duplicate reservation id`); byId.set(r.reservationId, { ...r, state: 'RESERVED', settledCredits: null, ok: null, status: null }); return; }
    const x = byId.get(r.reservationId); if (!x) fail('INVALID_INPUT', `quota journal row ${i}: unknown reservation`);
    if (x.state !== 'RESERVED') fail('INVALID_INPUT', `quota journal row ${i}: impossible transition from ${x.state}`);
    if (r.type === 'SETTLE') { if (r.credits > x.credits) fail('INVALID_INPUT', `quota journal row ${i}: settled credits exceed the reservation`); Object.assign(x, { state: 'SETTLED', settledCredits: r.credits, ok: r.ok, status: r.status, settledTs: r.ts }); }
    else if (r.type === 'UNRESOLVED') Object.assign(x, { state: 'UNRESOLVED', reason: r.reason, unresolvedTs: r.ts });
    else Object.assign(x, { state: 'RELEASED', reason: r.reason, releasedTs: r.ts });
  };
  return { byId, plans, apply, lastTs: () => lastTs, rows: () => rows };
}
// spent credits of one reservation against a limit: RESERVED and UNRESOLVED count in full (conservative); SETTLED counts the actual charge; RELEASED is zero
const spentCredits = (x) => (x.state === 'RELEASED' ? 0 : x.state === 'SETTLED' ? x.settledCredits : x.credits);
const spentCalls = (x) => (x.state === 'RELEASED' ? 0 : 1);
const spentUsd = (x) => (x.state === 'RELEASED' ? 0 : x.state === 'SETTLED' ? (x.credits ? x.estimatedUsd * (x.settledCredits / x.credits) : 0) : x.estimatedUsd);

function journalApi(state, { append, clock, durable, close, files }) {
  let closed = false; const guard = () => { if (closed) fail('PERMISSION_FAILURE', 'quota journal closed — no mutation after release'); };
  const now = () => Math.max(clock(), state.lastTs()); // clock rollback never regains a consumed bucket
  const write = (rec) => { guard(); state.apply(rec, state.rows() + 1, false); try { append(rec); } catch (err) { throw err; } };
  function totals(providerId, nowTs = now()) {
    const t = { calls: { day: 0, month: 0 }, credits: { day: 0, month: 0 }, usd: { day: 0, month: 0 }, reserved: 0, settled: 0, unresolved: 0, released: 0, smoke: { calls: 0, usd: 0 }, dispatched: 0 };
    for (const x of state.byId.values()) { if (x.providerId !== providerId) continue; if (x.state === 'RESERVED') t.reserved += 1; else if (x.state === 'SETTLED') t.settled += 1; else if (x.state === 'UNRESOLVED') t.unresolved += 1; else t.released += 1; if (x.state !== 'RELEASED') t.dispatched += 1; const c = spentCalls(x); const cr = spentCredits(x); const u = spentUsd(x); if (dayKey(x.ts) === dayKey(nowTs)) { t.calls.day += c; t.credits.day += cr; t.usd.day += u; } if (monthKey(x.ts) === monthKey(nowTs)) { t.calls.month += c; t.credits.month += cr; t.usd.month += u; } if (x.purpose === 'PROBE' || x.purpose === 'SMOKE') { t.smoke.calls += c; t.smoke.usd += u; } }
    t.usd.day = Number(t.usd.day.toFixed(6)); t.usd.month = Number(t.usd.month.toFixed(6)); t.smoke.usd = Number(t.smoke.usd.toFixed(6));
    return t;
  }
  // PLAN snapshots: the same plan digest is never re-granted; a different digest needs a strictly newer verifiedDate (a
  // verified new snapshot reconciles: consumption after the snapshot clock counts against it); otherwise it conflicts
  function loadPlan(providerId, plan) {
    guard(); const digest = planIdentity(plan); const cur = state.plans.get(providerId);
    if (cur && cur.planDigest === digest) return { ok: true, planDigest: digest, fresh: false };
    if (!(isCount(plan.remainingCalls) && typeof plan.verifiedDate === 'string')) return { ok: false, reason: 'ENTITLEMENT_UNKNOWN', planDigest: digest };
    if (cur && !(typeof cur.verifiedDate === 'string' && plan.verifiedDate > cur.verifiedDate)) return { ok: false, reason: 'PLAN_CONFLICT', planDigest: digest };
    write({ type: 'PLAN', providerId, planDigest: digest, billing: plan.billing, remainingCalls: plan.remainingCalls, includedCallsPerMonth: plan.includedCallsPerMonth, verifiedDate: plan.verifiedDate, ts: now() });
    return { ok: true, planDigest: digest, fresh: true };
  }
  function entitlementRemaining(providerId) { const p = state.plans.get(providerId); if (!p || p.remainingCalls === null) return null; let used = 0; for (const x of state.byId.values()) if (x.providerId === providerId && x.ts >= p.ts) used += spentCredits(x); return Math.max(0, p.remainingCalls - used); }
  let seq = 0;
  function reserve({ providerId, endpointId, unit, credits, chargedOn, purpose, requestKey, estimatedUsd }) {
    guard(); const ts = now(); seq += 1;
    const reservationId = `qr-${canonicalDigest({ providerId, endpointId, requestKey, ts, seq, pid: process.pid }).slice(0, 40)}`;
    write({ type: 'RESERVE', reservationId, providerId, endpointId, calls: 1, credits, unit, chargedOn, purpose, requestKey: String(requestKey).slice(0, 512), estimatedUsd, ts });
    return reservationId;
  }
  const settle = (reservationId, { ok, status = null, credits = null }) => { guard(); const x = state.byId.get(reservationId); if (!x) fail('INVALID_REQUEST', 'unknown reservation'); const c = credits === null ? (x.chargedOn === 'SUCCESS' && !ok ? 0 : x.credits) : credits; write({ type: 'SETTLE', reservationId, ok: ok === true, status: isCount(status) ? status : null, credits: c, ts: now() }); };
  const unresolved = (reservationId, reason) => { guard(); write({ type: 'UNRESOLVED', reservationId, reason: String(reason).slice(0, 64), ts: now() }); };
  const release = (reservationId, reason) => { guard(); write({ type: 'RELEASE', reservationId, reason: String(reason).slice(0, 64), ts: now() }); };
  return {
    journalVersion: QUOTA_JOURNAL_VERSION, durable, files, loadPlan, entitlementRemaining, reserve, settle, unresolved, release, totals, now,
    reservations: () => deepFreeze([...state.byId.values()].map((x) => ({ ...x }))), plans: () => deepFreeze(Object.fromEntries([...state.plans.entries()].map(([k, v]) => [k, { ...v }]))),
    close: () => { if (closed) return; closed = true; close(); }, isClosed: () => closed,
  };
}
// the durable single-owner journal at a STABLE accounting location (never a per-run output directory)
export function openQuotaJournal({ dir, clock = () => Date.now(), pid = process.pid }) {
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'quota.lock'); const journalFile = path.join(dir, 'quota.jsonl');
  let lockFd = null;
  try { lockFd = openSync(lockFile, 'wx'); writeAll(lockFd, Buffer.from(`${JSON.stringify({ pid, openedTs: clock(), version: QUOTA_JOURNAL_VERSION })}\n`), 'quota.lock'); fsyncSync(lockFd); }
  catch (err) { if (err?.code === 'EEXIST') fail('PERMISSION_FAILURE', 'the provider quota journal is locked by another owner (single-owner law; a stale lock is never deleted by age)'); fail('IO_FAILURE', `cannot lock the quota journal (${err?.code ?? 'error'})`); }
  const releaseLock = () => { if (lockFd !== null) { try { closeSync(lockFd); } catch { /* ignore */ } lockFd = null; try { unlinkSync(lockFile); } catch { /* ignore */ } } };
  const state = createState(); let bytes = 0;
  try {
    if (existsSync(journalFile)) { const buf = readFileSync(journalFile); bytes = buf.length; if (buf.length > MAX_QUOTA_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'quota journal too large — stop explicitly, never cleared to regain budget'); const lines = buf.toString('utf8').split('\n'); for (let i = 0; i < lines.length; i += 1) { const l = lines[i]; if (!l) { if (i !== lines.length - 1) fail('INVALID_INPUT', `quota journal: empty line ${i + 1}`); continue; } if (Buffer.byteLength(l) > MAX_QUOTA_ROW_BYTES) fail('INVALID_INPUT', `quota journal: row ${i + 1} too long`); const p = parseStrictJson(l, { maxBytes: MAX_QUOTA_ROW_BYTES }); if (!p.ok) fail('INVALID_INPUT', `quota journal: line ${i + 1} ${p.error}`); state.apply(p.value, i + 1, true); } }
  } catch (err) { releaseLock(); throw err; }
  function append(rec) { const line = Buffer.from(`${JSON.stringify(rec)}\n`); if (bytes + line.length > MAX_QUOTA_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'quota journal at its bound — dispatch stopped explicitly'); let fd = null; try { fd = openSync(journalFile, 'a'); writeAll(fd, line, 'quota.jsonl'); fsyncSync(fd); bytes += line.length; } catch (err) { if (err?.code === 'RESOURCE_LIMIT_EXCEEDED') throw err; fail('IO_FAILURE', `quota journal append failed (${err?.code ?? 'error'}) — dispatch blocked`); } finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } } }
  const api = journalApi(state, { append, clock, durable: true, close: releaseLock, files: { lockFile, journalFile } });
  // restart law: a reservation left open by a crash may have been dispatched — UNRESOLVED, counted, never refunded
  for (const x of [...state.byId.values()]) if (x.state === 'RESERVED') api.unresolved(x.reservationId, 'RESERVED_AT_RESTART');
  return api;
}
// process-local accounting for FREE public providers when no stable research root is configured (never for paid dispatch)
export function createMemoryQuotaJournal({ clock = () => Date.now() } = {}) { const state = createState(); return journalApi(state, { append: () => {}, clock, durable: false, close: () => {}, files: null }); }

// ---- the guard: one admission decision immediately before dispatch --------------------------------------------------------
export function createDispatchGuard({ policy, env = {}, journal, clock = () => Date.now(), mode = null, lifecycle = () => 'ACTIVE', log = () => {} }) {
  if (!journal || typeof journal.reserve !== 'function') fail('INVALID_REQUEST', 'a quota journal is required');
  const presence = credentialPresence(policy, env); const researchMode = mode ?? policy.mode;
  const refusals = {}; let purposeDefault = 'ACQUIRE';
  const counters = { admitted: 0, refused: 0, dispatched: 0, settled: 0, unresolved: 0, released: 0, credits: 0 };
  const note = (providerId, reasons) => { counters.refused += 1; const r = refusals[providerId] ?? (refusals[providerId] = { count: 0, reasons: {}, lastTs: null, lastReasons: [] }); r.count += 1; r.lastTs = clock(); r.lastReasons = reasons; for (const x of reasons) r.reasons[x] = (r.reasons[x] ?? 0) + 1; };
  function evaluate({ providerId, endpointId, query = null, purpose = purposeDefault }) {
    const reasons = []; const p = policy.providers[providerId]; const e = endpointOf(providerId, endpointId);
    if (researchMode === 'REPLAY_AS_OF') reasons.push('NETWORK_OFF');
    if (lifecycle() !== 'ACTIVE') reasons.push('OWNER_STOPPED');
    if (!p || p.enabled !== true) reasons.push('PROVIDER_DISABLED');
    if (!e || e.method === 'WS') reasons.push('ENDPOINT_UNKNOWN'); else if (p && !endpointPermitted(policy, providerId, endpointId)) reasons.push('ENDPOINT_NOT_PERMITTED');
    if (e && e.authEnv !== null && e.authPlacement !== 'HEADER_OPTIONAL' && presence[providerId]?.access !== 'CONFIGURED') reasons.push('CREDENTIAL_MISSING');
    if (p && p.limits.maxConcurrency === 0) reasons.push('CONCURRENCY_ZERO');
    const charge = e ? nativeCharge({ providerId, endpointId, query }) : null; if (!charge) reasons.push('CHARGE_UNKNOWN');
    if (!p) return { reasons, charge, estimatedUsd: 0 };
    const t = journal.totals(providerId); const credits = charge?.credits ?? 1;
    if (p.limits.maxCallsPerDay === 0) reasons.push('DAY_CAP_ZERO'); else if (t.calls.day + 1 > p.limits.maxCallsPerDay) reasons.push('DAY_CAP');
    if (p.limits.maxCallsPerMonth === 0) reasons.push('MONTH_CAP_ZERO'); else if (t.calls.month + 1 > p.limits.maxCallsPerMonth) reasons.push('MONTH_CAP');
    let estimatedUsd = 0; const billing = p.plan.billing; const smokeLike = purpose === 'PROBE' || purpose === 'SMOKE';
    if (billing === 'FREE') { /* public: local caps only */ }
    else if (!journal.durable) reasons.push('ACCOUNTING_UNAVAILABLE');
    if (billing !== 'FREE' && smokeLike) { if (p.smoke.authorized !== true) reasons.push('SMOKE_NOT_AUTHORIZED'); else if (t.smoke.calls + 1 > p.smoke.maxCalls) reasons.push('SMOKE_CALL_CAP'); }
    if (billing === 'INCLUDED_QUOTA') {
      if (!(isCount(p.plan.includedCallsPerMonth) && isCount(p.plan.remainingCalls))) reasons.push('ENTITLEMENT_UNKNOWN');
      else { if (p.plan.incrementalUsdPerCall !== 0) reasons.push('OVERAGE_NOT_AUTHORIZED'); let lp; try { lp = journal.durable ? journal.loadPlan(providerId, p.plan) : { ok: false, reason: 'ACCOUNTING_UNAVAILABLE' }; } catch (err) { log(`quota plan snapshot failed: ${String(err?.message ?? err).slice(0, 120)}`); lp = { ok: false, reason: err?.code === 'RESOURCE_LIMIT_EXCEEDED' ? 'JOURNAL_LIMIT' : 'ACCOUNTING_UNAVAILABLE' }; } if (!lp.ok) { if (!reasons.includes(lp.reason)) reasons.push(lp.reason); } else { const rem = journal.entitlementRemaining(providerId); if (rem === null) reasons.push('ENTITLEMENT_UNKNOWN'); else if (rem < credits) reasons.push('ENTITLEMENT_EXHAUSTED'); } }
    } else if (billing === 'METERED') {
      if (!(isFiniteNum(p.plan.incrementalUsdPerCall) && p.plan.incrementalUsdPerCall >= 0)) reasons.push('CHARGE_UNKNOWN'); else estimatedUsd = Number((p.plan.incrementalUsdPerCall * credits).toFixed(6));
      if (smokeLike) { if (!(isFiniteNum(p.smoke.maxEstimatedUsd) && p.smoke.maxEstimatedUsd > 0)) { if (!reasons.includes('SMOKE_NOT_AUTHORIZED')) reasons.push('SMOKE_NOT_AUTHORIZED'); } else if (t.smoke.usd + estimatedUsd > p.smoke.maxEstimatedUsd) reasons.push('SMOKE_USD_CAP'); }
      else { const ma = p.plan.meteredAuthorization ?? null; if (!ma || ma.authorized !== true) reasons.push('METERED_AUTHORIZATION_ABSENT'); else { if (t.calls.month + 1 > ma.maxCallsPerMonth) reasons.push('METERED_CALL_CAP'); if (t.usd.month + estimatedUsd > ma.maxEstimatedUsdPerMonth) reasons.push('METERED_USD_CAP'); } }
    } else if (billing !== 'FREE') reasons.push('BILLING_UNKNOWN');
    return { reasons: [...new Set(reasons)], charge, estimatedUsd };
  }
  // cheap refusal BEFORE queueing (no reservation): disabled / zero / unknown conditions never wait in a limiter
  const precheck = (req) => { const v = evaluate(req); return { ok: v.reasons.length === 0, reasons: v.reasons, maxConcurrency: policy.providers[req.providerId]?.limits.maxConcurrency ?? 1 }; };
  // the atomic admission at the dispatch boundary: recheck, then reserve durably; refusal or persistence failure = no wire
  function admit(req) {
    const v = evaluate(req); const providerId = req.providerId;
    if (v.reasons.length) { note(providerId, v.reasons); return { ok: false, reasons: v.reasons, charge: v.charge }; }
    let reservationId;
    try { reservationId = journal.reserve({ providerId, endpointId: req.endpointId, unit: v.charge.unit, credits: v.charge.credits, chargedOn: v.charge.chargedOn, purpose: req.purpose ?? purposeDefault, requestKey: req.requestKey ?? `${providerId}:${req.endpointId}`, estimatedUsd: v.estimatedUsd }); }
    catch (err) { const reason = err?.code === 'RESOURCE_LIMIT_EXCEEDED' ? 'JOURNAL_LIMIT' : 'ACCOUNTING_UNAVAILABLE'; log(`quota reservation failed (${reason}): ${String(err?.message ?? err).slice(0, 120)}`); note(providerId, [reason]); return { ok: false, reasons: [reason], charge: v.charge }; }
    counters.admitted += 1; counters.dispatched += 1; counters.credits += v.charge.credits;
    return { ok: true, reservationId, charge: v.charge, estimatedUsd: v.estimatedUsd };
  }
  const safe = (fn) => { try { fn(); return true; } catch (err) { log(`quota journal mutation failed: ${String(err?.message ?? err).slice(0, 120)}`); return false; } };
  return {
    precheck, admit,
    settle: (id, r) => safe(() => { journal.settle(id, r); counters.settled += 1; }),
    unresolved: (id, reason) => safe(() => { journal.unresolved(id, reason); counters.unresolved += 1; }),
    release: (id, reason) => safe(() => { journal.release(id, reason); counters.released += 1; counters.dispatched -= 1; }),
    mayStream: (providerId, endpointId) => { const p = policy.providers[providerId]; const e = endpointOf(providerId, endpointId); const reasons = []; if (researchMode === 'REPLAY_AS_OF') reasons.push('NETWORK_OFF'); if (lifecycle() !== 'ACTIVE') reasons.push('OWNER_STOPPED'); if (!p || p.enabled !== true) reasons.push('PROVIDER_DISABLED'); if (!e || e.method !== 'WS') reasons.push('ENDPOINT_UNKNOWN'); else if (p && !endpointPermitted(policy, providerId, endpointId)) reasons.push('ENDPOINT_NOT_PERMITTED'); if (p && p.limits.maxConcurrency === 0) reasons.push('CONCURRENCY_ZERO'); return { ok: reasons.length === 0, reasons }; },
    withPurpose: async (purpose, fn) => { if (!DISPATCH_PURPOSES.includes(purpose)) fail('INVALID_REQUEST', 'unknown dispatch purpose'); const prev = purposeDefault; purposeDefault = purpose; try { return await fn(); } finally { purposeDefault = prev; } },
    purpose: () => purposeDefault,
    snapshot: () => deepFreeze({ journal: { version: QUOTA_JOURNAL_VERSION, durable: journal.durable, files: journal.files ?? null, closed: journal.isClosed() }, counters: { ...counters }, providers: Object.fromEntries(PROVIDER_IDS.filter((id) => policy.providers[id]?.enabled).map((id) => [id, { totals: journal.totals(id), entitlementRemaining: journal.entitlementRemaining(id), refusals: refusals[id] ? { ...refusals[id], reasons: { ...refusals[id].reasons } } : null, billing: policy.providers[id].plan.billing, unit: CREDIT_PROVIDERS[id] ? 'CREDIT' : 'CALL' }])), limitation: 'local accounting for THIS owner only; unrelated external users of the same provider account are not observed' }),
    journal,
  };
}
export { PROVIDERS as QUOTA_PROVIDERS };
