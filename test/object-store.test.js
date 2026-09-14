// PERSIST-1 object-store substrate (2026-09-14). The adapter contract, the dependency-free FILESYSTEM backend, and the
// env-NAME-only configuration resolver. No network, no secrets, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  openObjectStore, resolveObjectStoreConfig, objectKeyError, ObjectStoreError,
  OBJECT_STORE_ENV, OBJECT_STORE_CREDENTIAL_NAMES, MAX_OBJECT_BYTES,
} from '../persistence/object-store.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmpRoot = () => mkdtempSync(path.join(os.tmpdir(), 'serpent-objstore-'));

test('OS-1. provider selection is fail-closed: unset is DISABLED, S3/GCS are NOT_COMMISSIONED with the missing names, a bad provider or prefix is MISCONFIGURED — and never a credential value', () => {
  assert.equal(resolveObjectStoreConfig({}).state, 'DISABLED');
  assert.equal(resolveObjectStoreConfig({ [OBJECT_STORE_ENV.provider]: '  ' }).state, 'DISABLED');
  assert.equal(resolveObjectStoreConfig({ [OBJECT_STORE_ENV.provider]: 'sqlite' }).state, 'MISCONFIGURED');

  const s3 = resolveObjectStoreConfig({ [OBJECT_STORE_ENV.provider]: 's3', SERPENT_OBJECT_STORE_ACCESS_KEY_ID: 'AKIA-not-read' });
  assert.equal(s3.state, 'NOT_COMMISSIONED'); assert.equal(s3.provider, 'S3');
  assert.deepEqual(s3.credentials, { SERPENT_OBJECT_STORE_ACCESS_KEY_ID: true, SERPENT_OBJECT_STORE_SECRET_ACCESS_KEY: false });
  assert.ok(s3.missing.includes(OBJECT_STORE_ENV.bucket) && s3.missing.includes('SERPENT_OBJECT_STORE_SECRET_ACCESS_KEY'));
  assert.ok(!JSON.stringify(s3).includes('AKIA-not-read'), 'a credential value never appears in the resolved config');

  const gcs = resolveObjectStoreConfig({ [OBJECT_STORE_ENV.provider]: 'GCS', [OBJECT_STORE_ENV.bucket]: 'b', SERPENT_OBJECT_STORE_GCS_SERVICE_ACCOUNT_JSON: '{"k":"v"}' });
  assert.equal(gcs.state, 'NOT_COMMISSIONED'); assert.deepEqual(gcs.missing, []); assert.equal(gcs.bucket, 'b');
  assert.deepEqual(Object.keys(gcs.credentials), [...OBJECT_STORE_CREDENTIAL_NAMES.GCS]);

  const fsMissing = resolveObjectStoreConfig({ [OBJECT_STORE_ENV.provider]: 'FILESYSTEM' });
  assert.equal(fsMissing.state, 'MISCONFIGURED'); assert.deepEqual(fsMissing.missing, [OBJECT_STORE_ENV.dir]);
  const badPrefix = resolveObjectStoreConfig({ [OBJECT_STORE_ENV.provider]: 'FILESYSTEM', [OBJECT_STORE_ENV.dir]: '/tmp/x', [OBJECT_STORE_ENV.prefix]: '../escape' });
  assert.equal(badPrefix.state, 'MISCONFIGURED');
});

test('OS-2. openObjectStore returns no adapter unless ACTIVE; S3/GCS/DISABLED are dark gates', async () => {
  for (const env of [{}, { [OBJECT_STORE_ENV.provider]: 'S3' }, { [OBJECT_STORE_ENV.provider]: 'GCS' }]) {
    const store = await openObjectStore({ env });
    assert.equal(store.adapter, null, `no adapter for ${env[OBJECT_STORE_ENV.provider] ?? 'unset'}`);
    assert.notEqual(store.state, 'ACTIVE');
  }
});

test('OS-3. object key law: traversal, leading slash, backslash, trailing-dot, reserved segments and over-length are refused', () => {
  for (const good of ['a', 'a/b/c.jsonl', 'broad-kraken/2026-09-14/segment.000123.jsonl', 'x_y-z.9']) assert.equal(objectKeyError(good), null, good);
  for (const bad of ['', '/a', 'a/../b', '..', './a', 'A/B', 'a//b', 'a\\b', 'a/b.', 'con', 'nul.txt', 'a b', 'a'.repeat(513)]) assert.ok(objectKeyError(bad), `${bad} must be refused`);
});

test('OS-4. FILESYSTEM round-trip: put returns the digest, get returns exact bytes, head is stat-only, list is sorted and skips tmp/dirs, delete reports presence', async () => {
  const root = tmpRoot();
  try {
    const store = await openObjectStore({ env: { [OBJECT_STORE_ENV.provider]: 'FILESYSTEM', [OBJECT_STORE_ENV.dir]: root, [OBJECT_STORE_ENV.prefix]: 'serpent/bulk' } });
    assert.equal(store.state, 'ACTIVE'); assert.equal(store.adapter.provider, 'FILESYSTEM');
    const a = Buffer.from('alpha\nline\n'); const b = Buffer.from('{"seg":123}');
    const pa = await store.adapter.put('broad-kraken/day/a.jsonl', a);
    assert.deepEqual(pa, { key: 'broad-kraken/day/a.jsonl', bytes: a.byteLength, sha256: sha(a) });
    await store.adapter.put('broad-kraken/day/b.json', b);
    assert.deepEqual(await store.adapter.get('broad-kraken/day/a.jsonl'), a);
    assert.equal(await store.adapter.get('broad-kraken/day/missing.jsonl'), null);
    assert.deepEqual(await store.adapter.head('broad-kraken/day/b.json'), { key: 'broad-kraken/day/b.json', bytes: b.byteLength });
    assert.equal(await store.adapter.head('nope/x'), null);
    // a stray tmp file and a nested dir must not appear as objects
    writeFileSync(path.join(root, 'serpent/bulk/broad-kraken/day/c.jsonl.9.tmp'), 'partial');
    assert.deepEqual((await store.adapter.list('broad-kraken')).map((o) => o.key), ['broad-kraken/day/a.jsonl', 'broad-kraken/day/b.json']);
    assert.deepEqual((await store.adapter.list()).map((o) => o.key), ['broad-kraken/day/a.jsonl', 'broad-kraken/day/b.json']);
    assert.equal(await store.adapter.delete('broad-kraken/day/a.jsonl'), true);
    assert.equal(await store.adapter.delete('broad-kraken/day/a.jsonl'), false);
    assert.deepEqual((await store.adapter.list()).map((o) => o.key), ['broad-kraken/day/b.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OS-5. the backend never escapes its root and never follows a symlink out', async () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  try {
    writeFileSync(path.join(outside, 'secret'), 'do-not-read');
    const store = await openObjectStore({ env: { [OBJECT_STORE_ENV.provider]: 'FILESYSTEM', [OBJECT_STORE_ENV.dir]: root } });
    await assert.rejects(() => store.adapter.get('../' + path.basename(outside) + '/secret'), ObjectStoreError);
    await assert.rejects(() => store.adapter.put('a/../../escape', Buffer.from('x')), ObjectStoreError);
    // a symlink planted inside the root pointing outside is treated as absent, never read through
    mkdirSync(path.join(root, 'link-dir'));
    symlinkSync(path.join(outside, 'secret'), path.join(root, 'link-dir', 'leak'));
    assert.equal(await store.adapter.get('link-dir/leak'), null);
    assert.equal(await store.adapter.head('link-dir/leak'), null);
    assert.deepEqual(await store.adapter.list(), [], 'a symlink is never listed as an object');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('OS-6. bounds and type: a non-Buffer put and an over-cap put are refused; the cap is the documented one', async () => {
  const root = tmpRoot();
  try {
    const store = await openObjectStore({ env: { [OBJECT_STORE_ENV.provider]: 'FILESYSTEM', [OBJECT_STORE_ENV.dir]: root } });
    await assert.rejects(() => store.adapter.put('k', 'not a buffer'), /OBJECT_PAYLOAD_INVALID/);
    assert.equal(MAX_OBJECT_BYTES, 256 * 1024 * 1024);
    // exercise the cap without allocating 256 MiB: a fake oversized buffer view
    const huge = { byteLength: MAX_OBJECT_BYTES + 1 };
    Object.setPrototypeOf(huge, Buffer.prototype);
    await assert.rejects(() => store.adapter.put('k', huge), /OBJECT_TOO_LARGE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
