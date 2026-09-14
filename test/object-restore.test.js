// PERSIST-1 restore-on-boot (2026-09-14). Pull backed bulk files from the durable bucket after a republish wipes the
// container filesystem, digest-verified, before any consumer reads them. FILESYSTEM backend, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObjectStore, OBJECT_STORE_ENV } from '../persistence/object-store.js';
import { createObjectUploader } from '../persistence/object-uploader.js';
import { restoreObjectStoreOnBoot } from '../persistence/object-restore.js';
import { objectKeyForPath, MANIFEST_OBJECT_KEY } from '../persistence/object-manifest.js';

function tmp() { return mkdtempSync(path.join(os.tmpdir(), 'serpent-res-')); }
async function fsStore(bucketDir) { return openObjectStore({ env: { [OBJECT_STORE_ENV.provider]: 'FILESYSTEM', [OBJECT_STORE_ENV.dir]: bucketDir, [OBJECT_STORE_ENV.prefix]: 'p' } }); }
function writeFile(root, rel, body) { const abs = path.join(root, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, body); }

test('RS-1. after a wipe, restore pulls every backed file back, digest-verified, and reports the count', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/2026-09-14/s.jsonl', 'a\nb\n');
    writeFile(data, 'broad-kraken/seg.jsonl', '{"x":1}');
    const store = await fsStore(bucket);
    await createObjectUploader({ store, dataRoot: data, now: () => 1 }).syncOnce();
    // simulate the republish: the whole data dir is gone
    rmSync(data, { recursive: true, force: true }); mkdirSync(data);
    const summary = await restoreObjectStoreOnBoot({ store: await fsStore(bucket), dataRoot: data });
    assert.equal(summary.state, 'OK'); assert.equal(summary.restored, 2); assert.equal(summary.failures, 0); assert.equal(summary.manifestEntries, 2);
    assert.equal(readFileSync(path.join(data, 'tape/2026-09-14/s.jsonl'), 'utf8'), 'a\nb\n');
    assert.equal(readFileSync(path.join(data, 'broad-kraken/seg.jsonl'), 'utf8'), '{"x":1}');
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('RS-2. an intact local file is left untouched (its newer appends are not clobbered); only absent/diverged files are pulled', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/a.jsonl', 'one\n');
    writeFile(data, 'tape/b.jsonl', 'keep\n');
    const store = await fsStore(bucket);
    await createObjectUploader({ store, dataRoot: data, now: () => 1 }).syncOnce();
    // a.jsonl vanished; b.jsonl grew locally AFTER the upload (a newer local append the bucket has not seen)
    rmSync(path.join(data, 'tape/a.jsonl'));
    writeFile(data, 'tape/b.jsonl', 'keep\nnewer-local-append\n');
    const summary = await restoreObjectStoreOnBoot({ store: await fsStore(bucket), dataRoot: data });
    assert.equal(summary.restored, 1, 'only the missing file is restored');
    assert.equal(summary.verifiedPresent, 0, 'the grown local file is neither counted intact nor overwritten');
    assert.equal(readFileSync(path.join(data, 'tape/a.jsonl'), 'utf8'), 'one\n');
    assert.equal(readFileSync(path.join(data, 'tape/b.jsonl'), 'utf8'), 'keep\nnewer-local-append\n', 'the newer local append survives restore');
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('RS-3. an exactly-intact local file is verifiedPresent and not rewritten', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'learning/m.jsonl', 'row\n');
    const store = await fsStore(bucket);
    await createObjectUploader({ store, dataRoot: data, now: () => 1 }).syncOnce();
    const summary = await restoreObjectStoreOnBoot({ store: await fsStore(bucket), dataRoot: data });
    assert.equal(summary.restored, 0); assert.equal(summary.verifiedPresent, 1);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('RS-4. a durable object whose bytes do not match the manifest digest is REFUSED, never written', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    writeFile(data, 'tape/x.jsonl', 'good\n');
    const store = await fsStore(bucket);
    await createObjectUploader({ store, dataRoot: data, now: () => 1 }).syncOnce();
    // corrupt the durable object under its content-addressed key, leaving the manifest digest intact
    await store.adapter.put(objectKeyForPath('tape/x.jsonl'), Buffer.from('TAMPERED'));
    rmSync(data, { recursive: true, force: true }); mkdirSync(data);
    const summary = await restoreObjectStoreOnBoot({ store: await fsStore(bucket), dataRoot: data });
    assert.equal(summary.state, 'DEGRADED'); assert.equal(summary.restored, 0); assert.equal(summary.failures, 1);
    assert.equal(summary.firstFailure.reason, 'DURABLE_OBJECT_DIGEST_MISMATCH');
    assert.equal(existsSync(path.join(data, 'tape/x.jsonl')), false, 'a digest-mismatched object is never written to disk');
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});

test('RS-5. a dark / disabled store and an empty bucket are non-failures: nothing to restore', async () => {
  const data = tmp();
  try {
    const disabled = await openObjectStore({ env: {} });
    const s1 = await restoreObjectStoreOnBoot({ store: disabled, dataRoot: data });
    assert.equal(s1.state, 'STORE_DISABLED'); assert.equal(s1.restored, 0);
    const bucket = tmp();
    const s2 = await restoreObjectStoreOnBoot({ store: await fsStore(bucket), dataRoot: data });
    assert.equal(s2.state, 'MANIFEST_ABSENT'); assert.equal(s2.manifestEntries, 0);
    rmSync(bucket, { recursive: true, force: true });
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('RS-6. a corrupt bucket manifest is refused, not acted on', async () => {
  const data = tmp(); const bucket = tmp();
  try {
    const store = await fsStore(bucket);
    await store.adapter.put(MANIFEST_OBJECT_KEY, Buffer.from('{not a manifest'));
    const summary = await restoreObjectStoreOnBoot({ store: await fsStore(bucket), dataRoot: data });
    assert.equal(summary.state, 'MANIFEST_CORRUPT'); assert.equal(summary.restored, 0);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }); }
});
