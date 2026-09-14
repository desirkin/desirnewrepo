import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createDailyShardedStudyClassifier, dailyShardClassificationOutputError,
} from '../learning/daily-sharded-study-classifier.js';
import {
  dailyShardConsumerAckError, openDailyShardedStudyRunnerForTest,
} from '../learning/daily-sharded-study-runner.js';
import {
  DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION,
} from '../learning/daily-broad-archive-shards.js';
import { sealDailyMoveStudyManifestV2, SUPPORT_FAMILIES } from '../learning/daily-move-study.js';
import { canonicalDigest } from '../learning/shadow-contracts.js';
import { marketIdentityDigest, sealAcceptedCatalogSnapshot } from '../learning/shadow-catalog-snapshot.js';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 1_440 * MINUTE;
const AS_OF = END + MINUTE;
const MARKET_COUNT = 612;
const roots = [];
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const tempRoot = (name) => { const root = mkdtempSync(path.join(tmpdir(), name)); roots.push(root); return root; };

const markets = Array.from({ length: MARKET_COUNT }, (_, index) => {
  const coin = `Q${String(index).padStart(4, '0')}`;
  return {
    subjectKind: 'MARKET', canonicalCoin: coin, providerAssetId: `${coin}USD`,
    venue: 'kraken', nativeSymbol: `${coin}/USD`, base: coin, quote: 'USD',
    marketType: 'SPOT', quoteAliasGroup: 'USD',
  };
});
const catalog = sealAcceptedCatalogSnapshot({
  observedTs: START, knownAtTs: START + 1, maxAgeMs: 24 * 60 * MINUTE, markets,
});
const sourceDatasetDigest = canonicalDigest({ source: 'verified-local-v2-classifier-fixture' });
const sourceDatasetId = `bdd-${sourceDatasetDigest}`;
const catalogEpochDigest = canonicalDigest({ catalogEpoch: catalog.contentDigest });
const catalogProvenance = {
  provenanceVersion: 'daily-broad-archive-provenance-1',
  state: 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY', provenanceVerified: true,
  durableFullDayEpochUnionVerified: true,
  sourceDatasetVersion: 'broad-day-dataset-v1', sourceDatasetId, sourceDatasetDigest,
  sourceArchiveVersion: 'broad-day-archive-local-v2', catalogEpochDigest,
  catalogUnionContentDigest: catalog.contentDigest, durability: 'LOCAL_FILESYSTEM_ONLY',
  republishSafe: false, warning: 'Local fixture custody only; no external durability or prospective claim.',
};
const manifest = sealDailyMoveStudyManifestV2({
  createdTs: AS_OF, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
  acceptedCatalogSnapshot: catalog, catalogProvenance,
});
const shards = catalog.markets.map((market, shardIndex) => {
  const digest = marketIdentityDigest(market);
  const shardDigest = canonicalDigest({ sourceDatasetDigest, digest, shardIndex });
  return {
    shardVersion: 'daily-broad-archive-market-shard-1',
    shardId: `dbams-${shardDigest}`, shardDigest, sourceDatasetId, sourceDatasetDigest,
    shardIndex, sourceMarketIdentityDigest: digest, marketIdentityDigest: digest,
    market, expectedRows: 1_440, expectedCatalogMembershipMinutes: 1_440,
    sourceSessions: 1, sourceCatalogControls: 97,
  };
});
const descriptorBody = {
  datasetVersion: 'daily-broad-archive-shard-dataset-1',
  sourceDatasetVersion: 'broad-day-dataset-v1', sourceDatasetId, sourceDatasetDigest,
  dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
  acceptedCatalogSnapshot: catalog, catalogProvenance,
  shardCount: MARKET_COUNT, expectedRows: MARKET_COUNT * 1_440, shards,
  traversalOrder: 'ACCEPTED_CATALOG_MARKET_IDENTITY_DIGEST_ASCENDING',
  completeness: 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY_STABLE_CATALOG',
  durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
  authority: 'NONE', learningEligible: false, simulationCredit: 0,
};
const datasetDigest = canonicalDigest(descriptorBody);
const descriptor = { ...descriptorBody, datasetDigest, datasetId: `dbasd-${datasetDigest}` };

const absent = (state, reason) => ({
  state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
  gapCount: 0, sourceDigests: [], reason,
});
const supportOf = (sourceDigest) => Object.fromEntries(SUPPORT_FAMILIES.map((family) => {
  if (family === 'CANDLES' || family === 'BASE_VOLUME') return [family, {
    state: 'COMPLETE', observedCount: 1_440, coverageStartTs: START,
    coverageEndTs: END, gapCount: 0, sourceDigests: [sourceDigest], reason: null,
  }];
  const unsupported = ['QUOTE_VOLUME', 'TRADES', 'TRADE_FLOW', 'SPREAD', 'DEPTH', 'CATALYST'].includes(family);
  return [family, absent(unsupported ? 'UNSUPPORTED' : 'MISSING', unsupported ? 'NOT_CAPTURED_BY_ARCHIVE' : 'TICKER_HISTORY_EXCLUDED')];
}));

function marketDayFor(shard, kind, { collapse = 90 } = {}) {
  const supportDigest = canonicalDigest({ shard: shard.shardDigest, kind, support: 'FULL_DAY_GRID' });
  const candles = Array.from({ length: 1_440 }, (_, minute) => {
    let close = 100;
    if (kind === 'SURGE' && minute === 100) close = 109;
    if (kind === 'SURGE' && minute > 100) close = collapse;
    if (kind === 'FALLING' && minute > 100) close = 90;
    if (kind === 'FLAT') close = minute % 2 ? 100.1 : 100;
    const prior = minute === 0 ? 100 : (kind === 'SURGE' && minute === 101 ? 109 : close);
    const periodStartTs = START + minute * MINUTE;
    return {
      observationId: `c-${shard.shardIndex}-${kind}-${minute}`,
      periodStartTs, periodEndTs: periodStartTs + MINUTE,
      open: prior, high: Math.max(prior, close), low: Math.min(prior, close), close,
      volumeBase: 1, volumeQuote: null, closed: true,
      receivedTs: periodStartTs + MINUTE + 10,
      knownAtTs: periodStartTs + MINUTE + 20,
      sourceDigest: canonicalDigest({ shard: shard.shardDigest, kind, minute, prior, close }),
    };
  });
  return { marketIdentityDigest: shard.marketIdentityDigest, priceEvents: [], candles, support: supportOf(supportDigest) };
}

function receiptFor(shard, marketDay) {
  const receipt = {
    receiptVersion: DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION, receiptDigest: '',
    datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
    shardId: shard.shardId, shardDigest: shard.shardDigest,
    marketIdentityDigest: shard.marketIdentityDigest,
    marketDayDigest: canonicalDigest(marketDay), rowCount: 1_440,
    serializedCandleBytes: 1_440, pages: 3,
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
  return receipt;
}

function sourceWith(load) {
  return {
    descriptor,
    async loadShard({ shardId, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'SHARD_CANCELLED' });
      const shard = shards.find((row) => row.shardId === shardId);
      if (!shard) throw Object.assign(new Error('missing'), { code: 'SHARD_NOT_FOUND' });
      return load(shard);
    },
    close() { return { closed: true }; },
  };
}

test('the real daily classifier keeps all 612 denominator rows while ACKing surge-collapse, falling, and flat shards with zero credit', async () => {
  const kinds = ['SURGE', 'FALLING', 'FLAT']; let loaded = 0;
  const source = sourceWith((shard) => {
    const marketDay = marketDayFor(shard, kinds[loaded] ?? 'FLAT'); loaded += 1;
    return { marketDay, receipt: receiptFor(shard, marketDay), release() { return { released: true }; } };
  });
  const classifier = createDailyShardedStudyClassifier({ manifest });
  const stateRoot = tempRoot('daily-shard-classifier-');
  const runner = await openDailyShardedStudyRunnerForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'classifier-full-denominator', declaredTs: AS_OF,
    consumeShard: classifier.consumeShard,
  }, { source });
  const result = await runner.execute({ maxShards: 3 });
  assert.equal(result.revision, 3); assert.equal(result.completed, false);
  await runner.close();
  const state = JSON.parse(readFileSync(path.join(stateRoot, 'state.json'), 'utf8'));
  assert.deepEqual(state.acknowledgments.map((row) => row.output.disposition), ['SURGE_CASE', 'FALLING_CONTROL', 'FLAT_CONTROL']);
  for (const ack of state.acknowledgments) {
    assert.equal(ack.output.acceptedDenominatorCount, 612);
    assert.equal(ack.output.observedMarketDayCount, 1);
    assert.equal(ack.output.placeholderMissingCount, 611);
    assert.equal(ack.output.matchedControlCount, 0);
    assert.equal(ack.output.globalControlMatchingState, 'DEFERRED_UNTIL_ALL_SHARD_CLASSIFICATIONS_ACKNOWLEDGED');
    assert.equal(ack.output.attemptedSimulations, 0);
    assert.equal(ack.output.completedSimulations, 0);
    assert.equal(ack.output.validSimulationOutcomes, 0);
    assert.equal(ack.output.learningEligible, false);
  }

  const original = state.acknowledgments[0].output;
  const changedDay = marketDayFor(shards[0], 'SURGE', { collapse: 80 });
  const changed = await classifier.consumeShard({
    job: state.job, shard: shards[0], marketDay: changedDay,
    receipt: receiptFor(shards[0], changedDay),
  });
  assert.equal(changed.anchorPrefixDigest, original.anchorPrefixDigest, 'post-breach collapse cannot enter the predeclared anchor prefix');
  assert.notEqual(changed.chronologyDigest, original.chronologyDigest, 'post-breach chronology remains retained outcome evidence');
  assert.notEqual(changed.classifiedCaseDigest, original.classifiedCaseDigest);
});

test('forged denominator/catalog fields and a replayed classification cannot satisfy the source job or ACK identity', async () => {
  const marketDay = marketDayFor(shards[0], 'SURGE');
  const source = sourceWith(() => ({ marketDay, receipt: receiptFor(shards[0], marketDay), release() {} }));
  const classifier = createDailyShardedStudyClassifier({ manifest });
  const stateRoot = tempRoot('daily-shard-binding-');
  const runner = await openDailyShardedStudyRunnerForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'classifier-binding', declaredTs: AS_OF, consumeShard: classifier.consumeShard,
  }, { source });
  await runner.execute({ maxShards: 1 }); await runner.close();
  const state = JSON.parse(readFileSync(path.join(stateRoot, 'state.json'), 'utf8'));
  const ack = state.acknowledgments[0];
  assert.match(dailyShardClassificationOutputError({ ...ack.output, acceptedDenominatorCount: 611, placeholderMissingCount: 610 }, {
    job: state.job, shard: shards[0], receipt: receiptFor(shards[0], marketDay),
  }), /denominator/);
  assert.match(dailyShardClassificationOutputError({ ...ack.output, catalogContentDigest: 'f'.repeat(64) }, {
    job: state.job, shard: shards[0], receipt: receiptFor(shards[0], marketDay),
  }), /denominator/);
  assert.match(dailyShardClassificationOutputError(ack.output, {
    job: state.job, shard: shards[1], receipt: { ...receiptFor(shards[0], marketDay), marketDayDigest: ack.marketDayDigest },
  }), /loaded source shard/);
  const changedDisposition = structuredClone(ack);
  changedDisposition.output.disposition = 'OTHER_OBSERVED';
  assert.match(dailyShardConsumerAckError(changedDisposition, {
    job: state.job, shard: shards[0], receipt: { receiptDigest: ack.receiptDigest, marketDayDigest: ack.marketDayDigest }, prior: null,
  }), /identity|digest/);
});

test('a content-bound but invalid market day or missing shard cannot advance durable classification progress', async () => {
  const classifier = createDailyShardedStudyClassifier({ manifest });
  const invalidDay = marketDayFor(shards[0], 'FLAT');
  invalidDay.support.CANDLES.observedCount -= 1;
  const invalidSource = sourceWith(() => ({
    marketDay: invalidDay, receipt: receiptFor(shards[0], invalidDay), release() {},
  }));
  const invalidRunner = await openDailyShardedStudyRunnerForTest({
    stateRoot: tempRoot('daily-shard-invalid-'), dayStartTs: START, dayEndTs: END,
    asOfTs: AS_OF, jobId: 'classifier-invalid', declaredTs: AS_OF,
    consumeShard: classifier.consumeShard,
  }, { source: invalidSource });
  await assert.rejects(invalidRunner.execute(), { code: 'SHARD_CLASSIFIER_MARKET_DAY_INVALID' });
  assert.equal(invalidRunner.status().revision, 0); await invalidRunner.close();

  const missingSource = sourceWith(() => { throw Object.assign(new Error('missing archive shard'), { code: 'SHARD_NOT_FOUND' }); });
  const missingRunner = await openDailyShardedStudyRunnerForTest({
    stateRoot: tempRoot('daily-shard-missing-'), dayStartTs: START, dayEndTs: END,
    asOfTs: AS_OF, jobId: 'classifier-missing', declaredTs: AS_OF,
    consumeShard: classifier.consumeShard,
  }, { source: missingSource });
  await assert.rejects(missingRunner.execute(), { code: 'SHARD_NOT_FOUND' });
  assert.equal(missingRunner.status().revision, 0); await missingRunner.close();
});

test('restart cannot mix classifications sealed under a changed retrospective manifest', async () => {
  const stateRoot = tempRoot('daily-shard-manifest-restart-');
  const source = sourceWith((shard) => {
    const marketDay = marketDayFor(shard, 'FLAT');
    return { marketDay, receipt: receiptFor(shard, marketDay), release() {} };
  });
  const first = await openDailyShardedStudyRunnerForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'classifier-manifest-restart', declaredTs: AS_OF,
    consumeShard: createDailyShardedStudyClassifier({ manifest }).consumeShard,
  }, { source });
  await first.execute(); await first.close();

  const changedManifest = sealDailyMoveStudyManifestV2({
    createdTs: AS_OF, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: catalog, catalogProvenance,
    rules: { maxDecisionFramesPerMarket: 1_400 },
  });
  const resumed = await openDailyShardedStudyRunnerForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'classifier-manifest-restart', declaredTs: AS_OF,
    consumeShard: createDailyShardedStudyClassifier({ manifest: changedManifest }).consumeShard,
  }, { source });
  await assert.rejects(resumed.execute(), /classification manifest changed/);
  assert.equal(resumed.status().revision, 1);
  await resumed.close();
});
