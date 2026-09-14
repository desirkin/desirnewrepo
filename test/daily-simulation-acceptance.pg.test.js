// SIM-2 acceptance repairs — REAL PostgreSQL coverage. Gated identically to the
// other *.pg tests: runs only with PERSIST_TEST_DATABASE_URL (attested
// throwaway) + PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY and no
// DATABASE_URL. Applies ONLY the proposed DDL in a generated schema it drops.
// These exercise the ACTUAL SQL (esp. the DISTINCT-ON crediting aggregate that
// fixes within-batch duplicate inflation) rather than a fake's emulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { PROPOSED_DDL, DSIM_STORE_VERSION } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const RUN = TEST_URL && process.env.PERSIST_TEST_DATABASE_ISOLATED === 'THROWAWAY_SCHEMA_ONLY' && !process.env.DATABASE_URL;
const SCHEMA = `dsim_pgacc_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const DAY = '2026-09-14';

const row = (id, o = {}) => ({ id, status: 'COMPLETED_MODELED', completed: true, valid: false, prospective: false, digest: 'd:' + id, ...o });
function receipt(evidence, { batchId = 'B1', parentRevision = 0 } = {}) {
  const seen = new Map(); let completed = 0, valid = 0, prospective = 0;
  for (const e of evidence) { if (e.completed && !seen.has(e.id)) { seen.set(e.id, e); completed++; if (e.valid) valid++; if (e.prospective) prospective++; } }
  return { batchId, dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false, parentRevision, rotationIndex: 1, completedResults: [], newCompletedIds: [...seen.keys()], pendingDelta: [], resultEvidence: evidence, tally: { completed, validModeled: valid, prospectiveEligible: prospective, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length }, executorCounters: null, observedUtcMs: 1 };
}

if (!RUN) {
  test('SIM-2 acceptance on real PG', (t) => t.skip('needs PERSIST_TEST_DATABASE_URL + PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY, no DATABASE_URL'));
} else {
  test('SIM-2 acceptance repairs on real PostgreSQL (proposed DDL in a dropped schema)', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    assert.equal(await db.connect(), true);
    for (const ddl of PROPOSED_DDL) await db.query(ddl);
    const ID = `pgacc:${SCHEMA}`;
    try {
      await t.test('R4a: within-batch duplicate sim_id credited once via DISTINCT-ON aggregate', async () => {
        const store = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: 100000 });
        await store.commissionStore();
        const dup = row('S#0', { valid: true, prospective: true });
        const r = await store.commitBatch(receipt([dup, { ...dup }])); // two identical result rows, same sim_id
        assert.equal(r.ok, true);
        // Two raw evidence rows retained, but credited once.
        const { rows: raw } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity=$1 AND sim_id=$2', [ID, 'S#0']);
        assert.equal(raw[0].n, 2, 'raw evidence immutable — both rows retained');
        const led = (await store.loadDay(DAY)).ledger;
        assert.equal(led.totals.completed, 1);
        assert.equal(led.totals.validModeled, 1, 'valid credited once on real-PG aggregate, not inflated to 2');
        assert.equal(led.totals.prospectiveEligible, 1);
      });

      await t.test('R4b: conflicting duplicate sim_id rejected, nothing written', async () => {
        const id2 = `${ID}:b`; const store = createDailySimulationStore({ db, storeIdentity: id2 });
        await store.commissionStore();
        const r = await store.commitBatch(receipt([row('S#0', { valid: true }), row('S#0', { valid: false, digest: 'X' })]));
        assert.equal(r.ok, false); assert.equal(r.reason, 'DUPLICATE_SIM_CONFLICT');
        const { rows } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result WHERE identity=$1', [id2]);
        assert.equal(rows[0].n, 0);
      });

      await t.test('R1: write path refuses a policy/store-identity mismatch', async () => {
        const id3 = `${ID}:c`;
        await createDailySimulationStore({ db, storeIdentity: id3 }).commissionStore();
        const wrong = createDailySimulationStore({ db, storeIdentity: id3, policyVersion: 'other-policy' });
        const r = await wrong.commitBatch(receipt([row('S#0', { valid: true })]));
        assert.equal(r.ok, false); assert.equal(r.reason, 'STORE_IDENTITY_MISMATCH');
      });

      await t.test('R3b: malformed durable rotation_index loads as LOST', async () => {
        const id4 = `${ID}:d`; const store = createDailySimulationStore({ db, storeIdentity: id4 });
        await store.commissionStore();
        await store.commitBatch(receipt([row('S#0')]));
        await db.query('UPDATE serpent_dsim_day SET rotation_index = -7 WHERE identity=$1 AND day_key=$2', [id4, DAY]);
        assert.equal((await store.loadDay(DAY)).status, 'LOST');
      });

      await t.test('D1: evidence_digest persisted as SHA-256 scheme', async () => {
        const id5 = `${ID}:e`; const store = createDailySimulationStore({ db, storeIdentity: id5 });
        await store.commissionStore();
        await store.commitBatch(receipt([row('S#0', { valid: true })]));
        const { rows } = await db.query('SELECT evidence_digest FROM serpent_dsim_batch WHERE identity=$1 AND batch_id=$2', [id5, 'B1']);
        assert.ok(rows[0].evidence_digest.startsWith('sha256:'), rows[0].evidence_digest);
        // store_version row is recorded for identity binding
        const { rows: srow } = await db.query('SELECT store_version FROM serpent_dsim_store WHERE identity=$1', [id5]);
        assert.equal(srow[0].store_version, DSIM_STORE_VERSION);
      });
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
