import { getHeapStatistics } from 'node:v8';
import {
  openDailyShardedStudyRunnerForTest, sealDailyShardTraversalOutput,
} from '../../learning/daily-sharded-study-runner.js';
import { DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION } from '../../learning/daily-broad-archive-shards.js';
import { canonicalDigest } from '../../learning/shadow-contracts.js';

const [stateRoot] = process.argv.slice(2);
const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 1_440 * MINUTE;
const AS_OF = END + MINUTE;
const MARKET_COUNT = 612;
const sourceDatasetDigest = canonicalDigest({ source: 'synthetic-scale-only', markets: MARKET_COUNT, minutes: 1_440 });
const sourceDatasetId = `bdd-${sourceDatasetDigest}`;
const shards = Array.from({ length: MARKET_COUNT }, (_, index) => {
  const marketIdentityDigest = canonicalDigest({ market: index });
  const shardDigest = canonicalDigest({ sourceDatasetDigest, marketIdentityDigest, index });
  return {
    shardVersion: 'daily-broad-archive-market-shard-1', shardId: `dbams-${shardDigest}`,
    shardDigest, sourceDatasetId, sourceDatasetDigest, shardIndex: index,
    sourceMarketIdentityDigest: canonicalDigest({ sourceMarket: index }),
    marketIdentityDigest, market: { canonicalCoin: `S${index}`, providerAssetId: `S${index}USD` },
    expectedRows: 1_440, expectedCatalogMembershipMinutes: 1_440,
    sourceSessions: 1, sourceCatalogControls: 97,
  };
});
const descriptorBody = {
  datasetVersion: 'daily-broad-archive-shard-dataset-1', sourceDatasetVersion: 'broad-day-dataset-v1',
  sourceDatasetId, sourceDatasetDigest, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
  acceptedCatalogSnapshot: { contentDigest: canonicalDigest({ catalog: MARKET_COUNT }) },
  catalogProvenance: { catalogEpochDigest: canonicalDigest({ catalogEpoch: 'stable' }) },
  shardCount: MARKET_COUNT, expectedRows: MARKET_COUNT * 1_440, shards,
  traversalOrder: 'ACCEPTED_CATALOG_MARKET_IDENTITY_DIGEST_ASCENDING',
  completeness: 'SYNTHETIC_SCALE_FIXTURE_ONLY', durability: 'TEST_MEMORY_ONLY', republishSafe: false,
  authority: 'NONE', learningEligible: false, simulationCredit: 0,
};
const datasetDigest = canonicalDigest(descriptorBody);
const descriptor = { ...descriptorBody, datasetDigest, datasetId: `dbasd-${datasetDigest}` };

let activeLoads = 0; let maxActiveLoads = 0; let releases = 0; let generatedRows = 0;
const source = {
  descriptor,
  async loadShard({ shardId, signal }) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'SHARD_CANCELLED' });
    const shard = shards.find((row) => row.shardId === shardId);
    if (!shard) throw Object.assign(new Error('missing shard'), { code: 'SHARD_NOT_FOUND' });
    activeLoads += 1; maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
    const sourceDigest = canonicalDigest({ sourceDatasetDigest, marketIdentityDigest: shard.marketIdentityDigest });
    const candles = Array.from({ length: 1_440 }, (_, minute) => {
      const periodStartTs = START + minute * MINUTE; const close = 100 + (minute % 17) / 100;
      return {
        observationId: `synthetic-${shard.shardIndex}-${minute}`,
        periodStartTs, periodEndTs: periodStartTs + MINUTE,
        open: close, high: close, low: close, close,
        volumeBase: 1, volumeQuote: null, closed: true,
        receivedTs: periodStartTs + MINUTE + 100,
        knownAtTs: periodStartTs + MINUTE + 200, sourceDigest,
      };
    });
    generatedRows += candles.length;
    const complete = {
      state: 'COMPLETE', observedCount: 1_440, coverageStartTs: START,
      coverageEndTs: END, gapCount: 0, sourceDigests: [sourceDigest], reason: null,
    };
    const absent = (state, reason) => ({
      state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
      gapCount: 0, sourceDigests: [], reason,
    });
    const marketDay = {
      marketIdentityDigest: shard.marketIdentityDigest, priceEvents: [], candles,
      support: {
        PRICE: absent('MISSING', 'SYNTHETIC_SCALE_FIXTURE'), CANDLES: complete, BASE_VOLUME: complete,
        QUOTE_VOLUME: absent('UNSUPPORTED', 'SYNTHETIC_SCALE_FIXTURE'),
        TRADES: absent('UNSUPPORTED', 'SYNTHETIC_SCALE_FIXTURE'),
        TRADE_FLOW: absent('UNSUPPORTED', 'SYNTHETIC_SCALE_FIXTURE'),
        SPREAD: absent('UNSUPPORTED', 'SYNTHETIC_SCALE_FIXTURE'),
        DEPTH: absent('UNSUPPORTED', 'SYNTHETIC_SCALE_FIXTURE'),
        CATALYST: absent('UNSUPPORTED', 'SYNTHETIC_SCALE_FIXTURE'),
      },
    };
    const marketDayDigest = canonicalDigest(marketDay);
    const serializedCandleBytes = candles.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0);
    const receipt = {
      receiptVersion: DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION, receiptDigest: '',
      datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
      shardId: shard.shardId, shardDigest: shard.shardDigest,
      marketIdentityDigest: shard.marketIdentityDigest, marketDayDigest,
      rowCount: 1_440, serializedCandleBytes, pages: 3,
      byteBasis: 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD',
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    };
    receipt.receiptDigest = canonicalDigest({
      receiptVersion: receipt.receiptVersion, datasetId: receipt.datasetId,
      datasetDigest: receipt.datasetDigest, shardId: receipt.shardId,
      shardDigest: receipt.shardDigest, marketIdentityDigest: receipt.marketIdentityDigest,
      marketDayDigest: receipt.marketDayDigest, rowCount: receipt.rowCount,
      authority: receipt.authority, learningEligible: receipt.learningEligible,
      simulationCredit: receipt.simulationCredit,
    });
    let released = false;
    return {
      marketDay, receipt,
      release() {
        if (!released) { released = true; activeLoads -= 1; releases += 1; }
        return { released };
      },
    };
  },
  close() { return { closed: true }; },
};

let peakHeapUsed = process.memoryUsage().heapUsed; let peakRss = process.memoryUsage().rss; let eventLoopTicks = 0;
const timer = setInterval(() => { eventLoopTicks += 1; }, 1);
let runner;
try {
  runner = await openDailyShardedStudyRunnerForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'synthetic-612x1440', declaredTs: AS_OF,
    limits: { maxShardsPerExecute: 64, maxStateBytes: 8 * 1024 * 1024 },
    consumeShard: async ({ marketDay, receipt }) => {
      peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      return sealDailyShardTraversalOutput({ marketDay, receipt });
    },
  }, { source });
  let result;
  do {
    result = await runner.execute({ maxShards: 64 });
    peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  } while (!result.completed);
  await runner.close(); clearInterval(timer);
  process.stdout.write(`${JSON.stringify({
    result, generatedRows, releases, activeLoads, maxActiveLoads,
    peakHeapUsed, peakRss, heapLimit: getHeapStatistics().heap_size_limit,
    eventLoopTicks,
  })}\n`);
} catch (error) {
  clearInterval(timer); try { await runner?.close(); } catch {}
  process.stderr.write(`${JSON.stringify({ code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 500) })}\n`);
  process.exitCode = 1;
}
