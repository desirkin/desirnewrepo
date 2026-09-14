import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORE_ANCHOR_VERSION,
  MAX_STORE_SNAPSHOT_BYTES,
  MAX_STORE_ANCHORS,
  StoreAnchorError,
  validateStoreAnchor,
  listStoreAnchors,
  readStoreSnapshot,
  saveStoreSnapshot,
} from '../persistence/store-anchors.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../persistence/schema.js';

const T0 = 1_789_272_000_000;

function copyMaps(state) {
  return {
    anchors: new Map([...state.anchors].map(([key, value]) => [key, structuredClone(value)])),
    snapshots: new Map([...state.snapshots].map(([key, value]) => [key, structuredClone(value)])),
  };
}

class FakeSqlDb {
  constructor() {
    this.state = { anchors: new Map(), snapshots: new Map() };
    this.calls = [];
    this.tail = Promise.resolve();
    this.pause = null;
  }

  row(state, storeId, { includePayload = true } = {}) {
    const anchor = state.anchors.get(storeId);
    if (!anchor) return null;
    const snapshot = state.snapshots.get(`${storeId}|${anchor.revision}`) ?? null;
    return {
      store_id: storeId,
      revision: anchor.revision,
      relative_path: anchor.relativePath,
      metadata: structuredClone(anchor.metadata),
      payload: includePayload ? snapshot?.payload ?? null : undefined,
      payload_digest: snapshot?.payloadDigest ?? null,
      byte_count: snapshot?.byteCount ?? null,
    };
  }

  execute(state, text, params = [], raw = false) {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql, params: structuredClone(params), raw });
    if (/^SELECT pg_advisory_xact_lock/.test(sql)) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    if (sql.includes('FROM serpent_store_anchors a') && sql.includes('WHERE a.store_id = $1')) {
      const row = this.row(state, params[0], { includePayload: sql.includes('s.payload,') });
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM serpent_store_anchors a') && sql.includes('ORDER BY a.store_id')) {
      const rows = [...state.anchors.keys()].sort().map((id) => this.row(state, id, { includePayload: false }));
      return { rows, rowCount: rows.length };
    }
    if (sql === 'SELECT store_id FROM serpent_store_anchors WHERE relative_path = $1 FOR UPDATE') {
      const rows = [...state.anchors.values()].filter((row) => row.relativePath === params[0]).map((row) => ({ store_id: row.storeId }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO serpent_store_snapshots')) {
      const [storeId, revision, payload, payloadDigest, byteCount] = params;
      const key = `${storeId}|${revision}`;
      if (state.snapshots.has(key)) throw Object.assign(new Error('snapshot unique conflict'), { code: '23505' });
      state.snapshots.set(key, { storeId, revision, payload, payloadDigest, byteCount });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO serpent_store_anchors')) {
      const [storeId, revision, relativePath, encoded] = params;
      if (state.anchors.has(storeId) || [...state.anchors.values()].some((row) => row.relativePath === relativePath)) {
        throw Object.assign(new Error('anchor unique conflict'), { code: '23505' });
      }
      state.anchors.set(storeId, { storeId, revision, relativePath, metadata: JSON.parse(encoded) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE serpent_store_anchors')) {
      const [storeId, revision, encoded, expectedRevision] = params;
      const current = state.anchors.get(storeId);
      if (!current || current.revision !== expectedRevision) return { rows: [], rowCount: 0 };
      state.anchors.set(storeId, { ...current, revision, metadata: JSON.parse(encoded) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unimplemented fake SQL: ${sql}`);
  }

  async query(text, params = []) {
    return this.execute(this.state, text, params);
  }

  tx(fn) {
    const operation = this.tail.then(async () => {
      if (this.pause) await this.pause;
      const draft = copyMaps(this.state);
      const q = async (text, params = []) => this.execute(draft, text, params);
      const result = await fn(q, { raw: async (text, params = []) => this.execute(draft, text, params, true), db: this });
      this.state = draft;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}

const saveInput = (over = {}) => ({
  storeId: 'controls-current',
  relativePath: 'state/controls.json',
  format: 'JSON',
  storeVersion: 'control-state-1',
  payload: '{"kill":null}',
  headTs: T0,
  expectedRevision: null,
  ...over,
});

const rejectsCode = async (promise, code) => assert.rejects(promise, (error) => error instanceof StoreAnchorError && error.code === code);

test('migration 10 adds bounded anchor and immutable exact-text snapshot tables without changing older migrations', () => {
  assert.equal(SCHEMA_VERSION, 10);
  assert.deepEqual(MIGRATIONS.map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const migration = MIGRATIONS.at(-1);
  assert.equal(migration.name, 'PERSIST-1 bounded small-store snapshot anchors');
  const sql = migration.statements.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serpent_store_anchors/);
  assert.match(sql, /relative_path text NOT NULL UNIQUE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serpent_store_snapshots/);
  assert.match(sql, /PRIMARY KEY \(store_id, revision\)/);
  assert.match(sql, /byte_count <= 1048576/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE serpent_store_snapshots/);
});

test('save inserts exact immutable payload before advancing anchor; read verifies bytes and list omits payload', async () => {
  const db = new FakeSqlDb();
  const created = await saveStoreSnapshot(db, saveInput());
  assert.equal(created.status, 'CREATED');
  assert.equal(created.anchor.anchorVersion, STORE_ANCHOR_VERSION);
  assert.equal(created.anchor.recordCount, 1);
  assert.equal(created.anchor.byteCount, Buffer.byteLength('{"kill":null}'));
  assert.equal(created.anchor.revision, 1);
  assert.deepEqual(validateStoreAnchor(created.anchor), created.anchor);

  const insertSnapshot = db.calls.findIndex((call) => call.sql.startsWith('INSERT INTO serpent_store_snapshots'));
  const insertAnchor = db.calls.findIndex((call) => call.sql.startsWith('INSERT INTO serpent_store_anchors'));
  assert.ok(insertSnapshot >= 0 && insertSnapshot < insertAnchor, 'payload is inserted before its anchor in the same transaction');
  assert.ok(db.calls.some((call) => call.sql.includes('LEFT JOIN serpent_store_snapshots') && call.sql.endsWith('FOR UPDATE OF a')), 'only the non-null anchor side of the left join is row-locked');
  assert.equal(db.calls.filter((call) => call.raw && call.sql.startsWith('SELECT pg_advisory_xact_lock')).length, 2);

  const read = await readStoreSnapshot(db, 'controls-current');
  assert.equal(read.payload, '{"kill":null}');
  assert.deepEqual(read.anchor, created.anchor);
  const listed = await listStoreAnchors(db);
  assert.deepEqual(listed, [created.anchor]);
  assert.equal(Object.hasOwn(listed[0], 'payload'), false);
});

test('JSONL has an exact LF law, allows only exact empty zero-record snapshot, and derives count itself', async () => {
  const db = new FakeSqlDb();
  const empty = await saveStoreSnapshot(db, saveInput({
    storeId: 'empty-log', relativePath: 'state/empty.jsonl', format: 'JSONL',
    storeVersion: 'empty-log-1', payload: '',
  }));
  assert.equal(empty.anchor.recordCount, 0);
  assert.equal(empty.anchor.byteCount, 0);

  const full = await saveStoreSnapshot(db, saveInput({
    storeId: 'audit-log', relativePath: 'state/audit.jsonl', format: 'JSONL',
    storeVersion: 'audit-log-1', payload: '{"a":1}\n0\n',
  }));
  assert.equal(full.anchor.recordCount, 2);
  assert.equal((await readStoreSnapshot(db, 'audit-log')).payload, '{"a":1}\n0\n');

  for (const payload of ['{"a":1}', '{"a":1}\r\n', '{"a":1}\n\n', ' \n', '{oops}\n']) {
    await rejectsCode(saveStoreSnapshot(db, saveInput({
      storeId: `bad-${Buffer.from(payload).toString('hex').slice(0, 20) || 'empty'}`,
      relativePath: `bad/${Buffer.from(payload).toString('hex').slice(0, 20) || 'empty'}.jsonl`,
      format: 'JSONL', storeVersion: 'bad-1', payload,
    })), 'PAYLOAD_INVALID');
  }
});

test('identical retries are idempotent; changed snapshots require exact CAS and monotonic head time', async () => {
  const db = new FakeSqlDb();
  const original = saveInput();
  const first = await saveStoreSnapshot(db, original);
  const retry = await saveStoreSnapshot(db, original);
  assert.equal(retry.status, 'EXISTING');
  assert.equal(retry.anchor.revision, 1);
  assert.equal(db.state.snapshots.size, 1);

  const second = await saveStoreSnapshot(db, saveInput({ payload: '{"kill":{"active":true}}', headTs: T0 + 1, expectedRevision: 1 }));
  assert.equal(second.status, 'UPDATED');
  assert.equal(second.anchor.revision, 2);
  assert.equal(db.state.snapshots.size, 2);
  const lostReplyRetry = await saveStoreSnapshot(db, saveInput({ payload: '{"kill":{"active":true}}', headTs: T0 + 1, expectedRevision: 1 }));
  assert.equal(lostReplyRetry.status, 'EXISTING');
  assert.equal(lostReplyRetry.anchor.revision, 2);
  await rejectsCode(saveStoreSnapshot(db, saveInput({ payload: '{"kill":{"active":true}}', headTs: T0 + 1, expectedRevision: null })), 'REVISION_CONFLICT');
  await rejectsCode(saveStoreSnapshot(db, saveInput({ payload: '{"kill":{"active":true}}', headTs: T0 + 1, expectedRevision: 999 })), 'REVISION_CONFLICT');
  await rejectsCode(saveStoreSnapshot(db, saveInput({ payload: '{"kill":"other"}', headTs: T0 + 2, expectedRevision: 1 })), 'REVISION_CONFLICT');
  await rejectsCode(saveStoreSnapshot(db, saveInput({ payload: '{"kill":"old-clock"}', headTs: T0 - 1, expectedRevision: 2 })), 'HEAD_TS_REGRESSION');
  assert.equal((await readStoreSnapshot(db, 'controls-current')).payload, '{"kill":{"active":true}}');
});

test('JSONL snapshots cannot truncate, rewrite or reorder acknowledged history even with the current revision', async () => {
  const db = new FakeSqlDb();
  const original = saveInput({ storeId: 'append-log', relativePath: 'learning/append.jsonl', format: 'JSONL', storeVersion: 'append-1', payload: '{"id":1}\n{"id":2}\n' });
  await saveStoreSnapshot(db, original);
  for (const payload of ['', '{"id":1}\n', '{"id":2}\n{"id":1}\n', '{"id":1}\n{"id":3}\n']) {
    await rejectsCode(saveStoreSnapshot(db, { ...original, payload, headTs: T0 + 1, expectedRevision: 1 }), 'JOURNAL_PREFIX_CONFLICT');
    assert.equal((await readStoreSnapshot(db, original.storeId)).payload, original.payload);
    assert.equal(db.state.snapshots.size, 1, 'failed rewrite cannot leave an acknowledged replacement');
  }
  const appended = await saveStoreSnapshot(db, { ...original, payload: original.payload + '{"id":3}\n', headTs: T0 + 1, expectedRevision: 1 });
  assert.equal(appended.anchor.recordCount, 3); assert.equal(appended.anchor.revision, 2);
  assert.equal(db.state.snapshots.size, 2, 'earlier exact snapshot remains retained');
});

test('concurrent writers serialize: identical create collapses and same-revision competitors cannot both advance', async () => {
  const db = new FakeSqlDb();
  const [left, right] = await Promise.all([saveStoreSnapshot(db, saveInput()), saveStoreSnapshot(db, saveInput())]);
  assert.deepEqual([left.status, right.status], ['CREATED', 'EXISTING']);

  const settled = await Promise.allSettled([
    saveStoreSnapshot(db, saveInput({ payload: '{"v":2}', headTs: T0 + 1, expectedRevision: 1 })),
    saveStoreSnapshot(db, saveInput({ payload: '{"v":3}', headTs: T0 + 2, expectedRevision: 1 })),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const refused = settled.find((result) => result.status === 'rejected');
  assert.equal(refused.reason.code, 'REVISION_CONFLICT');
  assert.equal(db.state.snapshots.size, 2, 'failed transaction leaves no orphan candidate payload');
});

test('relative path and store identity are immutable and aliases are refused transactionally', async () => {
  const db = new FakeSqlDb();
  await saveStoreSnapshot(db, saveInput());
  await rejectsCode(saveStoreSnapshot(db, saveInput({ storeId: 'alias', expectedRevision: null })), 'RELATIVE_PATH_CONFLICT');
  assert.equal(db.state.snapshots.size, 1);
  await rejectsCode(saveStoreSnapshot(db, saveInput({ relativePath: 'state/other.json', expectedRevision: 1 })), 'STORE_IDENTITY_CONFLICT');
  await rejectsCode(saveStoreSnapshot(db, saveInput({ format: 'JSONL', payload: '{}\n', expectedRevision: 1 })), 'STORE_IDENTITY_CONFLICT');
  await rejectsCode(saveStoreSnapshot(db, saveInput({ storeVersion: 'control-state-2', expectedRevision: 1 })), 'STORE_IDENTITY_CONFLICT');
});

test('unsafe paths, malformed payloads, and payloads above one MiB are refused before any transaction', async () => {
  for (const relativePath of ['../state/x', '/state/x', 'C:/state/x', 'state\\x', 'state//x', 'state/./x', 'state/../x', 'State/x', 'state/file.', 'state/con', 'state/NUL.txt']) {
    const db = new FakeSqlDb();
    await rejectsCode(saveStoreSnapshot(db, saveInput({ relativePath })), 'RELATIVE_PATH_INVALID');
    assert.equal(db.calls.length, 0);
  }
  for (const payload of ['', '{oops}', '\uFEFF{}']) {
    const db = new FakeSqlDb();
    await rejectsCode(saveStoreSnapshot(db, saveInput({ payload })), 'PAYLOAD_INVALID');
    assert.equal(db.calls.length, 0);
  }
  const db = new FakeSqlDb();
  await rejectsCode(saveStoreSnapshot(db, saveInput({ payload: `"${'x'.repeat(MAX_STORE_SNAPSHOT_BYTES)}"` })), 'PAYLOAD_TOO_LARGE');
  assert.equal(db.calls.length, 0);
  const unicode = new FakeSqlDb();
  await rejectsCode(saveStoreSnapshot(unicode, saveInput({ payload: `"${String.fromCharCode(0xd800)}"` })), 'PAYLOAD_INVALID');
  assert.equal(unicode.calls.length, 0);
});

test('caller input is copied before the first await', async () => {
  const db = new FakeSqlDb();
  let release;
  db.pause = new Promise((resolve) => { release = resolve; });
  const input = saveInput();
  const pending = saveStoreSnapshot(db, input);
  input.storeId = 'mutated'; input.relativePath = 'other/path.json'; input.payload = '{"changed":true}'; input.headTs += 99;
  release();
  const result = await pending;
  assert.equal(result.anchor.storeId, 'controls-current');
  assert.equal(result.anchor.relativePath, 'state/controls.json');
  assert.equal(result.anchor.headTs, T0);
  assert.equal((await readStoreSnapshot(db, 'controls-current')).payload, '{"kill":null}');
});

test('read and list fail closed on missing, altered, or re-described durable payloads', async () => {
  const db = new FakeSqlDb();
  await saveStoreSnapshot(db, saveInput());
  const snapshot = db.state.snapshots.get('controls-current|1');
  snapshot.payload = '{"kill":"forged"}';
  await rejectsCode(readStoreSnapshot(db, 'controls-current'), 'DURABLE_SNAPSHOT_INVALID');

  snapshot.payload = '{"kill":null}';
  db.state.anchors.get('controls-current').metadata.recordCount = 2;
  await rejectsCode(readStoreSnapshot(db, 'controls-current'), 'ANCHOR_INVALID');

  db.state.anchors.get('controls-current').metadata.recordCount = 1;
  db.state.snapshots.delete('controls-current|1');
  await rejectsCode(listStoreAnchors(db), 'DURABLE_SNAPSHOT_MISSING');
});

test('anchor validator and list reject impossible empty metadata and unbounded inventories', async () => {
  const db = new FakeSqlDb();
  const created = await saveStoreSnapshot(db, saveInput());
  assert.throws(() => validateStoreAnchor({ ...created.anchor, byteCount: 0 }), (error) => error.code === 'ANCHOR_INVALID');

  for (let index = 1; index <= MAX_STORE_ANCHORS; index += 1) {
    const id = `extra-${String(index).padStart(3, '0')}`;
    const relativePath = `extra/${String(index).padStart(3, '0')}.json`;
    await saveStoreSnapshot(db, saveInput({ storeId: id, relativePath }));
  }
  await rejectsCode(listStoreAnchors(db), 'ANCHOR_LIST_LIMIT');
});
