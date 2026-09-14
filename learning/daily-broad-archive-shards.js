// Versioned, bounded per-market view of one verified local broad-day v2
// dataset. Construction seals the complete denominator before any shard is
// consumed. Each read holds at most one market-day in memory; no method grants
// learning, simulation, Judge, or order authority.
import {
  BROAD_DAY_MARKET_PAGE_VERSION, openBroadDayReader,
} from '../market-lab/broad-day-reader.js';
import {
  DAILY_BROAD_ARCHIVE_PROVENANCE_VERSION,
  dailyBroadArchiveCandleFromRow, dailyBroadArchiveDescriptorError,
  dailyBroadArchiveRowError, sealDailyBroadArchiveCatalog,
  sealDailyBroadArchiveProvenance,
} from './daily-broad-archive-input.js';
import { canonicalDigest, deepFreeze } from './shadow-contracts.js';
import { marketIdentityDigest } from './shadow-catalog-snapshot.js';

export const DAILY_BROAD_ARCHIVE_SHARD_SOURCE_VERSION = 'daily-broad-archive-shard-source-1';
export const DAILY_BROAD_ARCHIVE_SHARD_DATASET_VERSION = 'daily-broad-archive-shard-dataset-1';
export const DAILY_BROAD_ARCHIVE_MARKET_SHARD_VERSION = 'daily-broad-archive-market-shard-1';
export const DAILY_BROAD_ARCHIVE_SHARD_PAGE_VERSION = 'daily-broad-archive-shard-page-1';
export const DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION = 'daily-broad-archive-market-day-1';
export const DAILY_BROAD_ARCHIVE_SHARD_LIMITS = Object.freeze({
  maxMarkets: 5_000, maxRowsPerMarket: 1_500, maxPagesPerMarket: 128,
  pageRows: 512, maxMaterializedBytesPerMarket: 4 * 1024 * 1024,
});
const HARD = Object.freeze({
  maxMarkets: 5_000, maxRowsPerMarket: 2_000, maxPagesPerMarket: 2_000,
  pageRows: 5_000, maxMaterializedBytesPerMarket: 16 * 1024 * 1024,
});
const HEX64 = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const absent = (state, reason) => ({
  state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
  gapCount: 0, sourceDigests: [], reason,
});
const complete = (count, start, end, digest) => ({
  state: 'COMPLETE', observedCount: count, coverageStartTs: start,
  coverageEndTs: end, gapCount: 0, sourceDigests: [digest], reason: null,
});
const RECEIPT_KEYS = Object.freeze([
  'receiptVersion', 'receiptDigest', 'datasetId', 'datasetDigest', 'shardId',
  'shardDigest', 'marketIdentityDigest', 'marketDayDigest', 'rowCount',
  'serializedCandleBytes', 'pages', 'byteBasis', 'authority', 'learningEligible',
  'simulationCredit',
]);

function limitsOf(input) {
  if (input !== undefined && !plain(input)) throw fail('SHARD_LIMITS_INVALID', 'limits must be an object');
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in DAILY_BROAD_ARCHIVE_SHARD_LIMITS));
  if (unknown.length) throw fail('SHARD_LIMITS_INVALID', `unknown limits: ${unknown.join(',')}`);
  const out = { ...DAILY_BROAD_ARCHIVE_SHARD_LIMITS, ...(input ?? {}) };
  for (const [key, ceiling] of Object.entries(HARD)) {
    if (!positive(out[key]) || out[key] > ceiling) throw fail('SHARD_LIMITS_INVALID', `${key} exceeds its hard bound`);
  }
  return Object.freeze(out);
}

const shardBody = (value) => ({
  shardVersion: value.shardVersion, sourceDatasetId: value.sourceDatasetId,
  sourceDatasetDigest: value.sourceDatasetDigest, shardIndex: value.shardIndex,
  sourceMarketIdentityDigest: value.sourceMarketIdentityDigest,
  marketIdentityDigest: value.marketIdentityDigest, market: value.market,
  expectedRows: value.expectedRows, expectedCatalogMembershipMinutes: value.expectedCatalogMembershipMinutes,
  sourceSessions: value.sourceSessions, sourceCatalogControls: value.sourceCatalogControls,
});

const receiptDigestBody = (value) => ({
  receiptVersion: value.receiptVersion, datasetId: value.datasetId,
  datasetDigest: value.datasetDigest, shardId: value.shardId,
  shardDigest: value.shardDigest, marketIdentityDigest: value.marketIdentityDigest,
  marketDayDigest: value.marketDayDigest, rowCount: value.rowCount,
  authority: value.authority, learningEligible: value.learningEligible,
  simulationCredit: value.simulationCredit,
});

export function dailyBroadArchiveMarketDayReceiptError(value, { descriptor = null, shard = null, marketDay = null } = {}) {
  if (!plain(value) || Object.keys(value).length !== RECEIPT_KEYS.length
      || RECEIPT_KEYS.some((key) => !Object.hasOwn(value, key))) return 'market-day receipt shape malformed';
  if (value.receiptVersion !== DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION
      || !HEX64.test(value.receiptDigest ?? '') || !HEX64.test(value.datasetDigest ?? '')
      || !HEX64.test(value.shardDigest ?? '') || !HEX64.test(value.marketIdentityDigest ?? '')
      || !HEX64.test(value.marketDayDigest ?? '') || typeof value.datasetId !== 'string'
      || typeof value.shardId !== 'string' || !positive(value.rowCount)
      || !positive(value.serializedCandleBytes) || !positive(value.pages)
      || value.byteBasis !== 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD'
      || value.authority !== 'NONE' || value.learningEligible !== false || value.simulationCredit !== 0
      || value.receiptDigest !== canonicalDigest(receiptDigestBody(value))) return 'market-day receipt identity or fields malformed';
  if (descriptor && (value.datasetId !== descriptor.datasetId || value.datasetDigest !== descriptor.datasetDigest)) return 'market-day receipt dataset mismatch';
  if (shard && (value.shardId !== shard.shardId || value.shardDigest !== shard.shardDigest
      || value.marketIdentityDigest !== shard.marketIdentityDigest || value.rowCount !== shard.expectedRows)) return 'market-day receipt shard mismatch';
  if (marketDay && (value.marketDayDigest !== canonicalDigest(marketDay)
      || value.marketIdentityDigest !== marketDay.marketIdentityDigest)) return 'market-day receipt content mismatch';
  return null;
}

function marketDayOf({ shard, candles, dayStartTs, dayEndTs }) {
  const sourceDigest = canonicalDigest({
    provenanceVersion: DAILY_BROAD_ARCHIVE_PROVENANCE_VERSION,
    sourceDatasetDigest: shard.sourceDatasetDigest,
    marketIdentityDigest: shard.marketIdentityDigest,
    recordDigests: candles.map((row) => row.sourceDigest),
  });
  const support = {
    PRICE: absent('MISSING', 'BROAD_DAY_ARCHIVE_EXCLUDES_TICKER_HISTORY'),
    CANDLES: complete(candles.length, dayStartTs, dayEndTs, sourceDigest),
    BASE_VOLUME: complete(candles.length, dayStartTs, dayEndTs, sourceDigest),
    QUOTE_VOLUME: absent('UNSUPPORTED', 'VENUE_QUOTE_VOLUME_NOT_REPORTED;VWAP_TIMES_BASE_NOT_RELABELED_AS_OBSERVED_QUOTE_VOLUME'),
    TRADES: absent('UNSUPPORTED', 'AGGREGATE_CANDLE_TRADE_COUNT_IS_NOT_RAW_TRADE_EVIDENCE'),
    TRADE_FLOW: absent('UNSUPPORTED', 'RAW_TRADE_DIRECTION_NOT_ARCHIVED'),
    SPREAD: absent('UNSUPPORTED', 'ORDER_BOOK_SPREAD_NOT_ARCHIVED'),
    DEPTH: absent('UNSUPPORTED', 'ORDER_BOOK_DEPTH_NOT_ARCHIVED'),
    CATALYST: absent('UNSUPPORTED', 'CATALYST_EVIDENCE_NOT_ARCHIVED_IN_MARKET_CANDLE_SOURCE'),
  };
  return {
    marketIdentityDigest: shard.marketIdentityDigest,
    priceEvents: [], candles, support,
  };
}

export async function openDailyBroadArchiveShardSource({
  rootDir, dayStartTs, dayEndTs, asOfTs, limits: suppliedLimits, readerLimits, signal = null,
} = {}) {
  const limits = limitsOf(suppliedLimits);
  const reader = await openBroadDayReader({ rootDir, dayStartTs, dayEndTs, asOfTs, limits: readerLimits, signal });
  try {
    const sourceDescriptor = reader.descriptor;
    const descriptorError = dailyBroadArchiveDescriptorError(sourceDescriptor, { maxMarkets: limits.maxMarkets });
    if (descriptorError) throw fail(descriptorError.code, descriptorError.message);
    const acceptedCatalogSnapshot = sealDailyBroadArchiveCatalog(sourceDescriptor);
    const catalogProvenance = sealDailyBroadArchiveProvenance(sourceDescriptor, acceptedCatalogSnapshot);
    const sourceUnionByPair = new Map();
    for (const row of sourceDescriptor.catalogUnion) {
      if (sourceUnionByPair.has(row.market.pairKey)) throw fail('SHARD_INVENTORY_INVALID', 'source pair identity is duplicated');
      sourceUnionByPair.set(row.market.pairKey, row);
    }
    const coverageBySource = new Map(sourceDescriptor.coverage.map((row) => [row.marketIdentityDigest, row]));
    const shards = acceptedCatalogSnapshot.markets.map((market, shardIndex) => {
      const source = sourceUnionByPair.get(market.providerAssetId);
      const identity = marketIdentityDigest(market); const coverage = coverageBySource.get(source?.marketIdentityDigest);
      if (!source || source.market.canonicalCoin !== market.canonicalCoin
          || source.market.catalogWsname !== market.nativeSymbol || !coverage
          || coverage.gridState !== 'COMPLETE_OBSERVED_GRID'
          || coverage.uniqueObservedMinutes !== coverage.expectedCatalogMembershipMinutes
          || coverage.expectedCatalogMembershipMinutes !== (dayEndTs - dayStartTs) / 60_000
          || coverage.uniqueObservedMinutes > limits.maxRowsPerMarket) {
        throw fail('SHARD_INVENTORY_INVALID', 'one denominator market lacks an exact bounded full-day source shard');
      }
      const value = {
        shardVersion: DAILY_BROAD_ARCHIVE_MARKET_SHARD_VERSION,
        shardId: '', shardDigest: '', sourceDatasetId: sourceDescriptor.datasetId,
        sourceDatasetDigest: sourceDescriptor.datasetDigest, shardIndex,
        sourceMarketIdentityDigest: source.marketIdentityDigest,
        marketIdentityDigest: identity, market,
        expectedRows: coverage.uniqueObservedMinutes,
        expectedCatalogMembershipMinutes: coverage.expectedCatalogMembershipMinutes,
        sourceSessions: coverage.sessions, sourceCatalogControls: coverage.catalogControls,
      };
      value.shardDigest = canonicalDigest(shardBody(value));
      value.shardId = `dbams-${value.shardDigest}`;
      return value;
    });
    const descriptorBody = {
      datasetVersion: DAILY_BROAD_ARCHIVE_SHARD_DATASET_VERSION,
      sourceDatasetVersion: sourceDescriptor.datasetVersion,
      sourceDatasetId: sourceDescriptor.datasetId,
      sourceDatasetDigest: sourceDescriptor.datasetDigest,
      dayStartTs, dayEndTs, asOfTs,
      acceptedCatalogSnapshot, catalogProvenance,
      shardCount: shards.length,
      expectedRows: shards.reduce((sum, row) => sum + row.expectedRows, 0),
      shards, traversalOrder: 'ACCEPTED_CATALOG_MARKET_IDENTITY_DIGEST_ASCENDING',
      completeness: 'VERIFIED_LOCAL_V2_STABLE_CATALOG_FULL_DAY_SHARD_INVENTORY',
      durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    const datasetDigest = canonicalDigest(descriptorBody);
    const descriptor = deepFreeze({
      ...descriptorBody, datasetDigest, datasetId: `dbasd-${datasetDigest}`,
    });
    const byId = new Map(descriptor.shards.map((row) => [row.shardId, row]));
    let closed = false;

    const readShardPage = async ({ shardId, cursor = null, maxRows = limits.pageRows, signal: pageSignal = null } = {}) => {
      if (closed) throw fail('SHARD_SOURCE_CLOSED', 'source is closed');
      const shard = byId.get(shardId); if (!shard) throw fail('SHARD_NOT_FOUND', 'shardId is absent from the sealed inventory');
      if (!positive(maxRows) || maxRows > limits.pageRows) throw fail('SHARD_PAGE_LIMIT', 'page maxRows exceeds the sealed source bound');
      const sourcePage = await reader.readMarketPage({
        marketIdentityDigest: shard.sourceMarketIdentityDigest, cursor, maxRows, signal: pageSignal,
      });
      const sourceBody = { ...sourcePage }; delete sourceBody.pageDigest;
      if (sourcePage.pageVersion !== BROAD_DAY_MARKET_PAGE_VERSION
          || sourcePage.pageDigest !== canonicalDigest(sourceBody)
          || sourcePage.datasetId !== descriptor.sourceDatasetId
          || sourcePage.datasetDigest !== descriptor.sourceDatasetDigest
          || sourcePage.marketIdentityDigest !== shard.sourceMarketIdentityDigest
          || sourcePage.rowCount !== sourcePage.rows?.length || !Array.isArray(sourcePage.rows)) {
        throw fail('SHARD_PAGE_INTEGRITY_INVALID', 'source market page identity or census mismatch');
      }
      const candles = sourcePage.rows.map((row) => {
        const error = dailyBroadArchiveRowError(row, sourceDescriptor);
        if (error || row.marketIdentityDigest !== shard.sourceMarketIdentityDigest
            || row.market.pairKey !== shard.market.providerAssetId
            || row.market.canonicalCoin !== shard.market.canonicalCoin
            || row.market.catalogWsname !== shard.market.nativeSymbol) {
          throw fail('SHARD_ROW_INVALID', error ?? 'row differs from the sealed shard identity');
        }
        return dailyBroadArchiveCandleFromRow(row);
      });
      const body = {
        pageVersion: DAILY_BROAD_ARCHIVE_SHARD_PAGE_VERSION,
        datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
        shardId: shard.shardId, shardDigest: shard.shardDigest,
        sourceCursor: cursor, nextSourceCursor: sourcePage.nextCursor,
        done: sourcePage.done, rowCount: candles.length, candles,
        authority: 'NONE', learningEligible: false, simulationCredit: 0,
      };
      return deepFreeze({ ...body, pageDigest: canonicalDigest(body) });
    };

    const loadShard = async ({ shardId, pageRows = limits.pageRows, signal: pageSignal = null } = {}) => {
      if (closed) throw fail('SHARD_SOURCE_CLOSED', 'source is closed');
      const shard = byId.get(shardId); if (!shard) throw fail('SHARD_NOT_FOUND', 'shardId is absent from the sealed inventory');
      if (!positive(pageRows) || pageRows > limits.pageRows) throw fail('SHARD_PAGE_LIMIT', 'pageRows exceeds the sealed source bound');
      let cursor = null; let pages = 0; let bytes = 0; const candles = []; const periods = new Set();
      while (true) {
        if (pageSignal?.aborted) throw fail('SHARD_CANCELLED', 'shard load cancelled');
        pages += 1; if (pages > limits.maxPagesPerMarket) throw fail('SHARD_PAGE_LIMIT', 'market page count exceeds bound');
        const page = await readShardPage({ shardId, cursor, maxRows: pageRows, signal: pageSignal });
        for (const candle of page.candles) {
          if (periods.has(candle.periodStartTs)) throw fail('SHARD_DUPLICATE_PERIOD', 'market shard contains a repeated minute');
          periods.add(candle.periodStartTs); candles.push(candle);
          bytes += Buffer.byteLength(JSON.stringify(candle), 'utf8');
          if (candles.length > limits.maxRowsPerMarket || bytes > limits.maxMaterializedBytesPerMarket) {
            throw fail('SHARD_MATERIALIZATION_LIMIT', 'one market shard exceeds its row/byte bound');
          }
        }
        if (page.done) break;
        cursor = page.nextSourceCursor;
      }
      candles.sort((a, b) => a.periodStartTs - b.periodStartTs || a.observationId.localeCompare(b.observationId));
      if (candles.length !== shard.expectedRows
          || candles[0]?.periodStartTs !== dayStartTs
          || candles.at(-1)?.periodEndTs !== dayEndTs
          || candles.some((row, index) => row.periodStartTs !== dayStartTs + index * 60_000)) {
        throw fail('SHARD_GRID_INCOMPLETE', 'loaded shard differs from the sealed full-day minute grid');
      }
      const marketDay = marketDayOf({ shard, candles, dayStartTs, dayEndTs });
      const marketDayDigest = canonicalDigest(marketDay);
      const receipt = {
        receiptVersion: DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION,
        receiptDigest: '',
        datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
        shardId: shard.shardId, shardDigest: shard.shardDigest,
        marketIdentityDigest: shard.marketIdentityDigest, marketDayDigest,
        rowCount: candles.length, serializedCandleBytes: bytes, pages,
        byteBasis: 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD',
        authority: 'NONE', learningEligible: false, simulationCredit: 0,
      };
      receipt.receiptDigest = canonicalDigest(receiptDigestBody(receipt));
      const receiptError = dailyBroadArchiveMarketDayReceiptError(receipt, { descriptor, shard, marketDay });
      if (receiptError) throw fail('SHARD_RECEIPT_INVALID', receiptError);
      // The source retains no market-day cache. The explicit release hook lets
      // bounded runners close the custody interval before advancing progress
      // and gives test sources a deterministic reclamation contract.
      let released = false;
      const release = () => { released = true; return Object.freeze({ released }); };
      return Object.freeze({ marketDay: deepFreeze(marketDay), receipt, release });
    };

    const status = () => deepFreeze({
      sourceVersion: DAILY_BROAD_ARCHIVE_SHARD_SOURCE_VERSION,
      state: closed ? 'CLOSED' : 'OPEN', datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, shardCount: descriptor.shardCount,
      expectedRows: descriptor.expectedRows, durability: descriptor.durability,
      republishSafe: false, authority: 'NONE', learningEligible: false,
    });
    const close = () => { if (!closed) { reader.close(); closed = true; } return status(); };
    return Object.freeze({
      version: DAILY_BROAD_ARCHIVE_SHARD_SOURCE_VERSION,
      descriptor, readShardPage, loadShard, status, close,
    });
  } catch (error) {
    try { reader.close(); } catch { /* preserve construction error */ }
    throw error;
  }
}
