// SOCIAL-2B Job A — FIRST-KNOWN ACQUISITION CLOCK LAW. retrievedTs/knownAtTs are
// Serpent's first-known acquisition truth: never provider content identity (a
// later redelivery of the same immutable version derives the SAME
// socialVersionId and is absorbed keep-first), but once durable they are bound
// by the first-known diagnostic integrity hash so they can never be silently
// rewritten. Pure + real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSocialObservation, socialProvenanceFacts, socialDiagnosticFacts, buildSocialFilter } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-socpit-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const T = Date.parse('2026-09-05T12:00:00Z');
const iso = (m) => new Date(m).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
const frame = (seq = 100) => ({ $type: 'message', payload: { $type: 'network.bsky.jetstream.subscribeEvents#commit', seq, did: 'did:plc:a', time: iso(T - 1_000), rev: 'r', operation: 'create', collection: 'app.bsky.feed.post', rkey: 'k', cid: 'cidA', record: { $type: 'app.bsky.feed.post', createdAt: iso(T - 5_000), text: '$BTC listing rumor' } } });
const eventAt = (nowMs) => socialObservationToEvent(normalizeSocialObservation(jetstreamCommitToRaw(frame()).raw, { nowMs }).observation).event;

test('PIT-1 (PASS 1). rewriting retrievedTs + knownAtTs + ts on a stored event (same sourceEventId, same metaHash) is REJECTED', () => {
  const E = eventAt(T);
  assert.equal(validateSocialEvent(E, V), null);
  const E2 = { ...E, retrievedTs: T + 10_000, knownAtTs: T + 10_000, ts: iso(T + 10_000) };
  assert.equal(E2.sourceEventId, E.sourceEventId); assert.equal(E2.metaHash, E.metaHash);
  assert.notEqual(validateSocialEvent(E2, V), null, 'the first-known acquisition clock is diagnostic-bound');
  assert.match(validateSocialEvent(E2, V), /metaHash/);
});

test('PIT-2. rewriting knownAtTs + ts only is REJECTED; rewriting retrievedTs only is REJECTED', () => {
  const E = eventAt(T);
  assert.notEqual(validateSocialEvent({ ...E, knownAtTs: T + 10_000, ts: iso(T + 10_000) }, V), null);
  assert.notEqual(validateSocialEvent({ ...E, retrievedTs: T - 1 }, V), null);
  assert.equal(socialDiagnosticFacts(E).retrievedTs, T); assert.equal(socialDiagnosticFacts(E).knownAtTs, T);
  assert.ok(!('retrievedTs' in socialProvenanceFacts(E)) && !('knownAtTs' in socialProvenanceFacts(E)), 'acquisition clocks are NOT content identity');
});

test('PIT-3 (PASS 2). the same immutable version redelivered later: same socialVersionId, different candidate meta snapshot, durable keep-first, no altered append', () => {
  const durable = new Set();
  const intake = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: buildSocialFilter({ terms: ['BTC'] }), now: () => T, isDurable: (id) => durable.has(id) });
  const first = intake.offer(frame());
  assert.equal(first.outcome, 'enqueued');
  durable.add(first.observation.socialVersionId); // settled durably at T
  const later = normalizeSocialObservation(jetstreamCommitToRaw(frame()).raw, { nowMs: T + 300_000 }).observation;
  assert.equal(later.socialVersionId, first.observation.socialVersionId, 'same content version');
  assert.notEqual(later.metaHash, first.observation.metaHash, 'different first-known meta snapshot (acquisition clock differs)');
  const intake2 = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: buildSocialFilter({ terms: ['BTC'] }), now: () => T + 300_000, isDurable: (id) => durable.has(id) });
  const r = intake2.offer(frame());
  assert.equal(r.outcome, 'deduped'); assert.equal(r.durable, true, 'durable keep-first recognizes the existing version — no altered payload reaches the journal');
  assert.equal(first.observation.retrievedTs, T); assert.equal(first.observation.knownAtTs, T);
});

test('PIT-5. sourceDeclaredTs / providerEventTs can NEVER reduce knownAtTs', () => {
  const o = normalizeSocialObservation({ ...jetstreamCommitToRaw(frame()).raw, sourceDeclaredTs: T - 3_600_000, providerEventTs: T - 3_600_000 }, { nowMs: T }).observation;
  assert.equal(o.knownAtTs, T); assert.equal(o.retrievedTs, T);
  const w = reconstructSocialWitness(socialObservationToEvent(o).event);
  assert.equal(w.knownAtTs, T); assert.ok(w.knownAtTs > w.sourceDeclaredTs && w.knownAtTs > w.providerEventTs);
});

const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('PIT-4 durability', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  test('PIT-4 (PASS 2). settle at T, restart, redeliver at T+5m: one durable event, first-known T remains', async () => {
    const SCHEMA = `socpit_${Date.now().toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); await runMigrations(db);
      const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const mkJournal = () => rumor2JournalStore({ persistence });
      const boot = (nowMs) => createSocialRuntime({ filter: buildSocialFilter({ terms: ['BTC'] }), now: () => nowMs, mode: 'REPLAY', fixtures: [frame()], buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, cursorOnlyIntervalMs: 0 });
      const settle = (rt, j) => rt.settle({ append: (e) => j.append(e), lookup: (t, ids) => j.hasEventIds(t, ids) });
      const jA = mkJournal(); assert.equal((await jA.acquireWriter()).ok, true);
      const A = boot(T); A.hydrate([]); A.start(); assert.equal((await settle(A, jA)).appended, 1); A.stop(); await jA.releaseWriter();
      const jB = mkJournal(); assert.equal((await jB.acquireWriter()).ok, true);
      const B = boot(T + 300_000); assert.equal(B.hydrate((await jB.read()).events).durableIds, 1); B.start();
      assert.equal(B._intake().stats().durableDeduped, 1);
      assert.equal((await settle(B, jB)).appended, 0, 'no altered payload, no corruption');
      const soc = (await jB.read()).events.filter((e) => e.type === SOCIAL_EVENT_TYPE);
      assert.equal(soc.length, 1);
      assert.equal(soc[0].retrievedTs, T); assert.equal(soc[0].knownAtTs, T); assert.equal(soc[0].ts, iso(T), 'the FIRST durable acquisition clock stands');
      assert.equal(validateSocialEvent(soc[0], V), null);
      B.stop(); await jB.releaseWriter();
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  });
}
