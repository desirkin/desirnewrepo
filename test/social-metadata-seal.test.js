// SOCIAL-1 FINAL METADATA + TIME-SEMANTICS SEAL — the ticket's explicit
// matrices: handle out of content-version identity (§2/§4/§22), the
// content-vs-diagnostic hash separation (§26), first-known duplicate law
// (§6/§22/§23/§24), stored-diagnostic tamper (§25), the unknown / never-
// fabricated source-created clock (§7-§13), and first-known author-metadata
// durability through the authoritative journal (§14-§21). Pure passes need no
// network; the durability passes use real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeSocialObservation, socialMetaHash, socialVersionIdentity,
  socialProvenanceFacts, socialDiagnosticFacts, canonicalAuthorMeta,
  buildSocialFilter,
} from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';
import { classifyOfficialItem } from '../rumor2/truth.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { neynarEventToRaw, FARCASTER_OFFICIAL } from '../rumor2/providers/farcaster-official.js';
import { jetstreamCommitToRaw } from '../rumor2/providers/bluesky-official.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-socseal-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const C = Date.parse('2026-09-05T12:00:00Z');
const NOW = C + 10_000;
const iso = (m) => new Date(m).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };

// ONE unchanged provider-native Farcaster cast/version, with mutable diagnostics
// (handle / follower count / engagement) that a later delivery may legitimately
// change. hash + FID + timestamp + text + relation are the immutable content.
const castRaw = (over = {}) => neynarEventToRaw({ type: 'cast.created', data: {
  object: 'cast', hash: over.hash ?? '0xsame', parent_hash: null,
  author: {
    object: 'user', fid: over.fid ?? 7, username: over.username ?? 'alice.crypto',
    follower_count: over.followers ?? 100, following_count: over.following ?? 50,
    power_badge: over.powerBadge ?? true,
  },
  text: over.text ?? '$FOO mainnet is live', timestamp: over.timestamp ?? iso(C),
  reactions: { likes_count: over.likes ?? 10, recasts_count: 2 }, replies: { count: 1 },
} }).raw;
const castObs = (over = {}, nowMs = NOW) => normalizeSocialObservation(castRaw(over), { nowMs }).observation;

// ---- §2/§4/§22 handle is NOT content-version identity -----------------------
test('SEAL-HANDLE-1 (§22). a handle rename keeps identity + content version; only the diagnostic hash moves', () => {
  const a = castObs({ username: 'alice.crypto' }, C + 1000);
  const b = castObs({ username: 'alice' }, C + 2000);
  assert.equal(a.socialSourceId, b.socialSourceId, 'stable post identity unchanged');
  assert.equal(a.socialAuthorId, b.socialAuthorId, 'native author identity (FID) unchanged');
  assert.equal(a.socialVersionId, b.socialVersionId, 'content/version identity unchanged by a handle rename');
  assert.notEqual(a.metaHash, b.metaHash, 'the first-known diagnostic hash captures the handle change');
  assert.equal(a.handle, 'alice.crypto');
  assert.equal(b.handle, 'alice');
});

test('SEAL-HANDLE-2 (§4/§26). handle is absent from content facts and present in diagnostic facts', () => {
  const o = castObs();
  assert.equal('handle' in socialProvenanceFacts(o), false, 'handle is NOT a content/version fact');
  assert.equal(socialDiagnosticFacts(o).handle, o.handle, 'handle IS a first-known diagnostic fact');
  // the content/version identity derives from provenance facts only
  assert.equal(o.socialVersionId, socialVersionIdentity({ ...socialProvenanceFacts(o), socialSourceId: o.socialSourceId }));
});

// ---- §23/§24 follower-count and engagement do not fork a version -----------
test('SEAL-FOLLOWERS (§23). a follower-count change keeps the content version; diagnostic hash moves', () => {
  const a = castObs({ followers: 100 }, C + 1000);
  const b = castObs({ followers: 500 }, C + 2000);
  assert.equal(a.socialVersionId, b.socialVersionId, 'follower growth is not a new content version');
  assert.notEqual(a.metaHash, b.metaHash);
  assert.equal(a.authorMeta.followerCount, 100);
  assert.equal(b.authorMeta.followerCount, 500);
});

test('SEAL-ENGAGEMENT (§24). engagement growth keeps the content version; first-known snapshot differs', () => {
  const a = castObs({ likes: 10 }, C + 1000);
  const b = castObs({ likes: 100 }, C + 2000);
  assert.equal(a.socialVersionId, b.socialVersionId, 'engagement growth is not a new content version');
  assert.notEqual(a.metaHash, b.metaHash);
  assert.equal(a.engagement.likes, 10);
  assert.equal(b.engagement.likes, 100);
});

test('SEAL-CONTENT-CHANGE (control). a TEXT change DOES fork the content version (real edits preserved, §27)', () => {
  const a = castObs({ text: '$FOO v1' });
  const b = castObs({ text: '$FOO v2 edited' });
  assert.notEqual(a.socialVersionId, b.socialVersionId, 'a content change is a new version');
});

// ---- §6/§22 first-known duplicate law at the intake dedup boundary ----------
test('SEAL-FIRST-KNOWN (§6). a diagnostic-only redelivery dedupes keep-first — no new version, no corruption', () => {
  const intake = socialIntake({ provider: FARCASTER_OFFICIAL, mapCommit: neynarEventToRaw, filter: buildSocialFilter({ terms: ['FOO'] }), now: () => NOW });
  // delivery A: old handle, followers 100, likes 10
  const rA = intake.offer({ type: 'cast.created', data: { object: 'cast', hash: '0xdup', author: { fid: 7, username: 'oldname', follower_count: 100, following_count: 50, power_badge: true }, text: '$FOO news', timestamp: iso(C), reactions: { likes_count: 10 } } });
  // delivery B: SAME immutable cast, new handle, followers 500, likes 99
  const rB = intake.offer({ type: 'cast.created', data: { object: 'cast', hash: '0xdup', author: { fid: 7, username: 'newname', follower_count: 500, following_count: 60, power_badge: true }, text: '$FOO news', timestamp: iso(C), reactions: { likes_count: 99 } } });
  assert.equal(rA.outcome, 'enqueued');
  assert.equal(rB.outcome, 'deduped', 'a diagnostic-only redelivery is one truth, not corruption');
  assert.equal(intake.stats().corrupt, 0, 'never classified as corruption');
  const [{ observation: o }] = intake.drain();
  assert.equal(o.handle, 'oldname', 'the FIRST-KNOWN diagnostic snapshot is retained');
  assert.equal(o.authorMeta.followerCount, 100);
  assert.equal(o.engagement.likes, 10);
});

// ---- §25 stored-diagnostic tamper ------------------------------------------
test('SEAL-TAMPER (§18/§25). rewriting any stored first-known diagnostic fails validation', () => {
  const obs = castObs();
  const { event } = socialObservationToEvent(obs);
  assert.equal(validateSocialEvent(event, V), null, 'the honest event validates');
  const tampers = {
    handle: 'evil',
    authorMeta: { ...event.authorMeta, followerCount: 999_999 },
    engagement: { ...event.engagement, likes: 999_999 },
  };
  for (const [f, v] of Object.entries(tampers))
    assert.notEqual(validateSocialEvent({ ...event, [f]: v }, V), null, `stored ${f} tamper rejected by the diagnostic hash`);
  // every authorMeta field is bound
  for (const k of ['accountCreatedTs', 'followerCount', 'followingCount', 'verified', 'powerBadge']) {
    const mutated = { ...event.authorMeta, [k]: k === 'verified' || k === 'powerBadge' ? false : (event.authorMeta[k] === null ? 1 : (event.authorMeta[k] ?? 0) + 1) };
    if (k === 'accountCreatedTs') mutated[k] = C - 1_000_000; // a plausible-but-different value
    assert.notEqual(validateSocialEvent({ ...event, authorMeta: mutated }, V), null, `stored authorMeta.${k} tamper rejected`);
  }
});

// ---- §7-§13 unknown / never-fabricated source-created clock -----------------
test('SEAL-BSKY-DELETE-CLOCK (§9/§12). a Bluesky delete without a create clock is UNKNOWN and deterministic', () => {
  const delRaw = () => jetstreamCommitToRaw({ payload: { $type: 'x#commit', did: 'did:plc:z', seq: 1, time: iso(C), operation: 'delete', collection: 'app.bsky.feed.post', rkey: 'r1', cid: undefined, record: undefined } }).raw;
  assert.equal(delRaw().sourceDeclaredTs, null, 'the ear never fabricates the original creation clock for a delete');
  const d1 = normalizeSocialObservation(delRaw(), { nowMs: C + 1_000 }).observation;
  const d2 = normalizeSocialObservation(delRaw(), { nowMs: C + 9_999 }).observation;
  assert.equal(d1.socialSourceId, d2.socialSourceId, 'same stable post identity');
  assert.equal(d1.socialVersionId, d2.socialVersionId, 'same deterministic DELETE version across retrieval times');
  assert.equal(d1.sourceCreatedTs, null, 'sourceCreatedTs stays UNKNOWN');
  assert.notEqual(d1.retrievedTs, d2.retrievedTs, 'retrievedTs legitimately differs per acquisition');
  assert.equal(d1.knownAtTs, d1.retrievedTs, 'knownAt follows acquisition, never backdated');
  assert.equal(d1.lifecycle, 'TOMBSTONE');
});

test('SEAL-FC-MISSING-CLOCK (§13). a Farcaster cast with a missing timestamp is UNKNOWN and deterministic', () => {
  const missRaw = () => neynarEventToRaw({ type: 'cast.created', data: { object: 'cast', hash: '0xmiss', author: { fid: 9, username: 'x' }, text: '$FOO' } }).raw;
  assert.equal(missRaw().sourceDeclaredTs, null, 'no Date.now fabrication for a missing source clock');
  const f1 = normalizeSocialObservation(missRaw(), { nowMs: C + 1_000 }).observation;
  const f2 = normalizeSocialObservation(missRaw(), { nowMs: C + 5_000 }).observation;
  assert.equal(f1.sourceCreatedTs, null);
  assert.equal(f1.socialVersionId, f2.socialVersionId, 'same immutable content/version identity with unknown source time (§11)');
  assert.notEqual(f1.retrievedTs, f2.retrievedTs);
});

test('SEAL-CLOCK-LAW (§10 / SOURCE-CLOCK QUARANTINE). a future declared clock is QUARANTINED, not dropped; unknown clock passes', () => {
  const future = normalizeSocialObservation(castRaw({ timestamp: iso(NOW + 60_000) }), { nowMs: NOW });
  assert.equal(future.reject, undefined, 'the evidence is retained');
  assert.equal(future.observation.sourceClockStatus, 'FUTURE_QUARANTINED');
  assert.equal(future.observation.sourceCreatedTs, null, 'a future declared clock never becomes the trusted source clock');
  assert.equal(future.observation.sourceDeclaredTs, NOW + 60_000); assert.equal(future.observation.sourceClockSkewMs, 60_000);
  assert.equal(future.observation.knownAtTs, NOW, 'knownAt is never backdated');
  const unknown = normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://x/p/1', nativeAuthorId: 'did:x', text: 't' /* no source clock */ }, { nowMs: NOW });
  assert.equal(unknown.reject, undefined, 'an absent source clock is accepted as UNKNOWN, not rejected');
  assert.equal(unknown.observation.sourceCreatedTs, null); assert.equal(unknown.observation.sourceClockStatus, 'UNKNOWN');
});

// ---- §26 the durable event validator re-derives BOTH hashes -----------------
test('SEAL-VALIDATOR (§26). a durable event with a null source clock validates and round-trips', () => {
  const { event } = socialObservationToEvent(normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://x/p/2', nativeAuthorId: 'did:x', text: 'unknown clock' }, { nowMs: NOW }).observation);
  assert.equal(event.sourceCreatedTs, null);
  assert.equal(validateSocialEvent(event, V), null, 'null source clock is a valid durable event');
  // re-deriving with a fabricated clock breaks the content identity
  assert.notEqual(validateSocialEvent({ ...event, sourceCreatedTs: NOW }, V), null, 'injecting a source clock is rejected (content identity)');
});

// ---- §30 authority: diagnostics carry no claim/trade authority --------------
test('SEAL-AUTHORITY (§30). authorMeta/handle/engagement/clocks are information-only', () => {
  const { event } = socialObservationToEvent(castObs());
  for (const k of ['propositionId', 'claimType', 'packet', 'order', 'eligibility', 'size', 'hyped', 'score', 'attention'])
    assert.ok(!(k in event), `social event has no ${k}`);
  assert.ok(event.authorMeta !== undefined, 'authorMeta is retained');
  assert.equal(classifyOfficialItem({ providerKind: 'SOCIAL_MICROBLOG', title: 'FOO lists', summary: 'now' }), null, 'social kind mints no claim');
  assert.equal(classifyOfficialItem({ providerKind: 'SOCIAL_FORUM', title: 'x', summary: 'y' }), null);
});

test('SEAL-KEYS. the closed durable schema declares authorMeta and stays closed', () => {
  assert.ok(SOCIAL_EVENT_KEYS.includes('authorMeta'));
  const { event } = socialObservationToEvent(castObs());
  assert.notEqual(validateSocialEvent({ ...event, extra: 1 }, V), null, 'undeclared field rejected');
  assert.deepEqual(canonicalAuthorMeta(event.authorMeta), { accountCreatedTs: null, followerCount: 100, followingCount: 50, verified: null, powerBadge: true });
});

// ---- §14-§21 durable author-metadata durability (real PostgreSQL) -----------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL metadata durability (PASS 7)', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const mkJournal = (db) => rumor2JournalStore({ persistence: () => ({ repo: new Repository(db), health: () => ({ databaseConfigured: true, restored: true }) }) });
  const withDb = async (fn) => {
    const SCHEMA = `socseal_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try { assert.equal(await db.connect(), true); await runMigrations(db); await fn({ db, SCHEMA }); }
    finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  };
  const settle = async (journal, events) => { const w = await journal.acquireWriter(); assert.equal(w.ok, true); const r = await journal.append(events); await journal.releaseWriter(); return r; };
  const witnesses = async (journal) => (await journal.read()).events.filter((e) => e.type === SOCIAL_EVENT_TYPE).map(reconstructSocialWitness);

  test('SEAL-DUR-1 (§21/§20). first-known authorMeta survives journal + restart exactly, as information only', async () => {
    await withDb(async ({ db, SCHEMA }) => {
      const obs = castObs({ username: 'alice.crypto', followers: 1200, following: 300, powerBadge: true });
      const { event } = socialObservationToEvent(obs);
      assert.equal(validateSocialEvent(event, V), null);
      await settle(mkJournal(db), [event]);
      // restart: a fresh Db/journal on the same schema reads the durable truth
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try {
        assert.equal(await db2.connect(), true);
        const [w] = await witnesses(mkJournal(db2));
        assert.equal(w.nativeAuthorId, 'fid:7');
        assert.match(w.socialAuthorId, /^r2sa-[0-9a-f]{40}$/);
        assert.equal(w.handle, 'alice.crypto', 'first-known handle retained as diagnostic');
        assert.deepEqual(w.authorMeta, { accountCreatedTs: null, followerCount: 1200, followingCount: 300, verified: null, powerBadge: true }, 'authorMeta retained exactly across restart');
        // information only — no claim/trade authority materialized
        for (const k of ['propositionId', 'claimType', 'packet', 'order', 'eligibility', 'size', 'hyped'])
          assert.ok(!(k in w), `witness has no ${k}`);
        assert.equal(validateSocialEvent((await mkJournal(db2).read()).events.find((e) => e.type === SOCIAL_EVENT_TYPE), V), null, 'the restored event re-derives both hashes');
      } finally { await db2.end(); }
    });
  });

  test('SEAL-DUR-2 (§6/§22). a diagnostic-only redelivery collapses to one durable truth (keep-first)', async () => {
    await withDb(async ({ db }) => {
      const j = mkJournal(db);
      // the pipeline dedupes by version identity keep-first, so only the FIRST
      // snapshot ever reaches the journal — the redelivery is never a conflicting
      // durable append (which the journal would reject) nor a new version.
      const intake = socialIntake({ provider: FARCASTER_OFFICIAL, mapCommit: neynarEventToRaw, filter: buildSocialFilter({ terms: ['FOO'] }), now: () => NOW });
      intake.offer({ type: 'cast.created', data: { object: 'cast', hash: '0xkeep', author: { fid: 7, username: 'oldname', follower_count: 100, following_count: 50, power_badge: true }, text: '$FOO news', timestamp: iso(C), reactions: { likes_count: 10 } } });
      intake.offer({ type: 'cast.created', data: { object: 'cast', hash: '0xkeep', author: { fid: 7, username: 'newname', follower_count: 900, following_count: 80, power_badge: true }, text: '$FOO news', timestamp: iso(C), reactions: { likes_count: 88 } } });
      const events = intake.drain().map((env) => socialObservationToEvent(env.observation).event);
      assert.equal(events.length, 1, 'keep-first at the ear: one truth drained');
      const r = await settle(j, events);
      assert.equal(r.ok, true);
      const ws = await witnesses(j);
      assert.equal(ws.length, 1, 'one durable content version');
      assert.equal(ws[0].handle, 'oldname', 'first-known handle retained durably');
      assert.equal(ws[0].authorMeta.followerCount, 100, 'first-known follower count retained durably');
    });
  });

  test('SEAL-DUR-3 (§12). a delete with an UNKNOWN source clock settles and round-trips', async () => {
    await withDb(async ({ db }) => {
      const j = mkJournal(db);
      const del = normalizeSocialObservation(jetstreamCommitToRaw({ payload: { $type: 'x#commit', did: 'did:plc:z', seq: 1, time: iso(C), operation: 'delete', collection: 'app.bsky.feed.post', rkey: 'r9', cid: undefined, record: undefined } }).raw, { nowMs: NOW }).observation;
      const { event } = socialObservationToEvent(del);
      assert.equal(event.sourceCreatedTs, null);
      assert.equal(validateSocialEvent(event, V), null, 'a null-source-clock tombstone is a valid durable event');
      await settle(j, [event]);
      const [w] = await witnesses(j);
      assert.equal(w.lifecycle, 'TOMBSTONE');
      assert.equal(w.sourceCreatedTs, null, 'UNKNOWN source clock survives the journal, never fabricated');
    });
  });
}
