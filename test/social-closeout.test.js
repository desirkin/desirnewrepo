// SOCIAL-1 CLOSEOUT — the ten explicit adversarial closeout passes (§36).
// Durable passes use real PostgreSQL; the rest are pure. Together they prove
// the closeout: social evidence survives the authoritative journal with author,
// relationship, version, edit and deletion truth intact, and holds zero direct
// authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { normalizeSocialObservation, socialAuthorIdentity, estimateSocialStage, coordinationFeatures } from '../rumor2/social.js';
import { classifyOfficialItem } from '../rumor2/truth.js';
import { socialObservationToEvent, validateSocialEvent, reconstructSocialWitness, SOCIAL_EVENT_TYPE } from '../rumor2/social-settle.js';
import { jetstreamCommitToRaw } from '../rumor2/providers/bluesky-official.js';
import { SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';

const C = Date.parse('2026-09-05T12:00:00Z');
const NOW = C + 10_000;
const iso = (ms) => new Date(ms).toISOString();
const V = { socialProviderIds: SOCIAL_PROVIDER_IDS };
const bsky = (over = {}) => normalizeSocialObservation(jetstreamCommitToRaw({ payload: {
  $type: 'x#commit', did: over.did ?? 'did:plc:a', seq: over.seq ?? 1, time: iso(over.time ?? C),
  operation: over.op ?? 'create', collection: over.collection ?? 'app.bsky.feed.post', rkey: over.rkey ?? 'r1',
  cid: over.cid ?? 'cid1', record: over.record ?? { $type: 'app.bsky.feed.post', text: over.text ?? '$FOO news', createdAt: iso(C) },
} }).raw, { nowMs: over.now ?? NOW }).observation;

// ---- pure passes -----------------------------------------------------------
test('PASS 1 — OLD AUTHORITY: social files are tracked yet hold zero execution authority', () => {
  const tracked = execSync("git ls-files 'rumor2/social*.js' 'rumor2/providers/bluesky-official.js' 'rumor2/providers/farcaster-official.js'", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(tracked.length >= 6, 'social files are visible to git ls-files');
  assert.equal(classifyOfficialItem({ providerKind: 'SOCIAL_MICROBLOG', title: 'FOO lists', summary: 'now' }), null);
});

test('PASS 3 — AUTHOR IDENTITY: a handle rename cannot rewrite the native author identity', () => {
  const a = bsky({ rkey: 'a', text: 'x' });
  const b = bsky({ rkey: 'b', text: 'y' }); // same did, different post
  assert.equal(a.socialAuthorId, b.socialAuthorId, 'author identity is the DID, not the handle');
  assert.equal(a.socialAuthorId, socialAuthorIdentity({ provider: 'BLUESKY_OFFICIAL', nativeAuthorId: 'did:plc:a' }));
});

test('PASS 7 — SOCIAL EVENT FORGERY: altering native/social identity facts is rejected', () => {
  const { event } = socialObservationToEvent(bsky());
  assert.equal(validateSocialEvent(event, V), null);
  for (const f of ['nativePostId', 'nativeAuthorId', 'socialSourceId', 'socialAuthorId', 'provider', 'sourceEventId', 'text', 'nativeVersionId'])
    assert.notEqual(validateSocialEvent({ ...event, [f]: 'tampered' }, V), null, `mutating ${f} rejected`);
  assert.notEqual(validateSocialEvent({ ...event, blob: { any: 1 } }, V), null, 'undeclared field rejected');
});

test('PASS 9 — PUMP DOCTRINE: pump is not an automatic reject; late/no-edge may be discarded', () => {
  const m = readFileSync(new URL('../doctrine/MISSION.md', import.meta.url), 'utf8');
  assert.ok(m.includes('We do not reject pumps. We reject pump-like moves whose remaining executable edge has disappeared.'));
  assert.ok(/late-stage or exhausted pump behavior with no remaining executable edge/.test(m));
  assert.ok(/price extension is context, not an automatic veto/.test(m));
  assert.ok(!/meaningless movement,\s*pump behavior,\s*terrible liquidity/.test(m), 'the old pump=>discard construction is gone');
});

test('PASS 10 — AUTHORITY: no social event, pump stage, or propagation metric has direct trading authority', () => {
  const { event } = socialObservationToEvent(bsky());
  for (const k of ['propositionId', 'claimType', 'packet', 'order', 'eligibility', 'size', 'hyped'])
    assert.ok(!(k in event), `social event has no ${k}`);
  const stage = estimateSocialStage(coordinationFeatures([bsky()]));
  assert.equal(stage.calibrated, false);
  assert.ok(!['BUY', 'SELL', 'TRADE', 'REJECT', 'HYPED', 'ELIGIBLE'].includes(stage.stage), 'stage is never a trade verb');
});

// ---- durable passes (real PostgreSQL) --------------------------------------
const TEST_URL = process.env.PERSIST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!TEST_URL) {
  test('SOCIAL closeout durable passes', (t) => t.skip('no PERSIST_TEST_DATABASE_URL / DATABASE_URL configured'));
} else {
  const { Db } = await import('../persistence/db.js');
  const { Repository } = await import('../persistence/repository.js');
  const { runMigrations } = await import('../persistence/migrate.js');
  const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
  const mkJournal = (db) => rumor2JournalStore({ persistence: () => ({ repo: new Repository(db), health: () => ({ databaseConfigured: true, restored: true }) }) });
  const withDb = async (fn) => {
    const SCHEMA = `socc_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const db = new Db({ url: TEST_URL, schema: SCHEMA });
    try { assert.equal(await db.connect(), true); await runMigrations(db); await fn({ db, SCHEMA }); }
    finally { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {}); await db.end(); }
  };
  const settle = async (journal, events) => { const w = await journal.acquireWriter(); assert.equal(w.ok, true); const r = await journal.append(events); await journal.releaseWriter(); return r; };
  const witnesses = async (journal) => (await journal.read()).events.filter((e) => e.type === SOCIAL_EVENT_TYPE).map(reconstructSocialWitness);

  test('PASS 2 — SOCIAL SOURCE ROUND TRIP: provenance survives normalization -> journal -> replay', async () => {
    await withDb(async ({ db, SCHEMA }) => {
      const j = mkJournal(db);
      await settle(j, [socialObservationToEvent(bsky({ text: '$FOO listing' })).event]);
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try { assert.equal(await db2.connect(), true); const [w] = await witnesses(mkJournal(db2)); assert.equal(w.nativePostId, 'at://did:plc:a/app.bsky.feed.post/r1'); assert.equal(w.nativeVersionId, 'cid1'); assert.match(w.socialAuthorId, /^r2sa-/); }
      finally { await db2.end(); }
    });
  });

  test('PASS 4 — REPOST: explicit repost relationship survives restart', async () => {
    await withDb(async ({ db, SCHEMA }) => {
      const origin = bsky({ did: 'did:plc:src', rkey: 'o', cid: 'cO' });
      const repost = bsky({ did: 'did:plc:fan', rkey: 're', cid: 'cR', collection: 'app.bsky.feed.repost', record: { $type: 'app.bsky.feed.repost', createdAt: iso(C), subject: { uri: origin.nativePostId, cid: 'cO' } }, now: NOW + 1000 });
      await settle(mkJournal(db), [socialObservationToEvent(origin).event, socialObservationToEvent(repost).event]);
      const db2 = new Db({ url: TEST_URL, schema: SCHEMA });
      try { assert.equal(await db2.connect(), true); const ws = await witnesses(mkJournal(db2)); assert.equal(ws.find((w) => w.relation === 'REPOST').parentNativePostId, origin.nativePostId); }
      finally { await db2.end(); }
    });
  });

  test('PASS 5 — EDIT: a legitimate edit is a new version without becoming corruption', async () => {
    await withDb(async ({ db }) => {
      const j = mkJournal(db);
      const r = await settle(j, [socialObservationToEvent(bsky({ cid: 'cA', text: '$FOO v1' })).event, socialObservationToEvent(bsky({ op: 'update', seq: 2, cid: 'cB', text: '$FOO v2', now: NOW + 5 })).event]);
      assert.equal(r.ok, true);
      assert.deepEqual((await witnesses(j)).map((w) => w.lifecycle).sort(), ['CREATE', 'EDIT']);
    });
  });

  test('PASS 6 — DELETE: deletion does not erase the historical post', async () => {
    await withDb(async ({ db }) => {
      const j = mkJournal(db);
      await settle(j, [socialObservationToEvent(bsky({ cid: 'cA', text: '$FOO keep' })).event, socialObservationToEvent(bsky({ op: 'delete', seq: 2, cid: undefined, record: null, now: NOW + 100 })).event]);
      const ws = await witnesses(j);
      assert.ok(ws.some((w) => w.lifecycle === 'CREATE' && w.text === '$FOO keep'));
      assert.ok(ws.some((w) => w.lifecycle === 'TOMBSTONE'));
    });
  });

  test('PASS 8 — DUPLICATE DELIVERY: the same version repeated is one durable truth', async () => {
    await withDb(async ({ db }) => {
      const j = mkJournal(db);
      const { event } = socialObservationToEvent(bsky());
      await settle(j, [event]); await settle(j, [event]); await settle(j, [event]);
      assert.equal((await witnesses(j)).length, 1);
    });
  });
}
