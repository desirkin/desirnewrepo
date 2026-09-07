// SOCIAL-5 completion — the §36.6 shadow denominator and the §36.7 passive market bridge through the
// ACTUAL collector seams with real PostgreSQL, plus episode-state restart truth: one bounded shadow
// sample per completed sweep under the fence (lost-ack retry, altered payload = corruption, restart
// hydration); the tape store's real current feature snapshot consumed read-only (NOT_PRESENT before the
// tape writes, PRESENT_WITH_AGE after, STALE_SESSION for a prior session, OFFLINE visible, no socket, no
// subscription, no universe mutation); DORMANT reproduced from durable truth after a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_OBSERVATION_TYPES, RESEARCH_DOSSIER_EVENT_TYPE, RESEARCH_SHADOW_EVENT_TYPE } from '../rumor2/social-settle.js';
import { validateResearchDossierEvent } from '../rumor2/social-research-dossier.js';
import { validateResearchShadowEvent } from '../rumor2/social-research-shadow.js';
import { validateEvidencePacket } from '../evidence/contract.js';
import { canonicalJson } from '../rumor2/truth.js';
import { loadConfig } from '../lib/config.js';
import { sessionDate } from '../lib/time.js';

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
const sh = (arr) => arr.filter((e) => e.type === RESEARCH_SHADOW_EVENT_TYPE);
const population = (sweepId, tsMs, rows, catalogContentId) => Object.freeze({ version: 'wideeye-sweep-population-1', sweepId, tsMs, ts: iso(tsMs), sessionDate: sessionDate(new Date(tsMs)), catalogContentId, catalogStatus: 'ACCEPTED', scanned: rows.length + 2, tickerRows: rows.length + 1, evaluated: rows.length, excluded: { NO_TICKER_ROW: 1, PRICE_INVALID: 0, INSUFFICIENT_SERIES: 1 }, rows: Object.freeze(rows.map((r) => Object.freeze(r))) });
const row = (coin, over = {}) => ({ coin, evaluated: true, zVol: 0.4, zRet: -0.1, extension: 0.2, preCooldownVerdict: null, cooldownSuppressed: false, noticeEmitted: false, usdVol24h: null, inDeepTape: false, ...over });
const SWEEP = (n) => `ws-${n.toString(16).padStart(40, '0')}`;
const snapshotFor = (coin, tsMs, over = {}) => ({ ts: iso(tsMs), coin, tapeState: 'LIVE', bestBid: 9.99, bestAsk: 10.01, bestBidQty: 100, bestAskQty: 120, mid: 10, spreadBps: 20, depthUsd: { top: { bid: 999, ask: 1201.2 }, '5bps': { bid: 3000, ask: 2800 }, '10bps': { bid: 6000, ask: 5900 }, '25bps': { bid: 12000, ask: 13000 } }, obi: { top: -0.09, '5bps': 0.03, '10bps': 0.008, '25bps': -0.04 }, tradeImbalance15s: 0.2, tradeImbalance1m: -0.1, tradeImbalance5m: 0.05, cvd: 12.5, ...over });

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5d-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-5 durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { startRumor2 } = await import('../rumor2/collector.js');
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const { writeCurrentFeatureSnapshot, readCurrentFeatureSnapshot, writeTapeStatus, readTapeStatus } = await import('../tape/store.js');
  const { dataDir } = await import('../lib/config.js');
  const withDb = async (fn) => {
    const SCHEMA = `s5c_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
  const bootC = ({ checkpointStore, journal, clockMs = T0, config = CONFIG(), snapshot = undefined, notices = [], deep = null, pop = null, research = { enabled: true }, social = {}, reuseDir = false }) => {
    if (!reuseDir) seedDir();
    const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot }; const nl = { value: notices }; const dp = { value: deep }; const pp = { value: pop };
    const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => nl.value, deepObservation: () => dp.value, population: () => pp.value };
    const c = startRumor2({
      log: () => {}, config, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      researchCatalogSource: source, researchStrainer: research,
      socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
      ...social,
    });
    return { c, clock, sockets, snap, notices: nl, deep: dp, pop: pp, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;

  test('SHADOW-DURABLE. one bounded RUMOR2_RESEARCH_SHADOW_SAMPLE per completed sweep through the collector under the fence: the same sweep is never sampled twice; a new sweep yields a new sample; a lost acknowledgement retries byte-identically and collapses; an altered payload is corruption; restart hydrates the samples; status reports the recipe and counts; no outcome is stored', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000); const attempts = []; let lose = false;
      const journal = { ...stores.journal, append: async (recs) => { if (recs.some((e) => e.type === RESEARCH_SHADOW_EVENT_TYPE)) { attempts.push(canonicalJson(recs)); if (lose) { lose = false; await stores.journal.append(recs); return { ok: false, reason: 'UNAVAILABLE: acknowledgement lost' }; } } return stores.journal.append(recs); } };
      const pop1 = population(SWEEP(1), T0 - 10_000, [row('LINK'), row('FRESH42', { preCooldownVerdict: 'MISSED', cooldownSuppressed: true }), row('ZQQ7', { noticeEmitted: true, preCooldownVerdict: 'RIPPLE', usdVol24h: 4_000_000 })], cat.contentId);
      const b = bootC({ ...stores, journal, snapshot: accepted(cat), pop: pop1 });
      assert.equal(b.c.status().research.shadowControl.status, 'AWAITING_COMPLETED_SWEEP');
      await b.tick(); let ev = await hist(stores.journal);
      assert.equal(sh(ev).length, 1, 'ONE sample-set event for the completed sweep'); const s1 = sh(ev)[0]; assert.equal(validateResearchShadowEvent(s1), null); assert.equal(s1.sweepId, SWEEP(1)); assert.equal(s1.population.unnoticed, 2); assert.equal(s1.population.noticed, 1); assert.deepEqual(s1.selected.map((r) => r.coin).sort(), ['FRESH42', 'LINK']); assert.equal(s1.knownAtTs, b.clock.ms); assert.ok(s1.knownAtTs >= s1.sweepTsMs);
      assert.ok(!s1.selected.some((r) => r.coin === 'ZQQ7'), 'the noticed coin is not a shadow control'); assert.equal(s1.selected.find((r) => r.coin === 'FRESH42').reason, 'SHADOW_CONTROL_COOLDOWN_SUPPRESSED'); assert.ok(!Object.keys(s1).some((k) => /outcome|return|pnl/i.test(k)) && s1.selected.every((r) => !Object.keys(r).some((k) => /outcome|return|pnl/i.test(k))), 'no later outcome is stored in the sample');
      assert.equal(b.c.status().research.shadowControl.status, 'SAMPLING'); assert.equal(b.c.status().research.shadowControl.durableSamples, 1); assert.equal(b.c.status().research.shadowControl.recipeVersion, 'shadow-hash-sample-1'); assert.equal(b.c.status().research.shadowControl.sampleCap, 8);
      await b.tick(); await b.tick(); assert.equal(sh(await hist(stores.journal)).length, 1, 'the same completed sweep is sampled at most once');
      // a new sweep with a lost acknowledgement: retried byte-identically, collapsed to ONE durable record
      lose = true; b.pop.value = population(SWEEP(2), b.clock.ms + 1000, [row('LINK'), row('ZQQ7')], cat.contentId); await b.tick();
      assert.equal(b.c.status().research.pendingOperation.sweepId, SWEEP(2)); await b.tick(); ev = await hist(stores.journal);
      assert.equal(sh(ev).length, 2); assert.equal(attempts.length, 3); assert.equal(attempts[1], attempts[2], 'byte-identical retry of the prepared sample'); assert.equal(b.c.status().research.pendingOperation, null); assert.equal(b.c.status().research.stats.opRetries, 1);
      const s2 = sh(ev)[1]; assert.equal((await stores.journal.append([s2])).ok, true, 'exact re-append collapses'); const alt = await stores.journal.append([{ ...s2, sampleCap: 9 }]); assert.equal(alt.ok, false); assert.match(alt.reason, /CORRUPTION/);
      const rp = replaySocialHistory(await hist(stores.journal)); assert.equal(rp.ok, true); assert.equal(rp.shadow.count, 2); assert.deepEqual(rp.shadow.order, [SWEEP(1), SWEEP(2)]);
      await b.c.stop();
      const b2 = bootC({ ...mkStores(), snapshot: accepted(catalogOf(NON_MAJORS, T0 + 100_000)), clockMs: b.clock.ms + 60_000, pop: b.pop.value });
      await b2.tick(); assert.equal(b2.c.status().research.shadowControl.durableSamples, 2, 'restart hydrates the durable samples'); assert.equal(b2.c.status().research.shadowControl.lastSweepId, SWEEP(2)); assert.equal(sh(await hist(stores.journal)).length, 2, 'nothing re-emitted for an already-sampled sweep');
      await b2.c.stop();
    });
  });

  test('BRIDGE-DURABLE. the tape store\'s real current feature snapshot is consumed read-only through fly.js-shaped accessors: NOT_PRESENT before the tape wrote (RUMOR started first), PRESENT_WITH_AGE after — without a restart; a prior-session file is STALE_SESSION; a tape OFFLINE status stays visible and freshness is never invented; the packet carries a TAPE evidence item from a MARKET_DATA source; no socket, no subscription, no universe or book mutation', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000); const dir = seedDir();
      const research = { enabled: true, marketSnapshot: (coin) => ({ snapshot: readCurrentFeatureSnapshot(coin), owner: readTapeStatus() }), currentSession: () => sessionDate(new Date(b.clock.ms)) };
      const b = bootC({ ...stores, snapshot: accepted(cat), notices: [notice('LINK', T0 - 5000)], research, reuseDir: true });
      await b.tick(); let ev = await hist(stores.journal); assert.equal(rd(ev).length, 1);
      const d1 = rd(ev)[0]; assert.equal(d1.dossier.marketDeep.state, 'NOT_CONNECTED'); assert.equal(d1.dossier.marketDeep.ownerSnapshot.state, 'NOT_PRESENT', 'RUMOR started before the tape: honest NOT_PRESENT'); assert.equal(b.c.status().research.marketBridge, 'OWNER_SNAPSHOT_ACCESSOR');
      // the tape (simulated owner) now writes its current snapshot under the current session — the next tick sees it without a restart
      const tsMs = b.clock.ms + 1000; writeCurrentFeatureSnapshot('LINK', snapshotFor('LINK', tsMs), { tsMs, session: sessionDate(new Date(tsMs)), symbol: 'LINK/USD' }); writeTapeStatus({ state: 'LIVE', staleFeedSec: 10, coins: { LINK: { synced: true, state: 'LIVE', major: false } } });
      await b.tick(); ev = await hist(stores.journal); assert.equal(rd(ev).length, 2, 'a present owner snapshot is a material change (quality NOT_PRESENT -> OWNER_LIVE)');
      const d2 = rd(ev)[1]; assert.equal(d2.dossier.marketDeep.state, 'OWNER_SNAPSHOT'); assert.equal(d2.dossier.marketDeep.ownerSnapshot.state, 'PRESENT_WITH_AGE'); assert.equal(d2.dossier.marketDeep.ownerSnapshot.ageMs, b.clock.ms - tsMs); assert.equal(d2.dossier.marketDeep.ownerSnapshot.book.spreadBps, 20); assert.equal(d2.dossier.marketDeep.ownerSnapshot.flow.tradeImbalance15s, 0.2); assert.equal(d2.dossier.executability.state, 'UNASSESSED');
      assert.equal(d2.packetStatus, 'VALID'); assert.equal(validateEvidencePacket(d2.packet).valid, true); assert.ok(d2.packet.evidence.some((e) => e.sense === 'TAPE' && e.kind === 'TAPE_FEATURE_SNAPSHOT' && e.state === 'KNOWN' && e.value.executability === 'UNASSESSED')); assert.ok(d2.packet.sources.some((s) => s.sourceType === 'MARKET_DATA' && s.provider === 'KRAKEN_TAPE'));
      assert.ok(d2.dossier.dependencies.nodes.some((n) => n.kind === 'MARKET_SNAPSHOT')); assert.equal(d2.dossier.opportunityClock.latestInputKnownAtTs, tsMs, 'the snapshot enters at its own capture clock (never backdated to the notice)');
      // the same snapshot again => not material => no write; the tape goes OFFLINE (status) => the owner state is visible, freshness is not invented
      await b.tick(); assert.equal(rd(await hist(stores.journal)).length, 2);
      writeTapeStatus({ state: 'OFFLINE', staleFeedSec: 10, coins: {} }); await b.tick(); ev = await hist(stores.journal); assert.equal(rd(ev).length, 3, 'owner health OFFLINE is a quality-state change');
      const d3 = rd(ev)[2]; assert.equal(d3.dossier.marketDeep.ownerSnapshot.quality, 'OWNER_OFFLINE_NOW'); assert.equal(d3.dossier.marketDeep.ownerSnapshot.ownerHealth.state, 'OFFLINE'); assert.ok(d3.dossier.marketDeep.ownerSnapshot.ageMs > d2.dossier.marketDeep.ownerSnapshot.ageMs, 'exact age grows; no freshness threshold');
      // a prior-session file (the tape wrote it "yesterday") => STALE_SESSION, missing MARKET_DEEP_OBSERVATION
      const yday = tsMs - 86_400_000; writeCurrentFeatureSnapshot('LINK', snapshotFor('LINK', yday), { tsMs: yday, session: sessionDate(new Date(yday)), symbol: 'LINK/USD' }); await b.tick(); ev = await hist(stores.journal);
      const d4 = rd(ev).at(-1); assert.equal(d4.dossier.marketDeep.state, 'OWNER_SNAPSHOT_STALE_SESSION'); assert.equal(d4.dossier.marketDeep.ownerSnapshot.state, 'STALE_SESSION'); assert.ok(d4.dossier.missing.some((m) => m.kind === 'MARKET_DEEP_OBSERVATION'));
      // zero market acquisition by RUMOR: only the Bluesky fake socket exists; the tape universe / book files are untouched by the research path
      assert.equal(b.sockets.length >= 1 && b.sockets.every((s) => typeof s.emit === 'function'), true); assert.ok(!readdirSync(path.join(dataDir(), 'tape')).includes('books'), 'no book file was ever written by RUMOR'); assert.ok(!readdirSync(path.join(dataDir(), 'tape')).includes('universe'), 'no universe file was ever written by RUMOR');
      assert.equal(replaySocialHistory(ev).ok, true); assert.equal(dir, dataDir());
      await b.c.stop();
    });
  });

  test('EPISODE-RESTART. a research episode goes DORMANT only through the idle law; a restart reproduces the same DORMANT state from durable truth; the next input opens a NEW episode identity referencing the previous one; the legacy-free journal replays with a contiguous episode index', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      const b = bootC({ ...stores, snapshot: accepted(cat), research: { enabled: true, options: { researchIdleTtlMs: 600_000 } } });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(11, '$LINK first wave')));
      await b.tick(); const first = rd(await hist(stores.journal))[0]; assert.equal(first.canonicalCoin, 'LINK'); assert.equal(first.episodeState, 'LIGHT_OBSERVING'); assert.equal(b.c.status().research.subjectList[0].episode.state, 'LIGHT_OBSERVING');
      await b.c.stop();
      const b2 = bootC({ ...mkStores(), snapshot: accepted(catalogOf(NON_MAJORS, T0 + 100_000)), clockMs: b.clock.ms + 2 * 600_000, research: { enabled: true, options: { researchIdleTtlMs: 600_000 } } });
      await b2.tick(); assert.equal(b2.c.status().research.episodes.dormant, 1, 'restart reproduces DORMANT from durable truth'); assert.equal(rd(await hist(stores.journal)).length, 1, 'silence writes nothing');
      b2.sockets.at(-1).emit('open'); b2.sockets.at(-1).emit('message', JSON.stringify(commit(12, '$LINK second wave', { did: 'did:plc:b' })));
      await b2.tick(); const ev = await hist(stores.journal); const ds = rd(ev); assert.equal(ds.length, 2);
      assert.equal(ds[1].episodeIndex, 2); assert.equal(ds[1].dossier.episode.basis, 'NEW_AFTER_DORMANT'); assert.notEqual(ds[1].episodeId, ds[0].episodeId); assert.equal(ds[1].dossier.episode.previousEpisodeId, ds[0].episodeId); assert.equal(ds[1].previousDossierId, ds[0].dossierId); assert.equal(validateResearchDossierEvent(ds[1]), null);
      assert.equal(canonicalJson(ds[0]), canonicalJson(first), 'the earlier episode is never rewritten'); assert.equal(b2.c.status().research.episodes.dormant, 0); assert.equal(b2.c.status().research.subjectList[0].episode.state, 'LIGHT_OBSERVING');
      const rp = replaySocialHistory(ev); assert.equal(rp.ok, true); assert.deepEqual(rp.research.byCoin.get('LINK').map((x) => x.episodeIndex), [1, 2]); assert.equal(SOCIAL_OBSERVATION_TYPES.length, 2);
      await b2.c.stop();
    });
  });
}
