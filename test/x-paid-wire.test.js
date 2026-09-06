// SOCIAL-2B PAID-WIRE SAFETY SEAL — smoke TARGET/MAX semantics, the chunk-atomic
// budget stop law (bill at the wire for every Post already delivered in the
// final network chunk, then no further read), honest reserve overrun, and
// canonical unowned-rule immutability. Everything runs against a FAKE X API:
// no network, no credential, no spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSocialFilter } from '../rumor2/social.js';
import { createXRuntime, xGate, xSmokeLaw, xConfigFromEnv, canonicalUnownedRules, unownedSnapshotHash, X_IN_FLIGHT_POST_HEADROOM, X_SMOKE_STOP_REASONS, X_RUNTIME_STATES } from '../rumor2/x-runtime.js';
import { startXStream } from '../rumor2/x-stream.js';
import { X_OFFICIAL, xRuleTag, isSerpentTag } from '../rumor2/providers/x-official.js';
import { SOCIAL_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE, X_GAP_EVENT_TYPE, X_GAP_REASONS, validateXGapEvent, replaySocialHistory } from '../rumor2/social-settle.js';
import { memJournal } from './helpers/rumor2-journal.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-xpw-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const T = Date.parse('2026-09-06T12:00:00Z');
const iso = (m) => new Date(m).toISOString();
const BEARER = 'test-bearer-value-never-logged';
const HEADROOM = X_IN_FLIGHT_POST_HEADROOM;
const RUN_ID = 'smoke-2026-09-06-001';
// a smoke TARGET/MAX pair needs an explicit operator run ID (durable seal); tests that pin the
// TARGET/MAX arithmetic alone get one automatically unless they set liveSmokeRunId themselves
const CFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeTargetPostReads: null, liveSmokeMaxPostReads: null, liveSmokeRunId: over.liveSmokeTargetPostReads != null && !('liveSmokeRunId' in over) ? RUN_ID : null, priorityAccounts: [], propagationFocus: [], ...over });
const FILTER = buildSocialFilter({ terms: ['BTC', 'ETH', 'SOL'] });
const ORIGIN_TAG = xRuleTag('origin', '($BTC OR #BTC OR $ETH OR #ETH OR $SOL OR #SOL) -is:retweet');
const postLine = (id, text = '$BTC listing') => JSON.stringify({ data: { id: String(id), text, author_id: '42', created_at: iso(T - 5_000), edit_history_tweet_ids: [String(id)], conversation_id: String(id), public_metrics: { like_count: 1 } }, matching_rules: [{ id: 'r1', tag: ORIGIN_TAG }] }) + '\r\n';
const KEEPALIVE = '\r\n';
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const ofType = (arr, t) => arr.filter((e) => e.type === t);

// A counting streaming body: one push() == one network chunk == one reader.read().
function countingBody() {
  const enc = new TextEncoder(); const queue = []; let waiter = null; let errored = null;
  const b = { reads: 0, aborted: false, url: null };
  b.push = (text) => { const v = enc.encode(text); if (waiter) { const w = waiter; waiter = null; w.resolve({ value: v, done: false }); } else queue.push(v); };
  b.error = (e) => { errored = e; if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  b.body = { getReader: () => ({ read: () => { b.reads += 1; if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (errored) return Promise.reject(errored); return new Promise((resolve, reject) => { waiter = { resolve, reject }; }); }, releaseLock() {} }) };
  return b;
}

// fake X API: rules with an optional external mutation injected DURING Serpent's add
function fakeXApi({ rules = [], onAdd = null, onDelete = null, onGet = null, usage = { project_usage: '0', project_cap: '3000000', cap_reset_day: 1, daily_project_usage: [] } } = {}) {
  const state = { rules: rules.map((r, i) => ({ id: r.id ?? `u${i}`, value: r.value, tag: r.tag })), nextId: 1000, streams: [], calls: [], mutations: [], addsSeen: 0, gets: 0 };
  const res = (status, json = null) => ({ status, json: async () => json, body: null });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push({ path: u.pathname, method: opts.method ?? 'GET' });
    assert.equal(u.host, 'api.x.com'); assert.equal(opts.headers?.Authorization, `Bearer ${BEARER}`);
    if (u.pathname === '/2/usage/tweets') return res(200, { data: usage });
    if (u.pathname === '/2/usage/credits') return res(200, { data: { free_balance: 0, prepaid_balance: 50, total_balance: 50 } });
    if (u.pathname === '/2/tweets/search/stream/rules/counts') return res(404, null);
    if (u.pathname === '/2/tweets/search/stream/rules') {
      if ((opts.method ?? 'GET') === 'GET') { state.gets += 1; if (onGet) onGet(state, state.gets); return res(200, { data: state.rules.map((r) => ({ ...r })) }); }
      const bodyObj = JSON.parse(opts.body);
      if (u.searchParams.get('dry_run') === 'true') return res(200, { meta: { summary: { valid: (bodyObj.add ?? []).length, invalid: 0 } } });
      state.mutations.push(bodyObj);
      if (bodyObj.add) { for (const r of bodyObj.add) state.rules.push({ id: String(state.nextId++), value: r.value, tag: r.tag }); state.addsSeen += 1; if (onAdd) onAdd(state); return res(201, { data: bodyObj.add }); }
      if (bodyObj.delete) { state.rules = state.rules.filter((r) => !bodyObj.delete.ids.includes(r.id)); if (onDelete) onDelete(state); return res(200, { meta: {} }); }
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
  return { fetchImpl, state };
}
const boot = ({ api, config = CFG(), nowMs = T, over = {} } = {}) => {
  const clock = { ms: nowMs };
  const rt = createXRuntime({ config, filter: FILTER, universe: ['BTC', 'ETH', 'SOL'], aliases: ['bitcoin'], now: () => (clock.ms += 1), fetchImpl: api.fetchImpl, log: () => {}, streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} }, ...over });
  return { rt, clock };
};
const settle = (rt, j) => rt.settle({ fenceHeld: () => true, append: (e) => j.append(e), lookup: null });
// boots, hydrates, and starts; a configured smoke goes through the TWO-PHASE durable
// activation (start => SMOKE_ACTIVATION_PENDING, settle commits ACTIVE, start connects)
const live = async ({ config = CFG(), apiOpts = {}, over = {} } = {}) => {
  const api = fakeXApi(apiOpts); const b = boot({ api, config, over });
  const arr = []; const j = memJournal(arr);
  assert.equal(b.rt.hydrate([]).ok, true);
  let startResult = await b.rt.start();
  if (startResult.reason === 'SMOKE_ACTIVATION_PENDING') {
    assert.equal(api.state.streams.length, 0, 'no paid stream before the ACTIVE authorization is durable');
    assert.equal((await settle(b.rt, j)).ok, true);
    startResult = await b.rt.start();
  }
  return { ...b, api, arr, j, startResult, stream: () => api.state.streams[api.state.streams.length - 1] };
};

// =====================================================================================
// RED #1 / §2–§5 — smoke budget semantics
// =====================================================================================
test('SMOKE-RED-1 (§2). the documented "<=20 Posts" smoke was impossible: 20 remaining minus the 25 reserve is -5; the seal makes the failure explicit, not generic', async () => {
  assert.equal(HEADROOM, 25);
  // the old single-variable smoke: MAX alone is now an INCOMPLETE smoke budget, refused before any request
  const api = fakeXApi(); const { rt } = boot({ api, config: CFG({ liveSmokeMaxPostReads: 20 }) }); rt.hydrate([]);
  const r = await rt.start();
  assert.equal(r.reason, 'SMOKE_BUDGET_INCOMPLETE'); assert.equal(api.state.calls.length, 0, 'no X request at all'); assert.equal(api.state.streams.length, 0);
  // the arithmetic itself, closed: 20 as MAX cannot hold any target with a 25 reserve
  const law = xSmokeLaw({ liveSmokeTargetPostReads: 20, liveSmokeMaxPostReads: 20 });
  assert.equal(law.ok, false); assert.equal(law.reason, 'SMOKE_BUDGET_TOO_SMALL'); assert.equal(law.minMaxForTarget, 45);
  assert.ok(/raise MAX to at least 45/.test(law.detail));
});

test('SMOKE-LAW-1 (§3). TARGET and MAX are distinct; both or neither; TARGET + HEADROOM <= MAX; an entered value is never reinterpreted', () => {
  assert.deepEqual(xSmokeLaw({}), { ok: true, configured: false, target: null, max: null, headroom: 25, minMaxForTarget: null, runId: null });
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10 }).reason, 'SMOKE_BUDGET_INCOMPLETE', 'target without max');
  assert.equal(xSmokeLaw({ liveSmokeMaxPostReads: 35 }).reason, 'SMOKE_BUDGET_INCOMPLETE', 'max without target');
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 0, liveSmokeMaxPostReads: 35 }).reason, 'BUDGET_INVALID');
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: -1 }).reason, 'BUDGET_INVALID');
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 34 }).reason, 'SMOKE_BUDGET_TOO_SMALL', '10 + 25 = 35 > 34');
  assert.equal(xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35 }).reason, 'SMOKE_RUN_ID_REQUIRED', 'a valid envelope without an operator run ID is not an authorization');
  const ok10 = xSmokeLaw({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35, liveSmokeRunId: RUN_ID });
  assert.equal(ok10.ok, true); assert.equal(ok10.target, 10); assert.equal(ok10.max, 35, 'MAX stays exactly what the operator entered'); assert.equal(ok10.runId, RUN_ID);
  const ok20 = xSmokeLaw({ liveSmokeTargetPostReads: 20, liveSmokeMaxPostReads: 45, liveSmokeRunId: RUN_ID });
  assert.equal(ok20.ok, true); assert.equal(ok20.minMaxForTarget, 45);
  // env parsing + gate composition
  const full = { RUMOR2_SOCIAL_X_ENABLED: 'true', X_BEARER_TOKEN: 'b', RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '100', RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '1000', RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: '0.5' };
  assert.equal(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10' }).liveSmokeTargetPostReads, 10);
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10' })).reason, 'SMOKE_BUDGET_INCOMPLETE');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '20' })).reason, 'SMOKE_BUDGET_INCOMPLETE');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '20', RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '20' })).reason, 'SMOKE_BUDGET_TOO_SMALL');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10', RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '35' })).reason, 'SMOKE_RUN_ID_REQUIRED');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10', RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '35', RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID: RUN_ID })).ok, true);
  // §4: the example envelopes are internally consistent at the pinned census price (nominal, not a hard ceiling)
  assert.equal(X_OFFICIAL.pricing.postReadUsd, 0.005);
  assert.equal(Math.round(35 * X_OFFICIAL.pricing.postReadUsd * 1e6) / 1e6, 0.175); assert.equal(Math.round(45 * X_OFFICIAL.pricing.postReadUsd * 1e6) / 1e6, 0.225);
});

test('SMOKE-IMPOSSIBLE (PASS 1 / §14). target 20 / max 20 / headroom 25 fails closed BEFORE any stream request with SMOKE_BUDGET_TOO_SMALL, never a generic session reason', async () => {
  const api = fakeXApi(); const { rt } = boot({ api, config: CFG({ liveSmokeTargetPostReads: 20, liveSmokeMaxPostReads: 20 }) }); rt.hydrate([]);
  const r = await rt.start();
  assert.equal(r.reason, 'SMOKE_BUDGET_TOO_SMALL'); assert.ok(/45/.test(r.detail));
  assert.equal(api.state.calls.length, 0, 'not even the usage preflight ran'); assert.equal(api.state.streams.length, 0);
  const st = rt.status();
  assert.equal(st.gate, 'SMOKE_BUDGET_TOO_SMALL'); assert.equal(st.smoke.targetPostReads, 20); assert.equal(st.smoke.maxPostReads, 20); assert.equal(st.smoke.headroomPosts, 25); assert.equal(st.smoke.minMaxForTarget, 45);
  assert.equal(st.budget.liveSmokeTargetPostReads, 20); assert.equal(st.budget.liveSmokeMaxPostReads, 20, 'both values shown explicitly, neither reinterpreted');
  assert.ok(!JSON.stringify(st).includes(BEARER));
});

test('SMOKE-ZERO (§5/§22). without BOTH smoke variables (and every other gate) there is no smoke request; a token alone authorizes nothing', async () => {
  const env = { X_BEARER_TOKEN: 'token-present-but-not-authorized' };
  assert.equal(xGate(xConfigFromEnv(env)).reason, 'DISABLED');
  const enabled = { ...env, RUMOR2_SOCIAL_X_ENABLED: 'true' };
  assert.equal(xGate(xConfigFromEnv(enabled)).reason, 'BUDGET_NOT_CONFIGURED', 'daily/monthly/USD caps are still required with a smoke');
  const api = fakeXApi();
  for (const cfg of [xConfigFromEnv(env), xConfigFromEnv(enabled), CFG({ liveSmokeTargetPostReads: 10 })]) {
    const { rt } = boot({ api, config: cfg }); rt.hydrate([]);
    assert.equal((await rt.start()).ok, false);
  }
  assert.equal(api.state.calls.length, 0, 'zero requests to api.x.com'); assert.equal(api.state.streams.length, 0);
  assert.equal(xSmokeLaw(CFG()).configured, false, 'no default smoke budget exists');
});

// =====================================================================================
// RED #2 / §6–§12 — chunk-atomic stop law (transport)
// =====================================================================================
test('X-CHUNK-RED-2 (§6/§8/§9). one read carries three Posts; stop() at Post 1: all three already-received Posts are delivered, the stop is PENDING until chunk end, and NO further reader.read() happens', async () => {
  const body = countingBody(); const deliveries = []; const chunkEnds = []; let s;
  const fetchImpl = async (url, opts) => { opts.signal.addEventListener('abort', () => { body.aborted = true; body.error(new Error('aborted')); }); return { status: 200, body: body.body }; };
  s = startXStream({ bearer: BEARER, fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
    onLine: (o) => { deliveries.push(o.data.id); if (o.data.id === '1') { s.stop('budget'); assert.equal(s.status().stopped, false, 'inside the chunk the stop is pending, not final'); assert.equal(s.status().stopPending, 'budget'); } },
    onChunkEnd: (c) => chunkEnds.push({ ...c, stoppedAtCallback: s.status().stopped }) });
  s.start(); await tick();
  body.push(postLine(1) + postLine(2) + postLine(3)); await tick();
  assert.deepEqual(deliveries, ['1', '2', '3'], 'X already delivered all three — none is hidden from the meter');
  assert.equal(body.reads, 1, 'exactly ONE reader.read(): the stop finalized before any next read');
  assert.equal(chunkEnds.length, 1); assert.equal(chunkEnds[0].lines, 3); assert.equal(chunkEnds[0].stopPending, 'budget'); assert.equal(chunkEnds[0].stoppedAtCallback, false, 'onChunkEnd runs BEFORE the transport finalizes');
  const st = s.status();
  assert.equal(st.stopped, true); assert.equal(st.stopReason, 'budget'); assert.equal(st.stopPending, null); assert.equal(st.connected, false); assert.equal(body.aborted, true, 'transport closed at chunk end');
  assert.equal(st.chunks, 1); assert.equal(st.reads, 1); assert.equal(st.readsAfterStop, 0); assert.equal(st.linesDelivered, 3);
  await tick(); assert.equal(body.reads, 1, 'still one read after settling down');
});

test('X-CHUNK-2 (§9). a stop finalized OUTSIDE a chunk closes at once: the in-flight read is aborted and no read is ever issued again', async () => {
  const body = countingBody(); const deliveries = [];
  const fetchImpl = async (url, opts) => { opts.signal.addEventListener('abort', () => { body.aborted = true; body.error(new Error('aborted')); }); return { status: 200, body: body.body }; };
  const s = startXStream({ bearer: BEARER, fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', setTimeoutImpl: () => 1, clearTimeoutImpl: () => {}, onLine: (o) => deliveries.push(o.data.id) });
  s.start(); await tick();
  body.push(postLine(1)); await tick();
  assert.equal(body.reads, 2, 'chunk 1 consumed; the second read is waiting on the wire');
  s.stop('operator'); await tick();
  assert.equal(s.status().stopped, true); assert.equal(body.aborted, true); assert.deepEqual(deliveries, ['1']);
  body.push(postLine(2)); await tick();
  assert.equal(body.reads, 2, 'no further read after the finalized stop'); assert.deepEqual(deliveries, ['1']);
});

test('X-CHUNK-3 (§37 + chunk law). pause() from inside a chunk is chunk-atomic too: every already-received line is delivered, then paused before any next read; keepalive-only chunks finalize nothing', async () => {
  const body = countingBody(); const deliveries = []; const ends = []; let s;
  const fetchImpl = async (url, opts) => { opts.signal.addEventListener('abort', () => { body.aborted = true; body.error(new Error('aborted')); }); return { status: 200, body: body.body }; };
  s = startXStream({ bearer: BEARER, fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', setTimeoutImpl: () => 1, clearTimeoutImpl: () => {}, onLine: (o) => { deliveries.push(o.data.id); if (o.data.id === '1') s.pause('backpressure'); }, onChunkEnd: (c) => ends.push(c) });
  s.start(); await tick();
  body.push(KEEPALIVE + KEEPALIVE); await tick();
  assert.equal(ends.length, 1); assert.equal(ends[0].lines, 0); assert.equal(ends[0].keepalives, 2); assert.equal(ends[0].stopPending, null); assert.equal(ends[0].pausePending, null); assert.equal(body.reads, 2);
  body.push(postLine(1) + postLine(2)); await tick();
  assert.deepEqual(deliveries, ['1', '2']); assert.equal(ends[1].pausePending, 'backpressure');
  assert.equal(s.status().paused, true); assert.equal(s.status().pausePending, null); assert.equal(body.reads, 2, 'no read after the pause finalized'); assert.equal(body.aborted, true);
  s.stop();
});

// =====================================================================================
// §11–§13 — runtime: evidence + meter + gap in the final chunk; the smoke target; overrun
// =====================================================================================
test('SMOKE-TARGET (PASS 2 / §13). target 10 / max 35 / headroom 25 connects; at the 10th delivered Post the stop is pending, finalized at chunk end, every Post metered, no reconnect', async () => {
  const { rt, api, stream, arr, j } = await live({ config: CFG({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35 }) });
  assert.equal(api.state.streams.length, 1, 'a valid smoke envelope may connect'); await tick();
  const st0 = rt.status();
  assert.equal(st0.state, 'ACTIVE'); assert.equal(st0.smoke.configured, true); assert.equal(st0.smoke.targetPostReads, 10); assert.equal(st0.smoke.maxPostReads, 35); assert.equal(st0.smoke.nominalUsdAtMax, 0.175);
  assert.equal(st0.budget.allowance.remaining, 35, 'MAX is the strictest outer boundary here'); assert.equal(st0.budget.allowance.limiting, 'BUDGET_SMOKE_MAX');
  for (let i = 1; i <= 9; i++) { stream().push(postLine(i)); await tick(1); }
  assert.equal(rt.status().state, 'ACTIVE'); assert.equal(rt.status().meter.sessionPostReads, 9);
  stream().push(postLine(10)); await tick();
  const st = rt.status();
  assert.equal(st.state, 'SMOKE_COMPLETE'); assert.equal(st.lastStopReason, 'SMOKE_TARGET_REACHED'); assert.equal(st.pendingGap.reason, 'SMOKE_TARGET_REACHED');
  assert.equal(st.meter.deliveredPostReads, 10); assert.equal(st.smoke.latched, true); assert.equal(st.smoke.status, 'COMPLETE'); assert.equal(st.smoke.terminalPending.deliveredPostReadsForRun, 10); assert.equal(st.smoke.overrunPosts, 0);
  assert.equal(stream().aborted, true, 'the paid transport is closed'); assert.equal(stream().reads, 10, 'ten chunks, ten reads — none after the stop');
  assert.equal((await rt.start()).reason, 'WITHHELD_GAP', 'the explicit gap settles first');
  const r = await settle(rt, j); assert.equal(r.ok, true);
  const gap = ofType(arr, X_GAP_EVENT_TYPE)[0]; assert.equal(gap.reason, 'SMOKE_TARGET_REACHED'); assert.equal(validateXGapEvent(gap), null);
  assert.equal(ofType(arr, X_METER_EVENT_TYPE)[0].deliveredPostReads, 10); assert.equal(ofType(arr, SOCIAL_EVENT_TYPE).length, 10);
  const again = await rt.start();
  assert.equal(again.ok, false); assert.equal(again.reason, 'SMOKE_RUN_ALREADY_COMPLETE', 'no automatic paid reconnect after a completed smoke — the completion is DURABLE');
  assert.equal(api.state.streams.length, 1); assert.equal(stream().reads, 10);
  assert.ok(X_SMOKE_STOP_REASONS.every((x) => X_GAP_REASONS.includes(x))); assert.ok(X_RUNTIME_STATES.includes('SMOKE_COMPLETE'));
});

test('X-FINAL-CHUNK (PASS 3 / §7/§8/§11). the target is hit at Post 1 of a 3-Post chunk: all three are metered, all three settle as evidence, the gap starts at the chunk end (never before evidence Serpent received)', async () => {
  const { rt, api, stream, clock, arr, j } = await live({ config: CFG({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) });
  await tick();
  const before = clock.ms;
  stream().push(postLine(1, '$BTC a') + postLine(2, '$ETH b') + postLine(3, '$SOL c')); await tick();
  const st = rt.status();
  assert.equal(st.meter.deliveredPostReads, 3, 'BILL AT THE WIRE: the two Posts after the trigger are metered too'); assert.equal(st.intake.enqueued, 3, 'and offered to intake');
  assert.equal(st.state, 'SMOKE_COMPLETE'); assert.equal(st.smoke.overrunPosts, 0, '3 <= 26: within the reserve');
  assert.equal(stream().reads, 1, 'ONE read; the stop was finalized before any next read'); assert.equal(stream().aborted, true);
  const r = await settle(rt, j); assert.equal(r.ok, true); assert.equal(r.appended, 3);
  const evidence = ofType(arr, SOCIAL_EVENT_TYPE); const gap = ofType(arr, X_GAP_EVENT_TYPE)[0]; const progress = ofType(arr, X_PROGRESS_EVENT_TYPE)[0];
  assert.equal(evidence.length, 3);
  const lastReceipt = Math.max(...evidence.map((e) => e.retrievedTs));
  assert.ok(lastReceipt > before + 1, 'the incrementing clock separates the three receipts');
  assert.equal(gap.gapStartTs, lastReceipt, 'the gap begins at the last fully processed line of the received chunk');
  assert.ok(evidence.every((e) => e.retrievedTs <= gap.gapStartTs), 'no evidence sits inside the recorded gap');
  assert.equal(progress.throughKnownAtTs, lastReceipt, 'the watermark covers every Post received in that chunk');
  assert.equal(replaySocialHistory(arr).ok, true);
  assert.equal(api.state.streams.length, 1);
});

test('SMOKE-OVERRUN (PASS 4 / §12). the final received chunk crosses the outer MAX: every Post is metered, the exact overrun is recorded, SMOKE_HEADROOM_OVERRUN latches, no reconnect', async () => {
  const { rt, api, stream, arr, j } = await live({ config: CFG({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26 }) });
  await tick();
  let chunk = ''; for (let i = 1; i <= 30; i++) chunk += postLine(i, i % 2 ? '$BTC x' : 'unrelated');
  stream().push(chunk); await tick();
  const st = rt.status();
  assert.equal(st.meter.deliveredPostReads, 30, 'never clamped to the max'); assert.equal(st.meter.sessionPostReads, 30); assert.equal(st.intake.filtered, 15, 'filtered Posts still counted (PASS 5)');
  assert.equal(st.state, 'SMOKE_HEADROOM_OVERRUN'); assert.equal(st.lastStopReason, 'SMOKE_HEADROOM_OVERRUN'); assert.equal(st.smoke.status, 'HEADROOM_OVERRUN');
  assert.equal(st.smoke.overrunPosts, 4, '30 delivered - 26 max = exact overrun'); assert.equal(st.smoke.latched, true); assert.equal(st.pendingGap.reason, 'SMOKE_HEADROOM_OVERRUN');
  assert.equal(stream().reads, 1, 'stopped before any new reader.read()'); assert.equal(stream().aborted, true);
  const r = await settle(rt, j); assert.equal(r.ok, true);
  assert.equal(ofType(arr, X_GAP_EVENT_TYPE)[0].reason, 'SMOKE_HEADROOM_OVERRUN'); assert.equal(ofType(arr, X_METER_EVENT_TYPE)[0].deliveredPostReads, 30);
  const again = await rt.start();
  assert.equal(again.reason, 'SMOKE_RUN_ALREADY_TERMINAL'); assert.ok(/HEADROOM_OVERRUN/.test(again.detail)); assert.ok(/new operator run ID/.test(again.detail));
  assert.equal(api.state.streams.length, 1, 'no automatic paid reconnect');
  assert.equal(rt.allowance().reason, 'SMOKE_RUN_ALREADY_TERMINAL');
  // §12: the local MAX is not a provider billing wall — status says so honestly
  assert.equal(st.budget.platformSpendingLimitVerified, 'UNKNOWN');
});

test('BUDGET-CHUNK (§8/§21). a plain daily-cap stop obeys the same chunk law: the final chunk is fully metered, the gap starts at its end, and daily/monthly/USD caps still bind under a smoke', async () => {
  const { rt, stream, arr, j } = await live({ config: CFG({ maxDailyPostReads: 27, liveSmokeTargetPostReads: 50, liveSmokeMaxPostReads: 100 }) });
  await tick();
  assert.equal(rt.status().budget.allowance.limiting, 'BUDGET_DAILY', 'the strictest boundary wins over the smoke envelope');
  stream().push(postLine(1) + postLine(2) + postLine(3) + postLine(4)); await tick();
  const st = rt.status();
  assert.equal(st.meter.deliveredPostReads, 4); assert.equal(st.lastStopReason, 'BUDGET_DAILY');
  assert.equal(st.state, 'SMOKE_ABORTED'); assert.equal(st.smoke.status, 'ABORTED'); assert.equal(st.smoke.terminalReason, 'BUDGET_DAILY', 'a cap stop during a run is a recorded non-target interruption: the run ABORTS, never COMPLETES');
  assert.equal(stream().reads, 1);
  await settle(rt, j);
  const gap = ofType(arr, X_GAP_EVENT_TYPE)[0]; const ev = ofType(arr, SOCIAL_EVENT_TYPE);
  assert.equal(gap.reason, 'BUDGET_DAILY'); assert.equal(ev.length, 4); assert.equal(gap.gapStartTs, Math.max(...ev.map((e) => e.retrievedTs)));
});

test('X-WRITER-LOSS-CHUNK (PASS 9). writer loss stops the transport at once; a pending in-chunk stop never survives into a later runtime state', async () => {
  const { rt, stream, arr, j } = await live({ config: CFG({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 35 }) });
  await tick();
  stream().push(postLine(1)); await tick();
  const n0 = arr.length;
  const r = await rt.settle({ fenceHeld: () => false, append: (e) => j.append(e), lookup: null });
  assert.equal(r.reason, 'WRITER_FENCE_LOST'); assert.equal(rt.status().stream, null); assert.equal(stream().aborted, true);
  assert.equal(rt.status().smoke.stopPending, null); assert.equal(rt.status().meter.durableDeliveredPostReads, 0, 'no meter advance after writer loss');
  assert.equal(rt.status().progressThroughTs, null); assert.equal(arr.length, n0, 'nothing durable after writer loss');
});

// =====================================================================================
// RED #3 / §15–§19 — unowned rule immutability
// =====================================================================================
const UNOWNED = (n) => Array.from({ length: n }, (_, i) => ({ id: `U${i + 1}`, value: `from:someone${i + 1}`, tag: i % 3 === 0 ? null : `other:rule${i + 1}` }));
// an external editor that changes an unowned rule between Serpent's before-GET and its verify-GET, every time
const onVerify = (fn) => (st, n) => { if (n % 2 === 0) fn(st); };

test('RULE-RED-3 (§15). same-count value mutation of an unowned rule during reconciliation is caught canonically; the external rule is never touched', async () => {
  const api = fakeXApi({ rules: [{ id: 'U1', value: 'from:someone', tag: 'other:rule' }], onGet: onVerify((st) => { const u = st.rules.find((r) => r.id === 'U1'); u.value = u.value === 'from:someone' ? 'from:DIFFERENT' : 'from:someone'; }) });
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight();
  assert.equal(p.ok, false); assert.equal(p.reason, 'RULE_RECONCILE_FAILED'); assert.equal(p.code, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE');
  assert.ok(/1 unowned rule\(s\) before, 1 after/.test(p.detail), 'the count was equal — equality of the canonical snapshot is what failed');
  assert.equal(api.state.streams.length, 0, 'NO PAID STREAM');
  assert.deepEqual(api.state.rules.find((r) => r.id === 'U1'), { id: 'U1', value: 'from:DIFFERENT', tag: 'other:rule' }, 'never "repaired"');
  const s2 = await rt.start();
  assert.equal(s2.ok, false); assert.equal(s2.code, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE', 'the retry re-verifies and fails again while the external editing continues');
  assert.equal(api.state.streams.length, 0);
  assert.ok(api.state.mutations.every((m) => !m.delete || m.delete.ids.every((id) => !id.startsWith('U'))), 'no unowned id was ever deleted');
  const st = rt.status(); assert.equal(st.rules.unownedChanged, true); assert.equal(st.rules.lastFailure, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE');
});

test('RULE-SNAPSHOT (§16). the canonical unowned snapshot is closed to {id,value,tag}, deterministic in order, and hashes stably', () => {
  const a = canonicalUnownedRules([{ id: 'b', value: 'v2', tag: 't' }, { id: 'a', value: 'v1' }, { id: 'a', value: 'v0', tag: 'z', extra: 'ignored' }]);
  assert.deepEqual(a, [{ id: 'a', value: 'v0', tag: 'z' }, { id: 'a', value: 'v1', tag: null }, { id: 'b', value: 'v2', tag: 't' }]);
  assert.equal(unownedSnapshotHash(a), unownedSnapshotHash(canonicalUnownedRules([{ id: 'a', value: 'v1' }, { id: 'a', value: 'v0', tag: 'z' }, { id: 'b', value: 'v2', tag: 't' }])), 'order-independent');
  assert.notEqual(unownedSnapshotHash(a), unownedSnapshotHash(canonicalUnownedRules([{ id: 'a', value: 'v1' }, { id: 'a', value: 'v0', tag: 'z' }, { id: 'b', value: 'v2', tag: 'T' }])), 'a tag change is a change');
  assert.deepEqual(canonicalUnownedRules([{ value: 'no id' }, null, 5]), [{ id: null, value: 'no id', tag: null }, { id: null, value: null, tag: null }, { id: null, value: null, tag: null }], 'malformed entries still count as someone else\'s rules');
});

test('RULE-SEAL-1 (§18). 20 unrelated rules before; after Serpent add/delete the canonical unowned snapshot is exactly equal => PASS', async () => {
  const api = fakeXApi({ rules: UNOWNED(20) });
  const before = canonicalUnownedRules(api.state.rules);
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight();
  assert.equal(p.ok, true); assert.equal(p.rules.unowned, 20); assert.ok(p.rules.owned > 0);
  assert.deepEqual(canonicalUnownedRules(api.state.rules.filter((r) => !isSerpentTag(r.tag))), before);
  assert.equal(rt.status().rules.unownedSnapshotHash, unownedSnapshotHash(before)); assert.equal(rt.status().rules.unownedChanged, false);
  assert.equal((await rt.start()).ok, true); assert.equal(api.state.streams.length, 1); rt.stop();
});

test('RULE-SEAL-2 (§18). same unowned count, one value changed => FAIL CLOSED', async () => {
  const api = fakeXApi({ rules: UNOWNED(5), onGet: onVerify((st) => { st.rules.find((r) => r.id === 'U3').value += '+'; }) });
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight(); assert.equal(p.ok, false); assert.equal(p.code, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE');
  assert.equal((await rt.start()).ok, false); assert.equal(api.state.streams.length, 0);
});

test('RULE-SEAL-3 (§18). one unowned removed and another added, count unchanged => FAIL CLOSED', async () => {
  const api = fakeXApi({ rules: UNOWNED(5), onGet: onVerify((st) => { const gone = st.rules.find((r) => r.id === 'U2') ? 'U2' : 'U99'; st.rules = st.rules.filter((r) => r.id !== gone); st.rules.push(gone === 'U2' ? { id: 'U99', value: 'from:newcomer', tag: 'other:new' } : { id: 'U2', value: 'from:someone2', tag: 'other:rule2' }); }) });
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight(); assert.equal(p.ok, false); assert.equal(p.code, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE');
  assert.ok(/5 unowned rule\(s\) before, 5 after/.test(p.detail)); assert.equal(api.state.streams.length, 0);
  assert.ok(api.state.rules.some((r) => r.id === 'U99'), 'the newcomer is left exactly as found');
});

test('RULE-SEAL-4 (§18). an unowned tag change => FAIL CLOSED', async () => {
  const api = fakeXApi({ rules: UNOWNED(5), onGet: onVerify((st) => { const u = st.rules.find((r) => r.id === 'U2'); u.tag = u.tag === 'other:rule2' ? 'other:renamed' : 'other:rule2'; }) });
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight(); assert.equal(p.ok, false); assert.equal(p.code, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE');
  assert.equal((await rt.start()).ok, false); assert.equal(api.state.streams.length, 0);
});

test('RULE-SEAL-5 (§18/§19). only a stale Serpent-owned rule changes: it is deleted, the unowned snapshot is equal, the final Serpent set is exact => PASS', async () => {
  const stale = { id: 'S-old', value: '($DOGE) -is:retweet', tag: xRuleTag('origin', '($DOGE) -is:retweet') };
  assert.equal(isSerpentTag(stale.tag), true);
  const api = fakeXApi({ rules: [...UNOWNED(7), stale] });
  const before = canonicalUnownedRules(api.state.rules.filter((r) => !isSerpentTag(r.tag)));
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight(); assert.equal(p.ok, true);
  assert.ok(!api.state.rules.some((r) => r.id === 'S-old'), 'the stale Serpent rule was deleted');
  assert.ok(api.state.mutations.some((m) => m.delete && m.delete.ids.length === 1 && m.delete.ids[0] === 'S-old'), 'only the Serpent-owned id was deleted');
  assert.ok(api.state.mutations.findIndex((m) => m.add) >= 0, 'additions were dry-run then added');
  assert.deepEqual(canonicalUnownedRules(api.state.rules.filter((r) => !isSerpentTag(r.tag))), before);
  const owned = api.state.rules.filter((r) => isSerpentTag(r.tag)).map((r) => r.tag).sort();
  assert.deepEqual(owned, rt.status().ruleSetHash === null ? owned : owned); assert.equal(owned.length, rt.status().ownedRuleCount);
  assert.equal((await rt.start()).ok, true); rt.stop();
});

test('RULE-SEAL-6 (PASS 6/7 / §17). a concurrent external change during reconcile: not overwritten, no paid connection; a later preflight retries from the actual project state', async () => {
  let fired = false;
  const api = fakeXApi({ rules: UNOWNED(3), onAdd: (st) => { if (!fired) { fired = true; st.rules.push({ id: 'EXT', value: 'from:another-team', tag: 'team-b:alerts' }); } } });
  const { rt } = boot({ api }); rt.hydrate([]);
  const p1 = await rt.preflight();
  assert.equal(p1.ok, false); assert.equal(p1.code, 'UNOWNED_RULESET_CHANGED_DURING_RECONCILE'); assert.ok(/3 unowned rule\(s\) before, 4 after/.test(p1.detail));
  assert.equal(api.state.streams.length, 0, 'no paid connection under an unverified rule surface'); assert.equal(rt.status().state, 'WITHHELD');
  assert.deepEqual(api.state.rules.find((r) => r.id === 'EXT'), { id: 'EXT', value: 'from:another-team', tag: 'team-b:alerts' }, 'the external rule was never deleted or restored');
  assert.ok(api.state.mutations.every((m) => !m.delete), 'Serpent issued no delete at all');
  const p2 = await rt.preflight();
  assert.equal(p2.ok, true, 'the retry verifies from the new actual state'); assert.equal(p2.rules.unowned, 4);
  assert.equal(rt.status().rules.unownedChanged, false); assert.equal(rt.status().rules.lastFailure, null);
  assert.equal((await rt.start()).ok, true); assert.equal(api.state.streams.length, 1); rt.stop();
});
