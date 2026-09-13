// Pure adapter from one bounded broad-Kraken capture into the exact market-day
// input accepted by daily-move-study.js. It has no filesystem, provider,
// scheduler, Judge, promotion, or order authority.
//
// A current accepted catalog is a population snapshot, not proof of the union
// of every catalog epoch that existed during a civil day. Catalog churn is
// therefore refused in this version instead of being silently merged. The
// caller must also disclose the actual capture window; start/tail loss,
// reconnects, and explicit gaps can only reduce support.
import { createHash } from 'node:crypto';
import {
  canonicalDigest, deepFreeze, exactKeys, isFiniteNum, isPlainObject, isTs,
} from './shadow-contracts.js';
import {
  acceptedCatalogSnapshotError, marketIdentityDigest, sealAcceptedCatalogSnapshot,
} from './shadow-catalog-snapshot.js';

export const DAILY_BROAD_INPUT_VERSION = 'daily-broad-input-1';
export const DAILY_BROAD_CAPTURE_VERSION = 'daily-broad-capture-1';
export const DAILY_BROAD_HARD_LIMITS = Object.freeze({
  maxInputBytes: 32 * 1024 * 1024,
  // broad-kraken's physical JSONL line limit, including the newline.
  maxRecordBytes: 64 * 1024,
  maxRecords: 50_000,
  maxMarkets: 5_000,
  maxObservationsPerMarket: 100_000,
  maxFinalizationLagMs: 48 * 60 * 60_000,
});

const BROAD_RECORD_VERSION = 'broad-kraken-record-v1';
const MINUTE = 60_000;
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const COIN_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const PAIR_RE = /^[A-Za-z0-9._-]{1,40}$/;
const NATIVE_RE = /^[A-Z0-9.]{1,20}$/;
const WS_RE = /^([A-Z0-9][A-Z0-9._-]{0,39})\/USD$/;
const BASE_ALIASES = Object.freeze({ XBT: 'BTC', XDG: 'DOGE' });
const SUPPORT_FAMILIES = Object.freeze([
  'PRICE', 'CANDLES', 'BASE_VOLUME', 'QUOTE_VOLUME', 'TRADES', 'TRADE_FLOW', 'SPREAD', 'DEPTH', 'CATALYST',
]);
const CATALOG_MARKET_KEYS = Object.freeze(['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status']);
const RECORD_KEYS = Object.freeze([
  'recordVersion', 'recordId', 'sessionId', 'sequence', 'recordType', 'recordedTs',
  'catalogContentId', 'epochId', 'market', 'channel', 'quality', 'sourceEventTs',
  'receivedTs', 'periodStartTs', 'periodEndTs', 'payload',
]);
const RECORD_MARKET_KEYS = Object.freeze(['canonicalCoin', 'pairKey', 'nativeBase', 'catalogWsname', 'wsSymbol']);
const TICKER_KEYS = Object.freeze([
  'messageType', 'lastPrice', 'bid', 'ask', 'bidQty', 'askQty', 'change24h', 'changePct24h',
  'high24h', 'low24h', 'volume24hBase', 'vwap24h', 'tickerTimestampTs', 'missingFields', 'invalidFields',
]);
const OHLC_KEYS = Object.freeze([
  'messageType', 'finality', 'learningEligible', 'open', 'high', 'low', 'close', 'vwap', 'trades', 'volumeBase',
]);
const CLOSED_OHLC_KEYS = Object.freeze([...OHLC_KEYS.slice(0, 2), 'sourceClockBasis', ...OHLC_KEYS.slice(2)]);
const INSTRUMENT_KEYS = Object.freeze(['mappingState', 'candidates', 'pair']);
const INSTRUMENT_PAIR_KEYS = Object.freeze(['symbol', 'base', 'quote', 'status']);

const bounded = (value, max = 240) => String(value ?? '').slice(0, max);
const refuse = (reason, detail) => deepFreeze({ ok: false, reason, detail: bounded(detail) });
const utf8Bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const normalizeBase = (value) => BASE_ALIASES[value] ?? value;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const boundedString = (value, max) => typeof value === 'string' && value.length <= max;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (value[key] === undefined ? null : `${JSON.stringify(key)}:${canonicalJson(value[key])}`)).filter(Boolean).join(',')}}`;
}

function catalogContentId(catalog) {
  const markets = catalog.markets.map((market) => Object.fromEntries(CATALOG_MARKET_KEYS.map((key) => [key, market[key]])));
  return createHash('sha1').update(canonicalJson({
    venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion, markets,
  })).digest('hex');
}

function catalogProjection(catalog) {
  return {
    venue: catalog.venue, quote: catalog.quote, policyVersion: catalog.policyVersion,
    observedTs: catalog.observedTs, contentId: catalog.contentId,
    markets: catalog.markets.map((market) => Object.fromEntries(CATALOG_MARKET_KEYS.map((key) => [key, market[key]]))),
  };
}

function normalizeLimits(supplied) {
  if (supplied === undefined) return DAILY_BROAD_HARD_LIMITS;
  if (!isPlainObject(supplied)) return null;
  const out = { ...DAILY_BROAD_HARD_LIMITS };
  for (const [key, value] of Object.entries(supplied)) {
    if (!(key in out) || !Number.isSafeInteger(value) || value < 1 || value > DAILY_BROAD_HARD_LIMITS[key]) return null;
    out[key] = value;
  }
  return Object.freeze(out);
}

function validateCatalog(catalog, limits) {
  if (!isPlainObject(catalog) || catalog.venue !== 'kraken' || catalog.quote !== 'USD' || catalog.policyVersion !== 1
      || !isTs(catalog.observedTs) || !boundedString(catalog.contentId, 40) || !SHA1_RE.test(catalog.contentId) || !Array.isArray(catalog.markets)
      || catalog.markets.length < 1 || catalog.markets.length > limits.maxMarkets) return 'catalog envelope malformed or outside limits';
  const bases = new Set(); const pairKeys = new Set(); const names = new Set();
  let previous = null;
  for (let i = 0; i < catalog.markets.length; i += 1) {
    const market = catalog.markets[i];
    const keys = exactKeys(market, CATALOG_MARKET_KEYS);
    const match = typeof market?.wsname === 'string' ? market.wsname.match(WS_RE) : null;
    if (keys || !boundedString(market?.pairKey, 40) || !PAIR_RE.test(market.pairKey)
        || !boundedString(market?.nativeBase, 20) || !NATIVE_RE.test(market.nativeBase)
        || !['USD', 'ZUSD'].includes(market?.nativeQuote) || !match || normalizeBase(match[1]) !== market?.base
        || !boundedString(market?.base, 15) || !COIN_RE.test(market.base)
        || market?.quote !== 'USD' || market?.status !== 'online') return `catalog market ${i} malformed`;
    if (bases.has(market.base) || pairKeys.has(market.pairKey) || names.has(market.wsname)) return `catalog market ${i} duplicates an accepted identity`;
    const order = `${market.base}\n${market.pairKey}`;
    if (previous !== null && order < previous) return 'catalog market inventory is not canonical-sorted';
    previous = order; bases.add(market.base); pairKeys.add(market.pairKey); names.add(market.wsname);
  }
  if (catalogContentId(catalog) !== catalog.contentId) return 'catalog contentId forged';
  return null;
}

function acceptedFromCatalog(catalog) {
  return sealAcceptedCatalogSnapshot({
    observedTs: catalog.observedTs,
    knownAtTs: catalog.observedTs,
    maxAgeMs: 24 * 60 * 60_000,
    markets: catalog.markets.map((market) => ({
      subjectKind: 'MARKET', canonicalCoin: market.base, providerAssetId: market.pairKey,
      venue: 'kraken', nativeSymbol: market.wsname, base: market.base, quote: 'USD',
      marketType: 'SPOT', quoteAliasGroup: 'USD',
    })),
  });
}

function recordDigestError(record) {
  if (!boundedString(record.recordId, 68) || !record.recordId.startsWith('bkr-')
      || !SHA256_RE.test(record.recordId.slice(4))) return 'recordId malformed';
  const copy = { ...record, recordId: null };
  return `bkr-${sha256(JSON.stringify(copy))}` === record.recordId ? null : 'recordId content digest forged';
}

function nullableFinite(value, { positive = false, nonNegative = false } = {}) {
  if (value === null) return true;
  if (!isFiniteNum(value)) return false;
  if (positive && value <= 0) return false;
  if (nonNegative && value < 0) return false;
  return true;
}

function payloadError(record) {
  const p = record.payload;
  if (!isPlainObject(p)) return 'payload malformed';
  if (record.recordType === 'INSTRUMENT_MAP') {
    if (record.channel !== 'instrument' || exactKeys(p, INSTRUMENT_KEYS)
        || !['MAPPED', 'UNSUPPORTED', 'AMBIGUOUS'].includes(p.mappingState)
        || !Array.isArray(p.candidates) || p.candidates.length > 8 || p.candidates.some((x) => !boundedString(x, 80))
        || !(p.pair === null || (isPlainObject(p.pair) && !exactKeys(p.pair, INSTRUMENT_PAIR_KEYS)
          && boundedString(p.pair.symbol, 44) && WS_RE.test(p.pair.symbol)
          && boundedString(p.pair.base, 40) && boundedString(p.pair.quote, 40)
          && boundedString(p.pair.status, 40)))
        || (p.mappingState === 'MAPPED') !== (record.quality === 'OBSERVED')) return 'instrument payload malformed';
    return null;
  }
  if (record.recordType === 'SUBSCRIPTION') {
    if (!['ticker', 'ohlc'].includes(record.channel) || exactKeys(p, ['state', 'error'])
        || !['SUBSCRIBED', 'FAILED', 'PENDING'].includes(p.state)
        || !(p.error === null || boundedString(p.error, 240))
        || record.quality !== (p.state === 'SUBSCRIBED' ? 'SUBSCRIBED' : p.state === 'FAILED' ? 'FAILED' : 'PROVISIONAL')) return 'subscription payload malformed';
    return null;
  }
  if (record.recordType === 'GAP') {
    if (!['ticker', 'ohlc'].includes(record.channel) || record.quality !== 'GAP' || !['GAP', 'STOPPED'].includes(p.state)) return 'gap payload malformed';
    const socket = !exactKeys(p, ['state', 'reason', 'epochId']) && boundedString(p.reason, 240)
      && boundedString(p.epochId, 200) && ID_RE.test(p.epochId);
    const send = !exactKeys(p, ['state', 'error']) && boundedString(p.error, 240);
    const interval = !exactKeys(p, ['state', 'reason', 'sinceTs', 'untilTs']) && p.reason === 'NO_NATIVE_INTERVAL'
      && isTs(p.sinceTs) && isTs(p.untilTs) && p.sinceTs < p.untilTs;
    return socket || send || interval ? null : 'gap payload malformed';
  }
  if (record.recordType === 'TICKER') {
    if (record.channel !== 'ticker' || exactKeys(p, TICKER_KEYS)
        || !['OBSERVED', 'PARTIAL', 'MISSING', 'FAILED'].includes(record.quality)
        || !['snapshot', 'update'].includes(p.messageType)
        || !nullableFinite(p.lastPrice, { positive: true }) || !nullableFinite(p.bid, { positive: true })
        || !nullableFinite(p.ask, { positive: true }) || !nullableFinite(p.bidQty, { nonNegative: true })
        || !nullableFinite(p.askQty, { nonNegative: true }) || !nullableFinite(p.change24h)
        || !nullableFinite(p.changePct24h) || !nullableFinite(p.high24h, { positive: true })
        || !nullableFinite(p.low24h, { positive: true }) || !nullableFinite(p.volume24hBase, { nonNegative: true })
        || !nullableFinite(p.vwap24h, { positive: true }) || !(p.tickerTimestampTs === null || isTs(p.tickerTimestampTs))
        || !Array.isArray(p.missingFields) || p.missingFields.length > 32 || !Array.isArray(p.invalidFields) || p.invalidFields.length > 32
        || p.missingFields.some((x) => !boundedString(x, 80)) || p.invalidFields.some((x) => !boundedString(x, 80))) return 'ticker payload malformed';
    if (p.messageType === 'update' && (!isTs(record.sourceEventTs) || p.tickerTimestampTs !== record.sourceEventTs)) return 'ticker update lacks its exact source clock';
    if (p.messageType === 'snapshot' && record.sourceEventTs !== null) return 'ticker snapshot cannot claim a last-trade clock';
    const expectedQuality = p.invalidFields.length > 0 ? 'FAILED'
      : p.lastPrice === null ? 'MISSING'
        : p.volume24hBase !== null ? 'OBSERVED' : 'PARTIAL';
    if (record.quality !== expectedQuality) return 'ticker quality disagrees with its observed fields';
    return null;
  }
  if (record.recordType === 'OHLC') {
    const closed = record.quality === 'CONSERVATIVE_CLOSED';
    if (record.channel !== 'ohlc' || exactKeys(p, closed ? CLOSED_OHLC_KEYS : OHLC_KEYS)
        || !isTs(record.periodStartTs) || !isTs(record.periodEndTs) || record.periodEndTs - record.periodStartTs !== MINUTE
        || record.sourceEventTs !== null || ![p.open, p.high, p.low, p.close].every((n) => isFiniteNum(n) && n > 0)
        || p.high < Math.max(p.open, p.close) || p.low > Math.min(p.open, p.close) || p.high < p.low
        || !nullableFinite(p.vwap, { positive: true }) || !Number.isSafeInteger(p.trades) || p.trades < 0
        || !isFiniteNum(p.volumeBase) || p.volumeBase < 0 || p.learningEligible !== false) return 'OHLC payload malformed';
    if (closed) {
      if (p.messageType !== 'closed' || p.finality !== 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL'
          || p.sourceClockBasis !== 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME' || record.receivedTs < record.periodEndTs) return 'closed OHLC finality malformed';
    } else if (record.quality !== 'PROVISIONAL' || p.finality !== 'PROVISIONAL'
        || !['snapshot-provisional', 'update-provisional'].includes(p.messageType)) return 'provisional OHLC state malformed';
    return null;
  }
  return 'record type unsupported';
}

function recordError(record, { finalizedTs, captureStartTs, captureEndTs, catalog, marketByPair, maxRecordBytes }) {
  const keys = exactKeys(record, RECORD_KEYS); if (keys) return `record envelope ${keys}`;
  if (record.catalogContentId !== catalog.contentId) return 'catalog contentId changed inside the capture';
  if (record.recordVersion !== BROAD_RECORD_VERSION || !boundedString(record.sessionId, 200) || !ID_RE.test(record.sessionId)
      || !Number.isSafeInteger(record.sequence) || record.sequence < 1
      || !boundedString(record.epochId, 200) || !ID_RE.test(record.epochId)
      || !isTs(record.receivedTs) || !isTs(record.recordedTs)
      || record.receivedTs < captureStartTs || record.recordedTs < record.receivedTs
      || record.recordedTs > captureEndTs || record.recordedTs > finalizedTs
      || !(record.sourceEventTs === null || (isTs(record.sourceEventTs) && record.sourceEventTs <= record.receivedTs))
      || !(record.periodStartTs === null || isTs(record.periodStartTs))
      || !(record.periodEndTs === null || isTs(record.periodEndTs))) return 'record identity or clocks malformed';
  if (record.recordType !== 'OHLC' && (record.periodStartTs !== null || record.periodEndTs !== null)) return 'non-OHLC record carries candle clocks';
  if (!['TICKER', 'OHLC'].includes(record.recordType) && record.sourceEventTs !== null) return 'control record carries a source event clock';
  if (!isPlainObject(record.market) || exactKeys(record.market, RECORD_MARKET_KEYS)) return 'record market malformed';
  const accepted = marketByPair.get(record.market.pairKey);
  const ws = record.market.wsSymbol === null ? null
    : boundedString(record.market.wsSymbol, 44) ? record.market.wsSymbol.match(WS_RE) : null;
  if (!accepted || !boundedString(record.market.canonicalCoin, 15) || !boundedString(record.market.pairKey, 40)
      || !boundedString(record.market.nativeBase, 20) || !boundedString(record.market.catalogWsname, 44)
      || record.market.canonicalCoin !== accepted.accepted.canonicalCoin
      || record.market.catalogWsname !== accepted.raw.wsname || record.market.nativeBase !== accepted.raw.nativeBase
      || (ws && normalizeBase(ws[1]) !== accepted.accepted.canonicalCoin)
      || (record.market.wsSymbol !== null && !ws)) return 'record market is unknown or disagrees with the accepted catalog';
  const perType = payloadError(record); if (perType) return perType;
  let wireBytes;
  try { wireBytes = utf8Bytes(record) + 1; } catch { return 'record is not JSON serializable'; }
  if (wireBytes > maxRecordBytes) return `record exceeds the ${maxRecordBytes}-byte broad JSONL wire ceiling`;
  const digest = recordDigestError(record); if (digest) return digest;
  return null;
}

const absent = (state, reason) => ({
  state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
  gapCount: 0, sourceDigests: [], reason,
});

function evidenceSupport({ family, observations, startOf, endOf, reasons, complete = false }) {
  if (observations.length === 0) return absent('MISSING', reasons.length ? reasons.join('|').slice(0, 240) : `${family}_NOT_RECORDED`);
  let coverageStartTs = Infinity; let coverageEndTs = -Infinity;
  for (const row of observations) {
    coverageStartTs = Math.min(coverageStartTs, startOf(row));
    coverageEndTs = Math.max(coverageEndTs, endOf(row));
  }
  const sourceDigests = [canonicalDigest({
    adapterVersion: DAILY_BROAD_INPUT_VERSION, family,
    records: observations.map((row) => row.recordId).sort(),
  })];
  if (reasons.length) return {
    state: 'GAP', observedCount: observations.length,
    coverageStartTs, coverageEndTs,
    gapCount: reasons.length, sourceDigests, reason: reasons.join('|').slice(0, 240),
  };
  return {
    state: complete ? 'COMPLETE' : 'PARTIAL', observedCount: observations.length,
    coverageStartTs, coverageEndTs,
    gapCount: 0, sourceDigests,
    reason: complete ? null : `${family}_EVENT_RATE_HAS_NO_FULL_DAY_COMPLETENESS_LAW`,
  };
}

function boundaryReasons({ captureStartTs, captureEndTs, dayStartTs, dayEndTs }) {
  const reasons = [];
  if (captureStartTs > dayStartTs) reasons.push('CAPTURE_STARTED_AFTER_DAY_START');
  if (captureEndTs < dayEndTs) reasons.push('CAPTURE_ENDED_BEFORE_DAY_END');
  return reasons;
}

function relevantGap(record, dayStartTs, dayEndTs) {
  if (record.recordType !== 'GAP' && !(record.recordType === 'SUBSCRIPTION' && record.quality === 'FAILED')) return false;
  if (record.payload?.reason === 'NO_NATIVE_INTERVAL') return record.payload.sinceTs < dayEndTs && record.payload.untilTs > dayStartTs;
  return record.receivedTs >= dayStartTs && record.receivedTs < dayEndTs;
}

function makeMarketDay(state, { dayStartTs, dayEndTs, captureStartTs, captureEndTs, maxObservationsPerMarket }) {
  const boundary = boundaryReasons({ captureStartTs, captureEndTs, dayStartTs, dayEndTs });
  const common = [...boundary];
  if (state.sessions.size > 1) common.push('SESSION_RESTART');
  if (state.epochs.size > 1) common.push('FEED_EPOCH_CHANGE');
  const channelReasons = (channel) => {
    const out = [...common];
    if (state.channelGaps[channel]) out.push(`EXPLICIT_${channel.toUpperCase()}_GAP`);
    return [...new Set(out)];
  };
  const tickerReasons = channelReasons('ticker'); const candleReasons = channelReasons('ohlc');
  if (state.instrumentUnsupported) { tickerReasons.push('INSTRUMENT_UNSUPPORTED_OR_AMBIGUOUS'); candleReasons.push('INSTRUMENT_UNSUPPORTED_OR_AMBIGUOUS'); }

  const sortedPrices = [...state.prices].sort((a, b) => a.sourceEventTs - b.sourceEventTs || a.recordId.localeCompare(b.recordId));
  const sortedCandles = [...state.candles].sort((a, b) => a.periodStartTs - b.periodStartTs || a.recordId.localeCompare(b.recordId));
  if (sortedPrices.length + sortedCandles.length > maxObservationsPerMarket) throw Object.assign(new Error('market observation cap exceeded'), { code: 'MARKET_OBSERVATION_LIMIT' });

  const expectedCandles = (dayEndTs - dayStartTs) / MINUTE;
  let candleGridComplete = sortedCandles.length === expectedCandles;
  if (candleGridComplete) for (let i = 0; i < sortedCandles.length; i += 1) {
    if (sortedCandles[i].periodStartTs !== dayStartTs + i * MINUTE) { candleGridComplete = false; break; }
  }
  if (!candleGridComplete && sortedCandles.length > 0) candleReasons.push('CANDLE_INTERVALS_INCOMPLETE');

  const priceSupport = evidenceSupport({ family: 'PRICE', observations: sortedPrices, startOf: (r) => r.sourceEventTs, endOf: (r) => r.sourceEventTs, reasons: tickerReasons });
  const candleSupport = evidenceSupport({ family: 'CANDLES', observations: sortedCandles, startOf: (r) => r.periodStartTs, endOf: (r) => r.periodEndTs, reasons: candleReasons, complete: candleGridComplete });
  const baseSupport = evidenceSupport({ family: 'BASE_VOLUME', observations: sortedCandles, startOf: (r) => r.periodStartTs, endOf: (r) => r.periodEndTs, reasons: candleReasons, complete: candleGridComplete });

  const support = Object.fromEntries(SUPPORT_FAMILIES.map((family) => [family, absent('UNSUPPORTED', `BROAD_KRAKEN_${family}_NOT_CAPTURED`)]));
  support.PRICE = priceSupport; support.CANDLES = candleSupport; support.BASE_VOLUME = baseSupport;
  const marketDay = {
    marketIdentityDigest: state.marketDigest,
    priceEvents: sortedPrices.map((row) => ({
      observationId: row.recordId, kind: 'TICKER_UPDATE', price: row.payload.lastPrice,
      sourceEventTs: row.sourceEventTs, receivedTs: row.receivedTs, knownAtTs: row.recordedTs,
      sourceDigest: row.recordId.slice(4),
    })),
    candles: sortedCandles.map((row) => ({
      observationId: row.recordId, periodStartTs: row.periodStartTs, periodEndTs: row.periodEndTs,
      open: row.payload.open, high: row.payload.high, low: row.payload.low, close: row.payload.close,
      volumeBase: row.payload.volumeBase, volumeQuote: null, closed: true,
      receivedTs: row.receivedTs, knownAtTs: row.recordedTs, sourceDigest: row.recordId.slice(4),
    })),
    support,
  };
  return { marketDay, sessions: state.sessions.size, epochs: state.epochs.size, reasons: [...new Set([...tickerReasons, ...candleReasons])] };
}

// Returns either one complete planner-compatible input or an error with no
// partial catalog/marketDays. `truncated:true` always refuses the whole input.
export function prepareDailyBroadInput({
  catalog, records, dayStartTs, dayEndTs, finalizedTs,
  captureStartTs, captureEndTs, truncated = false, limits: suppliedLimits,
} = {}) {
  const limits = normalizeLimits(suppliedLimits); if (!limits) return refuse('INPUT_LIMITS_INVALID', 'limits must be positive and no larger than the hard law');
  if (!isTs(dayStartTs) || !isTs(dayEndTs) || dayEndTs <= dayStartTs || dayEndTs - dayStartTs < 23 * 60 * 60_000
      || dayEndTs - dayStartTs > 25 * 60 * 60_000 || (dayEndTs - dayStartTs) % MINUTE !== 0
      || !isTs(finalizedTs) || finalizedTs < dayEndTs || finalizedTs - dayEndTs > limits.maxFinalizationLagMs
      || !isTs(captureStartTs) || !isTs(captureEndTs) || captureEndTs < captureStartTs || captureEndTs > finalizedTs) return refuse('CAPTURE_CLOCK_INVALID', 'day/capture/finalization clocks violate the bounded completed-day law');
  if (truncated !== false) return refuse('CAPTURE_TRUNCATED', 'a truncated source inventory cannot produce any planner input');
  if (!Array.isArray(records) || records.length > limits.maxRecords) return refuse('RECORD_LIMIT', 'record inventory malformed or exceeds the hard row cap');
  const catalogError = validateCatalog(catalog, limits); if (catalogError) return refuse('CATALOG_INVALID', catalogError);
  if (catalog.observedTs >= dayEndTs || dayStartTs - catalog.observedTs > 24 * 60 * 60_000 || catalog.observedTs > finalizedTs) return refuse('CATALOG_NOT_POINT_IN_TIME', 'catalog cannot identify this completed day population');

  let bytes;
  try {
    // Measure only the validated catalog identity projection plus validated
    // record wires. WideEye's additional diagnostic arrays are not market
    // proof, and this is not represented as a physical-source byte count.
    bytes = utf8Bytes({ version: DAILY_BROAD_CAPTURE_VERSION, dayStartTs, dayEndTs, finalizedTs, captureStartTs, captureEndTs, truncated, catalog: catalogProjection(catalog), records: [] });
    if (bytes > limits.maxInputBytes) return refuse('INPUT_BYTE_LIMIT', `UTF-8 JSON input exceeds ${limits.maxInputBytes} bytes`);
  } catch { return refuse('INPUT_NOT_SERIALIZABLE', 'catalog or records are not JSON serializable'); }

  let acceptedCatalogSnapshot;
  try { acceptedCatalogSnapshot = acceptedFromCatalog(catalog); }
  catch (error) { return refuse('CATALOG_INVALID', error.message); }
  // A completed-day study intentionally consumes a historical point-in-time
  // catalog. The explicit day-relative checks above, rather than freshness at
  // finalization, are the applicable temporal law.
  const snapshotError = acceptedCatalogSnapshotError(acceptedCatalogSnapshot);
  if (snapshotError) return refuse('CATALOG_INVALID', snapshotError);
  const marketByPair = new Map(); const states = new Map();
  for (let i = 0; i < catalog.markets.length; i += 1) {
    const raw = catalog.markets[i]; const accepted = acceptedCatalogSnapshot.markets.find((market) => market.providerAssetId === raw.pairKey);
    const marketDigest = marketIdentityDigest(accepted);
    marketByPair.set(raw.pairKey, { raw, accepted, marketDigest });
    states.set(marketDigest, {
      marketDigest, raw, accepted, sessions: new Set(), epochs: new Set(),
      channelGaps: { ticker: false, ohlc: false }, instrumentUnsupported: false,
      prices: [], candles: [], candlePeriods: new Set(),
    });
  }

  const ids = new Set(); const sequenceIds = new Set();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const error = recordError(record, { finalizedTs, captureStartTs, captureEndTs, catalog, marketByPair, maxRecordBytes: limits.maxRecordBytes });
    if (error) return refuse(error.includes('catalog') ? 'CATALOG_CHURN_OR_UNKNOWN_MARKET' : error.includes('wire ceiling') ? 'RECORD_WIRE_LIMIT' : 'RECORD_INVALID', `record ${i}: ${error}`);
    let recordBytes;
    try { recordBytes = utf8Bytes(record); } catch { return refuse('RECORD_INVALID', `record ${i}: not JSON serializable`); }
    bytes += (i === 0 ? 0 : 1) + recordBytes;
    if (bytes > limits.maxInputBytes) return refuse('INPUT_BYTE_LIMIT', `validated projection and record wire bytes exceed ${limits.maxInputBytes}`);
    const seqId = `${record.sessionId}:${record.sequence}`;
    if (ids.has(record.recordId) || sequenceIds.has(seqId)) return refuse('DUPLICATE_RECORD', `record ${i} duplicates a durable identity or session sequence`);
    ids.add(record.recordId); sequenceIds.add(seqId);
    const binding = marketByPair.get(record.market.pairKey); const state = states.get(binding.marketDigest);
    const recordRelevant = (record.receivedTs >= dayStartTs && record.receivedTs < dayEndTs)
      || (record.recordType === 'TICKER' && isTs(record.sourceEventTs) && record.sourceEventTs >= dayStartTs && record.sourceEventTs < dayEndTs)
      || (record.recordType === 'OHLC' && record.periodStartTs < dayEndTs && record.periodEndTs > dayStartTs)
      || (record.payload?.reason === 'NO_NATIVE_INTERVAL' && record.payload.sinceTs < dayEndTs && record.payload.untilTs > dayStartTs);
    if (recordRelevant) {
      state.sessions.add(record.sessionId); state.epochs.add(record.epochId);
      if (['ticker', 'ohlc'].includes(record.channel) && relevantGap(record, dayStartTs, dayEndTs)) state.channelGaps[record.channel] = true;
      if (record.recordType === 'INSTRUMENT_MAP' && record.payload.mappingState !== 'MAPPED') state.instrumentUnsupported = true;
    }
    if (record.recordType === 'TICKER' && record.payload.messageType === 'update'
        && record.quality !== 'FAILED' && record.payload.lastPrice !== null
        && record.sourceEventTs >= dayStartTs && record.sourceEventTs < dayEndTs) {
      if (state.prices.length + state.candles.length >= limits.maxObservationsPerMarket) return refuse('MARKET_OBSERVATION_LIMIT', `record ${i} crosses the per-market observation cap`);
      state.prices.push(record);
    }
    if (record.recordType === 'OHLC' && record.quality === 'CONSERVATIVE_CLOSED'
        && record.periodStartTs >= dayStartTs && record.periodEndTs <= dayEndTs) {
      if (state.candlePeriods.has(record.periodStartTs)) return refuse('DUPLICATE_CANDLE_PERIOD', `record ${i} repeats a closed market minute`);
      if (state.prices.length + state.candles.length >= limits.maxObservationsPerMarket) return refuse('MARKET_OBSERVATION_LIMIT', `record ${i} crosses the per-market observation cap`);
      state.candlePeriods.add(record.periodStartTs); state.candles.push(record);
    }
  }

  const marketDays = []; let priceEvents = 0; let candles = 0; let gappedMarkets = 0;
  try {
    for (const market of acceptedCatalogSnapshot.markets) {
      const built = makeMarketDay(states.get(marketIdentityDigest(market)), {
        dayStartTs, dayEndTs, captureStartTs, captureEndTs,
        maxObservationsPerMarket: limits.maxObservationsPerMarket,
      });
      marketDays.push(built.marketDay); priceEvents += built.marketDay.priceEvents.length; candles += built.marketDay.candles.length;
      if (built.reasons.length) gappedMarkets += 1;
    }
  } catch (error) { return refuse(error.code ?? 'MARKET_DAY_INVALID', error.message); }

  return deepFreeze({
    ok: true,
    version: DAILY_BROAD_INPUT_VERSION,
    acceptedCatalogSnapshot,
    marketDays,
    diagnostics: {
      mode: 'BOUNDED_PARTIAL_CAPTURE_ONLY',
      inputByteBasis: 'VALIDATED_CATALOG_PROJECTION_PLUS_RECORD_WIRE_UTF8_BYTES', inputBytes: bytes, validatedRecords: records.length,
      acceptedMarkets: acceptedCatalogSnapshot.acceptedMarketCount, marketDays: marketDays.length,
      priceEvents, closedCandles: candles, gappedMarkets,
      sourceWindowCoversDay: captureStartTs <= dayStartTs && captureEndTs >= dayEndTs,
      catalogObservedAfterDayStart: catalog.observedTs > dayStartTs,
      fullDayCatalogEpochUnionVerified: false,
      persistedRecordContinuityVerified: false,
      producerSequenceMayLawfullyGapOrReorder: true,
      candleCompletenessBasis: 'EXACT_DIRECT_CLOSED_ONE_MINUTE_GRID_ONLY',
      fullDetailClaimed: false,
      authority: 'NONE',
    },
  });
}
