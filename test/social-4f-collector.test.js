// SOCIAL-4F — REAL PATHS through the production composition seam (H/J/L/M/N/D/O): the actual
// startRumor2 collector factories with an INJECTED broad survey snapshot, fake sockets, a fake X
// API, and real PostgreSQL. A non-major Bluesky frame becomes durable evidence under a real writer
// epoch behind a durable scope activation; restart restores scope + cursor; crash / writer-loss /
// failed-lookup postures hold; paid X targets come only from the explicit verified scope (zero
// spend otherwise); status separates discovery, local admission, paid watch, deep observation,
// and legacy permission; catalog admission never leaks into trade permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAdvisoryHolders } from './helpers/pg-fence.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRumor2 } from '../rumor2/collector.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_EVENT_V2_TYPE, SOCIAL_OBSERVATION_TYPES, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, X_RULESET_EVENT_TYPE, X_METER_EVENT_TYPE, X_SMOKE_EVENT_TYPE } from '../rumor2/social-settle.js';
import { socialScopeAt } from '../rumor2/social-scope.js';
import { xRuleTag, isSerpentTag } from '../rumor2/providers/x-official.js';
import { loadConfig } from '../lib/config.js';

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-4fcol-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const T1 = Date.parse('2026-09-07T12:00:00Z');
const C = T1 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const H = { get: () => null };
const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
const BEARER = 'test-bearer-never-logged-4f';
const XCFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeMaxPostReads: null, priorityAccounts: [], propagationFocus: [], ...over });
const bskyCommit = (seq, text, { rkey = `r${seq}` } = {}) => ({ $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:a', seq, time: iso(C), operation: 'create', collection: 'app.bsky.feed.post', rkey, cid: `cid${seq}`, record: { $type: 'app.bsky.feed.post', text, createdAt: iso(C) } } });
const xLine = (id, text, tagValue = '($ZQQ7 OR #ZQQ7) -is:retweet') => JSON.stringify({ data: { id: String(id), text, author_id: '7', created_at: iso(C), edit_history_tweet_ids: [String(id)], conversation_id: String(id) }, matching_rules: [{ id: 'r', tag: xRuleTag('origin', tagValue) }] }) + '\r\n';
function fakeXApi({ unowned = [] } = {}) {
  const state = { rules: unowned.map((r, i) => ({ id: `u${i}`, value: r.value, tag: r.tag })), nextId: 1, streams: [], calls: 0, paths: [] };
  const enc = new TextEncoder();
  const res = (status, json) => ({ status, json: async () => json });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); state.calls += 1; state.paths.push(u.pathname);
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
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// the synthetic broad venue: the 5 seeds + 120 generated non-majors (+ a digit-prefixed one)
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const synth = (i) => `Z${i.toString(36).toUpperCase().padStart(3, 'Q')}`;
function venue({ nonMajors = 120, extra = {}, drop = [] } = {}) {
  const out = { XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' }, XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' }, SOLUSD: { wsname: 'SOL/USD', base: 'SOL', quote: 'USD', status: 'online' }, XXRPZUSD: { wsname: 'XRP/USD', base: 'XXRP', quote: 'ZUSD', status: 'online' }, XDGUSD: { wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD', status: 'online' }, LINKUSD: { wsname: 'LINK/USD', base: 'LINK', quote: 'USD', status: 'online' }, '1INCHUSD': { wsname: '1INCH/USD', base: '1INCH', quote: 'USD', status: 'online' } };
  for (let i = 0; i < nonMajors; i += 1) { const b = synth(i); out[`${b}USD`] = { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }; }
  for (const k of drop) delete out[k];
  return { ...out, ...extra };
}
const catalogOf = (v, observedTs) => normalizeKrakenAssetPairs(v, { excludeBases: EXCLUDE, observedTs }).catalog;
const accepted = (catalog) => ({ status: 'ACCEPTED', catalog, lastError: null, lastSuccessTs: catalog.observedTs, lastAttemptTs: catalog.observedTs });
const CONFIG = (over = {}) => ({ universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], socialResearch: { catalog: { source: 'WIDEEYE_ASSET_PAIRS', refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 }, localAdmission: { mode: 'CATALOG_BACKED', policyVersion: 1, staticTerms: [] }, xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: 25 }, watchPlan: { maxXAssets: 25 } }, ...over });
const Z7 = synth(7); const Z8 = synth(8);

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4F collector integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `s4f_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, repo, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => {
    const { rows } = await ownAdvisoryHolders(admin);
    for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
    return rows.length;
  };
  const waitFor = async (pred, ms = 5000) => { let w = 0; while (!pred() && w < ms) { await new Promise((r) => setTimeout(r, 50)); w += 50; } return pred(); };
  const boot = ({ checkpointStore, journal, clockMs = T1, config = CONFIG(), snapshot = undefined, notices = [], social = {} }) => {
    seedDir();
    const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot };
    const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => notices, deepObservation: () => ({ count: 7, date: '2026-09-07', source: 'test current.json' }) };
    const c = startRumor2({
      log: () => {}, config,
      fetchImpl: async () => mkRes(304, ''),
      now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      researchCatalogSource: source,
      socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
      ...social,
    });
    return { c, clock, sockets, snap, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;
  const ofType = (ev, t) => ev.filter((e) => e.type === t);
  const src = (ev) => ev.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));

  test('4FCOL-H. real end-to-end: injected broad snapshot -> durable scope activation under a real writer epoch -> a non-major Bluesky frame becomes durable evidence -> restart/replay restores scope + cursor with correct knownAt and scope', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores();
      const cat = catalogOf(venue(), T1 - 60_000);
      const b = boot({ ...stores, snapshot: accepted(cat) });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.writerAuthority, 'ACTIVE'); assert.ok(Number.isSafeInteger(st.writerEpoch) && st.writerEpoch > 0, 'a real DB writer epoch');
      assert.equal(st.social.state, 'ACTIVE'); assert.equal(st.social.scope.mode, 'SCOPED'); assert.equal(st.social.scope.active.scopeRevision, 1); assert.equal(st.social.scope.active.termCount, 127);
      const ev0 = await hist(stores.journal);
      assert.deepEqual(ev0.filter((e) => e.type === SOCIAL_CATALOG_EVENT_TYPE || e.type === SOCIAL_SCOPE_EVENT_TYPE).map((e) => e.type), [SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE], 'catalog content + activation are durable BEFORE any frame');
      assert.equal(st.lastSettledEventSeq, ev0.length, 'the watermark covers the scope batch');
      assert.equal(b.sockets.length, 1);
      b.sockets[0].emit('open');
      b.sockets[0].emit('message', JSON.stringify(bskyCommit(100, `$${Z7} momentum rising`)));
      b.sockets[0].emit('message', JSON.stringify(bskyCommit(101, 'LINK momentum rising')));
      b.sockets[0].emit('message', JSON.stringify(bskyCommit(102, '$1INCH airdrop live')));
      await b.tick();
      const ev = await hist(stores.journal);
      const soc = ofType(ev, SOCIAL_EVENT_V2_TYPE);
      assert.deepEqual(soc.map((e) => e.providerEventSeq), [100, 102], 'the non-major and the digit-prefixed ticker are durable; the ambiguous bare LINK is not');
      assert.ok(soc[0].knownAtTs >= ofType(ev, SOCIAL_SCOPE_EVENT_TYPE)[0].activatedKnownAtTs, 'admitted after activation');
      assert.deepEqual(ofType(ev, SOCIAL_CURSOR_EVENT_TYPE).map((e) => e.durableCursor), [102]);
      assert.equal(b.c.status().lastSettledEventSeq, ev.length);
      assert.equal(b.c.status().activeClaims, 0, 'no claim, no packet from social research');
      await b.c.stop();
      // RESTART over the durable history
      const b2 = boot({ ...mkStores(), snapshot: accepted(catalogOf(venue(), T1 + 200_000)), clockMs: T1 + 250_000 });
      await b2.tick();
      const st2 = b2.c.status();
      assert.equal(st2.lifecycle, 'RESTORED'); assert.equal(st2.social.durableCursor, 102); assert.equal(st2.social.durableIndexSize, 2);
      assert.equal(st2.social.scope.active.scopeRevision, 1, 'the SAME durable scope (same content id): restored, no new activation');
      assert.equal(st2.social.scope.active.restored, true);
      const ev2 = await hist(stores.journal);
      assert.equal(ofType(ev2, SOCIAL_SCOPE_EVENT_TYPE).length, 1); assert.equal(ofType(ev2, SOCIAL_CATALOG_EVENT_TYPE).length, 1);
      const rp = replaySocialHistory(ev2);
      assert.equal(rp.ok, true); assert.equal(rp.observed, 2); assert.equal(rp.scopes.BLUESKY_OFFICIAL.scopeRevision, 1);
      for (const e of src(ev2)) assert.equal(socialScopeAt(rp.scopeHistory.BLUESKY_OFFICIAL, e.knownAtTs).scope.scopeRevision, 1);
      assert.equal(socialScopeAt(rp.scopeHistory.BLUESKY_OFFICIAL, ofType(ev2, SOCIAL_SCOPE_EVENT_TYPE)[0].activatedKnownAtTs - 1).state, 'LEGACY_SCOPE_UNKNOWN', 'before the first activation the scope is unknown, never backfilled');
      b2.sockets[0].emit('open'); b2.sockets[0].emit('message', JSON.stringify(bskyCommit(100, `$${Z7} momentum rising`))); b2.sockets[0].emit('message', JSON.stringify(bskyCommit(103, `$${Z8} pumping`)));
      await b2.tick();
      const ev3 = await hist(stores.journal);
      assert.deepEqual(ofType(ev3, SOCIAL_EVENT_V2_TYPE).map((e) => e.providerEventSeq), [100, 102, 103], 'the redelivered 100 deduped durably; another non-major admitted');
      await b2.c.stop();
    });
  });

  test('4FCOL-J. crash / writer-loss postures: a refused scope append opens nothing and retries byte-identically; a stale writer cannot adopt or append a new scope; a failed lookup retains owed work; a missing source after restart never becomes an empty authoritative scope', async () => {
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores();
      const cat = catalogOf(venue(), T1 - 60_000);
      // (1) crash BEFORE the scope commit: the first append is refused
      let refuse = 1; const origAppend = stores.journal.append.bind(stores.journal);
      stores.journal.append = async (recs) => (recs.some((r) => r.type === SOCIAL_SCOPE_EVENT_TYPE) && refuse-- > 0 ? { ok: false, reason: 'UNAVAILABLE: injected' } : origAppend(recs));
      const b = boot({ ...stores, snapshot: accepted(cat) });
      await b.tick();
      assert.equal(b.c.status().social.scope.active, null); assert.equal(b.sockets.length, 0, 'no stream without a durable scope'); assert.equal(ofType(await hist(stores.journal), SOCIAL_SCOPE_EVENT_TYPE).length, 0);
      await b.tick();
      const ev1 = await hist(stores.journal); assert.equal(ofType(ev1, SOCIAL_SCOPE_EVENT_TYPE).length, 1); assert.equal(b.sockets.length, 1); assert.equal(b.c.status().social.scope.active.scopeRevision, 1);
      // (2) failed durable lookup retains owed work: nothing appends, nothing advances, the next tick settles
      b.sockets[0].emit('open'); b.sockets[0].emit('message', JSON.stringify(bskyCommit(100, `$${Z7} listing`)));
      const origHas = stores.journal.hasEventIds.bind(stores.journal); let failLookup = 1;
      stores.journal.hasEventIds = async (t, ids) => (failLookup-- > 0 ? { ok: false, reason: 'injected lookup failure' } : origHas(t, ids));
      await b.tick();
      assert.equal(ofType(await hist(stores.journal), SOCIAL_EVENT_V2_TYPE).length, 0); assert.equal(b.c.status().social.durableCursor, null); assert.match(b.c.status().social.lastError ?? '', /durable lookup unavailable/);
      await b.tick();
      assert.equal(ofType(await hist(stores.journal), SOCIAL_EVENT_V2_TYPE).length, 1); assert.equal(b.c.status().social.durableCursor, 100);
      // (3) writer loss: the ear stops; a changed catalog cannot activate while standing by; reacquisition restores and then activates
      b.snap.value = accepted(catalogOf(venue({ extra: { NEWZUSD: { wsname: 'NEWZ/USD', base: 'NEWZ', quote: 'USD', status: 'online' } } }), T1 + 300_000));
      assert.ok((await killAdvisoryBackends(admin)) >= 1);
      assert.equal(await waitFor(() => stores.journal.writerHeld() === false), true);
      const origAcquire = stores.journal.acquireWriter; stores.journal.acquireWriter = async () => ({ ok: false, reason: 'HELD' });
      await b.tick(300_000);
      assert.equal(b.c.status().lifecycle, 'STANDBY_WRITER'); assert.equal(b.c.status().social.state, 'STANDBY'); assert.equal(b.sockets[0].closed, true);
      assert.equal(ofType(await hist(stores.journal), SOCIAL_SCOPE_EVENT_TYPE).length, 1, 'a standby writer appends no scope');
      stores.journal.acquireWriter = origAcquire;
      await b.tick();
      assert.equal(b.c.status().writerAuthority, 'ACTIVE'); assert.equal(b.c.status().social.scope.active.scopeRevision, 2, 'reacquired: the changed catalog activates as revision 2'); assert.equal(b.sockets.length, 3, 'reacquisition reopened the ear under the restored scope, then the quiescent transition reopened it under revision 2');
      assert.equal(ofType(await hist(stores.journal), SOCIAL_SCOPE_EVENT_TYPE).length, 2);
      await b.c.stop();
      // (4) restart with NO injected source: the last durable scope is restored (labelled) — never an empty authoritative scope, never five majors
      const b2 = boot({ ...mkStores(), clockMs: T1 + 900_000 });
      await b2.tick();
      const st = b2.c.status();
      assert.equal(st.lifecycle, 'RESTORED'); assert.equal(st.social.scope.active.scopeRevision, 2); assert.equal(st.social.scope.active.restored, true); assert.equal(st.social.scope.active.termCount, 128);
      assert.equal(st.social.scope.coverage.state, 'UNAVAILABLE'); assert.match(st.social.scope.coverage.reason, /CATALOG_SOURCE_NOT_INJECTED.*continuing under durable scope revision 2/);
      assert.equal(st.socialResearch.discovery.state, 'UNAVAILABLE'); assert.equal(st.socialResearch.discovery.source, 'NONE');
      assert.equal(ofType(await hist(stores.journal), SOCIAL_SCOPE_EVENT_TYPE).length, 2, 'no new activation without fresh catalog coverage');
      await b2.c.stop();
    });
  });

  test('4FCOL-L. X bounded selection: an EXPLICIT verified watch scope compiles a non-major into the REAL rule manifest through the collector; unselected markets stay locally discoverable; missing scope / catalog / bearer / budget => zero fake API calls; config.universe changes never widen it; unowned rules preserved', async () => {
    await withDb(async ({ mkStores }) => {
      const cat = catalogOf(venue(), T1 - 60_000);
      const unowned = { value: 'from:someoneelse', tag: 'other-project-rule' };
      const xOpts = { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } };
      // (a) explicit scope with a non-major, verified against the catalog
      const api = fakeXApi({ unowned: [unowned] });
      const cfg = CONFIG({ socialResearch: { ...CONFIG().socialResearch, xWatch: { mode: 'EXPLICIT_STATIC', tickers: [Z7, 'LINK', 'NOTINCAT', 'BTC'], maxAssets: 25 } } });
      const stores = mkStores();
      const b = boot({ ...stores, config: cfg, snapshot: accepted(cat), social: { socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: xOpts } });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.socialX.state, 'ACTIVE'); assert.equal(st.socialX.watch.mode, 'EXPLICIT_STATIC'); assert.deepEqual(st.socialX.watch.tickers, ['BTC', 'LINK', Z7]); assert.deepEqual(st.socialX.watch.rejected, [{ ticker: 'NOTINCAT', reason: 'WATCH_TICKER_NOT_IN_CATALOG' }]);
      const owned = api.state.rules.filter((r) => isSerpentTag(r.tag));
      assert.ok(owned.some((r) => r.value.includes(`$${Z7}`)), 'the non-major reached the REAL compiled rule set on the fake API'); assert.ok(!owned.some((r) => r.value.includes('DOGE') || r.value.includes('XRP')), 'config.universe majors outside the explicit scope are NOT rules');
      assert.ok(api.state.rules.some((r) => r.tag === 'other-project-rule'), 'the unowned project rule is untouched'); assert.equal(st.socialX.rules.unownedChanged, false);
      assert.equal(ofType(await hist(stores.journal), X_RULESET_EVENT_TYPE).length, 1);
      assert.deepEqual(st.socialResearch.paidWatch.verified.tickers, ['BTC', 'LINK', Z7]); assert.equal(st.socialResearch.paidWatch.proposed.status, 'PROPOSED'); assert.equal(st.socialResearch.paidWatch.active.watch.scopeId, st.socialResearch.paidWatch.verified.scopeId);
      // the locally discoverable set is the whole catalog: an unselected non-major is admitted by Bluesky, a delivered off-scope X Post is metered then filtered
      b.sockets[0].emit('open'); b.sockets[0].emit('message', JSON.stringify(bskyCommit(100, `$${Z8} pumping`)));
      api.state.streams[0].push(xLine(500, `$${Z7} listing`)); api.state.streams[0].push(xLine(501, 'nothing relevant')); api.state.streams[0].push('\r\n');
      await pause(); await b.tick();
      const ev = await hist(stores.journal);
      assert.deepEqual(ofType(ev, SOCIAL_EVENT_V2_TYPE).map((e) => `${e.provider}:${e.nativePostId.split('/').pop?.() ?? e.nativePostId}`).sort(), [`BLUESKY_OFFICIAL:r100`, `X_OFFICIAL:500`]);
      assert.equal(ofType(ev, X_METER_EVENT_TYPE)[0].deliveredPostReads, 2, 'every delivered Post is metered before the local filter');
      assert.ok(!JSON.stringify(b.c.status()).includes(BEARER));
      await b.c.stop();
      // (b) NOT_CONFIGURED scope with bearer + budget => zero calls
      for (const [label, config, snapshot, xcfg, expectReason] of [
        ['no watch scope', CONFIG(), accepted(cat), XCFG(), 'WATCH_SCOPE_NOT_CONFIGURED'],
        ['scope without a catalog', cfg, undefined, XCFG(), 'WATCH_SCOPE_CATALOG_UNAVAILABLE'],
        ['scope but no bearer', cfg, accepted(cat), XCFG({ bearer: null }), null],
        ['scope but no budget', cfg, accepted(cat), XCFG({ maxDailyPostReads: null, maxMonthlyPostReads: null, maxEstimatedDailyUsd: null }), null],
      ]) {
        const api2 = fakeXApi();
        const bb = boot({ ...mkStores(), config, snapshot, social: { socialXEnabled: true, socialXConfig: xcfg, socialXFetchImpl: api2.fetchImpl, socialXOptions: xOpts } });
        await bb.tick();
        assert.equal(api2.state.calls, 0, `${label}: zero X requests`); assert.notEqual(bb.c.status().socialX.state, 'ACTIVE', label);
        if (expectReason) assert.equal(bb.c.status().socialX.lastStopReason, expectReason, label);
        assert.equal(bb.c.status().socialX.watch.ok, expectReason === null, label);
        await bb.c.stop();
      }
      // (c) the manifest depends on the explicit scope only: a different config.universe yields the SAME rule set hash
      const api3 = fakeXApi(); const cfgWide = { ...cfg, universe: ['BTC'] };
      const b3 = boot({ ...mkStores(), config: cfgWide, snapshot: accepted(cat), social: { socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api3.fetchImpl, socialXOptions: xOpts } });
      await b3.tick();
      assert.equal(b3.c.status().socialX.ruleSetHash, st.socialX.ruleSetHash, 'config.universe does not change the paid rule set');
      assert.equal(b3.c.status().socialResearch.legacyPermission.count, 1, 'and the legacy permission count is reported separately');
      await b3.c.stop();
    });
  });

  test('4FCOL-M. X plan change through configuration: a new explicit scope reconciles disconnected into a NEW rule set / coverage epoch; a PROPOSED plan alone makes zero calls; an active smoke run bound to the old rule set fails closed on the new scope', async () => {
    await withDb(async ({ mkStores }) => {
      const cat = catalogOf(venue(), T1 - 60_000);
      const xOpts = { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } };
      const cfgA = CONFIG({ socialResearch: { ...CONFIG().socialResearch, xWatch: { mode: 'EXPLICIT_STATIC', tickers: [Z7], maxAssets: 25 } } });
      const cfgB = CONFIG({ socialResearch: { ...CONFIG().socialResearch, xWatch: { mode: 'EXPLICIT_STATIC', tickers: [Z7, Z8], maxAssets: 25 } } });
      const stores = mkStores(); const api = fakeXApi();
      const a = boot({ ...stores, config: cfgA, snapshot: accepted(cat), social: { socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: xOpts } });
      await a.tick();
      const hashA = a.c.status().socialX.ruleSetHash; assert.equal(a.c.status().socialX.coverageEpoch, 1);
      await a.c.stop();
      assert.ok(api.state.streams[0].aborted, 'the paid stream is disconnected before any reconfiguration');
      // a PROPOSED plan (notices) with NO explicit scope: zero calls
      const apiP = fakeXApi();
      const notices = [{ symbol: Z8, verdict: 'RIPPLE', zVol: 4, tsMs: T1 - 1000 }, { symbol: Z7, verdict: 'MISSED', zVol: 3, tsMs: T1 - 2000 }];
      const p = boot({ ...mkStores(), config: CONFIG(), snapshot: accepted(cat), notices, social: { socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: apiP.fetchImpl, socialXOptions: xOpts } });
      await p.tick();
      const pw = p.c.status().socialResearch.paidWatch;
      assert.equal(pw.proposed.status, 'PROPOSED'); assert.deepEqual(pw.proposed.selected, [Z8, Z7]); assert.equal(pw.configured.mode, 'NOT_CONFIGURED'); assert.equal(pw.verified.ok, false); assert.equal(apiP.state.calls, 0, 'a proposal is displayed, never applied: zero provider calls');
      assert.equal(p.c.status().socialX.state, 'DARK');
      await p.c.stop();
      // the operator applies scope B through configuration: disconnected reconcile, new rule set, new coverage epoch
      const b = boot({ ...mkStores(), config: cfgB, snapshot: accepted(cat), clockMs: T1 + 600_000, social: { socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl, socialXOptions: xOpts } });
      await b.tick();
      const stB = b.c.status();
      assert.notEqual(stB.socialX.ruleSetHash, hashA); assert.equal(stB.socialX.coverageEpoch, 2); assert.ok(api.state.rules.filter((r) => isSerpentTag(r.tag)).some((r) => r.value.includes(`$${Z8}`)));
      const rs = ofType(await hist(stores.journal), X_RULESET_EVENT_TYPE); assert.equal(rs.length, 2); assert.equal(rs[1].coverageEpoch, 2); assert.equal(rs[1].ruleSetHash, stB.socialX.ruleSetHash);
      await b.c.stop();
    });
    // a smoke run authorized against rule set B cannot be reused by a different scope (C): SMOKE_RUN_RULESET_MISMATCH, zero stream (fresh history)
    await withDb(async ({ mkStores }) => {
      const cat = catalogOf(venue(), T1 - 60_000);
      const xOpts = { streamOptions: { setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} } };
      const cfgB = CONFIG({ socialResearch: { ...CONFIG().socialResearch, xWatch: { mode: 'EXPLICIT_STATIC', tickers: [Z7, Z8], maxAssets: 25 } } });
      const apiS = fakeXApi(); const storesS = mkStores();
      const smoke = XCFG({ liveSmokeTargetPostReads: 10, liveSmokeMaxPostReads: 100, liveSmokeRunId: 'smoke-2026-09-07-4f' });
      const s1 = boot({ ...storesS, config: cfgB, snapshot: accepted(cat), social: { socialXEnabled: true, socialXConfig: smoke, socialXFetchImpl: apiS.fetchImpl, socialXOptions: xOpts } });
      await s1.tick(); // tick 1: the ACTIVE smoke authorization becomes durable before any paid stream
      assert.equal(ofType(await hist(storesS.journal), X_SMOKE_EVENT_TYPE).filter((e) => e.status === 'ACTIVE').length, 1); assert.equal(apiS.state.streams.length, 0, 'no stream before the authorization is durable');
      await s1.tick(); // tick 2: the durable authorization opens the ONE paid stream (XCOL-5 law)
      assert.equal(apiS.state.streams.length, 1);
      await s1.c.stop();
      const cfgC = CONFIG({ socialResearch: { ...CONFIG().socialResearch, xWatch: { mode: 'EXPLICIT_STATIC', tickers: [Z8], maxAssets: 25 } } });
      const s2 = boot({ ...mkStores(), config: cfgC, snapshot: accepted(cat), clockMs: T1 + 120_000, social: { socialXEnabled: true, socialXConfig: smoke, socialXFetchImpl: apiS.fetchImpl, socialXOptions: xOpts } });
      await s2.tick();
      assert.equal(s2.c.status().socialX.lastStopReason, 'SMOKE_RUN_RULESET_MISMATCH'); assert.equal(apiS.state.streams.length, 1, 'no second paid stream under a run bound to another rule set');
      await s2.c.stop();
    });
  });

  test('4FCOL-N/D/O. status separates discovery (127) / local admission / paid watch / deep observation (7) / legacy permission (5); missing metadata is UNAVAILABLE, never "five majors = full universe"; research admission never touches cost, ledger, claims, or blocked sources', async () => {
    await withDb(async ({ mkStores }) => {
      const cat = catalogOf(venue(), T1 - 60_000);
      const b = boot({ ...mkStores(), snapshot: accepted(cat) });
      await b.tick();
      const r = b.c.status().socialResearch;
      assert.equal(r.discovery.state, 'CATALOG_BACKED'); assert.equal(r.discovery.catalog.counts.supported, 127); assert.equal(r.discovery.catalog.contentId, cat.contentId); assert.equal(r.discovery.catalog.freshness, 'FRESH'); assert.equal(r.discovery.source, 'INJECTED_WIDEEYE_SNAPSHOT');
      assert.equal(r.localAdmission.active.termCount, 127); assert.equal(r.localAdmission.active.scopeRevision, 1); assert.equal(r.localAdmission.coverage.state, 'CATALOG_BACKED');
      assert.equal(r.paidWatch.configured.mode, 'NOT_CONFIGURED'); assert.equal(r.paidWatch.verified.reason, 'WATCH_SCOPE_NOT_CONFIGURED'); assert.equal(r.paidWatch.active.state, 'DISABLED'); assert.equal(r.paidWatch.proposed.status, 'PROPOSED'); assert.deepEqual(r.paidWatch.proposed.selected, [], 'no research signal => nothing proposed');
      assert.equal(r.deepObservation.count, 7); assert.match(r.deepObservation.label, /not the discovery count/);
      assert.equal(r.legacyPermission.count, 5); assert.match(r.legacyPermission.label, /LEGACY_PERMISSION_SET.*not the discovery count/);
      assert.match(r.historicalCoverage, /LEGACY_SCOPE_UNKNOWN/); assert.ok(!/all crypto|full universe|monitored every/i.test(JSON.stringify(r)));
      // D: catalog admission + planning changed no trade permission
      const { evaluateCost } = await import('../cost/model.js'); const { recordPrediction } = await import('../ledger/ledger.js');
      assert.match(JSON.stringify(evaluateCost(Z7, 100)), /not in universe/); assert.throws(() => recordPrediction({ coin: Z7, thesis: 'research', horizonMin: 5, predictedNetMovePct: 1, sizeUsd: 100 }), /not in universe/);
      const full = b.c.status(); assert.equal(full.activeClaims, 0); assert.equal(full.state, 'DARK'); assert.equal(full.social.authority, 'NONE');
      for (const k of ['attention', 'hyped', 'stalk', 'eligib', 'order', 'posture']) assert.ok(!Object.keys(full).some((key) => key.toLowerCase().includes(k)), `status carries no ${k} field`);
      // O: the blocked / foundation-only sources are untouched by research scope
      const s3 = JSON.stringify(b.c.status().socialResearch);
      assert.ok(!/REDDIT|STOCKTWITS|META_PUBLIC|TIKTOK|FARCASTER/.test(s3), 'no blocked provider is described as covered by research scope');
      await b.c.stop();
    });
    // missing metadata on a FRESH history: UNAVAILABLE with the reason; the legacy set is still reported as what it is; no scope, no stream
    await withDb(async ({ mkStores }) => {
      const b2 = boot({ ...mkStores(), snapshot: { status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED: HTTP 429' } });
      await b2.tick();
      const r2 = b2.c.status().socialResearch;
      assert.equal(r2.discovery.state, 'UNAVAILABLE'); assert.match(r2.discovery.reason, /CATALOG_NOT_ACCEPTED: REFRESH_FAILED: HTTP 429/); assert.equal(r2.discovery.catalog, null); assert.equal(r2.localAdmission.active, null); assert.equal(b2.c.status().social.state, 'HYDRATED');
      assert.equal(r2.legacyPermission.count, 5); assert.equal(r2.paidWatch.proposed.status, 'UNAVAILABLE'); assert.equal(b2.sockets.length, 0, 'no stream, no invented universe');
      await b2.c.stop();
    });
  });
}
