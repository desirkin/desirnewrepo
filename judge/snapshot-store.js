// JUDGE — bounded persisted decision / exit snapshots (closeout R11): the exact detached book snapshot a decision or a
// residual sale was valued on is written atomically, named by its content digest, BEFORE the intent is dispatched or the
// sale is sent, so every dispatched order references evidence that exists on disk. Bounded: at most `maxFiles` newest
// digests are retained (older ones pruned by the index), each snapshot is already bounded by the feed's level cap.
import { mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../lib/jsonl.js';
import { bookSnapshotError } from '../execution/contract.js';

export const SNAPSHOT_STORE_VERSION = 'judge-snapshot-store-1';
export function createSnapshotStore({ dir, maxFiles = 2000, log = () => {} }) {
  // a directory that cannot be created is a counted failure (closeout R16): the composition still runs; every persist then
  // fails and the Judge refuses new entries (DECISION_SNAPSHOT_NOT_PERSISTED) while exits continue
  const order = []; const known = new Set(); let writes = 0; let failures = 0; let dirError = null; try { mkdirSync(dir, { recursive: true }); } catch (err) { failures += 1; dirError = String(err.message ?? err).slice(0, 160); log(`snapshot store: ${dir}: ${err.message}`); }
  try { for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{64}\.json$/.test(x)).sort()) { const d = f.slice(0, 64); known.add(d); order.push(d); } } catch { /* fresh */ }
  const fileOf = (digest) => path.join(dir, `${digest}.json`);
  async function persist(snapshot, { purpose = 'DECISION', ref = null } = {}) {
    if (!snapshot || typeof snapshot.digest !== 'string') return { ok: false, reason: 'NO_SNAPSHOT' }; const e = bookSnapshotError(snapshot); if (e) return { ok: false, reason: e };
    if (known.has(snapshot.digest) && existsSync(fileOf(snapshot.digest))) return { ok: true, digest: snapshot.digest, file: fileOf(snapshot.digest), existing: true };
    try { mkdirSync(dir, { recursive: true }); atomicWriteJson(fileOf(snapshot.digest), { storeVersion: SNAPSHOT_STORE_VERSION, purpose, ref, persistedTs: Date.now(), snapshot }); writes += 1; known.add(snapshot.digest); order.push(snapshot.digest); while (order.length > maxFiles) { const old = order.shift(); known.delete(old); try { unlinkSync(fileOf(old)); } catch { /* gone */ } } return { ok: true, digest: snapshot.digest, file: fileOf(snapshot.digest), existing: false }; }
    catch (err) { failures += 1; log(`snapshot store: ${err.message}`); return { ok: false, reason: err.message }; }
  }
  function read(digest) { try { const raw = JSON.parse(readFileSync(fileOf(digest), 'utf8')); const e = bookSnapshotError(raw.snapshot); if (e || raw.snapshot.digest !== digest) return null; return raw; } catch { return null; } }
  return { persist, read, has: (d) => known.has(d) && existsSync(fileOf(d)), status: () => ({ storeVersion: SNAPSHOT_STORE_VERSION, dir, files: order.length, writes, failures, maxFiles }) };
}
