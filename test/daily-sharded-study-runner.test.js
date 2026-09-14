import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  BROAD_KRAKEN_RECORD_VERSION_V2, broadKrakenRecordIdOf,
} from '../market-lab/broad-kraken.js';
import { BROAD_DAY_ARCHIVE_VERSION_V2, openBroadDayArchive } from '../market-lab/broad-day-archive.js';
import { openBroadDayReader } from '../market-lab/broad-day-reader.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import {
  openDailyShardedStudyRunner as openDailyShardedStudyRunnerImpl, sealDailyShardTraversalOutput,
} from '../learning/daily-sharded-study-runner.js';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 4);
const END = START + 1_440 * MINUTE;
const AS_OF = END + MINUTE;
const roots = [];
const openDailyShardedStudyRunner = (options) => openDailyShardedStudyRunnerImpl({ ...options, openBroadDayReader });
let archiveRoot;
const makeRoot = (name) => {
  const root = mkdtempSync(path.join(tmpdir(), `sharded-runner-${name}-`)); roots.push(root); return root;
};
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('production runner refuses to choose a reader implementation implicitly', async () => {
  await assert.rejects(
    openDailyShardedStudyRunnerImpl({}),
    (error) => error?.code === 'RUNNER_READER_FACTORY_REQUIRED',
  );
});

function catalogAt(observedTs) {
  const result = normalizeKrakenAssetPairs({
    AAUSD: { wsname: 'AA/USD', base: 'AA', quote: 'USD', status: 'online' },
    BBUSD: { wsname: 'BB/USD', base: 'BB', quote: 'USD', status: 'online' },
    CCUSD: { wsname: 'CC/USD', base: 'CC', quote: 'USD', status: 'online' },
  }, { observedTs });
  assert.equal(result.ok, true); return result.catalog;
}

function recordOf(catalog, market, minute, sequence) {
  const periodStartTs = START + minute * MINUTE; const receivedTs = periodStartTs + MINUTE + 500;
  const close = 100 + (minute % 9) / 100;
  const record = {
    recordVersion: BROAD_KRAKEN_RECORD_VERSION_V2, recordId: null,
    sessionId: 'runner-source-session', sequence, recordType: 'OHLC', recordedTs: receivedTs + 10,
    catalogContentId: catalog.contentId, epochId: 'runner-source-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey, nativeBase: market.nativeBase,
      catalogWsname: market.wsname, wsSymbol: market.wsname,
    },
    channel: 'ohlc', quality: 'CONSERVATIVE_CLOSED', sourceEventTs: null,
    receivedTs, periodStartTs, periodEndTs: periodStartTs + MINUTE,
    payload: {
      open: close, high: close, low: close, close, volumeBase: 1, trades: 1, vwap: close,
      learningEligible: false, sourceClockBasis: 'DERIVED_PERIOD_END_NOT_PROVIDER_EVENT_TIME',
      finality: 'CONSERVATIVE_SAME_SYMBOL_NEXT_INTERVAL', messageType: 'closed',
    },
  };
  record.recordId = broadKrakenRecordIdOf(record); return record;
}

test.before(async () => {
  archiveRoot = makeRoot('archive'); let now = START - MINUTE; let sequence = 0; let catalog = catalogAt(now);
  const archive = openBroadDayArchive({
    rootDir: archiveRoot, formatVersion: BROAD_DAY_ARCHIVE_VERSION_V2, clock: () => now,
    limits: { maxQueueRows: 8_000, maxQueueBytes: 64 * 1024 * 1024, fsyncEveryEntries: 512 },
  });
  archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  for (let minute = 0; minute < 1_440; minute += 1) {
    if (minute > 0 && minute % 15 === 0) {
      now = START + minute * MINUTE + 520; catalog = catalogAt(now);
      archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
    }
    for (const market of catalog.markets) {
      const record = recordOf(catalog, market, minute, ++sequence); now = record.recordedTs;
      assert.equal(archive.tryAcceptRecord(record).accepted, true);
    }
    if (minute > 0 && minute % 300 === 0) await archive.drain();
  }
  now = END + 520; catalog = catalogAt(now);
  archive.tryAcceptCatalog({ catalog, sourceObservedTs: now, knownAtTs: now });
  archive.finalize({ cutoffTs: now }); await archive.close();
});

const goodConsumer = async ({ marketDay, receipt }) => sealDailyShardTraversalOutput({ marketDay, receipt });

test('durable market-bound acknowledgments resume without replay and never credit simulations', { timeout: 30_000 }, async () => {
  const stateRoot = makeRoot('resume'); const seen = [];
  let runner = await openDailyShardedStudyRunner({
    archiveRoot, stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'resume-job', declaredTs: AS_OF,
    consumeShard: async (input) => { seen.push(input.shard.shardId); return goodConsumer(input); },
  });
  const first = await runner.execute({ maxShards: 1 });
  assert.equal(first.status, 'CHECKPOINTED'); assert.equal(first.revision, 1);
  await runner.close();

  runner = await openDailyShardedStudyRunner({
    archiveRoot, stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'resume-job', declaredTs: AS_OF,
    consumeShard: async (input) => { seen.push(input.shard.shardId); return goodConsumer(input); },
  });
  const completed = await runner.execute({ maxShards: 64 });
  assert.equal(completed.status, 'COMPLETE'); assert.equal(completed.revision, 3);
  assert.equal(completed.acknowledgedShards, 3); assert.equal(completed.remainingShards, 0);
  assert.equal(new Set(seen).size, 3); assert.equal(seen.length, 3);
  const again = await runner.execute({ maxShards: 64 });
  assert.equal(again.revision, 3); assert.equal(seen.length, 3);
  await runner.close();
  const state = JSON.parse(readFileSync(path.join(stateRoot, 'state.json'), 'utf8'));
  assert.equal(state.completed, true); assert.equal(state.acknowledgments.length, 3);
  assert.ok(state.acknowledgments.every((ack) => ack.output.attemptedSimulations === 0
    && ack.output.completedSimulations === 0 && ack.output.validSimulationOutcomes === 0
    && ack.simulationCredit === 0));
});

test('consumer failure, malformed output and cancellation cannot advance durable progress', { timeout: 30_000 }, async () => {
  const stateRoot = makeRoot('refusal');
  let mode = 'throw';
  const runner = await openDailyShardedStudyRunner({
    archiveRoot, stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'refusal-job', declaredTs: AS_OF,
    consumeShard: async (input) => {
      if (mode === 'throw') throw Object.assign(new Error('consumer failed'), { code: 'TEST_CONSUMER_FAILED' });
      if (mode === 'credit') return { ...await goodConsumer(input), attemptedSimulations: 1 };
      return goodConsumer(input);
    },
  });
  await assert.rejects(runner.execute(), (error) => error.code === 'TEST_CONSUMER_FAILED');
  assert.equal(runner.status().revision, 0);
  mode = 'credit';
  await assert.rejects(runner.execute(), (error) => error.code === 'RUNNER_CONSUMER_OUTPUT_INVALID');
  assert.equal(runner.status().revision, 0);
  const controller = new AbortController(); controller.abort(); mode = 'good';
  const cancelled = await runner.execute({ signal: controller.signal });
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.revision, 0);
  const valid = await runner.execute(); assert.equal(valid.revision, 1);
  await runner.close();
});

test('corrupt middle acknowledgment refuses restart without overwriting preserved state', { timeout: 30_000 }, async () => {
  const stateRoot = makeRoot('corrupt');
  const runner = await openDailyShardedStudyRunner({
    archiveRoot, stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'corrupt-job', declaredTs: AS_OF, consumeShard: goodConsumer,
  });
  await runner.execute({ maxShards: 2 }); await runner.close();
  const stateFile = path.join(stateRoot, 'state.json'); const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.acknowledgments[0].output.resultState = 'FORGED_COMPLETE';
  const corruptText = JSON.stringify(state); writeFileSync(stateFile, corruptText);
  await assert.rejects(openDailyShardedStudyRunner({
    archiveRoot, stateRoot, dayStartTs: START, dayEndTs: END, asOfTs: AS_OF,
    jobId: 'corrupt-job', declaredTs: AS_OF, consumeShard: goodConsumer,
  }), (error) => error.code === 'RUNNER_STATE_INVALID');
  assert.equal(readFileSync(stateFile, 'utf8'), corruptText, 'invalid restart state must not be adopted or rewritten');
});

test('two guarded Node processes resume the same local traversal at the next durable shard', { timeout: 60_000 }, () => {
  const stateRoot = makeRoot('process');
  const fixture = fileURLToPath(new URL('./fixtures/daily-sharded-study-process.mjs', import.meta.url));
  const args = [archiveRoot, stateRoot, 'process-job', String(AS_OF), String(START), String(END), String(AS_OF)];
  const first = spawnSync(process.execPath, [fixture, ...args, '1'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(first.status, 0, first.stderr); const one = JSON.parse(first.stdout.trim());
  assert.equal(one.revision, 1); assert.equal(one.nextShardIndex, 1);
  const second = spawnSync(process.execPath, [fixture, ...args, '64'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(second.status, 0, second.stderr); const two = JSON.parse(second.stdout.trim());
  assert.equal(two.status, 'COMPLETE'); assert.equal(two.revision, 3); assert.equal(two.acknowledgedShards, 3);
});
