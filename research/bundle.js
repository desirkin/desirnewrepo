// SOCIAL-5B §11b — THE ARTIFACT BUNDLE LAW, WRITTEN ONCE AND OBEYED TWICE.
//
// A checksum proves bytes were not altered after the fact; it proves nothing about whether those bytes were ever
// lawful. Before this module the publisher verified only checksums, sizes and record counts, so a row the pipeline's
// own validator rejects — a dependency node carrying raw text, a required leaf pushed into the absence map, a
// backdated horizon floor — could still be sealed inside a perfectly checksummed artifact and refused only when
// somebody later tried to read it. That is a producer that seals what its consumer will not accept.
//
// So the SAME bundle law runs at BOTH boundaries: once on the unsealed candidate (before the manifest is written,
// while the run can still be abandoned and its files removed) and once on reopening. It is a whole-bundle law, not a
// per-file one: the member LIST is part of the contract (an omitted member is corruption, not a smaller artifact),
// declared summaries must equal the aggregates recomputed from the rows themselves, and a rendered report must be
// exactly what the deterministic renderer produces from the evaluation beside it.
//
// Nothing here re-dates a row, relaxes a bound or repairs a disagreement: a bundle that does not hold is refused.
import path from 'node:path';
import { canonicalJson } from '../rumor2/truth.js';
import { LIMITS, SNAPSHOT_VERSION, DATASET_MANIFEST_VERSION, EVALUATION_VERSION, PIPELINE_VERSION, FEATURE_RECIPE_VERSION, LABEL_RECIPE_VERSION, SPLIT_RECIPE_VERSION, SNAPSHOT_MANIFEST_KEYS, DATASET_MANIFEST_KEYS, EVALUATION_MANIFEST_KEYS, LABEL_HORIZONS_MIN, AUTHORITY, PURPOSE, fail, isTs, isPlainObject, exactKeys, isoOf } from './contracts.js';
import { readJsonFile, readJsonlStrict, readBoundedFile, verifyOutputs } from './artifacts.js';
import { validateSnapshotRecord } from './snapshot.js';
import { validateFeatureRow } from './features.js';
import { validateOutcomeRow } from './outcomes.js';
import { datasetJoinError, renderReport } from './evaluation.js';

export const SNAPSHOT_MEMBERS = Object.freeze(['snapshots.jsonl']);
export const DATASET_MEMBERS = Object.freeze(['features.jsonl', 'outcomes.jsonl', 'coverage.json']);
export const EVALUATION_MEMBERS = Object.freeze(['evaluation.json', 'report.txt']);

// THE recomputed row census — one definition used by the producer that writes coverage.json and by the reader that
// checks it, so a declared summary can never drift from the rows it claims to summarize.
export function rowCensusOf(featureRows, outcomeRows) {
  const decisionAnchor = { KNOWN: 0, NOT_YET_KNOWN: 0, OUTCOME_UNAVAILABLE: 0 };
  const rowAvailability = { AVAILABLE: 0, PARTIAL: 0, UNAVAILABLE: 0 };
  const unavailableReasons = {}; const horizons = {};
  for (const l of outcomeRows) {
    const c = (horizons[l.cohort] ??= { rows: 0, horizons: Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, { KNOWN: 0, CENSORED: 0, NOT_YET_KNOWN: 0, OUTCOME_UNAVAILABLE: 0 }])) });
    c.rows += 1; for (const h of LABEL_HORIZONS_MIN) c.horizons[`${h}m`][l.horizons[`${h}m`].state] += 1;
    decisionAnchor[l.reference.state] += 1; rowAvailability[l.availability.state] += 1;
    if (l.availability.state !== 'AVAILABLE') unavailableReasons[l.availability.reason] = (unavailableReasons[l.availability.reason] ?? 0) + 1;
  }
  return { rows: featureRows.length, labelled: outcomeRows.length, rowCoins: new Set(featureRows.map((r) => r.canonicalCoin)).size, decisionAnchor, rowAvailability, unavailableReasons, horizons };
}

// ---- snapshot ------------------------------------------------------------------------------------------------
export function snapshotBundle(dir, m, { limits = LIMITS } = {}) {
  const k = exactKeys(m, SNAPSHOT_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `snapshot manifest: ${k}`);
  if (m.version !== SNAPSHOT_VERSION) fail('UNSUPPORTED_INPUT_VERSION', `snapshot version ${String(m.version).slice(0, 60)} is not supported`);
  if (m.pipelineVersion !== PIPELINE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'snapshot pipeline version is not supported');
  if (!isPlainObject(m.prefix) || !Number.isSafeInteger(m.prefix.upperSeq) || !isPlainObject(m.prefix.digest) || !/^[0-9a-f]{64}$/.test(m.prefix.digest.sha256 ?? '')) fail('CORRUPT_INPUT', 'snapshot manifest: prefix malformed');
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'snapshot manifest: authority law');
  verifyOutputs(dir, m.outputs, { limits, expected: SNAPSHOT_MEMBERS });
  const records = []; let lastSeq = 0; let minClock = null; let maxClock = null;
  for (const rec of readJsonlStrict(path.join(dir, 'snapshots.jsonl'), { limits })) {
    const e = validateSnapshotRecord(rec); if (e) fail('CORRUPT_INPUT', e);
    if (rec.originalSeq <= lastSeq || rec.originalSeq > m.prefix.upperSeq) fail('CORRUPT_INPUT', 'snapshot records are not in original journal order within the prefix');
    lastSeq = rec.originalSeq;
    if (rec.origin !== m.origin) fail('CORRUPT_INPUT', 'snapshot record origin disagrees with the manifest');
    const clock = rec.recordKind === 'RESEARCH_DOSSIER_V2' ? rec.decisionKnownAtTs : rec.knownAtTs;
    if (isTs(clock)) { minClock = minClock === null || clock < minClock ? clock : minClock; maxClock = maxClock === null || clock > maxClock ? clock : maxClock; }
    records.push(rec);
    if (records.length > limits.maxProjectedSnapshots) fail('RESOURCE_LIMIT_EXCEEDED', 'snapshot exceeds the projected record limit');
  }
  if (records.length !== m.outputs['snapshots.jsonl']?.lines || records.length !== m.counts?.selectedRecords) fail('CORRUPT_INPUT', 'snapshot record count disagrees with the manifest');
  // the declared clock range must be the range of the records actually sealed, never a wider or narrower claim
  if (!isPlainObject(m.clockRange) || m.clockRange.minDecisionKnownAtTs !== minClock || m.clockRange.maxDecisionKnownAtTs !== maxClock) fail('CORRUPT_INPUT', `snapshot manifest clock range disagrees with the sealed records (${minClock} .. ${maxClock})`);
  return { records };
}

// ---- dataset -------------------------------------------------------------------------------------------------
export function datasetBundle(dir, m, { limits = LIMITS } = {}) {
  const k = exactKeys(m, DATASET_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `dataset manifest: ${k}`);
  if (m.version !== DATASET_MANIFEST_VERSION || m.featureRecipeVersion !== FEATURE_RECIPE_VERSION || m.labelRecipeVersion !== LABEL_RECIPE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'dataset versions are not supported');
  if (m.pipelineVersion !== PIPELINE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'dataset pipeline version is not supported');
  if (!isTs(m.asOfTs) || m.asOf !== isoOf(m.asOfTs) || m.authority !== AUTHORITY || m.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'dataset manifest: clocks / authority malformed');
  verifyOutputs(dir, m.outputs, { limits, expected: DATASET_MEMBERS });
  const featureRows = []; for (const r of readJsonlStrict(path.join(dir, 'features.jsonl'), { limits })) { const e = validateFeatureRow(r); if (e) fail('CORRUPT_INPUT', e); featureRows.push(r); if (featureRows.length > limits.maxSelectedRows) fail('RESOURCE_LIMIT_EXCEEDED', 'dataset exceeds the selected row limit'); }
  const outcomeRows = []; for (const r of readJsonlStrict(path.join(dir, 'outcomes.jsonl'), { limits })) { const e = validateOutcomeRow(r); if (e) fail('CORRUPT_INPUT', e); outcomeRows.push(r); }
  if (featureRows.length !== m.outputs['features.jsonl']?.lines || outcomeRows.length !== m.outputs['outcomes.jsonl']?.lines) fail('CORRUPT_INPUT', 'dataset row counts disagree with the manifest');
  const coverage = readJsonFile(path.join(dir, 'coverage.json'), { limits }).value;
  // A saved dataset is only meaningful under the as-of it was frozen for: the bundle proves every row still obeys
  // that clock, and that every declared summary equals what the rows themselves say. Nothing is re-dated to fit.
  const joined = datasetJoinError({ featureRows, outcomeRows, asOfTs: m.asOfTs }); if (joined.error) fail('CORRUPT_INPUT', joined.error);
  if (!isPlainObject(coverage) || coverage.asOfTs !== m.asOfTs) fail('CORRUPT_INPUT', 'dataset coverage report disagrees with the manifest as-of');
  if (coverage.authority !== AUTHORITY || coverage.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'dataset coverage report authority law');
  if (coverage.counts?.rows !== featureRows.length || coverage.counts?.labelled !== outcomeRows.length) fail('CORRUPT_INPUT', `dataset coverage counts (${coverage.counts?.rows} rows / ${coverage.counts?.labelled} labelled) disagree with the ${featureRows.length} feature and ${outcomeRows.length} outcome rows on disk`);
  if (canonicalJson(m.counts) !== canonicalJson(coverage.counts) || canonicalJson(m.coverage) !== canonicalJson(coverage.state)) fail('CORRUPT_INPUT', 'dataset manifest summary disagrees with its coverage report');
  if (canonicalJson(m.census) !== canonicalJson(coverage.census)) fail('CORRUPT_INPUT', 'dataset manifest census disagrees with its coverage report');
  // RECOMPUTED, not merely internally consistent: the anchor / availability / horizon censuses are counted again
  // from the sealed rows and must match the declaration exactly
  const c = rowCensusOf(featureRows, outcomeRows); const cen = coverage.census;
  if (!isPlainObject(cen) || !isPlainObject(cen.overlap) || cen.overlap.rowCoins !== c.rowCoins) fail('CORRUPT_INPUT', `dataset census claims ${cen?.overlap?.rowCoins} row assets but the sealed rows carry ${c.rowCoins}`);
  for (const [field, want] of [['decisionAnchor', c.decisionAnchor], ['rowAvailability', c.rowAvailability], ['unavailableReasons', c.unavailableReasons], ['horizons', c.horizons]]) {
    if (canonicalJson(cen[field]) !== canonicalJson(want)) fail('CORRUPT_INPUT', `dataset census ${field} disagrees with the outcome rows it summarizes`);
  }
  return { featureRows, outcomeRows, coverage };
}

// ---- evaluation ----------------------------------------------------------------------------------------------
export function evaluationBundle(dir, m, { limits = LIMITS } = {}) {
  const k = exactKeys(m, EVALUATION_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `evaluation manifest: ${k}`);
  if (m.version !== EVALUATION_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'evaluation version is not supported');
  if (m.pipelineVersion !== PIPELINE_VERSION || m.splitRecipeVersion !== SPLIT_RECIPE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'evaluation pipeline / split recipe is not supported');
  if (!isTs(m.asOfTs) || !isTs(m.splitAtTs) || m.splitAt !== isoOf(m.splitAtTs) || m.splitAtTs >= m.asOfTs) fail('CORRUPT_INPUT', 'evaluation manifest: clocks malformed');
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'evaluation manifest: authority law');
  verifyOutputs(dir, m.outputs, { limits, expected: EVALUATION_MEMBERS });
  const evaluation = readJsonFile(path.join(dir, 'evaluation.json'), { limits }).value;
  if (!isPlainObject(evaluation)) fail('CORRUPT_INPUT', 'evaluation.json is not an object');
  if (evaluation.version !== EVALUATION_VERSION || evaluation.splitRecipeVersion !== SPLIT_RECIPE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'evaluation.json versions are not supported');
  if (evaluation.asOfTs !== m.asOfTs || evaluation.splitAtTs !== m.splitAtTs) fail('CORRUPT_INPUT', 'evaluation.json clocks disagree with its manifest');
  if (evaluation.authority !== AUTHORITY || evaluation.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'evaluation.json authority law');
  const text = readBoundedFile(path.join(dir, 'report.txt'), { limits }).toString('utf8');
  // the human-readable report is a RENDERING of the evaluation, never an independently authored summary: it must be
  // exactly what the deterministic renderer produces from the evaluation sealed beside it
  let rendered; try { rendered = renderReport(evaluation); } catch { fail('CORRUPT_INPUT', 'evaluation.json cannot be rendered by its own report renderer'); }
  if (text !== rendered) fail('CORRUPT_INPUT', 'report.txt is not the rendering of the evaluation sealed beside it');
  return { evaluation, report: text };
}
