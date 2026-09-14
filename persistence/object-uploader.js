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
export const DEFAULT_BACKED_SOURCES = Object.freeze(['tape', 'broad-kraken', 'market-research', 'learning', 'survey', 'gateway', 'infra', 'discovery', 'video']);

const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
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

export function createObjectUploader({ store, dataRoot, sources = DEFAULT_BACKED_SOURCES, maxFilesPerSource = DEFAULT_MAX_FILES_PER_SOURCE, log = () => {}, now = () => Date.now() } = {}) {
  if (!store || store.state !== 'ACTIVE' || !store.adapter) throw new Error('createObjectUploader requires an ACTIVE object store');
  const adapter = store.adapter;
  const root = path.resolve(dataRoot);
  let manifest = null; // loaded lazily from the bucket on the first sync
  let running = false;
  let lastSummary = null;

  async function loadManifest() {
    if (manifest) return manifest;
    let bytes = null;
    try { bytes = await adapter.get(MANIFEST_OBJECT_KEY); } catch (error) { log(`OBJECT UPLOADER manifest read failed (starting empty): ${bounded(error?.code ?? error?.message ?? error)}`); }
    manifest = parseManifest(bytes) ?? emptyManifest();
    return manifest;
  }

  async function syncOnce() {
    if (running) return lastSummary ?? { state: 'BUSY' };
    running = true;
    try {
      const current = await loadManifest();
      const nextEntries = { ...current.entries };
      const { files, skipped } = await scanSources({ dataRoot: root, sources, maxFilesPerSource });
      let uploaded = 0; let skippedUnchanged = 0; let uploadedBytes = 0; const failures = [];
      // a source scanned this pass keeps its manifest entries even when a file momentarily disappeared (durable, never pruned)
      for (const file of files) {
        if (Object.keys(nextEntries).length >= MAX_MANIFEST_ENTRIES && !nextEntries[file.relativePath]) { skipped.overCount.push(file.relativePath); continue; }
        const prior = nextEntries[file.relativePath];
        if (prior && prior.bytes === file.bytes && prior.mtimeMs === file.mtimeMs) { skippedUnchanged += 1; continue; }
        let bytes;
        try { bytes = await readExact(file.abs, file.bytes); } catch (error) { failures.push({ relativePath: file.relativePath, reason: bounded(error?.code ?? error?.message ?? error) }); continue; }
        if (bytes === null) continue; // changed mid-read; next pass catches it
        const digest = sha256(bytes);
        if (prior && prior.sha256 === digest) { nextEntries[file.relativePath] = { ...prior, bytes: file.bytes, mtimeMs: file.mtimeMs }; skippedUnchanged += 1; continue; }
        const key = objectKeyForPath(file.relativePath);
        try { const put = await adapter.put(key, bytes); if (put.sha256 !== digest) throw new Error('object digest mismatch after put'); }
        catch (error) { failures.push({ relativePath: file.relativePath, reason: bounded(error?.code ?? error?.message ?? error) }); continue; }
        nextEntries[file.relativePath] = { key, bytes: file.bytes, sha256: digest, mtimeMs: file.mtimeMs, uploadedTs: now() };
        uploaded += 1; uploadedBytes += file.bytes;
      }
      const nextManifest = { version: OBJECT_MANIFEST_VERSION, updatedTs: now(), entries: nextEntries };
      // write the manifest only when something changed, so a quiet cycle costs one scan and no writes
      if (uploaded > 0) {
        try { await adapter.put(MANIFEST_OBJECT_KEY, serializeManifest(nextManifest)); manifest = nextManifest; }
        catch (error) { failures.push({ relativePath: MANIFEST_OBJECT_KEY, reason: bounded(error?.code ?? error?.message ?? error) }); }
      } else { manifest.entries = nextEntries; }
      lastSummary = Object.freeze({
        version: OBJECT_UPLOADER_VERSION, tsMs: now(), state: failures.length ? 'DEGRADED' : 'OK',
        scanned: files.length, uploaded, uploadedBytes, skippedUnchanged,
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
    _manifest: () => (manifest ? structuredClone(manifest) : null),
  });
}
