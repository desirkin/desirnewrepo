import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildActivation, transitionActivation } from '../learning/adapter.js';
import {
  activationImmutableDigest, activationTransitionError, replayActivationHistory,
} from '../learning/activation-chain.js';
import { createLearningStore } from '../learning/store.js';
import { readDecisionMemory } from '../learning/memory-view.js';

const T = Date.UTC(2026, 8, 13);
const DAY = 86_400_000;
const predicate = { clauses: [{ feature: 'rv60', op: 'GTE', threshold: 2 }] };

function published(overrides = {}) {
  return buildActivation({
    candidateId: 'lcand-chain', patternId: 'lpat-chain', trainingCutoffTs: T - DAY,
    candidateDigest: 'candidate-digest', evidenceDigest: 'evidence-digest', reportDigest: 'report-digest',
    maxAbsAdjust: 0.1, adjust: 0.05,
    validation: { evidenceBasis: 'PROSPECTIVE', groupCount: 30, assetCount: 5, dateCount: 7, netAfterCostsPct: 0.4 },
    scope: { setupType: 'RANGE_IGNITION', regime: 'LIVE_UNCLASSIFIED', assets: 'ANY', venues: ['kraken'] },
    featureRecipeVersion: 'judge-prepared-market-features-1', policyVersion: 'a'.repeat(64),
    applicability: predicate, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T,
    ...overrides,
  });
}

test('activation replay accepts only the closed contiguous lifecycle and keeps immutable publication binding fixed', () => {
  const pub = published();
  const active = transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 });
  const suspended = transitionActivation(active, { state: 'SUSPENDED', transitionReason: 'OPERATOR_SUSPENDED', ts: T + 2 });
  const resumed = transitionActivation(suspended, { state: 'ACTIVE_PAPER', transitionReason: 'OWNER_RESUMED', ts: T + 3 });
  const rolled = transitionActivation(resumed, { state: 'ROLLED_BACK', transitionReason: 'PREDECLARED_DEGRADATION_RULE_MET', ts: T + 4, cooldownUntilTs: T + DAY });
  const replay = replayActivationHistory([pub, active, suspended, resumed, rolled]);
  assert.equal(replay.invalid.size, 0);
  assert.equal(replay.globalErrors.length, 0);
  assert.equal(replay.heads.get(pub.activationId).state, 'ROLLED_BACK');
  assert.equal(activationImmutableDigest(pub), activationImmutableDigest(rolled));
  assert.match(activationTransitionError(rolled, transitionActivation(rolled, { state: 'ACTIVE_PAPER', transitionReason: 'ILLEGAL', ts: T + 5 })), /not lawful/);
});

test('bad origin, gaps, clock regression, immutable mutation and illegal edges withhold the exact activation', () => {
  const pub = published();
  const active = transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 });
  const cases = [
    [{ ...active }],
    [pub, { ...active, seq: 2 }],
    [pub, { ...active, ts: T - 1 }],
    [pub, { ...active, featureRecipeVersion: 'judge-prepared-market-features-2' }],
    [pub, transitionActivation(pub, { state: 'ROLLED_BACK', transitionReason: 'ILLEGAL', ts: T + 1 })],
  ];
  for (const rows of cases) {
    const replay = replayActivationHistory(rows);
    assert.equal(replay.heads.has(pub.activationId), false);
    assert.equal(replay.invalid.has(pub.activationId), true);
  }
});

test('the store refuses unlawful appends and an attributable bad physical row is retained but never a head', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-activation-chain-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const pub = published();
    const active = transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 });
    assert.throws(() => store.appendActivation(active), /origin must have seq 0/);
    store.appendActivation(pub);
    assert.throws(() => store.appendActivation({ ...active, seq: 2 }), /not contiguous/);
    store.appendActivation(active);
    assert.equal(store.activationHeads().get(pub.activationId).state, 'ACTIVE_PAPER');

    const file = path.join(dir, 'learning', 'activations.jsonl');
    const bad = { ...transitionActivation(active, { state: 'SUSPENDED', transitionReason: 'TAMPER', ts: T + 2 }), policyVersion: 'b'.repeat(64) };
    appendFileSync(file, `${JSON.stringify(bad)}\n`, 'utf8');
    const bytes = readFileSync(file, 'utf8');
    const replay = store.activationHistory();
    assert.equal(replay.invalid.has(pub.activationId), true);
    assert.equal(replay.heads.has(pub.activationId), false);
    assert.equal(readFileSync(file, 'utf8'), bytes, 'replay withholds; it never deletes or repairs stored history');

    appendFileSync(file, '{torn-json\n', 'utf8');
    assert.equal(store.activationHistory().globalErrors.length, 1);
    assert.equal(store.activationHeads().size, 0, 'an unattributable corrupt row fails the entire activation view closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decision memory withholds an ACTIVE activation until the exact pattern head is also ACTIVE', () => {
  const pub = published();
  const active = transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 });
  const store = {
    activationHistory: () => ({ heads: new Map([[active.activationId, active]]), invalid: new Map(), globalErrors: [] }),
    activationHeads: () => new Map([[active.activationId, active]]),
    patternHeads: () => new Map(),
    readProspective: () => [],
    readKill: () => ({ state: 'ARMED', reason: null, ts: null }),
  };
  const snapshot = readDecisionMemory({ store, nowTs: T + 2 });
  assert.equal(snapshot.activations.length, 0);
  assert.deepEqual(snapshot.withheld, [{ activationId: active.activationId, reason: 'ACTIVE_PATTERN_BINDING_MISSING' }]);
});

test('decision memory has no legacy activation-head fallback when replayable history is unavailable', () => {
  const active = transitionActivation(published(), { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 });
  const store = {
    activationHeads: () => new Map([[active.activationId, active]]),
    patternHeads: () => new Map(),
    readProspective: () => [],
    readKill: () => ({ state: 'ARMED', reason: null, ts: null }),
  };
  const snapshot = readDecisionMemory({ store, nowTs: T + 2 });
  assert.equal(snapshot.activations.length, 0);
  assert.deepEqual(snapshot.withheld, [{ activationId: 'UNKNOWN', reason: 'ACTIVATION_HISTORY_INVALID:ACTIVATION_HISTORY_UNAVAILABLE' }]);
});

test('decision memory never lets a future ACTIVE pattern complete a partial two-journal adoption', () => {
  const active = transitionActivation(published(), { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 });
  const futurePattern = {
    patternId: active.patternId, candidateId: active.candidateId, activationId: active.activationId,
    state: 'ACTIVE_PAPER', ts: T + 10,
  };
  const store = {
    activationHistory: () => ({ heads: new Map([[active.activationId, active]]), invalid: new Map(), globalErrors: [] }),
    patternHeads: () => new Map([[futurePattern.patternId, futurePattern]]),
    readProspective: () => [],
    readKill: () => ({ state: 'ARMED', reason: null, ts: null }),
  };
  const snapshot = readDecisionMemory({ store, nowTs: T + 2 });
  assert.equal(snapshot.activations.length, 0);
  assert.deepEqual(snapshot.withheld, [{ activationId: active.activationId, reason: 'ACTIVE_PATTERN_NOT_EFFECTIVE' }]);
});
