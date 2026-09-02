// Human controls — born before autonomy. KILL flattens and halts, CAGE stops
// new strikes while exits stay managed, VETO denies one specific trade.
// These are latches, not suggestions: they persist to disk and survive restarts.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dataDir } from '../lib/config.js';
import { nowIso } from '../lib/time.js';

const controlsFile = () => path.join(dataDir(), 'state', 'controls.json');

const DEFAULTS = { kill: null, cage: null, vetoes: [] };

export function readControls() {
  const file = controlsFile();
  if (!existsSync(file)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
}

function writeControls(controls) {
  mkdirSync(path.dirname(controlsFile()), { recursive: true });
  writeFileSync(controlsFile(), JSON.stringify(controls, null, 2));
  return controls;
}

export function kill() {
  const c = readControls();
  c.kill = { active: true, ts: nowIso() };
  return writeControls(c);
}

export function cage() {
  const c = readControls();
  c.cage = { active: true, ts: nowIso() };
  return writeControls(c);
}

export function veto(predictionId) {
  const c = readControls();
  if (!c.vetoes.some((v) => v.prediction_id === predictionId)) {
    c.vetoes.push({ prediction_id: predictionId, ts: nowIso() });
  }
  return writeControls(c);
}

export function isVetoed(predictionId) {
  return readControls().vetoes.some((v) => v.prediction_id === predictionId);
}

// Human-only reset of KILL/CAGE latches (vetoes stay — a denied trade stays denied).
export function clearLatches() {
  const c = readControls();
  c.kill = null;
  c.cage = null;
  return writeControls(c);
}
