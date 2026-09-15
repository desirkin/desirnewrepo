// Composed startup through the real Db/Repository boundary, with a fake
// driver only. No DB/provider credentials or real server are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import { startPersistence } from '../persistence/runtime.js';
import { openExternalCheckpointStore } from '../persistence/external-checkpoint-store.js';

const payload = '{"observed":1}\n';
const anchor = {
  anchorVersion: 'store-anchor-1', storeId: 'study:test', relativePath: 'learning/observations.jsonl',
  format: 'JSONL', storeVersion: 'test-1', recordCount: 1, byteCount: Buffer.byteLength(payload),
  headDigest: createHash('sha256').update(payload).digest('hex'), headTs: 1, revision: 1,
};
function fakePool({ mode = 'ANCHORED', sqlLog = [] } = {}) {
  const query = async (sql) => {
    sqlLog.push(sql);
    if (sql.includes('SELECT version FROM serpent_schema_migrations')) return { rows: Array.from({ length: SCHEMA_VERSION }, (_, i) => ({ version: i + 1 })) };
    if (sql.includes('FROM serpent_store_anchors')) {
      if (mode === 'FAILED') throw new Error('synthetic read failure');
      if (mode === 'ABSENT') return { rows: [] };
      const { revision, ...metadata } = anchor;
      return { rows: [{ store_id: anchor.storeId, relative_path: anchor.relativePath, revision, metadata,
        payload, payload_digest: anchor.headDigest, byte_count: anchor.byteCount }] };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
}
async function start(t, { mode, existing = false, generation } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'persist-anchor-runtime-'));
  const previousRoot = process.env.COBRA_DATA_DIR;
  const previousGen = process.env.SERPENT_DATA_GENERATION;
  process.env.COBRA_DATA_DIR = root;
  if (generation === undefined) delete process.env.SERPENT_DATA_GENERATION; else process.env.SERPENT_DATA_GENERATION = generation;
  // dataDir() nests under the generation when one is set; the flat root is where a pre-generation crib's files live
  const activeRoot = generation ? path.join(root, generation) : root;
  const file = path.join(activeRoot, 'learning', 'observations.jsonl');
  if (existing) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, payload); }
  const sqlLog = []; const logs = [];
  const persistence = await startPersistence({
    dbOverrides: { url: 'postgresql://offline-fake/anchor-runtime', poolFactory: () => fakePool({ mode, sqlLog }), retries: 1 },
    log: (line) => logs.push(line), registerSignals: false,
  });
  t.after(async () => {
    await persistence.stop();
    if (previousRoot === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = previousRoot;
    if (previousGen === undefined) delete process.env.SERPENT_DATA_GENERATION; else process.env.SERPENT_DATA_GENERATION = previousGen;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file, persistence, sqlLog, logs };
}

test('WIPED cache locks CLEAR before consumers, preserves pump/core restore, and does not recreate missing study', async (t) => {
  const f = await start(t);
  const h = f.persistence.health();
  assert.equal(h.restored, true, 'protective core recovery/pump still completes');
  assert.equal(h.permissionLock, true); assert.equal(h.storeIntegrityLock, true);
  assert.equal(h.failureCategory, 'STORE_ANCHOR_WIPED');
  assert.equal(h.storeGuard.stores[0].storeId, 'study:test');
  assert.equal(existsSync(f.file), false, 'missing learning store never initialized');
  const anchorRead = f.sqlLog.findIndex((sql) => sql.includes('FROM serpent_store_anchors'));
  const controlRestore = f.sqlLog.findIndex((sql) => sql.includes('FROM serpent_control_state'));
  assert.ok(anchorRead >= 0 && controlRestore > anchorRead, 'inspection precedes local reconciliation');
  assert.deepEqual(await f.persistence.durableClearOrRefuse(), { allow: false, reason: 'PERSISTENCE_PERMISSION_LOCK' });
  assert.ok(f.persistence._internal.pumpTimer, 'read-only durability pump stays running');
  await f.persistence.pumpOnce();
  assert.equal(existsSync(f.file), false);
  const restricted = await f.persistence.persistControlSnapshot({ kill: { active: true, ts: new Date().toISOString() }, cage: null, vetoes: [] });
  assert.equal(restricted.durable, true, 'permission-reducing state can still be persisted');
  assert.equal(f.persistence.health().permissionLock, true, 'unrelated writes cannot clear store lock');

  // The actual external-checkpoint startup gate permits independently
  // protected collection to continue once the core has restored. Inject
  // only the lock lease; do not invoke any paid dispatcher or collector.
  let held = true;
  f.persistence.db.acquireSessionLock = async () => ({ held: () => held, release: async () => { held = false; } });
  const external = await openExternalCheckpointStore({ persistence: f.persistence });
  assert.equal(external.status().lockHeld, true);
  await external.close();
});

test('a healthy commissioned cache leaves permission unchanged and startup does not rewrite its anchor', async (t) => {
  const f = await start(t, { existing: true });
  assert.equal(f.persistence.health().storeGuard.status, 'HEALTHY');
  assert.equal(f.persistence.health().permissionLock, false);
  assert.equal(f.sqlLog.some((sql) => /INSERT INTO serpent_store_|UPDATE serpent_store_|DELETE FROM serpent_store_/.test(sql)), false);
});

test('anchor-query failure cannot be laundered by successful core restore; it remains named and locked', async (t) => {
  const f = await start(t, { mode: 'FAILED' });
  assert.equal(f.persistence.health().restored, true);
  assert.equal(f.persistence.health().permissionLock, true);
  assert.equal(f.persistence.health().failureCategory, 'STORE_ANCHOR_VERIFICATION_FAILED');
  assert.equal(existsSync(f.file), false);
});

test('PUBLISH-FIX-2 ROOT CAUSE: a prior generation\'s anchor is NOT_APPLICABLE under a new SERPENT_DATA_GENERATION — restored stays true, no store-integrity lock, the old cache is never read as WIPED', async (t) => {
  // The durable anchor row was commissioned under the FLAT crib (generation ''); its file lived under the old flat root.
  // Boot the same disk with SERPENT_DATA_GENERATION=gen1 (a Replit republish's clean crib). The gen1 root has no such
  // file — but that absence is EXPECTED, not a wipe. Before this fix the guard read the missing file as WIPED and held a
  // permission lock forever; now it reports NOT_APPLICABLE and the boot restores clean.
  const f = await start(t, { generation: 'gen1' }); // default ANCHORED mode; the anchor const carries no generation => flat
  const h = f.persistence.health();
  assert.equal(h.restored, true, 'the durable core restores; a foreign-generation anchor never blocks the boot');
  assert.equal(h.permissionLock, false, 'no permission lock: the missing gen1 file is not a wipe, it is another crib');
  assert.equal(h.storeIntegrityLock, false);
  assert.equal(h.failureCategory, null);
  assert.equal(h.storeGuard.status, 'UNCOMMISSIONED', 'nothing is commissioned for gen1 yet');
  assert.equal(h.storeGuard.notApplicable, 1);
  assert.equal(h.storeGuard.applicable, 0);
  assert.equal(h.storeGuard.stores[0].status, 'NOT_APPLICABLE');
  assert.equal(h.storeGuard.stores[0].reason, 'ANCHOR_FROM_ANOTHER_DATA_GENERATION');
  assert.equal(existsSync(f.file), false, 'the gen1 crib is never seeded from another generation\'s anchor');
  assert.equal(f.sqlLog.some((sql) => /INSERT INTO serpent_store_|UPDATE serpent_store_|DELETE FROM serpent_store_/.test(sql)), false);
  assert.equal((await f.persistence.durableClearOrRefuse()).allow, true, 'CLEAR is permitted — the store lock never engaged');
});

test('pre-commissioning checkout reports zero coverage explicitly; no automatic import occurs', async (t) => {
  const f = await start(t, { mode: 'ABSENT', existing: true });
  assert.equal(f.persistence.health().storeGuard.status, 'UNCOMMISSIONED');
  assert.equal(f.persistence.health().storeGuard.checked, 0);
  assert.equal(f.sqlLog.some((sql) => /INSERT INTO serpent_store_|UPDATE serpent_store_/.test(sql)), false);
});
