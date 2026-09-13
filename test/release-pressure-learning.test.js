import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { prepareDailyBroadInput } from '../learning/daily-broad-input.js';
import {
  buildDailyDecisionFrame, buildDailyMoveStudy, sealDailyMoveStudyManifest,
} from '../learning/daily-move-study.js';
import { sealDailyStudyRunnerJob } from '../learning/daily-study-runner.js';
import {
  createDailyStudyProcessHost, isDailyStudyProcessResult,
} from '../tools/daily-study-process.js';
import {
  RUNTIME_PRESSURE_SAMPLE_VERSION, evaluateLearningBudget,
} from '../lib/runtime-pressure.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2025, 8, 13, 4);
const END = START + (24 * HOUR);
const FINAL = END + HOUR;
const PRESSURE_NOW = Date.UTC(2026, 8, 13, 18);
const MARKET_KEYS = ['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status'];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function rawMarket(index) {
  const base = `C${String(index).padStart(3, '0')}`;
  return {
    pairKey: `${base}USD`, nativeBase: base, nativeQuote: 'ZUSD',
    wsname: `${base}/USD`, base, quote: 'USD', status: 'online',
  };
}

function catalog(marketCount) {
  const markets = Array.from({ length: marketCount }, (_, index) => rawMarket(index));
  const value = {
    venue: 'kraken', quote: 'USD', policyVersion: 1,
    observedTs: START + 1, contentId: '', markets,
  };
  const selected = markets.map((market) => Object.fromEntries(MARKET_KEYS.map((key) => [key, market[key]])));
  value.contentId = createHash('sha1').update(canonicalJson({
    venue: value.venue, quote: value.quote, policyVersion: value.policyVersion, markets: selected,
  })).digest('hex');
  return value;
}

function tickerRecord({ market, sequence, eventTs, price, sourceCatalog, receivedTs = eventTs + 1 }) {
  const value = {
    recordVersion: 'broad-kraken-record-v1', recordId: null,
    sessionId: 'release-pressure-session', sequence, recordType: 'TICKER',
    recordedTs: receivedTs + 1, catalogContentId: sourceCatalog.contentId,
    epochId: 'release-pressure-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey,
      nativeBase: market.nativeBase, catalogWsname: market.wsname, wsSymbol: market.wsname,
    },
    channel: 'ticker', quality: 'OBSERVED', sourceEventTs: eventTs,
    receivedTs, periodStartTs: null, periodEndTs: null,
    payload: {
      messageType: 'update', lastPrice: price, bid: price - 0.01, ask: price + 0.01,
      bidQty: 2, askQty: 3, change24h: 1, changePct24h: 1,
      high24h: price + 1, low24h: Math.max(0.01, price - 1), volume24hBase: 1_000,
      vwap24h: price, tickerTimestampTs: eventTs, missingFields: [], invalidFields: [],
    },
  };
  value.recordId = `bkr-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  return value;
}

function boundedCapture({ marketCount = 2, observationsPerMarket = 2, lateSecond = false } = {}) {
  const sourceCatalog = catalog(marketCount);
  const records = [];
  let sequence = 0;
  for (let marketIndex = 0; marketIndex < marketCount; marketIndex += 1) {
    const market = sourceCatalog.markets[marketIndex];
    for (let observationIndex = 0; observationIndex < observationsPerMarket; observationIndex += 1) {
      const eventTs = START + ((observationIndex + 1) * MINUTE);
      const surge = marketIndex === 0 && observationIndex >= Math.floor(observationsPerMarket / 2);
      const price = surge ? 109 : 100 + ((observationIndex % 4) * 0.01);
      const receivedTs = lateSecond && observationIndex === 1
        ? START + (12 * HOUR) : eventTs + 1;
      records.push(tickerRecord({
        market, sequence: ++sequence, eventTs, price, sourceCatalog, receivedTs,
      }));
    }
  }
  return {
    catalog: sourceCatalog, records,
    dayStartTs: START, dayEndTs: END, finalizedTs: FINAL,
    captureStartTs: START, captureEndTs: FINAL, truncated: false,
  };
}

function declaration(jobId, sourceId = 'release-pressure-bounded-capture') {
  return sealDailyStudyRunnerJob({
    jobId, sourceId, declaredTs: FINAL,
    localDay: '2025-09-13', dayStartTs: START, dayEndTs: END,
  });
}

function fixtureRoot(t, label) {
  const root = mkdtempSync(path.join(tmpdir(), `serpent-release-pressure-${label}-`));
  const inputs = path.join(root, 'inputs');
  const outputs = path.join(root, 'outputs');
  mkdirSync(inputs); mkdirSync(outputs);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, inputs, outputs };
}

function writeFixture(dirs, { name, sourceCapture, jobId = `release-${name}` }) {
  const captureFile = path.join(dirs.inputs, `${name}-capture.json`);
  const declarationFile = path.join(dirs.inputs, `${name}-declaration.json`);
  const outputDir = path.join(dirs.outputs, `${name}-store`);
  writeFileSync(captureFile, JSON.stringify(sourceCapture));
  writeFileSync(declarationFile, JSON.stringify(declaration(jobId)));
  return { captureFile, declarationFile, outputDir };
}

function pressureSample(overrides = {}) {
  const base = {
    sampleVersion: RUNTIME_PRESSURE_SAMPLE_VERSION,
    observedTs: PRESSURE_NOW, evaluatedTs: PRESSURE_NOW, windowMs: 1_000,
    priorBand: null, priorProducerBand: null,
    capacity: {
      scope: 'PROCESS_VISIBLE_OS_AVAILABLE_PARALLELISM', verified: true,
      availableParallelism: 4, explicitScope: null,
      explicitVerified: false, explicitParallelism: null,
    },
    cpu: { scope: 'PARENT_PROCESS_PLUS_HOST_LOAD', processUtilizationPct: 20, hostLoadPerCapacity: 0.2 },
    memory: {
      scope: 'PARENT_PROCESS_RSS_PLUS_OS_HOST_MEMORY_NOT_VM_CGROUP',
      processRssBytes: 256 * 1024 * 1024, hostUsedPct: 40, cgroupUsedPct: null,
    },
    eventLoop: { scope: 'PARENT_NODE_EVENT_LOOP', utilizationPct: 10, p99LagMs: 5 },
    queue: { scope: 'INJECTED_LEARNING_QUEUE', observedTs: PRESSURE_NOW, depth: 0, oldestAgeMs: 0 },
    aggregate: null,
  };
  return {
    ...base, ...overrides,
    capacity: { ...base.capacity, ...(overrides.capacity ?? {}) },
    cpu: { ...base.cpu, ...(overrides.cpu ?? {}) },
    memory: { ...base.memory, ...(overrides.memory ?? {}) },
    eventLoop: { ...base.eventLoop, ...(overrides.eventLoop ?? {}) },
    queue: { ...base.queue, ...(overrides.queue ?? {}) },
  };
}

test('a substantial bounded planner job is pressure-gated, isolated, zero-credit, and leaves the parent event loop responsive', { timeout: 60_000 }, async (t) => {
  const dirs = fixtureRoot(t, 'load');
  const sourceCapture = boundedCapture({ marketCount: 80, observationsPerMarket: 240 });
  const spec = writeFixture(dirs, { name: 'load', sourceCapture });
  const physicalBytes = Buffer.byteLength(JSON.stringify(sourceCapture), 'utf8');
  assert.ok(physicalBytes > 8 * 1024 * 1024, `fixture was only ${physicalBytes} bytes`);
  assert.ok(physicalBytes < 32 * 1024 * 1024, `fixture crossed the bounded input law: ${physicalBytes}`);

  let decision = evaluateLearningBudget(pressureSample({ cpu: { processUtilizationPct: 90 } }));
  assert.equal(decision.dispatchAdmission, 'HOLD');
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs, maxConcurrency: 1, maxQueue: 1,
    canStart: () => ({
      allowed: decision.dispatchAdmission === 'ADMIT',
      reason: decision.reasons.join('|') || 'PRESSURE_HOLD',
    }),
  });
  t.after(() => host.close({ cancelQueued: true, cancelRunning: true }));

  let ticks = 0; let maxDelayMs = 0; let last = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, now - last - 10);
    last = now; ticks += 1;
  }, 10);
  t.after(() => clearInterval(heartbeat));

  const ticket = host.submit(spec);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(host.status().queued, 1, 'high pressure must defer the heavy child before dispatch');
  const ticksBeforeDispatch = ticks;
  decision = evaluateLearningBudget(pressureSample());
  assert.equal(decision.dispatchAdmission, 'ADMIT');
  host.resumeAdmissions();
  const result = await ticket.result;
  clearInterval(heartbeat);

  assert.equal(isDailyStudyProcessResult(result), true);
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.result.caseCount, 80);
  assert.equal(result.result.attemptedSimulations, 0);
  assert.equal(result.result.completedSimulations, 0);
  assert.equal(result.result.validSimulationOutcomes, 0);
  assert.equal(result.claims.fullDayStudyComplete, false);
  assert.equal(result.claims.learningAdopted, false);
  assert.equal(result.claims.tradingAuthority, false);
  assert.equal(result.inputAccounting.boundedPartialCaptureOnly, true);
  assert.equal(host.status().peakActive, 1);
  assert.ok(ticks - ticksBeforeDispatch >= 3, `parent heartbeat advanced only ${ticks - ticksBeforeDispatch} ticks during child work`);
  assert.ok(maxDelayMs < 750, `parent heartbeat stalled for ${maxDelayMs.toFixed(1)} ms`);
  await host.close();
});

test('late-known surge evidence stays out of earlier decision frames even though retrospective labeling can observe it later', () => {
  const sourceCapture = boundedCapture({ marketCount: 1, observationsPerMarket: 2, lateSecond: true });
  const prepared = prepareDailyBroadInput(sourceCapture);
  assert.equal(prepared.ok, true, prepared.detail);
  const manifest = sealDailyMoveStudyManifest({
    createdTs: FINAL, timeZone: 'America/New_York', localDay: '2025-09-13',
    dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot,
  });
  const marketDay = prepared.marketDays[0];
  const beforeReceipt = buildDailyDecisionFrame({
    manifest, marketDay, decisionTs: START + (3 * HOUR),
  });
  const afterReceipt = buildDailyDecisionFrame({
    manifest, marketDay, decisionTs: START + (13 * HOUR),
  });
  assert.equal(beforeReceipt.observedPriceEvents, 1);
  assert.equal(afterReceipt.observedPriceEvents, 2);
  assert.ok(beforeReceipt.knownAtCeilingTs <= beforeReceipt.decisionTs);
  assert.ok(afterReceipt.knownAtCeilingTs <= afterReceipt.decisionTs);
  assert.notEqual(beforeReceipt.prefixDigest, afterReceipt.prefixDigest);
  assert.equal(beforeReceipt.retrospectiveLabelsIncluded, false);

  const study = buildDailyMoveStudy({
    manifest, acceptedCatalogSnapshot: prepared.acceptedCatalogSnapshot,
    marketDays: prepared.marketDays,
  });
  assert.equal(study.cases[0].retrospectiveLabels.disposition, 'SURGE_CASE');
  for (const frame of study.cases[0].retrospectiveReplay.decisionFrames) {
    assert.ok(frame.knownAtCeilingTs <= frame.decisionTs, `${frame.knownAtCeilingTs} > ${frame.decisionTs}`);
    assert.equal(frame.retrospectiveLabelsIncluded, false);
  }
});

test('duplicate input is wholly refused and a completed job cannot be rebound to conflicting capture content', { timeout: 30_000 }, async (t) => {
  const sourceCapture = boundedCapture();
  const duplicate = prepareDailyBroadInput({
    ...sourceCapture, records: [...sourceCapture.records, structuredClone(sourceCapture.records[0])],
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'DUPLICATE_RECORD');
  assert.equal('marketDays' in duplicate, false, 'a duplicate may not yield a usable prefix');

  const dirs = fixtureRoot(t, 'conflict');
  const spec = writeFixture(dirs, { name: 'conflict', sourceCapture, jobId: 'release-content-conflict' });
  const host = createDailyStudyProcessHost({ inputRoot: dirs.inputs, outputRoot: dirs.outputs });
  t.after(() => host.close({ cancelQueued: true, cancelRunning: true }));
  const first = await host.submit(spec).result;
  const exactRetry = await host.submit(spec).result;
  assert.equal(first.status, 'FINALIZED');
  assert.equal(exactRetry.status, 'EXISTING_FINALIZED');
  assert.equal(exactRetry.result.resultDigest, first.result.resultDigest);

  const conflicting = structuredClone(sourceCapture);
  const target = conflicting.records.at(-1);
  target.payload.lastPrice = 111;
  target.payload.bid = 110.99; target.payload.ask = 111.01;
  target.payload.high24h = 112; target.payload.low24h = 110; target.payload.vwap24h = 111;
  target.recordId = null;
  target.recordId = `bkr-${createHash('sha256').update(JSON.stringify(target)).digest('hex')}`;
  writeFileSync(spec.captureFile, JSON.stringify(conflicting));
  await assert.rejects(host.submit(spec).result, (error) => (
    error?.code === 'JOB_ID_CONFLICT' || error?.code === 'JOB_CONTENT_CONFLICT'
  ));
  await host.close();
});

test('queued timeout and cancellation settle without starting heavy work or publishing late receipt state', { timeout: 10_000 }, async (t) => {
  const dirs = fixtureRoot(t, 'interrupt');
  const sourceCapture = boundedCapture({ marketCount: 40, observationsPerMarket: 120 });
  const cancelledSpec = writeFixture(dirs, { name: 'cancelled', sourceCapture });
  const timeoutSpec = writeFixture(dirs, {
    name: 'timed-out', sourceCapture, jobId: 'release-queued-timeout',
  });
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
    maxConcurrency: 1, maxQueue: 2, maxQueueWaitMs: 25,
  });
  host.pauseAdmissions('deterministic release-pressure interruption');
  const cancelled = host.submit(cancelledSpec);
  const timedOut = host.submit(timeoutSpec);
  assert.equal(cancelled.cancel('release pressure cancellation'), true);
  await assert.rejects(cancelled.result, (error) => error?.code === 'JOB_CANCELLED');
  await assert.rejects(timedOut.result, (error) => error?.code === 'QUEUE_TIMEOUT');
  assert.equal(host.status().active, 0);
  assert.equal(host.status().queued, 0);
  assert.equal(existsSync(cancelledSpec.outputDir), false);
  assert.equal(existsSync(timeoutSpec.outputDir), false);
  await host.close();
});
