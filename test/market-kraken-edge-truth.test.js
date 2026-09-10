// MARKET-EDGE-KRAKEN-1 §8 / §11.3 — POINT-IN-TIME and REPLAY law for the dark senses: the as-of wall, provisional
// exclusion, revisions as new observations, no zero-fill, coverage gaps lowering support, DELETE vs SCOPE_EVICTED vs GAP,
// deterministic recipes, and the sealed EDGE_CAPTURE bundle reopened under the same closed contracts. Mock only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as H from './helpers/market-lab.js';
import { createScriptedWebSocket } from './helpers/scripted-ws.js';
import { makeObservation, observationError, quality, emptyProvenance, ANALYTICS_MANIPULATION_RISK, DARK_PAYLOAD_KINDS } from '../market-lab/contracts.js';
import { orderKeyOf } from '../market-lab/l3-book.js';
import { analyticsSeries, derivativesPressure, l3Microstructure, level, change, EDGE_RECIPES, EDGE_RECIPE_SET_VERSION } from '../market-lab/edge-recipes.js';
import { loadPolicy, sampleSubjects } from '../market-lab/policy.js';
import { runEdgeCapture, readEdgeCapture, EDGE_STATUS } from '../market-lab/edge-capture.js';
import { openBundle } from '../market-lab/store.js';
import { admissibleAt } from '../market-lab/time.js';

const T0 = Date.parse('2026-09-10T12:00:00Z'); const IMS = 300_000;
const FUT = { subjectKind: 'DERIVATIVE', canonicalCoin: 'BTC', providerAssetId: null, venue: 'kraken-futures', instrumentId: 'PF_XBTUSD', specificationId: 'PF_XBTUSD:flexible_futures:1', marketType: 'PERPETUAL' };
const SPOT = { subjectKind: 'MARKET', canonicalCoin: 'BTC', providerAssetId: null, venue: 'kraken', nativeSymbol: 'BTC/USD', base: 'BTC', quote: 'USD', marketType: 'SPOT', quoteAliasGroup: null };
let seq = 0;
// one analytics bucket observation exactly as the client emits it (FINAL unless the bucket end lies after receipt)
function bucketObs({ type = 'open-interest', bucketTs, values, receivedTs, vintage = 'LIVE_FORWARD_CAPTURE', intervalMs = IMS }) {
  const provisional = bucketTs + intervalMs > receivedTs; const keys = { 'open-interest': ['value'], 'aggressor-differential': ['value'], 'liquidation-volume': ['value'], cvd: ['buyVolume', 'sellVolume', 'cvd'], 'future-basis': ['basis'], funding: ['rateOpen', 'rateHigh', 'rateLow', 'rateClose', 'relativeRateOpen', 'relativeRateHigh', 'relativeRateLow', 'relativeRateClose'] }[type];
  const v = values === null ? null : Object.fromEntries(keys.map((k, i) => [k, Array.isArray(values) ? values[i] ?? values[0] : values]));
  return makeObservation({ provider: 'KRAKEN_DERIVATIVES', endpointId: 'charts-analytics', subject: FUT, kind: 'DERIVATIVE_ANALYTIC_BUCKET', sourceKey: `PF_XBTUSD:${type}:${intervalMs / 1000}:${bucketTs}`, sourceRevision: `${vintage}:${receivedTs}`, sourceEventTs: bucketTs, periodStartTs: bucketTs, periodEndTs: bucketTs + intervalMs, publishedTs: null, receivedTs, knownAtTs: receivedTs, sequence: (seq += 1), epochId: null,
    quality: v === null ? quality('MISSING', { reasonCodes: ['FIELD_MISSING_AT_SOURCE', 'UNIT_UNVERIFIED'] }) : provisional ? quality('PROVISIONAL', { reasonCodes: ['UNCOMMITTED_BAR', 'UNIT_UNVERIFIED'] }) : quality('KNOWN', { reasonCodes: ['UNIT_UNVERIFIED'] }), provenance: { ...emptyProvenance(), vintage },
    payload: { analyticsType: type, intervalMs, bucketTs, values: v, nativeUnit: `kraken-charts:${type}`, normalizedUnit: 'NATIVE', normalization: 'NONE', finality: provisional ? 'PROVISIONAL' : 'FINAL', manipulationRisk: ANALYTICS_MANIPULATION_RISK[type], vintage, pageIndex: 0, more: false } });
}
const B = (k) => Math.floor(T0 / IMS) * IMS - k * IMS; // the bucket k intervals before the one containing T0
const order = (id, price, qty, firstSeenTs) => ({ orderKey: orderKeyOf('BTC/USD', id), price, qty, providerTs: firstSeenTs, firstSeenTs, modifiedTs: null });
const NULL_CLOCKS = { sourceKey: null, sourceRevision: null, sourceEventTs: null, periodStartTs: null, periodEndTs: null, publishedTs: null };
const snapshotObs = ({ receivedTs, bids, asks, epochId = 'KRAKEN_SPOT:ws-l3:1', synchronized = true }) => makeObservation({ ...NULL_CLOCKS, provider: 'KRAKEN_SPOT', endpointId: 'ws-l3', subject: SPOT, kind: 'L3_BOOK_SNAPSHOT', receivedTs, knownAtTs: receivedTs, sequence: (seq += 1), epochId, quality: quality(synchronized ? 'KNOWN' : 'PARTIAL', { reasonCodes: synchronized ? [] : ['DESYNCHRONIZED'] }), provenance: { ...emptyProvenance(), vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { depth: 10, bids, asks, checksumVerified: true, synchronized, sampleReason: 'INTERVAL', truncated: false, pricePrecision: 1, qtyPrecision: 8 } });
const ev = (event, id, side, price, qty, previousQty, firstSeenTs, receivedTs) => ({ event, orderKey: orderKeyOf('BTC/USD', id), side, price, qty, previousQty, providerTs: firstSeenTs, firstSeenTs, ageMs: receivedTs - firstSeenTs });
const eventsObs = ({ receivedTs, events, epochId = 'KRAKEN_SPOT:ws-l3:1' }) => makeObservation({ ...NULL_CLOCKS, provider: 'KRAKEN_SPOT', endpointId: 'ws-l3', subject: SPOT, kind: 'L3_ORDER_EVENT', receivedTs, knownAtTs: receivedTs, sequence: (seq += 1), epochId, quality: quality('KNOWN'), provenance: { ...emptyProvenance(), vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { depth: 10, events, checksumVerified: true } });
const covObs = ({ receivedTs, state, reason = 'NONE', epochId = 'KRAKEN_SPOT:ws-l3:1' }) => makeObservation({ ...NULL_CLOCKS, provider: 'KRAKEN_SPOT', endpointId: 'ws-l3', subject: SPOT, kind: 'L3_BOOK_COVERAGE', receivedTs, knownAtTs: receivedTs, sequence: (seq += 1), epochId, quality: quality('KNOWN'), provenance: { ...emptyProvenance(), vintage: 'LIVE_FORWARD_CAPTURE' }, payload: { state, reason, sinceTs: receivedTs, untilTs: null, droppedUpdates: 0, depth: 10, ordersTracked: 4 } });

test('PT-01. the as-of wall: a recipe at asOfTs sees ONLY observations with knownAtTs <= asOfTs (a later-fetched historical bucket is invisible until its fetch time, whatever its bucket time); PROVISIONAL buckets are excluded; the latest admissible REVISION of a bucket wins and a revision never overwrites; a missing bucket is a GAP (no zero-fill); the recipes are deterministic and order-invariant', () => {
  const t = B(0) + 60_000; // inside the in-progress bucket
  const final3 = bucketObs({ bucketTs: B(3), values: 100, receivedTs: B(2) + 5_000 }); const final2 = bucketObs({ bucketTs: B(2), values: 110, receivedTs: B(1) + 5_000 }); const final1 = bucketObs({ bucketTs: B(1), values: 125, receivedTs: B(0) + 5_000 }); const prov0 = bucketObs({ bucketTs: B(0), values: 999, receivedTs: B(0) + 30_000 });
  const late = bucketObs({ bucketTs: B(5), values: 90, receivedTs: t + 3_600_000, vintage: 'HISTORICAL_FETCH' }); // fetched an hour AFTER the as-of
  const obs = [prov0, final1, late, final3, final2];
  for (const o of obs) assert.equal(observationError(o), null);
  assert.equal(admissibleAt(late, t), false); assert.equal(admissibleAt(final1, t), true);
  const s = analyticsSeries(obs, { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t });
  assert.deepEqual(s.points.map((p) => p.bucketTs), [B(3), B(2), B(1)]); assert.equal(s.provisionalExcluded, 1); assert.equal(s.revisions, 0);
  assert.equal(level('oi_bucket_level', s, { asOfTs: t }).value, 125); assert.equal(change('oi_bucket_change', s, { asOfTs: t }).value, 15);
  const withProv = analyticsSeries(obs, { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t, includeProvisional: true }); assert.equal(withProv.points.at(-1).finality, 'PROVISIONAL');
  // the same bucket re-fetched later with a different value: a NEW observation; the latest admissible revision wins at a later as-of, the earlier one at an earlier as-of
  const revised = bucketObs({ bucketTs: B(1), values: 130, receivedTs: t + 600_000, vintage: 'HISTORICAL_FETCH' }); assert.notEqual(revised.observationId, final1.observationId);
  assert.equal(level('oi_bucket_level', analyticsSeries([...obs, revised], { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t }), { asOfTs: t }).value, 125, 'the revision is unknown at t');
  const laterSeries = analyticsSeries([...obs, revised], { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t + 700_000 }); assert.equal(laterSeries.revisions, 1); assert.equal(level('oi_bucket_level', laterSeries, { asOfTs: t + 700_000 }).value, 130);
  // a hole in the series: the change over the latest two buckets is a GAP with null, never zero-filled
  const holed = analyticsSeries([final3, final1], { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t }); const ch = change('oi_bucket_change', holed, { asOfTs: t }); assert.equal(ch.value, null); assert.equal(ch.support.state, 'PARTIAL'); assert.deepEqual(ch.support.reasons, ['GAP']); assert.equal(ch.support.buckets, 1);
  const nul = bucketObs({ bucketTs: B(1), values: null, receivedTs: B(0) + 5_000 }); const nulSeries = analyticsSeries([final3, final2, nul], { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t }); const lv = level('oi_bucket_level', nulSeries, { asOfTs: t }); assert.equal(lv.value, null); assert.equal(lv.support.state, 'MISSING'); assert.deepEqual(lv.support.reasons, ['VALUE_MISSING']);
  // determinism + order invariance
  const a = derivativesPressure(obs, { intervalMs: IMS, asOfTs: t }); const b = derivativesPressure([...obs].reverse(), { intervalMs: IMS, asOfTs: t }); assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); assert.equal(a.authority, 'NONE'); assert.equal(a.recipeSetVersion, EDGE_RECIPE_SET_VERSION);
  assert.equal(a.components.oi_bucket_acceleration.value, 5); assert.equal(a.components.oi_bucket_acceleration.support.state, 'COMPLETE'); assert.equal(a.components.aggressor_bucket_level.support.state, 'MISSING'); assert.equal(a.components.pressure_combinations.value.oi_rising_aggressor_positive, null, 'an unavailable component yields null, never false');
  assert.throws(() => derivativesPressure(obs, { intervalMs: IMS }), /asOfTs/);
  assert.throws(() => analyticsSeries([final1, bucketObs({ bucketTs: B(1), values: 1, receivedTs: B(0) + 5_000 }), { ...final1, subject: { ...FUT, instrumentId: 'PF_ETHUSD' } }], { analyticsType: 'open-interest', intervalMs: IMS, asOfTs: t }), /one instrument/);
});

test('PT-02. L3 windows: features at t use snapshots / events received at or before t only; a coverage GAP, a DESYNCHRONIZED transition or an epoch change inside the window lowers support to PARTIAL and marks the disappearance as unknown; DELETE and SCOPE_EVICTED are counted apart; ages are OUR firstSeenTs; the window may never end after the as-of', () => {
  const t0 = T0; const w = { asOfTs: t0 + 300_000, startTs: t0, endTs: t0 + 300_000 };
  const bids = [order('B1', 100, 2, t0 - 60_000), order('B2', 100, 1, t0 - 30_000), order('B3', 99, 5, t0 - 120_000)]; const asks = [order('A1', 101, 3, t0 - 5_000), order('A2', 102, 4, t0 - 90_000)];
  const s1 = snapshotObs({ receivedTs: t0 + 10_000, bids, asks }); const s2 = snapshotObs({ receivedTs: t0 + 290_000, bids: bids.slice(0, 2), asks });
  const e1 = eventsObs({ receivedTs: t0 + 100_000, events: [ev('DELETE', 'B3', 'BID', 99, 0, 5, t0 - 120_000, t0 + 100_000), ev('ADD', 'B4', 'BID', 100, 0.5, null, t0 + 100_000, t0 + 100_000), ev('SCOPE_EVICTED', 'A9', 'ASK', 110, 0, 7, t0 - 1_000, t0 + 100_000)] });
  const e2 = eventsObs({ receivedTs: t0 + 200_000, events: [ev('ADD', 'A3', 'ASK', 101, 1, null, t0 + 200_000, t0 + 200_000), ev('DELETE', 'A2', 'ASK', 102, 0, 4, t0 - 90_000, t0 + 200_000)] });
  const future = eventsObs({ receivedTs: t0 + 400_000, events: [ev('ADD', 'Z', 'BID', 100, 50, null, t0 + 400_000, t0 + 400_000)] });
  const all = [s1, e1, e2, s2, future];
  const m = l3Microstructure(all, w); const c = m.components;
  assert.equal(m.authority, 'NONE'); assert.equal(c.new_order_impulse.value.bid, 0.5); assert.equal(c.new_order_impulse.value.ask, 1); assert.equal(c.new_order_impulse.support.state, 'COMPLETE');
  assert.deepEqual(c.visible_liquidity_disappearance.value, { bid: { deleted: 5, scopeEvicted: 0 }, ask: { deleted: 4, scopeEvicted: 7 }, gap: false });
  assert.equal(c.visible_order_age_imbalance.support.snapshotTs, t0 + 290_000, 'the latest snapshot at or before the window end');
  assert.equal(c.order_age_quantiles.value.bid.p50Ms, t0 + 290_000 - (t0 - 30_000));
  assert.equal(c.depth_persistence.value.bid, Number((2 / 3).toFixed(8))); assert.equal(c.depth_persistence.value.ask, 1);
  assert.equal(c.replenishment_after_pressure.value.side, 'BID'); assert.equal(c.replenishment_after_pressure.value.ratio, 0.5 / 5);
  assert.equal(c.top_level_churn.value.bid, 1); assert.equal(c.queue_concentration.value.bid.orders, 2); assert.equal(c.queue_concentration.value.bid.largestShare, Number((2 / 3).toFixed(8)));
  // the future batch never leaks into the window (received after endTs) and a window past the as-of is refused
  assert.throws(() => l3Microstructure(all, { asOfTs: t0 + 300_000, startTs: t0, endTs: t0 + 400_000 }), /after the as-of/);
  assert.equal(l3Microstructure(all, { asOfTs: t0 + 400_000, startTs: t0 + 300_000, endTs: t0 + 400_000 }).components.new_order_impulse.value.bid, 50);
  // a coverage gap inside the window: PARTIAL, disappearance flagged as gap, pressure change PARTIAL
  const gapObs = covObs({ receivedTs: t0 + 150_000, state: 'GAP', reason: 'EPOCH_GAP' }); const g = l3Microstructure([...all, gapObs], w).components;
  assert.equal(g.new_order_impulse.support.state, 'PARTIAL'); assert.deepEqual(g.new_order_impulse.support.reasons, ['COVERAGE_GAP']); assert.equal(g.visible_liquidity_disappearance.value.gap, true);
  // an epoch change inside the window is an EPOCH_BREAK: ages never bridge it
  const e3 = eventsObs({ receivedTs: t0 + 250_000, events: [ev('ADD', 'N1', 'BID', 100, 1, null, t0 + 250_000, t0 + 250_000)], epochId: 'KRAKEN_SPOT:ws-l3:2' }); const eb = l3Microstructure([...all, e3], w).components; assert.ok(eb.new_order_impulse.support.reasons.includes('EPOCH_BREAK'));
  // an unsynchronized latest snapshot: age / concentration recipes are MISSING, never computed from a stale book
  const un = snapshotObs({ receivedTs: t0 + 295_000, bids: [], asks: [], synchronized: false }); const u = l3Microstructure([...all, un], w).components; assert.equal(u.visible_order_age_imbalance.support.state, 'MISSING'); assert.equal(u.queue_concentration.value, null);
  for (const id of Object.keys(c)) { assert.equal(c[id].family, 'L3_MICROSTRUCTURE'); assert.equal(EDGE_RECIPES[id].family, 'L3_MICROSTRUCTURE'); assert.ok(['COMPLETE', 'PARTIAL', 'MISSING'].includes(c[id].support.state)); }
});

test('PT-03. the capture runner: both senses under a policy that enables them, every dispatch through the accounting guard, one sealed EDGE_CAPTURE bundle (its own layout), reopened under the same contracts with dark kinds only; provisional / final buckets and L3 records land where declared; the status is IMPLEMENTED_DARK_NOT_EVALUATED with every authority NONE; a run with no dark sense enabled is refused; REPLAY mode never fetches', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/kraken-l3-checksum-snapshot.json', import.meta.url), 'utf8')).data[0];
  let t = T0; const clock = () => t; const bucket = (i) => Math.floor(T0 / IMS) * 300 - 300 * (2 - i);
  const analytics = (type) => { const ts = [bucket(0), bucket(1), bucket(2)]; const data = type === 'cvd' ? { buyVolume: ['1', '2', '3'], sellVolume: ['1', '1', '1'], cvd: ['0', '1', '2'] } : type === 'future-basis' ? { basis: ['0.1', '0.2', '0.3'] } : type === 'funding' ? { rate: [[1, 2, 0.5, 1.5], [1, 2, 0.5, 1.5], [1, 2, 0.5, 1.5]], relativeRate: [[0.01, 0.02, 0.005, 0.015], [0.01, 0.02, 0.005, 0.015], [0.01, 0.02, 0.005, 0.015]] } : ['100', '110', '120']; return { result: { timestamp: ts, data, more: false }, errors: [] }; };
  const fixture = await H.startHttpFixture({ 'GET /0/public/AssetPairs': { json: H.KRAKEN_ASSET_PAIRS }, 'GET /derivatives/api/v3/instruments': { json: H.KF_INSTRUMENTS }, '*': (req) => { const m = /^\/api\/charts\/v1\/analytics\/([^/]+)\/([^/]+)$/.exec(req.path); if (m) return { json: analytics(m[2]) }; if (req.path === '/0/private/GetApiKeyInfo') return { json: { error: [], result: { permissions: ['query-funds', 'create-ws-token'], validUntil: '0', nonceWindow: 0 } } }; if (req.path === '/0/private/GetWebSocketsToken') return { json: { error: [], result: { token: 'TOKEN-VALUE-XYZ', expires: 900 } } }; return { status: 404, json: { error: 'nope' } }; } });
  const raw = structuredClone(H.policyWith({ providers: ['KRAKEN_SPOT', 'KRAKEN_DERIVATIVES'] })); raw.providers.KRAKEN_DERIVATIVES.charts = { ...raw.providers.KRAKEN_DERIVATIVES.charts, enabled: true, intervalsS: [300] }; raw.providers.KRAKEN_SPOT.l3 = { ...raw.providers.KRAKEN_SPOT.l3, enabled: true, keyEnv: 'L3K', secretEnv: 'L3S', maxSymbols: 2 };
  const policy = loadPolicy(raw); const subjects = sampleSubjects(); const sw = createScriptedWebSocket({ ackSubscriptions: false });
  const root = mkdtempSync(path.join(tmpdir(), 'edge-root-')); const out = path.join(mkdtempSync(path.join(tmpdir(), 'edge-out-')), 'edge');
  const sleep = async () => { await new Promise((r) => setTimeout(r, 40)); const sock = sw.latest(); const subs = sock.sent.map((s) => JSON.parse(s)).filter((m) => m.method === 'subscribe'); assert.equal(subs.length, 1); assert.deepEqual(subs[0].params.symbol, ['BTC/USD', 'ETH/USD']); assert.equal(subs[0].params.depth, 10); for (const sym of subs[0].params.symbol) sock.deliver({ method: 'subscribe', success: true, result: { channel: 'level3', symbol: sym, depth: 10 } }); sock.deliver({ channel: 'level3', type: 'snapshot', data: [{ ...fx, symbol: 'BTC/USD' }] }); t += 1000; const b0 = fx.bids[0]; sock.deliver({ channel: 'level3', type: 'update', data: [{ symbol: 'BTC/USD', checksum: null, bids: [{ event: 'modify', order_id: b0.order_id, limit_price: b0.limit_price, order_qty: '0.5', timestamp: b0.timestamp }], asks: [] }] }); t += 20_000; };
  try {
    const env = { L3K: 'key-value', L3S: Buffer.from('s').toString('base64') };
    await assert.rejects(runEdgeCapture({ policy: loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT', 'KRAKEN_DERIVATIVES'] })), subjects, env, out, durationSeconds: 1, clock, fetchImpl: H.fetchFor(fixture), WebSocketImpl: sw.WebSocketImpl, researchRoot: root, sleep }), /no dark sense enabled/);
    await assert.rejects(runEdgeCapture({ policy: loadPolicy({ ...raw, mode: 'REPLAY_AS_OF' }), subjects, env, out, durationSeconds: 1, clock, fetchImpl: H.fetchFor(fixture), WebSocketImpl: sw.WebSocketImpl, researchRoot: root, sleep }), /replay never fetches/);
    assert.equal(fixture.requests.length, 0, 'a refused run dispatches nothing');
    const r = await runEdgeCapture({ policy, subjects, env, out, durationSeconds: 2, clock, fetchImpl: H.fetchFor(fixture), WebSocketImpl: sw.WebSocketImpl, researchRoot: root, sleep });
    assert.equal(r.ok, true, JSON.stringify(r.error)); assert.equal(r.status, EDGE_STATUS[0]); assert.equal(r.status, 'IMPLEMENTED_DARK_NOT_EVALUATED'); assert.equal(r.authority, 'NONE'); assert.equal(r.tradingAuthority, 'NONE'); assert.equal(r.judgeAuthority, 'NONE'); assert.equal(r.socratesConsumption, 'NONE');
    assert.equal(r.charts.failures, 0); assert.deepEqual(r.charts.symbols, ['PF_XBTUSD', 'PF_ETHUSD']); assert.equal(r.counters.analytics, 2 * 6 * 3); assert.equal(r.l3.verdict, 'SAFE_DATA_KEY'); assert.equal(r.l3.started, true); assert.deepEqual(r.l3.markets, ['BTC/USD', 'ETH/USD']); assert.equal(r.counters.snapshots >= 3, true); assert.equal(r.counters.events, 1);
    assert.ok(!JSON.stringify(r).includes('TOKEN-VALUE') && !JSON.stringify(r).includes('key-value'));
    // accounting: every REST dispatch (catalogs, charts, the two private reads) is admitted through the guard and settled in the journal
    assert.ok(r.accounting.KRAKEN_DERIVATIVES.requests >= 1 + 12); assert.ok(r.accounting.KRAKEN_SPOT.requests >= 3); assert.equal(r.accounting.KRAKEN_SPOT.refused, 0);
    const journal = readFileSync(path.join(root, 'accounting', 'quota.jsonl'), 'utf8'); assert.ok(journal.includes('"rest-private-key-info"') && journal.includes('"charts-analytics"')); assert.ok(!journal.includes('key-value') && !journal.includes('TOKEN-VALUE'));
    // reopen: the layout is EDGE_CAPTURE, every record re-validates, only dark kinds, provisional buckets carry their state
    const edge = readEdgeCapture(out); assert.equal(edge.bundle.kind, 'EDGE_CAPTURE'); assert.ok(edge.observations.every((o) => DARK_PAYLOAD_KINDS.includes(o.kind) && observationError(o) === null));
    const kinds = edge.observations.reduce((a, o) => { a[o.kind] = (a[o.kind] ?? 0) + 1; return a; }, {}); assert.equal(kinds.DERIVATIVE_ANALYTIC_BUCKET, 36); assert.equal(kinds.L3_BOOK_SNAPSHOT, 1); assert.equal(kinds.L3_ORDER_EVENT, 1); assert.ok(kinds.L3_BOOK_COVERAGE >= 3);
    const buckets = edge.observations.filter((o) => o.kind === 'DERIVATIVE_ANALYTIC_BUCKET'); assert.equal(buckets.filter((o) => o.payload.finality === 'PROVISIONAL').length, 12); assert.ok(buckets.every((o) => o.knownAtTs === o.receivedTs && o.payload.vintage === 'LIVE_FORWARD_CAPTURE'));
    assert.equal(edge.bundle.manifest.identity.status, 'IMPLEMENTED_DARK_NOT_EVALUATED'); assert.equal(edge.bundle.manifest.identity.authority, 'NONE'); assert.equal(edge.bundle.manifest.summary.l3.verdict, 'SAFE_DATA_KEY'); assert.ok(!JSON.stringify(edge.bundle.manifest).includes('TOKEN-VALUE'));
    assert.ok(!readFileSync(path.join(out, 'policy.json'), 'utf8').includes('key-value'), 'the sealed policy carries NAMES only');
    assert.throws(() => openBundle(out, 'CAPTURE'), /layout/, 'a dark bundle never opens as a decision capture');
    const spot = edge.observations.filter((o) => o.kind === 'L3_ORDER_EVENT')[0]; assert.deepEqual(spot.payload.events.map((e) => e.event), ['MODIFY']); assert.equal(spot.payload.events[0].previousQty, 0.88968699);
  } finally { await fixture.close(); }
});
