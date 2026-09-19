// PUBLISH-FIX-73: the move clock — "moves like this usually top out around minute N; this look is at minute N+2 — too late."
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { moveClockFacts, moveClockVerdict, moveClockMeasurements, MOVE_CLOCK_MEASUREMENT_ID, MOVE_CLOCK_REFUSAL } from '../judge/move-clock.js';
import { moveClockLessonOf, createMoveClockLesson, MOVE_CLOCK_LESSON_VERSION } from '../learning/move-clock-lesson.js';

const END = Date.UTC(2026, 8, 18, 20, 0, 0);
// 61 closed one-minute bars ending at END; closes from a function of the bar's index (0 = oldest)
const bars = (closeAt) => Array.from({ length: 61 }, (_, i) => { const c = closeAt(i); return { periodStartTs: END - (61 - i) * 60_000, periodEndTs: END - (60 - i) * 60_000, open: c, high: c * 1.001, low: c * 0.999, close: c, volumeQuote: 1000, volumeBase: 0.01, closed: true }; });

test('MC-01. facts: the move is measured from the lowest close of the lookback (two hours since fix81; 60 bars when asked) — its age in minutes at the decision and the climb since; under the minimum climb there is no move; a bad block is NOT_KNOWN', () => {
  const flat = moveClockFacts(bars(() => 100), END + 5_000); assert.equal(flat.state, 'KNOWN'); assert.equal(flat.present, false); assert.equal(flat.climbPct, 0);
  // the low sits 20 bars before the end (index 40 of 61): 100 -> 108 = +8% climb, 20 minutes + the 5 s past the last close = age 21
  const move = moveClockFacts(bars((i) => (i === 40 ? 100 : i > 40 ? 108 : 104)), END + 5_000);
  assert.equal(move.present, true); assert.equal(move.climbPct, 8); assert.equal(move.ageMin, 21); assert.equal(move.lowTs, END - 21 * 60_000); assert.equal(move.lowClose, 100); assert.equal(move.lastClose, 108);
  const small = moveClockFacts(bars((i) => (i === 40 ? 100 : 103)), END + 5_000); assert.equal(small.present, false, '3% from the hour low is not a move (minimum 5%)'); assert.equal(small.climbPct, 3);
  assert.equal(moveClockFacts(bars((i) => (i === 40 ? 100 : 103)), END + 5_000, { minClimbPct: 2 }).present, true, 'the minimum climb is the lesson\'s');
  // PUBLISH-FIX-81: the lookback is two hours (the mover study's own low-to-peak horizon); with a 61-bar block the whole block is the
  // window, so a lower close 61 bars back IS the low; passed lookbackBars 60 explicitly, it is outside the hour as before
  const old = moveClockFacts(bars((i) => (i === 0 ? 50 : 100)), END + 5_000); assert.equal(old.present, true); assert.equal(old.climbPct, 100); assert.equal(old.ageMin, 61);
  const hour = moveClockFacts(bars((i) => (i === 0 ? 50 : 100)), END + 5_000, { lookbackBars: 60 }); assert.equal(hour.present, false); assert.equal(hour.climbPct, 0);
  // a 121-bar block: a low 100 minutes back is measured (age 101) — the horizon the runtime could not see before fix81
  const two = Array.from({ length: 121 }, (_, i) => ({ periodStartTs: END - (121 - i) * 60_000, periodEndTs: END - (120 - i) * 60_000, open: 100, high: 110, low: 90, close: i === 20 ? 100 : 108, volume: 1, knownAtTs: END - (120 - i) * 60_000 }));
  const far = moveClockFacts(two, END + 5_000); assert.equal(far.present, true); assert.equal(far.ageMin, 101); assert.equal(far.climbPct, 8);
  assert.equal(moveClockFacts(null, END).state, 'NOT_KNOWN'); assert.equal(moveClockFacts([], END).state, 'NOT_KNOWN'); assert.equal(moveClockFacts([{ periodStartTs: END, close: null }], END).state, 'NOT_KNOWN');
});

test('MC-02. verdict: refuses MOVE_TOO_OLD only when the lesson is ARMED, the coin is in a move, and the move is at least lateMin old; DORMANT / absent lessons never refuse; the measurement rows carry the age, the climb and the lesson', () => {
  const inMove = { state: 'KNOWN', present: true, ageMin: 31, climbPct: 12, minClimbPct: 5 };
  const armed = { state: 'ARMED', lateMin: 30, medianMin: 22, movers: 25 };
  assert.deepEqual(moveClockVerdict(inMove, armed).refused, [MOVE_CLOCK_REFUSAL]); assert.match(moveClockVerdict(inMove, armed).reason, /MOVE_AGE_31_GTE_LATE_30/);
  assert.equal(moveClockVerdict({ ...inMove, ageMin: 30 }, armed).ok, false, 'at the late minute itself it is too late');
  assert.equal(moveClockVerdict({ ...inMove, ageMin: 29 }, armed).ok, true, 'one minute earlier is allowed');
  assert.equal(moveClockVerdict({ ...inMove, present: false }, armed).ok, true, 'no move in progress: the clock does not apply');
  assert.equal(moveClockVerdict(inMove, { state: 'DORMANT', lateMin: null, movers: 3 }).ok, true); assert.equal(moveClockVerdict(inMove, null).ok, true); assert.equal(moveClockVerdict({ state: 'NOT_KNOWN' }, armed).ok, true);
  const rows = moveClockMeasurements(inMove, armed, moveClockVerdict(inMove, armed));
  assert.equal(rows.length, 2); assert.equal(rows[0].id, MOVE_CLOCK_MEASUREMENT_ID); assert.equal(rows[0].ok, false); assert.equal(rows[0].value, 31); assert.equal(rows[0].threshold, 30); assert.equal(rows[0].unit, 'minutes'); assert.match(rows[0].note, /age:in-move:lesson=ARMED:movers=25:median=22/);
  assert.equal(rows[1].value, 12); assert.equal(rows[1].threshold, 5); assert.equal(rows[1].unit, 'pct'); assert.equal(rows[1].ok, true);
  const dormantRows = moveClockMeasurements({ state: 'NOT_KNOWN' }, null, moveClockVerdict({ state: 'NOT_KNOWN' }, null)); assert.equal(dormantRows[0].value, null); assert.equal(dormantRows[0].threshold, null); assert.equal(dormantRows[0].ok, true); assert.match(dormantRows[0].note, /lesson=ABSENT/);
});

test('MC-03. the lesson: DORMANT under 20 measured movers; ARMED at 20 with lateMin = the 75th percentile of minutes-low-to-peak (floor 5); MOVER records with a move clock count, and (fix80) the day-board climbs at/above minClimbPct; the reader takes the last 7 daily files and survives torn lines and missing files', () => {
  const mover = (m, extra = {}) => ({ kind: 'MOVER', coin: 'X', climbPct: 12, moveClock: { minutesLowToPeak: m }, ...extra });
  const d = moveClockLessonOf([mover(10), mover(20), mover(30)], { nowTs: END }); assert.equal(d.state, 'DORMANT'); assert.equal(d.movers, 3); assert.equal(d.lateMin, null); assert.equal(d.medianMin, 20); assert.equal(d.version, MOVE_CLOCK_LESSON_VERSION);
  const twenty = Array.from({ length: 20 }, (_, i) => mover(i + 1)); // 1..20 minutes
  const a = moveClockLessonOf([...twenty, { kind: 'CONTROL', moveClock: { minutesLowToPeak: 300 } }, mover(NaN), { kind: 'MOVER', hourAfter: {} }], { nowTs: END });
  assert.equal(a.state, 'ARMED'); assert.equal(a.movers, 20, 'controls, NaN clocks and pre-fix73 movers without a clock never count'); assert.equal(a.medianMin, 10); assert.equal(a.p75Min, 15); assert.equal(a.lateMin, 15); assert.equal(a.minClimbPct, 5);
  assert.equal(moveClockLessonOf(Array.from({ length: 20 }, () => mover(2)), { nowTs: END }).lateMin, 5, 'the floor');
  // PUBLISH-FIX-80: a day's-board entry (DAILY_TOP) counts when its climb reaches the clock's minClimbPct; a smaller one does not
  const top = (m, climb) => ({ kind: 'DAILY_TOP', coin: 'Y', climbPct: climb, moveClock: { minutesLowToPeak: m } });
  const t = moveClockLessonOf([mover(10), top(20, 7.5), top(30, 5), top(99, 4.9), { kind: 'DAILY_TOP_CONTROL', climbPct: 9, moveClock: { minutesLowToPeak: 99 } }], { nowTs: END });
  assert.equal(t.movers, 3, 'the mover and the two board climbs at/above 5%'); assert.equal(t.medianMin, 20);
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-move-clock-'));
  try {
    const sub = path.join(dir, 'learning', 'mover-study'); mkdirSync(sub, { recursive: true });
    const day = (offset) => new Date(END - offset * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(path.join(sub, `${day(0)}.jsonl`), [JSON.stringify(mover(40)), 'torn {', JSON.stringify(mover(44))].join('\n') + '\n');
    writeFileSync(path.join(sub, `${day(3)}.jsonl`), Array.from({ length: 18 }, (_, i) => JSON.stringify(mover(20 + i))).join('\n') + '\n');
    writeFileSync(path.join(sub, `${day(9)}.jsonl`), Array.from({ length: 50 }, () => JSON.stringify(mover(120))).join('\n') + '\n'); // older than 7 days: never read
    const logs = []; const reader = createMoveClockLesson({ dataDir: dir, clock: () => END, log: (l) => logs.push(l) });
    assert.equal(reader.lesson().state, 'DORMANT'); const l = reader.refresh();
    assert.equal(l.state, 'ARMED'); assert.equal(l.movers, 20); assert.equal(l.p75Min, 34, "sorted 20..37, 40, 44: the 15th of 20 is 34"); assert.equal(l.lateMin, 34); assert.match(logs.at(-1), /MOVE CLOCK: ARMED from 20 movers .* refuses a coin whose own move is 34\+ minutes old/);
    reader.refresh(); assert.equal(logs.length, 1, 'an unchanged lesson is not logged again');
    // PUBLISH-FIX-81 (review F4): the learned-influence kill file switches the clock to baseline; an invalid file fails toward baseline too
    mkdirSync(path.join(dir, 'learning'), { recursive: true });
    writeFileSync(path.join(dir, 'learning', 'kill.json'), JSON.stringify({ state: 'KILLED', reason: 'owner baseline', ts: END }));
    const k = reader.refresh(); assert.equal(k.state, 'DORMANT'); assert.equal(k.lateMin, null); assert.equal(k.movers, 20, 'still measured, not applied'); assert.deepEqual(k.killed, { reason: 'owner baseline' }); assert.match(logs.at(-1), /MOVE CLOCK: DORMANT — learned influence KILLED \(data\/learning\/kill.json: owner baseline\)/);
    writeFileSync(path.join(dir, 'learning', 'kill.json'), '{ not json'); assert.equal(reader.refresh().state, 'DORMANT'); assert.equal(reader.lesson().killed.reason, 'KILL_FILE_UNREADABLE');
    writeFileSync(path.join(dir, 'learning', 'kill.json'), JSON.stringify({ state: 'ARMED', reason: null, ts: END })); assert.equal(reader.refresh().state, 'ARMED'); assert.equal(reader.lesson().killed, undefined);
    const bare = createMoveClockLesson({ dataDir: path.join(dir, 'nowhere'), clock: () => END, log: (l) => logs.push(l) }); bare.refresh(); assert.equal(bare.lesson().state, 'DORMANT'); assert.match(bare.line(), /DORMANT \(0 of 20 movers/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
