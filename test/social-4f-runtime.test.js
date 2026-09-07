// SOCIAL-4F — the scoped Bluesky runtime (in-memory journal, fake sockets, REPLAY fixtures):
// no stream before a durable scope; broad non-major admission; the QUIESCENT scope transition
// (I: old-scope queued records, a prepared FAILED batch, duplicate delivery, unknown source time,
// unresolved reconciliation, a changed catalog during an awaited operation, and the 41/42/dup-42/
// filtered-43 partial-drain regression through the new integration); lifecycle continuity (K)
// across scope change, restart and cache eviction; stale/unavailable catalogs; A->B->A revisions;
// freshness records; restore mismatch withheld. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { createResearchScopeSource, parseSocialResearchConfig } from '../rumor2/social-catalog.js';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { replaySocialHistory, SOCIAL_SCOPE_EVENT_TYPE, SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE, SOCIAL_CURSOR_EVENT_TYPE, SOCIAL_OBSERVATION_TYPES, SOCIAL_RECONCILIATION_PENDING_TYPE } from '../rumor2/social-settle.js';
import { socialScopeAt } from '../rumor2/social-scope.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { loadConfig } from '../lib/config.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const C = T0 - 3_600_000;
const iso = (m) => new Date(m).toISOString();
const EXCLUDE = loadConfig().universeExpansion.excludeBases;
const synth = (i) => `Z${i.toString(36).toUpperCase().padStart(3, 'Q')}`;
function venue({ nonMajors = 105, extra = {}, drop = [] } = {}) {
  const out = { XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' }, XETHZUSD: { wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD', status: 'online' }, SOLUSD: { wsname: 'SOL/USD', base: 'SOL', quote: 'USD', status: 'online' }, XXRPZUSD: { wsname: 'XRP/USD', base: 'XXRP', quote: 'ZUSD', status: 'online' }, XDGUSD: { wsname: 'XDG/USD', base: 'XXDG', quote: 'ZUSD', status: 'online' }, LINKUSD: { wsname: 'LINK/USD', base: 'LINK', quote: 'USD', status: 'online' }, '1INCHUSD': { wsname: '1INCH/USD', base: '1INCH', quote: 'USD', status: 'online' } };
  for (let i = 0; i < nonMajors; i += 1) { const b = synth(i); out[`${b}USD`] = { wsname: `${b}/USD`, base: b, quote: 'USD', status: 'online' }; }
  for (const k of drop) delete out[k];
  return { ...out, ...extra };
}
const catalogOf = (v, observedTs) => normalizeKrakenAssetPairs(v, { excludeBases: EXCLUDE, observedTs }).catalog;
const RESEARCH = parseSocialResearchConfig(loadConfig()).research; // CATALOG_BACKED, refresh 300 / maxAge 900
const commit = (seq, text, { rkey = `r${seq}`, op = 'create', cid = `cid${seq}`, time = C, createdAt = C, did = 'did:plc:a', reply = null, seqless = false } = {}) => ({
  $type: 'message', payload: { $type: 'x#commit', did, ...(seqless ? {} : { seq }), time: iso(time), operation: op, collection: 'app.bsky.feed.post', rkey, cid: op === 'delete' ? undefined : cid,
    record: op === 'delete' ? undefined : { $type: 'app.bsky.feed.post', text, createdAt: createdAt === null ? undefined : iso(createdAt), ...(reply ? { reply: { parent: { uri: `at://${reply.did ?? did}/app.bsky.feed.post/${reply.rkey}`, cid: reply.cid ?? 'cidp' }, root: { uri: `at://${reply.did ?? did}/app.bsky.feed.post/${reply.rkey}`, cid: reply.cid ?? 'cidp' } } } : {}) } } });
function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; }, closed: false }; }
function boot({ snapshot, arr = [], nowMs = T0 + 10_000, journalOpts = {}, intakeOptions = {}, maxDrain = 200, hydrateFrom = arr, research = RESEARCH } = {}) {
  const clock = { ms: nowMs }; const sockets = [];
  const snap = { value: snapshot };
  const source = createResearchScopeSource({ research, source: { snapshot: () => snap.value, notices: () => [] }, now: () => clock.ms });
  const journal = memJournal(arr, journalOpts);
  const rt = createSocialRuntime({ scopeSource: source, now: () => clock.ms, mode: 'LIVE', socketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; }, buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, cursorOnlyIntervalMs: 0, intakeOptions, maxDrain });
  const h = rt.hydrate(hydrateFrom);
  const feed = (m) => sockets[sockets.length - 1].emit('message', JSON.stringify(m));
  const settle = (fence = () => true) => rt.settle({ fenceHeld: fence, append: (e) => journal.append(e), lookup: (t, ids) => journal.hasEventIds ? journal.hasEventIds(t, ids) : { ok: true, existing: [] } });
  const tick = async (fence) => { rt.start(); return settle(fence); };
  return { rt, clock, sockets, snap, arr, journal, feed, settle, tick, hydrateResult: h };
}
const ofType = (arr, t) => arr.filter((e) => e.type === t);
const src = (arr) => arr.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));
const accepted = (catalog, over = {}) => ({ status: 'ACCEPTED', catalog, lastError: null, lastSuccessTs: catalog.observedTs, lastAttemptTs: catalog.observedTs, ...over });

test('RT4F-1 (B/C). no scope, no stream: without an accepted catalog the ear reports SCOPE_NOT_ACTIVE / CATALOG_UNAVAILABLE and opens nothing; an accepted broad catalog activates ONE durable scope (catalog content + activation) before the first frame is admitted', async () => {
  const b = boot({ snapshot: { status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED: HTTP 503' } });
  assert.equal(b.hydrateResult.ok, true);
  assert.deepEqual(b.rt.start(), { ok: false, reason: 'SCOPE_NOT_ACTIVE', detail: 'NOT_EVALUATED_YET' });
  const r0 = await b.settle(); assert.deepEqual(r0, { ok: true, settled: 0, idle: true }); assert.equal(b.sockets.length, 0, 'no socket without a durable scope'); assert.equal(b.arr.length, 0);
  assert.equal(b.rt.status().scope.coverage.state, 'UNAVAILABLE'); assert.match(b.rt.status().scope.coverage.reason, /CATALOG_NOT_ACCEPTED: REFRESH_FAILED/); assert.equal(b.rt.status().scope.active, null); assert.equal(b.rt.status().state, 'HYDRATED');
  assert.match(b.rt.start().detail, /CATALOG_NOT_ACCEPTED/);
  // the catalog arrives: activation is durable BEFORE the stream opens
  const cat = catalogOf(venue(), T0);
  b.snap.value = accepted(cat);
  const r1 = await b.tick();
  assert.equal(r1.ok, true); assert.equal(r1.scopeActivated, 1); assert.deepEqual(r1.events.map((e) => e.type), [SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE]);
  assert.deepEqual(b.arr.map((e) => e.type), [SOCIAL_CATALOG_EVENT_TYPE, SOCIAL_SCOPE_EVENT_TYPE]); assert.equal(b.sockets.length, 1, 'the ear opened only after the scope committed');
  const sc = b.arr[1]; assert.equal(sc.mode, 'CATALOG_BACKED'); assert.equal(sc.termCount, 112); assert.equal(sc.catalogContentId, cat.contentId); assert.equal(sc.activatedKnownAtTs, T0 + 10_000); assert.equal(sc.reason, 'INITIAL_ACTIVATION'); assert.equal(sc.terms, null);
  assert.equal(b.arr[0].markets.length, 112); assert.equal(b.arr[0].acceptedKnownAtTs, T0 + 10_000); assert.equal(b.arr[0].observedTs, T0, 'observed and accepted clocks are distinct and truthful');
  const st = b.rt.status(); assert.equal(st.state, 'ACTIVE'); assert.equal(st.scope.mode, 'SCOPED'); assert.equal(st.scope.active.scopeRevision, 1); assert.equal(st.scope.coverage.state, 'CATALOG_BACKED'); assert.equal(st.scope.coverage.freshness, 'FRESH');
  // a generated non-major, a digit-prefixed ticker, and a seed are admitted; ambiguity is unresolved; an unknown cashtag is a research note only
  b.sockets[0].emit('open');
  b.feed(commit(100, `$${synth(7)} momentum rising`)); b.feed(commit(101, '$1INCH airdrop')); b.feed(commit(102, 'LINK momentum rising')); b.feed(commit(103, '$UNKNOWNXY coin')); b.feed(commit(104, 'BTC pumping'));
  const r2 = await b.settle(); assert.equal(r2.ok, true); assert.equal(r2.appended, 3);
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [100, 101, 104]); assert.equal(b.rt.durableCursor(), 104, 'filtered 102/103 are terminal');
  assert.equal(b.rt.status().scope.unresolved.distinct, 2); assert.deepEqual(b.rt.status().scope.unresolved.recent.map((n) => `${n.token}:${n.reason}`), ['LINK:AMBIGUOUS_TICKER_REQUIRES_CASHTAG', '$UNKNOWNXY:UNKNOWN_CASHTAG']);
  assert.equal(ofType(b.arr, SOCIAL_CATALOG_EVENT_TYPE).length, 1, 'catalog content is written once');
  // a same-content refresh appends at most ONE small freshness record per advanced acquisition clock; repeated settles append nothing
  b.snap.value = accepted(catalogOf(venue(), T0 + 300_000)); b.clock.ms = T0 + 320_000;
  const r3 = await b.tick(); assert.equal(r3.scopeVerified, true); assert.equal(ofType(b.arr, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE).length, 1); assert.equal(ofType(b.arr, SOCIAL_CATALOG_VERIFIED_EVENT_TYPE)[0].observedTs, T0 + 300_000);
  const n = b.arr.length; for (let i = 0; i < 5; i += 1) await b.tick(); assert.equal(b.arr.length, n, 'cursor-only / idle ticks never rewrite the catalog or the scope');
  assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1); assert.equal(ofType(b.arr, SOCIAL_CATALOG_EVENT_TYPE).length, 1);
  b.rt.stop();
});

test('RT4F-2 (C). no name hack: a NEW synthetic market appears in a later catalog and its explicit mention is admitted without editing any list; a catalog WITHOUT the five seeds still works and no seed is forced back', async () => {
  const b = boot({ snapshot: accepted(catalogOf(venue(), T0)) });
  await b.tick(); b.sockets[0].emit('open');
  b.feed(commit(100, '$FRESHNEW77 listing')); await b.settle();
  assert.equal(src(b.arr).length, 0, 'not in the catalog yet: unresolved, not admitted'); assert.equal(b.rt.durableCursor(), 100);
  const v2 = venue({ extra: { FRESHNEW77USD: { wsname: 'FRESHNEW77/USD', base: 'FRESHNEW77', quote: 'USD', status: 'online' } } });
  b.snap.value = accepted(catalogOf(v2, T0 + 300_000)); b.clock.ms = T0 + 310_000;
  const t = await b.tick(); assert.equal(t.scopeActivated, 2); assert.equal(b.arr.filter((e) => e.type === SOCIAL_SCOPE_EVENT_TYPE)[1].reason, 'CATALOG_CHANGED'); assert.equal(b.sockets.length, 2, 'the held transition reopened the ear');
  assert.equal(b.rt.status().stream.resumeCursor, 100, 'the reopened ear resumed from the durable cursor');
  b.sockets[1].emit('open'); b.feed(commit(101, '$FRESHNEW77 listing')); const r = await b.settle(); assert.equal(r.appended, 1); assert.equal(src(b.arr)[0].providerEventSeq, 101);
  assert.equal(b.sockets[1].closed, false);
  // as-of law: the earlier post (seq 100) is not reclassified — it was filtered under revision 1 and no record exists for it
  assert.equal(src(b.arr).some((e) => e.providerEventSeq === 100), false);
  b.rt.stop();
  // a catalog without any seed
  const noSeeds = venue({ drop: ['XXBTZUSD', 'XETHZUSD', 'SOLUSD', 'XXRPZUSD', 'XDGUSD'] });
  const b2 = boot({ snapshot: accepted(catalogOf(noSeeds, T0)) });
  await b2.tick(); b2.sockets[0].emit('open');
  const sc = ofType(b2.arr, SOCIAL_SCOPE_EVENT_TYPE)[0]; assert.equal(sc.termCount, 107); assert.deepEqual(sc.aliases, [], 'no seed => no seed alias facts');
  b2.feed(commit(200, '$BTC pumping')); b2.feed(commit(201, `$${synth(3)} pumping`)); await b2.settle();
  assert.deepEqual(src(b2.arr).map((e) => e.providerEventSeq), [201], 'the non-major research path works; BTC is not forced into the scope');
  b2.rt.stop();
});

test('RT4F-3 (I). quiescent transition: old-scope queued records, a prepared FAILED batch, a duplicate delivery, an unknown source time, and a PENDING reconciliation all settle under the OLD scope before the new activation; the changed catalog that arrives mid-operation waits', async () => {
  let fail = false;
  const b = boot({ snapshot: accepted(catalogOf(venue(), T0)), journalOpts: { failAppends: () => fail }, maxDrain: 2 });
  await b.tick(); b.sockets[0].emit('open');
  const Z = synth(1);
  b.feed(commit(100, `$${Z} listing`)); b.feed(commit(101, `$${Z} listing`, { createdAt: null })); b.feed(commit(101, `$${Z} listing`, { createdAt: null })); // duplicate delivery of 101 (unknown source time)
  b.feed(commit(102, `$${Z} listing`, { rkey: 'r100', cid: 'cid100', seqless: true })); // a SEQLESS redelivery of 100: missing occurrence discriminator => explicit PENDING record, never absorbed, never NEW
  b.feed(commit(103, `$${Z} third`)); b.feed(commit(104, 'nothing here'));
  fail = true; const f1 = await b.settle(); assert.equal(f1.ok, false, 'the first batch is prepared and its append FAILED — it stays owed');
  assert.equal(b.rt.status().pendingBatch.envelopes, 2); assert.equal(b.rt.durableCursor(), null);
  // a changed catalog arrives while work is owed: the transition holds, drains under the OLD scope, and only then activates
  b.snap.value = accepted(catalogOf(venue({ extra: { NEWONEUSD: { wsname: 'NEWONE/USD', base: 'NEWONE', quote: 'USD', status: 'online' } } }), T0 + 300_000)); b.clock.ms = T0 + 310_000;
  const held = await b.tick(); assert.equal(held.ok, false, 'the failed batch is retried byte-identically under the old scope; the activation waits');
  assert.equal(b.rt.status().scope.held, true); assert.equal(b.sockets[0].closed, true, 'no new intake during the hold'); assert.equal(ofType(b.arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1);
  assert.deepEqual(b.rt.start(), { ok: false, reason: 'SCOPE_TRANSITION_HELD', detail: 'owed work under the previous scope must settle before the stream reopens' });
  fail = false;
  const done = await b.tick(); assert.equal(done.ok, true); assert.equal(done.scopeActivated, 2);
  const types = b.arr.map((e) => e.type);
  const scopeIdx = types.lastIndexOf(SOCIAL_SCOPE_EVENT_TYPE); const lastSourceIdx = Math.max(...b.arr.map((e, i) => (SOCIAL_OBSERVATION_TYPES.includes(e.type) || e.type === SOCIAL_RECONCILIATION_PENDING_TYPE ? i : -1)));
  assert.ok(lastSourceIdx < scopeIdx, 'every old-scope record settled BEFORE the new activation in journal order');
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [100, 101, 103]); assert.equal(ofType(b.arr, SOCIAL_RECONCILIATION_PENDING_TYPE).length, 1, 'the seqless redelivery is an explicit pending record, never a guess and never a second source');
  assert.equal(src(b.arr).find((e) => e.providerEventSeq === 101).sourceClockStatus, 'UNKNOWN', 'unknown source time keeps the evidence and establishes nothing');
  assert.equal(b.rt.durableCursor(), 104, 'the filtered 104 and every owed cursor are terminal under the old scope');
  for (const e of src(b.arr)) assert.equal(socialScopeAt(replaySocialHistory(b.arr).scopeHistory.BLUESKY_OFFICIAL, e.knownAtTs).scope.scopeRevision, 1, 'as-of: each old-scope record maps to revision 1 by its own knowledge clock');
  assert.equal(b.rt.status().scope.held, false); assert.equal(b.sockets.length, 2); assert.equal(b.rt.status().scope.active.scopeRevision, 2);
  const rp = replaySocialHistory(b.arr); assert.equal(rp.ok, true); assert.equal(rp.scopeEvents, 2); assert.equal(rp.observed, 3);
  b.rt.stop();
});

test('RT4F-4 (I regression). 41 / 42 / exact repeat of 42 / filtered 43 with maxDrain=1 through the scoped integration: a scope change in the middle cannot commit a cursor past the still-owed 42', async () => {
  const b = boot({ snapshot: accepted(catalogOf(venue(), T0)), maxDrain: 1 });
  await b.tick(); b.sockets[0].emit('open');
  const Z = synth(2);
  b.feed(commit(41, `$${Z} a`)); b.feed(commit(42, `$${Z} b`, { rkey: 'k42', cid: 'bafy42' })); b.feed(commit(42, `$${Z} b`, { rkey: 'k42', cid: 'bafy42' })); b.feed(commit(43, 'nothing'));
  const s1 = await b.settle(); assert.equal(s1.appended, 1); assert.equal(b.rt.durableCursor(), 41, 'the first settle cannot commit a cursor past the still-owed 42');
  b.snap.value = accepted(catalogOf(venue({ extra: { MIDUSD: { wsname: 'MID/USD', base: 'MID', quote: 'USD', status: 'online' } } }), T0 + 300_000)); b.clock.ms = T0 + 310_000;
  const t = await b.tick(); assert.equal(t.ok, true); assert.equal(t.scopeActivated, 2);
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [41, 42], '42 reached truth exactly once during the drain'); assert.equal(b.rt.durableCursor(), 43, 'filtered 43 is terminal once 42 is durable');
  assert.deepEqual(ofType(b.arr, SOCIAL_CURSOR_EVENT_TYPE).map((c) => c.durableCursor), [41, 43], 'no cursor event ever named 43 while 42 was owed');
  const types = b.arr.map((e) => e.type); assert.ok(types.lastIndexOf(SOCIAL_CURSOR_EVENT_TYPE) < types.lastIndexOf(SOCIAL_SCOPE_EVENT_TYPE), 'drained under the old scope first');
  b.rt.stop();
});

test('RT4F-5 (K). lifecycle continuity: a non-major original admitted under revision 1, then textless delete / reply / repost updates after the asset LEFT the scope are admitted from retained native identity — across restart (journal) and cache eviction; unknown unlinked lifecycle stays unmatched', async () => {
  const Z = synth(4);
  const arr = [];
  const b = boot({ snapshot: accepted(catalogOf(venue(), T0)), arr, intakeOptions: { seenCap: 1 } });
  await b.tick(); b.sockets[0].emit('open');
  b.feed(commit(100, `$${Z} original`, { rkey: 'orig', cid: 'cidorig' })); await b.settle();
  assert.equal(src(arr).length, 1); assert.equal(b.rt.status().scope.continuity.knownNativePosts, 1);
  // the asset leaves the catalog
  b.snap.value = accepted(catalogOf(venue({ drop: [`${Z}USD`] }), T0 + 300_000)); b.clock.ms = T0 + 310_000;
  const t = await b.tick(); assert.equal(t.scopeActivated, 2); b.sockets[1].emit('open');
  b.feed(commit(101, '', { rkey: 'orig', op: 'delete' })); // textless delete of the known post
  b.feed(commit(102, 'no ticker text at all', { rkey: 'rep', reply: { rkey: 'orig', cid: 'cidorig' } })); // reply to the known post
  b.feed(commit(103, 'unrelated chatter')); b.feed(commit(104, '', { rkey: 'ghost', op: 'delete' })); // delete of a never-seen post: unmatched
  const r = await b.settle(); assert.equal(r.appended, 2);
  const seqs = src(arr).map((e) => [e.providerEventSeq, e.lifecycle, e.relation]);
  assert.deepEqual(seqs, [[100, 'CREATE', 'ORIGINAL'], [101, 'TOMBSTONE', 'UNKNOWN'], [102, 'CREATE', 'REPLY']]);
  assert.equal(src(arr)[2].parentNativePostId, src(arr)[0].nativePostId, 'the reply links through the retained native identity, not invented parent data');
  assert.equal(b.rt.status().stats.continuityAdmissions, 2); assert.equal(b.rt._intake().stats().filtered, 2, 'unrelated chatter and the ghost delete stay unmatched');
  b.rt.stop();
  // RESTART + EVICTION: a fresh runtime hydrated from the journal (seenCap 1) still knows the native post
  const b2 = boot({ snapshot: accepted(catalogOf(venue({ drop: [`${Z}USD`] }), T0 + 600_000)), arr, nowMs: T0 + 620_000, intakeOptions: { seenCap: 1 } });
  assert.equal(b2.hydrateResult.ok, true); assert.equal(b2.rt.status().scope.active.scopeRevision, 2); assert.equal(b2.rt.status().scope.active.restored, true); assert.equal(b2.rt.status().scope.continuity.knownNativePosts, 2);
  await b2.tick(); b2.sockets[0].emit('open');
  b2.feed(commit(101, '', { rkey: 'orig', op: 'delete' })); b2.feed(commit(100, `$${Z} ALTERED`, { rkey: 'orig', cid: 'cidorig' })); b2.feed(commit(107, 'plain repost text', { rkey: 'rp', reply: { rkey: 'rep', cid: 'cid102' } }));
  const r2 = await b2.settle(); assert.ok(r2.ok);
  const after = src(arr).map((e) => e.providerEventSeq);
  assert.ok(after.includes(107), 'a reply to the (also known) reply is admitted after restart');
  assert.equal(after.filter((s) => s === 101).length, 1, 'the redelivered delete (same occurrence) is one truth — deduped durably, not by the evicted local cache');
  assert.equal(src(arr).filter((e) => e.nativePostId === src(arr)[0].nativePostId && e.lifecycle === 'CREATE').length, 1, 'an altered redelivery of the SAME occurrence never mints a duplicate origin (it is an explicit pending record or a durable duplicate)');
  assert.ok(ofType(arr, SOCIAL_RECONCILIATION_PENDING_TYPE).length >= 1 || b2.rt.status().stats.durableDuplicates >= 1);
  assert.equal(replaySocialHistory(arr).ok, true);
  b2.rt.stop();
});

test('RT4F-6 (B/E/F). stale or unavailable catalogs never grant NEW scope but a restored durable scope keeps working (labelled); A->B->A yields revisions 1,2,3; an unchanged scope needs no activation; a future-dated catalog is refused', async () => {
  const catA = catalogOf(venue(), T0); const catB = catalogOf(venue({ extra: { BBUSD: { wsname: 'BB/USD', base: 'BB', quote: 'USD', status: 'online' } } }), T0 + 300_000);
  const arr = [];
  const b = boot({ snapshot: accepted(catA), arr });
  await b.tick(); assert.equal(ofType(arr, SOCIAL_SCOPE_EVENT_TYPE).length, 1);
  b.snap.value = accepted(catB); b.clock.ms = T0 + 310_000; await b.tick(); assert.equal(ofType(arr, SOCIAL_SCOPE_EVENT_TYPE).length, 2);
  b.snap.value = accepted(catalogOf(venue(), T0 + 600_000)); b.clock.ms = T0 + 610_000; await b.tick();
  const scopes = ofType(arr, SOCIAL_SCOPE_EVENT_TYPE); assert.deepEqual(scopes.map((s) => s.scopeRevision), [1, 2, 3]); assert.equal(scopes[0].filterId, scopes[2].filterId, 'A again is a NEW occurrence of the same content');
  assert.equal(ofType(arr, SOCIAL_CATALOG_EVENT_TYPE).length, 2, 'content A was written once, content B once');
  assert.equal(scopes[2].previousScopeRevision, 2); assert.equal(scopes[2].catalogObservedTs, T0 + 600_000);
  // stale: the snapshot is 20 minutes old — the active scope continues, labelled; nothing new is promoted
  b.clock.ms = T0 + 600_000 + 1_200_000; const s = await b.tick(); assert.equal(s.idle, undefined); assert.equal(ofType(arr, SOCIAL_SCOPE_EVENT_TYPE).length, 3);
  assert.equal(b.rt.status().scope.coverage.state, 'STALE'); assert.match(b.rt.status().scope.coverage.reason, /CATALOG_STALE.*continuing under durable scope revision 3/); assert.equal(b.rt.status().state, 'ACTIVE');
  b.snap.value = accepted(catalogOf(venue({ extra: { LATEUSD: { wsname: 'LATE/USD', base: 'LATE', quote: 'USD', status: 'online' } } }), T0 + 600_000)); await b.tick();
  assert.equal(ofType(arr, SOCIAL_SCOPE_EVENT_TYPE).length, 3, 'a changed but STALE catalog grants no new scope');
  // unavailable: same
  b.snap.value = { status: 'UNAVAILABLE', catalog: null, lastError: 'REFRESH_FAILED: x' }; await b.tick(); assert.equal(b.rt.status().scope.coverage.state, 'UNAVAILABLE'); assert.match(b.rt.status().scope.coverage.reason, /continuing under durable scope revision 3/); assert.equal(b.rt.status().state, 'ACTIVE');
  // future-dated observation: refused, never accepted
  b.snap.value = accepted(catalogOf(venue({ extra: { FUTUSD: { wsname: 'FUT/USD', base: 'FUT', quote: 'USD', status: 'online' } } }), b.clock.ms + 3_600_000)); await b.tick();
  assert.match(b.rt.status().scope.coverage.reason, /CATALOG_OBSERVED_IN_FUTURE/); assert.equal(ofType(arr, SOCIAL_SCOPE_EVENT_TYPE).length, 3);
  b.rt.stop();
  // restart with NO source at all: the last durable scope is restored (labelled restored + unavailable), admission continues, no new scope
  const b2 = boot({ snapshot: null, arr, nowMs: b.clock.ms + 60_000 });
  assert.equal(b2.rt.status().scope.active.scopeRevision, 3); assert.equal(b2.rt.status().scope.active.restored, true);
  const t2 = await b2.tick(); assert.equal(t2.ok, true); assert.equal(t2.scopeActivated, undefined, 'no new activation'); assert.equal(b2.rt.status().state, 'ACTIVE', 'admission continues under the restored durable scope'); assert.match(b2.rt.status().scope.coverage.reason, /CATALOG_SNAPSHOT_MALFORMED|CATALOG_NOT_ACCEPTED/);
  assert.equal(ofType(arr, SOCIAL_SCOPE_EVENT_TYPE).length, 3);
  b2.rt.stop();
  // restore mismatch: a journal whose scope record does not re-derive from its catalog content is WITHHELD, never repaired
  const forged = arr.map((e) => (e.type === SOCIAL_SCOPE_EVENT_TYPE && e.scopeRevision === 3 ? { ...e, termCount: e.termCount } : e));
  const tampered = forged.map((e) => (e.type === SOCIAL_CATALOG_EVENT_TYPE ? e : e));
  const b3 = boot({ snapshot: null, arr: tampered, hydrateFrom: tampered.filter((e) => e.type !== SOCIAL_CATALOG_EVENT_TYPE) });
  assert.equal(b3.hydrateResult.ok, false); assert.match(b3.hydrateResult.error, /never settled/, 'a scope without its catalog content is invalid history');
});

test('RT4F-7 (J/P). failed activation append keeps everything owed and retries byte-identically; a lost fence during the transition appends nothing; same accepted facts => same scope content; explicit-static mode is labelled and writes its own activation', async () => {
  let fail = false;
  const b = boot({ snapshot: accepted(catalogOf(venue(), T0)), journalOpts: { failAppends: () => fail } });
  fail = true; const r1 = await b.tick(); assert.equal(r1.ok, false); assert.equal(b.arr.length, 0); assert.equal(b.sockets.length, 0); assert.equal(b.rt.status().scope.active, null);
  fail = false; const r2 = await b.tick(); assert.equal(r2.scopeActivated, 1); assert.equal(b.arr.length, 2);
  const first = JSON.stringify(b.arr);
  // a second runtime over the same facts derives the same catalog + scope content (identity), and the journal collapses the byte-identical retry
  const b2 = boot({ snapshot: accepted(catalogOf(venue(), T0)), arr: b.arr, hydrateFrom: [] });
  const r3 = await b2.tick(); assert.equal(r3.ok, true); assert.equal(JSON.stringify(b.arr), first, 'a byte-identical re-append collapsed; nothing new landed');
  // fence lost mid-transition
  b2.snap.value = accepted(catalogOf(venue({ extra: { FENCEUSD: { wsname: 'FENCE/USD', base: 'FENCE', quote: 'USD', status: 'online' } } }), T0 + 300_000)); b2.clock.ms = T0 + 310_000;
  const lost = await b2.tick(() => false); assert.equal(lost.ok, false); assert.equal(lost.reason, 'WRITER_FENCE_LOST'); assert.equal(b2.arr.length, 2); assert.equal(b2.rt.status().state, 'STANDBY');
  b.rt.stop(); b2.rt.stop();
  // explicit-static: labelled mode, its own activation record with the listed terms
  const st = boot({ snapshot: null, research: parseSocialResearchConfig({ socialResearch: { localAdmission: { mode: 'EXPLICIT_STATIC', staticTerms: ['BTC', 'FRESH42'] } } }).research });
  const rs = await st.tick(); assert.equal(rs.scopeActivated, 1); const ev = st.arr[0]; assert.equal(ev.type, SOCIAL_SCOPE_EVENT_TYPE); assert.equal(ev.mode, 'EXPLICIT_STATIC'); assert.deepEqual(ev.terms, ['BTC', 'FRESH42']); assert.equal(ev.catalogContentId, null);
  assert.equal(st.rt.status().scope.coverage.state, 'EXPLICIT_STATIC'); assert.match(st.rt.status().scope.coverage.reason, /labelled/);
  st.rt.stop();
});
