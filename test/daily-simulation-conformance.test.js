// SIM-2 CONFORMANCE harness across the real seam:
//   real createDailySimulationScheduler  ->  real createDailySimulationStore
//   ->  restart  ->  single + paged outcome-body verification.
//
// The scheduler and store are UNMODIFIED. Bodies are wired in by a thin
// integrator SHIM (bodyAttachingStore) that plays the role a real integrator
// would: it enriches each newly-credited result-evidence row with the executor's
// outcome body and binds the row digest to sha256(canonical(body)). The executor
// is a DETERMINISTIC TEST-ONLY double emitting explicitly SYNTHETIC labels — these
// are NOT real market simulations, real learning, or prospective qualification.
//
// Proves, through the real scheduler: duplicate jobs, duplicate/idempotent
// batches, same sim in multiple raw result rows, interrupted commit + restart,
// pending backoff, target counts with retained replayable bodies, zero false
// completions on timeout/abort/error, and bounded (paged, non-materialized)
// body verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDailySimulationScheduler } from '../learning/daily-simulation-scheduler.js';
import { createDailySimulationStore } from '../persistence/daily-simulation-store.js';
import { SQL, SQL_BODY, RESULT_INSERT_BULK_PREFIX, COMPLETED_INSERT_BULK_PREFIX, RESULT_BODY_INSERT_BULK_PREFIX } from '../persistence/daily-simulation-schema.js';

const DAYMS = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY = '2026-09-14';

// canonical form MUST match the store's encodeOutcomeBody (key-sorted).
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const k = Object.keys(v).sort();
  return `{${k.map((x) => `${JSON.stringify(x)}:${stableStringify(v[x])}`).join(',')}}`;
}
const bodyDigest = (b) => `sha256:${createHash('sha256').update(stableStringify(b), 'utf8').digest('hex')}`;

// ---- comprehensive transactional fake Db (scheduler + store + body table) ----
function makeFakeDb() {
  const t = { store: new Map(), day: new Map(), batch: new Map(), completed: new Map(), pending: new Map(), result: [], jobsched: new Map(), payload: new Map() };
  const B2T = new Map(Object.entries(SQL_BODY).map(([tok, body]) => [body, tok]));
  const dk = (a, b) => `${a}|${b}`; const bk = (a, b, c) => `${a}|${b}|${c}`;
  let failAt = 0; let stmt = 0; // interrupt hook: throw on the Nth write statement inside a tx
  const cb = (id, d, sim) => { const c = t.completed.get(bk(id, d, sim)); return c ? c.batch_id : null; };
  const rd = (id, d, sim, batch) => { const r = t.result.filter((x) => x.identity === id && x.day_key === d && x.sim_id === sim && x.batch_id === batch && x.completed).sort((a, b) => a.row_ordinal - b.row_ordinal)[0]; return r ? r.digest : null; };
  function run(body, p) {
    if (body === 'BEGIN' || body === 'COMMIT' || body === 'ROLLBACK') return { rows: [], rowCount: 0 };
    const trip = () => { stmt += 1; if (failAt && stmt === failAt) throw new Error(`SIMULATED interrupt at write statement ${failAt}`); };
    if (body.startsWith(RESULT_INSERT_BULK_PREFIX)) { trip(); const n = p.length / 10; for (let i = 0; i < n; i++) { const b = i * 10; t.result.push({ identity: p[b], day_key: p[b + 1], batch_id: p[b + 2], row_ordinal: p[b + 3], sim_id: p[b + 4], status: p[b + 5], completed: p[b + 6], valid_modeled: p[b + 7], prospective_eligible: p[b + 8], digest: p[b + 9] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(COMPLETED_INSERT_BULK_PREFIX)) { trip(); const n = p.length / 4; for (let i = 0; i < n; i++) { const b = i * 4; const k = bk(p[b], p[b + 1], p[b + 2]); if (t.completed.has(k)) throw new Error('dup completed pk'); t.completed.set(k, { batch_id: p[b + 3] }); } return { rows: [], rowCount: n }; }
    if (body.startsWith(RESULT_BODY_INSERT_BULK_PREFIX)) { trip(); const n = p.length / 7; for (let i = 0; i < n; i++) { const b = i * 7; t.payload.set(bk(p[b], p[b + 1], p[b + 2]), { batch_id: p[b + 3], content_digest: p[b + 4], body_bytes: p[b + 5], body: JSON.parse(p[b + 6]) }); } return { rows: [], rowCount: n }; }
    switch (B2T.get(body)) {
      case SQL.STORE_GET: { const r = t.store.get(p[0]); return { rows: r ? [r] : [] }; }
      case SQL.STORE_INSERT: { t.store.set(p[0], { identity: p[0], policy_version: p[1], store_version: p[2], commissioned_at: p[3] }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_GET: { const r = t.day.get(dk(p[0], p[1])); return { rows: r ? [{ revision: r.revision, target: r.target, rotation_index: r.rotation_index, shortfall: r.shortfall }] : [] }; }
      case SQL.DAY_INSERT: { trip(); t.day.set(dk(p[0], p[1]), { revision: 0, target: p[2], rotation_index: 0, shortfall: null }); return { rowCount: 1, rows: [] }; }
      case SQL.DAY_UPDATE_CAS: { trip(); const r = t.day.get(dk(p[0], p[1])); if (r && r.revision === p[2]) { r.revision = p[3]; r.rotation_index = p[4]; return { rowCount: 1, rows: [] }; } return { rowCount: 0, rows: [] }; }
      case SQL.DAY_SET_SHORTFALL: { const r = t.day.get(dk(p[0], p[1])); if (r) r.shortfall = typeof p[2] === 'string' ? JSON.parse(p[2]) : p[2]; return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_GET: { const r = t.batch.get(bk(p[0], p[1], p[2])); return { rows: r ? [{ batch_id: r.batch_id, payload_digest: r.payload_digest, resulting_revision: r.resulting_revision, tally: r.tally, evidence_digest: r.evidence_digest }] : [] }; }
      case SQL.BATCH_INSERT: { trip(); const k = bk(p[0], p[1], p[2]); if (t.batch.has(k)) throw new Error('dup batch pk'); t.batch.set(k, { identity: p[0], day_key: p[1], batch_id: p[2], job_id: p[3], payload_digest: p[5], resulting_revision: p[7], cursor_before: p[8], next_cursor: p[9], done: p[10], evidence_digest: p[14] }); return { rowCount: 1, rows: [] }; }
      case SQL.EVIDENCE_AGGREGATE_DAY: { const g = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1]) continue; const e = g.get(r.status) || { status: r.status, n: 0, completed: 0 }; e.n++; e.completed += r.completed ? 1 : 0; g.set(r.status, e); } return { rows: [...g.values()] }; }
      case SQL.CREDITED_AGGREGATE: { const rep = new Map(); for (const r of t.result) { if (r.identity !== p[0] || r.day_key !== p[1] || !r.completed) continue; const c = t.completed.get(bk(p[0], p[1], r.sim_id)); if (!(c && c.batch_id === r.batch_id)) continue; const cur = rep.get(r.sim_id); if (!cur || r.row_ordinal < cur.row_ordinal) rep.set(r.sim_id, r); } let valid = 0, prospective = 0; for (const r of rep.values()) { valid += r.valid_modeled ? 1 : 0; prospective += r.prospective_eligible ? 1 : 0; } return { rows: [{ valid, prospective }] }; }
      case SQL.EVIDENCE_DISTINCT_COMPLETED: { const s = new Set(); for (const r of t.result) { if (r.identity === p[0] && r.day_key === p[1] && r.completed) s.add(r.sim_id); } return { rows: [{ n: s.size }] }; }
      case SQL.COMPLETED_HAS: return { rows: t.completed.has(bk(p[0], p[1], p[2])) ? [{ one: 1 }] : [] };
      case SQL.COMPLETED_LIST: { const out = []; for (const k of t.completed.keys()) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push(sim); } out.sort(); return { rows: out.slice(0, p[2] ?? out.length).map((sim_id) => ({ sim_id })) }; }
      case SQL.PENDING_LIST: { const out = []; for (const [k, v] of t.pending) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ sim_id: sim, ...v }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.PENDING_UPSERT: { trip(); const k = bk(p[0], p[1], p[2]); const prev = t.pending.get(k); t.pending.set(k, { status: p[3], digest: p[4], first_seen_rev: prev ? prev.first_seen_rev : p[5], last_seen_rev: p[6], attempts: p[7] }); return { rowCount: 1, rows: [] }; }
      case SQL.PENDING_DELETE: { trip(); t.pending.delete(bk(p[0], p[1], p[2])); return { rowCount: 1, rows: [] }; }
      case SQL.BATCH_LIST_DAY: { const out = []; for (const v of t.batch.values()) if (v.identity === p[0] && v.day_key === p[1]) out.push(v); out.sort((a, b) => a.resulting_revision - b.resulting_revision); return { rows: out.slice(0, p[2] ?? out.length).map((v) => ({ batch_id: v.batch_id, job_id: v.job_id, next_cursor: v.next_cursor, cursor_before: v.cursor_before, payload_digest: v.payload_digest, done: v.done })) }; }
      case SQL.JOBSCHED_LIST: { const out = []; for (const [k, v] of t.jobsched) { const [id, d, job] = k.split('|'); if (id === p[0] && d === p[1]) out.push({ job_id: job, next_eligible_ts: v.next_eligible_ts, backoff_attempts: v.backoff_attempts }); } return { rows: out.slice(0, p[2] ?? out.length) }; }
      case SQL.JOBSCHED_UPSERT: { trip(); t.jobsched.set(bk(p[0], p[1], p[2]), { next_eligible_ts: p[3], backoff_attempts: p[4] }); return { rowCount: 1, rows: [] }; }
      case SQL.ANALYZE_RESULT: case SQL.ANALYZE_COMPLETED: return { rows: [], rowCount: 0 };
      case SQL.RESULT_BODY_GET: { const r = t.payload.get(bk(p[0], p[1], p[2])); if (!r) return { rows: [] }; return { rows: [{ content_digest: r.content_digest, body_bytes: r.body_bytes, body: r.body, batch_id: r.batch_id, completed_batch: cb(p[0], p[1], p[2]), result_digest: rd(p[0], p[1], p[2], r.batch_id) }] }; }
      case SQL.RESULT_BODY_COUNT: { let n = 0; for (const k of t.payload.keys()) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) n++; } return { rows: [{ n }] }; }
      case SQL.RESULT_BODY_ORPHAN_COUNT: { let n = 0; for (const [k, v] of t.payload) { const [id, d, sim] = k.split('|'); if (id !== p[0] || d !== p[1]) continue; if (!(cb(id, d, sim) === v.batch_id && rd(id, d, sim, v.batch_id) === v.content_digest)) n++; } return { rows: [{ n }] }; }
      case SQL.RESULT_BODY_PAGE: { const out = []; for (const [k, v] of t.payload) { const [id, d, sim] = k.split('|'); if (id === p[0] && d === p[1] && sim > p[2]) out.push({ sim_id: sim, content_digest: v.content_digest, body_bytes: v.body_bytes, body: v.body, batch_id: v.batch_id, completed_batch: cb(id, d, sim), result_digest: rd(id, d, sim, v.batch_id) }); } out.sort((a, b) => (a.sim_id < b.sim_id ? -1 : 1)); return { rows: out.slice(0, p[3]) }; }
      case SQL.RESULT_BODY_DAY_BYTES: { let bytes = 0; for (const [k, v] of t.payload) { const [id, d] = k.split('|'); if (id === p[0] && d === p[1]) bytes += v.body_bytes; } return { rows: [{ bytes }] }; }
      default: throw new Error('conformance fake: unhandled ' + body);
    }
  }
  const snap = () => ({ store: new Map(t.store), day: new Map([...t.day].map(([k, v]) => [k, { ...v }])), batch: new Map(t.batch), completed: new Map(t.completed), pending: new Map(t.pending), result: t.result.slice(), jobsched: new Map(t.jobsched), payload: new Map(t.payload) });
  const rest = (s) => Object.assign(t, s);
  return {
    _t: t,
    setFailAt(n) { failAt = n; stmt = 0; },
    async query(b, p) { return run(b, p); },
    async tx(fn) { const s = snap(); try { return await fn((b, p) => Promise.resolve(run(b, p)), {}); } catch (e) { rest(s); throw e; } },
  };
}

// deterministic SYNTHETIC executor. Emits `frames` decision frames; each frame
// emits `variants` labelled synthetic rows carrying an outcome BODY. Modes let a
// test inject duplicate raw rows, a pending page, or a thrown error.
function syntheticExecutor(frames, { tag = 'C', variants = 4, mode = 'complete', dupEvery = 0 } = {}) {
  return {
    async executeDailySimulationBatch({ job, cursor, maxEvaluations }) {
      if (mode === 'throw') throw new Error('SIMULATED executor abort/timeout');
      const start = cursor ?? 0;
      const take = Math.max(0, Math.min(maxEvaluations, 64, frames - start));
      const results = [];
      for (let f = start; f < start + take; f++) {
        for (let v = 0; v < variants; v++) {
          const idx = f * variants + v;
          const simulationId = `${tag}#${idx}`;
          const body = { idx, tag, label: 'SYNTHETIC' };
          if (mode === 'pending') {
            results.push({ simulationId, status: 'PENDING_HORIZON', completed: false, validModeledOutcome: false, prospectiveQualificationEligible: false, body });
          } else {
            const row = { simulationId, status: 'COMPLETED_MODELED', completed: true, validModeledOutcome: idx % 8 === 0, prospectiveQualificationEligible: idx % 32 === 0, body };
            results.push(row);
            if (dupEvery && idx % dupEvery === 0) results.push({ ...row }); // same sim in TWO raw result rows
          }
        }
      }
      // Pending mode never finishes and does NOT advance the cursor — it rescans
      // the same sims so the scheduler can detect an unchanged, no-progress page
      // and back off (sim2-revisit-1). Completed mode advances normally.
      const done = mode === 'pending' ? false : (start + take >= frames);
      const nextCursor = mode === 'pending' ? start : (done ? null : start + take);
      return { jobId: job.jobId, cursor: start, nextCursor, done, results, counters: { frames: take, rows: results.length }, laws: ['synthetic'] };
    },
  };
}

const statusOf = (r) => r.status;
const identityOf = (r) => r.simulationId;
const completedOf = (r) => r.completed === true;
const validOf = (r) => r.validModeledOutcome === true;
const prospectiveOf = (r) => r.prospectiveQualificationEligible === true;
const bodyOf = (r) => r.body;
const outcomePathSource = { async pathsFor() { return { label: 'SYNTHETIC' }; } };

// Integrator SHIM: enrich each newly-credited evidence row with its outcome body
// and bind the row digest to the body content digest, then delegate to the REAL
// store. Scheduler and store are untouched.
function bodyAttachingStore(store) {
  return Object.freeze({
    loadDay: (...a) => store.loadDay(...a),
    recordPendingBackoff: (...a) => store.recordPendingBackoff(...a),
    recordShortfall: (...a) => store.recordShortfall(...a),
    readOutcomeBody: (...a) => store.readOutcomeBody(...a),
    verifyOutcomeBodies: (...a) => store.verifyOutcomeBodies(...a),
    async commitBatch(receipt) {
      const byId = new Map();
      for (const r of receipt.completedResults || []) { const b = bodyOf(r); if (b !== undefined) byId.set(String(identityOf(r)), b); }
      const resultEvidence = receipt.resultEvidence.map((e) => {
        if (e.completed && byId.has(e.id)) { const body = byId.get(e.id); return { ...e, outcomeBody: body, digest: bodyDigest(body) }; }
        return e;
      });
      return store.commitBatch({ ...receipt, resultEvidence });
    },
  });
}

const mkStore = (db, id) => createDailySimulationStore({ db, storeIdentity: id, dailyTarget: 100000 });
function mkScheduler(db, id, exec, { jobSource, maxEvalsPerTick = 64, dailyTarget = 100000 } = {}) {
  return createDailySimulationScheduler({
    store: bodyAttachingStore(mkStore(db, id)), jobSource, executor: exec, outcomePathSource,
    statusOf, identityOf, completedOf, validOf, prospectiveOf,
    dailyTarget, maxEvalsPerTick, clock: () => DAYMS,
  });
}
const oneJob = (jobId) => ({ async readyJobs() { return [{ jobId }]; } });

test('CONF-1: scheduler->store->restart->body verify (single + paged); replayable == completed', async () => {
  const db = makeFakeDb(); const ID = 'conf:1';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 40, VARIANTS = 4; const N = FRAMES * VARIANTS; // 160 credited sims
  const s1 = mkScheduler(db, ID, syntheticExecutor(FRAMES, { variants: VARIANTS }), { jobSource: oneJob('J'), dailyTarget: N });
  const run = await s1.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  // Restart: fresh handles on the same durable Db.
  const store = mkStore(db, ID);
  const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, N);
  assert.equal(led.totals.replayable, N, 'every credited sim retained a replayable body');
  assert.equal(led.bodyBackedIds, undefined, 'ledger never materializes a body id list (COUNT only)');
  const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 16 });
  assert.equal(v.verified, true); assert.equal(v.checked, N); assert.ok(v.pages > 1, 'verified across multiple bounded pages');
  const got = await store.readOutcomeBody({ dayKey: DAY, simId: 'C#0' });
  assert.equal(got.verified, true); assert.deepEqual(got.body, { idx: 0, tag: 'C', label: 'SYNTHETIC' });
});

test('CONF-2: duplicate jobs credit each sim once; replayable == unique completions', async () => {
  const db = makeFakeDb(); const ID = 'conf:2';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 20, VARIANTS = 4; const N = FRAMES * VARIANTS;
  // jobSource keeps returning the SAME job id even after it is done.
  const js = { async readyJobs() { return [{ jobId: 'DUPJOB' }]; } };
  const s = mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'D', variants: VARIANTS }), { jobSource: js, dailyTarget: N });
  await s.runToIdle({ maxTicks: 200 });
  const led = (await mkStore(db, ID).loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, N);
  assert.equal(led.totals.replayable, N);
  assert.equal(new Set(led.completedIds).size, N, 'no double-credit from duplicate jobs');
});

test('CONF-3: same sim in multiple raw result rows -> credited once, one body, verify ok', async () => {
  const db = makeFakeDb(); const ID = 'conf:3';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 10, VARIANTS = 4; const N = FRAMES * VARIANTS;
  const s = mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'M', variants: VARIANTS, dupEvery: 3 }), { jobSource: oneJob('J'), dailyTarget: N });
  await s.runToIdle();
  const store = mkStore(db, ID); const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, N, 'duplicate raw rows credited once');
  assert.equal(led.totals.replayable, N, 'one body per credited sim despite duplicate raw rows');
  // raw evidence retained duplicates (immutable): more result rows than completions.
  assert.ok(db._t.result.length > N, 'raw duplicate evidence preserved');
  assert.equal((await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 32 })).verified, true);
});

test('CONF-4: interrupted commit + restart -> no partial, no false completion, resumes consistent', async () => {
  const db = makeFakeDb(); const ID = 'conf:4';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 30, VARIANTS = 4; const N = FRAMES * VARIANTS;
  // First scheduler: interrupt the very first commit mid-write (rolls back whole batch).
  db.setFailAt(2);
  const s1 = mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'I', variants: VARIANTS }), { jobSource: oneJob('J'), dailyTarget: N });
  const r1 = await s1.tick();
  assert.equal(r1.tick, 'COMMIT_UNACKED', 'commit interrupted');
  assert.equal(db._t.result.length, 0, 'no partial evidence');
  assert.equal(db._t.payload.size, 0, 'no partial bodies');
  assert.equal((await mkStore(db, ID).loadDay(DAY)).status, 'NEW', 'clean rollback (day still NEW)');
  // Restart with no interrupt: resumes and completes consistently.
  db.setFailAt(0);
  const s2 = mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'I', variants: VARIANTS }), { jobSource: oneJob('J'), dailyTarget: N });
  const run = await s2.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const store = mkStore(db, ID); const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, N);
  assert.equal(led.totals.replayable, N);
  assert.equal((await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 50 })).verified, true);
});

test('CONF-5: pending backoff -> no completions, no bodies, no false replayable', async () => {
  const db = makeFakeDb(); const ID = 'conf:5';
  await mkStore(db, ID).commissionStore();
  const s = mkScheduler(db, ID, syntheticExecutor(5, { tag: 'P', variants: 4, mode: 'pending' }), { jobSource: oneJob('J'), dailyTarget: 100 });
  const outcomes = new Set();
  for (let i = 0; i < 6; i++) { const r = await s.tick(); outcomes.add(r.tick); }
  assert.ok(outcomes.has('PENDING_BACKOFF') || outcomes.has('PENDING_STALLED'), `saw backoff (${[...outcomes].join(',')})`);
  const led = (await mkStore(db, ID).loadDay(DAY)).ledger;
  assert.equal(led.totals.completed, 0, 'pending never counts as completed');
  assert.equal(led.totals.replayable, 0, 'no bodies for pending');
});

test('CONF-6: target counts + retained replayable bodies; overshoot bounded', async () => {
  const db = makeFakeDb(); const ID = 'conf:6';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 50, VARIANTS = 4; const N = FRAMES * VARIANTS; const TARGET = 150;
  const s = mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'T', variants: VARIANTS }), { jobSource: oneJob('J'), dailyTarget: TARGET });
  const run = await s.runToIdle();
  assert.equal(run.last, 'TARGET_MET');
  const led = (await mkStore(db, ID).loadDay(DAY)).ledger;
  assert.ok(led.totals.completed >= TARGET, 'target met');
  assert.equal(led.totals.replayable, led.totals.completed, 'all credited sims are replayable');
  assert.ok(led.totals.overshoot <= VARIANTS * 64, `bounded honest overshoot (${led.totals.overshoot})`);
});

test('CONF-7: zero false completions on executor timeout/abort/error', async () => {
  const db = makeFakeDb(); const ID = 'conf:7';
  await mkStore(db, ID).commissionStore();
  const s = mkScheduler(db, ID, syntheticExecutor(30, { tag: 'E', variants: 4, mode: 'throw' }), { jobSource: oneJob('J'), dailyTarget: 100 });
  const r = await s.tick();
  assert.equal(r.tick, 'EXEC_FAILED', 'executor abort surfaced, not swallowed');
  assert.equal(db._t.result.length, 0, 'no evidence written on abort');
  assert.equal(db._t.completed.size, 0, 'zero false completions');
  assert.equal(db._t.payload.size, 0, 'no bodies on abort');
  const load = await mkStore(db, ID).loadDay(DAY);
  assert.equal(load.status, 'NEW', 'no day materialized by a failed tick');
});

test('CONF-8: body verification is bounded/streaming (small page over many bodies)', async () => {
  const db = makeFakeDb(); const ID = 'conf:8';
  await mkStore(db, ID).commissionStore();
  const FRAMES = 64, VARIANTS = 4; const N = FRAMES * VARIANTS; // 256 bodies
  const s = mkScheduler(db, ID, syntheticExecutor(FRAMES, { tag: 'B', variants: VARIANTS }), { jobSource: oneJob('J'), dailyTarget: N });
  await s.runToIdle();
  const store = mkStore(db, ID);
  const v = await store.verifyOutcomeBodies({ dayKey: DAY, pageSize: 10 });
  assert.equal(v.verified, true); assert.equal(v.checked, N);
  assert.ok(v.pages >= Math.ceil(N / 10), `streamed in >= ${Math.ceil(N / 10)} bounded pages (got ${v.pages})`);
  // ledger proves replayable is a bounded COUNT, never a materialized list.
  const led = (await store.loadDay(DAY)).ledger;
  assert.equal(led.totals.replayable, N);
  assert.equal(led.bodyBackedIds, undefined);
});
