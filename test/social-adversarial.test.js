// SOCIAL-1 — the TWELVE adversarial passes (§51), consolidated. Each pass is
// one test. These are pure (no network); the durable PostgreSQL restore proof
// for PASS 10 also lives in test/social-durable.test.js (SOC-DUR-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSocialObservation, propagationVsIndependence, coordinationFeatures,
  socialAuthorIdentity, estimateSocialStage, buildSocialFilter,
} from '../rumor2/social.js';
import { classifyOfficialItem } from '../rumor2/truth.js';
import { socialIntake, startSocialStream } from '../rumor2/social-stream.js';
import { jetstreamCommitToRaw, BLUESKY_OFFICIAL } from '../rumor2/providers/bluesky-official.js';
import { socialProviderById } from '../rumor2/social-registry.js';
import { farcasterConfigured } from '../rumor2/providers/farcaster-official.js';

const NOW = Date.parse('2026-09-05T12:00:10Z');
const C = Date.parse('2026-09-05T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let seq = 1;
const commit = ({ did = 'did:plc:a', rkey = 'r', op = 'create', collection = 'app.bsky.feed.post', record = undefined, time = iso(C) } = {}) =>
  ({ $type: 'message', payload: { $type: 'x#commit', did, seq: seq++, time, operation: op, collection, rkey, cid: record ? 'c' : undefined, record } });
const postRec = (over = {}) => ({ $type: 'app.bsky.feed.post', text: over.text ?? '$FOO news', createdAt: over.createdAt ?? iso(C), ...over });
const mkIntake = (over = {}) => socialIntake({ provider: BLUESKY_OFFICIAL, mapCommit: jetstreamCommitToRaw, filter: buildSocialFilter({ terms: ['FOO', 'BAR', 'ZED'] }), now: () => NOW, ...over });
const obs = (over) => normalizeSocialObservation({ provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: over.id, nativeAuthorId: over.author, text: over.text ?? '', relation: over.relation ?? 'ORIGINAL', parentNativePostId: over.parent ?? null, sourceCreatedTs: over.created ?? C }, { nowMs: over.now ?? NOW }).observation;

function fakeSocket() { const h = {}; return { on(e, c) { h[e] = c; }, emit(e, d) { h[e]?.(d); }, close() { this.closed = true; h.close?.(); }, closed: false }; }
function fakeTimers() { const q = []; let id = 1; return { setTimeoutImpl: (cb, ms) => { q.push({ id: id, cb, ms }); return id++; }, clearTimeoutImpl: (t) => { const i = q.findIndex((x) => x.id === t); if (i >= 0) q.splice(i, 1); }, runAll: () => { let g = 0; while (q.length && g++ < 1000) q.shift().cb(); } }; }

test('PASS 1 — DUPLICATE DELIVERY: the same post 100x is ONE semantic source truth', () => {
  const intake = mkIntake();
  const m = commit({ rkey: 'dup', record: postRec({ text: '$FOO once' }) });
  for (let i = 0; i < 100; i++) intake.offer(m);
  assert.equal(intake.stats().enqueued, 1);
  assert.equal(intake.stats().deduped, 99);
});

test('PASS 2 — USERNAME RENAME: author identity stays stable across a handle change', () => {
  const a = socialAuthorIdentity({ provider: 'BLUESKY_OFFICIAL', nativeAuthorId: 'did:plc:x' });
  const b = socialAuthorIdentity({ provider: 'BLUESKY_OFFICIAL', nativeAuthorId: 'did:plc:x' });
  assert.equal(a, b);
});

test('PASS 3 — REPOST STORM: a huge repost count is not independent confirmation', () => {
  const list = [obs({ id: 'at://src/p/0', author: 'did:src', text: 'origin $FOO', created: C, now: C })];
  for (let i = 0; i < 5000; i++) list.push(obs({ id: `at://u${i}/rp/${i}`, author: `did:u${i}`, relation: 'REPOST', parent: 'at://src/p/0', created: C + 1 + i, now: C + 100 + i }));
  const prov = propagationVsIndependence(list);
  assert.ok(prov.rawPropagationCount > 1000);
  assert.equal(prov.independentProvenanceCount, 1);
});

test('PASS 4 — COPY-PASTE STORM: near-duplicate posts are one candidate family, not many confirmations', () => {
  const text = 'insider says QUUX lists next week on a top exchange';
  const list = [];
  // a copy-paste storm is the SAME text from many accounts (trailing space is
  // normalised away, so these are near-duplicates by the deterministic measure)
  for (let i = 0; i < 12; i++) list.push(obs({ id: `at://c${i}/p/${i}`, author: `did:c${i}`, text: i % 2 ? `${text} ` : text, created: C + i, now: C + 10 + i }));
  const prov = propagationVsIndependence(list);
  assert.equal(prov.independentProvenanceCount, 1);
});

test('PASS 5 — PUMP IGNITION: coordination is DESCRIBED, never converted to REJECT', () => {
  const list = [];
  for (let i = 0; i < 50; i++) list.push(obs({ id: `at://n${i}/p/${i}`, author: `did:n${i}`, text: 'BUY $ZED NOW', created: C + i * 100, now: C + i * 100 + 5 }));
  const f = coordinationFeatures(list);
  assert.ok(f.nearDuplicateRatio > 0.9 && f.independentOriginRatio < 0.1);
  assert.ok(!('decision' in f) && !('reject' in f) && !('action' in f) && !('trade' in f));
  const s = estimateSocialStage(f);
  assert.ok(!['BUY', 'SELL', 'TRADE', 'REJECT'].includes(s.stage));
});

test('PASS 6 — MALFORMED PROVIDER PAYLOAD: zero truth', () => {
  const intake = mkIntake();
  assert.equal(intake.offer(null).outcome, 'skipped');
  assert.equal(intake.offer({ payload: { kind: 'identity' } }).outcome, 'skipped');
  assert.equal(intake.offer(commit({ collection: 'app.bsky.feed.like', record: { $type: 'app.bsky.feed.like' } })).outcome, 'skipped');
  assert.equal(intake.size(), 0);
});

test('PASS 7 — FUTURE CLOCK: fail closed FOR CLOCK USE — the source clock is quarantined, the evidence survives, knownAt never moves', () => {
  const intake = mkIntake();
  const r = intake.offer(commit({ rkey: 'f', record: postRec({ text: '$FOO', createdAt: iso(NOW + 60_000) }) }));
  assert.equal(r.outcome, 'enqueued');
  assert.equal(r.observation.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(r.observation.sourceCreatedTs, null);
  assert.equal(r.observation.knownAtTs, NOW, 'no backdating, no manufactured lead time');
});

test('PASS 8 — STREAM RECONNECT: reconnect does not duplicate truth', () => {
  const timers = fakeTimers();
  const intake = mkIntake();
  const sockets = [];
  const s = startSocialStream({
    provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE', buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`,
    socketFactory: () => { const k = fakeSocket(); sockets.push(k); return k; },
    setTimeoutImpl: timers.setTimeoutImpl, clearTimeoutImpl: timers.clearTimeoutImpl, stallMs: 50, backoffBaseMs: 5, maxReconnects: 3,
  }).start();
  const frame = JSON.stringify(commit({ rkey: 'keep', record: postRec({ text: '$FOO persists' }) }));
  sockets[0].emit('open'); sockets[0].emit('message', frame);
  timers.runAll(); // stall -> reconnect
  assert.ok(sockets.length >= 2);
  sockets[sockets.length - 1].emit('open'); sockets[sockets.length - 1].emit('message', frame); // same frame after reconnect
  assert.equal(intake.stats().enqueued, 1, 'the redelivered frame after reconnect is deduped');
  s.stop();
});

test('PASS 9 — REPLAY -> LIVE CUTOVER: overlap between replay and live is deduped (no gap/duplicate)', () => {
  const intake = mkIntake();
  const overlap = commit({ rkey: 'ov', record: postRec({ text: '$FOO overlap' }) });
  // replay feeds the overlap message once
  startSocialStream({ provider: BLUESKY_OFFICIAL, intake, mode: 'REPLAY', fixtures: [overlap] }).start();
  assert.equal(intake.stats().enqueued, 1);
  // live then redelivers the SAME message at cutover
  const live = startSocialStream({ provider: BLUESKY_OFFICIAL, intake, mode: 'LIVE', buildUrl: () => `wss://${BLUESKY_OFFICIAL.hosts[0]}/x`, socketFactory: fakeSocket });
  live._feed(JSON.stringify(overlap));
  assert.equal(intake.stats().enqueued, 1, 'no duplicate across the replay->live boundary');
  assert.equal(intake.stats().deduped, 1);
  live.stop();
});

test('PASS 10 — CRASH/RESTART: settlement is idempotent (durable PG restore is SOC-DUR-3)', () => {
  // at the ear layer, a re-offer of the exact same native post collapses; the
  // durable event root proves exactly-once restore in test/social-durable.test.js
  const intake = mkIntake();
  const m = commit({ rkey: 'restart', record: postRec({ text: '$FOO survive' }) });
  intake.offer(m);
  const drained = intake.drain();
  assert.equal(drained.length, 1);
  intake.offer(m); // "restart" redelivers
  assert.equal(intake.stats().deduped, 1, 'a redelivered post after drain does not re-enqueue duplicate truth');
});

test('PASS 11 — ACCESS FAILURE: providers report truthfully; there is no scraping fallback', () => {
  // unavailable ears carry an honest state + reason, never a scrape path
  assert.equal(socialProviderById('STOCKTWITS_OFFICIAL').accessState, 'AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW'); assert.equal(socialProviderById('STOCKTWITS_OFFICIAL').access.liveStatus, 'DISABLED');
  assert.equal(socialProviderById('TIKTOK_PUBLIC').accessState, 'NOT_AUTHORIZED');
  // Farcaster's live ear is dark without a credential — it does not fall back to scraping
  assert.equal(farcasterConfigured({}), false);
  for (const id of ['STOCKTWITS_OFFICIAL', 'TIKTOK_PUBLIC', 'REDDIT_OFFICIAL', 'META_PUBLIC']) {
    assert.ok(socialProviderById(id).reason.length > 0, `${id} states why`);
  }
});

test('PASS 12 — AUTHORITY: social evidence has no direct trade path and mints no claim', () => {
  // a social providerKind yields NO typed claim from the frozen classifier
  assert.equal(classifyOfficialItem({ providerKind: 'SOCIAL_MICROBLOG', title: 'FOO lists on Kraken', summary: 'trading starts now' }), null);
  assert.equal(classifyOfficialItem({ providerKind: 'SOCIAL_FORUM', title: 'anything', summary: 'anything' }), null);
  // the stage estimate is never a trade verb and carries no authority
  const s = estimateSocialStage(coordinationFeatures([obs({ id: 'at://x/p/1', author: 'did:x', text: '$FOO', now: NOW })]));
  assert.equal(s.calibrated, false);
  assert.ok(!['BUY', 'SELL', 'TRADE', 'REJECT', 'HYPED', 'ELIGIBLE'].includes(s.stage));
});
