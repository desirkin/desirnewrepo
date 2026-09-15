import { OBSERVATION_SCHEMA_VERSION, MARKET_LAB_VERSION, AUTHORITY, PURPOSE, ERROR_CODES, EXIT_CODES, MAX_REASON_CHARS, boundedReason, MarketLabError, fail, isPlainObject, isTs, isTsOrNull, isCount, isFiniteNum, isNumOrNull, isPositive, isNonNegative, isBoundedString, isStringOrNull, isUnitFraction, safeType, sha256Hex, SHA256_RE, ID_RE, CODE_RE, COIN_RE, isId, isIdOrNull, isCode, isCoin, deepFreeze, round, cmp, canonicalJson, canonicalDigest, utf8Bytes, exactKeys, enumError, MAX_DTO_DEPTH, jsonShapeError, MAX_JSON_DEPTH, parseStrictJson, wellFormedString } from './contracts-core.js';
import { FAMILIES, PAYLOAD_KINDS, DARK_FAMILIES, DARK_PAYLOAD_KINDS, ALL_FAMILIES, DARK_FAMILY_LAW, isDarkFamily, isDarkKind, PROVIDER_IDS, SUBJECT_KINDS, MARKET_TYPES, QUALITY_STATES, QUALITY_REASON_CODES, SIDES, POSITION_SIDES, SIDE_CONVENTIONS, FUNDING_UNITS, OI_UNITS, NOTIONAL_UNITS, LINEARITY, OPTION_TYPES, TIME_PRECISIONS, UNLOCK_TYPES, SESSION_STATES, EVENT_KINDS, PROVIDER_STATUS_STATES, BOOK_SAMPLE_REASONS, BOOK_COVERAGE_STATES, DEFI_METRIC_IDS, ONCHAIN_METRIC_IDS, WHALE_METRIC_IDS, WHALE_METRIC_UNITS, STABLECOIN_METRIC_IDS, UNITS, ANALYTICS_TYPES, ANALYTICS_TYPES_UNSUPPORTED, ANALYTICS_VALUE_KEYS, ANALYTICS_INTERVALS_S, MANIPULATION_RISK, ANALYTICS_MANIPULATION_RISK, BUCKET_FINALITY, VINTAGES, UNIT_NORMALIZATIONS, L3_EVENTS, L3_SIDES, L3_COVERAGE_STATES, L3_SAMPLE_REASONS, L3_DEPTHS, MAX_L3_ORDERS_PER_SIDE, MAX_L3_EVENTS_PER_BATCH, L3_ORDER_KEY_RE, L3_ORDER_KEYS, L3_EVENT_KEYS, WINDOWS, KNOWN_CHAINS, FAMILY_REGISTRY, DARK_FAMILY_REGISTRY, darkFamilyMetricIds, familyMetricIds, metricUnit } from './contracts-registry.js';
// ---- subject identity (closed discriminated) -----------------------------------------------------------
export const SUBJECT_KEYS = deepFreeze({
  ASSET: ['subjectKind', 'canonicalCoin', 'providerAssetId'],
  MARKET: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'venue', 'nativeSymbol', 'base', 'quote', 'marketType', 'quoteAliasGroup'],
  TOKEN: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'chain', 'contractAddress', 'nativeTokenId'],
  DERIVATIVE: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'venue', 'instrumentId', 'specificationId', 'marketType'],
  SERIES: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'seriesId', 'instrumentId'],
  POOL: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'chain', 'poolAddress', 'quoteToken'],
  PROTOCOL: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'protocolId', 'chain'],
  PROVIDER: ['subjectKind', 'canonicalCoin', 'providerAssetId', 'providerId'],
});
// which subject kinds may carry which payload kinds
export const KIND_SUBJECTS = deepFreeze({
  TRADE: ['MARKET'], BOOK_SNAPSHOT: ['MARKET'], BOOK_COVERAGE: ['MARKET'], CANDLE: ['MARKET'], INSTRUMENT: ['MARKET', 'DERIVATIVE'],
  DERIVATIVE_TICK: ['DERIVATIVE'], LIQUIDATION: ['DERIVATIVE', 'ASSET'], OPTION_TICK: ['DERIVATIVE'], ASSET_REFERENCE: ['ASSET', 'TOKEN'],
  UNLOCK_EVENT: ['ASSET', 'TOKEN'], DEX_POOL: ['POOL'], DEFI_METRIC: ['PROTOCOL', 'ASSET'], ONCHAIN_METRIC: ['ASSET', 'TOKEN'],
  STABLECOIN_METRIC: ['ASSET', 'TOKEN'], ETF_FLOW: ['ASSET'], MACRO_OBSERVATION: ['SERIES'], ECONOMIC_EVENT: ['SERIES'],
  CROSS_ASSET_BAR: ['SERIES'], EVENT_REFERENCE: ['ASSET', 'PROVIDER'], PROVIDER_STATUS: ['PROVIDER'],
  DERIVATIVE_ANALYTIC_BUCKET: ['DERIVATIVE'], L3_BOOK_SNAPSHOT: ['MARKET'], L3_ORDER_EVENT: ['MARKET'], L3_BOOK_COVERAGE: ['MARKET'],
});
export function subjectError(s, where = 'subject') {
  if (!isPlainObject(s)) return `${where}: expected object`;
  if (!SUBJECT_KINDS.includes(s.subjectKind)) return `${where}: unknown subjectKind`;
  const k = exactKeys(s, SUBJECT_KEYS[s.subjectKind], where); if (k) return k;
  // canonicalCoin: null is lawful ONLY for non-crypto identities (macro series, cross-asset instruments, providers)
  if (s.canonicalCoin !== null && !isCoin(s.canonicalCoin)) return `${where}: canonicalCoin malformed`;
  if (s.canonicalCoin === null && !['SERIES', 'PROVIDER', 'PROTOCOL'].includes(s.subjectKind)) return `${where}: canonicalCoin required for ${s.subjectKind}`;
  if (!isIdOrNull(s.providerAssetId)) return `${where}: providerAssetId malformed`;
  switch (s.subjectKind) {
    case 'MARKET':
      if (!isId(s.venue) || !isId(s.nativeSymbol) || !isId(s.base) || !isId(s.quote)) return `${where}: market identity incomplete`;
      if (!MARKET_TYPES.includes(s.marketType)) return `${where}: marketType outside vocabulary`;
      if (!isIdOrNull(s.quoteAliasGroup)) return `${where}: quoteAliasGroup malformed`;
      break;
    case 'TOKEN':
      if (!isId(s.chain)) return `${where}: chain required`;
      if (!isIdOrNull(s.contractAddress) || !isIdOrNull(s.nativeTokenId)) return `${where}: token identity malformed`;
      if (s.contractAddress === null && s.nativeTokenId === null) return `${where}: a token needs a contract or a native id`;
      break;
    case 'DERIVATIVE':
      if (!isId(s.venue) || !isId(s.instrumentId) || !isId(s.specificationId)) return `${where}: derivative identity incomplete`;
      if (!['PERPETUAL', 'FUTURE', 'OPTION'].includes(s.marketType)) return `${where}: derivative marketType outside vocabulary`;
      break;
    case 'SERIES':
      if (!isIdOrNull(s.seriesId) || !isIdOrNull(s.instrumentId)) return `${where}: series identity malformed`;
      if (s.seriesId === null && s.instrumentId === null) return `${where}: a series needs a seriesId or an instrumentId`;
      break;
    case 'POOL':
      if (!isId(s.chain) || !isId(s.poolAddress) || !isId(s.quoteToken)) return `${where}: pool identity incomplete`;
      break;
    case 'PROTOCOL':
      if (!isId(s.protocolId) || !isIdOrNull(s.chain)) return `${where}: protocol identity malformed`;
      break;
    case 'PROVIDER':
      if (!PROVIDER_IDS.includes(s.providerId) && !isId(s.providerId)) return `${where}: providerId malformed`;
      break;
    default: break;
  }
  return null;
}
export const subjectId = (s) => `ms-${canonicalDigest(s).slice(0, 32)}`;
