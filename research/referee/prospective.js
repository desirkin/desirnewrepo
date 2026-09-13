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
import { experimentOf, appendRecord, validatedState } from './registry.js';
import { buildProspectiveDesign, historicalReportError, seedError, ANYTIME_VALID as SHARED_ANYTIME_VALID, CAPTURE_EVIDENCE as SHARED_CAPTURE_EVIDENCE } from './design.js';
import { metricValue, positionOf } from './metrics.js';
import { blockPermutationNull, describe, signedEffect } from './statistics.js';

export const INTERIM_BANNER = 'INTERIM — NOT A FORMAL CONFIRMATION';
export const ANYTIME_VALID = SHARED_ANYTIME_VALID;
export const CAPTURE_EVIDENCE = SHARED_CAPTURE_EVIDENCE;

// the sealed design: everything the terminal test will use, frozen from the manifest and the historical report. The
// feature and condition come from the CANDIDATE THE REPORT ACTUALLY SCORED — never manifest.signal mixed with another
// candidate's threshold. The null seed is bound here, before any prospective outcome exists.
export function sealProspectiveDesign(manifest, historicalReport, { seed, experimentId, experimentFamilyId, manifestDigest, featureDigest, resultPayload, registeredAtTs, openedAtTs }) {
  const se = seedError(seed); if (se) return { error: se };
  const he = historicalReportError(historicalReport, { experimentId, experimentFamilyId, manifest, manifestDigest, featureDigest, resultPayload, registeredAtTs, openedAtTs });
  if (he) return { error: he };
  return { ...buildProspectiveDesign(manifest, historicalReport, { seed }), error: null };
}
export function openProspective(reg, { experimentId, historicalReport, ts, seed = null }) {
  const v = validatedState(reg); if (v.error) return { registry: reg, error: v.error, design: null, designDigest: null };
  const ex = v.state.experiments.get(experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED'), design: null, designDigest: null };
  if (ex.status !== 'EVALUATED') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status), design: null, designDigest: null };
  if (!ex.manifest.prospective) return { registry: reg, error: finding('SCHEMA', 'the manifest declares no prospective design'), design: null, designDigest: null };
  // the seed is chosen ONCE, here, before any prospective outcome exists; there is nothing earlier to compare it with
  const chosen = seed === null ? `sealed-${String(historicalReport?.reportDigest ?? '').slice(0, 32)}` : seed;
  const sealed = sealProspectiveDesign(ex.manifest, historicalReport, { seed: chosen, experimentId, experimentFamilyId: ex.familyId, manifestDigest: ex.manifestDigest, featureDigest: ex.featureDigest, resultPayload: ex.result, registeredAtTs: ex.registeredAtTs, openedAtTs: ts });
  if (sealed.error) return { registry: reg, error: sealed.error, design: null, designDigest: null };
  const r = appendRecord(reg, { kind: 'PROSPECTIVE_OPENED', ts, experimentId, payload: { design: sealed.design, designDigest: sealed.designDigest, historicalReport, historicalReportDigest: historicalReport.reportDigest, ...AUTHORITY_STAMP } });
  return { ...r, design: r.error ? null : sealed.design, designDigest: r.error ? null : sealed.designDigest };
}
const openedOf = (ex) => (ex.prospective ? { design: ex.prospective.design, designDigest: ex.prospective.designDigest, openedAtTs: ex.prospective.openedAtTs, captures: ex.prospective.captures, outcomes: ex.prospective.outcomes, recordedAt: ex.prospective.recordedAt } : null);
// every consumer validates the registry it was handed before reading one field of it
function opened(reg, experimentId, { requirePending = true } = {}) {
  const v = validatedState(reg); if (v.error) return { error: v.error };
  const ex = v.state.experiments.get(experimentId); if (!ex) return { error: finding('EXPERIMENT_NOT_REGISTERED') };
  const od = openedOf(ex); if (!od) return { error: finding('PROSPECTIVE_NOT_OPENED'), ex };
  if (requirePending && ex.status !== 'PROSPECTIVE_PENDING') return { error: finding('STATUS_TRANSITION_REFUSED', ex.status), ex, od };
  return { error: null, ex, od };
}
// STAGE 1 — the capture. Every clock rule is re-proved by the registry's replay; nothing here is the only guard.
export function captureProspectiveObservation(reg, { experimentId, observation, ts }) {
  const o = opened(reg, experimentId); if (o.error) return { registry: reg, error: o.error };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'recording clock') };
  const e = exactKeys(observation, PROSPECTIVE_CAPTURE_INPUT_KEYS); if (e) return { registry: reg, error: finding('SCHEMA', e) };
  const ob = observation;
  if (!isId(ob.observationId) || !isCoin(ob.symbol) || !isTs(ob.ts) || !isTs(ob.labelEndTs) || !(ob.score === null || isFiniteNum(ob.score))) return { registry: reg, error: finding('SCHEMA', 'capture') };
  const payload = { observationId: ob.observationId, symbol: ob.symbol, ts: ob.ts, score: ob.score, position: positionOf(ob.score, { op: o.od.design.condition.op, threshold: o.od.design.condition.threshold }), labelEndTs: ob.labelEndTs, captureEvidence: CAPTURE_EVIDENCE, designDigest: o.od.designDigest };
  return appendRecord(reg, { kind: 'PROSPECTIVE_OBSERVATION', ts, experimentId, payload });
}
// STAGE 2 — the one outcome for a captured observation. It can revise nothing: the record carries only these keys.
export function recordProspectiveOutcome(reg, { experimentId, observationId, outcome, outcomeKnownAtTs, ts }) {
  const o = opened(reg, experimentId); if (o.error) return { registry: reg, error: o.error };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'recording clock') };
  if (!isId(observationId) || !isFiniteNum(outcome) || !isTs(outcomeKnownAtTs)) return { registry: reg, error: finding('SCHEMA', 'outcome') };
  return appendRecord(reg, { kind: 'PROSPECTIVE_OUTCOME', ts, experimentId, payload: { observationId, outcome, outcomeKnownAtTs, designDigest: o.od.designDigest } });
}
// THE COUNTED SAMPLE: the first N CAPTURED observations in registry order, joined with their outcome if one arrived.
function countedRows(od) {
  const ids = [...od.captures.keys()].slice(0, od.design.terminalObservations);
  return ids.map((id, i) => { const c = od.captures.get(id); const y = od.outcomes.get(id) ?? null; return { idx: i, observationId: id, symbol: c.symbol, ts: c.ts, score: c.score, position: c.position, labelEndTs: c.labelEndTs, recordedAtTs: od.recordedAt.get(id), outcome: y ? y.outcome : null, outcomeKnownAtTs: y ? y.outcomeKnownAtTs : null }; });
}
const scoredOf = (rows) => rows.map((o) => ({ idx: o.idx, score: o.score, position: o.position, outcome: o.outcome, gross: o.outcome === null ? null : o.position * o.outcome, r: o.outcome === null ? null : o.position * o.outcome }));
// the row view the metric catalogue reads (a LEAD_TIME outcome IS its event clock, exactly as in a historical bundle)
const metricRows = (rows, design) => rows.map((o) => ({ idx: o.idx, ts: o.ts, symbol: o.symbol, labelEndTs: o.labelEndTs, eventTs: design.evaluationType === 'LEAD_TIME' ? o.outcome : null, priorSenseTs: null, horizonValues: null, outcome: o.outcome }));
const latestClockOf = (rows) => Math.max(...rows.map((o) => o.outcomeKnownAtTs), ...rows.map((o) => o.recordedAtTs));

// DESCRIPTIVE progress. Invalid input is refused, never displayed as a metric.
export function prospectiveProgress(reg, experimentId) {
  const o = opened(reg, experimentId, { requirePending: false });
  if (o.error && !o.od) return { ...AUTHORITY_STAMP, status: o.ex ? o.ex.status : 'UNKNOWN', opened: false, error: o.error };
  const ex = o.ex; const od = o.od; const d = od.design; const rows = countedRows(od); const withOutcome = rows.filter((x) => x.outcome !== null);
  const scored = scoredOf(withOutcome); const value = withOutcome.length ? metricValue(d.primaryMetric, scored, metricRows(withOutcome, d), { parameters: d.parameters }) : null;
  const evaluated = ex.status === 'PROSPECTIVE_EVALUATED';
  const complete = rows.length >= d.terminalObservations && rows.every((x) => x.outcome !== null);
  return {
    ...AUTHORITY_STAMP, status: ex.status, opened: true, openedAtTs: od.openedAtTs, designDigest: od.designDigest,
    terminalObservations: d.terminalObservations, captured: od.captures.size, outcomesRecorded: od.outcomes.size,
    counted: rows.length, countedObservationIds: rows.map((x) => x.observationId), withOutcome: withOutcome.length, positioned: rows.filter((x) => x.position === 1).length,
    pendingObservationIds: rows.filter((x) => x.outcome === null).map((x) => x.observationId),
    interim: evaluated ? null : { banner: INTERIM_BANNER, descriptiveMetric: { name: d.primaryMetric, value: value === null ? null : round6(value) }, series: describe(scored.map((x) => x.gross)) },
    formal: { status: evaluated ? 'EVALUATED' : complete ? 'TERMINAL_SAMPLE_REACHED' : 'TERMINAL_SAMPLE_NOT_REACHED', anytimeValid: ANYTIME_VALID },
  };
}
// THE ONE FORMAL LOOK: at the sealed terminal count, once, with the sealed null, alpha and SEED. The seed cannot be
// chosen here — it was bound at opening, before any outcome existed. The record CARRIES the report it produced.
export function evaluateProspectiveTerminal(reg, { experimentId, ts, ...rest }) {
  if (Object.keys(rest).length) return { registry: reg, error: finding('SCHEMA', 'the null seed is sealed at opening and cannot be chosen at the final look'), report: null };
  const o = opened(reg, experimentId); if (o.error) return { registry: reg, error: o.error, report: null };
  if (!isTs(ts)) return { registry: reg, error: finding('SCHEMA', 'evaluation clock'), report: null };
  const od = o.od; const d = od.design; const rows = countedRows(od);
  const mature = rows.filter((x) => x.outcome !== null);
  if (rows.length < d.terminalObservations || mature.length < rows.length) return { registry: reg, error: finding('TERMINAL_SAMPLE_NOT_REACHED', `${mature.length}/${d.terminalObservations}`), report: null };
  const lastTs = reg.records[reg.records.length - 1]?.ts ?? 0;
  if (ts < lastTs) return { registry: reg, error: finding('REGISTRY_CLOCK_BACKWARDS'), report: null };
  const latestKnown = latestClockOf(rows);
  if (ts < latestKnown) return { registry: reg, error: finding('EVALUATION_BEFORE_RECORDS'), report: null };
  const scored = scoredOf(rows); const mrows = metricRows(rows, d);
  const observed = metricValue(d.primaryMetric, scored, mrows, { parameters: d.parameters });
  const statistic = (scores) => metricValue(d.primaryMetric, scored.map((sc, i) => { const pos = positionOf(scores[i], { op: d.condition.op, threshold: d.condition.threshold }); return { ...sc, score: scores[i], position: pos, gross: sc.outcome === null ? null : pos * sc.outcome, r: sc.outcome === null ? null : pos * sc.outcome }; }), mrows, { parameters: d.parameters });
  const rng = createRng(`${d.nullSeed}/prospective/${od.designDigest}`);
  const nullTest = observed === null ? { applicable: false, p: null } : blockPermutationNull(scored.map((sc) => sc.score), { blockLen: d.blockLengthRows, iterations: d.permutationIterations, rng, statistic, observed, direction: d.direction });
  const signed = signedEffect(observed, d.direction); const reasons = ['TERMINAL_SAMPLE_REACHED'];
  let verdict;
  if (observed === null) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('METRIC_UNDEFINED'); }
  else if (d.direction !== 'UNDECLARED' && signed <= 0) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('TERMINAL_WRONG_DIRECTION'); }
  else if (!nullTest.applicable || nullTest.p > d.nullAlpha) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('TERMINAL_NULL_NOT_REJECTED'); }
  else { verdict = 'PROSPECTIVE_SUPPORTED'; reasons.push('TERMINAL_NULL_REJECTED'); }
  const body = {
    reportVersion: PROSPECTIVE_VERSION, refereeVersion: REFEREE_VERSION, ...AUTHORITY_STAMP, experimentId, experimentFamilyId: o.ex.familyId, designDigest: od.designDigest, design: d,
    terminal: { counted: rows.length, observationIds: rows.map((x) => x.observationId), positioned: rows.filter((x) => x.position === 1).length, metric: { name: d.primaryMetric, value: observed === null ? null : round6(observed), signed: signed === null ? null : round6(signed) }, series: describe(scored.map((sc) => sc.gross), { sequential: true }), nullTest, alpha: d.nullAlpha, seed: rng.seed, latestOutcomeKnownAtTs: latestKnown },
    anytimeValid: ANYTIME_VALID,
    verdict: { verdict, reasons, meaning: verdict === 'PROSPECTIVE_SUPPORTED' ? 'survived the declared prospective research test; this is not production approval and changes no trading state' : 'did not survive the declared prospective research test' },
    evaluatedAtTs: ts,
  };
  const report = deepFreeze({ ...body, reportDigest: canonicalDigest(body) });
  const r = appendRecord(reg, { kind: 'PROSPECTIVE_EVALUATED', ts, experimentId, payload: { verdict, reasons, report, reportDigest: report.reportDigest, designDigest: od.designDigest } });
  return { registry: r.registry, error: r.error, report: r.error ? null : report };
}
