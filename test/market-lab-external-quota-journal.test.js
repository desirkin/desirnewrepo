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
