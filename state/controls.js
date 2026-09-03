// Human controls — born before autonomy. KILL flattens and halts, CAGE stops
// new strikes while exits stay managed, VETO denies one specific trade.
// These are latches, not suggestions: they persist to disk (atomically),
// survive restarts, and every action is appended to a permanent log with
// its timestamp and source (cli / ui).
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { nowIso } from '../lib/time.js';

const controlsFile = () => path.join(dataDir(), 'state', 'controls.json');
const controlLogFile = () => path.join(dataDir(), 'state', 'controls_log.jsonl');

const DEFAULTS = { kill: null, cage: null, vetoes: [] };

export function readControls() {
  const file = controlsFile();
  if (!existsSync(file)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
}

function writeControls(controls, action, source, detail = {}) {
  atomicWriteJson(controlsFile(), controls, { pretty: true });
  appendJsonl(controlLogFile(), { ts: nowIso(), action, source, ...detail }, { sync: true });
  return controls;
}

export function kill(source = 'cli') {
  const c = readControls();
  c.kill = { active: true, ts: nowIso() };
  return writeControls(c, 'KILL', source);
}

export function cage(source = 'cli') {
  const c = readControls();
  c.cage = { active: true, ts: nowIso() };
  return writeControls(c, 'CAGE', source);
}

export function veto(predictionId, source = 'cli') {
  const c = readControls();
  if (!c.vetoes.some((v) => v.prediction_id === predictionId)) {
    c.vetoes.push({ prediction_id: predictionId, ts: nowIso() });
  }
  return writeControls(c, 'VETO', source, { prediction_id: predictionId });
}

export function isVetoed(predictionId) {
  return readControls().vetoes.some((v) => v.prediction_id === predictionId);
}

// Human-only reset of KILL/CAGE latches (vetoes stay — a denied trade stays denied).
export function clearLatches(source = 'cli') {
  const c = readControls();
  c.kill = null;
  c.cage = null;
  return writeControls(c, 'CLEAR_LATCHES', source);
}

export function readControlLog() {
  const file = controlLogFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
