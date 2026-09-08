// MARKET LAB — READINESS with independent dimensions (§4, closeout §11): implementation, contract tests, access, live
// verification, runtime, coverage and billing. liveVerification is NEVER derived from contractTests; a previous
// successful smoke does not imply ACTIVE now; one fetched metric does not mark every metric verified; a provider smoke on
// an unrelated endpoint never establishes obtained coverage for a family; null / missing model verification never allows
// READINESS_GREEN. READINESS_GREEN requires code tests AND the applicable real-source AND model demonstrations.
import { deepFreeze, PROVIDER_IDS, FAMILIES } from './contracts.js';
import { PROVIDERS, endpointsOf, providersForFamily } from './registry.js';
import { credentialPresence } from './policy.js';

export const IMPLEMENTATION_STATES = Object.freeze(['IMPLEMENTED', 'NOT_IMPLEMENTED']);
export const CONTRACT_TEST_STATES = Object.freeze(['PASSED', 'FAILED', 'NOT_RUN']);
export const ACCESS_STATES = Object.freeze(['PUBLIC', 'CONFIGURED', 'CREDENTIAL_MISSING', 'ENTITLEMENT_DENIED', 'UNVERIFIED']);
export const LIVE_STATES = Object.freeze(['PASSED', 'FAILED', 'NOT_RUN']);
export const RUNTIME_STATES = Object.freeze(['STOPPED', 'STARTING', 'ACTIVE', 'DEGRADED', 'BACKOFF', 'BLOCKED']);
export const BILLING_STATES = Object.freeze(['FREE', 'INCLUDED_QUOTA', 'METERED', 'UNKNOWN']);
export const OVERALL_STATES = Object.freeze(['READINESS_GREEN', 'BLOCKED', 'NOT_VERIFIED']);
export const FAMILY_LIVE_STATES = Object.freeze(['LIVE', 'PARTIAL_LIVE', 'BLOCKED', 'NOT_VERIFIED']);
// the named contract test file per provider (readiness reads a test report; it never assumes PASSED)
export const CONTRACT_TEST_FILES = deepFreeze({ KRAKEN_SPOT: 'test/market-lab-providers.test.js', COINBASE_SPOT: 'test/market-lab-providers.test.js', KRAKEN_DERIVATIVES: 'test/market-lab-providers.test.js', DERIBIT: 'test/market-lab-providers.test.js', BYBIT: 'test/market-lab-providers.test.js', COINGECKO: 'test/market-lab-providers.test.js', GECKOTERMINAL: 'test/market-lab-providers.test.js', DEFILLAMA: 'test/market-lab-providers.test.js', COINGLASS: 'test/market-lab-providers.test.js', CRYPTOQUANT: 'test/market-lab-providers.test.js', SANTIMENT: 'test/market-lab-providers.test.js', COINMETRICS: 'test/market-lab-providers.test.js', FRED: 'test/market-lab-providers.test.js', TWELVEDATA: 'test/market-lab-providers.test.js', SETTLED_RECORDS: 'test/market-lab-providers.test.js', TOKENOMIST: 'test/market-lab-providers.test.js' });
export const IMPLEMENTED_PROVIDERS = deepFreeze(Object.fromEntries(PROVIDER_IDS.map((id) => [id, 'IMPLEMENTED'])));

// testReport: { [providerId]: 'PASSED'|'FAILED' } from an actual test run (owner-supplied / CI artifact); liveReport: { [providerId]: { state, ts, endpointId, asset, evidence } }
export function providerReadiness({ policy, env = {}, clientStatus = {}, testReport = null, liveReport = null }) {
  const presence = credentialPresence(policy, env); const rows = {};
  for (const id of PROVIDER_IDS) {
    const p = policy.providers[id]; const st = clientStatus[id] ?? null; const lf = st?.lastFailure ?? null;
    const access = lf?.access ?? presence[id]?.access ?? 'UNVERIFIED';
    const live = liveReport?.[id] ?? null;
    rows[id] = { providerId: id, name: PROVIDERS[id].name, ticket: PROVIDERS[id].ticket, implementation: IMPLEMENTED_PROVIDERS[id], contractTests: testReport?.[id] ?? 'NOT_RUN', contractTestFile: CONTRACT_TEST_FILES[id], access, liveVerification: live?.state ?? 'NOT_RUN', liveEvidence: live ? { ts: live.ts ?? null, endpointId: live.endpointId ?? null, asset: live.asset ?? null, evidence: live.evidence ?? null } : null, runtime: st?.runtime ?? 'STOPPED', enabled: p?.enabled === true, coverage: { families: [...new Set(endpointsOf(id).flatMap((e) => e.families))].sort(), endpoints: endpointsOf(id).map((e) => e.endpointId), omissions: PROVIDERS[id].accessNote ?? null }, billing: { state: p?.plan.billing ?? 'UNKNOWN', planName: p?.plan.name ?? null, remainingCalls: p?.plan.remainingCalls ?? null, includedCallsPerMonth: p?.plan.includedCallsPerMonth ?? null, quoteUsdPerMonth: p?.plan.quoteUsdPerMonth ?? null, localCaps: p?.limits ?? null, pricing: PROVIDERS[id].pricing ?? null }, counters: st?.counters ?? null, lastFailure: lf ? { kind: lf.kind, reasonCode: lf.reasonCode, ts: lf.ts } : null };
  }
  return deepFreeze(rows);
}
// familyCoverage: { [family]: { requested, obtained, assets, nativeLatencyMs, complete, providerId, smokeTs, metrics } } — OBTAINED family evidence bound to a smoke.
// A family is LIVE only when obtained evidence exists for it (its qualified source demonstrated the family's own endpoint / metrics),
// PARTIAL_LIVE when that evidence is explicitly partial, BLOCKED when every required provider is blocked / not verified, else NOT_VERIFIED.
// A provider PASSED on another endpoint (catalog, heartbeat) is a provider fact, never family coverage.
export function liveReadinessManifest({ rows, familyCoverage, modelReadiness = null, generatedTs }) {
  const families = {};
  for (const fam of FAMILIES) {
    const required = providersForFamily(fam); const obtained = familyCoverage?.[fam] ?? null;
    const providerStates = required.map((id) => ({ providerId: id, liveVerification: rows[id].liveVerification, access: rows[id].access, contractTests: rows[id].contractTests, enabled: rows[id].enabled }));
    const evidence = obtained && obtained.obtained !== null && obtained.obtained !== undefined && (obtained.obtained === true || (typeof obtained.obtained === 'number' && obtained.obtained > 0)) && (!obtained.providerId || required.includes(obtained.providerId));
    const state = evidence ? (obtained.complete === false ? 'PARTIAL_LIVE' : 'LIVE') : providerStates.some((p) => p.liveVerification === 'PASSED' || p.access === 'CONFIGURED' || p.access === 'PUBLIC') ? 'NOT_VERIFIED' : 'BLOCKED';
    families[fam] = { requiredProviders: required, providers: providerStates, requested: obtained?.requested ?? null, obtained: obtained?.obtained ?? null, representativeAssets: obtained?.assets ?? [], nativeLatencyMs: obtained?.nativeLatencyMs ?? null, obtainedBy: obtained?.providerId ?? null, smokeTs: obtained?.smokeTs ?? null, metrics: obtained?.metrics ?? null, state, note: evidence ? null : 'no OBTAINED family evidence: a provider smoke on another endpoint does not establish this family' };
  }
  const blocked = FAMILIES.filter((f) => families[f].state === 'BLOCKED'); const notLive = FAMILIES.filter((f) => families[f].state !== 'LIVE');
  const testsGreen = Object.values(rows).every((r) => r.contractTests === 'PASSED');
  const modelVerified = modelReadiness !== null && modelReadiness !== undefined && modelReadiness.liveVerification === 'PASSED';
  const overall = blocked.length ? 'BLOCKED' : !testsGreen ? 'NOT_VERIFIED' : !modelVerified ? 'BLOCKED' : notLive.length ? 'NOT_VERIFIED' : 'READINESS_GREEN';
  const blockers = [...(blocked.length ? [`families blocked: ${blocked.join(',')}`] : []), ...(testsGreen ? [] : ['contract tests not PASSED for every provider']), ...(modelVerified ? [] : ['model live verification absent or not PASSED']), ...(notLive.length && !blocked.length ? [`families without obtained live evidence: ${notLive.join(',')}`] : [])];
  return deepFreeze({ manifestVersion: 'market-live-readiness-2', generatedTs, overall, blockers, blockedFamilies: blocked, familiesNotLive: notLive, families, providers: rows, model: modelReadiness, law: 'READINESS_GREEN requires code tests AND obtained real-source evidence per required family AND a PASSED model demonstration; narrower working coverage is reported as such, never as complete coverage' });
}
