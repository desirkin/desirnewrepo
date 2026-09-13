// FORWARD-SHADOW LANE — the PREPARED, EXPLICITLY UNVALIDATED research result. This shapes the lane's matured
// evidence for the EXISTING promotion gate to consume LATER (learning/promotion.js — owned elsewhere, not
// called from here): paired TAKE-minus-ABSTAIN differences per dependence group, fidelity and ambiguity
// breakdowns, and loud disclaimers. It grants nothing: authority NONE, state UNVALIDATED_RESEARCH_RESULT,
// and it is structurally incapable of reaching the Judge (fenced).
import { deepFreeze, round6, AUTHORITY, PURPOSE } from './shadow-contracts.js';

export const SHADOW_RESULT_VERSION = 'forward-shadow-result-1';

export function buildShadowResearchResult({ store, recipeVersion, asOfTs }) {
  const captures = store.captures(); const outcomes = store.outcomes();
  const groups = new Map(); // groupId -> { takeNet: [], abstainNet: [], ambiguous, fidelity flags }
  let pending = 0; let matured = 0; let candleOnly = 0; let depthSupported = 0; let ambiguousRows = 0;
  for (const [captureId, o] of outcomes) {
    const c = captures.get(captureId); if (!c || c.recipeVersion !== recipeVersion) continue;
    if (o.label === 'PENDING_BEFORE_HORIZON') { pending += 1; continue; }
    if (!o.label.startsWith('MATURED')) continue;
    matured += 1;
    if (o.fidelity === 'CANDLE_ONLY') candleOnly += 1; else depthSupported += 1;
    if (o.ambiguityFlags.some((f) => f.startsWith('STOP_TARGET'))) ambiguousRows += 1;
    if (!groups.has(o.groupId)) groups.set(o.groupId, { takeNet: [], abstainNet: [] });
    const g = groups.get(o.groupId);
    if (c.variant.decision === 'TAKE') g.takeNet.push(o.netPct); else g.abstainNet.push(o.netPct);
  }
  // per-group paired difference: mean TAKE net minus mean ABSTAIN net (variants of one moment = ONE group)
  const pairedDiffs = [];
  for (const g of groups.values()) {
    if (!g.takeNet.length || !g.abstainNet.length) continue; // an unpaired group contributes NOTHING (no optimistic fill-in)
    pairedDiffs.push(g.takeNet.reduce((a, b) => a + b, 0) / g.takeNet.length - g.abstainNet.reduce((a, b) => a + b, 0) / g.abstainNet.length);
  }
  const mean = pairedDiffs.length ? pairedDiffs.reduce((a, b) => a + b, 0) / pairedDiffs.length : null;
  return deepFreeze({
    resultVersion: SHADOW_RESULT_VERSION, lane: 'FORWARD_SHADOW', recipeVersion, asOfTs,
    state: 'UNVALIDATED_RESEARCH_RESULT',
    pairedGroups: pairedDiffs.length, maturedRows: matured, pendingRows: pending,
    meanPairedTakeMinusAbstainPct: mean === null ? null : round6(mean),
    fidelity: { candleOnly, depthSupported },
    stopTargetAmbiguousRows: ambiguousRows,
    sizeEvidence: depthSupported > 0 ? 'PARTIAL_DEPTH_SUPPORTED_ROWS_ONLY' : 'NONE_AT_CANDLE_FIDELITY',
    disclaimers: [
      'NOT_VALIDATED: this is descriptive research output; the sealed prospective gate and promotion floors decide validation, not this file',
      'NOT_JUDGE_INPUT: nothing here is decision-eligible; no activation artifact is produced',
      'COUNT_IS_NOT_EDGE: matured/paired counts measure workload and coverage, never performance',
      'CANDLE_ONLY_ROWS_CANNOT_JUSTIFY_LARGE_SIZE_EVIDENCE',
    ],
    authority: AUTHORITY, purpose: PURPOSE,
  });
}
