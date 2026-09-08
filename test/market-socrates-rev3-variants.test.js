// MARKET / SOCRATES — the four remaining boundaries (baseline 6596db5): linked variants of the IR- acceptance cases.
// A readiness scope reconciliation, B native-period selection, C journal close failure, D component family binding.
// Offline only: scripted fetch, injected clocks, temp journals, a child process for the descriptor faults.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { T0, tmp, json, btcOnly, cryptoquantPolicy, cryptoquantFetch, H, SEALED_REF } from './helpers/market-closeout.js';
import { loadPolicy, ALLOWED_MAX_AGE_MS } from '../market-lab/policy.js';
import { PROVIDER_IDS, FAMILIES, familyMetricIds, makeObservation, observationError, canonicalDigest, sha256Hex } from '../market-lab/contracts.js';
import { ENDPOINTS, providersForFamily } from '../market-lab/registry.js';
import { providerReadiness, liveReadinessManifest, qualifyFamilyEvidence, qualifyModelDemonstration } from '../market-lab/readiness.js';
import { selectNativeSeries, seriesKeyOf, NATIVE_SERIES_LAW } from '../market-lab/native-series.js';
import { indicators, RECIPES, etfFlowSummary } from '../market-lab/recipes.js';
import { createResearchOwner } from '../market-lab/owner.js';
import { createBroker } from '../socrates/broker.js';
import { buildContext, contextError, contextIdentity, COMPONENT_KEYS, COMPONENT_FAMILY, GENERIC_RECIPE_METRIC_FAMILY, componentBindingError, METRIC_RECIPE } from '../market-lab/context.js';
import { METRIC_SCHEMAS } from '../market-lab/context-schema.js';
import { runBuild, readContext, contextBundleError } from '../market-lab/commands.js';
import { manifestIdentity } from '../market-lab/store.js';
import { codeIdentity } from '../market-lab/identity.js';
import { buildResearchEvidenceV2 } from '../evidence/research-builder.js';
import { openBudgetJournal } from '../socrates/budget.js';
import { openQuotaJournal } from '../market-lab/quota.js';

const DAY = 86_400_000; const HOUR = 3_600_000;
// ================================================================= A: readiness scope ======================================
const rows = providerReadiness({ policy: loadPolicy(H.policyWith({ providers: [...PROVIDER_IDS] })), env: Object.fromEntries(PROVIDER_IDS.map((id) => [`${id}_API_KEY`, 'x'])), testReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, 'PASSED'])), liveReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { state: 'PASSED', ts: T0, endpointId: 'x', asset: 'BTC', evidence: 's' }])) });
const qualified = (fam, over = {}) => { const providerId = providersForFamily(fam)[0]; const endpoint = ENDPOINTS.find((e) => e.providerId === providerId && e.families.includes(fam)); const metrics = familyMetricIds(fam); return { providerId, endpointId: endpoint.endpointId, requested: 2, obtained: 2, assets: { requested: ['BTC', 'ETH'], obtained: ['BTC', 'ETH'] }, metrics: { requested: metrics, obtained: metrics }, interval: { startTs: T0 - HOUR, endTs: T0 - 500 }, knownAtTs: T0 - 500, requestedMaxAgeMs: ALLOWED_MAX_AGE_MS[fam].at(-1), support: { state: 'COMPLETE', basis: 'SNAPSHOT' }, complete: true, nativeLatencyMs: 10, smokeTs: null, ...over }; };
const model = (over = {}) => ({ liveVerification: 'PASSED', demonstration: { ts: T0 - 1000, model: 'm', requestId: 'r', usage: { inputTokens: 10, outputTokens: 5 }, ...over } });
const manifest = (coverage, m = model(), generatedTs = T0) => liveReadinessManifest({ rows, familyCoverage: coverage, modelReadiness: m, generatedTs });
const full = () => Object.fromEntries(FAMILIES.map((f) => [f, qualified(f)]));

test('A-V01. requested / obtained scope is a SET fact: reordering is complete; a genuine partial (complete:false, PARTIAL support) is PARTIAL_LIVE with its shortfall named; a complete claim over a shortfall is contradicted; a count shortfall alone is refused', () => {
  const q = (ev) => qualifyFamilyEvidence('NETWORK_ACTIVITY', ev, rows, { generatedTs: T0 });
  const metrics = familyMetricIds('NETWORK_ACTIVITY');
  assert.deepEqual(q(qualified('NETWORK_ACTIVITY', { assets: { requested: ['ETH', 'BTC'], obtained: ['BTC', 'ETH'] }, metrics: { requested: metrics, obtained: [...metrics].reverse() } })), { qualified: true, complete: true, missing: [], shortfall: [] }, 'order never matters; membership does');
  const partial = q(qualified('NETWORK_ACTIVITY', { assets: { requested: ['BTC', 'ETH'], obtained: ['BTC'] }, obtained: 1, complete: false, support: { state: 'PARTIAL', basis: 'SNAPSHOT' } }));
  assert.deepEqual(partial, { qualified: true, complete: false, missing: [], shortfall: ['ASSET_SCOPE_SHORTFALL', 'COUNT_SHORTFALL'] }, 'useful genuinely partial evidence stays qualified and named');
  const contradicted = q(qualified('NETWORK_ACTIVITY', { assets: { requested: ['BTC', 'ETH'], obtained: ['BTC'] }, obtained: 1 }));
  assert.equal(contradicted.qualified, false); assert.deepEqual(contradicted.missing, ['COMPLETION_CLAIM_CONTRADICTED', 'ASSET_SCOPE_SHORTFALL', 'COUNT_SHORTFALL']);
  const metricShort = q(qualified('NETWORK_ACTIVITY', { metrics: { requested: metrics, obtained: metrics.slice(0, 1) } })); assert.deepEqual(metricShort.missing, ['COMPLETION_CLAIM_CONTRADICTED', 'METRIC_SCOPE_SHORTFALL']);
  const countOnly = q(qualified('NETWORK_ACTIVITY', { requested: 3 })); assert.deepEqual(countOnly.missing, ['COMPLETION_CLAIM_CONTRADICTED', 'COUNT_SHORTFALL'], 'counts are reconciled in their own meaning, never inferred from array lengths');
  const supportSaysComplete = q(qualified('NETWORK_ACTIVITY', { assets: { requested: ['BTC', 'ETH'], obtained: ['BTC'] }, obtained: 1, complete: false })); assert.ok(supportSaysComplete.missing.includes('COMPLETION_CLAIM_CONTRADICTED'), 'a COMPLETE support state over a shortfall is the same contradiction');
  for (const junk of [{ ...qualified('NETWORK_ACTIVITY'), assets: 'BTC' }, { ...qualified('NETWORK_ACTIVITY'), requested: '2' }]) { const r = q(junk); assert.equal(r.qualified, false); assert.ok(r.missing.length); }
});

test('A-V02. the manifest keeps a scope shortfall non-green on the family row and overall; a genuine partial family is PARTIAL_LIVE; the full-scope control stays green with alternatives disabled', () => {
  const green = manifest(full()); assert.equal(green.overall, 'READINESS_GREEN'); assert.ok(FAMILIES.every((f) => green.families[f].scopeShortfall.length === 0));
  const contradicted = manifest({ ...full(), NETWORK_ACTIVITY: qualified('NETWORK_ACTIVITY', { assets: { requested: ['BTC', 'ETH'], obtained: ['BTC'] }, obtained: 1 }) });
  assert.equal(contradicted.overall, 'NOT_VERIFIED'); assert.equal(contradicted.families.NETWORK_ACTIVITY.state, 'NOT_VERIFIED'); assert.deepEqual(contradicted.families.NETWORK_ACTIVITY.scopeShortfall, ['ASSET_SCOPE_SHORTFALL', 'COUNT_SHORTFALL']); assert.ok(contradicted.families.NETWORK_ACTIVITY.missingProof.includes('COMPLETION_CLAIM_CONTRADICTED')); assert.ok(contradicted.blockers.some((b) => /NETWORK_ACTIVITY/.test(b)));
  const partial = manifest({ ...full(), NETWORK_ACTIVITY: qualified('NETWORK_ACTIVITY', { assets: { requested: ['BTC', 'ETH'], obtained: ['BTC'] }, obtained: 1, complete: false, support: { state: 'PARTIAL', basis: 'SNAPSHOT' } }) });
  assert.equal(partial.families.NETWORK_ACTIVITY.state, 'PARTIAL_LIVE'); assert.equal(partial.families.NETWORK_ACTIVITY.qualified, true); assert.notEqual(partial.overall, 'READINESS_GREEN');
  // the selected required source with the alternatives disabled: the declared scope is the contract, not every provider in the registry
  const fewRows = providerReadiness({ policy: loadPolicy(H.policyWith({ providers: ['CRYPTOQUANT'] })), env: { CRYPTOQUANT_API_KEY: 'x' }, testReport: Object.fromEntries(PROVIDER_IDS.map((id) => [id, 'PASSED'])), liveReport: { CRYPTOQUANT: { state: 'PASSED', ts: T0, endpointId: 'network-data', asset: 'BTC', evidence: 's' } } });
  const one = qualifyFamilyEvidence('NETWORK_ACTIVITY', qualified('NETWORK_ACTIVITY', { providerId: 'CRYPTOQUANT', endpointId: 'network-data' }), fewRows, { generatedTs: T0 }); assert.deepEqual(one, { qualified: true, complete: true, missing: [], shortfall: [] });
});

test('A-V03. the model demonstration must have occurred by the manifest clock: generatedTs - 1 and equality qualify, +1 does not; no new expiry is invented (an old demonstration under PASSED still qualifies)', () => {
  const q = (ts, generatedTs = T0) => qualifyModelDemonstration(model({ ts }), { generatedTs });
  assert.equal(q(T0 - 1).qualified, true); assert.equal(q(T0).qualified, true); assert.deepEqual(q(T0 + 1).missing, ['MODEL_DEMONSTRATION_NOT_YET_OCCURRED']); assert.equal(q(T0 - 400 * DAY).qualified, true, 'freshness of the demonstration is not a new policy');
  assert.deepEqual(qualifyModelDemonstration(model({ ts: T0 }), { generatedTs: 'now' }).missing, ['GENERATED_CLOCK_MALFORMED']);
  const future = manifest(full(), model({ ts: T0 + DAY })); assert.equal(future.overall, 'BLOCKED'); assert.ok(future.blockers.some((b) => /MODEL_DEMONSTRATION_NOT_YET_OCCURRED/.test(b))); assert.deepEqual(future.modelQualification.missing, ['MODEL_DEMONSTRATION_NOT_YET_OCCURRED']);
  assert.equal(manifest(full(), model({ ts: T0 })).overall, 'READINESS_GREEN', 'equality with the manifest clock is available');
});

// ================================================================= B: native period selection =============================
async function hourlyBars(count, { endTs = T0, closePrice = 100 } = {}) {
  const kp = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })); const dir = tmp('rev3-bars-');
  const own = createResearchOwner({ policy: kp, subjects: btcOnly(), clock: () => T0, researchRoot: dir, fetchImpl: async (url) => json(new URL(url).pathname.endsWith('AssetPairs') ? H.KRAKEN_ASSET_PAIRS : H.krakenOhlc('XXBTZUSD', { intervalMin: 60, endTs, count, closePrice })) });
  try { await own.clients.KRAKEN_SPOT.loadCatalog(); const market = own.clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: 'BTC' }).market; const r = await own.clients.KRAKEN_SPOT.ohlc({ market, intervalMin: 60 }); assert.equal(r.ok, true); return { bars: r.observations.filter((o) => o.kind === 'CANDLE' && o.payload.closed), market, policy: kp }; } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
}
const reenvelope = (o, over = {}) => { const { observationId, ...rest } = o; return makeObservation({ ...rest, ...over, payload: { ...rest.payload, ...(over.payload ?? {}) } }); };
const detail = (policy, obs, metricIds = ['sma', 'atr14', 'bollinger20'], asOfTs = T0) => createBroker({ owner: { observations: () => obs, coverage: () => [], acquire: async () => ({ results: [], observations: [] }) }, policy, clock: () => asOfTs, mode: 'REPLAY_AS_OF' }).resolve({ requestKey: 'Q1', requestKind: 'DETAIL', family: 'SPOT_PRICE_CHART', metricIds, subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: [], question: 'q', interpretationIfSupported: 'x', interpretationIfContradicted: 'y' }, { analysisId: 'soc2-' + 'a'.repeat(40), caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs, deadlineTs: asOfTs + 60_000 });

test('B-V01. the selector: repeated receipts / new request ids / reordered input select one deterministic version per period; a changed value with a later knowledge clock is a revision (the later wins), a change at the same clock is a disclosed conflict; nothing known after the as-of takes part', async () => {
  const { bars } = await hourlyBars(4); const [a, b, c] = bars; // the fixture's last row is provisional: N rows give N - 1 closed bars
  const repeats = [a, reenvelope(a, { sequence: a.sequence + 5, receivedTs: a.receivedTs + 1000, knownAtTs: a.knownAtTs + 1000 }), reenvelope(a, { sequence: a.sequence + 9, receivedTs: a.receivedTs + 2000, knownAtTs: a.knownAtTs + 2000 })];
  assert.equal(new Set(repeats.map((o) => o.observationId)).size, 3); assert.ok(repeats.every((o) => observationError(o) === null));
  const sel = selectNativeSeries([...repeats, b, c]); assert.equal(sel.selectedPeriods, 3); assert.equal(sel.envelopes, 5); assert.equal(sel.repeats, 2); assert.equal(sel.revisions, 0); assert.equal(sel.conflicts, 0); assert.equal(sel.seriesCount, 1); assert.equal(sel.law, NATIVE_SERIES_LAW);
  const winner = sel.selected.find((o) => o.periodStartTs === a.periodStartTs); assert.equal(winner.knownAtTs, a.knownAtTs + 2000, 'the version known last is the current one');
  const shuffled = selectNativeSeries([c, repeats[2], b, repeats[0], repeats[1]]); assert.deepEqual(shuffled.selected.map((o) => o.observationId).sort(), sel.selected.map((o) => o.observationId).sort(), 'input order never changes the selection');
  const revised = reenvelope(a, { sequence: a.sequence + 20, receivedTs: a.receivedTs + 5000, knownAtTs: a.knownAtTs + 5000, payload: { close: a.payload.close + 1, high: Math.max(a.payload.high, a.payload.close + 1) } });
  const rev = selectNativeSeries([...repeats, revised, b, c]); assert.equal(rev.revisions, 1); assert.equal(rev.conflicts, 0); assert.equal(rev.selected.find((o) => o.periodStartTs === a.periodStartTs).payload.close, a.payload.close + 1);
  const conflicting = reenvelope(a, { sequence: a.sequence + 1, payload: { close: a.payload.close + 7, high: Math.max(a.payload.high, a.payload.close + 7) } }); // same knownAtTs as `a`, different value
  const con = selectNativeSeries([a, conflicting, b, c]); assert.equal(con.conflicts, 1); assert.equal(con.revisions, 0); assert.equal(con.series[seriesKeyOf(a)].conflicts, 1, 'disclosed per series, never averaged');
  const earlier = selectNativeSeries([...repeats, revised, b, c], { asOfTs: a.knownAtTs + 2000 }); assert.equal(earlier.lateExcluded, 1); assert.equal(earlier.selected.find((o) => o.periodStartTs === a.periodStartTs).payload.close, a.payload.close, 'an earlier as-of keeps its own selected value');
  assert.equal(selectNativeSeries([...repeats, revised], { asOfTs: a.knownAtTs - 1 }).selectedPeriods, 0, 'nothing known after the as-of influences selection');
});

test('B-V02. different providers / quotes / intervals are different series that never merge, fill gaps or jointly warm up; the same period across two series stays two selected samples', async () => {
  const { bars, policy } = await hourlyBars(63); const half = bars.slice(0, 31); const otherHalf = bars.slice(31);
  const coinbase = otherHalf.map((o) => reenvelope(o, { provider: 'COINBASE_SPOT', endpointId: 'rest-candles', subject: { ...o.subject, venue: 'coinbase', nativeSymbol: 'BTC-USD' }, provenance: { ...o.provenance, mappingId: 'coinbase-market-v1' } }));
  const mixed = selectNativeSeries([...half, ...coinbase]); assert.equal(mixed.seriesCount, 2); assert.equal(mixed.selectedPeriods, 62);
  const r = await detail(policy, [...half, ...coinbase], ['sma']); assert.equal(r.state, 'PARTIAL', 'two venues with 31 bars each do not jointly warm a 60-bar SMA'); assert.equal(r.metrics.sma.support.seriesCount, 2); assert.ok(r.metrics.sma.support.reasons.includes('NO_SINGLE_SERIES_COMPLETE'));
  const eur = half.map((o) => reenvelope(o, { subject: { ...o.subject, quote: 'EUR', nativeSymbol: 'BTC/EUR' } })); const quotes = selectNativeSeries([...half, ...eur]); assert.equal(quotes.seriesCount, 2); assert.equal(quotes.selectedPeriods, 62, 'the same period in two quotes is two samples of two series');
  const fourHour = half.map((o) => reenvelope(o, { periodEndTs: o.periodStartTs + 4 * HOUR, payload: { intervalMs: 4 * HOUR } })); assert.equal(selectNativeSeries([...half, ...fourHour]).seriesCount, 2);
  const daily = await (async () => { const dir = tmp('rev3-daily-'); const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir, fetchImpl: cryptoquantFetch() }); try { return (await own.acquire('NETWORK_ACTIVITY', 'BTC', { metricIds: ['active_addresses'] })).observations.filter((o) => o.payload.metricId === 'active_addresses'); } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); } })();
  const otherUnit = daily.map((o) => reenvelope(o, { payload: { unit: 'USD' } })); assert.equal(selectNativeSeries([...daily, ...otherUnit]).seriesCount, 2, 'a unit is a series discriminator');
});

test('B-V03. the broker: one native period under 62 envelopes is PARTIAL with one selected period and the repeats disclosed; a real gap stays a gap; the complete 62-bar series is SATISFIED; acquired results, the evidence cache and replay obey the same law', async () => {
  const { bars, policy } = await hourlyBars(63); const latest = bars.at(-1);
  const repeats = Array.from({ length: 62 }, (_, i) => reenvelope(latest, { sequence: latest.sequence + i + 1 }));
  const r = await detail(policy, repeats); assert.equal(r.state, 'PARTIAL'); for (const m of ['sma', 'atr14', 'bollinger20']) { assert.equal(r.metrics[m].state, 'PARTIAL'); assert.equal(r.metrics[m].matched, 1); assert.equal(r.metrics[m].envelopes, 62); assert.deepEqual(r.metrics[m].selection, { law: NATIVE_SERIES_LAW, envelopes: 62, selectedPeriods: 1, series: 1, repeats: 61, revisions: 0, conflicts: 0 }); assert.equal(r.metrics[m].support.closedBars, 1); assert.deepEqual(r.metrics[m].support.reasons, ['WARMUP_INCOMPLETE']); }
  assert.equal(r.observationsAdmitted, 1, 'admitted inputs are the selected period, not the envelopes');
  const gapped = bars.filter((o, i) => i !== 30); const g = await detail(policy, [...gapped, reenvelope(gapped[5], { sequence: 9999 })], ['sma']); assert.equal(g.state, 'PARTIAL'); assert.deepEqual(g.metrics.sma.support.reasons, ['MISSING_PERIODS']); assert.equal(g.metrics.sma.support.missingPeriods, 1);
  const ok = await detail(policy, [...bars, ...repeats], ['sma', 'atr14', 'bollinger20']); assert.equal(ok.state, 'SATISFIED'); assert.equal(ok.observationsAdmitted, 62); assert.equal(ok.metrics.sma.selection.repeats, 62);
  // acquisition path + evidence cache + replay: the same selection law
  const broker = createBroker({ owner: { observations: () => [], coverage: () => [], acquire: async () => ({ results: [{ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', state: 'OK' }], observations: repeats, coverage: [], usage: { dispatched: 1, credits: 1, refused: 0, unresolved: 0, reasons: {} } }) }, policy, clock: () => T0 });
  const req = (key, kind = 'REFRESH') => ({ requestKey: key, requestKind: kind, family: 'SPOT_PRICE_CHART', metricIds: ['sma'], subjectRef: 'BTC', windowStartTs: null, windowEndTs: null, requestedMaxAgeMs: null, hypothesisRefs: [], question: 'q', interpretationIfSupported: 'x', interpretationIfContradicted: 'y' }); const opts = (id) => ({ analysisId: 'soc2-' + id.repeat(40), caseSubject: { canonicalCoin: 'BTC', registeredRefs: [] }, asOfTs: T0, deadlineTs: T0 + 60_000 });
  const live = await broker.resolve(req('L1'), opts('a')); assert.equal(live.state, 'PARTIAL'); assert.equal(live.metrics.sma.selection.selectedPeriods, 1);
  const cached = await broker.resolve(req('L2'), opts('b')); assert.equal(cached.reason, 'CACHE_HIT'); assert.equal(cached.state, 'PARTIAL'); assert.equal(cached.metrics.sma.selection.repeats, 61);
});

test('B-V04. generated context: repeated input yields one selected closed bar with truthful references, digest, count and known-at maximum; a lawful saved context round-trips; the recipe and the ETF summary count selected periods; counters are disclosure, never scores', async () => {
  const { bars } = await hourlyBars(63); const latest = bars.at(-1);
  const repeats = Array.from({ length: 62 }, (_, i) => reenvelope(latest, { sequence: latest.sequence + i + 1 })); // repeated polling: new envelopes of one native period, all known at the as-of
  const built = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: repeats, captureRef: SEALED_REF }); const ind = built.context.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'indicators');
  assert.equal(contextError(built.context, { inputReferences: built.inputReferences }), null);
  assert.equal(ind.value.closedBars, 1); assert.equal(ind.value.sma['60'], null); assert.equal(ind.value.atr14, null); assert.equal(ind.value.bollinger20, null); assert.equal(ind.value.completeness.bars, 1);
  assert.deepEqual(ind.value.completeness.selection, { law: NATIVE_SERIES_LAW, envelopes: 62, selectedPeriods: 1, series: 1, repeats: 61, revisions: 0, conflicts: 0 });
  const winner = repeats.at(-1); /* same knowledge clock: the highest ingestion sequence is the deterministic representative */ assert.deepEqual(ind.inputObservationIds, [winner.observationId], 'the component references the selected version only'); assert.equal(ind.inputObservationCount, 1); assert.equal(ind.inputDigest, canonicalDigest([winner.observationId])); assert.equal(ind.inputKnownAtMax, winner.knownAtTs);
  assert.deepEqual(Object.keys(built.inputReferences), [winner.observationId], 'input references describe the selected inputs');
  const fullBuilt = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: [...bars, ...repeats], captureRef: SEALED_REF }); const fullInd = fullBuilt.context.families.SPOT_PRICE_CHART.components.find((c) => c.metricId === 'indicators');
  assert.equal(fullInd.value.closedBars, 62); assert.ok(fullInd.value.sma['60'] !== null); assert.equal(fullInd.inputObservationCount, 62); assert.equal(fullInd.value.completeness.selection.repeats, 62);
  const twice = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: [...repeats, ...bars], captureRef: SEALED_REF }); assert.equal(twice.context.contextId, fullBuilt.context.contextId, 'input order never changes the context identity');
  assert.equal(indicators(repeats).closedBars, 1); assert.equal(indicators([...bars, ...repeats]).closedBars, 62);
  assert.ok(!('score' in ind.value.completeness.selection) && !('rank' in ind.value.completeness.selection));
  // ETF: repeated receipts of one reporting day never inflate trailing sums
  const flow = (i, extra = {}) => makeObservation({ schemaVersion: bars[0].schemaVersion, provider: 'COINGLASS', endpointId: 'etf-bitcoin-flow-history', subject: { subjectKind: 'ASSET', canonicalCoin: 'BTC', providerAssetId: 'BTC' }, kind: 'ETF_FLOW', sourceKey: `etf:${i}`, sourceRevision: null, sourceEventTs: null, periodStartTs: T0 - (i + 1) * DAY, periodEndTs: T0 - i * DAY, publishedTs: null, receivedTs: T0 - 1000, knownAtTs: T0 - 1000, sequence: 100 + i, epochId: null, quality: bars[0].quality, provenance: bars[0].provenance, payload: { fund: null, asset: 'BTC', flowUsd: 1_000_000, reportingPeriodStartTs: T0 - (i + 1) * DAY, reportingPeriodEndTs: T0 - i * DAY, estimate: false, revision: null, priceUsd: null }, ...extra });
  const flows = [flow(0), flow(1), flow(2)]; const dup = [...flows, makeObservation({ ...flow(0), sequence: 900 })]; assert.equal(etfFlowSummary(dup).days, 3); assert.equal(etfFlowSummary(dup).trailing5, 3_000_000);
});

test('B-V05. saved artifact round trip: a sealed context built from repeated input reopens, and its recorded selection facts match the pure validator; the compatibility decision is no version change (lawful distinct-bar artifacts are byte-identical)', async () => {
  const dir = tmp('rev3-ctx-'); const cap = path.join(dir, 'capture'); const ctxDir = path.join(dir, 'context'); const schedules = [];
  const timers = { setInterval: (fn, ms) => { const x = { fn, ms, unref() {} }; schedules.push(x); return x; }, clearInterval() {}, setTimeout, clearTimeout };
  const own = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), clock: () => T0, mode: 'INTEGRATED', researchRoot: dir, timers, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS) });
  try {
    await own.start({ outDir: cap, families: [] }); own.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: T0, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2]], asks: [[100.5, 2]] }) }); for (const s of schedules) if (s.ms === 250) s.fn(); await own.stop({ seal: true });
    runBuild({ captureDir: cap, asOfTs: T0, canonicalCoin: 'BTC', out: ctxDir }); const ctx = readContext(ctxDir).context; assert.equal(contextError(ctx), null);
    const ind = ctx.families.SPOT_PRICE_CHART.components.filter((c) => c.metricId === 'indicators'); assert.ok(ind.every((c) => c.value.completeness.selection.law === NATIVE_SERIES_LAW && c.value.completeness.selection.selectedPeriods === c.value.closedBars));
    assert.equal(RECIPES.indicators.version, 1, 'no recipe version change: a lawful distinct-bar artifact derives byte-identically; an inflated older artifact is exposed by recomputation, never reinterpreted');
  } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================= C: journal close failure ================================
const PROBE = `
import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; import path from 'node:path';
const [,, kind, stage, dir] = process.argv; const T0 = 1_788_912_000_000;
const mod = await import(kind === 'budget' ? '${fileURLToPath(new URL('../socrates/budget.js', import.meta.url))}' : '${fileURLToPath(new URL('../market-lab/quota.js', import.meta.url))}');
const open = () => (kind === 'budget' ? mod.openBudgetJournal : mod.openQuotaJournal)({ dir, clock: () => T0 });
const originalOpen = fs.openSync, originalClose = fs.closeSync, originalFsync = fs.fsyncSync, originalWrite = fs.writeSync; const fds = new Set(); let injected = 0; let targetFile = null;
fs.openSync = function (file, ...a) { const fd = originalOpen.call(this, file, ...a); if (targetFile && String(file) === targetFile) fds.add(fd); return fd; };
fs.closeSync = function (fd) { const t = fds.delete(fd); const r = originalClose.call(this, fd); if (t && (stage === 'close' || stage === 'settle-close') && injected === 0) { injected++; throw Object.assign(new Error('injected close'), { code: 'EIO' }); } return r; };
fs.fsyncSync = function (fd) { if (fds.has(fd) && stage === 'fsync' && injected === 0) { injected++; throw Object.assign(new Error('injected fsync'), { code: 'EIO' }); } return originalFsync.call(this, fd); };
fs.writeSync = function (fd, ...a) { if (fds.has(fd) && stage === 'write' && injected === 0) { injected++; throw Object.assign(new Error('injected write'), { code: 'EIO' }); } return originalWrite.call(this, fd, ...a); };
syncBuiltinESMExports();
const out = { kind, stage };
if (stage === 'lock-fsync') { targetFile = path.join(dir, kind === 'budget' ? 'budget.lock' : 'quota.lock'); fs.fsyncSync = function (fd) { if (fds.has(fd) && injected === 0) { injected++; throw Object.assign(new Error('injected lock fsync'), { code: 'EIO' }); } return originalFsync.call(this, fd); }; syncBuiltinESMExports(); try { open(); out.opened = true; } catch (e) { out.openError = e.code; } out.injected = injected; out.lockLeft = fs.existsSync(targetFile); fs.openSync = originalOpen; fs.closeSync = originalClose; fs.fsyncSync = originalFsync; fs.writeSync = originalWrite; syncBuiltinESMExports(); try { const j = open(); out.reopened = true; j.close(); } catch (e) { out.reopenError = e.code; } console.log(JSON.stringify(out)); process.exit(0); }
const j = open(); targetFile = j.files.journalFile;
const reserve = (id) => kind === 'budget' ? j.reserve({ reservationId: id, caseId: id, attemptId: id, estimatedUsd: 1, inputTokens: 1000000, maxOutputTokens: 0, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 }, caps: { maxEstimatedUsdPerCase: 10, maxEstimatedUsdPerDay: 10, maxEstimatedUsdPerMonth: 10, totalSmokeMaxEstimatedUsd: 1 } }) : j.reserve({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', unit: 'CALL', credits: 1, chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey: id, estimatedUsd: 0 });
if (stage === 'settle-close') { targetFile = null; const id = reserve('r0'); targetFile = j.files.journalFile; out.reservationId = kind === 'budget' ? 'r0' : id; }
try { const r = stage === 'settle-close' ? (kind === 'budget' ? j.settle({ reservationId: 'r0', usage: { inputTokens: 100000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 } }) : j.settle(out.reservationId, { ok: true, status: 200 })) : reserve('r1'); out.first = r === undefined ? 'undefined' : 'value'; } catch (e) { out.error = e.code; out.message = String(e.message).slice(0, 120); }
try { reserve('r2'); out.second = 'accepted'; } catch (e) { out.secondError = e.code; }
out.injected = injected; out.latched = j.failed(); out.states = j.reservations().map((x) => x.state); out.totals = kind === 'budget' ? j.totals().dayUsd : j.totals('KRAKEN_SPOT').calls.day;
fs.openSync = originalOpen; fs.closeSync = originalClose; fs.fsyncSync = originalFsync; fs.writeSync = originalWrite; syncBuiltinESMExports(); j.close();
const j2 = open(); out.reopenStates = j2.reservations().map((x) => x.state); out.reopenTotal = kind === 'budget' ? j2.totals().dayUsd : j2.totals('KRAKEN_SPOT').calls.day; out.reopenLatched = j2.failed(); j2.close();
console.log(JSON.stringify(out));
`;
function probe(kind, stage) {
  const dir = tmp('rev3-close-'); const script = path.join(dir, 'probe.mjs'); writeFileSync(script, PROBE);
  try { const child = spawnSync(process.execPath, [script, kind, stage, path.join(dir, 'journal')], { encoding: 'utf8', timeout: 30_000 }); assert.equal(child.status, 0, `probe child failed: ${child.stderr}`); return JSON.parse(child.stdout.trim().split('\n').at(-1)); } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const kind of ['budget', 'quota']) {
  test(`C-V01 (${kind}). write, fsync and the primary close each surface as IO_FAILURE on reserve; the first error is kept; the latch blocks the next allowance; a reopen reconciles conservatively and starts without the latch`, () => {
    for (const stage of ['write', 'fsync', 'close']) {
      const r = probe(kind, stage); assert.equal(r.injected, 1, `${stage}: the seam was reached`); assert.equal(r.error, 'IO_FAILURE', `${stage}: surfaced`); assert.equal(r.first, undefined); assert.equal(r.secondError, 'IO_FAILURE', `${stage}: latched before the next allowance`); assert.equal(r.second, undefined);
      assert.equal(r.latched?.code, 'IO_FAILURE'); assert.match(r.latched.message, /EIO/, `${stage}: the first (primary) error is the one kept`); assert.deepEqual(r.states, [], `${stage}: no committed live state for the uncertain row`);
      assert.equal(r.reopenLatched, null, `${stage}: a verified reopen starts clean`); assert.ok(r.reopenStates.every((s) => s === 'UNRESOLVED'), `${stage}: whatever reached disk is reconciled conservatively (${JSON.stringify(r.reopenStates)})`); if (stage === 'close') { assert.deepEqual(r.reopenStates, ['UNRESOLVED'], 'the row written before the failed close IS on disk and stays charged'); assert.equal(r.reopenTotal, 1); }
    }
  });
  test(`C-V02 (${kind}). a lower-cost settle whose primary close fails is not settled: the reservation stays charged, the latch holds, and a reopen resolves it UNRESOLVED; the healthy control keeps settling`, () => {
    const r = probe(kind, 'settle-close'); assert.equal(r.injected, 1); assert.equal(r.error, 'IO_FAILURE'); assert.deepEqual(r.states, ['RESERVED'], 'the settle never committed in the owning session'); assert.equal(r.totals, 1, 'the conservative reservation stays charged while the latch holds'); assert.equal(r.secondError, 'IO_FAILURE');
    // the uncertain close left the settle row on disk: a verified reopen validates the ACTUAL journal (the valid row is never truncated) and starts without the latch
    assert.deepEqual(r.reopenStates, ['SETTLED'], 'the durable row is the truth at reopen'); assert.equal(r.reopenTotal, kind === 'budget' ? 0.1 : 1); assert.equal(r.reopenLatched, null);
    const dir = tmp('rev3-healthy-'); const j = (kind === 'budget' ? openBudgetJournal : openQuotaJournal)({ dir, clock: () => T0 });
    try { if (kind === 'budget') { j.reserve({ reservationId: 'h', caseId: 'h', attemptId: 'h', estimatedUsd: 1, inputTokens: 1_000_000, maxOutputTokens: 0, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 }, caps: { maxEstimatedUsdPerCase: 10, maxEstimatedUsdPerDay: 10, maxEstimatedUsdPerMonth: 10, totalSmokeMaxEstimatedUsd: 1 } }); j.settle({ reservationId: 'h', usage: { inputTokens: 100_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 } }); assert.equal(j.totals().dayUsd, 0.1, 'a complete durable lower-cost settlement frees allowance'); } else { const id = j.reserve({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', unit: 'CALL', credits: 1, chargedOn: 'DISPATCH', purpose: 'ACQUIRE', requestKey: 'h', estimatedUsd: 0 }); j.settle(id, { ok: true, status: 200 }); assert.equal(j.reservations()[0].state, 'SETTLED'); } assert.equal(j.failed(), null); } finally { j.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test(`C-V03 (${kind}). a failed initialization (lock fsync EIO) leaves neither descriptor nor lock behind, and the journal reopens; another owner's lock is never deleted`, () => {
    const r = probe(kind, 'lock-fsync'); assert.equal(r.injected, 1); assert.equal(r.openError, 'IO_FAILURE'); assert.equal(r.lockLeft, false, 'our partially written lock is removed'); assert.equal(r.reopened, true);
    const dir = tmp('rev3-lock-'); mkdirSync(dir, { recursive: true }); const lock = path.join(dir, kind === 'budget' ? 'budget.lock' : 'quota.lock'); writeFileSync(lock, '{"pid":1}\n');
    try { assert.throws(() => (kind === 'budget' ? openBudgetJournal : openQuotaJournal)({ dir, clock: () => T0 }), (e) => e.code === 'PERMISSION_FAILURE'); assert.equal(existsSync(lock), true, 'the other owner\'s lock stays'); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// ================================================================= D: component family binding =============================
async function sealedFixture() {
  const dir = tmp('rev3-family-'); const cap = path.join(dir, 'capture'); const ctxDir = path.join(dir, 'context'); const schedules = [];
  const timers = { setInterval: (fn, ms) => { const x = { fn, ms, unref() {} }; schedules.push(x); return x; }, clearInterval() {}, setTimeout, clearTimeout };
  const own = createResearchOwner({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT'] })), subjects: btcOnly(), clock: () => T0, mode: 'INTEGRATED', researchRoot: dir, timers, fetchImpl: async () => json(H.KRAKEN_ASSET_PAIRS) });
  try { await own.start({ outDir: cap, families: [] }); own.observer.onBook({ coin: 'BTC', symbol: 'BTC/USD', receivedTs: T0, synced: true, checksumVerified: true, pricePrecision: 1, qtyPrecision: 8, levels: () => ({ bids: [[99.5, 2]], asks: [[100.5, 2]] }) }); for (const s of schedules) if (s.ms === 250) s.fn(); await own.stop({ seal: true }); runBuild({ captureDir: cap, asOfTs: T0, canonicalCoin: 'BTC', out: ctxDir }); readContext(ctxDir); return { dir, ctxDir }; } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; } finally { await own.stop({ seal: false }); }
}
// move one component to another family, recompute every supported identity / count / checksum, and reseal the bundle
function relabel(ctxDir, metricId, fromFamily, toFamily) {
  const ctx = JSON.parse(readFileSync(path.join(ctxDir, 'context.json'), 'utf8')); const list = ctx.families[fromFamily].components; const i = list.findIndex((c) => c.metricId === metricId); const [c] = list.splice(i, 1); c.family = toFamily; ctx.families[toFamily].components.push(c); ctx.families[toFamily].state = 'OBSERVED';
  c.componentId = `mcc-${canonicalDigest(Object.fromEntries(COMPONENT_KEYS.filter((k) => k !== 'componentId').map((k) => [k, c[k]]))).slice(0, 40)}`; ctx.contextId = contextIdentity(ctx);
  const cov = JSON.parse(readFileSync(path.join(ctxDir, 'coverage.json'), 'utf8')); for (const [fam, f] of Object.entries(ctx.families)) { cov.families[fam].state = f.state; cov.families[fam].components = f.components.length; }
  const mf = JSON.parse(readFileSync(path.join(ctxDir, 'manifest.json'), 'utf8'));
  for (const [name, value] of [['context.json', ctx], ['coverage.json', cov]]) { const bytes = Buffer.from(`${JSON.stringify(value, null, 1)}\n`); writeFileSync(path.join(ctxDir, name), bytes); const member = mf.members.find((m) => m.name === name); member.bytes = bytes.length; member.sha256 = sha256Hex(bytes); }
  mf.summary.contextId = ctx.contextId; mf.bundleId = manifestIdentity(mf); writeFileSync(path.join(ctxDir, 'manifest.json'), `${JSON.stringify(mf, null, 1)}\n`); return ctx;
}
const SEMANTIC = (e) => ['INVALID_INPUT', 'VALIDATION_FAILURE', 'CORRUPT_INPUT'].includes(e.code) && !/checksum|sha256|digest|does not match content|bundleId|byte size/i.test(e.message);

test('D-V01. the closed binding table: every schema metric binds to exactly one family; single-family recipes bind their own family; every generic-recipe metric is bound explicitly; the binding check refuses a foreign supplied or containing family', () => {
  assert.deepEqual(Object.keys(COMPONENT_FAMILY).sort(), Object.keys(METRIC_SCHEMAS).sort());
  for (const [metricId, family] of Object.entries(COMPONENT_FAMILY)) { assert.ok(FAMILIES.includes(family)); if (RECIPES[metricId]) assert.equal(family, RECIPES[metricId].family, `${metricId}: single-family recipe binds its own family`); else assert.equal(family, GENERIC_RECIPE_METRIC_FAMILY[metricId], `${metricId}: generic recipe bound explicitly`); }
  for (const metricId of Object.keys(METRIC_RECIPE)) assert.ok(GENERIC_RECIPE_METRIC_FAMILY[metricId], `${metricId}: a generic-recipe use is never inferred from the recipe's nominal family`);
  assert.equal(RECIPES.latest_observation.family, 'NETWORK_ACTIVITY'); assert.equal(COMPONENT_FAMILY.holder_cohorts, 'ONCHAIN_ENTITY_FLOW'); assert.equal(COMPONENT_FAMILY.pool_liquidity, 'DEX_DEFI'); assert.equal(COMPONENT_FAMILY.active_addresses, 'NETWORK_ACTIVITY');
  const table = [['spread_bps', 'DISPLAYED_LIQUIDITY', 'NETWORK_ACTIVITY'], ['signed_notional', 'SPOT_FLOW', 'SPOT_PRICE_CHART'], ['exchange_reserve', 'ONCHAIN_ENTITY_FLOW', 'NETWORK_ACTIVITY'], ['pool_liquidity', 'DEX_DEFI', 'ONCHAIN_ENTITY_FLOW'], ['active_addresses', 'NETWORK_ACTIVITY', 'DEX_DEFI'], ['indicators', 'SPOT_PRICE_CHART', 'CROSS_VENUE']];
  for (const [metricId, home, foreign] of table) {
    const recipe = RECIPES[metricId] ?? RECIPES[METRIC_RECIPE[metricId]]; const c = { metricId, family: home, recipeId: recipe.recipeId, version: recipe.version };
    assert.equal(componentBindingError(c, home), null, `${metricId} at home`);
    assert.match(componentBindingError({ ...c, family: foreign }, foreign) ?? '', /family disagrees/, `${metricId}: supplied + containing foreign family`);
    assert.match(componentBindingError(c, foreign) ?? '', /family disagrees/, `${metricId}: containing family foreign`);
    assert.match(componentBindingError({ ...c, family: foreign }, home) ?? '', /family disagrees/, `${metricId}: supplied family foreign`);
    assert.match(componentBindingError({ ...c, recipeId: 'spread_bps' === metricId ? 'microprice' : 'spread_bps' }, home) ?? '', /recipe binding malformed/);
    assert.match(componentBindingError({ ...c, version: 2 }, home) ?? '', /recipe binding malformed/);
  }
  assert.match(componentBindingError({ metricId: 'not_a_metric', family: 'SPOT_FLOW', recipeId: 'signed_notional', version: 1 }, 'SPOT_FLOW'), /no closed schema/);
});

test('D-V02. a relabelled component is refused by the pure validator, the candidate publisher law, the saved-artifact reader after a valid reseal, and the packet boundary — semantically, never by checksum; the untouched artifact and a second single-family relabel behave the same', async () => {
  const fx = await sealedFixture();
  try {
    const before = JSON.parse(readFileSync(path.join(fx.ctxDir, 'context.json'), 'utf8')); assert.equal(contextError(before), null);
    for (const [metricId, from, to] of [['spread_bps', 'DISPLAYED_LIQUIDITY', 'NETWORK_ACTIVITY'], ['signed_notional', 'SPOT_FLOW', 'SPOT_PRICE_CHART']]) {
      writeFileSync(path.join(fx.ctxDir, 'context.json'), `${JSON.stringify(before, null, 1)}\n`); // restore, then reseal a fresh relabel
      const ctx = relabel(fx.ctxDir, metricId, from, to);
      const e = contextError(ctx); assert.match(e ?? '', /family disagrees with the metric's closed binding/, `${metricId}: pure validator`);
      assert.throws(() => readContext(fx.ctxDir), (err) => SEMANTIC(err) && /family disagrees/.test(err.message), `${metricId}: reader`);
      const refs = JSON.parse(readFileSync(path.join(fx.ctxDir, 'input-references.json'), 'utf8')); const cov = JSON.parse(readFileSync(path.join(fx.ctxDir, 'coverage.json'), 'utf8'));
      assert.match(contextBundleError({ context: ctx, inputReferences: refs, coverage: cov, identity: codeIdentity() }) ?? '', /family disagrees/, `${metricId}: candidate law`);
      const packet = buildResearchEvidenceV2({ marketContext: ctx, asOfTs: T0, trigger: { kind: 'MARKET_RESEARCH' } }); assert.equal(packet.ok, false); assert.match(packet.detail ?? '', /family disagrees/, `${metricId}: packet boundary`);
    }
    // restore the lawful bytes: the same reader accepts them again (the rejection was the binding, not the reseal)
    writeFileSync(path.join(fx.ctxDir, 'context.json'), `${JSON.stringify(before, null, 1)}\n`); const mf = JSON.parse(readFileSync(path.join(fx.ctxDir, 'manifest.json'), 'utf8')); const bytes = Buffer.from(`${JSON.stringify(before, null, 1)}\n`); const member = mf.members.find((m) => m.name === 'context.json'); member.bytes = bytes.length; member.sha256 = sha256Hex(bytes); mf.summary.contextId = before.contextId; mf.bundleId = manifestIdentity(mf); writeFileSync(path.join(fx.ctxDir, 'manifest.json'), `${JSON.stringify(mf, null, 1)}\n`);
    const cov = JSON.parse(readFileSync(path.join(fx.ctxDir, 'coverage.json'), 'utf8')); for (const [fam, f] of Object.entries(before.families)) { cov.families[fam].state = f.state; cov.families[fam].components = f.components.length; } const cb = Buffer.from(`${JSON.stringify(cov, null, 1)}\n`); writeFileSync(path.join(fx.ctxDir, 'coverage.json'), cb); const cm = mf.members.find((m) => m.name === 'coverage.json'); cm.bytes = cb.length; cm.sha256 = sha256Hex(cb); mf.bundleId = manifestIdentity(mf); writeFileSync(path.join(fx.ctxDir, 'manifest.json'), `${JSON.stringify(mf, null, 1)}\n`);
    readContext(fx.ctxDir);
  } finally { rmSync(fx.dir, { recursive: true, force: true }); }
});

test('D-V03. valid generic-recipe families stay green: real DEX / entity-flow / holder / network components built by the actual builder validate, and a positive signed metric is untouched', async () => {
  const dir = tmp('rev3-generic-'); const own = createResearchOwner({ policy: cryptoquantPolicy(), subjects: btcOnly(), env: { CRYPTOQUANT_API_KEY: 'offline-fixture' }, clock: () => T0, researchRoot: dir, fetchImpl: cryptoquantFetch() });
  try {
    const net = await own.acquire('NETWORK_ACTIVITY', 'BTC'); const flow = await own.acquire('ONCHAIN_ENTITY_FLOW', 'BTC'); const obs = [...net.observations, ...flow.observations];
    const built = buildContext({ canonicalCoin: 'BTC', asOfTs: T0, observations: obs, coverage: [...net.coverage, ...flow.coverage], captureRef: SEALED_REF });
    assert.equal(contextError(built.context, { inputReferences: built.inputReferences }), null);
    const fams = Object.fromEntries(Object.entries(built.context.families).map(([f, v]) => [f, v.components.map((c) => c.metricId)]));
    assert.ok(fams.NETWORK_ACTIVITY.includes('active_addresses')); assert.ok(fams.ONCHAIN_ENTITY_FLOW.includes('exchange_net_flow')); assert.ok(fams.ONCHAIN_ENTITY_FLOW.includes('exchange_reserve'));
    for (const [fam, v] of Object.entries(built.context.families)) for (const c of v.components) assert.equal(COMPONENT_FAMILY[c.metricId], fam);
    const net_ = built.context.families.ONCHAIN_ENTITY_FLOW.components.find((c) => c.metricId === 'exchange_net_flow'); assert.equal(typeof net_.value.net, 'number', 'a signed metric keeps its value');
  } finally { await own.stop({ seal: false }); rmSync(dir, { recursive: true, force: true }); }
});
