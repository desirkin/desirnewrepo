// MARKET LAB — READINESS with independent dimensions (§4): implementation, contract tests, access, live verification,
// runtime, coverage and billing. liveVerification is NEVER derived from contractTests; a previous successful smoke does
// not imply ACTIVE now; one fetched metric does not mark every metric verified. READINESS_GREEN requires code tests AND
// the applicable real-source / model demonstrations; a blocked required source leaves overall readiness BLOCKED.
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
// L04: requested vs obtained coverage per required family with representative assets and native latency
export function liveReadinessManifest({ rows, familyCoverage, modelReadiness = null, generatedTs }) {
  const families = {};
  for (const fam of FAMILIES) { const required = providersForFamily(fam); const obtained = familyCoverage?.[fam] ?? null; const providerStates = required.map((id) => ({ providerId: id, liveVerification: rows[id].liveVerification, access: rows[id].access, contractTests: rows[id].contractTests })); const anyLive = providerStates.some((p) => p.liveVerification === 'PASSED'); const anyBlocked = providerStates.every((p) => p.liveVerification !== 'PASSED');
    families[fam] = { requiredProviders: required, providers: providerStates, requested: obtained?.requested ?? null, obtained: obtained?.obtained ?? null, representativeAssets: obtained?.assets ?? [], nativeLatencyMs: obtained?.nativeLatencyMs ?? null, state: anyLive ? (obtained?.complete === false ? 'PARTIAL_LIVE' : 'LIVE') : anyBlocked ? 'BLOCKED' : 'NOT_VERIFIED' }; }
  const blocked = FAMILIES.filter((f) => families[f].state === 'BLOCKED');
  const testsGreen = Object.values(rows).every((r) => r.contractTests === 'PASSED');
  const overall = blocked.length ? 'BLOCKED' : !testsGreen ? 'NOT_VERIFIED' : (modelReadiness && modelReadiness.liveVerification !== 'PASSED') ? 'BLOCKED' : 'READINESS_GREEN';
  return deepFreeze({ manifestVersion: 'market-live-readiness-1', generatedTs, overall, blockedFamilies: blocked, families, providers: rows, model: modelReadiness, law: 'READINESS_GREEN requires code tests AND the applicable real-source / model demonstrations; narrower working coverage is reported as such, never as complete coverage' });
}
