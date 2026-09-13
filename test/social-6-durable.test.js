// SOCIAL-6 §44/§45 with real PostgreSQL through the ACTUAL collector seams: profiles are derived from the
// journal (no materialized family — the journal gains no new event type), a restart reproduces the
// byte-identical as-of profile and composite view, a later durable append leaves the earlier as-of view
// unchanged, the collector status names the outcome / association seams honestly, and the Childhood
// accessor shape fly.js injects resolves to OUTCOME_UNAVAILABLE when the archive has no aligned record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_EVENT_TYPES, SOCIAL_OBSERVATION_TYPES, RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-settle.js';
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

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-6d-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-6 durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { startRumor2 } = await import('../rumor2/collector.js');
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const { getChildhoodManifest, queryObservations, getOutcomeForObservation } = await import('../memory/childhood.js');
  const { childhoodOutcomeRecord } = await import('../rumor2/social-research-outcome.js');
  const withDb = async (fn) => {
    const SCHEMA = `s6d_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, repo, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const H = { get: () => null }; const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
  const CONFIG = (over = {}) => ({ universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'], socialResearch: { catalog: { source: 'WIDEEYE_ASSET_PAIRS', refreshSec: 300, maxAgeSec: 900, maxMarkets: 5000 }, localAdmission: { mode: 'CATALOG_BACKED', policyVersion: 1, staticTerms: [] }, xWatch: { mode: 'NOT_CONFIGURED', tickers: [], maxAssets: 25 }, watchPlan: { maxXAssets: 25 } }, ...over });
  // the exact accessor shape fly.js injects (the Childhood read bridge over an EMPTY data dir here => null / no records)
  const historicalOutcomes = ({ symbol, fromTsMs, toTsMs }) => { const m = getChildhoodManifest(); if (!m) return null; return queryObservations({ symbol, fromTs: Math.floor(fromTsMs / 1000), toTs: Math.floor(toTsMs / 1000), limit: 4 }).map((o) => { const out = getOutcomeForObservation(o.id); return out ? childhoodOutcomeRecord(o, out, m) : null; }).filter(Boolean); };
  const bootC = ({ checkpointStore, journal, clockMs = T0, config = CONFIG(), snapshot = undefined, notices = [], research = { enabled: true, historicalOutcomes } }) => {
    seedDir();
    const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot }; const nl = { value: notices };
    const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => nl.value, deepObservation: () => null, population: () => null };
    const c = startRumor2({
      log: () => {}, config, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      researchCatalogSource: source, researchStrainer: research,
      socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
    });
    return { c, clock, sockets, snap, notices: nl, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;

  test('S6-D1/D4/P1 durable. profiles derive from the PostgreSQL journal: no new event family is written; the as-of profile and composite view reproduce byte-identically after a restart; a later durable observation leaves the earlier as-of view unchanged; status names the seams (Childhood accessor connected, no association authority) and OUTCOME_UNAVAILABLE is reported truthfully without any fetch', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      const b = bootC({ ...stores, snapshot: accepted(cat), notices: [notice('LINK', T0 + 20_000)] });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(21, '$LINK source one speaks first')));
      await b.tick(); let ev = await hist(stores.journal); assert.equal(rd(ev).length, 2, 'the market-led dossier, then the participation update');
      const types = new Set(ev.map((e) => e.type)); for (const t of types) assert.ok(SOCIAL_EVENT_TYPES.includes(t) || !/PROFILE|SOURCE_BEHAVIOR/.test(t), `${t}: no profile family in the journal`);
      const research = b.c.internals.research; const src = ev.find((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type)); const me = src.socialAuthorId;
      const st = b.c.status().research.sourceBehavior; assert.equal(st.profiles, 1); assert.equal(st.materialized, false); assert.equal(st.outcomeSeam, 'CHILDHOOD_ARCHIVE_ACCESSOR'); assert.equal(st.claimAssociationSeam, 'NONE_AUTHORIZED'); assert.deepEqual(st.retention, { DURABLE_PROFILE_ALLOWED: 1 });
      const t1 = b.clock.ms; const p1 = research.sourceProfile(me, { asOfTs: t1 }); const c1 = research.composite('LINK', { asOfTs: t1 });
      assert.equal(p1.coverage.observationCount, 1); assert.equal(p1.coverage.distinctResearchEpisodeCount, 1); assert.equal(p1.marketLead.episodes[0].outcome.state, 'OUTCOME_UNAVAILABLE', 'an empty Childhood archive answers UNAVAILABLE, never a fabricated outcome'); assert.equal(p1.factualOutcome.state, 'UNAVAILABLE_NO_VALID_ASSOCIATION');
      assert.equal(c1.dossier.dossierId, rd(ev).at(-1).dossierId); assert.equal(c1.sourceContext.profiles[0].history, 'AVAILABLE'); assert.equal(c1.sourceContext.profiles[0].profileId, p1.profileId);
      // a later durable observation (a second source) => the earlier as-of view is unchanged; the later view grows
      b.clock.ms += 1000; b.sockets.at(-1).emit('message', JSON.stringify(commit(22, '$LINK source two arrives later', { did: 'did:plc:b' }))); await b.tick();
      assert.equal(canonicalJson(research.sourceProfile(me, { asOfTs: t1 })), canonicalJson(p1), 'S6-D4'); assert.equal(b.c.status().research.sourceBehavior.profiles, 2);
      await b.c.stop();
      // restart: hydrated from the journal alone => identical as-of views
      const b2 = bootC({ ...mkStores(), snapshot: accepted(catalogOf(NON_MAJORS, T0 + 100_000)), clockMs: b.clock.ms + 60_000, notices: [notice('LINK', T0 + 20_000)] });
      await b2.tick(); const r2 = b2.c.internals.research;
      assert.equal(b2.c.status().research.sourceBehavior.profiles, 2); assert.equal(canonicalJson(r2.sourceProfile(me, { asOfTs: t1 })), canonicalJson(p1), 'S6-D1: byte-identical after restart'); assert.equal(canonicalJson(r2.composite('LINK', { asOfTs: t1 })), canonicalJson(c1));
      ev = await hist(stores.journal); assert.equal(replaySocialHistory(ev).ok, true); assert.equal(ev.filter((e) => /PROFILE|SOURCE_BEHAVIOR|OUTCOME|COMPOSITE/.test(String(e.type))).length, 0, 'the journal gained no profile / outcome / composite family (the frozen core\'s own families remain)'); assert.ok(ev.some((e) => SOCIAL_EVENT_TYPES.includes(e.type)));
      await b2.c.stop();
    });
  });
}
