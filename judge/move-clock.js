// THE MOVE CLOCK (PUBLISH-FIX-73, 2026-09-18). David's son's question, in David's words: "if it comes down at 30 minutes every
// time and it's been 28 minutes while evaluated, then it should know not to get into it because it's probably too late."
//
// Two pure functions and one row builder. Nothing here reads the market, the clock or a file; the Judge hands in the bar block it
// already froze for the decision, the decision time, and the lesson the mover study taught (the move-clock lesson reader, composed in fly.js — nothing here imports it).
//
//   moveClockFacts(bars, decisionTs, { minClimbPct })  -> where THIS coin is in its own move: the lowest close of the last hour,
//                                                          how many minutes ago that low was (the move's age), and the climb since.
//                                                          A climb under minClimbPct is not "a move" — the clock does not apply.
//   moveClockVerdict(facts, lesson)                     -> refuse MOVE_TOO_OLD only when the lesson is ARMED (enough movers measured),
//                                                          the coin IS in a move, and the move is at least lesson.lateMin minutes old
//                                                          (the minute by which most measured movers had already topped out).
//   moveClockMeasurements(facts, lesson, verdict)       -> MEASUREMENT rows for the decision record, so "why?" can be answered from
//                                                          the record: the age, the climb, the learned late minute, the lesson state.
//
// Authority: the verdict is a Judge gate like any other clause — it refuses, it never buys. With no port composed the Judge is the
// baseline byte for byte (docs/JUDGE-PAPER-AUDIT.md §4.28).
export const MOVE_CLOCK_VERSION = 'judge-move-clock-1';
export const MOVE_CLOCK_MEASUREMENT_ID = 'MOVE_CLOCK';
export const MOVE_CLOCK_REFUSAL = 'MOVE_TOO_OLD';
// PUBLISH-FIX-81 (independent review cb305c6e F5): the mover study measures low-to-peak over the hour before the event and the
// hour after (up to 120 minutes), but the runtime read the move's age from the last 60 bars only — a learned late minute above 60
// could never be reached, so the gate could never fire. The runtime now reads a two-hour block (the Judge hands it 121 bars when
// its history has them, else the 61-bar setup block): the two clocks measure over the same horizon.
export const MOVE_CLOCK_DEFAULTS = Object.freeze({ minClimbPct: 5, lookbackBars: 120 });
export const MOVE_CLOCK_BARS = 121;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

export function moveClockFacts(bars, decisionTs, { minClimbPct = MOVE_CLOCK_DEFAULTS.minClimbPct, lookbackBars = MOVE_CLOCK_DEFAULTS.lookbackBars } = {}) {
  const none = { state: 'NOT_KNOWN', present: false, ageMin: null, climbPct: null, lowTs: null, lowClose: null, lastClose: null, minClimbPct };
  if (!Array.isArray(bars) || bars.length === 0 || !Number.isSafeInteger(decisionTs)) return none;
  const block = bars.slice(-lookbackBars);
  let low = null;
  for (const b of block) { const c = num(b?.close); if (c === null || c <= 0 || !Number.isSafeInteger(b.periodStartTs)) return none; if (low === null || c < low.close) low = { close: c, periodStartTs: b.periodStartTs }; }
  const last = num(block[block.length - 1].close);
  const climbPct = round2((last / low.close - 1) * 100);
  const ageMin = Math.max(0, Math.floor((decisionTs - low.periodStartTs) / 60_000));
  return { state: 'KNOWN', present: climbPct >= minClimbPct, ageMin, climbPct, lowTs: low.periodStartTs, lowClose: low.close, lastClose: last, minClimbPct };
}

export function moveClockVerdict(facts, lesson) {
  const armed = lesson && lesson.state === 'ARMED' && Number.isFinite(lesson.lateMin) && lesson.lateMin > 0;
  if (!armed) return { ok: true, refused: [], reason: lesson ? `LESSON_${String(lesson.state ?? 'ABSENT')}` : 'LESSON_ABSENT' };
  if (!facts || facts.state !== 'KNOWN') return { ok: true, refused: [], reason: 'FACTS_NOT_KNOWN' };
  if (!facts.present) return { ok: true, refused: [], reason: 'NO_MOVE_IN_PROGRESS' };
  if (facts.ageMin >= lesson.lateMin) return { ok: false, refused: [MOVE_CLOCK_REFUSAL], reason: `MOVE_AGE_${facts.ageMin}_GTE_LATE_${lesson.lateMin}` };
  return { ok: true, refused: [], reason: `MOVE_AGE_${facts.ageMin}_LT_LATE_${lesson.lateMin}` };
}

export function moveClockMeasurements(facts, lesson, verdict) {
  const known = facts && facts.state === 'KNOWN';
  const lateMin = lesson && Number.isFinite(lesson.lateMin) ? lesson.lateMin : null;
  const state = lesson ? String(lesson.state ?? 'ABSENT') : 'ABSENT';
  const movers = lesson && Number.isFinite(lesson.movers) ? lesson.movers : 0;
  const medianMin = lesson && Number.isFinite(lesson.medianMin) ? lesson.medianMin : null;
  return [
    { id: MOVE_CLOCK_MEASUREMENT_ID, ok: Boolean(verdict?.ok), value: known ? facts.ageMin : null, threshold: lateMin, unit: 'minutes', note: `age:${known && facts.present ? 'in-move' : 'no-move'}:lesson=${state}:movers=${movers}:median=${medianMin ?? 'n/a'}:${String(verdict?.reason ?? '').slice(0, 64)}`.slice(0, 120) },
    { id: MOVE_CLOCK_MEASUREMENT_ID, ok: known ? facts.present : false, value: known ? facts.climbPct : null, threshold: known ? facts.minClimbPct : null, unit: 'pct', note: 'climb:from-hour-low' },
  ];
}
