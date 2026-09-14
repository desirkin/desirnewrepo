// Restartable local aggregator for the per-shard retrospective classifier.
// It requires the complete classifier ACK denominator before work begins,
// persists one bounded prefix artifact at a time, then performs the existing
// prefix-only control-distance law. It grants no simulation, learning, Judge,
// promotion, or order credit.
import path from 'node:path';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteJson, readJsonBounded } from '../lib/jsonl.js';
import { dailyMoveControlMatchDistance, dailyMoveStudyManifestError } from './daily-move-study.js';
import { openDailyBroadArchiveShardSource } from './daily-broad-archive-shards.js';
import { dailyShardedStudyStateError } from './daily-sharded-study-runner.js';
import {
  DAILY_SHARD_PREFIX_LIMITS, dailyShardPrefixArtifactError,
  sealDailyShardPrefixArtifact, sealDailySurgeAnchorInventory,
} from './daily-shard-prefix-facts.js';
import { canonicalDigest, deepFreeze, stableStringify } from './shadow-contracts.js';

export const DAILY_SHARD_CONTROL_AGGREGATOR_VERSION = 'daily-shard-control-aggregator-1';
export const DAILY_SHARD_CONTROL_STATE_VERSION = 'daily-shard-control-state-1';
export const DAILY_SHARD_PREFIX_ACK_VERSION = 'daily-shard-prefix-ack-1';
export const DAILY_SHARD_CONTROL_RESULT_VERSION = 'daily-shard-control-result-1';
export const DAILY_SHARD_CONTROL_LIMITS = Object.freeze({
  maxMarkets: 5_000, maxAnchors: 1_500, maxArtifactBytes: 512 * 1024,
  maxStateBytes: 16 * 1024 * 1024, maxShardsPerExecute: 64,
  maxMatchComparisons: 1_000_000,
});
const HARD = Object.freeze({
  maxMarkets: 5_000, maxAnchors: 1_500, maxArtifactBytes: 1024 * 1024,
  maxStateBytes: 32 * 1024 * 1024, maxShardsPerExecute: 64,
  maxMatchComparisons: 2_000_000,
});
const CONTROL_CLASSES = Object.freeze(['FAILED_BREAKOUT_CONTROL', 'FALLING_CONTROL', 'FLAT_CONTROL']);
const HEX64 = /^[a-f0-9]{64}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const ts = (value) => Number.isSafeInteger(value) && value > 0;
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const clone = (value) => JSON.parse(stableStringify(value));
const digestWithout = (value, key) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));
const ACK_KEYS = Object.freeze([
  'ackVersion', 'ackDigest', 'revision', 'shardIndex', 'shardId', 'shardDigest',
  'receiptDigest', 'classificationOutputDigest', 'artifactId', 'artifactDigest',
  'previousAckDigest', 'durableTs',
]);
const STATE_KEYS = Object.freeze([
  'stateVersion', 'stateDigest', 'jobDigest', 'manifestDigest',
  'anchorInventoryDigest', 'nextShardIndex', 'revision', 'artifactAcks',
  'completed', 'result', 'durability',
]);

function limitsOf(input) {
  if (input !== undefined && !plain(input)) throw fail('CONTROL_LIMITS_INVALID', 'limits must be an object');
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in DAILY_SHARD_CONTROL_LIMITS));
  if (unknown.length) throw fail('CONTROL_LIMITS_INVALID', `unknown limits: ${unknown.join(',')}`);
  const value = { ...DAILY_SHARD_CONTROL_LIMITS, ...(input ?? {}) };
  for (const [key, ceiling] of Object.entries(HARD)) {
    if (!count(value[key], ceiling) || value[key] < 1) throw fail('CONTROL_LIMITS_INVALID', `${key} violates its hard bound`);
  }
  return Object.freeze(value);
}
const prefixLimitsOf = (limits) => ({
  maxMarkets: limits.maxMarkets, maxAnchors: limits.maxAnchors,
  maxArtifactBytes: limits.maxArtifactBytes,
});

function fsyncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) { if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function installLock(root, clock) {
  const lockFile = path.join(root, 'writer.lock'); const token = randomBytes(16).toString('hex');
  const acquiredTs = clock(); if (!ts(acquiredTs)) throw fail('CONTROL_CLOCK_INVALID', 'lock clock malformed');
  let fd;
  try {
    fd = openSync(lockFile, 'wx', 0o600);
    writeSync(fd, `${stableStringify({ version: DAILY_SHARD_CONTROL_AGGREGATOR_VERSION, token, pid: process.pid, acquiredTs })}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined; fsyncDirectory(root);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (error?.code === 'EEXIST') throw fail('CONTROL_LOCK_HELD', 'writer.lock exists; no timed takeover');
    throw error;
  }
  const assertOwned = () => {
    let current; try { current = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { throw fail('CONTROL_LOCK_LOST', 'writer.lock unreadable'); }
    if (current?.version !== DAILY_SHARD_CONTROL_AGGREGATOR_VERSION || current.token !== token) throw fail('CONTROL_LOCK_LOST', 'writer.lock identity changed');
  };
  return {
    assertOwned,
    release() { assertOwned(); unlinkSync(lockFile); fsyncDirectory(root); },
  };
}

function stateError(state, { job, manifest, inventory, descriptor, limits }) {
  if (!exact(state, STATE_KEYS) || state.stateVersion !== DAILY_SHARD_CONTROL_STATE_VERSION
      || !HEX64.test(state.stateDigest ?? '') || state.stateDigest !== digestWithout(state, 'stateDigest')
      || state.jobDigest !== job.jobDigest || state.manifestDigest !== manifest.manifestDigest
      || state.anchorInventoryDigest !== inventory.inventoryDigest
      || !count(state.nextShardIndex, descriptor.shardCount) || !count(state.revision, descriptor.shardCount)
      || state.nextShardIndex !== state.revision || !Array.isArray(state.artifactAcks)
      || state.artifactAcks.length !== state.revision || state.completed !== (state.revision === descriptor.shardCount)
      || !exact(state.durability, ['scope', 'republishSafe', 'externalArchive'])
      || state.durability.scope !== 'LOCAL_FILESYSTEM_ONLY' || state.durability.republishSafe !== false
      || state.durability.externalArchive !== 'UNKNOWN') return 'control state identity or counters malformed';
  let prior = null;
  for (let index = 0; index < state.artifactAcks.length; index += 1) {
    const ack = state.artifactAcks[index]; const shard = descriptor.shards[index];
    if (!exact(ack, ACK_KEYS) || ack.ackVersion !== DAILY_SHARD_PREFIX_ACK_VERSION
        || ack.revision !== index + 1 || ack.shardIndex !== index
        || ack.shardId !== shard.shardId || ack.shardDigest !== shard.shardDigest
        || !HEX64.test(ack.receiptDigest ?? '') || !HEX64.test(ack.classificationOutputDigest ?? '')
        || !HEX64.test(ack.artifactDigest ?? '') || ack.artifactId !== `dspf-${ack.artifactDigest}`
        || (ack.previousAckDigest ?? null) !== (prior?.ackDigest ?? null)
        || !ts(ack.durableTs) || !HEX64.test(ack.ackDigest ?? '')
        || ack.ackDigest !== digestWithout(ack, 'ackDigest')) return `artifactAcks[${index}] malformed`;
    prior = ack;
  }
  if (state.completed) {
    if (dailyShardControlResultError(state.result, { job, manifest, inventory, descriptor, limits })) return 'completed state result malformed';
  } else if (state.result !== null) return 'incomplete state carries result';
  return null;
}

function artifactFile(root, index) { return path.join(root, 'artifacts', `${String(index).padStart(5, '0')}.json`); }

function readArtifact(file, context, limits) {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw fail('CONTROL_ARTIFACT_MISSING', 'expected prefix artifact absent or symlinked');
  if (lstatSync(file).size > limits.maxArtifactBytes) throw fail('CONTROL_ARTIFACT_CORRUPT', 'prefix artifact exceeds byte bound');
  let value; try { value = readJsonBounded(file, limits.maxArtifactBytes); } catch { throw fail('CONTROL_ARTIFACT_CORRUPT', 'prefix artifact unreadable'); }
  const error = dailyShardPrefixArtifactError(value, { ...context, limits: prefixLimitsOf(limits) });
  if (error) throw fail('CONTROL_ARTIFACT_CORRUPT', error);
  return value;
}

function resultDigestOf(value) { return digestWithout(value, 'resultDigest'); }

export function dailyShardControlResultError(value, {
  job = null, manifest = null, inventory = null, descriptor = null, limits: suppliedLimits,
} = {}) {
  let limits; try { limits = limitsOf(suppliedLimits); } catch (error) { return error.message; }
  const keys = [
    'resultVersion', 'resultDigest', 'jobDigest', 'manifestDigest', 'datasetDigest',
    'anchorInventoryDigest', 'acceptedDenominatorCount', 'artifactCount',
    'surgeCount', 'controlMatches', 'missingControlMatches', 'comparisons',
    'resultState', 'retrospectiveSelection', 'attemptedSimulations',
    'completedSimulations', 'validSimulationOutcomes', 'authority',
    'learningEligible', 'simulationCredit', 'durability',
  ];
  if (!exact(value, keys) || value.resultVersion !== DAILY_SHARD_CONTROL_RESULT_VERSION
      || !HEX64.test(value.resultDigest ?? '') || value.resultDigest !== resultDigestOf(value)
      || !HEX64.test(value.jobDigest ?? '') || !HEX64.test(value.manifestDigest ?? '')
      || !HEX64.test(value.datasetDigest ?? '') || !HEX64.test(value.anchorInventoryDigest ?? '')
      || !count(value.acceptedDenominatorCount, limits.maxMarkets)
      || value.artifactCount !== value.acceptedDenominatorCount
      || !count(value.surgeCount, limits.maxAnchors) || !Array.isArray(value.controlMatches)
      || value.controlMatches.length !== value.surgeCount
      || !count(value.missingControlMatches, value.surgeCount * CONTROL_CLASSES.length)
      || !count(value.comparisons, limits.maxMatchComparisons)
      || value.resultState !== 'COMPLETE_RETROSPECTIVE_CONTROL_MATCHING_NO_SIMULATION'
      || value.retrospectiveSelection !== 'FULL_DAY_DISPOSITIONS_SELECT_COHORT;DISTANCE_USES_STRICT_PRE_ANCHOR_FACTS_ONLY'
      || value.attemptedSimulations !== 0 || value.completedSimulations !== 0
      || value.validSimulationOutcomes !== 0 || value.authority !== 'NONE'
      || value.learningEligible !== false || value.simulationCredit !== 0
      || !exact(value.durability, ['scope', 'republishSafe', 'externalArchive'])
      || value.durability.scope !== 'LOCAL_FILESYSTEM_ONLY' || value.durability.republishSafe !== false
      || value.durability.externalArchive !== 'UNKNOWN') return 'control result shape, identity, bounds, or zero-credit law malformed';
  const seen = new Set(); const selectedControls = new Set(); let missing = 0;
  for (let rowIndex = 0; rowIndex < value.controlMatches.length; rowIndex += 1) {
    const row = value.controlMatches[rowIndex]; const expectedAnchor = inventory?.anchors?.[rowIndex] ?? null;
    if (!exact(row, ['surgeMarketIdentityDigest', 'anchorTs', 'matches', 'missingClasses'])
        || !HEX64.test(row.surgeMarketIdentityDigest ?? '') || !ts(row.anchorTs)
        || seen.has(row.surgeMarketIdentityDigest) || !Array.isArray(row.matches)
        || !Array.isArray(row.missingClasses) || row.matches.length + row.missingClasses.length !== CONTROL_CLASSES.length
        || row.missingClasses.some((name) => !CONTROL_CLASSES.includes(name))) return 'control result match row malformed';
    if (expectedAnchor && (row.surgeMarketIdentityDigest !== expectedAnchor.surgeMarketIdentityDigest
        || row.anchorTs !== expectedAnchor.anchorTs)) return 'control result anchor order differs from inventory';
    seen.add(row.surgeMarketIdentityDigest); missing += row.missingClasses.length;
    const classes = new Set(row.missingClasses);
    for (const match of row.matches) {
      if (!exact(match, ['controlClass', 'marketIdentityDigest', 'distance', 'surgeFactDigest', 'controlFactDigest'])
          || !CONTROL_CLASSES.includes(match.controlClass) || classes.has(match.controlClass)
          || !HEX64.test(match.marketIdentityDigest ?? '') || !Number.isFinite(match.distance) || match.distance < 0
          || !HEX64.test(match.surgeFactDigest ?? '') || !HEX64.test(match.controlFactDigest ?? '')
          || selectedControls.has(match.marketIdentityDigest)) return 'control result selected match malformed or reused';
      selectedControls.add(match.marketIdentityDigest);
      classes.add(match.controlClass);
    }
    if (classes.size !== CONTROL_CLASSES.length) return 'control result class census malformed';
  }
  if (missing !== value.missingControlMatches) return 'control result missing census differs';
  if (job && (value.jobDigest !== job.jobDigest || value.datasetDigest !== job.datasetDigest
      || value.acceptedDenominatorCount !== job.shardCount)) return 'control result job mismatch';
  if (manifest && value.manifestDigest !== manifest.manifestDigest) return 'control result manifest mismatch';
  if (inventory && (value.anchorInventoryDigest !== inventory.inventoryDigest || value.surgeCount !== inventory.anchorCount)) return 'control result anchor inventory mismatch';
  if (descriptor && value.artifactCount !== descriptor.shardCount) return 'control result artifact denominator mismatch';
  return null;
}

async function aggregateArtifacts({ artifactRoot, job, manifest, inventory, descriptor, runnerAcks, limits, signal }) {
  const ownFacts = new Map();
  for (const anchor of inventory.anchors) {
    const index = descriptor.shards.findIndex((shard) => shard.marketIdentityDigest === anchor.surgeMarketIdentityDigest);
    if (index < 0) throw fail('CONTROL_RESULT_INVALID', 'surge anchor market absent from denominator');
    const artifact = readArtifact(artifactFile(artifactRoot, index), {
      job, manifest, shard: descriptor.shards[index],
      receipt: { receiptDigest: runnerAcks[index].receiptDigest, marketDayDigest: runnerAcks[index].marketDayDigest },
      classificationOutput: runnerAcks[index].output, anchorInventory: inventory,
    }, limits);
    const factIndex = inventory.anchors.findIndex((row) => row.surgeMarketIdentityDigest === anchor.surgeMarketIdentityDigest);
    ownFacts.set(anchor.surgeMarketIdentityDigest, artifact.facts[factIndex]);
  }
  const used = new Set(); const controlMatches = []; let comparisons = 0; let missingControlMatches = 0;
  for (let anchorIndex = 0; anchorIndex < inventory.anchors.length; anchorIndex += 1) {
    if (signal?.aborted) throw fail('CONTROL_CANCELLED', 'control aggregation cancelled');
    const anchor = inventory.anchors[anchorIndex]; const own = ownFacts.get(anchor.surgeMarketIdentityDigest);
    const matches = []; const missingClasses = [];
    for (const controlClass of CONTROL_CLASSES) {
      const ranked = [];
      for (let index = 0; index < descriptor.shards.length; index += 1) {
        const output = runnerAcks[index].output;
        if (output.disposition !== controlClass || used.has(output.marketIdentityDigest)) continue;
        comparisons += 1;
        if (comparisons > limits.maxMatchComparisons) throw fail('CONTROL_COMPARISON_LIMIT', 'comparison bound exceeded; no result was completed');
        const artifact = readArtifact(artifactFile(artifactRoot, index), {
          job, manifest, shard: descriptor.shards[index],
          receipt: { receiptDigest: runnerAcks[index].receiptDigest, marketDayDigest: runnerAcks[index].marketDayDigest },
          classificationOutput: output, anchorInventory: inventory,
        }, limits);
        const candidate = artifact.facts[anchorIndex];
        if (own?.state !== 'AVAILABLE' || candidate?.state !== 'AVAILABLE') continue;
        const distance = dailyMoveControlMatchDistance(own, candidate);
        if (distance !== null) ranked.push({
          controlClass, marketIdentityDigest: artifact.marketIdentityDigest, distance,
          surgeFactDigest: own.factDigest, controlFactDigest: candidate.factDigest,
          caseId: `dmcase-${canonicalDigest({ manifestId: manifest.manifestId, marketIdentityDigest: artifact.marketIdentityDigest }).slice(0, 24)}`,
        });
        if (comparisons % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      ranked.sort((a, b) => a.distance - b.distance || a.caseId.localeCompare(b.caseId));
      const selected = ranked[0] ? Object.fromEntries(Object.entries(ranked[0]).filter(([key]) => key !== 'caseId')) : null;
      if (selected) { used.add(selected.marketIdentityDigest); matches.push(selected); }
      else { missingClasses.push(controlClass); missingControlMatches += 1; }
    }
    controlMatches.push({
      surgeMarketIdentityDigest: anchor.surgeMarketIdentityDigest,
      anchorTs: anchor.anchorTs, matches, missingClasses,
    });
  }
  const result = {
    resultVersion: DAILY_SHARD_CONTROL_RESULT_VERSION, resultDigest: '',
    jobDigest: job.jobDigest, manifestDigest: manifest.manifestDigest,
    datasetDigest: job.datasetDigest, anchorInventoryDigest: inventory.inventoryDigest,
    acceptedDenominatorCount: job.shardCount, artifactCount: descriptor.shardCount,
    surgeCount: inventory.anchorCount, controlMatches, missingControlMatches, comparisons,
    resultState: 'COMPLETE_RETROSPECTIVE_CONTROL_MATCHING_NO_SIMULATION',
    retrospectiveSelection: 'FULL_DAY_DISPOSITIONS_SELECT_COHORT;DISTANCE_USES_STRICT_PRE_ANCHOR_FACTS_ONLY',
    attemptedSimulations: 0, completedSimulations: 0, validSimulationOutcomes: 0,
    authority: 'NONE', learningEligible: false, simulationCredit: 0,
    durability: { scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN' },
  };
  result.resultDigest = resultDigestOf(result);
  const error = dailyShardControlResultError(result, { job, manifest, inventory, descriptor, limits });
  if (error) throw fail('CONTROL_RESULT_INVALID', error);
  return result;
}

async function openImpl({
  archiveRoot, stateRoot, dayStartTs, dayEndTs, asOfTs, manifest,
  runnerState: suppliedRunnerState, clock = () => Date.now(), limits: suppliedLimits,
  readerLimits, shardLimits, signal = null,
} = {}, sourceFactory) {
  const limits = limitsOf(suppliedLimits);
  const manifestError = dailyMoveStudyManifestError(manifest);
  if (manifestError || typeof stateRoot !== 'string' || stateRoot.length < 1 || !plain(suppliedRunnerState)) {
    throw fail('CONTROL_ARGUMENT_INVALID', manifestError ?? 'stateRoot or runner state malformed');
  }
  if (manifest.rules.controlsPerClass !== 1) {
    throw fail('CONTROL_RULE_UNSUPPORTED', 'this bounded aggregator requires exactly one control per class');
  }
  const runnerState = clone(suppliedRunnerState);
  if (runnerState.completed !== true) throw fail('CONTROL_CLASSIFICATION_INCOMPLETE', 'classifier runner has not acknowledged the full denominator');
  mkdirSync(stateRoot, { recursive: true }); const root = realpathSync(path.resolve(stateRoot));
  const artifactsRoot = path.join(root, 'artifacts');
  if (existsSync(artifactsRoot) && lstatSync(artifactsRoot).isSymbolicLink()) throw fail('CONTROL_ARTIFACT_ROOT_INVALID', 'artifacts directory cannot be a symlink');
  mkdirSync(artifactsRoot, { recursive: true });
  if (realpathSync(artifactsRoot) !== path.resolve(artifactsRoot)) throw fail('CONTROL_ARTIFACT_ROOT_INVALID', 'artifacts directory identity changed');
  const lock = installLock(root, clock); let source; let state; let closed = false; let closing = false; let inFlight = null;
  try {
    source = await sourceFactory({ archiveRoot, dayStartTs, dayEndTs, asOfTs, readerLimits, shardLimits, signal });
    const descriptor = source.descriptor; const job = runnerState.job; const runnerAcks = runnerState.acknowledgments;
    const runnerStateError = dailyShardedStudyStateError(runnerState, { descriptor });
    if (runnerStateError) throw fail('CONTROL_CLASSIFICATION_STATE_INVALID', runnerStateError);
    if (!plain(job) || descriptor.datasetId !== job.datasetId || descriptor.datasetDigest !== job.datasetDigest
        || descriptor.sourceDatasetId !== job.sourceDatasetId || descriptor.sourceDatasetDigest !== job.sourceDatasetDigest
        || descriptor.acceptedCatalogSnapshot.contentDigest !== job.catalogSnapshotDigest
        || descriptor.catalogProvenance.catalogEpochDigest !== job.catalogEpochDigest
        || descriptor.shardCount !== job.shardCount || canonicalDigest(descriptor.shards) !== job.shardInventoryDigest
        || descriptor.dayStartTs !== job.dayStartTs || descriptor.dayEndTs !== job.dayEndTs || descriptor.asOfTs !== job.asOfTs
        || manifest.manifestDigest !== runnerAcks[0]?.output?.manifestDigest) {
      throw fail('CONTROL_SOURCE_BINDING_INVALID', 'source, job, manifest, or denominator differs');
    }
    const prefixLimits = prefixLimitsOf(limits);
    const inventory = sealDailySurgeAnchorInventory({ job, descriptor, acknowledgments: runnerAcks, limits: prefixLimits });
    const stateFile = path.join(root, 'state.json');
    if (existsSync(stateFile)) {
      if (lstatSync(stateFile).isSymbolicLink() || lstatSync(stateFile).size > limits.maxStateBytes) throw fail('CONTROL_STATE_INVALID', 'state symlinked or oversized');
      state = readJsonBounded(stateFile, limits.maxStateBytes);
      const error = stateError(state, { job, manifest, inventory, descriptor, limits });
      if (error) throw fail('CONTROL_STATE_INVALID', error);
    } else {
      state = {
        stateVersion: DAILY_SHARD_CONTROL_STATE_VERSION, stateDigest: '',
        jobDigest: job.jobDigest, manifestDigest: manifest.manifestDigest,
        anchorInventoryDigest: inventory.inventoryDigest, nextShardIndex: 0, revision: 0,
        artifactAcks: [], completed: false, result: null,
        durability: { scope: 'LOCAL_FILESYSTEM_ONLY', republishSafe: false, externalArchive: 'UNKNOWN' },
      };
      state.stateDigest = digestWithout(state, 'stateDigest'); atomicWriteJson(stateFile, state, { sync: true });
    }
    for (let index = 0; index < state.artifactAcks.length; index += 1) {
      const durableAck = state.artifactAcks[index]; const classifierAck = runnerAcks[index];
      const artifact = readArtifact(artifactFile(root, index), {
        job, manifest, shard: descriptor.shards[index],
        receipt: { receiptDigest: classifierAck.receiptDigest, marketDayDigest: classifierAck.marketDayDigest },
        classificationOutput: classifierAck.output, anchorInventory: inventory,
      }, limits);
      if (durableAck.receiptDigest !== classifierAck.receiptDigest
          || durableAck.classificationOutputDigest !== canonicalDigest(classifierAck.output)
          || durableAck.artifactId !== artifact.artifactId
          || durableAck.artifactDigest !== artifact.artifactDigest) {
        throw fail('CONTROL_STATE_INVALID', `artifactAcks[${index}] differs from durable artifact/classifier custody`);
      }
    }
    if (state.completed) {
      const replayedResult = await aggregateArtifacts({
        artifactRoot: root, job, manifest, inventory, descriptor, runnerAcks,
        limits, signal,
      });
      if (replayedResult.resultDigest !== state.result.resultDigest) {
        throw fail('CONTROL_RESULT_REPLAY_MISMATCH', 'stored result differs from exact prefix artifacts');
      }
    }

    const publicStatus = (override = null) => deepFreeze({
      aggregatorVersion: DAILY_SHARD_CONTROL_AGGREGATOR_VERSION,
      status: override ?? (closed ? 'CLOSED' : closing ? 'CLOSING' : state.completed ? 'COMPLETE' : 'READY'),
      jobDigest: job.jobDigest, datasetDigest: job.datasetDigest,
      revision: state.revision, processedArtifacts: state.artifactAcks.length,
      acceptedDenominatorCount: job.shardCount,
      remainingArtifacts: job.shardCount - state.artifactAcks.length,
      surgeAnchorCount: inventory.anchorCount, completed: state.completed,
      result: state.result ? clone(state.result) : null,
      durability: clone(state.durability), authority: 'NONE', learningEligible: false, simulationCredit: 0,
    });

    const execute = ({ maxShards = 1, signal: executeSignal = null } = {}) => {
      if (closing || closed) return Promise.reject(fail('CONTROL_CLOSED', 'aggregator is closing or closed'));
      if (inFlight) return inFlight;
      if (!count(maxShards, limits.maxShardsPerExecute) || maxShards < 1) return Promise.reject(fail('CONTROL_STEP_LIMIT', 'maxShards outside bound'));
      inFlight = (async () => {
        let processed = 0;
        while (!state.completed && state.nextShardIndex < descriptor.shardCount && processed < maxShards) {
          if (executeSignal?.aborted) return publicStatus('CANCELLED');
          const index = state.nextShardIndex; const shard = descriptor.shards[index]; const classifierAck = runnerAcks[index];
          let loaded;
          try {
            loaded = await source.loadShard({ shardId: shard.shardId, signal: executeSignal });
            if (executeSignal?.aborted) return publicStatus('CANCELLED');
            if (loaded.receipt.receiptDigest !== classifierAck.receiptDigest
                || loaded.receipt.marketDayDigest !== classifierAck.marketDayDigest) throw fail('CONTROL_SOURCE_REPLAY_MISMATCH', 'source shard differs from classifier ACK');
            const artifact = sealDailyShardPrefixArtifact({
              job, manifest, shard, receipt: loaded.receipt, marketDay: loaded.marketDay,
              classificationOutput: classifierAck.output, anchorInventory: inventory, limits: prefixLimits,
            });
            const file = artifactFile(root, index);
            if (existsSync(file)) {
              const existing = readArtifact(file, {
                job, manifest, shard, receipt: loaded.receipt,
                classificationOutput: classifierAck.output, anchorInventory: inventory,
              }, prefixLimits);
              if (existing.artifactDigest !== artifact.artifactDigest) throw fail('CONTROL_ARTIFACT_CONFLICT', 'first-written artifact differs from replay');
            } else atomicWriteJson(file, artifact, { sync: true });
            if (executeSignal?.aborted) return publicStatus('CANCELLED');
            const prior = state.artifactAcks.at(-1) ?? null; const durableTs = clock();
            if (!ts(durableTs)) throw fail('CONTROL_CLOCK_INVALID', 'artifact ACK clock malformed');
            const ack = {
              ackVersion: DAILY_SHARD_PREFIX_ACK_VERSION, ackDigest: '', revision: state.revision + 1,
              shardIndex: index, shardId: shard.shardId, shardDigest: shard.shardDigest,
              receiptDigest: classifierAck.receiptDigest,
              classificationOutputDigest: canonicalDigest(classifierAck.output),
              artifactId: artifact.artifactId, artifactDigest: artifact.artifactDigest,
              previousAckDigest: prior?.ackDigest ?? null, durableTs,
            };
            ack.ackDigest = digestWithout(ack, 'ackDigest');
            const next = {
              ...state, stateDigest: '', revision: ack.revision, nextShardIndex: index + 1,
              artifactAcks: [...state.artifactAcks, ack], completed: false, result: null,
            };
            next.stateDigest = digestWithout(next, 'stateDigest');
            if (Buffer.byteLength(stableStringify(next), 'utf8') > limits.maxStateBytes) throw fail('CONTROL_STATE_LIMIT', 'next state exceeds byte bound');
            if (loaded !== undefined) { if (typeof loaded.release !== 'function') throw fail('CONTROL_SOURCE_RELEASE_INVALID', 'source release missing'); loaded.release(); loaded = undefined; }
            lock.assertOwned(); atomicWriteJson(stateFile, next, { sync: true }); state = next; processed += 1;
            await new Promise((resolve) => setImmediate(resolve));
          } finally {
            if (loaded !== undefined) { if (typeof loaded.release !== 'function') throw fail('CONTROL_SOURCE_RELEASE_INVALID', 'source release missing'); loaded.release(); }
          }
        }
        if (!state.completed && state.nextShardIndex === descriptor.shardCount) {
          if (executeSignal?.aborted) return publicStatus('CANCELLED');
          const result = await aggregateArtifacts({
            artifactRoot: root, job, manifest, inventory, descriptor, runnerAcks, limits,
            signal: executeSignal,
          });
          const next = { ...state, stateDigest: '', completed: true, result };
          next.stateDigest = digestWithout(next, 'stateDigest');
          if (Buffer.byteLength(stableStringify(next), 'utf8') > limits.maxStateBytes) throw fail('CONTROL_STATE_LIMIT', 'completed state exceeds byte bound');
          lock.assertOwned(); atomicWriteJson(stateFile, next, { sync: true }); state = next;
        }
        return publicStatus();
      })().finally(() => { inFlight = null; });
      return inFlight;
    };

    const close = async () => {
      if (closed) return publicStatus(); closing = true;
      try { if (inFlight) await inFlight; source.close(); lock.release(); closed = true; }
      finally { closing = false; }
      return publicStatus();
    };
    return Object.freeze({ execute, status: publicStatus, close, anchorInventory: inventory });
  } catch (error) {
    try { source?.close(); } catch {}
    try { lock.release(); } catch {}
    throw error;
  }
}

export function openDailyShardControlAggregator(options = {}) {
  return openImpl(options, ({ archiveRoot, dayStartTs, dayEndTs, asOfTs, readerLimits, shardLimits, signal }) => openDailyBroadArchiveShardSource({
    rootDir: archiveRoot, dayStartTs, dayEndTs, asOfTs, readerLimits, limits: shardLimits, signal,
  }));
}

export function openDailyShardControlAggregatorForTest(options = {}, { source } = {}) {
  if (!source || !source.descriptor || typeof source.loadShard !== 'function' || typeof source.close !== 'function') {
    return Promise.reject(fail('CONTROL_TEST_SOURCE_INVALID', 'test source malformed'));
  }
  return openImpl(options, async () => source);
}
