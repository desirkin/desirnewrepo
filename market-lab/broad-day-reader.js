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
  validateBroadKrakenCatalog,
} from './broad-kraken.js';
import {
  BROAD_DAY_ARCHIVE_ENTRY_VERSION,
  BROAD_DAY_ARCHIVE_VERSION,
} from './broad-day-archive.js';

export const BROAD_DAY_DATASET_VERSION = 'broad-day-dataset-v1';
export const BROAD_DAY_CURSOR_VERSION = 'broad-day-reader-cursor-v1';
export const BROAD_DAY_PAGE_VERSION = 'broad-day-reader-page-v1';
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

function commonControlError(row, priorDigest, expectedOrdinal) {
  if (row.entryVersion !== BROAD_DAY_ARCHIVE_ENTRY_VERSION || row.globalOrdinal !== expectedOrdinal
      || row.previousControlDigest !== priorDigest || !positive(row.admittedTs) || !positive(row.knownAtTs)
      || row.knownAtTs > row.admittedTs || !HEX64.test(row.controlDigest ?? '')) return 'control identity, chain, or clocks malformed';
  if (digestWithout(row, 'controlDigest', 16 * 1024 * 1024) !== row.controlDigest) return 'control digest mismatch';
  return null;
}

function catalogControlError(row, limits) {
  const keys = exactKeys(row, CATALOG_CONTROL_KEYS); if (keys) return keys;
  if (row.kind !== 'CATALOG_CONTROL' || !positive(row.sourceObservedTs)
      || row.sourceObservedTs > row.knownAtTs || row.contentId !== row.catalog?.contentId) return 'catalog control clocks/content malformed';
  const valid = validateBroadKrakenCatalog(row.catalog, { maxMarkets: 5_000 });
  if (!valid.ok || row.catalog.observedTs !== row.sourceObservedTs) return `catalog invalid (${valid.reason ?? 'observed clock mismatch'})`;
  const catalogBody = canonicalBounded(row.catalog, limits.maxCatalogLineBytes);
  if (sha256(catalogBody.text) !== row.catalogBodyDigest) return 'catalog body digest mismatch';
  return null;
}

function commonRecordError(record, entry) {
  const keys = exactKeys(record, BROAD_RECORD_KEYS); if (keys) return `record envelope ${keys}`;
  const marketKeys = exactKeys(record.market, BROAD_MARKET_KEYS); if (marketKeys) return `record market ${marketKeys}`;
  if (record.recordVersion !== BROAD_KRAKEN_RECORD_VERSION
      || typeof record.recordId !== 'string' || !/^bkr-[a-f0-9]{64}$/.test(record.recordId)
      || !positive(record.recordedTs)
      || !positive(record.receivedTs) || record.receivedTs > record.recordedTs
      || record.recordedTs > entry.knownAtTs || record.catalogContentId !== entry.catalogContentId
      || typeof record.sessionId !== 'string' || record.sessionId.length < 1 || record.sessionId.length > 128
      || !positive(record.sequence) || typeof record.epochId !== 'string' || record.epochId.length < 1 || record.epochId.length > 160
      || !(record.market.wsSymbol === null || (typeof record.market.wsSymbol === 'string'
        && record.market.wsSymbol.length > 0 && record.market.wsSymbol.length <= 80))) return 'record clocks/identity disagree with archive custody';
  const digest = sha256(canonicalBounded(record, CEILINGS.maxRecordLineBytes).text);
  if (digest !== entry.recordDigest || record.recordId !== entry.recordId) return 'record digest/identity differs from control';
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
    identity, marketIdentityDigest: marketDigest(identity), minuteState: new Uint8Array(minutes),
    rows: 0, eligibleRows: 0, duplicateRows: 0, futureWithheldRows: 0, conflictRows: 0,
    firstPeriodStartTs: null, lastPeriodEndTs: null,
    sessions: new Set(), catalogControls: new Set(), eligibleRecordIds: new Set(), gaps: 0,
  };
}

function publicCoverage(state, dayStartTs, dayEndTs, siblingCount) {
  let uniqueMinutes = 0; let conflictMinutes = 0;
  for (const value of state.minuteState) {
    if (value > 0) uniqueMinutes += 1;
    if (value > 1) conflictMinutes += 1;
  }
  const expectedMinutes = (dayEndTs - dayStartTs) / MINUTE;
  const missingMinutes = expectedMinutes - uniqueMinutes;
  const gridState = conflictMinutes > 0 ? 'CONFLICT'
    : uniqueMinutes === 0 ? 'MISSING'
      : missingMinutes === 0 && state.gaps === 0 ? 'COMPLETE_OBSERVED_GRID' : 'PARTIAL';
  return {
    marketIdentityDigest: state.marketIdentityDigest, market: state.identity,
    catalogIdentitySiblingCount: siblingCount,
    catalogControls: state.catalogControls.size, sessions: state.sessions.size,
    physicalRows: state.rows, asOfEligibleRows: state.eligibleRows, exactDuplicateRows: state.duplicateRows,
    futureAdmissionWithheldRows: state.futureWithheldRows,
    conflictRows: state.conflictRows, conflictMinutes, explicitGapControls: state.gaps,
    expectedCivilDayMinutes: expectedMinutes, uniqueObservedMinutes: uniqueMinutes, missingMinutes,
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
  const sessionMetas = []; const epochs = []; const identities = new Map(); const eligibleIdentities = new Set(); const coverage = new Map();
  let totalBytes = 0; let totalControlRows = 0; let catalogControlCount = 0;
  let sourceControlCount = 0; let candleIndexCount = 0; let candleRowCount = 0;
  let relevantRows = 0; let asOfEligibleRows = 0; let futureWithheldRows = 0; let staleCatalogControls = 0;
  let futureCatalogControlsWithheld = 0; let totalShardFiles = 0; let duplicateCandleRows = 0;
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
      sessionMetas.push({ sessionId, controls: null, shards: [], empty: true, sourceDigest: sha256(`EMPTY:${sessionId}`) });
      continue;
    }

    const catalogs = new Map(); const catalogsByContentId = new Map(); const expectedShards = new Map();
    let lastDigest = null; let nextOrdinal = 1; let lastAdmittedTs = 0;
    const controls = await scanJsonl(controlFile, {
      maxFileBytes: limits.maxControlFileBytes,
      maxLineBytes: limits.maxCatalogLineBytes,
      maxRows: limits.maxControlRows,
      signal,
      onRow: async (row) => {
        totalControlRows += 1; if (totalControlRows > limits.maxControlRows) fail('READER_ROW_LIMIT', 'aggregate control rows exceed bound');
        let keys;
        if (row?.kind === 'CATALOG_CONTROL') keys = exactKeys(row, CATALOG_CONTROL_KEYS);
        else if (row?.kind === 'SOURCE_CONTROL') keys = exactKeys(row, SOURCE_CONTROL_KEYS);
        else if (row?.kind === 'CLOSED_CANDLE_INDEX') keys = exactKeys(row, CANDLE_INDEX_KEYS);
        else fail('READER_CONTROL_INVALID', 'unsupported control kind', { sessionId, ordinal: nextOrdinal });
        if (keys) fail('READER_CONTROL_INVALID', keys, { sessionId, ordinal: nextOrdinal });
        const common = commonControlError(row, lastDigest, nextOrdinal);
        if (common || row.admittedTs < lastAdmittedTs) fail('READER_CONTROL_INVALID', common ?? 'control admission clock regressed', { sessionId, ordinal: nextOrdinal });
        if (row.kind === 'CATALOG_CONTROL') {
          catalogControlCount += 1; if (catalogControlCount > limits.maxCatalogControls) fail('READER_ROW_LIMIT', 'catalog-control count exceeds bound');
          const error = catalogControlError(row, limits); if (error) fail('READER_CATALOG_CONTROL_INVALID', error, { sessionId, ordinal: row.globalOrdinal });
          catalogs.set(row.controlDigest, row); catalogsByContentId.set(row.contentId, row);
          const members = [];
          for (const market of row.catalog.markets) {
            const identity = marketIdentity(market); const digest = marketDigest(identity);
            if (!identities.has(digest)) identities.set(digest, identity);
            if (!coverage.has(digest)) coverage.set(digest, coverageState(identity, dayMinutes));
            if (row.admittedTs <= asOfTs) {
              eligibleIdentities.add(digest); coverage.get(digest).catalogControls.add(row.controlDigest);
            }
            members.push(digest);
          }
          if (row.admittedTs <= asOfTs) {
            if (row.knownAtTs - row.sourceObservedTs > limits.maxCatalogAgeMs) staleCatalogControls += 1;
            epochs.push({
              sessionId, globalOrdinal: row.globalOrdinal, controlDigest: row.controlDigest,
              catalogContentId: row.contentId, sourceObservedTs: row.sourceObservedTs,
              knownAtTs: row.knownAtTs, admittedTs: row.admittedTs,
              staleAtAdmission: row.knownAtTs - row.sourceObservedTs > limits.maxCatalogAgeMs,
              marketIdentityDigests: members.sort(),
            });
          } else futureCatalogControlsWithheld += 1;
        } else {
          const catalog = catalogs.get(row.catalogControlDigest);
          if (!catalog || catalog.contentId !== row.catalogContentId || catalog.admittedTs > row.admittedTs) fail('READER_CATALOG_REFERENCE_INVALID', 'record control does not reference a prior catalog control', { sessionId, ordinal: row.globalOrdinal });
          if (row.kind === 'SOURCE_CONTROL') {
            sourceControlCount += 1;
            const commonRecord = commonRecordError(row.record, row);
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
            candleIndexCount += 1;
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
            };
            if (meta.fileName !== fileName || meta.nextOrdinal !== row.shardOrdinal) fail('READER_CANDLE_INDEX_INVALID', 'shard ordinal or identity changed', { sessionId, ordinal: row.globalOrdinal });
            meta.expectedRows += 1; meta.nextOrdinal += 1;
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
          if (row.entryVersion !== BROAD_DAY_ARCHIVE_ENTRY_VERSION || row.kind !== 'CLOSED_CANDLE'
              || row.shardOrdinal !== nextShardOrdinal || row.knownAtTs !== row.admittedTs
              || typeof row.conflict !== 'boolean' || !HEX64.test(row.globalControlDigest ?? '')
              || !HEX64.test(row.recordDigest ?? '')) fail('READER_SHARD_ROW_INVALID', 'shard identity/clocks malformed', { sessionId, fileName, row: nextShardOrdinal });
          const commonRecord = commonRecordError(row.record, { ...row, catalogContentId: row.record.catalogContentId, recordId: row.record.recordId });
          const catalog = catalogsByContentId.get(row.record.catalogContentId);
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
            const state = coverage.get(expected.identityDigest); state.rows += 1; state.sessions.add(sessionId);
            if (exactDuplicate) { state.duplicateRows += 1; duplicateCandleRows += 1; }
            if (row.knownAtTs > asOfTs || row.record.recordedTs > asOfTs) {
              state.futureWithheldRows += 1; futureWithheldRows += 1;
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
    sessionMetas.push({
      sessionId, controls: { file: controlFile, rows: controls.rows, bytes: controls.bytes, digest: controls.digest },
      shards: shardMetas, empty: false, sourceDigest,
    });
  }

  const finalNames = readdirSync(sessionsRoot).sort();
  if (existsSync(path.join(archiveRoot, 'writer.lock')) || JSON.stringify(finalNames) !== JSON.stringify(initialNames)) fail('READER_ARCHIVE_CHANGED', 'archive ownership/session inventory changed during read');
  epochs.sort((a, b) => a.admittedTs - b.admittedTs || a.sessionId.localeCompare(b.sessionId) || a.globalOrdinal - b.globalOrdinal);
  const siblingCounts = new Map();
  for (const [digest, identity] of identities) if (eligibleIdentities.has(digest)) siblingCounts.set(identity.canonicalCoin, (siblingCounts.get(identity.canonicalCoin) ?? 0) + 1);
  const publicCoverageRows = [...coverage.values()].filter((state) => eligibleIdentities.has(state.marketIdentityDigest)).map((state) => publicCoverage(state, dayStartTs, dayEndTs, siblingCounts.get(state.identity.canonicalCoin))).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest));
  const completeGrids = publicCoverageRows.filter((row) => row.gridState === 'COMPLETE_OBSERVED_GRID').length;
  const conflicts = publicCoverageRows.filter((row) => row.gridState === 'CONFLICT').length;
  const identityChanges = [...siblingCounts.values()].filter((value) => value > 1).length;
  const reasons = [
    'WRITER_V1_HAS_NO_DURABLE_SESSION_FINALIZATION_CONTROL',
    'WRITER_V1_HAS_NO_CATALOG_REFRESH_HEARTBEAT_OR_FULL_DAY_EPOCH_CONTINUITY_PROOF',
    'WRITER_V1_CANONICALIZES_KEY_ORDER_AFTER_AN_ORDER_SENSITIVE_SOURCE_RECORD_ID_WAS_COMPUTED',
  ];
  if (sessionMetas.some((row) => row.empty)) reasons.push('EMPTY_ARCHIVE_SESSION_PRESENT');
  if (staleCatalogControls) reasons.push('STALE_CATALOG_CONTROL_PRESENT');
  if (futureWithheldRows) reasons.push('ROWS_KNOWN_AFTER_DATASET_ASOF_WITHHELD');
  if (futureCatalogControlsWithheld) reasons.push('CATALOG_CONTROLS_KNOWN_AFTER_DATASET_ASOF_WITHHELD');
  if (conflicts) reasons.push('CONFLICTING_CANDLE_MINUTES_PRESENT');
  if (publicCoverageRows.some((row) => row.gridState === 'MISSING' || row.gridState === 'PARTIAL')) reasons.push('CANDLE_GRID_INCOMPLETE');
  if (identityChanges) reasons.push('CANONICAL_COIN_IDENTITY_CHANGED_ACROSS_OBSERVED_CATALOG_EPOCHS');

  const sessionSources = sessionMetas.map((session) => ({
    sessionId: session.sessionId, empty: session.empty, sourceDigest: session.sourceDigest,
    controlRows: session.controls?.rows ?? 0, controlBytes: session.controls?.bytes ?? 0,
    shards: session.shards.map((shard) => ({ fileName: shard.fileName, digest: shard.digest, rows: shard.rows, bytes: shard.bytes })),
  }));
  const descriptorBody = {
    datasetVersion: BROAD_DAY_DATASET_VERSION,
    archiveVersion: BROAD_DAY_ARCHIVE_VERSION,
    dayStartTs, dayEndTs, asOfTs,
    sourceProvenance: {
      sourceKind: 'LOCAL_BROAD_DAY_ARCHIVE_V1',
      sourceRootDigest: sha256(archiveRoot), sessions: sessionSources,
      durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    },
    catalogEpochs: epochs,
    catalogUnion: [...identities.entries()].filter(([marketIdentityDigest]) => eligibleIdentities.has(marketIdentityDigest)).map(([marketIdentityDigest, identity]) => ({ marketIdentityDigest, market: identity })).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest)),
    coverage: publicCoverageRows,
    counters: {
      sessions: sessionMetas.length, emptySessions: sessionMetas.filter((row) => row.empty).length,
      catalogControls: catalogControlCount, futureCatalogControlsWithheld, staleCatalogControls, sourceControls: sourceControlCount,
      candleIndexes: candleIndexCount, candleRows: candleRowCount,
      civilDayRows: relevantRows, asOfEligibleCivilDayRows: asOfEligibleRows,
      futureAdmissionWithheldRows: futureWithheldRows, observedCatalogUnionMarkets: eligibleIdentities.size,
      exactDuplicateCandleRows: duplicateCandleRows,
      completeObservedMinuteGrids: completeGrids, conflictMarkets: conflicts,
      canonicalCoinsWithIdentityChanges: identityChanges, totalPhysicalBytes: totalBytes,
    },
    completeness: {
      physicalControlAndShardIntegrityVerified: true,
      sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite: false,
      observedCatalogEpochUnionConstructed: true,
      catalogEpochContinuityVerified: false,
      sessionFinalizationVerified: false,
      fullPopulationVerified: false,
      fullDaySimulationReady: false,
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
  let closed = false;

  const status = () => freeze({
    version: 'broad-day-reader-v1', state: closed ? 'CLOSED' : 'OPEN',
    datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
    shards: pageShards.length, rows: descriptor.counters.asOfEligibleCivilDayRows,
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    fullDaySimulationReady: false, authority: 'NONE',
  });

  const readPage = async ({ cursor = null, maxRows = limits.maxPageRows, signal: pageSignal = null } = {}) => {
    if (closed) fail('READER_CLOSED', 'reader is closed');
    const pageAbortError = signalError(pageSignal); if (pageAbortError) fail('READER_ARGUMENT_INVALID', pageAbortError);
    throwIfCancelled(signal); throwIfCancelled(pageSignal);
    const cursorErr = cursorError(cursor, descriptor, pageShards.length); if (cursorErr) fail('READER_CURSOR_INVALID', cursorErr);
    if (!positive(maxRows) || maxRows > limits.maxPageRows) fail('READER_PAGE_LIMIT', 'maxRows outside configured bound');
    let shardIndex = cursor?.shardIndex ?? 0; let rowOffset = cursor?.rowOffset ?? 0;
    const priorEmitted = cursor?.emittedRows ?? 0; const rows = []; let rowBytes = 0;
    let stopped = false; let nextShardIndex = pageShards.length; let nextRowOffset = 0;
    while (shardIndex < pageShards.length && !stopped) {
      const meta = pageShards[shardIndex]; let physicalRow = 0;
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
    const done = nextShardIndex >= pageShards.length;
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

  const close = () => { closed = true; return status(); };
  return Object.freeze({ version: 'broad-day-reader-v1', descriptor, readPage, status, close });
}
