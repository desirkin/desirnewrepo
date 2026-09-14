// Versioned, bounded per-market reader for a verified broad-day v2 archive
// whose accepted catalog changed during the civil day. A shard may be exact
// for its catalog membership intervals without being a complete civil-day
// market day. This contract never upgrades partial membership into 1,440
// minutes, simulation credit, learning evidence, or external durability.
import { BROAD_DAY_MARKET_PAGE_VERSION, openBroadDayReader } from '../market-lab/broad-day-reader.js';
import { BROAD_DAY_ARCHIVE_VERSION_V2 } from '../market-lab/broad-day-archive.js';
import { dailyBroadArchiveCandleFromRow, dailyBroadArchiveRowError } from './daily-broad-archive-input.js';
import { canonicalDigest, deepFreeze } from './shadow-contracts.js';
import { marketIdentityDigest } from './shadow-catalog-snapshot.js';

export const DAILY_BROAD_MEMBERSHIP_SOURCE_VERSION = 'daily-broad-membership-shard-source-1';
export const DAILY_BROAD_MEMBERSHIP_DATASET_VERSION = 'daily-broad-membership-shard-dataset-1';
export const DAILY_BROAD_MEMBERSHIP_SHARD_VERSION = 'daily-broad-membership-market-shard-1';
export const DAILY_BROAD_MEMBERSHIP_PAGE_VERSION = 'daily-broad-membership-shard-page-1';
export const DAILY_BROAD_MEMBERSHIP_MARKET_DAY_VERSION = 'daily-broad-membership-market-day-1';
export const DAILY_BROAD_MEMBERSHIP_RECEIPT_VERSION = 'daily-broad-membership-receipt-1';
export const DAILY_BROAD_MEMBERSHIP_LIMITS = Object.freeze({
  maxMarkets: 5_000,
  maxRowsPerMarket: 1_500,
  maxCatalogEpochs: 10_000,
  maxIntervalsPerMarket: 512,
  maxTotalIntervals: 100_000,
  maxPagesPerMarket: 128,
  pageRows: 512,
  maxMaterializedBytesPerMarket: 4 * 1024 * 1024,
});

const HARD = Object.freeze({
  maxMarkets: 5_000, maxRowsPerMarket: 2_000, maxCatalogEpochs: 100_000,
  maxIntervalsPerMarket: 2_000, maxTotalIntervals: 1_000_000,
  maxPagesPerMarket: 2_000, pageRows: 5_000,
  maxMaterializedBytesPerMarket: 16 * 1024 * 1024,
});
const MINUTE = 60_000;
const HEX64 = /^[a-f0-9]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const digestWithout = (value, key) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));

const SHARD_KEYS = Object.freeze([
  'shardVersion', 'shardId', 'shardDigest', 'sourceDatasetId', 'sourceDatasetDigest',
  'shardIndex', 'sourceMarketIdentityDigest', 'marketIdentityDigest', 'market',
  'expectedRows', 'expectedCatalogMembershipMinutes', 'expectedCivilDayMinutes',
  'membershipIntervals', 'membershipIntervalsDigest', 'membershipCoverage',
]);
const INTERVAL_KEYS = Object.freeze([
  'catalogContentId', 'startTs', 'endTs', 'expectedMinutes',
  'membershipKnownAtTs', 'catalogControls', 'firstCatalogControlDigest',
  'lastCatalogControlDigest',
]);
const RECEIPT_KEYS = Object.freeze([
  'receiptVersion', 'receiptDigest', 'datasetId', 'datasetDigest', 'shardId',
  'shardDigest', 'marketIdentityDigest', 'marketDayDigest', 'rowCount',
  'serializedCandleBytes', 'pages', 'byteBasis', 'authority', 'learningEligible',
  'simulationCredit',
]);

function limitsOf(input) {
  if (input !== undefined && !plain(input)) throw fail('MEMBERSHIP_LIMITS_INVALID', 'limits must be an object');
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in DAILY_BROAD_MEMBERSHIP_LIMITS));
  if (unknown.length) throw fail('MEMBERSHIP_LIMITS_INVALID', `unknown limits: ${unknown.join(',')}`);
  const value = { ...DAILY_BROAD_MEMBERSHIP_LIMITS, ...(input ?? {}) };
  for (const [key, ceiling] of Object.entries(HARD)) {
    if (!positive(value[key]) || value[key] > ceiling) throw fail('MEMBERSHIP_LIMITS_INVALID', `${key} exceeds its hard bound`);
  }
  return Object.freeze(value);
}

function marketOf(source) {
  return {
    subjectKind: 'MARKET', canonicalCoin: source.market.canonicalCoin,
    providerAssetId: source.market.pairKey, venue: 'kraken',
    nativeSymbol: source.market.catalogWsname, base: source.market.canonicalCoin,
    quote: 'USD', marketType: 'SPOT', quoteAliasGroup: 'USD',
  };
}

function sourceProofError(descriptor, limits) {
  if (descriptor?.archiveVersion !== BROAD_DAY_ARCHIVE_VERSION_V2
      || descriptor.sourceProvenance?.sourceKind !== 'LOCAL_BROAD_DAY_ARCHIVE_V2'
      || descriptor.sourceProvenance?.durability !== 'LOCAL_FILESYSTEM_ONLY'
      || descriptor.sourceProvenance?.republishSafe !== false
      || descriptor.completeness?.physicalControlAndShardIntegrityVerified !== true
      || descriptor.completeness?.sourceRecordIdentityRecomputableAfterCanonicalArchiveWrite !== true
      || descriptor.completeness?.catalogEpochContinuityVerified !== true
      || descriptor.completeness?.sessionFinalizationVerified !== true
      || descriptor.completeness?.fullPopulationVerified !== true) {
    return fail('MEMBERSHIP_SOURCE_PROOF_INCOMPLETE', 'reader v2 raw archive proof is incomplete');
  }
  if (!Array.isArray(descriptor.catalogUnion) || descriptor.catalogUnion.length < 1
      || descriptor.catalogUnion.length > limits.maxMarkets
      || !Array.isArray(descriptor.catalogEpochs) || descriptor.catalogEpochs.length < 1
      || descriptor.catalogEpochs.length > limits.maxCatalogEpochs
      || !Array.isArray(descriptor.coverage)
      || descriptor.coverage.length !== descriptor.catalogUnion.length) {
    return fail('MEMBERSHIP_CATALOG_INVALID', 'catalog union, epochs, or coverage inventory is malformed or over bound');
  }
  if (descriptor.counters?.canonicalCoinsWithIdentityChanges !== 0) {
    return fail('CATALOG_IDENTITY_CHURN_UNREPRESENTABLE', 'one canonical coin has multiple venue identities; no merged membership shard is returned');
  }
  const coins = descriptor.catalogUnion.map((row) => row?.market?.canonicalCoin);
  if (coins.some((coin) => typeof coin !== 'string') || new Set(coins).size !== coins.length) {
    return fail('CATALOG_IDENTITY_CHURN_UNREPRESENTABLE', 'catalog union does not have one stable venue identity per canonical coin');
  }
  return null;
}

function intervalsByIdentity(descriptor, limits) {
  const out = new Map(descriptor.catalogUnion.map((row) => [row.marketIdentityDigest, []]));
  let totalIntervals = 0;
  for (const epoch of descriptor.catalogEpochs) {
    const startMinute = Math.max(0, Math.ceil((Math.max(descriptor.dayStartTs, epoch.admittedTs) - descriptor.dayStartTs) / MINUTE));
    const endMinute = Math.min((descriptor.dayEndTs - descriptor.dayStartTs) / MINUTE,
      Math.ceil((Math.min(descriptor.dayEndTs, epoch.activeUntilTs) - descriptor.dayStartTs) / MINUTE));
    if (endMinute <= startMinute) continue;
    for (const identityDigest of epoch.marketIdentityDigests) {
      const list = out.get(identityDigest);
      if (!list) throw fail('MEMBERSHIP_CATALOG_INVALID', 'catalog epoch references an identity absent from the day union');
      const startTs = descriptor.dayStartTs + startMinute * MINUTE;
      const endTs = descriptor.dayStartTs + endMinute * MINUTE;
      const prior = list.at(-1);
      if (prior && prior.catalogContentId === epoch.catalogContentId && prior.endTs === startTs) {
        prior.endTs = endTs;
        prior.expectedMinutes += endMinute - startMinute;
        prior.catalogControls += 1;
        prior.lastCatalogControlDigest = epoch.controlDigest;
      } else {
        if (list.length >= limits.maxIntervalsPerMarket || totalIntervals >= limits.maxTotalIntervals) {
          throw fail('MEMBERSHIP_INTERVAL_LIMIT', 'catalog membership interval inventory exceeds its sealed bound');
        }
        list.push({
          catalogContentId: epoch.catalogContentId, startTs, endTs,
          expectedMinutes: endMinute - startMinute,
          membershipKnownAtTs: epoch.membershipKnownSinceTs,
          catalogControls: 1, firstCatalogControlDigest: epoch.controlDigest,
          lastCatalogControlDigest: epoch.controlDigest,
        });
        totalIntervals += 1;
      }
    }
  }
  return out;
}

function intervalError(interval, dayStartTs, dayEndTs) {
  if (!exact(interval, INTERVAL_KEYS) || typeof interval.catalogContentId !== 'string'
      || !positive(interval.startTs) || !positive(interval.endTs) || interval.startTs >= interval.endTs
      || interval.startTs < dayStartTs || interval.endTs > dayEndTs
      || (interval.startTs - dayStartTs) % MINUTE !== 0 || (interval.endTs - dayStartTs) % MINUTE !== 0
      || interval.expectedMinutes !== (interval.endTs - interval.startTs) / MINUTE
      || !positive(interval.expectedMinutes) || !positive(interval.membershipKnownAtTs)
      || interval.membershipKnownAtTs > interval.startTs
      || !positive(interval.catalogControls)
      || !HEX64.test(interval.firstCatalogControlDigest ?? '')
      || !HEX64.test(interval.lastCatalogControlDigest ?? '')) return 'membership interval malformed or backdated';
  return null;
}

function shardBody(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['shardId', 'shardDigest'].includes(key)));
}

function shardError(shard, { dayStartTs, dayEndTs }) {
  if (!exact(shard, SHARD_KEYS) || shard.shardVersion !== DAILY_BROAD_MEMBERSHIP_SHARD_VERSION
      || typeof shard.shardId !== 'string' || !HEX64.test(shard.shardDigest ?? '')
      || !HEX64.test(shard.sourceDatasetDigest ?? '') || !HEX64.test(shard.sourceMarketIdentityDigest ?? '')
      || !HEX64.test(shard.marketIdentityDigest ?? '') || !Number.isSafeInteger(shard.shardIndex) || shard.shardIndex < 0
      || !positive(shard.expectedRows) || shard.expectedRows !== shard.expectedCatalogMembershipMinutes
      || shard.expectedCivilDayMinutes !== (dayEndTs - dayStartTs) / MINUTE
      || !Array.isArray(shard.membershipIntervals) || shard.membershipIntervals.length < 1
      || !HEX64.test(shard.membershipIntervalsDigest ?? '')
      || shard.membershipIntervalsDigest !== canonicalDigest(shard.membershipIntervals)
      || !['FULL_CIVIL_DAY', 'PARTIAL_CIVIL_DAY_COMPLETE_FOR_MEMBERSHIP'].includes(shard.membershipCoverage)
      || shard.shardDigest !== canonicalDigest(shardBody(shard))
      || shard.shardId !== `dbmms-${shard.shardDigest}`) return 'membership shard identity or fields malformed';
  let priorEnd = null; let expected = 0;
  for (const interval of shard.membershipIntervals) {
    const error = intervalError(interval, dayStartTs, dayEndTs);
    if (error || (priorEnd !== null && interval.startTs < priorEnd)) return error ?? 'membership intervals overlap';
    priorEnd = interval.endTs; expected += interval.expectedMinutes;
  }
  if (expected !== shard.expectedRows
      || (shard.membershipCoverage === 'FULL_CIVIL_DAY'
        && (shard.membershipIntervals[0].startTs !== dayStartTs || shard.membershipIntervals.at(-1).endTs !== dayEndTs
          || expected !== shard.expectedCivilDayMinutes))
      || (shard.membershipCoverage === 'PARTIAL_CIVIL_DAY_COMPLETE_FOR_MEMBERSHIP'
        && expected === shard.expectedCivilDayMinutes)) return 'membership coverage classification malformed';
  return null;
}

function withinMembership(shard, periodStartTs) {
  return shard.membershipIntervals.some((interval) => periodStartTs >= interval.startTs && periodStartTs < interval.endTs);
}

function receiptDigestBody(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    'receiptDigest', 'serializedCandleBytes', 'pages', 'byteBasis',
  ].includes(key)));
}

export function dailyBroadMembershipReceiptError(value, { descriptor = null, shard = null, marketDay = null } = {}) {
  if (!exact(value, RECEIPT_KEYS) || value.receiptVersion !== DAILY_BROAD_MEMBERSHIP_RECEIPT_VERSION
      || !HEX64.test(value.receiptDigest ?? '') || !HEX64.test(value.datasetDigest ?? '')
      || !HEX64.test(value.shardDigest ?? '') || !HEX64.test(value.marketIdentityDigest ?? '')
      || !HEX64.test(value.marketDayDigest ?? '') || typeof value.datasetId !== 'string'
      || typeof value.shardId !== 'string' || !positive(value.rowCount)
      || !positive(value.serializedCandleBytes) || !positive(value.pages)
      || value.byteBasis !== 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD'
      || value.authority !== 'NONE' || value.learningEligible !== false || value.simulationCredit !== 0
      || value.receiptDigest !== canonicalDigest(receiptDigestBody(value))) return 'membership receipt identity or fields malformed';
  if (descriptor && (value.datasetId !== descriptor.datasetId || value.datasetDigest !== descriptor.datasetDigest)) return 'membership receipt dataset mismatch';
  if (shard && (value.shardId !== shard.shardId || value.shardDigest !== shard.shardDigest
      || value.marketIdentityDigest !== shard.marketIdentityDigest || value.rowCount !== shard.expectedRows)) return 'membership receipt shard mismatch';
  if (marketDay && (value.marketDayDigest !== canonicalDigest(marketDay)
      || value.marketIdentityDigest !== marketDay.marketIdentityDigest)) return 'membership receipt content mismatch';
  return null;
}

function supportFor(shard, candles, sourceDigest, dayStartTs, dayEndTs) {
  const full = shard.membershipCoverage === 'FULL_CIVIL_DAY';
  const observed = {
    state: full ? 'COMPLETE' : 'PARTIAL', observedCount: candles.length,
    coverageStartTs: shard.membershipIntervals[0].startTs,
    coverageEndTs: shard.membershipIntervals.at(-1).endTs,
    gapCount: 0, sourceDigests: [sourceDigest],
    reason: full ? null : 'COMPLETE_FOR_VERIFIED_CATALOG_MEMBERSHIP_INTERVALS;NOT_COMPLETE_CIVIL_DAY',
  };
  const absent = (state, reason) => ({
    state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
    gapCount: 0, sourceDigests: [], reason,
  });
  return {
    PRICE: absent('MISSING', 'BROAD_DAY_ARCHIVE_EXCLUDES_TICKER_HISTORY'),
    CANDLES: { ...observed }, BASE_VOLUME: { ...observed },
    QUOTE_VOLUME: absent('UNSUPPORTED', 'VENUE_QUOTE_VOLUME_NOT_REPORTED;VWAP_TIMES_BASE_NOT_RELABELED_AS_OBSERVED_QUOTE_VOLUME'),
    TRADES: absent('UNSUPPORTED', 'AGGREGATE_CANDLE_TRADE_COUNT_IS_NOT_RAW_TRADE_EVIDENCE'),
    TRADE_FLOW: absent('UNSUPPORTED', 'RAW_TRADE_DIRECTION_NOT_ARCHIVED'),
    SPREAD: absent('UNSUPPORTED', 'ORDER_BOOK_SPREAD_NOT_ARCHIVED'),
    DEPTH: absent('UNSUPPORTED', 'ORDER_BOOK_DEPTH_NOT_ARCHIVED'),
    CATALYST: absent('UNSUPPORTED', 'CATALYST_EVIDENCE_NOT_ARCHIVED_IN_MARKET_CANDLE_SOURCE'),
  };
}

export async function openDailyBroadMembershipShardSource({
  rootDir, dayStartTs, dayEndTs, asOfTs, limits: suppliedLimits, readerLimits, signal = null,
} = {}) {
  const limits = limitsOf(suppliedLimits);
  const reader = await openBroadDayReader({ rootDir, dayStartTs, dayEndTs, asOfTs, limits: readerLimits, signal });
  try {
    const sourceDescriptor = reader.descriptor;
    const sourceError = sourceProofError(sourceDescriptor, limits);
    if (sourceError) throw sourceError;
    const intervalMap = intervalsByIdentity(sourceDescriptor, limits);
    const coverageMap = new Map(sourceDescriptor.coverage.map((row) => [row.marketIdentityDigest, row]));
    const shards = sourceDescriptor.catalogUnion.map((source, shardIndex) => {
      const coverage = coverageMap.get(source.marketIdentityDigest);
      const intervals = intervalMap.get(source.marketIdentityDigest) ?? [];
      const market = marketOf(source);
      const expectedMinutes = intervals.reduce((sum, row) => sum + row.expectedMinutes, 0);
      const civilDayMinutes = (dayEndTs - dayStartTs) / MINUTE;
      if (!coverage || intervals.length < 1 || intervals.some((row) => intervalError(row, dayStartTs, dayEndTs))
          || coverage.gridState !== 'COMPLETE_OBSERVED_GRID' || coverage.uniqueObservedMinutes !== expectedMinutes
          || coverage.expectedCatalogMembershipMinutes !== expectedMinutes || expectedMinutes > limits.maxRowsPerMarket
          || coverage.futureAdmissionWithheldRows !== 0 || coverage.conflictRows !== 0
          || coverage.explicitGapControls !== 0 || coverage.outsideCatalogEpochMinutes !== 0) {
        throw fail('MEMBERSHIP_SHARD_INCOMPLETE', 'one catalog member lacks an exact bounded observed grid for its known membership intervals');
      }
      const value = {
        shardVersion: DAILY_BROAD_MEMBERSHIP_SHARD_VERSION,
        shardId: '', shardDigest: '', sourceDatasetId: sourceDescriptor.datasetId,
        sourceDatasetDigest: sourceDescriptor.datasetDigest, shardIndex,
        sourceMarketIdentityDigest: source.marketIdentityDigest,
        marketIdentityDigest: marketIdentityDigest(market), market,
        expectedRows: expectedMinutes, expectedCatalogMembershipMinutes: expectedMinutes,
        expectedCivilDayMinutes: civilDayMinutes, membershipIntervals: intervals,
        membershipIntervalsDigest: canonicalDigest(intervals),
        membershipCoverage: expectedMinutes === civilDayMinutes
          && intervals[0].startTs === dayStartTs && intervals.at(-1).endTs === dayEndTs
          ? 'FULL_CIVIL_DAY' : 'PARTIAL_CIVIL_DAY_COMPLETE_FOR_MEMBERSHIP',
      };
      value.shardDigest = canonicalDigest(shardBody(value));
      value.shardId = `dbmms-${value.shardDigest}`;
      const error = shardError(value, { dayStartTs, dayEndTs });
      if (error) throw fail('MEMBERSHIP_SHARD_INVALID', error);
      return value;
    }).sort((a, b) => a.marketIdentityDigest.localeCompare(b.marketIdentityDigest))
      .map((row, shardIndex) => {
        const value = { ...row, shardIndex, shardId: '', shardDigest: '' };
        value.shardDigest = canonicalDigest(shardBody(value)); value.shardId = `dbmms-${value.shardDigest}`;
        return value;
      });
    const catalogEpochDigest = canonicalDigest(sourceDescriptor.catalogEpochs);
    const fullCivilDayMarkets = shards.filter((row) => row.membershipCoverage === 'FULL_CIVIL_DAY').length;
    const descriptorBody = {
      datasetVersion: DAILY_BROAD_MEMBERSHIP_DATASET_VERSION,
      sourceDatasetVersion: sourceDescriptor.datasetVersion,
      sourceDatasetId: sourceDescriptor.datasetId, sourceDatasetDigest: sourceDescriptor.datasetDigest,
      dayStartTs, dayEndTs, asOfTs, catalogEpochDigest,
      catalogEpochCount: sourceDescriptor.catalogEpochs.length,
      catalogContentCount: new Set(sourceDescriptor.catalogEpochs.map((row) => row.catalogContentId)).size,
      shardCount: shards.length, expectedRows: shards.reduce((sum, row) => sum + row.expectedRows, 0),
      membershipCompleteMarkets: shards.length, fullCivilDayMarkets,
      partialCivilDayMarkets: shards.length - fullCivilDayMarkets,
      shards, traversalOrder: 'LEARNING_MARKET_IDENTITY_DIGEST_ASCENDING',
      completeness: 'VERIFIED_LOCAL_V2_COMPLETE_FOR_CATALOG_MEMBERSHIP_INTERVALS',
      consumerCompatibility: {
        membershipShardVersion: DAILY_BROAD_MEMBERSHIP_SHARD_VERSION,
        membershipIntervalsSupported: true,
        stableCivilDayV1AdapterCompatible: sourceDescriptor.catalogEpochs.every((row) => row.catalogContentId === sourceDescriptor.catalogEpochs[0].catalogContentId)
          && fullCivilDayMarkets === shards.length,
        civilDayCompleteMarkets: fullCivilDayMarkets,
        membershipCompleteMarkets: shards.length,
      },
      durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    const datasetDigest = canonicalDigest(descriptorBody);
    const descriptor = deepFreeze({ ...descriptorBody, datasetDigest, datasetId: `dbmmd-${datasetDigest}` });
    const byId = new Map(descriptor.shards.map((row) => [row.shardId, row]));
    let closed = false;

    const readShardPage = async ({ shardId, cursor = null, maxRows = limits.pageRows, signal: pageSignal = null } = {}) => {
      if (closed) throw fail('MEMBERSHIP_SOURCE_CLOSED', 'source is closed');
      const shard = byId.get(shardId);
      if (!shard) throw fail('MEMBERSHIP_SHARD_NOT_FOUND', 'shardId is absent from the sealed denominator');
      if (!positive(maxRows) || maxRows > limits.pageRows) throw fail('MEMBERSHIP_PAGE_LIMIT', 'page maxRows exceeds the sealed source bound');
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
        throw fail('MEMBERSHIP_PAGE_INTEGRITY_INVALID', 'source market page identity or census mismatch');
      }
      const candles = sourcePage.rows.map((row) => {
        const error = dailyBroadArchiveRowError(row, sourceDescriptor);
        if (error || row.marketIdentityDigest !== shard.sourceMarketIdentityDigest
            || row.market.pairKey !== shard.market.providerAssetId
            || row.market.canonicalCoin !== shard.market.canonicalCoin
            || row.market.catalogWsname !== shard.market.nativeSymbol
            || !withinMembership(shard, row.periodStartTs)) {
          throw fail('MEMBERSHIP_ROW_INVALID', error ?? 'row differs from the sealed identity or membership intervals');
        }
        return dailyBroadArchiveCandleFromRow(row);
      });
      const body = {
        pageVersion: DAILY_BROAD_MEMBERSHIP_PAGE_VERSION,
        datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
        shardId: shard.shardId, shardDigest: shard.shardDigest,
        sourceCursor: cursor, nextSourceCursor: sourcePage.nextCursor,
        done: sourcePage.done, rowCount: candles.length, candles,
        authority: 'NONE', learningEligible: false, simulationCredit: 0,
      };
      return deepFreeze({ ...body, pageDigest: canonicalDigest(body) });
    };

    const loadShard = async ({ shardId, pageRows = limits.pageRows, signal: pageSignal = null } = {}) => {
      if (closed) throw fail('MEMBERSHIP_SOURCE_CLOSED', 'source is closed');
      const shard = byId.get(shardId);
      if (!shard) throw fail('MEMBERSHIP_SHARD_NOT_FOUND', 'shardId is absent from the sealed denominator');
      if (!positive(pageRows) || pageRows > limits.pageRows) throw fail('MEMBERSHIP_PAGE_LIMIT', 'pageRows exceeds the sealed source bound');
      let cursor = null; let pages = 0; let bytes = 0; const candles = []; const periods = new Set();
      while (true) {
        if (pageSignal?.aborted) throw fail('MEMBERSHIP_CANCELLED', 'membership shard load cancelled');
        pages += 1;
        if (pages > limits.maxPagesPerMarket) throw fail('MEMBERSHIP_PAGE_LIMIT', 'market page count exceeds bound');
        const page = await readShardPage({ shardId, cursor, maxRows: pageRows, signal: pageSignal });
        for (const candle of page.candles) {
          if (periods.has(candle.periodStartTs)) throw fail('MEMBERSHIP_DUPLICATE_PERIOD', 'market shard contains a repeated minute');
          periods.add(candle.periodStartTs); candles.push(candle);
          bytes += Buffer.byteLength(JSON.stringify(candle), 'utf8');
          if (candles.length > limits.maxRowsPerMarket || bytes > limits.maxMaterializedBytesPerMarket) {
            throw fail('MEMBERSHIP_MATERIALIZATION_LIMIT', 'one membership shard exceeds its row/byte bound');
          }
        }
        if (page.done) break;
        cursor = page.nextSourceCursor;
      }
      candles.sort((a, b) => a.periodStartTs - b.periodStartTs || a.observationId.localeCompare(b.observationId));
      const expectedPeriods = shard.membershipIntervals.flatMap((interval) => Array.from(
        { length: interval.expectedMinutes }, (_, index) => interval.startTs + index * MINUTE,
      ));
      if (candles.length !== shard.expectedRows
          || candles.some((row, index) => row.periodStartTs !== expectedPeriods[index])) {
        throw fail('MEMBERSHIP_GRID_INCOMPLETE', 'loaded candles differ from exact sealed catalog membership minutes');
      }
      const sourceDigest = canonicalDigest({
        sourceDatasetDigest: shard.sourceDatasetDigest,
        membershipIntervalsDigest: shard.membershipIntervalsDigest,
        marketIdentityDigest: shard.marketIdentityDigest,
        recordDigests: candles.map((row) => row.sourceDigest),
      });
      const marketDay = {
        marketDayVersion: DAILY_BROAD_MEMBERSHIP_MARKET_DAY_VERSION,
        marketIdentityDigest: shard.marketIdentityDigest,
        membershipCoverage: shard.membershipCoverage,
        expectedCatalogMembershipMinutes: shard.expectedCatalogMembershipMinutes,
        expectedCivilDayMinutes: shard.expectedCivilDayMinutes,
        membershipIntervals: shard.membershipIntervals,
        priceEvents: [], candles,
        support: supportFor(shard, candles, sourceDigest, dayStartTs, dayEndTs),
        authority: 'NONE', learningEligible: false, simulationCredit: 0,
      };
      const marketDayDigest = canonicalDigest(marketDay);
      const receipt = {
        receiptVersion: DAILY_BROAD_MEMBERSHIP_RECEIPT_VERSION, receiptDigest: '',
        datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
        shardId: shard.shardId, shardDigest: shard.shardDigest,
        marketIdentityDigest: shard.marketIdentityDigest, marketDayDigest,
        rowCount: candles.length, serializedCandleBytes: bytes, pages,
        byteBasis: 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD',
        authority: 'NONE', learningEligible: false, simulationCredit: 0,
      };
      receipt.receiptDigest = canonicalDigest(receiptDigestBody(receipt));
      const error = dailyBroadMembershipReceiptError(receipt, { descriptor, shard, marketDay });
      if (error) throw fail('MEMBERSHIP_RECEIPT_INVALID', error);
      let released = false;
      const release = () => { released = true; return Object.freeze({ released }); };
      return Object.freeze({ marketDay: deepFreeze(marketDay), receipt: deepFreeze(receipt), release });
    };

    const status = () => deepFreeze({
      sourceVersion: DAILY_BROAD_MEMBERSHIP_SOURCE_VERSION,
      state: closed ? 'CLOSED' : 'OPEN', datasetId: descriptor.datasetId,
      datasetDigest: descriptor.datasetDigest, shardCount: descriptor.shardCount,
      expectedRows: descriptor.expectedRows, membershipCompleteMarkets: descriptor.membershipCompleteMarkets,
      fullCivilDayMarkets: descriptor.fullCivilDayMarkets,
      durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
      authority: 'NONE', learningEligible: false,
    });
    const close = () => { if (!closed) { reader.close(); closed = true; } return status(); };
    return Object.freeze({
      version: DAILY_BROAD_MEMBERSHIP_SOURCE_VERSION,
      descriptor, readShardPage, loadShard, status, close,
    });
  } catch (error) {
    try { reader.close(); } catch { /* preserve construction error */ }
    throw error;
  }
}
