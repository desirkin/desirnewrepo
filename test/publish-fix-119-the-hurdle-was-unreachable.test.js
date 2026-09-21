// PUBLISH-FIX-119 (2026-09-21). Why this application had never taken a trade — 7,889 scored decisions, zero entries, ever.
//
// Measured against the REAL cost law on a PERFECT book (infinite depth, one-tick spread, zero slippage — nothing thin to blame),
// the smallest target that can EVER be sized is:
//     stop 0.30% -> 4.55% | 0.50% -> 4.85% | 1.09% -> 5.75% | 1.72% -> 6.70% | 3.0% -> 8.60%
// because the 1.5x reward-to-risk law is applied to FEE-INCLUSIVE terms: the 1.60% round trip is subtracted from the reward and
// added to the risk, so the requirement is 1.5*(stop + fees) + fees.
// The eight close calls of 2026-09-21 proposed targets of 0.20%, 0.28%, 0.37%, 0.71%, 1.31%, 1.40%, 1.77% — every one the high of
// the last TWENTY ONE-MINUTE BARS. Three to twenty-five times too small. It was never close, and it never could be.
import test from 'node:test';
import assert from 'node:assert/strict';
import { minTargetDistance, derivedProjection, scenarioTarget } from '../judge/setups.js';
import { evaluateEntry, sizeSearch, REWARD_RISK_MIN } from '../judge/cost.js';
import { feeContract } from '../execution/contract.js';

const ASK = 0.48422, TICK = 0.00001, RT = '0.016';
const fee = feeContract({ venue: 'kraken', pairKey: 'UAIUSD', orderType: 'TAKER', rate: '0.008', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'test', observedTs: 1789000000000 });
const spec = { priceIncrement: '0.00001', qtyIncrement: '0.1', orderMin: '1', costMin: '5', status: 'online' };
const perfect = () => { const lv = (s, d) => Array.from({ length: 400 }, (_, i) => [(s + d * i * TICK).toFixed(5), '5000000']); return { bids: lv(ASK - TICK, -1), asks: lv(ASK, +1), receiptTs: 0, feedEpoch: 1 }; };
const thin = () => { const lv = (s, d) => Array.from({ length: 25 }, (_, i) => [(s + d * i * TICK * 5).toFixed(5), String(2000 + i * 800)]); return { bids: lv(ASK - TICK * 5, -1), asks: lv(ASK, +1), receiptTs: 0, feedEpoch: 1 }; };

test('FIX119-1: the measurement — on a PERFECT book the old targets are unreachable at ANY size, and the hurdle is the fee-inclusive R/R', () => {
  assert.equal(REWARD_RISK_MIN, '1.5');
  const snapshot = perfect(); const stop = (ASK * (1 - 0.01086)).toFixed(5);
  for (const tgtPct of [0.20, 0.28, 0.37, 0.71, 1.31, 1.40, 1.77, 3.0, 5.0]) {
    const e = evaluateEntry({ snapshot, q: '1000', spec, fee, atr14: '0.0001', structuralStop: stop, targetPrice: (ASK * (1 + tgtPct / 100)).toFixed(5) });
    assert.equal(e.status, 'REFUSED', `a ${tgtPct}% target is refused even on a perfect book`);
    assert.ok(e.reasons.includes('REWARD_RISK_BELOW_1_5'), `${tgtPct}%: the binding reason is the fee-inclusive reward-to-risk law, not depth`);
  }
  // and it is NOT depth, spread or slippage: the same book sizes a big enough target immediately
  const ok = evaluateEntry({ snapshot, q: '1000', spec, fee, atr14: '0.0001', structuralStop: stop, targetPrice: (ASK * 1.08).toFixed(5) });
  assert.equal(ok.status, 'OK', 'the very same perfect book sizes an 8% target');
});

test('FIX119-2: the floor now knows about fees, and it equals the measured hurdle', () => {
  for (const [stopPct, expected] of [[0.3, 4.45], [0.5, 4.75], [1.086, 5.63], [1.718, 6.58], [3.0, 8.50]]) {
    const stop = ASK * (1 - stopPct / 100);
    const pct = (minTargetDistance(ASK, stop, RT) / ASK) * 100;
    assert.ok(Math.abs(pct - expected) < 0.02, `stop ${stopPct}% -> floor ${pct.toFixed(2)}%, expected ~${expected}%`);
    const old = (minTargetDistance(ASK, stop, '0') / ASK) * 100;
    assert.ok(old < pct, `the old fee-blind floor (${old.toFixed(2)}%) was below the real hurdle — that is why it never fired`);
  }
  assert.equal(minTargetDistance(ASK, ASK * 1.2, RT), 0, 'a stop above the entry is refused geometry, not a distance');
  assert.equal(minTargetDistance(ASK, ASK * 0.99, '0'), (ASK - ASK * 0.99) * 1.5, 'fee rate 0 reproduces the old floor exactly');
});

test('FIX119-3: a setup without its own projection gets one from the bars it already froze — one 20-bar range above entry', () => {
  assert.equal(derivedProjection(null, String(ASK)), null);
  assert.equal(derivedProjection({ h20: '1', l20: '2' }, String(ASK)), null, 'an inverted range is not a projection');
  assert.equal(derivedProjection({ h20: '0', l20: '0' }, String(ASK)), null);
  const runner = derivedProjection({ h20: String(ASK * 1.06), l20: String(ASK * 0.94) }, String(ASK));
  assert.ok(Math.abs((Number(runner) / ASK - 1) * 100 - 12) < 0.01, 'a 12% 20-bar range projects 12% above the entry');
  const quiet = derivedProjection({ h20: String(ASK * 1.002), l20: String(ASK * 0.998) }, String(ASK));
  assert.ok(Math.abs((Number(quiet) / ASK - 1) * 100 - 0.4) < 0.01, 'a quiet coin projects 0.4% — still under the floor, still refused');
});

test('FIX119-4: end to end on a REALISTIC thin book — the runner sizes, the quiet coin does not', () => {
  const snapshot = thin(); const stop = (ASK * (1 - 0.01086)).toFixed(5);
  const size = (ind) => sizeSearch({ snapshot, spec, fee, atr14: '0.004', structuralStop: stop, targetPrice: derivedProjection(ind, String(ASK)), cashAvailable: '500', riskBudget: '15' });
  const runner = size({ h20: String(ASK * 1.06), l20: String(ASK * 0.94) });
  assert.equal(runner.status, 'OK', 'a coin that actually moved gets a target that can pay, and sizes');
  assert.ok(Number(runner.q) > 0 && Number(runner.evaluation.bufferedScenarioNetProfit) > 0, 'with a positive buffered profit after the full round trip');
  const quiet = size({ h20: String(ASK * 1.002), l20: String(ASK * 0.998) });
  assert.equal(quiet.status, 'NO_TRADE_SIZE', 'a coin going nowhere is still refused — the projection selects FOR movement');
});

test('FIX119-5: nothing was relaxed — fee rate 0 reproduces the old scenario byte for byte, and the cost law is untouched', () => {
  const frozen = { scenarioRaw: String(ASK * 1.014), scenarioProjected: null, structuralStop: String(ASK * (1 - 0.01086)) };
  const before = scenarioTarget(frozen, [], String(ASK), 0, null, '0');
  assert.equal(before.target, frozen.scenarioRaw, 'no ind and no fee -> the raw target stands, exactly as before this fix');
  const after = scenarioTarget(frozen, [], String(ASK), 0, { h20: String(ASK * 1.06), l20: String(ASK * 0.94) }, RT);
  assert.ok(Number(after.target) > Number(frozen.scenarioRaw), 'with the fee-aware floor the projection is preferred');
  const src = readCost();
  assert.match(src, /export const REWARD_RISK_MIN = '1\.5';/, 'the reward-to-risk law did not move');
  assert.match(src, /export const bufferOf = \(atr14, tick\) => max\(M\.mul\('2', tick\), M\.mul\('0\.1', atr14\)\);/, 'the execution buffer did not move');
  assert.match(src, /export const REFERENCE_HAIRCUT = '0\.5';/, 'the depth haircut did not move');
});
import { readFileSync } from 'node:fs';
function readCost() { return readFileSync('judge/cost.js', 'utf8'); }
