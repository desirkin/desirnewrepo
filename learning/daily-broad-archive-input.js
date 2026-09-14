// Versioned bridge from the verified local broad-day archive v2 reader into
// the existing retrospective daily-study market-day contract. This adapter
// accepts the fixed reader factory from its composition owner. Learning never
// imports the market pipeline; the returned reader and every byte it returns
// are validated against the closed mirrored wire contract below. It remains
// bounded, local-only and authority NONE.
import { canonicalDigest, deepFreeze } from './shadow-contracts.js';
import { marketIdentityDigest, sealAcceptedCatalogSnapshot } from './shadow-catalog-snapshot.js';

export const DAILY_BROAD_ARCHIVE_INPUT_VERSION = 'daily-broad-archive-input-1';
export const DAILY_BROAD_ARCHIVE_PROVENANCE_VERSION = 'daily-broad-archive-provenance-1';
// Mirrored from the v2 archive/reader wire contract. Tests compose the actual
// reader at the caller boundary and prove these literals remain byte-exact.
export const DAILY_BROAD_ARCHIVE_READER_CONTRACT = Object.freeze({
  archiveVersion: 'broad-day-archive-local-v2',
  datasetVersion: 'broad-day-dataset-v1',
  pageVersion: 'broad-day-reader-page-v1',
  marketPageVersion: 'broad-day-market-page-v1',
});
export const DAILY_BROAD_ARCHIVE_LIMITS = Object.freeze({
  maxMarkets: 5_000,
  maxRows: 1_000_000,
  maxPages: 20_000,
  pageRows: 2_000,
  maxMaterializedBytes: 1024 * 1024 * 1024,
});

const HARD = Object.freeze({
  maxMarkets: 5_000, maxRows: 2_000_000, maxPages: 50_000,
  pageRows: 10_000, maxMaterializedBytes: 2 * 1024 * 1024 * 1024,
});
const ROW_KEYS = Object.freeze([
  'rowVersion', 'sessionId', 'shardFile', 'globalOrdinal', 'globalControlDigest',
  'shardOrdinal', 'archiveAdmittedTs', 'asOfEligibleTs', 'recordId', 'recordDigest',
  'catalogContentId', 'marketIdentityDigest', 'market', 'periodStartTs', 'periodEndTs',
  'receivedTs', 'sourceRecordedTs', 'open', 'high', 'low', 'close', 'volumeBase',
  'volumeQuote', 'trades', 'vwap', 'finality', 'conflict', 'recordIntegrityVerified',
  'conflictFree', 'fullDaySimulationEligible',
]);
const MARKET_KEYS = Object.freeze(['canonicalCoin', 'pairKey', 'nativeBase', 'catalogWsname']);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code, message) => deepFreeze({ ok: false, version: DAILY_BROAD_ARCHIVE_INPUT_VERSION, code, message, authority: 'NONE' });

export function dailyBroadArchiveReaderPortError(reader, { method = 'readPage' } = {}) {
  if (!plain(reader) || !plain(reader.descriptor) || typeof reader.close !== 'function'
      || !['readPage', 'readMarketPage'].includes(method) || typeof reader[method] !== 'function') {
    return `reader port requires descriptor, close(), and ${method}()`;
  }
  return null;
}

function normalizeLimits(input) {
  if (input !== undefined && !plain(input)) return null;
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in DAILY_BROAD_ARCHIVE_LIMITS));
  if (unknown.length) return null;
  const value = { ...DAILY_BROAD_ARCHIVE_LIMITS, ...(input ?? {}) };
  for (const [key, ceiling] of Object.entries(HARD)) if (!positive(value[key]) || value[key] > ceiling) return null;
  return value;
}

export function dailyBroadArchiveRowError(row, descriptor) {
  if (!exact(row, ROW_KEYS) || row.rowVersion !== 'broad-day-candle-row-v1'
      || !exact(row.market, MARKET_KEYS) || typeof row.recordId !== 'string' || !/^bkr2-[a-f0-9]{64}$/.test(row.recordId)
      || typeof row.recordDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.recordDigest)
      || typeof row.marketIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.marketIdentityDigest)
      || !positive(row.periodStartTs) || !positive(row.periodEndTs) || row.periodEndTs - row.periodStartTs !== 60_000
      || row.periodStartTs < descriptor.dayStartTs || row.periodEndTs > descriptor.dayEndTs
      || !positive(row.receivedTs) || !positive(row.sourceRecordedTs) || !positive(row.asOfEligibleTs)
      || row.receivedTs < row.periodEndTs || row.sourceRecordedTs < row.receivedTs
      || row.asOfEligibleTs < row.sourceRecordedTs || row.asOfEligibleTs > descriptor.asOfTs
      || ![row.open, row.high, row.low, row.close].every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.high < row.low
      || typeof row.volumeBase !== 'number' || !Number.isFinite(row.volumeBase) || row.volumeBase < 0
      || row.volumeQuote !== null || !Number.isSafeInteger(row.trades) || row.trades < 0
      || row.finality !== 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL' || row.conflict !== false
      || row.recordIntegrityVerified !== true || row.conflictFree !== true
      || row.fullDaySimulationEligible !== false) return 'row envelope, clocks, values, or conservative custody malformed';
  return null;
}

export function dailyBroadArchiveCandleFromRow(row) {
  return {
    observationId: row.recordId, periodStartTs: row.periodStartTs, periodEndTs: row.periodEndTs,
    open: row.open, high: row.high, low: row.low, close: row.close,
    volumeBase: row.volumeBase, volumeQuote: null, closed: true,
    receivedTs: row.receivedTs, knownAtTs: row.asOfEligibleTs, sourceDigest: row.recordDigest,
  };
}

const absent = (state, reason) => ({
  state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
  gapCount: 0, sourceDigests: [], reason,
});

function complete(observedCount, dayStartTs, dayEndTs, sourceDigest) {
  return {
    state: 'COMPLETE', observedCount, coverageStartTs: dayStartTs, coverageEndTs: dayEndTs,
    gapCount: 0, sourceDigests: [sourceDigest], reason: null,
  };
}

export function dailyBroadArchiveDescriptorError(descriptor, { maxMarkets = DAILY_BROAD_ARCHIVE_LIMITS.maxMarkets } = {}) {
  if (!positive(maxMarkets) || maxMarkets > HARD.maxMarkets) return { code: 'INPUT_LIMITS_INVALID', message: 'descriptor market bound malformed' };
  if (descriptor?.datasetVersion !== DAILY_BROAD_ARCHIVE_READER_CONTRACT.datasetVersion
      || descriptor.archiveVersion !== DAILY_BROAD_ARCHIVE_READER_CONTRACT.archiveVersion
      || descriptor.sourceProvenance?.sourceKind !== 'LOCAL_BROAD_DAY_ARCHIVE_V2'
      || descriptor.sourceProvenance?.durability !== 'LOCAL_FILESYSTEM_ONLY'
      || descriptor.sourceProvenance?.republishSafe !== false
      || descriptor.completeness?.physicalControlAndShardIntegrityVerified !== true
      || descriptor.completeness?.sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite !== true
      || descriptor.completeness?.catalogEpochContinuityVerified !== true
      || descriptor.completeness?.sessionFinalizationVerified !== true
      || descriptor.completeness?.fullPopulationVerified !== true
      || descriptor.completeness?.fullDaySimulationReady !== true) {
    return { code: 'DATASET_PROOF_INCOMPLETE', message: 'reader v2 full-day proof is incomplete' };
  }
  if (!Array.isArray(descriptor.catalogUnion) || descriptor.catalogUnion.length < 1
      || descriptor.catalogUnion.length > maxMarkets || !Array.isArray(descriptor.catalogEpochs)
      || !Array.isArray(descriptor.coverage) || descriptor.coverage.length !== descriptor.catalogUnion.length) {
    return { code: 'CATALOG_UNION_INVALID', message: 'catalog union/coverage inventory malformed or over bound' };
  }
  if (new Set(descriptor.catalogEpochs.map((row) => row.catalogContentId)).size !== 1) {
    return { code: 'CATALOG_CHURN_UNREPRESENTABLE', message: 'daily-move-study v1 market days cannot encode per-market membership intervals; no partial union is returned' };
  }
  return null;
}

export function sealDailyBroadArchiveCatalog(descriptor) {
  const firstEpoch = descriptor.catalogEpochs[0];
  return sealAcceptedCatalogSnapshot({
    observedTs: firstEpoch.sourceObservedTs,
    knownAtTs: firstEpoch.membershipKnownSinceTs,
    maxAgeMs: 24 * 60 * 60_000,
    markets: descriptor.catalogUnion.map((row) => ({
      subjectKind: 'MARKET', canonicalCoin: row.market.canonicalCoin,
      providerAssetId: row.market.pairKey, venue: 'kraken',
      nativeSymbol: row.market.catalogWsname, base: row.market.canonicalCoin,
      quote: 'USD', marketType: 'SPOT', quoteAliasGroup: 'USD',
    })),
  });
}

export function sealDailyBroadArchiveProvenance(descriptor, acceptedCatalogSnapshot) {
  const catalogEpochDigest = canonicalDigest(descriptor.catalogEpochs);
  return deepFreeze({
    provenanceVersion: DAILY_BROAD_ARCHIVE_PROVENANCE_VERSION,
    state: 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY', provenanceVerified: true,
    durableFullDayEpochUnionVerified: true,
    sourceDatasetVersion: descriptor.datasetVersion, sourceDatasetId: descriptor.datasetId,
    sourceDatasetDigest: descriptor.datasetDigest, sourceArchiveVersion: descriptor.archiveVersion,
    catalogEpochDigest, catalogUnionContentDigest: acceptedCatalogSnapshot.contentDigest,
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    warning: 'Verified for this retained local archive only; no external/republish durability or prospective qualification is claimed.',
  });
}

export async function prepareDailyBroadArchiveInput({
  rootDir, dayStartTs, dayEndTs, asOfTs, limits: suppliedLimits, readerLimits,
  signal = null, openBroadDayReader,
} = {}) {
  const limits = normalizeLimits(suppliedLimits);
  if (!limits) return fail('INPUT_LIMITS_INVALID', 'adapter limits are malformed or exceed the hard ceiling');
  if (typeof openBroadDayReader !== 'function') return fail('READER_FACTORY_REQUIRED', 'a fixed broad-day reader factory must be injected by the composition owner');
  let reader;
  try {
    reader = await openBroadDayReader({ rootDir, dayStartTs, dayEndTs, asOfTs, limits: readerLimits, signal });
    const portError = dailyBroadArchiveReaderPortError(reader, { method: 'readPage' });
    if (portError) return fail('READER_PORT_INVALID', portError);
    const descriptor = reader.descriptor;
    const descriptorError = dailyBroadArchiveDescriptorError(descriptor, { maxMarkets: limits.maxMarkets });
    if (descriptorError) return fail(descriptorError.code, descriptorError.message);
    const acceptedCatalogSnapshot = sealDailyBroadArchiveCatalog(descriptor);
    const acceptedByPair = new Map(acceptedCatalogSnapshot.markets.map((market) => [market.providerAssetId, market]));
    const states = new Map(acceptedCatalogSnapshot.markets.map((market) => [marketIdentityDigest(market), {
      market, rows: [], periods: new Set(), bytes: 0,
    }]));

    let cursor = null; let pages = 0; let rows = 0; let materializedBytes = 0;
    while (true) {
      if (signal?.aborted) return fail('INPUT_CANCELLED', 'archive input materialization cancelled');
      pages += 1; if (pages > limits.maxPages) return fail('PAGE_LIMIT', 'reader page count exceeds adapter bound');
      const page = await reader.readPage({ cursor, maxRows: limits.pageRows, signal });
      const pageBody = { ...page }; delete pageBody.pageDigest;
      if (page.pageVersion !== DAILY_BROAD_ARCHIVE_READER_CONTRACT.pageVersion || page.pageDigest !== canonicalDigest(pageBody)
          || page.datasetDigest !== descriptor.datasetDigest || page.datasetId !== descriptor.datasetId
          || page.rowCount !== page.rows?.length || !Number.isSafeInteger(page.rowBytes) || page.rowBytes < 0
          || !Array.isArray(page.rows)) return fail('PAGE_INTEGRITY_INVALID', 'reader page identity, census, or body digest mismatch');
      for (const row of page.rows) {
        const error = dailyBroadArchiveRowError(row, descriptor); if (error) return fail('ROW_INVALID', error);
        rows += 1; if (rows > limits.maxRows) return fail('ROW_LIMIT', 'archive row inventory exceeds adapter bound');
        const accepted = acceptedByPair.get(row.market.pairKey);
        if (!accepted || accepted.canonicalCoin !== row.market.canonicalCoin
            || accepted.nativeSymbol !== row.market.catalogWsname) return fail('ROW_CATALOG_MISMATCH', 'archive row differs from sealed catalog union');
        const state = states.get(marketIdentityDigest(accepted));
        if (state.periods.has(row.periodStartTs)) return fail('DUPLICATE_CANDLE_PERIOD', 'reader returned a repeated market minute');
        state.periods.add(row.periodStartTs);
        const candle = dailyBroadArchiveCandleFromRow(row);
        const bytes = Buffer.byteLength(JSON.stringify(candle), 'utf8');
        materializedBytes += bytes; state.bytes += bytes;
        if (materializedBytes > limits.maxMaterializedBytes) return fail('MATERIALIZED_BYTE_LIMIT', 'planner candle materialization exceeds adapter bound');
        state.rows.push(candle);
      }
      if (page.done) break;
      if (page.nextCursor?.datasetDigest !== descriptor.datasetDigest) return fail('CURSOR_INVALID', 'reader returned an unbound restart cursor');
      cursor = page.nextCursor;
    }
    if (rows !== descriptor.counters.asOfEligibleCivilDayRows) return fail('ROW_CENSUS_MISMATCH', 'paged row census differs from verified reader descriptor');

    const marketDays = []; const marketDayDigests = [];
    for (const market of acceptedCatalogSnapshot.markets) {
      const digest = marketIdentityDigest(market); const state = states.get(digest);
      state.rows.sort((a, b) => a.periodStartTs - b.periodStartTs || a.observationId.localeCompare(b.observationId));
      const coverage = descriptor.coverage.find((row) => row.market.pairKey === market.providerAssetId);
      if (!coverage || coverage.gridState !== 'COMPLETE_OBSERVED_GRID'
          || coverage.expectedCatalogMembershipMinutes !== (dayEndTs - dayStartTs) / 60_000
          || state.rows.length !== coverage.uniqueObservedMinutes) return fail('MARKET_GRID_MISMATCH', 'a stable-union market lacks one exact closed candle for every day minute');
      const sourceDigest = canonicalDigest({
        provenanceVersion: DAILY_BROAD_ARCHIVE_PROVENANCE_VERSION,
        datasetDigest: descriptor.datasetDigest, marketIdentityDigest: digest,
        recordDigests: state.rows.map((row) => row.sourceDigest),
      });
      const support = {
        PRICE: absent('MISSING', 'BROAD_DAY_ARCHIVE_EXCLUDES_TICKER_HISTORY'),
        CANDLES: complete(state.rows.length, dayStartTs, dayEndTs, sourceDigest),
        BASE_VOLUME: complete(state.rows.length, dayStartTs, dayEndTs, sourceDigest),
        QUOTE_VOLUME: absent('UNSUPPORTED', 'VENUE_QUOTE_VOLUME_NOT_REPORTED;VWAP_TIMES_BASE_NOT_RELABELED_AS_OBSERVED_QUOTE_VOLUME'),
        TRADES: absent('UNSUPPORTED', 'AGGREGATE_CANDLE_TRADE_COUNT_IS_NOT_RAW_TRADE_EVIDENCE'),
        TRADE_FLOW: absent('UNSUPPORTED', 'RAW_TRADE_DIRECTION_NOT_ARCHIVED'),
        SPREAD: absent('UNSUPPORTED', 'ORDER_BOOK_SPREAD_NOT_ARCHIVED'),
        DEPTH: absent('UNSUPPORTED', 'ORDER_BOOK_DEPTH_NOT_ARCHIVED'),
        CATALYST: absent('UNSUPPORTED', 'CATALYST_EVIDENCE_NOT_ARCHIVED_IN_MARKET_CANDLE_SOURCE'),
      };
      const marketDay = { marketIdentityDigest: digest, priceEvents: [], candles: state.rows, support };
      marketDays.push(marketDay);
      // Hash one bounded market at a time. Hashing the full day object in one
      // canonical string would duplicate a large all-market payload in memory.
      marketDayDigests.push({ marketIdentityDigest: digest, marketDayDigest: canonicalDigest(marketDay) });
    }
    const provenance = sealDailyBroadArchiveProvenance(descriptor, acceptedCatalogSnapshot);
    const { catalogEpochDigest } = provenance;
    const body = {
      ok: true, version: DAILY_BROAD_ARCHIVE_INPUT_VERSION,
      acceptedCatalogSnapshot, marketDays, manifestCatalogProvenance: provenance,
      diagnostics: {
        readerDatasetId: descriptor.datasetId, readerDatasetDigest: descriptor.datasetDigest,
        catalogEpochDigest, catalogEpochs: descriptor.catalogEpochs.length,
        catalogMarkets: acceptedCatalogSnapshot.acceptedMarketCount, rows, pages,
        materializedBytes,
        materializedByteBasis: 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD',
        candleProvenance: 'DIRECT_CONSERVATIVE_CLOSED_OHLC',
        baseVolumeProvenance: 'DIRECT_VENUE_CANDLE_BASE_VOLUME',
        quoteVolumeProvenance: 'UNAVAILABLE_NOT_DERIVED', fullDetailClaimed: false,
        authority: 'NONE', durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
      },
    };
    // Content identity must not change when an operator chooses a different
    // bounded page size. Page count/bytes remain useful diagnostics, but are
    // transport observations rather than learning input content.
    const inputDigest = canonicalDigest({
      version: body.version, acceptedCatalogSnapshotDigest: acceptedCatalogSnapshot.contentDigest,
      marketDayDigests, manifestCatalogProvenance: provenance,
    });
    return deepFreeze({ ...body, inputDigest });
  } catch (error) {
    return fail(error?.code ?? 'ARCHIVE_INPUT_REFUSED', error?.message ?? 'archive input refused');
  } finally {
    try { reader?.close(); } catch { /* fixed reader close is synchronous and non-authoritative */ }
  }
}
