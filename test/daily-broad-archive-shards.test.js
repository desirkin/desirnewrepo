import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordIdOf,
} from '../market-lab/broad-kraken.js';
import { BROAD_DAY_ARCHIVE_VERSION_V2, openBroadDayArchive } from '../market-lab/broad-day-archive.js';
import { openBroadDayReader } from '../market-lab/broad-day-reader.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import {
  dailyBroadArchiveMarketDayReceiptError,
  openDailyBroadArchiveShardSource as openDailyBroadArchiveShardSourceImpl,
} from '../learning/daily-broad-archive-shards.js';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 1_440 * MINUTE;
const roots = [];
const openDailyBroadArchiveShardSource = (options) => openDailyBroadArchiveShardSourceImpl({ ...options, openBroadDayReader });
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('archive shard source refuses missing and malformed reader ports', async () => {
  const common = { rootDir: 'unused', dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE };
  await assert.rejects(openDailyBroadArchiveShardSourceImpl(common), (error) => error.code === 'READER_FACTORY_REQUIRED');
  let closed = 0;
  await assert.rejects(openDailyBroadArchiveShardSourceImpl({
    ...common,
    openBroadDayReader: async () => ({ descriptor: {}, close: () => { closed += 1; } }),
  }), (error) => error.code === 'READER_PORT_INVALID');
  assert.equal(closed, 1);
});

function catalogAt(observedTs) {
  const result = normalizeKrakenAssetPairs({
    AAUSD: { wsname: 'AA/USD', base: 'AA', quote: 'USD', status: 'online' },
    BBUSD: { wsname: 'BB/USD', base: 'BB', quote: 'USD', status: 'online' },
    CCUSD: { wsname: 'CC/USD', base: 'CC', quote: 'USD', status: 'online' },
  }, { observedTs });
  assert.equal(result.ok, true); return result.catalog;
}

function candle(catalog, market, minute, sequence) {
  const periodStartTs = START + minute * MINUTE;
  const receivedTs = periodStartTs + MINUTE + 500;
  const close = 100 + sequence / 1_000_000;
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null,
    sessionId: 'shard-source-session', sequence, recordType: 'OHLC', recordedTs: receivedTs + 10,
    catalogContentId: catalog.contentId, epochId: 'shard-source-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
      catalogWsname: market.wsname, wsSymbol: market.wsname,
    },
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null,
    receivedTs, periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: {
      open: close, high: close, low: close, close, volumeBase: 2, trades: 1, vwap: close,
      learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record); return record;
}

async function fullArchive(name) {
  const root = mkdtempSync(path.join(tmpdir(), `daily-shards-${name}-`)); roots.push(root);
  let now = START - MINUTE; let sequence = 0; let catalog = catalogAt(now);
  const archive = openBroadDayArchive({
    rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now,
    limits: { maxQueueRows: 8_000, maxQueueBytes: 64 * 1024 * 1024, fsyncEveryEntries: 512 },
  });
  archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  for (let minute = 0; minute < 1_440; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = START + minute * MINUTE + 520; catalog = catalogAt(now);
      assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    }
    for (const market of catalog.markets) {
      const row = candle(catalog, market, minute, ++sequence); now = row.recordedTs;
      assert.equal(archive.tryAcceptRecord(row).accepted, true);
    }
    if (minute > 0 && minute % 300 === 0) await archive.drain();
  }
  now = END + 520; catalog = catalogAt(now);
  archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  archive.finalize({ cutoffTs: now }); await archive.close(); return root;
}

test('sealed shard inventory reads one market at a time with page-size-invariant output identity', { timeout: 30_000 }, async () => {
  const root = await fullArchive('roundtrip');
  const source = await openDailyBroadArchiveShardSource({ rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE });
  try {
    assert.equal(source.descriptor.shardCount, 3);
    assert.equal(source.descriptor.expectedRows, 4_320);
    assert.equal(source.descriptor.acceptedCatalogSnapshot.acceptedMarketCount, 3);
    assert.equal(source.descriptor.catalogProvenance.republishSafe, false);
    const [one, two] = source.descriptor.shards;
    const page = await source.readShardPage({ shardId: one.shardId, maxRows: 17 });
    assert.equal(page.rowCount, 17); assert.equal(page.done, false);
    const retry = await source.readShardPage({ shardId: one.shardId, maxRows: 17 });
    assert.deepEqual(retry, page);
    const forged = structuredClone(page.nextSourceCursor); forged.emittedRows += 1;
    await assert.rejects(source.readShardPage({ shardId: one.shardId, cursor: forged, maxRows: 17 }), (error) => error.code === 'READER_CURSOR_INVALID');
    await assert.rejects(source.readShardPage({ shardId: two.shardId, cursor: page.nextSourceCursor, maxRows: 17 }), (error) => error.code === 'READER_CURSOR_INVALID');

    const smallPages = await source.loadShard({ shardId: one.shardId, pageRows: 37 });
    const largePages = await source.loadShard({ shardId: one.shardId, pageRows: 500 });
    assert.equal(smallPages.marketDay.candles.length, 1_440);
    assert.equal(smallPages.receipt.marketDayDigest, largePages.receipt.marketDayDigest);
    assert.equal(smallPages.receipt.receiptDigest, largePages.receipt.receiptDigest);
    assert.notEqual(smallPages.receipt.pages, largePages.receipt.pages);
    assert.equal(dailyBroadArchiveMarketDayReceiptError(smallPages.receipt, {
      descriptor: source.descriptor, shard: one, marketDay: smallPages.marketDay,
    }), null);
    assert.equal(smallPages.marketDay.support.QUOTE_VOLUME.state, 'UNSUPPORTED');
  } finally { source.close(); }
});

test('reader rechecks archive inventory between market pages', { timeout: 30_000 }, async () => {
  const root = await fullArchive('mutation');
  const source = await openDailyBroadArchiveShardSource({ rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE });
  try {
    const shard = source.descriptor.shards[0];
    const page = await source.readShardPage({ shardId: shard.shardId, maxRows: 10 });
    assert.equal(page.done, false);
    mkdirSync(path.join(root, 'sessions', 'bda-9999999999999-999999-deadbeefdeadbeef'));
    await assert.rejects(source.readShardPage({ shardId: shard.shardId, cursor: page.nextSourceCursor, maxRows: 10 }), (error) => error.code === 'READER_ARCHIVE_CHANGED');
  } finally { source.close(); }
});
