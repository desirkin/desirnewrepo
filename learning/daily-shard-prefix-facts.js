// Content-bound, bounded prefix facts for cross-market retrospective control
// matching. The anchor inventory comes only from a complete durable classifier
// ACK chain. Facts use the exact existing daily-move strict-before clock law.
import {
  dailyMoveControlPrefixFacts, dailyMoveStudyManifestError,
} from './daily-move-study.js';
import {
  DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION, dailyShardClassificationOutputError,
} from './daily-sharded-study-classifier.js';
import { dailyShardConsumerAckError } from './daily-sharded-study-runner.js';
import { dailyBroadArchiveMarketDayReceiptError } from './daily-broad-archive-shards.js';
import { canonicalDigest, deepFreeze, stableStringify } from './shadow-contracts.js';

export const DAILY_SURGE_ANCHOR_INVENTORY_VERSION = 'daily-surge-anchor-inventory-1';
export const DAILY_SHARD_PREFIX_ARTIFACT_VERSION = 'daily-shard-prefix-facts-1';
export const DAILY_SHARD_PREFIX_LIMITS = Object.freeze({
  maxMarkets: 5_000, maxAnchors: 1_500, maxArtifactBytes: 512 * 1024,
});
const HARD = Object.freeze({ maxMarkets: 5_000, maxAnchors: 1_500, maxArtifactBytes: 1024 * 1024 });
const HEX64 = /^[a-f0-9]{64}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const ts = (value) => Number.isSafeInteger(value) && value > 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const digestWithout = (value, key) => canonicalDigest(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)));
const artifactDigestOf = (value) => canonicalDigest(Object.fromEntries(
  Object.entries(value).filter(([name]) => name !== 'artifactId' && name !== 'artifactDigest'),
));
const ANCHOR_KEYS = Object.freeze(['surgeMarketIdentityDigest', 'anchorTs', 'classificationOutputDigest']);
const INVENTORY_KEYS = Object.freeze([
  'inventoryVersion', 'inventoryDigest', 'jobDigest', 'datasetDigest',
  'manifestDigest', 'catalogContentDigest', 'acceptedDenominatorCount',
  'anchorCount', 'anchors',
]);
const FACT_KEYS = Object.freeze([
  'factVersion', 'factDigest', 'surgeMarketIdentityDigest', 'anchorTs', 'state',
  'realizedVolPct', 'logQuoteVolume', 'supportSignature', 'sampleCount',
  'clockLaw',
]);
const ARTIFACT_KEYS = Object.freeze([
  'artifactVersion', 'artifactId', 'artifactDigest', 'jobDigest', 'datasetId',
  'datasetDigest', 'manifestId', 'manifestDigest', 'catalogContentDigest',
  'shardId', 'shardDigest', 'receiptDigest', 'marketDayDigest',
  'marketIdentityDigest', 'classificationOutputDigest', 'disposition',
  'anchorInventoryDigest', 'factCount', 'facts', 'byteBasis', 'authority',
  'learningEligible', 'simulationCredit',
]);

function limitsOf(input) {
  if (input !== undefined && !plain(input)) throw fail('PREFIX_LIMITS_INVALID', 'limits must be an object');
  const unknown = Object.keys(input ?? {}).filter((key) => !(key in DAILY_SHARD_PREFIX_LIMITS));
  if (unknown.length) throw fail('PREFIX_LIMITS_INVALID', `unknown limits: ${unknown.join(',')}`);
  const value = { ...DAILY_SHARD_PREFIX_LIMITS, ...(input ?? {}) };
  for (const [key, ceiling] of Object.entries(HARD)) {
    if (!count(value[key], ceiling) || value[key] < 1) throw fail('PREFIX_LIMITS_INVALID', `${key} violates its hard bound`);
  }
  return Object.freeze(value);
}

export function dailySurgeAnchorInventoryError(value, { job = null, limits: suppliedLimits } = {}) {
  let limits; try { limits = limitsOf(suppliedLimits); } catch (error) { return error.message; }
  if (!exact(value, INVENTORY_KEYS) || value.inventoryVersion !== DAILY_SURGE_ANCHOR_INVENTORY_VERSION
      || !HEX64.test(value.inventoryDigest ?? '') || !HEX64.test(value.jobDigest ?? '')
      || !HEX64.test(value.datasetDigest ?? '') || !HEX64.test(value.manifestDigest ?? '')
      || !HEX64.test(value.catalogContentDigest ?? '')
      || !count(value.acceptedDenominatorCount, limits.maxMarkets) || value.acceptedDenominatorCount < 1
      || !count(value.anchorCount, limits.maxAnchors) || !Array.isArray(value.anchors)
      || value.anchorCount !== value.anchors.length
      || value.inventoryDigest !== digestWithout(value, 'inventoryDigest')) return 'surge anchor inventory identity or bounds malformed';
  const seenMarkets = new Set();
  for (const anchor of value.anchors) {
    if (!exact(anchor, ANCHOR_KEYS) || !HEX64.test(anchor.surgeMarketIdentityDigest ?? '')
        || !ts(anchor.anchorTs) || !HEX64.test(anchor.classificationOutputDigest ?? '')
        || seenMarkets.has(anchor.surgeMarketIdentityDigest)) return 'surge anchor row malformed or duplicated';
    seenMarkets.add(anchor.surgeMarketIdentityDigest);
  }
  if (value.anchors.map((row) => row.surgeMarketIdentityDigest).join('\n')
      !== [...value.anchors].sort((a, b) => a.surgeMarketIdentityDigest.localeCompare(b.surgeMarketIdentityDigest))
        .map((row) => row.surgeMarketIdentityDigest).join('\n')) return 'surge anchor inventory is not canonical-sorted';
  if (job && (value.jobDigest !== job.jobDigest || value.datasetDigest !== job.datasetDigest
      || value.catalogContentDigest !== job.catalogSnapshotDigest
      || value.acceptedDenominatorCount !== job.shardCount)) return 'surge anchor inventory differs from source job';
  return null;
}

export function sealDailySurgeAnchorInventory({ job, descriptor, acknowledgments, limits: suppliedLimits } = {}) {
  const limits = limitsOf(suppliedLimits);
  if (!plain(job) || !plain(descriptor) || !Array.isArray(descriptor.shards)
      || descriptor.shards.length !== job?.shardCount || descriptor.shardCount !== job.shardCount
      || !Array.isArray(acknowledgments)) throw fail('PREFIX_ACK_INVENTORY_INVALID', 'job/descriptor/acknowledgments malformed');
  if (job.shardCount > limits.maxMarkets) throw fail('PREFIX_MARKET_LIMIT', 'accepted denominator exceeds bound');
  if (acknowledgments.length !== job.shardCount) {
    throw fail('PREFIX_CLASSIFICATION_INCOMPLETE', `complete denominator required; missing ${job.shardCount - acknowledgments.length} acknowledgments`);
  }
  let prior = null; let manifestDigest = acknowledgments[0]?.output?.manifestDigest ?? null; const anchors = [];
  for (let index = 0; index < acknowledgments.length; index += 1) {
    const ack = acknowledgments[index]; const shard = descriptor.shards[index];
    const receipt = { receiptDigest: ack?.receiptDigest, marketDayDigest: ack?.marketDayDigest };
    const error = dailyShardConsumerAckError(ack, { job, shard, receipt, prior });
    if (error || ack.output?.outputVersion !== DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION) {
      throw fail('PREFIX_ACK_INVENTORY_INVALID', error ?? `acknowledgments[${index}] is not a classifier output`);
    }
    if (ack.output.manifestDigest !== manifestDigest) throw fail('PREFIX_ACK_INVENTORY_INVALID', 'classification manifest changes within ACK chain');
    if (ack.output.disposition === 'SURGE_CASE') {
      if (!ts(ack.output.anchorTs) || !HEX64.test(ack.output.anchorPrefixDigest ?? '')) throw fail('PREFIX_ACK_INVENTORY_INVALID', 'surge lacks sealed anchor');
      anchors.push({
        surgeMarketIdentityDigest: ack.output.marketIdentityDigest,
        anchorTs: ack.output.anchorTs,
        classificationOutputDigest: canonicalDigest(ack.output),
      });
    }
    prior = ack;
  }
  if (anchors.length > limits.maxAnchors) throw fail('PREFIX_ANCHOR_LIMIT', 'surge anchor count exceeds bound; no prefix is silently skipped');
  anchors.sort((a, b) => a.surgeMarketIdentityDigest.localeCompare(b.surgeMarketIdentityDigest));
  const value = {
    inventoryVersion: DAILY_SURGE_ANCHOR_INVENTORY_VERSION, inventoryDigest: '',
    jobDigest: job.jobDigest, datasetDigest: job.datasetDigest, manifestDigest,
    catalogContentDigest: job.catalogSnapshotDigest,
    acceptedDenominatorCount: job.shardCount, anchorCount: anchors.length, anchors,
  };
  value.inventoryDigest = digestWithout(value, 'inventoryDigest');
  const error = dailySurgeAnchorInventoryError(value, { job, limits });
  if (error) throw fail('PREFIX_ANCHOR_INVENTORY_INVALID', error);
  return deepFreeze(value);
}

function factError(value, anchor) {
  if (!exact(value, FACT_KEYS) || value.factVersion !== 'daily-control-prefix-fact-1'
      || !HEX64.test(value.factDigest ?? '') || value.factDigest !== digestWithout(value, 'factDigest')
      || value.surgeMarketIdentityDigest !== anchor.surgeMarketIdentityDigest
      || value.anchorTs !== anchor.anchorTs
      || !['AVAILABLE', 'MISSING'].includes(value.state)
      || value.clockLaw !== 'SOURCE_EVENT_AND_KNOWN_AT_STRICTLY_BEFORE_ANCHOR') return 'prefix fact identity malformed';
  if (value.state === 'MISSING') {
    if (value.realizedVolPct !== null || value.logQuoteVolume !== null
        || value.supportSignature !== null || value.sampleCount !== 0) return 'missing prefix fact carries values';
  } else if (!finite(value.realizedVolPct) || value.realizedVolPct < 0
      || !(value.logQuoteVolume === null || (finite(value.logQuoteVolume) && value.logQuoteVolume >= 0))
      || typeof value.supportSignature !== 'string' || value.supportSignature.length < 1 || value.supportSignature.length > 240
      || !count(value.sampleCount, 100_000) || value.sampleCount < 2) return 'available prefix fact malformed';
  return null;
}

export function dailyShardPrefixArtifactError(value, {
  job = null, manifest = null, shard = null, receipt = null,
  classificationOutput = null, anchorInventory = null, limits: suppliedLimits,
} = {}) {
  let limits; try { limits = limitsOf(suppliedLimits); } catch (error) { return error.message; }
  if (!exact(value, ARTIFACT_KEYS) || value.artifactVersion !== DAILY_SHARD_PREFIX_ARTIFACT_VERSION
      || typeof value.artifactId !== 'string' || value.artifactId !== `dspf-${value.artifactDigest}`
      || !HEX64.test(value.artifactDigest ?? '') || value.artifactDigest !== artifactDigestOf(value)
      || !HEX64.test(value.jobDigest ?? '') || !HEX64.test(value.datasetDigest ?? '')
      || !HEX64.test(value.manifestDigest ?? '') || !HEX64.test(value.catalogContentDigest ?? '')
      || !HEX64.test(value.shardDigest ?? '') || !HEX64.test(value.receiptDigest ?? '')
      || !HEX64.test(value.marketDayDigest ?? '') || !HEX64.test(value.marketIdentityDigest ?? '')
      || !HEX64.test(value.classificationOutputDigest ?? '') || !HEX64.test(value.anchorInventoryDigest ?? '')
      || !count(value.factCount, limits.maxAnchors) || !Array.isArray(value.facts)
      || value.factCount !== value.facts.length
      || value.byteBasis !== 'UTF8_CANONICAL_JSON_OF_THIS_ARTIFACT'
      || value.authority !== 'NONE' || value.learningEligible !== false || value.simulationCredit !== 0) return 'prefix artifact identity, bounds, or authority malformed';
  if (Buffer.byteLength(stableStringify(value), 'utf8') > limits.maxArtifactBytes) return 'prefix artifact exceeds byte bound';
  if (anchorInventory) {
    if (value.anchorInventoryDigest !== anchorInventory.inventoryDigest || value.factCount !== anchorInventory.anchorCount) return 'prefix artifact anchor inventory mismatch';
    for (let index = 0; index < value.facts.length; index += 1) {
      const error = factError(value.facts[index], anchorInventory.anchors[index]); if (error) return `facts[${index}]: ${error}`;
    }
  }
  if (job && (value.jobDigest !== job.jobDigest || value.datasetId !== job.datasetId
      || value.datasetDigest !== job.datasetDigest || value.catalogContentDigest !== job.catalogSnapshotDigest)) return 'prefix artifact job mismatch';
  if (manifest && (value.manifestId !== manifest.manifestId || value.manifestDigest !== manifest.manifestDigest)) return 'prefix artifact manifest mismatch';
  if (shard && (value.shardId !== shard.shardId || value.shardDigest !== shard.shardDigest
      || value.marketIdentityDigest !== shard.marketIdentityDigest)) return 'prefix artifact shard mismatch';
  if (receipt && (value.receiptDigest !== receipt.receiptDigest || value.marketDayDigest !== receipt.marketDayDigest)) return 'prefix artifact receipt mismatch';
  if (classificationOutput && (value.classificationOutputDigest !== canonicalDigest(classificationOutput)
      || value.disposition !== classificationOutput.disposition)) return 'prefix artifact classification mismatch';
  return null;
}

export function sealDailyShardPrefixArtifact({
  job, manifest, shard, receipt, marketDay, classificationOutput,
  anchorInventory, limits: suppliedLimits,
} = {}) {
  const limits = limitsOf(suppliedLimits);
  const manifestError = dailyMoveStudyManifestError(manifest);
  const inventoryError = dailySurgeAnchorInventoryError(anchorInventory, { job, limits });
  const outputError = dailyShardClassificationOutputError(classificationOutput, { job, shard, receipt });
  const receiptError = dailyBroadArchiveMarketDayReceiptError(receipt, { shard, marketDay });
  if (manifestError || inventoryError || outputError || receiptError
      || manifest.manifestDigest !== anchorInventory.manifestDigest
      || classificationOutput.manifestDigest !== manifest.manifestDigest) {
    throw fail('PREFIX_ARTIFACT_INPUT_INVALID', manifestError ?? inventoryError ?? outputError ?? receiptError ?? 'manifest identity differs');
  }
  const facts = anchorInventory.anchors.map((anchor) => {
    const source = dailyMoveControlPrefixFacts(marketDay, manifest, anchor.anchorTs);
    const fact = source === null ? {
      factVersion: 'daily-control-prefix-fact-1', factDigest: '',
      surgeMarketIdentityDigest: anchor.surgeMarketIdentityDigest, anchorTs: anchor.anchorTs,
      state: 'MISSING', realizedVolPct: null, logQuoteVolume: null,
      supportSignature: null, sampleCount: 0,
      clockLaw: 'SOURCE_EVENT_AND_KNOWN_AT_STRICTLY_BEFORE_ANCHOR',
    } : {
      factVersion: 'daily-control-prefix-fact-1', factDigest: '',
      surgeMarketIdentityDigest: anchor.surgeMarketIdentityDigest, anchorTs: anchor.anchorTs,
      state: 'AVAILABLE', realizedVolPct: source.realizedVolPct,
      logQuoteVolume: source.logQuoteVolume, supportSignature: source.supportSignature,
      sampleCount: source.sampleCount,
      clockLaw: 'SOURCE_EVENT_AND_KNOWN_AT_STRICTLY_BEFORE_ANCHOR',
    };
    fact.factDigest = digestWithout(fact, 'factDigest'); return fact;
  });
  const value = {
    artifactVersion: DAILY_SHARD_PREFIX_ARTIFACT_VERSION, artifactId: '', artifactDigest: '',
    jobDigest: job.jobDigest, datasetId: job.datasetId, datasetDigest: job.datasetDigest,
    manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest,
    catalogContentDigest: manifest.catalogSnapshot.contentDigest,
    shardId: shard.shardId, shardDigest: shard.shardDigest,
    receiptDigest: receipt.receiptDigest, marketDayDigest: receipt.marketDayDigest,
    marketIdentityDigest: shard.marketIdentityDigest,
    classificationOutputDigest: canonicalDigest(classificationOutput),
    disposition: classificationOutput.disposition,
    anchorInventoryDigest: anchorInventory.inventoryDigest,
    factCount: facts.length, facts,
    byteBasis: 'UTF8_CANONICAL_JSON_OF_THIS_ARTIFACT', authority: 'NONE',
    learningEligible: false, simulationCredit: 0,
  };
  value.artifactDigest = artifactDigestOf(value); value.artifactId = `dspf-${value.artifactDigest}`;
  const error = dailyShardPrefixArtifactError(value, {
    job, manifest, shard, receipt, classificationOutput, anchorInventory, limits,
  });
  if (error) throw fail(error.includes('byte bound') ? 'PREFIX_ARTIFACT_LIMIT' : 'PREFIX_ARTIFACT_INVALID', error);
  return deepFreeze(value);
}
