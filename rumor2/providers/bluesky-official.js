// SOCIAL-1 — Bluesky / AT Protocol provider. The FIRST live social ear
// (§21). Transport is the official public Jetstream v2 firehose (decoded
// JSON, collection/DID filtering, replay cursor) — never bsky.app HTML. This
// module is PURE: it maps one Jetstream commit message into the shared social
// observation `raw` shape (or a skip), so it is fully fixture-testable with no
// network. The bounded WebSocket transport lives in rumor2/social-stream.js.
//
// Verified against official docs (bsky.network/docs/jetstream, 2026-09-05):
//   endpoint  wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents
//   subproto  xrpc.v1.json ; params collections<=100, dids<=10000, kinds, cursor(seq, inclusive, at-least-once)
//   message   { $type:'message', payload:{ $type:'...#commit', did, seq, time,
//               operation:create|update|delete, collection, rkey, rev, cid, record } }
//   a DELETE carries no record and no cid.

export const BLUESKY_OFFICIAL = Object.freeze({
  id: 'BLUESKY_OFFICIAL',
  providerKind: 'SOCIAL_MICROBLOG',
  organization: 'BLUESKY_PBC', // stable source family for later propagation reasoning
  hosts: Object.freeze(['jetstream.us-east.bsky.network', 'jetstream.us-west.bsky.network']),
  streamPath: '/xrpc/network.bsky.jetstream.subscribeEvents',
  subprotocol: 'xrpc.v1.json',
  postCollection: 'app.bsky.feed.post',
  repostCollection: 'app.bsky.feed.repost',
  wantedCollections: Object.freeze(['app.bsky.feed.post', 'app.bsky.feed.repost']),
});

const isStr = (v) => typeof v === 'string' && v.length > 0;
// AT-URI for a record in a repo: at://<did>/<collection>/<rkey>
const atUri = (did, collection, rkey) => `at://${did}/${collection}/${rkey}`;

// Map ONE Jetstream v2 commit message to a shared-contract `raw` observation.
// Returns { raw } for a relevant post/repost/delete, or { skip, reason } for
// anything outside the post/repost collections or a malformed shape. Never
// throws on adversarial input — a bad message is a skip, not a crash.
export function jetstreamCommitToRaw(message, { provider = 'BLUESKY_OFFICIAL' } = {}) {
  if (message === null || typeof message !== 'object') return { skip: true, reason: 'not an object' };
  const payload = message.payload ?? message; // tolerate pre-unwrapped payloads in fixtures
  if (payload === null || typeof payload !== 'object') return { skip: true, reason: 'no payload' };
  // Jetstream sends commit / identity / account / sync; we only settle commits.
  const kind = payload.kind ?? (payload.$type && String(payload.$type).endsWith('#commit') ? 'commit' : payload.$type);
  if (kind !== 'commit' && payload.commit === undefined && payload.operation === undefined) return { skip: true, reason: 'not a commit event' };
  const did = payload.did;
  const collection = payload.collection ?? payload.commit?.collection;
  const rkey = payload.rkey ?? payload.commit?.rkey;
  const operation = payload.operation ?? payload.commit?.operation;
  const record = payload.record ?? payload.commit?.record ?? null;
  const cid = payload.cid ?? payload.commit?.cid ?? null; // content id = the immutable record VERSION (changes on edit)
  const eventTime = payload.time ?? null; // ISO string of the commit event
  if (!isStr(did) || !isStr(collection) || !isStr(rkey) || !isStr(operation)) return { skip: true, reason: 'incomplete commit' };
  if (collection !== BLUESKY_OFFICIAL.postCollection && collection !== BLUESKY_OFFICIAL.repostCollection) return { skip: true, reason: `collection ${collection} not wanted` };

  const nativePostId = atUri(did, collection, rkey);
  const nativeAuthorId = did;
  const eventMs = eventTime ? Date.parse(eventTime) : NaN;

  // DELETE / tombstone — no record, no content. Preserve as a deletion
  // observation; original knowledge is never rewritten (§17).
  if (operation === 'delete') {
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId, nativeAuthorId,
        text: '', relation: collection === BLUESKY_OFFICIAL.repostCollection ? 'REPOST' : 'ORIGINAL',
        parentNativePostId: null, editState: 'TOMBSTONED',
        canonicalUrl: null, threadId: null, handle: null, nativeVersionId: isStr(cid) ? cid : null,
        sourceCreatedTs: Number.isFinite(eventMs) ? eventMs : Date.now(),
        engagement: null, authorMeta: null,
      },
    };
  }
  // A delete without a record is handled above; a create/update MUST carry a record.
  if (record === null || typeof record !== 'object') return { skip: true, reason: 'commit without a record' };

  // REPOST (explicit echo). record.subject is a StrongRef { uri, cid }.
  if (collection === BLUESKY_OFFICIAL.repostCollection) {
    const subjUri = record.subject?.uri;
    if (!isStr(subjUri)) return { skip: true, reason: 'repost without a subject uri' };
    const created = isStr(record.createdAt) ? Date.parse(record.createdAt) : eventMs;
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId, nativeAuthorId,
        text: '', relation: 'REPOST', parentNativePostId: subjUri,
        editState: operation === 'update' ? 'EDITED' : 'ORIGINAL',
        canonicalUrl: null, threadId: null, handle: null, nativeVersionId: isStr(cid) ? cid : null,
        sourceCreatedTs: Number.isFinite(created) ? created : Date.now(),
        engagement: null, authorMeta: null,
      },
    };
  }

  // POST (create or update). record fields: text, createdAt, reply(root/parent
  // StrongRef), embed (quote = app.bsky.embed.record[WithMedia]).
  const text = typeof record.text === 'string' ? record.text : '';
  const created = isStr(record.createdAt) ? Date.parse(record.createdAt) : eventMs;
  const replyParent = record.reply?.parent?.uri ?? null;
  const replyRoot = record.reply?.root?.uri ?? null;
  const embedType = record.embed?.$type ?? '';
  const quotedUri = record.embed?.record?.uri ?? record.embed?.record?.record?.uri ?? null;
  let relation = 'ORIGINAL';
  let parentNativePostId = null;
  if (isStr(replyParent)) { relation = 'REPLY'; parentNativePostId = replyParent; }
  else if (/app\.bsky\.embed\.record/.test(embedType) && isStr(quotedUri)) { relation = 'QUOTE'; parentNativePostId = quotedUri; }
  return {
    raw: {
      provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId, nativeAuthorId,
      text, relation, parentNativePostId,
      editState: operation === 'update' ? 'EDITED' : 'ORIGINAL',
      canonicalUrl: `https://bsky.app/profile/${did}/post/${rkey}`,
      threadId: isStr(replyRoot) ? replyRoot : nativePostId,
      nativeVersionId: isStr(cid) ? cid : null, // the record CID = this post's immutable version
      handle: null, // Jetstream commits carry the DID, not the handle; resolved elsewhere if needed
      sourceCreatedTs: Number.isFinite(created) ? created : Date.now(),
      engagement: null, // Jetstream post commits carry no engagement counts
      authorMeta: null,
    },
  };
}
