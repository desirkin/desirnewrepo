// RESEARCH REFEREE — THE EVALUATION. One sealed bundle in, one sealed deterministic report out. The stages run in
// the hard-failure precedence the doctrine fixes and STOP at the first failed stage:
//   1 schema / manifest / registry  -> INVALID_INPUT
//   2 the point-in-time wall         -> PIT_VIOLATION
//   3 the leakage auditor            -> LEAKAGE_DETECTED
//   4 too few (effective) rows       -> INSUFFICIENT_DATA
//   5 no valid design / OOS path     -> UNSCORABLE
//   6 no effect / placebo-equivalent -> REJECTED
//   7 multiple-testing evidence      -> REJECTED or SUSPECT_MULTIPLE_TESTING
//   8 fragility                      -> SUSPECT_FRAGILITY
//   9 otherwise                      -> HISTORICALLY_INTERESTING (worth continued research; nothing more)
// Hard validity failures are referee law; the research thresholds (alpha, minimum DSR, maximum PBO, direction
// consistency, concentration, OOS path agreement) are the experiment's OWN sealed criteria — the referee invents no
// financial threshold and never lowers a declared one. Nothing here has authority; the report says so on every page.
import { isFiniteNum, canonicalDigest, deepFreeze, round6, createRng, AUTHORITY_STAMP, REFEREE_VERSION, REPORT_VERSION, LIMITS, STRUCTURAL_MIN, METRICS, carriesForbiddenToken } from './contracts.js';
import { validateBundle, unifiedRows, pitAudit, leakageAudit } from './pitAudit.js';
import { buildDesign, buildCscv, blockLengthRows } from './splits.js';
import { scorableRows, absenceCensus, scoreRows, fitCondition, metricValue, metricContext, baselineValue, metricParameterError, seriesOf } from './metrics.js';
import { describe, averageUniqueness, probabilisticSharpe, deflatedSharpe, effectiveTrialCount, variance, blockBootstrap, signedEffect, mean, median, quantile } from './statistics.js';
import { runNegativeControls } from './negativeControls.js';
import { runStability } from './stability.js';

// effective observations = sum over symbols of the average-uniqueness count of that symbol's label intervals (overlapping
// labels of ONE series are the dependence this measures; cross-symbol dependence is the block null's and the symbol placebo's job)
export function effectiveObservationsOf(rows) {
  const bySymbol = new Map(); for (const r of rows) { if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []); bySymbol.get(r.symbol).push({ start: r.ts, end: Math.max(r.ts, r.labelEndTs) }); }
  let effective = 0; const perSymbol = {}; for (const [s, iv] of bySymbol) { const u = averageUniqueness(iv); effective += u.effective; perSymbol[s] = u.effective; }
  return { n: rows.length, effective: round6(effective), meanUniqueness: rows.length ? round6(effective / rows.length) : null, perSymbol, law: 'average uniqueness of overlapping label intervals within each symbol, summed' };
}
const VERDICT_MEANING = deepFreeze({
  INVALID_INPUT: 'the bundle failed its closed schema, checksum or registry law before any clock or statistic was examined',
  PIT_VIOLATION: 'at least one row uses information that was not known at its decision, or an outcome that could not yet be known',
  LEAKAGE_DETECTED: 'the experiment design lets outcome, full-sample, survivor or holdout information into the features or the evaluation',
  INSUFFICIENT_DATA: 'too few independent / effective observations to score without inventing precision',
  UNSCORABLE: 'the declared design cannot produce a valid out-of-sample path within the referee limits, or the metric is undefined on this data',
  REJECTED: 'the out-of-sample effect is absent, points the wrong way, or is indistinguishable from a block null / placebo, or multiple testing dominates it',
  SUSPECT_MULTIPLE_TESTING: 'the effect survives its own null but not the trial burden of its family under the declared deflation / overfitting criteria',
  SUSPECT_FRAGILITY: 'the effect collapses under small predeclared perturbations, one block or symbol carries it, or it lives at a knife-edge parameter',
  HISTORICALLY_INTERESTING: 'worth continued research; NOT robust, NOT production approval, NOT permission to change any trading state; a prospective test is still required',
});
const explain = (verdict, reasons) => `${verdict}: ${VERDICT_MEANING[verdict]}. Reason codes: ${reasons.join(', ')}.`;

function baseReport(b, ids) {
  return { reportVersion: REPORT_VERSION, refereeVersion: REFEREE_VERSION, identity: { experimentId: ids?.experimentId ?? null, experimentFamilyId: ids?.experimentFamilyId ?? null, manifestDigest: b?.checksums?.experiment ?? null, datasetDigest: b?.dataset?.manifestDigest ?? null, featureDigest: ids?.featureDigest ?? null, registryHeadDigest: b?.registrySnapshot?.headDigest ?? null, gitCommit: b?.codeIdentity?.gitCommit ?? null, sourceTreeSha256: b?.codeIdentity?.sourceTreeSha256 ?? null, codeLaw: b?.codeIdentity?.law ?? null, provenance: b?.provenance ?? null, seed: b?.seed ?? null, requestedAtTs: b?.evaluation?.requestedAtTs ?? null }, authority: { ...AUTHORITY_STAMP, law: 'a referee report can reject, question or mark an experiment as interesting; it can never say anything a production path may act on' }, pit: null, leakage: null, trialHistory: null, splits: null, primaryResult: null, overfitting: null, stability: null, prospective: null, verdict: null };
}
function seal(report, verdict, stage, reasons, warnings = []) {
  if (carriesForbiddenToken(verdict) || reasons.some(carriesForbiddenToken)) throw new Error('forbidden vocabulary');
  const body = { ...report, verdict: { verdict, stage, reasons, warnings, explanation: explain(verdict, reasons), meaning: VERDICT_MEANING[verdict] } };
  const text = JSON.stringify(body); if (text.length > LIMITS.maxReportBytes) return seal({ ...baseReport(null, null), identity: report.identity }, 'UNSCORABLE', 'REPORT', ['RESOURCE_LIMIT_EXCEEDED'], ['report exceeded maxReportBytes']);
  return deepFreeze({ ...body, reportDigest: canonicalDigest(body) });
}

export function refereeEvaluate(bundle) {
  // 1. schema
  const v = validateBundle(bundle);
  if (v.error) return seal({ ...baseReport(bundle, null), pit: { findings: [v.error] } }, 'INVALID_INPUT', 'INPUT', [v.error.reason]);
  const b = bundle; const m = b.experiment; const ex = v.experimentRecord; const trials = v.trials;
  const ids = { experimentId: v.experimentId, experimentFamilyId: ex.experimentFamilyId, featureDigest: ex.featureDigest };
  const report = baseReport(b, ids);
  // 2. the point-in-time wall
  const rows = unifiedRows(b); const pit = pitAudit(b, rows); report.pit = pit;
  if (!pit.pass) return seal(report, 'PIT_VIOLATION', 'PIT', [...new Set(pit.findings.map((f) => f.reason))]);
  // 3. leakage
  const leak = leakageAudit(b, rows, trials); report.leakage = leak;
  if (!leak.pass) return seal(report, 'LEAKAGE_DETECTED', 'LEAKAGE', [...new Set(leak.findings.map((f) => f.reason))]);
  report.trialHistory = { experimentFamilyId: trials.experimentFamilyId, rawTrialCount: trials.rawTrialCount, memberCount: trials.memberCount, members: trials.members, recordedSharpeCount: trials.recordedSharpes.length, holdoutWindows: trials.holdoutWindows, hypothesisOrigin: m.hypothesisOrigin, parentExperimentId: m.parentExperimentId, law: 'every registered family member counts at least once, every candidate counts, abandoned and failed trials keep counting; the registry, not the experiment, decides' };
  // 4. data sufficiency
  const scorable = scorableRows(rows, m.evaluationType); const census = absenceCensus(rows);
  const uniq = effectiveObservationsOf(scorable);
  report.splits = { census, effectiveObservations: uniq, design: null };
  if (census.known === 0) return seal(report, 'INSUFFICIENT_DATA', 'DATA', ['NO_KNOWN_OUTCOMES']);
  if (scorable.length < 2 * STRUCTURAL_MIN.rowsPerTest) return seal(report, 'INSUFFICIENT_DATA', 'DATA', ['TOO_FEW_OBSERVATIONS']);
  if (uniq.effective < STRUCTURAL_MIN.effectiveRows) return seal(report, 'INSUFFICIENT_DATA', 'DATA', ['TOO_FEW_EFFECTIVE_OBSERVATIONS']);
  // 5. scorability + design
  const pe = metricParameterError(m.primaryMetric, m.parameters); if (pe) return seal(report, 'UNSCORABLE', 'DESIGN', ['METRIC_UNDEFINED'], [pe]);
  const primarySignal = m.candidates.length ? m.candidates.find((c) => c.candidateId === m.primaryCandidateId).signal : m.signal;
  const distinct = new Set(scorable.map((r) => r.features[primarySignal.feature]).filter((x) => x !== null)); if (distinct.size < 2) return seal(report, 'UNSCORABLE', 'DESIGN', ['SCORE_CONSTANT']);
  if (['AUROC', 'PR_AUC', 'PRECISION_AT_K', 'LIFT_AT_K'].includes(m.primaryMetric)) { const pos = scorable.filter((r) => r.outcome > 0).length; if (pos === 0 || pos === scorable.length) return seal(report, 'UNSCORABLE', 'DESIGN', ['SINGLE_CLASS_OUTCOME']); }
  // the design runs over the scorable rows re-indexed contiguously
  const srows = scorable.map((r, i) => ({ ...r, idx: i }));
  const design = buildDesign(srows, m.split);
  if (!design.ok) { report.splits.design = design; return seal(report, 'UNSCORABLE', 'DESIGN', [design.reason]); }
  report.splits.design = { method: design.method, groups: design.groups, testGroups: design.testGroups, combinations: design.combinations, folds: design.folds.map((f) => ({ fold: f.fold, testGroups: f.testGroups, test: f.test.length, train: f.train.length, purged: f.purged, embargoed: f.embargoed, spans: f.spans, trainRange: f.trainRange, skipped: f.skipped })), groupBounds: design.groupBounds, validFolds: design.validFolds, skippedFolds: design.skippedFolds, pathCount: design.pathCount, validPaths: design.validPaths, purgedRows: design.purgedTotal, embargoedRows: design.embargoedTotal, embargoMs: m.split.embargoMs, purge: m.split.purge, minTestRows: design.minTest, candidateCount: Math.max(1, m.candidates.length) };
  if (design.validPaths === 0) return seal(report, design.folds.every((f) => f.skipped === 'TOO_FEW_TEST_OBSERVATIONS' || f.skipped === 'TOO_FEW_OBSERVATIONS') ? 'INSUFFICIENT_DATA' : 'UNSCORABLE', 'DESIGN', [design.folds.every((f) => f.skipped) ? 'TOO_FEW_TEST_OBSERVATIONS' : 'NO_VALID_OOS_PATH']);
  // 6. the primary result over every complete out-of-sample path
  const costPct = m.economics ? m.economics.costPerPositionPct : 0; const parameters = m.parameters; const name = m.primaryMetric; const direction = m.direction;
  const foldScored = new Map(); // fold -> scored test rows for the primary signal
  const scoreFold = (signal, f, filter = null) => { const test = filter ? f.test.filter(filter) : f.test; return scoreRows(srows, test, f.train, signal, { costPct }); };
  for (const f of design.folds) if (!f.skipped) foldScored.set(f.fold, scoreFold(primarySignal, f));
  const pathScored = (signal, filter = null) => design.paths.filter((p) => p.complete).map((p) => { const byFold = new Map(); for (const { fold } of p.rows) if (!byFold.has(fold)) byFold.set(fold, signal === primarySignal && !filter ? foldScored.get(fold) : scoreFold(signal, design.folds[fold], filter)); const inPath = new Set(p.rows.map((r) => r.idx)); const scored = []; for (const s of byFold.values()) for (const x of s.scored) if (inPath.has(x.idx)) scored.push(x); scored.sort((a, c) => a.idx - c.idx); return { path: p.path, scored, fits: [...byFold.values()].map((s) => s.fit) }; });
  const paths = pathScored(primarySignal);
  const pathValues = paths.map((p) => ({ path: p.path, value: metricValue(name, p.scored, srows, { parameters }), rows: p.scored.length }));
  const usable = pathValues.filter((p) => p.value !== null && p.rows >= design.minTest);
  if (!usable.length) return seal(report, 'UNSCORABLE', 'SCORING', ['METRIC_UNDEFINED']);
  const values = usable.map((p) => p.value); const primaryValue = mean(values); const signedPrimary = signedEffect(primaryValue, direction);
  const pathsPositive = usable.filter((p) => signedEffect(p.value, direction) > 0).length / usable.length;
  const rep = paths.find((p) => p.path === usable[0].path); const oos = rep.scored; const oosIdx = oos.map((s) => s.idx);
  const inSample = design.folds.filter((f) => !f.skipped).map((f) => { const s = scoreRows(srows, f.train, f.train, primarySignal, { costPct }); return metricValue(name, s.scored, srows, { parameters }); }).filter(isFiniteNum);
  const controlFit = (() => { const fit = fitCondition(srows, oosIdx, primarySignal); return { ...fit, quantile: primarySignal.condition.quantile }; })();
  const { blockLen, rule: blockRule, maxOverlapRows } = blockLengthRows(srows, m.controls);
  const rng = createRng(`${b.seed}/${v.experimentId}`);
  const ci = blockBootstrap(oos, { blockLen, iterations: m.controls.bootstrapIterations, rng: rng.child('bootstrap'), statistic: (sample) => metricValue(name, sample, srows, { parameters }) });
  const baseline = baselineValue(m.baseline.kind, name, oos, srows, parameters);
  const netValue = m.economics ? metricValue(name, oos, srows, { parameters, net: true }) : null;
  const seriesMetric = METRICS[name].series; const series = seriesMetric ? seriesOf(oos) : null;
  report.primaryResult = { metric: name, scale: METRICS[name].scale, direction, value: round6(primaryValue), signed: round6(signedPrimary), paths: usable.map((p) => ({ path: p.path, value: round6(p.value), rows: p.rows })), pathAgreement: { positive: round6(pathsPositive), required: m.criteria.minOosPathsPositive }, representativePath: rep.path, inSample: inSample.length ? { mean: round6(mean(inSample)), folds: inSample.length, degradation: round6(mean(inSample) - primaryValue) } : null, uncertainty: ci, baseline: { kind: m.baseline.kind, value: baseline === null ? null : round6(baseline), uplift: baseline === null ? null : round6(primaryValue - baseline) }, context: metricContext(oos, srows, m.evaluationType), economics: m.economics ? { costPerPositionPct: m.economics.costPerPositionPct, netValue: netValue === null ? null : round6(netValue), basis: 'cost charged once per positioned observation' } : null, series: series ? describe(series, { sequential: true }) : null, fit: { feature: primarySignal.feature, candidateId: m.candidates.length ? m.primaryCandidateId : null, op: controlFit.op, threshold: controlFit.threshold === null ? null : round6(controlFit.threshold), fitted: controlFit.fitted, law: 'thresholds declared as quantiles are fitted on training rows only; the control fit is fitted on the path scores themselves so every permutation sees the same rule' }, absences: { law: 'no observation / no known outcome / masked at as-of / censored are four different facts', census } };
  // 7. overfitting: PSR / DSR per path, the trial family, PBO over the candidate set
  const candidateSignals = m.candidates.length ? m.candidates : [{ candidateId: 'PRIMARY', signal: m.signal }];
  const candidateSeries = candidateSignals.map((c) => { const sc = c.signal === primarySignal ? oos : pathScored(c.signal)[0]?.scored ?? []; return { candidateId: c.candidateId, series: seriesOf(sc) }; });
  const sharpes = candidateSeries.map((c) => { const xs = c.series; const d = describe(xs); return { candidateId: c.candidateId, sharpe: d.sharpe, n: d.n }; });
  const insideSeries = candidateSeries.filter((c) => c.series.length >= STRUCTURAL_MIN.seriesForSharpe).map((c) => c.series);
  const eff = effectiveTrialCount({ rawTrialCount: trials.rawTrialCount, insideSeries });
  const allSharpes = [...trials.recordedSharpes, ...sharpes.map((s) => s.sharpe).filter(isFiniteNum)];
  const trialVariance = allSharpes.length >= 2 ? variance(allSharpes) : null;
  const perPath = seriesMetric ? usable.map((p) => { const ps = paths.find((q) => q.path === p.path); const xs = seriesOf(ps.scored); const d = describe(xs); const nEff = Math.floor(effectiveObservationsOf(ps.scored.map((s) => srows[s.idx])).effective); const psr = probabilisticSharpe({ sharpe: d.sharpe, benchmark: 0, n: nEff, skewness: d.skewness, kurtosis: d.kurtosis }); const dsr = deflatedSharpe({ sharpe: d.sharpe, n: nEff, skewness: d.skewness, kurtosis: d.kurtosis, effectiveTrials: eff.effectiveTrialCount, trialVariance }); return { path: p.path, rawRows: d.n, effectiveRows: nEff, psr, dsr }; }) : [];
  const psrVals = perPath.filter((p) => p.psr.applicable).map((p) => p.psr.psr); const dsrVals = perPath.filter((p) => p.dsr.applicable).map((p) => p.dsr.dsr);
  const psr = seriesMetric ? { applicable: psrVals.length > 0, benchmarkSharpe: 0, median: psrVals.length ? round6(median(psrVals)) : null, min: psrVals.length ? round6(Math.min(...psrVals)) : null, perPath: perPath.map((p) => ({ path: p.path, rawRows: p.rawRows, effectiveRows: p.effectiveRows, ...p.psr })), sampleCountLaw: 'n = the path effective observations (average uniqueness), never the raw row count', reason: psrVals.length ? null : 'PSR_NOT_APPLICABLE' } : { applicable: false, reason: 'PSR_NOT_APPLICABLE', note: 'the primary metric has no return series' };
  const dsr = seriesMetric ? { applicable: dsrVals.length > 0, median: dsrVals.length ? round6(median(dsrVals)) : null, min: dsrVals.length ? round6(Math.min(...dsrVals)) : null, benchmarkSharpe: perPath.length ? perPath[0].dsr.benchmarkSharpe : null, trials: eff, trialVariance: trialVariance === null ? null : round6(trialVariance), trialSharpes: { recordedInFamily: trials.recordedSharpes.length, thisBundle: sharpes }, perPath: perPath.map((p) => ({ path: p.path, rawRows: p.rawRows, effectiveRows: p.effectiveRows, ...p.dsr })), reason: dsrVals.length ? null : perPath.length && perPath[0].dsr.reason ? perPath[0].dsr.reason : 'DSR_NOT_APPLICABLE', law: 'the registry family fixes the raw trial count; the effective count is bounded [1, raw]; an unknown trial variance with more than one trial is never assumed favourable' } : { applicable: false, reason: 'DSR_NOT_APPLICABLE', trials: eff, note: 'the primary metric has no return series' };
  let pbo = { applicable: false, reason: candidateSignals.length < 2 ? 'SINGLE_CANDIDATE' : 'PBO_NOT_APPLICABLE', candidates: candidateSignals.length };
  if (candidateSignals.length >= 2) {
    const cscv = buildCscv(srows, m.split);
    if (!cscv.ok) pbo = { applicable: false, reason: cscv.reason, candidates: candidateSignals.length, combinations: cscv.combinations };
    else {
      const lambdas = []; const omegas = []; const selections = []; let losses = 0; let degradation = [];
      for (const set of cscv.sets) {
        if (set.skipped) continue;
        const isVals = candidateSignals.map((c) => signedEffect(metricValue(name, scoreRows(srows, set.inSample, set.inSample, c.signal, { costPct }).scored, srows, { parameters }), direction));
        if (isVals.some((x) => x === null)) continue;
        let best = 0; for (let i = 1; i < isVals.length; i += 1) if (isVals[i] > isVals[best]) best = i; // IS ONLY decides the selection
        const oosVals = candidateSignals.map((c) => signedEffect(metricValue(name, scoreRows(srows, set.outOfSample, set.inSample, c.signal, { costPct }).scored, srows, { parameters }), direction));
        if (oosVals.some((x) => x === null)) continue;
        const rank = oosVals.filter((x) => x < oosVals[best]).length + 1; const omega = rank / (oosVals.length + 1); const lambda = Math.log(omega / (1 - omega));
        omegas.push(round6(omega)); lambdas.push(round6(lambda)); selections.push(candidateSignals[best].candidateId); if (oosVals[best] <= 0) losses += 1; degradation.push(oosVals[best] - isVals[best]);
      }
      pbo = lambdas.length ? { applicable: true, reason: null, candidates: candidateSignals.length, combinations: cscv.combinations, evaluatedCombinations: lambdas.length, groups: cscv.groups, pbo: round6(lambdas.filter((l) => l < 0).length / lambdas.length), lambda: describe(lambdas), omega: describe(omegas), probabilityOfLossOos: round6(losses / lambdas.length), performanceDegradation: describe(degradation), selectedCandidates: [...new Set(selections)].slice(0, 50), law: 'the in-sample half alone selects the candidate; the out-of-sample half only ranks it; PBO = share of combinations whose in-sample winner ranks in the losing half out of sample' } : { applicable: false, reason: 'PBO_NOT_APPLICABLE', candidates: candidateSignals.length, combinations: cscv.combinations };
    }
  }
  const controls = runNegativeControls({ scoredOos: oos, rows: srows, fit: controlFit, name, parameters, observed: metricValue(name, oos, srows, { parameters }), direction, controls: m.controls, blockLen, rng, evaluationType: m.evaluationType, horizonMs: m.label.horizonMs });
  report.overfitting = { psr, dsr, pbo, negativeControls: { ...controls, blockLengthRule: blockRule, maxOverlapRows: maxOverlapRows ?? null, seed: rng.seed, alpha: m.criteria.nullAlpha, law: 'a candidate that performs as well under a meaningless placebo is SUSPECT / REJECTED, never promising' } };
  // 8. stability
  const neighbors = m.stability.neighbors.map((nb) => ({ ...nb, signal: m.candidates.find((c) => c.candidateId === nb.candidateId).signal }));
  const scoreSignal = (signal) => { const ps = pathScored(signal); const vals = ps.filter((p) => p.scored.length >= design.minTest).map((p) => metricValue(name, p.scored, srows, { parameters })).filter(isFiniteNum); return vals.length ? mean(vals) : null; };
  const scoreSubset = (filter) => { const ps = pathScored(primarySignal, filter); const vals = ps.filter((p) => p.scored.length >= design.minTest).map((p) => metricValue(name, p.scored, srows, { parameters })).filter(isFiniteNum); return vals.length ? mean(vals) : null; };
  const nullTest = (signal) => { const ps = pathScored(signal); const p0 = ps.find((p) => p.path === rep.path); if (!p0 || p0.scored.length < design.minTest) return null; const fit = { ...fitCondition(srows, p0.scored.map((s) => s.idx), signal), quantile: signal.condition.quantile }; const obs = metricValue(name, p0.scored, srows, { parameters }); if (obs === null) return null; const c = runNegativeControls({ scoredOos: p0.scored, rows: srows, fit, name, parameters, observed: obs, direction, controls: { ...m.controls, shiftCount: 0, nullFeatureTrials: 0, symbolPlacebo: false, horizonProfile: false }, blockLen, rng: rng.child(`neighbor/${signal.feature}/${canonicalDigest(signal)}`), evaluationType: m.evaluationType, horizonMs: m.label.horizonMs }); return c.permutation.applicable ? c.permutation.p : null; };
  const nullSubset = (filter) => { const ps = pathScored(primarySignal, filter); const p0 = ps.find((p) => p.path === rep.path); if (!p0 || p0.scored.length < design.minTest) return null; const obs = metricValue(name, p0.scored, srows, { parameters }); if (obs === null) return null; const c = runNegativeControls({ scoredOos: p0.scored, rows: srows, fit: controlFit, name, parameters, observed: obs, direction, controls: { ...m.controls, shiftCount: 0, nullFeatureTrials: 0, symbolPlacebo: false, horizonProfile: false }, blockLen, rng: rng.child(`subset/${p0.scored.length}/${p0.scored[0].idx}`), evaluationType: m.evaluationType, horizonMs: m.label.horizonMs }); return c.permutation.applicable ? c.permutation.p : null; };
  const stability = runStability({ rows: srows, oosIdx, primaryValue, direction, stability: m.stability, criteria: m.criteria, neighbors, scoreSignal, scoreSubset, nullTest, nullSubset });
  report.stability = stability;
  report.prospective = { status: m.prospective ? 'DESIGN_DECLARED' : 'NOT_DECLARED', design: m.prospective, law: 'a prospective shadow may be opened from a HISTORICALLY_INTERESTING result only; formal significance is evaluated once, at the sealed terminal count; interim views are descriptive', anytimeValid: { status: 'NOT_IMPLEMENTED' } };
  // 9. the verdict
  const alpha = m.criteria.nullAlpha; const reasons = []; const warnings = [];
  if (m.hypothesisOrigin === 'AFTER_INSPECTING_OUTCOMES') warnings.push('POST_HOC_HYPOTHESIS');
  if (stability.ok && stability.flags.includes('NEIGHBORS_NOT_DECLARED')) warnings.push('NEIGHBORS_NOT_DECLARED');
  if (!stability.ok) return seal(report, 'UNSCORABLE', 'STABILITY', [stability.reason], warnings);
  if (direction !== 'UNDECLARED' && signedPrimary <= 0) reasons.push('WRONG_DIRECTION'); else if (direction === 'UNDECLARED' && primaryValue === 0) reasons.push('NO_OOS_EFFECT');
  if (pathsPositive < m.criteria.minOosPathsPositive) reasons.push('NO_OOS_EFFECT');
  if (!controls.permutation.applicable) reasons.push('TOO_FEW_BLOCKS_FOR_NULL'); else if (controls.permutation.p > alpha) reasons.push('BLOCK_NULL_NOT_REJECTED');
  if (controls.timeShift.applicable && controls.timeShift.p > alpha) reasons.push('PLACEBO_EQUIVALENT');
  if (controls.nullFeature.applicable && controls.nullFeature.p > alpha) reasons.push('NULL_FEATURE_EQUIVALENT');
  if (controls.symbolPlacebo.applicable && controls.symbolPlacebo.p > alpha) reasons.push('SYMBOL_PLACEBO_EQUIVALENT');
  if (reasons.includes('TOO_FEW_BLOCKS_FOR_NULL')) return seal(report, 'INSUFFICIENT_DATA', 'NULL', [...new Set(reasons)], warnings);
  if (reasons.length) return seal(report, 'REJECTED', 'EFFECT', [...new Set(reasons)], warnings);
  const mt = []; const mtReject = [];
  if (dsr.applicable) { if (dsr.median <= 0.5) mtReject.push('MULTIPLE_TESTING_DOMINATES'); else if (dsr.median < m.criteria.minDsr) mt.push('DSR_BELOW_DECLARED'); }
  else if (trials.rawTrialCount > 1 && seriesMetric) mt.push('TRIAL_BURDEN_UNPENALIZED');
  if (pbo.applicable) { if (pbo.pbo >= 0.5) mtReject.push('OVERFIT_SELECTION_DOMINATES'); else if (pbo.pbo > m.criteria.maxPbo) mt.push('PBO_ABOVE_DECLARED'); }
  if (mtReject.length) return seal(report, 'REJECTED', 'MULTIPLE_TESTING', [...mtReject, ...mt], warnings);
  if (mt.length) return seal(report, 'SUSPECT_MULTIPLE_TESTING', 'MULTIPLE_TESTING', mt, warnings);
  const fr = stability.flags.filter((f) => f !== 'NEIGHBORS_NOT_DECLARED'); if (controls.horizonProfile.applicable && controls.horizonProfile.coherent === false) fr.push('HORIZON_PROFILE_INCOHERENT');
  if (fr.length) return seal(report, 'SUSPECT_FRAGILITY', 'STABILITY', fr, warnings);
  return seal(report, 'HISTORICALLY_INTERESTING', 'COMPLETE', ['SURVIVED_HISTORICAL_TESTS'], warnings);
}
// the sharpes a registry result records for this evaluation (the family's future trial-variance input)
export const resultSharpesOf = (report) => (report.overfitting?.dsr?.trialSharpes?.thisBundle ?? []).map((s) => s.sharpe).filter(isFiniteNum);
export { quantile };
