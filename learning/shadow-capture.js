// FORWARD-SHADOW LANE — the capture law. Given the EXACT then-known inputs (completed candles with volume and
// trade-flow, optional depth, optional social/news context), one recipe and one decision clock, it freezes the
// opportunity and its predeclared variants — or refuses the whole opportunity as INELIGIBLE with the exact
// reason. It never fabricates a missing fact, never zero-fills, never accepts a candle that closed after (or
// became known after) the decision clock, and downgrades fidelity honestly when depth is absent.
import {
  SHADOW_CAPTURE_VERSION, LANE, AUTHORITY, PURPOSE,
  recipeError, captureError, opportunityIdOf, captureIdOf, canonicalDigest, deepFreeze, isPlainObject, isTs, isFiniteNum,
} from './shadow-contracts.js';

const MINUTE = 60_000;

// inputs: {
//   candles: [{ periodStartTs, periodEndTs, open, high, low, close, volumeBase, volumeQuote, closed, knownAtTs, tradeFlow? }],
//   depth:   { bids: [[p,q]..], asks: [[p,q]..], knownAtTs } | null,
//   social:  { ...knownAtTs } | null, news: { ...knownAtTs } | null,
// }
export function buildShadowCapture({ recipe, venue, assetId, decisionTs, inputs }) {
  const rerr = recipeError(recipe); if (rerr) throw new Error(`shadow capture: ${rerr}`);
  if (typeof venue !== 'string' || !venue.length || typeof assetId !== 'string' || !assetId.length) throw new Error('shadow capture: scope required');
  if (!isTs(decisionTs)) throw new Error('shadow capture: decision clock required');
  const opportunityId = opportunityIdOf({ venue, assetId, decisionTs, recipeVersion: recipe.recipeVersion });
  const refuse = (reason, detail) => deepFreeze({
    eligible: [], ineligible: [{ kind: 'INELIGIBLE_OPPORTUNITY', opportunityId, lane: LANE, venue, assetId, decisionTs, recipeVersion: recipe.recipeVersion, reason, detail: String(detail).slice(0, 300), authority: AUTHORITY, purpose: PURPOSE }],
  });

  const candles = inputs?.candles;
  if (!Array.isArray(candles) || candles.length === 0) return refuse('REQUIRED_INPUT_MISSING', 'no candles supplied');
  // completed-window law: exactly the declared window of CLOSED, contiguous 1m candles, all fully known at D
  if (candles.length < recipe.candleWindowMin) return refuse('CANDLE_WINDOW_INCOMPLETE', `${candles.length}/${recipe.candleWindowMin} candles`);
  const window = candles.slice(-recipe.candleWindowMin);
  for (let i = 0; i < window.length; i += 1) {
    const c = window[i];
    if (!isPlainObject(c) || !isTs(c.periodStartTs) || !isTs(c.periodEndTs)) return refuse('CANDLE_WINDOW_INCOMPLETE', `candle ${i} malformed`);
    if (c.closed !== true) return refuse('CANDLE_NOT_CLOSED', `candle ending ${c.periodEndTs} is not a completed candle`);
    if (c.periodEndTs > decisionTs) return refuse('FUTURE_KNOWN_INPUT', `candle ends ${c.periodEndTs} after the decision clock ${decisionTs}`);
    if (!isTs(c.knownAtTs) || c.knownAtTs > decisionTs) return refuse('FUTURE_KNOWN_INPUT', `candle known at ${c.knownAtTs} after the decision clock`);
    if (i > 0 && c.periodStartTs !== window[i - 1].periodEndTs) return refuse('NON_CONTIGUOUS_WINDOW', `gap before candle starting ${c.periodStartTs}`);
    for (const f of ['open', 'high', 'low', 'close']) if (!isFiniteNum(c[f]) || c[f] <= 0) return refuse('CANDLE_WINDOW_INCOMPLETE', `candle ${i} ${f} malformed`);
    if (recipe.requiredInputs.includes('VOLUME') && (!isFiniteNum(c.volumeBase) || !isFiniteNum(c.volumeQuote))) return refuse('VOLUME_MISSING', `candle ending ${c.periodEndTs} carries no volume — a required fact is never zero-filled`);
    if (recipe.requiredInputs.includes('TRADE_FLOW') && !isFiniteNum(c.tradeFlow)) return refuse('TRADE_FLOW_MISSING', `candle ending ${c.periodEndTs} carries no trade-flow`);
  }
  const last = window[window.length - 1];
  if (decisionTs - last.periodEndTs > recipe.maxInputAgeMs) return refuse('REQUIRED_INPUT_STALE', `last completed candle ended ${decisionTs - last.periodEndTs}ms before the decision (max ${recipe.maxInputAgeMs}ms)`);

  // depth is OPTIONAL unless the recipe requires it; its absence is an honest fidelity DOWNGRADE, never a guess
  const depth = inputs?.depth ?? null;
  if (recipe.requiredInputs.includes('DEPTH_SNAPSHOT') && !depth) return refuse('REQUIRED_INPUT_MISSING', 'the recipe requires a depth snapshot');
  if (depth && (!isTs(depth.knownAtTs) || depth.knownAtTs > decisionTs)) return refuse('FUTURE_KNOWN_INPUT', 'depth known after the decision clock');
  const inputFidelity = depth ? 'DEPTH_SUPPORTED' : 'CANDLE_ONLY';
  // social/news are CONTEXTUAL unless declared required; when required, missing => INELIGIBLE (never a zero)
  for (const [kind, value] of [['SOCIAL_CONTEXT', inputs?.social ?? null], ['NEWS_CONTEXT', inputs?.news ?? null]]) {
    if (recipe.requiredInputs.includes(kind) && !value) return refuse('REQUIRED_INPUT_MISSING', `the recipe requires ${kind}`);
    if (value && (!isTs(value.knownAtTs) || value.knownAtTs > decisionTs)) return refuse('FUTURE_KNOWN_INPUT', `${kind} known after the decision clock`);
  }

  // freeze: digest over the exact inputs, units, knownAt clocks, versions, decision clock and window
  const frozenInputs = { window, depth, social: inputs?.social ?? null, news: inputs?.news ?? null };
  const inputDigest = canonicalDigest({ lane: LANE, venue, assetId, decisionTs, recipeVersion: recipe.recipeVersion, costPolicyVersion: recipe.costPolicy.costPolicyVersion, frozenInputs });
  const inputKnownAt = { lastCandle: last.knownAtTs, ...(depth ? { depth: depth.knownAtTs } : {}), ...(inputs?.social ? { social: inputs.social.knownAtTs } : {}), ...(inputs?.news ? { news: inputs.news.knownAtTs } : {}) };
  const inputUnits = { price: 'QUOTE_PER_BASE', volumeBase: 'BASE', volumeQuote: 'QUOTE', tradeFlow: 'SIGNED_FRACTION', candlePeriodMs: MINUTE };
  const frozenFacts = { lastClose: last.close, lastVolumeBase: last.volumeBase ?? null, lastVolumeQuote: last.volumeQuote ?? null, lastTradeFlow: last.tradeFlow ?? null, windowHigh: Math.max(...window.map((c) => c.high)), windowLow: Math.min(...window.map((c) => c.low)) };

  const eligible = recipe.variants.map((variant) => {
    const record = {
      captureVersion: SHADOW_CAPTURE_VERSION,
      captureId: captureIdOf({ opportunityId, variantId: variant.variantId }),
      opportunityId, variantId: variant.variantId, groupId: opportunityId, lane: LANE,
      venue, assetId, decisionTs,
      recipeVersion: recipe.recipeVersion, costPolicyVersion: recipe.costPolicy.costPolicyVersion,
      inputDigest,
      inputWindow: { startTs: window[0].periodStartTs, endTs: last.periodEndTs, candleCount: window.length },
      inputFidelity, inputUnits, inputKnownAt,
      variant: { ...variant },
      frozenFacts,
      authority: AUTHORITY, purpose: PURPOSE,
    };
    const err = captureError(record); if (err) throw new Error(`shadow capture: built an invalid record (${err})`);
    return deepFreeze(record);
  });
  return deepFreeze({ eligible, ineligible: [] });
}
