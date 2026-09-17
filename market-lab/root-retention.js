// MARKET LAB — research ROOT retention (PUBLISH-FIX-22, 2026-09-17). Production evidence (boot aac10add): the research
// root reached its 4 GiB quota and BOTH research owners (the integrated service and the data-only market addition)
// refused to start — "research root quota exhausted" — because every prior boot's capture run stayed on disk (and the
// object store restored them all again after each publish). Under retention policy ROTATE_OLDEST_CAPTURES the owner
// makes room BEFORE its quota check: the OLDEST prior capture runs under <root>/captures/ are removed until the root
// leaves at least one run bound (resources.runBytes) of headroom under the quota. Sealed CASES (the Judge's evidence),
// the accounting / budget journals, status files and the run that is about to open are never touched, and every removal
// is logged with its size. A root that is still exhausted afterwards (cases alone over quota) fails honestly as before.
import path from 'node:path';
import { readdirSync, statSync, rmSync } from 'node:fs';
import { directoryBytes } from './store.js';

export const ROOT_RETENTION_VERSION = 'market-root-retention-1';
export const CAPTURES_DIR = 'captures';
const TS_IN_NAME = /(\d{13})/;

// A capture run's age: the 13-digit timestamp its name carries (cap-<ts>, data-only-<ts>-<pid>-<seq>), else its mtime.
function runOrderKey(dir) { const m = TS_IN_NAME.exec(path.basename(dir)); if (m) return Number(m[1]); try { return Math.floor(statSync(dir).mtimeMs); } catch { return Number.MAX_SAFE_INTEGER; } }

export function listCaptureRuns(root) {
  const capturesDir = path.join(path.resolve(root), CAPTURES_DIR);
  let entries; try { entries = readdirSync(capturesDir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => { const dir = path.join(capturesDir, e.name); let bytes = 0; try { bytes = directoryBytes(dir); } catch { bytes = 0; } return { dir, name: e.name, bytes, order: runOrderKey(dir) }; }).sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
}

// Remove the oldest prior capture runs until usedBytes + reserveBytes <= quotaBytes. `keep` lists absolute directories
// that are never removed (the run about to open). Returns a bounded, log-ready summary; never throws for one bad run.
export function rotateCaptureRuns({ root, quotaBytes, reserveBytes = 0, keep = [], log = () => {} }) {
  const resolved = path.resolve(root); const keepSet = new Set(keep.map((k) => path.resolve(k)));
  let used; try { used = directoryBytes(resolved); } catch (err) { return { version: ROOT_RETENTION_VERSION, state: 'UNMEASURABLE', reason: String(err?.message ?? err).slice(0, 120), removed: [], freedBytes: 0, usedBefore: null, usedAfter: null }; }
  const usedBefore = used; const removed = []; const failed = [];
  if (used + reserveBytes <= quotaBytes) return { version: ROOT_RETENTION_VERSION, state: 'WITHIN_QUOTA', removed, failed, freedBytes: 0, usedBefore, usedAfter: used, quotaBytes, reserveBytes };
  for (const run of listCaptureRuns(resolved)) {
    if (used + reserveBytes <= quotaBytes) break;
    if (keepSet.has(path.resolve(run.dir))) continue;
    try { rmSync(run.dir, { recursive: true, force: true }); used -= run.bytes; removed.push({ name: run.name, bytes: run.bytes }); log(`MARKET RESEARCH retention: rotated prior capture run ${run.name} (${(run.bytes / 1048576).toFixed(1)} MB) — root ${(used / 1048576).toFixed(0)} MB of ${(quotaBytes / 1048576).toFixed(0)} MB quota`); }
    catch (err) { failed.push({ name: run.name, reason: String(err?.message ?? err).slice(0, 120) }); }
  }
  const state = used + reserveBytes <= quotaBytes ? 'ROTATED' : 'STILL_EXHAUSTED';
  const freedBytes = usedBefore - used;
  log(`MARKET RESEARCH retention ${state}: ${removed.length} prior capture run(s) rotated, ${(freedBytes / 1048576).toFixed(1)} MB freed; root ${(usedBefore / 1048576).toFixed(0)} -> ${(used / 1048576).toFixed(0)} MB of ${(quotaBytes / 1048576).toFixed(0)} MB (reserve ${(reserveBytes / 1048576).toFixed(0)} MB for this run)${failed.length ? `; ${failed.length} could not be removed (${failed[0].name}: ${failed[0].reason})` : ''}`);
  return { version: ROOT_RETENTION_VERSION, state, removed, failed, freedBytes, usedBefore, usedAfter: used, quotaBytes, reserveBytes };
}
