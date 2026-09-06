// SOCIAL-1 — Bluesky / AT Protocol provider. The FIRST live social ear
// (§21). Transport is the official public Jetstream v2 firehose (decoded
// JSON, collection/DID filtering, replay cursor) — never bsky.app HTML. This
// module is PURE: it maps one Jetstream commit message into the shared social
// observation `raw` shape (or a skip), so it is fully fixture-testable with no
// network. The bounded WebSocket transport lives in rumor2/social-stream.js.
//
// Verified against official docs (bsky.network/docs/jetstream, 2026-09-05):
//   endpoint  wss://jetstream.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents (v2 XRPC)
//   subproto  xrpc.v1.json
//   v2 query  kinds=commit (commit events only — without it identity/account/sync
//             events may still be delivered), collections=<nsid> (repeatable; filters
//             COMMIT collections), cursor=<monotonic seq> (inclusive, at-least-once).
//             LEGACY v1 names (wantedCollections, wantedDids, requireHello,
//             options_update) are REJECTED by the v2 endpoint — never sent.
//   message   { $type:'message', payload:{ $type:'...#commit', seq, did, time, rev,
//               operation:create|update|delete, collection, rkey, cid, record } }
//   `seq` is the monotonic per-event sequence number / resume cursor; `time` is the
//   server event timestamp; neither is the post's client-supplied record.createdAt.
//   A DELETE carries no record and no cid.

export const BLUESKY_OFFICIAL = Object.freeze({
  id: 'BLUESKY_OFFICIAL',
  providerKind: 'SOCIAL_MICROBLOG',
  organization: 'BLUESKY_PBC', // stable source family for later propagation reasoning
  hosts: Object.freeze(['jetstream.us-east.bsky.network', 'jetstream.us-west.bsky.network']),
  streamPath: '/xrpc/network.bsky.jetstream.subscribeEvents',
  subprotocol: 'xrpc.v1.json',
  postCollection: 'app.bsky.feed.post',
  repostCollection: 'app.bsky.feed.repost',
  // the CLOSED v2 subscription contract: commit events only, post + repost
  // collections only — immutable provider configuration, never caller-supplied
  kinds: Object.freeze(['commit']),
  collections: Object.freeze(['app.bsky.feed.post', 'app.bsky.feed.repost']),
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
  // SOCIAL-2A: Jetstream v2 `seq` is the provider-native monotonic per-event
  // sequence number — the commit/event identity AND the resume cursor unit,
  // stable per event across cursor replay. It is NOT a timestamp: the server
  // event time is the separate `time` field, and neither is the post's own
  // record.createdAt (sourceCreatedTs). It is the lifecycle identity that keeps
  // CREATE/DELETE/RECREATE/DELETE distinct. Provider-supplied only — never
  // invented. (§9)
  const providerEventSeq = jetstreamCursorOf(message);
  // SOURCE-CLOCK QUARANTINE SEAL (§7): payload.time is the provider EVENT clock —
  // parsed RFC3339 or null; never fabricated, never the post's creation time
  const providerEventTs = isStr(payload.time) && Number.isFinite(Date.parse(payload.time)) ? Date.parse(payload.time) : null;
  if (!isStr(did) || !isStr(collection) || !isStr(rkey) || !isStr(operation)) return { skip: true, reason: 'incomplete commit' };
  if (collection !== BLUESKY_OFFICIAL.postCollection && collection !== BLUESKY_OFFICIAL.repostCollection) return { skip: true, reason: `collection ${collection} not wanted` };

  const nativePostId = atUri(did, collection, rkey);
  const nativeAuthorId = did;

  // DELETE / tombstone — no record, no content. Preserve as a deletion
  // observation; original knowledge is never rewritten (§17).
  if (operation === 'delete') {
    // A Jetstream delete carries no prior record: no text, no subject/parent,
    // no thread. Do NOT fabricate the deleted post's relationship (§17/§18) —
    // relation is UNKNOWN and parent is null, never a REPOST with a null
    // parent (which the CREATE invariant would reject, dropping the tombstone).
    // The stable socialSourceId ties this DELETE back to the earlier CREATE.
    // sourceCreatedTs is null: the commit time is when the DELETE was emitted,
    // NOT when the original post was created — Serpent never fabricates the
    // original creation clock from a lifecycle event (§9). retrieved/known
    // still record when Serpent learned the deletion.
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId, nativeAuthorId,
        text: '', relation: 'UNKNOWN',
        parentNativePostId: null, editState: 'TOMBSTONED',
        canonicalUrl: null, threadId: null, handle: null, nativeVersionId: isStr(cid) ? cid : null, providerEventSeq, providerEventTs,
        sourceDeclaredTs: null, // a delete carries no record.createdAt — UNKNOWN, never the commit time
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
    // the repost's own createdAt is its source-created clock, from the immutable
    // record (deterministic across replay). Absent => null/UNKNOWN, never the
    // firehose delivery time and never Date.now() (§8/§11).
    const created = isStr(record.createdAt) ? Date.parse(record.createdAt) : NaN;
    return {
      raw: {
        provider, providerKind: 'SOCIAL_MICROBLOG', nativePostId, nativeAuthorId,
        text: '', relation: 'REPOST', parentNativePostId: subjUri,
        editState: operation === 'update' ? 'EDITED' : 'ORIGINAL',
        canonicalUrl: null, threadId: null, handle: null, nativeVersionId: isStr(cid) ? cid : null, providerEventSeq, providerEventTs,
        sourceDeclaredTs: Number.isFinite(created) ? created : null, // client-declared; Serpent classifies it
        engagement: null, authorMeta: null,
      },
    };
  }

  // POST (create or update). record fields: text, createdAt, reply(root/parent
  // StrongRef), embed (quote = app.bsky.embed.record[WithMedia]).
  const text = typeof record.text === 'string' ? record.text : '';
  // record.createdAt is the post's immutable source-created clock (deterministic
  // across replay). Absent => null/UNKNOWN, never the firehose delivery time and
  // never Date.now() (§8/§11).
  const created = isStr(record.createdAt) ? Date.parse(record.createdAt) : NaN;
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
      providerEventSeq,
      providerEventTs,
      handle: null, // Jetstream commits carry the DID, not the handle; resolved elsewhere if needed
      // the SOURCE-DECLARED clock: client-supplied record.createdAt (a malformed
      // value maps to null/UNKNOWN — the evidence is kept, never Date.now());
      // normalization decides whether it is TRUSTED or FUTURE_QUARANTINED
      sourceDeclaredTs: Number.isFinite(created) ? created : null,
      engagement: null, // Jetstream post commits carry no engagement counts
      authorMeta: null,
    },
  };
}

// The provider cursor of ONE Jetstream message: payload.seq (a non-negative
// safe integer) or null when absent/invalid. Pure; never throws. (§14/§20)
export function jetstreamCursorOf(message) {
  const payload = message && typeof message === 'object' ? (message.payload ?? message) : null;
  const seq = payload && typeof payload === 'object' ? payload.seq : undefined;
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

// The exact approved Jetstream v2 subscribe URL: deterministic parameter order
//   kinds=commit & collections=<post> & collections=<repost> [& cursor=<seq>]
// Commit-only, post/repost-only — never the whole network's identity/account/
// sync surface. Only the registered hosts are ever used (no caller host); the
// closed provider config supplies kinds/collections (no caller list). A cursor
// is included ONLY when it is a non-negative safe integer (the durable resume
// seq — inclusive, at-least-once); anything else is refused as resume truth and
// omitted. No legacy v1 name (wantedCollections/wantedDids/requireHello) is
// ever emitted — the v2 endpoint rejects them with HTTP 400.
export const JETSTREAM_LEGACY_PARAMS = Object.freeze(['wantedCollections', 'wantedDids', 'requireHello', 'options_update']);
export function jetstreamUrl({ host = BLUESKY_OFFICIAL.hosts[0], cursor = null } = {}) {
  if (!BLUESKY_OFFICIAL.hosts.includes(host)) throw new Error('jetstreamUrl: host not in the approved Bluesky host allowlist');
  const params = [
    ...BLUESKY_OFFICIAL.kinds.map((k) => `kinds=${encodeURIComponent(k)}`),
    ...BLUESKY_OFFICIAL.collections.map((c) => `collections=${encodeURIComponent(c)}`),
  ];
  if (Number.isSafeInteger(cursor) && cursor >= 0) params.push(`cursor=${cursor}`);
  return `wss://${host}${BLUESKY_OFFICIAL.streamPath}?${params.join('&')}`;
}
