// USDT→USD FROZEN-BASIS GATE (pure kernel, extracted from the retired Binance-global provider — SENSE-CULL-3). The frozen
// USD basis (USDT held at exactly 1) is trusted only while the stablecoin peg is fresh and near parity; a missing, stale, or
// depegged reading fails CLOSED (usd null, never a guessed 1). This is the isolation guard for the IFR cross-venue episode:
// a de-peg must never masquerade as a Kraken-only flush.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stablecoinHealthGate, usdBasisFromUsdt, FROZEN_USDT_USD_BASIS } from '../market-lab/usdt-basis-gate.js';

const HEALTHY = { pegPrice: 1.0004, pegDeviationBps: 4, ageMs: 60_000 };

test('UBG-1. the frozen USD basis is exactly one and only trusted while the stablecoin peg is fresh and near parity (fail-closed otherwise)', () => {
  assert.equal(FROZEN_USDT_USD_BASIS, 1);
  // healthy: usd == usdt (the frozen constant is one), and the gate says so
  const ok = usdBasisFromUsdt(50_000, HEALTHY); assert.equal(ok.usd, 50_000); assert.equal(ok.healthy, true); assert.equal(ok.basis, 1); assert.equal(ok.reason, null);
  // no reading -> UNKNOWN, never a guessed 1
  assert.deepEqual(stablecoinHealthGate(null), { healthy: false, reason: 'STABLECOIN_HEALTH_UNKNOWN' });
  assert.equal(usdBasisFromUsdt(50_000, null).usd, null);
  // stale reading -> refused
  assert.equal(stablecoinHealthGate({ pegDeviationBps: 2, ageMs: 7 * 3_600_000 }).reason, 'STABLECOIN_HEALTH_STALE');
  assert.equal(usdBasisFromUsdt(50_000, { pegDeviationBps: 2, ageMs: 7 * 3_600_000 }).usd, null);
  // depegged reading -> refused (a de-peg must never masquerade as a Kraken-only flush)
  assert.equal(stablecoinHealthGate({ pegDeviationBps: 120, ageMs: 60_000 }).reason, 'STABLECOIN_DEPEGGED');
  const dp = usdBasisFromUsdt(50_000, { pegDeviationBps: 120, ageMs: 60_000 }); assert.equal(dp.usd, null); assert.equal(dp.healthy, false); assert.equal(dp.reason, 'STABLECOIN_DEPEGGED');
});

test('UBG-2. a non-positive or non-finite price yields no USD basis even under a healthy peg (PRICE_UNAVAILABLE, never zero)', () => {
  const z = usdBasisFromUsdt(0, HEALTHY); assert.equal(z.usd, null); assert.equal(z.healthy, true); assert.equal(z.reason, 'PRICE_UNAVAILABLE');
  const n = usdBasisFromUsdt(null, HEALTHY); assert.equal(n.usd, null); assert.equal(n.reason, 'PRICE_UNAVAILABLE');
  const neg = usdBasisFromUsdt(-5, HEALTHY); assert.equal(neg.usd, null); assert.equal(neg.reason, 'PRICE_UNAVAILABLE');
});
