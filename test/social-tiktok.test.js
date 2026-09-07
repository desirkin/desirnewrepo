// SOCIAL-4E Stage 2 — TikTok product foundation. Pure, non-live. Asserts CORRECT
// behaviour: the registry decision (INACTIVE + OPERATOR_REVIEW_PENDING) is preserved;
// products cannot impersonate each other; a token cannot supply affiliation or
// approval; missing clocks/metrics stay unknown; documented epoch seconds are parsed
// only as seconds; no raw content reaches a persistent path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIKTOK_PROVIDER_ID, TIKTOK_FOUNDATION, TIKTOK_DECISION, TIKTOK_ROUTES, TIKTOK_ROUTE_IDS, TIKTOK_ROUTE_SUMMARY_KEYS, TIKTOK_PREREQUISITES, TIKTOK_EVIDENCE_CLASSES, TIKTOK_DOCUMENTATION,
  TIKTOK_APPLICATION_ID, TIKTOK_USE_CASE_VERSION, TIKTOK_USE_CASE, TIKTOK_EPOCH_SECONDS_MIN, TIKTOK_EPOCH_SECONDS_MAX, TIKTOK_CLOCK_STATUSES,
  tiktokRoute, tiktokRouteSummary, tiktokRouteRecordFromEnv, validateTiktokRouteRecord, tiktokCredentialsPresent, evaluateTiktokRouteAccess, tiktokEpochSeconds, tiktokVideoToPreview,
} from '../rumor2/social-tiktok.js';
import { socialProviderById } from '../rumor2/social-registry.js';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent } from '../rumor2/social-settle.js';

const NOW = Date.parse('2026-09-07T12:00:00Z');
const ENV = { TIKTOK_CLIENT_KEY: 'present', TIKTOK_CLIENT_SECRET: 'present' };
const record = (over = {}) => ({
  route: 'RESEARCH', approvalRef: 'tiktok/research/2026-09', status: 'ATTESTED', application: TIKTOK_APPLICATION_ID, useCaseVersion: TIKTOK_USE_CASE_VERSION,
  attested: [...TIKTOK_ROUTES.RESEARCH.eligibilityRequirements], permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH'],
  additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: true, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01',
  ...over,
});
const readyFor = (routeId) => record({ route: routeId, attested: [...tiktokRoute(routeId).eligibilityRequirements] });
const research = (over = {}) => ({ id: '7123456789012345678', create_time: 1788778800, username: 'creator_name', region_code: 'US', video_description: 'watch $FOO #crypto', like_count: 12, comment_count: 3, share_count: 1, view_count: 900, favorites_count: 4, hashtag_names: ['crypto', 'foo'], video_duration: 30, ...over });
const display = (over = {}) => ({ id: '7123456789012345678', create_time: 1788778800, title: 'My video', video_description: 'own upload', share_url: 'https://www.tiktok.com/@me/video/7123456789012345678', like_count: 2, comment_count: 0, share_count: 0, view_count: 50, duration: 15, ...over });
const isDeepFrozen = (o) => o === null || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(isDeepFrozen));

test('TIKTOK-1. the registry decision is preserved verbatim, the foundation is fixture-only, and the products are the registry\'s three routes', () => {
  const reg = socialProviderById('TIKTOK_PUBLIC');
  assert.equal(TIKTOK_PROVIDER_ID, reg.id); assert.equal(reg.implemented, false); assert.equal(reg.durable, false); assert.equal(reg.accessState, 'NOT_AUTHORIZED');
  assert.equal(TIKTOK_DECISION.currentDecision, reg.currentDecision); assert.equal(TIKTOK_DECISION.decisionStatus, reg.decisionStatus);
  assert.equal(TIKTOK_DECISION.currentDecision, 'INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED'); assert.equal(TIKTOK_DECISION.decisionStatus, 'OPERATOR_REVIEW_PENDING');
  assert.equal(TIKTOK_DECISION.applicationMade, false); assert.equal(TIKTOK_DECISION.applicationDenied, false); assert.equal(TIKTOK_DECISION.permanentExclusionApproved, false);
  for (const [k, v] of Object.entries(TIKTOK_FOUNDATION)) assert.equal(v, k === 'fixtureOnly', `TIKTOK_FOUNDATION.${k}`);
  assert.deepEqual([...TIKTOK_ROUTE_IDS].sort(), Object.keys(reg.routes).sort(), 'route ids are exactly the registry route keys');
  assert.equal(TIKTOK_USE_CASE.platformClassification, 'UNRESOLVED'); assert.equal(TIKTOK_USE_CASE.financialObjectiveDisclosed, true);
  for (const id of TIKTOK_ROUTE_IDS) {
    const r = TIKTOK_ROUTES[id]; const s = tiktokRouteSummary(id);
    assert.equal(r.id, id); assert.equal(r.registryRoute, id);
    for (const k of TIKTOK_ROUTE_SUMMARY_KEYS) assert.ok(k in s, `${id} answers ${k}`);
    assert.ok(TIKTOK_EVIDENCE_CLASSES.includes(r.evidenceClass)); for (const q of r.eligibilityRequirements) assert.ok(TIKTOK_PREREQUISITES.includes(q));
    assert.equal(r.eligibilityEstablishedForOperator, 'NOT_ESTABLISHED'); assert.equal(r.liveAllowed, false); assert.equal(r.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(r.measuredLatency, 'UNKNOWN'); assert.equal(r.productionObservation, 'UNOBSERVED');
    assert.equal(r.currentDecision, TIKTOK_DECISION.currentDecision); assert.equal(r.decisionStatus, 'OPERATOR_REVIEW_PENDING');
    assert.ok(isDeepFrozen(s)); for (const d of s.documentation) assert.equal(d.accessedOn, '2026-09-07');
  }
  assert.deepEqual(TIKTOK_ROUTES.RESEARCH.indexingDelay, { maxHours: 48, basis: 'T1' }); assert.deepEqual(TIKTOK_ROUTES.RESEARCH.metricRefreshDelay, { maxDays: 10, basis: 'T1' });
  assert.equal(TIKTOK_ROUTES.DISPLAY.indexingDelay, null, 'the 48 h delay is route-specific, never generalized');
  assert.equal(TIKTOK_ROUTES.DISPLAY.evidenceClass, 'OWN_VIDEOS_ONLY'); assert.equal(TIKTOK_ROUTES.COMMERCIAL_CONTENT.evidenceClass, 'COMMERCIAL_DATASET'); assert.equal(TIKTOK_ROUTES.COMMERCIAL_CONTENT.previewSupport, 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED');
  assert.ok(TIKTOK_ROUTES.RESEARCH.eligibilityRequirements.includes('ELIGIBLE_INSTITUTION_AFFILIATION') && TIKTOK_ROUTES.RESEARCH.eligibilityRequirements.includes('ETHICS_REVIEW'));
  assert.equal(tiktokRoute('RESEARCH_API'), null); assert.equal(tiktokRouteSummary('__proto__'), null);
  assert.ok(Object.values(TIKTOK_DOCUMENTATION).every((d) => d.status === 'VERIFIED'));
});

test('TIKTOK-2. the record is closed and route-bound; the env reader treats empty as unsupplied; credentials are booleans only', () => {
  assert.equal(validateTiktokRouteRecord(record()), null);
  assert.match(validateTiktokRouteRecord(record({ route: 'RESEARCH_API' })), /unknown route/);
  assert.match(validateTiktokRouteRecord(record({ attested: ['CLIENT_KEY_PRESENT'] })), /prerequisite vocabulary/);
  assert.match(validateTiktokRouteRecord(record({ status: 'APPROVED' })), /unknown status/);
  assert.match(validateTiktokRouteRecord(record({ extra: true })), /undeclared field/);
  assert.match(validateTiktokRouteRecord(record({ reviewedOn: '2026-09-01T00:00:00' })), /reviewedOn/);
  assert.equal(tiktokRouteRecordFromEnv({ RUMOR2_SOCIAL_TIKTOK_ROUTE_ID: '' }), null);
  const r = tiktokRouteRecordFromEnv({ RUMOR2_SOCIAL_TIKTOK_ROUTE_ID: 'DISPLAY', RUMOR2_SOCIAL_TIKTOK_ROUTE_STATUS: 'PENDING', RUMOR2_SOCIAL_TIKTOK_ROUTE_APPLICATION: TIKTOK_APPLICATION_ID, RUMOR2_SOCIAL_TIKTOK_ROUTE_USE_CASE_VERSION: TIKTOK_USE_CASE_VERSION, RUMOR2_SOCIAL_TIKTOK_ROUTE_ATTESTED: 'DEVELOPER_ACCOUNT' });
  assert.equal(validateTiktokRouteRecord(r), null); assert.deepEqual(r.attested, ['DEVELOPER_ACCOUNT']); assert.equal(r.retentionIdentity, 'UNRESOLVED');
  assert.equal(tiktokCredentialsPresent(ENV, 'RESEARCH'), true); assert.equal(tiktokCredentialsPresent({ TIKTOK_CLIENT_KEY: 'k' }, 'RESEARCH'), false); assert.equal(tiktokCredentialsPresent(ENV, 'nope'), false);
});

test('TIKTOK-3 (Stage-2 gate). products cannot impersonate each other; a token cannot supply affiliation or approval; readiness never grants a live path', () => {
  for (const bound of TIKTOK_ROUTE_IDS) for (const target of TIKTOK_ROUTE_IDS) {
    const e = evaluateTiktokRouteAccess({ routeId: target, record: readyFor(bound), env: ENV, nowMs: NOW });
    assert.equal(e.currentDecision, TIKTOK_DECISION.currentDecision); assert.equal(e.decisionStatus, 'OPERATOR_REVIEW_PENDING');
    assert.equal(e.liveAllowed, false); assert.equal(e.liveStatus, 'DISABLED'); assert.equal(e.durableContentAllowed, false); assert.equal(e.durableAuthorIdentityAllowed, false);
    if (bound === target) { assert.deepEqual(e.blockers, [], `${target} ready`); assert.equal(e.activationPrerequisitesMet, true); assert.equal(e.eligibilityEstablishedForOperator, 'OPERATOR_ATTESTED'); assert.ok(isDeepFrozen(e)); }
    else { assert.equal(e.approvalStatus, 'OUT_OF_SCOPE', `${bound} → ${target}`); assert.ok(e.blockers.some((b) => b.startsWith('APPROVAL_ROUTE_MISMATCH'))); assert.equal(e.activationPrerequisitesMet, false); }
  }
  // a present client key/secret with no record, or with a record lacking affiliation, is configuration only
  const keyOnly = evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record: null, env: ENV, nowMs: NOW });
  assert.ok(keyOnly.blockers.includes('APPROVAL_RECORD_MISSING')); assert.equal(keyOnly.credentialPresent, true); assert.ok(keyOnly.advisories.includes('CREDENTIAL_IS_CONFIGURATION_NOT_AFFILIATION_OR_APPROVAL')); assert.equal(keyOnly.eligibilityEstablishedForOperator, 'NOT_ESTABLISHED');
  const noAff = evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record: record({ attested: ['DEVELOPER_ACCOUNT'] }), env: ENV, nowMs: NOW });
  for (const q of ['ELIGIBLE_INSTITUTION_AFFILIATION', 'NON_COMMERCIAL_RESEARCH_BASIS', 'ETHICS_REVIEW', 'PROJECT_APPROVAL']) assert.ok(noAff.blockers.includes(`PREREQUISITE_NOT_ATTESTED: ${q}`), q);
  assert.equal(noAff.activationPrerequisitesMet, false); assert.ok(noAff.advisories.includes('ROUTE_INDEXING_DELAY_UP_TO_48H'));
  // the Display and Commercial products say what they are
  assert.ok(evaluateTiktokRouteAccess({ routeId: 'DISPLAY', record: null, env: {}, nowMs: NOW }).advisories.includes('NOT_ORGANIC_DISCOVERY: OWN_VIDEOS_ONLY'));
  assert.ok(evaluateTiktokRouteAccess({ routeId: 'COMMERCIAL_CONTENT', record: null, env: {}, nowMs: NOW }).advisories.includes('NOT_ORGANIC_DISCOVERY: COMMERCIAL_DATASET'));
  // independent blockers
  const cases = [
    [{ nowMs: null }, 'CLOCK_UNAVAILABLE'], [{ nowMs: -1 }, 'CLOCK_INVALID'], [{ env: {} }, 'CREDENTIAL_MISSING'],
    [{ record: record({ status: 'PENDING' }) }, 'APPROVAL_PENDING'], [{ record: record({ status: 'DENIED' }) }, 'APPROVAL_DENIED'], [{ record: record({ status: 'REVOKED' }) }, 'APPROVAL_REVOKED'],
    [{ record: record({ application: 'OTHER' }) }, /APPROVAL_OUT_OF_SCOPE/], [{ record: record({ validUntil: '2026-09-07T11:59:59Z' }) }, 'APPROVAL_EXPIRED'], [{ record: record({ validUntil: '2026-09-07' }) }, 'VALID_UNTIL_PRECISION_UNRESOLVED'],
    [{ record: record({ reviewedOn: '2026-09-08' }) }, 'REVIEW_DATE_IN_FUTURE'], [{ record: record({ additionalAgreementSatisfied: false }) }, 'ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED'],
    [{ record: record({ retentionContent: 'UNRESOLVED' }) }, 'RETENTION_CONTENT_UNRESOLVED'], [{ record: record({ retentionIdentity: 'INCOMPATIBLE' }) }, 'RETENTION_IDENTITY_INCOMPATIBLE'], [{ record: record({ permittedUses: ['PERSONAL_RESEARCH'] }) }, 'RETRIEVAL_NOT_PERMITTED'],
  ];
  for (const [over, expected] of cases) {
    const e = evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record: record(), env: ENV, nowMs: NOW, ...over });
    assert.ok(e.blockers.some((b) => (expected instanceof RegExp ? expected.test(b) : b === expected)), `${JSON.stringify(over)} → ${expected}; got ${e.blockers}`);
    assert.equal(e.activationPrerequisitesMet, false);
  }
  const unknown = evaluateTiktokRouteAccess({ routeId: 'ORGANIC_FIREHOSE', record: record(), env: ENV, nowMs: NOW });
  assert.ok(unknown.blockers.includes('ROUTE_UNKNOWN')); assert.equal(unknown.currentDecision, TIKTOK_DECISION.currentDecision);
  assert.ok(!JSON.stringify(evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record: record(), env: ENV, nowMs: NOW })).includes('present'), 'no credential value leaks');
});

test('TIKTOK-4. documented epoch SECONDS are parsed only as seconds with a range check — never rescaled, never parsed from strings, never rounded', () => {
  assert.deepEqual(tiktokEpochSeconds(1788778800), { declared: 1788778800, unit: 'UNIX_SECONDS_DOCUMENTED', status: 'INSTANT', instantMs: 1788778800000 });
  assert.equal(tiktokEpochSeconds(1788778800000).status, 'UNSUPPORTED_RANGE', 'a millisecond-magnitude value is out of the documented-unit window, not divided by 1000');
  assert.equal(tiktokEpochSeconds(1788778800000).instantMs, null);
  assert.equal(tiktokEpochSeconds(TIKTOK_EPOCH_SECONDS_MIN - 1).status, 'UNSUPPORTED_RANGE'); assert.equal(tiktokEpochSeconds(TIKTOK_EPOCH_SECONDS_MAX + 1).status, 'UNSUPPORTED_RANGE'); assert.equal(tiktokEpochSeconds(0).status, 'UNSUPPORTED_RANGE'); assert.equal(tiktokEpochSeconds(-1).status, 'UNSUPPORTED_RANGE');
  assert.equal(tiktokEpochSeconds(TIKTOK_EPOCH_SECONDS_MIN).status, 'INSTANT'); assert.equal(tiktokEpochSeconds(TIKTOK_EPOCH_SECONDS_MAX).status, 'INSTANT');
  assert.equal(tiktokEpochSeconds('1788778800').status, 'TYPE_MISMATCH'); assert.equal(tiktokEpochSeconds('2026-09-07T00:00:00+08:00').status, 'TYPE_MISMATCH'); assert.equal(tiktokEpochSeconds('2026-09-07').status, 'TYPE_MISMATCH');
  assert.equal(tiktokEpochSeconds(1788778800.5).status, 'NOT_AN_INTEGER'); assert.equal(tiktokEpochSeconds(Number.NaN).status, 'NOT_AN_INTEGER'); assert.equal(tiktokEpochSeconds(Infinity).status, 'NOT_AN_INTEGER');
  assert.equal(tiktokEpochSeconds(undefined).status, 'ABSENT'); assert.equal(tiktokEpochSeconds(null).status, 'ABSENT');
  assert.equal(tiktokEpochSeconds(true).status, 'TYPE_MISMATCH'); assert.equal(tiktokEpochSeconds({ seconds: 1 }).status, 'TYPE_MISMATCH');
  for (const v of [1788778800, '1', 1.5, undefined, 1e15]) assert.ok(TIKTOK_CLOCK_STATUSES.includes(tiktokEpochSeconds(v).status));
  assert.equal(tiktokEpochSeconds('x'.repeat(200)).declared.length, 64, 'a declared string is preserved bounded');
});

test('TIKTOK-5. previews are typed by product: research ids from int64, display ids from strings, no identity from labels, metrics as first-known snapshots, four distinct clocks', () => {
  const r = tiktokVideoToPreview({ routeId: 'RESEARCH', video: research() }, { retrievedTs: NOW }).preview;
  assert.equal(r.fixtureOnly, true); assert.equal(r.durable, false); assert.equal(r.authority, 'NONE'); assert.equal(r.readinessToken, false);
  assert.equal(r.provider, 'TIKTOK_PUBLIC'); assert.equal(r.route, 'RESEARCH'); assert.equal(r.kind, 'VIDEO'); assert.equal(r.evidenceClass, 'RESEARCH_INDEXED_ORGANIC'); assert.equal(r.currentDecision, TIKTOK_DECISION.currentDecision);
  assert.equal(r.nativeContentId, '7123456789012345678'); assert.equal(r.nativeIdNamespace, 'TIKTOK_RESEARCH_VIDEO_ID'); assert.equal(r.idSource, 'STRING');
  assert.deepEqual(r.actor, { kind: 'TIKTOK_USER', nativeId: null, identity: 'UNAVAILABLE_LABELS_ARE_NOT_IDENTITY', usernameDescriptive: 'creator_name' });
  assert.equal(r.relation, 'VIDEO'); assert.equal(r.parent, null); assert.equal(r.crossPlatformIdentity, 'NONE'); assert.equal(r.deletionSignal, 'NONE');
  assert.equal(r.originalText, 'watch $FOO #crypto'); assert.equal(r.overDocumentedLength, false); assert.deepEqual(r.hashtags, ['crypto', 'foo']); assert.equal(r.regionCode, 'US'); assert.equal(r.title, null); assert.equal(r.shareUrl, null);
  assert.equal(r.sourceCreated.status, 'INSTANT'); assert.equal(r.sourceCreatedTs, 1788778800000); assert.equal(r.sourceClockStatus, 'TRUSTED');
  assert.equal(r.indexedTs, null); assert.equal(r.indexedStatus, 'UNKNOWN_ROUTE_DELAY_UP_TO_48H'); assert.equal(r.metricUpdatedTs, null); assert.equal(r.metricUpdatedStatus, 'UNKNOWN_ROUTE_REFRESH_UP_TO_10D'); assert.equal(r.retrievedTs, NOW);
  assert.deepEqual(r.metrics, { kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT', asOf: 'UNKNOWN', likes: 12, comments: 3, shares: 1, views: 900, favorites: 4 }); assert.equal(r.durationSeconds, 30);
  assert.equal(r.nativeVersionId, null); assert.equal(r.providerEventSeq, null); assert.ok(isDeepFrozen(r));
  // research int64 ids: a safe integer is rendered exactly; an unsafe one is refused (precision lost), never rounded
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ id: 712345678901234 }) }, { retrievedTs: NOW }).preview.idSource, 'SAFE_INTEGER');
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ id: 712345678901234 }) }, { retrievedTs: NOW }).preview.nativeContentId, '712345678901234');
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ id: 7123456789012345678 }) }, { retrievedTs: NOW }).reason, 'ID_PRECISION_LOST');
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ id: 1.5 }) }, { retrievedTs: NOW }).reason, 'ID_PRECISION_LOST');
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ id: '1'.repeat(26) }) }, { retrievedTs: NOW }).reason, 'ID_MALFORMED');
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ id: undefined }) }, { retrievedTs: NOW }).reason, 'ID_ABSENT');
  // display: documented string ids only; title/share_url documented; no username on the video object
  const d = tiktokVideoToPreview({ routeId: 'DISPLAY', video: display() }, { retrievedTs: NOW }).preview;
  assert.equal(d.evidenceClass, 'OWN_VIDEOS_ONLY'); assert.equal(d.nativeIdNamespace, 'TIKTOK_DISPLAY_VIDEO_ID'); assert.equal(d.title, 'My video'); assert.equal(d.shareUrl, 'https://www.tiktok.com/@me/video/7123456789012345678');
  assert.equal(d.actor.usernameDescriptive, null); assert.equal(d.actor.nativeId, null); assert.equal(d.hashtags, null); assert.equal(d.regionCode, null); assert.equal(d.indexedStatus, 'NOT_APPLICABLE_UNKNOWN'); assert.equal(d.metricUpdatedStatus, 'UNKNOWN'); assert.equal(d.metrics.favorites, null); assert.equal(d.durationSeconds, 15);
  assert.equal(tiktokVideoToPreview({ routeId: 'DISPLAY', video: display({ id: 712345678901234 }) }, { retrievedTs: NOW }).reason, 'ID_TYPE_MISMATCH');
  // display_name / nickname never become identity even when supplied
  const labelled = tiktokVideoToPreview({ routeId: 'DISPLAY', video: display({ display_name: 'Famous Person', nickname: 'famous', open_id: 'abc' }) }, { retrievedTs: NOW }).preview;
  assert.equal(labelled.actor.nativeId, null); assert.equal(labelled.actor.identity, 'UNAVAILABLE_LABELS_ARE_NOT_IDENTITY'); assert.ok(!JSON.stringify(labelled).includes('Famous Person'));
});

test('TIKTOK-6 (Stage-2 gate). bad types, timezone strings, long ids, partial payloads, and absent dates stay unknown or are refused; missing metrics stay unknown; no preview reaches a persistent path', () => {
  const partial = tiktokVideoToPreview({ routeId: 'RESEARCH', video: { id: '42' } }, { retrievedTs: NOW }).preview;
  assert.equal(partial.sourceCreated.status, 'ABSENT'); assert.equal(partial.sourceCreatedTs, null); assert.equal(partial.sourceClockStatus, 'UNKNOWN');
  assert.equal(partial.contentAvailable, false); assert.equal(partial.contentAbsence, 'DESCRIPTION_NOT_SUPPLIED_NOT_DELETION'); assert.equal(partial.deletionSignal, 'NONE');
  assert.deepEqual(partial.metrics, { kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT', asOf: 'UNKNOWN', likes: null, comments: null, shares: null, views: null, favorites: null }, 'absent metrics are unknown, never zero');
  assert.equal(partial.actor.usernameDescriptive, null); assert.equal(partial.hashtags, null); assert.equal(partial.regionCode, null); assert.equal(partial.durationSeconds, null);
  const tz = tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ create_time: '2026-09-07T00:00:00+08:00' }) }, { retrievedTs: NOW }).preview;
  assert.equal(tz.sourceCreated.status, 'TYPE_MISMATCH'); assert.equal(tz.sourceCreated.declared, '2026-09-07T00:00:00+08:00'); assert.equal(tz.sourceCreatedTs, null);
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ create_time: 1788778800000 }) }, { retrievedTs: NOW }).preview.sourceCreatedTs, null, 'millisecond magnitude is not silently rescaled');
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ create_time: 1888778800 }) }, { retrievedTs: NOW }).preview.sourceClockStatus, 'FUTURE_QUARANTINED');
  const bad = tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ like_count: '12', view_count: -1, share_count: 1.5, region_code: 'usa', hashtag_names: 'crypto', video_description: 'x'.repeat(200) }) }, { retrievedTs: NOW }).preview;
  assert.equal(bad.metrics.likes, null); assert.equal(bad.metrics.views, null); assert.equal(bad.metrics.shares, null); assert.equal(bad.regionCode, null); assert.equal(bad.hashtags, null); assert.equal(bad.overDocumentedLength, true);
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research({ hashtag_names: Array.from({ length: 40 }, (_, i) => `h${i}`) }) }, { retrievedTs: NOW }).preview.hashtags.length, 16, 'bounded');
  for (const v of [null, [], 'video', 7]) assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: v }, { retrievedTs: NOW }).skip, true);
  assert.equal(tiktokVideoToPreview({ routeId: 'RESEARCH', video: research() }, {}).skip, true, 'the caller\'s knowledge clock is mandatory');
  assert.equal(tiktokVideoToPreview({ routeId: 'COMMERCIAL_CONTENT', video: research() }, { retrievedTs: NOW }).unsupported.reason, 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED');
  assert.equal(tiktokVideoToPreview({ routeId: 'LIVE', video: research() }, { retrievedTs: NOW }).unsupported.reason, 'ROUTE_UNKNOWN');
  for (const p of [tiktokVideoToPreview({ routeId: 'RESEARCH', video: research() }, { retrievedTs: NOW }).preview, tiktokVideoToPreview({ routeId: 'DISPLAY', video: display() }, { retrievedTs: NOW }).preview]) {
    assert.equal(normalizeSocialObservation(p, { nowMs: NOW }).reject, true); assert.equal(normalizeSocialObservation({ ...p, providerKind: 'SOCIAL_MICROBLOG' }, { nowMs: NOW }).reject, true);
    assert.notEqual(validateSocialEvent(p), null);
    let built = null; try { built = socialObservationToEvent(p); } catch { built = null; }
    if (built?.event) assert.notEqual(validateSocialEvent(built.event), null);
  }
});
