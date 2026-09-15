// Test-only fixture construction. No pipeline/database import and no provider access.
// These assemble synthetic artifacts with the delivered pure projector/selector/
// labeler/evaluator and the actual writer/bundle interfaces. They are not a CLI substitute.
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const repo = path.resolve(process.env.SERPENT_REPO_DIR || process.cwd());
const mod = p => import(pathToFileURL(path.join(repo, p)).href);
export const [C, IO, B, ID, FE, OUT, EV, AR, SNAP, FX, SH] = await Promise.all([
  mod('research/contracts.js'), mod('research/artifacts.js'), mod('research/bundle.js'),
  mod('research/identity.js'), mod('research/features.js'), mod('research/outcomes.js'),
  mod('research/evaluation.js'), mod('research/archive.js'), mod('research/snapshot.js'),
  mod('test/helpers/social-5b.js'), mod('rumor2/social-research-shadow.js'),
]);
const dossier = await mod('rumor2/social-research-dossier.js');
export const ASOF = FX.T0 + 86_400_000;
export const SPLIT = FX.T0 + 18_000_000;
export const CREATED = FX.T0 + 21_600_000;
export const clone = structuredClone;
const roots = [];
export const work = () => { const d = mkdtempSync(path.join(tmpdir(), 'serpent-acceptance-')); roots.push(d); return d; };
export const cleanup = () => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); };
export const json = file => JSON.parse(readFileSync(file, 'utf8'));
const NOTE = 'disposable, reproducible research artifact \u2014 not an input to any operational decision; authority NONE, purpose RESEARCH_ONLY';
const common = () => ({ codeIdentity: ID.codeIdentity(), limits: { ...C.LIMITS }, authority: C.AUTHORITY, purpose: C.PURPOSE, note: NOTE });

function snapshotFixture(root, events) {
  const p = SNAP.createSnapshotProjector({ origin: 'FIXTURE' });
  events.forEach((e, i) => p.feed(i + 1, e, Buffer.byteLength(JSON.stringify(e))));
  const r = p.finish();
  const reservation = IO.reserveOutputDir(path.join(root, 'snapshot'));
  const w = IO.jsonlWriter(reservation, 'snapshots.jsonl');
  r.records.forEach(rec => w.write(rec));
  const m = {
    version: C.SNAPSHOT_VERSION, pipelineVersion: C.PIPELINE_VERSION, origin: 'FIXTURE', stream: null,
    prefix: { upperSeq: r.upperSeq, digest: r.prefixDigest, digestRecipe: `${C.PREFIX_DIGEST_VERSION}: sha256 over "<seq>\\n<canonicalJson(event)>\\n" for EVERY event 1..upperSeq in sequence order (projected or not); a local provenance checksum, never an external attestation` },
    counts: { ...r.counts, retainedSets: r.retainedSets, selectedRecords: r.records.length }, clockRange: r.clockRange,
    projectionRecipe: {
      snapshotVersion: C.SNAPSHOT_VERSION, featureLeaves: C.FEATURE_NAMES.length, arrays: Object.keys(C.ARRAY_CATALOGUE),
      dossierVersions: { projected: [dossier.RESEARCH_DOSSIER_SCHEMA_VERSION], countedOnly: [dossier.RESEARCH_DOSSIER_LEGACY_SCHEMA_VERSION] },
      shadowVersions: { population: [...SH.RESEARCH_SHADOW_POPULATION_VERSIONS], recipe: SH.RESEARCH_SHADOW_RECIPE_VERSION },
      law: 'allowlisted structured projections only \u2014 no raw provider text, post bodies, handles, packets or free-text diagnostics; sparse original sequences are preserved and never presented as a complete replayable journal',
    },
    ...common(), outputs: { 'snapshots.jsonl': w.close() },
    readOnlyProof: { firstStatement: null, transactionReadOnly: 'NOT_APPLICABLE_FIXTURE', transactionIsolation: 'NOT_APPLICABLE_FIXTURE' },
  };
  const proof = IO.publishManifest(reservation, 'snapshot.manifest.json', m, { bundle: (d, cand) => B.snapshotBundle(d, cand) });
  return { dir: reservation.dir, manifest: m, manifestSha256: proof.sha256, ...B.snapshotBundle(reservation.dir, m) };
}

// Reproduce the existing generator's lawful metadata. Negative expectations below
// come from independently stated laws, not from agreement between this builder and a validator.
function coverageFixture(snap, archive, sel, labels) {
  const c = B.rowCensusOf(sel.rows, labels);
  const coins = new Set(sel.rows.map(r => r.canonicalCoin));
  const archiveCoins = new Set(archive.census.oneMinuteSymbols);
  const withSeries = [...coins].filter(c => archiveCoins.has(c)).length;
  const t1 = archive.census.tracks['1m']; const cr = snap.manifest.clockRange;
  const temporalOverlap = t1 && t1.fromSec !== null && cr.minDecisionKnownAtTs !== null ? !(cr.maxDecisionKnownAtTs / 1000 < t1.fromSec - 60 || cr.minDecisionKnownAtTs / 1000 > t1.toSec) : null;
  const reasons = new Set(['DECISION_ANCHOR_DELAYED_TO_NEXT_MINUTE', 'SOURCE_PROFILE_CONTEXT_NOT_RECORDED_IN_DOSSIER', 'CLAIM_ASSOCIATION_NOT_AVAILABLE']);
  if (sel.counts.dossierRecords === 0 && sel.counts.shadowSamples === 0) reasons.add('NO_RESEARCH_HISTORY');
  if (sel.rows.length === 0 && (sel.counts.dossierRecords > 0 || sel.counts.shadowSamples > 0)) reasons.add('NO_SELECTED_ROWS_AT_AS_OF');
  for (const l of archive.limitations) if (['SURVIVORSHIP_LIMITED_CURRENT_PAIR_SET', 'FAST_MEMORY_PARITY_LIMITED', 'NO_1M_TRACK'].includes(l)) reasons.add(l);
  if (temporalOverlap === false) reasons.add('NO_TEMPORAL_OVERLAP');
  if (coins.size > 0 && withSeries < coins.size) reasons.add('PARTIAL_ASSET_OVERLAP');
  if (sel.rows.some(r => r.cohort === 'PRIMARY' && r.features['dependencies.truncated'] === true)) reasons.add('DEPENDENCY_MANIFEST_TRUNCATED');
  if (c.rowAvailability.PARTIAL > 0) reasons.add('PARTIAL_HORIZON_COVERAGE');
  const state = sel.rows.length === 0 || (c.rowAvailability.AVAILABLE === 0 && c.rowAvailability.PARTIAL === 0) ? 'UNAVAILABLE' : c.rowAvailability.UNAVAILABLE === 0 && c.rowAvailability.PARTIAL === 0 ? 'AVAILABLE' : 'PARTIAL';
  return {
    version: C.DATASET_MANIFEST_VERSION, asOfTs: ASOF, state: { state, reasons: [...reasons].sort() },
    counts: { ...sel.counts, rows: sel.rows.length, labelled: labels.length, reconciliation: { dossierRecords: sel.counts.dossierRecords, primaryRows: sel.counts.primaryRows, continued: sel.counts.dossierContinued, afterAsOf: sel.counts.dossierAfterAsOf, sum: sel.counts.primaryRows + sel.counts.dossierContinued + sel.counts.dossierAfterAsOf, legacyDossiersInPrefix: snap.manifest.counts.dossierLegacy ?? 0 } },
    census: {
      snapshot: { origin: snap.manifest.origin, upperSeq: snap.manifest.prefix.upperSeq, events: snap.manifest.counts.events, byType: snap.manifest.counts.byType, dossierV2: snap.manifest.counts.dossierV2, dossierLegacy: snap.manifest.counts.dossierLegacy, dossierContinued: snap.manifest.counts.dossierContinued, shadowSamples: snap.manifest.counts.shadowSamples, clockRange: cr, decisionDates: cr.minDecisionKnownAtTs === null ? null : { from: C.isoOf(cr.minDecisionKnownAtTs).slice(0, 10), to: C.isoOf(cr.maxDecisionKnownAtTs).slice(0, 10) } },
      archive: archive.census,
      overlap: { rowCoins: coins.size, rowCoinsWithOneMinuteSeries: withSeries, archiveOneMinuteSymbols: archiveCoins.size, primaryShadowOverlapCoins: sel.overlapCoins, temporalOverlap },
      decisionAnchor: c.decisionAnchor, rowAvailability: c.rowAvailability, unavailableReasons: c.unavailableReasons, horizons: c.horizons,
    },
    limitations: [...new Set([...archive.limitations, 'DECISION_ANCHOR_IS_LABEL_SIDE_ONLY', 'SOURCE_PROFILE_CONTEXT_NOT_RECORDED_IN_DOSSIER', 'CLAIM_ASSOCIATION_NOT_AVAILABLE', 'SHADOW_ROWS_ARE_NOT_A_MARKET_DENOMINATOR'])].sort(),
    authority: C.AUTHORITY, purpose: C.PURPOSE,
  };
}

let basePromise;
export function baseFixture() {
  return basePromise ??= (async () => {
    const root = work(); const fx = await FX.journalFixture({ coins: ['ZQQ7'], shadow: false });
    const snap = snapshotFixture(root, fx.events);
    const archiveDir = path.join(root, 'archive');
    FX.writeChildhoodArchive(archiveDir, { series: [{ symbol: 'ZQQ7', candles: FX.linearBars({ fromSec: FX.T0 / 1000 - 600, toSec: FX.T0 / 1000 + 18_000 }) }], archiveCreatedTs: C.isoOf(CREATED), retrievedSec: SPLIT / 1000 });
    const archive = AR.readChildhoodArchive(archiveDir);
    const sel = FE.selectResearchRows(snap.records, { asOfTs: ASOF });
    const outcomes = sel.rows.map(r => OUT.labelRow(r, { archive, asOfTs: ASOF }));
    const coverage = coverageFixture(snap, archive, sel, outcomes);
    const m = {
      version: C.DATASET_MANIFEST_VERSION, pipelineVersion: C.PIPELINE_VERSION, featureRecipeVersion: C.FEATURE_RECIPE_VERSION, labelRecipeVersion: C.LABEL_RECIPE_VERSION, asOfTs: ASOF, asOf: C.isoOf(ASOF),
      inputs: { snapshot: { manifestSha256: snap.manifestSha256, snapshotsSha256: snap.manifest.outputs['snapshots.jsonl'].sha256, origin: snap.manifest.origin, upperSeq: snap.manifest.prefix.upperSeq, prefixDigest: snap.manifest.prefix.digest }, childhood: { manifestSha256: archive.census.identity.manifestSha256, archiveCreatedTs: archive.census.identity.archiveCreatedTs, consumedFiles: archive.consumedFiles } },
      census: coverage.census, counts: coverage.counts, coverage: coverage.state, ...common(), outputs: {},
    };
    const base = { snap, features: sel.rows, outcomes, coverage, m };
    const ds = datasetCandidate(base);
    assert.equal(ds.error, null, `positive dataset publication: ${ds.error?.message}`);
    const reopened = B.datasetBundle(ds.dir, ds.m);
    const expected = EV.evaluateDataset({ featureRows: reopened.featureRows, outcomeRows: reopened.outcomeRows, archiveContext: reopened.archiveContext, coverageState: reopened.coverage.state, asOfTs: ASOF, splitAtTs: SPLIT }).evaluation;
    const manifestDigest = C.sha256Hex(readFileSync(path.join(ds.dir, 'dataset.manifest.json')));
    base.evaluation = expected;
    base.em = { version: C.EVALUATION_VERSION, pipelineVersion: C.PIPELINE_VERSION, splitRecipeVersion: C.SPLIT_RECIPE_VERSION, datasetManifestDigest: manifestDigest, asOfTs: ASOF, splitAtTs: SPLIT, splitAt: C.isoOf(SPLIT), inputs: { dataset: { manifestSha256: manifestDigest, featuresSha256: ds.m.outputs['features.jsonl'].sha256, outcomesSha256: ds.m.outputs['outcomes.jsonl'].sha256, asOf: ds.m.asOf } }, ...common(), outputs: {} };
    const ev = evaluationCandidate(base);
    assert.equal(ev.error, null, `positive evaluation publication: ${ev.error?.message}`);
    B.evaluationBundle(ev.dir, ev.m);
    return base;
  })();
}

function finishCandidate(res, name, m, bundle, mode) {
  if (mode === 'saved') {
    // TEST FIXTURE ONLY: fabricate a corrupted saved artifact with honest file hashes.
    // Never use/relax the production completion publisher to construct invalid saved data.
    writeFileSync(path.join(res.dir, name), JSON.stringify(m, null, 1) + '\n');
    return { dir: res.dir, m, error: null, sealed: true };
  }
  let error = null;
  try { IO.publishManifest(res, name, m, { bundle }); } catch (e) { error = e; }
  return { dir: res.dir, m, error, sealed: existsSync(path.join(res.dir, name)) };
}

export function datasetCandidate(base, mutate = () => {}, mode = 'publish') {
  const res = IO.reserveOutputDir(path.join(work(), 'candidate'));
  const m = clone(base.m), coverage = clone(base.coverage), features = clone(base.features), outcomes = clone(base.outcomes);
  mutate({ m, coverage, features, outcomes });
  m.census = clone(coverage.census); m.counts = clone(coverage.counts); m.coverage = clone(coverage.state);
  try {
    const fw = IO.jsonlWriter(res, 'features.jsonl'); features.forEach(r => fw.write(r)); const fo = fw.close();
    const ow = IO.jsonlWriter(res, 'outcomes.jsonl'); outcomes.forEach(r => ow.write(r)); const oo = ow.close();
    m.outputs = { 'features.jsonl': fo, 'outcomes.jsonl': oo, 'coverage.json': IO.writeJsonFile(res, 'coverage.json', coverage) };
    return finishCandidate(res, 'dataset.manifest.json', m, (d, cand) => B.datasetBundle(d, cand, { source: { snapshot: base.snap } }), mode);
  } catch (error) { return { dir: res.dir, m, error, sealed: existsSync(path.join(res.dir, 'dataset.manifest.json')) }; }
}

export function evaluationCandidate(base, mutate = () => {}, mode = 'publish') {
  const res = IO.reserveOutputDir(path.join(work(), 'candidate'));
  const m = clone(base.em), e = clone(base.evaluation); mutate(e, m);
  m.outputs = { 'evaluation.json': IO.writeJsonFile(res, 'evaluation.json', e), 'report.txt': IO.writeTextFile(res, 'report.txt', EV.renderReport(e)) };
  return finishCandidate(res, 'evaluation.manifest.json', m, (d, cand) => B.evaluationBundle(d, cand), mode);
}

export async function dottedShadowFixture() {
  const fx = await FX.journalFixture({ coins: ['ZQQ7'], shadow: false });
  const pop = {
    version: 'wideeye-sweep-population-1', sweepId: `ws-${'b'.repeat(40)}`, tsMs: FX.T0 + 4000, sessionDate: C.isoOf(FX.T0).slice(0, 10), catalogContentId: null,
    scanned: 4, tickerRows: 4, excluded: { NO_TICKER_ROW: 0, PRICE_INVALID: 0, INSUFFICIENT_SERIES: 1 },
    rows: [{ coin: 'A.B', evaluated: true, noticeEmitted: false, zVol: 1.1, zRet: 0.2, extension: 0.5, usdVol24h: 1000 }, { coin: 'ZQQ7', evaluated: true, noticeEmitted: true }, { coin: 'CCC3', evaluated: true, noticeEmitted: false, cooldownSuppressed: true, preCooldownVerdict: 'RIPPLE', zVol: 4, zRet: 1, extension: 2, usdVol24h: 5000, inDeepTape: true }],
  };
  const s = SH.buildShadowSample(pop, { knownAtTs: FX.T0 + 4500 }); assert.equal(s.ok, true);
  const snap = snapshotFixture(work(), [...fx.events, s.event]);
  const rows = FE.selectResearchRows(snap.records, { asOfTs: ASOF }).rows;
  const shadow = rows.find(r => r.cohort === 'SHADOW' && r.canonicalCoin === 'A.B');
  assert.ok(shadow, 'fixture must generate an actual A.B SHADOW');
  assert.equal(FE.validateFeatureRow(shadow), null);
  return shadow;
}
