// Explicit offline entry point only. No timer/child/app is started on import.
// This runs one bounded partial-capture planner, NOT the 100k simulator and NOT
// a daily production scheduler. Output is a local receipt, not a raw archive.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDailyStudyProcessHost, isDailyStudyProcessSummary } from './daily-study-process.js';
import { createRuntimePressureMonitor } from '../lib/runtime-pressure.js';

export const DAILY_STUDY_OFFLINE_VERSION = 'daily-study-offline-1';
export const DAILY_STUDY_OFFLINE_HELP = `Offline bounded daily-study planner

node tools/daily-study-offline.mjs --capture capture.json --declaration job.json --output-dir study-receipts

Required: --capture, --declaration, --output-dir
Optional: --input-root, --output-root (default: current directory)
          --timeout-ms (default: 120000; 1000..600000)
          --admission-timeout-ms (default: 30000; 1000..600000)
          --help

Input/output roots and the output directory's parent must already exist.
The output directory must be dedicated to this local research receipt store.
Exactly one child worker is allowed here; pressure can defer its start.
Existing locks are never automatically recovered or deleted.
This command does not collect feeds, run trading simulations, adopt learning,
start PAPER/LIVE trading, modify production, or guarantee republish durability.
`;

const FLAGS = Object.freeze({
  '--capture': 'captureFile', '--declaration': 'declarationFile', '--output-dir': 'outputDir',
  '--input-root': 'inputRoot', '--output-root': 'outputRoot',
  '--timeout-ms': 'timeoutMs', '--admission-timeout-ms': 'admissionTimeoutMs',
});
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const errorCode = (error) => typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(error.code)
  ? error.code : 'OFFLINE_STUDY_FAILED';

export function parseDailyStudyOfflineArgs(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string' || a.length > 4096)) fail('ARGUMENT_INVALID');
  if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const key = FLAGS[flag]; const value = argv[index + 1];
    if (!key || Object.hasOwn(values, key) || !value || value.startsWith('--') || value.includes('\0')) fail('ARGUMENT_INVALID');
    values[key] = value;
  }
  for (const key of ['captureFile', 'declarationFile', 'outputDir']) if (!values[key]) fail('ARGUMENT_REQUIRED');
  const integer = (key, fallback) => {
    if (values[key] === undefined) return fallback;
    if (!/^\d+$/.test(values[key])) fail('ARGUMENT_INVALID');
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < 1000 || value > 600_000) fail('ARGUMENT_INVALID');
    return value;
  };
  return Object.freeze({
    help: false,
    captureFile: path.resolve(cwd, values.captureFile),
    declarationFile: path.resolve(cwd, values.declarationFile),
    outputDir: path.resolve(cwd, values.outputDir),
    inputRoot: path.resolve(cwd, values.inputRoot ?? '.'),
    outputRoot: path.resolve(cwd, values.outputRoot ?? '.'),
    timeoutMs: integer('timeoutMs', 120_000), admissionTimeoutMs: integer('admissionTimeoutMs', 30_000),
  });
}

export async function runDailyStudyOffline(argv, {
  cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr,
  signalSource = process, clock = () => Date.now(),
  createHost = createDailyStudyProcessHost, createMonitor = createRuntimePressureMonitor,
} = {}) {
  let options;
  try { options = parseDailyStudyOfflineArgs(argv, cwd); }
  catch (error) { stderr.write(`${JSON.stringify({ status: 'REFUSED', code: errorCode(error) })}\n`); return 2; }
  if (options.help) { stdout.write(DAILY_STUDY_OFFLINE_HELP); return 0; }
  let host; let monitor; let ticket; let interrupted = false;
  let queuedTs = null; let lastDecision = null; let cleanupFailed = false;
  const startedTs = clock();
  const report = { cliVersion: DAILY_STUDY_OFFLINE_VERSION, scope: 'OFFLINE_PARTIAL_CAPTURE_ONLY',
    maxStudyConcurrency: 1, authority: 'NONE', productionChanged: false,
    tradingStarted: false, simulationsExecuted: 0, republishSafe: false };
  const stopRequested = () => {
    interrupted = true;
    host?.pauseAdmissions('operator signal');
    ticket?.cancel('offline CLI interrupted');
  };
  let exitCode = 1; let summary = null; let failure = null;
  try {
    host = createHost({ inputRoot: options.inputRoot, outputRoot: options.outputRoot,
      maxConcurrency: 1, maxQueue: 1, maxRunMs: options.timeoutMs,
      maxQueueWaitMs: options.admissionTimeoutMs,
      canStart: () => !interrupted && monitor?.evaluate()?.admission === 'ADMIT',
    });
    host.pauseAdmissions('pressure sample warmup');
    monitor = createMonitor({
      config: { maxStudyConcurrency: 1 }, clock,
      sampleIntervalMs: 1000,
      queueSample: () => {
        const depth = host.status().queued;
        return { scope: 'OFFLINE_HOST_WAITING_QUEUE', observedTs: clock(), depth,
          oldestAgeMs: depth > 0 && queuedTs !== null ? Math.max(0, clock() - queuedTs) : 0 };
      },
      onSample: () => {
        lastDecision = monitor.evaluate();
        if (!interrupted && lastDecision.admission === 'ADMIT') host.resumeAdmissions();
        else host.pauseAdmissions('resource sample refused or pressured');
      },
    });
    signalSource.on('SIGINT', stopRequested); signalSource.on('SIGTERM', stopRequested);
    monitor.start();
    queuedTs = clock();
    ticket = host.submit({ captureFile: options.captureFile, declarationFile: options.declarationFile,
      outputDir: options.outputDir, timeoutMs: options.timeoutMs });
    if (interrupted) ticket.cancel('offline CLI interrupted before ticket assignment');
    summary = await ticket.result;
    const { cancelRequested, ...rawSummary } = summary ?? {};
    if (typeof cancelRequested !== 'boolean' || !isDailyStudyProcessSummary(rawSummary)) {
      summary = null; fail('CHILD_SUMMARY_INVALID');
    }
    if (interrupted || summary.cancelRequested || !['FINALIZED', 'EXISTING_FINALIZED'].includes(summary.status)) {
      failure = 'JOB_CANCELLED'; exitCode = 1;
    } else exitCode = 0;
  } catch (error) {
    failure = errorCode(error);
    // Do not print raw source data, private paths, stderr from a child, or env.
    if (error?.metadata?.operatorLockRecoveryRequired || error?.metadata?.operatorLockInspectionRequired) {
      report.operatorLockInspectionRequired = true;
    }
  } finally {
    signalSource.removeListener('SIGINT', stopRequested); signalSource.removeListener('SIGTERM', stopRequested);
    try { await monitor?.stop(); } catch { cleanupFailed = true; }
    try { await host?.close({ cancelQueued: true, cancelRunning: true }); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) { failure = 'CLEANUP_FAILED'; exitCode = 1; }
  const elapsedMs = Math.max(0, clock() - startedTs);
  const value = { ...report, status: exitCode === 0 ? 'COMPLETED_RESEARCH_ONLY' : 'REFUSED_OR_INTERRUPTED',
    elapsedMs, code: failure, pressureDecision: lastDecision, summary,
    productionPerformanceVerified: false };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    stderr.write(`${JSON.stringify({ ...report, status: 'REFUSED', code: 'CLI_OUTPUT_LIMIT' })}\n`); return 1;
  }
  stdout.write(`${serialized}\n`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDailyStudyOffline(process.argv.slice(2));
}
