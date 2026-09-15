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

export const CEILINGS = Object.freeze({
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

export const MINUTE = 60_000;
export const HEX64 = /^[a-f0-9]{64}$/;
export const SESSION_RE = /^bda-(\d+)-(\d+)-[a-f0-9]{16}$/;
export const SHARD_RE = /^market-([a-f0-9]{24})-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const CONTROL_COMMON = Object.freeze([
  'entryVersion', 'kind', 'globalOrdinal', 'previousControlDigest', 'admittedTs',
  'knownAtTs', 'controlDigest',
]);
export const CATALOG_CONTROL_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'sourceObservedTs', 'contentId', 'catalogBodyDigest', 'catalog',
]);
export const CATALOG_CONTROL_V2_KEYS = Object.freeze([
  ...CATALOG_CONTROL_KEYS, 'priorCatalogControlDigest', 'priorCatalogContentId', 'catalogChange',
]);
export const SOURCE_CONTROL_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'recordId', 'recordDigest', 'catalogContentId',
  'catalogControlDigest', 'record',
]);
export const CANDLE_INDEX_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'recordId', 'recordDigest', 'catalogContentId',
  'catalogControlDigest', 'marketIdentityDigest', 'periodStartTs', 'periodEndTs',
  'receivedTs', 'utcDate', 'shardOrdinal', 'conflict',
]);
export const SHARD_KEYS = Object.freeze([
  'entryVersion', 'kind', 'globalOrdinal', 'globalControlDigest', 'shardOrdinal',
  'admittedTs', 'knownAtTs', 'recordDigest', 'conflict', 'record',
]);
export const FINALIZATION_KEYS = Object.freeze([
  ...CONTROL_COMMON, 'sessionId', 'sessionStartedTs', 'cutoffTs', 'lastDataOrdinal',
  'lastDataControlDigest', 'activeCatalogContentId', 'activeCatalogControlDigest',
  'admittedCounts', 'shardFiles', 'plannedPhysicalRows', 'plannedBytes',
]);
export const CLOSED_PAYLOAD_KEYS = Object.freeze([
  'close', 'finality', 'high', 'learningEligible', 'low', 'messageType', 'open',
  'sourceClockBasis', 'trades', 'volumeBase', 'vwap',
]);
export const BROAD_RECORD_KEYS = Object.freeze([
  'recordVersion', 'recordId', 'sessionId', 'sequence', 'recordType', 'recordedTs',
  'catalogContentId', 'epochId', 'market', 'channel', 'quality', 'sourceEventTs',
  'receivedTs', 'periodStartTs', 'periodEndTs', 'payload',
]);
export const BROAD_MARKET_KEYS = Object.freeze([
  'canonicalCoin', 'pairKey', 'nativeBase', 'catalogWsname', 'wsSymbol',
]);

export const positive = (value) => Number.isSafeInteger(value) && value > 0;
export const count = (value) => Number.isSafeInteger(value) && value >= 0;
export const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const freeze = (value) => {
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

export const fail = (code, message, detail = null) => { throw new BroadDayReaderError(code, message, detail); };

export function exactKeys(value, keys) {
  if (!plain(value)) return 'not a record';
  for (const key of keys) if (!Object.hasOwn(value, key)) return `missing key ${key}`;
  for (const key of Object.keys(value)) if (!keys.includes(key)) return `undeclared key ${key}`;
  return null;
}

// This matches the writer's canonicalBounded JSON law. The physical line is
// already bounded before this traversal; depth/entry limits prevent hostile
// but small nested values from exhausting the call stack.
export function canonicalBounded(value, maxBytes, { maxDepth = 32, maxEntries = 200_000 } = {}) {
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

export function limitsOf(overrides) {
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

export function realDirectory(target, code) {
  if (!existsSync(target)) fail(code, 'directory does not exist');
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, 'directory must be real and not a symbolic link');
  return realpathSync(target);
}

export function fileInfo(file, maximum) {
  if (!existsSync(file)) fail('READER_FILE_MISSING', 'required archive file is missing', { name: path.basename(file) });
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('READER_FILE_INVALID', 'archive file must be regular and not a symbolic link', { name: path.basename(file) });
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximum) fail('READER_FILE_LIMIT', 'archive file exceeds configured read bound', { name: path.basename(file), bytes: stat.size, maximum });
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

export function signalError(signal) {
  if (signal === undefined || signal === null) return null;
  if ((typeof signal !== 'object' && typeof signal !== 'function')
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') return 'signal must be an AbortSignal';
  return null;
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) fail('READER_CANCELLED', 'archive read cancelled');
}

export async function scanJsonl(file, {
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

export function utcDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
export function marketIdentity(market) {
  return {
    canonicalCoin: market.base, pairKey: market.pairKey,
    nativeBase: market.nativeBase, catalogWsname: market.wsname,
  };
}
export function marketDigest(identity) { return sha256(canonicalBounded(identity, 4_096).text); }
export function archiveMarketDigest(record) {
  return marketDigest({
    canonicalCoin: record.market.canonicalCoin, pairKey: record.market.pairKey,
    nativeBase: record.market.nativeBase, catalogWsname: record.market.catalogWsname,
  });
}
export function digestWithout(value, key, maximum) {
  const body = { ...value }; delete body[key]; return sha256(canonicalBounded(body, maximum).text);
}
export function chainDigest(previous, row) { return sha256(canonicalBounded({ previous, row }, 512 * 1024).text); }

export function commonControlError(row, priorDigest, expectedOrdinal, entryVersion) {
  if (row.entryVersion !== entryVersion || row.globalOrdinal !== expectedOrdinal
      || row.previousControlDigest !== priorDigest || !positive(row.admittedTs) || !positive(row.knownAtTs)
      || row.knownAtTs > row.admittedTs || !HEX64.test(row.controlDigest ?? '')) return 'control identity, chain, or clocks malformed';
  if (digestWithout(row, 'controlDigest', 16 * 1024 * 1024) !== row.controlDigest) return 'control digest mismatch';
  return null;
}

export function catalogControlError(row, limits, entryVersion, lastCatalog = null) {
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

export function commonRecordError(record, entry, entryVersion = BROAD_DAY_ARCHIVE_ENTRY_VERSION) {
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

export function recordMembershipError(record, catalogControl, expectedDigest = null) {
  if (!plain(record.market)) return 'record market missing';
  const member = catalogControl.catalog.markets.find((candidate) => candidate.base === record.market.canonicalCoin);
  if (!member || member.pairKey !== record.market.pairKey || member.nativeBase !== record.market.nativeBase
      || member.wsname !== record.market.catalogWsname) return 'record identity is not a member of referenced catalog';
  if (expectedDigest !== null && marketDigest(marketIdentity(member)) !== expectedDigest) return 'record market digest differs from index';
  return null;
}

export function closedRecordError(record) {
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

export function sourceControlError(record) {
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

export function expectedShardSummary(index) {
  return {
    globalOrdinal: index.globalOrdinal, globalControlDigest: index.controlDigest,
    shardOrdinal: index.shardOrdinal, admittedTs: index.admittedTs, knownAtTs: index.knownAtTs,
    recordId: index.recordId, recordDigest: index.recordDigest, conflict: index.conflict,
    catalogContentId: index.catalogContentId, marketIdentityDigest: index.marketIdentityDigest,
    periodStartTs: index.periodStartTs, periodEndTs: index.periodEndTs, receivedTs: index.receivedTs,
  };
}
export function actualShardSummary(row) {
  return {
    globalOrdinal: row.globalOrdinal, globalControlDigest: row.globalControlDigest,
    shardOrdinal: row.shardOrdinal, admittedTs: row.admittedTs, knownAtTs: row.knownAtTs,
    recordId: row.record.recordId, recordDigest: row.recordDigest, conflict: row.conflict,
    catalogContentId: row.record.catalogContentId, marketIdentityDigest: archiveMarketDigest(row.record),
    periodStartTs: row.record.periodStartTs, periodEndTs: row.record.periodEndTs, receivedTs: row.record.receivedTs,
  };
}

export function coverageState(identity, minutes) {
  return {
    identity, marketIdentityDigest: marketDigest(identity), minuteState: new Uint8Array(minutes), expectedMinuteState: new Uint8Array(minutes),
    rows: 0, eligibleRows: 0, duplicateRows: 0, futureWithheldRows: 0, conflictRows: 0,
    firstPeriodStartTs: null, lastPeriodEndTs: null,
    sessions: new Set(), catalogControls: new Set(), eligibleRecordIds: new Set(), gaps: 0,
  };
}

export function publicCoverage(state, dayStartTs, dayEndTs, siblingCount) {
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

export function cursorError(cursor, descriptor, shardCount) {
  if (cursor === null) return null;
  const keys = exactKeys(cursor, ['cursorVersion', 'datasetDigest', 'shardIndex', 'rowOffset', 'emittedRows', 'cursorDigest']);
  if (keys || cursor.cursorVersion !== BROAD_DAY_CURSOR_VERSION || cursor.datasetDigest !== descriptor.datasetDigest
      || !count(cursor.shardIndex) || cursor.shardIndex > shardCount || !count(cursor.rowOffset)
      || !count(cursor.emittedRows) || (cursor.shardIndex === shardCount && cursor.rowOffset !== 0)
      || !HEX64.test(cursor.cursorDigest ?? '')
      || cursor.cursorDigest !== digestWithout(cursor, 'cursorDigest', 4_096)) return 'cursor identity or position malformed';
  return null;
}

export function marketCursorError(cursor, descriptor, marketIdentityDigest, shardCount) {
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

export function pageRow(entry, sessionId, fileName) {
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

