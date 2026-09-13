// SOCIAL-4E — TikTok PRODUCT-SPECIFIC ACCESS FOUNDATION. Fixture-only. This
// module performs NO API request, NO OAuth/client-key exchange, NO application,
// NO webhook, NO polling, holds NO credential value, and can NOT become live by
// flipping any field: there is no transport here. It is NOT an operational ear.
//
// WHAT IT RECORDS (doctrine/SOCIAL.md §5P; first-party pages read 2026-09-07):
//   * ONE registry provider (TIKTOK_PUBLIC) with THREE products reviewed
//     separately — Research Tools/API, Display API, Commercial Content API.
//     The registry's CURRENT decision is preserved unchanged here:
//     INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED with
//     OPERATOR_REVIEW_PENDING. No application was made, none was denied, and
//     no permanent exclusion is recorded on the operator's behalf.
//   * Research Tools: eligible academic / not-for-profit affiliation, non-
//     commercial research basis, ethics review, project approval — NOT
//     ESTABLISHED for this project; on THIS route new videos take up to 48 h
//     to enter search and some metrics up to 10 days to refresh (T1).
//   * Display API: the AUTHORIZING user's own videos only (T2) — not organic
//     discovery. Commercial Content API: paid ads, advertiser data, and other
//     commercial content (EU data in this phase) — a commercial dataset, not
//     the organic feed and not a classification of Serpent's use (T4).
//   * A client key or token is configuration; it never supplies affiliation,
//     approval, or entitlement. OPERATOR_ATTESTED is never platform proof.
//   * Previews are typed by product and content kind. Documented epoch-SECOND
//     timestamps are parsed ONLY as seconds with a range check — never scaled
//     by magnitude guessing; strings and floats are type mismatches. No author
//     identity is derived from display_name / nickname / username. Metrics are
//     first-known diagnostic snapshots with distinct source-created / indexing /
//     metric-update / retrieval times, each honestly unknown when not supplied.
import { classifySourceClock, MAX_NATIVE_ID_CHARS, MAX_SOCIAL_TEXT_CHARS, MAX_SOCIAL_HANDLE_CHARS, MAX_SOCIAL_URL_CHARS } from './social.js';
import {
  SOCIAL_FOUNDATION_APPLICATION_ID, isSupportedFoundationClock, FOUNDATION_LIVE_FACTS, FOUNDATION_PREVIEW_FACTS, FOUNDATION_EVIDENCE,
  FOUNDATION_ROUTE_SUMMARY_KEYS, isPlainObject, isBoundedString, csvList, nonNegativeInt, deepFreeze, docRef,
  foundationDates, validateFoundationRecordCore, foundationApprovalOutcome, foundationAgreementState, agreementSatisfied, agreementBlocker, retentionBlocker, foundationReadiness,
} from './social-foundation.js';

export const TIKTOK_PROVIDER_ID = 'TIKTOK_PUBLIC';
export const TIKTOK_FOUNDATION = Object.freeze({ fixtureOnly: true, liveTransport: false, apiRequests: false, clientKeyExchange: false, applicationSubmission: false, webhookReceiver: false, pollingLoop: false, scraping: false, modelCalls: false, persistentCache: false, decisionChanged: false });
// The registry decision, preserved verbatim (a test pins equality with the registry).
export const TIKTOK_DECISION = Object.freeze({ currentDecision: 'INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED', decisionStatus: 'OPERATOR_REVIEW_PENDING', applicationMade: false, applicationDenied: false, permanentExclusionApproved: false });
export const TIKTOK_APPLICATION_ID = SOCIAL_FOUNDATION_APPLICATION_ID;
export const TIKTOK_USE_CASE_VERSION = 'serpent-tiktok-use-case-v1';
export const TIKTOK_USE_CASE = Object.freeze({
  application: TIKTOK_APPLICATION_ID, version: TIKTOK_USE_CASE_VERSION,
  nature: 'PRIVATE_SINGLE_USER_PERSONAL_PROTOTYPE', offeredAsService: false, sold: false,
  intendedUses: Object.freeze(['PERSONAL_RESEARCH', 'PAPER_TRADING', 'OWN_FUNDS_TRADING']),
  financialObjectiveDisclosed: true, platformClassification: 'UNRESOLVED', // never assumed commercial, never assumed exempt
});

const ACCESSED = '2026-09-07';
export const TIKTOK_DOCUMENTATION = Object.freeze({
  T1: docRef({ id: 'T1', url: 'https://developers.tiktok.com/docs/en/research-api-faq', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Research API FAQ: creators, advertisers, and commercial users are not eligible; "New videos take up to 48 hours to be added to the search engine, and statistics such as view count and follower count can take up to 10 days to update"; daily quota 1,000 requests / 100,000 records, reset 12 AM UTC; no retention obligation stated on the page.' }),
  T2: docRef({ id: 'T2', url: 'https://developers.tiktok.com/doc/display-api-overview', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Display API: a creator\'s own profile (open_id, avatar_url, display_name, profile_deep_link, bio_description) and recently uploaded videos; scopes user.info.basic and video.list; no rate limits stated on the page.' }),
  T2V: docRef({ id: 'T2V', url: 'https://developers.tiktok.com/doc/tiktok-api-v2-video-object', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Display Video Object: id (string), create_time (int64, "UTC Unix epoch (in seconds) of when the TikTok video was posted"), share_url, video_description (max 150), title (max 150), duration (int32 seconds), like_count/comment_count/share_count (int32), view_count (int64); /v2/video/list/ max_count 20, cursor is a UTC Unix timestamp in milliseconds.' }),
  T3: docRef({ id: 'T3', url: 'https://developers.tiktok.com/products/research-api/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Research Tools eligibility: U.S., EEA, UK, Canada, Switzerland, Brazil; academic or not-for-profit / independent research institution; independent of commercial interests; funding disclosure; ethics review evidence; data security commitments; ~4 weeks to a decision.' }),
  T3V: docRef({ id: 'T3V', url: 'https://developers.tiktok.com/doc/research-api-specs-query-videos', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Research query videos object: id (int64), create_time (int64, "UTC Unix epoch (in seconds)"), username, region_code, video_description, music_id, like_count/comment_count/share_count/view_count/favorites_count (int64), hashtag_names, is_stem_verified, video_duration; max_count 100; start_date/end_date within 30 days; cursor + search_id.' }),
  T4: docRef({ id: 'T4', url: 'https://developers.tiktok.com/products/commercial-content-api/', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Commercial Content API: paid ads (published/last-seen dates, targeting, reach), advertiser information, other commercial content; EU data only in this phase; open application (~2 working days) issuing a client key; ad data available until one year after last shown. No content schema was verified for a preview.' }),
});

export const TIKTOK_PREREQUISITES = Object.freeze(['ELIGIBLE_INSTITUTION_AFFILIATION', 'NON_COMMERCIAL_RESEARCH_BASIS', 'ETHICS_REVIEW', 'PROJECT_APPROVAL', 'DEVELOPER_ACCOUNT', 'USER_AUTHORIZATION', 'APPLICATION_APPROVAL', 'CLIENT_KEY_ISSUED']);
export const TIKTOK_EVIDENCE_CLASSES = Object.freeze(['RESEARCH_INDEXED_ORGANIC', 'OWN_VIDEOS_ONLY', 'COMMERCIAL_DATASET']);
export const TIKTOK_PREVIEW_SUPPORT = Object.freeze(['SUPPORTED', 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED']);
export const TIKTOK_PREVIEW_KINDS = Object.freeze(['VIDEO']);

const COMMON = Object.freeze({
  eligibilityEstablishedForOperator: 'NOT_ESTABLISHED', approvalEntitlement: 'NOT_VERIFIED',
  retentionContent: 'UNRESOLVED_ROUTE_SPECIFIC_REVIEW_REQUIRED', retentionIdentity: 'UNRESOLVED_ROUTE_SPECIFIC_REVIEW_REQUIRED',
  realtimeDelivery: 'NOT_DOCUMENTED', evidence: FOUNDATION_EVIDENCE, ...TIKTOK_DECISION,
});
const route = (o) => deepFreeze({ ...COMMON, ...FOUNDATION_LIVE_FACTS, ...o });

// Route ids equal the registry's TIKTOK_PUBLIC.routes keys (a test pins this).
export const TIKTOK_ROUTES = Object.freeze({
  RESEARCH: route({
    id: 'RESEARCH', registryRoute: 'RESEARCH', platformPath: 'DOCUMENTED',
    payloadScope: 'Research API video/comment/user queries over indexed public content (30-day windows, cursor + search_id); new videos enter search up to 48 h late; some metrics refresh up to 10 days late', evidenceClass: 'RESEARCH_INDEXED_ORGANIC', contentKinds: ['VIDEO'],
    eligibilityRequirements: ['ELIGIBLE_INSTITUTION_AFFILIATION', 'NON_COMMERCIAL_RESEARCH_BASIS', 'ETHICS_REVIEW', 'PROJECT_APPROVAL', 'DEVELOPER_ACCOUNT'], extraAgreement: { applicability: 'RESEARCH_TERMS_AND_DATA_SECURITY_COMMITMENTS', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], permittedUses: ['NON_COMMERCIAL_PUBLIC_INTEREST_RESEARCH'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', indexingDelay: { maxHours: 48, basis: 'T1' }, metricRefreshDelay: { maxDays: 10, basis: 'T1' }, quota: { requestsPerDay: 1000, recordsPerDay: 100000, resetUtc: '00:00', basis: 'T1' }, documentation: ['T1', 'T3', 'T3V'],
  }),
  DISPLAY: route({
    id: 'DISPLAY', registryRoute: 'DISPLAY', platformPath: 'DOCUMENTED',
    payloadScope: 'the AUTHORIZING user\'s own profile and videos (scopes user.info.basic, video.list; max_count 20) — not organic discovery', evidenceClass: 'OWN_VIDEOS_ONLY', contentKinds: ['VIDEO'],
    eligibilityRequirements: ['DEVELOPER_ACCOUNT', 'USER_AUTHORIZATION'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], permittedUses: ['DISPLAY_AUTHORIZING_USER_CONTENT'],
    implementationStage: 'DESCRIPTOR_AND_FIXTURE_PREVIEW', previewSupport: 'SUPPORTED', indexingDelay: null, metricRefreshDelay: null, quota: { videosPerPageMax: 20, basis: 'T2V' }, documentation: ['T2', 'T2V'],
  }),
  COMMERCIAL_CONTENT: route({
    id: 'COMMERCIAL_CONTENT', registryRoute: 'COMMERCIAL_CONTENT', platformPath: 'DOCUMENTED',
    payloadScope: 'paid ads, advertiser data, and other commercial content (EU data in this phase) — a commercial dataset, never the organic feed', evidenceClass: 'COMMERCIAL_DATASET', contentKinds: [],
    eligibilityRequirements: ['DEVELOPER_ACCOUNT', 'APPLICATION_APPROVAL', 'CLIENT_KEY_ISSUED'], extraAgreement: { applicability: 'NOT_DOCUMENTED', satisfied: 'UNRESOLVED' },
    credentialConfiguration: 'ENV_NAMES', credentialEnvs: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], permittedUses: ['AD_TRANSPARENCY_SEARCH'],
    implementationStage: 'DESCRIPTOR_ONLY', previewSupport: 'PREVIEW_UNSUPPORTED_DOCUMENTATION_UNVERIFIED', indexingDelay: null, metricRefreshDelay: null, quota: null, documentation: ['T4'],
  }),
});
export const TIKTOK_ROUTE_IDS = Object.freeze(Object.keys(TIKTOK_ROUTES));
export const tiktokRoute = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(TIKTOK_ROUTES, id) ? TIKTOK_ROUTES[id] : null);
export const TIKTOK_ROUTE_SUMMARY_KEYS = FOUNDATION_ROUTE_SUMMARY_KEYS;
export function tiktokRouteSummary(routeId) {
  const r = tiktokRoute(routeId);
  if (r === null) return null;
  const docs = r.documentation.map((k) => TIKTOK_DOCUMENTATION[k]);
  return deepFreeze({ provider: TIKTOK_PROVIDER_ID, ...r, documentation: docs, documentationStatus: docs.every((d) => d.status === 'VERIFIED') ? 'VERIFIED' : 'DOCUMENTATION_UNVERIFIED' });
}

// ---- operator access record: bound to ONE product ---------------------------------
const RECORD_KEYS = Object.freeze(['route', 'approvalRef', 'status', 'application', 'useCaseVersion', 'attested', 'permittedUses', 'additionalAgreement', 'additionalAgreementSatisfied', 'validUntil', 'retentionContent', 'retentionIdentity', 'reviewedOn']);
export function tiktokRouteRecordFromEnv(env = process.env) {
  const p = 'RUMOR2_SOCIAL_TIKTOK_ROUTE_';
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
  if (error === null && tiktokRoute(r.route) === null) error = `access record: unknown route '${r.route}'`;
  if (error === null && (!Array.isArray(r.attested) || r.attested.length > TIKTOK_PREREQUISITES.length || r.attested.some((a) => !TIKTOK_PREREQUISITES.includes(a)) || new Set(r.attested).size !== r.attested.length)) error = 'access record: attested outside the closed prerequisite vocabulary';
  return { error, dates };
}
export const validateTiktokRouteRecord = (r) => inspectRecord(r).error;
export function tiktokCredentialsPresent(env = process.env, routeId) {
  const r = tiktokRoute(routeId);
  if (r === null) return false;
  return r.credentialEnvs.every((k) => typeof env?.[k] === 'string' && env[k].length > 0);
}

// The closed product access evaluation. A credential never supplies affiliation or
// approval; a record for another product contributes nothing; the registry decision
// is carried unchanged on every result.
export function evaluateTiktokRouteAccess({ routeId, record = null, env = process.env, nowMs = null, description = null } = {}) {
  const r = tiktokRoute(routeId);
  const blockers = []; const advisories = [];
  const clockKnown = isSupportedFoundationClock(nowMs);
  if (!clockKnown) blockers.push(nowMs === null || nowMs === undefined ? 'CLOCK_UNAVAILABLE' : 'CLOCK_INVALID');
  if (description !== null) advisories.push('SELF_DESCRIPTION_IS_NOT_PERMISSION');
  if (r === null) {
    blockers.push('ROUTE_UNKNOWN');
    return deepFreeze({ provider: TIKTOK_PROVIDER_ID, route: null, evidenceClass: null, ...TIKTOK_DECISION, eligibilityEstablishedForOperator: 'NOT_ESTABLISHED', approvalStatus: 'NOT_VERIFIED', additionalAgreement: 'UNRESOLVED', retentionContent: 'UNRESOLVED', retentionIdentity: 'UNRESOLVED', credentialPresent: false, permittedUses: [], missingPrerequisites: [], downstream: { inference: false, training: false, derivedFeatures: false, redistribution: false }, prerequisites: {}, activationPrerequisitesMet: false, ...FOUNDATION_LIVE_FACTS, durableReason: 'ROUTE_UNKNOWN', evidence: FOUNDATION_EVIDENCE, blockers, advisories });
  }
  if (r.evidenceClass !== 'RESEARCH_INDEXED_ORGANIC') advisories.push(`NOT_ORGANIC_DISCOVERY: ${r.evidenceClass}`);
  if (r.indexingDelay !== null) advisories.push(`ROUTE_INDEXING_DELAY_UP_TO_${r.indexingDelay.maxHours}H`);
  const credentialPresent = tiktokCredentialsPresent(env, routeId);
  let approvalStatus = 'NOT_VERIFIED'; let agreement = 'UNRESOLVED'; let retentionContent = 'UNRESOLVED'; let retentionIdentity = 'UNRESOLVED';
  let permittedUses = []; let reviewOk = false; let missing = [...r.eligibilityRequirements]; let attestedForRoute = false;
  if (record === null) blockers.push('APPROVAL_RECORD_MISSING');
  else {
    const inspected = inspectRecord(record);
    if (inspected.error) blockers.push(`APPROVAL_RECORD_INVALID: ${inspected.error}`);
    else if (!clockKnown) { /* nothing time-dependent can be judged */ }
    else {
      const out = foundationApprovalOutcome({ record, dates: inspected.dates, nowMs, applicationId: TIKTOK_APPLICATION_ID, useCaseVersion: TIKTOK_USE_CASE_VERSION, scopeMatch: record.route === r.id, scopeMismatchBlocker: `APPROVAL_ROUTE_MISMATCH: the record binds ${record.route}, not ${r.id}` });
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
  if (!credentialPresent) blockers.push('CREDENTIAL_MISSING');
  else if (!attestedForRoute) advisories.push('CREDENTIAL_IS_CONFIGURATION_NOT_AFFILIATION_OR_APPROVAL');
  const eligibility = attestedForRoute && missing.length === 0 ? 'OPERATOR_ATTESTED' : 'NOT_ESTABLISHED';
  const prerequisites = Object.freeze({
    clock: clockKnown,
    review: clockKnown && record !== null && reviewOk,
    approval: approvalStatus === 'OPERATOR_ATTESTED',
    eligibility: eligibility === 'OPERATOR_ATTESTED',
    agreement: agreementSatisfied(agreement),
    retentionContent: retentionContent === 'COMPATIBLE_REVIEWED',
    retentionIdentity: retentionIdentity === 'COMPATIBLE_REVIEWED',
    retrieval: permittedUses.includes('RETRIEVAL'),
    credential: credentialPresent,
  });
  return deepFreeze({
    provider: TIKTOK_PROVIDER_ID, route: r.id, evidenceClass: r.evidenceClass, ...TIKTOK_DECISION,
    eligibilityEstablishedForOperator: eligibility, approvalStatus, additionalAgreement: agreement, retentionContent, retentionIdentity,
    credentialPresent, permittedUses, missingPrerequisites: missing,
    downstream: { inference: permittedUses.includes('MODEL_INFERENCE'), training: permittedUses.includes('MODEL_TRAINING'), derivedFeatures: permittedUses.includes('DERIVED_FEATURES'), redistribution: permittedUses.includes('REDISTRIBUTION') },
    prerequisites, activationPrerequisitesMet: foundationReadiness(prerequisites, blockers),
    ...FOUNDATION_LIVE_FACTS, durableReason: prerequisites.retentionContent && prerequisites.retentionIdentity ? 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED' : 'RETENTION_COMPATIBILITY_UNRESOLVED',
    evidence: FOUNDATION_EVIDENCE, blockers, advisories,
  });
}

// ---- documented epoch-second clock: parsed ONLY as seconds, with a range check --------
// A value outside the documented-unit window is UNSUPPORTED_RANGE, never rescaled: a
// millisecond-looking integer is NOT divided by 1000, a string is NOT parsed, a float is
// NOT rounded. The declaration is preserved beside the outcome.
export const TIKTOK_EPOCH_SECONDS_MIN = 1_262_304_000; // 2010-01-01T00:00:00Z
export const TIKTOK_EPOCH_SECONDS_MAX = 4_102_444_800; // 2100-01-01T00:00:00Z
export const TIKTOK_CLOCK_STATUSES = Object.freeze(['INSTANT', 'ABSENT', 'TYPE_MISMATCH', 'NOT_AN_INTEGER', 'UNSUPPORTED_RANGE']);
export function tiktokEpochSeconds(v) {
  if (v === undefined || v === null) return Object.freeze({ declared: null, unit: 'UNIX_SECONDS_DOCUMENTED', status: 'ABSENT', instantMs: null });
  if (typeof v !== 'number') return Object.freeze({ declared: typeof v === 'string' ? v.slice(0, 64) : null, declaredType: typeof v, unit: 'UNIX_SECONDS_DOCUMENTED', status: 'TYPE_MISMATCH', instantMs: null });
  if (!Number.isSafeInteger(v)) return Object.freeze({ declared: Number.isFinite(v) ? v : null, unit: 'UNIX_SECONDS_DOCUMENTED', status: 'NOT_AN_INTEGER', instantMs: null });
  if (v < TIKTOK_EPOCH_SECONDS_MIN || v > TIKTOK_EPOCH_SECONDS_MAX) return Object.freeze({ declared: v, unit: 'UNIX_SECONDS_DOCUMENTED', status: 'UNSUPPORTED_RANGE', instantMs: null });
  return Object.freeze({ declared: v, unit: 'UNIX_SECONDS_DOCUMENTED', status: 'INSTANT', instantMs: v * 1000 });
}

// ---- fixture-only preview typed by product and content kind --------------------------
const DIGITS_RE = /^\d{1,25}$/;
const REGION_RE = /^[A-Z]{2}$/;
const MAX_HASHTAGS = 16; const MAX_HASHTAG_CHARS = 64; const DOCUMENTED_DESCRIPTION_CHARS = 150; const PREVIEW_TEXT_CHARS = 280;
const derivePreviewText = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_TEXT_CHARS) : null);
const unsupported = (reason, extra = {}) => ({ unsupported: deepFreeze({ reason, ...extra }) });
const skip = (reason) => ({ skip: true, reason });
// Research ids are documented int64: a digit string is preserved; a SAFE integer is rendered
// as its exact decimal; anything else (unsafe number, float, other type) is refused because
// the exact id can no longer be known. Display ids are documented strings: strings only.
function researchId(v) {
  if (typeof v === 'string') return DIGITS_RE.test(v) ? { id: v, source: 'STRING' } : { error: 'ID_MALFORMED' };
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? { id: String(v), source: 'SAFE_INTEGER' } : { error: 'ID_PRECISION_LOST' };
  return { error: v === undefined ? 'ID_ABSENT' : 'ID_TYPE_MISMATCH' };
}
function displayId(v) {
  if (typeof v === 'string') return DIGITS_RE.test(v) && v.length <= MAX_NATIVE_ID_CHARS ? { id: v, source: 'STRING' } : { error: 'ID_MALFORMED' };
  return { error: v === undefined ? 'ID_ABSENT' : 'ID_TYPE_MISMATCH' };
}
function textFacts(text, absenceReason) {
  if (typeof text !== 'string') return { contentAvailable: false, contentAbsence: absenceReason, originalText: null, previewText: null, overDocumentedLength: null };
  const bounded = text.slice(0, MAX_SOCIAL_TEXT_CHARS);
  return { contentAvailable: true, contentAbsence: null, originalText: bounded, previewText: derivePreviewText(bounded), overDocumentedLength: text.length > DOCUMENTED_DESCRIPTION_CHARS };
}
function hashtags(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const h of list) { if (isBoundedString(h, MAX_HASHTAG_CHARS)) out.push(h); if (out.length === MAX_HASHTAGS) break; }
  return Object.freeze(out);
}

export function tiktokVideoToPreview({ routeId, video } = {}, { retrievedTs } = {}) {
  if (!isSupportedFoundationClock(retrievedTs)) return skip('retrievedTs (the caller\'s knowledge clock) must be a supported epoch-ms timestamp; the adapter never reads a wall clock');
  const r = tiktokRoute(routeId);
  if (r === null) return unsupported('ROUTE_UNKNOWN');
  if (r.previewSupport !== 'SUPPORTED') return unsupported(r.previewSupport, { route: r.id, evidenceClass: r.evidenceClass });
  if (!isPlainObject(video)) return skip('video not an object');
  const idr = r.id === 'RESEARCH' ? researchId(video.id) : displayId(video.id);
  if (idr.error) return skip(idr.error);
  const created = tiktokEpochSeconds(video.create_time);
  const clock = created.instantMs === null ? { sourceClockStatus: 'UNKNOWN', sourceClockSkewMs: null } : classifySourceClock({ sourceDeclaredTs: created.instantMs, retrievedTs });
  const description = textFacts(video.video_description, 'DESCRIPTION_NOT_SUPPLIED_NOT_DELETION');
  const username = r.id === 'RESEARCH' && isBoundedString(video.username, MAX_SOCIAL_HANDLE_CHARS) ? video.username : null;
  return { preview: deepFreeze({
    ...FOUNDATION_PREVIEW_FACTS, provider: TIKTOK_PROVIDER_ID, route: r.id, kind: 'VIDEO', evidenceClass: r.evidenceClass, ...TIKTOK_DECISION,
    nativeContentId: idr.id, nativeIdNamespace: r.id === 'RESEARCH' ? 'TIKTOK_RESEARCH_VIDEO_ID' : 'TIKTOK_DISPLAY_VIDEO_ID', idSource: idr.source,
    // NO author identity: username / display_name / nickname are mutable labels, never identity
    actor: { kind: 'TIKTOK_USER', nativeId: null, identity: 'UNAVAILABLE_LABELS_ARE_NOT_IDENTITY', usernameDescriptive: username },
    relation: 'VIDEO', parent: null, crossPlatformIdentity: 'NONE', deletionSignal: 'NONE',
    ...description, title: r.id === 'DISPLAY' && typeof video.title === 'string' ? video.title.slice(0, MAX_SOCIAL_TEXT_CHARS) : null,
    hashtags: r.id === 'RESEARCH' ? hashtags(video.hashtag_names) : null,
    regionCode: r.id === 'RESEARCH' && typeof video.region_code === 'string' && REGION_RE.test(video.region_code) ? video.region_code : null,
    shareUrl: r.id === 'DISPLAY' && isBoundedString(video.share_url, MAX_SOCIAL_URL_CHARS) && video.share_url.startsWith('https://') ? video.share_url : null,
    // FOUR distinct clocks; each unknown when not supplied, never derived from another
    sourceCreated: created, sourceCreatedTs: created.instantMs, sourceClockStatus: clock.sourceClockStatus, sourceClockSkewMs: clock.sourceClockSkewMs,
    indexedTs: null, indexedStatus: r.indexingDelay === null ? 'NOT_APPLICABLE_UNKNOWN' : `UNKNOWN_ROUTE_DELAY_UP_TO_${r.indexingDelay.maxHours}H`,
    metricUpdatedTs: null, metricUpdatedStatus: r.metricRefreshDelay === null ? 'UNKNOWN' : `UNKNOWN_ROUTE_REFRESH_UP_TO_${r.metricRefreshDelay.maxDays}D`,
    retrievedTs,
    metrics: { kind: 'FIRST_KNOWN_DIAGNOSTIC_SNAPSHOT', asOf: 'UNKNOWN', likes: nonNegativeInt(video.like_count), comments: nonNegativeInt(video.comment_count), shares: nonNegativeInt(video.share_count), views: nonNegativeInt(video.view_count), favorites: r.id === 'RESEARCH' ? nonNegativeInt(video.favorites_count) : null },
    durationSeconds: nonNegativeInt(r.id === 'RESEARCH' ? video.video_duration : video.duration),
    nativeVersionId: null, providerEventSeq: null,
  }) };
}
