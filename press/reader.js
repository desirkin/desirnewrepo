// PRESS — the read-only consumer of publisher observations: the status file (per-source state, cadence, counters, last
// failure) and a bounded tail of admitted observations, every reopened record re-validated through the closed shape.
// Nothing here fetches, writes or decides. Used by the sensor snapshot (paper/readiness.js), the CLI (`cobra press …`)
// and any research reader that wants headlines as UNTRUSTED, NON-AUTHORITATIVE context.
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pressObservationError } from './parse.js';

export const PRESS_STATUS_VERSION = 'press-status-1';
export const pressDir = (dataDir) => path.join(dataDir, 'press');
export const pressStatusFile = (dataDir) => path.join(pressDir(dataDir), 'status.json');
export const pressObservationsFile = (dataDir) => path.join(pressDir(dataDir), 'observations.jsonl');
const MAX_READ_BYTES = 64 * 1024 * 1024;
export function readPressStatus(dataDir) { try { const f = pressStatusFile(dataDir); if (!existsSync(f)) return null; const s = JSON.parse(readFileSync(f, 'utf8')); return s && s.v === PRESS_STATUS_VERSION && s.sources && typeof s.sources === 'object' ? s : null; } catch { return null; } }
// the newest `limit` valid observations (optionally one source, optionally at/after a receipt clock); corrupt lines are counted, never returned
export function readPressObservations(dataDir, { sourceId = null, sinceReceiptTs = null, limit = 100 } = {}) {
  const f = pressObservationsFile(dataDir); const out = { observations: [], corrupt: 0, truncatedRead: false };
  if (!existsSync(f)) return out; const size = statSync(f).size; if (size > MAX_READ_BYTES) out.truncatedRead = true;
  const text = readFileSync(f, 'utf8'); const lines = text.split('\n'); const kept = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < Math.max(1, Math.min(limit, 5000)); i -= 1) {
    const l = lines[i]; if (!l) continue; let o; try { o = JSON.parse(l); } catch { out.corrupt += 1; continue; }
    if (pressObservationError(o)) { out.corrupt += 1; continue; } if (sourceId && o.sourceId !== sourceId) continue; if (sinceReceiptTs !== null && o.receiptTs < sinceReceiptTs) continue;
    kept.push(o);
  }
  out.observations = kept.reverse(); return out;
}
