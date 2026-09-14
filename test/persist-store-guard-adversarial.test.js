import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkStoreAnchors } from '../persistence/store-guard.js';

const payload = '{"observed":1}\n';
const headDigest = createHash('sha256').update(payload).digest('hex');

function anchor(relativePath, overrides = {}) {
  return {
    anchorVersion: 'store-anchor-1',
    storeId: 'study:test',
    relativePath,
    format: 'JSONL',
    storeVersion: 'test-1',
    recordCount: 1,
    byteCount: Buffer.byteLength(payload),
    headDigest,
    headTs: 10,
    revision: 1,
    ...overrides,
  };
}

function rowOf(value, { includePayload }) {
  const { revision, ...metadata } = value;
  return {
    store_id: value.storeId,
    relative_path: value.relativePath,
    revision,
    metadata,
    payload_digest: value.headDigest,
    byte_count: value.byteCount,
    ...(includePayload ? { payload } : {}),
  };
}

test('list/read race refuses when any durable anchor identity field changes at the same revision and digest', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'persist-store-guard-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const listed = anchor('learning/listed.jsonl');
  const reread = anchor('learning/current.jsonl', {
    storeVersion: 'test-2',
    headTs: 11,
  });
  const listedFile = path.join(root, 'learning', 'listed.jsonl');
  mkdirSync(path.dirname(listedFile), { recursive: true });
  writeFileSync(listedFile, payload);

  const db = {
    tx: async () => { throw new Error('guard must never write'); },
    query: async (sql) => {
      if (sql.includes('ORDER BY a.store_id')) return { rows: [rowOf(listed, { includePayload: false })] };
      if (sql.includes('WHERE a.store_id = $1')) return { rows: [rowOf(reread, { includePayload: true })] };
      throw new Error('unexpected query');
    },
  };

  const report = await checkStoreAnchors({ db, dataRoot: root });
  assert.equal(report.status, 'DEGRADED');
  assert.equal(report.permissionLock, true);
  assert.equal(report.failureCategory, 'STORE_ANCHOR_CHANGED_DURING_CHECK');
  assert.equal(report.stores[0].status, 'CHANGED_DURING_CHECK');
  assert.equal(report.stores[0].reason, 'DURABLE_HEAD_CHANGED_DURING_CHECK');
});
