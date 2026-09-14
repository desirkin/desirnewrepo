// PERSIST-1 real-PostgreSQL substrate proofs. This file never falls back to
// DATABASE_URL: a caller must supply an explicitly attested throwaway test
// database, and every object is confined to one generated schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const ISOLATION_ATTESTATION = 'THROWAWAY_SCHEMA_ONLY';
const T0 = 1_789_272_000_000;
const suffix = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const SCHEMA = `persist1_pg_${suffix}`;
const id = (name) => `p10:${suffix}:${name}`;
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function testDatabaseAuthorityError() {
  if (!TEST_URL) return null;
  if (process.env.PERSIST_TEST_DATABASE_ISOLATED !== ISOLATION_ATTESTATION) {
    return `PERSIST_TEST_DATABASE_ISOLATED must equal ${ISOLATION_ATTESTATION}`;
  }
  if (process.env.DATABASE_URL) return 'ambient DATABASE_URL must be absent for this isolated integration suite';
  let parsed;
  try { parsed = new URL(TEST_URL); }
  catch { return 'PERSIST_TEST_DATABASE_URL must be a valid PostgreSQL URL'; }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return 'test URL protocol must be postgres or postgresql';
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|testing|ci|sandbox|throwaway|ephemeral)(?:[_-]|$)/i.test(databaseName)) {
    return 'test database name must contain a delimited test/ci/sandbox/throwaway/ephemeral marker';
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(SCHEMA)) return 'generated schema name is not a safe PostgreSQL identifier';
  return null;
}

const authorityError = testDatabaseAuthorityError();
const save = ({ storeId = id('cas'), relativePath = `persist1/${suffix}/cas.json`, format = 'JSON', storeVersion = 'persist1-pg-1', payload = '{"v":1}', headTs = T0, expectedRevision = null } = {}) => ({
  storeId, relativePath, format, storeVersion, payload, headTs, expectedRevision,
});
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error?.code === code);

async function observeAdvisoryWait(db, applicationName, { maxProbes = 256 } = {}) {
  for (let probe = 0; probe < maxProbes; probe += 1) {
    const { rows } = await db.query(`SELECT pid, state, wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = $1
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND lower(COALESCE(wait_event, '')) = 'advisory'
        AND position('pg_advisory_xact_lock(hashtext($1))' in query) > 0`, [applicationName]);
    if (rows.length > 0) return rows;
    // Each probe is a real server round trip and setImmediate only yields to
    // the contender. There is no elapsed-time assertion or guessed sleep.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`no active advisory-lock waiter observed after ${maxProbes} server probes`);
}

if (!TEST_URL) {
  test('PERSIST-1 real PostgreSQL anchor integration', (t) => {
    t.skip('PERSIST_TEST_DATABASE_URL absent: an explicitly attested isolated test database is required');
  });
} else if (authorityError) {
  test('PERSIST-1 refuses an unverified PostgreSQL target before connecting', () => {
    assert.fail(authorityError);
  });
} else {
  test('PERSIST-1 migration 10, immutable snapshots, CAS, concurrency, rollback, and restart guard hold on real PostgreSQL', async (t) => {
    const [{ Db, applicationNameOf }, { runMigrations }, { SCHEMA_VERSION }, { readStoreSnapshot, saveStoreSnapshot }, { inspectStoreAnchor }] = await Promise.all([
      import('../persistence/db.js'), import('../persistence/migrate.js'), import('../persistence/schema.js'),
      import('../persistence/store-anchors.js'), import('../persistence/store-guard.js'),
    ]);
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    let connected = false;
    try {
      connected = await db.connect();
      assert.equal(connected, true, 'the explicitly attested test database must be reachable');
      assert.equal(db.schema, SCHEMA, 'all application SQL is schema-scoped');
      const { rows: ownerRows } = await db.query("SELECT current_setting('application_name') AS name");
      assert.equal(ownerRows[0].name, applicationNameOf(SCHEMA), 'test sessions carry the generated schema owner');

      await t.test('migration 10 is recorded, creates both tables, and its foreign key is initially deferred', async () => {
        const migrated = await runMigrations(db);
        assert.equal(SCHEMA_VERSION, 10);
        assert.equal(migrated.schemaVersion, 10);
        const { rows: versions } = await db.query('SELECT version FROM serpent_schema_migrations ORDER BY version');
        assert.deepEqual(versions.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        for (const table of ['serpent_store_anchors', 'serpent_store_snapshots']) {
          const { rows } = await db.query('SELECT to_regclass($1) AS relation', [`${SCHEMA}.${table}`]);
          assert.ok(rows[0].relation, `${table} exists only inside the generated schema`);
        }
        const { rows: constraints } = await db.query(`SELECT condeferrable, condeferred
          FROM pg_constraint
          WHERE conrelid = 'serpent_store_snapshots'::regclass AND contype = 'f'`);
        assert.equal(constraints.length, 1);
        assert.deepEqual(constraints[0], { condeferrable: true, condeferred: true });

        const storeId = id('deferred');
        const relativePath = `persist1/${suffix}/deferred.json`;
        const payload = '{"deferred":true}';
        const metadata = {
          anchorVersion: 'store-anchor-1', storeId, relativePath, format: 'JSON', storeVersion: 'persist1-pg-1',
          recordCount: 1, byteCount: Buffer.byteLength(payload, 'utf8'), headDigest: sha256(payload), headTs: T0,
        };
        await db.tx(async (q) => {
          await q(`INSERT INTO serpent_store_snapshots
            (store_id, revision, payload, payload_digest, byte_count) VALUES ($1, 1, $2, $3, $4)`,
          [storeId, payload, metadata.headDigest, metadata.byteCount]);
          await q(`INSERT INTO serpent_store_anchors
            (store_id, revision, relative_path, metadata) VALUES ($1, 1, $2, $3::jsonb)`,
          [storeId, relativePath, JSON.stringify(metadata)]);
        });
        assert.equal((await readStoreSnapshot(db, storeId)).payload, payload, 'snapshot-first creation commits through the deferred foreign key');

        const orphanId = id('orphan');
        await rejectsCode(db.tx(async (q) => {
          await q(`INSERT INTO serpent_store_snapshots
            (store_id, revision, payload, payload_digest, byte_count) VALUES ($1, 1, $2, $3, $4)`,
          [orphanId, '{}', sha256('{}'), 2]);
        }), '23503');
        const { rows: orphanRows } = await db.query('SELECT count(*)::int AS count FROM serpent_store_snapshots WHERE store_id = $1', [orphanId]);
        assert.equal(orphanRows[0].count, 0, 'deferred constraint failure rolls the orphan back at commit');
      });

      await t.test('save/read CAS is exact; retries are idempotent and a conflicting stale retry leaves no row', async () => {
        const first = save();
        assert.equal((await saveStoreSnapshot(db, first)).status, 'CREATED');
        assert.equal((await saveStoreSnapshot(db, first)).status, 'EXISTING', 'same create retry collapses');
        const second = { ...first, payload: '{"v":2}', headTs: T0 + 1, expectedRevision: 1 };
        const updated = await saveStoreSnapshot(db, second);
        assert.equal(updated.status, 'UPDATED'); assert.equal(updated.anchor.revision, 2);
        assert.equal((await saveStoreSnapshot(db, second)).status, 'EXISTING', 'same preceding-update retry collapses');
        await rejectsCode(saveStoreSnapshot(db, { ...second, payload: '{"v":3}' }), 'REVISION_CONFLICT');
        const current = await readStoreSnapshot(db, first.storeId);
        assert.equal(current.anchor.revision, 2); assert.equal(current.payload, second.payload);
        const { rows } = await db.query('SELECT revision FROM serpent_store_snapshots WHERE store_id = $1 ORDER BY revision', [first.storeId]);
        assert.deepEqual(rows.map((row) => Number(row.revision)), [1, 2], 'conflicting retry adds no candidate row');
      });

      await t.test('JSONL retention keeps exact prior revisions and refuses truncation or prefix rewrite', async () => {
        const first = save({ storeId: id('journal'), relativePath: `persist1/${suffix}/journal.jsonl`, format: 'JSONL', storeVersion: 'journal-1', payload: '{"id":1}\n{"id":2}\n' });
        await saveStoreSnapshot(db, first);
        const appendedPayload = `${first.payload}{"id":3}\n`;
        await saveStoreSnapshot(db, { ...first, payload: appendedPayload, headTs: T0 + 1, expectedRevision: 1 });
        for (const payload of ['', '{"id":1}\n', '{"id":2}\n{"id":1}\n', '{"id":1}\n{"id":9}\n']) {
          await rejectsCode(saveStoreSnapshot(db, { ...first, payload, headTs: T0 + 2, expectedRevision: 2 }), 'JOURNAL_PREFIX_CONFLICT');
        }
        const { rows } = await db.query('SELECT revision, payload FROM serpent_store_snapshots WHERE store_id = $1 ORDER BY revision', [first.storeId]);
        assert.deepEqual(rows.map((row) => ({ revision: Number(row.revision), payload: row.payload })), [
          { revision: 1, payload: first.payload }, { revision: 2, payload: appendedPayload },
        ], 'history is retained by revision; no rejected write alters an acknowledged prefix');
      });

      await t.test('save waits on the exact per-store transaction advisory lock held by another pool', async () => {
        const peer = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
        let holder = null; let contender = null; let releaseLock = null;
        try {
          assert.equal(await peer.connect(), true);
          const input = save({ storeId: id('observed-lock'), relativePath: `persist1/${suffix}/observed-lock.json` });
          const lockKey = `store-anchor:${input.storeId}`;
          let signalHeld; let rejectHeld;
          const held = new Promise((resolve, reject) => { signalHeld = resolve; rejectHeld = reject; });
          const released = new Promise((resolve) => { releaseLock = resolve; });
          holder = db.tx(async (_q, { raw }) => {
            await raw('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
            signalHeld();
            await released;
          });
          holder.catch(rejectHeld);
          await held;
          contender = saveStoreSnapshot(peer, input);
          const waiting = await observeAdvisoryWait(db, applicationNameOf(SCHEMA));
          assert.ok(waiting.length >= 1, 'PostgreSQL reports the independent save blocked on an advisory lock');
          releaseLock();
          await holder; holder = null;
          const result = await contender; contender = null;
          assert.equal(result.status, 'CREATED', 'the blocked save proceeds only after the owning transaction releases the lock');
        } finally {
          releaseLock?.();
          await holder?.catch(() => {});
          await contender?.catch(() => {});
          await peer.end();
        }
      });

      await t.test('two independent pools serialize same-store CAS and same-path ownership', async () => {
        const peer = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
        try {
          assert.equal(await peer.connect(), true);
          const first = save({ storeId: id('race'), relativePath: `persist1/${suffix}/race.json` });
          const createResults = await Promise.all([saveStoreSnapshot(db, first), saveStoreSnapshot(peer, first)]);
          assert.deepEqual(createResults.map((result) => result.status).sort(), ['CREATED', 'EXISTING']);
          const competitors = await Promise.allSettled([
            saveStoreSnapshot(db, { ...first, payload: '{"winner":"a"}', headTs: T0 + 1, expectedRevision: 1 }),
            saveStoreSnapshot(peer, { ...first, payload: '{"winner":"b"}', headTs: T0 + 1, expectedRevision: 1 }),
          ]);
          assert.equal(competitors.filter((result) => result.status === 'fulfilled').length, 1);
          assert.equal(competitors.filter((result) => result.status === 'rejected' && result.reason?.code === 'REVISION_CONFLICT').length, 1);
          const { rows: raceRows } = await db.query('SELECT revision FROM serpent_store_snapshots WHERE store_id = $1 ORDER BY revision', [first.storeId]);
          assert.deepEqual(raceRows.map((row) => Number(row.revision)), [1, 2]);

          const sharedPath = `persist1/${suffix}/one-owner.json`;
          const owners = await Promise.allSettled([
            saveStoreSnapshot(db, save({ storeId: id('owner-a'), relativePath: sharedPath })),
            saveStoreSnapshot(peer, save({ storeId: id('owner-b'), relativePath: sharedPath })),
          ]);
          assert.equal(owners.filter((result) => result.status === 'fulfilled').length, 1);
          assert.equal(owners.filter((result) => result.status === 'rejected' && result.reason?.code === 'RELATIVE_PATH_CONFLICT').length, 1);
          const { rows: pathRows } = await db.query('SELECT store_id FROM serpent_store_anchors WHERE relative_path = $1', [sharedPath]);
          assert.equal(pathRows.length, 1, 'one durable store owns one relative path');
        } finally {
          await peer.end();
        }
      });

      await t.test('a thrown transaction leaves no candidate snapshot', async () => {
        const storeId = id('rollback');
        const marker = Object.assign(new Error('TEST_ROLLBACK_MARKER'), { code: 'TEST_ROLLBACK_MARKER' });
        await assert.rejects(db.tx(async (q) => {
          await q(`INSERT INTO serpent_store_snapshots
            (store_id, revision, payload, payload_digest, byte_count) VALUES ($1, 1, $2, $3, $4)`,
          [storeId, '{}', sha256('{}'), 2]);
          throw marker;
        }), (error) => error === marker);
        const { rows } = await db.query('SELECT count(*)::int AS count FROM serpent_store_snapshots WHERE store_id = $1', [storeId]);
        assert.equal(rows[0].count, 0);
      });

      await t.test('an independent client reads exact custody; missing and truncated local caches stay locked', async () => {
        const input = save({ storeId: id('restart'), relativePath: `restart/${suffix}/state.json`, payload: '{"safe":true}' });
        await saveStoreSnapshot(db, input);
        const restarted = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
        const dataRoot = mkdtempSync(path.join(tmpdir(), 'persist1-pg-guard-'));
        try {
          assert.equal(await restarted.connect(), true);
          const snapshot = await readStoreSnapshot(restarted, input.storeId);
          assert.equal(snapshot.payload, input.payload); assert.equal(snapshot.anchor.revision, 1);
          const local = path.join(dataRoot, ...snapshot.anchor.relativePath.split('/'));
          mkdirSync(path.dirname(local), { recursive: true }); writeFileSync(local, snapshot.payload);
          assert.deepEqual(await inspectStoreAnchor({ dataRoot, anchor: snapshot.anchor }), {
            storeId: input.storeId, revision: 1, status: 'HEALTHY', reason: 'EXACT_DURABLE_SNAPSHOT_MATCH', permissionLock: false,
          });
          unlinkSync(local);
          assert.equal((await inspectStoreAnchor({ dataRoot, anchor: snapshot.anchor })).status, 'WIPED');
          writeFileSync(local, snapshot.payload.slice(0, -1));
          const truncated = await inspectStoreAnchor({ dataRoot, anchor: snapshot.anchor });
          assert.equal(truncated.status, 'WIPED'); assert.equal(truncated.permissionLock, true);
        } finally {
          await restarted.end();
          rmSync(dataRoot, { recursive: true, force: true });
        }
      });
    } finally {
      try {
        if (connected) {
          assert.equal(db.schema, SCHEMA);
          await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        }
      } finally {
        await db.end();
      }
    }
  });
}
