// Human controls — born before autonomy. KILL flattens and halts, CAGE stops
// new strikes while exits stay managed, VETO denies one specific trade.
// These are latches, not suggestions: they persist to disk (atomically),
// survive restarts, and every action is appended to a permanent log with
// its timestamp and source (cli / ui).
//
// PERSIST-0C: the actual read/validate/lock/mutate semantics live in ONE
// authority — state/control-store.js. These public functions remain as the
// compatibility surface; a corrupt local mirror can no longer crash KILL
// (it fail-closes toward restriction instead), and mutations are
// serialized across processes so concurrent restrictions merge rather
// than cancel each other.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { dataDir } from '../lib/config.js';
import {
  readControls as storeRead,
  killLocal,
  cageLocal,
  vetoLocal,
  clearLatchesLocal,
} from './control-store.js';

const controlLogFile = () => path.join(dataDir(), 'state', 'controls_log.jsonl');

export function readControls() {
  return storeRead();
}

export function kill(source = 'cli') {
  return killLocal(source).state;
}

export function cage(source = 'cli') {
  return cageLocal(source).state;
}

export function veto(predictionId, source = 'cli') {
  return vetoLocal(predictionId, source).state;
}

export function isVetoed(predictionId) {
  return readControls().vetoes.some((v) => v.prediction_id === predictionId);
}

// Human-only reset of KILL/CAGE latches (vetoes stay — a denied trade stays
// denied). This is the raw LOCAL primitive; the durable permission-increase
// gate lives in persistence/control-plane.js requestClear().
export function clearLatches(source = 'cli') {
  return clearLatchesLocal(source).state;
}

export function readControlLog() {
  const file = controlLogFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
