// RESEARCH REFEREE — the four synthetic acceptance fixtures, G. fragility, I. reproducibility, the prospective shadow,
// the resource bounds and the absence census. Everything here is FIXTURE provenance: none of it is Serpent history and
// none of it validates any actual Serpent edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refereeEvaluate, resultSharpesOf } from '../research/referee/evaluate.js';
import { verifyReport, renderReport, reportDigestOf, buildBundle } from '../research/referee/seal.js';
import { writeReportFile } from '../research/referee/store.js';
import { recordResult, registrySnapshot, experimentOf } from '../research/referee/registry.js';
import { openProspective, captureProspectiveObservation, recordProspectiveOutcome, prospectiveProgress, evaluateProspectiveTerminal, INTERIM_BANNER, ANYTIME_VALID } from '../research/referee/prospective.js';
import { describe } from '../research/referee/statistics.js';
import { FORBIDDEN_TOKENS, LIMITS, tokensOf } from '../research/referee/contracts.js';
import { realEffectData, noiseData, leakData, knifeEdgeData, bundleFor, feature, condition, synth, mix, T0, HOUR, MIN, PROVENANCE, CODE_IDENTITY } from './helpers/referee.js';

const walkStrings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStrings(x, out)); return out; };
const noForbidden = (report) => { for (const s of walkStrings(report)) if (/^[A-Z0-9_]+$/.test(s)) assert.ok(!tokensOf(s).some((t) => FORBIDDEN_TOKENS.includes(t)), `forbidden token in ${s}`); };
const stabilityWith = (neighbors) => ({ neighbors, leaveOneBlockOut: true, blocks: 5, leaveOneSymbolOut: true, earlyLate: true, regimeFeature: null, dayOfWeek: false, minPartitionRows: 20 });

test('FIXTURE 1 — REAL EFFECT: PIT clean, leakage clean, the out-of-sample effect remains, the negative controls weaken it, the verdict reaches HISTORICALLY_INTERESTING and means only "worth continued research"', () => {
  const { bundle } = bundleFor({ data: realEffectData() }); const r = refereeEvaluate(bundle);
  assert.equal(r.pit.pass, true); assert.equal(r.leakage.pass, true); assert.equal(r.verdict.verdict, 'HISTORICALLY_INTERESTING'); assert.deepEqual(r.verdict.reasons, ['SURVIVED_HISTORICAL_TESTS']); assert.equal(r.verdict.stage, 'COMPLETE');
  assert.ok(r.primaryResult.value > 0 && r.primaryResult.uncertainty.lower > 0, 'OOS effect remains'); assert.equal(r.primaryResult.metric, 'SHARPE_PER_OBS'); assert.equal(r.primaryResult.scale, 'PER_OBSERVATION');
  const c = r.overfitting.negativeControls; assert.ok(c.timeShift.placeboDistribution.mean < r.primaryResult.value); assert.ok(c.permutation.nullDistribution.mean < r.primaryResult.value); assert.ok(c.nullFeature.distribution.mean < r.primaryResult.value);
  assert.ok(r.overfitting.psr.median > 0.95 && r.overfitting.dsr.median > 0.95); assert.equal(r.overfitting.dsr.trials.rawTrialCount, 1);
  assert.equal(r.stability.directionConsistency, 1); assert.deepEqual(r.stability.flags, ['NEIGHBORS_NOT_DECLARED']); assert.ok(r.stability.concentration.maxBlockShare < 0.6);
  assert.match(r.verdict.meaning, /NOT production approval/); assert.match(r.verdict.meaning, /prospective test is still required/);
  assert.deepEqual(r.authority, { authority: 'NONE', purpose: 'RESEARCH_ONLY', researchOnly: true, canAffectTrading: false, canAffectEligibility: false, canAffectSizing: false, canAffectExecution: false, law: r.authority.law });
  noForbidden(r); assert.ok(Object.isFrozen(r) && Object.isFrozen(r.primaryResult));
  assert.ok(r.splits.design.purgedRows > 0 && r.splits.design.embargoedRows > 0); assert.equal(r.splits.design.validPaths, 1); assert.equal(r.identity.provenance.origin, 'FIXTURE');
  assert.match(renderReport(r), /VERDICT HISTORICALLY_INTERESTING/); assert.match(renderReport(r), /authority NONE/);
});

test('FIXTURE 2 — PURE NOISE + PARAMETER MINING: the naive best Sharpe looks attractive, the referee counts the forty trials, DSR / PBO / the placebo expose the selection, and the winner is never marked robust', () => {
  const nd = noiseData(40); const feats = Array.from({ length: 40 }, (_, i) => `F${i + 1}`);
  const naive = feats.map((f) => { const xs = nd.observations.map((o, i) => (o.features[f] > 0 ? nd.outcomes[i].value : 0)); return { f, sharpe: describe(xs).sharpe, n: xs.length }; }).sort((a, b) => b.sharpe - a.sharpe);
  assert.ok(naive[0].sharpe * Math.sqrt(naive[0].n) > 1.8, `the mined winner looks attractive: t ${naive[0].sharpe * Math.sqrt(naive[0].n)}`);
  const cands = feats.map((f) => ({ candidateId: `cand-${f}`, params: { feature: f }, signal: { feature: f, condition: condition('GT', 0) } }));
  const { bundle } = bundleFor({ data: nd, manifestOver: { features: feats.map((f) => feature(f)), signal: { feature: naive[0].f, condition: condition('GT', 0) }, candidates: cands, primaryCandidateId: `cand-${naive[0].f}` } });
  const r = refereeEvaluate(bundle);
  assert.equal(r.trialHistory.rawTrialCount, 40); assert.equal(r.splits.design.candidateCount, 40);
  assert.ok(['REJECTED', 'SUSPECT_MULTIPLE_TESTING'].includes(r.verdict.verdict), r.verdict.verdict); assert.notEqual(r.verdict.verdict, 'HISTORICALLY_INTERESTING');
  assert.equal(r.overfitting.pbo.applicable, true); assert.ok(r.overfitting.pbo.pbo > bundle.experiment.criteria.maxPbo, `PBO ${r.overfitting.pbo.pbo}`);
  assert.equal(r.overfitting.dsr.applicable, true); assert.ok(r.overfitting.dsr.median < bundle.experiment.criteria.minDsr, `DSR ${r.overfitting.dsr.median}`); assert.ok(r.overfitting.dsr.benchmarkSharpe > 0, 'the family burden sets a positive benchmark');
  assert.ok(r.overfitting.dsr.trials.effectiveTrialCount > 1 && r.overfitting.dsr.trials.effectiveTrialCount <= 40);
  assert.ok(r.overfitting.negativeControls.timeShift.p > 0.05 || r.overfitting.negativeControls.permutation.p > 0.05 || r.overfitting.pbo.pbo >= 0.5 || r.overfitting.dsr.median <= 0.5, 'at least one hostile check exposes the mining');
  noForbidden(r);
});

test('FIXTURE 3 — FUTURE LEAK: the hidden future-derived predictor stops the referee BEFORE statistical scoring (LEAKAGE_DETECTED); the same predictor with a dishonest clock is PIT_VIOLATION; a declared future input is LEAKAGE_DETECTED', () => {
  const ld = leakData();
  const r = refereeEvaluate(bundleFor({ data: ld, manifestOver: { features: [feature('SIG'), feature('LEAK')] } }).bundle);
  assert.equal(r.verdict.verdict, 'LEAKAGE_DETECTED'); assert.deepEqual(r.verdict.reasons, ['FEATURE_REPRODUCES_OUTCOME']); assert.equal(r.primaryResult, null); assert.equal(r.overfitting, null); assert.equal(r.splits, null);
  const clocked = structuredClone(ld); for (const o of clocked.observations) o.featureClocks = { LEAK: o.ts + HOUR };
  const r2 = refereeEvaluate(bundleFor({ data: clocked, manifestOver: { features: [feature('SIG'), feature('LEAK')] } }).bundle); assert.equal(r2.verdict.verdict, 'PIT_VIOLATION'); assert.deepEqual(r2.verdict.reasons, ['FEATURE_KNOWN_AFTER_DECISION']); assert.equal(r2.pit.violationCount, ld.observations.length); assert.equal(r2.pit.findings.length, LIMITS.maxViolationsListed);
  const r3 = refereeEvaluate(bundleFor({ data: ld, manifestOver: { features: [feature('SIG'), feature('LEAK', { inputs: ['FUTURE_CLOSE'] })] } }).bundle); assert.equal(r3.verdict.verdict, 'LEAKAGE_DETECTED'); assert.ok(r3.verdict.reasons.includes('FEATURE_DERIVED_FROM_OUTCOME'));
});

test('FIXTURE 4 — KNIFE-EDGE: only one parameter cell looks strong; the declared neighbours fail their own null; the verdict is SUSPECT_FRAGILITY / KNIFE_EDGE_PARAMETER and cannot be presented as broadly robust; a broad effect stays stable', () => {
  const kc = ['SIG_P4', 'SIG_P5', 'SIG_P6'].map((f) => ({ candidateId: f, params: { p: Number(f.slice(-1)) }, signal: { feature: f, condition: condition('GT', 0) } }));
  const { bundle } = bundleFor({ data: knifeEdgeData(), manifestOver: { features: ['SIG_P4', 'SIG_P5', 'SIG_P6'].map((f) => feature(f)), signal: { feature: 'SIG_P5', condition: condition('GT', 0) }, candidates: kc, primaryCandidateId: 'SIG_P5', stability: stabilityWith([{ candidateId: 'SIG_P4', axis: 'PARAMETER', distance: 1 }, { candidateId: 'SIG_P6', axis: 'PARAMETER', distance: 1 }]) } });
  const r = refereeEvaluate(bundle);
  assert.equal(r.verdict.verdict, 'SUSPECT_FRAGILITY'); assert.ok(r.verdict.reasons.includes('KNIFE_EDGE_PARAMETER')); assert.equal(r.stability.knifeEdge.flagged, true); assert.equal(r.stability.knifeEdge.neighborsSupportive, 0);
  assert.ok(r.stability.perturbations.filter((p) => p.kind === 'NEIGHBOR').every((p) => p.nullP > 0.05));
  assert.ok(r.primaryResult.value > 0 && r.overfitting.negativeControls.permutation.p <= 0.05, 'the cell itself passes its null; that is not enough');
  // a broad effect: neighbours carry the same signal and support it
  const broad = synth({ seed: 'broad', steps: 400, features: (rng, y) => { const core = mix(rng, y, 0.4); return { SIG_P4: core + 0.2 * rng.normal(), SIG_P5: core, SIG_P6: core + 0.2 * rng.normal() }; } });
  const rb = refereeEvaluate(bundleFor({ data: broad, manifestOver: { features: ['SIG_P4', 'SIG_P5', 'SIG_P6'].map((f) => feature(f)), signal: { feature: 'SIG_P5', condition: condition('GT', 0) }, candidates: kc, primaryCandidateId: 'SIG_P5', stability: stabilityWith([{ candidateId: 'SIG_P4', axis: 'PARAMETER', distance: 1 }, { candidateId: 'SIG_P6', axis: 'PARAMETER', distance: 1 }]) } }).bundle);
  assert.equal(rb.stability.knifeEdge.flagged, false); assert.equal(rb.stability.knifeEdge.neighborsSupportive, 2); assert.deepEqual(rb.stability.flags, []); assert.equal(rb.stability.directionConsistency, 1); assert.ok(['HISTORICALLY_INTERESTING', 'SUSPECT_MULTIPLE_TESTING'].includes(rb.verdict.verdict), rb.verdict.verdict);
});

test('G2. concentration and regime dependence: an effect carried by one symbol is CONCENTRATED_IN_ONE_SYMBOL; an effect present in one point-in-time regime only is REGIME_DEPENDENT; the horizon profile flags an isolated bucket', () => {
  const oneSymbol = synth({ seed: 'concentrated', steps: 400, features: (rng, y, t, s) => ({ SIG: s === 'BTC' ? mix(rng, y, 0.8) : rng.normal() }) });
  const r = refereeEvaluate(bundleFor({ data: oneSymbol }).bundle);
  assert.ok(r.stability.flags.includes('CONCENTRATED_IN_ONE_SYMBOL'), r.stability.flags.join()); assert.ok(['SUSPECT_FRAGILITY', 'SUSPECT_MULTIPLE_TESTING', 'REJECTED'].includes(r.verdict.verdict), r.verdict.verdict); assert.notEqual(r.verdict.verdict, 'HISTORICALLY_INTERESTING'); if (r.verdict.verdict === 'SUSPECT_FRAGILITY') assert.ok(r.verdict.reasons.includes('CONCENTRATED_IN_ONE_SYMBOL'));
  const regimes = synth({ seed: 'regime', steps: 400, regime: (rng, t) => (t % 40 < 20 ? 'HIGH_VOL' : 'LOW_VOL'), features: (rng, y, t) => ({ SIG: t % 40 < 20 ? mix(rng, y, 0.6) : rng.normal() }) });
  const rr = refereeEvaluate(bundleFor({ data: regimes, manifestOver: { stability: { ...stabilityWith([]), regimeFeature: 'REGIME' } } }).bundle);
  assert.ok(rr.stability.regimeDependency.evaluated); assert.equal(rr.stability.regimeDependency.dependent, true); assert.ok(rr.stability.flags.includes('REGIME_DEPENDENT')); assert.notEqual(rr.verdict.verdict, 'HISTORICALLY_INTERESTING'); if (rr.verdict.verdict === 'SUSPECT_FRAGILITY') assert.ok(rr.verdict.reasons.includes('REGIME_DEPENDENT'));
  const isolated = synth({ seed: 'horizon', steps: 400, horizonValues: true, features: (rng, y) => ({ SIG: mix(rng, y, 0.4) }) });
  const rh = refereeEvaluate(bundleFor({ data: isolated, manifestOver: { controls: { blockLengthRule: 'MAX_OVERLAP_PLUS_ONE', blockLengthRows: null, shiftCount: 30, permutationIterations: 200, bootstrapIterations: 200, nullFeatureTrials: 30, symbolPlacebo: true, horizonProfile: true } } }).bundle);
  assert.equal(rh.overfitting.negativeControls.horizonProfile.applicable, true); assert.equal(rh.overfitting.negativeControls.horizonProfile.horizons.length, 3); assert.equal(rh.overfitting.negativeControls.horizonProfile.coherent, true, 'neighbouring horizons carry the same sign here'); assert.equal(rh.overfitting.negativeControls.symbolPlacebo.applicable, true);
});

test('I1. reproducibility: the same sealed bundle yields a byte-identical canonical report and digest; a changed decision-relevant input changes the digest; an old report does not validate against a changed manifest; the seed is recorded', () => {
  const { bundle } = bundleFor({ data: realEffectData('repro') }); const a = refereeEvaluate(bundle); const b = refereeEvaluate(bundle);
  assert.equal(a.reportDigest, b.reportDigest); assert.equal(JSON.stringify(a), JSON.stringify(b)); assert.equal(reportDigestOf(a), a.reportDigest); assert.equal(a.identity.seed, bundle.seed);
  assert.deepEqual(verifyReport(a, bundle), { ok: true, finding: null, reproducedDigest: a.reportDigest });
  const { bundle: other } = bundleFor({ data: realEffectData('repro'), seed: 'seed-2' }); const c = refereeEvaluate(other); assert.notEqual(c.reportDigest, a.reportDigest, 'another seed is another report'); assert.equal(c.verdict.verdict, a.verdict.verdict);
  const changed = realEffectData('repro'); changed.outcomes[10].value += 0.5; const { bundle: cb } = bundleFor({ data: changed }); const d = refereeEvaluate(cb); assert.notEqual(d.reportDigest, a.reportDigest); assert.notEqual(cb.dataset.manifestDigest === bundle.dataset.manifestDigest, false, 'same counts keep the dataset manifest digest; the outcome checksum differs'); assert.notEqual(cb.checksums.outcomes, bundle.checksums.outcomes);
  const v = verifyReport(a, cb); assert.equal(v.ok, false); assert.ok(['CHECKSUM_MISMATCH', 'DATASET_IDENTITY_MISMATCH'].includes(v.finding.reason));
  const forged = { ...a, verdict: { ...a.verdict, verdict: 'REJECTED', reasons: ['NO_OOS_EFFECT'] } }; assert.equal(a.verdict.verdict, 'HISTORICALLY_INTERESTING'); assert.equal(verifyReport(forged, bundle).finding.reason, 'CHECKSUM_MISMATCH');
  const { bundle: ob } = bundleFor({ data: realEffectData('repro'), manifestOver: { criteria: { nullAlpha: 0.01, minDsr: 0.99, maxPbo: 0.1, minDirectionConsistency: 0.9, maxConcentrationShare: 0.5, minOosPathsPositive: 0.9 } } }); assert.equal(verifyReport(a, ob).finding.reason, 'CHECKSUM_MISMATCH', 'a changed manifest is a different bundle');
  const dir = mkdtempSync(path.join(tmpdir(), 'referee-rep-')); try { const f = path.join(dir, 'report.json'); const w = writeReportFile(f, a); assert.equal(w.reportDigest, a.reportDigest); assert.equal(JSON.parse(readFileSync(f, 'utf8')).reportDigest, a.reportDigest); assert.throws(() => writeReportFile(f, a), /OUTPUT_EXISTS/); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PROSPECTIVE — the shadow: only a HISTORICALLY_INTERESTING result may open a sealed design; captures and outcomes are two DARK stages with coherent clocks; interim progress is descriptive; the formal look happens once at the terminal count; anytime-valid inference is NOT_IMPLEMENTED', () => {
  const data = realEffectData('prospective'); const { bundle, registry } = bundleFor({ data, manifestOver: { prospective: { terminalObservations: 20, horizonMs: HOUR, universeRule: 'DECLARED_STATIC_LIST', sequentialMethod: null } } });
  const report = refereeEvaluate(bundle); assert.equal(report.verdict.verdict, 'HISTORICALLY_INTERESTING'); assert.equal(report.prospective.status, 'DESIGN_DECLARED');
  const id = report.identity.experimentId; const t1 = bundle.evaluation.requestedAtTs + MIN;
  assert.equal(openProspective(registry, { experimentId: id, historicalReport: report, ts: t1 }).error.reason, 'STATUS_TRANSITION_REFUSED', 'the result must be recorded first');
  let reg = recordResult(registry, { experimentId: id, reportDigest: report.reportDigest, verdict: report.verdict.verdict, primaryMetric: { name: report.primaryResult.metric, value: report.primaryResult.value }, sharpes: resultSharpesOf(report), datasetDigest: bundle.dataset.manifestDigest, recordedAtTs: t1 }).registry;
  const forged = { ...report, verdict: { ...report.verdict, verdict: 'REJECTED' } };
  assert.equal(openProspective(reg, { experimentId: id, historicalReport: forged, ts: t1 + 1 }).error.reason, 'CHECKSUM_MISMATCH');
  const opened = openProspective(reg, { experimentId: id, historicalReport: report, ts: t1 + MIN }); assert.equal(opened.error, null); reg = opened.registry;
  const T = t1 + MIN; // the sealing clock
  assert.equal(opened.design.terminalObservations, 20); assert.equal(opened.design.condition.threshold, 0); assert.equal(opened.design.feature, 'SIG');
  assert.deepEqual(opened.design.anytimeValid, ANYTIME_VALID); assert.ok(opened.design.nullSeed, 'the null seed is bound at opening');
  assert.equal(experimentOf(reg, id).status, 'PROSPECTIVE_PENDING');
  // a decision that predates the sealing is refused, whatever its recording clock says
  assert.equal(captureProspectiveObservation(reg, { experimentId: id, observation: { observationId: 'p-early', symbol: 'BTC', ts: T - MIN, score: 1, labelEndTs: T - MIN + HOUR }, ts: T + MIN }).error.reason, 'EVALUATION_BEFORE_REGISTRATION');
  // 21 future decisions on a coherent clock: each is captured a minute after it is decided, well inside its own hour
  const future = synth({ seed: 'prospective-future', steps: 21, symbols: ['BTC'], features: (rng, y) => ({ SIG: mix(rng, y, 0.4) }) });
  const obs = future.observations.map((o, i) => { const ts = T + MIN + i * 5 * MIN; return { observationId: `p-${i}`, symbol: 'BTC', ts, score: o.features.SIG, labelEndTs: ts + HOUR, outcome: future.outcomes[i].value }; });
  for (const o of obs) { const r = captureProspectiveObservation(reg, { experimentId: id, observation: { observationId: o.observationId, symbol: o.symbol, ts: o.ts, score: o.score, labelEndTs: o.labelEndTs }, ts: o.ts + MIN }); assert.equal(r.error, null, JSON.stringify(r.error)); reg = r.registry; }
  const last = obs[obs.length - 1];
  assert.equal(captureProspectiveObservation(reg, { experimentId: id, observation: { observationId: 'p-0', symbol: 'BTC', ts: last.ts, score: 1, labelEndTs: last.ts + HOUR }, ts: last.ts + MIN }).error.reason, 'DUPLICATE_OBSERVATION_ID');
  assert.equal(captureProspectiveObservation(reg, { experimentId: id, observation: { observationId: 'p-bad', symbol: 'BTC', ts: last.ts, score: 1, labelEndTs: last.ts + 2 * HOUR }, ts: last.ts + MIN }).error.reason, 'LABEL_HORIZON_MISMATCH');
  assert.equal(captureProspectiveObservation(reg, { experimentId: id, observation: { observationId: 'p-bad', symbol: 'DOGE', ts: last.ts, score: 1, labelEndTs: last.ts + HOUR }, ts: last.ts + MIN }).error.reason, 'SYMBOL_OUTSIDE_SCOPE');
  // outcomes mature only after their own hour
  const firstBatchTs = obs[9].labelEndTs + MIN;
  assert.equal(recordProspectiveOutcome(reg, { experimentId: id, observationId: 'p-0', outcome: obs[0].outcome, outcomeKnownAtTs: obs[0].labelEndTs - 1, ts: firstBatchTs }).error.reason, 'OUTCOME_KNOWN_BEFORE_HORIZON_END');
  for (const o of obs.slice(0, 10)) { const r = recordProspectiveOutcome(reg, { experimentId: id, observationId: o.observationId, outcome: o.outcome, outcomeKnownAtTs: o.labelEndTs, ts: firstBatchTs }); assert.equal(r.error, null, JSON.stringify(r.error)); reg = r.registry; }
  const prog = prospectiveProgress(reg, id);
  assert.equal(prog.formal.status, 'TERMINAL_SAMPLE_NOT_REACHED'); assert.equal(prog.interim.banner, INTERIM_BANNER); assert.equal(prog.counted, 20, 'the first twenty CAPTURED are the sample'); assert.equal(prog.withOutcome, 10, 'half of them are still pending'); assert.equal(prog.pendingObservationIds.length, 10); assert.equal(prog.canAffectTrading, false);
  assert.equal(evaluateProspectiveTerminal(reg, { experimentId: id, ts: firstBatchTs + MIN }).error.reason, 'TERMINAL_SAMPLE_NOT_REACHED');
  // the remaining outcomes mature later, on the same forward-running clock
  const endTs = obs[obs.length - 1].labelEndTs + MIN;
  for (const o of obs.slice(10)) { const r = recordProspectiveOutcome(reg, { experimentId: id, observationId: o.observationId, outcome: o.outcome, outcomeKnownAtTs: o.labelEndTs, ts: endTs }); assert.equal(r.error, null, JSON.stringify(r.error)); reg = r.registry; }
  assert.equal(prospectiveProgress(reg, id).formal.status, 'TERMINAL_SAMPLE_REACHED'); assert.equal(prospectiveProgress(reg, id).captured, 21);
  const done = evaluateProspectiveTerminal(reg, { experimentId: id, ts: endTs + MIN }); assert.equal(done.error, null); reg = done.registry;
  assert.ok(['PROSPECTIVE_SUPPORTED', 'PROSPECTIVE_NOT_SUPPORTED'].includes(done.report.verdict.verdict));
  assert.equal(done.report.terminal.counted, 20, 'exactly the sealed terminal count, in capture order');
  assert.equal(done.report.canAffectExecution, false); assert.deepEqual(done.report.anytimeValid, ANYTIME_VALID); assert.ok(done.report.verdict.reasons.includes('TERMINAL_SAMPLE_REACHED'));
  assert.equal(experimentOf(reg, id).status, 'PROSPECTIVE_EVALUATED'); assert.equal(prospectiveProgress(reg, id).interim, null);
  assert.equal(evaluateProspectiveTerminal(reg, { experimentId: id, ts: endTs + 2 * MIN }).error.reason, 'STATUS_TRANSITION_REFUSED', 'one formal look');
  assert.equal(captureProspectiveObservation(reg, { experimentId: id, observation: { observationId: 'p-late', symbol: 'BTC', ts: endTs + 2 * MIN, score: 1, labelEndTs: endTs + 2 * MIN + HOUR }, ts: endTs + 3 * MIN }).error.reason, 'STATUS_TRANSITION_REFUSED');
  noForbidden(done.report);
});

test('RESOURCE BOUNDS + ABSENCES: iteration counts over the named limits are refused at the manifest; an impractical CPCV is UNSCORABLE; too few rows is INSUFFICIENT_DATA; masked and censored rows are counted as distinct absences and never scored as zero', () => {
  const data = realEffectData('bounds');
  let r = refereeEvaluate(bundleFor({ data, manifestOver: { controls: { blockLengthRule: 'MAX_OVERLAP_PLUS_ONE', blockLengthRows: null, shiftCount: 30, permutationIterations: LIMITS.maxResampleIterations + 1, bootstrapIterations: 10, nullFeatureTrials: 10, symbolPlacebo: false, horizonProfile: false } } }).bundle); assert.equal(r.verdict.verdict, 'INVALID_INPUT'); assert.deepEqual(r.verdict.reasons, ['RESOURCE_LIMIT_EXCEEDED']);
  r = refereeEvaluate(bundleFor({ data, manifestOver: { split: { method: 'CPCV', groups: 40, testGroups: 20, embargoMs: HOUR, purge: true, minTestObservations: 20, cscvGroups: 6, holdout: null } } }).bundle); assert.equal(r.verdict.verdict, 'UNSCORABLE'); assert.deepEqual(r.verdict.reasons, ['CPCV_NOT_PRACTICAL']); assert.equal(r.splits.design.combinations, 137846528820);
  const tiny = synth({ seed: 'tiny', steps: 4, features: (rng, y) => ({ SIG: mix(rng, y, 0.4) }) }); r = refereeEvaluate(bundleFor({ data: tiny }).bundle); assert.equal(r.verdict.verdict, 'INSUFFICIENT_DATA'); assert.deepEqual(r.verdict.reasons, ['TOO_FEW_OBSERVATIONS']);
  const masked = realEffectData('masked'); for (let i = 0; i < masked.outcomes.length; i += 1) { if (i % 10 === 0) { masked.outcomes[i].state = 'MASKED'; masked.outcomes[i].value = null; masked.outcomes[i].outcomeKnownAtTs = masked.dataset.asOfTs + HOUR; } else if (i % 10 === 1) { masked.outcomes[i].state = 'CENSORED'; masked.outcomes[i].value = null; } }
  r = refereeEvaluate(bundleFor({ data: masked }).bundle); assert.equal(r.splits.census.masked, 120); assert.equal(r.splits.census.censored, 120); assert.equal(r.splits.census.known, 960); assert.equal(r.primaryResult.context.rows, r.splits.census.known, 'only KNOWN rows are scored'); assert.equal(r.primaryResult.absences.census.masked, 120);
  const cp = refereeEvaluate(bundleFor({ data, manifestOver: { split: { method: 'CPCV', groups: 6, testGroups: 2, embargoMs: HOUR, purge: true, minTestObservations: 20, cscvGroups: 6, holdout: null } } }).bundle); assert.equal(cp.splits.design.pathCount, 5); assert.equal(cp.primaryResult.paths.length, 5); assert.ok(cp.overfitting.psr.perPath.length === 5);
  const lead = synth({ seed: 'lead', steps: 60, symbols: ['BTC'], features: (rng) => ({ DET: rng.normal() }) }); for (let i = 0; i < lead.outcomes.length; i += 1) { const o = lead.outcomes[i]; const obs = lead.observations[i]; if (i % 3 === 0) { o.state = 'CENSORED'; o.value = null; o.eventTs = null; } else { o.eventTs = obs.ts + 20 * MIN; o.value = o.eventTs; } o.horizonValues = null; }
  const lr = refereeEvaluate(bundleFor({ data: lead, manifestOver: { evaluationType: 'LEAD_TIME', features: [feature('DET')], signal: { feature: 'DET', condition: condition('GT', 0) }, primaryMetric: 'DETECTION_RATE', secondaryMetrics: ['MEDIAN_LEAD_MS'], label: { definition: 'EVENT_WITHIN_HORIZON', horizonMs: HOUR, knownAtRule: 'HORIZON_END', unit: 'TIMESTAMP_MS' }, stability: stabilityWith([]) } }).bundle);
  assert.notEqual(lr.verdict.verdict, 'INVALID_INPUT'); assert.notEqual(lr.verdict.verdict, 'PIT_VIOLATION'); if (lr.primaryResult) { assert.equal(lr.primaryResult.metric, 'DETECTION_RATE'); assert.ok(lr.primaryResult.context.falseAlarmRate !== undefined); }
  assert.equal(PROVENANCE.origin, 'FIXTURE'); assert.equal(CODE_IDENTITY.law, 'PRODUCED_BY_COMMITTED_SOURCE'); assert.ok(existsSync('research/referee/evaluate.js')); assert.ok(typeof buildBundle === 'function'); assert.ok(T0 > 0);
});
