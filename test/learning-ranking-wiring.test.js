// PUBLISH-FIX-14 (2026-09-17, independent review F5) — the production wiring, end to end over REAL parts: a promotion-
// published activation in a learning store -> the steward makes it ACTIVE_PAPER -> lib/learning-ranking-source.js (the
// source fly.js composes) reads the validated DECISION view -> the Judge's snapshot cache accepts it -> the ranking-only
// selector applies the contribution inside the activation's own bound. The baseline arm is proven the same way: with the
// kill file KILLED the same pipeline answers baseline; with the enable unset nothing is composed and the cockpit says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCandidate, settleCandidate } from '../learning/promotion.js';
import { buildPatternRecord, buildEvidence, estimateFromEvidence } from '../learning/patterns.js';
import { createLearningStore } from '../learning/store.js';
import { createLearningRankingSource } from '../lib/learning-ranking-source.js';
import { createLearningSnapshotCache } from '../judge/learning-snapshot-cache.js';
import { JUDGE_FACT_RECIPE_VERSION, resolveLearningContribution } from '../judge/learning-intake.js';
import { stewardActivations } from '../lib/learning-activation-steward.js';
import { learnedSelectionState } from '../lib/learned-selection-state.js';

const T0 = Date.now() - 50 * 86_400_000; // settled 10 days ago: the 30-day activation is effective NOW
const HOUR = 3_600_000; const DAY = 86_400_000;
const BINDING = Object.freeze({ featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyDigest: 'a'.repeat(64) });
const predicate = { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 3 }] };
const scope = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED' };

function publishedStore(dataDir) {
  const store = createLearningStore({ dataDir });
  const items = Array.from({ length: 8 }, (_, i) => ({ opportunityId: `lop-h${i}`, canonicalCoin: `A${i % 5}A`, decisionTs: T0 - 20 * DAY + i * DAY, evidenceBasis: 'HISTORICAL_RECONSTRUCTION', outcomeClass: i % 4 === 3 ? 'ADVERSE' : 'FAVORABLE' }));
  const evidence = buildEvidence(items); const estimate = estimateFromEvidence(items, evidence, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 - DAY }); const pe = { ...evidence, _grouping: null };
  store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 20 * DAY, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: pe, estimate, contradictions: [] }));
  store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 10 * DAY, seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE', evidence: pe, estimate, contradictions: [] }));
  const pattern = store.patternHeads().values().next().value;
  const design = freezeCandidate({ store, pattern, costModel: { feePctPerSide: 0.8, slippageBps: 10 }, consumerBinding: BINDING, nowTs: T0 });
  for (let g = 0; g < 34; g += 1) {
    const decisionTs = design.sealedTs + HOUR + (g % 8) * DAY + Math.floor(g / 8) * 5 * HOUR; const id = `lop-forward-${g}`; const labelEndTs = decisionTs + HOUR;
    store.appendProspective({ kind: 'CAPTURE', candidateId: design.candidateId, opportunityId: id, canonicalCoin: `A${g % 6}A`, decisionTs, candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED', recordedTs: decisionTs + 1_000, labelEndTs });
    store.appendProspective({ kind: 'OUTCOME', candidateId: design.candidateId, opportunityId: id, outcomeClass: 'FAVORABLE', metricValue: 1.5, outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1_000 });
  }
  const settledTs = T0 + 40 * DAY;
  const result = settleCandidate({ store, candidateId: design.candidateId, nowTs: settledTs });
  assert.equal(result.note, 'PUBLISHED_WAITING_FOR_PAPER');
  return { store, activation: result.activation, settledTs };
}

const facts = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED', asset: 'AAA', venue: 'KRAKEN', featureRecipeVersion: BINDING.featureRecipeVersion, policyVersion: BINDING.policyDigest, features: { relVolume60m: { value: 4, availability: 'KNOWN', ageMs: 0 } } };

test('F5 wiring: store -> steward -> ranking source -> Judge snapshot cache -> ranking contribution applied; the kill file is the baseline arm; the enable is the off switch', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cobra-learn-wiring-'));
  try {
    const { store, activation, settledTs } = publishedStore(dataDir);
    const activated = stewardActivations({ store, nowTs: settledTs + 1 });
    assert.deepEqual(activated.activated.map((a) => a.activationId), [activation.activationId]);

    const ranking = createLearningRankingSource({ dataDir }); // the exact source fly.js composes
    const cache = createLearningSnapshotCache({ source: ranking.source });
    const refreshed = await cache.refresh();
    assert.equal(refreshed.state, 'READY', `snapshot cache refused: ${JSON.stringify(cache.status())}`);
    const snapshot = cache.read();
    assert.ok(snapshot, 'admission reads an immutable snapshot'); assert.equal(Object.isFrozen(snapshot), true);
    // PUBLISH-FIX-30: the Judge's cache runs on the venue-anchored permission clock, which can trail the local wall clock;
    // the source prepares the snapshot on the CALLER'S clock, so a wall clock 5 s ahead of the permission clock is still READY
    const behind = createLearningSnapshotCache({ source: ranking.source, clock: () => Date.now() - 5_000 });
    const behindRefresh = await behind.refresh(); assert.equal(behindRefresh.state, 'READY', `a permission clock behind the wall clock must not make the snapshot "invalid or stale": ${JSON.stringify(behind.status())}`);
    assert.ok(behind.read(), 'readable on the caller\'s clock'); assert.equal(behind.read().preparedTs <= Date.now() - 5_000 + 50, true, 'preparedTs is the caller\'s clock, not the wall clock');
    assert.equal(snapshot.view, 'DECISION'); assert.deepEqual(snapshot.withheld, []);
    assert.equal(snapshot.activations.length, 1); assert.equal(snapshot.activations[0].state, 'ACTIVE_PAPER');
    const nowTs = Date.now();
    const r = resolveLearningContribution({ snapshot, facts, mode: 'PAPER', nowTs });
    assert.equal(r.applied, true, `not applied: ${JSON.stringify({ reason: r.reason, rejected: r.rejected })}`);
    assert.equal(r.selected.activationId, activation.activationId);
    assert.ok(r.adjust !== 0 && Math.abs(r.adjust) <= r.selected.maxAbsAdjust + 1e-12 && r.selected.maxAbsAdjust === activation.allowedEffect.maxAbsAdjust, `the nudge (${r.adjust}) stays inside the activation bound`);
    assert.equal(ranking.status().reads, 2, 'two cache refreshes read the source twice'); assert.equal(ranking.status().lastActivations, 1);
    assert.equal(learnedSelectionState(store, { env: { SERPENT_LEARNING_RANKING: 'true' }, run: { kind: 'PAPER', learningSnapshotStatus: () => cache.status() } }).startsWith('ON_RANKING_ONLY (snapshot prepared'), true);
    cache.dispose();

    // BASELINE ARM: the operator kill file — the same pipeline, every decision answers baseline
    store.writeKill({ state: 'KILLED', reason: 'CLI_KILL', ts: nowTs });
    const killedCache = createLearningSnapshotCache({ source: ranking.source });
    assert.equal((await killedCache.refresh()).state, 'READY');
    const killed = resolveLearningContribution({ snapshot: killedCache.read(), facts, mode: 'PAPER', nowTs: Date.now() });
    assert.equal(killed.applied, false); assert.match(String(killed.reason), /KILL/);
    assert.match(learnedSelectionState(store, { env: { SERPENT_LEARNING_RANKING: 'true' }, run: { kind: 'PAPER', learningSnapshotStatus: () => killedCache.status() } }), /BASELINE_ARM .*KILLED/);
    killedCache.dispose();

    // a fault in the store answers "no snapshot" (baseline), never a partial view
    const faulty = createLearningSnapshotCache({ source: async () => { throw new Error('journals unreadable'); } });
    assert.equal((await faulty.refresh()).state, 'REFUSED'); assert.equal(faulty.read(), null); faulty.dispose();

    // OFF SWITCH: the enable unset => no source is composed, the cockpit says so
    assert.equal(learnedSelectionState(store, { env: {}, run: { kind: 'PAPER' } }), 'OFF_NOT_ENABLED');
    assert.equal(learnedSelectionState(store, { env: { SERPENT_LEARNING_RANKING: 'true' }, run: null }), 'OFF_NO_PAPER_JUDGE');
    assert.equal(learnedSelectionState(store, { env: { SERPENT_LEARNING_RANKING: 'true' }, run: { kind: 'PAPER', learningSnapshotStatus: () => null } }), 'OFF_NOT_WIRED');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
