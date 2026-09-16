import { OBSERVATION_SCHEMA_VERSION, MARKET_LAB_VERSION, AUTHORITY, PURPOSE, ERROR_CODES, EXIT_CODES, MAX_REASON_CHARS, boundedReason, MarketLabError, fail, isPlainObject, isTs, isTsOrNull, isCount, isFiniteNum, isNumOrNull, isPositive, isNonNegative, isBoundedString, isStringOrNull, isUnitFraction, safeType, sha256Hex, SHA256_RE, ID_RE, CODE_RE, COIN_RE, isId, isIdOrNull, isCode, isCoin, deepFreeze, round, cmp, canonicalJson, canonicalDigest, utf8Bytes, exactKeys, enumError, MAX_DTO_DEPTH, jsonShapeError, MAX_JSON_DEPTH, parseStrictJson, wellFormedString } from './contracts-core.js';
// ---- closed vocabularies ---------------------------------------------------------------------------------
export const FAMILIES = Object.freeze(['SPOT_PRICE_CHART', 'SPOT_FLOW', 'DISPLAYED_LIQUIDITY', 'CROSS_VENUE', 'DERIVATIVES_FUNDING_OI', 'LIQUIDATIONS', 'OPTIONS_TERM_SKEW', 'SUPPLY_UNLOCKS', 'DEX_DEFI', 'ONCHAIN_ENTITY_FLOW', 'NETWORK_ACTIVITY', 'STABLECOIN_LIQUIDITY', 'ETF_FLOWS', 'MACRO_RELEASES', 'OFFICIAL_SOCIAL_EVENTS', 'INFRASTRUCTURE_STATUS']);
export const PAYLOAD_KINDS = Object.freeze(['TRADE', 'BOOK_SNAPSHOT', 'BOOK_COVERAGE', 'CANDLE', 'INSTRUMENT', 'DERIVATIVE_TICK', 'LIQUIDATION', 'OPTION_TICK', 'ASSET_REFERENCE', 'UNLOCK_EVENT', 'DEX_POOL', 'DEFI_METRIC', 'ONCHAIN_METRIC', 'STABLECOIN_METRIC', 'ETF_FLOW', 'MACRO_OBSERVATION', 'ECONOMIC_EVENT', 'EVENT_REFERENCE', 'PROVIDER_STATUS', 'DERIVATIVE_ANALYTIC_BUCKET', 'L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE']);
// MARKET-EDGE-KRAKEN-1 — DARK research families. They are deliberately NOT members of FAMILIES: every generic consumer of the
// decision vocabulary (FAMILY_REGISTRY -> the Socrates broker metric registry, the evidence METRIC_MAP, readiness, the
// coverage matrix, the context builder, the Socrates v2 contract) iterates FAMILIES and therefore never sees them. They live
// only in the closed observation / coverage / store / retention contracts, the dark recipes and the dark evaluation harness.
export const DARK_FAMILIES = Object.freeze(['DERIVATIVES_PRESSURE', 'L3_MICROSTRUCTURE']);
export const DARK_PAYLOAD_KINDS = Object.freeze(['DERIVATIVE_ANALYTIC_BUCKET', 'L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE']);
export const ALL_FAMILIES = Object.freeze([...FAMILIES, ...DARK_FAMILIES]);
export const DARK_FAMILY_LAW = 'MARKET-EDGE-KRAKEN-1: dark families carry no trading, Judge or Socrates authority; they never enter Judge intake / features, Socrates broker requests, decision evidence, readiness, thresholds, execution, the Watch or the paper / live adapters';
export const isDarkFamily = (f) => DARK_FAMILIES.includes(f);
export const isDarkKind = (k) => DARK_PAYLOAD_KINDS.includes(k);
export const PROVIDER_IDS = Object.freeze(['KRAKEN_SPOT', 'COINBASE_SPOT', 'KRAKEN_DERIVATIVES', 'DERIBIT', 'BYBIT', 'COINGECKO', 'GECKOTERMINAL', 'DEFILLAMA', 'COINGLASS', 'CRYPTOQUANT', 'SANTIMENT', 'COINMETRICS', 'FRED', 'SETTLED_RECORDS', 'TOKENOMIST', 'BINANCE_SPOT', 'BITSTAMP_SPOT', 'BINANCE_US_SPOT']);
export const SUBJECT_KINDS = Object.freeze(['ASSET', 'MARKET', 'TOKEN', 'DERIVATIVE', 'SERIES', 'POOL', 'PROTOCOL', 'PROVIDER']);
export const MARKET_TYPES = Object.freeze(['SPOT', 'PERPETUAL', 'FUTURE', 'OPTION']);
export const QUALITY_STATES = Object.freeze(['KNOWN', 'PARTIAL', 'MISSING', 'UNAVAILABLE', 'STALE', 'PROVISIONAL', 'CLOCK_CONFLICT', 'FAILED', 'NOT_SUPPORTED']);
export const QUALITY_REASON_CODES = Object.freeze(['NONE', 'SOURCE_EVENT_AHEAD_OF_RECEIPT', 'FIELD_MISSING_AT_SOURCE', 'UNIT_UNVERIFIED', 'PAGINATION_INCOMPLETE', 'CENSUS_INCOMPLETE', 'DELAYED_DATA', 'SESSION_CLOSED', 'PROVIDER_ERROR', 'CREDENTIAL_MISSING', 'ENTITLEMENT_DENIED', 'RATE_LIMITED', 'GEO_RESTRICTED', 'STALE_BY_POLICY', 'UNCOMMITTED_BAR', 'NO_TRADES_IN_PERIOD', 'DATE_ONLY_PRECISION', 'ESTIMATE', 'REVISED', 'RESOURCE_EVICTED', 'QUEUE_DROPPED', 'DESYNCHRONIZED', 'EPOCH_GAP', 'CHECKSUM_UNVERIFIED', 'NOT_IN_CATALOG', 'AMBIGUOUS_MAPPING', 'QUOTA_REFUSED', 'RECORDING_FAILED', 'SUBSCRIPTION_ENDED', 'COVERAGE_OVERFLOW', 'RECORD_REJECTED', 'MISALIGNED_BUCKET', 'ACQUISITION_INCOMPLETE']);
export const SIDES = Object.freeze(['BUY', 'SELL', 'UNKNOWN']);
export const POSITION_SIDES = Object.freeze(['LONG', 'SHORT', 'UNKNOWN']);
export const SIDE_CONVENTIONS = Object.freeze(['TAKER_NATIVE', 'MAKER_NATIVE_INVERTED', 'UNKNOWN']);
export const FUNDING_UNITS = Object.freeze(['FRACTION_PER_INTERVAL', 'ABSOLUTE_QUOTE_PER_CONTRACT_PER_INTERVAL', 'UNKNOWN']);
export const OI_UNITS = Object.freeze(['CONTRACTS', 'BASE', 'QUOTE', 'USD', 'UNKNOWN']);
export const NOTIONAL_UNITS = Object.freeze(['USD', 'USDT', 'USDC', 'BASE', 'QUOTE', 'CONTRACTS', 'UNKNOWN']);
export const LINEARITY = Object.freeze(['LINEAR', 'INVERSE', 'NOT_APPLICABLE', 'UNKNOWN']);
export const OPTION_TYPES = Object.freeze(['CALL', 'PUT']);
export const TIME_PRECISIONS = Object.freeze(['MILLISECOND', 'SECOND', 'MINUTE', 'DAY', 'UNKNOWN']);
export const UNLOCK_TYPES = Object.freeze(['CLIFF', 'LINEAR', 'NATIVE_OTHER', 'UNKNOWN']);
export const SESSION_STATES = Object.freeze(['REGULAR', 'PRE', 'POST', 'CLOSED', 'CONTINUOUS', 'UNKNOWN']);
export const EVENT_KINDS = Object.freeze(['OFFICIAL_CLAIM', 'SOCIAL_DOSSIER', 'INFRA_INCIDENT', 'NEWS_HEADLINE']);
export const PROVIDER_STATUS_STATES = Object.freeze(['OPERATIONAL', 'DEGRADED', 'OUTAGE', 'UNKNOWN']);
export const BOOK_SAMPLE_REASONS = Object.freeze(['INTERVAL', 'MINUTE_ENDPOINT', 'REQUEST', 'REST_SNAPSHOT']);
export const BOOK_COVERAGE_STATES = Object.freeze(['SYNCHRONIZED', 'DESYNCHRONIZED', 'GAP', 'SUBSCRIBED', 'UNSUBSCRIBED']);
export const DEFI_METRIC_IDS = Object.freeze(['protocol_tvl', 'chain_tvl', 'protocol_fees', 'protocol_revenue', 'dex_volume', 'pool_supply_apy', 'pool_borrow_apy']);
export const ONCHAIN_METRIC_IDS = Object.freeze(['exchange_inflow', 'exchange_outflow', 'exchange_netflow', 'exchange_reserve', 'active_addresses', 'transaction_count', 'transfer_volume', 'fees_total', 'mvrv', 'sopr', 'realized_price', 'supply_circulating', 'holder_age_cohort', 'miner_reserve', 'dev_activity', 'stablecoin_supply_ratio', 'whale_transaction_count_100k_usd_to_inf', 'whale_transaction_count_1m_usd_to_inf', 'whale_transaction_volume_100k_usd_to_inf', 'whale_transaction_volume_1m_usd_to_inf']);
// JUDGE-1 §5.2: the four documented Santiment large-transfer metrics (NETWORK_ACTIVITY: large transfers WITHOUT entity attribution;
// the >1m group is NESTED inside >100k — never added as independent counts / volume); restricted-access metrics with a 5m native interval
export const WHALE_METRIC_IDS = Object.freeze(['whale_transaction_count_100k_usd_to_inf', 'whale_transaction_count_1m_usd_to_inf', 'whale_transaction_volume_100k_usd_to_inf', 'whale_transaction_volume_1m_usd_to_inf']);
export const WHALE_METRIC_UNITS = Object.freeze({ whale_transaction_count_100k_usd_to_inf: 'COUNT', whale_transaction_count_1m_usd_to_inf: 'COUNT', whale_transaction_volume_100k_usd_to_inf: 'USD', whale_transaction_volume_1m_usd_to_inf: 'USD' });
export const STABLECOIN_METRIC_IDS = Object.freeze(['circulating_supply', 'peg_price', 'bridged_supply']);
export const UNITS = Object.freeze(['USD', 'USDT', 'USDC', 'EUR', 'BASE', 'QUOTE', 'CONTRACTS', 'COUNT', 'PERCENT', 'PERCENTAGE_POINTS', 'FRACTION', 'BPS', 'RATIO', 'NATIVE', 'INDEX', 'BILLIONS_USD', 'MILLIONS_USD', 'UNKNOWN']);
// ---- MARKET-EDGE-KRAKEN-1 dark vocabularies (documented 2026-09-10; see doctrine/MARKET_EDGE_KRAKEN.md) ----------------
// Charts / Market Analytics types with an UNAMBIGUOUS documented value schema (scalar series, cvd, future-basis, funding);
// the nested types (long-short-info, top-traders, orderbook, spreads, liquidity, slippage) are NOT_SUPPORTED_WITH_CURRENT_SCHEMA
export const ANALYTICS_TYPES = Object.freeze(['open-interest', 'aggressor-differential', 'trade-volume', 'trade-count', 'liquidation-volume', 'rolling-volatility', 'long-short-ratio', 'cvd', 'future-basis', 'funding']);
export const ANALYTICS_TYPES_UNSUPPORTED = Object.freeze(['long-short-info', 'top-traders', 'orderbook', 'spreads', 'liquidity', 'slippage']);
export const ANALYTICS_VALUE_KEYS = deepFreeze({ 'open-interest': ['value'], 'aggressor-differential': ['value'], 'trade-volume': ['value'], 'trade-count': ['value'], 'liquidation-volume': ['value'], 'rolling-volatility': ['value'], 'long-short-ratio': ['value'], cvd: ['buyVolume', 'sellVolume', 'cvd'], 'future-basis': ['basis'], funding: ['rateOpen', 'rateHigh', 'rateLow', 'rateClose', 'relativeRateOpen', 'relativeRateHigh', 'relativeRateLow', 'relativeRateClose'] });
export const ANALYTICS_INTERVALS_S = Object.freeze([60, 300, 900, 1800, 3600, 14400, 43200, 86400, 604800]);
// manipulation-risk metadata (documentation only, never a weight): LOWER = settlement-anchored (basis, funding); MEDIUM = venue
// aggregates (OI, CVD, aggressor differential, liquidations, volumes, counts, volatility); HIGHER = positioning ratios
export const MANIPULATION_RISK = Object.freeze(['LOWER', 'MEDIUM', 'HIGHER']);
export const ANALYTICS_MANIPULATION_RISK = deepFreeze({ 'future-basis': 'LOWER', funding: 'LOWER', 'open-interest': 'MEDIUM', cvd: 'MEDIUM', 'aggressor-differential': 'MEDIUM', 'liquidation-volume': 'MEDIUM', 'trade-volume': 'MEDIUM', 'trade-count': 'MEDIUM', 'rolling-volatility': 'MEDIUM', 'long-short-ratio': 'HIGHER' });
export const BUCKET_FINALITY = Object.freeze(['FINAL', 'PROVISIONAL']);
export const VINTAGES = Object.freeze(['LIVE_FORWARD_CAPTURE', 'HISTORICAL_FETCH']);
export const UNIT_NORMALIZATIONS = Object.freeze(['NONE', 'IDENTITY']); // NONE: native only (unit unverified); IDENTITY: normalized == native under a documented unit
export const L3_EVENTS = Object.freeze(['ADD', 'MODIFY', 'DELETE', 'SCOPE_EVICTED']); // SCOPE_EVICTED: left the subscribed depth — NEVER a cancel
export const L3_SIDES = Object.freeze(['BID', 'ASK']);
export const L3_COVERAGE_STATES = Object.freeze(['SYNCHRONIZED', 'DESYNCHRONIZED', 'GAP', 'SUBSCRIBED', 'UNSUBSCRIBED', 'DEGRADED', 'OVERFLOW', 'ACCESS_BLOCKED']);
export const L3_SAMPLE_REASONS = Object.freeze(['SNAPSHOT', 'INTERVAL', 'REQUEST']);
export const L3_DEPTHS = Object.freeze([10, 100, 1000]);
export const MAX_L3_ORDERS_PER_SIDE = 2_000;
export const MAX_L3_EVENTS_PER_BATCH = 2_000;
export const L3_ORDER_KEY_RE = /^[0-9a-f]{24}$/; // sha256(symbol|order_id) prefix: a stable persisted identity that never echoes the venue id
export const L3_ORDER_KEYS = Object.freeze(['orderKey', 'price', 'qty', 'providerTs', 'firstSeenTs', 'modifiedTs']);
export const L3_EVENT_KEYS = Object.freeze(['event', 'orderKey', 'side', 'price', 'qty', 'previousQty', 'providerTs', 'firstSeenTs', 'ageMs']);
export const WINDOWS = Object.freeze(['day', 'hour', 'block', 'minute', 'five_minutes']); // five_minutes: exact 300000ms native periods (JUDGE-1 §5.2)
export const KNOWN_CHAINS = Object.freeze(['ethereum', 'bitcoin', 'solana', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'tron', 'hyperliquid', 'sui', 'aptos', 'near', 'cosmos', 'cardano', 'dogecoin', 'litecoin', 'xrp', 'ton', 'other']);

// ---- family registry: which kinds, which providers, which metrics -----------------------------------------
// The metric ids here are the ONLY ids a data request may name; each names a fixed recipe in recipes.js.
export const FAMILY_REGISTRY = deepFreeze({
  SPOT_PRICE_CHART: { kinds: ['TRADE', 'CANDLE'], providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'], metrics: { window_ohlcv: 'QUOTE', vwap: 'QUOTE', log_return: 'FRACTION', close_location: 'FRACTION', sma: 'QUOTE', ema: 'QUOTE', realized_volatility: 'FRACTION', atr14: 'QUOTE', rsi14: 'INDEX', macd: 'QUOTE', bollinger20: 'QUOTE', prior_range: 'QUOTE', relative_activity: 'RATIO', breakout_distance: 'BPS' } },
  SPOT_FLOW: { kinds: ['TRADE'], providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'], metrics: { signed_notional: 'QUOTE', known_side_imbalance: 'FRACTION', trade_size_stats: 'BASE', interarrival: 'COUNT', pressure_response_efficiency: 'BPS' } },
  DISPLAYED_LIQUIDITY: { kinds: ['BOOK_SNAPSHOT', 'BOOK_COVERAGE'], providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'], metrics: { spread_bps: 'BPS', depth_bands: 'QUOTE', band_imbalance: 'FRACTION', microprice: 'QUOTE', book_walk: 'QUOTE', round_trip_loss: 'BPS', liquidity_haircut: 'QUOTE', micro_projection: 'RATIO' } },
  CROSS_VENUE: { kinds: ['TRADE', 'BOOK_SNAPSHOT', 'DERIVATIVE_TICK'], providers: ['KRAKEN_SPOT', 'COINBASE_SPOT', 'KRAKEN_DERIVATIVES'], metrics: { venue_mid_dispersion: 'BPS', first_observed_change: 'COUNT', peer_relative_move: 'BPS' } },
  DERIVATIVES_FUNDING_OI: { kinds: ['DERIVATIVE_TICK', 'INSTRUMENT'], providers: ['KRAKEN_DERIVATIVES', 'DERIBIT', 'BYBIT', 'COINGLASS'], metrics: { basis_bps: 'BPS', oi_change: 'CONTRACTS', funding_native: 'NATIVE', dated_basis: 'BPS' } },
  LIQUIDATIONS: { kinds: ['LIQUIDATION'], providers: ['BYBIT', 'COINGLASS'], metrics: { liquidation_notional_by_side: 'USD' } },
  OPTIONS_TERM_SKEW: { kinds: ['OPTION_TICK', 'INSTRUMENT'], providers: ['DERIBIT'], metrics: { atm_iv_term: 'FRACTION', risk_reversal_25d: 'FRACTION', butterfly_25d: 'FRACTION', put_call_oi_ratio: 'RATIO', put_call_volume_ratio: 'RATIO', iv_bid_ask_spread: 'FRACTION' } },
  SUPPLY_UNLOCKS: { kinds: ['ASSET_REFERENCE', 'UNLOCK_EVENT'], providers: ['COINGECKO', 'COINGLASS', 'TOKENOMIST'], metrics: { supply_ratios: 'FRACTION', unlock_schedule: 'BASE', next_unlock: 'BASE' } },
  DEX_DEFI: { kinds: ['DEX_POOL', 'DEFI_METRIC'], providers: ['GECKOTERMINAL', 'DEFILLAMA'], metrics: { pool_liquidity: 'USD', pool_activity: 'USD', protocol_tvl: 'USD', protocol_fees_revenue: 'USD', lending_rates: 'PERCENT' } },
  ONCHAIN_ENTITY_FLOW: { kinds: ['ONCHAIN_METRIC'], providers: ['CRYPTOQUANT', 'SANTIMENT'], metrics: { exchange_net_flow: 'NATIVE', exchange_reserve: 'NATIVE', holder_cohorts: 'NATIVE' } },
  NETWORK_ACTIVITY: { kinds: ['ONCHAIN_METRIC'], providers: ['COINMETRICS', 'CRYPTOQUANT', 'SANTIMENT'], metrics: { active_addresses: 'COUNT', transaction_count: 'COUNT', transfer_volume: 'NATIVE', network_fees: 'NATIVE', realized_value_metrics: 'RATIO', whale_transaction_count_100k_usd_to_inf: 'COUNT', whale_transaction_count_1m_usd_to_inf: 'COUNT', whale_transaction_volume_100k_usd_to_inf: 'USD', whale_transaction_volume_1m_usd_to_inf: 'USD' } },
  STABLECOIN_LIQUIDITY: { kinds: ['STABLECOIN_METRIC'], providers: ['DEFILLAMA', 'CRYPTOQUANT'], metrics: { stablecoin_supply_change: 'USD', peg_deviation: 'BPS' } },
  ETF_FLOWS: { kinds: ['ETF_FLOW'], providers: ['COINGLASS'], metrics: { etf_daily_flow: 'USD', etf_flow_trailing: 'USD' } },
  MACRO_RELEASES: { kinds: ['MACRO_OBSERVATION', 'ECONOMIC_EVENT'], providers: ['FRED', 'COINGLASS'], metrics: { macro_level: 'NATIVE', macro_change: 'NATIVE', macro_surprise: 'PERCENTAGE_POINTS', release_schedule: 'COUNT' } },
  OFFICIAL_SOCIAL_EVENTS: { kinds: ['EVENT_REFERENCE'], providers: ['SETTLED_RECORDS', 'COINGLASS'], metrics: { event_references: 'COUNT' } },
  INFRASTRUCTURE_STATUS: { kinds: ['PROVIDER_STATUS'], providers: ['SETTLED_RECORDS'], metrics: { provider_status: 'COUNT' } },
});
// the DARK registry is a separate object on purpose: nothing that derives its vocabulary from FAMILY_REGISTRY can reach it
export const DARK_FAMILY_REGISTRY = deepFreeze({
  DERIVATIVES_PRESSURE: { kinds: ['DERIVATIVE_ANALYTIC_BUCKET'], providers: ['KRAKEN_DERIVATIVES'], metrics: { oi_bucket_level: 'NATIVE', oi_bucket_change: 'NATIVE', oi_bucket_acceleration: 'NATIVE', aggressor_bucket_level: 'NATIVE', aggressor_bucket_change: 'NATIVE', aggressor_bucket_slope: 'NATIVE', cvd_bucket_change: 'NATIVE', cvd_bucket_slope: 'NATIVE', liquidation_bucket_burst: 'RATIO', basis_bucket_level: 'NATIVE', basis_bucket_change: 'NATIVE', funding_bucket_level: 'NATIVE', funding_bucket_change: 'NATIVE', pressure_combinations: 'NATIVE' } },
  L3_MICROSTRUCTURE: { kinds: ['L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE'], providers: ['KRAKEN_SPOT'], metrics: { visible_order_age_imbalance: 'RATIO', queue_turnover_imbalance: 'RATIO', depth_persistence: 'FRACTION', new_order_impulse: 'BASE', visible_liquidity_disappearance: 'BASE', replenishment_after_pressure: 'BASE', queue_concentration: 'FRACTION', order_age_quantiles: 'NATIVE', top_level_churn: 'COUNT', microstructure_pressure_change: 'RATIO' } },
});
for (const f of DARK_FAMILIES) if (FAMILIES.includes(f) || FAMILY_REGISTRY[f]) throw new Error(`dark family ${f} leaked into the decision vocabulary`);
{ const decision = new Set(Object.values(FAMILY_REGISTRY).flatMap((r) => Object.keys(r.metrics))); for (const f of DARK_FAMILIES) for (const id of Object.keys(DARK_FAMILY_REGISTRY[f].metrics)) if (decision.has(id)) throw new Error(`dark metric ${id} collides with a decision metric id`); }
export const darkFamilyMetricIds = (family) => Object.keys(DARK_FAMILY_REGISTRY[family]?.metrics ?? {});
export const familyMetricIds = (family) => Object.keys(FAMILY_REGISTRY[family]?.metrics ?? {});
export const metricUnit = (family, metricId) => FAMILY_REGISTRY[family]?.metrics?.[metricId] ?? null;
