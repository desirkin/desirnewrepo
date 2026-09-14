// Immutable, bounded reader for the append-only local broad-day archive.
//
// The archive writer deliberately does not seal catalog-refresh continuity or
// a whole-day session manifest. This reader verifies every physical control
// and shard row that does exist, constructs the observed catalog-epoch union,
// and pages exact conservative closed candles. It never upgrades those facts
// into a full-population/full-day claim that the writer did not record.
import path from 'node:path';
import {
  createReadStream, existsSync, lstatSync, readdirSync, realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BROAD_KRAKEN_RECORD_VERSION,
  BROAD_KRAKEN_RECORD_VERSION_V2,
  broadKrakenRecordIdOf,
  validateBroadKrakenCatalog,
} from './broad-kraken.js';
import {
  BROAD_DAY_ARCHIVE_ENTRY_VERSION,
  BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2,
  BROAD_DAY_ARCHIVE_VERSION,
  BROAD_DAY_ARCHIVE_VERSION_V2,
} from './broad-day-archive.js';

export const BROAD_DAY_DATASET_VERSION = 'broad-day-dataset-v1';
export const BROAD_DAY_CURSOR_VERSION = 'broad-day-reader-cursor-v1';
export const BROAD_DAY_PAGE_VERSION = 'broad-day-reader-page-v1';
export const BROAD_DAY_MARKET_CURSOR_VERSION = 'broad-day-market-cursor-v1';
export const BROAD_DAY_MARKET_PAGE_VERSION = 'broad-day-market-page-v1';
export const BROAD_DAY_READER_DEFAULTS = Object.freeze({
  maxSessions: 256,
  maxControlRows: 4_000_000,
  maxCatalogControls: 10_000,
  maxShardFiles: 10_000,
  maxShardRows: 100_000,
  maxControlFileBytes: 4 * 1024 * 1024 * 1024,
  maxShardBytes: 64 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  maxCatalogLineBytes: 16 * 1024 * 1024,
  maxRecordLineBytes: 128 * 1024,
  maxPageRows: 5_000,
  maxPageBytes: 32 * 1024 * 1024,
  maxCatalogAgeMs: 24 * 60 * 60_000,
  maxCatalogHeartbeatGapMs: 20 * 60_000,
  maxFinalizationLagMs: 48 * 60 * 60_000,
});

const CEILINGS = Object.freeze({
  maxSessions: 10_000,
  maxControlRows: 8_000_000,
  maxCatalogControls: 100_000,
  maxShardFiles: 50_000,
  maxShardRows: 4_000_000,
  maxControlFileBytes: 16 * 1024 * 1024 * 1024,
  maxShardBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024 * 1024,
  maxCatalogLineBytes: 16 * 1024 * 1024,
  maxRecordLineBytes: 256 * 1024,
  maxPageRows: 50_000,
  maxPageBytes: 256 * 1024 * 1024,
  maxCatalogAgeMs: 7 * 24 * 60 * 60_000,
  maxCatalogHeartbeatGapMs: 24 * 60 * 60_000,
  maxFinalizationLagMs: 7 * 24 * 60 * 60_000,
});

const MINUTE = 60_000;
const HEX64 = /^[a-f0-9]{64}$/;
const SESSION_RE = /^bda-(\d+)-(\d+)-[a-f0-9]{16}$/;
const SHARD_RE = /^market-([a-f0-9]{24})-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const CONTROL_COMMON = Object.freeze([
  'entryVersion', 'kind', 'globalOrdinal', 'previousControlDigest', 'admittedTs',
  'knownAtTs', 'controlDigest',
]);
const CATALOG_CONTROL_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'sourceObservedTs', 'contentId', 'catalogBodyDigest', 'catalog',
]);
const CATALOG_CONTROL_V2_KEYS = Object.freeze([
  ...CATALOG_CONTROL_KEYS, 'priorCatalogControlDigest', 'priorCatalogContentId', 'catalogChange',
]);
const SOURCE_CONTROL_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'recordId', 'recordDigest', 'catalogContentId',
  'catalogControlDigest', 'record',
]);
const CANDLE_INDEX_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'recordId', 'recordDigest', 'catalogContentId',
  'catalogControlDigest', 'marketIdentityDigest', 'periodStartTs', 'periodEndTs',
  'receivedTs', 'utcDate', 'shardOrdinal', 'conflict',
]);
const SHARD_KEYS = Object.freeze([
  'entryVersion', 'kind', 'globalOrdinal', 'globalControlDigest', 'shardOrdinal',
  'admittedTs', 'knownAtTs', 'recordDigest', 'conflict', 'record',
]);
const FINALIZATION_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'sessionId', 'sessionStartedTs', 'cutoffTs', 'lastDataOrdinal',
  'lastDataControlDigest', 'activeCatalogContentId', 'activeCatalogControlDigest',
  'admittedCounts', 'shardFiles', 'plannedPhysicalRows', 'plannedBytes',
]);
const CLOSED_PAYLOAD_KEYS = Object.freeze([
  'close', 'finality', 'high', 'learningEligible', 'low', 'messageType', 'open',
  'sourceClockBasis', 'trades', 'volumeBase', 'vwap',
]);
const BROAD_RECORD_KEYS = Object.freeze([
  'recordVersion', 'recordId', 'sessionId', 'sequence', 'recordType', 'recordedTs',
  'catalogContentId', 'epochId', 'market', 'channel', 'quality', 'sourceEventTs',
  'receivedTs', 'periodStartTs', 'periodEndTs', 'payload',
]);
const BROAD_MARKET_KEYS = Object.freeze([
  'canonicalCoin', 'pairKey', 'nativeBase', 'catalogWsname', 'wsSymbol',
]);

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

export class BroadDayReaderError extends Error {
  constructor(code, message, detail = null) {
    super(`${code}: ${String(message).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 400)}`);
    this.name = 'BroadDayReaderError'; this.code = code; this.detail = detail;
  }
}

const fail = (code, message, detail = null) => { throw new BroadDayReaderError(code, message, detail); };

function exactKeys(value, keys) {
  if (!plain(value)) return 'not a record';
  for (const key of keys) if (!Object.hasOwn(value, key)) return `missing key ${key}`;
  for (const key of Object.keys(value)) if (!keys.includes(key)) return `undeclared key ${key}`;
  return null;
}

// This matches the writer's canonicalBounded JSON law. The physical line is
// already bounded before this traversal; depth/entry limits prevent hostile
// but small nested values from exhausting the call stack.
function canonicalBounded(value, maxBytes, { maxDepth = 32, maxEntries = 200_000 } = {}) {
  let bytes = 0; let entries = 0; const parts = []; const stack = new Set();
  const add = (part) => {
    const size = Buffer.byteLength(part, 'utf8');
    if (bytes + size > maxBytes) fail('READER_LINE_TOO_LARGE', `canonical row exceeds ${maxBytes} bytes`);
    bytes += size; parts.push(part);
  };
  const walk = (current, depth) => {
    if (depth > maxDepth) fail('READER_ROW_INVALID', 'row nesting exceeds bound');
    if (current === null) { add('null'); return; }
    if (typeof current === 'boolean') { add(current ? 'true' : 'false'); return; }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('READER_ROW_INVALID', 'non-finite number');
      add(JSON.stringify(current)); return;
    }
    if (typeof current === 'string') { add(JSON.stringify(current)); return; }
    if (!plain(current) && !Array.isArray(current)) fail('READER_ROW_INVALID', `unsupported value ${typeof current}`);
    if (stack.has(current)) fail('READER_ROW_INVALID', 'cyclic value');
    stack.add(current);
    if (Array.isArray(current)) {
      add('[');
      for (let i = 0; i < current.length; i += 1) {
        entries += 1; if (entries > maxEntries) fail('READER_ROW_INVALID', 'row entry count exceeds bound');
        if (i) add(','); walk(current[i], depth + 1);
      }
      add(']');
    } else {
      add('{'); let emitted = 0;
      for (const key of Object.keys(current).sort()) {
        if (current[key] === undefined) fail('READER_ROW_INVALID', `undefined field ${key}`);
        entries += 1; if (entries > maxEntries) fail('READER_ROW_INVALID', 'row entry count exceeds bound');
        if (emitted) add(','); add(JSON.stringify(key)); add(':'); walk(current[key], depth + 1); emitted += 1;
      }
      add('}');
    }
    stack.delete(current);
  };
  walk(value, 0);
  return { text: parts.join(''), bytes };
}

function limitsOf(overrides) {
  if (overrides !== undefined && !plain(overrides)) fail('READER_LIMITS_INVALID', 'limits must be a record');
  const unknown = Object.keys(overrides ?? {}).filter((key) => !(key in BROAD_DAY_READER_DEFAULTS));
  if (unknown.length) fail('READER_LIMITS_INVALID', `unknown limits ${unknown.join(',')}`);
  const limits = { ...BROAD_DAY_READER_DEFAULTS, ...(overrides ?? {}) };
  for (const [key, ceiling] of Object.entries(CEILINGS)) {
    if (!positive(limits[key]) || limits[key] > ceiling) fail('READER_LIMITS_INVALID', `${key} outside 1..${ceiling}`);
  }
  if (limits.maxCatalogLineBytes > limits.maxControlFileBytes
      || limits.maxRecordLineBytes > limits.maxShardBytes
      || limits.maxRecordLineBytes > limits.maxPageBytes) fail('READER_LIMITS_INVALID', 'single-row bounds exceed their enclosing budgets');
  return Object.freeze(limits);
}

function realDirectory(target, code) {
  if (!existsSync(target)) fail(code, 'directory does not exist');
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, 'directory must be real and not a symbolic link');
  return realpathSync(target);
}

function fileInfo(file, maximum) {
  if (!existsSync(file)) fail('READER_FILE_MISSING', 'required archive file is missing', { name: path.basename(file) });
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('READER_FILE_INVALID', 'archive file must be regular and not a symbolic link', { name: path.basename(file) });
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximum) fail('READER_FILE_LIMIT', 'archive file exceeds configured read bound', { name: path.basename(file), bytes: stat.size, maximum });
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function signalError(signal) {
  if (signal === undefined || signal === null) return null;
  if ((typeof signal !== 'object' && typeof signal !== 'function')
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') return 'signal must be an AbortSignal';
  return null;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) fail('READER_CANCELLED', 'archive read cancelled');
}

async function scanJsonl(file, {
  maxFileBytes, maxLineBytes, maxRows, onRow, signal = null,
}) {
  throwIfCancelled(signal);
  const before = fileInfo(file, maxFileBytes);
  if (before.size === 0) fail('READER_FILE_EMPTY', 'required JSONL file is empty', { name: path.basename(file) });
  const hash = createHash('sha256'); const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts = []; let lineBytes = 0; let rows = 0; let physicalBytes = 0; let endedWithNewline = false;
  const emitLine = async () => {
    throwIfCancelled(signal);
    if (lineBytes === 0) fail('READER_ROW_INVALID', 'blank JSONL row');
    let text;
    try { text = decoder.decode(Buffer.concat(parts, lineBytes)); }
    catch { fail('READER_UTF8_INVALID', 'archive row is not valid UTF-8', { name: path.basename(file), row: rows + 1 }); }
    let value;
    try { value = JSON.parse(text); }
    catch { fail('READER_JSON_INVALID', 'archive row is not valid JSON', { name: path.basename(file), row: rows + 1 }); }
    const canonical = canonicalBounded(value, maxLineBytes);
    if (canonical.text !== text) fail('READER_CANONICAL_MISMATCH', 'archive row is not the writer canonical form', { name: path.basename(file), row: rows + 1 });
    rows += 1; if (rows > maxRows) fail('READER_ROW_LIMIT', 'archive file row count exceeds bound', { name: path.basename(file), maxRows });
    await onRow(value, { row: rows, lineBytes: lineBytes + 1 });
    parts = []; lineBytes = 0;
  };
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    throwIfCancelled(signal);
    hash.update(chunk); physicalBytes += chunk.length;
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 0x0a) continue;
      throwIfCancelled(signal);
      const piece = chunk.subarray(start, i);
      lineBytes += piece.length;
      if (lineBytes > maxLineBytes) fail('READER_LINE_TOO_LARGE', 'physical JSONL row exceeds bound', { name: path.basename(file), maximum: maxLineBytes });
      if (piece.length) parts.push(piece);
      await emitLine(); start = i + 1; endedWithNewline = true;
    }
    if (start < chunk.length) {
      const piece = chunk.subarray(start); lineBytes += piece.length;
      if (lineBytes > maxLineBytes) fail('READER_LINE_TOO_LARGE', 'physical JSONL row exceeds bound', { name: path.basename(file), maximum: maxLineBytes });
      parts.push(piece); endedWithNewline = false;
    }
  }
  throwIfCancelled(signal);
  if (lineBytes !== 0 || !endedWithNewline) fail('READER_TRUNCATED_TAIL', 'JSONL file does not end at a complete newline', { name: path.basename(file) });
  const after = fileInfo(file, maxFileBytes);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || physicalBytes !== before.size) fail('READER_FILE_CHANGED', 'archive file changed during read', { name: path.basename(file) });
  return { rows, bytes: physicalBytes, digest: hash.digest('hex'), fingerprint: after };
}

function utcDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
function marketIdentity(market) {
  return {
    canonicalCoin: market.base, pairKey: market.pairKey,
    nativeBase: market.nativeBase, catalogWsname: market.wsname,
  };
}
function marketDigest(identity) { return sha256(canonicalBounded(identity, 4_096).text); }
function archiveMarketDigest(record) {
  return marketDigest({
    canonicalCoin: record.market.canonicalCoin, pairKey: record.market.pairKey,
    nativeBase: record.market.nativeBase, catalogWsname: record.market.catalogWsname,
  });
}
function digestWithout(value, key, maximum) {
  const body = { ...value }; delete body[key]; return sha256(canonicalBounded(body, maximum).text);
}
function chainDigest(previous, row) { return sha256(canonicalBounded({ previous, row }, 512 * 1024).text); }

function commonControlError(row, priorDigest, expectedOrdinal, entryVersion) {
  if (row.entryVersion !== entryVersion || row.globalOrdinal !== expectedOrdinal
      || row.previousControlDigest !== priorDigest || !positive(row.admittedTs) || !positive(row.knownAtTs)
      || row.knownAtTs > row.admittedTs || !HEX64.test(row.controlDigest ?? '')) return 'control identity, chain, or clocks malformed';
  if (digestWithout(row, 'controlDigest', 16 * 1024 * 1024) !== row.controlDigest) return 'control digest mismatch';
  return null;
}

function catalogControlError(row, limits, entryVersion, lastCatalog = null) {
  const v2 = entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2;
  const keys = exactKeys(row, v2 ? CATALOG_CONTROL_V2_KEYS : CATALOG_CONTROL_KEYS); if (keys) return keys;
  if (!['CATALOG_CONTROL', ...(v2 ? ['CATALOG_HEARTBEAT'] : [])].includes(row.kind) || !positive(row.sourceObservedTs)
      || row.sourceObservedTs > row.knownAtTs || row.contentId !== row.catalog?.contentId) return 'catalog control clocks/content malformed';
  const valid = validateBroadKrakenCatalog(row.catalog, { maxMarkets: 5_000 });
  if (!valid.ok || row.catalog.observedTs !== row.sourceObservedTs) return `catalog invalid (${valid.reason ?? 'observed clock mismatch'})`;
  const catalogBody = canonicalBounded(row.catalog, limits.maxCatalogLineBytes);
  if (sha256(catalogBody.text) !== row.catalogBodyDigest) return 'catalog body digest mismatch';
  if (v2) {
    const initial = lastCatalog === null;
    const expectedChange = initial ? 'INITIAL' : row.contentId === lastCatalog.contentId ? 'UNCHANGED' : 'CHANGED';
    const expectedKind = expectedChange === 'UNCHANGED' ? 'CATALOG_HEARTBEAT' : 'CATALOG_CONTROL';
    if (row.catalogChange !== expectedChange || row.kind !== expectedKind
        || row.priorCatalogControlDigest !== (lastCatalog?.controlDigest ?? null)
        || row.priorCatalogContentId !== (lastCatalog?.contentId ?? null)
        || (lastCatalog && (row.sourceObservedTs < lastCatalog.sourceObservedTs
          || row.knownAtTs < lastCatalog.knownAtTs))) return 'catalog heartbeat/change chain malformed';
  }
  return null;
}

function commonRecordError(record, entry, entryVersion = BROAD_DAY_ARCHIVE_ENTRY_VERSION) {
  const keys = exactKeys(record, BROAD_RECORD_KEYS); if (keys) return `record envelope ${keys}`;
  const marketKeys = exactKeys(record.market, BROAD_MARKET_KEYS); if (marketKeys) return `record market ${marketKeys}`;
  const requiredRecordVersion = entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 ? BROAD_KRAKEN_RECORD_VERSION_V2 : BROAD_KRAKEN_RECORD_VERSION;
  if (record.recordVersion !== requiredRecordVersion
      || typeof record.recordId !== 'string'
      || (requiredRecordVersion === BROAD_KRAKEN_RECORD_VERSION ? !/^bkr-[a-f0-9]{64}$/.test(record.recordId) : !/^bkr2-[a-f0-9]{64}$/.test(record.recordId))
      || !positive(record.recordedTs)
      || !positive(record.receivedTs) || record.receivedTs > record.recordedTs
      || record.recordedTs > entry.knownAtTs || record.catalogContentId !== entry.catalogContentId
      || typeof record.sessionId !== 'string' || record.sessionId.length < 1 || record.sessionId.length > 128
      || !positive(record.sequence) || typeof record.epochId !== 'string' || record.epochId.length < 1 || record.epochId.length > 160
      || !(record.market.wsSymbol === null || (typeof record.market.wsSymbol === 'string'
        && record.market.wsSymbol.length > 0 && record.market.wsSymbol.length <= 80))) return 'record clocks/identity disagree with archive custody';
  const digest = sha256(canonicalBounded(record, CEILINGS.maxRecordLineBytes).text);
  if (digest !== entry.recordDigest || record.recordId !== entry.recordId) return 'record digest/identity differs from control';
  if (requiredRecordVersion === BROAD_KRAKEN_RECORD_VERSION_V2) {
    try { if (broadKrakenRecordIdOf(record) !== record.recordId) return 'canonical source record identity mismatch'; }
    catch { return 'canonical source record identity uncomputable'; }
  }
  return null;
}

function recordMembershipError(record, catalogControl, expectedDigest = null) {
  if (!plain(record.market)) return 'record market missing';
  const member = catalogControl.catalog.markets.find((candidate) => candidate.base === record.market.canonicalCoin);
  if (!member || member.pairKey !== record.market.pairKey || member.nativeBase !== record.market.nativeBase
      || member.wsname !== record.market.catalogWsname) return 'record identity is not a member of referenced catalog';
  if (expectedDigest !== null && marketDigest(marketIdentity(member)) !== expectedDigest) return 'record market digest differs from index';
  return null;
}

function closedRecordError(record) {
  const payload = record.payload;
  if (record.recordType !== 'OHLC' || record.channel !== 'ohlc' || record.quality !== 'CONSERVATIVE_CLOSED'
      || record.sourceEventTs !== null || !positive(record.periodStartTs) || !positive(record.periodEndTs)
      || record.periodEndTs - record.periodStartTs !== MINUTE || record.periodEndTs > record.receivedTs
      || exactKeys(payload, CLOSED_PAYLOAD_KEYS)
      || payload.messageType !== 'closed' || payload.finality !== 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL'
      || payload.sourceClockBasis !== 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME' || payload.learningEligible !== false
      || ![payload.open, payload.high, payload.low, payload.close].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || payload.high < Math.max(payload.open, payload.close) || payload.low > Math.min(payload.open, payload.close) || payload.high < payload.low
      || !(payload.vwap === null || (typeof payload.vwap === 'number' && Number.isFinite(payload.vwap) && payload.vwap > 0))
      || typeof payload.volumeBase !== 'number' || !Number.isFinite(payload.volumeBase) || payload.volumeBase < 0
      || !count(payload.trades)) return 'closed conservative candle malformed';
  return null;
}

function sourceControlError(record) {
  if (!['INSTRUMENT_MAP', 'SUBSCRIPTION', 'GAP'].includes(record.recordType)) return 'archive source control type unsupported';
  if (record.periodStartTs !== null || record.periodEndTs !== null || record.sourceEventTs !== null) return 'source control carries market-data clocks';
  if (record.recordType === 'INSTRUMENT_MAP') {
    const state = record.payload?.mappingState;
    if (record.channel !== 'instrument' || !['MAPPED', 'UNSUPPORTED', 'AMBIGUOUS'].includes(state)
        || !Array.isArray(record.payload?.candidates) || record.payload.candidates.length > 8
        || record.payload.candidates.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 80)
        || (state === 'MAPPED' ? record.quality !== 'OBSERVED' || record.payload.candidates.length !== 1
          || !plain(record.payload.pair) || record.payload.pair.symbol !== record.market.wsSymbol
          || record.payload.pair.base !== record.market.nativeBase
          || record.payload.pair.quote !== 'USD' || record.payload.pair.status !== 'online'
          : record.quality !== 'FAILED' || record.payload.pair !== null
            || (state === 'UNSUPPORTED' ? record.payload.candidates.length !== 0 : record.payload.candidates.length < 2))) return 'instrument control malformed';
  } else if (record.recordType === 'SUBSCRIPTION') {
    const state = record.payload?.state;
    if (!['ticker', 'ohlc'].includes(record.channel) || !['PENDING', 'SUBSCRIBED', 'FAILED', 'UNSUPPORTED', 'AWAITING_INSTRUMENT'].includes(state)
        || (state === 'SUBSCRIBED' ? record.quality !== 'SUBSCRIBED' : state === 'FAILED' ? record.quality !== 'FAILED' : record.quality !== 'PROVISIONAL')) return 'subscription control malformed';
  } else if (!['ticker', 'ohlc'].includes(record.channel) || !['GAP', 'STOPPED'].includes(record.payload?.state)
      || typeof record.payload?.reason !== 'string' || record.payload.reason.length < 1
      || record.quality !== 'GAP'
      || (record.payload.reason === 'NO_NATIVE_INTERVAL'
        && (!positive(record.payload.sinceTs) || !positive(record.payload.untilTs)
          || record.payload.sinceTs >= record.payload.untilTs || record.payload.untilTs > record.receivedTs))) return 'gap control malformed';
  return null;
}

function expectedShardSummary(index) {
  return {
    globalOrdinal: index.globalOrdinal, globalControlDigest: index.controlDigest,
    shardOrdinal: index.shardOrdinal, admittedTs: index.admittedTs, knownAtTs: index.knownAtTs,
    recordId: index.recordId, recordDigest: index.recordDigest, conflict: index.conflict,
    catalogContentId: index.catalogContentId, marketIdentityDigest: index.marketIdentityDigest,
    periodStartTs: index.periodStartTs, periodEndTs: index.periodEndTs, receivedTs: index.receivedTs,
  };
}
function actualShardSummary(row) {
  return {
    globalOrdinal: row.globalOrdinal, globalControlDigest: row.globalControlDigest,
    shardOrdinal: row.shardOrdinal, admittedTs: row.admittedTs, knownAtTs: row.knownAtTs,
    recordId: row.record.recordId, recordDigest: row.recordDigest, conflict: row.conflict,
    catalogContentId: row.record.catalogContentId, marketIdentityDigest: archiveMarketDigest(row.record),
    periodStartTs: row.record.periodStartTs, periodEndTs: row.record.periodEndTs, receivedTs: row.record.receivedTs,
  };
}

function coverageState(identity, minutes) {
  return {
    identity, marketIdentityDigest: marketDigest(identity), minuteState: new Uint8Array(minutes), expectedMinuteState: new Uint8Array(minutes),
    rows: 0, eligibleRows: 0, duplicateRows: 0, futureWithheldRows: 0, conflictRows: 0,
    firstPeriodStartTs: null, lastPeriodEndTs: null,
    sessions: new Set(), catalogControls: new Set(), eligibleRecordIds: new Set(), gaps: 0,
  };
}

function publicCoverage(state, dayStartTs, dayEndTs, siblingCount) {
  let uniqueMinutes = 0; let conflictMinutes = 0; let expectedMinutes = 0; let outsideExpectedMinutes = 0;
  for (let i = 0; i < state.minuteState.length; i += 1) {
    const value = state.minuteState[i]; const expected = state.expectedMinuteState[i] === 1;
    if (expected) expectedMinutes += 1;
    if (value > 0 && expected) uniqueMinutes += 1;
    if (value > 1 && expected) conflictMinutes += 1;
    if (value > 0 && !expected) outsideExpectedMinutes += 1;
  }
  const missingMinutes = expectedMinutes - uniqueMinutes;
  const gridState = outsideExpectedMinutes > 0 ? 'OUTSIDE_CATALOG_EPOCH'
    : conflictMinutes > 0 ? 'CONFLICT'
    : uniqueMinutes === 0 ? 'MISSING'
      : missingMinutes === 0 && state.gaps === 0 ? 'COMPLETE_OBSERVED_GRID' : 'PARTIAL';
  return {
    marketIdentityDigest: state.marketIdentityDigest, market: state.identity,
    catalogIdentitySiblingCount: siblingCount,
    catalogControls: state.catalogControls.size, sessions: state.sessions.size,
    physicalRows: state.rows, asOfEligibleRows: state.eligibleRows, exactDuplicateRows: state.duplicateRows,
    futureAdmissionWithheldRows: state.futureWithheldRows,
    conflictRows: state.conflictRows, conflictMinutes, explicitGapControls: state.gaps,
    expectedCatalogMembershipMinutes: expectedMinutes, expectedCivilDayMinutes: (dayEndTs - dayStartTs) / MINUTE,
    uniqueObservedMinutes: uniqueMinutes, missingMinutes, outsideCatalogEpochMinutes: outsideExpectedMinutes,
    firstPeriodStartTs: state.firstPeriodStartTs, lastPeriodEndTs: state.lastPeriodEndTs,
    gridState,
    observedGridComplete: gridState === 'COMPLETE_OBSERVED_GRID',
    fullDaySimulationEligible: false,
  };
}

function cursorError(cursor, descriptor, shardCount) {
  if (cursor === null) return null;
  const keys = exactKeys(cursor, ['cursorVersion', 'datasetDigest', 'shardIndex', 'rowOffset', 'emittedRows', 'cursorDigest']);
  if (keys || cursor.cursorVersion !== BROAD_DAY_CURSOR_VERSION || cursor.datasetDigest !== descriptor.datasetDigest
      || !count(cursor.shardIndex) || cursor.shardIndex > shardCount || !count(cursor.rowOffset)
      || !count(cursor.emittedRows) || (cursor.shardIndex === shardCount && cursor.rowOffset !== 0)
      || !HEX64.test(cursor.cursorDigest ?? '')
      || cursor.cursorDigest !== digestWithout(cursor, 'cursorDigest', 4_096)) return 'cursor identity or position malformed';
  return null;
}

function marketCursorError(cursor, descriptor, marketIdentityDigest, shardCount) {
  if (cursor === null) return null;
  const keys = exactKeys(cursor, [
    'cursorVersion', 'datasetDigest', 'marketIdentityDigest', 'shardIndex',
    'rowOffset', 'emittedRows', 'cursorDigest',
  ]);
  if (keys || cursor.cursorVersion !== BROAD_DAY_MARKET_CURSOR_VERSION
      || cursor.datasetDigest !== descriptor.datasetDigest
      || cursor.marketIdentityDigest !== marketIdentityDigest
      || !count(cursor.shardIndex) || cursor.shardIndex > shardCount || !count(cursor.rowOffset)
      || !count(cursor.emittedRows) || (cursor.shardIndex === shardCount && cursor.rowOffset !== 0)
      || !HEX64.test(cursor.cursorDigest ?? '')
      || cursor.cursorDigest !== digestWithout(cursor, 'cursorDigest', 4_096)) return 'market cursor identity or position malformed';
  return null;
}

function pageRow(entry, sessionId, fileName) {
  const record = entry.record;
  return {
    rowVersion: 'broad-day-candle-row-v1',
    sessionId, shardFile: fileName, globalOrdinal: entry.globalOrdinal,
    globalControlDigest: entry.globalControlDigest, shardOrdinal: entry.shardOrdinal,
    archiveAdmittedTs: entry.admittedTs, asOfEligibleTs: entry.knownAtTs,
    recordId: record.recordId, recordDigest: entry.recordDigest,
    catalogContentId: record.catalogContentId, marketIdentityDigest: archiveMarketDigest(record),
    market: {
      canonicalCoin: record.market.canonicalCoin, pairKey: record.market.pairKey,
      nativeBase: record.market.nativeBase, catalogWsname: record.market.catalogWsname,
    },
    periodStartTs: record.periodStartTs, periodEndTs: record.periodEndTs,
    receivedTs: record.receivedTs, sourceRecordedTs: record.recordedTs,
    open: record.payload.open, high: record.payload.high, low: record.payload.low, close: record.payload.close,
    volumeBase: record.payload.volumeBase, volumeQuote: null,
    trades: record.payload.trades, vwap: record.payload.vwap,
    finality: record.payload.finality, conflict: entry.conflict,
    recordIntegrityVerified: true, conflictFree: entry.conflict === false,
    fullDaySimulationEligible: false,
  };
}

export async function openBroadDayReader({
  rootDir, dayStartTs, dayEndTs, asOfTs, limits: suppliedLimits, signal = null,
} = {}) {
  if (typeof rootDir !== 'string' || rootDir.length < 1) fail('READER_ROOT_INVALID', 'rootDir required');
  const abortError = signalError(signal); if (abortError) fail('READER_ARGUMENT_INVALID', abortError);
  throwIfCancelled(signal);
  const limits = limitsOf(suppliedLimits);
  if (!positive(dayStartTs) || !positive(dayEndTs) || dayEndTs <= dayStartTs
      || dayEndTs - dayStartTs < 23 * 60 * MINUTE || dayEndTs - dayStartTs > 25 * 60 * MINUTE
      || dayStartTs % MINUTE !== 0 || dayEndTs % MINUTE !== 0
      || (dayEndTs - dayStartTs) % MINUTE !== 0 || !positive(asOfTs) || asOfTs < dayEndTs
      || asOfTs - dayEndTs > limits.maxFinalizationLagMs) fail('READER_CLOCK_INVALID', 'completed-day/asOf clocks violate bounds');
  const archiveRoot = realDirectory(path.resolve(rootDir), 'READER_ROOT_INVALID');
  if (existsSync(path.join(archiveRoot, 'writer.lock'))) fail('READER_WRITER_ACTIVE', 'archive writer.lock is present; immutable snapshot unavailable');
  const sessionsRoot = realDirectory(path.join(archiveRoot, 'sessions'), 'READER_SESSIONS_MISSING');
  const initialNames = readdirSync(sessionsRoot).sort();
  if (initialNames.length < 1 || initialNames.length > limits.maxSessions || initialNames.some((name) => !SESSION_RE.test(name))) fail('READER_SESSION_INVENTORY_INVALID', 'session inventory empty, malformed, or over bound');

  const dayMinutes = (dayEndTs - dayStartTs) / MINUTE;
  const sessionMetas = []; const catalogObservations = []; const identities = new Map(); const eligibleIdentities = new Set(); const coverage = new Map();
  let totalBytes = 0; let totalControlRows = 0; let catalogControlCount = 0;
  let catalogHeartbeatCount = 0; let sessionFinalizationCount = 0;
  let sourceControlCount = 0; let candleIndexCount = 0; let candleRowCount = 0; let canonicalV2CandleRows = 0;
  let relevantRows = 0; let asOfEligibleRows = 0; let futureWithheldRows = 0; let staleCatalogControls = 0;
  let futureCatalogControlsWithheld = 0; let totalShardFiles = 0; let duplicateCandleRows = 0; let catalogAsOfWithheldRows = 0;
  const seenRecordDigests = new Map(); const eligibleCandleLocations = new Set();

  for (const sessionId of initialNames) {
    const sessionDir = realDirectory(path.join(sessionsRoot, sessionId), 'READER_SESSION_INVALID');
    const sessionEntries = readdirSync(sessionDir).sort();
    if (sessionEntries.some((name) => !['controls.jsonl', 'shards'].includes(name))) fail('READER_SESSION_INVENTORY_INVALID', 'session contains an undeclared file', { sessionId });
    const shardsDir = realDirectory(path.join(sessionDir, 'shards'), 'READER_SHARDS_MISSING');
    const shardNames = readdirSync(shardsDir).sort();
    totalShardFiles += shardNames.length;
    if (totalShardFiles > limits.maxShardFiles || shardNames.some((name) => !SHARD_RE.test(name))) fail('READER_SHARD_INVENTORY_INVALID', 'aggregate shard inventory malformed or over bound', { sessionId });
    const controlFile = path.join(sessionDir, 'controls.jsonl');
    if (!existsSync(controlFile)) {
      if (shardNames.length) fail('READER_CONTROL_MISSING', 'session has shards without a control ledger', { sessionId });
      sessionMetas.push({
        sessionId, controls: null, shards: [], empty: true, sourceDigest: sha256(`EMPTY:${sessionId}`),
        entryVersion: null, archiveVersion: null, startedTs: Number(SESSION_RE.exec(sessionId)?.[1]),
        firstCatalogAdmittedTs: null, finalized: null,
      });
      continue;
    }

    const catalogs = new Map(); const expectedShards = new Map();
    let lastDigest = null; let nextOrdinal = 1; let lastAdmittedTs = 0;
    let sessionEntryVersion = null; let lastCatalog = null; let finalized = null; let finalizationLineBytes = 0;
    const sessionCounts = { catalogControls: 0, catalogHeartbeats: 0, sourceControls: 0, closedCandles: 0 };
    const controls = await scanJsonl(controlFile, {
      maxFileBytes: limits.maxControlFileBytes,
      maxLineBytes: limits.maxCatalogLineBytes,
      maxRows: limits.maxControlRows,
      signal,
      onRow: async (row, rowMeta) => {
        totalControlRows += 1; if (totalControlRows > limits.maxControlRows) fail('READER_ROW_LIMIT', 'aggregate control rows exceed bound');
        if (sessionEntryVersion === null) {
          if (![BROAD_DAY_ARCHIVE_ENTRY_VERSION, BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2].includes(row?.entryVersion)) fail('READER_CONTROL_INVALID', 'unsupported session entry version', { sessionId, ordinal: nextOrdinal });
          sessionEntryVersion = row.entryVersion;
        }
        let keys;
        if (['CATALOG_CONTROL', 'CATALOG_HEARTBEAT'].includes(row?.kind)) keys = exactKeys(row, sessionEntryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 ? CATALOG_CONTROL_V2_KEYS : CATALOG_CONTROL_KEYS);
        else if (row?.kind === 'SOURCE_CONTROL') keys = exactKeys(row, SOURCE_CONTROL_KEYS);
        else if (row?.kind === 'CLOSED_CANDLE_INDEX') keys = exactKeys(row, CANDLE_INDEX_KEYS);
        else if (row?.kind === 'SESSION_FINALIZATION') keys = exactKeys(row, FINALIZATION_KEYS);
        else fail('READER_CONTROL_INVALID', 'unsupported control kind', { sessionId, ordinal: nextOrdinal });
        if (keys) fail('READER_CONTROL_INVALID', keys, { sessionId, ordinal: nextOrdinal });
        if (finalized) fail('READER_FINALIZATION_INVALID', 'control appears after session finalization', { sessionId, ordinal: nextOrdinal });
        const common = commonControlError(row, lastDigest, nextOrdinal, sessionEntryVersion);
        if (common || row.admittedTs < lastAdmittedTs) fail('READER_CONTROL_INVALID', common ?? 'control admission clock regressed', { sessionId, ordinal: nextOrdinal });
        if (['CATALOG_CONTROL', 'CATALOG_HEARTBEAT'].includes(row.kind)) {
          if (row.kind === 'CATALOG_CONTROL') { catalogControlCount += 1; sessionCounts.catalogControls += 1; }
          else { catalogHeartbeatCount += 1; sessionCounts.catalogHeartbeats += 1; }
          if (catalogControlCount + catalogHeartbeatCount > limits.maxCatalogControls) fail('READER_ROW_LIMIT', 'catalog-control count exceeds bound');
          const error = catalogControlError(row, limits, sessionEntryVersion, lastCatalog); if (error) fail('READER_CATALOG_CONTROL_INVALID', error, { sessionId, ordinal: row.globalOrdinal });
          const catalogState = Object.freeze({
            ...row,
            membershipKnownSinceTs: lastCatalog?.contentId === row.contentId
              ? lastCatalog.membershipKnownSinceTs : row.admittedTs,
          });
          catalogs.set(row.controlDigest, catalogState);
          const members = [];
          for (const market of row.catalog.markets) {
            const identity = marketIdentity(market); const digest = marketDigest(identity);
            if (!identities.has(digest)) identities.set(digest, identity);
            if (!coverage.has(digest)) coverage.set(digest, coverageState(identity, dayMinutes));
            members.push(digest);
          }
          catalogObservations.push({
            sessionId, globalOrdinal: row.globalOrdinal, controlDigest: row.controlDigest,
            catalogContentId: row.contentId, sourceObservedTs: row.sourceObservedTs,
            knownAtTs: row.knownAtTs, admittedTs: row.admittedTs,
            staleAtAdmission: row.knownAtTs - row.sourceObservedTs > limits.maxCatalogAgeMs,
            marketIdentityDigests: members.sort(), kind: row.kind, entryVersion: sessionEntryVersion,
            membershipKnownSinceTs: catalogState.membershipKnownSinceTs,
          });
          if (row.admittedTs > asOfTs) futureCatalogControlsWithheld += 1;
          lastCatalog = catalogState;
        } else if (row.kind === 'SESSION_FINALIZATION') {
          sessionFinalizationCount += 1;
          if (sessionEntryVersion !== BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2
              || row.sessionId !== sessionId || row.sessionStartedTs !== Number(SESSION_RE.exec(sessionId)?.[1])
              || row.cutoffTs < row.sessionStartedTs || row.cutoffTs > row.admittedTs
              || row.lastDataOrdinal !== row.globalOrdinal - 1 || row.lastDataControlDigest !== row.previousControlDigest
              || row.activeCatalogContentId !== (lastCatalog?.contentId ?? null)
              || row.activeCatalogControlDigest !== (lastCatalog?.controlDigest ?? null)
              || !plain(row.admittedCounts) || exactKeys(row.admittedCounts, Object.keys(sessionCounts))
              || Object.keys(sessionCounts).some((key) => row.admittedCounts[key] !== sessionCounts[key])
              || !count(row.shardFiles) || !count(row.plannedPhysicalRows) || !count(row.plannedBytes)) fail('READER_FINALIZATION_INVALID', 'session finalization receipt does not bind the preceding session', { sessionId, ordinal: row.globalOrdinal });
          finalized = row; finalizationLineBytes = rowMeta.lineBytes;
        } else {
          const catalog = catalogs.get(row.catalogControlDigest);
          if (!catalog || catalog.contentId !== row.catalogContentId || catalog.admittedTs > row.admittedTs) fail('READER_CATALOG_REFERENCE_INVALID', 'record control does not reference a prior catalog control', { sessionId, ordinal: row.globalOrdinal });
          if (row.kind === 'SOURCE_CONTROL') {
            sourceControlCount += 1;
            sessionCounts.sourceControls += 1;
            const commonRecord = commonRecordError(row.record, row, sessionEntryVersion);
            const membership = recordMembershipError(row.record, catalog);
            const source = sourceControlError(row.record);
            if (commonRecord || membership || source) fail('READER_SOURCE_CONTROL_INVALID', commonRecord ?? membership ?? source, { sessionId, ordinal: row.globalOrdinal });
            const priorRecordDigest = seenRecordDigests.get(row.recordId);
            if (priorRecordDigest && priorRecordDigest !== row.recordDigest) fail('READER_RECORD_ID_COLLISION', 'one source record identity has altered bytes across archive sessions', { sessionId, ordinal: row.globalOrdinal });
            seenRecordDigests.set(row.recordId, row.recordDigest);
            if (row.record.recordType === 'GAP' && row.record.channel === 'ohlc') {
              const digest = archiveMarketDigest(row.record); const state = coverage.get(digest);
              if (state && row.knownAtTs <= asOfTs) state.gaps += 1;
            }
          } else {
            candleIndexCount += 1; sessionCounts.closedCandles += 1;
            if (!positive(row.periodStartTs) || !positive(row.periodEndTs) || row.periodEndTs - row.periodStartTs !== MINUTE
                || row.utcDate !== utcDate(row.periodStartTs) || !positive(row.shardOrdinal)
                || typeof row.conflict !== 'boolean' || row.knownAtTs !== row.admittedTs
                || row.receivedTs > row.knownAtTs || !HEX64.test(row.recordDigest ?? '')
                || !HEX64.test(row.marketIdentityDigest ?? '')) fail('READER_CANDLE_INDEX_INVALID', 'candle index fields malformed', { sessionId, ordinal: row.globalOrdinal });
            const member = catalog.catalog.markets.find((candidate) => marketDigest(marketIdentity(candidate)) === row.marketIdentityDigest);
            if (!member) fail('READER_CANDLE_INDEX_INVALID', 'index market absent from referenced catalog', { sessionId, ordinal: row.globalOrdinal });
            const key = `${row.marketIdentityDigest}:${row.utcDate}`;
            const fileName = `market-${row.marketIdentityDigest.slice(0, 24)}-${row.utcDate}.jsonl`;
            const meta = expectedShards.get(key) ?? {
              key, fileName, identityDigest: row.marketIdentityDigest, utcDate: row.utcDate,
              expectedRows: 0, expectedChain: 'GENESIS', nextOrdinal: 1,
              catalogControlDigests: [],
            };
            if (meta.fileName !== fileName || meta.nextOrdinal !== row.shardOrdinal) fail('READER_CANDLE_INDEX_INVALID', 'shard ordinal or identity changed', { sessionId, ordinal: row.globalOrdinal });
            meta.expectedRows += 1; meta.nextOrdinal += 1;
            meta.catalogControlDigests.push(row.catalogControlDigest);
            meta.expectedChain = chainDigest(meta.expectedChain, expectedShardSummary(row));
            expectedShards.set(key, meta);
          }
        }
        lastDigest = row.controlDigest; lastAdmittedTs = row.admittedTs; nextOrdinal += 1;
      },
    });
    totalBytes += controls.bytes; if (totalBytes > limits.maxTotalBytes) fail('READER_TOTAL_BYTE_LIMIT', 'archive exceeds aggregate byte bound');

    const expectedByFile = new Map();
    for (const meta of expectedShards.values()) {
      if (expectedByFile.has(meta.fileName)) fail('READER_SHARD_IDENTITY_COLLISION', 'two full market identities collide on one shard filename', { sessionId, fileName: meta.fileName });
      expectedByFile.set(meta.fileName, meta);
    }
    if (shardNames.length !== expectedByFile.size || shardNames.some((name) => !expectedByFile.has(name))) fail('READER_SHARD_INVENTORY_MISMATCH', 'control ledger and shard files do not match exactly', { sessionId });
    const shardMetas = [];
    for (const fileName of shardNames) {
      const expected = expectedByFile.get(fileName); const file = path.join(shardsDir, fileName);
      let actualChain = 'GENESIS'; let nextShardOrdinal = 1; let relevantInShard = 0;
      const scanned = await scanJsonl(file, {
        maxFileBytes: limits.maxShardBytes, maxLineBytes: limits.maxRecordLineBytes,
        maxRows: limits.maxShardRows,
        signal,
        onRow: async (row) => {
          const keys = exactKeys(row, SHARD_KEYS); if (keys) fail('READER_SHARD_ROW_INVALID', keys, { sessionId, fileName, row: nextShardOrdinal });
          if (row.entryVersion !== sessionEntryVersion || row.kind !== 'CLOSED_CANDLE'
              || row.shardOrdinal !== nextShardOrdinal || row.knownAtTs !== row.admittedTs
              || typeof row.conflict !== 'boolean' || !HEX64.test(row.globalControlDigest ?? '')
              || !HEX64.test(row.recordDigest ?? '')) fail('READER_SHARD_ROW_INVALID', 'shard identity/clocks malformed', { sessionId, fileName, row: nextShardOrdinal });
          const commonRecord = commonRecordError(row.record, { ...row, catalogContentId: row.record.catalogContentId, recordId: row.record.recordId }, sessionEntryVersion);
          const catalog = catalogs.get(expected.catalogControlDigests[nextShardOrdinal - 1]);
          const membership = catalog ? recordMembershipError(row.record, catalog, expected.identityDigest) : 'shard record catalog is not present in session controls';
          const closed = closedRecordError(row.record);
          if (commonRecord || membership || closed) fail('READER_SHARD_ROW_INVALID', commonRecord ?? membership ?? closed, { sessionId, fileName, row: nextShardOrdinal });
          if (archiveMarketDigest(row.record) !== expected.identityDigest || utcDate(row.record.periodStartTs) !== expected.utcDate) fail('READER_SHARD_ROW_INVALID', 'row belongs to a different shard identity/day', { sessionId, fileName, row: nextShardOrdinal });
          const location = `${sessionId}:${fileName}:${row.shardOrdinal}`;
          const priorRecordDigest = seenRecordDigests.get(row.record.recordId);
          if (priorRecordDigest && priorRecordDigest !== row.recordDigest) fail('READER_RECORD_ID_COLLISION', 'one candle record identity has altered bytes across archive sessions', { sessionId, fileName, row: nextShardOrdinal });
          const exactDuplicate = priorRecordDigest === row.recordDigest;
          seenRecordDigests.set(row.record.recordId, row.recordDigest);
          actualChain = chainDigest(actualChain, actualShardSummary(row)); nextShardOrdinal += 1; candleRowCount += 1;
          if (row.record.periodStartTs >= dayStartTs && row.record.periodStartTs < dayEndTs) {
            relevantRows += 1; relevantInShard += 1;
            if (sessionEntryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2) canonicalV2CandleRows += 1;
            const state = coverage.get(expected.identityDigest); state.rows += 1; state.sessions.add(sessionId);
            if (exactDuplicate) { state.duplicateRows += 1; duplicateCandleRows += 1; }
            if (row.knownAtTs > asOfTs || row.record.recordedTs > asOfTs
                || catalog.membershipKnownSinceTs > row.record.periodStartTs) {
              state.futureWithheldRows += 1; futureWithheldRows += 1;
              if (catalog.membershipKnownSinceTs > row.record.periodStartTs) catalogAsOfWithheldRows += 1;
            } else if (!exactDuplicate || !state.eligibleRecordIds.has(row.record.recordId)) {
              state.eligibleRecordIds.add(row.record.recordId); eligibleCandleLocations.add(location);
              state.eligibleRows += 1; asOfEligibleRows += 1;
              const minute = (row.record.periodStartTs - dayStartTs) / MINUTE;
              if (!Number.isSafeInteger(minute) || minute < 0 || minute >= dayMinutes) fail('READER_SHARD_ROW_INVALID', 'candle is not aligned to the declared civil-day minute grid');
              if (row.conflict || state.minuteState[minute] > 0) {
                state.minuteState[minute] = 2; state.conflictRows += 1;
              } else state.minuteState[minute] = 1;
              state.firstPeriodStartTs = state.firstPeriodStartTs === null ? row.record.periodStartTs : Math.min(state.firstPeriodStartTs, row.record.periodStartTs);
              state.lastPeriodEndTs = state.lastPeriodEndTs === null ? row.record.periodEndTs : Math.max(state.lastPeriodEndTs, row.record.periodEndTs);
            }
          }
        },
      });
      if (scanned.rows !== expected.expectedRows || actualChain !== expected.expectedChain) fail('READER_SHARD_CONTROL_MISMATCH', 'shard rows do not exactly match the control ledger', { sessionId, fileName });
      totalBytes += scanned.bytes; if (totalBytes > limits.maxTotalBytes) fail('READER_TOTAL_BYTE_LIMIT', 'archive exceeds aggregate byte bound');
      shardMetas.push({
        sessionId, fileName, file, identityDigest: expected.identityDigest, utcDate: expected.utcDate,
        rows: scanned.rows, relevantRows: relevantInShard, bytes: scanned.bytes,
        digest: scanned.digest, fingerprint: scanned.fingerprint,
      });
    }
    const sourceDigest = sha256(canonicalBounded({
      sessionId, controlsDigest: controls.digest,
      shards: shardMetas.map((row) => ({ fileName: row.fileName, digest: row.digest, rows: row.rows, bytes: row.bytes })),
    }, 4 * 1024 * 1024).text);
    if (finalized) {
      const expectedPhysicalRows = finalized.lastDataOrdinal + sessionCounts.closedCandles;
      const expectedPhysicalBytes = controls.bytes - finalizationLineBytes + shardMetas.reduce((sum, shard) => sum + shard.bytes, 0);
      if (finalized.shardFiles !== shardMetas.length
          || finalized.plannedPhysicalRows !== expectedPhysicalRows
          || finalized.plannedBytes !== expectedPhysicalBytes) fail('READER_FINALIZATION_INVALID', 'session finalization physical counts do not match retained files', { sessionId });
    }
    sessionMetas.push({
      sessionId, controls: { file: controlFile, rows: controls.rows, bytes: controls.bytes, digest: controls.digest },
      shards: shardMetas, empty: false, sourceDigest, entryVersion: sessionEntryVersion,
      archiveVersion: sessionEntryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 ? BROAD_DAY_ARCHIVE_VERSION_V2 : BROAD_DAY_ARCHIVE_VERSION,
      startedTs: Number(SESSION_RE.exec(sessionId)?.[1]), firstCatalogAdmittedTs: catalogObservations.filter((row) => row.sessionId === sessionId).at(0)?.admittedTs ?? null,
      finalized: finalized ? { ordinal: finalized.globalOrdinal, controlDigest: finalized.controlDigest, cutoffTs: finalized.cutoffTs, admittedTs: finalized.admittedTs } : null,
    });
  }

  const finalNames = readdirSync(sessionsRoot).sort();
  if (existsSync(path.join(archiveRoot, 'writer.lock')) || JSON.stringify(finalNames) !== JSON.stringify(initialNames)) fail('READER_ARCHIVE_CHANGED', 'archive ownership/session inventory changed during read');
  catalogObservations.sort((a, b) => a.admittedTs - b.admittedTs || a.sessionId.localeCompare(b.sessionId) || a.globalOrdinal - b.globalOrdinal);
  const knownCatalogObservations = catalogObservations.filter((row) => row.admittedTs <= asOfTs);
  const epochs = [];
  for (let i = 0; i < knownCatalogObservations.length; i += 1) {
    const observation = knownCatalogObservations[i];
    const activeUntilTs = knownCatalogObservations[i + 1]?.admittedTs ?? Number.MAX_SAFE_INTEGER;
    if (observation.admittedTs >= dayEndTs || activeUntilTs <= dayStartTs) continue;
    const expectedStart = Math.max(dayStartTs, observation.admittedTs);
    const expectedEnd = Math.min(dayEndTs, activeUntilTs);
    const startMinute = Math.max(0, Math.ceil((expectedStart - dayStartTs) / MINUTE));
    const endMinute = Math.min(dayMinutes, Math.ceil((expectedEnd - dayStartTs) / MINUTE));
    for (const digest of observation.marketIdentityDigests) {
      eligibleIdentities.add(digest); coverage.get(digest).catalogControls.add(observation.controlDigest);
      for (let minute = startMinute; minute < endMinute; minute += 1) coverage.get(digest).expectedMinuteState[minute] = 1;
    }
    if (observation.staleAtAdmission) staleCatalogControls += 1;
    epochs.push({ ...observation, activeUntilTs: Math.min(activeUntilTs, dayEndTs) });
  }

  const relevantSessions = sessionMetas.filter((session) => session.empty
    ? session.startedTs < dayEndTs
    : session.firstCatalogAdmittedTs !== null && session.firstCatalogAdmittedTs < dayEndTs
      && (session.finalized?.cutoffTs ?? Number.MAX_SAFE_INTEGER) > dayStartTs);
  const allRelevantSessionsV2 = relevantSessions.length > 0
    && relevantSessions.every((session) => session.entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2);
  const sessionIntervals = relevantSessions.filter((session) => session.entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 && session.finalized)
    .map((session) => ({ startTs: session.firstCatalogAdmittedTs, endTs: session.finalized.cutoffTs, sessionId: session.sessionId }))
    .sort((a, b) => a.startTs - b.startTs || a.sessionId.localeCompare(b.sessionId));
  let sessionCursor = dayStartTs;
  for (const interval of sessionIntervals) {
    if (interval.endTs <= sessionCursor) continue;
    if (interval.startTs > sessionCursor) break;
    sessionCursor = Math.max(sessionCursor, interval.endTs);
  }
  const sessionFinalizationVerified = allRelevantSessionsV2
    && relevantSessions.every((session) => session.finalized !== null) && sessionCursor >= dayEndTs;

  const scheduleStartIndex = knownCatalogObservations.findLastIndex((row) => row.admittedTs <= dayStartTs);
  let scheduleEndIndex = -1;
  if (scheduleStartIndex >= 0) {
    scheduleEndIndex = knownCatalogObservations.findIndex((row, index) => index >= scheduleStartIndex && row.admittedTs >= dayEndTs);
  }
  const schedule = scheduleStartIndex >= 0 && scheduleEndIndex >= scheduleStartIndex
    ? knownCatalogObservations.slice(scheduleStartIndex, scheduleEndIndex + 1) : [];
  let scheduleGapMaxMs = null;
  if (schedule.length > 1) scheduleGapMaxMs = schedule.slice(1).reduce((maximum, row, index) => Math.max(maximum, row.admittedTs - schedule[index].admittedTs), 0);
  const catalogHeartbeatContinuityVerified = schedule.length > 0
    && schedule.every((row) => row.entryVersion === BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 && !row.staleAtAdmission)
    && schedule.slice(1).every((row, index) => row.sourceObservedTs >= schedule[index].sourceObservedTs)
    && schedule[0].admittedTs <= dayStartTs && schedule.at(-1).admittedTs >= dayEndTs
    && scheduleGapMaxMs !== null && scheduleGapMaxMs <= limits.maxCatalogHeartbeatGapMs;

  const siblingCounts = new Map();
  for (const [digest, identity] of identities) if (eligibleIdentities.has(digest)) siblingCounts.set(identity.canonicalCoin, (siblingCounts.get(identity.canonicalCoin) ?? 0) + 1);
  const publicCoverageRows = [...coverage.values()].filter((state) => eligibleIdentities.has(state.marketIdentityDigest)).map((state) => publicCoverage(state, dayStartTs, dayEndTs, siblingCounts.get(state.identity.canonicalCoin))).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest));
  const completeGrids = publicCoverageRows.filter((row) => row.gridState === 'COMPLETE_OBSERVED_GRID').length;
  const conflicts = publicCoverageRows.filter((row) => row.gridState === 'CONFLICT').length;
  const identityChanges = [...siblingCounts.values()].filter((value) => value > 1).length;
  const sourceRecordIdentityRecomputable = relevantRows > 0 && canonicalV2CandleRows === relevantRows;
  const fullPopulationVerified = sourceRecordIdentityRecomputable && sessionFinalizationVerified && catalogHeartbeatContinuityVerified && eligibleIdentities.size > 0;
  const allExpectedGridsComplete = publicCoverageRows.length === eligibleIdentities.size
    && publicCoverageRows.length > 0 && publicCoverageRows.every((row) => row.gridState === 'COMPLETE_OBSERVED_GRID' && row.expectedCatalogMembershipMinutes > 0);
  const fullDaySimulationReady = fullPopulationVerified && allExpectedGridsComplete
    && futureWithheldRows === 0 && catalogAsOfWithheldRows === 0
    && identityChanges === 0;
  const reasons = [];
  if (!sourceRecordIdentityRecomputable) reasons.push('SOURCE_RECORD_IDENTITY_NOT_CANONICALLY_RECOMPUTABLE_FOR_ALL_DAY_ROWS');
  if (!sessionFinalizationVerified) reasons.push('SESSION_FINALIZATION_OR_EXACT_CROSS_SESSION_COVERAGE_MISSING');
  if (!catalogHeartbeatContinuityVerified) reasons.push('CATALOG_HEARTBEAT_SCHEDULE_OR_BOUNDARY_PROOF_MISSING');
  if (sessionMetas.some((row) => row.empty)) reasons.push('EMPTY_ARCHIVE_SESSION_PRESENT');
  if (staleCatalogControls) reasons.push('STALE_CATALOG_CONTROL_PRESENT');
  if (futureWithheldRows) reasons.push('ROWS_KNOWN_AFTER_DATASET_ASOF_WITHHELD');
  if (futureCatalogControlsWithheld) reasons.push('CATALOG_CONTROLS_KNOWN_AFTER_DATASET_ASOF_WITHHELD');
  if (catalogAsOfWithheldRows) reasons.push('CANDLE_CATALOG_MEMBERSHIP_NOT_KNOWN_AT_PERIOD_START');
  if (conflicts) reasons.push('CONFLICTING_CANDLE_MINUTES_PRESENT');
  if (!allExpectedGridsComplete) {
    reasons.push('CANDLE_GRID_INCOMPLETE');
    reasons.push('CANDLE_GRID_INCOMPLETE_FOR_OBSERVED_MEMBERSHIP_EPOCHS');
  }
  if (identityChanges) reasons.push('CANONICAL_COIN_IDENTITY_CHANGED_ACROSS_OBSERVED_CATALOG_EPOCHS');

  const sessionSources = sessionMetas.map((session) => ({
    sessionId: session.sessionId, empty: session.empty, sourceDigest: session.sourceDigest,
    archiveVersion: session.archiveVersion ?? null, entryVersion: session.entryVersion ?? null,
    startedTs: session.startedTs ?? null, finalized: session.finalized,
    controlRows: session.controls?.rows ?? 0, controlBytes: session.controls?.bytes ?? 0,
    shards: session.shards.map((shard) => ({ fileName: shard.fileName, digest: shard.digest, rows: shard.rows, bytes: shard.bytes })),
  }));
  const descriptorBody = {
    datasetVersion: BROAD_DAY_DATASET_VERSION,
    archiveVersion: sessionMetas.some((row) => !row.empty)
      && sessionMetas.every((row) => row.empty || row.archiveVersion === BROAD_DAY_ARCHIVE_VERSION_V2)
      ? BROAD_DAY_ARCHIVE_VERSION_V2 : BROAD_DAY_ARCHIVE_VERSION,
    dayStartTs, dayEndTs, asOfTs,
    sourceProvenance: {
      sourceKind: allRelevantSessionsV2 ? 'LOCAL_BROAD_DAY_ARCHIVE_V2' : 'LOCAL_BROAD_DAY_ARCHIVE_MIXED_OR_V1',
      sourceRootDigest: sha256(archiveRoot), sessions: sessionSources,
      durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    },
    catalogEpochs: epochs,
    catalogUnion: [...identities.entries()].filter(([marketIdentityDigest]) => eligibleIdentities.has(marketIdentityDigest)).map(([marketIdentityDigest, identity]) => ({ marketIdentityDigest, market: identity })).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest)),
    coverage: publicCoverageRows,
    counters: {
      sessions: sessionMetas.length, emptySessions: sessionMetas.filter((row) => row.empty).length,
      catalogControls: catalogControlCount, catalogHeartbeats: catalogHeartbeatCount,
      sessionFinalizations: sessionFinalizationCount, futureCatalogControlsWithheld, staleCatalogControls, sourceControls: sourceControlCount,
      candleIndexes: candleIndexCount, candleRows: candleRowCount,
      civilDayRows: relevantRows, asOfEligibleCivilDayRows: asOfEligibleRows,
      futureAdmissionWithheldRows: futureWithheldRows, catalogAsOfWithheldRows, observedCatalogUnionMarkets: eligibleIdentities.size,
      exactDuplicateCandleRows: duplicateCandleRows,
      completeObservedMinuteGrids: completeGrids, conflictMarkets: conflicts,
      canonicalCoinsWithIdentityChanges: identityChanges, totalPhysicalBytes: totalBytes,
    },
    completeness: {
      physicalControlAndShardIntegrityVerified: true,
      sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite: sourceRecordIdentityRecomputable,
      observedCatalogEpochUnionConstructed: true,
      catalogEpochContinuityVerified: catalogHeartbeatContinuityVerified,
      catalogHeartbeatMaxObservedGapMs: scheduleGapMaxMs,
      catalogHeartbeatRequiredMaximumGapMs: limits.maxCatalogHeartbeatGapMs,
      sessionFinalizationVerified,
      fullPopulationVerified,
      fullDaySimulationReady,
      reasons: [...new Set(reasons)].sort(),
    },
    ordering: 'SESSION_ID_THEN_SHARD_FILENAME_THEN_PHYSICAL_SHARD_ORDINAL',
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
  };
  const datasetDigest = sha256(canonicalBounded(descriptorBody, 64 * 1024 * 1024).text);
  const descriptor = freeze({
    ...clone(descriptorBody), datasetDigest, datasetId: `bdd-${datasetDigest}`,
  });
  const pageShards = sessionMetas.flatMap((session) => session.shards).sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.fileName.localeCompare(b.fileName));
  const marketPageShards = new Map(descriptor.catalogUnion.map((row) => [row.marketIdentityDigest, []]));
  for (const shard of pageShards) marketPageShards.get(shard.identityDigest)?.push(shard);
  let closed = false;

  const status = () => freeze({
    version: 'broad-day-reader-v1', state: closed ? 'CLOSED' : 'OPEN',
    datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
    shards: pageShards.length, rows: descriptor.counters.asOfEligibleCivilDayRows,
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    fullDaySimulationReady: descriptor.completeness.fullDaySimulationReady, authority: 'NONE',
  });

  const assertInventoryUnchanged = () => {
    if (existsSync(path.join(archiveRoot, 'writer.lock'))
        || JSON.stringify(readdirSync(sessionsRoot).sort()) !== JSON.stringify(initialNames)) {
      fail('READER_ARCHIVE_CHANGED', 'archive ownership/session inventory changed after reader construction');
    }
    for (const session of sessionMetas) {
      const sessionDir = path.join(sessionsRoot, session.sessionId);
      const entries = readdirSync(sessionDir).sort();
      if (JSON.stringify(entries) !== JSON.stringify(['controls.jsonl', 'shards']) && !session.empty) {
        fail('READER_ARCHIVE_CHANGED', 'session inventory changed after reader construction', { sessionId: session.sessionId });
      }
      if (session.empty && JSON.stringify(entries) !== JSON.stringify(['shards'])) {
        fail('READER_ARCHIVE_CHANGED', 'empty session inventory changed after reader construction', { sessionId: session.sessionId });
      }
      const shardNames = readdirSync(path.join(sessionDir, 'shards')).sort();
      if (JSON.stringify(shardNames) !== JSON.stringify(session.shards.map((row) => row.fileName).sort())) {
        fail('READER_ARCHIVE_CHANGED', 'session shard inventory changed after reader construction', { sessionId: session.sessionId });
      }
    }
  };

  const scanProjectedPage = async ({ shards, cursor, maxRows, pageSignal }) => {
    let shardIndex = cursor?.shardIndex ?? 0; let rowOffset = cursor?.rowOffset ?? 0;
    const rows = []; let rowBytes = 0;
    let stopped = false; let nextShardIndex = shards.length; let nextRowOffset = 0;
    while (shardIndex < shards.length && !stopped) {
      const meta = shards[shardIndex]; let physicalRow = 0;
      if (rowOffset > meta.rows) fail('READER_CURSOR_INVALID', 'cursor rowOffset exceeds shard rows');
      const rescanned = await scanJsonl(meta.file, {
        maxFileBytes: limits.maxShardBytes, maxLineBytes: limits.maxRecordLineBytes, maxRows: limits.maxShardRows,
        signal: pageSignal ?? signal,
        onRow: async (entry) => {
          physicalRow += 1;
          if (physicalRow <= rowOffset || stopped) return;
          const location = `${meta.sessionId}:${meta.fileName}:${entry.shardOrdinal}`;
          if (!eligibleCandleLocations.has(location)) return;
          if (entry.record.periodStartTs < dayStartTs || entry.record.periodStartTs >= dayEndTs
              || entry.knownAtTs > asOfTs || entry.record.recordedTs > asOfTs) return;
          const projected = pageRow(entry, meta.sessionId, meta.fileName);
          const projectedBytes = Buffer.byteLength(canonicalBounded(projected, limits.maxRecordLineBytes).text, 'utf8') + 1;
          if (rows.length >= maxRows || rowBytes + projectedBytes > limits.maxPageBytes) {
            if (rows.length === 0) fail('READER_PAGE_LIMIT', 'one projected row exceeds the page-byte bound');
            stopped = true; nextShardIndex = shardIndex; nextRowOffset = physicalRow - 1; return;
          }
          rows.push(projected); rowBytes += projectedBytes;
          nextShardIndex = shardIndex; nextRowOffset = physicalRow;
        },
      });
      if (rescanned.digest !== meta.digest || rescanned.bytes !== meta.bytes || rescanned.rows !== meta.rows) fail('READER_FILE_CHANGED', 'verified shard changed before/during page read', { sessionId: meta.sessionId, fileName: meta.fileName });
      if (!stopped) { shardIndex += 1; rowOffset = 0; nextShardIndex = shardIndex; nextRowOffset = 0; }
    }
    return { rows, rowBytes, nextShardIndex, nextRowOffset, done: nextShardIndex >= shards.length };
  };

  const readPage = async ({ cursor = null, maxRows = limits.maxPageRows, signal: pageSignal = null } = {}) => {
    if (closed) fail('READER_CLOSED', 'reader is closed');
    const pageAbortError = signalError(pageSignal); if (pageAbortError) fail('READER_ARGUMENT_INVALID', pageAbortError);
    throwIfCancelled(signal); throwIfCancelled(pageSignal);
    const cursorErr = cursorError(cursor, descriptor, pageShards.length); if (cursorErr) fail('READER_CURSOR_INVALID', cursorErr);
    if (!positive(maxRows) || maxRows > limits.maxPageRows) fail('READER_PAGE_LIMIT', 'maxRows outside configured bound');
    assertInventoryUnchanged();
    const scanned = await scanProjectedPage({ shards: pageShards, cursor, maxRows, pageSignal });
    assertInventoryUnchanged();
    const { rows, rowBytes, nextShardIndex, nextRowOffset, done } = scanned;
    const priorEmitted = cursor?.emittedRows ?? 0;
    const nextCursor = {
      cursorVersion: BROAD_DAY_CURSOR_VERSION, datasetDigest: descriptor.datasetDigest,
      shardIndex: done ? pageShards.length : nextShardIndex,
      rowOffset: done ? 0 : nextRowOffset,
      emittedRows: priorEmitted + rows.length,
      cursorDigest: '',
    };
    nextCursor.cursorDigest = digestWithout(nextCursor, 'cursorDigest', 4_096);
    const body = {
      pageVersion: BROAD_DAY_PAGE_VERSION, datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, cursor, nextCursor, done,
      rows, rowBytes, rowCount: rows.length,
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    const pageDigest = sha256(canonicalBounded(body, limits.maxPageBytes + 512 * 1024).text);
    return freeze({ ...body, pageDigest });
  };

  const readMarketPage = async ({ marketIdentityDigest, cursor = null, maxRows = limits.maxPageRows, signal: pageSignal = null } = {}) => {
    if (closed) fail('READER_CLOSED', 'reader is closed');
    const pageAbortError = signalError(pageSignal); if (pageAbortError) fail('READER_ARGUMENT_INVALID', pageAbortError);
    throwIfCancelled(signal); throwIfCancelled(pageSignal);
    if (!HEX64.test(marketIdentityDigest ?? '') || !marketPageShards.has(marketIdentityDigest)) {
      fail('READER_MARKET_INVALID', 'market identity is absent from the sealed dataset denominator');
    }
    const shards = marketPageShards.get(marketIdentityDigest);
    const cursorErr = marketCursorError(cursor, descriptor, marketIdentityDigest, shards.length);
    if (cursorErr) fail('READER_CURSOR_INVALID', cursorErr);
    if (!positive(maxRows) || maxRows > limits.maxPageRows) fail('READER_PAGE_LIMIT', 'maxRows outside configured bound');
    assertInventoryUnchanged();
    const scanned = await scanProjectedPage({ shards, cursor, maxRows, pageSignal });
    assertInventoryUnchanged();
    const { rows, rowBytes, nextShardIndex, nextRowOffset, done } = scanned;
    if (rows.some((row) => row.marketIdentityDigest !== marketIdentityDigest)) {
      fail('READER_MARKET_PAGE_INVALID', 'market page crossed the requested identity boundary');
    }
    const priorEmitted = cursor?.emittedRows ?? 0;
    const nextCursor = {
      cursorVersion: BROAD_DAY_MARKET_CURSOR_VERSION, datasetDigest: descriptor.datasetDigest,
      marketIdentityDigest, shardIndex: done ? shards.length : nextShardIndex,
      rowOffset: done ? 0 : nextRowOffset, emittedRows: priorEmitted + rows.length,
      cursorDigest: '',
    };
    nextCursor.cursorDigest = digestWithout(nextCursor, 'cursorDigest', 4_096);
    const body = {
      pageVersion: BROAD_DAY_MARKET_PAGE_VERSION, datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, marketIdentityDigest,
      cursor, nextCursor, done, rows, rowBytes, rowCount: rows.length,
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    const pageDigest = sha256(canonicalBounded(body, limits.maxPageBytes + 512 * 1024).text);
    return freeze({ ...body, pageDigest });
  };

  const close = () => { closed = true; return status(); };
  return Object.freeze({ version: 'broad-day-reader-v1', descriptor, readPage, readMarketPage, status, close });
}
