// Cobra posture machine — Phase C-2.
// Five postures, one resting truth. Every non-demo transition is persisted
// and appended to the transitions log with its cause. STALKING / STRIKE /
// DIGESTING are defined and legal on the map, but no autonomous path may
// enter them until a signal engine exists: outside demo mode they throw
// NotYetImplemented. Demo mode is a sealed terrarium — it never touches disk.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { nowIso } from '../lib/time.js';

export const POSTURES = Object.freeze(['COILED', 'STALKING', 'STRIKE', 'DIGESTING', 'RETREAT']);

// The intended hunt cycle, drawn now so C-3 inherits the map, not a rewrite.
// RETREAT is reachable from everywhere; only COILED leaves it.
const LEGAL = Object.freeze({
  COILED: ['STALKING', 'RETREAT'],
  STALKING: ['STRIKE', 'COILED', 'RETREAT'],
  STRIKE: ['DIGESTING', 'RETREAT'],
  DIGESTING: ['COILED', 'RETREAT'],
  RETREAT: ['COILED'],
});

// Postures a real code path may enter. S-2b opened STALKING to exactly one
// door: RUMINT nomination (arming only). STRIKE and DIGESTING stay locked
// until a real confirmation engine exists — there is still no path to a
// strike anywhere in this codebase.
const REACHABLE = Object.freeze(new Set(['COILED', 'STALKING', 'RETREAT']));

export class IllegalTransition extends Error {}
export class NotYetImplemented extends Error {}

const postureFile = () => path.join(dataDir(), 'state', 'posture.json');
const transitionsFile = () => path.join(dataDir(), 'state', 'transitions.jsonl');

function readPersistedPosture() {
  const file = postureFile();
  if (!existsSync(file)) return 'COILED'; // the resting truth needs no file
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  return POSTURES.includes(saved.posture) ? saved.posture : 'COILED';
}

export class PostureMachine {
  constructor({ demo = false } = {}) {
    this.demo = demo;
    this.posture = demo ? 'COILED' : readPersistedPosture();
  }

  can(to) {
    return LEGAL[this.posture].includes(to);
  }

  // Returns the transition event, or null when already in `to` (no-op, not
  // logged — posture holds are not events).
  transition(to, cause) {
    const from = this.posture;
    if (!POSTURES.includes(to)) throw new IllegalTransition(`unknown posture ${to}`);
    if (from === to) return null;
    if (!LEGAL[from].includes(to)) {
      throw new IllegalTransition(`illegal transition ${from} -> ${to}`);
    }
    if (!this.demo && !REACHABLE.has(to)) {
      throw new NotYetImplemented(
        `${to} is defined but unreachable — no confirmation/strike engine exists yet (demo mode only)`
      );
    }
    this.posture = to;
    const event = { ts: nowIso(), from, to, cause, demo: this.demo };
    if (!this.demo) {
      atomicWriteJson(postureFile(), { posture: to, ts: event.ts, cause }, { pretty: true });
      appendJsonl(transitionsFile(), event);
    }
    return event;
  }
}

export function readTransitionsLog() {
  const file = transitionsFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
