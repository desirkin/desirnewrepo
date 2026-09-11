// SOCIAL-5A — the research strainer through the ACTUAL collector seams with real PostgreSQL:
// durability / replay / fence (L1-L8), resource / no-spend (M1-M5), five-coin regression (N1-N3),
// the detached deep-observation membership seam, the injected deep-market adapter through the
// collector, and status auditability (§24). Synthetic catalogs, fake sockets, fake X HTTP,
// isolated PostgreSQL schemas. No live request, no config change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownAdvisoryHolders } from './helpers/pg-fence.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_OBSERVATION_TYPES, SOCIAL_SCOPE_EVENT_TYPE, RESEARCH_DOSSIER_EVENT_TYPE } from '../rumor2/social-settle.js';
import { validateResearchDossierEvent, researchDossierAt } from '../rumor2/social-research-dossier.js';
import { validateEvidencePacket } from '../evidence/contract.js';
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
const BEARER = 'closeout-bearer-never-logged';
const XCFG = (over = {}) => ({ enabled: true, bearer: BEARER, maxDailyPostReads: 1000, maxMonthlyPostReads: 20000, maxEstimatedDailyUsd: 5, maxSessionPostReads: null, liveSmokeMaxPostReads: null, priorityAccounts: [], propagationFocus: [], ...over });
const fakeXApi = () => { const state = { calls: 0 }; return { state, fetchImpl: async () => { state.calls += 1; throw new Error('no X request may happen in SOCIAL-5A'); } }; };
const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const NON_MAJORS = ['LINK', 'FRESH42', 'ZQQ7']; // no BTC / ETH / SOL / XRP / DOGE anywhere in the synthetic venue
// the composition-root notice / deep-observation seams, injected as fly.js does
const notice = (symbol, tsMs, over = {}) => ({ ts: iso(tsMs), tsMs, symbol, verdict: 'RIPPLE', zVol: 5.1, zRet: 2.2, extension: 3.9, liquidityNote: 'x', inDeepTape: false, usdVol24h: 3_000_000, ...over });
const rd = (arr) => arr.filter((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE);
const src = (arr) => arr.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-5a-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-5A durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { startRumor2 } = await import('../rumor2/collector.js');
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `s5a_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
  const bootC = ({ checkpointStore, journal, clockMs = T0, config = CONFIG(), snapshot = undefined, notices = [], deep = null, research = { enabled: true }, social = {}, mirror = null }) => {
    seedDir();
    const clock = { ms: clockMs }; const sockets = []; const snap = { value: snapshot }; const nl = { value: notices }; const dp = { value: deep };
    const source = snapshot === undefined ? null : { snapshot: () => snap.value, notices: () => nl.value, deepObservation: () => dp.value };
    const c = startRumor2({
      log: () => {}, config, fetchImpl: async () => mkRes(304, ''), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      researchCatalogSource: source, researchStrainer: research, ...(mirror ? { mirrorEvent: (e) => mirror.push(e) } : {}),
      socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
      ...social,
    });
    return { c, clock, sockets, snap, notices: nl, deep: dp, tick: async (adv = 30_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;

  test('L1/L7/L8/N1/N2/§24. a non-major Social frame settles durably, the strainer builds a participation-led dossier in the SAME fenced tick, the durable event validates and replays; restart restores it byte-identically; full-history and prefix replay agree; status answers the audit questions with authority NONE; no major appears anywhere', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000); const mirror = [];
      const deep = Object.freeze({ count: 2, date: '2026-09-07', selectedAt: iso(T0 - 7200_000), source: 'test current.json', coins: Object.freeze(['LINK', 'ZQQ7']) });
      const b = bootC({ ...stores, snapshot: accepted(cat), deep, mirror });
      await b.tick(); assert.equal(b.c.status().social.scope.active.scopeRevision, 1); assert.equal(b.c.status().research.subjects, 0); assert.equal(b.c.status().research.authority, 'NONE'); assert.equal(b.c.status().research.purpose, 'RESEARCH_ONLY');
      b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(61, '$FRESH42 just listed, deposits open')));
      await b.tick();
      let ev = await hist(stores.journal);
      assert.deepEqual(src(ev).map((e) => e.text), ['$FRESH42 just listed, deposits open']);
      assert.equal(rd(ev).length, 1, 'the strainer appended ONE dossier in the same tick the observation became durable');
      const d = rd(ev)[0]; assert.equal(validateResearchDossierEvent(d), null); assert.equal(d.canonicalCoin, 'FRESH42'); assert.deepEqual(d.entrances, ['PARTICIPATION_LED']); assert.equal(d.researchState, 'DATA_INSUFFICIENT'); assert.equal(d.knownAtTs, b.clock.ms);
      assert.equal(d.dossier.entrances.triggers[0].ref, src(ev)[0].sourceEventId); assert.ok(d.dossier.opportunityClock.dossierDerivedKnownAtTs >= src(ev)[0].knownAtTs);
      assert.equal(d.packetStatus, 'PACKET_UNREPRESENTABLE_V1_TRIGGER', 'raw Social participation has no exact serpent-evidence-1 trigger'); assert.equal(d.packet, null); assert.equal(d.packetId, null); assert.deepEqual(d.packetReasonCodes, ['PARTICIPATION_LED_ONLY']); assert.deepEqual(d.dossier.providerSymbols, { kraken: 'FRESH42/USD' });
      assert.equal(d.dossier.episode.basis, 'FIRST_DOSSIER'); assert.equal(d.episodeState, 'LIGHT_OBSERVING'); assert.equal(d.dossier.marketDeep.ownerSnapshot.state, 'NOT_PRESENT', 'no tape feature snapshot in this test venue: NOT_PRESENT, never zero');
      assert.equal(d.dossier.marketDeep.deepObservationMembership.state, 'ABSENT', 'FRESH42 is not in the deep-observation set'); assert.equal(d.dossier.marketDeep.state, 'NOT_CONNECTED'); assert.equal(d.dossier.executability.state, 'UNASSESSED');
      assert.ok(d.proposalKinds.includes('MARKET_DEEP_OBSERVATION_PROPOSED'));
      assert.deepEqual(d.dossier.participation.coverage.providers.map((p) => `${p.provider}:${p.state}`), ['BLUESKY_OFFICIAL:OBSERVED', 'X_OFFICIAL:NOT_QUERIED']);
      assert.ok(!canonicalJson(ev).includes('"BTC"') && !canonicalJson(ev).includes('"ETH"'), 'no legacy major appears in the research journal');
      assert.equal(rd(mirror).length, 1, 'the best-effort mirror saw the dossier');
      // status auditability
      const rs = b.c.status().research; assert.equal(rs.subjects, 1); assert.equal(rs.subjectList[0].canonicalCoin, 'FRESH42'); assert.equal(rs.subjectList[0].latest.dossierId, d.dossierId); assert.equal(rs.subjectList[0].latest.packetId, null); assert.equal(rs.subjectList[0].latest.packetStatus, 'PACKET_UNREPRESENTABLE_V1_TRIGGER'); assert.equal(rs.durableDossiers, 1); assert.equal(rs.deepMarket, 'NOT_CONNECTED'); assert.equal(rs.pendingOperation, null);
      assert.equal(rs.subjectList[0].episode.state, 'LIGHT_OBSERVING'); assert.equal(rs.shadowControl.status, 'NOT_CONNECTED', 'no population seam in this venue'); assert.equal(rs.marketBridge, 'NOT_CONNECTED');
      // full-history vs prefix replay
      const full = replaySocialHistory(ev); assert.equal(full.ok, true); assert.equal(full.research.count, 1);
      const prefix = replaySocialHistory(ev.slice(0, ev.indexOf(d) + 1)); assert.equal(canonicalJson(prefix.research.byCoin.get('FRESH42')), canonicalJson(full.research.byCoin.get('FRESH42')));
      assert.equal(researchDossierAt(full.research.byCoin.get('FRESH42'), d.derivedKnownAtTs - 1), null); assert.equal(researchDossierAt(full.research.byCoin.get('FRESH42'), d.derivedKnownAtTs).dossierId, d.dossierId);
      await b.c.stop();
      // RESTART: hydrated from the journal; the record is byte-identical; nothing is re-emitted for unchanged content
      const b2 = bootC({ ...mkStores(), snapshot: accepted(catalogOf(NON_MAJORS, T0 + 100_000)), clockMs: b.clock.ms + 60_000, deep }); // the same inputs => no new dossier (a changed deep-observation snapshot WOULD be new evidence)
      await b2.tick(); assert.equal(b2.c.status().lifecycle, 'RESTORED'); assert.equal(b2.c.status().research.durableDossiers, 1); assert.equal(b2.c.status().research.subjectList[0].latest.dossierId, d.dossierId);
      await b2.tick();
      const ev2 = await hist(stores.journal); assert.equal(rd(ev2).length, 1, 'unchanged content: no new dossier'); assert.equal(canonicalJson(rd(ev2)[0]), canonicalJson(d), 'historical bytes never rewritten');
      await b2.c.stop();
    });
  });

  test('M1-M5/N3/I-seam. market-led (wide-eye notice) and information-free research with X ENABLED but xWatch NOT_CONFIGURED makes ZERO X calls; a MARKET_DEEP_OBSERVATION_PROPOSED / SOCIAL_RESEARCH_PROPOSED record changes no tape subscription, no X rule and no config; an injected deep-market adapter through the collector yields measured executability; a stale prior-session deep file is STALE; the permission set stays the five majors', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000); const api = fakeXApi();
      const deep = Object.freeze({ count: 1, date: '2026-09-06', selectedAt: iso(T0 - 86_400_000), source: 'yesterday current.json', coins: Object.freeze(['LINK']) });
      let windows = 0;
      // ONE fixed window (a new window each tick would be new evidence and lawfully produce a new dossier)
      const deepMarketSource = (coin) => { windows += 1; return coin === 'LINK' ? { contractVersion: 1, venue: 'kraken', canonicalCoin: 'LINK', symbol: 'LINK/USD', windowStartTs: T0 - 60_000, windowEndTs: T0 - 1000, observedTs: T0 - 1000, knownAtTs: T0 - 500, state: 'SYNCHRONIZED', priceStart: 10, priceEnd: 10.3, trades: { source: 'test trade feed', count: 5, takerSideKnown: true, buyNotionalUsd: 4000, sellNotionalUsd: 1000, totalNotionalUsd: 5000 }, book: { source: 'test book', synchronized: true, observedTs: T0 - 1000, bids: [[10.29, 100], [10.2, 500]], asks: [[10.31, 100], [10.4, 500]] }, referenceNotionalsUsd: [500] } : null; };
      const b = bootC({ ...stores, snapshot: accepted(cat), notices: [notice('LINK', T0 - 5000, { verdict: 'MISSED', extension: 9.5 })], deep, research: { enabled: true, deepMarketSource }, social: { socialXEnabled: true, socialXConfig: XCFG(), socialXFetchImpl: api.fetchImpl } });
      await b.tick(); await b.tick();
      const ev = await hist(stores.journal); const ds = rd(ev); assert.equal(ds.length, 1, ds.map((x) => x.canonicalCoin));
      const d = ds[0]; assert.equal(d.canonicalCoin, 'LINK'); assert.deepEqual(d.entrances, ['MARKET_LED']); assert.equal(d.researchState, 'INVESTIGATE'); assert.equal(d.dossier.marketLight.notices[0].verdict, 'MISSED', 'MISSED is context, not rejection');
      assert.equal(d.packetStatus, 'PACKET_UNREPRESENTABLE_V1_TRIGGER', 'a MISSED notice is never relabelled WIDE_EYE_RIPPLE'); assert.equal(d.packet, null); assert.deepEqual(d.packetReasonCodes, ['MARKET_LED_MISSED_ONLY']); assert.equal(d.episodeState, 'ACTIVE_RESEARCH');
      assert.equal(api.state.calls, 0, 'ZERO X calls: xWatch NOT_CONFIGURED'); assert.equal(b.c.status().socialX.state, 'DARK'); assert.equal(b.c.status().socialResearch.paidWatch.configured.mode, 'NOT_CONFIGURED');
      assert.equal(d.dossier.marketDeep.state, 'SYNCHRONIZED'); assert.equal(d.dossier.executability.state, 'ASSESSED'); assert.equal(d.dossier.marketDeep.features.flow.netTakerNotionalUsd, 3000); assert.ok(d.dossier.marketDeep.features.book.spreadBps > 0); assert.equal(d.dossier.marketDeep.features.slippage[0].marketSell.coverage, 'FULL');
      assert.equal(d.dossier.marketDeep.deepObservationMembership.state, 'STALE', 'a prior-session deep file never masquerades as current'); assert.equal(d.dossier.marketDeep.deepObservationMembership.member, null);
      assert.ok(d.dossier.dependencies.nodes.some((n) => n.kind === 'MARKET_SNAPSHOT' && n.id === `market:${d.dossier.marketDeep.features.windowId}`), 'the injected window is a dependency node of marketDeep');
      assert.ok(windows >= 1); assert.equal(b.c.status().research.deepMarket, 'INJECTED_ADAPTER');
      // proposals change nothing: the deep-observation snapshot is the same frozen object, config values are untouched, X made no call
      assert.equal(b.deep.value, deep); assert.equal(Object.isFrozen(deep), true); assert.deepEqual(loadConfig().universe, ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']); assert.equal(loadConfig().socialResearch.xWatch.mode, 'NOT_CONFIGURED');
      for (const p of d.dossier.nextObservationProposals) { assert.equal(p.authority, 'NONE'); assert.equal(p.activation, 'NOT_AUTHORIZED'); }
      await b.c.stop();
    });
  });

  test('L2/L5/L6. a refused research append advances no research watermark and retries the SAME prepared event; the PostgreSQL store refuses an altered payload under the same identity as corruption; an exact re-append collapses', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000); let refuse = false; const attempts = [];
      const journal = { ...stores.journal, append: async (recs) => { if (recs.some((e) => e.type === RESEARCH_DOSSIER_EVENT_TYPE)) { attempts.push(canonicalJson(recs)); if (refuse) return { ok: false, reason: 'UNAVAILABLE: injected refusal' }; } return stores.journal.append(recs); } };
      const b = bootC({ ...stores, journal, snapshot: accepted(cat) });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(71, '$LINK listing')));
      refuse = true; await b.tick();
      let ev = await hist(stores.journal); assert.equal(rd(ev).length, 0, 'refused: nothing durable'); assert.equal(b.c.status().research.pendingOperation.coin, 'LINK'); assert.equal(b.c.status().research.durableDossiers, 0); assert.equal(b.c.status().research.subjectList[0].latest, null);
      await b.tick(); assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1], 'byte-identical retry of the prepared operation');
      refuse = false; await b.tick(); ev = await hist(stores.journal); assert.equal(rd(ev).length, 1); assert.equal(attempts.length, 3); assert.equal(attempts[2], attempts[0]); assert.equal(b.c.status().research.durableDossiers, 1); assert.equal(b.c.status().research.pendingOperation, null);
      const d = rd(ev)[0];
      const again = await stores.journal.append([d]); assert.equal(again.ok, true, 'an exact re-append collapses');
      const altered = await stores.journal.append([{ ...d, researchState: 'OBSERVING' }]); assert.equal(altered.ok, false); assert.match(altered.reason, /CORRUPTION/);
      assert.equal(rd(await hist(stores.journal)).length, 1);
      await b.c.stop();
    });
  });

  test('L3/L4. a stale writer cannot append a dossier; a fence lost after the async preparation (after the durable append, before adoption) adopts nothing and opens nothing; the lawful writer hydrates the committed dossier once from the journal', async () => {
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      // (1) stale writer: authority lost before the research tick => no dossier
      const b = bootC({ ...stores, snapshot: accepted(cat) });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(81, '$ZQQ7 rumor')));
      await b.tick(); assert.equal(rd(await hist(stores.journal)).length, 1);
      b.sockets.at(-1).emit('message', JSON.stringify(commit(82, '$ZQQ7 second post', { did: 'did:plc:b' })));
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
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(91, '$LINK fence case')));
      await b.tick();
      assert.equal(b.c.status().lifecycle, 'STANDBY_WRITER'); assert.equal(rd(await hist(stores.journal)).length, 1, 'journal-ahead durable truth'); assert.equal(b.c.status().research.durableDossiers, 0, 'NOT adopted by the lost writer'); assert.equal(b.c.status().research.journalAhead.coin, 'LINK');
      await b.tick(); // reacquire => re-hydrate from the journal
      assert.ok(['RESTORED', 'REBUILT_FROM_EVENT_HISTORY', 'FRESH_START'].includes(b.c.status().lifecycle), b.c.status().lifecycle);
      assert.equal(b.c.status().research.durableDossiers, 1); assert.equal(rd(await hist(stores.journal)).length, 1, 'hydrated once, never re-appended'); assert.equal(replaySocialHistory(await hist(stores.journal)).ok, true);
      await b.c.stop();
    });
  });

  test('O4/§12/§18 through the collector. a second evidence wave after the first dossier opens a later immutable dossier that references the earlier one (never edits it); a scope revision change inside the comparison span is disclosed as incomparable coverage', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores(); const cat = catalogOf(NON_MAJORS, T0 - 1000);
      const b = bootC({ ...stores, snapshot: accepted(cat) });
      await b.tick(); b.sockets.at(-1).emit('open'); b.sockets.at(-1).emit('message', JSON.stringify(commit(101, '$LINK wave one')));
      await b.tick(); const first = rd(await hist(stores.journal))[0]; assert.equal(first.canonicalCoin, 'LINK');
      // the catalog changes (a new listing): scope revision 2 => the next dossier discloses the boundary
      b.snap.value = accepted(catalogOf([...NON_MAJORS, 'NEWONE'], b.clock.ms)); await b.tick(300_000);
      assert.equal(b.c.status().social.scope.active.scopeRevision, 2);
      b.sockets.at(-1).emit('message', JSON.stringify(commit(102, '$LINK wave two', { did: 'did:plc:c' }))); await b.tick();
      const ev = await hist(stores.journal); const ds = rd(ev); assert.equal(ds.length, 2); assert.equal(ds[1].previousDossierId, first.dossierId); assert.equal(canonicalJson(ds[0]), canonicalJson(first));
      assert.ok(ds[1].dossier.participation.windows.w900s.comparability.reasons.includes('SOCIAL_SCOPE_CHANGED'), ds[1].dossier.participation.windows.w900s.comparability.reasons);
      assert.equal(ds[1].dossier.participation.windows.w900s.delta.countDelta, null, 'no acceleration is claimed across the scope boundary');
      assert.ok(ds[1].proposalKinds.includes('SOCIAL_RESEARCH_PROPOSED'));
      const rp = replaySocialHistory(ev); assert.equal(rp.ok, true); assert.equal(rp.research.byCoin.get('LINK').length, 2); assert.equal(rp.scopes.BLUESKY_OFFICIAL.scopeRevision, 2); assert.equal(ev.filter((e) => e.type === SOCIAL_SCOPE_EVENT_TYPE).length, 2);
      await b.c.stop();
    });
  });
}
