// SOURCE-CLOCK QUARANTINE SEAL — three explicitly distinct clocks (source-
// declared / provider event / Serpent knowledge), the closed clock verdict, the
// bounded skew diagnostic, and the permanent knowledge law: a client clock that
// runs ahead never discards valid social evidence and never makes Serpent
// believe it knew something earlier than it did. Pure + real PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSocialObservation, classifySourceClock, SOURCE_CLOCK_STATES, MAX_SOURCE_CLOCK_SKEW_MS, socialProvenanceFacts, socialDiagnosticFacts, buildSocialFilter } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, SOCIAL_EVENT_KEYS, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { createSocialRuntime } from '../rumor2/social-runtime.js';
import { jetstreamCommitToRaw, jetstreamCursorOf, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { classifyOfficialItem } from '../rumor2/truth.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-socclk-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const T = Date.parse('2026-09-05T12:00:00Z');
const iso = (m) => new Date(m).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
// an otherwise-valid current v2 CREATE frame; createdAt is the CLIENT clock, time is the provider clock
const frame = (createdAt, { seq = 100, time = iso(T - 1_000), op = 'create', rkey = 'k' } = {}) => ({
  $type: 'message', payload: { $type: 'network.bsky.jetstream.subscribeEvents#commit', seq, did: 'did:plc:a', time, rev: 'r', operation: op, collection: 'app.bsky.feed.post', rkey, cid: op === 'delete' ? undefined : 'cidA', record: op === 'delete' ? undefined : { $type: 'app.bsky.feed.post', createdAt, text: '$BTC listing rumor' } },
});
const norm = (createdMs, nowMs = T, over = {}) => normalizeSocialObservation(jetstreamCommitToRaw(frame(typeof createdMs === 'number' ? iso(createdMs) : createdMs, over)).raw, { nowMs });

test('CLK-1 (§16). normal past clock: TRUSTED, sourceCreatedTs = declared, knownAt = retrieval', () => {
  const r = norm(T - 5_000);
  assert.equal(r.ok, true);
  const o = r.observation;
  assert.equal(o.sourceDeclaredTs, T - 5_000); assert.equal(o.sourceCreatedTs, T - 5_000);
  assert.equal(o.sourceClockStatus, 'TRUSTED'); assert.equal(o.sourceClockSkewMs, null);
  assert.equal(o.retrievedTs, T); assert.equal(o.knownAtTs, T);
});

test('CLK-2 (§17 / PASS 1). +28 ms: accepted, declared preserved, trusted null, FUTURE_QUARANTINED, skew 28, knownAt = T', () => {
  const r = norm(T + 28);
  assert.equal(r.reject, undefined, 'no rejection');
  const o = r.observation;
  assert.equal(o.sourceDeclaredTs, T + 28); assert.equal(o.sourceCreatedTs, null);
  assert.equal(o.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(o.sourceClockSkewMs, 28);
  assert.equal(o.knownAtTs, T, 'knownAt never backdated (and never advanced) by the client clock');
  assert.equal(o.text, '$BTC listing rumor'); assert.equal(o.nativeAuthorId, 'did:plc:a');
});

test('CLK-3 (§18 / PASS 2). +87 s: accepted, clock quarantined, text/author/provenance retained', () => {
  const o = norm(T + 87_000).observation;
  assert.equal(o.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(o.sourceCreatedTs, null); assert.equal(o.sourceClockSkewMs, 87_000);
  assert.equal(o.sourceDeclaredTs, T + 87_000); assert.equal(o.relation, 'ORIGINAL'); assert.equal(o.providerEventSeq, 100);
  const { event } = socialObservationToEvent(o);
  assert.equal(validateSocialEvent(event, V), null, 'a quarantined observation is a valid durable social event');
});

test('CLK-4 (§19 / PASS 3). +1 day: evidence retained, bounded skew, no temporal authority; an absurd clock cannot overflow', () => {
  const o = norm(T + 86_400_000).observation;
  assert.equal(o.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(o.sourceCreatedTs, null); assert.equal(o.sourceClockSkewMs, 86_400_000);
  assert.ok(Number.isSafeInteger(o.sourceClockSkewMs));
  // the far edge of Date: still a bounded safe integer, still quarantined, still accepted
  const far = norm('+275760-09-13T00:00:00.000Z');
  assert.equal(far.ok, true); assert.equal(far.observation.sourceClockStatus, 'FUTURE_QUARANTINED');
  assert.equal(far.observation.sourceClockSkewMs, MAX_SOURCE_CLOCK_SKEW_MS, 'clamped to the bound');
  assert.ok(Number.isSafeInteger(far.observation.sourceDeclaredTs));
  assert.equal(validateSocialEvent(socialObservationToEvent(far.observation).event, V), null);
});

test('CLK-5 (§20). malformed record.createdAt: sourceDeclaredTs = null / UNKNOWN, evidence kept, never Date.now', () => {
  const before = Date.now();
  const r = norm('not-a-timestamp');
  assert.equal(r.ok, true, 'structurally valid evidence with a broken client timestamp is retained');
  const o = r.observation;
  assert.equal(o.sourceDeclaredTs, null); assert.equal(o.sourceCreatedTs, null); assert.equal(o.sourceClockStatus, 'UNKNOWN'); assert.equal(o.sourceClockSkewMs, null);
  assert.ok(o.sourceDeclaredTs === null && !(o.sourceDeclaredTs >= before), 'no wall-clock fabrication');
  // a non-number in the shared raw contract is still a contract violation (adapters map malformed -> null)
  assert.equal(normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://x/p/1', nativeAuthorId: 'did:x', text: 't', sourceDeclaredTs: 'x' }, { nowMs: T }).reject, true);
});

test('CLK-6 (§21 / PASS 5). Jetstream payload.time is providerEventTs — distinct from record.createdAt and never copied into sourceCreatedTs or knownAt', () => {
  const o = norm(T - 5_000, T, { time: iso(T - 1_000) }).observation;
  assert.equal(o.providerEventTs, T - 1_000); assert.equal(o.sourceDeclaredTs, T - 5_000);
  assert.notEqual(o.providerEventTs, o.sourceDeclaredTs); assert.notEqual(o.providerEventTs, o.knownAtTs);
  assert.equal(o.sourceCreatedTs, o.sourceDeclaredTs, 'trusted source time comes from the declared clock, not the provider clock');
  const q = norm(T + 5_000, T, { time: iso(T - 1_000) }).observation;
  assert.equal(q.sourceCreatedTs, null, 'a quarantined source clock is not replaced by the provider clock either');
  assert.equal(q.providerEventTs, T - 1_000);
  const noTime = normalizeSocialObservation(jetstreamCommitToRaw({ ...frame(iso(T - 1)), payload: { ...frame(iso(T - 1)).payload, time: 'garbage' } }).raw, { nowMs: T }).observation;
  assert.equal(noTime.providerEventTs, null, 'an unparseable provider clock is null, never fabricated');
});

test('CLK-7 (§22 / PASS 8). delete/tombstone: no declared/trusted source time, UNKNOWN, provider event clock + seq preserved', () => {
  const o = norm(null, T + 10, { op: 'delete', seq: 110, time: iso(T + 5) }).observation;
  assert.equal(o.lifecycle, 'TOMBSTONE');
  assert.equal(o.sourceDeclaredTs, null); assert.equal(o.sourceCreatedTs, null); assert.equal(o.sourceClockStatus, 'UNKNOWN');
  assert.equal(o.providerEventTs, T + 5); assert.equal(o.providerEventSeq, 110);
  assert.equal(o.retrievedTs, T + 10); assert.equal(o.knownAtTs, T + 10);
  assert.equal(validateSocialEvent(socialObservationToEvent(o).event, V), null);
});

test('CLK-8 (§8/§9). the closed verdict + one skew definition; the validator re-derives both and rejects forged clock truth', () => {
  assert.deepEqual([...SOURCE_CLOCK_STATES], ['TRUSTED', 'FUTURE_QUARANTINED', 'UNKNOWN']);
  assert.deepEqual(classifySourceClock({ sourceDeclaredTs: 10, retrievedTs: 10 }), { sourceCreatedTs: 10, sourceClockStatus: 'TRUSTED', sourceClockSkewMs: null }, 'equal is trusted');
  assert.deepEqual(classifySourceClock({ sourceDeclaredTs: 11, retrievedTs: 10 }), { sourceCreatedTs: null, sourceClockStatus: 'FUTURE_QUARANTINED', sourceClockSkewMs: 1 });
  assert.deepEqual(classifySourceClock({ sourceDeclaredTs: null, retrievedTs: 10 }), { sourceCreatedTs: null, sourceClockStatus: 'UNKNOWN', sourceClockSkewMs: null });
  for (const k of ['sourceDeclaredTs', 'sourceCreatedTs', 'sourceClockStatus', 'sourceClockSkewMs', 'providerEventTs']) assert.ok(SOCIAL_EVENT_KEYS.includes(k), `${k} declared`);
  const { event } = socialObservationToEvent(norm(T + 5_000).observation);
  assert.equal(validateSocialEvent(event, V), null);
  assert.notEqual(validateSocialEvent({ ...event, sourceClockStatus: 'TRUSTED' }, V), null, 'a forged TRUSTED over a future clock is rejected');
  assert.notEqual(validateSocialEvent({ ...event, sourceCreatedTs: event.sourceDeclaredTs }, V), null, 'a fabricated trusted source time is rejected');
  assert.notEqual(validateSocialEvent({ ...event, sourceClockSkewMs: 1 }, V), null, 'a rewritten skew is rejected');
  assert.notEqual(validateSocialEvent({ ...event, sourceClockStatus: 'BOGUS' }, V), null);
  assert.notEqual(validateSocialEvent({ ...event, providerEventTs: 'x' }, V), null);
  const trusted = socialObservationToEvent(norm(T - 5_000).observation).event;
  assert.notEqual(validateSocialEvent({ ...trusted, sourceCreatedTs: null, sourceClockStatus: 'UNKNOWN' }, V), null, 'a trusted clock cannot be laundered into UNKNOWN');
  assert.notEqual(validateSocialEvent({ ...trusted, sourceDeclaredTs: T - 6_000, sourceCreatedTs: T - 6_000 }, V), null, 'the declared clock is bound by the content identity');
  assert.notEqual(validateSocialEvent({ ...trusted, providerEventTs: T - 2 }, V), null, 'providerEventTs is bound first-known by the diagnostic hash');
});

test('CLK-9 (§13/§15). the declared clock is content identity; the verdict/skew/providerEventTs are first-known diagnostics — a later acquisition never forks a version', () => {
  const early = norm(T + 30_000, T).observation; // quarantined at first acquisition
  const later = norm(T + 30_000, T + 60_000).observation; // redelivered after wall time caught up: TRUSTED now
  assert.equal(early.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(later.sourceClockStatus, 'TRUSTED');
  assert.equal(early.socialVersionId, later.socialVersionId, 'same immutable record => same content version, whatever the acquisition clock said');
  assert.notEqual(early.metaHash, later.metaHash, 'the first-known diagnostic snapshot differs (bound, never silently rewritten)');
  assert.equal(socialProvenanceFacts(early).sourceDeclaredTs, T + 30_000); assert.equal('sourceCreatedTs' in socialProvenanceFacts(early), false);
  assert.equal(socialDiagnosticFacts(early).sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(socialDiagnosticFacts(early).sourceClockSkewMs, 30_000);
  const other = norm(T + 31_000, T).observation; // a DIFFERENT declared createdAt on the same CID = incompatible record content
  assert.notEqual(other.socialVersionId, early.socialVersionId, 'a different declared clock is a different immutable record');
});

test('CLK-10 (§24 / PASS 4). live-sample regression: +28ms, +1s, +5s, +30s, +87s — none lost, all quarantined, knownAt untouched', () => {
  const intake = socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, cursorOf: jetstreamCursorOf, filter: buildSocialFilter({ terms: ['BTC'] }), now: () => T });
  const offs = [28, 1_000, 5_000, 30_000, 87_000];
  offs.forEach((off, i) => {
    const r = intake.offer(frame(iso(T + off), { seq: 200 + i, rkey: `r${i}` }));
    assert.equal(r.outcome, 'enqueued', `+${off}ms retained`);
    assert.equal(r.observation.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(r.observation.sourceCreatedTs, null);
    assert.equal(r.observation.sourceClockSkewMs, off); assert.equal(r.observation.knownAtTs, T);
  });
  assert.equal(intake.offer(frame(iso(T - 10), { seq: 300, rkey: 'past' })).observation.sourceClockStatus, 'TRUSTED');
  const st = intake.stats();
  assert.equal(st.rejected, 0, 'zero future-clock rejections');
  assert.equal(st.sourceClockFutureQuarantined, 5); assert.equal(st.sourceClockTrusted, 1); assert.equal(st.sourceClockUnknown, 0);
});

test('CLK-11 (§25/§27 / PASS 9). counters are observability only; clock fields carry no claim/trade authority; a bad clock rejects nothing', () => {
  const { event } = socialObservationToEvent(norm(T + 86_400_000).observation);
  for (const k of ['propositionId', 'claimType', 'packet', 'order', 'eligibility', 'size', 'hyped', 'score', 'attention', 'reject', 'decision'])
    assert.ok(!(k in event), `no ${k}`);
  assert.equal(classifyOfficialItem({ providerKind: 'SOCIAL_MICROBLOG', title: event.text, summary: '' }), null);
  const w = reconstructSocialWitness(event);
  assert.equal(w.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(w.sourceDeclaredTs, T + 86_400_000); assert.equal(w.providerEventTs, T - 1_000);
  assert.ok(!('authority' in w) && !('rejectAsset' in w));
});

// ---- §23 first-known durability (real PostgreSQL) ----
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOURCE-CLOCK durability', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  test('CLK-PG-1 (§23 / PASS 6 / PASS 7). first-known FUTURE_QUARANTINED survives restart; redelivery after wall time caught up cannot rewrite it; no corruption', async () => {
    const SCHEMA = `socclk_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try {
      assert.equal(await db.connect(), true); await runMigrations(db);
      const repo = new Repository(db); const persistence = () => ({ repo, health: () => ({ databaseConfigured: true, restored: true }) });
      const mkJournal = () => rumor2JournalStore({ persistence });
      const boot = (nowMs, fixtures) => createSocialRuntime({ filter: buildSocialFilter({ terms: ['BTC'] }), now: () => nowMs, mode: 'REPLAY', fixtures, buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, cursorOnlyIntervalMs: 0 });
      const settle = (rt, j) => rt.settle({ append: (e) => j.append(e), lookup: (t, ids) => j.hasEventIds(t, ids) });
      // process A at T receives createdAt = T + 30s
      const jA = mkJournal(); assert.equal((await jA.acquireWriter()).ok, true);
      const A = boot(T, [frame(iso(T + 30_000))]); A.hydrate([]); A.start();
      assert.equal(A._intake().stats().sourceClockFutureQuarantined, 1);
      const r = await settle(A, jA); assert.equal(r.ok, true); assert.equal(r.appended, 1);
      A.stop(); await jA.releaseWriter();
      // restart later — the client's createdAt is no longer in the future
      const jB = mkJournal(); assert.equal((await jB.acquireWriter()).ok, true);
      const B = boot(T + 120_000, [frame(iso(T + 30_000))]);
      const h = B.hydrate((await jB.read()).events); assert.equal(h.ok, true); assert.equal(h.durableIds, 1);
      B.start();
      assert.equal(B._intake().stats().durableDeduped, 1, 'same immutable version recognized as durable');
      const r2 = await settle(B, jB); assert.equal(r2.ok, true); assert.equal(r2.appended, 0, 'no altered payload, no corruption');
      const soc = (await jB.read()).events.filter((e) => e.type === SOCIAL_EVENT_TYPE);
      assert.equal(soc.length, 1, 'ONE durable social event');
      const w = reconstructSocialWitness(soc[0]);
      assert.equal(w.sourceClockStatus, 'FUTURE_QUARANTINED', 'first-known verdict stands');
      assert.equal(w.sourceClockSkewMs, 30_000, 'first-known skew stands'); assert.equal(w.sourceCreatedTs, null); assert.equal(w.sourceDeclaredTs, T + 30_000);
      assert.equal(w.knownAtTs, T, 'historical truth is what Serpent knew at first acquisition');
      assert.equal(validateSocialEvent(soc[0], V), null);
      B.stop(); await jB.releaseWriter();
    } finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  });
}
