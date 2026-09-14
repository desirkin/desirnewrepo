// Pure retrospective classifier for one verified market-day shard. It calls
// the existing full-denominator daily study law, then seals only the selected
// market's classification into a bounded runner output. Missing denominator
// members stay explicit placeholders; cross-market control matching is
// deliberately deferred until a separately verified aggregation phase.
import {
  DAILY_MOVE_MANIFEST_VERSION_V2, DISPOSITIONS, buildDailyDecisionFrame,
  buildDailyMoveStudy, dailyMoveStudyManifestError,
} from './daily-move-study.js';
import {
  dailyBroadArchiveMarketDayReceiptError,
} from './daily-broad-archive-shards.js';
import { canonicalDigest, deepFreeze } from './shadow-contracts.js';

export const DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION = 'daily-shard-classification-output-1';
export const DAILY_SHARD_CLASSIFIER_VERSION = 'daily-shard-study-classifier-1';
const HEX64 = /^[a-f0-9]{64}$/;
const OUTPUT_KEYS = Object.freeze([
  'outputVersion', 'marketIdentityDigest', 'marketDayDigest', 'jobDigest',
  'manifestId', 'manifestDigest', 'catalogContentDigest', 'sourceDatasetDigest',
  'catalogEpochDigest', 'acceptedDenominatorCount', 'observedMarketDayCount',
  'placeholderMissingCount', 'classifiedCaseDigest', 'chronologyDigest',
  'disposition', 'anchorTs', 'anchorPrefixDigest', 'plannedDecisionMoments',
  'matchedControlCount', 'globalControlMatchingState', 'resultState',
  'attemptedSimulations', 'completedSimulations', 'validSimulationOutcomes',
  'authority', 'learningEligible', 'simulationCredit',
]);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const ts = (value) => Number.isSafeInteger(value) && value > 0;
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

export function dailyShardClassificationOutputError(value, {
  job = null, shard = null, receipt = null,
} = {}) {
  if (!exact(value, OUTPUT_KEYS)) return 'classification output shape malformed';
  const anchorPairValid = (value.anchorTs === null && value.anchorPrefixDigest === null)
    || (ts(value.anchorTs) && HEX64.test(value.anchorPrefixDigest ?? ''));
  if (value.outputVersion !== DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION
      || !HEX64.test(value.marketIdentityDigest ?? '') || !HEX64.test(value.marketDayDigest ?? '')
      || !HEX64.test(value.jobDigest ?? '') || !HEX64.test(value.manifestDigest ?? '')
      || value.manifestId !== `dmstudy-${value.manifestDigest.slice(0, 24)}`
      || !HEX64.test(value.catalogContentDigest ?? '') || !HEX64.test(value.sourceDatasetDigest ?? '')
      || !HEX64.test(value.catalogEpochDigest ?? '') || !HEX64.test(value.classifiedCaseDigest ?? '')
      || !HEX64.test(value.chronologyDigest ?? '') || !DISPOSITIONS.includes(value.disposition)
      || !count(value.acceptedDenominatorCount, 5_000) || value.acceptedDenominatorCount < 1
      || value.observedMarketDayCount !== 1
      || value.placeholderMissingCount !== value.acceptedDenominatorCount - 1
      || !anchorPairValid || !count(value.plannedDecisionMoments, 1_500)
      || value.matchedControlCount !== 0
      || value.globalControlMatchingState !== 'DEFERRED_UNTIL_ALL_SHARD_CLASSIFICATIONS_ACKNOWLEDGED'
      || value.resultState !== 'RETROSPECTIVE_CLASSIFIED_NO_SIMULATION'
      || value.attemptedSimulations !== 0 || value.completedSimulations !== 0
      || value.validSimulationOutcomes !== 0 || value.authority !== 'NONE'
      || value.learningEligible !== false || value.simulationCredit !== 0) {
    return 'classification output identity, census, or zero-credit law malformed';
  }
  if (job && (value.jobDigest !== job.jobDigest
      || value.catalogContentDigest !== job.catalogSnapshotDigest
      || value.sourceDatasetDigest !== job.sourceDatasetDigest
      || value.catalogEpochDigest !== job.catalogEpochDigest
      || value.acceptedDenominatorCount !== job.shardCount)) {
    return 'classification output differs from the verified source job denominator';
  }
  if (shard && (value.marketIdentityDigest !== shard.marketIdentityDigest
      || value.marketDayDigest !== receipt?.marketDayDigest)) {
    return 'classification output differs from the loaded source shard';
  }
  return null;
}

function ensureJobBinding(job, manifest, shard, receipt, marketDay) {
  if (!plain(job) || !plain(shard)) throw fail('SHARD_CLASSIFIER_CONTEXT_INVALID', 'job or shard context malformed');
  const receiptError = dailyBroadArchiveMarketDayReceiptError(receipt, { shard, marketDay });
  if (receiptError) throw fail('SHARD_CLASSIFIER_RECEIPT_INVALID', receiptError);
  if (job.jobDigest === undefined || job.catalogSnapshotDigest !== manifest.catalogSnapshot.contentDigest
      || job.sourceDatasetId !== manifest.catalogProvenance.sourceDatasetId
      || job.sourceDatasetDigest !== manifest.catalogProvenance.sourceDatasetDigest
      || job.catalogEpochDigest !== manifest.catalogProvenance.catalogEpochDigest
      || job.dayStartTs !== manifest.dayStartTs || job.dayEndTs !== manifest.dayEndTs
      || job.shardCount !== manifest.catalogSnapshot.acceptedMarketCount
      || receipt.datasetId !== job.datasetId || receipt.datasetDigest !== job.datasetDigest
      || shard.marketIdentityDigest !== marketDay?.marketIdentityDigest) {
    throw fail('SHARD_CLASSIFIER_BINDING_INVALID', 'manifest, job, receipt, or denominator identity differs');
  }
}

export function createDailyShardedStudyClassifier({ manifest } = {}) {
  const manifestError = dailyMoveStudyManifestError(manifest);
  if (manifestError || manifest?.manifestVersion !== DAILY_MOVE_MANIFEST_VERSION_V2) {
    throw fail('SHARD_CLASSIFIER_MANIFEST_INVALID', manifestError ?? 'verified local v2 manifest required');
  }
  const acceptedCatalogSnapshot = manifest.catalogSnapshot;

  const consumeShard = async ({ job, shard, marketDay, receipt } = {}) => {
    ensureJobBinding(job, manifest, shard, receipt, marketDay);
    const study = buildDailyMoveStudy({
      manifest, acceptedCatalogSnapshot, marketDays: [marketDay],
    });
    const selected = study.cases.find((row) => row.marketIdentityDigest === shard.marketIdentityDigest);
    if (!selected || selected.retrospectiveLabels.disposition === 'INVALID_DATA') {
      throw fail('SHARD_CLASSIFIER_MARKET_DAY_INVALID', selected?.retrospectiveLabels?.reason ?? 'classified market absent');
    }
    const expectedMissing = acceptedCatalogSnapshot.acceptedMarketCount - 1;
    if (study.cases.length !== acceptedCatalogSnapshot.acceptedMarketCount
        || study.counters.acceptedMarketDays !== acceptedCatalogSnapshot.acceptedMarketCount
        || study.counters.dispositions.MISSING_DATA !== expectedMissing
        || study.cases.filter((row) => row.marketIdentityDigest !== shard.marketIdentityDigest)
          .some((row) => row.retrospectiveLabels.disposition !== 'MISSING_DATA')
        || selected.matches.length !== 0) {
      throw fail('SHARD_CLASSIFIER_DENOMINATOR_INVALID', 'one-shard classification did not preserve explicit missing denominator members');
    }
    const anchorTs = selected.retrospectiveLabels.anchorTs ?? null;
    const anchorPrefixDigest = anchorTs === null ? null
      : buildDailyDecisionFrame({ manifest, marketDay, decisionTs: anchorTs }).prefixDigest;
    const output = {
      outputVersion: DAILY_SHARD_CLASSIFICATION_OUTPUT_VERSION,
      marketIdentityDigest: shard.marketIdentityDigest,
      marketDayDigest: receipt.marketDayDigest,
      jobDigest: job.jobDigest,
      manifestId: manifest.manifestId,
      manifestDigest: manifest.manifestDigest,
      catalogContentDigest: manifest.catalogSnapshot.contentDigest,
      sourceDatasetDigest: manifest.catalogProvenance.sourceDatasetDigest,
      catalogEpochDigest: manifest.catalogProvenance.catalogEpochDigest,
      acceptedDenominatorCount: acceptedCatalogSnapshot.acceptedMarketCount,
      observedMarketDayCount: 1,
      placeholderMissingCount: expectedMissing,
      classifiedCaseDigest: canonicalDigest(selected),
      chronologyDigest: selected.retrospectiveLabels.chronology.chronologyDigest,
      disposition: selected.retrospectiveLabels.disposition,
      anchorTs,
      anchorPrefixDigest,
      plannedDecisionMoments: selected.retrospectiveReplay.decisionFrames.length,
      matchedControlCount: 0,
      globalControlMatchingState: 'DEFERRED_UNTIL_ALL_SHARD_CLASSIFICATIONS_ACKNOWLEDGED',
      resultState: 'RETROSPECTIVE_CLASSIFIED_NO_SIMULATION',
      attemptedSimulations: 0,
      completedSimulations: 0,
      validSimulationOutcomes: 0,
      authority: 'NONE',
      learningEligible: false,
      simulationCredit: 0,
    };
    const outputError = dailyShardClassificationOutputError(output, { job, shard, receipt });
    if (outputError) throw fail('SHARD_CLASSIFIER_OUTPUT_INVALID', outputError);
    return deepFreeze(output);
  };

  return deepFreeze({
    version: DAILY_SHARD_CLASSIFIER_VERSION,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    consumeShard,
    authority: 'NONE',
    learningEligible: false,
    simulationCredit: 0,
  });
}
