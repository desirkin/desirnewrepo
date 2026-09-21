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
import { REWARD_RISK_MIN } from './cost.js';

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
// GATE LEARNING (PUBLISH-FIX-82; owner directive 2026-09-19, David: "I want him to move the gate once it's tested enough — thousands
// of tests — without me having to say so"): the flow lines a learned lesson may move, each inside a FIXED band it can never leave.
// A learned line replaces the REFERENCE value as the clause's threshold, and the clause row records the line actually used (the
// learning ledger reads that row, so every later test is scored against the line that judged it). No lesson -> REFERENCE, byte for
// byte. `min` is the band's floor: at the floor every KNOWN value passes (an unknown value still fails — the gate is moved, never
// blinded). Structural clauses (levels, stops, geometry) are NOT learnable: only these buying-pressure / volume lines are.
export const LEARNABLE_GATES = Object.freeze({
  FI15: Object.freeze({ reference: 0.2, min: -1, max: 0.5, step: 0.05, op: 'GTE', unit: 'FRACTION' }),
  FI60_POSITIVE: Object.freeze({ reference: 0, min: -1, max: 0.3, step: 0.05, op: 'GT', unit: 'FRACTION' }),
  RV60: Object.freeze({ reference: null, min: 0, max: 3, step: 0.25, op: 'GTE', unit: 'RATIO' }), // reference is the setup's own rv60Min
  RECLAIM_FI15: Object.freeze({ reference: 0.2, min: -1, max: 0.5, step: 0.05, op: 'GTE', unit: 'FRACTION' }),
  FI15_FRESH_AT_D: Object.freeze({ reference: 0.2, min: -1, max: 0.5, step: 0.05, op: 'GTE', unit: 'FRACTION' }),
});
// the line in force for a learnable gate: the learned one when it is a finite number inside the band, else the reference
export function learnedLine(learned, id, reference) {
  const g = LEARNABLE_GATES[id]; const v = learned && typeof learned === 'object' ? learned[id] : undefined;
  return g && typeof v === 'number' && Number.isFinite(v) && v >= g.min && v <= g.max ? v : reference;
}
// the learned lines that differ from their references (for the decision's GATE_LEARNING row); RV60's reference is per setup
export function learnedOverrides(learned, setupId = null) {
  const out = [];
  for (const id of Object.keys(LEARNABLE_GATES)) { const ref = id === 'RV60' ? (setupId && setupDefinition(setupId)?.rv60Min !== null && setupDefinition(setupId)?.rv60Min !== undefined ? setupDefinition(setupId).rv60Min : null) : LEARNABLE_GATES[id].reference; if (ref === null) continue; const line = learnedLine(learned, id, ref); if (line !== ref) out.push({ id, reference: ref, line }); }
  return out;
}
const known = (x) => x && x.state === 'KNOWN';
const safePositive = (x) => { try { return x !== null && x !== undefined && M.isPositive(x); } catch { return false; } };
const safeNonNegative = (x) => { try { return x !== null && x !== undefined && M.gte(x, '0'); } catch { return false; } };
const freshFact = (x, decisionTs, maxAgeMs) => known(x) && Number.isSafeInteger(x.knownAtTs) && Number.isSafeInteger(decisionTs) && x.knownAtTs <= decisionTs && decisionTs - x.knownAtTs <= maxAgeMs;
const PRE_EVENT_EVIDENCE_KEYS = Object.freeze(['canonicalCoin', 'componentSourceIds', 'cutoffTs', 'eventId', 'evidenceId', 'knownAtTs', 'marketContextRef', 'observedTs', 'occurrenceClockBasis', 'packetId', 'price', 'quote', 'sourceRefs', 'venue', 'version', 'windowEndTs'].sort());
const exactKeys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === expected.join('|');
const boundedUniqueStrings = (value, max = 32) => Array.isArray(value) && value.length > 0 && value.length <= max
  && value.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 160) && new Set(value).size === value.length;
const preEventSnapshotBound = (event) => {
  const p = event?.p0Evidence; if (!p || event?.p0Source !== 'PRE_EVENT_SNAPSHOT' || !safePositive(event?.p0)) return false;
  if (!exactKeys(p, PRE_EVENT_EVIDENCE_KEYS)) return false;
  if (p.version !== 'judge-catalyst-pre-event-snapshot-1' || p.eventId !== event.eventId || p.price !== event.p0) return false;
  if (p.occurrenceClockBasis !== 'SOURCE_PUBLISHED_TS' || event.occurrenceClockBasis !== p.occurrenceClockBasis) return false;
  if (p.venue !== 'kraken' || p.quote !== 'USD' || p.canonicalCoin !== event.canonicalCoin || typeof p.canonicalCoin !== 'string' || !p.canonicalCoin.length) return false;
  if (!/^sep2-[0-9a-f]{40}$/.test(p.packetId ?? '') || !/^evd-[0-9a-f]{40}$/.test(p.marketContextRef ?? '') || !/^evd-[0-9a-f]{40}$/.test(p.evidenceId ?? '')) return false;
  if (!boundedUniqueStrings(p.sourceRefs) || !p.sourceRefs.every((x) => /^src-[0-9a-f]{40}$/.test(x)) || !boundedUniqueStrings(p.componentSourceIds)) return false;
  if (![p.observedTs, p.knownAtTs, p.windowEndTs, p.cutoffTs].every((x) => Number.isSafeInteger(x) && x > 0)) return false;
  return Number.isSafeInteger(event.knownAtTs) && Number.isSafeInteger(event.occurredTs)
    && p.cutoffTs === Math.min(event.knownAtTs, event.occurredTs)
    && p.observedTs <= p.cutoffTs && p.knownAtTs <= p.cutoffTs && p.windowEndTs <= p.cutoffTs;
};
// The structural anchor is fixed at the crossing. A later valid event/chart
// cannot silently qualify the old price geometry under a new hypothesis.
const sameFrozenCatalyst = (frozen, event) => preEventSnapshotBound(event)
  && frozen?.event?.eventId === event.eventId
  && frozen.event.knownAtTs === event.knownAtTs
  && frozen.p0 === event.p0
  && digestOf(frozen.event.p0Evidence) === digestOf(event.p0Evidence);
const detachedPreEventEvidence = (p) => Object.freeze({ ...p,
  sourceRefs: Object.freeze([...p.sourceRefs]),
  componentSourceIds: Object.freeze([...p.componentSourceIds]),
});
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
  if (setupId === 'ABSORPTION_RECLAIM') { const trigger = M.add(fast.vwap60, tick); return { ...base, priorFi: fast.priorFi, priorMidChange: fast.priorMidChange, priorMedianDepth: fast.priorMedianDepth, priorDepthSamples: fast.priorDepthSamples, priorLow: fast.priorLow60, vwap60: fast.vwap60, triggerLevel: trigger, structuralStop: M.sub(fast.priorLow60, buffer), scenarioRaw: d(ind.h20), scenarioProjected: M.add(d(ind.l120), M.sub(d(ind.h120), d(ind.l120))), coilLow: d(ind.l120), coilHigh: d(ind.h120), coilRange15: d(ind.range15), coilBars: ind.coilBars, maxEntryLevel: null }; } // PUBLISH-FIX-120: the coil's own two-hour geometry, and a projection one full two-hour range above its low
  if (setupId === 'CATALYST_TRANSMISSION') { if (!preEventSnapshotBound(event)) return null; const p0 = event.p0; const trigger = M.add(p0, M.mul('0.1', atr)); return { ...base, event: Object.freeze({ eventId: event.eventId, knownAtTs: event.knownAtTs, taxonomy: event.taxonomy, caseId: event.caseId, analysisId: event.analysisId, p0Evidence: detachedPreEventEvidence(event.p0Evidence) }), p0, preEventH20: d(ind.h20), preEventL20: d(ind.l20), preEventLow5: d(ind.low5), triggerLevel: trigger, structuralStop: M.sub(M.min(p0, d(ind.low5)), buffer), scenarioRaw: M.add(p0, M.sub(d(ind.h20), d(ind.l20))), maxEntryLevel: M.add(p0, M.mul('1', atr)) }; }
  if (setupId === 'MOMENTUM_CONTINUATION') { const h20 = d(ind.h20); const l20 = d(ind.l20); return { ...base, ema5: d(ind.ema5), ema20: d(ind.ema20), lastClose: d(ind.lastClose), prior20Return: ind.prior20Return, triggerLevel: M.add(h20, buffer), structuralStop: M.sub(d(ind.low5), buffer), scenarioRaw: M.add(h20, M.mul('0.75', M.sub(h20, l20))), maxEntryLevel: null }; }
  if (setupId === 'MICRO_BITE') { const trigger = M.add(d(ind.last2High), tick); const h20 = d(ind.h20); const l20 = d(ind.l20); return { ...base, ema5: d(ind.ema5), lastClose: d(ind.lastClose), envelope5: d(ind.envelope5), h20, l20, triggerLevel: trigger, structuralStop: M.sub(d(ind.low5), buffer), scenarioRaw: h20, scenarioProjected: M.add(h20, M.sub(h20, l20)), maxEntryLevel: null }; } // PUBLISH-FIX-85: when the 20-bar high is already behind the entry the scenario projects one range above it (the RANGE_IGNITION measure)
  return null;
}
export const hypothesisDigest = (frozen) => digestOf(frozen);
// the slow / structural clauses judged at T (a breach of any is a refusal, not a later re-rating)
export function structuralClauses(setupId, frozen, ind, fast, { decisionTs, event = null, learned = null } = {}) {
  const c = [];
  if (setupId === 'RANGE_IGNITION') { c.push(clause('COMPRESSION_5BAR', M.lte(frozen.envelope5, M.mul('2', frozen.atr14)), frozen.envelope5, M.mul('2', frozen.atr14), 'QUOTE', 'prior 5 closed bars high-low envelope <= 2 ATR14')); }
  if (setupId === 'TREND_PULLBACK_CONTINUATION') { c.push(clause('EMA5_ABOVE_EMA20', M.gt(frozen.ema5, frozen.ema20), frozen.ema5, frozen.ema20, 'QUOTE')); c.push(clause('PRIOR20_RETURN_POSITIVE', frozen.prior20Return > 0, frozen.prior20Return, 0, 'FRACTION')); c.push(clause('PRIOR20_HIGH_BEFORE_LAST3', frozen.prior20HighBarsFromEnd >= 3, frozen.prior20HighBarsFromEnd, 3, 'BARS', 'the prior20 high occurred before the last 3 completed bars')); c.push(clause('PULLBACK_WITHIN_1_5_ATR', M.lte(M.sub(frozen.prior20High, frozen.last3Low), M.mul('1.5', frozen.atr14)), M.sub(frozen.prior20High, frozen.last3Low), M.mul('1.5', frozen.atr14), 'QUOTE')); }
  if (setupId === 'ABSORPTION_RECLAIM') { c.push(coilAtLowClause(frozen)); c.push(coilCompressedClause(frozen)); c.push(clause('PRIOR_FI_ABSORBED', known(frozen.priorFi) && frozen.priorFi.fi <= -0.15, frozen.priorFi?.fi ?? null, -0.15, 'FRACTION', 'prior episode [T-75s,T-15s) taker imbalance')); c.push(clause('PRIOR_MID_RESPONSE_SMALL', frozen.priorMidChange !== null && M.lte(M.abs(frozen.priorMidChange), M.mul('0.15', frozen.atr14)), frozen.priorMidChange, M.mul('0.15', frozen.atr14), 'QUOTE', 'absolute mid change in EITHER direction')); c.push(clause('BASELINE_DEPTH_SUPPORT', frozen.priorDepthSamples >= 30, frozen.priorDepthSamples, 30, 'BOOKS')); const atT = fast.atTrigger ?? fast; const reclaimLine = learnedLine(learned, 'RECLAIM_FI15', 0.2); c.push(clause('RECLAIM_FI15', known(atT.reclaimFi) && atT.reclaimFi.fi >= reclaimLine, atT.reclaimFi?.fi ?? null, reclaimLine, 'FRACTION', 'FI over [T-15s,T): the frozen episode window, never the decision window')); c.push(clause('SCENARIO_LEVEL_EXISTS', frozen.scenarioRaw !== null && M.gt(frozen.scenarioRaw, frozen.triggerLevel), frozen.scenarioRaw, frozen.triggerLevel, 'QUOTE', 'previously observed H20 above entry; none -> NO_TRADE')); }
  if (setupId === 'CATALYST_TRANSMISSION') { const ev = frozen.event; c.push(clause('EVENT_PRIMARY_CONFIRMED', Boolean(event?.primaryConfirmed), event?.primaryConfirmed ?? null, true, 'BOOL')); c.push(clause('EVENT_KNOWN_WITHIN_10M', Boolean(ev) && decisionTs - ev.knownAtTs <= REFERENCE.catalystKnownWithinMs && decisionTs >= ev.knownAtTs, ev ? decisionTs - ev.knownAtTs : null, REFERENCE.catalystKnownWithinMs, 'MS')); c.push(clause('EVENT_OCCURRED_NOT_SCHEDULED', Boolean(event?.occurred), event?.occurred ?? null, true, 'BOOL', 'a future scheduled date is not an occurrence')); c.push(clause('MECHANISM_UPWARD_PRESSURE_CITED', event?.mechanismDirection === 'UPWARD_PRESSURE' && Boolean(event?.mechanismCitesEvent), event?.mechanismDirection ?? null, 'UPWARD_PRESSURE', 'ENUM', 'MIXED / UNKNOWN never becomes UPWARD by prose')); c.push(clause('P0_FROM_PRE_EVENT_SNAPSHOT', sameFrozenCatalyst(frozen, event), preEventSnapshotBound(event) ? event.p0Evidence.evidenceId : null, 'PRE_EVENT_SNAPSHOT_BOUND', 'EVIDENCE_ID')); }
  if (setupId === 'MOMENTUM_CONTINUATION') { c.push(clause('LAST_CLOSE_ABOVE_EMA5', M.gt(frozen.lastClose, frozen.ema5), frozen.lastClose, frozen.ema5, 'QUOTE')); c.push(clause('EMA5_ABOVE_EMA20', M.gt(frozen.ema5, frozen.ema20), frozen.ema5, frozen.ema20, 'QUOTE')); c.push(clause('PRIOR20_RETURN_POSITIVE', typeof frozen.prior20Return === 'number' && Number.isFinite(frozen.prior20Return) && frozen.prior20Return > 0, Number.isFinite(frozen.prior20Return) ? frozen.prior20Return : null, 0, 'FRACTION')); }
  if (setupId === 'MICRO_BITE') { c.push(clause('MICRO_PRICE_AT_OR_ABOVE_EMA5', M.gte(frozen.lastClose, frozen.ema5), frozen.lastClose, frozen.ema5, 'QUOTE')); c.push(clause('MICRO_RANGE_READY', M.lte(frozen.envelope5, M.mul('2', frozen.atr14)), frozen.envelope5, M.mul('2', frozen.atr14), 'QUOTE', 'five completed bars remain bounded before the micro ignition')); }
  c.push(clause('ATR14_POSITIVE', M.isPositive(frozen.atr14), frozen.atr14, '0', 'QUOTE'));
  return c;
}
// the fast clauses re-evaluated at D against the FROZEN references (extension cap, flow, relative volume, crossing)
export function fastClauses(setupId, frozen, fast, learned = null) {
  const c = []; const mid = fast.mid;
  c.push(clause('MID_ABOVE_TRIGGER', M.gte(mid, frozen.triggerLevel), mid, frozen.triggerLevel, 'QUOTE', 'fresh mid at/above the full trigger level'));
  if (frozen.maxEntryLevel !== null) c.push(clause('EXTENSION_CAP', M.lte(mid, frozen.maxEntryLevel), mid, frozen.maxEntryLevel, 'QUOTE', 'do not chase'));
  const fi15Line = learnedLine(learned, 'FI15', REFERENCE.fi15Min); c.push(clause('FI15', known(fast.fi15) && fast.fi15.fi >= fi15Line, fast.fi15?.fi ?? null, fi15Line, 'FRACTION', fast.fi15?.reason ?? null));
  const fi60Line = learnedLine(learned, 'FI60_POSITIVE', 0); c.push(clause('FI60_POSITIVE', known(fast.fi60) && fast.fi60.fi > fi60Line, fast.fi60?.fi ?? null, fi60Line, 'FRACTION', fast.fi60?.reason ?? null));
  if (setupId !== 'ABSORPTION_RECLAIM') { const min = learnedLine(learned, 'RV60', setupDefinition(setupId)?.rv60Min ?? REFERENCE.rv60Catalyst); c.push(clause('RV60', known(fast.rv60) && fast.rv60.rv60 >= min, fast.rv60?.rv60 ?? null, min, 'RATIO', fast.rv60?.reason ?? null)); }
  else { c.push(clause('DEPTH_HOLDS_80PCT_OF_BASELINE', fast.depth10bps !== null && frozen.priorMedianDepth !== null && M.gte(fast.depth10bps, M.mul('0.8', frozen.priorMedianDepth)), fast.depth10bps, frozen.priorMedianDepth ? M.mul('0.8', frozen.priorMedianDepth) : null, 'QUOTE', 'current 10bps bid notional vs the SAME frozen median')); const freshLine = learnedLine(learned, 'FI15_FRESH_AT_D', 0.2); c.push(clause('FI15_FRESH_AT_D', known(fast.fi15) && fast.fi15.fi >= freshLine, fast.fi15?.fi ?? null, freshLine, 'FRACTION', 'may overlap prior data; not independent confirmation')); }
  c.push(clause('COVERAGE_60S', fast.coverage?.continuous === true && fast.coverage.startTs <= fast.decisionTs - 60_000, fast.coverage?.startTs ?? null, fast.decisionTs - 60_000, 'TS', '60s continuous trade coverage'));
  c.push(clause('BOOK_FRESH', fast.bookAgeMs !== null && fast.bookAgeMs <= 1000 && fast.crcVerified === true, fast.bookAgeMs, 1000, 'MS', 'CRC-verified book at most 1s old'));
  if (setupId === 'MOMENTUM_CONTINUATION' || setupId === 'MICRO_BITE') {
    const depth = fast.depth10bps ?? null;
    c.push(clause('LIQUIDITY_PRESENT', safePositive(depth), depth, '0', 'QUOTE', 'observed bid notional within 10bps of the best bid; zero or missing is not liquidity'));
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
// PUBLISH-FIX-120 (2026-09-21): the coil. Two conditions, and only two, measured over 23,445 one-minute moments on 45 USD
// pairs and labelled by PATH — a winner only when +12% arrived BEFORE the -1.2% stop, so a run we would have been stopped out
// of counts as a loss, not a win. Near the two-hour low AND the last fifteen minutes compressed took the average trade from
// -0.911% to +1.033% after the full 1.60% round trip, on 338 trades; an independent search at a +5% target returned the SAME
// two conditions on 727 trades (break-even there — the whole profit lives between 5% and 12%, which is why the projection
// above reaches for a full two-hour range). The four-condition 88%-precision rule from the same search is deliberately NOT
// here: it held 25 rows out of 23,445 after thousands of threshold trials and one of its terms was noise.
export const COIL_FROM_LOW_MAX_PCT = '0.5';   // within half a percent of the two-hour low
export const COIL_SQUEEZE_MAX = '0.11';       // fifteen-minute range under 11% of the two-hour range
export const COIL_MIN_BARS = 60;              // measured over at least an hour of bars, else the fact is UNKNOWN, never assumed
export function coilAtLowClause(frozen) {
  const known = M.isPositive(frozen.coilLow ?? '0') && Number.isSafeInteger(frozen.coilBars) && frozen.coilBars >= COIL_MIN_BARS;
  const pct = known ? Number(M.div(M.mul(M.sub(frozen.triggerLevel, frozen.coilLow), '100'), frozen.coilLow, 6, 'HALF_UP')) : null;
  return clause('COILED_AT_THE_LOW', known && Number.isFinite(pct) && pct >= 0 && pct <= Number(COIL_FROM_LOW_MAX_PCT), pct, Number(COIL_FROM_LOW_MAX_PCT), 'PCT', 'distance from the two-hour low at the reclaim');
}
export function coilCompressedClause(frozen) {
  const span = M.sub(frozen.coilHigh ?? '0', frozen.coilLow ?? '0');
  const known = M.isPositive(span) && Number.isSafeInteger(frozen.coilBars) && frozen.coilBars >= COIL_MIN_BARS;
  const ratio = known ? Number(M.div(frozen.coilRange15 ?? '0', span, 6, 'HALF_UP')) : null;
  return clause('COILED_COMPRESSED', known && Number.isFinite(ratio) && ratio <= Number(COIL_SQUEEZE_MAX), ratio, Number(COIL_SQUEEZE_MAX), 'RATIO', 'fifteen-minute range as a fraction of the two-hour range');
}
// the target scenario capped by a nearer confirmed resistance above the proposed entry (never an invented level)
// PUBLISH-FIX-85 (2026-09-20): the resistance cap honours the reward-to-risk law. A swing high nearer the entry than
// REWARD_RISK_MIN × (entry − structural stop) can never size (reward below 1.5× risk before fees), so it is not a target: the cap
// looks past it to the nearest swing that could, or leaves the setup's own target. The stop is the setup's own; no fee enters here
// (the cost law still applies fees and haircuts to whatever target results — a poor setup is still refused, at sizing, with reasons).
export const TARGET_MIN_REWARD_RISK = REWARD_RISK_MIN;
// PUBLISH-FIX-119 (2026-09-21). THE reason this application had never taken a trade: 7,889 scored decisions, zero entries, ever.
//
// Measured, not argued. Running the real cost law (judge/cost.js evaluateEntry) against a PERFECT book — infinite depth, a
// one-tick spread, zero slippage, nothing thin to blame — the smallest target that can EVER be sized is:
//       stop 0.30% -> target 4.55% | stop 0.50% -> 4.85% | stop 1.09% -> 5.75% | stop 1.72% -> 6.70% | stop 3.0% -> 8.60%
// because the 1.5x reward-to-risk law is applied to FEE-INCLUSIVE terms: the round trip (1.60% at Kraken tier 1) is subtracted
// from the reward AND added to the risk, so the required distance is 1.5*(stop + fees) + fees, not 1.5*stop.
// And the target every setup actually proposes is the high of the last TWENTY ONE-MINUTE BARS. The eight close calls of
// 2026-09-21 proposed: 0.20%, 0.28%, 0.37%, 0.71%, 1.31%, 1.40%, 1.77%. Three to twenty-five times too small. Not once close.
// The gate stack and the sizing law were built against different assumptions and the implied hurdle was never computed.
//
// Two halves of the fix, both here:
//  1. minTargetDistance now knows about fees. Its stated job is "a swing high nearer than this can never size"; it computed that
//     floor WITHOUT fees (the old comment admitted it: "reward below 1.5x risk before fees"), so the guard never fired for the
//     targets that actually occur, and the resistance cap happily capped a target down to a level that could never pay.
//  2. a setup that carries no projection of its own gets one derived from the bars it already froze: one full 20-bar range above
//     the entry. MICRO_BITE has had exactly this shape since PUBLISH-FIX-85; the other five never got it. A quiet coin has a
//     small range and is still refused at sizing, as it should be — the projection selects FOR coins that actually move, which
//     is the owner's standing thesis ("runners, that's our prey") and the only population where these economics can close.
// Nothing here relaxes the cost law, the reward-to-risk law, the stop, or any gate. The scenario is still a scenario and sizing
// still refuses it with its own reasons. Authority unchanged.
export function minTargetDistance(entry, structuralStop, feeRoundTripRate = '0') {
  const e = Number(entry); const st = Number(structuralStop); const fr = Number(feeRoundTripRate);
  if (!Number.isFinite(e) || !Number.isFinite(st) || !(st > 0) || !(st < e)) return 0;
  const fees = Number.isFinite(fr) && fr > 0 ? e * fr : 0; // the round trip, valued at the entry (monotone and conservative)
  return (e - st + fees) * Number(TARGET_MIN_REWARD_RISK) + fees;
}
// one full 20-bar range above the entry — the projection MICRO_BITE has carried since PUBLISH-FIX-85, for the setups that lack one
export function derivedProjection(ind, entry) {
  if (!ind) return null;
  try {
    const h20 = d(ind.h20); const l20 = d(ind.l20);
    if (!M.isPositive(h20) || !M.isPositive(l20) || !M.lt(l20, h20)) return null;
    return M.add(d(entry), M.sub(h20, l20));
  } catch { return null; }
}
// A setup whose own target is not at least that distance above the entry (the price already ran past it, or it never reached the
// fee-inclusive floor) has an EXHAUSTED scenario: the setup's own projection is used when it carries one, else the derived
// 20-bar-range projection; otherwise the raw target stands and sizing refuses it with its reasons, as before.
export function scenarioTarget(frozen, bars, entry, referenceTs, ind = null, feeRoundTripRate = '0') {
  let raw = frozen.scenarioRaw; if (raw === null || raw === undefined) return { target: null, cappedBy: null };
  const minAbove = minTargetDistance(entry, frozen.structuralStop, feeRoundTripRate);
  const projected = frozen.scenarioProjected ?? derivedProjection(ind, entry);
  if (projected !== null && Number(raw) <= Number(entry) + minAbove && M.gt(projected, raw)) raw = projected;
  const res = nearestResistanceAbove(bars, Number(entry), { referenceTs, minAbove });
  if (res && M.lt(d(res.price), raw)) return { target: d(res.price), cappedBy: { price: d(res.price), periodStartTs: res.periodStartTs } };
  return { target: raw, cappedBy: null };
}
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
export function evaluateSetup({ setupId, frozen, ind, fast, bars, entry, decisionTs, event = null, ablate = null, learned = null, feeRoundTripRate = '0' }) {
  if (!SETUP_EVALUATORS.includes(setupId)) throw new Error(`unknown setup ${setupId}`);
  if (ablate && ablate.setupId === setupId) { const allowed = ABLATABLE_CLAUSES[setupId] ?? []; const bad = (ablate.clauses ?? []).filter((id) => !allowed.includes(id)); if (bad.length) throw new Error(`clauses ${bad.join(',')} are not ablatable for ${setupId}`); }
  const structural = structuralClauses(setupId, frozen, ind, fast, { decisionTs, event, learned }); const quick = fastClauses(setupId, frozen, fast, learned); const all = [...structural, ...quick];
  let ablated = []; if (ablate && ablate.setupId === setupId) ablated = all.filter((x) => ablate.clauses.includes(x.id)).map((x) => ({ ...x, ablated: true }));
  const clauses = ablated.length ? all.filter((x) => !ablate.clauses.includes(x.id)) : all;
  const needsData = clauses.filter((x) => x.value === null && !x.ok).map((x) => x.id); const refused = clauses.filter((x) => !x.ok).map((x) => x.id);
  const t = scenarioTarget(frozen, bars, entry, frozen.referenceTs, ind, feeRoundTripRate); const stopOk = M.isPositive(frozen.structuralStop) && M.lt(frozen.structuralStop, entry);
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
// PUBLISH-FIX-83 (full review item 16): a coin oscillating around its level (ZAMA: 1,172 crossings and 1,172 resets in a day) made every
// re-cross a hypothesis lock, a decision record and a projection write. After a look ends in a refusal (NO_TRADE / NEEDS_DATA /
// ENTRY_REFUSED / EXPIRED) the next crossing needs RECROSS_MIN_MS to have passed — the thesis that was just refused is not a new
// thesis 3 seconds later. A reset before any decision, a filled entry (its own cooldown) and a second-look re-arm are untouched.
export const RECROSS_MIN_MS = 30_000;
export function createEpisodeTracker({ assetId, setupId, cooldownMs = REFERENCE.cooldownMs, recrossMinMs = RECROSS_MIN_MS }) {
  let episode = null; let below = true; let cooldownUntil = 0; let counter = 0; let refusedAtTs = null; let heldRecross = false; const counters = { crossings: 0, resets: 0, expired: 0, cooldownRefusals: 0, rearms: 0, recrossRefusals: 0 };
  const REFUSAL_STATES = new Set(['NO_TRADE', 'NEEDS_DATA', 'ENTRY_REFUSED', 'EXPIRED']);
  return {
    observeMid(mid, level, receiptTs) { if (M.lt(mid, level)) { if (!below) counters.resets += 1; below = true; heldRecross = false; if (episode && episode.state === 'PENDING') { episode.state = 'RESET'; episode = null; } return { crossing: false }; } if (below && !episode) { if (receiptTs < cooldownUntil) { below = false; counters.cooldownRefusals += 1; return { crossing: false, refused: 'COOLDOWN', cooldownUntil }; } if (refusedAtTs !== null && receiptTs - refusedAtTs < recrossMinMs) { if (!heldRecross) { heldRecross = true; counters.recrossRefusals += 1; } /* counted once per held crossing (review finding) */ return { crossing: false, refused: 'RECROSS_TOO_SOON', recrossAfterTs: refusedAtTs + recrossMinMs }; } below = false; heldRecross = false; counter += 1; counters.crossings += 1; episode = { episodeId: `ep-${assetId}-${setupId}-${receiptTs}-${counter}`, triggerTs: receiptTs, level, state: 'PENDING' }; return { crossing: true, episode }; } return { crossing: false }; },
    current: () => episode, expire(now) { if (episode && episode.state === 'PENDING' && now - episode.triggerTs > REFERENCE.proposalExpiryMs) { episode.state = 'EXPIRED'; counters.expired += 1; refusedAtTs = Math.min(now, episode.triggerTs + REFERENCE.proposalExpiryMs); /* review finding: never a future clock */ const e = episode; episode = null; return e; } return null; },
    decide(state, nowTs = null) { if (episode) { episode.state = state; const e = episode; if (state !== 'PENDING') { episode = null; if (REFUSAL_STATES.has(state)) refusedAtTs = Number.isFinite(nowTs) ? nowTs : (e.decidedTs ?? e.triggerTs); } return e; } return null; },
    closed(now) { cooldownUntil = now + cooldownMs; below = true; episode = null; }, status: () => ({ assetId, setupId, below, cooldownUntil, episode, counters: { ...counters } }),
    // PUBLISH-FIX-79 (the second look): re-arm the tracker so the NEXT book at/above the level counts as a fresh crossing without the
    // mid having to fall below the level first. Nothing else changes: the cooldown, the confirmation, the lock and every gate apply
    // to the new episode exactly as to a natural crossing. Refused while an episode is pending.
    rearm() { if (episode) return false; below = true; refusedAtTs = null; counters.rearms += 1; return true; },
  };
}
