// Bounded local custody port for broad Kraken catalog/control evidence and
// conservative closed one-minute candles. This module is intentionally not a
// full-day reader, external backup, learning input, simulation source, Judge,
// Watch, execution, or trading authority.
import path from 'node:path';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import {
  BROAD_KRAKEN_RECORD_VERSION,
  BROAD_KRAKEN_RECORD_VERSION_V2,
  broadKrakenRecordError,
  validateBroadKrakenCatalog,
} from './broad-kraken.js';

export const BROAD_DAY_ARCHIVE_VERSION = 'broad-day-archive-local-v1';
export const BROAD_DAY_ARCHIVE_ENTRY_VERSION = 'broad-day-archive-entry-v1';
export const BROAD_DAY_ARCHIVE_VERSION_V2 = 'broad-day-archive-local-v2';
export const BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 = 'broad-day-archive-entry-v2';
export const BROAD_DAY_ARCHIVE_DURABILITY = 'LOCAL_FILESYSTEM_ONLY';
export const BROAD_DAY_ARCHIVE_DEFAULTS = Object.freeze({
  maxMarkets: 5_000,
  maxCatalogBytes: 8 * 1024 * 1024,
  maxRecordBytes: 64 * 1024,
  maxQueueRows: 4_096,
  maxQueueBytes: 16 * 1024 * 1024,
  maxIdentityRows: 1_000_000,
  maxControlRows: 2_000_000,
  maxCatalogControls: 256,
  maxShardFiles: 10_000,
  maxOpenShards: 64,
  maxShardRows: 2_000_000,
  maxShardBytes: 2 * 1024 * 1024 * 1024,
  maxTotalRows: 4_000_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  fsyncEveryEntries: 256,
  clockSkewMs: 2_000,
});

const LIMIT_CEILINGS = Object.freeze({
  maxMarkets: 5_000,
  maxCatalogBytes: 16 * 1024 * 1024,
  maxRecordBytes: 128 * 1024,
  maxQueueRows: 50_000,
  maxQueueBytes: 256 * 1024 * 1024,
  maxIdentityRows: 2_000_000,
  maxControlRows: 4_000_000,
  maxCatalogControls: 10_000,
  maxShardFiles: 50_000,
  maxOpenShards: 256,
  maxShardRows: 4_000_000,
  maxShardBytes: 8 * 1024 * 1024 * 1024,
  maxTotalRows: 8_000_000,
  maxTotalBytes: 32 * 1024 * 1024 * 1024,
  fsyncEveryEntries: 4_096,
  clockSkewMs: 60_000,
});

const positiveInt = (n) => Number.isSafeInteger(n) && n > 0;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const boundedText = (v, max = 240) => String(v ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const utcDate = (ts) => new Date(ts).toISOString().slice(0, 10);

export class BroadDayArchiveError extends Error {
  constructor(code, message, detail = null) {
    super(`${code}: ${message}`);
    this.code = code;
    this.detail = detail;
  }
}

function limitsOf(overrides) {
  if (overrides !== undefined && !plain(overrides)) throw new BroadDayArchiveError('ARCHIVE_LIMITS_INVALID', 'limits must be an object');
  const unknown = Object.keys(overrides ?? {}).filter((k) => !(k in BROAD_DAY_ARCHIVE_DEFAULTS));
  if (unknown.length) throw new BroadDayArchiveError('ARCHIVE_LIMITS_INVALID', `unknown limits: ${unknown.join(',')}`);
  const out = { ...BROAD_DAY_ARCHIVE_DEFAULTS, ...(overrides ?? {}) };
  for (const [key, ceiling] of Object.entries(LIMIT_CEILINGS)) {
    if (!positiveInt(out[key]) || out[key] > ceiling) throw new BroadDayArchiveError('ARCHIVE_LIMITS_INVALID', `${key} must be 1..${ceiling}`);
  }
  if (out.maxOpenShards > out.maxShardFiles) throw new BroadDayArchiveError('ARCHIVE_LIMITS_INVALID', 'maxOpenShards exceeds maxShardFiles');
  if (out.maxRecordBytes > out.maxQueueBytes || out.maxCatalogBytes > out.maxQueueBytes) throw new BroadDayArchiveError('ARCHIVE_LIMITS_INVALID', 'one admitted input cannot exceed the queue byte bound');
  return Object.freeze(out);
}

// Canonicalization stops while traversing, before building an unbounded joined
// result. String byte lengths and container counts are charged first.
function canonicalBounded(value, maxBytes, { maxDepth = 24, maxEntries = 100_000 } = {}) {
  let bytes = 0; let entries = 0; const parts = []; const stack = new Set();
  const add = (part) => {
    const n = Buffer.byteLength(part, 'utf8');
    if (bytes + n > maxBytes) throw new BroadDayArchiveError('ARCHIVE_INPUT_TOO_LARGE', `canonical input exceeds ${maxBytes} bytes`);
    bytes += n; parts.push(part);
  };
  const walk = (v, depth) => {
    if (depth > maxDepth) throw new BroadDayArchiveError('ARCHIVE_INPUT_INVALID', 'canonical input nesting exceeds bound');
    if (v === null) { add('null'); return; }
    if (typeof v === 'boolean') { add(v ? 'true' : 'false'); return; }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new BroadDayArchiveError('ARCHIVE_INPUT_INVALID', 'non-finite number');
      add(JSON.stringify(v)); return;
    }
    if (typeof v === 'string') {
      if (Buffer.byteLength(v, 'utf8') > maxBytes - bytes) throw new BroadDayArchiveError('ARCHIVE_INPUT_TOO_LARGE', `string exceeds ${maxBytes} byte input bound`);
      add(JSON.stringify(v)); return;
    }
    if (typeof v !== 'object' || v === undefined) throw new BroadDayArchiveError('ARCHIVE_INPUT_INVALID', `unsupported value type ${typeof v}`);
    if (stack.has(v)) throw new BroadDayArchiveError('ARCHIVE_INPUT_INVALID', 'cyclic input');
    stack.add(v);
    if (Array.isArray(v)) {
      if (v.length > maxEntries - entries) throw new BroadDayArchiveError('ARCHIVE_INPUT_TOO_LARGE', 'container entry bound exceeded');
      add('[');
      for (let i = 0; i < v.length; i += 1) {
        entries += 1; if (entries > maxEntries) throw new BroadDayArchiveError('ARCHIVE_INPUT_TOO_LARGE', 'container entry bound exceeded');
        if (i) add(','); walk(v[i], depth + 1);
      }
      add(']');
    } else {
      const keys = Object.keys(v).sort();
      add('{'); let emitted = 0;
      for (const key of keys) {
        if (v[key] === undefined) throw new BroadDayArchiveError('ARCHIVE_INPUT_INVALID', `undefined field ${key}`);
        entries += 1; if (entries > maxEntries) throw new BroadDayArchiveError('ARCHIVE_INPUT_TOO_LARGE', 'container entry bound exceeded');
        if (emitted) add(','); add(JSON.stringify(key)); add(':'); walk(v[key], depth + 1); emitted += 1;
      }
      add('}');
    }
    stack.delete(v);
  };
  walk(value, 0);
  return { text: parts.join(''), bytes };
}

function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const n = writeSync(fd, buffer, offset, buffer.length - offset);
    if (!positiveInt(n)) throw new BroadDayArchiveError('ARCHIVE_LOCK_WRITE_FAILED', 'zero-byte lock write');
    offset += n;
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!positiveInt(result?.bytesWritten)) throw new BroadDayArchiveError('ARCHIVE_WRITE_FAILED', 'zero-byte archive write');
    offset += result.bytesWritten;
  }
}

function validateArchiveRecord(record, catalog, nowTs, limits, requiredRecordVersion = BROAD_KRAKEN_RECORD_VERSION) {
  const baseError = broadKrakenRecordError(record);
  if (baseError) return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: baseError };
  if (record.recordVersion !== requiredRecordVersion) return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: 'record version mismatch' };
  if (!positiveInt(record.sequence)) return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: 'producer sequence malformed' };
  if (typeof record.sessionId !== 'string' || !record.sessionId.length || record.sessionId.length > 128) return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: 'session identity malformed' };
  if (typeof record.epochId !== 'string' || !record.epochId.length || record.epochId.length > 160) return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: 'epoch identity malformed' };
  if (record.catalogContentId !== catalog.contentId) return { ok: false, code: 'ARCHIVE_CATALOG_NOT_CURRENT', reason: 'record does not bind the active catalog control' };
  if (record.recordedTs > nowTs || record.receivedTs > record.recordedTs) return { ok: false, code: 'ARCHIVE_RECORD_CLOCK_INVALID', reason: 'record custody clocks are future or reversed' };
  if (record.sourceEventTs !== null && (!positiveInt(record.sourceEventTs) || record.sourceEventTs > record.receivedTs + limits.clockSkewMs)) return { ok: false, code: 'ARCHIVE_RECORD_CLOCK_INVALID', reason: 'source event clock exceeds receipt clock' };
  const member = catalog.members.get(record.market?.canonicalCoin);
  if (!member || member.pairKey !== record.market?.pairKey || member.nativeBase !== record.market?.nativeBase || member.wsname !== record.market?.catalogWsname) return { ok: false, code: 'ARCHIVE_MARKET_NOT_IN_CATALOG', reason: 'record market identity is absent from active catalog' };
  if (!(record.market.wsSymbol === null || (typeof record.market.wsSymbol === 'string' && record.market.wsSymbol.length > 0 && record.market.wsSymbol.length <= 80))) return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: 'record WebSocket identity malformed' };

  if (record.recordType === 'TICKER' || (record.recordType === 'OHLC' && record.quality === 'PROVISIONAL')) return { ok: false, eligible: false, code: 'ARCHIVE_RECORD_NOT_ELIGIBLE', reason: 'ticker and provisional history are intentionally excluded' };
  if (record.recordType === 'OHLC') {
    const p = record.payload;
    const nums = [p.open, p.high, p.low, p.close];
    const candleKeys = ['close', 'finality', 'high', 'learningEligible', 'low', 'messageType', 'open', 'sourceClockBasis', 'trades', 'volumeBase', 'vwap'];
    if (record.channel !== 'ohlc' || record.quality !== 'CONSERVATIVE_CLOSED' || record.sourceEventTs !== null
      || typeof record.market.wsSymbol !== 'string' || JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(candleKeys)
      || !positiveInt(record.periodStartTs) || !positiveInt(record.periodEndTs) || record.periodEndTs - record.periodStartTs !== 60_000
      || record.periodEndTs > record.receivedTs + limits.clockSkewMs
      || p.messageType !== 'closed' || p.finality !== 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL'
      || p.sourceClockBasis !== 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME' || p.learningEligible !== false
      || !nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
      || p.high < Math.max(p.open, p.close) || p.low > Math.min(p.open, p.close) || p.high < p.low
      || !(p.vwap === null || (typeof p.vwap === 'number' && Number.isFinite(p.vwap) && p.vwap > 0))
      || typeof p.volumeBase !== 'number' || !Number.isFinite(p.volumeBase) || p.volumeBase < 0
      || !Number.isSafeInteger(p.trades) || p.trades < 0) return { ok: false, code: 'ARCHIVE_CLOSED_CANDLE_INVALID', reason: 'closed one-minute OHLC contract malformed' };
    return { ok: true, kind: 'CLOSED_CANDLE', shardTs: record.periodStartTs };
  }
  if (record.recordType === 'INSTRUMENT_MAP' && record.channel === 'instrument') {
    const state = record.payload?.mappingState; const candidates = record.payload?.candidates;
    const pair = record.payload?.pair;
    if (!['MAPPED', 'UNSUPPORTED', 'AMBIGUOUS'].includes(state) || !Array.isArray(candidates) || candidates.length > 8 || candidates.some((x) => typeof x !== 'string' || !x.length || x.length > 80)
      || (state === 'MAPPED' ? record.quality !== 'OBSERVED' || candidates.length !== 1 || !plain(pair) || pair.symbol !== record.market.wsSymbol || pair.base !== record.market.nativeBase || pair.quote !== 'USD' || pair.status !== 'online'
        : record.quality !== 'FAILED' || pair !== null || (state === 'UNSUPPORTED' ? candidates.length !== 0 : candidates.length < 2))) return { ok: false, code: 'ARCHIVE_SOURCE_CONTROL_INVALID', reason: 'instrument mapping control malformed' };
    return { ok: true, kind: 'SOURCE_CONTROL' };
  }
  if (record.recordType === 'SUBSCRIPTION' && ['ticker', 'ohlc'].includes(record.channel)) {
    const state = record.payload?.state;
    if (!['AWAITING_INSTRUMENT', 'PENDING', 'SUBSCRIBED', 'FAILED', 'UNSUPPORTED'].includes(state)
      || (state === 'SUBSCRIBED' ? record.quality !== 'SUBSCRIBED' : state === 'FAILED' ? record.quality !== 'FAILED' : record.quality !== 'PROVISIONAL')) return { ok: false, code: 'ARCHIVE_SOURCE_CONTROL_INVALID', reason: 'subscription control malformed' };
    return { ok: true, kind: 'SOURCE_CONTROL' };
  }
  if (record.recordType === 'GAP' && ['ticker', 'ohlc'].includes(record.channel)) {
    if (record.quality !== 'GAP' || !['GAP', 'STOPPED'].includes(record.payload?.state) || typeof record.payload?.reason !== 'string' || !record.payload.reason.length) return { ok: false, code: 'ARCHIVE_GAP_INVALID', reason: 'gap control state malformed' };
    if (record.payload?.reason === 'NO_NATIVE_INTERVAL' && (!positiveInt(record.payload.sinceTs) || !positiveInt(record.payload.untilTs) || record.payload.sinceTs >= record.payload.untilTs || record.payload.untilTs > record.receivedTs + limits.clockSkewMs)) return { ok: false, code: 'ARCHIVE_GAP_INVALID', reason: 'native interval gap clocks malformed' };
    return { ok: true, kind: 'SOURCE_CONTROL' };
  }
  return { ok: false, code: 'ARCHIVE_RECORD_INVALID', reason: `unsupported archive record type ${boundedText(record.recordType, 40)}` };
}

export function openBroadDayArchive({
  rootDir,
  formatVersion = BROAD_DAY_ARCHIVE_VERSION,
  limits = undefined,
  clock = () => Date.now(),
  onFault = () => {},
  io = { open: openFile },
} = {}) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new BroadDayArchiveError('ARCHIVE_ROOT_INVALID', 'rootDir required');
  if (![BROAD_DAY_ARCHIVE_VERSION, BROAD_DAY_ARCHIVE_VERSION_V2].includes(formatVersion)) throw new BroadDayArchiveError('ARCHIVE_VERSION_INVALID', 'unsupported archive formatVersion');
  if (typeof clock !== 'function' || typeof onFault !== 'function' || !io || typeof io.open !== 'function') throw new BroadDayArchiveError('ARCHIVE_ARGUMENT_INVALID', 'clock, onFault and io.open are required functions');
  const cfg = limitsOf(limits);
  const entryVersion = formatVersion === BROAD_DAY_ARCHIVE_VERSION_V2 ? BROAD_DAY_ARCHIVE_ENTRY_VERSION_V2 : BROAD_DAY_ARCHIVE_ENTRY_VERSION;
  const requiredRecordVersion = formatVersion === BROAD_DAY_ARCHIVE_VERSION_V2 ? BROAD_KRAKEN_RECORD_VERSION_V2 : BROAD_KRAKEN_RECORD_VERSION;
  const startedTs = clock();
  if (!positiveInt(startedTs)) throw new BroadDayArchiveError('ARCHIVE_CLOCK_INVALID', 'opening clock must be positive epoch-ms');

  const requestedRoot = path.resolve(rootDir);
  mkdirSync(requestedRoot, { recursive: true });
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new BroadDayArchiveError('ARCHIVE_ROOT_INVALID', 'archive root must be a real directory, not a symlink');
  const archiveRoot = realpathSync(requestedRoot);
  const lockPath = path.join(archiveRoot, 'writer.lock');
  const token = randomBytes(24).toString('hex');
  const sessionId = `bda-${startedTs}-${process.pid}-${randomBytes(8).toString('hex')}`;
  const lockText = `${JSON.stringify({ version: formatVersion, token, sessionId, pid: process.pid, acquiredTs: startedTs })}\n`;
  const lockBytes = Buffer.byteLength(lockText, 'utf8');
  const ownLockMatches = () => existsSync(lockPath) && statSync(lockPath).size === lockBytes && readFileSync(lockPath, 'utf8') === lockText;
  let lockFd = null;
  try {
    lockFd = openSync(lockPath, 'wx', 0o600);
    writeAllSync(lockFd, Buffer.from(lockText, 'utf8'));
    fsyncSync(lockFd);
    closeSync(lockFd); lockFd = null;
  } catch (error) {
    if (lockFd !== null) try { closeSync(lockFd); } catch { /* preserve first error */ }
    if (error?.code === 'EEXIST') throw new BroadDayArchiveError('ARCHIVE_WRITER_HELD', 'writer.lock exists; no age-based takeover');
    throw new BroadDayArchiveError('ARCHIVE_LOCK_FAILED', boundedText(error?.message ?? error));
  }

  const sessionsDir = path.join(archiveRoot, 'sessions');
  const sessionDir = path.join(sessionsDir, sessionId);
  const shardsDir = path.join(sessionDir, 'shards');
  try {
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(sessionDir);
    mkdirSync(shardsDir);
  } catch (error) {
    try { if (ownLockMatches()) unlinkSync(lockPath); } catch { /* never delete an unverified lock */ }
    throw new BroadDayArchiveError('ARCHIVE_SESSION_FAILED', boundedText(error?.message ?? error));
  }

  const controlFile = path.join(sessionDir, 'controls.jsonl');
  const queue = []; const waiters = [];
  const seenRecordIds = new Map(); const candleKeys = new Map(); const shardStats = new Map(); const openShards = new Map();
  let controlHandle = null; const touched = new Set();
  let activeCatalog = null; let lastControlDigest = null; let nextOrdinal = 1; let lastAdmissionTs = startedTs;
  let admittedOrdinal = 0; let writtenOrdinal = 0; let fsyncedOrdinal = 0;
  let queuedBytes = 0; let writing = false; let scheduled = false; let inFlight = null; let ioFailed = false;
  let closing = false; let closed = false; let closePromise = null; let failure = null; let onFaultCalled = false; let writesSinceSync = 0; let finalizedControl = null;
  const counters = {
    admitted: 0, written: 0, catalogControls: 0, catalogHeartbeats: 0, sourceControls: 0, closedCandles: 0, finalizations: 0,
    idempotent: 0, conflicts: 0, rejected: 0, queueHighWaterRows: 0, queueHighWaterBytes: 0,
    writtenPhysicalRows: 0, writtenBytes: 0,
  };
  let plannedPhysicalRows = 0; let plannedBytes = 0;

  const publicFailure = () => failure ? { code: failure.code, message: failure.message, ts: failure.ts, ordinal: failure.ordinal } : null;
  const latch = (code, message, detail = null, ordinal = null) => {
    if (failure) return failure;
    let faultTs = lastAdmissionTs;
    try { const observed = clock(); if (positiveInt(observed)) faultTs = observed; } catch { /* retain the last valid local clock */ }
    failure = { code: boundedText(code, 64), message: boundedText(message), detail, ts: faultTs, ordinal };
    if (!onFaultCalled) {
      onFaultCalled = true;
      try {
        const returned = onFault(Object.freeze(publicFailure()));
        if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => {});
      } catch { /* a fault callback cannot replace the archive failure */ }
    }
    return failure;
  };
  const rejection = (code, reason, { fatal = true, detail = null } = {}) => {
    counters.rejected += 1;
    if (fatal) latch(code, reason, detail);
    return Object.freeze({ accepted: false, code, reason: boundedText(reason), fatal, failure: publicFailure() });
  };
  const faultError = () => new BroadDayArchiveError(failure.code, failure.message, failure);

  const status = () => Object.freeze({
    version: formatVersion,
    state: closed ? (failure ? 'CLOSED_FAILED' : 'CLOSED') : failure ? 'FAILED' : closing ? 'CLOSING' : writing ? 'WRITING' : 'OPEN',
    startedTs, lastAdmissionTs, sessionId, rootDir: archiveRoot, sessionDir,
    durability: BROAD_DAY_ARCHIVE_DURABILITY, republishSafe: false,
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
    claims: Object.freeze({ fullDay: false, fullPopulation: false, continuity: false, finalized: Boolean(finalizedControl) && fsyncedOrdinal >= finalizedControl.globalOrdinal, externallyDurable: false }),
    ordinals: Object.freeze({ admitted: admittedOrdinal, written: writtenOrdinal, fsynced: fsyncedOrdinal, sealed: finalizedControl?.globalOrdinal ?? null }),
    queue: Object.freeze({ rows: queue.length + (inFlight ? 1 : 0), bytes: queuedBytes, inFlightOrdinal: inFlight?.ordinal ?? null, maxRows: cfg.maxQueueRows, maxBytes: cfg.maxQueueBytes }),
    files: Object.freeze({ controlRows: counters.catalogControls + counters.catalogHeartbeats + counters.sourceControls + counters.closedCandles + counters.finalizations, shards: shardStats.size, openShards: openShards.size, sealedShards: finalizedControl ? shardStats.size : 0, unsealedShards: finalizedControl ? 0 : shardStats.size, maxShardFiles: cfg.maxShardFiles, maxOpenShards: cfg.maxOpenShards }),
    planned: Object.freeze({ physicalRows: plannedPhysicalRows, bytes: plannedBytes, maxRows: cfg.maxTotalRows, maxBytes: cfg.maxTotalBytes }),
    counters: Object.freeze({ ...counters }),
    catalog: activeCatalog ? Object.freeze({ contentId: activeCatalog.contentId, sourceObservedTs: activeCatalog.sourceObservedTs, knownAtTs: activeCatalog.knownAtTs, controlOrdinal: activeCatalog.ordinal, controlDigest: activeCatalog.controlDigest, markets: activeCatalog.members.size }) : null,
    completeness: Object.freeze({ denominatorReconciled: false, recordContinuityVerified: false, marketDataComplete: false, localDayFinalized: Boolean(finalizedControl) && fsyncedOrdinal >= finalizedControl.globalOrdinal, externalDurabilityVerified: false, incomplete: true, failureLatched: Boolean(failure) }),
    failure: publicFailure(),
  });

  const notifyWaiters = () => {
    if (writing || scheduled || (queue.length && !ioFailed)) return;
    const list = waiters.splice(0);
    for (const w of list) ioFailed ? w.reject(faultError()) : w.resolve();
  };

  const syncTouched = async () => {
    for (const handle of [...touched]) {
      try { await handle.sync(); }
      catch (error) { throw new BroadDayArchiveError('ARCHIVE_FSYNC_FAILED', boundedText(error?.message ?? error), { causeCode: boundedText(error?.code ?? 'UNKNOWN', 60) }); }
    }
    touched.clear(); writesSinceSync = 0; fsyncedOrdinal = writtenOrdinal;
  };

  const ensureControlHandle = async () => {
    if (!controlHandle) {
      try { controlHandle = await io.open(controlFile, 'wx', 0o600); }
      catch (error) { throw new BroadDayArchiveError('ARCHIVE_OPEN_FAILED', boundedText(error?.message ?? error), { causeCode: boundedText(error?.code ?? 'UNKNOWN', 60) }); }
    }
    return controlHandle;
  };

  const ensureShardHandle = async (key, file) => {
    if (openShards.has(key)) {
      const h = openShards.get(key); openShards.delete(key); openShards.set(key, h); return h;
    }
    if (openShards.size >= cfg.maxOpenShards) {
      const [oldKey, oldHandle] = openShards.entries().next().value;
      try { await oldHandle.sync(); }
      catch (error) { throw new BroadDayArchiveError('ARCHIVE_FSYNC_FAILED', boundedText(error?.message ?? error), { causeCode: boundedText(error?.code ?? 'UNKNOWN', 60) }); }
      touched.delete(oldHandle); await oldHandle.close(); openShards.delete(oldKey);
    }
    const meta = shardStats.get(key);
    let handle;
    try { handle = await io.open(file, meta.opened ? 'a' : 'wx', 0o600); }
    catch (error) { throw new BroadDayArchiveError('ARCHIVE_OPEN_FAILED', boundedText(error?.message ?? error), { causeCode: boundedText(error?.code ?? 'UNKNOWN', 60) }); }
    meta.opened = true; openShards.set(key, handle); return handle;
  };

  const runWriter = async () => {
    if (writing || ioFailed) return;
    scheduled = false; writing = true;
    try {
      while (queue.length) {
        const item = queue.shift(); inFlight = item;
        const ch = await ensureControlHandle();
        await writeAll(ch, item.controlLine); touched.add(ch);
        if (item.shardLine) {
          const sh = await ensureShardHandle(item.shardKey, item.shardFile);
          await writeAll(sh, item.shardLine); touched.add(sh);
        }
        writtenOrdinal = item.ordinal; counters.written += 1; counters.writtenPhysicalRows += item.physicalRows; counters.writtenBytes += item.physicalBytes;
        writesSinceSync += 1; queuedBytes -= item.physicalBytes; inFlight = null;
        if (writesSinceSync >= cfg.fsyncEveryEntries) await syncTouched();
      }
      if (touched.size) await syncTouched();
    } catch (error) {
      ioFailed = true;
      const stable = error instanceof BroadDayArchiveError && ['ARCHIVE_OPEN_FAILED', 'ARCHIVE_WRITE_FAILED', 'ARCHIVE_FSYNC_FAILED'].includes(error.code) ? error.code : 'ARCHIVE_WRITE_FAILED';
      latch(stable, error?.message ?? error, error?.detail ?? { causeCode: boundedText(error?.code ?? 'UNKNOWN', 60) }, inFlight?.ordinal ?? null);
    } finally {
      if (inFlight) queuedBytes -= inFlight.physicalBytes;
      inFlight = null; writing = false; notifyWaiters();
    }
  };

  const scheduleWriter = () => {
    if (scheduled || writing || ioFailed || !queue.length) return;
    scheduled = true;
    queueMicrotask(() => { runWriter().catch((error) => { ioFailed = true; latch('ARCHIVE_WRITE_FAILED', error?.message ?? error); scheduled = false; notifyWaiters(); }); });
  };

  const reserve = ({ control, shard = null, kind, recordId = null, conflict = false }) => {
    const controlBound = canonicalBounded(control, ['CATALOG_CONTROL', 'CATALOG_HEARTBEAT'].includes(kind) ? cfg.maxCatalogBytes + 8_192 : cfg.maxRecordBytes + 8_192);
    const controlLine = Buffer.from(`${controlBound.text}\n`, 'utf8');
    let shardLine = null;
    if (shard) {
      const shardBound = canonicalBounded(shard.body, cfg.maxRecordBytes + 8_192);
      shardLine = Buffer.from(`${shardBound.text}\n`, 'utf8');
    }
    const physicalRows = shardLine ? 2 : 1;
    const physicalBytes = controlLine.length + (shardLine?.length ?? 0);
    if (queue.length + (inFlight ? 1 : 0) >= cfg.maxQueueRows || queuedBytes + physicalBytes > cfg.maxQueueBytes) return rejection('ARCHIVE_BACKPRESSURE', 'archive admission queue bound reached');
    if (plannedPhysicalRows + physicalRows > cfg.maxTotalRows || plannedBytes + physicalBytes > cfg.maxTotalBytes) return rejection('ARCHIVE_CAP_REACHED', 'archive aggregate row/byte cap reached');
    if (counters.catalogControls + counters.catalogHeartbeats + counters.sourceControls + counters.closedCandles + counters.finalizations + 1 > cfg.maxControlRows) return rejection('ARCHIVE_CAP_REACHED', 'archive control ledger row cap reached');
    if (shard) {
      const meta = shardStats.get(shard.key) ?? { key: shard.key, file: shard.file, rows: 0, bytes: 0, nextOrdinal: 1, opened: false };
      if (!shardStats.has(shard.key) && shardStats.size >= cfg.maxShardFiles) return rejection('ARCHIVE_CAP_REACHED', 'archive shard-file cap reached');
      if (meta.rows + 1 > cfg.maxShardRows || meta.bytes + shardLine.length > cfg.maxShardBytes) return rejection('ARCHIVE_CAP_REACHED', 'archive per-shard row/byte cap reached');
      if (!shardStats.has(shard.key)) shardStats.set(shard.key, meta);
      meta.rows += 1; meta.bytes += shardLine.length; meta.nextOrdinal += 1;
    }
    const item = { ordinal: control.globalOrdinal, kind, controlLine, shardLine, shardKey: shard?.key ?? null, shardFile: shard?.file ?? null, physicalRows, physicalBytes };
    queue.push(item); queuedBytes += physicalBytes; plannedPhysicalRows += physicalRows; plannedBytes += physicalBytes;
    admittedOrdinal = item.ordinal; counters.admitted += 1;
    if (kind === 'CATALOG_CONTROL') counters.catalogControls += 1;
    else if (kind === 'CATALOG_HEARTBEAT') counters.catalogHeartbeats += 1;
    else if (kind === 'CLOSED_CANDLE') counters.closedCandles += 1;
    else if (kind === 'SESSION_FINALIZATION') counters.finalizations += 1;
    else counters.sourceControls += 1;
    if (recordId) seenRecordIds.set(recordId, { digest: control.recordDigest, ordinal: control.globalOrdinal });
    if (conflict) counters.conflicts += 1;
    counters.queueHighWaterRows = Math.max(counters.queueHighWaterRows, queue.length + (inFlight ? 1 : 0));
    counters.queueHighWaterBytes = Math.max(counters.queueHighWaterBytes, queuedBytes);
    lastControlDigest = control.controlDigest;
    nextOrdinal += 1; scheduleWriter();
    return Object.freeze({ accepted: true, code: 'ACCEPTED', ordinal: item.ordinal, controlDigest: control.controlDigest, conflict, durable: false });
  };

  const tryAcceptCatalog = ({ catalog, sourceObservedTs, knownAtTs } = {}) => {
    if (closing || closed) return rejection('ARCHIVE_CLOSED', 'archive is closing or closed', { fatal: false });
    if (finalizedControl) return rejection('ARCHIVE_FINALIZED', 'archive session is already finalized', { fatal: false });
    if (failure) return rejection('ARCHIVE_FAILED', failure.message, { fatal: false });
    let nowTs;
    try { nowTs = clock(); } catch (error) { return rejection('ARCHIVE_CLOCK_INVALID', error?.message ?? 'archive clock failed'); }
    if (!positiveInt(nowTs) || nowTs < lastAdmissionTs || !positiveInt(sourceObservedTs) || !positiveInt(knownAtTs) || sourceObservedTs > knownAtTs || knownAtTs > nowTs) return rejection('ARCHIVE_CATALOG_CLOCK_INVALID', 'catalog source/knowledge/admission clocks are invalid');
    lastAdmissionTs = nowTs;
    let body;
    try { body = canonicalBounded(catalog, cfg.maxCatalogBytes); } catch (error) { return rejection(error.code ?? 'ARCHIVE_CATALOG_INVALID', error.message); }
    const valid = validateBroadKrakenCatalog(catalog, { maxMarkets: cfg.maxMarkets });
    if (!valid.ok || catalog.observedTs !== sourceObservedTs) return rejection('ARCHIVE_CATALOG_INVALID', valid.reason ?? 'catalog observed clock mismatch');
    if (activeCatalog && (sourceObservedTs < activeCatalog.sourceObservedTs || knownAtTs < activeCatalog.knownAtTs)) return rejection('ARCHIVE_CATALOG_CLOCK_REGRESSION', 'catalog source or local knowledge clock regressed');
    if (counters.catalogControls >= cfg.maxCatalogControls) return rejection('ARCHIVE_CAP_REACHED', 'catalog-control cap reached');
    const exactCatalog = JSON.parse(body.text);
    const ordinal = nextOrdinal;
    const isHeartbeat = formatVersion === BROAD_DAY_ARCHIVE_VERSION_V2 && activeCatalog?.contentId === exactCatalog.contentId;
    const kind = isHeartbeat ? 'CATALOG_HEARTBEAT' : 'CATALOG_CONTROL';
    const base = {
      entryVersion, kind, globalOrdinal: ordinal,
      previousControlDigest: lastControlDigest, admittedTs: nowTs, knownAtTs, sourceObservedTs,
      contentId: exactCatalog.contentId, catalogBodyDigest: sha256(body.text), catalog: exactCatalog,
    };
    if (formatVersion === BROAD_DAY_ARCHIVE_VERSION_V2) {
      base.priorCatalogControlDigest = activeCatalog?.controlDigest ?? null;
      base.priorCatalogContentId = activeCatalog?.contentId ?? null;
      base.catalogChange = activeCatalog === null ? 'INITIAL' : isHeartbeat ? 'UNCHANGED' : 'CHANGED';
    }
    const controlDigest = sha256(canonicalBounded(base, cfg.maxCatalogBytes + 4_096).text);
    const control = { ...base, controlDigest };
    let result;
    try { result = reserve({ control, kind }); } catch (error) { return rejection(error.code ?? 'ARCHIVE_CATALOG_INVALID', error.message); }
    if (result.accepted) {
      activeCatalog = {
        contentId: exactCatalog.contentId, sourceObservedTs, knownAtTs, ordinal, controlDigest,
        members: new Map(exactCatalog.markets.map((m) => [m.base, m])),
      };
    }
    return result;
  };

  const tryAcceptRecord = (record) => {
    if (closing || closed) return rejection('ARCHIVE_CLOSED', 'archive is closing or closed', { fatal: false });
    if (finalizedControl) return rejection('ARCHIVE_FINALIZED', 'archive session is already finalized', { fatal: false });
    if (failure) return rejection('ARCHIVE_FAILED', failure.message, { fatal: false });
    if (!activeCatalog) return rejection('ARCHIVE_CATALOG_REQUIRED', 'a catalog control must be admitted before records');
    let nowTs;
    try { nowTs = clock(); } catch (error) { return rejection('ARCHIVE_CLOCK_INVALID', error?.message ?? 'archive clock failed'); }
    if (!positiveInt(nowTs) || nowTs < lastAdmissionTs) return rejection('ARCHIVE_CLOCK_INVALID', 'archive admission clock regressed or is invalid');
    lastAdmissionTs = nowTs;
    let raw;
    try { raw = canonicalBounded(record, cfg.maxRecordBytes); } catch (error) { return rejection(error.code ?? 'ARCHIVE_RECORD_INVALID', error.message); }
    const checked = validateArchiveRecord(record, activeCatalog, nowTs, cfg, requiredRecordVersion);
    if (!checked.ok) return rejection(checked.code, checked.reason, { fatal: checked.eligible !== false });
    if (record.recordVersion !== requiredRecordVersion) return rejection('ARCHIVE_RECORD_VERSION_MISMATCH', 'record version does not match archive format');
    const recordDigest = sha256(raw.text);
    if (seenRecordIds.has(record.recordId)) {
      const prior = seenRecordIds.get(record.recordId);
      if (prior.digest !== recordDigest) return rejection('ARCHIVE_RECORD_IDENTITY_CONFLICT', 'record id was reused with different bytes');
      counters.idempotent += 1;
      return Object.freeze({ accepted: true, code: 'IDEMPOTENT', ordinal: null, recordId: record.recordId, durable: fsyncedOrdinal >= prior.ordinal });
    }
    if (seenRecordIds.size >= cfg.maxIdentityRows) return rejection('ARCHIVE_CAP_REACHED', 'archive record-identity cap reached');
    const ordinal = nextOrdinal; const knownAtTs = nowTs;
    let shard = null; let conflict = false; let candleKey = null;
    if (checked.kind === 'CLOSED_CANDLE') {
      candleKey = `${record.market.canonicalCoin}|${record.market.pairKey}|${record.periodStartTs}`;
      const prior = candleKeys.get(candleKey);
      conflict = Boolean(prior && prior !== recordDigest);
      const day = utcDate(checked.shardTs);
      const identityDigest = sha256(canonicalBounded({ canonicalCoin: record.market.canonicalCoin, pairKey: record.market.pairKey, nativeBase: record.market.nativeBase, catalogWsname: record.market.catalogWsname }, 4_096).text);
      const key = `${identityDigest}:${day}`; const file = path.join(shardsDir, `market-${identityDigest.slice(0, 24)}-${day}.jsonl`);
      const meta = shardStats.get(key); const shardOrdinal = meta?.nextOrdinal ?? 1;
      const indexBase = {
        entryVersion, kind: 'CLOSED_CANDLE_INDEX', globalOrdinal: ordinal,
        previousControlDigest: lastControlDigest, admittedTs: nowTs, knownAtTs,
        recordId: record.recordId, recordDigest, catalogContentId: record.catalogContentId,
        catalogControlDigest: activeCatalog.controlDigest, marketIdentityDigest: identityDigest,
        periodStartTs: record.periodStartTs, periodEndTs: record.periodEndTs, receivedTs: record.receivedTs,
        utcDate: day, shardOrdinal, conflict,
      };
      const controlDigest = sha256(canonicalBounded(indexBase, cfg.maxRecordBytes).text);
      const control = { ...indexBase, controlDigest };
      const shardBody = {
        entryVersion, kind: 'CLOSED_CANDLE', globalOrdinal: ordinal,
        globalControlDigest: controlDigest, shardOrdinal, admittedTs: nowTs, knownAtTs,
        recordDigest, conflict, record: JSON.parse(raw.text),
      };
      shard = { key, file, body: shardBody };
      let result;
      try { result = reserve({ control, shard, kind: 'CLOSED_CANDLE', recordId: record.recordId, conflict }); } catch (error) { return rejection(error.code ?? 'ARCHIVE_RECORD_INVALID', error.message); }
      if (result.accepted) {
        if (!candleKeys.has(candleKey)) candleKeys.set(candleKey, recordDigest);
      }
      return result;
    }

    const base = {
      entryVersion, kind: 'SOURCE_CONTROL', globalOrdinal: ordinal,
      previousControlDigest: lastControlDigest, admittedTs: nowTs, knownAtTs,
      recordId: record.recordId, recordDigest, catalogContentId: record.catalogContentId,
      catalogControlDigest: activeCatalog.controlDigest, record: JSON.parse(raw.text),
    };
    const controlDigest = sha256(canonicalBounded(base, cfg.maxRecordBytes + 4_096).text);
    const control = { ...base, controlDigest };
    let result;
    try { result = reserve({ control, kind: 'SOURCE_CONTROL', recordId: record.recordId }); } catch (error) { return rejection(error.code ?? 'ARCHIVE_RECORD_INVALID', error.message); }
    return result;
  };

  const awaitWriter = () => {
    if (ioFailed) return Promise.reject(faultError());
    if (!writing && !scheduled && queue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  const drain = async () => {
    if (closed) { if (failure) throw faultError(); return status(); }
    scheduleWriter(); await awaitWriter();
    if (failure) throw faultError();
    return status();
  };

  const finalize = ({ cutoffTs } = {}) => {
    if (formatVersion !== BROAD_DAY_ARCHIVE_VERSION_V2) return rejection('ARCHIVE_FINALIZATION_UNSUPPORTED', 'explicit finalization requires archive v2', { fatal: false });
    if (closing || closed) return rejection('ARCHIVE_CLOSED', 'archive is closing or closed', { fatal: false });
    if (failure) return rejection('ARCHIVE_FAILED', failure.message, { fatal: false });
    if (finalizedControl) return cutoffTs === finalizedControl.cutoffTs
      ? Object.freeze({ accepted: true, code: 'IDEMPOTENT', ordinal: finalizedControl.globalOrdinal, controlDigest: finalizedControl.controlDigest, durable: fsyncedOrdinal >= finalizedControl.globalOrdinal })
      : rejection('ARCHIVE_FINALIZATION_CONFLICT', 'session was finalized with a different cutoff', { fatal: false });
    let nowTs;
    try { nowTs = clock(); } catch (error) { return rejection('ARCHIVE_CLOCK_INVALID', error?.message ?? 'archive clock failed'); }
    if (!positiveInt(nowTs) || nowTs < lastAdmissionTs || !positiveInt(cutoffTs)
        || cutoffTs < lastAdmissionTs || cutoffTs > nowTs) return rejection('ARCHIVE_FINALIZATION_CLOCK_INVALID', 'finalization cutoff/admission clocks are invalid');
    lastAdmissionTs = nowTs;
    const ordinal = nextOrdinal;
    const base = {
      entryVersion, kind: 'SESSION_FINALIZATION', globalOrdinal: ordinal,
      previousControlDigest: lastControlDigest, admittedTs: nowTs, knownAtTs: nowTs,
      sessionId, sessionStartedTs: startedTs, cutoffTs,
      lastDataOrdinal: ordinal - 1, lastDataControlDigest: lastControlDigest,
      activeCatalogContentId: activeCatalog?.contentId ?? null,
      activeCatalogControlDigest: activeCatalog?.controlDigest ?? null,
      admittedCounts: {
        catalogControls: counters.catalogControls, catalogHeartbeats: counters.catalogHeartbeats,
        sourceControls: counters.sourceControls, closedCandles: counters.closedCandles,
      },
      shardFiles: shardStats.size, plannedPhysicalRows, plannedBytes,
    };
    const controlDigest = sha256(canonicalBounded(base, cfg.maxRecordBytes + 8_192).text);
    const control = { ...base, controlDigest };
    let result;
    try { result = reserve({ control, kind: 'SESSION_FINALIZATION' }); }
    catch (error) { return rejection(error.code ?? 'ARCHIVE_FINALIZATION_INVALID', error.message); }
    if (result.accepted) finalizedControl = Object.freeze(control);
    return result;
  };

  const releaseOwnLock = () => {
    try {
      if (!existsSync(lockPath)) { latch('ARCHIVE_LOCK_LOST', 'writer.lock disappeared before close'); return false; }
      if (!ownLockMatches()) { latch('ARCHIVE_LOCK_LOST', 'writer.lock token changed; refusing deletion'); return false; }
      unlinkSync(lockPath); return true;
    } catch (error) { latch('ARCHIVE_LOCK_RELEASE_FAILED', error?.message ?? error); return false; }
  };

  const close = async () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try { scheduleWriter(); await awaitWriter(); } catch { /* preserve primary failure and continue owned cleanup */ }
      const handles = [...new Set([controlHandle, ...openShards.values()].filter(Boolean))];
      for (const handle of handles) {
        try { await handle.sync(); } catch (error) { latch('ARCHIVE_FSYNC_FAILED', error?.message ?? error); }
        try { await handle.close(); } catch (error) { latch('ARCHIVE_CLOSE_FAILED', error?.message ?? error); }
      }
      controlHandle = null; openShards.clear(); touched.clear();
      releaseOwnLock(); closed = true; closing = false; notifyWaiters();
      if (failure) throw faultError();
      return status();
    })();
    return closePromise;
  };

  return Object.freeze({
    version: formatVersion,
    tryAcceptCatalog,
    tryAcceptRecord,
    finalize,
    drain,
    status,
    close,
  });
}
