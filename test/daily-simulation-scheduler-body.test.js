// SIM-2 DIRECT scheduler->store outcome-body handoff. NO body-attaching shim:
// the real createDailySimulationScheduler must itself forward the executor's
// outcome body into the commit receipt and bind the credited result row digest
// to the store's exact SHA-256 canonical law. RED-first: before the production
// handoff exists, bodies never reach the store through the real scheduler, so
// `replayable` is 0 and verify finds nothing — these assertions fail. After the
// narrow handoff lands they pass. Executor is a deterministic TEST-ONLY double
// with explicit SYNTHETIC labels (not real market simulations).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX, RESULT_BODY_INSERT_BULK_PREFIX } from '../persistence/daily-simulation-schema.js';

const DAYMS = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY = '2026-09-14';
function stableStringify(v) { if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'; if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`; const k = Object.keys(v).sort(); return `{${k.map((x) => `${JSON.stringify(x)}:${stableStringify(v[x])}`).join(',')}}`; }
const bodyDigest = (b) => `sha256:${createHash('sha256').update(stableStringify(b), 'utf8').digest('hex')}`;

function makeFakeDb() {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [], jobsched: new Map(), payload: new Map() };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  const dk = (a, b) => `${a}|${b}`; const bk = (a, b, c) => `${a}|${b}|${c}`;
  const cb = (id, d, sim) => { const c = t.completed.get(bk(id, d, sim)); return c ? c.batch_id : null; };
  const rdg = (id, d, sim, batch) => { const r = t.result.filter((x) => x.identity === id && x.day_key === d && x.sim_id === sim && x.batch_id === batch && x.completed).sort((a, b) => a.row_ordinal - b.row_ordinal)[0]; return r ? r.digest : null; };
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) { const n = p.length / 10; for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ identity: p[b], day_key: p[b + 1], batch_id: p[b + 2], row_ordinal: p[b + 3], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8], digest: p[b + 9] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; const k = bk(p[b], p[b + 1], p[b + 2]); if (t.completed.has(k)) throw new Error('dup completed pk'); t.completed.set(k, { batch_id: p[b + 3] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(RESULT_BODY_INSERT_BULK_PREFIX)) { const n = p.length / 7; for (let i = 0; i < n; i++) { const b = i * 7; t.payload.set(bk(p[b], p[b + 1], p[b + 2]), { batch_id: p[b + 3], content_digest: p[b + 4], body_bytes: p[b + 5], body: JSON.parse(p[b + 6]) }); } return { rows: [], rowCount: n }; }
    switch (B2T.get(body)) {
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0], policy_version: p[1], store_version: p[2], commissioned_at: p[3] }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_GET: { const r = t.day.get(dk(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: r.rotation_index, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { t.day.set(dk(p[0], p[1]), { revision: 0, target: p[2], rotation_index: 0, shortfall: null }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_UPDATE_CAS: { const r = t.day.get(dk(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; r.rotation_index = p[4]; return { rowCount: 1, rows: [] }; } return { rowCount: 0, rows: [] }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dk(p[0], p[1])); if (r) r.shortfall = typeof p[2] === 'string' ? JSON.parse(p[2]) : p[2]; return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bk(p[0], p[1], p[2])); return { rows: r ? [{ batch_id: r.batch_id, payload_digest: r.payload_digest, resulting_revision: r.resulting_revision, tally: r.tally, evidence_digest: r.evidence_digest }] : [] }; }
      case SQL.BATCH_INSERT: { const k = bk(p[0], p[1], p[2]); if (t.batch.has(k)) throw new Error('dup batch pk'); t.batch.set(k, { identity: p[0], day_key: p[1], batch_id: p[2], job_id: p[3], payload_digest: p[5], resulting_revision: p[7], cursor_before: p[8], next_cursor: p[9], done: p[10], evidence_digest: p[14] }); return { rowCount: 1, rows: [] }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1]) continue; const e = g.get(r.status) || { status: r.status, n: 0, completed: 0 }; e.n++; e.completed += r.completed ? 1 : 0; g.set(r.status, e); } return { rows: [...g.values()] }; }
      case SQL.CREDITED_AGGREGATE: { const rep = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1] || !r.completed) continue; const c = t.completed.get(bk(p[0], p[1], r.sim_id)); if (!(c && c.batch_id === r.batch_id)) continue; const cur = rep.get(r.sim_id); if (!cur || r.row_ordinal < cur.row_ordinal) rep.set(r.sim_id, r); } let valid = 0, prospective = 0; for (const r of rep.values()) { valid += r.valid_modeled ? 1 : 0; prospective += r.prospective_eligible ? 1 : 0; } return { rows: [{ valid, prospective }] }; }
      case SQL.EVIDENCE_DISTINCT_COMPLETED: { const s = new Set(); for (const r of t.result) { if (r.identity === p[0] && r.day_key === p[1] && r.completed) s.add(r.sim_id); } return { rows: [{ n: s.size }] }; }
      case SQL.COMPLETED_HAS: return { rows: t.completed.has(bk(p[0], p[1], p[2])) ? [{ one: 1 }] : [] };
      case SQL.COMPLETED_LIST: { const out = []; for (const k of t.completed.keys()) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push(sim); } out.sort(); return { rows: out.slice(0, p[2] ?? out.length).map((sim_id) => ({ sim_id })) }; }
      case SQL.PENDING_LIST: { const out = []; for (const [k, v] of t.pending) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ sim_id: sim, ...v }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.PENDING_UPSERT: { const k = bk(p[0], p[1], p[2]); const prev = t.pending.get(k); t.pending.set(k, { status: p[3], digest: p[4], first_seen_rev: prev ? prev.first_seen_rev : p[5], last_seen_rev: p[6], attempts: p[7] }); return { rowCount: 1, rows: [] }; }
      case SQL.PENDING_DELETE: { t.pending.delete(bk(p[0], p[1], p[2])); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_LIST_DAY: { const out = []; for (const v of t.batch.values()) if (v.identity === p[0] && v.day_key === p[1]) out.push(v); out.sort((a, b) => a.resulting_revision - b.resulting_revision); return { rows: out.slice(0, p[2] ?? out.length).map((v) => ({ batch_id: v.batch_id, job_id: v.job_id, next_cursor: v.next_cursor, cursor_before: v.cursor_before, payload_digest: v.payload_digest, done: v.done })) }; }
      case SQL.JOBSCHED_LIST: { const out = []; for (const [k, v] of t.jobsched) { const [id, d, job] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ job_id: job, next_eligible_ts: v.next_eligible_ts, backoff_attempts: v.backoff_attempts }); } return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.JOBSCHED_UPSERT: { t.jobsched.set(bk(p[0], p[1], p[2]), { next_eligible_ts: p[3], backoff_attempts: p[4] }); return { rowCount: 1, rows: [] }; }
      case SQL.ANALYZE_RESULT: case SQL.ANALYZE_COMPLETED: return { rows: [], rowCount: 0 };
      case SQL.RESULT_BODY_GET: { const r = t.payload.get(bk(p[0], p[1], p[2])); if (!r) return { rows: [] }; return { rows: [{ content_digest: r.content_digest, body_bytes: r.body_bytes, body: r.body, batch_id: r.batch_id, completed_batch: cb(p[0], p[1], p[2]), result_digest: rdg(p[0], p[1], p[2], r.batch_id) }] }; }
      case SQL.RESULT_BODY_COUNT: { let n = 0; for (const k of t.payload.keys()) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) n++; } return { rows: [{ n }] }; }
      case SQL.RESULT_BODY_ORPHAN_COUNT: { let n = 0; for (const [k, v] of t.payload) { const [id, d, sim] = k.split('|'); if (id !== p[0] || d !== p[1]) continue; if (!(cb(id, d, sim) === v.batch_id && rdg(id, d, sim, v.batch_id) === v.content_digest)) n++; } return { rows: [{ n }] }; }
      case SQL.RESULT_BODY_PAGE: { const out = []; for (const [k, v] of t.payload) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1] && sim > p[2]) out.push({ sim_id: sim, content_digest: v.content_digest, body_bytes: v.body_bytes, body: v.body, batch_id: v.batch_id, completed_batch: cb(id, d, sim), result_digest: rdg(id, d, sim, v.batch_id) }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out.slice(0, p[3]) }; }
      case SQL.RESULT_BODY_DAY_BYTES: { let bytes = 0; for (const [k, v] of t.payload) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) bytes += v.body_bytes; } return { rows: [{ bytes }] }; }
      default: throw new Error('fake: unhandled ' + body);
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map(t.batch), completed: new Map(t.completed), pending: new Map(t.pending), result: t.result.slice(), jobsched: new Map(t.jobsched), payload: new Map(t.payload) });
  const rest = (s) => Object.assign(t, s);
  return { _t: t, async query(b, p) { return run(b, p); }, async tx(fn) { const s = snap(); try { return await fn((b, p) => Promise.resolve(run(b, p)), {}); } catch (e) { rest(s); throw e; } } };
}

function syntheticExecutor(frames, { tag = 'S', variants = 4, mode = 'complete', dupEvery = 0 } = {}) {
  return { async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
    if (mode === 'throw') throw new Error('SIMULATED executor abort/timeout');
    const start = cursor ?? 0; const take = Math.max(0, Math.min(maxEvaluations, 64, frames - start));
    const results = [];
    for (let f = start; f < start + take; f++) for (let v = 0; v < variants; v++) {
      const idx = f * variants + v; const simulationId = `${tag}#${idx}`; const body = { idx, tag, label: 'SYNTHETIC' };
      const row = { simulationId, status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: idx % 8 === 0, prospectiveQualificationEligible: idx % 32 === 0, body };
      results.push(row);
      if (dupEvery && idx % dupEvery === 0) results.push({ ...row });
    }
    const done = start + take >= frames;
    return { jobId: job.jobId, cursor: start, nextCursor: done ? null : start + take, done, results, counters: { frames: take }, laws: ['synthetic'] };
  } };
}
const statusOf = (r) => r.status; const identityOf = (r) => r.simulationId; const completedOf = (r) => r.completed === true;
const validOf = (r) => r.validModeledOutcome === true; const prospectiveOf = (r) => r.prospectiveQualificationEligible === true;
const bodyOf = (r) => r.body; // <-- the production handoff selector under test
const outcomePathSource = { async pathsFor() { return { label: 'SYNTHETIC' }; } };
const oneJob = (jobId) => ({ async readyJobs() { return [{ jobId }]; } });
const mkStore = (db, id) => createDailySimulationStore({ db, storeIdentity: id, dailyTarget: 100000 });
// DIRECT wiring: the real store handle is given to the scheduler unchanged — NO
// body-attaching proxy. Bodies must flow because the scheduler forwards them.
function mkScheduler(db, id, exec, { jobId = 'J', dailyTarget = 100000 } = {}) {
  return createDailySimulationScheduler({
    store: mkStore(db, id), jobSource: oneJob(jobId), executor: exec, outcomePathSource,
    statusOf, identityOf, completedOf, validOf, prospectiveOf, bodyOf,
    dailyTarget, maxEvalsPerTick: 64, clock: () => DAYMS,
  });
}

test('SBODY-1: real scheduler forwards bodies; direct-committed bodies survive restart + single/paged verify', async () => {
  const db = makeFakeDb(); const ID = 'sbody:1';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 40, VARIANTS = 4; const N = FRAMES * VARIANTS;
  const run = await mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'S', variants: VARIANTS }), { dailyTarget: N }).runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  // bodies were written by the REAL scheduler->store path (no shim).
  assert.equal(db._t.payload.size, N, 'scheduler forwarded a body per credited sim');
  const store = mkStore(db, ID);
  const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, N);
  assert.equal(led.totals.replayable, N, 'direct-committed bodies are replayable after restart');
  const got = await store.readOutcomeBody({ dayKey: DAY, simId: 'S#0' });
  assert.equal(got.verified, true); assert.deepEqual(got.body, { idx: 0, tag: 'S', label: 'SYNTHETIC' });
  const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 16 });
  assert.equal(v.verified, true); assert.equal(v.checked, N); assert.ok(v.pages > 1);
});

test('SBODY-2: credited result row digest is bound to the SHA-256 canonical body law', async () => {
  const db = makeFakeDb(); const ID = 'sbody:2';
  await mkStore(db, ID).commissionStore();
  await mkScheduler(db, ID, syntheticExecutor(1, { tag: 'Z', variants: 1 }), { dailyTarget: 1 }).runToIdle();
  // the credited result row's digest AND the stored body content_digest both
  // equal sha256(canonical(body)) — the store's exact law, from the real scheduler.
  const expect = bodyDigest({ idx: 0, tag: 'Z', label: 'SYNTHETIC' });
  const resRow = db._t.result.find((r) => r.sim_id === 'Z#0' && r.completed);
  assert.equal(resRow.digest, expect, 'scheduler bound the credited row digest to the body content digest');
  const bodyRow = db._t.payload.get(`${ID}|${DAY}|Z#0`);
  assert.equal(bodyRow.content_digest, expect);
});

test('SBODY-3: duplicate raw rows -> one credit, one body via the real scheduler', async () => {
  const db = makeFakeDb(); const ID = 'sbody:3';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 12, VARIANTS = 4; const N = FRAMES * VARIANTS;
  await mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'D', variants: VARIANTS, dupEvery: 3 }), { dailyTarget: N }).runToIdle();
  const store = mkStore(db, ID); const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, N);
  assert.equal(led.totals.replayable, N, 'one body per credited sim despite duplicate raw rows');
  assert.ok(db._t.result.length > N, 'raw duplicate evidence preserved');
  assert.equal((await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 32 })).verified, true);
});

test('SBODY-4: executor timeout/abort -> no bodies, zero false credit through the real scheduler', async () => {
  const db = makeFakeDb(); const ID = 'sbody:4';
  await mkStore(db, ID).commissionStore();
  const r = await mkScheduler(db, ID, syntheticExecutor(30, { tag: 'E', variants: 4, mode: 'throw' }), { dailyTarget: 100 }).tick();
  assert.equal(r.tick, 'EXEC_FAILED');
  assert.equal(db._t.completed.size, 0, 'zero false completions');
  assert.equal(db._t.payload.size, 0, 'no bodies on abort');
  assert.equal((await mkStore(db, ID).loadDay(DAY)).status, 'NEW');
});

import { readFileSync } from 'node:fs';

test('SBODY-5: oversized body is rejected by the scheduler (finite bound) with NO write', async () => {
  const db = makeFakeDb(); const ID = 'sbody:5'; await mkStore(db, ID).commissionStore();
  const bigExec = { async executeDailySimulationBatch({ job }) {
    return { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: [
      { simulationId: 'H#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: false, prospectiveQualificationEligible: false, body: { blob: 'x'.repeat(20000) } },
    ], counters: { frames: 1 }, laws: ['synthetic'] };
  } };
  // default maxOutcomeBodyBytes = 16 KiB; the 20 KB body must be refused before commit.
  const r = await mkScheduler(db, ID, bigExec, { dailyTarget: 10 }).tick();
  assert.equal(r.tick, 'BODY_REJECTED');
  assert.equal(r.reason, 'OUTCOME_BODY_BYTES_LIMIT');
  assert.equal(db._t.result.length, 0, 'no evidence written');
  assert.equal(db._t.completed.size, 0, 'zero false completions');
  assert.equal(db._t.payload.size, 0, 'no body written');
  assert.equal((await mkStore(db, ID).loadDay(DAY)).status, 'NEW');
});

test('SBODY-FENCE: scheduler uses the pure body module, not persistence; store + body module obey the fence', () => {
  const sched = readFileSync(new URL('../learning/daily-simulation-scheduler.js', import.meta.url), 'utf8');
  assert.ok(!sched.includes("from '../persistence"), 'scheduler must not import persistence (learning fence)');
  assert.ok(sched.includes("from './daily-simulation-body.js'"), 'scheduler imports the pure body codec');
  const bodyMod = readFileSync(new URL('../learning/daily-simulation-body.js', import.meta.url), 'utf8');
  assert.ok(bodyMod.includes("from 'node:crypto'"), 'body module uses node:crypto');
  for (const forbidden of ["from '../persistence", "from '../judge", "from '../execution", 'node:fs', 'node:http', 'fetch(']) {
    assert.ok(!bodyMod.includes(forbidden), `pure body module must not contain ${forbidden}`);
  }
  const store = readFileSync(new URL('../persistence/daily-simulation-store.js', import.meta.url), 'utf8');
  assert.ok(store.includes("from '../learning/daily-simulation-body.js'"), 'store reuses the same pure body codec');
});

test('SBODY-6: whole-page strict preflight rejects a getter field (no getter invoked) before digest/selectors', async () => {
  const db = makeFakeDb(); const ID = 'sbody:6'; await mkStore(db, ID).commissionStore();
  let getterInvoked = false;
  const gExec = { async executeDailySimulationBatch({ job }) {
    const row = { simulationId: 'G#0', status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false, prospectiveQualificationEligible: false };
    Object.defineProperty(row, 'extra', { enumerable: true, get() { getterInvoked = true; return 1; } });
    return { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: [row], counters: { frames: 1 }, laws: ['x'] };
  } };
  const r = await mkScheduler(db, ID, gExec, { dailyTarget: 10 }).tick();
  assert.equal(r.tick, 'PAGE_REJECTED');
  assert.equal(r.reason, 'PAGE_NONCANONICAL');
  assert.equal(getterInvoked, false, 'the page preflight read via descriptors — the getter was never invoked');
  assert.equal(db._t.result.length, 0);
});

test('SBODY-7: same sim id with DIFFERENT bodies is rejected, never silently the first body', async () => {
  const db = makeFakeDb(); const ID = 'sbody:7'; await mkStore(db, ID).commissionStore();
  const dExec = { async executeDailySimulationBatch({ job }) {
    const mk = (body) => ({ simulationId: 'X#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: false, prospectiveQualificationEligible: false, body });
    return { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: [mk({ v: 1 }), mk({ v: 2 })], counters: { frames: 1 }, laws: ['x'] };
  } };
  const r = await mkScheduler(db, ID, dExec, { dailyTarget: 10 }).tick();
  assert.equal(r.tick, 'BODY_REJECTED');
  assert.equal(r.reason, 'DUPLICATE_SIM_BODY_CONFLICT');
  assert.equal(db._t.result.length, 0, 'nothing written on conflict');
  assert.equal(db._t.payload.size, 0);
});

test('SBODY-8: exact-duplicate same-id body dedups (one credit, one body) through the real scheduler', async () => {
  const db = makeFakeDb(); const ID = 'sbody:8'; await mkStore(db, ID).commissionStore();
  const sameExec = { async executeDailySimulationBatch({ job }) {
    const mk = () => ({ simulationId: 'Y#0', status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: true, prospectiveQualificationEligible: false, body: { v: 7 } });
    return { jobId: job.jobId, cursor: 0, nextCursor: null, done: true, results: [mk(), mk()], counters: { frames: 1 }, laws: ['x'] };
  } };
  const run = await mkScheduler(db, ID, sameExec, { dailyTarget: 1 }).runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const led = (await mkStore(db, ID).loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, 1); assert.equal(led.totals.replayable, 1);
});
