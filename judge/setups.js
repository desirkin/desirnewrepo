// JUDGE — the four PAPER_REFERENCE setup evaluators (ticket §5.1): deterministic, versioned rules over facts. Each returns
// features, satisfied / refused clauses (typed, with units and support), the structural invalidation, the target
// SCENARIO, the maximum entry level and the maximum duration. References are FROZEN at the first eligible crossing time T
// (bars, levels, geometry, event anchor, hypothesis id); D is the final admission time where only fast flow / cost /
// extension are recomputed. The confirmation law: the crossing persists for 3 distinct accepted book observations
// spanning >= 2s with EVERY intervening accepted mid at or above the full trigger level; a breach resets; 10s without a
// completed confirmation / decision expires the proposal; re-entry needs a documented reset and a new crossing; same-asset
// cooldown 60s after a close. These values are hypotheses, not calibrated thresholds; nothing here is a win probability.
import * as M from '../execution/money.js';
import { digestOf } from '../execution/contract.js';
import { EDGE_EXECUTION_GATE_VERSION } from './edge-state.js';
// setup geometry buffer: max(1 tick, 0.10 * ATR14) (the cost model's execution buffer is max(2 tick, 0.10 ATR) and lives in cost.js)
const setupBuffer = (atr, tick) => (M.gt(tick, M.mul('0.1', atr)) ? tick : M.mul('0.1', atr));
import { nearestResistanceAbove } from './features.js';

export const STRATEGY_VERSION = 'judge-strategy-paper-reference-1';
export const STARTING_STYLE_CATALOG_VERSION = 'judge-starting-styles-1';
// This is a starting playbook, not an exhaustive strategy enum. Newly learned
// candidates remain untrusted/versioned hypotheses until prospective evidence
// promotes them through the separate experiment path.
export const SETUP_DEFINITIONS = Object.freeze({
  MOMENTUM_CONTINUATION: Object.freeze({ familyId: 'MOMENTUM_CONTINUATION', label: 'Momentum / Continuation', horizon: Object.freeze({ kind: 'EDGE_STATE', intendedMinMs: null, intendedMaxMs: null, mandatoryTimer: false, exitBasis: 'THESIS_DECAY_EXHAUSTION_OR_REMAINING_EDGE' }), operationalMaxDurationMs: null, rv60Min: 1.5, startingPlaybook: true }),
  RANGE_IGNITION: Object.freeze({ familyId: 'EARLY_IGNITION_BREAKOUT', label: 'Early Ignition / Breakout', horizon: Object.freeze({ kind: 'REFERENCE_MAX', intendedMinMs: null, intendedMaxMs: 14_400_000, mandatoryTimer: true, exitBasis: 'EXISTING_REFERENCE' }), operationalMaxDurationMs: 14_400_000, rv60Min: 2, startingPlaybook: true }),
  TREND_PULLBACK_CONTINUATION: Object.freeze({ familyId: 'PULLBACK_REENTRY', label: 'Pullback / Re-entry', horizon: Object.freeze({ kind: 'REFERENCE_MAX', intendedMinMs: null, intendedMaxMs: 14_400_000, mandatoryTimer: true, exitBasis: 'EXISTING_REFERENCE' }), operationalMaxDurationMs: 14_400_000, rv60Min: 1.5, startingPlaybook: true }),
  ABSORPTION_RECLAIM: Object.freeze({ familyId: 'PULLBACK_REENTRY', label: 'Pullback / Re-entry — Absorption Reclaim', horizon: Object.freeze({ kind: 'REFERENCE_MAX', intendedMinMs: null, intendedMaxMs: 14_400_000, mandatoryTimer: true, exitBasis: 'EXISTING_REFERENCE' }), operationalMaxDurationMs: 14_400_000, rv60Min: null, startingPlaybook: true }),
  CATALYST_TRANSMISSION: Object.freeze({ familyId: 'RUMOR_CATALYST', label: 'Rumor / Catalyst', horizon: Object.freeze({ kind: 'REFERENCE_MAX', intendedMinMs: null, intendedMaxMs: 14_400_000, mandatoryTimer: true, exitBasis: 'EXISTING_REFERENCE' }), operationalMaxDurationMs: 14_400_000, rv60Min: 1.5, startingPlaybook: true }),
  MICRO_BITE: Object.freeze({ familyId: 'MICRO_BITE', label: 'Micro-Bite', horizon: Object.freeze({ kind: 'EDGE_STATE', intendedMinMs: 60_000, intendedMaxMs: 300_000, mandatoryTimer: false, exitBasis: 'THESIS_DECAY_EXHAUSTION_OR_REMAINING_EDGE', thesisTransition: 'NEW_INDEPENDENT_THESIS_REQUIRED' }), operationalMaxDurationMs: null, rv60Min: 1.5, startingPlaybook: true }),
});
export const STARTING_STYLE_FAMILIES = Object.freeze([...new Set(Object.values(SETUP_DEFINITIONS).map((x) => x.familyId))]);
export const SETUP_EVALUATORS = Object.freeze(Object.keys(SETUP_DEFINITIONS));
export const setupDefinition = (setupId) => SETUP_DEFINITIONS[setupId] ?? null;
// Compatibility: these are the four evaluators currently composed by Judge.
// The two additions are deliberately not activated by this setup-layer patch.
export const SETUPS = Object.freeze(['RANGE_IGNITION', 'ABSORPTION_RECLAIM', 'TREND_PULLBACK_CONTINUATION', 'CATALYST_TRANSMISSION']);
export const SETUP_INPUT_MODES = Object.freeze({ MOMENTUM_CONTINUATION: ['MARKET_DIRECT', 'CASE_ENRICHED'], RANGE_IGNITION: ['MARKET_DIRECT', 'CASE_ENRICHED'], ABSORPTION_RECLAIM: ['MARKET_DIRECT', 'CASE_ENRICHED'], TREND_PULLBACK_CONTINUATION: ['MARKET_DIRECT', 'CASE_ENRICHED'], CATALYST_TRANSMISSION: ['CATALYST_CASE'], MICRO_BITE: ['MARKET_DIRECT', 'CASE_ENRICHED'] });
export const REFERENCE = Object.freeze({ persistenceBooks: 3, persistenceSpanMs: 2000, proposalExpiryMs: 10_000, cooldownMs: 60_000, maxDurationMs: 4 * 3_600_000, fi15Min: 0.2, rv60Ignition: 2.0, rv60Trend: 1.5, rv60Catalyst: 1.5, catalystKnownWithinMs: 600_000, caseMaxAgeMs: 300_000 });
const d = (x, scale = 8) => (typeof x === 'string' ? x : M.fromStatistic(x, scale));
const clause = (id, ok, value, threshold, unit, note = null) => ({ id, ok, value, threshold, unit, note });
const known = (x) => x && x.state === 'KNOWN';
const safePositive = (x) => { try { return x !== null && x !== undefined && M.isPositive(x); } catch { return false; } };
const safeNonNegative = (x) => { try { return x !== null && x !== undefined && M.gte(x, '0'); } catch { return false; } };
const freshFact = (x, decisionTs, maxAgeMs) => known(x) && Number.isSafeInteger(x.knownAtTs) && Number.isSafeInteger(decisionTs) && x.knownAtTs <= decisionTs && decisionTs - x.knownAtTs <= maxAgeMs;
const CONTINUATION_DIMENSIONS = Object.freeze(['PRICE_ACCELERATION', 'EXECUTED_VOLUME', 'ORDER_FLOW', 'LIQUIDITY_DEPTH', 'SPREAD', 'VOLATILITY', 'CATALYST_PROPAGATION']);
const CONTINUATION_PHASES = Object.freeze({
  MOMENTUM_CONTINUATION: Object.freeze(['IGNITION', 'ACCELERATING', 'HEALTHY_CONTINUATION', 'EDGE_REACCELERATING', 'BREAKOUT_PRESSURE_BUILDING']),
  MICRO_BITE: Object.freeze(['IGNITION', 'ACCELERATING', 'EDGE_REACCELERATING', 'BREAKOUT_PRESSURE_BUILDING']),
});
const POST_SIZE_EXECUTION_GATE_SETUPS = Object.freeze(['MOMENTUM_CONTINUATION', 'MICRO_BITE']);
export const POST_SIZE_EXECUTION_GATE_VERSION = EDGE_EXECUTION_GATE_VERSION;
// the frozen reference bundle: what may never move after T
export function freezeReferences({ setupId, ind, spec, fast, event = null, triggerTs, strategyVersion = STRATEGY_VERSION }) {
  const tick = spec.priceIncrement; const atr = d(ind.atr14); const buffer = setupBuffer(atr, tick);
  const base = { setupId, strategyVersion, triggerTs, blockDigest: ind.blockDigest, referenceTs: ind.referenceTs, atr14: atr, tick, buffer };
  if (setupId === 'RANGE_IGNITION') { const h20 = d(ind.h20); const l20 = d(ind.l20); const trigger = M.add(h20, buffer); const stop = M.sub(d(ind.low5), buffer); const scenario = M.add(h20, M.sub(h20, l20)); return { ...base, h20, l20, envelope5: d(ind.envelope5), triggerLevel: trigger, structuralStop: stop, scenarioRaw: scenario, maxEntryLevel: M.add(h20, M.mul('0.75', atr)) }; }
  if (setupId === 'TREND_PULLBACK_CONTINUATION') { const p20h = d(ind.prior20High); const p20l = d(ind.prior20Low); const trigger = M.add(d(ind.last2High), tick); return { ...base, prior20High: p20h, prior20Low: p20l, last3Low: d(ind.last3Low), ema5: d(ind.ema5), ema20: d(ind.ema20), prior20Return: ind.prior20Return, prior20HighBarsFromEnd: ind.prior20HighBarsFromEnd, triggerLevel: trigger, structuralStop: M.sub(d(ind.last3Low), buffer), scenarioRaw: M.add(p20h, M.mul('0.5', M.sub(p20h, p20l))), maxEntryLevel: M.add(p20h, M.mul('0.75', atr)) }; }
  if (setupId === 'ABSORPTION_RECLAIM') { const trigger = M.add(fast.vwap60, tick); return { ...base, priorFi: fast.priorFi, priorMidChange: fast.priorMidChange, priorMedianDepth: fast.priorMedianDepth, priorDepthSamples: fast.priorDepthSamples, priorLow: fast.priorLow60, vwap60: fast.vwap60, triggerLevel: trigger, structuralStop: M.sub(fast.priorLow60, buffer), scenarioRaw: d(ind.h20), maxEntryLevel: null }; }
  if (setupId === 'CATALYST_TRANSMISSION') { if (!event) return null; const p0 = event.p0; const trigger = M.add(p0, M.mul('0.1', atr)); return { ...base, event: { eventId: event.eventId, knownAtTs: event.knownAtTs, taxonomy: event.taxonomy, caseId: event.caseId, analysisId: event.analysisId }, p0, preEventH20: d(ind.h20), preEventL20: d(ind.l20), preEventLow5: d(ind.low5), triggerLevel: trigger, structuralStop: M.sub(M.min(p0, d(ind.low5)), buffer), scenarioRaw: M.add(p0, M.sub(d(ind.h20), d(ind.l20))), maxEntryLevel: M.add(p0, M.mul('1', atr)) }; }
  if (setupId === 'MOMENTUM_CONTINUATION') { const h20 = d(ind.h20); const l20 = d(ind.l20); return { ...base, ema5: d(ind.ema5), ema20: d(ind.ema20), lastClose: d(ind.lastClose), prior20Return: ind.prior20Return, triggerLevel: M.add(h20, buffer), structuralStop: M.sub(d(ind.low5), buffer), scenarioRaw: M.add(h20, M.mul('0.75', M.sub(h20, l20))), maxEntryLevel: null }; }
  if (setupId === 'MICRO_BITE') { const trigger = M.add(d(ind.last2High), tick); return { ...base, ema5: d(ind.ema5), lastClose: d(ind.lastClose), envelope5: d(ind.envelope5), h20: d(ind.h20), triggerLevel: trigger, structuralStop: M.sub(d(ind.low5), buffer), scenarioRaw: d(ind.h20), maxEntryLevel: null }; }
  return null;
}
export const hypothesisDigest = (frozen) => digestOf(frozen);
// the slow / structural clauses judged at T (a breach of any is a refusal, not a later re-rating)
export function structuralClauses(setupId, frozen, ind, fast, { decisionTs, event = null } = {}) {
  const c = [];
  if (setupId === 'RANGE_IGNITION') { c.push(clause('COMPRESSION_5BAR', M.lte(frozen.envelope5, M.mul('2', frozen.atr14)), frozen.envelope5, M.mul('2', frozen.atr14), 'QUOTE', 'prior 5 closed bars high-low envelope <= 2 ATR14')); }
  if (setupId === 'TREND_PULLBACK_CONTINUATION') { c.push(clause('EMA5_ABOVE_EMA20', M.gt(frozen.ema5, frozen.ema20), frozen.ema5, frozen.ema20, 'QUOTE')); c.push(clause('PRIOR20_RETURN_POSITIVE', frozen.prior20Return > 0, frozen.prior20Return, 0, 'FRACTION')); c.push(clause('PRIOR20_HIGH_BEFORE_LAST3', frozen.prior20HighBarsFromEnd >= 3, frozen.prior20HighBarsFromEnd, 3, 'BARS', 'the prior20 high occurred before the last 3 completed bars')); c.push(clause('PULLBACK_WITHIN_1_5_ATR', M.lte(M.sub(frozen.prior20High, frozen.last3Low), M.mul('1.5', frozen.atr14)), M.sub(frozen.prior20High, frozen.last3Low), M.mul('1.5', frozen.atr14), 'QUOTE')); }
  if (setupId === 'ABSORPTION_RECLAIM') { c.push(clause('PRIOR_FI_ABSORBED', known(frozen.priorFi) && frozen.priorFi.fi <= -0.15, frozen.priorFi?.fi ?? null, -0.15, 'FRACTION', 'prior episode [T-75s,T-15s) taker imbalance')); c.push(clause('PRIOR_MID_RESPONSE_SMALL', frozen.priorMidChange !== null && M.lte(M.abs(frozen.priorMidChange), M.mul('0.15', frozen.atr14)), frozen.priorMidChange, M.mul('0.15', frozen.atr14), 'QUOTE', 'absolute mid change in EITHER direction')); c.push(clause('BASELINE_DEPTH_SUPPORT', frozen.priorDepthSamples >= 30, frozen.priorDepthSamples, 30, 'BOOKS')); const atT = fast.atTrigger ?? fast; c.push(clause('RECLAIM_FI15', known(atT.reclaimFi) && atT.reclaimFi.fi >= 0.2, atT.reclaimFi?.fi ?? null, 0.2, 'FRACTION', 'FI over [T-15s,T): the frozen episode window, never the decision window')); c.push(clause('SCENARIO_LEVEL_EXISTS', frozen.scenarioRaw !== null && M.gt(frozen.scenarioRaw, frozen.triggerLevel), frozen.scenarioRaw, frozen.triggerLevel, 'QUOTE', 'previously observed H20 above entry; none -> NO_TRADE')); }
  if (setupId === 'CATALYST_TRANSMISSION') { const ev = frozen.event; c.push(clause('EVENT_PRIMARY_CONFIRMED', Boolean(event?.primaryConfirmed), event?.primaryConfirmed ?? null, true, 'BOOL')); c.push(clause('EVENT_KNOWN_WITHIN_10M', Boolean(ev) && decisionTs - ev.knownAtTs <= REFERENCE.catalystKnownWithinMs && decisionTs >= ev.knownAtTs, ev ? decisionTs - ev.knownAtTs : null, REFERENCE.catalystKnownWithinMs, 'MS')); c.push(clause('EVENT_OCCURRED_NOT_SCHEDULED', Boolean(event?.occurred), event?.occurred ?? null, true, 'BOOL', 'a future scheduled date is not an occurrence')); c.push(clause('MECHANISM_UPWARD_PRESSURE_CITED', event?.mechanismDirection === 'UPWARD_PRESSURE' && Boolean(event?.mechanismCitesEvent), event?.mechanismDirection ?? null, 'UPWARD_PRESSURE', 'ENUM', 'MIXED / UNKNOWN never becomes UPWARD by prose')); c.push(clause('P0_FROM_PRE_EVENT_SNAPSHOT', Boolean(event?.p0) && Boolean(event?.p0Source === 'PRE_EVENT_SNAPSHOT'), event?.p0Source ?? null, 'PRE_EVENT_SNAPSHOT', 'ENUM')); }
  if (setupId === 'MOMENTUM_CONTINUATION') { c.push(clause('LAST_CLOSE_ABOVE_EMA5', M.gt(frozen.lastClose, frozen.ema5), frozen.lastClose, frozen.ema5, 'QUOTE')); c.push(clause('EMA5_ABOVE_EMA20', M.gt(frozen.ema5, frozen.ema20), frozen.ema5, frozen.ema20, 'QUOTE')); c.push(clause('PRIOR20_RETURN_POSITIVE', typeof frozen.prior20Return === 'number' && Number.isFinite(frozen.prior20Return) && frozen.prior20Return > 0, Number.isFinite(frozen.prior20Return) ? frozen.prior20Return : null, 0, 'FRACTION')); }
  if (setupId === 'MICRO_BITE') { c.push(clause('MICRO_PRICE_AT_OR_ABOVE_EMA5', M.gte(frozen.lastClose, frozen.ema5), frozen.lastClose, frozen.ema5, 'QUOTE')); c.push(clause('MICRO_RANGE_READY', M.lte(frozen.envelope5, M.mul('2', frozen.atr14)), frozen.envelope5, M.mul('2', frozen.atr14), 'QUOTE', 'five completed bars remain bounded before the micro ignition')); }
  c.push(clause('ATR14_POSITIVE', M.isPositive(frozen.atr14), frozen.atr14, '0', 'QUOTE'));
  return c;
}
// the fast clauses re-evaluated at D against the FROZEN references (extension cap, flow, relative volume, crossing)
export function fastClauses(setupId, frozen, fast) {
  const c = []; const mid = fast.mid;
  c.push(clause('MID_ABOVE_TRIGGER', M.gte(mid, frozen.triggerLevel), mid, frozen.triggerLevel, 'QUOTE', 'fresh mid at/above the full trigger level'));
  if (frozen.maxEntryLevel !== null) c.push(clause('EXTENSION_CAP', M.lte(mid, frozen.maxEntryLevel), mid, frozen.maxEntryLevel, 'QUOTE', 'do not chase'));
  c.push(clause('FI15', known(fast.fi15) && fast.fi15.fi >= REFERENCE.fi15Min, fast.fi15?.fi ?? null, REFERENCE.fi15Min, 'FRACTION', fast.fi15?.reason ?? null));
  c.push(clause('FI60_POSITIVE', known(fast.fi60) && fast.fi60.fi > 0, fast.fi60?.fi ?? null, 0, 'FRACTION', fast.fi60?.reason ?? null));
  if (setupId !== 'ABSORPTION_RECLAIM') { const min = setupDefinition(setupId)?.rv60Min ?? REFERENCE.rv60Catalyst; c.push(clause('RV60', known(fast.rv60) && fast.rv60.rv60 >= min, fast.rv60?.rv60 ?? null, min, 'RATIO', fast.rv60?.reason ?? null)); }
  else { c.push(clause('DEPTH_HOLDS_80PCT_OF_BASELINE', fast.depth10bps !== null && frozen.priorMedianDepth !== null && M.gte(fast.depth10bps, M.mul('0.8', frozen.priorMedianDepth)), fast.depth10bps, frozen.priorMedianDepth ? M.mul('0.8', frozen.priorMedianDepth) : null, 'QUOTE', 'current 10bps bid notional vs the SAME frozen median')); c.push(clause('FI15_FRESH_AT_D', known(fast.fi15) && fast.fi15.fi >= 0.2, fast.fi15?.fi ?? null, 0.2, 'FRACTION', 'may overlap prior data; not independent confirmation')); }
  c.push(clause('COVERAGE_60S', fast.coverage?.continuous === true && fast.coverage.startTs <= fast.decisionTs - 60_000, fast.coverage?.startTs ?? null, fast.decisionTs - 60_000, 'TS', '60s continuous trade coverage'));
  c.push(clause('BOOK_FRESH', fast.bookAgeMs !== null && fast.bookAgeMs <= 1000 && fast.crcVerified === true, fast.bookAgeMs, 1000, 'MS', 'CRC-verified book at most 1s old'));
  if (setupId === 'MOMENTUM_CONTINUATION' || setupId === 'MICRO_BITE') {
    const depth = fast.depth10bps ?? null;
    c.push(clause('LIQUIDITY_PRESENT', safePositive(depth), depth, '0', 'QUOTE', 'observed bid notional within 10bps; zero or missing is not liquidity'));
    const evidence = fast.continuationEvidence; const evidenceFresh = freshFact(evidence, fast.decisionTs, 60_000);
    const dimensions = evidenceFresh && Array.isArray(evidence.dimensions) && evidence.dimensions.every((x) => CONTINUATION_DIMENSIONS.includes(x)) && new Set(evidence.dimensions).size === evidence.dimensions.length ? evidence.dimensions : null;
    const groups = evidenceFresh && Array.isArray(evidence.relianceGroups) && evidence.relianceGroups.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 60) ? [...new Set(evidence.relianceGroups)] : null;
    c.push(clause('CONTINUATION_PHASE_ELIGIBLE', evidenceFresh && CONTINUATION_PHASES[setupId].includes(evidence.phase), evidenceFresh ? evidence.phase : null, CONTINUATION_PHASES[setupId], 'ENUM', 'KNOWN means the observed/calculated inputs are current, not that the future outcome is certain'));
    c.push(clause('DISTINCT_EVIDENCE_DIMENSIONS', dimensions !== null && dimensions.length >= 3 && groups !== null && groups.length >= 2, dimensions === null || groups === null ? null : { dimensions, relianceGroups: groups }, { minDimensions: 3, minRelianceGroups: 2 }, 'EVIDENCE_SET', 'distinct dimensions/reliance groups are corroboration inputs, not statistically independent wins'));
    if (setupId === 'MOMENTUM_CONTINUATION') c.push(clause('CHALLENGE_NOT_FAILED', evidenceFresh && evidence.challengeState !== 'FAILED', evidenceFresh ? (evidence.challengeState ?? 'NOT_OBSERVED') : null, 'NOT_FAILED', 'ENUM', 'a survived challenge is preferred but NOT_OBSERVED is not a mandatory pullback refusal'));
    const exhaustion = fast.exhaustion; const exhaustionKnown = freshFact(exhaustion, fast.decisionTs, 60_000) && typeof exhaustion.exhausted === 'boolean';
    c.push(clause('NOT_EXHAUSTED', exhaustionKnown && exhaustion.exhausted === false, exhaustionKnown ? exhaustion.exhausted : null, false, 'BOOL', 'unknown exhaustion is not interpreted as room to run'));
  }
  return c;
}
// the target scenario capped by a nearer confirmed resistance above the proposed entry (never an invented level)
export function scenarioTarget(frozen, bars, entry, referenceTs) { const raw = frozen.scenarioRaw; if (raw === null) return { target: null, cappedBy: null }; const res = nearestResistanceAbove(bars, Number(entry), { referenceTs }); if (res && M.lt(d(res.price), raw)) return { target: d(res.price), cappedBy: { price: d(res.price), periodStartTs: res.periodStartTs } }; return { target: raw, cappedBy: null }; }
// ablate (focused completion §5, MOMENTUM_ABLATION): an explicit research-only removal of NAMED entry clauses of ONE setup; the removed
// clauses are still measured and reported (`ablated`), they simply do not decide. Nothing else changes; PAPER / LIVE never pass it.
export const ABLATABLE_CLAUSES = Object.freeze({ RANGE_IGNITION: ['FI15', 'FI60_POSITIVE'] });
// This gate runs only AFTER the intended size has walked both sides of a real
// book and the existing cost layer has produced executable facts. It is kept
// separate from evaluateSetup to avoid circularly requiring cost before size.
export function evaluateStyleExecutionGate({ setupId, executableEdge, decisionTs } = {}) {
  if (!POST_SIZE_EXECUTION_GATE_SETUPS.includes(setupId)) return Object.freeze({ gateVersion: POST_SIZE_EXECUTION_GATE_VERSION, setupId, required: false, state: 'NOT_REQUIRED', clauses: [], refused: [], needsData: [] });
  const fresh = freshFact(executableEdge, decisionTs, 1_000);
  const priceInputs = fresh && safePositive(executableEdge.averageEntryPrice) && safePositive(executableEdge.averageExitPrice);
  const costInputs = fresh && safeNonNegative(executableEdge.roundTripFeesQuote) && safeNonNegative(executableEdge.spreadCostQuote) && safeNonNegative(executableEdge.slippageCostQuote);
  const edge = Number(executableEdge?.estimatedRemainingEdgeAfterCostsBps); const riskEdge = Number(executableEdge?.estimatedRemainingEdgeAfterCostsAndRiskBps);
  const clauses = [
    clause('EXECUTABLE_BOTH_DIRECTIONS', priceInputs && executableEdge.entryDepthSufficient === true && executableEdge.exitDepthSufficient === true, fresh ? { averageEntryPrice: executableEdge.averageEntryPrice ?? null, averageExitPrice: executableEdge.averageExitPrice ?? null, entryDepthSufficient: executableEdge.entryDepthSufficient ?? null, exitDepthSufficient: executableEdge.exitDepthSufficient ?? null } : null, true, 'EXECUTION_FACTS', 'realistic intended-size average fills and depth supplied by the cost/size layer'),
    clause('ROUND_TRIP_COST_INPUTS_KNOWN', costInputs, costInputs ? { roundTripFeesQuote: executableEdge.roundTripFeesQuote, spreadCostQuote: executableEdge.spreadCostQuote, slippageCostQuote: executableEdge.slippageCostQuote } : null, 'NON_NEGATIVE', 'QUOTE', 'fees, spread and slippage are supplied facts; this gate does not recompute them'),
    clause('ESTIMATED_REMAINING_EDGE_AFTER_COSTS_POSITIVE', fresh && Number.isFinite(edge) && edge > 0, fresh && Number.isFinite(edge) ? edge : null, 0, 'BPS', 'an estimate from valid inputs, never known future profit'),
    clause('ESTIMATED_REMAINING_EDGE_AFTER_COSTS_AND_RISK_POSITIVE', fresh && Number.isFinite(riskEdge) && riskEdge > 0, fresh && Number.isFinite(riskEdge) ? riskEdge : null, 0, 'BPS', 'estimated remaining edge must survive both round-trip costs and risk'),
  ];
  const refused = clauses.filter((x) => !x.ok).map((x) => x.id); const needsData = clauses.filter((x) => !x.ok && x.value === null).map((x) => x.id);
  const state = refused.length === 0 ? 'ELIGIBLE' : needsData.length === refused.length ? 'NEEDS_DATA' : 'REFUSED';
  return Object.freeze({ gateVersion: POST_SIZE_EXECUTION_GATE_VERSION, setupId, required: true, state, clauses, refused, needsData });
}
export function setupStrengthFacts(frozen, fast) {
  let priceBeyondTriggerAtr = null;
  try { if (frozen && M.isPositive(frozen.atr14) && fast?.mid !== null && fast?.mid !== undefined) priceBeyondTriggerAtr = M.div(M.sub(fast.mid, frozen.triggerLevel), frozen.atr14, 8, 'HALF_UP'); } catch { priceBeyondTriggerAtr = null; }
  const exhaustionKnown = fast?.exhaustion?.state === 'KNOWN' && typeof fast.exhaustion.exhausted === 'boolean';
  const age = (fact) => Number.isSafeInteger(fact?.knownAtTs) && Number.isSafeInteger(fast?.decisionTs) ? Math.max(0, fast.decisionTs - fact.knownAtTs) : null;
  const evidenceKnown = known(fast?.continuationEvidence);
  return Object.freeze({ strengthFactsVersion: 'judge-setup-strength-facts-1', priceBeyondTriggerAtr, relativeVolume60: known(fast?.rv60) ? fast.rv60.rv60 : null, flow15: known(fast?.fi15) ? fast.fi15.fi : null, flow60: known(fast?.fi60) ? fast.fi60.fi : null, depth10bps: fast?.depth10bps ?? null, continuationPhase: evidenceKnown ? fast.continuationEvidence.phase ?? null : null, evidenceDimensions: evidenceKnown && Array.isArray(fast.continuationEvidence.dimensions) ? [...fast.continuationEvidence.dimensions] : null, exhausted: exhaustionKnown ? fast.exhaustion.exhausted : null, known: Object.freeze({ relativeVolume60: known(fast?.rv60), flow15: known(fast?.fi15), flow60: known(fast?.fi60), liquidity: fast?.depth10bps !== null && fast?.depth10bps !== undefined, continuation: evidenceKnown, exhaustion: exhaustionKnown }), sourceAgeMs: Object.freeze({ book: fast?.bookAgeMs ?? null, continuation: age(fast?.continuationEvidence), exhaustion: age(fast?.exhaustion) }) });
}
export function evaluateSetup({ setupId, frozen, ind, fast, bars, entry, decisionTs, event = null, ablate = null }) {
  if (!SETUP_EVALUATORS.includes(setupId)) throw new Error(`unknown setup ${setupId}`);
  if (ablate && ablate.setupId === setupId) { const allowed = ABLATABLE_CLAUSES[setupId] ?? []; const bad = (ablate.clauses ?? []).filter((id) => !allowed.includes(id)); if (bad.length) throw new Error(`clauses ${bad.join(',')} are not ablatable for ${setupId}`); }
  const structural = structuralClauses(setupId, frozen, ind, fast, { decisionTs, event }); const quick = fastClauses(setupId, frozen, fast); const all = [...structural, ...quick];
  let ablated = []; if (ablate && ablate.setupId === setupId) ablated = all.filter((x) => ablate.clauses.includes(x.id)).map((x) => ({ ...x, ablated: true }));
  const clauses = ablated.length ? all.filter((x) => !ablate.clauses.includes(x.id)) : all;
  const needsData = clauses.filter((x) => x.value === null && !x.ok).map((x) => x.id); const refused = clauses.filter((x) => !x.ok).map((x) => x.id);
  const t = scenarioTarget(frozen, bars, entry, frozen.referenceTs); const stopOk = M.isPositive(frozen.structuralStop) && M.lt(frozen.structuralStop, entry);
  if (!stopOk) refused.push('STOP_GEOMETRY');
  const state = refused.length === 0 ? 'ELIGIBLE' : needsData.length && needsData.length === refused.length ? 'NEEDS_DATA' : 'REFUSED';
  const definition = setupDefinition(setupId);
  return Object.freeze({ setupId, setupFamily: definition.familyId, startingStyleCatalogVersion: STARTING_STYLE_CATALOG_VERSION, strategyVersion: frozen.strategyVersion ?? STRATEGY_VERSION, state, clauses: ablated.length ? [...clauses, ...ablated] : clauses, ablated: ablated.map((x) => x.id), refused, needsData, invalidation: { structuralStop: frozen.structuralStop, kind: 'ABSOLUTE_PRICE_BELOW' }, scenario: { target: t.target, cappedBy: t.cappedBy, kind: 'SCENARIO_NOT_FORECAST' }, maxEntryLevel: frozen.maxEntryLevel, horizon: definition.horizon, maxDurationMs: definition.operationalMaxDurationMs, executionGate: Object.freeze({ required: POST_SIZE_EXECUTION_GATE_SETUPS.includes(setupId), version: POST_SIZE_EXECUTION_GATE_VERSION, state: POST_SIZE_EXECUTION_GATE_SETUPS.includes(setupId) ? 'REQUIRED_DOWNSTREAM' : 'NOT_REQUIRED' }), strengthFacts: setupStrengthFacts(frozen, fast), hypothesisDigest: hypothesisDigest(frozen), calibrationState: 'UNVALIDATED_HYPOTHESIS' });
}
// ---- the persistence / expiry / cooldown law over accepted books --------------------------------------------------------------
export function createConfirmation({ level, triggerTs, expiryMs = REFERENCE.proposalExpiryMs, minBooks = REFERENCE.persistenceBooks, spanMs = REFERENCE.persistenceSpanMs }) {
  let obs = []; let resets = 0; let state = 'PENDING'; let confirmedTs = null;
  return {
    observe(mid, receiptTs, sequence) { if (state === 'EXPIRED' || state === 'CONFIRMED') return state; if (receiptTs - triggerTs > expiryMs) { state = 'EXPIRED'; return state; } if (M.lt(mid, level)) { obs = []; resets += 1; state = 'PENDING'; return 'RESET'; } if (obs.length && obs[obs.length - 1].sequence === sequence) return state; obs.push({ mid, receiptTs, sequence }); if (obs.length >= minBooks && obs[obs.length - 1].receiptTs - obs[0].receiptTs >= spanMs) { state = 'CONFIRMED'; confirmedTs = receiptTs; } return state; },
    expire(now) { if (state !== 'CONFIRMED' && now - triggerTs > expiryMs) state = 'EXPIRED'; return state; },
    status: () => ({ state, level, triggerTs, observations: obs.length, spanMs: obs.length ? obs[obs.length - 1].receiptTs - obs[0].receiptTs : 0, resets, confirmedTs }),
  };
}
// per (asset, setup) episode state: one episode per crossing; a reset (mid back below the level) is required before a new crossing; cooldown after a close
export function createEpisodeTracker({ assetId, setupId, cooldownMs = REFERENCE.cooldownMs }) {
  let episode = null; let below = true; let cooldownUntil = 0; let counter = 0; const counters = { crossings: 0, resets: 0, expired: 0, cooldownRefusals: 0 };
  return {
    observeMid(mid, level, receiptTs) { if (M.lt(mid, level)) { if (!below) counters.resets += 1; below = true; if (episode && episode.state === 'PENDING') { episode.state = 'RESET'; episode = null; } return { crossing: false }; } if (below && !episode) { below = false; if (receiptTs < cooldownUntil) { counters.cooldownRefusals += 1; return { crossing: false, refused: 'COOLDOWN', cooldownUntil }; } counter += 1; counters.crossings += 1; episode = { episodeId: `ep-${assetId}-${setupId}-${receiptTs}-${counter}`, triggerTs: receiptTs, level, state: 'PENDING' }; return { crossing: true, episode }; } return { crossing: false }; },
    current: () => episode, expire(now) { if (episode && episode.state === 'PENDING' && now - episode.triggerTs > REFERENCE.proposalExpiryMs) { episode.state = 'EXPIRED'; counters.expired += 1; const e = episode; episode = null; return e; } return null; },
    decide(state) { if (episode) { episode.state = state; const e = episode; if (state !== 'PENDING') episode = null; return e; } return null; },
    closed(now) { cooldownUntil = now + cooldownMs; below = true; episode = null; }, status: () => ({ assetId, setupId, below, cooldownUntil, episode, counters: { ...counters } }),
  };
}
