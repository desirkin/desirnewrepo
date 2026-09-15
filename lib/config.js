import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

// PUBLISH-FIX-1 — data-dir generation. A Replit republish does NOT wipe the deployment VM disk, so the previous app's data,
// locks and journals are still there. The runtime writes under <COBRA_DATA_DIR>/<generation> so a new generation is a clean
// crib on an old disk; bump SERPENT_DATA_GENERATION (gen1 -> gen2 -> …) for a future fresh start. An unset/empty generation
// keeps the flat legacy layout (the layout every test uses); a set-but-malformed value fails closed rather than silently
// mixing generations. `.replit` provides SERPENT_DATA_GENERATION=gen1 in production.
export function dataGeneration(env = process.env) {
  const raw = env.SERPENT_DATA_GENERATION;
  if (raw === undefined || raw === null || String(raw).trim() === '') return '';
  const g = String(raw).trim();
  if (!GENERATION_RE.test(g)) throw new Error(`SERPENT_DATA_GENERATION must be a safe directory name (letters, digits, . _ -; <=64 chars); got ${JSON.stringify(g).slice(0, 80)}`);
  return g;
}

// The base data directory (COBRA_DATA_DIR or the config default), WITHOUT the generation — the root the legacy purge scans.
export function dataDirBase(config = loadConfig()) {
  if (process.env.COBRA_DATA_DIR) return path.resolve(process.env.COBRA_DATA_DIR);
  return path.resolve(ROOT, config.tape.dataDir);
}

// The directory every collector root, lock, journal and research root actually uses: base + generation (or the flat base
// when no generation is set). This is the single point the whole runtime resolves through, so one change covers it all.
export function dataDir(config = loadConfig()) {
  const base = dataDirBase(config);
  const gen = dataGeneration();
  return gen ? path.join(base, gen) : base;
}

const dirBytes = (target) => {
  let total = 0;
  const walk = (p) => {
    let st; try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { let names = []; try { names = readdirSync(p); } catch { names = []; } for (const n of names) walk(path.join(p, n)); }
    else total += st.size;
  };
  walk(target);
  return total;
};

// One-shot legacy purge (PUBLISH-FIX-1): when SERPENT_PURGE_LEGACY_DATA=1, delete every TOP-LEVEL entry in the base data dir
// that is NOT the current generation directory — the old flat app's data, locks and rows a republished disk kept. Each
// removal is logged with a byte count; the current generation is NEVER touched. David sets the env for exactly one
// republish, then removes it. A missing base, or no generation set, is a no-op (nothing to protect / nothing to clean).
export function purgeLegacyData({ env = process.env, log = () => {} } = {}) {
  if (env.SERPENT_PURGE_LEGACY_DATA !== '1') return { purged: false, removed: [], totalBytes: 0 };
  let gen; try { gen = dataGeneration(env); } catch (err) { log(`legacy purge refused: ${String(err?.message ?? err).slice(0, 160)}`); return { purged: false, removed: [], totalBytes: 0 }; }
  if (!gen) { log('legacy purge skipped: SERPENT_PURGE_LEGACY_DATA=1 but no SERPENT_DATA_GENERATION set — a flat layout has no generation to protect, so nothing is purged'); return { purged: false, removed: [], totalBytes: 0 }; }
  const base = dataDirBase();
  let names = []; try { names = readdirSync(base); } catch { return { purged: false, removed: [], totalBytes: 0 }; }
  const removed = [];
  for (const name of names) {
    if (name === gen) continue; // never touch the current generation
    const full = path.join(base, name);
    const bytes = dirBytes(full);
    try { rmSync(full, { recursive: true, force: true }); removed.push({ name, bytes }); log(`legacy purge: removed ${name} (${bytes} bytes)`); }
    catch (err) { log(`legacy purge: FAILED to remove ${name} (${String(err?.message ?? err).slice(0, 120)})`); }
  }
  const totalBytes = removed.reduce((n, e) => n + e.bytes, 0);
  log(`legacy purge complete: ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} removed, ${totalBytes} bytes freed; generation ${gen} preserved`);
  return { purged: true, removed, totalBytes };
}

// Kraken v2 symbol for a universe coin, e.g. BTC -> "BTC/USD".
export function venueSymbol(coin, config = loadConfig()) {
  return `${coin}/${config.quote}`;
}

export function coinFromSymbol(symbol) {
  return symbol.split('/')[0];
}
