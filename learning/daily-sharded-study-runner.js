// Restartable local traversal of a verified broad-day shard dataset. The
// runner durably acknowledges one bounded market-day at a time and releases it
// before loading the next. It records input-verification outputs only: no
// simulation, statistical evidence, Judge, promotion, or trading credit.
import path from 'node:path';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteJson, readJsonBounded } from '../lib/jsonl.js';
import {
  dailyBroadArchiveMarketDayReceiptError, openDailyBroadArchiveShardSource,
} from './daily-broad-archive-shards.js';
import {
  DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION, dailyShardClassificationOutputError,
} from './daily-sharded-study-classifier.js';
import { canonicalDigest, deepFreeze, stableStringify } from './shadow-contracts.js';

export const DAILY_SHARDED_STUDY_RUNNER_VERSION = 'daily-sharded-study-runner-1';
export const DAILY_SHARDED_STUDY_JOB_VERSION = 'daily-sharded-study-job-1';
export const DAILY_SHARDED_STUDY_STATE_VERSION = 'daily-sharded-study-state-1';
export const DAILY_SHARD_TRAVERSAL_OUTPUT_VERSION = 'daily-shard-traversal-output-1';
export const DAILY_SHARD_CONSUMER_ACK_VERSION = 'daily-shard-consumer-ack-1';
export const DAILY_SHARDED_STUDY_DURABILITY = Object.freeze({
  scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN',
});
export const DAILY_SHARDED_STUDY_LIMITS = Object.freeze({
  maxShardsPerExecute: 64, maxStateBytes: 8 * 1024 * 1024,
  maxConsumerOutputBytes: 4 * 1024, maxAcknowledgments: 5_000,
});

const HEX64 = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const OUTPUT_KEYS = Object.freeze([
  'outputVersion', 'marketIdentityDigest', 'marketDayDigest', 'resultState',
  'attemptedSimulations', 'completedSimulations', 'validSimulationOutcomes',
  'authority', 'learningEligible', 'simulationCredit',
]);
const ACK_KEYS = Object.freeze([
  'ackVersion', 'ackDigest', 'jobId', 'jobDigest', 'datasetId', 'datasetDigest',
  'revision', 'shardIndex', 'shardId', 'shardDigest', 'receiptDigest',
  'marketDayDigest', 'output', 'outputDigest', 'previousAckDigest', 'acknowledgedTs',
  'authority', 'learningEligible', 'simulationCredit',
]);
const JOB_KEYS = Object.freeze([
  'jobVersion', 'jobId', 'jobDigest', 'declaredTs', 'datasetId', 'datasetDigest',
  'sourceDatasetId', 'sourceDatasetDigest', 'catalogSnapshotDigest',
  'catalogEpochDigest', 'shardInventoryDigest', 'shardCount', 'expectedRows',
  'dayStartTs', 'dayEndTs', 'asOfTs', 'durability', 'authority', 'purpose',
]);
const STATE_KEYS = Object.freeze([
  'stateVersion', 'stateDigest', 'revision', 'job', 'nextShardIndex',
  'acknowledgments', 'completed', 'durability',
]);
const positiveTs = (value) => Number.isSafeInteger(value) && value > 0;
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const clone = (value) => JSON.parse(stableStringify(value));
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const digestWithout = (value, key) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));

function limitsOf(input) {
  if (input !== undefined && !plain(input)) throw fail('RUNNER_LIMITS_INVALID', 'limits must be an object');
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in DAILY_SHARDED_STUDY_LIMITS));
  if (unknown.length) throw fail('RUNNER_LIMITS_INVALID', `unknown limits: ${unknown.join(',')}`);
  const value = { ...DAILY_SHARDED_STUDY_LIMITS, ...(input ?? {}) };
  if (!count(value.maxShardsPerExecute, 64) || value.maxShardsPerExecute < 1
      || !count(value.maxStateBytes, 16 * 1024 * 1024) || value.maxStateBytes < 64 * 1024
      || !count(value.maxConsumerOutputBytes, 64 * 1024) || value.maxConsumerOutputBytes < 256
      || !count(value.maxAcknowledgments, 5_000) || value.maxAcknowledgments < 1) {
    throw fail('RUNNER_LIMITS_INVALID', 'runner limits violate hard bounds');
  }
  return Object.freeze(value);
}

const sameDurability = (value) => exact(value, ['scope', 'republishSafe', 'externalArchive'])
  && value.scope === 'LOCAL_FILESYSTEM_ONLY' && value.republishSafe === false && value.externalArchive === 'UNKNOWN';

export function dailyShardTraversalOutputError(value, { shard = null, receipt = null } = {}) {
  if (!exact(value, OUTPUT_KEYS)) return 'consumer output shape malformed';
  if (value.outputVersion !== DAILY_SHARD_TRAVERSAL_OUTPUT_VERSION
      || !HEX64.test(value.marketIdentityDigest ?? '') || !HEX64.test(value.marketDayDigest ?? '')
      || value.resultState !== 'INPUT_VERIFIED_NO_SIMULATION'
      || value.attemptedSimulations !== 0 || value.completedSimulations !== 0
      || value.validSimulationOutcomes !== 0 || value.authority !== 'NONE'
      || value.learningEligible !== false || value.simulationCredit !== 0) return 'consumer output violates zero-credit traversal law';
  if (shard && (value.marketIdentityDigest !== shard.marketIdentityDigest
      || value.marketDayDigest !== receipt?.marketDayDigest)) return 'consumer output is not bound to the loaded shard';
  return null;
}

function dailyShardConsumerOutputError(value, context = {}) {
  if (value?.outputVersion === DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION) {
    return dailyShardClassificationOutputError(value, context);
  }
  return dailyShardTraversalOutputError(value, context);
}

export function sealDailyShardTraversalOutput({ marketDay, receipt } = {}) {
  const value = {
    outputVersion: DAILY_SHARD_TRAVERSAL_OUTPUT_VERSION,
    marketIdentityDigest: marketDay?.marketIdentityDigest ?? null,
    marketDayDigest: receipt?.marketDayDigest ?? null,
    resultState: 'INPUT_VERIFIED_NO_SIMULATION',
    attemptedSimulations: 0, completedSimulations: 0,
    validSimulationOutcomes: 0, authority: 'NONE',
    learningEligible: false, simulationCredit: 0,
  };
  const error = dailyShardTraversalOutputError(value, { receipt });
  if (error || value.marketIdentityDigest !== receipt?.marketIdentityDigest) {
    throw fail('RUNNER_CONSUMER_OUTPUT_INVALID', error ?? 'market day differs from receipt identity');
  }
  return deepFreeze(value);
}

const ackDigestBody = (ack) => Object.fromEntries(Object.entries(ack).filter(([key]) => key !== 'ackDigest'));

export function dailyShardConsumerAckError(ack, { job = null, shard = null, receipt = null, prior = null } = {}) {
  if (!exact(ack, ACK_KEYS)) return 'consumer acknowledgment shape malformed';
  const outputError = dailyShardConsumerOutputError(ack.output, { job, shard, receipt });
  if (outputError || ack.ackVersion !== DAILY_SHARD_CONSUMER_ACK_VERSION
      || !HEX64.test(ack.ackDigest ?? '') || ack.ackDigest !== canonicalDigest(ackDigestBody(ack))
      || !HEX64.test(ack.outputDigest ?? '') || ack.outputDigest !== canonicalDigest(ack.output)
      || !count(ack.revision) || !count(ack.shardIndex) || !positiveTs(ack.acknowledgedTs)
      || !(ack.previousAckDigest === null || HEX64.test(ack.previousAckDigest))
      || ack.authority !== 'NONE' || ack.learningEligible !== false || ack.simulationCredit !== 0) {
    return outputError ?? 'consumer acknowledgment identity or fields malformed';
  }
  if (job && (ack.jobId !== job.jobId || ack.jobDigest !== job.jobDigest
      || ack.datasetId !== job.datasetId || ack.datasetDigest !== job.datasetDigest)) return 'consumer acknowledgment job mismatch';
  if (shard && (ack.shardIndex !== shard.shardIndex || ack.shardId !== shard.shardId
      || ack.shardDigest !== shard.shardDigest || ack.marketDayDigest !== receipt?.marketDayDigest
      || ack.receiptDigest !== receipt?.receiptDigest)) return 'consumer acknowledgment shard mismatch';
  if ((prior?.ackDigest ?? null) !== ack.previousAckDigest
      || (prior ? prior.revision + 1 : 1) !== ack.revision) return 'consumer acknowledgment chain mismatch';
  if (prior && prior.output?.outputVersion !== ack.output.outputVersion) {
    return 'consumer output version changed within one immutable job';
  }
  if (prior && ack.output.outputVersion === DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION
      && prior.output.manifestDigest !== ack.output.manifestDigest) {
    return 'classification manifest changed within one immutable job';
  }
  return null;
}

function jobError(job, descriptor, limits) {
  if (!exact(job, JOB_KEYS) || job.jobVersion !== DAILY_SHARDED_STUDY_JOB_VERSION
      || !ID_RE.test(job.jobId ?? '') || !HEX64.test(job.jobDigest ?? '')
      || !positiveTs(job.declaredTs) || !positiveTs(job.dayStartTs) || !positiveTs(job.dayEndTs)
      || !positiveTs(job.asOfTs) || !count(job.shardCount, limits.maxAcknowledgments)
      || !count(job.expectedRows) || !sameDurability(job.durability)
      || job.authority !== 'NONE' || job.purpose !== 'RESEARCH_ONLY'
      || job.jobDigest !== digestWithout(job, 'jobDigest')) return 'job identity or fields malformed';
  if (descriptor && (job.datasetId !== descriptor.datasetId || job.datasetDigest !== descriptor.datasetDigest
      || job.sourceDatasetId !== descriptor.sourceDatasetId || job.sourceDatasetDigest !== descriptor.sourceDatasetDigest
      || job.catalogSnapshotDigest !== descriptor.acceptedCatalogSnapshot.contentDigest
      || job.catalogEpochDigest !== descriptor.catalogProvenance.catalogEpochDigest
      || job.shardInventoryDigest !== canonicalDigest(descriptor.shards)
      || job.shardCount !== descriptor.shardCount || job.expectedRows !== descriptor.expectedRows
      || job.dayStartTs !== descriptor.dayStartTs || job.dayEndTs !== descriptor.dayEndTs
      || job.asOfTs !== descriptor.asOfTs)) return 'job differs from sealed shard dataset';
  return null;
}

function stateError(state, descriptor, limits) {
  if (!exact(state, STATE_KEYS) || state.stateVersion !== DAILY_SHARDED_STUDY_STATE_VERSION
      || !HEX64.test(state.stateDigest ?? '') || state.stateDigest !== digestWithout(state, 'stateDigest')
      || !count(state.revision, limits.maxAcknowledgments) || !count(state.nextShardIndex, descriptor.shardCount)
      || !Array.isArray(state.acknowledgments) || state.acknowledgments.length > limits.maxAcknowledgments
      || state.revision !== state.acknowledgments.length || state.nextShardIndex !== state.acknowledgments.length
      || state.completed !== (state.nextShardIndex === descriptor.shardCount)
      || !sameDurability(state.durability)) return 'progress state identity or counters malformed';
  const jobErr = jobError(state.job, descriptor, limits); if (jobErr) return jobErr;
  for (let index = 0; index < state.acknowledgments.length; index += 1) {
    const ack = state.acknowledgments[index]; const shard = descriptor.shards[index];
    const receipt = { marketDayDigest: ack?.marketDayDigest, receiptDigest: ack?.receiptDigest };
    const err = dailyShardConsumerAckError(ack, {
      job: state.job, shard, receipt, prior: index === 0 ? null : state.acknowledgments[index - 1],
    });
    if (err) return `acknowledgments[${index}]: ${err}`;
  }
  return null;
}

export function dailyShardedStudyStateError(state, { descriptor, limits: suppliedLimits } = {}) {
  if (!descriptor || typeof descriptor !== 'object') return 'runner state descriptor missing';
  let limits;
  try { limits = limitsOf(suppliedLimits); } catch (error) { return error.message; }
  return stateError(state, descriptor, limits);
}

function fsyncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) { if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function installLock(root, clock) {
  const lockFile = path.join(root, 'writer.lock'); const token = randomBytes(16).toString('hex');
  const acquiredTs = clock(); if (!positiveTs(acquiredTs)) throw fail('RUNNER_CLOCK_INVALID', 'lock clock malformed');
  const lock = { version: DAILY_SHARDED_STUDY_RUNNER_VERSION, token, pid: process.pid, acquiredTs };
  let fd;
  try {
    fd = openSync(lockFile, 'wx', 0o600); writeSync(fd, `${stableStringify(lock)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined; fsyncDirectory(root);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (error?.code === 'EEXIST') throw fail('RUNNER_LOCK_HELD', 'writer.lock exists; no timed takeover');
    throw error;
  }
  const assertOwned = () => {
    let current;
    try { current = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { throw fail('RUNNER_LOCK_LOST', 'writer.lock unreadable'); }
    if (current?.token !== token || current?.version !== DAILY_SHARDED_STUDY_RUNNER_VERSION) throw fail('RUNNER_LOCK_LOST', 'writer.lock identity changed');
  };
  const release = () => { assertOwned(); unlinkSync(lockFile); fsyncDirectory(root); };
  return { assertOwned, release };
}

function sealJob({ jobId, declaredTs, descriptor }) {
  const job = {
    jobVersion: DAILY_SHARDED_STUDY_JOB_VERSION, jobId, jobDigest: '', declaredTs,
    datasetId: descriptor.datasetId, datasetDigest: descriptor.datasetDigest,
    sourceDatasetId: descriptor.sourceDatasetId, sourceDatasetDigest: descriptor.sourceDatasetDigest,
    catalogSnapshotDigest: descriptor.acceptedCatalogSnapshot.contentDigest,
    catalogEpochDigest: descriptor.catalogProvenance.catalogEpochDigest,
    shardInventoryDigest: canonicalDigest(descriptor.shards), shardCount: descriptor.shardCount,
    expectedRows: descriptor.expectedRows, dayStartTs: descriptor.dayStartTs,
    dayEndTs: descriptor.dayEndTs, asOfTs: descriptor.asOfTs,
    durability: clone(DAILY_SHARDED_STUDY_DURABILITY), authority: 'NONE', purpose: 'RESEARCH_ONLY',
  };
  job.jobDigest = digestWithout(job, 'jobDigest'); return job;
}

async function openDailyShardedStudyRunnerImpl({
  archiveRoot, stateRoot, dayStartTs, dayEndTs, asOfTs, jobId, declaredTs,
  consumeShard, clock = () => Date.now(), limits: suppliedLimits,
  readerLimits, shardLimits, signal = null,
} = {}, sourceFactory) {
  const limits = limitsOf(suppliedLimits);
  if (typeof stateRoot !== 'string' || stateRoot.length < 1 || !ID_RE.test(jobId ?? '')
      || !positiveTs(declaredTs) || declaredTs < asOfTs || typeof consumeShard !== 'function') {
    throw fail('RUNNER_ARGUMENT_INVALID', 'stateRoot/job/declaration/consumer malformed');
  }
  mkdirSync(stateRoot, { recursive: true }); const root = realpathSync(path.resolve(stateRoot));
  if (!lstatSync(root).isDirectory()) throw fail('RUNNER_STATE_ROOT_INVALID', 'stateRoot is not a directory');
  const lock = installLock(root, clock); let source; let closed = false; let closing = false; let inFlight = null;
  const stateFile = path.join(root, 'state.json');
  try {
    if (existsSync(stateFile) && lstatSync(stateFile).isSymbolicLink()) throw fail('RUNNER_STATE_INVALID', 'state.json cannot be a symlink');
    source = await sourceFactory({ archiveRoot, dayStartTs, dayEndTs, asOfTs, shardLimits, readerLimits, signal });
    const descriptor = source.descriptor; const job = sealJob({ jobId, declaredTs, descriptor });
    const jerr = jobError(job, descriptor, limits); if (jerr) throw fail('RUNNER_JOB_INVALID', jerr);
    let state;
    if (existsSync(stateFile)) {
      const size = lstatSync(stateFile).size; if (size > limits.maxStateBytes) throw fail('RUNNER_STATE_INVALID', 'state exceeds byte bound');
      state = readJsonBounded(stateFile, limits.maxStateBytes);
      const serr = stateError(state, descriptor, limits); if (serr) throw fail('RUNNER_STATE_INVALID', serr);
      if (state.job.jobDigest !== job.jobDigest) throw fail('RUNNER_JOB_CONFLICT', 'existing state names different immutable job content');
    } else {
      state = {
        stateVersion: DAILY_SHARDED_STUDY_STATE_VERSION, stateDigest: '', revision: 0,
        job, nextShardIndex: 0, acknowledgments: [], completed: descriptor.shardCount === 0,
        durability: clone(DAILY_SHARDED_STUDY_DURABILITY),
      };
      state.stateDigest = digestWithout(state, 'stateDigest');
      atomicWriteJson(stateFile, state, { sync: true });
    }

    const publicStatus = (status = null) => deepFreeze({
      runnerVersion: DAILY_SHARDED_STUDY_RUNNER_VERSION,
      status: status ?? (closed ? 'CLOSED' : closing ? 'CLOSING' : state.completed ? 'COMPLETE' : 'READY'),
      jobId: state.job.jobId, jobDigest: state.job.jobDigest,
      datasetId: state.job.datasetId, datasetDigest: state.job.datasetDigest,
      revision: state.revision, nextShardIndex: state.nextShardIndex,
      shardCount: state.job.shardCount, acknowledgedShards: state.acknowledgments.length,
      remainingShards: state.job.shardCount - state.nextShardIndex,
      completed: state.completed, durability: clone(state.durability),
      authority: 'NONE', learningEligible: false, simulationCredit: 0,
    });

    const execute = ({ maxShards = 1, signal: executeSignal = null } = {}) => {
      if (closing || closed) return Promise.reject(fail('RUNNER_CLOSED', 'runner is closing or closed'));
      if (inFlight) return inFlight;
      if (!count(maxShards, limits.maxShardsPerExecute) || maxShards < 1) return Promise.reject(fail('RUNNER_STEP_LIMIT', 'maxShards outside bound'));
      inFlight = (async () => {
        let processed = 0;
        while (!state.completed && processed < maxShards && !closing) {
          if (executeSignal?.aborted) return publicStatus('CANCELLED');
          lock.assertOwned(); const shard = descriptor.shards[state.nextShardIndex];
          let loaded; let next;
          try {
            loaded = await source.loadShard({ shardId: shard.shardId, signal: executeSignal });
            const receiptError = dailyBroadArchiveMarketDayReceiptError(loaded.receipt, { descriptor, shard, marketDay: loaded.marketDay });
            if (receiptError) throw fail('RUNNER_SHARD_RECEIPT_INVALID', receiptError);
            if (executeSignal?.aborted) return publicStatus('CANCELLED');
            const returned = await consumeShard(deepFreeze({
              job: clone(state.job), shard: clone(shard), marketDay: loaded.marketDay,
              receipt: loaded.receipt,
            }));
            let output;
            try { output = clone(returned); } catch { throw fail('RUNNER_CONSUMER_OUTPUT_INVALID', 'consumer output is not canonical JSON'); }
            if (Buffer.byteLength(stableStringify(output), 'utf8') > limits.maxConsumerOutputBytes) throw fail('RUNNER_CONSUMER_OUTPUT_INVALID', 'consumer output exceeds byte bound');
            const outputError = dailyShardConsumerOutputError(output, { job: state.job, shard, receipt: loaded.receipt });
            if (outputError) throw fail('RUNNER_CONSUMER_OUTPUT_INVALID', outputError);
            if (executeSignal?.aborted) return publicStatus('CANCELLED');
            const acknowledgedTs = clock(); if (!positiveTs(acknowledgedTs)) throw fail('RUNNER_CLOCK_INVALID', 'acknowledgment clock malformed');
            const prior = state.acknowledgments.at(-1) ?? null;
            const ack = {
              ackVersion: DAILY_SHARD_CONSUMER_ACK_VERSION, ackDigest: '',
              jobId: state.job.jobId, jobDigest: state.job.jobDigest,
              datasetId: state.job.datasetId, datasetDigest: state.job.datasetDigest,
              revision: state.revision + 1, shardIndex: shard.shardIndex,
              shardId: shard.shardId, shardDigest: shard.shardDigest,
              receiptDigest: loaded.receipt.receiptDigest, marketDayDigest: loaded.receipt.marketDayDigest,
              output, outputDigest: canonicalDigest(output), previousAckDigest: prior?.ackDigest ?? null,
              acknowledgedTs, authority: 'NONE', learningEligible: false, simulationCredit: 0,
            };
            ack.ackDigest = canonicalDigest(ackDigestBody(ack));
            const ackError = dailyShardConsumerAckError(ack, { job: state.job, shard, receipt: loaded.receipt, prior });
            if (ackError) throw fail('RUNNER_ACK_INVALID', ackError);
            next = {
              ...state, stateDigest: '', revision: ack.revision,
              nextShardIndex: state.nextShardIndex + 1,
              acknowledgments: [...state.acknowledgments, ack],
              completed: state.nextShardIndex + 1 === state.job.shardCount,
            };
            next.stateDigest = digestWithout(next, 'stateDigest');
            const stateBytes = Buffer.byteLength(stableStringify(next), 'utf8');
            if (stateBytes > limits.maxStateBytes) throw fail('RUNNER_STATE_LIMIT', 'next durable state exceeds byte bound');
          } finally {
            if (loaded !== undefined) {
              if (typeof loaded.release !== 'function') throw fail('RUNNER_SHARD_RELEASE_INVALID', 'source omitted the bounded shard release contract');
              loaded.release(); loaded = null;
            }
          }
          lock.assertOwned(); atomicWriteJson(stateFile, next, { sync: true }); state = next;
          processed += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
        return publicStatus(executeSignal?.aborted ? 'CANCELLED' : state.completed ? 'COMPLETE' : 'CHECKPOINTED');
      })().finally(() => { inFlight = null; });
      return inFlight;
    };

    const status = () => publicStatus();
    let closePromise = null;
    const close = () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try { if (inFlight) await inFlight; }
        finally {
          try { source.close(); } finally { lock.release(); closed = true; closing = false; }
        }
        return publicStatus('CLOSED');
      })();
      return closePromise;
    };
    return Object.freeze({ version: DAILY_SHARDED_STUDY_RUNNER_VERSION, job: deepFreeze(clone(job)), execute, status, close });
  } catch (error) {
    try { source?.close(); } catch {}
    try { lock.release(); } catch {}
    throw error;
  }
}

export function openDailyShardedStudyRunner({ openBroadDayReader, ...options } = {}) {
  if (typeof openBroadDayReader !== 'function') {
    return Promise.reject(fail('RUNNER_READER_FACTORY_REQUIRED', 'the composition owner must inject the fixed broad-day reader factory'));
  }
  return openDailyShardedStudyRunnerImpl(options, ({
    archiveRoot, dayStartTs, dayEndTs, asOfTs, shardLimits, readerLimits, signal,
  }) => openDailyBroadArchiveShardSource({
    rootDir: archiveRoot, dayStartTs, dayEndTs, asOfTs,
    limits: shardLimits, readerLimits, signal, openBroadDayReader,
  }));
}

// Explicit test-only constructor for synthetic scale/fault fixtures. Production
// composition injects the fixed verified reader; this seam injects a complete
// already-sealed source for bounded deterministic fixtures only.
export function openDailyShardedStudyRunnerForTest(options = {}, { source } = {}) {
  if (!source || typeof source !== 'object' || typeof source.loadShard !== 'function'
      || typeof source.close !== 'function' || !source.descriptor) {
    return Promise.reject(fail('RUNNER_TEST_SOURCE_INVALID', 'test source contract malformed'));
  }
  return openDailyShardedStudyRunnerImpl(options, async () => source);
}
