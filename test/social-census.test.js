// SOCIAL-1 — the access census as machine-checked truth (§2/§33). The system
// knows WHY each social ear is or is not available, from current official docs
// (citations in doctrine/SOCIAL.md). This test pins the census so drift is
// caught, and asserts the SOCIAL-1 activation decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SOCIAL_PROVIDERS, SOCIAL_PROVIDER_IDS, SOCIAL_ACCESS_STATES, ACTIVE_SOCIAL_PROVIDER_IDS,
  socialProviderById, isLiveActivatable, isPlatformCapable,
} from '../rumor2/social-registry.js';
import { SOCIAL_PROVIDER_KINDS } from '../rumor2/social.js';

test('CENSUS-1. every intended provider has a truthful, closed access state — never a vague "disabled"', () => {
  for (const p of SOCIAL_PROVIDERS) {
    assert.ok(SOCIAL_ACCESS_STATES.includes(p.accessState), `${p.id} accessState`);
    assert.ok(SOCIAL_PROVIDER_KINDS.includes(p.providerKind), `${p.id} providerKind`);
    assert.ok(typeof p.reason === 'string' && p.reason.length > 20, `${p.id} carries a concrete reason`);
    assert.ok(typeof p.docUrl === 'string' && p.docUrl.startsWith('https://'), `${p.id} cites an official doc`);
  }
});

test('CENSUS-2. the SOCIAL-1 provider set is exactly the intended universe', () => {
  assert.deepEqual([...SOCIAL_PROVIDER_IDS].sort(), [
    'BLUESKY_OFFICIAL', 'FARCASTER_OFFICIAL', 'META_PUBLIC', 'REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL', 'TIKTOK_PUBLIC', 'X_OFFICIAL',
  ]);
});

test('CENSUS-3. the recorded access decisions match the verified census', () => {
  assert.equal(socialProviderById('BLUESKY_OFFICIAL').accessState, 'AVAILABLE_AUTHORIZED');
  assert.equal(socialProviderById('FARCASTER_OFFICIAL').accessState, 'AVAILABLE_REQUIRES_CREDENTIAL');
  assert.equal(socialProviderById('X_OFFICIAL').accessState, 'AVAILABLE_REQUIRES_CREDENTIAL');
  assert.equal(socialProviderById('REDDIT_OFFICIAL').accessState, 'AVAILABLE_REQUIRES_APPROVAL_AND_CLASSIFICATION', 'SOCIAL-3: classification-neutral — approval and use-case review pending, nothing assumed');
  assert.equal(socialProviderById('STOCKTWITS_OFFICIAL').accessState, 'AVAILABLE_REQUIRES_ENTITLEMENT_AND_TERMS_REVIEW', 'SOCIAL-4B: route-specific — registration paused, Firestream documented, entitlement/terms unresolved');
  assert.equal(socialProviderById('META_PUBLIC').accessState, 'AVAILABLE_REQUIRES_APP_REVIEW');
  assert.equal(socialProviderById('TIKTOK_PUBLIC').accessState, 'NOT_AUTHORIZED');
});

test('CENSUS-4 (SOCIAL-2B §7). Bluesky is credential-free live; X is durable but RUNTIME-GATED (credential + budget + preflight + fence); the rest dark by access', () => {
  assert.deepEqual(ACTIVE_SOCIAL_PROVIDER_IDS, ['BLUESKY_OFFICIAL', 'X_OFFICIAL']);
  assert.equal(isLiveActivatable('AVAILABLE_AUTHORIZED'), true, 'unattended activation needs no credential');
  assert.equal(isLiveActivatable('AVAILABLE_REQUIRES_CREDENTIAL'), false, 'a static flag never implies a credential exists');
  assert.equal(isPlatformCapable('AVAILABLE_REQUIRES_CREDENTIAL'), true); assert.equal(isPlatformCapable('NOT_AUTHORIZED'), false);
  const x = socialProviderById('X_OFFICIAL');
  assert.equal(x.accessState, 'AVAILABLE_REQUIRES_CREDENTIAL', 'X is NOT relabeled AVAILABLE_AUTHORIZED');
  assert.equal(x.implemented, true); assert.equal(x.durable, true); assert.equal(x.runtimeGated, true);
  assert.equal(x.cost.dedupeGuarantee, 'SOFT'); assert.equal(x.cost.observedOn, '2026-09-06');
  // structural invariants: durable => platform capable; credential-gated durable => runtime-gated
  for (const p of SOCIAL_PROVIDERS) if (p.durable) assert.ok(isPlatformCapable(p.accessState), `${p.id} durable => platform capable`);
  for (const p of SOCIAL_PROVIDERS) if (p.durable && !isLiveActivatable(p.accessState)) assert.equal(p.runtimeGated, true, `${p.id} needs runtime authorization`);
});

test('CENSUS-5. StockTwits stays HIGH PRIORITY though access-blocked; TikTok is a FINAL exclusion, not a TODO', () => {
  assert.equal(socialProviderById('STOCKTWITS_OFFICIAL').highPriority, true, 'blocked by entitlement/terms review, not by importance');
  assert.equal(socialProviderById('STOCKTWITS_OFFICIAL').routes.SELF_SERVE_REGISTRATION.status, 'PAUSED', 'the registration pause is route-specific');
  assert.equal(socialProviderById('TIKTOK_PUBLIC').currentDecision, 'INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED'); assert.equal(socialProviderById('TIKTOK_PUBLIC').decisionStatus, 'OPERATOR_REVIEW_PENDING'); assert.ok(!('finalDecision' in socialProviderById('TIKTOK_PUBLIC')), 'no permanent exclusion is claimed on the operator\'s behalf');
  assert.equal(socialProviderById('META_PUBLIC').eligibilityForThisProject, 'NOT_ESTABLISHED'); assert.equal(socialProviderById('FARCASTER_OFFICIAL').account.thisProjectPlan, 'UNKNOWN');
  for (const id of ['META_PUBLIC', 'TIKTOK_PUBLIC']) { const p = socialProviderById(id); assert.equal(p.implemented, false); assert.equal(p.durable, false); assert.ok(!/commercial trading|bars commercial use/i.test(p.reason), `${id}: no commercial classification asserted`); }
});

test('CENSUS-6. no credential/secret value is ever embedded — only env var NAMES', () => {
  for (const p of SOCIAL_PROVIDERS) {
    if (p.credentialEnv !== null) assert.match(p.credentialEnv, /^[A-Z0-9_]+$/, `${p.id} names an env var, not a secret`);
    // guard against an accidental literal token/key VALUE in the registry data
    // (an opaque long token, never plain descriptive prose like "bearer")
    const blob = JSON.stringify(p);
    assert.ok(!/(sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,})/.test(blob), `${p.id} embeds no secret token value`);
  }
});

test('CENSUS-7 (SOCIAL-4E). foundation-stage metadata is explicit and non-live; implemented/durable keep their meanings; the TikTok decision and Meta eligibility are unchanged; the stale v5 wording is gone', () => {
  const expected = { META_PUBLIC: 'rumor2/social-meta.js', TIKTOK_PUBLIC: 'rumor2/social-tiktok.js', FARCASTER_OFFICIAL: 'rumor2/social-farcaster-access.js' };
  for (const [id, module] of Object.entries(expected)) {
    const f = socialProviderById(id).foundation;
    assert.equal(f.ticket, 'SOCIAL-4E'); assert.equal(f.module, module); assert.equal(f.fixtureOnly, true); assert.equal(f.live, false); assert.equal(f.durable, false); assert.equal(f.operationalAccess, false); assert.match(f.docsAccessedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
  for (const p of SOCIAL_PROVIDERS) if (!(p.id in expected)) assert.ok(!('foundation' in p), `${p.id} carries no 4E metadata`);
  assert.equal(socialProviderById('META_PUBLIC').implemented, false); assert.equal(socialProviderById('TIKTOK_PUBLIC').implemented, false); assert.equal(socialProviderById('FARCASTER_OFFICIAL').implemented, true);
  assert.equal(socialProviderById('TIKTOK_PUBLIC').currentDecision, 'INACTIVE_NO_AUTHORIZED_MINUTES_SCALE_ORGANIC_ROUTE_ESTABLISHED'); assert.equal(socialProviderById('TIKTOK_PUBLIC').decisionStatus, 'OPERATOR_REVIEW_PENDING');
  assert.equal(socialProviderById('META_PUBLIC').eligibilityForThisProject, 'NOT_ESTABLISHED'); assert.equal(socialProviderById('FARCASTER_OFFICIAL').account.entitlement, 'UNVERIFIED');
  assert.deepEqual(ACTIVE_SOCIAL_PROVIDER_IDS, ['BLUESKY_OFFICIAL', 'X_OFFICIAL'], 'no 4E provider became durable');
  const src = readFileSync(new URL('../rumor2/social-registry.js', import.meta.url), 'utf8');
  assert.ok(!/checkpoint v5 migration|via v5/.test(src)); assert.ok(/checkpoint v4/.test(src) && /RUMOR2_SOCIAL_CURSOR/.test(src));
});
