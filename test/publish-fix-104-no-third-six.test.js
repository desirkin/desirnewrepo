// PUBLISH-FIX-104 (2026-09-21). A THIRD SIX, in a third file, undoing the first two without a word.
//
// PUBLISH-FIX-99 widened the tape's hot lane 6 -> 20 on measured headroom. PUBLISH-FIX-100 widened
// policy.universe.preparationSlots and maxCandidates 6 -> 20 and bound a NEW $500 account to do it, because a policy binding is
// immutable per account. Deployment dc6e5638 then logged `HOT LANE: POL joins the deep tape now (... hot slots 20/20)` — and the
// very next funnel line read:
//
//     JUDGE FUNNEL: 6 candidates; books 61413 ...
//
// judge/readiness.js carried `export const PREP_SLOTS_MAX = 6`, applied as `Math.min(PREP_SLOTS_MAX, remainingSlots)`. It is a
// CEILING, and it was set to exactly the number the policy used to say — so the policy could be widened, the account could be
// rebound, the tape could carry twenty books, and the Judge would still prepare six, silently, for ever.
//
// The policy is the authority for how many coins stand on the stage: it is digest-bound to the account and cannot change without
// a new one, which is the strongest guarantee in the system. This constant exists only to refuse an absurd value. This drill
// walks the WHOLE chain — shipped config -> composition's remainingSlots -> the slots actually selected — so a fourth six in a
// fourth file cannot hide either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectPreparation, PREP_SLOTS_MAX } from '../judge/readiness.js';
import { loadJudgePolicy } from '../judge/policy.js';

const POLICY_FILE = 'config/judge.paper.starting-styles-fee080.json';
const now = Date.UTC(2026, 8, 21, 3, 0, 0);
const noms = (n) => Array.from({ length: n }, (_, i) => ({
  symbol: `C${String(i).padStart(2, '0')}/USD`, assetId: `C${String(i).padStart(2, '0')}`, source: 'VOLATILITY_WATCH',
  nominationKnownAtTs: now - (n - i) * 1000, nominationLastSeenTs: now - (n - i) * 1000,
}));

test('FIX104-1: the ceiling is no longer the policy\'s old number', () => {
  assert.equal(PREP_SLOTS_MAX, 64);
  assert.notEqual(PREP_SLOTS_MAX, 6, 'a ceiling equal to the value it bounds is not a ceiling, it is a second opinion');
});

test('FIX104-2: the SHIPPED policy asks for twenty, and twenty is what is prepared', () => {
  const { policy } = loadJudgePolicy(POLICY_FILE);
  const remaining = Math.min(policy.universe.preparationSlots, policy.universe.maxCandidates); // judge/composition.js admitNominations
  assert.equal(remaining, 20, 'the effective ask (PUBLISH-FIX-100)');
  const sel = selectPreparation({ nominations: noms(40), remainingSlots: remaining, nowTs: now });
  assert.equal(sel.slots, 20, 'and the planner grants it — before FIX-104 this was 6');
  assert.equal(sel.selected.length, 20);
  assert.equal(sel.preempted.length, 20, 'the other twenty wait, they are not lost');
});

test('FIX104-3: the ceiling still refuses an absurd value', () => {
  assert.equal(selectPreparation({ nominations: noms(200), remainingSlots: 1000, nowTs: now }).slots, 64);
  assert.equal(selectPreparation({ nominations: noms(10), remainingSlots: 0, nowTs: now }).slots, 0);
  assert.equal(selectPreparation({ nominations: noms(10), remainingSlots: -5, nowTs: now }).slots, 0, 'never negative');
});

test('FIX104-4: a smaller policy is still honoured — the ceiling never RAISES the number', () => {
  const sel = selectPreparation({ nominations: noms(40), remainingSlots: 6, nowTs: now });
  assert.equal(sel.slots, 6); assert.equal(sel.selected.length, 6);
});

test('FIX104-5: the whole stage agrees — tape, feed and Judge all say twenty', () => {
  const { policy } = loadJudgePolicy(POLICY_FILE);
  const cobra = JSON.parse(readFileSync('cobra.config.json', 'utf8'));
  assert.equal(cobra.universeExpansion.hotLane.slots, 20, 'the tape carries twenty order books (PUBLISH-FIX-99)');
  assert.equal(policy.universe.preparationSlots, 20, 'the Judge prepares twenty (PUBLISH-FIX-100)');
  assert.equal(policy.universe.maxCandidates, 20, 'the execution feed admits twenty (PUBLISH-FIX-100)');
  assert.ok(PREP_SLOTS_MAX >= 20, 'and nothing clamps it on the way (PUBLISH-FIX-104)');
  // the funnel can only ever show as many candidates as the SMALLEST of these
  const effective = Math.min(cobra.universeExpansion.hotLane.slots, policy.universe.preparationSlots, policy.universe.maxCandidates, PREP_SLOTS_MAX);
  assert.equal(effective, 20, `the narrowest point of the funnel's last stage is ${effective}, not 20`);
});
