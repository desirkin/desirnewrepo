// Owner-supplied acceptance assertions: RED on the reviewed delivery, GREEN after repair.
// A RED test passes only by rejecting the demonstrated corruption for the right class
// of reason. Do not invert these assertions to accept the broken baseline behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { baseFixture, datasetCandidate, evaluationCandidate, dottedShadowFixture, clone, cleanup, work, repo, ASOF, SPLIT, CREATED, C, IO, B, FE, EV, OUT, ID } from './helpers/social-5b-owner-support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let base, shadow;
test.before(async () => { base = await baseFixture(); shadow = await dottedShadowFixture(); });
test.after(cleanup);
function corruption(error, label) {
  assert.ok(error instanceof C.ResearchError, `${label}: required CORRUPT_INPUT; candidate was accepted or returned the wrong error class`);
  assert.equal(error.code, 'CORRUPT_INPUT', label);
  assert.doesNotMatch(error.researchMessage ?? '', /checksum mismatch|bytes do not match|byte count disagrees|line count disagrees/i, `${label}: must reach semantic validation`);
}
function thrown(fn) { try { fn(); return null; } catch (e) { return e; } }
function child(mode, target = '') {
  const r = spawnSync(process.execPath, ['--require', path.join(HERE, 'helpers/social-5b-owner-fs.cjs'), path.join(HERE, 'helpers/social-5b-owner-child.mjs')], {
    cwd: repo, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: '', SERPENT_REPO_DIR: repo, SERPENT_ACCEPTANCE_CHILD_MODE: mode, SERPENT_ACCEPTANCE_CLOSE_TARGET: target },
  });
  assert.equal(r.error, undefined, 'child must finish without a spawn/timeout failure');
  assert.equal(r.status, 0, `child infrastructure failure: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('P01 complete synthetic snapshot/dataset/evaluation positives publish and reopen', () => {
  const ds = datasetCandidate(base); assert.equal(ds.error, null); assert.equal(ds.sealed, true);
  assert.equal(B.datasetBundle(ds.dir, ds.m).featureRows.length, 1);
  const e = evaluationCandidate(base); assert.equal(e.error, null); assert.equal(e.sealed, true);
  assert.equal(B.evaluationBundle(e.dir, e.m).evaluation.learnability.horizons['240m'].discoveryTrainableAtSplit, 0);
});
test('P02 the repaired contextual double-backdate stays rejected and honest learnability remains zero', () => {
  assert.equal(base.outcomes[0].reference.knownAtTs, CREATED);
  assert.equal(base.evaluation.learnability.horizons['240m'].discoveryTrainableAtSplit, 0);
  const r = datasetCandidate(base, ({ outcomes }) => { outcomes[0].reference.knownAtTs = outcomes[0].anchorTsMs; for (const h of Object.values(outcomes[0].horizons)) h.outcomeKnownAtTs = h.horizonEndTs; });
  corruption(r.error, 'double backdate'); assert.equal(r.sealed, false);
});
test('P03 original negative-count, false-calibration and null-input examples stay rejected', () => {
  for (const mutate of [e => { e.rows.primary = -1; }, e => { e.state.stageCalibration = 'PERFORMED'; }]) {
    const r = evaluationCandidate(base, mutate); corruption(r.error, 'original evaluation corruption'); assert.equal(r.sealed, false);
  }
  const d = datasetCandidate(base, ({ m }) => { m.inputs = null; }); corruption(d.error, 'null inputs'); assert.equal(d.sealed, false);
});
test('P04 actual dotted A.B SHADOW survives snapshot projection, feature file round trip and descriptive evaluation', () => {
  assert.equal(shadow.cohort, 'SHADOW'); assert.equal(shadow.canonicalCoin, 'A.B');
  const res = IO.reserveOutputDir(path.join(work(), 'shadow'));
  const w = IO.jsonlWriter(res, 'features.jsonl'); w.write(shadow); w.close();
  const loaded = [];
  IO.consumeJsonl(path.join(res.dir, 'features.jsonl'), { onRecord: r => { assert.equal(FE.validateFeatureRow(r), null); loaded.push(r); } });
  assert.deepEqual(loaded, [shadow]);
  const o = OUT.labelRow(loaded[0], { archive: null, asOfTs: ASOF });
  const e = EV.evaluateDataset({ featureRows: loaded, outcomeRows: [o], asOfTs: ASOF, splitAtTs: SPLIT }).evaluation;
  assert.equal(e.rows.shadow, 1);
});

const datasetCases = [
  ['R1a nested archive source text', ({ coverage }) => { coverage.census.archive.source.text = 'AUDIT_RAW_CONTENT_SENTINEL_9B68'; }],
  ['R1b archive tracks wrong type', ({ coverage }) => { coverage.census.archive.tracks = 'NOT_AN_OBJECT'; }],
  ['R1c empty declared series inventory with populated outcomes', ({ coverage }) => { coverage.census.archive.oneMinuteSymbols = []; coverage.census.overlap.archiveOneMinuteSymbols = 0; coverage.census.overlap.rowCoinsWithOneMinuteSeries = 0; }],
  ['R1d dirty identity falsely claiming committed source', ({ m }) => { m.codeIdentity.gitCommit = 'a'.repeat(40); m.codeIdentity.gitSourceDirty = true; m.codeIdentity.law = 'PRODUCED_BY_COMMITTED_SOURCE'; assert.equal(ID.identityLaw(m.codeIdentity), 'PRODUCED_BY_UNCOMMITTED_SOURCE'); }],
  ['R3 derivation latency inconsistent with unchanged input clocks', ({ features }) => { const f = features[0]; const lawful = f.featureAsOfTs - f.features['decision.latestInputKnownAtTs']; assert.equal(f.features['clock.derivationLatencyMs'], lawful); f.features['clock.derivationLatencyMs'] += 1; }],
];
for (const [name, mutate] of datasetCases) {
  test(`${name}: publication rejects before seal`, () => { const r = datasetCandidate(base, mutate); corruption(r.error, name); assert.equal(r.sealed, false, 'invalid candidate must have no completion manifest'); });
  test(`${name}: saved artifact with correct hashes is rejected`, () => {
    const r = datasetCandidate(base, mutate, 'saved'); assert.equal(r.error, null, 'fixture writing must succeed');
    corruption(thrown(() => B.datasetBundle(r.dir, r.m)), name);
  });
}
test('R1e SHADOW context is closed to undeclared fields', () => {
  const f = clone(shadow); f.shadowContext.unexpectedValue = 7;
  assert.notEqual(FE.validateFeatureRow(f), null, 'undeclared SHADOW context field must reject');
});
test('R1f SHADOW selection reason uses the actual closed vocabulary', () => {
  const f = clone(shadow); f.features['shadow.selectionReason'] = 'MADE_UP_SELECTION';
  assert.notEqual(FE.validateFeatureRow(f), null, 'invented selection reason must reject');
});

const spread = e => { e.tables.primaryAll['1m'].mfePct = { n: 1, min: 0, p25: 1, median: 2, p75: 3, max: 4 }; };
const evaluationCases = [
  ['R2a one-observation order statistics must coincide', spread],
  ['R2b group split must agree with recorded counts and chronology', e => { assert.equal(e.splits.groupsBySplit.DISCOVERY, 1); assert.equal(e.splits.groupsBySplit.VALIDATION, 0); e.grouping.groupSummaries[0].split = 'VALIDATION'; }],
  ['R2c coverage reasons use the actual closed vocabulary', e => { e.state.dataCoverage.reasons.push('MADE_UP_REASON'); e.state.dataCoverage.reasons.sort(); }],
];
for (const [name, mutate] of evaluationCases) {
  test(`${name}: standalone publication rejects before seal`, () => { const r = evaluationCandidate(base, mutate); corruption(r.error, name); assert.equal(r.sealed, false); });
  test(`${name}: standalone reopening rejects despite regenerated report`, () => {
    const r = evaluationCandidate(base, mutate, 'saved');
    corruption(thrown(() => B.evaluationBundle(r.dir, r.m)), name);
  });
}
test('P05 the additional honest source.expected evaluation proof remains effective', () => {
  const r = evaluationCandidate(base, spread, 'saved');
  const inp = base.em.inputs.dataset;
  corruption(thrown(() => B.evaluationBundle(r.dir, r.m, { source: { expected: base.evaluation, datasetManifestSha256: inp.manifestSha256, featuresSha256: inp.featuresSha256, outcomesSha256: inp.outcomesSha256 } })), 'source-aware evaluation proof');
});
for (const target of ['features.jsonl.part', 'coverage.json.part', 'dataset.manifest.json.part']) {
  test(`R4 reported close EIO for ${target} prevents completion`, () => {
    const r = child('close', target);
    assert.deepEqual(r, { injected: 1, code: 'IO_FAILURE', researchError: true, sealed: false, outstanding: 0 });
  });
}
test('P06 early iterator exit closes the actual tracked descriptor', () => {
  const r = child('reader-early');
  assert.equal(r.opened, 1); assert.equal(r.closed, 1); assert.equal(r.outstanding, 0); assert.equal(r.code, null); assert.equal(r.got.length, 1); assert.equal(r.complete, false);
});
test('P07 malformed JSONL closes the actual tracked descriptor', () => {
  const r = child('reader-malformed');
  assert.equal(r.opened, 1); assert.equal(r.closed, 1); assert.equal(r.outstanding, 0); assert.equal(r.code, 'CORRUPT_INPUT');
});
test('P08 tiny multibyte reads preserve text and hash the consumed stream', () => {
  const r = child('reader-multibyte');
  assert.equal(r.opened, 1); assert.equal(r.closed, 1); assert.equal(r.outstanding, 0); assert.equal(r.code, null); assert.equal(r.complete, true); assert.equal(r.sha256, r.expectedSha256);
  assert.deepEqual(r.got, [{ text: 'abcd\u20ac\ud83d\ude00efghi' }, { n: 2 }]);
});
test('R5 actual saved-bundle error rejects an unknown feature without echoing its name', () => {
  const sentinel = 'AUDIT_RAW_CONTENT_SENTINEL_EXTRA_FEATURE';
  const r = datasetCandidate(base, ({ features }) => { features[0].features[sentinel] = 1; }, 'saved');
  const e = thrown(() => B.datasetBundle(r.dir, r.m)); corruption(e, 'unknown feature');
  assert.equal(JSON.stringify(e.toJSON()).includes(sentinel), false, 'serialized error must not contain the untrusted key name');
});
