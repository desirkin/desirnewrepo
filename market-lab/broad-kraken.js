// Data-only broad Kraken eye. This is a shallow, public market-data collector:
// it has no account, order, execution, model, Watch, Tape, or Judge dependency.
//
// The accepted REST AssetPairs catalog remains the population authority. A
// fresh public WebSocket v2 instrument snapshot must independently map every
// accepted member before ticker/OHLC subscription; an unsupported or ambiguous
// member stays in the denominator and is reported, never silently discarded.
// Raw ticker and OHLC events are kept in a bounded rolling local JSONL capture.
// That capture is useful operational evidence, but is explicitly not external
// or republish durability and grants no learning/promotion authority.
import path from 'node:path';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createWsClient } from './transport.js';
import { catalogContentId, KRAKEN_BASE_ALIASES } from '../survey/catalog.js';

export const BROAD_KRAKEN_VERSION = 'broad-kraken-v1';
export const BROAD_KRAKEN_RECORD_VERSION = 'broad-kraken-record-v1';
export const BROAD_KRAKEN_RECORD_VERSION_V2 = 'broad-kraken-record-v2';
export const BROAD_KRAKEN_STATES = Object.freeze([
  'WAITING_CATALOG', 'CONNECTING', 'AWAITING_INSTRUMENT', 'SUBSCRIBING',
  'ACTIVE', 'DEGRADED', 'STOPPING', 'STOPPED', 'RECORDING_FAILED',
]);
export const BROAD_KRAKEN_CHANNEL_STATES = Object.freeze([
  'AWAITING_INSTRUMENT', 'PENDING', 'SUBSCRIBED', 'FAILED', 'GAP',
  'UNSUPPORTED', 'STOPPED',
]);
export const BROAD_KRAKEN_DEFAULTS = Object.freeze({
  maxMarkets: 5_000,
  subscribeChunkSize: 25,
  subscribePaceMs: 250,
  catalogPollMs: 5_000,
  maxCatalogAgeMs: 900_000,
  clockSkewMs: 2_000,
  tickerFreshMs: 120_000,
  candleFreshMs: 180_000,
  segmentBytes: 16 * 1024 * 1024,
  maxSegments: 64,
  lineBytes: 64 * 1024,
  maxQueue: 50_000,
  writeBatchSize: 256,
  fsyncEveryRecords: 256,
  // Native socket ingestion is continuous. Replaceable current-market disk
  // state is coalesced to this bounded cadence to avoid full-catalog fsync
  // amplification on the shared host; the status discloses the resulting lag.
  latestSnapshotMs: 5_000,
  maxLatestBytes: 16 * 1024 * 1024,
});

const SEGMENT_RE = /^events-(\d{6})\.jsonl$/;
const BASE_RE = /^[A-Z0-9][A-Z0-9.]{0,14}$/;
const PAIR_KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;
const WS_SYMBOL_RE = /^([A-Z0-9][A-Z0-9._-]{0,39})\/USD$/;
// Instrument snapshots are venue-wide, not USD-only. This grammar validates
// the native BASE/QUOTE identity without turning non-USD pairs into candidates.
const WS_COMPONENT_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
const WS_PAIR_SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}\/[A-Z0-9][A-Z0-9._-]{0,39}$/;
const positiveInt = (n) => Number.isSafeInteger(n) && n > 0;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const number = (v) => finite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()) && Number.isFinite(Number(v)) ? Number(v) : null;
const integer = (v) => { const n = number(v); return Number.isSafeInteger(n) ? n : null; };
const isoTs = (v) => { if (typeof v !== 'string' || v.length > 40) return null; const n = Date.parse(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boundedText = (v, max = 160) => typeof v === 'string' ? v.slice(0, max) : String(v ?? '').slice(0, max);
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonicalText = (value, { maxBytes = 256 * 1024, maxDepth = 24, maxEntries = 100_000 } = {}) => {
  let bytes = 0; let entries = 0; const parts = []; const stack = new Set();
  const add = (part) => {
    if (typeof part !== 'string' || bytes + Buffer.byteLength(part, 'utf8') > maxBytes) throw new Error('canonical record identity exceeds byte bound');
    bytes += Buffer.byteLength(part, 'utf8'); parts.push(part);
  };
  const walk = (current, depth) => {
    if (depth > maxDepth) throw new Error('canonical record identity exceeds depth bound');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') { add(JSON.stringify(current)); return; }
    if (typeof current === 'number') { if (!Number.isFinite(current)) throw new Error('canonical record identity contains a non-finite number'); add(JSON.stringify(current)); return; }
    if (!plain(current) && !Array.isArray(current)) throw new Error('canonical record identity contains a non-JSON value');
    if (stack.has(current)) throw new Error('canonical record identity is cyclic');
    stack.add(current);
    if (Array.isArray(current)) {
      add('[');
      for (let i = 0; i < current.length; i += 1) { if (++entries > maxEntries) throw new Error('canonical record identity exceeds entry bound'); if (i) add(','); walk(current[i], depth + 1); }
      add(']');
    } else {
      add('{'); let emitted = 0;
      for (const key of Object.keys(current).sort()) {
        if (current[key] === undefined || ++entries > maxEntries) throw new Error('canonical record identity contains undefined or too many entries');
        if (emitted) add(','); add(JSON.stringify(key)); add(':'); walk(current[key], depth + 1); emitted += 1;
      }
      add('}');
    }
    stack.delete(current);
  };
  walk(value, 0); return parts.join('');
};
const canonicalHash = (value) => createHash('sha256').update(canonicalText(value)).digest('hex');
const normalizeAsset = (v) => typeof v === 'string' ? (KRAKEN_BASE_ALIASES[v] ?? v) : null;
const marketIdentity = (m) => ({
  canonicalCoin: m.base,
  pairKey: m.pairKey,
  nativeBase: m.nativeBase,
  catalogWsname: m.wsname,
  wsSymbol: null,
});
// A missing native candle interval is historical coverage evidence, not a
// transport disconnect or revocation of an acknowledged OHLC subscription.
// Keep it visible separately; never synthesize a zero candle to fill the gap.
const isNativeIntervalGap = (r) => r?.recordType === 'GAP' && r.channel === 'ohlc' && r.payload?.reason === 'NO_NATIVE_INTERVAL';

export function validateBroadKrakenCatalog(catalog, { maxMarkets = BROAD_KRAKEN_DEFAULTS.maxMarkets } = {}) {
  if (!plain(catalog)) return { ok: false, reason: 'CATALOG_MISSING' };
  if (catalog.venue !== 'kraken' || catalog.quote !== 'USD') return { ok: false, reason: 'CATALOG_SCOPE_MISMATCH' };
  if (!positiveInt(catalog.observedTs) || typeof catalog.contentId !== 'string') return { ok: false, reason: 'CATALOG_IDENTITY_MALFORMED' };
  if (!Array.isArray(catalog.markets) || catalog.markets.length === 0) return { ok: false, reason: 'CATALOG_EMPTY' };
  if (!positiveInt(maxMarkets) || catalog.markets.length > maxMarkets) return { ok: false, reason: 'CATALOG_OVERFLOW', count: catalog.markets.length };
  const bases = new Set(); const pairKeys = new Set(); const wsNames = new Set();
  for (const m of catalog.markets) {
    if (!plain(m) || !PAIR_KEY_RE.test(String(m.pairKey)) || !BASE_RE.test(String(m.base)) || m.quote !== 'USD' || m.status !== 'online'
      || typeof m.nativeBase !== 'string' || typeof m.nativeQuote !== 'string' || typeof m.wsname !== 'string') return { ok: false, reason: 'CATALOG_MARKET_MALFORMED' };
    if (bases.has(m.base) || pairKeys.has(m.pairKey) || wsNames.has(m.wsname)) return { ok: false, reason: 'CATALOG_IDENTITY_DUPLICATE' };
    bases.add(m.base); pairKeys.add(m.pairKey); wsNames.add(m.wsname);
  }
  let computed;
  try { computed = catalogContentId(catalog); } catch { return { ok: false, reason: 'CATALOG_CONTENT_ID_UNVERIFIABLE' }; }
  if (computed !== catalog.contentId) return { ok: false, reason: 'CATALOG_CONTENT_ID_MISMATCH' };
  return { ok: true, count: catalog.markets.length };
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const n = writeSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(n) || n <= 0) throw Object.assign(new Error('zero-byte broad market write'), { code: 'BROAD_MARKET_WRITE_FAILED' });
    offset += n;
  }
}

// PUBLISH-FIX-3 — the kernel boot id (a UUID that changes on every boot / container start; /proc/sys/kernel/random/boot_id
// on Linux). It is the ONLY reliable cross-restart identity: a low pid like 34 is routinely reused by an unrelated process
// in a republished container, so `process.kill(pid, 0)` returning "alive" does NOT mean the real writer is alive. Recording
// the boot id lets a lock from a PREVIOUS boot be recognized as stale even when its pid was reused.
function currentBootId() {
  try { const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); return id.length ? id : null; }
  catch { return null; }
}

// PUBLISH-FIX-1/3 — dead-pid + prior-boot recovery for the broad-Kraken writer lock, the same law acquireRuntimeLock uses: a
// lock left by a PREVIOUS boot (a republished disk keeps the old app's lock) is a stale artifact and is recovered and logged,
// never "operator verification required". Staleness is decided by the boot id first (a different boot is always stale, even
// if the recorded pid is now a live UNRELATED process — the Replit pid-34 false positive), then by pid liveness for a lock
// from THIS boot. A lock from this boot whose pid IS alive still refuses (real contention); an unreadable/invalid lock still
// refuses for manual review; a pid we cannot verify (EPERM) refuses rather than guess.
function recoverStaleBroadLock(lockFile, clock, log) {
  if (!existsSync(lockFile)) return;
  let payload;
  try { payload = JSON.parse(readFileSync(lockFile, 'utf8')); }
  catch { throw Object.assign(new Error('broad Kraken writer lock is unreadable; manual review required'), { code: 'BROAD_MARKET_LOCKED' }); }
  const pid = payload?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw Object.assign(new Error('broad Kraken writer lock has an invalid pid; manual review required'), { code: 'BROAD_MARKET_LOCKED' });
  const bootNow = currentBootId();
  if (typeof payload?.bootId === 'string' && payload.bootId.length && bootNow && payload.bootId !== bootNow) {
    unlinkSync(lockFile);
    log(`recovered stale broad Kraken writer lock from a previous boot (pid ${pid}; the pid may have been reused by this container)`);
    return;
  }
  try { process.kill(pid, 0); throw Object.assign(new Error(`broad Kraken writer already active as pid ${pid}`), { code: 'BROAD_MARKET_LOCKED' }); }
  catch (error) {
    if (error?.code === 'BROAD_MARKET_LOCKED') throw error;
    if (error?.code !== 'ESRCH') throw Object.assign(new Error(`broad Kraken writer lock owner could not be verified: ${boundedText(error?.message)}`), { code: 'BROAD_MARKET_LOCKED' });
  }
  unlinkSync(lockFile);
  log(`recovered stale broad Kraken writer lock from stopped pid ${pid}`);
}

function openBroadStore({ dataDir, clock, segmentBytes, maxSegments, lineBytes, fsyncEveryRecords, log = () => {} }) {
  if (typeof dataDir !== 'string' || !dataDir.length) throw Object.assign(new Error('broad market dataDir required'), { code: 'BROAD_MARKET_DATA_DIR_REQUIRED' });
  for (const [name, value] of Object.entries({ segmentBytes, maxSegments, lineBytes, fsyncEveryRecords })) if (!positiveInt(value)) throw new Error(`invalid ${name}`);
  const dir = path.join(path.resolve(dataDir), 'broad-kraken');
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'writer.lock');
  const lockToken = randomBytes(16).toString('hex');
  let lockFd = null; let fd = null; let closed = false; let current = null; let bytes = 0; let records = 0; let unflushedRecords = 0;
  let evictedSegments = 0; let evictedBytes = 0; let latestBytes = 0; let latestWrittenTs = null; let latestWrites = 0;
  recoverStaleBroadLock(lockFile, clock, log); // clear a dead owner's lock before we try to take it (a republished disk keeps it)
  try {
    lockFd = openSync(lockFile, 'wx');
    writeAll(lockFd, Buffer.from(`${JSON.stringify({ version: BROAD_KRAKEN_VERSION, pid: process.pid, bootId: currentBootId(), token: lockToken, acquiredTs: clock() })}\n`));
    fsyncSync(lockFd); closeSync(lockFd); lockFd = null;
    // PUBLISH-FIX-4: name the owning process at acquisition so a boot log shows
    // exactly one owner. A "already active as pid N" refusal on another boot then
    // pairs against this line to tell a genuine second starter from a stale lock.
    log(`broad Kraken writer owned by pid ${process.pid} (boot ${currentBootId()})`);
  } catch (error) {
    if (lockFd !== null) try { closeSync(lockFd); } catch { /* preserve first failure */ }
    // EEXIST here means a LIVE owner raced us in after recovery (recoverStaleBroadLock already recovered a dead one).
    const e = Object.assign(new Error(error?.code === 'EEXIST' ? 'broad Kraken writer locked by a live owner' : `cannot acquire broad Kraken writer: ${boundedText(error?.message)}`), { code: error?.code === 'EEXIST' ? 'BROAD_MARKET_LOCKED' : 'BROAD_MARKET_IO' });
    throw e;
  }
  const segments = () => readdirSync(dir).map((name) => {
    const m = name.match(SEGMENT_RE); if (!m) return null;
    const file = path.join(dir, name); return { name, file, index: Number(m[1]), bytes: statSync(file).size };
  }).filter(Boolean).sort((a, b) => a.index - b.index);
  let nextIndex = (segments().at(-1)?.index ?? 0) + 1;
  const releaseLock = () => {
    if (!existsSync(lockFile)) return;
    let payload = null;
    try { payload = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* refuse to unlink an unverified lock */ }
    if (payload?.token !== lockToken) throw Object.assign(new Error('broad Kraken writer lock ownership changed'), { code: 'BROAD_MARKET_LOCK_CHANGED' });
    unlinkSync(lockFile);
  };
  const pruneForNewSegment = () => {
    const all = segments();
    while (all.length >= maxSegments) {
      const victim = all.shift();
      if (!victim || !SEGMENT_RE.test(victim.name) || path.dirname(victim.file) !== dir) throw new Error('unsafe broad market retention target');
      unlinkSync(victim.file);
      evictedSegments += 1; evictedBytes += victim.bytes;
    }
  };
  const openSegment = () => {
    pruneForNewSegment();
    const name = `events-${String(nextIndex).padStart(6, '0')}.jsonl`; nextIndex += 1;
    current = path.join(dir, name); fd = openSync(current, 'wx'); bytes = 0; records = 0; unflushedRecords = 0;
  };
  try { openSegment(); } catch (error) { try { releaseLock(); } catch { /* preserve open failure */ } throw error; }
  return {
    append(record) {
      if (closed || fd === null) throw Object.assign(new Error('broad market writer closed'), { code: 'BROAD_MARKET_WRITER_CLOSED' });
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      if (line.length > lineBytes) throw Object.assign(new Error(`broad market line exceeds ${lineBytes} bytes`), { code: 'BROAD_MARKET_LINE_LIMIT' });
      if (bytes > 0 && bytes + line.length > segmentBytes) {
        fsyncSync(fd); closeSync(fd); fd = null; openSegment();
      }
      writeAll(fd, line); bytes += line.length; records += 1; unflushedRecords += 1;
      if (unflushedRecords >= fsyncEveryRecords) { fsyncSync(fd); unflushedRecords = 0; }
      return { file: current, bytes: line.length };
    },
    flush() { if (!closed && fd !== null && unflushedRecords > 0) { fsyncSync(fd); unflushedRecords = 0; } },
    writeLatest(snapshot, maxBytes) {
      if (closed) throw Object.assign(new Error('broad market writer closed'), { code: 'BROAD_MARKET_WRITER_CLOSED' });
      const bytes_ = Buffer.from(`${JSON.stringify(snapshot)}\n`);
      if (bytes_.length > maxBytes) throw Object.assign(new Error(`broad market latest snapshot exceeds ${maxBytes} bytes`), { code: 'BROAD_MARKET_LATEST_LIMIT' });
      const target = path.join(dir, 'latest.json'); const tmp = path.join(dir, `latest.${process.pid}.${randomBytes(6).toString('hex')}.tmp`); let latestFd = null;
      try {
        latestFd = openSync(tmp, 'wx'); writeAll(latestFd, bytes_); fsyncSync(latestFd); closeSync(latestFd); latestFd = null; renameSync(tmp, target);
      } catch (error) {
        if (latestFd !== null) try { closeSync(latestFd); } catch { /* preserve first error */ }
        try { unlinkSync(tmp); } catch { /* owned temp may already be renamed */ }
        throw error;
      }
      latestBytes = bytes_.length; latestWrittenTs = clock(); latestWrites += 1;
    },
    close() {
      if (closed) return;
      let first = null;
      if (fd !== null) { try { fsyncSync(fd); } catch (e) { first = e; } try { closeSync(fd); } catch (e) { if (!first) first = e; } fd = null; }
      try { releaseLock(); } catch (e) { if (!first) first = e; }
      closed = true; if (first) throw first;
    },
    status() {
      const all = segments();
      return { dir, segment: current ? path.basename(current) : null, segments: all.length, bytes: all.reduce((n, s) => n + s.bytes, 0), records, unflushedRecords, latestBytes, latestWrittenTs, latestWrites, latestSnapshotWrites: latestWrites, evictedSegments, evictedBytes, durability: 'LOCAL_FILESYSTEM_PERIODIC_FSYNC', retention: 'ROLLING_BOUNDED_JOURNAL_PLUS_REPLACEABLE_LATEST' };
    },
  };
}

export function broadKrakenRecordIdOf(record) {
  if (!plain(record) || ![BROAD_KRAKEN_RECORD_VERSION, BROAD_KRAKEN_RECORD_VERSION_V2].includes(record.recordVersion)) throw new Error('record version malformed');
  const copy = { ...record, recordId: null };
  return record.recordVersion === BROAD_KRAKEN_RECORD_VERSION_V2
    ? `bkr2-${canonicalHash(copy)}` : `bkr-${hash(copy)}`;
}

function sealRecord({ sessionId, sequence, clock, body, recordVersion }) {
  const record = {
    recordVersion,
    recordId: null,
    sessionId,
    sequence,
    recordType: body.recordType,
    recordedTs: clock(),
    catalogContentId: body.catalogContentId ?? null,
    epochId: body.epochId ?? null,
    market: body.market ?? null,
    channel: body.channel ?? null,
    quality: body.quality,
    sourceEventTs: body.sourceEventTs ?? null,
    receivedTs: body.receivedTs,
    periodStartTs: body.periodStartTs ?? null,
    periodEndTs: body.periodEndTs ?? null,
    payload: body.payload,
  };
  record.recordId = broadKrakenRecordIdOf(record);
  return Object.freeze(record);
}

export function broadKrakenRecordError(record) {
  if (!plain(record) || ![BROAD_KRAKEN_RECORD_VERSION, BROAD_KRAKEN_RECORD_VERSION_V2].includes(record.recordVersion)
      || typeof record.recordId !== 'string'
      || (record.recordVersion === BROAD_KRAKEN_RECORD_VERSION ? !/^bkr-[a-f0-9]{64}$/.test(record.recordId) : !/^bkr2-[a-f0-9]{64}$/.test(record.recordId))) return 'record envelope malformed';
  if (!positiveInt(record.recordedTs) || !positiveInt(record.receivedTs) || !plain(record.payload)) return 'record clocks/payload malformed';
  if (record.market !== null && (!plain(record.market) || !BASE_RE.test(String(record.market.canonicalCoin)) || !PAIR_KEY_RE.test(String(record.market.pairKey)))) return 'record market malformed';
  try { if (broadKrakenRecordIdOf(record) !== record.recordId) return 'record identity mismatch'; }
  catch { return 'record identity uncomputable'; }
  return null;
}

export function readBroadKrakenLatest({ dataDir, now = Date.now(), includeJournal = false, maxBytes = BROAD_KRAKEN_DEFAULTS.maxLatestBytes, maxLatestBytes = BROAD_KRAKEN_DEFAULTS.maxLatestBytes, tickerFreshMs = BROAD_KRAKEN_DEFAULTS.tickerFreshMs, candleFreshMs = BROAD_KRAKEN_DEFAULTS.candleFreshMs, clockSkewMs = BROAD_KRAKEN_DEFAULTS.clockSkewMs } = {}) {
  if (typeof dataDir !== 'string' || typeof includeJournal !== 'boolean' || !positiveInt(now) || !positiveInt(maxBytes) || !positiveInt(maxLatestBytes) || !positiveInt(tickerFreshMs) || !positiveInt(candleFreshMs) || !positiveInt(clockSkewMs)) throw new Error('invalid broad latest reader arguments');
  const dir = path.join(path.resolve(dataDir), 'broad-kraken');
  if (!existsSync(dir)) return { version: BROAD_KRAKEN_VERSION, asOfTs: now, source: 'LOCAL_FILESYSTEM_NOT_REPUBLISH_DURABLE', historyIncluded: includeJournal, sessionId: null, epochId: null, catalog: null, records: {}, markets: [], bytesRead: 0, truncated: false, malformed: 0 };
  const files = includeJournal ? readdirSync(dir).map((name) => {
    const m = name.match(SEGMENT_RE); if (!m) return null;
    const file = path.join(dir, name); return { file, index: Number(m[1]), bytes: statSync(file).size };
  }).filter(Boolean).sort((a, b) => b.index - a.index) : [];
  let budget = maxBytes; let truncated = false; let malformed = 0; const chosen = [];
  for (const f of files) { if (f.bytes > budget) { truncated = true; break; } chosen.push(f); budget -= f.bytes; }
  const latest = {};
  let snapshotSessionId = null; let snapshotEpochId = null; let snapshotCatalog = null;
  for (const f of chosen.reverse()) {
    const text = readFileSync(f.file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!lines[i]) continue;
      try {
        const r = JSON.parse(lines[i]); if (broadKrakenRecordError(r)) { malformed += 1; continue; }
        const coin = r.market?.canonicalCoin; if (!coin) continue;
        latest[coin] ??= { instrument: null, subscription: {}, ticker: null, candleProvisional: null, candleClosed: null };
        if (r.recordType === 'INSTRUMENT_MAP') latest[coin].instrument = r;
        else if (isNativeIntervalGap(r)) latest[coin].intervalGap = r;
        else if (r.recordType === 'SUBSCRIPTION' || r.recordType === 'GAP') latest[coin].subscription[r.channel] = r;
        else if (r.recordType === 'TICKER') latest[coin].ticker = r;
        else if (r.recordType === 'OHLC' && r.quality === 'PROVISIONAL') latest[coin].candleProvisional = r;
        else if (r.recordType === 'OHLC') latest[coin].candleClosed = r;
      } catch { malformed += 1; }
    }
  }
  const latestFile = path.join(dir, 'latest.json');
  if (existsSync(latestFile)) {
    try {
      const size = statSync(latestFile).size;
      if (size > maxLatestBytes || size > budget) truncated = true;
      else {
        const snap = JSON.parse(readFileSync(latestFile, 'utf8')); budget -= size;
        const validSnapshot = snap?.version === BROAD_KRAKEN_VERSION && plain(snap.records)
          && typeof snap.sessionId === 'string' && snap.sessionId.length > 0 && snap.sessionId.length <= 128
          && typeof snap.currentEpoch === 'string' && snap.currentEpoch.length > 0 && snap.currentEpoch.length <= 160
          && positiveInt(snap.updatedTs) && snap.updatedTs <= now + clockSkewMs
          && plain(snap.catalog) && typeof snap.catalog.contentId === 'string' && positiveInt(snap.catalog.observedTs) && snap.catalog.observedTs <= now + clockSkewMs
          && Number.isSafeInteger(snap.catalog.markets) && snap.catalog.markets > 0
          && snap.catalog.contentId === snap.catalogContentId && Object.keys(snap.records).length === snap.catalog.markets;
        if (!validSnapshot) malformed += 1;
        else {
          snapshotSessionId = snap.sessionId; snapshotEpochId = snap.currentEpoch; snapshotCatalog = clone(snap.catalog);
          for (const [coin, row] of Object.entries(snap.records)) {
          const marketOk = BASE_RE.test(coin) && plain(row) && plain(row.market)
            && row.market.canonicalCoin === coin && PAIR_KEY_RE.test(String(row.market.pairKey))
            && typeof row.market.nativeBase === 'string' && typeof row.market.catalogWsname === 'string'
            && (row.market.wsSymbol === null || WS_SYMBOL_RE.test(String(row.market.wsSymbol)));
          if (!marketOk) { malformed += 1; continue; }
          latest[coin] ??= { instrument: null, subscription: {}, ticker: null, candleProvisional: null, candleClosed: null };
          latest[coin].market = row.market;
          const clocksOk = (r, field) => !broadKrakenRecordError(r)
            && r.recordedTs <= now + clockSkewMs && r.receivedTs <= now + clockSkewMs
            && (r.sourceEventTs === null || (positiveInt(r.sourceEventTs) && r.sourceEventTs <= r.receivedTs + clockSkewMs && r.sourceEventTs <= now + clockSkewMs))
            && (field !== 'candleProvisional' && field !== 'candleClosed' || (positiveInt(r.periodStartTs) && positiveInt(r.periodEndTs) && r.periodEndTs - r.periodStartTs === 60_000 && r.periodStartTs <= r.receivedTs + clockSkewMs && (field === 'candleProvisional' || r.periodEndTs <= r.receivedTs + clockSkewMs)));
          if (plain(row.subscription)) for (const [channel, r] of Object.entries(row.subscription)) {
            const compatible = ['ticker', 'ohlc'].includes(channel) && clocksOk(r, 'subscription')
              && ['SUBSCRIPTION', 'GAP'].includes(r.recordType) && r.channel === channel
              && r.market?.canonicalCoin === coin && r.market?.pairKey === row.market.pairKey
              && r.sessionId === snap.sessionId && r.catalogContentId === snap.catalog.contentId;
            if (!compatible) malformed += 1; else latest[coin].subscription[channel] = r;
          }
          for (const [field, target] of [['instrument', 'instrument'], ['ticker', 'ticker'], ['candleProvisional', 'candleProvisional'], ['candleClosed', 'candleClosed'], ['intervalGap', 'intervalGap']]) {
            const r = row[field]; if (r === null || r === undefined) continue;
            const expected = field === 'instrument' ? r.recordType === 'INSTRUMENT_MAP'
              : field === 'intervalGap' ? isNativeIntervalGap(r) && positiveInt(r.payload.sinceTs) && positiveInt(r.payload.untilTs) && r.payload.sinceTs < r.payload.untilTs && r.payload.untilTs <= r.receivedTs + clockSkewMs
              : field === 'ticker' ? r.recordType === 'TICKER'
                : r.recordType === 'OHLC' && (field === 'candleProvisional' ? r.quality === 'PROVISIONAL' : r.quality !== 'PROVISIONAL');
            const compatible = clocksOk(r, field) && expected
              && r.market?.canonicalCoin === coin && r.market?.pairKey === row.market.pairKey
              && r.sessionId === snap.sessionId && r.catalogContentId === snap.catalog.contentId;
            if (!compatible) malformed += 1; else latest[coin][target] = r;
          }
        }
        }
      }
    } catch { malformed += 1; }
  }
  const markets = Object.entries(latest).sort(([a], [b]) => a.localeCompare(b)).map(([canonicalCoin, row]) => {
    const t = row.ticker; const p = row.candleProvisional; const c = row.candleClosed;
    const age = (r) => r ? Math.max(0, now - r.receivedTs) : null;
    const epochCurrent = (r) => !!r && snapshotSessionId !== null && r.sessionId === snapshotSessionId && r.epochId === snapshotEpochId && r.catalogContentId === snapshotCatalog?.contentId;
    const channelCurrent = (channel) => { const r = row.subscription?.[channel]; return epochCurrent(r) && r.recordType === 'SUBSCRIPTION' && r.payload?.state === 'SUBSCRIBED'; };
    const tickerAge = t ? Math.max(age(t), t.sourceEventTs === null ? Infinity : Math.max(0, now - t.sourceEventTs)) : null;
    const candleAge = (r) => r ? Math.max(age(r), Math.max(0, now - r.periodEndTs)) : null;
    return { canonicalCoin,
      identity: row.market ?? t?.market ?? p?.market ?? c?.market ?? row.instrument?.market ?? null,
      ticker: { record: t, ageMs: tickerAge, state: !t ? 'NEVER_OBSERVED' : !epochCurrent(t) ? 'EPOCH_STALE_PERSISTED' : !channelCurrent('ticker') ? 'RETAINED_ONLY_PERSISTED' : t.quality === 'FAILED' ? 'INVALID' : t.payload.lastPrice === null ? 'OBSERVED_MISSING_PRICE' : t.payload.messageType === 'snapshot' ? 'IDLE_SNAPSHOT_BASELINE_PERSISTED' : t.quality !== 'OBSERVED' ? 'OBSERVED_PARTIAL' : tickerAge <= tickerFreshMs ? 'FRESH_PERSISTED' : 'STALE_PERSISTED' },
      candle: { provisional: p, provisionalAgeMs: candleAge(p), closed: c, closedAgeMs: candleAge(c), state: p ? (!epochCurrent(p) ? 'EPOCH_STALE_PERSISTED' : !channelCurrent('ohlc') ? 'RETAINED_ONLY_PERSISTED' : candleAge(p) <= candleFreshMs && p.periodStartTs <= now && p.periodEndTs >= now ? 'PROVISIONAL_FRESH_PERSISTED' : 'PROVISIONAL_STALE_PERSISTED') : c ? (!epochCurrent(c) ? 'EPOCH_STALE_PERSISTED' : !channelCurrent('ohlc') ? 'RETAINED_ONLY_PERSISTED' : candleAge(c) <= candleFreshMs ? 'CLOSED_FRESH_PERSISTED' : 'CLOSED_STALE_PERSISTED') : 'NEVER_OBSERVED' },
      instrument: row.instrument, subscription: row.subscription, intervalGap: row.intervalGap ?? null,
    };
  });
  return { version: BROAD_KRAKEN_VERSION, asOfTs: now, source: 'LOCAL_FILESYSTEM_NOT_REPUBLISH_DURABLE', historyIncluded: includeJournal, sessionId: snapshotSessionId, epochId: snapshotEpochId, catalog: snapshotCatalog, records: latest, markets, bytesRead: maxBytes - budget, truncated, malformed };
}

export function startBroadKraken({
  catalogSource,
  dataDir,
  WebSocketImpl = globalThis.WebSocket,
  url = null,
  clock = () => Date.now(),
  log = () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  onRecord = () => {},
  recordVersion = BROAD_KRAKEN_RECORD_VERSION,
  limits = {},
} = {}) {
  if (!catalogSource || typeof catalogSource.snapshot !== 'function') throw new Error('broad Kraken catalogSource.snapshot required');
  if (typeof WebSocketImpl !== 'function') throw new Error('broad Kraken WebSocket implementation required');
  if (![BROAD_KRAKEN_RECORD_VERSION, BROAD_KRAKEN_RECORD_VERSION_V2].includes(recordVersion)) throw new Error('broad Kraken recordVersion invalid');
  const cfg = { ...BROAD_KRAKEN_DEFAULTS, ...limits };
  for (const key of Object.keys(BROAD_KRAKEN_DEFAULTS)) if (!positiveInt(cfg[key])) throw new Error(`invalid broad Kraken ${key}`);
  if (cfg.subscribeChunkSize > cfg.maxMarkets || cfg.writeBatchSize > cfg.maxQueue) throw new Error('broad Kraken limits contradict');
  const store = openBroadStore({ dataDir, clock, ...cfg, log });
  const sessionId = `bks-${randomBytes(12).toString('hex')}`;
  let state = 'WAITING_CATALOG'; let startedTs = clock(); let stoppedTs = null; let stopping = false; let sequence = 0; let ws = null; let currentEpoch = null;
  let acceptedCatalog = null; let lastInstrumentTs = null; let instrumentState = 'AWAITING'; let instrumentError = null;
  let catalogLastCheckedTs = null; let catalogLastError = null; let subscribeTimer = null; let catalogTimer = null; let drainTimer = null; let latestTimer = null; let draining = false; let stopPromise = null;
  const instrumentPairs = new Map(); const markets = new Map(); const byWsSymbol = new Map(); const requestMap = new Map(); const subscriptionQueue = []; const writeQueue = [];
  const dirtyLatest = new Map(); let latestDirty = false;
  const counters = { nativeMessages: 0, nativeRows: 0, records: 0, tickerRecords: 0, ohlcRecords: 0, instrumentRecords: 0, latestSnapshotWrites: 0, snapshotRecordsPersisted: 0, coalescedSnapshotRecords: 0, rejectedRows: 0, gaps: 0, subscriptionRequests: 0, recordingFailures: 0, queueHighWater: 0 };
  let recordingError = null; let requestId = 1;

  const schedule = (fn, ms) => timers.setTimeout(fn, ms);
  const marketForRecord = (m) => ({ canonicalCoin: m.canonicalCoin, pairKey: m.pairKey, nativeBase: m.nativeBase, catalogWsname: m.catalogWsname, wsSymbol: m.wsSymbol });
  const applyLatest = (r) => {
    const m = r.market ? markets.get(r.market.canonicalCoin) : null; if (!m) return;
    if (r.recordType === 'INSTRUMENT_MAP') m.latestInstrument = r;
    if (isNativeIntervalGap(r)) m.latestIntervalGap = r;
    else if (r.recordType === 'SUBSCRIPTION' || r.recordType === 'GAP') m.latestSubscription[r.channel] = r;
    if (r.recordType === 'TICKER') m.latestTicker = r;
    if (r.recordType === 'OHLC' && r.quality === 'PROVISIONAL') m.latestProvisional = r;
    if (r.recordType === 'OHLC' && r.quality !== 'PROVISIONAL') m.latestClosed = r;
  };
  const failRecording = (error) => {
    if (recordingError) return;
    recordingError = { code: boundedText(error?.code || 'BROAD_MARKET_RECORDING_FAILED', 60), message: boundedText(error?.message ?? error), ts: clock() };
    counters.recordingFailures += 1; state = 'RECORDING_FAILED'; stopping = true;
    if (subscribeTimer !== null) timers.clearTimeout(subscribeTimer); subscribeTimer = null;
    if (catalogTimer !== null) timers.clearInterval(catalogTimer); catalogTimer = null;
    if (latestTimer !== null) timers.clearTimeout(latestTimer); latestTimer = null;
    void ws?.stop?.().catch(() => {});
  };
  const drainWrites = () => {
    if (draining || recordingError) return;
    draining = true; drainTimer = null;
    try {
      let n = 0;
      while (writeQueue.length && n < cfg.writeBatchSize) {
        const r = writeQueue.shift(); store.append(r); counters.records += 1;
        if (r.recordType === 'TICKER') counters.tickerRecords += 1;
        else if (r.recordType === 'OHLC') counters.ohlcRecords += 1;
        else if (r.recordType === 'INSTRUMENT_MAP') counters.instrumentRecords += 1;
        applyLatest(r); latestDirty = true; if (latestTimer === null) latestTimer = schedule(persistLatestSnapshot, cfg.latestSnapshotMs); try { onRecord(r); } catch (error) { log(`broad Kraken onRecord contained: ${boundedText(error?.message)}`); }
        n += 1;
      }
    } catch (error) { failRecording(error); }
    finally { draining = false; }
    if (writeQueue.length && !recordingError) drainTimer = schedule(drainWrites, 0);
  };
  const enqueue = (body, { duringStop = false } = {}) => {
    if (recordingError || (stopping && !duringStop)) return false;
    if (writeQueue.length >= cfg.maxQueue) { failRecording(Object.assign(new Error(`broad market write queue exceeded ${cfg.maxQueue}`), { code: 'BROAD_MARKET_BACKPRESSURE' })); return false; }
    const r = sealRecord({ sessionId, sequence: ++sequence, clock, body, recordVersion });
    const e = broadKrakenRecordError(r); if (e) { failRecording(Object.assign(new Error(e), { code: 'BROAD_MARKET_RECORD_INVALID' })); return false; }
    writeQueue.push(r); counters.queueHighWater = Math.max(counters.queueHighWater, writeQueue.length);
    if (!draining && drainTimer === null) drainTimer = schedule(drainWrites, 0);
    return true;
  };
  const persistLatestSnapshot = () => {
    latestTimer = null;
    if (recordingError || !latestDirty) return;
    const records = {};
    for (const m of markets.values()) records[m.canonicalCoin] = { market: marketForRecord(m), instrument: m.latestInstrument ?? null, subscription: { ...m.latestSubscription }, intervalGap: m.latestIntervalGap ?? null, ticker: m.currentTicker ?? m.latestTicker ?? null, candleProvisional: m.currentProvisional ?? m.latestProvisional ?? null, candleClosed: m.latestClosed ?? null };
    try {
      store.writeLatest({ version: BROAD_KRAKEN_VERSION, sessionId, currentEpoch, updatedTs: clock(), catalogContentId: acceptedCatalog?.contentId ?? null, catalog: acceptedCatalog ? { contentId: acceptedCatalog.contentId, observedTs: acceptedCatalog.observedTs, markets: acceptedCatalog.markets.length } : null, records }, cfg.maxLatestBytes);
      counters.latestSnapshotWrites += 1;
      for (const r of dirtyLatest.values()) {
        applyLatest(r); counters.records += 1; counters.snapshotRecordsPersisted += 1;
        if (r.recordType === 'TICKER') counters.tickerRecords += 1; else counters.ohlcRecords += 1;
        try { onRecord(r); } catch (error) { log(`broad Kraken onRecord contained: ${boundedText(error?.message)}`); }
      }
      dirtyLatest.clear(); latestDirty = false;
    } catch (error) { failRecording(error); }
  };
  const stageLatest = (m, field, body) => {
    if (recordingError || stopping) return false;
    const record = sealRecord({ sessionId, sequence: ++sequence, clock, body, recordVersion });
    const e = broadKrakenRecordError(record); if (e) { failRecording(Object.assign(new Error(e), { code: 'BROAD_MARKET_RECORD_INVALID' })); return false; }
    const key = `${m.canonicalCoin}:${field}`; if (dirtyLatest.has(key)) counters.coalescedSnapshotRecords += 1;
    dirtyLatest.set(key, record); latestDirty = true;
    if (field === 'ticker') m.currentTicker = record; else m.currentProvisional = record;
    if (latestTimer === null) latestTimer = schedule(persistLatestSnapshot, cfg.latestSnapshotMs);
    return true;
  };
  const markLatestDirty = () => {
    if (recordingError) return;
    latestDirty = true;
    if (!stopping && latestTimer === null) latestTimer = schedule(persistLatestSnapshot, cfg.latestSnapshotMs);
  };

  const coverageRecord = (m, channel, quality, receivedTs, payload = {}, duringStop = false) => enqueue({ recordType: quality === 'GAP' ? 'GAP' : 'SUBSCRIPTION', catalogContentId: acceptedCatalog?.contentId, epochId: currentEpoch, market: marketForRecord(m), channel, quality, receivedTs, payload }, { duringStop });
  const setChannel = (m, channel, value, ts, error = null) => { m.channels[channel] = value; m.lastError = error; coverageRecord(m, channel, value === 'SUBSCRIBED' ? 'SUBSCRIBED' : value === 'GAP' ? 'GAP' : value === 'FAILED' ? 'FAILED' : 'PROVISIONAL', ts, { state: value, error }); };

  const resolveInstrument = (m) => {
    const candidates = [];
    for (const p of instrumentPairs.values()) {
      const sm = typeof p.symbol === 'string' ? p.symbol.match(WS_SYMBOL_RE) : null;
      if (!sm || p.quote !== 'USD' || p.status !== 'online') continue;
      if (normalizeAsset(p.base) === m.canonicalCoin && normalizeAsset(sm[1]) === m.canonicalCoin) candidates.push(p);
    }
    if (candidates.length === 1) return { state: 'MAPPED', pair: candidates[0] };
    return { state: candidates.length ? 'AMBIGUOUS' : 'UNSUPPORTED', candidates: candidates.slice(0, 8).map((p) => p.symbol) };
  };
  const queueSubscriptions = (entries) => {
    const symbols = entries.map((m) => m.wsSymbol);
    for (let i = 0; i < symbols.length; i += cfg.subscribeChunkSize) {
      const chunk = symbols.slice(i, i + cfg.subscribeChunkSize);
      subscriptionQueue.push({ channel: 'ticker', symbols: chunk });
      subscriptionQueue.push({ channel: 'ohlc', symbols: chunk });
    }
    if (subscriptionQueue.length && subscribeTimer === null) subscribeTimer = schedule(pumpSubscriptions, 0);
  };
  const updateState = () => {
    if (recordingError || stopping || !acceptedCatalog) return;
    if (catalogLastError) { state = 'DEGRADED'; return; }
    const rows = [...markets.values()];
    if (instrumentState !== 'MAPPED') { state = instrumentState === 'FAILED' ? 'DEGRADED' : 'AWAITING_INSTRUMENT'; return; }
    const classified = rows.every((m) => ['MAPPED', 'UNSUPPORTED', 'AMBIGUOUS'].includes(m.mappingState));
    const allMappedAcked = rows.filter((m) => m.mappingState === 'MAPPED').every((m) => m.channels.ticker === 'SUBSCRIBED' && m.channels.ohlc === 'SUBSCRIBED');
    const anyRefused = rows.some((m) => m.mappingState !== 'MAPPED' || ['FAILED', 'GAP'].includes(m.channels.ticker) || ['FAILED', 'GAP'].includes(m.channels.ohlc));
    state = classified && allMappedAcked && subscriptionQueue.length === 0 && !anyRefused ? 'ACTIVE' : anyRefused ? 'DEGRADED' : 'SUBSCRIBING';
  };
  function pumpSubscriptions() {
    subscribeTimer = null;
    if (stopping || recordingError || !ws) return;
    const item = subscriptionQueue.shift(); if (!item) { updateState(); return; }
    const id = requestId++;
    const params = item.channel === 'ticker'
      ? { channel: 'ticker', symbol: item.symbols, event_trigger: 'trades', snapshot: true }
      : { channel: 'ohlc', symbol: item.symbols, interval: 1, snapshot: true };
    requestMap.set(id, { ...item, remaining: new Set(item.symbols) }); counters.subscriptionRequests += 1;
    const sent = ws.send({ method: 'subscribe', params, req_id: id });
    if (!sent) { requestMap.delete(id); for (const symbol of item.symbols) { const m = byWsSymbol.get(symbol); if (m) setChannel(m, item.channel, 'GAP', clock(), 'SOCKET_NOT_OPEN'); } }
    if (subscriptionQueue.length) subscribeTimer = schedule(pumpSubscriptions, cfg.subscribePaceMs);
    else updateState();
  }

  const reconcileMappings = (receivedTs) => {
    byWsSymbol.clear(); const newlyMapped = [];
    let mapped = 0; let unsupported = 0; let ambiguous = 0;
    for (const m of markets.values()) {
      const r = resolveInstrument(m); m.mappingState = r.state;
      if (r.state === 'MAPPED') {
        m.wsSymbol = r.pair.symbol; byWsSymbol.set(m.wsSymbol, m); mapped += 1;
        if (!['SUBSCRIBED', 'PENDING'].includes(m.channels.ticker)) { m.channels.ticker = 'PENDING'; m.channels.ohlc = 'PENDING'; newlyMapped.push(m); }
      } else {
        m.wsSymbol = null; m.channels.ticker = 'UNSUPPORTED'; m.channels.ohlc = 'UNSUPPORTED';
        if (r.state === 'AMBIGUOUS') ambiguous += 1; else unsupported += 1;
      }
      enqueue({ recordType: 'INSTRUMENT_MAP', catalogContentId: acceptedCatalog?.contentId, epochId: currentEpoch, market: marketForRecord(m), channel: 'instrument', quality: r.state === 'MAPPED' ? 'OBSERVED' : 'FAILED', receivedTs, payload: { mappingState: r.state, candidates: r.candidates ?? [r.pair.symbol], pair: r.pair ? { symbol: r.pair.symbol, base: r.pair.base, quote: r.pair.quote, status: r.pair.status } : null } });
    }
    instrumentState = 'MAPPED'; instrumentError = null;
    if (unsupported || ambiguous) state = 'DEGRADED'; else state = newlyMapped.length ? 'SUBSCRIBING' : 'SUBSCRIBING';
    queueSubscriptions(newlyMapped);
    updateState();
    return { mapped, unsupported, ambiguous };
  };

  const adoptCatalog = () => {
    catalogLastCheckedTs = clock(); let snap;
    const reject = (error) => { catalogLastError = error; if (acceptedCatalog && !recordingError && !stopping) state = 'DEGRADED'; };
    try { snap = catalogSource.snapshot(); } catch (error) { reject({ reason: 'CATALOG_SOURCE_FAILED', detail: boundedText(error?.message), ts: catalogLastCheckedTs }); return; }
    const catalog = plain(snap) && plain(snap.catalog) ? snap.catalog : snap;
    const checked = validateBroadKrakenCatalog(catalog, cfg);
    if (!checked.ok) { reject({ ...checked, ts: catalogLastCheckedTs }); return; }
    if (plain(snap) && snap.fresh === false) { reject({ reason: 'CATALOG_SOURCE_STALE', ts: catalogLastCheckedTs }); return; }
    if (catalog.observedTs > catalogLastCheckedTs + cfg.clockSkewMs) { reject({ reason: 'CATALOG_CLOCK_AHEAD', ts: catalogLastCheckedTs }); return; }
    if (catalogLastCheckedTs - catalog.observedTs > cfg.maxCatalogAgeMs) { reject({ reason: 'CATALOG_TOO_OLD', ageMs: catalogLastCheckedTs - catalog.observedTs, ts: catalogLastCheckedTs }); return; }
    if (acceptedCatalog && catalog.observedTs < acceptedCatalog.observedTs) { reject({ reason: 'CATALOG_CLOCK_REGRESSION', ts: catalogLastCheckedTs }); return; }
    if (acceptedCatalog?.contentId === catalog.contentId) { acceptedCatalog = clone(catalog); catalogLastError = null; markLatestDirty(); updateState(); return; }
    acceptedCatalog = clone(catalog); catalogLastError = null;
    const previous = new Map(markets); markets.clear();
    for (const row of acceptedCatalog.markets) {
      const prior = previous.get(row.base);
      markets.set(row.base, prior && prior.pairKey === row.pairKey ? prior : {
        ...marketIdentity(row), mappingState: 'AWAITING_INSTRUMENT', channels: { ticker: 'AWAITING_INSTRUMENT', ohlc: 'AWAITING_INSTRUMENT' },
        currentTicker: null, currentProvisional: null, latestInstrument: null, latestSubscription: {}, latestTicker: null, latestProvisional: null, latestClosed: null, pendingCandle: null, lastError: null,
      });
    }
    if (instrumentPairs.size) reconcileMappings(catalogLastCheckedTs);
    if (!ws) startSocket();
  };

  const nativeTicker = (row, receivedTs, epochId) => {
    const symbol = typeof row.symbol === 'string' ? row.symbol : null; const m = symbol ? byWsSymbol.get(symbol) : null;
    if (!m) { counters.rejectedRows += 1; return; }
    const tickerTimestampTs = isoTs(row.timestamp);
    // A ticker snapshot is a baseline of the rolling window. Kraken only
    // documents trade-trigger semantics for updates, so snapshot.timestamp is
    // retained as payload but is not promoted to a last-trade event clock.
    const sourceEventTs = row.__messageType === 'update' ? tickerTimestampTs : null;
    const payload = {
      lastPrice: number(row.last), bid: number(row.bid), ask: number(row.ask), bidQty: number(row.bid_qty), askQty: number(row.ask_qty),
      change24h: number(row.change), changePct24h: number(row.change_pct), high24h: number(row.high), low24h: number(row.low),
      volume24hBase: number(row.volume), vwap24h: number(row.vwap), tickerTimestampTs,
    };
    const missingFields = Object.entries(payload).filter(([, v]) => v === null).map(([k]) => k);
    const invalidFields = [];
    if (payload.lastPrice !== null && payload.lastPrice <= 0) invalidFields.push('lastPrice');
    if (payload.volume24hBase !== null && payload.volume24hBase < 0) invalidFields.push('volume24hBase');
    if (payload.vwap24h !== null && payload.vwap24h <= 0) invalidFields.push('vwap24h');
    if (tickerTimestampTs !== null && tickerTimestampTs > receivedTs + cfg.clockSkewMs) invalidFields.push('tickerTimestampTs');
    const full = payload.lastPrice !== null && payload.lastPrice > 0 && payload.volume24hBase !== null && payload.volume24hBase >= 0;
    stageLatest(m, 'ticker', { recordType: 'TICKER', catalogContentId: acceptedCatalog.contentId, epochId, market: marketForRecord(m), channel: 'ticker', quality: invalidFields.length ? 'FAILED' : full ? 'OBSERVED' : payload.lastPrice === null ? 'MISSING' : 'PARTIAL', sourceEventTs, receivedTs, payload: { messageType: row.__messageType, ...payload, missingFields, invalidFields } });
  };
  const nativeOhlc = (row, receivedTs, epochId) => {
    const symbol = typeof row.symbol === 'string' ? row.symbol : null; const m = symbol ? byWsSymbol.get(symbol) : null;
    const startTs = isoTs(row.interval_begin ?? row.timestamp); const interval = integer(row.interval);
    if (!m || startTs === null || interval !== 1 || startTs > receivedTs + cfg.clockSkewMs) { counters.rejectedRows += 1; return; }
    const periodEndTs = startTs + 60_000;
    const payload = { open: number(row.open), high: number(row.high), low: number(row.low), close: number(row.close), vwap: number(row.vwap), trades: integer(row.trades), volumeBase: number(row.volume) };
    if (![payload.open, payload.high, payload.low, payload.close].every((n) => n !== null && n > 0) || payload.high < Math.max(payload.open, payload.close) || payload.low > Math.min(payload.open, payload.close) || payload.high < payload.low || (payload.vwap !== null && payload.vwap <= 0) || payload.volumeBase === null || payload.volumeBase < 0 || payload.trades === null || payload.trades < 0) { counters.rejectedRows += 1; return; }
    const prior = m.pendingCandle;
    if (prior && startTs < prior.periodStartTs) { counters.rejectedRows += 1; m.lastError = 'OHLC_CLOCK_REGRESSION'; return; }
    if (prior && startTs > prior.periodStartTs) {
      enqueue({ recordType: 'OHLC', catalogContentId: acceptedCatalog.contentId, epochId, market: marketForRecord(m), channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, receivedTs, periodStartTs: prior.periodStartTs, periodEndTs: prior.periodEndTs, payload: { messageType: 'closed', finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME', learningEligible: false, ...prior.payload } });
      if (startTs > prior.periodEndTs) { counters.gaps += 1; coverageRecord(m, 'ohlc', 'GAP', receivedTs, { state: 'GAP', reason: 'NO_NATIVE_INTERVAL', sinceTs: prior.periodEndTs, untilTs: startTs }); }
    }
    m.pendingCandle = { periodStartTs: startTs, periodEndTs, payload };
    stageLatest(m, 'candle', { recordType: 'OHLC', catalogContentId: acceptedCatalog.contentId, epochId, market: marketForRecord(m), channel: 'ohlc', quality: 'PROVISIONAL', receivedTs, periodStartTs: startTs, periodEndTs, payload: { messageType: row.__messageType, finality: 'PROVISIONAL', learningEligible: false, ...payload } });
  };

  function onMessage(msg, meta) {
    counters.nativeMessages += 1;
    if (msg?.method === 'subscribe') {
      const result = plain(msg.result) ? msg.result : {}; const channel = result.channel; const symbol = result.symbol; const request = requestMap.get(integer(msg.req_id));
      if (!request || request.channel !== channel) { counters.rejectedRows += 1; return; }
      if (channel === 'instrument') {
        if (msg.success === false) { instrumentState = 'FAILED'; instrumentError = boundedText(msg.error ?? 'instrument subscription failed'); state = 'DEGRADED'; }
        else if (instrumentState !== 'MAPPED') instrumentState = 'SUBSCRIBED';
        requestMap.delete(integer(msg.req_id)); updateState();
        return;
      }
      if (!['ticker', 'ohlc'].includes(channel) || typeof symbol !== 'string' || !request.remaining.has(symbol)) { counters.rejectedRows += 1; return; }
      const affected = [symbol]; request.remaining.delete(symbol); if (request.remaining.size === 0) requestMap.delete(integer(msg.req_id));
      for (const s of affected) { const m = byWsSymbol.get(s); if (m) setChannel(m, channel, msg.success === true ? 'SUBSCRIBED' : 'FAILED', meta.receivedTs, msg.success === false ? boundedText(msg.error ?? 'subscription failed') : null); }
      updateState();
      return;
    }
    if (msg?.channel === 'instrument' && plain(msg.data)) {
      const hasPairs = Array.isArray(msg.data.pairs); const pairs = hasPairs ? msg.data.pairs : [];
      // Kraken may send an asset-only incremental instrument update. It does
      // not alter pair reconciliation and is not evidence that the feed failed.
      if (msg.type !== 'snapshot' && !hasPairs && Array.isArray(msg.data.assets)) { lastInstrumentTs = meta.receivedTs; return; }
      // The instrument snapshot contains every quote currency. Validate the
      // complete native row set, then resolve only exact USD members below.
      const valid = (msg.type !== 'snapshot' || pairs.length > 0) && hasPairs
        && pairs.every((raw) => {
          if (!plain(raw) || typeof raw.symbol !== 'string' || !WS_PAIR_SYMBOL_RE.test(raw.symbol)
            || typeof raw.base !== 'string' || !WS_COMPONENT_RE.test(raw.base)
            || typeof raw.quote !== 'string' || !WS_COMPONENT_RE.test(raw.quote)
            || typeof raw.status !== 'string' || raw.status.length === 0 || raw.status.length > 40) return false;
          const [base, quote] = raw.symbol.split('/'); return base === raw.base && quote === raw.quote;
        }) && new Set(pairs.map((p) => p.symbol)).size === pairs.length;
      if (!valid) { counters.rejectedRows += Math.max(1, pairs.length); instrumentState = 'FAILED'; instrumentError = 'INSTRUMENT_PAYLOAD_MALFORMED_OR_EMPTY'; state = 'DEGRADED'; return; }
      if (pairs.length === 0) { lastInstrumentTs = meta.receivedTs; return; }
      if (msg.type === 'snapshot') instrumentPairs.clear();
      for (const raw of pairs) instrumentPairs.set(raw.symbol, { symbol: raw.symbol, base: raw.base, quote: raw.quote, status: raw.status });
      lastInstrumentTs = meta.receivedTs; reconcileMappings(meta.receivedTs); return;
    }
    if (msg?.channel === 'ticker' && Array.isArray(msg.data)) {
      for (const row of msg.data) { counters.nativeRows += 1; if (plain(row)) nativeTicker({ ...row, __messageType: msg.type === 'snapshot' ? 'snapshot' : 'update' }, meta.receivedTs, meta.epochId); else counters.rejectedRows += 1; }
      return;
    }
    if (msg?.channel === 'ohlc' && Array.isArray(msg.data)) {
      for (const row of msg.data) { counters.nativeRows += 1; if (plain(row)) nativeOhlc({ ...row, __messageType: msg.type === 'snapshot' ? 'snapshot-provisional' : 'update-provisional' }, meta.receivedTs, meta.epochId); else counters.rejectedRows += 1; }
    }
  }

  function startSocket() {
    state = 'CONNECTING';
    ws = createWsClient({
      providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', WebSocketImpl, clock, log, url,
      onMessage,
      onOpen: ({ epochId, send }) => {
        currentEpoch = epochId; state = 'AWAITING_INSTRUMENT'; instrumentState = 'PENDING'; instrumentError = null; instrumentPairs.clear(); byWsSymbol.clear(); subscriptionQueue.length = 0; requestMap.clear();
        for (const m of markets.values()) { m.mappingState = 'AWAITING_INSTRUMENT'; m.wsSymbol = null; m.channels.ticker = 'AWAITING_INSTRUMENT'; m.channels.ohlc = 'AWAITING_INSTRUMENT'; m.pendingCandle = null; }
        markLatestDirty();
        const id = requestId++; requestMap.set(id, { channel: 'instrument', symbols: [], remaining: new Set() }); counters.subscriptionRequests += 1;
        if (!send({ method: 'subscribe', params: { channel: 'instrument', snapshot: true, include_tokenized_assets: false }, req_id: id })) { instrumentState = 'FAILED'; instrumentError = 'SOCKET_NOT_OPEN'; state = 'DEGRADED'; }
      },
      onClose: ({ epochId, reason }) => {
        const ts = clock();
        if (subscribeTimer !== null) timers.clearTimeout(subscribeTimer); subscribeTimer = null; subscriptionQueue.length = 0;
        for (const m of markets.values()) {
          for (const channel of ['ticker', 'ohlc']) if (m.channels[channel] === 'SUBSCRIBED' || m.channels[channel] === 'PENDING') { m.channels[channel] = stopping ? 'STOPPED' : 'GAP'; coverageRecord(m, channel, 'GAP', ts, { state: m.channels[channel], reason: reason ?? 'SOCKET_CLOSED', epochId }, stopping); }
          m.pendingCandle = null;
        }
        if (!stopping && !recordingError) state = 'DEGRADED';
      },
    });
    ws.start();
  }

  const freshness = (m, now) => {
    // Public readiness is based on the last fsynced latest snapshot / appended
    // close, never merely a value waiting in the coalescing buffer.
    const t = m.latestTicker; const p = m.latestProvisional; const c = p ?? m.latestClosed;
    const tickerAge = t ? Math.max(0, now - t.receivedTs) : null; const tickerEventAge = t?.sourceEventTs ? Math.max(0, now - t.sourceEventTs) : null;
    const candleAge = c ? Math.max(Math.max(0, now - c.receivedTs), Math.max(0, now - c.periodEndTs)) : null;
    const tickerContinuous = !!t && t.epochId === currentEpoch && m.channels.ticker === 'SUBSCRIBED';
    const candleContinuous = !!c && c.epochId === currentEpoch && m.channels.ohlc === 'SUBSCRIBED';
    const tickerState = !t ? 'NEVER_OBSERVED' : !tickerContinuous ? 'EPOCH_STALE' : t.quality === 'FAILED' ? 'INVALID' : t.payload.lastPrice === null ? 'OBSERVED_MISSING_PRICE' : t.payload.messageType === 'snapshot' ? 'IDLE_SNAPSHOT_BASELINE' : t.quality !== 'OBSERVED' ? 'OBSERVED_PARTIAL' : tickerAge > cfg.tickerFreshMs ? 'STALE' : tickerEventAge === null || tickerEventAge > cfg.tickerFreshMs ? 'IDLE_NO_RECENT_TRADE' : 'FRESH';
    const currentInterval = !!p && p.periodStartTs <= now + cfg.clockSkewMs && p.periodEndTs >= now - cfg.clockSkewMs;
    const candleState = !c ? 'NEVER_OBSERVED' : !candleContinuous ? 'EPOCH_STALE' : p ? (currentInterval && candleAge <= cfg.candleFreshMs ? 'PROVISIONAL_FRESH' : 'PROVISIONAL_STALE') : (candleAge <= cfg.candleFreshMs ? 'CLOSED_FRESH' : 'CLOSED_STALE');
    return { tickerState, tickerAge, candleState, candleAge };
  };
  const perMarketStatus = (now) => [...markets.values()].map((m) => {
    const f = freshness(m, now);
    const ticker = m.currentTicker ?? m.latestTicker; const provisional = m.currentProvisional ?? m.latestProvisional; const closed = m.latestClosed; const candle = provisional ?? closed;
    const tickerPending = !!m.currentTicker && m.currentTicker.recordId !== m.latestTicker?.recordId;
    const candlePending = !!m.currentProvisional && m.currentProvisional.recordId !== m.latestProvisional?.recordId;
    return { canonicalCoin: m.canonicalCoin, pairKey: m.pairKey, nativeBase: m.nativeBase, catalogWsname: m.catalogWsname, wsSymbol: m.wsSymbol, mappingState: m.mappingState, channels: { ...m.channels }, ticker: { state: tickerPending ? 'PENDING_PERSIST' : f.tickerState, persisted: !tickerPending && !!ticker, lastReceivedTs: ticker?.receivedTs ?? null, sourceEventTs: ticker?.sourceEventTs ?? null, ageMs: tickerPending ? Math.max(0, now - ticker.receivedTs) : f.tickerAge, lastPrice: ticker?.payload.lastPrice ?? null, volume24hBase: ticker?.payload.volume24hBase ?? null, vwap24h: ticker?.payload.vwap24h ?? null }, candle: { state: candlePending ? 'PENDING_PERSIST' : f.candleState, persisted: !candlePending && !!candle, lastReceivedTs: candle?.receivedTs ?? null, periodStartTs: candle?.periodStartTs ?? null, periodEndTs: candle?.periodEndTs ?? null, ageMs: candlePending ? Math.max(0, now - candle.receivedTs) : f.candleAge, quality: candle?.quality ?? null, close: candle?.payload.close ?? null, volumeBase: candle?.payload.volumeBase ?? null, learningEligible: false, provisional: provisional ? { receivedTs: provisional.receivedTs, periodStartTs: provisional.periodStartTs, periodEndTs: provisional.periodEndTs, close: provisional.payload.close, volumeBase: provisional.payload.volumeBase, trades: provisional.payload.trades } : null, closed: closed ? { receivedTs: closed.receivedTs, periodStartTs: closed.periodStartTs, periodEndTs: closed.periodEndTs, close: closed.payload.close, volumeBase: closed.payload.volumeBase, trades: closed.payload.trades, finality: closed.payload.finality } : null }, lastError: m.lastError };
  });
  const status = () => {
    const now = clock(); const perMarket = perMarketStatus(now); const channelCount = (ch, value) => perMarket.filter((m) => m.channels[ch] === value).length;
    const countState = (field, values) => perMarket.filter((m) => values.includes(m[field].state)).length;
    const storage = store.status();
    return clone({ version: BROAD_KRAKEN_VERSION, state, startedTs, stoppedTs,
      catalog: { state: !acceptedCatalog ? 'WAITING' : catalogLastError ? 'STALE_OR_REJECTED' : 'ACCEPTED', contentId: acceptedCatalog?.contentId ?? null, observedTs: acceptedCatalog?.observedTs ?? null, ageMs: acceptedCatalog ? Math.max(0, now - acceptedCatalog.observedTs) : null, maxAgeMs: cfg.maxCatalogAgeMs, markets: acceptedCatalog?.markets.length ?? 0, attempted: markets.size, lastCheckedTs: catalogLastCheckedTs, lastError: catalogLastError },
      instrument: { state: instrumentState, receivedTs: lastInstrumentTs, pairs: instrumentPairs.size, mapped: perMarket.filter((m) => m.mappingState === 'MAPPED').length, unsupported: perMarket.filter((m) => m.mappingState === 'UNSUPPORTED').length, ambiguous: perMarket.filter((m) => m.mappingState === 'AMBIGUOUS').length, lastError: instrumentError },
      socket: ws?.status?.() ?? { state: 'STOPPED' },
      subscription: { queueDepth: subscriptionQueue.length, requestsSent: counters.subscriptionRequests, ackedTicker: channelCount('ticker', 'SUBSCRIBED'), ackedOhlc: channelCount('ohlc', 'SUBSCRIBED'), failedTicker: channelCount('ticker', 'FAILED'), failedOhlc: channelCount('ohlc', 'FAILED') },
      recording: { state: recordingError ? 'FAILED' : stopping ? 'STOPPING' : 'ACTIVE', ...storage, latestSnapshotCadenceMs: cfg.latestSnapshotMs, queued: writeQueue.length, maxQueue: cfg.maxQueue, error: recordingError },
      freshness: { tickerFreshMs: cfg.tickerFreshMs, candleFreshMs: cfg.candleFreshMs, freshTicker: countState('ticker', ['FRESH']), staleTicker: countState('ticker', ['STALE', 'EPOCH_STALE']), idleTicker: countState('ticker', ['IDLE_NO_RECENT_TRADE', 'IDLE_SNAPSHOT_BASELINE']), snapshotBaselineTicker: countState('ticker', ['IDLE_SNAPSHOT_BASELINE']), partialTicker: countState('ticker', ['OBSERVED_PARTIAL', 'INVALID']), neverTicker: countState('ticker', ['NEVER_OBSERVED']), missingPriceTicker: countState('ticker', ['OBSERVED_MISSING_PRICE']), freshCandle: countState('candle', ['PROVISIONAL_FRESH', 'CLOSED_FRESH']), staleCandle: countState('candle', ['PROVISIONAL_STALE', 'CLOSED_STALE', 'EPOCH_STALE']), neverCandle: countState('candle', ['NEVER_OBSERVED']), provisionalCandle: countState('candle', ['PROVISIONAL_FRESH', 'PROVISIONAL_STALE']), closedCandle: countState('candle', ['CLOSED_FRESH', 'CLOSED_STALE']) },
      counters: { ...counters }, perMarket,
    });
  };
  const latest = (canonicalCoin = null) => {
    const rows = perMarketStatus(clock());
    if (canonicalCoin !== null) return clone(rows.find((m) => m.canonicalCoin === canonicalCoin) ?? null);
    return clone({ catalogContentId: acceptedCatalog?.contentId ?? null, markets: rows });
  };
  const drain = async () => {
    if (latestTimer !== null) timers.clearTimeout(latestTimer); latestTimer = null;
    while ((writeQueue.length || draining) && !recordingError) { drainWrites(); await Promise.resolve(); }
    if (!recordingError) {
      store.flush();
      if (latestTimer !== null) timers.clearTimeout(latestTimer); latestTimer = null;
      if (latestDirty) persistLatestSnapshot();
    }
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (latestTimer !== null) timers.clearTimeout(latestTimer); latestTimer = null;
      stopping = true; if (state !== 'RECORDING_FAILED') state = 'STOPPING';
      if (catalogTimer !== null) timers.clearInterval(catalogTimer); catalogTimer = null;
      if (subscribeTimer !== null) timers.clearTimeout(subscribeTimer); subscribeTimer = null;
      if (drainTimer !== null) timers.clearTimeout(drainTimer); drainTimer = null;
      try { await ws?.stop?.(); } catch (error) { if (!recordingError) recordingError = { code: 'BROAD_MARKET_SOCKET_STOP_FAILED', message: boundedText(error?.message), ts: clock() }; }
      await drain();
      try { store.close(); } catch (error) { if (!recordingError) recordingError = { code: boundedText(error?.code || 'BROAD_MARKET_CLOSE_FAILED', 60), message: boundedText(error?.message), ts: clock() }; }
      stoppedTs = clock(); state = recordingError ? 'RECORDING_FAILED' : 'STOPPED';
      return status();
    })(); return stopPromise;
  };

  adoptCatalog();
  catalogTimer = timers.setInterval(adoptCatalog, cfg.catalogPollMs); catalogTimer?.unref?.();
  return { status, latest, drain, stop, dataDir: store.status().dir };
}
