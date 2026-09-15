// PERSIST-1 GCS provider end-to-end (2026-09-15). The GCS adapter and the restore-on-boot + uploader run against an
// in-memory GCS client double (the durable bucket survives a store re-open, as it would across a Replit republish). No
// network, no real credential — the same uploader/restore code paths that the FILESYSTEM backend uses, over GCS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openObjectStore, OBJECT_STORE_ENV, MAX_OBJECT_BYTES } from '../persistence/object-store.js';
import { createObjectUploader } from '../persistence/object-uploader.js';
import { restoreObjectStoreOnBoot } from '../persistence/object-restore.js';

function tmp() { return mkdtempSync(path.join(os.tmpdir(), 'serpent-gcs-')); }
// the durable bucket: an in-memory GCS client double keyed by full object name (prefix already applied by the backend)
function memGcsClient(bucket = 'serpent-bucket', store = new Map()) {
  return {
    bucket, _store: store,
    async putObject(name, bytes) { store.set(name, Buffer.from(bytes)); return { key: name, bytes: bytes.byteLength }; },
    async getObject(name) { return store.has(name) ? Buffer.from(store.get(name)) : null; },
    async headObject(name) { return store.has(name) ? { key: name, bytes: store.get(name).byteLength } : null; },
    async listObjects(prefix = '') { return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, bytes: v.byteLength })); },
    async deleteObject(name) { return store.delete(name); },
    describe: () => ({ provider: 'GCS', bucket }),
  };
}
const gcsEnv = { [OBJECT_STORE_ENV.provider]: 'GCS', [OBJECT_STORE_ENV.bucket]: 'serpent-bucket', [OBJECT_STORE_ENV.prefix]: 'serpent/bulk', SERPENT_OBJECT_STORE_GCS_SERVICE_ACCOUNT_JSON: '{"present":"but-injected-client-used"}' };
async function gcsStore(client) { return openObjectStore({ env: gcsEnv, gcsClient: client }); }
function writeFile(root, rel, body) { const abs = path.join(root, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, body); return abs; }

test('GCS-BE-1. the GCS backend is ACTIVE with a client; put/get/head/delete round-trip, prefix is applied and stripped on list, keys are validated and the object cap holds', async () => {
  const client = memGcsClient();
  const store = await gcsStore(client);
  assert.equal(store.state, 'ACTIVE'); assert.equal(store.adapter.provider, 'GCS'); assert.equal(store.describe().bucket, 'serpent-bucket');
  const put = await store.adapter.put('tape/a.jsonl', Buffer.from('hello')); assert.equal(put.bytes, 5); assert.equal(put.sha256.length, 64);
  // the object lands under the prefix in the durable bucket, but the adapter speaks prefix-relative keys
  assert.ok(client._store.has('serpent/bulk/tape/a.jsonl'));
  assert.equal((await store.adapter.get('tape/a.jsonl')).toString(), 'hello');
  assert.equal((await store.adapter.head('tape/a.jsonl')).bytes, 5);
  assert.equal(await store.adapter.get('tape/missing.jsonl'), null);
  assert.deepEqual(await store.adapter.list('tape'), [{ key: 'tape/a.jsonl', bytes: 5 }]);
  assert.equal(await store.adapter.delete('tape/a.jsonl'), true);
  assert.equal(await store.adapter.delete('tape/a.jsonl'), false);
  await assert.rejects(() => store.adapter.put('../escape', Buffer.from('x')), /OBJECT_KEY/);
  await assert.rejects(() => store.adapter.put('tape/big', Buffer.alloc(MAX_OBJECT_BYTES + 1)), /OBJECT_TOO_LARGE/);
});

test('GCS-E2E-1. uploader mirrors backed files into GCS; a fresh store on the same bucket restores them after a wipe, digest-verified', async () => {
  const client = memGcsClient(); const data = tmp();
  try {
    writeFile(data, 'tape/2026-09-15/session.jsonl', 'a\nb\n');
    writeFile(data, 'broad-kraken/day/seg.000001.jsonl', '{"x":1}\n');
    writeFile(data, 'learning/shadow/rec.jsonl', '{"lane":"CROSS_VENUE_SHADOW"}\n');
    writeFile(data, 'ignored/elsewhere.jsonl', 'not a backed source');
    const up = await createObjectUploader({ store: await gcsStore(client), dataRoot: data, now: () => 1 }).syncOnce();
    assert.equal(up.uploaded, 3, 'exactly the three backed files were mirrored'); assert.equal(up.failures, 0);
    // a wipe: the local bulk dirs are gone, the durable bucket (the mock client's Map) survives
    rmSync(path.join(data, 'tape'), { recursive: true, force: true }); rmSync(path.join(data, 'broad-kraken'), { recursive: true, force: true }); rmSync(path.join(data, 'learning'), { recursive: true, force: true });
    assert.ok(!existsSync(path.join(data, 'tape/2026-09-15/session.jsonl')));
    const restore = await restoreObjectStoreOnBoot({ store: await gcsStore(client), dataRoot: data });
    assert.equal(restore.state, 'OK'); assert.equal(restore.restored, 3); assert.equal(restore.failures, 0); assert.equal(restore.manifestEntries, 3);
    assert.equal(readFileSync(path.join(data, 'tape/2026-09-15/session.jsonl'), 'utf8'), 'a\nb\n');
    assert.equal(readFileSync(path.join(data, 'broad-kraken/day/seg.000001.jsonl'), 'utf8'), '{"x":1}\n');
    assert.ok(![...client._store.keys()].some((k) => k.includes('ignored')), 'a non-backed source was never made durable');
    // a second restore is a no-op (local copies already match the manifest digests)
    const again = await restoreObjectStoreOnBoot({ store: await gcsStore(client), dataRoot: data });
    assert.equal(again.restored, 0); assert.equal(again.state, 'OK');
  } finally { rmSync(data, { recursive: true, force: true }); }
});
