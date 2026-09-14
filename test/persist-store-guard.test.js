import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { inspectStoreAnchor, checkStoreAnchors } from '../persistence/store-guard.js';
import { persistenceHealth } from '../persistence/health.js';

const payload = '{"id":"observation-1","knownAt":10}\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
function anchorFor(text = payload, over = {}) {
  return {
    anchorVersion: 'store-anchor-1', storeId: 'study:test', relativePath: 'learning/observations.jsonl',
    format: 'JSONL', storeVersion: 'test-1', recordCount: text === '' ? 0 : text.trimEnd().split('\n').length,
    byteCount: Buffer.byteLength(text), headDigest: sha(text), headTs: 10, revision: 1, ...over,
  };
}
function fixture(t, { text = null, anchor = anchorFor() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'persist-store-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ...anchor.relativePath.split('/'));
  if (text !== null) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
  return { root, file, anchor };
}
function dbFor(anchor, text = payload, { fail = false, missingPayload = false, changedRevision = false } = {}) {
  const makeRow = () => {
    const { revision, ...metadata } = anchor;
    return { store_id: anchor.storeId, relative_path: anchor.relativePath, revision,
      metadata, payload_digest: anchor.headDigest, byte_count: anchor.byteCount, payload: text };
  };
  return {
    tx: async () => { throw new Error('guard must never write'); },
    query: async (sql) => {
      if (fail) throw new Error('synthetic database failure');
      assert.match(sql, /^SELECT /);
      if (!anchor) return { rows: [] };
      const row = makeRow();
      if (missingPayload) row.payload = null;
      if (changedRevision && sql.includes('WHERE a.store_id')) row.revision += 1;
      return { rows: [row] };
    },
  };
}

test('anchored missing directory is WIPED, never silently initialized on either restart', async (t) => {
  const f = fixture(t);
  const before = readdirSync(f.root);
  for (let restart = 0; restart < 2; restart++) {
    const report = await checkStoreAnchors({ db: dbFor(f.anchor), dataRoot: f.root });
    assert.equal(report.status, 'DEGRADED');
    assert.equal(report.permissionLock, true);
    assert.equal(report.failureCategory, 'STORE_ANCHOR_WIPED');
    assert.equal(report.stores[0].reason, 'ANCHORED_CACHE_MISSING');
    assert.equal(existsSync(f.file), false);
    assert.deepEqual(readdirSync(f.root), before, 'guard does not create registry/cache');
  }
});

test('exact acknowledged payload and cache match is HEALTHY; nested snapshot metadata is read correctly', async (t) => {
  const f = fixture(t, { text: payload });
  const report = await checkStoreAnchors({ db: dbFor(f.anchor), dataRoot: f.root });
  assert.equal(report.status, 'HEALTHY'); assert.equal(report.permissionLock, false);
  assert.equal(report.checked, 1); assert.equal(report.stores[0].revision, 1);
  assert.equal(readFileSync(f.file, 'utf8'), payload);
});

test('a truly empty commissioned JSONL file is healthy; its absence is still WIPED', async (t) => {
  const anchor = anchorFor('');
  const f = fixture(t, { anchor, text: '' });
  assert.equal((await checkStoreAnchors({ db: dbFor(anchor, ''), dataRoot: f.root })).status, 'HEALTHY');
  const absent = fixture(t, { anchor });
  assert.equal((await inspectStoreAnchor({ dataRoot: absent.root, anchor })).status, 'WIPED');
});

test('zero anchors is UNCOMMISSIONED, not blanket proof that old stores are NEW or backed up', async (t) => {
  const f = fixture(t, { text: payload });
  const report = await checkStoreAnchors({ db: dbFor(null), dataRoot: f.root });
  assert.equal(report.status, 'UNCOMMISSIONED'); assert.equal(report.checked, 0);
  assert.equal(report.coverage, 'COMMISSIONED_SNAPSHOTS_ONLY');
  assert.equal(readFileSync(f.file, 'utf8'), payload);
});

test('truncated, extended, same-size-corrupt and non-file caches all refuse without rewriting', async (t) => {
  const cases = [
    [payload.slice(0, -2), 'WIPED'],
    [payload + '{"extra":1}\n', 'UNANCHORED_WRITES'],
    [payload.replace('observation', 'OBSERVATION'), 'DIVERGED'],
  ];
  for (const [text, expected] of cases) {
    const f = fixture(t, { text });
    const report = await inspectStoreAnchor({ dataRoot: f.root, anchor: f.anchor });
    assert.equal(report.status, expected); assert.equal(report.permissionLock, true);
    assert.equal(readFileSync(f.file, 'utf8'), text, 'evidence is untouched');
  }
  const f = fixture(t); mkdirSync(f.file, { recursive: true });
  assert.equal((await inspectStoreAnchor({ dataRoot: f.root, anchor: f.anchor })).reason, 'CACHE_NOT_REGULAR_FILE');
});

test('valid local bytes cannot conceal missing/corrupt durable payload or a concurrent durable revision change', async (t) => {
  const f = fixture(t, { text: payload });
  for (const db of [dbFor(f.anchor, 'bad'), dbFor(f.anchor, payload, { missingPayload: true }), dbFor(f.anchor, payload, { fail: true })]) {
    const report = await checkStoreAnchors({ db, dataRoot: f.root });
    assert.equal(report.permissionLock, true);
    assert.equal(report.failureCategory, 'STORE_ANCHOR_VERIFICATION_FAILED');
    assert.equal(readFileSync(f.file, 'utf8'), payload);
  }
  const changed = await checkStoreAnchors({ db: dbFor(f.anchor, payload, { changedRevision: true }), dataRoot: f.root });
  assert.equal(changed.stores[0].status, 'CHANGED_DURING_CHECK');
});

test('unsafe metadata paths are rejected before disk inspection', async (t) => {
  const f = fixture(t);
  for (const relativePath of ['../outside.jsonl', '/outside.jsonl', 'C:/outside.jsonl', 'learning\\outside.jsonl', 'a/../outside.jsonl']) {
    await assert.rejects(() => inspectStoreAnchor({ dataRoot: f.root, anchor: { ...f.anchor, relativePath } }), /ANCHOR_INVALID/);
  }
  assert.deepEqual(readdirSync(f.root), []);
});

test('symlink/junction parents are refused even when the target has matching bytes', async (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'target'); mkdirSync(target);
  writeFileSync(path.join(target, 'observations.jsonl'), payload);
  symlinkSync(target, path.join(f.root, 'learning'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await inspectStoreAnchor({ dataRoot: f.root, anchor: f.anchor });
  assert.equal(report.status, 'INVALID'); assert.equal(report.reason, 'SYMLINK_REFUSED');
});

test('store loss locks new permission but does not erase restored=true or mutate caller health evidence', () => {
  const storeGuard = { permissionLock: true, failureCategory: 'STORE_ANCHOR_WIPED', stores: [{ storeId: 'study:test', status: 'WIPED' }] };
  const h = persistenceHealth({ db: { configured: () => true, reachable: true }, restored: true, storeGuard });
  assert.equal(h.status, 'DEGRADED'); assert.equal(h.permissionLock, true); assert.equal(h.restored, true);
  assert.equal(h.storeIntegrityLock, true); assert.equal(h.failureCategory, 'STORE_ANCHOR_WIPED');
  h.storeGuard.stores[0].status = 'HEALTHY';
  assert.equal(storeGuard.stores[0].status, 'WIPED');
});
