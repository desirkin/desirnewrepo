// SOCRATES V2 — the REAL, BOUNDED data broker (§11.1, closeout R04). Resolves validated data requests to the research
// owner's real clients or the immutable local observation store. A result is SATISFIED only when EVERY requested metric is
// matched by value-bearing observations of its declared native inputs, for the registered subject (a null-subject
// observation satisfies only a global-scope metric), inside the requested interval / freshness as measured on the source
// knowledge clocks, over positive coverage for the claimed answer; one matching member plus one missing member is
// PARTIAL. Selection order: cached EVIDENCE (rebound to the current request, zero new usage, never a later as-of into an
// earlier replay); then the local store (DETAIL: local only); then the guarded owner acquisition (REFRESH / HISTORY) with the
// requested metrics and window forwarded. Every result carries exact request binding, exact admitted unique ids and
// counts, the actual guarded usage, coverage, cache status and ONE closed terminal state. Failures carry a closed reason
// and ZERO invented values. Results are diagnostics in the case envelope, never corroborating facts.
import { deepFreeze, FAMILY_REGISTRY, familyMetricIds, canonicalDigest, subjectId } from '../market-lab/contracts.js';
import { indicators } from '../market-lab/recipes.js';
import { selectNativeSeries, selectionFacts, seriesKeyOf } from '../market-lab/native-series.js';
import { ALLOWED_MAX_AGE_MS, providerEnabled, paidCallAuthorized } from '../market-lab/policy.js';
import { providersForFamily } from '../market-lab/registry.js';
import { METRIC_MAP, metricInputMatch } from '../evidence/research-builder.js';
import { requestIdentity } from './contract-v2.js';

export const BROKER_STATES = Object.freeze(['SATISFIED', 'PARTIAL', 'NOT_APPLICABLE', 'ACCESS_BLOCKED', 'BUDGET_BLOCKED', 'SOURCE_FAILED', 'DEADLINE_EXCEEDED', 'ALREADY_REQUESTED', 'POLICY_REJECTED']);
export const BROKER_REASONS = Object.freeze(['NONE', 'CACHE_HIT', 'NO_MAPPING_FOR_SUBJECT', 'FAMILY_NOT_ENABLED', 'PAID_NOT_AUTHORIZED', 'PROVIDER_ACCESS_DENIED', 'PROVIDER_FAILED', 'NO_OBSERVATIONS', 'DEADLINE', 'DUPLICATE_REQUEST', 'REPLAY_NETWORK_OFF', 'UNSUPPORTED_METRIC', 'SUBJECT_NOT_REGISTERED', 'HISTORY_UNAVAILABLE', 'PARTIAL_COVERAGE', 'METRIC_UNMATCHED', 'FRESHNESS_UNMET', 'VALUE_MISSING', 'QUOTA_REFUSED', 'REQUEST_MALFORMED', 'SEMANTIC_DUPLICATE']);
export const METRIC_REGISTRY = deepFreeze(Object.fromEntries(Object.keys(FAMILY_REGISTRY).map((f) => [f, familyMetricIds(f)])));
export const MAX_ID_LIST = 256;
const REQUEST_KINDS = ['REFRESH', 'DETAIL', 'HISTORY', 'SCHEDULE'];
const isTs = (v) => Number.isSafeInteger(v) && v > 0;
export function createBroker({ owner, policy, clock = () => Date.now(), cacheSize = 256, log = () => {}, mode = 'LIVE_OBSERVATION' }) {
  const cache = new Map(); // evidence cache: semanticKey -> { asOfTs, mode, policyDigest, observations, coverage, acquisition, usage, acquiredTs }
  const put = (k, v) => { cache.set(k, v); if (cache.size > cacheSize) cache.delete(cache.keys().next().value); };
  const subjectCoinOf = (subjectRef, caseSubject) => (subjectRef === caseSubject.canonicalCoin ? caseSubject.canonicalCoin : (caseSubject.registeredRefs ?? []).find((r) => r.ref === subjectRef)?.canonicalCoin ?? null);
  // the SEMANTIC identity of a question: family, metric set, subject, kind, window and freshness — never the model's arbitrary key
  const semanticKey = (r, coin) => `${r.family}|${[...r.metricIds].sort().join(',')}|${coin}|${r.requestKind}|${r.windowStartTs ?? ''}|${r.windowEndTs ?? ''}|${r.requestedMaxAgeMs ?? ''}`;
  const emptyUsage = () => ({ calls: 0, credits: 0, dispatched: 0, refused: 0, unresolved: 0, estimatedUsd: 0 });
  const result = (r, analysisId, state, reason, extra = {}) => deepFreeze({ requestId: requestIdentity(analysisId, r), analysisId, requestKey: r.requestKey, requestKind: r.requestKind, family: r.family, metricIds: r.metricIds, subjectRef: r.subjectRef, state, reason, responseTs: clock(), sourceIds: [], inputIds: [], observationIds: [], idsTruncated: false, coverage: null, cacheStatus: 'MISS', usage: emptyUsage(), observationsAdmitted: 0, metrics: null, ...extra });
  const requestError = (r) => { if (!r || typeof r !== 'object') return 'request malformed'; if (!REQUEST_KINDS.includes(r.requestKind) || !FAMILY_REGISTRY[r.family] || !Array.isArray(r.metricIds) || !r.metricIds.length || r.metricIds.length > 8 || new Set(r.metricIds).size !== r.metricIds.length || typeof r.subjectRef !== 'string' || typeof r.requestKey !== 'string') return 'request shape outside the closed contract'; if (r.metricIds.some((m) => !METRIC_REGISTRY[r.family].includes(m))) return 'UNSUPPORTED_METRIC'; if (!(r.windowStartTs === null || isTs(r.windowStartTs)) || !(r.windowEndTs === null || isTs(r.windowEndTs)) || (r.windowStartTs !== null && r.windowEndTs !== null && r.windowEndTs < r.windowStartTs)) return 'window malformed'; if (r.requestKind === 'HISTORY' && !(isTs(r.windowStartTs) && isTs(r.windowEndTs))) return 'HISTORY needs a window'; if (!(r.requestedMaxAgeMs === null || (Number.isSafeInteger(r.requestedMaxAgeMs) && r.requestedMaxAgeMs > 0))) return 'requestedMaxAgeMs malformed'; return null; };
  // ---- satisfaction (closeout P4): every requested metric matched by value-bearing native inputs for the subject, window and
  // freshness, over DEMONSTRATED support — never a row count. Identities are deduplicated first (one observation repeated is
  // one observation). HISTORY support is a complete expected-period grid derived from the observations' own declared periods
  // (a lawful daily/hourly/bar census basis) with no missing period inside the requested interval and an interval no shorter
  // than one period; point observations need positive OBSERVED coverage records spanning the interval. Derived candle metrics
  // use the ACTUAL indicators() warmup over contiguous same-interval closed bars. A cache hit re-runs the same law, so a hit
  // can never erase a gap. Snapshot metrics rest on the freshness / identity law above.
  function evaluate(rawObs, r, coin, { asOfTs, receiptCutoffTs = null, coverage = [] }) {
    const obs = []; const seenIds = new Set(); let duplicateIdentities = 0;
    for (const o of rawObs) { if (seenIds.has(o.observationId)) { duplicateIdentities += 1; continue; } seenIds.add(o.observationId); obs.push(o); }
    const perMetric = {}; const admitted = new Map(); let allSatisfied = r.metricIds.length > 0; let anySatisfied = false; const reasons = new Set();
    for (const metricId of r.metricIds) {
      const m = METRIC_MAP[r.family]?.[metricId]; if (!m) { perMetric[metricId] = { state: 'UNSUPPORTED', matched: 0 }; allSatisfied = false; reasons.add('METRIC_UNMATCHED'); continue; }
      const matches = []; let fresh = 0; let stale = 0; let nullValues = 0; let wrongSubject = 0; let outOfWindow = 0;
      for (const o of obs) {
        if (o.knownAtTs > asOfTs) continue; if (receiptCutoffTs !== null && o.receivedTs < receiptCutoffTs) continue;
        const subjectOk = o.subject.canonicalCoin === coin || (o.subject.canonicalCoin === null && m.scope === 'GLOBAL'); if (!subjectOk) { if (o.subject.canonicalCoin === null) wrongSubject += 1; continue; }
        const match = metricInputMatch(m, o); if (!match.ok) { if (match.reason === 'VALUE_NULL') nullValues += 1; continue; }
        const measureTs = o.sourceEventTs ?? o.periodEndTs ?? o.receivedTs; // the source measurement / knowledge clock, never a cache clock
        if (r.requestKind === 'HISTORY') { if (!(measureTs >= r.windowStartTs && measureTs <= r.windowEndTs)) { outOfWindow += 1; continue; } }
        else if (r.requestedMaxAgeMs !== null && asOfTs - (o.periodEndTs !== null && o.periodEndTs <= asOfTs ? o.knownAtTs : measureTs) > r.requestedMaxAgeMs) { stale += 1; continue; }
        matches.push(o); fresh += 1;
      }
      // correction B: after the as-of / freshness admission, ONE version per native period of each compatible series is selected;
      // envelope repeats, revisions and conflicts are disclosed and never counted as periods, bars or admitted inputs
      const selection = selectNativeSeries(matches, { asOfTs }); const selected = selection.selected;
      // a derived metric needs EVERY declared native input
      // closeout B02: a derived metric's constituents must be recipe-compatible (same provider / entity set / chain / unit / window / period);
      // an inflow in one unit and an outflow in another never satisfy exchange_net_flow
      const needed = m.native ?? null; const nativeSeen = new Set();
      if (needed && needed.length > 1 && m.nativeOf) { const groups = new Map(); for (const o of selected) { const p = o.payload ?? {}; const k = `${o.provider}|${p.entitySet ?? ''}|${p.chain ?? ''}|${p.unit ?? ''}|${p.window ?? ''}|${o.periodStartTs ?? ''}|${o.periodEndTs ?? ''}`; if (!groups.has(k)) groups.set(k, new Set()); groups.get(k).add(m.nativeOf(o)); } const complete = [...groups.values()].find((g) => needed.every((n) => g.has(n))); if (complete) for (const n of complete) nativeSeen.add(n); else for (const g of groups.values()) for (const n of g) nativeSeen.add(n); if (!complete && groups.size > 1) { for (const n of needed) if (![...groups.values()].every((g) => g.has(n))) nativeSeen.delete(n); } }
      else for (const o of selected) nativeSeen.add(m.nativeOf ? m.nativeOf(o) : o.kind);
      const constituentsMissing = needed ? needed.filter((n) => !nativeSeen.has(n)) : [];
      const support = selected.length ? metricSupport(m, metricId, selected, r, coverage) : { state: 'NONE', basis: 'NO_MATCH', reasons: ['NO_MATCH'] };
      const historyThin = r.requestKind === 'HISTORY' && support.state !== 'COMPLETE';
      const satisfied = selected.length > 0 && constituentsMissing.length === 0 && support.state === 'COMPLETE';
      perMetric[metricId] = { state: satisfied ? 'SATISFIED' : selected.length ? 'PARTIAL' : 'UNMATCHED', matched: selected.length, envelopes: matches.length, fresh, stale, nullValues, wrongSubject, outOfWindow, constituentsMissing, nativeInputs: needed, historyThin, support, duplicateIdentities, selection: selectionFacts(selection) };
      if (satisfied) { anySatisfied = true; for (const o of selected) admitted.set(o.observationId, o); } else { allSatisfied = false; if (stale && !selected.length) reasons.add('FRESHNESS_UNMET'); else if (nullValues && !selected.length) reasons.add('VALUE_MISSING'); else if (historyThin || constituentsMissing.length || (selected.length && support.state !== 'COMPLETE')) reasons.add('PARTIAL_COVERAGE'); else reasons.add('METRIC_UNMATCHED'); if (selected.length) for (const o of selected) admitted.set(o.observationId, o); }
    }
    return { allSatisfied, anySatisfied, perMetric, admitted: [...admitted.values()], reasons: [...reasons], duplicateIdentities };
  }
  // the per-metric support law (closeout P4). Returns { state: COMPLETE | PARTIAL, basis, reasons, ...facts }; never a row count.
  const MAX_MISSING_LISTED = 16;
  const INDICATOR_WARMUP = Object.freeze({ sma: (i) => i.sma[60] !== null, ema: (i) => i.ema[60] !== null, realized_volatility: (i) => i.realizedVolatility[60] !== null, atr14: (i) => i.atr14 !== null, rsi14: (i) => i.rsi14.state !== 'WARMUP', macd: (i) => i.macd !== null, bollinger20: (i) => i.bollinger20 !== null, prior_range: (i) => i.prior60 !== null, breakout_distance: (i) => i.prior20 !== null });
  function periodGrid(list, startTs, endTs) {
    // expected periods: every period of the observations' own grid that overlaps [startTs, endTs]; present: the distinct periods seen
    const lengths = new Set(list.map((o) => o.periodEndTs - o.periodStartTs)); if (lengths.size !== 1) return { state: 'PARTIAL', reasons: ['MIXED_PERIODS'], periodMs: null, expectedPeriods: null, presentPeriods: null, missingPeriods: null, missingStarts: [] };
    const periodMs = [...lengths][0]; if (!(periodMs > 0)) return { state: 'PARTIAL', reasons: ['PERIOD_MALFORMED'], periodMs, expectedPeriods: null, presentPeriods: null, missingPeriods: null, missingStarts: [] };
    const anchor = Math.min(...list.map((o) => o.periodStartTs)); const off = (t) => (t - anchor) / periodMs;
    if (list.some((o) => !Number.isInteger(off(o.periodStartTs)))) return { state: 'PARTIAL', reasons: ['PERIOD_GRID_MISALIGNED'], periodMs, expectedPeriods: null, presentPeriods: null, missingPeriods: null, missingStarts: [] };
    if (endTs - startTs < periodMs) return { state: 'PARTIAL', reasons: ['INTERVAL_BELOW_RESOLUTION'], periodMs, expectedPeriods: null, presentPeriods: new Set(list.map((o) => o.periodStartTs)).size, missingPeriods: null, missingStarts: [] };
    const kMin = Math.ceil((startTs - periodMs + 1 - anchor) / periodMs); const kMax = Math.floor((endTs - 1 - anchor) / periodMs); const expected = Math.max(0, kMax - kMin + 1);
    const present = new Set(); for (const o of list) { const k = off(o.periodStartTs); if (k >= kMin && k <= kMax) present.add(k); }
    const missing = expected - present.size; const missingStarts = []; if (missing > 0) for (let k = kMin; k <= kMax && missingStarts.length < MAX_MISSING_LISTED; k += 1) if (!present.has(k)) missingStarts.push(anchor + k * periodMs);
    return { state: missing === 0 && expected > 0 ? 'COMPLETE' : 'PARTIAL', reasons: missing === 0 && expected > 0 ? [] : ['MISSING_PERIODS'], periodMs, expectedPeriods: expected, presentPeriods: present.size, missingPeriods: missing, missingStarts };
  }
  function coverageSpan(records, kinds, subjectIds, family, startTs, endTs) {
    // positive OBSERVED coverage records of the metric's input kinds for the subject, merged; complete only when their union spans the interval
    const spans = records.filter((c) => c.state === 'OBSERVED' && c.family === family && (c.kind === null || kinds.includes(c.kind)) && subjectIds.has(c.subjectId)).map((c) => [c.startTs, c.endTs ?? endTs]).sort((a, b) => a[0] - b[0]);
    if (!spans.length) return { state: 'PARTIAL', reasons: ['COVERAGE_BASIS_MISSING'], coverageRecords: 0, gaps: [] };
    let cursor = startTs; const gaps = []; for (const [s, e] of spans) { if (e < cursor) continue; if (s > cursor) gaps.push([cursor, s]); cursor = Math.max(cursor, e); if (cursor >= endTs) break; } if (cursor < endTs) gaps.push([cursor, endTs]);
    return { state: gaps.length ? 'PARTIAL' : 'COMPLETE', reasons: gaps.length ? ['COVERAGE_GAP'] : [], coverageRecords: spans.length, gaps: gaps.slice(0, MAX_MISSING_LISTED) };
  }
  // support of ONE compatible native series (already selected: one version per period); different series never fill each
  // other's gaps or jointly satisfy a warmup they individually lack
  function seriesSupport(m, metricId, list, r) {
    const isIndicator = m.component === 'indicators' && m.inputKinds.includes('CANDLE');
    let out = { state: 'COMPLETE', basis: 'SNAPSHOT', reasons: [] };
    if (r.requestKind === 'HISTORY') {
      // a native constituent set (inflow + outflow) must EACH cover the whole grid
      const groups = new Map(); for (const o of list) { const n = m.native && m.nativeOf ? m.nativeOf(o) : o.kind; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(o); }
      const grids = [...groups.entries()].map(([n, g]) => [n, periodGrid(g, r.windowStartTs, r.windowEndTs)]); const worst = grids.find(([, g]) => g.state !== 'COMPLETE');
      out = { state: worst ? 'PARTIAL' : 'COMPLETE', basis: 'PERIOD_GRID', reasons: worst ? worst[1].reasons : [], ...(worst ? worst[1] : grids[0][1]), nativeInput: worst ? worst[0] : grids[0][0] };
    } else if (list.some((o) => o.kind === 'CANDLE')) {
      // a bar set answering a snapshot request must be one contiguous same-interval series (a cache hit cannot hide a gap)
      const sorted = [...list].sort((a, b) => a.periodStartTs - b.periodStartTs); const g = periodGrid(sorted, sorted[0].periodStartTs, sorted[sorted.length - 1].periodEndTs);
      out = { state: g.state, basis: 'PERIOD_GRID', reasons: g.reasons, ...g };
    }
    if (isIndicator && out.state === 'COMPLETE') {
      const ind = indicators(list); const ready = INDICATOR_WARMUP[metricId] ? INDICATOR_WARMUP[metricId](ind) : ind.closedBars > 0;
      out = { ...out, basis: 'INDICATOR_WARMUP', state: ready ? 'COMPLETE' : 'PARTIAL', reasons: ready ? [] : ['WARMUP_INCOMPLETE'], closedBars: ind.closedBars, intervalMs: ind.intervalMs };
    }
    return out;
  }
  function metricSupport(m, metricId, selected, r, coverage) {
    const periodic = selected.filter((o) => o.periodStartTs !== null && o.periodEndTs !== null);
    if (periodic.length && periodic.length !== selected.length) return { state: 'PARTIAL', basis: 'MIXED', reasons: ['MIXED_OBSERVATION_SHAPES'] };
    if (!periodic.length) {
      if (r.requestKind !== 'HISTORY') return { state: 'COMPLETE', basis: 'SNAPSHOT', reasons: [] };
      const ids = new Set(selected.map((o) => subjectId(o.subject)));
      return { basis: 'COVERAGE_RECORDS', ...coverageSpan(coverage, m.inputKinds, ids, r.family, r.windowStartTs, r.windowEndTs) };
    }
    // correction B: support is judged PER compatible series (provider / subject / kind / interval / unit / methodology); a derived
    // metric's constituents share one provider series family, so constituent grouping happens inside the chosen series set
    // a derived metric's constituents (inflow + outflow) live in sibling series of one provider / entity set / chain / unit / window:
    // the metric id and its per-metric methodology are masked so the constituents are judged together, never across providers
    const constituentKey = (o) => seriesKeyOf({ ...o, payload: { ...(o.payload ?? {}), metricId: '*', methodologyId: '*' } });
    const bySeries = new Map(); for (const o of periodic) { const k = m.native && m.nativeOf ? constituentKey(o) : seriesKeyOf(o); if (!bySeries.has(k)) bySeries.set(k, []); bySeries.get(k).push(o); }
    const judged = [...bySeries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, list]) => ({ key, periods: list.length, support: seriesSupport(m, metricId, list, r) }));
    const complete = judged.filter((j) => j.support.state === 'COMPLETE'); const pick = complete[0] ?? judged.slice().sort((a, b) => b.periods - a.periods || (a.key < b.key ? -1 : 1))[0];
    return { ...pick.support, seriesCount: judged.length, seriesJudged: judged.map((j) => ({ periods: j.periods, state: j.support.state })), reasons: pick.support.state === 'COMPLETE' ? [] : judged.length > 1 && !complete.length ? [...new Set([...pick.support.reasons, 'NO_SINGLE_SERIES_COMPLETE'])] : pick.support.reasons };
  }
  const idsOf = (list) => { const ids = list.map((o) => o.observationId).sort(); return { ids: ids.slice(0, MAX_ID_LIST), truncated: ids.length > MAX_ID_LIST, digest: canonicalDigest(ids), count: ids.length }; };
  const shape = (ev, extra = {}) => { const idl = idsOf(ev.admitted); return { observationIds: idl.ids, inputIds: idl.ids, idsTruncated: idl.truncated, admittedDigest: idl.digest, sourceIds: [...new Set(ev.admitted.map((o) => o.provider))].sort(), observationsAdmitted: idl.count, metrics: ev.perMetric, coverage: ev.admitted.length ? { startTs: Math.min(...ev.admitted.map((o) => o.sourceEventTs ?? o.periodStartTs ?? o.knownAtTs)), endTs: Math.max(...ev.admitted.map((o) => o.sourceEventTs ?? o.periodEndTs ?? o.knownAtTs)), knownAtMax: Math.max(...ev.admitted.map((o) => o.knownAtTs)), count: idl.count } : null, ...extra }; };
  const stateOf = (ev, degraded) => (ev.allSatisfied && !degraded ? 'SATISFIED' : ev.anySatisfied || ev.admitted.length ? 'PARTIAL' : null);
  async function resolve(r, { analysisId, caseSubject, asOfTs, deadlineTs, alreadyRequested = new Set(), signal = null, round = null }) {
    const bad = requestError(r); if (bad) { if (bad === 'UNSUPPORTED_METRIC') return result(r, analysisId, 'POLICY_REJECTED', 'UNSUPPORTED_METRIC'); return result({ ...r, metricIds: Array.isArray(r?.metricIds) ? r.metricIds : [], requestKey: String(r?.requestKey ?? '?').slice(0, 16) }, analysisId, 'POLICY_REJECTED', 'REQUEST_MALFORMED', { detail: bad }); }
    const requestId = requestIdentity(analysisId, r);
    if (alreadyRequested.has(requestId)) return result(r, analysisId, 'ALREADY_REQUESTED', 'DUPLICATE_REQUEST');
    if (clock() > deadlineTs) return result(r, analysisId, 'DEADLINE_EXCEEDED', 'DEADLINE');
    const coin = subjectCoinOf(r.subjectRef, caseSubject); if (coin === null) return result(r, analysisId, 'POLICY_REJECTED', 'SUBJECT_NOT_REGISTERED');
    if (r.requestedMaxAgeMs !== null && !(ALLOWED_MAX_AGE_MS[r.family] ?? []).includes(r.requestedMaxAgeMs)) return result(r, analysisId, 'POLICY_REJECTED', 'NONE', { detail: 'requestedMaxAgeMs outside policy' });
    const key = semanticKey(r, coin); const now = clock(); const pd = canonicalDigest(policy);
    // a semantic repeat inside the same round (different arbitrary key, same question) never causes duplicate paid work
    const roundKey = `${round ?? analysisId}|${key}`; if (roundKeys.has(roundKey)) { const prior = roundKeys.get(roundKey); return result(r, analysisId, prior.state, 'SEMANTIC_DUPLICATE', { ...prior.extra, cacheStatus: 'ROUND_DUPLICATE', usage: emptyUsage(), duplicateOf: prior.requestKey }); }
    const remember = (res) => { roundKeys.set(roundKey, { state: res.state, requestKey: r.requestKey, extra: { observationIds: res.observationIds, inputIds: res.inputIds, idsTruncated: res.idsTruncated, admittedDigest: res.admittedDigest ?? null, sourceIds: res.sourceIds, observationsAdmitted: res.observationsAdmitted, metrics: res.metrics, coverage: res.coverage } }); if (roundKeys.size > 64) roundKeys.delete(roundKeys.keys().next().value); return res; };
    // 1. cached EVIDENCE (not an old result envelope): rebound to THIS request, freshness rechecked on the source clocks, zero new usage;
    //    a cache entry recorded at a later as-of never contaminates an earlier replay
    const cached = cache.get(key);
    if (cached && cached.mode === mode && cached.policyDigest === pd && cached.asOfTs <= asOfTs && (r.requestedMaxAgeMs === null ? now - cached.acquiredTs <= 60_000 : true)) {
      const ev = evaluate(cached.observations, r, coin, { asOfTs, coverage: cached.coverage ?? [] }); const st = stateOf(ev, false);
      if (st) return remember(result(r, analysisId, st, 'CACHE_HIT', shape(ev, { cacheStatus: 'FRESH_EXACT', cachedFrom: { acquiredTs: cached.acquiredTs, asOfTs: cached.asOfTs, requestId: cached.requestId, usage: cached.usage }, usage: emptyUsage() })));
    }
    // 2. DETAIL: the current lawful LOCAL evidence only (never paid fetching); HISTORY / REFRESH may also be answered locally when it satisfies
    const local = owner.observations(); const localCoverage = typeof owner.coverage === 'function' ? owner.coverage() : [];
    if (r.requestKind === 'DETAIL') { const ev = evaluate(local, r, coin, { asOfTs, coverage: localCoverage }); const st = stateOf(ev, false); const res = st ? result(r, analysisId, st, st === 'SATISFIED' ? 'NONE' : ev.reasons[0] ?? 'PARTIAL_COVERAGE', shape(ev, { cacheStatus: 'LOCAL_STORE' })) : result(r, analysisId, 'NOT_APPLICABLE', ev.reasons[0] ?? 'NO_OBSERVATIONS', shape(ev, { cacheStatus: 'LOCAL_STORE' })); return remember(res); }
    if (mode === 'REPLAY_AS_OF') { const ev = evaluate(local, r, coin, { asOfTs, coverage: localCoverage }); const st = stateOf(ev, r.requestKind !== 'HISTORY'); if (st) return remember(result(r, analysisId, st, st === 'SATISFIED' ? 'NONE' : 'REPLAY_NETWORK_OFF', shape(ev, { cacheStatus: 'LOCAL_STORE' }))); return remember(result(r, analysisId, 'NOT_APPLICABLE', 'REPLAY_NETWORK_OFF')); }
    // 3. enabled native source, then configured alternative (the owner's acquire crosses the R01 guard per request)
    const providers = providersForFamily(r.family); const enabled = providers.filter((p) => providerEnabled(policy, p));
    if (!enabled.length) return remember(result(r, analysisId, 'POLICY_REJECTED', 'FAMILY_NOT_ENABLED'));
    const authorized = enabled.filter((p) => policy.providers[p].plan.billing === 'FREE' || paidCallAuthorized(policy, p) || policy.providers[p].plan.meteredAuthorization?.authorized === true);
    if (!authorized.length) return remember(result(r, analysisId, 'BUDGET_BLOCKED', 'PAID_NOT_AUTHORIZED', { providers: enabled }));
    const startTs = clock(); let acq;
    // closeout R01/Q04: a broker acquisition goes through the SAME owner guard, labelled with its BROKER purpose in the accounting journal
    const acquire = () => owner.acquire(r.family, coin, { signal, force: true, metricIds: r.metricIds, windowStartTs: r.windowStartTs, windowEndTs: r.windowEndTs });
    try { acq = owner.guard && typeof owner.guard.withPurpose === 'function' ? await owner.guard.withPurpose('BROKER', acquire) : await acquire(); } catch (err) { log(`broker acquire failed: ${String(err?.message ?? err).slice(0, 120)}`); return remember(result(r, analysisId, 'SOURCE_FAILED', 'PROVIDER_FAILED')); }
    const results = Array.isArray(acq.results) ? acq.results : []; const u = acq.usage ?? null;
    const usage = { calls: u ? u.dispatched : results.filter((x) => x.state === 'OK').length, credits: u ? u.credits : 0, dispatched: u ? u.dispatched : 0, refused: u ? u.refused : results.filter((x) => x.state === 'QUOTA_REFUSED').length, unresolved: u ? u.unresolved : 0, estimatedUsd: 0, reasons: u?.reasons ?? {} };
    if (clock() > deadlineTs) return remember(result(r, analysisId, 'DEADLINE_EXCEEDED', 'DEADLINE', { usage, acquisition: results }));
    const fresh = (acq.observations ?? []).filter((o) => o.receivedTs >= startTs); const freshCoverage = Array.isArray(acq.coverage) ? acq.coverage : []; /* the acquisition's own coverage records are the support basis for point observations */ const ev = evaluate(fresh, r, coin, { asOfTs: clock(), coverage: freshCoverage });
    const blocked = results.filter((x) => x.state === 'ACCESS_BLOCKED'); const failed = results.filter((x) => x.state === 'FAILED' || x.state === 'SOURCE_FAILED'); const refused = results.filter((x) => x.state === 'QUOTA_REFUSED'); const okResults = results.filter((x) => x.state === 'OK' || x.state === 'CACHED');
    const common = shape(ev, { usage, acquisition: results });
    let res;
    const st = stateOf(ev, failed.length || blocked.length || refused.length);
    if (st) res = result(r, analysisId, st, st === 'SATISFIED' ? 'NONE' : refused.length ? 'QUOTA_REFUSED' : failed.length || blocked.length ? 'PARTIAL_COVERAGE' : ev.reasons[0] ?? 'PARTIAL_COVERAGE', common);
    else if (!okResults.length && refused.length) res = result(r, analysisId, 'BUDGET_BLOCKED', 'QUOTA_REFUSED', common);
    else if (!okResults.length && blocked.length) res = result(r, analysisId, 'ACCESS_BLOCKED', 'PROVIDER_ACCESS_DENIED', common);
    else if (!okResults.length && failed.length) res = result(r, analysisId, 'SOURCE_FAILED', 'PROVIDER_FAILED', common);
    else if (!okResults.length && results.length && results.every((x) => x.state === 'PROVIDER_DISABLED' || x.state === 'POLICY_REJECTED')) res = result(r, analysisId, 'POLICY_REJECTED', 'FAMILY_NOT_ENABLED', common);
    else res = result(r, analysisId, 'NOT_APPLICABLE', results.length ? (r.requestKind === 'HISTORY' ? 'HISTORY_UNAVAILABLE' : ev.reasons[0] ?? 'NO_OBSERVATIONS') : 'NO_MAPPING_FOR_SUBJECT', common);
    if (fresh.length) put(key, { asOfTs: clock(), mode, policyDigest: pd, observations: fresh, coverage: freshCoverage, acquisition: results, usage, acquiredTs: clock(), requestId });
    return remember(res);
  }
  const roundKeys = new Map();
  return { resolve, cacheSize: () => cache.size, metricRegistry: METRIC_REGISTRY, allowedMaxAgeMs: ALLOWED_MAX_AGE_MS, states: BROKER_STATES };
}
