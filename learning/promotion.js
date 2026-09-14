// LEARN-1 — the promotion orchestration: every requirement machine-enforced, visible in ONE versioned policy object,
// with finite configured values. No hidden TODO, no 'choose later' in the runtime gate. The path is:
//   ACCUMULATING pattern -> freezeCandidate (seals the design, appends DESIGN_SEALED, pattern -> CANDIDATE_FROZEN
//   -> PROSPECTIVE_PENDING) -> fresh forward captures/outcomes (learning/prospective.js law) -> the ONE terminal
//   evaluation -> on FORWARD_SUPPORTED, publishValidated appends the immutable activation record
//   (PUBLISHED_WAITING_FOR_PAPER while the paper runtime is stopped) and the pattern becomes VALIDATED_PAPER.
// A failed terminal returns the pattern to ACCUMULATING with the failure retained; the candidate id stays consumed.
// Nothing here starts paper, changes the Judge, or touches an order path.
import { DEFAULT_FLOORS, LEGACY_PROSPECTIVE_VERSION, canonicalDigest, deepFreeze } from './contracts.js';
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

export function freezeCandidate({
  store, pattern, costModel, consumerBinding,
  primaryMetric = 'NET_LOG_RETURN_60M_PCT',
  comparator = 'BASELINE_RULE_SAME_STREAM',
  terminalGroupTarget = PROMOTION_POLICY.minTerminalGroupTarget, nowTs,
}) {
  if (pattern.state !== 'ACCUMULATING') throw new Error(`freezeCandidate: only an ACCUMULATING pattern can freeze (state ${pattern.state})`);
  const comparison = `${primaryMetric}|${comparator}`;
  if (![
    'NET_LOG_RETURN_60M_PCT|BASELINE_RULE_SAME_STREAM',
    'PAIRED_EXECUTABLE_NET_RETURN_PCT|EVOLVING_ADAPTIVE_RANKING_VS_UNADJUSTED_SAME_BATCH',
  ].includes(comparison)) throw new Error('freezeCandidate: unsupported primary metric/comparator pair');
  const design = sealDesign({
    patternId: pattern.patternId, predicate: pattern.predicate, scope: pattern.scope,
    primaryMetric, comparator, costModel, terminalGroupTarget,
    alpha: PROMOTION_POLICY.alpha, sealedTs: nowTs,
    evidenceDigest: pattern.evidence.evidenceRefs.length ? pattern.evidence.evidenceRefs.join('|') : 'NO_REFS',
    consumerBinding,
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
export function settleCandidate({
  store, candidateId, nowTs, commonShockDates = new Set(),
  maxAbsAdjust = PROMOTION_POLICY.maxAbsAdjustDefault,
  adaptiveRankingTrialValidator = null,
}) {
  const state = replayProspective(store.readProspective(), { adaptiveRankingTrialValidator });
  if (state.errors.length > 0) throw new Error(`settleCandidate: prospective journal invalid (${state.errors[0]})`);
  const design = state.designs.get(candidateId);
  if (!design) throw new Error('settleCandidate: unknown candidate');
  const terminal = evaluateTerminal(state, candidateId, { nowTs, commonShockDates });
  // Reaching the predeclared terminal sample is a precondition for the ONE formal look. An early operator/scheduler
  // call is merely pending: it appends no terminal, consumes no candidate and changes no pattern state.
  if (terminal.reasons.includes('TERMINAL_SAMPLE_NOT_REACHED')) {
    return { terminal: null, activation: null, patternState: 'PROSPECTIVE_PENDING', note: 'TERMINAL_SAMPLE_NOT_REACHED' };
  }
  store.appendProspective(terminal);
  const heads = store.patternHeads();
  const pattern = heads.get(design.patternId);
  if (!pattern || pattern.state !== 'PROSPECTIVE_PENDING' || pattern.candidateId !== candidateId) {
    return { terminal, activation: null, patternState: pattern?.state ?? null, note: 'PATTERN_NOT_PENDING_FOR_THIS_CANDIDATE' };
  }
  if (terminal.verdict === 'FORWARD_SUPPORTED') {
    // v1 designs predate a sealed consumer recipe/policy binding. Their forward results remain replayable history,
    // but attaching today's binding after observing their outcomes would be retrospective selection. Consume the
    // candidate and return the pattern to accumulation; only a newly sealed v2 design can publish to Judge.
    if (design.prospectiveVersion === LEGACY_PROSPECTIVE_VERSION) {
      store.appendPattern(buildPatternRecord({
        predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs,
        ts: nowTs, seq: pattern.seq + 1, state: 'ACCUMULATING', previousState: pattern.state,
        transitionReason: 'LEGACY_CONSUMER_BINDING_UNSEALED',
        evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions,
        candidateId: null, activationId: null,
      }));
      return { terminal, activation: null, patternState: 'ACCUMULATING', note: 'LEGACY_CONSUMER_UNBOUND_INELIGIBLE_FOR_JUDGE' };
    }
    const activation = buildActivation({
      candidateId, patternId: design.patternId, trainingCutoffTs: design.sealedTs,
      candidateDigest: canonicalDigest(design),
      evidenceDigest: canonicalDigest(store.readProspective().filter((r) => (r.candidateId ?? r.design?.candidateId) === candidateId && r.kind !== 'TERMINAL_EVALUATED')),
      reportDigest: canonicalDigest(terminal),
      // the frozen learned parameter: the full permitted positive nudge, itself conservative — sealed at publication,
      // never retuned in place; the artifact also carries the design's exact declared scope for the selector
      maxAbsAdjust, adjust: maxAbsAdjust,
      scope: {
        setupType: String(design.scope?.setupType ?? 'ANY'), regime: String(design.scope?.regime ?? 'ANY'),
        assets: Array.isArray(design.scope?.assets) && design.scope.assets.length ? [...design.scope.assets] : 'ANY',
        venues: Array.isArray(design.scope?.venues) && design.scope.venues.length ? [...design.scope.venues] : 'ANY',
      },
      // the validation evidence travels IN the artifact, straight from the one sealed terminal look: effective
      // sample size is dependence GROUPS, the effect is the paired net difference AFTER the sealed cost model
      validation: {
        evidenceBasis: 'PROSPECTIVE', groupCount: terminal.maturedGroups, assetCount: terminal.distinctAssets,
        dateCount: terminal.distinctUtcDates, netAfterCostsPct: terminal.effect.pairedMeanDiff,
      },
      // candle-fidelity forward validation differentiates NO purchase sizes: the artifact explicitly declares
      // no supported size (null) — dynamic sizing's full-balance path can therefore never cite it
      maxSizeUsd: null,
      featureRecipeVersion: design.consumerBinding.featureRecipeVersion,
      policyVersion: design.consumerBinding.policyDigest,
      applicability: design.predicate, effectiveTs: nowTs,
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
