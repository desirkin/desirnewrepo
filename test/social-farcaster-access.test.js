// SOCIAL-4E Stage 3 — Farcaster (Neynar) access / readiness boundary. Pure, non-live.
// Asserts CORRECT behaviour: the provider adapter is byte-identical; a key, a
// published Free plan, an unrelated approval, or credits alone can never authorize;
// clock / expiry / terms / retention blockers are independent; published reference
// limits are never this account's entitlement; pagination is never complete
// coverage; unmeasured lag is never a real-time lead; webhook authentication is
// never delivery completeness, ordering, or replay; no runtime imports the boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';
import {
  FARCASTER_PROVIDER_ID, FARCASTER_ACCESS_FOUNDATION, FARCASTER_DOCUMENTATION, NEYNAR_PUBLISHED_REFERENCE, FARCASTER_ACCESS_ROUTE, FARCASTER_ROUTE_SUMMARY_KEYS,
  FARCASTER_APPLICATION_ID, FARCASTER_USE_CASE_VERSION, FARCASTER_PLAN_STATES, FARCASTER_CREDIT_STATES, FARCASTER_TERMS_STATES, FARCASTER_ACQUISITION_PATHS, FARCASTER_SUGGESTED_ACQUISITION_PATH,
  farcasterAccessSummary, farcasterAccountRecordFromEnv, validateFarcasterAccountRecord, farcasterKeyPresent, evaluateFarcasterAccess, farcasterSearchRequestShape,
} from '../rumor2/social-farcaster-access.js';
import { FARCASTER_OFFICIAL, farcasterConfigured } from '../rumor2/providers/farcaster-official.js';
import { socialProviderById } from '../rumor2/social-registry.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
const sha = (f) => createHash('sha256').update(read(f)).digest('hex');
const NOW = Date.parse('2026-09-07T12:00:00Z');
const ENV = { NEYNAR_API_KEY: 'present' };
const record = (over = {}) => ({
  approvalRef: 'neynar/account/2026-09', status: 'ATTESTED', application: FARCASTER_APPLICATION_ID, useCaseVersion: FARCASTER_USE_CASE_VERSION,
  plan: 'FREE', credits: 'AVAILABLE', termsReview: 'REVIEWED_PERMITS', permittedUses: ['RETRIEVAL', 'PERSONAL_RESEARCH'], acquisitionPath: 'SEARCH_POLLING', acquisitionApproved: true,
  additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01',
  ...over,
});
const isDeepFrozen = (o) => o === null || typeof o !== 'object' || (Object.isFrozen(o) && Object.values(o).every(isDeepFrozen));

test('FC-ACCESS-1. the provider adapter stays byte-identical and the boundary only reuses its key-presence boolean; the registry account facts are unchanged', () => {
  assert.equal(sha('rumor2/providers/farcaster-official.js'), '47d8e8c3ce6ab5bf4993b7a3f7fb6ea312bb6b916e39139b47641aed6879feea', 'providers/farcaster-official.js is byte-identical to 9b1b405');
  assert.equal(FARCASTER_PROVIDER_ID, FARCASTER_OFFICIAL.id); assert.equal(farcasterKeyPresent(ENV), farcasterConfigured(ENV)); assert.equal(farcasterKeyPresent({}), false); assert.equal(farcasterKeyPresent({ NEYNAR_API_KEY: '' }), false);
  for (const [k, v] of Object.entries(FARCASTER_ACCESS_FOUNDATION)) assert.equal(v, k === 'fixtureOnly', `FARCASTER_ACCESS_FOUNDATION.${k}`);
  const reg = socialProviderById('FARCASTER_OFFICIAL');
  assert.equal(reg.implemented, true); assert.equal(reg.durable, false); assert.equal(reg.account.thisProjectPlan, 'UNKNOWN'); assert.equal(reg.account.entitlement, 'UNVERIFIED'); assert.equal(reg.account.publishedPlan, 'FREE_PLAN_DOCUMENTED');
  assert.deepEqual(FARCASTER_ACCESS_ROUTE.credentialEnvs, [FARCASTER_OFFICIAL.credentialEnv]);
});

test('FC-ACCESS-2. published reference limits, pagination, and webhook facts are separated from entitlement, coverage, lag, and delivery guarantees; pricing and terms are DOCUMENTATION_UNVERIFIED', () => {
  assert.equal(NEYNAR_PUBLISHED_REFERENCE.basis, 'PUBLISHED_REFERENCE_NOT_ACCOUNT_ENTITLEMENT'); assert.equal(NEYNAR_PUBLISHED_REFERENCE.accessedOn, '2026-09-07');
  assert.deepEqual(NEYNAR_PUBLISHED_REFERENCE.plans.FREE, { rpmPerEndpoint: 600, rpsPerEndpoint: 10, castSearchRpm: 120, globalRpm: 1000, documentation: 'N1' });
  assert.equal(NEYNAR_PUBLISHED_REFERENCE.limitsIndependentOfCredits, true);
  assert.equal(NEYNAR_PUBLISHED_REFERENCE.searchCasts.maxLimit, 100); assert.equal(NEYNAR_PUBLISHED_REFERENCE.searchCasts.pagination, 'CURSOR'); assert.equal(NEYNAR_PUBLISHED_REFERENCE.searchCasts.freshnessStatement, 'NONE_DOCUMENTED'); assert.equal(NEYNAR_PUBLISHED_REFERENCE.searchCasts.completenessStatement, 'NONE_DOCUMENTED');
  assert.equal(NEYNAR_PUBLISHED_REFERENCE.pricing, 'DOCUMENTATION_UNVERIFIED'); assert.equal(NEYNAR_PUBLISHED_REFERENCE.terms, 'DOCUMENTATION_UNVERIFIED');
  assert.equal(FARCASTER_DOCUMENTATION.N1.status, 'VERIFIED'); assert.equal(FARCASTER_DOCUMENTATION.N2.status, 'VERIFIED'); assert.equal(FARCASTER_DOCUMENTATION.N3.status, 'DOCUMENTATION_UNVERIFIED'); assert.equal(FARCASTER_DOCUMENTATION.N4.status, 'DOCUMENTATION_UNVERIFIED');
  const s = farcasterAccessSummary();
  for (const k of FARCASTER_ROUTE_SUMMARY_KEYS) assert.ok(k in s, `summary answers ${k}`);
  assert.equal(s.implementationStage, 'ACCESS_BOUNDARY_ONLY'); assert.equal(s.eligibilityEstablishedForOperator, 'NOT_ESTABLISHED'); assert.equal(s.approvalEntitlement, 'UNVERIFIED'); assert.equal(s.documentationStatus, 'DOCUMENTATION_UNVERIFIED');
  assert.deepEqual(s.acquisition, { suggested: 'SEARCH_POLLING', approved: false, pagination: 'CURSOR_DOCUMENTED', completeness: 'UNPROVEN' }); assert.equal(FARCASTER_SUGGESTED_ACQUISITION_PATH, 'SEARCH_POLLING');
  assert.deepEqual(s.lag, { measured: false, status: 'UNMEASURED', realTimeLead: 'UNPROVEN' });
  assert.deepEqual(s.webhook, { authentication: 'DOCUMENTED_NOT_IMPLEMENTED', completeness: 'UNPROVEN', ordering: 'UNPROVEN', replay: 'UNPROVEN' });
  assert.equal(s.liveAllowed, false); assert.equal(s.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(s.measuredLatency, 'UNKNOWN'); assert.equal(s.productionObservation, 'UNOBSERVED'); assert.ok(isDeepFrozen(s));
  // the hypothetical search shape is never sent and refuses undocumented ranges rather than clamping
  assert.deepEqual(farcasterSearchRequestShape({ q: '$FOO', limit: 100 }).shape, { endpoint: 'search-casts', q: '$FOO', limit: 100, cursor: null, sortType: 'desc_chron', sent: false, coverage: 'PAGE_ONLY_COMPLETENESS_UNPROVEN', freshness: 'UNDOCUMENTED' });
  assert.equal(farcasterSearchRequestShape({ q: '$FOO', limit: 101 }).error, 'LIMIT_OUTSIDE_DOCUMENTED_RANGE'); assert.equal(farcasterSearchRequestShape({ q: '$FOO', limit: 0 }).error, 'LIMIT_OUTSIDE_DOCUMENTED_RANGE');
  assert.equal(farcasterSearchRequestShape({ q: '' }).error, 'QUERY_REQUIRED'); assert.equal(farcasterSearchRequestShape({ q: 'x', sortType: 'relevance' }).error, 'SORT_TYPE_UNDOCUMENTED'); assert.equal(farcasterSearchRequestShape({ q: 'x', cursor: 7 }).error, 'CURSOR_MALFORMED');
});

test('FC-ACCESS-3. the account record is closed; the env reader treats empty as unsupplied', () => {
  assert.equal(validateFarcasterAccountRecord(record()), null);
  assert.match(validateFarcasterAccountRecord(record({ plan: 'PRO' })), /unknown plan/); assert.match(validateFarcasterAccountRecord(record({ credits: '100' })), /unknown credits/);
  assert.match(validateFarcasterAccountRecord(record({ termsReview: 'READ' })), /unknown termsReview/); assert.match(validateFarcasterAccountRecord(record({ acquisitionPath: 'SCRAPE' })), /unknown acquisitionPath/);
  assert.match(validateFarcasterAccountRecord(record({ acquisitionPath: 'UNDECIDED', acquisitionApproved: true })), /UNDECIDED/); assert.match(validateFarcasterAccountRecord(record({ acquisitionApproved: 'yes' })), /boolean/);
  assert.match(validateFarcasterAccountRecord(record({ route: 'NEYNAR_HOSTED_API' })), /undeclared field/); assert.match(validateFarcasterAccountRecord(record({ validUntil: '2026-13-01' })), /validUntil/);
  for (const v of FARCASTER_PLAN_STATES) assert.equal(validateFarcasterAccountRecord(record({ plan: v })), null);
  for (const v of FARCASTER_CREDIT_STATES) assert.equal(validateFarcasterAccountRecord(record({ credits: v })), null);
  for (const v of FARCASTER_TERMS_STATES) assert.equal(validateFarcasterAccountRecord(record({ termsReview: v })), null);
  for (const v of FARCASTER_ACQUISITION_PATHS) assert.equal(validateFarcasterAccountRecord(record({ acquisitionPath: v, acquisitionApproved: false })), null);
  assert.equal(farcasterAccountRecordFromEnv({ RUMOR2_SOCIAL_FARCASTER_ACCOUNT_PLAN: '' }), null);
  const r = farcasterAccountRecordFromEnv({ RUMOR2_SOCIAL_FARCASTER_ACCOUNT_STATUS: 'PENDING', RUMOR2_SOCIAL_FARCASTER_ACCOUNT_APPLICATION: FARCASTER_APPLICATION_ID, RUMOR2_SOCIAL_FARCASTER_ACCOUNT_USE_CASE_VERSION: FARCASTER_USE_CASE_VERSION });
  assert.equal(validateFarcasterAccountRecord(r), null); assert.equal(r.plan, 'UNKNOWN'); assert.equal(r.credits, 'UNKNOWN'); assert.equal(r.termsReview, 'UNRESOLVED'); assert.equal(r.acquisitionPath, 'UNDECIDED'); assert.equal(r.acquisitionApproved, false);
});

test('FC-ACCESS-4 (Stage-3 gate). a key, a published Free plan, an unrelated approval, or credits alone cannot authorize; every blocker is independent; full readiness still has no live path', () => {
  const keyOnly = evaluateFarcasterAccess({ record: null, env: ENV, nowMs: NOW });
  assert.equal(keyOnly.keyPresent, true); assert.equal(keyOnly.keyMeaning, 'CONFIGURATION_ONLY'); assert.ok(keyOnly.blockers.includes('ACCOUNT_RECORD_MISSING')); assert.equal(keyOnly.activationPrerequisitesMet, false);
  assert.deepEqual(keyOnly.plan, { published: 'FREE_PLAN_DOCUMENTED', thisAccount: 'UNKNOWN', publishedReferenceLimits: null, accountLimits: 'UNVERIFIED' }); assert.equal(keyOnly.entitlement, 'NOT_VERIFIED'); assert.equal(keyOnly.credits, 'UNKNOWN');
  assert.ok(keyOnly.advisories.includes('KEY_PRESENCE_IS_CONFIGURATION_NOT_ENTITLEMENT'));
  for (const a of ['TERMS_DOCUMENTATION_UNVERIFIED', 'PRICING_DOCUMENTATION_UNVERIFIED', 'LAG_UNMEASURED', 'COVERAGE_COMPLETENESS_UNPROVEN', 'WEBHOOK_DELIVERY_GUARANTEES_UNPROVEN']) assert.ok(keyOnly.advisories.includes(a), a);
  // an approval for another application / use case is out of scope: plan, credits, terms in it confer nothing
  const unrelated = evaluateFarcasterAccess({ record: record({ application: 'OTHER_PROJECT' }), env: ENV, nowMs: NOW });
  assert.equal(unrelated.entitlement, 'OUT_OF_SCOPE'); assert.equal(unrelated.plan.thisAccount, 'UNKNOWN'); assert.equal(unrelated.credits, 'UNKNOWN'); assert.equal(unrelated.terms.review, 'UNRESOLVED'); assert.equal(unrelated.acquisition.approved, false); assert.equal(unrelated.activationPrerequisitesMet, false);
  // the published Free plan attested as this account's plan yields reference limits, still labelled reference, with account limits UNVERIFIED
  const free = evaluateFarcasterAccess({ record: record(), env: ENV, nowMs: NOW });
  assert.deepEqual(free.blockers, []); assert.equal(free.activationPrerequisitesMet, true); assert.ok(Object.values(free.prerequisites).every((v) => v === true));
  assert.equal(free.plan.thisAccount, 'FREE'); assert.deepEqual(free.plan.publishedReferenceLimits, NEYNAR_PUBLISHED_REFERENCE.plans.FREE); assert.equal(free.plan.accountLimits, 'UNVERIFIED');
  assert.equal(free.liveAllowed, false); assert.equal(free.liveStatus, 'DISABLED'); assert.equal(free.liveReason, 'FOUNDATION_ONLY_NO_LIVE_PATH'); assert.equal(free.durableContentAllowed, false); assert.equal(free.durableAuthorIdentityAllowed, false);
  assert.deepEqual(free.transport, { implemented: false, poller: false, webhookReceiver: false, collectorWiring: false, journalWriter: false });
  assert.deepEqual(free.acquisition, { suggested: 'SEARCH_POLLING', chosen: 'SEARCH_POLLING', approved: true, pagination: 'CURSOR_DOCUMENTED', completeness: 'UNPROVEN' });
  assert.deepEqual(free.lag, { measured: false, status: 'UNMEASURED', realTimeLead: 'UNPROVEN' }); assert.equal(free.webhook.completeness, 'UNPROVEN'); assert.equal(free.terms.documentation, 'DOCUMENTATION_UNVERIFIED');
  assert.deepEqual(free.downstream, { inference: false, training: false, derivedFeatures: false, redistribution: false }); assert.ok(isDeepFrozen(free)); assert.ok(!JSON.stringify(free).includes('present'));
  const cases = [
    [{ nowMs: null }, 'CLOCK_UNAVAILABLE'], [{ nowMs: 'now' }, 'CLOCK_INVALID'], [{ env: {} }, 'KEY_MISSING'],
    [{ record: record({ status: 'PENDING' }) }, 'APPROVAL_PENDING'], [{ record: record({ status: 'REVOKED' }) }, 'APPROVAL_REVOKED'], [{ record: record({ status: 'DENIED' }) }, 'APPROVAL_DENIED'],
    [{ record: record({ validUntil: '2026-09-07T12:00:00Z' }) }, 'APPROVAL_EXPIRED'], [{ record: record({ validUntil: '2026-09-30' }) }, 'VALID_UNTIL_PRECISION_UNRESOLVED'], [{ record: record({ reviewedOn: '2026-09-08' }) }, 'REVIEW_DATE_IN_FUTURE'],
    [{ record: record({ plan: 'UNKNOWN' }) }, 'PLAN_UNKNOWN'], [{ record: record({ credits: 'UNKNOWN' }) }, 'CREDITS_UNKNOWN'], [{ record: record({ credits: 'EXHAUSTED' }) }, 'CREDITS_EXHAUSTED'],
    [{ record: record({ termsReview: 'UNRESOLVED' }) }, 'TERMS_UNRESOLVED'], [{ record: record({ termsReview: 'REVIEWED_PROHIBITS' }) }, 'TERMS_PROHIBIT_USE'],
    [{ record: record({ acquisitionApproved: false }) }, 'ACQUISITION_PATH_NOT_APPROVED'], [{ record: record({ acquisitionPath: 'UNDECIDED', acquisitionApproved: false }) }, 'ACQUISITION_PATH_NOT_APPROVED'],
    [{ record: record({ additionalAgreement: 'REQUIRED' }) }, 'ADDITIONAL_AGREEMENT_REQUIRED_UNSATISFIED'], [{ record: record({ additionalAgreement: 'UNRESOLVED' }) }, 'ADDITIONAL_AGREEMENT_UNRESOLVED'],
    [{ record: record({ retentionContent: 'UNRESOLVED' }) }, 'RETENTION_CONTENT_UNRESOLVED'], [{ record: record({ retentionIdentity: 'INCOMPATIBLE' }) }, 'RETENTION_IDENTITY_INCOMPATIBLE'],
    [{ record: record({ permittedUses: ['DERIVED_FEATURES'] }) }, 'RETRIEVAL_NOT_PERMITTED'], [{ record: record({ plan: 'PRO' }) }, /ACCOUNT_RECORD_INVALID/],
  ];
  for (const [over, expected] of cases) {
    const e = evaluateFarcasterAccess({ record: record(), env: ENV, nowMs: NOW, ...over });
    assert.ok(e.blockers.some((b) => (expected instanceof RegExp ? expected.test(b) : b === expected)), `${JSON.stringify(over)} → ${expected}; got ${e.blockers}`);
    assert.equal(e.activationPrerequisitesMet, false); assert.equal(e.liveAllowed, false);
  }
  // a credits-available attestation with unknown plan blocks on the plan; a known plan with unknown credits blocks on credits — independent dimensions
  assert.deepEqual(evaluateFarcasterAccess({ record: record({ plan: 'UNKNOWN' }), env: ENV, nowMs: NOW }).blockers, ['PLAN_UNKNOWN']);
  assert.deepEqual(evaluateFarcasterAccess({ record: record({ credits: 'UNKNOWN' }), env: ENV, nowMs: NOW }).blockers, ['CREDITS_UNKNOWN']);
  const self = evaluateFarcasterAccess({ record: null, env: {}, nowMs: NOW, description: 'private research' });
  assert.ok(self.advisories.includes('SELF_DESCRIPTION_IS_NOT_PERMISSION')); assert.ok(self.blockers.includes('KEY_MISSING'));
});

test('FC-ACCESS-5 (Stage-3 gate). no production runtime, collector, provider, or persistence module imports the boundary; the boundary imports only the provider adapter and the shared primitive', () => {
  const tracked = execSync("git ls-files '*.js' '*.mjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
  assert.ok(tracked.includes('rumor2/social-farcaster-access.js'), 'the boundary is tracked');
  const importers = tracked.filter((f) => !f.startsWith('test/') && /from\s+'[^']*social-farcaster-access/.test(read(f)));
  assert.deepEqual(importers, [], 'nothing outside tests reaches the boundary');
  const imports = [...read('rumor2/social-farcaster-access.js').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./providers/farcaster-official.js', './social-foundation.js']);
  const src = read('rumor2/social-farcaster-access.js');
  for (const forbidden of ['fetch(', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'node:', 'child_process', 'x-api-key:', 'Date.now', 'randomUUID', 'kafka.', 'grpc']) assert.ok(!src.includes(forbidden), `boundary carries no ${forbidden}`);
});
