// SOCIAL-5B TRUTH-BOUNDARY CLOSEOUT — the independent delivery review's F1-F6, each reproduced against the delivered
// behaviour and then locked shut, plus the positive legacy -> v2 lineage round trip the review asked for.
//   F1  evaluation / reopening did not enforce its own as-of wall
//   F2a "never null" was read as permission to accept null (the prose contains the substring "null")
//   F2b nested record shapes were not revalidated on read (bounded length only)
//   F2c equal COUNTS were accepted instead of exact set equality (duplicate feature + orphan label balanced)
//   F3  a lawful dotted symbol projected to a record its own reader called malformed
//   F4  an output could be sealed beyond the byte bound its reader enforces
//   F5  an archive claiming creation BEFORE the series it consumed was accepted
//   F6  code identity omitted effective transitive source, so a clean HEAD could be claimed over dirty bytes
// Semantic mutations are RESEALED (checksums recomputed) so the semantic validators are actually exercised rather
// than stopping at the first checksum mismatch. No provider, network, spend, config or authority change.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../rumor2/truth.js';
import { RESEARCH_DOSSIER_EVENT_TYPE, validateResearchDossierEvent, isLegacyResearchDossierEvent } from '../rumor2/social-research-dossier.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { LIMITS, sha256Hex, FEATURE_CATALOGUE, FEATURE_LEAF_VALUE_OK, featureSpec, isCoin, isCode, catalogueArrayError, forbiddenLeafError, ARRAY_CATALOGUE, ResearchError, LABEL_HORIZONS_MIN, fail } from '../research/contracts.js';
import { projectEventList, validateSnapshotRecord } from '../research/snapshot.js';
import { selectResearchRows, validateFeatureRow } from '../research/features.js';
import { labelRow, validateOutcomeRow } from '../research/outcomes.js';
import { readChildhoodArchive } from '../research/archive.js';
import { evaluateDataset, datasetJoinError } from '../research/evaluation.js';
import { runSnapshot, runBuild, runEvaluate, readSnapshotDir, readDatasetDir, codeIdentity, pipelineSourceClosure, identityLaw, PIPELINE_ROOTS, ROOT } from '../research/pipeline.js';
import { jsonlWriter, writeJsonFile, publishManifest, readJsonlStrict, prepareOutputTarget, reserveOutputDir, verifyOutputs } from '../research/artifacts.js';
import { journalFixture, writeChildhoodArchive, linearBars, legacyDossierEventFrom, T0, SEC } from './helpers/social-5b.js';
import { obsEvent, observed, notice } from './helpers/social-7.js';

const dirs = []; const work = () => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5bc-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = (ms) => new Date(ms).toISOString();
const ASOF = T0 + 86_400_000;
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } };
const msgOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.researchMessage ?? String(e.message); } };
const ARCHIVE = (dir, over = {}) => writeChildhoodArchive(dir, { series: [{ symbol: over.symbol ?? 'ZQQ7', candles: over.bars ?? linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 5 * 3600 }) }], archiveCreatedTs: iso(over.createdMs ?? (SEC(T0) + 6 * 3600) * 1000), retrievedSec: over.retrievedSec ?? SEC(T0) + 5 * 3600 + 60 });
// rewrite a dataset directory in place and RESEAL its checksums, so semantic validation is what actually runs
function resealDataset(src, dst, mutate) {
  mkdirSync(dst); for (const f of readdirSync(src)) writeFileSync(path.join(dst, f), readFileSync(path.join(src, f)));
  mutate(dst);
  const m = JSON.parse(readFileSync(path.join(dst, 'dataset.manifest.json'), 'utf8'));
  for (const name of Object.keys(m.outputs)) { const buf = readFileSync(path.join(dst, name)); m.outputs[name].sha256 = sha256Hex(buf); m.outputs[name].bytes = buf.length; if (typeof m.outputs[name].lines === 'number') m.outputs[name].lines = buf.toString('utf8').split('\n').filter(Boolean).length; }
  writeFileSync(path.join(dst, 'dataset.manifest.json'), JSON.stringify(m, null, 1) + '\n');
  return dst;
}
async function lawfulDataset(W, { name = 'ds', asOfTs = ASOF, coins = ['ZQQ7'] } = {}) {
  const fx = await journalFixture({ coins, shadow: false });
  const snap = await runSnapshot({ events: fx.events, out: path.join(W, `${name}-snap`) });
  ARCHIVE(path.join(W, `${name}-arch`));
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, `${name}-arch`), asOfTs, out: path.join(W, name) });
  return { fx, snap, ds };
}

test('C1 (F1). reopening enforces the dataset as-of wall: a lawful row from a LATER dataset cannot contaminate an earlier evaluation — a decision, an input clock, a reference price or a KNOWN horizon beyond the as-of, and a value masked although already knowable, are all CORRUPT_INPUT at evaluate AND at readDatasetDir with valid checksums', async () => {
  const W = work(); const { ds } = await lawfulDataset(W);
  const read = readDatasetDir(ds.dir); const F = read.featureRows.find((r) => r.cohort === 'PRIMARY'); const L = read.outcomeRows.find((o) => o.rowId === F.rowId);
  assert.equal(L.horizons['240m'].state, 'KNOWN'); assert.ok(L.horizons['240m'].outcomeKnownAtTs > T0 + 120_000, 'the label is only knowable hours after the decision');
  // the delivered defect: this pair evaluated cleanly at an as-of before its own knowledge floors
  const early = await msgOf(async () => evaluateDataset({ featureRows: [F], outcomeRows: [L], asOfTs: T0 + 120_000, splitAtTs: T0 + 60_000 }));
  assert.match(early, /reference price knowable only at|horizon .* is KNOWN although/, 'a KNOWN value beyond the as-of is refused');
  const beforeDecision = await msgOf(async () => evaluateDataset({ featureRows: [F], outcomeRows: [L], asOfTs: T0 + 2000, splitAtTs: T0 + 1000 }));
  assert.match(beforeDecision, /decides at .* after the dataset as-of/, 'a feature whose decision is in the future of the as-of is refused');
  assert.equal(evaluateDataset({ featureRows: [F], outcomeRows: [L], asOfTs: ASOF, splitAtTs: T0 + 3_600_000 }).evaluation.rows.primary, 1, 'the lawful as-of still evaluates');
  // masked although knowable, and a knowledge floor before its own horizon end
  const maskedButKnowable = { ...L, horizons: { ...L.horizons, '1m': { ...L.horizons['1m'], state: 'NOT_YET_KNOWN', reason: 'NOT_YET_KNOWN_AT_AS_OF', mfePct: null, maePct: null } } };
  assert.match(await msgOf(async () => evaluateDataset({ featureRows: [F], outcomeRows: [maskedButKnowable], asOfTs: ASOF, splitAtTs: T0 + 3_600_000 })), /masked although it was knowable/);
  assert.match(validateOutcomeRow({ ...L, horizons: { ...L.horizons, '1m': { ...L.horizons['1m'], outcomeKnownAtTs: L.anchorTsMs } } }), /knowledge floor precedes the horizon end/);
  assert.match(validateOutcomeRow({ ...L, reference: { ...L.reference, knownAtTs: L.anchorTsMs - 1 } }), /reference must name the bar closing at the anchor and its own knowledge floor/);
  assert.match(validateOutcomeRow({ ...L, reference: { state: 'NOT_YET_KNOWN', barOpenSec: null, price: null, knownAtTs: L.reference.knownAtTs } }), /is KNOWN while its reference price is not/, 'an excursion cannot be known before its own reference price');
  // and on REOPEN: a re-dated manifest with perfectly valid checksums is refused, never silently honoured
  const redated = resealDataset(ds.dir, path.join(W, 'redated'), (d) => { const m = JSON.parse(readFileSync(path.join(d, 'dataset.manifest.json'), 'utf8')); m.asOfTs = T0 + 120_000; m.asOf = iso(T0 + 120_000); writeFileSync(path.join(d, 'dataset.manifest.json'), JSON.stringify(m, null, 1) + '\n'); });
  assert.equal(await codeOf(async () => readDatasetDir(redated)), 'CORRUPT_INPUT', 'a dataset re-dated to an earlier as-of is corrupt input, not a cheaper evaluation');
  // mismatched dataset metadata is refused too (counts / coverage / manifest summary must reconcile)
  const miscounted = resealDataset(ds.dir, path.join(W, 'miscounted'), (d) => { const c = JSON.parse(readFileSync(path.join(d, 'coverage.json'), 'utf8')); c.counts = { ...c.counts, rows: c.counts.rows + 5 }; writeFileSync(path.join(d, 'coverage.json'), JSON.stringify(c, null, 1) + '\n'); });
  assert.match(await msgOf(async () => readDatasetDir(miscounted)), /coverage counts .* disagree with the .* rows on disk|manifest summary disagrees|counts: the row total is not the primary plus shadow rows/);
});

test('C2 (F2a). nullability is an explicit machine-readable flag: "never null" is documentation, never permission — every catalogue leaf declares a boolean that AGREES with its prose, and a non-nullable leaf is refused at generation and on read', () => {
  for (const s of FEATURE_CATALOGUE) {
    assert.equal(typeof s.nullable, 'boolean', `${s.name} declares nullability`);
    if (/^never null(\b|$)/.test(s.nullMeaning)) assert.equal(s.nullable, false, `${s.name}: "never null" must not be nullable`);
    if (/^null = /.test(s.nullMeaning)) assert.equal(s.nullable, true, `${s.name}: a documented null meaning must be nullable`);
    assert.equal(FEATURE_LEAF_VALUE_OK(s, null), s.nullable, `${s.name}: null is decided by the flag alone`);
  }
  const truncated = featureSpec('dependencies.truncated');
  assert.ok(/null/.test(truncated.nullMeaning), 'the prose still contains the substring that used to defeat the check');
  assert.equal(truncated.nullable, false); assert.equal(FEATURE_LEAF_VALUE_OK(truncated, null), false);
  assert.ok(FEATURE_CATALOGUE.some((s) => s.nullable) && FEATURE_CATALOGUE.some((s) => !s.nullable), 'both kinds exist');
});

test('C2b (F2b). nested record shapes are fully revalidated on read: an undeclared member key (including a raw-text one), a wrong member type, a missing member and an out-of-vocabulary code are refused on snapshot records AND feature rows, with checksums resealed so the semantic validator is what runs', async () => {
  const W = work(); const { ds, snap } = await lawfulDataset(W);
  const read = readDatasetDir(ds.dir); const F = read.featureRows.find((r) => r.cohort === 'PRIMARY');
  const withNodes = (nodes) => ({ ...F, arrays: { ...F.arrays, dependencyNodes: nodes } });
  const n0 = F.arrays.dependencyNodes[0];
  assert.match(validateFeatureRow(withNodes([{ ...n0, text: 'AUDIT_RAW_CONTENT_SENTINEL' }])), /free-text \/ raw-content leaf/, 'the delivered defect: a raw-text member was accepted');
  // the diagnostic names a SAFE STRUCTURAL POSITION, never the attacker-chosen key text itself
  assert.match(validateFeatureRow(withNodes([{ ...n0, extra: 1 }])), /undeclared key at position \d+ of \d+/);
  assert.match(validateFeatureRow(withNodes([{ id: n0.id, kind: n0.kind }])), /missing key 'knownAtTs'/);
  assert.match(validateFeatureRow(withNodes([{ ...n0, kind: 'not a code' }])), /dependencyNodes\[0\]\.kind unsupported/);
  assert.match(validateFeatureRow(withNodes([{ ...n0, knownAtTs: 'yesterday' }])), /dependencyNodes\[0\]\.knownAtTs unsupported/);
  assert.match(validateFeatureRow({ ...F, arrays: { ...F.arrays, entrances: ['NOT_A_KIND'] } }), /entrances\[0\] is not a closed value/);
  assert.match(validateFeatureRow({ ...F, arrays: { ...F.arrays, dependencyNodes: 'nope' } }), /dependencyNodes is not a list/);
  const { dependencyNodes, ...missingArray } = F.arrays; assert.match(validateFeatureRow({ ...F, arrays: missingArray }), /dependencyNodes is not a list/);
  assert.match(validateFeatureRow({ ...F, arrays: { ...F.arrays, madeUp: [] } }), /undeclared array madeUp/);
  // the same law on snapshot records, and through the real readers with valid checksums
  const rec = readSnapshotDir(snap.dir).records.find((r) => r.recordKind === 'RESEARCH_DOSSIER_V2');
  assert.match(validateSnapshotRecord({ ...rec, arrays: { ...rec.arrays, dependencyNodes: [{ ...rec.arrays.dependencyNodes[0], text: 'X' }] } }), /undeclared key at position \d+|free-text \/ raw-content leaf/, 'the exact-member-key law rejects it first; the free-text law is the second net');
  assert.match(validateSnapshotRecord({ ...rec, arrays: { ...rec.arrays, claims: [{ claimRef: 'c' }] } }), /claims\[0\] missing key/);
  const tampered = resealDataset(ds.dir, path.join(W, 'nested'), (d) => { const lines = readFileSync(path.join(d, 'features.jsonl'), 'utf8').split('\n').filter(Boolean); const r = JSON.parse(lines[0]); r.arrays.dependencyNodes[0].text = 'AUDIT_RAW_CONTENT_SENTINEL'; lines[0] = JSON.stringify(r); writeFileSync(path.join(d, 'features.jsonl'), lines.join('\n') + '\n'); });
  assert.equal(await codeOf(async () => readDatasetDir(tampered)), 'CORRUPT_INPUT', 'a resealed nested mutation still fails the semantic validator');
  // the shared array validator is the same one the projector obeys
  assert.equal(catalogueArrayError('dependencyNodes', F.arrays.dependencyNodes), null);
  assert.equal(forbiddenLeafError({ a: { b: [{ note: 'x' }] } }), 'record.a.b[0].note is a free-text / raw-content leaf and can never be exported');
  assert.ok(Object.keys(ARRAY_CATALOGUE).length >= 12);
});

test('C2c (F2c). row identity is exact SET equality, not equal counts: a duplicate feature beside an orphan label no longer balances the books; duplicate labels, orphan labels and unmatched features are each refused', async () => {
  const W = work(); const { ds } = await lawfulDataset(W);
  const read = readDatasetDir(ds.dir); const F = read.featureRows.find((r) => r.cohort === 'PRIMARY'); const L = read.outcomeRows.find((o) => o.rowId === F.rowId);
  const orphan = { ...L, rowId: `r5f-${'e'.repeat(64)}` };
  assert.match((await msgOf(async () => evaluateDataset({ featureRows: [F, F], outcomeRows: [L, orphan], asOfTs: ASOF, splitAtTs: T0 + 3_600_000 }))), /duplicate feature row/, 'the delivered defect: two features and two labels balanced by count');
  assert.match(datasetJoinError({ featureRows: [F], outcomeRows: [L, orphan], asOfTs: ASOF }).error, /outcome rows exist without a feature row/);
  assert.match(datasetJoinError({ featureRows: [F], outcomeRows: [L, L], asOfTs: ASOF }).error, /duplicate outcome row/);
  assert.match(datasetJoinError({ featureRows: [F], outcomeRows: [], asOfTs: ASOF }).error, /has no outcome row/);
  assert.match(datasetJoinError({ featureRows: [F], outcomeRows: [{ ...L, canonicalCoin: 'FRESH42' }], asOfTs: ASOF }).error, /disagrees with its feature row/);
  assert.equal(datasetJoinError({ featureRows: read.featureRows, outcomeRows: read.outcomeRows, asOfTs: ASOF }).rows.length, read.featureRows.length, 'the lawful bijection is accepted');
});

test('C3 (F3). a lawful dotted asset identity survives the whole pipeline: the projector, the snapshot reader, the dataset reader and the evaluator all use the ONE canonical coin law, and an out-of-law symbol is still refused', async () => {
  const W = work();
  const fx = await journalFixture({ coins: ['A.B'], shadow: false });
  const rec = projectEventList(fx.events).records.find((r) => r.recordKind === 'RESEARCH_DOSSIER_V2');
  assert.equal(rec.canonicalCoin, 'A.B');
  assert.equal(validateSnapshotRecord(rec), null, 'the delivered defect: a generated record its own reader called malformed');
  const snap = await runSnapshot({ events: fx.events, out: path.join(W, 'snap') });
  ARCHIVE(path.join(W, 'arch'), { symbol: 'A.B' });
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'ds') });
  const read = readDatasetDir(ds.dir); const row = read.featureRows.find((r) => r.cohort === 'PRIMARY');
  assert.equal(row.canonicalCoin, 'A.B'); assert.equal(read.outcomeRows.find((o) => o.rowId === row.rowId).horizons['60m'].state, 'KNOWN', 'a dotted symbol labels normally');
  const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: T0 + 5 * 3_600_000, out: path.join(W, 'ev') });
  assert.equal(ev.evaluation.rows.primary, 1);
  // shadow rows carry the same law
  const fxs = await journalFixture({ coins: ['A.B'], shadow: true });
  const shadowRec = projectEventList(fxs.events).records.find((r) => r.recordKind === 'RESEARCH_SHADOW_SAMPLE');
  assert.equal(validateSnapshotRecord(shadowRec), null);
  assert.equal(validateSnapshotRecord({ ...shadowRec, selected: [{ ...shadowRec.selected[0], coin: 'not a coin' }] }), 'snapshot record: selected rows malformed');
  // and the law itself: an asset identity is not a reason code, and neither admits the other's shape
  assert.ok(isCoin('A.B') && isCoin('ZQQ7') && !isCoin('a.b') && !isCoin('TOO.LONG.SYMBOL.X'));
  assert.ok(isCode('SOCIAL_SOURCE') && !isCode('A.B'));
  assert.equal(validateSnapshotRecord({ ...rec, canonicalCoin: 'not a coin' }), 'snapshot record: identity / clocks malformed');
});

test('C4 (F4). producer and consumer share one byte bound: a writer refuses to seal what its reader would reject, publishing validates every output before the manifest, an omitted checksum entry is a corrupt manifest, and a bound tripped mid-file leaves no open handle and no artifact', async () => {
  const W = work(); const lim = { ...LIMITS, maxInputFileBytes: 400, maxJsonlLineBytes: 512 };
  const res = reserveOutputDir(prepareOutputTarget(path.join(W, 'seal')));
  const w = jsonlWriter(res, 'rows.jsonl', { limits: lim });
  w.write({ pad: 'a'.repeat(100) });
  assert.equal(await codeOf(async () => w.write({ pad: 'b'.repeat(350) })), 'RESOURCE_LIMIT_EXCEEDED', 'the delivered defect: the writer sealed beyond its reader bound');
  assert.equal(await codeOf(async () => w.write({ pad: 'c' })), 'INTERNAL_FAILURE', 'the descriptor is closed after the bound trips — no write survives it');
  // a lawful file round-trips through the same limits
  const res2 = reserveOutputDir(prepareOutputTarget(path.join(W, 'ok')));
  const w2 = jsonlWriter(res2, 'rows.jsonl', { limits: lim }); w2.write({ pad: 'a'.repeat(100) }); const o2 = w2.close();
  let n = 0; for (const rec of readJsonlStrict(path.join(res2.dir, 'rows.jsonl'), { limits: lim })) { void rec; n += 1; }
  assert.equal(n, 1); assert.equal(o2.lines, 1);
  assert.equal(await codeOf(async () => writeJsonFile(res2, 'big.json', { pad: 'x'.repeat(1000) }, { limits: lim })), 'RESOURCE_LIMIT_EXCEEDED');
  // publishing proves the EXACT candidate that will be serialized, under a law that verifies every declared output
  // against the bytes on disk, its record count and the reader's limits
  const LAW = (d, m) => verifyOutputs(d, m.outputs, { limits: lim, expected: ['rows.jsonl'] });
  assert.equal(await codeOf(async () => publishManifest(res2, 'm.json', { outputs: { 'rows.jsonl': { ...o2, sha256: 'f'.repeat(64) } } }, { limits: lim, bundle: LAW })), 'CORRUPT_INPUT');
  assert.ok(!existsSync(path.join(res2.dir, 'm.json')), 'no manifest is sealed over an unverified output');
  assert.equal(await codeOf(async () => publishManifest(res2, 'm.json', { outputs: { 'rows.jsonl': { ...o2, lines: 99 } } }, { limits: lim, bundle: LAW })), 'CORRUPT_INPUT', 'a declared record count must match the file');
  // and a manifest may not be sealed under NO law at all: checksums prove bytes did not change, never that they were lawful
  assert.equal(await codeOf(async () => publishManifest(res2, 'm.json', { outputs: { 'rows.jsonl': o2 } }, { limits: lim })), 'INTERNAL_FAILURE', 'the delivered defect: a checksummed artifact could be sealed without the reader\'s own law');
  assert.ok(!existsSync(path.join(res2.dir, 'm.json')));
  // a law that refuses the candidate stops the seal, and nothing is written
  assert.equal(await codeOf(async () => publishManifest(res2, 'm.json', { outputs: { 'rows.jsonl': o2 } }, { limits: lim, bundle: () => fail('CORRUPT_INPUT', 'the reader would refuse this row') })), 'CORRUPT_INPUT');
  assert.ok(!existsSync(path.join(res2.dir, 'm.json')));
  // THE PROVED CANDIDATE IS THE SERIALIZED CANDIDATE: a proof cannot be run against a different object, and mutating
  // the caller's manifest after publication cannot change the bytes that were validated and written
  const candidate = { outputs: { 'rows.jsonl': o2 } };
  publishManifest(res2, 'm.json', candidate, { limits: lim, bundle: (d, m) => { assert.deepEqual(m, candidate, 'the law receives the exact candidate'); assert.ok(Object.isFrozen(m), 'and it is immutable between proof and serialization'); LAW(d, m); } });
  candidate.outputs['rows.jsonl'] = { ...o2, sha256: 'f'.repeat(64) };
  assert.equal(JSON.parse(readFileSync(path.join(res2.dir, 'm.json'), 'utf8')).outputs['rows.jsonl'].sha256, o2.sha256, 'the sealed bytes are the proved ones');
  // the declared member LIST is part of the contract: an omitted entry is corrupt, not "everything listed matched"
  assert.equal(await codeOf(async () => verifyOutputs(res2.dir, { 'rows.jsonl': o2 }, { limits: lim, expected: ['rows.jsonl', 'other.jsonl'] })), 'CORRUPT_INPUT');
  // an interrupted build leaves no manifest and removes its own files
  const { snap } = await lawfulDataset(W, { name: 'l' });
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: path.join(W, 'tiny'), limits: { ...LIMITS, maxInputFileBytes: 200 } })), 'RESOURCE_LIMIT_EXCEEDED');
  assert.ok(!existsSync(path.join(W, 'tiny')));
});

test('C5 (F5). archive provenance: a manifest claiming the archive was created BEFORE the series it consumed is corrupt input, while a genuinely ABSENT creation clock stays an explicit unavailable-coverage limitation — the two are never confused', async () => {
  const W = work();
  ARCHIVE(path.join(W, 'bad'), { createdMs: T0, retrievedSec: SEC(T0) + 5 * 3600 });
  assert.match(await msgOf(async () => readChildhoodArchive(path.join(W, 'bad'))), /was retrieved at .* but the manifest claims the archive was created earlier/, 'the delivered defect: contradictory provenance was accepted');
  ARCHIVE(path.join(W, 'good'), { createdMs: (SEC(T0) + 6 * 3600) * 1000, retrievedSec: SEC(T0) + 5 * 3600 });
  const good = readChildhoodArchive(path.join(W, 'good'));
  assert.equal(good.census.tracks['1m'].symbols, 1); assert.ok(!good.limitations.includes('PROVENANCE_CLOCK_MISSING'));
  // equality is lawful (retrieved exactly when the archive was created)
  ARCHIVE(path.join(W, 'equal'), { createdMs: (SEC(T0) + 5 * 3600) * 1000, retrievedSec: SEC(T0) + 5 * 3600 });
  assert.equal(readChildhoodArchive(path.join(W, 'equal')).census.tracks['1m'].symbols, 1);
  // ABSENT provenance and MALFORMED provenance are DIFFERENT facts and are never collapsed into one.
  // A SUPPLIED value that is not a lawful UTC instant is a corrupt archive, not "no clock recorded":
  writeChildhoodArchive(path.join(W, 'garbled'), { series: [{ symbol: 'ZQQ7', candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 3600 }) }], archiveCreatedTs: 'not-a-clock', retrievedSec: SEC(T0) + 3600 });
  assert.equal(await codeOf(async () => readChildhoodArchive(path.join(W, 'garbled'))), 'CORRUPT_INPUT', 'the delivered defect: a garbled creation clock was silently rewritten as an absent one');
  assert.match(await msgOf(async () => readChildhoodArchive(path.join(W, 'garbled'))), /supplies an archiveCreatedTs that is not a lawful UTC instant/);
  // a genuinely ABSENT clock (null, or the key omitted) stays an explicit unavailable-coverage limitation
  writeChildhoodArchive(path.join(W, 'noclock'), { series: [{ symbol: 'ZQQ7', candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 3600 }) }], archiveCreatedTs: null, retrievedSec: SEC(T0) + 3600 });
  const nc = readChildhoodArchive(path.join(W, 'noclock'));
  assert.equal(nc.archiveCreatedTsMs, null); assert.ok(nc.limitations.includes('PROVENANCE_CLOCK_MISSING'));
  assert.equal(labelRow({ rowId: 'r', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: nc, asOfTs: ASOF }).availability.reason, 'PROVENANCE_CLOCK_MISSING');
});

test('C6 (F6). code identity is the DISCOVERED source closure: it reaches transitive dependencies the entry points execute, a change confined to one of them changes the digest and the dirty verdict, and a dirty closure outranks a clean HEAD', () => {
  const closure = pipelineSourceClosure();
  for (const r of PIPELINE_ROOTS) assert.ok(closure.includes(r), `${r} is a root`);
  assert.ok(closure.includes('evidence/contract.js'), 'the delivered defect: an executed transitive dependency was outside the identity');
  assert.ok(closure.includes('rumor2/social-research-dossier.js') && closure.includes('childhood/validate.js') && closure.includes('research/contracts.js'));
  assert.ok(closure.length > PIPELINE_ROOTS.length && closure.every((f) => existsSync(path.join(ROOT, f))));
  assert.deepEqual(closure, [...closure].sort(), 'deterministic order');
  assert.deepEqual(pipelineSourceClosure(), closure, 'deterministic across calls');
  const before = codeIdentity(); assert.equal(before.sourceFiles, closure.length); assert.deepEqual(before.sourceClosure, closure);
  const dep = path.join(ROOT, 'evidence/contract.js'); const orig = readFileSync(dep, 'utf8');
  try {
    writeFileSync(dep, `${orig}\n// SOCIAL-5B closeout: transitive identity probe\n`);
    const after = codeIdentity();
    assert.notEqual(after.sourceTreeSha256, before.sourceTreeSha256, 'mutating an executed transitive dependency changes the source digest');
    assert.equal(after.gitSourceDirty, true, 'and the path-scoped dirty check sees it');
  } finally { writeFileSync(dep, orig); }
  assert.equal(codeIdentity().sourceTreeSha256, before.sourceTreeSha256, 'restoring the dependency restores the identity');
  // the law itself, over all three controlled cases
  assert.equal(identityLaw({ gitCommit: 'a'.repeat(40), gitSourceDirty: false }), 'PRODUCED_BY_COMMITTED_SOURCE');
  assert.equal(identityLaw({ gitCommit: 'a'.repeat(40), gitSourceDirty: true }), 'PRODUCED_BY_UNCOMMITTED_SOURCE', 'a dirty closure is never attributed to a clean HEAD');
  assert.equal(identityLaw({ gitCommit: null, gitSourceDirty: null }), 'NO_GIT_CHECKOUT');
  assert.match(before.note, /never an operational import or authority allowance/, 'the inventory is provenance, not an authority grant');
});

test('C7 (review §8). a VALID legacy dossier is inventoried and opens a lawful NEW_AFTER_LEGACY v2 episode: the positive round trip, not merely the rejection of a record carrying a legacy version label', async () => {
  const seed = await journalFixture({ coins: ['ZQQ7'], shadow: false });
  const legacy = legacyDossierEventFrom(seed.dossiers[0]);
  assert.equal(validateResearchDossierEvent(legacy), null, 'the fixture is a genuinely valid legacy event under the frozen legacy law');
  assert.equal(isLegacyResearchDossierEvent(legacy), true);
  const arr = [...seed.events.filter((e) => e.type !== RESEARCH_DOSSIER_EVENT_TYPE), legacy];
  const clock = { ms: T0 + 500_000 }; const rt = createResearchStrainer({ now: () => clock.ms });
  assert.equal(rt.hydrate(arr).ok, true, 'the runtime replays a legacy dossier');
  const o = obsEvent({ id: 'nl1', author: 'did:plc:next', text: '$ZQQ7 after the legacy record', nowMs: T0 + 400_000 }); arr.push(o); rt.ingest([o]);
  const r = await rt.tick({ knownAtTs: clock.ms, providerStates: observed(clock.ms), fenceHeld: () => true, append: (evs) => { arr.push(...evs); return { ok: true, lastSeq: arr.length }; }, notices: [notice('ZQQ7', T0 + 450_000)] });
  assert.equal(r.ok, true);
  const dossiers = arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE);
  assert.equal(dossiers.length, 2); assert.equal(dossiers[1].dossier.episode.basis, 'NEW_AFTER_LEGACY'); assert.equal(dossiers[1].episodeIndex, 2);
  const out = projectEventList(arr);
  assert.equal(out.counts.dossierLegacy, 1, 'the legacy dossier is inventoried'); assert.equal(out.counts.dossierV2, 1);
  assert.equal(out.counts.dossierV2Projected, 1, 'and never converted into a v2 projection');
  assert.equal(out.records.filter((x) => x.recordKind === 'RESEARCH_DOSSIER_V2').length, 1);
  const sel = selectResearchRows(out.records, { asOfTs: ASOF });
  assert.equal(sel.counts.primaryRows, 1); assert.equal(sel.rows[0].episodeBasis, 'NEW_AFTER_LEGACY', 'a legacy predecessor lawfully opens the next episode');
  assert.equal(sel.rows[0].features['episode.index'], 2);
});

test('C8. the closeout changes no authority: artifacts still carry authority NONE / RESEARCH_ONLY, stage calibration is NOT_PERFORMED with the current stage UNKNOWN, and every horizon vocabulary is unchanged', async () => {
  const W = work(); const { ds } = await lawfulDataset(W);
  const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: T0 + 5 * 3_600_000, out: path.join(W, 'ev') });
  assert.equal(ev.evaluation.authority, 'NONE'); assert.equal(ev.evaluation.purpose, 'RESEARCH_ONLY');
  assert.equal(ev.evaluation.state.stageCalibration, 'NOT_PERFORMED'); assert.equal(ev.evaluation.state.currentRuntimeStage, 'UNKNOWN'); assert.equal(ev.evaluation.state.fittedModel, 'NONE');
  assert.deepEqual(LABEL_HORIZONS_MIN, [1, 3, 5, 15, 30, 60, 240]);
  const read = readDatasetDir(ds.dir);
  for (const r of read.featureRows) { assert.equal(r.authority, 'NONE'); assert.equal(r.sourceProfileContext, 'NOT_RECORDED_IN_DOSSIER'); assert.equal(r.claimAssociationContext, 'NOT_AVAILABLE_NO_AUTHORIZED_SEAM'); }
  assert.equal(canonicalJson(read.manifest.counts), canonicalJson(read.coverage.counts));
});
