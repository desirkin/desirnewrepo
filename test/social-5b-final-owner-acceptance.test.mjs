// Independent acceptance assertions for the existing ticket's additional obligations.
// Run from the target repository root:
// node --test --test-concurrency=1 /absolute/path/to/this-file.mjs
// The target repository already contains the original, byte-identical owner helpers.
// No production edit, database import, provider request or installation is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.env.SERPENT_REPO_DIR || process.cwd());
const S = await import(pathToFileURL(path.join(root, 'test/helpers/social-5b-owner-support.mjs')).href);
const SC = await import(pathToFileURL(path.join(root, 'research/schemas.js')).href);
let base, validationBase, shadow;
test.before(async () => {
  base = await S.baseFixture();
  shadow = await S.dottedShadowFixture();
  const splitAtTs = S.FX.T0 - 8 * 86_400_000;
  const evaluation = S.EV.evaluateDataset({
    featureRows: base.features, outcomeRows: base.outcomes,
    asOfTs: S.ASOF, splitAtTs, archiveContext: S.B.archiveContextOf(base.m), coverageState: base.coverage.state,
  }).evaluation;
  assert.equal(SC.evaluationPayloadError(evaluation), null);
  assert.equal(evaluation.tables.primaryBySplit.VALIDATION['1m'].counts.KNOWN, 1);
  assert.equal(evaluation.learnability.horizons['1m'].validationKnownAtAsOf, 1);
  validationBase = { ...base, evaluation, em: S.clone(base.em) };
  validationBase.em.splitAtTs = splitAtTs; validationBase.em.splitAt = S.C.isoOf(splitAtTs);
});
test.after(S.cleanup);
const caught = fn => { try { fn(); return null; } catch (e) { return e; } };
const corrupt = e => e instanceof S.C.ResearchError && e.code === 'CORRUPT_INPUT';
function evaluationSource() {
  const d = validationBase.em.inputs.dataset;
  return { expected: validationBase.evaluation, datasetManifestSha256: d.manifestSha256,
    featuresSha256: d.featuresSha256, outcomesSha256: d.outcomesSha256 };
}

test('CONTROL: lawful validation cohort, metadata and SHADOW round trips remain accepted', () => {
  const d = S.datasetCandidate(base); assert.equal(d.error, null); S.B.datasetBundle(d.dir, d.m);
  const e = S.evaluationCandidate(validationBase); assert.equal(e.error, null); S.B.evaluationBundle(e.dir, e.m);
  S.B.evaluationBundle(e.dir, e.m, { source: evaluationSource() });
  assert.equal(S.FE.validateFeatureRow(shadow), null);
  assert.equal(S.OUT.archiveContextError(S.B.archiveContextOf(base.m)), null);
});

for (const [name, mutate] of [
  ['N1 validation known-count equality also rejects an UNDERCOUNT', e => { e.learnability.horizons['1m'].validationKnownAtAsOf = 0; }],
  ['N2 research-state breakdown rejects an invented state', e => { e.byResearchState = { MADE_UP_STATE: e.rows.primary }; }],
  ['N3 provider-context breakdown rejects arbitrary text outside its provider/state grammar', e => { e.byProviderContext = { AUDIT_RAW_CONTENT_SENTINEL_497: e.rows.primary }; }],
]) {
  test(name, () => {
    // Both paths execute before assertions. The invalid completed artifact is
    // written by TEST-ONLY resealing with real checksums and a regenerated report.
    const pub = S.evaluationCandidate(validationBase, mutate);
    const saved = S.evaluationCandidate(validationBase, mutate, 'saved');
    const readError = caught(() => S.B.evaluationBundle(saved.dir, saved.m));
    const sourceError = caught(() => S.B.evaluationBundle(saved.dir, saved.m, { source: evaluationSource() }));
    assert.deepEqual({ preSealCorruption: corrupt(pub.error), sealExists: pub.sealed, readCorruption: corrupt(readError), sourceAwareCorruption: corrupt(sourceError) },
      { preSealCorruption: true, sealExists: false, readCorruption: true, sourceAwareCorruption: true });
  });
}

test('N4 archive consumed-file inventory must include the manifest it declares as its source', () => {
  const mutate = ({ m, coverage }) => {
    delete m.inputs.childhood.consumedFiles['manifest.json'];
    delete coverage.census.archive.consumedFiles['manifest.json'];
  };
  const pub = S.datasetCandidate(base, mutate);
  const saved = S.datasetCandidate(base, mutate, 'saved');
  const readError = caught(() => S.B.datasetBundle(saved.dir, saved.m));
  assert.deepEqual({ preSealCorruption: corrupt(pub.error), sealExists: pub.sealed, readCorruption: corrupt(readError) },
    { preSealCorruption: true, sealExists: false, readCorruption: true });
});

test('N5 supplied archive context validates canonical, unique inventory members', () => {
  const observations = [];
  for (const oneMinuteSymbols of [['ZQQ7', 'not a coin'], ['ZQQ7', 'ZQQ7']]) {
    const context = { ...S.B.archiveContextOf(base.m), oneMinuteSymbols };
    const result = S.OUT.archiveContextError(context);
    const error = caught(() => S.EV.evaluateDataset({ featureRows: base.features, outcomeRows: base.outcomes,
      asOfTs: S.ASOF, splitAtTs: validationBase.em.splitAtTs, archiveContext: context }));
    observations.push({ rejectsContext: result !== null, rejectsEvaluation: corrupt(error) });
  }
  assert.deepEqual(observations, [
    { rejectsContext: true, rejectsEvaluation: true },
    { rejectsContext: true, rejectsEvaluation: true },
  ]);
});

test('N6 SHADOW sampling rank must equal the existing recipe hash for its identity', () => {
  const row = S.clone(shadow);
  const correct = S.SH.shadowRowRank({ recipeVersion: row.shadowContext.recipeVersion, sweepId: row.sweepId, coin: row.canonicalCoin });
  assert.equal(row.features['shadow.rank'], correct);
  row.features['shadow.rank'] = correct === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  assert.notEqual(S.FE.validateFeatureRow(row), null, 'a different valid-looking hash is still the wrong sampling identity');
});
