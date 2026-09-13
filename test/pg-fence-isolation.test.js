// PARALLEL TEST ISOLATION — the regression for the full-suite flake family (social-4f-closeout CLOSE-P3, social-4f-collector
// 4FCOL-M, social-5b-durable T01): node --test runs files in parallel processes against ONE database; a simulated session
// loss that terminated every advisory-lock session in the database killed other files' collectors mid-tick. The law now:
// every Db session names its schema-scoped owner (application_name), and the shared kill helper terminates ONLY its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db, applicationNameOf } from '../persistence/db.js';
import { ownAdvisoryHolders, killOwnAdvisoryBackends, OWN_ADVISORY_HOLDERS_SQL } from './helpers/pg-fence.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL; const skip = !TEST_URL;
const schemaOf = (p) => `${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

test('ISO-1. application_name law: a schema-scoped Db is serpent-test:<schema>, an unscoped Db is serpent; the helper refuses an unscoped Db (it could only terminate production-shaped sessions)', async () => {
  assert.equal(applicationNameOf('abc'), 'serpent-test:abc'); assert.equal(applicationNameOf(null), 'serpent'); assert.equal(applicationNameOf(undefined), 'serpent');
  await assert.rejects(ownAdvisoryHolders({ schema: null, query: async () => ({ rows: [] }) }), /schema-scoped test Db is required/);
  assert.match(OWN_ADVISORY_HOLDERS_SQL, /application_name = \$1/); assert.match(OWN_ADVISORY_HOLDERS_SQL, /pid <> pg_backend_pid\(\)/);
});

test('ISO-2 (real DB). two test families hold advisory locks on the same database at once: killing family A terminates A\'s holder only; family B\'s lock is still held afterwards and B keeps working (the exact cross-file interference that made untouched suites fail in the full suite)', { skip }, async () => {
  const A = schemaOf('isoa'); const B = schemaOf('isob');
  const dbA = new Db({ url: TEST_URL, schema: A }); const adminA = new Db({ url: TEST_URL, schema: A }); const dbB = new Db({ url: TEST_URL, schema: B });
  try {
    assert.equal(await dbA.connect(), true); assert.equal(await adminA.connect(), true); assert.equal(await dbB.connect(), true);
    const { rows: nameRows } = await dbA.query('SELECT current_setting(\'application_name\') AS n'); assert.equal(nameRows[0].n, applicationNameOf(A), 'the session carries its owner name');
    const lockA = await dbA.acquireSessionLock(`iso:${A}:writer`); const lockB = await dbB.acquireSessionLock(`iso:${B}:writer`); assert.ok(lockA && lockB, 'both families hold a lock');
    const { rows: seenByA } = await ownAdvisoryHolders(adminA); assert.equal(seenByA.length, 1, 'family A sees exactly ONE holder: its own');
    const killed = await killOwnAdvisoryBackends(adminA); assert.equal(killed, 1);
    // A's holder is gone; B's is untouched and still granted in pg_locks
    const { rows: bLocks } = await dbB.query('SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = \'advisory\' AND l.granted AND a.application_name = $1', [applicationNameOf(B)]); assert.equal(bLocks[0].n, 1, 'B still holds its advisory lock');
    assert.equal(lockB.held(), true, 'B\'s handle is still held'); const { rows: bWork } = await dbB.query('SELECT 1 AS ok'); assert.equal(bWork[0].ok, 1, 'B keeps working');
    await lockB.release();
  } finally { for (const d of [dbA, adminA, dbB]) { try { await d.query(`DROP SCHEMA IF EXISTS ${d.schema} CASCADE`); } catch { /* schema may not exist */ } await d.end(); } }
});
