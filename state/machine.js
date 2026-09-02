// Cobra posture machine — STUB for Phase C-1.
// The full enum is reserved now; only COILED and RETREAT are reachable until
// C-2 gives the animal a nervous system. Default posture is COILED: NO TRADE.
import { readControls } from './controls.js';
import { dailyLockStatus } from './locks.js';
import { readTapeStatus, TAPE_STATES } from '../tape/store.js';

export const STATES = Object.freeze({
  COILED: 'COILED', // watching, no position, no pending strike (default)
  STALKING: 'STALKING', // reserved — C-2
  STRIKE: 'STRIKE', // reserved — C-2
  DIGESTING: 'DIGESTING', // reserved — C-2
  RETREAT: 'RETREAT', // halted: KILL, hard lock, or data integrity failure
});

export function getEngineState(config) {
  const reasons = [];
  let state = STATES.COILED;

  const controls = readControls();
  if (controls.kill?.active) {
    state = STATES.RETREAT;
    reasons.push(`KILL active since ${controls.kill.ts}`);
  }

  let locks = null;
  try {
    locks = dailyLockStatus();
    if (locks.level === 'HARD_LOCK') {
      state = STATES.RETREAT;
      reasons.push(`daily HARD_LOCK at ${locks.pnl_pct.toFixed(2)}%`);
    }
  } catch {
    // No ledger yet — that's a fresh snake, not an error.
  }

  const tape = readTapeStatus();
  if (tape && tape.state === TAPE_STATES.DEGRADED) {
    reasons.push('tape DEGRADED — NO TRADE — DATA INTEGRITY');
  }
  if (controls.cage?.active) reasons.push(`CAGE active since ${controls.cage.ts} — no new strikes`);

  return { state, reasons, controls, locks, tape: tape?.state ?? 'ABSENT' };
}
