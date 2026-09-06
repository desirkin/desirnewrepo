// SOCIAL-1 — Farcaster provider. Access is credential-gated: the practical
// real-time path is the Neynar hosted API (x-api-key; free tier) — the hub/
// Snapchain path needs a full syncing node and is not lightweight (see the
// census in doctrine/SOCIAL.md). SOCIAL-1 ships the PURE normalization adapter
// + fixtures; the live transport (Neynar webhook/Kafka) stays DARK until
// NEYNAR_API_KEY is configured (§25/§49). This module never holds a key and
// never touches the network.
//
// Identifiers (docs.farcaster.xyz/learn/what-is-farcaster/messages):
//   cast hash — immutable cast id ; FID — immutable numeric author id ;
//   fname/username — MUTABLE (never the durable identity). Casts are NOT
//   editable (delete+republish); deletes are tombstones; a recast is a
//   reaction of type RECAST (an explicit echo).

export const FARCASTER_OFFICIAL = Object.freeze({
  id: 'FARCASTER_OFFICIAL',
  providerKind: 'SOCIAL_MICROBLOG',
  organization: 'FARCASTER',
  transport: 'NEYNAR_WEBHOOK_REST',
  hosts: Object.freeze(['api.neynar.com', 'hub.neynar.com']),
  credentialEnv: 'NEYNAR_API_KEY',
});

// Live transport is dark unless a credential is present. Never logs the key.
export function farcasterConfigured(env = process.env) {
  const k = env?.[FARCASTER_OFFICIAL.credentialEnv];
  return typeof k === 'string' && k.length > 0;
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const fidStr = (v) => (Number.isInteger(v) && v > 0 ? `fid:${v}` : (isStr(v) ? String(v) : null));

// Map ONE Neynar webhook event to the shared-contract `raw` observation, or a
// skip. Handles cast.created, cast.deleted, and reaction.created(recast).
// Pure and total: adversarial input is a skip, never a throw.
export function neynarEventToRaw(event, { provider = 'FARCASTER_OFFICIAL' } = {}) {
  if (event === null || typeof event !== 'object') return { skip: true, reason: 'not an object' };
  const type = event.type;
  const d = event.data ?? event;
  if (d === null || typeof d !== 'object') return { skip: true, reason: 'no data' };

  if (type === 'cast.created' || (d.object === 'cast' && d.hash && !type)) {
    const hash = d.hash;
    const authorFid = fidStr(d.author?.fid);
    if (!isStr(hash) || !authorFid) return { skip: true, reason: 'cast without hash/fid' };
    const parentHash = isStr(d.parent_hash) ? d.parent_hash : null;
    // the cast's provider-supplied creation time; absent/invalid => null/UNKNOWN,
    // never Date.now() (§8/§11)
    const created = isStr(d.timestamp) ? Date.parse(d.timestamp) : NaN;
    const reactions = d.reactions ?? {};
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId: hash, nativeAuthorId: authorFid,
        text: typeof d.text === 'string' ? d.text : '',
        relation: parentHash ? 'REPLY' : 'ORIGINAL', parentNativePostId: parentHash, editState: 'ORIGINAL',
        canonicalUrl: isStr(d.author?.username) ? `https://warpcast.com/${d.author.username}/${hash.slice(0, 10)}` : null,
        threadId: isStr(d.root_parent_url) ? d.root_parent_url : (isStr(d.thread_hash) ? d.thread_hash : hash),
        handle: isStr(d.author?.username) ? d.author.username : null,
        displayName: isStr(d.author?.display_name) ? d.author.display_name : null,
        sourceCreatedTs: Number.isFinite(created) ? created : null,
        engagement: {
          likes: Number.isSafeInteger(reactions.likes_count) ? reactions.likes_count : null,
          reposts: Number.isSafeInteger(reactions.recasts_count) ? reactions.recasts_count : null,
          replies: Number.isSafeInteger(d.replies?.count) ? d.replies.count : null,
        },
        // CLOSED first-known author metadata (§16): only provider-normalizable,
        // bounded facts; unavailable => null/UNKNOWN, never a fake zero/false.
        // powerBadge is a distinct signal — never conflated with `verified`
        // (Neynar cast payloads carry no plain verified flag; account creation
        // time is absent here too, so both are honestly null).
        authorMeta: {
          accountCreatedTs: null,
          followerCount: Number.isSafeInteger(d.author?.follower_count) ? d.author.follower_count : null,
          followingCount: Number.isSafeInteger(d.author?.following_count) ? d.author.following_count : null,
          verified: typeof d.author?.verified === 'boolean' ? d.author.verified : null,
          powerBadge: typeof d.author?.power_badge === 'boolean' ? d.author.power_badge : null,
        },
      },
    };
  }

  if (type === 'cast.deleted') {
    const hash = d.hash;
    const authorFid = fidStr(d.author?.fid);
    if (!isStr(hash) || !authorFid) return { skip: true, reason: 'delete without hash/fid' };
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId: hash, nativeAuthorId: authorFid,
        text: '', relation: 'ORIGINAL', parentNativePostId: null, editState: 'TOMBSTONED',
        canonicalUrl: null, threadId: null, handle: null,
        // a delete's timestamp is when the deletion was emitted, NOT the cast's
        // original creation — never fabricate the original clock from it (§9)
        sourceCreatedTs: null,
        engagement: null, authorMeta: null,
      },
    };
  }

  if (type === 'reaction.created' && (d.reaction_type === 'recast' || d.reaction_type === 2)) {
    const targetHash = d.cast?.hash;
    const reactorFid = fidStr(d.reactor?.fid ?? d.user?.fid);
    if (!isStr(targetHash) || !reactorFid) return { skip: true, reason: 'recast without target/reactor' };
    // a recast has no cast hash of its own — derive a deterministic native id
    // for the echo edge (reactor + target), so re-delivery dedupes correctly
    const recastCreated = isStr(d.timestamp) ? Date.parse(d.timestamp) : NaN;
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId: `recast:${reactorFid}:${targetHash}`, nativeAuthorId: reactorFid,
        text: '', relation: 'REPOST', parentNativePostId: targetHash, editState: 'ORIGINAL',
        canonicalUrl: null, threadId: null, handle: null,
        // the recast's own creation time; absent/invalid => null/UNKNOWN, never
        // Date.now() (§8/§11)
        sourceCreatedTs: Number.isFinite(recastCreated) ? recastCreated : null,
        engagement: null, authorMeta: null,
      },
    };
  }

  return { skip: true, reason: `unhandled event type ${type ?? '(none)'}` };
}
