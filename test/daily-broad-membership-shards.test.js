import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordError, broadKrakenRecordIdOf,
} from '../market-lab/broad-kraken.js';
import { BROAD_DAY_ARCHIVE_VERSION_V2, openBroadDayArchive } from '../market-lab/broad-day-archive.js';
import { openBroadDayReader } from '../market-lab/broad-day-reader.js';
import { prepareDailyBroadArchiveInput as prepareDailyBroadArchiveInputImpl } from '../learning/daily-broad-archive-input.js';
import {
  DAILY_BROAD_MEMBERSHIP_DATASET_VERSION,
  dailyBroadMembershipReceiptError,
  openDailyBroadMembershipShardSource as openDailyBroadMembershipShardSourceImpl,
} from '../learning/daily-broad-membership-shards.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const MINUTE = 60_000;
const DAY = Date.parse('2026-09-13T00:00:00.000Z');
const END = DAY + 1_440 * MINUTE;
const roots = [];
const prepareDailyBroadArchiveInput = (options) => prepareDailyBroadArchiveInputImpl({ ...options, openBroadDayReader });
const openDailyBroadMembershipShardSource = (options) => openDailyBroadMembershipShardSourceImpl({ ...options, openBroadDayReader });

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('membership shard source requires a well-formed injected reader port', async () => {
  const common = { rootDir: 'unused', dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE };
  await assert.rejects(
    openDailyBroadMembershipShardSourceImpl(common),
    (error) => error?.code === 'READER_FACTORY_REQUIRED',
  );

  let closed = 0;
  await assert.rejects(
    openDailyBroadMembershipShardSourceImpl({
      ...common,
      openBroadDayReader: async () => ({ descriptor: {}, close() { closed += 1; } }),
    }),
    (error) => error?.code === 'READER_PORT_INVALID',
  );
  assert.equal(closed, 1);
});

function makeRoot(name) {
  const root = mkdtempSync(path.join(tmpdir(), `membership-shards-${name}-`));
  roots.push(root);
  return root;
}

function catalogAt(observedTs, { eth = false, btcKey = 'XXBTZUSD' } = {}) {
  const normalized = normalizeKrakenAssetPairs({
    [btcKey]: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
    ...(eth ? { XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' } } : {}),
  }, { observedTs });
  assert.equal(normalized.ok, true);
  return normalized.catalog;
}

function candle(catalog, market, periodStartTs, sequence) {
  const periodEndTs = periodStartTs + MINUTE;
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null,
    sessionId: 'membership-source-session', sequence, recordType: 'OHLC',
    recordedTs: periodEndTs, catalogContentId: catalog.contentId,
    epochId: 'membership-source-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
      catalogWsname: market.wsname, wsSymbol: market.wsname,
    },
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null,
    receivedTs: periodEndTs, periodStartTs, periodEndTs,
    payload: {
      volumeBase: 3, trades: 2, vwap: 100, close: 101, low: 99, high: 102, open: 100,
      learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record);
  assert.equal(broadKrakenRecordError(record), null);
  return Object.freeze(record);
}

function shape(mode, after) {
  if (mode === 'listing') return { eth: after };
  if (mode === 'delisting') return { eth: !after };
  if (mode === 'rename') return { btcKey: after ? 'XBTUSD' : 'XXBTZUSD' };
  throw new Error(`unknown mode ${mode}`);
}

async function archiveDay(mode, { boundaryOffsetMs = 0 } = {}) {
  const rootDir = makeRoot(mode);
  let now = DAY; let sequence = 0;
  const archive = openBroadDayArchive({
    rootDir, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now,
    limits: { fsyncEveryEntries: 4_096 },
  });
  let catalog = catalogAt(now, shape(mode, false));
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  for (let minute = 0; minute < 1_440; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = DAY + minute * MINUTE + (minute === 720 ? boundaryOffsetMs : 0);
      catalog = catalogAt(now, shape(mode, minute >= 720));
      assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    }
    for (const market of catalog.markets) {
      const row = candle(catalog, market, DAY + minute * MINUTE, ++sequence);
      now = row.recordedTs;
      assert.equal(archive.tryAcceptRecord(row).accepted, true);
    }
  }
  now = END; catalog = catalogAt(now, shape(mode, true));
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  assert.equal(archive.finalize({ cutoffTs: END }).accepted, true);
  await archive.close();
  return rootDir;
}

test('listing shards seal the whole denominator while preserving 720-minute partial membership', { timeout: 45_000 }, async () => {
  const rootDir = await archiveDay('listing');
  const oldAdapter = await prepareDailyBroadArchiveInput({ rootDir, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
  assert.deepEqual({ ok: oldAdapter.ok, code: oldAdapter.code }, { ok: false, code: 'CATALOG_CHURN_UNREPRESENTABLE' });

  const source = await openDailyBroadMembershipShardSource({ rootDir, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
  assert.equal(source.descriptor.datasetVersion, DAILY_BROAD_MEMBERSHIP_DATASET_VERSION);
  assert.equal(source.descriptor.shardCount, 2);
  assert.equal(source.descriptor.expectedRows, 2_160);
  assert.equal(source.descriptor.membershipCompleteMarkets, 2);
  assert.equal(source.descriptor.fullCivilDayMarkets, 1);
  assert.equal(source.descriptor.partialCivilDayMarkets, 1);
  assert.equal(source.descriptor.consumerCompatibility.membershipIntervalsSupported, true);
  assert.equal(source.descriptor.consumerCompatibility.stableCivilDayV1AdapterCompatible, false);

  const eth = source.descriptor.shards.find((row) => row.market.canonicalCoin === 'ETH');
  assert.equal(eth.expectedRows, 720);
  assert.equal(eth.expectedCatalogMembershipMinutes, 720);
  assert.equal(eth.expectedCivilDayMinutes, 1_440);
  assert.equal(eth.membershipCoverage, 'PARTIAL_CIVIL_DAY_COMPLETE_FOR_MEMBERSHIP');
  assert.equal(eth.membershipIntervals[0].startTs, DAY + 720 * MINUTE);
  assert.equal(eth.membershipIntervals.at(-1).endTs, END);
  const loadedEth = await source.loadShard({ shardId: eth.shardId, pageRows: 113 });
  assert.equal(loadedEth.marketDay.candles.length, 720);
  assert.equal(loadedEth.marketDay.candles[0].periodStartTs, DAY + 720 * MINUTE);
  assert.equal(loadedEth.marketDay.candles.at(-1).periodEndTs, END);
  assert.equal(loadedEth.marketDay.support.CANDLES.state, 'PARTIAL');
  assert.equal(loadedEth.marketDay.support.CANDLES.observedCount, 720);
  assert.match(loadedEth.marketDay.support.CANDLES.reason, /NOT_COMPLETE_CIVIL_DAY/);
  assert.equal(dailyBroadMembershipReceiptError(loadedEth.receipt, {
    descriptor: source.descriptor, shard: eth, marketDay: loadedEth.marketDay,
  }), null);

  const btc = source.descriptor.shards.find((row) => row.market.canonicalCoin === 'BTC');
  const loadedBtc = await source.loadShard({ shardId: btc.shardId, pageRows: 127 });
  assert.equal(loadedBtc.marketDay.support.CANDLES.state, 'COMPLETE');
  assert.equal(loadedBtc.marketDay.support.CANDLES.observedCount, 1_440);
  assert.equal(loadedBtc.marketDay.expectedCivilDayMinutes, 1_440);
  loadedEth.release(); loadedBtc.release(); source.close();
});

test('delisting retains only the exact pre-delisting membership interval without a full-day claim', { timeout: 45_000 }, async () => {
  const rootDir = await archiveDay('delisting');
  const source = await openDailyBroadMembershipShardSource({ rootDir, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
  const eth = source.descriptor.shards.find((row) => row.market.canonicalCoin === 'ETH');
  assert.equal(eth.expectedRows, 720);
  assert.equal(eth.membershipIntervals[0].startTs, DAY);
  assert.equal(eth.membershipIntervals.at(-1).endTs, DAY + 720 * MINUTE);
  const loaded = await source.loadShard({ shardId: eth.shardId, pageRows: 256 });
  assert.equal(loaded.marketDay.candles[0].periodStartTs, DAY);
  assert.equal(loaded.marketDay.candles.at(-1).periodEndTs, DAY + 720 * MINUTE);
  assert.equal(loaded.marketDay.membershipCoverage, 'PARTIAL_CIVIL_DAY_COMPLETE_FOR_MEMBERSHIP');
  assert.equal(loaded.marketDay.learningEligible, false);
  assert.equal(loaded.marketDay.simulationCredit, 0);
  loaded.release(); source.close();
});

test('same-canonical rename and mid-minute backdating gaps refuse the whole membership source', { timeout: 45_000 }, async () => {
  const renameRoot = await archiveDay('rename');
  await assert.rejects(
    openDailyBroadMembershipShardSource({ rootDir: renameRoot, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE }),
    { code: 'CATALOG_IDENTITY_CHURN_UNREPRESENTABLE' },
  );

  const midMinuteRoot = await archiveDay('listing', { boundaryOffsetMs: 30_000 });
  await assert.rejects(
    openDailyBroadMembershipShardSource({ rootDir: midMinuteRoot, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE }),
    { code: 'MEMBERSHIP_SHARD_INCOMPLETE' },
  );
});
