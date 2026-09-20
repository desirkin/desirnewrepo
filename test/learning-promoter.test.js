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
    outcomeRow: { rowId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionKnownAtTs: e.decisionTs, availability: { state: 'AVAILABLE', reason: null }, horizons: { '5m': hz('KNOWN', { horizonEndTs: e.decisionTs + 5 * 60_000, logReturnPct, mfePct: Math.max(0, logReturnPct), maePct: Math.min(0, logReturnPct) }), '60m': hz('KNOWN', { logReturnPct, mfePct: Math.max(0, logReturnPct), maePct: Math.min(0, logReturnPct) }) } }, // PUBLISH-FIX-56: the bite horizon carries the same return in this fixture
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
    // PUBLISH-FIX-56 (review finding 2): a Judge-setup candidate is sealed on the 5-minute BITE, the horizon the trade lives on
    assert.equal(design.primaryHorizonMin, 5); assert.equal(design.primaryMetric, 'NET_LOG_RETURN_5M_PCT');
    // 2+3. forward evidence: new in-scope episodes after the seal, captured before their window closes, outcomes once matured
    let now = T0 + 3 * HOUR; let capturedTotal = 0; let outcomesTotal = 0; let settledAt = null;
    const pending = () => [...store.patternHeads().values()].some((p) => p.origin === CANDIDATE_ORIGIN && p.state === 'PROSPECTIVE_PENDING');
    // PUBLISH-FIX-83 (full review item 19): the forward test is a RANKING test — the candidate's picks against every matured look of
    // the same group — so each dependence group (one coin, one 4-hour window) carries TWO looks: one inside the stump (picked) and
    // one outside (skipped), a minute apart, exactly as a live coin offers several looks in a window
    for (let g = 0; g < 48 && pending(); g += 1) {
      const ts = T0 + 3 * HOUR + g * 5 * HOUR; const coin = COINS[g % COINS.length];
      const inside = episode({ coin, ts, rv60: 2 + (g % 3), decision: g % 2 ? 'SELECTED_FOR_PAPER' : 'SKIPPED' }); const outside = episode({ coin, ts: ts + 60_000, rv60: 1, decision: 'SKIPPED' });
      store.appendEpisode(inside); store.appendEpisode(outside);
      now = ts + 70_000; r = promoter.step({ nowTs: now }); // the tick right after the decisions captures both
      assert.equal(r.captured, 2, `group ${g}: both looks captured before their label windows close`); capturedTotal += 2;
      store.appendOutcome(outcomeAttach(inside, 2.5, ts + HOUR + 1_000)); store.appendOutcome(outcomeAttach(outside, -0.5, ts + 60_000 + HOUR + 1_000));
      now = ts + 60_000 + HOUR + 60_000; r = promoter.step({ nowTs: now }); // the tick after maturity records the outcomes; the settle look runs every tick
      assert.equal(r.outcomes, 2, `group ${g}: outcomes recorded once matured`); outcomesTotal += 2;
      if (r.settled.length) settledAt = g;
    }
    assert.ok(settledAt !== null, 'the ONE terminal look ran once the predeclared sample (30 independent groups) was reached');
    assert.ok(capturedTotal >= 60 && outcomesTotal === capturedTotal, `captures ${capturedTotal}, outcomes ${outcomesTotal}`);
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

// PUBLISH-FIX-56 (review finding 2): one horizon rule for the cell, the promoter and the rollback — the Judge's setups on
// the 5-minute BITE, the mover lessons on their hour; the metric and the horizon of a sealed design cannot disagree
test('PUBLISH-FIX-56: horizonForScope names the bite for every Judge setup and the hour for DAILY_MOVER; cellItems reads that horizon; the 5m label carries a log return', async () => {
  const { horizonForScope, horizonKeyForScope } = await import('../learning/patterns.js');
  const { cellItems, metricForHorizon } = await import('../learning/promoter.js');
  const { LOG_RETURN_HORIZONS_MIN } = await import('../learning/labels.js');
  for (const setupType of ['RANGE_IGNITION', 'ABSORPTION_RECLAIM', 'TREND_PULLBACK_CONTINUATION', 'CATALYST_TRANSMISSION', 'MOMENTUM_CONTINUATION', 'MICRO_BITE']) { assert.equal(horizonForScope({ setupType }), 5, setupType); assert.equal(horizonKeyForScope({ setupType }), '5m'); }
  assert.equal(horizonForScope({ setupType: 'DAILY_MOVER' }), 60); assert.equal(metricForHorizon(5), 'NET_LOG_RETURN_5M_PCT'); assert.equal(metricForHorizon(60), 'NET_LOG_RETURN_60M_PCT');
  assert.deepEqual([...LOG_RETURN_HORIZONS_MIN], [5, 15, 60, 240], 'the bite and the continuation carry log returns');
  // a cell item is graded on the 5m horizon: a 60m-only outcome is not (yet) an item for a Judge setup
  const e = { opportunityId: 'op', canonicalCoin: 'AAA', decisionTs: T0, evidenceBasis: 'PROSPECTIVE', setupType: 'RANGE_IGNITION', regime: 'LIVE_UNCLASSIFIED', decision: 'SKIPPED', features: {} };
  const only60 = new Map([['op', { outcomeRow: { horizons: { '60m': { state: 'KNOWN', logReturnPct: 3 } } } }]]);
  assert.equal(cellItems({ episodes: [e], outcomes: only60, scope: { setupType: 'RANGE_IGNITION', regime: 'LIVE_UNCLASSIFIED' }, costModel: { feePctPerSide: 0.8, slippageBps: 10 } }).length, 0);
  const with5 = new Map([['op', { outcomeRow: { horizons: { '5m': { state: 'KNOWN', logReturnPct: 2.5 }, '60m': { state: 'KNOWN', logReturnPct: 9 } } } }]]);
  const items = cellItems({ episodes: [e], outcomes: with5, scope: { setupType: 'RANGE_IGNITION', regime: 'LIVE_UNCLASSIFIED' }, costModel: { feePctPerSide: 0.8, slippageBps: 10 } });
  assert.equal(items.length, 1); assert.equal(items[0].metric, 2.5 - 1.6 - 0.2, 'the 5m return net of the fee and slippage both ways, not the 60m');
});

test('PUBLISH-FIX-83 item 24: the pattern journal is read into the store cache once and the heads are derived once per generation — a hundred patternHeads() calls do not re-read the file; an append refreshes the heads; a caller cannot corrupt the cache through the Map it was handed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-promoter-cache-'));
  try {
    const store = createLearningStore({ dataDir: dir, log: () => {} }); seedCell(store);
    const h1 = store.patternHeads(); assert.equal(h1.size, 1);
    for (let i = 0; i < 100; i += 1) store.patternHeads();
    const h2 = store.patternHeads(); assert.deepEqual([...h2.keys()], [...h1.keys()]); h2.clear(); assert.equal(store.patternHeads().size, 1, 'the handed-out Map is a copy');
    const head = store.patternHeads().values().next().value; const next = nextPatternStep({ head, evidenceItems: [], pooledMean: 0.5, priorStrength: 8, nowTs: T0 });
    store.appendPattern(buildPatternRecord({ predicate: head.predicate, scope: head.scope, origin: head.origin, createdTs: head.createdTs, ts: T0, seq: head.seq + 1, state: head.state, previousState: head.state, transitionReason: 'NEW_MATURED_EVIDENCE', evidence: next.evidence, estimate: next.estimate, contradictions: next.contradictions }));
    assert.equal(store.patternHeads().values().next().value.seq, head.seq + 1, 'the append refreshed the derived heads'); assert.equal(store.patternHistory(head.patternId).length, head.seq + 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
