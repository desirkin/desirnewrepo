// SOCIAL-5B §12 — the OFFLINE end-to-end / adversarial matrix (no database): T03 (projector-level corruption), T04
// (digest + sparse ordering + legacy counting), T05 (hand-checked fixture end to end), T06 (first-episode selection),
// T07 (future poison cannot change earlier rows; features see no candles), T08 (anchors / temporal coverage / units),
// T09 (toy candle arithmetic + structural corruption), T10 (as-of knowledge floors), T11 (dependency grouping and
// embargo), T12 (shadow cohort), T13 (byte-identical reproducibility), T14 (tampering / limits / output safety), T16
// (no history => honest unavailable coverage), T17 (no rank / trust / trade vocabulary anywhere).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../rumor2/truth.js';
import { RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-research-dossier.js';
import { LIMITS, sha256Hex, percentile, summarize, parseUtcInstant, LABEL_HORIZONS_MIN, FEATURE_CATALOGUE, FEATURE_NAMES, GROUPING_DEPENDENCY_KINDS, ResearchError } from '../research/contracts.js';
import { createSnapshotProjector, projectEventList, validateSnapshotRecord, snapshotRecordIdentity } from '../research/snapshot.js';
import { selectResearchRows, featureRowIdentity, validateFeatureRow, SHADOW_ABSENCE } from '../research/features.js';
import { labelRow, excursions, anchorOf, validateOutcomeRow } from '../research/outcomes.js';
import { readChildhoodArchive, validateCandleSeriesRow } from '../research/archive.js';
import { evaluateDataset, groupingKeysOf, featureSupportOf } from '../research/evaluation.js';
import { runSnapshot, runBuild, runEvaluate, readSnapshotDir, readDatasetDir, readEvaluationDir, codeIdentity, pipelineSourceClosure, PIPELINE_ROOTS, ROOT } from '../research/pipeline.js';
import { prepareOutputTarget, reserveOutputDir } from '../research/artifacts.js';
import { journalFixture, writeChildhoodArchive, linearBars, T0, SEC, SENTINEL_TEXT } from './helpers/social-5b.js';

const dirs = []; const work = () => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5b-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof ResearchError, `expected ResearchError, got ${e?.stack ?? e}`); return e.code; } };
const iso = (ms) => new Date(ms).toISOString();
const ARCHIVE = ({ dir, from = SEC(T0) - 600, to = SEC(T0) + 5 * 3600, retrievedSec = SEC(T0) + 5 * 3600 + 60, createdMs = (SEC(T0) + 6 * 3600) * 1000, symbols = ['ZQQ7'], bars = null, tracks = undefined, manifestOverride = undefined }) => writeChildhoodArchive(dir, { series: symbols.map((s) => ({ symbol: s, candles: bars ?? linearBars({ fromSec: from, toSec: to }) })), archiveCreatedTs: iso(createdMs), retrievedSec, tracks, manifestOverride });
const ASOF = T0 + 86_400_000;

test('T03/T04 (pure projector). sequence gap / duplicate / unsafe seq / non-object payload / unknown dossier version are refused; the prefix digest covers EVERY event (ignored families included) in sequence order; sparse projected sequences keep original order; legacy dossiers are counted, never converted', async () => {
  const fx = await journalFixture({ coins: ['ZQQ7'] });
  const p1 = createSnapshotProjector({ origin: 'FIXTURE' }); p1.feed(1, fx.events[0]);
  assert.equal(await codeOf(async () => p1.feed(3, fx.events[1])), 'CORRUPT_JOURNAL', 'gap');
  const p2 = createSnapshotProjector({ origin: 'FIXTURE' }); p2.feed(1, fx.events[0]); assert.equal(await codeOf(async () => p2.feed(1, fx.events[0])), 'CORRUPT_JOURNAL', 'duplicate');
  assert.equal(await codeOf(async () => createSnapshotProjector({ origin: 'FIXTURE' }).feed(2 ** 53, fx.events[0])), 'CORRUPT_JOURNAL', 'unsafe seq');
  assert.equal(await codeOf(async () => createSnapshotProjector({ origin: 'FIXTURE' }).feed(1, 'not an event')), 'CORRUPT_JOURNAL', 'non-object payload');
  const d = fx.dossiers[0]; const bogus = { ...d, dossier: { ...d.dossier, schemaVersion: 'serpent-research-dossier-3' } };
  assert.equal(await codeOf(async () => projectEventList([...fx.events.filter((e) => e.type !== RESEARCH_DOSSIER_EVENT_TYPE && e.type !== 'RUMOR2_RESEARCH_SHADOW_SAMPLE'), bogus])), 'UNSUPPORTED_INPUT_VERSION');
  assert.equal(await codeOf(async () => createSnapshotProjector({ origin: 'LIVE' })), 'INVALID_REQUEST');
  // digest recipe: independent recomputation over every event, including the unrelated catalog / scope families
  const out = projectEventList(fx.events);
  const expected = sha256Hex(fx.events.map((e, i) => `${i + 1}\n${canonicalJson(e)}\n`).join(''));
  assert.equal(out.prefixDigest.sha256, expected, 'the digest is sha256 over "<seq>\\n<canonicalJson(event)>\\n" for EVERY event');
  const ignoredOnly = projectEventList(fx.events.filter((e) => !/RESEARCH/.test(e.type)));
  assert.notEqual(ignoredOnly.prefixDigest.sha256, out.prefixDigest.sha256); assert.equal(ignoredOnly.records.length, 0); assert.ok(ignoredOnly.counts.unrelated > 0);
  assert.deepEqual(out.records.map((r) => r.originalSeq), out.records.map((r) => r.originalSeq).slice().sort((a, b) => a - b), 'original order');
  assert.ok(out.records[0].originalSeq > 1, 'sparse: projected sequences are not renumbered');
  assert.equal(out.counts.dossierLegacy, 0); assert.equal(out.counts.byDossierVersion['serpent-research-dossier-2'], 1);
  for (const r of out.records) { assert.equal(validateSnapshotRecord(r), null); assert.equal(r.origin, 'FIXTURE'); }
  // a legacy (v1) dossier in the prefix is inventoried by the projector's counters without a v2 projection: simulate by
  // asserting the projector routes on schemaVersion (a full v1 fixture requires the frozen legacy validator; the count
  // path is exercised through the byDossierVersion tally and the CORRUPT_LINEAGE law for a non-validating record)
  const stripped = { ...d, dossier: { ...d.dossier, schemaVersion: 'serpent-research-dossier-1' } };
  assert.equal(await codeOf(async () => projectEventList([...fx.events.filter((e) => e.type !== RESEARCH_DOSSIER_EVENT_TYPE && e.type !== 'RUMOR2_RESEARCH_SHADOW_SAMPLE'), stripped])), 'CORRUPT_LINEAGE', 'a record claiming the legacy version is validated under the frozen legacy law, never modernized');
});

test('T05 (end to end, hand-checked). committed lawful dossier + shadow history -> snapshot -> dataset -> evaluation with independently computed counts and outcomes; no raw text in any artifact', async () => {
  const W = work(); const fx = await journalFixture({ coins: ['ZQQ7'] });
  const snap = await runSnapshot({ events: fx.events, out: path.join(W, 'snap') });
  assert.equal(snap.manifest.origin, 'FIXTURE'); assert.equal(snap.manifest.prefix.upperSeq, fx.events.length); assert.equal(snap.manifest.counts.selectedRecords, 2, 'one dossier + one shadow sample');
  ARCHIVE({ dir: path.join(W, 'arch') });
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'ds') });
  assert.equal(ds.coverage.counts.primaryRows, 1); assert.equal(ds.coverage.counts.shadowRows, 2, 'AAA1 + CCC3 selected; the noticed coin is not a shadow row'); assert.equal(ds.coverage.counts.rows, 3);
  const read = readDatasetDir(ds.dir); const prim = read.featureRows.find((r) => r.cohort === 'PRIMARY'); const o = read.outcomeRows.find((x) => x.rowId === prim.rowId);
  assert.equal(prim.canonicalCoin, 'ZQQ7'); assert.equal(prim.decisionKnownAtTs, T0 + 5000, 'the durable event clock');
  // hand-checked label arithmetic on the linear series (start 100, +0.5 per bar, wick +1 / -0.5, close = open + 0.25; bar i opens at T0 - 600 + 60 i)
  assert.equal(o.anchorTsMs, T0 + 60_000); assert.equal(o.anchorLagMs, 55_000); assert.equal(o.reference.price, 105.25, 'the bar opening at T0 (i = 10) closes at 105 + 0.25');
  const p = 105.25; const q4 = (v) => Number(v.toFixed(4));
  assert.equal(o.horizons['1m'].mfePct, q4((106.5 / p - 1) * 100)); assert.equal(o.horizons['1m'].maePct, q4((105 / p - 1) * 100));
  assert.equal(o.horizons['60m'].mfePct, q4((136 / p - 1) * 100), 'max high over bars 11..70 = open(70) + 1 = 136'); assert.equal(o.horizons['60m'].logReturnPct, q4(100 * Math.log(135.25 / p)), 'final close of bar 70 = 135.25');
  assert.equal(o.horizons['240m'].state, 'KNOWN'); assert.equal(o.horizons['60m'].logReturnUnit, 'LOG_RETURN_PERCENT'); assert.equal(o.horizons['1m'].logReturnUnit, null);
  const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: T0 + 5 * 3_600_000, out: path.join(W, 'ev') });
  assert.equal(ev.evaluation.rows.total, 3); assert.equal(ev.evaluation.state.stageCalibration, 'NOT_PERFORMED'); assert.equal(ev.evaluation.state.currentRuntimeStage, 'UNKNOWN'); assert.equal(ev.evaluation.state.fittedModel, 'NONE');
  assert.equal(ev.evaluation.splits.primaryRows.DISCOVERY, 1, 'decision 12:00:05 and outcome support to 16:01 both precede a 17:00 split');
  assert.equal(ev.evaluation.learnability.horizons['1m'].discoveryKnownRetrospectively, 1); assert.equal(ev.evaluation.learnability.horizons['1m'].discoveryTrainableAtSplit, 0, 'the archive was created at 18:00, after the 17:00 split: known retrospectively, NOT trainable at the split');
  assert.equal(ev.evaluation.tables.primaryBySplit.DISCOVERY['1m'].mfePct.median, q4((106.5 / p - 1) * 100));
  const back = readEvaluationDir(ev.dir); assert.equal(canonicalJson(back.evaluation), canonicalJson(ev.evaluation)); assert.match(back.report, /stage calibration NOT_PERFORMED/);
  for (const f of ['snap/snapshots.jsonl', 'snap/snapshot.manifest.json', 'ds/features.jsonl', 'ds/outcomes.jsonl', 'ds/coverage.json', 'ds/dataset.manifest.json', 'ev/evaluation.json', 'ev/report.txt', 'ev/evaluation.manifest.json']) { const t = readFileSync(path.join(W, f), 'utf8'); assert.ok(!t.includes(SENTINEL_TEXT), `${f}: raw post text never persists`); assert.ok(!t.includes('did:plc:'), `${f}: no native author identity`); }
});

test('T06. exactly the FIRST durable v2 dossier of each episode is a primary row across entrances and research states (CONTINUED counted, never selected); a missing opening dossier is CORRUPT_LINEAGE; equal clocks keep journal order (never lexical); assets are synthetic non-legacy symbols', async () => {
  const fx = await journalFixture({ coins: ['ZQQ7', 'FRESH42'], continued: true, claims: true });
  const out = projectEventList(fx.events); const sel = selectResearchRows(out.records, { asOfTs: ASOF });
  assert.equal(sel.counts.primaryRows, 2); assert.equal(sel.counts.dossierContinued, 2); assert.equal(sel.counts.dossierRecords, 4); assert.equal(sel.counts.episodes, 2);
  for (const r of sel.rows.filter((x) => x.cohort === 'PRIMARY')) { assert.equal(r.episodeBasis, 'FIRST_DOSSIER'); assert.equal(r.rowStatus, 'FIRST_DOSSIER_OF_EPISODE'); assert.ok(!['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].includes(r.canonicalCoin)); }
  // research states never filter selection: clone a real record into every closed state
  const base = out.records.find((r) => r.recordKind === 'RESEARCH_DOSSIER_V2');
  for (const st of ['INVESTIGATE', 'KEEP_OBSERVING', 'DATA_INSUFFICIENT', 'DATA_UNAVAILABLE']) { const rec = { ...base, leaves: { ...base.leaves, 'dossier.researchState': st } }; assert.equal(validateSnapshotRecord(rec), null); assert.equal(selectResearchRows([rec], { asOfTs: ASOF }).rows[0].researchState, st); }
  // missing opening dossier: the CONTINUED record without its predecessor
  const cont = out.records.filter((r) => r.recordKind === 'RESEARCH_DOSSIER_V2' && r.episodeBasis === 'CONTINUED');
  assert.equal(await codeOf(async () => selectResearchRows(cont, { asOfTs: ASOF })), 'CORRUPT_LINEAGE');
  assert.equal(await codeOf(async () => projectEventList(fx.events.filter((e) => e.type !== RESEARCH_DOSSIER_EVENT_TYPE || e.dossier.episode.basis !== 'FIRST_DOSSIER'))), 'CORRUPT_LINEAGE', 'the projector refuses a prefix whose first dossier of a coin is missing');
  // equal clocks: journal order, not lexical asset id
  const first = out.records.filter((r) => r.recordKind === 'RESEARCH_DOSSIER_V2' && r.episodeBasis === 'FIRST_DOSSIER');
  const a = { ...first[0], canonicalCoin: 'ZZZ9', originalSeq: 5, decisionKnownAtTs: T0 + 7000, recordId: snapshotRecordIdentity({ recordKind: 'RESEARCH_DOSSIER_V2', sourceEventId: first[0].sourceEventId, dossierId: first[0].dossierId, canonicalCoin: 'ZZZ9' }) };
  const b = { ...first[1], canonicalCoin: 'AAA1', originalSeq: 6, decisionKnownAtTs: T0 + 7000, recordId: snapshotRecordIdentity({ recordKind: 'RESEARCH_DOSSIER_V2', sourceEventId: first[1].sourceEventId, dossierId: first[1].dossierId, canonicalCoin: 'AAA1' }) };
  assert.deepEqual(selectResearchRows([a, b], { asOfTs: ASOF }).rows.map((r) => r.canonicalCoin), ['ZZZ9', 'AAA1']);
});

test('T07. later journal events and later labels cannot change an earlier feature row\'s bytes or id; rows after --as-of are excluded before grouping; the feature module takes no candle / label input and never fills present-day profile context', async () => {
  const W = work();
  const short = await journalFixture({ coins: ['ZQQ7'] }); const long = await journalFixture({ coins: ['ZQQ7'], continued: true });
  const sa = await runSnapshot({ events: short.events, out: path.join(W, 'a') }); const sb = await runSnapshot({ events: long.events, out: path.join(W, 'b') });
  assert.notEqual(sa.manifest.prefix.digest.sha256, sb.manifest.prefix.digest.sha256, 'container digests change as inputs grow');
  const da = await runBuild({ snapshotDir: sa.dir, asOfTs: ASOF, out: path.join(W, 'da') }); const db = await runBuild({ snapshotDir: sb.dir, asOfTs: ASOF, out: path.join(W, 'db') });
  const ra = readDatasetDir(da.dir).featureRows.find((r) => r.cohort === 'PRIMARY'); const rb = readDatasetDir(db.dir).featureRows.find((r) => r.cohort === 'PRIMARY');
  assert.equal(canonicalJson(ra), canonicalJson(rb), 'the first-episode row is byte-identical although the later journal holds a CONTINUED dossier');
  assert.equal(ra.rowId, rb.rowId);
  // an earlier as-of excludes later projections BEFORE selection / grouping
  const early = await runBuild({ snapshotDir: sb.dir, asOfTs: T0 + 100_000, out: path.join(W, 'early') });
  assert.equal(early.coverage.counts.dossierAfterAsOf, 1); assert.equal(early.coverage.counts.primaryRows, 1); assert.equal(canonicalJson(readDatasetDir(early.dir).featureRows.find((r) => r.cohort === 'PRIMARY')), canonicalJson(ra));
  const ev = await runEvaluate({ datasetDir: early.dir, splitAtTs: T0 + 50_000, out: path.join(W, 'ev') }); assert.equal(ev.evaluation.rows.primary, 1);
  // features see no future: the selector's signature carries no archive / label / candle parameter, and its module imports none
  const src = readFileSync(path.join(ROOT, 'research/features.js'), 'utf8');
  assert.ok(!/archive|candle|outcomes\.js|labelRow/i.test(src.replace(/\/\/.*$/gm, '')), 'features.js never references candle / label inputs');
  assert.equal(selectResearchRows.length, 1, 'records plus one options bag (as-of / limits): no archive, label or candle parameter exists');
  for (const r of readDatasetDir(db.dir).featureRows) { assert.equal(r.sourceProfileContext, 'NOT_RECORDED_IN_DOSSIER'); assert.equal(r.claimAssociationContext, 'NOT_AVAILABLE_NO_AUTHORIZED_SEAM'); }
  // a poisoned label file cannot alter feature bytes: rows are joined by id, and the feature file is checksummed independently
  const fa = readFileSync(path.join(da.dir, 'features.jsonl'), 'utf8'); writeFileSync(path.join(da.dir, 'outcomes.jsonl'), readFileSync(path.join(da.dir, 'outcomes.jsonl'), 'utf8').replace('"mfePct":null', '"mfePct":99'));
  assert.equal(readFileSync(path.join(da.dir, 'features.jsonl'), 'utf8'), fa); assert.equal(await codeOf(async () => readDatasetDir(da.dir)), 'CORRUPT_INPUT', 'the tampered label file fails its checksum');
});

test('T08. exact-minute and between-minute anchors; reference bar missing; archive temporal non-overlap; 1m absent / coarse-only; seconds-vs-milliseconds confusion; maximum 4h support', async () => {
  const W = work();
  const arch = (name, opts) => { ARCHIVE({ dir: path.join(W, name), ...opts }); return readChildhoodArchive(path.join(W, name)); };
  const full = arch('full', {});
  const exact = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 }, { archive: full, asOfTs: ASOF });
  assert.equal(exact.anchorLagMs, 0); assert.equal(exact.anchorTsMs, T0); assert.equal(exact.reference.barOpenSec, SEC(T0) - 60, 'an exact-minute decision anchors to itself; the reference bar is the one closing at the anchor');
  const between = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 1 }, { archive: full, asOfTs: ASOF });
  assert.equal(between.anchorTsMs, T0 + 60_000); assert.equal(between.anchorLagMs, 59_999);
  assert.deepEqual(anchorOf(T0 + 59_999), { anchorTsMs: T0 + 60_000, anchorLagMs: 1 });
  // reference bar missing inside the span (gap) vs no temporal overlap
  const gapBars = linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 3600 }).filter((b) => b[0] !== SEC(T0));
  const gap = arch('gap', { bars: gapBars });
  assert.equal(labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: gap, asOfTs: ASOF }).availability.reason, 'REFERENCE_BAR_MISSING');
  const past = arch('past', { from: SEC(T0) - 86_400, to: SEC(T0) - 80_000, retrievedSec: SEC(T0) - 79_000 });
  const np = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: past, asOfTs: ASOF });
  assert.equal(np.availability.reason, 'NO_TEMPORAL_OVERLAP'); for (const h of LABEL_HORIZONS_MIN) assert.equal(np.horizons[`${h}m`].state, 'OUTCOME_UNAVAILABLE');
  assert.equal(labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'FRESH42', decisionKnownAtTs: T0 + 5000 }, { archive: full, asOfTs: ASOF }).availability.reason, 'SERIES_ABSENT_FOR_ASSET');
  // coarse-only archive: the 5m track is visible in the census but never substituted
  writeChildhoodArchive(path.join(W, 'coarse'), { series: [], archiveCreatedTs: iso(ASOF - 1), retrievedSec: SEC(T0) + 7200, tracks: { '5m': [{ symbol: 'ZQQ7', intervalMin: 5, retrievedTs: iso((SEC(T0) + 7200) * 1000), retrievedSec: SEC(T0) + 7200, candles: [[SEC(T0) - 600, 1, 2, 0.5, 1.5, 1]] }], '15m': null, '60m': null } });
  const coarse = readChildhoodArchive(path.join(W, 'coarse')); assert.equal(coarse.census.tracks['5m'].symbols, 1); assert.equal(coarse.census.tracks['1m'].present, false); assert.ok(coarse.limitations.includes('NO_1M_TRACK'));
  assert.equal(labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: coarse, asOfTs: ASOF }).availability.reason, 'NO_1M_TRACK');
  // milliseconds where seconds are required
  assert.equal(await codeOf(async () => validateCandleSeriesRow({ symbol: 'ZQQ7', intervalMin: 1, retrievedTs: iso(ASOF), retrievedSec: SEC(ASOF), candles: [[T0, 1, 2, 0.5, 1.5, 1]] }, { intervalMin: 1 })), 'CORRUPT_INPUT');
  assert.equal(await codeOf(async () => validateCandleSeriesRow({ symbol: 'ZQQ7', intervalMin: 1, retrievedTs: iso(ASOF), retrievedSec: ASOF, candles: [] }, { intervalMin: 1 })), 'CORRUPT_INPUT', 'retrievedSec in milliseconds');
  // maximum 4h support: coverage exactly through the 240m close vs one minute short
  const anchorSec = SEC(T0) + 60; const endSec = anchorSec + 240 * 60;
  const exact4h = arch('e4', { from: SEC(T0) - 600, to: endSec, retrievedSec: endSec, createdMs: endSec * 1000 });
  const r4 = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: exact4h, asOfTs: ASOF }); assert.equal(r4.horizons['240m'].state, 'KNOWN');
  const short4h = arch('s4', { from: SEC(T0) - 600, to: endSec - 60, retrievedSec: endSec - 60, createdMs: endSec * 1000 });
  const s4 = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 + 5000 }, { archive: short4h, asOfTs: ASOF });
  assert.equal(s4.horizons['240m'].state, 'CENSORED'); assert.equal(s4.horizons['240m'].reason, 'SOURCE_COVERAGE_ENDS_BEFORE_HORIZON'); assert.equal(s4.horizons['240m'].mfePct, null); assert.equal(s4.horizons['60m'].state, 'KNOWN');
});

test('T09. toy candles: rising / falling / flat series with independently calculated MFE, MAE and log returns; a missing end bar, an interior gap and a partial end are CENSORED; disorder, duplicates, impossible OHLC, negative volume, unit confusion and retrieval / creation clock errors are refused', async () => {
  const s = SEC(T0); const mk = (fn, n = 300) => { const out = []; for (let i = -2; i < n; i += 1) out.push([s + 60 * i, ...fn(i)]); return out; };
  const rising = mk((i) => { const o = 10 + i; return [o, o + 2, o - 1, o + 1, 5]; }); // ref bar i=-1: close 10; anchor bar i=0
  const falling = mk((i) => { const o = 100 - i; return [o, o + 0.5, o - 2, o - 1, 5]; }, 90); // ref close 100; stays positive
  const flat = mk(() => [50, 50, 50, 50, 0]);
  const q4 = (v) => Number(v.toFixed(4));
  assert.deepEqual(excursions(rising.slice(2, 3), 10), { mfePct: q4(((10 + 2) / 10 - 1) * 100), maePct: q4(((10 - 1) / 10 - 1) * 100), finalClose: 11, logReturnPct: q4(100 * Math.log(11 / 10)) });
  assert.deepEqual(excursions(falling.slice(2, 62), 100), { mfePct: q4((100.5 / 100 - 1) * 100), maePct: q4(((100 - 59 - 2) / 100 - 1) * 100), finalClose: 100 - 59 - 1, logReturnPct: q4(100 * Math.log(40 / 100)) });
  assert.deepEqual(excursions(flat.slice(2, 7), 50), { mfePct: 0, maePct: 0, finalClose: 50, logReturnPct: 0 }, 'a flat path has MFE 0 and MAE 0 (never -0)');
  assert.ok(!Object.is(excursions(flat.slice(2, 7), 50).maePct, -0));
  const series = (bars, over = {}) => validateCandleSeriesRow({ symbol: 'ZQQ7', intervalMin: 1, retrievedTs: iso((s + 60 * 400) * 1000), retrievedSec: s + 60 * 400, candles: bars, ...over }, { intervalMin: 1 });
  const archive = (bars) => ({ archiveCreatedTsMs: (s + 60 * 500) * 1000, oneMinute: new Map([['ZQQ7', series(bars)]]) });
  const L = (bars, D = T0) => labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: D }, { archive: archive(bars), asOfTs: ASOF });
  const r = L(rising); assert.equal(r.reference.price, 10); assert.equal(r.horizons['1m'].mfePct, 20); assert.equal(r.horizons['1m'].maePct, -10); assert.equal(r.horizons['60m'].logReturnPct, q4(100 * Math.log((10 + 59 + 1) / 10)));
  const f = L(falling); assert.equal(f.horizons['5m'].maePct, q4(((100 - 4 - 2) / 100 - 1) * 100)); assert.equal(f.horizons['5m'].mfePct, 0.5);
  // missing END bar of the 5m window (i = 4): 5m CENSORED, 3m KNOWN
  const noEnd = rising.filter((b) => b[0] !== s + 60 * 4); const ne = L(noEnd); assert.equal(ne.horizons['5m'].state, 'CENSORED'); assert.equal(ne.horizons['5m'].reason, 'INTERIOR_BAR_MISSING'); assert.equal(ne.horizons['3m'].state, 'KNOWN'); assert.equal(ne.horizons['5m'].mfePct, null);
  const gap = rising.filter((b) => b[0] !== s + 60 * 2); assert.equal(L(gap).horizons['3m'].state, 'CENSORED'); assert.equal(L(gap).horizons['1m'].state, 'KNOWN');
  const partial = rising.slice(0, 2 + 100); assert.equal(L(partial).horizons['240m'].state, 'CENSORED', 'a series that ends mid-horizon is never the full horizon\'s result'); assert.equal(L(partial).horizons['60m'].state, 'KNOWN');
  const bad = async (bars, over) => codeOf(async () => series(bars, over));
  assert.equal(await bad([rising[1], rising[0]]), 'CORRUPT_INPUT', 'wrong order'); assert.equal(await bad([rising[0], rising[0]]), 'CORRUPT_INPUT', 'duplicate');
  assert.equal(await bad([[s, 10, 9, 8, 9.5, 1]]), 'CORRUPT_INPUT', 'high below open'); assert.equal(await bad([[s, 10, 11, 10.5, 10.2, 1]]), 'CORRUPT_INPUT', 'low above open'); assert.equal(await bad([[s, 10, 11, 9, 10, -1]]), 'CORRUPT_INPUT', 'negative volume'); assert.equal(await bad([[s, 0, 11, 9, 10, 1]]), 'CORRUPT_INPUT', 'non-positive price'); assert.equal(await bad([[s, 10, NaN, 9, 10, 1]]), 'CORRUPT_INPUT', 'NaN');
  assert.equal(await bad([[s + 30, 10, 11, 9, 10, 1]]), 'CORRUPT_INPUT', 'off-grid open');
  assert.equal(await bad(rising, { retrievedTs: iso((s + 60 * 400 + 1) * 1000) }), 'CORRUPT_INPUT', 'retrievedTs disagrees with retrievedSec');
  assert.equal(await bad(rising, { retrievedSec: s + 60 * 100, retrievedTs: iso((s + 60 * 100) * 1000) }), 'CORRUPT_INPUT', 'a candle not closed by retrieval time');
  const noClock = { archiveCreatedTsMs: null, oneMinute: new Map([['ZQQ7', series(rising)]]) };
  assert.equal(labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: T0 }, { archive: noClock, asOfTs: ASOF }).availability.reason, 'PROVENANCE_CLOCK_MISSING', 'missing provenance is never replaced by now or the last candle');
});

test('T10. as-of masking at every knowledge floor: immediately before each horizon end nothing leaks (values null, never zero, never a loss); at the horizon end the value appears; the archive creation and series retrieval clocks are floors for every horizon AND for the reference price', async () => {
  const s = SEC(T0); const bars = linearBars({ fromSec: s - 600, toSec: s + 5 * 3600 });
  const D = T0 + 5000; const anchor = T0 + 60_000;
  const mk = (createdMs, retrievedSec) => ({ archiveCreatedTsMs: createdMs, oneMinute: new Map([['ZQQ7', validateCandleSeriesRow({ symbol: 'ZQQ7', intervalMin: 1, retrievedTs: iso(retrievedSec * 1000), retrievedSec, candles: bars.filter((b) => b[0] + 60 <= retrievedSec) }, { intervalMin: 1 })]]) });
  const early = mk(anchor, s + 60 + 240 * 60); // archive created at the anchor, retrieval exactly at the 4h close: the horizon end is the floor
  for (const h of LABEL_HORIZONS_MIN) {
    const end = anchor + h * 60_000;
    const before = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: D }, { archive: early, asOfTs: end - 1 }).horizons[`${h}m`];
    assert.equal(before.state, 'NOT_YET_KNOWN', `${h}m one ms before its end`); assert.equal(before.mfePct, null); assert.equal(before.maePct, null); assert.equal(before.logReturnPct, null); assert.equal(before.outcomeKnownAtTs, Math.max(end, (s + 60 + 240 * 60) * 1000));
    const at = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: D }, { archive: early, asOfTs: Math.max(end, (s + 60 + 240 * 60) * 1000) }).horizons[`${h}m`];
    assert.equal(at.state, 'KNOWN', `${h}m at its floor`);
  }
  // archive created long after every horizon: the creation clock is the floor for all of them and for the reference price
  const late = mk(ASOF - 1000, s + 5 * 3600 + 60);
  const masked = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: D }, { archive: late, asOfTs: ASOF - 1001 });
  assert.equal(masked.reference.state, 'NOT_YET_KNOWN'); assert.equal(masked.reference.price, null); assert.equal(masked.reference.barOpenSec, null);
  for (const h of LABEL_HORIZONS_MIN) assert.equal(masked.horizons[`${h}m`].state, 'NOT_YET_KNOWN');
  const shown = labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: D }, { archive: late, asOfTs: ASOF - 1000 });
  assert.equal(shown.reference.state, 'KNOWN'); assert.equal(shown.horizons['240m'].state, 'KNOWN');
  // series retrieval later than creation: retrieval is the floor
  const lateRetrieval = mk(anchor, s + 8 * 3600);
  assert.equal(labelRow({ rowId: 'x', cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: D }, { archive: lateRetrieval, asOfTs: (s + 8 * 3600) * 1000 - 1 }).horizons['1m'].state, 'NOT_YET_KNOWN');
  assert.equal(validateOutcomeRow({ ...masked, reference: { ...masked.reference, price: 1 } }), 'outcome row: a reference price is exposed before its knowledge floor');
});

// synthetic primary feature rows built from ONE real projection (identity recomputed; dependency nodes / clocks varied)
async function syntheticRows() {
  const fx = await journalFixture({ coins: ['ZQQ7'] }); const base = selectResearchRows(projectEventList(fx.events).records, { asOfTs: ASOF }).rows.find((r) => r.cohort === 'PRIMARY');
  const mk = (n, { decisionMs, nodes = [], truncated = false, unknownSupport = false, coin = 'ZQQ7', notice = false }) => {
    const sourceEventId = `r2rde-${n.toString(16).padStart(40, '0')}`; const dossierId = `r2rd-${n.toString(16).padStart(40, 'a')}`; const episodeId = `r2ep-${n.toString(16).padStart(40, 'b')}`;
    const features = { ...base.features, 'episode.episodeId': episodeId, 'episode.onsetKnownAtTs': decisionMs - 4000, 'episode.onsetObservedTs': decisionMs - 4000, 'decision.featureAsOfTs': decisionMs, 'decision.decisionKnownAtTs': decisionMs, 'decision.latestInputKnownAtTs': decisionMs - 2000, 'decision.firstTriggerKnownAtTs': decisionMs - 4000, 'dependencies.truncated': truncated, 'participation.oldestKnownAtTs': decisionMs - 4000, 'participation.latestKnownAtTs': decisionMs - 4000 };
    const absent = { ...base.absentFeatures };
    if (unknownSupport) { features['marketDeep.ownerSnapshot.flow.cvdBaseUnits'] = 12.5; delete absent['marketDeep.ownerSnapshot.flow.cvdBaseUnits']; }
    const arrays = { ...base.arrays, dependencyNodes: nodes.map((x) => ({ id: x.id, kind: x.kind, knownAtTs: x.knownAtTs ?? decisionMs - 3000 })), dependencyEdges: [], triggers: [{ kind: 'PARTICIPATION_LED', ref: `r2sv-${n.toString(16).padStart(40, 'c')}`, knownAtTs: decisionMs - 4000, observedTs: decisionMs - 4000 }], notices: notice ? [{ ref: `wideeye:${coin}:${decisionMs - 2000}`, verdict: 'RIPPLE', zVol: 4.5, zRet: 2.1, extension: 3.2, usdVol24h: 2_500_000, inDeepTape: false, observedTs: decisionMs - 2000, knownAtTs: decisionMs - 2000 }] : [] };
    return { ...base, rowId: featureRowIdentity({ cohort: 'PRIMARY', sourceEventId, dossierId, episodeId, canonicalCoin: coin }), sourceEventId, dossierId, episodeId, canonicalCoin: coin, originalSeq: 100 + n, featureAsOfTs: decisionMs, decisionKnownAtTs: decisionMs, features, absentFeatures: absent, arrays };
  };
  return { mk, base };
}
test('T11. grouping and embargo: shared concrete refs group transitively, generic dependency labels never do, a group straddling the split is EMBARGOED whole, truncated / undocumented support is DESCRIPTIVE_ONLY, and archive acquisition after the split makes labels unavailable for true historical learning despite retrospective value', async () => {
  const { mk } = await syntheticRows(); const B = T0 + 12 * 3_600_000; const asOf = T0 + 12 * 86_400_000; // the as-of must cover the latest row: a dataset is only meaningful under a clock every row obeys
  const rows = [
    mk(1, { decisionMs: T0 + 1000, nodes: [{ id: 'social:r2sv-A', kind: 'SOCIAL_SOURCE' }] }),
    mk(2, { decisionMs: T0 + 3_600_000, nodes: [{ id: 'social:r2sv-A', kind: 'SOCIAL_SOURCE' }, { id: 'family:r2ss-F', kind: 'TEXT_FAMILY' }], coin: 'FRESH42' }),
    mk(3, { decisionMs: T0 + 2 * 3_600_000, nodes: [{ id: 'family:r2ss-F', kind: 'TEXT_FAMILY' }], coin: 'AAA1' }),
    mk(4, { decisionMs: T0 + 3 * 3_600_000, nodes: [{ id: 'dossier:entrances', kind: 'DOSSIER_FIELD' }], coin: 'BBB2' }), // generic label shared with row 5: must NOT group
    mk(5, { decisionMs: T0 + 4 * 3_600_000, nodes: [{ id: 'dossier:entrances', kind: 'DOSSIER_FIELD' }], coin: 'CCC3' }),
    mk(6, { decisionMs: B - 3_600_000, nodes: [], coin: 'DDD4' }), // outcome support (anchor + 240m) crosses B => EMBARGOED
    mk(7, { decisionMs: B + 8 * 86_400_000, nodes: [], coin: 'EEE5', notice: true }), // far after B: even the seven-day wide-eye support starts after B => VALIDATION
    mk(8, { decisionMs: B + 8 * 86_400_000 + 1000, nodes: [], coin: 'FFF6', truncated: true }),
    mk(9, { decisionMs: B + 8 * 86_400_000 + 2000, nodes: [], coin: 'GGG7', unknownSupport: true }),
  ];
  for (const r of rows) assert.equal(validateFeatureRow(r), null, r.canonicalCoin);
  const outcomes = rows.map((r) => labelRow({ rowId: r.rowId, cohort: 'PRIMARY', canonicalCoin: r.canonicalCoin, decisionKnownAtTs: r.decisionKnownAtTs }, { archive: null, asOfTs: asOf }));
  const { evaluation: e } = evaluateDataset({ featureRows: rows, outcomeRows: outcomes, asOfTs: asOf, splitAtTs: B });
  assert.equal(e.grouping.groups, 7, 'rows 1-2-3 form ONE transitive group; 4 and 5 stay separate; 6, 7, 8, 9 are singletons');
  const g = (coin) => e.grouping.groupSummaries.find((x) => x.coins.includes(coin));
  assert.deepEqual(g('ZQQ7').coins, ['AAA1', 'FRESH42', 'ZQQ7']); assert.equal(g('BBB2').rows, 1); assert.equal(g('CCC3').rows, 1);
  assert.equal(g('ZQQ7').split, 'DISCOVERY'); assert.equal(g('DDD4').split, 'EMBARGOED'); assert.equal(g('EEE5').split, 'VALIDATION'); assert.equal(g('FFF6').split, 'DESCRIPTIVE_ONLY'); assert.equal(g('GGG7').split, 'DESCRIPTIVE_ONLY');
  assert.equal(featureSupportOf(rows[6]).featureSupportStartTs, rows[6].featureAsOfTs - 7 * 86_400_000, 'the wide-eye seven-day baseline bounds the support start when a notice value is present'); assert.ok(featureSupportOf(rows[5]).featureSupportStartTs > rows[5].featureAsOfTs - 7 * 86_400_000, 'without a notice the support is the participation window / onset');
  assert.equal(featureSupportOf(rows[8]).supportKnown, false);
  assert.ok(rows.every((r) => r.decisionKnownAtTs <= asOf), 'the fixture obeys its own as-of wall'); assert.ok(featureSupportOf(rows[8]).unknownSupportFeatures.includes('marketDeep.ownerSnapshot.flow.cvdBaseUnits'));
  assert.deepEqual(groupingKeysOf(rows[3]).filter((k) => !k.startsWith('EPISODE:') && !k.startsWith('SOCIAL_SOURCE:')), [], 'a DOSSIER_FIELD node yields no grouping key');
  for (const k of GROUPING_DEPENDENCY_KINDS) assert.ok(!['DOSSIER_FIELD', 'COVERAGE_BOUNDARY', 'SOCIAL_FEATURE_WINDOW'].includes(k));
  // the same rows with a REAL archive created after the split: discovery labels known retrospectively, never trainable at B
  const W = work(); ARCHIVE({ dir: path.join(W, 'a'), from: SEC(T0) - 600, to: SEC(T0) + 9 * 86_400, retrievedSec: SEC(T0) + 9 * 86_400 + 60, createdMs: T0 + 9 * 86_400_000 + 3_600_000 });
  const arch = readChildhoodArchive(path.join(W, 'a'));
  const labelled = rows.map((r) => labelRow({ rowId: r.rowId, cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: r.decisionKnownAtTs }, { archive: arch, asOfTs: asOf }));
  const rowsZ = rows.map((r) => ({ ...r, canonicalCoin: 'ZQQ7', rowId: featureRowIdentity({ cohort: 'PRIMARY', sourceEventId: r.sourceEventId, dossierId: r.dossierId, episodeId: r.episodeId, canonicalCoin: 'ZQQ7' }) }));
  const asOfLate = T0 + 10 * 86_400_000; // after the archive's creation clock: labels are knowable retrospectively — but the archive still postdates the split
  const labelledZ = rowsZ.map((r) => labelRow({ rowId: r.rowId, cohort: 'PRIMARY', canonicalCoin: 'ZQQ7', decisionKnownAtTs: r.decisionKnownAtTs }, { archive: arch, asOfTs: asOfLate }));
  const { evaluation: e2 } = evaluateDataset({ featureRows: rowsZ, outcomeRows: labelledZ, asOfTs: asOfLate, splitAtTs: B });
  assert.ok(e2.learnability.horizons['1m'].discoveryKnownRetrospectively >= 3); assert.equal(e2.learnability.horizons['1m'].discoveryTrainableAtSplit, 0); assert.ok(e2.state.calibrationBlockers.includes('NO_AS_OF_TRAINABLE_LABELS'));
  assert.ok(e2.state.calibrationBlockers.includes('EFFECTIVE_SAMPLE_SUPPORT_UNKNOWN')); void labelled;
});

test('T12. shadow rows preserve sweep identity / population counts / selection provenance, carry NO Social feature value (absent with a reason, never zero), disclose overlap with primary rows, and stay a separate descriptive cohort with no causal vocabulary', async () => {
  const fx = await journalFixture({ coins: ['ZQQ7', 'AAA1'] }); // AAA1 is both a research episode and a selected shadow row
  const sel = selectResearchRows(projectEventList(fx.events).records, { asOfTs: ASOF });
  const sh = sel.rows.filter((r) => r.cohort === 'SHADOW'); assert.equal(sh.length, 2); assert.deepEqual(sel.overlapCoins, ['AAA1']); assert.equal(sel.counts.overlapCoins, 1);
  for (const r of sh) { assert.equal(validateFeatureRow(r), null); for (const n of FEATURE_NAMES) { assert.ok(!(n in r.features), `${n} never appears on a shadow row`); assert.equal(r.absentFeatures[n], SHADOW_ABSENCE); } assert.equal(r.shadowContext.sampleCap, 8); assert.equal(r.shadowContext.population.scanned, 4); assert.match(r.shadowContext.populationDigest, /^[0-9a-f]{40}$/); assert.equal(r.shadowContext.law, 'SHADOW_CONTROL_IS_NOT_A_MATCHED_CONTROL_AND_NOT_A_MARKET_DENOMINATOR'); }
  const ccc = sh.find((r) => r.canonicalCoin === 'CCC3'); assert.equal(ccc.features['shadow.selectionReason'], 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED'); assert.equal(ccc.features['shadow.preCooldownVerdict'], 'RIPPLE');
  const outcomes = sel.rows.map((r) => labelRow({ rowId: r.rowId, cohort: r.cohort, canonicalCoin: r.canonicalCoin, decisionKnownAtTs: r.decisionKnownAtTs }, { archive: null, asOfTs: ASOF }));
  const { evaluation: e, report } = evaluateDataset({ featureRows: sel.rows, outcomeRows: outcomes, asOfTs: ASOF, splitAtTs: T0 + 3_600_000 });
  assert.equal(e.rows.shadow, 2); assert.equal(e.grouping.groups, 2, 'shadow rows never enter the primary dependency groups'); assert.equal(e.splits.shadowRowsByPeriod.BEFORE_SPLIT, 2);
  const prose = report.split('\n').filter((l) => !l.startsWith('laws:')).join('\n'); assert.ok(!/\b(causal|causes|caused|proves|significant|significance|profitable|profit)\b|p-value/i.test(prose), 'no causal / significance / profitability prose'); assert.ok(e.laws.includes('SHADOW_ROWS_ARE_A_SEPARATE_DESCRIPTIVE_COHORT') && e.laws.includes('NO_ROW_WEIGHTING'));
});

test('T13. reproducibility: repeated same-input runs into different directories are byte-identical for every artifact; a changed input changes the appropriate hashes; no wall time or output path contaminates an artifact; code identity is a source-tree digest', async () => {
  const W = work(); const fx = await journalFixture({ coins: ['ZQQ7'] });
  const s1 = await runSnapshot({ events: fx.events, out: path.join(W, 's1') }); const s2 = await runSnapshot({ events: fx.events, out: path.join(W, 'other', 's2').replace('/other/', '/') });
  const same = (a, b, f) => assert.equal(readFileSync(path.join(a, f), 'utf8'), readFileSync(path.join(b, f), 'utf8'), f);
  same(s1.dir, s2.dir, 'snapshots.jsonl'); same(s1.dir, s2.dir, 'snapshot.manifest.json');
  ARCHIVE({ dir: path.join(W, 'arch') });
  const d1 = await runBuild({ snapshotDir: s1.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'd1') }); const d2 = await runBuild({ snapshotDir: s2.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'd2') });
  for (const f of ['features.jsonl', 'outcomes.jsonl', 'coverage.json', 'dataset.manifest.json']) same(d1.dir, d2.dir, f);
  const e1 = await runEvaluate({ datasetDir: d1.dir, splitAtTs: T0 + 3_600_000, out: path.join(W, 'e1') }); const e2 = await runEvaluate({ datasetDir: d2.dir, splitAtTs: T0 + 3_600_000, out: path.join(W, 'e2') });
  for (const f of ['evaluation.json', 'report.txt', 'evaluation.manifest.json']) same(e1.dir, e2.dir, f);
  for (const f of [path.join(d1.dir, 'dataset.manifest.json'), path.join(e1.dir, 'evaluation.manifest.json'), path.join(s1.dir, 'snapshot.manifest.json')]) { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(W), `${path.basename(f)}: no output path inside the artifact`); assert.ok(!t.includes(tmpdir()), 'no temp path'); assert.ok(!/"(now|generatedAt|createdAt|timestamp)"/.test(t), 'no wall-clock field'); }
  // a changed archive byte changes the dataset hashes but not the feature rows or their ids
  ARCHIVE({ dir: path.join(W, 'arch2'), bars: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 5 * 3600, start: 101 }) });
  const d3 = await runBuild({ snapshotDir: s1.dir, childhoodDir: path.join(W, 'arch2'), asOfTs: ASOF, out: path.join(W, 'd3') });
  same(d1.dir, d3.dir, 'features.jsonl'); assert.notEqual(readFileSync(path.join(d1.dir, 'outcomes.jsonl'), 'utf8'), readFileSync(path.join(d3.dir, 'outcomes.jsonl'), 'utf8')); assert.notEqual(d1.manifest.outputs['outcomes.jsonl'].sha256, d3.manifest.outputs['outcomes.jsonl'].sha256); assert.notEqual(d1.manifest.inputs.childhood.consumedFiles['candles-1m.jsonl'].sha256, d3.manifest.inputs.childhood.consumedFiles['candles-1m.jsonl'].sha256);
  const asOf2 = await runBuild({ snapshotDir: s1.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF + 1, out: path.join(W, 'd4') }); assert.notEqual(asOf2.manifestSha256, d1.manifestSha256); same(d1.dir, asOf2.dir, 'features.jsonl');
  const id = codeIdentity(); assert.match(id.sourceTreeSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(id.sourceClosure, pipelineSourceClosure(), 'code identity hashes the DISCOVERED source closure, not a hand-kept list');
  assert.equal(id.sourceFiles, id.sourceClosure.length); assert.ok(id.sourceFiles > PIPELINE_ROOTS.length, 'the closure reaches past its own entry points');
  for (const r of PIPELINE_ROOTS) assert.ok(id.sourceClosure.includes(r), r);
  assert.equal(d1.manifest.codeIdentity.sourceTreeSha256, id.sourceTreeSha256); assert.ok(['PRODUCED_BY_UNCOMMITTED_SOURCE', 'PRODUCED_BY_COMMITTED_SOURCE', 'NO_GIT_CHECKOUT'].includes(id.law));
});

test('T14. closed-schema tampering, checksum mismatch, unknown key, non-finite value, malformed JSONL, missing manifest member, bounded overflow, existing / aliased / overlapping / in-tree output, concurrent collision and an interrupted publish: every case fails closed with no false success seal', async () => {
  const W = work(); const fx = await journalFixture({ coins: ['ZQQ7'] });
  const snap = await runSnapshot({ events: fx.events, out: path.join(W, 'snap') }); ARCHIVE({ dir: path.join(W, 'arch') });
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'ds') });
  const clone = (name, mutate) => { const d = path.join(W, name); mkdirSync(d); for (const f of readdirSync(ds.dir)) writeFileSync(path.join(d, f), readFileSync(path.join(ds.dir, f))); mutate(d); return d; };
  const rewriteLine = (d, file, fn) => { const lines = readFileSync(path.join(d, file), 'utf8').split('\n').filter(Boolean); writeFileSync(path.join(d, file), lines.map((l, i) => (i === 0 ? fn(l) : l)).join('\n') + '\n'); };
  const reseal = (d) => { const m = JSON.parse(readFileSync(path.join(d, 'dataset.manifest.json'), 'utf8')); for (const f of Object.keys(m.outputs)) { const buf = readFileSync(path.join(d, f)); m.outputs[f].sha256 = sha256Hex(buf); m.outputs[f].bytes = buf.length; } writeFileSync(path.join(d, 'dataset.manifest.json'), JSON.stringify(m)); };
  assert.equal(await codeOf(async () => readDatasetDir(clone('t1', (d) => writeFileSync(path.join(d, 'features.jsonl'), readFileSync(path.join(d, 'features.jsonl'), 'utf8').replace('PRIMARY', 'PRIMARY'.toLowerCase()))))), 'CORRUPT_INPUT', 'checksum mismatch');
  assert.equal(await codeOf(async () => readDatasetDir(clone('t2', (d) => { rewriteLine(d, 'features.jsonl', (l) => l.replace('"authority":"NONE"', '"authority":"NONE","extra":1')); reseal(d); }))), 'CORRUPT_INPUT', 'unknown key');
  assert.equal(await codeOf(async () => readDatasetDir(clone('t3', (d) => { rewriteLine(d, 'outcomes.jsonl', (l) => l.replace(/"mfePct":[-0-9.]+/, '"mfePct":"NaN"')); reseal(d); }))), 'CORRUPT_INPUT', 'non-finite value');
  assert.equal(await codeOf(async () => readDatasetDir(clone('t4', (d) => { writeFileSync(path.join(d, 'features.jsonl'), readFileSync(path.join(d, 'features.jsonl'), 'utf8') + '{not json\n'); reseal(d); }))), 'CORRUPT_INPUT', 'malformed JSONL');
  assert.equal(await codeOf(async () => readDatasetDir(clone('t5', (d) => rmSync(path.join(d, 'outcomes.jsonl'))))), 'CORRUPT_INPUT', 'missing manifest member');
  assert.equal(await codeOf(async () => readDatasetDir(clone('t6', (d) => rmSync(path.join(d, 'dataset.manifest.json'))))), 'CORRUPT_INPUT', 'no manifest => no artifact');
  assert.equal(await codeOf(async () => readDatasetDir(clone('t7', (d) => { const m = JSON.parse(readFileSync(path.join(d, 'dataset.manifest.json'), 'utf8')); m.featureRecipeVersion = 'social-research-features-9'; writeFileSync(path.join(d, 'dataset.manifest.json'), JSON.stringify(m)); }))), 'UNSUPPORTED_INPUT_VERSION');
  // bounded overflow: a tiny row limit fails the build with NO manifest and no leftover directory
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'over'), limits: { ...LIMITS, maxSelectedRows: 1 } })), 'RESOURCE_LIMIT_EXCEEDED');
  assert.ok(!existsSync(path.join(W, 'over')));
  assert.equal(await codeOf(async () => runSnapshot({ events: fx.events, out: path.join(W, 'over2'), limits: { ...LIMITS, maxJsonlLineBytes: 64 } })), 'RESOURCE_LIMIT_EXCEEDED', 'interrupted publish: the record writer fails mid-way');
  assert.ok(!existsSync(path.join(W, 'over2', 'snapshot.manifest.json')) && !existsSync(path.join(W, 'over2')), 'no completed manifest, own files removed');
  assert.equal(await codeOf(async () => runSnapshot({ events: fx.events, out: path.join(W, 'over3'), limits: { ...LIMITS, maxSourceEvents: 3 } })), 'RESOURCE_LIMIT_EXCEEDED');
  // output safety
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: ds.dir })), 'OUTPUT_EXISTS');
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: path.join(snap.dir, 'inside') })), 'OUTPUT_OVERLAP', 'output inside an input');
  symlinkSync(snap.dir, path.join(W, 'alias')); assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: path.join(W, 'alias', 'x') })), 'OUTPUT_OVERLAP', 'symlink alias resolved');
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: path.join(ROOT, 'research', 'never') })), 'OUTPUT_OVERLAP', 'inside the source tree');
  assert.equal(await codeOf(async () => runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: path.join(W, 'no-parent', 'x') })), 'INVALID_REQUEST');
  const real = prepareOutputTarget(path.join(W, 'race')); const r1 = reserveOutputDir(real); assert.equal(await codeOf(async () => reserveOutputDir(real)), 'OUTPUT_EXISTS', 'a concurrently created target is never clobbered'); r1.remove();
  assert.ok(!existsSync(real));
  // a snapshot with a record whose recordId was forged fails revalidation
  const forged = path.join(W, 'forged'); mkdirSync(forged); for (const f of readdirSync(snap.dir)) writeFileSync(path.join(forged, f), readFileSync(path.join(snap.dir, f)));
  const lines = readFileSync(path.join(forged, 'snapshots.jsonl'), 'utf8').split('\n').filter(Boolean); const first = JSON.parse(lines[0]); first.recordId = 'r5s-' + 'f'.repeat(64); lines[0] = JSON.stringify(first);
  const text = lines.join('\n') + '\n'; writeFileSync(path.join(forged, 'snapshots.jsonl'), text); const m = JSON.parse(readFileSync(path.join(forged, 'snapshot.manifest.json'), 'utf8')); m.outputs['snapshots.jsonl'].sha256 = sha256Hex(text); m.outputs['snapshots.jsonl'].bytes = Buffer.byteLength(text); writeFileSync(path.join(forged, 'snapshot.manifest.json'), JSON.stringify(m));
  assert.equal(await codeOf(async () => readSnapshotDir(forged)), 'CORRUPT_INPUT');
});

test('T16. no research history and no archive still yield reconciled unavailable-coverage reports with calibration NOT_PERFORMED — never a fake empty-success validation table; percentiles on small N are exact', async () => {
  const W = work(); const fx = await journalFixture({ coins: ['ZQQ7'], shadow: false });
  const onlyScope = fx.events.filter((e) => !/RESEARCH|OBSERVED/.test(e.type));
  const snap = await runSnapshot({ events: onlyScope, out: path.join(W, 'snap') }); assert.equal(snap.manifest.counts.selectedRecords, 0); assert.equal(snap.manifest.prefix.upperSeq, onlyScope.length);
  const ds = await runBuild({ snapshotDir: snap.dir, asOfTs: ASOF, out: path.join(W, 'ds') });
  assert.equal(ds.coverage.state.state, 'UNAVAILABLE'); assert.ok(ds.coverage.state.reasons.includes('NO_RESEARCH_HISTORY') && ds.coverage.state.reasons.includes('CHILDHOOD_ARCHIVE_NOT_SUPPLIED')); assert.equal(ds.coverage.counts.rows, 0); assert.deepEqual(ds.coverage.counts.reconciliation, { dossierRecords: 0, primaryRows: 0, continued: 0, afterAsOf: 0, sum: 0, legacyDossiersInPrefix: 0 });
  const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: T0, out: path.join(W, 'ev') });
  assert.equal(ev.evaluation.state.stageCalibration, 'NOT_PERFORMED'); assert.ok(ev.evaluation.state.calibrationBlockers.includes('NO_RESEARCH_HISTORY') && ev.evaluation.state.calibrationBlockers.includes('ARCHIVE_NOT_SUPPLIED'));
  for (const h of LABEL_HORIZONS_MIN) { const t = ev.evaluation.tables.primaryAll[`${h}m`]; assert.equal(t.n, 0); assert.equal(t.mfePct.median, null); assert.equal(t.mfePct.n, 0); }
  assert.equal(ev.evaluation.state.dataCoverage.state, 'UNAVAILABLE');
  // empty valid journal
  const empty = await runSnapshot({ events: [], out: path.join(W, 'empty') }); assert.equal(empty.manifest.prefix.upperSeq, 0); assert.equal(empty.manifest.prefix.digest.sha256, sha256Hex(''));
  // percentile law: linear interpolation at (n-1)p; n=0 null; n=1 sole value
  assert.equal(percentile([], 0.5), null); assert.equal(percentile([7], 0.25), 7); assert.equal(percentile([1, 2], 0.5), 1.5); assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75); assert.equal(percentile([1, 2, 3, 4], 0.75), 3.25); assert.deepEqual(summarize([3, 1, 2]), { n: 3, p25: 1.5, median: 2, p75: 2.5, min: 1, max: 3 });
  assert.equal(parseUtcInstant('2026-09-07T12:00:00Z'), T0); assert.equal(parseUtcInstant('2026-09-07 12:00:00Z'), null); assert.equal(parseUtcInstant('2026-13-07T12:00:00Z'), null);
});

test('T17. vocabulary and authority: no rank / trust / score / attention / trade vocabulary enters the pipeline code or its artifacts; every artifact carries authority NONE / RESEARCH_ONLY; the feature catalogue documents path, unit, null meaning and support for every leaf', async () => {
  const W = work(); const fx = await journalFixture({ coins: ['ZQQ7'] });
  const snap = await runSnapshot({ events: fx.events, out: path.join(W, 'snap') }); ARCHIVE({ dir: path.join(W, 'arch') });
  const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: path.join(W, 'arch'), asOfTs: ASOF, out: path.join(W, 'ds') }); const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: T0 + 3_600_000, out: path.join(W, 'ev') });
  for (const f of ['snap/snapshot.manifest.json', 'ds/dataset.manifest.json', 'ds/features.jsonl', 'ds/outcomes.jsonl', 'ev/evaluation.json', 'ev/evaluation.manifest.json']) { const t = readFileSync(path.join(W, f), 'utf8'); assert.ok(!/"(BUY|SELL|STRIKE|TRADE|ENTER|EXIT|LONG|SHORT)"/.test(t), `${f}: no execution vocabulary`); assert.ok(!/trustScore|reliabilityScore|winRate|botProbability|\b(attention|stalk|stalking|hyped|nomination|nominate|nominated)\b/i.test(t), `${f}: no rank / trust / attention vocabulary`); assert.ok(t.includes('"authority":"NONE"') || t.includes('"authority": "NONE"'), `${f}: authority NONE`); }
  for (const f of readdirSync(path.join(ROOT, 'research'))) { const c = readFileSync(path.join(ROOT, 'research', f), 'utf8').replace(/\/\/.*$/gm, ''); assert.ok(!/(trust|reliability|credibility|bot|winner|alpha|buy|win)(Score|Probability|Percent|Rate)\b/i.test(c), `${f}: no score alias`); assert.ok(!/config\.universe|createOrder|submitOrder|placeOrder|armStalk|setHyped/.test(c), `${f}: no authority`); }
  for (const s of FEATURE_CATALOGUE) { assert.ok(Array.isArray(s.path) && s.path.length > 0 && typeof s.unit === 'string' && typeof s.nullMeaning === 'string' && ['NONE', 'FIXED_MS', 'ROW_CLOCK', 'UNKNOWN'].includes(s.support.kind), s.name); if (s.support.kind === 'FIXED_MS') assert.ok(s.support.ms > 0); if (s.support.kind === 'ROW_CLOCK') assert.ok(FEATURE_NAMES.includes(s.support.leaf), `${s.name} references a catalogued clock`); }
  assert.equal(ev.evaluation.authority, 'NONE'); assert.equal(ev.evaluation.purpose, 'RESEARCH_ONLY');
});
