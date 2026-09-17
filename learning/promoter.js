// THE PROMOTER (PUBLISH-FIX-39, 2026-09-17). LEARN-1 had every piece of the promotion law — freezeCandidate, the
// prospective CAPTURE/OUTCOME records, the ONE terminal look, publishValidated — and nothing in the running app ever
// called any of it: activations stayed 0 forever. This is the runtime owner of that path, in four bounded moves per tick:
//
//   1. PROPOSE — for a descriptive cell (an ACCUMULATING pattern per setupType|regime, built by learning/service.js)
//      whose matured evidence meets the anti-shortcut floors, find the best ONE-clause "when" over the Judge's prepared
//      facts (a decision stump: feature ≥/≤ a quantile threshold) whose in-domain matured net return beats the cell's
//      baseline by a margin. The stump becomes its OWN pattern (NOTICED -> ACCUMULATING, origin CANDIDATE_STUMP) and is
//      frozen at once (freezeCandidate seals the design: predicate, scope, cost model, floors, consumer binding). The
//      cell itself stays descriptive. An empty predicate is never proposed — the Judge's selector rejects it.
//   2. CAPTURE — for every PROSPECTIVE_PENDING design: each NEW in-scope episode decided after the seal is captured
//      BEFORE its label window closes: candidateDecision = what the sealed predicate says on the episode's own recorded
//      features; baselineDecision = what the Judge (or the sweep rule) actually did. Recorded once; never rewritten.
//   3. OUTCOME — a captured episode whose 60m label has matured gets its OUTCOME record: class + the NET metric
//      (log return minus the sealed round-trip cost model). Known before recorded, recorded once.
//   4. SETTLE — settleCandidate on every pending design: TERMINAL_SAMPLE_NOT_REACHED is a no-op; FORWARD_SUPPORTED
//      publishes the activation (PUBLISHED_WAITING_FOR_PAPER — the steward adopts it); a failed terminal returns the
//      stump to ACCUMULATING with its trial retained. Nothing here touches the Judge; authority NONE.
//
// Everything is derived from the store's own journals (episodes, outcomes, patterns, prospective), so a restart
// resumes exactly where the journals say. Every failure is contained per candidate and counted.
import { DEFAULT_FLOORS, canonicalDigest, utcDateOf } from './contracts.js';
import { classifyOutcome, nextPatternStep, buildPatternRecord, BITE_HORIZON_MIN, horizonForScope } from './patterns.js';
import { freezeCandidate, settleCandidate, PROMOTION_POLICY } from './promotion.js';
import { replayProspective } from './prospective.js';
import { evaluatePredicate } from './features.js';

export const PROMOTER_VERSION = 'learning-promoter-1';
export const CANDIDATE_ORIGIN = 'CANDIDATE_STUMP';
export const JUDGE_FACTS = Object.freeze(['rv60', 'fi15', 'fi60', 'spreadBps', 'depthUsd10bps', 'atrPct']);
export const DEFAULT_MAX_PENDING = 4;
export const PRIMARY_HORIZON_MIN = 60;
// PUBLISH-FIX-56 (2026-09-17, independent review f32484ca finding 2): the promotion is judged on the horizon the trade
// actually lives on. The Judge's setups are scored on the 5-minute BITE (learning/decision-yardstick.js: "did the move
// we were hunting happen in the 4-6 minutes we would have held it"); the promoter used to freeze every candidate on the
// 60-minute research horizon, so a lesson could look good over an hour while the short trade it changes would have been
// poor (or the reverse). Now a Judge-setup cell freezes on the BITE horizon (net of the sealed cost model — a 5-minute
// scalp must beat the fee both ways), the DAILY_MOVER cell keeps the hour its features describe, and the 15-minute
// continuation and the 60-minute horizon stay diagnostics on every graded decision.
export { BITE_HORIZON_MIN, horizonForScope };
export const metricForHorizon = (h) => `NET_LOG_RETURN_${h}M_PCT`;
const STUMP_QUANTILES = Object.freeze([0.25, 0.5, 0.75]);
const STUMP_MIN_IN = 10;
const STUMP_MIN_IN_FRACTION = 0.3;
const STUMP_MIN_LIFT_PCT = 0.15; // the in-domain mean net return must beat the cell's mean by this many percentage points
const STUMP_MIN_COVERAGE = 0.6; // a feature unknown on more than 40% of the cell's items is not a "when"

const isSelected = (d) => d === 'SELECTED_FOR_SHADOW' || d === 'SELECTED_FOR_PAPER';
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// the net metric of a matured 60m horizon under the sealed cost model: a long round trip pays the fee both ways and
// the slippage both ways; a horizon without a finite log return has no metric (censored stays censored)
export function netMetricOf(horizon, costModel) {
  if (!horizon || horizon.state !== 'KNOWN' || !Number.isFinite(horizon.logReturnPct)) return null;
  const fee = Number.isFinite(costModel?.feePctPerSide) ? costModel.feePctPerSide : 0;
  const slip = Number.isFinite(costModel?.slippageBps) ? costModel.slippageBps / 100 : 0;
  return round4(horizon.logReturnPct - 2 * fee - 2 * slip);
}

// items of one cell with a matured 60m outcome: the stump's training table (decision, features, net metric)
export function cellItems({ episodes, outcomes, scope, costModel, horizonMin = horizonForScope(scope) }) {
  const items = [];
  for (const e of episodes) {
    if (e.setupType !== scope.setupType || e.regime !== scope.regime) continue;
    const o = outcomes.get(e.opportunityId); if (!o) continue;
    const h = o.outcomeRow?.horizons?.[`${horizonMin}m`];
    const cls = classifyOutcome(h);
    if (cls === 'NOT_YET_KNOWN' || cls === 'UNAVAILABLE') continue;
    items.push({ opportunityId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionTs: e.decisionTs, evidenceBasis: e.evidenceBasis, outcomeClass: cls, decision: e.decision, features: e.features ?? {}, metric: netMetricOf(h, costModel) });
  }
  return items;
}

// the decision stump: the best single clause over the consumable facts, or null when no clause earns the lift
export function proposeStump(items, { features = JUDGE_FACTS, minIn = STUMP_MIN_IN, minInFraction = STUMP_MIN_IN_FRACTION, minLiftPct = STUMP_MIN_LIFT_PCT, minCoverage = STUMP_MIN_COVERAGE } = {}) {
  const scored = items.filter((i) => Number.isFinite(i.metric));
  if (scored.length < minIn) return null;
  const baseMean = scored.reduce((s, i) => s + i.metric, 0) / scored.length;
  let best = null;
  for (const feature of features) {
    const known = scored.filter((i) => i.features[feature]?.availability === 'KNOWN' && Number.isFinite(i.features[feature].value));
    if (known.length < Math.max(minIn, Math.ceil(minCoverage * scored.length))) continue;
    const values = known.map((i) => i.features[feature].value).sort((a, b) => a - b);
    for (const q of STUMP_QUANTILES) {
      const threshold = round4(values[Math.min(values.length - 1, Math.floor(q * values.length))]);
      for (const op of ['GTE', 'LTE']) {
        const inside = known.filter((i) => (op === 'GTE' ? i.features[feature].value >= threshold : i.features[feature].value <= threshold));
        if (inside.length < minIn || inside.length < minInFraction * scored.length || inside.length === known.length) continue;
        const mean = inside.reduce((s, i) => s + i.metric, 0) / inside.length;
        const lift = mean - baseMean;
        if (lift < minLiftPct) continue;
        // predeclared tie-break: larger lift, then the larger in-domain sample, then the lexicographic clause
        const key = `${feature}|${op}|${threshold}`;
        if (!best || lift > best.lift + 1e-9 || (Math.abs(lift - best.lift) <= 1e-9 && (inside.length > best.inside.length || (inside.length === best.inside.length && key < best.key)))) {
          best = { clause: { feature, op, threshold }, lift: round4(lift), inMean: round4(mean), baseMean: round4(baseMean), inside, key };
        }
      }
    }
  }
  if (!best) return null;
  return { predicate: { clauses: [best.clause] }, lift: best.lift, inMean: best.inMean, baseMean: best.baseMean, inItems: best.inside, n: scored.length };
}

const floorsMet = (evidence, floors) => evidence && evidence.groupCount >= floors.minIndependentGroups && evidence.distinctUtcDates >= floors.minDistinctUtcDates && evidence.distinctAssets >= floors.minDistinctAssets;

export function createPromoter({
  store, consumerBinding, costModel, log = () => {}, floors = DEFAULT_FLOORS, maxPending = DEFAULT_MAX_PENDING,
  consumableFeatures = JUDGE_FACTS, commonShockDates = new Set(), priorStrength = 8,
} = {}) {
  if (!store || typeof store.patternHeads !== 'function') throw new Error('createPromoter: a learning store is required');
  if (!consumerBinding || typeof consumerBinding.featureRecipeVersion !== 'string' || !/^[a-f0-9]{64}$/.test(String(consumerBinding.policyDigest ?? ''))) throw new Error('createPromoter: consumerBinding {featureRecipeVersion, policyDigest(sha256)} is required');
  if (!costModel || !Number.isFinite(costModel.feePctPerSide) || !Number.isFinite(costModel.slippageBps)) throw new Error('createPromoter: costModel {feePctPerSide, slippageBps} is required');
  const counters = { proposed: 0, frozen: 0, captured: 0, outcomes: 0, settled: 0, published: 0, demoted: 0, failures: 0 };
  let last = null;

  function propose(nowTs, heads, episodes, outcomes) {
    let proposed = 0; let frozen = 0;
    const pendingCount = [...heads.values()].filter((p) => p.state === 'PROSPECTIVE_PENDING' || p.state === 'CANDIDATE_FROZEN').length;
    if (pendingCount >= maxPending) return { proposed, frozen, reason: 'MAX_PENDING' };
    // one live stump per cell scope: a scope that already has a frozen/pending/validated/active stump proposes nothing
    const busyScopes = new Set([...heads.values()].filter((p) => p.origin === CANDIDATE_ORIGIN && !['ACCUMULATING', 'NOTICED', 'RETIRED', 'DEGRADED'].includes(p.state)).map((p) => canonicalDigest(p.scope)));
    for (const cell of [...heads.values()].filter((p) => p.origin !== CANDIDATE_ORIGIN && p.state === 'ACCUMULATING')) {
      if (busyScopes.has(canonicalDigest(cell.scope))) continue;
      if (!floorsMet(cell.evidence, floors)) continue;
      const items = cellItems({ episodes, outcomes, scope: cell.scope, costModel });
      const stump = proposeStump(items, { features: consumableFeatures });
      if (!stump) continue;
      proposed += 1; counters.proposed += 1;
      try {
        const informative = stump.inItems.filter((i) => i.outcomeClass === 'FAVORABLE' || i.outcomeClass === 'ADVERSE');
        const pooledMean = informative.length ? informative.filter((i) => i.outcomeClass === 'FAVORABLE').length / informative.length : 0.5;
        const evidenceItems = stump.inItems.map((i) => ({ opportunityId: i.opportunityId, canonicalCoin: i.canonicalCoin, decisionTs: i.decisionTs, evidenceBasis: i.evidenceBasis, outcomeClass: i.outcomeClass }));
        // the stump's own pattern: NOTICED then ACCUMULATING (the lawful path), evidence = its in-domain matured items
        const first = nextPatternStep({ head: null, evidenceItems, pooledMean, priorStrength, nowTs, commonShockDates });
        const noticed = buildPatternRecord({ predicate: stump.predicate, scope: cell.scope, origin: CANDIDATE_ORIGIN, createdTs: nowTs, ts: nowTs, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: first.evidence, estimate: first.estimate, contradictions: first.contradictions });
        const existing = heads.get(noticed.patternId);
        if (existing && existing.state !== 'ACCUMULATING' && existing.state !== 'NOTICED') continue; // a retired/degraded stump is not re-proposed by the same clause
        if (!existing) store.appendPattern(noticed);
        const head = existing ?? noticed;
        const next = nextPatternStep({ head, evidenceItems, pooledMean, priorStrength, nowTs, commonShockDates });
        const accumulating = buildPatternRecord({ predicate: stump.predicate, scope: cell.scope, origin: CANDIDATE_ORIGIN, createdTs: head.createdTs, ts: nowTs, seq: head.seq + 1, state: 'ACCUMULATING', previousState: head.state, transitionReason: next.transitionReason, evidence: next.evidence, estimate: next.estimate, contradictions: next.contradictions });
        if (!floorsMet(accumulating.evidence, floors)) { store.appendPattern(accumulating); log(`promoter: stump for ${cell.scope.setupType} noted (${stump.predicate.clauses[0].feature} ${stump.predicate.clauses[0].op} ${stump.predicate.clauses[0].threshold}, lift ${stump.lift}) — its own evidence is below the floors; accumulating`); continue; }
        store.appendPattern(accumulating);
        const horizonMin = horizonForScope(cell.scope);
        const design = freezeCandidate({ store, pattern: store.patternHeads().get(accumulating.patternId), costModel, consumerBinding, nowTs, primaryHorizonMin: horizonMin, primaryMetric: metricForHorizon(horizonMin) });
        frozen += 1; counters.frozen += 1;
        log(`promoter: CANDIDATE FROZEN for ${cell.scope.setupType} — when ${stump.predicate.clauses[0].feature} ${stump.predicate.clauses[0].op} ${stump.predicate.clauses[0].threshold} (lift ${stump.lift} pct over ${stump.n} matured; ${stump.inItems.length} in-domain); forward test to ${design.terminalGroupTarget} groups begins now (${design.candidateId})`);
        if ([...store.patternHeads().values()].filter((p) => p.state === 'PROSPECTIVE_PENDING').length >= maxPending) break;
      } catch (err) { counters.failures += 1; log(`promoter: propose/freeze failed for ${cell.scope.setupType}: ${String(err?.message ?? err).slice(0, 160)}`); }
    }
    return { proposed, frozen };
  }

  function capture(nowTs, heads, episodes, state) {
    let captured = 0;
    for (const p of [...heads.values()].filter((x) => x.state === 'PROSPECTIVE_PENDING' && x.candidateId)) {
      const design = state.designs.get(p.candidateId); if (!design) continue;
      const caps = state.captures.get(p.candidateId) ?? new Map();
      for (const e of episodes) {
        if (e.setupType !== design.scope.setupType || e.regime !== design.scope.regime) continue;
        if (e.decisionTs < design.sealedTs || caps.has(e.opportunityId)) continue;
        const labelEndTs = e.decisionTs + design.primaryHorizonMin * 60_000;
        if (nowTs >= labelEndTs) continue; // too late to capture honestly: no prior-capture evidence, the episode is simply not part of the trial
        const verdict = evaluatePredicate(design.predicate, { features: e.features ?? {} });
        const candidateDecision = verdict === 'TRUE' ? 'SELECTED_FOR_SHADOW' : 'SKIPPED';
        const baselineDecision = isSelected(e.decision) ? 'SELECTED_FOR_SHADOW' : 'SKIPPED';
        try {
          store.appendProspective({ kind: 'CAPTURE', candidateId: p.candidateId, opportunityId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionTs: e.decisionTs, candidateDecision, baselineDecision, recordedTs: nowTs, labelEndTs });
          captured += 1; counters.captured += 1;
        } catch (err) { counters.failures += 1; log(`promoter: capture refused (${p.candidateId}): ${String(err?.message ?? err).slice(0, 160)}`); }
      }
    }
    return captured;
  }

  function outcome(nowTs, heads, outcomes, state) {
    let recorded = 0;
    for (const p of [...heads.values()].filter((x) => x.state === 'PROSPECTIVE_PENDING' && x.candidateId)) {
      const caps = state.captures.get(p.candidateId) ?? new Map(); const outs = state.outcomes.get(p.candidateId) ?? new Map();
      const design = state.designs.get(p.candidateId); if (!design) continue;
      for (const cap of caps.values()) {
        if (outs.has(cap.opportunityId)) continue;
        const o = outcomes.get(cap.opportunityId); const h = o?.outcomeRow?.horizons?.[`${design.primaryHorizonMin}m`];
        const cls = classifyOutcome(h);
        if (cls === 'NOT_YET_KNOWN' || cls === 'UNAVAILABLE') continue;
        const knownAt = Number.isSafeInteger(h?.outcomeKnownAtTs) ? Math.max(h.outcomeKnownAtTs, cap.labelEndTs) : cap.labelEndTs;
        if (nowTs < knownAt) continue;
        try {
          store.appendProspective({ kind: 'OUTCOME', candidateId: p.candidateId, opportunityId: cap.opportunityId, outcomeClass: cls, metricValue: netMetricOf(h, design.costModel), outcomeKnownAtTs: knownAt, recordedTs: nowTs });
          recorded += 1; counters.outcomes += 1;
        } catch (err) { counters.failures += 1; log(`promoter: outcome refused (${p.candidateId}): ${String(err?.message ?? err).slice(0, 160)}`); }
      }
    }
    return recorded;
  }

  function settle(nowTs, heads) {
    const results = [];
    for (const p of [...heads.values()].filter((x) => x.state === 'PROSPECTIVE_PENDING' && x.candidateId)) {
      try {
        const r = settleCandidate({ store, candidateId: p.candidateId, nowTs, commonShockDates, maxAbsAdjust: PROMOTION_POLICY.maxAbsAdjustDefault });
        if (r.note === 'TERMINAL_SAMPLE_NOT_REACHED') continue;
        counters.settled += 1;
        if (r.activation) { counters.published += 1; log(`promoter: FORWARD_SUPPORTED — ${p.scope.setupType} when ${p.predicate.clauses[0].feature} ${p.predicate.clauses[0].op} ${p.predicate.clauses[0].threshold}: activation ${r.activation.activationId} published (PUBLISHED_WAITING_FOR_PAPER; the steward adopts it)`); }
        else { counters.demoted += 1; log(`promoter: terminal ${r.terminal?.verdict ?? 'UNKNOWN'} for ${p.scope.setupType} (${(r.terminal?.reasons ?? []).join(',')}) — the stump returns to accumulation`); }
        results.push({ candidateId: p.candidateId, verdict: r.terminal?.verdict ?? null, activationId: r.activation?.activationId ?? null });
      } catch (err) { counters.failures += 1; log(`promoter: settle failed (${p.candidateId}): ${String(err?.message ?? err).slice(0, 160)}`); }
    }
    return results;
  }

  function step({ nowTs }) {
    const report = { nowTs, proposed: 0, frozen: 0, captured: 0, outcomes: 0, settled: [], authority: 'NONE' };
    try {
      const heads0 = store.patternHeads(); const episodes = store.readEpisodes(); const outcomes = store.latestOutcomes();
      const pr = propose(nowTs, heads0, episodes, outcomes); report.proposed = pr.proposed; report.frozen = pr.frozen;
      const heads = store.patternHeads();
      const state = replayProspective(store.readProspective());
      if (state.errors.length) { report.prospectiveErrors = state.errors.length; log(`promoter: prospective journal carries ${state.errors.length} invalid record(s) (skipped, never repaired)`); }
      report.captured = capture(nowTs, heads, episodes, state);
      const state2 = report.captured ? replayProspective(store.readProspective()) : state;
      report.outcomes = outcome(nowTs, heads, outcomes, state2);
      report.settled = settle(nowTs, store.patternHeads());
    } catch (err) { counters.failures += 1; report.failed = String(err?.message ?? err).slice(0, 200); }
    last = report; return report;
  }

  function status() {
    let pending = [];
    try {
      const state = replayProspective(store.readProspective());
      pending = [...store.patternHeads().values()].filter((p) => p.state === 'PROSPECTIVE_PENDING' && p.candidateId).map((p) => ({ candidateId: p.candidateId, setupType: p.scope.setupType, clause: p.predicate.clauses[0], captures: state.captures.get(p.candidateId)?.size ?? 0, outcomes: state.outcomes.get(p.candidateId)?.size ?? 0, target: state.designs.get(p.candidateId)?.terminalGroupTarget ?? null }));
    } catch { pending = []; }
    return { version: PROMOTER_VERSION, counters: { ...counters }, pending, last, policy: PROMOTION_POLICY.policyVersion, authority: 'NONE' };
  }
  return { version: PROMOTER_VERSION, step, status };
}
