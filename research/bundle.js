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
import { LIMITS, SNAPSHOT_VERSION, DATASET_MANIFEST_VERSION, EVALUATION_VERSION, FEATURE_RECIPE_VERSION, LABEL_RECIPE_VERSION, SNAPSHOT_MANIFEST_KEYS, DATASET_MANIFEST_KEYS, EVALUATION_MANIFEST_KEYS, LABEL_HORIZONS_MIN, fail, isTs, exactKeys, parseUtcInstant, sha256Hex } from './contracts.js';
import { snapshotManifestError, datasetManifestError, coverageReportError, evaluationManifestError, evaluationPayloadError } from './schemas.js';
import { readJsonFile, readBoundedFile, consumeJsonl, verifyOutputs } from './artifacts.js';
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
  const primary = featureRows.filter((r) => r.cohort === 'PRIMARY'); const shadow = featureRows.filter((r) => r.cohort === 'SHADOW');
  const coinsP = new Set(primary.map((r) => r.canonicalCoin)); const coinsS = new Set(shadow.map((r) => r.canonicalCoin));
  return { rows: featureRows.length, labelled: outcomeRows.length, primaryRows: primary.length, shadowRows: shadow.length,
    episodes: new Set(primary.map((r) => r.episodeId)).size, coinsPrimary: coinsP.size, coinsShadow: coinsS.size,
    overlapCoins: [...coinsP].filter((c) => coinsS.has(c)).length,
    rowCoins: new Set(featureRows.map((r) => r.canonicalCoin)).size, decisionAnchor, rowAvailability, unavailableReasons, horizons };
}

// ---- snapshot ------------------------------------------------------------------------------------------------
export function snapshotBundle(dir, m, { limits = LIMITS, consumed = null } = {}) {
  const k = exactKeys(m, SNAPSHOT_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `snapshot manifest: ${k}`);
  if (m.version !== SNAPSHOT_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'the snapshot manifest does not declare a supported version');
  const se = snapshotManifestError(m); if (se) fail(/unsupported versions/.test(se) ? 'UNSUPPORTED_INPUT_VERSION' : 'CORRUPT_INPUT', se);
  // ONE pass over snapshots.jsonl: hashed, counted and validated from the same read
  const records = []; let lastSeq = 0; let minClock = null; let maxClock = null; let projected = 0; let shadow = 0;
  const io = consumed?.['snapshots.jsonl'] ?? consumeJsonl(path.join(dir, 'snapshots.jsonl'), { limits, onRecord: (rec) => {
    const e = validateSnapshotRecord(rec); if (e) fail('CORRUPT_INPUT', e);
    if (rec.originalSeq <= lastSeq) fail('CORRUPT_INPUT', 'snapshot records are not in original journal order');
    if (rec.originalSeq > m.prefix.upperSeq) fail('CORRUPT_INPUT', 'a snapshot record lies beyond the prefix it declares');
    lastSeq = rec.originalSeq;
    if (rec.origin !== m.origin) fail('CORRUPT_INPUT', 'snapshot record origin disagrees with the manifest');
    if (rec.recordKind === 'RESEARCH_DOSSIER_V2') projected += 1; else shadow += 1;
    const clock = rec.recordKind === 'RESEARCH_DOSSIER_V2' ? rec.decisionKnownAtTs : rec.knownAtTs;
    if (isTs(clock)) { minClock = minClock === null || clock < minClock ? clock : minClock; maxClock = maxClock === null || clock > maxClock ? clock : maxClock; }
    records.push(rec);
    if (records.length > limits.maxProjectedSnapshots) fail('RESOURCE_LIMIT_EXCEEDED', 'snapshot exceeds the projected record limit');
  } });
  verifyOutputs(dir, m.outputs, { limits, expected: SNAPSHOT_MEMBERS, consumed: { 'snapshots.jsonl': io } });
  if (records.length !== io.lines || records.length !== m.counts.selectedRecords) fail('CORRUPT_INPUT', 'snapshot record count disagrees with the manifest');
  if (projected !== m.counts.dossierV2Projected || shadow !== m.counts.shadowSamples) fail('CORRUPT_INPUT', 'the sealed records do not match the projected / shadow census the manifest declares');
  // the declared clock range must be the range of the records actually sealed, never a wider or narrower claim
  if (m.clockRange.minDecisionKnownAtTs !== minClock || m.clockRange.maxDecisionKnownAtTs !== maxClock) fail('CORRUPT_INPUT', 'the snapshot manifest clock range disagrees with the sealed records');
  return { records };
}

// ---- dataset -------------------------------------------------------------------------------------------------
// the dataset's OWN validated archive provenance, derived from metadata it already records (never a re-read)
export function archiveContextOf(m) {
  if (m.inputs.childhood === null) return { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: null };
  // the inventory comes from the census the manifest already records and datasetManifestError has already validated
  return { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: parseUtcInstant(m.inputs.childhood.archiveCreatedTs), oneMinuteSymbols: [...m.census.archive.oneMinuteSymbols] };
}
export function datasetBundle(dir, m, { limits = LIMITS, consumed = null, source = null } = {}) {
  const k = exactKeys(m, DATASET_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `dataset manifest: ${k}`);
  if (m.version !== DATASET_MANIFEST_VERSION || m.featureRecipeVersion !== FEATURE_RECIPE_VERSION || m.labelRecipeVersion !== LABEL_RECIPE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'dataset versions are not supported');
  const me = datasetManifestError(m); if (me) fail(/unsupported versions/.test(me) ? 'UNSUPPORTED_INPUT_VERSION' : 'CORRUPT_INPUT', me);
  const featureRows = []; const outcomeRows = [];
  const fio = consumed?.['features.jsonl'] ?? consumeJsonl(path.join(dir, 'features.jsonl'), { limits, onRecord: (r) => {
    const e = validateFeatureRow(r); if (e) fail('CORRUPT_INPUT', e);
    featureRows.push(r); if (featureRows.length > limits.maxSelectedRows) fail('RESOURCE_LIMIT_EXCEEDED', 'dataset exceeds the selected row limit');
  } });
  const oio = consumed?.['outcomes.jsonl'] ?? consumeJsonl(path.join(dir, 'outcomes.jsonl'), { limits, onRecord: (r) => {
    const e = validateOutcomeRow(r); if (e) fail('CORRUPT_INPUT', e);
    outcomeRows.push(r); if (outcomeRows.length > limits.maxSelectedRows) fail('RESOURCE_LIMIT_EXCEEDED', 'dataset exceeds the selected row limit');
  } });
  const cov = readJsonFile(path.join(dir, 'coverage.json'), { limits });
  verifyOutputs(dir, m.outputs, { limits, expected: DATASET_MEMBERS, consumed: { 'features.jsonl': fio, 'outcomes.jsonl': oio, 'coverage.json': { name: 'coverage.json', bytes: cov.bytes, sha256: cov.sha256 } } });
  const coverage = cov.value;
  const ce = coverageReportError(coverage, m); if (ce) fail('CORRUPT_INPUT', ce);
  // A saved dataset is only meaningful under the as-of it was frozen for AND the archive it was built from. Both
  // the row-local as-of wall and the CONTEXTUAL archive floor run here, from the provenance this manifest records.
  const archiveContext = archiveContextOf(m);
  const joined = datasetJoinError({ featureRows, outcomeRows, asOfTs: m.asOfTs, archiveContext }); if (joined.error) fail('CORRUPT_INPUT', joined.error);
  // RECOMPUTED, not merely internally consistent: every summary recoverable from the sealed rows is counted again
  const c = rowCensusOf(featureRows, outcomeRows); const cen = coverage.census;
  if (coverage.counts.rows !== c.rows || coverage.counts.labelled !== c.labelled) fail('CORRUPT_INPUT', `the dataset coverage counts (${coverage.counts.rows} rows / ${coverage.counts.labelled} labelled) disagree with the ${c.rows} feature and ${c.labelled} outcome rows on disk`);
  if (coverage.counts.primaryRows !== c.primaryRows || coverage.counts.shadowRows !== c.shadowRows) fail('CORRUPT_INPUT', 'the declared cohort populations disagree with the sealed rows');
  if (coverage.counts.coinsPrimary !== c.coinsPrimary || coverage.counts.coinsShadow !== c.coinsShadow || coverage.counts.overlapCoins !== c.overlapCoins) fail('CORRUPT_INPUT', 'the declared asset counts disagree with the sealed rows');
  if (coverage.counts.episodes !== c.episodes) fail('CORRUPT_INPUT', 'the declared episode count disagrees with the sealed rows');
  if (cen.overlap.rowCoins !== c.rowCoins) fail('CORRUPT_INPUT', `the dataset census claims ${cen.overlap.rowCoins} row assets but the sealed rows carry ${c.rowCoins}`);
  // RECOMPUTED FROM THE ROWS AND THE VALIDATED INVENTORY, never taken on the census's word
  const inventory = archiveContext.oneMinuteSymbols ?? [];
  if (cen.overlap.archiveOneMinuteSymbols !== inventory.length) fail('CORRUPT_INPUT', 'the declared archive series count disagrees with the inventory beside it');
  const rowCoins = new Set(featureRows.map((r) => r.canonicalCoin));
  const withSeries = [...rowCoins].filter((x) => inventory.includes(x)).length;
  if (cen.overlap.rowCoinsWithOneMinuteSeries !== withSeries) fail('CORRUPT_INPUT', `the census claims ${cen.overlap.rowCoinsWithOneMinuteSeries} row assets have a 1m series but the rows and the validated inventory give ${withSeries}`);
  // the cohort overlap is a CAPPED PROJECTION of the sorted intersection; its count is the FULL intersection
  const primaryCoins = new Set(featureRows.filter((r) => r.cohort === 'PRIMARY').map((r) => r.canonicalCoin));
  const shadowCoins = new Set(featureRows.filter((r) => r.cohort === 'SHADOW').map((r) => r.canonicalCoin));
  const intersection = [...primaryCoins].filter((x) => shadowCoins.has(x)).sort();
  if (canonicalJson(cen.overlap.primaryShadowOverlapCoins) !== canonicalJson(intersection.slice(0, 200))) fail('CORRUPT_INPUT', 'the declared cohort overlap list is not the sorted intersection of the sealed rows under its own projection cap');
  if (coverage.counts.overlapCoins !== intersection.length) fail('CORRUPT_INPUT', 'the declared cohort overlap count is not the full intersection of the sealed rows');
  // temporalOverlap is recomputed from ITS OWN declared inputs when they are available; null stays unknown
  const t1 = cen.archive === null ? null : cen.archive.tracks['1m'] ?? null;
  const cr = cen.snapshot.clockRange;
  const wantTemporal = t1 && t1.fromSec !== null && cr.minDecisionKnownAtTs !== null ? !(cr.maxDecisionKnownAtTs / 1000 < t1.fromSec - 60 || cr.minDecisionKnownAtTs / 1000 > t1.toSec) : null;
  if (cen.overlap.temporalOverlap !== wantTemporal) fail('CORRUPT_INPUT', 'the declared temporal overlap is not what its own recorded coverage bounds and decision range produce');
  for (const [field, want] of [['decisionAnchor', c.decisionAnchor], ['rowAvailability', c.rowAvailability], ['unavailableReasons', c.unavailableReasons], ['horizons', c.horizons]]) {
    if (canonicalJson(cen[field]) !== canonicalJson(want)) fail('CORRUPT_INPUT', `the dataset census ${field} disagrees with the outcome rows it summarizes`);
  }
  // and the manifest's own copies are the coverage report's, not a second independently authored summary
  if (canonicalJson(m.counts) !== canonicalJson(coverage.counts) || canonicalJson(m.coverage) !== canonicalJson(coverage.state)) fail('CORRUPT_INPUT', 'the dataset manifest summary disagrees with its coverage report');
  if (canonicalJson(m.census) !== canonicalJson(coverage.census)) fail('CORRUPT_INPUT', 'the dataset manifest census disagrees with its coverage report');
  // SOURCE-AWARE proof, only where the validated source is actually in scope (production build time)
  if (source?.snapshot) {
    const sm = source.snapshot.manifest;
    if (m.inputs.snapshot.manifestSha256 !== source.snapshot.manifestSha256 || m.inputs.snapshot.snapshotsSha256 !== sm.outputs['snapshots.jsonl'].sha256) fail('CORRUPT_INPUT', 'the dataset names a different snapshot than the one it was built from');
    if (canonicalJson(m.inputs.snapshot.prefixDigest) !== canonicalJson(sm.prefix.digest) || m.inputs.snapshot.upperSeq !== sm.prefix.upperSeq || m.inputs.snapshot.origin !== sm.origin) fail('CORRUPT_INPUT', 'the recorded snapshot prefix provenance disagrees with the validated snapshot');
    for (const [f, v] of [['events', sm.counts.events], ['dossierV2', sm.counts.dossierV2], ['dossierLegacy', sm.counts.dossierLegacy], ['dossierContinued', sm.counts.dossierContinued], ['shadowSamples', sm.counts.shadowSamples], ['upperSeq', sm.prefix.upperSeq]]) if (cen.snapshot[f] !== v) fail('CORRUPT_INPUT', `the dataset census ${f} disagrees with the validated source snapshot`);
    if (canonicalJson(cen.snapshot.byType) !== canonicalJson(sm.counts.byType) || canonicalJson(cen.snapshot.clockRange) !== canonicalJson(sm.clockRange)) fail('CORRUPT_INPUT', 'the dataset census source summary disagrees with the validated source snapshot');
  }
  return { featureRows, outcomeRows, coverage, archiveContext };
}

// ---- evaluation ----------------------------------------------------------------------------------------------
export function evaluationBundle(dir, m, { limits = LIMITS, consumed = null, source = null } = {}) {
  const k = exactKeys(m, EVALUATION_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `evaluation manifest: ${k}`);
  if (m.version !== EVALUATION_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'the evaluation manifest does not declare a supported version');
  const me = evaluationManifestError(m); if (me) fail(/unsupported versions/.test(me) ? 'UNSUPPORTED_INPUT_VERSION' : 'CORRUPT_INPUT', me);
  const ef = readJsonFile(path.join(dir, 'evaluation.json'), { limits });
  const rf = readBoundedFile(path.join(dir, 'report.txt'), { limits });
  const text = rf.toString('utf8');
  verifyOutputs(dir, m.outputs, { limits, expected: EVALUATION_MEMBERS, consumed: { 'evaluation.json': { name: 'evaluation.json', bytes: ef.bytes, sha256: ef.sha256 }, 'report.txt': { name: 'report.txt', bytes: rf.length, sha256: sha256Hex(rf) } } });
  const evaluation = ef.value;
  // THE PAYLOAD IS VALIDATED FIRST, COMPLETELY, AND ON ITS OWN. A report is a rendering, never a proof: it renders a
  // negative population or a false calibration exactly as faithfully as a true one.
  const pe = evaluationPayloadError(evaluation); if (pe) fail(/unsupported versions/.test(pe) ? 'UNSUPPORTED_INPUT_VERSION' : 'CORRUPT_INPUT', pe);
  if (evaluation.asOfTs !== m.asOfTs || evaluation.splitAtTs !== m.splitAtTs) fail('CORRUPT_INPUT', 'the evaluation payload clocks disagree with its manifest');
  // only then is the rendering required to be exactly what THIS payload produces
  let rendered; try { rendered = renderReport(evaluation); } catch { fail('CORRUPT_INPUT', 'the evaluation payload cannot be rendered by its own report renderer'); }
  if (text !== rendered) fail('CORRUPT_INPUT', 'report.txt is not the rendering of the evaluation sealed beside it');
  // SOURCE-AWARE proof, only where the validated dataset is actually in scope (production evaluate time). Bound to
  // the input digests, never to a caller's unchecked assurance.
  if (source?.expected) {
    if (m.inputs.dataset.manifestSha256 !== source.datasetManifestSha256 || m.inputs.dataset.featuresSha256 !== source.featuresSha256 || m.inputs.dataset.outcomesSha256 !== source.outcomesSha256) fail('CORRUPT_INPUT', 'the evaluation names a different dataset than the one it was computed from');
    if (canonicalJson(evaluation) !== canonicalJson(source.expected)) fail('CORRUPT_INPUT', 'the evaluation payload is not what the deterministic evaluator produces for its own source rows');
  }
  return { evaluation, report: text };
}
