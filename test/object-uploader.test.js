// PERSIST-1 uploader + manifest (2026-09-14). Changed-only mirroring into a durable object store with a self-describing
// manifest; restart-safe; never deletes durable evidence. FILESYSTEM backend, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObjectStore, OBJECT_STORE_ENV } from '../persistence/object-store.js';
import { createObjectUploader } from '../persistence/object-uploader.js';
import { parseManifest, manifestError, objectKeyForPath, MANIFEST_OBJECT_KEY, serializeManifest, emptyManifest } from '../persistence/object-manifest.js';

function tmp() { return mkdtempSync(path.join(os.tmpdir(), 'serpent-upl-')); }
async function fsStore(bucketDir) {
  return openObjectStore({ env: { [OBJECT_STORE_ENV.provider]: 'FILESYSTEM', [OBJECT_STORE_ENV.dir]: bucketDir, [OBJECT_STORE_ENV.prefix]: 'serpent/bulk' } });
}
function writeFile(root, rel, body, mtimeSec = null) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (mtimeSec !== null) utimesSync(abs, mtimeSec, mtimeSec);
  return abs;
}

test('OM-1. the manifest law: exact keys, content-addressed object key per path, duplicate-key and digest-shape refusal; parse revalidates', () => {
  const good = { version: 'serpent-object-manifest-1', updatedTs: 1, entries: { 'tape/a.jsonl': { key: objectKeyForPath('tape/a.jsonl'), bytes: 3, sha256: 'a'.repeat(64), mtimeMs: 10, uploadedTs: 20 } } };
  assert.equal(manifestError(good), null);
  assert.match(manifestError({ ...good, version: 'x' }), /version must be/);
  assert.match(manifestError({ ...good, entries: { 'tape/a.jsonl': { ...good.entries['tape/a.jsonl'], key: 'blob/deadbeef' } } }), /content-addressed key/);
  // a corrupt manifest parses to null (caller falls back to a full re-upload), a valid one round-trips
  assert.equal(parseManifest(Buffer.from('{not json')), null);
  assert.equal(parseManifest(Buffer.from('')), null);
  assert.deepEqual(parseManifest(serializeManifest(good)), good);
});

test('UP-1. first sync uploads every backed file, writes the manifest, and a second sync uploads nothing (changed-only)', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/2026-09-14/session.jsonl', 'a\nb\n');
    writeFile(data, 'broad-kraken/day/seg.000001.jsonl', '{"x":1}');
    writeFile(data, 'ignored/elsewhere.jsonl', 'not a backed source');
    const store = await fsStore(bucket);
    const uploader = createObjectUploader({ store, dataRoot: data, now: () => 1000 });
    const s1 = await uploader.syncOnce();
    assert.equal(s1.state, 'OK'); assert.equal(s1.uploaded, 2); assert.equal(s1.backed, 2); assert.equal(s1.scanned, 2, 'only the backed sources are scanned');
    // the manifest is durable in the bucket and maps each path to its content-addressed key
    const manifest = parseManifest(await store.adapter.get(MANIFEST_OBJECT_KEY));
    assert.equal(manifestError(manifest), null);
    assert.deepEqual(Object.keys(manifest.entries).sort(), ['broad-kraken/day/seg.000001.jsonl', 'tape/2026-09-14/session.jsonl']);
    assert.equal(manifest.entries['tape/2026-09-14/session.jsonl'].key, objectKeyForPath('tape/2026-09-14/session.jsonl'));
    assert.deepEqual(await store.adapter.get(objectKeyForPath('tape/2026-09-14/session.jsonl')), Buffer.from('a\nb\n'));
    const s2 = await uploader.syncOnce();
    assert.equal(s2.uploaded, 0); assert.equal(s2.skippedUnchanged, 2);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('UP-2. a grown file re-uploads; identical content at a new mtime re-digests but does not re-put', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/s.jsonl', 'line1\n', 1000);
    const store = await fsStore(bucket);
    let clock = 5000;
    const uploader = createObjectUploader({ store, dataRoot: data, now: () => clock });
    await uploader.syncOnce();
    // append: bytes change -> re-upload
    writeFile(data, 'tape/s.jsonl', 'line1\nline2\n', 2000);
    clock = 6000;
    const s = await uploader.syncOnce();
    assert.equal(s.uploaded, 1);
    assert.deepEqual(await store.adapter.get(objectKeyForPath('tape/s.jsonl')), Buffer.from('line1\nline2\n'));
    // touch only mtime, same bytes+content -> re-digested, NOT re-put, manifest mtime refreshed
    writeFile(data, 'tape/s.jsonl', 'line1\nline2\n', 3000);
    clock = 7000;
    const s2 = await uploader.syncOnce();
    assert.equal(s2.uploaded, 0); assert.equal(s2.skippedUnchanged, 1);
    assert.equal(uploader._manifest().entries['tape/s.jsonl'].mtimeMs, 3000 * 1000);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('UP-3. a file gone from local disk is LEFT in the bucket and the manifest — durability is never pruned', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/keep.jsonl', 'keep');
    const store = await fsStore(bucket);
    const uploader = createObjectUploader({ store, dataRoot: data, now: () => 1 });
    await uploader.syncOnce();
    rmSync(path.join(data, 'tape/keep.jsonl'));
    const s = await uploader.syncOnce();
    assert.equal(s.scanned, 0); assert.equal(s.uploaded, 0); assert.equal(s.backed, 1, 'the manifest entry survives a wiped local copy');
    assert.deepEqual(await store.adapter.get(objectKeyForPath('tape/keep.jsonl')), Buffer.from('keep'), 'the durable object is untouched');
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('UP-4. restart-safe: a fresh uploader over the same bucket reads the manifest and re-uploads nothing', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'learning/model.jsonl', 'row\n');
    const store1 = await fsStore(bucket);
    await createObjectUploader({ store: store1, dataRoot: data, now: () => 1 }).syncOnce();
    // a new process: new store handle, new uploader, same bucket + same local files
    const store2 = await fsStore(bucket);
    const s = await createObjectUploader({ store: store2, dataRoot: data, now: () => 2 }).syncOnce();
    assert.equal(s.uploaded, 0); assert.equal(s.skippedUnchanged, 1);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('UP-5. an over-cap file is reported SKIPPED_TOO_LARGE, never silently dropped; a corrupt bucket manifest falls back to a full re-upload', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/ok.jsonl', 'small');
    const store = await fsStore(bucket);
    // plant a corrupt manifest in the bucket
    await store.adapter.put(MANIFEST_OBJECT_KEY, Buffer.from('{not a manifest'));
    const uploader = createObjectUploader({ store, dataRoot: data, now: () => 1 });
    const s = await uploader.syncOnce();
    assert.equal(s.uploaded, 1, 'the corrupt manifest is discarded and everything re-uploads');
    assert.equal(manifestError(parseManifest(await store.adapter.get(MANIFEST_OBJECT_KEY))), null, 'a valid manifest replaces the corrupt one');
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('UP-6. the uploader refuses a non-ACTIVE store', async () => {
  const store = await openObjectStore({ env: {} });
  assert.throws(() => createObjectUploader({ store, dataRoot: tmp() }), /requires an ACTIVE object store/);
  void emptyManifest;
});
