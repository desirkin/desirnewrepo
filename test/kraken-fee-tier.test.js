// FEES (Ticket A, 2026-09-15) — the read-only Kraken fee-tier reader. Offline: an injected fetch stub; a base64 secret is
// used only to sign (never verified here). Keys by NAME; fallback to the base schedule; the key/secret/nonce/signature
// never leak. No order verb, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAccountFeeTier, feeScheduleForVolume, baseScheduleResult, feeTierStatus, KRAKEN_PRO_BASE_SCHEDULE, KRAKEN_FEE_TIER_ENV } from '../lib/kraken-fee-tier.js';

const SECRET = Buffer.from('fee-tier-read-only-secret').toString('base64');
const ENV = { [KRAKEN_FEE_TIER_ENV.key]: 'FEE-READ-ONLY-KEY', [KRAKEN_FEE_TIER_ENV.secret]: SECRET };
function stub({ status = 200, body = null, throwOn = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url, method: init.method, headers: init.headers, body: init.body }); if (throwOn) throw Object.assign(new Error('econnrefused'), { code: 'ECONNREFUSED' }); return { ok: status < 300, status, arrayBuffer: async () => Buffer.from(JSON.stringify(body ?? {})) }; };
  return { fetchImpl, calls };
}

test('FEE-1. the base schedule is Kraken Pro base (0.25% maker / 0.40% taker) and the tier table lands a volume correctly', () => {
  assert.equal(KRAKEN_PRO_BASE_SCHEDULE.taker, 0.004); assert.equal(KRAKEN_PRO_BASE_SCHEDULE.maker, 0.0025);
  assert.equal(feeScheduleForVolume(0).takerPct, 0.40); assert.equal(feeScheduleForVolume(60_000).takerPct, 0.24); assert.equal(feeScheduleForVolume(60_000).makerPct, 0.14);
  assert.equal(feeScheduleForVolume(50_000_000).takerPct, 0.10); assert.equal(feeScheduleForVolume(-1).takerPct, 0.40);
  assert.equal(baseScheduleResult('X').source, 'BASE_SCHEDULE'); assert.equal(baseScheduleResult('X').reason, 'X');
});

test('FEE-2. no key -> base schedule fallback, and NOTHING is fetched (read-only, keys by NAME)', async () => {
  const s = stub();
  const r = await readAccountFeeTier({ env: {}, fetchImpl: s.fetchImpl });
  assert.equal(r.source, 'BASE_SCHEDULE'); assert.equal(r.reason, 'CREDENTIAL_MISSING'); assert.equal(r.taker, 0.004);
  assert.equal(s.calls.length, 0, 'no credential -> no call');
});

test('FEE-3. with a key, one signed read-only TradeVolume call yields the account tier; the secret/nonce never leak', async () => {
  const logs = [];
  const s = stub({ body: { error: [], result: { volume: '5000.0', fees: { XXBTZUSD: { fee: '0.24' } }, fees_maker: { XXBTZUSD: { fee: '0.14' } } } } });
  const r = await readAccountFeeTier({ env: ENV, fetchImpl: s.fetchImpl, clock: () => 1_700_000_000_000, log: (m) => logs.push(m) });
  assert.equal(r.source, 'ACCOUNT_TIER'); assert.equal(r.takerPct, 0.24); assert.equal(r.taker, 0.0024); assert.equal(r.makerPct, 0.14); assert.equal(r.volume30dUsd, 5000);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].method, 'POST'); assert.ok(s.calls[0].headers['API-Sign']); assert.match(s.calls[0].body, /^nonce=\d+&pair=XXBTZUSD$/);
  const leak = JSON.stringify(logs) + JSON.stringify(s.calls.map((c) => ({ url: c.url, sign: c.headers['API-Sign'], body: c.body })));
  assert.ok(!leak.includes(SECRET), 'the base64 secret never appears in logs or the recorded body'); // the API-Key header is the request itself; the SECRET must never leak
});

test('FEE-4. a provider error, an HTTP failure, an unreachable host, or missing fee fields all fall back to base; a volume-only response derives the tier', async () => {
  assert.equal((await readAccountFeeTier({ env: ENV, fetchImpl: stub({ body: { error: ['EGeneral:Temporary'] } }).fetchImpl })).reason, 'PROVIDER_ERROR');
  assert.equal((await readAccountFeeTier({ env: ENV, fetchImpl: stub({ status: 500 }).fetchImpl })).reason, 'HTTP_500');
  assert.equal((await readAccountFeeTier({ env: ENV, fetchImpl: stub({ throwOn: true }).fetchImpl })).reason, 'UNREACHABLE');
  const byVol = await readAccountFeeTier({ env: ENV, fetchImpl: stub({ body: { error: [], result: { volume: '75000' } } }).fetchImpl });
  assert.equal(byVol.source, 'ACCOUNT_TIER_BY_VOLUME'); assert.equal(byVol.takerPct, 0.24); assert.equal(byVol.volume30dUsd, 75_000);
});

test('FEE-5. the status names the two env NAMES, present/absent, and carries no value', () => {
  const off = feeTierStatus({}); assert.deepEqual(off.credentialNames, ['KRAKEN_FEE_TIER_API_KEY', 'KRAKEN_FEE_TIER_API_SECRET']); assert.equal(off.credentialPresent, false);
  const on = feeTierStatus(ENV); assert.equal(on.credentialPresent, true); assert.equal(on.base.taker, 0.004);
  assert.ok(!JSON.stringify(feeTierStatus(ENV)).includes(SECRET));
});
