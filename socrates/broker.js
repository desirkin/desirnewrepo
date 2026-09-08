// SOCRATES V2 — the REAL, BOUNDED data broker (§11.1). Resolves validated data requests to the research owner's real
// clients or the immutable local observation store. Selection order: fresh exact-key cache; then an enabled native
// source under the declared policy / entitlement; then a configured equivalent alternative (same metric identity /
// unit / period, or an explicitly separately labelled observation). Every result carries exact request binding,
// source / input ids, response time, coverage, cache status, usage and ONE closed terminal state. Failures carry a
// closed reason and ZERO invented values. Results are diagnostics in the case envelope, never corroborating facts.
import { deepFreeze, FAMILY_REGISTRY, familyMetricIds } from '../market-lab/contracts.js';
import { ALLOWED_MAX_AGE_MS, providerEnabled, paidCallAuthorized } from '../market-lab/policy.js';
import { providersForFamily } from '../market-lab/registry.js';
import { requestIdentity } from './contract-v2.js';

export const BROKER_STATES = Object.freeze(['SATISFIED', 'PARTIAL', 'NOT_APPLICABLE', 'ACCESS_BLOCKED', 'BUDGET_BLOCKED', 'SOURCE_FAILED', 'DEADLINE_EXCEEDED', 'ALREADY_REQUESTED', 'POLICY_REJECTED']);
export const BROKER_REASONS = Object.freeze(['NONE', 'CACHE_HIT', 'NO_MAPPING_FOR_SUBJECT', 'FAMILY_NOT_ENABLED', 'PAID_NOT_AUTHORIZED', 'PROVIDER_ACCESS_DENIED', 'PROVIDER_FAILED', 'NO_OBSERVATIONS', 'DEADLINE', 'DUPLICATE_REQUEST', 'REPLAY_NETWORK_OFF', 'UNSUPPORTED_METRIC', 'SUBJECT_NOT_REGISTERED', 'HISTORY_UNAVAILABLE', 'PARTIAL_COVERAGE']);
export const METRIC_REGISTRY = deepFreeze(Object.fromEntries(Object.keys(FAMILY_REGISTRY).map((f) => [f, familyMetricIds(f)])));
const KIND_OF_FAMILY = (f) => FAMILY_REGISTRY[f]?.kinds ?? [];
export function createBroker({ owner, policy, clock = () => Date.now(), cacheSize = 256, log = () => {}, mode = 'LIVE_OBSERVATION' }) {
  const cache = new Map(); // exactKey -> { ts, observationIds, result }
  const put = (k, v) => { cache.set(k, v); if (cache.size > cacheSize) cache.delete(cache.keys().next().value); };
  const subjectCoinOf = (subjectRef, caseSubject) => (subjectRef === caseSubject.canonicalCoin ? caseSubject.canonicalCoin : (caseSubject.registeredRefs ?? []).find((r) => r.ref === subjectRef)?.canonicalCoin ?? null);
  const exactKey = (r, coin) => `${r.family}|${[...r.metricIds].sort().join(',')}|${coin}|${r.requestKind}|${r.windowStartTs ?? ''}|${r.windowEndTs ?? ''}`;
  const filterObs = (obs, r, coin, asOfTs) => obs.filter((o) => (o.subject.canonicalCoin === coin || o.subject.canonicalCoin === null) && KIND_OF_FAMILY(r.family).includes(o.kind) && o.knownAtTs <= asOfTs && (r.requestKind !== 'HISTORY' || ((o.sourceEventTs ?? o.periodEndTs ?? o.receivedTs) >= r.windowStartTs && (o.sourceEventTs ?? o.periodEndTs ?? o.receivedTs) <= r.windowEndTs)));
  const result = (r, analysisId, state, reason, extra = {}) => deepFreeze({ requestId: requestIdentity(analysisId, r), analysisId, requestKey: r.requestKey, requestKind: r.requestKind, family: r.family, metricIds: r.metricIds, subjectRef: r.subjectRef, state, reason, responseTs: clock(), sourceIds: [], inputIds: [], observationIds: [], coverage: null, cacheStatus: 'MISS', usage: { calls: 0, credits: 0, estimatedUsd: 0 }, observationsAdmitted: 0, ...extra });
  async function resolve(r, { analysisId, caseSubject, asOfTs, deadlineTs, alreadyRequested = new Set(), signal = null }) {
    const requestId = requestIdentity(analysisId, r);
    if (alreadyRequested.has(requestId)) return result(r, analysisId, 'ALREADY_REQUESTED', 'DUPLICATE_REQUEST');
    if (clock() > deadlineTs) return result(r, analysisId, 'DEADLINE_EXCEEDED', 'DEADLINE');
    const coin = subjectCoinOf(r.subjectRef, caseSubject); if (coin === null) return result(r, analysisId, 'POLICY_REJECTED', 'SUBJECT_NOT_REGISTERED');
    if (r.metricIds.some((m) => !METRIC_REGISTRY[r.family].includes(m))) return result(r, analysisId, 'POLICY_REJECTED', 'UNSUPPORTED_METRIC');
    if (r.requestedMaxAgeMs !== null && !(ALLOWED_MAX_AGE_MS[r.family] ?? []).includes(r.requestedMaxAgeMs)) return result(r, analysisId, 'POLICY_REJECTED', 'NONE', { detail: 'requestedMaxAgeMs outside policy' });
    const key = exactKey(r, coin); const now = clock();
    // 1. fresh exact-key cache
    const cached = cache.get(key); if (cached && (r.requestedMaxAgeMs === null ? now - cached.ts <= 60_000 : now - cached.ts <= r.requestedMaxAgeMs)) return result(r, analysisId, cached.result.state, 'CACHE_HIT', { ...cached.result, cacheStatus: 'FRESH_EXACT', responseTs: now, requestId });
    // 2. DETAIL / HISTORY from the immutable local store first (no network)
    const local = filterObs(owner.observations(), r, coin, asOfTs);
    if (r.requestKind === 'DETAIL') { const st = local.length ? 'SATISFIED' : 'NOT_APPLICABLE'; const res = result(r, analysisId, st, local.length ? 'NONE' : 'NO_OBSERVATIONS', { observationIds: local.map((o) => o.observationId).slice(0, 256), inputIds: local.map((o) => o.observationId).slice(0, 256), sourceIds: [...new Set(local.map((o) => o.provider))].sort(), cacheStatus: 'LOCAL_STORE', observationsAdmitted: local.length, coverage: local.length ? { startTs: Math.min(...local.map((o) => o.knownAtTs)), endTs: Math.max(...local.map((o) => o.knownAtTs)), count: local.length } : null }); put(key, { ts: now, result: res }); return res; }
    if (mode === 'REPLAY_AS_OF') { if (local.length) { const res = result(r, analysisId, r.requestKind === 'HISTORY' ? 'SATISFIED' : 'PARTIAL', r.requestKind === 'HISTORY' ? 'NONE' : 'REPLAY_NETWORK_OFF', { observationIds: local.map((o) => o.observationId).slice(0, 256), inputIds: local.map((o) => o.observationId).slice(0, 256), sourceIds: [...new Set(local.map((o) => o.provider))].sort(), cacheStatus: 'LOCAL_STORE', observationsAdmitted: local.length }); put(key, { ts: now, result: res }); return res; } return result(r, analysisId, 'NOT_APPLICABLE', 'REPLAY_NETWORK_OFF'); }
    // 3. enabled native source, then configured alternative (the owner's acquire consults policy / entitlement per provider)
    const providers = providersForFamily(r.family); const enabled = providers.filter((p) => providerEnabled(policy, p));
    if (!enabled.length) return result(r, analysisId, 'POLICY_REJECTED', 'FAMILY_NOT_ENABLED');
    const authorized = enabled.filter((p) => policy.providers[p].plan.billing === 'FREE' || paidCallAuthorized(policy, p));
    if (!authorized.length) return result(r, analysisId, 'BUDGET_BLOCKED', 'PAID_NOT_AUTHORIZED', { providers: enabled });
    const startTs = clock(); let acq;
    try { acq = await owner.acquire(r.family, coin, { signal, force: true }); } catch (err) { log(`broker acquire failed: ${String(err?.message ?? err).slice(0, 120)}`); return result(r, analysisId, 'SOURCE_FAILED', 'PROVIDER_FAILED'); }
    if (clock() > deadlineTs) return result(r, analysisId, 'DEADLINE_EXCEEDED', 'DEADLINE', { usage: { calls: acq.results.length, credits: acq.results.length, estimatedUsd: 0 } });
    const fresh = acq.observations.filter((o) => o.receivedTs >= startTs); const applicable = filterObs(fresh, { ...r, requestKind: r.requestKind === 'HISTORY' ? 'HISTORY' : 'REFRESH' }, coin, clock());
    const blocked = acq.results.filter((x) => x.state === 'ACCESS_BLOCKED'); const failed = acq.results.filter((x) => x.state === 'FAILED' || x.state === 'SOURCE_FAILED'); const okResults = acq.results.filter((x) => x.state === 'OK' || x.state === 'CACHED');
    const usage = { calls: acq.results.filter((x) => x.state !== 'CACHED' && x.state !== 'PROVIDER_DISABLED' && x.state !== 'POLICY_REJECTED').length, credits: acq.results.filter((x) => x.state === 'OK').length, estimatedUsd: 0 };
    const common = { observationIds: applicable.map((o) => o.observationId).slice(0, 256), inputIds: applicable.map((o) => o.observationId).slice(0, 256), sourceIds: [...new Set(applicable.map((o) => o.provider))].sort(), usage, observationsAdmitted: applicable.length, coverage: applicable.length ? { startTs: Math.min(...applicable.map((o) => o.receivedTs)), endTs: Math.max(...applicable.map((o) => o.receivedTs)), count: applicable.length } : null, acquisition: acq.results };
    let res;
    if (applicable.length) res = result(r, analysisId, failed.length || blocked.length ? 'PARTIAL' : 'SATISFIED', failed.length || blocked.length ? 'PARTIAL_COVERAGE' : 'NONE', common);
    else if (!okResults.length && blocked.length) res = result(r, analysisId, 'ACCESS_BLOCKED', 'PROVIDER_ACCESS_DENIED', common);
    else if (!okResults.length && failed.length) res = result(r, analysisId, 'SOURCE_FAILED', 'PROVIDER_FAILED', common);
    else if (!okResults.length && acq.results.every((x) => x.state === 'PROVIDER_DISABLED' || x.state === 'POLICY_REJECTED')) res = result(r, analysisId, 'POLICY_REJECTED', 'FAMILY_NOT_ENABLED', common);
    else res = result(r, analysisId, r.requestKind === 'HISTORY' ? 'NOT_APPLICABLE' : 'NOT_APPLICABLE', acq.results.length ? (r.requestKind === 'HISTORY' ? 'HISTORY_UNAVAILABLE' : 'NO_OBSERVATIONS') : 'NO_MAPPING_FOR_SUBJECT', common);
    put(key, { ts: clock(), result: res }); return res;
  }
  return { resolve, cacheSize: () => cache.size, metricRegistry: METRIC_REGISTRY, allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, states: BROKER_STATES };
}
