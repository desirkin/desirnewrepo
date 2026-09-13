// MEMORY-0 read-only Childhood bridge. The Childhood archive is IMMUTABLE
// EVIDENCE: this module opens files strictly for reading, exports no write
// capability, and hands out frozen copies. No similarity search, no analog
// ranking, no learning — a stable boundary future systems will query.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { dataDir } from '../lib/config.js';

const MAX_QUERY_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 50;
const clamp = (limit) => Math.max(1, Math.min(Number.isFinite(limit) ? limit : DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));

const childhoodDir = () => path.join(dataDir(), 'childhood');

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

function* jsonlLines(file) {
  if (!existsSync(file)) return;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const t = l.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // corrupt archive lines are the childhood validator's concern; the
      // bridge never repairs, never rewrites — it simply cannot serve them
    }
  }
}

export function getChildhoodManifest() {
  const f = path.join(childhoodDir(), 'manifest.json');
  if (!existsSync(f)) return null;
  return deepFreeze(JSON.parse(readFileSync(f, 'utf8')));
}

export function getObservationById(id) {
  for (const o of jsonlLines(path.join(childhoodDir(), 'observations.jsonl'))) {
    if (o.id === id) return deepFreeze(o);
  }
  return null;
}

export function getOutcomeForObservation(id) {
  for (const o of jsonlLines(path.join(childhoodDir(), 'outcomes.jsonl'))) {
    if (o.id === id) return deepFreeze(o);
  }
  return null;
}

// Bounded query: symbol / date range (epoch sec) / population / track role.
// Defaults: limit 50; maximum 500 (larger requests are clamped).
export function queryObservations({ symbol, fromTs, toTs, population, trackRole, limit } = {}) {
  const n = clamp(limit);
  const out = [];
  for (const o of jsonlLines(path.join(childhoodDir(), 'observations.jsonl'))) {
    if (symbol !== undefined && o.symbol !== symbol) continue;
    if (fromTs !== undefined && o.ts < fromTs) continue;
    if (toTs !== undefined && o.ts > toTs) continue;
    if (population !== undefined && o.population !== population) continue;
    if (trackRole !== undefined && o.trackRole !== trackRole) continue;
    out.push(deepFreeze(o));
    if (out.length >= n) break;
  }
  return out;
}
