// lib/learning-activation-steward.js — PUBLISH-FIX-14 (2026-09-17, independent review F5): the ONE place a validated
// learned adjustment goes live for PAPER, and the ONE place it expires.
//
// Promotion (learning/promotion.js) publishes an activation as PUBLISHED_WAITING_FOR_PAPER and leaves the pattern in
// VALIDATED_PAPER; nothing in the runtime ever moved either to ACTIVE_PAPER, so the Judge's decision memory (which
// requires BOTH heads to be ACTIVE_PAPER and bound to each other) could never hold an active adjustment. This steward
// runs inside an authorized PAPER runtime on the maintenance cadence and appends the two lawful transitions:
//   PUBLISHED_WAITING_FOR_PAPER -> ACTIVE_PAPER  (reason PAPER_RUNTIME_ADOPTED)   pattern VALIDATED_PAPER -> ACTIVE_PAPER
//   ACTIVE_PAPER past expiresTs -> EXPIRED       (reason LIFETIME_ELAPSED)       pattern ACTIVE_PAPER -> RETIRED
// It creates nothing, validates nothing, scores nothing: it only advances records the promotion law already validated.
// Rollback / suspension stay operator or degrade-rule acts (learning kill / arm, transitionActivation). Authority NONE
// beyond the bounded rank-order nudge the activation itself carries. Every failure is contained and logged.
import { transitionActivation, degradationCheck } from '../learning/adapter.js';
import { buildPatternRecord, classifyOutcome } from '../learning/patterns.js';
import { evaluatePredicate } from '../learning/features.js';
import { utcDateOf } from '../learning/contracts.js';

export const STEWARD_VERSION = 'learning-activation-steward-2';
export const DEGRADE_WINDOW_GROUPS = 10; // one evaluation window = this many matured post-activation independent groups (coin x UTC date)

// PUBLISH-FIX-48 (2026-09-17, owner acceptance law): the automatic ROLLBACK. learning/adapter.js degradationCheck — the
// predeclared statistical rule every activation carries (minGroups, adverseFractionAbove, consecutiveWindows) — had no
// runtime caller. This pass builds, for ONE ACTIVE_PAPER activation, the post-activation forward evidence from the store:
// in-scope episodes decided at/after effectiveTs whose facts fall inside the activation's own applicability (the same
// predicate the Judge's selector evaluates), with a matured primary horizon. Independent groups are coin x UTC date;
// a group is ADVERSE when its matured items are mostly ADVERSE (never a single loss). Groups fill consecutive windows of
// DEGRADE_WINDOW_GROUPS in time order; the rule is asked over the completed windows. Pure; the steward acts on it.
export function forwardWindowsOf({ store, activation, windowGroups = DEGRADE_WINDOW_GROUPS }) {
  const scope = activation.scope ?? {}; const groups = new Map();
  const outcomes = store.latestOutcomes();
  for (const e of store.readEpisodes()) {
    if (e.decisionTs < activation.effectiveTs) continue;
    if (scope.setupType && scope.setupType !== 'ANY' && e.setupType !== scope.setupType) continue;
    if (scope.regime && scope.regime !== 'ANY' && e.regime !== scope.regime) continue;
    if (evaluatePredicate(activation.applicability, { features: e.features ?? {} }) !== 'TRUE') continue;
    const o = outcomes.get(e.opportunityId); if (!o) continue;
    const cls = classifyOutcome(o.outcomeRow?.horizons?.['60m']);
    if (cls !== 'FAVORABLE' && cls !== 'ADVERSE' && cls !== 'NEUTRAL') continue;
    const key = `${e.canonicalCoin}|${utcDateOf(e.decisionTs)}`;
    const g = groups.get(key) ?? { key, firstTs: e.decisionTs, adverse: 0, total: 0 };
    g.total += 1; if (cls === 'ADVERSE') g.adverse += 1; if (e.decisionTs < g.firstTs) g.firstTs = e.decisionTs; groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => a.firstTs - b.firstTs || (a.key < b.key ? -1 : 1));
  const windows = [];
  for (let i = 0; i + windowGroups <= ordered.length; i += windowGroups) {
    const slice = ordered.slice(i, i + windowGroups);
    windows.push({ groups: slice.length, adverseGroups: slice.filter((g) => g.adverse * 2 > g.total).length, fromTs: slice[0].firstTs, toTs: slice[slice.length - 1].firstTs });
  }
  return { groups: ordered.length, windows };
}

export function stewardActivations({ store, nowTs, paperActive = true, log = () => {} }) {
  const out = { activated: [], expired: [], rolledBack: [], skipped: [] };
  let heads; let patterns;
  try {
    heads = store.activationHeads(); const ph = store.patternHeads();
    patterns = new Map((ph instanceof Map ? [...ph.values()] : Array.isArray(ph) ? ph : []).map((p) => [p.patternId, p]));
  }
  catch (err) { log(`learning steward: journals unreadable (contained): ${String(err?.message ?? err).slice(0, 120)}`); return out; }
  const list = heads instanceof Map ? [...heads.values()] : Array.isArray(heads) ? heads : [];
  for (const a of list) {
    try {
      const pattern = patterns.get(a.patternId) ?? null;
      if (a.state === 'PUBLISHED_WAITING_FOR_PAPER') {
        if (!paperActive) { out.skipped.push({ activationId: a.activationId, reason: 'PAPER_NOT_ACTIVE' }); continue; }
        if (nowTs >= a.expiresTs) { expire(a, pattern, 'LIFETIME_ELAPSED_BEFORE_ACTIVATION'); continue; }
        if (!pattern || pattern.state !== 'VALIDATED_PAPER' || pattern.candidateId !== a.candidateId || pattern.activationId !== a.activationId) { out.skipped.push({ activationId: a.activationId, reason: 'PATTERN_NOT_VALIDATED_FOR_THIS_ACTIVATION' }); continue; }
        // the activation first (its head is what the memory view reads), then the pattern binding
        store.appendActivation(transitionActivation(a, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: nowTs }));
        store.appendPattern(buildPatternRecord({ predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs, ts: nowTs, seq: pattern.seq + 1, state: 'ACTIVE_PAPER', previousState: pattern.state, transitionReason: 'PAPER_RUNTIME_ADOPTED', evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions, candidateId: pattern.candidateId, activationId: a.activationId }));
        out.activated.push({ activationId: a.activationId, patternId: a.patternId, expiresTs: a.expiresTs });
        log(`LEARNING activation ${a.activationId} is ACTIVE_PAPER (pattern ${a.patternId}; ranking-only, max |effect| ${a.allowedEffect?.maxAbsAdjust ?? '?'}; expires ${new Date(a.expiresTs).toISOString()})`);
        continue;
      }
      if (a.state === 'ACTIVE_PAPER' && nowTs >= a.expiresTs) { expire(a, pattern, 'LIFETIME_ELAPSED'); continue; }
      if (a.state === 'ACTIVE_PAPER') { // PUBLISH-FIX-48: the predeclared degradation rule, over the forward evidence since activation
        const fw = forwardWindowsOf({ store, activation: a });
        const verdict = degradationCheck({ head: a, windows: fw.windows });
        if (verdict.degrade) {
          store.appendActivation(transitionActivation(a, { state: 'ROLLED_BACK', transitionReason: 'PREDECLARED_DEGRADATION_RULE_MET', ts: nowTs }));
          if (pattern && pattern.state === 'ACTIVE_PAPER' && pattern.activationId === a.activationId) store.appendPattern(buildPatternRecord({ predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs, ts: nowTs, seq: pattern.seq + 1, state: 'DEGRADED', previousState: pattern.state, transitionReason: 'PREDECLARED_DEGRADATION_RULE_MET', evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions, candidateId: pattern.candidateId, activationId: a.activationId }));
          out.rolledBack.push({ activationId: a.activationId, patternId: a.patternId, windows: fw.windows.slice(-a.degradeRule.consecutiveWindows) });
          log(`LEARNING activation ${a.activationId} ROLLED BACK (${verdict.reason}: ${fw.windows.slice(-a.degradeRule.consecutiveWindows).map((w) => `${w.adverseGroups}/${w.groups} adverse`).join(', ')} over the last ${a.degradeRule.consecutiveWindows} windows; the Judge answers baseline for this pattern from now on)`);
        }
      }
    } catch (err) { out.skipped.push({ activationId: a?.activationId ?? 'UNKNOWN', reason: `TRANSITION_FAILED: ${String(err?.message ?? err).slice(0, 100)}` }); log(`learning steward: ${a?.activationId ?? '?'} not advanced (contained): ${String(err?.message ?? err).slice(0, 120)}`); }
  }
  return out;
  function expire(a, pattern, reason) {
    store.appendActivation(transitionActivation(a, { state: 'EXPIRED', transitionReason: reason, ts: nowTs }));
    if (pattern && pattern.state === 'ACTIVE_PAPER' && pattern.activationId === a.activationId) store.appendPattern(buildPatternRecord({ predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs, ts: nowTs, seq: pattern.seq + 1, state: 'RETIRED', previousState: pattern.state, transitionReason: reason, evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions, candidateId: pattern.candidateId, activationId: a.activationId }));
    out.expired.push({ activationId: a.activationId, reason });
    log(`LEARNING activation ${a.activationId} EXPIRED (${reason})`);
  }
}
