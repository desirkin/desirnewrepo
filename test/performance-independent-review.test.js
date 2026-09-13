import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDailyStudyProcessHost, isDailyStudyProcessResult,
} from '../tools/daily-study-process.js';
import { prepareDailyBroadInput } from '../learning/daily-broad-input.js';
import {
  buildDailyMoveStudy, sealDailyMoveStudyManifest,
} from '../learning/daily-move-study.js';
import {
  openDailyStudyStore, sealDailyStudyInputDescriptor,
  sealDailyStudyJobDescriptor,
} from '../learning/daily-study-store.js';
import {
  sealDailyStudyRunnerJob,
} from '../learning/daily-study-runner.js';
import {
  RUNTIME_PRESSURE_SAMPLE_VERSION, createRuntimePressureMonitor,
  evaluateLearningBudget,
} from '../lib/runtime-pressure.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 13, 18);
const START = Date.UTC(2025, 8, 13, 4);
const END = START + 24 * HOUR;
const FINAL = END + HOUR;
const MARKET_KEYS = ['pairKey', 'nativeBase', 'nativeQuote', 'wsname', 'base', 'quote', 'status'];

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const rawMarket = (base) => ({
  pairKey: `${base}USD`, nativeBase: `X${base}`, nativeQuote: 'ZUSD',
  wsname: `${base}/USD`, base, quote: 'USD', status: 'online',
});

function catalog() {
  const markets = [rawMarket('BTC'), rawMarket('ETH')];
  const value = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: START + 1, contentId: '', markets };
  const selected = markets.map((market) => Object.fromEntries(MARKET_KEYS.map((key) => [key, market[key]])));
  value.contentId = createHash('sha1').update(canonicalJson({
    venue: value.venue, quote: value.quote, policyVersion: value.policyVersion, markets: selected,
  })).digest('hex');
  return value;
}

function tickerRecord({ sequence, eventTs, price, sourceCatalog }) {
  const market = rawMarket('BTC');
  const value = {
    recordVersion: 'broad-kraken-record-v1', recordId: null,
    sessionId: 'performance-review-session', sequence, recordType: 'TICKER',
    recordedTs: eventTs + 2, catalogContentId: sourceCatalog.contentId,
    epochId: 'performance-review-epoch',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey,
      nativeBase: market.nativeBase, catalogWsname: market.wsname,
      wsSymbol: market.wsname,
    },
    channel: 'ticker', quality: 'OBSERVED', sourceEventTs: eventTs,
    receivedTs: eventTs + 1, periodStartTs: null, periodEndTs: null,
    payload: {
      messageType: 'update', lastPrice: price, bid: price - 1, ask: price + 1,
      bidQty: 2, askQty: 3, change24h: 1, changePct24h: 1,
      high24h: price + 5, low24h: price - 5, volume24hBase: 1000,
      vwap24h: price, tickerTimestampTs: eventTs, missingFields: [], invalidFields: [],
    },
  };
  value.recordId = `bkr-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  return value;
}

function capture() {
  const sourceCatalog = catalog();
  return {
    catalog: sourceCatalog,
    records: [
      tickerRecord({ sequence: 1, eventTs: START + HOUR, price: 100, sourceCatalog }),
      tickerRecord({ sequence: 2, eventTs: START + 2 * HOUR, price: 109, sourceCatalog }),
    ],
    dayStartTs: START, dayEndTs: END, finalizedTs: FINAL,
    captureStartTs: START, captureEndTs: FINAL, truncated: false,
  };
}

function declaration(jobId) {
  return sealDailyStudyRunnerJob({
    jobId, sourceId: 'performance-bounded-capture', declaredTs: FINAL,
    localDay: '2025-09-13', dayStartTs: START, dayEndTs: END,
  });
}

function fixtureRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-performance-independent-'));
  const inputs = path.join(root, 'inputs'); const outputs = path.join(root, 'outputs');
  mkdirSync(inputs); mkdirSync(outputs);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, inputs, outputs };
}

function writeFixture(dirs, name) {
  const captureFile = path.join(dirs.inputs, `${name}-capture.json`);
  const declarationFile = path.join(dirs.inputs, `${name}-declaration.json`);
  const outputDir = path.join(dirs.outputs, `${name}-store`);
  writeFileSync(captureFile, JSON.stringify(capture()));
  writeFileSync(declarationFile, JSON.stringify(declaration(`performance-${name}-2025-09-13`)));
  return { captureFile, declarationFile, outputDir };
}

function pressureSample(overrides = {}) {
  const base = {
    sampleVersion: RUNTIME_PRESSURE_SAMPLE_VERSION,
    observedTs: NOW, evaluatedTs: NOW, windowMs: 1_000,
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
    queue: { scope: 'INJECTED_LEARNING_QUEUE', observedTs: NOW, depth: 0, oldestAgeMs: 0 },
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

const progress = (phase, completedSteps, counters = null) => ({
  phase, completedSteps, totalSteps: 3,
  plannedDecisionMoments: counters?.plannedDecisionMoments ?? 0,
  grossPlannedRecipeVariantSlots: counters?.grossPlannedRecipeVariantSlots ?? 0,
  attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
  cancelled: false, note: `independent ${phase}`,
});

test('pressure decisions fail closed on forged clocks/scopes and separate queue production from worker dispatch', () => {
  for (const [candidate, reason] of [
    [null, 'SAMPLE_SHAPE_INVALID'],
    [pressureSample({ observedTs: -1, evaluatedTs: -1 }), 'SAMPLE_CLOCK_OR_BAND_INVALID'],
    [pressureSample({ observedTs: NOW - 15_001 }), 'SAMPLE_STALE'],
    [pressureSample({ observedTs: NOW + 1 }), 'SAMPLE_FROM_FUTURE'],
    [pressureSample({ cpu: { processUtilizationPct: Number.NaN } }), 'CPU_METRICS_MISSING_OR_NONFINITE'],
    [pressureSample({ cpu: { hostLoadPerCapacity: null } }), 'CPU_METRICS_MISSING_OR_NONFINITE'],
    [pressureSample({ queue: { observedTs: -1 } }), 'QUEUE_METRICS_MISSING_OR_NONFINITE'],
    [pressureSample({ aggregate: {
      scope: 'VERIFIED_VM_WORKER_GROUP', verified: true,
      observedTs: -1, cpuPct: 10, memoryUsedPct: 20,
    } }), 'AGGREGATE_METRICS_INVALID'],
  ]) {
    const result = evaluateLearningBudget(candidate);
    assert.equal(result.dispatchAdmission, 'HOLD', reason);
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons.join(',')}`);
  }

  const unavailableHostLoad = evaluateLearningBudget(pressureSample({
    cpu: { scope: 'PARENT_PROCESS_ONLY_HOST_LOAD_UNAVAILABLE', hostLoadPerCapacity: null },
  }));
  assert.equal(unavailableHostLoad.dispatchAdmission, 'ADMIT');

  const congested = evaluateLearningBudget(pressureSample({ queue: { depth: 4, oldestAgeMs: 1 } }));
  assert.equal(congested.dispatchAdmission, 'ADMIT', 'a healthy consumer must be allowed to drain');
  assert.equal(congested.producerAdmission, 'HOLD', 'queue pressure must stop new producers');

  const unprovenSecond = evaluateLearningBudget(pressureSample(), { maxStudyConcurrency: 2 });
  assert.equal(unprovenSecond.recommendedConcurrency, 1);
  const provenSecond = evaluateLearningBudget(pressureSample({
    capacity: {
      explicitScope: 'OPERATOR_VERIFIED_VM_CAPACITY', explicitVerified: true,
      explicitParallelism: 4,
    },
    aggregate: {
      scope: 'VERIFIED_VM_WORKER_GROUP', verified: true,
      observedTs: NOW, cpuPct: 20, memoryUsedPct: 30,
    },
  }), { maxStudyConcurrency: 2 });
  assert.equal(provenSecond.recommendedConcurrency, 2);
});

test('a failed pressure port stays latched without reinvocation until explicit stop/start', async () => {
  let calls = 0; let monotonic = 0;
  const monitor = createRuntimePressureMonitor({
    config: { minWindowMs: 10 }, clock: () => NOW,
    monotonicClock: () => { monotonic += 20; return monotonic; },
    sampleIntervalMs: 60_000,
    queueSample: () => {
      calls += 1;
      return calls === 1 ? { malformed: true }
        : { scope: 'INJECTED_LEARNING_QUEUE', observedTs: NOW, depth: 0, oldestAgeMs: 0 };
    },
  });
  monitor.start();
  const first = await monitor.sampleNow();
  assert.equal(first.decision.dispatchAdmission, 'HOLD');
  assert.equal(calls, 1);
  const latched = await monitor.sampleNow();
  assert.equal(latched.decision.dispatchAdmission, 'HOLD');
  assert.ok(latched.decision.reasons.includes('MONITOR_SAMPLE_FAILED'));
  assert.equal(calls, 1, 'a potentially uncooperative failed port is not started again');
  await monitor.stop();
  assert.equal(monitor.start(), true);
  await monitor.sampleNow();
  assert.equal(calls, 2, 'only an explicit lifecycle restart clears the port-failure latch');
  await monitor.stop();
});

test('the process host bounds queue/concurrency, reserves outputs, scrubs authority, and rejects forged summaries', async (t) => {
  const dirs = fixtureRoot(t);
  const a = writeFixture(dirs, 'a'); const b = writeFixture(dirs, 'b'); const c = writeFixture(dirs, 'c');
  const previousSecret = process.env.KRAKEN_INDEPENDENT_SECRET;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.KRAKEN_INDEPENDENT_SECRET = 'must-not-cross-child-boundary';
  process.env.NODE_OPTIONS = [previousNodeOptions, '--require=./hostile-independent-review-loader.js']
    .filter(Boolean).join(' ');
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
    maxConcurrency: 2, maxQueue: 2,
  });
  host.pauseAdmissions('independent saturation fixture');
  t.after(async () => {
    await host.close({ cancelQueued: true, cancelRunning: true });
    if (previousSecret === undefined) delete process.env.KRAKEN_INDEPENDENT_SECRET;
    else process.env.KRAKEN_INDEPENDENT_SECRET = previousSecret;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  });

  const one = host.submit(a);
  assert.throws(() => host.submit({ ...c, outputDir: a.outputDir }), (error) => error?.code === 'OUTPUT_DIR_BUSY');
  const two = host.submit(b);
  assert.throws(() => host.submit(c), (error) => error?.code === 'QUEUE_FULL');
  host.resumeAdmissions();
  const results = await Promise.all([one.result, two.result]);
  assert.equal(host.status().peakActive, 2);
  for (const result of results) {
    assert.equal(isDailyStudyProcessResult(result), true);
    assert.equal(result.authority, 'NONE');
    assert.equal(result.result.attemptedSimulations, 0);
    assert.equal(result.result.completedSimulations, 0);
    assert.equal(result.result.validSimulationOutcomes, 0);
    assert.equal(result.claims.learningAdopted, false);
    assert.equal(result.claims.tradingAuthority, false);
    assert.equal(result.environment.providerLikeKeyCount, 0);
    assert.equal(result.environment.unapprovedNodeOptionsPresent, false);
  }
  const forged = structuredClone(results[0]);
  forged.result.validSimulationOutcomes = 1;
  assert.equal(isDailyStudyProcessResult(forged), false);
  const forgedDigest = structuredClone(results[0]);
  forgedDigest.result.resultDigest = 'not-a-digest';
  assert.equal(isDailyStudyProcessResult(forgedDigest), false);
  const forgedManifestBinding = structuredClone(results[0]);
  forgedManifestBinding.result.manifestId = `dmstudy-${'e'.repeat(24)}`;
  assert.equal(isDailyStudyProcessResult(forgedManifestBinding), false);
});

test('accepted running cancellation settles only as cancellation/unknown interruption and cannot later resolve success', async (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs, 'cancel-running');
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
    maxRunMs: 1_000, killGraceMs: 10,
  });
  t.after(() => host.close({ cancelQueued: true, cancelRunning: true }));
  const ticket = host.submit(spec);
  assert.equal(ticket.cancel('independent running cancellation'), true);
  await assert.rejects(ticket.result, (error) => ['JOB_CANCELLED', 'INTERRUPTED_UNKNOWN'].includes(error?.code));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(host.status().active, 0);
  assert.equal(host.status().queued, 0);
});

test('malformed child input and a run timeout fail with bounded non-secret diagnostics and no late success', async (t) => {
  const dirs = fixtureRoot(t);
  const malformed = writeFixture(dirs, 'malformed-process-failure');
  const marker = 'provider-secret-must-not-appear';
  writeFileSync(malformed.declarationFile, `{${marker}`);
  const malformedHost = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
  });
  let malformedError;
  try {
    await malformedHost.submit(malformed).result;
  } catch (error) {
    malformedError = error;
  } finally {
    await malformedHost.close({ cancelQueued: true, cancelRunning: true });
  }
  assert.equal(malformedError?.code, 'INPUT_JSON_INVALID');
  assert.ok(JSON.stringify(malformedError).length < 2_000);
  assert.equal(JSON.stringify(malformedError).includes(marker), false);

  const timeoutSpec = writeFixture(dirs, 'timeout-process-failure');
  const timeoutHost = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
    maxRunMs: 10, killGraceMs: 10,
  });
  try {
    const ticket = timeoutHost.submit({ ...timeoutSpec, timeoutMs: 10 });
    await assert.rejects(ticket.result, (error) => ['RUN_TIMEOUT', 'INTERRUPTED_UNKNOWN'].includes(error?.code));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(timeoutHost.status().active, 0);
    assert.equal(timeoutHost.status().queued, 0);
  } finally {
    await timeoutHost.close({ cancelQueued: true, cancelRunning: true });
  }
});

test('receipt-free finalization independently rebuilds and rejects forged study/prepared input before durable success', async (t) => {
  const dirs = fixtureRoot(t); const rootDir = path.join(dirs.outputs, 'optimized-store');
  const sourceCapture = capture(); const preparedInput = prepareDailyBroadInput(sourceCapture);
  assert.equal(preparedInput.ok, true);
  const inputDescriptor = sealDailyStudyInputDescriptor({
    sourceId: 'performance-bounded-capture', capture: sourceCapture, preparedInput,
  });
  const manifest = sealDailyMoveStudyManifest({
    createdTs: FINAL, timeZone: 'America/New_York', localDay: '2025-09-13',
    dayStartTs: START, dayEndTs: END,
    acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
  });
  const jobDescriptor = sealDailyStudyJobDescriptor({
    jobId: 'performance-optimized-store', manifest, inputDescriptor,
  });
  const study = buildDailyMoveStudy({
    manifest, acceptedCatalogSnapshot: preparedInput.acceptedCatalogSnapshot,
    marketDays: preparedInput.marketDays,
  });
  let now = FINAL + 1;
  const store = await openDailyStudyStore({ rootDir, clock: () => now++ });
  try {
    let view = await store.createJob({ jobDescriptor });
    view = await store.checkpoint({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, progress: progress('INPUT_VALIDATED', 1),
    });
    view = await store.checkpoint({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, progress: progress('STUDY_BUILT', 2, study.counters),
    });
    view = await store.checkpoint({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, progress: progress('PLAN_COMPLETE', 3, study.counters),
    });

    const forgedStudy = structuredClone(study);
    forgedStudy.laws.moveDefinition = 'FORGED_STUDY_LAW';
    await assert.rejects(store.finalize({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, study: forgedStudy, preparedInput,
    }), (error) => error?.code === 'RESULT_INVALID');

    const forgedCounters = structuredClone(study);
    forgedCounters.counters.attemptedSimulations = 1;
    await assert.rejects(store.finalize({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, study: forgedCounters, preparedInput,
    }), (error) => error?.code === 'RESULT_INVALID');

    const wrongPrepared = structuredClone(preparedInput);
    wrongPrepared.diagnostics.recordCount += 1;
    await assert.rejects(store.finalize({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, study, preparedInput: wrongPrepared,
    }), (error) => error?.code === 'RESULT_INVALID');

    const finalized = await store.finalize({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: view.revision, study, preparedInput,
    });
    assert.equal(finalized.status, 'FINALIZED');
    assert.equal(finalized.result.attemptedSimulations, 0);
    assert.equal(finalized.result.completedSimulations, 0);
    assert.equal(finalized.result.validSimulationOutcomes, 0);

    const exactRetry = await store.finalize({
      jobId: jobDescriptor.jobId, jobDigest: jobDescriptor.jobDigest,
      expectedRevision: 0, resultReceipt: finalized.result,
    });
    assert.equal(exactRetry.status, 'EXISTING');
    assert.equal(exactRetry.result.resultDigest, finalized.result.resultDigest);
  } finally {
    await store.close();
  }
});
