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
export const QUOTA_RECORD_TYPES = Object.freeze(['PLAN', 'RESERVE', 'SETTLE', 'UNRESOLVED', 'RELEASE', 'CARRY']);
export const QUOTA_RESERVATION_STATES = Object.freeze(['RESERVED', 'SETTLED', 'UNRESOLVED', 'RELEASED']);
export const DISPATCH_PURPOSES = Object.freeze(['ACQUIRE', 'CATALOG', 'BROKER', 'PROBE', 'SMOKE']);
export const CHARGE_UNITS = Object.freeze(['CALL', 'CREDIT']);
export const QUOTA_REFUSAL_REASONS = Object.freeze(['NETWORK_OFF', 'OWNER_STOPPED', 'PROVIDER_DISABLED', 'ENDPOINT_UNKNOWN', 'ENDPOINT_NOT_PERMITTED', 'CREDENTIAL_MISSING', 'CONCURRENCY_ZERO', 'CHARGE_UNKNOWN', 'DAY_CAP_ZERO', 'DAY_CAP', 'MONTH_CAP_ZERO', 'MONTH_CAP', 'BILLING_UNKNOWN', 'ENTITLEMENT_UNKNOWN', 'ENTITLEMENT_EXHAUSTED', 'OVERAGE_NOT_AUTHORIZED', 'PLAN_CONFLICT', 'METERED_AUTHORIZATION_ABSENT', 'METERED_CALL_CAP', 'METERED_USD_CAP', 'SMOKE_NOT_AUTHORIZED', 'SMOKE_CALL_CAP', 'SMOKE_USD_CAP', 'ACCOUNTING_UNAVAILABLE', 'JOURNAL_LIMIT']);
export const MAX_QUOTA_JOURNAL_BYTES = 16 * 1024 * 1024;
export const MAX_QUOTA_ROW_BYTES = 4096;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);
const QUOTA_ROW_KEYS = Object.freeze({
  PLAN: ['billing', 'includedCallsPerMonth', 'planDigest', 'providerId', 'remainingCalls', 'ts', 'type', 'verifiedDate'],
  RESERVE: ['calls', 'chargedOn', 'credits', 'endpointId', 'estimatedUsd', 'providerId', 'purpose', 'requestKey', 'reservationId', 'ts', 'type', 'unit'],
  SETTLE: ['credits', 'ok', 'reservationId', 'status', 'ts', 'type'],
  UNRESOLVED: ['reason', 'reservationId', 'ts', 'type'],
  RELEASE: ['reason', 'reservationId', 'ts', 'type'],
  // PUBLISH-FIX-65: one CARRY row = the folded consumption of one provider on one UTC day (compaction); it feeds the day /
  // month / smoke aggregates exactly as the reservations it replaced did, names no reservation and never counts toward an
  // entitlement (that was netted into the provider's PLAN row when the rows were folded)
  CARRY: ['calls', 'credits', 'dayKey', 'providerId', 'smokeCalls', 'smokeUsd', 'ts', 'type', 'usd'],
});

// ---- the native charge of one actual request (documented accounting unit per request type) ------------------------------
// CALL providers: every HTTP request is one call and one unit. CREDIT providers: Tokenomist bills one credit per SUCCESSFUL
// request (chargedOn SUCCESS). WebSocket handshakes and messages are never HTTP calls or native credits. An unknown unit is
// null (denial), never 1.
const CREDIT_PROVIDERS = deepFreeze({ TOKENOMIST: 'PER_SUCCESS' });
export function nativeCharge({ providerId, endpointId, query = null }) {
  const e = endpointOf(providerId, endpointId); if (!e || e.method === 'WS') return null;
  const rule = CREDIT_PROVIDERS[providerId];
  if (!rule) return { unit: 'CALL', calls: 1, credits: 1, chargedOn: 'DISPATCH' };
  return { unit: 'CREDIT', calls: 1, credits: 1, chargedOn: 'SUCCESS' };
}
export const planIdentity = (plan) => canonicalDigest({ name: plan.name, billing: plan.billing, includedCallsPerMonth: plan.includedCallsPerMonth, remainingCalls: plan.remainingCalls, incrementalUsdPerCall: plan.incrementalUsdPerCall, attestation: plan.attestation, verifiedDate: plan.verifiedDate });

// ---- journal rows ------------------------------------------------------------------------------------------------------
function rowError(r, i) {
  const w = `quota journal row ${i}`;
  if (!isPlainObject(r) || !QUOTA_RECORD_TYPES.includes(r.type) || !isTs(r.ts)) return `${w}: type/ts malformed`;
  const actual = Object.keys(r).sort(); const expected = QUOTA_ROW_KEYS[r.type]; if (actual.length !== expected.length || actual.some((key, n) => key !== expected[n])) return `${w}: keys malformed`;
  if (r.type === 'PLAN') { if (!PROVIDER_IDS.includes(r.providerId) || typeof r.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.planDigest) || !(r.remainingCalls === null || isCount(r.remainingCalls)) || !(r.includedCallsPerMonth === null || isCount(r.includedCallsPerMonth)) || !(r.verifiedDate === null || typeof r.verifiedDate === 'string') || !['FREE', 'INCLUDED_QUOTA', 'METERED', 'UNKNOWN'].includes(r.billing)) return `${w}: plan malformed`; return null; }
  if (r.type === 'CARRY') { if (!PROVIDER_IDS.includes(r.providerId) || !isCount(r.calls) || !isCount(r.credits) || !(isFiniteNum(r.usd) && r.usd >= 0) || !isCount(r.smokeCalls) || !(isFiniteNum(r.smokeUsd) && r.smokeUsd >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(r.dayKey) || dayKey(r.ts) < r.dayKey) return `${w}: carry malformed`; return null; }
  if (typeof r.reservationId !== 'string' || !/^qr-[0-9a-f]{24,64}$/.test(r.reservationId)) return `${w}: reservationId malformed`;
  if (r.type === 'RESERVE') { if (!PROVIDER_IDS.includes(r.providerId) || !isId(r.endpointId) || r.calls !== 1 || !isCount(r.credits) || r.credits === 0 || !CHARGE_UNITS.includes(r.unit) || !DISPATCH_PURPOSES.includes(r.purpose) || typeof r.requestKey !== 'string' || r.requestKey.length > 512 || !(isFiniteNum(r.estimatedUsd) && r.estimatedUsd >= 0) || !['DISPATCH', 'SUCCESS'].includes(r.chargedOn)) return `${w}: reservation malformed`; return null; }
  if (r.type === 'SETTLE') { if (typeof r.ok !== 'boolean' || !isCount(r.credits) || !(r.status === null || isCount(r.status))) return `${w}: settlement malformed`; return null; }
  if (typeof r.reason !== 'string' || r.reason.length === 0 || r.reason.length > 64) return `${w}: reason malformed`;
  return null;
}
// PUBLISH-FIX-24 (2026-09-17): totals() used to walk EVERY reservation of the journal (all providers, all days) and format
// two ISO dates per row on every dispatch admission and every status snapshot — production boot 29e95c87 spent ~14% of
// the main thread in dayKey/monthKey alone. The journal now keeps per-provider aggregates (per-day and per-month spend,
// state counts, smoke) that every transition updates by subtracting the row's old contribution and adding the new one,
// so totals() is O(1) and answers exactly what the walk answered. The append-only records stay the single truth: a
// replay rebuilds the aggregates from the rows.
const emptyAgg = () => ({ reserved: 0, settled: 0, unresolved: 0, released: 0, dispatched: 0, smoke: { calls: 0, usd: 0 }, byDay: new Map(), byMonth: new Map() });
const bucketOf = (map, key) => { let b = map.get(key); if (!b) { b = { calls: 0, credits: 0, usd: 0 }; map.set(key, b); } return b; };
function contribute(aggs, x, sign) {
  let a = aggs.get(x.providerId); if (!a) { a = emptyAgg(); aggs.set(x.providerId, a); }
  if (x.state === 'RESERVED') a.reserved += sign; else if (x.state === 'SETTLED') a.settled += sign; else if (x.state === 'UNRESOLVED') a.unresolved += sign; else a.released += sign;
  if (x.state !== 'RELEASED') a.dispatched += sign;
  const c = spentCalls(x) * sign; const cr = spentCredits(x) * sign; const u = spentUsd(x) * sign;
  const d = bucketOf(a.byDay, x.dayKey); d.calls += c; d.credits += cr; d.usd += u;
  const m = bucketOf(a.byMonth, x.monthKey); m.calls += c; m.credits += cr; m.usd += u;
  if (x.purpose === 'PROBE' || x.purpose === 'SMOKE') { a.smoke.calls += c; a.smoke.usd += u; }
}
// PUBLISH-FIX-65: a CARRY row adds its folded totals to the provider's day / month / smoke buckets (never to byId)
function contributeCarry(aggs, r) {
  let a = aggs.get(r.providerId); if (!a) { a = emptyAgg(); aggs.set(r.providerId, a); }
  const d = bucketOf(a.byDay, r.dayKey); d.calls += r.calls; d.credits += r.credits; d.usd += r.usd;
  const m = bucketOf(a.byMonth, r.dayKey.slice(0, 7)); m.calls += r.calls; m.credits += r.credits; m.usd += r.usd;
  a.smoke.calls += r.smokeCalls; a.smoke.usd += r.smokeUsd; a.carried = (a.carried ?? 0) + 1;
}
function createState() {
  const byId = new Map(); const plans = new Map(); const aggs = new Map(); let lastTs = 0; let rows = 0;
  // closeout P2: prepare() validates the row and the transition WITHOUT touching state and returns the nonthrowing commit;
  // the journal persists the bytes between the two, so a rejected transition or a failed write changes no live counter
  const prepare = (r, i, strict) => {
    const e = rowError(r, i); if (e) fail('INVALID_INPUT', e);
    if (r.ts < lastTs && strict) fail('INVALID_INPUT', `quota journal row ${i}: clock runs backwards`);
    const advance = () => { lastTs = Math.max(lastTs, r.ts); rows += 1; };
    if (r.type === 'PLAN') return () => { advance(); plans.set(r.providerId, { ...r }); };
    if (r.type === 'CARRY') return () => { advance(); contributeCarry(aggs, r); };
    if (r.type === 'RESERVE') { if (byId.has(r.reservationId)) fail('INVALID_INPUT', `quota journal row ${i}: duplicate reservation id`); return () => { advance(); const x = { ...r, state: 'RESERVED', settledCredits: null, ok: null, status: null, dayKey: dayKey(r.ts), monthKey: monthKey(r.ts) }; byId.set(r.reservationId, x); contribute(aggs, x, +1); }; }
    const x = byId.get(r.reservationId); if (!x) fail('INVALID_INPUT', `quota journal row ${i}: unknown reservation`);
    if (x.state !== 'RESERVED') fail('INVALID_INPUT', `quota journal row ${i}: impossible transition from ${x.state}`);
    if (r.type === 'SETTLE') { if (r.credits > x.credits) fail('INVALID_INPUT', `quota journal row ${i}: settled credits exceed the reservation`); return () => { advance(); contribute(aggs, x, -1); Object.assign(x, { state: 'SETTLED', settledCredits: r.credits, ok: r.ok, status: r.status, settledTs: r.ts }); contribute(aggs, x, +1); }; }
    if (r.type === 'UNRESOLVED') return () => { advance(); contribute(aggs, x, -1); Object.assign(x, { state: 'UNRESOLVED', reason: r.reason, unresolvedTs: r.ts }); contribute(aggs, x, +1); };
    return () => { advance(); contribute(aggs, x, -1); Object.assign(x, { state: 'RELEASED', reason: r.reason, releasedTs: r.ts }); contribute(aggs, x, +1); };
  };
  const apply = (r, i, strict) => prepare(r, i, strict)();
  // O(1): the provider's aggregates read at the current day / month keys (a bucket that does not exist is zero)
  const totals = (providerId, nowTs) => {
    const a = aggs.get(providerId) ?? emptyAgg(); const d = a.byDay.get(dayKey(nowTs)) ?? { calls: 0, credits: 0, usd: 0 }; const m = a.byMonth.get(monthKey(nowTs)) ?? { calls: 0, credits: 0, usd: 0 };
    return { calls: { day: d.calls, month: m.calls }, credits: { day: d.credits, month: m.credits }, usd: { day: Number(d.usd.toFixed(6)), month: Number(m.usd.toFixed(6)) }, reserved: a.reserved, settled: a.settled, unresolved: a.unresolved, released: a.released, smoke: { calls: a.smoke.calls, usd: Number(a.smoke.usd.toFixed(6)) }, dispatched: a.dispatched };
  };
  return { byId, plans, apply, prepare, totals, lastTs: () => lastTs, rows: () => rows };
}
// spent credits of one reservation against a limit: RESERVED and UNRESOLVED count in full (conservative); SETTLED counts the actual charge; RELEASED is zero
const spentCredits = (x) => (x.state === 'RELEASED' ? 0 : x.state === 'SETTLED' ? x.settledCredits : x.credits);
const spentCalls = (x) => (x.state === 'RELEASED' ? 0 : 1);
const spentUsd = (x) => (x.state === 'RELEASED' ? 0 : x.state === 'SETTLED' ? (x.credits ? x.estimatedUsd * (x.settledCredits / x.credits) : 0) : x.estimatedUsd);

// Pure replay used by the external-checkpoint adapter. The append-only records remain the single accounting truth;
// derived counters are rebuilt and every row/transition/clock/byte bound is checked before a restored mirror is usable.
// PUBLISH-FIX-59 (2026-09-17): the replay is now the birth of an INCREMENTAL mirror — createQuotaMirror — that also
// accepts one strictly validated row at a time (prepare -> commit, the same two-phase law the filesystem journal uses),
// answers a reservation by id in O(1), and keeps its own byte count under the journal bound. The external journal used
// to REPLAY EVERY ROW on every append (and validate, digest and clone the whole checkpoint several times per append):
// production boot 4dd77a32 / feda514a spent 132 s of its first 180 s blocked in replayQuotaRecords / canonicalJson /
// structuredClone, and ~20% of the main thread after boot. replayQuotaRecords keeps its exact frozen snapshot shape.
export function createQuotaMirror(records, { clock = () => Date.now() } = {}) {
  if (!Array.isArray(records)) fail('INVALID_INPUT', 'quota records must be an array');
  const state = createState(); let bytes = 0; const kept = [];
  const encodedBytes = (r, i) => {
    let encoded; try { encoded = Buffer.from(`${JSON.stringify(r)}\n`); } catch { fail('INVALID_INPUT', `quota journal row ${i}: not serializable`); }
    if (encoded.byteLength > MAX_QUOTA_ROW_BYTES) fail('INVALID_INPUT', `quota journal row ${i}: too long`);
    if (bytes + encoded.byteLength > MAX_QUOTA_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'quota records exceed the journal bound');
    return encoded.byteLength;
  };
  // validate the row and its transition against the CURRENT mirror without changing it; the returned commit applies it
  const prepare = (r) => {
    const i = state.rows() + 1; const n = encodedBytes(r, i); const commit = state.prepare(r, i, true);
    return () => { commit(); bytes += n; kept.push(r); };
  };
  for (let i = 0; i < records.length; i += 1) prepare(records[i])();
  const now = () => Math.max(clock(), state.lastTs());
  const totals = (providerId, nowTs = now()) => state.totals(providerId, nowTs);
  function entitlementRemaining(providerId) { const p = state.plans.get(providerId); if (!p || p.remainingCalls === null) return null; let used = 0; for (const x of state.byId.values()) if (x.providerId === providerId && x.ts >= p.ts) used += spentCredits(x); return Math.max(0, p.remainingCalls - used); }
  const strip = ({ dayKey: _d, monthKey: _m, ...x }) => ({ ...x });
  return Object.freeze({
    now, totals, entitlementRemaining, prepare, apply: (r) => prepare(r)(),
    reservation: (id) => { const x = state.byId.get(id); return x ? deepFreeze(strip(x)) : null; },
    reservations: () => deepFreeze([...state.byId.values()].map(strip)),
    plans: () => deepFreeze(Object.fromEntries([...state.plans.entries()].map(([k, v]) => [k, { ...v }]))),
    records: () => deepFreeze(kept.map((r) => ({ ...r }))),
    rows: () => state.rows(), bytes: () => bytes,
  });
}
export function replayQuotaRecords(records, { clock = () => Date.now() } = {}) {
  const m = createQuotaMirror(records, { clock });
  return Object.freeze({ now: m.now, totals: m.totals, entitlementRemaining: m.entitlementRemaining, reservations: m.reservations, plans: m.plans, records: m.records, rows: m.rows(), bytes: m.bytes() });
}

// PUBLISH-FIX-60 (2026-09-17) / PUBLISH-FIX-65 (2026-09-18): COMPACTION — the journal's only truth is its rows, and every
// durable append rewrites all of them (the external checkpoint is one JSON value with a 16 MB bound; the database layer
// also re-validates and canonicalizes the whole value on every write: at 8,196 rows / 1.9 MB that was ~20% of the main
// thread on 2f1fcadc, growing all month). Rows the admission law can no longer ask about one by one are folded into
// CARRY rows, and NOTHING the law reads changes:
//   - a reservation is folded only when it is TERMINAL (SETTLED / RELEASED / UNRESOLVED) and was RESERVED before the
//     retained window (the current UTC day by default: the day cap reads today's bucket row by row, the month cap reads
//     this month's bucket, which the CARRY rows keep whole); an open (RESERVED) reservation is kept whatever its age —
//     compaction never resolves anything;
//   - one CARRY row per provider per UTC day carries the folded calls, credits, usd and (for PROBE / SMOKE purposes) the
//     lifetime smoke calls and usd; it sits where the first folded row of that day sat (so the strict replay's clock law
//     holds) and merges with an earlier CARRY row for the same provider-day on a later compaction;
//   - each provider keeps only its latest PLAN row (older plans are superseded on replay anyway); when that plan carries a
//     remaining-calls entitlement, the consumption of the folded rows since the plan's ts is netted into remainingCalls
//     (never below 0), so entitlementRemaining answers exactly what it answered before (CARRY rows never count there).
// The result is proven, not trusted: a strict replay of the compacted rows must answer the same day / month calls, credits
// and usd, the same lifetime smoke calls / usd, the same entitlement, the same plans and the same open and kept
// reservations for every provider the journal has seen — any difference refuses the compaction and leaves the rows
// untouched. Lifetime state counts (reserved / settled / unresolved / released / dispatched) are informational and do
// drop; no cap reads them.
export const startOfUtcMonth = (ts) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
export const startOfUtcDay = (ts) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
export function compactQuotaRecords(records, { nowTs = Date.now(), retainFromTs = startOfUtcDay(nowTs) } = {}) {
  const before = createQuotaMirror(records, { clock: () => nowTs });
  const byId = new Map(before.reservations().map((x) => [x.reservationId, x]));
  const plans = before.plans();
  const foldable = new Set(); const droppedSpentSincePlan = new Map(); // providerId -> credits consumed by folded rows at/after the plan ts
  for (const x of byId.values()) {
    if (x.state === 'RESERVED' || !(x.ts < retainFromTs)) continue;
    foldable.add(x.reservationId);
    const p = plans[x.providerId]; if (p && p.remainingCalls !== null && x.ts >= p.ts) droppedSpentSincePlan.set(x.providerId, (droppedSpentSincePlan.get(x.providerId) ?? 0) + spentCredits(x));
  }
  // the carries: one per provider-day, placed at the first folded row (reservation or earlier CARRY) of that provider-day
  const carries = new Map(); // key -> { row, at }
  const carryKey = (providerId, day) => `${providerId}|${day}`;
  const addCarry = (providerId, day, at, ts, calls, credits, usd, smokeCalls, smokeUsd) => {
    const k = carryKey(providerId, day); let c = carries.get(k);
    if (!c) { c = { at, row: { type: 'CARRY', providerId, dayKey: day, ts, calls: 0, credits: 0, usd: 0, smokeCalls: 0, smokeUsd: 0 } }; carries.set(k, c); }
    c.row.calls += calls; c.row.credits += credits; c.row.usd += usd; c.row.smokeCalls += smokeCalls; c.row.smokeUsd += smokeUsd;
  };
  const latestPlanIndex = new Map(); records.forEach((r, i) => { if (r?.type === 'PLAN') latestPlanIndex.set(r.providerId, i); });
  let droppedRows = 0; let mergedCarries = 0;
  const keep = new Array(records.length).fill(true);
  // pass 1: which carry groups actually change — a lone CARRY row already before the window with nothing to merge stays as it is
  const members = new Map(); // key -> { carries: [i...], reservations: [i...] }
  const memberOf = (k) => { let m = members.get(k); if (!m) { m = { carries: [], reservations: [] }; members.set(k, m); } return m; };
  records.forEach((r, i) => {
    if (r.type === 'CARRY' && r.ts < retainFromTs) memberOf(carryKey(r.providerId, r.dayKey)).carries.push(i);
    else if (r.type === 'RESERVE' && foldable.has(r.reservationId)) { const x = byId.get(r.reservationId); memberOf(carryKey(x.providerId, dayKey(x.ts))).reservations.push(i); }
  });
  const untouchedCarry = new Set(); for (const m of members.values()) if (m.reservations.length === 0 && m.carries.length === 1) untouchedCarry.add(m.carries[0]);
  records.forEach((r, i) => {
    if (r.type === 'PLAN') { if (latestPlanIndex.get(r.providerId) !== i) { keep[i] = false; droppedRows += 1; } return; }
    if (r.type === 'CARRY') { if (r.ts < retainFromTs && !untouchedCarry.has(i)) { keep[i] = false; droppedRows += 1; mergedCarries += 1; addCarry(r.providerId, r.dayKey, i, r.ts, r.calls, r.credits, r.usd, r.smokeCalls, r.smokeUsd); } return; }
    if (!foldable.has(r.reservationId)) return;
    keep[i] = false; droppedRows += 1;
    if (r.type === 'RESERVE') { const x = byId.get(r.reservationId); const smoke = x.purpose === 'PROBE' || x.purpose === 'SMOKE'; const usd = spentUsd(x); addCarry(x.providerId, dayKey(x.ts), i, x.ts, spentCalls(x), spentCredits(x), usd, smoke ? spentCalls(x) : 0, smoke ? usd : 0); }
  });
  if (droppedRows === 0) return { ok: true, changed: false, rows: records, droppedRows: 0, droppedReservations: 0, carries: 0, before: { rows: before.rows(), bytes: before.bytes() }, after: { rows: before.rows(), bytes: before.bytes() } };
  const carryAt = new Map(); for (const c of carries.values()) carryAt.set(c.at, c.row);
  const out = [];
  records.forEach((r, i) => {
    const carry = carryAt.get(i); if (carry) out.push(carry);
    if (!keep[i]) return;
    if (r.type === 'PLAN') { const fold = droppedSpentSincePlan.get(r.providerId) ?? 0; out.push(fold > 0 && r.remainingCalls !== null ? { ...r, remainingCalls: Math.max(0, r.remainingCalls - fold) } : r); return; }
    out.push(r);
  });
  let after; try { after = createQuotaMirror(out, { clock: () => nowTs }); } catch (error) { return { ok: false, reason: `COMPACTED_REPLAY_REFUSED: ${String(error?.message ?? error).slice(0, 160)}` }; }
  // the proof: everything the admission law reads answers the same
  const providers = new Set([...Object.keys(plans), ...[...byId.values()].map((x) => x.providerId), ...records.filter((r) => r.type === 'CARRY').map((r) => r.providerId)]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const providerId of providers) {
    const a = before.totals(providerId, nowTs); const b = after.totals(providerId, nowTs);
    if (!same(a.calls, b.calls) || !same(a.credits, b.credits) || !same(a.usd, b.usd) || !same(a.smoke, b.smoke)) return { ok: false, reason: `INVARIANT_TOTALS ${providerId}` };
    if (before.entitlementRemaining(providerId) !== after.entitlementRemaining(providerId)) return { ok: false, reason: `INVARIANT_ENTITLEMENT ${providerId}` };
    const pa = plans[providerId]; const pb = after.plans()[providerId];
    if (Boolean(pa) !== Boolean(pb) || (pa && (pa.planDigest !== pb.planDigest || pa.verifiedDate !== pb.verifiedDate || pa.ts !== pb.ts || pa.billing !== pb.billing))) return { ok: false, reason: `INVARIANT_PLAN ${providerId}` };
  }
  const open = (m) => m.reservations().filter((x) => x.state === 'RESERVED').map((x) => x.reservationId).sort();
  if (!same(open(before), open(after))) return { ok: false, reason: 'INVARIANT_OPEN_RESERVATIONS' };
  for (const x of after.reservations()) { const o = byId.get(x.reservationId); if (!o || !same(o, x)) return { ok: false, reason: `INVARIANT_KEPT_RESERVATION ${x.reservationId}` }; }
  return { ok: true, changed: true, rows: out, droppedRows, droppedReservations: foldable.size, carries: carries.size, mergedCarries, retainFromTs, before: { rows: before.rows(), bytes: before.bytes() }, after: { rows: after.rows(), bytes: after.bytes() } };
}

export function validateQuotaRecords(records) {
  try { const replay = replayQuotaRecords(records, { clock: () => 0 }); return { ok: true, rows: replay.rows, bytes: replay.bytes }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 180), code: error?.code ?? 'INVALID_INPUT' }; }
}

function journalApi(state, { append, clock, durable, close, files }) {
  let closed = false; let failure = null; // closeout P2: the first failed / uncertain durable write latches; no allowance until a safe reopen
  const guard = () => { if (closed) fail('PERMISSION_FAILURE', 'quota journal closed — no mutation after release'); if (failure) fail('IO_FAILURE', `quota journal accounting failure latched (${failure.code}: ${failure.message}) — no new dispatch until a safe reopen`); };
  const now = () => Math.max(clock(), state.lastTs()); // clock rollback never regains a consumed bucket
  // validate -> persist -> commit (P2): live state changes only after the bytes are durable
  const write = (rec) => { guard(); const commit = state.prepare(rec, state.rows() + 1, false); try { append(rec); } catch (err) { if (err?.code !== 'RESOURCE_LIMIT_EXCEEDED' && !failure) failure = { code: err?.code ?? 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) }; throw err; } commit(); };
  const totals = (providerId, nowTs = now()) => state.totals(providerId, nowTs);
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
    reservations: () => deepFreeze([...state.byId.values()].map(({ dayKey: _d, monthKey: _m, ...x }) => ({ ...x }))), plans: () => deepFreeze(Object.fromEntries([...state.plans.entries()].map(([k, v]) => [k, { ...v }]))),
    close: () => { if (closed) return; closed = true; close(); }, isClosed: () => closed, failed: () => (failure ? { ...failure } : null),
  };
}
// the durable single-owner journal at a STABLE accounting location (never a per-run output directory)
// PUBLISH-FIX-13 (2026-09-17): the same dead-owner law the runtime and broad-Kraken locks use (PUBLISH-FIX-1/3). A quota
// lock left by a PREVIOUS BOOT (a republished disk and the object-store restore both bring the old process's lock back)
// is a stale artifact: it is recovered and logged, never "manual review". Staleness is decided by the kernel boot id
// first (a different boot is always stale even if the recorded pid is now a live unrelated process), then by pid
// liveness for a lock from THIS boot. A live owner from this boot still refuses (real contention); an unreadable or
// invalid lock still refuses; a pid we cannot verify (EPERM) refuses rather than guess. Age is never the reason.
export function currentBootId() { try { const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); return id.length ? id : null; } catch { return null; } }
// when process `pid` started, in epoch ms (Linux /proc: boot time + start ticks) — null when it cannot be read
export function processStartedAtMs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const after = stat.slice(stat.lastIndexOf(')') + 2).split(' '); const startTicks = Number(after[19]);
    const btime = Number((readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m) ?? [])[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return (btime + startTicks / 100) * 1000; // CLK_TCK is 100 on every Linux the app runs on
  } catch { return null; }
}
export function recoverStaleQuotaLock(lockFile, { log = () => {}, bootId = currentBootId(), isAlive = (pid) => { process.kill(pid, 0); return true; }, startedAtMs = processStartedAtMs } = {}) {
  if (!existsSync(lockFile)) return { recovered: false, reason: 'NO_LOCK' };
  let payload; try { payload = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return { recovered: false, reason: 'UNREADABLE' }; }
  const pid = payload?.pid; if (!Number.isSafeInteger(pid) || pid < 1) return { recovered: false, reason: 'INVALID_PID' };
  if (typeof payload?.bootId === 'string' && payload.bootId.length && bootId && payload.bootId !== bootId) { unlinkSync(lockFile); log(`recovered stale provider quota journal lock from a previous boot (pid ${pid}; the pid may have been reused by this container)`); return { recovered: true, reason: 'PREVIOUS_BOOT', pid }; }
  try { isAlive(pid); }
  catch (error) {
    if (error?.code !== 'ESRCH') return { recovered: false, reason: 'UNVERIFIABLE', pid };
    unlinkSync(lockFile); log(`recovered stale provider quota journal lock from stopped pid ${pid}`); return { recovered: true, reason: 'DEAD_PID', pid };
  }
  // the pid is alive: a process that STARTED AFTER the lock was written cannot be the process that wrote it (a reused pid —
  // the only way a legacy lock without a boot id, restored from a previous container, is ever told apart from a live owner)
  // wallTs is the REAL clock at lock time (the journal's own clock may be injected / replayed); a legacy lock only has openedTs
  const opened = Number.isFinite(payload?.wallTs) ? payload.wallTs : Number.isFinite(payload?.openedTs) ? payload.openedTs : null; const started = opened === null ? null : startedAtMs(pid);
  if (opened !== null && Number.isFinite(started) && started > opened + 1000) { unlinkSync(lockFile); log(`recovered stale provider quota journal lock from reused pid ${pid} (that process started after the lock was written)`); return { recovered: true, reason: 'REUSED_PID', pid }; }
  return { recovered: false, reason: 'LIVE_OWNER', pid };
}
export function openQuotaJournal({ dir, clock = () => Date.now(), pid = process.pid, log = () => {}, recoverStale = true }) {
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'quota.lock'); const journalFile = path.join(dir, 'quota.jsonl');
  let lockFd = null;
  if (recoverStale) recoverStaleQuotaLock(lockFile, { log });
  try { lockFd = openSync(lockFile, 'wx'); writeAll(lockFd, Buffer.from(`${JSON.stringify({ pid, bootId: currentBootId(), openedTs: clock(), wallTs: Date.now(), version: QUOTA_JOURNAL_VERSION })}\n`), 'quota.lock'); fsyncSync(lockFd); }
  catch (err) { if (lockFd !== null) { const owned = lockFd; lockFd = null; try { closeSync(owned); } catch { /* released once */ } try { unlinkSync(lockFile); } catch { /* our own partial lock */ } } if (err?.code === 'EEXIST') fail('PERMISSION_FAILURE', 'the provider quota journal is locked by another owner (single-owner law; a stale lock is never deleted by age)'); fail('IO_FAILURE', `cannot lock the quota journal (${err?.code ?? 'error'})`); } // correction C: a failed initialization holds neither descriptor nor lock; another process's lock is never deleted
  const releaseLock = () => { if (lockFd !== null) { try { closeSync(lockFd); } catch { /* ignore */ } lockFd = null; try { unlinkSync(lockFile); } catch { /* ignore */ } } };
  const state = createState(); let bytes = 0;
  try {
    if (existsSync(journalFile)) { const buf = readFileSync(journalFile); bytes = buf.length; if (buf.length > MAX_QUOTA_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'quota journal too large — stop explicitly, never cleared to regain budget'); const lines = buf.toString('utf8').split('\n'); for (let i = 0; i < lines.length; i += 1) { const l = lines[i]; if (!l) { if (i !== lines.length - 1) fail('INVALID_INPUT', `quota journal: empty line ${i + 1}`); continue; } if (Buffer.byteLength(l) > MAX_QUOTA_ROW_BYTES) fail('INVALID_INPUT', `quota journal: row ${i + 1} too long`); const p = parseStrictJson(l, { maxBytes: MAX_QUOTA_ROW_BYTES }); if (!p.ok) fail('INVALID_INPUT', `quota journal: line ${i + 1} ${p.error}`); state.apply(p.value, i + 1, true); } }
  } catch (err) { releaseLock(); throw err; }
  function append(rec) { const line = Buffer.from(`${JSON.stringify(rec)}\n`); if (bytes + line.length > MAX_QUOTA_JOURNAL_BYTES) fail('RESOURCE_LIMIT_EXCEEDED', 'quota journal at its bound — dispatch stopped explicitly'); let fd = null; let primary = null;
    // correction C: a successful append is open + write-all + fsync + the ONE primary close; the first failure is kept and surfaced as
    // IO_FAILURE. The descriptor is closed exactly once (the caller never retries a close that may already have released it);
    // a close error after a successful fsync is still an accounting failure — the row may be on disk while live state is not committed.
    try { fd = openSync(journalFile, 'a'); writeAll(fd, line, 'quota.jsonl'); fsyncSync(fd); } catch (err) { primary = err; }
    if (fd !== null) { const owned = fd; fd = null; try { closeSync(owned); } catch (err) { if (!primary) primary = err; } }
    if (primary) { if (primary?.code === 'RESOURCE_LIMIT_EXCEEDED') throw primary; fail('IO_FAILURE', `quota journal append failed (${primary?.code ?? 'error'}: ${String(primary?.message ?? primary).slice(0, 120)}) — dispatch blocked`); }
    bytes += line.length; }
  const api = journalApi(state, { append, clock, durable: true, close: releaseLock, files: { lockFile, journalFile } });
  // restart law: a reservation left open by a crash may have been dispatched — UNRESOLVED, counted, never refunded
  try { for (const x of [...state.byId.values()]) if (x.state === 'RESERVED') api.unresolved(x.reservationId, 'RESERVED_AT_RESTART'); } catch (err) { releaseLock(); throw err; } // a failed initialization holds no lock
  return api;
}
// process-local accounting for FREE public providers when no stable research root is configured (never for paid dispatch)
export function createMemoryQuotaJournal({ clock = () => Date.now(), record = null } = {}) { const state = createState(); return journalApi(state, { append: record ? (r) => record({ ...r }) : () => {}, clock, durable: false, close: () => {}, files: null }); }

// ---- the guard: one admission decision immediately before dispatch --------------------------------------------------------
export function createDispatchGuard({ policy, env = {}, journal, clock = () => Date.now(), mode = null, lifecycle = () => 'ACTIVE', log = () => {} }) {
  if (!journal || typeof journal.reserve !== 'function') fail('INVALID_REQUEST', 'a quota journal is required');
  const presence = credentialPresence(policy, env); const researchMode = mode ?? policy.mode;
  const refusals = {}; let purposeDefault = 'ACQUIRE';
  const counters = { admitted: 0, refused: 0, dispatched: 0, settled: 0, unresolved: 0, released: 0, credits: 0 };
  // An injected durable journal may persist through an async database/CAS adapter. All mutation promises are owned here:
  // reserve is awaited before transport dispatch, terminal transitions are awaited before their result is trusted, and
  // closeout can wait until the set is empty. Synchronous file/memory journals retain their existing API and behaviour.
  const pendingMutations = new Set(); const failures = []; let latchedFailure = null; let failureCount = 0; let admissionTail = Promise.resolve();
  const rememberFailure = (err) => {
    const failure = { code: err?.code ?? 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160), ts: clock() };
    if (!latchedFailure) { latchedFailure = failure; log(`quota journal mutation failed: ${failure.message.slice(0, 120)}`); }
    failures.push(failure); if (failures.length > 16) failures.shift(); failureCount += 1; return failure;
  };
  const trackMutation = (fn) => {
    let p;
    try { p = Promise.resolve(fn()); } catch (err) { p = Promise.reject(err); }
    pendingMutations.add(p); p.then(() => pendingMutations.delete(p), () => pendingMutations.delete(p)); return p;
  };
  const mutate = async (fn) => { try { return await trackMutation(fn); } catch (err) { rememberFailure(err); throw err; } };
  const accountingFailure = () => (journal.failed?.() ?? null) ?? latchedFailure;
  const serializeAdmission = (fn) => { const run = admissionTail.then(fn, fn); admissionTail = run.then(() => undefined, () => undefined); return run; };
  const note = (providerId, reasons) => { counters.refused += 1; const r = refusals[providerId] ?? (refusals[providerId] = { count: 0, reasons: {}, lastTs: null, lastReasons: [] }); r.count += 1; r.lastTs = clock(); r.lastReasons = reasons; for (const x of reasons) r.reasons[x] = (r.reasons[x] ?? 0) + 1; };
  function evaluate({ providerId, endpointId, query = null, purpose = purposeDefault }, { planReady = false } = {}) {
    const reasons = []; const p = policy.providers[providerId]; const e = endpointOf(providerId, endpointId);
    if (researchMode === 'REPLAY_AS_OF') reasons.push('NETWORK_OFF');
    if (lifecycle() !== 'ACTIVE') reasons.push('OWNER_STOPPED');
    if (accountingFailure()) reasons.push('ACCOUNTING_UNAVAILABLE'); // P2: either journal or guard mutation latch admits nothing
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
      else { if (p.plan.incrementalUsdPerCall !== 0) reasons.push('OVERAGE_NOT_AUTHORIZED'); if (!journal.durable) reasons.push('ACCOUNTING_UNAVAILABLE'); else if (planReady) { const rem = journal.entitlementRemaining(providerId); if (rem === null) reasons.push('ENTITLEMENT_UNKNOWN'); else if (rem < credits) reasons.push('ENTITLEMENT_EXHAUSTED'); } }
    } else if (billing === 'METERED') {
      if (!(isFiniteNum(p.plan.incrementalUsdPerCall) && p.plan.incrementalUsdPerCall >= 0)) reasons.push('CHARGE_UNKNOWN'); else estimatedUsd = Number((p.plan.incrementalUsdPerCall * credits).toFixed(6));
      if (smokeLike) { if (!(isFiniteNum(p.smoke.maxEstimatedUsd) && p.smoke.maxEstimatedUsd > 0)) { if (!reasons.includes('SMOKE_NOT_AUTHORIZED')) reasons.push('SMOKE_NOT_AUTHORIZED'); } else if (t.smoke.usd + estimatedUsd > p.smoke.maxEstimatedUsd) reasons.push('SMOKE_USD_CAP'); }
      else { const ma = p.plan.meteredAuthorization ?? null; if (!ma || ma.authorized !== true) reasons.push('METERED_AUTHORIZATION_ABSENT'); else { if (t.calls.month + 1 > ma.maxCallsPerMonth) reasons.push('METERED_CALL_CAP'); if (t.usd.month + estimatedUsd > ma.maxEstimatedUsdPerMonth) reasons.push('METERED_USD_CAP'); } }
    } else if (billing !== 'FREE') reasons.push('BILLING_UNKNOWN');
    return { reasons: [...new Set(reasons)], charge, estimatedUsd };
  }
  // cheap refusal BEFORE queueing (no reservation): disabled / zero / unknown conditions never wait in a limiter
  const precheck = (req) => { const v = evaluate(req); return { ok: v.reasons.length === 0, reasons: v.reasons, maxConcurrency: policy.providers[req.providerId]?.limits.maxConcurrency ?? 1 }; };
  // The last-boundary check and reservation are serialised across concurrent requests. This preserves the old single-threaded
  // cap law while allowing a CAS-backed append to yield. The durable reserve MUST resolve before this function authorises wire I/O.
  function admit(req) { return serializeAdmission(async () => {
    let v = evaluate(req); const providerId = req.providerId;
    if (v.reasons.length) { note(providerId, v.reasons); return { ok: false, reasons: v.reasons, charge: v.charge }; }
    if (policy.providers[providerId]?.plan?.billing === 'INCLUDED_QUOTA') {
      let lp;
      try { lp = await mutate(() => journal.loadPlan(providerId, policy.providers[providerId].plan)); }
      catch (err) { const reason = err?.code === 'RESOURCE_LIMIT_EXCEEDED' ? 'JOURNAL_LIMIT' : 'ACCOUNTING_UNAVAILABLE'; note(providerId, [reason]); return { ok: false, reasons: [reason], charge: v.charge }; }
      if (!lp?.ok) { const reason = QUOTA_REFUSAL_REASONS.includes(lp?.reason) ? lp.reason : 'ACCOUNTING_UNAVAILABLE'; note(providerId, [reason]); return { ok: false, reasons: [reason], charge: v.charge }; }
      v = evaluate(req, { planReady: true });
      if (v.reasons.length) { note(providerId, v.reasons); return { ok: false, reasons: v.reasons, charge: v.charge }; }
    }
    let reservationId;
    try { reservationId = await mutate(() => journal.reserve({ providerId, endpointId: req.endpointId, unit: v.charge.unit, credits: v.charge.credits, chargedOn: v.charge.chargedOn, purpose: req.purpose ?? purposeDefault, requestKey: req.requestKey ?? `${providerId}:${req.endpointId}`, estimatedUsd: v.estimatedUsd })); }
    catch (err) { const reason = err?.code === 'RESOURCE_LIMIT_EXCEEDED' ? 'JOURNAL_LIMIT' : 'ACCOUNTING_UNAVAILABLE'; note(providerId, [reason]); return { ok: false, reasons: [reason], charge: v.charge }; }
    if (!(typeof reservationId === 'string' && reservationId.length)) { const err = Object.assign(new Error('quota journal reserve returned no reservation id'), { code: 'IO_FAILURE' }); rememberFailure(err); note(providerId, ['ACCOUNTING_UNAVAILABLE']); return { ok: false, reasons: ['ACCOUNTING_UNAVAILABLE'], charge: v.charge }; }
    counters.admitted += 1; counters.dispatched += 1; counters.credits += v.charge.credits;
    return { ok: true, reservationId, charge: v.charge, estimatedUsd: v.estimatedUsd };
  }); }
  // P2: a failed accounting transition is NEVER silently swallowed. Async rejection has the exact same latch as sync throw.
  const safeMutation = async (fn, committed) => { try { await mutate(fn); committed(); return true; } catch { return false; } };
  const drained = async () => { await admissionTail; while (pendingMutations.size) await Promise.allSettled([...pendingMutations]); if (typeof journal.drained === 'function') await journal.drained(); };
  return {
    precheck, admit,
    settle: (id, r) => safeMutation(() => journal.settle(id, r), () => { counters.settled += 1; }),
    unresolved: (id, reason) => safeMutation(() => journal.unresolved(id, reason), () => { counters.unresolved += 1; }),
    release: (id, reason) => safeMutation(() => journal.release(id, reason), () => { counters.released += 1; counters.dispatched -= 1; }),
    drained,
    failureCount: () => failureCount, accountingFailure,
    mayStream: (providerId, endpointId) => { const p = policy.providers[providerId]; const e = endpointOf(providerId, endpointId); const reasons = []; if (researchMode === 'REPLAY_AS_OF') reasons.push('NETWORK_OFF'); if (lifecycle() !== 'ACTIVE') reasons.push('OWNER_STOPPED'); if (!p || p.enabled !== true) reasons.push('PROVIDER_DISABLED'); if (!e || e.method !== 'WS') reasons.push('ENDPOINT_UNKNOWN'); else if (p && !endpointPermitted(policy, providerId, endpointId)) reasons.push('ENDPOINT_NOT_PERMITTED'); if (p && p.limits.maxConcurrency === 0) reasons.push('CONCURRENCY_ZERO'); return { ok: reasons.length === 0, reasons }; },
    withPurpose: async (purpose, fn) => { if (!DISPATCH_PURPOSES.includes(purpose)) fail('INVALID_REQUEST', 'unknown dispatch purpose'); const prev = purposeDefault; purposeDefault = purpose; try { return await fn(); } finally { purposeDefault = prev; } },
    purpose: () => purposeDefault,
    snapshot: () => deepFreeze({ journal: { version: journal.journalVersion ?? QUOTA_JOURNAL_VERSION, durable: journal.durable, files: journal.files ?? null, closed: journal.isClosed?.() ?? false, failure: accountingFailure(), transitionFailures: failures.slice(), pendingMutations: pendingMutations.size }, counters: { ...counters }, providers: Object.fromEntries(PROVIDER_IDS.filter((id) => policy.providers[id]?.enabled).map((id) => [id, { totals: journal.totals(id), entitlementRemaining: journal.entitlementRemaining(id), refusals: refusals[id] ? { ...refusals[id], reasons: { ...refusals[id].reasons } } : null, billing: policy.providers[id].plan.billing, unit: CREDIT_PROVIDERS[id] ? 'CREDIT' : 'CALL' }])), limitation: 'accounting for THIS owner only; external usage is visible only if the injected journal reconciles it' }),
    journal,
  };
}
export { PROVIDERS as QUOTA_PROVIDERS };
