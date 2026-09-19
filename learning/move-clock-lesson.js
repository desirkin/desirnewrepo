// THE MOVE CLOCK LESSON (PUBLISH-FIX-73, 2026-09-18). What the mover study teaches the Judge about TIME: measured over the
// last days' movers (every >=10%/hour climb the study recorded, with its move clock — learning/mover-study.js pictureAt), how many
// minutes it took from the move's low to its top. The Judge's move-clock gate (judge/move-clock.js) refuses a look at a coin
// whose own move is already that old: "moves like this usually top out around minute N; this one is at minute N+2 — too late."
//
// The lesson is DORMANT until at least ARM_AT movers carry a move clock (records written before fix73 have none, so the count
// starts at zero and grows with the study), then ARMED with lateMin = the 75th percentile of minutes-low-to-peak (three of four
// measured movers had topped out by then) and medianMin for the record. Bounded read (7 daily files, best effort, never throws
// past its own log line); authority NONE — it only hands the Judge a number the Judge's own gate compares against.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const MOVE_CLOCK_LESSON_VERSION = 'learning-move-clock-lesson-1';
export const MOVE_CLOCK_LESSON_DEFAULTS = Object.freeze({ days: 7, armAt: 20, minClimbPct: 5, latePercentile: 0.75, floorMin: 5, refreshMs: 5 * 60_000 });
const DAY = 86_400_000;
const utcDateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

function percentile(sorted, p) { if (!sorted.length) return null; const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)); return sorted[idx]; }

// pure: the lesson from a list of study records (any kind; only MOVER records with a finite move clock count)
export function moveClockLessonOf(records, { armAt = MOVE_CLOCK_LESSON_DEFAULTS.armAt, minClimbPct = MOVE_CLOCK_LESSON_DEFAULTS.minClimbPct, latePercentile = MOVE_CLOCK_LESSON_DEFAULTS.latePercentile, floorMin = MOVE_CLOCK_LESSON_DEFAULTS.floorMin, nowTs = Date.now(), days = MOVE_CLOCK_LESSON_DEFAULTS.days } = {}) {
  const mins = [];
  for (const r of records ?? []) {
    if (!r || r.kind !== 'MOVER') continue;
    const m = r.moveClock?.minutesLowToPeak;
    if (!Number.isFinite(m) || m < 0) continue;
    mins.push(m);
  }
  mins.sort((a, b) => a - b);
  const movers = mins.length;
  const medianMin = percentile(mins, 0.5);
  const p75Min = percentile(mins, latePercentile);
  const armed = movers >= armAt && Number.isFinite(p75Min);
  return { version: MOVE_CLOCK_LESSON_VERSION, state: armed ? 'ARMED' : 'DORMANT', movers, armAt, medianMin, p75Min, lateMin: armed ? Math.max(floorMin, Math.round(p75Min)) : null, minClimbPct, days, refreshedTs: nowTs, authority: 'NONE' };
}

export function createMoveClockLesson({ dataDir, clock = () => Date.now(), log = () => {}, options = {} } = {}) {
  const cfg = { ...MOVE_CLOCK_LESSON_DEFAULTS, ...options };
  const dir = path.join(dataDir, 'learning', 'mover-study');
  let lesson = moveClockLessonOf([], { ...cfg, nowTs: clock() });
  let lastLogged = null;
  function readDays(nowTs) {
    const out = [];
    for (let d = 0; d < cfg.days; d += 1) {
      const f = path.join(dir, `${utcDateOf(nowTs - d * DAY)}.jsonl`);
      if (!existsSync(f)) continue;
      let text = ''; try { text = readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) { if (!line) continue; try { const r = JSON.parse(line); if (r && r.kind === 'MOVER') out.push(r); } catch { /* a torn line is skipped */ } }
    }
    return out;
  }
  function refresh() {
    const nowTs = clock();
    try { lesson = moveClockLessonOf(readDays(nowTs), { ...cfg, nowTs }); }
    catch (err) { log(`MOVE CLOCK lesson refresh failed (previous lesson kept): ${String(err?.message ?? err).slice(0, 160)}`); return lesson; }
    const key = `${lesson.state}:${lesson.movers}:${lesson.lateMin}`;
    if (key !== lastLogged) { lastLogged = key; log(line()); }
    return lesson;
  }
  function line() {
    const l = lesson;
    if (l.state !== 'ARMED') return `MOVE CLOCK: DORMANT (${l.movers} of ${l.armAt} movers measured over ${l.days} days; the Judge records each look's move age but refuses nothing on it yet)`;
    return `MOVE CLOCK: ARMED from ${l.movers} movers — a move typically tops out at minute ${l.medianMin} (three of four by minute ${l.p75Min}); the Judge refuses a coin whose own move is ${l.lateMin}+ minutes old (MOVE_TOO_OLD)`;
  }
  return { refresh, lesson: () => lesson, line, status: () => ({ ...lesson, config: { ...cfg } }) };
}
