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
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const MINUTE = 60_000;
const DAY = Date.parse('2026-09-13T00:00:00.000Z');
const END = DAY + 1_440 * MINUTE;
const BOUNDARY_MINUTE = 720;
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(name) {
  const root = mkdtempSync(path.join(tmpdir(), `broad-churn-${name}-`));
  roots.push(root);
  return root;
}

function catalogAt(observedTs, { btcKey = 'XXBTZUSD', eth = false } = {}) {
  const normalized = normalizeKrakenAssetPairs({
    [btcKey]: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
    ...(eth ? { XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' } } : {}),
  }, { observedTs });
  assert.equal(normalized.ok, true);
  return normalized.catalog;
}

function candle(catalog, market, periodStartTs, sequence) {
  const recordedTs = periodStartTs + MINUTE;
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2,
    recordId: null,
    sessionId: 'catalog-churn-source-session',
    sequence,
    recordType: 'OHLC',
    recordedTs,
    catalogContentId: catalog.contentId,
    epochId: 'catalog-churn-source-epoch',
    market: {
      canonicalCoin: market.base,
      pairKey: market.pairKey,
      nativeBase: market.nativeBase,
      catalogWsname: market.wsname,
      wsSymbol: market.wsname,
    },
    channel: 'ohlc',
    quality: 'CONSERVATIVE_CLOSED',
    sourceEventTs: null,
    receivedTs: recordedTs,
    periodStartTs,
    periodEndTs: recordedTs,
    payload: {
      volumeBase: 4,
      trades: 3,
      vwap: 100.5,
      close: 101,
      low: 99,
      high: 102,
      open: 100,
      learningEligible: false,
      sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL',
      messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record);
  assert.equal(broadKrakenRecordError(record), null);
  return Object.freeze(record);
}

function shapeFor(mode, afterBoundary) {
  if (mode === 'listing') return { eth: afterBoundary };
  if (mode === 'delisting') return { eth: !afterBoundary };
  if (mode === 'rename') return { btcKey: afterBoundary ? 'XBTUSD' : 'XXBTZUSD' };
  throw new Error(`unknown mode ${mode}`);
}

async function writeChurnDay(name, mode, { boundaryOffsetMs = 0 } = {}) {
  const rootDir = makeRoot(name);
  let now = DAY;
  let sequence = 0;
  const archive = openBroadDayArchive({
    rootDir,
    formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2,
    clock: () => now,
    limits: { fsyncEveryEntries: 4_096 },
  });
  let catalog = catalogAt(now, shapeFor(mode, false));
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);

  for (let minute = 0; minute < 1_440; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = DAY + minute * MINUTE + (minute === BOUNDARY_MINUTE ? boundaryOffsetMs : 0);
      catalog = catalogAt(now, shapeFor(mode, minute >= BOUNDARY_MINUTE));
      assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    }
    for (const market of catalog.markets) {
      const record = candle(catalog, market, DAY + minute * MINUTE, ++sequence);
      now = record.recordedTs;
      assert.equal(archive.tryAcceptRecord(record).accepted, true);
    }
  }

  now = END;
  catalog = catalogAt(now, shapeFor(mode, true));
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  assert.equal(archive.finalize({ cutoffTs: END }).accepted, true);
  await archive.drain();
  await archive.close();
  return openBroadDayReader({ rootDir, dayStartTs: DAY, dayEndTs: END, asOfTs: END + MINUTE });
}

test('exact listing and delisting epochs retain the full accepted population with membership-sized grids', { timeout: 45_000 }, async () => {
  for (const mode of ['listing', 'delisting']) {
    const reader = await writeChurnDay(mode, mode);
    const byCoin = Object.fromEntries(reader.descriptor.coverage.map((row) => [row.market.canonicalCoin, row]));
    assert.equal(reader.descriptor.completeness.physicalControlAndShardIntegrityVerified, true);
    assert.equal(reader.descriptor.completeness.catalogEpochContinuityVerified, true);
    assert.equal(reader.descriptor.completeness.sessionFinalizationVerified, true);
    assert.equal(reader.descriptor.completeness.fullPopulationVerified, true);
    assert.equal(reader.descriptor.completeness.fullDaySimulationReady, true);
    assert.equal(reader.descriptor.counters.observedCatalogUnionMarkets, 2);
    assert.equal(reader.descriptor.counters.canonicalCoinsWithIdentityChanges, 0);
    assert.equal(byCoin.BTC.expectedCatalogMembershipMinutes, 1_440);
    assert.equal(byCoin.BTC.uniqueObservedMinutes, 1_440);
    assert.equal(byCoin.ETH.expectedCatalogMembershipMinutes, 720);
    assert.equal(byCoin.ETH.uniqueObservedMinutes, 720);
    assert.equal(byCoin.ETH.gridState, 'COMPLETE_OBSERVED_GRID');
    reader.close();
  }
});

test('a same-canonical identity rename keeps both complete raw grids but is not simulation compatible', { timeout: 45_000 }, async () => {
  const reader = await writeChurnDay('rename', 'rename');
  const btc = reader.descriptor.coverage.filter((row) => row.market.canonicalCoin === 'BTC');
  assert.equal(btc.length, 2);
  assert.deepEqual(btc.map((row) => row.market.pairKey).sort(), ['XBTUSD', 'XXBTZUSD']);
  assert.ok(btc.every((row) => row.catalogIdentitySiblingCount === 2
    && row.expectedCatalogMembershipMinutes === 720
    && row.uniqueObservedMinutes === 720
    && row.gridState === 'COMPLETE_OBSERVED_GRID'));
  assert.equal(reader.descriptor.completeness.fullPopulationVerified, true);
  assert.equal(reader.descriptor.counters.completeObservedMinuteGrids, 2);
  assert.equal(reader.descriptor.counters.canonicalCoinsWithIdentityChanges, 1);
  assert.ok(reader.descriptor.completeness.reasons.includes('CANONICAL_COIN_IDENTITY_CHANGED_ACROSS_OBSERVED_CATALOG_EPOCHS'));
  assert.equal(reader.descriptor.completeness.fullDaySimulationReady, false);
  reader.close();
});

test('a catalog learned mid-minute cannot backdate membership or make the boundary grid complete', { timeout: 45_000 }, async () => {
  const reader = await writeChurnDay('mid-minute', 'rename', { boundaryOffsetMs: 30_000 });
  const btc = reader.descriptor.coverage.filter((row) => row.market.canonicalCoin === 'BTC');
  const oldIdentity = btc.find((row) => row.market.pairKey === 'XXBTZUSD');
  const newIdentity = btc.find((row) => row.market.pairKey === 'XBTUSD');
  assert.equal(oldIdentity.expectedCatalogMembershipMinutes, 721);
  assert.equal(oldIdentity.uniqueObservedMinutes, 720);
  assert.equal(oldIdentity.missingMinutes, 1);
  assert.equal(oldIdentity.gridState, 'PARTIAL');
  assert.equal(newIdentity.expectedCatalogMembershipMinutes, 719);
  assert.equal(newIdentity.uniqueObservedMinutes, 719);
  assert.equal(newIdentity.futureAdmissionWithheldRows, 1);
  assert.equal(reader.descriptor.counters.catalogAsOfWithheldRows, 1);
  assert.equal(reader.descriptor.completeness.fullPopulationVerified, true);
  assert.equal(reader.descriptor.completeness.fullDaySimulationReady, false);
  assert.ok(reader.descriptor.completeness.reasons.includes('CANDLE_CATALOG_MEMBERSHIP_NOT_KNOWN_AT_PERIOD_START'));
  reader.close();
});
