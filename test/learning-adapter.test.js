// LEARN-1 — the bounded paper adapter: allowlisted score contribution only, caps, kill switch, corrupt-state
// fallback, frozen active parameters, predeclared degradation and durable rollback without oscillation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildActivation, transitionActivation, applyLearnedAdjustment, degradationCheck, DEFAULT_DEGRADE_RULE } from '../learning/adapter.js';
import { createLearningStore } from '../learning/store.js';

const T = Date.UTC(2026, 5, 10);
const DAY = 86_400_000;
const KILL_ARMED = { state: 'ARMED', reason: null, ts: T };
const featureSet = { features: { relVolume60m: { value: 5, unit: 'ratio', lookbackMs: 1, availability: 'KNOWN' } } };
const applicability = { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 3 }] };

function activeActivation(over = {}) {
  const base = buildActivation({
    candidateId: 'lcand-a', patternId: 'lpat-a', trainingCutoffTs: T - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd',
    maxAbsAdjust: 0.1, applicability, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T,
  });
  return transitionActivation(base, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T, ...over });
}

test('M. only the allowlisted score contribution changes; baseline is preserved beside the effective score; hard gates are unreachable (no such input exists)', () => {
  const a = activeActivation();
  const heads = new Map([[a.activationId, a]]);
  const r = applyLearnedAdjustment({ baselineScore: 1.0, activationHeads: heads, featureSet, adjustments: { [a.activationId]: 0.08 }, nowTs: T + DAY, kill: KILL_ARMED });
  assert.equal(r.baselineScore, 1.0);
  assert.equal(r.effectiveScore, 1.08);
  assert.equal(r.applied.length, 1);
  assert.equal(r.fallbackReason, null);
});

test('an adjustment beyond the activation\'s own allowed effect suspends learned influence entirely (baseline + reason), never a partial apply', () => {
  const a = activeActivation();
  const r = applyLearnedAdjustment({ baselineScore: 1, activationHeads: new Map([[a.activationId, a]]), featureSet, adjustments: { [a.activationId]: 0.2 }, nowTs: T + DAY, kill: KILL_ARMED });
  assert.equal(r.effectiveScore, 1);
  assert.equal(r.fallbackReason, 'ADJUSTMENT_EXCEEDS_ALLOWED_EFFECT');
});

test('correlated patterns cannot stack full boosts: the aggregate ceiling squeezes proportionally and discloses it', () => {
  const list = [1, 2, 3].map((i) => {
    const base = buildActivation({ candidateId: `lcand-a${i}`, patternId: `lpat-a${i}`, trainingCutoffTs: T - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: 0.1, applicability, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T });
    return transitionActivation(base, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T });
  });
  const heads = new Map(list.map((a) => [a.activationId, a]));
  const adjustments = Object.fromEntries(list.map((a) => [a.activationId, 0.1]));
  const r = applyLearnedAdjustment({ baselineScore: 0, activationHeads: heads, featureSet, adjustments, nowTs: T + DAY, kill: KILL_ARMED });
  assert.ok(Math.abs(r.effectiveScore) <= 0.25 + 1e-9, `aggregate capped (got ${r.effectiveScore})`);
  assert.equal(r.applied.length, 3);
});

test('expiry, kill switch, out-of-domain and corrupt records each answer BASELINE with the reason exposed', () => {
  const a = activeActivation();
  const heads = new Map([[a.activationId, a]]);
  const expired = applyLearnedAdjustment({ baselineScore: 1, activationHeads: heads, featureSet, adjustments: { [a.activationId]: 0.05 }, nowTs: a.expiresTs + 1, kill: KILL_ARMED });
  assert.equal(expired.effectiveScore, 1); assert.deepEqual(expired.applied, []);
  const killed = applyLearnedAdjustment({ baselineScore: 1, activationHeads: heads, featureSet, adjustments: { [a.activationId]: 0.05 }, nowTs: T + DAY, kill: { state: 'KILLED', reason: 'CLI_KILL', ts: T } });
  assert.equal(killed.effectiveScore, 1); assert.equal(killed.fallbackReason, 'CLI_KILL');
  const outOfDomain = applyLearnedAdjustment({ baselineScore: 1, activationHeads: heads, featureSet: { features: { relVolume60m: { value: null, unit: 'ratio', lookbackMs: 1, availability: 'UNAVAILABLE' } } }, adjustments: { [a.activationId]: 0.05 }, nowTs: T + DAY, kill: KILL_ARMED });
  assert.equal(outOfDomain.effectiveScore, 1, 'UNKNOWN/OUT_OF_DOMAIN contributes nothing — no extrapolated confidence');
  const corrupt = applyLearnedAdjustment({ baselineScore: 1, activationHeads: new Map([['x', { garbage: true }]]), featureSet, adjustments: {}, nowTs: T + DAY, kill: KILL_ARMED });
  assert.equal(corrupt.fallbackReason, 'ACTIVATION_RECORD_INVALID');
});

test('frozen active parameters: the adapter consumes only immutable records — a mutated copy fails validation and suspends influence', () => {
  const a = activeActivation();
  assert.throws(() => { a.allowedEffect.maxAbsAdjust = 0.5; }, TypeError, 'activation records are deep-frozen');
  const tampered = { ...a, allowedEffect: { ...a.allowedEffect, maxAbsAdjust: 0.5 } };
  const r = applyLearnedAdjustment({ baselineScore: 1, activationHeads: new Map([[a.activationId, tampered]]), featureSet, adjustments: { [a.activationId]: 0.4 }, nowTs: T + DAY, kill: KILL_ARMED });
  assert.equal(r.fallbackReason, 'ACTIVATION_RECORD_INVALID', 'a widened cap is not a lawful record');
});

test('O. degradation follows its predeclared rule: one ordinary loss cannot flip anything; rollback is durable with cooldown', () => {
  const a = activeActivation();
  // one bad window below minGroups: no degradation
  assert.equal(degradationCheck({ head: a, windows: [{ groups: 1, adverseGroups: 1 }, { groups: 1, adverseGroups: 1 }] }).degrade, false);
  // one qualifying window is not consecutive windows
  assert.equal(degradationCheck({ head: a, windows: [{ groups: 12, adverseGroups: 10 }] }).degrade, false);
  // the rule met across consecutive windows degrades
  const met = degradationCheck({ head: a, windows: [{ groups: 12, adverseGroups: 10 }, { groups: 15, adverseGroups: 12 }] });
  assert.equal(met.degrade, true);
  assert.equal(DEFAULT_DEGRADE_RULE.minGroups >= 2, true);
  // durable rollback through the store, with cooldown preventing oscillation
  const dir = mkdtempSync(path.join(tmpdir(), 'cobra-learn-adapter-'));
  try {
    const store = createLearningStore({ dataDir: dir });
    const pub = buildActivation({ candidateId: 'lcand-b', patternId: 'lpat-b', trainingCutoffTs: T - DAY, candidateDigest: 'cd', evidenceDigest: 'ed', reportDigest: 'rd', maxAbsAdjust: 0.1, applicability, effectiveTs: T, expiresTs: T + 30 * DAY, ts: T });
    store.appendActivation(pub);
    store.appendActivation(transitionActivation(pub, { state: 'ACTIVE_PAPER', transitionReason: 'PAPER_RUNTIME_ADOPTED', ts: T + 1 }));
    const active = store.activationHeads().get(pub.activationId);
    const rolled = transitionActivation(active, { state: 'ROLLED_BACK', transitionReason: 'PREDECLARED_DEGRADATION_RULE_MET', ts: T + 2, cooldownUntilTs: T + 2 + DAY });
    store.appendActivation(rolled);
    const reread = createLearningStore({ dataDir: dir }); // restart
    const head = reread.activationHeads().get(pub.activationId);
    assert.equal(head.state, 'ROLLED_BACK', 'rollback survives restart');
    assert.equal(head.cooldownUntilTs, T + 2 + DAY);
    const r = applyLearnedAdjustment({ baselineScore: 1, activationHeads: reread.activationHeads(), featureSet, adjustments: { [pub.activationId]: 0.05 }, nowTs: T + 3, kill: reread.readKill() });
    assert.equal(r.effectiveScore, 1, 'a rolled-back version influences nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
