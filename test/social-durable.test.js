// SOCIAL-1 — durable social evidence through the FROZEN event root (real
// PostgreSQL). Proves social observations settle as RUMOR2_SOURCE_OBSERVED
// events in the SAME journal, under the SAME advisory-lock writer + database
// writer epoch (§34/§35), with no parallel store and no social checkpoint:
//   - a social evidence event appends only under a held writer epoch;
//   - a stale/absent epoch is refused at the mutation boundary (§35);
//   - an exact re-append collapses (dedupe / crash-safe restart, §51 PASS-10);
//   - the settled event re-derives its own frozen source identity (§36).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialObservationToSourceEvent } from '../rumor2/social-settle.js';
import { jetstreamCommitToRaw } from '../rumor2/providers/bluesky-official.js';
import { sourceObservationIdentity } from '../rumor2/truth.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-social-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-05T12:00:10Z');
const CREATED = Date.parse('2026-09-05T12:00:00Z');
const mkObs = (over = {}) => normalizeSocialObservation({
  provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG',
  nativePostId: over.nativePostId ?? 'at://did:plc:alice/app.bsky.feed.post/r1',
  nativeAuthorId: over.nativeAuthorId ?? 'did:plc:alice',
  text: over.text ?? '$FOO is listing today', relation: over.relation ?? 'ORIGINAL',
  parentNativePostId: over.parentNativePostId ?? null,
  canonicalUrl: 'https://bsky.app/profile/did:plc:alice/post/r1',
  sourceCreatedTs: over.sourceCreatedTs ?? CREATED,
}, { nowMs: over.nowMs ?? NOW }).observation;

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL durable integration', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');

  const withDb = async (fn) => {
    const SCHEMA = `soc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true);
      const m = await runMigrations(db);
      assert.equal(m.schemaVersion, 7, 'social evidence rides the existing frozen event-root schema — no new migration');
      const repo = new Repository(db);
      const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      await fn({ db, repo, journal: rumor2JournalStore({ persistence }) });
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await db.end();
    }
  };

  test('SOC-DUR-1 (§34/§36). a social observation settles as a RUMOR2_SOURCE_OBSERVED event that re-derives its own identity', async () => {
    await withDb(async ({ journal }) => {
      const w = await journal.acquireWriter();
      assert.equal(w.ok, true);
      const { event, sourceEventId } = socialObservationToSourceEvent(mkObs());
      assert.equal(event.type, 'RUMOR2_SOURCE_OBSERVED');
      // the settled event's identity is the frozen semantic hash of its facts
      assert.equal(sourceObservationIdentity({ provider: event.provider, guid: event.guid, link: event.link, publishedTs: event.publishedTs, title: event.title, summary: event.summary }), sourceEventId);
      const r = await journal.append([event]);
      assert.equal(r.ok, true);
      const back = await journal.read();
      assert.equal(back.events.length, 1);
      assert.equal(back.events[0].sourceEventId, sourceEventId, 'the durable event round-trips through the same journal');
      assert.equal(back.events[0].provider, 'BLUESKY_OFFICIAL');
      await journal.releaseWriter();
    });
  });

  test('SOC-DUR-2 (§35). no social write without a held writer epoch — the fence applies to social evidence', async () => {
    await withDb(async ({ journal }) => {
      const { event } = socialObservationToSourceEvent(mkObs());
      // no acquisition => no writer fence => refused
      const refused = await journal.append([event]);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'WRITER_FENCE_LOST', 'a social append with no writer epoch is refused (no bypass)');
      // acquire, append succeeds, then release => the fence is gone again
      const w = await journal.acquireWriter();
      assert.equal(w.ok, true);
      assert.equal((await journal.append([event])).ok, true);
      await journal.releaseWriter();
      assert.equal((await journal.append([event])).ok, false, 'after release the social writer cannot append');
    });
  });

  test('SOC-DUR-3 (§51 PASS-10). an exact re-append of the same social event collapses — restart never double-applies', async () => {
    await withDb(async ({ journal }) => {
      await journal.acquireWriter();
      const { event } = socialObservationToSourceEvent(mkObs());
      assert.equal((await journal.append([event])).ok, true);
      assert.equal((await journal.append([event])).ok, true, 'exact re-append is accepted (idempotent)');
      const back = await journal.read();
      assert.equal(back.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED').length, 1, 'the crash re-append collapsed to ONE durable truth');
      await journal.releaseWriter();
    });
  });

  test('SOC-DUR-4 (§34). a full Jetstream commit flows end-to-end into the durable event root', async () => {
    await withDb(async ({ journal }) => {
      await journal.acquireWriter();
      const msg = { $type: 'message', payload: { $type: 'x#commit', did: 'did:plc:zed', seq: 5, time: new Date(CREATED).toISOString(), operation: 'create', collection: 'app.bsky.feed.post', rkey: 'k1', cid: 'c', record: { $type: 'app.bsky.feed.post', text: '$FOO exchange listing rumor', createdAt: new Date(CREATED).toISOString() } } };
      const mapped = jetstreamCommitToRaw(msg);
      const obs = normalizeSocialObservation(mapped.raw, { nowMs: NOW }).observation;
      const { event } = socialObservationToSourceEvent(obs);
      assert.equal((await journal.append([event])).ok, true);
      const back = await journal.read();
      assert.equal(back.events[0].guid, 'at://did:plc:zed/app.bsky.feed.post/k1', 'the native at:// id is the durable guid');
      assert.equal(back.events[0].knownAtTs, NOW, 'knownAt is retrieval time, never the post creation');
      await journal.releaseWriter();
    });
  });
}
