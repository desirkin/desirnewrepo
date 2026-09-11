// RESEARCH REFEREE — THE PROSPECTIVE SHADOW. Historical evidence is not enough. A candidate that survived the
// historical tests may be registered PROSPECTIVE_PENDING; its feature definition, condition (with any fitted threshold
// frozen to a number), primary metric, horizon, universe rule, terminal sample count and null test are SEALED before
// one prospective observation exists, and future observations / outcomes are recorded DARK in the registry with zero
// trading authority. FORMAL significance is evaluated ONCE, at the pre-registered terminal sample count. Anything
// shown before that is DESCRIPTIVE and carries the banner INTERIM — NOT A FORMAL CONFIRMATION. Changing any sealed
// element mid-stream is refused (PROSPECTIVE_DESIGN_CHANGED): that is a new experiment. The data model carries a
// `sequentialMethod` slot so an anytime-valid test can be plugged in later without changing experiment identity;
// v1 leaves it NOT_IMPLEMENTED rather than improvising one.
import { isPlainObject, isTs, isFiniteNum, canonicalDigest, deepFreeze, exactKeys, isCoin, isId, finding, round6, createRng, AUTHORITY_STAMP, PROSPECTIVE_VERSION, REFEREE_VERSION, LIMITS } from './contracts.js';
import { experimentOf, appendRecord } from './registry.js';
import { metricValue, positionOf } from './metrics.js';
import { blockPermutationNull, describe, signedEffect } from './statistics.js';

export const INTERIM_BANNER = 'INTERIM — NOT A FORMAL CONFIRMATION';
export const ANYTIME_VALID = deepFreeze({ status: 'NOT_IMPLEMENTED', note: 'v1 evaluates formal significance only at the sealed terminal sample count; a sequential method may be plugged into design.sequentialMethod later without changing experiment identity' });
export const PROSPECTIVE_OBSERVATION_KEYS = Object.freeze(['observationId', 'symbol', 'ts', 'score', 'labelEndTs', 'outcome', 'outcomeKnownAtTs']);

// the sealed design: everything the terminal test will use, frozen from the manifest and the historical report
export function sealProspectiveDesign(manifest, historicalReport) {
  const fit = historicalReport.primaryResult.fit; const p = manifest.prospective;
  const design = { prospectiveVersion: PROSPECTIVE_VERSION, refereeVersion: REFEREE_VERSION, feature: manifest.signal.feature, featureDefinitionDigest: manifest.features.find((f) => f.name === manifest.signal.feature).definitionDigest, condition: { op: fit.op, threshold: fit.threshold }, primaryMetric: manifest.primaryMetric, parameters: manifest.parameters, direction: manifest.direction, horizonMs: p.horizonMs, terminalObservations: p.terminalObservations, universeRule: p.universeRule, symbolScope: manifest.universe.symbolScope, nullAlpha: manifest.criteria.nullAlpha, blockLengthRows: historicalReport.overfitting.negativeControls.blockLen, permutationIterations: manifest.controls.permutationIterations, sequentialMethod: p.sequentialMethod, anytimeValid: ANYTIME_VALID, evaluationType: manifest.evaluationType, historicalReportDigest: historicalReport.reportDigest };
  return deepFreeze({ design, designDigest: canonicalDigest(design) });
}
export function openProspective(reg, { experimentId, historicalReport, ts }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  if (ex.status !== 'EVALUATED') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status) };
  if (!ex.manifest.prospective) return { registry: reg, error: finding('SCHEMA', 'the manifest declares no prospective design') };
  const { reportDigest: claimed, ...body } = isPlainObject(historicalReport) ? historicalReport : {};
  if (!isPlainObject(historicalReport) || historicalReport.identity?.experimentId !== experimentId || claimed !== ex.result.payload.reportDigest || canonicalDigest(body) !== claimed) return { registry: reg, error: finding('CHECKSUM_MISMATCH', 'historical report') };
  if (historicalReport.verdict.verdict !== 'HISTORICALLY_INTERESTING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', 'only a HISTORICALLY_INTERESTING result may open a prospective shadow') };
  const { design, designDigest } = sealProspectiveDesign(ex.manifest, historicalReport);
  const r = appendRecord(reg, { kind: 'PROSPECTIVE_OPENED', ts, experimentId, payload: { design, designDigest, historicalReportDigest: historicalReport.reportDigest, ...AUTHORITY_STAMP } });
  return { ...r, design, designDigest };
}
function openedDesign(ex) { return ex.prospective ? { design: ex.prospective.payload.design, designDigest: ex.prospective.payload.designDigest, openedAtTs: ex.prospective.ts } : null; }
// one DARK observation: recorded after opening, outcome known only after its own horizon, never twice
export function recordProspectiveObservation(reg, { experimentId, observation, ts }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED') };
  const od = openedDesign(ex); if (!od || ex.status !== 'PROSPECTIVE_PENDING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status) };
  const e = exactKeys(observation, PROSPECTIVE_OBSERVATION_KEYS); if (e) return { registry: reg, error: finding('SCHEMA', e) };
  const o = observation; const d = od.design;
  if (!isId(o.observationId) || !isCoin(o.symbol) || !isTs(o.ts) || !isTs(o.labelEndTs) || !(o.score === null || isFiniteNum(o.score)) || !(o.outcome === null || isFiniteNum(o.outcome)) || !(o.outcomeKnownAtTs === null || isTs(o.outcomeKnownAtTs))) return { registry: reg, error: finding('SCHEMA', 'observation') };
  if (!d.symbolScope.includes(o.symbol)) return { registry: reg, error: finding('SYMBOL_OUTSIDE_SCOPE') };
  if (o.ts < od.openedAtTs) return { registry: reg, error: finding('EVALUATION_BEFORE_REGISTRATION', 'a prospective observation must be decided after the design was sealed') };
  if (o.labelEndTs - o.ts !== d.horizonMs) return { registry: reg, error: finding('LABEL_HORIZON_MISMATCH') };
  if (o.outcome !== null && (o.outcomeKnownAtTs === null || o.outcomeKnownAtTs < o.labelEndTs)) return { registry: reg, error: finding('OUTCOME_KNOWN_BEFORE_HORIZON_END') };
  if (o.outcome === null && o.outcomeKnownAtTs !== null) return { registry: reg, error: finding('CONTRADICTORY_KNOWN_STATE') };
  if (ex.prospectiveObservations.some((r) => r.payload.observationId === o.observationId)) return { registry: reg, error: finding('DUPLICATE_OBSERVATION_ID') };
  if (ex.prospectiveObservations.length >= LIMITS.maxProspectiveObservations) return { registry: reg, error: finding('REGISTRY_LIMIT_EXCEEDED') };
  const position = positionOf(o.score, { op: d.condition.op, threshold: d.condition.threshold });
  return appendRecord(reg, { kind: 'PROSPECTIVE_OBSERVATION', ts, experimentId, payload: { ...o, position, designDigest: od.designDigest } });
}
// the observations the sealed design counts: the FIRST terminalObservations recorded, in registry order
function terminalRows(ex, design) { return ex.prospectiveObservations.slice(0, design.terminalObservations).map((r, i) => ({ idx: i, ...r.payload, ts: r.payload.ts })); }
function scoredOf(obs) { return obs.map((o) => ({ idx: o.idx, score: o.score, position: o.position, outcome: o.outcome, gross: o.outcome === null ? null : o.position * o.outcome, r: o.outcome === null ? null : o.position * o.outcome })); }
// descriptive progress: counts and effect estimates with the banner; the formal state says only whether the terminal count is reached
export function prospectiveProgress(reg, experimentId) {
  const ex = experimentOf(reg, experimentId); if (!ex) return null; const od = openedDesign(ex); if (!od) return { status: ex.status, opened: false };
  const d = od.design; const rows = terminalRows(ex, d); const withOutcome = rows.filter((o) => o.outcome !== null);
  const consumed = ex.prospectiveObservations.filter((r) => r.payload.designDigest !== od.designDigest).length;
  const scored = scoredOf(withOutcome); const value = withOutcome.length ? metricValue(d.primaryMetric, scored, rows, { parameters: d.parameters }) : null;
  const evaluated = ex.status === 'PROSPECTIVE_EVALUATED';
  return { ...AUTHORITY_STAMP, status: ex.status, opened: true, openedAtTs: od.openedAtTs, designDigest: od.designDigest, terminalObservations: d.terminalObservations, recorded: ex.prospectiveObservations.length, counted: rows.length, withOutcome: withOutcome.length, positioned: rows.filter((o) => o.position === 1).length, designMismatches: consumed, interim: evaluated ? null : { banner: INTERIM_BANNER, descriptiveMetric: { name: d.primaryMetric, value: value === null ? null : round6(value) }, series: describe(scored.filter((s) => s.outcome !== null).map((s) => s.gross)) }, formal: { status: evaluated ? 'EVALUATED' : withOutcome.length >= d.terminalObservations ? 'TERMINAL_SAMPLE_REACHED' : 'TERMINAL_SAMPLE_NOT_REACHED', anytimeValid: ANYTIME_VALID } };
}
// THE ONE FORMAL LOOK: only at the sealed terminal count, only once, with the sealed null and the sealed alpha
export function evaluateProspectiveTerminal(reg, { experimentId, ts, seed }) {
  const ex = experimentOf(reg, experimentId); if (!ex) return { registry: reg, error: finding('EXPERIMENT_NOT_REGISTERED'), report: null };
  const od = openedDesign(ex); if (!od || ex.status !== 'PROSPECTIVE_PENDING') return { registry: reg, error: finding('STATUS_TRANSITION_REFUSED', ex.status), report: null };
  const d = od.design; const rows = terminalRows(ex, d);
  if (rows.some((o) => o.designDigest !== od.designDigest)) return { registry: reg, error: finding('PROSPECTIVE_DESIGN_CHANGED'), report: null };
  if (rows.length < d.terminalObservations || rows.some((o) => o.outcome === null)) return { registry: reg, error: finding('TERMINAL_SAMPLE_NOT_REACHED', `${rows.filter((o) => o.outcome !== null).length}/${d.terminalObservations}`), report: null };
  const scored = scoredOf(rows); const observed = metricValue(d.primaryMetric, scored, rows, { parameters: d.parameters });
  const statistic = (scores) => metricValue(d.primaryMetric, scored.map((s, i) => { const p = positionOf(scores[i], { op: d.condition.op, threshold: d.condition.threshold }); return { ...s, score: scores[i], position: p, gross: s.outcome === null ? null : p * s.outcome, r: s.outcome === null ? null : p * s.outcome }; }), rows, { parameters: d.parameters });
  const rng = createRng(`${seed}/prospective/${od.designDigest}`);
  const nullTest = observed === null ? { applicable: false, p: null } : blockPermutationNull(scored.map((s) => s.score), { blockLen: d.blockLengthRows, iterations: d.permutationIterations, rng, statistic, observed, direction: d.direction });
  const signed = signedEffect(observed, d.direction); const reasons = ['TERMINAL_SAMPLE_REACHED'];
  let verdict;
  if (observed === null) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('METRIC_UNDEFINED'); }
  else if (d.direction !== 'UNDECLARED' && signed <= 0) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('TERMINAL_WRONG_DIRECTION'); }
  else if (!nullTest.applicable || nullTest.p > d.nullAlpha) { verdict = 'PROSPECTIVE_NOT_SUPPORTED'; reasons.push('TERMINAL_NULL_NOT_REJECTED'); }
  else { verdict = 'PROSPECTIVE_SUPPORTED'; reasons.push('TERMINAL_NULL_REJECTED'); }
  const body = { reportVersion: PROSPECTIVE_VERSION, refereeVersion: REFEREE_VERSION, ...AUTHORITY_STAMP, experimentId, experimentFamilyId: ex.experimentFamilyId, designDigest: od.designDigest, design: d, terminal: { counted: rows.length, positioned: rows.filter((o) => o.position === 1).length, metric: { name: d.primaryMetric, value: observed === null ? null : round6(observed), signed: signed === null ? null : round6(signed) }, series: describe(scored.map((s) => s.gross), { sequential: true }), nullTest, alpha: d.nullAlpha, seed: rng.seed }, anytimeValid: ANYTIME_VALID, verdict: { verdict, reasons, meaning: verdict === 'PROSPECTIVE_SUPPORTED' ? 'survived the declared prospective research test; this is not production approval and changes no trading state' : 'did not survive the declared prospective research test' }, evaluatedAtTs: ts };
  const report = deepFreeze({ ...body, reportDigest: canonicalDigest(body) });
  const r = appendRecord(reg, { kind: 'PROSPECTIVE_EVALUATED', ts, experimentId, payload: { verdict, reasons, reportDigest: report.reportDigest, designDigest: od.designDigest } });
  return { registry: r.registry, error: r.error, report };
}
