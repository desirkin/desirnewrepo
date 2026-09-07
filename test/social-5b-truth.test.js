// SOCIAL-5B REMAINING TRUTH-BOUNDARY REPAIR — the regression matrix (A .. I) for R1 .. R8.
//
// Every test here first states the DELIVERED DEFECT it closes: each of these constructions was accepted by the
// pipeline at baseline 865a07a on unchanged production code. Nothing below relaxes a law to make a fixture pass, and
// no expected count was moved to match an over-permissive validator — where the honest answer is zero it stays zero
// and the doctored input is REFUSED instead.
//
// Offline only: an in-memory journal fixture, a synthetic Childhood archive in a temp directory, and a fake `git`
// shim on PATH for one provenance branch. No network, no database, no provider, no config read, no git mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LIMITS, ResearchError, ABSENCE_VALUES, ARRAY_CLOCK_LAW, ARRAY_CATALOGUE, FEATURE_CATALOGUE, sha256Hex, arrayClockError } from '../research/contracts.js';
import { projectEventList } from '../research/snapshot.js';
import { selectResearchRows, validateFeatureRow } from '../research/features.js';
import { labelRow, validateOutcomeRow } from '../research/outcomes.js';
import { validateCandleSeriesRow, readChildhoodArchive } from '../research/archive.js';
import { evaluateDataset } from '../research/evaluation.js';
import { runSnapshot, runBuild, runEvaluate, readSnapshotDir, readDatasetDir, readEvaluationDir, codeIdentity, identityLaw, IDENTITY_LAWS } from '../research/pipeline.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, publishManifest, readJsonlStrict, JSONL_CHUNK_BYTES } from '../research/artifacts.js';
import { datasetBundle } from '../research/bundle.js';
import { journalFixture, writeChildhoodArchive, linearBars, T0, SEC } from './helpers/social-5b.js';

const dirs = []; const work = () => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5bt-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = (ms) => new Date(ms).toISOString();
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } };
const msgOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.researchMessage ?? String(e.message); } };

// ---- THE APPENDIX A FIXTURE ---------------------------------------------------------------------------------
// decision 2026-09-07T12:00:05Z; the 1m track is retrieved (and the split falls) at 17:00Z; the archive that carries
// it was created at 18:00Z; the dataset as-of is the next day at 12:00Z. Every horizon of that decision therefore
// ENDS long before Cobra could read any of it: the honest as-of-trainable count at the split is ZERO.
const ASOF = T0 + 86_400_000;          // 2026-09-08T12:00:00Z
const SPLIT = T0 + 5 * 3_600_000;      // 2026-09-07T17:00:00Z
const CREATED = T0 + 6 * 3_600_000;    // 2026-09-07T18:00:00Z
async function appendixA() {
  const fx = await journalFixture({ coins: ['ZQQ7'], shadow: false });
  const F = selectResearchRows(projectEventList(fx.events).records, { asOfTs: ASOF }).rows.find((r) => r.cohort === 'PRIMARY');
  const raw = { symbol: 'ZQQ7', intervalMin: 1, retrievedTs: iso(SPLIT), retrievedSec: SPLIT / 1000, candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 18_000 }) };
  const archive = { archiveCreatedTsMs: CREATED, oneMinute: new Map([['ZQQ7', validateCandleSeriesRow(raw, { intervalMin: 1 })]]) };
  const L = labelRow(F, { archive, asOfTs: ASOF });
  return { fx, F, L, archive };
}
const evalOf = (f, l) => evaluateDataset({ featureRows: [f], outcomeRows: [l], asOfTs: ASOF, splitAtTs: SPLIT }).evaluation;

// ---- A (R1, F1) ----------------------------------------------------------------------------------------------
test('A (R1/F1). a horizon knowledge floor may not precede its own REFERENCE floor: backdating every floor to the horizon end is refused semantically, and the honest as-of-trainable count stays ZERO', async () => {
  const { F, L } = await appendixA();
  assert.equal(validateFeatureRow(F), null); assert.equal(validateOutcomeRow(L), null);
  assert.equal(L.reference.knownAtTs, CREATED, 'the reference bar closes at the anchor but is learnable only through the archive');
  assert.equal(L.horizons['240m'].outcomeKnownAtTs, CREATED, 'so is every horizon that ended before the archive existed');
  assert.equal(evalOf(F, L).learnability.horizons['240m'].discoveryTrainableAtSplit, 0, 'nothing here was learnable at the split — and this stays zero');
  // THE DELIVERED DEFECT: cloning the outcome and setting every floor to its horizon end (the reference clock and
  // every value untouched) made the 240m count ONE. The repair REJECTS the row; it does not accept a count of one.
  const backdated = structuredClone(L);
  for (const h of Object.keys(backdated.horizons)) backdated.horizons[h].outcomeKnownAtTs = backdated.horizons[h].horizonEndTs;
  assert.match(validateOutcomeRow(backdated), /knowledge floor precedes its own reference floor/);
  assert.equal(await codeOf(async () => evaluateDataset({ featureRows: [F], outcomeRows: [backdated], asOfTs: ASOF, splitAtTs: SPLIT })), 'CORRUPT_INPUT');
  // a floor that still precedes its own horizon END remains refused by the older law too
  const tooEarly = structuredClone(L); tooEarly.horizons['240m'].outcomeKnownAtTs = tooEarly.horizons['240m'].horizonEndTs - 1;
  assert.match(validateOutcomeRow(tooEarly), /knowledge floor precedes the horizon end/);
  // and the lawful row is untouched by the new clause: equality with the reference floor is allowed
  assert.ok(L.horizons['60m'].outcomeKnownAtTs >= L.reference.knownAtTs);
});

// ---- B (R2, F1) ----------------------------------------------------------------------------------------------
test('B (R2/F1). NESTED input clocks obey the same law as the row clocks: a trigger, claim, coverage check, notice or dependency node known AFTER the decision it fed is refused, and an observation may not follow the knowledge it belongs to', async () => {
  const { F, L } = await appendixA();
  // THE DELIVERED DEFECT: arrays.notices[0].knownAtTs = asOf + 1000 validated and evaluated.
  const future = structuredClone(F); future.arrays.notices[0].knownAtTs = ASOF + 1000;
  assert.match(validateFeatureRow(future), /notices\[0\]\.knownAtTs is known after the derivation it fed/);
  assert.equal(await codeOf(async () => evaluateDataset({ featureRows: [future], outcomeRows: [L], asOfTs: ASOF, splitAtTs: SPLIT })), 'CORRUPT_INPUT');
  // NOT notices-only: the authoritative dependency / trigger / claim / coverage relationships are covered too
  const t = structuredClone(F); t.arrays.triggers[0].knownAtTs = F.decisionKnownAtTs + 1;
  assert.match(validateFeatureRow(t), /triggers\[0\]\.knownAtTs is known after the derivation it fed/);
  const d = structuredClone(F); d.arrays.dependencyNodes[0].knownAtTs = F.decisionKnownAtTs + 1;
  assert.match(validateFeatureRow(d), /dependencyNodes\[0\]\.knownAtTs is known after the derivation it fed/);
  const cp = structuredClone(F); if (cp.arrays.coverageProviders.length) { cp.arrays.coverageProviders[0].checkedTs = F.decisionKnownAtTs + 1; assert.match(validateFeatureRow(cp), /coverageProviders\[0\]\.checkedTs is known after the derivation it fed/); }
  // an observation clock may never follow the knowledge clock it belongs to
  const obs = structuredClone(F); obs.arrays.notices[0].observedTs = obs.arrays.notices[0].knownAtTs + 1;
  assert.match(validateFeatureRow(obs), /notices\[0\]\.observedTs follows notices\[0\]\.knownAtTs/);
  const tr = structuredClone(F); tr.arrays.triggers[0].observedTs = tr.arrays.triggers[0].knownAtTs + 1;
  assert.match(validateFeatureRow(tr), /triggers\[0\]\.observedTs follows triggers\[0\]\.knownAtTs/);
  // the law is DECLARED over real catalogued members, not invented field names
  for (const [name, law] of Object.entries(ARRAY_CLOCK_LAW)) {
    const keys = Object.keys(ARRAY_CATALOGUE[name].keys);
    for (const k of law.known) assert.ok(keys.includes(k), `${name}.${k} is a catalogued member key`);
    for (const [a, b] of law.observedBeforeKnown) { assert.ok(keys.includes(a)); assert.ok(keys.includes(b)); }
  }
  // a null / absent optional clock is not a violation, and the shared validator refuses a derivation clock it cannot trust
  assert.equal(arrayClockError({ triggers: [{ kind: 'PARTICIPATION_LED', ref: 'r', knownAtTs: 10, observedTs: null }] }, 10), null);
  assert.match(arrayClockError({}, 0), /a derivation clock is required/);
});

// ---- C (R3, F2) ----------------------------------------------------------------------------------------------
test('C (R3/F2). OPTIONALITY IS NOT NULLABILITY: a catalogued REQUIRED leaf can never be omitted nor moved into the absence map, an absence marker must be one of the lawful two, and the absence map carries no undeclared name', async () => {
  const { F } = await appendixA();
  // THE DELIVERED DEFECT: deleting a required leaf and declaring it NOT_RECORDED validated and evaluated.
  const moved = structuredClone(F); delete moved.features['dependencies.truncated']; moved.absentFeatures['dependencies.truncated'] = 'NOT_RECORDED';
  assert.match(validateFeatureRow(moved), /dependencies\.truncated is a required leaf and can never be declared absent/);
  assert.equal(await codeOf(async () => evaluateDataset({ featureRows: [moved], outcomeRows: [await appendixA().then((x) => x.L)], asOfTs: ASOF, splitAtTs: SPLIT })), 'CORRUPT_INPUT');
  // omitting it entirely stays refused by the present-xor-absent law
  const gone = structuredClone(F); delete gone.features['dependencies.truncated'];
  assert.match(validateFeatureRow(gone), /must be present xor absent/);
  // an OPTIONAL leaf may be absent — under a LAWFUL marker only
  const optional = FEATURE_CATALOGUE.find((s) => s.optional && s.name in F.absentFeatures);
  assert.ok(optional, 'the projection actually carries an optional-and-absent leaf');
  const badMarker = structuredClone(F); badMarker.absentFeatures[optional.name] = 'BECAUSE_I_SAID_SO';
  assert.match(validateFeatureRow(badMarker), new RegExp(`${optional.name.replace(/\./g, '\\.')} carries an unlawful absence marker`));
  const undeclared = structuredClone(F); undeclared.absentFeatures['dossier.notARealLeaf'] = 'NOT_RECORDED';
  assert.match(validateFeatureRow(undeclared), /undeclared absent feature dossier\.notARealLeaf/);
  assert.deepEqual([...ABSENCE_VALUES], ['NOT_RECORDED', 'SHADOW_ROW_NO_SOCIAL_DEPENDENCY']);
  // and the projected entrances must be the row's own entrances — no repeats, no divergent copy
  const dup = structuredClone(F); dup.entrances = [...dup.entrances, dup.entrances[0]];
  assert.match(validateFeatureRow(dup), /entrances repeat/);
  const diverged = structuredClone(F); diverged.arrays.entrances = ['INFORMATION_LED'];
  assert.match(validateFeatureRow(diverged), /projected entrances disagree with the row entrances/);
});

// ---- D (R4, F2) ----------------------------------------------------------------------------------------------
test('D (R4/F2). a projected member must be a value the AUTHORITATIVE upstream vocabulary defines, not merely an uppercase-shaped token', async () => {
  const { F } = await appendixA();
  // THE DELIVERED DEFECT: dependencyNodes[0].kind = 'MADE_UP_KIND' validated because the shape was 'code'.
  const fake = structuredClone(F); fake.arrays.dependencyNodes[0].kind = 'MADE_UP_KIND';
  assert.match(validateFeatureRow(fake), /dependencyNodes\[0\]\.kind unsupported/);
  const trig = structuredClone(F); trig.arrays.triggers[0].kind = 'RUMOUR_LED';
  assert.match(validateFeatureRow(trig), /triggers\[0\]\.kind unsupported/);
  const cs = structuredClone(F); cs.arrays.crossSense = ['INVENTED_DESCRIPTOR'];
  assert.match(validateFeatureRow(cs), /crossSense\[0\] is not a value of its authoritative vocabulary/);
  const pk = structuredClone(F); pk.arrays.proposalKinds = ['DO_A_TRADE'];
  assert.match(validateFeatureRow(pk), /proposalKinds\[0\] is not a value of its authoritative vocabulary/);
  const prc = structuredClone(F); prc.arrays.packetReasonCodes = ['BECAUSE'];
  assert.match(validateFeatureRow(prc), /packetReasonCodes\[0\] is not a value of its authoritative vocabulary/);
  // the bindings are the IMPORTED upstream lists, never a local restatement
  const { RESEARCH_ENTRANCE_KINDS, RESEARCH_CROSS_SENSE, RESEARCH_PROPOSAL_KINDS, RESEARCH_PACKET_REASON_CODES, RESEARCH_DEPENDENCY_NODE_KINDS, RESEARCH_DEPENDENCY_RELATIONS } = await import('../rumor2/social-research-dossier.js');
  assert.equal(ARRAY_CATALOGUE.dependencyNodes.keys.kind, RESEARCH_DEPENDENCY_NODE_KINDS);
  assert.equal(ARRAY_CATALOGUE.dependencyEdges.keys.relation, RESEARCH_DEPENDENCY_RELATIONS);
  assert.equal(ARRAY_CATALOGUE.triggers.keys.kind, RESEARCH_ENTRANCE_KINDS);
  assert.equal(ARRAY_CATALOGUE.crossSense.element, RESEARCH_CROSS_SENSE);
  assert.equal(ARRAY_CATALOGUE.proposalKinds.element, RESEARCH_PROPOSAL_KINDS);
  assert.equal(ARRAY_CATALOGUE.packetReasonCodes.element, RESEARCH_PACKET_REASON_CODES);
  assert.equal(ARRAY_CATALOGUE.entrances.values, RESEARCH_ENTRANCE_KINDS);
});

// ---- E (R5, F2) ----------------------------------------------------------------------------------------------
test('E (R5/F2). an outcome verdict is a CLOSED object: an extra field beside a recognized state and reason is refused, not carried through', async () => {
  const { F, L } = await appendixA();
  // THE DELIVERED DEFECT: availability.text = '<raw content>' validated and evaluated.
  const open = structuredClone(L); open.availability.text = 'AUDIT_RAW_CONTENT_SENTINEL';
  assert.match(validateOutcomeRow(open), /availability malformed/);
  assert.equal(await codeOf(async () => evaluateDataset({ featureRows: [F], outcomeRows: [open], asOfTs: ASOF, splitAtTs: SPLIT })), 'CORRUPT_INPUT');
  const missing = structuredClone(L); delete missing.availability.reason;
  assert.match(validateOutcomeRow(missing), /availability malformed/);
  // the reference and every horizon were already closed and stay closed
  const ref = structuredClone(L); ref.reference.note = 'x';
  assert.match(validateOutcomeRow(ref), /reference malformed/);
  const hz = structuredClone(L); hz.horizons['60m'].detail = 'x';
  assert.match(validateOutcomeRow(hz), /horizon 60m undeclared key 'detail'/);
});

// ---- F (R6, F2/F4) -------------------------------------------------------------------------------------------
test('F (R6/F2+F4). PUBLICATION PROOF: a manifest is sealed only under the reader\'s own bundle law — the publisher cannot seal a correctly checksummed row its own validator rejects — and the whole bundle (member list, recomputed census, evaluation/report agreement) is law at both boundaries', async () => {
  const W = work();
  // THE DELIVERED DEFECT: a JSONL feature row carrying a dependency-node `text` field sealed cleanly.
  const { F } = await appendixA();
  const res = reserveOutputDir(prepareOutputTarget(path.join(W, 'seal')));
  const w = jsonlWriter(res, 'features.jsonl'); const bad = structuredClone(F); bad.arrays.dependencyNodes[0].text = 'AUDIT_RAW_CONTENT_SENTINEL'; w.write(bad); const o = w.close();
  assert.match(validateFeatureRow(bad), /free-text \/ raw-content leaf and can never be exported/);
  assert.equal(await codeOf(async () => publishManifest(res, 'm.json', { outputs: { 'features.jsonl': o } }, { outputs: { 'features.jsonl': o } })), 'INTERNAL_FAILURE', 'a manifest may not be sealed under no law at all');
  assert.ok(!existsSync(path.join(res.dir, 'm.json')));
  assert.equal(await codeOf(async () => publishManifest(res, 'm.json', { outputs: { 'features.jsonl': o } }, { outputs: { 'features.jsonl': o }, bundle: (d) => datasetBundle(d, { version: 'x' }, {}) })), 'CORRUPT_INPUT', 'and never over a bundle its own reader refuses');
  assert.ok(!existsSync(path.join(res.dir, 'm.json')));

  // a LAWFUL end-to-end bundle, then each member of the whole-bundle law broken in turn
  const fx = await journalFixture({ coins: ['ZQQ7'], shadow: false });
  const snap = await runSnapshot({ events: fx.events, out: path.join(W, 'snap') });
  writeChildhoodArchive(path.join(W, 'arch'), { series: [{ symbol: 'ZQQ7', candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 18_000 }) }], archiveCreatedTs: iso(CREATED), retrievedSec: SPLIT / 1000 });
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'ds') });
  const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: SPLIT, out: path.join(W, 'ev') });
  assert.equal(readSnapshotDir(snap.dir).records.length, snap.manifest.counts.selectedRecords);
  assert.equal(readDatasetDir(ds.dir).featureRows.length, ds.manifest.counts.rows);
  assert.equal(readEvaluationDir(ev.dir).report, ev.report);

  const reseal = (src, name, mutate) => {
    const dst = path.join(W, name); mkdirSync(dst); for (const f of readdirSync(src)) writeFileSync(path.join(dst, f), readFileSync(path.join(src, f)));
    const mn = readdirSync(dst).find((f) => f.endsWith('.manifest.json'));
    const m = JSON.parse(readFileSync(path.join(dst, mn), 'utf8')); mutate(dst, m);
    for (const n of Object.keys(m.outputs)) { const buf = readFileSync(path.join(dst, n)); m.outputs[n].sha256 = sha256Hex(buf); m.outputs[n].bytes = buf.length; if (typeof m.outputs[n].lines === 'number') m.outputs[n].lines = buf.toString('utf8').split('\n').filter(Boolean).length; }
    writeFileSync(path.join(dst, mn), JSON.stringify(m, null, 1) + '\n'); return dst;
  };
  // an OMITTED member is corruption, not a smaller artifact — even with every remaining checksum correct
  const dropped = reseal(ds.dir, 'ds-dropped', (d, m) => { delete m.outputs['coverage.json']; });
  assert.match(await msgOf(async () => readDatasetDir(dropped)), /but this artifact requires/);
  // a WRONG coverage / census count is refused even when it is internally consistent with the manifest
  const miscensus = reseal(ds.dir, 'ds-census', (d, m) => {
    const cov = JSON.parse(readFileSync(path.join(d, 'coverage.json'), 'utf8'));
    cov.census.rowAvailability.AVAILABLE += 1; m.census = cov.census;
    writeFileSync(path.join(d, 'coverage.json'), JSON.stringify(cov, null, 1) + '\n');
  });
  assert.match(await msgOf(async () => readDatasetDir(miscensus)), /census rowAvailability disagrees with the outcome rows it summarizes/);
  const misanchor = reseal(ds.dir, 'ds-anchor', (d, m) => {
    const cov = JSON.parse(readFileSync(path.join(d, 'coverage.json'), 'utf8'));
    cov.census.overlap.rowCoins += 7; m.census = cov.census;
    writeFileSync(path.join(d, 'coverage.json'), JSON.stringify(cov, null, 1) + '\n');
  });
  assert.match(await msgOf(async () => readDatasetDir(misanchor)), /row assets but the sealed rows carry/);
  // an evaluation whose clocks disagree with its manifest, and a report that is not its own rendering
  const mismatched = reseal(ev.dir, 'ev-clock', (d) => {
    const e = JSON.parse(readFileSync(path.join(d, 'evaluation.json'), 'utf8')); e.splitAtTs -= 60_000;
    writeFileSync(path.join(d, 'evaluation.json'), JSON.stringify(e, null, 1) + '\n');
  });
  assert.match(await msgOf(async () => readEvaluationDir(mismatched)), /clocks disagree with its manifest/);
  const rewritten = reseal(ev.dir, 'ev-report', (d) => { writeFileSync(path.join(d, 'report.txt'), 'PROFITABLE STRATEGY CONFIRMED\n'); });
  assert.match(await msgOf(async () => readEvaluationDir(rewritten)), /report\.txt is not the rendering of the evaluation sealed beside it/);
  // and an UNLAWFUL row inside an otherwise perfect dataset is refused on reopening
  const poisoned = reseal(ds.dir, 'ds-poison', (d) => {
    const lines = readFileSync(path.join(d, 'features.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => {
      const r = JSON.parse(l); if (r.cohort === 'PRIMARY') r.arrays.notices[0].knownAtTs = ASOF + 1000; return JSON.stringify(r);
    });
    writeFileSync(path.join(d, 'features.jsonl'), lines.join('\n') + '\n');
  });
  assert.equal(await codeOf(async () => readDatasetDir(poisoned)), 'CORRUPT_INPUT');
});

// ---- G (R7, F5) ----------------------------------------------------------------------------------------------
test('G (R7/F5). ABSENT provenance and MALFORMED provenance are different facts: a supplied non-instant archiveCreatedTs is corrupt input, while a null / omitted one stays an explicit unavailable-coverage limitation', async () => {
  const W = work();
  const bars = [{ symbol: 'ZQQ7', candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 3600 }) }];
  // THE DELIVERED DEFECT: 'not-a-clock' became PROVENANCE_CLOCK_MISSING, indistinguishable from no clock at all.
  // (This alone does NOT demonstrate numerical leakage — labels stay OUTCOME_UNAVAILABLE either way. What it hides
  //  is a corrupt archive presented as an honest coverage gap.)
  for (const garbage of ['not-a-clock', '2026-09-07 12:00:00', '2026-09-07T12:00:00+02:00', 1788782400000, {}]) {
    writeChildhoodArchive(path.join(W, `g-${sha256Hex(String(JSON.stringify(garbage))).slice(0, 8)}`), { series: bars, archiveCreatedTs: garbage, retrievedSec: SEC(T0) + 3600 });
    const dir = path.join(W, `g-${sha256Hex(String(JSON.stringify(garbage))).slice(0, 8)}`);
    assert.equal(await codeOf(async () => readChildhoodArchive(dir)), 'CORRUPT_INPUT', `${JSON.stringify(garbage)} is not a lawful UTC instant`);
    assert.match(await msgOf(async () => readChildhoodArchive(dir)), /supplies an archiveCreatedTs that is not a lawful UTC instant/);
  }
  writeChildhoodArchive(path.join(W, 'null'), { series: bars, archiveCreatedTs: null, retrievedSec: SEC(T0) + 3600 });
  const nulled = readChildhoodArchive(path.join(W, 'null'));
  assert.equal(nulled.archiveCreatedTsMs, null); assert.ok(nulled.limitations.includes('PROVENANCE_CLOCK_MISSING'));
  writeChildhoodArchive(path.join(W, 'omitted'), { series: bars, retrievedSec: SEC(T0) + 3600 });
  const omitted = readChildhoodArchive(path.join(W, 'omitted'));
  assert.equal(omitted.archiveCreatedTsMs, null); assert.ok(omitted.limitations.includes('PROVENANCE_CLOCK_MISSING'));
  assert.equal(labelRow({ rowId: 'r', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: omitted, asOfTs: ASOF }).availability.reason, 'PROVENANCE_CLOCK_MISSING');
  // a lawful clock still reads
  writeChildhoodArchive(path.join(W, 'ok'), { series: bars, archiveCreatedTs: iso(CREATED), retrievedSec: SEC(T0) + 3600 });
  assert.equal(readChildhoodArchive(path.join(W, 'ok')).archiveCreatedTsMs, CREATED);
});

// ---- H (R8, F6) ----------------------------------------------------------------------------------------------
test('H (R8/F6). UNKNOWN source cleanliness is its own state: a commit label alone never proves the closure matches it, and the real codeIdentity status-failure branch reports SOURCE_CLEANLINESS_UNKNOWN rather than claiming committed source', () => {
  // THE DELIVERED DEFECT: identityLaw({ gitCommit: <valid SHA>, gitSourceDirty: null }) returned
  // PRODUCED_BY_COMMITTED_SOURCE — an unanswered cleanliness check was read as a clean one.
  assert.equal(identityLaw({ gitCommit: 'a'.repeat(40), gitSourceDirty: null }), 'SOURCE_CLEANLINESS_UNKNOWN');
  assert.equal(identityLaw({ gitCommit: 'a'.repeat(40), gitSourceDirty: false }), 'PRODUCED_BY_COMMITTED_SOURCE');
  assert.equal(identityLaw({ gitCommit: 'a'.repeat(40), gitSourceDirty: true }), 'PRODUCED_BY_UNCOMMITTED_SOURCE');
  assert.equal(identityLaw({ gitCommit: null, gitSourceDirty: true }), 'PRODUCED_BY_UNCOMMITTED_SOURCE', 'a dirty closure outranks the absence of a commit too');
  assert.equal(identityLaw({ gitCommit: null, gitSourceDirty: null }), 'NO_GIT_CHECKOUT');
  assert.ok(IDENTITY_LAWS.includes('SOURCE_CLEANLINESS_UNKNOWN'));

  // THE ACTUAL BRANCH, under a controlled fixture: a `git` on PATH that answers rev-parse and FAILS status. The
  // repository itself is never touched — only this process's PATH, restored immediately.
  const W = work(); const shim = path.join(W, 'bin'); mkdirSync(shim);
  writeFileSync(path.join(shim, 'git'), `#!/bin/sh\ncase "$1" in\n  rev-parse) echo ${'a'.repeat(40)} ;;\n  *) exit 3 ;;\nesac\n`);
  chmodSync(path.join(shim, 'git'), 0o755);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = shim;
    const id = codeIdentity();
    assert.equal(id.gitCommit, 'a'.repeat(40), 'the commit label was answered');
    assert.equal(id.gitSourceDirty, null, 'but the cleanliness check was not');
    assert.equal(id.law, 'SOURCE_CLEANLINESS_UNKNOWN', 'so the artifact says so rather than claiming committed source');
    assert.match(id.sourceTreeSha256, /^[0-9a-f]{64}$/);
    // and with no git at all, the honest answer is NO_GIT_CHECKOUT
    process.env.PATH = path.join(W, 'empty');
    const none = codeIdentity();
    assert.equal(none.gitCommit, null); assert.equal(none.law, 'NO_GIT_CHECKOUT');
    assert.equal(none.sourceTreeSha256, id.sourceTreeSha256, 'the source digest never depends on git being reachable');
  } finally { process.env.PATH = savedPath; }
  const real = codeIdentity();
  assert.ok(IDENTITY_LAWS.includes(real.law), 'the live checkout reports one of the four declared laws');
});

// ---- I (§4). incremental artifact reads ----------------------------------------------------------------------
test('I (§4). JSONL is consumed in bounded chunks with an incomplete-line buffer: records spanning chunk boundaries and multi-byte UTF-8 split by a chunk edge read correctly, the per-line and cumulative bounds still hold, a blank line inside the file is corruption, and an early break leaves no open handle', () => {
  const W = work(); const res = reserveOutputDir(prepareOutputTarget(path.join(W, 'jsonl')));
  // several megabytes of records: more than one chunk, with a multi-byte character positioned across the boundary
  const w = jsonlWriter(res, 'rows.jsonl');
  const pad = 'é'.repeat(1000); // two bytes per character — a chunk edge WILL fall inside one of them
  const n = Math.ceil((JSONL_CHUNK_BYTES * 2.5) / 2100);
  for (let i = 0; i < n; i += 1) w.write({ i, pad });
  const o = w.close();
  assert.ok(o.bytes > JSONL_CHUNK_BYTES * 2, 'the fixture actually spans several chunks');
  let count = 0; for (const r of readJsonlStrict(path.join(res.dir, 'rows.jsonl'))) { assert.equal(r.i, count); assert.equal(r.pad, pad); count += 1; }
  assert.equal(count, n, 'every record survives the chunk boundaries intact');
  // an early break runs the generator's finally and closes the descriptor: reading again still works
  for (const r of readJsonlStrict(path.join(res.dir, 'rows.jsonl'))) { void r; break; }
  let again = 0; for (const r of readJsonlStrict(path.join(res.dir, 'rows.jsonl'))) { void r; again += 1; }
  assert.equal(again, n);
  // the same bounds the writer enforces are enforced on the way back in
  const file = path.join(res.dir, 'rows.jsonl');
  assert.equal(codeOfSync(() => { for (const r of readJsonlStrict(file, { limits: { ...LIMITS, maxJsonlLineBytes: 100 } })) void r; }), 'RESOURCE_LIMIT_EXCEEDED');
  assert.equal(codeOfSync(() => { for (const r of readJsonlStrict(file, { limits: { ...LIMITS, maxInputFileBytes: 1000 } })) void r; }), 'RESOURCE_LIMIT_EXCEEDED');
  // a blank line INSIDE the file is corruption; a single trailing newline is the terminator
  writeFileSync(path.join(res.dir, 'gap.jsonl'), '{"a":1}\n\n{"a":2}\n');
  assert.equal(codeOfSync(() => { for (const r of readJsonlStrict(path.join(res.dir, 'gap.jsonl'))) void r; }), 'CORRUPT_INPUT');
  writeFileSync(path.join(res.dir, 'tail.jsonl'), '{"a":1}\n{"a":2}\n');
  assert.equal([...readJsonlStrict(path.join(res.dir, 'tail.jsonl'))].length, 2);
  writeFileSync(path.join(res.dir, 'nonl.jsonl'), '{"a":1}\n{"a":2}');
  assert.equal([...readJsonlStrict(path.join(res.dir, 'nonl.jsonl'))].length, 2, 'a final record without a trailing newline is still a record');
  writeFileSync(path.join(res.dir, 'empty.jsonl'), '');
  assert.equal([...readJsonlStrict(path.join(res.dir, 'empty.jsonl'))].length, 0);
  writeFileSync(path.join(res.dir, 'scalar.jsonl'), '"just a string"\n');
  assert.equal(codeOfSync(() => { for (const r of readJsonlStrict(path.join(res.dir, 'scalar.jsonl'))) void r; }), 'CORRUPT_INPUT');
  assert.equal(codeOfSync(() => { for (const r of readJsonlStrict(path.join(res.dir, 'nope.jsonl'))) void r; }), 'CORRUPT_INPUT');
});
function codeOfSync(fn) { try { fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } }
