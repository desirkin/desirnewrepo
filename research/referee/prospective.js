// RESEARCH REFEREE — THE PROSPECTIVE SHADOW. Historical evidence is not enough. A candidate that survived the
// historical tests may be registered PROSPECTIVE_PENDING; the feature and condition OF THE CANDIDATE THAT WAS ACTUALLY
// EVALUATED (with any fitted threshold frozen to a number), the primary metric, horizon, universe rule, terminal sample
// count, alpha and the null SEED are SEALED before one prospective observation exists. Future observations are recorded
// DARK in the registry with zero trading authority. FORMAL significance is evaluated ONCE, at the pre-registered
// terminal sample count. Anything shown before that is DESCRIPTIVE and carries INTERIM — NOT A FORMAL CONFIRMATION.
//
// THE LIFECYCLE IS TWO APPEND-ONLY STAGES, because a prediction is only a prediction if the score existed before the
// outcome did:
//   1 CAPTURE  commits observationId, symbol, decision clock, score, position and the design binding while the outcome
//              is still unknown. It must be recorded at or after its own decision, after the design was sealed, and
//              BEFORE its label window closes — that last rule is the only prior-capture evidence this registry can
//              actually verify (CAPTURE_EVIDENCE_KINDS). A declared timestamp attached to a score supplied later proves
//              nothing about an external source's honesty, so a delayed import is refused rather than credited.
//   2 OUTCOME  a separate later record supplies exactly one outcome for that id. It carries nothing that could revise
//              the capture, and it cannot be recorded before the outcome could be known (>= label end, <= its own
//              recording clock).
// The counted sample is the first N CAPTURED observations, never the first N favourable or completed ones; a missing
// outcome keeps the formal evaluation pending, and out-of-order outcome arrival cannot reorder it. Every rule here is
// enforced identically by the registry's semantic replay, so a reload or a snapshot cannot smuggle past it.
import { isPlainObject, isTs, isFiniteNum, canonicalDigest, deepFreeze, exactKeys, isCoin, isId, finding, round6, createRng, AUTHORITY_STAMP, PROSPECTIVE_VERSION, REFEREE_VERSION, LIMITS, PROSPECTIVE_CAPTURE_INPUT_KEYS } from './contracts.js';
import { experimentOf, appendRecord } from './registry.js';
import { metricValue, positionOf } from './metrics.js';
import { blockPermutationNull, describe, signedEffect } from './statistics.js';

export const INTERIM_BANNER = 'INTERIM — NOT A FORMAL CONFIRMATION';
export const ANYTIME_VALID = deepFreeze({ status: 'NOT_IMPLEMENTED', note: 'v1 evaluates formal significance only at the sealed terminal sample count; a sequential method may be plugged into design.sequentialMethod later without changing experiment identity' });
export const CAPTURE_EVIDENCE = 'IN_REGISTRY_PRIOR_CAPTURE';

// the sealed design: everything the terminal test will use, frozen from the manifest and the historical report. The
// feature and condition come from the CANDIDATE THE REPORT ACTUALLY SCORED — never manifest.signal mixed with another
// candidate's threshold. The null seed is bound here, before any prospective outcome exists.
export function sealProspectiveDesign(manifest, historicalReport, { seed = null } = {}) {
  const fit = historicalReport.primaryResult.fit; const p = manifest.prospective;
  const feat = manifest.features.find((f) => f.name === fit.feature);
  if (!feat) return { error: finding('UNKNOWN_FEATURE_REFERENCE', 'the report names a feature the manifest does not declare') };
  const design = {
    prospectiveVersion: PROSPECTIVE_VERSION, refereeVersion: REFEREE_VERSION,
    feature: fit.feature, candidateId: fit.candidateId, featureDefinitionDigest: feat.definitionDigest, condition: { op: fit.op, threshold: fit.threshold },
    primaryMetric: manifest.primaryMetric, parameters: manifest.parameters, direction: manifest.direction, evaluationType: manifest.evaluationType,
    horizonMs: p.horizonMs, terminalObservations: p.terminalObservations, universeRule: p.universeRule, symbolScope: manifest.universe.symbolScope,
    nullAlpha: manifest.criteria.nullAlpha, blockLengthRows: historicalReport.overfitting.negativeControls.blockLen, permutationIterations: manifest.controls.permutationIterations,
    nullSeed: seed === null ? `sealed-${historicalReport.reportDigest.slice(0, 32)}` : seed,
    sequentialMethod: p.sequentialMethod, anytimeValid: ANYTIME_VALID, captureEvidenceRequired: CAPTURE_EVIDENCE, historicalReportDigest: historicalReport.reportDigest,
  };
  return { design: deepFreeze(design), designDigest: canonicalDigest(design), error: null };
}
export function openProspective(reg, { experimentId, historicalReport, ts, seed = null }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  if (ex.status !== 'EVALUATED') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status) };
  if (!ex.manifest.prospective) return { registry: reg, error: finding('SCHEMA', 'the manifest declares no prospective design') };
  if (seed !== null && (typeof seed !== 'string' || !seed.length || seed.length > 200)) return { registry: reg, error: finding('SCHEMA', 'seed') };
  const { reportDigest: claimed, ...body } = isPlainObject(historicalReport) ? historicalReport : {};
  if (!isPlainObject(historicalReport) || historicalReport.identity?.experimentId !== experimentId || claimed !== ex.result.payload.reportDigest || canonicalDigest(body) !== claimed) return { registry: reg, error: finding('CHECKSUM_MISMATCH', 'historical report') };
  if (historicalReport.verdict.verdict !== 'HISTORICALLY_INTERESTING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', 'only a HISTORICALLY_INTERESTING result may open a prospective shadow') };
  const sealed = sealProspectiveDesign(ex.manifest, historicalReport, { seed }); if (sealed.error) return { registry: reg, error: sealed.error };
  const r = appendRecord(reg, { kind: 'PROSPECTIVE_OPENED', ts, experimentId, payload: { design: sealed.design, designDigest: sealed.designDigest, historicalReportDigest: historicalReport.reportDigest, ...AUTHORITY_STAMP } });
  return { ...r, design: r.error ? null : sealed.design, designDigest: r.error ? null : sealed.designDigest };
}
const openedDesign = (ex) => (ex.prospective ? { design: ex.prospective.payload.design, designDigest: ex.prospective.payload.designDigest, openedAtTs: ex.prospective.ts } : null);

// STAGE 1 — the capture. Every clock rule is re-proved by the registry's replay; nothing here is the only guard.
export function captureProspectiveObservation(reg, { experimentId, observation, ts }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  const od = openedDesign(ex); if (!od) return { registry: reg, error: finding('PROSPECTIVE_NOT_OPENED') };
  if (ex.status !== 'PROSPECTIVE_PENDING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status) };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'recording clock') };
  const e = exactKeys(observation, PROSPECTIVE_CAPTURE_INPUT_KEYS); if (e) return { registry: reg, error: finding('SCHEMA', e) };
  const o = observation;
  if (!isId(o.observationId) || !isCoin(o.symbol) || !isTs(o.ts) || !isTs(o.labelEndTs) || !(o.score === null || isFiniteNum(o.score))) return { registry: reg, error: finding('SCHEMA', 'capture') };
  if (ex.prospectiveObservations.length >= LIMITS.maxProspectiveObservations) return { registry: reg, error: finding('REGISTRY_LIMIT_EXCEEDED') };
  const payload = { observationId: o.observationId, symbol: o.symbol, ts: o.ts, score: o.score, position: positionOf(o.score, { op: od.design.condition.op, threshold: od.design.condition.threshold }), labelEndTs: o.labelEndTs, captureEvidence: CAPTURE_EVIDENCE, designDigest: od.designDigest };
  return appendRecord(reg, { kind: 'PROSPECTIVE_OBSERVATION', ts, experimentId, payload });
}
// STAGE 2 — the one outcome for a captured observation. It can revise nothing: the record carries only these keys.
export function recordProspectiveOutcome(reg, { experimentId, observationId, outcome, outcomeKnownAtTs, ts }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  const od = openedDesign(ex); if (!od) return { registry: reg, error: finding('PROSPECTIVE_NOT_OPENED') };
  if (ex.status !== 'PROSPECTIVE_PENDING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status) };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'recording clock') };
  if (!isId(observationId) || !isFiniteNum(outcome) || !isTs(outcomeKnownAtTs)) return { registry: reg, error: finding('SCHEMA', 'outcome') };
  return appendRecord(reg, { kind: 'PROSPECTIVE_OUTCOME', ts, experimentId, payload: { observationId, outcome, outcomeKnownAtTs, designDigest: od.designDigest } });
}

// THE COUNTED SAMPLE: the first N CAPTURED observations in registry order, each joined with its outcome record if one
// has arrived. Arrival order of outcomes changes nothing about which observations count.
function countedRows(ex, design) {
  const outcomes = new Map(); for (const r of ex.prospectiveOutcomes) outcomes.set(r.payload.observationId, r.payload);
  return ex.prospectiveObservations.slice(0, design.terminalObservations).map((r, i) => {
    const c = r.payload; const y = outcomes.get(c.observationId) ?? null;
    return { idx: i, observationId: c.observationId, symbol: c.symbol, ts: c.ts, score: c.score, position: c.position, labelEndTs: c.labelEndTs, designDigest: c.designDigest, recordedAtTs: r.ts, outcome: y ? y.outcome : null, outcomeKnownAtTs: y ? y.outcomeKnownAtTs : null };
  });
}
const scoredOf = (rows) => rows.map((o) => ({ idx: o.idx, score: o.score, position: o.position, outcome: o.outcome, gross: o.outcome === null ? null : o.position * o.outcome, r: o.outcome === null ? null : o.position * o.outcome }));
// the row view the metric catalogue reads (a LEAD_TIME outcome IS its event clock, exactly as in a historical bundle)
const metricRows = (rows, design) => rows.map((o) => ({ idx: o.idx, ts: o.ts, symbol: o.symbol, labelEndTs: o.labelEndTs, eventTs: design.evaluationType === 'LEAD_TIME' ? o.outcome : null, priorSenseTs: null, horizonValues: null, outcome: o.outcome }));

// DESCRIPTIVE progress: counts and an effect estimate under the banner. The formal state says only whether the sealed
// terminal sample has been reached — it is never a p-value re-run after every new observation.
export function prospectiveProgress(reg, experimentId) {
  const ex = experimentOf(reg, experimentId); if (!ex) return null; const od = openedDesign(ex); if (!od) return { status: ex.status, opened: false };
  const d = od.design; const rows = countedRows(ex, d); const withOutcome = rows.filter((o) => o.outcome !== null);
  const scored = scoredOf(withOutcome); const value = withOutcome.length ? metricValue(d.primaryMetric, scored, metricRows(withOutcome, d), { parameters: d.parameters }) : null;
  const evaluated = ex.status === 'PROSPECTIVE_EVALUATED';
  const complete = rows.length >= d.terminalObservations && rows.every((o) => o.outcome !== null);
  return {
    ...AUTHORITY_STAMP, status: ex.status, opened: true, openedAtTs: od.openedAtTs, designDigest: od.designDigest,
    terminalObservations: d.terminalObservations, captured: ex.prospectiveObservations.length, outcomesRecorded: ex.prospectiveOutcomes.length,
    counted: rows.length, countedObservationIds: rows.map((o) => o.observationId), withOutcome: withOutcome.length, positioned: rows.filter((o) => o.position === 1).length,
    pendingObservationIds: rows.filter((o) => o.outcome === null).map((o) => o.observationId),
    interim: evaluated ? null : { banner: INTERIM_BANNER, descriptiveMetric: { name: d.primaryMetric, value: value === null ? null : round6(value) }, series: describe(scored.map((s) => s.gross)) },
    formal: { status: evaluated ? 'EVALUATED' : complete ? 'TERMINAL_SAMPLE_REACHED' : 'TERMINAL_SAMPLE_NOT_REACHED', anytimeValid: ANYTIME_VALID },
  };
}
// THE ONE FORMAL LOOK: at the sealed terminal count, once, with the sealed null, alpha and SEED. The seed cannot be
// chosen here — it was bound at opening, before any outcome existed.
export function evaluateProspectiveTerminal(reg, { experimentId, ts, ...rest }) {
  if (Object.keys(rest).length) return { registry: reg, error: finding('SCHEMA', 'the null seed is sealed at opening and cannot be chosen at the final look'), report: null };
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED'), report: null };
  const od = openedDesign(ex); if (!od) return { registry: reg, error: finding('PROSPECTIVE_NOT_OPENED'), report: null };
  if (ex.status !== 'PROSPECTIVE_PENDING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status), report: null };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'evaluation clock'), report: null };
  const d = od.design; const rows = countedRows(ex, d);
  if (rows.some((o) => o.designDigest !== od.designDigest)) return { registry: reg, error: finding('PROSPECTIVE_DESIGN_CHANGED'), report: null };
  const mature = rows.filter((o) => o.outcome !== null);
  if (rows.length < d.terminalObservations || mature.length < rows.length) return { registry: reg, error: finding('TERMINAL_SAMPLE_NOT_REACHED', `${mature.length}/${d.terminalObservations}`), report: null };
  const lastTs = reg.records[reg.records.length - 1]?.ts ?? 0;
  if (ts < lastTs) return { registry: reg, error: finding('REGISTRY_CLOCK_BACKWARDS'), report: null };
  const latestKnown = Math.max(...rows.map((o) => o.outcomeKnownAtTs), ...rows.map((o) => o.recordedAtTs));
  if (ts < latestKnown) return { registry: reg, error: finding('EVALUATION_BEFORE_RECORDS'), report: null };
  const scored = scoredOf(rows); const mrows = metricRows(rows, d);
  const observed = metricValue(d.primaryMetric, scored, mrows, { parameters: d.parameters });
  const statistic = (scores) => metricValue(d.primaryMetric, scored.map((s, i) => { const p = positionOf(scores[i], { op: d.condition.op, threshold: d.condition.threshold }); return { ...s, score: scores[i], position: p, gross: s.outcome === null ? null : p * s.outcome, r: s.outcome === null ? null : p * s.outcome }; }), mrows, { parameters: d.parameters });
  const rng = createRng(`${d.nullSeed}/prospective/${od.designDigest}`);
  const nullTest = observed === null ? { applicable: false, p: null } : blockPermutationNull(scored.map((s) => s.score), { blockLen: d.blockLengthRows, iterations: d.permutationIterations, rng, statistic, observed, direction: d.direction });
  const signed = signedEffect(observed, d.direction); const reasons = ['TERMINAL_SAMPLE_REACHED'];
  let verdict;
  if (observed === null) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('METRIC_UNDEFINED'); }
  else if (d.direction !== 'UNDECLARED' && signed <= 0) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('TERMINAL_WRONG_DIRECTION'); }
  else if (!nullTest.applicable || nullTest.p > d.nullAlpha) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('TERMINAL_NULL_NOT_REJECTED'); }
  else { verdict = 'PROSPECTIVE_SUPPORTED'; reasons.push('TERMINAL_NULL_REJECTED'); }
  const body = {
    reportVersion: PROSPECTIVE_VERSION, refereeVersion: REFEREE_VERSION, ...AUTHORITY_STAMP, experimentId, experimentFamilyId: ex.experimentFamilyId, designDigest: od.designDigest, design: d,
    terminal: { counted: rows.length, observationIds: rows.map((o) => o.observationId), positioned: rows.filter((o) => o.position === 1).length, metric: { name: d.primaryMetric, value: observed === null ? null : round6(observed), signed: signed === null ? null : round6(signed) }, series: describe(scored.map((s) => s.gross), { sequential: true }), nullTest, alpha: d.nullAlpha, seed: rng.seed, latestOutcomeKnownAtTs: latestKnown },
    anytimeValid: ANYTIME_VALID,
    verdict: { verdict, reasons, meaning: verdict === 'PROSPECTIVE_SUPPORTED' ? 'survived the declared prospective research test; this is not production approval and changes no trading state' : 'did not survive the declared prospective research test' },
    evaluatedAtTs: ts,
  };
  const report = deepFreeze({ ...body, reportDigest: canonicalDigest(body) });
  const r = appendRecord(reg, { kind: 'PROSPECTIVE_EVALUATED', ts, experimentId, payload: { verdict, reasons, reportDigest: report.reportDigest, designDigest: od.designDigest } });
  return { registry: r.registry, error: r.error, report: r.error ? null : report };
}
