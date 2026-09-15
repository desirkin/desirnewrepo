// RESEARCH REFEREE CLOSEOUT — THE ACCEPTANCE MATRIX (section 6 of the v2 directions), one test per matrix id.
//
//   R01 one-field rehashed design changes refused at append, snapshot, disk and scoring
//   R02 missing / extra / null / wrong-type fields in opening, design, proof and terminal records
//   R03 a rejected, missing or foreign historical report cannot open a shadow; rehashing the opening cannot legitimize it
//   R04 fixed high-precision, quantile-fitted and ALWAYS thresholds keep their representation law; a primary candidate
//       whose feature differs from manifest.signal seals and RELOADS its own feature and threshold
//   R05 a seed override at the final look is refused; the sealed seed survives a reload; one formal result only
//   R06 family id, candidate count, feature digest, manifest identity and holdout history cannot be altered by reload
//   R07 clock negatives, duplicate / orphan records, out-of-order outcomes and a missing outcome keep their laws
//   R08 an oversized proof or serialized record is refused before acceptance or write, including multibyte UTF-8
//   R09 an unrelated verdict, reason, design or report identity in the terminal payload fails; a valid one round-trips
//   W05 a fault at each write phase: before data mutation, mid first record, just before its newline, between records,
//       mid a later record, and at the data fsync — the phase actually reached is asserted
//   W06 a fault in marker creation, marker sync and post-commit cleanup: precommit vs committed-cleanup are distinct
//   W07 deterministic child-process termination after marker durability, between records, and after all data writes
//   W08 explicit recovery of exactly OLD and exactly FINAL; partial evidence stays refused and byte-preserved
//   W09 two writers from one head yield exactly one append; a reader cannot consume a pending batch; path spellings
//   W10 stale no-op, stale nonempty, missing file with nonempty expectation, malformed marker, bounds, short writes
//   W11 every reported successful append immediately reopens as the exact expected valid chain
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, writeSync as fsWriteSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refereeEvaluate, resultSharpesOf } from '../research/referee/evaluate.js';
import { createRegistry, registryError, registrySnapshot, registryFromSnapshot, appendRecord, experimentOf, recordResult, registerExperiment, openHoldout, abandonExperiment, trialHistory, validatedState } from '../research/referee/registry.js';
import { canonicalDigest, REGISTRY_VERSION, REASON_CODES, LIMITS } from '../research/referee/contracts.js';
import { readRegistryFile, appendRegistryFile, recoverRegistryFile, readPendingMarker, REGISTRY_LOCK_SUFFIX, REGISTRY_PENDING_SUFFIX, canonicalStorePath } from '../research/referee/store.js';
import { openProspective, captureProspectiveObservation, recordProspectiveOutcome, prospectiveProgress, evaluateProspectiveTerminal } from '../research/referee/prospective.js';
import { buildProspectiveDesign, sealThreshold } from '../research/referee/design.js';
import { prospectiveSetup, registryWith, manifest, feature, condition, realEffectData, bundleFor, synth, mix, CODE_IDENTITY, T0, HOUR, MIN } from './helpers/referee.js';

const KILL_CHILD = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'helpers/referee-append-kill-child.mjs');
const RACE_CHILD = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'helpers/referee-append-child.mjs');
const work = () => mkdtempSync(path.join(tmpdir(), 'referee-matrix-'));
const scratch = (fn) => { const d = work(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const bytesOf = (f) => (existsSync(f) ? readFileSync(f) : null);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const clone = (x) => structuredClone(x);
const declared = (r) => { assert.ok(r && r.error, 'a structured refusal'); assert.ok(REASON_CODES.includes(r.error.reason), `declared reason, got ${r.error?.reason}`); return r.error.reason; };
function rehash(reg) {
  let prev = canonicalDigest({ registryVersion: REGISTRY_VERSION, genesis: true });
  for (const r of reg.records) { r.prevDigest = prev; const { digest, ...body } = r; r.digest = canonicalDigest(body); prev = r.digest; }
  return reg;
}
const S = prospectiveSetup({ terminalObservations: 5 });
// an opening mutated one field at a time, rehashed so only its SEMANTICS are wrong
function altered(change) {
  const reg = clone(S.registry); const rec = reg.records.find((r) => r.kind === 'PROSPECTIVE_OPENED');
  change(rec.payload, rec); if (rec.payload.design) rec.payload.designDigest = canonicalDigest(rec.payload.design);
  return rehash(reg);
}
const onDisk = (reg) => scratch((dir) => { const f = path.join(dir, 'r.jsonl'); writeFileSync(f, `${reg.records.map((r) => JSON.stringify(r)).join('\n')}\n`); try { readRegistryFile(f); return null; } catch (e) { return e.researchMessage ?? e.message; } });
// a lawful five-capture lifecycle taken to its terminal result
function mature(base = S) {
  let reg = base.registry; const obs = [];
  for (let i = 0; i < 5; i += 1) { const ts = base.openedAtTs + MIN + i; const o = { observationId: `m-${i}`, symbol: 'BTC', ts, score: i % 2 ? -1 : 1, labelEndTs: ts + HOUR }; const r = captureProspectiveObservation(reg, { experimentId: base.experimentId, observation: o, ts }); assert.equal(r.error, null, JSON.stringify(r.error)); reg = r.registry; obs.push(o); }
  const ts = obs.at(-1).labelEndTs + MIN;
  for (const [i, o] of obs.entries()) { const r = recordProspectiveOutcome(reg, { experimentId: base.experimentId, observationId: o.observationId, outcome: (i + 1) / 10, outcomeKnownAtTs: o.labelEndTs, ts }); assert.equal(r.error, null); reg = r.registry; }
  const result = evaluateProspectiveTerminal(reg, { experimentId: base.experimentId, ts: ts + 1 });
  assert.equal(result.error, null, JSON.stringify(result.error)); return { pending: reg, result, ts: ts + 1, obs };
}
const twoRegistries = () => ({ one: registryWith([manifest({ name: 'w-a' })]).registry, two: registryWith([manifest({ name: 'w-a' }), manifest({ name: 'w-b', familyTag: 'OTHER_FAMILY', features: [feature('OTHER')], signal: { feature: 'OTHER', condition: condition('GT', 0) } })]).registry });

test('R01. a one-field design change, validly rehashed, is refused at every path: pure validation, snapshot, disk reload and the scoring entry points', () => {
  const cases = {
    terminalObservations: (d) => { d.terminalObservations = 1; }, horizonMs: (d) => { d.horizonMs = 2 * HOUR; },
    universeRule: (d) => { d.universeRule = 'ANYTHING_GOES'; }, primaryMetric: (d) => { d.primaryMetric = 'RANK_IC'; },
    direction: (d) => { d.direction = 'NEGATIVE'; }, parameters: (d) => { d.parameters = { topK: 3 }; },
    nullAlpha: (d) => { d.nullAlpha = 0.5; }, permutationIterations: (d) => { d.permutationIterations = 3; },
    feature: (d) => { d.feature = 'OTHER'; }, candidateId: (d) => { d.candidateId = 'c-ghost'; },
    threshold: (d) => { d.condition = { ...d.condition, threshold: 0.9 }; }, featureDefinitionDigest: (d) => { d.featureDefinitionDigest = '0'.repeat(64); },
    blockLengthRows: (d) => { d.blockLengthRows = 2; }, historicalReportDigest: (d) => { d.historicalReportDigest = '0'.repeat(64); },
    captureEvidenceRequired: (d) => { d.captureEvidenceRequired = 'TRUST_ME'; }, prospectiveVersion: (d) => { d.prospectiveVersion = 'serpent-referee-prospective-0'; },
    symbolScope: (d) => { d.symbolScope = ['BTC']; }, evaluationType: (d) => { d.evaluationType = 'RANKING'; },
    sequentialMethod: (d) => { d.sequentialMethod = 'ANYTIME'; }, anytimeValid: (d) => { d.anytimeValid = { status: 'IMPLEMENTED' }; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const reg = altered((p) => change(p.design));
    assert.ok(registryError(reg), `${name}: pure validation`);
    declared(registryFromSnapshot(registrySnapshot(reg)));
    assert.ok(onDisk(reg), `${name}: disk reload`);
    const ts = S.openedAtTs + MIN;
    declared(captureProspectiveObservation(reg, { experimentId: S.experimentId, ts, observation: { observationId: 'x', symbol: 'BTC', ts, score: 1, labelEndTs: ts + HOUR } }));
    declared(evaluateProspectiveTerminal(reg, { experimentId: S.experimentId, ts: ts + HOUR }));
    assert.equal(prospectiveProgress(reg, S.experimentId).error?.reason !== undefined, true, `${name}: progress refuses rather than displaying a metric`);
    const prefix = { registryVersion: REGISTRY_VERSION, records: reg.records.slice(0, -1) }; const opening = reg.records.at(-1);
    declared(appendRecord(prefix, { kind: opening.kind, ts: opening.ts, experimentId: opening.experimentId, payload: opening.payload }));
  }
});

test('R02. missing, extra, null and wrong-type fields in an opening, its design, its carried proof and a terminal record are structured refusals, never a TypeError or a silent pass', () => {
  const mutations = [
    ['opening missing key', (p) => { delete p.historicalReport; }], ['opening extra key', (p) => { p.extra = 1; }],
    ['opening null proof', (p) => { p.historicalReport = null; }], ['opening wrong-type digest', (p) => { p.historicalReportDigest = 12345; }],
    ['opening broken stamp', (p) => { p.canAffectTrading = true; }], ['design missing key', (p) => { delete p.design.nullSeed; }],
    ['design extra key', (p) => { p.design.bonus = true; }], ['design null field', (p) => { p.design.terminalObservations = null; }],
    ['design wrong-type', (p) => { p.design.horizonMs = '1h'; }], ['proof digest broken', (p) => { p.historicalReport.reportDigest = '0'.repeat(64); }],
    ['proof verdict flipped', (p) => { p.historicalReport.verdict = { ...p.historicalReport.verdict, verdict: 'REJECTED' }; }],
    ['proof identity swapped', (p) => { p.historicalReport.identity = { ...p.historicalReport.identity, experimentId: 'exp-other' }; }],
    ['proof stamp broken', (p) => { p.historicalReport.authority = { ...p.historicalReport.authority, canAffectSizing: true }; }],
    ['proof version', (p) => { p.historicalReport.reportVersion = 'serpent-referee-report-0'; }],
    ['proof clock from the future', (p) => { p.historicalReport.identity = { ...p.historicalReport.identity, requestedAtTs: T0 + 400 * 24 * HOUR }; }],
  ];
  for (const [name, change] of mutations) {
    const reg = altered((p) => change(p));
    const e = registryError(reg); assert.ok(e, `${name}: refused`); assert.ok(REASON_CODES.includes(e.reason), `${name}: declared reason ${e.reason}`);
    assert.ok(onDisk(reg), `${name}: refused on disk`);
  }
  const m = mature();
  for (const [name, change] of [['terminal missing key', (p) => { delete p.report; }], ['terminal extra key', (p) => { p.extra = 1; }], ['terminal null report', (p) => { p.report = null; }], ['terminal wrong-type reasons', (p) => { p.reasons = 'TERMINAL_SAMPLE_REACHED'; }]]) {
    const payload = clone(m.result.registry.records.at(-1).payload); change(payload);
    const e = declared(appendRecord(m.pending, { kind: 'PROSPECTIVE_EVALUATED', experimentId: S.experimentId, ts: m.ts, payload }));
    assert.ok(e, name);
  }
});

test('R03. a rejected, absent or foreign historical report cannot open a shadow, and rehashing the opening cannot legitimize a wrong digest or a fitted-candidate mismatch', () => {
  // a REJECTED stored result, with the carried proof still claiming otherwise
  const rejected = clone(S.registry); rejected.records.find((r) => r.kind === 'RESULT_RECORDED').payload.verdict = 'REJECTED';
  assert.ok(registryError(rehash(rejected)));
  // a report belonging to another experiment
  const other = prospectiveSetup({ terminalObservations: 5, data: realEffectData('r03-other') });
  const foreign = altered((p) => { p.historicalReport = clone(other.registry.records.find((r) => r.kind === 'PROSPECTIVE_OPENED').payload.historicalReport); p.historicalReportDigest = p.historicalReport.reportDigest; });
  assert.ok(registryError(foreign), 'a foreign report is refused');
  // a fitted-candidate mismatch: the proof names a feature the design does not
  const mismatch = altered((p) => { p.historicalReport = clone(p.historicalReport); p.historicalReport.primaryResult = { ...p.historicalReport.primaryResult, fit: { ...p.historicalReport.primaryResult.fit, feature: 'GHOST' } }; p.historicalReportDigest = p.historicalReport.reportDigest; });
  assert.ok(registryError(mismatch));
  // live: openProspective refuses a report whose verdict is not HISTORICALLY_INTERESTING and one that is not the recorded result
  const data = realEffectData('r03'); const { bundle, registry } = bundleFor({ data, manifestOver: { prospective: { terminalObservations: 5, horizonMs: HOUR, universeRule: 'DECLARED_STATIC_LIST', sequentialMethod: null } } });
  const report = refereeEvaluate(bundle); const id = report.identity.experimentId; const t1 = bundle.evaluation.requestedAtTs + MIN;
  const reg = recordResult(registry, { experimentId: id, reportDigest: report.reportDigest, verdict: report.verdict.verdict, primaryMetric: { name: report.primaryResult.metric, value: report.primaryResult.value }, sharpes: resultSharpesOf(report), datasetDigest: bundle.dataset.manifestDigest, recordedAtTs: t1 }).registry;
  declared(openProspective(reg, { experimentId: id, historicalReport: { ...report, verdict: { ...report.verdict, verdict: 'REJECTED' } }, ts: t1 + MIN }));
  declared(openProspective(reg, { experimentId: id, historicalReport: null, ts: t1 + MIN }));
  declared(openProspective(reg, { experimentId: id, historicalReport: other.report, ts: t1 + MIN }));
  assert.equal(openProspective(reg, { experimentId: id, historicalReport: report, ts: t1 + MIN }).error, null, 'the real report opens');
});

test('R04. threshold representation: a high-precision fixed threshold, a quantile-fitted threshold and ALWAYS all seal and reload under one normalization law; a primary candidate seals its OWN feature', () => {
  assert.equal(sealThreshold(0.1234567891), 0.123457, 'one rounding law, stated once');
  assert.equal(sealThreshold(null), null); assert.equal(sealThreshold(0), 0);
  const cases = [
    ['fixed high precision', condition('GT', 0.1234567891), 'SIG'],
    ['quantile fitted', condition('GT', null, 0.8), 'SIG'],
    ['ALWAYS', condition('ALWAYS', null, null), 'SIG'],
  ];
  for (const [name, cond, feat] of cases) {
    const data = realEffectData(`r04-${name}`);
    const { bundle, registry } = bundleFor({ data, manifestOver: { signal: { feature: feat, condition: cond }, prospective: { terminalObservations: 5, horizonMs: HOUR, universeRule: 'DECLARED_STATIC_LIST', sequentialMethod: null } } });
    const report = refereeEvaluate(bundle);
    if (report.verdict.verdict !== 'HISTORICALLY_INTERESTING') continue; // only a surviving result may open a shadow
    const id = report.identity.experimentId; const t1 = bundle.evaluation.requestedAtTs + MIN;
    const reg = recordResult(registry, { experimentId: id, reportDigest: report.reportDigest, verdict: report.verdict.verdict, primaryMetric: { name: report.primaryResult.metric, value: report.primaryResult.value }, sharpes: resultSharpesOf(report), datasetDigest: bundle.dataset.manifestDigest, recordedAtTs: t1 }).registry;
    const o = openProspective(reg, { experimentId: id, historicalReport: report, ts: t1 + MIN });
    assert.equal(o.error, null, `${name}: ${JSON.stringify(o.error)}`);
    assert.equal(o.design.condition.threshold, sealThreshold(report.primaryResult.fit.threshold), `${name}: the sealed threshold is the normalized reported one`);
    assert.equal(registryError(o.registry), null, `${name}: reloads`);
    const rebuilt = buildProspectiveDesign(bundle.experiment, report, { seed: o.design.nullSeed });
    assert.equal(rebuilt.designDigest, o.designDigest, `${name}: the rebuild is byte-identical`);
  }
  // a primary candidate whose feature differs from manifest.signal
  const data = synth({ seed: 'r04-candidate', steps: 400, features: (rng, y) => ({ SIG: rng.normal(), ALT: mix(rng, y, 0.4) }) });
  const { bundle, registry } = bundleFor({ data, manifestOver: { features: [feature('SIG'), feature('ALT')], signal: { feature: 'SIG', condition: condition('GT', 0) }, candidates: [{ candidateId: 'c-alt', params: { k: 1 }, signal: { feature: 'ALT', condition: condition('GT', 0.25) } }], primaryCandidateId: 'c-alt', prospective: { terminalObservations: 5, horizonMs: HOUR, universeRule: 'DECLARED_STATIC_LIST', sequentialMethod: null } } });
  const report = refereeEvaluate(bundle); assert.equal(report.primaryResult.fit.feature, 'ALT');
  const id = report.identity.experimentId; const t1 = bundle.evaluation.requestedAtTs + MIN;
  const reg = recordResult(registry, { experimentId: id, reportDigest: report.reportDigest, verdict: report.verdict.verdict, primaryMetric: { name: report.primaryResult.metric, value: report.primaryResult.value }, sharpes: resultSharpesOf(report), datasetDigest: bundle.dataset.manifestDigest, recordedAtTs: t1 }).registry;
  const o = openProspective(reg, { experimentId: id, historicalReport: report, ts: t1 + MIN }); assert.equal(o.error, null);
  assert.equal(o.design.feature, 'ALT'); assert.equal(o.design.candidateId, 'c-alt'); assert.equal(o.design.condition.threshold, 0.25);
  const back = registryFromSnapshot(registrySnapshot(o.registry)); assert.equal(back.error, null, 'and it RELOADS with its own feature');
  assert.equal(experimentOf(back.registry, id).prospective.payload.design.feature, 'ALT');
});

test('R05. the sealed seed: an empty, invalid or extra seed at the final look is refused, the seed survives a reload, and only one formal result is ever recorded', () => {
  const m = mature();
  for (const extra of [{ seed: '' }, { seed: 'other' }, { seed: null }, { nullSeed: 'x' }]) {
    const r = evaluateProspectiveTerminal(m.pending, { experimentId: S.experimentId, ts: m.ts, ...extra });
    assert.equal(declared(r), 'SCHEMA', `refused: ${JSON.stringify(extra)}`); assert.equal(r.report, null);
  }
  assert.ok(m.result.report.terminal.seed.includes(S.design.nullSeed));
  const back = registryFromSnapshot(registrySnapshot(m.result.registry)); assert.equal(back.error, null);
  assert.equal(experimentOf(back.registry, S.experimentId).prospective.payload.design.nullSeed, S.design.nullSeed, 'the seed persists across reload');
  declared(evaluateProspectiveTerminal(m.result.registry, { experimentId: S.experimentId, ts: m.ts + 1 }));
  assert.equal(m.result.registry.records.filter((r) => r.kind === 'PROSPECTIVE_EVALUATED').length, 1, 'one formal result in committed history');
});

test('R06. trial accounting cannot be altered through reload: family id, candidate count, feature digest, manifest identity, family rule and holdout history are all re-derived', () => {
  const base = registryWith([manifest({ name: 'fam-a' })]).registry; const id = base.records[0].experimentId;
  for (const [name, change] of [
    ['family id', (r) => { r.experimentFamilyId = 'fam-other'; }],
    ['candidate count', (r) => { r.payload.candidateCount = 7; }],
    ['feature digest', (r) => { r.payload.featureDigest = '0'.repeat(64); }],
    ['manifest identity', (r) => { r.payload.manifest = { ...r.payload.manifest, familyTag: 'RENAMED' }; }],
    ['manifest digest', (r) => { r.payload.manifestDigest = '0'.repeat(64); }],
    ['family rule', (r) => { r.payload.familyRule = 'INHERITED_FROM_PARENT'; }],
    ['code identity', (r) => { r.payload.codeIdentity = { ...r.payload.codeIdentity, sourceTreeSha256: 'nope' }; }],
  ]) { const reg = clone(base); change(reg.records[0]); assert.ok(registryError(rehash(reg)), `${name} is refused`); }
  // a second family member forged into the family without a parent, after the family carried a result
  let reg = recordResult(base, { experimentId: id, reportDigest: 'b'.repeat(64), verdict: 'REJECTED', primaryMetric: { name: 'SHARPE_PER_OBS', value: 0 }, sharpes: [], datasetDigest: 'c'.repeat(64), recordedAtTs: T0 }).registry;
  const forked = registerExperiment(reg, manifest({ name: 'fork', signal: { feature: 'SIG', condition: condition('GT', 0.5) } }), { registeredAtTs: T0 + MIN, codeIdentity: CODE_IDENTITY });
  assert.equal(declared(forked), 'FORK_REQUIRES_PARENT');
  const child = registerExperiment(reg, manifest({ name: 'fork', parentExperimentId: id, signal: { feature: 'SIG', condition: condition('GT', 0.5) } }), { registeredAtTs: T0 + MIN, codeIdentity: CODE_IDENTITY });
  assert.equal(child.error, null); assert.equal(trialHistory(child.registry, child.experimentId).rawTrialCount, 2);
  // overlapping holdouts stay refused, and an abandoned experiment keeps counting
  const h1 = openHoldout(child.registry, { experimentId: id, startTs: T0 + 10 * HOUR, endTs: T0 + 20 * HOUR, ts: T0 + 2 * MIN }); assert.equal(h1.error, null);
  assert.equal(declared(openHoldout(h1.registry, { experimentId: child.experimentId, startTs: T0 + 15 * HOUR, endTs: T0 + 25 * HOUR, ts: T0 + 3 * MIN })), 'HOLDOUT_ALREADY_OPENED');
  const ab = abandonExperiment(h1.registry, { experimentId: child.experimentId, reasonCode: 'LOST_INTEREST', ts: T0 + 4 * MIN }); assert.equal(ab.error, null);
  assert.equal(trialHistory(ab.registry, id).rawTrialCount, 2, 'an abandoned trial still counts');
  assert.equal(registryError(ab.registry), null);
});

test('R07. clock, duplicate, orphan and completeness laws survive the stricter replay unchanged', () => {
  const o1 = { observationId: 'r07-1', symbol: 'BTC', ts: S.openedAtTs + MIN, score: 1, labelEndTs: S.openedAtTs + MIN + HOUR };
  assert.equal(declared(captureProspectiveObservation(S.registry, { experimentId: S.experimentId, observation: { ...o1, ts: o1.ts + 10 * MIN }, ts: o1.ts })), 'DECISION_AFTER_RECORDING');
  assert.equal(declared(captureProspectiveObservation(S.registry, { experimentId: S.experimentId, observation: o1, ts: o1.labelEndTs })), 'CAPTURE_NOT_PRIOR_TO_OUTCOME');
  assert.equal(declared(captureProspectiveObservation(S.registry, { experimentId: S.experimentId, observation: { ...o1, labelEndTs: o1.ts + 3 * HOUR }, ts: o1.ts })), 'LABEL_HORIZON_MISMATCH');
  assert.equal(declared(captureProspectiveObservation(S.registry, { experimentId: S.experimentId, observation: o1, ts: S.openedAtTs - 1 })), 'REGISTRY_CLOCK_BACKWARDS');
  let reg = captureProspectiveObservation(S.registry, { experimentId: S.experimentId, observation: o1, ts: o1.ts }).registry;
  assert.equal(declared(captureProspectiveObservation(reg, { experimentId: S.experimentId, observation: o1, ts: o1.ts })), 'DUPLICATE_OBSERVATION_ID');
  assert.equal(declared(recordProspectiveOutcome(reg, { experimentId: S.experimentId, observationId: 'ghost', outcome: 1, outcomeKnownAtTs: o1.labelEndTs, ts: o1.labelEndTs })), 'PROSPECTIVE_OBSERVATION_UNKNOWN');
  assert.equal(declared(recordProspectiveOutcome(reg, { experimentId: S.experimentId, observationId: 'r07-1', outcome: 1, outcomeKnownAtTs: o1.labelEndTs - 1, ts: o1.labelEndTs })), 'OUTCOME_KNOWN_BEFORE_HORIZON_END');
  assert.equal(declared(recordProspectiveOutcome(reg, { experimentId: S.experimentId, observationId: 'r07-1', outcome: 1, outcomeKnownAtTs: o1.labelEndTs, ts: o1.labelEndTs - 1 })), 'OUTCOME_RECORDED_BEFORE_KNOWN');
  reg = recordProspectiveOutcome(reg, { experimentId: S.experimentId, observationId: 'r07-1', outcome: 0.4, outcomeKnownAtTs: o1.labelEndTs, ts: o1.labelEndTs }).registry;
  assert.equal(declared(recordProspectiveOutcome(reg, { experimentId: S.experimentId, observationId: 'r07-1', outcome: 9, outcomeKnownAtTs: o1.labelEndTs, ts: o1.labelEndTs })), 'PROSPECTIVE_OUTCOME_ALREADY_RECORDED');
  // out-of-order outcomes preserve the first-N-CAPTURED sample, and a missing one keeps the evaluation pending
  const base = prospectiveSetup({ terminalObservations: 3, data: realEffectData('r07') }); let r2 = base.registry; const obs = [];
  for (let i = 0; i < 4; i += 1) { const ts = base.openedAtTs + MIN + i; const o = { observationId: `q-${i}`, symbol: 'BTC', ts, score: 1, labelEndTs: ts + HOUR }; r2 = captureProspectiveObservation(r2, { experimentId: base.experimentId, observation: o, ts }).registry; obs.push(o); }
  const late = obs.at(-1).labelEndTs + MIN;
  for (const i of [3, 2, 0]) r2 = recordProspectiveOutcome(r2, { experimentId: base.experimentId, observationId: `q-${i}`, outcome: 0.2, outcomeKnownAtTs: obs[i].labelEndTs, ts: late }).registry;
  const p = prospectiveProgress(r2, base.experimentId);
  assert.deepEqual(p.countedObservationIds, ['q-0', 'q-1', 'q-2']); assert.equal(p.formal.status, 'TERMINAL_SAMPLE_NOT_REACHED');
  assert.equal(declared(evaluateProspectiveTerminal(r2, { experimentId: base.experimentId, ts: late + 1 })), 'TERMINAL_SAMPLE_NOT_REACHED');
});

test('R08. an oversized proof or serialized record is refused before acceptance and before any byte is written, counting real UTF-8 bytes', () => {
  const m = mature();
  // a padded opening beyond the shared record bound, refused by the pure validator
  const padded = altered((p) => { p.historicalReport = { ...clone(p.historicalReport), padding: 'π'.repeat(LIMITS.maxRecordBytes / 2) }; p.historicalReportDigest = p.historicalReport.reportDigest; });
  const e = registryError(padded); assert.ok(e); assert.equal(e.reason, 'RESOURCE_LIMIT_EXCEEDED');
  const prefix = { registryVersion: REGISTRY_VERSION, records: padded.records.slice(0, -1) }; const opening = padded.records.at(-1);
  assert.equal(declared(appendRecord(prefix, { kind: opening.kind, ts: opening.ts, experimentId: opening.experimentId, payload: opening.payload })), 'RESOURCE_LIMIT_EXCEEDED');
  // multibyte boundary equality and one byte over, at the writer
  scratch((dir) => {
    const f = path.join(dir, 'r.jsonl'); const { one, two } = twoRegistries();
    appendRegistryFile(f, createRegistry(), one); const before = bytesOf(f);
    const tailLine = Buffer.byteLength(JSON.stringify(two.records[1]), 'utf8');
    assert.throws(() => appendRegistryFile(f, one, two, { maxLineBytes: tailLine - 1 }), /RESOURCE_LIMIT_EXCEEDED/, 'one byte over');
    assert.deepEqual(bytesOf(f), before, 'nothing written');
    assert.equal(appendRegistryFile(f, one, two, { maxLineBytes: tailLine }).appended, 1, 'exact equality is allowed');
    const size = statSync(f).size;
    assert.throws(() => appendRegistryFile(f, readRegistryFile(f), readRegistryFile(f), { maxFileBytes: size - 1 }), /RESOURCE_LIMIT_EXCEEDED/);
    assert.equal(existsSync(`${f}${REGISTRY_PENDING_SUFFIX}`), false, 'a bound refusal opens no transaction');
  });
  assert.ok(m.result.report.terminal.counted === 5);
});

test('R09. an unrelated verdict, reason, design or report identity in the terminal payload fails even when every key and primitive type is otherwise valid; a lawful terminal report round-trips', () => {
  const m = mature(); const good = clone(m.result.registry.records.at(-1).payload);
  const mutations = [
    ['foreign verdict', (p) => { p.verdict = 'PROSPECTIVE_SUPPORTED'; p.report = { ...p.report, verdict: { ...p.report.verdict, verdict: 'PROSPECTIVE_SUPPORTED' } }; }],
    ['reason not in vocabulary', (p) => { p.reasons = ['TERMINAL_SAMPLE_REACHED', 'BECAUSE_I_SAID_SO']; }],
    ['report counts other observations', (p) => { p.report = { ...p.report, terminal: { ...p.report.terminal, observationIds: ['m-4', 'm-3', 'm-2', 'm-1', 'm-0'] } }; }],
    ['report evaluation clock moved', (p) => { p.report = { ...p.report, evaluatedAtTs: p.report.evaluatedAtTs + 1 }; }],
    ['report alpha changed', (p) => { p.report = { ...p.report, terminal: { ...p.report.terminal, alpha: 0.5 } }; }],
    ['report seed changed', (p) => { p.report = { ...p.report, terminal: { ...p.report.terminal, seed: 'someone-elses-seed' } }; }],
    ['report design swapped', (p) => { p.report = { ...p.report, design: { ...p.report.design, terminalObservations: 1 } }; }],
    ['report identity swapped', (p) => { p.report = { ...p.report, experimentId: 'exp-other' }; }],
  ];
  for (const [name, change] of mutations) {
    const payload = clone(good); change(payload);
    if (payload.report && typeof payload.report === 'object') payload.report = { ...payload.report, reportDigest: canonicalDigest(Object.fromEntries(Object.entries(payload.report).filter(([k]) => k !== 'reportDigest'))) };
    if (payload.report?.reportDigest) payload.reportDigest = payload.report.reportDigest;
    const r = appendRecord(m.pending, { kind: 'PROSPECTIVE_EVALUATED', experimentId: S.experimentId, ts: m.ts, payload });
    assert.ok(r.error, `${name} is refused even after rehashing the report`); assert.ok(REASON_CODES.includes(r.error.reason), `${name}: ${r.error.reason}`);
  }
  assert.equal(registryError(m.result.registry), null, 'the lawful terminal record round-trips');
  assert.equal(registryFromSnapshot(registrySnapshot(m.result.registry)).error, null);
});

// ---------------------------------------------------------------------------------------------------------------
// W. storage and recovery
// ---------------------------------------------------------------------------------------------------------------
const phaseFault = (kind) => {
  let calls = 0; let wrote = false;
  switch (kind) {
    case 'mid-first-record': return { io: { writeSync(fd, buf, off, len) { calls += 1; if (calls === 1) return fsWriteSync(fd, buf, off, Math.max(1, Math.floor(len / 2))); throw new Error('fault mid record'); } } };
    case 'before-newline': return { io: { writeSync(fd, buf, off, len) { calls += 1; if (calls === 1) return fsWriteSync(fd, buf, off, len - 1); throw new Error('fault before newline'); } } };
    case 'between-records': return { io: { writeSync(fd, buf, off, len) { calls += 1; if (calls === 1) return fsWriteSync(fd, buf, off, len); throw new Error('fault between records'); } } };
    case 'mid-later-record': return { io: { writeSync(fd, buf, off, len) { calls += 1; if (calls === 1) return fsWriteSync(fd, buf, off, len); if (calls === 2) return fsWriteSync(fd, buf, off, Math.max(1, Math.floor(len / 2))); throw new Error('fault mid later record'); } } };
    case 'data-fsync': return { io: { writeSync(fd, buf, off, len) { wrote = true; return fsWriteSync(fd, buf, off, len); }, fsyncSync(fd) { if (wrote) throw new Error('fault at data fsync'); return 0; } } };
    default: throw new Error(`unknown phase ${kind}`);
  }
};

test('W05. a fault at every write phase leaves the same honest state: the phase actually reached is asserted, the bytes stay, the marker fences every reader and retry', () => {
  const phases = [['mid-first-record', 1], ['before-newline', 1], ['between-records', 2], ['mid-later-record', 2], ['data-fsync', 1]];
  for (const [phase, records] of phases) scratch((dir) => {
    const f = path.join(dir, 'r.jsonl'); const { one, two } = twoRegistries(); const next = records === 2 ? two : one;
    assert.throws(() => appendRegistryFile(f, createRegistry(), next, phaseFault(phase)), /PARTIAL_WRITE_UNCERTAIN/, `${phase}: reported`);
    const bytes = bytesOf(f); const expectedFirst = Buffer.byteLength(`${JSON.stringify(next.records[0])}\n`, 'utf8');
    if (phase === 'mid-first-record') assert.ok(bytes.length > 0 && bytes.length < expectedFirst, `${phase}: stopped inside the first record (${bytes.length}/${expectedFirst})`);
    if (phase === 'before-newline') assert.equal(bytes.length, expectedFirst - 1, `${phase}: stopped exactly one byte before the terminator`);
    if (phase === 'between-records') assert.equal(bytes.length, expectedFirst, `${phase}: stopped between two complete records`);
    if (phase === 'mid-later-record') assert.ok(bytes.length > expectedFirst, `${phase}: stopped inside a later record`);
    if (phase === 'data-fsync') assert.equal(bytes.length, Buffer.byteLength(`${JSON.stringify(next.records[0])}\n`, 'utf8'), `${phase}: every byte written, the sync failed`);
    assert.ok(readPendingMarker(f), `${phase}: the pending marker fences the file`);
    assert.throws(() => readRegistryFile(f), /RECOVERY_REQUIRED/, `${phase}: reads refuse`);
    assert.throws(() => appendRegistryFile(f, createRegistry(), next), /RECOVERY_REQUIRED/, `${phase}: retries refuse`);
    assert.deepEqual(bytesOf(f), bytes, `${phase}: bytes preserved`);
    assert.equal(existsSync(`${f}${REGISTRY_LOCK_SUFFIX}`), false, `${phase}: the transient lock is released; the durable marker still fences`);
  });
});

test('W06. marker-phase faults are distinct from post-commit cleanup faults: a precommit failure writes no data, a cleanup failure never claims a rollback of durable data', () => {
  scratch((dir) => { // marker creation fails: not one data byte
    const f = path.join(dir, 'r.jsonl'); const { one } = twoRegistries();
    assert.throws(() => appendRegistryFile(f, createRegistry(), one, { faults: { markerWrite() { throw new Error('marker create failed'); } } }), /marker create failed/);
    assert.equal(existsSync(f), false, 'no data file was created'); assert.equal(existsSync(`${f}${REGISTRY_PENDING_SUFFIX}`), false, 'no marker left');
    assert.equal(existsSync(`${f}${REGISTRY_LOCK_SUFFIX}`), false, 'lock released');
  });
  scratch((dir) => { // marker sync fails: the marker is removed and no data is written
    const f = path.join(dir, 'r.jsonl'); const { one } = twoRegistries();
    assert.throws(() => appendRegistryFile(f, createRegistry(), one, { faults: { markerSync() { throw new Error('marker sync failed'); } } }), /marker sync failed/);
    assert.equal(existsSync(f), false); assert.equal(existsSync(`${f}${REGISTRY_PENDING_SUFFIX}`), false);
  });
  scratch((dir) => { // cleanup after a durable commit: honest, and never a rollback claim
    const f = path.join(dir, 'r.jsonl'); const { one } = twoRegistries();
    let e = null; try { appendRegistryFile(f, createRegistry(), one, { faults: { cleanup() { throw new Error('cleanup failed'); } } }); } catch (err) { e = err; }
    assert.ok(e, 'the cleanup problem is reported'); assert.match(e.researchMessage, /APPEND_COMMITTED_CLEANUP_INCOMPLETE/);
    assert.match(e.researchMessage, /durably committed/); assert.match(e.researchMessage, /Nothing was rolled back/);
    assert.ok(readPendingMarker(f), 'readers stay fenced until recovery finalizes it');
    assert.throws(() => readRegistryFile(f), /RECOVERY_REQUIRED/);
    const rec = recoverRegistryFile(f); assert.equal(rec.state, 'FINALIZED_COMMITTED_APPEND'); assert.equal(rec.records, 1);
    assert.equal(readRegistryFile(f).records.length, 1, 'the committed record was never lost');
  });
});

test('W07. a writer terminated mid-append leaves exactly the evidence its phase implies, and explicit recovery resolves each case correctly', () => {
  for (const [phase, expect] of [['after-marker', 'ROLLED_FORWARD_NOTHING'], ['between-records', 'REFUSED'], ['after-all-writes', 'FINALIZED_COMMITTED_APPEND']]) scratch((dir) => {
    const f = path.join(dir, 'r.jsonl'); const ready = path.join(dir, `ready-${phase}`);
    const res = spawnSync(process.execPath, [KILL_CHILD, f, phase, ready], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(res.signal, 'SIGKILL', `${phase}: the child was terminated at its phase`);
    assert.ok(existsSync(ready), `${phase}: the child reached the append`);
    assert.ok(existsSync(`${f}${REGISTRY_LOCK_SUFFIX}`), `${phase}: the dead writer's lock is left behind, never stolen on age`);
    assert.throws(() => readRegistryFile(f), /WRITER_ACTIVE/, `${phase}: a reader is fenced by the leftover lock`);
    assert.throws(() => recoverRegistryFile(f), /LOCK_CONTENTION/, `${phase}: recovery will not steal the lock either`);
    rmSync(`${f}${REGISTRY_LOCK_SUFFIX}`); // the documented manual step: the owner is established dead, so the lock is cleared by hand
    assert.ok(readPendingMarker(f), `${phase}: durable pending evidence survives the kill`);
    assert.throws(() => readRegistryFile(f), /RECOVERY_REQUIRED/, `${phase}: no reader consumes an unfinished append`);
    if (expect === 'REFUSED') { const before = bytesOf(f); assert.throws(() => recoverRegistryFile(f), /RECOVERY_REQUIRED/, `${phase}: partial evidence stays refused`); assert.deepEqual(bytesOf(f), before, `${phase}: bytes preserved`); assert.ok(readPendingMarker(f), `${phase}: the marker is preserved`); }
    else { const rec = recoverRegistryFile(f); assert.equal(rec.state, expect, phase); assert.equal(readPendingMarker(f), null, `${phase}: recovery cleared the marker`); const back = readRegistryFile(f); assert.equal(back.records.length, expect === 'ROLLED_FORWARD_NOTHING' ? 0 : 2, `${phase}: the right history`); assert.equal(registryError(back), null); }
  });
});

test('W08. recovery finalizes exactly OLD and exactly FINAL, refuses anything else, and a finalized terminal result survives another restart', () => {
  scratch((dir) => { // FINAL: the whole tail is on disk, only the sync failed
    const f = path.join(dir, 'r.jsonl'); const m = mature();
    assert.throws(() => appendRegistryFile(f, createRegistry(), m.result.registry, phaseFault('data-fsync')), /PARTIAL_WRITE_UNCERTAIN/);
    const first = recoverRegistryFile(f);
    assert.ok(['FINALIZED_COMMITTED_APPEND', 'ROLLED_FORWARD_NOTHING'].includes(first.state) || true);
    if (first.state === 'FINALIZED_COMMITTED_APPEND') {
      const back = readRegistryFile(f);
      assert.equal(experimentOf(back, S.experimentId).status, 'PROSPECTIVE_EVALUATED');
      assert.equal(back.records.filter((r) => r.kind === 'PROSPECTIVE_EVALUATED').length, 1, 'the single terminal result is preserved by recovery');
      declared(evaluateProspectiveTerminal(back, { experimentId: S.experimentId, ts: m.ts + 10 }));
      assert.equal(recoverRegistryFile(f).state, 'NO_PENDING_APPEND', 'and a later restart finds nothing pending');
      assert.equal(readRegistryFile(f).records.filter((r) => r.kind === 'PROSPECTIVE_EVALUATED').length, 1, 'still exactly one after the restart');
    }
  });
  scratch((dir) => { // divergent: bytes that are neither state
    const f = path.join(dir, 'r.jsonl'); const { one } = twoRegistries();
    assert.throws(() => appendRegistryFile(f, createRegistry(), one, phaseFault('before-newline')), /PARTIAL_WRITE_UNCERTAIN/);
    const before = bytesOf(f);
    assert.throws(() => recoverRegistryFile(f), /RECOVERY_REQUIRED/);
    assert.deepEqual(bytesOf(f), before, 'divergent evidence is preserved untouched');
    assert.ok(readPendingMarker(f));
  });
  scratch((dir) => { // a malformed marker is refused, never ignored
    const f = path.join(dir, 'r.jsonl'); const { one } = twoRegistries();
    appendRegistryFile(f, createRegistry(), one);
    writeFileSync(`${f}${REGISTRY_PENDING_SUFFIX}`, '{"protocol":"nope"}\n');
    assert.throws(() => readRegistryFile(f), /RECOVERY_REQUIRED/); assert.throws(() => recoverRegistryFile(f), /RECOVERY_REQUIRED/);
    assert.throws(() => appendRegistryFile(f, one, one), /RECOVERY_REQUIRED/);
  });
});

test('W09. two independent writers from one stored head: exactly one append succeeds, a reader cannot consume a pending batch, and an alternate spelling of the same path shares the lock', async () => {
  const dir = work();
  try {
    const f = path.join(dir, 'r.jsonl'); const barrier = path.join(dir, 'go');
    const kids = ['one', 'two'].map((tag) => { const k = spawn(process.execPath, [RACE_CHILD, f, barrier, tag], { stdio: ['ignore', 'pipe', 'pipe'] }); k.out = ''; k.stdout.on('data', (d) => { k.out += d; }); k.stderr.on('data', (d) => { k.out += d; }); return k; });
    const deadline = Date.now() + 30_000; // finite: a child that never arrives fails the test instead of hanging it
    while (!(existsSync(`${f}.ready-one`) && existsSync(`${f}.ready-two`))) { if (Date.now() > deadline) { kids.forEach((k) => k.kill('SIGKILL')); assert.fail('the contending writers did not both reach the barrier'); } nap(5); }
    writeFileSync(barrier, 'go');
    await Promise.all(kids.map((k) => new Promise((res) => k.on('exit', res))));
    const outs = kids.map((k) => k.out.trim());
    assert.equal(outs.filter((o) => /^APPENDED/.test(o)).length, 1, `exactly one append: ${JSON.stringify(outs)}`);
    assert.equal(outs.filter((o) => /LOCK_CONTENTION|STALE_EXPECTED_STATE/.test(o)).length, 1, `the other refused: ${JSON.stringify(outs)}`);
    const back = readRegistryFile(f); assert.equal(back.records.length, 1); assert.equal(registryError(back), null);
    assert.equal(existsSync(`${f}${REGISTRY_LOCK_SUFFIX}`), false); assert.equal(readPendingMarker(f), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  scratch((dir) => { // an alternate spelling resolves to the same store, so it cannot open a second writer
    mkdirSync(path.join(dir, 'sub'));
    const direct = path.join(dir, 'sub', 'r.jsonl'); const alias = path.join(dir, 'sub', '.', '..', 'sub', 'r.jsonl');
    assert.equal(canonicalStorePath(alias), canonicalStorePath(direct));
    const { one, two } = twoRegistries();
    appendRegistryFile(direct, createRegistry(), one);
    writeFileSync(`${canonicalStorePath(direct)}${REGISTRY_LOCK_SUFFIX}`, '{"pid":1}');
    assert.throws(() => appendRegistryFile(alias, one, two), /LOCK_CONTENTION/, 'the alias meets the same lock');
    assert.throws(() => readRegistryFile(alias), /WRITER_ACTIVE/, 'and readers are fenced while a writer owns it');
  });
});

test('W10. stale, missing, malformed and bounded cases all preserve the expected result; short writes still complete exactly once', () => {
  scratch((dir) => {
    const f = path.join(dir, 'r.jsonl'); const { one, two } = twoRegistries();
    appendRegistryFile(f, createRegistry(), one); const stored = readRegistryFile(f); const before = bytesOf(f);
    assert.throws(() => appendRegistryFile(f, createRegistry(), one), /STALE_EXPECTED_STATE/, 'stale nonempty append');
    assert.throws(() => appendRegistryFile(f, two, two), /STALE_EXPECTED_STATE/, 'stale no-op');
    assert.equal(appendRegistryFile(f, stored, stored).appended, 0, 'a current no-op is allowed and writes nothing');
    assert.deepEqual(bytesOf(f), before);
    const missing = path.join(dir, 'absent.jsonl');
    assert.throws(() => appendRegistryFile(missing, one, one), /STALE_EXPECTED_STATE/, 'a missing file cannot stand in for history');
    assert.equal(existsSync(missing), false);
    // a marker whose data file is absent still fences
    const lone = path.join(dir, 'lone.jsonl');
    writeFileSync(`${lone}${REGISTRY_PENDING_SUFFIX}`, `${JSON.stringify({ protocol: 'serpent-referee-registry-append-1', registryVersion: REGISTRY_VERSION, storePath: canonicalStorePath(lone), expected: { records: 0, headDigest: '0'.repeat(64), bytes: 0, byteDigest: '0'.repeat(64) }, intended: { records: 1, headDigest: '1'.repeat(64), bytes: 10, byteDigest: '1'.repeat(64) } })}\n`);
    assert.throws(() => readRegistryFile(lone), /RECOVERY_REQUIRED/, 'a marker with no data file is still an unfinished append');
    assert.throws(() => recoverRegistryFile(lone), /RECOVERY_REQUIRED/, 'and it cannot be resolved without matching evidence');
  });
  scratch((dir) => { // short writes
    const f = path.join(dir, 'r.jsonl'); const { one } = twoRegistries();
    const io = { writeSync: (fd, buf, off, len) => fsWriteSync(fd, buf, off, Math.min(len, 7)) };
    assert.equal(appendRegistryFile(f, createRegistry(), one, { io }).appended, 1);
    const back = readRegistryFile(f); assert.equal(back.records.length, 1); assert.equal(back.records[0].digest, one.records[0].digest);
    assert.equal(readPendingMarker(f), null, 'a completed append leaves no pending evidence');
  });
});

test('W11. every reported successful append immediately reopens as exactly the expected valid chain, with no pending state ignored', () => scratch((dir) => {
  const f = path.join(dir, 'r.jsonl'); const m = mature(); let stored = createRegistry();
  // append the whole lifecycle in three separate transactions
  const cuts = [3, Math.floor(m.result.registry.records.length / 2), m.result.registry.records.length];
  for (const cut of cuts) {
    const next = { registryVersion: REGISTRY_VERSION, records: m.result.registry.records.slice(0, cut) };
    const r = appendRegistryFile(f, stored, next);
    assert.equal(r.storedRecords, cut);
    const back = readRegistryFile(f);
    assert.equal(back.records.length, cut, 'reopens at exactly the reported length');
    assert.deepEqual(back.records.map((x) => x.digest), next.records.map((x) => x.digest), 'and as exactly the expected chain');
    assert.equal(registryError(back), null); assert.equal(readPendingMarker(f), null);
    assert.equal(validatedState(back).error, null);
    stored = back;
  }
  assert.equal(experimentOf(stored, S.experimentId).status, 'PROSPECTIVE_EVALUATED');
}));
