// SOCIAL-4D CLOSEOUT — cursor obligations + identity-conflict routing + annotation
// consistency + as-of isolation. Every RED here was reproduced against the untouched 37b2dab
// runtime with the ticket's script (synthetic inputs, in-memory journal, no network);
// these tests assert the CORRECT outcomes. Fixture provenance: the legacy corpora under
// test/fixtures/social-4d-legacy-d5db393-*.json were produced by the untouched d5db393 code
// and are NOT regenerated; every other input is synthetic and built inline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { neynarEventToRaw, FARCASTER_OFFICIAL } from '../rumor2/providers/farcaster-official.js';
import { xPostToRaw, X_OFFICIAL } from '../rumor2/providers/x-official.js';
import { normalizeSocialObservation, buildSocialFilter } from '../rumor2/social.js';
import {
  socialObservationToEvent, validateSocialEvent, replaySocialHistory, socialImmutableDigest, assessSocialEquivalence, sameDeclaration, socialSeenRecord,
  socialClockInterpretationEvent, validateSocialClockInterpretation, reconstructSocialWitness,
  SOCIAL_OBSERVATION_TYPES, SOCIAL_EVENT_V2_TYPE, SOCIAL_CLOCK_INTERPRETATION_TYPE, SOCIAL_RECONCILIATION_PENDING_TYPE, SOCIAL_CURSOR_EVENT_TYPE,
} from '../rumor2/social-settle.js';
import { createSocialReconciler } from '../rumor2/social-reconcile.js';
import { socialTemporalView, SOCIAL_VIEW_CONFLICT_STATE } from '../rumor2/social-view.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { canonicalJson } from '../rumor2/truth.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/social-4d-legacy-d5db393-UTC.json'), 'utf8'));
const fixtureCase = (p, label) => FIX.cases.find((c) => c.path === p && c.label === label);
const T_Z = '2026-09-06T12:00:00Z'; const T_MS = Date.parse(T_Z);
const FILTER = buildSocialFilter({ terms: ['BTC'], watchAuthorIds: ['did:plc:synthetic', 'fid:4242', 'fid:99', '42'] });
const LEGACY = fixtureCase('bsky_post', 'valid_z'); // one valid legacy observation whose original string was NOT retained
const T0 = LEGACY.event.knownAtTs; const T1 = T0 + 600_000; const T2 = T1 + 1_000;
const bsky = (createdAt, o = {}) => ({ payload: { $type: 'x#commit', did: o.did ?? 'did:plc:synthetic', seq: 'seq' in o ? o.seq : 41, time: 'time' in o ? o.time : '2026-09-06T13:59:00Z', operation: o.op ?? 'create', collection: 'app.bsky.feed.post', rkey: o.rkey ?? 'k1', cid: o.op === 'delete' ? undefined : (o.cid ?? 'bafysynthetic1'), record: o.op === 'delete' ? undefined : { $type: 'app.bsky.feed.post', text: o.text ?? 'synthetic $BTC fixture', createdAt } } });
const fc = (timestamp, o = {}) => ({ type: 'cast.created', data: { object: 'cast', hash: o.hash ?? '0xsyntheticcast1', author: { fid: 4242, username: o.username ?? 'fx_synthetic', follower_count: o.followers ?? 3 }, text: o.text ?? 'synthetic $BTC fixture', timestamp, parent_hash: null, reactions: { likes_count: o.likes ?? 1 } } });
const xp = (created_at, o = {}) => ({ data: { id: o.id ?? '100', text: o.text ?? 'synthetic $BTC fixture', author_id: '42', created_at, edit_history_tweet_ids: o.history ?? ['100'], public_metrics: { like_count: o.likes ?? 1 } } });
const MAP = { bsky: [BLUESKY_OFFICIAL, jetstreamCommitToRaw, jetstreamCursorOf], fc: [FARCASTER_OFFICIAL, neynarEventToRaw, null], x: [X_OFFICIAL, xPostToRaw, null] };
const obs = (p, msg, nowMs = T1) => { const r = MAP[p][1](msg); assert.ok(r.raw, r.reason); const n = normalizeSocialObservation(r.raw, { nowMs }); assert.ok(n.observation, n.reason); return n.observation; };
const asEvent = (o) => { const e = socialObservationToEvent(o).event; assert.equal(validateSocialEvent(e), null); return e; };
const src = (evs) => evs.filter((e) => SOCIAL_OBSERVATION_TYPES.includes(e.type));
const ann = (evs) => evs.filter((e) => e.type === SOCIAL_CLOCK_INTERPRETATION_TYPE);
const pend = (evs) => evs.filter((e) => e.type === SOCIAL_RECONCILIATION_PENDING_TYPE);
const cursors = (evs) => evs.filter((e) => e.type === SOCIAL_CURSOR_EVENT_TYPE);
const rec = (history) => { const r = createSocialReconciler({ provider: BLUESKY_OFFICIAL }); const h = replaySocialHistory(history); assert.ok(h.ok, h.error); r.hydrate(h); return r; };
const noise = (seq) => bsky('2026-09-06T12:00:02Z', { seq, rkey: `k${seq}`, cid: `bafy${seq}`, did: 'did:plc:other', text: 'unrelated garden discussion' }); // legitimately filtered: neither a watched author nor a universe term

// the REAL runtime over the shared in-memory journal (same laws as the PG store); the journal
// array is shared so restart pairs literally share one durable log
function boot({ p = 'bsky', arr = [], deliveries, nowMs = T1, maxDrain = 200, seenCap, maxQueue } = {}) {
  const [provider, mapCommit, cursorOf] = MAP[p]; const j = memJournal(arr);
  const rt = createSocialRuntime({ provider, mapCommit, cursorOf, filter: FILTER, now: () => nowMs, mode: 'REPLAY', fixtures: deliveries, log: () => {}, maxDrain, intakeOptions: { ...(seenCap ? { seenCap } : {}), ...(maxQueue ? { maxQueue } : {}) } });
  const h = rt.hydrate(arr); assert.equal(h.ok, true, h.error);
  const okLookup = async (type, ids) => ({ ok: true, existing: new Set(arr.filter((e) => e.type === type && ids.includes(e.sourceEventId)).map((e) => e.sourceEventId)) });
  const settle = ({ lookup = okLookup, append = (evs) => j.append(evs), fenceHeld = () => true } = {}) => rt.settle({ fenceHeld, append, lookup });
  return { rt, j, arr, settle, intake: () => rt._intake(), feed: (m) => rt._feed(JSON.stringify(m)) };
}
async function pipeline(opts) {
  const before = (opts.arr ?? []).map((e) => canonicalJson(e)); const b = boot(opts); b.rt.start();
  const res = await b.settle(opts.settle ?? {});
  for (let i = 0; i < before.length; i++) assert.equal(canonicalJson(b.arr[i]), before[i], `history row ${i} stays byte-identical`);
  return { ...b, res, appended: b.arr.slice(before.length), stats: b.rt.status().stats };
}

// =========================================================================================
// A. CURSOR OBLIGATIONS — a duplicate never settles the first receipt
// =========================================================================================
const A_FIXTURES = () => [bsky(T_Z), bsky('2026-09-06T12:00:01Z', { seq: 42, rkey: 'k42', cid: 'bafy42' }), bsky('2026-09-06T12:00:01Z', { seq: 42, rkey: 'k42', cid: 'bafy42' }), noise(43)];

test('A1. 41 / 42 / exact repeat of 42 / filtered 43 with maxDrain=1: the first settle cannot commit a cursor past the still-owed 42', async () => {
  const b = boot({ deliveries: A_FIXTURES(), maxDrain: 1 }); b.rt.start();
  const st = b.intake().stats(); assert.equal(st.enqueued, 2); assert.equal(st.deduped, 1); assert.equal(st.filtered, 1);
  assert.deepEqual(b.intake().obligation(42), { owed: 1, dropped: false }, 'the duplicate referred to the existing obligation without deleting it');
  assert.equal(b.intake().contiguousCursor ?? b.intake().cursor().contiguous, 40, 'nothing is contiguous while 41 and 42 are queued');
  const r1 = await b.settle(); assert.equal(r1.ok, true);
  assert.equal(b.rt.durableCursor(), 41, 'the durable cursor stops BEFORE the unprocessed 42');
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [41]); assert.equal(b.intake().size(), 1, '42 still queued'); assert.equal(b.intake().pendingCount(), 1, '42 still owed');
  const r2 = await b.settle(); assert.equal(r2.ok, true);
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [41, 42]); assert.equal(b.rt.durableCursor(), 43, 'filtered 43 is terminal once 42 is durable'); assert.equal(b.intake().pendingCount(), 0);
  assert.deepEqual(cursors(b.arr).map((c) => c.durableCursor), [41, 43], 'no cursor event ever named 43 while 42 was owed');
  b.rt.stop();
});

test('A2. crash after that first batch: a fresh runtime from durable history with inclusive replay brings 42 to truth exactly once', async () => {
  const a = boot({ deliveries: A_FIXTURES(), maxDrain: 1 }); a.rt.start(); assert.equal((await a.settle()).ok, true); assert.equal(a.rt.durableCursor(), 41);
  a.rt.stop(); // the non-durable queue is gone with the process
  const b = boot({ arr: a.arr, deliveries: A_FIXTURES() }); assert.equal(b.rt.durableCursor(), 41); b.rt.start(); // inclusive replay from the durable cursor redelivers 41 and 42
  const r = await b.settle(); assert.equal(r.ok, true);
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [41, 42], '42 reached truth exactly once'); assert.equal(b.rt.durableCursor(), 43);
  assert.equal(b.intake().stats().durableDeduped, 1, '41 was recognized as durable'); assert.equal(replaySocialHistory(b.arr).ok, true);
  b.rt.stop();
});

test('A3. the same reproduction under an append refusal: neither evidence nor cursor adopts; the retry uses the identical prepared payload', async () => {
  const b = boot({ deliveries: A_FIXTURES(), maxDrain: 1 }); b.rt.start();
  let attempts = 0; const captured = [];
  const failing = async (evs) => { attempts += 1; captured.push(canonicalJson(evs)); if (attempts === 1) return { ok: false, reason: 'UNAVAILABLE' }; return b.j.append(evs); };
  const f = await b.settle({ append: failing }); assert.equal(f.ok, false); assert.equal(b.arr.length, 0); assert.equal(b.rt.durableCursor(), null); assert.equal(b.intake().pendingCount(), 2, 'both 41 and 42 remain owed');
  const ok = await b.settle({ append: failing }); assert.equal(ok.ok, true); assert.equal(captured[0], captured[1], 'byte-identical retry'); assert.equal(b.rt.durableCursor(), 41); assert.equal(b.intake().pendingCount(), 1);
  b.rt.stop();
});

test('A4. duplicates before the drain, during retained lookup work, and after durable settlement never release an obligation or move a cursor early', async () => {
  const b = boot({ deliveries: [bsky(T_Z), bsky('2026-09-06T12:00:01Z', { seq: 42, rkey: 'k42', cid: 'bafy42' })] }); b.rt.start();
  const dup42 = bsky('2026-09-06T12:00:01Z', { seq: 42, rkey: 'k42', cid: 'bafy42' });
  b.feed(dup42); assert.equal(b.intake().stats().deduped, 1); assert.deepEqual(b.intake().obligation(42), { owed: 1, dropped: false });
  const failed = await b.settle({ lookup: async () => ({ ok: false, reason: 'UNAVAILABLE' }) }); assert.equal(failed.ok, false); assert.equal(b.intake().pendingCount(), 2, 'envelopes retained across the failed lookup stay owed');
  b.feed(dup42); assert.equal(b.intake().stats().deduped, 2); assert.deepEqual(b.intake().obligation(42), { owed: 1, dropped: false }, 'a duplicate during retained work changes nothing');
  assert.equal(b.rt.durableCursor(), null);
  const ok = await b.settle(); assert.equal(ok.ok, true); assert.equal(b.rt.durableCursor(), 42); assert.equal(b.intake().pendingCount(), 0); assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), [41, 42]);
  b.feed(dup42); assert.equal(b.intake().stats().durableDeduped, 1, 'after durable settlement the duplicate is a durable dedupe'); assert.equal(b.intake().pendingCount(), 0);
  const again = await b.settle(); assert.equal(again.ok, true); assert.equal(src(b.arr).length, 2); assert.equal(b.rt.durableCursor(), 42);
  b.rt.stop();
});

test('A5. larger batches, a tiny local cache, filtered traffic, and queue-full drop/replay: a cursor never passes an owed or dropped frame', async () => {
  // batches of 3 over interleaved duplicates and noise, with a cache of 1
  const seqs = [41, 42, 43, 44, 45];
  const deliveries = seqs.flatMap((s) => [bsky(T_Z, { seq: s, rkey: `k${s}`, cid: `bafy${s}` }), bsky(T_Z, { seq: s, rkey: `k${s}`, cid: `bafy${s}` }), noise(s + 100)]);
  const b = boot({ deliveries, maxDrain: 3, seenCap: 1 }); b.rt.start();
  const seen = []; let guard = 0;
  while (b.intake().size() > 0 && guard++ < 10) { const r = await b.settle(); assert.equal(r.ok, true); const c = b.rt.durableCursor(); const owed = [...seqs].filter((s) => b.intake().obligation(s) !== null); if (owed.length) assert.ok(c < Math.min(...owed), `cursor ${c} never passes owed ${owed}`); seen.push(c); }
  assert.deepEqual(src(b.arr).map((e) => e.providerEventSeq), seqs, 'each commit exactly once despite cache eviction'); assert.equal(b.rt.durableCursor(), 145); assert.equal(b.intake().pendingCount(), 0);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'monotonic');
  b.rt.stop();
  // pure obligation law under backpressure: drop, replay, and a drop of an already-owed cursor
  const it = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, filter: FILTER, now: () => T1, cursorOf: jetstreamCursorOf, maxQueue: 2 });
  const m = (s) => bsky(T_Z, { seq: s, rkey: `k${s}`, cid: `bafy${s}` });
  assert.equal(it.offer(m(41)).outcome, 'enqueued'); assert.equal(it.offer(m(42)).outcome, 'enqueued'); assert.equal(it.offer(m(43)).outcome, 'dropped');
  assert.deepEqual(it.obligation(43), { owed: 0, dropped: true }); assert.equal(it.hasDropped(), true);
  const e12 = it.drain(2); assert.equal(it.projectedCursor(e12), 42, 'the dropped 43 pins the projection');
  assert.equal(it.offer(m(42)).outcome, 'deduped', 'a duplicate of a drained-but-unsettled 42'); assert.deepEqual(it.obligation(42), { owed: 1, dropped: false }, 'still owed by its envelope');
  it.settled(e12); assert.equal(it.cursor().contiguous, 42); assert.equal(it.obligation(42), null);
  assert.equal(it.offer(m(43)).outcome, 'enqueued', 'the replay of the dropped frame'); assert.deepEqual(it.obligation(43), { owed: 1, dropped: false }); assert.equal(it.hasDropped(), false);
  const e3 = it.drain(); it.settled(e3); assert.equal(it.cursor().contiguous, 43); assert.equal(it.pendingCount(), 0);
  // a queue-full drop of a cursor that is ALREADY owed keeps the drop pending until its replay is seen
  assert.equal(it.offer(m(50)).outcome, 'enqueued'); assert.equal(it.offer(m(51)).outcome, 'enqueued');
  const seenEvicting = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, filter: FILTER, now: () => T1, cursorOf: jetstreamCursorOf, maxQueue: 1, seenCap: 1 });
  assert.equal(seenEvicting.offer(m(60)).outcome, 'enqueued'); assert.equal(seenEvicting.offer(m(61)).outcome, 'dropped'); assert.equal(seenEvicting.offer(m(60)).outcome, 'deduped');
  assert.deepEqual(seenEvicting.obligation(60), { owed: 1, dropped: false }); assert.deepEqual(seenEvicting.obligation(61), { owed: 0, dropped: true });
  const e60 = seenEvicting.drain(); seenEvicting.settled(e60); assert.equal(seenEvicting.cursor().contiguous, 60, 'pinned below the dropped 61');
  assert.equal(seenEvicting.offer(m(61)).outcome, 'enqueued'); seenEvicting.settled(seenEvicting.drain()); assert.equal(seenEvicting.cursor().contiguous, 61);
});

test('A6. X has no numeric provider cursor: queued work, duplicates, and a conflicting redelivery keep their semantics without an invented sequence or cursor event', async () => {
  const r = await pipeline({ p: 'x', deliveries: [xp('2026-09-06T12:00:00.100Z'), xp('2026-09-06T12:00:00.100Z', { likes: 99 }), xp('2026-09-06T12:00:00.200Z')] });
  const st = r.intake().stats(); assert.equal(st.enqueued, 2); assert.equal(st.deduped, 1, 'the diagnostic-only duplicate collapsed locally'); assert.equal(st.pending, 0, 'no cursor obligation is invented for X'); assert.equal(st.receivedCursor, null);
  assert.equal(src(r.appended).length, 1); assert.equal(src(r.appended)[0].providerEventSeq, null); assert.equal(pend(r.appended).length, 1); assert.equal(pend(r.appended)[0].reason, 'DECLARATION_CONFLICT'); assert.equal(pend(r.appended)[0].nativeKey.providerEventSeq, null);
  assert.equal(cursors(r.arr).length, 0, 'no cursor event exists for X'); assert.equal(r.rt.durableCursor(), null); assert.equal(r.intake()._peekKnownAts().length, 0, 'queued work fully settled');
  assert.equal(reconstructSocialWitness(src(r.appended)[0]).engagement.likes, 1, 'first-known diagnostics stand');
});

// =========================================================================================
// B. ONE SHARED EQUIVALENCE LAW ON EVERY DUPLICATE ROUTE
// =========================================================================================
test('B1. two fine-precision declarations of the same commit (.0005Z / .0006Z) before the first settle: ONE source plus an explicit DECLARATION_CONFLICT, never an unrecorded duplicate', async () => {
  const o5 = obs('bsky', bsky('2026-09-06T12:00:00.0005Z')); const o6 = obs('bsky', bsky('2026-09-06T12:00:00.0006Z'));
  assert.equal(o5.socialVersionId, o6.socialVersionId); assert.notEqual(o5.witnessHash, o6.witnessHash);
  const it = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, filter: FILTER, now: () => T1, cursorOf: jetstreamCursorOf });
  assert.equal(it.offer(bsky('2026-09-06T12:00:00.0005Z')).outcome, 'enqueued'); const d = it.offer(bsky('2026-09-06T12:00:00.0006Z')); assert.equal(d.outcome, 'enqueued'); assert.equal(d.deferred, 'DECLARATION_CONFLICT'); assert.equal(it.stats().deferred, 1); assert.equal(it.size(), 2);
  assert.deepEqual(it.obligation(41), { owed: 2, dropped: false }, 'both deliveries own an obligation unit');
  const r = await pipeline({ deliveries: [bsky('2026-09-06T12:00:00.0005Z'), bsky('2026-09-06T12:00:00.0006Z')] });
  assert.equal(src(r.appended).length, 1); assert.equal(src(r.appended)[0].sourceClockWitness.declared, '2026-09-06T12:00:00.0005Z'); assert.equal(pend(r.appended).length, 1); assert.equal(pend(r.appended)[0].reason, 'DECLARATION_CONFLICT'); assert.equal(pend(r.appended)[0].sourceClockWitness.declared, '2026-09-06T12:00:00.0006Z');
  assert.equal(r.rt.durableCursor(), 41); assert.equal(r.intake().pendingCount(), 0);
});

test('B2. the same input after durable settlement, after a restart, and with a tiny seen cache yields the same disposition', async () => {
  const e5 = asEvent(obs('bsky', bsky('2026-09-06T12:00:00.0005Z')));
  const after = await pipeline({ arr: [e5], deliveries: [bsky('2026-09-06T12:00:00.0006Z')] }); assert.equal(pend(after.appended).length, 1); assert.equal(src(after.appended).length, 0);
  const restart = await pipeline({ arr: after.arr, deliveries: [bsky('2026-09-06T12:00:00.0006Z'), bsky('2026-09-06T12:00:00.0005Z')] }); assert.equal(restart.appended.length, 0, 'the conflict is already retained; nothing repeats');
  const tiny = await pipeline({ deliveries: [bsky('2026-09-06T12:00:00.0005Z'), bsky('2026-09-06T12:00:00.0006Z'), bsky('2026-09-06T12:00:00.0005Z'), bsky('2026-09-06T12:00:00.0006Z')], seenCap: 1 });
  assert.equal(src(tiny.appended).length, 1); assert.equal(pend(tiny.appended).length, 1);
});

test('B3. URL-path case / whitespace / normalized-fingerprint-equal but exact-text-different inputs never pass as known immutable facts on any route', async () => {
  const mA = bsky(T_Z, { text: 'synthetic $BTC https://example.invalid/ABCD' }); const mB = bsky(T_Z, { text: 'synthetic $BTC https://example.invalid/abcd' });
  const a = obs('bsky', mA); const b = obs('bsky', mB); assert.equal(a.socialVersionId, b.socialVersionId, 'the folded fingerprint agrees'); assert.notEqual(socialImmutableDigest(a), socialImmutableDigest(b));
  assert.deepEqual(assessSocialEquivalence(socialSeenRecord(a), b), { verdict: 'CONFLICT', reason: 'IMMUTABLE_FACT_CONFLICT' });
  const r = rec([asEvent(a)]); assert.equal(r.isFastDurable(b.socialVersionId, b), false, 'the durable fast path defers'); const out = r.reconcile(b, r.batch({ knownAtTs: T1 })); assert.equal(out.kind, 'PENDING'); assert.equal(out.reason, 'IMMUTABLE_FACT_CONFLICT');
  const it = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, filter: FILTER, now: () => T1, cursorOf: jetstreamCursorOf }); it.offer(mA); const d = it.offer(mB); assert.equal(d.outcome, 'enqueued'); assert.equal(d.deferred, 'IMMUTABLE_FACT_CONFLICT');
  const batch = await pipeline({ deliveries: [mA, mB] }); assert.equal(src(batch.appended).length, 1); assert.equal(src(batch.appended)[0].text, a.text); assert.equal(pend(batch.appended).length, 1); assert.equal(pend(batch.appended)[0].candidate.text, b.text);
  const ws = await pipeline({ arr: [asEvent(a)], deliveries: [bsky(T_Z, { text: 'synthetic  $BTC   https://example.invalid/ABCD' })] }); assert.equal(src(ws.appended).length, 0); assert.equal(pend(ws.appended).length, 1); assert.equal(pend(ws.appended)[0].reason, 'IMMUTABLE_FACT_CONFLICT');
  const restart = await pipeline({ arr: batch.arr, deliveries: [mB], seenCap: 1 }); assert.equal(restart.appended.length, 0, 'the retained conflict record is idempotent');
});

test('B4. diagnostic-only redeliveries still dedupe and retain the first-known diagnostics', async () => {
  const first = asEvent(obs('fc', fc(T_Z)));
  const r = await pipeline({ p: 'fc', arr: [first], deliveries: [fc(T_Z, { username: 'renamed', followers: 9999, likes: 77 }), fc(T_Z, { username: 'renamed', followers: 9999, likes: 77 })] });
  assert.equal(r.appended.length, 0); assert.equal(r.intake().stats().durableDeduped + r.intake().stats().deduped, 2);
  const w = reconstructSocialWitness(r.arr[0]); assert.equal(w.handle, 'fx_synthetic'); assert.equal(w.authorMeta.followerCount, 3); assert.equal(w.engagement.likes, 1);
  const rc = createSocialReconciler({ provider: FARCASTER_OFFICIAL }); rc.hydrate(replaySocialHistory([first])); const o = obs('fc', fc(T_Z, { username: 'renamed', likes: 77 })); assert.equal(rc.isFastDurable(o.socialVersionId, o), true); assert.equal(rc.reconcile(o, rc.batch({ knownAtTs: T1 })).kind, 'KNOWN');
});

test('B5. equivalent offsets and trailing-zero precision padding remain legitimate same-instant matches', async () => {
  const e = asEvent(obs('bsky', bsky('2026-09-06T12:00:00.100Z')));
  const r = await pipeline({ arr: [e], deliveries: [bsky('2026-09-06T12:00:00.100000Z'), bsky('2026-09-06T08:00:00.100-04:00'), bsky('2026-09-06T12:00:00.1Z')] });
  assert.equal(src(r.appended).length + ann(r.appended).length + pend(r.appended).length, 0); assert.equal(r.intake().stats().durableDeduped, 3);
  const first = socialSeenRecord(obs('bsky', bsky('2026-09-06T12:00:00.100Z')));
  for (const t of ['2026-09-06T12:00:00.100000Z', '2026-09-06T08:00:00.100-04:00', '2026-09-06T12:00:00.1Z']) assert.equal(assessSocialEquivalence(first, obs('bsky', bsky(t))).verdict, 'EQUIVALENT', t);
  assert.equal(assessSocialEquivalence(first, obs('bsky', bsky('2026-09-06T12:00:00.1001Z'))).reason, 'DECLARATION_CONFLICT', 'a non-zero remainder is a different instant');
  // a differing provider EVENT clock is delivery diagnostics: first-known stands, no conflict record
  const pe = await pipeline({ arr: [e], deliveries: [bsky('2026-09-06T12:00:00.100Z', { time: '2026-09-06T13:59:30Z' })] }); assert.equal(src(pe.appended).length + ann(pe.appended).length + pend(pe.appended).length, 0);
  assert.equal(assessSocialEquivalence(first, obs('bsky', bsky('2026-09-06T12:00:00.100Z', { time: '2026-09-06T13:59:30Z' }))).reason, 'PROVIDER_EVENT_FIRST_KNOWN'); assert.equal(pe.arr[0].providerEventTs, e.providerEventTs);
});

test('B6. true new native versions and distinct Bluesky sequences remain separate', async () => {
  const c10 = fixtureCase('bsky_post', 'seq10'); const c20 = fixtureCase('bsky_post', 'seq20');
  const r = await pipeline({ arr: [c10.event], deliveries: [c20.msg] }); assert.equal(src(r.appended).length, 1); assert.equal(src(r.appended)[0].providerEventSeq, 20); assert.equal(pend(r.appended).length, 0);
  const x100 = fixtureCase('x_post', 'valid_z'); const rx = await pipeline({ p: 'x', arr: [x100.event], deliveries: [xp(T_Z, { id: '101', history: ['100', '101'] })] }); assert.equal(src(rx.appended).length, 1); assert.equal(src(rx.appended)[0].nativeVersionId, '101'); assert.equal(src(rx.appended)[0].lifecycle, 'EDIT');
});

test('B7. a failed lookup or a failed append cannot install a reconciliation cache entry that lets a later candidate bypass owed work', async () => {
  // same-identity legacy rows: 'edge_half_ms' (the strict witness changes the verdict => annotation) and
  // 'valid_z' (unchanged interpretation => KNOWN with no annotation; only the reconciled mark is learned)
  for (const [label, expectAnn] of [['edge_half_ms', 1], ['valid_z', 0]]) {
    const c = fixtureCase('bsky_post', label); const o = obs('bsky', c.msg); assert.equal(o.socialVersionId, c.event.sourceEventId, 'same identity: the fast path is the route under test');
    const b = boot({ arr: [c.event], deliveries: [c.msg] }); b.rt.start(); const rc = b.rt.reconciler();
    assert.equal(rc.isFastDurable(o.socialVersionId, o), false, 'a legacy row is never fast-durable before reconciliation');
    if (expectAnn === 1) { assert.equal((await b.settle({ lookup: async () => ({ ok: false, reason: 'UNAVAILABLE' }) })).ok, false); assert.equal(rc.isFastDurable(o.socialVersionId, o), false, 'a failed lookup installed nothing'); } // a KNOWN-only batch has nothing to look up
    let n = 0; assert.equal((await b.settle({ append: async () => { n += 1; return { ok: false, reason: 'UNAVAILABLE' }; } })).ok, false); assert.equal(n, 1); assert.equal(rc.isFastDurable(o.socialVersionId, o), false, 'a failed append installed nothing'); assert.equal(b.intake().pendingCount(), 1, 'the work is still owed');
    assert.equal(b.intake().offer(c.msg).outcome, 'deduped'); assert.equal(b.intake().stats().durableDeduped, 0, 'the duplicate was a LOCAL cache hit (equivalent first-seen record), never a durable claim');
    assert.equal((await b.settle()).ok, true); assert.equal(ann(b.arr).length, expectAnn); assert.equal(rc.isFastDurable(o.socialVersionId, o), true, 'only durable adoption installs the entry');
    b.rt.stop();
    const b2 = boot({ arr: b.arr, deliveries: [c.msg] }); b2.rt.start(); assert.equal(b2.rt.reconciler().isFastDurable(o.socialVersionId, o), expectAnn === 1, 'a durable annotation hydrates the fast path; an in-process mark does not survive restart (settle re-decides KNOWN)');
    assert.equal((await b2.settle()).ok, true); assert.equal(src(b2.arr).length + ann(b2.arr).length + pend(b2.arr).length, 1 + expectAnn, 'nothing repeats'); b2.rt.stop();
  }
});

// =========================================================================================
// C. MISSING OCCURRENCE IDENTITY
// =========================================================================================
test('C1. existing seq=41 plus a seq-less candidate (either side lacking the discriminator) => PENDING, not NEW, not absorbed', async () => {
  const m = bsky('2026-09-06T12:00:00'); delete m.payload.seq;
  const o = obs('bsky', m); assert.equal(o.providerEventSeq, null); assert.equal(o.socialSourceId, LEGACY.event.socialSourceId);
  const r = rec([LEGACY.event]); const out = r.reconcile(o, r.batch({ knownAtTs: T1 })); assert.equal(out.kind, 'PENDING'); assert.equal(out.reason, 'OCCURRENCE_IDENTITY_INSUFFICIENT'); assert.deepEqual(out.candidateIds, [LEGACY.event.sourceEventId]); assert.equal(out.event.nativeKey.providerEventSeq, null, 'no seq is invented');
  const p = await pipeline({ arr: [LEGACY.event], deliveries: [m] }); assert.equal(src(p.appended).length, 0); assert.equal(ann(p.appended).length, 0); assert.equal(pend(p.appended).length, 1); assert.equal(replaySocialHistory(p.arr).durableIds.size, 1, 'no second logical source');
  // symmetric: the KNOWN occurrence lacks its sequence, the candidate carries one
  const nullSeqEvent = asEvent(obs('bsky', m)); const r2 = rec([nullSeqEvent]); const out2 = r2.reconcile(obs('bsky', bsky(T_Z)), r2.batch({ knownAtTs: T1 })); assert.equal(out2.kind, 'PENDING'); assert.equal(out2.reason, 'OCCURRENCE_IDENTITY_INSUFFICIENT'); assert.deepEqual(out2.candidateIds, [nullSeqEvent.sourceEventId]);
  // a first-ever seq-less record with NO known occurrence follows the approved source contract (NEW)
  const r3 = rec([]); assert.equal(r3.reconcile(o, r3.batch({ knownAtTs: T1 })).kind, 'NEW');
});

test('C2. known seq=41 and seq=42 remain two occurrences; C3. several compatible potential occurrences stay explicitly unresolved and linked', async () => {
  const s42 = bsky(T_Z, { seq: 42 }); const r = await pipeline({ arr: [LEGACY.event], deliveries: [s42] }); assert.equal(src(r.appended).length, 1); assert.equal(src(r.appended)[0].providerEventSeq, 42);
  const m = bsky(T_Z); delete m.payload.seq; const r3 = rec(src(r.arr)); const out = r3.reconcile(obs('bsky', m), r3.batch({ knownAtTs: T1 })); assert.equal(out.kind, 'PENDING'); assert.equal(out.reason, 'OCCURRENCE_IDENTITY_INSUFFICIENT'); assert.deepEqual(out.candidateIds, src(r.arr).map((e) => e.sourceEventId).sort());
  const same = rec(src(r.arr)); const sc = same.batch({ knownAtTs: T1 }); same.reconcile(obs('bsky', m), sc); assert.equal(same.reconcile(obs('bsky', m), sc).kind, 'KNOWN', 'the same unresolved candidate twice in one batch resolves once');
});

test('C4. same-seq replay is one truth and delete/recreate/delete keeps both tombstones; C5. X edits and distinct Farcaster hashes remain valid new versions', async () => {
  const c10 = fixtureCase('bsky_post', 'seq10'); const d11 = fixtureCase('bsky_post', 'delete_seq11'); const c20 = fixtureCase('bsky_post', 'seq20'); const d21 = fixtureCase('bsky_post', 'delete_seq21');
  const r = await pipeline({ arr: [c10.event, d11.event, c20.event, d21.event], deliveries: [c10.msg, c10.msg, d11.msg, c20.msg, d21.msg, d21.msg] }); assert.equal(src(r.appended).length + ann(r.appended).length + pend(r.appended).length, 0);
  const rp = replaySocialHistory(r.arr); assert.equal([...rp.targets.values()].filter((e) => e.lifecycle === 'TOMBSTONE').length, 2);
  const x = fixtureCase('x_post', 'valid_z'); const rx = await pipeline({ p: 'x', arr: [x.event], deliveries: [xp(T_Z, { id: '101', history: ['100', '101'] }), xp(T_Z, { id: '102', history: ['100', '101', '102'] })] }); assert.deepEqual(src(rx.appended).map((e) => e.nativeVersionId), ['101', '102']); assert.equal(pend(rx.appended).length, 0);
  const f1 = fixtureCase('fc_cast', 'valid_z'); const rf = await pipeline({ p: 'fc', arr: [f1.event], deliveries: [fc(T_Z, { hash: '0xsyntheticcast9' })] }); assert.equal(src(rf.appended).length, 1); assert.equal(src(rf.appended)[0].nativePostId, '0xsyntheticcast9');
});

// =========================================================================================
// D. CONFLICTING LATER DECLARATIONS ARE NEVER LAST-WINS
// =========================================================================================
async function annotatedLegacy() {
  const r1 = await pipeline({ arr: [LEGACY.event], deliveries: [bsky('2026-09-06T12:00:00.100Z')], nowMs: T1 });
  assert.equal(ann(r1.appended).length, 1); assert.equal(ann(r1.appended)[0].witness.declared, '2026-09-06T12:00:00.100Z'); assert.equal(ann(r1.appended)[0].knownAtTs, T1);
  return r1;
}
test('D1. .100Z then .200Z across separate settles: the second is an explicit DECLARATION_CONFLICT, not a replacement annotation', async () => {
  const r1 = await annotatedLegacy();
  const r2 = await pipeline({ arr: r1.arr, deliveries: [bsky('2026-09-06T12:00:00.200Z')], nowMs: T2 });
  assert.equal(ann(r2.appended).length, 0); assert.equal(src(r2.appended).length, 0); assert.equal(pend(r2.appended).length, 1);
  const p = pend(r2.appended)[0]; assert.equal(p.reason, 'DECLARATION_CONFLICT'); assert.deepEqual(p.candidateIds, [LEGACY.event.sourceEventId]); assert.equal(p.sourceClockWitness.declared, '2026-09-06T12:00:00.200Z'); assert.equal(p.knownAtTs, T2);
  const rp = replaySocialHistory(r2.arr); assert.equal(rp.ok, true); assert.equal(rp.durableIds.size, 1); assert.deepEqual(rp.annotationConflicts, []); assert.equal(rp.pendingByTarget.get(LEGACY.event.sourceEventId).length, 1);
});

test('D2. both candidates in one pending batch: one annotation, one conflict record', async () => {
  const r = await pipeline({ arr: [LEGACY.event], deliveries: [bsky('2026-09-06T12:00:00.100Z'), bsky('2026-09-06T12:00:00.200Z')], nowMs: T1 });
  assert.equal(ann(r.appended).length, 1); assert.equal(ann(r.appended)[0].witness.declared, '2026-09-06T12:00:00.100Z'); assert.equal(pend(r.appended).length, 1); assert.equal(pend(r.appended)[0].reason, 'DECLARATION_CONFLICT'); assert.equal(src(r.appended).length, 0);
});

test('D3. fresh replay / restart followed by the conflicting candidate', async () => {
  const r1 = await annotatedLegacy(); const rp = replaySocialHistory(r1.arr); assert.equal(rp.ok, true);
  const fresh = rec(r1.arr); const out = fresh.reconcile(obs('bsky', bsky('2026-09-06T12:00:00.200Z'), T2), fresh.batch({ knownAtTs: T2 })); assert.equal(out.kind, 'PENDING'); assert.equal(out.reason, 'DECLARATION_CONFLICT');
  const r2 = await pipeline({ arr: r1.arr, deliveries: [bsky('2026-09-06T12:00:00.200Z')], nowMs: T2, seenCap: 1 }); assert.equal(pend(r2.appended).length, 1); assert.equal(ann(r2.appended).length, 0);
});

test('D4. equivalent offsets / padding and the repeated same annotation remain idempotent', async () => {
  const r1 = await annotatedLegacy();
  const r2 = await pipeline({ arr: r1.arr, deliveries: [bsky('2026-09-06T12:00:00.100000Z'), bsky('2026-09-06T08:00:00.100-04:00'), bsky('2026-09-06T12:00:00.100Z'), bsky('2026-09-06T12:00:00.100Z')], nowMs: T2 });
  assert.equal(r2.appended.length, 0, 'no new annotation, no conflict');
});

test('D5. the view at T1 and T2 respects when the conflict became known and never picks a winner', async () => {
  const r1 = await annotatedLegacy(); const r2 = await pipeline({ arr: r1.arr, deliveries: [bsky('2026-09-06T12:00:00.200Z')], nowMs: T2 });
  const rp = replaySocialHistory(r2.arr); const id = LEGACY.event.sourceEventId; const annotations = rp.annotations.get(id); const pending = rp.pendingByTarget.get(id);
  const at = (asOfTs) => socialTemporalView({ event: LEGACY.event, annotations, pending, asOfTs });
  const v1 = at(T1); assert.equal(v1.conflict, null); assert.equal(v1.effective.sourceDeclaredTs, T_MS + 100); assert.equal(v1.effective.provenance, 'LATER_EVIDENCE_SAME_EVENT');
  const v2m = at(T2 - 1); assert.equal(v2m.conflict, null); assert.equal(v2m.effective.sourceDeclaredTs, T_MS + 100, 'conflict knowledge never leaks backward');
  const v2 = at(T2); assert.equal(v2.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(v2.effective.sourceDeclaredTs, null); assert.equal(v2.effective.sourceClockWitness, null); assert.equal(v2.effective.provenance, 'CONFLICTING_DECLARATIONS'); assert.equal(v2.effective.precisionVerified, false);
  assert.equal(v2.conflict.knownAtTs, T2); assert.deepEqual(v2.conflict.retainedAnnotationIds, [annotations[0].sourceEventId]); assert.deepEqual(v2.conflict.pendingIds, [pending[0].sourceEventId]); assert.deepEqual(v2.appliedAnnotations, []);
  assert.equal(v2.original.sourceDeclaredTs, LEGACY.event.sourceDeclaredTs, 'the original record is untouched');
  // a legacy history carrying two non-equivalent annotations (written before this closeout) is accepted, flagged, and never resolved by arrival order
  const later = socialClockInterpretationEvent({ target: LEGACY.event, clockRole: 'SOURCE_DECLARATION', basis: 'NEW_DELIVERY_SAME_EVENT', witness: obs('bsky', bsky('2026-09-06T12:00:00.200Z'), T2).sourceClockWitness, evidenceRetrievedTs: T2, knownAtTs: T2 });
  const old = replaySocialHistory([...r1.arr, later]); assert.equal(old.ok, true); assert.deepEqual(old.annotationConflicts, [{ targetEventId: id, clockRole: 'SOURCE_DECLARATION', annotationIds: [annotations[0].sourceEventId, later.sourceEventId].sort() }]);
  const vo = socialTemporalView({ event: LEGACY.event, annotations: old.annotations.get(id), asOfTs: T2 + 1 }); assert.equal(vo.effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE); assert.equal(vo.conflict.knownAtTs, T2);
  assert.equal(socialTemporalView({ event: LEGACY.event, annotations: old.annotations.get(id), asOfTs: T2 - 1 }).effective.sourceDeclaredTs, T_MS + 100);
  const foreign = { ...pending[0], candidateIds: ['r2sv-' + 'a'.repeat(40)] }; assert.equal(socialTemporalView({ event: LEGACY.event, annotations, pending: [foreign], asOfTs: T2 }).ok, false, 'a pending record that does not name this event is refused');
});

test('D6. a permitted policy-version reinterpretation of retained bytes is not altered source bytes; unsupported versions fail honestly', () => {
  const w = obs('bsky', bsky('2026-09-06T12:00:00.100Z')).sourceClockWitness;
  assert.equal(sameDeclaration(w, { ...w }), true); assert.equal(sameDeclaration(w, { ...w, policyVersion: 2, projectionMs: w.projectionMs + 1 }), false, 'the same bytes re-read to a different instant under another policy version are a different interpretation, never silently equal');
  assert.equal(sameDeclaration(w, { ...w, declared: '2026-09-06T08:00:00.100-04:00' }), true, 'the same instant under equivalent bytes stays equivalent');
  assert.equal(normalizeSocialObservation({ ...jetstreamCommitToRaw(bsky('2026-09-06T12:00:00.100Z')).raw, sourceClockWitness: { ...w, policyVersion: 2 } }, { nowMs: T1 }).reject, true, 'an unsupported witness version is refused at normalization');
  const v2 = asEvent(obs('bsky', bsky('2026-09-06T12:00:00.100Z')));
  const same = socialClockInterpretationEvent({ target: v2, clockRole: 'SOURCE_DECLARATION', basis: 'RETAINED_ORIGINAL_DECLARATION', witness: v2.sourceClockWitness, evidenceRetrievedTs: v2.retrievedTs, knownAtTs: T2 });
  assert.equal(validateSocialClockInterpretation(same, { target: v2 }), null, 'the retained bytes re-read under the supported policy version bind');
  assert.match(validateSocialClockInterpretation({ ...same, witness: { ...same.witness, policyVersion: 2 } }, { target: v2 }), /policyVersion|witness/);
  assert.match(validateSocialClockInterpretation({ ...same, witness: { ...same.witness, declared: '2026-09-06T12:00:00.200Z' } }, { target: v2 }), /retained declaration differs|re-derived|witness/);
});

// =========================================================================================
// E. AS-OF BASE-EVENT ADMISSIBILITY   F. DETACHED IMMUTABLE SNAPSHOTS
// =========================================================================================
test('E1-E4. NOT_YET_KNOWN before first-known for legacy and v2 records; T1/T2 cutoffs; invalid as-of fails closed without touching any event', async () => {
  const v2 = asEvent(obs('bsky', bsky(T_Z)));
  for (const e of [LEGACY.event, v2]) {
    const before = socialTemporalView({ event: e, asOfTs: e.knownAtTs - 1 }); assert.equal(before.ok, true); assert.equal(before.status, 'NOT_YET_KNOWN'); assert.equal(before.admissible, false); assert.equal(before.original, null); assert.equal(before.effective, null); assert.equal(before.firstKnownAtTs, e.knownAtTs);
    const at = socialTemporalView({ event: e, asOfTs: e.knownAtTs }); assert.equal(at.status, 'EFFECTIVE'); assert.equal(at.effective.firstKnownAtTs, e.knownAtTs); assert.equal(socialTemporalView({ event: e, asOfTs: e.knownAtTs + 1 }).status, 'EFFECTIVE');
    assert.equal(socialTemporalView({ event: e, asOfTs: e.sourceDeclaredTs }).status, 'NOT_YET_KNOWN', 'the source clock grants no earlier admissibility');
  }
  const r1 = await annotatedLegacy(); const r2 = await pipeline({ arr: r1.arr, deliveries: [bsky('2026-09-06T12:00:00.200Z')], nowMs: T2 }); const rp = replaySocialHistory(r2.arr); const id = LEGACY.event.sourceEventId;
  const at = (asOfTs) => socialTemporalView({ event: LEGACY.event, annotations: rp.annotations.get(id), pending: rp.pendingByTarget.get(id), asOfTs });
  assert.deepEqual(at(T1 - 1).appliedAnnotations, []); assert.equal(at(T1 - 1).effective.sourceDeclaredTs, LEGACY.event.sourceDeclaredTs); assert.equal(at(T1).appliedAnnotations.length, 1);
  assert.equal(at(T2 - 1).conflict, null); assert.equal(at(T2).conflict.knownAtTs, T2);
  const snap = canonicalJson(LEGACY.event);
  for (const bad of [undefined, null, 'now', NaN, 1.5, 2 ** 53, Infinity]) assert.equal(socialTemporalView({ event: LEGACY.event, asOfTs: bad }).ok, false);
  assert.equal(canonicalJson(LEGACY.event), snap);
});

test('F1-F4. views built from JSON-deserialized inputs are detached deep-frozen snapshots: no alias, no contamination between original and effective, input never frozen', async () => {
  const r1 = await annotatedLegacy(); const v2src = asEvent(obs('bsky', bsky('2026-09-06T12:00:00.000000500Z')));
  const event = JSON.parse(JSON.stringify(v2src)); const legacy = JSON.parse(JSON.stringify(LEGACY.event)); const a = JSON.parse(JSON.stringify(ann(r1.arr)[0]));
  const v = socialTemporalView({ event, asOfTs: event.knownAtTs + 1 });
  assert.throws(() => { v.effective.sourceClockWitness.declared = 'CHANGED_VIA_VIEW'; }); assert.throws(() => { v.original.sourceClockWitness.declared = 'CHANGED_VIA_VIEW'; }); assert.throws(() => { v.effective.sourceClockWitness.subMillisecondRemainder = '9'; });
  assert.equal(event.sourceClockWitness.declared, '2026-09-06T12:00:00.000000500Z'); assert.equal(validateSocialEvent(event), null); assert.equal(Object.isFrozen(event), false, 'the caller\'s input is not frozen as a side effect'); assert.equal(Object.isFrozen(event.sourceClockWitness), false);
  assert.notEqual(v.original.sourceClockWitness, event.sourceClockWitness); assert.notEqual(v.effective.sourceClockWitness, v.original.sourceClockWitness, 'original and effective hold distinct snapshots');
  event.sourceClockWitness.declared = 'MUTATED_AFTER_VIEW'; assert.equal(v.original.sourceClockWitness.declared, '2026-09-06T12:00:00.000000500Z', 'an existing view is a stable snapshot, not a moving alias'); assert.equal(v.effective.sourceClockWitness.declared, '2026-09-06T12:00:00.000000500Z');
  const va = socialTemporalView({ event: legacy, annotations: [a], asOfTs: T1 });
  assert.throws(() => { va.effective.sourceClockWitness.declared = 'X'; }); assert.equal(Object.isFrozen(a), false); assert.equal(Object.isFrozen(a.witness), false);
  a.witness.declared = 'MUTATED_ANNOTATION'; assert.equal(va.effective.sourceClockWitness.declared, '2026-09-06T12:00:00.100Z'); assert.equal(va.original.sourceClockWitness, null);
  assert.throws(() => { va.original.sourceDeclaredTs = 1; }); assert.throws(() => { va.effective.conflict = {}; }); assert.throws(() => { va.appliedAnnotations.push('x'); });
  const pv = socialTemporalView({ event: legacy, annotations: [JSON.parse(JSON.stringify(ann(r1.arr)[0]))], asOfTs: T1 }); assert.notEqual(pv.effective.sourceClockWitness, pv.original.sourceClockWitness);
});

// =========================================================================================
// PG1-PG4. REAL POSTGRESQL DRILLS
// =========================================================================================
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL-4D CLOSEOUT durable drills', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const withDb = async (fn) => {
    const SCHEMA = `soc4dc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA }); const admin = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); assert.equal(await admin.connect(), true); await runMigrations(db);
      const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ admin, mkJournal: () => rumor2JournalStore({ persistence }) });
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); await admin.end(); }
  };
  const killAdvisoryBackends = async (admin) => { const { rows } = await admin.query(`SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.pid <> pg_backend_pid()`); for (const r of rows) await admin.query(`SELECT pg_terminate_backend($1)`, [r.pid]).catch(() => {}); return rows.length; };
  const events = async (j) => (await j.read()).events;
  const acquire = async (j) => { const w = await j.acquireWriter(); assert.equal(w.ok, true); return w; };
  const bootRt = ({ fixtures, nowMs = T1, maxDrain = 200 }) => createSocialRuntime({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: FILTER, now: () => nowMs, mode: 'REPLAY', fixtures, log: () => {}, maxDrain });
  const settleWith = (rt, j, fenceHeld = () => true, append = (e) => j.append(e)) => rt.settle({ fenceHeld, append, lookup: (t, ids) => j.hasEventIds(t, ids) });

  test('PG1. partial drain with duplicate 42 + filtered 43 cannot commit a cursor that skips the unresolved 42; a restart completes it exactly once', async () => {
    await withDb(async ({ mkJournal }) => {
      const j = mkJournal(); await acquire(j);
      const rt = bootRt({ fixtures: A_FIXTURES(), maxDrain: 1 }); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start();
      assert.equal((await settleWith(rt, j)).ok, true); assert.equal(rt.durableCursor(), 41);
      const h1 = await events(j); assert.deepEqual(src(h1).map((e) => e.providerEventSeq), [41]); assert.deepEqual(cursors(h1).map((c) => c.durableCursor), [41]);
      rt.stop(); await j.releaseWriter(); // crash: the queued 42 dies with the process
      const j2 = mkJournal(); await acquire(j2);
      const rt2 = bootRt({ fixtures: A_FIXTURES() }); const h = rt2.hydrate(await events(j2)); assert.equal(h.ok, true); assert.equal(h.durableCursor, 41); rt2.start();
      assert.equal((await settleWith(rt2, j2)).ok, true); const h2 = await events(j2);
      assert.deepEqual(src(h2).map((e) => e.providerEventSeq), [41, 42], '42 exactly once'); assert.equal(rt2.durableCursor(), 43); assert.equal(replaySocialHistory(h2).cursors.BLUESKY_OFFICIAL, 43);
      assert.equal((await settleWith(rt2, j2)).ok, true); assert.equal((await events(j2)).length, h2.length, 'idempotent');
      rt2.stop(); await j2.releaseWriter();
    });
  });

  test('PG2. old records remain byte-identical through reconciliation and conflict intake', async () => {
    await withDb(async ({ mkJournal }) => {
      const legacy = ['valid_z', 'reply', 'seq10', 'delete_seq11', 'seq20'].map((l) => fixtureCase('bsky_post', l).event); assert.equal(new Set(legacy.map((e) => e.sourceEventId)).size, 5);
      const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append(legacy)).ok, true); await jA.releaseWriter();
      const before = (await events(mkJournal())).map((e) => canonicalJson(e));
      const j = mkJournal(); await acquire(j);
      const m = bsky(T_Z); delete m.payload.seq;
      const rt = bootRt({ fixtures: [bsky('2026-09-06T12:00:00.100Z'), bsky('2026-09-06T12:00:00.200Z'), bsky(T_Z, { text: 'synthetic $BTC fixture!' }), m, fixtureCase('bsky_post', 'offsetless').msg] }); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start();
      assert.equal((await settleWith(rt, j)).ok, true);
      const after = await events(j); for (let i = 0; i < before.length; i++) assert.equal(canonicalJson(after[i]), before[i], `row ${i} byte-identical`);
      // .100Z annotates valid_z (seq 41); .200Z conflicts with that in-batch annotation; altered text is an immutable conflict; the
      // seq-less delivery is uncertain among seq 41/10/20; the offset-less redelivery conflicts with the retained .100Z declaration
      const rp = replaySocialHistory(after); assert.equal(rp.ok, true); assert.equal(rp.durableIds.size, legacy.length, 'no logical source was minted'); assert.equal(rp.annotated, 1); assert.equal(rp.pending, 4);
      assert.deepEqual(pend(after).map((e) => e.reason).sort(), ['DECLARATION_CONFLICT', 'DECLARATION_CONFLICT', 'IMMUTABLE_FACT_CONFLICT', 'OCCURRENCE_IDENTITY_INSUFFICIENT']);
      assert.equal(pend(after).find((e) => e.reason === 'OCCURRENCE_IDENTITY_INSUFFICIENT').candidateIds.length, 3, 'linked to every potential occurrence (seq 41, 10, 20)');
      for (const e of src(after)) assert.equal(e.type, legacy[0].type, 'no legacy row was rewritten to v2');
      rt.stop(); await j.releaseWriter();
    });
  });

  test('PG3. annotation and conflict history survives restart and honors as-of cutoffs', async () => {
    await withDb(async ({ mkJournal }) => {
      const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append([LEGACY.event])).ok, true); await jA.releaseWriter();
      const j = mkJournal(); await acquire(j);
      const rt = bootRt({ fixtures: [bsky('2026-09-06T12:00:00.100Z')], nowMs: T1 }); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start(); assert.equal((await settleWith(rt, j)).ok, true); rt.stop(); await j.releaseWriter();
      const j2 = mkJournal(); await acquire(j2);
      const rt2 = bootRt({ fixtures: [bsky('2026-09-06T12:00:00.200Z'), bsky('2026-09-06T12:00:00.100000Z')], nowMs: T2 }); assert.equal(rt2.hydrate(await events(j2)).ok, true); rt2.start(); assert.equal((await settleWith(rt2, j2)).ok, true); rt2.stop(); await j2.releaseWriter();
      const hist = await events(mkJournal()); assert.equal(ann(hist).length, 1); assert.equal(pend(hist).length, 1); assert.equal(src(hist).length, 1);
      const rp = replaySocialHistory(hist); assert.equal(rp.ok, true); const id = LEGACY.event.sourceEventId;
      const at = (asOfTs) => socialTemporalView({ event: rp.targets.get(id), annotations: rp.annotations.get(id), pending: rp.pendingByTarget.get(id), asOfTs });
      assert.equal(at(T0 - 1).status, 'NOT_YET_KNOWN'); assert.equal(at(T1 - 1).effective.sourceDeclaredTs, LEGACY.event.sourceDeclaredTs); assert.equal(at(T1).effective.sourceDeclaredTs, T_MS + 100); assert.equal(at(T2 - 1).conflict, null); assert.equal(at(T2).effective.sourceClockStatus, SOCIAL_VIEW_CONFLICT_STATE);
      // a third process hydrated from that history repeats nothing on redelivery of either declaration
      const j3 = mkJournal(); await acquire(j3); const rt3 = bootRt({ fixtures: [bsky('2026-09-06T12:00:00.100Z'), bsky('2026-09-06T12:00:00.200Z')], nowMs: T2 + 1 }); assert.equal(rt3.hydrate(await events(j3)).ok, true); rt3.start();
      assert.equal((await settleWith(rt3, j3)).ok, true); assert.equal((await events(j3)).length, hist.length, 'nothing repeats'); rt3.stop(); await j3.releaseWriter();
    });
  });

  test('PG4. append refusal and a stale writer epoch produce no durable adoption; retries remain idempotent', async () => {
    await withDb(async ({ mkJournal, admin }) => {
      const jA = mkJournal(); await acquire(jA); assert.equal((await jA.append([LEGACY.event])).ok, true); await jA.releaseWriter();
      const j = mkJournal(); await acquire(j);
      const rt = bootRt({ fixtures: [bsky('2026-09-06T12:00:00.100Z'), bsky('2026-09-06T12:00:00.200Z'), bsky('2026-09-06T12:00:01Z', { seq: 42, rkey: 'k42', cid: 'bafy42' })] }); assert.equal(rt.hydrate(await events(j)).ok, true); rt.start();
      let attempts = 0; const captured = [];
      const failing = async (evs) => { attempts += 1; captured.push(canonicalJson(evs)); if (attempts === 1) return { ok: false, reason: 'UNAVAILABLE' }; return j.append(evs); };
      const f1 = await settleWith(rt, j, () => true, failing); assert.equal(f1.ok, false); assert.equal((await events(j)).length, 1); assert.equal(rt.durableCursor(), null); assert.equal(rt.reconciler().status().annotations + rt.reconciler().status().pending, 0, 'nothing adopted from a refused append'); assert.equal(rt._intake().pendingCount(), 2);
      const f2 = await settleWith(rt, j, () => true, failing); assert.equal(f2.ok, true); assert.equal(captured[0], captured[1], 'byte-identical retry'); assert.equal(rt.durableCursor(), 42);
      const all = await events(j); assert.equal(ann(all).length, 1); assert.equal(pend(all).length, 1); assert.equal(src(all).length, 2); assert.equal(rt.reconciler().status().annotations, 1); assert.equal(rt.reconciler().status().pending, 1);
      // stale writer epoch (takeover): no mutation, the ear stops
      const killed = await killAdvisoryBackends(admin); assert.ok(killed >= 1);
      rt._feed(JSON.stringify(bsky('2026-09-06T12:00:00.300Z')));
      const r3 = await settleWith(rt, j, () => false); assert.equal(r3.ok, false); assert.equal(r3.reason, 'WRITER_FENCE_LOST'); assert.equal((await events(mkJournal())).length, all.length, 'no mutation after fence loss'); assert.equal(rt.isActive(), false);
    });
  });
}
