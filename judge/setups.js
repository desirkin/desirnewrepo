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
// setup geometry buffer: max(1 tick, 0.10 * ATR14) (the cost model's execution buffer is max(2 tick, 0.10 ATR) and lives in cost.js)
const setupBuffer = (atr, tick) => (M.gt(tick, M.mul('0.1', atr)) ? tick : M.mul('0.1', atr));
import { nearestResistanceAbove } from './features.js';

export const STRATEGY_VERSION = 'judge-strategy-paper-reference-1';
export const SETUPS = Object.freeze(['RANGE_IGNITION', 'ABSORPTION_RECLAIM', 'TREND_PULLBACK_CONTINUATION', 'CATALYST_TRANSMISSION']);
export const SETUP_INPUT_MODES = Object.freeze({ RANGE_IGNITION: ['MARKET_DIRECT', 'CASE_ENRICHED'], ABSORPTION_RECLAIM: ['MARKET_DIRECT', 'CASE_ENRICHED'], TREND_PULLBACK_CONTINUATION: ['MARKET_DIRECT', 'CASE_ENRICHED'], CATALYST_TRANSMISSION: ['CATALYST_CASE'] });
export const REFERENCE = Object.freeze({ persistenceBooks: 3, persistenceSpanMs: 2000, proposalExpiryMs: 10_000, cooldownMs: 60_000, maxDurationMs: 4 * 3_600_000, fi15Min: 0.2, rv60Ignition: 2.0, rv60Trend: 1.5, rv60Catalyst: 1.5, catalystKnownWithinMs: 600_000, caseMaxAgeMs: 300_000 });
const d = (x, scale = 8) => (typeof x === 'string' ? x : M.fromStatistic(x, scale));
const clause = (id, ok, value, threshold, unit, note = null) => ({ id, ok, value, threshold, unit, note });
const known = (x) => x && x.state === 'KNOWN';
// the frozen reference bundle: what may never move after T
export function freezeReferences({ setupId, ind, spec, fast, event = null, triggerTs }) {
  const tick = spec.priceIncrement; const atr = d(ind.atr14); const buffer = setupBuffer(atr, tick);
  const base = { setupId, strategyVersion: STRATEGY_VERSION, triggerTs, blockDigest: ind.blockDigest, referenceTs: ind.referenceTs, atr14: atr, tick, buffer };
  if (setupId === 'RANGE_IGNITION') { const h20 = d(ind.h20); const l20 = d(ind.l20); const trigger = M.add(h20, buffer); const stop = M.sub(d(ind.low5), buffer); const scenario = M.add(h20, M.sub(h20, l20)); return { ...base, h20, l20, envelope5: d(ind.envelope5), triggerLevel: trigger, structuralStop: stop, scenarioRaw: scenario, maxEntryLevel: M.add(h20, M.mul('0.75', atr)) }; }
  if (setupId === 'TREND_PULLBACK_CONTINUATION') { const p20h = d(ind.prior20High); const p20l = d(ind.prior20Low); const trigger = M.add(d(ind.last2High), tick); return { ...base, prior20High: p20h, prior20Low: p20l, last3Low: d(ind.last3Low), ema5: d(ind.ema5), ema20: d(ind.ema20), prior20Return: ind.prior20Return, prior20HighBarsFromEnd: ind.prior20HighBarsFromEnd, triggerLevel: trigger, structuralStop: M.sub(d(ind.last3Low), buffer), scenarioRaw: M.add(p20h, M.mul('0.5', M.sub(p20h, p20l))), maxEntryLevel: M.add(p20h, M.mul('0.75', atr)) }; }
  if (setupId === 'ABSORPTION_RECLAIM') { const trigger = M.add(fast.vwap60, tick); return { ...base, priorFi: fast.priorFi, priorMidChange: fast.priorMidChange, priorMedianDepth: fast.priorMedianDepth, priorDepthSamples: fast.priorDepthSamples, priorLow: fast.priorLow60, vwap60: fast.vwap60, triggerLevel: trigger, structuralStop: M.sub(fast.priorLow60, buffer), scenarioRaw: d(ind.h20), maxEntryLevel: null }; }
  if (setupId === 'CATALYST_TRANSMISSION') { if (!event) return null; const p0 = event.p0; const trigger = M.add(p0, M.mul('0.1', atr)); return { ...base, event: { eventId: event.eventId, knownAtTs: event.knownAtTs, taxonomy: event.taxonomy, caseId: event.caseId, analysisId: event.analysisId }, p0, preEventH20: d(ind.h20), preEventL20: d(ind.l20), preEventLow5: d(ind.low5), triggerLevel: trigger, structuralStop: M.sub(M.min(p0, d(ind.low5)), buffer), scenarioRaw: M.add(p0, M.sub(d(ind.h20), d(ind.l20))), maxEntryLevel: M.add(p0, M.mul('1', atr)) }; }
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
  if (setupId !== 'ABSORPTION_RECLAIM') { const min = setupId === 'RANGE_IGNITION' ? REFERENCE.rv60Ignition : setupId === 'TREND_PULLBACK_CONTINUATION' ? REFERENCE.rv60Trend : REFERENCE.rv60Catalyst; c.push(clause('RV60', known(fast.rv60) && fast.rv60.rv60 >= min, fast.rv60?.rv60 ?? null, min, 'RATIO', fast.rv60?.reason ?? null)); }
  else { c.push(clause('DEPTH_HOLDS_80PCT_OF_BASELINE', fast.depth10bps !== null && frozen.priorMedianDepth !== null && M.gte(fast.depth10bps, M.mul('0.8', frozen.priorMedianDepth)), fast.depth10bps, frozen.priorMedianDepth ? M.mul('0.8', frozen.priorMedianDepth) : null, 'QUOTE', 'current 10bps bid notional vs the SAME frozen median')); c.push(clause('FI15_FRESH_AT_D', known(fast.fi15) && fast.fi15.fi >= 0.2, fast.fi15?.fi ?? null, 0.2, 'FRACTION', 'may overlap prior data; not independent confirmation')); }
  c.push(clause('COVERAGE_60S', fast.coverage?.continuous === true && fast.coverage.startTs <= fast.decisionTs - 60_000, fast.coverage?.startTs ?? null, fast.decisionTs - 60_000, 'TS', '60s continuous trade coverage'));
  c.push(clause('BOOK_FRESH', fast.bookAgeMs !== null && fast.bookAgeMs <= 1000 && fast.crcVerified === true, fast.bookAgeMs, 1000, 'MS', 'CRC-verified book at most 1s old'));
  return c;
}
// the target scenario capped by a nearer confirmed resistance above the proposed entry (never an invented level)
export function scenarioTarget(frozen, bars, entry, referenceTs) { const raw = frozen.scenarioRaw; if (raw === null) return { target: null, cappedBy: null }; const res = nearestResistanceAbove(bars, Number(entry), { referenceTs }); if (res && M.lt(d(res.price), raw)) return { target: d(res.price), cappedBy: { price: d(res.price), periodStartTs: res.periodStartTs } }; return { target: raw, cappedBy: null }; }
// ablate (focused completion §5, MOMENTUM_ABLATION): an explicit research-only removal of NAMED entry clauses of ONE setup; the removed
// clauses are still measured and reported (`ablated`), they simply do not decide. Nothing else changes; PAPER / LIVE never pass it.
export const ABLATABLE_CLAUSES = Object.freeze({ RANGE_IGNITION: ['FI15', 'FI60_POSITIVE'] });
export function evaluateSetup({ setupId, frozen, ind, fast, bars, entry, decisionTs, event = null, ablate = null }) {
  if (!SETUPS.includes(setupId)) throw new Error(`unknown setup ${setupId}`);
  if (ablate && ablate.setupId === setupId) { const allowed = ABLATABLE_CLAUSES[setupId] ?? []; const bad = (ablate.clauses ?? []).filter((id) => !allowed.includes(id)); if (bad.length) throw new Error(`clauses ${bad.join(',')} are not ablatable for ${setupId}`); }
  const structural = structuralClauses(setupId, frozen, ind, fast, { decisionTs, event }); const quick = fastClauses(setupId, frozen, fast); const all = [...structural, ...quick];
  let ablated = []; if (ablate && ablate.setupId === setupId) ablated = all.filter((x) => ablate.clauses.includes(x.id)).map((x) => ({ ...x, ablated: true }));
  const clauses = ablated.length ? all.filter((x) => !ablate.clauses.includes(x.id)) : all;
  const needsData = clauses.filter((x) => x.value === null && !x.ok).map((x) => x.id); const refused = clauses.filter((x) => !x.ok).map((x) => x.id);
  const t = scenarioTarget(frozen, bars, entry, frozen.referenceTs); const stopOk = M.isPositive(frozen.structuralStop) && M.lt(frozen.structuralStop, entry);
  if (!stopOk) refused.push('STOP_GEOMETRY');
  const state = refused.length === 0 ? 'ELIGIBLE' : needsData.length && needsData.length === refused.length ? 'NEEDS_DATA' : 'REFUSED';
  return Object.freeze({ setupId, strategyVersion: STRATEGY_VERSION, state, clauses: ablated.length ? [...clauses, ...ablated] : clauses, ablated: ablated.map((x) => x.id), refused, needsData, invalidation: { structuralStop: frozen.structuralStop, kind: 'ABSOLUTE_PRICE_BELOW' }, scenario: { target: t.target, cappedBy: t.cappedBy, kind: 'SCENARIO_NOT_FORECAST' }, maxEntryLevel: frozen.maxEntryLevel, maxDurationMs: REFERENCE.maxDurationMs, hypothesisDigest: hypothesisDigest(frozen), calibrationState: 'UNVALIDATED_HYPOTHESIS' });
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
