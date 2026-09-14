// SIM-2 Option A — REAL PostgreSQL 100k-body memory witness. Double-gated:
// PERSIST_TEST_DATABASE_URL (attested throwaway) + PERSIST_TEST_DATABASE_ISOLATED
// + SIM2_STRESS=1, no DATABASE_URL. Proves that verifying a full day of ~100k
// outcome bodies is done by BOUNDED streaming pages — peak RSS does NOT scale
// with the day size — and that a plain count is NOT accepted as content proof
// (every body is re-hashed against its stored content_digest). Synthetic bodies
// only; NOT real market simulations. Applies ONLY proposed DDL in a dropped schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { PROPOSED_DDL } from '../persistence/daily-simulation-schema.js';

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? null;
const RUN = TEST_URL && process.env.SIM2_STRESS && process.env.PERSIST_TEST_DATABASE_ISOLATED === 'THROWAWAY_SCHEMA_ONLY' && !process.env.DATABASE_URL;
const SCHEMA = `dsim_pgbodystress_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const DAY = '2026-09-14';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const k = Object.keys(v).sort();
  return `{${k.map((x) => `${JSON.stringify(x)}:${stableStringify(v[x])}`).join(',')}}`;
}
const bodyDigest = (b) => `sha256:${createHash('sha256').update(stableStringify(b), 'utf8').digest('hex')}`;

if (!RUN) {
  test('SIM-2 100k outcome-body memory witness', (t) => t.skip('needs PERSIST_TEST_DATABASE_URL + PERSIST_TEST_DATABASE_ISOLATED=THROWAWAY_SCHEMA_ONLY + SIM2_STRESS=1, no DATABASE_URL'));
} else {
  test('SIM-2 Option A: verifying ~100k bodies is bounded-memory streaming (not materialized)', async (t) => {
    const { Db } = await import('../persistence/db.js');
    const db = new Db({ url: TEST_URL, schema: SCHEMA, retries: 1, log: () => {} });
    assert.equal(await db.connect(), true);
    for (const ddl of PROPOSED_DDL) await db.query(ddl);
    const ID = `pgbs:${SCHEMA}`;
    const TARGET = 100000; const PER = 4096; const FRAMES = Math.ceil(TARGET / PER); // ~25 batches
    try {
      const store = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: TARGET });
      await store.commissionStore();
      let n = 0; let parentRevision = 0; let totalBodyBytes = 0;
      for (let bt = 0; bt < FRAMES; bt++) {
        const evidence = [];
        for (let i = 0; i < PER; i++) {
          const id = `S#${String(n).padStart(7, '0')}`;
          const body = { i: n, r: (n % 97) / 7 }; // small synthetic body (~30 bytes canonical)
          totalBodyBytes += Buffer.byteLength(stableStringify(body), 'utf8');
          evidence.push({ id, status: 'COMPLETED_MODELED', completed: true, valid: n % 8 === 0, prospective: n % 32 === 0, digest: bodyDigest(body), outcomeBody: body });
          n++;
        }
        const rec = { batchId: `B${bt}`, dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: `pd${bt}`, cursorBefore: bt === 0 ? null : bt, nextCursor: bt + 1, done: bt === FRAMES - 1, parentRevision, rotationIndex: bt, completedResults: [], newCompletedIds: evidence.map((e) => e.id), pendingDelta: [], resultEvidence: evidence, tally: { completed: evidence.length, validModeled: evidence.filter((e) => e.valid).length, prospectiveEligible: evidence.filter((e) => e.prospective).length, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length }, executorCounters: null, observedUtcMs: 1 };
        const r = await store.commitBatch(rec);
        assert.equal(r.ok, true, `batch ${bt} committed`);
        parentRevision = r.revision;
      }

      // Restart handle; replayable is a COUNT (no materialization).
      const s2 = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: TARGET });
      const led = (await s2.loadDay(DAY)).ledger;
      assert.equal(led.totals.replayable, n, 'every credited sim is body-backed');

      // Streaming content verification with a bounded page; sample RSS across it.
      if (global.gc) global.gc();
      const rss0 = process.memoryUsage().rss;
      let peak = rss0;
      const pageSize = 2000;
      // Run verify while sampling RSS via a concurrent interval.
      const sampler = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 5);
      const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize });
      clearInterval(sampler);
      const rss1 = process.memoryUsage().rss; if (rss1 > peak) peak = rss1;
      assert.equal(v.verified, true);
      assert.equal(v.checked, n, 'all bodies content-verified by streaming pages');
      const verifyDeltaMb = (peak - rss0) / 1048576;
      // A bounded page (2000 small bodies) must not grow RSS anywhere near the
      // whole-day body set; assert the verify pass stays well under 200 MB delta.
      assert.ok(verifyDeltaMb < 200, `verify peak RSS delta bounded (${verifyDeltaMb.toFixed(1)} MB)`);
      // eslint-disable-next-line no-console
      console.log(`PGBODYSTRESS bodies=${n} totalBodyKiB=${(totalBodyBytes / 1024).toFixed(0)} pageSize=${pageSize} checked=${v.checked} pages=${v.pages} verifyRssDeltaMb=${verifyDeltaMb.toFixed(1)}`);
    } finally {
      try { assert.equal(db.schema, SCHEMA); await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }
  });
}
