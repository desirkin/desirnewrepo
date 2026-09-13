import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecisionMemoryPort } from '../lib/decision-memory-port.js';
import { UNSEALED_ACTIVATION_REASON } from '../learning/decision-memory-worker.js';
import { transitionActivation } from '../learning/adapter.js';
import { buildEvidence, buildPatternRecord, estimateFromEvidence } from '../learning/patterns.js';
import { freezeCandidate, settleCandidate } from '../learning/promotion.js';
import { readDecisionMemory } from '../learning/memory-view.js';
import { createLearningStore } from '../learning/store.js';
import { JUDGE_FACT_RECIPE_VERSION } from '../judge/learning-intake.js';

const T0 = Date.UTC(2026, 5, 1);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const POLICY_DIGEST = 'a'.repeat(64);
const PREDICATE = Object.freeze({ clauses: [Object.freeze({ feature: 'relVolume60m', op: 'GTE', threshold: 3 })] });
const SCOPE = Object.freeze({ setupType: 'BASELINE_SWEEP', regime: 'UNCLASSIFIED' });
const COST_MODEL = Object.freeze({ feePctPerSide: 0.8, slippageBps: 10 });
const CONSUMER_BINDING = Object.freeze({ featureRecipeVersion: JUDGE_FACT_RECIPE_VERSION, policyDigest: POLICY_DIGEST });

function appendAccumulatingPattern(store) {
  const items = Array.from({ length: 8 }, (_, index) => ({
    opportunityId: `lop-history-${index}`,
    canonicalCoin: `A${index % 5}A`,
    decisionTs: T0 - 20 * DAY + index * DAY,
    evidenceBasis: 'HISTORICAL_RECONSTRUCTION',
    outcomeClass: index % 4 === 3 ? 'ADVERSE' : 'FAVORABLE',
  }));
  const evidence = buildEvidence(items);
  const estimate = estimateFromEvidence(items, evidence, { pooledMean: 0.5, priorStrength: 8, updatedTs: T0 - DAY });
  const persistedEvidence = { ...evidence, _grouping: null };
  store.appendPattern(buildPatternRecord({
    predicate: PREDICATE, scope: SCOPE, origin: 'TEST', createdTs: T0 - 20 * DAY,
    ts: T0 - 20 * DAY, seq: 0, state: 'NOTICED', previousState: null,
    transitionReason: 'FIRST_OBSERVATION', evidence: persistedEvidence, estimate, contradictions: [],
  }));
  store.appendPattern(buildPatternRecord({
    predicate: PREDICATE, scope: SCOPE, origin: 'TEST', createdTs: T0 - 20 * DAY,
    ts: T0 - 10 * DAY, seq: 1, state: 'ACCUMULATING', previousState: 'NOTICED',
    transitionReason: 'NEW_MATURED_EVIDENCE', evidence: persistedEvidence, estimate, contradictions: [],
  }));
  return store.patternHeads().values().next().value;
}

function appendForwardEvidence(store, design) {
  for (let group = 0; group < 34; group += 1) {
    const decisionTs = design.sealedTs + HOUR + (group % 8) * DAY + Math.floor(group / 8) * 5 * HOUR;
    const labelEndTs = decisionTs + HOUR;
    const opportunityId = `lop-forward-${group}`;
    store.appendProspective({
      kind: 'CAPTURE', candidateId: design.candidateId, opportunityId,
      canonicalCoin: `A${group % 6}A`, decisionTs,
      candidateDecision: 'SELECTED_FOR_SHADOW', baselineDecision: 'SKIPPED',
      recordedTs: decisionTs + 1_000, labelEndTs,
    });
    store.appendProspective({
      kind: 'OUTCOME', candidateId: design.candidateId, opportunityId,
      outcomeClass: 'FAVORABLE', metricValue: 1.5,
      outcomeKnownAtTs: labelEndTs, recordedTs: labelEndTs + 1_000,
    });
  }
}

function commissionLawfulActiveV1(dataDir) {
  const store = createLearningStore({ dataDir });
  const accumulating = appendAccumulatingPattern(store);
  const design = freezeCandidate({
    store, pattern: accumulating, costModel: COST_MODEL,
    consumerBinding: CONSUMER_BINDING, nowTs: T0,
  });
  appendForwardEvidence(store, design);
  const settledTs = T0 + 40 * DAY;
  const settled = settleCandidate({ store, candidateId: design.candidateId, nowTs: settledTs });
  assert.equal(settled.terminal.verdict, 'FORWARD_SUPPORTED');
  assert.equal(settled.activation.activationVersion, 'learning-activation-1');
  const active = transitionActivation(settled.activation, {
    state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: settledTs + 1,
  });
  store.appendActivation(active);
  const validated = store.patternHeads().get(design.patternId);
  store.appendPattern(buildPatternRecord({
    predicate: validated.predicate, scope: validated.scope, origin: validated.origin,
    createdTs: validated.createdTs, ts: settledTs + 1, seq: validated.seq + 1,
    state: 'ACTIVE_PAPER', previousState: validated.state, transitionReason: 'PAPER_RUNTIME_ADOPTED',
    evidence: validated.evidence, estimate: validated.estimate, contradictions: validated.contradictions,
    candidateId: validated.candidateId, activationId: active.activationId,
  }));
  return { store, active, nowTs: settledTs + 2 };
}

test('the real fixed worker withholds a lawful active activation-v1 instead of retrofitting it', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cobra-worker-lawful-v1-'));
  try {
    const { store, active, nowTs } = commissionLawfulActiveV1(dataDir);
    const preWorker = readDecisionMemory({ store, nowTs });
    assert.equal(preWorker.activations.length, 1, 'fixture must be lawful before testing the worker fence');
    assert.equal(preWorker.activations[0].activationId, active.activationId);
    assert.deepEqual(preWorker.withheld, []);

    const port = createDecisionMemoryPort({ enabled: true, mode: 'PAPER', dataDir, clock: () => nowTs });
    try {
      assert.deepEqual(await port.refresh(), { ok: true, preparedTs: nowTs, withheldCount: 1 });
      const snapshot = port.snapshot();
      assert.deepEqual(snapshot.activations, []);
      assert.deepEqual(snapshot.withheld, [{ activationId: active.activationId, reason: UNSEALED_ACTIVATION_REASON }]);
      assert.equal(snapshot.sourceProvenance.trustBasis, 'FIXED_BOUNDED_READER_COMPLETE_RAW_BYTES');
    } finally {
      await port.stop();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('production source cannot import or call the injectable test-only port constructor', () => {
  const runtimeRoot = fileURLToPath(new URL('..', import.meta.url));
  const excludedDirectories = new Set(['.git', 'coverage', 'data', 'node_modules', 'test']);
  const portSource = path.join(runtimeRoot, 'lib', 'decision-memory-port.js');
  const violations = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) visit(path.join(directory, entry.name));
      if (!entry.isFile() || !/\.(?:cjs|mjs|js)$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (file === portSource) continue;
      if (/\bcreateDecisionMemoryPortForTest\b/.test(readFileSync(file, 'utf8'))) violations.push(path.relative(runtimeRoot, file));
    }
  };
  visit(runtimeRoot);
  assert.deepEqual(violations, [], `test-only constructor referenced by production source: ${violations.join(', ')}`);
});
