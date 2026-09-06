// SOCIAL-2B — the X operational runtime: default-zero gates, the bounded HTTP
// streaming transport, the conservative bill-at-the-wire cost governor with
// pinned headroom, usage/credit preflight, Serpent-owned rule reconciliation,
// atomic evidence+meter+progress settlement, the gap/backfill law, writer loss,
// and durable restart — all against a FAKE X API (no network, no spend) and
// real PostgreSQL for the durable passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSocialFilter } from '../rumor2/social.js';
import { createXRuntime, xGate, xConfigFromEnv, X_IN_FLIGHT_POST_HEADROOM, X_SAFE_GAP_MS } from '../rumor2/x-runtime.js';
import { startXStream } from '../rumor2/x-stream.js';
import { X_OFFICIAL, xRuleTag, compileXRuleManifest, isSerpentTag } from '../rumor2/providers/x-official.js';
import { SOCIAL_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_GAP_EVENT_TYPE, replaySocialHistory, validateXMeterEvent, validateXProgressEvent, validateXRuleSetEvent, validateXGapEvent, xMeterEvent, xProgressEvent, xRuleSetEvent, xGapEvent } from '../rumor2/social-settle.js';
import { memJournal } from './helpers/rumor2-journal.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-xrt-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const T = Date.parse('2026-09-06T12:00:00Z');
const iso = (m) => new Date(m).toISOString();
const BEARER = 'test-bearer-value-never-logged';
const CFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeMaxPostReads: null, priorityAccounts: [], propagationFocus: [], ...over });
const UNIVERSE = ['BTC', 'ETH', 'SOL'];
const FILTER = buildSocialFilter({ terms: ['BTC', 'ETH', 'SOL'] });
const postLine = (id, text = '$BTC listing', over = {}) => JSON.stringify({ data: { id: String(id), text, author_id: '42', created_at: iso(T - 5_000), edit_history_tweet_ids: [String(id)], conversation_id: String(id), public_metrics: { like_count: 1 }, ...over }, matching_rules: [{ id: 'r1', tag: xRuleTag('origin', '($BTC OR #BTC OR $ETH OR #ETH OR $SOL OR #SOL) -is:retweet') }] }) + '\r\n';
const KEEPALIVE = '\r\n';

// ---- fake X HTTP API + streaming body -------------------------------------------
function fakeStream() {
  let ctrl; const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  return { body, push: (text) => ctrl.enqueue(enc.encode(text)), close: () => { try { ctrl.close(); } catch { /* closed */ } }, error: (e) => { try { ctrl.error(e); } catch { /* closed */ } } };
}
function fakeXApi({ usage = { project_usage: '100', project_cap: '3000000', cap_reset_day: 1, daily_project_usage: [] }, usageStatus = 200, credits = { free_balance: 0, prepaid_balance: 50, total_balance: 50 }, creditsStatus = 200, rules = [], dryRunInvalid = 0, streamStatus = 200, counts = null } = {}) {
  const state = { rules: rules.map((r, i) => ({ id: r.id ?? `u${i}`, value: r.value, tag: r.tag })), nextId: 1000, streams: [], calls: [], mutations: [] };
  const res = (status, json = null, body = null) => ({ status, json: async () => json, body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push({ path: u.pathname, method: opts.method ?? 'GET', dry: u.searchParams.get('dry_run') === 'true', auth: opts.headers?.Authorization });
    assert.equal(u.host, 'api.x.com', 'only the approved host'); assert.equal(opts.headers?.Authorization, `Bearer ${BEARER}`, 'bearer only in the Authorization header');
    if (u.pathname === '/2/usage/tweets') return res(usageStatus, usageStatus === 200 ? { data: usage } : { errors: [{ title: 'x' }] });
    if (u.pathname === '/2/usage/credits') return res(creditsStatus, creditsStatus === 200 ? { data: credits } : { errors: [{ title: 'forbidden' }] });
    if (u.pathname === '/2/tweets/search/stream/rules/counts') return counts ? res(200, { data: counts }) : res(404, null);
    if (u.pathname === '/2/tweets/search/stream/rules') {
      if ((opts.method ?? 'GET') === 'GET') return res(200, { data: state.rules.map((r) => ({ ...r })) });
      const bodyObj = JSON.parse(opts.body);
      if (u.searchParams.get('dry_run') === 'true') return res(200, { meta: { summary: { valid: (bodyObj.add ?? []).length - dryRunInvalid, invalid: dryRunInvalid } }, ...(dryRunInvalid ? { errors: [{ title: 'invalid rule' }] } : {}) });
      state.mutations.push(bodyObj);
      if (bodyObj.add) { for (const r of bodyObj.add) state.rules.push({ id: String(state.nextId++), value: r.value, tag: r.tag }); return res(201, { data: bodyObj.add }); }
      if (bodyObj.delete) { state.rules = state.rules.filter((r) => !bodyObj.delete.ids.includes(r.id)); return res(200, { meta: {} }); }
      return res(400, null);
    }
    if (u.pathname === '/2/tweets/search/stream') {
      if (streamStatus !== 200) return res(streamStatus, { title: 'nope' });
      const s = fakeStream(); s.url = url; s.signal = opts.signal;
      opts.signal?.addEventListener('abort', () => s.error(new Error('aborted')));
      state.streams.push(s);
      return { status: 200, body: s.body, json: async () => null };
    }
    return res(404, null);
  };
  return { fetchImpl, state };
}
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const fakeTimers = () => { const q = []; let id = 1; return { setTimeoutImpl: (cb, ms) => { q.push({ id, cb, ms }); return id++; }, clearTimeoutImpl: (t) => { const i = q.findIndex((x) => x.id === t); if (i >= 0) q.splice(i, 1); }, runAll: () => { let g = 0; while (q.length && g++ < 100) q.shift().cb(); }, pending: () => q.length }; };
const boot = ({ api, config = CFG(), nowMs = T, universe = UNIVERSE, over = {} } = {}) => {
  const clock = { ms: nowMs }; const timers = fakeTimers();
  const rt = createXRuntime({ config, filter: FILTER, universe, aliases: ['bitcoin'], now: () => clock.ms, fetchImpl: api.fetchImpl, log: () => {}, streamOptions: { setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl }, ...over });
  return { rt, clock, timers };
};
const settle = (rt, j, fenceHeld = () => true) => rt.settle({ fenceHeld, append: (e) => j.append(e), lookup: j.hasEventIds ? (t, ids) => j.hasEventIds(t, ids) : null });
const ofType = (arr, t) => arr.filter((e) => e.type === t);

// ---- §8 gates: default cost is ZERO ----------------------------------------------
test('X-GATE-1 (§8). X is OFF by default; enable alone spends nothing; missing bearer/budget, zero, negative, absurd all fail closed', () => {
  assert.equal(xConfigFromEnv({}).enabled, false);
  assert.equal(xGate(xConfigFromEnv({})).reason, 'DISABLED');
  assert.equal(xGate(xConfigFromEnv({ RUMOR2_SOCIAL_X_ENABLED: 'true' })).reason, 'CREDENTIAL_MISSING', 'enable alone cannot start spending');
  assert.equal(xGate(xConfigFromEnv({ RUMOR2_SOCIAL_X_ENABLED: 'true', X_BEARER_TOKEN: 'b' })).reason, 'BUDGET_NOT_CONFIGURED', 'no default paid budget exists');
  assert.equal(xGate(xConfigFromEnv({ RUMOR2_SOCIAL_X_ENABLED: 'true', X_BEARER_TOKEN: 'b', RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '100' })).reason, 'BUDGET_NOT_CONFIGURED');
  const full = { RUMOR2_SOCIAL_X_ENABLED: 'true', X_BEARER_TOKEN: 'b', RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '100', RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '1000', RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: '0.5' };
  assert.equal(xGate(xConfigFromEnv(full)).ok, true);
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '0' })).reason, 'BUDGET_INVALID', 'zero budget => no paid connection');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '-5' })).reason, 'BUDGET_INVALID');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '3000001' })).reason, 'BUDGET_INVALID', 'monthly never exceeds the X self-serve cap');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '5000' })).reason, 'BUDGET_INVALID', 'daily > monthly');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: 'lots' })).reason, 'BUDGET_INVALID');
  assert.equal(xGate(xConfigFromEnv({ ...full, RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '0' })).reason, 'BUDGET_INVALID');
  const g = xGate(xConfigFromEnv(full)); assert.ok(!JSON.stringify(g).includes('b"'), 'the gate never returns the bearer value');
});

test('X-GATE-2. an unhydrated or ungated runtime never touches the API', async () => {
  const api = fakeXApi();
  const { rt } = boot({ api, config: CFG({ enabled: false }) });
  assert.equal((await rt.start()).reason, 'NOT_HYDRATED');
  rt.hydrate([]);
  assert.equal((await rt.start()).reason, 'DISABLED'); assert.equal(api.state.calls.length, 0, 'no request without the gate');
  const { rt: r2 } = boot({ api, config: CFG({ bearer: null }) }); r2.hydrate([]);
  assert.equal((await r2.start()).reason, 'CREDENTIAL_MISSING'); assert.equal(api.state.calls.length, 0);
  const { rt: r3 } = boot({ api, config: CFG({ maxEstimatedDailyUsd: null }) }); r3.hydrate([]);
  assert.equal((await r3.start()).reason, 'BUDGET_NOT_CONFIGURED'); assert.equal(api.state.calls.length, 0);
  assert.equal(r3.status().credentialPresent, true); assert.ok(!JSON.stringify(r3.status()).includes(BEARER), 'status never carries the bearer');
});

// ---- §20/§36-§38 transport --------------------------------------------------------
test('X-STREAM-1 (§20/§36). HTTP stream: Posts + blank keepalives parsed incrementally, bearer only in the header, one connection', async () => {
  const api = fakeXApi(); const timers = fakeTimers(); const lines = []; let keep = 0;
  const s = startXStream({ bearer: BEARER, fetchImpl: api.fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', onLine: (o) => lines.push(o), onKeepalive: () => { keep += 1; }, setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
  s.start(); s.start(); s.start();
  await tick();
  assert.equal(api.state.streams.length, 1, 'ONE connection only'); assert.equal(api.state.calls[0].auth, `Bearer ${BEARER}`);
  const st = api.state.streams[0];
  st.push(postLine(1)); st.push(KEEPALIVE); st.push(postLine(2).slice(0, 10)); await tick(); st.push(postLine(2).slice(10)); st.push(KEEPALIVE);
  await tick();
  assert.equal(lines.length, 2); assert.equal(keep, 2); assert.equal(s.status().linesDelivered, 2); assert.equal(s.status().keepalives, 2);
  assert.ok(!JSON.stringify(s.status()).includes(BEARER));
  s.stop(); await tick();
  assert.equal(s.status().connected, false);
});

test('X-STREAM-2 (§36). stall (no Post/keepalive for the window) => bounded reconnect; never two connections at once', async () => {
  const api = fakeXApi(); const timers = fakeTimers();
  const s = startXStream({ bearer: BEARER, fetchImpl: api.fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl, stallMs: 20_000, backoffBaseMs: 1 });
  s.start(); await tick();
  assert.equal(api.state.streams.length, 1);
  timers.runAll(); await tick(); // the stall timer fires -> abort -> reconnect scheduled
  timers.runAll(); await tick(); // the backoff fires -> reconnect
  assert.equal(api.state.streams.length, 2); assert.equal(s.status().stalls, 1); assert.equal(s.status().reconnects, 1);
  s.stop();
});

test('X-STREAM-3 (§38/§20). 401/403 stops (AUTH_REJECTED); 429 backs off; repeated 420 stops boundedly (CONNECTION_LIMIT); oversized line taints and reconnects', async () => {
  for (const [status, expect] of [[401, 'AUTH_REJECTED'], [403, 'AUTH_REJECTED']]) {
    const api = fakeXApi({ streamStatus: status }); const timers = fakeTimers(); const closes = [];
    const s = startXStream({ bearer: BEARER, fetchImpl: api.fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', onClose: (c) => closes.push(c), setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl });
    s.start(); await tick();
    assert.equal(s.status().stopReason, expect); assert.equal(closes[0].reason, expect); assert.equal(timers.pending(), 0, 'no reconnect scheduled after a credential rejection');
  }
  const api429 = fakeXApi({ streamStatus: 429 }); const t429 = fakeTimers();
  const s429 = startXStream({ bearer: BEARER, fetchImpl: api429.fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', setTimeoutImpl: t429.setTimeoutImpl, clearTimeoutImpl: t429.clearTimeoutImpl, rateLimitBackoffMs: 60_000 });
  s429.start(); await tick();
  assert.equal(t429.pending(), 1, 'one long backoff, no storm');
  t429.runAll(); await tick(); t429.runAll(); await tick();
  assert.equal(s429.status().stopReason, 'CONNECTION_LIMIT', 'repeated 420/429 stops boundedly'); assert.equal(t429.pending(), 0);
  const api = fakeXApi(); const timers = fakeTimers();
  const s = startXStream({ bearer: BEARER, fetchImpl: api.fetchImpl, buildUrl: () => 'https://api.x.com/2/tweets/search/stream', setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl, maxLineBytes: 200, backoffBaseMs: 1 });
  s.start(); await tick();
  api.state.streams[0].push(JSON.stringify({ data: { id: '1', text: 'x'.repeat(500) } }) + '\r\n'); await tick();
  assert.equal(s.status().oversizedLines, 1); assert.equal(s.status().connected, false, 'a tainted connection is closed so backfill can redeliver the owed line');
  s.stop();
});

// ---- §9/§49 cost governor -----------------------------------------------------------
async function liveRuntime({ config = CFG(), apiOpts = {}, nowMs = T, journalEvents = [], over = {} } = {}) {
  const api = fakeXApi(apiOpts);
  const b = boot({ api, config, nowMs, over });
  assert.equal(b.rt.hydrate(journalEvents).ok, true);
  const st = await b.rt.start();
  return { ...b, api, startResult: st, stream: () => api.state.streams[api.state.streams.length - 1] };
}

test('COST-1 (PASS 5). 100 delivered Posts, 90 filtered internally: the local billable meter reads 100, not 10', async () => {
  const { rt, api, stream } = await liveRuntime();
  await tick();
  for (let i = 1; i <= 100; i++) stream().push(postLine(i, i <= 10 ? '$BTC news' : 'unrelated chatter'));
  await tick();
  const st = rt.status();
  assert.equal(st.meter.deliveredPostReads, 100); assert.equal(st.intake.filtered, 90); assert.equal(st.intake.enqueued, 10);
  assert.equal(st.budget.estimatedUsdUsedDay, 0.5); assert.equal(st.meter.byLane.origin, 100, 'reads by Serpent rule lane');
  rt.stop();
});

test('COST-2/COST-9 (§9). backfill redelivers the same Post: metered every time (soft billing dedupe is never relied on); durable truth dedupes', async () => {
  const j = memJournal([]);
  const { rt, stream } = await liveRuntime();
  await tick();
  for (let i = 0; i < 5; i++) stream().push(postLine(7, '$BTC once')); stream().push(KEEPALIVE);
  await tick();
  assert.equal(rt.status().meter.deliveredPostReads, 5, 'five deliveries, five reads'); assert.equal(rt.status().stats.keepalives, 1, 'keepalives cost nothing');
  const r = await settle(rt, j);
  assert.equal(r.ok, true); assert.equal(r.appended, 1, 'one durable truth');
  rt.stop();
});

test('COST-4/COST-5/COST-7/COST-8 (PASS 7). server usage higher than local => the higher stands; usage unavailable/stale => no paid connection; near cap / zero credits => no paid connection', async () => {
  // usage unavailable
  let r = await liveRuntime({ apiOpts: { usageStatus: 503 } });
  assert.equal(r.startResult.reason, 'USAGE_PREFLIGHT_FAILED'); assert.equal(r.api.state.streams.length, 0, 'no paid stream on a usage failure');
  // malformed usage
  r = await liveRuntime({ apiOpts: { usage: { project_usage: 'many' } } });
  assert.equal(r.startResult.reason, 'USAGE_PREFLIGHT_FAILED'); assert.equal(r.api.state.streams.length, 0);
  // server usage exceeds local expectation: the monthly allowance uses the higher observed value
  r = await liveRuntime({ config: CFG({ maxMonthlyPostReads: 500, maxDailyPostReads: 400 }), apiOpts: { usage: { project_usage: '490', project_cap: '3000000' } } });
  assert.equal(r.startResult.reason, 'BUDGET_MONTHLY', '490 observed + headroom 25 > 500 cap'); assert.equal(r.api.state.streams.length, 0);
  // platform cap nearly reached
  r = await liveRuntime({ apiOpts: { usage: { project_usage: '2999990', project_cap: '3000000' } } });
  assert.equal(r.startResult.reason, 'BUDGET_MONTHLY'); assert.equal(r.api.state.streams.length, 0);
  // credits zero
  r = await liveRuntime({ apiOpts: { credits: { free_balance: 0, prepaid_balance: 0, total_balance: 0 } } });
  assert.equal(r.startResult.reason, 'NO_CREDITS'); assert.equal(r.api.state.streams.length, 0);
  // credits endpoint unavailable for this credential: honest capability, caps still enforce, stream allowed
  r = await liveRuntime({ apiOpts: { creditsStatus: 403 } });
  assert.equal(r.startResult.ok, true); assert.equal(r.rt.status().credits.capability, 'UNAVAILABLE_FOR_CREDENTIAL'); assert.equal(r.rt.status().credits.value, null, 'never fabricated');
  r.rt.stop();
  // stale usage snapshot (restart 7h later with no fresh preflight): refused
  const late = boot({ api: fakeXApi({ usageStatus: 503 }), nowMs: T + 7 * 3_600_000 });
  late.rt.hydrate([xMeterEvent({ provider: 'X_OFFICIAL', period: '2026-09-06', deliveredPostReads: 1, monthPeriod: '2026-09', monthDeliveredPostReads: 1, unitPriceUsd: 0.005, serverUsage: { projectUsage: 1, projectCap: 3_000_000, capResetDay: 1, dailyProjectUsage: null, observedTs: T }, knownAtTs: T })]);
  assert.equal(late.rt.allowance().reason, 'USAGE_PREFLIGHT_FAILED', 'a stale snapshot is not a guess the governor may use');
});

test('COST-6 (PASS 8 / §15). headroom: the stream stops BEFORE the configured boundary; the reserve is pinned and visible', async () => {
  assert.equal(X_IN_FLIGHT_POST_HEADROOM, 25);
  const { rt, stream, api } = await liveRuntime({ config: CFG({ maxDailyPostReads: 40 }) });
  await tick();
  assert.equal(rt.status().budget.headroomPosts, 25); assert.equal(rt.status().budget.allowance.remaining, 40);
  for (let i = 1; i <= 20; i++) stream().push(postLine(i, 'x'));
  await tick();
  const st = rt.status();
  assert.equal(st.state, 'BUDGET_STOPPED'); assert.equal(st.lastStopReason, 'BUDGET_DAILY');
  assert.ok(st.meter.deliveredPostReads <= 40 - 25 + 1, `stopped with headroom: ${st.meter.deliveredPostReads} reads`);
  assert.equal(st.pendingGap.reason, 'BUDGET_DAILY', 'an explicit coverage gap is recorded');
  assert.equal(api.state.streams[0].signal.aborted, true, 'the HTTP stream was aborted');
  assert.equal((await rt.start()).reason, 'WITHHELD_GAP', 'no reconnect until the gap is durable');
  // one remaining read but the reserve requires more => no connection at all
  const one = await liveRuntime({ config: CFG({ maxDailyPostReads: 25 }) }); // remaining 25 == headroom => usable 0
  assert.equal(one.startResult.reason, 'BUDGET_DAILY'); assert.equal(one.api.state.streams.length, 0);
  rt.stop();
});

test('COST-3 (PASS 6). RESTART: the durable local meter is restored; the budget does not reset', async () => {
  const j = memJournal([]);
  const A = await liveRuntime({ config: CFG({ maxDailyPostReads: 100 }) });
  await tick();
  for (let i = 1; i <= 30; i++) A.stream().push(postLine(i, 'x'));
  await tick();
  assert.equal((await settle(A.rt, j)).ok, true);
  A.rt.stop();
  const hist = await j.read();
  const meters = ofType(hist.events, X_METER_EVENT_TYPE);
  assert.equal(meters.length, 1); assert.equal(meters[0].deliveredPostReads, 30); assert.equal(meters[0].estimatedUsd, 0.15); assert.equal(validateXMeterEvent(meters[0]), null);
  const B = await liveRuntime({ config: CFG({ maxDailyPostReads: 100 }), journalEvents: hist.events, nowMs: T + 60_000 });
  assert.equal(B.rt.status().meter.deliveredPostReads, 30, 'restored from the journal'); assert.equal(B.rt.status().budget.dailyRemainingLocal, 70);
  await tick();
  for (let i = 31; i <= 60; i++) B.stream().push(postLine(i, 'x'));
  await tick();
  assert.equal(B.rt.status().meter.deliveredPostReads, 60, 'the count continued, never reset');
  assert.equal(B.rt.status().state, 'ACTIVE');
  for (let i = 61; i <= 80; i++) B.stream().push(postLine(i, 'x'));
  await tick();
  assert.equal(B.rt.status().state, 'BUDGET_STOPPED', '100 - 25 headroom reached across the restart');
  B.rt.stop();
});

// ---- §16/§19/§51 rule reconciliation ----------------------------------------------
test('RULE-A/RULE-B/RULE-6/RULE-7 (PASS 4). 20 unrelated rules survive byte-for-byte; stale Serpent rules are removed while disconnected; the final set is verified', async () => {
  const unrelated = Array.from({ length: 20 }, (_, i) => ({ id: `other${i}`, value: `(from:someone${i})`, tag: `their-tool-${i}` }));
  const stale = { id: 'stale1', value: '($OLD OR #OLD) -is:retweet', tag: xRuleTag('origin', '($OLD OR #OLD) -is:retweet') };
  const api = fakeXApi({ rules: [...unrelated, stale] });
  const { rt } = boot({ api }); rt.hydrate([]);
  const p = await rt.preflight();
  assert.equal(p.ok, true);
  const final = api.state.rules;
  const survivors = final.filter((r) => !isSerpentTag(r.tag));
  assert.deepEqual(survivors, unrelated, 'unowned rules untouched byte-for-byte');
  assert.ok(!final.some((r) => r.id === 'stale1'), 'the stale Serpent rule was removed');
  const desired = compileXRuleManifest({ universe: UNIVERSE, aliases: ['bitcoin'] });
  assert.deepEqual(final.filter((r) => isSerpentTag(r.tag)).map((r) => r.tag).sort(), desired.rules.map((r) => r.tag).sort(), 'the final Serpent set equals the manifest exactly');
  const order = api.state.calls.filter((c) => c.path.endsWith('/rules') && c.method === 'POST').map((c) => (c.dry ? 'dry' : 'mutate'));
  assert.deepEqual(order.slice(0, 2), ['dry', 'mutate'], 'dry-run precedes any mutation');
  assert.deepEqual(api.state.mutations.map((m) => Object.keys(m)[0]), ['add', 'delete'], 'add new, then delete only stale owned');
  assert.equal(api.state.streams.length, 0, 'rules were reconciled with the stream disconnected');
  assert.equal(rt.status().pendingActivation.coverageEpoch, 1, 'a new rule set opens coverage epoch 1');
});

test('RULE-C/RULE-8 + RULE-D (§16). dry-run rejection => no mutation, no paid connection; insufficient capacity => fail closed, unowned never deleted', async () => {
  const api = fakeXApi({ dryRunInvalid: 1 });
  const { rt } = boot({ api }); rt.hydrate([]);
  const r = await rt.start();
  assert.equal(r.reason, 'RULE_RECONCILE_FAILED'); assert.match(r.detail, /dry-run/);
  assert.equal(api.state.mutations.length, 0, 'no project mutation'); assert.equal(api.state.streams.length, 0, 'no paid connection');
  const full = fakeXApi({ counts: { cap_per_project: 21 }, rules: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, value: `(from:u${i})`, tag: `t${i}` })) });
  const { rt: r2 } = boot({ api: full }); r2.hydrate([]);
  const p = await r2.start();
  assert.equal(p.reason, 'RULE_RECONCILE_FAILED'); assert.match(p.detail, /capacity/);
  assert.equal(full.state.rules.length, 20, 'no unrelated rule was deleted to make room'); assert.equal(full.state.mutations.length, 0); assert.equal(full.state.streams.length, 0);
});

// ---- §30 atomic settlement + §34 rule-set activation ----------------------------------
test('X-ATOMIC-1 (§30/§34). one batch = [ruleset] [evidence...] [meter] [progress]; adoption only after commit; a failed append advances nothing', async () => {
  const arr = []; let fail = false; const j = memJournal(arr, { failAppends: () => fail });
  const { rt, stream, clock } = await liveRuntime();
  await tick();
  stream().push(postLine(1, '$BTC listing')); stream().push(postLine(2, 'noise')); stream().push(KEEPALIVE);
  await tick();
  fail = true;
  const r1 = await settle(rt, j);
  assert.equal(r1.ok, false); assert.equal(arr.length, 0);
  assert.equal(rt.status().coverageEpoch, 0); assert.equal(rt.status().meter.durableDeliveredPostReads, 0); assert.equal(rt.status().progressThroughTs, null, 'nothing adopted');
  assert.equal(rt.status().pendingBatch.events, 4, 'ruleset + 1 evidence + meter + progress retained whole');
  fail = false;
  const r2 = await settle(rt, j);
  assert.equal(r2.ok, true); assert.equal(r2.appended, 1);
  assert.deepEqual(arr.map((e) => e.type), [X_RULESET_EVENT_TYPE, SOCIAL_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE], 'authoritative order');
  assert.equal(validateXRuleSetEvent(arr[0]), null); assert.equal(validateXMeterEvent(arr[2]), null); assert.equal(validateXProgressEvent(arr[3]), null);
  assert.equal(arr[0].coverageEpoch, 1); assert.equal(arr[0].activatedKnownAtTs, T, 'activation is point-in-time (now), never backdated');
  assert.equal(arr[2].deliveredPostReads, 2); assert.equal(arr[3].throughKnownAtTs, clock.ms, 'progress through the last receipt once every line is terminal');
  assert.equal(arr[3].ruleSetHash, arr[0].ruleSetHash); assert.equal(arr[1].ingressTags.length, 1);
  const st = rt.status();
  assert.equal(st.coverageEpoch, 1); assert.equal(st.meter.durableDeliveredPostReads, 2); assert.equal(st.progressThroughTs, clock.ms);
  // replay rebuilds the same durable X state
  const rp = replaySocialHistory(arr);
  assert.equal(rp.ok, true); assert.equal(rp.x.coverageEpoch, 1); assert.equal(rp.x.meter.deliveredPostReads, 2); assert.equal(rp.x.progressThroughTs, clock.ms);
  rt.stop();
});

test('X-PROGRESS (§29). progress never outruns unsettled Posts: with a queued Post the watermark stays before its acquisition', async () => {
  const arr = []; const j = memJournal(arr);
  const { rt, stream, clock } = await liveRuntime({ over: { maxDrain: 1 } });
  await tick();
  stream().push(postLine(1, '$BTC a')); await tick(); clock.ms += 1_000; stream().push(postLine(2, '$ETH b')); await tick(); clock.ms += 1_000; stream().push(KEEPALIVE); await tick();
  const r = await settle(rt, j); // drains ONE of the two
  assert.equal(r.appended, 1);
  const prog = ofType(arr, X_PROGRESS_EVENT_TYPE);
  assert.equal(prog.length, 1); assert.equal(prog[0].throughKnownAtTs, T + 1_000 - 1, 'watermark = oldest still-queued acquisition - 1');
  const r2 = await settle(rt, j);
  assert.equal(r2.appended, 1);
  assert.equal(ofType(arr, X_PROGRESS_EVENT_TYPE)[1].throughKnownAtTs, clock.ms, 'once everything is terminal, progress reaches the last receipt');
  rt.stop();
});

// ---- §31-§33 recovery law ----------------------------------------------------------------
test('REC-3 (PASS 11 / §31). restart after 3 minutes: reconnect with backfill_minutes=5; overlap deduped; every backfilled Post still metered', async () => {
  const arr = []; const j = memJournal(arr);
  const A = await liveRuntime(); await tick();
  A.stream().push(postLine(1, '$BTC a')); await tick();
  assert.equal((await settle(A.rt, j)).ok, true); A.rt.stop();
  const B = await liveRuntime({ journalEvents: arr, nowMs: T + 3 * 60_000 });
  assert.equal(B.startResult.backfillMinutes, 5); await tick();
  assert.ok(B.stream().url.endsWith('backfill_minutes=5'));
  B.stream().push(postLine(1, '$BTC a')); B.stream().push(postLine(2, '$BTC b')); await tick();
  assert.equal(B.rt.status().meter.deliveredPostReads, 3, '1 before + 2 backfilled (the duplicate is metered again)');
  assert.equal(B.rt._intake().stats().durableDeduped, 1, 'the overlap is durable-deduped');
  const r = await settle(B.rt, j); assert.equal(r.appended, 1);
  assert.equal(ofType(arr, SOCIAL_EVENT_TYPE).length, 2); assert.equal(ofType(arr, X_RULESET_EVENT_TYPE).length, 1, 'same rule set, same coverage epoch — no new activation');
  B.rt.stop();
});

test('REC-4 (PASS 12 / §32). restart after an unexplained gap > 4 min: WITHHELD_GAP, an explicit gap event, a NEW coverage epoch — never silent live-tail continuity', async () => {
  const arr = []; const j = memJournal(arr);
  const A = await liveRuntime(); await tick();
  A.stream().push(postLine(1, '$BTC a')); await tick(); assert.equal((await settle(A.rt, j)).ok, true); A.rt.stop();
  assert.equal(X_SAFE_GAP_MS, 4 * 60_000);
  const B = await liveRuntime({ journalEvents: arr, nowMs: T + 10 * 60_000 });
  assert.equal(B.startResult.reason, 'WITHHELD_GAP'); assert.equal(B.rt.status().state, 'WITHHELD_GAP'); assert.equal(B.api.state.streams.length, 0, 'no stream opened');
  const r = await settle(B.rt, j);
  assert.equal(r.ok, true);
  const gaps = ofType(arr, X_GAP_EVENT_TYPE); const sets = ofType(arr, X_RULESET_EVENT_TYPE);
  assert.equal(gaps.length, 1); assert.equal(gaps[0].reason, 'UNEXPLAINED_GAP'); assert.equal(gaps[0].gapStartTs, T, 'gap starts at the last durable progress'); assert.equal(validateXGapEvent(gaps[0]), null);
  assert.equal(sets.length, 2); assert.equal(sets[1].coverageEpoch, 2); assert.equal(sets[1].activatedKnownAtTs, T + 10 * 60_000, 'the new epoch is activated now, not backdated');
  const s2 = await B.rt.start();
  assert.equal(s2.ok, true); assert.equal(s2.backfillMinutes, 0, 'live tail under the NEW epoch — explicitly, not silently');
  assert.equal(replaySocialHistory(arr).x.coverageEpoch, 2);
  B.rt.stop();
});

test('REC-5 (§33). an intentional budget stop records the gap; the next authorized period opens a new coverage epoch', async () => {
  const arr = []; const j = memJournal(arr);
  const { rt, stream, clock } = await liveRuntime({ config: CFG({ maxDailyPostReads: 30 }) });
  await tick();
  for (let i = 1; i <= 10; i++) stream().push(postLine(i, 'x'));
  await tick();
  assert.equal(rt.status().state, 'BUDGET_STOPPED');
  assert.equal((await settle(rt, j)).ok, true);
  const gap = ofType(arr, X_GAP_EVENT_TYPE)[0];
  assert.equal(gap.reason, 'BUDGET_DAILY'); assert.equal(validateXGapEvent(gap), null);
  // hours later, a new UTC day: the daily meter is fresh, the month continues; a new epoch opens
  clock.ms = Date.parse('2026-09-07T00:10:00Z');
  const B = await liveRuntime({ config: CFG({ maxDailyPostReads: 30 }), journalEvents: arr, nowMs: clock.ms });
  assert.equal(B.rt.status().meter.deliveredPostReads, 0, 'new UTC day'); assert.equal(B.rt.status().meter.monthDeliveredPostReads, 5, 'the month carries (30 cap - 25 headroom = 5 reads before the stop)');
  assert.equal(B.startResult.reason, 'WITHHELD_GAP', 'the elapsed gap is recorded before any new coverage claim');
  await settle(B.rt, j);
  assert.equal((await B.rt.start()).ok, true);
  assert.equal(replaySocialHistory(arr).x.coverageEpoch, 2);
  B.rt.stop(); rt.stop();
});

test('REC-6 (§37). queue full: the stream pauses; no progress skips the owed Post', async () => {
  const arr = []; const j = memJournal(arr);
  const { rt, stream } = await liveRuntime({ over: { intakeOptions: { maxQueue: 1 } } });
  await tick();
  stream().push(postLine(1, '$BTC a')); stream().push(postLine(2, '$BTC b')); await tick();
  assert.equal(rt.status().state, 'STANDBY'); assert.equal(rt.status().lastStopReason, 'BACKPRESSURE'); assert.equal(rt._stream().status().paused, true);
  assert.equal(rt.status().meter.deliveredPostReads, 2, 'both deliveries were metered');
  await settle(rt, j);
  assert.equal(ofType(arr, X_PROGRESS_EVENT_TYPE).length, 0, 'no progress claim while a delivered Post is owed');
  rt.stop();
});

test('REC-7 (PASS 13 / §39). writer epoch lost: the transport stops immediately; no evidence, meter, or progress mutation', async () => {
  const arr = []; const j = memJournal(arr);
  const { rt, stream, api } = await liveRuntime(); await tick();
  stream().push(postLine(1, '$BTC a')); await tick();
  const r = await settle(rt, j, () => false);
  assert.equal(r.reason, 'WRITER_FENCE_LOST'); assert.equal(arr.length, 0);
  assert.equal(rt.isActive(), false); assert.equal(api.state.streams[0].signal.aborted, true);
  assert.equal(rt.status().coverageEpoch, 0); assert.equal(rt.status().meter.durableDeliveredPostReads, 0); assert.equal(rt.status().progressThroughTs, null);
});

test('X-REPLAY (§35 crash C). forged / regressive X operational history fails closed on hydrate', () => {
  const good = xRuleSetEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), ruleTags: ['serpent:v1:origin:0123456789abcdef'], coverageEpoch: 1, activatedKnownAtTs: T, knownAtTs: T });
  const p1 = xProgressEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), coverageEpoch: 1, throughKnownAtTs: T + 10, knownAtTs: T + 10 });
  const p0 = xProgressEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), coverageEpoch: 1, throughKnownAtTs: T + 5, knownAtTs: T + 20 });
  assert.equal(replaySocialHistory([good, p1]).ok, true);
  assert.equal(replaySocialHistory([good, p1, p0]).ok, false, 'progress regression');
  assert.equal(replaySocialHistory([p1]).ok, false, 'progress outside an active epoch');
  assert.equal(replaySocialHistory([{ ...good, ruleCount: 9 }]).ok, false, 'forged ruleset');
  const m1 = xMeterEvent({ provider: 'X_OFFICIAL', period: '2026-09-06', deliveredPostReads: 10, monthPeriod: '2026-09', monthDeliveredPostReads: 10, unitPriceUsd: 0.005, knownAtTs: T });
  const m0 = xMeterEvent({ provider: 'X_OFFICIAL', period: '2026-09-06', deliveredPostReads: 5, monthPeriod: '2026-09', monthDeliveredPostReads: 5, unitPriceUsd: 0.005, knownAtTs: T + 1 });
  assert.equal(replaySocialHistory([m1, m0]).ok, false, 'meter regression');
  assert.equal(replaySocialHistory([{ ...m1, estimatedUsd: 0 }]).ok, false, 'forged estimate');
  assert.equal(replaySocialHistory([xGapEvent({ provider: 'X_OFFICIAL', ruleSetHash: 'a'.repeat(40), coverageEpoch: 1, gapStartTs: T, reason: 'BOGUS', knownAtTs: T })]).ok, false);
  const { rt } = boot({ api: fakeXApi() });
  assert.equal(rt.hydrate([good, p1, p0]).ok, false); assert.equal(rt.status().state, 'WITHHELD');
});

// ---- real PostgreSQL: REC-1/REC-2 ------------------------------------------------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('X durable passes', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  test('REC-1/REC-2 (PostgreSQL). crash before append: no progress, backfill redelivers; atomic Post+meter+progress then crash: restart restores all three', async () => {
    const SCHEMA = `xrt_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); await runMigrations(db);
      const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const mkJournal = () => rumor2JournalStore({ persistence });
      // REC-1: receipt, then crash before any append
      const jA = mkJournal(); assert.equal((await jA.acquireWriter()).ok, true);
      const A = await liveRuntime(); await tick(); A.stream().push(postLine(1, '$BTC a')); await tick();
      A.rt.stop(); await jA.releaseWriter(); // crash: nothing durable
      assert.equal((await jA.read()).events.length, 0);
      const jB = mkJournal(); assert.equal((await jB.acquireWriter()).ok, true);
      const B = await liveRuntime({ journalEvents: (await jB.read()).events, nowMs: T + 60_000 });
      assert.equal(B.startResult.backfillMinutes, 0, 'no prior coverage epoch => nothing to backfill from'); await tick();
      B.stream().push(postLine(1, '$BTC a')); await tick();
      const r = await settle(B.rt, jB); assert.equal(r.ok, true); assert.equal(r.appended, 1);
      B.rt.stop(); await jB.releaseWriter(); // REC-2: atomic batch committed, immediate crash
      const hist = (await jB.read()).events;
      assert.deepEqual(hist.map((e) => e.type), [X_RULESET_EVENT_TYPE, SOCIAL_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE]);
      const jC = mkJournal(); assert.equal((await jC.acquireWriter()).ok, true);
      const C = await liveRuntime({ journalEvents: hist, nowMs: T + 120_000 });
      const st = C.rt.status();
      assert.equal(st.coverageEpoch, 1); assert.equal(st.meter.deliveredPostReads, 1); assert.equal(st.progressThroughTs, hist[3].throughKnownAtTs, 'all three restored');
      assert.equal(C.startResult.backfillMinutes, 5, 'within the safe window => backfill'); await tick();
      C.stream().push(postLine(1, '$BTC a')); await tick();
      assert.equal(C.rt._intake().stats().durableDeduped, 1); assert.equal(C.rt.status().meter.deliveredPostReads, 2, 'the redelivery is still metered');
      const r2 = await settle(C.rt, jC); assert.equal(r2.ok, true); assert.equal(r2.appended, 0, 'no duplicate, no corruption');
      C.rt.stop(); await jC.releaseWriter();
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  });
}
