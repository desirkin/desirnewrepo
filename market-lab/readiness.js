// MARKET LAB — READINESS with independent dimensions (§4, closeout §11): implementation, contract tests, access, live
// verification, runtime, coverage and billing. liveVerification is NEVER derived from contractTests; a previous
// successful smoke does not imply ACTIVE now; one fetched metric does not mark every metric verified; a provider smoke on
// an unrelated endpoint never establishes obtained coverage for a family; null / missing model verification never allows
// READINESS_GREEN. READINESS_GREEN requires code tests AND the applicable real-source AND model demonstrations.
import { deepFreeze, PROVIDER_IDS, FAMILIES, familyMetricIds } from './contracts.js';
import { PROVIDERS, endpointsOf, endpointOf, providersForFamily } from './registry.js';
import { credentialPresence, ALLOWED_MAX_AGE_MS } from './policy.js';

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
// ---- closeout P1: qualification of OBTAINED family evidence -------------------------------------------------------------
// A count is never proof. A family is LIVE only from QUALIFIED evidence that names the selected provider (required for the
// family, enabled, live-PASSED as a provider, with usable access), a family-relevant registry endpoint, the requested and
// obtained assets and registered metrics, the measured interval, the knowledge clock with freshness under the family's own
// policy age (ALLOWED_MAX_AGE_MS — no invented universal threshold) and a support / census basis. A historical smoke stays a
// separate, non-qualifying fact. Absent or incomplete proof yields a non-green family with explicit missing-proof reasons;
// nothing here throws.
export const SUPPORT_BASES = Object.freeze(['PERIOD_GRID', 'COVERAGE_RECORDS', 'SNAPSHOT', 'INDICATOR_WARMUP', 'CENSUS_RECORD']);
export const FAMILY_EVIDENCE_KEYS = Object.freeze(['providerId', 'endpointId', 'requested', 'obtained', 'assets', 'metrics', 'interval', 'knownAtTs', 'requestedMaxAgeMs', 'support', 'complete', 'nativeLatencyMs', 'smokeTs']);
const isTs = (v) => Number.isSafeInteger(v) && v > 0; const isCount = (v) => Number.isSafeInteger(v) && v >= 0; const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idList = (v, max = 64) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(x)) && new Set(v).size === v.length;
const subset = (a, b) => a.every((x) => b.includes(x));
export function qualifyFamilyEvidence(family, ev, rows, { generatedTs }) {
  const missing = []; const add = (r) => { if (!missing.includes(r)) missing.push(r); };
  if (!FAMILIES.includes(family)) return { qualified: false, complete: false, missing: ['FAMILY_UNKNOWN'] };
  if (!isPlain(ev)) return { qualified: false, complete: false, missing: ['NO_FAMILY_EVIDENCE'] };
  for (const k of Object.keys(ev)) if (!FAMILY_EVIDENCE_KEYS.includes(k)) add('UNDECLARED_MEMBER');
  const required = providersForFamily(family); const row = typeof ev.providerId === 'string' ? rows?.[ev.providerId] ?? null : null;
  if (typeof ev.providerId !== 'string' || !required.includes(ev.providerId)) add('PROVIDER_NOT_SELECTED_FOR_FAMILY');
  else if (!row) add('PROVIDER_ROW_MISSING');
  else { if (row.liveVerification !== 'PASSED') add('PROVIDER_LIVE_NOT_PASSED'); if (row.enabled !== true) add('PROVIDER_NOT_ENABLED'); if (!['PUBLIC', 'CONFIGURED'].includes(row.access)) add('PROVIDER_ACCESS_UNUSABLE'); }
  const endpoint = typeof ev.providerId === 'string' && typeof ev.endpointId === 'string' ? endpointOf(ev.providerId, ev.endpointId) : null;
  if (!endpoint) add('ENDPOINT_NOT_IN_REGISTRY'); else if (!endpoint.families.includes(family)) add('ENDPOINT_NOT_FAMILY_RELEVANT');
  const familyMetrics = familyMetricIds(family);
  if (!isPlain(ev.metrics) || !idList(ev.metrics.requested) || !idList(ev.metrics.obtained) || !subset(ev.metrics.requested, familyMetrics) || !subset(ev.metrics.obtained, ev.metrics.requested)) add('METRIC_PROOF_MISSING');
  if (!isPlain(ev.assets) || !idList(ev.assets.requested) || !idList(ev.assets.obtained) || !subset(ev.assets.obtained, ev.assets.requested)) add('ASSET_PROOF_MISSING');
  if (!isCount(ev.requested) || !isCount(ev.obtained) || ev.obtained < 1 || ev.obtained > ev.requested) add('OBTAINED_COUNT_UNBOUND');
  // correction A: COMPLETE concerns the declared requested scope. The obtained asset set, metric set and count must each equal the
  // requested ones (as sets: order is irrelevant; membership is the fact); a shortfall is a named partial, and a complete claim
  // over a shortfall is a contradiction that never qualifies. Counts are reconciled in their own declared meaning, never inferred
  // from the lengths of the asset or metric arrays.
  const shortfall = [];
  if (isPlain(ev.assets) && idList(ev.assets.requested) && idList(ev.assets.obtained) && !subset(ev.assets.requested, ev.assets.obtained)) shortfall.push('ASSET_SCOPE_SHORTFALL');
  if (isPlain(ev.metrics) && idList(ev.metrics.requested) && idList(ev.metrics.obtained) && !subset(ev.metrics.requested, ev.metrics.obtained)) shortfall.push('METRIC_SCOPE_SHORTFALL');
  if (isCount(ev.requested) && isCount(ev.obtained) && ev.obtained < ev.requested) shortfall.push('COUNT_SHORTFALL');
  if (shortfall.length && (ev.complete === true || ev.support?.state === 'COMPLETE')) { add('COMPLETION_CLAIM_CONTRADICTED'); for (const r of shortfall) add(r); }
  if (!isPlain(ev.interval) || !isTs(ev.interval.startTs) || !isTs(ev.interval.endTs) || ev.interval.endTs < ev.interval.startTs) add('INTERVAL_MISSING');
  if (!isTs(ev.knownAtTs)) add('KNOWN_AT_MISSING'); else if (isPlain(ev.interval) && isTs(ev.interval.endTs) && ev.knownAtTs < ev.interval.endTs) add('KNOWN_BEFORE_MEASUREMENT');
  const ages = ALLOWED_MAX_AGE_MS[family] ?? [];
  if (!ages.includes(ev.requestedMaxAgeMs)) add('FRESHNESS_POLICY_NOT_NAMED');
  else if (isTs(ev.knownAtTs)) { if (!isTs(generatedTs) || generatedTs < ev.knownAtTs) add('GENERATED_BEFORE_KNOWN'); else if (generatedTs - ev.knownAtTs > ev.requestedMaxAgeMs) add('FRESHNESS_UNMET'); }
  if (!isPlain(ev.support) || !['COMPLETE', 'PARTIAL'].includes(ev.support.state) || !SUPPORT_BASES.includes(ev.support.basis)) add('SUPPORT_BASIS_MISSING');
  if (typeof ev.complete !== 'boolean' || (isPlain(ev.support) && ev.complete !== (ev.support.state === 'COMPLETE'))) add('COMPLETENESS_DISAGREES_WITH_SUPPORT');
  if (ev.nativeLatencyMs !== undefined && ev.nativeLatencyMs !== null && !isCount(ev.nativeLatencyMs)) add('LATENCY_MALFORMED');
  if (ev.smokeTs !== undefined && ev.smokeTs !== null && !isTs(ev.smokeTs)) add('SMOKE_TS_MALFORMED');
  return { qualified: missing.length === 0, complete: missing.length === 0 && ev.complete === true && shortfall.length === 0, missing, shortfall };
}
// the model demonstration must be a SUPPORTED demonstration: PASSED plus the identity of the run (clock, model, request, usage
// with real output); a bare PASSED flag, a null or a historical note never qualifies
export function qualifyModelDemonstration(m, { generatedTs = null } = {}) {
  const missing = [];
  if (!isPlain(m)) return { qualified: false, missing: ['MODEL_READINESS_ABSENT'] };
  if (generatedTs !== null && !isTs(generatedTs)) missing.push('GENERATED_CLOCK_MALFORMED');
  if (m.liveVerification !== 'PASSED') missing.push('MODEL_LIVE_NOT_PASSED');
  const d = isPlain(m.demonstration) ? m.demonstration : null;
  if (!d) missing.push('MODEL_DEMONSTRATION_MISSING');
  else { if (!isTs(d.ts)) missing.push('MODEL_DEMONSTRATION_CLOCK_MISSING'); else if (isTs(generatedTs) && d.ts > generatedTs) missing.push('MODEL_DEMONSTRATION_NOT_YET_OCCURRED'); /* correction A: a demonstration counts only once it has happened by this manifest's clock (no invented expiry) */ if (typeof d.model !== 'string' || !d.model.length || d.model.length > 120) missing.push('MODEL_DEMONSTRATION_MODEL_MISSING'); if (typeof d.requestId !== 'string' || !d.requestId.length || d.requestId.length > 200) missing.push('MODEL_DEMONSTRATION_REQUEST_MISSING'); if (!isPlain(d.usage) || !isCount(d.usage.inputTokens) || !isCount(d.usage.outputTokens) || d.usage.inputTokens < 1 || d.usage.outputTokens < 1) missing.push('MODEL_DEMONSTRATION_USAGE_MISSING'); }
  return { qualified: missing.length === 0, missing };
}
// familyCoverage: { [family]: qualified family evidence (FAMILY_EVIDENCE_KEYS) }. A family is LIVE only from QUALIFIED complete
// evidence, PARTIAL_LIVE from qualified evidence whose support is explicitly PARTIAL, NOT_VERIFIED when evidence is absent or
// fails qualification (missing proof named), BLOCKED when every required provider is blocked / not verified.
// A provider PASSED on another endpoint (catalog, heartbeat) is a provider fact, never family coverage.
export function liveReadinessManifest({ rows, familyCoverage, modelReadiness = null, generatedTs }) {
  const families = {};
  for (const fam of FAMILIES) {
    const required = providersForFamily(fam); const obtained = isPlain(familyCoverage) ? familyCoverage[fam] ?? null : null;
    const providerStates = required.map((id) => ({ providerId: id, liveVerification: rows[id].liveVerification, access: rows[id].access, contractTests: rows[id].contractTests, enabled: rows[id].enabled }));
    const q = obtained ? qualifyFamilyEvidence(fam, obtained, rows, { generatedTs }) : { qualified: false, complete: false, missing: ['NO_FAMILY_EVIDENCE'], shortfall: [] };
    const state = q.qualified ? (q.complete ? 'LIVE' : 'PARTIAL_LIVE') : providerStates.some((p) => p.liveVerification === 'PASSED' || p.access === 'CONFIGURED' || p.access === 'PUBLIC') ? 'NOT_VERIFIED' : 'BLOCKED';
    const ev = isPlain(obtained) ? obtained : null;
    families[fam] = { requiredProviders: required, providers: providerStates, requested: isCount(ev?.requested) ? ev.requested : null, obtained: isCount(ev?.obtained) ? ev.obtained : null, requestedAssets: isPlain(ev?.assets) && Array.isArray(ev.assets.requested) ? ev.assets.requested.slice(0, 64) : [], obtainedAssets: isPlain(ev?.assets) && Array.isArray(ev.assets.obtained) ? ev.assets.obtained.slice(0, 64) : [], requestedMetrics: isPlain(ev?.metrics) && Array.isArray(ev.metrics.requested) ? ev.metrics.requested.slice(0, 64) : [], obtainedMetrics: isPlain(ev?.metrics) && Array.isArray(ev.metrics.obtained) ? ev.metrics.obtained.slice(0, 64) : [], interval: isPlain(ev?.interval) ? { startTs: ev.interval.startTs ?? null, endTs: ev.interval.endTs ?? null } : null, knownAtTs: isTs(ev?.knownAtTs) ? ev.knownAtTs : null, requestedMaxAgeMs: Number.isSafeInteger(ev?.requestedMaxAgeMs) ? ev.requestedMaxAgeMs : null, support: isPlain(ev?.support) ? { state: ev.support.state ?? null, basis: ev.support.basis ?? null } : null, nativeLatencyMs: isCount(ev?.nativeLatencyMs) ? ev.nativeLatencyMs : null, obtainedBy: typeof ev?.providerId === 'string' ? ev.providerId : null, endpointId: typeof ev?.endpointId === 'string' ? ev.endpointId : null, historicalSmokeTs: isTs(ev?.smokeTs) ? ev.smokeTs : null, qualified: q.qualified, missingProof: q.missing, scopeShortfall: q.shortfall ?? [], state, note: q.qualified ? null : ev ? `family evidence not qualified: ${q.missing.join(',')} — counts, a historical smoke or a provider smoke on another endpoint never establish this family` : 'no OBTAINED family evidence: a provider smoke on another endpoint does not establish this family' };
  }
  const blocked = FAMILIES.filter((f) => families[f].state === 'BLOCKED'); const notLive = FAMILIES.filter((f) => families[f].state !== 'LIVE');
  const testsGreen = Object.values(rows).every((r) => r.contractTests === 'PASSED');
  const model = qualifyModelDemonstration(modelReadiness, { generatedTs }); const modelVerified = model.qualified;
  const overall = blocked.length ? 'BLOCKED' : !testsGreen ? 'NOT_VERIFIED' : !modelVerified ? 'BLOCKED' : notLive.length ? 'NOT_VERIFIED' : 'READINESS_GREEN';
  const blockers = [...(blocked.length ? [`families blocked: ${blocked.join(',')}`] : []), ...(testsGreen ? [] : ['contract tests not PASSED for every provider']), ...(modelVerified ? [] : [`model live demonstration absent or not qualified: ${model.missing.join(',')}`]), ...(notLive.length && !blocked.length ? [`families without qualified live evidence: ${notLive.join(',')}`] : [])];
  return deepFreeze({ manifestVersion: 'market-live-readiness-3', generatedTs, overall, blockers, blockedFamilies: blocked, familiesNotLive: notLive, families, providers: rows, model: modelReadiness, modelQualification: model, law: 'READINESS_GREEN requires code tests AND qualified obtained real-source evidence per required family (selected provider, family-relevant endpoint, requested / obtained assets and metrics, interval, knowledge clock fresh under the family policy age, support basis) AND a supported model demonstration; counts, historical smokes and unrelated endpoints never qualify; narrower working coverage is reported as such, never as complete coverage' });
}
