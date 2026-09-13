import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createDailyStudyProcessHost, DAILY_STUDY_PROCESS_HARD_LIMITS,
  isDailyStudyProcessResult, isDailyStudyProcessSummary,
} from '../tools/daily-study-process.js';
import { sealDailyStudyRunnerJob } from '../learning/daily-study-runner.js';
import { openDailyStudyStore } from '../learning/daily-study-store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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

function tickerPayload(eventTs, price) {
  return {
    messageType: 'update', lastPrice: price, bid: price - 1, ask: price + 1,
    bidQty: 2, askQty: 3, change24h: 1, changePct24h: 1,
    high24h: price + 5, low24h: price - 5, volume24hBase: 1000,
    vwap24h: price, tickerTimestampTs: eventTs, missingFields: [], invalidFields: [],
  };
}

function record({ seq, eventTs, price, sourceCatalog }) {
  const market = rawMarket('BTC');
  const value = {
    recordVersion: 'broad-kraken-record-v1', recordId: null,
    sessionId: 'bks-session-1', sequence: seq, recordType: 'TICKER',
    recordedTs: eventTs + 2, catalogContentId: sourceCatalog.contentId,
    epochId: 'epoch-1',
    market: {
      canonicalCoin: market.base, pairKey: market.pairKey,
      nativeBase: market.nativeBase, catalogWsname: market.wsname,
      wsSymbol: market.wsname,
    },
    channel: 'ticker', quality: 'OBSERVED', sourceEventTs: eventTs,
    receivedTs: eventTs + 1, periodStartTs: null, periodEndTs: null,
    payload: tickerPayload(eventTs, price),
  };
  value.recordId = `bkr-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  return value;
}

function capture() {
  const sourceCatalog = catalog();
  return {
    catalog: sourceCatalog,
    records: [
      record({ seq: 1, eventTs: START + HOUR, price: 100, sourceCatalog }),
      record({ seq: 2, eventTs: START + 2 * HOUR, price: 109, sourceCatalog }),
    ],
    dayStartTs: START, dayEndTs: END, finalizedTs: FINAL,
    captureStartTs: START, captureEndTs: FINAL, truncated: false,
  };
}

function declaration(jobId = 'process-daily-2025-09-13') {
  return sealDailyStudyRunnerJob({
    jobId, sourceId: 'bounded-process-fixture', declaredTs: FINAL,
    localDay: '2025-09-13', dayStartTs: START, dayEndTs: END,
  });
}

function fixtureRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-daily-process-'));
  const inputs = path.join(root, 'inputs'); const outputs = path.join(root, 'outputs');
  mkdirSync(inputs); mkdirSync(outputs);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, inputs, outputs };
}

function writeFixture(dirs, name = 'a', jobId = `process-${name}-2025-09-13`) {
  const captureFile = path.join(dirs.inputs, `${name}-capture.json`);
  const declarationFile = path.join(dirs.inputs, `${name}-declaration.json`);
  const outputDir = path.join(dirs.outputs, `${name}-store`);
  writeFileSync(captureFile, JSON.stringify(capture()));
  writeFileSync(declarationFile, JSON.stringify(declaration(jobId)));
  return { captureFile, declarationFile, outputDir };
}

async function closeIgnoringInterrupted(host) {
  try { await host.close(); } catch { /* individual ticket owns its error */ }
}

test('runs the whole bounded planner/store in a sanitized child and returns only a zero-credit receipt summary', async (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs);
  const priorNodeOptions = process.env.NODE_OPTIONS;
  const priorKraken = process.env.KRAKEN_API_KEY;
  process.env.NODE_OPTIONS = '--import=./hostile-loader.js';
  process.env.KRAKEN_API_KEY = 'must-not-cross-process-boundary';
  const host = createDailyStudyProcessHost({ inputRoot: dirs.inputs, outputRoot: dirs.outputs });
  t.after(async () => {
    await closeIgnoringInterrupted(host);
    if (priorNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = priorNodeOptions;
    if (priorKraken === undefined) delete process.env.KRAKEN_API_KEY; else process.env.KRAKEN_API_KEY = priorKraken;
  });

  const ticket = host.submit(spec);
  assert.match(ticket.jobToken, /^dailyproc-[a-f0-9]{24}$/);
  const result = await ticket.result;
  const { cancelRequested, ...rawSummary } = result;
  assert.equal(cancelRequested, false);
  assert.equal(isDailyStudyProcessResult(result), true);
  assert.equal(isDailyStudyProcessSummary(rawSummary), true);
  assert.equal(isDailyStudyProcessSummary({
    ...rawSummary, result: { ...rawSummary.result, studyDigest: 'f'.repeat(63) },
  }), false);
  assert.equal(isDailyStudyProcessSummary({
    ...rawSummary, progress: { ...rawSummary.progress, completedSimulations: 1 },
  }), false);
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.progress.phase, 'FINALIZED');
  assert.equal(result.result.resultMode, 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY');
  assert.equal(result.result.attemptedSimulations, 0);
  assert.equal(result.result.completedSimulations, 0);
  assert.equal(result.result.validSimulationOutcomes, 0);
  assert.equal(result.result.fullDetailCasesClaimed, 0);
  assert.equal(result.claims.fullDayStudyComplete, false);
  assert.equal(result.claims.learningAdopted, false);
  assert.equal(result.claims.tradingAuthority, false);
  assert.equal(result.detailedStudyReturned, false);
  assert.equal('study' in result, false);
  assert.equal(result.environment.nodeOptionsPresent, result.environment.testOfflineGuardActive);
  assert.equal(result.environment.unapprovedNodeOptionsPresent, false);
  assert.equal(result.environment.providerLikeKeyCount, 0);
  assert.equal(result.environment.fixedAllowlistOnly, true);
  assert.equal(result.resourceBoundary.v8OldSpaceLimitMb, 256);
  assert.equal(result.resourceBoundary.wholeProcessRssHardCap, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024);
  assert.equal(existsSync(path.join(spec.outputDir, 'writer.lock')), false, 'graceful child close releases its exact lock');

  const retry = await host.submit(spec).result;
  assert.equal(retry.status, 'EXISTING_FINALIZED');
  assert.equal(retry.result.resultDigest, result.result.resultDigest);
  assert.equal(retry.detailedStudyReturned, false);
});

test('a startup NODE_OPTIONS-only offline guard is snapshotted before later hostile env mutation', (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs, 'startup-guard');
  const guardFile = fileURLToPath(new URL('./helpers/offline-guard.mjs', import.meta.url));
  const guardUrl = new URL('./helpers/offline-guard.mjs', import.meta.url).href;
  const hostUrl = `${new URL('../tools/daily-study-process.js', import.meta.url).href}?startup-guard=${Date.now()}`;
  const script = `
    import { createDailyStudyProcessHost, isDailyStudyProcessResult } from ${JSON.stringify(hostUrl)};
    process.env.NODE_OPTIONS = '--import=./hostile-loader.js';
    process.env.COBRA_OFFLINE_GUARD_LOG = 'hostile-later-log';
    process.env.COBRA_OFFLINE_GUARD_RUN = 'hostile-later-run';
    process.env.KRAKEN_API_KEY = 'must-not-cross-process-boundary';
    const host = createDailyStudyProcessHost({ inputRoot: ${JSON.stringify(dirs.inputs)}, outputRoot: ${JSON.stringify(dirs.outputs)} });
    try {
      const result = await host.submit(${JSON.stringify(spec)}).result;
      process.stdout.write(JSON.stringify({ valid: isDailyStudyProcessResult(result), environment: result.environment }));
    } finally { await host.close(); }
  `;
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  const expectedLog = path.join(dirs.root, 'startup-guard.jsonl');
  env.NODE_OPTIONS = `--import="${guardUrl}" --title="${guardFile}"`;
  env.COBRA_OFFLINE_GUARD_LOG = expectedLog;
  env.COBRA_OFFLINE_GUARD_RUN = 'startup-node-options-only';
  const output = childProcess.execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))), env, encoding: 'utf8', timeout: 30_000,
  });
  const result = JSON.parse(output);
  assert.equal(result.valid, true);
  assert.equal(result.environment.testOfflineGuardActive, true);
  assert.equal(result.environment.nodeOptionsPresent, true);
  assert.equal(result.environment.unapprovedNodeOptionsPresent, false);
  assert.equal(result.environment.providerLikeKeyCount, 0);
  assert.equal(result.environment.fixedAllowlistOnly, true);
  assert.equal(existsSync(expectedLog), false, 'the isolated startup-guard run made zero outbound attempts');
});

test('admission is bounded, rechecked per dequeue, and exact or nested store ownership cannot overlap', async (t) => {
  const dirs = fixtureRoot(t); const a = writeFixture(dirs, 'a'); const b = writeFixture(dirs, 'b');
  mkdirSync(a.outputDir);
  let admit = false; let checks = 0;
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs, maxConcurrency: 1, maxQueue: 2,
    canStart: () => { checks += 1; return { allowed: admit, reason: 'test pressure gate' }; },
  });
  t.after(() => closeIgnoringInterrupted(host));
  const first = host.submit(a);
  assert.equal(host.status().queued, 1);
  assert.equal(host.status().admissionBlocked, true);
  assert.throws(() => host.submit({ ...b, outputDir: path.join(a.outputDir, 'nested') }), (error) => error?.code === 'OUTPUT_DIR_BUSY');
  const second = host.submit(b);
  assert.throws(() => host.submit(writeFixture(dirs, 'c')), (error) => error?.code === 'QUEUE_FULL');
  admit = true; host.resumeAdmissions();
  const [one, two] = await Promise.all([first.result, second.result]);
  assert.equal(one.status, 'FINALIZED'); assert.equal(two.status, 'FINALIZED');
  assert.ok(checks >= 3, 'external pressure decision is re-evaluated before each dequeue');
  assert.equal(host.status().peakActive, 1);
  assert.equal(host.status().active, 0);
  assert.throws(() => createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs, maxConcurrency: DAILY_STUDY_PROCESS_HARD_LIMITS.maxConcurrency + 1,
  }), (error) => error?.code === 'PROCESS_LIMIT_INVALID');
});

test('queued cancellation is usable from its ticket and never creates a receipt or lock', async (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs, 'cancel');
  const host = createDailyStudyProcessHost({ inputRoot: dirs.inputs, outputRoot: dirs.outputs });
  host.pauseAdmissions('test pause');
  const ticket = host.submit(spec);
  assert.equal(ticket.cancel('operator test cancellation'), true);
  await assert.rejects(ticket.result, (error) => error?.code === 'JOB_CANCELLED');
  assert.equal(existsSync(spec.outputDir), false);
  assert.equal(host.status().queued, 0);
  await host.close();
});

test('a queued input changed after parent admission is refused by child descriptor custody', async (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs, 'changed');
  const host = createDailyStudyProcessHost({ inputRoot: dirs.inputs, outputRoot: dirs.outputs });
  host.pauseAdmissions('hold for deterministic custody mutation');
  const ticket = host.submit(spec);
  writeFileSync(spec.captureFile, `${JSON.stringify(capture())} `);
  host.resumeAdmissions();
  await assert.rejects(ticket.result, (error) => error?.code === 'INPUT_CUSTODY_CHANGED');
  assert.equal(existsSync(path.join(spec.outputDir, 'jobs')), false);
  await host.close();
});

test('run timeout waits for child exit and never promises that an interrupted local store is safe to reuse', async (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs, 'timeout');
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
    maxRunMs: 10, killGraceMs: 10,
  });
  t.after(() => closeIgnoringInterrupted(host));
  const ticket = host.submit({ ...spec, timeoutMs: 10 });
  await assert.rejects(ticket.result, (error) => ['RUN_TIMEOUT', 'INTERRUPTED_UNKNOWN'].includes(error?.code));
  assert.equal(host.status().active, 0, 'timeout settles only after the child exit event');
});

test('a valid terminal IPC response cannot clear the physical-exit deadline or authorize a hung child result', async (t) => {
  const dirs = fixtureRoot(t); const spec = writeFixture(dirs, 'hung-terminal');
  const physicalBytes = readFileSync(spec.captureFile).length + readFileSync(spec.declarationFile).length;
  const jobDigest = 'a'.repeat(64); const resultDigest = 'b'.repeat(64);
  const manifestDigest = 'c'.repeat(64);
  const summary = {
    processVersion: 'daily-study-process-1', executionModel: 'ONE_CHILD_PROCESS_PER_JOB',
    spawnOverheadPerJob: true, status: 'FINALIZED', jobId: 'hung-terminal-job',
    jobDigest, revision: 4,
    progress: { phase: 'FINALIZED', completedSteps: 3, totalSteps: 3,
      plannedDecisionMoments: 0, grossPlannedRecipeVariantSlots: 0,
      attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
      cancelled: false, note: null, updatedTs: 1 },
    result: { resultVersion: 'daily-study-result-receipt-1',
      resultId: `dailyresult-${resultDigest.slice(0, 32)}`, resultDigest,
      jobId: 'hung-terminal-job', jobDigest,
      manifestId: `dmstudy-${manifestDigest.slice(0, 24)}`, manifestDigest,
      studyVersion: 'daily-move-study-1', studyDigest: 'd'.repeat(64),
      studyBytes: 0, caseCount: 0, plannedDecisionMoments: 0,
      grossPlannedRecipeVariantSlots: 0, attemptedSimulations: 0,
      completedSimulations: 0, validSimulationOutcomes: 0,
      fullDetailCasesClaimed: 0, resultMode: 'RETROSPECTIVE_PLANNER_RECEIPT_ONLY',
      externalArchive: 'UNKNOWN', authority: 'NONE', purpose: 'RESEARCH_ONLY' },
    detailedStudyReturned: false, detailedStudyPersistedByReceiptStore: false,
    durability: { scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN' },
    authority: 'NONE', purpose: 'RESEARCH_ONLY',
    inputAccounting: { physicalBytes, decodedStringBytesUpperBound: physicalBytes * 2, boundedPartialCaptureOnly: true },
    resourceBoundary: { v8OldSpaceLimitMb: 256, wholeProcessRssHardCap: false, inputPreflightBeforeJsonParse: true },
    environment: { inheritedKeys: [], fixedAllowlistOnly: true,
      nodeOptionsPresent: false, nodePathPresent: false, testOfflineGuardActive: false,
      unapprovedNodeOptionsPresent: false, providerLikeKeyCount: 0 },
    claims: { fullDayCatalogContinuityVerified: false, fullDayStudyComplete: false,
      simulationsAttempted: 0, simulationsCompleted: 0, validSimulationOutcomes: 0,
      learningAdopted: false, tradingAuthority: false },
  };
  const kills = [];
  class HungChild extends EventEmitter {
    constructor() {
      super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.connected = true;
      queueMicrotask(() => this.emit('spawn'));
    }
    send(message) {
      if (message.type === 'RUN') queueMicrotask(() => this.emit('message', {
        protocolVersion: 'daily-study-process-protocol-1', jobToken: message.jobToken,
        ok: true, summary,
      }));
      return true;
    }
    kill(signal) {
      kills.push(signal); this.connected = false;
      queueMicrotask(() => this.emit('exit', null, signal)); return true;
    }
  }
  const originalFork = childProcess.fork;
  childProcess.fork = () => new HungChild(); syncBuiltinESMExports();
  try {
    const isolated = await import(`../tools/daily-study-process.js?hung-terminal=${Date.now()}`);
    const host = isolated.createDailyStudyProcessHost({
      inputRoot: dirs.inputs, outputRoot: dirs.outputs, killGraceMs: 10,
    });
    const ticket = host.submit(spec);
    await assert.rejects(ticket.result, (error) => error?.code === 'INTERRUPTED_UNKNOWN'
      && error?.metadata?.operatorLockRecoveryRequired === true);
    assert.deepEqual(kills, ['SIGTERM']);
    assert.equal(host.status().active, 0);
    assert.equal(await host.close(), undefined);
  } finally {
    childProcess.fork = originalFork; syncBuiltinESMExports();
  }
});

test('existing external store lock, malformed JSON, outside paths, symlinks, and physical byte overflow fail closed', async (t) => {
  const dirs = fixtureRoot(t); const locked = writeFixture(dirs, 'locked');
  mkdirSync(locked.outputDir);
  let store;
  try {
    store = await openDailyStudyStore({ rootDir: locked.outputDir });
    const host = createDailyStudyProcessHost({ inputRoot: dirs.inputs, outputRoot: dirs.outputs });
    t.after(() => closeIgnoringInterrupted(host));
    await assert.rejects(host.submit(locked).result, (error) => error?.code === 'DAILY_STUDY_LOCK_HELD');
  } finally { if (store) await store.close(); }

  const malformed = writeFixture(dirs, 'malformed');
  writeFileSync(malformed.declarationFile, '{bad json');
  const host = createDailyStudyProcessHost({
    inputRoot: dirs.inputs, outputRoot: dirs.outputs,
    maxCaptureFileBytes: 1024 * 1024, maxTotalInputFileBytes: 1024 * 1024,
  });
  t.after(() => closeIgnoringInterrupted(host));
  await assert.rejects(host.submit(malformed).result, (error) => error?.code === 'INPUT_JSON_INVALID');
  assert.throws(() => host.submit({ ...malformed, captureFile: path.join(dirs.root, 'outside.json') }), (error) => error?.code === 'PATH_ESCAPE');

  const oversized = writeFixture(dirs, 'oversized');
  writeFileSync(oversized.captureFile, JSON.stringify({ padding: 'x'.repeat((1024 * 1024) + 1) }));
  assert.throws(() => host.submit(oversized), (error) => error?.code === 'INPUT_BYTE_LIMIT');

  const target = writeFixture(dirs, 'target');
  const link = path.join(dirs.inputs, 'capture-link.json');
  try {
    symlinkSync(target.captureFile, link, 'file');
    assert.throws(() => host.submit({ ...target, captureFile: link }), (error) => error?.code === 'PATH_ESCAPE');
  } catch (error) {
    if (!(process.platform === 'win32' && ['EPERM', 'UNKNOWN'].includes(error?.code))) throw error;
  }
});

test('production host/child sources expose no shell, provider, DB, app, or arbitrary-module startup seam', () => {
  const hostSource = readFileSync(new URL('../tools/daily-study-process.js', import.meta.url), 'utf8');
  const childSource = readFileSync(new URL('../tools/daily-study-process-child.js', import.meta.url), 'utf8');
  assert.doesNotMatch(hostSource, /\bexec(?:File)?\s*\(|\bspawn\s*\(|shell\s*:\s*true/);
  assert.doesNotMatch(hostSource, /env\.NODE_OPTIONS\s*=\s*process\.env\.NODE_OPTIONS|envAllowlist|modulePath|command\s*:/);
  assert.match(hostSource, /OFFLINE_GUARD_FILE/);
  assert.match(hostSource, /pathToFileURL\(OFFLINE_GUARD_FILE\)/);
  assert.match(hostSource, /execArgv:\s*\[`--max-old-space-size=/);
  assert.doesNotMatch(childSource, /from\s+['"][^'"]*(?:provider|order-client|paper|judge\/|ui\/server|data-only-runtime|\bpg\b)/i);
  assert.match(childSource, /\.\.\/learning\/daily-study-runner\.js/);
  assert.match(childSource, /\.\.\/learning\/daily-study-store\.js/);
  assert.match(childSource, /O_NOFOLLOW/);
  assert.match(childSource, /inputPreflightBeforeJsonParse:\s*true/);
});
