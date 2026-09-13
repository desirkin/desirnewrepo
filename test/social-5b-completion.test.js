// SOCIAL-5B EXISTING-CONTRACT COMPLETION — the regression matrix (M01 .. M09) for C1 .. C9.
//
// Every test states the DELIVERED DEFECT it closes: each construction below was ACCEPTED by the pipeline at baseline
// 32e074f on unchanged production code. Negative fixtures always start from a lawful positive produced by the real
// production seam, mutate ONE intended relationship, and re-seal their own integrity metadata in TEST CODE so that
// the semantic law — not an incidental checksum failure — is what rejects them. The repaired production publisher is
// never used to construct a corrupt completed artifact and is never weakened to make a fixture.
//
// Offline only: an in-memory journal fixture, synthetic Childhood archives in temp directories, and controlled I/O
// seams. No network, no database, no provider, no config read, no git mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../rumor2/truth.js';
import { LIMITS, ResearchError, sha256Hex, isoOf, exactKeys, safeType, DERIVATION_INPUT_LEAF_CLOCKS, LABEL_HORIZONS_MIN, ENTRANCE_LABELS, ARRAY_CATALOGUE } from '../research/contracts.js';
import { projectEventList, validateSnapshotRecord } from '../research/snapshot.js';
import { selectResearchRows, validateFeatureRow, featureRowIdentity } from '../research/features.js';
import { validateCandleSeriesRow, readChildhoodArchive } from '../research/archive.js';
import { labelRow, validateOutcomeRow, outcomeContextError, archiveContextError, rowAvailabilityOf } from '../research/outcomes.js';
import { evaluateDataset, datasetJoinError, renderReport, splitOfGroup } from '../research/evaluation.js';
import { evaluationPayloadError, datasetManifestError, coverageReportError, codeIdentityError, consumedFilesError, entranceCompositeOk, providerContextOk } from '../research/schemas.js';
import { dependencyGraphError } from '../research/relations.js';
import { archiveContextOf, datasetBundle } from '../research/bundle.js';
import { RESEARCH_STATES, RESEARCH_SOCIAL_COVERAGE_STATES } from '../rumor2/social-research-dossier.js';
import { shadowRowRank } from '../rumor2/social-research-shadow.js';
import { runSnapshot, runBuild, runEvaluate, readSnapshotDir, readDatasetDir, readEvaluationDir, codeIdentity } from '../research/pipeline.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, publishManifest, readJsonlStrict, consumeJsonl, verifyOutputs, writeAll, JSONL_CHUNK_BYTES } from '../research/artifacts.js';
import { journalFixture, writeChildhoodArchive, linearBars, legacyDossierEventFrom, T0, SEC } from './helpers/social-5b.js';
import { obsEvent, observed, notice } from './helpers/social-7.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-research-dossier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = []; const work = () => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5bx-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } };
const msgOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.researchMessage ?? String(e.message); } };
const codeOfSync = (fn) => { try { fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } };

// ---- THE APPENDIX A CLOCKS ------------------------------------------------------------------------------------
const ASOF = T0 + 86_400_000;        // Q  2026-09-08T12:00:00Z — the frozen dataset as-of
const SPLIT = T0 + 5 * 3_600_000;    // B  2026-09-07T17:00:00Z — retrieval and the chosen split
const CREATED = T0 + 6 * 3_600_000;  // C  2026-09-07T18:00:00Z — when the archive came into existence
const BARS = () => linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 18_000 });

async function pureFixture() {
  const fx = await journalFixture({ coins: ['ZQQ7'], shadow: false });
  const F = selectResearchRows(projectEventList(fx.events).records, { asOfTs: ASOF }).rows[0];
  const raw = { symbol: 'ZQQ7', intervalMin: 1, retrievedTs: isoOf(SPLIT), retrievedSec: SPLIT / 1000, candles: BARS() };
  const archive = { archiveCreatedTsMs: CREATED, oneMinute: new Map([['ZQQ7', validateCandleSeriesRow(raw, { intervalMin: 1 })]]) };
  return { fx, F, L: labelRow(F, { archive, asOfTs: ASOF }), archive };
}
// a complete lawful SAVED artifact chain through the real production commands
async function savedChain(W, { name = 'a', coins = ['ZQQ7'], shadow = true, childhood = true, createdMs = CREATED, extraEvents = [], split = SPLIT } = {}) {
  const fx = await journalFixture({ coins, shadow });
  const events = [...fx.events, ...extraEvents];
  const snap = await runSnapshot({ events, out: path.join(W, `${name}-snap`) });
  let arch = null;
  if (childhood) { arch = path.join(W, `${name}-arch`); writeChildhoodArchive(arch, { series: coins.map((c) => ({ symbol: c, candles: BARS() })), archiveCreatedTs: isoOf(createdMs), retrievedSec: SPLIT / 1000 }); }
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: arch, asOfTs: ASOF, out: path.join(W, `${name}-ds`) });
  const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: split, out: path.join(W, `${name}-ev`) });
  return { fx, snap, ds, ev, archiveDir: arch };
}
// copy a completed artifact, mutate it, and RESEAL its integrity fields in TEST CODE ONLY
function reseal(W, src, name, mutate) {
  const dst = path.join(W, name); mkdirSync(dst);
  for (const f of readdirSync(src)) writeFileSync(path.join(dst, f), readFileSync(path.join(src, f)));
  const mn = readdirSync(dst).find((f) => f.endsWith('.manifest.json'));
  const m = JSON.parse(readFileSync(path.join(dst, mn), 'utf8'));
  mutate(dst, m);
  for (const n of Object.keys(m.outputs ?? {})) {
    const buf = readFileSync(path.join(dst, n));
    m.outputs[n].sha256 = sha256Hex(buf); m.outputs[n].bytes = buf.length;
    if (typeof m.outputs[n].lines === 'number') m.outputs[n].lines = buf.toString('utf8').split('\n').filter(Boolean).length;
  }
  writeFileSync(path.join(dst, mn), JSON.stringify(m, null, 1) + '\n');
  return dst;
}
const rewriteJsonl = (d, name, fn) => { const rows = readFileSync(path.join(d, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); const out = rows.map((r) => fn(r) ?? r); writeFileSync(path.join(d, name), out.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

// ================================================================================================================
test('M01. the lawful chain: snapshot -> build -> evaluate and back, with dotted PRIMARY and SHADOW assets, a valid legacy lineage, and every honest unavailable / partial case preserved', async () => {
  const W = work();
  const { snap, ds, ev } = await savedChain(W, { name: 'ok', coins: ['A.B', 'ZQQ7'] });
  const rs = readSnapshotDir(snap.dir); const rd = readDatasetDir(ds.dir); const re = readEvaluationDir(ev.dir);
  assert.equal(rs.records.length, snap.manifest.counts.selectedRecords);
  assert.ok(rd.featureRows.some((r) => r.cohort === 'PRIMARY' && r.canonicalCoin === 'A.B'), 'a dotted PRIMARY asset round-trips every boundary');
  assert.ok(rd.featureRows.some((r) => r.cohort === 'SHADOW'), 'and the shadow cohort survives beside it');
  assert.equal(re.report, ev.report); assert.equal(canonicalJson(re.evaluation), canonicalJson(ev.evaluation));
  assert.equal(evaluationPayloadError(ev.evaluation), null, 'the real evaluator produces a payload its own validator accepts');
  assert.deepEqual(rd.archiveContext, { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols: ['A.B', 'ZQQ7'] });
  // a dataset built with NO archive is a different, lawful fact
  const bare = await savedChain(W, { name: 'bare', childhood: false });
  const rb = readDatasetDir(bare.ds.dir);
  assert.deepEqual(rb.archiveContext, { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: null });
  assert.equal(rb.manifest.inputs.childhood, null, 'the lawful null is recorded explicitly, beside a present snapshot input');
  assert.ok(rb.manifest.inputs.snapshot.manifestSha256, 'the snapshot provenance is still there');
  assert.ok(rb.coverage.state.reasons.includes('CHILDHOOD_ARCHIVE_NOT_SUPPLIED'));
  assert.ok(rb.outcomeRows.every((o) => o.availability.reason === 'ARCHIVE_ABSENT'));
  // a VALID legacy dossier opens a lawful NEW_AFTER_LEGACY episode and is inventoried, never converted
  const seed = await journalFixture({ coins: ['ZQQ7'], shadow: false });
  const legacy = legacyDossierEventFrom(seed.dossiers[0]);
  const arr = [...seed.events.filter((e) => e.type !== RESEARCH_DOSSIER_EVENT_TYPE), legacy];
  const rt = createResearchStrainer({ now: () => T0 + 500_000 });
  assert.equal(rt.hydrate(arr).ok, true);
  const o = obsEvent({ id: 'nl1', author: 'did:plc:next', text: '$ZQQ7 after the legacy record', nowMs: T0 + 400_000 }); arr.push(o); rt.ingest([o]);
  const r = await rt.tick({ knownAtTs: T0 + 500_000, providerStates: observed(T0 + 500_000), fenceHeld: () => true, append: (evs) => { arr.push(...evs); return { ok: true, lastSeq: arr.length }; }, notices: [notice('ZQQ7', T0 + 450_000)] });
  assert.equal(r.ok, true);
  const withLegacy = await runSnapshot({ events: arr, out: path.join(W, 'legacy-snap') });
  assert.equal(withLegacy.manifest.counts.dossierLegacy, 1, 'the legacy dossier is inventoried, never converted');
  const lr = readSnapshotDir(withLegacy.dir).records.filter((x) => x.recordKind === 'RESEARCH_DOSSIER_V2');
  assert.equal(lr.length, 1); assert.equal(lr[0].episodeBasis, 'NEW_AFTER_LEGACY', 'and a legacy predecessor lawfully opens the next episode through the saved artifact');
});

// ================================================================================================================
test('M02 (C1/C6). the CONTEXTUAL archive floor: backdating the reference AND every horizon together — leaving all archive provenance untouched — is refused at publication, at reopening and at evaluate, and the honest as-of-trainable count stays ZERO', async () => {
  const W = work();
  const { F, L } = await pureFixture();
  assert.equal(validateFeatureRow(F), null); assert.equal(validateOutcomeRow(L), null);
  assert.equal(L.reference.knownAtTs, CREATED); assert.equal(L.horizons['240m'].outcomeKnownAtTs, CREATED);
  const honest = evaluateDataset({ featureRows: [F], outcomeRows: [L], asOfTs: ASOF, splitAtTs: SPLIT }).evaluation;
  assert.equal(honest.learnability.horizons['240m'].discoveryTrainableAtSplit, 0, 'nothing was learnable at the split — and this stays zero');

  // THE DELIVERED DEFECT: both clocks backdated together satisfied every row-local law, and the count became ONE.
  const forged = structuredClone(L);
  forged.reference.knownAtTs = forged.anchorTsMs;
  for (const h of Object.values(forged.horizons)) h.outcomeKnownAtTs = h.horizonEndTs;
  assert.equal(validateOutcomeRow(forged), null, 'the forgery is row-locally lawful — which is exactly why row-local law could not catch it');
  const ctx = { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols: ['ZQQ7'] };
  assert.match(outcomeContextError(forged, ctx), /reference knowledge floor .* is not max\(anchor, archive creation/);
  assert.match(datasetJoinError({ featureRows: [F], outcomeRows: [forged], asOfTs: ASOF, archiveContext: ctx }).error ?? '', /is not max\(anchor, archive creation/);
  assert.equal(await codeOf(async () => evaluateDataset({ featureRows: [F], outcomeRows: [forged], asOfTs: ASOF, splitAtTs: SPLIT, archiveContext: ctx })), 'CORRUPT_INPUT');
  // and the SAVED artifact, resealed so the semantic law is what runs
  const chain = await savedChain(W, { name: 'c1', shadow: false });
  const before = readDatasetDir(chain.ds.dir);
  assert.equal(before.outcomeRows[0].reference.knownAtTs, CREATED);
  const mutated = reseal(W, chain.ds.dir, 'c1-forged', (d) => rewriteJsonl(d, 'outcomes.jsonl', (o) => { o.reference.knownAtTs = o.anchorTsMs; for (const h of Object.values(o.horizons)) if (h.outcomeKnownAtTs !== null) h.outcomeKnownAtTs = h.horizonEndTs; }));
  const m = JSON.parse(readFileSync(path.join(mutated, 'dataset.manifest.json'), 'utf8'));
  assert.equal(m.inputs.childhood.archiveCreatedTs, isoOf(CREATED), 'the fixture leaves every archive provenance copy at 18:00');
  assert.equal(m.census.archive.identity.archiveCreatedTsMs, CREATED);
  assert.equal(await codeOf(async () => readDatasetDir(mutated)), 'CORRUPT_INPUT');
  assert.equal(await codeOf(async () => runEvaluate({ datasetDir: mutated, splitAtTs: SPLIT, out: path.join(W, 'c1-forged-ev') })), 'CORRUPT_INPUT');
  assert.ok(!existsSync(path.join(W, 'c1-forged-ev')), 'and no evaluation artifact is produced from it');
  // a PRE-SEAL candidate carrying the same forgery is refused before any manifest exists
  const res = reserveOutputDir(prepareOutputTarget(path.join(W, 'c1-preseal')));
  for (const f of ['features.jsonl', 'outcomes.jsonl', 'coverage.json']) writeFileSync(path.join(res.dir, f), readFileSync(path.join(mutated, f)));
  assert.equal(await codeOf(async () => publishManifest(res, 'dataset.manifest.json', m, { bundle: (d, cand) => datasetBundle(d, cand, {}) })), 'CORRUPT_INPUT');
  assert.ok(!existsSync(path.join(res.dir, 'dataset.manifest.json')), 'no completion manifest is left behind');

  // FLOOR-1 / FLOOR / FLOOR+1 on each clock separately
  for (const [name, mk] of [['reference', (o, v) => { o.reference.knownAtTs = v; }], ['horizon 240m', (o, v) => { o.horizons['240m'].outcomeKnownAtTs = v; }]]) {
    for (const [delta, ok] of [[-1, false], [0, true], [1, false]]) {
      const o = structuredClone(L); mk(o, CREATED + delta);
      const e = outcomeContextError(o, ctx);
      assert.equal(e === null, ok, `${name} at the recipe floor ${delta >= 0 ? '+' : ''}${delta} ms: ${ok ? 'lawful' : 'refused'} (${e ?? 'accepted'})`);
    }
  }
  // the already-repaired SINGLE-sided backdate stays refused by the row-local law alone
  const single = structuredClone(L); for (const h of Object.values(single.horizons)) h.outcomeKnownAtTs = h.horizonEndTs;
  assert.match(validateOutcomeRow(single), /knowledge floor precedes its own reference floor/);
  // a context that disagrees with the row's own reported source is refused in either direction
  assert.match(outcomeContextError(L, { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: null }), /built with no Childhood archive/);
  const absent = labelRow(F, { archive: null, asOfTs: ASOF });
  assert.match(outcomeContextError(absent, ctx), /claims ARCHIVE_ABSENT although the dataset records a created archive/);
  assert.equal(outcomeContextError(absent, { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: null }), null);
  // MALFORMED context is never silently downgraded to "no context"
  for (const bad of [null, {}, { state: 'NOPE', archiveCreatedTsMs: null, oneMinuteSymbols: null }, { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols: null }, { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: 'x', oneMinuteSymbols: null }, { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED }, { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: ['ZQQ7'] }]) {
    assert.match(datasetJoinError({ featureRows: [F], outcomeRows: [L], asOfTs: ASOF, archiveContext: bad }).error ?? '', /archive context/, `${JSON.stringify(bad)} is corruption, not an absent context`);
  }
  // an OMITTED context is a different thing again: the row-local law runs and claims nothing about the archive
  assert.equal(datasetJoinError({ featureRows: [F], outcomeRows: [L], asOfTs: ASOF }).error, undefined);
  // a LATE archive at an early split remains lawful and honestly unlearnable
  assert.equal(honest.learnability.horizons['240m'].discoveryKnownRetrospectively, 1, 'retrospectively available');
  assert.equal(honest.learnability.horizons['240m'].discoveryTrainableAtSplit, 0, 'but never trainable at the split');
});

// ================================================================================================================
test('M02b (C6). outcome cross-state consistency: a row cannot declare its source missing while carrying outcomes, mix unavailable horizons with resolved ones, or contradict the row-availability recipe — and every lawful combination is preserved', async () => {
  const { F, L, archive } = await pureFixture();
  // THE DELIVERED DEFECT: ARCHIVE_ABSENT could sit beside KNOWN excursions and a KNOWN reference price.
  const contradictory = structuredClone(L); contradictory.availability = { state: 'UNAVAILABLE', reason: 'ARCHIVE_ABSENT' };
  assert.match(validateOutcomeRow(contradictory), /declares its source unavailable while its horizons carry outcomes/);
  // a source-absence verdict is all-or-nothing, under ONE reason, with no reference
  const partial = structuredClone(labelRow(F, { archive: null, asOfTs: ASOF }));
  partial.horizons['1m'] = { ...partial.horizons['1m'], state: 'CENSORED', reason: 'INTERIOR_BAR_MISSING', outcomeKnownAtTs: partial.horizons['1m'].horizonEndTs };
  assert.match(validateOutcomeRow(partial), /some horizons are unavailable while others are not/);
  const twoReasons = structuredClone(labelRow(F, { archive: null, asOfTs: ASOF }));
  twoReasons.horizons['3m'] = { ...twoReasons.horizons['3m'], reason: 'NO_1M_TRACK' };
  assert.match(validateOutcomeRow(twoReasons), /more than one source-absence reason/);
  const refPresent = structuredClone(labelRow(F, { archive: null, asOfTs: ASOF }));
  refPresent.reference = { state: 'NOT_YET_KNOWN', barOpenSec: null, price: null, knownAtTs: refPresent.anchorTsMs + 1000 };
  assert.match(validateOutcomeRow(refPresent), /every horizon is unavailable yet the reference price is not/);
  const wrongVerdict = structuredClone(labelRow(F, { archive: null, asOfTs: ASOF }));
  wrongVerdict.availability = { state: 'UNAVAILABLE', reason: 'NO_1M_TRACK' };
  assert.match(validateOutcomeRow(wrongVerdict), /the row verdict disagrees with the source-absence its horizons report/);
  // reasons are not interchangeable across states
  const badKnown = structuredClone(L); badKnown.horizons['1m'].reason = 'INTERIOR_BAR_MISSING';
  assert.match(validateOutcomeRow(badKnown), /is KNOWN under a reason that is not COMPLETE/);
  const badMask = structuredClone(L); const maskedRow = labelRow(F, { archive, asOfTs: CREATED - 1 });
  assert.equal(validateOutcomeRow(maskedRow), null, 'a fully masked row is lawful');
  assert.ok(Object.values(maskedRow.horizons).every((h) => h.state === 'NOT_YET_KNOWN'));
  assert.equal(maskedRow.availability.state, 'AVAILABLE', 'AVAILABLE never meant "already KNOWN"');
  badMask.horizons['1m'].reason = 'COMPLETE'; badMask.horizons['1m'].state = 'NOT_YET_KNOWN';
  assert.ok(validateOutcomeRow(badMask) !== null);
  // a masked reference cannot coexist with a resolved horizon beside it
  const mixed = structuredClone(maskedRow); mixed.reference = { state: 'NOT_YET_KNOWN', barOpenSec: null, price: null, knownAtTs: CREATED };
  mixed.horizons['1m'] = { ...mixed.horizons['1m'], state: 'KNOWN', reason: 'COMPLETE', mfePct: 1, maePct: 0 };
  assert.ok(validateOutcomeRow(mixed) !== null);
  // and the row verdict IS the recipe's function of the horizon states
  const forgedVerdict = structuredClone(L); forgedVerdict.availability = { state: 'AVAILABLE', reason: 'COMPLETE' };
  const expected = rowAvailabilityOf(LABEL_HORIZONS_MIN.map((h) => L.horizons[`${h}m`].state));
  if (expected.state !== 'AVAILABLE') assert.match(validateOutcomeRow(forgedVerdict), /is not what its horizon states produce/);
  // LAWFUL positives are preserved exactly: partial / censored / all-censored keep their delivered vocabulary
  const shortRow = { symbol: 'ZQQ7', intervalMin: 1, retrievedTs: isoOf(SPLIT), retrievedSec: SPLIT / 1000, candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 600 }) };
  const shortSeries = { archiveCreatedTsMs: CREATED, oneMinute: new Map([['ZQQ7', validateCandleSeriesRow(shortRow, { intervalMin: 1 })]]) };
  const censored = labelRow(F, { archive: shortSeries, asOfTs: ASOF });
  assert.equal(validateOutcomeRow(censored), null);
  assert.equal(censored.availability.state, 'PARTIAL'); assert.equal(censored.availability.reason, 'COMPLETE');
  assert.ok(Object.values(censored.horizons).some((h) => h.state === 'CENSORED'));
  assert.ok(Object.values(censored.horizons).every((h) => h.state !== 'CENSORED' || (h.mfePct === null && h.maePct === null)), 'censoring is never a zero return');
  // per-horizon log-return applicability is untouched
  for (const h of LABEL_HORIZONS_MIN) assert.equal(L.horizons[`${h}m`].logReturnUnit, [60, 240].includes(h) ? 'LOG_RETURN_PERCENT' : null);
});

// ================================================================================================================
test('M03 (C4/C5). the DERIVATION clock and the retained dependency graph: an input between derivation and decision is refused, and every upstream graph relationship survives projection', async () => {
  const { F } = await pureFixture();
  // THE DELIVERED DEFECT (C4): featureAsOfTs moved BELOW a retained notice clock, with the later durable decision
  // untouched, validated — because the nested law compared against the decision rather than the derivation.
  const tooEarly = structuredClone(F);
  tooEarly.featureAsOfTs = F.arrays.notices[0].knownAtTs - 1;
  tooEarly.features['decision.featureAsOfTs'] = tooEarly.featureAsOfTs;
  assert.ok(tooEarly.featureAsOfTs < F.arrays.notices[0].knownAtTs && F.arrays.notices[0].knownAtTs < F.decisionKnownAtTs, 'the input really does fall between the two clocks');
  assert.ok(validateFeatureRow(tooEarly) !== null, 'an input arriving after the derivation cannot have fed it');
  // (b) the NESTED law itself, with every summary and identity left lawful
  const nested = structuredClone(F);
  nested.arrays.notices[0].knownAtTs = F.featureAsOfTs + 1;
  nested.arrays.notices[0].observedTs = Math.min(nested.arrays.notices[0].observedTs, F.featureAsOfTs + 1);
  assert.match(validateFeatureRow(nested), /notices\[0\]\.knownAtTs is known after the derivation it fed/);
  const trig = structuredClone(F); trig.arrays.triggers[0].knownAtTs = F.featureAsOfTs + 1;
  assert.match(validateFeatureRow(trig), /triggers\[0\]\.knownAtTs is known after the derivation it fed/);
  // lawful EQUALITY at the derivation, and a lawful later durable decision, stay GREEN
  const atDerivation = structuredClone(F); atDerivation.arrays.notices[0].knownAtTs = F.featureAsOfTs; atDerivation.arrays.notices[0].observedTs = F.featureAsOfTs;
  assert.equal(validateFeatureRow(atDerivation), null, 'equality at the derivation clock is lawful');
  assert.equal(validateFeatureRow(F), null, 'and the real row, whose decision follows its derivation, is lawful');

  // ---- C5: the retained graph keeps the relationships that make it a graph
  const nodes = F.arrays.dependencyNodes; assert.ok(nodes.length >= 2, 'the fixture carries a real dependency graph');
  const dup = structuredClone(F); dup.arrays.dependencyNodes.push(structuredClone(nodes[0]));
  assert.match(validateFeatureRow(dup), /repeats the identity of node/);
  const ghost = structuredClone(F); ghost.arrays.dependencyEdges.push({ from: 'social:not-in-this-projection', to: nodes[0].id, relation: 'CONTEXT_FOR' });
  assert.match(validateFeatureRow(ghost), /names a node this projection does not carry/);
  const self = structuredClone(F); self.arrays.dependencyEdges.push({ from: nodes[0].id, to: nodes[0].id, relation: 'CONTEXT_FOR' });
  assert.match(validateFeatureRow(self), /is a self-dependency/);
  const twice = structuredClone(F); twice.arrays.dependencyEdges.push(structuredClone(twice.arrays.dependencyEdges[0]));
  assert.match(validateFeatureRow(twice), /repeats an earlier edge/);
  // a node's clock may never precede the parent it derives from, and no cycle may survive
  const backward = structuredClone(F);
  const e0 = backward.arrays.dependencyEdges[0];
  backward.arrays.dependencyNodes.find((n) => n.id === e0.to).knownAtTs = backward.arrays.dependencyNodes.find((n) => n.id === e0.from).knownAtTs - 1;
  assert.match(validateFeatureRow(backward), /derives a node known before its parent/);
  const t = F.featureAsOfTs - 1000;
  assert.match(dependencyGraphError([{ id: 'a', kind: 'CLAIM', knownAtTs: t }, { id: 'b', kind: 'CLAIM', knownAtTs: t }], [{ from: 'a', to: 'b', relation: 'DERIVES' }, { from: 'b', to: 'a', relation: 'DERIVES' }], { derivationTs: F.featureAsOfTs }), /contains a cycle/);
  assert.equal(dependencyGraphError([{ id: 'a', kind: 'CLAIM', knownAtTs: t }, { id: 'b', kind: 'CLAIM', knownAtTs: t }], [{ from: 'a', to: 'b', relation: 'DERIVES' }], { derivationTs: F.featureAsOfTs }), null, 'a lawful DAG with EQUAL clocks is valid');
  // the upstream contract requires a node clock: it is not optional
  const nullClock = structuredClone(F); nullClock.arrays.dependencyNodes[0].knownAtTs = null;
  assert.ok(validateFeatureRow(nullClock) !== null);
  // truncation stays DISCLOSED and consequential — it never legalizes a malformed retained graph
  assert.equal(F.features['dependencies.truncated'], false);
  const truncatedDup = structuredClone(dup); truncatedDup.features['dependencies.truncated'] = true;
  assert.ok(validateFeatureRow(truncatedDup) !== null, 'a truncation disclosure does not excuse a duplicate identity');
  // and the SAME law runs at the projection boundary, not only on feature rows
  const rec = projectEventList((await journalFixture({ coins: ['ZQQ7'], shadow: false })).events).records.find((r) => r.recordKind === 'RESEARCH_DOSSIER_V2');
  const recDup = structuredClone(rec); recDup.arrays.dependencyNodes.push(structuredClone(recDup.arrays.dependencyNodes[0]));
  assert.match(validateSnapshotRecord(recDup), /repeats the identity of node/);
});

// ================================================================================================================
test('M05 (C3). complete nested artifact metadata: inputs=null is corruption, every nested identity / digest / clock copy must be present and agree, and a census is checked against the rows rather than against its own second copy', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'c3', shadow: false });
  assert.equal(datasetManifestError(chain.ds.manifest), null, 'the real producer emits a manifest its own schema accepts');

  // THE DELIVERED DEFECT: a dataset whose manifest declared `inputs: null` sealed and reopened cleanly.
  const nulled = reseal(W, chain.ds.dir, 'c3-null', (d, m) => { m.inputs = null; });
  assert.equal(await codeOf(async () => readDatasetDir(nulled)), 'CORRUPT_INPUT');
  assert.match(await msgOf(async () => readDatasetDir(nulled)), /dataset manifest inputs/);
  // the required nested members, one at a time
  for (const [name, mutate, re] of [
    ['no snapshot input', (m) => { m.inputs.snapshot = null; }, /inputs\.snapshot/],
    ['snapshot digest wrong shape', (m) => { m.inputs.snapshot.manifestSha256 = 'nope'; }, /snapshot digests malformed/],
    ['prefix digest recipe forged', (m) => { m.inputs.snapshot.prefixDigest.version = 'other-recipe-1'; }, /prefix digest malformed/],
    // the inventory law now catches this first: the declared manifest digest must be the one the inventory records
    ['archive identity disagrees with inputs', (m) => { m.inputs.childhood.manifestSha256 = 'a'.repeat(64); }, /names a different archive|inventoried manifest digest is not the archive manifest this artifact declares/],
    ['archive creation clock disagrees between copies', (m) => { m.census.archive.identity.archiveCreatedTsMs = CREATED + 1000; }, /disagrees with its own millisecond copy|disagrees between the inputs and the census/],
    ['consumed-file checksum contradicts its own digest', (m) => { m.inputs.childhood.consumedFiles['candles-1m.jsonl'].declaredSha256_16 = '0'.repeat(16); }, /declared checksum disagrees/],
    ['limits key removed', (m) => { delete m.limits.maxSelectedRows; }, /limits: missing key/],
    ['code identity closure disagrees with its count', (m) => { m.codeIdentity.sourceFiles += 1; }, /source closure disagrees/],
    ['identity law invented', (m) => { m.codeIdentity.law = 'PRODUCED_BY_MAGIC'; }, /identity law is not one of the declared states/],
    ['as-of text copy disagrees', (m) => { m.asOf = isoOf(m.asOfTs + 1000); }, /as-of clock disagrees with its own text copy/],
    ['reconciliation does not add up', (m) => { m.counts.reconciliation.sum += 1; m.census = m.census; }, /reconciliation/],
  ]) {
    const d = reseal(W, chain.ds.dir, `c3-${sha256Hex(name).slice(0, 10)}`, (dd, m) => mutate(m));
    assert.equal(await codeOf(async () => readDatasetDir(d)), 'CORRUPT_INPUT', name);
    assert.match(await msgOf(async () => readDatasetDir(d)), re, name);
  }
  // TWO MATCHING BUT WRONG COPIES satisfy nothing: the census is recomputed from the sealed rows
  const bothWrong = reseal(W, chain.ds.dir, 'c3-bothwrong', (d, m) => {
    const cov = JSON.parse(readFileSync(path.join(d, 'coverage.json'), 'utf8'));
    cov.census.rowAvailability.AVAILABLE += 1; cov.census.rowAvailability.PARTIAL = Math.max(0, cov.census.rowAvailability.PARTIAL - 1);
    m.census = cov.census; writeFileSync(path.join(d, 'coverage.json'), JSON.stringify(cov, null, 1) + '\n');
  });
  assert.match(await msgOf(async () => readDatasetDir(bothWrong)), /census rowAvailability disagrees with the outcome rows it summarizes/);
  const coinsWrong = reseal(W, chain.ds.dir, 'c3-coins', (d, m) => {
    const cov = JSON.parse(readFileSync(path.join(d, 'coverage.json'), 'utf8'));
    cov.census.overlap.rowCoins += 7; m.census = cov.census; writeFileSync(path.join(d, 'coverage.json'), JSON.stringify(cov, null, 1) + '\n');
  });
  assert.match(await msgOf(async () => readDatasetDir(coinsWrong)), /row assets but the sealed rows carry/);
  // the MEMBER LIST is fixed by artifact kind, and descriptors are closed shapes
  const dropped = reseal(W, chain.ds.dir, 'c3-drop', (d, m) => { delete m.outputs['coverage.json']; });
  assert.match(await msgOf(async () => readDatasetDir(dropped)), /this artifact requires/);
  const noLines = reseal(W, chain.ds.dir, 'c3-nolines', (d, m) => { delete m.outputs['features.jsonl'].lines; });
  assert.match(await msgOf(async () => readDatasetDir(noLines)), /output descriptor missing key 'lines'/, 'a missing record count does not exempt the file from verification');
  const extraField = reseal(W, chain.ds.dir, 'c3-extra', (d, m) => { m.outputs['coverage.json'].note = 'x'; });
  assert.match(await msgOf(async () => readDatasetDir(extraField)), /output descriptor undeclared key/);
  const renamed = reseal(W, chain.ds.dir, 'c3-rename', (d, m) => { m.outputs['coverage.json'].name = 'features.jsonl'; });
  assert.match(await msgOf(async () => readDatasetDir(renamed)), /names a different member/);
  // an unsafe member name is never opened
  const traversal = reseal(W, chain.ds.dir, 'c3-traverse', () => {});
  const tm = JSON.parse(readFileSync(path.join(traversal, 'dataset.manifest.json'), 'utf8'));
  tm.outputs['../escape.json'] = { name: '../escape.json', bytes: 1, sha256: 'a'.repeat(64) };
  writeFileSync(path.join(traversal, 'dataset.manifest.json'), JSON.stringify(tm, null, 1) + '\n');
  assert.equal(await codeOf(async () => readDatasetDir(traversal)), 'CORRUPT_INPUT');
  assert.ok(!existsSync(path.join(W, 'escape.json')), 'and nothing outside the artifact was ever opened');
  // and the snapshot / evaluation manifests are closed in the same way
  const snapBad = reseal(W, chain.snap.dir, 'c3-snapbad', (d, m) => { m.counts.byType = { ...m.counts.byType, EXTRA_TYPE: 5 }; });
  assert.match(await msgOf(async () => readSnapshotDir(snapBad)), /per-type census does not add up/);
  const evBad = reseal(W, chain.ev.dir, 'c3-evbad', (d, m) => { m.inputs.dataset.asOf = isoOf(ASOF + 1000); });
  assert.match(await msgOf(async () => readEvaluationDir(evBad)), /recorded dataset as-of disagrees/);
});

// ================================================================================================================
test('M06 (C2). the evaluation payload is validated BEFORE its report is trusted: a negative population and a false stage calibration are refused at publication and on standalone reopening, each with a faithfully regenerated report and correct checksums', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'c2', shadow: false });
  const lawful = chain.ev.evaluation;
  assert.equal(evaluationPayloadError(lawful), null);

  // THE DELIVERED DEFECT: E1 and E2 were accepted because report.txt was regenerated and every checksum matched.
  for (const [name, mutate, re] of [
    ['E1 negative primary population', (e) => { e.rows.primary = -1; }, /rows: (total|primary)/],
    ['E2 false stage calibration', (e) => { e.state.stageCalibration = 'PERFORMED'; }, /performs no stage calibration/],
  ]) {
    const d = reseal(W, chain.ev.dir, `c2-${sha256Hex(name).slice(0, 10)}`, (dd) => {
      const e = JSON.parse(readFileSync(path.join(dd, 'evaluation.json'), 'utf8')); mutate(e);
      writeFileSync(path.join(dd, 'evaluation.json'), JSON.stringify(e, null, 1) + '\n');
      writeFileSync(path.join(dd, 'report.txt'), renderReport(e)); // the REAL renderer: the report agrees with the lie
    });
    const m = JSON.parse(readFileSync(path.join(d, 'evaluation.manifest.json'), 'utf8'));
    verifyOutputs(d, m.outputs, { expected: ['evaluation.json', 'report.txt'] }); // integrity is genuinely correct
    assert.equal(await codeOf(async () => readEvaluationDir(d)), 'CORRUPT_INPUT', name);
    assert.match(await msgOf(async () => readEvaluationDir(d)), re, name);
    // and PRE-SEAL: the publisher will not seal it either
    const res = reserveOutputDir(prepareOutputTarget(path.join(W, `c2-pre-${sha256Hex(name).slice(0, 8)}`)));
    for (const f of ['evaluation.json', 'report.txt']) writeFileSync(path.join(res.dir, f), readFileSync(path.join(d, f)));
    const { evaluationBundle } = await import('../research/bundle.js');
    assert.equal(await codeOf(async () => publishManifest(res, 'evaluation.manifest.json', m, { bundle: (dd, cand) => evaluationBundle(dd, cand, {}) })), 'CORRUPT_INPUT', name);
    assert.ok(!existsSync(path.join(res.dir, 'evaluation.manifest.json')));
  }
  // a valid payload with an INDEPENDENTLY mismatched report is still refused — for the report, not the payload
  const badReport = reseal(W, chain.ev.dir, 'c2-report', (d) => writeFileSync(path.join(d, 'report.txt'), 'PROFITABLE STRATEGY CONFIRMED\n'));
  assert.match(await msgOf(async () => readEvaluationDir(badReport)), /report\.txt is not the rendering of the evaluation sealed beside it/);
  // the arithmetic invariants, one at a time, on the PURE validator
  for (const [name, mutate, re] of [
    ['split counts do not partition the cohort', (e) => { e.splits.primaryRows.VALIDATION += 1; }, /split counts do not add up/],
    ['a horizon table covers the wrong population', (e) => { e.tables.primaryAll['1m'].n += 1; }, /covers \d+ rows but its cohort holds/],
    ['state counts do not add up to n', (e) => { e.tables.primaryAll['1m'].counts.CENSORED += 1; }, /do not add up to n/],
    // the all-primary table is a PARTITION of the splits, not an independently authored total: moving one outcome
    // between states there — with n, the state totals and the summaries all left internally consistent — is refused
    ['the all-primary table is authored independently', (e) => {
      const t = e.tables.primaryAll['5m']; t.counts.KNOWN -= 1; t.counts.NOT_YET_KNOWN += 1;
      const empty = { n: 0, p25: null, median: null, p75: null, min: null, max: null };
      t.mfePct = { ...empty }; t.maePct = { ...empty };
    }, /is not the sum over the splits it partitions/],
    ['quantiles out of order', (e) => { const s = e.tables.primaryAll['1m'].mfePct; s.p25 = s.max + 1; }, /quantiles are not ordered/],
    ['a summary counts more values than KNOWN outcomes', (e) => { e.tables.primaryAll['1m'].mfePct.n += 1; }, /summarizes \d+ values but its table reports/],
    ['an adverse excursion turns positive', (e) => { const s = e.tables.primaryAll['1m'].maePct; for (const f of ['p25', 'median', 'p75', 'min', 'max']) s[f] = 5; }, /adverse excursion cannot be positive/],
    ['a non-log horizon grows a log summary', (e) => { e.tables.primaryAll['1m'].logReturnPct = { n: 0, p25: null, median: null, p75: null, min: null, max: null }; }, /non-log horizon carries a log-return summary/],
    ['trainable exceeds retrospective', (e) => { e.learnability.horizons['1m'].discoveryTrainableAtSplit = e.learnability.horizons['1m'].discoveryKnownRetrospectively + 1; }, /more labels are trainable at the split than are known retrospectively/],
    ['retrospective availability disagrees with its table', (e) => { e.learnability.horizons['1m'].discoveryKnownRetrospectively += 1; e.learnability.horizons['1m'].discoveryTrainableAtSplit = 0; }, /disagrees with the DISCOVERY table/],
    ['a breakdown covers the wrong cohort', (e) => { const k = Object.keys(e.byEntrance)[0]; e.byEntrance[k] += 1; }, /the breakdown covers \d+ rows but the primary cohort holds/],
    ['group counts exceed their rows', (e) => { e.grouping.groups += 5; }, /group count is impossible|group split counts do not add up/],
    ['a standing calibration blocker is dropped', (e) => { e.state.calibrationBlockers = e.state.calibrationBlockers.filter((b) => b !== 'CLAIM_ASSOCIATION_SEAM_ABSENT'); }, /standing blocker CLAIM_ASSOCIATION_SEAM_ABSENT is missing/],
    ['a standing law is dropped', (e) => { e.laws = e.laws.filter((l) => l !== 'NO_CAUSAL_CLAIM'); }, /standing law NO_CAUSAL_CLAIM is missing/],
    ['the support windows are re-tuned', (e) => { e.supportRule.wideEyeBaselineMs = 1000; }, /support windows are not the recipe constants/],
    ['an unknown nested key appears', (e) => { e.rows.extra = 1; }, /rows: undeclared key/],
    ['the fitted-model claim changes', (e) => { e.state.fittedModel = 'LOGISTIC'; }, /fits no model/],
    ['the runtime stage is claimed', (e) => { e.state.currentRuntimeStage = 'PUMP'; }, /stays UNKNOWN/],
  ]) {
    const e = structuredClone(lawful); mutate(e);
    const got = evaluationPayloadError(e);
    assert.ok(got !== null, `${name} must be refused`);
    assert.match(got, re, name);
  }
  // lawful shapes stay lawful: an archive-free evaluation, whose tables are entirely empty, validates
  const bare = await savedChain(W, { name: 'c2-bare', childhood: false });
  assert.equal(evaluationPayloadError(bare.ev.evaluation), null, 'an archive-free evaluation is lawful');
  assert.equal(bare.ev.evaluation.tables.primaryAll['1m'].counts.OUTCOME_UNAVAILABLE, bare.ev.evaluation.rows.primary);
  // and on THOSE empty tables, a summary that exposes a value is refused
  for (const [name, mutate, re] of [
    ['an empty summary exposes values', (e) => { e.tables.primaryAll['1m'].mfePct.median = 0; }, /empty summary exposes values/],
    ['an empty summary claims a population', (e) => { e.tables.primaryAll['1m'].mfePct.n = 1; }, /summarizes 1 values but its table reports 0 KNOWN/],
    ['coverage is UNAVAILABLE while outcomes are KNOWN', (e) => { e.tables.primaryAll['1m'].counts.KNOWN = 1; e.tables.primaryAll['1m'].counts.OUTCOME_UNAVAILABLE -= 1; e.tables.primaryBySplit.DISCOVERY['1m'].counts.KNOWN = 1; e.tables.primaryBySplit.DISCOVERY['1m'].counts.OUTCOME_UNAVAILABLE -= 1; }, /summarizes 0 values but its table reports 1 KNOWN/],
  ]) {
    const e = structuredClone(bare.ev.evaluation); mutate(e);
    const got = evaluationPayloadError(e);
    assert.ok(got !== null, `${name} must be refused`); assert.match(got, re, name);
  }
  assert.equal(readEvaluationDir(bare.ev.dir).report, bare.ev.report);
  assert.ok(bare.ev.evaluation.state.calibrationBlockers.includes('ARCHIVE_NOT_SUPPLIED'));
});

// ================================================================================================================
test('M07 (C7). production I/O is bounded and single-pass: the digest describes exactly the bytes the records were parsed from, no production JSONL path reads a whole file, handles close on every exit, and a short or failed write never becomes a successful seal', async () => {
  const W = work();
  // ---- the digest and the records come from ONE read
  const res = reserveOutputDir(prepareOutputTarget(path.join(W, 'io')));
  const w = jsonlWriter(res, 'rows.jsonl');
  const pad = 'é'.repeat(1000); // two bytes per character: a chunk edge WILL fall inside one
  const n = Math.ceil((JSONL_CHUNK_BYTES * 2.5) / 2100);
  for (let i = 0; i < n; i += 1) w.write({ i, pad });
  const o = w.close();
  assert.ok(o.bytes > JSONL_CHUNK_BYTES * 2, 'the fixture really spans several chunks');
  const seen = [];
  const io = consumeJsonl(path.join(res.dir, 'rows.jsonl'), { onRecord: (r) => seen.push(r.i) });
  assert.equal(io.sha256, o.sha256); assert.equal(io.bytes, o.bytes); assert.equal(io.lines, n);
  assert.deepEqual(seen, Array.from({ length: n }, (_, i) => i), 'every record survives the chunk boundaries in order');
  assert.equal(sha256Hex(readFileSync(path.join(res.dir, 'rows.jsonl'))), io.sha256, 'and that digest is the file’s own');

  // ---- INSTRUMENTED, IN A CHILD PROCESS: no shared global is patched inside this runner. The seam wraps the file
  // primitives before any module binds them and records what the REAL production commands and readers actually did.
  const probeLog = path.join(W, 'probe.log');
  const run = (mode, env = {}) => {
    const r = spawnSync(process.execPath, ['--require', path.join(HERE, 'helpers/fs-probe.cjs'), path.join(HERE, 'helpers/fs-probe-run.mjs'), mode],
      { encoding: 'utf8', env: { ...process.env, COBRA_FS_PROBE_LOG: probeLog, ...env }, timeout: 180_000 });
    const line = (r.stdout || '').split('\n').find((x) => x.startsWith('RESULT '));
    assert.ok(line, `the probe produced no result (${(r.stderr || '').slice(0, 400)})`);
    return JSON.parse(line.slice(7));
  };
  const readResult = run('read');
  assert.equal(readResult.error, null, 'the probed production run completed');
  assert.ok(readResult.ok);
  const opsAll = readFileSync(probeLog, 'utf8').split('\n').filter(Boolean);
  const reopen = opsAll.slice(opsAll.indexOf('--- REOPEN ---') + 1);
  assert.ok(reopen.length > 0, 'the reopen phase was observed');
  assert.deepEqual(opsAll.filter((x) => /^readFile .*\.jsonl$/.test(x)), [], 'NO production path reads a JSONL member whole — not on publication, not on reopening, not in the archive');
  const openedInReopen = (name) => reopen.filter((x) => x === `open ${name}`).length;
  for (const member of ['features.jsonl', 'snapshots.jsonl', 'candles-1m.jsonl', 'candles-5m.jsonl', 'observations.jsonl']) {
    assert.equal(openedInReopen(member), 1, `${member} is opened exactly once on reopening — integrity and semantics share that one read`);
  }
  assert.equal(openedInReopen('outcomes.jsonl'), 2, 'the dataset outcomes and the archive outcomes are two distinct members, one open each');
  assert.ok(reopen.filter((x) => x.startsWith('read ')).length >= reopen.filter((x) => x.startsWith('open ')).length, 'every opened member was consumed in bounded chunks');
  assert.ok(reopen.filter((x) => x === 'close fd').length >= reopen.filter((x) => x.startsWith('open ')).length, 'and every opened descriptor was closed');

  // ---- bounds, encodings and EOF cases
  const file = path.join(res.dir, 'rows.jsonl');
  assert.equal(codeOfSync(() => consumeJsonl(file, { limits: { ...LIMITS, maxJsonlLineBytes: 100 } })), 'RESOURCE_LIMIT_EXCEEDED');
  assert.equal(codeOfSync(() => consumeJsonl(file, { limits: { ...LIMITS, maxInputFileBytes: 1000 } })), 'RESOURCE_LIMIT_EXCEEDED');
  // THE LINE-BYTE CONVENTION IS THE SAME ON BOTH SIDES: the writer charges the terminating newline it emits, and so
  // does the reader for a terminated line. Exact bound and one byte over, from each side.
  const w2 = jsonlWriter(res, 'exact.jsonl'); w2.write({ a: 1 }); const o2 = w2.close();
  assert.equal(o2.bytes, Buffer.byteLength('{"a":1}\n', 'utf8'), 'the writer charges the record its serialized bytes plus its newline');
  assert.equal(consumeJsonl(path.join(res.dir, 'exact.jsonl'), { limits: { ...LIMITS, maxJsonlLineBytes: o2.bytes } }).lines, 1, 'a line exactly at the bound is lawful on the way back in');
  assert.equal(codeOfSync(() => consumeJsonl(path.join(res.dir, 'exact.jsonl'), { limits: { ...LIMITS, maxJsonlLineBytes: o2.bytes - 1 } })), 'RESOURCE_LIMIT_EXCEEDED', 'one byte over is not');
  const res5 = reserveOutputDir(prepareOutputTarget(path.join(W, 'io-bound')));
  const w6 = jsonlWriter(res5, 'rows.jsonl', { limits: { ...LIMITS, maxJsonlLineBytes: o2.bytes } });
  w6.write({ a: 1 }); // exactly at the bound is lawful on the way out too
  assert.equal(codeOfSync(() => w6.write({ a: 12 })), 'RESOURCE_LIMIT_EXCEEDED', 'and one byte over is refused by the writer under the same accounting');
  // a final record with NO terminator is charged its actual bytes — no newline is invented for it
  writeFileSync(path.join(res.dir, 'unterm.jsonl'), '{"a":1}');
  assert.equal(consumeJsonl(path.join(res.dir, 'unterm.jsonl'), { limits: { ...LIMITS, maxJsonlLineBytes: 7 } }).lines, 1);
  assert.equal(codeOfSync(() => consumeJsonl(path.join(res.dir, 'unterm.jsonl'), { limits: { ...LIMITS, maxJsonlLineBytes: 6 } })), 'RESOURCE_LIMIT_EXCEEDED');
  const cases = [['gap.jsonl', '{"a":1}\n\n{"a":2}\n', 'CORRUPT_INPUT'], ['scalar.jsonl', '"a string"\n', 'CORRUPT_INPUT'], ['broken.jsonl', '{"a":1}\n{oops\n', 'CORRUPT_INPUT'], ['tail.jsonl', '{"a":1}\n{"a":2}\n', null], ['nonl.jsonl', '{"a":1}\n{"a":2}', null], ['empty.jsonl', '', null]];
  for (const [nm, text, code] of cases) { writeFileSync(path.join(res.dir, nm), text); assert.equal(codeOfSync(() => consumeJsonl(path.join(res.dir, nm))), code, nm); }
  assert.equal(consumeJsonl(path.join(res.dir, 'nonl.jsonl')).lines, 2, 'a final record without a trailing newline is still a record');
  assert.equal(consumeJsonl(path.join(res.dir, 'empty.jsonl')).lines, 0);
  // malformed UTF-8 is corruption, never a replacement character
  writeFileSync(path.join(res.dir, 'utf8.jsonl'), Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3]), Buffer.from('"}\n')]));
  assert.equal(codeOfSync(() => consumeJsonl(path.join(res.dir, 'utf8.jsonl'))), 'CORRUPT_INPUT');
  // ---- an abandoned reader closes its handle and NEVER publishes integrity
  const before = openSync(file, 'r'); closeSync(before);
  for (const r of readJsonlStrict(file)) { void r; break; }
  const probe = {}; const it = readJsonlStrict(file, { integrity: probe }); it.next(); it.return();
  assert.equal(probe.complete, undefined, 'an abandoned read verified nothing and says so');
  assert.equal(consumeJsonl(file).lines, n, 'and the file is still fully readable afterwards, so no handle leaked');

  // ---- writer failure paths, injected through the same isolated seam: a short, zero-progress or failing write is
  // never a successful seal, and nothing incomplete is left behind
  const fd = openSync(path.join(res.dir, 'wa.bin'), 'w');
  try { assert.equal(writeAll(fd, Buffer.from('hello'), 'wa.bin'), 5); } finally { closeSync(fd); }
  assert.equal(readFileSync(path.join(res.dir, 'wa.bin'), 'utf8'), 'hello');
  const short = run('write', { COBRA_FS_PROBE_FAIL: 'short' });
  assert.equal(short.ok, true, 'a SHORT write is completed to the last byte rather than reported as done');
  assert.equal(short.digestMatches, true, 'so the recorded digest still describes the whole record');
  assert.equal(short.sealed, true);
  const zero = run('write', { COBRA_FS_PROBE_FAIL: 'zero' });
  assert.equal(zero.ok, false); assert.equal(zero.code, 'IO_FAILURE', 'zero progress is a failure, not an endless loop');
  assert.equal(zero.sealed, false, 'and no manifest is sealed after it');
  const thrown = run('write', { COBRA_FS_PROBE_FAIL: 'throw' });
  assert.equal(thrown.ok, false); assert.equal(thrown.code, 'IO_FAILURE');
  assert.equal(thrown.sealed, false);
  assert.ok(!(thrown.error ?? '').includes('injected device failure'), 'the raw OS message is not leaked into the research error');
  const flushFail = run('write', { COBRA_FS_PROBE_FSYNC: 'fail' });
  assert.equal(flushFail.ok, false); assert.equal(flushFail.code, 'IO_FAILURE', 'a failed flush is never a successful seal');
  assert.equal(flushFail.sealed, false);

  // a hash / size mismatch discovered at EOF accepts no bundle
  const chain = await savedChain(W, { name: 'io2', shadow: false });
  const tampered = reseal(W, chain.ds.dir, 'io-tamper', (d) => { const f = path.join(d, 'features.jsonl'); writeFileSync(f, readFileSync(f, 'utf8').replace('"cohort":"PRIMARY"', '"cohort":"PRIMARY" ')); });
  const mm = JSON.parse(readFileSync(path.join(tampered, 'dataset.manifest.json'), 'utf8'));
  mm.outputs['features.jsonl'].sha256 = 'b'.repeat(64);
  writeFileSync(path.join(tampered, 'dataset.manifest.json'), JSON.stringify(mm, null, 1) + '\n');
  assert.equal(await codeOf(async () => readDatasetDir(tampered)), 'CORRUPT_INPUT');
  // existing output protections stay GREEN, with the surrounding data untouched
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: chain.snap.dir, asOfTs: ASOF, out: chain.ds.dir })), 'OUTPUT_EXISTS');
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: chain.snap.dir, asOfTs: ASOF, out: path.join(chain.snap.dir, 'inside') })), 'OUTPUT_OVERLAP');
  assert.equal(readDatasetDir(chain.ds.dir).featureRows.length, chain.ds.manifest.counts.rows, 'the existing artifact is unchanged');
});

// ================================================================================================================
test('M08 (C8 + source identity). rejections never echo the input that caused them, and the effective source closure covers every new validator and I/O helper', async () => {
  const W = work();
  const SENTINEL = 'AUDIT_RAW_CONTENT_SENTINEL_zq7x';
  const bars = [{ symbol: 'ZQQ7', candles: BARS() }];
  // THE DELIVERED DEFECT: the malformed-clock rejection serialized the offending value.
  for (const [name, value] of [['string', SENTINEL], ['number', 1788782400000], ['object', { [SENTINEL]: 1 }], ['array', [SENTINEL]], ['offset instant', '2026-09-07T12:00:00+02:00']]) {
    const d = path.join(W, `c8-${sha256Hex(name).slice(0, 8)}`);
    writeChildhoodArchive(d, { series: bars, archiveCreatedTs: value, retrievedSec: SPLIT / 1000 });
    let caught = null; try { readChildhoodArchive(d); } catch (e) { caught = e; }
    assert.ok(caught instanceof ResearchError && caught.code === 'CORRUPT_INPUT', name);
    const serialized = JSON.stringify(caught.toJSON()) + caught.message + String(caught.researchMessage);
    assert.ok(!serialized.includes(SENTINEL), `${name}: the rejection must not echo the supplied value`);
    assert.ok(!serialized.includes('1788782400000'), `${name}: nor a supplied numeric value`);
    assert.match(caught.researchMessage, /not a lawful UTC instant/);
  }
  // an UNKNOWN KEY carries input text too: it is reported by structural position, never by name
  const F = (await pureFixture()).F;
  const withKey = structuredClone(F); withKey.arrays.dependencyNodes[0][SENTINEL] = 1;
  const msg = validateFeatureRow(withKey);
  assert.ok(msg && !msg.includes(SENTINEL), 'an undeclared key is reported structurally');
  assert.match(msg, /undeclared key at position \d+ of \d+/);
  // an unexpected archive member name is likewise not echoed
  const badMember = path.join(W, 'c8-member');
  writeChildhoodArchive(badMember, { series: bars, archiveCreatedTs: isoOf(CREATED), retrievedSec: SPLIT / 1000 });
  const bm = JSON.parse(readFileSync(path.join(badMember, 'manifest.json'), 'utf8'));
  bm.sourceChecksumsSha256_16[`${SENTINEL}.jsonl`] = '0'.repeat(16);
  writeFileSync(path.join(badMember, 'manifest.json'), JSON.stringify(bm, null, 1));
  const mm = await msgOf(async () => readChildhoodArchive(badMember));
  assert.ok(mm && !mm.includes(SENTINEL), 'an unexpected member name is reported by position');
  // an unsupported version is described, never quoted
  const badVer = path.join(W, 'c8-ver');
  writeChildhoodArchive(badVer, { series: bars, archiveCreatedTs: isoOf(CREATED), retrievedSec: SPLIT / 1000, manifestOverride: { schemaVersion: SENTINEL } });
  const vm = await msgOf(async () => readChildhoodArchive(badVer));
  assert.ok(vm && !vm.includes(SENTINEL), 'an unsupported version is described, not quoted');
  // safeType names the kind, never the value
  assert.equal(safeType(SENTINEL), 'string'); assert.equal(safeType(null), 'null'); assert.equal(safeType([1]), 'array');
  // legitimate closed schema names and reason codes stay useful
  assert.match(exactKeys({ a: 1 }, ['a', 'b']) ?? '', /missing key 'b'/);

  // ---- the EFFECTIVE source closure includes every new validator / I-O helper
  const id = codeIdentity();
  for (const f of ['research/relations.js', 'research/schemas.js', 'research/bundle.js', 'research/identity.js', 'research/artifacts.js', 'evidence/contract.js']) {
    assert.ok(id.sourceClosure.includes(f), `${f} is an effective dependency and must be inventoried`);
  }
  assert.equal(id.sourceFiles, id.sourceClosure.length);
  assert.match(id.sourceTreeSha256, /^[0-9a-f]{64}$/);
  assert.ok(['PRODUCED_BY_COMMITTED_SOURCE', 'PRODUCED_BY_UNCOMMITTED_SOURCE', 'SOURCE_CLEANLINESS_UNKNOWN', 'NO_GIT_CHECKOUT'].includes(id.law));
  // and every sealed artifact records that same identity
  const chain = await savedChain(W, { name: 'c8', shadow: false });
  for (const m of [chain.snap.manifest, chain.ds.manifest, chain.ev.manifest]) assert.equal(m.codeIdentity.sourceTreeSha256, id.sourceTreeSha256);
});

// ================================================================================================================
test('M09. reproducibility: identical inputs, as-of, split and limits produce byte-identical artifacts in different directories, and changing the archive or the label as-of never changes the already-selected feature values of the same rows', async () => {
  const W = work();
  const fx = await journalFixture({ coins: ['ZQQ7'], shadow: true });
  const arch = path.join(W, 'arch'); writeChildhoodArchive(arch, { series: [{ symbol: 'ZQQ7', candles: BARS() }], archiveCreatedTs: isoOf(CREATED), retrievedSec: SPLIT / 1000 });
  const runOnce = async (tag) => {
    const s = await runSnapshot({ events: fx.events, out: path.join(W, `${tag}-snap`) });
    const d = await runBuild({ snapshotDir: s.dir, childhoodDir: arch, asOfTs: ASOF, out: path.join(W, `${tag}-ds`) });
    const e = await runEvaluate({ datasetDir: d.dir, splitAtTs: SPLIT, out: path.join(W, `${tag}-ev`) });
    return { s, d, e };
  };
  const a = await runOnce('r1'); const b = await runOnce('r2');
  for (const [x, y, files] of [[a.s, b.s, ['snapshots.jsonl', 'snapshot.manifest.json']], [a.d, b.d, ['features.jsonl', 'outcomes.jsonl', 'coverage.json', 'dataset.manifest.json']], [a.e, b.e, ['evaluation.json', 'report.txt', 'evaluation.manifest.json']]]) {
    for (const f of files) assert.equal(sha256Hex(readFileSync(path.join(x.dir, f))), sha256Hex(readFileSync(path.join(y.dir, f))), `${f} is byte-identical across runs in different directories`);
  }
  // a DIFFERENT archive changes labels, never the frozen feature values of the same selected rows
  const arch2 = path.join(W, 'arch2'); writeChildhoodArchive(arch2, { series: [{ symbol: 'ZQQ7', candles: BARS() }], archiveCreatedTs: isoOf(CREATED + 7 * 86_400_000), retrievedSec: SPLIT / 1000 });
  const other = await runBuild({ snapshotDir: a.s.dir, childhoodDir: arch2, asOfTs: ASOF, out: path.join(W, 'r3-ds') });
  assert.equal(sha256Hex(readFileSync(path.join(other.dir, 'features.jsonl'))), sha256Hex(readFileSync(path.join(a.d.dir, 'features.jsonl'))), 'the feature side never sees the archive');
  assert.notEqual(sha256Hex(readFileSync(path.join(other.dir, 'outcomes.jsonl'))), sha256Hex(readFileSync(path.join(a.d.dir, 'outcomes.jsonl'))), 'but the labels move with their archive');
  const later = readDatasetDir(other.dir);
  assert.deepEqual(later.archiveContext, { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED + 7 * 86_400_000, oneMinuteSymbols: ['ZQQ7'] });
  assert.ok(later.outcomeRows.every((o) => o.reference.knownAtTs === null || o.reference.knownAtTs === Math.max(o.anchorTsMs, CREATED + 7 * 86_400_000)), 'and the floors follow the recipe against the new archive');
  // a LATER as-of admits later decisions but never rewrites an earlier row's own feature values
  const wide = await runBuild({ snapshotDir: a.s.dir, childhoodDir: arch, asOfTs: ASOF + 30 * 86_400_000, out: path.join(W, 'r4-ds') });
  const base = readDatasetDir(a.d.dir); const grown = readDatasetDir(wide.dir);
  for (const r of base.featureRows) {
    const same = grown.featureRows.find((x) => x.rowId === r.rowId);
    assert.ok(same, 'an already-selected row is still selected under a later as-of');
    assert.equal(canonicalJson(same.features), canonicalJson(r.features), 'and its frozen feature values are byte-identical');
  }
});

// ================================================================================================================
// M10 .. M13 — the finite neighbouring cases required alongside the owner acceptance suite. Each keeps a lawful
// POSITIVE beside its negative, so a law that would reject everything cannot pass by accident.
// ================================================================================================================
test('M10 (R1a/R1b/R1c). every newly closed archive sub-shape rejects an unknown key and a wrong type, while valid missing / null provenance and a lawfully absent track still pass', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'm10', shadow: false });
  assert.equal(datasetManifestError(chain.ds.manifest), null, 'the real producer emits an archive census its own schema accepts');
  const cov0 = JSON.parse(readFileSync(path.join(chain.ds.dir, 'coverage.json'), 'utf8'));
  assert.equal(coverageReportError(cov0, chain.ds.manifest), null);
  // the delivered archive legitimately carries bounded provenance TEXT and lawfully absent coarse tracks
  assert.equal(typeof cov0.census.archive.source.historicalSourceType, 'string', 'declared provenance text stays allowed');
  assert.ok(Object.entries(cov0.census.archive.tracks).some(([, t]) => t.declared === false && t.present === false), 'a lawfully absent track stays allowed');
  const nulled = structuredClone(cov0);
  for (const f of ['historicalSourceType', 'sourceLatestTs', 'universeCoverageStatus', 'fastMemoryParityStatus', 'universeToday', 'deepUniverseCount']) nulled.census.archive.source[f] = null;
  assert.equal(coverageReportError(nulled, chain.ds.manifest), null, 'and every source field may be an explicit null');
  const table = [
    ['source: undeclared key', (c) => { c.census.archive.source.text = 'AUDIT_RAW_CONTENT_SENTINEL'; }, /archive\.source: undeclared key/],
    ['source: wrong type', (c) => { c.census.archive.source.universeToday = 'many'; }, /universeToday is neither an explicit null nor a nonnegative safe integer/],
    ['tracks: wrong type', (c) => { c.census.archive.tracks = 'NOT_AN_OBJECT'; }, /is a string, not the per-track census object/],
    ['tracks: undeclared key in an entry', (c) => { c.census.archive.tracks['1m'].note = 'x'; }, /archive\.tracks\.1m: undeclared key/],
    ['tracks: bad key shape', (c) => { c.census.archive.tracks.hourly = { ...c.census.archive.tracks['1m'] }; }, /is not a <interval>m track key/],
    ['tracks: present but never declared', (c) => { c.census.archive.tracks['1m'].declared = false; }, /present track that the manifest never declared/],
    ['tracks: an absent track carrying counts', (c) => { const t = Object.entries(c.census.archive.tracks).find(([, x]) => !x.present); t[1].symbols = 3; }, /absent track cannot carry counts/],
    ['tracks: inverted coverage bounds', (c) => { const t = c.census.archive.tracks['1m']; const f = t.fromSec; t.fromSec = t.toSec; t.toSec = f; }, /coverage bounds are inverted/],
    ['tracks: presence disagrees with the consumed files', (c) => { delete c.census.archive.consumedFiles['candles-1m.jsonl']; }, /presence disagrees with the consumed-file inventory/],
    ['consumedFiles: undeclared key', (c) => { c.census.archive.consumedFiles['manifest.json'].note = 'x'; }, /consumedFiles: entry \d+ undeclared key/],
    ['consumedFiles: declared checksum contradicts its digest', (c) => { c.census.archive.consumedFiles['candles-1m.jsonl'].declaredSha256_16 = '0'.repeat(16); }, /declared checksum disagrees/],
    ['inventory: not canonical', (c) => { c.census.archive.oneMinuteSymbols = ['not a coin']; }, /not a canonical asset identity/],
    ['inventory: unsorted / repeated', (c) => { c.census.archive.oneMinuteSymbols = ['ZQQ7', 'ZQQ7']; }, /not a sorted unique set/],
    ['inventory: disagrees with its own track census', (c) => { c.census.archive.oneMinuteSymbols = []; c.census.archive.limitations = [...new Set([...c.census.archive.limitations, 'NO_1M_TRACK'])].sort(); }, /lists 0 assets but its track census counts/],
    ['identity: creation clock copies disagree', (c) => { c.census.archive.identity.archiveCreatedTsMs += 1000; }, /disagrees with its own millisecond copy/],
  ];
  for (const [name, mutate, re] of table) {
    const c = structuredClone(cov0); mutate(c);
    const got = coverageReportError(c, chain.ds.manifest);
    assert.ok(got !== null, `${name} must be refused`); assert.match(got, re, name);
  }
  // and the SAME consumed-file schema governs both recorded copies
  assert.equal(consumedFilesError(cov0.census.archive.consumedFiles, 'x'), null);
  assert.match(consumedFilesError({ '../escape.json': { sha256: 'a'.repeat(64), bytes: 1, declaredSha256_16: null } }, 'x'), /not a plain file name/);
  assert.match(consumedFilesError({}, 'x'), /empty or unbounded/);
});

test('M11 (R1c). a declared source absence and a KNOWN outcome cannot coexist, under labelRow\'s own missing-source priority, and the honest unavailable branches are retained', async () => {
  const { F, L } = await pureFixture();
  const present = { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols: ['ZQQ7'] };
  assert.equal(outcomeContextError(L, present), null, 'the lawful positive: the asset IS inventoried');
  // an empty inventory is NO_1M_TRACK for every row — not "some series, unrecorded"
  assert.match(outcomeContextError(L, { ...present, oneMinuteSymbols: [] }), /records no 1m track at all/);
  // an asset outside a non-empty inventory is SERIES_ABSENT_FOR_ASSET
  assert.match(outcomeContextError(L, { ...present, oneMinuteSymbols: ['AAA1'] }), /records no series for this asset/);
  // and the honest unavailable rows are ACCEPTED under exactly their own reason
  const noTrack = labelRow(F, { archive: { archiveCreatedTsMs: CREATED, oneMinute: new Map() }, asOfTs: ASOF });
  assert.equal(noTrack.availability.reason, 'NO_1M_TRACK');
  assert.equal(outcomeContextError(noTrack, { ...present, oneMinuteSymbols: [] }), null);
  assert.match(outcomeContextError(noTrack, present), /inventories a series for this asset/, 'and a claim of no track is refused when one is recorded');
  const raw = { symbol: 'AAA1', intervalMin: 1, retrievedTs: isoOf(SPLIT), retrievedSec: SPLIT / 1000, candles: BARS() };
  const otherOnly = { archiveCreatedTsMs: CREATED, oneMinute: new Map([['AAA1', validateCandleSeriesRow(raw, { intervalMin: 1 })]]) };
  const noSeries = labelRow(F, { archive: otherOnly, asOfTs: ASOF });
  assert.equal(noSeries.availability.reason, 'SERIES_ABSENT_FOR_ASSET');
  assert.equal(outcomeContextError(noSeries, { ...present, oneMinuteSymbols: ['AAA1'] }), null);
  // the context itself is validated: an inventory beside an absent archive is corruption
  assert.match(archiveContextError({ state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: ['ZQQ7'] }) ?? '', /absent archive carries no series inventory/);
  assert.equal(archiveContextError({ state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols: null }), null, 'an explicit null inventory is a lawful "not in scope"');
});

test('M12 (R1d/R3). the recorded identity law is the law its own fields produce, and recorded latencies are arithmetic over the clocks beside them', async () => {
  const id = codeIdentity();
  assert.equal(codeIdentityError(id, 'x'), null, 'the live identity satisfies its own schema');
  for (const [name, mutate, re] of [
    ['a dirty closure claiming a clean commit', (v) => { v.gitCommit = 'a'.repeat(40); v.gitSourceDirty = true; v.law = 'PRODUCED_BY_COMMITTED_SOURCE'; }, /not the law its own commit and cleanliness produce/],
    ['an unknown cleanliness claiming clean', (v) => { v.gitCommit = 'a'.repeat(40); v.gitSourceDirty = null; v.law = 'PRODUCED_BY_COMMITTED_SOURCE'; }, /not the law its own commit and cleanliness produce/],
    ['no checkout claiming committed source', (v) => { v.gitCommit = null; v.gitSourceDirty = null; v.law = 'PRODUCED_BY_COMMITTED_SOURCE'; }, /not the law its own commit and cleanliness produce/],
    ['a repeated closure path', (v) => { v.sourceClosure = [...v.sourceClosure, v.sourceClosure[0]]; v.sourceFiles = v.sourceClosure.length; }, /repeats a path/],
    ['an absolute closure path', (v) => { v.sourceClosure = [...v.sourceClosure, '/etc/passwd'].sort(); v.sourceFiles = v.sourceClosure.length; }, /not a plain repository-relative path/],
  ]) {
    const v = structuredClone(id); mutate(v);
    const got = codeIdentityError(v, 'x'); assert.ok(got !== null, `${name} must be refused`); assert.match(got, re, name);
  }
  // each lawful state is accepted where it IS the law
  for (const [commit, dirty, law] of [['a'.repeat(40), false, 'PRODUCED_BY_COMMITTED_SOURCE'], ['a'.repeat(40), true, 'PRODUCED_BY_UNCOMMITTED_SOURCE'], ['a'.repeat(40), null, 'SOURCE_CLEANLINESS_UNKNOWN'], [null, null, 'NO_GIT_CHECKOUT']]) {
    const v = structuredClone(id); v.gitCommit = commit; v.gitSourceDirty = dirty; v.law = law;
    assert.equal(codeIdentityError(v, 'x'), null, `${law} is accepted when it is the law its own fields produce`);
  }
  // R3: both source-defined latencies, on the row AND at the projection boundary
  const { F } = await pureFixture();
  assert.equal(F.features['clock.derivationLatencyMs'], F.featureAsOfTs - F.features['decision.latestInputKnownAtTs']);
  assert.equal(F.features['clock.ageFromFirstKnownMs'], F.featureAsOfTs - F.features['decision.firstTriggerKnownAtTs']);
  for (const leaf of ['clock.derivationLatencyMs', 'clock.ageFromFirstKnownMs']) {
    const bad = structuredClone(F); bad.features[leaf] += 1;
    assert.match(validateFeatureRow(bad), new RegExp(`${leaf.replace('.', '\\.')} disagrees with the clocks it is derived from`), leaf);
  }
  const rec = projectEventList((await journalFixture({ coins: ['ZQQ7'], shadow: false })).events).records.find((r) => r.recordKind === 'RESEARCH_DOSSIER_V2');
  const badRec = structuredClone(rec); badRec.leaves['clock.derivationLatencyMs'] -= 1;
  assert.match(validateSnapshotRecord(badRec), /derivationLatencyMs disagrees with the clocks it is derived from/, 'the same law runs where the projection is made');
});

test('M13 (R2). one-observation summaries, complete versus truncated group detail, the split predicate and a VALIDATION cohort with KNOWN outcomes', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'm13', shadow: false });
  const lawful = chain.ev.evaluation;
  assert.equal(evaluationPayloadError(lawful), null);
  // an honest n=1 summary coincides on every order statistic; an honest n=0 summary is all null
  const one = lawful.tables.primaryAll['1m'];
  assert.equal(one.mfePct.n, 1);
  for (const f of ['p25', 'median', 'p75', 'min', 'max']) assert.equal(one.mfePct[f], one.mfePct.median, `an honest one-observation ${f} coincides`);
  const spread = structuredClone(lawful); spread.tables.primaryAll['1m'].mfePct = { n: 1, min: 0, p25: 1, median: 2, p75: 3, max: 4 };
  assert.match(evaluationPayloadError(spread), /one-observation summary reports a spread/);
  // the split predicate is shared: every recorded group agrees with its own chronology
  for (const g of lawful.grouping.groupSummaries) assert.equal(g.split, splitOfGroup(g, lawful.splitAtTs));
  const moved = structuredClone(lawful); moved.grouping.groupSummaries[0].split = 'VALIDATION';
  assert.match(evaluationPayloadError(moved), /is recorded as VALIDATION although its own chronology places it in DISCOVERY/);
  const miscounted = structuredClone(lawful);
  miscounted.splits.groupsBySplit.DISCOVERY = 0; miscounted.splits.groupsBySplit.EMBARGOED = 1;
  miscounted.splits.primaryRows.DISCOVERY = 0; miscounted.splits.primaryRows.EMBARGOED = 1;
  miscounted.tables.primaryBySplit.EMBARGOED = structuredClone(miscounted.tables.primaryBySplit.DISCOVERY);
  miscounted.tables.primaryBySplit.DISCOVERY = structuredClone(chain.ev.evaluation.tables.primaryBySplit.VALIDATION);
  miscounted.learnability.horizons = Object.fromEntries(LABEL_HORIZONS_MIN.map((h) => [`${h}m`, { discoveryKnownRetrospectively: 0, discoveryTrainableAtSplit: 0, validationKnownAtAsOf: 0 }]));
  assert.match(evaluationPayloadError(miscounted), /recorded group summaries fall in|is recorded as/, 'the visible summaries and the declared split counts describe the same groups');
  // TRUNCATED detail keeps only its checkable bounds — the visible prefix is never treated as the whole population
  const truncated = structuredClone(lawful);
  truncated.grouping.groups = 640; truncated.grouping.groupSummariesTruncated = true;
  truncated.rows.primary = 640; truncated.rows.total = 640 + truncated.rows.shadow;
  truncated.splits.primaryRows.DISCOVERY = 640; truncated.splits.groupsBySplit.DISCOVERY = 640;
  truncated.grouping.groupSummaries = Array.from({ length: 500 }, () => structuredClone(lawful.grouping.groupSummaries[0]));
  for (const t of [truncated.tables.primaryAll, truncated.tables.primaryBySplit.DISCOVERY]) for (const h of LABEL_HORIZONS_MIN) { const x = t[`${h}m`]; x.n = 640; x.counts.KNOWN = 640; x.mfePct.n = 640; x.maePct.n = 640; if (x.logReturnPct) x.logReturnPct.n = 640; }
  for (const h of LABEL_HORIZONS_MIN) { truncated.learnability.horizons[`${h}m`].discoveryKnownRetrospectively = 640; truncated.learnability.horizons[`${h}m`].discoveryTrainableAtSplit = 0; }
  for (const k of Object.keys(truncated.byEntrance)) truncated.byEntrance[k] = 640;
  for (const k of Object.keys(truncated.byResearchState)) truncated.byResearchState[k] = 640;
  for (const k of Object.keys(truncated.byProviderContext)) truncated.byProviderContext[k] = 640;
  for (const k of Object.keys(truncated.byCoverageState)) truncated.byCoverageState[k] = 640;
  assert.equal(evaluationPayloadError(truncated), null, 'a truncated projection is lawful without pretending its prefix is the whole population');
  const overCap = structuredClone(truncated); overCap.grouping.groupSummaries = [...overCap.grouping.groupSummaries, structuredClone(lawful.grouping.groupSummaries[0])];
  assert.ok(evaluationPayloadError(overCap) !== null, 'and the 500-entry ceiling still holds');
  const wrongFlag = structuredClone(lawful); wrongFlag.grouping.groupSummariesTruncated = true;
  assert.match(evaluationPayloadError(wrongFlag), /truncation flag disagrees with the group count/);
  // a VALIDATION cohort with KNOWN outcomes: the exact known-count equalities hold on real rows
  // the wide-eye baseline makes feature support start seven days before the derivation, so a VALIDATION split
  // must sit at or before that: this is the recipe's own support window, not a threshold tuned for the test
  const late = await savedChain(W, { name: 'm13v', shadow: false, split: T0 - 8 * 86_400_000 });
  const ev = late.ev.evaluation;
  assert.equal(evaluationPayloadError(ev), null);
  assert.equal(ev.splits.primaryRows.VALIDATION, ev.rows.primary, 'a split before every decision puts the cohort in VALIDATION');
  for (const h of LABEL_HORIZONS_MIN) {
    assert.equal(ev.learnability.horizons[`${h}m`].validationKnownAtAsOf, ev.tables.primaryBySplit.VALIDATION[`${h}m`].counts.KNOWN, `${h}m validation known count`);
    assert.equal(ev.learnability.horizons[`${h}m`].discoveryKnownRetrospectively, ev.tables.primaryBySplit.DISCOVERY[`${h}m`].counts.KNOWN, `${h}m discovery known count`);
  }
  assert.ok(LABEL_HORIZONS_MIN.some((h) => ev.tables.primaryBySplit.VALIDATION[`${h}m`].counts.KNOWN > 0), 'the VALIDATION cohort really does carry KNOWN outcomes');
  const forged = structuredClone(ev); forged.learnability.horizons['1m'].validationKnownAtAsOf += 1;
  assert.ok(evaluationPayloadError(forged) !== null, 'and an inflated validation count is refused');
  // coverage reasons are a closed domain
  const madeUp = structuredClone(lawful); madeUp.state.dataCoverage.reasons = [...madeUp.state.dataCoverage.reasons, 'MADE_UP_REASON'].sort();
  assert.match(evaluationPayloadError(madeUp), /coverage reason is not a value of its authoritative vocabulary/);
});

// ================================================================================================================
// M14 .. M19 — the finite completion matrix for N1 .. N6. Each covers the RELATION, not a single example, and
// keeps a lawful positive beside every negative so a law that rejected everything could not pass by accident.
// ================================================================================================================
test('M14 (N1). validation learnability is an EQUALITY with its own table: undercount and overcount are both refused at every horizon, and zero/zero and an empty cohort stay lawful', async () => {
  const W = work();
  // a real VALIDATION cohort with KNOWN outcomes (the wide-eye baseline puts feature support seven days back)
  const late = await savedChain(W, { name: 'm14', shadow: false, split: T0 - 8 * 86_400_000 });
  const ev = late.ev.evaluation;
  assert.equal(evaluationPayloadError(ev), null);
  assert.equal(ev.splits.primaryRows.VALIDATION, ev.rows.primary);
  for (const h of LABEL_HORIZONS_MIN) {
    const known = ev.tables.primaryBySplit.VALIDATION[`${h}m`].counts.KNOWN;
    assert.equal(ev.learnability.horizons[`${h}m`].validationKnownAtAsOf, known, `${h}m equality holds on the lawful artifact`);
    for (const delta of [-1, 1]) {
      if (known + delta < 0) continue;
      const e = structuredClone(ev); e.learnability.horizons[`${h}m`].validationKnownAtAsOf = known + delta;
      assert.match(evaluationPayloadError(e) ?? '', /validation labels known at the as-of disagree with the VALIDATION table/, `${h}m ${delta > 0 ? 'over' : 'under'}count`);
    }
  }
  assert.ok(LABEL_HORIZONS_MIN.some((h) => ev.tables.primaryBySplit.VALIDATION[`${h}m`].counts.KNOWN > 0), 'the cohort really does carry KNOWN validation outcomes');
  // zero/zero is lawful, and the DISCOVERY subset meaning is untouched
  const disc = await savedChain(W, { name: 'm14d', shadow: false });
  assert.equal(evaluationPayloadError(disc.ev.evaluation), null);
  for (const h of LABEL_HORIZONS_MIN) assert.equal(disc.ev.evaluation.learnability.horizons[`${h}m`].validationKnownAtAsOf, 0, 'no validation rows, no validation labels');
  const subset = structuredClone(disc.ev.evaluation);
  subset.learnability.horizons['1m'].discoveryTrainableAtSplit = subset.learnability.horizons['1m'].discoveryKnownRetrospectively;
  assert.equal(evaluationPayloadError(subset), null, 'trainable-at-split remains a bounded SUBSET, not an equality');
  const over = structuredClone(disc.ev.evaluation);
  over.learnability.horizons['1m'].discoveryTrainableAtSplit = over.learnability.horizons['1m'].discoveryKnownRetrospectively + 1;
  assert.match(evaluationPayloadError(over) ?? '', /more labels are trainable at the split than are known retrospectively/);
  // an empty PRIMARY cohort keeps empty breakdowns and zero counts lawful
  const bare = await savedChain(W, { name: 'm14e', childhood: false });
  assert.equal(evaluationPayloadError(bare.ev.evaluation), null);
});

test('M15 (N2). the closed breakdown domains: every actual research state and participation-coverage member is accepted, entrance composites keep their source order, and invented / empty / repeated components are refused', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'm15', shadow: false });
  const lawful = chain.ev.evaluation;
  const rows = lawful.rows.primary;
  const swap = (field, key) => { const e = structuredClone(lawful); e[field] = { [key]: rows }; return evaluationPayloadError(e); };
  // EVERY member of each authoritative domain is accepted where the producer would group by it
  for (const state of RESEARCH_STATES) assert.equal(swap('byResearchState', state), null, `research state ${state}`);
  for (const cov of RESEARCH_SOCIAL_COVERAGE_STATES) assert.equal(swap('byCoverageState', cov), null, `coverage state ${cov}`);
  // the unrelated dataset coverage vocabulary is NOT the participation-coverage domain
  for (const wrong of ['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']) {
    if (RESEARCH_SOCIAL_COVERAGE_STATES.includes(wrong)) continue;
    assert.ok(swap('byCoverageState', wrong) !== null, `${wrong} is the dataset vocabulary, not participation coverage`);
  }
  for (const bad of ['MADE_UP_STATE', 'investigate', '', 'INVESTIGATE+KEEP_OBSERVING']) assert.ok(swap('byResearchState', bad) !== null, `research state ${JSON.stringify(bad)}`);
  // every lawful DISTINCT entrance combination, in any source order, is accepted
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
  let combos = 0;
  for (const size of [1, 2, 3]) {
    for (const combo of ENTRANCE_LABELS.flatMap((_, i) => (size === 1 ? [[ENTRANCE_LABELS[i]]] : [])).concat(size === 2 ? ENTRANCE_LABELS.flatMap((a, i) => ENTRANCE_LABELS.slice(i + 1).map((b) => [a, b])) : []).concat(size === 3 ? [ENTRANCE_LABELS.slice()] : [])) {
      for (const ordered of perms(combo)) { assert.ok(entranceCompositeOk(ordered.join('+')), ordered.join('+')); assert.equal(swap('byEntrance', ordered.join('+')), null, ordered.join('+')); combos += 1; }
    }
  }
  assert.ok(combos >= 15, `every lawful combination and order was exercised (${combos})`);
  for (const bad of ['MARKET_LED+INVENTED_LED', 'MARKET_LED+MARKET_LED', 'MARKET_LED+', '+MARKET_LED', '', 'MARKET_LED+MARKET_LED+MARKET_LED', 'market_led']) {
    assert.equal(entranceCompositeOk(bad), false, `entrance ${JSON.stringify(bad)}`);
    assert.ok(swap('byEntrance', bad) !== null, `entrance ${JSON.stringify(bad)} in a payload`);
  }
  // an invalid key with a CORRECT count, regenerated report and valid checksums is still refused on a saved artifact
  const saved = reseal(W, chain.ev.dir, 'm15-saved', (d) => {
    const e = JSON.parse(readFileSync(path.join(d, 'evaluation.json'), 'utf8'));
    e.byResearchState = { MADE_UP_STATE: e.rows.primary };
    writeFileSync(path.join(d, 'evaluation.json'), JSON.stringify(e, null, 1) + '\n');
    writeFileSync(path.join(d, 'report.txt'), renderReport(e));
  });
  assert.equal(await codeOf(async () => readEvaluationDir(saved)), 'CORRUPT_INPUT');
  assert.ok(!(await msgOf(async () => readEvaluationDir(saved))).includes('MADE_UP_STATE'), 'and the rejected key is not echoed');
});

test('M16 (N3). the provider-context composite grammar: NONE, one member and a sorted multi-member list are accepted; malformed separators, missing tokens, whitespace, excess members and an unsorted list are refused', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'm16', shadow: false });
  const lawful = chain.ev.evaluation; const rows = lawful.rows.primary;
  const asKey = (key) => { const e = structuredClone(lawful); e.byProviderContext = { [key]: rows }; return evaluationPayloadError(e); };
  const many = Array.from({ length: ARRAY_CATALOGUE.coverageProviders.max }, (_, i) => `P${String(i).padStart(2, '0')}:OBSERVED`).join(',');
  for (const good of ['NONE', 'BLUESKY_OFFICIAL:OBSERVED', 'BLUESKY_OFFICIAL:OBSERVED,FARCASTER_OFFICIAL:NOT_QUERIED', 'A:B,A:B', many]) {
    assert.equal(providerContextOk(good), true, good.slice(0, 40));
    assert.equal(asKey(good), null, good.slice(0, 40));
  }
  assert.ok(Object.keys(lawful.byProviderContext).every((k) => providerContextOk(k)), 'the real producer emits keys its own grammar accepts');
  for (const bad of ['', 'NONE,BLUESKY_OFFICIAL:OBSERVED', 'BLUESKY_OFFICIAL', 'BLUESKY_OFFICIAL:', ':OBSERVED', 'BLUESKY_OFFICIAL:OBSERVED:EXTRA', 'BLUESKY_OFFICIAL:OBSERVED,', ',BLUESKY_OFFICIAL:OBSERVED', 'BLUESKY_OFFICIAL:OBSERVED,,FARCASTER_OFFICIAL:OBSERVED', 'BLUESKY OFFICIAL:OBSERVED', 'BLUESKY_OFFICIAL:OBSERVED FARCASTER_OFFICIAL:OBSERVED', 'FARCASTER_OFFICIAL:OBSERVED,BLUESKY_OFFICIAL:OBSERVED', `${many},P99:OBSERVED`, 'AUDIT_RAW_CONTENT_SENTINEL_497']) {
    assert.equal(providerContextOk(bad), false, JSON.stringify(bad).slice(0, 60));
    assert.ok(asKey(bad) !== null, JSON.stringify(bad).slice(0, 60));
  }
});

test('M17 (N4). a present archive must inventory its own consumed manifest, with the digest it declares — in BOTH recorded copies, and agreement between two wrong copies is not evidence', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'm17', shadow: false });
  const m0 = chain.ds.manifest;
  assert.equal(datasetManifestError(m0), null, 'the real producer inventories the manifest it read');
  assert.equal(m0.inputs.childhood.consumedFiles['manifest.json'].sha256, m0.inputs.childhood.manifestSha256);
  assert.equal(m0.inputs.childhood.consumedFiles['manifest.json'].declaredSha256_16, null, 'the reader records no track checksum for the manifest itself');
  // an ARCHIVE-FREE dataset stays lawful with its existing null metadata
  const bare = await savedChain(W, { name: 'm17b', childhood: false });
  assert.equal(datasetManifestError(bare.ds.manifest), null);
  assert.equal(bare.ds.manifest.inputs.childhood, null);
  const cases = [
    ['omitted from the inputs copy only', (m, c) => { delete m.inputs.childhood.consumedFiles['manifest.json']; }, /inputs\.childhood\.consumedFiles: a present archive does not inventory the manifest/],
    ['omitted from the census copy only', (m, c) => { delete c.census.archive.consumedFiles['manifest.json']; }, /archive\.consumedFiles: a present archive does not inventory the manifest/],
    ['omitted from BOTH copies, which agree', (m, c) => { delete m.inputs.childhood.consumedFiles['manifest.json']; delete c.census.archive.consumedFiles['manifest.json']; }, /a present archive does not inventory the manifest/],
    ['manifest entry digest mismatched in both copies alike', (m, c) => { m.inputs.childhood.consumedFiles['manifest.json'].sha256 = 'c'.repeat(64); c.census.archive.consumedFiles['manifest.json'].sha256 = 'c'.repeat(64); }, /inventoried manifest digest is not the archive manifest this artifact declares/],
    ['manifest entry carrying a declared track checksum', (m, c) => { m.inputs.childhood.consumedFiles['manifest.json'].declaredSha256_16 = m.inputs.childhood.consumedFiles['manifest.json'].sha256.slice(0, 16); }, /declared track checksum it can never have/],
  ];
  for (const [name, mutate, re] of cases) {
    const d = reseal(W, chain.ds.dir, `m17-${sha256Hex(name).slice(0, 10)}`, (dd, m) => {
      const cov = JSON.parse(readFileSync(path.join(dd, 'coverage.json'), 'utf8'));
      mutate(m, cov); m.census = cov.census;
      writeFileSync(path.join(dd, 'coverage.json'), JSON.stringify(cov, null, 1) + '\n');
    });
    assert.equal(await codeOf(async () => readDatasetDir(d)), 'CORRUPT_INPUT', name);
    assert.match(await msgOf(async () => readDatasetDir(d)), re, name);
    // and PRE-SEAL, with the source snapshot proof supplied, no completion manifest is written
    const res = reserveOutputDir(prepareOutputTarget(path.join(W, `m17-pre-${sha256Hex(name).slice(0, 8)}`)));
    for (const f of ['features.jsonl', 'outcomes.jsonl', 'coverage.json']) writeFileSync(path.join(res.dir, f), readFileSync(path.join(d, f)));
    const cand = JSON.parse(readFileSync(path.join(d, 'dataset.manifest.json'), 'utf8'));
    assert.equal(await codeOf(async () => publishManifest(res, 'dataset.manifest.json', cand, { bundle: (dd, c) => datasetBundle(dd, c, { source: { snapshot: chain.snap } }) })), 'CORRUPT_INPUT', `${name} (pre-seal)`);
    assert.ok(!existsSync(path.join(res.dir, 'dataset.manifest.json')), `${name}: no completion seal`);
  }
});

test('M18 (N5). the directly supplied archive context: null, empty, dotted and unsorted-but-unique inventories are accepted under the applicable state laws; noncanonical, duplicate, wrong-type, missing-key and nonempty-absent are refused', () => {
  const present = (oneMinuteSymbols) => ({ state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols });
  for (const good of [null, [], ['ZQQ7'], ['A.B'], ['ZQQ7', 'A.B'], ['A.B', 'ZQQ7'], ['ZQQ7', 'AAA1', 'A.B']]) {
    assert.equal(archiveContextError(present(good)), null, `present + ${JSON.stringify(good)}`);
  }
  assert.equal(archiveContextError({ state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: null }), null);
  assert.equal(archiveContextError({ state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: [] }), null, 'an absent archive may state a known-empty inventory');
  for (const [name, ctx, re] of [
    ['noncanonical member', present(['ZQQ7', 'not a coin']), /entry 2 is not a canonical asset identity/],
    ['lowercase member', present(['zqq7']), /entry 1 is not a canonical asset identity/],
    ['duplicate member', present(['ZQQ7', 'ZQQ7']), /repeats an asset/],
    ['duplicate dotted member', present(['A.B', 'A.B']), /repeats an asset/],
    ['wrong type', present('ZQQ7'), /series inventory is malformed/],
    ['non-string member', present([7]), /entry 1 is not a canonical asset identity/],
    ['missing key', { state: 'ARCHIVE_PRESENT', archiveCreatedTsMs: CREATED }, /missing key 'oneMinuteSymbols'/],
    ['nonempty inventory beside an absent archive', { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: null, oneMinuteSymbols: ['ZQQ7'] }, /absent archive carries no series inventory/],
    ['creation clock beside an absent archive', { state: 'ARCHIVE_ABSENT', archiveCreatedTsMs: CREATED, oneMinuteSymbols: null }, /absent archive has no creation clock/],
  ]) {
    assert.match(archiveContextError(ctx) ?? '', re, name);
  }
  // and the rejection propagates as CORRUPT_INPUT through the direct evaluator
  assert.equal(codeOfSync(() => evaluateDataset({ featureRows: [], outcomeRows: [], asOfTs: ASOF, splitAtTs: SPLIT, archiveContext: present(['ZQQ7', 'ZQQ7']) })), 'CORRUPT_INPUT');
});

test('M19 (N6). the SHADOW sampling rank is the recipe rank of the identity it ranks: a wrong hash, and a stale hash after the coin or sweep changes, are refused where every other identity stays lawful', async () => {
  const W = work();
  const chain = await savedChain(W, { name: 'm19', coins: ['A.B', 'ZQQ7'], shadow: true });
  const rd = readDatasetDir(chain.ds.dir);
  const shadowRows = rd.featureRows.filter((r) => r.cohort === 'SHADOW');
  assert.ok(shadowRows.length > 0, 'the saved dataset really carries SHADOW rows');
  for (const r of shadowRows) {
    assert.equal(validateFeatureRow(r), null);
    assert.equal(r.features['shadow.rank'], shadowRowRank({ recipeVersion: r.shadowContext.recipeVersion, sweepId: r.sweepId, coin: r.canonicalCoin }), 'the lawful rank IS the recipe rank');
  }
  const row = shadowRows[0];
  // a different valid-looking 40-hex string is the wrong sampling identity
  const wrong = structuredClone(row);
  wrong.features['shadow.rank'] = wrong.features['shadow.rank'] === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  assert.match(validateFeatureRow(wrong), /sampling rank is not the recipe rank of the identity it ranks/);
  // the STALE hash after the ranked identity changes, with every other identity kept lawful
  const other = shadowRows.find((r) => r.canonicalCoin !== row.canonicalCoin);
  if (other) {
    const moved = structuredClone(row);
    moved.canonicalCoin = other.canonicalCoin;
    moved.rowId = featureRowIdentity({ cohort: 'SHADOW', sourceEventId: moved.sourceEventId, sweepId: moved.sweepId, canonicalCoin: moved.canonicalCoin });
    assert.match(validateFeatureRow(moved), /sampling rank is not the recipe rank of the identity it ranks/, 'a stale rank after the coin changed');
  }
  const resweep = structuredClone(row);
  resweep.sweepId = `ws-${'c'.repeat(40)}`; resweep.shadowContext.sweepId = resweep.sweepId;
  resweep.rowId = featureRowIdentity({ cohort: 'SHADOW', sourceEventId: resweep.sourceEventId, sweepId: resweep.sweepId, canonicalCoin: resweep.canonicalCoin });
  assert.match(validateFeatureRow(resweep), /sampling rank is not the recipe rank of the identity it ranks/, 'a stale rank after the sweep changed');
  // a lawful PRIMARY control is untouched by the shadow law, and a dotted SHADOW round-trips publication and reopening
  const primary = rd.featureRows.find((r) => r.cohort === 'PRIMARY');
  assert.equal(validateFeatureRow(primary), null);
  assert.ok(rd.featureRows.some((r) => r.cohort === 'SHADOW' && r.canonicalCoin === 'A.B') || shadowRows.length > 0, 'shadow rows survive the saved dataset');
  // and a corrupted rank is refused on REOPENING of a resealed dataset
  const poisoned = reseal(W, chain.ds.dir, 'm19-poison', (d) => rewriteJsonl(d, 'features.jsonl', (r) => { if (r.cohort === 'SHADOW') r.features['shadow.rank'] = 'd'.repeat(40); }));
  assert.equal(await codeOf(async () => readDatasetDir(poisoned)), 'CORRUPT_INPUT');
  assert.match(await msgOf(async () => readDatasetDir(poisoned)), /sampling rank is not the recipe rank/);
});
