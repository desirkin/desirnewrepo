import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached = null;

export function repoRoot() {
  return ROOT;
}

// PAPER profile overlay (config/paper-runtime.json, selected by COBRA_PROFILE): the profile's configOverlay is deep-merged onto
// cobra.config.json so every reader (fly.js collectors, the CLI, the cockpit) sees ONE composition. A profile may enable
// observation senses; the profile validator refuses overlays touching locks / paper / fees / cost (no threshold change by profile).
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mergeOverlay = (base, overlay) => { if (!plain(overlay)) return base; const out = { ...base }; for (const [k, v] of Object.entries(overlay)) out[k] = plain(v) && plain(base?.[k]) ? mergeOverlay(base[k], v) : v; return out; };
const FORBIDDEN_OVERLAY = ['locks', 'paper', 'fees', 'cost'];
export function profileOverlay(env = process.env) {
  const file = env.COBRA_PROFILE; if (typeof file !== 'string' || !file.length) return null;
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  if (raw?.runtimeMode !== 'PAPER') throw new Error(`COBRA_PROFILE ${file}: runtimeMode must be PAPER`);
  const overlay = plain(raw.configOverlay) ? raw.configOverlay : {};
  for (const k of Object.keys(overlay)) if (FORBIDDEN_OVERLAY.includes(k)) throw new Error(`COBRA_PROFILE ${file}: configOverlay may not touch ${k}`);
  return overlay;
}
export function loadConfig() {
  if (cached) return cached;
  const base = JSON.parse(readFileSync(path.join(ROOT, 'cobra.config.json'), 'utf8'));
  const overlay = profileOverlay();
  cached = overlay ? mergeOverlay(base, overlay) : base;
  return cached;
}
export function resetConfigCache() { cached = null; }

export function dataDir(config = loadConfig()) {
  if (process.env.COBRA_DATA_DIR) return path.resolve(process.env.COBRA_DATA_DIR);
  return path.resolve(ROOT, config.tape.dataDir);
}

// Kraken v2 symbol for a universe coin, e.g. BTC -> "BTC/USD".
export function venueSymbol(coin, config = loadConfig()) {
  return `${coin}/${config.quote}`;
}

export function coinFromSymbol(symbol) {
  return symbol.split('/')[0];
}
