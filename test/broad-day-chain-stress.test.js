import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordError, broadKrakenRecordIdOf,
} from '../market-lab/broad-kraken.js';
import { BROAD_DAY_ARCHIVE_VERSION_V2, openBroadDayArchive } from '../market-lab/broad-day-archive.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { prepareDailyBroadArchiveInput } from '../learning/daily-broad-archive-input.js';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 1_440 * MINUTE;
const MARKET_COUNT = 24;
const ROW_COUNT = MARKET_COUNT * 1_440;

const roots = [];
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function catalogAt(observedTs) {
  const pairs = {};
  for (let i = 0; i < MARKET_COUNT; i += 1) {
    const base = `C${String(i).padStart(3, '0')}`;
    pairs[`${base}USD`] = { wsname: `${base}/USD`, base, quote: 'USD', status: 'online' };
  }
  const normalized = normalizeKrakenAssetPairs(pairs, { observedTs });
  assert.equal(normalized.ok, true); return normalized.catalog;
}

function sourceRecord(catalog, market, minute, sequence) {
  const periodStartTs = START + minute * MINUTE;
  const receivedTs = periodStartTs + MINUTE + 500;
  const close = 100 + (minute % 7) / 100;
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null,
    sessionId: 'stress-source-session', sequence, recordType: 'OHLC', recordedTs: receivedTs + 10,
    catalogContentId: catalog.contentId, epochId: 'stress-source-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
      catalogWsname: market.wsname, wsSymbol: market.wsname,
    },
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, receivedTs,
    periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: {
      volumeBase: 1 + (sequence % 11) / 10, trades: sequence % 17, vwap: close,
      open: close, high: close, low: close, close,
      learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record);
  assert.equal(broadKrakenRecordError(record), null);
  return record;
}

async function buildStressArchive() {
  const root = mkdtempSync(path.join(tmpdir(), 'broad-chain-stress-')); roots.push(root);
  let now = START - MINUTE; let sequence = 0; let catalog = catalogAt(now);
  const archive = openBroadDayArchive({
    rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now,
    limits: {
      maxQueueRows: 10_000, maxQueueBytes: 64 * 1024 * 1024,
      maxControlRows: 100_000, maxIdentityRows: 100_000, fsyncEveryEntries: 1_024,
    },
  });
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  for (let minute = 0; minute < 1_440; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = START + minute * MINUTE + 520; catalog = catalogAt(now);
      assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    }
    for (const market of catalog.markets) {
      const record = sourceRecord(catalog, market, minute, ++sequence); now = record.recordedTs;
      const accepted = archive.tryAcceptRecord(record);
      assert.equal(accepted.accepted, true, `${market.base}/${minute}: ${accepted.code}`);
      if (market === catalog.markets[0] && minute > 0 && minute % 360 === 0) {
        const duplicate = archive.tryAcceptRecord(record);
        assert.equal(duplicate.accepted, true); assert.equal(duplicate.code, 'IDEMPOTENT');
      }
    }
    if (minute > 0 && minute % 120 === 0) await archive.drain();
  }
  now = END + 520; catalog = catalogAt(now);
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  assert.equal(archive.finalize({ cutoffTs: now }).accepted, true);
  await archive.close();
  return root;
}

test('bounded 34,560-row archive chain yields, replays deterministically and retains all markets', { timeout: 90_000 }, async () => {
  const root = await buildStressArchive();
  let timerObserved = false;
  const responsivenessProbe = setTimeout(() => { timerObserved = true; }, 0);
  const first = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { pageRows: 127, maxPages: 1_000, maxRows: ROW_COUNT, maxMaterializedBytes: 128 * 1024 * 1024 },
  });
  clearTimeout(responsivenessProbe);
  assert.equal(first.ok, true, first.message);
  assert.equal(timerObserved, true, 'async reader must yield to the parent event loop during bounded paging');
  assert.equal(first.diagnostics.rows, ROW_COUNT);
  assert.equal(first.diagnostics.catalogMarkets, MARKET_COUNT);
  assert.equal(first.marketDays.length, MARKET_COUNT);
  assert.ok(first.diagnostics.pages > 250 && first.diagnostics.pages < 1_000);
  assert.ok(first.diagnostics.materializedBytes > 0 && first.diagnostics.materializedBytes < 128 * 1024 * 1024);
  assert.match(first.diagnostics.materializedByteBasis, /NOT_PROCESS_HEAP/);
  assert.ok(first.marketDays.every((row) => row.candles.length === 1_440));

  const replay = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { pageRows: 2_000, maxRows: ROW_COUNT, maxMaterializedBytes: 128 * 1024 * 1024 },
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.inputDigest, first.inputDigest, 'reader paging and process restart boundaries cannot alter content identity');
});

test('page, byte and cancellation pressure refuse whole inputs without a partial denominator', { timeout: 90_000 }, async () => {
  const root = await buildStressArchive();
  const marketBound = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { maxMarkets: MARKET_COUNT - 1 },
  });
  assert.deepEqual({ ok: marketBound.ok, code: marketBound.code }, { ok: false, code: 'CATALOG_UNION_INVALID' });
  assert.equal(Object.hasOwn(marketBound, 'marketDays'), false);

  const pageBound = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { pageRows: 100, maxPages: 10, maxRows: ROW_COUNT, maxMaterializedBytes: 128 * 1024 * 1024 },
  });
  assert.deepEqual({ ok: pageBound.ok, code: pageBound.code }, { ok: false, code: 'PAGE_LIMIT' });
  assert.equal(Object.hasOwn(pageBound, 'marketDays'), false);

  const byteBound = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { pageRows: 100, maxRows: ROW_COUNT, maxMaterializedBytes: 1_024 },
  });
  assert.deepEqual({ ok: byteBound.ok, code: byteBound.code }, { ok: false, code: 'MATERIALIZED_BYTE_LIMIT' });
  assert.equal(Object.hasOwn(byteBound, 'marketDays'), false);

  const controller = new AbortController(); controller.abort();
  const cancelled = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE, signal: controller.signal,
  });
  assert.equal(cancelled.ok, false);
  assert.equal(Object.hasOwn(cancelled, 'marketDays'), false);
});
