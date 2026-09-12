// SOCIAL-7 §48 — the PROVIDER READINESS TRUTH MATRIX (pure). One bounded machine-readable projection
// derived from the existing registry, the retention capability law, the runtime statuses the collector
// already exposes and the existing access evaluators — closed states, closed blocker codes, never one
// `implemented: true` flag, never a green state invented to match prose, external verification listed
// as a blocker rather than assumed, and authority NONE (operational truth is not evidence corroboration
// and not a trade permission).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessMatrix, providerReadinessRow, legacyAggregateReadinessRow, validateReadinessRow, closedBlocker, READINESS_STATES, READINESS_BLOCKERS, READINESS_ROW_KEYS, READINESS_MATRIX_VERSION, PROVIDER_SMOKE_FACTS } from '../rumor2/social-readiness.js';
import { SOCIAL_PROVIDERS, SOCIAL_PROVIDER_IDS } from '../rumor2/social-registry.js';
import { retentionCapability, SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER } from '../rumor2/social-research-profile.js';
import { evaluateRedditAccess } from '../rumor2/social-reddit.js';
import { evaluateStocktwitsAccess } from '../rumor2/social-stocktwits.js';
import { evaluateFarcasterAccess } from '../rumor2/social-farcaster-access.js';
import { evaluateMetaRouteAccess, META_ROUTE_IDS } from '../rumor2/social-meta.js';
import { evaluateTiktokRouteAccess, TIKTOK_ROUTE_IDS } from '../rumor2/social-tiktok.js';
import { canonicalJson } from '../rumor2/truth.js';

const T0 = Date.parse('2026-09-07T12:00:00Z');
const bskyActive = (over = {}) => ({ provider: 'BLUESKY_OFFICIAL', state: 'ACTIVE', hydrated: true, mode: 'LIVE', durableCursor: 10, durableIndexSize: 3, authority: 'NONE', ...over });
const xStatus = (over = {}) => ({ provider: 'X_OFFICIAL', accessState: 'AVAILABLE_REQUIRES_CREDENTIAL', enabled: true, credentialPresent: true, gate: 'OPEN', gateDetail: null, state: 'HYDRATED', hydrated: true, authority: 'NONE', watch: { ok: true, mode: 'EXPLICIT_STATIC', reason: null }, smoke: { configured: false, ok: false, durableStatus: null, status: null }, ...over });
const disabled = (gate) => ({ enabled: false, state: 'DARK', gateDetail: `disabled (${gate})` });

test('R7-1. closed vocabularies; every registry provider plus the legacy aggregate family has exactly one row with the closed keys; no row flattens to one implemented flag; readiness/blockers are closed; authority NONE; the matrix is deterministic for identical inputs', () => {
  assert.deepEqual(READINESS_STATES, ['OPERATIONAL_LIVE_PROVEN', 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', 'IMPLEMENTED_NOT_LIVE_SMOKED', 'READY_REQUIRES_EXPLICIT_PAID_SMOKE', 'AVAILABLE_REQUIRES_APPROVAL', 'FIXTURE_ONLY', 'ACCESS_UNRESOLVED', 'RETENTION_BLOCKED', 'NOT_CONFIGURED', 'DISABLED', 'UNAVAILABLE']);
  for (const k of ['provider', 'foundationPresent', 'transportImplemented', 'accessState', 'entitlementOrApprovalState', 'retentionState', 'historicalReplayCapability', 'liveSmokeState', 'productionGateState', 'currentlyEnabledState', 'durableRawContentAllowed', 'durableAuthorIdentityAllowed', 'operationalEvidenceAvailable', 'statusKnownAtTs', 'latestVerifiedKnownAtTs', 'blockers', 'authority']) assert.ok(READINESS_ROW_KEYS.includes(k), `§48 field ${k}`);
  const m = readinessMatrix({ knownAtTs: T0 });
  assert.equal(m.version, READINESS_MATRIX_VERSION); assert.equal(m.authority, 'NONE'); assert.equal(m.knownAtTs, T0);
  assert.deepEqual(m.providers.map((r) => r.provider), [...SOCIAL_PROVIDER_IDS, SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER], 'one row per registry provider + the legacy aggregate family, registry order');
  for (const r of m.providers) { assert.equal(validateReadinessRow(r), null, r.provider); assert.ok(!('implemented' in r)); assert.equal(r.retentionState, retentionCapability(r.provider).state, `${r.provider}: retention from the ONE capability law`); assert.equal(r.statusKnownAtTs, T0); assert.ok(Object.isFrozen(r)); }
  assert.equal(canonicalJson(readinessMatrix({ knownAtTs: T0 })), canonicalJson(m), 'deterministic');
  assert.equal(validateReadinessRow({ ...m.providers[0], implemented: true }), 'readiness row: keys are not the closed readiness keys');
  assert.match(validateReadinessRow({ ...m.providers[0], readiness: 'LIVE' }), /not a closed state/);
  assert.match(validateReadinessRow({ ...m.providers[0], blockers: ['VIBES'] }), /outside the closed codes/);
  assert.match(validateReadinessRow({ ...m.providers[0], readiness: 'OPERATIONAL_LIVE_PROVEN' }), /called operational while blocked/);
  assert.equal(providerReadinessRow('NOT_A_PROVIDER'), null, 'no row is invented for an unregistered provider');
});

test('R7-2. the tree wins over prose: with NO runtime status in this process Bluesky is LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE (its one real prior smoke is kept; the production gate is unobserved) and X is IMPLEMENTED_NOT_LIVE_SMOKED (paid smoke NOT performed), Reddit / StockTwits are RETENTION_BLOCKED, TikTok is FIXTURE_ONLY; Meta / Farcaster have bounded transports with unobserved gates, the legacy aggregate is ACCESS_UNRESOLVED; nothing is green', () => {
  const m = readinessMatrix({ knownAtTs: T0 });
  const row = (id) => m.providers.find((r) => r.provider === id);
  assert.equal(row('BLUESKY_OFFICIAL').readiness, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', 'a performed prior smoke and an unobserved current gate are two dimensions — the row may not deny its own smoke'); assert.deepEqual(row('BLUESKY_OFFICIAL').blockers, ['PRODUCTION_GATE_UNOBSERVED']); assert.equal(row('BLUESKY_OFFICIAL').liveSmokeState, 'PERFORMED_PRIOR_SESSION', 'the one real Bluesky smoke (doctrine §5B) is repository-known status'); assert.equal(row('BLUESKY_OFFICIAL').historicalReplayCapability, 'JOURNAL_REPLAY'); assert.equal(row('BLUESKY_OFFICIAL').durableRawContentAllowed, true);
  assert.equal(row('X_OFFICIAL').readiness, 'IMPLEMENTED_NOT_LIVE_SMOKED'); assert.deepEqual(row('X_OFFICIAL').blockers, ['PAID_SMOKE_NOT_PERFORMED', 'PRODUCTION_GATE_UNOBSERVED']); assert.equal(row('X_OFFICIAL').liveSmokeState, 'NOT_PERFORMED'); assert.equal(row('X_OFFICIAL').entitlementOrApprovalState, 'PAY_PER_USE_CREDENTIAL_AND_BUDGET_REQUIRED');
  for (const id of ['REDDIT_OFFICIAL', 'STOCKTWITS_OFFICIAL']) { const r = row(id); assert.equal(r.readiness, 'RETENTION_BLOCKED', id); assert.ok(r.blockers.includes('RETENTION_NOT_APPROVED')); assert.equal(r.durableRawContentAllowed, false); assert.equal(r.durableAuthorIdentityAllowed, false); assert.equal(r.transportImplemented, true); assert.equal(r.historicalReplayCapability, 'FIXTURE_REPLAY_ONLY'); }
  assert.ok(row('REDDIT_OFFICIAL').blockers.includes('APPROVAL_NOT_OBTAINED')); assert.ok(row('STOCKTWITS_OFFICIAL').blockers.includes('ENTITLEMENT_UNRESOLVED'));
  for (const id of ['TIKTOK_PUBLIC']) { const r = row(id); assert.equal(r.readiness, 'FIXTURE_ONLY', id); assert.ok(r.blockers.includes('TRANSPORT_NOT_IMPLEMENTED')); assert.ok(r.blockers.includes('EXTERNAL_VERIFICATION_DEFERRED'), `${id}: unverified docs stay deferred, never assumed`); assert.equal(r.operationalEvidenceAvailable, false); assert.equal(r.foundationPresent, true); }
  assert.ok(row('TIKTOK_PUBLIC').blockers.includes('PLATFORM_DECISION_PENDING')); for (const id of ['META_PUBLIC','FARCASTER_OFFICIAL']) { assert.equal(row(id).readiness, 'ACCESS_UNRESOLVED'); assert.equal(row(id).transportImplemented, true); assert.ok(row(id).blockers.includes('PRODUCTION_GATE_UNOBSERVED')); }
  const la = row(SOURCE_PROFILE_LEGACY_AGGREGATE_PROVIDER); assert.equal(la.readiness, 'ACCESS_UNRESOLVED'); assert.deepEqual(la.blockers, ['DEPLOYMENT_UNOBSERVED', 'ENTITLEMENT_UNRESOLVED']); assert.equal(la.retentionState, 'AGGREGATE_ONLY_ALLOWED'); assert.equal(la.durableAuthorIdentityAllowed, false); assert.equal(la.historicalReplayCapability, 'AGGREGATE_CHECKPOINT_ONLY'); assert.equal(la.currentlyEnabledState, 'UNOBSERVED_IN_THIS_PROCESS');
  assert.deepEqual(m.operationalProviders, []); assert.equal(m.counts.OPERATIONAL_LIVE_PROVEN, undefined);
  assert.equal(legacyAggregateReadinessRow({ knownAtTs: T0, configured: true }).currentlyEnabledState, 'ENABLED'); assert.equal(legacyAggregateReadinessRow({ knownAtTs: T0, configured: true }).readiness, 'ACCESS_UNRESOLVED', 'config-enabled is not entitlement');
  assert.equal(PROVIDER_SMOKE_FACTS.X_OFFICIAL.liveSmokeState, 'NOT_PERFORMED');
});

test('R7-3. live statuses project truthfully: Bluesky ACTIVE => OPERATIONAL_LIVE_PROVEN (no blocker), HYDRATED/DARK => gate unobserved, STANDBY/WITHHELD => UNAVAILABLE + RUNTIME_WITHHELD, disabled => DISABLED; X disabled => DISABLED, no credential => NOT_CONFIGURED, budget gate => NOT_CONFIGURED, watch not configured => NOT_CONFIGURED, all configured but no completed smoke => READY_REQUIRES_EXPLICIT_PAID_SMOKE, ACTIVE with a COMPLETE durable smoke => OPERATIONAL_LIVE_PROVEN, BUDGET_STOPPED/WITHHELD => UNAVAILABLE', () => {
  const b = (rt) => providerReadinessRow('BLUESKY_OFFICIAL', { runtime: rt, knownAtTs: T0 });
  assert.equal(b(bskyActive()).readiness, 'OPERATIONAL_LIVE_PROVEN'); assert.deepEqual(b(bskyActive()).blockers, []); assert.equal(b(bskyActive()).operationalEvidenceAvailable, true); assert.equal(b(bskyActive({ durableIndexSize: 0 })).operationalEvidenceAvailable, false, 'live but no durable evidence yet');
  for (const s of ['HYDRATED', 'DARK']) { const r = b(bskyActive({ state: s })); assert.equal(r.readiness, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', s); assert.deepEqual(r.blockers, ['PRODUCTION_GATE_UNOBSERVED']); assert.equal(r.liveSmokeState, 'PERFORMED_PRIOR_SESSION'); assert.equal(validateReadinessRow(r), null); }
  for (const s of ['HYDRATED', 'DARK']) { const r = b(bskyActive({ state: s, gate: 'OPEN' })); assert.equal(r.readiness, 'LIVE_SMOKED_NOT_CURRENTLY_PROVEN_ACTIVE', s); assert.deepEqual(r.blockers, ['RUNTIME_NOT_ACTIVE'], 'an explicitly OPEN gate is a true fact about the gate, never about current activation'); }
  for (const s of ['STANDBY', 'WITHHELD']) { const r = b(bskyActive({ state: s })); assert.equal(r.readiness, 'UNAVAILABLE', s); assert.deepEqual(r.blockers, ['RUNTIME_WITHHELD']); assert.equal(r.currentlyEnabledState, s); }
  const bd = b(disabled('RUMOR2_SOCIAL_BLUESKY_ENABLED')); assert.equal(bd.readiness, 'DISABLED'); assert.deepEqual(bd.blockers, ['RUNTIME_DISABLED']); assert.equal(bd.currentlyEnabledState, 'DISABLED');
  const x = (rt) => providerReadinessRow('X_OFFICIAL', { runtime: rt, knownAtTs: T0 });
  const xd = x(disabled('RUMOR2_SOCIAL_X_ENABLED')); assert.equal(xd.readiness, 'DISABLED'); assert.deepEqual(xd.blockers, ['PAID_SMOKE_NOT_PERFORMED', 'RUNTIME_DISABLED']);
  const xc = x(xStatus({ credentialPresent: false, gate: 'X_BEARER_TOKEN missing' })); assert.equal(xc.readiness, 'NOT_CONFIGURED'); assert.ok(xc.blockers.includes('CREDENTIAL_MISSING') && xc.blockers.includes('PAID_SMOKE_NOT_PERFORMED'));
  const xb = x(xStatus({ gate: 'BUDGET_NOT_CONFIGURED' })); assert.equal(xb.readiness, 'NOT_CONFIGURED'); assert.ok(xb.blockers.includes('BUDGET_NOT_CONFIGURED'));
  const xw = x(xStatus({ watch: { ok: false, mode: 'NOT_CONFIGURED', reason: 'WATCH_NOT_CONFIGURED' } })); assert.equal(xw.readiness, 'NOT_CONFIGURED'); assert.ok(xw.blockers.includes('WATCH_SCOPE_NOT_CONFIGURED'));
  const xr = x(xStatus()); assert.equal(xr.readiness, 'READY_REQUIRES_EXPLICIT_PAID_SMOKE'); assert.deepEqual(xr.blockers, ['PAID_SMOKE_NOT_PERFORMED']); assert.equal(xr.liveSmokeState, 'NOT_PERFORMED');
  const xa = x(xStatus({ state: 'ACTIVE' })); assert.equal(xa.readiness, 'READY_REQUIRES_EXPLICIT_PAID_SMOKE', 'ACTIVE without a completed authorized smoke is not proven');
  const xp = x(xStatus({ state: 'ACTIVE', smoke: { configured: true, ok: true, durableStatus: 'COMPLETE', status: 'COMPLETE' } })); assert.equal(xp.readiness, 'OPERATIONAL_LIVE_PROVEN'); assert.deepEqual(xp.blockers, []); assert.equal(xp.liveSmokeState, 'PERFORMED_PRIOR_SESSION');
  for (const s of ['BUDGET_STOPPED', 'WITHHELD', 'WITHHELD_GAP', 'STANDBY']) { const r = x(xStatus({ state: s })); assert.equal(r.readiness, 'UNAVAILABLE', s); assert.ok(r.blockers.includes('RUNTIME_WITHHELD')); }
  for (const r of [xd, xc, xb, xw, xr, xa, xp, bd]) assert.equal(validateReadinessRow(r), null);
});

test('R7-4. the existing access evaluators feed the matrix through the closed blocker mapping (their own vocabulary is never leaked as a new code), the evaluation clock becomes latestVerifiedKnownAtTs, and no evaluator outcome can turn a retention-blocked or fixture-only provider green', () => {
  const env = {};
  const evaluations = { REDDIT_OFFICIAL: evaluateRedditAccess({ env, nowMs: T0 }), STOCKTWITS_OFFICIAL: evaluateStocktwitsAccess({ env, nowMs: T0 }), FARCASTER_OFFICIAL: evaluateFarcasterAccess({ env, nowMs: T0 }), META_PUBLIC: evaluateMetaRouteAccess({ routeId: META_ROUTE_IDS[0], env, nowMs: T0 }), TIKTOK_PUBLIC: evaluateTiktokRouteAccess({ routeId: TIKTOK_ROUTE_IDS[0], env, nowMs: T0 }) };
  for (const [id, ev] of Object.entries(evaluations)) { assert.ok(Array.isArray(ev.blockers) && ev.blockers.length > 0, `${id}: the evaluator names blockers with an empty env`); for (const b of ev.blockers) assert.ok(READINESS_BLOCKERS.includes(closedBlocker(b)), `${id}: ${b} maps to a closed code`); }
  const m = readinessMatrix({ knownAtTs: T0, evaluations });
  for (const r of m.providers) assert.equal(validateReadinessRow(r), null, r.provider);
  const row = (id) => m.providers.find((r) => r.provider === id);
  assert.equal(row('REDDIT_OFFICIAL').readiness, 'RETENTION_BLOCKED'); assert.equal(row('STOCKTWITS_OFFICIAL').readiness, 'RETENTION_BLOCKED'); assert.equal(row('FARCASTER_OFFICIAL').readiness, 'ACCESS_UNRESOLVED'); assert.equal(row('META_PUBLIC').readiness, 'ACCESS_UNRESOLVED'); assert.equal(row('TIKTOK_PUBLIC').readiness, 'FIXTURE_ONLY');
  assert.ok(row('REDDIT_OFFICIAL').blockers.includes('CREDENTIAL_MISSING')); assert.ok(row('REDDIT_OFFICIAL').blockerDetail.some((d) => /APPROVAL_RECORD_MISSING/.test(d)), 'the evaluator\'s own reason is kept as bounded detail');
  for (const r of m.providers) if (evaluations[r.provider]) assert.equal(r.latestVerifiedKnownAtTs, Number.isSafeInteger(evaluations[r.provider].evaluatedAtTs) ? evaluations[r.provider].evaluatedAtTs : null);
  // an evaluator claiming green cannot override registry / retention truth
  const fake = { REDDIT_OFFICIAL: { blockers: [], liveAllowed: true, durableContentAllowed: true } };
  assert.equal(readinessMatrix({ knownAtTs: T0, evaluations: fake }).providers.find((r) => r.provider === 'REDDIT_OFFICIAL').readiness, 'RETENTION_BLOCKED');
  assert.equal(closedBlocker('SOMETHING_NEW'), 'OTHER_EVALUATOR_BLOCKER'); assert.equal(closedBlocker('CLOCK_UNAVAILABLE'), 'EVALUATION_CLOCK_UNAVAILABLE'); assert.equal(closedBlocker('TERMS_NOT_READ'), 'TERMS_UNRESOLVED');
});

test('R7-5. readiness is operational truth only: no row and no matrix field carries evidence, corroboration, direction, score or execution vocabulary; the registry census, not the matrix, decides accessState; a provider deliberately excluded (retention prohibited) is represented rather than omitted', () => {
  const m = readinessMatrix({ knownAtTs: T0, runtimes: { BLUESKY_OFFICIAL: bskyActive(), X_OFFICIAL: xStatus() } });
  const json = canonicalJson(m);
  assert.ok(!/bullish|bearish|score|probab|"(BUY|SELL|STRIKE|TRADE|ENTER|EXIT)"/i.test(json), 'no direction / score / execution vocabulary');
  assert.ok(!/corroborat/i.test(canonicalJson(m.providers)), 'no row carries corroboration vocabulary'); assert.match(m.note, /never evidence corroboration, never a trade permission/);
  for (const p of SOCIAL_PROVIDERS) { const r = m.providers.find((x) => x.provider === p.id); assert.equal(r.accessState, p.accessState, `${p.id}: accessState is the registry census`); assert.equal(r.family, p.providerKind); assert.equal(r.transportImplemented, p.durable === true || typeof p.runtimeTransport === 'string'); }
  assert.ok(m.providers.some((r) => r.readiness === 'RETENTION_BLOCKED'), 'excluded providers are represented with a current reason');
  assert.equal(m.purpose, 'OPERATIONAL_STATUS_ONLY');
});

test('bounded runtime transports are present without granting durable retention or claiming current operation', async()=>{
  const {currentReadinessRuntimes}=await import('../rumor2/social-readiness.js');
  const runtimes=currentReadinessRuntimes({enabled:true,state:'CURRENT_VIEW',sources:{
    REDDIT_OFFICIAL:{enabled:true,state:'OBSERVED',gateReason:null},
    STOCKTWITS_OFFICIAL:{enabled:true,state:'ENTITLEMENT_REQUIRED',gateReason:'ENTITLEMENT_REQUIRED'},
    META_FACEBOOK:{enabled:true,state:'OBSERVED',gateReason:null},
    META_INSTAGRAM:{enabled:false,state:'DISABLED',gateReason:'DISABLED'},
  }});
  runtimes.FARCASTER_OFFICIAL={enabled:true,state:'DARK',gateReason:'KEY_MISSING'};
  const m=readinessMatrix({runtimes,knownAtTs:T0});
  for(const id of ['REDDIT_OFFICIAL','STOCKTWITS_OFFICIAL','META_PUBLIC','FARCASTER_OFFICIAL']){
    const r=m.providers.find(x=>x.provider===id);assert.equal(r.transportImplemented,true);assert.ok(!r.blockers.includes('TRANSPORT_NOT_IMPLEMENTED'));assert.equal(r.durableRawContentAllowed,false);assert.equal(r.operationalEvidenceAvailable,false);assert.equal(validateReadinessRow(r),null);
  }
  assert.match(m.providers.find(x=>x.provider==='META_PUBLIC').currentlyEnabledState,/FACEBOOK:OBSERVED;INSTAGRAM:DISABLED/);
  assert.ok(m.providers.find(x=>x.provider==='FARCASTER_OFFICIAL').blockers.includes('CREDENTIAL_MISSING'));
  assert.deepEqual(m.operationalProviders,[]);
});
