// PERSIST-1-1: inspect commissioned local caches BEFORE consumers can call
// missing history a fresh start. Read-only: no mkdir, reset, import, restore,
// anchor adoption, permission increase, or deletion occurs in this module.
// An anchor is not a backup. Its acknowledged snapshot must also validate.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { listStoreAnchors, readStoreSnapshot, validateStoreAnchor, MAX_STORE_SNAPSHOT_BYTES } from './store-anchors.js';
import { canonicalJson } from './schema.js';
import { dataGeneration } from '../lib/config.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
// HEALTHY and NOT_APPLICABLE are the two non-locking verdicts: a matched snapshot, or an anchor from another data
// generation whose files legitimately live under a different root (PUBLISH-FIX-2 — a new generation must not read the
// previous generation's anchors as WIPED and hold a permission lock).
const NON_LOCKING = new Set(['HEALTHY', 'NOT_APPLICABLE']);
const result = (anchor, status, reason) => ({
  storeId: anchor.storeId, revision: anchor.revision, status, reason,
  generation: anchor.generation ?? '',
  permissionLock: !NON_LOCKING.has(status),
});
const anchorGenerationOf = (anchor) => (typeof anchor?.generation === 'string' ? anchor.generation : '');

export async function inspectStoreAnchor({ dataRoot, anchor }) {
  // Strict persisted metadata validation is mandatory even when called
  // directly (not only through a repository that previously validated it).
  anchor = validateStoreAnchor(anchor);
  const root = path.resolve(dataRoot);
  const file = path.resolve(root, ...anchor.relativePath.split('/'));
  if (!inside(root, file) || file === root) return result(anchor, 'INVALID', 'PATH_OUTSIDE_DATA_ROOT');
  let handle;
  try {
    let current = root;
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return result(anchor, 'INVALID', 'DATA_ROOT_NOT_PLAIN_DIRECTORY');
    const directories = [{ name: root, stat: rootStat }];
    const actualRoot = await realpath(root);
    const parts = anchor.relativePath.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const partStat = await lstat(current);
      if (partStat.isSymbolicLink()) return result(anchor, 'INVALID', 'SYMLINK_REFUSED');
      if (i < parts.length - 1 && !partStat.isDirectory()) return result(anchor, 'INVALID', 'PARENT_NOT_DIRECTORY');
      if (i < parts.length - 1) directories.push({ name: current, stat: partStat });
      if (i === parts.length - 1 && !partStat.isFile()) return result(anchor, 'INVALID', 'CACHE_NOT_REGULAR_FILE');
    }
    if (!inside(actualRoot, await realpath(file))) return result(anchor, 'INVALID', 'RESOLVED_PATH_OUTSIDE_DATA_ROOT');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) return result(anchor, 'INVALID', 'CACHE_NOT_REGULAR_FILE');
    if (before.size > anchor.byteCount) return result(anchor, 'UNANCHORED_WRITES', 'DISK_AHEAD_OF_DURABLE_ANCHOR');
    if (before.size < anchor.byteCount) return result(anchor, 'WIPED', 'DISK_TRUNCATED_BEHIND_DURABLE_ANCHOR');
    if (before.size > MAX_STORE_SNAPSHOT_BYTES) return result(anchor, 'INVALID', 'SNAPSHOT_INSPECTION_BOUND_EXCEEDED');
    // Bounded read from the opened descriptor, never readFile on a file that
    // a concurrent writer could grow without bound after the size check.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return result(anchor, 'CHANGED_DURING_CHECK', 'CACHE_CHANGED_DURING_CHECK');
      offset += bytesRead;
    }
    const after = await handle.stat();
    const now = await lstat(file);
    if (now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        now.size !== before.size || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs) {
      return result(anchor, 'CHANGED_DURING_CHECK', 'CACHE_CHANGED_DURING_CHECK');
    }
    // Recheck the root and parent directories as well as the final opened
    // file. A renamed/replaced ancestor is not the same observed cache.
    for (const directory of directories) {
      const currentStat = await lstat(directory.name);
      if (currentStat.isSymbolicLink() || !currentStat.isDirectory() ||
          currentStat.dev !== directory.stat.dev || currentStat.ino !== directory.stat.ino) {
        return result(anchor, 'CHANGED_DURING_CHECK', 'CACHE_ANCESTRY_CHANGED_DURING_CHECK');
      }
    }
    if (!inside(actualRoot, await realpath(file))) return result(anchor, 'INVALID', 'RESOLVED_PATH_OUTSIDE_DATA_ROOT');
    if (digest(bytes) !== anchor.headDigest) return result(anchor, 'DIVERGED', 'CACHE_DIGEST_DIFFERS_FROM_DURABLE_ANCHOR');
    return result(anchor, 'HEALTHY', 'EXACT_DURABLE_SNAPSHOT_MATCH');
  } catch (error) {
    if (error?.code === 'ENOENT') return result(anchor, 'WIPED', 'ANCHORED_CACHE_MISSING');
    return result(anchor, 'UNAVAILABLE', 'CACHE_INSPECTION_FAILED');
  } finally {
    await handle?.close();
  }
}

export async function checkStoreAnchors({ db, dataRoot, log = () => {} }) {
  const stores = [];
  const currentGeneration = dataGeneration();
  try {
    const anchors = await listStoreAnchors(db);
    for (const anchor of anchors) {
      // PUBLISH-FIX-2: an anchor commissioned under a DIFFERENT data generation describes files under that generation's
      // root, not this one — its absence here is expected, not a wiped cache. Report NOT_APPLICABLE (no permission lock),
      // never WIPED/UNAVAILABLE. A legacy anchor with no generation is generation '' (the flat layout).
      if (anchorGenerationOf(anchor) !== currentGeneration) {
        stores.push(result(anchor, 'NOT_APPLICABLE', 'ANCHOR_FROM_ANOTHER_DATA_GENERATION'));
        continue;
      }
      // The listing alone is not proof that recoverable payload still
      // exists. Validate its exact bytes before trusting a matching cache.
      const snapshot = await readStoreSnapshot(db, anchor.storeId);
      if (!snapshot || canonicalJson(snapshot.anchor) !== canonicalJson(anchor)) {
        stores.push(result(anchor, 'CHANGED_DURING_CHECK', 'DURABLE_HEAD_CHANGED_DURING_CHECK'));
      } else {
        stores.push(await inspectStoreAnchor({ dataRoot, anchor: snapshot.anchor }));
      }
    }
    const failed = stores.filter((store) => store.permissionLock);
    const notApplicable = stores.filter((store) => store.status === 'NOT_APPLICABLE');
    // Anchors from another generation are neither a pass nor a lock — they simply do not describe this generation's
    // crib. They count toward neither HEALTHY nor DEGRADED so a boot that only sees prior-generation anchors is
    // UNCOMMISSIONED for THIS generation, not falsely HEALTHY.
    const applicable = stores.length - notApplicable.length;
    const status = failed.length ? 'DEGRADED' : applicable ? 'HEALTHY' : 'UNCOMMISSIONED';
    // No anchor rows does NOT establish that all existing stores are new,
    // backed up, or safe to delete. This is coverage of commissioned stores
    // only. Owner-specific commissioning comes in subsequent PERSIST tickets.
    const report = {
      version: 'store-guard-1', status, coverage: 'COMMISSIONED_SNAPSHOTS_ONLY',
      generation: currentGeneration,
      checked: stores.length, applicable, notApplicable: notApplicable.length, failed: failed.length,
      permissionLock: failed.length > 0,
      failureCategory: failed.length ? `STORE_ANCHOR_${failed[0].status}` : null,
      stores,
    };
    log(`PERSISTENCE store anchors: ${status}; ${stores.length} checked (${applicable} for generation ${currentGeneration || 'flat'}, ${notApplicable.length} from another generation), ${failed.length} unresolved`);
    for (const store of notApplicable) log(`PERSISTENCE store anchor ${store.storeId}: NOT_APPLICABLE (${store.reason}; anchor generation ${store.generation || 'flat'}) — no permission lock; this generation's cache untouched`);
    for (const store of failed) log(`PERSISTENCE store anchor ${store.storeId}: ${store.status} (${store.reason}) — permission locked; cache untouched`);
    return report;
  } catch (error) {
    // PUBLISH-FIX-2: name the error's CODE and CLASS (never raw DB/path/error text) so an operator can tell a query
    // timeout from a schema mismatch from a filesystem fault — the empty catch here hid exactly this on the boot that
    // locked. The raw message is still withheld from operator-visible status.
    const errorCode = error?.code ?? error?.constructor?.name ?? 'ERROR';
    log(`PERSISTENCE store anchors: verification unavailable (${errorCode}) — permission locked; caches untouched`);
    return {
      version: 'store-guard-1', status: 'UNAVAILABLE', coverage: 'COMMISSIONED_SNAPSHOTS_ONLY',
      checked: stores.length, failed: stores.filter((store) => store.permissionLock).length,
      permissionLock: true, failureCategory: 'STORE_ANCHOR_VERIFICATION_FAILED', errorCode, stores,
    };
  }
}
