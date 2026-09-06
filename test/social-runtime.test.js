// SOCIAL-2A — the durable Social resume law: received-vs-contiguous cursor
// ledger (§14/§18/§20), backpressure PAUSE (§19), cursor-last atomic settle
// (§15/§16), durable keep-first across restart and LRU eviction (§5-§8), and
// the crash-window matrix (§25) on real PostgreSQL. Pure passes use the shared
// in-memory journal; no network anywhere (fake sockets + timers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSocialFilter } from '../rumor2/social.js';
import { socialIntake, startSocialStream } from '../rumor2/social-stream.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { SOCIAL_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE, reconstructSocialWitness, socialObservationToEvent } from '../rumor2/social-settle.js';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { neynarEventToRaw, FARCASTER_OFFICIAL } from '../rumor2/providers/farcaster-official.js';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { memJournal } from './helpers/rumor2-journal.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-socrt-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const C = Date.parse('2026-09-05T12:00:00Z');
const iso = (m) => new Date(m).toISOString();
const FOO = buildSocialFilter({ terms: ['FOO'] });
// one Jetstream post commit per seq; text decides whether the universe filter admits it
const commit = (seq, text = '$FOO post', { rkey = `r${seq}`, op = 'create', did = 'did:plc:a' } = {}) =>
  ({ $type: 'message', payload: { $type: 'x#commit', did, seq, time: iso(C), operation: op, collection: 'app.bsky.feed.post', rkey, cid: op === 'delete' ? undefined : `cid${seq}`, record: op === 'delete' ? undefined : { $type: 'app.bsky.feed.post', text, createdAt: iso(C) } } });
const castV = (username, followers, likes) => ({ type: 'cast.created', data: { object: 'cast', hash: '0xV', author: { fid: 7, username, follower_count: followers, following_count: 50, power_badge: true }, text: '$FOO news', timestamp: iso(C), reactions: { likes_count: likes } } });
const socialOf = (events) => events.filter((e) => e.type === SOCIAL_EVENT_TYPE);
const cursorsOf = (events) => events.filter((e) => e.type === SOCIAL_CURSOR_EVENT_TYPE).map((e) => e.durableCursor);

function fakeTimers() { const q = []; let id = 1; return { setTimeoutImpl: (cb, ms) => { q.push({ id, cb, ms }); return id++; }, clearTimeoutImpl: (t) => { const i = q.findIndex((x) => x.id === t); if (i >= 0) q.splice(i, 1); }, runAll: () => { let g = 0; while (q.length && g++ < 1000) q.shift().cb(); }, pending: () => q.length }; }
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; h.close?.(); }, closed: false }; }

const mkIntake = (over = {}) => socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FOO, now: () => C + 10_000, ...over });

// ---- §14/§18/§20 the cursor ledger --------------------------------------------
test('RT-LEDGER-1. received moves on every frame; contiguous moves only past terminal frames', () => {
  const intake = mkIntake();
  assert.equal(intake.offer(commit(10, 'nothing relevant')).outcome, 'filtered');
  assert.deepEqual(intake.cursor(), { received: 10, contiguous: 10 }, 'a filtered frame is terminal');
  assert.equal(intake.offer(commit(20)).outcome, 'enqueued');
  assert.deepEqual(intake.cursor(), { received: 20, contiguous: 19 }, 'an enqueued frame is NOT terminal — contiguous stays below it');
  assert.equal(intake.offer(commit(30, 'unrelated')).outcome, 'filtered');
  assert.deepEqual(intake.cursor(), { received: 30, contiguous: 19 }, 'later terminal frames cannot leapfrog an unsettled one');
  const envs = intake.drain();
  assert.equal(envs.length, 1); assert.equal(envs[0].providerCursor, 20);
  assert.equal(intake.projectedCursor(envs), 30, 'projection: if the batch were terminal, contiguous = received');
  assert.equal(intake.cursor().contiguous, 19, 'projection is pure — nothing advanced');
  intake.settled(envs);
  assert.deepEqual(intake.cursor(), { received: 30, contiguous: 30 });
  assert.equal(intake.pendingCount(), 0);
});

test('RT-LEDGER-2 (§24). contiguous is monotonic — a replayed older frame never regresses it', () => {
  const intake = mkIntake();
  intake.offer(commit(10, 'x')); intake.offer(commit(20, 'x'));
  assert.equal(intake.cursor().contiguous, 20);
  assert.equal(intake.offer(commit(5)).outcome, 'enqueued', 'an older frame replayed (at-least-once)');
  assert.equal(intake.cursor().contiguous, 20, 'no regression');
  intake.settled(intake.drain());
  assert.equal(intake.cursor().contiguous, 20);
});

test('RT-LEDGER-3 (§18). a queue-full DROP is NOT terminal: it pins contiguous until the frame is replayed', () => {
  const intake = mkIntake({ maxQueue: 1 });
  assert.equal(intake.offer(commit(10)).outcome, 'enqueued');
  const d = intake.offer(commit(20));
  assert.equal(d.outcome, 'dropped'); assert.equal(d.providerCursor, 20);
  assert.equal(intake.offer(commit(30, 'x')).outcome, 'filtered');
  assert.equal(intake.hasDropped(), true);
  intake.settled(intake.drain());
  assert.equal(intake.cursor().contiguous, 19, 'settling seq 10 cannot pass the dropped seq 20');
  assert.equal(intake.offer(commit(20)).outcome, 'enqueued', 'the replayed frame replaces its dropped record');
  assert.equal(intake.hasDropped(), false);
  intake.settled(intake.drain());
  assert.deepEqual(intake.cursor(), { received: 30, contiguous: 30 });
});

test('RT-LEDGER-4. durable-aware dedupe: the durable index wins over the local LRU', () => {
  const durable = new Set();
  const intake = mkIntake({ seenCap: 1, isDurable: (id) => durable.has(id) });
  const r = intake.offer(commit(10));
  durable.add(r.observation.socialVersionId);
  intake.offer(commit(11)); intake.offer(commit(12)); // evict seq 10 from the LRU
  const again = intake.offer(commit(10));
  assert.equal(again.outcome, 'deduped'); assert.equal(again.durable, true);
  assert.equal(intake.stats().durableDeduped, 1);
});

// ---- §19 backpressure pause + resume from the DURABLE cursor -------------------
test('RT-BACKPRESSURE (PASS 8). queue full pauses the stream; reconnect resumes from the durable cursor, never past dropped work', () => {
  const timers = fakeTimers();
  const intake = mkIntake({ maxQueue: 1 });
  const sockets = []; const urls = [];
  let durable = 10;
  const s = startSocialStream({
    provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE',
    buildUrl: ({ cursor }) => { urls.push(cursor); return `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`; },
    resumeCursor: () => durable,
    socketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl, backoffBaseMs: 1, maxReconnects: 5,
  }).start();
  assert.equal(urls[0], 10, 'the connect resumed from the DURABLE cursor, not a receive-side value');
  sockets[0].emit('open');
  sockets[0].emit('message', JSON.stringify(commit(11)));
  sockets[0].emit('message', JSON.stringify(commit(12))); // queue full -> dropped
  sockets[0].emit('message', JSON.stringify(commit(13))); // after pause: ignored (will be replayed)
  assert.equal(sockets[0].closed, true, 'the socket was closed (paused)');
  assert.equal(s.status().paused, true); assert.equal(s.status().backpressureEvents, 1);
  assert.equal(intake.stats().received, 2, 'no frame is consumed after the pause');
  assert.equal(intake.cursor().contiguous, 10, 'contiguous never passed the dropped frame');
  // settle the earlier work, then the reconnect replays from the durable cursor
  intake.settled(intake.drain()); durable = 11;
  timers.runAll();
  assert.equal(sockets.length, 2); assert.equal(urls[1], 11, 'reconnect resumed from the durable cursor (<= dropped seq 12)');
  assert.equal(s.status().paused, false);
  sockets[1].emit('open');
  sockets[1].emit('message', JSON.stringify(commit(12)));
  assert.equal(intake.size(), 1, 'the dropped frame was redelivered and enqueued');
  s.stop();
});

// ---- §15/§16 cursor-last atomic settle (PASS 5 / CRASH-5) ----------------------
const bootRuntime = ({ journal = null, fixtures = null, mode = 'REPLAY', provider, mapCommit, cursorOf, filter = FOO, nowMs = C + 10_000, intakeOptions = {}, socketFactory = null } = {}) => {
  const clock = { ms: nowMs };
  const rt = createSocialRuntime({
    ...(provider ? { provider, mapCommit, cursorOf } : {}),
    filter, now: () => clock.ms, mode, fixtures, socketFactory,
    buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`,
    intakeOptions, cursorOnlyIntervalMs: 0,
  });
  return { rt, clock };
};
const settleWith = (rt, journal, { fenceHeld = () => true } = {}) => rt.settle({ fenceHeld, append: (ev) => journal.append(ev), lookup: journal.hasEventIds ? (t, ids) => journal.hasEventIds(t, ids) : null });

test('RT-SETTLE-1 (PASS 5 / CRASH-5). the cursor event is built LAST from the same batch; a failed append advances nothing; retry is byte-identical', async () => {
  const arr = []; let fail = false;
  const journal = memJournal(arr, { failAppends: () => fail });
  const { rt } = bootRuntime({ fixtures: [commit(100), commit(101, 'unrelated'), commit(102)] });
  assert.equal(rt.hydrate([]).ok, true); assert.equal(rt.start().ok, true);
  fail = true;
  const r1 = await settleWith(rt, journal);
  assert.equal(r1.ok, false);
  assert.equal(rt.durableCursor(), null, 'no cursor advance without a durable append');
  assert.equal(rt.durableIndexSize(), 0); assert.equal(arr.length, 0);
  assert.equal(rt.status().pendingBatch.events, 3, 'batch retained whole: 2 evidence + 1 cursor');
  assert.equal(rt.status().pendingBatch.projectedCursor, 102);
  fail = false;
  const r2 = await settleWith(rt, journal);
  assert.equal(r2.ok, true); assert.equal(r2.appended, 2);
  assert.equal(arr[arr.length - 1].type, SOCIAL_CURSOR_EVENT_TYPE, 'cursor event is the LAST record of the batch');
  assert.equal(arr[arr.length - 1].durableCursor, 102);
  assert.equal(rt.durableCursor(), 102, 'adopted only after the durable commit');
  assert.equal(rt.status().pendingBatch, null);
  // there is no path that persists a cursor ahead of its evidence: the only
  // cursor record in the journal follows the evidence it covers
  const idx = arr.findIndex((e) => e.type === SOCIAL_CURSOR_EVENT_TYPE);
  assert.ok(idx === arr.length - 1 && socialOf(arr).length === 2);
  rt.stop();
});

test('RT-SETTLE-2 (CRASH-6). writer authority lost before append: no mutation, no cursor advance, stream stopped', async () => {
  const arr = []; let appends = 0;
  const journal = { append: async (ev) => { appends += 1; return memJournal(arr).append(ev); } };
  const { rt } = bootRuntime({ fixtures: [commit(100)] });
  rt.hydrate([]); rt.start();
  const r = await settleWith(rt, journal, { fenceHeld: () => false });
  assert.equal(r.ok, false); assert.equal(r.reason, 'WRITER_FENCE_LOST');
  assert.equal(appends, 0, 'no append attempted without authority');
  assert.equal(rt.durableCursor(), null); assert.equal(arr.length, 0);
  assert.equal(rt.isActive(), false, 'the stream stopped immediately'); assert.equal(rt.status().state, 'STANDBY');
});

test('RT-SETTLE-3. cursor-only progress: a tick of purely filtered frames still advances the durable cursor (rate-limited)', async () => {
  const arr = []; const journal = memJournal(arr);
  const { rt } = bootRuntime({ fixtures: [commit(100, 'x'), commit(101, 'y')] });
  rt.hydrate([]); rt.start();
  const r = await settleWith(rt, journal);
  assert.equal(r.ok, true); assert.equal(r.appended, 0);
  assert.deepEqual(cursorsOf(arr), [101]); assert.equal(rt.durableCursor(), 101);
  rt.stop();
});

// ---- real PostgreSQL: restart / eviction / crash-window matrix ----------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL runtime durable passes', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `socrt_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, admin, SCHEMA, mkJournal: () => rumor2JournalStore({ persistence }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => {
    const { rows } = await admin.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`);
    for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {});
    return rows.length;
  };
  const waitFor = async (pred, ms = 5000) => { let w = 0; while (!pred() && w < ms) { await new Promise((r) => setTimeout(r, 50)); w += 50; } return pred(); };
  const events = async (j) => (await j.read()).events;
  // a Farcaster runtime (diagnostics vary by delivery; no cursor domain)
  const fcRuntime = (over = {}) => bootRuntime({ provider: FARCASTER_OFFICIAL, mapCommit: neynarEventToRaw, cursorOf: null, ...over });
  const acquire = async (j) => { const w = await j.acquireWriter(); assert.equal(w.ok, true); return w; };

  test('RT-PG-1 (PASS 1 / CRASH-8 / §7). RESTART: a diagnostic-changed redelivery of a settled version is recognized as ALREADY DURABLE — keep first, no corruption', async () => {
    await withDb(async ({ mkJournal }) => {
      const jA = mkJournal(); await acquire(jA);
      const A = fcRuntime({ fixtures: [castV('oldname', 100, 10)] }); A.rt.hydrate([]); A.rt.start();
      const r = await settleWith(A.rt, jA);
      assert.equal(r.ok, true); assert.equal(r.appended, 1);
      A.rt.stop(); await jA.releaseWriter(); // runtime A destroyed
      // a COMPLETELY FRESH runtime B on the same schema — no shared memory
      const jB = mkJournal(); await acquire(jB);
      const B = fcRuntime({ fixtures: [castV('newname', 900, 88)] });
      const h = B.rt.hydrate(await events(jB));
      assert.equal(h.ok, true); assert.equal(h.durableIds, 1, 'the durable version index was rebuilt from the journal');
      B.rt.start();
      assert.equal(B.rt._intake().stats().durableDeduped, 1, 'the redelivery was recognized as already durable');
      const r2 = await settleWith(B.rt, jB);
      assert.equal(r2.ok, true); assert.equal(r2.appended, 0, 'no altered payload was sent to the journal');
      const soc = socialOf(await events(jB));
      assert.equal(soc.length, 1, 'ONE durable RUMOR2_SOCIAL_OBSERVED');
      const w = reconstructSocialWitness(soc[0]);
      assert.equal(w.handle, 'oldname'); assert.equal(w.authorMeta.followerCount, 100); assert.equal(w.engagement.likes, 10);
      B.rt.stop(); await jB.releaseWriter();
    });
  });

  test('RT-PG-2 (PASS 2 / §8). SEEN-CAP EVICTION: the LRU forgets the version; the durable layer still knows it', async () => {
    await withDb(async ({ mkJournal }) => {
      const j = mkJournal(); await acquire(j);
      const { rt } = fcRuntime({ fixtures: [castV('oldname', 100, 10)], intakeOptions: { seenCap: 2 } });
      rt.hydrate([]); rt.start();
      assert.equal((await settleWith(rt, j)).appended, 1);
      // evict V from the tiny LRU with distinct versions
      for (let i = 0; i < 5; i++) rt._feed(JSON.stringify({ type: 'cast.created', data: { object: 'cast', hash: `0x${i}`, author: { fid: 9 }, text: '$FOO other', timestamp: iso(C) } }));
      assert.equal(rt._intake().seenSize(), 2, 'LRU is tiny; V is evicted locally');
      const out = rt._intake().offer(castV('newname', 900, 88));
      assert.equal(out.outcome, 'deduped'); assert.equal(out.durable, true, 'the durable index recognized V');
      const r = await settleWith(rt, j);
      assert.equal(r.ok, true);
      const soc = socialOf(await events(j));
      assert.equal(soc.filter((e) => e.nativePostId === '0xV').length, 1, 'one durable truth for V');
      assert.equal(reconstructSocialWitness(soc.find((e) => e.nativePostId === '0xV')).handle, 'oldname');
      rt.stop(); await j.releaseWriter();
    });
  });

  test('RT-PG-3 (PASS 2b). even with the local index bypassed, the authoritative journal lookup blocks the altered re-append', async () => {
    await withDb(async ({ mkJournal }) => {
      const j = mkJournal(); await acquire(j);
      const A = fcRuntime({ fixtures: [castV('oldname', 100, 10)] }); A.rt.hydrate([]); A.rt.start();
      assert.equal((await settleWith(A.rt, j)).appended, 1); A.rt.stop();
      // a runtime that was NOT hydrated with the history (index empty) — the read-only lookup is the last line
      const B = fcRuntime({ fixtures: [castV('newname', 900, 88)] }); B.rt.hydrate([]); B.rt.start();
      assert.equal(B.rt._intake().stats().enqueued, 1, 'the local index did not know V');
      const r = await settleWith(B.rt, j);
      assert.equal(r.ok, true); assert.equal(r.appended, 0, 'the authoritative lookup caught it — nothing altered was appended');
      assert.equal(B.rt.isDurable(socialObservationToEvent(normalizeSocialObservation(neynarEventToRaw(castV('x', 1, 1)).raw, { nowMs: C + 1 }).observation).event.sourceEventId), true, 'the lookup result was learned into the index');
      assert.equal(socialOf(await events(j)).length, 1);
      B.rt.stop(); await j.releaseWriter();
    });
  });

  test('RT-PG-4 (PASS 3 / PASS 4). 100x the same delete = one truth; delete/recreate/delete = two distinct tombstones — durably', async () => {
    await withDb(async ({ mkJournal }) => {
      const j = mkJournal(); await acquire(j);
      const del110 = commit(110, '', { rkey: 'k', op: 'delete', did: 'did:plc:w' });
      const cycle = [commit(100, '$FOO v1', { rkey: 'k', did: 'did:plc:w' }), ...Array(100).fill(del110), commit(120, '$FOO v2', { rkey: 'k', did: 'did:plc:w' }), commit(130, '', { rkey: 'k', op: 'delete', did: 'did:plc:w' })];
      const { rt } = bootRuntime({ fixtures: cycle, filter: buildSocialFilter({ terms: ['FOO'], watchAuthorIds: ['did:plc:w'] }) });
      rt.hydrate([]); rt.start();
      const r = await settleWith(rt, j);
      assert.equal(r.ok, true); assert.equal(r.appended, 4, 'CREATE, DELETE@110, RECREATE, DELETE@130');
      const soc = socialOf(await events(j));
      assert.equal(new Set(soc.map((e) => e.socialSourceId)).size, 1, 'one stable post identity');
      assert.deepEqual(soc.map((e) => e.providerEventSeq), [100, 110, 120, 130]);
      assert.equal(soc.filter((e) => e.lifecycle === 'TOMBSTONE').length, 2, 'two distinct delete commits, two tombstones');
      assert.deepEqual(cursorsOf(await events(j)), [130]);
      rt.stop(); await j.releaseWriter();
    });
  });

  // ---- §25 crash-window matrix (Bluesky, real PG) ----
  const bskyBoot = (fixtures, over = {}) => bootRuntime({ fixtures, ...over });
  test('CRASH-1/2 (PASS 6). crash before normalize / before append: restart from the OLD durable cursor, redelivery settles exactly once', async () => {
    await withDb(async ({ mkJournal }) => {
      // A: frame received + enqueued, then the process dies before any append
      const jA = mkJournal(); await acquire(jA);
      const A = bskyBoot([commit(100)]); A.rt.hydrate([]); A.rt.start();
      assert.equal(A.rt._intake().stats().enqueued, 1);
      A.rt.stop(); await jA.releaseWriter(); // crash: nothing durable
      assert.equal(socialOf(await events(jA)).length, 0);
      // B: restart; the durable cursor is still the old one (none), the frame is redelivered
      const jB = mkJournal(); await acquire(jB);
      const B = bskyBoot([commit(100)]); const h = B.rt.hydrate(await events(jB));
      assert.equal(h.durableCursor, null, 'no cursor ever outran the missing evidence');
      B.rt.start();
      assert.equal((await settleWith(B.rt, jB)).appended, 1);
      assert.equal(socialOf(await events(jB)).length, 1, 'exactly once'); assert.deepEqual(cursorsOf(await events(jB)), [100]);
      B.rt.stop(); await jB.releaseWriter();
    });
  });

  test('CRASH-3 (PASS 7). evidence durable but the cursor record torn: restart replays, durable dedupe absorbs the duplicate, no corruption', async () => {
    await withDb(async ({ mkJournal }) => {
      const jA = mkJournal(); await acquire(jA);
      // simulate a non-atomic store that lost the trailing cursor record
      const torn = { append: (ev) => jA.append(ev.filter((e) => e.type !== SOCIAL_CURSOR_EVENT_TYPE)), hasEventIds: (t, ids) => jA.hasEventIds(t, ids) };
      const A = bskyBoot([commit(100)]); A.rt.hydrate([]); A.rt.start();
      assert.equal((await settleWith(A.rt, torn)).appended, 1);
      A.rt.stop(); await jA.releaseWriter();
      assert.equal(cursorsOf(await events(jA)).length, 0, 'no cursor record survived');
      const jB = mkJournal(); await acquire(jB);
      const B = bskyBoot([commit(100)]); const h = B.rt.hydrate(await events(jB));
      assert.equal(h.durableIds, 1); assert.equal(h.durableCursor, null);
      B.rt.start();
      assert.equal(B.rt._intake().stats().durableDeduped, 1, 'the replayed frame is a durable duplicate');
      const r = await settleWith(B.rt, jB);
      assert.equal(r.ok, true); assert.equal(r.appended, 0);
      assert.equal(socialOf(await events(jB)).length, 1, 'no duplicate, no corruption'); assert.deepEqual(cursorsOf(await events(jB)), [100], 'the cursor now follows the evidence');
      B.rt.stop(); await jB.releaseWriter();
    });
  });

  test('CRASH-4 (PASS 7/10). evidence + cursor landed atomically, crash right after: restart resumes from the durable cursor, evidence exactly once', async () => {
    await withDb(async ({ mkJournal }) => {
      const jA = mkJournal(); await acquire(jA);
      const A = bskyBoot([commit(100), commit(101, 'x'), commit(102)]); A.rt.hydrate([]); A.rt.start();
      const r = await settleWith(A.rt, jA);
      assert.equal(r.ok, true); assert.equal(r.durableCursor, 102);
      A.rt.stop(); await jA.releaseWriter(); // crash immediately after the commit
      const jB = mkJournal(); await acquire(jB);
      const urls = [];
      const B = bootRuntime({ mode: 'LIVE', socketFactory: () => fakeSocket() });
      B.rt.hydrate(await events(jB));
      assert.equal(B.rt.durableCursor(), 102, 'the durable cursor was restored from the journal');
      assert.equal(B.rt.durableIndexSize(), 2, 'the durable dedupe index was restored');
      // inclusive at-least-once replay from the durable cursor: seq 102 is redelivered
      B.rt.start();
      B.rt._feed(JSON.stringify(commit(102)));
      assert.equal(B.rt._intake().stats().durableDeduped, 1);
      B.rt._feed(JSON.stringify(commit(103)));
      const r2 = await settleWith(B.rt, jB);
      assert.equal(r2.ok, true); assert.equal(r2.appended, 1);
      assert.equal(socialOf(await events(jB)).length, 3, 'each version exactly once'); assert.deepEqual(cursorsOf(await events(jB)), [102, 103]);
      B.rt.stop(); await jB.releaseWriter();
    });
  });

  test('CRASH-6/7 (PASS 9). writer epoch lost: before append => no mutation, no cursor advance; after append => truth durable, restart resumes', async () => {
    await withDb(async ({ mkJournal, admin }) => {
      const j = mkJournal(); await acquire(j);
      const { rt } = bskyBoot([commit(100)]); rt.hydrate([]); rt.start();
      assert.equal((await settleWith(rt, j)).appended, 1); // CRASH-7 setup: evidence durable
      rt._feed(JSON.stringify(commit(101)));
      // the advisory session dies after the frame was fetched, before the append
      assert.ok((await killAdvisoryBackends(admin)) >= 1);
      assert.equal(await waitFor(() => j.writerHeld() === false), true);
      const r = await settleWith(rt, j, { fenceHeld: () => j.writerHeld() === true });
      assert.equal(r.ok, false); assert.equal(r.reason, 'WRITER_FENCE_LOST');
      assert.equal(rt.isActive(), false, 'stream stopped'); assert.equal(rt.durableCursor(), 100, 'no cursor advance');
      const hist = await events(j);
      assert.equal(socialOf(hist).length, 1, 'CRASH-7: the earlier truth remains durable'); assert.deepEqual(cursorsOf(hist), [100]);
      // reacquire + rehydrate: resume from the durable cursor
      await j.releaseWriter(); const j2 = mkJournal(); await acquire(j2);
      const B = bskyBoot([commit(101)]); B.rt.hydrate(await events(j2)); B.rt.start();
      assert.equal((await settleWith(B.rt, j2)).appended, 1);
      assert.deepEqual(cursorsOf(await events(j2)), [100, 101]);
      B.rt.stop(); await j2.releaseWriter();
    });
  });

  test('RT-PG-5 (PASS 11). forged Social / cursor history in the journal is rejected on hydrate (fail closed)', async () => {
    await withDb(async ({ mkJournal }) => {
      const j = mkJournal(); await acquire(j);
      const { rt } = bskyBoot([commit(100)]); rt.hydrate([]); rt.start();
      assert.equal((await settleWith(rt, j)).appended, 1); rt.stop();
      const hist = await events(j);
      const forgedSocial = { ...socialOf(hist)[0], sourceEventId: 'r2sv-' + 'b'.repeat(40) };
      assert.equal((await j.append([forgedSocial])).ok, true, 'the frozen journal stores any closed record; the SOCIAL validator is the guard');
      const B = bskyBoot([]); const h = B.rt.hydrate(await events(j));
      assert.equal(h.ok, false); assert.match(h.error, /SOCIAL_HISTORY_INVALID/);
      assert.equal(B.rt.start().ok, false, 'an unhydrated runtime cannot start');
      assert.equal(B.rt.status().state, 'WITHHELD');
      await j.releaseWriter();
    });
  });
}
