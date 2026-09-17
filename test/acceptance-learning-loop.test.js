// ACCEPTANCE (David, 2026-09-17): ONE automated end-to-end proof that a REJECTED / observed opportunity can mature into
// a learning record, accumulate sufficient evidence, be safely promoted and activated, ALTER a later PAPER decision, and
// then automatically ROLL BACK when its forward performance deteriorates. Every step runs the production modules through
// the production seams (learning/service.js with the Judge decision bridge and the promoter as fly.js composes them, the
// steward fly.js runs every 60 s, the memory view lib/learning-ranking-source.js reads, and judge/learning-intake.js
// resolveLearningContribution — the exact selector judge.js calls at decision time). The only synthetic parts are the
// Judge's decisions (a ring of ENTRY_REFUSED records with the six LEARNED_FACT rows, as the Judge records them) and the
// tape outcomes (attached as learning/maturation.js attaches them, with a known 60m log return); everything between is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLearning } from '../learning/service.js';
import { createJudgeDecisionBridge } from '../learning/judge-decision-bridge.js';
import { createPromoter, CANDIDATE_ORIGIN } from '../learning/promoter.js';
import { readDecisionMemory } from '../learning/memory-view.js';
import { stewardActivations, forwardWindowsOf } from '../lib/learning-activation-steward.js';
import { JUDGE_FACT_RECIPE_VERSION, resolveLearningContribution, contributionMeasurement } from '../judge/learning-intake.js';
import { LEARNING_VERSION } from '../learning/contracts.js';

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const HOUR = 3_600_000; const DAY = 86_400_000;
const POLICY_DIGEST = 'c'.repeat(64); // the Judge's policy digest: the promoter binds to it, the Judge's facts carry it
const POLICY_VERSION = `judge-policy-${POLICY_DIGEST.slice(0, 16)}`; // fly.js's bridge policyVersion law
const COINS = ['BTC', 'ETH', 'SOL', 'ADA', 'LINK', 'DOT', 'AVAX', 'XRP', 'DOGE', 'NEAR', 'ARB', 'HYPE'];
const SETUP = 'MOMENTUM_IGNITION';
const COST = { feePctPerSide: 0.8, slippageBps: 10 };

// the six prepared facts exactly as the Judge records them on a decision (PUBLISH-FIX-38 LEARNED_FACT rows)
const factRows = (rv60) => [
  { id: 'LEARNED_FACT', ok: true, value: rv60, threshold: null, unit: 'ratio', note: 'rv60' },
  { id: 'LEARNED_FACT', ok: true, value: 0.4, threshold: null, unit: 'fraction', note: 'fi15' },
  { id: 'LEARNED_FACT', ok: true, value: 0.3, threshold: null, unit: 'fraction', note: 'fi60' },
  { id: 'LEARNED_FACT', ok: true, value: 3, threshold: null, unit: 'bps', note: 'spreadBps' },
  { id: 'LEARNED_FACT', ok: true, value: 20_000, threshold: null, unit: 'usd_notional', note: 'depthUsd10bps' },
  { id: 'LEARNED_FACT', ok: true, value: 1, threshold: null, unit: 'pct_of_mid', note: 'atrPct' },
];
// a REJECTED Judge decision (ENTRY_REFUSED at the after-cost gate) — the snake watched and did not bite
let seq = 0;
const refused = ({ coin, ts, rv60 }) => ({
  decisionId: `dec-${(seq += 1)}`, asset: { canonicalCoin: coin, venue: 'kraken', pair: `${coin}/USD` }, setupId: SETUP,
  status: 'ENTRY_REFUSED', reasonCodes: ['AFTER_COST_EDGE_INSUFFICIENT'], decisionKnownAtTs: ts,
  measurements: [{ id: 'RV60_GTE', ok: rv60 >= 2, value: rv60, threshold: 2, unit: 'ratio', note: null }, ...factRows(rv60)],
  valuationRef: null,
});
// the tape's verdict an hour later, attached as maturation attaches it (KNOWN 60m horizon)
const outcomeAttach = (e, logReturnPct, knownAt) => ({
  learningVersion: LEARNING_VERSION, opportunityId: e.opportunityId, labelRecipeVersion: 'learning-candle-labels-1',
  outcomeRow: { rowId: e.opportunityId, canonicalCoin: e.canonicalCoin, decisionKnownAtTs: e.decisionTs, availability: { state: 'AVAILABLE', reason: null }, horizons: { '60m': { state: 'KNOWN', reason: 'COMPLETE', horizonEndTs: e.decisionTs + HOUR, outcomeKnownAtTs: knownAt, mfePct: Math.max(0, logReturnPct), maePct: Math.min(0, logReturnPct), logReturnPct } } },
  counterfactual: null, attachedTs: knownAt, supersedes: null, authority: 'NONE', purpose: 'RESEARCH_ONLY',
});
// the Judge's prepared facts for a LATER decision (judge.js:314 builds exactly this object for the selector)
const preparedFacts = (rv60, coin = 'BTC') => ({
  setupType: SETUP, regime: 'LIVE_UNCLASSIFIED', asset: coin, venue: 'kraken', featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyVersion: POLICY_DIGEST,
  features: Object.fromEntries([['rv60', rv60, 'ratio'], ['fi15', 0.4, 'fraction'], ['fi60', 0.3, 'fraction'], ['spreadBps', 3, 'bps'], ['depthUsd10bps', 20_000, 'usd_notional'], ['atrPct', 1, 'pct_of_mid']].map(([k, v, u]) => [k, { value: v, unit: u, lookbackMs: 0, ageMs: 0, availability: 'KNOWN' }])),
});

test('ACCEPTANCE: rejected opportunities -> learning records -> evidence -> promotion -> activation -> a later PAPER decision changes -> automatic rollback on forward deterioration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-acceptance-'));
  try {
    const log = []; let now = T0; const ring = [];
    // ---- the production composition (fly.js): the service with the Judge decision bridge and the promoter as ports ----
    const svc = startLearning({
      dataDir: dir, env: { LEARNING_ENABLED: 'true' }, clock: () => now, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
      populationSource: null, archiveSource: null, log: (l) => log.push(l),
      decisionBridge: (store) => createJudgeDecisionBridge({ store, decisionsSource: () => ring.slice(-256), policyVersion: POLICY_VERSION, log: (l) => log.push(l) }),
      promoter: (store) => createPromoter({ store, consumerBinding: { featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyDigest: POLICY_DIGEST }, costModel: COST, log: (l) => log.push(l) }),
    });
    const store = svc.store;
    const outcomes = new Map(); // opportunityId -> the tape's verdict, attached once the hour has passed
    const judgeDecides = ({ coin, ts, rv60 }) => { const d = refused({ coin, ts, rv60 }); ring.push(d); return d; };
    const tapeGrades = () => { for (const e of store.readEpisodes()) { if (outcomes.has(e.opportunityId) || now < e.decisionTs + HOUR + 1_000) continue; const rv = e.features.rv60.value; const ret = rv >= 2 ? 2.5 : -0.5; store.appendOutcome(outcomeAttach(e, ret, e.decisionTs + HOUR + 1_000)); outcomes.set(e.opportunityId, ret); } };

    // ---- 1. observed & rejected opportunities become learning records; the tape grades them an hour later ----------
    // 20 days, 12 coins, one decision every 5 hours; rv60 cycles 1..4 — when rv60 >= 2 the coin paid +2.5% an hour later
    let i = 0;
    for (; i < 96; i += 1) {
      now = T0 + i * 5 * HOUR; judgeDecides({ coin: COINS[i % COINS.length], ts: now, rv60: 1 + (i % 4) });
      svc.tick(); now += HOUR + 2_000; tapeGrades(); svc.tick();
    }
    const episodes = store.readEpisodes().filter((e) => e.setupType === SETUP);
    assert.equal(episodes.length, 96, 'every rejected decision became a LEARN-1 episode through the bridge');
    assert.ok(episodes.every((e) => e.decision === 'SKIPPED' && e.rejection?.reasonCode === 'AFTER_COST_EDGE_INSUFFICIENT'), 'the record keeps that the Judge refused, and why');
    assert.equal(store.latestOutcomes().size, 96, 'every episode carries its matured outcome');

    // ---- 2. evidence accumulates into the cell (PUBLISH-FIX-41: refusals count) and the promoter proposes + freezes ----
    const heads = () => [...store.patternHeads().values()];
    const cell = heads().find((p) => p.origin === 'LIVE_DESCRIPTIVE_CELL' && p.scope.setupType === SETUP);
    assert.ok(cell && cell.evidence.rawCount >= 90, `the cell holds the graded refusals: ${cell && cell.evidence.rawCount}`);
    const stump = heads().find((p) => p.origin === CANDIDATE_ORIGIN);
    assert.ok(stump, `the promoter proposed a candidate from the cell (log: ${log.filter((l) => /PROMOTER|promoter/.test(l)).slice(-3).join(' | ')})`);
    assert.equal(stump.predicate.clauses[0].feature, 'rv60'); assert.equal(stump.predicate.clauses[0].op, 'GTE');
    assert.ok(['PROSPECTIVE_PENDING', 'VALIDATED_PAPER'].includes(stump.state), `frozen for the forward test: ${stump.state} :: ${log.filter((l) => /settle|demot|FORWARD|publish|frozen|propos/i.test(l)).join(' | ')}`);

    // ---- 3. the forward test on NEW decisions the candidate never saw; the ONE terminal look; publish ---------------
    for (let g = 0; g < 60 && !heads().some((p) => p.origin === CANDIDATE_ORIGIN && ['VALIDATED_PAPER', 'ACCUMULATING', 'RETIRED'].includes(p.state)); g += 1, i += 1) {
      now = T0 + i * 5 * HOUR; judgeDecides({ coin: COINS[i % COINS.length], ts: now, rv60: 1 + (i % 4) });
      svc.tick(); now += HOUR + 2_000; tapeGrades(); svc.tick();
    }
    const validated = heads().find((p) => p.origin === CANDIDATE_ORIGIN);
    assert.equal(validated.state, 'VALIDATED_PAPER', `the forward evidence supports the when (${log.filter((l) => /FORWARD|settled|demoted/.test(l)).slice(-2).join(' | ')})`);
    let acts = [...store.activationHeads().values()];
    assert.equal(acts.length, 1); assert.equal(acts[0].state, 'PUBLISHED_WAITING_FOR_PAPER');
    assert.equal(acts[0].policyVersion, POLICY_DIGEST, 'bound to THIS Judge\'s policy'); assert.equal(acts[0].featureRecipeVersion, JUDGE_FACT_RECIPE_VERSION);

    // ---- 4. the steward (fly.js, every 60 s) adopts it; the Judge's memory view now holds one ACTIVE candidate ----------
    now += 60_000;
    const adopted = stewardActivations({ store, nowTs: now, paperActive: true, log: (l) => log.push(l) });
    assert.equal(adopted.activated.length, 1, JSON.stringify(adopted));
    let view = readDecisionMemory({ store, nowTs: now });
    assert.equal(view.activations.length, 1); assert.equal(view.withheld.length, 0); assert.equal(view.kill.state, 'ARMED');
    const activation = view.activations[0];
    assert.equal(activation.scope.setupType, SETUP); assert.deepEqual(activation.applicability, validated.predicate);

    // ---- 5. a LATER PAPER decision changes: the selector the Judge calls (judge.js:314) applies a nonzero rank nudge ----
    //         inside the learned domain and answers baseline outside it and before the activation existed
    const snapshot = { ...view, preparedTs: now };
    const inDomain = resolveLearningContribution({ snapshot, facts: preparedFacts(3), mode: 'PAPER', nowTs: now + 1 });
    assert.equal(inDomain.applied, true, JSON.stringify(inDomain)); assert.equal(inDomain.disposition, 'DECISION_ELIGIBLE');
    assert.notEqual(inDomain.adjust, 0); assert.equal(inDomain.selected.activationId, activation.activationId);
    assert.ok(Math.abs(inDomain.adjust) <= inDomain.selected.maxAbsAdjust, 'bounded by the activation\'s own ceiling');
    const outOfDomain = resolveLearningContribution({ snapshot, facts: preparedFacts(1), mode: 'PAPER', nowTs: now + 1 });
    assert.equal(outOfDomain.applied, false); assert.equal(outOfDomain.rejected[0].reason, 'APPLICABILITY_FALSE');
    const rowIn = contributionMeasurement(inDomain); assert.equal(rowIn.id, 'LEARNED_RANK_ADJUSTMENT'); assert.equal(rowIn.value, inDomain.adjust); assert.equal(rowIn.ok, true);
    assert.equal(resolveLearningContribution({ snapshot, facts: preparedFacts(3), mode: 'OBSERVE', nowTs: now + 1 }).applied, false, 'never applied outside PAPER');
    assert.equal(resolveLearningContribution({ snapshot: { ...snapshot, kill: { state: 'KILLED', reason: 'owner', ts: now } }, facts: preparedFacts(3), mode: 'PAPER', nowTs: now + 1 }).reason, 'LEARNED_INFLUENCE_KILLED', 'the off switch wins');

    // ---- 6. forward performance deteriorates: in-domain decisions after activation now LOSE; the predeclared rule ----
    //         (10 groups per window, > 70% adverse, 2 consecutive windows) fires and the steward ROLLS BACK automatically
    const rule = activation.degradeRule; assert.deepEqual(rule, { minGroups: 10, adverseFractionAbove: 0.7, consecutiveWindows: 2 });
    const badStart = i; let rolledAt = null; let lastWindows = null;
    for (let k = 0; k < 64 && rolledAt === null; k += 1, i += 1) {
      now = T0 + i * 5 * HOUR; const d = judgeDecides({ coin: COINS[i % COINS.length], ts: now, rv60: 3 }); // inside the learned domain
      svc.tick();
      const e = store.readEpisodes().find((x) => x.decisionTs === d.decisionKnownAtTs && x.canonicalCoin === d.asset.canonicalCoin);
      assert.ok(e, 'the post-activation decision became an episode');
      now += HOUR + 2_000; store.appendOutcome(outcomeAttach(e, -1.5, e.decisionTs + HOUR + 1_000)); outcomes.set(e.opportunityId, -1.5); // the tape says: it lost
      svc.tick();
      lastWindows = forwardWindowsOf({ store, activation }).windows;
      const pass = stewardActivations({ store, nowTs: now, paperActive: true, log: (l) => log.push(l) });
      if (pass.rolledBack.length) rolledAt = k + 1;
    }
    assert.ok(rolledAt !== null, `the rule fired (${JSON.stringify(lastWindows?.slice(-2))})`);
    assert.ok(rolledAt >= 20, `never on a handful of losses: it took ${rolledAt} losing in-domain decisions (two full windows of ${rule.minGroups} independent groups)`);
    const lastTwo = lastWindows.slice(-2); assert.ok(lastTwo.every((w) => w.groups >= rule.minGroups && w.adverseGroups / w.groups > rule.adverseFractionAbove), JSON.stringify(lastTwo));
    acts = [...store.activationHeads().values()];
    assert.equal(acts[0].state, 'ROLLED_BACK'); assert.equal(acts[0].transitionReason, 'PREDECLARED_DEGRADATION_RULE_MET');
    assert.equal(heads().find((p) => p.origin === CANDIDATE_ORIGIN).state, 'DEGRADED', 'the pattern is marked, history kept');
    view = readDecisionMemory({ store, nowTs: now + 1 });
    assert.equal(view.activations[0].state, 'ROLLED_BACK', 'the memory view carries the rolled-back head (history, not authority)');
    const afterRollback = resolveLearningContribution({ snapshot: { ...view, preparedTs: now + 1 }, facts: preparedFacts(3), mode: 'PAPER', nowTs: now + 2 });
    assert.equal(afterRollback.applied, false); assert.equal(afterRollback.reason, 'NO_MATCHING_VALIDATED_CANDIDATE');
    assert.equal(afterRollback.rejected[0].reason, 'NOT_ACTIVE:ROLLED_BACK', 'the selector the Judge calls refuses it by name');
    assert.equal(afterRollback.adjust, 0, 'the later decision is baseline again');
    assert.ok(log.some((l) => /ROLLED BACK/.test(l)), 'the rollback is named in the log');
    // a second steward pass changes nothing: ROLLED_BACK is terminal
    assert.deepEqual(stewardActivations({ store, nowTs: now + 120_000, paperActive: true }).rolledBack, []);
    assert.equal([...store.activationHeads().values()][0].state, 'ROLLED_BACK');
    svc.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
