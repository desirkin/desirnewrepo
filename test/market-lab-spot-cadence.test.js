import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchOwner, SPOT_REST_CADENCE, spotRestCallPlan } from '../market-lab/owner.js';
import { loadPolicy, loadSubjects, sampleSubjects } from '../market-lab/policy.js';
import * as H from './helpers/market-lab.js';

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const products = [...H.COINBASE_PRODUCTS];

function controlledTimers() {
  const intervals = [];
  return {
    intervals,
    setInterval(fn, ms) { const handle = { fn, ms, cleared: false, unref() {} }; intervals.push(handle); return handle; },
    clearInterval(handle) { if (handle) handle.cleared = true; },
    setTimeout,
    clearTimeout,
  };
}

test('spot REST cadence preserves one-minute candle/volume priority without exceeding shipped daily or monthly caps', async () => {
  const plan = spotRestCallPlan({ subjectCount: 3 });
  assert.deepEqual(plan.KRAKEN_SPOT, { callsPerDay: 586, callsPerMonth: 18166, catalogStartsPerDay: 1, chartCallsPerDay: 549, flowCallsPerDay: 36, daysInMonth: 31 });
  assert.deepEqual(plan.COINBASE_SPOT, { callsPerDay: 577, callsPerMonth: 17887, catalogStartsPerDay: 1, chartCallsPerDay: 288, flowCallsPerDay: 288, daysInMonth: 31 });
  assert.ok(plan.KRAKEN_SPOT.callsPerDay <= 1000 && plan.KRAKEN_SPOT.callsPerMonth <= 20000);
  assert.ok(plan.COINBASE_SPOT.callsPerDay <= 1000 && plan.COINBASE_SPOT.callsPerMonth <= 20000);
  assert.equal(SPOT_REST_CADENCE.KRAKEN_SPOT.SPOT_PRICE_CHART.intervalRefreshMs[1], 10 * 60_000);
  assert.equal(SPOT_REST_CADENCE.KRAKEN_SPOT.SPOT_FLOW.primary, 'ws-v2');
  assert.equal(SPOT_REST_CADENCE.COINBASE_SPOT.SPOT_FLOW.primary, 'ws-feed');
});

test('spot family cache clocks enforce the published effective cadence and never restamp cached observations', async () => {
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'] }));
  const rawSubjects = structuredClone(sampleSubjects());
  rawSubjects.subjects = [rawSubjects.subjects[0]];
  rawSubjects.macroSeries = []; rawSubjects.stablecoins = []; rawSubjects.peers = []; rawSubjects.benchmarks = ['BTC'];
  const subjects = loadSubjects(rawSubjects); const clock = H.clockAt(H.T0); const timers = controlledTimers(); const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input); calls.push({ host: url.host, path: url.pathname, interval: url.searchParams.get('interval'), ts: clock() });
    if (url.pathname === '/0/public/AssetPairs') return json(H.KRAKEN_ASSET_PAIRS);
    if (url.pathname === '/products') return json(products);
    if (url.pathname === '/0/public/OHLC') return json(H.krakenOhlc(url.searchParams.get('pair'), { intervalMin: Number(url.searchParams.get('interval')), endTs: clock() }));
    if (url.pathname === '/0/public/Trades') return json(H.krakenTrades(url.searchParams.get('pair'), { endTs: clock() }));
    if (/\/candles$/.test(url.pathname)) return json([[Math.floor((clock() - 7_200_000) / 1000), 99, 102, 100, 101, 12], [Math.floor((clock() - 3_600_000) / 1000), 100, 103, 101, 102, 13]]);
    if (/\/trades$/.test(url.pathname)) return json(H.coinbaseTrades({ endTs: clock() }));
    return new Response('{"error":"fixture route missing"}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const owner = createResearchOwner({ policy, subjects, mode: 'INTEGRATED', clock, fetchImpl, timers, log: () => {} });
  const count = (host, path, interval = undefined) => calls.filter((c) => c.host === host && c.path === path && (interval === undefined || c.interval === String(interval))).length;
  try {
    await owner.start({ families: [] });
    const firstChart = await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    await owner.acquire('SPOT_FLOW', 'BTC');
    const firstKnownAt = firstChart.observations[0].knownAtTs;
    assert.deepEqual({ ohlc: count('api.kraken.com', '/0/public/OHLC'), kt: count('api.kraken.com', '/0/public/Trades'), candles: count('api.exchange.coinbase.com', '/products/BTC-USD/candles'), ct: count('api.exchange.coinbase.com', '/products/BTC-USD/trades') }, { ohlc: 6, kt: 1, candles: 1, ct: 1 });

    clock.advance(5 * 60_000);
    const cachedChart = await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    await owner.acquire('SPOT_FLOW', 'BTC');
    assert.ok(cachedChart.results.every((r) => r.state === 'CACHED'));
    assert.equal(cachedChart.observations[0].knownAtTs, firstKnownAt, 'cache hits retain the provider receipt clock');
    assert.deepEqual({ ohlc: count('api.kraken.com', '/0/public/OHLC'), kt: count('api.kraken.com', '/0/public/Trades'), candles: count('api.exchange.coinbase.com', '/products/BTC-USD/candles'), ct: count('api.exchange.coinbase.com', '/products/BTC-USD/trades') }, { ohlc: 6, kt: 1, candles: 1, ct: 1 });

    clock.advance(5 * 60_000);
    const tenMinute = await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    await owner.acquire('SPOT_FLOW', 'BTC');
    assert.equal(tenMinute.results.filter((r) => r.providerId === 'KRAKEN_SPOT' && r.state === 'OK').length, 1, 'only the prioritized 1m Kraken interval refreshes at ten minutes');
    assert.equal(count('api.kraken.com', '/0/public/OHLC', 1), 2);
    assert.equal(count('api.kraken.com', '/0/public/OHLC', 5), 1);

    clock.advance(5 * 60_000);
    await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    await owner.acquire('SPOT_FLOW', 'BTC');
    assert.equal(count('api.exchange.coinbase.com', '/products/BTC-USD/candles'), 2, 'Coinbase candles refresh at 15m');
    assert.equal(count('api.exchange.coinbase.com', '/products/BTC-USD/trades'), 2, 'Coinbase REST flow refreshes at 15m');
    assert.equal(count('api.kraken.com', '/0/public/Trades'), 1, 'Kraken REST flow is a 2h recovery sample; WS remains primary');

    clock.set(H.T0 + 60 * 60_000);
    await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    assert.equal(count('api.kraken.com', '/0/public/OHLC', 1), 3);
    assert.equal(count('api.kraken.com', '/0/public/OHLC', 5), 2, '5m native bars refresh hourly under the cap');
    assert.equal(count('api.kraken.com', '/0/public/OHLC', 15), 1, '15m native bars keep their published 3h wire cadence');
    assert.equal(owner.status().cadence.stableProcessPlan.KRAKEN_SPOT.callsPerDay, 196, 'status plan reflects this one-subject owner');
    assert.equal(owner.status().cadence.providers.COINBASE_SPOT.SPOT_PRICE_CHART.refreshMs, 15 * 60_000);
  } finally {
    await owner.stop({ seal: false });
  }
});

test('a malformed provider response is cadence-gated too, so failures cannot restore five-minute request flooding', async () => {
  const policy = loadPolicy(H.policyWith({ providers: ['KRAKEN_SPOT', 'COINBASE_SPOT'] }));
  const rawSubjects = structuredClone(sampleSubjects()); rawSubjects.subjects = [rawSubjects.subjects[0]]; rawSubjects.macroSeries = []; rawSubjects.stablecoins = []; rawSubjects.peers = []; rawSubjects.benchmarks = ['BTC'];
  const subjects = loadSubjects(rawSubjects); const clock = H.clockAt(H.T0); const timers = controlledTimers(); let ohlcCalls = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/0/public/AssetPairs') return json(H.KRAKEN_ASSET_PAIRS);
    if (url.pathname === '/products') return json(products);
    if (url.pathname === '/0/public/OHLC') { ohlcCalls += 1; return json({ error: [], result: {} }); }
    if (/\/candles$/.test(url.pathname)) return json([]);
    return json([]);
  };
  const owner = createResearchOwner({ policy, subjects, mode: 'INTEGRATED', clock, fetchImpl, timers, log: () => {} });
  try {
    await owner.start({ families: [] });
    await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    assert.equal(ohlcCalls, 6);
    clock.advance(5 * 60_000);
    const skipped = await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    assert.equal(ohlcCalls, 6);
    assert.equal(skipped.results.filter((r) => r.providerId === 'KRAKEN_SPOT' && r.state === 'CADENCE_SKIPPED').length, 6);
    clock.advance(5 * 60_000);
    await owner.acquire('SPOT_PRICE_CHART', 'BTC');
    assert.equal(ohlcCalls, 7, 'at ten minutes only the 1m interval retries');
    assert.ok(owner.status().counters.cadenceSkips >= 6);
  } finally { await owner.stop({ seal: false }); }
});
