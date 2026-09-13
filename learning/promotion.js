// LEARN-1 — the promotion orchestration: every requirement machine-enforced, visible in ONE versioned policy object,
// with finite configured values. No hidden TODO, no 'choose later' in the runtime gate. The path is:
//   ACCUMULATING pattern -> freezeCandidate (seals the design, appends DESIGN_SEALED, pattern -> CANDIDATE_FROZEN
//   -> PROSPECTIVE_PENDING) -> fresh forward captures/outcomes (learning/prospective.js law) -> the ONE terminal
//   evaluation -> on FORWARD_SUPPORTED, publishValidated appends the immutable activation record
//   (PUBLISHED_WAITING_FOR_PAPER while the paper runtime is stopped) and the pattern becomes VALIDATED_PAPER.
// A failed terminal returns the pattern to ACCUMULATING with the failure retained; the candidate id stays consumed.
// Nothing here starts paper, changes the Judge, or touches an order path.
import { DEFAULT_FLOORS, deepFreeze } from './contracts.js';
import { sealDesign, replayProspective, evaluateTerminal, MIN_COMPARISON_COVERAGE } from './prospective.js';
import { buildActivation, DEFAULT_DEGRADE_RULE } from './adapter.js';
import { buildPatternRecord } from './patterns.js';

// THE one promotion policy: finite values, rationale beside each. Configuration may narrow these, never widen.
export const PROMOTION_POLICY = deepFreeze({
  policyVersion: 'learning-promotion-policy-1',
  floors: DEFAULT_FLOORS, // engineering anti-shortcut floors; NOT proof of statistical power
  minTerminalGroupTarget: DEFAULT_FLOORS.minIndependentGroups,
  minComparisonCoverage: MIN_COMPARISON_COVERAGE, // dropping difficult outcomes cannot manufacture improvement
  alpha: 0.05, // sealed into each design; a change is a NEW design
  maxAbsAdjustDefault: 0.1, // in baseline score units; inside the code-level ceiling
  activationLifetimeDays: 30,
  degradeRule: DEFAULT_DEGRADE_RULE,
  rationale: 'conservative engineering defaults, labelled defaults — not empirically proven sufficient sample sizes',
});

export function freezeCandidate({ store, pattern, costModel, terminalGroupTarget = PROMOTION_POLICY.minTerminalGroupTarget, nowTs }) {
  if (pattern.state !== 'ACCUMULATING') throw new Error(`freezeCandidate: only an ACCUMULATING pattern can freeze (state ${pattern.state})`);
  const design = sealDesign({
    patternId: pattern.patternId, predicate: pattern.predicate, scope: pattern.scope,
    costModel, terminalGroupTarget, alpha: PROMOTION_POLICY.alpha, sealedTs: nowTs,
    evidenceDigest: pattern.evidence.evidenceRefs.length ? pattern.evidence.evidenceRefs.join('|') : 'NO_REFS',
  });
  store.appendProspective({ kind: 'DESIGN_SEALED', design });
  const frozen = buildPatternRecord({
    predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs,
    ts: nowTs, seq: pattern.seq + 1, state: 'CANDIDATE_FROZEN', previousState: pattern.state, transitionReason: 'CANDIDATE_SEALED',
    evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions,
    candidateId: design.candidateId, activationId: null,
  });
  store.appendPattern(frozen);
  const pending = buildPatternRecord({
    predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs,
    ts: nowTs, seq: pattern.seq + 2, state: 'PROSPECTIVE_PENDING', previousState: 'CANDIDATE_FROZEN', transitionReason: 'AWAITING_FRESH_FORWARD_EVIDENCE',
    evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions,
    candidateId: design.candidateId, activationId: null,
  });
  store.appendPattern(pending);
  return design;
}

// Run the one terminal look for a candidate whose sample target is reached; record it; publish or demote.
export function settleCandidate({ store, candidateId, nowTs, commonShockDates = new Set(), maxAbsAdjust = PROMOTION_POLICY.maxAbsAdjustDefault }) {
  const state = replayProspective(store.readProspective());
  if (state.errors.length > 0) throw new Error(`settleCandidate: prospective journal invalid (${state.errors[0]})`);
  const design = state.designs.get(candidateId);
  if (!design) throw new Error('settleCandidate: unknown candidate');
  const terminal = evaluateTerminal(state, candidateId, { nowTs, commonShockDates });
  store.appendProspective(terminal);
  const heads = store.patternHeads();
  const pattern = heads.get(design.patternId);
  if (!pattern || pattern.state !== 'PROSPECTIVE_PENDING' || pattern.candidateId !== candidateId) {
    return { terminal, activation: null, patternState: pattern?.state ?? null, note: 'PATTERN_NOT_PENDING_FOR_THIS_CANDIDATE' };
  }
  if (terminal.verdict === 'FORWARD_SUPPORTED') {
    const activation = buildActivation({
      candidateId, patternId: design.patternId, trainingCutoffTs: design.sealedTs,
      candidateDigest: candidateId, evidenceDigest: design.evidenceDigest, reportDigest: `terminal-${terminal.recordedTs}`,
      maxAbsAdjust, applicability: design.predicate, effectiveTs: nowTs,
      expiresTs: nowTs + PROMOTION_POLICY.activationLifetimeDays * 86_400_000,
      degradeRule: PROMOTION_POLICY.degradeRule, ts: nowTs,
    });
    store.appendActivation(activation);
    store.appendPattern(buildPatternRecord({
      predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs,
      ts: nowTs, seq: pattern.seq + 1, state: 'VALIDATED_PAPER', previousState: pattern.state, transitionReason: 'TERMINAL_FORWARD_SUPPORTED',
      evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions,
      candidateId, activationId: activation.activationId,
    }));
    return { terminal, activation, patternState: 'VALIDATED_PAPER', note: 'PUBLISHED_WAITING_FOR_PAPER' };
  }
  // failed or insufficient: the pattern returns to accumulation; the trial stays recorded; no silent reset
  store.appendPattern(buildPatternRecord({
    predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs,
    ts: nowTs, seq: pattern.seq + 1, state: 'ACCUMULATING', previousState: pattern.state,
    transitionReason: terminal.verdict === 'INSUFFICIENT_COMPARISON' ? `TERMINAL_INSUFFICIENT:${terminal.reasons[0]}` : 'TERMINAL_NOT_SUPPORTED',
    evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions,
    candidateId: null, activationId: null,
  }));
  return { terminal, activation: null, patternState: 'ACCUMULATING', note: 'CANDIDATE_CONSUMED_PATTERN_RETURNS_TO_ACCUMULATION' };
}
