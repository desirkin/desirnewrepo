// MARKET LAB — FIXED RECIPES (§7, §8). Every calculation here is a DESCRIPTOR with evidence, never a trade gate:
// no learned cutoff, no tuning against outcomes, no composite edge score, no invented probability. Each recipe has an
// immutable id/version, exact input kinds, formula, window, units, required/optional leaves and machine-readable
// nullability. Absent support yields null with a closed reason — never zero, never an extrapolation.
import { deepFreeze, isFiniteNum, isTs, round } from './contracts.js';
import { inWindow } from './time.js';

export const RECIPE_SET_VERSION = 'market-lab-recipes-1';
const R = (id, o) => [id, deepFreeze({ recipeId: id, version: 1, ...o })];
export const RECIPES = deepFreeze(Object.fromEntries([
  R('window_ohlcv', { family: 'SPOT_PRICE_CHART', inputs: ['TRADE'], formula: 'trades in (start,end] by event time: open/high/low/close/volumeBase/quoteNotional/count/vwap=sum(p*q)/sum(q)/range/closeLocation=(close-low)/(high-low)/logReturn=ln(close/open)', window: '15s|60s|300s|900s|3600s', units: 'QUOTE', required: ['sourceEventTs', 'payload.price', 'payload.qty'], optional: [], nullable: { ohlc: true, vwap: true, volume: false, count: false }, limitations: ['a gap with unknown trades has unknown totals; complete no-trade intervals carry zero count with null prices'] }),
  R('signed_notional', { family: 'SPOT_FLOW', inputs: ['TRADE'], formula: 'B=sum(quote notional of known BUY taker trades), S=sum(known SELL); signed=B-S; imbalance=(B-S)/(B+S) over the KNOWN-side subset; knownSideFraction=(B+S)/total', window: 'same as window_ohlcv', units: 'QUOTE', required: ['payload.takerSide', 'payload.quoteNotional'], optional: [], nullable: { signed: true, imbalance: true }, limitations: ['unknown sides reduce support and never join buys or sells'] }),
  R('trade_size_stats', { family: 'SPOT_FLOW', inputs: ['TRADE'], formula: 'nearest-rank order statistics of trade base size (p50, p90); interarrival mean/median in ms with clock precision', window: 'same as window_ohlcv', units: 'BASE', required: ['payload.qty', 'sourceEventTs'], optional: [], nullable: { median: true, p90: true, interarrival: true }, limitations: ['provider clock precision bounds interarrival timing'] }),
  R('spread_bps', { family: 'DISPLAYED_LIQUIDITY', inputs: ['BOOK_SNAPSHOT'], formula: 'mid=(bid+ask)/2; spreadBps=10000*(ask-bid)/mid', window: 'endpoint at or before boundary', units: 'BPS', required: ['payload.bids[0]', 'payload.asks[0]'], optional: [], nullable: { value: true }, limitations: ['displayed liquidity only'] }),
  R('depth_bands', { family: 'DISPLAYED_LIQUIDITY', inputs: ['BOOK_SNAPSHOT'], formula: 'per side: sum(qty) and sum(price*qty) for levels within 5/10/25 bps of mid; a retained book ending inside a band proves a lower bound only', window: 'endpoint', units: 'QUOTE', required: ['payload.bids', 'payload.asks'], optional: [], nullable: { band: true }, limitations: ['lowerBoundOnly flag when the retained depth ends inside the band'] }),
  R('microprice', { family: 'DISPLAYED_LIQUIDITY', inputs: ['BOOK_SNAPSHOT'], formula: 'microprice=(ask*bidQty+bid*askQty)/(bidQty+askQty) with top-of-book quantities', window: 'endpoint', units: 'QUOTE', required: ['payload.bids[0]', 'payload.asks[0]'], optional: [], nullable: { value: true }, limitations: [] }),
  R('book_walk', { family: 'DISPLAYED_LIQUIDITY', inputs: ['BOOK_SNAPSHOT'], formula: 'walk one side in price order consuming levels until requested quote notional or base quantity is filled; report consumed levels, filled, residual, average and worst price; PARTIAL never extrapolated', window: 'endpoint', units: 'QUOTE', required: ['payload.bids', 'payload.asks'], optional: [], nullable: { averagePrice: true }, limitations: ['hypothetical; pre-fee; displayed depth is not guaranteed'] }),
  R('round_trip_loss', { family: 'DISPLAYED_LIQUIDITY', inputs: ['BOOK_SNAPSHOT'], formula: 'H03: buy quantity q with quote N walking asks; only if FULL, sell the SAME q walking bids; lossBps=10000*(N-saleProceeds)/N; either side partial => null with partial amounts disclosed', window: 'endpoint', units: 'BPS', required: ['payload.bids', 'payload.asks'], optional: [], nullable: { lossBps: true }, limitations: ['pre-fee; no position-size advice; stress haircuts are scenarios, not probabilities'] }),
  R('pressure_response_efficiency', { family: 'SPOT_FLOW', inputs: ['TRADE', 'BOOK_SNAPSHOT'], formula: 'H01: for two adjacent complete 60s windows S=buy-sell quote notional (known sides), R=10000*(endMid/startMid-1) from lawful fresh book endpoints; efficiency=sign(S)*R/(|S|/1e6) bps per million QUOTE; S=0 => null', window: '60s x2', units: 'BPS', required: ['signed_notional', 'spread_bps endpoints'], optional: [], nullable: { efficiency: true }, limitations: ['unknown side or gapped coverage prevents a complete signed-pressure claim; no threshold declares a cause'] }),
  R('peer_relative_move', { family: 'CROSS_VENUE', inputs: ['TRADE', 'CANDLE'], formula: 'H02: target return minus MEDIAN of >=5 admissible peer returns at identical endpoints in the same quote/venue cohort (target excluded); MAD, n, positive count, exclusions', window: 'same endpoints', units: 'BPS', required: ['peer returns'], optional: [], nullable: { residual: true }, limitations: ['no hindsight sector selection; no zero-filled missing peer; observed sequences are not lead/lag proof'] }),
  R('venue_mid_dispersion', { family: 'CROSS_VENUE', inputs: ['BOOK_SNAPSHOT'], formula: 'median of same-quote venue mids; dispersionBps=10000*(max-min)/median; a quote conversion requires a sourced rate observation', window: 'endpoint', units: 'BPS', required: ['mids'], optional: [], nullable: { dispersionBps: true }, limitations: ['fiat names alone never convert'] }),
  R('basis_bps', { family: 'DERIVATIVES_FUNDING_OI', inputs: ['DERIVATIVE_TICK'], formula: 'basisBps=10000*(mark/index-1)', window: 'point', units: 'BPS', required: ['payload.markPrice', 'payload.indexPrice'], optional: [], nullable: { value: true }, limitations: [] }),
  R('oi_change', { family: 'DERIVATIVES_FUNDING_OI', inputs: ['DERIVATIVE_TICK'], formula: 'same-specification OI absolute and percent change between two ticks; incomparable specs/units reject', window: 'two points', units: 'CONTRACTS', required: ['payload.openInterest', 'payload.openInterestUnit', 'subject.specificationId'], optional: [], nullable: { absolute: true, percent: true }, limitations: ['positive OI delta is not proof of new longs, shorts or leverage'] }),
  R('funding_native', { family: 'DERIVATIVES_FUNDING_OI', inputs: ['DERIVATIVE_TICK'], formula: 'native funding value with interval, unit and payer convention preserved; no silent annualization', window: 'point', units: 'NATIVE', required: ['payload.fundingRateNative', 'payload.fundingUnit', 'payload.fundingIntervalMs'], optional: ['payload.fundingRelative'], nullable: { value: true }, limitations: ['absolute native amounts are not percentages'] }),
  R('atm_iv_term', { family: 'OPTIONS_TERM_SKEW', inputs: ['OPTION_TICK'], formula: 'per expiry: ATM = min abs(ln(strike/index)) (instrument-id tie-break); mark IV fraction', window: 'point', units: 'FRACTION', required: ['payload.markIv', 'payload.strike', 'payload.underlyingPrice'], optional: [], nullable: { atmIv: true }, limitations: ['same source, expiry, underlying and settlement convention required'] }),
  R('risk_reversal_25d', { family: 'OPTIONS_TERM_SKEW', inputs: ['OPTION_TICK'], formula: 'nearest observed +0.25 call delta and -0.25 put delta per expiry; RR=callIV-putIV; butterfly=(callIV+putIV)/2-ATM_IV; actual deltas and distances exposed', window: 'point', units: 'FRACTION', required: ['payload.delta', 'payload.markIv'], optional: [], nullable: { riskReversal: true, butterfly: true }, limitations: ['no interpolation; no homemade pricing model'] }),
  R('put_call_oi_ratio', { family: 'OPTIONS_TERM_SKEW', inputs: ['OPTION_TICK'], formula: 'sum(put OI)/sum(call OI) and volumes under a complete admitted same-scope census with positive denominators', window: 'point', units: 'RATIO', required: ['payload.openInterest'], optional: ['payload.volume24h'], nullable: { value: true }, limitations: ['partial-chain totals are never market totals; no dealer gamma inference'] }),
  R('supply_ratios', { family: 'SUPPLY_UNLOCKS', inputs: ['ASSET_REFERENCE'], formula: 'circulating/total, circulating/max, FDV/marketCap, volume24h/marketCap; unknown max => only its ratio null', window: 'point', units: 'FRACTION', required: ['payload.circulatingSupply'], optional: ['payload.maxSupply'], nullable: { all: true }, limitations: ['provider-reported cap is not overwritten with another venue price'] }),
  R('exchange_net_flow', { family: 'ONCHAIN_ENTITY_FLOW', inputs: ['ONCHAIN_METRIC'], formula: 'net=inflow-outflow ONLY for matching provider, entity set, chain, asset, unit, window and methodology', window: 'matched', units: 'NATIVE', required: ['inflow', 'outflow'], optional: [], nullable: { net: true }, limitations: ['transfers into exchange labels do not prove sales; wrapper transfers are not pooled'] }),
  R('indicators', { family: 'SPOT_PRICE_CHART', inputs: ['CANDLE'], formula: 'closed bars only: SMA/EMA 5/20/60 (EMA seeded by SMA of its length), realized volatility of log returns 5/20/60, ATR14 and RSI14 with Wilder smoothing seeded by arithmetic averages (RSI: no gains and no losses => FLAT null; no losses => 100; no gains => 0), MACD 12/26/9, Bollinger 20 with population stdev, prior 20/60-bar high/low; warmup is null never zero', window: 'bars', units: 'QUOTE', required: ['closed bars'], optional: [], nullable: { warmup: true }, limitations: ['candle typical-price VWAP is never trade VWAP'] }),
  R('macro_surprise', { family: 'MACRO_RELEASES', inputs: ['ECONOMIC_EVENT'], formula: 'actual minus pre-release forecast in compatible units (percentage points for percent units) ONLY when the forecast was known BEFORE release; revised previous is never the first-release prior', window: 'event', units: 'PERCENTAGE_POINTS', required: ['payload.actualValue', 'payload.forecastValue', 'payload.forecastKnownAtTs', 'payload.scheduledTs'], optional: [], nullable: { surprise: true }, limitations: ['forecast learned after release cannot establish a point-in-time surprise'] }),
  R('pearson_correlation', { family: 'CROSS_ASSET', inputs: ['CROSS_ASSET_BAR', 'CANDLE'], formula: 'Pearson r over >=30 paired closed returns of the same complete interval and synchronous labelled sessions; both variances must be positive', window: 'paired returns', units: 'RATIO', required: ['paired returns'], optional: [], nullable: { r: true }, limitations: ['descriptive, never causal; no forward-fill of a closed market as a fresh zero return'] }),
  R('relative_activity', { family: 'SPOT_PRICE_CHART', inputs: ['TRADE', 'CANDLE'], formula: 'current window volume / range divided by the median of the coin\'s own trailing complete windows of equal elapsed time', window: 'current vs trailing', units: 'RATIO', required: ['current', 'trailing>=3'], optional: [], nullable: { ratio: true }, limitations: ['equal elapsed time, not a full prior day; 24/7 UTC clock'] }),
  R('breakout_distance', { family: 'SPOT_PRICE_CHART', inputs: ['CANDLE'], formula: 'distance in bps from prior 20/60-bar high/low and from trade VWAP; touch / failed follow-through / return-to-range are temporal descriptions with explicit prior boundaries', window: 'bars', units: 'BPS', required: ['prior_range'], optional: [], nullable: { value: true }, limitations: ['no labelled support/resistance strength'] }),
  R('stablecoin_supply_change', { family: 'STABLECOIN_LIQUIDITY', inputs: ['STABLECOIN_METRIC'], formula: 'supply change between two matched (asset, chain, unit) observations; pegDeviationBps=10000*(price-1)', window: 'two points', units: 'NATIVE', required: ['matched pair'], optional: [], nullable: { change: true }, limitations: ['bridged balances never double counted; supply expansion is not proof it bought a token'] }),
  R('liquidation_notional_by_side', { family: 'LIQUIDATIONS', inputs: ['LIQUIDATION'], formula: 'sum of comparable-unit notional by liquidated position side within (start,end]; provider coverage decides whether zero is meaningful', window: 'window', units: 'USD', required: ['payload.notional', 'payload.notionalUnit'], optional: [], nullable: { totals: true }, limitations: ['heatmaps are estimates, never observed liquidations'] }),
  R('latest_observation', { family: 'NETWORK_ACTIVITY', inputs: ['ONCHAIN_METRIC', 'DEFI_METRIC', 'DEX_POOL', 'PROVIDER_STATUS'], formula: 'the latest admissible observation of one provider metric at or before the as-of, with its previous point and change, its period and its age', window: 'point', units: 'NATIVE', required: ['payload.value'], optional: ['previous'], nullable: { value: true, change: true }, limitations: ['provider definition and methodology preserved; no cross-provider pooling'] }),
  R('unlock_schedule', { family: 'SUPPLY_UNLOCKS', inputs: ['UNLOCK_EVENT'], formula: 'upcoming scheduled unlock events after the as-of sorted by scheduled time (<=16) with precision, amount, category, type, tracked flag and receipt clock; untracked allocations counted', window: 'future schedule (payload, not knowledge)', units: 'BASE', required: ['payload.scheduledTs'], optional: ['payload.amountUsd'], nullable: { amount: true }, limitations: ['unlocked, circulating and sold supply are three different facts'] }),
  R('macro_level', { family: 'MACRO_RELEASES', inputs: ['MACRO_OBSERVATION'], formula: 'latest non-missing observation of a series with its previous observation, change, vintage date and units from metadata', window: 'point', units: 'NATIVE', required: ['payload.value', 'payload.unit'], optional: ['payload.vintageDate'], nullable: { change: true }, limitations: ['date-only precision; release date is not receipt time'] }),
  R('cross_asset_return', { family: 'CROSS_ASSET', inputs: ['CROSS_ASSET_BAR'], formula: 'log return of the last closed bar of a labelled proxy instrument and its correlation with the target coin over paired closed bars (pearson_correlation)', window: 'bars', units: 'FRACTION', required: ['closed bars'], optional: [], nullable: { logReturn: true }, limitations: ['proxies are named as proxies; sessions are labelled; closed markets are not zero returns'] }),
  R('event_references', { family: 'OFFICIAL_SOCIAL_EVENTS', inputs: ['EVENT_REFERENCE'], formula: 'bounded list (<=32) of settled event references newest first with kind, provider, native ref, clocks, status and untrusted headline flag', window: 'as-of', units: 'COUNT', required: ['payload.nativeRef'], optional: ['payload.headline'], nullable: {}, limitations: ['references only; bodies never persisted'] }),
  R('provider_status', { family: 'INFRASTRUCTURE_STATUS', inputs: ['PROVIDER_STATUS', 'EVENT_REFERENCE'], formula: 'latest provider / venue door status per component and open infrastructure incidents touching the coin', window: 'as-of', units: 'COUNT', required: ['payload.status'], optional: [], nullable: {}, limitations: ['experimental infrastructure observations'] }),
  R('etf_daily_flow', { family: 'ETF_FLOWS', inputs: ['ETF_FLOW'], formula: 'reported daily aggregate flow and trailing sums with reporting period, estimate and revision preserved', window: 'days', units: 'USD', required: ['payload.flowUsd'], optional: [], nullable: { value: true }, limitations: ['daily flow cannot explain a minute move; creation/redemption is not intraday volume'] }),
]));

// ---- helpers ------------------------------------------------------------------------------------------------------
const sum = (a) => a.reduce((x, y) => x + y, 0);
export const nearestRank = (sortedAsc, p) => { if (!sortedAsc.length) return null; const k = Math.max(1, Math.ceil((p / 100) * sortedAsc.length)); return sortedAsc[k - 1]; };
export const median = (values) => { const s = [...values].filter(isFiniteNum).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const mad = (values) => { const m = median(values); if (m === null) return null; return median(values.map((v) => Math.abs(v - m))); };
export const populationStdev = (values) => { if (!values.length) return null; const m = sum(values) / values.length; return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / values.length); };
const support = (state, reasons = [], extra = {}) => ({ state, reasons, ...extra });

// ---- 7.1 trade windows ----------------------------------------------------------------------------------------------
export function tradeWindow(trades, { startTs, endTs, evictedUntilTs = null, coverageGap = false }) {
  const inside = trades.filter((t) => inWindow(t.sourceEventTs, startTs, endTs)).sort((a, b) => a.sourceEventTs - b.sourceEventTs || a.sequence - b.sequence);
  const unknownCoverage = coverageGap || (evictedUntilTs !== null && evictedUntilTs > startTs);
  const totalNotional = sum(inside.map((t) => t.payload.quoteNotional)); const qty = sum(inside.map((t) => t.payload.qty));
  const known = { BUY: 0, SELL: 0, UNKNOWN: 0 }; const counts = { BUY: 0, SELL: 0, UNKNOWN: 0 };
  for (const t of inside) { known[t.payload.takerSide] += t.payload.quoteNotional; counts[t.payload.takerSide] += 1; }
  const prices = inside.map((t) => t.payload.price); const sizes = inside.map((t) => t.payload.qty).sort((a, b) => a - b);
  const gaps = []; for (let i = 1; i < inside.length; i += 1) gaps.push(inside[i].sourceEventTs - inside[i - 1].sourceEventTs);
  const kn = known.BUY + known.SELL;
  const base = { recipeId: 'window_ohlcv', version: 1, startTs, endTs, windowMs: endTs - startTs, count: unknownCoverage ? null : inside.length, observedCount: inside.length, volumeBase: unknownCoverage ? null : round(qty), quoteNotional: unknownCoverage ? null : round(totalNotional), vwap: qty > 0 ? round(totalNotional / qty) : null, open: prices.length ? prices[0] : null, high: prices.length ? Math.max(...prices) : null, low: prices.length ? Math.min(...prices) : null, close: prices.length ? prices[prices.length - 1] : null };
  base.range = base.high !== null ? round(base.high - base.low) : null;
  base.closeLocation = base.high !== null && base.high > base.low ? round((base.close - base.low) / (base.high - base.low)) : null;
  base.logReturn = base.open !== null ? round(Math.log(base.close / base.open)) : null;
  base.support = support(unknownCoverage ? 'PARTIAL' : inside.length ? 'COMPLETE' : 'COMPLETE_NO_TRADES', unknownCoverage ? ['COVERAGE_GAP_INSIDE_WINDOW'] : []);
  const flow = { recipeId: 'signed_notional', version: 1, buyNotional: round(known.BUY), sellNotional: round(known.SELL), unknownNotional: round(known.UNKNOWN), buyCount: counts.BUY, sellCount: counts.SELL, unknownCount: counts.UNKNOWN, signedNotional: kn > 0 ? round(known.BUY - known.SELL) : null, knownSideImbalance: kn > 0 ? round((known.BUY - known.SELL) / kn) : null, knownSideFraction: totalNotional > 0 ? round(kn / totalNotional) : null, support: support(unknownCoverage ? 'PARTIAL' : kn === 0 ? 'NO_KNOWN_SIDE' : counts.UNKNOWN ? 'KNOWN_SUBSET' : 'COMPLETE', [...(unknownCoverage ? ['COVERAGE_GAP_INSIDE_WINDOW'] : []), ...(counts.UNKNOWN ? ['UNKNOWN_SIDES_EXCLUDED'] : [])]) };
  const stats = { recipeId: 'trade_size_stats', version: 1, sizeMedian: sizes.length ? nearestRank(sizes, 50) : null, sizeP90: sizes.length ? nearestRank(sizes, 90) : null, interarrivalMeanMs: gaps.length ? round(sum(gaps) / gaps.length, 3) : null, interarrivalMedianMs: gaps.length ? median(gaps) : null, clockPrecisionMs: inside.length ? (inside.every((t) => t.sourceEventTs % 1000 === 0) ? 1000 : 1) : null, support: support(gaps.length ? 'COMPLETE' : 'INSUFFICIENT') };
  return deepFreeze({ ...base, flow, stats });
}
export const adjacentChange = (prev, cur, key) => (prev && cur && isFiniteNum(prev[key]) && isFiniteNum(cur[key]) ? round(cur[key] - prev[key]) : null);

// ---- 7.2 displayed liquidity --------------------------------------------------------------------------------------------
const BANDS_BPS = Object.freeze([5, 10, 25]);
export function bookMetrics(book) {
  const bids = book.bids ?? []; const asks = book.asks ?? [];
  if (!bids.length || !asks.length) return deepFreeze({ recipeId: 'spread_bps', version: 1, mid: null, spreadBps: null, support: support('NO_TWO_SIDED_BOOK') });
  const bid = bids[0][0]; const ask = asks[0][0]; const mid = (bid + ask) / 2; const bq = bids[0][1]; const aq = asks[0][1];
  const bandOf = (levels, bps, side) => { const limit = side === 'bid' ? mid * (1 - bps / 1e4) : mid * (1 + bps / 1e4); let qty = 0; let notional = 0; let ended = true; for (const [p, q] of levels) { if (side === 'bid' ? p < limit : p > limit) { ended = false; break; } qty += q; notional += p * q; } return { qty: round(qty), notional: round(notional), lowerBoundOnly: ended }; };
  const bands = {};
  for (const bps of BANDS_BPS) { const b = bandOf(bids, bps, 'bid'); const a = bandOf(asks, bps, 'ask'); const tot = b.notional + a.notional; bands[`${bps}bps`] = { bid: b, ask: a, imbalance: tot > 0 ? round((b.notional - a.notional) / tot) : null }; }
  return deepFreeze({ recipeId: 'spread_bps', version: 1, mid: round(mid), spreadBps: round(1e4 * (ask - bid) / mid), bestBid: bid, bestAsk: ask, topBidQty: bq, topAskQty: aq, microprice: bq + aq > 0 ? round((ask * bq + bid * aq) / (bq + aq)) : null, bands, levelsRetained: { bids: bids.length, asks: asks.length }, support: support('COMPLETE', [], { attribution: 'AGGREGATE_L2_UNATTRIBUTED' }) });
}
export function walkBook(levels, { quoteNotional = null, baseQty = null }) {
  const requested = quoteNotional !== null ? { quoteNotional } : { baseQty };
  if (!Array.isArray(levels) || !levels.length || (quoteNotional === null && baseQty === null)) return deepFreeze({ recipeId: 'book_walk', version: 1, requested, consumedLevels: 0, filledBase: 0, filledQuote: 0, residualQuote: quoteNotional, residualBase: baseQty, averagePrice: null, worstPrice: null, coverage: 'NO_BOOK', hypothetical: true });
  let remQ = quoteNotional; let remB = baseQty; let fb = 0; let fq = 0; let consumed = 0; let worst = null;
  for (const [p, q] of levels) { if (q <= 0) continue; let take; if (quoteNotional !== null) { take = Math.min(q, remQ / p); } else take = Math.min(q, remB); if (take <= 0) break; fb += take; fq += take * p; consumed += 1; worst = p; if (quoteNotional !== null) remQ -= take * p; else remB -= take; if ((quoteNotional !== null && remQ <= 1e-9) || (baseQty !== null && remB <= 1e-12)) { remQ = quoteNotional !== null ? 0 : null; remB = baseQty !== null ? 0 : null; break; } }
  const full = quoteNotional !== null ? remQ <= 1e-9 : remB <= 1e-12;
  return deepFreeze({ recipeId: 'book_walk', version: 1, requested, consumedLevels: consumed, filledBase: round(fb), filledQuote: round(fq), residualQuote: quoteNotional !== null ? round(Math.max(0, remQ)) : null, residualBase: baseQty !== null ? round(Math.max(0, remB)) : null, averagePrice: fb > 0 ? round(fq / fb) : null, worstPrice: worst, coverage: full ? 'FULL' : 'PARTIAL', hypothetical: true, preFee: true });
}
export function roundTrip(book, N, { haircut = 1 } = {}) {
  const scale = (ls) => ls.map(([p, q]) => [p, q * haircut]);
  const buy = walkBook(scale(book.asks ?? []), { quoteNotional: N });
  if (buy.coverage !== 'FULL') return deepFreeze({ recipeId: 'round_trip_loss', version: 1, quoteNotional: N, haircut, buy, sell: null, saleProceeds: null, lossBps: null, spreadBps: bookMetrics(book).spreadBps, coverage: 'PARTIAL_BUY', preFee: true, hypothetical: true });
  const sell = walkBook(scale(book.bids ?? []), { baseQty: buy.filledBase });
  if (sell.coverage !== 'FULL') return deepFreeze({ recipeId: 'round_trip_loss', version: 1, quoteNotional: N, haircut, buy, sell, saleProceeds: null, lossBps: null, spreadBps: bookMetrics(book).spreadBps, coverage: 'PARTIAL_SELL', preFee: true, hypothetical: true });
  const proceeds = sell.filledQuote;
  return deepFreeze({ recipeId: 'round_trip_loss', version: 1, quoteNotional: N, haircut, buy, sell, saleProceeds: round(proceeds), lossBps: round(1e4 * (N - proceeds) / N), worstBuyPrice: buy.worstPrice, worstSellPrice: sell.worstPrice, spreadBps: bookMetrics(book).spreadBps, coverage: 'FULL', preFee: true, hypothetical: true });
}
export const haircutScenarios = (book, N) => deepFreeze([1, 0.5, 0.25].map((h) => ({ haircut: h, scenario: 'STRESS_NOT_PROBABILITY', ...roundTrip(book, N, { haircut: h }) })));

// ---- H01 pressure / response ---------------------------------------------------------------------------------------
export function pressureResponse({ signedNotional, startMid, endMid, spreadStart = null, spreadEnd = null, knownSideFraction = null, complete = true }) {
  if (!isFiniteNum(startMid) || !isFiniteNum(endMid) || startMid <= 0) return deepFreeze({ recipeId: 'pressure_response_efficiency', version: 1, responseBps: null, efficiencyBpsPerMillion: null, support: support('NO_BOOK_ENDPOINTS') });
  const R_ = 1e4 * (endMid / startMid - 1);
  const S = signedNotional; const eff = isFiniteNum(S) && S !== 0 ? Math.sign(S) * R_ / (Math.abs(S) / 1e6) : null;
  return deepFreeze({ recipeId: 'pressure_response_efficiency', version: 1, signedNotional: isFiniteNum(S) ? round(S) : null, responseBps: round(R_), efficiencyBpsPerMillion: eff === null ? null : round(eff), spreadStartBps: spreadStart, spreadEndBps: spreadEnd, knownSideFraction, support: support(!complete ? 'PARTIAL' : !isFiniteNum(S) ? 'NO_KNOWN_SIDE' : S === 0 ? 'ZERO_SIGNED_PRESSURE' : 'COMPLETE', !complete ? ['COVERAGE_GAP'] : []), alternatives: ['ABSORPTION', 'THINNER_PARTICIPATION', 'TWO_SIDED_CHURN', 'DATA_LOSS', 'VENUE_MISMATCH'] });
}
export const pressureResponseChange = (prev, cur) => deepFreeze({ recipeId: 'pressure_response_efficiency', version: 1, previous: prev, current: cur, efficiencyChange: isFiniteNum(prev?.efficiencyBpsPerMillion) && isFiniteNum(cur?.efficiencyBpsPerMillion) ? round(cur.efficiencyBpsPerMillion - prev.efficiencyBpsPerMillion) : null, pressureChange: isFiniteNum(prev?.signedNotional) && isFiniteNum(cur?.signedNotional) ? round(cur.signedNotional - prev.signedNotional) : null, support: support(prev?.support?.state === 'COMPLETE' && cur?.support?.state === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL') });

// ---- H02 peer relative -------------------------------------------------------------------------------------------------
export function peerRelativeMove({ targetReturnBps, peers, minPeers = 5, cohortLabel = 'SAME_QUOTE_VENUE' }) {
  const admissible = peers.filter((p) => isFiniteNum(p.returnBps)); const excluded = peers.filter((p) => !isFiniteNum(p.returnBps)).map((p) => ({ coin: p.coin, reason: p.reason ?? 'RETURN_UNAVAILABLE' }));
  if (!isFiniteNum(targetReturnBps) || admissible.length < minPeers) return deepFreeze({ recipeId: 'peer_relative_move', version: 1, cohortLabel, targetReturnBps: isFiniteNum(targetReturnBps) ? round(targetReturnBps) : null, medianPeerReturnBps: null, residualBps: null, madBps: null, n: admissible.length, positivePeers: null, excluded, support: support('INSUFFICIENT_PEERS', [`NEED_${minPeers}`]) });
  const rets = admissible.map((p) => p.returnBps); const m = median(rets);
  return deepFreeze({ recipeId: 'peer_relative_move', version: 1, cohortLabel, targetReturnBps: round(targetReturnBps), medianPeerReturnBps: round(m), residualBps: round(targetReturnBps - m), madBps: round(mad(rets)), n: admissible.length, positivePeers: rets.filter((r) => r > 0).length, peers: admissible.map((p) => ({ coin: p.coin, returnBps: round(p.returnBps) })), excluded, support: support('COMPLETE') });
}
// observed first-changes across independently captured venues: ordered facts, never lead/lag proof
export const orderedFirstChanges = (changes) => deepFreeze({ recipeId: 'venue_mid_dispersion', version: 1, kind: 'FIRST_OBSERVED_CHANGE', sequence: [...changes].filter((c) => isTs(c.receivedTs)).sort((a, b) => a.receivedTs - b.receivedTs).map((c) => ({ venue: c.venue, receivedTs: c.receivedTs, clockUncertaintyMs: c.clockUncertaintyMs ?? null })), law: 'OBSERVED_SEQUENCE_NOT_CAUSATION' });
export function venueDispersion(mids) {
  const ok = mids.filter((m) => isFiniteNum(m.mid) && m.mid > 0); const quotes = new Set(ok.map((m) => m.quote));
  if (ok.length < 2) return deepFreeze({ recipeId: 'venue_mid_dispersion', version: 1, medianMid: null, dispersionBps: null, n: ok.length, support: support('INSUFFICIENT_VENUES') });
  if (quotes.size > 1) return deepFreeze({ recipeId: 'venue_mid_dispersion', version: 1, medianMid: null, dispersionBps: null, n: ok.length, support: support('QUOTE_MISMATCH', [...quotes].sort()) });
  const vals = ok.map((m) => m.mid); const med = median(vals);
  return deepFreeze({ recipeId: 'venue_mid_dispersion', version: 1, quote: [...quotes][0], medianMid: round(med), dispersionBps: round(1e4 * (Math.max(...vals) - Math.min(...vals)) / med), n: ok.length, venues: ok.map((m) => ({ venue: m.venue, mid: m.mid, receivedTs: m.receivedTs ?? null })), support: support('COMPLETE') });
}
// quote conversion: ONLY with a sourced rate observation whose pair matches; fiat names alone fail
export function convertQuote(value, fromQuote, toQuote, rate) {
  if (!isFiniteNum(value)) return { value: null, support: support('NO_VALUE') };
  if (fromQuote === toQuote) return { value, support: support('SAME_QUOTE') };
  if (!rate || !isFiniteNum(rate.rate) || rate.rate <= 0 || !rate.sourceObservationId || rate.base !== fromQuote || rate.quote !== toQuote) return { value: null, support: support('NO_SOURCED_RATE', [`${fromQuote}->${toQuote}`]) };
  return { value: round(value * rate.rate), rawValue: value, rate: rate.rate, rateDirection: `${fromQuote}->${toQuote}`, rateSource: rate.sourceObservationId, rateAgeMs: rate.ageMs ?? null, conversionPath: [fromQuote, toQuote], support: support('CONVERTED') };
}

// ---- 7.3 derivatives / options -------------------------------------------------------------------------------------------
export const basisBps = (mark, index) => (isFiniteNum(mark) && isFiniteNum(index) && index > 0 ? round(1e4 * (mark / index - 1)) : null);
export function oiChange(a, b) {
  if (!a || !b) return deepFreeze({ recipeId: 'oi_change', version: 1, absolute: null, percent: null, support: support('MISSING_TICK') });
  if (a.subject.specificationId !== b.subject.specificationId || a.payload.openInterestUnit !== b.payload.openInterestUnit) return deepFreeze({ recipeId: 'oi_change', version: 1, absolute: null, percent: null, support: support('SPECIFICATION_MISMATCH') });
  const x = a.payload.openInterest; const y = b.payload.openInterest;
  if (!isFiniteNum(x) || !isFiniteNum(y)) return deepFreeze({ recipeId: 'oi_change', version: 1, absolute: null, percent: null, support: support('OI_MISSING') });
  return deepFreeze({ recipeId: 'oi_change', version: 1, unit: a.payload.openInterestUnit, from: x, to: y, absolute: round(y - x), percent: x > 0 ? round(100 * (y - x) / x) : null, fromTs: a.knownAtTs, toTs: b.knownAtTs, support: support('COMPLETE'), law: 'OI_DELTA_IS_NOT_A_SIDE' });
}
export function fundingNative(tick) {
  const p = tick?.payload; if (!p || !isFiniteNum(p.fundingRateNative)) return deepFreeze({ recipeId: 'funding_native', version: 1, value: null, support: support('NO_FUNDING') });
  if (!['FRACTION_PER_INTERVAL', 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL'].includes(p.fundingUnit) || !isTs(p.fundingIntervalMs)) return deepFreeze({ recipeId: 'funding_native', version: 1, value: null, support: support('UNIT_REJECTED') });
  return deepFreeze({ recipeId: 'funding_native', version: 1, value: p.fundingRateNative, unit: p.fundingUnit, intervalMs: p.fundingIntervalMs, relative: p.fundingRelative, payerConvention: p.fundingRateNative > 0 ? 'LONGS_PAY_SHORTS' : p.fundingRateNative < 0 ? 'SHORTS_PAY_LONGS' : 'ZERO', settlementCurrency: p.settlementCurrency, linearity: p.linearity, annualized: null, support: support('COMPLETE'), law: 'NO_SILENT_ANNUALIZATION' });
}
export function optionsSurface(ticks, { admittedCap = 512, censusComplete = true } = {}) {
  const usable = ticks.filter((t) => t.kind === 'OPTION_TICK'); const byExpiry = new Map();
  for (const t of usable) { const k = t.payload.expiryTs; if (!byExpiry.has(k)) byExpiry.set(k, []); byExpiry.get(k).push(t); }
  const source = new Set(usable.map((t) => `${t.provider}:${t.subject.venue}:${t.payload.settlementCurrency}:${t.payload.underlyingIndex}`));
  if (!usable.length) return deepFreeze({ recipeId: 'atm_iv_term', version: 1, term: [], support: support('NO_OPTIONS') });
  if (source.size > 1) return deepFreeze({ recipeId: 'atm_iv_term', version: 1, term: [], support: support('SCOPE_MISMATCH', [...source].sort()) });
  const term = [];
  for (const [expiryTs, list] of [...byExpiry.entries()].sort((a, b) => a[0] - b[0])) {
    const withIv = list.filter((t) => isFiniteNum(t.payload.markIv) && isFiniteNum(t.payload.underlyingPrice) && t.payload.underlyingPrice > 0);
    const atm = withIv.map((t) => ({ t, d: Math.abs(Math.log(t.payload.strike / t.payload.underlyingPrice)) })).sort((a, b) => a.d - b.d || (a.t.subject.instrumentId < b.t.subject.instrumentId ? -1 : 1))[0] ?? null;
    const calls = withIv.filter((t) => t.payload.optionType === 'CALL' && isFiniteNum(t.payload.delta)); const puts = withIv.filter((t) => t.payload.optionType === 'PUT' && isFiniteNum(t.payload.delta));
    const call25 = calls.map((t) => ({ t, d: Math.abs(t.payload.delta - 0.25) })).sort((a, b) => a.d - b.d || (a.t.subject.instrumentId < b.t.subject.instrumentId ? -1 : 1))[0] ?? null;
    const put25 = puts.map((t) => ({ t, d: Math.abs(t.payload.delta + 0.25) })).sort((a, b) => a.d - b.d || (a.t.subject.instrumentId < b.t.subject.instrumentId ? -1 : 1))[0] ?? null;
    const atmIv = atm ? atm.t.payload.markIv : null; const cIv = call25 ? call25.t.payload.markIv : null; const pIv = put25 ? put25.t.payload.markIv : null;
    const putOi = sum(list.filter((t) => t.payload.optionType === 'PUT').map((t) => t.payload.openInterest ?? 0)); const callOi = sum(list.filter((t) => t.payload.optionType === 'CALL').map((t) => t.payload.openInterest ?? 0));
    const putVol = sum(list.filter((t) => t.payload.optionType === 'PUT').map((t) => t.payload.volume24h ?? 0)); const callVol = sum(list.filter((t) => t.payload.optionType === 'CALL').map((t) => t.payload.volume24h ?? 0));
    const ivSpread = atm && isFiniteNum(atm.t.payload.bidIv) && isFiniteNum(atm.t.payload.askIv) ? round(atm.t.payload.askIv - atm.t.payload.bidIv) : null;
    term.push({ expiryTs, contracts: list.length, atm: atm ? { instrumentId: atm.t.subject.instrumentId, strike: atm.t.payload.strike, logDistance: round(atm.d), markIv: atmIv } : null, call25: call25 ? { instrumentId: call25.t.subject.instrumentId, delta: call25.t.payload.delta, deltaDistance: round(call25.d), markIv: cIv } : null, put25: put25 ? { instrumentId: put25.t.subject.instrumentId, delta: put25.t.payload.delta, deltaDistance: round(put25.d), markIv: pIv } : null, riskReversal25d: isFiniteNum(cIv) && isFiniteNum(pIv) ? round(cIv - pIv) : null, butterfly25d: isFiniteNum(cIv) && isFiniteNum(pIv) && isFiniteNum(atmIv) ? round((cIv + pIv) / 2 - atmIv) : null, atmIvBidAskSpread: ivSpread, putCallOiRatio: censusComplete && callOi > 0 ? round(putOi / callOi) : null, putCallVolumeRatio: censusComplete && callVol > 0 ? round(putVol / callVol) : null, support: support(censusComplete ? 'COMPLETE_ADMITTED_SCOPE' : 'PARTIAL_CENSUS') });
  }
  return deepFreeze({ recipeId: 'atm_iv_term', version: 1, scope: [...source][0], admitted: usable.length, admittedCap, censusComplete, term, law: 'NO_DEALER_GAMMA_INFERENCE_FROM_PUBLIC_OI', support: support(usable.length > admittedCap ? 'OVER_CAP' : 'COMPLETE') });
}
// deterministic admission of a large chain: nearest expiries first, then strikes nearest the index, capped
export function admitOptions(ticks, { cap = 512, nowTs }) {
  const sorted = [...ticks].filter((t) => isTs(t.payload.expiryTs) && t.payload.expiryTs > nowTs).sort((a, b) => (a.payload.expiryTs - b.payload.expiryTs) || (Math.abs(Math.log(a.payload.strike / (a.payload.underlyingPrice || a.payload.strike))) - Math.abs(Math.log(b.payload.strike / (b.payload.underlyingPrice || b.payload.strike)))) || (a.subject.instrumentId < b.subject.instrumentId ? -1 : 1));
  return { admitted: sorted.slice(0, cap), omitted: sorted.length - Math.min(cap, sorted.length), census: ticks.length };
}

// ---- 7.4 supply / on-chain --------------------------------------------------------------------------------------------
export function supplyRatios(ref) {
  const p = ref?.payload; if (!p) return deepFreeze({ recipeId: 'supply_ratios', version: 1, support: support('NO_REFERENCE') });
  const div = (a, b) => (isFiniteNum(a) && isFiniteNum(b) && b > 0 ? round(a / b) : null);
  return deepFreeze({ recipeId: 'supply_ratios', version: 1, circulatingOverTotal: div(p.circulatingSupply, p.totalSupply), circulatingOverMax: div(p.circulatingSupply, p.maxSupply), fdvOverMarketCap: div(p.fdvUsd, p.marketCapUsd), volumeOverMarketCap: div(p.volume24hUsd, p.marketCapUsd), maxSupplyKnown: isFiniteNum(p.maxSupply), capMethodologyId: p.capMethodologyId, support: support('COMPLETE') });
}
export function exchangeNetFlow(inflow, outflow) {
  const k = (o) => `${o.provider}|${o.payload.entitySet}|${o.payload.chain}|${o.subject.canonicalCoin}|${o.payload.unit}|${o.payload.window}|${o.periodStartTs}|${o.periodEndTs}`;
  if (!inflow || !outflow) return deepFreeze({ recipeId: 'exchange_net_flow', version: 1, net: null, support: support('MISSING_LEG') });
  const a = k(inflow); const b = k(outflow); const ma = inflow.payload.methodologyId.replace(/-inflow-/, '-x-'); const mb = outflow.payload.methodologyId.replace(/-outflow-/, '-x-');
  if (a !== b || ma !== mb) return deepFreeze({ recipeId: 'exchange_net_flow', version: 1, net: null, support: support('RECIPE_MISMATCH', ['provider/entity/chain/asset/unit/window/methodology must match']) });
  if (!isFiniteNum(inflow.payload.value) || !isFiniteNum(outflow.payload.value)) return deepFreeze({ recipeId: 'exchange_net_flow', version: 1, net: null, support: support('VALUE_MISSING') });
  return deepFreeze({ recipeId: 'exchange_net_flow', version: 1, inflow: inflow.payload.value, outflow: outflow.payload.value, net: round(inflow.payload.value - outflow.payload.value), unit: inflow.payload.unit, entitySet: inflow.payload.entitySet, chain: inflow.payload.chain, window: inflow.payload.window, periodStartTs: inflow.periodStartTs, periodEndTs: inflow.periodEndTs, labelVintage: inflow.payload.labelVintage, support: support('COMPLETE'), law: 'EXCHANGE_TRANSFER_IS_NOT_A_SALE' });
}
export const stablecoinChange = (a, b) => (!a || !b ? deepFreeze({ recipeId: 'stablecoin_supply_change', version: 1, change: null, support: support('MISSING_POINT') }) : a.payload.stablecoinId !== b.payload.stablecoinId || a.payload.chain !== b.payload.chain || a.payload.unit !== b.payload.unit || a.payload.metricId !== b.payload.metricId ? deepFreeze({ recipeId: 'stablecoin_supply_change', version: 1, change: null, support: support('MATCH_FAILED') }) : deepFreeze({ recipeId: 'stablecoin_supply_change', version: 1, from: a.payload.value, to: b.payload.value, change: isFiniteNum(a.payload.value) && isFiniteNum(b.payload.value) ? round(b.payload.value - a.payload.value) : null, unit: a.payload.unit, chain: a.payload.chain, fromTs: a.knownAtTs, toTs: b.knownAtTs, support: support('COMPLETE') }));
export const pegDeviationBps = (price) => (isFiniteNum(price) && price > 0 ? round(1e4 * (price - 1)) : null);
export function liquidationTotals(events, { startTs, endTs, coverageKnown = true }) {
  const inside = events.filter((e) => e.kind === 'LIQUIDATION' && ((e.sourceEventTs !== null && inWindow(e.sourceEventTs, startTs, endTs)) || (e.periodEndTs !== null && e.periodEndTs > startTs && e.periodEndTs <= endTs)));
  const units = new Set(inside.map((e) => e.payload.notionalUnit)); if (units.size > 1) return deepFreeze({ recipeId: 'liquidation_notional_by_side', version: 1, longNotional: null, shortNotional: null, support: support('UNIT_MISMATCH', [...units].sort()) });
  let L = 0; let S = 0; let U = 0; let n = 0;
  for (const e of inside) { const p = e.payload; if (p.aggregated) { L += p.longNotional ?? 0; S += p.shortNotional ?? 0; } else if (p.liquidatedPositionSide === 'LONG') L += p.notional ?? 0; else if (p.liquidatedPositionSide === 'SHORT') S += p.notional ?? 0; else U += p.notional ?? 0; n += 1; }
  return deepFreeze({ recipeId: 'liquidation_notional_by_side', version: 1, startTs, endTs, events: n, unit: units.size ? [...units][0] : null, longNotional: n ? round(L) : null, shortNotional: n ? round(S) : null, unknownSideNotional: n ? round(U) : null, zeroMeaningful: coverageKnown, support: support(n ? 'COMPLETE' : coverageKnown ? 'COMPLETE_NO_EVENTS' : 'UNKNOWN_COVERAGE'), law: 'CAUSE_OF_A_LIQUIDATION_IS_NOT_OBSERVED' });
}
export function etfFlowSummary(flows) {
  const agg = flows.filter((f) => f.kind === 'ETF_FLOW' && f.payload.fund === null && isFiniteNum(f.payload.flowUsd)).sort((a, b) => a.periodStartTs - b.periodStartTs);
  if (!agg.length) return deepFreeze({ recipeId: 'etf_daily_flow', version: 1, latest: null, support: support('NO_FLOWS') });
  const last = agg[agg.length - 1]; const trailing = (n) => round(sum(agg.slice(-n).map((f) => f.payload.flowUsd)));
  return deepFreeze({ recipeId: 'etf_daily_flow', version: 1, asset: last.payload.asset, latest: { periodStartTs: last.periodStartTs, periodEndTs: last.periodEndTs, flowUsd: last.payload.flowUsd, estimate: last.payload.estimate, receivedTs: last.receivedTs }, trailing5: trailing(5), trailing20: trailing(20), days: agg.length, support: support('COMPLETE'), law: 'DAILY_FLOW_IS_SLOW_CONTEXT' });
}

// ---- 7.5 macro / cross-asset ------------------------------------------------------------------------------------------------
export function macroSurprise(ev) {
  const p = ev?.payload; if (!p) return deepFreeze({ recipeId: 'macro_surprise', version: 1, surprise: null, support: support('NO_EVENT') });
  if (!isFiniteNum(p.actualValue) || !isFiniteNum(p.forecastValue)) return deepFreeze({ recipeId: 'macro_surprise', version: 1, surprise: null, support: support('VALUE_MISSING') });
  if (!isTs(p.forecastKnownAtTs) || !isTs(p.scheduledTs) || p.forecastKnownAtTs >= p.scheduledTs) return deepFreeze({ recipeId: 'macro_surprise', version: 1, surprise: null, support: support('FORECAST_NOT_KNOWN_BEFORE_RELEASE') });
  return deepFreeze({ recipeId: 'macro_surprise', version: 1, actual: p.actualValue, forecast: p.forecastValue, surprise: round(p.actualValue - p.forecastValue), unit: p.unit === 'PERCENT' ? 'PERCENTAGE_POINTS' : p.unit ?? 'NATIVE', previous: p.previousValue, revisedPrevious: null, forecastKnownAtTs: p.forecastKnownAtTs, releaseTs: p.scheduledTs, support: support('COMPLETE'), law: 'REVISED_PREVIOUS_IS_NOT_THE_FIRST_RELEASE_PRIOR' });
}
export function pearson(pairs, { minN = 30 } = {}) {
  const ok = pairs.filter((p) => isFiniteNum(p[0]) && isFiniteNum(p[1]));
  if (ok.length < minN) return deepFreeze({ recipeId: 'pearson_correlation', version: 1, r: null, n: ok.length, support: support('INSUFFICIENT_PAIRS', [`NEED_${minN}`]) });
  const xs = ok.map((p) => p[0]); const ys = ok.map((p) => p[1]); const mx = sum(xs) / xs.length; const my = sum(ys) / ys.length;
  const vx = sum(xs.map((x) => (x - mx) ** 2)); const vy = sum(ys.map((y) => (y - my) ** 2));
  if (vx <= 0 || vy <= 0) return deepFreeze({ recipeId: 'pearson_correlation', version: 1, r: null, n: ok.length, support: support('ZERO_VARIANCE') });
  const cov = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  return deepFreeze({ recipeId: 'pearson_correlation', version: 1, r: round(cov / Math.sqrt(vx * vy)), n: ok.length, support: support('COMPLETE'), law: 'DESCRIPTIVE_NEVER_CAUSAL' });
}
export function relativeActivity(current, trailing, key) {
  const vals = trailing.map((w) => w?.[key]).filter(isFiniteNum); const cur = current?.[key];
  if (!isFiniteNum(cur) || vals.length < 3) return deepFreeze({ recipeId: 'relative_activity', version: 1, key, ratio: null, n: vals.length, support: support('INSUFFICIENT_TRAILING', ['NEED_3']) });
  const m = median(vals); return deepFreeze({ recipeId: 'relative_activity', version: 1, key, current: cur, trailingMedian: round(m), ratio: m > 0 ? round(cur / m) : null, n: vals.length, support: support('COMPLETE') });
}

// ---- indicators over closed bars -------------------------------------------------------------------------------------
export function indicators(bars) {
  const closed = bars.filter((b) => b.payload.closed && isFiniteNum(b.payload.close)).sort((a, b) => a.periodStartTs - b.periodStartTs);
  const c = closed.map((b) => b.payload.close); const h = closed.map((b) => b.payload.high); const l = closed.map((b) => b.payload.low); const n = c.length;
  const sma = (k) => (n >= k ? round(sum(c.slice(-k)) / k) : null);
  const ema = (k) => { if (n < k) return null; let e = sum(c.slice(0, k)) / k; const a = 2 / (k + 1); for (let i = k; i < n; i += 1) e = c[i] * a + e * (1 - a); return round(e); };
  const rets = []; for (let i = 1; i < n; i += 1) rets.push(Math.log(c[i] / c[i - 1]));
  const rv = (k) => (rets.length >= k ? round(populationStdev(rets.slice(-k))) : null);
  const rsi = () => { if (n < 15) return { value: null, state: 'WARMUP' }; let g = 0; let ls = 0; for (let i = 1; i <= 14; i += 1) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else ls -= d; } let ag = g / 14; let al = ls / 14; for (let i = 15; i < n; i += 1) { const d = c[i] - c[i - 1]; ag = (ag * 13 + Math.max(0, d)) / 14; al = (al * 13 + Math.max(0, -d)) / 14; } if (ag === 0 && al === 0) return { value: null, state: 'FLAT' }; if (al === 0) return { value: 100, state: 'NO_LOSSES' }; if (ag === 0) return { value: 0, state: 'NO_GAINS' }; return { value: round(100 - 100 / (1 + ag / al)), state: 'OK' }; };
  const atr = () => { if (n < 15) return null; const tr = []; for (let i = 1; i < n; i += 1) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); let a = sum(tr.slice(0, 14)) / 14; for (let i = 14; i < tr.length; i += 1) a = (a * 13 + tr[i]) / 14; return round(a); };
  const macd = () => { if (n < 35) return null; const series = (k) => { const out = []; let e = sum(c.slice(0, k)) / k; out[k - 1] = e; const a = 2 / (k + 1); for (let i = k; i < n; i += 1) { e = c[i] * a + e * (1 - a); out[i] = e; } return out; }; const e12 = series(12); const e26 = series(26); const line = []; for (let i = 25; i < n; i += 1) line.push(e12[i] - e26[i]); if (line.length < 9) return null; let s = sum(line.slice(0, 9)) / 9; for (let i = 9; i < line.length; i += 1) s = line[i] * 0.2 + s * 0.8; const m = line[line.length - 1]; return { macd: round(m), signal: round(s), histogram: round(m - s) }; };
  const bb = () => { if (n < 20) return null; const w = c.slice(-20); const m = sum(w) / 20; const sd = populationStdev(w); return { middle: round(m), upper: round(m + 2 * sd), lower: round(m - 2 * sd), stdev: round(sd) }; };
  const prior = (k) => (n > k ? { high: Math.max(...h.slice(-k - 1, -1)), low: Math.min(...l.slice(-k - 1, -1)) } : null);
  return deepFreeze({ recipeId: 'indicators', version: 1, closedBars: n, lastClosedEndTs: n ? closed[n - 1].periodEndTs : null, intervalMs: n ? closed[n - 1].payload.intervalMs : null, sma: { 5: sma(5), 20: sma(20), 60: sma(60) }, ema: { 5: ema(5), 20: ema(20), 60: ema(60) }, realizedVolatility: { 5: rv(5), 20: rv(20), 60: rv(60) }, atr14: atr(), rsi14: rsi(), macd: macd(), bollinger20: bb(), prior20: prior(20), prior60: prior(60), lastClose: n ? c[n - 1] : null, support: support(n ? 'COMPLETE' : 'NO_CLOSED_BARS', n < 60 ? ['WARMUP_INCOMPLETE_FOR_60'] : []), law: 'WARMUP_IS_NULL_NEVER_ZERO' });
}
export function breakoutDistance(lastClose, ind, vwap = null) {
  const bps = (a, b) => (isFiniteNum(a) && isFiniteNum(b) && b > 0 ? round(1e4 * (a / b - 1)) : null);
  return deepFreeze({ recipeId: 'breakout_distance', version: 1, toPrior20High: bps(lastClose, ind?.prior20?.high), toPrior20Low: bps(lastClose, ind?.prior20?.low), toPrior60High: bps(lastClose, ind?.prior60?.high), toPrior60Low: bps(lastClose, ind?.prior60?.low), toVwap: bps(lastClose, vwap), support: support(ind?.prior20 ? 'COMPLETE' : 'INSUFFICIENT_BARS') });
}
