// SOCIAL-5B — ORCHESTRATION of the three dependent offline commands (snapshot -> build -> evaluate) over the pure
// modules, the read-only journal reader and the safe artifact writer. Features and labels are different files and
// different module interfaces: rows are selected and FROZEN before the labeler opens any future window, and the
// labeler only ever sees a row's identity and decision clock. Every artifact records full input hashes, the code
// identity that produced it (a source-tree digest plus the git commit and a dirty flag when a checkout exists), the
// fixed as-of / split, recipe versions, census and exclusion counts and output checksums — never an absolute path,
// a credential, Date.now() or a random id. Importing this module has no side effects.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '../rumor2/truth.js';
import { PIPELINE_VERSION, SNAPSHOT_VERSION, FEATURE_RECIPE_VERSION, LABEL_RECIPE_VERSION, DATASET_MANIFEST_VERSION, EVALUATION_VERSION, SPLIT_RECIPE_VERSION, PREFIX_DIGEST_VERSION, JOURNAL_STREAM, LIMITS, LABEL_HORIZONS_MIN, SNAPSHOT_MANIFEST_KEYS, DATASET_MANIFEST_KEYS, EVALUATION_MANIFEST_KEYS, FEATURE_NAMES, ARRAY_CATALOGUE, AUTHORITY, PURPOSE, fail, isTs, isPlainObject, sha256Hex, exactKeys, isoOf, deepFreeze } from './contracts.js';
import { createSnapshotProjector, validateSnapshotRecord } from './snapshot.js';
import { readJournalPrefixReadOnly } from '../persistence/social-research-export.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, writeTextFile, publishManifest, readJsonFile, readJsonlStrict, verifyOutputs, fileSha256 } from './artifacts.js';
import { evaluateDataset, datasetJoinError } from './evaluation.js';
import { readChildhoodArchive } from './archive.js';
import { selectResearchRows, validateFeatureRow } from './features.js';
import { labelRow, validateOutcomeRow } from './outcomes.js';
import { RESEARCH_DOSSIER_SCHEMA_VERSION, RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION } from '../rumor2/social-research-dossier.js';
import { RESEARCH_SHADOW_POPULATION_VERSIONS, RESEARCH_SHADOW_RECIPE_VERSION } from '../rumor2/social-research-shadow.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the code closure whose bytes decide artifact provenance (sorted, repo-relative)
// (direct sources only; transitive dependencies such as the evidence contract behind the dossier validator are covered by the git commit)
// CODE IDENTITY IS THE EFFECTIVE SOURCE CLOSURE, NOT A HAND-KEPT LIST (F6). Starting from the entry points, every
// local module actually reachable from them is discovered and hashed — including modules reached transitively, such
// as the evidence contract the dossier validator executes. A hand-maintained list silently omitted those, so a change
// confined to a real validation dependency changed neither the source digest nor the path-scoped dirty check, and an
// artifact could still claim PRODUCED_BY_COMMITTED_SOURCE. This inventory is PROVENANCE ONLY: it records which bytes
// produced an artifact and grants no module any operational import or authority (the import fences decide that).
export const PIPELINE_ROOTS = Object.freeze(['bin/social-research.js', 'research/pipeline.js', 'persistence/social-research-export.js']);
const LOCAL_SPECIFIER_RE = /['"](\.{1,2}\/[^'"\n]+\.js)['"]/g;
export function pipelineSourceClosure(roots = PIPELINE_ROOTS) {
  const seen = new Set(); const stack = [...roots];
  while (stack.length) {
    const rel = stack.pop(); if (seen.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) fail('INTERNAL_FAILURE', `pipeline source ${rel} is missing`);
    seen.add(rel);
    for (const m of readFileSync(abs, 'utf8').matchAll(LOCAL_SPECIFIER_RE)) {
      const target = path.resolve(path.dirname(abs), m[1]);
      if (!target.startsWith(`${ROOT}${path.sep}`) || !existsSync(target)) continue; // never reaches outside the repo
      stack.push(path.relative(ROOT, target));
    }
  }
  return [...seen].sort();
}
// a dirty CLOSURE outranks a clean HEAD: bytes that produced the artifact decide the law, not the commit label
export const identityLaw = ({ gitCommit, gitSourceDirty }) => (gitSourceDirty === true ? 'PRODUCED_BY_UNCOMMITTED_SOURCE' : gitCommit ? 'PRODUCED_BY_COMMITTED_SOURCE' : 'NO_GIT_CHECKOUT');
export function codeIdentity() {
  const files = pipelineSourceClosure();
  const parts = files.map((f) => `${f}\n${sha256Hex(readFileSync(path.join(ROOT, f)))}\n`);
  let gitCommit = null; let gitSourceDirty = null;
  try { gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); if (!/^[0-9a-f]{40}$/.test(gitCommit)) gitCommit = null; } catch { gitCommit = null; }
  if (gitCommit) { try { gitSourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...files], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().length > 0; } catch { gitSourceDirty = null; } }
  return deepFreeze({ pipelineVersion: PIPELINE_VERSION, sourceTreeSha256: sha256Hex(parts.join('')), sourceFiles: files.length, sourceClosure: files, roots: [...PIPELINE_ROOTS], gitCommit, gitSourceDirty, law: identityLaw({ gitCommit, gitSourceDirty }), note: 'provenance inventory of the bytes that produced this artifact — never an operational import or authority allowance' });
}
const NOTE = 'disposable, reproducible research artifact — not an input to any operational decision; authority NONE, purpose RESEARCH_ONLY';

// ---- snapshot -------------------------------------------------------------------------------------------------
export async function runSnapshot({ db = null, events = null, out, stream = JOURNAL_STREAM, limits = LIMITS, probe = null } = {}) {
  if ((db === null) === (events === null)) fail('INVALID_REQUEST', 'exactly one of a connected Db (live journal) or an event list (fixture) is required');
  const origin = db ? 'LIVE_JOURNAL' : 'FIXTURE';
  const real = prepareOutputTarget(out, { forbiddenRoots: [ROOT] });
  const res = reserveOutputDir(real);
  try {
    const projector = createSnapshotProjector({ origin, limits });
    let readOnlyProof = null;
    if (db) { const r = await readJournalPrefixReadOnly({ db, stream, limits, probe, onEvent: projector.feed }); readOnlyProof = r.readOnlyProof; }
    else { if (!Array.isArray(events)) fail('INVALID_REQUEST', 'fixture events must be a list'); events.forEach((e, i) => projector.feed(i + 1, e, Buffer.byteLength(JSON.stringify(e), 'utf8'))); readOnlyProof = { firstStatement: null, transactionReadOnly: 'NOT_APPLICABLE_FIXTURE', transactionIsolation: 'NOT_APPLICABLE_FIXTURE' }; }
    const result = projector.finish();
    const w = jsonlWriter(res, 'snapshots.jsonl', { limits }); for (const rec of result.records) w.write(rec); const o = w.close();
    const manifest = { version: SNAPSHOT_VERSION, pipelineVersion: PIPELINE_VERSION, origin, stream: db ? stream : null, prefix: { upperSeq: result.upperSeq, digest: result.prefixDigest, digestRecipe: `${PREFIX_DIGEST_VERSION}: sha256 over "<seq>\\n<canonicalJson(event)>\\n" for EVERY event 1..upperSeq in sequence order (projected or not); a local provenance checksum, never an external attestation` },
      counts: { ...result.counts, retainedSets: result.retainedSets, selectedRecords: result.records.length }, clockRange: result.clockRange,
      projectionRecipe: { snapshotVersion: SNAPSHOT_VERSION, featureLeaves: FEATURE_NAMES.length, arrays: Object.keys(ARRAY_CATALOGUE), dossierVersions: { projected: [RESEARCH_DOSSIER_SCHEMA_VERSION], countedOnly: [RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION] }, shadowVersions: { population: [...RESEARCH_SHADOW_POPULATION_VERSIONS], recipe: RESEARCH_SHADOW_RECIPE_VERSION }, law: 'allowlisted structured projections only — no raw provider text, post bodies, handles, packets or free-text diagnostics; sparse original sequences are preserved and never presented as a complete replayable journal' },
      codeIdentity: codeIdentity(), limits: { ...limits }, outputs: { 'snapshots.jsonl': o }, readOnlyProof, authority: AUTHORITY, purpose: PURPOSE, note: NOTE };
    const m = publishManifest(res, 'snapshot.manifest.json', manifest, { outputs: manifest.outputs, limits });
    return { dir: real, manifest, manifestSha256: m.sha256 };
  } catch (err) { res.remove(); throw err; }
}
export function readSnapshotDir(dir, { limits = LIMITS } = {}) {
  if (typeof dir !== 'string' || !existsSync(dir) || !statSync(dir).isDirectory()) fail('INVALID_REQUEST', 'the snapshot directory does not exist');
  const mf = readJsonFile(path.join(dir, 'snapshot.manifest.json'), { limits }); const m = mf.value;
  const k = exactKeys(m, SNAPSHOT_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `snapshot manifest: ${k}`);
  if (m.version !== SNAPSHOT_VERSION) fail('UNSUPPORTED_INPUT_VERSION', `snapshot version ${String(m.version).slice(0, 60)} is not supported`);
  if (!isPlainObject(m.prefix) || !Number.isSafeInteger(m.prefix.upperSeq) || !isPlainObject(m.prefix.digest) || !/^[0-9a-f]{64}$/.test(m.prefix.digest.sha256 ?? '')) fail('CORRUPT_INPUT', 'snapshot manifest: prefix malformed');
  if (m.authority !== AUTHORITY || m.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'snapshot manifest: authority law');
  verifyOutputs(dir, m.outputs, { limits, expected: ['snapshots.jsonl'] });
  const records = []; let lastSeq = 0;
  for (const rec of readJsonlStrict(path.join(dir, 'snapshots.jsonl'), { limits })) { const e = validateSnapshotRecord(rec); if (e) fail('CORRUPT_INPUT', e); if (rec.originalSeq <= lastSeq || rec.originalSeq > m.prefix.upperSeq) fail('CORRUPT_INPUT', 'snapshot records are not in original journal order within the prefix'); lastSeq = rec.originalSeq; if (rec.origin !== m.origin) fail('CORRUPT_INPUT', 'snapshot record origin disagrees with the manifest'); records.push(rec); if (records.length > limits.maxProjectedSnapshots) fail('RESOURCE_LIMIT_EXCEEDED', 'snapshot exceeds the projected record limit'); }
  if (records.length !== m.outputs['snapshots.jsonl']?.lines || records.length !== m.counts?.selectedRecords) fail('CORRUPT_INPUT', 'snapshot record count disagrees with the manifest');
  return { manifest: m, manifestSha256: mf.sha256, records };
}

// ---- build ----------------------------------------------------------------------------------------------------
export async function runBuild({ snapshotDir, childhoodDir = null, asOfTs, out, limits = LIMITS } = {}) {
  if (!isTs(asOfTs)) fail('INVALID_REQUEST', 'a valid --as-of instant is required');
  const snap = readSnapshotDir(snapshotDir, { limits });
  const archive = childhoodDir === null ? null : readChildhoodArchive(childhoodDir, { limits });
  const real = prepareOutputTarget(out, { forbiddenRoots: [ROOT], inputPaths: [snapshotDir, childhoodDir] });
  // FEATURES FIRST, FROZEN: the selector sees no archive; the labeler sees only identities and decision clocks
  const sel = selectResearchRows(snap.records, { asOfTs, limits });
  const labels = sel.rows.map((r) => labelRow({ rowId: r.rowId, cohort: r.cohort, canonicalCoin: r.canonicalCoin, decisionKnownAtTs: r.decisionKnownAtTs }, { archive, asOfTs, limits }));
  const coverage = buildCoverage({ snap, archive, sel, labels, asOfTs, childhoodSupplied: childhoodDir !== null });
  const res = reserveOutputDir(real);
  try {
    const fw = jsonlWriter(res, 'features.jsonl', { limits }); for (const r of sel.rows) fw.write(r); const fo = fw.close();
    const ow = jsonlWriter(res, 'outcomes.jsonl', { limits }); for (const l of labels) ow.write(l); const oo = ow.close();
    const co = writeJsonFile(res, 'coverage.json', coverage);
    const manifest = { version: DATASET_MANIFEST_VERSION, pipelineVersion: PIPELINE_VERSION, featureRecipeVersion: FEATURE_RECIPE_VERSION, labelRecipeVersion: LABEL_RECIPE_VERSION, asOfTs, asOf: isoOf(asOfTs),
      inputs: { snapshot: { manifestSha256: snap.manifestSha256, snapshotsSha256: snap.manifest.outputs['snapshots.jsonl'].sha256, origin: snap.manifest.origin, upperSeq: snap.manifest.prefix.upperSeq, prefixDigest: snap.manifest.prefix.digest }, childhood: archive ? { manifestSha256: archive.census.identity.manifestSha256, archiveCreatedTs: archive.census.identity.archiveCreatedTs, consumedFiles: archive.consumedFiles } : null },
      census: coverage.census, counts: coverage.counts, coverage: coverage.state, codeIdentity: codeIdentity(), limits: { ...limits }, outputs: { 'features.jsonl': fo, 'outcomes.jsonl': oo, 'coverage.json': co }, authority: AUTHORITY, purpose: PURPOSE, note: NOTE };
    const m = publishManifest(res, 'dataset.manifest.json', manifest, { outputs: manifest.outputs, limits });
    return { dir: real, manifest, manifestSha256: m.sha256, coverage };
  } catch (err) { res.remove(); throw err; }
}
function buildCoverage({ snap, archive, sel, labels, asOfTs, childhoodSupplied }) {
  const perCohort = {}; const reference = { KNOWN: 0, NOT_YET_KNOWN: 0, OUTCOME_UNAVAILABLE: 0 }; const rowAvailability = { AVAILABLE: 0, PARTIAL: 0, UNAVAILABLE: 0 }; const unavailableReasons = {};
  for (const l of labels) {
    const c = (perCohort[l.cohort] ??= { rows: 0, horizons: Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, { KNOWN: 0, CENSORED: 0, NOT_YET_KNOWN: 0, OUTCOME_UNAVAILABLE: 0 }])) });
    c.rows += 1; for (const h of LABEL_HORIZONS_MIN) c.horizons[`${h}m`][l.horizons[`${h}m`].state] += 1;
    reference[l.reference.state] += 1; rowAvailability[l.availability.state] += 1; if (l.availability.state !== 'AVAILABLE') unavailableReasons[l.availability.reason] = (unavailableReasons[l.availability.reason] ?? 0) + 1;
  }
  const coins = new Set(sel.rows.map((r) => r.canonicalCoin)); const archiveCoins = archive ? new Set(archive.census.oneMinuteSymbols) : new Set();
  const withSeries = [...coins].filter((c) => archiveCoins.has(c)).length;
  const t1 = archive?.census.tracks['1m'] ?? null; const cr = snap.manifest.clockRange;
  const temporalOverlap = t1 && t1.fromSec !== null && cr.minDecisionKnownAtTs !== null ? !(cr.maxDecisionKnownAtTs / 1000 < t1.fromSec - 60 || cr.minDecisionKnownAtTs / 1000 > t1.toSec) : null;
  const reasons = new Set(['DECISION_ANCHOR_DELAYED_TO_NEXT_MINUTE', 'SOURCE_PROFILE_CONTEXT_NOT_RECORDED_IN_DOSSIER', 'CLAIM_ASSOCIATION_NOT_AVAILABLE']);
  if (sel.counts.dossierRecords === 0 && sel.counts.shadowSamples === 0) reasons.add('NO_RESEARCH_HISTORY');
  if (sel.rows.length === 0 && (sel.counts.dossierRecords > 0 || sel.counts.shadowSamples > 0)) reasons.add('NO_SELECTED_ROWS_AT_AS_OF');
  if (!childhoodSupplied) reasons.add('CHILDHOOD_ARCHIVE_NOT_SUPPLIED');
  if (archive) { for (const l of archive.limitations) if (['SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET', 'FAST_MEMORY_PARITY_LIMITED', 'NO_1M_TRACK'].includes(l)) reasons.add(l); if (temporalOverlap === false) reasons.add('NO_TEMPORAL_OVERLAP'); if (coins.size > 0 && withSeries < coins.size) reasons.add('PARTIAL_ASSET_OVERLAP'); }
  if (sel.rows.some((r) => r.cohort === 'PRIMARY' && (r.features['dependencies.truncated'] === true))) reasons.add('DEPENDENCY_MANIFEST_TRUNCATED');
  if (rowAvailability.PARTIAL > 0) reasons.add('PARTIAL_HORIZON_COVERAGE');
  const state = sel.rows.length === 0 || !archive || (rowAvailability.AVAILABLE === 0 && rowAvailability.PARTIAL === 0) ? 'UNAVAILABLE' : rowAvailability.UNAVAILABLE === 0 && rowAvailability.PARTIAL === 0 ? 'AVAILABLE' : 'PARTIAL';
  return deepFreeze({
    version: DATASET_MANIFEST_VERSION, asOfTs, state: { state, reasons: [...reasons].sort() },
    counts: { ...sel.counts, rows: sel.rows.length, labelled: labels.length, reconciliation: { dossierRecords: sel.counts.dossierRecords, primaryRows: sel.counts.primaryRows, continued: sel.counts.dossierContinued, afterAsOf: sel.counts.dossierAfterAsOf, sum: sel.counts.primaryRows + sel.counts.dossierContinued + sel.counts.dossierAfterAsOf, legacyDossiersInPrefix: snap.manifest.counts.dossierLegacy ?? 0 } },
    census: { snapshot: { origin: snap.manifest.origin, upperSeq: snap.manifest.prefix.upperSeq, events: snap.manifest.counts.events, byType: snap.manifest.counts.byType, dossierV2: snap.manifest.counts.dossierV2, dossierLegacy: snap.manifest.counts.dossierLegacy, dossierContinued: snap.manifest.counts.dossierContinued, shadowSamples: snap.manifest.counts.shadowSamples, clockRange: cr, decisionDates: cr.minDecisionKnownAtTs === null ? null : { from: isoOf(cr.minDecisionKnownAtTs).slice(0, 10), to: isoOf(cr.maxDecisionKnownAtTs).slice(0, 10) } }, archive: archive ? archive.census : null, overlap: { rowCoins: coins.size, rowCoinsWithOneMinuteSeries: withSeries, archiveOneMinuteSymbols: archiveCoins.size, primaryShadowOverlapCoins: sel.overlapCoins, temporalOverlap }, decisionAnchor: reference, rowAvailability, unavailableReasons, horizons: perCohort },
    limitations: [...new Set([...(archive ? archive.limitations : []), 'DECISION_ANCHOR_IS_LABEL_SIDE_ONLY', 'SOURCE_PROFILE_CONTEXT_NOT_RECORDED_IN_DOSSIER', 'CLAIM_ASSOCIATION_NOT_AVAILABLE', 'SHADOW_ROWS_ARE_NOT_A_MARKET_DENOMINATOR'])].sort(),
    authority: AUTHORITY, purpose: PURPOSE,
  });
}
export function readDatasetDir(dir, { limits = LIMITS } = {}) {
  if (typeof dir !== 'string' || !existsSync(dir) || !statSync(dir).isDirectory()) fail('INVALID_REQUEST', 'the dataset directory does not exist');
  const mf = readJsonFile(path.join(dir, 'dataset.manifest.json'), { limits }); const m = mf.value;
  const k = exactKeys(m, DATASET_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `dataset manifest: ${k}`);
  if (m.version !== DATASET_MANIFEST_VERSION || m.featureRecipeVersion !== FEATURE_RECIPE_VERSION || m.labelRecipeVersion !== LABEL_RECIPE_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'dataset versions are not supported');
  if (!isTs(m.asOfTs) || m.asOf !== isoOf(m.asOfTs) || m.authority !== AUTHORITY || m.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'dataset manifest: clocks / authority malformed');
  verifyOutputs(dir, m.outputs, { limits, expected: ['features.jsonl', 'outcomes.jsonl', 'coverage.json'] });
  const featureRows = []; for (const r of readJsonlStrict(path.join(dir, 'features.jsonl'), { limits })) { const e = validateFeatureRow(r); if (e) fail('CORRUPT_INPUT', e); featureRows.push(r); if (featureRows.length > limits.maxSelectedRows) fail('RESOURCE_LIMIT_EXCEEDED', 'dataset exceeds the selected row limit'); }
  const outcomeRows = []; for (const r of readJsonlStrict(path.join(dir, 'outcomes.jsonl'), { limits })) { const e = validateOutcomeRow(r); if (e) fail('CORRUPT_INPUT', e); outcomeRows.push(r); }
  if (featureRows.length !== m.outputs['features.jsonl']?.lines || outcomeRows.length !== m.outputs['outcomes.jsonl']?.lines) fail('CORRUPT_INPUT', 'dataset row counts disagree with the manifest');
  const coverage = readJsonFile(path.join(dir, 'coverage.json'), { limits }).value;
  // A saved dataset is only meaningful under the as-of it was frozen for: reopening proves every row still obeys that
  // clock, and that the manifest's own summary agrees with the rows on disk. Nothing is re-dated to make it fit.
  const joined = datasetJoinError({ featureRows, outcomeRows, asOfTs: m.asOfTs }); if (joined.error) fail('CORRUPT_INPUT', joined.error);
  if (!isPlainObject(coverage) || coverage.asOfTs !== m.asOfTs) fail('CORRUPT_INPUT', 'dataset coverage report disagrees with the manifest as-of');
  if (coverage.authority !== AUTHORITY || coverage.purpose !== PURPOSE) fail('CORRUPT_INPUT', 'dataset coverage report authority law');
  if (coverage.counts?.rows !== featureRows.length || coverage.counts?.labelled !== outcomeRows.length) fail('CORRUPT_INPUT', `dataset coverage counts (${coverage.counts?.rows} rows / ${coverage.counts?.labelled} labelled) disagree with the ${featureRows.length} feature and ${outcomeRows.length} outcome rows on disk`);
  if (canonicalJson(m.counts) !== canonicalJson(coverage.counts) || canonicalJson(m.coverage) !== canonicalJson(coverage.state)) fail('CORRUPT_INPUT', 'dataset manifest summary disagrees with its coverage report');
  return { manifest: m, manifestSha256: mf.sha256, featureRows, outcomeRows, coverage };
}

// ---- evaluate -------------------------------------------------------------------------------------------------
export async function runEvaluate({ datasetDir, splitAtTs, out, limits = LIMITS } = {}) {
  if (!isTs(splitAtTs)) fail('INVALID_REQUEST', 'a valid --split-at instant is required');
  const ds = readDatasetDir(datasetDir, { limits });
  const asOfTs = ds.manifest.asOfTs; // the frozen dataset as-of is inherited, never re-chosen
  if (splitAtTs >= asOfTs) fail('INVALID_REQUEST', 'split-at must be earlier than the dataset as-of');
  const real = prepareOutputTarget(out, { forbiddenRoots: [ROOT], inputPaths: [datasetDir] });
  const { evaluation, report } = evaluateDataset({ featureRows: ds.featureRows, outcomeRows: ds.outcomeRows, asOfTs, splitAtTs, coverageState: ds.coverage?.state ?? null, limits });
  const res = reserveOutputDir(real);
  try {
    const eo = writeJsonFile(res, 'evaluation.json', evaluation);
    const ro = writeTextFile(res, 'report.txt', report);
    const manifest = { version: EVALUATION_VERSION, pipelineVersion: PIPELINE_VERSION, splitRecipeVersion: SPLIT_RECIPE_VERSION, datasetManifestDigest: ds.manifestSha256, asOfTs, splitAtTs, splitAt: isoOf(splitAtTs), inputs: { dataset: { manifestSha256: ds.manifestSha256, featuresSha256: ds.manifest.outputs['features.jsonl'].sha256, outcomesSha256: ds.manifest.outputs['outcomes.jsonl'].sha256, asOf: ds.manifest.asOf } }, codeIdentity: codeIdentity(), limits: { ...limits }, outputs: { 'evaluation.json': eo, 'report.txt': ro }, authority: AUTHORITY, purpose: PURPOSE, note: NOTE };
    const m = publishManifest(res, 'evaluation.manifest.json', manifest, { outputs: manifest.outputs, limits });
    return { dir: real, manifest, manifestSha256: m.sha256, evaluation, report };
  } catch (err) { res.remove(); throw err; }
}
export function readEvaluationDir(dir, { limits = LIMITS } = {}) {
  const mf = readJsonFile(path.join(dir, 'evaluation.manifest.json'), { limits }); const m = mf.value;
  const k = exactKeys(m, EVALUATION_MANIFEST_KEYS); if (k) fail('CORRUPT_INPUT', `evaluation manifest: ${k}`);
  if (m.version !== EVALUATION_VERSION) fail('UNSUPPORTED_INPUT_VERSION', 'evaluation version is not supported');
  verifyOutputs(dir, m.outputs, { limits, expected: ['evaluation.json', 'report.txt'] });
  return { manifest: m, evaluation: readJsonFile(path.join(dir, 'evaluation.json'), { limits }).value, report: readFileSync(path.join(dir, 'report.txt'), 'utf8') };
}
export const datasetDigestOf = (dir) => fileSha256(path.join(dir, 'dataset.manifest.json'));
export { canonicalJson };
