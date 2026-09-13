// Read-only normal consumer for the WideEye full-catalog durable population
// archive. It never fetches, writes, selects, nominates, or trades.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readJsonBounded, readJsonlTail } from '../lib/jsonl.js';
import { SWEEP_POPULATION_VERSION } from './wideeye.js';

export function readWideEyeStatus(dataDir) {
  try { return readJsonBounded(path.join(dataDir, 'survey', 'status.json'), 2 * 1024 * 1024); }
  catch { return null; }
}

export function readWideEyePopulations(dataDir, { limit = 10 } = {}) {
  const file = path.join(dataDir, 'survey', 'populations.jsonl');
  const out = { populations: [], corrupt: 0, truncatedRead: false };
  if (!existsSync(file)) return out;
  const tail = readJsonlTail(file, { maxBytes: 64 * 1024 * 1024 });
  out.truncatedRead = tail.truncated;
  if (tail.torn) out.corrupt += 1;
  for (let index = tail.lines.length - 1; index >= 0 && out.populations.length < Math.max(1, Math.min(100, limit)); index -= 1) {
    try {
      const row = JSON.parse(tail.lines[index]);
      if (row?.version !== SWEEP_POPULATION_VERSION || typeof row.sweepId !== 'string' || !Number.isSafeInteger(row.tsMs) || !Array.isArray(row.rows)) { out.corrupt += 1; continue; }
      out.populations.push(row);
    } catch { out.corrupt += 1; }
  }
  out.populations.reverse();
  return out;
}
