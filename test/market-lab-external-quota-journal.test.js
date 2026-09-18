import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openQuotaJournal, QUOTA_JOURNAL_VERSION, replayQuotaRecords } from '../market-lab/quota.js';
import {
  MARKET_QUOTA_CHECKPOINT_VERSION,
  createExternalQuotaJournal,
  loadMarketQuotaCheckpoint,
  validateMarketQuotaCheckpoint,
} from '../market-lab/external-quota-journal.js';
import { T0, tmp } from './helpers/market-closeout.js';

const emptyCheckpoint = () => ({ version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: [] });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn, timeoutMs = 2000) { const end = Date.now() + timeoutMs; while (!fn()) { if (Date.now() >= end) throw new Error('condition timed out'); await new Promise((r) => setTimeout(r, 2)); } }

function fakeBinding(initial = emptyCheckpoint()) {
  let state = structuredClone(initial); let revision = 1; let failure = null; let gate = null; let failOperation = null; const calls = [];
  return {
    snapshot: () => structuredClone(state),
    revision: () => revision,
    update: async (reducer, meta = null) => {
      calls.push(meta); const next = reducer(structuredClone(state)); if (gate) await gate.promise;
      if (failOperation && meta?.operation === failOperation) { const error = Object.assign(new Error(`fixture ${failOperation} CAS conflict`), { code: 'CHECKPOINT_CAS_CONFLICT' }); failure ??= { code: error.code, message: error.message, ts: T0 }; throw error; }
      state = structuredClone(next); revision += 1; return structuredClone(state);
    },
    failed: () => failure ? { ...failure } : null,
    calls,
    state: () => structuredClone(state),
    delay: (value) => { gate = value; },
    failOn: (operation) => { failOperation = operation; },
  };
}

const reservation = (requestKey) => ({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', unit: 'CALL', credits: 1, chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey, estimatedUsd: 0 });

test('filesystem commissioning import requires a stopped writer, preserves actual rows, and never invents an absent zero checkpoint', () => {
  const root = tmp('market-quota-import-'); const accounting = path.join(root, 'accounting'); let journal = null;
  try {
    assert.equal(loadMarketQuotaCheckpoint(accounting), null, 'missing is absent, not a zero allowance');
    journal = openQuotaJournal({ dir: accounting, clock: () => T0 });
    assert.throws(() => loadMarketQuotaCheckpoint(accounting), (error) => error.code === 'WRITER_ACTIVE');
    const settled = journal.reserve(reservation('settled')); journal.settle(settled, { ok: true, status: 200 });
    const unresolved = journal.reserve(reservation('unresolved')); journal.unresolved(unresolved, 'TIMEOUT');
    const released = journal.reserve(reservation('released')); journal.release(released, 'CANCELLED_BEFORE_DISPATCH');
    journal.close(); journal = null;
    const imported = loadMarketQuotaCheckpoint(accounting); assert.equal(validateMarketQuotaCheckpoint(imported).ok, true);
    const replay = replayQuotaRecords(imported.rows, { clock: () => T0 });
    assert.deepEqual(replay.reservations().map((row) => row.state), ['SETTLED', 'UNRESOLVED', 'RELEASED']);
    assert.deepEqual(replay.totals('KRAKEN_SPOT'), { calls: { day: 2, month: 2 }, credits: { day: 2, month: 2 }, usd: { day: 0, month: 0 }, reserved: 0, settled: 1, unresolved: 1, released: 1, smoke: { calls: 0, usd: 0 }, dispatched: 2 });
  } finally { journal?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('checkpoint validator is closed and replays every transition, clock, and row shape', () => {
  const valid = emptyCheckpoint(); assert.equal(validateMarketQuotaCheckpoint(valid).ok, true);
  assert.equal(validateMarketQuotaCheckpoint({ ...valid, extra: true }).ok, false);
  assert.equal(validateMarketQuotaCheckpoint({ ...valid, journalVersion: 'wrong' }).ok, false);
  const reserve = { type: 'RESERVE', reservationId: `qr-${'a'.repeat(40)}`, providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', calls: 1, credits: 1, unit: 'CALL', chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey: 'x', estimatedUsd: 0, ts: T0 };
  assert.equal(validateMarketQuotaCheckpoint({ ...valid, rows: [{ ...reserve, unknown: true }] }).ok, false, 'unknown row keys are refused');
  assert.equal(validateMarketQuotaCheckpoint({ ...valid, rows: [{ type: 'SETTLE', reservationId: reserve.reservationId, ok: true, status: 200, credits: 1, ts: T0 }] }).ok, false, 'a terminal row cannot mint a reservation');
  assert.equal(validateMarketQuotaCheckpoint({ ...valid, rows: [reserve, { type: 'UNRESOLVED', reservationId: reserve.reservationId, reason: 'TIMEOUT', ts: T0 - 1 }] }).ok, false, 'checkpoint clocks cannot run backwards');
});

test('local importer refuses malformed JSONL instead of commissioning corrupted accounting', () => {
  const root = tmp('market-quota-invalid-'); const accounting = path.join(root, 'accounting'); mkdirSync(accounting, { recursive: true });
  try {
    writeFileSync(path.join(accounting, 'quota.jsonl'), '{"type":"RESERVE","type":"RESERVE"}\n');
    assert.throws(() => loadMarketQuotaCheckpoint(accounting), (error) => error.code === 'CHECKPOINT_INVALID');
    writeFileSync(path.join(accounting, 'quota.jsonl'), Buffer.from([0xff, 0x05, 0x0a]));
    assert.throws(() => loadMarketQuotaCheckpoint(accounting), (error) => error.code === 'CHECKPOINT_INVALID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('external adapter commits the durable CAS before changing its synchronous admission mirror', async () => {
  const gate = deferred(); const binding = fakeBinding(); binding.delay(gate); const journal = createExternalQuotaJournal({ binding, clock: () => T0 });
  const pending = journal.reserve(reservation('delayed')); await until(() => binding.calls.length === 1);
  assert.equal(journal.totals('KRAKEN_SPOT').calls.day, 0); assert.equal(journal.reservations().length, 0, 'an unconfirmed write has no live allowance effect');
  gate.resolve(); const id = await pending;
  assert.equal(journal.totals('KRAKEN_SPOT').calls.day, 1); assert.equal(journal.reservations()[0].state, 'RESERVED'); assert.equal(binding.state().rows.length, 1);
  await journal.settle(id, { ok: true, status: 200 }); assert.equal(journal.reservations()[0].state, 'SETTLED'); assert.equal(binding.state().rows.length, 2);
});

test('external adapter preserves a reserved charge and latches after a failed terminal CAS', async () => {
  const binding = fakeBinding(); const journal = createExternalQuotaJournal({ binding, clock: () => T0 }); const id = await journal.reserve(reservation('cas-fault'));
  binding.failOn('SETTLE'); await assert.rejects(journal.settle(id, { ok: true, status: 200 }), (error) => error.code === 'CHECKPOINT_CAS_CONFLICT');
  assert.equal(journal.reservations()[0].state, 'RESERVED'); assert.equal(binding.state().rows.length, 1, 'the failed terminal write never changes either mirror');
  assert.equal(journal.failed().code, 'CHECKPOINT_CAS_CONFLICT');
  await assert.rejects(journal.reserve(reservation('must-block')), (error) => error.code === 'ACCOUNTING_UNAVAILABLE');
  assert.equal(binding.calls.length, 2, 'the latched follow-up never reaches the binding');
});

test('included plan and entitlement are restored and advanced through the same external row chain', async () => {
  const binding = fakeBinding(); const journal = createExternalQuotaJournal({ binding, clock: () => T0 });
  const plan = { name: 'fixture', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: 10, remainingCalls: 2, incrementalUsdPerCall: 0, attestation: 'fixture', verifiedDate: '2026-09-13' };
  assert.equal((await journal.loadPlan('COINGECKO', plan)).fresh, true); assert.equal(journal.entitlementRemaining('COINGECKO'), 2);
  const id = await journal.reserve({ providerId: 'COINGECKO', endpointId: 'coins-list', unit: 'CALL', credits: 1, chargedOn: 'DISPATCH', purpose: 'CATALOG', requestKey: 'cg', estimatedUsd: 0 });
  await journal.unresolved(id, 'NETWORK'); assert.equal(journal.entitlementRemaining('COINGECKO'), 1);
  assert.equal((await journal.loadPlan('COINGECKO', plan)).fresh, false, 'the same attestation never grants allowance twice');
  assert.equal(validateMarketQuotaCheckpoint(binding.state()).ok, true);
});

// ---- PUBLISH-FIX-59 / 60 (2026-09-17): no replay per append; compaction proven equal for everything the law reads ----
import { compactQuotaRecords, createQuotaMirror, startOfUtcMonth, startOfUtcDay } from '../market-lab/quota.js';
import { COMPACT_AT_BYTES } from '../market-lab/external-quota-journal.js';

const MONTH = 30 * 24 * 60 * 60 * 1000;
const fixtureRows = ({ start, count, providerId = 'KRAKEN_SPOT', purpose = 'ACQUIRE', settle = true, stepMs = 60_000 }) => {
  const rows = []; let ts = start;
  for (let i = 0; i < count; i += 1) {
    const id = `qr-${(ts + i).toString(16).padStart(24, '0')}`; ts += stepMs;
    rows.push({ type: 'RESERVE', reservationId: id, providerId, endpointId: 'rest-ticker', calls: 1, credits: 1, unit: 'CALL', chargedOn: 'DISPATCH', purpose, requestKey: `k${ts}`, estimatedUsd: 0.001, ts });
    if (settle) rows.push({ type: 'SETTLE', reservationId: id, ok: true, status: 200, credits: 1, ts: ts + 1000 });
  }
  return rows;
};

test('FIX-59. the incremental mirror: prepare validates without changing state, apply advances, reservation(id) is O(1), replayQuotaRecords keeps its snapshot shape', () => {
  const rows = fixtureRows({ start: T0, count: 5 });
  const m = createQuotaMirror(rows, { clock: () => T0 + MONTH });
  assert.equal(m.rows(), 10); assert.ok(m.bytes() > 0); assert.equal(m.reservation(rows[0].reservationId).state, 'SETTLED'); assert.equal(m.reservation('qr-000000000000000000000000'), null);
  const open = { type: 'RESERVE', reservationId: 'qr-aaaaaaaaaaaaaaaaaaaaaaaa', providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', calls: 1, credits: 1, unit: 'CALL', chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey: 'open', estimatedUsd: 0, ts: T0 + MONTH };
  const commit = m.prepare(open); assert.equal(m.rows(), 10, 'prepare changes nothing'); assert.equal(m.reservation(open.reservationId), null);
  commit(); assert.equal(m.rows(), 11); assert.equal(m.reservation(open.reservationId).state, 'RESERVED');
  assert.throws(() => m.prepare({ type: 'SETTLE', reservationId: 'qr-bbbbbbbbbbbbbbbbbbbbbbbb', ok: true, status: 200, credits: 1, ts: T0 + MONTH + 1 }), /unknown reservation/);
  assert.throws(() => m.prepare({ ...open, ts: T0 }), /clock runs backwards/);
  assert.equal(m.rows(), 11, 'a refused prepare changes nothing');
  const snap = replayQuotaRecords(rows); assert.equal(snap.rows, 10); assert.equal(typeof snap.bytes, 'number'); assert.equal(snap.records().length, 10);
});

test('FIX-59. the external journal never replays every row on an append: 20,000 rows then 50 appends stay fast, the mirror answers, and a confirmation that is not the proposal is refused', async () => {
  const rows = fixtureRows({ start: T0 - 2 * MONTH, count: 10_000 });
  // a binding that hands its state over by reference: the clock measures the JOURNAL's own work per append, not the store's clones
  let state = { version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows }; let revision = 1;
  const binding = { snapshot: () => state, revision: () => revision, update: async (reducer) => { state = reducer(state); revision += 1; return state; }, failed: () => null };
  const journal = createExternalQuotaJournal({ binding, clock: () => T0 + MONTH });
  assert.equal(journal.size().rows, 20_000);
  const began = performance.now();
  for (let i = 0; i < 50; i += 1) { const id = await journal.reserve(reservation(`fast-${i}`)); await journal.settle(id, { ok: true, status: 200 }); }
  const took = performance.now() - began;
  assert.ok(took < 2000, `100 appends on a 20k-row journal took ${took.toFixed(0)} ms (the old journal replayed all rows several times per append)`);
  assert.equal(journal.size().rows, 20_100); assert.equal(journal.size().appends, 100); assert.equal(journal.totals('KRAKEN_SPOT').calls.month, 50);
  // a database that confirms something other than the proposed append latches the journal
  const lying = fakeBinding(); const original = lying.update; lying.update = async (reducer, meta) => { const saved = await original(reducer, meta); saved.rows[saved.rows.length - 1] = { ...saved.rows[saved.rows.length - 1], requestKey: 'tampered' }; return saved; };
  const j2 = createExternalQuotaJournal({ binding: lying, clock: () => T0 });
  await assert.rejects(j2.reserve(reservation('x')), /CHECKPOINT_CONFIRMATION_INVALID/);
  assert.equal(j2.failed().code, 'CHECKPOINT_CONFIRMATION_INVALID');
});

test('FIX-60/65. compaction folds settled reservations from before today into one CARRY row per provider-day and proves every answer the admission law reads unchanged; open rows stay; probe / smoke fold into the lifetime smoke fields; a plan keeps its entitlement; a later compaction merges carries', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const plan = { type: 'PLAN', providerId: 'COINGECKO', planDigest: 'a'.repeat(64), billing: 'INCLUDED_QUOTA', remainingCalls: 100, includedCallsPerMonth: 1000, verifiedDate: '2026-07-01', ts: T0 - 3 * MONTH };
  const oldPlan = { ...plan, planDigest: 'b'.repeat(64), remainingCalls: 500, verifiedDate: '2026-06-01', ts: T0 - 4 * MONTH };
  const now = T0 + MONTH + 10 * 60 * 60 * 1000; const dayStart = startOfUtcDay(now); const monthStart = startOfUtcMonth(now);
  const twoDaysAgo = fixtureRows({ start: dayStart - 2 * DAY + 60_000, count: 30 });                              // this month, earlier day: folds
  const yesterdayCg = fixtureRows({ start: dayStart - DAY + 60_000, count: 7, providerId: 'COINGECKO' });       // consumption since the plan: netted into remainingCalls
  const probes = fixtureRows({ start: dayStart - DAY + 3_600_000, count: 2, purpose: 'PROBE' });                // lifetime smoke: carried in the smoke fields
  const openOld = fixtureRows({ start: dayStart - DAY + 7_200_000, count: 1, settle: false });                  // still open: kept
  const lastMonth = fixtureRows({ start: monthStart - 5 * DAY, count: 4 });                                       // last month: folds into its own day's carry
  const today = fixtureRows({ start: dayStart + 60_000, count: 5 });                                              // retained: kept row by row
  const rows = [oldPlan, plan, ...lastMonth, ...twoDaysAgo, ...yesterdayCg, ...probes, ...openOld, ...today];
  const before = createQuotaMirror(rows, { clock: () => now });
  const c = compactQuotaRecords(rows, { nowTs: now });
  assert.equal(c.ok, true); assert.equal(c.changed, true);
  assert.equal(c.droppedReservations, 43, '30 + 7 + 2 probes + 4 last month'); assert.equal(c.carries, 4, 'KRAKEN two days ago, COINGECKO yesterday, KRAKEN probes yesterday, KRAKEN last month');
  const after = createQuotaMirror(c.rows, { clock: () => now });
  const carries = c.rows.filter((r) => r.type === 'CARRY'); assert.equal(carries.length, 4);
  const kY = carries.find((r) => r.providerId === 'KRAKEN_SPOT' && r.dayKey === new Date(dayStart - DAY).toISOString().slice(0, 10));
  assert.equal(kY.calls, 2); assert.equal(kY.smokeCalls, 2, 'the two probes ride the smoke fields'); assert.ok(kY.smokeUsd > 0);
  const k2 = carries.find((r) => r.providerId === 'KRAKEN_SPOT' && r.dayKey === new Date(dayStart - 2 * DAY).toISOString().slice(0, 10));
  assert.equal(k2.calls, 30); assert.equal(k2.credits, 30); assert.equal(k2.smokeCalls, 0);
  for (const p of ['KRAKEN_SPOT', 'COINGECKO']) { assert.deepEqual(after.totals(p, now).calls, before.totals(p, now).calls); assert.deepEqual(after.totals(p, now).credits, before.totals(p, now).credits); assert.deepEqual(after.totals(p, now).usd, before.totals(p, now).usd); assert.deepEqual(after.totals(p, now).smoke, before.totals(p, now).smoke); }
  assert.equal(before.totals('KRAKEN_SPOT', now).calls.month, 38, '30 + 2 probes + 1 open + 5 today this month');
  assert.equal(before.entitlementRemaining('COINGECKO'), 93); assert.equal(after.entitlementRemaining('COINGECKO'), 93);
  assert.equal(after.plans().COINGECKO.remainingCalls, 93); assert.equal(after.plans().COINGECKO.planDigest, plan.planDigest);
  assert.equal(after.reservations().filter((x) => x.state === 'RESERVED').length, 1); assert.equal(after.reservations().length, 6, "the open one and today's five");
  // ordering law: the carry sits where its first folded row sat, so the replay's clock never runs backwards
  for (let i = 1; i < c.rows.length; i += 1) assert.ok(c.rows[i].ts >= c.rows[i - 1].ts, `row ${i} keeps the clock`);
  const again = compactQuotaRecords(c.rows, { nowTs: now }); assert.equal(again.changed, false, 'idempotent on the same day');
  // the next day: today's rows fold into a new carry, and yesterday's carries (now before the window) merge unchanged
  // the open reservation from yesterday settles today; tomorrow it folds INTO yesterday's existing KRAKEN carry (a merge)
  const openId = openOld[0].reservationId; const settled = [...c.rows, { type: 'SETTLE', reservationId: openId, ok: true, status: 200, credits: 1, ts: now + 1000 }];
  const tomorrow = now + DAY; const next = compactQuotaRecords(settled, { nowTs: tomorrow });
  assert.equal(next.ok, true); assert.equal(next.droppedReservations, 6, "today's five and the settled one"); assert.equal(next.mergedCarries, 1, 'yesterday\'s KRAKEN carry absorbed the late settlement'); assert.equal(next.carries, 2, 'that merged carry and a new one for today');
  const kY2 = next.rows.filter((r) => r.type === 'CARRY').find((r) => r.providerId === 'KRAKEN_SPOT' && r.dayKey === kY.dayKey); assert.equal(kY2.calls, 3); assert.equal(kY2.smokeCalls, 2);
  assert.equal(next.rows.filter((r) => r.type === 'CARRY').length, 5, 'five carries in all (three untouched, one merged, one new): no duplicates for a provider-day');
  const after2 = createQuotaMirror(next.rows, { clock: () => tomorrow }); const settledMirror = createQuotaMirror(settled, { clock: () => tomorrow });
  assert.deepEqual(after2.totals('KRAKEN_SPOT', tomorrow).calls, settledMirror.totals('KRAKEN_SPOT', tomorrow).calls); assert.deepEqual(after2.totals('KRAKEN_SPOT', tomorrow).smoke, settledMirror.totals('KRAKEN_SPOT', tomorrow).smoke);
  assert.equal(after2.reservations().length, 0, 'nothing is left row by row: everything settled and is carried');
  // an old journal without carries still validates; a carry row with a malformed field is refused
  assert.equal(validateMarketQuotaCheckpoint({ version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: c.rows }).ok, true);
  assert.equal(validateMarketQuotaCheckpoint({ version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows: [{ ...carries[0], calls: -1 }] }).ok, false);
});

test('FIX-60/65. the journal compacts itself: at the boot call, when it passes a quarter of its bound, and once a day; one durable write, mirror rebuilt, answers unchanged', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let now = T0 + MONTH + 10 * 60 * 60 * 1000; const dayStart = startOfUtcDay(now);
  const rows = [...fixtureRows({ start: dayStart - 2 * DAY, count: 200 }), ...fixtureRows({ start: dayStart + 60_000, count: 3 })];
  const binding = fakeBinding({ version: MARKET_QUOTA_CHECKPOINT_VERSION, journalVersion: QUOTA_JOURNAL_VERSION, rows });
  const journal = createExternalQuotaJournal({ binding, clock: () => now });
  const monthBefore = journal.totals('KRAKEN_SPOT').calls.month; const dayBefore = journal.totals('KRAKEN_SPOT').calls.day;
  const r = await journal.compact();
  assert.equal(r.ok, true); assert.equal(r.changed, true); assert.equal(r.droppedReservations, 200); assert.equal(r.carries, 1); assert.equal(r.after.rows, 7, "one carry + today's six rows");
  assert.equal(journal.size().rows, 7); assert.equal(journal.size().compactions, 1);
  assert.equal(journal.totals('KRAKEN_SPOT').calls.month, monthBefore); assert.equal(journal.totals('KRAKEN_SPOT').calls.day, dayBefore);
  assert.equal(binding.calls.at(-1).operation, 'COMPACT'); assert.equal(binding.state().rows.length, 7);
  assert.equal(validateMarketQuotaCheckpoint(binding.state()).ok, true);
  const id = await journal.reserve(reservation('after-compaction')); await journal.settle(id, { ok: true, status: 200 }); assert.equal(journal.size().rows, 9);
  assert.equal((await journal.compact()).changed, false);
  // the day turns: the next append schedules a compaction by itself (off the caller's path), folding yesterday
  now += DAY; const id2 = await journal.reserve(reservation('next-day')); await journal.settle(id2, { ok: true, status: 200 });
  await journal.drained(); await new Promise((resolve) => setTimeout(resolve, 5)); await journal.drained();
  assert.equal(journal.size().compactions, 2, 'the day change compacted'); assert.equal(journal.size().rows, 4, "two carries + today's two rows");
  assert.ok(COMPACT_AT_BYTES > 0);
});
