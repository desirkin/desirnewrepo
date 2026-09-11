// SOCIAL-7 §48 / §51 with real PostgreSQL through the ACTUAL collector seams: the readiness matrix is projected from
// the collector's own live runtime statuses (Bluesky ACTIVE only after a real connection in this process; X DISABLED
// with the paid smoke NOT performed; the legacy aggregate UNOBSERVED here) and written into the status file; a stale
// writer appends no dossier; a fence lost after the durable append (advisory-lock backends killed) adopts nothing and
// derives no profile fact, while the lawful writer re-derives once from the journal; every journal prefix replays to
// the exact as-of dossier history and source profile; a later readiness / outcome projection rewrites no journal byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAdvisoryHolders } from './helpers/pg-fence.js';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_OBSERVATION_TYPES, RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-settle.js';
import { validateReadinessRow, READINESS_MATRIX_VERSION } from '../rumor2/social-readiness.js';
import { createResearchStrainer } from '../rumor2/social-research-runtime.js';
import { canonicalJson } from '../rumor2/truth.js';
import { loadConfig } from '../lib/config.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const C = T0 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const pairs = (bases) => Object.fromEntries(bases.map((b) => [`${b}USD`, { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }]));
const catalogOf = (bases, observedTs) => { const n = normalizeKrakenAssetPairs(pairs(bases), { excludeBases: EXCLUDE, observedTs }); assert.equal(n.ok, true, n.reason); return n.catalog; };
const accepted = (catalog) => ({ status: 'ACCEPTED', catalog, lastError: null, lastSuccessTs: catalog.observedTs, lastAttemptTs: catalog.observedTs });
const commit = (seq, text, { rkey = `r${seq}`, did = 'did:plc:a' } = {}) => ({ $type: 'message', payload: { $type: 'x#commit', did, seq, time: iso(C), operation: 'create', collection: 'app.bsky.feed.post', rkey, cid: `cid${seq}`, record: { $type: 'app.bsky.feed.post', text, createdAt: iso(C) } } });
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; }, closed: false }; }
const NON_MAJORS = ['LINK', 'FRESH42', 'ZQQ7'];
const notice = (symbol, tsMs, over = {}) => ({ ts: iso(tsMs), tsMs, symbol, verdict: 'RIPPLE', zVol: 5.1, zRet: 2.2, extension: 3.9, liquidityNote: 'x', inDeepTape: false, usdVol24h: 3_000_000, ...over });
const rd = (arr) => arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE);
const findFiles = (dir, name, out = []) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) findFiles(p, name, out); else if (f === name) out.push(p); } return out; };

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-7d-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-7 durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { startRumor2 } = await import('../rumor2/collector.js');
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `s7d_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
  const H = { get: () => null }; const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
  const CONFIG = (over = {}) => ({ universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], socialResearch: { catalog: { source: 'WIDEEYE_ASSET_PAIRS', refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 }, localAdmission: { mode: 'CATALOG_BACKED', policyVersion: 1, staticTerms: [] }, xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: 25 }, watchPlan: { maxXAssets: 25 } }, ...over });
  const bootC = ({ checkpointStore, journal, clockMs = T0, config = CONFIG(), snapshot = undefined, notices = [], research = { enabled: true } }) => {
    const dir = seedDir();
    const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot }; const nl = { value: notices };
    const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => nl.value, deepObservation: () => null, population: () => null };
    const c = startRumor2({
      log: () => {}, config, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      researchCatalogSource: source, researchStrainer: research,
      socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
    });
    return { c, dir, clock, sockets, snap, notices: nl, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;

  test('D7-1 (§48/§54.18). the collector projects ONE readiness matrix from its own live statuses: Bluesky is OPERATIONAL_LIVE_PROVEN only once the runtime is ACTIVE in this process (durable evidence available only after a durable observation), X is DISABLED with the paid smoke NOT performed, the legacy aggregate stays UNOBSERVED here, every row validates, and the projection lands in the status file', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      const b = bootC({ ...stores, snapshot: accepted(cat), notices: [notice('LINK', T0 + 20_000)] });
      await b.tick();
      let st = b.c.status(); let m = st.socialReadiness; assert.equal(m.version, READINESS_MATRIX_VERSION); assert.equal(m.authority, 'NONE'); assert.equal(m.knownAtTs, b.clock.ms);
      for (const r of m.providers) assert.equal(validateReadinessRow(r), null, r.provider);
      const row = (id) => m.providers.find((r) => r.provider === id);
      assert.equal(row('BLUESKY_OFFICIAL').currentlyEnabledState, st.social.state, 'the row mirrors the live runtime state');
      assert.equal(row('BLUESKY_OFFICIAL').readiness, st.social.state === 'ACTIVE' ? 'OPERATIONAL_LIVE_PROVEN' : 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE'); assert.equal(row('BLUESKY_OFFICIAL').liveSmokeState, 'PERFORMED_PRIOR_SESSION', 'a not-yet-connected runtime never erases the one real prior Bluesky smoke');
      assert.equal(row('X_OFFICIAL').readiness, 'DISABLED'); assert.deepEqual(row('X_OFFICIAL').blockers, ['PAID_SMOKE_NOT_PERFORMED', 'RUNTIME_DISABLED']); assert.equal(row('X_OFFICIAL').liveSmokeState, 'NOT_PERFORMED');
      assert.equal(row('RUMINT_LEGACY_AGGREGATE').currentlyEnabledState, 'UNOBSERVED_IN_THIS_PROCESS'); assert.equal(row('RUMINT_LEGACY_AGGREGATE').readiness, 'ACCESS_UNRESOLVED');
      for (const id of ['REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL']) assert.equal(row(id).readiness, 'RETENTION_BLOCKED'); for (const id of ['META_PUBLIC', 'TIKTOK_PUBLIC', 'FARCASTER_OFFICIAL']) assert.equal(row(id).readiness, 'FIXTURE_ONLY');
      // a real connection in this process (fake socket) + one durable observation
      b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(31, '$LINK readiness proof post')));
      await b.tick(); st = b.c.status(); m = st.socialReadiness;
      assert.equal(st.social.state, 'ACTIVE'); const bl = m.providers.find((r) => r.provider === 'BLUESKY_OFFICIAL'); assert.equal(bl.readiness, 'OPERATIONAL_LIVE_PROVEN'); assert.deepEqual(bl.blockers, []); assert.equal(bl.operationalEvidenceAvailable, true); assert.equal(bl.durableRawContentAllowed, true);
      assert.deepEqual(m.operationalProviders, ['BLUESKY_OFFICIAL']); assert.equal(m.counts.OPERATIONAL_LIVE_PROVEN, 1);
      const files = findFiles(b.dir, 'status.json'); assert.ok(files.length >= 1, 'the collector status file exists'); const onDisk = JSON.parse(readFileSync(files[0], 'utf8')); assert.equal(onDisk.socialReadiness.version, READINESS_MATRIX_VERSION); assert.equal(onDisk.socialReadiness.providers.length, m.providers.length);
      assert.ok(!/BUY|SELL|STRIKE|TRADE|corroborat/.test(canonicalJson(m.providers)));
      await b.c.stop();
    });
  });

  test('D7-2 (§51-C/D real fence). a stale writer (advisory lock lost before the tick) appends no dossier; a fence lost after the durable dossier append adopts nothing — no dossier, no profile episode in the lost writer — and the lawful writer re-derives the committed dossier and its profile facts from the journal once, never re-appending', async () => {
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      const b = bootC({ ...stores, snapshot: accepted(cat) });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(41, '$ZQQ7 first durable post')));
      await b.tick(); assert.equal(rd(await hist(stores.journal)).length, 1);
      b.sockets.at(-1).emit('message', JSON.stringify(commit(42, '$ZQQ7 second post from another author', { did: 'did:plc:b' })));
      assert.ok((await killAdvisoryBackends(admin)) >= 1); assert.equal(await waitFor(() => stores.journal.writerHeld() === false), true);
      const origAcquire = stores.journal.acquireWriter; stores.journal.acquireWriter = async () => ({ ok: false, reason: 'HELD' });
      await b.tick(300_000); assert.equal(b.c.status().lifecycle, 'STANDBY_WRITER'); assert.equal(rd(await hist(stores.journal)).length, 1, 'a standby writer appends no dossier'); assert.equal(b.c.status().research.pendingOperation, null);
      stores.journal.acquireWriter = origAcquire; await b.c.stop();
    });
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000); let cut = true;
      const waitLost = async () => { let w = 0; while (stores.journal.writerHeld() !== false && w < 5000) { await new Promise((r) => setTimeout(r, 50)); w += 50; } };
      const journal = { ...stores.journal, append: async (recs) => { const r = await stores.journal.append(recs); if (cut && r.ok && recs.some((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE)) { cut = false; assert.ok((await killAdvisoryBackends(admin)) >= 1); await waitLost(); } return r; } };
      const b = bootC({ ...stores, journal, snapshot: accepted(cat) });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(51, '$LINK fence case post')));
      await b.tick();
      const ev = await hist(stores.journal); const me = ev.find((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type)).socialAuthorId;
      assert.equal(b.c.status().lifecycle, 'STANDBY_WRITER'); assert.equal(rd(ev).length, 1, 'journal-ahead durable truth'); assert.equal(b.c.status().research.durableDossiers, 0, 'NOT adopted by the lost writer'); assert.equal(b.c.status().research.journalAhead.coin, 'LINK');
      const lost = b.c.internals.research; const lp = lost.sourceProfile(me, { asOfTs: b.clock.ms }); assert.ok(lp === null || lp.marketLead.episodeAssociations === 0, 'the lost writer derives no episode fact from its unadopted write');
      const bytes = canonicalJson(ev);
      await b.tick(); // reacquire => re-hydrate from the journal alone
      assert.ok(['RESTORED', 'REBUILT_FROM_EVENT_HISTORY', 'FRESH_START'].includes(b.c.status().lifecycle), b.c.status().lifecycle);
      assert.equal(b.c.status().research.durableDossiers, 1); assert.equal(b.c.internals.research.sourceProfile(me, { asOfTs: b.clock.ms }).marketLead.episodeAssociations, 1, 'the lawful writer derives the profile fact from the journal');
      const after = await hist(stores.journal); assert.equal(rd(after).length, 1, 'hydrated once, never re-appended'); assert.equal(canonicalJson(after), bytes); assert.equal(replaySocialHistory(after).ok, true);
      await b.c.stop();
    });
  });

  test('D7-3 (§51-F/K over the real journal). every journal prefix replays to the exact as-of dossier history and source profile the live collector held at that boundary; a later readiness / outcome / composite projection rewrites no journal byte and leaves the earlier as-of view unchanged', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      const b = bootC({ ...stores, snapshot: accepted(cat), notices: [notice('LINK', T0 + 20_000)] });
      await b.tick(); b.sockets.at(-1).emit('open');
      const records = []; let me = null;
      const posts = [[61, '$LINK prefix one', 'did:plc:a'], [62, '$LINK prefix two other author', 'did:plc:b'], [63, '$LINK prefix three same author again', 'did:plc:a'], [64, '$LINK prefix one', 'did:plc:c']];
      for (const [seq, text, did] of posts) {
        b.sockets.at(-1).emit('message', JSON.stringify(commit(seq, text, { did }))); await b.tick();
        const ev = await hist(stores.journal); me ??= ev.find((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type)).socialAuthorId;
        const research = b.c.internals.research;
        records.push({ n: ev.length, asOfTs: b.clock.ms, hist: canonicalJson(research.history('LINK')), profile: canonicalJson(research.sourceProfile(me, { asOfTs: b.clock.ms })), composite: canonicalJson(research.composite('LINK', { asOfTs: b.clock.ms })) });
      }
      const all = await hist(stores.journal); assert.ok(rd(all).length >= 2);
      for (const rec of records) {
        const rt = createResearchStrainer({ now: () => rec.asOfTs }); assert.equal(rt.hydrate(all.slice(0, rec.n)).ok, true, `prefix ${rec.n}`);
        assert.equal(canonicalJson(rt.history('LINK')), rec.hist, `prefix ${rec.n}: history`); assert.equal(canonicalJson(rt.sourceProfile(me, { asOfTs: rec.asOfTs })), rec.profile, `prefix ${rec.n}: profile`); assert.equal(canonicalJson(rt.composite('LINK', { asOfTs: rec.asOfTs })), rec.composite, `prefix ${rec.n}: composite`);
      }
      for (let n = 1; n <= all.length; n += 1) { const rt = createResearchStrainer({ now: () => b.clock.ms }); assert.equal(rt.hydrate(all.slice(0, n)).ok, true, `prefix ${n} hydrates`); }
      // K: later projections change nothing durable
      const bytes = canonicalJson(all); const earlier = records[0];
      b.c.status(); b.c.internals.research.sourceProfile(me, { asOfTs: b.clock.ms + 86_400_000, availability: 'SIMULATED_AS_OF' }); b.c.internals.research.composite('LINK', { asOfTs: b.clock.ms + 86_400_000 });
      assert.equal(canonicalJson(await hist(stores.journal)), bytes, 'no journal byte changed'); assert.equal(canonicalJson(b.c.internals.research.sourceProfile(me, { asOfTs: earlier.asOfTs })), earlier.profile, 'the earlier as-of view is untouched');
      await b.c.stop();
    });
  });
}
