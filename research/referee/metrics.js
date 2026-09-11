// RESEARCH REFEREE — SIGNAL-TYPE METRICS over unified rows. A candidate is a feature plus a condition; the condition's
// threshold is either fixed in the sealed manifest or FITTED ON THE TRAINING ROWS ONLY (a quantile), never on the rows
// it is scored on. The only research "return series" that exists here is r_i = position_i * outcome_i (flat = 0),
// which is a description of a conditional forward-return distribution, never a fill, never an execution.
import { fail, isFiniteNum, round6, STRUCTURAL_MIN } from './contracts.js';
import { mean, sharpe, spearman, auroc, prAuc, precisionAtK, quantile, median } from './statistics.js';

export const scorableRows = (rows, evaluationType) => rows.filter((r) => r.state === 'KNOWN' || (evaluationType === 'LEAD_TIME' && r.state === 'CENSORED'));
export const absenceCensus = (rows) => ({ total: rows.length, known: rows.filter((r) => r.state === 'KNOWN').length, masked: rows.filter((r) => r.state === 'MASKED').length, censored: rows.filter((r) => r.state === 'CENSORED').length });

// the fitted condition: threshold from the TRAIN rows' feature values when a quantile is declared
export function fitCondition(rows, trainIdx, signal) {
  const c = signal.condition;
  if (c.op === 'ALWAYS') return { op: 'ALWAYS', threshold: null, fitted: false };
  if (c.threshold !== null) return { op: c.op, threshold: c.threshold, fitted: false };
  const xs = []; for (const i of trainIdx) { const v = rows[i].features[signal.feature]; if (v !== null) xs.push(v); }
  if (xs.length < 2) return { op: c.op, threshold: null, fitted: true, unfittable: true };
  return { op: c.op, threshold: quantile(xs, c.quantile), fitted: true, fitRows: xs.length };
}
export function positionOf(value, fit) {
  if (value === null || fit.unfittable) return 0;
  switch (fit.op) { case 'ALWAYS': return 1; case 'GT': return value > fit.threshold ? 1 : 0; case 'GTE': return value >= fit.threshold ? 1 : 0; case 'LT': return value < fit.threshold ? 1 : 0; case 'LTE': return value <= fit.threshold ? 1 : 0; default: return fail('INTERNAL_FAILURE', 'condition op'); }
}
// scores + positions of one candidate on `idxs`, with the condition fitted on `trainIdx`
export function scoreRows(rows, idxs, trainIdx, signal, { costPct = 0 } = {}) {
  const fit = fitCondition(rows, trainIdx, signal);
  const out = idxs.map((i) => { const v = rows[i].features[signal.feature]; const p = positionOf(v, fit); const y = rows[i].outcome; return { idx: i, score: v, position: p, outcome: y, r: y === null ? null : p * y - (p ? costPct : 0), gross: y === null ? null : p * y }; });
  return { fit, scored: out };
}
export const seriesOf = (scored, { net = false } = {}) => scored.filter((s) => s.outcome !== null).map((s) => (net ? s.r : s.gross));

// ---- the metric catalogue implementation --------------------------------------------------------------------------------
// bucket rows by decision ts (a cross-section) for RANKING metrics
function buckets(scored, rows) { const m = new Map(); for (const s of scored) { const t = rows[s.idx].ts; if (!m.has(t)) m.set(t, []); m.get(t).push(s); } return [...m.values()]; }
const topIdx = (arr, key, k) => arr.map((s, i) => i).sort((a, b) => key(arr[b]) - key(arr[a]) || a - b).slice(0, k);
export function metricValue(name, scored, rows, { parameters, net = false }) {
  const withOutcome = scored.filter((s) => s.outcome !== null && s.score !== null);
  switch (name) {
    case 'SHARPE_PER_OBS': { const xs = seriesOf(scored, { net }); return xs.length >= STRUCTURAL_MIN.seriesForSharpe ? sharpe(xs) : null; }
    case 'MEAN_RETURN': { const xs = seriesOf(scored, { net }); return xs.length ? mean(xs) : null; }
    case 'MEAN_CONDITIONAL_RETURN': { const xs = scored.filter((s) => s.position === 1 && s.outcome !== null).map((s) => (net ? s.r : s.gross)); return xs.length >= 2 ? mean(xs) : null; }
    case 'RANK_IC': return withOutcome.length >= 3 ? spearman(withOutcome.map((s) => s.score), withOutcome.map((s) => s.outcome)) : null;
    case 'AUROC': return withOutcome.length >= 2 ? auroc(withOutcome.map((s) => s.score), withOutcome.map((s) => (s.outcome > 0 ? 1 : 0))) : null;
    case 'PR_AUC': return withOutcome.length >= 2 ? prAuc(withOutcome.map((s) => s.score), withOutcome.map((s) => (s.outcome > 0 ? 1 : 0))) : null;
    case 'PRECISION_AT_K': return precisionAtK(withOutcome.map((s) => s.score), withOutcome.map((s) => (s.outcome > 0 ? 1 : 0)), parameters.topK);
    case 'LIFT_AT_K': { const p = precisionAtK(withOutcome.map((s) => s.score), withOutcome.map((s) => (s.outcome > 0 ? 1 : 0)), parameters.topK); const base = withOutcome.length ? withOutcome.filter((s) => s.outcome > 0).length / withOutcome.length : 0; return p === null || base === 0 ? null : p / base; }
    case 'TOP_K_PRECISION': { const k = parameters.topK; const vals = []; for (const b of buckets(withOutcome, rows)) { if (b.length < 2 * k) continue; const ts = new Set(topIdx(b, (s) => s.score, k)); const to = topIdx(b, (s) => s.outcome, k); vals.push(to.filter((i) => ts.has(i)).length / k); } return vals.length ? mean(vals) : null; }
    case 'TOP_QUANTILE_LIFT': { const q = parameters.topQuantile; const vals = []; for (const b of buckets(withOutcome, rows)) { const k = Math.max(1, Math.floor(b.length * (1 - q))); if (b.length < 2 * k) continue; const top = topIdx(b, (s) => s.score, k).map((i) => b[i].outcome); vals.push(mean(top) - mean(b.map((s) => s.outcome))); } return vals.length ? mean(vals) : null; }
    case 'DETECTION_RATE': { const events = scored.filter((s) => rows[s.idx].eventTs !== null); if (!events.length) return null; return events.filter((s) => s.position === 1 && rows[s.idx].ts < rows[s.idx].eventTs).length / events.length; }
    case 'MEDIAN_LEAD_MS': { const leads = scored.filter((s) => s.position === 1 && rows[s.idx].eventTs !== null && rows[s.idx].ts < rows[s.idx].eventTs).map((s) => rows[s.idx].eventTs - rows[s.idx].ts); return leads.length ? median(leads) : null; }
    case 'LEAD_VS_PRIOR_SENSE_RATE': { const det = scored.filter((s) => s.position === 1 && rows[s.idx].eventTs !== null && rows[s.idx].ts < rows[s.idx].eventTs); if (!det.length) return null; return det.filter((s) => rows[s.idx].priorSenseTs === null || rows[s.idx].ts < rows[s.idx].priorSenseTs).length / det.length; }
    default: return fail('INTERNAL_FAILURE', 'unknown metric');
  }
}
// LEAD_TIME extras and the base rate / prevalence facts a report shows next to any metric
export function metricContext(scored, rows, evaluationType) {
  const withOutcome = scored.filter((s) => s.outcome !== null); const positioned = scored.filter((s) => s.position === 1);
  const ctx = { rows: scored.length, withOutcome: withOutcome.length, positioned: positioned.length, positionRate: scored.length ? round6(positioned.length / scored.length) : null, baseRate: withOutcome.length ? round6(withOutcome.filter((s) => s.outcome > 0).length / withOutcome.length) : null, unconditionalMean: withOutcome.length ? round6(mean(withOutcome.map((s) => s.outcome))) : null };
  if (evaluationType === 'LEAD_TIME') { const alarms = positioned.length; const falseAlarms = positioned.filter((s) => rows[s.idx].eventTs === null).length; ctx.falseAlarmRate = alarms ? round6(falseAlarms / alarms) : null; ctx.events = scored.filter((s) => rows[s.idx].eventTs !== null).length; ctx.duplicateEventHandling = 'ONE_ROW_PER_DETECTION_CANDIDATE; a detection after its own event is not a detection'; }
  return ctx;
}
// the declared baseline the effect is measured against
export function baselineValue(kind, name, scored, rows, parameters) {
  const withOutcome = scored.filter((s) => s.outcome !== null); const prevalence = withOutcome.length ? withOutcome.filter((s) => s.outcome > 0).length / withOutcome.length : null;
  if (kind === 'ZERO') return 0;
  if (kind === 'UNCONDITIONAL_MEAN') { if (name === 'SHARPE_PER_OBS') { const xs = withOutcome.map((s) => s.outcome); return xs.length >= STRUCTURAL_MIN.seriesForSharpe ? sharpe(xs) : null; } return withOutcome.length ? mean(withOutcome.map((s) => s.outcome)) : null; }
  if (kind === 'BASE_RATE') return prevalence;
  if (kind === 'RANDOM_RANKING') { switch (name) { case 'AUROC': return 0.5; case 'PR_AUC': case 'PRECISION_AT_K': return prevalence; case 'LIFT_AT_K': return 1; case 'RANK_IC': case 'TOP_QUANTILE_LIFT': case 'SHARPE_PER_OBS': case 'MEAN_RETURN': case 'MEAN_CONDITIONAL_RETURN': return 0; case 'TOP_K_PRECISION': { const bs = buckets(withOutcome, rows).filter((b) => b.length >= 2 * parameters.topK); return bs.length ? mean(bs.map((b) => parameters.topK / b.length)) : null; } default: return null; } }
  return null;
}
// which manifest parameters a metric needs
export function metricParameterError(name, parameters) {
  if ((name === 'PRECISION_AT_K' || name === 'LIFT_AT_K' || name === 'TOP_K_PRECISION') && !(Number.isSafeInteger(parameters.topK) && parameters.topK >= 1)) return 'topK';
  if (name === 'TOP_QUANTILE_LIFT' && !(isFiniteNum(parameters.topQuantile) && parameters.topQuantile > 0 && parameters.topQuantile < 1)) return 'topQuantile';
  return null;
}
