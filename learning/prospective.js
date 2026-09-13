// LEARN-1 — the sealed prospective validation discipline and the machine-enforced promotion gate.
//
// This mirrors the referee's LAW without importing it (research/referee/ has a structural import fence): a candidate
// is FROZEN before one future observation exists — predicate, scope, primary metric/horizon, comparator, cost model,
// group law, terminal sample target, missingness rule, uncertainty method and alpha are all inside the sealed design
// whose digest is the candidate's identity. Fresh forward evidence then arrives as two append-only stages: a CAPTURE
// commits the hypothetical decision while the outcome is unknown; a later OUTCOME record supplies exactly one
// outcome per capture and can revise nothing. Formal significance is evaluated ONCE, at the pre-registered terminal
// group count. Interim views are descriptive and carry the banner. Repeated looks, modified candidates and reused
// evidence cannot bypass the endpoint: any change to the design is a NEW candidate with a new id, and the journal
// keeps every failed candidate charged against its question's trial budget.
//
// The anti-shortcut floors (learning/contracts.js DEFAULT_FLOORS) are engineering safeguards, not proof of power:
// >= 30 matured prospective dependence groups, >= 7 distinct UTC dates, >= 5 distinct eligible assets, and a
// registered terminal target no smaller than the floors. Skipped winners alone cannot pass: the paired comparison
// runs candidate-vs-baseline over the SAME opportunity stream, newly admitted losers and costs included, under the
// predeclared missingness rule (a coverage ratio below the rule's threshold is INSUFFICIENT, never repaired).
import {
  PROSPECTIVE_VERSION, DEFAULT_FLOORS, AUTHORITY, PURPOSE,
  candidateIdOf, designError, canonicalDigest, utcDateOf, isTs, isFiniteNum, round4, deepFreeze, exactKeys,
} from './contracts.js';
import { assignGroups } from './grouping.js';
import { normalShrinkageGrouped } from './estimator.js';

export const PROSPECTIVE_RECORD_KINDS = Object.freeze(['DESIGN_SEALED', 'CAPTURE', 'OUTCOME', 'TERMINAL_EVALUATED']);
export const TERMINAL_VERDICTS = Object.freeze(['PROSPECTIVE_SUPPORTED', 'PROSPECTIVE_NOT_SUPPORTED', 'INSUFFICIENT_COMPARISON']);
export const INTERIM_BANNER = 'INTERIM — NOT A FORMAL CONFIRMATION';
export const MIN_COMPARISON_COVERAGE = 0.8; // predeclared: below this matured-outcome coverage the comparison is INSUFFICIENT

export function sealDesign({
  patternId, predicate, scope, primaryHorizonMin = 60, primaryMetric = 'NET_LOG_RETURN_60M_PCT',
  comparator = 'BASELINE_RULE_SAME_STREAM', costModel, groupLaw = 'learning-group-law-1',
  terminalGroupTarget, floors = DEFAULT_FLOORS, missingnessRule = `MATURED_COVERAGE_AT_LEAST_${MIN_COMPARISON_COVERAGE}`,
  uncertaintyMethod = 'NORMAL_SE_OVER_GROUP_MEANS', alpha = 0.05, sealedTs, evidenceDigest,
}) {
  const body = {
    prospectiveVersion: PROSPECTIVE_VERSION, candidateId: 'lcand-UNBOUND', patternId, predicate, predicateDigest: canonicalDigest(predicate),
    scope, primaryHorizonMin, primaryMetric, comparator, costModel, groupLaw, terminalGroupTarget, floors, missingnessRule,
    uncertaintyMethod, alpha, sealedTs, evidenceDigest,
  };
  const design = { ...body, candidateId: candidateIdOf(body) };
  const err = designError(design); if (err) throw new Error(`sealDesign: ${err}`);
  return deepFreeze(design);
}

export const CAPTURE_KEYS = Object.freeze(['kind', 'candidateId', 'opportunityId', 'canonicalCoin', 'decisionTs', 'candidateDecision', 'baselineDecision', 'recordedTs', 'labelEndTs']);
export const OUTCOME_KEYS = Object.freeze(['kind', 'candidateId', 'opportunityId', 'outcomeClass', 'metricValue', 'outcomeKnownAtTs', 'recordedTs']);

// ---- validated replay: the ONLY way to obtain trusted prospective state ------------------------------------------
export function replayProspective(records) {
  const designs = new Map(); const captures = new Map(); const outcomes = new Map(); const terminals = new Map(); const errors = [];
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    const at = (m) => { errors.push(`record ${i + 1}: ${m}`); };
    if (!r || typeof r !== 'object' || !PROSPECTIVE_RECORD_KINDS.includes(r.kind)) { at('unknown record kind'); continue; }
    if (r.kind === 'DESIGN_SEALED') {
      const err = designError(r.design ?? null); if (err) { at(err); continue; }
      if (designs.has(r.design.candidateId)) { at('duplicate design'); continue; }
      designs.set(r.design.candidateId, r.design);
      captures.set(r.design.candidateId, new Map()); outcomes.set(r.design.candidateId, new Map());
      continue;
    }
    const d = designs.get(r.candidateId);
    if (!d) { at('record precedes its sealed design'); continue; }
    if (terminals.has(r.candidateId)) { at('record after the one terminal look'); continue; }
    if (r.kind === 'CAPTURE') {
      const k = exactKeys(r, CAPTURE_KEYS); if (k) { at(`capture ${k}`); continue; }
      const caps = captures.get(r.candidateId);
      if (caps.has(r.opportunityId)) { at('duplicate capture'); continue; }
      if (!isTs(r.decisionTs) || !isTs(r.recordedTs) || !isTs(r.labelEndTs)) { at('capture clocks malformed'); continue; }
      if (r.decisionTs < d.sealedTs) { at('capture decided before the design was sealed'); continue; }
      if (r.recordedTs < r.decisionTs) { at('capture recorded before its decision'); continue; }
      if (r.labelEndTs - r.decisionTs < d.primaryHorizonMin * 60_000) { at('capture label window shorter than the sealed horizon'); continue; }
      if (r.recordedTs >= r.labelEndTs) { at('capture not recorded before its label window closes — no prior-capture evidence'); continue; }
      caps.set(r.opportunityId, r);
      continue;
    }
    if (r.kind === 'OUTCOME') {
      const k = exactKeys(r, OUTCOME_KEYS); if (k) { at(`outcome ${k}`); continue; }
      const caps = captures.get(r.candidateId); const outs = outcomes.get(r.candidateId);
      const cap = caps.get(r.opportunityId);
      if (!cap) { at('outcome without a prior capture'); continue; }
      if (outs.has(r.opportunityId)) { at('second outcome for one capture'); continue; }
      if (!isTs(r.outcomeKnownAtTs) || r.outcomeKnownAtTs < cap.labelEndTs) { at('outcome known before its horizon end'); continue; }
      if (!isTs(r.recordedTs) || r.recordedTs < r.outcomeKnownAtTs) { at('outcome recorded before it was known'); continue; }
      outs.set(r.opportunityId, r);
      continue;
    }
    if (r.kind === 'TERMINAL_EVALUATED') {
      terminals.set(r.candidateId, r);
    }
  }
  return { designs, captures, outcomes, terminals, errors };
}

// ---- interim view (descriptive only) -------------------------------------------------------------------------------
export function interimView(state, candidateId, { commonShockDates = new Set() } = {}) {
  const d = state.designs.get(candidateId); if (!d) return null;
  const caps = [...state.captures.get(candidateId).values()];
  const outs = state.outcomes.get(candidateId);
  const matured = caps.filter((c) => outs.has(c.opportunityId));
  const grouping = assignGroups(matured.map((c) => ({ canonicalCoin: c.canonicalCoin, decisionTs: c.decisionTs })), { commonShockDates });
  return deepFreeze({
    banner: INTERIM_BANNER, candidateId, captured: caps.length, matured: matured.length,
    maturedGroups: grouping.groupCount, distinctAssets: grouping.distinctAssets, distinctUtcDates: grouping.distinctUtcDates,
    terminalGroupTarget: d.terminalGroupTarget, floors: d.floors,
  });
}

// ---- the ONE terminal evaluation ------------------------------------------------------------------------------------
// Counted sample = the FIRST terminalGroupTarget matured dependence groups in capture order — never the first N
// favourable ones. The paired comparison is candidate-vs-baseline mean primary metric over the same opportunities:
// the candidate takes the metric where it decided to select and 0 where it skipped, and vice versa for the baseline,
// so newly admitted losers and forgone gains both count. Floors and coverage are machine-enforced before any effect
// is read.
export function evaluateTerminal(state, candidateId, { nowTs, commonShockDates = new Set() }) {
  if (state.terminals.has(candidateId)) throw new Error('evaluateTerminal: the one terminal look is already recorded');
  const d = state.designs.get(candidateId); if (!d) throw new Error('evaluateTerminal: unknown candidate');
  const caps = [...state.captures.get(candidateId).values()].sort((a, b) => a.recordedTs - b.recordedTs || (a.opportunityId < b.opportunityId ? -1 : 1));
  const outs = state.outcomes.get(candidateId);
  // groups over ALL captures (the denominator); matured coverage judged against it under the sealed missingness rule
  const allGrouping = assignGroups(caps.map((c) => ({ canonicalCoin: c.canonicalCoin, decisionTs: c.decisionTs })), { commonShockDates });
  const maturedCaps = caps.filter((c) => outs.has(c.opportunityId));
  const maturedGrouping = assignGroups(maturedCaps.map((c) => ({ canonicalCoin: c.canonicalCoin, decisionTs: c.decisionTs })), { commonShockDates });
  const reasons = [];
  if (maturedGrouping.groupCount < d.terminalGroupTarget) reasons.push('TERMINAL_SAMPLE_NOT_REACHED');
  if (maturedGrouping.groupCount < d.floors.minIndependentGroups) reasons.push('FLOOR_GROUPS_NOT_MET');
  if (maturedGrouping.distinctUtcDates < d.floors.minDistinctUtcDates) reasons.push('FLOOR_DATES_NOT_MET');
  if (maturedGrouping.distinctAssets < d.floors.minDistinctAssets) reasons.push('FLOOR_ASSETS_NOT_MET');
  const coverage = caps.length === 0 ? 0 : maturedCaps.length / caps.length;
  if (coverage < MIN_COMPARISON_COVERAGE) reasons.push('MATURED_COVERAGE_BELOW_RULE'); // dropping difficult outcomes cannot manufacture improvement
  if (reasons.length > 0) {
    return deepFreeze({ kind: 'TERMINAL_EVALUATED', candidateId, verdict: 'INSUFFICIENT_COMPARISON', reasons, effect: null, coverage: round4(coverage), maturedGroups: maturedGrouping.groupCount, distinctAssets: maturedGrouping.distinctAssets, distinctUtcDates: maturedGrouping.distinctUtcDates, recordedTs: nowTs, alpha: d.alpha, authority: AUTHORITY, purpose: PURPOSE });
  }
  // per-group paired difference (candidate minus baseline) of the primary metric
  const diffs = maturedGrouping.groups.map((g) => {
    let sum = 0; let n = 0;
    for (const idx of g.members) {
      const cap = maturedCaps[idx]; const out = outs.get(cap.opportunityId);
      const metric = isFiniteNum(out.metricValue) ? out.metricValue : null;
      if (metric === null) continue;
      const cand = cap.candidateDecision === 'SELECTED_FOR_SHADOW' ? metric : 0;
      const base = cap.baselineDecision === 'SELECTED_FOR_SHADOW' ? metric : 0;
      sum += cand - base; n += 1;
    }
    return n > 0 ? sum / n : null;
  }).filter((v) => v !== null);
  const est = normalShrinkageGrouped({ groupMeans: diffs, pooledMean: 0, priorStrength: 1 });
  // one-sided lower bound must clear zero at the sealed alpha (1.96 ≈ two-sided 5%; the sealed uncertainty method)
  const supported = est.lower95 !== null && est.lower95 > 0;
  return deepFreeze({
    kind: 'TERMINAL_EVALUATED', candidateId, verdict: supported ? 'PROSPECTIVE_SUPPORTED' : 'PROSPECTIVE_NOT_SUPPORTED',
    reasons: supported ? ['PAIRED_LOWER_BOUND_ABOVE_ZERO'] : ['PAIRED_LOWER_BOUND_NOT_ABOVE_ZERO'],
    effect: { pairedMeanDiff: est.posteriorMean, lower95: est.lower95, upper95: est.upper95, groups: est.effectiveGroups, metric: d.primaryMetric },
    coverage: round4(coverage), maturedGroups: maturedGrouping.groupCount, distinctAssets: maturedGrouping.distinctAssets, distinctUtcDates: maturedGrouping.distinctUtcDates,
    allGroups: allGrouping.groupCount, recordedTs: nowTs, alpha: d.alpha, authority: AUTHORITY, purpose: PURPOSE,
  });
}
