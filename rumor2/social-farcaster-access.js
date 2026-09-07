// SOCIAL-4E — Farcaster (Neynar hosted API) ACCESS / READINESS BOUNDARY. Pure.
// This module performs NO request, NO webhook, NO poller, NO Kafka/gRPC client,
// NO collector or journal wiring, holds NO key value, and leaves the existing
// provider adapter (rumor2/providers/farcaster-official.js) byte-identical —
// it only REUSES that adapter's key-presence boolean and static descriptor.
//
// WHAT IT SEPARATES (doctrine/SOCIAL.md §5P; first-party pages read 2026-09-07):
//   * PUBLISHED plan/reference limits vs THIS account's plan and credits. Neynar
//     publishes a Free plan (600 RPM / 10 RPS per endpoint; cast search 120 RPM;
//     1000 RPM global; limits per subscription plan, independent of credits —
//     N1). This project's plan, credits, and entitlement are UNKNOWN/UNVERIFIED.
//     Pricing (N3) and terms (N4) could not be read: DOCUMENTATION_UNVERIFIED.
//   * Key PRESENCE vs entitlement: NEYNAR_API_KEY present is configuration only.
//   * The SUGGESTED acquisition path (search polling, N2: q, limit ≤ 100, cursor,
//     chronological sort — no freshness or completeness statement) vs an
//     APPROVED choice. Pagination documented ≠ complete coverage proven.
//   * Unmeasured lag vs a real-time lead: nothing here has been measured.
//   * Webhook authentication documented ≠ delivery completeness, ordering, or
//     replay proven.
//   Readiness = all prerequisites satisfied AND zero blockers; even then there
//   is no live path: liveAllowed false, durable* false, FOUNDATION_ONLY_NO_LIVE_PATH.
import { FARCASTER_OFFICIAL, farcasterConfigured } from './providers/farcaster-official.js';
import {
  SOCIAL_FOUNDATION_APPLICATION_ID, isSupportedFoundationClock, FOUNDATION_LIVE_FACTS, FOUNDATION_EVIDENCE, FOUNDATION_ROUTE_SUMMARY_KEYS,
  isBoundedString, csvList, deepFreeze, docRef,
  foundationDates, validateFoundationRecordCore, foundationApprovalOutcome, foundationAgreementState, agreementSatisfied, agreementBlocker, retentionBlocker, foundationReadiness,
} from './social-foundation.js';

export const FARCASTER_PROVIDER_ID = FARCASTER_OFFICIAL.id;
export const FARCASTER_ACCESS_FOUNDATION = Object.freeze({ fixtureOnly: true, liveTransport: false, apiRequests: false, webhookReceiver: false, poller: false, kafkaClient: false, hubClient: false, collectorWiring: false, journalWriter: false, modelCalls: false, persistentCache: false, providerAdapterModified: false });
export const FARCASTER_APPLICATION_ID = SOCIAL_FOUNDATION_APPLICATION_ID;
export const FARCASTER_USE_CASE_VERSION = 'serpent-farcaster-use-case-v1';

const ACCESSED = '2026-09-07';
export const FARCASTER_DOCUMENTATION = Object.freeze({
  N1: docRef({ id: 'N1', url: 'https://docs.neynar.com/reference/what-are-the-rate-limits-on-neynar-apis', accessedOn: ACCESSED, status: 'VERIFIED', note: 'Free: 600 RPM or 10 RPS per endpoint; Scale: 1200 RPM / 20 RPS; cast search 120 RPM (Free) / 240 (Scale); global 1000 RPM (Free) / 2000 (Scale); legacy Starter/Growth grandfathered; "Rate limits are based on requests per min and are fully independent of overall credits usage"; enforced per endpoint and per subscription plan.' }),
  N2: docRef({ id: 'N2', url: 'https://docs.neynar.com/reference/search-casts', accessedOn: ACCESSED, status: 'VERIFIED', note: 'search-casts: q (required, operators incl. before:/after:), limit max 100 (default 25), cursor, sort_type desc_chron|chron, mode literal|semantic|hybrid, author_fid, parent_url, channel_id; response casts[] + next.cursor; NO statement on freshness, indexing lag, or completeness.' }),
  N3: docRef({ id: 'N3', url: 'https://dev.neynar.com/pricing', accessedOn: ACCESSED, status: 'DOCUMENTATION_UNVERIFIED', note: 'Pricing page returned only a logo/header shell on read (client-rendered); plan prices, credits, and commercial-use terms could not be verified. A retrieval failure is not an access decision.' }),
  N4: docRef({ id: 'N4', url: 'https://neynar.com/terms', accessedOn: ACCESSED, status: 'DOCUMENTATION_UNVERIFIED', note: 'First-party terms: HTTP 404 at /terms and /terms-of-service on read (one recheck each). Permitted use, retention/deletion, and prohibited uses remain unverified — consistent with the registry\'s termsRetrieval FAILED_2026-09-06.' }),
});

// ---- published reference facts (never this account's entitlement) ---------------------
export const NEYNAR_PUBLISHED_REFERENCE = deepFreeze({
  accessedOn: ACCESSED, basis: 'PUBLISHED_REFERENCE_NOT_ACCOUNT_ENTITLEMENT',
  plans: {
    FREE: { rpmPerEndpoint: 600, rpsPerEndpoint: 10, castSearchRpm: 120, globalRpm: 1000, documentation: 'N1' },
    SCALE: { rpmPerEndpoint: 1200, rpsPerEndpoint: 20, castSearchRpm: 240, globalRpm: 2000, documentation: 'N1' },
    LEGACY: { rpmPerEndpoint: null, rpsPerEndpoint: null, castSearchRpm: null, globalRpm: null, documentation: 'N1', note: 'grandfathered Starter/Growth; exact per-account limits not asserted' },
  },
  limitsIndependentOfCredits: true,
  searchCasts: { maxLimit: 100, defaultLimit: 25, pagination: 'CURSOR', sortTypes: ['desc_chron', 'chron'], dateOperators: ['before:', 'after:'], freshnessStatement: 'NONE_DOCUMENTED', completenessStatement: 'NONE_DOCUMENTED', documentation: 'N2' },
  pricing: 'DOCUMENTATION_UNVERIFIED', terms: 'DOCUMENTATION_UNVERIFIED',
});

export const FARCASTER_PLAN_STATES = Object.freeze(['UNKNOWN', 'FREE', 'SCALE', 'LEGACY']);
export const FARCASTER_CREDIT_STATES = Object.freeze(['UNKNOWN', 'AVAILABLE', 'EXHAUSTED']);
export const FARCASTER_TERMS_STATES = Object.freeze(['UNRESOLVED', 'REVIEWED_PERMITS', 'REVIEWED_PROHIBITS']);
export const FARCASTER_ACQUISITION_PATHS = Object.freeze(['UNDECIDED', 'SEARCH_POLLING', 'WEBHOOK', 'KAFKA_STREAM', 'HUB_GRPC']);
export const FARCASTER_SUGGESTED_ACQUISITION_PATH = 'SEARCH_POLLING'; // a PROPOSAL from the census — never an approved choice

// The access-boundary summary answers the standard route questions for ONE route:
// the hosted-API path this project could use, described without assuming it.
export const FARCASTER_ACCESS_ROUTE = deepFreeze({
  id: 'NEYNAR_HOSTED_API', provider: FARCASTER_PROVIDER_ID, platformPath: 'DOCUMENTED',
  payloadScope: 'Neynar hosted API: cast search (polling), event webhooks, Kafka stream, gRPC hub access; casts carry hash, author fid, text, parent, RFC 3339 timestamp, reaction counts',
  evidenceClass: 'PUBLIC_CASTS', eligibilityRequirements: ['ACCOUNT_PLAN_KNOWN', 'CREDITS_AVAILABLE', 'TERMS_REVIEWED_PERMIT', 'ACQUISITION_PATH_APPROVED'],
  eligibilityEstablishedForOperator: 'NOT_ESTABLISHED', approvalEntitlement: 'UNVERIFIED',
  credentialConfiguration: 'ENV_NAMES', credentialEnvs: [FARCASTER_OFFICIAL.credentialEnv], permittedUses: ['DOCUMENTATION_UNVERIFIED'],
  extraAgreement: { applicability: 'DOCUMENTATION_UNVERIFIED', satisfied: 'UNRESOLVED' },
  retentionContent: 'UNRESOLVED', retentionIdentity: 'UNRESOLVED',
  implementationStage: 'ACCESS_BOUNDARY_ONLY', // mapper exists in the provider adapter; NO transport, poller, webhook, collector, or journal wiring
  acquisition: { suggested: FARCASTER_SUGGESTED_ACQUISITION_PATH, approved: false, pagination: 'CURSOR_DOCUMENTED', completeness: 'UNPROVEN' },
  lag: { measured: false, status: 'UNMEASURED', realTimeLead: 'UNPROVEN' },
  webhook: { authentication: 'DOCUMENTED_NOT_IMPLEMENTED', completeness: 'UNPROVEN', ordering: 'UNPROVEN', replay: 'UNPROVEN' },
  ...FOUNDATION_LIVE_FACTS, evidence: FOUNDATION_EVIDENCE, documentation: Object.values(FARCASTER_DOCUMENTATION),
  documentationStatus: 'DOCUMENTATION_UNVERIFIED', // pricing and terms could not be read
});
export const FARCASTER_ROUTE_SUMMARY_KEYS = FOUNDATION_ROUTE_SUMMARY_KEYS;
export const farcasterAccessSummary = () => FARCASTER_ACCESS_ROUTE;

// ---- operator account record -------------------------------------------------------
const RECORD_KEYS = Object.freeze(['approvalRef', 'status', 'application', 'useCaseVersion', 'plan', 'credits', 'termsReview', 'permittedUses', 'acquisitionPath', 'acquisitionApproved', 'additionalAgreement', 'additionalAgreementSatisfied', 'validUntil', 'retentionContent', 'retentionIdentity', 'reviewedOn']);
export function farcasterAccountRecordFromEnv(env = process.env) {
  const p = 'RUMOR2_SOCIAL_FARCASTER_ACCOUNT_';
  const keys = ['REF', 'STATUS', 'APPLICATION', 'USE_CASE_VERSION', 'PLAN', 'CREDITS', 'TERMS_REVIEW', 'PERMITTED_USES', 'ACQUISITION_PATH', 'ACQUISITION_APPROVED', 'ADDITIONAL_AGREEMENT', 'ADDITIONAL_AGREEMENT_SATISFIED', 'VALID_UNTIL', 'RETENTION_CONTENT', 'RETENTION_IDENTITY', 'REVIEWED_ON'];
  if (!keys.some((k) => typeof env?.[p + k] === 'string' && env[p + k].length > 0)) return null;
  const g = (k) => (typeof env?.[p + k] === 'string' && env[p + k].length > 0 ? env[p + k] : null);
  return {
    approvalRef: g('REF'), status: g('STATUS'), application: g('APPLICATION'), useCaseVersion: g('USE_CASE_VERSION'),
    plan: g('PLAN') ?? 'UNKNOWN', credits: g('CREDITS') ?? 'UNKNOWN', termsReview: g('TERMS_REVIEW') ?? 'UNRESOLVED',
    permittedUses: csvList(g('PERMITTED_USES')), acquisitionPath: g('ACQUISITION_PATH') ?? 'UNDECIDED', acquisitionApproved: g('ACQUISITION_APPROVED') === 'true',
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
  if (error === null && !FARCASTER_PLAN_STATES.includes(r.plan)) error = `access record: unknown plan '${r.plan}'`;
  if (error === null && !FARCASTER_CREDIT_STATES.includes(r.credits)) error = `access record: unknown credits '${r.credits}'`;
  if (error === null && !FARCASTER_TERMS_STATES.includes(r.termsReview)) error = `access record: unknown termsReview '${r.termsReview}'`;
  if (error === null && !FARCASTER_ACQUISITION_PATHS.includes(r.acquisitionPath)) error = `access record: unknown acquisitionPath '${r.acquisitionPath}'`;
  if (error === null && typeof r.acquisitionApproved !== 'boolean') error = 'access record: acquisitionApproved must be boolean';
  if (error === null && r.acquisitionApproved && r.acquisitionPath === 'UNDECIDED') error = 'access record: an UNDECIDED acquisition path cannot be approved';
  return { error, dates };
}
export const validateFarcasterAccountRecord = (r) => inspectRecord(r).error;
export const farcasterKeyPresent = (env = process.env) => farcasterConfigured(env); // presence only; the value is never read out

// The closed access evaluation. Every dimension is judged independently and each
// unmet dimension is its own blocker: a key, a published Free plan, an approval for
// another scope, or credits alone can never authorize; an independent clock, expiry,
// terms, or retention blocker stands on its own.
export function evaluateFarcasterAccess({ record = null, env = process.env, nowMs = null, description = null } = {}) {
  const blockers = []; const advisories = [];
  const clockKnown = isSupportedFoundationClock(nowMs);
  if (!clockKnown) blockers.push(nowMs === null || nowMs === undefined ? 'CLOCK_UNAVAILABLE' : 'CLOCK_INVALID');
  if (description !== null) advisories.push('SELF_DESCRIPTION_IS_NOT_PERMISSION');
  const keyPresent = farcasterKeyPresent(env);
  if (!keyPresent) blockers.push('KEY_MISSING'); else advisories.push('KEY_PRESENCE_IS_CONFIGURATION_NOT_ENTITLEMENT');
  advisories.push('TERMS_DOCUMENTATION_UNVERIFIED', 'PRICING_DOCUMENTATION_UNVERIFIED', 'LAG_UNMEASURED', 'COVERAGE_COMPLETENESS_UNPROVEN', 'WEBHOOK_DELIVERY_GUARANTEES_UNPROVEN');
  let approvalStatus = 'NOT_VERIFIED'; let plan = 'UNKNOWN'; let credits = 'UNKNOWN'; let terms = 'UNRESOLVED'; let agreement = 'UNRESOLVED';
  let retentionContent = 'UNRESOLVED'; let retentionIdentity = 'UNRESOLVED'; let permittedUses = []; let reviewOk = false;
  let acquisition = { suggested: FARCASTER_SUGGESTED_ACQUISITION_PATH, chosen: 'UNDECIDED', approved: false };
  if (record === null) blockers.push('ACCOUNT_RECORD_MISSING');
  else {
    const inspected = inspectRecord(record);
    if (inspected.error) blockers.push(`ACCOUNT_RECORD_INVALID: ${inspected.error}`);
    else if (!clockKnown) { /* nothing time-dependent can be judged */ }
    else {
      const out = foundationApprovalOutcome({ record, dates: inspected.dates, nowMs, applicationId: FARCASTER_APPLICATION_ID, useCaseVersion: FARCASTER_USE_CASE_VERSION });
      approvalStatus = out.approvalStatus; reviewOk = out.reviewOk; blockers.push(...out.blockers); advisories.push(...out.advisories);
      if (approvalStatus === 'OPERATOR_ATTESTED') {
        plan = record.plan; credits = record.credits; terms = record.termsReview;
        if (plan === 'UNKNOWN') blockers.push('PLAN_UNKNOWN');
        if (credits === 'UNKNOWN') blockers.push('CREDITS_UNKNOWN'); else if (credits === 'EXHAUSTED') blockers.push('CREDITS_EXHAUSTED');
        if (terms === 'UNRESOLVED') blockers.push('TERMS_UNRESOLVED'); else if (terms === 'REVIEWED_PROHIBITS') blockers.push('TERMS_PROHIBIT_USE');
        acquisition = { suggested: FARCASTER_SUGGESTED_ACQUISITION_PATH, chosen: record.acquisitionPath, approved: record.acquisitionApproved };
        if (!record.acquisitionApproved) blockers.push('ACQUISITION_PATH_NOT_APPROVED');
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
  const prerequisites = Object.freeze({
    clock: clockKnown,
    key: keyPresent,
    review: clockKnown && record !== null && reviewOk,
    entitlement: approvalStatus === 'OPERATOR_ATTESTED',
    plan: plan !== 'UNKNOWN',
    credits: credits === 'AVAILABLE',
    terms: terms === 'REVIEWED_PERMITS',
    acquisition: acquisition.approved === true,
    agreement: agreementSatisfied(agreement),
    retentionContent: retentionContent === 'COMPATIBLE_REVIEWED',
    retentionIdentity: retentionIdentity === 'COMPATIBLE_REVIEWED',
    retrieval: permittedUses.includes('RETRIEVAL'),
  });
  return deepFreeze({
    provider: FARCASTER_PROVIDER_ID, route: FARCASTER_ACCESS_ROUTE.id,
    keyPresent, keyMeaning: 'CONFIGURATION_ONLY',
    plan: { published: 'FREE_PLAN_DOCUMENTED', thisAccount: plan, publishedReferenceLimits: plan === 'UNKNOWN' ? null : NEYNAR_PUBLISHED_REFERENCE.plans[plan], accountLimits: 'UNVERIFIED' },
    credits, entitlement: approvalStatus, terms: { review: terms, documentation: 'DOCUMENTATION_UNVERIFIED' }, pricingDocumentation: 'DOCUMENTATION_UNVERIFIED',
    acquisition: { ...acquisition, pagination: 'CURSOR_DOCUMENTED', completeness: 'UNPROVEN' },
    lag: { measured: false, status: 'UNMEASURED', realTimeLead: 'UNPROVEN' },
    webhook: { authentication: 'DOCUMENTED_NOT_IMPLEMENTED', completeness: 'UNPROVEN', ordering: 'UNPROVEN', replay: 'UNPROVEN' },
    additionalAgreement: agreement, retentionContent, retentionIdentity, permittedUses,
    downstream: { inference: permittedUses.includes('MODEL_INFERENCE'), training: permittedUses.includes('MODEL_TRAINING'), derivedFeatures: permittedUses.includes('DERIVED_FEATURES'), redistribution: permittedUses.includes('REDISTRIBUTION') },
    prerequisites, activationPrerequisitesMet: foundationReadiness(prerequisites, blockers),
    ...FOUNDATION_LIVE_FACTS, durableReason: prerequisites.retentionContent && prerequisites.retentionIdentity ? 'RETENTION_COMPATIBLE_DESIGN_NOT_IMPLEMENTED' : 'RETENTION_COMPATIBILITY_UNRESOLVED',
    transport: { implemented: false, poller: false, webhookReceiver: false, collectorWiring: false, journalWriter: false },
    evidence: FOUNDATION_EVIDENCE, blockers, advisories,
  });
}

// Whether a caller-described search request would fit the PUBLISHED reference shape.
// Pure shape reasoning about a hypothetical request — nothing is sent. `limit` above the
// documented maximum is refused rather than clamped; unknown fields are refused.
export function farcasterSearchRequestShape({ q, limit = NEYNAR_PUBLISHED_REFERENCE.searchCasts.defaultLimit, cursor = null, sortType = 'desc_chron' } = {}) {
  if (!isBoundedString(q, 500)) return { error: 'QUERY_REQUIRED' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NEYNAR_PUBLISHED_REFERENCE.searchCasts.maxLimit) return { error: 'LIMIT_OUTSIDE_DOCUMENTED_RANGE' };
  if (cursor !== null && !isBoundedString(cursor, 500)) return { error: 'CURSOR_MALFORMED' };
  if (!NEYNAR_PUBLISHED_REFERENCE.searchCasts.sortTypes.includes(sortType)) return { error: 'SORT_TYPE_UNDOCUMENTED' };
  return { shape: deepFreeze({ endpoint: 'search-casts', q, limit, cursor, sortType, sent: false, coverage: 'PAGE_ONLY_COMPLETENESS_UNPROVEN', freshness: 'UNDOCUMENTED' }) };
}
