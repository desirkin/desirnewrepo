// MARKET LAB — CLOSED component value / support schemas (closeout R07). Every component of a context bundle carries a
// value whose keys, types, enums, nullability and nesting are declared HERE per metric, and a support block whose state is
// drawn from that metric's closed state list. The same validator runs for the builder's candidate (before publication),
// the reader (before a case) and the verifier (after a case), so a malformed value (a string where a number is owed, an
// undeclared key, an unknown support state) is refused identically at every boundary — never coerced, never ignored.
// Importing this module performs no I/O.
import { QUALITY_STATES, TIME_PRECISIONS, UNLOCK_TYPES, SESSION_STATES, EVENT_KINDS, PROVIDER_STATUS_STATES, UNITS, WINDOWS, deepFreeze } from './contracts.js';
import { INTERVAL_COVERAGE_STATES, TRADE_WINDOW_SUPPORT, OPTIONS_CENSUS_BASES } from './recipes.js';

const MAX_REASONS = 16; const MAX_REASON_CHARS = 120; const MAX_STR = 300; const MAX_LIST = 4_096;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- a small closed-schema DSL: every node is (value, where) -> error string | null ------------------------------------
const num = (v, w) => (typeof v === 'number' && Number.isFinite(v) ? null : `${w}: must be a finite number`);
const int = (v, w) => (Number.isSafeInteger(v) ? null : `${w}: must be an integer`);
const count = (v, w) => (Number.isSafeInteger(v) && v >= 0 ? null : `${w}: must be a non-negative integer`);
const ts = (v, w) => (Number.isSafeInteger(v) && v > 0 ? null : `${w}: must be a positive epoch-ms timestamp`);
// a displayed / filled / requested QUANTITY or NOTIONAL is a magnitude: finite and never negative (closeout P5; signed metrics such
// as returns, imbalances, basis, net flows and changes keep their sign under `num`)
const nonneg = (v, w) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : `${w}: must be a non-negative finite number`);
const price = (v, w) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? null : `${w}: must be a positive finite price`);
const bool = (v, w) => (typeof v === 'boolean' ? null : `${w}: must be a boolean`);
const str = (max = MAX_STR) => (v, w) => (typeof v === 'string' && v.length >= 1 && v.length <= max ? null : `${w}: must be a non-empty string (max ${max})`);
const en = (list) => (v, w) => (list.includes(v) ? null : `${w}: must be one of ${list.join('|')}`);
const nullable = (s) => (v, w) => (v === null ? null : s(v, w));
const literal = (x) => (v, w) => (v === x ? null : `${w}: must be ${JSON.stringify(x)}`);
const arr = (item, max = MAX_LIST) => (v, w) => { if (!Array.isArray(v)) return `${w}: must be an array`; if (v.length > max) return `${w}: over the cap of ${max}`; for (let i = 0; i < v.length; i += 1) { const e = item(v[i], `${w}[${i}]`); if (e) return e; } return null; };
// a CLOSED object: every required key present, optional keys typed when present, no undeclared keys
// (closeout P5: membership is OWN-property membership on both sides — an inherited name such as `constructor` is never a
// declared key, and an inherited name on the value is never a present key; diagnostics name the schema path, never the text)
const obj = (required, optional = {}) => (v, w) => {
  if (!isPlain(v)) return `${w}: must be an object`;
  for (const k of Object.keys(required)) { if (!Object.hasOwn(v, k)) return `${w}.${k}: required key missing`; const e = required[k](v[k], `${w}.${k}`); if (e) return e; }
  const own = Object.keys(v);
  for (let i = 0; i < own.length; i += 1) { const k = own[i]; if (Object.hasOwn(required, k)) continue; if (!Object.hasOwn(optional, k)) return `${w}: undeclared key at position ${i + 1} of ${own.length}`; const e = optional[k](v[k], `${w}.${k}`); if (e) return e; }
  return null;
};
// a value whose shape depends on a discriminator (recipe early returns): pick(v) -> schema
const variant = (pick) => (v, w) => { if (!isPlain(v)) return `${w}: must be an object`; return pick(v)(v, w); };
const numN = nullable(num); const nonnegN = nullable(nonneg); const priceN = nullable(price); const intN = nullable(int); const tsN = nullable(ts); const boolN = nullable(bool); const strN = nullable(str()); const idN = nullable(str(120)); const countN = nullable(count);
const version = int; const law = str(120); const laws = arr(str(120), 16);

// ---- support blocks: { state, reasons, attribution? } with a CLOSED state list ---------------------------------------
export const SUPPORT_REASON_MAX = MAX_REASONS;
const supportOf = (states) => obj({ state: en(states), reasons: arr(str(MAX_REASON_CHARS), MAX_REASONS) }, { attribution: str(80) });
export function contextSupportError(support, where = 'support') {
  if (!isPlain(support)) return `${where}: must be an object`;
  const own = Object.keys(support); for (let i = 0; i < own.length; i += 1) if (!['state', 'reasons', 'attribution'].includes(own[i])) return `${where}: undeclared key at position ${i + 1} of ${own.length}`;
  if (typeof support.state !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(support.state)) return `${where}.state: must be an upper-case token`;
  const e = arr(str(MAX_REASON_CHARS), MAX_REASONS)(support.reasons, `${where}.reasons`); if (e) return e;
  if (Object.hasOwn(support, 'attribution')) { const a = str(80)(support.attribution, `${where}.attribution`); if (a) return a; }
  return null;
}

// ---- recipe sub-schemas (each mirrors one recipe's output, including its early-return forms) ------------------------------
const FLOW_STATES = Object.freeze(['COMPLETE', 'KNOWN_SUBSET', 'NO_KNOWN_SIDE', 'PARTIAL', 'UNKNOWN_COVERAGE']);
const flowSchema = obj({ recipeId: literal('signed_notional'), version, buyNotional: nonneg, sellNotional: nonneg, unknownNotional: nonneg, buyCount: count, sellCount: count, unknownCount: count, signedNotional: numN, knownSideImbalance: numN, knownSideFraction: nonnegN, observedOnly: bool, support: supportOf(FLOW_STATES) });
const statsSchema = obj({ recipeId: literal('trade_size_stats'), version, sizeMedian: nonnegN, sizeP90: nonnegN, interarrivalMeanMs: nonnegN, interarrivalMedianMs: nonnegN, clockPrecisionMs: nullable(en([1, 1000])), support: supportOf(['COMPLETE', 'INSUFFICIENT']) });
const intervalCoverageSchema = obj({ state: en(INTERVAL_COVERAGE_STATES), basis: arr(str(80), 8) });
const tradeWindowSchema = obj({ recipeId: literal('window_ohlcv'), version, startTs: ts, endTs: ts, windowMs: count, count: countN, observedCount: count, volumeBase: nonnegN, quoteNotional: nonnegN, observedNotional: nonneg, vwap: priceN, open: priceN, high: priceN, low: priceN, close: priceN, coverage: intervalCoverageSchema, range: nonnegN, closeLocation: numN, logReturn: numN, support: supportOf(TRADE_WINDOW_SUPPORT), flow: flowSchema, stats: statsSchema });
const relativeActivitySchema = obj({ recipeId: literal('relative_activity'), version, key: en(['quoteNotional', 'range']), ratio: numN, n: count, support: supportOf(['COMPLETE', 'INSUFFICIENT_TRAILING']) }, { current: num, trailingMedian: num });
const triple = obj({ 5: numN, 20: numN, 60: numN }); const nonnegTriple = obj({ 5: nonnegN, 20: nonnegN, 60: nonnegN });
const indicatorsValue = obj({
  intervalMs: nullable(count), recipeId: literal('indicators'), version, closedBars: count, lastClosedEndTs: tsN, sma: triple, ema: triple, realizedVolatility: nonnegTriple, atr14: nonnegN,
  rsi14: obj({ value: nullable((v, w) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? null : `${w}: must be an RSI in [0, 100]`)), state: en(['WARMUP', 'FLAT', 'NO_LOSSES', 'NO_GAINS', 'OK']) }), macd: nullable(obj({ macd: num, signal: num, histogram: num })), bollinger20: nullable(obj({ middle: num, upper: num, lower: num, stdev: nonneg })),
  prior20: nullable(obj({ high: price, low: price })), prior60: nullable(obj({ high: price, low: price })), lastClose: priceN, support: supportOf(['COMPLETE', 'NO_CLOSED_BARS', 'PARTIAL']), law: literal('WARMUP_IS_NULL_NEVER_ZERO'),
  breakout: obj({ recipeId: literal('breakout_distance'), version, toPrior20High: numN, toPrior20Low: numN, toPrior60High: numN, toPrior60Low: numN, toVwap: numN, support: supportOf(['COMPLETE', 'INSUFFICIENT_BARS']) }),
  provisionalBar: nullable(obj({ periodStartTs: ts, close: price, state: literal('PROVISIONAL') })), completeness: obj({ bars: count, evictedBarsUntilTs: tsN, capReached: bool }, { selection: obj({ law: literal('ONE_SELECTED_VERSION_PER_NATIVE_PERIOD'), envelopes: count, selectedPeriods: count, series: count, repeats: count, revisions: count, conflicts: count }) }), venue: str(80),
});
const bandSide = obj({ qty: nonneg, notional: nonneg, lowerBoundOnly: bool });
const band = obj({ bid: bandSide, ask: bandSide, imbalance: numN });
const bookExtras = { bookAgeMs: count, synchronized: boolN, checksumVerified: boolN, sampleReason: strN, venue: str(80), quote: str(20) };
const spreadFull = obj({ recipeId: literal('spread_bps'), version, mid: price, spreadBps: nonneg, bestBid: price, bestAsk: price, topBidQty: nonneg, topAskQty: nonneg, microprice: priceN, bands: obj({ '5bps': band, '10bps': band, '25bps': band }), levelsRetained: obj({ bids: count, asks: count }), support: supportOf(['COMPLETE']), ...bookExtras });
const spreadEmpty = obj({ recipeId: literal('spread_bps'), version, mid: literal(null), spreadBps: literal(null), support: supportOf(['NO_TWO_SIDED_BOOK']), ...bookExtras });
const spreadNoBook = obj({ venue: str(80), mid: literal(null), spreadBps: literal(null) });
const spreadValue = variant((v) => (!Object.hasOwn(v, 'recipeId') ? spreadNoBook : v.mid === null && !Object.hasOwn(v, 'bestBid') ? spreadEmpty : spreadFull));
const walkSchema = obj({ recipeId: literal('book_walk'), version, requested: variant((r) => (Object.hasOwn(r, 'quoteNotional') ? obj({ quoteNotional: nonneg }) : obj({ baseQty: nonneg }))), consumedLevels: count, filledBase: nonneg, filledQuote: nonneg, residualQuote: nonnegN, residualBase: nonnegN, averagePrice: priceN, worstPrice: priceN, coverage: en(['FULL', 'PARTIAL', 'NO_BOOK']), hypothetical: bool }, { preFee: bool });
const roundTripSchema = obj({ recipeId: literal('round_trip_loss'), version, quoteNotional: nonneg, haircut: nonneg, buy: walkSchema, sell: nullable(walkSchema), saleProceeds: nonnegN, lossBps: numN, spreadBps: nonnegN, coverage: en(['FULL', 'PARTIAL_BUY', 'PARTIAL_SELL']), preFee: bool, hypothetical: bool }, { worstBuyPrice: priceN, worstSellPrice: priceN, scenario: literal('STRESS_NOT_PROBABILITY') });
const roundTripValue = obj({ quoteNotional: nonneg, current: roundTripSchema, previous: nullable(roundTripSchema), lossChangeBps: numN, haircuts: arr(roundTripSchema, 3), buyWalk: walkSchema, sellWalk: walkSchema, fees: literal('NOT_SUPPLIED_PRE_FEE_ONLY'), venue: str(80) });
const pressureSchema = obj({ recipeId: literal('pressure_response_efficiency'), version, responseBps: numN, efficiencyBpsPerMillion: numN, support: supportOf(['NO_BOOK_ENDPOINTS', 'PARTIAL', 'NO_KNOWN_SIDE', 'ZERO_SIGNED_PRESSURE', 'COMPLETE']) }, { signedNotional: numN, spreadStartBps: nonnegN, spreadEndBps: nonnegN, knownSideFraction: nonnegN, alternatives: arr(str(40), 8) });
const pressureValue = obj({ recipeId: literal('pressure_response_efficiency'), version, previous: pressureSchema, current: pressureSchema, efficiencyChange: numN, pressureChange: numN, support: supportOf(['COMPLETE', 'PARTIAL']), replenishment: nullable(obj({ depth10bpsBidChange: num, depth10bpsAskChange: num })), venue: str(80), quote: str(20), quoteUnitNote: str(80) });
const dispersionSchema = obj({ recipeId: literal('venue_mid_dispersion'), version, medianMid: priceN, dispersionBps: nonnegN, n: count, support: supportOf(['COMPLETE', 'INSUFFICIENT_VENUES', 'QUOTE_MISMATCH']) }, { quote: str(20), venues: arr(obj({ venue: str(80), mid: price, receivedTs: tsN }), 64) });
const dispersionValue = obj({ dispersion: dispersionSchema, firstObservedChanges: obj({ recipeId: literal('venue_mid_dispersion'), version, kind: literal('FIRST_OBSERVED_CHANGE'), sequence: arr(obj({ venue: str(80), receivedTs: ts, clockUncertaintyMs: numN }), 64), law }), aliasNote: str(160) });
const peerValue = obj({ recipeId: literal('peer_relative_move'), version, cohortLabel: str(80), targetReturnBps: numN, medianPeerReturnBps: numN, residualBps: numN, madBps: nonnegN, n: count, positivePeers: countN, excluded: arr(obj({ coin: str(20), reason: str(80) }), 256), support: supportOf(['COMPLETE', 'INSUFFICIENT_PEERS']), cohortMappingKnownAtTs: tsN, cohortNote: str(200) }, { peers: arr(obj({ coin: str(20), returnBps: num }), 256) });
const oiChangeSchema = obj({ recipeId: literal('oi_change'), version, absolute: numN, percent: numN, support: supportOf(['MISSING_TICK', 'SPECIFICATION_MISMATCH', 'OI_MISSING', 'COMPLETE']) }, { unit: str(40), from: num, to: num, fromTs: ts, toTs: ts, law });
const fundingSchema = obj({ recipeId: literal('funding_native'), version, value: numN, support: supportOf(['NO_FUNDING', 'UNIT_REJECTED', 'COMPLETE']) }, { unit: en(['FRACTION_PER_INTERVAL', 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL']), intervalMs: count, relative: numN, payerConvention: en(['LONGS_PAY_SHORTS', 'SHORTS_PAY_LONGS', 'ZERO']), settlementCurrency: strN, linearity: strN, annualized: literal(null), law });
const basisValue = obj({ instrument: str(120), marketType: str(40), basisBps: numN, markPrice: priceN, indexPrice: priceN, openInterest: obj({ value: nonnegN, unit: str(40), changeOverHour: oiChangeSchema }), funding: fundingSchema, ageMs: count, quality: en(QUALITY_STATES) });
const liquidationValue = obj({ recipeId: literal('liquidation_notional_by_side'), version, longNotional: nonnegN, shortNotional: nonnegN, support: supportOf(['COMPLETE', 'COMPLETE_NO_EVENTS', 'UNKNOWN_COVERAGE', 'UNIT_MISMATCH']), venues: arr(str(80), 64) }, { startTs: ts, endTs: ts, events: count, unit: strN, unknownSideNotional: nonnegN, zeroMeaningful: bool, law });
const optionLeg = obj({ instrumentId: str(120), delta: num, deltaDistance: nonneg, markIv: nonneg });
const termEntry = obj({ expiryTs: ts, contracts: count, atm: nullable(obj({ instrumentId: str(120), strike: price, logDistance: nonneg, markIv: nonneg })), call25: nullable(optionLeg), put25: nullable(optionLeg), riskReversal25d: numN, butterfly25d: numN, atmIvBidAskSpread: nonnegN, putCallOiRatio: nonnegN, putCallVolumeRatio: nonnegN, ratioScope: en(['WHOLE_CHAIN', 'ADMITTED_SUBSET']), greeksMissing: count, support: supportOf(['PARTIAL_ADMITTED_SCOPE', 'PARTIAL_CENSUS', 'COMPLETE_ADMITTED_SCOPE']) });
const censusSchema = obj({ complete: bool, basis: en(OPTIONS_CENSUS_BASES), total: countN, admitted: count, omitted: countN, rejected: countN, unticked: countN, censusId: idN, censusKnownAtTs: tsN });
const optionsValue = obj({ recipeId: literal('atm_iv_term'), version, term: arr(termEntry, 256), support: supportOf(['NO_OPTIONS', 'SCOPE_MISMATCH', 'OVER_CAP', 'PARTIAL_CENSUS', 'ADMITTED_SUBSET', 'COMPLETE']), admission: obj({ ticksSeen: count, inCensus: count, notInCensus: count, admitted: count, omitted: count, recipe: str(120) }) }, { scope: str(200), admitted: count, admittedCap: count, censusComplete: bool, census: censusSchema, law });
const supplyValue = obj({ recipeId: literal('supply_ratios'), version, support: supportOf(['NO_REFERENCE', 'COMPLETE']), reference: obj({ provider: str(40), marketCapUsd: nonnegN, fdvUsd: nonnegN, circulatingSupply: nonnegN, totalSupply: nonnegN, maxSupply: nonnegN, priceUsd: nonnegN, lastUpdatedTs: tsN, ageMs: count }) }, { circulatingOverTotal: nonnegN, circulatingOverMax: nonnegN, fdvOverMarketCap: nonnegN, volumeOverMarketCap: nonnegN, maxSupplyKnown: bool, capMethodologyId: idN });
const unlockValue = obj({ upcoming: arr(obj({ provider: str(40), eventId: str(120), scheduledTs: tsN, timePrecision: en(TIME_PRECISIONS), amountToken: nonnegN, amountUsd: nonnegN, recipientCategory: strN, unlockType: en(UNLOCK_TYPES), tracked: bool, knownAtTs: ts }), 256), untrackedAllocations: count, laws });
const poolValue = obj({ chain: str(80), poolAddress: str(120), dex: idN, baseToken: str(120), quoteToken: str(120), priceUsd: nonnegN, priceQuote: nonnegN, liquidityUsd: nonnegN, volume24hUsd: nonnegN, volume1hUsd: nonnegN, txCount24h: countN, poolCreatedTs: tsN, feePct: nonnegN, ageMs: count, provider: str(40), laws });
const defiValue = obj({ metricId: str(80), value: numN, unit: en(UNITS), chain: idN, protocol: idN, periodKind: en(['POINT', 'DAILY']), methodologyId: str(120), ageMs: count, provider: str(40), law });
const netFlowValue = obj({ provider: str(40), recipeId: literal('exchange_net_flow'), version, net: numN, support: supportOf(['MISSING_LEG', 'RECIPE_MISMATCH', 'VALUE_MISSING', 'COMPLETE']), ageMs: countN }, { inflow: nonneg, outflow: nonneg, unit: en(UNITS), entitySet: idN, chain: str(80), window: en(WINDOWS), periodStartTs: ts, periodEndTs: ts, labelVintage: idN, law });
const onchainKeys = { metricId: str(80), value: numN, unit: en(UNITS), entitySet: idN, chain: str(80), window: en(WINDOWS), methodologyId: str(120), labelVintage: idN };
const onchainLatestValue = obj({ provider: str(40), ...onchainKeys, ageMs: count });
const networkValue = obj({ nativeMetric: en(['active_addresses', 'transaction_count', 'transfer_volume', 'fees_total', 'mvrv', 'sopr', 'realized_price', 'whale_transaction_count_100k_usd_to_inf', 'whale_transaction_count_1m_usd_to_inf', 'whale_transaction_volume_100k_usd_to_inf', 'whale_transaction_volume_1m_usd_to_inf']), provider: str(40), ...onchainKeys, previousValue: numN, change: numN, ageMs: count });
const stableValue = obj({ stablecoinId: str(80), chain: idN, recipeId: literal('stablecoin_supply_change'), version, change: numN, support: supportOf(['MISSING_POINT', 'MATCH_FAILED', 'COMPLETE']), current: numN, pegPrice: numN, pegDeviationBps: numN, pegAgeMs: countN, ageMs: count, laws }, { from: numN, to: numN, unit: en(UNITS), fromTs: ts, toTs: ts });
const etfValue = obj({ recipeId: literal('etf_daily_flow'), version, latest: nullable(obj({ periodStartTs: ts, periodEndTs: ts, flowUsd: num, estimate: bool, receivedTs: ts })), support: supportOf(['NO_FLOWS', 'COMPLETE']), ageMs: countN, funds: arr(str(80), 64) }, { asset: str(20), trailing5: num, trailing20: num, days: count, law });
const dateOnly = (v, w) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : `${w}: must be a YYYY-MM-DD date`);
const macroLevelValue = obj({ seriesId: str(80), value: num, unit: en(UNITS), unitLabel: strN, observationDate: dateOnly, vintageDate: nullable(dateOnly), previous: nullable(obj({ value: num, observationDate: dateOnly })), change: numN, frequency: strN, ageMs: count, law });
const surpriseSchema = obj({ recipeId: literal('macro_surprise'), version, surprise: numN, support: supportOf(['NO_EVENT', 'VALUE_MISSING', 'FORECAST_NOT_KNOWN_BEFORE_RELEASE', 'COMPLETE']) }, { actual: num, forecast: num, unit: str(40), previous: numN, revisedPrevious: literal(null), forecastKnownAtTs: ts, releaseTs: ts, law });
const macroSurpriseValue = obj({ upcoming: arr(obj({ eventName: str(MAX_STR), countryCode: str(8), scheduledTs: tsN, timePrecision: en(TIME_PRECISIONS), forecastValue: numN, unit: nullable(en(UNITS)), importance: nullable(en([0, 1, 2, 3])) }), 256), released: arr(obj({ eventName: str(MAX_STR), countryCode: str(8), scheduledTs: tsN, actual: numN, forecast: numN, unit: nullable(en(UNITS)), surprise: surpriseSchema }), 256) });
const pearsonSchema = obj({ recipeId: literal('pearson_correlation'), version, r: nullable((v, w) => (typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1 ? null : `${w}: must be a correlation in [-1, 1]`)), n: count, support: supportOf(['INSUFFICIENT_PAIRS', 'ZERO_VARIANCE', 'COMPLETE']) }, { law });
const crossAssetValue = obj({ instrument: str(120), proxyFor: idN, exchange: idN, currency: str(20), sessionState: en(SESSION_STATES), intervalMs: count, lastClose: numN, lastBarEndTs: ts, logReturnLastBar: numN, ageMs: count, correlationWithTarget: pearsonSchema, delayed: boolN });
const eventsValue = obj({ events: arr(obj({ observationId: str(120), eventKind: en(EVENT_KINDS), sourceProvider: str(80), nativeRef: str(120), sourceEventTs: tsN, knownAtTs: ts, status: nullable(str(40)), headline: nullable(str(MAX_STR)), untrusted: bool }), 512), law });
const infraValue = obj({ statuses: arr(obj({ providerId: str(40), component: nullable(str(80)), status: en(PROVIDER_STATUS_STATES), knownAtTs: ts }), 128), incidents: arr(obj({ nativeRef: str(120), status: nullable(str(40)), sourceEventTs: tsN, headline: nullable(str(MAX_STR)), untrusted: literal(true) }), 128), law });

// ---- per-metric CLOSED schema: value shape + the component's own support states ------------------------------------------
const NETWORK_METRICS = ['active_addresses', 'transaction_count', 'transfer_volume', 'network_fees', 'realized_value_metrics', 'whale_transaction_count_100k_usd_to_inf', 'whale_transaction_count_1m_usd_to_inf', 'whale_transaction_volume_100k_usd_to_inf', 'whale_transaction_volume_1m_usd_to_inf'];
export const METRIC_SCHEMAS = deepFreeze(Object.fromEntries([
  ['window_ohlcv', { support: TRADE_WINDOW_SUPPORT, value: obj({ current: tradeWindowSchema, previous: tradeWindowSchema, venue: str(80), quote: str(20), changes: obj({ logReturn: numN, quoteNotional: numN, count: numN }) }) }],
  ['relative_activity', { support: ['COMPLETE', 'INSUFFICIENT_TRAILING'], value: obj({ notional: relativeActivitySchema, range: relativeActivitySchema, venue: str(80) }) }],
  ['indicators', { support: ['COMPLETE', 'NO_CLOSED_BARS', 'PARTIAL'], value: indicatorsValue }],
  ['signed_notional', { support: FLOW_STATES, value: obj({ current: flowSchema, previous: flowSchema, stats: statsSchema, venue: str(80), quote: str(20) }) }],
  ['pressure_response_efficiency', { support: ['COMPLETE', 'PARTIAL'], value: pressureValue }],
  ['spread_bps', { support: ['FRESH', 'STALE', 'NO_BOOK'], value: spreadValue }],
  ['round_trip_loss', { support: ['COMPLETE', 'PARTIAL', 'STALE'], value: roundTripValue }],
  ['venue_mid_dispersion', { support: ['COMPLETE', 'INSUFFICIENT_VENUES', 'QUOTE_MISMATCH'], value: dispersionValue }],
  ['peer_relative_move', { support: ['COMPLETE', 'INSUFFICIENT_PEERS'], value: peerValue }],
  ['basis_bps', { support: ['COMPLETE', 'PARTIAL'], value: basisValue }],
  ['liquidation_notional_by_side', { support: ['COMPLETE', 'COMPLETE_NO_EVENTS', 'UNKNOWN_COVERAGE', 'UNIT_MISMATCH'], value: liquidationValue }],
  ['atm_iv_term', { support: ['COMPLETE', 'ADMITTED_SUBSET', 'PARTIAL_CENSUS', 'OVER_CAP', 'NO_OPTIONS', 'SCOPE_MISMATCH'], value: optionsValue }],
  ['supply_ratios', { support: ['COMPLETE'], value: supplyValue }],
  ['unlock_schedule', { support: ['COMPLETE', 'NO_UPCOMING_TRACKED'], value: unlockValue }],
  ['pool_liquidity', { support: ['COMPLETE', 'PARTIAL'], value: poolValue }],
  ['protocol_tvl', { support: ['COMPLETE', 'MISSING'], value: defiValue }],
  ['lending_rates', { support: ['COMPLETE', 'MISSING'], value: defiValue }],
  ['protocol_fees_revenue', { support: ['COMPLETE', 'MISSING'], value: defiValue }],
  ['exchange_net_flow', { support: ['COMPLETE', 'MISSING_LEG', 'RECIPE_MISMATCH', 'VALUE_MISSING'], value: netFlowValue }],
  ['exchange_reserve', { support: ['COMPLETE', 'MISSING'], value: onchainLatestValue }],
  ['holder_cohorts', { support: ['COMPLETE', 'MISSING'], value: onchainLatestValue }],
  ...NETWORK_METRICS.map((m) => [m, { support: ['COMPLETE', 'MISSING'], value: networkValue }]),
  ['stablecoin_supply_change', { support: ['COMPLETE', 'SINGLE_POINT'], value: stableValue }],
  ['etf_daily_flow', { support: ['COMPLETE', 'NO_FLOWS'], value: etfValue }],
  ['macro_level', { support: ['COMPLETE'], value: macroLevelValue }],
  ['macro_surprise', { support: ['COMPLETE'], value: macroSurpriseValue }],
  ['cross_asset_return', { support: ['COMPLETE', 'PARTIAL'], value: crossAssetValue }],
  ['event_references', { support: ['COMPLETE'], value: eventsValue }],
  ['provider_status', { support: ['COMPLETE'], value: infraValue }],
]));
export const SCHEMA_METRIC_IDS = Object.freeze(Object.keys(METRIC_SCHEMAS));
export const SUPPORT_STATES = deepFreeze(Object.fromEntries(SCHEMA_METRIC_IDS.map((m) => [m, METRIC_SCHEMAS[m].support])));

// validate one component's value against its metric's closed schema and its support state against the metric's list
export function componentValueError(component, where = 'value') {
  const schema = METRIC_SCHEMAS[component?.metricId];
  if (!schema) return `${where}: no closed schema for metric ${String(component?.metricId)}`;
  const se = contextSupportError(component.support, where.replace(/\.value$/, '.support')); if (se) return se;
  if (!schema.support.includes(component.support.state)) return `${where.replace(/\.value$/, '.support')}.state: ${component.support.state} is not a ${component.metricId} state (${schema.support.join('|')})`;
  return schema.value(component.value, where);
}
