import { OBSERVATION_SCHEMA_VERSION, MARKET_LAB_VERSION, AUTHORITY, PURPOSE, ERROR_CODES, EXIT_CODES, MAX_REASON_CHARS, boundedReason, MarketLabError, fail, isPlainObject, isTs, isTsOrNull, isCount, isFiniteNum, isNumOrNull, isPositive, isNonNegative, isBoundedString, isStringOrNull, isUnitFraction, safeType, sha256Hex, SHA256_RE, ID_RE, CODE_RE, COIN_RE, isId, isIdOrNull, isCode, isCoin, deepFreeze, round, cmp, canonicalJson, canonicalDigest, utf8Bytes, exactKeys, enumError, MAX_DTO_DEPTH, jsonShapeError, MAX_JSON_DEPTH, parseStrictJson, wellFormedString } from './contracts-core.js';
import { FAMILIES, PAYLOAD_KINDS, DARK_FAMILIES, DARK_PAYLOAD_KINDS, ALL_FAMILIES, DARK_FAMILY_LAW, isDarkFamily, isDarkKind, PROVIDER_IDS, SUBJECT_KINDS, MARKET_TYPES, QUALITY_STATES, QUALITY_REASON_CODES, SIDES, POSITION_SIDES, SIDE_CONVENTIONS, FUNDING_UNITS, OI_UNITS, NOTIONAL_UNITS, LINEARITY, OPTION_TYPES, TIME_PRECISIONS, UNLOCK_TYPES, SESSION_STATES, EVENT_KINDS, PROVIDER_STATUS_STATES, BOOK_SAMPLE_REASONS, BOOK_COVERAGE_STATES, DEFI_METRIC_IDS, ONCHAIN_METRIC_IDS, WHALE_METRIC_IDS, WHALE_METRIC_UNITS, STABLECOIN_METRIC_IDS, UNITS, ANALYTICS_TYPES, ANALYTICS_TYPES_UNSUPPORTED, ANALYTICS_VALUE_KEYS, ANALYTICS_INTERVALS_S, MANIPULATION_RISK, ANALYTICS_MANIPULATION_RISK, BUCKET_FINALITY, VINTAGES, UNIT_NORMALIZATIONS, L3_EVENTS, L3_SIDES, L3_COVERAGE_STATES, L3_SAMPLE_REASONS, L3_DEPTHS, MAX_L3_ORDERS_PER_SIDE, MAX_L3_EVENTS_PER_BATCH, L3_ORDER_KEY_RE, L3_ORDER_KEYS, L3_EVENT_KEYS, WINDOWS, KNOWN_CHAINS, FAMILY_REGISTRY, DARK_FAMILY_REGISTRY, darkFamilyMetricIds, familyMetricIds, metricUnit } from './contracts-registry.js';
// ---- payload schemas (closed, typed) ---------------------------------------------------------------------
const levelsError = (levels, side, cap) => {
  if (!Array.isArray(levels) || levels.length > cap) return `${side}: levels malformed or over ${cap}`;
  let prev = null;
  for (let i = 0; i < levels.length; i += 1) {
    const l = levels[i];
    if (!Array.isArray(l) || l.length !== 2 || !isPositive(l[0]) || !isNonNegative(l[1])) return `${side}: level ${i} malformed`;
    if (prev !== null && (side === 'bids' ? l[0] >= prev : l[0] <= prev)) return `${side}: level ${i} not strictly ordered from the touch`;
    prev = l[0];
  }
  return null;
};
export const MAX_BOOK_LEVELS = 200;
export const MAX_CATEGORIES = 32;
export const MAX_PLATFORMS = 32;
export const MAX_TEXT_CHARS = 300;
const numOrNullKeys = (p, keys, where) => { for (const k of keys) if (!isNumOrNull(p[k])) return `${where}: ${k} must be a finite number or null`; return null; };
const nonNegOrNullKeys = (p, keys, where) => { for (const k of keys) if (!(p[k] === null || isNonNegative(p[k]))) return `${where}: ${k} must be >= 0 or null`; return null; };

export const PAYLOAD_KEYS = deepFreeze({
  TRADE: ['price', 'qty', 'quoteNotional', 'takerSide', 'sideConvention', 'nativeTradeId', 'orderType'],
  BOOK_SNAPSHOT: ['bids', 'asks', 'levelsPerSideCap', 'synchronized', 'checksumVerified', 'bookAgeMs', 'sampleReason', 'pricePrecision', 'qtyPrecision'],
  BOOK_COVERAGE: ['state', 'reason', 'sinceTs', 'untilTs', 'droppedUpdates'],
  CANDLE: ['intervalMs', 'open', 'high', 'low', 'close', 'volumeBase', 'volumeQuote', 'tradeCount', 'vwap', 'closed', 'provisional'],
  INSTRUMENT: ['status', 'base', 'quote', 'marketType', 'pricePrecision', 'qtyPrecision', 'priceIncrement', 'qtyIncrement', 'contractSize', 'linearity', 'settlementCurrency', 'underlying', 'expiryTs', 'strike', 'optionType', 'quoteAliasGroup', 'tradeable', 'fundingIntervalMs', 'fundingUnit'],
  DERIVATIVE_TICK: ['markPrice', 'indexPrice', 'lastPrice', 'bid', 'ask', 'openInterest', 'openInterestUnit', 'fundingRateNative', 'fundingUnit', 'fundingIntervalMs', 'fundingRelative', 'fundingPredictedNative', 'nextFundingTs', 'volume24hBase', 'volume24hQuote', 'contractMultiplier', 'settlementCurrency', 'linearity'],
  LIQUIDATION: ['forcedOrderSide', 'liquidatedPositionSide', 'qtyBase', 'price', 'notional', 'notionalUnit', 'aggregated', 'aggregationIntervalMs', 'longNotional', 'shortNotional', 'venueScope'],
  ASSET_REFERENCE: ['providerAssetId', 'name', 'symbolNative', 'marketCapUsd', 'fdvUsd', 'circulatingSupply', 'totalSupply', 'maxSupply', 'priceUsd', 'volume24hUsd', 'categories', 'platforms', 'capMethodologyId', 'lastUpdatedTs'],
  UNLOCK_EVENT: ['eventId', 'scheduledTs', 'timePrecision', 'amountToken', 'amountUsd', 'recipientCategory', 'unlockType', 'tracked', 'allocationName', 'totalLocked', 'totalUnlocked', 'totalUntracked', 'circulatingSupply', 'scheduleVersion'],
  DEX_POOL: ['chain', 'poolAddress', 'dex', 'baseToken', 'quoteToken', 'priceUsd', 'priceQuote', 'liquidityUsd', 'volume24hUsd', 'volume1hUsd', 'txCount24h', 'poolCreatedTs', 'feePct'],
  DEFI_METRIC: ['metricId', 'value', 'unit', 'chain', 'protocol', 'periodKind', 'methodologyId'],
  ONCHAIN_METRIC: ['metricId', 'value', 'unit', 'entitySet', 'chain', 'window', 'methodologyId', 'labelVintage'],
  STABLECOIN_METRIC: ['metricId', 'value', 'unit', 'chain', 'stablecoinId', 'pegCurrency'],
  ETF_FLOW: ['fund', 'asset', 'flowUsd', 'reportingPeriodStartTs', 'reportingPeriodEndTs', 'estimate', 'revision', 'priceUsd'],
  ECONOMIC_EVENT: ['eventName', 'countryCode', 'scheduledTs', 'timePrecision', 'forecastRaw', 'actualRaw', 'previousRaw', 'revisedPreviousRaw', 'forecastValue', 'actualValue', 'previousValue', 'unit', 'importance', 'forecastKnownAtTs', 'actualKnownAtTs'],
  EVENT_REFERENCE: ['eventKind', 'sourceProvider', 'nativeRef', 'sourceEventTs', 'headline', 'untrusted', 'status'],
  PROVIDER_STATUS: ['providerId', 'status', 'component', 'incidentRef'],
  // MARKET-EDGE-KRAKEN-1 (dark): one Charts analytics bucket; one L3 book snapshot; one batch of L3 order events (one WS
  // message); one L3 coverage transition. Clocks: bucketTs = the provider bucket timestamp (period start), periodEndTs =
  // bucketTs + intervalMs; finality FINAL only when the bucket closed at or before receipt; knownAtTs >= receivedTs always.
  DERIVATIVE_ANALYTIC_BUCKET: ['analyticsType', 'intervalMs', 'bucketTs', 'values', 'nativeUnit', 'normalizedUnit', 'normalization', 'finality', 'manipulationRisk', 'vintage', 'pageIndex', 'more'],
  L3_BOOK_SNAPSHOT: ['depth', 'bids', 'asks', 'checksumVerified', 'synchronized', 'sampleReason', 'truncated', 'pricePrecision', 'qtyPrecision'],
  L3_ORDER_EVENT: ['depth', 'events', 'checksumVerified'],
  L3_BOOK_COVERAGE: ['state', 'reason', 'sinceTs', 'untilTs', 'droppedUpdates', 'depth', 'ordersTracked'],
});
const l3OrdersError = (orders, side, cap) => {
  if (!Array.isArray(orders) || orders.length > cap) return `${side}: orders malformed or over ${cap}`;
  let prev = null;
  for (let i = 0; i < orders.length; i += 1) {
    const o = orders[i]; const e = exactKeys(o, L3_ORDER_KEYS, `${side}[${i}]`); if (e) return e;
    if (!L3_ORDER_KEY_RE.test(String(o.orderKey)) || !isPositive(o.price) || !isNonNegative(o.qty)) return `${side}: order ${i} malformed`;
    if (!isTsOrNull(o.providerTs) || !isTs(o.firstSeenTs) || !isTsOrNull(o.modifiedTs) || (o.modifiedTs !== null && o.modifiedTs < o.firstSeenTs)) return `${side}: order ${i} clocks malformed`;
    if (prev !== null && (side === 'bids' ? o.price > prev : o.price < prev)) return `${side}: order ${i} not ordered from the touch`; // equal prices = queue order within a level
    prev = o.price;
  }
  return null;
};
const l3EventsError = (events, where) => {
  if (!Array.isArray(events) || events.length > MAX_L3_EVENTS_PER_BATCH) return `${where}: events malformed or over ${MAX_L3_EVENTS_PER_BATCH}`;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]; const e = exactKeys(ev, L3_EVENT_KEYS, `${where}[${i}]`); if (e) return e;
    if (!L3_EVENTS.includes(ev.event) || !L3_SIDES.includes(ev.side) || !L3_ORDER_KEY_RE.test(String(ev.orderKey))) return `${where}[${i}]: vocabulary`;
    if (!isPositive(ev.price) || !isNonNegative(ev.qty) || !(ev.previousQty === null || isNonNegative(ev.previousQty))) return `${where}[${i}]: quantities malformed`;
    if (!isTsOrNull(ev.providerTs) || !isTs(ev.firstSeenTs) || !(ev.ageMs === null || isCount(ev.ageMs))) return `${where}[${i}]: clocks malformed`;
    if (ev.event === 'ADD' && ev.previousQty !== null) return `${where}[${i}]: an ADD has no previous quantity`;
    if (ev.event === 'MODIFY' && ev.previousQty === null) return `${where}[${i}]: a MODIFY carries its previous quantity`;
  }
  return null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDateOnly = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const ohlcError = (p, where) => {
  if (![p.open, p.high, p.low, p.close].every((x) => x === null || isPositive(x))) return `${where}: ohlc must be positive or null`;
  const present = [p.open, p.high, p.low, p.close].filter((x) => x !== null);
  if (present.length !== 0 && present.length !== 4) return `${where}: ohlc must be complete or entirely null`;
  if (present.length === 4 && (p.high < Math.max(p.open, p.close) || p.low > Math.min(p.open, p.close) || p.high < p.low)) return `${where}: ohlc internally inconsistent`;
  return null;
};

export function payloadError(kind, p, where = 'payload') {
  if (!PAYLOAD_KINDS.includes(kind)) return `${where}: unknown kind`;
  const k = exactKeys(p, PAYLOAD_KEYS[kind], where); if (k) return k;
  let e = null;
  switch (kind) {
    case 'TRADE':
      if (!isPositive(p.price) || !isPositive(p.qty)) return `${where}: price and qty must be positive`;
      if (!isNonNegative(p.quoteNotional) || Math.abs(p.quoteNotional - p.price * p.qty) > 1e-6 * Math.max(1, p.quoteNotional)) return `${where}: quoteNotional must equal price*qty`;
      if (!SIDES.includes(p.takerSide) || !SIDE_CONVENTIONS.includes(p.sideConvention)) return `${where}: side vocabulary`;
      if (p.takerSide !== 'UNKNOWN' && p.sideConvention === 'UNKNOWN') return `${where}: a known taker side needs a known convention`;
      if (!isIdOrNull(p.nativeTradeId) || !isStringOrNull(p.orderType, 32)) return `${where}: trade identity malformed`;
      return null;
    case 'BOOK_SNAPSHOT':
      if (!isCount(p.levelsPerSideCap) || p.levelsPerSideCap > MAX_BOOK_LEVELS) return `${where}: levelsPerSideCap malformed`;
      e = levelsError(p.bids, 'bids', p.levelsPerSideCap) ?? levelsError(p.asks, 'asks', p.levelsPerSideCap); if (e) return `${where}: ${e}`;
      if (p.bids.length > 0 && p.asks.length > 0 && p.bids[0][0] >= p.asks[0][0]) return `${where}: crossed book`;
      if (typeof p.synchronized !== 'boolean') return `${where}: synchronized must be boolean`;
      if (!(p.checksumVerified === null || typeof p.checksumVerified === 'boolean')) return `${where}: checksumVerified malformed`;
      if (!(p.bookAgeMs === null || isCount(p.bookAgeMs))) return `${where}: bookAgeMs malformed`;
      if (!BOOK_SAMPLE_REASONS.includes(p.sampleReason)) return `${where}: sampleReason vocabulary`;
      if (!(p.pricePrecision === null || isCount(p.pricePrecision)) || !(p.qtyPrecision === null || isCount(p.qtyPrecision))) return `${where}: precision malformed`;
      return null;
    case 'BOOK_COVERAGE':
      if (!BOOK_COVERAGE_STATES.includes(p.state) || !QUALITY_REASON_CODES.includes(p.reason)) return `${where}: vocabulary`;
      if (!isTs(p.sinceTs) || !isTsOrNull(p.untilTs) || (p.untilTs !== null && p.untilTs < p.sinceTs)) return `${where}: interval malformed`;
      if (!isCount(p.droppedUpdates)) return `${where}: droppedUpdates malformed`;
      return null;
    case 'CANDLE':
      if (!isTs(p.intervalMs)) return `${where}: intervalMs malformed`;
      e = ohlcError(p, where); if (e) return e;
      if (!(p.volumeBase === null || isNonNegative(p.volumeBase)) || !(p.volumeQuote === null || isNonNegative(p.volumeQuote))) return `${where}: volume malformed`;
      if (!(p.tradeCount === null || isCount(p.tradeCount)) || !(p.vwap === null || isPositive(p.vwap))) return `${where}: count/vwap malformed`;
      if (typeof p.closed !== 'boolean' || typeof p.provisional !== 'boolean' || p.closed === p.provisional) return `${where}: closed XOR provisional`;
      if (p.open === null && p.volumeBase !== 0 && p.volumeBase !== null) return `${where}: a no-trade candle carries null prices, not invented ones`;
      return null;
    case 'INSTRUMENT':
      if (!isBoundedString(p.status, 32) || !isId(p.base) || !isId(p.quote) || !MARKET_TYPES.includes(p.marketType)) return `${where}: instrument identity malformed`;
      if (!(p.pricePrecision === null || isCount(p.pricePrecision)) || !(p.qtyPrecision === null || isCount(p.qtyPrecision))) return `${where}: precision malformed`;
      if (!(p.priceIncrement === null || isPositive(p.priceIncrement)) || !(p.qtyIncrement === null || isPositive(p.qtyIncrement)) || !(p.contractSize === null || isPositive(p.contractSize))) return `${where}: increments malformed`;
      if (!LINEARITY.includes(p.linearity) || !isIdOrNull(p.settlementCurrency) || !isIdOrNull(p.underlying) || !isTsOrNull(p.expiryTs)) return `${where}: specification malformed`;
      if (!(p.strike === null || isPositive(p.strike)) || !(p.optionType === null || OPTION_TYPES.includes(p.optionType))) return `${where}: option fields malformed`;
      if (p.marketType === 'OPTION' && (p.strike === null || p.optionType === null || p.expiryTs === null)) return `${where}: an option needs strike, type and expiry`;
      if (p.marketType === 'SPOT' && (p.strike !== null || p.optionType !== null || p.expiryTs !== null)) return `${where}: spot carries no derivative specification`;
      if (!isIdOrNull(p.quoteAliasGroup) || !(p.tradeable === null || typeof p.tradeable === 'boolean')) return `${where}: alias/tradeable malformed`;
      if (!(p.fundingIntervalMs === null || isTs(p.fundingIntervalMs)) || !FUNDING_UNITS.includes(p.fundingUnit)) return `${where}: funding specification malformed`;
      return null;
    case 'DERIVATIVE_TICK':
      e = numOrNullKeys(p, ['markPrice', 'indexPrice', 'lastPrice', 'bid', 'ask', 'fundingRateNative', 'fundingRelative', 'fundingPredictedNative'], where); if (e) return e;
      e = nonNegOrNullKeys(p, ['openInterest', 'volume24hBase', 'volume24hQuote'], where); if (e) return e;
      for (const k of ['markPrice', 'indexPrice', 'lastPrice', 'bid', 'ask']) if (p[k] !== null && p[k] <= 0) return `${where}: ${k} must be positive`;
      if (!OI_UNITS.includes(p.openInterestUnit) || !FUNDING_UNITS.includes(p.fundingUnit) || !LINEARITY.includes(p.linearity)) return `${where}: unit vocabulary`;
      if (p.openInterest !== null && p.openInterestUnit === 'UNKNOWN') return `${where}: an open interest value needs a known unit`;
      if (p.fundingRateNative !== null && p.fundingUnit === 'UNKNOWN') return `${where}: a funding value needs a known native unit`;
      if (p.fundingUnit === 'FRACTION_PER_INTERVAL' && p.fundingRateNative !== null && Math.abs(p.fundingRateNative) > 0.1) return `${where}: a fractional funding rate outside +-10% per interval is not a fraction`;
      if (!(p.fundingIntervalMs === null || isTs(p.fundingIntervalMs)) || !isTsOrNull(p.nextFundingTs)) return `${where}: funding clocks malformed`;
      if (p.fundingRateNative !== null && p.fundingIntervalMs === null) return `${where}: a funding value needs its interval`;
      if (!(p.contractMultiplier === null || isPositive(p.contractMultiplier)) || !isIdOrNull(p.settlementCurrency)) return `${where}: contract specification malformed`;
      if (p.bid !== null && p.ask !== null && p.bid > p.ask) return `${where}: crossed quote`;
      return null;
    case 'LIQUIDATION':
      if (!SIDES.includes(p.forcedOrderSide) || !POSITION_SIDES.includes(p.liquidatedPositionSide)) return `${where}: side vocabulary`;
      if (typeof p.aggregated !== 'boolean' || !NOTIONAL_UNITS.includes(p.notionalUnit) || !isIdOrNull(p.venueScope)) return `${where}: aggregation malformed`;
      e = nonNegOrNullKeys(p, ['qtyBase', 'notional', 'longNotional', 'shortNotional'], where); if (e) return e;
      if (!(p.price === null || isPositive(p.price))) return `${where}: price malformed`;
      if (!(p.aggregationIntervalMs === null || isTs(p.aggregationIntervalMs))) return `${where}: aggregationIntervalMs malformed`;
      if (p.aggregated) { if (p.aggregationIntervalMs === null) return `${where}: aggregated liquidations need an interval`; if (p.qtyBase !== null) return `${where}: aggregated liquidations carry no single quantity`; }
      else { if (p.longNotional !== null || p.shortNotional !== null) return `${where}: a single liquidation carries no side totals`; if (p.forcedOrderSide !== 'UNKNOWN' && p.liquidatedPositionSide !== 'UNKNOWN' && ((p.forcedOrderSide === 'SELL') !== (p.liquidatedPositionSide === 'LONG'))) return `${where}: forced-order side contradicts liquidated position side`; }
      if ((p.notional !== null || p.longNotional !== null || p.shortNotional !== null) && p.notionalUnit === 'UNKNOWN') return `${where}: a notional needs a unit`;
      return null;
    case 'ASSET_REFERENCE':
      if (!isId(p.providerAssetId) || !isStringOrNull(p.name, 120) || !isId(p.symbolNative) || !isId(p.capMethodologyId)) return `${where}: reference identity malformed`;
      e = nonNegOrNullKeys(p, ['marketCapUsd', 'fdvUsd', 'circulatingSupply', 'totalSupply', 'maxSupply', 'priceUsd', 'volume24hUsd'], where); if (e) return e;
      if (p.maxSupply !== null && p.totalSupply !== null && p.totalSupply > p.maxSupply * (1 + 1e-9)) return `${where}: total supply exceeds max supply`;
      if (p.circulatingSupply !== null && p.totalSupply !== null && p.circulatingSupply > p.totalSupply * (1 + 1e-9)) return `${where}: circulating exceeds total`;
      if (!Array.isArray(p.categories) || p.categories.length > MAX_CATEGORIES || p.categories.some((c) => !isBoundedString(c, 80)) || new Set(p.categories).size !== p.categories.length) return `${where}: categories malformed`;
      if (!isPlainObject(p.platforms) || Object.keys(p.platforms).length > MAX_PLATFORMS || Object.entries(p.platforms).some(([c, a]) => !isId(c) || !isIdOrNull(a))) return `${where}: platforms malformed`;
      if (!isTsOrNull(p.lastUpdatedTs)) return `${where}: lastUpdatedTs malformed`;
      return null;
    case 'UNLOCK_EVENT':
      if (!isId(p.eventId) || !isTsOrNull(p.scheduledTs) || !TIME_PRECISIONS.includes(p.timePrecision) || !UNLOCK_TYPES.includes(p.unlockType)) return `${where}: unlock identity malformed`;
      if (p.scheduledTs !== null && p.timePrecision === 'UNKNOWN') return `${where}: a scheduled clock needs a precision`;
      e = nonNegOrNullKeys(p, ['amountToken', 'amountUsd', 'totalLocked', 'totalUnlocked', 'totalUntracked', 'circulatingSupply'], where); if (e) return e;
      if (typeof p.tracked !== 'boolean' || !isStringOrNull(p.recipientCategory, 80) || !isStringOrNull(p.allocationName, 120) || !isIdOrNull(p.scheduleVersion)) return `${where}: unlock fields malformed`;
      if (!p.tracked && p.amountToken !== null) return `${where}: an untracked allocation has no amount`;
      return null;
    case 'DEX_POOL':
      if (!isId(p.chain) || !isId(p.poolAddress) || !isIdOrNull(p.dex) || !isId(p.baseToken) || !isId(p.quoteToken)) return `${where}: pool identity malformed`;
      e = nonNegOrNullKeys(p, ['priceUsd', 'priceQuote', 'liquidityUsd', 'volume24hUsd', 'volume1hUsd', 'feePct'], where); if (e) return e;
      if (!(p.txCount24h === null || isCount(p.txCount24h)) || !isTsOrNull(p.poolCreatedTs)) return `${where}: pool activity malformed`;
      return null;
    case 'DEFI_METRIC':
      if (!DEFI_METRIC_IDS.includes(p.metricId) || !isNumOrNull(p.value) || !UNITS.includes(p.unit) || !isIdOrNull(p.chain) || !isIdOrNull(p.protocol) || !['POINT', 'DAILY'].includes(p.periodKind) || !isId(p.methodologyId)) return `${where}: defi metric malformed`;
      if (p.value !== null && p.unit === 'UNKNOWN') return `${where}: a value needs a unit`;
      return null;
    case 'ONCHAIN_METRIC':
      if (!ONCHAIN_METRIC_IDS.includes(p.metricId) || !isNumOrNull(p.value) || !UNITS.includes(p.unit) || !isIdOrNull(p.entitySet) || !isId(p.chain) || !WINDOWS.includes(p.window) || !isId(p.methodologyId) || !isIdOrNull(p.labelVintage)) return `${where}: onchain metric malformed`;
      if (p.value !== null && p.unit === 'UNKNOWN') return `${where}: a value needs a unit`;
      if (['exchange_inflow', 'exchange_outflow', 'exchange_netflow', 'exchange_reserve'].includes(p.metricId) && p.entitySet === null) return `${where}: an exchange-flow metric needs its entity set`;
      return null;
    case 'STABLECOIN_METRIC':
      if (!STABLECOIN_METRIC_IDS.includes(p.metricId) || !isNumOrNull(p.value) || !UNITS.includes(p.unit) || !isIdOrNull(p.chain) || !isId(p.stablecoinId) || !isId(p.pegCurrency)) return `${where}: stablecoin metric malformed`;
      if (p.metricId === 'peg_price' && p.value !== null && p.value <= 0) return `${where}: peg price must be positive`;
      return null;
    case 'ETF_FLOW':
      if (!isIdOrNull(p.fund) || !isId(p.asset) || !isNumOrNull(p.flowUsd) || !isTs(p.reportingPeriodStartTs) || !isTs(p.reportingPeriodEndTs) || p.reportingPeriodEndTs < p.reportingPeriodStartTs) return `${where}: etf flow malformed`;
      if (typeof p.estimate !== 'boolean' || !isIdOrNull(p.revision) || !(p.priceUsd === null || isPositive(p.priceUsd))) return `${where}: etf fields malformed`;
      return null;
    case 'ECONOMIC_EVENT':
      if (!isBoundedString(p.eventName, MAX_TEXT_CHARS) || !isBoundedString(p.countryCode, 8) || !isTsOrNull(p.scheduledTs) || !TIME_PRECISIONS.includes(p.timePrecision)) return `${where}: economic event malformed`;
      for (const k of ['forecastRaw', 'actualRaw', 'previousRaw', 'revisedPreviousRaw']) if (!isStringOrNull(p[k], 40)) return `${where}: ${k} malformed`;
      e = numOrNullKeys(p, ['forecastValue', 'actualValue', 'previousValue'], where); if (e) return e;
      if (!(p.unit === null || UNITS.includes(p.unit)) || !(p.importance === null || (isCount(p.importance) && p.importance <= 3))) return `${where}: unit/importance malformed`;
      if (!isTsOrNull(p.forecastKnownAtTs) || !isTsOrNull(p.actualKnownAtTs)) return `${where}: knowledge clocks malformed`;
      if (p.actualValue !== null && p.actualKnownAtTs === null) return `${where}: an actual value needs its knowledge clock`;
      if (p.forecastValue !== null && p.forecastKnownAtTs === null) return `${where}: a forecast needs its knowledge clock`;
      return null;
    case 'EVENT_REFERENCE':
      if (!EVENT_KINDS.includes(p.eventKind) || !isId(p.sourceProvider) || !isId(p.nativeRef) || !isTsOrNull(p.sourceEventTs) || !isStringOrNull(p.headline, MAX_TEXT_CHARS) || typeof p.untrusted !== 'boolean' || !isStringOrNull(p.status, 40)) return `${where}: event reference malformed`;
      if (p.headline !== null && !p.untrusted) return `${where}: provider text is untrusted by law`;
      return null;
    case 'PROVIDER_STATUS':
      if (!isId(p.providerId) || !PROVIDER_STATUS_STATES.includes(p.status) || !isStringOrNull(p.component, 80) || !isIdOrNull(p.incidentRef)) return `${where}: provider status malformed`;
      return null;
    case 'DERIVATIVE_ANALYTIC_BUCKET':
      if (!ANALYTICS_TYPES.includes(p.analyticsType) || !ANALYTICS_INTERVALS_S.includes(p.intervalMs / 1000) || !isTs(p.bucketTs)) return `${where}: analytics identity malformed`;
      if (p.bucketTs % p.intervalMs !== 0) return `${where}: bucketTs is not aligned to its interval`;
      if (!(p.values === null || isPlainObject(p.values))) return `${where}: values must be an object or null`;
      if (p.values !== null) { const ke = exactKeys(p.values, ANALYTICS_VALUE_KEYS[p.analyticsType], `${where}.values`); if (ke) return ke; e = numOrNullKeys(p.values, ANALYTICS_VALUE_KEYS[p.analyticsType], `${where}.values`); if (e) return e; if (ANALYTICS_VALUE_KEYS[p.analyticsType].every((k) => p.values[k] === null)) return `${where}: an all-null bucket carries null values, not an empty object`; }
      if (!isStringOrNull(p.nativeUnit, 80) || !UNITS.includes(p.normalizedUnit) || !UNIT_NORMALIZATIONS.includes(p.normalization)) return `${where}: unit vocabulary`;
      if (p.normalization === 'NONE' && p.normalizedUnit !== 'NATIVE') return `${where}: an unnormalized bucket is NATIVE (a unit is never inferred from magnitude)`;
      if (p.normalization === 'IDENTITY' && (p.nativeUnit === null || p.normalizedUnit === 'NATIVE' || p.normalizedUnit === 'UNKNOWN')) return `${where}: an IDENTITY normalization names both units`;
      if (!BUCKET_FINALITY.includes(p.finality) || !MANIPULATION_RISK.includes(p.manipulationRisk) || !VINTAGES.includes(p.vintage)) return `${where}: finality/risk/vintage vocabulary`;
      if (p.manipulationRisk !== ANALYTICS_MANIPULATION_RISK[p.analyticsType]) return `${where}: manipulation risk disagrees with the documented class`;
      if (!isCount(p.pageIndex) || typeof p.more !== 'boolean') return `${where}: pagination fields malformed`;
      return null;
    case 'L3_BOOK_SNAPSHOT':
      if (!L3_DEPTHS.includes(p.depth)) return `${where}: depth outside the documented set`;
      e = l3OrdersError(p.bids, 'bids', MAX_L3_ORDERS_PER_SIDE) ?? l3OrdersError(p.asks, 'asks', MAX_L3_ORDERS_PER_SIDE); if (e) return `${where}: ${e}`;
      if (p.bids.length > 0 && p.asks.length > 0 && p.bids[0].price >= p.asks[0].price) return `${where}: crossed book`;
      if (new Set([...p.bids, ...p.asks].map((o) => o.orderKey)).size !== p.bids.length + p.asks.length) return `${where}: duplicate order identity`;
      if (!(p.checksumVerified === null || typeof p.checksumVerified === 'boolean') || typeof p.synchronized !== 'boolean' || typeof p.truncated !== 'boolean') return `${where}: flags malformed`;
      if (!L3_SAMPLE_REASONS.includes(p.sampleReason)) return `${where}: sampleReason vocabulary`;
      if (!(p.pricePrecision === null || isCount(p.pricePrecision)) || !(p.qtyPrecision === null || isCount(p.qtyPrecision))) return `${where}: precision malformed`;
      return null;
    case 'L3_ORDER_EVENT':
      if (!L3_DEPTHS.includes(p.depth)) return `${where}: depth outside the documented set`;
      e = l3EventsError(p.events, `${where}.events`); if (e) return e;
      if (!(p.checksumVerified === null || typeof p.checksumVerified === 'boolean')) return `${where}: checksumVerified malformed`;
      return null;
    case 'L3_BOOK_COVERAGE':
      if (!L3_COVERAGE_STATES.includes(p.state) || !QUALITY_REASON_CODES.includes(p.reason)) return `${where}: vocabulary`;
      if (!isTs(p.sinceTs) || !isTsOrNull(p.untilTs) || (p.untilTs !== null && p.untilTs < p.sinceTs)) return `${where}: interval malformed`;
      if (!isCount(p.droppedUpdates) || !L3_DEPTHS.includes(p.depth) || !isCount(p.ordersTracked)) return `${where}: counters malformed`;
      return null;
    default: return `${where}: unknown kind`;
  }
}

// The "primary value" of each kind: KNOWN requires it admissible; MISSING/UNAVAILABLE/FAILED/NOT_SUPPORTED require null.
const PRIMARY_VALUE_KEYS = deepFreeze({
  TRADE: ['price'], BOOK_SNAPSHOT: ['bids'], BOOK_COVERAGE: ['state'], CANDLE: ['close'], INSTRUMENT: ['status'], DERIVATIVE_TICK: ['markPrice', 'indexPrice', 'lastPrice', 'openInterest', 'fundingRateNative'],
  LIQUIDATION: ['notional', 'longNotional', 'shortNotional', 'qtyBase'], ASSET_REFERENCE: ['priceUsd', 'marketCapUsd', 'circulatingSupply'], UNLOCK_EVENT: ['scheduledTs', 'amountToken'],
  DEX_POOL: ['priceUsd', 'liquidityUsd'], DEFI_METRIC: ['value'], ONCHAIN_METRIC: ['value'], STABLECOIN_METRIC: ['value'], ETF_FLOW: ['flowUsd'], ECONOMIC_EVENT: ['scheduledTs', 'actualValue', 'forecastValue'],
  EVENT_REFERENCE: ['nativeRef'], PROVIDER_STATUS: ['status'],
  DERIVATIVE_ANALYTIC_BUCKET: ['values'], L3_BOOK_SNAPSHOT: ['bids', 'asks'], L3_ORDER_EVENT: ['events'], L3_BOOK_COVERAGE: ['state'],
});
const NULL_VALUE_STATES = new Set(['MISSING', 'UNAVAILABLE', 'FAILED', 'NOT_SUPPORTED']);
export const VALUE_BEARING = (kind, p) => PRIMARY_VALUE_KEYS[kind].some((k) => p[k] !== null && !(Array.isArray(p[k]) && p[k].length === 0));

// ---- quality + provenance ---------------------------------------------------------------------------------
export const QUALITY_KEYS = Object.freeze(['state', 'reasonCodes', 'coverageStartTs', 'coverageEndTs', 'completeness', 'methodologyId', 'originalUnit']);
export const PROVENANCE_KEYS = Object.freeze(['requestId', 'bytesSha256', 'nativeLocator', 'mappingId', 'specificationId', 'vintage']);
export function qualityError(q, kind, p, where = 'quality') {
  const k = exactKeys(q, QUALITY_KEYS, where); if (k) return k;
  if (!QUALITY_STATES.includes(q.state)) return `${where}: state outside vocabulary`;
  if (!Array.isArray(q.reasonCodes) || q.reasonCodes.length > 8 || q.reasonCodes.some((r) => !QUALITY_REASON_CODES.includes(r)) || new Set(q.reasonCodes).size !== q.reasonCodes.length) return `${where}: reasonCodes malformed`;
  if (!isTsOrNull(q.coverageStartTs) || !isTsOrNull(q.coverageEndTs) || (q.coverageStartTs !== null && q.coverageEndTs !== null && q.coverageEndTs < q.coverageStartTs)) return `${where}: coverage interval malformed`;
  if (!(q.completeness === null || isUnitFraction(q.completeness))) return `${where}: completeness must be a unit fraction or null`;
  if (!isIdOrNull(q.methodologyId) || !isStringOrNull(q.originalUnit, 40)) return `${where}: methodology/unit malformed`;
  const bearing = VALUE_BEARING(kind, p);
  if (q.state === 'KNOWN' && !bearing) return `${where}: KNOWN requires an admissible primary value`;
  if (NULL_VALUE_STATES.has(q.state) && bearing) return `${where}: ${q.state} carries null values, never a number`;
  if (q.state === 'PARTIAL' && q.reasonCodes.length === 0) return `${where}: PARTIAL must say what is missing`;
  if (q.state === 'PARTIAL' && q.completeness === 1) return `${where}: PARTIAL cannot claim complete coverage`;
  const provisionalBucket = kind === 'DERIVATIVE_ANALYTIC_BUCKET' && p.finality === 'PROVISIONAL';
  if (q.state === 'PROVISIONAL' && !(kind === 'CANDLE' && p.provisional === true) && !provisionalBucket) return `${where}: PROVISIONAL is the uncommitted-candle / in-progress-bucket state only`;
  if (kind === 'CANDLE' && p.provisional === true && q.state !== 'PROVISIONAL') return `${where}: an uncommitted candle is PROVISIONAL`;
  if (provisionalBucket && (q.state !== 'PROVISIONAL' || !q.reasonCodes.includes('UNCOMMITTED_BAR'))) return `${where}: an in-progress analytics bucket is PROVISIONAL with reason UNCOMMITTED_BAR`;
  if (q.state === 'CLOCK_CONFLICT' && !q.reasonCodes.includes('SOURCE_EVENT_AHEAD_OF_RECEIPT')) return `${where}: CLOCK_CONFLICT needs its reason`;
  if (q.state === 'STALE' && !q.reasonCodes.includes('STALE_BY_POLICY') && !q.reasonCodes.includes('DELAYED_DATA')) return `${where}: STALE needs a staleness reason`;
  return null;
}
export function provenanceError(pv, where = 'provenance') {
  const k = exactKeys(pv, PROVENANCE_KEYS, where); if (k) return k;
  if (!isIdOrNull(pv.requestId) || !(pv.bytesSha256 === null || (typeof pv.bytesSha256 === 'string' && SHA256_RE.test(pv.bytesSha256)))) return `${where}: request/bytes malformed`;
  if (!isIdOrNull(pv.nativeLocator) || !isIdOrNull(pv.mappingId) || !isIdOrNull(pv.specificationId) || !isIdOrNull(pv.vintage)) return `${where}: locator/mapping/vintage malformed`;
  return null;
}
