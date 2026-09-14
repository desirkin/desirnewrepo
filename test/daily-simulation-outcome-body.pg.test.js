// SIM-2 Option A outcome-body custody — REAL PostgreSQL. Gated like the other
// *.pg tests. Applies ONLY the proposed DDL in a generated schema it drops.
// Proves body write/readback/restart, digest binding, and the per-day byte
// ceiling on the ACTUAL jsonb table + queries (not a fake).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { PROPOSED_DDL } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const RUN = TEST_URL && process.env.PERSIST_TEST_DATABASE_ISOLATED === 'THROWAWAY_SCHEMA_ONLY' && !process.env.DATABASE_URL;
const SCHEMA = `dsim_pgbody_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const DAY = '2026-09-14';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const k = Object.keys(v).sort();
  return `{${k.map((x) => `${JSON.stringify(x)}:${stableStringify(v[x])}`).join(',')}}`;
}
const bodyDigest = (b) => `sha256:${createHash('sha256').update(stableStringify(b), 'utf8').digest('hex')}`;
const rowB = (id, body, o = {}) => ({ id, status: 'COMPLETED_MODELED', completed: true, valid: false, prospective: false, digest: bodyDigest(body), outcomeBody: body, ...o });
function receipt(evidence, { batchId = 'B1', parentRevision = 0 } = {}) {
  const seen = new Map(); let completed = 0, valid = 0, prospective = 0;
  for (const e of evidence) { if (e.completed && !seen.has(e.id)) { seen.set(e.id, e); completed++; if (e.valid) valid++; if (e.prospective) prospective++; } }
  return { batchId, dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false, parentRevision, rotationIndex: 1, completedResults: [], newCompletedIds: [...seen.keys()], pendingDelta: [], resultEvidence: evidence, tally: { completed, validModeled: valid, prospectiveEligible: prospective, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length }, executorCounters: null, observedUtcMs: 1 };
}

if (!RUN) {
  test('SIM-2 outcome-body on real PG', (t) => t.skip('needs PERSIST_TEST_DATABASE_URL + PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY, no DATABASE_URL'));
} else {
  test('SIM-2 Option A outcome-body custody on real PostgreSQL', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    assert.equal(await db.connect(), true);
    for (const ddl of PROPOSED_DDL) await db.query(ddl);
    const ID = `pgbody:${SCHEMA}`;
    try {
      await t.test('body persists, reads back digest-verified, survives restart; replayable tracked', async () => {
        const s1 = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: 100000 });
        await s1.commissionStore();
        const bodies = { 'S#0': { path: [100, 101, 99], pnl: -1, meta: { horizon: 5 } }, 'S#1': { path: [50, 55], pnl: 5 } };
        const r = await s1.commitBatch(receipt([rowB('S#0', bodies['S#0'], { valid: true }), rowB('S#1', bodies['S#1'])]));
        assert.equal(r.ok, true);
        // Restart: fresh store handle over the same durable Db.
        const s2 = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: 100000 });
        for (const id of ['S#0', 'S#1']) {
          const got = await s2.readOutcomeBody({ dayKey: DAY, simId: id });
          assert.equal(got.found, true); assert.equal(got.verified, true);
          assert.deepEqual(got.body, bodies[id], `exact body round-trips for ${id}`);
        }
        const led = (await s2.loadDay(DAY)).ledger;
        assert.equal(led.totals.completed, 2);
        assert.equal(led.totals.replayable, 2, 'both credited sims are body-backed / replayable (COUNT, not materialized)');
        // Content verification is a separate bounded/streaming pass.
        const v = await s2.verifyOutcomeBodies({ dayKey: DAY, pageSize: 1 });
        assert.equal(v.verified, true); assert.equal(v.checked, 2);
      });

      await t.test('metadata-only credit is not replayable; per-day ceiling fails closed', async () => {
        const id2 = `${ID}:b`;
        const store = createDailySimulationStore({ db, storeIdentity: id2, dailyTarget: 100000, maxDayBodyBytes: 64 });
        await store.commissionStore();
        // One body-less completed row (metadata only) + one small body that fits.
        const small = { v: 1 };
        const meta = { id: 'M#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: 'plain-meta' };
        const ok = await store.commitBatch(receipt([meta, rowB('S#9', small)]));
        assert.equal(ok.ok, true);
        const led = (await store.loadDay(DAY)).ledger;
        assert.equal(led.totals.completed, 2, 'both counted for accounting');
        assert.equal(led.totals.replayable, 1, 'only the body-backed sim is replayable');
        // A second batch whose body would exceed the tiny per-day ceiling is refused.
        const big = { blob: 'x'.repeat(200) };
        const refused = await store.commitBatch(receipt([rowB('S#10', big)], { batchId: 'B2', parentRevision: 1 }));
        assert.equal(refused.ok, false); assert.equal(refused.reason, 'OUTCOME_BODY_DAY_BYTES_LIMIT');
        const { rows } = await db.query('SELECT count(*)::int AS n FROM serpent_dsim_result_body WHERE identity=$1 AND sim_id=$2', [id2, 'S#10']);
        assert.equal(rows[0].n, 0, 'nothing written on ceiling refusal');
      });

      await t.test('a body whose stored jsonb no longer matches its content_digest reads as corruption', async () => {
        const id3 = `${ID}:c`;
        const store = createDailySimulationStore({ db, storeIdentity: id3, dailyTarget: 100000 });
        await store.commissionStore();
        await store.commitBatch(receipt([rowB('S#0', { a: 1 })]));
        // Tamper the durable body out from under its digest.
        await db.query(`UPDATE serpent_dsim_result_body SET body = '{"a":999}'::jsonb WHERE identity=$1 AND sim_id=$2`, [id3, 'S#0']);
        await assert.rejects(() => store.readOutcomeBody({ dayKey: DAY, simId: 'S#0' }), /content_digest/);
      });

      await t.test('corrupted INTERIOR body is caught by the streaming paged verify (restart witness)', async () => {
        const id4 = `${ID}:d`;
        const store = createDailySimulationStore({ db, storeIdentity: id4, dailyTarget: 100000 });
        await store.commissionStore();
        // 50 bodies; sim ids zero-padded so ordering is deterministic.
        const N = 50; const evidence = [];
        for (let i = 0; i < N; i++) { const body = { i, v: `val-${i}` }; evidence.push(rowB(`S#${String(i).padStart(3, '0')}`, body)); }
        assert.equal((await store.commitBatch(receipt(evidence))).ok, true);
        const target = 'S#025';
        await db.query(`UPDATE serpent_dsim_result_body SET body = '{"i":-1,"v":"tampered"}'::jsonb WHERE identity=$1 AND sim_id=$2`, [id4, target]);
        // Streaming verify in small pages holds only one page in memory yet still
        // detects the interior tamper at the right sim.
        const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 7 });
        assert.equal(v.verified, false);
        assert.equal(v.corruptSim, target);
      });
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
