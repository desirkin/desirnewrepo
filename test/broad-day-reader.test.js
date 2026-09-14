import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openBroadDayArchive } from '../market-lab/broad-day-archive.js';
import {
  BROAD_DAY_CURSOR_VERSION,
  BROAD_DAY_DATASET_VERSION,
  BroadDayReaderError,
  openBroadDayReader,
} from '../market-lab/broad-day-reader.js';
import { BROAD_KRAKEN_RECORD_VERSION } from '../market-lab/broad-kraken.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = Date.parse('2026-09-13T00:00:00.000Z');
const END = DAY + 24 * HOUR;
const roots = [];
const makeRoot = (name) => {
  const root = mkdtempSync(path.join(tmpdir(), `broad-reader-${name}-`)); roots.push(root); return root;
};
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function catalogAt(observedTs, { eth = false, alternateBtcKey = false } = {}) {
  const btcKey = alternateBtcKey ? 'ALT_XBT_USD' : 'XXBTZUSD';
  const raw = {
    [btcKey]: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' },
    ...(eth ? { XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' } } : {}),
  };
  const normalized = normalizeKrakenAssetPairs(raw, { observedTs });
  assert.equal(normalized.ok, true);
  return normalized.catalog;
}

function marketOf(catalog, coin = 'BTC') {
  const market = catalog.markets.find((row) => row.base === coin);
  return {
    canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
    catalogWsname: market.wsname, wsSymbol: market.wsname,
  };
}

function seal(body, { sequence = 1, sessionId = 'source-session', recordedTs = body.receivedTs + 10 } = {}) {
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION, recordId: null, sessionId, sequence,
    recordType: body.recordType, recordedTs, catalogContentId: body.catalogContentId,
    epochId: body.epochId ?? 'source-epoch', market: body.market, channel: body.channel,
    quality: body.quality, sourceEventTs: null, receivedTs: body.receivedTs,
    periodStartTs: body.periodStartTs ?? null, periodEndTs: body.periodEndTs ?? null,
    payload: body.payload,
  };
  record.recordId = `bkr-${hash(record)}`;
  return Object.freeze(record);
}

function closed(catalog, {
  coin = 'BTC', periodStartTs = DAY, sequence = 1, close = 101,
  receivedTs = periodStartTs + MINUTE + 500, recordedTs = receivedTs + 10,
} = {}) {
  return seal({
    recordType: 'OHLC', catalogContentId: catalog.contentId, market: marketOf(catalog, coin),
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', receivedTs,
    periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: {
      messageType: 'closed', finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL',
      sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME', learningEligible: false,
      open: 100, high: Math.max(102, close), low: 99, close,
      vwap: 100.5, trades: 3, volumeBase: 4,
    },
  }, { sequence, recordedTs });
}

async function writeArchive(root, build) {
  let now = DAY - MINUTE;
  const archive = openBroadDayArchive({ rootDir: root, clock: () => now, limits: { fsyncEveryEntries: 1 } });
  const clock = {
    get: () => now,
    set: (value) => { now = value; },
  };
  await build(archive, clock);
  await archive.close();
  return archive.status();
}

function onlyShard(root) {
  const session = readdirSync(path.join(root, 'sessions'))[0];
  const dir = path.join(root, 'sessions', session, 'shards');
  const file = readdirSync(dir)[0];
  return path.join(dir, file);
}

test('actual writer roundtrip builds an immutable observed catalog-epoch union and restart-safe bounded pages without full-day overclaim', async () => {
  const root = makeRoot('epochs');
  const firstCatalog = catalogAt(DAY - 2 * MINUTE);
  const secondCatalog = catalogAt(DAY + MINUTE, { eth: true });
  await writeArchive(root, async (archive, clock) => {
    assert.equal(archive.tryAcceptCatalog({ catalog: firstCatalog, sourceObservedTs: firstCatalog.observedTs, knownAtTs: DAY - MINUTE }).accepted, true);
    clock.set(DAY + MINUTE + 1_000);
    assert.equal(archive.tryAcceptRecord(closed(firstCatalog, { periodStartTs: DAY, sequence: 1 })).accepted, true);
    clock.set(DAY + 2 * MINUTE);
    assert.equal(archive.tryAcceptCatalog({ catalog: secondCatalog, sourceObservedTs: secondCatalog.observedTs, knownAtTs: DAY + 2 * MINUTE }).accepted, true);
    clock.set(DAY + 3 * MINUTE + 1_000);
    assert.equal(archive.tryAcceptRecord(closed(secondCatalog, { periodStartTs: DAY + 2 * MINUTE, sequence: 2 })).accepted, true);
    assert.equal(archive.tryAcceptRecord(closed(secondCatalog, { coin: 'ETH', periodStartTs: DAY + 2 * MINUTE, sequence: 3 })).accepted, true);
    await archive.drain();
  });

  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + HOUR });
  const descriptor = reader.descriptor;
  assert.equal(descriptor.datasetVersion, BROAD_DAY_DATASET_VERSION);
  assert.match(descriptor.datasetId, /^bdd-[a-f0-9]{64}$/);
  assert.equal(descriptor.catalogEpochs.length, 2);
  assert.equal(descriptor.catalogUnion.length, 2);
  assert.equal(descriptor.counters.civilDayRows, 3);
  assert.equal(descriptor.counters.asOfEligibleCivilDayRows, 3);
  assert.equal(descriptor.completeness.physicalControlAndShardIntegrityVerified, true);
  assert.equal(descriptor.completeness.observedCatalogEpochUnionConstructed, true);
  assert.equal(descriptor.completeness.catalogEpochContinuityVerified, false);
  assert.equal(descriptor.completeness.sessionFinalizationVerified, false);
  assert.equal(descriptor.completeness.fullDaySimulationReady, false);
  assert.equal(descriptor.learningEligible, false);
  assert.equal(descriptor.simulationCredit, 0);
  assert.ok(descriptor.completeness.reasons.includes('CANDLE_GRID_INCOMPLETE'));

  const first = await reader.readPage({ maxRows: 2 });
  assert.equal(first.rows.length, 2); assert.equal(first.done, false);
  assert.equal(first.nextCursor.cursorVersion, BROAD_DAY_CURSOR_VERSION);
  assert.ok(first.rows.every((row) => row.recordIntegrityVerified && row.fullDaySimulationEligible === false));
  reader.close();
  const reopened = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + HOUR });
  assert.equal(reopened.descriptor.datasetDigest, descriptor.datasetDigest);
  const second = await reopened.readPage({ cursor: first.nextCursor, maxRows: 2 });
  assert.equal(second.rows.length, 1); assert.equal(second.done, true);
  assert.equal(second.nextCursor.emittedRows, 3);
  const allIds = new Set([...first.rows, ...second.rows].map((row) => row.recordId));
  assert.equal(allIds.size, 3);
  reopened.close();
});

test('exact replay stays one physical row while a same-minute conflict remains explicit and earns no valid full-day input claim', async () => {
  const root = makeRoot('conflict'); const catalog = catalogAt(DAY - MINUTE);
  await writeArchive(root, async (archive, clock) => {
    archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: catalog.observedTs });
    const one = closed(catalog, { periodStartTs: DAY, close: 101 });
    clock.set(one.recordedTs + 10);
    assert.equal(archive.tryAcceptRecord(one).accepted, true);
    assert.equal(archive.tryAcceptRecord(one).code, 'IDEMPOTENT');
    const conflict = closed(catalog, { periodStartTs: DAY, close: 103, sequence: 2, recordedTs: one.recordedTs + 1 });
    assert.equal(archive.tryAcceptRecord(conflict).conflict, true);
    await archive.drain();
  });
  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END });
  assert.equal(reader.descriptor.counters.candleRows, 2);
  assert.equal(reader.descriptor.coverage[0].gridState, 'CONFLICT');
  assert.equal(reader.descriptor.coverage[0].conflictMinutes, 1);
  assert.equal(reader.descriptor.coverage[0].fullDaySimulationEligible, false);
  const page = await reader.readPage({ maxRows: 10 });
  assert.equal(page.rows.length, 2);
  assert.deepEqual(page.rows.map((row) => row.conflict), [false, true]);
  assert.deepEqual(page.rows.map((row) => row.conflictFree), [true, false]);
  reader.close();
});

test('an exact source record re-archived by a later writer session remains one logical candle', async () => {
  const root = makeRoot('cross-session-duplicate'); const catalog = catalogAt(DAY - MINUTE);
  const row = closed(catalog, { periodStartTs: DAY, close: 101 });
  for (let session = 0; session < 2; session += 1) {
    await writeArchive(root, async (archive, clock) => {
      assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: catalog.observedTs }).accepted, true);
      clock.set(row.recordedTs + 10 + session);
      assert.equal(archive.tryAcceptRecord(row).accepted, true);
      await archive.drain();
    });
  }
  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END });
  assert.equal(reader.descriptor.counters.candleRows, 2);
  assert.equal(reader.descriptor.counters.exactDuplicateCandleRows, 1);
  assert.equal(reader.descriptor.counters.asOfEligibleCivilDayRows, 1);
  assert.equal(reader.descriptor.coverage[0].physicalRows, 2);
  assert.equal(reader.descriptor.coverage[0].exactDuplicateRows, 1);
  assert.equal(reader.descriptor.coverage[0].asOfEligibleRows, 1);
  assert.equal(reader.descriptor.coverage[0].conflictMinutes, 0);
  const page = await reader.readPage({ maxRows: 10 });
  assert.equal(page.rows.length, 1); assert.equal(page.rows[0].recordId, row.recordId);
  reader.close();
});

test('future-admitted catalog membership and candles are withheld from the as-of dataset instead of leaking backward', async () => {
  const root = makeRoot('asof'); const first = catalogAt(DAY - MINUTE);
  const future = catalogAt(END + 10 * MINUTE, { eth: true });
  await writeArchive(root, async (archive, clock) => {
    archive.tryAcceptCatalog({ catalog: first, sourceObservedTs: first.observedTs, knownAtTs: first.observedTs });
    clock.set(END + 10 * MINUTE);
    archive.tryAcceptCatalog({ catalog: future, sourceObservedTs: future.observedTs, knownAtTs: END + 10 * MINUTE });
    const late = closed(future, {
      coin: 'ETH', periodStartTs: END - MINUTE, sequence: 1,
      receivedTs: END + 11 * MINUTE, recordedTs: END + 11 * MINUTE + 10,
    });
    clock.set(late.recordedTs + 1); archive.tryAcceptRecord(late); await archive.drain();
  });
  const reader = await openBroadDayReader({
    rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END + 5 * MINUTE,
  });
  assert.equal(reader.descriptor.catalogEpochs.length, 1);
  assert.equal(reader.descriptor.catalogUnion.length, 1);
  assert.equal(reader.descriptor.catalogUnion[0].market.canonicalCoin, 'BTC');
  assert.equal(reader.descriptor.counters.futureCatalogControlsWithheld, 1);
  assert.equal(reader.descriptor.counters.futureAdmissionWithheldRows, 1);
  const page = await reader.readPage({ maxRows: 10 });
  assert.equal(page.rows.length, 0); assert.equal(page.done, true);
  reader.close();
});

test('catalog identity changes are distinct union members and never silently merge by canonical coin', async () => {
  const root = makeRoot('identity-change');
  const original = catalogAt(DAY - MINUTE); const changed = catalogAt(DAY + MINUTE, { alternateBtcKey: true });
  await writeArchive(root, async (archive, clock) => {
    archive.tryAcceptCatalog({ catalog: original, sourceObservedTs: original.observedTs, knownAtTs: original.observedTs });
    clock.set(DAY + 2 * MINUTE);
    archive.tryAcceptCatalog({ catalog: changed, sourceObservedTs: changed.observedTs, knownAtTs: DAY + 2 * MINUTE });
    await archive.drain();
  });
  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END });
  assert.equal(reader.descriptor.catalogUnion.length, 2);
  assert.equal(new Set(reader.descriptor.catalogUnion.map((row) => row.market.canonicalCoin)).size, 1);
  assert.equal(reader.descriptor.counters.canonicalCoinsWithIdentityChanges, 1);
  assert.ok(reader.descriptor.completeness.reasons.includes('CANONICAL_COIN_IDENTITY_CHANGED_ACROSS_OBSERVED_CATALOG_EPOCHS'));
  assert.ok(reader.descriptor.coverage.every((row) => row.catalogIdentitySiblingCount === 2 && row.fullDaySimulationEligible === false));
  reader.close();
});

test('missing, truncated and byte-corrupt chunks refuse the whole immutable reader instead of returning a partial prefix', async () => {
  const build = async (name) => {
    const root = makeRoot(name); const catalog = catalogAt(DAY - MINUTE);
    await writeArchive(root, async (archive, clock) => {
      archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: catalog.observedTs });
      const row = closed(catalog); clock.set(row.recordedTs + 10); archive.tryAcceptRecord(row); await archive.drain();
    });
    return root;
  };
  const missing = await build('missing'); unlinkSync(onlyShard(missing));
  await assert.rejects(openBroadDayReader({ rootDir: missing, dayStartTs: DAY, dayEndTs: END, asOfTs: END }), (error) => error.code === 'READER_SHARD_INVENTORY_MISMATCH');

  const truncated = await build('truncated'); appendFileSync(onlyShard(truncated), '{"partial":');
  await assert.rejects(openBroadDayReader({ rootDir: truncated, dayStartTs: DAY, dayEndTs: END, asOfTs: END }), (error) => error.code === 'READER_TRUNCATED_TAIL');

  const corrupt = await build('corrupt'); const file = onlyShard(corrupt);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('"close":101', '"close":102'));
  await assert.rejects(openBroadDayReader({ rootDir: corrupt, dayStartTs: DAY, dayEndTs: END, asOfTs: END }), (error) => ['READER_SHARD_ROW_INVALID', 'READER_SHARD_CONTROL_MISMATCH'].includes(error.code));
});

test('row/byte/page bounds and cursor content identity provide deterministic cancellation and restart fences', async () => {
  const root = makeRoot('bounds'); const catalog = catalogAt(DAY - MINUTE, { eth: true });
  await writeArchive(root, async (archive, clock) => {
    archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: catalog.observedTs });
    for (let i = 0; i < 3; i += 1) {
      const row = closed(catalog, { coin: i === 2 ? 'ETH' : 'BTC', periodStartTs: DAY + i * MINUTE, sequence: i + 1 });
      clock.set(row.recordedTs + 10); archive.tryAcceptRecord(row);
    }
    await archive.drain();
  });
  await assert.rejects(openBroadDayReader({
    rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END,
    limits: { maxTotalBytes: 100 },
  }), (error) => error.code === 'READER_TOTAL_BYTE_LIMIT' || error.code === 'READER_FILE_LIMIT');

  const reader = await openBroadDayReader({
    rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END,
    limits: { maxPageRows: 1 },
  });
  const one = await reader.readPage({ maxRows: 1 });
  assert.equal(one.rows.length, 1); assert.equal(one.done, false);
  const same = await reader.readPage({ maxRows: 1 });
  assert.deepEqual(same, one, 'a page retry from the same cursor is deterministic');
  const forged = structuredClone(one.nextCursor); forged.emittedRows += 1;
  await assert.rejects(reader.readPage({ cursor: forged, maxRows: 1 }), (error) => error.code === 'READER_CURSOR_INVALID');
  const two = await reader.readPage({ cursor: one.nextCursor, maxRows: 1 });
  const three = await reader.readPage({ cursor: two.nextCursor, maxRows: 1 });
  assert.equal(three.done, true); assert.equal(three.nextCursor.emittedRows, 3);
  reader.close();
  await assert.rejects(reader.readPage({ maxRows: 1 }), (error) => error instanceof BroadDayReaderError && error.code === 'READER_CLOSED');
});

test('pre-cancelled construction and page reads refuse without returning partial data', async () => {
  const root = makeRoot('cancel'); const catalog = catalogAt(DAY - MINUTE);
  await writeArchive(root, async (archive, clock) => {
    assert.equal(archive.tryAcceptCatalog({ catalog, sourceObservedTs: catalog.observedTs, knownAtTs: catalog.observedTs }).accepted, true);
    const row = closed(catalog); clock.set(row.recordedTs + 10);
    assert.equal(archive.tryAcceptRecord(row).accepted, true); await archive.drain();
  });
  const construction = new AbortController(); construction.abort();
  await assert.rejects(openBroadDayReader({
    rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END, signal: construction.signal,
  }), (error) => error.code === 'READER_CANCELLED');

  const reader = await openBroadDayReader({ rootDir: root, dayStartTs: DAY, dayEndTs: END, asOfTs: END });
  const paging = new AbortController(); paging.abort();
  await assert.rejects(reader.readPage({ maxRows: 10, signal: paging.signal }), (error) => error.code === 'READER_CANCELLED');
  assert.equal(reader.status().state, 'OPEN');
  const page = await reader.readPage({ maxRows: 10 });
  assert.equal(page.rows.length, 1); assert.equal(page.done, true);
  reader.close();
});
