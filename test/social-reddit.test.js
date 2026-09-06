// SOCIAL-3 — classification-neutral Reddit access foundation + retention firewall.
// Everything here is synthetic: no Reddit content, no credential value, no network.
// These tests prove ENGINEERING behavior with invented approval fixtures; they do
// not claim Reddit has approved anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REDDIT_OFFICIAL, REDDIT_FOUNDATION, REDDIT_USE_CASE, REDDIT_USE_CASE_VERSION, REDDIT_APPLICATION_ID,
  REDDIT_USE_CASE_CLASSIFICATIONS, REDDIT_APPROVAL_STATUSES, REDDIT_AGREEMENT_STATES, REDDIT_RETENTION_STATES, REDDIT_PERMITTED_USES,
  redditApprovalRecordFromEnv, validateRedditApprovalRecord, evaluateRedditAccess, redditCredentialsPresent,
  redditThingToPreview, redditUserAgent, redditListingRequest, parseRedditRateHeaders, redditRateAllowance,
} from '../rumor2/social-reddit.js';
import { SOCIAL_PROVIDERS, SOCIAL_ACCESS_STATES, socialProviderById, ACTIVE_SOCIAL_PROVIDER_IDS, isLiveActivatable, isPlatformCapable } from '../rumor2/social-registry.js';
import { normalizeSocialObservation, SOCIAL_RETENTION_PROHIBITED_PROVIDERS, socialRetentionRefusal, socialSourceIdentity, socialAuthorIdentity, socialVersionIdentity, socialMetaHash, classifySourceClock, buildSocialFilter } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent, replaySocialHistory } from '../rumor2/social-settle.js';
import { socialIntake } from '../rumor2/social-stream.js';
import { neynarEventToRaw } from '../rumor2/providers/farcaster-official.js';
import { memJournal } from './helpers/rumor2-journal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = Date.parse('2026-09-06T12:00:00Z');
const NOW = { nowMs: T };
const CREDS = { REDDIT_CLIENT_ID: 'fixture-client-id-not-real', REDDIT_CLIENT_SECRET: 'fixture-secret-not-real' };
const RECORD = (over = {}) => ({
  approvalRef: 'reddit-ticket-FIXTURE-0001', status: 'APPROVED', application: REDDIT_APPLICATION_ID, useCaseVersion: REDDIT_USE_CASE_VERSION,
  classification: 'NON_COMMERCIAL_PERSONAL', permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH', 'PAPER_TRADING'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false,
  validUntil: '2027-09-06T00:00:00Z', retentionCompatibility: 'UNRESOLVED', reviewedOn: '2026-09-06', ...over,
});
const post = (over = {}) => ({ kind: 't3', data: { name: 't3_fx1a2b', id: 'fx1a2b', subreddit: 'CryptoCurrency', subreddit_id: 't5_2wlj3', title: 'Fixture: BTC listing rumor', selftext: 'synthetic  fixture   body', author: 'fixture_user', author_fullname: 't2_fxauthr', created_utc: (T - 60_000) / 1000, score: 12, ups: 14, num_comments: 3, upvote_ratio: 0.86, edited: false, permalink: '/r/CryptoCurrency/comments/fx1a2b/fixture/', is_self: true, ...over } });
const comment = (over = {}) => ({ kind: 't1', data: { name: 't1_fxc0m1', id: 'fxc0m1', subreddit: 'CryptoCurrency', subreddit_id: 't5_2wlj3', body: 'synthetic reply', author: 'fixture_replier', author_fullname: 't2_fxrepli', link_id: 't3_fx1a2b', parent_id: 't3_fx1a2b', created_utc: (T - 30_000) / 1000, score: 2, ups: 2, edited: false, permalink: '/r/CryptoCurrency/comments/fx1a2b/fixture/fxc0m1/', ...over } });

// =====================================================================================
// §1/§5 — the recorded description and the neutral classification state
// =====================================================================================
test('REDDIT-CENSUS (§5). the census records a documented official path with UNRESOLVED classification/approval/agreement/retention — neither commercial nor exempt is assumed', () => {
  const r = socialProviderById('REDDIT_OFFICIAL');
  assert.equal(r.accessState, 'AVAILABLE_REQUIRES_APPROVAL_AND_CLASSIFICATION'); assert.ok(SOCIAL_ACCESS_STATES.includes(r.accessState));
  assert.deepEqual(r.access, { platformPath: 'DOCUMENTED_OFFICIAL_PATH', useCaseClassification: 'UNRESOLVED', approvalStatus: 'NOT_VERIFIED', additionalAgreementRequirement: 'UNRESOLVED', retentionCompatibility: 'UNRESOLVED', liveStatus: 'DISABLED', durableContentAllowed: false, durableAuthorIdentityAllowed: false });
  assert.equal('requiresCommercialContract' in r, false); assert.equal('nonCommercialExempt' in r, false); assert.equal('commercialContractRequired' in r.cost, false, 'no hard-coded contract requirement');
  assert.equal(r.cost.entitlement, 'NOT_ESTABLISHED'); assert.equal(r.cost.freeEligibleQpmReference, 100, 'technical context, not entitlement');
  assert.equal(r.useCase.audience, 'PRIVATE_SINGLE_USER'); assert.equal(r.useCase.offeredToCustomers, false); assert.equal(r.useCase.soldAsService, false);
  assert.deepEqual([...r.useCase.intendedUses], ['PERSONAL_RESEARCH', 'PAPER_TRADING', 'POSSIBLE_OWN_FUNDS_AUTOMATED_TRADING'], 'personal trading is disclosed, never omitted');
  assert.equal(r.useCase.affiliationClaimed, 'NONE'); assert.equal(r.useCase.classificationSource, 'REDDIT_USE_CASE_REVIEW');
  assert.equal(r.sources.length, 5); for (const s of r.sources) { assert.match(s.ref, /^R[1-5]$/); assert.ok(s.url.startsWith('https://')); assert.equal(s.accessedOn, '2026-09-06'); }
  assert.equal(r.implemented, true); assert.equal(r.durable, false); assert.equal(r.runtimeGated, false); assert.equal(r.retentionProhibited, true);
  assert.ok(!ACTIVE_SOCIAL_PROVIDER_IDS.includes('REDDIT_OFFICIAL')); assert.equal(isLiveActivatable(r.accessState), false); assert.equal(isPlatformCapable(r.accessState), false, 'a documented path is not a capability until approved');
  assert.ok(!/research-only|definitely commercial|exempt/i.test(r.reason));
  assert.deepEqual(REDDIT_USE_CASE.intendedUses, r.useCase.intendedUses); assert.equal(REDDIT_USE_CASE.version, r.useCase.version);
  for (const p of SOCIAL_PROVIDERS) if (p.id !== 'REDDIT_OFFICIAL') assert.notEqual(p.retentionProhibited, true, `${p.id} is unaffected`);
});

// =====================================================================================
// §6/§7 — approval is evidence, not a magic boolean (A..J)
// =====================================================================================
test('REDDIT-A/C. a personal/single-user or "theoretical prototype" description alone: classification unresolved, no permission invented, zero requests', () => {
  for (const description of ['private single-user personal prototype', 'theoretical prototype only', 'research']) {
    const a = evaluateRedditAccess({ record: null, env: {}, description, nowMs: T });
    assert.equal(a.useCaseClassification, 'UNRESOLVED'); assert.equal(a.approvalStatus, 'NOT_VERIFIED'); assert.equal(a.liveAllowed, false); assert.equal(a.durableContentAllowed, false);
    assert.ok(a.advisories.includes('SELF_DESCRIPTION_IS_NOT_PERMISSION'), 'informational, never mistaken for a blocker'); assert.ok(a.blockers.includes('APPROVAL_RECORD_MISSING')); assert.equal(a.activationPrerequisitesMet, false);
  }
  assert.equal(REDDIT_FOUNDATION.liveTransport, false); assert.equal(REDDIT_FOUNDATION.oauthExchange, false); assert.equal(REDDIT_FOUNDATION.pollingLoop, false); assert.equal(REDDIT_FOUNDATION.scraping, false);
});

test('REDDIT-B. credentials alone: approval not verified, nothing live, no credential value ever surfaces', () => {
  assert.equal(redditCredentialsPresent(CREDS), true); assert.equal(redditCredentialsPresent({ REDDIT_CLIENT_ID: 'x' }), false, 'a pair is required');
  const a = evaluateRedditAccess({ record: null, env: CREDS, nowMs: T });
  assert.equal(a.credentialPresent, true); assert.equal(a.approvalStatus, 'NOT_VERIFIED'); assert.equal(a.useCaseClassification, 'UNRESOLVED'); assert.equal(a.liveAllowed, false); assert.equal(a.activationPrerequisitesMet, false);
  assert.ok(!JSON.stringify(a).includes(CREDS.REDDIT_CLIENT_SECRET)); assert.ok(!JSON.stringify(a).includes(CREDS.REDDIT_CLIENT_ID));
  assert.equal(a.evidence, 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF');
});

test('REDDIT-D. an operator approval flag with no supporting review record stays unverified; a record that names no classification stays unverified', () => {
  const flagOnly = evaluateRedditAccess({ record: redditApprovalRecordFromEnv({ REDDIT_COMMERCIAL_APPROVED: 'true', REDDIT_APPROVED: 'true' }), env: CREDS, nowMs: T });
  assert.equal(flagOnly.approvalStatus, 'NOT_VERIFIED'); assert.ok(flagOnly.blockers.includes('APPROVAL_RECORD_MISSING'), 'an unrelated boolean is not a record');
  const noClass = evaluateRedditAccess({ record: RECORD({ classification: 'UNRESOLVED' }), env: CREDS, nowMs: T });
  assert.equal(noClass.approvalStatus, 'NOT_VERIFIED'); assert.equal(noClass.useCaseClassification, 'UNRESOLVED'); assert.ok(noClass.blockers.some((b) => b.startsWith('APPROVAL_WITHOUT_CLASSIFICATION')));
  const pending = evaluateRedditAccess({ record: RECORD({ status: 'PENDING' }), env: CREDS, nowMs: T });
  assert.equal(pending.approvalStatus, 'NOT_VERIFIED'); assert.ok(pending.blockers.includes('APPROVAL_PENDING'));
});

test('REDDIT-E. a hypothetical valid NON-COMMERCIAL personal-use approval is representable without any commercial contract by default — live access still disabled in this foundation', () => {
  const a = evaluateRedditAccess({ record: RECORD({ retentionCompatibility: 'COMPATIBLE_REVIEWED' }), env: CREDS, nowMs: T });
  assert.equal(a.approvalStatus, 'OPERATOR_ATTESTED'); assert.equal(a.useCaseClassification, 'APPROVED_NON_COMMERCIAL_PERSONAL'); assert.equal(a.additionalAgreement, 'NOT_REQUIRED');
  assert.equal(a.retentionCompatibility, 'COMPATIBLE_REVIEWED'); assert.equal(a.activationPrerequisitesMet, true, 'every prerequisite a future activation ticket would check');
  assert.equal(a.liveAllowed, false); assert.equal(a.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(a.liveStatus, 'DISABLED');
  assert.equal(a.durableContentAllowed, false); assert.equal(a.durableReason, 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED');
  assert.deepEqual(a.downstream, { inference: false, training: false, derivedFeatures: false, redistribution: false }, 'retrieval approval never expands to downstream uses');
  assert.equal(socialRetentionRefusal('REDDIT_OFFICIAL') !== null, true, 'the journal firewall does not read the record at all');
});

test('REDDIT-F. a hypothetical approval that requires a separate agreement: unsatisfied blocks readiness; satisfied is representable', () => {
  const un = evaluateRedditAccess({ record: RECORD({ classification: 'REQUIRES_ADDITIONAL_TERMS', additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: false, retentionCompatibility: 'COMPATIBLE_REVIEWED' }), env: CREDS, nowMs: T });
  assert.equal(un.useCaseClassification, 'APPROVED_WITH_ADDITIONAL_TERMS'); assert.equal(un.additionalAgreement, 'REQUIRED_UNSATISFIED'); assert.equal(un.activationPrerequisitesMet, false); assert.ok(un.blockers.includes('ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED'));
  const ok = evaluateRedditAccess({ record: RECORD({ classification: 'COMMERCIAL', additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: true, retentionCompatibility: 'COMPATIBLE_REVIEWED' }), env: CREDS, nowMs: T });
  assert.equal(ok.useCaseClassification, 'APPROVED_COMMERCIAL'); assert.equal(ok.additionalAgreement, 'REQUIRED_SATISFIED'); assert.equal(ok.activationPrerequisitesMet, true); assert.equal(ok.liveAllowed, false);
  assert.match(validateRedditApprovalRecord(RECORD({ classification: 'COMMERCIAL', additionalAgreement: 'NOT_REQUIRED' })), /requires additional terms/, 'an inconsistent record fails closed');
  const unresolved = evaluateRedditAccess({ record: RECORD({ additionalAgreement: 'UNRESOLVED' }), env: CREDS, nowMs: T });
  assert.equal(unresolved.additionalAgreement, 'UNRESOLVED'); assert.ok(unresolved.blockers.includes('ADDITIONAL_AGREEMENT_UNRESOLVED'));
});

test('REDDIT-G/H. approval covering another application/use-case version is out of scope; revoked, expired, and denied approvals are blocked', () => {
  const other = evaluateRedditAccess({ record: RECORD({ application: 'SOME_OTHER_APP' }), env: CREDS, nowMs: T });
  assert.equal(other.approvalStatus, 'OUT_OF_SCOPE'); assert.equal(other.useCaseClassification, 'UNRESOLVED'); assert.equal(other.activationPrerequisitesMet, false);
  const otherVersion = evaluateRedditAccess({ record: RECORD({ useCaseVersion: 'serpent-reddit-use-case-v0' }), env: CREDS, nowMs: T });
  assert.equal(otherVersion.approvalStatus, 'OUT_OF_SCOPE', 'a changed use case needs a fresh review');
  assert.equal(evaluateRedditAccess({ record: RECORD({ status: 'REVOKED' }), env: CREDS, nowMs: T }).approvalStatus, 'REVOKED');
  assert.equal(evaluateRedditAccess({ record: RECORD({ validUntil: '2026-09-05T00:00:00Z' }), env: CREDS, nowMs: T }).approvalStatus, 'EXPIRED');
  const denied = evaluateRedditAccess({ record: RECORD({ status: 'DENIED' }), env: CREDS, nowMs: T });
  assert.equal(denied.approvalStatus, 'DENIED'); assert.equal(denied.useCaseClassification, 'DENIED');
  for (const a of [other, otherVersion, denied]) { assert.equal(a.liveAllowed, false); assert.equal(a.durableContentAllowed, false); }
});

test('REDDIT-I. approved classification but unresolved retention: the durable-content path stays blocked and retention is a separate blocker', () => {
  const a = evaluateRedditAccess({ record: RECORD({ retentionCompatibility: 'UNRESOLVED' }), env: CREDS, nowMs: T });
  assert.equal(a.approvalStatus, 'OPERATOR_ATTESTED'); assert.equal(a.useCaseClassification, 'APPROVED_NON_COMMERCIAL_PERSONAL');
  assert.equal(a.retentionCompatibility, 'UNRESOLVED'); assert.equal(a.prerequisites.retention, false); assert.equal(a.activationPrerequisitesMet, false); assert.ok(a.blockers.includes('RETENTION_COMPATIBILITY_UNRESOLVED'));
  assert.equal(a.durableContentAllowed, false); assert.equal(a.durableAuthorIdentityAllowed, false); assert.equal(a.durableReason, 'RETENTION_COMPATIBILITY_UNRESOLVED');
  const inc = evaluateRedditAccess({ record: RECORD({ retentionCompatibility: 'INCOMPATIBLE' }), env: CREDS, nowMs: T });
  assert.ok(inc.blockers.includes('RETENTION_INCOMPATIBLE'));
});

test('REDDIT-J. unknown classification / policy enums fail closed, never as permission; env parsing is bounded and holds no secret', () => {
  for (const bad of [{ status: 'GRANTED' }, { classification: 'FREE_FOR_ALL' }, { additionalAgreement: 'WAIVED' }, { retentionCompatibility: 'PROBABLY_FINE' }, { permittedUses: ['EVERYTHING'] }, { approvalRef: 'contains spaces and text' }, { validUntil: 'soon' }, { extra: 1 }]) {
    const err = validateRedditApprovalRecord(RECORD(bad)); assert.ok(err, JSON.stringify(bad));
    const a = evaluateRedditAccess({ record: RECORD(bad), env: CREDS, nowMs: T });
    assert.equal(a.approvalStatus, 'NOT_VERIFIED'); assert.equal(a.useCaseClassification, 'UNRESOLVED'); assert.ok(a.blockers.some((b) => b.startsWith('APPROVAL_RECORD_INVALID')));
  }
  const env = { RUMOR2_SOCIAL_REDDIT_APPROVAL_REF: 'reddit-ticket-FIXTURE-0002', RUMOR2_SOCIAL_REDDIT_APPROVAL_STATUS: 'APPROVED', RUMOR2_SOCIAL_REDDIT_APPROVAL_APPLICATION: REDDIT_APPLICATION_ID, RUMOR2_SOCIAL_REDDIT_APPROVAL_USE_CASE_VERSION: REDDIT_USE_CASE_VERSION, RUMOR2_SOCIAL_REDDIT_APPROVAL_CLASSIFICATION: 'NON_COMMERCIAL_PERSONAL', RUMOR2_SOCIAL_REDDIT_APPROVAL_PERMITTED_USES: 'RETRIEVAL, PERSONAL_RESEARCH', RUMOR2_SOCIAL_REDDIT_APPROVAL_ADDITIONAL_AGREEMENT: 'NOT_REQUIRED', RUMOR2_SOCIAL_REDDIT_APPROVAL_RETENTION_COMPATIBILITY: 'UNRESOLVED' };
  const rec = redditApprovalRecordFromEnv(env); assert.equal(validateRedditApprovalRecord(rec), null); assert.deepEqual(rec.permittedUses, ['RETRIEVAL', 'PERSONAL_RESEARCH']);
  assert.equal(redditApprovalRecordFromEnv({}), null);
  assert.equal(REDDIT_USE_CASE_CLASSIFICATIONS.includes('UNRESOLVED'), true); assert.equal(REDDIT_APPROVAL_STATUSES.includes('OPERATOR_ATTESTED'), true); assert.equal(REDDIT_AGREEMENT_STATES.length, 4); assert.equal(REDDIT_RETENTION_STATES.length, 3); assert.equal(REDDIT_PERMITTED_USES.includes('RETRIEVAL'), true);
});

// =====================================================================================
// §8/§9 — retention firewall at every supported Social boundary
// =====================================================================================
const redditRaw = () => ({ provider: 'REDDIT_OFFICIAL', providerKind: 'SOCIAL_FORUM', nativePostId: 't3_fx1a2b', nativeAuthorId: 't2_fxauthr', text: 'synthetic fixture body', relation: 'ORIGINAL', sourceDeclaredTs: T - 60_000 });
const farcasterEvent = () => {
  const { raw } = neynarEventToRaw({ type: 'cast.created', data: { hash: '0xfixturehash', author: { fid: 77, username: 'fx' }, text: 'synthetic cast', timestamp: new Date(T - 60_000).toISOString() } });
  const n = normalizeSocialObservation(raw, NOW); assert.equal(n.ok, true);
  return socialObservationToEvent(n.observation).event;
};
// a SHAPE-VALID Reddit durable event forged with correctly re-derived identities
const forgedRedditEvent = () => {
  const e = { ...farcasterEvent(), provider: 'REDDIT_OFFICIAL', providerKind: 'SOCIAL_FORUM', nativePostId: 't3_fx1a2b', nativeAuthorId: 't2_fxauthr' };
  e.socialSourceId = socialSourceIdentity({ provider: e.provider, nativePostId: e.nativePostId });
  e.socialAuthorId = socialAuthorIdentity({ provider: e.provider, nativeAuthorId: e.nativeAuthorId });
  e.metaHash = socialMetaHash(e); e.sourceEventId = socialVersionIdentity(e);
  return e;
};

test('REDDIT-FIREWALL-1 (§9). normalized Reddit observation -> durable Social event: refused at normalization AND at event construction', () => {
  assert.deepEqual([...SOCIAL_RETENTION_PROHIBITED_PROVIDERS], ['REDDIT_OFFICIAL']);
  const n = normalizeSocialObservation(redditRaw(), NOW);
  assert.equal(n.reject, true); assert.match(n.reason, /^RETENTION_NOT_APPROVED: REDDIT_OFFICIAL/);
  // even a hand-built "observation" that skipped normalization cannot become an event
  const built = socialObservationToEvent({ provider: 'REDDIT_OFFICIAL', providerKind: 'SOCIAL_FORUM', nativePostId: 't3_x', nativeAuthorId: 't2_x', text: 'x', knownAtTs: T, retrievedTs: T });
  assert.equal(built.event, null); assert.match(built.refused, /^RETENTION_NOT_APPROVED/);
  // the control: the same firewall leaves an approved provider untouched
  const bsky = normalizeSocialObservation({ ...redditRaw(), provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativePostId: 'at://did:plc:a/app.bsky.feed.post/1', nativeAuthorId: 'did:plc:a' }, NOW);
  assert.equal(bsky.ok, true);
});

test('REDDIT-FIREWALL-2 (§9). event -> Social validation: a shape-valid forged Reddit event is refused; a caller allowlist cannot broaden it', () => {
  const forged = forgedRedditEvent();
  const err = validateSocialEvent(forged);
  assert.match(err, /RETENTION_NOT_APPROVED/);
  assert.match(validateSocialEvent(forged, { socialProviderIds: ['REDDIT_OFFICIAL'] }), /RETENTION_NOT_APPROVED/, 'a caller-provided list can only narrow, never authorize');
  assert.match(validateSocialEvent(forged, { socialProviderIds: ['REDDIT_OFFICIAL', 'BLUESKY_OFFICIAL', 'FARCASTER_OFFICIAL', 'X_OFFICIAL'] }), /RETENTION_NOT_APPROVED/);
  // proof the forgery is otherwise well-formed: the identical construction for a permitted provider validates
  assert.equal(validateSocialEvent(farcasterEvent()), null);
  // the registry flag and the code constant are two independent locks
  assert.equal(socialProviderById('REDDIT_OFFICIAL').retentionProhibited, true); assert.ok(socialRetentionRefusal('REDDIT_OFFICIAL'));
  assert.equal(socialRetentionRefusal('BLUESKY_OFFICIAL'), null);
});

test('REDDIT-FIREWALL-3 (§9/§16). event -> Social replay: forged Reddit durable history fails closed, so it can never be hydrated as truth', () => {
  const r = replaySocialHistory([farcasterEvent(), forgedRedditEvent()]);
  assert.equal(r.ok, false); assert.match(r.error, /RETENTION_NOT_APPROVED/);
  const ok = replaySocialHistory([farcasterEvent()]); assert.equal(ok.ok, true); assert.equal(ok.observed, 1);
});

test('REDDIT-FIREWALL-4 (§9). ordinary Social settlement -> journal append callback: Reddit content is refused at intake and never reaches append', async () => {
  const appended = []; const j = memJournal(appended);
  const intake = socialIntake({ provider: { id: 'REDDIT_OFFICIAL' }, mapCommit: (m) => ({ raw: m }), filter: buildSocialFilter({ terms: ['BTC'] }), now: () => T, cursorOf: null, isDurable: () => false });
  const r = intake.offer({ ...redditRaw(), text: '$BTC synthetic' });
  assert.equal(r.outcome, 'rejected'); assert.match(r.reason, /^RETENTION_NOT_APPROVED/);
  assert.equal(intake.drain().length, 0, 'nothing queued for settlement');
  // an explicit append of a forged Reddit event through the journal contract is refused by the validator that every settle path runs first
  const forged = forgedRedditEvent();
  assert.match(validateSocialEvent(forged), /RETENTION_NOT_APPROVED/);
  await j.append([]); assert.equal(appended.length, 0);
});

// =====================================================================================
// §10–§12 — fixture-only preview adapter
// =====================================================================================
test('REDDIT-FIXTURE-1 (§10/§11). post/comment/crosspost mapping: native fullnames, distinct namespaces, community, relationships, engagement, canonical URL', () => {
  const p = redditThingToPreview(post(), { retrievedTs: T }).preview;
  assert.equal(p.provider, 'REDDIT_OFFICIAL'); assert.equal(p.kind, 'POST'); assert.equal(p.nativeThingId, 't3_fx1a2b'); assert.equal(p.durable, false);
  assert.deepEqual(p.community, { name: 'CryptoCurrency', id: 't5_2wlj3' }); assert.equal(p.title, 'Fixture: BTC listing rumor');
  assert.equal(p.originalText, 'synthetic  fixture   body', 'original text preserved'); assert.equal(p.previewText, 'synthetic fixture body', 'derived preview is deterministic and separate');
  assert.equal(p.relation, 'ORIGINAL'); assert.equal(p.parentNativeThingId, null); assert.deepEqual(p.engagement, { score: 12, upvotes: 14, replies: 3, upvoteRatio: 0.86 });
  assert.equal(p.canonicalUrl, 'https://www.reddit.com/r/CryptoCurrency/comments/fx1a2b/fixture/'); assert.equal(p.flags.isSelf, true);
  const c = redditThingToPreview(comment(), { retrievedTs: T }).preview;
  assert.equal(c.kind, 'COMMENT'); assert.equal(c.nativeThingId, 't1_fxc0m1'); assert.equal(c.relation, 'REPLY'); assert.equal(c.parentNativeThingId, 't3_fx1a2b'); assert.equal(c.linkNativeThingId, 't3_fx1a2b'); assert.equal(c.title, null);
  assert.equal(c.originalText, 'synthetic reply'); assert.equal(c.engagement.replies, null, 'unavailable engagement is null, never invented');
  const nested = redditThingToPreview(comment({ name: 't1_fxc0m2', parent_id: 't1_fxc0m1' }), { retrievedTs: T }).preview;
  assert.equal(nested.relation, 'REPLY'); assert.equal(nested.parentNativeThingId, 't1_fxc0m1');
  const x = redditThingToPreview(post({ name: 't3_fxxpost', crosspost_parent: 't3_fx1a2b' }), { retrievedTs: T }).preview;
  assert.equal(x.relation, 'CROSSPOST'); assert.equal(x.parentNativeThingId, 't3_fx1a2b');
  // ambiguity stays UNKNOWN; identities are never content hashes
  assert.equal(redditThingToPreview(comment({ parent_id: 'garbage' }), { retrievedTs: T }).preview.relation, 'UNKNOWN');
  assert.equal(redditThingToPreview(post({ crosspost_parent: 'nope' }), { retrievedTs: T }).preview.relation, 'UNKNOWN');
  assert.equal(redditThingToPreview(post({ name: undefined, id: 'fx1a2b' }), { retrievedTs: T }).preview.nativeThingId, 't3_fx1a2b', 'kind + id when the fullname is absent');
  assert.equal(redditThingToPreview({ kind: 't1', data: { name: 't3_fx1a2b', id: 'zz' } }, { retrievedTs: T }).preview.nativeThingId, 't1_zz', 'a post fullname never becomes a comment identity');
  for (const bad of [null, 5, { kind: 't5', data: {} }, { kind: 't3', data: { title: 'no id' } }, { kind: 't3', data: null }]) assert.equal(redditThingToPreview(bad, { retrievedTs: T }).skip, true);
});

test('REDDIT-FIXTURE-2 (§11). author identity: the immutable account fullname when supplied, otherwise UNKNOWN; a username is display metadata; nothing is fetched to fill it', () => {
  const p = redditThingToPreview(post(), { retrievedTs: T }).preview;
  assert.deepEqual(p.author, { nativeAuthorId: 't2_fxauthr', identityStatus: 'NATIVE_FULLNAME', displayName: 'fixture_user' });
  const noId = redditThingToPreview(post({ author_fullname: undefined }), { retrievedTs: T }).preview;
  assert.deepEqual(noId.author, { nativeAuthorId: null, identityStatus: 'UNKNOWN', displayName: 'fixture_user' }, 'no fictional native author id');
  const deleted = redditThingToPreview(post({ author: '[deleted]', author_fullname: undefined }), { retrievedTs: T }).preview;
  assert.deepEqual(deleted.author, { nativeAuthorId: null, identityStatus: 'UNKNOWN', displayName: null });
  assert.equal(redditThingToPreview(post({ author_fullname: 'fred' }), { retrievedTs: T }).preview.author.identityStatus, 'UNKNOWN', 'a non-fullname is not an identity');
  // the shared contract's author-identity law is untouched: UNKNOWN cannot be normalized as an author
  assert.equal(normalizeSocialObservation({ ...redditRaw(), provider: 'BLUESKY_OFFICIAL', providerKind: 'SOCIAL_MICROBLOG', nativeAuthorId: '' }, NOW).reject, true);
});

test('REDDIT-FIXTURE-3 (§11). clocks: created_utc is the source-declared clock under the existing quarantine law; malformed => UNKNOWN; future => FUTURE_QUARANTINED; retrieval is required and never Date.now()', () => {
  const ok = redditThingToPreview(post(), { retrievedTs: T }).preview;
  assert.equal(ok.sourceDeclaredTs, T - 60_000); assert.equal(ok.sourceCreatedTs, T - 60_000); assert.equal(ok.sourceClockStatus, 'TRUSTED'); assert.equal(ok.retrievedTs, T); assert.equal(ok.knownAtTs, T);
  assert.deepEqual({ sourceCreatedTs: ok.sourceCreatedTs, sourceClockStatus: ok.sourceClockStatus, sourceClockSkewMs: ok.sourceClockSkewMs }, classifySourceClock({ sourceDeclaredTs: T - 60_000, retrievedTs: T }), 'the SAME policy as every other social ear');
  const future = redditThingToPreview(post({ created_utc: (T + 3_600_000) / 1000 }), { retrievedTs: T }).preview;
  assert.equal(future.sourceClockStatus, 'FUTURE_QUARANTINED'); assert.equal(future.sourceCreatedTs, null); assert.equal(future.sourceDeclaredTs, T + 3_600_000, 'declared value preserved, never trusted'); assert.equal(future.sourceClockSkewMs, 3_600_000);
  for (const bad of ['yesterday', -5, NaN, undefined, 1e12]) { const p = redditThingToPreview(post({ created_utc: bad }), { retrievedTs: T }).preview; assert.equal(p.sourceDeclaredTs, null); assert.equal(p.sourceClockStatus, 'UNKNOWN'); }
  assert.equal(redditThingToPreview(post(), {}).skip, true, 'no acquisition clock => no preview (never Date.now())');
  assert.equal(ok.providerEventSeq, null); assert.equal(ok.nativeVersionId, null, 'no provider sequence or version id is invented');
});

test('REDDIT-FIXTURE-4 (§12). edits and deletions: provider-supplied edit state without a version id; a removal reveals that content is gone but never reconstructs text or infers why', () => {
  const edited = redditThingToPreview(post({ edited: (T - 10_000) / 1000 }), { retrievedTs: T }).preview;
  assert.equal(edited.editState, 'EDITED'); assert.equal(edited.editedTs, T - 10_000); assert.equal(edited.nativeVersionId, null);
  const before = redditThingToPreview(post(), { retrievedTs: T }).preview;
  const removed = redditThingToPreview(post({ selftext: '[removed]', removed_by_category: 'moderator' }), { retrievedTs: T }).preview;
  assert.equal(removed.contentAvailable, false); assert.equal(removed.originalText, null); assert.equal(removed.previewText, null); assert.equal(removed.editState, 'TOMBSTONED');
  assert.deepEqual(removed.removal, { gone: true, providerCategory: 'moderator', reason: 'moderator', textReconstructed: false });
  assert.equal(removed.nativeThingId, before.nativeThingId, 'same thing, in-memory before/after');
  const deleted = redditThingToPreview(comment({ body: '[deleted]', author: '[deleted]', author_fullname: undefined }), { retrievedTs: T }).preview;
  assert.equal(deleted.editState, 'DELETED'); assert.equal(deleted.originalText, null); assert.deepEqual(deleted.removal, { gone: true, providerCategory: null, reason: 'UNKNOWN', textReconstructed: false }, 'no evidence => no inferred reason');
  assert.equal(deleted.author.identityStatus, 'UNKNOWN');
  const unknownCat = redditThingToPreview(post({ selftext: '[removed]', removed_by_category: 'made_up' }), { retrievedTs: T }).preview;
  assert.equal(unknownCat.removal.providerCategory, null); assert.equal(unknownCat.removal.reason, 'UNKNOWN');
  assert.ok(!JSON.stringify(removed).includes('synthetic'), 'the pre-removal fixture text is not carried into the removed preview');
});

// =====================================================================================
// §13 — pure request/limit helpers; §16 — no live path, no scraping, no authority
// =====================================================================================
test('REDDIT-REQUEST (§13). documented host/path, descriptive User-Agent shape, credential named not valued, rate headers bounded, malformed headers => zero allowance', () => {
  const ua = redditUserAgent({ appId: 'serpent-fixture', version: '0.0.1', owner: 'fixture_owner' });
  assert.equal(ua, 'nodejs:serpent-fixture:0.0.1 (by /u/fixture_owner)'); assert.equal(redditUserAgent({ appId: 'bad app', version: '1', owner: 'x' }), null);
  const req = redditListingRequest({ subreddit: 'CryptoCurrency', listing: 'new', limit: 50, after: 't3_fx1a2b', userAgent: ua });
  assert.equal(req.host, 'oauth.reddit.com'); assert.equal(req.path, '/r/CryptoCurrency/new'); assert.deepEqual(req.query, { limit: 50, raw_json: 1, after: 't3_fx1a2b' }); assert.equal(req.sent, false);
  assert.deepEqual(req.headers.Authorization, { scheme: 'Bearer', tokenEnv: 'REDDIT_ACCESS_TOKEN', value: null }, 'no credential value, ever');
  assert.equal(redditListingRequest({ subreddit: 'bad sub', userAgent: ua }).error, 'subreddit invalid'); assert.equal(redditListingRequest({ subreddit: 'ok_sub', limit: 500, userAgent: ua }).error, 'limit must be 1..100'); assert.ok(redditListingRequest({ subreddit: 'ok_sub', userAgent: 'curl/8' }).error);
  assert.deepEqual(REDDIT_OFFICIAL.hosts, ['oauth.reddit.com', 'www.reddit.com']); assert.equal(REDDIT_OFFICIAL.tokenPath, '/api/v1/access_token');
  assert.deepEqual(parseRedditRateHeaders({ 'x-ratelimit-remaining': '96.0', 'x-ratelimit-used': '4', 'x-ratelimit-reset': '412' }), { remaining: 96, used: 4, resetSeconds: 412 });
  for (const h of [null, {}, { 'x-ratelimit-remaining': 'lots' }, { 'x-ratelimit-remaining': '-1', 'x-ratelimit-used': '0', 'x-ratelimit-reset': '1' }, { 'x-ratelimit-remaining': '1e9', 'x-ratelimit-used': '0', 'x-ratelimit-reset': '1' }]) assert.equal(parseRedditRateHeaders(h), null);
  const good = { 'x-ratelimit-remaining': '96', 'x-ratelimit-used': '4', 'x-ratelimit-reset': '412' };
  assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 30, headers: good }).allowance, 30, 'the strictest of approved scope, configured cap, observed remaining');
  assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 100, headers: { ...good, 'x-ratelimit-remaining': '7' } }).allowance, 7);
  assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 100, headers: { 'x-ratelimit-remaining': 'unlimited' } }).allowance, 0, 'malformed headers never create allowance');
  assert.equal(redditRateAllowance({ configuredQpm: 100, headers: good }).allowance, 0, 'no approved scope => nothing; the published 100 QPM is never a default');
  assert.equal(REDDIT_OFFICIAL.freeEligibleQpmReference, 100);
});

test('REDDIT-NO-LIVE (§3/§16). the Reddit surface is exactly one fixture-only file: no fetch, socket, timer loop, OAuth exchange, scraping, model, or execution import — even with permissive flags', () => {
  const src = readFileSync(path.join(REPO, 'rumor2/social-reddit.js'), 'utf8');
  for (const forbidden of ['fetch(', 'WebSocket', 'setInterval', 'setTimeout', 'http.request', 'https.request', 'node:http', 'node:https', 'node:net', 'child_process', 'cheerio', 'jsdom', 'puppeteer', 'playwright', 'access_token=', 'grant_type', 'Date.now()', 'randomUUID', 'localStorage', 'writeFile']) assert.ok(!src.includes(forbidden), `social-reddit.js must not contain ${forbidden}`);
  const codeOnly = src.replace(/\/\/.*$/gm, '');
  for (const authority of [/\bledger\b/i, /\bstrike\b/i, /\bexecut(e|ion)\b/i, /\border(s|Book)?\b/i, /\bsocrates\b/i, /\battention\b/i, /\bhyped\b/i, /\beligib/i, /\banthropic\b/i, /\bopenai\b/i, /\bcompletions?\b/i, /\bmessages\.create\b/, /\bpaperTrade|placeOrder|submitOrder\b/]) assert.ok(!authority.test(codeOnly), `no ${authority} token in code`);
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./social.js'], 'imports only the shared social contract — no model, execution, or network module');
  // permissive-looking flags change nothing: there is no transport to enable
  const a = evaluateRedditAccess({ record: RECORD({ retentionCompatibility: 'COMPATIBLE_REVIEWED' }), env: { ...CREDS, REDDIT_ENABLED: 'true', RUMOR2_SOCIAL_REDDIT_ENABLED: 'true', REDDIT_COMMERCIAL_APPROVED: 'true', REDDIT_LIVE: 'true' }, nowMs: T });
  assert.equal(a.liveAllowed, false); assert.equal(a.durableContentAllowed, false);
  assert.equal(REDDIT_FOUNDATION.fixtureOnly, true);
  // the collector has no Reddit runtime wiring at all
  assert.ok(!/reddit/i.test(readFileSync(path.join(REPO, 'rumor2/collector.js'), 'utf8')), 'collector never mentions Reddit');
});

// =====================================================================================
// READINESS CONSISTENCY + RATE-HEADER VALIDATION (SOCIAL-3 correction)
// =====================================================================================
const READY = (over = {}) => RECORD({ permittedUses: ['RETRIEVAL'], validUntil: null, retentionCompatibility: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-06', ...over });
const noAuthority = (a) => { assert.equal(a.liveAllowed, false); assert.equal(a.liveStatus, 'DISABLED'); assert.equal(a.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(a.durableContentAllowed, false); assert.equal(a.durableAuthorIdentityAllowed, false); };
const consistent = (a) => { if (a.blockers.length > 0) assert.equal(a.activationPrerequisitesMet, false, `blockers ${JSON.stringify(a.blockers)} cannot coexist with readiness`); if (a.activationPrerequisitesMet) assert.deepEqual([...a.blockers], []); };

test('READINESS-A1/A2 (RED A). a known clock with a valid attestation reviewed in the past and no supplied expiry is ready-on-paper but never live; the SAME record without a clock is not ready, with a precise reason', () => {
  const ok = evaluateRedditAccess({ record: READY(), env: CREDS, nowMs: T });
  assert.equal(ok.approvalStatus, 'OPERATOR_ATTESTED'); assert.equal(ok.activationPrerequisitesMet, true); assert.deepEqual([...ok.blockers], []); assert.equal(ok.prerequisites.clock, true); assert.equal(ok.prerequisites.review, true); noAuthority(ok);
  const none = evaluateRedditAccess({ record: READY(), env: CREDS });
  assert.equal(none.activationPrerequisitesMet, false, 'RED A: readiness cannot be true beside CLOCK_UNAVAILABLE'); assert.ok(none.blockers.includes('CLOCK_UNAVAILABLE')); assert.equal(none.prerequisites.clock, false);
  assert.equal(none.approvalStatus, 'NOT_VERIFIED', 'an attestation cannot be evaluated without a clock'); consistent(none); noAuthority(none);
  // present-time review is fine; a null validUntil is "no supplied expiry", never an invented one
  const today = evaluateRedditAccess({ record: READY({ reviewedOn: '2026-09-06T12:00:00Z' }), env: CREDS, nowMs: T }); assert.equal(today.activationPrerequisitesMet, true); assert.equal(today.approvalStatus, 'OPERATOR_ATTESTED');
});

test('READINESS-A3. clock null, NaN, Infinity, string, negative, or out-of-range: not ready, no coercion, no wall-clock substitution', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '1788696000000', String(T), -1, 0, 1.5, 4102444800000 * 10, -T, true, {}, [T]]) {
    const a = evaluateRedditAccess({ record: READY(), env: CREDS, nowMs: bad });
    assert.equal(a.activationPrerequisitesMet, false, `clock ${String(bad)}`); assert.ok(a.blockers.includes('CLOCK_UNAVAILABLE') || a.blockers.includes('CLOCK_INVALID'), `clock ${String(bad)} => ${a.blockers}`);
    assert.equal(a.approvalStatus, 'NOT_VERIFIED'); consistent(a); noAuthority(a);
  }
  const src = readFileSync(path.join(REPO, 'rumor2/social-reddit.js'), 'utf8'); assert.ok(!src.includes('Date.now'), 'no wall-clock substitution inside the pure helper');
});

test('READINESS-A4/A5 (RED A). a review dated after the evaluation clock is not ready with an explicit review-time blocker and is never rewritten; an invalid review date is rejected consistently', () => {
  const future = evaluateRedditAccess({ record: READY({ reviewedOn: '2056-01-01' }), env: CREDS, nowMs: T });
  assert.equal(future.activationPrerequisitesMet, false, 'RED A: a review that has not happened cannot establish reviewed status'); assert.ok(future.blockers.includes('REVIEW_DATE_IN_FUTURE')); assert.equal(future.prerequisites.review, false);
  assert.equal(future.approvalStatus, 'NOT_VERIFIED'); consistent(future); noAuthority(future);
  const soon = evaluateRedditAccess({ record: READY({ reviewedOn: new Date(T + 1000).toISOString() }), env: CREDS, nowMs: T }); assert.ok(soon.blockers.includes('REVIEW_DATE_IN_FUTURE'), 'one second ahead is still the future');
  for (const bad of ['yesterday', '2026-13-45', '', 42, {}]) { const a = evaluateRedditAccess({ record: READY({ reviewedOn: bad }), env: CREDS, nowMs: T }); assert.equal(a.activationPrerequisitesMet, false); assert.ok(a.blockers.some((b) => b.startsWith('APPROVAL_RECORD_INVALID')), `reviewedOn ${String(bad)}`); consistent(a); }
  const absent = evaluateRedditAccess({ record: READY({ reviewedOn: null }), env: CREDS, nowMs: T }); assert.equal(absent.activationPrerequisitesMet, true, 'an absent review date is not a future one');
});

test('READINESS-A6..A10. expiry, status, scope, agreement, retention, retrieval, credential cases stay not ready; in the whole matrix a blocker implies not-ready and every case keeps live/durable false', () => {
  const matrix = [
    ['expired', READY({ validUntil: '2026-09-05T00:00:00Z' }), CREDS, 'APPROVAL_EXPIRED'],
    ['revoked', READY({ status: 'REVOKED' }), CREDS, 'APPROVAL_REVOKED'], ['denied', READY({ status: 'DENIED' }), CREDS, 'APPROVAL_DENIED'], ['pending', READY({ status: 'PENDING' }), CREDS, 'APPROVAL_PENDING'],
    ['wrong app', READY({ application: 'OTHER' }), CREDS, 'APPROVAL_OUT_OF_SCOPE'], ['wrong use case', READY({ useCaseVersion: 'v0' }), CREDS, 'APPROVAL_OUT_OF_SCOPE'],
    ['unclassified', READY({ classification: 'UNRESOLVED' }), CREDS, 'APPROVAL_WITHOUT_CLASSIFICATION'],
    ['agreement unresolved', READY({ additionalAgreement: 'UNRESOLVED' }), CREDS, 'ADDITIONAL_AGREEMENT_UNRESOLVED'], ['agreement unsatisfied', READY({ classification: 'REQUIRES_ADDITIONAL_TERMS', additionalAgreement: 'REQUIRED' }), CREDS, 'ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED'],
    ['retention unresolved', READY({ retentionCompatibility: 'UNRESOLVED' }), CREDS, 'RETENTION_COMPATIBILITY_UNRESOLVED'], ['retention incompatible', READY({ retentionCompatibility: 'INCOMPATIBLE' }), CREDS, 'RETENTION_INCOMPATIBLE'],
    ['retrieval missing', READY({ permittedUses: ['PERSONAL_RESEARCH'] }), CREDS, 'RETRIEVAL_NOT_PERMITTED'], ['credential missing', READY(), {}, 'CREDENTIAL_MISSING'],
    ['future review', READY({ reviewedOn: '2056-01-01' }), CREDS, 'REVIEW_DATE_IN_FUTURE'], ['no record', null, CREDS, 'APPROVAL_RECORD_MISSING'],
  ];
  for (const [label, record, env, blocker] of matrix) {
    const a = evaluateRedditAccess({ record, env, nowMs: T });
    assert.equal(a.activationPrerequisitesMet, false, label); assert.ok(a.blockers.some((b) => b.startsWith(blocker)), `${label}: expected ${blocker} in ${a.blockers}`); consistent(a); noAuthority(a);
  }
  // fully permissive attestations (every classification path, satisfied agreement, reviewed retention) are ready-on-paper only
  for (const rec of [READY(), READY({ classification: 'REQUIRES_ADDITIONAL_TERMS', additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: true }), READY({ classification: 'COMMERCIAL', additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: true, permittedUses: [...REDDIT_PERMITTED_USES] })]) {
    const a = evaluateRedditAccess({ record: rec, env: { ...CREDS, REDDIT_LIVE: 'true', RUMOR2_SOCIAL_REDDIT_ENABLED: 'true' }, nowMs: T });
    assert.equal(a.activationPrerequisitesMet, true); consistent(a); noAuthority(a); assert.equal(a.evidence, 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF');
  }
  // an informational note is an advisory, never a blocker that readiness contradicts
  const described = evaluateRedditAccess({ record: READY(), env: CREDS, nowMs: T, description: 'private single-user prototype' });
  assert.equal(described.activationPrerequisitesMet, true); assert.deepEqual([...described.blockers], []); assert.ok(described.advisories.includes('SELF_DESCRIPTION_IS_NOT_PERMISSION')); noAuthority(described);
});

test('RATE-HEADERS (RED B). only documented decimal header strings (or finite non-negative numeric fixtures) are accepted; booleans, arrays, objects, functions, null, empty, whitespace, NaN, Infinity, negatives, and out-of-bound values are rejected in every header, and malformed input never yields allowance', () => {
  const H = (r, u, s) => ({ 'x-ratelimit-remaining': r, 'x-ratelimit-used': u, 'x-ratelimit-reset': s });
  // RED B
  assert.equal(parseRedditRateHeaders(H(true, false, [])), null, 'RED B: booleans/arrays coerced to 1/0/0 at baseline');
  assert.equal(parseRedditRateHeaders(H([], [], [])), null);
  assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 100, headers: H(true, false, []) }).allowance, 0);
  // documented decimal forms + valid zero remaining
  assert.deepEqual(parseRedditRateHeaders(H('96.0', '4', '412')), { remaining: 96, used: 4, resetSeconds: 412 });
  assert.deepEqual(parseRedditRateHeaders(H('0', '100', '1')), { remaining: 0, used: 100, resetSeconds: 1 }); assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 100, headers: H('0', '100', '1') }).allowance, 0);
  assert.deepEqual(parseRedditRateHeaders(H(' 12.5 ', '1', '2')), { remaining: 12, used: 1, resetSeconds: 2 }, 'surrounding whitespace tolerated; remaining rounds DOWN');
  assert.deepEqual(parseRedditRateHeaders(H(96, 4, 412)), { remaining: 96, used: 4, resetSeconds: 412 }, 'finite numeric fixture representation');
  assert.deepEqual(parseRedditRateHeaders({ 'X-RateLimit-Remaining': '5', 'X-RATELIMIT-USED': '1', 'x-RateLimit-Reset': '9' }), { remaining: 5, used: 1, resetSeconds: 9 }, 'case-insensitive lookup on plain objects');
  assert.deepEqual(parseRedditRateHeaders(new Headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-used': '3', 'x-ratelimit-reset': '30' })), { remaining: 7, used: 3, resetSeconds: 30 }, 'native Headers fixture');
  // each malformed type in each of the three headers
  const bads = [true, false, [], ['96'], {}, { v: 1 }, () => 96, null, undefined, '', '   ', NaN, Infinity, -Infinity, -1, '-1', '1e3', '0x10', 'Infinity', 'NaN', '96,0', '96.', '.5', '+5', 1e7, '10000000', 12345678, Symbol('x'), 96n];
  for (const bad of bads) for (const slot of [0, 1, 2]) {
    const good = ['96', '4', '412']; good[slot] = bad;
    const h = H(...good);
    assert.equal(parseRedditRateHeaders(h), null, `slot ${slot} value ${typeof bad === 'symbol' ? 'symbol' : String(bad)} (${typeof bad}) must be rejected`);
    assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 100, headers: h }).allowance, 0);
  }
  // missing headers and missing caps
  assert.equal(parseRedditRateHeaders(H('96', '4')), null); assert.equal(parseRedditRateHeaders({}), null); assert.equal(parseRedditRateHeaders(null), null); assert.equal(parseRedditRateHeaders('96'), null);
  assert.equal(redditRateAllowance({ headers: H('96', '4', '412') }).allowance, 0, 'no caps => zero; the published 100 QPM is never a default');
  assert.equal(redditRateAllowance({ approvedQpm: 100, headers: H('96', '4', '412') }).allowance, 0); assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 0, headers: H('96', '4', '412') }).allowance, 0);
  assert.equal(redditRateAllowance({ approvedQpm: 100, configuredQpm: 30, headers: H('96.9', '4', '412') }).allowance, 30);
});
