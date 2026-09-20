// PUBLISH-FIX-84 (review c6985361 F2/F3, 2026-09-20). F2: a KILL written to data/learning/kill.json took effect only at the next
// scheduled refresh; the Judge's cached lines stayed live meanwhile. Now the port re-reads the kill file on the Judge's own reads,
// at most every 5 s. F3: a lesson older than 7 days (the study stopped) counted as a lesson; now it is reference lines with a STALE line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateLesson, GATE_LESSON_VERSION, gateLessonPaths } from '../learning/gate-lesson.js';

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
