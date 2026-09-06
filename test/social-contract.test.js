// SOCIAL-1 — the shared social contract (pure, deterministic; no PG, no
// network, no model). Proves identity (§8/§9/§41), point-in-time clocks
// (§7/§42), echo/repost + near-duplicate (§10/§11/§43), propagation vs
// independence (§13), the pump/coordination feature foundation and the
// pump!=reject doctrine (§14/§44), the DARK non-authoritative stage (§15),
// and the author-record foundation (§16).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  socialSourceIdentity, socialAuthorIdentity, R2SS_RE, R2SA_RE,
  socialClocks, normalizeSocialText, textFingerprint, nearDuplicate, shingleSimilarity, textShingles,
  normalizeSocialObservation, propagationVsIndependence, coordinationFeatures, estimateSocialStage,
  emptyAuthorRecord, SOCIAL_RELATION_KINDS, SOCIAL_PROVIDER_KINDS, SOCIAL_STAGE_STATES, ECHO_RELATIONS,
} from '../rumor2/social.js';

const P = 'BLUESKY_OFFICIAL';
const T = Date.parse('2026-09-05T12:00:00Z');
const post = (over = {}) => ({
  provider: P, providerKind: 'SOCIAL_MICROBLOG',
  nativePostId: over.nativePostId ?? 'at://did:plc:aaa/app.bsky.feed.post/r1',
  nativeAuthorId: over.nativeAuthorId ?? 'did:plc:aaa',
  text: over.text ?? 'BREAKING: FOO lists on a major exchange today',
  sourceCreatedTs: over.sourceCreatedTs ?? Date.parse('2026-09-05T12:00:00Z'),
  ...over,
});

// ---- identity (§8/§9/§41) --------------------------------------------------
test('SOC-ID-1. post identity is provider+nativePostId only; author identity is provider-scoped', () => {
  const a = socialSourceIdentity({ provider: P, nativePostId: 'at://x/p/1' });
  assert.match(a, R2SS_RE);
  // same native post => same identity (idempotent re-delivery)
  assert.equal(a, socialSourceIdentity({ provider: P, nativePostId: 'at://x/p/1' }));
  // different post => different identity
  assert.notEqual(a, socialSourceIdentity({ provider: P, nativePostId: 'at://x/p/2' }));
  // same nativePostId on a different provider => different identity (no cross-network merge)
  assert.notEqual(a, socialSourceIdentity({ provider: 'X_OFFICIAL', nativePostId: 'at://x/p/1' }));
  const au = socialAuthorIdentity({ provider: P, nativeAuthorId: 'did:plc:aaa' });
  assert.match(au, R2SA_RE);
  // same username string on two networks is NOT one author (§9)
  assert.notEqual(
    socialAuthorIdentity({ provider: 'X_OFFICIAL', nativeAuthorId: 'fred' }),
    socialAuthorIdentity({ provider: 'REDDIT_OFFICIAL', nativeAuthorId: 'fred' })
  );
});

test('SOC-ID-2. username rename keeps a stable author identity; identity ignores handle', () => {
  const before = normalizeSocialObservation(post({ handle: 'oldhandle.bsky.social' }), { nowMs: Date.parse('2026-09-05T12:00:05Z') });
  const after = normalizeSocialObservation(post({ nativePostId: 'at://did:plc:aaa/app.bsky.feed.post/r2', handle: 'newhandle.bsky.social' }), { nowMs: Date.parse('2026-09-05T12:00:06Z') });
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.equal(before.observation.socialAuthorId, after.observation.socialAuthorId, 'rename does not change author identity');
  assert.notEqual(before.observation.socialSourceId, after.observation.socialSourceId, 'different posts are different sources');
});

test('SOC-ID-3. altered content changes the content/version identity, not the diagnostic hash (§26)', () => {
  const one = normalizeSocialObservation(post({ text: 'original text' }), { nowMs: Date.parse('2026-09-05T12:00:05Z') });
  const two = normalizeSocialObservation(post({ text: 'ALTERED text' }), { nowMs: Date.parse('2026-09-05T12:00:05Z') }); // same acquisition clock (first-known clocks are diagnostic-bound)
  assert.equal(one.observation.socialSourceId, two.observation.socialSourceId, 'identity is native-id only');
  assert.notEqual(one.observation.textHash, two.observation.textHash, 'altered content is visible in the textHash');
  // content lives in the CONTENT/VERSION identity now, not the diagnostic hash:
  // altered text is a new content version (and, at a KEPT native version id, a
  // corruption signal the journal catches); the diagnostic hash — handle +
  // authorMeta + engagement, all unchanged here — is unaffected (§4/§26).
  assert.notEqual(one.observation.socialVersionId, two.observation.socialVersionId, 'altered content is a new content/version identity');
  assert.equal(one.observation.metaHash, two.observation.metaHash, 'the diagnostic hash is unaffected by a content-only change');
});

test('SOC-ID-4. two independent authors posting identical text are distinct sources', () => {
  const a = normalizeSocialObservation(post({ nativePostId: 'at://did:plc:aaa/app.bsky.feed.post/x', nativeAuthorId: 'did:plc:aaa', text: 'same words' }), { nowMs: T + 1 });
  const b = normalizeSocialObservation(post({ nativePostId: 'at://did:plc:bbb/app.bsky.feed.post/y', nativeAuthorId: 'did:plc:bbb', text: 'same words' }), { nowMs: T + 2 });
  assert.notEqual(a.observation.socialSourceId, b.observation.socialSourceId);
  assert.notEqual(a.observation.socialAuthorId, b.observation.socialAuthorId);
});

// ---- point-in-time (§7/§42) ------------------------------------------------
test('SOC-PIT-1. knownAt equals retrieval, never the post creation; replay preserves old createdTs', () => {
  const created = Date.parse('2026-01-01T00:00:00Z');
  const replayNow = Date.parse('2026-09-05T12:00:00Z'); // replayed months later
  const r = normalizeSocialObservation(post({ sourceCreatedTs: created }), { nowMs: replayNow });
  assert.equal(r.ok, true);
  assert.equal(r.observation.sourceCreatedTs, created, 'original creation preserved');
  assert.equal(r.observation.retrievedTs, replayNow, 'retrieval is the replay acquisition clock');
  assert.equal(r.observation.knownAtTs, replayNow, 'knownAt is never backdated to creation');
  assert.ok(r.observation.knownAtTs > r.observation.sourceCreatedTs);
});

test('SOC-PIT-2 (SOURCE-CLOCK QUARANTINE). a future source clock is quarantined from causal use — the evidence is kept, knownAt never backdated', () => {
  const r = normalizeSocialObservation(post({ sourceCreatedTs: Date.parse('2026-09-05T12:00:10Z') }), { nowMs: Date.parse('2026-09-05T12:00:00Z') });
  assert.equal(r.ok, true, 'a bad client clock never discards the post');
  assert.equal(r.observation.sourceClockStatus, 'FUTURE_QUARANTINED');
  assert.equal(r.observation.sourceCreatedTs, null, 'quarantined: no trusted source time');
  assert.equal(r.observation.sourceDeclaredTs, Date.parse('2026-09-05T12:00:10Z'), 'the declared value is preserved as evidence');
  assert.equal(r.observation.sourceClockSkewMs, 10_000);
  assert.equal(r.observation.knownAtTs, Date.parse('2026-09-05T12:00:00Z'));
});

// ---- normalization rejects (closed shape, no blobs) ------------------------
test('SOC-NORM-1. malformed observations are rejected; unknown relation/kind refused', () => {
  assert.equal(normalizeSocialObservation(null, { nowMs: 1 }).reject, true);
  assert.equal(normalizeSocialObservation(post({ providerKind: 'REGULATOR' }), { nowMs: 1 }).reject, true, 'a claim-capable kind is not a social kind');
  assert.equal(normalizeSocialObservation(post({ relation: 'BOGUS' }), { nowMs: 1 }).reject, true);
  assert.equal(normalizeSocialObservation(post({ nativePostId: '' }), { nowMs: 1 }).reject, true);
  assert.equal(normalizeSocialObservation(post({ text: 'x'.repeat(5000) }), { nowMs: 1 }).reject, true, 'oversized text refused');
  assert.equal(normalizeSocialObservation(post({ relation: 'REPOST', parentNativePostId: null }), { nowMs: 1 }).reject, true, 'an echo must name its parent');
  // engagement is bounded ints or null, never fabricated
  assert.equal(normalizeSocialObservation(post({ engagement: { likes: -1 } }), { nowMs: 1 }).reject, true);
  assert.equal(normalizeSocialObservation(post({ authorMeta: { accountCreatedTs: Date.parse('2999-01-01') } }), { nowMs: 1 }).reject, true, 'future account age refused');
});

test('SOC-NORM-2. a valid observation is a closed, frozen, bounded shape', () => {
  const r = normalizeSocialObservation(post({ relation: 'ORIGINAL', engagement: { likes: 3, reposts: 1 }, authorMeta: { followerCount: 10, verified: true } }), { nowMs: Date.parse('2026-09-05T12:00:05Z') });
  assert.equal(r.ok, true);
  const o = r.observation;
  assert.ok(Object.isFrozen(o));
  assert.equal(o.engagement.likes, 3);
  assert.equal(o.engagement.views, null, 'absent engagement is null, never invented');
  assert.equal(o.authorMeta.verified, true);
  assert.match(o.socialSourceId, R2SS_RE);
});

// ---- echo / near-duplicate (§10/§11/§43) -----------------------------------
test('SOC-ECHO-1 (§43 ECHO-1). 100 exact native reposts are ONE provenance family', () => {
  const origin = normalizeSocialObservation(post({ nativePostId: 'at://did:plc:src/app.bsky.feed.post/o', nativeAuthorId: 'did:plc:src', text: 'FOO mainnet is live' }), { nowMs: T }).observation;
  const obs = [origin];
  for (let i = 0; i < 100; i++) {
    obs.push(normalizeSocialObservation({
      provider: P, providerKind: 'SOCIAL_MICROBLOG',
      nativePostId: `at://did:plc:u${i}/app.bsky.feed.repost/r${i}`, nativeAuthorId: `did:plc:u${i}`,
      text: '', relation: 'REPOST', parentNativePostId: 'at://did:plc:src/app.bsky.feed.post/o', sourceCreatedTs: T + 1 + i,
    }, { nowMs: T + 1000 + i }).observation);
  }
  const prov = propagationVsIndependence(obs);
  assert.equal(prov.rawPropagationCount, 101, 'every post is counted as propagation');
  assert.equal(prov.independentProvenanceCount, 1, 'but there is ONE originating family');
});

test('SOC-ECHO-2 (§43 ECHO-2). 10 manual copy-paste posts collapse into one near-duplicate family, not 10 confirmations', () => {
  const text = 'RUMOR: BAR to be listed on a top-5 exchange next week, insider says';
  const obs = [];
  for (let i = 0; i < 10; i++) {
    obs.push(normalizeSocialObservation({
      provider: P, providerKind: 'SOCIAL_MICROBLOG',
      nativePostId: `at://did:plc:c${i}/app.bsky.feed.post/p${i}`, nativeAuthorId: `did:plc:c${i}`,
      text: i === 0 ? text : text + (i % 2 ? ' ' : ''), relation: 'ORIGINAL', sourceCreatedTs: 1000 + i,
    }, { nowMs: 2000 + i }).observation);
  }
  const prov = propagationVsIndependence(obs);
  assert.equal(prov.rawPropagationCount, 10);
  assert.equal(prov.independentProvenanceCount, 1, 'near-duplicate copies are one candidate family, not 10 independent confirmations');
});

test('SOC-ECHO-3 (§43 ECHO-3). genuinely different accounts with materially different wording stay distinct origins', () => {
  const obs = [
    normalizeSocialObservation(post({ nativePostId: 'at://a/p/1', nativeAuthorId: 'did:a', text: 'FOO is launching a mainnet upgrade with staking rewards' }), { nowMs: T + 1 }).observation,
    normalizeSocialObservation(post({ nativePostId: 'at://b/p/2', nativeAuthorId: 'did:b', text: 'heard the FOO team ships v2 tomorrow, big news for holders' }), { nowMs: T + 2 }).observation,
    normalizeSocialObservation(post({ nativePostId: 'at://c/p/3', nativeAuthorId: 'did:c', text: 'FOO exchange listing confirmed by a reliable source imo' }), { nowMs: T + 3 }).observation,
  ];
  const prov = propagationVsIndependence(obs);
  assert.equal(prov.independentProvenanceCount, 3, 'distinct wording is not auto-merged — SOCIAL-5 decides independence');
});

test('SOC-DUP. deterministic near-duplicate scoring: exact copy 1.0, unrelated ~0', () => {
  assert.equal(nearDuplicate('abc def ghi', 'abc def ghi').score, 1);
  assert.equal(nearDuplicate('', 'anything').candidate, false, 'empty text is never a copy candidate');
  const nd = nearDuplicate('the quick brown fox jumps', 'the quick brown fox leaps');
  assert.ok(nd.score > 0 && nd.score < 1);
  assert.equal(shingleSimilarity(textShingles('a b c'), textShingles('x y z')), 0);
});

// ---- propagation vs independence (§13) -------------------------------------
test('SOC-IND-1 (§44 PUMP-3). one influencer + 10,000 reposts: huge propagation, low independence', () => {
  const origin = normalizeSocialObservation(post({ nativePostId: 'at://star/p/0', nativeAuthorId: 'did:star', text: 'aped into ZED, lfg' }), { nowMs: T }).observation;
  const obs = [origin];
  for (let i = 0; i < 10000; i++) {
    obs.push(normalizeSocialObservation({
      provider: P, providerKind: 'SOCIAL_MICROBLOG', nativePostId: `at://u${i}/repost/${i}`, nativeAuthorId: `did:u${i}`,
      text: '', relation: 'REPOST', parentNativePostId: 'at://star/p/0', sourceCreatedTs: T + 1 + i,
    }, { nowMs: T + 2 + i }).observation);
  }
  const prov = propagationVsIndependence(obs);
  assert.ok(prov.rawPropagationCount >= 4096, 'propagation window is bounded but large');
  assert.equal(prov.independentProvenanceCount, 1, 'independence stays at 1 — reposts are not confirmations');
});

// ---- pump/coordination features (§14/§44) — INFORMATION, not a decision -----
test('SOC-PUMP-1 (§44 PUMP-1). a coordinated new-account identical-text burst is described, never rejected', () => {
  const text = 'BUY $ZAP NOW 100x guaranteed';
  const t0 = Date.parse('2026-09-05T12:00:00Z');
  const obs = [];
  for (let i = 0; i < 100; i++) {
    obs.push(normalizeSocialObservation({
      provider: P, providerKind: 'SOCIAL_MICROBLOG', nativePostId: `at://n${i}/p/${i}`, nativeAuthorId: `did:new${i}`,
      text, relation: 'ORIGINAL', sourceCreatedTs: t0 + i * 100,
      authorMeta: { accountCreatedTs: t0 - 3_600_000, verified: false }, // ~1h-old accounts
    }, { nowMs: t0 + i * 100 + 500 }).observation);
  }
  const f = coordinationFeatures(obs);
  assert.equal(f.messageCount, 100);
  assert.ok(f.nearDuplicateRatio > 0.9, 'identical text => high near-duplicate ratio');
  assert.ok(f.independentOriginRatio < 0.1, 'one text family => low independence');
  assert.equal(f.newAccountRatio, 1, 'all brand-new accounts');
  assert.ok(f.burstConcentration > 0, 'burst measured');
  // CRITICAL: the layer records features; it does NOT produce a reject/trade signal
  assert.ok(!('decision' in f) && !('reject' in f) && !('action' in f), 'no trade decision in coordination features');
});

test('SOC-PUMP-2 (§44 PUMP-2). many established independent voices: lower duplicate ratio, higher independence', () => {
  const t0 = Date.parse('2026-09-05T12:00:00Z');
  const phrases = ['FOO ships mainnet', 'the FOO upgrade is live now', 'staking opens on FOO today', 'FOO v2 launched, devs confirm', 'big FOO milestone reached this morning'];
  const obs = [];
  for (let i = 0; i < 20; i++) {
    obs.push(normalizeSocialObservation({
      provider: P, providerKind: 'SOCIAL_MICROBLOG', nativePostId: `at://e${i}/p/${i}`, nativeAuthorId: `did:est${i}`,
      text: phrases[i % phrases.length] + ` (${i})`, relation: 'ORIGINAL', sourceCreatedTs: t0 + i * 300_000,
      authorMeta: { accountCreatedTs: t0 - 400 * 24 * 3_600_000, verified: true },
    }, { nowMs: t0 + i * 300_000 + 500 }).observation);
  }
  const f = coordinationFeatures(obs);
  assert.ok(f.independentOriginRatio > 0.2, 'varied wording => more independent families');
  assert.equal(f.newAccountRatio, 0, 'all established accounts');
  assert.equal(f.verifiedRatio, 1);
});

test('SOC-PUMP-3. features are null (UNKNOWN) where platform metadata is absent — never fabricated', () => {
  const obs = [normalizeSocialObservation(post(), { nowMs: T + 10 }).observation]; // no authorMeta
  const f = coordinationFeatures(obs);
  assert.equal(f.newAccountRatio, null, 'unknown account ages => null, not a guess');
  assert.equal(f.verifiedRatio, null);
  assert.equal(f.messageVelocityPerMin, null, 'a single instant has no measurable velocity');
});

// ---- stage classifier is DARK (§15) ----------------------------------------
test('SOC-STAGE. the stage contract exists but the classifier is uncalibrated/UNKNOWN and carries no authority', () => {
  const f = coordinationFeatures([normalizeSocialObservation(post(), { nowMs: T + 1 }).observation]);
  const s = estimateSocialStage(f);
  assert.equal(s.stage, 'UNKNOWN');
  assert.equal(s.calibrated, false);
  assert.ok(SOCIAL_STAGE_STATES.includes(s.stage));
  assert.ok(!['BUY', 'SELL', 'TRADE', 'REJECT'].includes(s.stage), 'stage is never a trade verb');
});

// ---- author record foundation (§16) ----------------------------------------
test('SOC-AUTHOR. author record is objective histories only — no good/bad score', () => {
  const rec = emptyAuthorRecord({ provider: P, nativeAuthorId: 'did:plc:aaa' });
  assert.match(rec.socialAuthorId, R2SA_RE);
  for (const k of ['firstSeenCount', 'independentOriginCount', 'laterConfirmedCount', 'laterContradictedCount', 'deletedCount', 'copiedCount']) assert.equal(rec[k], 0);
  assert.ok(!('score' in rec) && !('reputation' in rec) && !('trust' in rec), 'no social-credit score');
});

// ---- enum sanity -----------------------------------------------------------
test('SOC-ENUM. relation/kind/echo enums are the closed expected sets', () => {
  assert.deepEqual(SOCIAL_RELATION_KINDS, ['ORIGINAL', 'REPLY', 'REPOST', 'QUOTE', 'CROSSPOST', 'POSSIBLE_COPY', 'UNKNOWN']);
  assert.deepEqual(ECHO_RELATIONS, ['REPOST', 'QUOTE', 'CROSSPOST']);
  for (const k of SOCIAL_PROVIDER_KINDS) assert.match(k, /^SOCIAL_/);
});
