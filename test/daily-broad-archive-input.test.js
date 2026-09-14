import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordError, broadKrakenRecordIdOf,
} from '../market-lab/broad-kraken.js';
import { BROAD_DAY_ARCHIVE_VERSION_V2, openBroadDayArchive } from '../market-lab/broad-day-archive.js';
import {
  BROAD_DAY_DATASET_VERSION, BROAD_DAY_MARKET_PAGE_VERSION,
  BROAD_DAY_PAGE_VERSION, openBroadDayReader,
} from '../market-lab/broad-day-reader.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import {
  DAILY_BROAD_ARCHIVE_READER_CONTRACT,
  prepareDailyBroadArchiveInput as prepareDailyBroadArchiveInputImpl,
} from '../learning/daily-broad-archive-input.js';
import {
  buildDailyMoveStudy, dailyMoveStudyManifestError, sealDailyMoveStudyManifestV2,
} from '../learning/daily-move-study.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 8, 13, 4); // midnight America/New_York (EDT)
const END = START + 24 * HOUR;
const roots = [];
const prepareDailyBroadArchiveInput = (options) => prepareDailyBroadArchiveInputImpl({ ...options, openBroadDayReader });
const makeRoot = (name) => {
  const root = mkdtempSync(path.join(tmpdir(), `daily-broad-v2-${name}-`)); roots.push(root); return root;
};
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('the learning-side closed reader contract stays byte-exact with the actual injected reader', () => {
  assert.deepEqual(DAILY_BROAD_ARCHIVE_READER_CONTRACT, {
    archiveVersion: BROAD_DAY_ARCHIVE_VERSION_V2,
    datasetVersion: BROAD_DAY_DATASET_VERSION,
    pageVersion: BROAD_DAY_PAGE_VERSION,
    marketPageVersion: BROAD_DAY_MARKET_PAGE_VERSION,
  });
});

test('archive input refuses a missing or malformed injected reader before accepting source claims', async () => {
  const common = { rootDir: 'unused', dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE };
  const missing = await prepareDailyBroadArchiveInputImpl(common);
  assert.equal(missing.code, 'READER_FACTORY_REQUIRED');
  let closed = 0;
  const malformed = await prepareDailyBroadArchiveInputImpl({
    ...common,
    openBroadDayReader: async () => ({ descriptor: {}, close: () => { closed += 1; } }),
  });
  assert.equal(malformed.code, 'READER_PORT_INVALID');
  assert.equal(closed, 1, 'a malformed returned reader with a close method is still closed exactly once');
});

const PAIRS = Object.freeze({
  ADAUSD: { wsname: 'ADA/USD', base: 'ADA', quote: 'USD', status: 'online' },
  XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
  XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' },
  SOLUSD: { wsname: 'SOL/USD', base: 'SOL', quote: 'USD', status: 'online' },
});

function catalogAt(observedTs, pairs = PAIRS) {
  const normalized = normalizeKrakenAssetPairs(pairs, { observedTs });
  assert.equal(normalized.ok, true); return normalized.catalog;
}

function marketOf(catalog, coin) {
  const market = catalog.markets.find((row) => row.base === coin);
  assert.ok(market, `missing ${coin} fixture market`);
  return {
    canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
    catalogWsname: market.wsname, wsSymbol: market.wsname,
  };
}

function closeFor(coin, minute) {
  if (coin === 'BTC') return minute < 60 ? 100 : minute < 70 ? 110 : 90; // >8%, then collapses
  if (coin === 'ETH') return minute < 60 ? 100 : minute < 70 ? 106 : 100; // failed breakout
  if (coin === 'SOL') return minute < 60 ? 100 : 90; // falling control
  return 100; // flat control
}

function closedCandle(catalog, coin, minute, sequence) {
  const periodStartTs = START + minute * MINUTE;
  const receivedTs = periodStartTs + MINUTE + 500;
  const close = closeFor(coin, minute);
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null,
    sessionId: 'daily-adapter-v2-source', sequence, recordType: 'OHLC', recordedTs: receivedTs + 10,
    catalogContentId: catalog.contentId, epochId: 'daily-adapter-v2-epoch', market: marketOf(catalog, coin),
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null, receivedTs,
    periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: {
      volumeBase: coin === 'BTC' ? 4 : 2, trades: 3, vwap: close, close, low: close, high: close, open: close,
      learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record);
  assert.equal(broadKrakenRecordError(record), null);
  return Object.freeze(record);
}

async function buildStableArchive(name, { stopMinute = 1_440, finalize = true } = {}) {
  const root = makeRoot(name); let now = START - MINUTE; let sequence = 0;
  let catalog = catalogAt(now);
  const archive = openBroadDayArchive({
    rootDir: root, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now,
    limits: { maxQueueRows: 10_000, maxQueueBytes: 64 * 1024 * 1024, fsyncEveryEntries: 512 },
  });
  assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
  for (let minute = 0; minute < stopMinute; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = START + minute * MINUTE + 520; catalog = catalogAt(now);
      assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    }
    for (const coin of ['ADA', 'BTC', 'ETH', 'SOL']) {
      const record = closedCandle(catalog, coin, minute, ++sequence); now = record.recordedTs;
      const admitted = archive.tryAcceptRecord(record);
      assert.equal(admitted.accepted, true, `${coin}/${minute}: ${admitted.code}`);
    }
    if (minute > 0 && minute % 240 === 0) await archive.drain();
  }
  if (finalize) {
    now = END + 520; catalog = catalogAt(now);
    assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now }).accepted, true);
    assert.equal(archive.finalize({ cutoffTs: now }).accepted, true);
  }
  await archive.close();
  return root;
}

test('verified writer to reader to v2 manifest retains the full denominator and surge-then-collapse controls', { timeout: 45_000 }, async () => {
  const root = await buildStableArchive('complete');
  const prepared = await prepareDailyBroadArchiveInput({
    rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { pageRows: 257 },
  });
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.acceptedCatalogSnapshot.acceptedMarketCount, 4);
  assert.equal(prepared.marketDays.length, 4);
  assert.equal(prepared.diagnostics.rows, 4 * 1_440);
  assert.equal(prepared.diagnostics.fullDetailClaimed, false);
  assert.equal(prepared.manifestCatalogProvenance.provenanceVerified, true);
  assert.equal(prepared.manifestCatalogProvenance.durability, 'LOCAL_FILESYSTEM_ONLY');
  assert.equal(prepared.manifestCatalogProvenance.republishSafe, false);
  for (const day of prepared.marketDays) {
    assert.equal(day.candles.length, 1_440);
    assert.equal(day.support.CANDLES.state, 'COMPLETE');
    assert.equal(day.support.BASE_VOLUME.state, 'COMPLETE');
    assert.equal(day.support.QUOTE_VOLUME.state, 'UNSUPPORTED');
    assert.ok(day.candles.every((row) => row.volumeQuote === null && row.knownAtTs <= END + MINUTE));
  }

  const manifest = sealDailyMoveStudyManifestV2({
    createdTs: END + MINUTE, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot,
    catalogProvenance: prepared.manifestCatalogProvenance,
  });
  assert.equal(dailyMoveStudyManifestError(manifest), null);
  const study = buildDailyMoveStudy({
    manifest, acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot, marketDays: prepared.marketDays,
  });
  assert.equal(study.counters.acceptedMarketDays, 4);
  assert.equal(study.counters.exclusiveDispositionRows, 4);
  assert.equal(study.counters.dispositions.SURGE_CASE, 1);
  assert.equal(study.counters.dispositions.FAILED_BREAKOUT_CONTROL, 1);
  assert.equal(study.counters.dispositions.FALLING_CONTROL, 1);
  assert.equal(study.counters.dispositions.FLAT_CONTROL, 1);
  assert.equal(study.counters.attemptedSimulations, 0);
  assert.equal(study.counters.completedSimulations, 0);
  assert.equal(study.counters.validSimulationOutcomes, 0);
  const surge = study.cases.find((row) => row.retrospectiveLabels.disposition === 'SURGE_CASE');
  assert.equal(surge.market.canonicalCoin, 'BTC');
  assert.ok(surge.retrospectiveLabels.bestOrderedRise.movePct > 8);
  assert.ok(surge.retrospectiveLabels.bestOrderedDecline.movePct > 8);
  assert.ok(surge.retrospectiveReplay.decisionFrames.every((frame) => frame.knownAtCeilingTs <= frame.decisionTs));
  assert.match(study.laws.denominator, /VERIFIED LOCAL V2 ARCHIVE/);
  assert.match(study.laws.catalogProvenance, /republishSafe=false/);
});

test('incomplete custody, cancellation and hard row bounds refuse the whole archive input', { timeout: 30_000 }, async () => {
  const incompleteRoot = await buildStableArchive('incomplete', { stopMinute: 1, finalize: false });
  const incomplete = await prepareDailyBroadArchiveInput({
    rootDir: incompleteRoot, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
  });
  assert.deepEqual({ ok: incomplete.ok, code: incomplete.code }, { ok: false, code: 'DATASET_PROOF_INCOMPLETE' });

  const completeRoot = await buildStableArchive('bounds');
  const bounded = await prepareDailyBroadArchiveInput({
    rootDir: completeRoot, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    limits: { maxRows: 5_759 },
  });
  assert.deepEqual({ ok: bounded.ok, code: bounded.code }, { ok: false, code: 'ROW_LIMIT' });
  const controller = new AbortController(); controller.abort();
  const cancelled = await prepareDailyBroadArchiveInput({
    rootDir: completeRoot, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE,
    signal: controller.signal,
  });
  assert.equal(cancelled.ok, false);
  assert.ok(['READER_CANCELLED', 'READER_ARGUMENT_INVALID', 'INPUT_CANCELLED'].includes(cancelled.code));
});

test('manifest v2 content identity rejects post-seal local archive provenance alteration', async () => {
  const root = await buildStableArchive('manifest');
  const prepared = await prepareDailyBroadArchiveInput({ rootDir: root, dayStartTs: START, dayEndTs: END, asOfTs: END + MINUTE });
  assert.equal(prepared.ok, true);
  const manifest = sealDailyMoveStudyManifestV2({
    createdTs: END + MINUTE, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot,
    catalogProvenance: prepared.manifestCatalogProvenance,
  });
  const forged = JSON.parse(JSON.stringify(manifest));
  forged.catalogProvenance.sourceDatasetDigest = '0'.repeat(64);
  forged.catalogProvenance.sourceDatasetId = `bdd-${'0'.repeat(64)}`;
  assert.match(dailyMoveStudyManifestError(forged), /content identity forged/);
});
