// FINAL DYNAMIC-SIZING ADDENDUM — the size ladder over the EXISTING cost law, and the candle-fidelity honesty of
// the learning-side joint study. Risk caps stay binding at every size; missing/stale books invent nothing; larger
// sizes lose when depth consumption destroys the advantage; all-in wins only when it genuinely outperforms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSizeLadder, sizingMeasurement, DEFAULT_FRACTIONS, SIZING_OBJECTIVE } from '../judge/size-ladder.js';
import { compareStrategySizeGrid } from '../learning/sizing-study.js';
import { instrumentSpec, feeContract } from '../execution/contract.js';

const T0 = Date.parse('2026-09-13T12:00:00Z');
const SPEC = instrumentSpec({ venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online', priceIncrement: '0.1', qtyIncrement: '0.00000001', orderMin: '0.00005', costMin: '0.5', priceDecimals: 1, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE' });
const FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'fixture', observedTs: T0 });
const snap = (asks, bids) => ({ asks, bids, digest: 'a'.repeat(64), receiptTs: T0, receiptSequence: 1, feedEpoch: 1, crcVerified: true, synced: true });
// geometry that clears the UNCHANGED 1.5 reward/stressed-risk screen: profit/unit ~3960, stressed loss/unit ~740
const GEOMETRY = { atr14: '400', structuralStop: '99500', targetPrice: '104000', maxEntryLevel: '101000' };

test('a deep book: the full risk-bounded budget wins the declared objective (profit scales while marginal depth carries the advantage) and all-in is flagged eligible with every candidate size recorded', () => {
  const deep = snap([['100000', '50'], ['100050', '50']], [['99990', '50'], ['99950', '50']]);
  const ladder = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000' });
  assert.equal(ladder.objective, SIZING_OBJECTIVE);
  assert.equal(ladder.candidates.length, DEFAULT_FRACTIONS.length);
  assert.equal(ladder.selected.fraction, '1');
  assert.equal(ladder.allInEligible, true);
  const smaller = ladder.candidates.find((c) => c.fraction === '0.25');
  assert.equal(smaller.whyNotSelected, 'LOWER_BUFFERED_NET_PROFIT');
  const m = sizingMeasurement(ladder);
  assert.equal(m.id, 'DYNAMIC_SIZE_SELECTION'); assert.equal(m.ok, true); assert.equal(m.value, 1);
  assert.equal(m.unit, 'FRACTION_OF_RISK_BOUNDED_SPENDABLE');
});

test('a thin book: larger fractions are rejected or lose when walking the depth destroys the advantage — a smaller supported amount is selected, with the larger sizes’ reasons recorded', () => {
  // enough depth for the small size near the touch; the rest priced so badly the reward/risk screen refuses it
  const thin = snap([['100000', '0.012'], ['113000', '80']], [['99990', '0.012'], ['88000', '80']]);
  const ladder = evaluateSizeLadder({ snapshot: thin, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000' });
  assert.ok(ladder.selected, `a smaller size stays supported: ${JSON.stringify(ladder.candidates)}`);
  assert.notEqual(ladder.selected.fraction, '1', 'the full budget is NOT selected on a thin book');
  assert.equal(ladder.allInEligible, false);
  const full = ladder.candidates.find((c) => c.fraction === '1');
  assert.ok(full.whyNotSelected !== null, `the full-size rejection is recorded (${JSON.stringify(full)})`);
});

test('risk caps stay binding at every size: a small risk budget bounds even the full-cash fraction (no safety control weakened for a larger purchase)', () => {
  const deep = snap([['100000', '50']], [['99990', '50']]);
  const capped = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '20' });
  const uncapped = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000' });
  const q = (l) => Number(l.selected.found.q);
  assert.ok(q(capped) < q(uncapped), `the risk budget, not the cash fraction, binds (${q(capped)} vs ${q(uncapped)})`);
  for (const c of capped.candidates.filter((x) => x.status === 'OK')) assert.ok(Number(c.scenarioStressedLoss) <= 20 + 1e-9, 'no size exceeds the unchanged risk budget');
});

test('a missing or one-sided book invents nothing: no price, no executable size, no selection', () => {
  const ladder = evaluateSizeLadder({ snapshot: { asks: [], bids: [['99990', '5']], digest: 'a'.repeat(64) }, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '1000' });
  assert.equal(ladder.selected, null);
  assert.equal(ladder.reason, 'NO_ELIGIBLE_SIZE');
  assert.ok(ladder.candidates.every((c) => c.status !== 'OK'));
});

test('learning-side joint study: cells are independent; candle-fidelity inputs can NEVER validate all-in; a depth-supported curve can, and can also reject larger sizes', () => {
  const opportunity = { grossPct: 2, feePctPerSide: 0.1, spendableUsd: 1000 };
  const strategies = [{ id: 'base', decision: 'ENTER' }, { id: 'skip', decision: 'SKIP' }];
  // candle fidelity: flat assumed penalty -> all-in wins the USD objective but is NOT eligible
  const candle = compareStrategySizeGrid({ opportunity, strategies, costCurve: { kind: 'ASSUMED_CANDLE_FIDELITY', extraSlippageBpsAt: () => 5 } });
  assert.equal(candle.best.fraction, 1);
  assert.equal(candle.allInEligible, false);
  assert.match(candle.allInReason, /CANDLE_FIDELITY/);
  assert.ok(candle.cells.some((c) => c.assumptionLabel), 'assumed penalties are labelled');
  assert.ok(candle.cells.filter((c) => c.strategyId === 'skip').every((c) => c.netUsd === 0), 'a skipping strategy ties up nothing — cells never share fills');
  // depth-supported curve where the full size destroys the edge -> a smaller fraction wins
  const steep = compareStrategySizeGrid({ opportunity, strategies, costCurve: { kind: 'DEPTH_SUPPORTED', extraSlippageBpsAt: (f) => (f >= 1 ? 250 : f >= 0.75 ? 120 : 5) } });
  assert.ok(steep.best.fraction < 1, `depth consumption rejects the full size (best ${steep.best.fraction})`);
  assert.equal(steep.allInEligible, false);
  // depth-supported curve that stays cheap -> all-in wins AND is eligible
  const cheap = compareStrategySizeGrid({ opportunity, strategies, costCurve: { kind: 'DEPTH_SUPPORTED', extraSlippageBpsAt: () => 2 } });
  assert.equal(cheap.allInEligible, true);
  assert.equal(cheap.allInReason, 'ALL_IN_WON_UNDER_DEPTH_SUPPORTED_COSTS');
});
