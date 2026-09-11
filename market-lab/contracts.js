// MARKET LAB — shared closed contracts for real market observations (market-observation-1).
//
// This module is PURE: no network, no filesystem, no clock, no configuration, no model. It defines
// (1) the strict input boundary (UTF-8 / JSON / duplicate keys / unsafe numbers / prototype hazards),
// (2) the ONE normalized observation envelope every provider client emits, with a closed discriminated
//     subject identity and a closed typed payload per kind,
// (3) the closed vocabularies (families, kinds, quality states, reason codes, units) and the metric registry
//     the broker, the recipes and the evidence builder all validate against.
// Laws: unknown keys fail at every depth; missing / failed / unsupported data carries null, never zero; a
// diagnostic never echoes raw provider text, property names or credentials — positions and closed reasons only.
import { createHash } from 'node:crypto';

export const OBSERVATION_SCHEMA_VERSION = 'market-observation-1';
export const MARKET_LAB_VERSION = 'market-lab-1';
export const AUTHORITY = 'NONE';
export const PURPOSE = 'RESEARCH_ONLY';

// ---- error type ------------------------------------------------------------------------------------------
export const ERROR_CODES = Object.freeze(['INVALID_REQUEST', 'INVALID_INPUT', 'RESOURCE_LIMIT_EXCEEDED', 'IO_FAILURE', 'PERMISSION_FAILURE', 'CONNECTION_FAILURE', 'PROVIDER_REJECTED', 'ACCESS_DENIED', 'RATE_LIMITED', 'TIMEOUT', 'CANCELLED', 'OUTPUT_EXISTS', 'VALIDATION_FAILURE', 'POLICY_REJECTED', 'BUDGET_BLOCKED', 'INTERNAL_FAILURE']);
export const EXIT_CODES = Object.freeze({ OK: 0, INVALID_REQUEST: 2, INVALID_INPUT: 3, RESOURCE_LIMIT_EXCEEDED: 4, EXECUTION_FAILURE: 5 });
const EXIT_OF = Object.freeze({ INVALID_REQUEST: 2, INVALID_INPUT: 3, VALIDATION_FAILURE: 3, RESOURCE_LIMIT_EXCEEDED: 4 });
export const MAX_REASON_CHARS = 240;
export const boundedReason = (msg) => String(msg ?? 'unknown').slice(0, MAX_REASON_CHARS);
export class MarketLabError extends Error {
  constructor(code, message, detail = null) {
    super(boundedReason(message));
    this.name = 'MarketLabError';
    this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL_FAILURE';
    this.detail = detail === undefined ? null : detail;
    this.exitCode = EXIT_OF[this.code] ?? EXIT_CODES.EXECUTION_FAILURE;
  }
  toJSON() { return { code: this.code, message: this.message, detail: this.detail, exitCode: this.exitCode }; }
}
export const fail = (code, message, detail) => { throw new MarketLabError(code, message, detail); };

// ---- primitives -------------------------------------------------------------------------------------------
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const isTs = (v) => Number.isSafeInteger(v) && v > 0;
export const isTsOrNull = (v) => v === null || isTs(v);
export const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isNumOrNull = (v) => v === null || isFiniteNum(v);
export const isPositive = (v) => isFiniteNum(v) && v > 0;
export const isNonNegative = (v) => isFiniteNum(v) && v >= 0;
export const isBoundedString = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
export const isStringOrNull = (v, max) => v === null || isBoundedString(v, max);
export const isUnitFraction = (v) => isFiniteNum(v) && v >= 0 && v <= 1;
export const safeType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/; // a bounded identifier / locator (provider ids, symbols, slugs, addresses)
export const CODE_RE = /^[A-Z0-9][A-Z0-9_]{0,63}$/;
export const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
export const isIdOrNull = (v) => v === null || isId(v);
export const isCode = (v) => typeof v === 'string' && CODE_RE.test(v);
export const isCoin = (v) => typeof v === 'string' && COIN_RE.test(v);
export const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
export const round = (v, d = 8) => { if (!isFiniteNum(v)) return null; const r = Number(v.toFixed(d)); return Object.is(r, -0) ? 0 : r; };
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Deterministic canonical JSON: keys sorted, undefined dropped, no whitespace. Assumes JSON-safe input.
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`)).filter(Boolean).join(',')}}`;
};
export const canonicalDigest = (v) => sha256Hex(canonicalJson(v));
export const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

// exact closed key set — sanitized diagnostics: an undeclared key is named by POSITION, never echoed
export const exactKeys = (o, keys, where = 'object') => {
  if (!isPlainObject(o)) return `${where}: expected object, got ${safeType(o)}`;
  const own = Object.keys(o);
  for (let i = 0; i < own.length; i += 1) if (!keys.includes(own[i])) return `${where}: undeclared key at position ${i + 1} of ${own.length}`;
  for (const k of keys) if (!(k in o)) return `${where}: missing key '${k}'`;
  return null;
};
export const enumError = (v, list, where) => (list.includes(v) ? null : `${where}: value outside the closed vocabulary (${safeType(v)})`);

// structural JSON safety for INTERNAL DTOs: finite numbers, bounded depth, plain objects, no cycles/undefined
export const MAX_DTO_DEPTH = 24;
export function jsonShapeError(v, label = 'value', depth = 1, seen = new Set()) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return null;
  if (t === 'number') return Number.isFinite(v) ? null : `${label}: non-finite number`;
  if (t !== 'object') return `${label}: unsupported type ${t}`;
  if (depth > MAX_DTO_DEPTH) return `${label}: nesting exceeds depth ${MAX_DTO_DEPTH}`;
  if (seen.has(v)) return `${label}: cyclic structure`;
  seen.add(v);
  let err = null;
  if (Array.isArray(v)) { for (let i = 0; i < v.length && err === null; i += 1) err = v[i] === undefined ? `${label}[${i}]: undefined` : jsonShapeError(v[i], `${label}[${i}]`, depth + 1, seen); }
  else if (!isPlainObject(v)) err = `${label}: non-plain object`;
  else { const ks = Object.keys(v); for (let i = 0; i < ks.length && err === null; i += 1) err = v[ks[i]] === undefined ? `${label}.<key ${i + 1}>: undefined` : jsonShapeError(v[ks[i]], `${label}.<key ${i + 1}>`, depth + 1, seen); }
  seen.delete(v);
  return err;
}

// ---- strict JSON input boundary --------------------------------------------------------------------------
// Rejects: invalid UTF-8, BOM/garbage, duplicate object keys, `__proto__` / `constructor` / `prototype` keys,
// integers outside the safe range, numbers that do not round-trip, nesting deeper than maxDepth, trailing data.
// Returns { ok: true, value } | { ok: false, error } — the error is a closed reason with a byte position, never text.
export const MAX_JSON_DEPTH = 64;
const HAZARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function parseStrictJson(input, { maxBytes = 8 * 1024 * 1024, maxDepth = MAX_JSON_DEPTH } = {}) {
  let text;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength > maxBytes) return { ok: false, error: `JSON_TOO_LARGE:${input.byteLength}>${maxBytes}` };
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); } catch { return { ok: false, error: 'INVALID_UTF8' }; }
  } else if (typeof input === 'string') { if (utf8Bytes(input) > maxBytes) return { ok: false, error: 'JSON_TOO_LARGE' }; text = input; }
  else return { ok: false, error: `JSON_INPUT_TYPE:${safeType(input)}` };
  let i = 0; const n = text.length;
  const ws = () => { while (i < n) { const c = text.charCodeAt(i); if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i += 1; else break; } };
  const err = (code) => ({ ok: false, error: `${code}@${i}` });
  let failure = null;
  const parseValue = (depth) => {
    if (failure) return undefined;
    if (depth > maxDepth) { failure = err('JSON_DEPTH'); return undefined; }
    ws(); if (i >= n) { failure = err('JSON_EOF'); return undefined; }
    const c = text[i];
    if (c === '{') {
      i += 1; const obj = {}; const seenKeys = new Set(); ws();
      if (text[i] === '}') { i += 1; return obj; }
      for (;;) {
        ws(); if (text[i] !== '"') { failure = err('JSON_KEY'); return undefined; }
        const key = parseString(); if (failure) return undefined;
        if (seenKeys.has(key)) { failure = err('JSON_DUPLICATE_KEY'); return undefined; }
        if (HAZARD_KEYS.has(key)) { failure = err('JSON_HAZARD_KEY'); return undefined; }
        seenKeys.add(key);
        ws(); if (text[i] !== ':') { failure = err('JSON_COLON'); return undefined; } i += 1;
        const v = parseValue(depth + 1); if (failure) return undefined;
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws(); if (text[i] === ',') { i += 1; continue; } if (text[i] === '}') { i += 1; return obj; }
        failure = err('JSON_OBJECT'); return undefined;
      }
    }
    if (c === '[') {
      i += 1; const arr = []; ws();
      if (text[i] === ']') { i += 1; return arr; }
      for (;;) { const v = parseValue(depth + 1); if (failure) return undefined; arr.push(v); ws(); if (text[i] === ',') { i += 1; continue; } if (text[i] === ']') { i += 1; return arr; } failure = err('JSON_ARRAY'); return undefined; }
    }
    if (c === '"') return parseString();
    if (c === 't') { if (text.startsWith('true', i)) { i += 4; return true; } failure = err('JSON_LITERAL'); return undefined; }
    if (c === 'f') { if (text.startsWith('false', i)) { i += 5; return false; } failure = err('JSON_LITERAL'); return undefined; }
    if (c === 'n') { if (text.startsWith('null', i)) { i += 4; return null; } failure = err('JSON_LITERAL'); return undefined; }
    return parseNumber();
  };
  const parseString = () => {
    i += 1; let out = ''; let start = i;
    for (;;) {
      if (i >= n) { failure = err('JSON_STRING_EOF'); return undefined; }
      const ch = text.charCodeAt(i);
      if (ch === 0x22) { out += text.slice(start, i); i += 1; return out; }
      if (ch < 0x20) { failure = err('JSON_STRING_CONTROL'); return undefined; }
      if (ch === 0x5c) {
        out += text.slice(start, i); i += 1; const e = text[i];
        if (e === '"') out += '"'; else if (e === '\\') out += '\\'; else if (e === '/') out += '/'; else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f'; else if (e === 'n') out += '\n'; else if (e === 'r') out += '\r'; else if (e === 't') out += '\t';
        else if (e === 'u') { const h = text.slice(i + 1, i + 5); if (!/^[0-9a-fA-F]{4}$/.test(h)) { failure = err('JSON_STRING_ESCAPE'); return undefined; } out += String.fromCharCode(parseInt(h, 16)); i += 4; }
        else { failure = err('JSON_STRING_ESCAPE'); return undefined; }
        i += 1; start = i; continue;
      }
      i += 1;
    }
  };
  const parseNumber = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64));
    if (!m) { failure = err('JSON_NUMBER'); return undefined; }
    const raw = m[0]; i += raw.length;
    const v = Number(raw);
    if (!Number.isFinite(v)) { failure = err('JSON_NUMBER_RANGE'); return undefined; }
    if (!m[2] && !m[3] && !Number.isSafeInteger(v)) { failure = err('JSON_UNSAFE_INTEGER'); return undefined; }
    return v;
  };
  const value = parseValue(1);
  if (failure) return failure;
  ws(); if (i !== n) return err('JSON_TRAILING');
  return { ok: true, value };
}
// lone-surrogate check for strings that will be hashed / persisted (a malformed UTF-16 string cannot be written as UTF-8 faithfully)
export const wellFormedString = (s) => typeof s === 'string' && (typeof s.isWellFormed === 'function' ? s.isWellFormed() : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s));

// ---- closed vocabularies ---------------------------------------------------------------------------------
export const FAMILIES = Object.freeze(['SPOT_PRICE_CHART', 'SPOT_FLOW', 'DISPLAYED_LIQUIDITY', 'CROSS_VENUE', 'DERIVATIVES_FUNDING_OI', 'LIQUIDATIONS', 'OPTIONS_TERM_SKEW', 'SUPPLY_UNLOCKS', 'DEX_DEFI', 'ONCHAIN_ENTITY_FLOW', 'NETWORK_ACTIVITY', 'STABLECOIN_LIQUIDITY', 'ETF_FLOWS', 'MACRO_RELEASES', 'CROSS_ASSET', 'OFFICIAL_SOCIAL_EVENTS', 'INFRASTRUCTURE_STATUS']);
export const PAYLOAD_KINDS = Object.freeze(['TRADE', 'BOOK_SNAPSHOT', 'BOOK_COVERAGE', 'CANDLE', 'INSTRUMENT', 'DERIVATIVE_TICK', 'LIQUIDATION', 'OPTION_TICK', 'ASSET_REFERENCE', 'UNLOCK_EVENT', 'DEX_POOL', 'DEFI_METRIC', 'ONCHAIN_METRIC', 'STABLECOIN_METRIC', 'ETF_FLOW', 'MACRO_OBSERVATION', 'ECONOMIC_EVENT', 'CROSS_ASSET_BAR', 'EVENT_REFERENCE', 'PROVIDER_STATUS', 'DERIVATIVE_ANALYTIC_BUCKET', 'L3_BOOK_SNAPSHOT', 'L3_ORDER_EVENT', 'L3_BOOK_COVERAGE']);
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
export const PROVIDER_IDS = Object.freeze(['KRAKEN_SPOT', 'COINBASE_SPOT', 'KRAKEN_DERIVATIVES', 'DERIBIT', 'BYBIT', 'COINGECKO', 'GECKOTERMINAL', 'DEFILLAMA', 'COINGLASS', 'CRYPTOQUANT', 'SANTIMENT', 'COINMETRICS', 'FRED', 'TWELVEDATA', 'SETTLED_RECORDS', 'TOKENOMIST']);
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
export const EVENT_KINDS = Object.freeze(['OFFICIAL_CLAIM', 'SOCIAL_DOSSIER', 'GOVERNANCE_PROPOSAL', 'INFRA_INCIDENT', 'NEWS_HEADLINE']);
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
  CROSS_ASSET: { kinds: ['CROSS_ASSET_BAR'], providers: ['TWELVEDATA'], metrics: { cross_asset_return: 'FRACTION', pearson_correlation: 'RATIO' } },
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
  OPTION_TICK: ['markIv', 'bidIv', 'askIv', 'delta', 'gamma', 'vega', 'theta', 'markPrice', 'underlyingPrice', 'underlyingIndex', 'openInterest', 'volume24h', 'bid', 'ask', 'ivUnit', 'strike', 'expiryTs', 'optionType', 'settlementCurrency'],
  ASSET_REFERENCE: ['providerAssetId', 'name', 'symbolNative', 'marketCapUsd', 'fdvUsd', 'circulatingSupply', 'totalSupply', 'maxSupply', 'priceUsd', 'volume24hUsd', 'categories', 'platforms', 'capMethodologyId', 'lastUpdatedTs'],
  UNLOCK_EVENT: ['eventId', 'scheduledTs', 'timePrecision', 'amountToken', 'amountUsd', 'recipientCategory', 'unlockType', 'tracked', 'allocationName', 'totalLocked', 'totalUnlocked', 'totalUntracked', 'circulatingSupply', 'scheduleVersion'],
  DEX_POOL: ['chain', 'poolAddress', 'dex', 'baseToken', 'quoteToken', 'priceUsd', 'priceQuote', 'liquidityUsd', 'volume24hUsd', 'volume1hUsd', 'txCount24h', 'poolCreatedTs', 'feePct'],
  DEFI_METRIC: ['metricId', 'value', 'unit', 'chain', 'protocol', 'periodKind', 'methodologyId'],
  ONCHAIN_METRIC: ['metricId', 'value', 'unit', 'entitySet', 'chain', 'window', 'methodologyId', 'labelVintage'],
  STABLECOIN_METRIC: ['metricId', 'value', 'unit', 'chain', 'stablecoinId', 'pegCurrency'],
  ETF_FLOW: ['fund', 'asset', 'flowUsd', 'reportingPeriodStartTs', 'reportingPeriodEndTs', 'estimate', 'revision', 'priceUsd'],
  MACRO_OBSERVATION: ['seriesId', 'value', 'unit', 'observationDate', 'realtimeStart', 'realtimeEnd', 'frequency', 'vintageDate', 'unitLabel'],
  ECONOMIC_EVENT: ['eventName', 'countryCode', 'scheduledTs', 'timePrecision', 'forecastRaw', 'actualRaw', 'previousRaw', 'revisedPreviousRaw', 'forecastValue', 'actualValue', 'previousValue', 'unit', 'importance', 'forecastKnownAtTs', 'actualKnownAtTs'],
  CROSS_ASSET_BAR: ['instrument', 'exchange', 'intervalMs', 'open', 'high', 'low', 'close', 'volume', 'sessionState', 'delayed', 'proxyFor', 'currency'],
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
    case 'OPTION_TICK':
      e = numOrNullKeys(p, ['markIv', 'bidIv', 'askIv', 'delta', 'gamma', 'vega', 'theta', 'markPrice', 'underlyingPrice', 'bid', 'ask'], where); if (e) return e;
      e = nonNegOrNullKeys(p, ['openInterest', 'volume24h'], where); if (e) return e;
      if (p.ivUnit !== 'FRACTION') return `${where}: ivUnit must be FRACTION (native units are normalized before this DTO)`;
      for (const k of ['markIv', 'bidIv', 'askIv']) if (p[k] !== null && (p[k] < 0 || p[k] > 10)) return `${where}: ${k} outside a plausible fraction range`;
      if (p.delta !== null && Math.abs(p.delta) > 1) return `${where}: delta outside [-1,1]`;
      if (!isId(p.underlyingIndex) || !isPositive(p.strike) || !isTs(p.expiryTs) || !OPTION_TYPES.includes(p.optionType) || !isId(p.settlementCurrency)) return `${where}: option specification malformed`;
      if (p.optionType === 'CALL' && p.delta !== null && p.delta < 0) return `${where}: a call delta is not negative`;
      if (p.optionType === 'PUT' && p.delta !== null && p.delta > 0) return `${where}: a put delta is not positive`;
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
    case 'MACRO_OBSERVATION':
      if (!isId(p.seriesId) || !isNumOrNull(p.value) || !UNITS.includes(p.unit) || !isDateOnly(p.observationDate)) return `${where}: macro observation malformed`;
      if (!(p.realtimeStart === null || isDateOnly(p.realtimeStart)) || !(p.realtimeEnd === null || isDateOnly(p.realtimeEnd)) || !(p.vintageDate === null || isDateOnly(p.vintageDate))) return `${where}: vintage dates malformed`;
      if (!isStringOrNull(p.frequency, 24) || !isStringOrNull(p.unitLabel, 120)) return `${where}: frequency/unit label malformed`;
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
    case 'CROSS_ASSET_BAR':
      if (!isId(p.instrument) || !isIdOrNull(p.exchange) || !isTs(p.intervalMs) || !SESSION_STATES.includes(p.sessionState) || !(p.delayed === null || typeof p.delayed === 'boolean') || !isIdOrNull(p.proxyFor) || !isId(p.currency)) return `${where}: cross-asset bar malformed`;
      e = ohlcError(p, where); if (e) return e;
      if (!(p.volume === null || isNonNegative(p.volume))) return `${where}: volume malformed`;
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
  LIQUIDATION: ['notional', 'longNotional', 'shortNotional', 'qtyBase'], OPTION_TICK: ['markIv', 'markPrice', 'openInterest'], ASSET_REFERENCE: ['priceUsd', 'marketCapUsd', 'circulatingSupply'], UNLOCK_EVENT: ['scheduledTs', 'amountToken'],
  DEX_POOL: ['priceUsd', 'liquidityUsd'], DEFI_METRIC: ['value'], ONCHAIN_METRIC: ['value'], STABLECOIN_METRIC: ['value'], ETF_FLOW: ['flowUsd'], MACRO_OBSERVATION: ['value'], ECONOMIC_EVENT: ['scheduledTs', 'actualValue', 'forecastValue'],
  CROSS_ASSET_BAR: ['close'], EVENT_REFERENCE: ['nativeRef'], PROVIDER_STATUS: ['status'],
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
