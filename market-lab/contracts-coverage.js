import { OBSERVATION_SCHEMA_VERSION, MARKET_LAB_VERSION, AUTHORITY, PURPOSE, ERROR_CODES, EXIT_CODES, MAX_REASON_CHARS, boundedReason, MarketLabError, fail, isPlainObject, isTs, isTsOrNull, isCount, isFiniteNum, isNumOrNull, isPositive, isNonNegative, isBoundedString, isStringOrNull, isUnitFraction, safeType, sha256Hex, SHA256_RE, ID_RE, CODE_RE, COIN_RE, isId, isIdOrNull, isCode, isCoin, deepFreeze, round, cmp, canonicalJson, canonicalDigest, utf8Bytes, exactKeys, enumError, MAX_DTO_DEPTH, jsonShapeError, MAX_JSON_DEPTH, parseStrictJson, wellFormedString } from './contracts-core.js';
import { FAMILIES, PAYLOAD_KINDS, DARK_FAMILIES, DARK_PAYLOAD_KINDS, ALL_FAMILIES, DARK_FAMILY_LAW, isDarkFamily, isDarkKind, PROVIDER_IDS, SUBJECT_KINDS, MARKET_TYPES, QUALITY_STATES, QUALITY_REASON_CODES, SIDES, POSITION_SIDES, SIDE_CONVENTIONS, FUNDING_UNITS, OI_UNITS, NOTIONAL_UNITS, LINEARITY, OPTION_TYPES, TIME_PRECISIONS, UNLOCK_TYPES, SESSION_STATES, EVENT_KINDS, PROVIDER_STATUS_STATES, BOOK_SAMPLE_REASONS, BOOK_COVERAGE_STATES, DEFI_METRIC_IDS, ONCHAIN_METRIC_IDS, WHALE_METRIC_IDS, WHALE_METRIC_UNITS, STABLECOIN_METRIC_IDS, UNITS, ANALYTICS_TYPES, ANALYTICS_TYPES_UNSUPPORTED, ANALYTICS_VALUE_KEYS, ANALYTICS_INTERVALS_S, MANIPULATION_RISK, ANALYTICS_MANIPULATION_RISK, BUCKET_FINALITY, VINTAGES, UNIT_NORMALIZATIONS, L3_EVENTS, L3_SIDES, L3_COVERAGE_STATES, L3_SAMPLE_REASONS, L3_DEPTHS, MAX_L3_ORDERS_PER_SIDE, MAX_L3_EVENTS_PER_BATCH, L3_ORDER_KEY_RE, L3_ORDER_KEYS, L3_EVENT_KEYS, WINDOWS, KNOWN_CHAINS, FAMILY_REGISTRY, DARK_FAMILY_REGISTRY, darkFamilyMetricIds, familyMetricIds, metricUnit } from './contracts-registry.js';
// ---- coverage interval record (coverage.jsonl) -------------------------------------------------------------
export const COVERAGE_RECORD_KEYS = Object.freeze(['recordVersion', 'coverageId', 'provider', 'endpointId', 'subjectId', 'family', 'kind', 'state', 'reasonCodes', 'startTs', 'endTs', 'observationCount', 'droppedCount', 'epochId', 'sequenceStart', 'sequenceEnd']);
export const COVERAGE_RECORD_VERSION = 'market-coverage-1';
// SUBSCRIBED (closeout R02): a POSITIVE feed-continuity fact — the provider acknowledged the channel subscription for this
// subject at startTs; the interval stays open (endTs null) until a GAP / SUBSCRIPTION_ENDED record closes it. It is the only
// lawful basis for a complete zero-trade interval; a book, a heartbeat or one trade never establishes it.
export const COVERAGE_STATES = Object.freeze(['OBSERVED', 'GAP', 'NOT_QUERIED', 'FAILED', 'ACCESS_BLOCKED', 'NOT_SUPPORTED', 'EVICTED', 'DROPPED', 'SUBSCRIBED']);
export const coverageIdentity = (c) => { const b = {}; for (const k of COVERAGE_RECORD_KEYS) if (k !== 'coverageId') b[k] = c[k]; return `mc-${canonicalDigest(b).slice(0, 40)}`; };
export function coverageRecordError(c, where = 'coverage') {
  const k = exactKeys(c, COVERAGE_RECORD_KEYS, where); if (k) return k;
  if (c.recordVersion !== COVERAGE_RECORD_VERSION) return `${where}: unsupported recordVersion`;
  if (!PROVIDER_IDS.includes(c.provider) || !isId(c.endpointId) || !/^ms-[0-9a-f]{32}$/.test(String(c.subjectId)) || !ALL_FAMILIES.includes(c.family) || !(c.kind === null || PAYLOAD_KINDS.includes(c.kind))) return `${where}: identity malformed`;
  if (c.kind !== null && DARK_PAYLOAD_KINDS.includes(c.kind) !== DARK_FAMILIES.includes(c.family)) return `${where}: a dark kind belongs to a dark family and to nothing else`;
  if (!COVERAGE_STATES.includes(c.state) || !Array.isArray(c.reasonCodes) || c.reasonCodes.some((r) => !QUALITY_REASON_CODES.includes(r))) return `${where}: state/reasons malformed`;
  if (!isTs(c.startTs) || !isTsOrNull(c.endTs) || (c.endTs !== null && c.endTs < c.startTs)) return `${where}: interval malformed`;
  if (!isCount(c.observationCount) || !isCount(c.droppedCount) || !isIdOrNull(c.epochId) || !(c.sequenceStart === null || isCount(c.sequenceStart)) || !(c.sequenceEnd === null || isCount(c.sequenceEnd))) return `${where}: counters malformed`;
  if (c.state === 'OBSERVED' && c.observationCount === 0) return `${where}: OBSERVED with zero observations is a GAP or NOT_QUERIED, not coverage`;
  if (c.state === 'DROPPED' && c.droppedCount === 0) return `${where}: DROPPED requires a measured dropped count`;
  if (typeof c.coverageId !== 'string' || coverageIdentity(c) !== c.coverageId) return `${where}: coverageId does not match content`;
  return null;
}
export const makeCoverage = (body) => { const c = { recordVersion: COVERAGE_RECORD_VERSION, coverageId: 'mc-x', ...body }; c.coverageId = coverageIdentity(c); const e = coverageRecordError(c); if (e) fail('VALIDATION_FAILURE', e); return deepFreeze(c); };
