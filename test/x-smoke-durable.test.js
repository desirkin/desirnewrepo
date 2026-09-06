// SOCIAL-2B DURABLE PAID-SMOKE AUTHORIZATION SEAL — a paid smoke is an explicit
// operator-authorized RUN (RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID), durable ACTIVE
// before the paid stream opens, a durable per-run count that survives crashes,
// and durable terminal state that a restart can never unlatch. Fake X API only:
// no network, no credential, no spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSocialFilter } from '../rumor2/social.js';
import { createXRuntime, xGate, xSmokeLaw, xConfigFromEnv, smokeRunIdHash, X_IN_FLIGHT_POST_HEADROOM, X_RUNTIME_STATES } from '../rumor2/x-runtime.js';
import { X_OFFICIAL, xRuleTag } from '../rumor2/providers/x-official.js';
import { SOCIAL_EVENT_TYPE, X_METER_EVENT_TYPE, X_GAP_EVENT_TYPE, X_SMOKE_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_SMOKE_RUN_ID_RE, X_SMOKE_STATUSES, SOCIAL_EVENT_TYPES, xSmokeEvent, validateXSmokeEvent, replaySocialHistory } from '../rumor2/social-settle.js';
import { memJournal } from './helpers/rumor2-journal.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-xsd-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const T = Date.parse('2026-09-06T12:00:00Z');
const NEXT_DAY = Date.parse('2026-09-07T00:00:05Z');
const iso = (m) => new Date(m).toISOString();
const BEARER = 'test-bearer-value-never-logged';
const RUN1 = 'smoke-2026-09-06-001'; const RUN2 = 'smoke-2026-09-06-002';
const CFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeTargetPostReads: null, liveSmokeMaxPostReads: null, liveSmokeRunId: null, priorityAccounts: [], propagationFocus: [], ...over });
const SMOKE = (over = {}) => CFG({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35, liveSmokeRunId: RUN1, ...over });
const FILTER = buildSocialFilter({ terms: ['BTC', 'ETH', 'SOL'] });
const ORIGIN_TAG = xRuleTag('origin', '($BTC OR #BTC OR $ETH OR #ETH OR $SOL OR #SOL) -is:retweet');
const postLine = (id, text = '$BTC listing') => JSON.stringify({ data: { id: String(id), text, author_id: '42', created_at: iso(T - 5_000), edit_history_tweet_ids: [String(id)], conversation_id: String(id), public_metrics: { like_count: 1 } }, matching_rules: [{ id: 'r1', tag: ORIGIN_TAG }] }) + '\r\n';
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const ofType = (arr, t) => arr.filter((e) => e.type === t);

function countingBody() {
  const enc = new TextEncoder(); const queue = []; let waiter = null; let errored = null;
  const b = { reads: 0, aborted: false, url: null };
  b.push = (text) => { const v = enc.encode(text); if (waiter) { const w = waiter; waiter = null; w.resolve({ value: v, done: false }); } else queue.push(v); };
  b.error = (e) => { errored = e; if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  b.body = { getReader: () => ({ read: () => { b.reads += 1; if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (errored) return Promise.reject(errored); return new Promise((resolve, reject) => { waiter = { resolve, reject }; }); }, releaseLock() {} }) };
  return b;
}
// fake X API whose server project usage can be moved between "processes"
function fakeXApi({ rules = [], projectUsage = 100 } = {}) {
  const state = { rules: rules.map((r, i) => ({ id: r.id ?? `u${i}`, value: r.value, tag: r.tag })), nextId: 1000, streams: [], calls: [], projectUsage };
  const res = (status, json = null) => ({ status, json: async () => json, body: null });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push({ path: u.pathname, method: opts.method ?? 'GET' });
    assert.equal(u.host, 'api.x.com'); assert.equal(opts.headers?.Authorization, `Bearer ${BEARER}`);
    if (u.pathname === '/2/usage/tweets') return res(200, { data: { project_usage: String(state.projectUsage), project_cap: '3000000', cap_reset_day: 1, daily_project_usage: [] } });
    if (u.pathname === '/2/usage/credits') return res(200, { data: { free_balance: 0, prepaid_balance: 50, total_balance: 50 } });
    if (u.pathname === '/2/tweets/search/stream/rules/counts') return res(404, null);
    if (u.pathname === '/2/tweets/search/stream/rules') {
      if ((opts.method ?? 'GET') === 'GET') return res(200, { data: state.rules.map((r) => ({ ...r })) });
      const bodyObj = JSON.parse(opts.body);
      if (u.searchParams.get('dry_run') === 'true') return res(200, { meta: { summary: { valid: (bodyObj.add ?? []).length, invalid: 0 } } });
      if (bodyObj.add) { for (const r of bodyObj.add) state.rules.push({ id: String(state.nextId++), value: r.value, tag: r.tag }); return res(201, { data: bodyObj.add }); }
      if (bodyObj.delete) { state.rules = state.rules.filter((r) => !bodyObj.delete.ids.includes(r.id)); return res(200, { meta: {} }); }
      return res(400, null);
    }
    if (u.pathname === '/2/tweets/search/stream') {
      const s = countingBody(); s.url = url; s.signal = opts.signal;
      opts.signal?.addEventListener('abort', () => { s.aborted = true; s.error(new Error('aborted')); });
      state.streams.push(s);
      return { status: 200, body: s.body, json: async () => null };
    }
    return res(404, null);
  };
  return { fetchImpl, state, streams: () => state.streams.length, last: () => state.streams[state.streams.length - 1] };
}
// wall clock: monotonic across "processes" within a test (a restart never runs the clock backwards)
let WALL = T;
test.beforeEach(() => { WALL = T; });
const boot = ({ api, config = SMOKE(), nowMs = null, universe = ['BTC', 'ETH', 'SOL'], over = {} } = {}) => {
  const clock = { ms: Math.max(nowMs ?? T, WALL) };
  const rt = createXRuntime({ config, filter: FILTER, universe, aliases: ['bitcoin'], now: () => { clock.ms += 1; if (clock.ms > WALL) WALL = clock.ms; return clock.ms; }, fetchImpl: api.fetchImpl, log: () => {}, streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} }, ...over });
  return { rt, clock };
};
const settle = (rt, j, fenceHeld = () => true) => rt.settle({ fenceHeld, append: (e) => j.append(e), lookup: null });
// "process": hydrate from the shared journal, then the two-phase start
async function proc({ api, arr, config = SMOKE(), nowMs = null, universe, over } = {}) {
  const j = memJournal(arr); const b = boot({ api, config, nowMs, universe, over });
  const h = b.rt.hydrate(arr); assert.equal(h.ok, true, h.error);
  const first = await b.rt.start();
  let second = null;
  if (first.reason === 'SMOKE_ACTIVATION_PENDING') { assert.equal((await settle(b.rt, j)).ok, true); second = await b.rt.start(); }
  return { ...b, j, first, start: second ?? first, stream: () => api.last() };
}
const deliver = async (api, from, to) => { for (let i = from; i <= to; i++) { api.last().push(postLine(i)); await tick(1); } await tick(); };

// =====================================================================================
// §4–§5 run ID law
// =====================================================================================
test('SMOKE-RUNID-1 (§4/§5). TARGET/MAX without a run ID fail closed; malformed IDs fail closed; the ID is never generated; ignored when no smoke is configured', async () => {
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35 }).reason, 'SMOKE_RUN_ID_REQUIRED');
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35, liveSmokeRunId: '' }).reason, 'SMOKE_RUN_ID_REQUIRED');
  for (const bad of ['short', 'x'.repeat(65), 'has space here', 'bearer/secret?', 'tab\tinside', 'émoji-run-id-1']) assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35, liveSmokeRunId: bad }).reason, 'SMOKE_RUN_ID_INVALID', bad);
  for (const good of [RUN1, '3f1c2a9e-7b5d-4c1e-9a0b-1234567890ab', 'ops:smoke.2026-09-06_01', 'a1b2c3d4']) assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35, liveSmokeRunId: good }).ok, true, good);
  assert.ok(X_SMOKE_RUN_ID_RE.test(RUN1)); assert.equal(X_SMOKE_RUN_ID_RE.source, '^[A-Za-z0-9._:-]{8,64}$');
  const env = { RUMOR2_SOCIAL_X_ENABLED: 'true', X_BEARER_TOKEN: 'b', RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '100', RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '1000', RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: '0.5' };
  assert.equal(xConfigFromEnv(env).liveSmokeRunId, null, 'no default run ID');
  assert.equal(xConfigFromEnv({ ...env, RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID: RUN1 }).liveSmokeRunId, RUN1);
  assert.equal(xGate(xConfigFromEnv({ ...env, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10', RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '35' })).reason, 'SMOKE_RUN_ID_REQUIRED');
  assert.equal(xGate(xConfigFromEnv({ ...env, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10', RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '35', RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID: 'bad id' })).reason, 'SMOKE_RUN_ID_INVALID');
  assert.equal(xGate(xConfigFromEnv({ ...env, RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID: RUN1 })).ok, true, 'a run ID without a smoke is ignored — normal X gates apply');
  // runtime: zero requests either way
  const api = fakeXApi();
  for (const cfg of [SMOKE({ liveSmokeRunId: null }), SMOKE({ liveSmokeRunId: 'nope' }), SMOKE({ liveSmokeTargetPostReads: null, liveSmokeMaxPostReads: 35 })]) { const { rt } = boot({ api, config: cfg }); rt.hydrate([]); assert.equal((await rt.start()).ok, false); }
  assert.equal(api.state.calls.length, 0, 'zero X requests'); assert.equal(api.streams(), 0);
  // the hash is deterministic and is not a secret; status exposes only a prefix
  assert.equal(smokeRunIdHash(RUN1), smokeRunIdHash(RUN1)); assert.notEqual(smokeRunIdHash(RUN1), smokeRunIdHash(RUN2));
});

// =====================================================================================
// §8 ACTIVE-before-connect + RED #1 completed restart + RED #2 mid-run restart
// =====================================================================================
test('SMOKE-ACTIVATE (§8/§9). the ACTIVE authorization with its durable baseline is appended under the fence BEFORE any paid stream request; the next start connects', async () => {
  const api = fakeXApi({ projectUsage: 250 }); const arr = []; const j = memJournal(arr);
  const { rt } = boot({ api }); rt.hydrate([]);
  const r1 = await rt.start();
  assert.equal(r1.reason, 'SMOKE_ACTIVATION_PENDING'); assert.equal(api.streams(), 0, 'NO paid stream before the ACTIVE event is durable');
  assert.ok(api.state.calls.some((c) => c.path === '/2/usage/tweets'), 'the mandatory usage preflight ran first'); assert.equal(rt.status().state, 'SMOKE_ACTIVATING'); assert.equal(rt.status().smoke.activationPending, true);
  assert.equal((await rt.start()).reason, 'SMOKE_ACTIVATION_PENDING', 'still pending until settle commits — no second activation identity'); assert.equal(api.streams(), 0);
  const s = await settle(rt, j); assert.equal(s.ok, true);
  const act = ofType(arr, X_SMOKE_EVENT_TYPE); assert.equal(act.length, 1);
  assert.equal(act[0].status, 'ACTIVE'); assert.equal(act[0].smokeRunId, RUN1); assert.equal(act[0].targetPostReads, 10); assert.equal(act[0].maxPostReads, 35); assert.equal(act[0].headroomPosts, 25);
  assert.equal(act[0].baselinePeriod, '2026-09-06'); assert.equal(act[0].baselineDailyDeliveredPostReads, 0); assert.equal(act[0].baselineMonthlyDeliveredPostReads, 0); assert.equal(act[0].baselineServerProjectUsage, 250, 'baseline from the FRESH usage preflight');
  assert.equal(act[0].unitPriceUsd, X_OFFICIAL.pricing.postReadUsd); assert.equal(act[0].ruleSetHash.length, 40); assert.equal(act[0].coverageEpoch, 1); assert.equal(validateXSmokeEvent(act[0]), null);
  assert.equal(arr.findIndex((e) => e.type === X_RULESET_EVENT_TYPE) < arr.findIndex((e) => e.type === X_SMOKE_EVENT_TYPE), true, 'rule-set activation precedes the smoke activation in the same batch');
  assert.ok(!JSON.stringify(arr).includes(BEARER), 'no bearer in any durable event');
  const r2 = await rt.start(); assert.equal(r2.ok, true); assert.equal(api.streams(), 1);
  const st = rt.status().smoke; assert.equal(st.durableStatus, 'ACTIVE'); assert.equal(st.conservativeDeliveredForRun, 0); assert.equal(st.targetRemaining, 10); assert.equal(st.maxRemaining, 35); assert.equal(st.smokeRunIdHashPrefix, smokeRunIdHash(RUN1).slice(0, 12));
  rt.stop();
});

test('SMOKE-DUR-1 (RED #1 / §11 / PASS 4). a completed smoke stays COMPLETE after restart: same RUN_ID => SMOKE_RUN_ALREADY_COMPLETE, zero stream requests', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) });
  assert.equal(A.start.ok, true); await tick(); await deliver(api, 1, 1);
  assert.equal(A.rt.status().state, 'SMOKE_COMPLETE'); assert.equal(A.rt.status().smoke.latched, true); assert.equal(A.rt.status().meter.sessionPostReads, 1);
  assert.equal((await settle(A.rt, A.j)).ok, true);
  const types = arr.map((e) => e.type);
  assert.deepEqual(types, [X_RULESET_EVENT_TYPE, X_SMOKE_EVENT_TYPE, SOCIAL_EVENT_TYPE, X_METER_EVENT_TYPE, 'RUMOR2_SOCIAL_X_PROGRESS', X_GAP_EVENT_TYPE, X_SMOKE_EVENT_TYPE], 'terminal smoke truth settles WITH the final evidence/meter/progress/gap');
  const term = ofType(arr, X_SMOKE_EVENT_TYPE)[1];
  assert.equal(term.status, 'COMPLETE'); assert.equal(term.terminalReason, 'SMOKE_TARGET_REACHED'); assert.equal(term.deliveredPostReadsForRun, 1); assert.equal(term.overrunPosts, 0); assert.equal(validateXSmokeEvent(term), null);
  A.rt.stop(); // destroy A
  const streamsBefore = api.streams();
  const B = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) });
  assert.equal(B.first.reason, 'SMOKE_RUN_ALREADY_COMPLETE'); assert.equal(B.rt.status().state, 'SMOKE_COMPLETE'); assert.equal(B.rt.status().smoke.durableStatus, 'COMPLETE'); assert.equal(B.rt.status().smoke.latched, true);
  assert.equal(api.streams(), streamsBefore, 'ZERO new stream requests'); assert.equal(B.rt.status().meter.sessionPostReads, 0, 'meter.session is a diagnostic, not the envelope');
  assert.equal(B.rt.status().meter.durableDeliveredPostReads, 1);
  assert.equal(replaySocialHistory(arr).x.smoke.runs[RUN1].status, 'COMPLETE');
});

test('SMOKE-DUR-2 (RED #2 / §10 / §18 / PASS 3+6). 8 Posts durable, crash, same RUN_ID: the run resumes with 8 counted and 2 remaining — not another 10', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); assert.equal(A.start.ok, true); await tick(); await deliver(api, 1, 8);
  assert.equal((await settle(A.rt, A.j)).ok, true); assert.equal(A.rt.status().smoke.conservativeDeliveredForRun, 8);
  A.rt.stop();
  const B = await proc({ api, arr });
  assert.equal(B.first.ok, true, 'same run resumes'); assert.equal(api.streams(), 2, 'after a fresh usage/credit/rule preflight');
  const st = B.rt.status().smoke;
  assert.equal(st.durableStatus, 'ACTIVE'); assert.equal(st.resumedAfterRestart, true); assert.equal(st.conservativeDeliveredForRun, 8); assert.equal(st.targetRemaining, 2); assert.equal(st.maxRemaining, 27);
  assert.equal(B.rt.status().meter.sessionPostReads, 0); assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).length, 1, 'no second activation');
  await deliver(api, 9, 10);
  assert.equal(B.rt.status().state, 'SMOKE_COMPLETE'); assert.equal(B.rt.status().smoke.terminalPending.deliveredPostReadsForRun, 10, '8 durable + 2 now');
  assert.equal(api.last().reads, 2, 'two chunks, no read after the stop');
  assert.equal((await settle(B.rt, B.j)).ok, true);
  const term = ofType(arr, X_SMOKE_EVENT_TYPE)[1]; assert.equal(term.status, 'COMPLETE'); assert.equal(term.deliveredPostReadsForRun, 10);
  assert.equal(ofType(arr, X_METER_EVENT_TYPE).at(-1).deliveredPostReads, 10);
  assert.equal((await B.rt.start()).reason, 'SMOKE_RUN_ALREADY_COMPLETE'); assert.equal(api.streams(), 2);
});

test('SMOKE-DUR-3 (§12 / PASS 9). after smoke-001 completes, only a NEW explicit RUN_ID authorizes another paid smoke: a new ACTIVE event, a new run', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) }); await tick(); await deliver(api, 1, 1); await settle(A.rt, A.j); A.rt.stop();
  const same = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) });
  assert.equal(same.first.reason, 'SMOKE_RUN_ALREADY_COMPLETE'); assert.equal(api.streams(), 1);
  const B = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26, liveSmokeRunId: RUN2 }) });
  assert.equal(B.first.reason, 'SMOKE_ACTIVATION_PENDING'); assert.equal(B.start.ok, true); assert.equal(api.streams(), 2);
  const acts = ofType(arr, X_SMOKE_EVENT_TYPE).filter((e) => e.status === 'ACTIVE'); assert.equal(acts.length, 2); assert.equal(acts[1].smokeRunId, RUN2);
  assert.equal(acts[1].baselineDailyDeliveredPostReads, 1, 'the new run baselines on the durable meter, so run 1 reads never count for run 2');
  assert.equal(B.rt.status().smoke.conservativeDeliveredForRun, 0);
  const rp = replaySocialHistory(arr).x.smoke; assert.equal(rp.activeRunId, RUN2); assert.equal(rp.runs[RUN1].status, 'COMPLETE');
  B.rt.stop();
  // restart, day rollover, unchanged target/max, bearer, and budget room are NOT consent for run 1
  const later = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }), nowMs: NEXT_DAY });
  assert.equal(later.first.reason, 'SMOKE_RUN_ALREADY_COMPLETE'); assert.equal(api.streams(), 2);
});

test('SMOKE-DUR-4 (§13 / PASS 8). the same RUN_ID with a different TARGET/MAX is not the same authorization: SMOKE_RUN_CONFIG_MISMATCH, zero stream requests', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); await tick(); await deliver(api, 1, 3); await settle(A.rt, A.j); A.rt.stop();
  for (const cfg of [SMOKE({ liveSmokeTargetPostReads: 20, liveSmokeMaxPostReads: 45 }), SMOKE({ liveSmokeMaxPostReads: 40 }), SMOKE({ liveSmokeTargetPostReads: 5 })]) {
    const B = await proc({ api, arr, config: cfg });
    assert.equal(B.first.reason, 'SMOKE_RUN_CONFIG_MISMATCH'); assert.ok(/never reinterpreted/.test(B.first.detail));
  }
  assert.equal(api.streams(), 1, 'no stream under a mutated authorization');
  const h = boot({ api, config: SMOKE({ liveSmokeMaxPostReads: 45 }), over: { headroom: 30 } }); h.rt.hydrate(arr);
  assert.equal((await h.rt.start()).reason, 'SMOKE_RUN_CONFIG_MISMATCH', 'a different reserve is a different envelope too');
  const ok = await proc({ api, arr }); assert.equal(ok.first.ok, true, 'the original envelope still resumes'); assert.equal(ok.rt.status().smoke.conservativeDeliveredForRun, 3); ok.rt.stop();
});

test('SMOKE-DUR-5 (§16 / PASS 1). the ACTIVE event cannot become durable: zero stream requests; a restart finds no run and the same RUN_ID may retry activation', async () => {
  const api = fakeXApi(); const arr = [];
  const j = memJournal(arr, { failAppends: () => true });
  const { rt } = boot({ api }); rt.hydrate([]);
  assert.equal((await rt.start()).reason, 'SMOKE_ACTIVATION_PENDING');
  const s = await settle(rt, j); assert.equal(s.ok, false); assert.equal(arr.length, 0);
  assert.equal((await rt.start()).reason, 'SMOKE_ACTIVATION_PENDING'); assert.equal(api.streams(), 0, 'no paid stream without a durable ACTIVE run');
  rt.stop(); // crash
  const B = await proc({ api, arr }); assert.equal(B.first.reason, 'SMOKE_ACTIVATION_PENDING'); assert.equal(B.start.ok, true);
  assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).length, 1, 'one activation identity'); assert.equal(api.streams(), 1); B.rt.stop();
});

test('SMOKE-DUR-6 (§17 / PASS 2). crash immediately after the ACTIVE commit, before the stream opens: the same run resumes from 0 with ONE activation identity', async () => {
  const api = fakeXApi(); const arr = [];
  const { rt } = boot({ api }); rt.hydrate([]);
  assert.equal((await rt.start()).reason, 'SMOKE_ACTIVATION_PENDING'); assert.equal((await settle(rt, memJournal(arr))).ok, true);
  rt.stop(); // crash before connect
  assert.equal(api.streams(), 0);
  const B = await proc({ api, arr });
  assert.equal(B.first.ok, true, 'resumes the durable ACTIVE run'); assert.equal(api.streams(), 1);
  assert.equal(B.rt.status().smoke.conservativeDeliveredForRun, 0); assert.equal(B.rt.status().smoke.resumedAfterRestart, true);
  assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).length, 1); assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE)[0].status, 'ACTIVE');
  assert.equal(api.state.calls.filter((c) => c.path === '/2/usage/tweets').length, 2, 'the restart re-ran the mandatory usage preflight');
  B.rt.stop();
});

test('SMOKE-DUR-7 (§19/§20 / PASS 7). server project usage ahead of the local durable run delta: the safer/higher delta wins (lost in-memory reads are never free)', async () => {
  const api = fakeXApi({ projectUsage: 100 }); const arr = []; const cfg = SMOKE({ liveSmokeTargetPostReads: 20, liveSmokeMaxPostReads: 45 });
  const A = await proc({ api, arr, config: cfg }); await tick(); await deliver(api, 1, 8); await settle(A.rt, A.j); A.rt.stop();
  api.state.projectUsage = 111; // 11 reads billed since the activation baseline of 100 (3 of them never became durable locally)
  const B = await proc({ api, arr, config: cfg });
  assert.equal(B.first.ok, true);
  const st = B.rt.status().smoke;
  assert.equal(st.serverDeltaForRun, 11); assert.equal(st.localDeltaForRun, 11, 'the 3 lost reads were adopted into the conservative meter'); assert.equal(st.conservativeDeliveredForRun, 11, 'max(local, server)'); assert.equal(st.targetRemaining, 9);
  assert.equal(B.rt.status().meter.deliveredPostReads, 11, 'the daily meter (and every cap) now counts the lost reads too');
  await deliver(api, 9, 17);
  assert.equal(B.rt.status().state, 'SMOKE_COMPLETE'); assert.equal(B.rt.status().smoke.terminalPending.deliveredPostReadsForRun, 20, '11 conservative + 9 delivered');
  assert.equal((await settle(B.rt, B.j)).ok, true); assert.equal(replaySocialHistory(arr).ok, true);
  assert.equal(ofType(arr, X_METER_EVENT_TYPE).at(-1).deliveredPostReads, 20, 'the durable meter carries the adopted reads');
  // the run-1 target with exactly the server delta: an ALREADY-met target completes at start without any stream
  const api3 = fakeXApi({ projectUsage: 100 }); const arr3 = [];
  const E = await proc({ api: api3, arr: arr3 }); await tick(); await deliver(api3, 1, 8); await settle(E.rt, E.j); E.rt.stop();
  api3.state.projectUsage = 112;
  const F = await proc({ api: api3, arr: arr3 });
  assert.equal(F.first.reason, 'SMOKE_TARGET_REACHED'); assert.equal(api3.streams(), 1, 'no new stream: the server says the target is already met'); assert.equal(F.rt.status().smoke.terminalPending.deliveredPostReadsForRun, 12);
  assert.equal((await settle(F.rt, F.j)).ok, true); assert.equal(ofType(arr3, X_SMOKE_EVENT_TYPE).at(-1).status, 'COMPLETE');
  // a server usage RESET across the run invalidates the comparison: fail closed
  const api2 = fakeXApi({ projectUsage: 500 }); const arr2 = [];
  const C = await proc({ api: api2, arr: arr2 }); await tick(); await deliver(api2, 1, 2); await settle(C.rt, C.j); C.rt.stop();
  api2.state.projectUsage = 40;
  const D = await proc({ api: api2, arr: arr2 });
  assert.equal(D.first.reason, 'SMOKE_USAGE_RESET'); assert.equal(api2.streams(), 1); assert.equal(D.rt.status().state, 'SMOKE_ABORTED');
  assert.equal((await settle(D.rt, D.j)).ok, true); assert.equal(ofType(arr2, X_SMOKE_EVENT_TYPE).at(-1).status, 'ABORTED'); assert.equal(ofType(arr2, X_SMOKE_EVENT_TYPE).at(-1).terminalReason, 'SMOKE_USAGE_RESET');
  assert.equal((await D.rt.start()).reason, 'SMOKE_RUN_ALREADY_TERMINAL');
});

test('SMOKE-DUR-8 (§21 / PASS 5). a durable HEADROOM_OVERRUN terminal: the same RUN_ID can never reconnect', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) }); await tick();
  let chunk = ''; for (let i = 1; i <= 30; i++) chunk += postLine(i); api.last().push(chunk); await tick();
  assert.equal(A.rt.status().state, 'SMOKE_HEADROOM_OVERRUN'); assert.equal(A.rt.status().smoke.overrunPosts, 4);
  assert.equal((await settle(A.rt, A.j)).ok, true);
  const term = ofType(arr, X_SMOKE_EVENT_TYPE)[1];
  assert.equal(term.status, 'HEADROOM_OVERRUN'); assert.equal(term.terminalReason, 'SMOKE_HEADROOM_OVERRUN'); assert.equal(term.deliveredPostReadsForRun, 30); assert.equal(term.overrunPosts, 4); assert.equal(validateXSmokeEvent(term), null);
  A.rt.stop();
  const B = await proc({ api, arr, config: SMOKE({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) });
  assert.equal(B.first.reason, 'SMOKE_RUN_ALREADY_TERMINAL'); assert.ok(/HEADROOM_OVERRUN/.test(B.first.detail)); assert.equal(api.streams(), 1); assert.equal(B.rt.status().state, 'SMOKE_HEADROOM_OVERRUN');
  assert.equal(B.rt.status().smoke.overrunPosts, 4, 'the exact overrun survives restart');
});

test('SMOKE-DUR-9 (§9). the UTC day changes mid-smoke: SMOKE_PERIOD_ROLLOVER, durable ABORTED, no counter reset, no silent continuation, new RUN_ID required', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); await tick(); await deliver(api, 1, 4); await settle(A.rt, A.j); A.rt.stop();
  const B = await proc({ api, arr, nowMs: NEXT_DAY });
  assert.equal(B.first.reason, 'SMOKE_PERIOD_ROLLOVER'); assert.equal(api.streams(), 1); assert.equal(B.rt.status().state, 'SMOKE_ABORTED');
  assert.equal((await settle(B.rt, B.j)).ok, true);
  const term = ofType(arr, X_SMOKE_EVENT_TYPE).at(-1); assert.equal(term.status, 'ABORTED'); assert.equal(term.terminalReason, 'SMOKE_PERIOD_ROLLOVER'); assert.equal(term.deliveredPostReadsForRun, 4, 'the run count is preserved, not reset');
  assert.equal((await B.rt.start()).reason, 'SMOKE_RUN_ALREADY_TERMINAL'); assert.equal(api.streams(), 1);
  // in-process rollover during an ACTIVE stream stops at the chunk end with the same reason
  const api2 = fakeXApi(); const arr2 = []; WALL = Date.parse('2026-09-06T23:59:59.900Z');
  const C = await proc({ api: api2, arr: arr2 }); await tick();
  C.clock.ms = NEXT_DAY; api2.last().push(postLine(1)); await tick();
  assert.equal(C.rt.status().state, 'SMOKE_ABORTED'); assert.equal(C.rt.status().lastStopReason, 'SMOKE_PERIOD_ROLLOVER'); assert.equal(api2.last().reads, 1);
  assert.equal(C.rt.status().meter.deliveredPostReads, 1, 'the Post that arrived after midnight is still metered');
  assert.equal((await settle(C.rt, C.j)).ok, true);
  assert.equal(ofType(arr2, X_SMOKE_EVENT_TYPE).at(-1).terminalReason, 'SMOKE_PERIOD_ROLLOVER'); assert.equal(ofType(arr2, X_GAP_EVENT_TYPE).at(-1).reason, 'SMOKE_PERIOD_ROLLOVER');
  assert.equal((await C.rt.start()).reason, 'SMOKE_RUN_ALREADY_TERMINAL'); C.rt.stop();
  const N = await proc({ api: api2, arr: arr2, config: SMOKE({ liveSmokeRunId: RUN2 }), nowMs: NEXT_DAY + 1000 });
  assert.equal(N.first.reason, 'SMOKE_ACTIVATION_PENDING'); assert.equal(N.start.ok, true, 'a new run ID is the only path forward'); assert.equal(api2.streams(), 2); N.rt.stop();
});

test('SMOKE-DUR-10 (§14). the verified rule-set hash differs from the run\'s activation hash after restart: SMOKE_RUN_RULESET_MISMATCH, durable ABORTED, no paid stream', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); await tick(); await deliver(api, 1, 2); await settle(A.rt, A.j); A.rt.stop();
  const B = await proc({ api, arr, universe: ['BTC', 'ETH', 'SOL', 'DOGE'] });
  assert.equal(B.first.reason, 'SMOKE_RUN_RULESET_MISMATCH'); assert.equal(api.streams(), 1); assert.ok(/new operator run ID/.test(B.first.detail));
  assert.equal((await settle(B.rt, B.j)).ok, true);
  const term = ofType(arr, X_SMOKE_EVENT_TYPE).at(-1); assert.equal(term.status, 'ABORTED'); assert.equal(term.terminalReason, 'SMOKE_RUN_RULESET_MISMATCH'); assert.equal(term.deliveredPostReadsForRun, 2);
  assert.equal(ofType(arr, X_RULESET_EVENT_TYPE).length, 2, 'the new rule set activated its own coverage epoch');
  assert.equal((await B.rt.start()).reason, 'SMOKE_RUN_ALREADY_TERMINAL');
  const C = await proc({ api, arr, config: SMOKE({ liveSmokeRunId: RUN2 }), universe: ['BTC', 'ETH', 'SOL', 'DOGE'] });
  assert.equal(C.start.ok, true, `a NEW run ID authorizes a smoke against the new surface: ${JSON.stringify(C.start)}`); assert.equal(api.streams(), 2); C.rt.stop();
});

test('SMOKE-PRICING (§15). the pinned unit price differs from the run\'s activation price: SMOKE_RUN_PRICING_CHANGED, durable ABORTED, new RUN_ID required', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); await tick(); await deliver(api, 1, 1); await settle(A.rt, A.j); A.rt.stop();
  const repriced = { ...X_OFFICIAL, pricing: { ...X_OFFICIAL.pricing, postReadUsd: 0.006 } };
  const b = boot({ api, over: { provider: repriced } }); b.rt.hydrate(arr);
  const r = await b.rt.start();
  assert.equal(r.reason, 'SMOKE_RUN_PRICING_CHANGED'); assert.equal(api.streams(), 1); assert.equal(b.rt.status().state, 'SMOKE_ABORTED');
  assert.equal((await settle(b.rt, memJournal(arr))).ok, true);
  assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).at(-1).terminalReason, 'SMOKE_RUN_PRICING_CHANGED');
});

test('SMOKE-INTERRUPT (§22 / PASS 10). recorded non-target interruptions ABORT the run durably; a crash/writer loss leaves ACTIVE and resumes ONLY through full preflight + gap law', async () => {
  // credential rejection mid-run => ABORTED (AUTH_REJECTED)
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); await tick(); await deliver(api, 1, 2); await settle(A.rt, A.j);
  A.rt._stream().stop('operator'); // simulate transport end, then a rejected reconnect
  A.rt.stop();
  // writer loss: nothing durable moves; the run is still ACTIVE durably
  const B = await proc({ api, arr }); await tick(); await deliver(api, 3, 3);
  const n0 = arr.length; const w = await B.rt.settle({ fenceHeld: () => false, append: (e) => B.j.append(e), lookup: null });
  assert.equal(w.reason, 'WRITER_FENCE_LOST'); assert.equal(arr.length, n0); assert.equal(replaySocialHistory(arr).x.smoke.runs[RUN1].status, 'ACTIVE');
  // resume after reacquisition within the safe gap: preflight re-run, run count from durable truth (2), the in-memory 3rd read is NOT lost — the server delta covers it
  api.state.projectUsage = 103;
  const C = await proc({ api, arr });
  assert.equal(C.first.ok, true); assert.equal(api.state.calls.filter((c) => c.path === '/2/usage/tweets').length, 3);
  assert.equal(C.rt.status().smoke.conservativeDeliveredForRun, 3, 'max(local 2, server 3)'); C.rt.stop();
  // an unexplained gap (> 4 min) on resume aborts the run: no silent continuation
  const D = await proc({ api, arr, nowMs: T + 10 * 60_000 });
  assert.equal(D.first.reason, 'WITHHELD_GAP'); assert.equal(D.rt.status().state, 'WITHHELD_GAP'); assert.equal(D.rt.status().smoke.terminalPending.status, 'ABORTED'); assert.equal(D.rt.status().smoke.terminalPending.terminalReason, 'UNEXPLAINED_GAP');
  assert.equal((await settle(D.rt, D.j)).ok, true); assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).at(-1).status, 'ABORTED');
  assert.equal((await D.rt.start()).reason, 'SMOKE_RUN_ALREADY_TERMINAL'); assert.equal(api.streams(), 3);
});

test('SMOKE-SUPERSEDE (§12). a NEW run ID while a crashed run is still ACTIVE durably: the stale run is ABORTED (SMOKE_RUN_SUPERSEDED) in the same batch, before the new activation', async () => {
  const api = fakeXApi(); const arr = [];
  const A = await proc({ api, arr }); await tick(); await deliver(api, 1, 2); await settle(A.rt, A.j); A.rt.stop();
  const B = await proc({ api, arr, config: SMOKE({ liveSmokeRunId: RUN2 }) });
  assert.equal(B.start.ok, true);
  const sm = ofType(arr, X_SMOKE_EVENT_TYPE);
  assert.deepEqual(sm.map((e) => `${e.smokeRunId}:${e.status}`), [`${RUN1}:ACTIVE`, `${RUN1}:ABORTED`, `${RUN2}:ACTIVE`]);
  assert.equal(sm[1].terminalReason, 'SMOKE_RUN_SUPERSEDED'); assert.equal(sm[1].deliveredPostReadsForRun, 2);
  assert.equal(replaySocialHistory(arr).x.smoke.activeRunId, RUN2); B.rt.stop();
});

// =====================================================================================
// §24 normal operation, §26 replay validation, §30 zero-spend, §32 authority
// =====================================================================================
test('SMOKE-NORMAL (§24). without smoke variables, normal X operation is unchanged: no run ID needed, no smoke events, no smoke gates', async () => {
  const api = fakeXApi(); const arr = [];
  const P = await proc({ api, arr, config: CFG() });
  assert.equal(P.first.ok, true, 'no two-phase activation in normal operation'); assert.equal(api.streams(), 1);
  await tick(); await deliver(api, 1, 3); await settle(P.rt, P.j);
  assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).length, 0); assert.equal(P.rt.status().smoke.configured, false); assert.equal(P.rt.status().smoke.smokeRunId, null);
  assert.equal(P.rt.status().state, 'ACTIVE'); P.rt.stop();
  const Q = await proc({ api, arr, config: CFG({ liveSmokeRunId: RUN1 }) });
  assert.equal(Q.first.ok, true, 'a stray run ID without TARGET/MAX is ignored'); assert.equal(ofType(arr, X_SMOKE_EVENT_TYPE).length, 0); Q.rt.stop();
});

test('SMOKE-REPLAY (§26). replay validates smoke history and fails closed on every forged or impossible sequence', async () => {
  const base = { provider: 'X_OFFICIAL', smokeRunId: RUN1, targetPostReads: 10, maxPostReads: 35, headroomPosts: 25, unitPriceUsd: 0.005, ruleSetHash: 'a'.repeat(40), coverageEpoch: 1, baselinePeriod: '2026-09-06', baselineDailyDeliveredPostReads: 0, baselineMonthlyDeliveredPostReads: 0, baselineServerProjectUsage: 100, activatedKnownAtTs: T, knownAtTs: T };
  const ruleset = { type: X_RULESET_EVENT_TYPE, ts: iso(T), sourceEventId: null, provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), ruleTags: [], ruleCount: 0, coverageEpoch: 1, activatedKnownAtTs: T, knownAtTs: T };
  const { xRuleSetEvent } = await import('../rumor2/social-settle.js');
  const rs = xRuleSetEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), ruleTags: [], coverageEpoch: 1, activatedKnownAtTs: T, knownAtTs: T }); void ruleset;
  const active = xSmokeEvent({ ...base, status: 'ACTIVE' });
  const complete = xSmokeEvent({ ...base, status: 'COMPLETE', deliveredPostReadsForRun: 10, overrunPosts: 0, terminalReason: 'SMOKE_TARGET_REACHED', completedKnownAtTs: T + 5, knownAtTs: T + 5 });
  assert.equal(validateXSmokeEvent(active), null); assert.equal(validateXSmokeEvent(complete), null);
  assert.equal(replaySocialHistory([rs, active, complete]).ok, true); assert.equal(replaySocialHistory([rs, active, complete]).x.smoke.runs[RUN1].status, 'COMPLETE');
  assert.equal(replaySocialHistory([rs, active]).x.smoke.activeRunId, RUN1);
  const bad = (events, re) => { const r = replaySocialHistory(events); assert.equal(r.ok, false); assert.ok(re.test(r.error), `${r.error} !~ ${re}`); };
  bad([rs, active, { ...active, baselineServerProjectUsage: 101 }], /altered payload/);
  bad([rs, active, xSmokeEvent({ ...base, status: 'COMPLETE', targetPostReads: 20, maxPostReads: 45, deliveredPostReadsForRun: 20, overrunPosts: 0, terminalReason: 'SMOKE_TARGET_REACHED', completedKnownAtTs: T + 5, knownAtTs: T + 5 })], /terminal targetPostReads disagrees/);
  bad([rs, complete], /terminal state before activation/);
  bad([rs, active, complete, xSmokeEvent({ ...base, status: 'ABORTED', deliveredPostReadsForRun: 10, overrunPosts: 0, terminalReason: 'WRITER_LOST', completedKnownAtTs: T + 6, knownAtTs: T + 6 })], /terminal state after terminal state/);
  bad([rs, active, xSmokeEvent({ ...base, smokeRunId: RUN2, status: 'ACTIVE' })], /still ACTIVE/);
  bad([rs, active, { ...complete, deliveredPostReadsForRun: 5, sourceEventId: complete.sourceEventId }], /COMPLETE below target/);
  bad([rs, active, { ...complete, status: 'FINISHED' }], /unknown status/);
  bad([rs, { ...active, provider: 'BLUESKY_OFFICIAL' }], /provider/);
  bad([rs, { ...active, smokeRunId: 'bad id!' }], /smokeRunId malformed/);
  bad([rs, { ...active, unitPriceUsd: 'cheap' }], /unitPriceUsd/); bad([rs, { ...active, ruleSetHash: 'zz' }], /ruleSetHash/);
  bad([rs, { ...active, baselineDailyDeliveredPostReads: 3, baselineMonthlyDeliveredPostReads: 3 }], /baseline claims reads in a period without a durable meter/);
  bad([rs, active, { ...complete, terminalReason: 'BECAUSE' }], /unknown terminal reason/);
  bad([rs, active, xSmokeEvent({ ...base, status: 'HEADROOM_OVERRUN', deliveredPostReadsForRun: 30, overrunPosts: 4, terminalReason: 'SMOKE_HEADROOM_OVERRUN', completedKnownAtTs: T + 5, knownAtTs: T + 5 })], /HEADROOM_OVERRUN counts disagree/);
  bad([rs, xSmokeEvent({ ...base, status: 'ACTIVE', coverageEpoch: 2 })], /outside the active coverage epoch/);
  bad([rs, active, xSmokeEvent({ ...base, status: 'ABORTED', deliveredPostReadsForRun: 1, overrunPosts: 0, terminalReason: 'SMOKE_TARGET_REACHED', completedKnownAtTs: T + 5, knownAtTs: T + 5 })], /ABORTED with a completion reason/);
  assert.ok(SOCIAL_EVENT_TYPES.includes(X_SMOKE_EVENT_TYPE)); assert.deepEqual([...X_SMOKE_STATUSES], ['ACTIVE', 'COMPLETE', 'HEADROOM_OVERRUN', 'ABORTED']);
  for (const s of ['SMOKE_ACTIVATING', 'SMOKE_COMPLETE', 'SMOKE_HEADROOM_OVERRUN', 'SMOKE_ABORTED']) assert.ok(X_RUNTIME_STATES.includes(s));
  assert.equal(X_IN_FLIGHT_POST_HEADROOM, 25);
});

test('SMOKE-ZERO-SPEND + AUTHORITY (§30/§32). every incomplete authorization yields zero paid stream requests; smoke events carry operational truth only', async () => {
  const api = fakeXApi();
  const cases = [
    [SMOKE({ bearer: null }), 'CREDENTIAL_MISSING'], [SMOKE({ liveSmokeRunId: null }), 'SMOKE_RUN_ID_REQUIRED'], [SMOKE({ maxEstimatedDailyUsd: null }), 'BUDGET_NOT_CONFIGURED'],
    [SMOKE({ liveSmokeTargetPostReads: null }), 'SMOKE_BUDGET_INCOMPLETE'], [SMOKE({ liveSmokeTargetPostReads: 20, liveSmokeMaxPostReads: 20 }), 'SMOKE_BUDGET_TOO_SMALL'],
  ];
  for (const [cfg, reason] of cases) { const { rt } = boot({ api, config: cfg }); rt.hydrate([]); assert.equal((await rt.start()).reason, reason); }
  assert.equal(api.state.calls.length, 0); assert.equal(api.streams(), 0);
  const arr = []; const P = await proc({ api, arr }); await tick(); await deliver(api, 1, 10); await settle(P.rt, P.j);
  for (const e of ofType(arr, X_SMOKE_EVENT_TYPE)) for (const k of ['claim', 'propositionId', 'attention', 'hyped', 'eligibility', 'score', 'size', 'order', 'execution', 'model', 'bearer']) assert.ok(!(k in e), `no ${k}`);
  assert.ok(!JSON.stringify(arr).includes(BEARER)); assert.equal(P.rt.status().authority, 'NONE');
});
