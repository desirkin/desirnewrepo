import { OBSERVATION_SCHEMA_VERSION, MARKET_LAB_VERSION, AUTHORITY, PURPOSE, ERROR_CODES, EXIT_CODES, MAX_REASON_CHARS, boundedReason, MarketLabError, fail, isPlainObject, isTs, isTsOrNull, isCount, isFiniteNum, isNumOrNull, isPositive, isNonNegative, isBoundedString, isStringOrNull, isUnitFraction, safeType, sha256Hex, SHA256_RE, ID_RE, CODE_RE, COIN_RE, isId, isIdOrNull, isCode, isCoin, deepFreeze, round, cmp, canonicalJson, canonicalDigest, utf8Bytes, exactKeys, enumError, MAX_DTO_DEPTH, jsonShapeError, MAX_JSON_DEPTH, parseStrictJson, wellFormedString } from './contracts-core.js';
import { FAMILIES, PAYLOAD_KINDS, DARK_FAMILIES, DARK_PAYLOAD_KINDS, ALL_FAMILIES, DARK_FAMILY_LAW, isDarkFamily, isDarkKind, PROVIDER_IDS, SUBJECT_KINDS, MARKET_TYPES, QUALITY_STATES, QUALITY_REASON_CODES, SIDES, POSITION_SIDES, SIDE_CONVENTIONS, FUNDING_UNITS, OI_UNITS, NOTIONAL_UNITS, LINEARITY, OPTION_TYPES, TIME_PRECISIONS, UNLOCK_TYPES, SESSION_STATES, EVENT_KINDS, PROVIDER_STATUS_STATES, BOOK_SAMPLE_REASONS, BOOK_COVERAGE_STATES, DEFI_METRIC_IDS, ONCHAIN_METRIC_IDS, WHALE_METRIC_IDS, WHALE_METRIC_UNITS, STABLECOIN_METRIC_IDS, UNITS, ANALYTICS_TYPES, ANALYTICS_TYPES_UNSUPPORTED, ANALYTICS_VALUE_KEYS, ANALYTICS_INTERVALS_S, MANIPULATION_RISK, ANALYTICS_MANIPULATION_RISK, BUCKET_FINALITY, VINTAGES, UNIT_NORMALIZATIONS, L3_EVENTS, L3_SIDES, L3_COVERAGE_STATES, L3_SAMPLE_REASONS, L3_DEPTHS, MAX_L3_ORDERS_PER_SIDE, MAX_L3_EVENTS_PER_BATCH, L3_ORDER_KEY_RE, L3_ORDER_KEYS, L3_EVENT_KEYS, WINDOWS, KNOWN_CHAINS, FAMILY_REGISTRY, DARK_FAMILY_REGISTRY, darkFamilyMetricIds, familyMetricIds, metricUnit } from './contracts-registry.js';
import { SUBJECT_KEYS, KIND_SUBJECTS, subjectError, subjectId } from './contracts-subject.js';
import { MAX_BOOK_LEVELS, MAX_CATEGORIES, MAX_PLATFORMS, MAX_TEXT_CHARS, PAYLOAD_KEYS, isDateOnly, payloadError, VALUE_BEARING, QUALITY_KEYS, PROVENANCE_KEYS, qualityError, provenanceError } from './contracts-payload.js';
// ---- the envelope ----------------------------------------------------------------------------------------
export const OBSERVATION_KEYS = Object.freeze(['schemaVersion', 'observationId', 'provider', 'endpointId', 'subject', 'kind', 'sourceKey', 'sourceRevision', 'sourceEventTs', 'periodStartTs', 'periodEndTs', 'publishedTs', 'receivedTs', 'knownAtTs', 'sequence', 'epochId', 'quality', 'provenance', 'payload']);
export const CLOCK_CONFLICT_TOLERANCE_MS = 2_000; // a source event this far ahead of trusted receipt is a conflict, not a fact
export const observationIdentity = (o) => { const basis = {}; for (const k of OBSERVATION_KEYS) if (k !== 'observationId') basis[k] = o[k]; return `mo-${canonicalDigest(basis)}`; };
export const OBSERVATION_ID_RE = /^mo-[0-9a-f]{64}$/;

// Validate ONE observation envelope. Returns null or a bounded closed reason. Never throws on hostile input.
export function observationError(o, where = 'observation') {
  try {
    const shape = jsonShapeError(o, where); if (shape) return boundedReason(shape);
    const k = exactKeys(o, OBSERVATION_KEYS, where); if (k) return k;
    if (o.schemaVersion !== OBSERVATION_SCHEMA_VERSION) return `${where}: unsupported schemaVersion`;
    if (!PROVIDER_IDS.includes(o.provider)) return `${where}: provider outside vocabulary`;
    if (!isId(o.endpointId)) return `${where}: endpointId malformed`;
    if (!PAYLOAD_KINDS.includes(o.kind)) return `${where}: kind outside vocabulary`;
    const se = subjectError(o.subject, `${where}.subject`); if (se) return se;
    if (!KIND_SUBJECTS[o.kind].includes(o.subject.subjectKind)) return `${where}: subject kind ${o.subject.subjectKind} cannot carry ${o.kind}`;
    if (!isIdOrNull(o.sourceKey) || !isIdOrNull(o.sourceRevision)) return `${where}: sourceKey/sourceRevision malformed`;
    if (!isTsOrNull(o.sourceEventTs) || !isTsOrNull(o.periodStartTs) || !isTsOrNull(o.periodEndTs) || !isTsOrNull(o.publishedTs)) return `${where}: nullable clocks malformed`;
    if (o.periodStartTs !== null && o.periodEndTs !== null && o.periodEndTs < o.periodStartTs) return `${where}: period end before start`;
    if (!isTs(o.receivedTs)) return `${where}: receivedTs required (the owner's receipt clock)`;
    if (!isTs(o.knownAtTs) || o.knownAtTs < o.receivedTs) return `${where}: knownAtTs cannot precede receipt`;
    if (o.publishedTs !== null && o.publishedTs > o.receivedTs + CLOCK_CONFLICT_TOLERANCE_MS) return `${where}: publishedTs after receipt is impossible`;
    if (!isCount(o.sequence) || !isIdOrNull(o.epochId)) return `${where}: sequence/epoch malformed`;
    const pe = payloadError(o.kind, o.payload, `${where}.payload`); if (pe) return pe;
    const qe = qualityError(o.quality, o.kind, o.payload, `${where}.quality`); if (qe) return qe;
    const pv = provenanceError(o.provenance, `${where}.provenance`); if (pv) return pv;
    const ahead = o.sourceEventTs !== null && o.sourceEventTs > o.receivedTs + CLOCK_CONFLICT_TOLERANCE_MS;
    if (ahead && o.quality.state !== 'CLOCK_CONFLICT') return `${where}: source event ahead of receipt must be CLOCK_CONFLICT`;
    if (!ahead && o.quality.state === 'CLOCK_CONFLICT') return `${where}: CLOCK_CONFLICT without a conflicting source clock`;
    if (o.kind === 'CANDLE' && o.periodStartTs !== null && o.periodEndTs !== null && o.periodEndTs - o.periodStartTs !== o.payload.intervalMs) return `${where}: candle period disagrees with its interval`;
    if (o.kind === 'CANDLE' && o.payload.closed && o.periodEndTs !== null && o.periodEndTs > o.receivedTs) return `${where}: a closed candle cannot end after receipt`;
    if (o.kind === 'CANDLE' && o.payload.provisional && o.periodEndTs !== null && o.periodEndTs <= o.receivedTs) return `${where}: a provisional candle has not closed yet`;
    if (o.kind === 'DERIVATIVE_ANALYTIC_BUCKET') {
      if (o.periodStartTs !== o.payload.bucketTs || o.periodEndTs !== o.payload.bucketTs + o.payload.intervalMs) return `${where}: analytics bucket period must be [bucketTs, bucketTs + interval]`;
      if (o.payload.finality === 'FINAL' && o.periodEndTs > o.receivedTs) return `${where}: a FINAL bucket cannot end after receipt`;
      if (o.payload.finality === 'PROVISIONAL' && o.periodEndTs <= o.receivedTs) return `${where}: a bucket that closed before receipt is not PROVISIONAL`;
      if (o.provenance.vintage !== o.payload.vintage) return `${where}: provenance vintage disagrees with the payload vintage`;
    }
    if (o.kind === 'L3_BOOK_SNAPSHOT' || o.kind === 'L3_ORDER_EVENT') { if (o.epochId === null) return `${where}: an L3 record names its connection epoch`; const orders = o.kind === 'L3_BOOK_SNAPSHOT' ? [...o.payload.bids, ...o.payload.asks] : o.payload.events; for (const x of orders) if (x.firstSeenTs > o.receivedTs || (x.providerTs !== null && x.providerTs > o.receivedTs + CLOCK_CONFLICT_TOLERANCE_MS)) return `${where}: an order clock cannot follow receipt`; }
    if (typeof o.observationId !== 'string' || !OBSERVATION_ID_RE.test(o.observationId)) return `${where}: observationId malformed`;
    if (observationIdentity(o) !== o.observationId) return `${where}: observationId does not match content`;
    return null;
  } catch (err) { return boundedReason(`${where}: rejected hostile input (${err?.name ?? 'error'})`); }
}
// Build a sealed observation from a validated body; identity is recomputed here, never supplied.
export function makeObservation(body) {
  const o = { schemaVersion: OBSERVATION_SCHEMA_VERSION, observationId: 'mo-0000000000000000000000000000000000000000000000000000000000000000', ...body };
  o.observationId = observationIdentity(o);
  const e = observationError(o); if (e) fail('VALIDATION_FAILURE', e);
  return deepFreeze(o);
}
export const emptyProvenance = () => ({ requestId: null, bytesSha256: null, nativeLocator: null, mappingId: null, specificationId: null, vintage: null });
export const quality = (state, { reasonCodes = [], coverageStartTs = null, coverageEndTs = null, completeness = null, methodologyId = null, originalUnit = null } = {}) => ({ state, reasonCodes, coverageStartTs, coverageEndTs, completeness, methodologyId, originalUnit });
