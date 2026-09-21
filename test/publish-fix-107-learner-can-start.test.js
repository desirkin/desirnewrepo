// PUBLISH-FIX-107 (2026-09-21, owner directive). David: "If you think dropping from 1000 to 300 speeds us go for it !!"
//
// `minScored` is how many SCORED looks a gate needs before the learner may even PROPOSE moving its line. It was 1000, and it
// was set on 2026-09-19 — before PUBLISH-FIX-92 found that the maturation sweep was silently stalled: 6,941 judge looks in
// 48 hours with ZERO outcome rows, because a settlement row was being dropped as a duplicate of the row it settled. So for the
// whole life of the gate learner, nothing was ever being counted toward the thousand. The number was not cautious, it was moot.
//
// With the grader working, 300 is reachable in days instead of weeks. NOTHING else about the law moves, and this drill exists to
// prove that: the change must be exactly one number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadProfile, applyProfileEnvironment } from '../paper/profile.js';

const laneOf = () => JSON.parse(readFileSync('config/paper-runtime.json', 'utf8')).groups.judge.gateLearning;

test('FIX107-1: the learner may start at 300 scored looks, not 1000', () => {
  assert.equal(laneOf().minScored, 300);
});

test('FIX107-2: every OTHER guard is untouched — this is one number, not a loosening', () => {
  const g = laneOf();
  assert.equal(g.desiredState, 'ON');
  assert.equal(g.minCohort, 100, 'still 100 looks in the cohort the change affects');
  assert.equal(g.minForward, 100, 'still 100 looks scored AFTER the proposal before it may publish');
  assert.equal(g.confidence, 0.9, 'still bootstrap confidence that the admitted looks\' 15-minute return does not fall');
  assert.equal(g.module, 'learning/gate-lesson.js');
  assert.equal(g.blockerPolicy, 'DEGRADE', 'a failing learner degrades; it never blocks the paper run');
});

test('FIX107-3: the profile derives it, so the running app sees 300', () => {
  const env = {}; applyProfileEnvironment(loadProfile(), env);
  assert.equal(env.JUDGE_GATE_MIN_SCORED, '300');
  assert.equal(env.JUDGE_GATE_MIN_COHORT, '100');
  assert.equal(env.JUDGE_GATE_MIN_FORWARD, '100');
  assert.equal(env.JUDGE_GATE_CONFIDENCE, '0.9');
  assert.equal(env.JUDGE_GATE_LEARNING, 'true');
});

test('FIX107-4: what the learner is allowed to touch has NOT widened', async () => {
  const { LEARNABLE_GATES } = await import('../judge/setups.js');
  const { GATE_BANDS } = await import('../learning/gate-lesson.js');
  const FIVE = ['FI15', 'FI60_POSITIVE', 'RV60', 'RECLAIM_FI15', 'FI15_FRESH_AT_D'];
  assert.deepEqual(Object.keys(LEARNABLE_GATES).sort(), [...FIVE].sort(), 'exactly the five flow lines, no more');
  assert.deepEqual(Object.keys(GATE_BANDS).sort(), [...FIVE].sort(), 'and the learner knows exactly those five');
  for (const id of FIVE) {
    const b = GATE_BANDS[id];
    assert.ok(Number.isFinite(b.min) && Number.isFinite(b.max) && b.min < b.max, `${id} has a fixed band`);
    assert.deepEqual({ min: b.min, max: b.max, step: b.step, op: b.op }, { min: LEARNABLE_GATES[id].min, max: LEARNABLE_GATES[id].max, step: LEARNABLE_GATES[id].step, op: LEARNABLE_GATES[id].op }, `${id}: the Judge's band and the learner's band are the same band`);
  }
  // the cost law, the stop and sizing are outside the learner entirely
  const lesson = readFileSync('learning/gate-lesson.js', 'utf8');
  for (const forbidden of ['REWARD_RISK_MIN', 'scenarioStressedLoss', 'size-ladder']) {
    assert.equal(lesson.includes(forbidden), false, `the learner has no idea what ${forbidden} is`);
  }
});

test('FIX107-5: the reason is recorded where the number lives, so nobody has to guess why', () => {
  const note = String(laneOf().note ?? '');
  assert.match(note, /PUBLISH-FIX-107/);
  assert.match(note, /PUBLISH-FIX-92/, 'and it names the stall that made 1000 meaningless');
});
