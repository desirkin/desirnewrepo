// SIM-2 Phase-15 — RED behavioral tests for the MISSING bounded outcome-body
// custody path. These define the contract for persisting an actual, replayable
// outcome body per credited simulation (the gap documented in
// docs/SIM2-EVIDENCE-CONTRACT.md). They are RED BY DESIGN: the current store
// (persistence/daily-simulation-store.js) persists metadata only, so it exposes
// no readOutcomeBody(), enforces no body byte quotas, verifies no body/digest
// binding, and counts no "replayable" total. Every test below therefore fails
// against the current source. Do NOT change schema/runtime to make them green
// until root approves the specific contract; they encode the target so the
// eventual GREEN slice has an executable specification and a red→green record.
//
// Naming: file is *.red.test.js so it is obvious these are expected-failing
// contract tests, not part of the passing regression suite. Run explicitly:
//   node --test test/daily-simulation-outcome-body.red.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX, RESULT_BODY_INSERT_BULK_PREFIX } from '../persistence/daily-simulation-schema.js';

// Canonical content digest the executor binds to a body. The contract requires
// content_digest === sha256 over the store's canonical stableStringify bytes
// (key-sorted), so the store can verify the body it stores is the one named.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
const bodyDigest = (body) => `sha256:${createHash('sha256').update(stableStringify(body), 'utf8').digest('hex')}`;

// Minimal transactional fake Db. It models the CURRENT statements plus a
// forward-compatible serpent_dsim_result_payload table so that, once the store
// issues the proposed payload SQL, these same tests can go green unchanged.
// Unknown statements return empty (they are not exercised by the current store).
function makeFakeDb() {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [], jobsched: new Map(), payload: new Map() };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  const dk = (a, b) => `${a}|${b}`; const bk = (a, b, c) => `${a}|${b}|${c}`;
  // binding helpers: crediting completion's batch for a sim, and the credited
  // (min row_ordinal) result row's digest for (sim, batch).
  const bodyCompletedBatch = (id, d, sim) => { const c = t.completed.get(bk(id, d, sim)); return c ? c.batch_id : null; };
  const bodyResultDigest = (id, d, sim, batch) => { const rr = t.result.filter((x) => x.identity === id && x.day_key === d && x.sim_id === sim && x.batch_id === batch && x.completed).sort((a, b) => a.row_ordinal - b.row_ordinal)[0]; return rr ? rr.digest : null; };
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) { const n = p.length / 10; for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ identity: p[b], day_key: p[b + 1], batch_id: p[b + 2], row_ordinal: p[b + 3], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8], digest: p[b + 9] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; t.completed.set(bk(p[b], p[b + 1], p[b + 2]), { batch_id: p[b + 3] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(RESULT_BODY_INSERT_BULK_PREFIX)) { if (t._failBodyInsert) throw new Error('SIMULATED body-insert failure'); const n = p.length / 7; for (let i = 0; i < n; i++) { const b = i * 7; t.payload.set(bk(p[b], p[b + 1], p[b + 2]), { batch_id: p[b + 3], content_digest: p[b + 4], body_bytes: p[b + 5], body: JSON.parse(p[b + 6]) }); } return { rows: [], rowCount: n }; }
    switch (B2T.get(body)) {
      case SQL.RESULT_BODY_GET: { const r = t.payload.get(bk(p[0], p[1], p[2])); if (!r) return { rows: [] }; return { rows: [{ content_digest: r.content_digest, body_bytes: r.body_bytes, body: r.body, batch_id: r.batch_id, completed_batch: bodyCompletedBatch(p[0], p[1], p[2]), result_digest: bodyResultDigest(p[0], p[1], p[2], r.batch_id) }] }; }
      case SQL.RESULT_BODY_COUNT: { let n = 0; for (const k of t.payload.keys()) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) n++; } return { rows: [{ n }] }; }
      case SQL.RESULT_BODY_ORPHAN_COUNT: { let n = 0; for (const [k, v] of t.payload) { const [id, d, sim] = k.split('|'); if (id !== p[0] || d !== p[1]) continue; const cb = bodyCompletedBatch(id, d, sim); const rd = bodyResultDigest(id, d, sim, v.batch_id); if (!(cb === v.batch_id && rd === v.content_digest)) n++; } return { rows: [{ n }] }; }
      case SQL.RESULT_BODY_PAGE: { const out = []; for (const [k, v] of t.payload) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1] && sim > p[2]) out.push({ sim_id: sim, content_digest: v.content_digest, body_bytes: v.body_bytes, body: v.body, batch_id: v.batch_id, completed_batch: bodyCompletedBatch(id, d, sim), result_digest: bodyResultDigest(id, d, sim, v.batch_id) }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out.slice(0, p[3]) }; }
      case SQL.RESULT_BODY_DAY_BYTES: { let bytes = 0; for (const [k, v] of t.payload) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) bytes += v.body_bytes; } return { rows: [{ bytes }] }; }
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0], policy_version: p[1], store_version: p[2], commissioned_at: p[3] }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_GET: { const r = t.day.get(dk(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: r.rotation_index || 0, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { t.day.set(dk(p[0], p[1]), { revision: 0, target: p[2], rotation_index: 0, shortfall: null }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_UPDATE_CAS: { const r = t.day.get(dk(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; r.rotation_index = p[4]; return { rowCount: 1, rows: [] }; } return { rowCount: 0, rows: [] }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dk(p[0], p[1])); if (r) r.shortfall = JSON.parse(p[2]); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bk(p[0], p[1], p[2])); return { rows: r ? [r] : [] }; }
      case SQL.BATCH_INSERT: { t.batch.set(bk(p[0], p[1], p[2]), { batch_id: p[2], payload_digest: p[5], resulting_revision: p[7], evidence_digest: p[14] }); return { rowCount: 1, rows: [] }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1]) continue; const e = g.get(r.status) || { status: r.status, n: 0, completed: 0 }; e.n++; e.completed += r.completed ? 1 : 0; g.set(r.status, e); } return { rows: [...g.values()] }; }
      case SQL.CREDITED_AGGREGATE: { let valid = 0, prospective = 0; for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1] || !r.completed) continue; const c = t.completed.get(bk(p[0], p[1], r.sim_id)); if (c && c.batch_id === r.batch_id) { valid += r.valid_modeled ? 1 : 0; prospective += r.prospective_eligible ? 1 : 0; } } return { rows: [{ valid, prospective }] }; }
      case SQL.EVIDENCE_DISTINCT_COMPLETED: { const s = new Set(); for (const r of t.result) { if (r.identity === p[0] && r.day_key === p[1] && r.completed) s.add(r.sim_id); } return { rows: [{ n: s.size }] }; }
      case SQL.COMPLETED_HAS: return { rows: t.completed.has(bk(p[0], p[1], p[2])) ? [{ one: 1 }] : [] };
      case SQL.COMPLETED_LIST: { const out = []; for (const k of t.completed.keys()) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push(sim); } out.sort(); return { rows: out.slice(0, p[2] ?? out.length).map((sim_id) => ({ sim_id })) }; }
      case SQL.PENDING_LIST: return { rows: [] };
      case SQL.BATCH_LIST_DAY: { const out = []; for (const v of t.batch.values()) out.push(v); return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.JOBSCHED_LIST: return { rows: [] };
      default: return { rows: [], rowCount: 0 }; // forward-compatible: unknown/payload SQL no-ops for now
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map(t.batch), completed: new Map(t.completed), pending: new Map(t.pending), result: t.result.slice(), jobsched: new Map(t.jobsched), payload: new Map(t.payload) });
  const rest = (s) => { const keep = t._failBodyInsert; Object.assign(t, s); t._failBodyInsert = keep; };
  return { _t: t, async query(b, p) { return run(b, p); }, async tx(fn) { const s = snap(); try { return await fn((b, p) => Promise.resolve(run(b, p)), {}); } catch (e) { rest(s); throw e; } } };
}

const ID = 'obody:iso', DAY = '2026-09-14';
// Build a commitBatch receipt carrying per-result OUTCOME BODIES. `body` is the
// actual replayable outcome; `digest` binds the row to the body's content hash.
function receiptWithBodies(bodies, { batchId = 'B1', parentRevision = 0 } = {}) {
  const evidence = bodies.map((b, i) => ({ id: `S#${i}`, status: 'COMPLETED_MODELED', completed: true, valid: i % 2 === 0, prospective: false, digest: bodyDigest(b), outcomeBody: b }));
  const newCompletedIds = evidence.map((e) => e.id);
  return {
    batchId, dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false,
    parentRevision, rotationIndex: 1, completedResults: [], newCompletedIds, pendingDelta: [], resultEvidence: evidence,
    tally: { completed: evidence.length, validModeled: evidence.filter((e) => e.valid).length, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length },
    executorCounters: null, observedUtcMs: 1,
  };
}
const mkStore = (db, opts = {}) => createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: 100000, ...opts });

test('RED contract 1: a credited result body is durably retained and retrievable, verified against its digest', async () => {
  const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
  const body = { pricePath: [100, 101, 99, 102], realizedPnl: 2.0, entry: 100, exit: 102 };
  const r = await store.commitBatch(receiptWithBodies([body]));
  assert.equal(r.ok, true, 'commit accepted');
  // The store MUST expose a bounded body readback bound to (day, sim).
  assert.equal(typeof store.readOutcomeBody, 'function', 'store must expose readOutcomeBody() — MISSING today');
  const got = await store.readOutcomeBody({ dayKey: DAY, simId: 'S#0' });
  assert.equal(got.verified, true, 'readback verifies content_digest == stored digest');
  assert.deepEqual(got.body, body, 'exact outcome body round-trips (actual replay is possible)');
});

test('RED contract 2: an oversize single body is REFUSED (fail-closed), nothing written', async () => {
  const db = makeFakeDb(); const store = mkStore(db, { maxOutcomeBodyBytes: 256 }); await store.commissionStore();
  const huge = { blob: 'x'.repeat(4096) };
  const r = await store.commitBatch(receiptWithBodies([huge]));
  assert.equal(r.ok, false, 'oversize body must be refused');
  assert.equal(r.reason, 'OUTCOME_BODY_BYTES_LIMIT', 'specific fail-closed reason');
  assert.equal(db._t.result.length, 0, 'no evidence written on refusal (whole batch rolled back)');
});

test('RED contract 3: per-batch aggregate body bytes over cap is REFUSED', async () => {
  const db = makeFakeDb(); const store = mkStore(db, { maxOutcomeBodyBytes: 4096, maxBatchBodyBytes: 1024 }); await store.commissionStore();
  const bodies = [{ blob: 'a'.repeat(600) }, { blob: 'b'.repeat(600) }];
  const r = await store.commitBatch(receiptWithBodies(bodies));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OUTCOME_BODY_BATCH_BYTES_LIMIT');
  assert.equal(db._t.result.length, 0, 'nothing written');
});

test('RED contract 4: a body whose hash != declared digest is REFUSED (canonical identity/digest binding)', async () => {
  const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
  const rec = receiptWithBodies([{ ok: 1 }]);
  rec.resultEvidence[0].digest = 'sha256:deadbeef'; // digest no longer matches the body
  const r = await store.commitBatch(rec);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'OUTCOME_BODY_DIGEST_MISMATCH');
});

test('RED contract 5: bodies survive restart and read back within the bounded cap', async () => {
  const db = makeFakeDb(); const s1 = mkStore(db); await s1.commissionStore();
  const bodies = [{ v: 1 }, { v: 2 }, { v: 3 }];
  const r = await s1.commitBatch(receiptWithBodies(bodies));
  assert.equal(r.ok, true);
  const s2 = mkStore(db); // simulate a restart on the same durable Db
  for (let i = 0; i < bodies.length; i++) {
    const got = await s2.readOutcomeBody({ dayKey: DAY, simId: `S#${i}` });
    assert.equal(got.verified, true);
    assert.deepEqual(got.body, bodies[i]);
  }
});

test('RED contract 6: metadata-only credited rows do NOT count as replayable', async () => {
  const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
  // A receipt with completed rows but NO outcome bodies — metadata only.
  const evidence = [0, 1].map((i) => ({ id: `M#${i}`, status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: `d${i}` }));
  const rec = {
    batchId: 'MB', dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false,
    parentRevision: 0, rotationIndex: 1, completedResults: [], newCompletedIds: evidence.map((e) => e.id), pendingDelta: [], resultEvidence: evidence,
    tally: { completed: 2, validModeled: 2, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 2 }, executorCounters: null, observedUtcMs: 1,
  };
  const r = await store.commitBatch(rec);
  assert.equal(r.ok, true, 'metadata-only commit is still allowed (accounting), but not replayable');
  const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, 2, 'counted for accounting');
  assert.equal(led.totals.replayable, 0, 'replayable total excludes metadata-only rows — MISSING today');
});

// ---- Additional Option A acceptance witnesses (root-required) ---------------

// Build a receipt carrying ONE completed row with an arbitrary (possibly
// non-canonical) body. digest is set to a benign value; the store rejects a
// non-canonical body at encode time, before the digest is ever compared.
function receiptRawBody(body, digest = 'sha256:placeholder') {
  const evidence = [{ id: 'S#0', status: 'COMPLETED_MODELED', completed: true, valid: false, prospective: false, digest, outcomeBody: body }];
  return { batchId: 'B1', dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false, parentRevision: 0, rotationIndex: 1, completedResults: [], newCompletedIds: ['S#0'], pendingDelta: [], resultEvidence: evidence, tally: { completed: 1, validModeled: 0, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 1 }, executorCounters: null, observedUtcMs: 1 };
}

test('W1: non-canonical bodies are rejected (undefined/nonfinite/function/accessor/non-plain), nothing written', async () => {
  const cases = [
    { x: undefined },
    { x: Number.NaN },
    { x: Infinity },
    { x: () => 1 },
    (() => { const o = {}; Object.defineProperty(o, 'g', { get() { return 1; }, enumerable: true }); return o; })(),
    { d: new Date() },
    { m: new Map() },
    [1, , 3], // sparse hole
  ];
  for (const body of cases) {
    const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
    const r = await store.commitBatch(receiptRawBody(body));
    assert.equal(r.ok, false, `should reject ${JSON.stringify(body)}`);
    assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL');
    assert.equal(db._t.result.length, 0, 'no evidence written on non-canonical body');
    assert.equal(db._t.payload.size, 0, 'no body written');
  }
});

test('W2: body+result+completion+day commit atomically — a body-write failure rolls back everything', async () => {
  const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
  db._t._failBodyInsert = true;
  await assert.rejects(() => store.commitBatch(receiptWithBodies([{ v: 1 }])), /body-insert failure/);
  assert.equal(db._t.result.length, 0, 'result rolled back');
  assert.equal(db._t.completed.size, 0, 'completed index rolled back');
  assert.equal(db._t.payload.size, 0, 'bodies rolled back');
  db._t._failBodyInsert = false;
  const load = await store.loadDay(DAY);
  assert.equal(load.status, 'NEW', 'day cleanly rolled back to NEW (no partial revision)');
});

test('W3: exact same sim+body retry (same batchId) is idempotent and content-verified; body not duplicated', async () => {
  const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
  const body = { path: [1, 2, 3], pnl: 4 };
  const r1 = await store.commitBatch(receiptWithBodies([body]));
  assert.equal(r1.ok, true);
  const r2 = await store.commitBatch(receiptWithBodies([body]));
  assert.equal(r2.ok, true); assert.equal(r2.idempotent, true); assert.equal(r2.contentVerified, true);
  assert.equal(db._t.payload.size, 1, 'body stored exactly once across the retry');
});

test('W4: a conflicting body for the same sim in one batch is refused (before any write)', async () => {
  const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
  const a = { id: 'S#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: bodyDigest({ v: 1 }), outcomeBody: { v: 1 } };
  const b = { id: 'S#0', status: 'COMPLETED_MODELED', completed: true, valid: true, prospective: false, digest: bodyDigest({ v: 2 }), outcomeBody: { v: 2 } };
  const rec = { batchId: 'B1', dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false, parentRevision: 0, rotationIndex: 1, completedResults: [], newCompletedIds: ['S#0'], pendingDelta: [], resultEvidence: [a, b], tally: { completed: 1, validModeled: 1, prospectiveEligible: 0, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: 2 }, executorCounters: null, observedUtcMs: 1 };
  const r = await store.commitBatch(rec);
  assert.equal(r.ok, false); assert.equal(r.reason, 'DUPLICATE_SIM_CONFLICT');
  assert.equal(db._t.payload.size, 0);
});

test('W5: per-day quota is serialized with concurrent commits (CAS-fenced stale parent cannot land bodies)', async () => {
  const db = makeFakeDb();
  await mkStore(db).commissionStore();
  const A = mkStore(db); const B = mkStore(db);
  // A commits at parent revision 0 and advances the day to revision 1.
  const ra = await A.commitBatch(receiptWithBodies([{ a: 1 }], { batchId: 'A', parentRevision: 0 }));
  assert.equal(ra.ok, true);
  // B still believes parent is 0 (concurrent) — the CAS fence rejects it, so its
  // body never lands and the day-byte total cannot be raced past the quota.
  const rb = await B.commitBatch(receiptWithBodies([{ b: 2 }], { batchId: 'B', parentRevision: 0 }));
  assert.equal(rb.ok, false); assert.equal(rb.reason, 'STALE_PARENT_REVISION');
  assert.equal(db._t.payload.size, 1, 'only the winning commit persisted a body');
});

// ---- W6: encoder strictness holes found in review of 292d345 -----------------
test('W6: encoder rejects symbol/non-enumerable keys, array getters/extra props, cycles, and over-deep', async () => {
  // helper that submits a raw body and returns the refusal
  async function reject(body) {
    const db = makeFakeDb(); const store = mkStore(db); await store.commissionStore();
    return store.commitBatch(receiptRawBody(body));
  }
  // symbol key (Object.keys silently ignored it before)
  { const b = { ok: 1 }; b[Symbol('s')] = 2; const r = await reject(b); assert.equal(r.ok, false); assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL'); }
  // non-enumerable data key (silently dropped before)
  { const b = {}; Object.defineProperty(b, 'hidden', { value: 1, enumerable: false }); const r = await reject(b); assert.equal(r.ok, false); assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL'); }
  // array indexed getter (was invoked / accepted via `i in value`)
  { const a = []; Object.defineProperty(a, '0', { get() { return 7; }, enumerable: true }); a.length = 1; const r = await reject(a); assert.equal(r.ok, false); assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL'); }
  // array extra (non-index) own property (ignored before)
  { const a = [1, 2]; a.tag = 'x'; const r = await reject(a); assert.equal(r.ok, false); assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL'); }
  // cycle — must be detected explicitly (detail says cycle), not via stack overflow
  { const b = { n: 1 }; b.self = b; const r = await reject(b); assert.equal(r.ok, false); assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL'); assert.match(String(r.detail), /cycle/); }
  // over-deep acyclic nesting — rejected by the depth ceiling (detail says depth)
  { let d = {}; for (let i = 0; i < 5000; i++) d = { c: d }; const r = await reject(d); assert.equal(r.ok, false); assert.equal(r.reason, 'OUTCOME_BODY_NONCANONICAL'); assert.match(String(r.detail), /deep|depth|node/); }
});
