// LEARN-1 §21 — continuous-research acceptance: coverage floors beat hot assets, midnight rolls lose nothing,
// duplicates cannot satisfy the daily target, shed work is exposed, ages reveal starvation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCaptureTick, rotationOrder, rollCounters, emptyDailyCounters, countCapture, coverageAges, MAX_REVISIT_INTERVAL_MS } from '../learning/continuous.js';
import { buildQuestion, transitionQuestion, chargeTrial } from '../learning/questions.js';
import { reconcileCoverage, buildCoverageRow } from '../learning/capture.js';

const T = Date.UTC(2026, 5, 10, 12, 0, 0);

test('21. a high-volume asset cannot starve others: the coverage floor fills in rotation order before ANY change-driven extra', () => {
  const eligible = [
    { symbol: 'HOT', lastCapturedTs: T - 60_000, changed: true },
    ...Array.from({ length: 20 }, (_, i) => ({ symbol: `C${String(i).padStart(2, '0')}C`, lastCapturedTs: null, changed: false })),
  ];
  // HOT already had its floor visit today; capacity 5
  const capturedToday = new Map([['HOT', 3]]);
  const plan = planCaptureTick({ eligible, nowTs: T, capacity: 5, capturedTodayBySymbol: capturedToday });
  assert.equal(plan.selected.length, 5);
  assert.ok(plan.selected.every((s) => s.reason === 'COVERAGE_FLOOR_ROTATION'), 'floor work first');
  assert.ok(!plan.selected.some((s) => s.symbol === 'HOT'), 'the hot asset waits behind the floor');
  assert.equal(plan.shed.extras, 1, 'the shed change-driven extra is exposed');
});

test('21. overload sheds optional extras before baseline coverage, and the shed counts are visible', () => {
  const eligible = Array.from({ length: 10 }, (_, i) => ({ symbol: `A${i}A`, lastCapturedTs: null, changed: i < 5 }));
  const captured = new Map(eligible.map((e) => [e.symbol, 1])); // floor met everywhere
  const plan = planCaptureTick({ eligible, nowTs: T, capacity: 2, capturedTodayBySymbol: captured });
  assert.equal(plan.selected.length, 2);
  assert.ok(plan.selected.every((s) => s.reason === 'SETUP_STATE_CHANGE'));
  assert.equal(plan.shed.extras, 3);
});

test('the rotation is deterministic per UTC date and outcome-independent (order changes across dates, not within one)', () => {
  const symbols = ['AAA', 'BBB', 'CCC', 'DDD'];
  assert.deepEqual(rotationOrder(symbols, '2026-06-10'), rotationOrder(symbols, '2026-06-10'));
  const d1 = rotationOrder(symbols, '2026-06-10'); const d2 = rotationOrder(symbols, '2026-06-11');
  assert.notDeepEqual(d1, d2, 'a different day rotates differently (no permanent favorites)');
});

test('21. midnight rolls the counters without inventing or destroying work: pending state lives in the stores, counters restart cleanly', () => {
  let counters = emptyDailyCounters('2026-06-10');
  countCapture(counters, 'AAA'); countCapture(counters, 'AAA');
  assert.equal(counters.captured, 2);
  const sameDay = rollCounters(counters, Date.UTC(2026, 5, 10, 23, 59, 59));
  assert.equal(sameDay.captured, 2, 'no roll inside the day');
  const nextDay = rollCounters(counters, Date.UTC(2026, 5, 11, 0, 0, 1));
  assert.equal(nextDay.captured, 0);
  assert.equal(nextDay.utcDate, '2026-06-11');
  assert.equal(counters.captured, 2, 'the previous day object is untouched (reported, not erased)');
});

test('21. the daily target cannot be satisfied by duplicate timestamps: the episode store suppresses the same opportunity id (identity = asset+time+recipe+dataset)', () => {
  // covered end-to-end in learning-store.test.js (restart-safe dedupe); here: the counter only advances on a real append
  let counters = emptyDailyCounters('2026-06-10');
  countCapture(counters, 'AAA');
  assert.equal(counters.perAsset.AAA, 1);
});

test('coverage ages expose starvation against the supported revisit bound', () => {
  const ages = coverageAges({ lastCapturedBySymbol: new Map([['AAA', T - 1000], ['BBB', T - 2 * MAX_REVISIT_INTERVAL_MS], ['CCC', null]]), nowTs: T });
  assert.equal(ages.neverCaptured, 1);
  assert.deepEqual(ages.starved, ['BBB']);
  assert.equal(ages.maxSupportedRevisitMs, MAX_REVISIT_INTERVAL_MS);
});

test('21. failed hypotheses stay registered and charged; renaming cannot evade trial accounting (identity is the predicate digest)', () => {
  const q = buildQuestion({ family: 'REJECTION_ANALYSIS', trigger: 'repeated soft skips', predicate: { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 2 }] }, scope: {}, priorityRationale: 'test', assignedBudget: 2, createdTs: T });
  const t1 = chargeTrial(q, { ts: T + 1 }); assert.equal(t1.ok, true);
  const t2 = chargeTrial(t1.question, { ts: T + 2 }); assert.equal(t2.ok, true);
  const t3 = chargeTrial(t2.question, { ts: T + 3 });
  assert.equal(t3.ok, false); assert.equal(t3.reason, 'QUESTION_BUDGET_EXHAUSTED');
  const failed = transitionQuestion(t2.question, { state: 'NOT_SUPPORTED', ts: T + 4, result: { verdict: 'NOT_SUPPORTED' } });
  assert.equal(failed.state, 'NOT_SUPPORTED');
  assert.equal(failed.trialCount, 2, 'the failed trials stay counted');
  // a "renamed" question with the same predicate mints the same identity input (family + digest + createdTs law)
  const renamed = buildQuestion({ family: 'REJECTION_ANALYSIS', trigger: 'totally new idea, honest', predicate: { clauses: [{ feature: 'relVolume60m', op: 'GTE', threshold: 2 }] }, scope: {}, priorityRationale: 'rename', assignedBudget: 2, createdTs: T });
  assert.equal(renamed.questionId, q.questionId, 'same predicate + family + creation clock = same question');
});

test('the coverage ledger reconciles: evaluated + omitted + stale + unavailable + ineligible = the denominator', () => {
  const rows = [
    buildCoverageRow({ sweepId: 's', sweepTs: T, canonicalCoin: 'AAA', attention: 'EVALUATED' }),
    buildCoverageRow({ sweepId: 's', sweepTs: T, canonicalCoin: 'BBB', attention: 'UNAVAILABLE', reasonCode: 'PROVIDER_OUTAGE' }),
    buildCoverageRow({ sweepId: 's', sweepTs: T, canonicalCoin: 'CCC', attention: 'OMITTED_CAPACITY' }),
  ];
  const rec = reconcileCoverage(rows);
  assert.equal(rec.denominator, 3);
  assert.equal(rec.reconciles, true);
  assert.equal(rec.counts.UNAVAILABLE, 1, 'a coin unseen because of an outage is a coverage failure, never a good rejection');
});
