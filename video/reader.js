// VIDEO — the read-only consumer of social-video observations: the collector's status file and a bounded tail of admitted
// observations (each reopened record re-validated through the closed shape). Nothing here fetches, writes or decides. Used by
// the sensor snapshot (paper/readiness.js), the CLI (`cobra video …`) and any research reader that wants video metadata as
// UNTRUSTED, NON-AUTHORITATIVE context. Never a RUMOR-2 social event.
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { videoObservationError } from './parse.js';

export const VIDEO_STATUS_VERSION = 'video-status-1';
export const videoDir = (dataDir) => path.join(dataDir, 'video');
export const videoStatusFile = (dataDir) => path.join(videoDir(dataDir), 'status.json');
export const videoObservationsFile = (dataDir) => path.join(videoDir(dataDir), 'observations.jsonl');
const MAX_READ_BYTES = 64 * 1024 * 1024;
export function readVideoStatus(dataDir) { try { const f = videoStatusFile(dataDir); if (!existsSync(f)) return null; const s = JSON.parse(readFileSync(f, 'utf8')); return s && s.v === VIDEO_STATUS_VERSION && typeof s.state === 'string' ? s : null; } catch { return null; } }
export function readVideoObservations(dataDir, { query = null, sinceReceiptTs = null, limit = 100 } = {}) {
  const f = videoObservationsFile(dataDir); const out = { observations: [], corrupt: 0, truncatedRead: false };
  if (!existsSync(f)) return out; const size = statSync(f).size; if (size > MAX_READ_BYTES) out.truncatedRead = true;
  const text = readFileSync(f, 'utf8'); const lines = text.split('\n'); const kept = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < Math.max(1, Math.min(limit, 5000)); i -= 1) {
    const l = lines[i]; if (!l) continue; let o; try { o = JSON.parse(l); } catch { out.corrupt += 1; continue; }
    if (videoObservationError(o)) { out.corrupt += 1; continue; } if (query && o.query !== query) continue; if (sinceReceiptTs !== null && o.receiptTs < sinceReceiptTs) continue;
    kept.push(o);
  }
  out.observations = kept.reverse(); return out;
}
