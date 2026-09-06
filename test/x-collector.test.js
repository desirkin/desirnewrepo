// SOCIAL-2B — X inside the single-writer RUMOR collector, coexisting with the
// Bluesky ear under ONE writer authority (§39): default OFF; X + Bluesky settle
// through the same epoch-fenced journal; restore rebuilds Bluesky cursor AND X
// meter/progress/rule-set state; writer loss stops BOTH ears with no append,
// no progress, no meter advance. Real PostgreSQL; fake X API; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRumor2 } from '../rumor2/collector.js';
import { SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE, X_METER_EVENT_TYPE, X_PROGRESS_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_SMOKE_EVENT_TYPE } from '../rumor2/social-settle.js';
import { xRuleTag } from '../rumor2/providers/x-official.js';

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-xcol-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CONFIG = { universe: ['BTC', 'ETH', 'SOL'] };
const T1 = Date.parse('2026-09-06T12:00:00Z');
const C = T1 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const H = { get: () => null };
const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
const BEARER = 'test-bearer-never-logged';
const XCFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeMaxPostReads: null, priorityAccounts: [], propagationFocus: [], ...over });
const bskyCommit = (seq, text) => ({ $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:a', seq, time: iso(C), operation: 'create', collection: 'app.bsky.feed.post', rkey: `r${seq}`, cid: `cid${seq}`, record: { $type: 'app.bsky.feed.post', text, createdAt: iso(C) } } });
const xLine = (id, text) => JSON.stringify({ data: { id: String(id), text, author_id: '7', created_at: iso(C), edit_history_tweet_ids: [String(id)], conversation_id: String(id) }, matching_rules: [{ id: 'r', tag: xRuleTag('origin', '($BTC OR #BTC OR $ETH OR #ETH OR $SOL OR #SOL) -is:retweet') }] }) + '\r\n';

function fakeXApi() {
  const state = { rules: [], nextId: 1, streams: [], calls: 0 };
  const enc = new TextEncoder();
  const res = (status, json) => ({ status, json: async () => json });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); state.calls += 1;
    assert.equal(u.host, 'api.x.com'); assert.equal(opts.headers?.Authorization, `Bearer ${BEARER}`);
    if (u.pathname === '/2/usage/tweets') return res(200, { data: { project_usage: '10', project_cap: '3000000' } });
    if (u.pathname === '/2/usage/credits') return res(200, { data: { free_balance: 0, prepaid_balance: 20, total_balance: 20 } });
    if (u.pathname.endsWith('/rules/counts')) return res(404, null);
    if (u.pathname.endsWith('/rules')) {
      if ((opts.method ?? 'GET') === 'GET') return res(200, { data: state.rules.map((r) => ({ ...r })) });
      const b = JSON.parse(opts.body);
      if (u.searchParams.get('dry_run') === 'true') return res(200, { meta: { summary: { valid: (b.add ?? []).length, invalid: 0 } } });
      if (b.add) { for (const r of b.add) state.rules.push({ id: String(state.nextId++), value: r.value, tag: r.tag }); return res(201, {}); }
      if (b.delete) { state.rules = state.rules.filter((r) => !b.delete.ids.includes(r.id)); return res(200, {}); }
      return res(400, null);
    }
    let ctrl; const body = new ReadableStream({ start(c) { ctrl = c; } });
    const s = { push: (t) => ctrl.enqueue(enc.encode(t)), aborted: false, url };
    opts.signal?.addEventListener('abort', () => { s.aborted = true; try { ctrl.error(new Error('aborted')); } catch { /* closed */ } });
    state.streams.push(s);
    return { status: 200, body, json: async () => null };
  };
  return { fetchImpl, state };
}
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; h.close?.(); }, closed: false }; }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('X collector integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `xcol_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => {
    const { rows } = await admin.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`);
    for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
    return rows.length;
  };
  const waitFor = async (pred, ms = 5000) => { let w = 0; while (!pred() && w < ms) { await new Promise((r) => setTimeout(r, 50)); w += 50; } return pred(); };
  const boot = ({ checkpointStore, journal, clockMs = T1, social = {} }) => {
    seedDir();
    const clock = { ms: clockMs };
    const c = startRumor2({
      log: () => {}, config: CONFIG,
      fetchImpl: async () => mkRes(304, ''),
      now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      ...social,
    });
    return { c, clock, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;
  const ofType = (ev, t) => ev.filter((e) => e.type === t);

  test('XCOL-1 (§8/§39). X is OFF by default in the collector — no runtime, no request, no spend; Bluesky unaffected', async () => {
    await withDb(async ({ mkStores }) => {
      const api = fakeXApi();
      const b = boot({ ...mkStores(), social: { socialSocketFactory: () => fakeSocket(), socialXFetchImpl: api.fetchImpl } });
      await b.tick();
      assert.equal(b.c.status().socialX.enabled, false); assert.equal(b.c.status().socialX.state, 'DARK'); assert.equal(b.c.status().socialX.authority, 'NONE');
      assert.equal(b.c.internals.socialX, null); assert.equal(api.state.calls, 0, 'no X request without the gate');
      await b.c.stop();
    });
  });

  test('XCOL-2 (§39/§30). Bluesky + X coexist under ONE writer: both settle through the same fenced journal; the watermark covers both', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const api = fakeXApi(); const sockets = [];
      const b = boot({ ...stores, social: {
        socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
        socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } },
      } });
      await b.tick();
      assert.equal(b.c.status().writerAuthority, 'ACTIVE');
      assert.equal(sockets.length, 1, 'Bluesky opened'); assert.equal(api.state.streams.length, 1, 'X opened ONE paid stream after preflight');
      assert.equal(b.c.status().socialX.state, 'ACTIVE'); assert.equal(b.c.status().socialX.credentialPresent, true);
      assert.equal(b.c.status().socialX.smoke.configured, false, 'no default smoke budget'); assert.equal(b.c.status().socialX.smoke.headroomPosts, 25); assert.equal(b.c.status().socialX.rules.unownedChanged, false);
      assert.ok(!JSON.stringify(b.c.status()).includes(BEARER), 'status never carries the bearer');
      sockets[0].emit('open'); sockets[0].emit('message', JSON.stringify(bskyCommit(100, 'BTC is listing')));
      api.state.streams[0].push(xLine(500, '$ETH upgrade live')); api.state.streams[0].push(xLine(501, 'nothing relevant')); api.state.streams[0].push('\r\n');
      await tick();
      await b.tick();
      const ev = await hist(stores.journal);
      const soc = ofType(ev, SOCIAL_EVENT_TYPE);
      assert.deepEqual(soc.map((e) => e.provider).sort(), ['BLUESKY_OFFICIAL', 'X_OFFICIAL'], 'both ears settled evidence');
      assert.equal(ofType(ev, SOCIAL_CURSOR_EVENT_TYPE).length, 1, 'Bluesky durable cursor');
      assert.equal(ofType(ev, X_RULESET_EVENT_TYPE).length, 1); assert.equal(ofType(ev, X_METER_EVENT_TYPE)[0].deliveredPostReads, 2, 'X metered BOTH delivered Posts (one was filtered)'); assert.equal(ofType(ev, X_PROGRESS_EVENT_TYPE).length, 1);
      assert.equal(b.c.status().lastSettledEventSeq, ev.length, 'the event-root watermark covers both ears');
      const stx = b.c.status().socialX;
      assert.equal(stx.coverageEpoch, 1); assert.equal(stx.meter.durableDeliveredPostReads, 2); assert.equal(stx.budget.headroomPosts, 25); assert.equal(stx.ownedRuleCount, 2);
      assert.equal(b.c.status().activeClaims, 0, 'no claim from either social ear'); assert.equal(b.c.status().counters.sourcesObserved, 0);
      await b.c.stop();
      assert.equal(api.state.streams[0].aborted, true, 'clean shutdown closed the X stream'); assert.equal(sockets[0].closed, true);
    });
  });

  test('XCOL-3 (§39). restart restores Bluesky cursor AND X meter/progress/rule-set; X reconnects with backfill; the budget does not reset', async () => {
    await withDb(async ({ mkStores }) => {
      const s1 = mkStores(); const api = fakeXApi();
      const a = boot({ ...s1, social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [bskyCommit(100, 'BTC is listing')], socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } } } });
      await a.tick();
      api.state.streams[0].push(xLine(500, '$ETH upgrade live')); await tick(); await a.tick();
      await a.c.stop();
      const before = await hist(s1.journal);
      assert.equal(ofType(before, SOCIAL_EVENT_TYPE).length, 2);
      const s2 = mkStores();
      const b = boot({ ...s2, clockMs: a.clock.ms + 60_000, social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [bskyCommit(100, 'BTC is listing')], socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } } } });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.lifecycle, 'RESTORED'); assert.equal(st.social.durableCursor, 100, 'Bluesky cursor restored');
      assert.equal(st.socialX.coverageEpoch, 1); assert.equal(st.socialX.meter.deliveredPostReads, 1, 'X meter restored — no reset'); assert.ok(st.socialX.progressThroughTs > 0, 'X progress restored');
      assert.equal(st.socialX.ruleSetHash.length, 40);
      assert.equal(api.state.streams.length, 2); assert.ok(api.state.streams[1].url.endsWith('backfill_minutes=5'), 'within the safe window => backfill');
      assert.equal(st.social.stream.intake.durableDeduped, 1, 'the Bluesky redelivery was recognized');
      api.state.streams[1].push(xLine(500, '$ETH upgrade live')); await tick(); await b.tick();
      const after = await hist(s2.journal);
      assert.equal(ofType(after, SOCIAL_EVENT_TYPE).length, 2, 'the backfilled X Post is one durable truth');
      assert.equal(b.c.status().socialX.meter.deliveredPostReads, 2, 'but it was metered again (soft billing dedupe is never relied on)');
      assert.equal(ofType(after, X_RULESET_EVENT_TYPE).length, 1, 'same rule set => same coverage epoch');
      await b.c.stop();
    });
  });

  test('XCOL-4 (PASS 13 / §39). writer loss stops BOTH ears immediately: no append, no progress, no meter advance; reacquisition restarts both', async () => {
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores(); const api = fakeXApi(); const sockets = [];
      const b = boot({ ...stores, social: {
        socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
        socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } },
      } });
      await b.tick();
      sockets[0].emit('open'); sockets[0].emit('message', JSON.stringify(bskyCommit(100, 'BTC is listing')));
      api.state.streams[0].push(xLine(500, '$ETH live')); await tick(); await b.tick();
      const n0 = (await hist(stores.journal)).length;
      // frames arrive, then the advisory session dies before the next settle
      sockets[0].emit('message', JSON.stringify(bskyCommit(101, 'ETH news'))); api.state.streams[0].push(xLine(501, '$SOL news')); await tick();
      assert.ok((await killAdvisoryBackends(admin)) >= 1);
      assert.equal(await waitFor(() => stores.journal.writerHeld() === false), true);
      const origAcquire = stores.journal.acquireWriter; stores.journal.acquireWriter = async () => ({ ok: false, reason: 'HELD' });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.lifecycle, 'STANDBY_WRITER'); assert.equal(st.social.state, 'STANDBY'); assert.equal(st.socialX.state, 'STANDBY');
      assert.equal(sockets[0].closed, true); assert.equal(api.state.streams[0].aborted, true, 'the paid X stream was aborted');
      assert.equal((await hist(stores.journal)).length, n0, 'no stale append from either ear');
      assert.equal(st.socialX.meter.durableDeliveredPostReads, 1, 'no meter advance'); assert.equal(st.socialX.stream, null, 'no zombie X transport');
      stores.journal.acquireWriter = origAcquire;
      await b.tick();
      const st2 = b.c.status();
      assert.equal(st2.writerAuthority, 'ACTIVE'); assert.equal(st2.social.state, 'ACTIVE'); assert.equal(st2.socialX.state, 'ACTIVE');
      assert.equal(api.state.streams.length, 2, 'X reconnected after reacquisition (usage + rules re-verified)');
      await b.c.stop();
    });
  });

  test('XCOL-5 (durable smoke seal §8/§11). through the collector tick: the smoke ACTIVE authorization is durable in PostgreSQL BEFORE the paid stream opens; a restart cannot re-authorize a completed run', async () => {
    await withDb(async ({ mkStores }) => {
      const s1 = mkStores(); const api = fakeXApi();
      const smoke = XCFG({ liveSmokeTargetPostReads: 1, liveSmokeMaxPostReads: 26, liveSmokeRunId: 'smoke-2026-09-06-xcol' });
      const social = { socialXEnabled: true, socialXConfig: smoke, socialXFetchImpl: api.fetchImpl, socialXOptions: { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } } };
      const a = boot({ ...s1, social });
      await a.tick();
      assert.equal(api.state.streams.length, 0, 'tick 1: NO paid stream — the ACTIVE event is being made durable first');
      const h1 = await hist(s1.journal); const act = ofType(h1, X_SMOKE_EVENT_TYPE);
      assert.equal(act.length, 1); assert.equal(act[0].status, 'ACTIVE'); assert.equal(act[0].smokeRunId, 'smoke-2026-09-06-xcol'); assert.equal(act[0].baselineServerProjectUsage, 10, 'baseline from the fresh usage preflight');
      assert.equal(a.c.status().socialX.smoke.durableStatus, 'ACTIVE');
      await a.tick();
      assert.equal(api.state.streams.length, 1, 'tick 2: the durable authorization opens the ONE paid stream');
      api.state.streams[0].push(xLine(900, '$BTC smoke')); await tick(); await a.tick();
      const h2 = await hist(s1.journal);
      assert.equal(ofType(h2, X_SMOKE_EVENT_TYPE).at(-1).status, 'COMPLETE'); assert.equal(ofType(h2, X_SMOKE_EVENT_TYPE).at(-1).deliveredPostReadsForRun, 1);
      assert.equal(a.c.status().socialX.state, 'SMOKE_COMPLETE');
      await a.c.stop();
      const b = boot({ ...mkStores(), clockMs: a.clock.ms + 30_000, social });
      await b.tick(); await b.tick();
      assert.equal(b.c.status().socialX.smoke.durableStatus, 'COMPLETE'); assert.equal(b.c.status().socialX.lastStopReason, 'SMOKE_RUN_ALREADY_COMPLETE');
      assert.equal(api.state.streams.length, 1, 'restart: ZERO new paid streams for the completed run');
      await b.c.stop();
    });
  });
}
