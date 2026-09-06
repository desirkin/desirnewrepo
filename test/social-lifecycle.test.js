// SOCIAL-2A — Bluesky provider-event / lifecycle identity (§9-§13) and the
// closed durable cursor event + Social history replay (§16/§22-§24). Pure: no
// network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSocialObservation, socialProvenanceFacts, buildSocialFilter } from '../rumor2/social.js';
import {
  socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, socialCursorEvent, validateSocialCursorEvent,
  replaySocialHistory, socialCursorIdentity, SOCIAL_EVENT_KEYS, SOCIAL_CURSOR_EVENT_KEYS, isSocialEventType,
} from '../rumor2/social-settle.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { jetstreamCommitToRaw, jetstreamCursorOf, jetstreamUrl, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { neynarEventToRaw } from '../rumor2/providers/farcaster-official.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const C = Date.parse('2026-09-05T12:00:00Z');
const NOW = C + 10_000;
const iso = (m) => new Date(m).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
const AT = 'at://did:plc:z/app.bsky.feed.post/rkey';
const commit = ({ seq, op = 'create', cid = 'cidA', record = { $type: 'app.bsky.feed.post', text: '$FOO listing', createdAt: iso(C) }, time = iso(C) } = {}) =>
  ({ $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:z', seq, time, operation: op, collection: 'app.bsky.feed.post', rkey: 'rkey', cid: op === 'delete' ? undefined : cid, record: op === 'delete' ? undefined : record } });
const obs = (m, nowMs = NOW) => normalizeSocialObservation(jetstreamCommitToRaw(m).raw, { nowMs }).observation;

test('LIFE-1 (§9). Jetstream seq is preserved as providerEventSeq — provider-supplied, replay-stable, never invented', () => {
  const o = obs(commit({ seq: 100 }));
  assert.equal(o.providerEventSeq, 100);
  assert.equal(jetstreamCursorOf(commit({ seq: 7 })), 7);
  assert.equal(jetstreamCursorOf({ payload: { seq: -1 } }), null, 'a negative seq is not a cursor');
  assert.equal(jetstreamCursorOf({ payload: {} }), null, 'no seq => null (never invented)');
  assert.equal(jetstreamCursorOf(null), null);
  assert.equal(obs(commit({ seq: undefined })).providerEventSeq, null, 'absent seq stays UNKNOWN');
  assert.equal(o.sourceCreatedTs, C, 'sourceCreatedTs is still the record createdAt, never the seq/commit time');
});

test('LIFE-2 (§10). the stable post identity never carries the seq; the version identity does', () => {
  const a = obs(commit({ seq: 100 }));
  const b = obs(commit({ seq: 101 }));
  assert.equal(a.socialSourceId, b.socialSourceId, 'socialSourceId = provider + nativePostId only');
  assert.notEqual(a.socialVersionId, b.socialVersionId, 'a distinct provider commit is a distinct lifecycle version');
  assert.equal(socialProvenanceFacts(a).providerEventSeq, 100, 'providerEventSeq is a CONTENT/VERSION fact');
});

test('LIFE-3 (§11). CREATE / DELETE / RECREATE / DELETE — four distinct versions, one stable identity, no fabricated clocks', () => {
  const create = obs(commit({ seq: 100, cid: 'cidA' }));
  const del1 = obs(commit({ seq: 110, op: 'delete' }), NOW + 1);
  const recreate = obs(commit({ seq: 120, cid: 'cidB' }), NOW + 2);
  const del2 = obs(commit({ seq: 130, op: 'delete' }), NOW + 3);
  const ids = new Set([create, del1, recreate, del2].map((o) => o.socialSourceId));
  assert.equal(ids.size, 1, 'same stable socialSourceId across all four');
  const versions = new Set([create, del1, recreate, del2].map((o) => o.socialVersionId));
  assert.equal(versions.size, 4, 'four unique lifecycle versions');
  assert.notEqual(del1.socialVersionId, del2.socialVersionId, 'DELETE 130 is a DIFFERENT tombstone from DELETE 110');
  assert.equal(del1.lifecycle, 'TOMBSTONE'); assert.equal(del2.lifecycle, 'TOMBSTONE');
  assert.equal(del1.sourceCreatedTs, null); assert.equal(del2.sourceCreatedTs, null);
  assert.equal(del1.text, ''); assert.equal(del2.text, '');
  assert.equal(del1.parentNativePostId, null, 'no fabricated parent');
  for (const o of [create, del1, recreate, del2]) {
    const { event } = socialObservationToEvent(o);
    assert.equal(validateSocialEvent(event, V), null, `${o.lifecycle}@${o.providerEventSeq} validates`);
    assert.equal(reconstructSocialWitness(event).providerEventSeq, o.providerEventSeq, 'seq survives the witness');
  }
});

test('LIFE-4 (§12). the exact SAME Jetstream delete commit 100x is ONE lifecycle truth', () => {
  const intake = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: buildSocialFilter({ watchAuthorIds: ['did:plc:z'] }), now: () => NOW });
  const del = commit({ seq: 110, op: 'delete' });
  const outcomes = [];
  for (let i = 0; i < 100; i++) outcomes.push(intake.offer(del).outcome);
  assert.equal(outcomes[0], 'enqueued');
  assert.equal(outcomes.filter((o) => o === 'deduped').length, 99);
  const [env] = intake.drain();
  assert.equal(env.providerCursor, 110, 'same provider event id');
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(obs(del, NOW + i).socialVersionId);
  assert.equal(ids.size, 1, 'same sourceEventId every time');
});

test('LIFE-5 (§13). providerEventSeq is closed-validated: type, range, provider applicability', () => {
  const { event } = socialObservationToEvent(obs(commit({ seq: 100 })));
  assert.ok(SOCIAL_EVENT_KEYS.includes('providerEventSeq'), 'declared in the closed schema');
  assert.equal(validateSocialEvent(event, V), null);
  assert.notEqual(validateSocialEvent({ ...event, providerEventSeq: -1 }, V), null, 'negative rejected');
  assert.notEqual(validateSocialEvent({ ...event, providerEventSeq: 1.5 }, V), null, 'non-integer rejected');
  assert.notEqual(validateSocialEvent({ ...event, providerEventSeq: '100' }, V), null, 'string rejected');
  assert.notEqual(validateSocialEvent({ ...event, providerEventSeq: 101 }, V), null, 'a changed seq under the same version id is rejected (bound by sourceEventId)');
  // a provider with no seq concept must carry null; a caller-supplied seq cannot authenticate it
  const fc = socialObservationToEvent(normalizeSocialObservation(neynarEventToRaw({ type: 'cast.created', data: { object: 'cast', hash: '0xc', author: { fid: 7 }, text: '$FOO', timestamp: iso(C) } }).raw, { nowMs: NOW }).observation).event;
  assert.equal(fc.providerEventSeq, null);
  assert.equal(validateSocialEvent(fc, V), null);
  assert.notEqual(validateSocialEvent({ ...fc, providerEventSeq: 5 }, V), null, 'Farcaster cannot carry a provider seq');
  assert.equal(normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://x/p/1', nativeAuthorId: 'did:x', text: 't', providerEventSeq: 'x' }, { nowMs: NOW }).reject, true, 'normalization refuses a malformed seq');
});

test('LIFE-6. the approved Jetstream URL builder: exact hosts, wanted collections, inclusive resume cursor', () => {
  const u = jetstreamUrl({ cursor: 12345 });
  assert.ok(u.startsWith(`wss://${BLUESKY_OFFICIAL.hosts[0]}${BLUESKY_OFFICIAL.streamPath}?`));
  assert.ok(u.includes('wantedCollections=app.bsky.feed.post') && u.includes('wantedCollections=app.bsky.feed.repost'));
  assert.ok(u.endsWith('cursor=12345'));
  assert.ok(!jetstreamUrl({ cursor: null }).includes('cursor='), 'no cursor => live tail');
  assert.throws(() => jetstreamUrl({ host: 'evil.example.com' }), /allowlist/);
});

// ---- cursor event + social replay --------------------------------------------
test('CURSOR-1 (§16). the durable cursor event is closed, deterministic, and validated', () => {
  const ev = socialCursorEvent({ provider: 'BLUESKY_OFFICIAL', durableCursor: 500, knownAtTs: NOW });
  assert.deepEqual(Object.keys(ev).sort(), [...SOCIAL_CURSOR_EVENT_KEYS].sort());
  assert.equal(validateSocialCursorEvent(ev), null);
  assert.equal(ev.sourceEventId, socialCursorIdentity({ provider: 'BLUESKY_OFFICIAL', durableCursor: 500 }));
  assert.equal(socialCursorEvent({ provider: 'BLUESKY_OFFICIAL', durableCursor: 500, knownAtTs: NOW + 99 }).sourceEventId, ev.sourceEventId, 'identity is (provider, cursor) — not the clock');
  assert.notEqual(validateSocialCursorEvent({ ...ev, durableCursor: 501 }), null, 'forged cursor under the same identity rejected');
  assert.notEqual(validateSocialCursorEvent({ ...ev, provider: 'FARCASTER_OFFICIAL' }), null, 'a provider without a cursor domain is rejected');
  assert.notEqual(validateSocialCursorEvent({ ...ev, provider: 'EVIL' }), null, 'unknown provider rejected');
  assert.notEqual(validateSocialCursorEvent({ ...ev, extra: 1 }), null, 'undeclared field rejected');
  assert.notEqual(validateSocialCursorEvent({ ...ev, ts: iso(NOW + 1) }), null, 'ts must equal knownAtTs');
  assert.ok(isSocialEventType(ev.type) && isSocialEventType('RUMOR2_SOCIAL_OBSERVED') && !isSocialEventType('RUMOR2_SOURCE_OBSERVED'));
});

test('CURSOR-2 (§23/§24). social history replay rebuilds the durable index + cursor, and fails closed on regression / forgery', () => {
  const e1 = socialObservationToEvent(obs(commit({ seq: 100 }))).event;
  const e2 = socialObservationToEvent(obs(commit({ seq: 110, op: 'delete' }), NOW + 1)).event;
  const c500 = socialCursorEvent({ provider: 'BLUESKY_OFFICIAL', durableCursor: 500, knownAtTs: NOW });
  const c600 = socialCursorEvent({ provider: 'BLUESKY_OFFICIAL', durableCursor: 600, knownAtTs: NOW + 1 });
  const c550 = socialCursorEvent({ provider: 'BLUESKY_OFFICIAL', durableCursor: 550, knownAtTs: NOW + 2 });
  const core = { type: 'RUMOR2_STARTED', ts: iso(NOW), lifecycle: 'FRESH_START', durability: 'DURABLE', checkpointRevision: 0 };
  const r = replaySocialHistory([core, e1, c500, e2, e1, c600, c600]);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.durableIds].sort(), [e1.sourceEventId, e2.sourceEventId].sort());
  assert.equal(r.cursors.BLUESKY_OFFICIAL, 600);
  assert.equal(r.observed, 2, 'an exact re-append is one truth');
  assert.equal(replaySocialHistory([e1, c500, c600, c550]).ok, false, 'cursor regression 500,600,550 fails closed');
  assert.match(replaySocialHistory([e1, c500, c600, c550]).error, /regression/);
  assert.equal(replaySocialHistory([e1, { ...e1, handle: 'evil' }]).ok, false, 'same identity + altered payload is corruption');
  assert.equal(replaySocialHistory([{ ...e1, provider: 'EVIL_SOCIAL' }]).ok, false, 'unknown provider fails closed');
  assert.equal(replaySocialHistory([{ ...e1, providerKind: 'SOCIAL_FORUM' }]).ok, false, 'provider kind mismatch fails closed');
  assert.equal(replaySocialHistory([{ ...e1, sourceEventId: 'r2sv-' + 'a'.repeat(40) }]).ok, false, 'invalid event identity fails closed');
  assert.equal(replaySocialHistory([{ ...c500, durableCursor: 501 }]).ok, false, 'forged cursor event fails closed');
  assert.equal(replaySocialHistory('nope').ok, false);
});
