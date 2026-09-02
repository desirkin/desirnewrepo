// Engine state = the persisted posture machine, synced against reality.
// RETREAT causes in C-2 (wired to what C1-6 already built, not reimplemented):
//   KILL latch, daily HARD_LOCK, tape DEGRADED or OFFLINE.
// A tape that has never run (no status file) is a cobra at rest, not a cobra
// in retreat: COILED, with strikes independently refused by cost/ledger.
import { readControls } from './controls.js';
import { dailyLockStatus } from './locks.js';
import { readTapeStatus, TAPE_STATES } from '../tape/store.js';
import { PostureMachine, POSTURES } from './posture.js';

export const STATES = Object.freeze(Object.fromEntries(POSTURES.map((p) => [p, p])));

// Collect every currently-true RETREAT cause plus advisory reasons.
function assess() {
  const retreatCauses = [];
  const advisories = [];

  const controls = readControls();
  if (controls.kill?.active) {
    retreatCauses.push({ key: 'killed', detail: `KILL active since ${controls.kill.ts}` });
  }

  let locks = null;
  try {
    locks = dailyLockStatus();
    if (locks.level === 'HARD_LOCK') {
      retreatCauses.push({ key: 'daily lock', detail: `daily HARD_LOCK at ${locks.pnl_pct.toFixed(2)}%` });
    }
  } catch {
    // No ledger yet — a fresh snake, not an error.
  }

  const tape = readTapeStatus();
  if (tape) {
    const ageSec = (Date.now() - tape.tsMs) / 1000;
    if (tape.state === TAPE_STATES.DEGRADED || tape.state === TAPE_STATES.OFFLINE) {
      retreatCauses.push({ key: 'data integrity', detail: `tape ${tape.state}` });
    } else if (ageSec > (tape.staleFeedSec ?? 10) * 2) {
      // A dead tape process leaves a frozen LIVE status behind. Frozen = gone.
      retreatCauses.push({ key: 'data integrity', detail: `tape status frozen ${ageSec.toFixed(0)}s ago` });
    }
  }

  if (controls.cage?.active) {
    advisories.push(`CAGE active since ${controls.cage.ts} — no new strikes`);
  }

  return { retreatCauses, advisories, controls, locks, tape };
}

// Sync the persisted machine with reality; logs any transition it causes.
export function syncPosture() {
  const { retreatCauses, advisories, controls, locks, tape } = assess();
  const machine = new PostureMachine();
  let transition = null;
  if (retreatCauses.length && machine.posture !== STATES.RETREAT) {
    transition = machine.transition(STATES.RETREAT, retreatCauses.map((c) => c.detail).join('; '));
  } else if (!retreatCauses.length && machine.posture === STATES.RETREAT) {
    transition = machine.transition(STATES.COILED, 'all retreat causes cleared');
  }
  // Postures beyond COILED/RETREAT cannot be entered by any path here in C-2;
  // if a stale posture file claims one, stand down to the resting truth.
  if (!REACHABLE(machine.posture)) {
    transition = machine.transition(STATES.RETREAT, `unreachable posture ${machine.posture} found persisted`);
  }
  return { machine, transition, retreatCauses, advisories, controls, locks, tape };
}

const REACHABLE = (p) => p === STATES.COILED || p === STATES.RETREAT;

// Same shape C-1 callers (index.js, CLI) already rely on.
export function getEngineState() {
  const { machine, retreatCauses, advisories, controls, locks, tape } = syncPosture();
  return {
    state: machine.posture,
    reasons: [...retreatCauses.map((c) => c.detail), ...advisories],
    retreatCauses,
    controls,
    locks,
    tape: tape?.state ?? 'ABSENT',
    tapeStatus: tape ?? null,
  };
}
