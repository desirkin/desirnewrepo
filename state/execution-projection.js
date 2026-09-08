// STATE — the read-only execution projection (ticket §9.1): the Judge composition publishes <data dir>/execution/
// projection.json from the ACTUAL journal state (open positions, pending entry orders, exit phases). The posture machine
// projects STRIKE / DIGESTING from that file ONLY while it is fresh; a stale or absent projection projects nothing, and a
// projected posture label never grants permission or invents a fill. Pure file read, bounded, never a write.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { dataDir } from '../lib/config.js';

export const PROJECTION_FRESH_MS = 15_000;
export const PROJECTION_MAX_BYTES = 2 * 1024 * 1024;
export const projectionFile = () => path.join(dataDir(), 'execution', 'projection.json');
export function readExecutionProjection({ now = Date.now(), file = projectionFile() } = {}) {
  if (!existsSync(file)) return null;
  let p; try { const buf = readFileSync(file); if (buf.length > PROJECTION_MAX_BYTES) return { state: 'UNREADABLE', reason: 'TOO_LARGE' }; p = JSON.parse(buf.toString('utf8')); } catch { return { state: 'UNREADABLE', reason: 'PARSE' }; }
  if (p?.projectionVersion !== 'judge-projection-1' || !Number.isSafeInteger(p.ts)) return { state: 'UNREADABLE', reason: 'SHAPE' };
  const ageMs = now - p.ts; const fresh = ageMs >= -PROJECTION_FRESH_MS && ageMs <= PROJECTION_FRESH_MS;
  const open = Array.isArray(p.positions) ? p.positions.length : 0; const pending = Array.isArray(p.pendingOrders) ? p.pendingOrders.filter((o) => o.kind === 'ENTRY' || o.kind === 'CANARY_ENTRY').length : 0;
  return { state: fresh ? 'FRESH' : 'STALE', ageMs, ts: p.ts, accountId: p.accountId ?? null, mode: p.mode ?? null, runMode: p.runMode ?? null, accountKind: p.accountKind ?? null, adapter: p.adapter ?? null, posture: fresh && (p.posture === 'STRIKE' || p.posture === 'DIGESTING') && (open > 0 || pending > 0) ? p.posture : null, openPositions: open, pendingEntries: pending, restrictions: Array.isArray(p.restrictions) ? p.restrictions : [], exposure: open > 0 || pending > 0 };
}
