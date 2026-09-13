// FINAL DYNAMIC-SIZING ADDENDUM (review-corrected) — the size ladder over the EXISTING cost law, the sustainable
// net-return objective, per-size prepared-input checks (admission law, candidate max supported size, freshness,
// protective exit), the conservative all-in prerequisites, and the candle-fidelity honesty of the learning-side
// joint study. Risk caps stay binding at every size; missing/stale inputs make full-balance ineligible; nothing
// is ever invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSizeLadder, sizingMeasurement, sizingCandidateLog, DEFAULT_FRACTIONS, SIZING_OBJECTIVE, SUSTAINABILITY_TOLERANCE } from '../judge/size-ladder.js';
import { compareStrategySizeGrid } from '../learning/sizing-study.js';
import { instrumentSpec, feeContract } from '../execution/contract.js';

const T0 = Date.parse('2026-09-13T12:00:00Z');
const SPEC = instrumentSpec({ venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', canonicalCoin: 'BTC', status: 'online', priceIncrement: '0.1', qtyIncrement: '0.00000001', orderMin: '0.00005', costMin: '0.5', priceDecimals: 1, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE' });
const FEE = feeContract({ venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE', currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL', scheduleId: 'fixture', observedTs: T0 });
const snap = (asks, bids) => ({ asks, bids, digest: 'a'.repeat(64), receiptTs: T0, receiptSequence: 1, feedEpoch: 1, crcVerified: true, synced: true });
// geometry that clears the UNCHANGED 1.5 reward/stressed-risk screen: profit/unit ~3960, stressed loss/unit ~740
const GEOMETRY = { atr14: '400', structuralStop: '99500', targetPrice: '104000', maxEntryLevel: '101000' };
// complete prepared inputs: the unchanged admission law (accepting here), genuine candidate size evidence, freshness
const PREPARED = { admissible: () => ({ ok: true, reasons: [] }), candidateMaxSizeUsd: 1_000_000, maxBookAgeMs: 60_000 };
const NOW = T0 + 1_000;

test('a deep book WITH every prerequisite prepared: the full risk-bounded budget wins the sustainable objective, all-in is flagged eligible, and EVERY size records executable entry/exit, fees, spread/slippage, net return %, stressed loss, depth-exit sensitivities and the admission verdict', () => {
  const deep = snap([['100000', '50'], ['100050', '50']], [['99990', '50'], ['99950', '50']]);
  const ladder = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: PREPARED, nowTs: NOW });
  assert.equal(ladder.objective, SIZING_OBJECTIVE);
  assert.equal(ladder.candidates.length, DEFAULT_FRACTIONS.length);
  assert.equal(ladder.selected.fraction, '1');
  assert.equal(ladder.allInEligible, true);
  assert.deepEqual(ladder.allInMissing, []);
  for (const c of ladder.candidates.filter((x) => x.status === 'OK')) {
    for (const k of ['entryLimitPrice', 'entryCashOut', 'scenarioExitCashIn', 'entryFeeBound', 'spreadCost', 'slippageCost', 'bufferedScenarioNetProfit', 'netReturnPct', 'scenarioStressedLoss', 'rewardRiskRatio', 'depthExitSensitivities', 'opportunityCostVsStayOut']) assert.ok(k in c, `size row records ${k}`);
    assert.equal(c.admission.ok, true, 'the unchanged admission law is consulted per size');
    assert.equal(c.protectiveExitOk, true, 'the protective exit survives the deepest recorded haircut');
  }
  const smaller = ladder.candidates.find((c) => c.fraction === '0.25');
  assert.equal(smaller.whyNotSelected, 'LOWER_BUFFERED_NET_PROFIT');
  const m = sizingMeasurement(ladder);
  assert.equal(m.id, 'DYNAMIC_SIZE_SELECTION'); assert.equal(m.ok, true); assert.equal(m.value, 1);
  assert.equal(m.unit, 'FRACTION_OF_RISK_BOUNDED_SPENDABLE');
  assert.ok(m.note.length <= 300, 'the summary note respects the closed decision bound');
  const logRows = sizingCandidateLog(ladder);
  assert.equal(logRows.length, DEFAULT_FRACTIONS.length, 'one durable row per candidate size');
  assert.ok(logRows.every((x) => x.note.length <= 300));
  assert.ok(logRows.find((x) => x.value === 1).note.includes('SELECTED'));
  assert.ok(logRows.find((x) => x.value === 0.25).note.includes('r='), 'net return rides the per-size durable row');
});

test('ALL-IN PREREQUISITES: without prepared inputs the fraction-1 candidate may not even compete — the ladder falls back to a smaller supported size and names every missing prerequisite; null candidate size evidence (candle-fidelity validation) and a stale book each keep full-balance ineligible', () => {
  const deep = snap([['100000', '50'], ['100050', '50']], [['99990', '50'], ['99950', '50']]);
  const bare = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000' });
  assert.equal(bare.allInEligible, false);
  assert.notEqual(bare.selected.fraction, '1', 'conservative fallback: a smaller supported size is selected');
  const full = bare.candidates.find((c) => c.fraction === '1');
  assert.match(full.reason, /^ALL_IN_PREREQUISITES_MISSING:/);
  assert.ok(bare.allInMissing.includes('ADMISSION_LAW') && bare.allInMissing.includes('CANDIDATE_MAX_SIZE_EVIDENCE') && bare.allInMissing.includes('FRESHNESS_LAW'));
  // a validated candidate that DECLARED no size evidence (maxSizeUsd null — every candle-fidelity validation) cannot license all-in
  const noEvidence = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: { ...PREPARED, candidateMaxSizeUsd: null }, nowTs: NOW });
  assert.equal(noEvidence.allInEligible, false);
  assert.ok(noEvidence.allInMissing.includes('CANDIDATE_MAX_SIZE_EVIDENCE'));
  // a stale book fails the freshness prerequisite even with everything else present
  const stale = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: PREPARED, nowTs: T0 + 10 * 60_000 });
  assert.ok(stale.allInMissing.includes('FRESH_BOOK'));
  assert.equal(stale.allInEligible, false);
});

test('the declared candidate maximum supported size binds EVERY fraction it covers, and a refusing admission law (concentration/reservations/caps — the unchanged admitCandidate) refuses that size with the reason recorded', () => {
  const deep = snap([['100000', '50']], [['99990', '50']]);
  const capped = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: { ...PREPARED, candidateMaxSizeUsd: 3000 }, nowTs: NOW });
  for (const c of capped.candidates.filter((x) => Number(x.fraction) >= 0.5)) assert.equal(c.reason, 'ABOVE_CANDIDATE_MAX_SUPPORTED_SIZE');
  assert.equal(capped.selected.fraction, '0.25');
  assert.equal(capped.allInEligible, false);
  const congested = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: { ...PREPARED, admissible: (e) => (Number(e.entryCashOut) > 5100 ? { ok: false, reasons: ['CLUSTER_RISK_CAP'] } : { ok: true, reasons: [] }) }, nowTs: NOW });
  const bigRows = congested.candidates.filter((x) => Number(x.fraction) >= 0.75);
  for (const c of bigRows) assert.equal(c.reason, 'ADMISSION_CLUSTER_RISK_CAP', `the admission refusal is recorded per size (${JSON.stringify(c.reason)})`);
  assert.equal(congested.selected.fraction, '0.5');
});

test('SUSTAINABLE objective: a larger size with nominally higher absolute profit but a net return degraded beyond the predeclared tolerance does NOT displace the smaller size — depth consumption is a real account cost, not a tie-break footnote', () => {
  // 0.05 BTC at the touch, the rest priced 600 higher: the full budget walks the book, absolute profit still rises
  // (~309 vs ~185) but the net return collapses (~3.09% vs ~3.71%, a ~17% degradation beyond the 10% tolerance)
  const stepped = snap([['100000', '0.05'], ['100600', '50']], [['99990', '50'], ['99950', '50']]);
  const ladder = evaluateSizeLadder({ snapshot: stepped, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: PREPARED, nowTs: NOW });
  assert.ok(ladder.selected, JSON.stringify(ladder.candidates, null, 1));
  assert.notEqual(ladder.selected.fraction, '1', `the degraded full size must not win (selected ${ladder.selected.fraction})`);
  const full = ladder.candidates.find((c) => c.fraction === '1');
  assert.equal(full.status, 'OK', 'the full size IS executable — it loses on the objective, honestly recorded');
  assert.equal(full.whyNotSelected, 'NET_RETURN_DEGRADATION_BEYOND_TOLERANCE');
  assert.equal(ladder.allInEligible, false);
  assert.equal(ladder.sustainabilityTolerance, SUSTAINABILITY_TOLERANCE);
});

test('a thin book: larger fractions are rejected or lose when walking the depth destroys the advantage — a smaller supported amount is selected, with the larger sizes’ reasons recorded', () => {
  const thin = snap([['100000', '0.012'], ['113000', '80']], [['99990', '0.012'], ['88000', '80']]);
  const ladder = evaluateSizeLadder({ snapshot: thin, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: PREPARED, nowTs: NOW });
  assert.ok(ladder.selected, `a smaller size stays supported: ${JSON.stringify(ladder.candidates)}`);
  assert.notEqual(ladder.selected.fraction, '1', 'the full budget is NOT selected on a thin book');
  assert.equal(ladder.allInEligible, false);
  const full = ladder.candidates.find((c) => c.fraction === '1');
  assert.ok(full.whyNotSelected !== null, `the full-size rejection is recorded (${JSON.stringify(full)})`);
});

test('risk caps stay binding at every size: a small risk budget bounds even the full-cash fraction (no safety control weakened for a larger purchase)', () => {
  const deep = snap([['100000', '50']], [['99990', '50']]);
  const capped = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '20', prepared: PREPARED, nowTs: NOW });
  const uncapped = evaluateSizeLadder({ snapshot: deep, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '100000', prepared: PREPARED, nowTs: NOW });
  const q = (l) => Number(l.selected.found.q);
  assert.ok(q(capped) < q(uncapped), `the risk budget, not the cash fraction, binds (${q(capped)} vs ${q(uncapped)})`);
  for (const c of capped.candidates.filter((x) => x.status === 'OK')) assert.ok(Number(c.scenarioStressedLoss) <= 20 + 1e-9, 'no size exceeds the unchanged risk budget');
});

test('a missing or one-sided book invents nothing: no price, no executable size, no selection', () => {
  const ladder = evaluateSizeLadder({ snapshot: { asks: [], bids: [['99990', '5']], digest: 'a'.repeat(64) }, spec: SPEC, fee: FEE, ...GEOMETRY, cashAvailable: '10000', riskBudget: '1000', prepared: PREPARED, nowTs: NOW });
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
