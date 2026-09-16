// SOCIAL-4E — Meta (Facebook + Instagram) ROUTE-SPECIFIC ACCESS FOUNDATION.
// Fixture-only. This module performs NO Graph API request, NO OAuth exchange,
// NO App Review submission, NO webhook, NO polling, holds NO credential value,
// and can NOT become live by flipping any field: there is no transport here.
// It is NOT an operational ear and it is NOT operational access.
//
// WHAT IT RECORDS (doctrine/SOCIAL.md §5P; first-party pages read 2026-09-07):
//   * ONE registry provider (META_PUBLIC) with TWO route namespaces, FACEBOOK
//     and INSTAGRAM, that are reviewed separately. Neither namespace is a
//     checkpoint provider and neither becomes one here.
//   * Each route answers the same questions SEPARATELY: documented platform
//     path; payload scope; eligibility requirements; eligibility established
//     for THIS operator (NOT_ESTABLISHED — no app, token, Page, professional
//     account, or institutional affiliation exists); approval/entitlement;
//     credential configuration (env NAMES only); permitted uses; extra
//     agreement applicability and satisfaction; retention for content;
//     retention for author identity; implementation stage; measured latency
//     (UNKNOWN); production observation (UNOBSERVED).
//   * Metadata, Ad Library, managed-Page, and research-archive results are
//     NEVER labelled public organic evidence; the Groups API has no sanctioned
//     route (removed 2024-04-22).
//   * An access record is an operator attestation bound to ONE route; it
//     supplies nothing to any other route. OPERATOR_ATTESTED is never platform
//     proof. Serpent is a private single-user personal research / paper-trading
//     / possible own-funds project; it is classified neither as commercial nor
//     as exempt, and no platform decision is recorded on its behalf.
//   * Previews are in-memory fixtures typed by route and content kind. They
//     preserve string ids with a namespace, carry an explicit relationship,
//     keep the provider's clock declaration verbatim beside its witness, and
//     answer honestly with null. Missing content is never deletion. A username
//     is never identity and never a cross-platform identity.
import { classifySourceClock, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_TEXT_CHARS, MAX_SOCIAL_HANDLE_CHARS, MAX_SOCIAL_URL_CHARS } from './social.js';
import { temporalWitness, SOCIAL_TIME_POLICIES } from './social-time.js';
import {
  SOCIAL_FOUNDATION_APPLICATION_ID, isSupportedFoundationClock, FOUNDATION_LIVE_FACTS, FOUNDATION_PREVIEW_FACTS, FOUNDATION_EVIDENCE,
  FOUNDATION_ROUTE_SUMMARY_KEYS, isPlainObject, isBoundedString, csvList, nonNegativeInt, deepFreeze, docRef,
  foundationDates, validateFoundationRecordCore, foundationApprovalOutcome, foundationAgreementState, agreementSatisfied, agreementBlocker, retentionBlocker, foundationReadiness,
} from './social-foundation.js';

export const META_PROVIDER_ID = 'META_PUBLIC'; // the registry provider; routes live beneath it
export const META_FOUNDATION = Object.freeze({ fixtureOnly: true, liveTransport: false, graphRequests: false, oauthExchange: false, appReviewSubmission: false, webhookReceiver: false, pollingLoop: false, scraping: false, modelCalls: false, persistentCache: false, registryProviderAdded: false });
export const META_ROUTE_NAMESPACES = Object.freeze(['FACEBOOK', 'INSTAGRAM']);
export const META_APPLICATION_ID = SOCIAL_FOUNDATION_APPLICATION_ID;
export const META_USE_CASE_VERSION = 'serpent-meta-use-case-v1';
export const META_USE_CASE = Object.freeze({
  application: META_APPLICATION_ID, version: META_USE_CASE_VERSION,
  nature: 'PRIVATE_SINGLE_USER_PERSONAL_PROTOTYPE', offeredAsService: false, sold: false,
  intendedUses: Object.freeze(['PERSONAL_RESEARCH', 'PAPER_TRADING', 'OWN_FUNDS_TRADING']),
  financialObjectiveDisclosed: true, platformClassification: 'UNRESOLVED', // never assumed commercial, never assumed exempt
});

// ---- documentation, dated (a fetch failure is DOCUMENTATION_UNVERIFIED, never a guess) ----
const ACCESSED = '2026-09-07';
export const META_DOCUMENTATION = Object.freeze({
  M1: docRef({ id: 'M1', url: 'https://developers.facebook.com/docs/features-reference/page-public-content-access/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Page Public Content Access: /page/feed, /page-post, /page-post/comments of Pages the app does not manage; App Review + Business Verification, possible additional contracts; allowed use "Analyze and/or display posts and engagement on Pages"; no rate-limit or retention statement on the page.' }),
  M2: docRef({ id: 'M2', url: 'https://developers.facebook.com/docs/features-reference/page-public-metadata-access/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Page Public Metadata Access: Pages Search + public Page data (/page) without pages_read_engagement; App Review + Business Verification; excludes Page feed and comments; not combinable with Page Public Content Access.' }),
  M3: docRef({ id: 'M3', url: 'https://developers.facebook.com/docs/instagram-platform/overview', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Two access paths: Business Login for Instagram (professional accounts, Instagram User token) and Facebook Login for Business (professional accounts linked to a Page); hashtag search only via Facebook Login under Instagram Public Content Access; Meta App Review required for Advanced Access; webhooks recommended; rate limit 4800 * impressions per 24 h.' }),
  M4: docRef({ id: 'M4', url: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Instagram API with Instagram Login: comments, media, insights, mentions of the authorizing professional account; no linked Page required; cannot access ads or tagging; hashtag search and business discovery not documented on this route.' }),
  M5: docRef({ id: 'M5', url: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Instagram API with Facebook Login: professional accounts only (no consumer accounts); cursor pagination; ordering unsupported; hashtag search cap and business discovery detailed elsewhere (overview).' }),
  M6: docRef({ id: 'M6', url: 'https://developers.facebook.com/docs/graph-api/reference/page/feed/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Page /feed: Post fields id ("{page-id}_{post-identifier}"), message, created_time ("The time the post was initially published"), permalink_url, from {name,id}, is_published; ~600 ranked published posts per year; limit max 100; unmanaged Pages need Page Public Content Access.' }),
  M6C: docRef({ id: 'M6C', url: 'https://developers.facebook.com/docs/graph-api/reference/comment/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Comment object: id, parent (Comment), comment_count, like_count, can_comment, is_private, user_likes; Page Public Content Access "may be required". The fetched page did NOT document message, created_time, or from — those fields stay unparsed here (DOCUMENTATION_UNVERIFIED).' }),
  M6M: docRef({ id: 'M6M', url: 'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media', accessedOn: ACCESSED, status: 'VERIFIED', note: 'IG Media: id, media_type (CAROUSEL_ALBUM|IMAGE|VIDEO), timestamp ("ISO 8601-formatted creation date in UTC"), permalink, username (mutable), owner (only for own media), comments_count, like_count (omitted when hidden), shortcode; caption and media_product_type (AD|FEED|STORY|REELS) documented for Instagram API with Facebook Login only.' }),
  M7: docRef({ id: 'M7', url: 'https://transparency.meta.com/researchtools/meta-content-library/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Meta Content Library: academic or not-for-profit affiliation; applications reviewed by CASD; controlled environments (Meta Secure Research Environment, SOMAR VDE); export restricted to widely-known accounts; not an operational feed.' }),
  M8: docRef({ id: 'M8', url: 'https://developers.facebook.com/terms/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Platform Terms 3.d: delete Platform Data on user request, when no longer necessary, and when the product stops; 3.a: no eligibility determinations (credit etc.), no sale/licensing of Platform Data; no explicit statement on automated financial use — retention/inference need route-specific review.' }),
});

// ---- closed vocabularies ----------------------------------------------------------
export const META_PREREQUISITES = Object.freeze(['APP_REVIEW', 'BUSINESS_VERIFICATION', 'ADDITIONAL_CONTRACT', 'PAGE_ADMIN_ROLE', 'PROFESSIONAL_ACCOUNT', 'PAGE_LINKAGE', 'ADVANCED_ACCESS', 'PUBLIC_CONTENT_ACCESS_FEATURE', 'PARTNER_AFFILIATION_REVIEW']);
export const META_EVIDENCE_CLASSES = Object.freeze(['PUBLIC_PAGE_ORGANIC', 'METADATA_ONLY', 'OPERATOR_MANAGED', 'OWN_PROFESSIONAL_ACCOUNT', 'HASHTAG_DISCOVERY_CAPPED', 'RESEARCH_ARCHIVE', 'PROMOTION_DATA', 'NONE']);
export const META_PLATFORM_PATHS = Object.freeze(['DOCUMENTED', 'DOCUMENTED_PARTNER_ENVIRONMENT', 'REMOVED']);
export const META_PREVIEW_SUPPORT = Object.freeze(['SUPPORTED', 'PREVIEW_UNSUPPORTED_METADATA_ONLY', 'PREVIEW_UNSUPPORTED_NOT_ORGANIC_CONTENT', 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED', 'PREVIEW_UNSUPPORTED_NO_ROUTE']);
export const META_PREVIEW_KINDS = Object.freeze(['PAGE_POST', 'PAGE_COMMENT', 'INSTAGRAM_MEDIA']);
export const META_ELIGIBILITY_STATES = Object.freeze(['NOT_ESTABLISHED', 'OPERATOR_ATTESTED']);

const COMMON = Object.freeze({
  eligibilityEstablishedForOperator: 'NOT_ESTABLISHED', approvalEntitlement: 'NOT_VERIFIED',
  retentionContent: 'UNRESOLVED_ROUTE_SPECIFIC_REVIEW_REQUIRED', retentionIdentity: 'UNRESOLVED_ROUTE_SPECIFIC_REVIEW_REQUIRED',
  realtimeDelivery: 'NOT_DOCUMENTED', evidence: FOUNDATION_EVIDENCE,
});
const route = (o) => deepFreeze({ ...COMMON, ...FOUNDATION_LIVE_FACTS, ...o });

// Every route is a DISTINCT descriptor. `registryRoute` names the key it refines in
// the registry's META_PUBLIC.routes census (two Instagram descriptors refine one key).
export const META_ROUTES = Object.freeze({
  FACEBOOK_PAGE_PUBLIC_CONTENT: route({
    id: 'FACEBOOK_PAGE_PUBLIC_CONTENT', namespace: 'FACEBOOK', registryRoute: 'PAGE_PUBLIC_CONTENT', platformPath: 'DOCUMENTED',
    payloadScope: 'public posts and comments of Pages the app does not manage (/page/feed, /page-post, /page-post/comments)', evidenceClass: 'PUBLIC_PAGE_ORGANIC', contentKinds: ['PAGE_POST', 'PAGE_COMMENT'],
    eligibilityRequirements: ['APP_REVIEW', 'BUSINESS_VERIFICATION', 'PUBLIC_CONTENT_ACCESS_FEATURE'], extraAgreement: { applicability: 'POSSIBLE_ADDITIONAL_CONTRACTS', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_APP_TOKEN'], permittedUses: ['ANALYZE_OR_DISPLAY_PAGE_POSTS_AND_ENGAGEMENT'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', quota: { rankedPostsPerYearApprox: 600, feedLimitMax: 100, basis: 'M6' }, documentation: ['M1', 'M6', 'M6C', 'M8'],
  }),
  FACEBOOK_PAGE_PUBLIC_METADATA: route({
    id: 'FACEBOOK_PAGE_PUBLIC_METADATA', namespace: 'FACEBOOK', registryRoute: 'PAGE_PUBLIC_METADATA', platformPath: 'DOCUMENTED',
    payloadScope: 'Pages Search and public Page metadata (/page) — never feed, posts, or comments', evidenceClass: 'METADATA_ONLY', contentKinds: [],
    eligibilityRequirements: ['APP_REVIEW', 'BUSINESS_VERIFICATION'], extraAgreement: { applicability: 'POSSIBLE_ADDITIONAL_CONTRACTS', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_APP_TOKEN'], permittedUses: ['ANALYZE_PUBLIC_PAGE_ENGAGEMENT_COUNTS', 'AGGREGATE_PUBLIC_ABOUT_INFORMATION'],
    implementationStage: 'DESCRIPTOR_ONLY', previewSupport: 'PREVIEW_UNSUPPORTED_METADATA_ONLY', quota: null, documentation: ['M2', 'M8'],
  }),
  FACEBOOK_MANAGED_PAGES: route({
    id: 'FACEBOOK_MANAGED_PAGES', namespace: 'FACEBOOK', registryRoute: 'MANAGED_PAGES', platformPath: 'DOCUMENTED',
    payloadScope: 'feed and comments of Pages the operator administers (Page tasks + pages_read_engagement + pages_read_user_content) — not platform listening', evidenceClass: 'OPERATOR_MANAGED', contentKinds: ['PAGE_POST', 'PAGE_COMMENT'],
    eligibilityRequirements: ['PAGE_ADMIN_ROLE', 'APP_REVIEW'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_APP_TOKEN'], permittedUses: ['MANAGE_OWN_PAGE_CONTENT'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', quota: { feedLimitMax: 100, basis: 'M6' }, documentation: ['M6', 'M6C', 'M8'],
  }),
  FACEBOOK_CONTENT_LIBRARY: route({
    id: 'FACEBOOK_CONTENT_LIBRARY', namespace: 'FACEBOOK', registryRoute: 'CONTENT_LIBRARY', platformPath: 'DOCUMENTED_PARTNER_ENVIRONMENT',
    payloadScope: 'Facebook public content in the Meta Content Library research archive (controlled environment; export restricted)', evidenceClass: 'RESEARCH_ARCHIVE', contentKinds: [],
    eligibilityRequirements: ['PARTNER_AFFILIATION_REVIEW'], extraAgreement: { applicability: 'PARTNER_TERMS', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'NOT_APPLICABLE_PARTNER_ENVIRONMENT', credentialEnvs: [], permittedUses: ['ACADEMIC_OR_NOT_FOR_PROFIT_RESEARCH'],
    implementationStage: 'DESCRIPTOR_ONLY', previewSupport: 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED', quota: null, documentation: ['M7'],
  }),
  FACEBOOK_AD_LIBRARY: route({
    id: 'FACEBOOK_AD_LIBRARY', namespace: 'FACEBOOK', registryRoute: 'AD_LIBRARY', platformPath: 'DOCUMENTED',
    payloadScope: 'archived ads — promotion data, never organic evidence', evidenceClass: 'PROMOTION_DATA', contentKinds: [],
    eligibilityRequirements: ['APP_REVIEW'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_APP_TOKEN'], permittedUses: ['AD_TRANSPARENCY_RESEARCH'],
    implementationStage: 'DESCRIPTOR_ONLY', previewSupport: 'PREVIEW_UNSUPPORTED_NOT_ORGANIC_CONTENT', quota: null, documentation: ['M8'],
  }),
  FACEBOOK_GROUPS: route({
    id: 'FACEBOOK_GROUPS', namespace: 'FACEBOOK', registryRoute: 'GROUPS', platformPath: 'REMOVED',
    payloadScope: 'none — the Groups API was deprecated in v19.0 and removed 2024-04-22', evidenceClass: 'NONE', contentKinds: [],
    eligibilityRequirements: [], extraAgreement: { applicability: 'NOT_APPLICABLE', satisfied: 'NOT_APPLICABLE' },
    credentialConfiguration: 'NONE_NO_ROUTE', credentialEnvs: [], permittedUses: [],
    implementationStage: 'NO_SANCTIONED_ROUTE', previewSupport: 'PREVIEW_UNSUPPORTED_NO_ROUTE', quota: null, documentation: [],
  }),
  INSTAGRAM_LOGIN: route({
    id: 'INSTAGRAM_LOGIN', namespace: 'INSTAGRAM', registryRoute: 'INSTAGRAM_LOGIN', platformPath: 'DOCUMENTED',
    payloadScope: 'media, comments, mentions, insights of the AUTHORIZING professional account only; no ads, no tagging, no hashtag search documented', evidenceClass: 'OWN_PROFESSIONAL_ACCOUNT', contentKinds: ['INSTAGRAM_MEDIA'],
    eligibilityRequirements: ['PROFESSIONAL_ACCOUNT', 'APP_REVIEW', 'ADVANCED_ACCESS'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_INSTAGRAM_USER_TOKEN'], permittedUses: ['MANAGE_OWN_PROFESSIONAL_ACCOUNT_PRESENCE'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', quota: { callsPer24hFormula: '4800 * impressions', basis: 'M3' }, documentation: ['M3', 'M4', 'M6M', 'M8'],
    fieldAvailability: { caption: 'NOT_DOCUMENTED_FOR_ROUTE', media_product_type: 'NOT_DOCUMENTED_FOR_ROUTE' },
  }),
  INSTAGRAM_FACEBOOK_LOGIN: route({
    id: 'INSTAGRAM_FACEBOOK_LOGIN', namespace: 'INSTAGRAM', registryRoute: 'INSTAGRAM_FACEBOOK_LOGIN', platformPath: 'DOCUMENTED',
    payloadScope: 'media, comments, mentions, insights of the authorizing professional account linked to a Page (Facebook User or Page token)', evidenceClass: 'OWN_PROFESSIONAL_ACCOUNT', contentKinds: ['INSTAGRAM_MEDIA'],
    eligibilityRequirements: ['PROFESSIONAL_ACCOUNT', 'PAGE_LINKAGE', 'APP_REVIEW', 'ADVANCED_ACCESS'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_APP_TOKEN'], permittedUses: ['MANAGE_OWN_PROFESSIONAL_ACCOUNT_PRESENCE'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', quota: { callsPer24hFormula: '4800 * impressions', basis: 'M3' }, documentation: ['M3', 'M5', 'M6M', 'M8'],
    fieldAvailability: { caption: 'DOCUMENTED', media_product_type: 'DOCUMENTED' },
  }),
  INSTAGRAM_HASHTAG_DISCOVERY: route({
    id: 'INSTAGRAM_HASHTAG_DISCOVERY', namespace: 'INSTAGRAM', registryRoute: 'INSTAGRAM_FACEBOOK_LOGIN', platformPath: 'DOCUMENTED',
    payloadScope: 'hashtag search (30 unique hashtags per 7 days) + business discovery under Instagram Public Content Access — a capped bounded read, not minutes-scale discovery', evidenceClass: 'HASHTAG_DISCOVERY_CAPPED', contentKinds: ['INSTAGRAM_MEDIA'],
    eligibilityRequirements: ['PROFESSIONAL_ACCOUNT', 'PAGE_LINKAGE', 'APP_REVIEW', 'ADVANCED_ACCESS', 'PUBLIC_CONTENT_ACCESS_FEATURE'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['META_APP_TOKEN'], permittedUses: ['DISCOVER_CAMPAIGN_CONTENT', 'BRAND_SENTIMENT_ANALYSIS', 'AUDIENCE_MANAGEMENT'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', quota: { uniqueHashtags: 30, windowDays: 7, basis: 'M3' }, documentation: ['M3', 'M6M', 'M8'],
    fieldAvailability: { caption: 'DOCUMENTED', media_product_type: 'DOCUMENTED' },
  }),
  INSTAGRAM_CONTENT_LIBRARY: route({
    id: 'INSTAGRAM_CONTENT_LIBRARY', namespace: 'INSTAGRAM', registryRoute: 'CONTENT_LIBRARY', platformPath: 'DOCUMENTED_PARTNER_ENVIRONMENT',
    payloadScope: 'Instagram public content in the Meta Content Library research archive (controlled environment; export restricted)', evidenceClass: 'RESEARCH_ARCHIVE', contentKinds: [],
    eligibilityRequirements: ['PARTNER_AFFILIATION_REVIEW'], extraAgreement: { applicability: 'PARTNER_TERMS', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'NOT_APPLICABLE_PARTNER_ENVIRONMENT', credentialEnvs: [], permittedUses: ['ACADEMIC_OR_NOT_FOR_PROFIT_RESEARCH'],
    implementationStage: 'DESCRIPTOR_ONLY', previewSupport: 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED', quota: null, documentation: ['M7'],
  }),
});
export const META_ROUTE_IDS = Object.freeze(Object.keys(META_ROUTES));
export const metaRoute = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(META_ROUTES, id) ? META_ROUTES[id] : null);
export const META_ROUTE_SUMMARY_KEYS = FOUNDATION_ROUTE_SUMMARY_KEYS;

// The route summary: the descriptor's separated answers plus the static facts —
// eligibility for THIS operator is NOT_ESTABLISHED and nothing here is live.
export function metaRouteSummary(routeId) {
  const r = metaRoute(routeId);
  if (r === null) return null;
  const docs = r.documentation.map((k) => META_DOCUMENTATION[k]);
  return deepFreeze({ provider: META_PROVIDER_ID, ...r, documentation: docs, documentationStatus: docs.length === 0 ? 'NOT_APPLICABLE' : docs.every((d) => d.status === 'VERIFIED') ? 'VERIFIED' : 'DOCUMENTATION_UNVERIFIED' });
}

// ---- operator access record: bound to ONE route ------------------------------------
const RECORD_KEYS = Object.freeze(['route', 'approvalRef', 'status', 'application', 'useCaseVersion', 'attested', 'permittedUses', 'additionalAgreement', 'additionalAgreementSatisfied', 'validUntil', 'retentionContent', 'retentionIdentity', 'reviewedOn']);
export function metaRouteRecordFromEnv(env = process.env) {
  const p = 'RUMOR2_SOCIAL_META_ROUTE_';
  const keys = ['ID', 'REF', 'STATUS', 'APPLICATION', 'USE_CASE_VERSION', 'ATTESTED', 'PERMITTED_USES', 'ADDITIONAL_AGREEMENT', 'ADDITIONAL_AGREEMENT_SATISFIED', 'VALID_UNTIL', 'RETENTION_CONTENT', 'RETENTION_IDENTITY', 'REVIEWED_ON'];
  if (!keys.some((k) => typeof env?.[p + k] === 'string' && env[p + k].length > 0)) return null;
  const g = (k) => (typeof env?.[p + k] === 'string' && env[p + k].length > 0 ? env[p + k] : null);
  return {
    route: g('ID'), approvalRef: g('REF'), status: g('STATUS'), application: g('APPLICATION'), useCaseVersion: g('USE_CASE_VERSION'),
    attested: csvList(g('ATTESTED')), permittedUses: csvList(g('PERMITTED_USES')),
    additionalAgreement: g('ADDITIONAL_AGREEMENT') ?? 'UNRESOLVED', additionalAgreementSatisfied: g('ADDITIONAL_AGREEMENT_SATISFIED') === 'true',
    validUntil: g('VALID_UNTIL'), retentionContent: g('RETENTION_CONTENT') ?? 'UNRESOLVED', retentionIdentity: g('RETENTION_IDENTITY') ?? 'UNRESOLVED', reviewedOn: g('REVIEWED_ON'),
  };
}
function inspectRecord(r) {
  const dates = foundationDates(r);
  let error = validateFoundationRecordCore(r, dates);
  if (error === null) {
    for (const k of Object.keys(r)) if (!RECORD_KEYS.includes(k)) { error = `access record: undeclared field '${k}'`; break; }
  }
  if (error === null && metaRoute(r.route) === null) error = `access record: unknown route '${r.route}'`;
  if (error === null && (!Array.isArray(r.attested) || r.attested.length > META_PREREQUISITES.length || r.attested.some((a) => !META_PREREQUISITES.includes(a)) || new Set(r.attested).size !== r.attested.length)) error = 'access record: attested outside the closed prerequisite vocabulary';
  return { error, dates };
}
export const validateMetaRouteRecord = (r) => inspectRecord(r).error;

// Whether every credential NAME a route needs is present (booleans only; values never returned).
export function metaCredentialsPresent(env = process.env, routeId) {
  const r = metaRoute(routeId);
  if (r === null || r.credentialConfiguration !== 'ENV_NAMES') return false;
  return r.credentialEnvs.every((k) => typeof env?.[k] === 'string' && env[k].length > 0);
}

// The closed route access evaluation. Inputs: the route, the operator record (or null),
// credential presence, and the caller's clock. Output never contains a secret and never
// grants a live path. A record bound to another route contributes NOTHING here.
export function evaluateMetaRouteAccess({ routeId, record = null, env = process.env, nowMs = null, description = null } = {}) {
  const r = metaRoute(routeId);
  const blockers = []; const advisories = [];
  const clockKnown = isSupportedFoundationClock(nowMs);
  if (!clockKnown) blockers.push(nowMs === null || nowMs === undefined ? 'CLOCK_UNAVAILABLE' : 'CLOCK_INVALID');
  if (description !== null) advisories.push('SELF_DESCRIPTION_IS_NOT_PERMISSION');
  if (r === null) {
    blockers.push('ROUTE_UNKNOWN');
    return deepFreeze({ provider: META_PROVIDER_ID, route: null, namespace: null, evidenceClass: 'NONE', platformPath: null, eligibilityEstablishedForOperator: 'NOT_ESTABLISHED', approvalStatus: 'NOT_VERIFIED', additionalAgreement: 'UNRESOLVED', retentionContent: 'UNRESOLVED', retentionIdentity: 'UNRESOLVED', credentialPresent: false, permittedUses: [], missingPrerequisites: [], downstream: { inference: false, training: false, derivedFeatures: false, redistribution: false }, prerequisites: {}, activationPrerequisitesMet: false, ...FOUNDATION_LIVE_FACTS, durableReason: 'ROUTE_UNKNOWN', evidence: FOUNDATION_EVIDENCE, blockers, advisories });
  }
  if (r.platformPath === 'REMOVED') blockers.push('NO_SANCTIONED_ROUTE');
  if (r.evidenceClass === 'METADATA_ONLY' || r.evidenceClass === 'PROMOTION_DATA' || r.evidenceClass === 'RESEARCH_ARCHIVE') advisories.push(`NOT_PUBLIC_ORGANIC_EVIDENCE: ${r.evidenceClass}`);
  const credentialPresent = metaCredentialsPresent(env, routeId);
  let approvalStatus = 'NOT_VERIFIED'; let agreement = 'UNRESOLVED'; let retentionContent = 'UNRESOLVED'; let retentionIdentity = 'UNRESOLVED';
  let permittedUses = []; let reviewOk = false; let missing = [...r.eligibilityRequirements]; let attestedForRoute = false;
  if (record === null) blockers.push('APPROVAL_RECORD_MISSING');
  else {
    const inspected = inspectRecord(record); // parsed ONCE; validation and readiness share it
    if (inspected.error) blockers.push(`APPROVAL_RECORD_INVALID: ${inspected.error}`);
    else if (!clockKnown) { /* nothing time-dependent can be judged: the attestation stays NOT_VERIFIED */ }
    else {
      const out = foundationApprovalOutcome({ record, dates: inspected.dates, nowMs, applicationId: META_APPLICATION_ID, useCaseVersion: META_USE_CASE_VERSION, scopeMatch: record.route === r.id, scopeMismatchBlocker: `APPROVAL_ROUTE_MISMATCH: the record binds ${record.route}, not ${r.id}` });
      approvalStatus = out.approvalStatus; reviewOk = out.reviewOk; blockers.push(...out.blockers); advisories.push(...out.advisories);
      if (approvalStatus === 'OPERATOR_ATTESTED') {
        attestedForRoute = true;
        missing = r.eligibilityRequirements.filter((q) => !record.attested.includes(q));
        for (const q of missing) blockers.push(`PREREQUISITE_NOT_ATTESTED: ${q}`);
        agreement = foundationAgreementState(record);
        const ab = agreementBlocker(agreement); if (ab) blockers.push(ab);
        retentionContent = record.retentionContent; retentionIdentity = record.retentionIdentity;
        const rc = retentionBlocker(retentionContent, 'CONTENT'); if (rc) blockers.push(rc);
        const ri = retentionBlocker(retentionIdentity, 'IDENTITY'); if (ri) blockers.push(ri);
        permittedUses = [...record.permittedUses];
        if (!permittedUses.includes('RETRIEVAL')) blockers.push('RETRIEVAL_NOT_PERMITTED');
      }
    }
  }
  if (r.credentialConfiguration === 'ENV_NAMES' && !credentialPresent) blockers.push('CREDENTIAL_MISSING');
  if (r.credentialConfiguration === 'NOT_APPLICABLE_PARTNER_ENVIRONMENT') advisories.push('CREDENTIAL_NOT_APPLICABLE_PARTNER_ENVIRONMENT');
  const eligibility = attestedForRoute && missing.length === 0 ? 'OPERATOR_ATTESTED' : 'NOT_ESTABLISHED';
  const prerequisites = Object.freeze({
    route: r.platformPath !== 'REMOVED',
    clock: clockKnown,
    review: clockKnown && record !== null && reviewOk,
    approval: approvalStatus === 'OPERATOR_ATTESTED',
    eligibility: eligibility === 'OPERATOR_ATTESTED',
    agreement: agreementSatisfied(agreement),
    retentionContent: retentionContent === 'COMPATIBLE_REVIEWED',
    retentionIdentity: retentionIdentity === 'COMPATIBLE_REVIEWED',
    retrieval: permittedUses.includes('RETRIEVAL'),
    credential: r.credentialConfiguration === 'ENV_NAMES' ? credentialPresent : r.credentialConfiguration === 'NOT_APPLICABLE_PARTNER_ENVIRONMENT',
  });
  return deepFreeze({
    provider: META_PROVIDER_ID, route: r.id, namespace: r.namespace, registryRoute: r.registryRoute, evidenceClass: r.evidenceClass, platformPath: r.platformPath,
    eligibilityEstablishedForOperator: eligibility, approvalStatus, additionalAgreement: agreement, retentionContent, retentionIdentity,
    credentialPresent, permittedUses, missingPrerequisites: missing,
    downstream: { inference: permittedUses.includes('MODEL_INFERENCE'), training: permittedUses.includes('MODEL_TRAINING'), derivedFeatures: permittedUses.includes('DERIVED_FEATURES'), redistribution: permittedUses.includes('REDISTRIBUTION') },
    prerequisites, activationPrerequisitesMet: foundationReadiness(prerequisites, blockers),
    ...FOUNDATION_LIVE_FACTS, durableReason: prerequisites.retentionContent && prerequisites.retentionIdentity ? 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED' : 'RETENTION_COMPATIBILITY_UNRESOLVED',
    evidence: FOUNDATION_EVIDENCE, blockers, advisories,
  });
}

// ---- fixture-only previews typed by route AND content kind --------------------------
// The preview is deliberately NOT the shared durable observation shape (different key
// names, no nativePostId/nativeAuthorId), so the existing normalization, event build, and
// settlement entry points reject it. Nothing here fetches, caches, or fabricates.
const PAGE_POST_ID_RE = /^\d{1,30}_\d{1,30}$/; // documented "{page-id}_{post-identifier}" (M6)
const COMMENT_ID_RE = /^\d{1,30}(?:_\d{1,30}){0,2}$/; // opaque numeric-and-underscore token; preserved verbatim, never split into meaning
const IG_MEDIA_ID_RE = /^\d{1,30}$/;
const PAGE_ID_RE = /^\d{1,30}$/;
const PREVIEW_TEXT_CHARS = 280;
const IG_MEDIA_TYPES = Object.freeze(['CAROUSEL_ALBUM', 'IMAGE', 'VIDEO']);
const IG_PRODUCT_TYPES = Object.freeze(['AD', 'FEED', 'STORY', 'REELS']);
const derivePreviewText = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_TEXT_CHARS) : null);
const boundedUrl = (v) => (isBoundedString(v, MAX_SOCIAL_URL_CHARS) && v.startsWith('https://') ? v : null);
const stringId = (v, re) => (typeof v === 'string' && v.length <= MAX_NATIVE_ID_CHARS && re.test(v) ? v : null);
const unsupported = (reason, extra = {}) => ({ unsupported: deepFreeze({ reason, ...extra }) });
const skip = (reason) => ({ skip: true, reason });

// The provider's declared clock, kept verbatim beside ONE sealed witness. Meta documents an
// ISO 8601 UTC date-time; the sealed ISO8601_PROFILE grammar accepts an extended offset
// (Z or ±HH:MM). A basic-format offset such as +0000 is NOT repaired: it stays MALFORMED
// with the declaration preserved and no instant — a Meta-specific grammar is remaining
// work pending an observed payload, never a guess here.
function declaredClock(v, retrievedTs) {
  const witness = temporalWitness(v, SOCIAL_TIME_POLICIES.ISO8601_PROFILE);
  const instantMs = witness.projectionMs;
  const clock = instantMs === null ? { sourceClockStatus: 'UNKNOWN', sourceClockSkewMs: null } : classifySourceClock({ sourceDeclaredTs: instantMs, retrievedTs });
  return { sourceDeclared: witness.declared, sourceDeclaredStatus: witness.outcome, sourceDeclaredWitness: witness, sourceDeclaredTs: instantMs, sourceClockStatus: clock.sourceClockStatus, sourceClockSkewMs: clock.sourceClockSkewMs };
}
function textFacts(text, absenceReason) {
  if (typeof text !== 'string') return { contentAvailable: false, contentAbsence: absenceReason, originalText: null, previewText: null };
  const bounded = text.slice(0, MAX_SOCIAL_TEXT_CHARS);
  return { contentAvailable: true, contentAbsence: null, originalText: bounded, previewText: derivePreviewText(bounded), textTruncated: text.length > MAX_SOCIAL_TEXT_CHARS };
}
const base = ({ r, kind, retrievedTs }) => ({ ...FOUNDATION_PREVIEW_FACTS, provider: META_PROVIDER_ID, namespace: r.namespace, route: r.id, kind, evidenceClass: r.evidenceClass, retrievedTs, deletionSignal: 'NONE', crossPlatformIdentity: 'NONE' });

function pagePostPreview(r, d, retrievedTs) {
  const id = stringId(d.id, PAGE_POST_ID_RE);
  if (id === null) return skip(typeof d.id === 'number' ? 'ID_MUST_BE_A_STRING' : 'POST_ID_NOT_DOCUMENTED_FORMAT');
  const prefixPageId = id.slice(0, id.indexOf('_'));
  const from = isPlainObject(d.from) ? d.from : null;
  const fromId = from === null ? null : stringId(from.id, PAGE_ID_RE);
  if (from !== null && from.id !== undefined && fromId === null) return skip('FROM_ID_MALFORMED');
  if (fromId !== null && fromId !== prefixPageId) return skip('FROM_ID_CONTRADICTS_POST_ID_PREFIX'); // contradictory provenance is refused, never resolved
  const actorName = from !== null && isBoundedString(from.name, MAX_SOCIAL_HANDLE_CHARS) ? from.name : null;
  return { preview: deepFreeze({
    ...base({ r, kind: 'PAGE_POST', retrievedTs }),
    nativeContentId: id, nativeIdNamespace: 'FACEBOOK_GRAPH_POST_ID', pageId: prefixPageId,
    actor: { kind: 'PAGE', nativeId: fromId ?? prefixPageId, idSource: fromId !== null ? 'FROM_ID' : 'POST_ID_PREFIX', nameDescriptive: actorName },
    relation: 'PAGE_POST', parent: null,
    ...textFacts(d.message, 'MESSAGE_NOT_SUPPLIED_NOT_DELETION'),
    ...declaredClock(d.created_time, retrievedTs),
    permalink: boundedUrl(d.permalink_url), isPublished: typeof d.is_published === 'boolean' ? d.is_published : null,
    nativeVersionId: null, providerEventSeq: null, engagement: null,
  }) };
}
function pageCommentPreview(r, d, retrievedTs, context) {
  const id = stringId(d.id, COMMENT_ID_RE);
  if (id === null) return skip(typeof d.id === 'number' ? 'ID_MUST_BE_A_STRING' : 'COMMENT_ID_MALFORMED');
  const parent = isPlainObject(d.parent) ? stringId(d.parent.id, COMMENT_ID_RE) : null;
  if (isPlainObject(d.parent) && parent === null) return skip('PARENT_ID_MALFORMED');
  if (parent === id) return skip('SELF_PARENT');
  const postId = isPlainObject(context) ? stringId(context.postId, PAGE_POST_ID_RE) : null;
  if (isPlainObject(context) && context.postId !== undefined && postId === null) return skip('POST_CONTEXT_MALFORMED');
  let relation; let relationReason = null; let parentPostId = null; let parentCommentId = null;
  if (parent !== null) { relation = 'REPLY_TO_COMMENT'; parentCommentId = parent; parentPostId = postId; }
  else if (postId !== null) { relation = 'COMMENT_ON_POST'; parentPostId = postId; }
  else { relation = 'UNKNOWN'; relationReason = 'POST_CONTEXT_MISSING'; }
  return { preview: deepFreeze({
    ...base({ r, kind: 'PAGE_COMMENT', retrievedTs }),
    nativeContentId: id, nativeIdNamespace: 'FACEBOOK_GRAPH_COMMENT_ID',
    actor: null, actorStatus: 'DOCUMENTATION_UNVERIFIED', // `from` was not documented on the page read 2026-09-07 (M6C)
    relation, relationReason, parentPostId, parentCommentId,
    contentAvailable: false, contentAbsence: 'MESSAGE_FIELD_DOCUMENTATION_UNVERIFIED', originalText: null, previewText: null, textStatus: 'DOCUMENTATION_UNVERIFIED',
    sourceDeclared: null, sourceDeclaredStatus: 'DOCUMENTATION_UNVERIFIED', sourceDeclaredWitness: null, sourceDeclaredTs: null, sourceClockStatus: 'UNKNOWN', sourceClockSkewMs: null,
    engagement: { replies: nonNegativeInt(d.comment_count), likes: nonNegativeInt(d.like_count), kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT' },
    nativeVersionId: null, providerEventSeq: null,
  }) };
}
function instagramMediaPreview(r, d, retrievedTs) {
  const id = stringId(d.id, IG_MEDIA_ID_RE);
  if (id === null) return skip(typeof d.id === 'number' ? 'ID_MUST_BE_A_STRING' : 'MEDIA_ID_MALFORMED');
  const mediaType = IG_MEDIA_TYPES.includes(d.media_type) ? d.media_type : null;
  const productDocumented = r.fieldAvailability.media_product_type === 'DOCUMENTED';
  const productType = productDocumented && IG_PRODUCT_TYPES.includes(d.media_product_type) ? d.media_product_type : null;
  const owner = isPlainObject(d.owner) ? stringId(d.owner.id, IG_MEDIA_ID_RE) : null;
  if (isPlainObject(d.owner) && d.owner.id !== undefined && owner === null) return skip('OWNER_ID_MALFORMED');
  const username = isBoundedString(d.username, MAX_SOCIAL_HANDLE_CHARS) ? d.username : null;
  const captionDocumented = r.fieldAvailability.caption === 'DOCUMENTED';
  const text = captionDocumented ? textFacts(d.caption, 'CAPTION_NOT_SUPPLIED_NOT_DELETION') : { contentAvailable: false, contentAbsence: 'CAPTION_NOT_DOCUMENTED_FOR_ROUTE', originalText: null, previewText: null };
  // an AD product type is promotion data even on an organic route — never relabelled organic
  const evidenceClass = productType === 'AD' ? 'PROMOTION_DATA' : r.evidenceClass;
  return { preview: deepFreeze({
    ...base({ r, kind: 'INSTAGRAM_MEDIA', retrievedTs }), evidenceClass,
    nativeContentId: id, nativeIdNamespace: 'INSTAGRAM_GRAPH_MEDIA_ID', shortcode: isBoundedString(d.shortcode, 64) ? d.shortcode : null,
    mediaType, mediaTypeStatus: mediaType === null ? (d.media_type === undefined ? 'ABSENT' : 'UNDOCUMENTED_VALUE') : 'DOCUMENTED',
    mediaProductType: productType, mediaProductTypeStatus: !productDocumented ? 'NOT_DOCUMENTED_FOR_ROUTE' : productType === null ? (d.media_product_type === undefined ? 'ABSENT' : 'UNDOCUMENTED_VALUE') : 'DOCUMENTED',
    actor: { kind: 'INSTAGRAM_USER', nativeId: owner, idSource: owner === null ? null : 'OWNER_ID', usernameDescriptive: username, identity: owner === null ? 'UNAVAILABLE_USERNAME_IS_NOT_IDENTITY' : 'OWNER_ID' },
    relation: 'MEDIA', parent: null,
    ...text, captionStatus: captionDocumented ? 'DOCUMENTED' : 'NOT_DOCUMENTED_FOR_ROUTE',
    ...declaredClock(d.timestamp, retrievedTs),
    permalink: boundedUrl(d.permalink),
    engagement: { comments: nonNegativeInt(d.comments_count), likes: nonNegativeInt(d.like_count), kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT', likesHiddenPossible: d.like_count === undefined },
    nativeVersionId: null, providerEventSeq: null,
  }) };
}

// Map ONE official-shaped payload for ONE route and ONE content kind to an in-memory
// preview, a typed `unsupported`, or a `skip`. Total: adversarial input never throws.
export function metaPayloadToPreview({ routeId, kind, payload, context = null } = {}, { retrievedTs } = {}) {
  if (!isSupportedFoundationClock(retrievedTs)) return skip('retrievedTs (the caller\'s knowledge clock) must be a supported epoch-ms timestamp; the adapter never reads a wall clock');
  const r = metaRoute(routeId);
  if (r === null) return unsupported('ROUTE_UNKNOWN');
  if (r.previewSupport !== 'SUPPORTED') return unsupported(r.previewSupport, { route: r.id, evidenceClass: r.evidenceClass });
  if (!META_PREVIEW_KINDS.includes(kind)) return unsupported('CONTENT_KIND_UNKNOWN', { route: r.id });
  if (!r.contentKinds.includes(kind)) return unsupported('ROUTE_CONTENT_KIND_MISMATCH', { route: r.id, kind });
  if (!isPlainObject(payload)) return skip('payload not an object');
  if (kind === 'PAGE_POST') return pagePostPreview(r, payload, retrievedTs);
  if (kind === 'PAGE_COMMENT') return pageCommentPreview(r, payload, retrievedTs, context);
  return instagramMediaPreview(r, payload, retrievedTs);
}
