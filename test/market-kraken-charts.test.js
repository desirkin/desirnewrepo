// MARKET-EDGE-KRAKEN-1 §11.1 — Kraken Futures Charts / Market Analytics (dark sense A). Mock only: a loopback fixture
// speaks the documented response shapes (docs checked 2026-09-10); no network, no credential, no order verb.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/market-lab.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createKrakenDerivativesClient } from '../market-lab/providers/kraken-derivatives.js';
import { createKrakenChartsClient, parseAnalyticsPage, CHARTS_NATIVE_UNIT_LABELS, FORWARD_CAPTURE_BUCKETS } from '../market-lab/providers/kraken-charts.js';
import { ANALYTICS_TYPES, ANALYTICS_TYPES_UNSUPPORTED, ANALYTICS_VALUE_KEYS, ANALYTICS_MANIPULATION_RISK, observationError, DARK_FAMILIES, FAMILIES } from '../market-lab/contracts.js';
import { CHARTS_DEFAULTS, loadPolicy, chartsEnabled } from '../market-lab/policy.js';
import { endpointOf } from '../market-lab/registry.js';

const T0 = Date.parse('2026-09-10T12:00:00Z'); const I = 300; const IMS = I * 1000;
const bucket = (k) => Math.floor(T0 / IMS) * I - I * k; // k buckets before the one containing T0 (k = 0: in progress)
const page = (type, buckets, { more = false, data = null } = {}) => { const n = buckets.length; const d = data ?? (type === 'cvd' ? { buyVolume: buckets.map((_, i) => String(i + 1)), sellVolume: buckets.map(() => '1'), cvd: buckets.map((_, i) => String(i)) } : type === 'future-basis' ? { basis: buckets.map((_, i) => 0.1 * (i + 1)) } : type === 'funding' ? { rate: buckets.map(() => [1, 2, 0.5, 1.5]), relativeRate: buckets.map(() => [0.01, 0.02, 0.005, 0.015]) } : buckets.map((_, i) => 100 + i)); return { result: { timestamp: buckets, data: d, more }, errors: [] }; };
const CHARTS = { ...CHARTS_DEFAULTS, enabled: true, analyticsTypes: [...CHARTS_DEFAULTS.analyticsTypes, 'trade-count'], intervalsS: [60, 300, 3600], maxPagesPerRequest: 3, maxCallsPerDay: 100 };
async function rig(routes, { clock = null, charts = CHARTS } = {}) {
  let t = T0; const clk = clock ?? (() => t);
  const fixture = await H.startHttpFixture({ 'GET /derivatives/api/v3/instruments': { json: H.KF_INSTRUMENTS }, ...routes });
  const recorded = []; const transport = createHttpTransport({ fetchImpl: H.fetchFor(fixture), clock: clk, recorder: (r) => recorded.push(r) });
  const d = createKrakenDerivativesClient({ transport, clock: clk }); const cat = await d.loadInstruments(); assert.equal(cat.ok, true);
  const client = createKrakenChartsClient({ transport, clock: clk, resolveInstrument: d.resolveInstrument, charts });
  return { fixture, charts: client, recorded, advance: (ms) => { t += ms; }, close: () => fixture.close() };
}

test('CH-01. the registry extends KRAKEN_DERIVATIVES (no duplicate provider) with a DARK charts endpoint on the documented host/path; the dark family is outside FAMILIES; the parser accepts every documented value schema and refuses the nested types as NOT_SUPPORTED_WITH_CURRENT_SCHEMA', () => {
  const e = endpointOf('KRAKEN_DERIVATIVES', 'charts-analytics'); assert.ok(e); assert.equal(e.host, 'futures.kraken.com'); assert.equal(e.path, '/api/charts/v1/analytics/{symbol}/{analyticsType}'); assert.equal(e.dark, true); assert.deepEqual(e.families, ['DERIVATIVES_PRESSURE']); assert.equal(e.verifiedDate, '2026-09-10');
  assert.ok(DARK_FAMILIES.includes('DERIVATIVES_PRESSURE') && !FAMILIES.includes('DERIVATIVES_PRESSURE'));
  const b = [bucket(2), bucket(1)];
  for (const type of ANALYTICS_TYPES) { const r = parseAnalyticsPage(page(type, b), { analyticsType: type, intervalS: I }); assert.equal(r.ok, true, type); assert.equal(r.buckets.length, 2); assert.deepEqual(Object.keys(r.buckets[0].values), ANALYTICS_VALUE_KEYS[type]); assert.equal(r.more, false); }
  for (const type of ANALYTICS_TYPES_UNSUPPORTED) assert.equal(parseAnalyticsPage(page('open-interest', b), { analyticsType: type, intervalS: I }).reason, 'NOT_SUPPORTED_WITH_CURRENT_SCHEMA');
  // closed shapes: a length mismatch, a missing column, a 3-element funding row, a non-boolean `more`, provider errors (never echoed)
  assert.equal(parseAnalyticsPage({ result: { timestamp: b, data: [1], more: false }, errors: [] }, { analyticsType: 'open-interest', intervalS: I }).reason, 'SCHEMA');
  assert.equal(parseAnalyticsPage({ result: { timestamp: b, data: { buyVolume: ['1', '2'], cvd: ['1', '2'] }, more: false }, errors: [] }, { analyticsType: 'cvd', intervalS: I }).reason, 'SCHEMA');
  assert.equal(parseAnalyticsPage({ result: { timestamp: b, data: { rate: [[1, 2, 3], [1, 2, 3]], relativeRate: [[1, 2, 3, 4], [1, 2, 3, 4]] }, more: false }, errors: [] }, { analyticsType: 'funding', intervalS: I }).reason, 'SCHEMA');
  assert.equal(parseAnalyticsPage({ result: { timestamp: b, data: [1, 2] }, errors: [] }, { analyticsType: 'open-interest', intervalS: I }).reason, 'SCHEMA');
  const pe = parseAnalyticsPage({ result: { timestamp: b, data: [1, 2], more: false }, errors: ['secret provider text'] }, { analyticsType: 'open-interest', intervalS: I }); assert.equal(pe.reason, 'PROVIDER_ERRORS'); assert.equal(pe.errorCount, 1); assert.ok(!JSON.stringify(pe).includes('secret'));
  // non-advancing timestamps fail closed; a misaligned bucket is dropped and counted (never re-aligned)
  assert.equal(parseAnalyticsPage(page('open-interest', [bucket(1), bucket(1)]), { analyticsType: 'open-interest', intervalS: I }).reason, 'NON_ADVANCING_TIMESTAMPS');
  const mis = parseAnalyticsPage(page('open-interest', [bucket(2), bucket(1) + 7]), { analyticsType: 'open-interest', intervalS: I }); assert.equal(mis.buckets.length, 1); assert.equal(mis.misaligned, 1);
  // an all-null bucket carries null values (never zero)
  const nul = parseAnalyticsPage({ result: { timestamp: b, data: [null, '5'], more: false }, errors: [] }, { analyticsType: 'open-interest', intervalS: I }); assert.equal(nul.buckets[0].values, null); assert.equal(nul.buckets[1].values.value, 5);
});

test('CH-02. clocks and finality: bucketTs is the period start and periodEnd = bucketTs + interval; a bucket ending after receipt is PROVISIONAL (UNCOMMITTED_BAR), one that closed is FINAL; knownAtTs = receivedTs for EVERY vintage (a HISTORICAL_FETCH is never known at bucket time); units stay NATIVE with UNIT_UNVERIFIED; manipulation risk is the documented class; the envelope validates', async () => {
  const r = await rig({ '*': (req) => ({ json: page(req.path.split('/').pop(), [bucket(2), bucket(1), bucket(0)]) }) });
  try {
    const live = await r.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I });
    assert.equal(live.ok, true); assert.equal(live.observations.length, 3);
    for (const o of live.observations) { assert.equal(observationError(o), null); assert.equal(o.kind, 'DERIVATIVE_ANALYTIC_BUCKET'); assert.equal(o.subject.subjectKind, 'DERIVATIVE'); assert.equal(o.periodStartTs, o.payload.bucketTs); assert.equal(o.periodEndTs, o.payload.bucketTs + IMS); assert.equal(o.knownAtTs, o.receivedTs); assert.equal(o.payload.vintage, 'LIVE_FORWARD_CAPTURE'); assert.equal(o.provenance.vintage, 'LIVE_FORWARD_CAPTURE'); assert.equal(o.payload.normalizedUnit, 'NATIVE'); assert.equal(o.payload.normalization, 'NONE'); assert.equal(o.payload.nativeUnit, CHARTS_NATIVE_UNIT_LABELS['open-interest']); assert.ok(o.quality.reasonCodes.includes('UNIT_UNVERIFIED')); assert.equal(o.payload.manipulationRisk, ANALYTICS_MANIPULATION_RISK['open-interest']); }
    const [b2, b1, b0] = live.observations; assert.equal(b2.payload.finality, 'FINAL'); assert.equal(b2.quality.state, 'KNOWN'); assert.equal(b1.payload.finality, 'FINAL');
    assert.equal(b0.payload.finality, 'PROVISIONAL'); assert.equal(b0.quality.state, 'PROVISIONAL'); assert.ok(b0.quality.reasonCodes.includes('UNCOMMITTED_BAR')); assert.ok(b0.periodEndTs > b0.receivedTs);
    assert.equal(live.coverage[0].family, 'DERIVATIVES_PRESSURE'); assert.equal(live.coverage[0].state, 'OBSERVED'); assert.equal(live.coverage[0].observationCount, 3);
    // historical vintage: same buckets, knownAtTs is the fetch receipt, the identity differs (a revision is a NEW observation)
    r.advance(60_000);
    const hist = await r.charts.fetchAnalytics({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I, sinceTs: bucket(2) * 1000, vintage: 'HISTORICAL_FETCH' });
    assert.equal(hist.ok, true); assert.equal(hist.observations[0].payload.vintage, 'HISTORICAL_FETCH'); assert.equal(hist.observations[0].knownAtTs, hist.observations[0].receivedTs); assert.ok(hist.observations[0].knownAtTs > hist.observations[0].periodEndTs); assert.notEqual(hist.observations[0].observationId, b2.observationId); assert.equal(hist.observations[0].sourceKey, b2.sourceKey); assert.notEqual(hist.observations[0].sourceRevision, b2.sourceRevision);
    // the closed payload law refuses a FINAL bucket that ends after receipt and a PROVISIONAL one that already closed
    const forged = { ...b0, payload: { ...b0.payload, finality: 'FINAL' }, quality: { ...b0.quality, state: 'KNOWN', reasonCodes: ['UNIT_UNVERIFIED'] } }; assert.match(observationError(forged) ?? '', /FINAL bucket cannot end after receipt|observationId/);
    const forged2 = { ...b2, payload: { ...b2.payload, finality: 'PROVISIONAL' }, quality: { ...b2.quality, state: 'PROVISIONAL', reasonCodes: ['UNCOMMITTED_BAR', 'UNIT_UNVERIFIED'] } }; assert.match(observationError(forged2) ?? '', /not PROVISIONAL|observationId/);
    // every required type is parsed into its own closed value keys; the manipulation class is documentation carried on the record
    for (const type of ['aggressor-differential', 'liquidation-volume', 'cvd', 'future-basis', 'funding']) { const x = await r.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: type, intervalS: I }); assert.equal(x.ok, true, type); assert.deepEqual(Object.keys(x.observations[0].payload.values), ANALYTICS_VALUE_KEYS[type]); assert.equal(x.observations[0].payload.manipulationRisk, ANALYTICS_MANIPULATION_RISK[type]); }
    assert.equal(ANALYTICS_MANIPULATION_RISK['future-basis'], 'LOWER'); assert.equal(ANALYTICS_MANIPULATION_RISK.funding, 'LOWER'); assert.equal(ANALYTICS_MANIPULATION_RISK['long-short-ratio'], 'HIGHER');
  } finally { await r.close(); }
});

test('CH-03. pagination follows result.more with an advancing cursor; the page cap yields PAGINATION_INCOMPLETE (PARTIAL coverage, data kept); a page that does not advance FAILS CLOSED (never re-requested); the policy bounds (types, intervals, lookback, forward-capture reach, daily cap) refuse before any request; an unknown instrument is NOT_IN_CATALOG', async () => {
  const seen = []; let mode = 'advance';
  const r = await rig({ '*': (req) => { seen.push(req.query.since); const since = Number(req.query.since); if (mode === 'stuck') return { json: page('open-interest', [since, since + I], { more: true }) }; return { json: page('open-interest', [since, since + I], { more: true }) }; } });
  try {
    const capped = await r.charts.fetchAnalytics({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I, sinceTs: bucket(40) * 1000, vintage: 'HISTORICAL_FETCH', maxPages: 3 });
    assert.equal(capped.ok, true); assert.equal(capped.meta.pages, 3); assert.equal(capped.meta.truncated, true); assert.ok(capped.coverage[0].reasonCodes.includes('PAGINATION_INCOMPLETE')); assert.equal(capped.observations.length, 6);
    assert.deepEqual(seen.slice(0, 3).map(Number), [bucket(40), bucket(40) + 2 * I, bucket(40) + 4 * I], 'the cursor advances past the last bucket of each page');
    assert.equal(capped.observations[0].payload.pageIndex, 0); assert.equal(capped.observations[5].payload.pageIndex, 2); assert.equal(capped.observations[5].payload.more, true);
  } finally { await r.close(); }
  // a provider stuck on the same buckets: the cursor would not advance -> stop after ONE page, PAGINATION_INCOMPLETE, no loop
  const stuckSeen = [];
  const r2 = await rig({ '*': (req) => { stuckSeen.push(req.query.since); return { json: page('open-interest', [bucket(40), bucket(39)], { more: true }) }; } }, { charts: { ...CHARTS, maxCallsPerDay: 6 } });
  try {
    const stuck = await r2.charts.fetchAnalytics({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I, sinceTs: bucket(38) * 1000, vintage: 'HISTORICAL_FETCH', maxPages: 3 });
    assert.equal(stuck.meta.nonAdvancing, true); assert.equal(stuck.meta.pages, 1); assert.ok(stuck.coverage[0].reasonCodes.includes('PAGINATION_INCOMPLETE')); assert.equal(stuckSeen.length, 1);
    assert.equal(stuck.observations.length, 0, 'buckets before the cursor are never admitted as if newly fetched forward');
    const notInCatalog = await r2.charts.pollForward({ symbol: 'PF_NOPEUSD', analyticsType: 'open-interest', intervalS: I }); assert.equal(notInCatalog.failure.kind, 'NOT_IN_CATALOG'); assert.equal(notInCatalog.coverage.length, 0);
    const badType = await r2.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: 'rolling-volatility', intervalS: I }); assert.equal(badType.failure.kind, 'TYPE_NOT_PERMITTED'); assert.equal(badType.coverage[0].state, 'NOT_QUERIED');
    const nested = await r2.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: 'orderbook', intervalS: I }); assert.equal(nested.failure.kind, 'NOT_SUPPORTED_WITH_CURRENT_SCHEMA'); assert.equal(nested.coverage[0].state, 'NOT_SUPPORTED');
    const badInterval = await r2.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: 900 }); assert.equal(badInterval.failure.kind, 'INTERVAL_NOT_PERMITTED');
    const tooOld = await r2.charts.fetchAnalytics({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I, sinceTs: T0 - 31 * 86_400_000, vintage: 'HISTORICAL_FETCH' }); assert.equal(tooOld.failure.kind, 'LOOKBACK_EXCEEDED');
    const reach = await r2.charts.fetchAnalytics({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I, sinceTs: T0 - (FORWARD_CAPTURE_BUCKETS + 1) * IMS, vintage: 'LIVE_FORWARD_CAPTURE' }); assert.equal(reach.failure.kind, 'VINTAGE_MISMATCH');
    await assert.rejects(r2.charts.fetchAnalytics({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I, sinceTs: T0, vintage: 'BACKFILL' }), /vintage/);
    assert.equal(stuckSeen.length, 1, 'refusals dispatch nothing');
    // the per-day call cap: after maxCallsPerDay dispatches the client refuses with QUOTA_REFUSED coverage
    for (let i = 0; i < 5; i += 1) await r2.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I });
    const capped2 = await r2.charts.pollForward({ symbol: 'PF_XBTUSD', analyticsType: 'open-interest', intervalS: I }); assert.equal(capped2.failure.kind, 'CHARTS_DAILY_CAP'); assert.deepEqual(capped2.coverage[0].reasonCodes, ['QUOTA_REFUSED']);
  } finally { await r2.close(); }
});

test('CH-04. policy: charts ships DISABLED with closed keys and ceilings; an unknown analytics type, an undocumented interval, a page count over the ceiling or a cadence under the floor is refused; an older policy without the block loads with the shipped defaults', () => {
  const base = H.policyWith({ providers: ['KRAKEN_DERIVATIVES'] });
  assert.equal(chartsEnabled(loadPolicy(base)), false); assert.deepEqual(loadPolicy(base).providers.KRAKEN_DERIVATIVES.charts, CHARTS_DEFAULTS);
  const older = structuredClone(base); delete older.providers.KRAKEN_DERIVATIVES.charts; assert.deepEqual(loadPolicy(older).providers.KRAKEN_DERIVATIVES.charts, CHARTS_DEFAULTS);
  const on = structuredClone(base); on.providers.KRAKEN_DERIVATIVES.charts.enabled = true; assert.equal(chartsEnabled(loadPolicy(on)), true);
  const bad = (mut) => { const p = structuredClone(base); mut(p.providers.KRAKEN_DERIVATIVES.charts); assert.throws(() => loadPolicy(p), /charts/); };
  bad((c) => { c.analyticsTypes = ['orderbook']; }); bad((c) => { c.intervalsS = [120]; }); bad((c) => { c.maxPagesPerRequest = 51; }); bad((c) => { c.pollingCadenceMs = 1000; }); bad((c) => { c.extra = 1; }); bad((c) => { c.maxLookbackMs = 0; });
  const spot = structuredClone(base); spot.providers.KRAKEN_SPOT.charts = { ...CHARTS_DEFAULTS }; assert.throws(() => loadPolicy(spot), /undeclared key/);
});
