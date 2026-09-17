// PUBLISH-FIX-39 (2026-09-17): the promoter — the runtime owner of LEARN-1's promotion law. Propose a one-clause
// "when" from a cell's matured evidence, freeze it, capture new in-scope episodes before their label window closes,
// record their outcomes once matured, settle the ONE terminal look, publish on FORWARD_SUPPORTED. Authority NONE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPromoter, proposeStump, netMetricOf, cellItems, CANDIDATE_ORIGIN } from '../learning/promoter.js';
import { createLearningStore } from '../learning/store.js';
import { buildEpisode } from '../learning/capture.js';
import { nextPatternStep, buildPatternRecord } from '../learning/patterns.js';
import { replayProspective } from '../learning/prospective.js';
import { LEARNING_VERSION, canonicalDigest } from '../learning/contracts.js';
import { readDecisionMemory } from '../learning/memory-view.js';
import { stewardActivations } from '../lib/learning-activation-steward.js';

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 3_600_000; const DAY = 86_400_000;
const BINDING = { featureRecipeVersion: 'judge-prepared-market-features-1', policyDigest: 'b'.repeat(64) };
const COST = { feePctPerSide: 0.8, slippageBps: 10 };
const SCOPE = { setupType: 'MOMENTUM_IGNITION', regime: 'LIVE_UNCLASSIFIED' };
const COINS = ['BTC', 'ETH', 'SOL', 'ADA', 'LINK', 'DOT', 'AVAX', 'XRP'];

const feat = (v) => (Number.isFinite(v) ? { value: v, unit: 'ratio', lookbackMs: 0, availability: 'KNOWN' } : { value: null, unit: 'ratio', lookbackMs: 0, availability: 'UNAVAILABLE' });
function episode({ coin, ts, rv60, decision = 'SELECTED_FOR_PAPER' }) {
  return buildEpisode({
    canonicalCoin: coin, decisionTs: ts, usableAtTs: ts, datasetId: 'live-judge-paper:MOMENTUM_IGNITION',
    mode: 'PROSPECTIVE_SHADOW', evidenceBasis: 'PROSPECTIVE', fidelity: 'PROSPECTIVE_SHADOW',
    featureSet: { features: { rv60: feat(rv60), fi15: feat(0.5), fi60: feat(null), spreadBps: feat(3), depthUsd10bps: feat(20_000), atrPct: feat(1) } },
    gates: [], decision, rejection: decision === 'SKIPPED' ? { reasonCode: 'X', observedValue: null, threshold: null, class: 'HARD' } : null,
    setupType: SCOPE.setupType, regime: SCOPE.regime, baselineRuleVersion: 'judge-policy-test', membershipAtDecision: 'CURRENT_CATALOG_MEMBER',
  });
}
// an outcome attachment whose 60m horizon is KNOWN with the given log return
function outcomeAttach(e, logReturnPct, knownAt) {
  const hz = (state, extra = {}) => ({ state, reason: state === 'KNOWN' ? 'COMPLETE' : 'NOT_YET_KNOWN_AT_AS_OF', horizonEndTs: e.decisionTs + HOUR, outcomeKnownAtTs: knownAt, mfePct: null, maePct: null, logReturnPct: null, ...extra });
  return {
    learningVersion: LEARNING_VERSION, opportunityId: e.opportunityId, labelRecipeVersion: 'learning-candle-labels-1',
    outcomeRow: { rowId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionKnownAtTs: e.decisionTs, availability: { state: 'AVAILABLE', reason: null }, horizons: { '60m': hz('KNOWN', { logReturnPct, mfePct: Math.max(0, logReturnPct), maePct: Math.min(0, logReturnPct) }) } },
    counterfactual: null, attachedTs: knownAt, supersedes: null, authority: 'NONE', purpose: 'RESEARCH_ONLY',
  };
}
// a cell: n matured episodes over 10 days and 8 coins; rv60 >= 2 pays +2.5%, below pays -0.5% (a real "when")
function seedCell(store, { n = 80, startTs = T0 - 20 * DAY } = {}) {
  const eps = [];
  for (let i = 0; i < n; i += 1) {
    const ts = startTs + i * 5 * HOUR; const rv60 = 1 + (i % 4); // 1,2,3,4 — a strictly increasing clock, one group per item
    const e = episode({ coin: COINS[i % COINS.length], ts, rv60, decision: i % 3 === 0 ? 'SKIPPED' : 'SELECTED_FOR_PAPER' });
    store.appendEpisode(e); store.appendOutcome(outcomeAttach(e, rv60 >= 2 ? 2.5 : -0.5, ts + HOUR + 1_000)); eps.push(e);
  }
  // the descriptive cell record (what learning/service.js learnTick writes)
  const items = eps.map((e) => ({ opportunityId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionTs: e.decisionTs, evidenceBasis: 'PROSPECTIVE', outcomeClass: 'FAVORABLE' }));
  const predicate = { clauses: [], descriptor: 'SELECTED_MOMENTUM_IGNITION' };
  const s0 = nextPatternStep({ head: null, evidenceItems: items, pooledMean: 0.5, priorStrength: 8, nowTs: T0 - DAY });
  const noticed = buildPatternRecord({ predicate, scope: SCOPE, origin: 'LIVE_DESCRIPTIVE_CELL', createdTs: T0 - DAY, ts: T0 - DAY, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: s0.evidence, estimate: s0.estimate, contradictions: s0.contradictions });
  store.appendPattern(noticed);
  const s1 = nextPatternStep({ head: noticed, evidenceItems: items, pooledMean: 0.5, priorStrength: 8, nowTs: T0 });
  store.appendPattern(buildPatternRecord({ predicate, scope: SCOPE, origin: 'LIVE_DESCRIPTIVE_CELL', createdTs: T0 - DAY, ts: T0, seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', transitionReason: s1.transitionReason, evidence: s1.evidence, estimate: s1.estimate, contradictions: s1.contradictions }));
  return eps;
}

test('the net metric and the stump: costs are charged both ways; the best one-clause "when" is found; too little lift or coverage proposes nothing', () => {
  assert.equal(netMetricOf({ state: 'KNOWN', logReturnPct: 3 }, COST), 3 - 1.6 - 0.2);
  assert.equal(netMetricOf({ state: 'CENSORED' }, COST), null);
  const mk = (rv, m) => ({ opportunityId: `o${rv}${m}`, features: { rv60: feat(rv) }, metric: m, outcomeClass: m > 0 ? 'FAVORABLE' : 'ADVERSE', canonicalCoin: 'BTC', decisionTs: T0, evidenceBasis: 'PROSPECTIVE' });
  const items = []; for (let i = 0; i < 40; i += 1) items.push(mk(1 + (i % 4), (i % 4) >= 1 ? 0.7 : -1.3));
  const stump = proposeStump(items);
  assert.ok(stump, 'a stump is found'); assert.equal(stump.predicate.clauses.length, 1); assert.equal(stump.predicate.clauses[0].feature, 'rv60');
  assert.equal(stump.predicate.clauses[0].op, 'GTE'); assert.ok(stump.lift > 0);
  assert.equal(proposeStump(items.map((i) => ({ ...i, metric: 0.5 }))), null, 'no lift, no stump');
  assert.equal(proposeStump(items.map((i) => ({ ...i, features: { rv60: feat(null) } }))), null, 'a fact nobody had is not a when');
});

test('end to end: propose -> freeze -> capture new episodes -> outcomes -> the terminal look -> a published activation the steward adopts and the Judge\'s memory view accepts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-promoter-'));
  try {
    const store = createLearningStore({ dataDir: dir, log: () => {} });
    seedCell(store);
    const log = [];
    const promoter = createPromoter({ store, consumerBinding: BINDING, costModel: COST, log: (l) => log.push(l) });
    // 1. propose + freeze
    let r = promoter.step({ nowTs: T0 + HOUR });
    assert.equal(r.proposed, 1); assert.equal(r.frozen, 1, log.join('\n'));
    const heads = [...store.patternHeads().values()];
    const stump = heads.find((p) => p.origin === CANDIDATE_ORIGIN);
    assert.ok(stump && stump.state === 'PROSPECTIVE_PENDING' && stump.candidateId, 'the stump is frozen and pending');
    assert.deepEqual(Object.keys(stump.predicate), ['clauses']); assert.equal(stump.predicate.clauses[0].feature, 'rv60');
    assert.equal(heads.find((p) => p.origin === 'LIVE_DESCRIPTIVE_CELL').state, 'ACCUMULATING', 'the cell stays descriptive');
    assert.equal(promoter.step({ nowTs: T0 + 2 * HOUR }).proposed, 0, 'one live stump per scope');
    const design = replayProspective(store.readProspective()).designs.get(stump.candidateId);
    assert.equal(design.consumerBinding.policyDigest, BINDING.policyDigest); assert.equal(design.costModel.feePctPerSide, 0.8);
    // 2+3. forward evidence: new in-scope episodes after the seal, captured before their window closes, outcomes once matured
    let now = T0 + 3 * HOUR; let capturedTotal = 0; let outcomesTotal = 0; let settledAt = null;
    const pending = () => [...store.patternHeads().values()].some((p) => p.origin === CANDIDATE_ORIGIN && p.state === 'PROSPECTIVE_PENDING');
    for (let g = 0; g < 48 && pending(); g += 1) {
      const ts = T0 + 3 * HOUR + g * 5 * HOUR; const rv60 = 1 + (g % 4);
      const e = episode({ coin: COINS[g % COINS.length], ts, rv60, decision: g % 2 ? 'SELECTED_FOR_PAPER' : 'SKIPPED' });
      store.appendEpisode(e);
      now = ts + 10_000; r = promoter.step({ nowTs: now }); // the tick right after the decision captures it
      assert.equal(r.captured, 1, `episode ${g} captured before its label window closes`); capturedTotal += 1;
      store.appendOutcome(outcomeAttach(e, rv60 >= 2 ? 2.5 : -0.5, ts + HOUR + 1_000));
      now = ts + HOUR + 60_000; r = promoter.step({ nowTs: now }); // the tick after maturity records the outcome; the settle look runs every tick
      assert.equal(r.outcomes, 1, `episode ${g} outcome recorded once matured`); outcomesTotal += 1;
      if (r.settled.length) settledAt = g;
    }
    assert.ok(settledAt !== null, 'the ONE terminal look ran once the predeclared sample (30 independent groups) was reached');
    assert.ok(capturedTotal >= 30 && outcomesTotal === capturedTotal, `captures ${capturedTotal}, outcomes ${outcomesTotal}`);
    const state = replayProspective(store.readProspective());
    assert.equal(state.errors.length, 0, state.errors.join('\n'));
    assert.equal(state.captures.get(stump.candidateId).size, capturedTotal);
    assert.equal(state.terminals.size, 1, 'exactly one terminal record');
    const late = episode({ coin: 'BTC', ts: T0 + 4 * HOUR, rv60: 3 }); store.appendEpisode(late);
    r = promoter.step({ nowTs: now + 1 }); assert.equal(r.captured, 0, 'after the terminal, and for a window already closed, nothing is captured after the fact');
    const st = promoter.status();
    assert.equal(st.counters.settled, 1);
    const after = [...store.patternHeads().values()].find((p) => p.origin === CANDIDATE_ORIGIN);
    assert.equal(after.state, 'VALIDATED_PAPER', `the forward test supports the when (log: ${log.slice(-3).join(' | ')})`);
    {
      assert.equal(st.counters.published, 1);
      const acts = [...store.activationHeads().values()]; assert.equal(acts.length, 1); assert.equal(acts[0].state, 'PUBLISHED_WAITING_FOR_PAPER');
      // the steward (fix14) adopts it; the Judge's memory view then holds ONE active candidate scoped to the setup
      const out = stewardActivations({ store, nowTs: now + 5 * DAY + 60_000, paperActive: true });
      assert.equal(out.activated.length, 1);
      const view = readDecisionMemory({ store, nowTs: now + 5 * DAY + 120_000 });
      assert.equal(view.activations.length, 1); assert.equal(view.activations[0].scope.setupType, 'MOMENTUM_IGNITION');
      assert.deepEqual(view.activations[0].applicability, stump.predicate);
    }
    assert.ok(st.counters.failures === 0, `no contained failures: ${log.filter((l) => /failed|refused/.test(l)).join('\n')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cell below the floors, or with no consumable fact, proposes nothing; failures are contained and counted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-promoter-floors-'));
  try {
    const store = createLearningStore({ dataDir: dir, log: () => {} });
    seedCell(store, { n: 16 }); // 16 items: 2 dates, 8 coins -> floors (30 groups / 7 dates) not met
    const promoter = createPromoter({ store, consumerBinding: BINDING, costModel: COST });
    const r = promoter.step({ nowTs: T0 + HOUR });
    assert.equal(r.proposed, 0); assert.equal(r.frozen, 0);
    assert.equal([...store.patternHeads().values()].filter((p) => p.origin === CANDIDATE_ORIGIN).length, 0);
    assert.throws(() => createPromoter({ store, consumerBinding: { featureRecipeVersion: 'x', policyDigest: 'nope' }, costModel: COST }), /consumerBinding/);
    assert.equal(cellItems({ episodes: store.readEpisodes(), outcomes: store.latestOutcomes(), scope: SCOPE, costModel: COST }).length, 16);
    assert.equal(canonicalDigest(SCOPE).length, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
