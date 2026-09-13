import test from 'node:test';
import assert from 'node:assert/strict';
import { openExternalCheckpointStore, EXTERNAL_CHECKPOINT_IDS, EXTERNAL_CHECKPOINT_RECORD_VERSION } from '../persistence/external-checkpoint-store.js';

class FakeDb {
  constructor() { this.alive = true; this.released = 0; this.lockAvailable = true; }
  async acquireSessionLock() {
    if (!this.lockAvailable) return null;
    return { held: () => this.alive, release: async () => { this.released += 1; this.alive = false; } };
  }
}

class FakeRepo {
  constructor() { this.rows = new Map(); this.forceConflict = new Set(); this.writes = []; }
  async loadRuntimeState(id) { const row = this.rows.get(id); return row ? structuredClone(row) : null; }
  async saveRuntimeState(id, state, expectedRevision = null) {
    const cur = this.rows.get(id);
    if (!cur) { const row = { revision: 1, state: structuredClone(state) }; this.rows.set(id, row); this.writes.push({ id, expectedRevision, state: structuredClone(state) }); return { ...structuredClone(row), conflict: false }; }
    const stale = this.forceConflict.delete(id) || expectedRevision !== cur.revision;
    const row = { revision: cur.revision + 1, state: stale ? structuredClone(cur.state) : structuredClone(state) };
    this.rows.set(id, row); this.writes.push({ id, expectedRevision, state: structuredClone(state) });
    return { ...structuredClone(row), conflict: stale };
  }
}

const validator = (state) => Number.isSafeInteger(state?.used) && state.used >= 0 ? { ok: true } : { ok: false, errors: ['used invalid'] };
const persistence = () => { const db = new FakeDb(); const repo = new FakeRepo(); return { db, repo, health: () => ({ databaseConfigured: true, restored: true }) }; };

test('external checkpoint restore never treats absence as zero and one missing source does not poison another', async () => {
  const p = persistence(); const store = await openExternalCheckpointStore({ persistence: p });
  await assert.rejects(() => store.restore({ id: EXTERNAL_CHECKPOINT_IDS.YOUTUBE, validate: validator }), /CHECKPOINT_ABSENT/);
  assert.equal(store.failed(EXTERNAL_CHECKPOINT_IDS.YOUTUBE).code, 'CHECKPOINT_ABSENT');
  const budget = await store.restore({ id: EXTERNAL_CHECKPOINT_IDS.DATA_ONLY, validate: validator, commission: { allowCreate: true, state: { used: 0 }, reason: 'first request owner before any dispatch', ts: 123 } });
  assert.deepEqual(budget.snapshot(), { used: 0 });
  const row = p.repo.rows.get(EXTERNAL_CHECKPOINT_IDS.DATA_ONLY).state;
  assert.equal(row.v, EXTERNAL_CHECKPOINT_RECORD_VERSION); assert.equal(row.commissioning.mode, 'EXPLICIT_COMMISSION'); assert.equal(row.commissioning.ts, 123);
  await store.close();
  p.db = new FakeDb(); const reopened = await openExternalCheckpointStore({ persistence: p });
  const restored = await reopened.restore({ id: EXTERNAL_CHECKPOINT_IDS.DATA_ONLY, validate: validator });
  assert.deepEqual(restored.snapshot(), { used: 0 }, 'a fresh body restores the durable envelope without filesystem input');
  await reopened.close();
});

test('filesystem commissioning is explicit and serialized CAS updates keep first durable truth', async () => {
  const p = persistence(); const store = await openExternalCheckpointStore({ persistence: p });
  await assert.rejects(() => store.restore({ id: EXTERNAL_CHECKPOINT_IDS.DATA_ONLY, validate: validator, loadLocal: () => ({ used: 4 }) }), /commissioning metadata is required/);
  // A failed id stays latched by design; use another id to prove a valid import.
  const binding = await store.restore({ id: EXTERNAL_CHECKPOINT_IDS.MARKET, validate: validator, loadLocal: () => ({ used: 4 }), importMeta: { reason: 'validated quota journal before republish', ts: 1000 } });
  const [a, b] = await Promise.all([binding.update((s) => ({ used: s.used + 1 })), binding.update((s) => ({ used: s.used + 1 }))]);
  assert.deepEqual(a, { used: 5 }); assert.deepEqual(b, { used: 6 }); assert.equal(binding.revision(), 3); assert.deepEqual(binding.snapshot(), { used: 6 });
  assert.deepEqual(binding.commissioning(), { mode: 'FILESYSTEM_IMPORT', reason: 'validated quota journal before republish', ts: 1000 });
  await store.close(); assert.equal(p.db.released, 1);
});

test('CAS conflict latches only its checkpoint and a lost session lock blocks every checkpoint', async () => {
  const p = persistence(); const store = await openExternalCheckpointStore({ persistence: p });
  const a = await store.restore({ id: EXTERNAL_CHECKPOINT_IDS.DATA_ONLY, validate: validator, commission: { allowCreate: true, state: { used: 1 }, reason: 'test owner', ts: 1 } });
  const b = await store.restore({ id: EXTERNAL_CHECKPOINT_IDS.MARKET, validate: validator, commission: { allowCreate: true, state: { used: 2 }, reason: 'test owner', ts: 1 } });
  p.repo.forceConflict.add(EXTERNAL_CHECKPOINT_IDS.DATA_ONLY);
  await assert.rejects(() => a.commit({ used: 2 }), /CHECKPOINT_CAS_CONFLICT/);
  assert.deepEqual(await b.commit({ used: 3 }), { used: 3 }, 'another checkpoint remains independently usable');
  p.db.alive = false;
  await assert.rejects(() => b.commit({ used: 4 }), /LOCK_LOST/);
  await store.close();
});

test('store refuses startup before the durable core is restored or when another owner holds the lock', async () => {
  const p = persistence(); p.health = () => ({ databaseConfigured: true, restored: false, failureCategory: 'RESTORE_FAILED' });
  await assert.rejects(() => openExternalCheckpointStore({ persistence: p }), /PERSISTENCE_RESTORE_REQUIRED/);
  const q = persistence(); q.db.lockAvailable = false;
  await assert.rejects(() => openExternalCheckpointStore({ persistence: q }), /LOCK_HELD_ELSEWHERE/);
});

test('close drains mutations accepted before close and refuses later admission', async () => {
  const p = persistence();
  const store = await openExternalCheckpointStore({ persistence: p });
  const binding = await store.restore({
    id: EXTERNAL_CHECKPOINT_IDS.DATA_ONLY,
    validate: validator,
    commission: { allowCreate: true, state: { used: 0 }, reason: 'test owner', ts: 1 },
  });

  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const save = p.repo.saveRuntimeState.bind(p.repo);
  let updateCalls = 0;
  p.repo.saveRuntimeState = async (...args) => {
    if (args[2] !== null && ++updateCalls === 1) await writeGate;
    return save(...args);
  };

  const first = binding.commit({ used: 1 });
  const second = binding.commit({ used: 2 });
  const closing = store.close();
  assert.equal(store.status().closing, true);
  await assert.rejects(binding.commit({ used: 3 }), /STORE_CLOSING/);
  releaseWrite();

  await assert.doesNotReject(Promise.all([first, second, closing]));
  assert.equal(store.status().closed, true);
  assert.equal(store.status().closing, false);
  assert.equal(p.repo.rows.get(EXTERNAL_CHECKPOINT_IDS.DATA_ONLY).state.checkpoint.used, 2);
  assert.equal(p.db.released, 1);
});
