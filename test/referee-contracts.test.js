// RESEARCH REFEREE — A. contract tests, B. point-in-time tests, J. the immutable trial registry. Every rejection is a
// deterministic INVALID_INPUT / PIT_VIOLATION / LEAKAGE_DETECTED report with a closed reason code; nothing is repaired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refereeEvaluate } from '../research/referee/evaluate.js';
import { validateBundle } from '../research/referee/pitAudit.js';
import { createRegistry, registerExperiment, recordResult, abandonExperiment, openHoldout, registryError, registrySnapshot, experimentOf, trialHistory, experimentIdOf, familyMembers } from '../research/referee/registry.js';
import { readRegistryFile, appendRegistryFile } from '../research/referee/store.js';
import { REASON_CODES, VERDICTS, BUNDLE_KEYS, EXPERIMENT_MANIFEST_KEYS } from '../research/referee/contracts.js';
import { realEffectData, bundleFor, manifest, feature, condition, registryWith, CODE_IDENTITY, T0, HOUR, MIN, synth, mix } from './helpers/referee.js';
import { buildBundle } from '../research/referee/seal.js';

const data = realEffectData();
const base = () => bundleFor({ data });
// rebuild a bundle after mutating its parts so the checksums are honest (the mutation is the thing under test)
const rebuilt = (b, mutate) => {
  const parts = { experiment: structuredClone(b.experiment), dataset: { datasetId: b.dataset.datasetId, symbolScope: [...b.dataset.symbolScope], startTs: b.dataset.startTs, endTs: b.dataset.endTs, asOfTs: b.dataset.asOfTs, source: b.dataset.source, archive: b.dataset.archive }, observations: structuredClone(b.observations), outcomes: structuredClone(b.outcomes), provenance: b.provenance, codeIdentity: b.codeIdentity, registrySnapshot: null, seed: b.seed, requestedAtTs: b.evaluation.requestedAtTs };
  mutate(parts);
  const probe = buildBundle({ ...structuredClone(parts), registrySnapshot: registrySnapshot(createRegistry()) }); parts.experiment.dataset = { datasetId: probe.dataset.datasetId, manifestDigest: probe.dataset.manifestDigest, startTs: probe.dataset.startTs, endTs: probe.dataset.endTs, asOfTs: probe.dataset.asOfTs };
  if (parts.registrySnapshot === null) { let reg; try { reg = registryWith([parts.experiment]).registry; } catch { reg = createRegistry(); } parts.registrySnapshot = registrySnapshot(reg); }
  return buildBundle(parts);
};
const verdictOf = (b) => { const r = refereeEvaluate(b); return { verdict: r.verdict.verdict, reasons: r.verdict.reasons, report: r }; };

test('A1. exact keys: an undeclared bundle key, a missing key, a wrong version and a non-boolean flag are INVALID_INPUT with structural reasons; the closed vocabularies are what the report may say', () => {
  const { bundle } = base();
  assert.deepEqual(Object.keys(bundle).sort(), [...BUNDLE_KEYS].sort()); assert.deepEqual(Object.keys(bundle.experiment).sort(), [...EXPERIMENT_MANIFEST_KEYS].sort());
  let v = verdictOf({ ...bundle, extra: 1 }); assert.equal(v.verdict, 'INVALID_INPUT'); assert.deepEqual(v.reasons, ['SCHEMA']);
  const { seed, ...missing } = bundle; v = verdictOf(missing); assert.equal(v.verdict, 'INVALID_INPUT'); assert.deepEqual(v.reasons, ['SCHEMA']);
  v = verdictOf({ ...bundle, bundleVersion: 'serpent-referee-bundle-2' }); assert.deepEqual(v.reasons, ['UNKNOWN_VOCABULARY']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.split.purge = 'true'; })); assert.equal(v.verdict, 'INVALID_INPUT'); assert.deepEqual(v.reasons, ['SCHEMA']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.evaluationType = 'PNL'; })); assert.deepEqual(v.reasons, ['UNKNOWN_VOCABULARY']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.criteria.nullAlpha = 1; })); assert.deepEqual(v.reasons, ['SCHEMA']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.primaryMetric = 'AUROC'; })); assert.deepEqual(v.reasons, ['METRIC_TYPE_MISMATCH']);
  for (const code of REASON_CODES) assert.match(code, /^[A-Z0-9_]+$/); assert.equal(new Set(REASON_CODES).size, REASON_CODES.length); assert.equal(VERDICTS.length, 12);
  const r = refereeEvaluate({ nonsense: true }); assert.equal(r.verdict.verdict, 'INVALID_INPUT'); assert.equal(r.authority.canAffectTrading, false); assert.equal(r.authority.authority, 'NONE'); assert.ok(Object.isFrozen(r));
});

test('A2. NaN / Infinity, duplicate ids, duplicate labels, label / observation set mismatch, invalid symbol, symbol outside scope, manifest count mismatch, contradictory known / masked state', () => {
  const { bundle } = base();
  let v = verdictOf(rebuilt(bundle, (p) => { p.observations[3].features.SIG = NaN; })); assert.deepEqual([v.verdict, v.reasons], ['INVALID_INPUT', ['NON_FINITE_VALUE']]);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[3].value = Infinity; })); assert.deepEqual(v.reasons, ['NON_FINITE_VALUE']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[5].id = p.observations[4].id; })); assert.deepEqual(v.reasons, ['DUPLICATE_OBSERVATION_ID']);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[5].observationId = p.outcomes[4].observationId; })); assert.deepEqual(v.reasons, ['DUPLICATE_OUTCOME']);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[5].observationId = 'ghost'; })); assert.deepEqual(v.reasons, ['LABEL_SET_MISMATCH']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations.push({ ...structuredClone(p.observations[0]), id: 'orphan' }); })); assert.deepEqual(v.reasons, ['LABEL_SET_MISMATCH']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[0].symbol = 'btc'; })); assert.deepEqual(v.reasons, ['INVALID_SYMBOL']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[0].symbol = 'DOGE'; })); assert.deepEqual(v.reasons, ['SYMBOL_OUTSIDE_SCOPE']);
  v = verdictOf({ ...bundle, dataset: { ...bundle.dataset, observationCount: bundle.dataset.observationCount - 1 } }); assert.equal(v.verdict, 'INVALID_INPUT'); assert.ok(['CHECKSUM_MISMATCH', 'MANIFEST_COUNT_MISMATCH'].includes(v.reasons[0]));
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[2].state = 'MASKED'; })); assert.deepEqual(v.reasons, ['CONTRADICTORY_KNOWN_STATE']);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[2].value = null; })); assert.deepEqual(v.reasons, ['CONTRADICTORY_KNOWN_STATE']);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[2].outcomeKnownAtTs = 'soon'; })); assert.deepEqual(v.reasons, ['MISSING_TIMESTAMP']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[2].features = { SIG: 1, EXTRA: 2 }; })); assert.deepEqual(v.reasons, ['FEATURE_DEFINITION_MISMATCH']);
});

test('A3. checksums: any byte changed after sealing is CHECKSUM_MISMATCH until the bundle is resealed; the dataset manifest digest is recomputed, never trusted', () => {
  const { bundle } = base();
  const tampered = structuredClone(bundle); tampered.outcomes[0].value += 0.0001;
  let v = verdictOf(tampered); assert.deepEqual([v.verdict, v.reasons], ['INVALID_INPUT', ['CHECKSUM_MISMATCH']]);
  const t2 = structuredClone(bundle); t2.dataset.startTs -= 1; v = verdictOf(t2); assert.deepEqual(v.reasons, ['CHECKSUM_MISMATCH']);
  const t3 = structuredClone(bundle); t3.experiment.criteria.nullAlpha = 0.2; v = verdictOf(t3); assert.deepEqual(v.reasons, ['CHECKSUM_MISMATCH']);
  const resealed = rebuilt(bundle, (p) => { p.outcomes[0].value += 0.0001; }); const r = validateBundle(resealed); assert.equal(r.error, null, 'a resealed bundle validates'); assert.notEqual(resealed.checksums.outcomes, bundle.checksums.outcomes); assert.equal(resealed.dataset.manifestDigest, bundle.dataset.manifestDigest, 'the dataset manifest names counts and clocks, not values');
});

test('B1. the point-in-time wall: a legal as-of row passes; a feature one millisecond into the future, an outcome known before its horizon end, a reference price after the decision, a decision after the as-of and a missing market-wide aggregate clock all fail BEFORE any statistic; the stage order is PIT before leakage', () => {
  const { bundle } = base();
  const ok = refereeEvaluate(bundle); assert.equal(ok.pit.pass, true); assert.equal(ok.pit.violationCount, 0);
  let v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].featureKnownAtTs = p.observations[7].ts + 1; })); assert.deepEqual([v.verdict, v.reasons], ['PIT_VIOLATION', ['FEATURE_KNOWN_AFTER_DECISION']]); assert.equal(v.report.primaryResult, null); assert.equal(v.report.pit.findings[0].ordinal, 8);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[7].outcomeKnownAtTs = p.outcomes[7].labelEndTs - 1; })); assert.deepEqual(v.reasons, ['OUTCOME_KNOWN_BEFORE_HORIZON_END']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].referencePriceTs = p.observations[7].ts + 1; })); assert.deepEqual(v.reasons, ['REFERENCE_PRICE_AFTER_DECISION']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].receivedAtTs = p.observations[7].ts + 1; })); assert.deepEqual(v.reasons, ['RECEIVED_AFTER_DECISION']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].featureClocks = { SIG: p.observations[7].ts + 1 }; })); assert.deepEqual(v.reasons, ['FEATURE_KNOWN_AFTER_DECISION']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.features[0].scope = 'MARKET_WIDE'; })); assert.deepEqual(v.reasons, ['MARKET_WIDE_AGGREGATE_CLOCK_MISSING']);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[7].labelStartTs = p.observations[7].ts - 1; p.outcomes[7].labelEndTs = p.outcomes[7].labelStartTs + HOUR; })); assert.deepEqual(v.reasons, ['LABEL_STARTS_BEFORE_DECISION']);
  v = verdictOf(rebuilt(bundle, (p) => { p.outcomes[7].labelEndTs += 1; p.outcomes[7].outcomeKnownAtTs += 1; })); assert.deepEqual(v.reasons, ['LABEL_HORIZON_MISMATCH']);
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].ts = p.dataset.asOfTs + 1; p.observations[7].featureKnownAtTs = p.observations[7].ts; p.outcomes[7].labelStartTs = p.observations[7].ts; p.outcomes[7].labelEndTs = p.observations[7].ts + HOUR; p.outcomes[7].outcomeKnownAtTs = p.outcomes[7].labelEndTs; })); assert.equal(v.verdict, 'INVALID_INPUT'); assert.deepEqual(v.reasons, ['OUTCOME_MARKED_KNOWN_AFTER_AS_OF'], 'an outcome known after the as-of cannot be KNOWN');
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].ts = p.dataset.asOfTs + 1; p.observations[7].featureKnownAtTs = p.observations[7].ts; p.outcomes[7].labelStartTs = p.observations[7].ts; p.outcomes[7].labelEndTs = p.observations[7].ts + HOUR; p.outcomes[7].state = 'MASKED'; p.outcomes[7].value = null; p.outcomes[7].outcomeKnownAtTs = p.outcomes[7].labelEndTs; })); assert.equal(v.verdict, 'PIT_VIOLATION'); assert.ok(v.reasons.includes('DECISION_AFTER_AS_OF') && v.reasons.includes('DECISION_OUTSIDE_DATASET_WINDOW'));
  // PIT failure AND a leakage failure in the same bundle: the referee stops at PIT
  v = verdictOf(rebuilt(bundle, (p) => { p.observations[7].featureKnownAtTs = p.observations[7].ts + 1; p.experiment.features[0].normalization = 'FULL_SAMPLE'; })); assert.equal(v.verdict, 'PIT_VIOLATION'); assert.equal(v.report.leakage, null);
});

test('B2. archive / provenance clocks: an archive retrieved before an outcome horizon ended contradicts it; HORIZON_END_PLUS_ARCHIVE raises the outcome knowledge floor to the retrieval clock', () => {
  const { bundle } = base(); const lastEnd = Math.max(...bundle.outcomes.map((o) => o.labelEndTs));
  let v = verdictOf(rebuilt(bundle, (p) => { p.dataset.archive = { archiveId: 'arc', createdTs: T0 - HOUR, retrievedTs: lastEnd - 10 * MIN }; })); assert.equal(v.verdict, 'PIT_VIOLATION'); assert.ok(v.reasons.includes('ARCHIVE_CLOCK_CONTRADICTION'));
  v = verdictOf(rebuilt(bundle, (p) => { p.dataset.archive = { archiveId: 'arc', createdTs: T0 - HOUR, retrievedTs: lastEnd + HOUR }; p.experiment.label.knownAtRule = 'HORIZON_END_PLUS_ARCHIVE'; })); assert.equal(v.verdict, 'PIT_VIOLATION'); assert.deepEqual(v.reasons, ['OUTCOME_KNOWN_BEFORE_HORIZON_END'], 'outcomes stamped at horizon end were not yet in the archive');
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.label.knownAtRule = 'HORIZON_END_PLUS_ARCHIVE'; })); assert.equal(v.verdict, 'PIT_VIOLATION'); assert.ok(v.reasons.includes('ARCHIVE_CLOCK_CONTRADICTION'), 'the rule without an archive');
  v = verdictOf(rebuilt(bundle, (p) => { p.dataset.archive = { archiveId: 'arc', createdTs: T0 - HOUR, retrievedTs: lastEnd + HOUR }; p.experiment.label.knownAtRule = 'HORIZON_END_PLUS_ARCHIVE'; for (const o of p.outcomes) o.outcomeKnownAtTs = lastEnd + HOUR; })); assert.notEqual(v.verdict, 'PIT_VIOLATION'); assert.notEqual(v.verdict, 'INVALID_INPUT');
});

test('B3. the leakage auditor: present-day entity labels, outcome-derived inputs, full-sample normalization, survivor universes, undeclared purge / embargo over overlapping labels, and the empirical canary are LEAKAGE_DETECTED before scoring', () => {
  const { bundle } = base();
  let v = verdictOf(rebuilt(bundle, (p) => { p.experiment.features[0].kind = 'ENTITY_LABEL'; p.experiment.features[0].vintage = 'CURRENT_SNAPSHOT'; })); assert.deepEqual([v.verdict, v.reasons], ['LEAKAGE_DETECTED', ['ENTITY_LABEL_CURRENT_SNAPSHOT']]); assert.equal(v.report.primaryResult, null);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.features[0].inputs = ['TAPE_RETURNS', 'FUTURE_RETURN']; })); assert.deepEqual(v.reasons, ['FEATURE_DERIVED_FROM_OUTCOME']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.features[0].inputs = ['FORWARD_LOG_RETURN']; })); assert.deepEqual(v.reasons, ['FEATURE_DERIVED_FROM_OUTCOME']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.features[0].normalization = 'FULL_SAMPLE'; })); assert.deepEqual(v.reasons, ['NORMALIZATION_FITTED_ON_FULL_SAMPLE']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.universe.definition = 'CURRENT_SURVIVORS'; })); assert.deepEqual(v.reasons, ['UNIVERSE_DEFINED_BY_SURVIVORS']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.universe.definition = 'CURRENT_LISTINGS'; })); assert.deepEqual(v.reasons, ['UNIVERSE_DEFINED_BY_CURRENT_LISTINGS']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.split.purge = false; p.experiment.split.embargoMs = 0; })); assert.deepEqual(v.reasons, ['PURGE_NOT_DECLARED_WITH_OVERLAPPING_LABELS', 'EMBARGO_NOT_DECLARED']);
  v = verdictOf(rebuilt(bundle, (p) => { p.experiment.features.push(feature('LEAK')); for (let i = 0; i < p.observations.length; i += 1) p.observations[i].features.LEAK = p.outcomes[i].value; })); assert.deepEqual(v.reasons, ['FEATURE_REPRODUCES_OUTCOME']); assert.ok(v.report.leakage.canary.checks.find((c) => c.feature === 'LEAK').rho > 0.999);
  const lead = verdictOf(rebuilt(bundle, (p) => { p.experiment.features[0].inputs = ['ONCHAIN_LABEL']; })); assert.deepEqual(lead.reasons, ['FEATURE_DERIVED_FROM_OUTCOME'], 'LABEL is an outcome token');
});

test('J1. the registry: identity is the decision-relevant declaration; a duplicate registration, a second result, a post-result variant without a parent and a post-hoc hypothesis without provenance are refused; abandoned trials keep counting; the chain refuses tampering', () => {
  let reg = createRegistry(); const m1 = manifest({ name: 'one' }); const m1b = manifest({ name: 'one-renamed', reason: 'same declaration, other prose' });
  assert.equal(experimentIdOf(m1), experimentIdOf(m1b), 'name and reason are not identity');
  let r = registerExperiment(reg, m1, { registeredAtTs: T0, codeIdentity: CODE_IDENTITY }); assert.equal(r.error, null); reg = r.registry;
  r = registerExperiment(reg, m1b, { registeredAtTs: T0 + 1, codeIdentity: CODE_IDENTITY }); assert.equal(r.error.reason, 'ALREADY_REGISTERED');
  const m2 = manifest({ name: 'two', signal: { feature: 'SIG', condition: condition('GT', 0.5) } }); assert.notEqual(experimentIdOf(m2), experimentIdOf(m1), 'a threshold change is a new experiment');
  r = registerExperiment(reg, m2, { registeredAtTs: T0 + 2, codeIdentity: CODE_IDENTITY }); assert.equal(r.error, null); reg = r.registry; assert.equal(r.experimentFamilyId, experimentOf(reg, experimentIdOf(m1)).experimentFamilyId, 'same family');
  r = recordResult(reg, { experimentId: experimentIdOf(m1), reportDigest: 'b'.repeat(64), verdict: 'REJECTED', primaryMetric: { name: 'SHARPE_PER_OBS', value: 0.01 }, sharpes: [0.01], datasetDigest: 'c'.repeat(64), recordedAtTs: T0 + 3 }); assert.equal(r.error, null); reg = r.registry;
  r = recordResult(reg, { experimentId: experimentIdOf(m1), reportDigest: 'd'.repeat(64), verdict: 'HISTORICALLY_INTERESTING', primaryMetric: { name: 'SHARPE_PER_OBS', value: 0.5 }, sharpes: [0.5], datasetDigest: 'c'.repeat(64), recordedAtTs: T0 + 4 }); assert.equal(r.error.reason, 'RESULT_ALREADY_RECORDED', 'no overwrite of the bad run');
  r = recordResult(reg, { experimentId: experimentIdOf(m1), reportDigest: 'd'.repeat(64), verdict: 'ENTER', primaryMetric: { name: 'X', value: 0 }, sharpes: [], datasetDigest: 'c'.repeat(64), recordedAtTs: T0 + 4 }); assert.ok(r.error);
  const m3 = manifest({ name: 'three', signal: { feature: 'SIG', condition: condition('GT', 0.7) } }); r = registerExperiment(reg, m3, { registeredAtTs: T0 + 5, codeIdentity: CODE_IDENTITY }); assert.equal(r.error.reason, 'FORK_REQUIRES_PARENT', 'the family carries a result: a rewrite must name its parent');
  const m3p = { ...m3, parentExperimentId: experimentIdOf(m1) }; r = registerExperiment(reg, m3p, { registeredAtTs: T0 + 5, codeIdentity: CODE_IDENTITY }); assert.equal(r.error, null); reg = r.registry; assert.equal(reg.records[reg.records.length - 1].payload.familyRule, 'INHERITED_FROM_PARENT');
  const posthoc = manifest({ name: 'ph', hypothesisOrigin: 'AFTER_INSPECTING_OUTCOMES', familyTag: 'OTHER', features: [feature('NEW')], signal: { feature: 'NEW', condition: condition('GT', 0) } }); r = registerExperiment(reg, posthoc, { registeredAtTs: T0 + 6, codeIdentity: CODE_IDENTITY }); assert.equal(r.error.reason, 'POST_HOC_REQUIRES_PARENT');
  r = abandonExperiment(reg, { experimentId: experimentIdOf(m2), reasonCode: 'LOST_INTEREST', ts: T0 + 7 }); assert.equal(r.error, null); reg = r.registry;
  const th = trialHistory(reg, experimentIdOf(m3p)); assert.equal(th.rawTrialCount, 3); assert.equal(th.memberCount, 3); assert.deepEqual(th.members.map((x) => x.status).sort(), ['ABANDONED', 'EVALUATED', 'REGISTERED']); assert.deepEqual(th.recordedSharpes, [0.01]);
  r = registerExperiment(reg, { ...m3p, parentExperimentId: 'exp-unknown' }, { registeredAtTs: T0 + 8, codeIdentity: CODE_IDENTITY }); assert.equal(r.error.reason, 'PARENT_UNKNOWN');
  // shared feature identity pulls a differently tagged experiment into the family (no parent needed before results... but this family has a result)
  const evade = manifest({ name: 'evade', familyTag: 'FRESH_TAG', signal: { feature: 'SIG', condition: condition('GT', 0.9) } }); r = registerExperiment(reg, evade, { registeredAtTs: T0 + 9, codeIdentity: CODE_IDENTITY }); assert.equal(r.error.reason, 'FORK_REQUIRES_PARENT', 'a new tag over the same feature identity cannot evade the family');
  assert.equal(registryError(reg), null);
  const tampered = { ...reg, records: reg.records.map((x, i) => (i === 1 ? { ...x, payload: { ...x.payload, candidateCount: 99 } } : x)) }; assert.equal(registryError(tampered).reason, 'REGISTRY_CHAIN_BROKEN');
  const snap = registrySnapshot(reg); assert.equal(snap.headSeq, reg.records.length); assert.throws(() => { snap.records.push({}); });
  const r2 = openHoldout(reg, { experimentId: experimentIdOf(m1), startTs: T0 + 10 * HOUR, endTs: T0 + 20 * HOUR, ts: T0 + 10 }); assert.equal(r2.error, null); const r3 = openHoldout(r2.registry, { experimentId: experimentIdOf(m3p), startTs: T0 + 15 * HOUR, endTs: T0 + 25 * HOUR, ts: T0 + 11 }); assert.equal(r3.error.reason, 'HOLDOUT_ALREADY_OPENED');
  assert.equal(familyMembers(reg, 'fam-nope').length, 0);
});

test('J2. evaluation binds to the registry: an unregistered experiment, a manifest that differs from the registered one, a request dated before registration and a corrupted snapshot are INVALID_INPUT; an opened family holdout overlapping the dataset is HOLDOUT_CONTAMINATED for another member', () => {
  const { bundle, manifest: m, registry } = base();
  let v = verdictOf({ ...bundle, registrySnapshot: registrySnapshot(createRegistry()), checksums: { ...bundle.checksums, registrySnapshot: undefined } }); assert.equal(v.verdict, 'INVALID_INPUT');
  v = verdictOf(rebuilt(bundle, (p) => { p.registrySnapshot = registrySnapshot(createRegistry()); })); assert.deepEqual(v.reasons, ['EXPERIMENT_NOT_REGISTERED']);
  v = verdictOf(rebuilt(bundle, (p) => { p.requestedAtTs = registry.records[0].ts - 1; })); assert.deepEqual(v.reasons, ['EVALUATION_BEFORE_REGISTRATION']);
  const broken = structuredClone(registrySnapshot(registry)); broken.records[0].payload.candidateCount = 5; v = verdictOf(rebuilt(bundle, (p) => { p.registrySnapshot = broken; })); assert.deepEqual(v.reasons, ['REGISTRY_CHAIN_BROKEN']);
  const wrongHead = { ...registrySnapshot(registry), headDigest: 'e'.repeat(64) }; v = verdictOf(rebuilt(bundle, (p) => { p.registrySnapshot = wrongHead; })); assert.deepEqual(v.reasons, ['REGISTRY_SNAPSHOT_DIGEST_MISMATCH']);
  // holdout contamination: another member of the family opened a window overlapping this dataset
  const sibling = manifest({ name: 'sib', signal: { feature: 'SIG', condition: condition('GT', 0.25) } }, bundle.dataset); let reg = registerExperiment(registry, sibling, { registeredAtTs: registry.records[0].ts + 1, codeIdentity: CODE_IDENTITY }).registry;
  reg = openHoldout(reg, { experimentId: experimentIdOf(sibling), startTs: bundle.dataset.endTs - HOUR, endTs: bundle.dataset.endTs + HOUR, ts: registry.records[0].ts + 2 }).registry;
  v = verdictOf(rebuilt(bundle, (p) => { p.registrySnapshot = registrySnapshot(reg); })); assert.deepEqual([v.verdict, v.reasons], ['LEAKAGE_DETECTED', ['HOLDOUT_CONTAMINATED']]);
  assert.equal(m.name, 'fixture-experiment');
});

test('J3. the durable store: append-only JSONL with the chain re-verified on read; a divergent registry is refused; a tampered line is CORRUPT input, never repaired', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'referee-reg-')); const file = path.join(dir, 'registry.jsonl');
  try {
    const { registry } = registryWith([manifest({ name: 'a' })]); assert.equal(readRegistryFile(file).records.length, 0);
    let w = appendRegistryFile(file, createRegistry(), registry); assert.equal(w.appended, 1);
    const reg2 = recordResult(registry, { experimentId: registry.records[0].experimentId, reportDigest: 'b'.repeat(64), verdict: 'REJECTED', primaryMetric: { name: 'SHARPE_PER_OBS', value: 0 }, sharpes: [], datasetDigest: 'c'.repeat(64), recordedAtTs: registry.records[0].ts + 1 }).registry;
    w = appendRegistryFile(file, registry, reg2); assert.equal(w.appended, 1); const back = readRegistryFile(file); assert.equal(back.records.length, 2); assert.equal(registryError(back), null); assert.equal(back.records[1].digest, reg2.records[1].digest);
    const other = registryWith([manifest({ name: 'b', familyTag: 'B' })]).registry; assert.throws(() => appendRegistryFile(file, back, other), /diverges|shorter/);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"REJECTED"', '"HISTORICALLY_INTERESTING"')); assert.throws(() => readRegistryFile(file), /CORRUPT_INPUT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('J4. family history raises the bar: the same evaluation under a registry that already carries many evaluated family trials yields a LOWER deflated Sharpe than under a single-trial family', () => {
  const { bundle: solo } = base(); const rSolo = refereeEvaluate(solo);
  const extras = Array.from({ length: 30 }, (_, i) => manifest({ name: `variant-${i}`, signal: { feature: 'SIG', condition: condition('GT', (i + 1) / 100) } }, solo.dataset));
  let reg = createRegistry(); let ts = T0 - 10 * 24 * HOUR;
  for (const x of extras) { const r = registerExperiment(reg, x, { registeredAtTs: ts, codeIdentity: CODE_IDENTITY }); reg = r.registry; ts += MIN; }
  for (let i = 0; i < extras.length; i += 1) { const r = recordResult(reg, { experimentId: experimentIdOf(extras[i]), reportDigest: 'b'.repeat(64), verdict: 'REJECTED', primaryMetric: { name: 'SHARPE_PER_OBS', value: (i - 15) / 100 }, sharpes: [(i - 15) / 100], datasetDigest: solo.dataset.manifestDigest, recordedAtTs: ts }); reg = r.registry; ts += MIN; }
  const mine = manifest({ parentExperimentId: experimentIdOf(extras[0]) }, solo.dataset); const r = registerExperiment(reg, mine, { registeredAtTs: ts, codeIdentity: CODE_IDENTITY }); assert.equal(r.error, null);
  const { bundle: burdened } = bundleFor({ data, manifestOver: { parentExperimentId: experimentIdOf(extras[0]) }, registry: r.registry });
  const rB = refereeEvaluate(burdened);
  assert.equal(rB.trialHistory.rawTrialCount, 31); assert.equal(rSolo.trialHistory.rawTrialCount, 1);
  assert.ok(rB.overfitting.dsr.applicable && rSolo.overfitting.dsr.applicable);
  assert.ok(rB.overfitting.dsr.benchmarkSharpe > 0 && rSolo.overfitting.dsr.benchmarkSharpe === 0);
  assert.ok(rB.overfitting.dsr.median < rSolo.overfitting.dsr.median, `burdened ${rB.overfitting.dsr.median} < solo ${rSolo.overfitting.dsr.median}`);
  assert.equal(rB.overfitting.dsr.trials.effectiveTrialCount, 31, 'trials outside the bundle count raw');
});
