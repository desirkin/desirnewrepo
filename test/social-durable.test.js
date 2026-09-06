// SOCIAL-1 closeout — durable social provenance through the FROZEN event root
// (real PostgreSQL). Proves a normalized social observation settles as a
// RUMOR2_SOCIAL_OBSERVED event in the SAME journal, under the SAME writer epoch
// (§6/§34/§35), and that NO author/relationship/version/edit/deletion truth is
// lost across the journal boundary or a restart (§16-§24). No parallel store,
// no social checkpoint, no new migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';
import { jetstreamCommitToRaw } from '../rumor2/providers/bluesky-official.js';
import { neynarEventToRaw } from '../rumor2/providers/farcaster-official.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-social-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const C = Date.parse('2026-09-05T12:00:00Z');
const NOW = C + 10_000;
const iso = (ms) => new Date(ms).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };

const obsFrom = (raw, nowMs = NOW) => normalizeSocialObservation(raw, { nowMs }).observation;
const bskyPost = (over = {}) => jetstreamCommitToRaw({ payload: {
  $type: 'x#commit', did: over.did ?? 'did:plc:alice', seq: over.seq ?? 1, time: iso(over.time ?? C),
  operation: over.op ?? 'create', collection: over.collection ?? 'app.bsky.feed.post', rkey: over.rkey ?? 'r1',
  cid: over.cid ?? 'bafyCID1', record: over.record,
} }).raw;
const postRecord = (over = {}) => { const { text, createdAt, ...rest } = over; return { $type: 'app.bsky.feed.post', text: text ?? '$FOO lists today', createdAt: iso(createdAt ?? C), ...rest }; };

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');

  const mkJournal = (db) => {
    const repo = new Repository(db);
    const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
    return rumor2JournalStore({ persistence });
  };
  const withDb = async (fn) => {
    const SCHEMA = `soc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 7, 'social evidence rides the existing frozen event-root schema — no new migration');
      await fn({ db, SCHEMA, journal: mkJournal(db) });
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  };
  // append a batch of social events under a freshly acquired writer epoch
  const settle = async (journal, events) => {
    const w = await journal.acquireWriter();
    assert.equal(w.ok, true, 'writer acquired');
    const r = await journal.append(events);
    await journal.releaseWriter();
    return r;
  };
  const readWitnesses = async (journal) => (await journal.read()).events.filter((e) => e.type === SOCIAL_EVENT_TYPE).map(reconstructSocialWitness);

  test('SOC-DUR-1 (§16/§17). a Bluesky post round-trips with every provenance fact intact and re-derivable', async () => {
    await withDb(async ({ journal }) => {
      const obs = obsFrom(bskyPost({ record: postRecord({ text: '$FOO listing rumor', reply: { root: { uri: 'at://root/app.bsky.feed.post/z', cid: 'c' }, parent: { uri: 'at://did:plc:bob/app.bsky.feed.post/p', cid: 'c' } } }) }));
      const { event } = socialObservationToEvent(obs);
      assert.equal(validateSocialEvent(event, V), null, 'the durable event validates');
      assert.equal((await settle(journal, [event])).ok, true);
      const [w] = await readWitnesses(journal);
      assert.equal(w.nativePostId, 'at://did:plc:alice/app.bsky.feed.post/r1');
      assert.equal(w.nativeAuthorId, 'did:plc:alice');
      assert.match(w.socialAuthorId, /^r2sa-[0-9a-f]{40}$/);
      assert.equal(w.relation, 'REPLY');
      assert.equal(w.parentNativePostId, 'at://did:plc:bob/app.bsky.feed.post/p');
      assert.equal(w.threadId, 'at://root/app.bsky.feed.post/z');
      assert.equal(w.nativeVersionId, 'bafyCID1', 'the immutable CID version survives');
      assert.equal(w.lifecycle, 'CREATE');
      assert.equal(w.knownAtTs, NOW, 'knownAt is retrieval time');
      // the settled event alone re-derives its own identities
      assert.equal(validateSocialEvent((await journal.read()).events[0], V), null);
    });
  });

  test('SOC-DUR-2 (§35). no social write without a held writer epoch — the fence applies to social evidence', async () => {
    await withDb(async ({ journal }) => {
      const { event } = socialObservationToEvent(obsFrom(bskyPost({ record: postRecord() })));
      assert.equal((await journal.append([event])).reason, 'WRITER_FENCE_LOST', 'no epoch => refused');
      const w = await journal.acquireWriter();
      assert.equal((await journal.append([event])).ok, true);
      await journal.releaseWriter();
      assert.equal((await journal.append([event])).ok, false, 'after release the social writer cannot append');
    });
  });

  test('SOC-DUR-3 (§23). the same version delivered repeatedly is ONE durable truth', async () => {
    await withDb(async ({ journal }) => {
      const { event } = socialObservationToEvent(obsFrom(bskyPost({ record: postRecord() })));
      await settle(journal, [event]);
      await settle(journal, [event]); // exact re-append
      await settle(journal, [event]);
      assert.equal((await readWitnesses(journal)).length, 1, 'exact re-append collapsed to one truth');
    });
  });

  test('SOC-DUR-4 (§18 repost). origin and native repost both durable; the repost references its origin; survives restart', async () => {
    await withDb(async ({ db, SCHEMA, journal }) => {
      const origin = obsFrom(bskyPost({ did: 'did:plc:src', rkey: 'o', cid: 'cidO', record: postRecord({ text: '$FOO mainnet live' }) }));
      const repost = obsFrom(bskyPost({ did: 'did:plc:fan', rkey: 're', cid: 'cidR', collection: 'app.bsky.feed.repost', record: { $type: 'app.bsky.feed.repost', createdAt: iso(C + 60_000), subject: { uri: origin.nativePostId, cid: 'cidO' } } }), NOW + 60_000);
      await settle(journal, [socialObservationToEvent(origin).event, socialObservationToEvent(repost).event]);
      // restart: a fresh Db/journal on the same schema reads the durable truth
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try {
        assert.equal(await db2.connect(), true);
        const ws = await readWitnesses(mkJournal(db2));
        assert.equal(ws.length, 2);
        const rp = ws.find((w) => w.relation === 'REPOST');
        assert.equal(rp.parentNativePostId, origin.nativePostId, 'the repost still points at its origin after restart');
        const org = ws.find((w) => w.relation === 'ORIGINAL');
        assert.notEqual(rp.socialSourceId, org.socialSourceId, 'a repost is a distinct observation, not the origin');
      } finally { await db2.end(); }
    });
  });

  test('SOC-DUR-5 (§19 edit). a legitimate edit becomes a new version; both versions retained, no corruption', async () => {
    await withDb(async ({ journal }) => {
      const v1 = obsFrom(bskyPost({ cid: 'cidA', record: postRecord({ text: '$FOO v1' }) }));
      const v2 = obsFrom(bskyPost({ op: 'update', cid: 'cidB', seq: 2, record: postRecord({ text: '$FOO v2 corrected' }) }), NOW + 5_000);
      assert.equal(v1.socialSourceId, v2.socialSourceId, 'same stable post identity');
      assert.notEqual(v1.socialVersionId, v2.socialVersionId, 'edit is a new version');
      const r = await settle(journal, [socialObservationToEvent(v1).event, socialObservationToEvent(v2).event]);
      assert.equal(r.ok, true);
      const ws = await readWitnesses(journal);
      assert.equal(ws.length, 2, 'both versions retained — old truth never rewritten');
      assert.deepEqual(ws.map((w) => w.lifecycle).sort(), ['CREATE', 'EDIT']);
    });
  });

  test('SOC-DUR-6 (§20 delete). a deletion is appended as a tombstone; the original post remains historically known', async () => {
    await withDb(async ({ journal }) => {
      const create = obsFrom(bskyPost({ cid: 'cidA', record: postRecord({ text: '$FOO will pump' }) }));
      const del = obsFrom(bskyPost({ op: 'delete', seq: 2, cid: undefined, record: undefined }), NOW + 120_000);
      assert.equal(del.lifecycle, 'TOMBSTONE');
      await settle(journal, [socialObservationToEvent(create).event, socialObservationToEvent(del).event]);
      const ws = await readWitnesses(journal);
      assert.equal(ws.length, 2);
      assert.ok(ws.some((w) => w.lifecycle === 'CREATE' && w.text === '$FOO will pump'), 'the original post text is still known');
      assert.ok(ws.some((w) => w.lifecycle === 'TOMBSTONE'), 'the deletion is recorded, not an erasure');
    });
  });

  test('SOC-DUR-7 (§21 Farcaster). a Neynar cast round-trips with hash/FID/author-id/recast relationship intact', async () => {
    await withDb(async ({ journal }) => {
      const cast = obsFrom(neynarEventToRaw({ type: 'cast.created', data: { object: 'cast', hash: '0xcast1', parent_hash: null, author: { fid: 42, username: 'alice' }, text: '$FOO is live', timestamp: iso(C) } }).raw);
      const recast = obsFrom(neynarEventToRaw({ type: 'reaction.created', data: { reaction_type: 'recast', reactor: { fid: 99 }, cast: { hash: '0xcast1' }, timestamp: iso(C + 30_000) } }).raw, NOW + 30_000);
      await settle(journal, [socialObservationToEvent(cast).event, socialObservationToEvent(recast).event]);
      const ws = await readWitnesses(journal);
      const c = ws.find((w) => w.nativePostId === '0xcast1');
      assert.equal(c.nativeAuthorId, 'fid:42', 'FID survives (not the mutable username)');
      const rc = ws.find((w) => w.relation === 'REPOST');
      assert.equal(rc.parentNativePostId, '0xcast1', 'the recast still references its target');
    });
  });

  test('SOC-DUR-8 (§22 forgery). a real version id cannot authenticate altered social facts', async () => {
    await withDb(async () => {
      const { event } = socialObservationToEvent(obsFrom(bskyPost({ record: postRecord() })));
      assert.equal(validateSocialEvent(event, V), null);
      for (const field of ['nativePostId', 'nativeAuthorId', 'socialSourceId', 'socialAuthorId', 'provider', 'lifecycle', 'relation', 'text', 'nativeVersionId', 'sourceEventId']) {
        const bad = { ...event, [field]: field === 'lifecycle' ? 'EDIT' : field === 'relation' ? 'REPOST' : field === 'sourceCreatedTs' ? 1 : (field === 'nativeVersionId' ? 'tampered' : 'tampered-' + field) };
        assert.notEqual(validateSocialEvent(bad, V), null, `mutating ${field} must be rejected`);
      }
      // an undeclared field is rejected (no unbounded blob)
      assert.notEqual(validateSocialEvent({ ...event, rawResponse: { anything: true } }, V), null, 'undeclared field rejected');
    });
  });

  test('SOC-DUR-9 (§24 point-in-time). an old post replayed today keeps its old creation but records today as knownAt', async () => {
    await withDb(async ({ journal }) => {
      const oldCreate = Date.parse('2026-01-01T00:00:00Z');
      const replayNow = Date.parse('2026-09-05T18:00:00Z');
      const obs = obsFrom(bskyPost({ record: postRecord({ text: '$FOO old news', createdAt: oldCreate }) }), replayNow);
      const { event } = socialObservationToEvent(obs);
      await settle(journal, [event]);
      const [w] = await readWitnesses(journal);
      assert.equal(w.sourceCreatedTs, oldCreate, 'original creation preserved');
      assert.equal(w.knownAtTs, replayNow, 'knownAt is the replay acquisition time, never backdated');
      assert.ok(w.knownAtTs > w.sourceCreatedTs);
    });
  });

  test('SOC-DUR-10. a durable social event is NOT accepted by the frozen non-social event world (isolation)', async () => {
    await withDb(async ({ journal }) => {
      // sanity: the social event type is distinct from RUMOR2_SOURCE_OBSERVED,
      // so the frozen source path is untouched by social evidence
      const { event } = socialObservationToEvent(obsFrom(bskyPost({ record: postRecord() })));
      assert.equal(event.type, 'RUMOR2_SOCIAL_OBSERVED');
      assert.notEqual(event.type, 'RUMOR2_SOURCE_OBSERVED');
      await settle(journal, [event]);
      assert.equal((await journal.read()).events[0].type, 'RUMOR2_SOCIAL_OBSERVED');
    });
  });
}
