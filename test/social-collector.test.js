// SOCIAL-2A — Bluesky auto-drain INSIDE the single-writer RUMOR collector
// (§21/§22/§26/§27/§30): explicit gate OFF by default; the ear becomes ACTIVE
// only after writer authority is positively held; evidence + durable cursor
// settle as ONE epoch-fenced batch and advance the event-root watermark; the
// collector restores over a journal carrying Social history (the latent RED:
// the frozen replay must never see social event kinds); writer loss stops the
// ear immediately; Social truth never enters graph/claims/packets. Real
// PostgreSQL; fake sockets; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRumor2 } from '../rumor2/collector.js';
import { SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE } from '../rumor2/social-settle.js';
import { BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';

const dirs = [];
function seedDir() { const d = mkdtempSync(path.join(tmpdir(), 'cobra-soccol-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; }
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CONFIG = { universe: ['BTC', 'ETH', 'SOL'] };
const T1 = Date.parse('2026-09-05T12:00:00Z');
const C = T1 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const H = { get: () => null };
const mkRes = (status, body = '') => ({ status, headers: H, text: async () => body });
const rssItem = (i) => `<item><title>${i.title}</title><link>https://blog.kraken.com/p/${i.guid}</link><guid>${i.guid}</guid><pubDate>${new Date(C).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`;
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>f</title>${items.map(rssItem).join('')}</channel></rss>`;
const LISTING = { title: 'BTC trading starts on Kraken', guid: 'listing-1', desc: 'Bitcoin (BTC) is now available for trading.' };
const commit = (seq, text, { rkey = `r${seq}`, op = 'create' } = {}) =>
  ({ $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:a', seq, time: iso(C), operation: op, collection: 'app.bsky.feed.post', rkey, cid: op === 'delete' ? undefined : `cid${seq}`, record: op === 'delete' ? undefined : { $type: 'app.bsky.feed.post', text, createdAt: iso(C) } } });
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; h.close?.(); }, closed: false }; }

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL collector integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `soccol_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, repo, mkStores: () => ({ checkpointStore: rumor2CheckpointStore({ persistence }), journal: rumor2JournalStore({ persistence }) }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => {
    const { rows } = await admin.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`);
    for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
    return rows.length;
  };
  const waitFor = async (pred, ms = 5000) => { let w = 0; while (!pred() && w < ms) { await new Promise((r) => setTimeout(r, 50)); w += 50; } return pred(); };
  const boot = ({ checkpointStore, journal, feedItems = [], clockMs = T1, social = {} }) => {
    seedDir();
    const clock = { ms: clockMs };
    const c = startRumor2({
      log: () => {}, config: CONFIG,
      fetchImpl: async (u) => (new URL(u).hostname === 'blog.kraken.com' ? mkRes(200, rss(feedItems)) : mkRes(304, '')),
      now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore, journal, contact: 'ops@example.com', enabled: true, timeoutMs: 5000,
      ...social,
    });
    return { c, clock, tick: async (adv = 4_000_000) => ((clock.ms += adv), await c.tickOnce()) };
  };
  const hist = async (journal) => (await journal.read()).events;
  const social = (events) => events.filter((e) => e.type === SOCIAL_EVENT_TYPE);
  const cursors = (events) => events.filter((e) => e.type === SOCIAL_CURSOR_EVENT_TYPE).map((e) => e.durableCursor);

  test('COL-1 (§27). the Bluesky ear is OFF by default — no runtime, no stream, no social events', async () => {
    await withDb(async ({ mkStores }) => {
      const b = boot({ ...mkStores() });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.social.enabled, false); assert.equal(st.social.state, 'DARK');
      assert.equal(b.c.internals.social, null);
      assert.equal(social(await hist(mkStores().journal)).length, 0);
      await b.c.stop();
    });
  });

  test('COL-2 (§26/§15/§30). enabled: evidence + durable cursor settle as one fenced batch, the watermark advances, Social never touches graph/claims/packets', async () => {
    await withDb(async ({ mkStores }) => {
      const stores = mkStores();
      const fixtures = [commit(100, 'BTC is listing'), commit(101, 'no coin here'), commit(102, 'ETH upgrade live'), commit(103, 'Bitcoin news')];
      const b = boot({ ...stores, feedItems: [LISTING], social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: fixtures } });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.lifecycle, 'FRESH_START'); assert.equal(st.writerAuthority, 'ACTIVE');
      assert.equal(st.social.state, 'ACTIVE'); assert.equal(st.social.hydrated, true);
      const ev = await hist(stores.journal);
      const soc = social(ev);
      assert.equal(soc.length, 3, 'BTC / ETH / Bitcoin(alias) admitted; the off-universe frame filtered');
      assert.deepEqual(cursors(ev), [103], 'the durable cursor covers the whole processed batch, including the filtered frame');
      assert.equal(ev[ev.length - 1].type, SOCIAL_CURSOR_EVENT_TYPE, 'cursor LAST');
      assert.equal(st.social.durableCursor, 103);
      assert.equal(st.lastSettledEventSeq, ev.length, 'the event-root watermark advanced over the Social batch');
      // ZERO AUTHORITY: the official listing produced the only claim; Social produced none
      assert.equal(st.counters.sourcesObserved, 1, 'Social evidence is not an official source observation');
      assert.equal(st.counters.claimsObserved, 1); assert.equal(st.activeClaims, 1);
      assert.ok(!ev.some((e) => e.type === 'RUMOR2_CLAIM_OBSERVED' && e.provider === 'BLUESKY_OFFICIAL'));
      assert.ok(!ev.some((e) => e.type === 'RUMOR2_PACKET' && e.provider === 'BLUESKY_OFFICIAL'));
      assert.equal(st.social.authority, 'NONE');
      for (const e of soc) assert.equal(e.providerKind, 'SOCIAL_MICROBLOG');
      // the durable checkpoint carries the watermark (validated on restore)
      const cp = await stores.checkpointStore.load();
      assert.equal(cp.outcome, 'LOADED'); assert.equal(cp.state.lastSettledEventSeq, ev.length);
      await b.c.stop();
    });
  });

  test('COL-3 (RED C -> GREEN / PASS 10). restart over a journal carrying Social history: RESTORED, dedupe + cursor rebuilt, redelivery deduped, core truth intact', async () => {
    await withDb(async ({ mkStores }) => {
      const s1 = mkStores();
      const a = boot({ ...s1, feedItems: [LISTING], social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [commit(100, 'BTC is listing')] } });
      await a.tick(); await a.c.stop();
      const before = await hist(s1.journal);
      assert.equal(social(before).length, 1);
      // fresh process, same schema, the SAME fixture redelivered (at-least-once)
      const s2 = mkStores();
      const b = boot({ ...s2, feedItems: [LISTING], social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [commit(100, 'BTC is listing'), commit(104, 'SOL news')] } });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.lifecycle, 'RESTORED', 'the frozen core restored — Social history did not withhold it');
      assert.equal(st.withholdReason, null);
      assert.equal(st.social.durableIndexSize, 2); assert.equal(st.social.durableCursor, 104);
      assert.equal(st.social.stream.intake.durableDeduped, 1, 'the redelivered frame was recognized as durable');
      const after = await hist(s2.journal);
      assert.equal(social(after).length, 2, 'one new version; no duplicate of the old');
      assert.deepEqual(cursors(after), [100, 104]);
      assert.equal(st.counters.claimsObserved, 1); assert.equal(st.activeClaims, 1, 'core graph unchanged by Social');
      await b.c.stop();
      // a THIRD restart must also restore cleanly (checkpoint + journal + social)
      const s3 = mkStores();
      const c3 = boot({ ...s3, feedItems: [LISTING], social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [] } });
      await c3.tick();
      assert.equal(c3.c.status().lifecycle, 'RESTORED'); assert.equal(c3.c.status().social.durableCursor, 104);
      await c3.c.stop();
    });
  });

  test('COL-3b. a collector WITHOUT the gate restores over Social history too (source-only events never withhold the core)', async () => {
    await withDb(async ({ mkStores }) => {
      const s1 = mkStores();
      const a = boot({ ...s1, social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [commit(100, 'BTC is listing')] } });
      await a.tick(); await a.c.stop();
      const b = boot({ ...mkStores() });
      await b.tick();
      assert.equal(b.c.status().lifecycle, 'RESTORED'); assert.equal(b.c.status().social.enabled, false);
      await b.c.stop();
    });
  });

  test('COL-4 (PASS 9 / §21). writer loss stops the Social stream immediately: no append, no cursor advance; reacquisition resumes from the durable cursor', async () => {
    await withDb(async ({ mkStores, admin }) => {
      const stores = mkStores();
      const sockets = [];
      const b = boot({ ...stores, social: { socialBlueskyEnabled: true, socialMode: 'LIVE', socialSocketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; } } });
      await b.tick();
      assert.equal(sockets.length, 1, 'the ear opened one socket after authority was acquired');
      sockets[0].emit('open'); sockets[0].emit('message', JSON.stringify(commit(100, 'BTC is listing')));
      await b.tick();
      assert.deepEqual(cursors(await hist(stores.journal)), [100]);
      // a frame arrives, then the advisory session dies before the next settle
      sockets[0].emit('message', JSON.stringify(commit(101, 'ETH news')));
      assert.ok((await killAdvisoryBackends(admin)) >= 1);
      assert.equal(await waitFor(() => stores.journal.writerHeld() === false), true);
      // hold reacquisition back for one tick so the standby posture is observable
      const origAcquire = stores.journal.acquireWriter;
      stores.journal.acquireWriter = async () => ({ ok: false, reason: 'HELD' });
      await b.tick();
      const st = b.c.status();
      assert.equal(st.lifecycle, 'STANDBY_WRITER'); assert.equal(st.writerAuthority, 'STANDBY');
      assert.equal(st.social.state, 'STANDBY'); assert.equal(st.social.stream, null, 'no zombie stream');
      assert.equal(sockets[0].closed, true, 'the socket was closed');
      const h2 = await hist(stores.journal);
      assert.equal(social(h2).length, 1, 'no stale append'); assert.deepEqual(cursors(h2), [100], 'no cursor advance');
      // reacquire: the next tick re-hydrates and reconnects from the durable cursor
      stores.journal.acquireWriter = origAcquire;
      await b.tick();
      const st2 = b.c.status();
      assert.equal(st2.writerAuthority, 'ACTIVE'); assert.equal(st2.social.state, 'ACTIVE');
      assert.equal(sockets.length, 2, 'a fresh socket'); assert.equal(st2.social.stream.resumeCursor, 100, 'resumed from the durable cursor');
      sockets[1].emit('open'); sockets[1].emit('message', JSON.stringify(commit(101, 'ETH news')));
      await b.tick();
      const h3 = await hist(stores.journal);
      assert.equal(social(h3).length, 2); assert.deepEqual(cursors(h3), [100, 101]);
      await b.c.stop();
      assert.equal(sockets[1].closed, true, 'clean shutdown closes the ear');
    });
  });

  test('COL-5 (PASS 11). corrupted Social history withholds the collector fail-closed', async () => {
    await withDb(async ({ mkStores }) => {
      const s1 = mkStores();
      const a = boot({ ...s1, social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [commit(100, 'BTC is listing')] } });
      await a.tick(); await a.c.stop();
      const j = mkStores().journal; assert.equal((await j.acquireWriter()).ok, true);
      const forged = { ...social(await hist(j))[0], sourceEventId: 'r2sv-' + 'c'.repeat(40), nativePostId: 'at://did:plc:a/app.bsky.feed.post/forged' };
      assert.equal((await j.append([forged])).ok, true); await j.releaseWriter();
      const b = boot({ ...mkStores(), social: { socialBlueskyEnabled: true, socialMode: 'REPLAY', socialFixtures: [] } });
      await b.tick();
      assert.equal(b.c.status().lifecycle, 'WITHHELD_INVALID_CHECKPOINT');
      assert.match(b.c.status().withholdReason, /SOCIAL_HISTORY_INVALID/);
      assert.equal(b.c.status().social.state, 'WITHHELD');
      await b.c.stop();
    });
  });
}
