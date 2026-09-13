// SOCIAL-4E Stage 1 — Meta (Facebook / Instagram) route foundation. Pure, non-live.
// Asserts CORRECT behaviour: distinct route descriptors that answer every question
// separately; a record bound to one route confers nothing on another; metadata /
// ad / managed / archive results are never labelled public organic evidence;
// malformed relationship, id, or clock input can never fabricate provenance; no
// permissive input can enable a request or a durable event.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  META_PROVIDER_ID, META_FOUNDATION, META_ROUTES, META_ROUTE_IDS, META_ROUTE_NAMESPACES, META_ROUTE_SUMMARY_KEYS, META_PREREQUISITES, META_EVIDENCE_CLASSES,
  META_PLATFORM_PATHS, META_PREVIEW_SUPPORT, META_PREVIEW_KINDS, META_DOCUMENTATION, META_APPLICATION_ID, META_USE_CASE_VERSION, META_USE_CASE,
  metaRoute, metaRouteSummary, metaRouteRecordFromEnv, validateMetaRouteRecord, metaCredentialsPresent, evaluateMetaRouteAccess, metaPayloadToPreview,
} from '../rumor2/social-meta.js';
import { FOUNDATION_IMPLEMENTATION_STAGES, FOUNDATION_DOC_STATUSES } from '../rumor2/social-foundation.js';
import { socialProviderById } from '../rumor2/social-registry.js';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialObservationToEvent, validateSocialEvent } from '../rumor2/social-settle.js';

const NOW = Date.parse('2026-09-07T12:00:00Z');
const ENV = { META_APP_TOKEN: 'present', META_INSTAGRAM_USER_TOKEN: 'present' };
const record = (over = {}) => ({
  route: 'FACEBOOK_PAGE_PUBLIC_CONTENT', approvalRef: 'meta/app-review/2026-09', status: 'ATTESTED', application: META_APPLICATION_ID, useCaseVersion: META_USE_CASE_VERSION,
  attested: ['APP_REVIEW', 'BUSINESS_VERIFICATION', 'PUBLIC_CONTENT_ACCESS_FEATURE'], permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH'],
  additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01',
  ...over,
});
const readyFor = (routeId) => record({ route: routeId, attested: [...metaRoute(routeId).eligibilityRequirements] });
const evalRoute = (routeId, over = {}) => evaluateMetaRouteAccess({ routeId, record: readyFor(routeId), env: ENV, nowMs: NOW, ...over });
const post = (over = {}) => ({ id: '1234567890_9876543210', message: 'Page says $FOO listing soon', created_time: '2026-09-07T10:00:00+00:00', permalink_url: 'https://www.facebook.com/1234567890/posts/9876543210', from: { id: '1234567890', name: 'Some Page' }, ...over });
const media = (over = {}) => ({ id: '17895695668004550', caption: 'IG caption $FOO', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-09-07T10:00:00Z', permalink: 'https://www.instagram.com/p/abc/', username: 'some_user', comments_count: 3, like_count: 10, ...over });
const isDeepFrozen = (o) => o === null || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(isDeepFrozen));

test('META-1. the foundation is fixture-only with no live path, and the provider stays ONE registry entry beneath which two namespaces are reviewed separately', () => {
  assert.equal(META_PROVIDER_ID, 'META_PUBLIC');
  assert.equal(socialProviderById('META_PUBLIC').implemented, false); assert.equal(socialProviderById('META_PUBLIC').durable, false);
  assert.ok(socialProviderById('FACEBOOK') === null && socialProviderById('INSTAGRAM') === null, 'namespaces are not checkpoint providers');
  for (const [k, v] of Object.entries(META_FOUNDATION)) assert.equal(v, k === 'fixtureOnly', `META_FOUNDATION.${k}`);
  assert.deepEqual(META_ROUTE_NAMESPACES, ['FACEBOOK', 'INSTAGRAM']);
  assert.equal(META_USE_CASE.platformClassification, 'UNRESOLVED'); assert.equal(META_USE_CASE.financialObjectiveDisclosed, true); assert.equal(META_USE_CASE.offeredAsService, false);
});

test('META-2. every route is a distinct descriptor answering every summary question separately, with closed enums and dated documentation', () => {
  assert.equal(META_ROUTE_IDS.length, 10);
  const registryRoutes = Object.keys(socialProviderById('META_PUBLIC').routes);
  const covered = new Set();
  for (const id of META_ROUTE_IDS) {
    const r = META_ROUTES[id]; const s = metaRouteSummary(id);
    assert.equal(r.id, id); assert.ok(META_ROUTE_NAMESPACES.includes(r.namespace), `${id} namespace`);
    assert.ok(registryRoutes.includes(r.registryRoute), `${id} refines a registry route`); covered.add(r.registryRoute);
    for (const k of META_ROUTE_SUMMARY_KEYS) assert.ok(k in s, `${id} answers ${k}`);
    assert.ok(META_PLATFORM_PATHS.includes(r.platformPath)); assert.ok(META_EVIDENCE_CLASSES.includes(r.evidenceClass)); assert.ok(META_PREVIEW_SUPPORT.includes(r.previewSupport));
    assert.ok(FOUNDATION_IMPLEMENTATION_STAGES.includes(r.implementationStage));
    for (const q of r.eligibilityRequirements) assert.ok(META_PREREQUISITES.includes(q), `${id} requirement ${q}`);
    assert.equal(r.eligibilityEstablishedForOperator, 'NOT_ESTABLISHED'); assert.equal(r.measuredLatency, 'UNKNOWN'); assert.equal(r.productionObservation, 'UNOBSERVED');
    assert.equal(r.liveAllowed, false); assert.equal(r.liveStatus, 'DISABLED'); assert.equal(r.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(r.durableContentAllowed, false); assert.equal(r.durableAuthorIdentityAllowed, false);
      assert.equal(r.extraAgreement.applicability !== undefined && r.extraAgreement.satisfied !== undefined, true, `${id} separates extra-agreement applicability from satisfaction`);
    assert.equal(r.retentionContent.startsWith('UNRESOLVED'), true); assert.equal(r.retentionIdentity.startsWith('UNRESOLVED'), true);
    assert.equal(s.provider, 'META_PUBLIC'); assert.ok(isDeepFrozen(s), `${id} summary is deep-frozen`);
    for (const d of s.documentation) { assert.ok(FOUNDATION_DOC_STATUSES.includes(d.status)); assert.equal(d.accessedOn, '2026-09-07'); assert.ok(d.url.startsWith('https://')); }
    assert.equal(r.previewSupport === 'SUPPORTED', r.contentKinds.length > 0, `${id} preview support matches content kinds`);
    assert.equal(r.implementationStage === 'DESCRIPTOR_AND_FIXTURE_PREVIEW', r.previewSupport === 'SUPPORTED');
  }
  assert.deepEqual([...covered].sort(), [...registryRoutes].sort(), 'every registry route key is refined by at least one descriptor');
  // the separations that matter
  assert.equal(META_ROUTES.FACEBOOK_PAGE_PUBLIC_CONTENT.evidenceClass, 'PUBLIC_PAGE_ORGANIC');
  assert.equal(META_ROUTES.FACEBOOK_PAGE_PUBLIC_METADATA.evidenceClass, 'METADATA_ONLY'); assert.deepEqual(META_ROUTES.FACEBOOK_PAGE_PUBLIC_METADATA.contentKinds, []);
  assert.equal(META_ROUTES.FACEBOOK_MANAGED_PAGES.evidenceClass, 'OPERATOR_MANAGED');
  assert.equal(META_ROUTES.FACEBOOK_AD_LIBRARY.evidenceClass, 'PROMOTION_DATA');
  assert.equal(META_ROUTES.FACEBOOK_GROUPS.platformPath, 'REMOVED'); assert.equal(META_ROUTES.FACEBOOK_GROUPS.implementationStage, 'NO_SANCTIONED_ROUTE');
  for (const id of ['FACEBOOK_CONTENT_LIBRARY', 'INSTAGRAM_CONTENT_LIBRARY']) { assert.equal(META_ROUTES[id].evidenceClass, 'RESEARCH_ARCHIVE'); assert.deepEqual(META_ROUTES[id].eligibilityRequirements, ['PARTNER_AFFILIATION_REVIEW']); assert.equal(META_ROUTES[id].previewSupport, 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED'); }
  assert.equal(META_ROUTES.INSTAGRAM_LOGIN.fieldAvailability.caption, 'NOT_DOCUMENTED_FOR_ROUTE'); assert.equal(META_ROUTES.INSTAGRAM_FACEBOOK_LOGIN.fieldAvailability.caption, 'DOCUMENTED');
  assert.deepEqual(META_ROUTES.INSTAGRAM_HASHTAG_DISCOVERY.quota, { uniqueHashtags: 30, windowDays: 7, basis: 'M3' });
  assert.equal(META_ROUTES.INSTAGRAM_LOGIN.credentialEnvs.includes('META_APP_TOKEN'), false, 'the Instagram Login route names its own token, never the Facebook app token');
  assert.equal(metaRoute('FACEBOOK'), null); assert.equal(metaRoute('__proto__'), null); assert.equal(metaRouteSummary('nope'), null);
  assert.equal(META_DOCUMENTATION.M6C.note.includes('DOCUMENTATION_UNVERIFIED'), true, 'the comment message/created_time gap is recorded, not guessed');
});

test('META-3. the operator record is closed: unknown fields, enums, routes, prerequisites, dates fail closed; the env reader treats empty as unsupplied', () => {
  assert.equal(validateMetaRouteRecord(record()), null);
  assert.notEqual(validateMetaRouteRecord(null), null); assert.notEqual(validateMetaRouteRecord([]), null);
  assert.match(validateMetaRouteRecord(record({ extra: 1 })), /undeclared field/);
  assert.match(validateMetaRouteRecord(record({ status: 'APPROVED' })), /unknown status/);
  assert.match(validateMetaRouteRecord(record({ route: 'FACEBOOK' })), /unknown route/);
  assert.match(validateMetaRouteRecord(record({ attested: ['APP_REVIEW', 'TOKEN_PRESENT'] })), /prerequisite vocabulary/);
  assert.match(validateMetaRouteRecord(record({ attested: ['APP_REVIEW', 'APP_REVIEW'] })), /prerequisite vocabulary/);
  assert.match(validateMetaRouteRecord(record({ permittedUses: ['RETRIEVAL', 'EVERYTHING'] })), /closed vocabulary/);
  assert.match(validateMetaRouteRecord(record({ retentionIdentity: 'FINE' })), /retentionIdentity/);
  assert.match(validateMetaRouteRecord(record({ reviewedOn: '2026-09-01T12:00:00' })), /reviewedOn/);
  assert.match(validateMetaRouteRecord(record({ validUntil: '0' })), /validUntil/);
  assert.match(validateMetaRouteRecord(record({ approvalRef: 'Dear Meta, please approve my app because ...' })), /reference label/);
  assert.equal(metaRouteRecordFromEnv({}), null); assert.equal(metaRouteRecordFromEnv({ RUMOR2_SOCIAL_META_ROUTE_ID: '' }), null);
  const r = metaRouteRecordFromEnv({ RUMOR2_SOCIAL_META_ROUTE_ID: 'INSTAGRAM_LOGIN', RUMOR2_SOCIAL_META_ROUTE_STATUS: 'PENDING', RUMOR2_SOCIAL_META_ROUTE_APPLICATION: META_APPLICATION_ID, RUMOR2_SOCIAL_META_ROUTE_USE_CASE_VERSION: META_USE_CASE_VERSION, RUMOR2_SOCIAL_META_ROUTE_ATTESTED: 'PROFESSIONAL_ACCOUNT, APP_REVIEW', RUMOR2_SOCIAL_META_ROUTE_REVIEWED_ON: '' });
  assert.equal(validateMetaRouteRecord(r), null); assert.deepEqual(r.attested, ['PROFESSIONAL_ACCOUNT', 'APP_REVIEW']); assert.equal(r.reviewedOn, null); assert.equal(r.retentionContent, 'UNRESOLVED');
  assert.equal(metaCredentialsPresent({ META_APP_TOKEN: 'x' }, 'FACEBOOK_PAGE_PUBLIC_CONTENT'), true);
  assert.equal(metaCredentialsPresent({ META_APP_TOKEN: 'x' }, 'INSTAGRAM_LOGIN'), false, 'the Facebook app token is not the Instagram user token');
  assert.equal(metaCredentialsPresent({ META_APP_TOKEN: '' }, 'FACEBOOK_PAGE_PUBLIC_CONTENT'), false); assert.equal(metaCredentialsPresent(ENV, 'FACEBOOK_CONTENT_LIBRARY'), false); assert.equal(metaCredentialsPresent(ENV, 'FACEBOOK_GROUPS'), false);
});

test('META-4. readiness is ONE derivation (all prerequisites AND zero blockers) and even full readiness never grants a live or durable path', () => {
  for (const id of ['FACEBOOK_PAGE_PUBLIC_CONTENT', 'FACEBOOK_MANAGED_PAGES', 'INSTAGRAM_LOGIN', 'INSTAGRAM_FACEBOOK_LOGIN', 'INSTAGRAM_HASHTAG_DISCOVERY', 'FACEBOOK_PAGE_PUBLIC_METADATA', 'FACEBOOK_AD_LIBRARY']) {
    const e = evalRoute(id);
    assert.deepEqual(e.blockers, [], `${id} ready with no blockers`); assert.equal(e.activationPrerequisitesMet, true, id);
    assert.ok(Object.values(e.prerequisites).every((v) => v === true), id);
    assert.equal(e.approvalStatus, 'OPERATOR_ATTESTED'); assert.equal(e.eligibilityEstablishedForOperator, 'OPERATOR_ATTESTED'); assert.equal(e.evidence, 'OPERATOR_ATTESTATION_NOT_PLATFORM_PROOF');
    assert.equal(e.liveAllowed, false); assert.equal(e.liveStatus, 'DISABLED'); assert.equal(e.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH');
    assert.equal(e.durableContentAllowed, false); assert.equal(e.durableAuthorIdentityAllowed, false); assert.equal(e.durableReason, 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED');
    assert.equal(e.measuredLatency, 'UNKNOWN'); assert.equal(e.productionObservation, 'UNOBSERVED');
    assert.deepEqual(e.downstream, { inference: false, training: false, derivedFeatures: false, redistribution: false }, 'retrieval never implies downstream uses');
    assert.ok(isDeepFrozen(e), `${id} result is deep-frozen`);
    assert.ok(!JSON.stringify(e).includes('present'), 'no credential value leaks');
  }
  // content library: partner environment, no env credential — readiness needs the partner review attested
  const cl = evalRoute('FACEBOOK_CONTENT_LIBRARY');
  assert.deepEqual(cl.blockers, []); assert.equal(cl.activationPrerequisitesMet, true); assert.ok(cl.advisories.includes('CREDENTIAL_NOT_APPLICABLE_PARTNER_ENVIRONMENT')); assert.ok(cl.advisories.includes('NOT_PUBLIC_ORGANIC_EVIDENCE: RESEARCH_ARCHIVE'));
  const cl2 = evaluateMetaRouteAccess({ routeId: 'FACEBOOK_CONTENT_LIBRARY', record: record({ route: 'FACEBOOK_CONTENT_LIBRARY', attested: ['APP_REVIEW', 'BUSINESS_VERIFICATION'] }), env: ENV, nowMs: NOW });
  assert.ok(cl2.blockers.includes('PREREQUISITE_NOT_ATTESTED: PARTNER_AFFILIATION_REVIEW')); assert.equal(cl2.eligibilityEstablishedForOperator, 'NOT_ESTABLISHED'); assert.equal(cl2.activationPrerequisitesMet, false);
  // metadata / ads: never organic evidence, said out loud
  assert.ok(evalRoute('FACEBOOK_PAGE_PUBLIC_METADATA').advisories.includes('NOT_PUBLIC_ORGANIC_EVIDENCE: METADATA_ONLY'));
  assert.ok(evalRoute('FACEBOOK_AD_LIBRARY').advisories.includes('NOT_PUBLIC_ORGANIC_EVIDENCE: PROMOTION_DATA'));
  // the removed Groups route can never be ready, whatever is attested
  const g = evaluateMetaRouteAccess({ routeId: 'FACEBOOK_GROUPS', record: record({ route: 'FACEBOOK_GROUPS', attested: [...META_PREREQUISITES] }), env: ENV, nowMs: NOW });
  assert.ok(g.blockers.includes('NO_SANCTIONED_ROUTE')); assert.equal(g.prerequisites.route, false); assert.equal(g.activationPrerequisitesMet, false);
});

test('META-5. every blocker is independent and can never coexist with readiness; a self-description is advisory, never permission', () => {
  const cases = [
    [{ nowMs: null }, 'CLOCK_UNAVAILABLE'], [{ nowMs: Number.NaN }, 'CLOCK_INVALID'], [{ nowMs: 1 }, 'CLOCK_INVALID'],
    [{ record: null }, 'APPROVAL_RECORD_MISSING'], [{ record: record({ status: 'GRANTED' }) }, /APPROVAL_RECORD_INVALID/],
    [{ record: record({ status: 'PENDING' }) }, 'APPROVAL_PENDING'], [{ record: record({ status: 'DENIED' }) }, 'APPROVAL_DENIED'], [{ record: record({ status: 'REVOKED' }) }, 'APPROVAL_REVOKED'],
    [{ record: record({ application: 'SOMEONE_ELSES_APP' }) }, /APPROVAL_OUT_OF_SCOPE/], [{ record: record({ useCaseVersion: 'serpent-meta-use-case-v0' }) }, /APPROVAL_OUT_OF_SCOPE/],
    [{ record: record({ reviewedOn: '2026-09-08' }) }, 'REVIEW_DATE_IN_FUTURE'], [{ record: record({ reviewedOn: '2026-09-07T12:00:00.001Z' }) }, 'REVIEW_DATE_IN_FUTURE'],
    [{ record: record({ validUntil: '2026-09-07T12:00:00Z' }) }, 'APPROVAL_EXPIRED'], [{ record: record({ validUntil: '2026-12-31' }) }, 'VALID_UNTIL_PRECISION_UNRESOLVED'],
    [{ record: record({ attested: ['APP_REVIEW'] }) }, 'PREREQUISITE_NOT_ATTESTED: BUSINESS_VERIFICATION'],
    [{ record: record({ additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: false }) }, 'ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED'], [{ record: record({ additionalAgreement: 'UNRESOLVED' }) }, 'ADDITIONAL_AGREEMENT_UNRESOLVED'],
    [{ record: record({ retentionContent: 'UNRESOLVED' }) }, 'RETENTION_CONTENT_UNRESOLVED'], [{ record: record({ retentionContent: 'INCOMPATIBLE' }) }, 'RETENTION_CONTENT_INCOMPATIBLE'],
    [{ record: record({ retentionIdentity: 'UNRESOLVED' }) }, 'RETENTION_IDENTITY_UNRESOLVED'], [{ record: record({ retentionIdentity: 'INCOMPATIBLE' }) }, 'RETENTION_IDENTITY_INCOMPATIBLE'],
    [{ record: record({ permittedUses: ['MODEL_INFERENCE'] }) }, 'RETRIEVAL_NOT_PERMITTED'], [{ env: {} }, 'CREDENTIAL_MISSING'], [{ env: { META_APP_TOKEN: '' } }, 'CREDENTIAL_MISSING'],
  ];
  for (const [over, expected] of cases) {
    const e = evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: record(), env: ENV, nowMs: NOW, ...over });
    assert.ok(e.blockers.some((b) => (expected instanceof RegExp ? expected.test(b) : b === expected)), `${JSON.stringify(over)} → ${expected}; got ${e.blockers}`);
    assert.equal(e.activationPrerequisitesMet, false); assert.equal(e.liveAllowed, false);
  }
  // a day-label review passes on its day, an instant compares exactly; retention content and identity are judged separately
  assert.equal(evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: record({ reviewedOn: '2026-09-07' }), env: ENV, nowMs: NOW }).activationPrerequisitesMet, true);
  const half = evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: record({ retentionIdentity: 'UNRESOLVED' }), env: ENV, nowMs: NOW });
  assert.equal(half.prerequisites.retentionContent, true); assert.equal(half.prerequisites.retentionIdentity, false); assert.equal(half.durableReason, 'RETENTION_COMPATIBILITY_UNRESOLVED');
  const d = evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: null, env: {}, nowMs: NOW, description: 'private single-user research only' });
  assert.ok(d.advisories.includes('SELF_DESCRIPTION_IS_NOT_PERMISSION')); assert.ok(d.blockers.includes('APPROVAL_RECORD_MISSING'));
  // the interpretation is host-zone independent: the same day label judged from two clocks on the same UTC day
  assert.equal(evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: record({ reviewedOn: '2026-09-07' }), env: ENV, nowMs: Date.parse('2026-09-07T00:00:00Z') }).activationPrerequisitesMet, true);
  assert.equal(evaluateMetaRouteAccess({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', record: record({ reviewedOn: '2026-09-07' }), env: ENV, nowMs: Date.parse('2026-09-06T23:59:59.999Z') }).activationPrerequisitesMet, false);
  const unknown = evaluateMetaRouteAccess({ routeId: 'PAGE_PUBLIC_CONTENT', record: record(), env: ENV, nowMs: NOW });
  assert.ok(unknown.blockers.includes('ROUTE_UNKNOWN')); assert.equal(unknown.route, null); assert.equal(unknown.activationPrerequisitesMet, false);
});

test('META-6 (Stage-1 gate). no evidence leaks across routes or namespaces: a record bound to one route confers nothing on any other', () => {
  for (const bound of META_ROUTE_IDS) {
    const rec = readyFor(bound);
    for (const target of META_ROUTE_IDS) {
      const e = evaluateMetaRouteAccess({ routeId: target, record: rec, env: ENV, nowMs: NOW });
      if (target === bound) continue;
      assert.equal(e.approvalStatus, 'OUT_OF_SCOPE', `${bound} → ${target}`);
      assert.ok(e.blockers.some((b) => b.startsWith('APPROVAL_ROUTE_MISMATCH')), `${bound} → ${target}: ${e.blockers}`);
      assert.equal(e.eligibilityEstablishedForOperator, 'NOT_ESTABLISHED'); assert.equal(e.activationPrerequisitesMet, false); assert.deepEqual(e.permittedUses, []);
    }
  }
  // attesting EVERY prerequisite on the Facebook public-content route does not make an Instagram route ready, and vice versa
  const fbAll = record({ attested: [...META_PREREQUISITES] });
  assert.equal(evaluateMetaRouteAccess({ routeId: 'INSTAGRAM_HASHTAG_DISCOVERY', record: fbAll, env: ENV, nowMs: NOW }).activationPrerequisitesMet, false);
});

test('META-7. Page post previews preserve the documented string id, page namespace, explicit relationship, the declaration beside its witness, and honest nulls; contradictions are refused', () => {
  const ok = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).preview;
  assert.equal(ok.fixtureOnly, true); assert.equal(ok.durable, false); assert.equal(ok.authority, 'NONE'); assert.equal(ok.readinessToken, false);
  assert.equal(ok.provider, 'META_PUBLIC'); assert.equal(ok.namespace, 'FACEBOOK'); assert.equal(ok.route, 'FACEBOOK_PAGE_PUBLIC_CONTENT'); assert.equal(ok.kind, 'PAGE_POST'); assert.equal(ok.evidenceClass, 'PUBLIC_PAGE_ORGANIC');
  assert.equal(ok.nativeContentId, '1234567890_9876543210'); assert.equal(ok.nativeIdNamespace, 'FACEBOOK_GRAPH_POST_ID'); assert.equal(ok.pageId, '1234567890');
  assert.deepEqual(ok.actor, { kind: 'PAGE', nativeId: '1234567890', idSource: 'FROM_ID', nameDescriptive: 'Some Page' });
  assert.equal(ok.relation, 'PAGE_POST'); assert.equal(ok.parent, null); assert.equal(ok.crossPlatformIdentity, 'NONE'); assert.equal(ok.deletionSignal, 'NONE');
  assert.equal(ok.contentAvailable, true); assert.equal(ok.originalText, 'Page says $FOO listing soon');
  assert.equal(ok.sourceDeclared, '2026-09-07T10:00:00+00:00'); assert.equal(ok.sourceDeclaredStatus, 'INSTANT'); assert.equal(ok.sourceDeclaredTs, Date.parse('2026-09-07T10:00:00Z')); assert.equal(ok.sourceClockStatus, 'TRUSTED'); assert.equal(ok.sourceDeclaredWitness.policy, 'ISO8601_PROFILE');
  assert.equal(ok.retrievedTs, NOW); assert.equal(ok.nativeVersionId, null); assert.equal(ok.providerEventSeq, null); assert.ok(isDeepFrozen(ok));
  // the same payload on the managed route is OPERATOR_MANAGED, never public organic
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_MANAGED_PAGES', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).preview.evidenceClass, 'OPERATOR_MANAGED');
  // ids: strings only, documented format only; a numeric id is refused (precision is not knowable), never coerced
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ id: 12345678909876543210 }) }, { retrievedTs: NOW }).reason, 'ID_MUST_BE_A_STRING');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ id: '9876543210' }) }, { retrievedTs: NOW }).reason, 'POST_ID_NOT_DOCUMENTED_FORMAT');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ id: '1_2_3' }) }, { retrievedTs: NOW }).reason, 'POST_ID_NOT_DOCUMENTED_FORMAT');
  // provenance: `from.id` contradicting the documented id prefix is refused, not resolved; absent `from` falls back to the prefix and says so
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ from: { id: '5555', name: 'Other' } }) }, { retrievedTs: NOW }).reason, 'FROM_ID_CONTRADICTS_POST_ID_PREFIX');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ from: { id: 1234567890 } }) }, { retrievedTs: NOW }).reason, 'FROM_ID_MALFORMED');
  const noFrom = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ from: undefined }) }, { retrievedTs: NOW }).preview;
  assert.deepEqual(noFrom.actor, { kind: 'PAGE', nativeId: '1234567890', idSource: 'POST_ID_PREFIX', nameDescriptive: null });
  // clocks: a basic-format offset (+0000) is NOT repaired — MALFORMED, declaration preserved, no instant, status UNKNOWN; an offset-less time is OFFSET_MISSING; a future declaration is quarantined
  const basic = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ created_time: '2026-09-07T10:00:00+0000' }) }, { retrievedTs: NOW }).preview;
  assert.equal(basic.sourceDeclared, '2026-09-07T10:00:00+0000'); assert.equal(basic.sourceDeclaredStatus, 'MALFORMED'); assert.equal(basic.sourceDeclaredTs, null); assert.equal(basic.sourceClockStatus, 'UNKNOWN');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ created_time: '2026-09-07T10:00:00' }) }, { retrievedTs: NOW }).preview.sourceDeclaredStatus, 'OFFSET_MISSING');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ created_time: '2026-02-30T10:00:00Z' }) }, { retrievedTs: NOW }).preview.sourceDeclaredTs, null);
  const nonString = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ created_time: 1757239200 }) }, { retrievedTs: NOW }).preview;
  assert.equal(nonString.sourceDeclaredStatus, 'MALFORMED'); assert.equal(nonString.sourceDeclaredWitness.declaredStatus, 'NON_STRING'); assert.equal(nonString.sourceDeclaredTs, null, 'an epoch number is never accepted where a date-time is documented');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ created_time: '2027-09-07T10:00:00Z' }) }, { retrievedTs: NOW }).preview.sourceClockStatus, 'FUTURE_QUARANTINED');
  const absentClock = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ created_time: undefined }) }, { retrievedTs: NOW }).preview;
  assert.equal(absentClock.sourceDeclared, null); assert.equal(absentClock.sourceDeclaredStatus, 'ABSENT'); assert.equal(absentClock.sourceClockStatus, 'UNKNOWN');
  // missing content is not deletion; oversized text is bounded and flagged; a non-https permalink is null
  const noMsg = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ message: undefined, permalink_url: 'javascript:alert(1)' }) }, { retrievedTs: NOW }).preview;
  assert.equal(noMsg.contentAvailable, false); assert.equal(noMsg.contentAbsence, 'MESSAGE_NOT_SUPPLIED_NOT_DELETION'); assert.equal(noMsg.deletionSignal, 'NONE'); assert.equal(noMsg.permalink, null);
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post({ message: 'x'.repeat(5000) }) }, { retrievedTs: NOW }).preview.textTruncated, true);
  // the caller's knowledge clock is mandatory — no wall clock is ever read
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post() }, {}).skip, true);
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post() }, { retrievedTs: '2026-09-07T12:00:00Z' }).skip, true);
  for (const bad of [null, [], 'post', 42]) assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: bad }, { retrievedTs: NOW }).skip, true);
});

test('META-8. Page comment previews carry only what the fetched documentation established: id, parent, counts; message/created_time/from stay DOCUMENTATION_UNVERIFIED; relationship needs explicit context', () => {
  const c = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '9876543210_111', message: 'nice', created_time: '2026-09-07T11:00:00+00:00', from: { id: '42', name: 'Someone' }, like_count: 2, comment_count: 0 }, context: { postId: '1234567890_9876543210' } }, { retrievedTs: NOW }).preview;
  assert.equal(c.kind, 'PAGE_COMMENT'); assert.equal(c.nativeContentId, '9876543210_111'); assert.equal(c.nativeIdNamespace, 'FACEBOOK_GRAPH_COMMENT_ID');
  assert.equal(c.relation, 'COMMENT_ON_POST'); assert.equal(c.parentPostId, '1234567890_9876543210'); assert.equal(c.parentCommentId, null);
  assert.equal(c.actor, null); assert.equal(c.actorStatus, 'DOCUMENTATION_UNVERIFIED');
  assert.equal(c.contentAvailable, false); assert.equal(c.textStatus, 'DOCUMENTATION_UNVERIFIED'); assert.equal(c.originalText, null, 'the message is NOT parsed until the field is documented');
  assert.equal(c.sourceDeclaredTs, null); assert.equal(c.sourceDeclaredStatus, 'DOCUMENTATION_UNVERIFIED'); assert.equal(c.sourceClockStatus, 'UNKNOWN');
  assert.deepEqual(c.engagement, { replies: 0, likes: 2, kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT' }); assert.equal(c.deletionSignal, 'NONE');
  const reply = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '9876543210_222', parent: { id: '9876543210_111' } }, context: { postId: '1234567890_9876543210' } }, { retrievedTs: NOW }).preview;
  assert.equal(reply.relation, 'REPLY_TO_COMMENT'); assert.equal(reply.parentCommentId, '9876543210_111'); assert.equal(reply.parentPostId, '1234567890_9876543210');
  const noCtx = metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '9876543210_333' } }, { retrievedTs: NOW }).preview;
  assert.equal(noCtx.relation, 'UNKNOWN'); assert.equal(noCtx.relationReason, 'POST_CONTEXT_MISSING'); assert.equal(noCtx.parentPostId, null);
  assert.deepEqual(noCtx.engagement, { replies: null, likes: null, kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT' }, 'absent counts are unknown, never zero');
  // malformed relationship can never fabricate provenance
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '9876543210_111', parent: { id: '9876543210_111' } } }, { retrievedTs: NOW }).reason, 'SELF_PARENT');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '9876543210_111', parent: { id: 5 } } }, { retrievedTs: NOW }).reason, 'PARENT_ID_MALFORMED');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '9876543210_111' }, context: { postId: 'not-a-post' } }, { retrievedTs: NOW }).reason, 'POST_CONTEXT_MALFORMED');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: 111 } }, { retrievedTs: NOW }).reason, 'ID_MUST_BE_A_STRING');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: 'abc' } }, { retrievedTs: NOW }).reason, 'COMMENT_ID_MALFORMED');
});

test('META-9. Instagram media previews are route-specific: caption only where documented, an AD product type is promotion data, a username is never identity, hidden likes are unknown', () => {
  const fb = metaPayloadToPreview({ routeId: 'INSTAGRAM_FACEBOOK_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media() }, { retrievedTs: NOW }).preview;
  assert.equal(fb.namespace, 'INSTAGRAM'); assert.equal(fb.kind, 'INSTAGRAM_MEDIA'); assert.equal(fb.evidenceClass, 'OWN_PROFESSIONAL_ACCOUNT');
  assert.equal(fb.nativeContentId, '17895695668004550'); assert.equal(fb.nativeIdNamespace, 'INSTAGRAM_GRAPH_MEDIA_ID'); assert.equal(fb.mediaType, 'IMAGE'); assert.equal(fb.mediaProductType, 'FEED');
  assert.equal(fb.contentAvailable, true); assert.equal(fb.originalText, 'IG caption $FOO'); assert.equal(fb.captionStatus, 'DOCUMENTED');
  assert.deepEqual(fb.actor, { kind: 'INSTAGRAM_USER', nativeId: null, idSource: null, usernameDescriptive: 'some_user', identity: 'UNAVAILABLE_USERNAME_IS_NOT_IDENTITY' });
  assert.equal(fb.sourceDeclaredTs, Date.parse('2026-09-07T10:00:00Z')); assert.equal(fb.sourceClockStatus, 'TRUSTED'); assert.equal(fb.crossPlatformIdentity, 'NONE');
  assert.deepEqual(fb.engagement, { comments: 3, likes: 10, kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT', likesHiddenPossible: false });
  // Instagram Login: caption and media_product_type are not documented for the route — never carried, never guessed
  const ig = metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media() }, { retrievedTs: NOW }).preview;
  assert.equal(ig.contentAvailable, false); assert.equal(ig.contentAbsence, 'CAPTION_NOT_DOCUMENTED_FOR_ROUTE'); assert.equal(ig.originalText, null); assert.equal(ig.captionStatus, 'NOT_DOCUMENTED_FOR_ROUTE');
  assert.equal(ig.mediaProductType, null); assert.equal(ig.mediaProductTypeStatus, 'NOT_DOCUMENTED_FOR_ROUTE'); assert.equal(ig.deletionSignal, 'NONE');
  // hashtag discovery is a capped route with its own evidence class; an AD product is relabelled promotion data even there
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_HASHTAG_DISCOVERY', kind: 'INSTAGRAM_MEDIA', payload: media() }, { retrievedTs: NOW }).preview.evidenceClass, 'HASHTAG_DISCOVERY_CAPPED');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_HASHTAG_DISCOVERY', kind: 'INSTAGRAM_MEDIA', payload: media({ media_product_type: 'AD' }) }, { retrievedTs: NOW }).preview.evidenceClass, 'PROMOTION_DATA');
  // owner id is the only identity source; a malformed owner is refused; unknown enum values are recorded as undocumented, not mapped
  const own = metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media({ owner: { id: '17841400000000000' }, media_type: 'STORY_HIGHLIGHT', like_count: undefined }) }, { retrievedTs: NOW }).preview;
  assert.equal(own.actor.nativeId, '17841400000000000'); assert.equal(own.actor.identity, 'OWNER_ID'); assert.equal(own.mediaType, null); assert.equal(own.mediaTypeStatus, 'UNDOCUMENTED_VALUE');
  assert.equal(own.engagement.likes, null); assert.equal(own.engagement.likesHiddenPossible, true);
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media({ owner: { id: 17841400000000000 } }) }, { retrievedTs: NOW }).reason, 'OWNER_ID_MALFORMED');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media({ id: 17895695668004550 }) }, { retrievedTs: NOW }).reason, 'ID_MUST_BE_A_STRING');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media({ id: 'abc_123' }) }, { retrievedTs: NOW }).reason, 'MEDIA_ID_MALFORMED');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media({ timestamp: '2026-09-07T10:00:00+0000' }) }, { retrievedTs: NOW }).preview.sourceDeclaredTs, null, 'a basic-format offset is never repaired');
});

test('META-10 (Stage-1 gate). unsupported routes and kind mismatches are typed refusals, and no preview can enter normalization, event build, or settlement', () => {
  assert.deepEqual(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_METADATA', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).unsupported, { reason: 'PREVIEW_UNSUPPORTED_METADATA_ONLY', route: 'FACEBOOK_PAGE_PUBLIC_METADATA', evidenceClass: 'METADATA_ONLY' });
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_AD_LIBRARY', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).unsupported.reason, 'PREVIEW_UNSUPPORTED_NOT_ORGANIC_CONTENT');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_CONTENT_LIBRARY', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).unsupported.reason, 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_CONTENT_LIBRARY', kind: 'INSTAGRAM_MEDIA', payload: media() }, { retrievedTs: NOW }).unsupported.reason, 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_GROUPS', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).unsupported.reason, 'PREVIEW_UNSUPPORTED_NO_ROUTE');
  assert.equal(metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'INSTAGRAM_MEDIA', payload: media() }, { retrievedTs: NOW }).unsupported.reason, 'ROUTE_CONTENT_KIND_MISMATCH');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).unsupported.reason, 'ROUTE_CONTENT_KIND_MISMATCH');
  assert.equal(metaPayloadToPreview({ routeId: 'INSTAGRAM_LOGIN', kind: 'REEL', payload: media() }, { retrievedTs: NOW }).unsupported.reason, 'CONTENT_KIND_UNKNOWN');
  assert.equal(metaPayloadToPreview({ routeId: 'THREADS', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).unsupported.reason, 'ROUTE_UNKNOWN');
  assert.deepEqual(META_PREVIEW_KINDS, ['PAGE_POST', 'PAGE_COMMENT', 'INSTAGRAM_MEDIA']);
  const previews = [
    metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_POST', payload: post() }, { retrievedTs: NOW }).preview,
    metaPayloadToPreview({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', kind: 'PAGE_COMMENT', payload: { id: '1_2' }, context: { postId: '1_2' } }, { retrievedTs: NOW }).preview,
    metaPayloadToPreview({ routeId: 'INSTAGRAM_FACEBOOK_LOGIN', kind: 'INSTAGRAM_MEDIA', payload: media() }, { retrievedTs: NOW }).preview,
  ];
  for (const p of previews) {
    assert.equal(normalizeSocialObservation(p, { nowMs: NOW }).reject, true, 'the preview is not a raw observation');
    assert.equal(normalizeSocialObservation({ ...p, providerKind: 'SOCIAL_MICROBLOG' }, { nowMs: NOW }).reject, true, 'even with a providerKind it lacks the native identity keys');
    assert.notEqual(validateSocialEvent(p), null, 'the preview is not a durable social event');
    let built = null; try { built = socialObservationToEvent(p); } catch { built = null; }
    if (built?.event) assert.notEqual(validateSocialEvent(built.event), null, 'nothing built from a preview validates as a durable event');
  }
});
