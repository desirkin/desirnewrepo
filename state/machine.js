// Engine state = the persisted posture machine, synced against reality.
// RETREAT causes in C-2 (wired to what C1-6 already built, not reimplemented):
//   KILL latch, daily HARD_LOCK, tape DEGRADED or OFFLINE.
// A tape that has never run (no status file) is a cobra at rest, not a cobra
// in retreat: COILED, with strikes independently refused by cost/ledger.
import { readControls } from './controls.js';
import { dailyLockStatus } from './locks.js';
import { pruneStalking } from './stalking.js';
import { readTapeStatus, TAPE_STATES } from '../tape/store.js';
import { PostureMachine, POSTURES } from './posture.js';
import { readExecutionProjection } from './execution-projection.js';

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

  // JUDGE: the execution projection is READ here, never written. A held
  // position stays visible whatever the posture label says (a RETREAT with
  // exposure is a retreat under Watch, never a flat fiction); a stale or
  // absent projection projects nothing.
  // closeout R16: the projection must be bound (account / run mode / revision) and its revision may never go backwards for
  // the same account within this process; a rejected projection projects nothing and is named
  const execution = readExecutionProjection({ expected: lastProjection ? { accountId: lastProjection.accountId, minRevision: lastProjection.revision } : null });
  if (execution?.state === 'FRESH' || execution?.state === 'STALE') lastProjection = { accountId: execution.accountId, revision: execution.revision };
  if (execution?.state === 'REJECTED') {
    advisories.push(`execution projection REJECTED (${execution.reason}): it projects nothing; the journal is the truth`);
  } else if (execution?.state === 'FRESH' && execution.exposure) {
    advisories.push(`execution exposure: ${execution.openPositions} open position(s), ${execution.pendingEntries} pending entr${execution.pendingEntries === 1 ? 'y' : 'ies'} under Watch (${execution.accountKind} ${execution.accountId})`);
  } else if (execution?.state === 'STALE' && execution.exposure) {
    // recorded exposure whose publisher went quiet: no new strikes until the
    // journal speaks again; the label is RETREAT, the exposure stays named.
    retreatCauses.push({ key: 'execution', detail: `execution projection STALE (${Math.round(execution.ageMs / 1000)}s) with recorded exposure (${execution.openPositions} open, ${execution.pendingEntries} pending) — the Judge process is not publishing; the journal, not this label, is the truth` });
  }

  return { retreatCauses, advisories, controls, locks, tape, execution };
}

// The legal path from the machine's posture to `target`, one logged step at
// a time (COILED -> STALKING -> STRIKE -> DIGESTING -> COILED; RETREAT only
// leaves through COILED). Returns the last transition event.
function walk(machine, target, cause, execution) {
  const NEXT = { COILED: 'STALKING', STALKING: 'STRIKE', STRIKE: 'DIGESTING', DIGESTING: 'COILED', RETREAT: 'COILED' };
  let last = null;
  for (let i = 0; i < 5 && machine.posture !== target; i += 1) {
    const step = machine.can(target) ? target : NEXT[machine.posture];
    last = machine.transition(step, cause, { execution }) ?? last;
  }
  return last;
}

// Sync the persisted machine with reality; logs any transition it causes.
// Precedence: RETREAT causes > live stalk set (RUMINT nominations, arming
// only) > COILED, the resting truth. Nothing here can reach STRIKE.
let lastProjection = null; // the last bound projection this process accepted (account + revision): revisions never go backwards
export function syncPosture() {
  const { retreatCauses, advisories, controls, locks, tape, execution } = assess();
  const stalking = pruneStalking();
  const stalkSymbols = Object.keys(stalking);
  const machine = new PostureMachine();
  let transition = null;
  const projected = execution?.posture ?? null; // STRIKE / DIGESTING only from a FRESH projection with real exposure

  // A persisted posture beyond what any real path can enter is stood down —
  // unless the fresh execution projection still supports it.
  if ((machine.posture === STATES.STRIKE || machine.posture === STATES.DIGESTING) && !projected && execution?.state !== 'FRESH') {
    transition = machine.transition(STATES.RETREAT, `unreachable posture ${machine.posture} found persisted${execution ? ` (execution projection ${execution.state}${execution.exposure ? ', exposure recorded' : ', no exposure'})` : ''}`);
  }

  const target = retreatCauses.length
    ? STATES.RETREAT
    : projected
      ? projected
      : stalkSymbols.length
        ? STATES.STALKING
        : STATES.COILED;

  if (machine.posture !== target) {
    if (target === STATES.RETREAT) {
      transition = machine.transition(STATES.RETREAT, retreatCauses.map((c) => c.detail).join('; '));
    } else if (target === STATES.STRIKE || target === STATES.DIGESTING) {
      transition = walk(machine, target, `execution ${target}: ${execution.openPositions} open, ${execution.pendingEntries} pending entry (journal projection ${execution.accountKind} ${execution.accountId})`, execution);
    } else if (target === STATES.STALKING) {
      if (machine.posture === STATES.RETREAT) {
        transition = machine.transition(STATES.COILED, 'all retreat causes cleared');
      }
      if (machine.posture === STATES.STRIKE || machine.posture === STATES.DIGESTING) {
        transition = walk(machine, STATES.COILED, 'execution flat — position closed', execution);
      }
      transition = machine.transition(STATES.STALKING, `stalking: ${stalkSymbols.join(', ')}`) ?? transition;
    } else {
      transition = machine.posture === STATES.STRIKE || machine.posture === STATES.DIGESTING
        ? walk(machine, STATES.COILED, 'execution flat — position closed', execution)
        : machine.transition(
          STATES.COILED,
          machine.posture === STATES.RETREAT ? 'all retreat causes cleared' : 'stalk set empty — back to rest'
        );
    }
  }
  return { machine, transition, retreatCauses, advisories, controls, locks, tape, stalking, execution };
}

// Same shape C-1 callers (index.js, CLI) already rely on.
export function getEngineState() {
  const { machine, retreatCauses, advisories, controls, locks, tape, stalking, execution } = syncPosture();
  return {
    state: machine.posture,
    reasons: [...retreatCauses.map((c) => c.detail), ...advisories],
    retreatCauses,
    controls,
    locks,
    stalking,
    tape: tape?.state ?? 'ABSENT',
    tapeStatus: tape ?? null,
    // JUDGE: the read-only execution projection (null when the Judge is off)
    execution: execution ?? null,
  };
}
