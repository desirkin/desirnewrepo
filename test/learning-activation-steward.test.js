// PUBLISH-FIX-14 (2026-09-17, independent review F5) — the activation steward is the ONE runtime act that takes a
// promotion-published activation from PUBLISHED_WAITING_FOR_PAPER to ACTIVE_PAPER (and, later, to EXPIRED). The
// fixture is the real promotion path (freeze -> forward evidence -> settle), so the record the steward advances is
// exactly the record the memory view then admits and the Judge's ranking-only selector applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_FLOORS } from '../learning/contracts.js';
import { freezeCandidate, settleCandidate } from '../learning/promotion.js';
import { buildPatternRecord, buildEvidence, estimateFromEvidence } from '../learning/patterns.js';
import { createLearningStore } from '../learning/store.js';
import { readDecisionMemory } from '../learning/memory-view.js';
import { JUDGE_FACT_RECIPE_VERSION, resolveLearningContribution } from '../judge/learning-intake.js';
import { stewardActivations, STEWARD_VERSION } from '../lib/learning-activation-steward.js';

const T0 = Date.UTC(2026, 5, 1);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BINDING = Object.freeze({ featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyDigest: 'a'.repeat(64) });
const predicate = { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 3 }] };
const scope = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED' };
const costModel = { feePctPerSide: 0.8, slippageBps: 10 };
void DEFAULT_FLOORS;

function appendAccumulatingPattern(store) {
  const items = Array.from({ length: 8 }, (_, i) => ({ opportunityId: `lop-h${i}`, canonicalCoin: `A${i % 5}A`, decisionTs: T0 - 20 * DAY + i * DAY, evidenceBasis: 'HISTORICAL_RECONSTRUCTION', outcomeClass: i % 4 === 3 ? 'ADVERSE' : 'FAVORABLE' }));
  const evidence = buildEvidence(items);
  const estimate = estimateFromEvidence(items, evidence, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 - DAY });
  const persistedEvidence = { ...evidence, _grouping: null };
  store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 20 * DAY, seq: 0, state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION', evidence: persistedEvidence, estimate, contradictions: [] }));
  store.appendPattern(buildPatternRecord({ predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 10 * DAY, seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE', evidence: persistedEvidence, estimate, contradictions: [] }));
  return store.patternHeads().values().next().value;
}

function appendForwardEvidence(store, design, groups = 34) {
  for (let g = 0; g < groups; g += 1) {
    const decisionTs = design.sealedTs + HOUR + (g % 8) * DAY + Math.floor(g / 8) * 5 * HOUR;
    const opportunityId = `lop-forward-${g}`; const labelEndTs = decisionTs + HOUR;
    store.appendProspective({ kind: 'CAPTURE', candidateId: design.candidateId, opportunityId, canonicalCoin: `A${g % 6}A`, decisionTs, candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED', recordedTs: decisionTs + 1_000, labelEndTs });
    store.appendProspective({ kind: 'OUTCOME', candidateId: design.candidateId, opportunityId, outcomeClass: 'FAVORABLE', metricValue: 1.5, outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1_000 });
  }
}

function publishedFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learn-steward-'));
  const store = createLearningStore({ dataDir: dir });
  const pattern = appendAccumulatingPattern(store);
  const design = freezeCandidate({ store, pattern, costModel, consumerBinding: BINDING, nowTs: T0 });
  appendForwardEvidence(store, design);
  const settledTs = T0 + 40 * DAY;
  const result = settleCandidate({ store, candidateId: design.candidateId, nowTs: settledTs });
  assert.equal(result.note, 'PUBLISHED_WAITING_FOR_PAPER');
  return { dir, store, pattern, activation: result.activation, settledTs };
}

const facts = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED', asset: 'AAA', venue: 'KRAKEN', featureRecipeVersion: BINDING.featureRecipeVersion, policyVersion: BINDING.policyDigest, features: { relVolume60m: { value: 4, availability: 'KNOWN', ageMs: 0 } } };

test('F5: a promotion-published activation is invisible to the Judge until the steward runs; after one pass both heads are ACTIVE_PAPER and the ranking contribution applies', () => {
  const { dir, store, pattern, activation, settledTs } = publishedFixture();
  try {
    const before = readDecisionMemory({ store, nowTs: settledTs + 1 });
    const waiting = resolveLearningContribution({ snapshot: before, facts, mode: 'PAPER', nowTs: settledTs + 1 });
    assert.equal(waiting.applied, false, 'a waiting activation carries no decision authority'); assert.match(waiting.rejected[0].reason, /NOT_ACTIVE/);

    const lines = [];
    const out = stewardActivations({ store, nowTs: settledTs + 1, log: (l) => lines.push(l) });
    assert.deepEqual(out.activated.map((a) => a.activationId), [activation.activationId]);
    assert.deepEqual(out.expired, []); assert.deepEqual(out.skipped, []);
    assert.equal(store.activationHeads().get(activation.activationId).state, 'ACTIVE_PAPER');
    assert.equal(store.activationHeads().get(activation.activationId).transitionReason, 'PAPER_RUNTIME_ADOPTED');
    const head = store.patternHeads().get(pattern.patternId);
    assert.equal(head.state, 'ACTIVE_PAPER'); assert.equal(head.activationId, activation.activationId); assert.equal(head.candidateId, activation.candidateId);
    assert.match(lines[0], /is ACTIVE_PAPER .*ranking-only/);

    const after = readDecisionMemory({ store, nowTs: settledTs + 2 });
    assert.equal(after.activations.length, 1); assert.deepEqual(after.withheld, []);
    const matched = resolveLearningContribution({ snapshot: after, facts, mode: 'PAPER', nowTs: settledTs + 2 });
    assert.equal(matched.applied, true); assert.equal(matched.selected.activationId, activation.activationId);

    // idempotent: a second pass appends nothing
    const again = stewardActivations({ store, nowTs: settledTs + 3 });
    assert.deepEqual(again, { activated: [], expired: [], skipped: [] });
    assert.equal(store.activationHeads().get(activation.activationId).seq, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F5: the steward refuses to activate while paper is not active, and expires an ACTIVE_PAPER activation past its lifetime (pattern RETIRED)', () => {
  const { dir, store, pattern, activation, settledTs } = publishedFixture();
  try {
    const held = stewardActivations({ store, nowTs: settledTs + 1, paperActive: false });
    assert.deepEqual(held.activated, []); assert.equal(held.skipped[0].reason, 'PAPER_NOT_ACTIVE');
    assert.equal(store.activationHeads().get(activation.activationId).state, 'PUBLISHED_WAITING_FOR_PAPER');

    stewardActivations({ store, nowTs: settledTs + 1 });
    const late = activation.expiresTs + 1;
    const out = stewardActivations({ store, nowTs: late });
    assert.deepEqual(out.expired, [{ activationId: activation.activationId, reason: 'LIFETIME_ELAPSED' }]);
    assert.equal(store.activationHeads().get(activation.activationId).state, 'EXPIRED');
    assert.equal(store.patternHeads().get(pattern.patternId).state, 'RETIRED');
    const gone = resolveLearningContribution({ snapshot: readDecisionMemory({ store, nowTs: late + 1 }), facts, mode: 'PAPER', nowTs: late + 1 });
    assert.equal(gone.applied, false); assert.match(gone.rejected[0].reason, /EXPIRED|NOT_ACTIVE/);
    assert.equal(STEWARD_VERSION, 'learning-activation-steward-1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F5: a waiting activation whose lifetime elapsed before paper ever ran expires instead of activating; an unreadable store is contained', () => {
  const { dir, store, activation } = publishedFixture();
  try {
    const out = stewardActivations({ store, nowTs: activation.expiresTs + 1 });
    assert.deepEqual(out.expired, [{ activationId: activation.activationId, reason: 'LIFETIME_ELAPSED_BEFORE_ACTIVATION' }]);
    assert.equal(store.activationHeads().get(activation.activationId).state, 'EXPIRED');
    const broken = { activationHeads: () => { throw new Error('disk gone'); }, patternHeads: () => new Map() };
    const lines = [];
    assert.deepEqual(stewardActivations({ store: broken, nowTs: T0, log: (l) => lines.push(l) }), { activated: [], expired: [], skipped: [] });
    assert.match(lines[0], /journals unreadable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
