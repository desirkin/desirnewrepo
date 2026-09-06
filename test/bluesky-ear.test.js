// SOCIAL-1 — the Bluesky ear: pure Jetstream mapping (§40 fixtures), the
// bounded intake pipeline (identity/echo/dedupe/corruption/filter — §41/§43),
// and the WebSocket transport security bounds (host allowlist, oversized/
// malformed drop, stall reconnect, clean shutdown — §23). NO network: a fake
// socket + fake timers drive everything deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jetstreamCommitToRaw, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { socialIntake, startSocialStream } from '../rumor2/social-stream.js';
import { buildSocialFilter } from '../rumor2/social.js';

const NOW = Date.parse('2026-09-05T12:00:10Z');
const CREATED = Date.parse('2026-09-05T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

let seq = 1;
const commit = ({ did = 'did:plc:alice', rkey = 'r1', op = 'create', collection = 'app.bsky.feed.post', record = undefined, time = iso(CREATED) } = {}) => ({
  $type: 'message',
  payload: {
    $type: 'network.bsky.jetstream.subscribeEvents#commit',
    did, seq: seq++, time, operation: op, collection, rkey,
    rev: '3abc', cid: record ? 'bafyCID' : undefined, record,
  },
});
const postRecord = (over = {}) => ({ $type: 'app.bsky.feed.post', text: over.text ?? '$FOO is listing on a top exchange today', createdAt: over.createdAt ?? iso(CREATED), ...over });

// ---- §40 mapping fixtures --------------------------------------------------
test('BSKY-MAP-1. original post maps to an ORIGINAL observation with native at:// identity', () => {
  const r = jetstreamCommitToRaw(commit({ record: postRecord() }));
  assert.equal(r.raw.relation, 'ORIGINAL');
  assert.equal(r.raw.nativePostId, 'at://did:plc:alice/app.bsky.feed.post/r1');
  assert.equal(r.raw.nativeAuthorId, 'did:plc:alice');
  assert.equal(r.raw.parentNativePostId, null);
  assert.equal(r.raw.canonicalUrl, 'https://bsky.app/profile/did:plc:alice/post/r1');
});

test('BSKY-MAP-2. reply/quote/repost carry the explicit parent (echo relationships)', () => {
  const reply = jetstreamCommitToRaw(commit({ rkey: 'rp', record: postRecord({ reply: { root: { uri: 'at://root/app.bsky.feed.post/a', cid: 'c' }, parent: { uri: 'at://did:plc:bob/app.bsky.feed.post/x', cid: 'c' } } }) }));
  assert.equal(reply.raw.relation, 'REPLY');
  assert.equal(reply.raw.parentNativePostId, 'at://did:plc:bob/app.bsky.feed.post/x');
  const quote = jetstreamCommitToRaw(commit({ rkey: 'qt', record: postRecord({ embed: { $type: 'app.bsky.embed.record', record: { uri: 'at://did:plc:carol/app.bsky.feed.post/y', cid: 'c' } } }) }));
  assert.equal(quote.raw.relation, 'QUOTE');
  assert.equal(quote.raw.parentNativePostId, 'at://did:plc:carol/app.bsky.feed.post/y');
  const repost = jetstreamCommitToRaw(commit({ collection: 'app.bsky.feed.repost', rkey: 'rr', record: { $type: 'app.bsky.feed.repost', createdAt: iso(CREATED), subject: { uri: 'at://did:plc:dave/app.bsky.feed.post/z', cid: 'c' } } }));
  assert.equal(repost.raw.relation, 'REPOST');
  assert.equal(repost.raw.parentNativePostId, 'at://did:plc:dave/app.bsky.feed.post/z');
});

test('BSKY-MAP-3. delete/tombstone maps to a deletion observation with no text', () => {
  const del = jetstreamCommitToRaw(commit({ op: 'delete', rkey: 'r1', record: undefined }));
  assert.equal(del.raw.editState, 'TOMBSTONED');
  assert.equal(del.raw.text, '');
  assert.equal(del.raw.nativePostId, 'at://did:plc:alice/app.bsky.feed.post/r1');
});

test('BSKY-MAP-4. edit (update) is marked EDITED; malformed / non-commit / wrong-collection are skipped', () => {
  const edit = jetstreamCommitToRaw(commit({ op: 'update', rkey: 'r1', record: postRecord({ text: 'edited text' }) }));
  assert.equal(edit.raw.editState, 'EDITED');
  assert.equal(jetstreamCommitToRaw(null).skip, true);
  assert.equal(jetstreamCommitToRaw({ payload: { kind: 'identity', did: 'did:x' } }).skip, true, 'identity event skipped');
  assert.equal(jetstreamCommitToRaw(commit({ collection: 'app.bsky.feed.like', record: { $type: 'app.bsky.feed.like' } })).skip, true, 'non-post collection skipped');
  assert.equal(jetstreamCommitToRaw(commit({ record: undefined, op: 'create' })).skip, true, 'create without a record skipped');
});

// ---- intake pipeline (identity/filter/dedupe/corruption) -------------------
const mkIntake = (over = {}) => socialIntake({
  provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw,
  filter: buildSocialFilter({ terms: ['FOO', '$BAR', 'solana'], watchAuthorIds: ['did:plc:watched'] }),
  now: () => NOW, ...over,
});

test('BSKY-INTAKE-1 (§24). the bounded filter admits matching posts and drops the rest — no all-network intake', () => {
  const intake = mkIntake();
  assert.equal(intake.offer(commit({ rkey: 'a', record: postRecord({ text: 'nothing relevant here' }) })).outcome, 'filtered');
  assert.equal(intake.offer(commit({ rkey: 'b', record: postRecord({ text: 'buy $FOO now' }) })).outcome, 'enqueued');
  assert.equal(intake.offer(commit({ did: 'did:plc:watched', rkey: 'c', record: postRecord({ text: 'unrelated but watched author' }) })).outcome, 'enqueued', 'watch-author always matches');
  assert.equal(intake.size(), 2);
});

test('BSKY-INTAKE-2 (§41/§51 PASS-1). duplicate delivery collapses to ONE truth', () => {
  const intake = mkIntake();
  const msg = commit({ rkey: 'dup', record: postRecord({ text: '$FOO breaking' }) });
  assert.equal(intake.offer(msg).outcome, 'enqueued');
  assert.equal(intake.offer(msg).outcome, 'deduped');
  assert.equal(intake.offer(msg).outcome, 'deduped');
  assert.equal(intake.stats().enqueued, 1);
  assert.equal(intake.stats().deduped, 2);
});

test('BSKY-INTAKE-3 (§22 corruption). SAME version (same cid) with an altered payload is CORRUPTION, not a new post', () => {
  const intake = mkIntake();
  // original CREATE (commit() gives every post cid 'bafyCID')
  assert.equal(intake.offer(commit({ rkey: 'x', record: postRecord({ text: '$FOO original', createdAt: iso(CREATED) }) })).outcome, 'enqueued');
  // same did+rkey (same at:// id) AND same cid (same immutable version) but altered content — impossible in honest data => corruption
  const forged = { $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:alice', seq: 999, time: iso(CREATED), operation: 'create', collection: 'app.bsky.feed.post', rkey: 'x', cid: 'bafyCID', record: postRecord({ text: '$FOO ALTERED', createdAt: iso(CREATED) }) } };
  assert.equal(intake.offer(forged).outcome, 'corrupt');
  assert.equal(intake.stats().corrupt, 1);
  assert.equal(intake.size(), 1, 'the forged re-delivery never entered the queue');
});

test('BSKY-INTAKE-7 (§19 edit). an update with a NEW cid is a new version, admitted (not false corruption)', () => {
  const intake = mkIntake();
  assert.equal(intake.offer({ $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:alice', seq: 1, time: iso(CREATED), operation: 'create', collection: 'app.bsky.feed.post', rkey: 'e', cid: 'cidA', record: postRecord({ text: '$FOO v1' }) } }).outcome, 'enqueued');
  const edit = { $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:alice', seq: 2, time: iso(CREATED + 60000), operation: 'update', collection: 'app.bsky.feed.post', rkey: 'e', cid: 'cidB', record: postRecord({ text: '$FOO v2 edited', createdAt: iso(CREATED) }) } };
  assert.equal(intake.offer(edit).outcome, 'enqueued', 'a legitimate edit is a new version, not corruption');
  assert.equal(intake.size(), 2);
  assert.equal(intake.stats().corrupt, 0);
});

test('BSKY-INTAKE-4 (§42). a future source clock fails closed', () => {
  const intake = mkIntake();
  const future = commit({ rkey: 'f', record: postRecord({ text: '$FOO soon', createdAt: iso(NOW + 60_000) }) });
  assert.equal(intake.offer(future).outcome, 'rejected');
});

test('BSKY-INTAKE-5. drain hands observations to the durable writer and empties the queue', () => {
  const intake = mkIntake();
  intake.offer(commit({ rkey: 'a', record: postRecord({ text: '$FOO one' }) }));
  intake.offer(commit({ rkey: 'b', record: postRecord({ text: '$FOO two' }) }));
  const batch = intake.drain(10);
  assert.equal(batch.length, 2);
  assert.equal(intake.size(), 0);
  for (const o of batch) assert.match(o.socialSourceId, /^r2ss-[0-9a-f]{40}$/);
});

test('BSKY-INTAKE-6. queue is bounded — backpressure drops rather than growing without limit (§23)', () => {
  const intake = mkIntake({ maxQueue: 3 });
  for (let i = 0; i < 10; i++) intake.offer(commit({ rkey: `q${i}`, record: postRecord({ text: `$FOO ${i}` }) }));
  assert.equal(intake.size(), 3);
  assert.ok(intake.stats().dropped >= 7);
});

// ---- transport lifecycle (fake socket + fake timers; no network) -----------
function fakeTimers() {
  const q = [];
  let id = 1;
  return {
    setTimeoutImpl: (cb, ms) => { const t = { id: id++, cb, ms }; q.push(t); return t.id; },
    clearTimeoutImpl: (tid) => { const i = q.findIndex((t) => t.id === tid); if (i >= 0) q.splice(i, 1); },
    runAll: () => { let guard = 0; while (q.length && guard++ < 1000) { const t = q.shift(); t.cb(); } },
    pending: () => q.length,
  };
}
function fakeSocket() {
  const handlers = {};
  return {
    on(ev, cb) { handlers[ev] = cb; },
    emit(ev, data) { handlers[ev]?.(data); },
    close() { this.closed = true; handlers.close?.(); },
    closed: false,
  };
}

test('BSKY-STREAM-1 (§23). exact host allowlist: a non-allowlisted host is refused, never connected', () => {
  const intake = mkIntake();
  let made = 0;
  const s = startSocialStream({
    provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE',
    buildUrl: () => 'wss://evil.example.com/xrpc/network.bsky.jetstream.subscribeEvents',
    socketFactory: () => { made += 1; return fakeSocket(); },
  }).start();
  assert.equal(made, 0, 'no socket opened to a non-allowlisted host');
  assert.equal(s.status().badHost, 1);
  s.stop();
});

test('BSKY-STREAM-2. oversized and malformed frames are dropped, never parsed into truth (§23/§40)', () => {
  const intake = mkIntake();
  const s = startSocialStream({ provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE', buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, socketFactory: fakeSocket, maxMessageBytes: 1024 });
  s._feed('x'.repeat(2048)); // oversized
  s._feed('{not valid json'); // malformed
  s._feed(JSON.stringify(commit({ rkey: 'ok', record: postRecord({ text: '$FOO valid' }) }))); // good
  const st = s.status();
  assert.equal(st.oversized, 1);
  assert.equal(st.badJson, 1);
  assert.equal(intake.size(), 1, 'only the valid frame produced an observation');
  s.stop();
});

test('BSKY-STREAM-3 (§51 PASS-8). a stall reconnects with backoff; a clean stop halts all activity', () => {
  const timers = fakeTimers();
  const intake = mkIntake();
  const sockets = [];
  const s = startSocialStream({
    provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE',
    buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`,
    socketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl,
    stallMs: 100, backoffBaseMs: 10, maxReconnects: 2,
  }).start();
  sockets[0].emit('open');
  // no messages arrive -> the armed stall timer fires -> reconnect scheduled
  timers.runAll();
  assert.ok(sockets.length >= 2, 'a stall triggered a reconnect');
  s.stop();
  const before = sockets.length;
  timers.runAll();
  assert.equal(sockets.length, before, 'after stop() no further reconnects occur');
  assert.equal(s.status().stopped, true);
});

test('BSKY-STREAM-4 (§40 replay). REPLAY mode deterministically feeds fixtures with no socket', () => {
  const intake = mkIntake();
  const fixtures = [
    commit({ rkey: 'r1', record: postRecord({ text: '$FOO alpha' }) }),
    commit({ rkey: 'r2', record: postRecord({ text: 'irrelevant' }) }),
    commit({ rkey: 'r1', record: postRecord({ text: '$FOO alpha' }) }), // duplicate
    commit({ op: 'delete', rkey: 'r1', record: undefined }), // later tombstone (filtered: empty text, not watched)
  ];
  const s = startSocialStream({ provider: BLUESKY_OFFICIAL, intake, mode: 'REPLAY', fixtures }).start();
  const st = intake.stats();
  assert.equal(st.enqueued, 1, 'one matching original');
  assert.equal(st.deduped, 1, 'the duplicate collapsed');
  s.stop();
});
