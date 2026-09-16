import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DATA_ONLY_MARKET_FAMILIES,
  buildDataOnlyMarketPolicy,
  loadDataOnlyMarketSubjects,
  startDataOnlyMarket,
} from '../tools/data-only-market.mjs';
import * as H from './helpers/market-lab.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(REPO, 'tools', 'data-only-market.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'data-only-market-'));
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function importsOf(file, seen = new Set()) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) return seen;
  seen.add(absolute);
  const source = readFileSync(absolute, 'utf8');
  const specs = [...source.matchAll(/(?:from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)].map((m) => m[2]);
  for (const spec of specs) {
    let next = path.resolve(path.dirname(absolute), spec);
    if (!path.extname(next)) next += '.js';
    importsOf(next, seen);
  }
  return seen;
}

test('data-only market policy is a zero-spend observation allowlist and missing keys block only their own sources', () => {
  const withoutKeys = buildDataOnlyMarketPolicy({ env: {} });
  assert.deepEqual(Object.entries(withoutKeys.providers).filter(([, p]) => p.enabled).map(([id]) => id), ['KRAKEN_SPOT', 'COINBASE_SPOT', 'GECKOTERMINAL', 'DEFILLAMA', 'COINMETRICS']);
  assert.equal(withoutKeys.providers.FRED.enabled, false);
  assert.equal(withoutKeys.providers.COINGECKO.enabled, false);
  assert.equal(withoutKeys.providers.KRAKEN_SPOT.enabled, true, 'a missing unrelated key cannot disable public spot');

  const withKeys = buildDataOnlyMarketPolicy({ env: { FRED_API_KEY: 'fixture', COINGECKO_DEMO_API_KEY: 'fixture', COINGLASS_API_KEY: 'must-not-enable', KRAKEN_L3_DATA_API_KEY: 'must-not-enable' } });
  for (const id of ['FRED', 'COINGECKO']) assert.equal(withKeys.providers[id].enabled, true, id);
  for (const id of ['KRAKEN_DERIVATIVES', 'DERIBIT', 'BYBIT', 'COINGLASS', 'CRYPTOQUANT', 'SANTIMENT', 'TOKENOMIST']) assert.equal(withKeys.providers[id].enabled, false, id);
  assert.equal(withKeys.providers.KRAKEN_SPOT.l3.enabled, false);
  assert.equal(withKeys.providers.KRAKEN_DERIVATIVES.charts.enabled, false);
  assert.deepEqual({ enabled: withKeys.model.enabled, perCase: withKeys.model.maxEstimatedUsdPerCase, day: withKeys.model.maxEstimatedUsdPerDay, month: withKeys.model.maxEstimatedUsdPerMonth }, { enabled: false, perCase: 0, day: 0, month: 0 });
  assert.deepEqual(loadDataOnlyMarketSubjects().subjects.map((s) => s.canonicalCoin), ['BTC', 'ETH', 'SOL']);
  assert.ok(DATA_ONLY_MARKET_FAMILIES.includes('SPOT_PRICE_CHART') && DATA_ONLY_MARKET_FAMILIES.includes('SPOT_FLOW'));
});

test('fake provider transport starts scoped spot capture, publishes honest cap pressure, and stops without orders', async () => {
  const root = tmp(); const calls = []; let handle = null;
  const products = [...H.COINBASE_PRODUCTS, { id: 'SOL-USD', base_currency: 'SOL', quote_currency: 'USD', status: 'online', trading_disabled: false, quote_increment: '0.01', base_increment: '0.00000001' }];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); calls.push({ host: url.host, path: url.pathname, method: init.method ?? 'GET' });
    if (url.pathname === '/0/public/AssetPairs') return json(H.KRAKEN_ASSET_PAIRS);
    if (url.pathname === '/products') return json(products);
    if (url.pathname === '/0/public/OHLC') return json(H.krakenOhlc(url.searchParams.get('pair'), { intervalMin: Number(url.searchParams.get('interval')), endTs: H.T0 }));
    if (url.pathname === '/0/public/Trades') return json(H.krakenTrades(url.searchParams.get('pair'), { endTs: H.T0 }));
    if (/\/products\/[^/]+\/candles$/.test(url.pathname)) return json([[Math.floor((H.T0 - 7_200_000) / 1000), 99, 102, 100, 101, 12], [Math.floor((H.T0 - 3_600_000) / 1000), 100, 103, 101, 102, 13]]);
    if (/\/products\/[^/]+\/trades$/.test(url.pathname)) return json(H.coinbaseTrades({ endTs: H.T0 }));
    return new Response('{"error":"unhandled fixture route"}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  try {
    handle = await startDataOnlyMarket({ researchRoot: root, env: {}, fetchImpl, ownerMode: 'INTEGRATED', clock: () => H.T0, families: ['SPOT_PRICE_CHART', 'SPOT_FLOW'], log: () => {} });
    assert.equal(handle.status().state, 'ACTIVE');
    await H.waitFor(() => handle.status().bootstrap.initialState === 'COMPLETE');
    const status = handle.status();
    assert.deepEqual(status.scope.subjects, ['BTC', 'ETH', 'SOL']);
    assert.equal(status.scope.allAssetCoverageClaim, false);
    assert.equal(status.safety.orders, false);
    assert.equal(status.safety.modelEnabled, false);
    assert.deepEqual(status.persistence.processRestartSameFilesystem, { captures: true, quotaJournal: true, cadenceCache: false });
    assert.equal(status.persistence.replitRepublish, 'NOT_GUARANTEED');
    assert.equal(status.sources.KRAKEN_SPOT.state, 'OBSERVED');
    assert.equal(status.sources.COINBASE_SPOT.state, 'OBSERVED');
    assert.equal(status.sources.FRED.state, 'BLOCKED_CREDENTIAL');
    assert.equal(status.sources.KRAKEN_DERIVATIVES.state, 'RESTRICTED_OFF');
    assert.equal(status.sources.COINGLASS.state, 'DISABLED_ZERO_BUDGET');
    assert.deepEqual(status.streams, {}, 'the data-only status exposes the owner stream state (integrated fixture opens none)');
    assert.equal(status.quotaAudit.state, 'WITHIN_DECLARED_CAPS');
    assert.deepEqual(status.quotaAudit.rows.KRAKEN_SPOT, { callsPerDay: 586, callsPerMonth: 18166, configuredDailyCap: 1000, configuredMonthlyCap: 20000, state: 'WITHIN_CAP' });
    assert.deepEqual(status.quotaAudit.rows.COINBASE_SPOT, { callsPerDay: 577, callsPerMonth: 17887, configuredDailyCap: 1000, configuredMonthlyCap: 20000, state: 'WITHIN_CAP' });
    assert.ok(status.counters.observations > 0);
    assert.deepEqual([...new Set(calls.map((c) => c.host))].sort(), ['api.exchange.coinbase.com', 'api.kraken.com']);
    assert.ok(calls.every((c) => c.method === 'GET'));
    await handle.stop({ seal: false });
    assert.equal(handle.status().state, 'STOPPED');
  } finally {
    if (handle?.status().running) await handle.stop({ seal: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test('status exposes a durable CoinGecko policy block that occurs before the client can issue a request', async () => {
  const root = tmp(); let handle = null; let wires = 0;
  const policyRaw = JSON.parse(readFileSync(path.join(REPO, 'config', 'market-research.paper.json'), 'utf8'));
  for (const [id, provider] of Object.entries(policyRaw.providers)) provider.enabled = id === 'COINGECKO';
  const zero = () => ({ calls: { day: 0, month: 0 }, credits: { day: 0, month: 0 }, usd: { day: 0, month: 0 }, reserved: 0, settled: 0, unresolved: 0, released: 0, smoke: { calls: 0, usd: 0 }, dispatched: 0 });
  const quotaJournal = {
    durable: true,
    failed: () => null,
    isClosed: () => false,
    totals: (id) => id === 'COINGECKO' ? { ...zero(), calls: { day: 0, month: 2 }, credits: { day: 0, month: 2 }, settled: 2, dispatched: 2 } : zero(),
    entitlementRemaining: (id) => id === 'COINGECKO' ? 0 : null,
    loadPlan: async () => { throw new Error('precheck must block before plan loading'); },
    reserve: async () => { throw new Error('precheck must block before reservation'); },
    settle: async () => { throw new Error('no reservation exists'); },
    unresolved: async () => { throw new Error('no reservation exists'); },
    release: async () => { throw new Error('no reservation exists'); },
    drained: async () => {},
  };
  try {
    handle = await startDataOnlyMarket({
      env: { COINGECKO_DEMO_API_KEY: 'fixture' }, policyRaw, dataDir: root,
      families: ['SUPPLY_UNLOCKS'], ownerMode: 'INTEGRATED', quotaJournal,
      fetchImpl: async () => { wires += 1; throw new Error('no provider request expected'); },
      clock: () => H.T0, log: () => {},
    });
    const source = handle.status().sources.COINGECKO;
    assert.equal(source.desired, 'ON');
    assert.equal(source.state, 'POLICY_BLOCKED');
    assert.equal(source.requests, 0);
    assert.equal(source.callsToday, 0);
    assert.equal(source.callsMonth, 2);
    assert.equal(source.monthlyCap, 2);
    assert.equal(source.entitlementRemaining, 0);
    assert.deepEqual(source.policyBlockReasons, ['MONTH_CAP', 'ENTITLEMENT_EXHAUSTED']);
    assert.equal(source.policyRefusals, null, 'the catalog precheck itself does not increment dispatch-refusal counters');
    assert.deepEqual(source.catalogResolution, { state: 'PROVIDER_DISABLED', count: null, knownAtTs: null });
    assert.equal(wires, 0);
  } finally {
    if (handle) await handle.stop({ seal: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a historical policy refusal remains diagnosed but does not mask a later successful observation', async () => {
  const root = tmp(); let handle = null; const intervals = []; const reservations = new Map();
  const clock = H.clockAt(H.T0); let planLoads = 0; let calls = 0; let nextReservation = 0;
  const policyRaw = JSON.parse(readFileSync(path.join(REPO, 'config', 'market-research.paper.json'), 'utf8'));
  for (const [id, provider] of Object.entries(policyRaw.providers)) provider.enabled = id === 'COINGECKO';
  Object.assign(policyRaw.providers.COINGECKO.plan, { includedCallsPerMonth: 10, remainingCalls: 10, attestation: 'offline recovery fixture' });
  Object.assign(policyRaw.providers.COINGECKO.limits, { maxCallsPerDay: 10, maxCallsPerMonth: 10 });
  const totals = () => ({ calls: { day: calls, month: calls }, credits: { day: calls, month: calls }, usd: { day: 0, month: 0 }, reserved: 0, settled: calls, unresolved: 0, released: 0, smoke: { calls: 0, usd: 0 }, dispatched: calls });
  const quotaJournal = {
    durable: true,
    failed: () => null,
    isClosed: () => false,
    totals: () => totals(),
    entitlementRemaining: (id) => id === 'COINGECKO' ? 10 - calls : null,
    loadPlan: async () => { planLoads += 1; return planLoads === 2 ? { ok: false, reason: 'PLAN_CONFLICT' } : { ok: true, fresh: planLoads === 1 }; },
    reserve: async (record) => { calls += 1; const id = `r-${++nextReservation}`; reservations.set(id, record); return id; },
    settle: async (id) => { assert.ok(reservations.has(id)); },
    unresolved: async (id) => { assert.ok(reservations.has(id)); },
    release: async (id) => { assert.ok(reservations.has(id)); },
    drained: async () => {},
  };
  const timers = {
    setInterval: (fn, ms) => { const timer = { fn, ms, unref() {} }; intervals.push(timer); return timer; },
    clearInterval() {}, setTimeout, clearTimeout,
  };
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v3/coins/list') return json(H.COINGECKO_LIST);
    if (url.pathname === '/api/v3/coins/markets') return json(H.coingeckoMarkets().map((row) => ({ ...row, last_updated: new Date(clock() - 60_000).toISOString() })));
    throw new Error(`unexpected provider request ${url.pathname}`);
  };
  try {
    handle = await startDataOnlyMarket({ env: { COINGECKO_DEMO_API_KEY: 'fixture' }, policyRaw, dataDir: root, families: ['SUPPLY_UNLOCKS'], ownerMode: 'INTEGRATED', quotaJournal, fetchImpl, clock, timers, log: () => {} });
    await H.waitFor(() => handle.status().bootstrap.initialState === 'COMPLETE');
    const refused = handle.status().sources.COINGECKO;
    assert.equal(refused.state, 'POLICY_BLOCKED');
    assert.deepEqual(refused.policyBlockReasons, ['PLAN_CONFLICT']);
    assert.equal(refused.policyRefusals.count, 1);

    clock.advance(1000);
    intervals.find((timer) => timer.ms === 300_000).fn();
    await H.waitFor(() => handle.status().bootstrap.runsCompleted === 2);
    const recovered = handle.status().sources.COINGECKO;
    assert.equal(recovered.state, 'OBSERVED', 'a later successful provider receipt owns the live source state');
    assert.equal(recovered.succeeded, 2, 'catalog and recovered market request both succeeded');
    assert.deepEqual(recovered.policyBlockReasons, []);
    assert.equal(recovered.policyRefusals.count, 1, 'the historical refusal remains visible for audit');
    assert.deepEqual(recovered.policyRefusals.lastReasons, ['PLAN_CONFLICT']);
  } finally {
    if (handle) await handle.stop({ seal: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test('data-only market import graph has no trading, model, Judge, Watch, Paper, or Tape composition', () => {
  const graph = [...importsOf(entry)];
  const forbidden = ['paper', 'judge', 'execution', 'watch', 'socrates', 'ledger', 'state'];
  for (const file of graph) {
    const relative = path.relative(REPO, file).replace(/\\/g, '/');
    for (const dir of forbidden) assert.equal(relative === `${dir}.js` || relative.startsWith(`${dir}/`), false, `forbidden data-only market dependency: ${relative}`);
    if (relative.startsWith('tape/')) assert.equal(relative, 'tape/book.js', `only the pure order-book data structure is allowed from tape/: ${relative}`);
  }
  const direct = readFileSync(entry, 'utf8');
  assert.doesNotMatch(direct, /createResearchService|enqueueCase|ANTHROPIC_API_KEY/);
  assert.match(direct, /createResearchOwner/);
});
