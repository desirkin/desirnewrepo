// SOCIAL-1 PROVENANCE INTEGRITY SEAL — the ticket's explicit matrices:
// provider-registry closure (§14), lifecycle-aware relationship law (§24),
// the forgery matrix (§26) + recomputed-forgery (§27), the Bluesky
// delete/tombstone repair (§21/§22/§23), and the eight adversarial passes
// (§34). Pure passes need no network; the delete-durability passes use real PG.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSocialObservation, socialMetaHash, socialVersionIdentity } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';
import { jetstreamCommitToRaw } from '../rumor2/providers/bluesky-official.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-socint-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const C = Date.parse('2026-09-05T12:00:00Z');
const NOW = C + 10_000;
const iso = (m) => new Date(m).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
// a fully-populated event (reply, engagement, handle, cid) so every bound field is exercised
const richEvent = () => {
  const obs = normalizeSocialObservation({
    provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG',
    nativePostId: 'at://did:plc:a/app.bsky.feed.post/r1', nativeAuthorId: 'did:plc:a',
    text: '$FOO listing rumor', relation: 'REPLY', parentNativePostId: 'at://did:plc:b/app.bsky.feed.post/p',
    threadId: 'at://root/app.bsky.feed.post/z', handle: 'alice.bsky.social', nativeVersionId: 'cid1',
    engagement: { likes: 5, reposts: 2, replies: 1, quotes: null, views: null, upvotes: null },
    sourceCreatedTs: C,
  }, { nowMs: NOW }).observation;
  return socialObservationToEvent(obs).event;
};

// ---- §14 provider registry closure ----------------------------------------
const evilEvent = () => socialObservationToEvent(normalizeSocialObservation({ provider: 'EVIL_SOCIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'evil:1', nativeAuthorId: 'evil:a', text: 'pump', sourceCreatedTs: C }, { nowMs: NOW }).observation).event;

test('PROVIDER-1/2. an unregistered provider is rejected by default AND cannot be authorized by a caller allowlist', () => {
  assert.notEqual(validateSocialEvent(evilEvent()), null, 'PROVIDER-1: rejected with no allowlist');
  assert.notEqual(validateSocialEvent(evilEvent(), { socialProviderIds: ['EVIL_SOCIAL'] }), null, 'PROVIDER-2: a broadening allowlist cannot authorize it');
});

test('PROVIDER-3/4. registered provider + correct kind passes; wrong kind rejected', () => {
  assert.equal(validateSocialEvent(richEvent(), V), null, 'PROVIDER-3');
  assert.notEqual(validateSocialEvent({ ...richEvent(), providerKind: 'SOCIAL_FORUM' }, V), null, 'PROVIDER-4: providerKind must match the registry');
});

test('PROVIDER-5/6. Farcaster passes with correct kind; a narrowing allowlist can exclude it for one caller', () => {
  const fc = socialObservationToEvent(normalizeSocialObservation({ provider: 'FARCASTER_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: '0xcast', nativeAuthorId: 'fid:7', text: '$FOO', sourceCreatedTs: C }, { nowMs: NOW }).observation).event;
  assert.equal(validateSocialEvent(fc, V), null, 'PROVIDER-5');
  assert.notEqual(validateSocialEvent(fc, { socialProviderIds: ['BLUESKY_OFFICIAL'] }), null, 'PROVIDER-6: narrowing excludes Farcaster for this caller');
});

// ---- §24 relationship matrix ----------------------------------------------
const norm = (over) => normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://x/p/1', nativeAuthorId: 'did:x', text: over.text ?? 't', sourceCreatedTs: C, ...over }, { nowMs: NOW });

test('REL-1..6. lifecycle-aware relationship law', () => {
  assert.equal(norm({ relation: 'REPOST', parentNativePostId: 'at://a/p/1' }).reject, undefined, 'REL-1 CREATE REPOST + parent passes');
  assert.equal(norm({ relation: 'REPOST', parentNativePostId: null }).reject, true, 'REL-2 CREATE REPOST + no parent rejected');
  assert.equal(norm({ relation: 'UNKNOWN', parentNativePostId: null, editState: 'TOMBSTONED', text: '' }).reject, undefined, 'REL-3 DELETE + UNKNOWN + no parent passes');
  assert.equal(norm({ relation: 'REPLY', parentNativePostId: 'at://a/p/1', editState: 'EDITED' }).reject, undefined, 'REL-5 EDIT REPLY + parent passes');
  assert.equal(norm({ relation: 'ORIGINAL', parentNativePostId: 'at://a/p/1' }).reject, true, 'REL-6 CREATE ORIGINAL + unexpected parent rejected (not silently ignored)');
});

// ---- §26 forgery matrix + §27 recomputed forgery --------------------------
test('FORGE-1..17. every provenance/identity mutation (keeping the version id) is rejected', () => {
  const e = richEvent();
  assert.equal(validateSocialEvent(e, V), null);
  const mutations = {
    relation: 'REPOST', parentNativePostId: 'at://evil/p/9', threadId: 'at://evil/t', sourceCreatedTs: C - 5,
    handle: 'evil.bsky.social', engagement: { likes: 9999, reposts: null, replies: null, quotes: null, views: null, upvotes: null },
    metaHash: 'a'.repeat(40), nativeVersionId: 'cidEVIL', provider: 'FARCASTER_OFFICIAL', providerKind: 'SOCIAL_FORUM',
    nativeAuthorId: 'did:evil', socialAuthorId: 'r2sa-' + 'b'.repeat(40), nativePostId: 'at://evil/p/1',
    socialSourceId: 'r2ss-' + 'c'.repeat(40), lifecycle: 'DELETE', text: 'EVIL text',
  };
  for (const [f, v] of Object.entries(mutations))
    assert.notEqual(validateSocialEvent({ ...e, [f]: v }, V), null, `FORGE ${f} must be rejected`);
  assert.notEqual(validateSocialEvent({ ...e, extraField: 1 }, V), null, 'FORGE-17: unknown field rejected');
});

test('FORGE recomputed (§27). altering provenance + recomputing metaHash but keeping the old sourceEventId is rejected', () => {
  const e = richEvent();
  const tampered = { ...e, relation: 'REPOST', parentNativePostId: 'at://evil/p/1', threadId: 'at://evil/t' };
  // maliciously recompute metaHash to match the tampered facts, but keep old sourceEventId
  tampered.metaHash = socialMetaHash({ ...tampered, socialSourceId: tampered.socialSourceId });
  assert.notEqual(validateSocialEvent(tampered, V), null, 'recomputed metaHash + old sourceEventId => reject');
  // recompute BOTH: it becomes a DISTINCT version id (a new observation), not a mutation of the original (§28 boundary)
  tampered.sourceEventId = socialVersionIdentity({ ...tampered, socialSourceId: tampered.socialSourceId });
  assert.equal(validateSocialEvent(tampered, V), null, 'a fully re-derived event is a new version id — a distinct observation, never the same event mutated');
  assert.notEqual(tampered.sourceEventId, e.sourceEventId, 'the forged provenance produced a DIFFERENT version identity');
});

// ---- §34 eight adversarial passes ------------------------------------------
test('PASS 1 — PROVENANCE REWRITE: change relation/parent/thread => reject', () => {
  const e = richEvent();
  for (const f of ['relation', 'parentNativePostId', 'threadId'])
    assert.notEqual(validateSocialEvent({ ...e, [f]: f === 'relation' ? 'ORIGINAL' : null }, V), null);
});
test('PASS 2 — CLOCK REWRITE: change sourceCreatedTs => reject', () => {
  assert.notEqual(validateSocialEvent({ ...richEvent(), sourceCreatedTs: C - 1 }, V), null);
});
test('PASS 3 — DIAGNOSTIC REWRITE: change handle / first-known engagement => reject', () => {
  assert.notEqual(validateSocialEvent({ ...richEvent(), handle: 'evil' }, V), null);
  assert.notEqual(validateSocialEvent({ ...richEvent(), engagement: { likes: 1, reposts: null, replies: null, quotes: null, views: null, upvotes: null } }, V), null);
});
test('PASS 4/5 — UNKNOWN PROVIDER / CALLER BROADENING => reject', () => {
  assert.notEqual(validateSocialEvent(evilEvent()), null);
  assert.notEqual(validateSocialEvent(evilEvent(), { socialProviderIds: ['EVIL_SOCIAL'] }), null);
});
test('PASS 8 — AUTHORITY: a social event carries no claim/trade authority fields', () => {
  const e = richEvent();
  for (const k of ['propositionId', 'claimType', 'packet', 'order', 'eligibility', 'hyped', 'size'])
    assert.ok(!(k in e), `no ${k}`);
});

// ---- delete/tombstone durability (§21/§22/§23) — real PostgreSQL -----------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL delete durability (PASS 6/7)', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const mkJournal = (db) => rumor2JournalStore({ persistence: () => ({ repo: new Repository(db), health: () => ({ databaseConfigured: true, restored: true }) }) });
  const withDb = async (fn) => {
    const SCHEMA = `socint_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try { assert.equal(await db.connect(), true); await runMigrations(db); await fn({ db, SCHEMA }); }
    finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  };
  const settle = async (journal, events) => { const w = await journal.acquireWriter(); assert.equal(w.ok, true); const r = await journal.append(events); await journal.releaseWriter(); return r; };
  const witnesses = async (journal) => (await journal.read()).events.filter((e) => e.type === SOCIAL_EVENT_TYPE).map(reconstructSocialWitness);
  const bd = (over) => jetstreamCommitToRaw({ payload: { $type: 'x#commit', did: over.did ?? 'did:plc:fan', seq: over.seq ?? 1, time: iso(over.time ?? C), operation: over.op ?? 'create', collection: over.collection ?? 'app.bsky.feed.post', rkey: over.rkey ?? 'r', cid: over.cid, record: over.record } }).raw;
  const ev = (raw, nowMs = NOW) => socialObservationToEvent(normalizeSocialObservation(raw, { nowMs }).observation).event;

  test('BLUESKY-DEL-1 (§21 PASS 6). delete of a repost is preserved without a fabricated parent; survives restart', async () => {
    await withDb(async ({ db, SCHEMA }) => {
      const create = bd({ did: 'did:plc:fan', rkey: 're', cid: 'cidR', collection: 'app.bsky.feed.repost', record: { $type: 'app.bsky.feed.repost', createdAt: iso(C), subject: { uri: 'at://did:plc:src/app.bsky.feed.post/A', cid: 'cA' } } });
      const del = bd({ did: 'did:plc:fan', rkey: 're', seq: 2, op: 'delete', collection: 'app.bsky.feed.repost', time: C + 60_000 });
      const cE = ev(create), dE = ev(del, NOW + 60_000);
      assert.equal(validateSocialEvent(cE, V), null);
      assert.equal(validateSocialEvent(dE, V), null, 'the tombstone validates');
      await settle(mkJournal(db), [cE, dE]);
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try {
        assert.equal(await db2.connect(), true);
        const ws = await witnesses(mkJournal(db2));
        const c = ws.find((w) => w.relation === 'REPOST');
        const d = ws.find((w) => w.lifecycle === 'TOMBSTONE');
        assert.equal(c.parentNativePostId, 'at://did:plc:src/app.bsky.feed.post/A', 'CREATE keeps its repost target');
        assert.equal(d.relation, 'UNKNOWN', 'DELETE does not fabricate the target');
        assert.equal(d.parentNativePostId, null);
        assert.equal(c.socialSourceId, d.socialSourceId, 'both share the stable post identity');
        assert.notEqual(c.versionId, d.versionId, 'CREATE and DELETE are distinct versions');
      } finally { await db2.end(); }
    });
  });

  test('BLUESKY-DEL-2 (§22). a deletion with no prior CREATE in history is still a representable tombstone', async () => {
    await withDb(async ({ db }) => {
      const del = ev(bd({ rkey: 'gone', op: 'delete', collection: 'app.bsky.feed.post', time: C }), NOW);
      assert.equal(validateSocialEvent(del, V), null);
      await settle(mkJournal(db), [del]);
      const [w] = await witnesses(mkJournal(db));
      assert.equal(w.lifecycle, 'TOMBSTONE');
      assert.equal(w.text, '', 'prior content is UNKNOWN, never fabricated');
    });
  });

  test('BLUESKY-DEL-3 (§23 PASS 7). the same delete redelivered is one durable tombstone', async () => {
    await withDb(async ({ db }) => {
      const j = mkJournal(db);
      const del = ev(bd({ rkey: 'gone', op: 'delete', collection: 'app.bsky.feed.post', time: C }), NOW);
      await settle(j, [del]); await settle(j, [del]); await settle(j, [del]);
      assert.equal((await witnesses(j)).length, 1);
    });
  });
}
