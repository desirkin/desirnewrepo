// PERSIST-1 uploader (2026-09-14). Tails the configured bulk-stream directories under the data dir and mirrors every
// file into the durable object store, then rewrites the bucket's self-describing manifest. It is:
//  - CHANGED-ONLY: a file whose (bytes, mtimeMs) still match the manifest entry is skipped without a re-read; anything
//    new or grown is digested and uploaded, and re-uploaded only if the digest actually differs.
//  - RESTART-SAFE: the manifest loaded from the bucket is the source of truth for what is already durable; a crash
//    between an object put and the manifest write costs at most one redundant re-upload, never a lost file.
//  - NON-DESTRUCTIVE: a file present in the manifest but gone from local disk is LEFT in the bucket. Durability is the
//    whole point of this module; it never deletes durable evidence because a republish wiped the ephemeral copy.
//  - BOUNDED and HONEST: each source dir is walked to a file-count bound; a file over the object cap is reported
//    SKIPPED_TOO_LARGE in the summary, never silently dropped. Authority NONE.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { MAX_OBJECT_BYTES } from './object-store.js';
import { OBJECT_MANIFEST_VERSION, MANIFEST_OBJECT_KEY, MAX_MANIFEST_ENTRIES, objectKeyForPath, relativePathError, emptyManifest, serializeManifest, parseManifest } from './object-manifest.js';

export const OBJECT_UPLOADER_VERSION = 'serpent-object-uploader-1';
export const DEFAULT_MAX_FILES_PER_SOURCE = 20_000;
// The bulk streams a Replit republish wipes (APP-MAP §4), relative to the data dir. Each is a directory of append-only
// files; the manifest keeps them individually addressed.
export const DEFAULT_BACKED_SOURCES = Object.freeze(['tape', 'broad-kraken', 'market-research', 'learning', 'survey', 'gateway', 'discovery', 'video', 'control']);

const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// PUBLISH-FIX-83 second pass: a 100-150 MB file is hashed OFF the main thread (WebCrypto runs in the thread pool) — the
// synchronous hash stalled the loop ~0.5-1 s per big file every pass; the digest is then handed to put() so it is hashed once
const sha256Async = async (bytes) => (bytes.byteLength < 1 << 20 ? sha256(bytes) : Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', bytes)).toString('hex'));
export const FINAL_SYNC_BUDGET_MS = 15_000; // the final sync at stop gets its own deadline inside the shutdown budget
// PUBLISH-FIX-84 (2026-09-20, own mistake from the 83 second pass): the manifest was rewritten after every 3 uploads in a pass and
// after EVERY upload in the final sync — but Google Cloud Storage (Replit App Storage underneath) refuses more than ONE write per
// second to the SAME object (429 rateLimitExceeded), so a pass with 30 changed files failed most of its manifest writes and logged
// "degraded ... first manifest.json: OBJECT_PUT_FAILED" every two minutes all night. The objects themselves landed; the entries
// the refused writes carried were re-uploaded next pass (churn, never loss). Now: a mid-pass manifest write happens only when the
// gap since the last manifest write has elapsed (otherwise the next upload tries again); the end-of-pass write always happens,
// waiting out the remainder of the gap first, and retries once after another gap. The gap is measured on the wall clock (it is
// the provider's rate limit, not domain time) and the wait is injectable so tests never sleep.
export const MANIFEST_MIN_WRITE_GAP_MS = 1_500;
const failureReason = (error) => bounded(error?.name === 'ObjectStoreError' ? error.message : (error?.code ?? error?.message ?? error));
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

async function readExact(file, size) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (before.size !== size) return null; // grew/shrank between stat and open: caught next pass
    const buf = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buf.length) { const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset); if (bytesRead === 0) return null; offset += bytesRead; }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return buf;
  } finally { await handle?.close(); }
}

// Enumerate the current backed files as { relativePath, bytes, mtimeMs, abs }, bounded per source, skipping symlinks,
// tmp files and anything whose relative path the manifest law would reject.
async function scanSources({ dataRoot, sources, maxFilesPerSource }) {
  const files = [];
  const skipped = { tooLarge: [], overCount: [], unsafePath: [] };
  for (const source of sources) {
    const sourceRoot = path.resolve(dataRoot, source);
    if (!inside(dataRoot, sourceRoot)) { skipped.unsafePath.push(source); continue; }
    let count = 0;
    const stack = [sourceRoot];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const abs = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { stack.push(abs); continue; }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.tmp')) continue;
        const relativePath = path.relative(dataRoot, abs).split(path.sep).join('/');
        if (relativePathError(relativePath)) { skipped.unsafePath.push(relativePath); continue; }
        if (count >= maxFilesPerSource) { skipped.overCount.push(source); break; }
        count += 1;
        const meta = await lstat(abs);
        if (!meta.isFile()) continue;
        if (meta.size > MAX_OBJECT_BYTES) { skipped.tooLarge.push(relativePath); continue; }
        // the manifest records integer milliseconds; a filesystem mtime carries sub-ms float precision
        files.push({ relativePath, bytes: meta.size, mtimeMs: Math.floor(meta.mtimeMs), abs });
      }
    }
  }
  return { files, skipped };
}

// PUBLISH-FIX-34 (2026-09-17): a GROWING append-only file is re-uploaded whole (there is no append to an object), so its
// cadence scales with its size — 15 s per MiB, never under a minute, never over `maxDeferMs` (15 min): a 7 MB tape
// snapshot file every ~2 min, a 32 MB segment every 8 min, the 70-150 MB daily learning coverage journal every 15 min.
// Before: learning/coverage/<day>.jsonl (68 MB at 11:18 UTC, ~150 MB by midnight) was read, sha256'd and uploaded EVERY
// minute — 200 MB of external memory churn and 68+ MB of network per minute for one file. The final sync at stop
// (`final: true`) uploads everything regardless, so a graceful republish loses nothing; a hard crash loses at most the
// deferral window of the largest file.
export const REUPLOAD_MS_PER_MIB = 15_000;
export const REUPLOAD_MAX_DEFER_MS = 15 * 60_000;
export const reuploadIntervalMs = (bytes, { perMiB = REUPLOAD_MS_PER_MIB, maxDeferMs = REUPLOAD_MAX_DEFER_MS, minMs = 60_000 } = {}) => Math.min(maxDeferMs, Math.max(minMs, Math.ceil((Number(bytes) || 0) / 1048576) * perMiB));

// PUBLISH-FIX-83 (full review item 32): OLD and NEW instances both uploaded to the same keys during a republish overlap — the old
// instance's FINAL sync at shutdown overwrote files the new one had already restored and then wrote ITS manifest over the new one's
// (next restore: digest mismatch, a file silently not restored, or older data over newer). The bucket now carries an OWNER record: a
// run epoch (the boot clock). Every sync re-reads it first; a run that finds a NEWER epoch yields — it uploads nothing and writes
// nothing, final sync included. The first sync of a boot claims ownership.
export const OWNER_OBJECT_KEY = 'manifest-owner.json';
export function createObjectUploader({ store, dataRoot, sources = DEFAULT_BACKED_SOURCES, maxFilesPerSource = DEFAULT_MAX_FILES_PER_SOURCE, log = () => {}, now = () => Date.now(), perMiB = REUPLOAD_MS_PER_MIB, maxDeferMs = REUPLOAD_MAX_DEFER_MS, runEpoch = null, finalBudgetMs = FINAL_SYNC_BUDGET_MS, manifestGapMs = MANIFEST_MIN_WRITE_GAP_MS, wallClock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!store || store.state !== 'ACTIVE' || !store.adapter) throw new Error('createObjectUploader requires an ACTIVE object store');
  const adapter = store.adapter;
  const root = path.resolve(dataRoot);
  const epoch = Number.isSafeInteger(runEpoch) ? runEpoch : now(); const pid = process.pid;
  let manifest = null; // loaded lazily from the bucket on the first sync
  let running = false;
  let lastSummary = null; let yielded = false; let claimed = false; let lastManifestWriteWallMs = 0; // wall clock of the last manifest put (any outcome)
  async function ownership() {
    let bytes = null; try { bytes = await adapter.get(OWNER_OBJECT_KEY); } catch (error) { log(`OBJECT UPLOADER owner read failed (claiming): ${failureReason(error)}`); }
    let owner = null; if (Buffer.isBuffer(bytes) && bytes.byteLength) { try { owner = JSON.parse(bytes.toString('utf8')); } catch { owner = null; } }
    const theirs = owner && Number.isSafeInteger(owner.runEpoch) ? owner.runEpoch : null;
    if (theirs !== null && theirs > epoch) { if (!yielded) { yielded = true; log(`OBJECT UPLOADER yields: a newer run (epoch ${new Date(theirs).toISOString()}, pid ${owner.pid ?? '?'}) owns the bucket; this run (epoch ${new Date(epoch).toISOString()}) uploads nothing more, final sync included`); } return false; }
    if (theirs === epoch && claimed) return true;
    try { await adapter.put(OWNER_OBJECT_KEY, Buffer.from(JSON.stringify({ version: 'serpent-object-owner-1', runEpoch: epoch, pid, claimedTs: now() }))); claimed = true; if (theirs !== null && theirs < epoch) log(`OBJECT UPLOADER claims the bucket from the previous run (epoch ${new Date(theirs).toISOString()})`); }
    catch (error) { log(`OBJECT UPLOADER owner claim failed (proceeding unfenced this pass): ${failureReason(error)}`); }
    return true;
  }

  async function loadManifest() {
    if (manifest) return manifest;
    let bytes = null;
    try { bytes = await adapter.get(MANIFEST_OBJECT_KEY); } catch (error) { log(`OBJECT UPLOADER manifest read failed (starting empty): ${failureReason(error)}`); }
    manifest = parseManifest(bytes) ?? emptyManifest();
    return manifest;
  }

  async function syncOnce({ final = false } = {}) {
    if (running) return lastSummary ?? { state: 'BUSY' };
    running = true;
    try {
      if (!(await ownership())) { lastSummary = Object.freeze({ version: OBJECT_UPLOADER_VERSION, tsMs: now(), state: 'YIELDED', scanned: 0, uploaded: 0, uploadedBytes: 0, skippedUnchanged: 0, deferred: 0, final, skippedTooLarge: 0, skippedOverCount: 0, skippedUnsafePath: 0, backed: manifest ? Object.keys(manifest.entries).length : null, failures: 0, firstFailure: null }); return lastSummary; }
      const current = await loadManifest();
      const nextEntries = { ...current.entries };
      const { files, skipped } = await scanSources({ dataRoot: root, sources, maxFilesPerSource });
      let uploaded = 0; let skippedUnchanged = 0; let deferred = 0; let uploadedBytes = 0; const failures = []; let sinceManifest = 0; const passStartedTs = now();
      const gapLeft = () => Math.max(0, lastManifestWriteWallMs + manifestGapMs - wallClock());
      const putManifest = async () => { const nextManifest = { version: OBJECT_MANIFEST_VERSION, updatedTs: now(), entries: { ...nextEntries } }; lastManifestWriteWallMs = wallClock(); await adapter.put(MANIFEST_OBJECT_KEY, serializeManifest(nextManifest)); manifest = nextManifest; sinceManifest = 0; };
      // force: the end-of-pass write — waits out the gap, retries once; otherwise a mid-pass write is skipped while the gap is open
      // reviewer findings: a mid-pass manifest refusal that the end-of-pass write then repairs is not a failure of the pass (the
      // entries landed); and the final sync never sleeps for a retry past its budget
      const dropManifestFailures = () => { for (let i = failures.length - 1; i >= 0; i -= 1) if (failures[i].relativePath === MANIFEST_OBJECT_KEY) failures.splice(i, 1); };
      const flushManifest = async ({ force = false } = {}) => {
        if (!force && gapLeft() > 0) return;
        if (force && gapLeft() > 0) await sleep(gapLeft());
        try { await putManifest(); if (force) dropManifestFailures(); return; }
        catch (error) {
          if (!force) { failures.push({ relativePath: MANIFEST_OBJECT_KEY, reason: failureReason(error) }); return; }
          if (final && now() - passStartedTs > finalBudgetMs) { failures.push({ relativePath: MANIFEST_OBJECT_KEY, reason: failureReason(error) }); return; }
          await sleep(Math.max(gapLeft(), manifestGapMs));
          try { await putManifest(); dropManifestFailures(); } catch (again) { failures.push({ relativePath: MANIFEST_OBJECT_KEY, reason: failureReason(again) }); }
        }
      };
      // a source scanned this pass keeps its manifest entries even when a file momentarily disappeared (durable, never pruned)
      for (const file of files) {
        if (Object.keys(nextEntries).length >= MAX_MANIFEST_ENTRIES && !nextEntries[file.relativePath]) { skipped.overCount.push(file.relativePath); continue; }
        const prior = nextEntries[file.relativePath];
        if (prior && prior.bytes === file.bytes && prior.mtimeMs === file.mtimeMs) { skippedUnchanged += 1; continue; }
        if (prior && !final && now() - (Number(prior.uploadedTs) || 0) < reuploadIntervalMs(file.bytes, { perMiB, maxDeferMs })) { deferred += 1; continue; } // PUBLISH-FIX-34: a growing file waits its size-scaled turn
        if (final && now() - passStartedTs > finalBudgetMs) { deferred += 1; continue; } // the final sync stops at its deadline BEFORE reading the next file; what landed is already in the manifest
        let bytes;
        try { bytes = await readExact(file.abs, file.bytes); } catch (error) { failures.push({ relativePath: file.relativePath, reason: failureReason(error) }); continue; }
        if (bytes === null) continue; // changed mid-read; next pass catches it
        const digest = await sha256Async(bytes);
        if (prior && prior.sha256 === digest) { nextEntries[file.relativePath] = { ...prior, bytes: file.bytes, mtimeMs: file.mtimeMs }; skippedUnchanged += 1; continue; }
        const key = objectKeyForPath(file.relativePath);
        try { await adapter.put(key, bytes, { sha256: digest }); }
        catch (error) { failures.push({ relativePath: file.relativePath, reason: failureReason(error) }); continue; }
        nextEntries[file.relativePath] = { key, bytes: file.bytes, sha256: digest, mtimeMs: file.mtimeMs, uploadedTs: now() };
        uploaded += 1; uploadedBytes += file.bytes; sinceManifest += 1;
        // PUBLISH-FIX-83 second pass: the manifest follows the objects it names — after EVERY upload in the final sync and every
        // few in a regular pass — so a process cut off mid-pass never leaves objects newer than the manifest that describes them
        // (the restore refused such a file as DURABLE_OBJECT_DIGEST_MISMATCH). PUBLISH-FIX-84: only once the provider's per-object
        // write gap has elapsed; the end-of-pass write below always lands.
        if (final || sinceManifest >= 3) { await flushManifest(); }
      }
      if (uploaded > 0 && sinceManifest > 0) await flushManifest({ force: true });
      else if (uploaded === 0) manifest.entries = nextEntries;
      lastSummary = Object.freeze({
        version: OBJECT_UPLOADER_VERSION, tsMs: now(), state: failures.length ? 'DEGRADED' : 'OK',
        scanned: files.length, uploaded, uploadedBytes, skippedUnchanged, deferred, final,
        skippedTooLarge: skipped.tooLarge.length, skippedOverCount: skipped.overCount.length, skippedUnsafePath: skipped.unsafePath.length,
        backed: Object.keys(nextEntries).length, failures: failures.length,
        firstFailure: failures[0] ?? null,
      });
      if (failures.length) log(`OBJECT UPLOADER degraded: ${failures.length} failure(s); first ${failures[0].relativePath}: ${failures[0].reason}`);
      return lastSummary;
    } finally { running = false; }
  }

  return Object.freeze({
    version: OBJECT_UPLOADER_VERSION,
    syncOnce,
    status: () => lastSummary ?? Object.freeze({ version: OBJECT_UPLOADER_VERSION, state: 'IDLE', backed: manifest ? Object.keys(manifest.entries).length : null }),
    runEpoch: epoch,
    _manifest: () => (manifest ? structuredClone(manifest) : null),
  });
}
