// PUBLISH-FIX-93 (2026-09-21) — REVIEW FINDING F1, blind application review of revision 34a25ad2.
//
// The finding, in the reviewer's words: "the training filter accepts a record for one flow gate when every non-flow gate passes,
// even if other flow gates fail ... After that change, zero of all 1,100 examples passes the complete required gate set because
// RV60 is still unknown and failing. The output nevertheless calls them newly admitted." That filter was PUBLISH-FIX-91, made the
// same afternoon to stop the learner starving. It is an invalid policy-improvement inference: a promotion moves ONE line, so a
// look the other flow gates refused does not become tradable when this one moves.
//
// Corroboration from our own data (48-hour gate study, 2026-09-20, 3,174 scored looks): FI15 was never the only refusal on any
// look — when it failed, a sibling flow gate failed with it. So under FIX-91 the ENTIRE cohort it added for FI15 consisted of
// looks that would still be refused.
//
// The repair keeps promotion strict (every other required gate actually passed; an UNKNOWN gate is never counterfactually
// passable) and keeps the wider family count as a reported diagnostic. Moving gates that fail together needs a JOINT family
// policy proposed and forward-tested against the complete rule set — a separate ticket, not a single-gate threshold change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE_BANDS, GATE_LESSON_DEFAULTS, testsOf, evaluateUnit, computeGateLesson } from '../learning/gate-lesson.js';

const T0 = Date.parse('2026-09-10T00:00:00Z');
const CFG = { ...GATE_LESSON_DEFAULTS, minScored: 200, minCohort: 20, minForward: 20, confidence: 0.8, bootstraps: 200, costHurdlePct: 0.2 };

// the reviewer's shape: FI15 observed 0.15 against a reference line of 0.20 (fails), RV60 unknown/failed on the same look,
// every structural gate passing. `rv` picks how RV60 is refused: 'FAILED' (ok false) or 'UNKNOWN' (no verdict at all).
function episodes(n, { start = 0, rv = 'FAILED', r = 3.0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const k = start + i;
    out.push({
      canonicalCoin: `C${k % 12}`, decisionTs: T0 + k * 60_000, setupType: 'RANGE_IGNITION',
      gates: [
        { id: 'FI15', ok: false, observed: 0.15, threshold: 0.2, class: 'SOFT' },
        rv === 'UNKNOWN'
          ? { id: 'RV60', observed: null, threshold: 2.0, class: 'SOFT' }
          : { id: 'RV60', ok: false, observed: 1.1, threshold: 2.0, class: 'SOFT' },
        { id: 'EMA_STACK', ok: true, observed: 1, threshold: 1, class: 'HARD' },
        { id: 'RANGE_DEFINED', ok: true, observed: 1, threshold: 1, class: 'HARD' },
      ],
    });
  }
  return out;
}
const outcomes = (eps, r) => eps.map((e) => ({ assetId: e.canonicalCoin, decisionKnownAtTs: e.decisionTs, yardstick: { continuation: { state: 'KNOWN', logReturnPct: r + (((e.decisionTs / 60_000) % 81) / 100 - 0.4) } } }));

test('FIX93-1: a look another flow gate refused is NOT evidence for moving this gate (it is reported as family, never counted as usable)', () => {
  const eps = episodes(40);
  const tests = testsOf(eps, outcomes(eps, 3.0), { nowTs: T0 + 100 * 60_000 });
  const fi = tests.filter((t) => t.gate === 'FI15');
  assert.equal(fi.length, 40, 'every look joins its scored outcome');
  assert.ok(fi.every((t) => t.othersOk === false), 'RV60 failed on the same look: FI15 alone did not decide it');
  assert.ok(fi.every((t) => t.familyOk === true), 'the wider family view is still reported (FIX-91 diagnostic), it is simply not counted');
  // and the reverse: with RV60 passing, the same look IS this gate's evidence
  const ok = episodes(1, { start: 500 }).map((e) => ({ ...e, gates: e.gates.map((g) => (g.id === 'RV60' ? { ...g, ok: true, observed: 2.5 } : g)) }));
  const t2 = testsOf(ok, outcomes(ok, 3.0), { nowTs: T0 + 600 * 60_000 }).filter((t) => t.gate === 'FI15');
  assert.equal(t2[0].othersOk, true);
});

test('FIX93-2: the reviewer\'s reproduction — 1,000 looks + 100 later looks at FI15 0.15 with RV60 failing propose and publish NOTHING', () => {
  const eps = [...episodes(1000), ...episodes(100, { start: 2000 })];
  const tests = testsOf(eps, outcomes(eps, 3.0), { nowTs: T0 + 3000 * 60_000 });
  const fi = tests.filter((t) => t.gate === 'FI15');
  assert.equal(fi.length, 1100);
  const ev = evaluateUnit(fi, GATE_BANDS.FI15, 0.2, CFG);
  assert.equal(ev.move, null, 'no line move is supported by looks the complete policy still refuses');
  assert.equal(ev.usable, 0, 'none of the 1,100 is usable evidence for FI15');
  assert.equal(ev.family, 1100, 'all 1,100 are visible in the family diagnostic');
  assert.equal(ev.admittedNow, 0);
  assert.match(ev.reason, /^USABLE_0_OF_/);
  // and end to end through the proposal machine: no event, no published line
  const out = computeGateLesson({ tests: fi, nowTs: T0 + 3000 * 60_000, cfg: CFG });
  assert.deepEqual(out.lesson.lines, {}, 'the Judge is handed no learned line');
  assert.equal(out.events.filter((e) => /PROPOSED|PUBLISHED/.test(e)).length, 0, 'nothing proposed, nothing published');
});

test('FIX93-3: an UNKNOWN required gate is never counterfactually passable', () => {
  const eps = episodes(300, { rv: 'UNKNOWN' });
  const fi = testsOf(eps, outcomes(eps, 3.0), { nowTs: T0 + 900 * 60_000 }).filter((t) => t.gate === 'FI15');
  assert.equal(fi.length, 300);
  assert.ok(fi.every((t) => t.othersOk === false), 'no verdict is not a pass');
  assert.equal(evaluateUnit(fi, GATE_BANDS.FI15, 0.2, CFG).move, null);
});

test('FIX93-4: evidence where this gate alone decided still moves the line — the repair does not disable learning', () => {
  // 260 looks, RV60 and the structural gates passing, FI15 observed just under the line with a strongly positive scored return:
  // the cohort the move newly admits is real, tradable and beats the round trip, so the proposal is made on this evidence.
  const mk = (n, start, value, r) => {
    const eps = [];
    for (let i = 0; i < n; i += 1) {
      const k = start + i;
      eps.push({
        canonicalCoin: `C${k % 12}`, decisionTs: T0 + k * 60_000, setupType: 'RANGE_IGNITION',
        gates: [
          { id: 'FI15', ok: false, observed: value + ((i * 0.618033) % 1) * 0.04, threshold: 0.2, class: 'SOFT' },
          { id: 'RV60', ok: true, observed: 2.5, threshold: 2.0, class: 'SOFT' },
          { id: 'EMA_STACK', ok: true, observed: 1, threshold: 1, class: 'HARD' },
        ],
      });
    }
    return { eps, outs: eps.map((e, i) => ({ assetId: e.canonicalCoin, decisionKnownAtTs: e.decisionTs, yardstick: { continuation: { state: 'KNOWN', logReturnPct: r + (((i * 7919) % 81) / 100 - 0.4) } } })) };
  };
  const { eps, outs } = mk(260, 0, 0.15, 3.0);
  const fi = testsOf(eps, outs, { nowTs: T0 + 900 * 60_000 }).filter((t) => t.gate === 'FI15');
  assert.equal(fi.length, 260);
  assert.ok(fi.every((t) => t.othersOk === true), 'FI15 alone decided every one of these looks');
  const ev = evaluateUnit(fi, GATE_BANDS.FI15, 0.2, CFG);
  assert.equal(ev.usable, 260);
  assert.ok(ev.move !== null, 'a real, tradable, after-cost cohort still supports a move');
  assert.equal(ev.move.kind, 'LOOSEN');
});

test('FIX93-5: the production evidence bars are what they claim — the cost hurdle is this account\'s real round trip and a cohort needs 30 independent coin-hours', () => {
  // the logic tests in learning-gate-lesson name their own (looser) cluster floor for twelve synthetic coins; this is the guard that
  // the SHIPPED default is not quietly loosened with them. costHurdlePct is the fallback — fly.js derives 1.8 from the running
  // policy's 0.80% taker — and it must never again sit at the superseded 0.4% schedule's 1.0.
  assert.equal(GATE_LESSON_DEFAULTS.minClusters, 30);
  assert.equal(GATE_LESSON_DEFAULTS.costHurdlePct, 1.8);
  assert.equal(GATE_LESSON_DEFAULTS.minScored, 1000);
});
