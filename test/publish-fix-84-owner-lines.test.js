// PUBLISH-FIX-84 (2026-09-20, the owner's night) — OWNER LINES. The learner moves a line only from looks where every other gate
// passed; with the median look failing four or five gates at once those looks arrive at a few dozen a day against a 1,000 minimum,
// so the autonomous mover is starved. The owner can set the flow lines himself by NAME (SERPENT_OWNER_GATE_LINES, JSON), inside the
// learner's bands, through the same port the Judge reads: outranks a learned line, survives the kill file, logged and named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseOwnerGateLines, createGateLesson, gateLessonPaths, GATE_LESSON_VERSION, GATE_BANDS, OWNER_GATE_LINES_ENV } from '../learning/gate-lesson.js';
import { learnedLine } from '../judge/setups.js';

test('FIX84-OL1. parseOwnerGateLines: learnable gates only, numbers only, clamped to the band, everything else named and ignored; empty / bad JSON is no lines', () => {
  assert.deepEqual(parseOwnerGateLines(''), { lines: {}, rejected: [] });
  assert.deepEqual(parseOwnerGateLines(undefined), { lines: {}, rejected: [] });
  assert.match(parseOwnerGateLines('{nope').rejected[0], /not JSON/);
  assert.match(parseOwnerGateLines('[1]').rejected[0], /not an object/);
  const r = parseOwnerGateLines(JSON.stringify({ FI15: -1, FI60_POSITIVE: -1, RECLAIM_FI15: -1, FI15_FRESH_AT_D: -1, RV60: 0, PRIOR_MID_RESPONSE_SMALL: 0, FI15X: 'abc', }));
  assert.deepEqual(r.lines, { FI15: -1, FI60_POSITIVE: -1, RECLAIM_FI15: -1, FI15_FRESH_AT_D: -1, RV60: 0 });
  assert.equal(r.rejected.length, 2); assert.match(r.rejected[0], /PRIOR_MID_RESPONSE_SMALL: not a learnable gate/); assert.match(r.rejected[1], /FI15X: not a learnable gate/);
  const c = parseOwnerGateLines(JSON.stringify({ FI15: -5, RV60: 9, FI60_POSITIVE: 'x' }));
  assert.deepEqual(c.lines, { FI15: GATE_BANDS.FI15.min, RV60: GATE_BANDS.RV60.max }); assert.equal(c.rejected.length, 3);
  assert.equal(OWNER_GATE_LINES_ENV, 'SERPENT_OWNER_GATE_LINES');
});

test('FIX84-OL2. the lesson port: an owner line outranks a learned one, rides beside learned lines it does not name, survives the kill file, and is logged at boot and in the line', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fix84-owner-')); const P = gateLessonPaths(root); mkdirSync(P.dir, { recursive: true });
  try {
    writeFileSync(P.lesson, JSON.stringify({ version: GATE_LESSON_VERSION, computedTs: 1, cfg: {}, tests: 1, lines: { FI15: 0.1, RV60: { RANGE_IGNITION: 1.5 } }, units: {} }));
    const logs = []; const lesson = createGateLesson({ dataDir: root, log: (l) => logs.push(String(l)), ownerLines: '{"FI15":-1,"FI60_POSITIVE":-1,"RV60":0}' }); lesson.refresh();
    assert.ok(logs.some((l) => l.startsWith('GATE LINES: OWNER-SET FI15 -1') && l.includes('FI60_POSITIVE -1') && l.includes('RV60 0') && l.includes('band -1..0.5')), logs.join('\n'));
    assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: -1, RV60: 0, FI60_POSITIVE: -1 }, 'owner FI15 -1 outranks learned 0.1; owner RV60 0 outranks the learned per-setup 1.5');
    assert.deepEqual(lesson.lesson('ABSORPTION_RECLAIM'), { FI15: -1, FI60_POSITIVE: -1, RV60: 0 });
    assert.match(lesson.line(), /OWNER LINES in force: FI15 -1, FI60_POSITIVE -1, RV60 0/);
    // the kill file silences learned influence, never the owner's
    writeFileSync(path.join(root, 'learning', 'kill.json'), JSON.stringify({ state: 'KILLED', reason: 'owner', ts: 1 })); lesson.refresh();
    assert.deepEqual(lesson.lesson('RANGE_IGNITION'), { FI15: -1, FI60_POSITIVE: -1, RV60: 0 }); assert.match(lesson.line(), /KILLED.*OWNER LINES in force/);
    // the Judge's own band check accepts every owner line (they were clamped to the same bands)
    for (const [id, v] of Object.entries(lesson.ownerLines())) assert.equal(learnedLine(lesson.lesson('RANGE_IGNITION'), id, 99), v, id);
    // no owner lines: nothing changes, nothing logged
    const plainLogs = []; const plain = createGateLesson({ dataDir: root, log: (l) => plainLogs.push(String(l)) }); plain.refresh();
    assert.ok(!plainLogs.some((l) => l.includes('OWNER')), plainLogs.join('\n')); assert.equal(typeof plain.ownerLines, 'function'); assert.deepEqual(plain.ownerLines(), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
