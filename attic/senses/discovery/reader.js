import path from 'node:path';
import { existsSync } from 'node:fs';
import { readJsonBounded, readJsonlTail } from '../lib/jsonl.js';
import { discoveryObservationError } from './parse.js';

export const DISCOVERY_STATUS_VERSION = 'public-discovery-status-1';
export const discoveryDir = (dataDir) => path.join(dataDir, 'public-discovery');
export const discoveryStatusFile = (dataDir) => path.join(discoveryDir(dataDir), 'status.json');
export const discoveryObservationsFile = (dataDir) => path.join(discoveryDir(dataDir), 'observations.jsonl');
export const discoveryReceiptsFile = (dataDir) => path.join(discoveryDir(dataDir), 'receipts.jsonl');
export const discoveryCheckpointFile = (dataDir) => path.join(discoveryDir(dataDir), 'checkpoint.json');
export const discoveryWriterFile = (dataDir) => path.join(discoveryDir(dataDir), 'writer.lock');

export function readDiscoveryStatus(dataDir) { try { const status = readJsonBounded(discoveryStatusFile(dataDir)); return status?.v === DISCOVERY_STATUS_VERSION ? status : null; } catch { return null; } }

export function readDiscoveryObservations(dataDir, { sourceId = null, limit = 100 } = {}) {
  const out = { observations: [], corrupt: 0, truncatedRead: false }; const file = discoveryObservationsFile(dataDir); if (!existsSync(file)) return out;
  const tail = readJsonlTail(file, { maxBytes: 64 * 1024 * 1024 }); out.truncatedRead = tail.truncated; if (tail.torn) out.corrupt += 1;
  for (let index = tail.lines.length - 1; index >= 0 && out.observations.length < Math.max(1, Math.min(5000, limit)); index -= 1) {
    let observation; try { observation = JSON.parse(tail.lines[index]); } catch { out.corrupt += 1; continue; }
    if (discoveryObservationError(observation)) { out.corrupt += 1; continue; } if (sourceId && observation.sourceId !== sourceId) continue; out.observations.push(observation);
  }
  out.observations.reverse(); return out;
}

export function readDiscoveryReceipts(dataDir, { sourceId = null, limit = 200 } = {}) {
  const out = { receipts: [], corrupt: 0, truncatedRead: false }; const file = discoveryReceiptsFile(dataDir); if (!existsSync(file)) return out;
  const tail = readJsonlTail(file, { maxBytes: 16 * 1024 * 1024 }); out.truncatedRead = tail.truncated; if (tail.torn) out.corrupt += 1;
  for (let index = tail.lines.length - 1; index >= 0 && out.receipts.length < Math.max(1, Math.min(5000, limit)); index -= 1) {
    let receipt; try { receipt = JSON.parse(tail.lines[index]); } catch { out.corrupt += 1; continue; }
    if (receipt?.v !== 'public-discovery-receipt-1' || !['RESERVED','SETTLED'].includes(receipt.phase) || typeof receipt.sourceId !== 'string' || !Number.isSafeInteger(receipt.requestOrdinal) || !Number.isSafeInteger(receipt.requestedTs)) { out.corrupt += 1; continue; }
    if (sourceId && receipt.sourceId !== sourceId) continue; out.receipts.push(receipt);
  }
  out.receipts.reverse(); return out;
}
