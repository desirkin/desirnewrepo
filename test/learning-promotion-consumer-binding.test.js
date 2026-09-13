import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FLOORS, LEGACY_PROSPECTIVE_VERSION, PROSPECTIVE_VERSION,
  candidateIdOf, canonicalDigest, designError,
} from '../learning/contracts.js';
import { sealDesign, replayProspective } from '../learning/prospective.js';
import { freezeCandidate, settleCandidate } from '../learning/promotion.js';
import { buildPatternRecord, buildEvidence, estimateFromEvidence } from '../learning/patterns.js';
import { transitionActivation } from '../learning/adapter.js';
import { createLearningStore } from '../learning/store.js';
import { readDecisionMemory } from '../learning/memory-view.js';
import { JUDGE_FACT_RECIPE_VERSION, resolveLearningContribution } from '../judge/learning-intake.js';

const T0 = Date.UTC(2026, 5, 1);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const POLICY_DIGEST = 'a'.repeat(64);
const BINDING = Object.freeze({ featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyDigest: POLICY_DIGEST });
const predicate = { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 3 }] };
const scope = { setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED' };
const costModel = { feePctPerSide: 0.8, slippageBps: 10 };

function appendAccumulatingPattern(store) {
  const items = Array.from({ length: 8 }, (_, i) => ({
    opportunityId: `lop-h${i}`, canonicalCoin: `A${i % 5}A`, decisionTs: T0 - 20 * DAY + i * DAY,
    evidenceBasis: 'HISTORICAL_RECONSTRUCTION', outcomeClass: i % 4 === 3 ? 'ADVERSE' : 'FAVORABLE',
  }));
  const evidence = buildEvidence(items);
  const estimate = estimateFromEvidence(items, evidence, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 - DAY });
  const persistedEvidence = { ...evidence, _grouping: null };
  store.appendPattern(buildPatternRecord({
    predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 20 * DAY, seq: 0,
    state: 'NOTICED', previousState: null, transitionReason: 'FIRST_OBSERVATION',
    evidence: persistedEvidence, estimate, contradictions: [],
  }));
  store.appendPattern(buildPatternRecord({
    predicate, scope, origin: 'TEST', createdTs: T0 - 20 * DAY, ts: T0 - 10 * DAY, seq: 1,
    state: 'ACCUMULATING', previousState: 'NOTICED', transitionReason: 'NEW_MATURED_EVIDENCE',
    evidence: persistedEvidence, estimate, contradictions: [],
  }));
  return store.patternHeads().values().next().value;
}

function appendForwardEvidence(store, design, groups = 34) {
  for (let g = 0; g < groups; g += 1) {
    const decisionTs = design.sealedTs + HOUR + (g % 8) * DAY + Math.floor(g / 8) * 5 * HOUR;
    const opportunityId = `lop-forward-${g}`;
    const labelEndTs = decisionTs + HOUR;
    store.appendProspective({
      kind: 'CAPTURE', candidateId: design.candidateId, opportunityId, canonicalCoin: `A${g % 6}A`,
      decisionTs, candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED',
      recordedTs: decisionTs + 1_000, labelEndTs,
    });
    store.appendProspective({
      kind: 'OUTCOME', candidateId: design.candidateId, opportunityId,
      outcomeClass: 'FAVORABLE', metricValue: 1.5, outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1_000,
    });
  }
}

function legacyDesign(patternId) {
  const body = {
    prospectiveVersion: LEGACY_PROSPECTIVE_VERSION, candidateId: 'lcand-UNBOUND', patternId,
    predicate, predicateDigest: canonicalDigest(predicate), scope,
    primaryHorizonMin: 60, primaryMetric: 'NET_LOG_RETURN_60M_PCT', comparator: 'BASELINE_RULE_SAME_STREAM',
    costModel, groupLaw: 'learning-group-law-1', terminalGroupTarget: 30, floors: DEFAULT_FLOORS,
    missingnessRule: 'MATURED_COVERAGE_AT_LEAST_0.8', uncertaintyMethod: 'NORMAL_SE_OVER_GROUP_MEANS',
    alpha: 0.05, sealedTs: T0, evidenceDigest: 'legacy-evidence',
  };
  return { ...body, candidateId: candidateIdOf(body) };
}

test('a v2 candidate seals the exact consumer binding, promotion copies it, and Judge accepts only matching prepared facts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learn-consumer-binding-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const pattern = appendAccumulatingPattern(store);
    assert.throws(() => sealDesign({
      patternId: pattern.patternId, predicate, scope, costModel, terminalGroupTarget: 30,
      sealedTs: T0, evidenceDigest: 'unbound',
    }), /consumer binding/);

    const design = freezeCandidate({ store, pattern, costModel, consumerBinding: BINDING, nowTs: T0 });
    assert.equal(design.prospectiveVersion, PROSPECTIVE_VERSION);
    assert.deepEqual(design.consumerBinding, BINDING);
    assert.equal(Object.isFrozen(design.consumerBinding), true);
    for (const changedBinding of [
      { ...BINDING, featureRecipeVersion: 'judge-prepared-market-features-2' },
      { ...BINDING, policyDigest: 'b'.repeat(64) },
    ]) {
      const changed = sealDesign({
        patternId: pattern.patternId, predicate, scope, costModel, terminalGroupTarget: 30,
        sealedTs: T0, evidenceDigest: 'NO_REFS', consumerBinding: changedBinding,
      });
      assert.notEqual(changed.candidateId, design.candidateId, 'either consumer-binding field changes the content-hashed candidate identity');
    }

    appendForwardEvidence(store, design);
    const settledTs = T0 + 40 * DAY;
    const result = settleCandidate({ store, candidateId: design.candidateId, nowTs: settledTs });
    assert.equal(result.terminal.verdict, 'FORWARD_SUPPORTED');
    assert.equal(result.activation.featureRecipeVersion, BINDING.featureRecipeVersion);
    assert.equal(result.activation.policyVersion, BINDING.policyDigest);

    const active = transitionActivation(result.activation, {
      state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: settledTs + 1,
    });
    store.appendActivation(active);
    const validatedPattern = store.patternHeads().get(pattern.patternId);
    store.appendPattern(buildPatternRecord({
      predicate: validatedPattern.predicate, scope: validatedPattern.scope, origin: validatedPattern.origin,
      createdTs: validatedPattern.createdTs, ts: settledTs + 1, seq: validatedPattern.seq + 1,
      state: 'ACTIVE_PAPER', previousState: validatedPattern.state, transitionReason: 'PAPER_RUNTIME_ADOPTED',
      evidence: validatedPattern.evidence, estimate: validatedPattern.estimate, contradictions: validatedPattern.contradictions,
      candidateId: validatedPattern.candidateId, activationId: active.activationId,
    }));
    const nowTs = settledTs + 2;
    const snapshot = readDecisionMemory({ store, nowTs });
    assert.equal(snapshot.activations.length, 1);
    assert.deepEqual(snapshot.withheld, []);
    const facts = {
      setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED', asset: 'AAA', venue: 'KRAKEN',
      featureRecipeVersion: BINDING.featureRecipeVersion, policyVersion: BINDING.policyDigest,
      features: { relVolume60m: { value: 4, availability: 'KNOWN', ageMs: 0 } },
    };
    const matched = resolveLearningContribution({ snapshot, facts, mode: 'PAPER', nowTs });
    assert.equal(matched.applied, true);
    assert.equal(matched.selected.activationId, active.activationId);

    const wrongRecipe = resolveLearningContribution({
      snapshot, facts: { ...facts, featureRecipeVersion: 'judge-prepared-market-features-2' }, mode: 'PAPER', nowTs,
    });
    assert.equal(wrongRecipe.rejected[0].reason, 'FEATURE_RECIPE_VERSION_MISMATCH');
    const wrongPolicy = resolveLearningContribution({
      snapshot, facts: { ...facts, policyVersion: 'b'.repeat(64) }, mode: 'PAPER', nowTs,
    });
    assert.equal(wrongPolicy.rejected[0].reason, 'POLICY_VERSION_MISMATCH');

    for (const mutation of [
      { featureRecipeVersion: 'judge-prepared-market-features-2' },
      { policyVersion: 'b'.repeat(64) },
    ]) {
      const forged = { ...active, ...mutation };
      const forgedHeads = new Map([[forged.activationId, forged]]);
      const tamperedStore = { ...store, activationHeads: () => forgedHeads, activationHistory: () => ({ heads: forgedHeads, invalid: new Map(), globalErrors: [] }) };
      const withheld = readDecisionMemory({ store: tamperedStore, nowTs });
      assert.equal(withheld.activations.length, 0);
      assert.equal(withheld.withheld[0].reason, 'ACTIVATION_EVIDENCE_MISMATCH');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('historical v1 designs retain their exact identity and replay, but an unbound winner cannot publish to Judge', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learn-legacy-binding-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const pattern = appendAccumulatingPattern(store);
    const design = legacyDesign(pattern.patternId);
    assert.equal(design.candidateId, 'lcand-bc446aca2a9640238009358f72fd32d12006bb46', 'the historical v1 content hash is unchanged');
    assert.equal(designError(design), null);
    assert.deepEqual(replayProspective([{ kind: 'DESIGN_SEALED', design }]).errors, []);

    store.appendProspective({ kind: 'DESIGN_SEALED', design });
    for (const [seq, state, previousState, transitionReason] of [
      [2, 'CANDIDATE_FROZEN', 'ACCUMULATING', 'CANDIDATE_SEALED'],
      [3, 'PROSPECTIVE_PENDING', 'CANDIDATE_FROZEN', 'AWAITING_FRESH_FORWARD_EVIDENCE'],
    ]) {
      store.appendPattern(buildPatternRecord({
        predicate: pattern.predicate, scope: pattern.scope, origin: pattern.origin, createdTs: pattern.createdTs,
        ts: T0, seq, state, previousState, transitionReason,
        evidence: { ...pattern.evidence, _grouping: null }, estimate: pattern.estimate, contradictions: pattern.contradictions,
        candidateId: design.candidateId, activationId: null,
      }));
    }
    appendForwardEvidence(store, design);
    const result = settleCandidate({ store, candidateId: design.candidateId, nowTs: T0 + 40 * DAY });
    assert.equal(result.terminal.verdict, 'FORWARD_SUPPORTED', 'the old forward result remains valid historical evidence');
    assert.equal(result.activation, null, 'no current binding is retrofitted after observing the outcome');
    assert.equal(result.patternState, 'ACCUMULATING');
    assert.equal(result.note, 'LEGACY_CONSUMER_UNBOUND_INELIGIBLE_FOR_JUDGE');
    assert.equal(store.activationHeads().size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
