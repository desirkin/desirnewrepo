// JUDGE — cost-aware admission arithmetic (ticket §6.1-6.3): ONE size-specific model, exact decimals, no omitted or
// double-counted cost. Walk asks for buying and bids for selling at the candidate ORDER SIZE with the instrument's
// increments and minima and the fee contract's scope. The admission bound is the PERMITTED-LIMIT acquisition (worst
// consumed ask + max(2 tick, 0.10 ATR), capped by the setup's frozen maximum entry level), never today's cheaper average.
// The target / stop scenarios are SHIFTED_BOOK_STRESS: every current bid shifted by scenarioMid / currentMid, rounded down
// to tick, HALF of each level retained, walked for the net owned base; an unpriceable residual makes the size ineligible.
// Spread and slippage are already inside the walked cash flows (attributed for display, never deducted twice).
import * as M from '../execution/money.js';
import { worstFeeBound, feesForExecutions, chargeFor } from '../execution/fees.js';
import { bookFacts } from './features.js';

export const COST_MODEL_VERSION = 'judge-cost-paper-reference-1';
export const REWARD_RISK_MIN = '1.5'; export const REFERENCE_HAIRCUT = '0.5'; export const HAIRCUTS = Object.freeze(['1', '0.5', '0.25']);
export const EXPECTANCY_STATE = 'UNCALIBRATED';
const max = (...xs) => xs.reduce((a, b) => M.max(a, b));
export const bufferOf = (atr14, tick) => max(M.mul('2', tick), M.mul('0.1', atr14));
// walk one side for base quantity q (asks: buy up to `cap`; bids: sell); `haircut` retains that fraction of each level
export function walkSide(levels, side, q, { cap = null, haircut = '1', shift = null, tick = null } = {}) {
  const fills = []; let remaining = q; let last = null;
  for (const [rawPrice, rawQty] of levels) { if (M.isZero(remaining)) break; let price = rawPrice; if (shift !== null) { price = M.mul(rawPrice, shift); price = tick ? M.roundToStep(price, tick, side === 'bids' ? 'FLOOR' : 'CEIL') : price; } if (cap !== null && (side === 'asks' ? M.gt(price, cap) : M.lt(price, cap))) break; const avail = M.mul(rawQty, haircut); if (M.isZero(avail)) continue; const take = M.min(avail, remaining); fills.push({ price, base: take, quote: M.mul(price, take) }); remaining = M.sub(remaining, take); last = price; }
  const base = M.sum(fills.map((f) => f.base)); const quote = M.sum(fills.map((f) => f.quote));
  return { fills, base, quote, remaining, exhausted: !M.isZero(remaining), worstPrice: last, avgPrice: M.isZero(base) ? null : M.div(quote, base, 8, side === 'asks' ? 'UP' : 'DOWN'), levels: fills.length };
}
export const stopStressMid = ({ stop, atr14, spread, tick }) => M.sub(stop, max(M.mul('0.5', atr14), M.mul('2', spread), M.mul('2', tick)));
// sale proceeds after fees at a scenario mid under the shifted-book stress (label carried in the result)
export function scenarioExit({ snapshot, q, scenarioMid, spec, fee, haircut = REFERENCE_HAIRCUT }) {
  const f = bookFacts(snapshot); if (!f) return { status: 'REFUSED', reason: 'NO_TWO_SIDED_BOOK' };
  const shift = M.div(scenarioMid, f.mid, 12, 'DOWN'); const w = walkSide(snapshot.bids, 'bids', q, { haircut, shift, tick: spec.priceIncrement });
  if (w.exhausted) return { status: 'REFUSED', reason: 'SCENARIO_DEPTH_INSUFFICIENT', priced: w.base, unpriced: w.remaining, label: 'SHIFTED_BOOK_STRESS', haircut };
  const fees = feesForExecutions(fee, w.fills); const cashIn = M.sub(w.quote, fees.total);
  return { status: 'OK', label: 'SHIFTED_BOOK_STRESS', haircut, scenarioMid, shift, proceeds: w.quote, fees: fees.total, cashIn, levels: w.levels, avgPrice: w.avgPrice };
}
// conservative executable liquidation value of `q` on the CURRENT book (100% displayed depth, fees included)
export function liquidationValue({ snapshot, q, spec, fee }) { if (M.isZero(q)) return { status: 'OK', cashIn: '0', proceeds: '0', fees: '0' }; const w = walkSide(snapshot.bids, 'bids', q, { haircut: '1' }); if (w.exhausted) return { status: 'UNKNOWN', reason: 'DEPTH_INSUFFICIENT', priced: w.base }; const fees = feesForExecutions(fee, w.fills); return { status: 'OK', cashIn: M.sub(w.quote, fees.total), proceeds: w.quote, fees: fees.total, avgPrice: w.avgPrice, worstPrice: w.worstPrice, snapshotDigest: snapshot.digest }; }
// ---- the full entry valuation at ONE size --------------------------------------------------------------------------------
export function evaluateEntry({ snapshot, q, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel = null, haircut = REFERENCE_HAIRCUT }) {
  const reasons = []; const f = bookFacts(snapshot); if (!f) return { status: 'REFUSED', reasons: ['NO_TWO_SIDED_BOOK'] };
  if (!M.isMultipleOf(q, spec.qtyIncrement) || M.lt(q, spec.orderMin)) return { status: 'REFUSED', reasons: ['SIZE_NOT_LEGAL'], q };
  const tick = spec.priceIncrement; const buffer = bufferOf(atr14, tick);
  const est = walkSide(snapshot.asks, 'asks', q, { haircut: '1' }); if (est.exhausted) return { status: 'REFUSED', reasons: ['ENTRY_DEPTH_INSUFFICIENT'], q, entryBookEstimate: { exhausted: true, priced: est.base } };
  let limit = M.roundToStep(M.add(est.worstPrice, buffer), tick, 'CEIL'); let capped = false;
  if (maxEntryLevel !== null) { const capLevel = M.roundToStep(maxEntryLevel, tick, 'FLOOR'); if (M.gt(limit, capLevel)) { limit = capLevel; capped = true; } }
  const atLimit = walkSide(snapshot.asks, 'asks', q, { haircut: '1', cap: limit }); if (atLimit.exhausted) return { status: 'REFUSED', reasons: ['LIMIT_CAP_INSUFFICIENT_DEPTH'], q, entryLimitPrice: limit, capped, priced: atLimit.base };
  if (spec.costMin && M.lt(M.mul(q, limit), spec.costMin)) return { status: 'REFUSED', reasons: ['BELOW_MIN_NOTIONAL'], q };
  const notionalBound = M.mul(q, limit); const feeBound = worstFeeBound(fee, notionalBound); if (!feeBound.ok) return { status: 'REFUSED', reasons: [feeBound.reason], q, detail: feeBound.detail };
  const entryCashOut = M.add(notionalBound, feeBound.fee); const estFee = feesForExecutions(fee, est.fills).total; const entryBookEstimate = { avgPrice: est.avgPrice, worstAsk: est.worstPrice, notional: est.quote, fee: estFee, cashOut: M.add(est.quote, estFee), levels: est.levels };
  const netBase = fee.currency === 'BASE' ? M.roundToStep(M.sub(q, M.mul(q, fee.rate)), spec.qtyIncrement, 'DOWN') : q;
  const target = scenarioExit({ snapshot, q: netBase, scenarioMid: targetPrice, spec, fee, haircut }); if (target.status !== 'OK') return { status: 'REFUSED', reasons: [target.reason], q, entryCashOut, entryLimitPrice: limit };
  const scenarioNetProfit = M.sub(target.cashIn, entryCashOut); const executionUncertaintyBuffer = M.mul(q, buffer); const bufferedScenarioNetProfit = M.sub(scenarioNetProfit, executionUncertaintyBuffer);
  const stressMid = stopStressMid({ stop: structuralStop, atr14, spread: f.spread, tick }); if (!M.isPositive(stressMid)) return { status: 'REFUSED', reasons: ['STOP_STRESS_NONPOSITIVE'], q };
  const stress = scenarioExit({ snapshot, q: netBase, scenarioMid: stressMid, spec, fee, haircut }); if (stress.status !== 'OK') return { status: 'REFUSED', reasons: ['STRESS_DEPTH_INSUFFICIENT'], q, entryCashOut, entryLimitPrice: limit };
  const scenarioStressedLoss = M.sub(entryCashOut, stress.cashIn); const ratio = M.isPositive(scenarioStressedLoss) ? M.div(bufferedScenarioNetProfit, scenarioStressedLoss, 6, 'DOWN') : null;
  if (!M.isPositive(bufferedScenarioNetProfit)) reasons.push(M.isZero(bufferedScenarioNetProfit) ? 'BUFFERED_REWARD_ZERO' : 'BUFFERED_REWARD_NEGATIVE');
  if (ratio === null) reasons.push('STRESSED_LOSS_NONPOSITIVE_UNKNOWN_RATIO'); else if (M.lt(ratio, REWARD_RISK_MIN)) reasons.push('REWARD_RISK_BELOW_1_5');
  const sensitivities = {}; for (const h of HAIRCUTS) { const s = scenarioExit({ snapshot, q: netBase, scenarioMid: targetPrice, spec, fee, haircut: h }); sensitivities[`depth_${Math.round(Number(h) * 100)}pct`] = s.status === 'OK' ? { cashIn: s.cashIn, net: M.sub(s.cashIn, entryCashOut) } : { cashIn: null, reason: s.reason }; }
  const spreadAttribution = M.mul(q, f.spread); const slippageAttribution = M.sub(est.quote, M.mul(q, f.bestAsk));
  return Object.freeze({ status: reasons.length ? 'REFUSED' : 'OK', reasons, costModelVersion: COST_MODEL_VERSION, q, netBase, entryLimitPrice: limit, capped, maxEntryLevel, entryCashOut, entryNotionalBound: notionalBound, entryFeeBound: feeBound.fee, feeBasis: feeBound.basis, entryBookEstimate, actualEntryCashOut: null, scenarioExitCashIn: target.cashIn, scenarioNetProfit, executionUncertaintyBuffer, bufferedScenarioNetProfit, scenarioStressedLoss, stressMid, rewardRiskRatio: ratio, sensitivities, attribution: { spread: spreadAttribution, slippage: slippageAttribution, note: 'already inside walked cash flows; displayed, never deducted twice' }, expectancyState: EXPECTANCY_STATE, feeDigest: fee.feeDigest, specDigest: spec.specDigest, snapshotDigest: snapshot.digest, units: { money: 'USD', base: spec.canonicalCoin } });
}
// ---- bounded lot search: the largest legal q passing every constraint; boundary candidates validated explicitly ------------------
export function sizeSearch({ snapshot, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel = null, cashAvailable, riskBudget, maxIterations = 40 }) {
  const f = bookFacts(snapshot); if (!f) return { status: 'NO_TRADE_SIZE', reason: 'NO_TWO_SIDED_BOOK' };
  const lot = spec.qtyIncrement; const passes = (q) => { const e = evaluateEntry({ snapshot, q, spec, fee, atr14, structuralStop, targetPrice, maxEntryLevel }); if (e.status !== 'OK') return { ok: false, e, why: e.reasons }; const why = []; if (M.gt(e.entryCashOut, cashAvailable)) why.push('CASH'); if (M.gt(e.scenarioStressedLoss, riskBudget)) why.push('RISK_BUDGET'); return { ok: why.length === 0, e, why }; };
  let lo = spec.orderMin; const cap = M.roundToStep(M.div(cashAvailable, f.bestAsk, 18, 'DOWN'), lot, 'DOWN'); if (M.lt(cap, lo)) return { status: 'NO_TRADE_SIZE', reason: 'CASH_BELOW_MINIMUM_LOT', binding: ['CASH'] };
  const first = passes(lo); if (!first.ok) return { status: 'NO_TRADE_SIZE', reason: 'MINIMUM_LOT_FAILS', binding: first.why, evaluation: first.e };
  let hi = cap; let best = { q: lo, e: first.e }; let iterations = 0; let hiPass = passes(hi); if (hiPass.ok) best = { q: hi, e: hiPass.e }; else { while (iterations < maxIterations && M.gt(M.sub(hi, lo), lot)) { iterations += 1; const mid = M.roundToStep(M.div(M.add(lo, hi), '2', 18, 'DOWN'), lot, 'DOWN'); const r = passes(mid); if (r.ok) { lo = mid; best = { q: mid, e: r.e }; } else hi = mid; } }
  // rounded / minimum fees break monotonicity: validate the boundary candidates around the found size explicitly
  const bindingSet = new Set(); for (const cand of [M.add(best.q, lot), M.add(best.q, M.mul(lot, '2'))]) { if (M.gt(cand, cap)) continue; const r = passes(cand); if (r.ok) best = { q: cand, e: r.e }; else for (const w of r.why) bindingSet.add(w); }
  return { status: 'OK', q: best.q, evaluation: best.e, iterations, binding: [...bindingSet], cap, cashAvailable, riskBudget };
}
export { chargeFor };
