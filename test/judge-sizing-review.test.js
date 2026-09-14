import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../execution/money.js';
import { instrumentSpec, feeContract } from '../execution/contract.js';
import { evaluateSizeLadder, sizingMeasurement, sizingCandidateLog, MAX_FRACTIONS } from '../judge/size-ladder.js';
import { SETUPS, structuralClauses, fastClauses } from '../judge/setups.js';
import { CANDIDATE_LOG_LIMIT, contributionMeasurement, contributionCandidateLog } from '../judge/learning-intake.js';

const T0 = Date.parse('2026-09-13T12:00:00Z');
const spec = (priceIncrement = '0.1', priceDecimals = 1) => instrumentSpec({
  venue: 'kraken', pairKey: 'XXBTZUSD', altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD',
  canonicalCoin: 'BTC', status: 'online', priceIncrement, qtyIncrement: '0.00000001', orderMin: '0.00005',
  costMin: '0.5', priceDecimals, qtyDecimals: 8, observedTs: T0, source: 'FIXTURE',
});
const SPEC = spec();
const FEE = feeContract({
  venue: 'kraken', pairKey: null, orderType: 'TAKER', rate: '0.001', rateKind: 'PAPER_REFERENCE',
  currency: 'QUOTE', roundingQuantum: '0.01', roundingMode: 'UP', minimumFee: '0', scope: 'ORDER_TOTAL',
  scheduleId: 'fixture', observedTs: T0,
});
const geometry = { atr14: '400', structuralStop: '99500', targetPrice: '104000', maxEntryLevel: '101000' };
const prepared = { admissible: () => ({ ok: true, reasons: [] }), candidateMaxSizeUsd: 1_000_000, maxBookAgeMs: 60_000 };
const snapshot = (asks = [['100000', '50']], bids = [['99990', '50']]) => ({
  asks, bids, digest: 'a'.repeat(64), receiptTs: T0, receiptSequence: 1, feedEpoch: 1, crcVerified: true, synced: true,
});
const args = (overrides = {}) => ({
  snapshot: snapshot(), spec: SPEC, fee: FEE, ...geometry, cashAvailable: '10000', riskBudget: '100000',
  prepared, nowTs: T0 + 1_000, ...overrides,
});

test('fractions are canonicalized before exact-money use, numeric full-size aliases cannot evade prerequisites, duplicates are refused, and malformed configuration never throws', () => {
  const ladder = evaluateSizeLadder(args({ fractions: ['1.0', ' 0.5 ', '01', 0.5, '0.50'], prepared: null }));
  assert.equal(ladder.selected?.fraction, '0.5');
  assert.equal(ladder.candidates.find((row) => row.fraction === '1').reason.startsWith('ALL_IN_PREREQUISITES_MISSING:'), true);
  assert.equal(ladder.candidates.filter((row) => row.reason === 'DUPLICATE_FRACTION').length, 1);
  assert.equal(ladder.candidates.filter((row) => row.reason === 'FRACTION_MALFORMED').length, 2);
  const malformedLogs = sizingCandidateLog(ladder).filter((row) => row.note === 'FRACTION_MALFORMED');
  assert.ok(malformedLogs.every((row) => row.value === null), 'malformed fractions never become NaN or a misleading numeric measurement');

  const nonArray = evaluateSizeLadder(args({ fractions: null }));
  assert.equal(nonArray.candidates[0].reason, 'FRACTIONS_NOT_ARRAY');
  assert.equal(sizingCandidateLog(nonArray)[0].value, null);
  const excessive = evaluateSizeLadder(args({ fractions: Array.from({ length: MAX_FRACTIONS + 1 }, (_, i) => (i + 1) / (MAX_FRACTIONS + 1)) }));
  assert.equal(excessive.candidates[0].reason, 'FRACTION_COUNT_EXCEEDS_LIMIT');
  const boundedFractions = Array.from({ length: MAX_FRACTIONS }, (_, i) => M.div(String(i + 1), String(MAX_FRACTIONS), 5, 'DOWN'));
  const bounded = evaluateSizeLadder(args({ fractions: boundedFractions }));
  assert.equal(bounded.candidates.length, MAX_FRACTIONS);
  assert.equal(sizingCandidateLog(bounded).length, MAX_FRACTIONS, 'every allowed candidate has a durable bounded measurement row');
});

test('freshness fails closed for future-dated books and malformed negative age laws', () => {
  const future = evaluateSizeLadder(args({ snapshot: { ...snapshot(), receiptTs: T0 + 2_000 }, fractions: ['1'] }));
  assert.ok(future.allInMissing.includes('FRESH_BOOK'));
  assert.equal(future.selected, null);
  const negativeLaw = evaluateSizeLadder(args({ prepared: { ...prepared, maxBookAgeMs: -1 }, fractions: ['1'] }));
  assert.ok(negativeLaw.allInMissing.includes('FRESHNESS_LAW'));
  assert.equal(negativeLaw.selected, null);
});

test('the deepest protective-exit proof is explicitly priced at stop stress, not inferred from target-price sensitivities', () => {
  const ladder = evaluateSizeLadder(args({ fractions: ['0.25'] }));
  const row = ladder.candidates[0];
  assert.equal(row.status, 'OK');
  assert.equal(row.protectiveExitAtDepth25pct.scenarioMid, '99300');
  assert.equal(row.protectiveExitAtDepth25pct.haircut, '0.25');
  assert.equal(row.protectiveExitOk, true);
  assert.ok(M.lt(row.protectiveExitAtDepth25pct.cashIn, row.scenarioExitCashIn), 'the stop-stress close is distinct from and below the target exit');
});

test('throwing or malformed injected admission verdicts refuse the candidate instead of crashing the Judge path', () => {
  const thrown = evaluateSizeLadder(args({ fractions: ['0.25', '0.5'], prepared: { ...prepared, admissible: () => { throw new Error('boom'); } } }));
  assert.equal(thrown.selected, null);
  assert.ok(thrown.candidates.every((row) => row.reason === 'ADMISSION_CHECK_FAILED'));
  const malformed = evaluateSizeLadder(args({ fractions: ['0.25'], prepared: { ...prepared, admissible: () => null } }));
  assert.equal(malformed.selected, null);
  assert.equal(malformed.candidates[0].reason, 'ADMISSION_REFUSED');
  assert.deepEqual(malformed.candidates[0].admission, { ok: false, reasons: [] });
});

test('the 10% sustainability boundary is decided from exact cash decimals, not rounded display percentages', () => {
  const fineSpec = spec('0.0001', 4);
  const book = snapshot([['100000', '0.05'], ['100358.9428', '50']], [['99990', '50'], ['99950', '50']]);
  const ladder = evaluateSizeLadder(args({ snapshot: book, spec: fineSpec, fractions: ['0.5', '1'] }));
  const smaller = ladder.candidates.find((row) => row.fraction === '0.5');
  const full = ladder.candidates.find((row) => row.fraction === '1');
  assert.ok(M.gt(full.bufferedScenarioNetProfit, smaller.bufferedScenarioNetProfit), 'larger size has more absolute profit');
  assert.ok(full.netReturnPct >= smaller.netReturnPct * 0.9, 'rounded display values alone would incorrectly admit the full size');
  assert.equal(ladder.selected.fraction, '0.5');
  assert.equal(full.whyNotSelected, 'NET_RETURN_DEGRADATION_BEYOND_TOLERANCE');
});

test('maximum setup, learning, and sizing logs all fit the unchanged 64-measurement decision contract', () => {
  const fast = {
    mid: '101', fi15: { state: 'KNOWN', fi: 0.3 }, fi60: { state: 'KNOWN', fi: 0.2 }, rv60: { state: 'KNOWN', rv60: 2.5 },
    coverage: { continuous: true, startTs: T0 - 60_000 }, decisionTs: T0, bookAgeMs: 0, crcVerified: true,
    depth10bps: '1000', atTrigger: { reclaimFi: { state: 'KNOWN', fi: 0.3 } },
  };
  const common = { atr14: '10', triggerLevel: '100', structuralStop: '90', scenarioRaw: '120', maxEntryLevel: '110' };
  const frozen = {
    RANGE_IGNITION: { ...common, envelope5: '10' },
    TREND_PULLBACK_CONTINUATION: { ...common, ema5: '101', ema20: '99', prior20Return: 0.01, prior20HighBarsFromEnd: 4, prior20High: '110', last3Low: '100' },
    ABSORPTION_RECLAIM: { ...common, maxEntryLevel: null, priorFi: { state: 'KNOWN', fi: -0.2 }, priorMidChange: '1', priorDepthSamples: 30, priorMedianDepth: '1000' },
    CATALYST_TRANSMISSION: { ...common, event: { knownAtTs: T0 - 1_000 } },
  };
  const p0Evidence = { version: 'judge-catalyst-pre-event-snapshot-1', eventId: 'claim-sizing', canonicalCoin: 'BTC', packetId: `sep2-${'1'.repeat(40)}`, marketContextRef: `evd-${'2'.repeat(40)}`, evidenceId: `evd-${'3'.repeat(40)}`, sourceRefs: [`src-${'4'.repeat(40)}`], componentSourceIds: ['mcc-sizing-1'], observedTs: T0 - 2_000, knownAtTs: T0 - 2_000, windowEndTs: T0 - 2_000, cutoffTs: T0 - 1_000, occurrenceClockBasis: 'SOURCE_PUBLISHED_TS', venue: 'kraken', quote: 'USD', price: '100' };
  const event = { eventId: 'claim-sizing', canonicalCoin: 'BTC', knownAtTs: T0 - 1_000, occurredTs: T0 - 1_000, occurrenceClockBasis: 'SOURCE_PUBLISHED_TS', primaryConfirmed: true, occurred: true, mechanismDirection: 'UPWARD_PRESSURE', mechanismCitesEvent: true, p0: '100', p0Source: 'PRE_EVENT_SNAPSHOT', p0Evidence };
  const baselineBySetup = SETUPS.map((setupId) => [
    ...structuralClauses(setupId, frozen[setupId], {}, fast, { decisionTs: T0, event }),
    ...fastClauses(setupId, frozen[setupId], fast),
  ]);
  const baseline = baselineBySetup.reduce((largest, rows) => rows.length > largest.length ? rows : largest, []);
  assert.equal(baseline.length, 13, 'the largest current setup emits 13 baseline clauses');

  const eligible = Array.from({ length: CANDIDATE_LOG_LIMIT }, (_, i) => ({ activationId: `act-${String(i).padStart(2, '0')}`, adjust: 0.01 }));
  const learningResolution = { selectorVersion: 'fixture', applied: true, adjust: 0.01, selected: { ...eligible[0], maxAbsAdjust: 0.05 }, eligible, rejected: [], reason: 'SELECTED_BY_TIE_BREAK_LAW' };
  const fractions = Array.from({ length: MAX_FRACTIONS }, (_, i) => M.div(String(i + 1), String(MAX_FRACTIONS), 5, 'DOWN'));
  const ladder = evaluateSizeLadder(args({ fractions }));
  const combined = [
    ...baseline,
    contributionMeasurement(learningResolution), ...contributionCandidateLog(learningResolution),
    sizingMeasurement(ladder), ...sizingCandidateLog(ladder),
  ];
  assert.equal(contributionCandidateLog(learningResolution).length, 24);
  assert.equal(sizingCandidateLog(ladder).length, 16);
  assert.equal(combined.length, 55);
  assert.ok(combined.length <= 64);
  const persisted = combined.slice(0, 64);
  assert.equal(persisted.filter((row) => row.id === 'LEARNED_CANDIDATE').length, 24);
  assert.equal(persisted.filter((row) => row.id === 'SIZE_CANDIDATE').length, 16, 'no allowed sizing row can be silently truncated');
  assert.equal(persisted.at(-1).id, 'SIZE_CANDIDATE', 'the final candidate survives the actual final-slice ordering');
});
