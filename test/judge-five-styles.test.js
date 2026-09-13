import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SETUPS, SETUP_DEFINITIONS, SETUP_EVALUATORS, STARTING_STYLE_FAMILIES,
  evaluateSetup, evaluateStyleExecutionGate, freezeReferences,
} from '../judge/setups.js';

const T = Date.UTC(2026, 8, 13, 18, 0, 0);
const SPEC = { priceIncrement: '0.1' };
const IND = Object.freeze({
  blockDigest: 'a'.repeat(64), referenceTs: T, atr14: 1, h20: 110, l20: 100,
  low5: 106, last2High: 109, ema5: 107, ema20: 105, lastClose: 108,
  prior20Return: 0.05, envelope5: 1,
});
const fast = (over = {}) => ({
  mid: '110.2', fi15: { state: 'KNOWN', fi: 0.35 }, fi60: { state: 'KNOWN', fi: 0.2 },
  rv60: { state: 'KNOWN', rv60: 2 }, coverage: { continuous: true, startTs: T - 120_000, endTs: T },
  decisionTs: T, bookAgeMs: 100, crcVerified: true, depth10bps: '10000',
  continuationEvidence: { state: 'KNOWN', knownAtTs: T - 100, phase: 'ACCELERATING', dimensions: ['PRICE_ACCELERATION', 'EXECUTED_VOLUME', 'ORDER_FLOW', 'LIQUIDITY_DEPTH'], relianceGroups: ['PRICE_BARS', 'TRADES', 'ORDER_BOOK'], challengeState: 'NOT_OBSERVED' },
  exhaustion: { state: 'KNOWN', knownAtTs: T - 100, exhausted: false },
  ...over,
});
const evaluate = (setupId, over = {}) => {
  const facts = fast(over); const frozen = freezeReferences({ setupId, ind: IND, spec: SPEC, fast: facts, triggerTs: T });
  return evaluateSetup({ setupId, frozen, ind: IND, fast: facts, bars: [], entry: facts.mid, decisionTs: T });
};
const executable = (over = {}) => ({
  state: 'KNOWN', knownAtTs: T - 100, averageEntryPrice: '110.25', averageExitPrice: '110.8',
  roundTripFeesQuote: '0.2', spreadCostQuote: '0.05', slippageCostQuote: '0.1',
  entryDepthSufficient: true, exitDepthSufficient: true,
  estimatedRemainingEdgeAfterCostsBps: 25, estimatedRemainingEdgeAfterCostsAndRiskBps: 10,
  ...over,
});

test('five starting families map to six evaluators without deleting Absorption or silently activating new Judge setups', () => {
  assert.deepEqual(STARTING_STYLE_FAMILIES, ['MOMENTUM_CONTINUATION', 'EARLY_IGNITION_BREAKOUT', 'PULLBACK_REENTRY', 'RUMOR_CATALYST', 'MICRO_BITE']);
  assert.deepEqual(SETUP_EVALUATORS, ['MOMENTUM_CONTINUATION', 'RANGE_IGNITION', 'TREND_PULLBACK_CONTINUATION', 'ABSORPTION_RECLAIM', 'CATALYST_TRANSMISSION', 'MICRO_BITE']);
  assert.equal(SETUP_DEFINITIONS.TREND_PULLBACK_CONTINUATION.familyId, 'PULLBACK_REENTRY');
  assert.equal(SETUP_DEFINITIONS.ABSORPTION_RECLAIM.familyId, 'PULLBACK_REENTRY');
  assert.ok(SETUPS.includes('ABSORPTION_RECLAIM'));
  assert.equal(SETUPS.includes('MOMENTUM_CONTINUATION'), false);
  assert.equal(SETUPS.includes('MICRO_BITE'), false);
  const policy = JSON.parse(readFileSync(new URL('../config/judge.paper.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy.setups.enabled, SETUPS, 'policy/version compatibility stays exact; another layer must explicitly activate candidates');
});

test('Momentum and Micro-Bite are market-evidence hypotheses with no rigid percent/ATR extension cutoff and explicit non-timer horizons', () => {
  const momentum = evaluate('MOMENTUM_CONTINUATION');
  assert.equal(momentum.state, 'ELIGIBLE', momentum.refused.join(','));
  assert.equal(momentum.setupFamily, 'MOMENTUM_CONTINUATION');
  assert.equal(momentum.maxEntryLevel, null); assert.equal(momentum.maxDurationMs, null);
  assert.equal(momentum.horizon.mandatoryTimer, false);
  assert.equal(momentum.clauses.some((x) => x.id === 'EXTENSION_CAP'), false);
  assert.equal(momentum.clauses.find((x) => x.id === 'CHALLENGE_NOT_FAILED').value, 'NOT_OBSERVED', 'a pullback/challenge is preferred, not mandatory');
  assert.equal(momentum.executionGate.state, 'REQUIRED_DOWNSTREAM');
  assert.equal('netEdgeAfterCostsBps' in momentum.strengthFacts, false, 'setup strength remains market-only; cost is size-specific later');

  const micro = evaluate('MICRO_BITE');
  assert.equal(micro.state, 'ELIGIBLE', micro.refused.join(','));
  assert.equal(micro.horizon.intendedMinMs, 60_000); assert.equal(micro.horizon.intendedMaxMs, 300_000);
  assert.equal(micro.horizon.mandatoryTimer, false); assert.equal(micro.horizon.thesisTransition, 'NEW_INDEPENDENT_THESIS_REQUIRED');
  assert.equal(micro.maxDurationMs, null); assert.equal(micro.maxEntryLevel, null);
});

test('new setup evidence fails closed when metrics/liquidity/exhaustion are missing or stale, while known decay/exhaustion refuses', () => {
  for (const [name, over, reason] of [
    ['volume', { rv60: { state: 'UNKNOWN', rv60: null, reason: 'COVERAGE_INCOMPLETE' } }, 'RV60'],
    ['continuation', { continuationEvidence: null }, 'CONTINUATION_PHASE_ELIGIBLE'],
    ['liquidity', { depth10bps: null }, 'LIQUIDITY_PRESENT'],
    ['exhaustion', { exhaustion: null }, 'NOT_EXHAUSTED'],
    ['stale continuation', { continuationEvidence: { ...fast().continuationEvidence, knownAtTs: T - 60_001 } }, 'CONTINUATION_PHASE_ELIGIBLE'],
  ]) {
    const r = evaluate('MOMENTUM_CONTINUATION', over); assert.equal(r.state, 'NEEDS_DATA', name); assert.ok(r.needsData.includes(reason), name);
  }
  const exhausted = evaluate('MOMENTUM_CONTINUATION', { exhaustion: { state: 'KNOWN', knownAtTs: T, exhausted: true } });
  assert.equal(exhausted.state, 'REFUSED'); assert.ok(exhausted.refused.includes('NOT_EXHAUSTED'));
  const decaying = evaluate('MOMENTUM_CONTINUATION', { continuationEvidence: { ...fast().continuationEvidence, phase: 'DECAYING' } });
  assert.equal(decaying.state, 'REFUSED'); assert.ok(decaying.refused.includes('CONTINUATION_PHASE_ELIGIBLE'));
  const singleSource = evaluate('MICRO_BITE', { continuationEvidence: { ...fast().continuationEvidence, dimensions: ['PRICE_ACCELERATION', 'EXECUTED_VOLUME', 'ORDER_FLOW'], relianceGroups: ['ONE_PIPELINE'] } });
  assert.equal(singleSource.state, 'REFUSED'); assert.ok(singleSource.refused.includes('DISTINCT_EVIDENCE_DIMENSIONS'));
});

test('the separate post-size gate requires current two-way average-fill/depth and complete round-trip cost/risk evidence', () => {
  const missing = evaluateStyleExecutionGate({ setupId: 'MICRO_BITE', executableEdge: null, decisionTs: T });
  assert.equal(missing.state, 'NEEDS_DATA'); assert.equal(missing.needsData.length, 4);
  const stale = evaluateStyleExecutionGate({ setupId: 'MICRO_BITE', executableEdge: executable({ knownAtTs: T - 1_001 }), decisionTs: T });
  assert.equal(stale.state, 'NEEDS_DATA');
  const noExitDepth = evaluateStyleExecutionGate({ setupId: 'MICRO_BITE', executableEdge: executable({ exitDepthSufficient: false }), decisionTs: T });
  assert.equal(noExitDepth.state, 'REFUSED'); assert.ok(noExitDepth.refused.includes('EXECUTABLE_BOTH_DIRECTIONS'));
  const costsWin = evaluateStyleExecutionGate({ setupId: 'MOMENTUM_CONTINUATION', executableEdge: executable({ estimatedRemainingEdgeAfterCostsAndRiskBps: -0.1 }), decisionTs: T });
  assert.equal(costsWin.state, 'REFUSED'); assert.ok(costsWin.refused.includes('ESTIMATED_REMAINING_EDGE_AFTER_COSTS_AND_RISK_POSITIVE'));
  const valid = evaluateStyleExecutionGate({ setupId: 'MICRO_BITE', executableEdge: executable(), decisionTs: T });
  assert.equal(valid.state, 'ELIGIBLE', valid.refused.join(','));
});
