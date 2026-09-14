// Operational contract for the two EDGE_STATE starting styles. This module is
// deterministic and authority-free: it derives entry evidence from already
// admitted market facts, projects the existing size-specific cost result into
// the post-size gate, and classifies an owned position for The Watch. It never
// predicts a return, changes risk limits, or dispatches an order.
import * as M from '../execution/money.js';
import { bookFacts, bidDepthWithinBps, medianDecimal } from './features.js';
import { liquidationValue, scenarioExit } from './cost.js';
import { SETUP_SELECTION_VERSION } from './setup-selection.js';

export const EDGE_STATE_VERSION = 'judge-edge-state-1';
export const EDGE_MANAGEMENT_VERSION = 'judge-position-edge-state-1';
export const OPERATIONAL_EDGE_STRATEGY_VERSION = 'judge-strategy-starting-styles-edge-2';
export const EDGE_WATCH_VERSION = 'watch-paper-edge-state-2';
export const EDGE_POLICY_VERSION = 'judge-policy-2';
export const EDGE_EXECUTION_GATE_VERSION = 'judge-post-size-execution-gate-1';
export const EDGE_SETUPS = Object.freeze(['MOMENTUM_CONTINUATION', 'MICRO_BITE']);
export const EDGE_STATES = Object.freeze([
  'EDGE_REACCELERATING',
  'BREAKOUT_PRESSURE_BUILDING',
  'EDGE_STABLE',
  'EDGE_DECAYING',
  'DISTRIBUTION_EXHAUSTION',
  'UNKNOWN',
]);
export const EDGE_REFERENCE = Object.freeze({
  bookFreshMs: 1_000,
  entryEvidenceFreshMs: 60_000,
  liveWarmupMs: 15_000,
  priceLookbackMs: 15_000,
  baselineLookbackMs: 60_000,
  flowWindowMs: 15_000,
  minBookSamples: 3,
  minBookSpanMs: 2_000,
  depthDecayFraction: '0.5',
  depthHealthyFraction: '0.8',
  volumeDecayFraction: '0.5',
  volumeReaccelerationFraction: '1.25',
  priceDecayAtrFraction: '0.1',
  spreadAtrFraction: '0.1',
});

const ownKeysExact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const isTs = (value) => Number.isSafeInteger(value) && value >= 0;
const safePositive = (value) => { try { return value !== null && value !== undefined && M.isPositive(value); } catch { return false; } };
const safeNonNegative = (value) => { try { return value !== null && value !== undefined && M.gte(value, '0'); } catch { return false; } };
const knownMetric = (value, key) => value?.state === 'KNOWN' && Number.isFinite(value[key]);
const decimalNumber = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; };
const maxDecimal = (left, right) => M.gt(left, right) ? left : right;
const ratioBps = (numerator, denominator) => {
  try { return safePositive(denominator) ? Number(M.mul(M.div(numerator, denominator, 10, 'DOWN'), '10000')) : null; }
  catch { return null; }
};

export function edgeStatePortError(port) {
  if (!ownKeysExact(port, ['version'])) return 'EDGE_STATE_PORT_SHAPE_INVALID';
  return port.version === EDGE_STATE_VERSION ? null : 'EDGE_STATE_PORT_VERSION_INVALID';
}

export const isEdgeSetup = (setupId) => EDGE_SETUPS.includes(setupId);

// This exact object is written into POSITION_OPENED. The Watch restores edge
// semantics from these entry-time bytes, never from the current policy or from
// a setup name alone. maxDurationMs remains the independently configured hard
// operator ceiling; EDGE_STATE does not turn the 60-300 s Micro intent into a
// mandatory timer.
export function edgePositionManagement({ setupId, hardMaxDurationMs, selectionVersion } = {}) {
  if (!isEdgeSetup(setupId)) throw new Error('EDGE_MANAGEMENT_SETUP_INVALID');
  if (!Number.isSafeInteger(hardMaxDurationMs) || hardMaxDurationMs <= 0) throw new Error('EDGE_MANAGEMENT_HARD_MAX_INVALID');
  if (selectionVersion !== SETUP_SELECTION_VERSION) throw new Error('EDGE_MANAGEMENT_SELECTION_VERSION_INVALID');
  return Object.freeze({
    managementVersion: EDGE_MANAGEMENT_VERSION,
    policyVersion: EDGE_POLICY_VERSION,
    strategyVersion: OPERATIONAL_EDGE_STRATEGY_VERSION,
    setupId,
    edgeStateVersion: EDGE_STATE_VERSION,
    executionGateVersion: EDGE_EXECUTION_GATE_VERSION,
    watchVersion: EDGE_WATCH_VERSION,
    selectionVersion,
    horizonKind: 'EDGE_STATE',
    hardMaxDurationMs,
  });
}

export function edgePositionManagementError(value) {
  const keys = ['managementVersion', 'policyVersion', 'strategyVersion', 'setupId', 'edgeStateVersion', 'executionGateVersion', 'watchVersion', 'selectionVersion', 'horizonKind', 'hardMaxDurationMs'];
  if (!ownKeysExact(value, keys)) return 'EDGE_MANAGEMENT_SHAPE_INVALID';
  if (value.managementVersion !== EDGE_MANAGEMENT_VERSION) return 'EDGE_MANAGEMENT_VERSION_INVALID';
  if (value.policyVersion !== EDGE_POLICY_VERSION) return 'EDGE_MANAGEMENT_POLICY_VERSION_INVALID';
  if (value.strategyVersion !== OPERATIONAL_EDGE_STRATEGY_VERSION) return 'EDGE_MANAGEMENT_STRATEGY_VERSION_INVALID';
  if (!isEdgeSetup(value.setupId)) return 'EDGE_MANAGEMENT_SETUP_INVALID';
  if (value.edgeStateVersion !== EDGE_STATE_VERSION) return 'EDGE_MANAGEMENT_EDGE_VERSION_INVALID';
  if (value.executionGateVersion !== EDGE_EXECUTION_GATE_VERSION) return 'EDGE_MANAGEMENT_EXECUTION_GATE_VERSION_INVALID';
  if (value.watchVersion !== EDGE_WATCH_VERSION) return 'EDGE_MANAGEMENT_WATCH_VERSION_INVALID';
  if (value.selectionVersion !== SETUP_SELECTION_VERSION) return 'EDGE_MANAGEMENT_SELECTION_VERSION_INVALID';
  if (value.horizonKind !== 'EDGE_STATE') return 'EDGE_MANAGEMENT_HORIZON_INVALID';
  if (!Number.isSafeInteger(value.hardMaxDurationMs) || value.hardMaxDurationMs <= 0) return 'EDGE_MANAGEMENT_HARD_MAX_INVALID';
  return null;
}

const unknownEntryFacts = (reason) => Object.freeze({
  continuationEvidence: Object.freeze({ state: 'UNKNOWN', knownAtTs: null, phase: null, dimensions: null, relianceGroups: null, challengeState: null, reason }),
  exhaustion: Object.freeze({ state: 'UNKNOWN', knownAtTs: null, exhausted: null, reason }),
});

// Entry evidence uses only the already prepared as-of-D facts. Dimensions are
// named observations/calculations, not independent trials and not confidence.
export function deriveOperationalEntryFacts({ setupId, decisionTs, frozen, fast, books = [], catalyst = null } = {}) {
  if (!isEdgeSetup(setupId)) return Object.freeze({ continuationEvidence: null, exhaustion: null });
  const fi15 = knownMetric(fast?.fi15, 'fi') ? fast.fi15.fi : null;
  const fi60 = knownMetric(fast?.fi60, 'fi') ? fast.fi60.fi : null;
  const rv60 = knownMetric(fast?.rv60, 'rv60') ? fast.rv60.rv60 : null;
  if (!isTs(decisionTs) || !frozen || !fast || !Array.isArray(books)
      || !safePositive(fast.mid) || !safePositive(fast.bestBid) || !safePositive(fast.bestAsk)
      || !safePositive(frozen.atr14) || !safePositive(frozen.tick) || !safePositive(frozen.triggerLevel)
      || !Number.isFinite(fi15) || !Number.isFinite(fi60) || !Number.isFinite(rv60)
      || !safePositive(fast.depth10bps) || !Number.isFinite(fast.bookAgeMs)
      || fast.bookAgeMs < 0 || fast.bookAgeMs > EDGE_REFERENCE.bookFreshMs || fast.crcVerified !== true) {
    return unknownEntryFacts('ENTRY_FACTS_MISSING_OR_STALE');
  }
  let spread;
  try { spread = M.sub(fast.bestAsk, fast.bestBid); } catch { return unknownEntryFacts('ENTRY_BOOK_INVALID'); }
  const spreadLimit = maxDecimal(M.mul(EDGE_REFERENCE.spreadAtrFraction, frozen.atr14), M.mul('2', frozen.tick));
  const spreadHealthy = safeNonNegative(spread) && M.lte(spread, spreadLimit);
  const rows = books.filter((row) => isTs(row?.ts) && row.ts <= decisionTs && row.ts >= decisionTs - 30_000 && safePositive(row.mid));
  const prior = [...rows].reverse().find((row) => row.ts <= decisionTs - 2_000) ?? null;
  const priceAdvancing = prior ? M.gt(fast.mid, prior.mid) : M.gte(fast.mid, frozen.triggerLevel);
  const dimensions = [];
  const groups = [];
  const add = (dimension, group, ok) => { if (ok) { dimensions.push(dimension); groups.push(group); } };
  add('PRICE_ACCELERATION', 'PRICE_BOOK', priceAdvancing && M.gte(fast.mid, frozen.triggerLevel));
  add('EXECUTED_VOLUME', 'TRADES_VOLUME', rv60 >= (setupId === 'MICRO_BITE' ? 1.5 : 1.5));
  add('ORDER_FLOW', 'TRADES_DIRECTION', fi15 >= 0.2 && fi60 > 0);
  add('LIQUIDITY_DEPTH', 'ORDER_BOOK_DEPTH', safePositive(fast.depth10bps));
  add('SPREAD', 'ORDER_BOOK_SPREAD', spreadHealthy);
  add('VOLATILITY', 'CLOSED_BARS', priceAdvancing && safePositive(frozen.atr14));
  add('CATALYST_PROPAGATION', 'VERIFIED_CASE', catalyst?.primaryConfirmed === true && catalyst?.mechanismDirection === 'UPWARD_PRESSURE');
  let phase = setupId === 'MICRO_BITE' ? 'ACCELERATING' : 'HEALTHY_CONTINUATION';
  if (priceAdvancing && fi15 >= 0.3 && fi15 > fi60 && rv60 >= 2) phase = 'EDGE_REACCELERATING';
  else if (priceAdvancing && fi15 >= 0.2 && rv60 >= 1.5) phase = 'BREAKOUT_PRESSURE_BUILDING';
  const challengeState = setupId === 'MOMENTUM_CONTINUATION'
    ? (rows.some((row) => M.lt(row.mid, frozen.triggerLevel)) && M.gte(fast.mid, frozen.triggerLevel) ? 'SURVIVED' : 'NOT_OBSERVED')
    : null;
  const exhausted = fi15 <= 0 || fi60 <= 0 || !spreadHealthy;
  return Object.freeze({
    continuationEvidence: Object.freeze({
      state: 'KNOWN', knownAtTs: decisionTs, phase,
      dimensions: Object.freeze(dimensions), relianceGroups: Object.freeze([...new Set(groups)]),
      challengeState, reason: null,
    }),
    exhaustion: Object.freeze({ state: 'KNOWN', knownAtTs: decisionTs, exhausted, reason: exhausted ? 'CURRENT_PRESSURE_OR_SPREAD_DOES_NOT_SUPPORT_CONTINUATION' : null }),
  });
}

// Converts the existing exact-decimal, intended-size cost result into the
// already-defined post-size gate contract. The target is explicitly a frozen
// unvalidated scenario, never a forecast or promised return.
export function executableEdgeFromEvaluation({ setupId, evaluation, decisionTs } = {}) {
  if (!isEdgeSetup(setupId) || !isTs(decisionTs) || evaluation?.status !== 'OK') return null;
  const exit = evaluation.scenarioExitDetail;
  if (!exit || !safePositive(evaluation.entryBookEstimate?.avgPrice) || !safePositive(exit.avgPrice)
      || !safeNonNegative(evaluation.entryBookEstimate?.fee) || !safeNonNegative(exit.fees)
      || !safeNonNegative(evaluation.attribution?.spread) || !safeNonNegative(evaluation.attribution?.slippage)
      || !safeNonNegative(exit.slippage)) return null;
  const afterCosts = ratioBps(evaluation.scenarioNetProfit, evaluation.entryCashOut);
  const afterRisk = ratioBps(evaluation.bufferedScenarioNetProfit, evaluation.entryCashOut);
  if (!Number.isFinite(afterCosts) || !Number.isFinite(afterRisk)) return null;
  return Object.freeze({
    state: 'KNOWN', knownAtTs: decisionTs,
    basis: 'UNVALIDATED_SCENARIO_NOT_FORECAST',
    averageEntryPrice: evaluation.entryBookEstimate.avgPrice,
    averageExitPrice: exit.avgPrice,
    roundTripFeesQuote: M.add(evaluation.entryBookEstimate.fee, exit.fees),
    spreadCostQuote: evaluation.attribution.spread,
    slippageCostQuote: M.add(evaluation.attribution.slippage, exit.slippage),
    entryDepthSufficient: true,
    exitDepthSufficient: true,
    estimatedRemainingEdgeAfterCostsBps: afterCosts,
    estimatedRemainingEdgeAfterCostsAndRiskBps: afterRisk,
  });
}

const unknownState = ({ nowTs, reason, warmup = false, facts = {} }) => Object.freeze({
  version: EDGE_STATE_VERSION, state: 'UNKNOWN', knownAtTs: nowTs, reason, warmup,
  shouldExit: !warmup, exitReason: warmup ? null : 'EDGE_STATE_UNKNOWN',
  facts: Object.freeze(facts),
});

// The Watch owns action priority; this function only classifies. It uses the
// current executable bid side (including fees), actual recent trades, book
// depth/spread, and the frozen scenario. Missing/stale evidence is UNKNOWN,
// never EDGE_STABLE. A newly filled position gets a bounded observation warmup
// while its native protection remains authoritative; restored positions do not
// receive invented historical evidence.
export function evaluatePositionEdgeState({ position, tracker, nowTs, bookAgeMs, spec, fee } = {}) {
  const managementError = edgePositionManagementError(position?.management);
  if (managementError) return Object.freeze({ version: EDGE_STATE_VERSION, state: 'NOT_APPLICABLE', knownAtTs: nowTs, reason: managementError, warmup: false, shouldExit: false, exitReason: null, facts: Object.freeze({}) });
  // POSITION_OPENED is deliberately committed before any venue send. The
  // resulting shell is risk-visible, but it is not yet an owned position whose
  // thesis can decay. Edge-state evidence must never cancel an unfilled entry
  // merely because Watch has not observed post-fill flow yet.
  let owned = null;
  try { owned = M.sub(M.sub(position.confirmedBase ?? '0', position.soldBase ?? '0'), position.baseFees ?? '0'); } catch { owned = null; }
  if (!isTs(position?.firstFillTs) || !safePositive(owned)) {
    return Object.freeze({ version: EDGE_STATE_VERSION, state: 'UNKNOWN', knownAtTs: nowTs, reason: 'ENTRY_NOT_FILLED', warmup: true, shouldExit: false, exitReason: null, facts: Object.freeze({ ownedBase: owned }) });
  }
  const elapsedMs = isTs(position?.firstFillTs) && isTs(nowTs) ? Math.max(0, nowTs - position.firstFillTs) : null;
  const warmup = tracker?.edgeRestarted !== true && elapsedMs !== null && elapsedMs < EDGE_REFERENCE.liveWarmupMs;
  if (!isTs(nowTs) || !tracker?.lastBook || !Number.isFinite(bookAgeMs) || bookAgeMs < 0 || bookAgeMs > EDGE_REFERENCE.bookFreshMs) {
    return unknownState({ nowTs, reason: 'BOOK_MISSING_OR_STALE', warmup, facts: { bookAgeMs: Number.isFinite(bookAgeMs) ? bookAgeMs : null } });
  }
  const f = bookFacts(tracker.lastBook);
  if (!f || !spec || !fee || !safePositive(position.atr14) || !safePositive(spec.priceIncrement)) return unknownState({ nowTs, reason: 'VALUATION_INPUT_MISSING', warmup });
  const rows = (tracker.edgeBooks ?? []).filter((row) => isTs(row?.ts) && row.ts <= nowTs && row.ts >= nowTs - EDGE_REFERENCE.baselineLookbackMs && safePositive(row.mid) && safeNonNegative(row.spread) && safeNonNegative(row.depth));
  const currentRows = rows.filter((row) => row.ts >= nowTs - EDGE_REFERENCE.flowWindowMs);
  const baseRows = rows.filter((row) => row.ts < nowTs - EDGE_REFERENCE.flowWindowMs);
  const span = rows.length ? rows.at(-1).ts - rows[0].ts : 0;
  if (rows.length < EDGE_REFERENCE.minBookSamples || span < EDGE_REFERENCE.minBookSpanMs || !currentRows.length) return unknownState({ nowTs, reason: 'BOOK_OBSERVATION_SUPPORT_INCOMPLETE', warmup, facts: { bookSamples: rows.length, bookSpanMs: span } });
  const fi15 = tracker.flow.fi(nowTs - 15_000, nowTs, { asOfTs: nowTs });
  const fi60 = tracker.flow.fi(nowTs - 60_000, nowTs, { asOfTs: nowTs });
  const recentVolume = tracker.flow.notional(nowTs - 15_000, nowTs, { asOfTs: nowTs });
  const priorVolume = tracker.flow.notional(nowTs - 30_000, nowTs - 15_000, { asOfTs: nowTs });
  if (fi15.state !== 'KNOWN' || fi60.state !== 'KNOWN' || !safeNonNegative(recentVolume.notional) || !safeNonNegative(priorVolume.notional)) {
    return unknownState({ nowTs, reason: 'FLOW_SUPPORT_INCOMPLETE', warmup, facts: { fi15: fi15.fi ?? null, fi60: fi60.fi ?? null } });
  }
  const priorPrice = [...rows].reverse().find((row) => row.ts <= nowTs - Math.min(5_000, EDGE_REFERENCE.priceLookbackMs))?.mid ?? rows[0].mid;
  const baseDepth = medianDecimal((baseRows.length ? baseRows : rows.slice(0, Math.max(1, rows.length - 1))).map((row) => row.depth).filter(safePositive));
  const currentDepth = currentRows.at(-1).depth;
  const spreadLimit = maxDecimal(M.mul(EDGE_REFERENCE.spreadAtrFraction, position.atr14), M.mul('2', spec.priceIncrement));
  const priceDelta = M.sub(f.mid, priorPrice);
  const priceDecay = M.lt(priceDelta, M.neg(M.mul(EDGE_REFERENCE.priceDecayAtrFraction, position.atr14)));
  const priceAdvancing = M.gt(priceDelta, '0');
  const depthDecaying = !safePositive(baseDepth) || M.lt(currentDepth, M.mul(EDGE_REFERENCE.depthDecayFraction, baseDepth));
  const depthHealthy = safePositive(baseDepth) && M.gte(currentDepth, M.mul(EDGE_REFERENCE.depthHealthyFraction, baseDepth));
  const spreadWidened = M.gt(f.spread, spreadLimit);
  const volumeDecaying = safePositive(priorVolume.notional) && M.lt(recentVolume.notional, M.mul(EDGE_REFERENCE.volumeDecayFraction, priorVolume.notional));
  const volumeReaccelerating = safePositive(priorVolume.notional) && M.gte(recentVolume.notional, M.mul(EDGE_REFERENCE.volumeReaccelerationFraction, priorVolume.notional));
  const flowNegative = fi15.fi <= -0.05;
  const flowFading = fi15.fi + 0.1 < fi60.fi;
  const liquidation = liquidationValue({ snapshot: tracker.lastBook, q: owned, spec, fee });
  const target = safePositive(position.targetPrice) ? scenarioExit({ snapshot: tracker.lastBook, q: owned, scenarioMid: position.targetPrice, spec, fee }) : { status: 'REFUSED', reason: 'NO_TARGET' };
  if (liquidation.status !== 'OK' || target.status !== 'OK') return unknownState({ nowTs, reason: 'EXECUTABLE_EXIT_OR_SCENARIO_UNKNOWN', warmup, facts: { liquidation: liquidation.status, target: target.status } });
  const remainingScenarioEdgeBps = ratioBps(M.sub(target.cashIn, liquidation.cashIn), liquidation.cashIn);
  if (!Number.isFinite(remainingScenarioEdgeBps)) return unknownState({ nowTs, reason: 'REMAINING_EDGE_UNKNOWN', warmup });
  const remainingThin = remainingScenarioEdgeBps <= 0;
  const bad = [priceDecay, depthDecaying, spreadWidened, volumeDecaying, flowNegative, flowFading, remainingThin].filter(Boolean).length;
  const nearHigh = safePositive(tracker.highestBid) && M.gte(f.bestBid, M.sub(tracker.highestBid, M.mul(EDGE_REFERENCE.priceDecayAtrFraction, position.atr14)));
  let state;
  if (nearHigh && bad >= 3 && (flowFading || volumeDecaying || flowNegative)) state = 'DISTRIBUTION_EXHAUSTION';
  else if (bad >= 2 || remainingThin) state = 'EDGE_DECAYING';
  else if (priceAdvancing && fi15.fi >= 0.2 && fi15.fi >= fi60.fi && volumeReaccelerating && depthHealthy && !spreadWidened) state = 'EDGE_REACCELERATING';
  else if (priceAdvancing && fi15.fi > 0 && !volumeDecaying && !depthDecaying && !spreadWidened) state = 'BREAKOUT_PRESSURE_BUILDING';
  else if (fi60.fi > 0 && !priceDecay && !depthDecaying && !spreadWidened) state = 'EDGE_STABLE';
  else state = 'EDGE_DECAYING';
  const shouldExit = state === 'EDGE_DECAYING' || state === 'DISTRIBUTION_EXHAUSTION';
  return Object.freeze({
    version: EDGE_STATE_VERSION, state, knownAtTs: nowTs, reason: null, warmup: false, shouldExit,
    exitReason: state === 'DISTRIBUTION_EXHAUSTION' ? 'DISTRIBUTION_EXHAUSTION' : shouldExit ? 'EDGE_DECAY' : null,
    facts: Object.freeze({
      fi15: fi15.fi, fi60: fi60.fi, recentVolume: recentVolume.notional, priorVolume: priorVolume.notional,
      currentDepth, baselineDepth: baseDepth, spread: f.spread, spreadLimit, priceDelta,
      liquidationCashIn: liquidation.cashIn, targetScenarioCashIn: target.cashIn,
      remainingScenarioEdgeAfterCostsBps: remainingScenarioEdgeBps,
      scenarioBasis: 'FROZEN_SCENARIO_NOT_FORECAST', bookSamples: rows.length, bookSpanMs: span,
    }),
  });
}
