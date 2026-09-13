import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseDailyStudyOfflineArgs, runDailyStudyOffline,
} from '../tools/daily-study-offline.mjs';
import { sealDailyStudyRunnerJob } from '../learning/daily-study-runner.js';
import { stableStringify } from '../learning/shadow-contracts.js';

const args = ['--capture', 'capture.json', '--declaration', 'job.json', '--output-dir', 'receipts'];
const safeSummary = () => ({
  processVersion: 'daily-study-process-1', executionModel: 'ONE_CHILD_PROCESS_PER_JOB', spawnOverheadPerJob: true,
  status: 'FINALIZED', jobId: 'cli-unit-test', jobDigest: 'a'.repeat(64), revision: 4,
  progress: { phase: 'FINALIZED', completedSteps: 3, totalSteps: 3, plannedDecisionMoments: 0,
    grossPlannedRecipeVariantSlots: 0, attemptedSimulations: 0, completedSimulations: 0,
    validSimulationOutcomes: 0, cancelled: false, note: null, updatedTs: 1 },
  result: { resultVersion: 'daily-study-result-receipt-1', resultId: `dailyresult-${'b'.repeat(32)}`,
    resultDigest: 'b'.repeat(64), jobId: 'cli-unit-test', jobDigest: 'a'.repeat(64),
    manifestId: `dmstudy-${'c'.repeat(24)}`, manifestDigest: 'c'.repeat(64), studyVersion: 'daily-move-study-1',
    studyDigest: 'd'.repeat(64), studyBytes: 0, caseCount: 0, plannedDecisionMoments: 0, grossPlannedRecipeVariantSlots: 0,
    attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
    fullDetailCasesClaimed: 0, resultMode: 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY',
    externalArchive: 'UNKNOWN', authority: 'NONE', purpose: 'RESEARCH_ONLY' },
  detailedStudyReturned: false, detailedStudyPersistedByReceiptStore: false,
  durability: { scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN' },
  authority: 'NONE', purpose: 'RESEARCH_ONLY',
  inputAccounting: { physicalBytes: 1000, decodedStringBytesUpperBound: 2000, boundedPartialCaptureOnly: true },
  resourceBoundary: { v8OldSpaceLimitMb: 256, wholeProcessRssHardCap: false, inputPreflightBeforeJsonParse: true },
  environment: { inheritedKeys: [], fixedAllowlistOnly: true, nodeOptionsPresent: false,
    nodePathPresent: false, providerLikeKeyCount: 0, testOfflineGuardActive: false, unapprovedNodeOptionsPresent: false },
  claims: { fullDayCatalogContinuityVerified: false, fullDayStudyComplete: false,
    tradingAuthority: false, learningAdopted: false,
    simulationsAttempted: 0, simulationsCompleted: 0, validSimulationOutcomes: 0 }, cancelRequested: false,
});
function harness({ admitted = true, summary = safeSummary(), rejection = null } = {}) {
  const output = []; const errors = []; const signals = new EventEmitter();
  let monitorOptions; let hostOptions; let resolve; let reject; let queued = 0;
  let closed = false; let stopped = false; let status = 'UNVERIFIED';
  const fakeHost = {
    pauseAdmissions() {},
    resumeAdmissions() { if (hostOptions.canStart() && queued) {
      queued = 0; rejection ? reject(rejection) : resolve(summary);
    } },
    status: () => ({ queued }),
    submit: () => {
      queued = 1;
      const result = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { result, cancel() { queued = 0; reject(Object.assign(new Error('cancelled'), { code: 'JOB_CANCELLED' })); } };
    },
    async close() { closed = true; },
  };
  const dependencies = { stdout: { write: (s) => output.push(s) }, stderr: { write: (s) => errors.push(s) },
    signalSource: signals,
    createHost: (options) => { hostOptions = options; return fakeHost; },
    createMonitor: (options) => { monitorOptions = options; return {
      start() { queueMicrotask(() => { status = admitted ? 'ADMIT' : 'HOLD'; options.onSample(); }); },
      evaluate: () => ({ admission: status }),
      async stop() { stopped = true; },
    }; },
  };
  return { dependencies, output, errors, signals, host: fakeHost,
    get hostOptions() { return hostOptions; }, get monitorOptions() { return monitorOptions; },
    get cleaned() { return closed && stopped; } };
}

test('offline CLI argument contract has no production or arbitrary-command switches', () => {
  const parsed = parseDailyStudyOfflineArgs(args);
  assert.equal(parsed.timeoutMs, 120_000); assert.equal(parsed.admissionTimeoutMs, 30_000);
  assert.ok(path.isAbsolute(parsed.captureFile));
  for (const bad of [[], [...args, '--publish'], [...args, '--max-concurrency', '4'],
    [...args, '--capture', 'other.json'], [...args, '--timeout-ms', 'NaN'],
    [...args, '--timeout-ms', '600001'], [...args, '--help'], ['--help', '--publish'],
    [...args.slice(0, -1), 'bad\0path']]) {
    assert.throws(() => parseDailyStudyOfflineArgs(bad));
  }
});

test('help and malformed arguments never construct a host or monitor', async () => {
  let writes = '';
  const dep = { stdout: { write: (s) => { writes += s; } }, stderr: { write: () => {} },
    createHost() { throw new Error('must not construct'); }, createMonitor() { throw new Error('must not construct'); } };
  assert.equal(await runDailyStudyOffline(['--help'], dep), 0);
  assert.match(writes, /not collect feeds/);
  assert.equal(await runDailyStudyOffline(['--publish'], dep), 2);
});

test('one-worker composition checks fresh admission and cleans signal listeners', async () => {
  const fx = harness();
  assert.equal(await runDailyStudyOffline(args, fx.dependencies), 0);
  assert.equal(fx.hostOptions.maxConcurrency, 1); assert.equal(fx.hostOptions.maxQueue, 1);
  const report = JSON.parse(fx.output.join(''));
  assert.equal(report.status, 'COMPLETED_RESEARCH_ONLY');
  assert.equal(report.simulationsExecuted, 0); assert.equal(report.productionChanged, false);
  assert.equal(report.productionPerformanceVerified, false); assert.equal(fx.cleaned, true);
  assert.equal(fx.signals.listenerCount('SIGINT'), 0); assert.equal(fx.signals.listenerCount('SIGTERM'), 0);
});

test('held pressure never bypasses admission; an operator signal cancels and drains', async () => {
  const fx = harness({ admitted: false });
  const task = runDailyStudyOffline(args, fx.dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.host.status().queued, 1);
  fx.signals.emit('SIGINT');
  assert.equal(await task, 1); assert.equal(fx.cleaned, true);
  assert.equal(JSON.parse(fx.output.join('')).code, 'JOB_CANCELLED');
});

test('errors do not echo private child diagnostic strings', async () => {
  const fx = harness({ rejection: Object.assign(new Error('PRIVATE_SOURCE_CONTENT'), {
    code: 'INTERRUPTED_UNKNOWN', metadata: { operatorLockRecoveryRequired: true },
  }) });
  assert.equal(await runDailyStudyOffline(args, fx.dependencies), 1);
  assert.doesNotMatch(fx.output.join('') + fx.errors.join(''), /PRIVATE_SOURCE_CONTENT/);
  assert.equal(JSON.parse(fx.output.join('')).operatorLockInspectionRequired, true);
});

test('invalid authority or simulation claims cannot receive a completed CLI label', async () => {
  for (const summary of [
    { ...safeSummary(), authority: 'ORDERS' },
    { ...safeSummary(), claims: { ...safeSummary().claims, simulationsCompleted: 100000 } },
    { ...safeSummary(), durability: { republishSafe: true } },
    { status: 'FINALIZED', authority: 'NONE', claims: safeSummary().claims, durability: safeSummary().durability, cancelRequested: false },
  ]) {
    const fx = harness({ summary });
    assert.equal(await runDailyStudyOffline(args, fx.dependencies), 1);
    assert.equal(JSON.parse(fx.output.join('')).code, 'CHILD_SUMMARY_INVALID');
  }
});

test('a signal delivered during setup cancels the ticket immediately after assignment', async () => {
  const fx = harness({ admitted: false });
  const original = fx.dependencies.createMonitor;
  fx.dependencies.createMonitor = (options) => {
    const monitor = original(options);
    return { ...monitor, start() { fx.signals.emit('SIGTERM'); monitor.start(); } };
  };
  assert.equal(await runDailyStudyOffline(args, fx.dependencies), 1);
  assert.equal(JSON.parse(fx.output.join('')).code, 'JOB_CANCELLED');
  assert.equal(fx.cleaned, true);
});

test('offline CLI runs a real child/store on a declared empty partial capture, with no fabricated simulation credit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-offline-cli-'));
  const outputs = path.join(root, 'outputs'); mkdirSync(outputs);
  const start = Date.UTC(2026, 8, 10, 4); const end = start + 86_400_000; const final = end + 3_600_000;
  const market = { pairKey: 'BTCUSD', nativeBase: 'XBTC', nativeQuote: 'ZUSD', wsname: 'BTC/USD', base: 'BTC', quote: 'USD', status: 'online' };
  const catalog = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: start + 1, contentId: '', markets: [market] };
  catalog.contentId = createHash('sha1').update(stableStringify({ venue: 'kraken', quote: 'USD', policyVersion: 1, markets: [market] })).digest('hex');
  const capture = { catalog, records: [], dayStartTs: start, dayEndTs: end, finalizedTs: final,
    captureStartTs: start, captureEndTs: final, truncated: false };
  const declaration = sealDailyStudyRunnerJob({ jobId: 'offline-cli-fixture', sourceId: 'cli-test',
    declaredTs: final, localDay: '2026-09-10', dayStartTs: start, dayEndTs: end });
  writeFileSync(path.join(root, 'capture.json'), JSON.stringify(capture));
  writeFileSync(path.join(root, 'job.json'), JSON.stringify(declaration));
  let output = ''; let opts;
  // Deterministic admission port; actual monitor is tested separately. No false
  // local OS measurement is presented as a production pressure reading here.
  const createMonitor = (o) => { opts = o; return {
    start() { queueMicrotask(() => opts.onSample()); },
    evaluate: () => ({ admission: 'ADMIT', scope: 'DETERMINISTIC_TEST_ONLY' }), async stop() {},
  }; };
  try {
    const code = await runDailyStudyOffline([...args.slice(0, -1), 'outputs/receipts'], {
      cwd: root, stdout: { write: (s) => { output += s; } }, stderr: { write: () => {} }, createMonitor,
    });
    assert.equal(code, 0, output);
    const report = JSON.parse(output);
    assert.equal(report.summary.result.caseCount, 1);
    assert.equal(report.summary.result.attemptedSimulations, 0);
    const state = JSON.parse(readFileSync(path.join(outputs, 'receipts', 'jobs', 'offline-cli-fixture.json'), 'utf8'));
    assert.equal(state.progress.phase, 'FINALIZED'); assert.equal(state.result.fullDetailCasesClaimed, 0);
  } finally {
    assert.ok(root.startsWith(path.join(tmpdir(), 'serpent-offline-cli-')));
    rmSync(root, { recursive: true, force: true });
  }
});
