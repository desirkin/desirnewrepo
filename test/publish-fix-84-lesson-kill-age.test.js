// PUBLISH-FIX-84 (review c6985361 F2/F3, 2026-09-20). F2: a KILL written to data/learning/kill.json took effect only at the next
// scheduled refresh; the Judge's cached lines stayed live meanwhile. Now the port re-reads the kill file on the Judge's own reads,
// at most every 5 s. F3: a lesson older than 7 days (the study stopped) counted as a lesson; now it is reference lines with a STALE line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateLesson, GATE_LESSON_VERSION, gateLessonPaths, testsOf } from '../learning/gate-lesson.js';

function root(computedTs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix84-lesson-')); const P = gateLessonPaths(dir);
  fs.mkdirSync(P.dir, { recursive: true });
  fs.writeFileSync(P.lesson, JSON.stringify({ version: GATE_LESSON_VERSION, computedTs, lines: { FI15: 0.2 }, units: {}, cfg: { minScored: 1, minForward: 1 } }));
  return { dir, P, kill: path.join(dir, 'learning', 'kill.json') };
}

test('FIX84-L1 (F2). a KILL is seen on the Judge\'s next read within 5 s, without a refresh; RESUME likewise', () => {
  let now = 1_000_000_000_000; const r = root(now - 60_000); const logs = [];
  const lesson = createGateLesson({ dataDir: r.dir, clock: () => now, log: (l) => logs.push(String(l)) }); lesson.refresh();
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: 0.2 });
  fs.writeFileSync(r.kill, JSON.stringify({ state: 'KILLED', reason: 'owner' }));
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: 0.2 }, 'inside the 5 s window the cached answer stands (one stat per 5 s, not per look)');
  now += 5_000;
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), {}, 'after the window the kill is in force with no refresh');
  assert.ok(logs.some((l) => l.includes('KILLED')), logs.join('\n'));
  fs.writeFileSync(r.kill, JSON.stringify({ state: 'ARMED' })); now += 5_000;
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: 0.2 }, 'and RESUME is seen the same way');
});

test('FIX84-L2 (F3). a lesson older than the age limit is reference lines, logged STALE; a fresh one is in force', () => {
  const now = 1_000_000_000_000; const r = root(now - 8 * 24 * 3_600_000); const logs = [];
  const lesson = createGateLesson({ dataDir: r.dir, clock: () => now, log: (l) => logs.push(String(l)) }); lesson.refresh();
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), {});
  assert.equal(lesson.current().stale?.ageMs, 8 * 24 * 3_600_000);
  assert.match(lesson.line(), /lesson STALE — computed 192 h ago, older than 168 h/);
  const fresh = root(now - 6 * 24 * 3_600_000); const l2 = createGateLesson({ dataDir: fresh.dir, clock: () => now }); l2.refresh();
  assert.deepEqual(l2.lesson('RANGE_IGNITION'), { FI15: 0.2 });
});

test('FIX89-L3 (blind review 864b4c3a F3). a future-dated lesson is rejected on read; a lesson that ages past the limit between refreshes drops on the next read, not the next refresh', () => {
  let now = 1_000_000_000_000; const r = root(now + 24 * 3_600_000); const logs = [];
  const lesson = createGateLesson({ dataDir: r.dir, clock: () => now, log: (l) => logs.push(String(l)) }); lesson.refresh();
  assert.deepEqual(lesson.lesson('RANGE_IGNITION'), {}, 'a lesson from tomorrow is not a lesson');
  assert.match(lesson.line(), /REJECTED — computedTs is \d+ min in the FUTURE/);
  // a sane lesson, then time passes beyond the limit with no refresh
  const fresh = root(now - 60_000); const l2 = createGateLesson({ dataDir: fresh.dir, clock: () => now, maxLessonAgeMs: 3_600_000 }); l2.refresh();
  assert.deepEqual(l2.lesson('RANGE_IGNITION'), { FI15: 0.2 });
  now += 3_600_000 + 61_000;
  assert.deepEqual(l2.lesson('RANGE_IGNITION'), {}, 'aged out on the read itself'); assert.match(l2.line(), /lesson STALE/);
});

test('FIX91 -> FIX93 (review F1). the flow-family view is REPORTED (familyOk) but only a look this gate alone decided is EVIDENCE (othersOk): a sibling flow gate failing excludes it from the count, exactly as a structural refusal does', () => {
  const T0 = 1_000_000_000_000;
  const ep = (i, gates) => ({ datasetId: 'live-judge-x', canonicalCoin: 'AAA', decisionTs: T0 + i * 60_000, setupType: 'RANGE_IGNITION', gates });
  const g = (id, ok, observed, threshold) => ({ id, ok, observed, threshold });
  const episodes = [
    ep(1, [g('FI15', false, -0.5, 0.2), g('FI60_POSITIVE', false, -0.1, 0), g('RV60', false, 0.8, 1), g('RANGE_BREAK', true, 1, 1)]), // flow family fails together, structure OK
    ep(2, [g('FI15', false, -0.5, 0.2), g('RANGE_BREAK', false, 0, 1)]),                                                             // a structural refusal
    ep(3, [g('FI15', true, 0.5, 0.2), g('RV60', true, 1.5, 1), g('RANGE_BREAK', true, 1, 1)]),                                       // passed
  ];
  const outcomes = episodes.map((e) => ({ assetId: 'AAA', decisionKnownAtTs: e.decisionTs, yardstick: { continuation: { state: 'KNOWN', logReturnPct: 1 }, bite: { state: 'KNOWN', logReturnPct: 0.5 } } }));
  const tests = testsOf(episodes, outcomes, { nowTs: T0 + 3_600_000 });
  const fi15 = tests.filter((t) => t.gate === 'FI15').map((t) => [t.ts, t.othersOk, t.familyOk]);
  // PUBLISH-FIX-93: FIX-91 counted look 1 as evidence for FI15 even though RV60 and FI60_POSITIVE refused it too. A promotion moves ONE
  // line, so that look would still not trade — it is reported in the family view and never counted. Look 2 is a structural refusal
  // (excluded from both). Look 3 passed everything, so FI15 alone decided it.
  assert.deepEqual(fi15, [[T0 + 60_000, false, true], [T0 + 120_000, false, false], [T0 + 180_000, true, true]], JSON.stringify(tests));
});
