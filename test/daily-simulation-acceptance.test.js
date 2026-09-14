// SIM-2 acceptance repairs (root-confirmed). RED-first: each test encodes a
// confirmed defect and is expected to fail against the pre-repair store, then
// pass once the repair lands. Repairs:
//  (1) every write path enforces commissioned policy+store identity;
//  (2) constructor validates positive-finite bounds + safe target/clock;
//  (3) JOBSCHED_LIST bounded cap+1 refusal; malformed rotation/backoff refuse;
//  (4) within-batch duplicate sim_id credited once (no restart inflation);
//      conflicting duplicate bodies rejected;
//  (5) rebuildLedger reads a consistent revision snapshot (bounded retry), never
//      a mixed-version healthy RESUME;
//  + SHA-256 content identity; legacy null-digest rows never falsely "verified".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailySimulationStore, DsimStoreError } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX } from '../persistence/daily-simulation-schema.js';

const ID = 'acc:iso';
const DAY = '2026-09-14';

// Compact transactional fake with snapshot/rollback and a per-token query hook
// (used to simulate a concurrent commit landing mid-rebuild).
function makeFakeDb() {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [], jobsched: new Map() };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  const dk = (a, b) => `${a}|${b}`; const bk = (a, b, c) => `${a}|${b}|${c}`;
  let hook = null; // (tok) => void, invoked before each switch
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) { const n = p.length / 10; for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ identity: p[b], day_key: p[b + 1], batch_id: p[b + 2], row_ordinal: p[b + 3], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8], digest: p[b + 9] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; const k = bk(p[b], p[b + 1], p[b + 2]); if (t.completed.has(k)) throw new Error('dup completed pk'); t.completed.set(k, { batch_id: p[b + 3] }); } return { rows: [], rowCount: n }; }
    const tok = B2T.get(body);
    if (!tok) throw new Error('fake: unknown ' + body);
    if (hook) hook(tok);
    switch (tok) {
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0], policy_version: p[1], store_version: p[2], commissioned_at: p[3] }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_GET: { const r = t.day.get(dk(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: r.rotation_index, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { t.day.set(dk(p[0], p[1]), { revision: 0, target: p[2], rotation_index: 0, shortfall: null }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_UPDATE_CAS: { const r = t.day.get(dk(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; r.rotation_index = p[4]; return { rowCount: 1, rows: [] }; } return { rowCount: 0, rows: [] }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dk(p[0], p[1])); if (r) r.shortfall = typeof p[2] === 'string' ? JSON.parse(p[2]) : p[2]; return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bk(p[0], p[1], p[2])); return { rows: r ? [{ batch_id: r.batch_id, payload_digest: r.payload_digest, resulting_revision: r.resulting_revision, tally: r.tally, evidence_digest: r.evidence_digest }] : [] }; }
      case SQL.BATCH_INSERT: { const k = bk(p[0], p[1], p[2]); if (t.batch.has(k)) throw new Error('dup batch pk'); t.batch.set(k, { identity: p[0], day_key: p[1], batch_id: p[2], job_id: p[3], payload_digest: p[5], resulting_revision: p[7], next_cursor: p[9], cursor_before: p[8], done: p[10], evidence_digest: p[14] }); return { rowCount: 1, rows: [] }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1]) continue; const e = g.get(r.status) || { status: r.status, n: 0, completed: 0 }; e.n++; e.completed += r.completed ? 1 : 0; g.set(r.status, e); } return { rows: [...g.values()] }; }
      // DISTINCT ON (sim_id) representative row (min row_ordinal) then sum — one credit per credited sim.
      case SQL.CREDITED_AGGREGATE: { const rep = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1] || !r.completed) continue; const c = t.completed.get(bk(p[0], p[1], r.sim_id)); if (!(c && c.batch_id === r.batch_id)) continue; const cur = rep.get(r.sim_id); if (!cur || r.row_ordinal < cur.row_ordinal) rep.set(r.sim_id, r); } let valid = 0, prospective = 0; for (const r of rep.values()) { valid += r.valid_modeled ? 1 : 0; prospective += r.prospective_eligible ? 1 : 0; } return { rows: [{ valid, prospective }] }; }
      case SQL.EVIDENCE_DISTINCT_COMPLETED: { const s = new Set(); for (const r of t.result) { if (r.identity === p[0] && r.day_key === p[1] && r.completed) s.add(r.sim_id); } return { rows: [{ n: s.size }] }; }
      case SQL.COMPLETED_HAS: return { rows: t.completed.has(bk(p[0], p[1], p[2])) ? [{ one: 1 }] : [] };
      case SQL.COMPLETED_LIST: { const out = []; for (const k of t.completed.keys()) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push(sim); } out.sort(); return { rows: out.slice(0, p[2] ?? out.length).map((sim_id) => ({ sim_id })) }; }
      case SQL.PENDING_LIST: { const out = []; for (const [k, v] of t.pending) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ sim_id: sim, ...v }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.PENDING_UPSERT: { t.pending.set(bk(p[0], p[1], p[2]), { status: p[3], digest: p[4], first_seen_rev: p[5], last_seen_rev: p[6], attempts: p[7] }); return { rowCount: 1, rows: [] }; }
      case SQL.PENDING_DELETE: { t.pending.delete(bk(p[0], p[1], p[2])); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_LIST_DAY: { const out = []; for (const v of t.batch.values()) if (v.identity === p[0] && v.day_key === p[1]) out.push(v); out.sort((a, b) => a.resulting_revision - b.resulting_revision); return { rows: out.slice(0, p[2] ?? out.length).map((v) => ({ batch_id: v.batch_id, job_id: v.job_id, next_cursor: v.next_cursor, cursor_before: v.cursor_before, payload_digest: v.payload_digest, done: v.done })) }; }
      case SQL.JOBSCHED_LIST: { const out = []; for (const [k, v] of t.jobsched) { const [id, d, job] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ job_id: job, next_eligible_ts: v.next_eligible_ts, backoff_attempts: v.backoff_attempts }); } return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.JOBSCHED_UPSERT: { t.jobsched.set(bk(p[0], p[1], p[2]), { next_eligible_ts: p[3], backoff_attempts: p[4] }); return { rowCount: 1, rows: [] }; }
      case SQL.ANALYZE_RESULT: case SQL.ANALYZE_COMPLETED: return { rows: [], rowCount: 0 };
      case SQL.RESULT_BODY_COUNT: return { rows: [{ n: 0 }] };
      case SQL.RESULT_BODY_ORPHAN_COUNT: return { rows: [{ n: 0 }] };
      case SQL.RESULT_BODY_PAGE: return { rows: [] };
      case SQL.RESULT_BODY_DAY_BYTES: return { rows: [{ bytes: 0 }] };
      case SQL.RESULT_BODY_GET: return { rows: [] };
      default: throw new Error('fake: unhandled ' + tok);
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map(t.batch), completed: new Map(t.completed), pending: new Map(t.pending), result: t.result.slice(), jobsched: new Map(t.jobsched) });
  const rest = (s) => Object.assign(t, s);
  return {
    _t: t, setHook(fn) { hook = fn; },
    async query(b, p) { return run(b, p); },
    async tx(fn) { const s = snap(); try { return await fn((b, p) => Promise.resolve(run(b, p)), {}); } catch (e) { rest(s); throw e; } },
  };
}

function receipt(evidence, { batchId = 'B1', parentRevision = 0 } = {}) {
  const seen = new Map(); // first occurrence per id decides credit
  let completed = 0, valid = 0, prospective = 0;
  for (const e of evidence) { if (e.completed && !seen.has(e.id)) { seen.set(e.id, e); completed++; if (e.valid) valid++; if (e.prospective) prospective++; } }
  return { batchId, dayKey: DAY, jobId: 'J', jobDigest: 'jd', payloadDigest: 'pd', cursorBefore: null, nextCursor: 1, done: false, parentRevision, rotationIndex: 1, completedResults: [], newCompletedIds: [...seen.keys()], pendingDelta: [], resultEvidence: evidence, tally: { completed, validModeled: valid, prospectiveEligible: prospective, pending: 0, terminalNonCompleted: 0, duplicates: 0, pageSize: evidence.length }, executorCounters: null, observedUtcMs: 1 };
}
const row = (id, o = {}) => ({ id, status: 'COMPLETED_MODELED', completed: true, valid: false, prospective: false, digest: 'd:' + id, ...o });

// (1) write-path identity enforcement
test('R1: commitBatch/recordPendingBackoff/recordShortfall refuse a policy/store-identity mismatch', async () => {
  const db = makeFakeDb();
  await createDailySimulationStore({ db, storeIdentity: ID }).commissionStore(); // policy sim2-policy-1
  const wrong = createDailySimulationStore({ db, storeIdentity: ID, policyVersion: 'other-policy' });
  const c = await wrong.commitBatch(receipt([row('S#0', { valid: true })]));
  assert.equal(c.ok, false); assert.equal(c.reason, 'STORE_IDENTITY_MISMATCH');
  const p = await wrong.recordPendingBackoff({ dayKey: DAY, jobId: 'J', nextEligibleTs: 1, backoffAttempts: 1 });
  assert.equal(p.ok, false); assert.equal(p.reason, 'STORE_IDENTITY_MISMATCH');
  const s = await wrong.recordShortfall({ dayKey: DAY, shortfall: { missing: 1 } });
  assert.equal(s.ok, false); assert.equal(s.reason, 'STORE_IDENTITY_MISMATCH');
});

// (2) constructor argument validation
test('R2: constructor rejects non-positive/non-finite bounds and unsafe target/clock', async () => {
  const db = makeFakeDb();
  const bad = [{ maxResultRows: 0 }, { maxResultRows: 1.5 }, { maxReceiptBytes: 0 }, { maxReceiptBytes: -1 }, { maxDayRows: -1 }, { maxDayRows: 2.5 }, { maxResultRows: Infinity }, { dailyTarget: -5 }, { dailyTarget: Number.NaN }, { dailyTarget: 1.2 }, { clock: 123 }];
  for (const o of bad) assert.throws(() => createDailySimulationStore({ db, storeIdentity: ID, ...o }), DsimStoreError, `expected throw for ${JSON.stringify(o)}`);
  assert.doesNotThrow(() => createDailySimulationStore({ db, storeIdentity: ID, maxResultRows: 10, maxReceiptBytes: 1024, maxDayRows: 100, dailyTarget: 100000, clock: () => 1 }));
});

// (3) bounded jobsched + malformed refusal
test('R3a: JOBSCHED_LIST over the bounded cap loads as LOST', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID, maxDayRows: 2 }); await store.commissionStore();
  await store.commitBatch(receipt([row('S#0')]));
  db._t.jobsched.set(`${ID}|${DAY}|j1`, { next_eligible_ts: 1, backoff_attempts: 0 });
  db._t.jobsched.set(`${ID}|${DAY}|j2`, { next_eligible_ts: 1, backoff_attempts: 0 });
  db._t.jobsched.set(`${ID}|${DAY}|j3`, { next_eligible_ts: 1, backoff_attempts: 0 });
  const l = await store.loadDay(DAY); assert.equal(l.status, 'LOST');
});
test('R3b: malformed rotation_index refuses (LOST), never coerces to 0', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID }); await store.commissionStore();
  await store.commitBatch(receipt([row('S#0')]));
  db._t.day.get(`${ID}|${DAY}`).rotation_index = 'not-an-int';
  assert.equal((await store.loadDay(DAY)).status, 'LOST');
  db._t.day.get(`${ID}|${DAY}`).rotation_index = -3;
  assert.equal((await store.loadDay(DAY)).status, 'LOST');
});
test('R3c: malformed backoff/next_eligible in job schedule refuses (LOST)', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID }); await store.commissionStore();
  await store.commitBatch(receipt([row('S#0')]));
  db._t.jobsched.set(`${ID}|${DAY}|J`, { next_eligible_ts: 1, backoff_attempts: -2 });
  assert.equal((await store.loadDay(DAY)).status, 'LOST');
  db._t.jobsched.set(`${ID}|${DAY}|J`, { next_eligible_ts: Number.NaN, backoff_attempts: 0 });
  assert.equal((await store.loadDay(DAY)).status, 'LOST');
});

// (4) within-batch duplicate sim_id
test('R4a: identical duplicate sim_id in one batch is credited ONCE (no restart inflation)', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: 100000 }); await store.commissionStore();
  const dup = row('S#0', { valid: true, prospective: true });
  const r = await store.commitBatch(receipt([dup, { ...dup }])); // two identical rows, same id
  assert.equal(r.ok, true);
  const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, 1, 'one credited completion');
  assert.equal(led.totals.validModeled, 1, 'valid counted once, not twice, after restart');
  assert.equal(led.totals.prospectiveEligible, 1, 'prospective counted once');
});
test('R4b: conflicting duplicate sim_id bodies in one batch are rejected', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID }); await store.commissionStore();
  const r = await store.commitBatch(receipt([row('S#0', { valid: true }), row('S#0', { valid: false, digest: 'CONFLICT' })]));
  assert.equal(r.ok, false); assert.equal(r.reason, 'DUPLICATE_SIM_CONFLICT');
  assert.equal(db._t.result.length, 0, 'nothing written on conflict');
});

// (5) consistent-revision rebuild snapshot
test('R5: a concurrent commit during rebuild never yields a mixed-version RESUME', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID, dailyTarget: 100000 }); await store.commissionStore();
  await store.commitBatch(receipt([row('S#0', { valid: true })]));            // rev 1, 1 completed
  // Simulate ONE concurrent commit that lands after the first mid-rebuild read.
  let fired = false;
  db.setHook((tok) => {
    if (tok === SQL.EVIDENCE_AGGREGATE_DAY && !fired) {
      fired = true;
      const d = db._t.day.get(`${ID}|${DAY}`); d.revision += 1;               // concurrent revision advance
      db._t.result.push({ identity: ID, day_key: DAY, batch_id: 'B2', row_ordinal: 0, sim_id: 'S#1', status: 'COMPLETED_MODELED', completed: true, valid_modeled: true, prospective_eligible: false, digest: 'd:S#1' });
      db._t.completed.set(`${ID}|${DAY}|S#1`, { batch_id: 'B2' });
    }
  });
  const l = await store.loadDay(DAY);
  assert.equal(l.status, 'RESUME', 'still resumable after retry');
  // Consistency: reported revision must match the final day revision, and totals
  // must reflect the SAME snapshot (2 completed at rev 2), never rev 1 + 2 rows.
  assert.equal(l.ledger.revision, db._t.day.get(`${ID}|${DAY}`).revision, 'revision is the settled snapshot');
  assert.equal(l.ledger.totals.completed, 2, 'completed count matches the settled revision');
});

// SHA-256 identity + legacy null-digest honesty
test('D1: new evidence_digest uses SHA-256; identical replay is idempotent', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID }); await store.commissionStore();
  await store.commitBatch(receipt([row('S#0', { valid: true })]));
  const stored = db._t.batch.get(`${ID}|${DAY}|B1`).evidence_digest;
  assert.ok(typeof stored === 'string' && stored.startsWith('sha256:'), `evidence_digest should be sha256, got ${stored}`);
  const again = await store.commitBatch(receipt([row('S#0', { valid: true })]));
  assert.equal(again.ok, true); assert.equal(again.idempotent, true); assert.equal(again.contentVerified, true);
});
test('D2: a legacy null-digest batch row is never falsely reported content-verified', async () => {
  const db = makeFakeDb(); const store = createDailySimulationStore({ db, storeIdentity: ID }); await store.commissionStore();
  await store.commitBatch(receipt([row('S#0', { valid: true })]));
  db._t.batch.get(`${ID}|${DAY}|B1`).evidence_digest = null; // simulate an old receipt with no digest
  const again = await store.commitBatch(receipt([row('S#0', { valid: true })]));
  assert.equal(again.ok, true); assert.equal(again.idempotent, true);
  assert.equal(again.contentVerified, false, 'no verified-content claim for a null-digest legacy row');
});
