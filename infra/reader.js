import { readJsonlTail, readJsonBounded } from '../lib/jsonl.js';
// INFRA — read-only consumer of dark infrastructure observations: the status file and a bounded, re-validated tail of
// observations. Nothing here fetches, writes or decides.
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { infraObservationError } from './parse.js';
export const INFRA_STATUS_VERSION = 'infra-status-1';
export const infraDir = (dataDir) => path.join(dataDir, 'infra');
export const infraStatusFile = (dataDir) => path.join(infraDir(dataDir), 'status.json');
export const infraObservationsFile = (dataDir) => path.join(infraDir(dataDir), 'observations.jsonl');
const MAX_READ_BYTES = 64 * 1024 * 1024;
export function readInfraStatus(dataDir) { try { const f = infraStatusFile(dataDir); if (!existsSync(f)) return null; const s = readJsonBounded(f); return s && s.v === INFRA_STATUS_VERSION && s.sources && typeof s.sources === 'object' ? s : null; } catch { return null; } }
export function readInfraObservations(dataDir, { sourceId = null, kind = null, sinceReceiptTs = null, limit = 100 } = {}) {
  const f = infraObservationsFile(dataDir); const out = { observations: [], corrupt: 0, truncatedRead: false }; if (!existsSync(f)) return out; if (statSync(f).size > MAX_READ_BYTES) out.truncatedRead = true;
  const lines = readFileSync(f, 'utf8').split('\n'); const kept = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < Math.max(1, Math.min(limit, 5000)); i -= 1) { const l = lines[i]; if (!l) continue; let o; try { o = JSON.parse(l); } catch { out.corrupt += 1; continue; } if (infraObservationError(o)) { out.corrupt += 1; continue; } if (sourceId && o.sourceId !== sourceId) continue; if (kind && o.kind !== kind) continue; if (sinceReceiptTs !== null && o.receiptTs < sinceReceiptTs) continue; kept.push(o); }
  out.observations = kept.reverse(); return out;
}
