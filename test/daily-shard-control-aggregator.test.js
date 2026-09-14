import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  openDailyShardControlAggregatorForTest,
} from '../learning/daily-shard-control-aggregator.js';
import { createDailyShardedStudyClassifier } from '../learning/daily-sharded-study-classifier.js';
import { openDailyShardedStudyRunnerForTest } from '../learning/daily-sharded-study-runner.js';
import { DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION } from '../learning/daily-broad-archive-shards.js';
import { sealDailyMoveStudyManifestV2, SUPPORT_FAMILIES } from '../learning/daily-move-study.js';
import { canonicalDigest } from '../learning/shadow-contracts.js';
import { marketIdentityDigest, sealAcceptedCatalogSnapshot } from '../learning/shadow-catalog-snapshot.js';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 1_440 * MINUTE;
const AS_OF = END + MINUTE;
const roots = [];
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const tempRoot = (name) => { const root = mkdtempSync(path.join(tmpdir(), name)); roots.push(root); return root; };
const kinds = ['SURGE', 'FALLING', 'FLAT', 'FAILED', 'OTHER', 'EXACT_EIGHT'];

function fixtureDefinition(kindList = kinds) {
  const catalog = sealAcceptedCatalogSnapshot({
    observedTs: START, knownAtTs: START + 1, maxAgeMs: 24 * 60 * MINUTE,
    markets: Array.from({ length: kindList.length }, (_, index) => {
      const coin = `A${index}`;
      return {
        subjectKind: 'MARKET', canonicalCoin: coin, providerAssetId: `${coin}USD`,
        venue: 'kraken', nativeSymbol: `${coin}/USD`, base: coin, quote: 'USD',
        marketType: 'SPOT', quoteAliasGroup: 'USD',
      };
    }),
  });
  const sourceDatasetDigest = canonicalDigest({ fixture: 'daily-control-aggregate' });
  const sourceDatasetId = `bdd-${sourceDatasetDigest}`;
  const catalogEpochDigest = canonicalDigest({ epoch: catalog.contentDigest });
  const catalogProvenance = {
    provenanceVersion: 'daily-broad-archive-provenance-1', state: 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY',
    provenanceVerified: true, durableFullDayEpochUnionVerified: true,
    sourceDatasetVersion: 'broad-day-dataset-v1', sourceDatasetId, sourceDatasetDigest,
    sourceArchiveVersion: 'broad-day-archive-local-v2', catalogEpochDigest,
    catalogUnionContentDigest: catalog.contentDigest, durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    warning: 'Local test archive only; no external custody or prospective qualification.',
  };
  const manifest = sealDailyMoveStudyManifestV2({
    createdTs: AS_OF, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: catalog, catalogProvenance,
  });
  const shards = catalog.markets.map((market, index) => {
    const marketDigest = marketIdentityDigest(market);
    const shardDigest = canonicalDigest({ sourceDatasetDigest, marketDigest, index });
    return {
      shardVersion: 'daily-broad-archive-market-shard-1', shardId: `dbams-${shardDigest}`,
      shardDigest, sourceDatasetId, sourceDatasetDigest, shardIndex: index,
      sourceMarketIdentityDigest: marketDigest, marketIdentityDigest: marketDigest,
      market, expectedRows: 1_440, expectedCatalogMembershipMinutes: 1_440,
      sourceSessions: 1, sourceCatalogControls: 97,
    };
  });
  const descriptorBody = {
    datasetVersion: 'daily-broad-archive-shard-dataset-1', sourceDatasetVersion: 'broad-day-dataset-v1',
    sourceDatasetId, sourceDatasetDigest, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    acceptedCatalogSnapshot: catalog, catalogProvenance, shardCount: shards.length,
    expectedRows: shards.length * 1_440, shards,
    traversalOrder: 'ACCEPTED_CATALOG_MARKET_IDENTITY_DIGEST_ASCENDING',
    completeness: 'VERIFIED_LOCAL_V2_ARCHIVE_FULL_DAY_STABLE_CATALOG',
    durability: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false,
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
  };
  const datasetDigest = canonicalDigest(descriptorBody);
  const descriptor = { ...descriptorBody, datasetDigest, datasetId: `dbasd-${datasetDigest}` };
  return { catalog, catalogProvenance, manifest, shards, descriptor, kindList };
}

const absent = (state, reason) => ({
  state, observedCount: 0, coverageStartTs: null, coverageEndTs: null,
  gapCount: 0, sourceDigests: [], reason,
});

function marketDayFor(shard, kind) {
  const supportDigest = canonicalDigest({ shard: shard.shardDigest, support: 'FULL_DAY' });
  const candles = Array.from({ length: 1_440 }, (_, minute) => {
    let close = 100;
    if (kind === 'SURGE' && minute === 100) close = 109;
    else if (kind === 'SURGE' && minute > 100) close = 90;
    else if (kind === 'FALLING' && minute > 100) close = 90;
    else if (kind === 'FLAT') close = minute % 2 ? 100.1 : 100;
    else if (kind === 'FAILED' && minute === 100) close = 105;
    else if (kind === 'FAILED' && minute > 100) close = 99;
    else if (kind === 'OTHER' && minute > 100) close = 102;
    else if (kind === 'EXACT_EIGHT' && minute > 100) close = 108;
    let open = close;
    if (minute === 100) open = 100;
    if (minute === 101 && kind === 'SURGE') open = 109;
    if (minute === 101 && kind === 'FAILED') open = 105;
    const periodStartTs = START + minute * MINUTE;
    return {
      observationId: `agg-${shard.shardIndex}-${minute}`, periodStartTs,
      periodEndTs: periodStartTs + MINUTE, open, high: Math.max(open, close),
      low: Math.min(open, close), close, volumeBase: 1, volumeQuote: null, closed: true,
      receivedTs: periodStartTs + MINUTE + 10, knownAtTs: periodStartTs + MINUTE + 20,
      sourceDigest: canonicalDigest({ shard: shard.shardDigest, minute, open, close }),
    };
  });
  const support = Object.fromEntries(SUPPORT_FAMILIES.map((family) => {
    if (family === 'CANDLES' || family === 'BASE_VOLUME') return [family, {
      state: 'COMPLETE', observedCount: 1_440, coverageStartTs: START, coverageEndTs: END,
      gapCount: 0, sourceDigests: [supportDigest], reason: null,
    }];
    const unsupported = family !== 'PRICE';
    return [family, absent(unsupported ? 'UNSUPPORTED' : 'MISSING', unsupported ? 'ARCHIVE_FAMILY_UNSUPPORTED' : 'TICKER_HISTORY_EXCLUDED')];
  }));
  return { marketIdentityDigest: shard.marketIdentityDigest, priceEvents: [], candles, support };
}

function receiptFor(descriptor, shard, marketDay) {
  const value = {
    receiptVersion: DAILY_BROAD_ARCHIVE_MARKET_DAY_VERSION, receiptDigest: '',
    datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
    shardId: shard.shardId, shardDigest: shard.shardDigest,
    marketIdentityDigest: shard.marketIdentityDigest, marketDayDigest: canonicalDigest(marketDay),
    rowCount: 1_440, serializedCandleBytes: 1_440, pages: 3,
    byteBasis: 'SUM_UTF8_JSON_BYTES_OF_CANDLE_PROJECTIONS;NOT_PROCESS_HEAP_OR_CONTAINER_OVERHEAD',
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
  };
  value.receiptDigest = canonicalDigest({
    receiptVersion: value.receiptVersion, datasetId: value.datasetId, datasetDigest: value.datasetDigest,
    shardId: value.shardId, shardDigest: value.shardDigest,
    marketIdentityDigest: value.marketIdentityDigest, marketDayDigest: value.marketDayDigest,
    rowCount: value.rowCount, authority: value.authority,
    learningEligible: value.learningEligible, simulationCredit: value.simulationCredit,
  });
  return value;
}

function makeSource(definition, { missingIndex = null, changedDescriptor = null } = {}) {
  const descriptor = changedDescriptor ?? definition.descriptor;
  return {
    descriptor,
    async loadShard({ shardId, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'SHARD_CANCELLED' });
      const index = descriptor.shards.findIndex((row) => row.shardId === shardId);
      if (index < 0 || index === missingIndex) throw Object.assign(new Error('missing'), { code: 'SHARD_NOT_FOUND' });
      const shard = descriptor.shards[index]; const marketDay = marketDayFor(shard, definition.kindList[index]);
      return { marketDay, receipt: receiptFor(descriptor, shard, marketDay), release() { return { released: true }; } };
    },
    close() { return { closed: true }; },
  };
}

async function classifiedFixture(kindList = kinds) {
  const definition = fixtureDefinition(kindList); const source = makeSource(definition);
  const runnerRoot = tempRoot('daily-control-classifier-');
  const runner = await openDailyShardedStudyRunnerForTest({
    stateRoot: runnerRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'control-aggregate-classifier', declaredTs: AS_OF,
    consumeShard: createDailyShardedStudyClassifier({ manifest: definition.manifest }).consumeShard,
  }, { source });
  const done = await runner.execute({ maxShards: kindList.length });
  assert.equal(done.completed, true); await runner.close();
  const runnerState = JSON.parse(readFileSync(path.join(runnerRoot, 'state.json'), 'utf8'));
  return { definition, runnerState };
}

test('complete classifier ACKs persist one prefix artifact at a time, restart, and match falling/flat/failed controls with zero credit', async () => {
  const { definition, runnerState } = await classifiedFixture();
  const stateRoot = tempRoot('daily-control-aggregate-');
  const first = await openDailyShardControlAggregatorForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) });
  const cancelled = new AbortController(); cancelled.abort();
  const held = await first.execute({ signal: cancelled.signal }); assert.equal(held.status, 'CANCELLED');
  assert.equal(held.revision, 0);
  const partial = await first.execute({ maxShards: 2 }); assert.equal(partial.revision, 2); assert.equal(partial.completed, false);
  await first.close();

  const resumed = await openDailyShardControlAggregatorForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) });
  const done = await resumed.execute({ maxShards: 6 });
  assert.equal(done.completed, true); assert.equal(done.revision, 6);
  assert.equal(done.result.acceptedDenominatorCount, 6);
  assert.equal(done.result.artifactCount, 6); assert.equal(done.result.surgeCount, 1);
  assert.deepEqual(new Set(done.result.controlMatches[0].matches.map((row) => row.controlClass)), new Set([
    'FAILED_BREAKOUT_CONTROL', 'FALLING_CONTROL', 'FLAT_CONTROL',
  ]));
  assert.equal(done.result.controlMatches[0].missingClasses.length, 0);
  assert.equal(done.result.attemptedSimulations, 0); assert.equal(done.result.completedSimulations, 0);
  assert.equal(done.result.validSimulationOutcomes, 0); assert.equal(done.result.learningEligible, false);
  await resumed.close();

  const replay = await openDailyShardControlAggregatorForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) });
  assert.equal(replay.status().result.resultDigest, done.result.resultDigest);
  await replay.close();
});

test('incomplete/mixed/forged classifier inventories and missing source shards refuse without creating qualified results', async () => {
  const { definition, runnerState } = await classifiedFixture();
  await assert.rejects(openDailyShardControlAggregatorForTest({
    stateRoot: tempRoot('daily-control-partial-'), dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest,
    runnerState: { ...runnerState, completed: false, acknowledgments: runnerState.acknowledgments.slice(0, -1) },
  }, { source: makeSource(definition) }), { code: 'CONTROL_CLASSIFICATION_INCOMPLETE' });

  const changedDescriptor = structuredClone(definition.descriptor);
  changedDescriptor.datasetDigest = 'f'.repeat(64); changedDescriptor.datasetId = `dbasd-${changedDescriptor.datasetDigest}`;
  await assert.rejects(openDailyShardControlAggregatorForTest({
    stateRoot: tempRoot('daily-control-mixed-'), dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition, { changedDescriptor }) }), { code: 'CONTROL_SOURCE_BINDING_INVALID' });

  const forged = structuredClone(runnerState);
  forged.acknowledgments[2].output.catalogContentDigest = 'e'.repeat(64);
  await assert.rejects(openDailyShardControlAggregatorForTest({
    stateRoot: tempRoot('daily-control-forged-'), dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState: forged,
  }, { source: makeSource(definition) }), { code: 'PREFIX_ACK_INVENTORY_INVALID' });

  const missingRoot = tempRoot('daily-control-missing-shard-');
  const missing = await openDailyShardControlAggregatorForTest({
    stateRoot: missingRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition, { missingIndex: 2 }) });
  await assert.rejects(missing.execute({ maxShards: 6 }), { code: 'SHARD_NOT_FOUND' });
  assert.equal(missing.status().revision, 2); assert.equal(missing.status().result, null); await missing.close();
});

test('corrupt or absent middle artifacts and a changed whole-day manifest refuse deterministic restart', async () => {
  const { definition, runnerState } = await classifiedFixture();
  const stateRoot = tempRoot('daily-control-corruption-');
  const aggregate = await openDailyShardControlAggregatorForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) });
  const done = await aggregate.execute({ maxShards: 6 }); assert.equal(done.completed, true); await aggregate.close();

  const middle = path.join(stateRoot, 'artifacts', '00002.json');
  const original = readFileSync(middle, 'utf8'); writeFileSync(middle, `${original.slice(0, -4)}xxxx`, 'utf8');
  await assert.rejects(openDailyShardControlAggregatorForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) }), /CONTROL_ARTIFACT_CORRUPT/);
  writeFileSync(middle, original, 'utf8'); unlinkSync(middle);
  await assert.rejects(openDailyShardControlAggregatorForTest({
    stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) }), /CONTROL_ARTIFACT_MISSING/);

  const changedManifest = sealDailyMoveStudyManifestV2({
    createdTs: AS_OF, localDay: '2026-09-13', dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: definition.catalog, catalogProvenance: definition.catalogProvenance,
    rules: { flatRangePct: 1.5 },
  });
  await assert.rejects(openDailyShardControlAggregatorForTest({
    stateRoot: tempRoot('daily-control-changed-job-'), dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    manifest: changedManifest, runnerState,
  }, { source: makeSource(definition) }), { code: 'CONTROL_SOURCE_BINDING_INVALID' });
});

test('a complete day with no surge anchors remains a valid empty retrospective match census', async () => {
  const { definition, runnerState } = await classifiedFixture(['FLAT', 'FALLING', 'OTHER']);
  const aggregate = await openDailyShardControlAggregatorForTest({
    stateRoot: tempRoot('daily-control-no-surge-'), dayStartTs: START, dayEndTs: END,
    asOfTs: AS_OF, manifest: definition.manifest, runnerState,
  }, { source: makeSource(definition) });
  const done = await aggregate.execute({ maxShards: 3 });
  assert.equal(done.completed, true); assert.equal(done.result.surgeCount, 0);
  assert.deepEqual(done.result.controlMatches, []); assert.equal(done.result.missingControlMatches, 0);
  assert.equal(done.result.simulationCredit, 0); await aggregate.close();
});
