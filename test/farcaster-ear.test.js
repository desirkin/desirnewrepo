// SOCIAL-1 — Farcaster/Neynar normalization adapter (pure; credential-gated
// live transport is DARK). Proves cast/reply/recast/delete mapping, FID-based
// (not fname) identity (§9), the intake pipeline over Neynar events, and that
// the live ear stays dark without NEYNAR_API_KEY (§25/§49).
import test from 'node:test';
import assert from 'node:assert/strict';
import { neynarEventToRaw, farcasterConfigured, FARCASTER_OFFICIAL } from '../rumor2/providers/farcaster-official.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { buildSocialFilter, socialAuthorIdentity } from '../rumor2/social.js';

const NOW = Date.parse('2026-09-05T12:00:10Z');
const iso = (ms) => new Date(ms).toISOString();
const T = iso(Date.parse('2026-09-05T12:00:00Z'));

const castCreated = (over = {}) => ({
  type: 'cast.created',
  data: {
    object: 'cast', hash: over.hash ?? '0xcast1', thread_hash: '0xthread', parent_hash: over.parent_hash ?? null,
    root_parent_url: over.root_parent_url ?? null,
    author: { object: 'user', fid: over.fid ?? 42, username: over.username ?? 'alice', display_name: 'Alice', follower_count: 1200, power_badge: true },
    text: over.text ?? 'gm, $FOO mainnet is live', timestamp: over.timestamp ?? T,
    reactions: { likes_count: 5, recasts_count: 2 }, replies: { count: 1 },
  },
});

test('FC-MAP-1. a cast maps to an ORIGINAL observation keyed on cast hash + FID (not the mutable fname)', () => {
  const r = neynarEventToRaw(castCreated());
  assert.equal(r.raw.relation, 'ORIGINAL');
  assert.equal(r.raw.nativePostId, '0xcast1');
  assert.equal(r.raw.nativeAuthorId, 'fid:42');
  assert.equal(r.raw.handle, 'alice');
  assert.equal(r.raw.engagement.likes, 5);
  // power_badge maps to powerBadge (a distinct signal), NOT verified; the Neynar
  // cast payload carries no plain verified flag, so verified is honestly null
  assert.equal(r.raw.authorMeta.powerBadge, true);
  assert.equal(r.raw.authorMeta.verified, null);
  assert.equal(r.raw.authorMeta.followerCount, 1200);
});

test('FC-MAP-2 (§9). a username (fname) rename does not change the author identity; the FID does', () => {
  const a = neynarEventToRaw(castCreated({ hash: '0xa', fid: 7, username: 'oldname' }));
  const b = neynarEventToRaw(castCreated({ hash: '0xb', fid: 7, username: 'newname' }));
  assert.equal(socialAuthorIdentity({ provider: 'FARCASTER_OFFICIAL', nativeAuthorId: a.raw.nativeAuthorId }),
               socialAuthorIdentity({ provider: 'FARCASTER_OFFICIAL', nativeAuthorId: b.raw.nativeAuthorId }));
});

test('FC-MAP-3. reply carries parent; recast is an explicit echo; delete is a tombstone', () => {
  const reply = neynarEventToRaw(castCreated({ hash: '0xr', parent_hash: '0xparent' }));
  assert.equal(reply.raw.relation, 'REPLY');
  assert.equal(reply.raw.parentNativePostId, '0xparent');
  const recast = neynarEventToRaw({ type: 'reaction.created', data: { reaction_type: 'recast', reactor: { fid: 99 }, cast: { hash: '0xtarget', author: { fid: 42 } }, timestamp: T } });
  assert.equal(recast.raw.relation, 'REPOST');
  assert.equal(recast.raw.parentNativePostId, '0xtarget');
  assert.equal(recast.raw.nativePostId, 'recast:fid:99:0xtarget');
  const del = neynarEventToRaw({ type: 'cast.deleted', data: { hash: '0xdead', author: { fid: 42 }, timestamp: T } });
  assert.equal(del.raw.editState, 'TOMBSTONED');
  assert.equal(del.raw.text, '');
});

test('FC-MAP-4. adversarial / unhandled events are skipped, never thrown', () => {
  assert.equal(neynarEventToRaw(null).skip, true);
  assert.equal(neynarEventToRaw({ type: 'cast.created', data: { object: 'cast' } }).skip, true, 'no hash/fid');
  assert.equal(neynarEventToRaw({ type: 'follow.created', data: {} }).skip, true, 'unhandled type');
  assert.equal(neynarEventToRaw({ type: 'reaction.created', data: { reaction_type: 'like', reactor: { fid: 1 }, cast: { hash: '0x' } } }).skip, true, 'likes are not echoes we settle');
});

test('FC-INTAKE. the same intake pipeline dedupes and filters Farcaster casts', () => {
  const intake = socialIntake({ provider: FARCASTER_OFFICIAL, mapCommit: neynarEventToRaw, filter: buildSocialFilter({ terms: ['FOO'] }), now: () => NOW });
  assert.equal(intake.offer(castCreated({ hash: '0x1', text: 'unrelated' })).outcome, 'filtered');
  assert.equal(intake.offer(castCreated({ hash: '0x2', text: 'the $FOO news' })).outcome, 'enqueued');
  assert.equal(intake.offer(castCreated({ hash: '0x2', text: 'the $FOO news' })).outcome, 'deduped');
  assert.equal(intake.size(), 1);
});

test('FC-GATE (§25/§49). the live ear is dark without a credential, and configured only when the key is present', () => {
  assert.equal(farcasterConfigured({}), false);
  assert.equal(farcasterConfigured({ NEYNAR_API_KEY: '' }), false);
  assert.equal(farcasterConfigured({ NEYNAR_API_KEY: 'x' }), true);
  assert.equal(FARCASTER_OFFICIAL.credentialEnv, 'NEYNAR_API_KEY');
});
