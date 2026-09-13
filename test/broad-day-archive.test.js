import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { open as openFile } from 'node:fs/promises';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  BROAD_DAY_ARCHIVE_DURABILITY,
  BROAD_DAY_ARCHIVE_VERSION,
  openBroadDayArchive,
} from '../market-lab/broad-day-archive.js';
import { BROAD_KRAKEN_RECORD_VERSION } from '../market-lab/broad-kraken.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const T0 = Date.parse('2026-09-13T12:00:00.000Z');
const roots = [];
const root = (name) => { const dir = mkdtempSync(path.join(tmpdir(), `broad-day-${name}-`)); roots.push(dir); return dir; };
test.after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function catalogAt(observedTs = T0, { eth = false } = {}) {
  const result = {
    XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
    ...(eth ? { XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' } } : {}),
  };
  const normalized = normalizeKrakenAssetPairs(result, { observedTs });
  assert.equal(normalized.ok, true);
  return normalized.catalog;
}

function marketOf(catalog, coin = 'BTC') {
  const m = catalog.markets.find((row) => row.base === coin);
  return { canonicalCoin: m.base, pairKey: m.pairKey, nativeBase: m.nativeBase, catalogWsname: m.wsname, wsSymbol: m.wsname };
}

function seal(body, { sessionId = 'broad-source-session', sequence = 1, recordedTs = body.receivedTs + 10 } = {}) {
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION,
    recordId: null,
    sessionId,
    sequence,
    recordType: body.recordType,
    recordedTs,
    catalogContentId: body.catalogContentId ?? null,
    epochId: body.epochId ?? 'broad-source-epoch',
    market: body.market ?? null,
    channel: body.channel ?? null,
    quality: body.quality,
    sourceEventTs: body.sourceEventTs ?? null,
    receivedTs: body.receivedTs,
    periodStartTs: body.periodStartTs ?? null,
    periodEndTs: body.periodEndTs ?? null,
    payload: body.payload,
  };
  record.recordId = `bkr-${hash(record)}`;
  return Object.freeze(record);
}

function closed(catalog, {
  coin = 'BTC', periodStartTs = T0, receivedTs = periodStartTs + 60_500,
  recordedTs = receivedTs + 10, sequence = 1, close = 101,
} = {}) {
  return seal({
    recordType: 'OHLC', catalogContentId: catalog.contentId, market: marketOf(catalog, coin), channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED',
    receivedTs, periodStartTs, periodEndTs: periodStartTs + 60_000,
    payload: {
      messageType: 'closed', finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME', learningEligible: false,
      open: 100, high: Math.max(102, close), low: 99, close, vwap: 100.5, trades: 3, volumeBase: 4,
    },
  }, { sequence, recordedTs });
}

function instrument(catalog, { coin = 'BTC', receivedTs = T0 + 2_000, sequence = 1 } = {}) {
  const market = marketOf(catalog, coin);
  return seal({
    recordType: 'INSTRUMENT_MAP', catalogContentId: catalog.contentId, market, channel: 'instrument', quality: 'OBSERVED', receivedTs,
    payload: { mappingState: 'MAPPED', candidates: [market.wsSymbol], pair: { symbol: market.wsSymbol, base: market.nativeBase, quote: 'USD', status: 'online' } },
  }, { sequence });
}

function ticker(catalog, { receivedTs = T0 + 3_000 } = {}) {
  return seal({
    recordType: 'TICKER', catalogContentId: catalog.contentId, market: marketOf(catalog), channel: 'ticker', quality: 'OBSERVED', receivedTs,
    payload: { messageType: 'update', lastPrice: 100, volume24hBase: 20 },
  });
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const closeIgnoringFailure = async (archive) => { try { await archive.close(); } catch { /* expected in failure cases */ } };

test('catalog control is admitted/written before controls and a late-known conservative candle; all claims stay local and incomplete', async () => {
  let now = T0 + 11 * 60_000;
  const dir = root('order'); const catalog = catalogAt();
  const archive = openBroadDayArchive({ rootDir: dir, clock: () => now, limits: { fsyncEveryEntries: 2 } });
  const a = archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: T0 + 1_000 });
  const b = archive.tryAcceptRecord(instrument(catalog));
  const candle = closed(catalog, { receivedTs: T0 + 10 * 60_000, recordedTs: T0 + 10 * 60_000 + 10, sequence: 2 });
  const c = archive.tryAcceptRecord(candle);
  assert.deepEqual([a.accepted, b.accepted, c.accepted], [true, true, true]);
  assert.deepEqual([a.durable, b.durable, c.durable], [false, false, false], 'synchronous admission is never labeled durable');
  await archive.drain();

  const status = archive.status();
  assert.equal(status.version, BROAD_DAY_ARCHIVE_VERSION);
  assert.equal(status.durability, BROAD_DAY_ARCHIVE_DURABILITY);
  assert.equal(status.republishSafe, false);
  assert.equal(status.learningEligible, false);
  assert.equal(status.simulationCredit, 0);
  assert.deepEqual(status.claims, { fullDay: false, fullPopulation: false, continuity: false, finalized: false, externallyDurable: false });
  assert.deepEqual(status.ordinals, { admitted: 3, written: 3, fsynced: 3, sealed: null });
  assert.equal(status.completeness.recordContinuityVerified, false, 'this slice does not infer full-day continuity from successful writes');

  const control = lines(path.join(status.sessionDir, 'controls.jsonl'));
  assert.deepEqual(control.map((row) => [row.globalOrdinal, row.kind]), [[1, 'CATALOG_CONTROL'], [2, 'SOURCE_CONTROL'], [3, 'CLOSED_CANDLE_INDEX']]);
  assert.equal(control[1].previousControlDigest, control[0].controlDigest);
  assert.equal(control[2].previousControlDigest, control[1].controlDigest);
  assert.equal(control[2].catalogControlDigest, control[0].controlDigest);
  const shardName = readdirSync(path.join(status.sessionDir, 'shards'))[0];
  const shard = lines(path.join(status.sessionDir, 'shards', shardName));
  assert.equal(shard.length, 1);
  assert.equal(shard[0].globalOrdinal, 3);
  assert.equal(shard[0].globalControlDigest, control[2].controlDigest);
  assert.equal(shard[0].knownAtTs, now, 'period end and delayed receipt never backdate archive knowledge');
  assert.equal(shard[0].record.periodEndTs, T0 + 60_000);
  await archive.close();
  assert.equal(existsSync(path.join(dir, 'writer.lock')), false);
});

test('ticker/provisional history is a nonfatal explicit exclusion; malformed archive-eligible input latches once', async () => {
  let now = T0 + 120_000; const catalog = catalogAt();
  const excludedFaults = []; const excluded = openBroadDayArchive({ rootDir: root('excluded'), clock: () => now, onFault: (f) => excludedFaults.push(f) });
  assert.equal(excluded.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 }).accepted, true);
  const skip = excluded.tryAcceptRecord(ticker(catalog));
  assert.deepEqual({ accepted: skip.accepted, code: skip.code, fatal: skip.fatal }, { accepted: false, code: 'ARCHIVE_RECORD_NOT_ELIGIBLE', fatal: false });
  assert.equal(excluded.status().failure, null);
  assert.equal(excludedFaults.length, 0);
  await excluded.close();

  const faults = []; const bad = openBroadDayArchive({ rootDir: root('invalid'), clock: () => now, onFault: (f) => faults.push(f) });
  assert.equal(bad.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 }).accepted, true);
  const malformed = { ...closed(catalog), quality: 'PROVISIONAL' };
  const refused = bad.tryAcceptRecord(malformed);
  assert.equal(refused.accepted, false);
  assert.equal(refused.code, 'ARCHIVE_RECORD_INVALID', 'changing a sealed broad record fails its source identity before archive classification');
  assert.equal(faults.length, 1);
  assert.equal(bad.tryAcceptRecord(closed(catalog, { periodStartTs: T0 + 60_000, sequence: 2 })).code, 'ARCHIVE_FAILED');
  assert.equal(faults.length, 1, 'permanent failure invokes onFault once');
  await assert.rejects(bad.drain(), (error) => error.code === 'ARCHIVE_RECORD_INVALID');
  await assert.rejects(bad.close(), (error) => error.code === 'ARCHIVE_RECORD_INVALID');
});

test('queue saturation is synchronous, permanent and loss-visible while already-admitted rows still drain', async () => {
  const faults = []; const catalog = catalogAt(); const dir = root('queue'); let now = T0 + 180_000;
  const archive = openBroadDayArchive({ rootDir: dir, clock: () => now, limits: { maxQueueRows: 2 }, onFault: (f) => faults.push(f) });
  const first = archive.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 });
  const second = archive.tryAcceptRecord(instrument(catalog));
  const overflow = archive.tryAcceptRecord(closed(catalog));
  assert.deepEqual([first.accepted, second.accepted, overflow.accepted], [true, true, false]);
  assert.equal(overflow.code, 'ARCHIVE_BACKPRESSURE');
  assert.equal(faults.length, 1);
  await assert.rejects(archive.drain(), (error) => error.code === 'ARCHIVE_BACKPRESSURE');
  const status = archive.status();
  assert.deepEqual(status.ordinals, { admitted: 2, written: 2, fsynced: 2, sealed: null });
  assert.equal(status.completeness.incomplete, true);
  assert.equal(lines(path.join(status.sessionDir, 'controls.jsonl')).length, 2, 'prior admissions remain visible; the refused row is not invented');
  await assert.rejects(archive.close(), (error) => error.code === 'ARCHIVE_BACKPRESSURE');
  assert.equal(existsSync(path.join(dir, 'writer.lock')), false);
});

test('UTF-8 record and queue-byte caps apply before archive envelope allocation or partial persistence', async () => {
  const catalog = catalogAt(); let now = T0 + 180_000;
  const oversized = openBroadDayArchive({ rootDir: root('record-bytes'), clock: () => now, limits: { maxRecordBytes: 1_024 } });
  oversized.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 });
  const market = marketOf(catalog);
  const huge = seal({
    recordType: 'INSTRUMENT_MAP', catalogContentId: catalog.contentId, market, channel: 'instrument', quality: 'OBSERVED', receivedTs: T0 + 2_000,
    payload: { mappingState: 'MAPPED', candidates: [market.wsSymbol], pair: { symbol: market.wsSymbol, base: market.nativeBase, quote: 'USD', status: 'online' }, extra: 'é'.repeat(2_000) },
  });
  assert.equal(oversized.tryAcceptRecord(huge).code, 'ARCHIVE_INPUT_TOO_LARGE');
  assert.equal(existsSync(path.join(oversized.status().sessionDir, 'controls.jsonl')), false, 'the writer has not received a partially serialized oversized row');
  await closeIgnoringFailure(oversized);

  const calibrate = openBroadDayArchive({ rootDir: root('queue-byte-calibrate'), clock: () => now });
  calibrate.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 });
  const exactCatalogQueueBytes = calibrate.status().queue.bytes;
  await calibrate.close();
  const byteCap = openBroadDayArchive({ rootDir: root('queue-byte-cap'), clock: () => now, limits: { maxCatalogBytes: exactCatalogQueueBytes, maxRecordBytes: Math.min(940, exactCatalogQueueBytes), maxQueueBytes: exactCatalogQueueBytes } });
  assert.equal(byteCap.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 }).accepted, true);
  assert.equal(byteCap.tryAcceptRecord(instrument(catalog)).code, 'ARCHIVE_BACKPRESSURE');
  await assert.rejects(byteCap.drain(), (error) => error.code === 'ARCHIVE_BACKPRESSURE');
  await closeIgnoringFailure(byteCap);
});

test('exact record replay is idempotent; a different candle for the same market/minute is preserved as a conflict', async () => {
  const catalog = catalogAt(); let now = T0 + 180_000;
  const archive = openBroadDayArchive({ rootDir: root('conflict'), clock: () => now });
  archive.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 });
  const one = closed(catalog, { close: 101 });
  const conflict = closed(catalog, { close: 103, sequence: 2, recordedTs: one.recordedTs + 1 });
  assert.equal(archive.tryAcceptRecord(one).accepted, true);
  const again = archive.tryAcceptRecord(one);
  assert.deepEqual({ accepted: again.accepted, code: again.code, ordinal: again.ordinal }, { accepted: true, code: 'IDEMPOTENT', ordinal: null });
  const second = archive.tryAcceptRecord(conflict);
  assert.equal(second.accepted, true);
  assert.equal(second.conflict, true);
  await archive.drain();
  const status = archive.status();
  assert.equal(status.counters.idempotent, 1);
  assert.equal(status.counters.conflicts, 1);
  const controls = lines(path.join(status.sessionDir, 'controls.jsonl'));
  assert.equal(controls.filter((row) => row.kind === 'CLOSED_CANDLE_INDEX').length, 2);
  const shardName = readdirSync(path.join(status.sessionDir, 'shards'))[0];
  const shard = lines(path.join(status.sessionDir, 'shards', shardName));
  assert.deepEqual(shard.map((row) => row.conflict), [false, true]);
  assert.notEqual(shard[0].recordDigest, shard[1].recordDigest);
  await archive.close();
});

test('per-shard and shard-file caps latch instead of evicting accepted evidence', async () => {
  const catalog = catalogAt(T0, { eth: true }); let now = T0 + 240_000;
  const rowCap = openBroadDayArchive({ rootDir: root('row-cap'), clock: () => now, limits: { maxShardRows: 1 } });
  rowCap.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 });
  assert.equal(rowCap.tryAcceptRecord(closed(catalog)).accepted, true);
  assert.equal(rowCap.tryAcceptRecord(closed(catalog, { periodStartTs: T0 + 60_000, sequence: 2 })).code, 'ARCHIVE_CAP_REACHED');
  await assert.rejects(rowCap.drain(), (error) => error.code === 'ARCHIVE_CAP_REACHED');
  assert.equal(rowCap.status().files.shards, 1);
  await closeIgnoringFailure(rowCap);

  const fileCap = openBroadDayArchive({ rootDir: root('file-cap'), clock: () => now, limits: { maxShardFiles: 1, maxOpenShards: 1 } });
  fileCap.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 });
  assert.equal(fileCap.tryAcceptRecord(closed(catalog, { coin: 'BTC' })).accepted, true);
  assert.equal(fileCap.tryAcceptRecord(closed(catalog, { coin: 'ETH', sequence: 2 })).code, 'ARCHIVE_CAP_REACHED');
  await assert.rejects(fileCap.drain(), (error) => error.code === 'ARCHIVE_CAP_REACHED');
  assert.equal(fileCap.status().files.shards, 1, 'no accepted shard is evicted to make room');
  await closeIgnoringFailure(fileCap);
});

function failingIo(kind) {
  return {
    async open(file, flags, mode) {
      const handle = await openFile(file, flags, mode);
      let injected = false;
      return {
        async write(...args) {
          if (kind === 'write' && !injected) { injected = true; const error = new Error('injected write failure'); error.code = 'EIO_TEST'; throw error; }
          return handle.write(...args);
        },
        async sync() {
          if (kind === 'fsync' && !injected) { injected = true; const error = new Error('injected fsync failure'); error.code = 'EIO_TEST'; throw error; }
          return handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };
}

for (const [kind, code] of [['write', 'ARCHIVE_WRITE_FAILED'], ['fsync', 'ARCHIVE_FSYNC_FAILED']]) {
  test(`${kind} failure latches a stable category, produces no unhandled rejection and close releases only its own lock`, async () => {
    const catalog = catalogAt(); const dir = root(`${kind}-failure`); const faults = []; let now = T0 + 180_000;
    const archive = openBroadDayArchive({ rootDir: dir, clock: () => now, io: failingIo(kind), onFault: (f) => faults.push(f) });
    assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 }).accepted, true);
    await assert.rejects(archive.drain(), (error) => error.code === code);
    assert.equal(archive.status().failure.code, code);
    assert.equal(faults.length, 1);
    await assert.rejects(archive.close(), (error) => error.code === code);
    assert.equal(existsSync(path.join(dir, 'writer.lock')), false);
  });
}

test('writer ownership has no timed takeover; orderly close permits a new independent session', async () => {
  const dir = root('lock'); let now = T0 + 1;
  const first = openBroadDayArchive({ rootDir: dir, clock: () => now });
  now += 10_000_000;
  assert.throws(() => openBroadDayArchive({ rootDir: dir, clock: () => now }), (error) => error.code === 'ARCHIVE_WRITER_HELD', 'age never authorizes takeover');
  const firstSession = first.status().sessionId;
  await first.close();
  const second = openBroadDayArchive({ rootDir: dir, clock: () => now + 1 });
  assert.notEqual(second.status().sessionId, firstSession);
  await second.close();
});

test('close never deletes a replaced writer lock token', async () => {
  const dir = root('foreign-lock'); const archive = openBroadDayArchive({ rootDir: dir, clock: () => T0 + 1 });
  const lock = path.join(dir, 'writer.lock');
  writeFileSync(lock, '{"token":"foreign-owner"}\n');
  await assert.rejects(archive.close(), (error) => error.code === 'ARCHIVE_LOCK_LOST');
  assert.equal(readFileSync(lock, 'utf8'), '{"token":"foreign-owner"}\n');
});

test('close waits for an admitted asynchronous write and immediately closes further admission', async () => {
  let releaseWrite; const held = new Promise((resolve) => { releaseWrite = resolve; });
  let reportStarted; const started = new Promise((resolve) => { reportStarted = resolve; });
  let blocked = false;
  const io = {
    async open(file, flags, mode) {
      const handle = await openFile(file, flags, mode);
      return {
        async write(...args) {
          if (!blocked) { blocked = true; reportStarted(); await held; }
          return handle.write(...args);
        },
        sync: () => handle.sync(), close: () => handle.close(),
      };
    },
  };
  const catalog = catalogAt(); const dir = root('close-drain'); let now = T0 + 180_000;
  const archive = openBroadDayArchive({ rootDir: dir, clock: () => now, io });
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: T0, knownAtTs: T0 + 1 }).accepted, true);
  await reportStarted;
  const closing = archive.close();
  assert.equal(archive.tryAcceptRecord(closed(catalog)).code, 'ARCHIVE_CLOSED');
  assert.equal(archive.status().state, 'CLOSING');
  releaseWrite();
  const final = await closing;
  assert.equal(final.state, 'CLOSED');
  assert.deepEqual(final.ordinals, { admitted: 1, written: 1, fsynced: 1, sealed: null });
  assert.equal(existsSync(path.join(dir, 'writer.lock')), false);
});
