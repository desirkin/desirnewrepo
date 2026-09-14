// PERSIST-1 restore-on-boot (2026-09-14). A Replit republish wipes the container filesystem; on the next boot this
// pulls every backed bulk file the durable bucket holds back onto local disk BEFORE any consumer reads it, so a day of
// capture is not lost to a publish. It reads the bucket's self-describing manifest and, for each entry, restores the
// file only when the local copy is absent or its digest does not match — a file the local disk already carries intact is
// left untouched (no needless rewrite, no clobber of newer local appends the bucket has not seen yet). Every restored
// byte is digest-verified against the manifest before the atomic rename; a mismatch is refused, never written. Restore
// NEVER deletes a local file the manifest does not mention. Authority NONE.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { MANIFEST_OBJECT_KEY, parseManifest, relativePathError } from './object-manifest.js';

export const OBJECT_RESTORE_VERSION = 'serpent-object-restore-1';
const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

// Decide what to do with the local copy at `abs` against a manifest entry of `expectedBytes`/`expectedDigest`:
//  - 'PRESENT'  : the local file is byte-identical to the durable one — leave it.
//  - 'LOCAL_AHEAD': the local file is at least as large but not identical — a newer local append the bucket has not
//                   seen yet. LEAVE it; restore must never clobber newer local evidence.
//  - 'RESTORE'  : the local file is absent, shorter than the durable one, a symlink, or a directory — pull the durable
//                 copy (it is the more complete truth). Never follows a symlink when reading.
async function localDecision(abs, expectedBytes, expectedDigest) {
  let meta;
  try { meta = await lstat(abs); }
  catch (error) { if (error?.code === 'ENOENT') return 'RESTORE'; throw error; }
  if (meta.isSymbolicLink() || !meta.isFile()) return 'RESTORE';
  if (meta.size < expectedBytes) return 'RESTORE';
  if (meta.size > expectedBytes) return 'LOCAL_AHEAD';
  // exactly the expected size: identical bytes are PRESENT, anything else is a same-length divergence to restore
  let handle;
  try {
    handle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.size !== expectedBytes) return stat.size > expectedBytes ? 'LOCAL_AHEAD' : 'RESTORE';
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) { const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset); if (bytesRead === 0) return 'RESTORE'; offset += bytesRead; }
    return sha256(buf) === expectedDigest ? 'PRESENT' : 'RESTORE';
  } catch (error) { if (error?.code === 'ENOENT') return 'RESTORE'; throw error; }
  finally { await handle?.close(); }
}

async function writeAtomic(abs, bytes) {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.restore-tmp`;
  let handle;
  try {
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle?.close(); }
  try { await rename(tmp, abs); }
  catch (error) { try { await unlink(tmp); } catch { /* best effort */ } throw error; }
}

// Restore the backed bulk files from the durable bucket onto local disk. Returns a bounded summary; it never throws for
// a single-file failure (that file is counted and reported) so one bad object cannot block the rest of boot.
export async function restoreObjectStoreOnBoot({ store, dataRoot, log = () => {}, now = () => Date.now() } = {}) {
  const base = { version: OBJECT_RESTORE_VERSION, tsMs: now() };
  if (!store || store.state !== 'ACTIVE' || !store.adapter) {
    // an absent or dark bucket is not a boot failure: there is simply nothing durable to restore
    return Object.freeze({ ...base, state: store?.state === undefined ? 'NO_STORE' : `STORE_${store.state}`, restored: 0, verifiedPresent: 0, failures: 0, manifestEntries: 0 });
  }
  const root = path.resolve(dataRoot);
  let manifestBytes = null;
  try { manifestBytes = await store.adapter.get(MANIFEST_OBJECT_KEY); }
  catch (error) { log(`OBJECT RESTORE manifest read failed (nothing restored): ${bounded(error?.code ?? error?.message ?? error)}`); return Object.freeze({ ...base, state: 'MANIFEST_UNAVAILABLE', restored: 0, verifiedPresent: 0, failures: 0, manifestEntries: 0 }); }
  const manifest = parseManifest(manifestBytes);
  if (!manifest) { if (manifestBytes) log('OBJECT RESTORE manifest is corrupt or foreign (nothing restored)'); return Object.freeze({ ...base, state: manifestBytes ? 'MANIFEST_CORRUPT' : 'MANIFEST_ABSENT', restored: 0, verifiedPresent: 0, failures: 0, manifestEntries: 0 }); }

  let restored = 0; let verifiedPresent = 0; let localAhead = 0; const failures = [];
  const entries = Object.entries(manifest.entries);
  for (const [relativePath, entry] of entries) {
    if (relativePathError(relativePath)) { failures.push({ relativePath, reason: 'UNSAFE_PATH' }); continue; }
    const abs = path.resolve(root, ...relativePath.split('/'));
    if (!inside(root, abs)) { failures.push({ relativePath, reason: 'PATH_ESCAPES_DATA_ROOT' }); continue; }
    let decision;
    try { decision = await localDecision(abs, entry.bytes, entry.sha256); }
    catch (error) { failures.push({ relativePath, reason: bounded(error?.code ?? error?.message ?? error) }); continue; }
    if (decision === 'PRESENT') { verifiedPresent += 1; continue; }
    if (decision === 'LOCAL_AHEAD') { localAhead += 1; continue; } // a newer local append the bucket has not seen — never clobbered
    let bytes;
    try { bytes = await store.adapter.get(entry.key); }
    catch (error) { failures.push({ relativePath, reason: bounded(error?.code ?? error?.message ?? error) }); continue; }
    if (bytes === null) { failures.push({ relativePath, reason: 'DURABLE_OBJECT_MISSING' }); continue; }
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) { failures.push({ relativePath, reason: 'DURABLE_OBJECT_DIGEST_MISMATCH' }); continue; }
    try { await writeAtomic(abs, bytes); restored += 1; }
    catch (error) { failures.push({ relativePath, reason: bounded(error?.code ?? error?.message ?? error) }); }
  }
  const state = failures.length ? 'DEGRADED' : 'OK';
  log(`OBJECT RESTORE ${state}: ${restored} restored, ${verifiedPresent} already intact, ${localAhead} local-ahead kept, ${failures.length} failed of ${entries.length} manifest entries`);
  if (failures.length) log(`OBJECT RESTORE first failure ${failures[0].relativePath}: ${failures[0].reason}`);
  return Object.freeze({ ...base, state, restored, verifiedPresent, localAhead, failures: failures.length, manifestEntries: entries.length, firstFailure: failures[0] ?? null });
}
