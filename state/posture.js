// Cobra posture machine — Phase C-2.
// Five postures, one resting truth. Every non-demo transition is persisted
// and appended to the transitions log with its cause. STALKING / STRIKE /
// DIGESTING are defined and legal on the map, but no autonomous path may
// enter them until a signal engine exists: outside demo mode they throw
// NotYetImplemented. Demo mode is a sealed terrarium — it never touches disk.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendJsonl } from '../lib/jsonl.js';
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

// The only postures any real code path may enter in C-2.
const REACHABLE_C2 = Object.freeze(new Set(['COILED', 'RETREAT']));

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
    if (!this.demo && !REACHABLE_C2.has(to)) {
      throw new NotYetImplemented(
        `${to} is defined but unreachable in C-2 — no signal engine exists yet (demo mode only)`
      );
    }
    this.posture = to;
    const event = { ts: nowIso(), from, to, cause, demo: this.demo };
    if (!this.demo) {
      mkdirSync(path.dirname(postureFile()), { recursive: true });
      writeFileSync(postureFile(), JSON.stringify({ posture: to, ts: event.ts, cause }, null, 2));
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
