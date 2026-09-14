// SIM-2 store — bounded multi-row INSERT batching (perf) unit test. A counting
// fake Db proves the store writes result evidence and the completed index in a
// few bounded statements instead of one round-trip per row, preserves exact
// canonical evidence + ordinals, and rolls the WHOLE batch back on a mid-batch
// failure (no partial acknowledgement). In-memory timing is not the benchmark
// (see the real-PG stress); this asserts batching SHAPE and integrity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX, MAX_INSERT_ROWS_PER_STATEMENT, MAX_INSERT_PARAMS } from '../persistence/daily-simulation-schema.js';

function makeCountingDb({ failOnResultStatement = null } = {}) {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [] };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  const counts = { resultStatements: 0, completedStatements: 0, singleResultRow: 0, maxParamsSeen: 0 };
  const dk = (a, b) => `${a}|${b}`; const bk = (a, b, c) => `${a}|${b}|${c}`;
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) {
      counts.resultStatements += 1; counts.maxParamsSeen = Math.max(counts.maxParamsSeen, p.length);
      const n = p.length / 10;
      if (failOnResultStatement && counts.resultStatements === failOnResultStatement) throw new Error('SIMULATED failure mid-batch (statement ' + failOnResultStatement + ')');
      for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ batch_id: p[b + 2], row_ordinal: p[b + 3], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8] }); }
      return { rows: [], rowCount: n };
    }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { counts.completedStatements += 1; const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; t.completed.set(bk(p[b], p[b + 1], p[b + 2]), 1); } return { rows: [], rowCount: n }; }
    switch (B2T.get(body)) {
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0], policy_version: p[1], store_version: p[2], commissioned_at: p[3] }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_GET: { const r = t.day.get(dk(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: 0, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { t.day.set(dk(p[0], p[1]), { revision: 0, target: p[2], shortfall: null }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_UPDATE_CAS: { const r = t.day.get(dk(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; return { rowCount: 1, rows: [] }; } return { rowCount: 0, rows: [] }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dk(p[0], p[1])); if (r) r.shortfall = JSON.parse(p[2]); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bk(p[0], p[1], p[2])); return { rows: r ? [{ batch_id: r.batch_id, payload_digest: r.payload_digest, resulting_revision: r.resulting_revision }] : [] }; }
      case SQL.BATCH_INSERT: { t.batch.set(bk(p[0], p[1], p[2]), { batch_id: p[2], payload_digest: p[5], resulting_revision: p[7] }); return { rowCount: 1, rows: [] }; }
      case SQL.RESULT_INSERT: { counts.singleResultRow += 1; t.result.push({ sim_id: p[4] }); return { rowCount: 1, rows: [] }; }
      case SQL.COMPLETED_HAS: return { rows: t.completed.has(bk(p[0], p[1], p[2])) ? [{ one: 1 }] : [] };
      case SQL.COMPLETED_INSERT: { t.completed.set(bk(p[0], p[1], p[2]), 1); return { rowCount: 1, rows: [] }; }
      case SQL.COMPLETED_LIST: { const out = []; for (const k of t.completed.keys()) { const [id, d, s] = k.split('|'); if (id === p[0] && d === p[1]) out.push(s); } out.sort(); return { rows: out.map((sim_id) => ({ sim_id })) }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { const e = g.get(r.status) || { status: r.status, n: 0, completed: 0, valid_modeled: 0, prospective_eligible: 0 }; e.n++; g.set(r.status, e); } return { rows: [...g.values()] }; }
      case SQL.PENDING_LIST: return { rows: [] };
      case SQL.PENDING_UPSERT: return { rowCount: 1, rows: [] };
      case SQL.PENDING_DELETE: return { rowCount: 1, rows: [] };
      case SQL.BATCH_LIST_DAY: { const out = []; for (const v of t.batch.values()) out.push({ batch_id: v.batch_id, job_id: 'J', next_cursor: null, done: true, resulting_revision: v.resulting_revision }); return { rows: out }; }
      default: throw new Error('countingDb: ' + body);
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map(t.batch), completed: new Map(t.completed), pending: new Map(t.pending), result: t.result.slice() });
  const rest = (s) => { Object.assign(t, s); };
  return { _t: t, counts, async query(b, p) { return run(b, p); }, async tx(fn) { const s = snap(); try { return await fn((b, p) => Promise.resolve(run(b, p)), {}); } catch (e) { rest(s); throw e; } } };
}

function bigReceipt(nRows) {
  const evidence = Array.from({ length: nRows }, (_, i) => ({ id: `R#${i}`, status: 'COMPLETED_MODELED', completed: true, valid: i % 2 === 0, prospective: i % 4 === 0, digest: `d${i}` }));
  const newCompletedIds = evidence.map((e) => e.id);
  return {
    port: 'daily-sim-scheduler-2', policyVersion: 'sim2-policy-1', batchId: 'BULK', dayKey: '2026-09-14', jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd',
    cursorBefore: null, nextCursor: null, done: true, parentRevision: 0, expectedRevision: 1,
    completedResults: [], newCompletedIds, pendingDelta: [], resultEvidence: evidence, byStatus: {},
    tally: { completed: nRows, validModeled: evidence.filter((e) => e.valid).length, prospectiveEligible: evidence.filter((e) => e.prospective).length, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: nRows },
    executorCounters: null, executorLaws: null, observedUtcMs: 1,
  };
}

test('perf: 1000 result rows write in bounded batches, not per-row round-trips', async () => {
  const db = makeCountingDb();
  const store = createDailySimulationStore({ db, storeIdentity: 'perf:1', dailyTarget: 100000 });
  await store.commissionStore();
  const res = await store.commitBatch(bigReceipt(1000));
  assert.equal(res.ok, true);
  assert.equal(db.counts.singleResultRow, 0, 'no single-row RESULT_INSERT used');
  const expectedStatements = Math.ceil(1000 / MAX_INSERT_ROWS_PER_STATEMENT);
  assert.equal(db.counts.resultStatements, expectedStatements, `bounded batches: ${expectedStatements} statements for 1000 rows`);
  assert.ok(db.counts.maxParamsSeen <= MAX_INSERT_PARAMS, 'param bound respected');
  assert.equal(db._t.result.length, 1000, 'all rows persisted');
  // ordinals preserved and contiguous
  const ords = db._t.result.map((r) => r.row_ordinal).sort((a, b) => a - b);
  assert.equal(ords[0], 0); assert.equal(ords[999], 999);
});

test('perf: canonical evidence preserved (status/valid/prospective per row)', async () => {
  const db = makeCountingDb();
  const store = createDailySimulationStore({ db, storeIdentity: 'perf:2', dailyTarget: 100000 });
  await store.commissionStore();
  await store.commitBatch(bigReceipt(10));
  const r5 = db._t.result.find((r) => r.sim_id === 'R#5');
  assert.equal(r5.status, 'COMPLETED_MODELED'); assert.equal(r5.completed, true); assert.equal(r5.valid_modeled, false); assert.equal(r5.prospective_eligible, false);
  const r4 = db._t.result.find((r) => r.sim_id === 'R#4');
  assert.equal(r4.valid_modeled, true); assert.equal(r4.prospective_eligible, true);
});

test('perf: a failure mid-batch rolls back the WHOLE transaction (no partial ack)', async () => {
  const db = makeCountingDb({ failOnResultStatement: 2 }); // fail on the 2nd bulk statement
  const store = createDailySimulationStore({ db, storeIdentity: 'perf:3', dailyTarget: 100000 });
  await store.commissionStore();
  await assert.rejects(store.commitBatch(bigReceipt(1000)));
  assert.equal(db._t.result.length, 0, 'no evidence rows survive the rollback');
  assert.equal(db._t.completed.size, 0);
  assert.equal(db._t.batch.size, 0, 'no batch row acknowledged');
  assert.equal(db._t.day.get('perf:3|2026-09-14'), undefined, 'day revision not advanced');
});
