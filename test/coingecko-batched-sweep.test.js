import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { createResearchOwner } from '../market-lab/owner.js';
import { loadPolicy, loadSubjects } from '../market-lab/policy.js';
import { subjectId } from '../market-lab/contracts.js';
import * as H from './helpers/market-lab.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const timers = { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout, clearTimeout };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'coingecko-batch-'));

function policy() {
  const raw = H.policyWith({ providers: ['COINGECKO'] });
  raw.providers.COINGECKO.plan = {
    name: 'Demo', billing: 'INCLUDED_QUOTA', includedCallsPerMonth: 10_000,
    remainingCalls: 2, incrementalUsdPerCall: 0, attestation: 'offline fixture',
    verifiedDate: '2026-09-13', quoteUsdPerMonth: 0,
  };
  raw.providers.COINGECKO.limits = { maxCallsPerDay: 2, maxCallsPerMonth: 2, maxConcurrency: 1 };
  raw.providers.COINGECKO.permittedEndpoints = ['coins-list', 'coins-markets'];
  raw.providers.COINGECKO.smoke = { authorized: true, maxCalls: 2, maxEstimatedUsd: 0 };
  return loadPolicy(raw);
}

const subjects = () => loadSubjects(H.subjectsWith());
const marketRows = () => [
  { ...H.coingeckoMarkets()[0], last_updated: new Date(H.T0 - 60_000).toISOString() },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 4_200, market_cap: 5e11, fully_diluted_valuation: 5.1e11, total_volume: 2e10, circulating_supply: 120_000_000, total_supply: 120_000_000, max_supply: null, last_updated: new Date(H.T0 - 60_000).toISOString() },
  { id: 'solana', symbol: 'sol', name: 'Solana', current_price: 220, market_cap: 1.2e11, fully_diluted_valuation: 1.3e11, total_volume: 7e9, circulating_supply: 550_000_000, total_supply: 600_000_000, max_supply: null, last_updated: new Date(H.T0 - 60_000).toISOString() },
];

function fetchFixture(requests, { marketStatus = 200 } = {}) {
  return async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname === '/api/v3/coins/list') return json(H.COINGECKO_LIST);
    if (url.pathname === '/api/v3/coins/markets') return marketStatus === 200 ? json(marketRows()) : json({ error: 'fixture failure' }, marketStatus);
    throw new Error(`unexpected wire attempt: ${url.pathname}`);
  };
}

test('scheduled SUPPLY_UNLOCKS sweep batches every resolved CoinGecko asset into its one remaining admitted call', async () => {
  const root = tmp(); const requests = [];
  const owner = createResearchOwner({ policy: policy(), subjects: subjects(), env: { COINGECKO_DEMO_API_KEY: 'offline-fixture' }, researchRoot: root, mode: 'INTEGRATED', clock: () => H.T0, fetchImpl: fetchFixture(requests), timers });
  try {
    await owner.start({ families: ['SUPPLY_UNLOCKS'], awaitInitialSweep: true });
    const marketRequests = requests.filter((u) => u.pathname === '/api/v3/coins/markets');
    assert.equal(requests.filter((u) => u.pathname === '/api/v3/coins/list').length, 1);
    assert.equal(marketRequests.length, 1, 'catalog plus one batched market request consumes the exact two-call allowance');
    assert.deepEqual(marketRequests[0].searchParams.get('ids').split(','), ['bitcoin', 'ethereum', 'solana']);
    assert.equal(marketRequests[0].searchParams.get('per_page'), '3');
    const observations = owner.observations().filter((o) => o.provider === 'COINGECKO' && o.endpointId === 'coins-markets');
    assert.deepEqual(observations.map((o) => o.subject.canonicalCoin).sort(), ['BTC', 'ETH', 'SOL']);
    assert.deepEqual(observations.map((o) => o.sourceKey).sort(), ['bitcoin', 'ethereum', 'solana']);
    assert.equal(new Set(observations.map((o) => o.observationId)).size, 3, 'each asset keeps a distinct evidence identity');
    assert.equal(owner.journal.totals('COINGECKO').calls.day, 2);
  } finally { await owner.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});

test('a failed batched response records provider failure coverage separately for every requested asset', async () => {
  const root = tmp(); const requests = [];
  const owner = createResearchOwner({ policy: policy(), subjects: subjects(), env: { COINGECKO_DEMO_API_KEY: 'offline-fixture' }, researchRoot: root, mode: 'INTEGRATED', clock: () => H.T0, fetchImpl: fetchFixture(requests, { marketStatus: 503 }), timers });
  try {
    await owner.start({ families: ['SUPPLY_UNLOCKS'], awaitInitialSweep: true });
    assert.equal(requests.filter((u) => u.pathname === '/api/v3/coins/markets').length, 1);
    const coverage = owner.coverage().filter((c) => c.provider === 'COINGECKO' && c.endpointId === 'coins-markets');
    assert.deepEqual(coverage.map((c) => c.subjectId).sort(), [
      ['BTC', 'bitcoin'], ['ETH', 'ethereum'], ['SOL', 'solana'],
    ].map(([canonicalCoin, providerAssetId]) => subjectId({ subjectKind: 'ASSET', canonicalCoin, providerAssetId })).sort());
    assert.ok(coverage.every((c) => c.observationCount === 0 && c.state === 'FAILED'));
  } finally { await owner.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});

test('explicit owner.acquire retains its existing single-subject CoinGecko request behavior', async () => {
  const root = tmp(); const requests = [];
  const owner = createResearchOwner({ policy: policy(), subjects: subjects(), env: { COINGECKO_DEMO_API_KEY: 'offline-fixture' }, researchRoot: root, mode: 'INTEGRATED', clock: () => H.T0, fetchImpl: fetchFixture(requests), timers });
  try {
    await owner.start({ families: [], awaitInitialSweep: true });
    const result = await owner.acquire('SUPPLY_UNLOCKS', 'ETH');
    const marketRequests = requests.filter((u) => u.pathname === '/api/v3/coins/markets');
    assert.equal(marketRequests.length, 1);
    assert.equal(marketRequests[0].searchParams.get('ids'), 'ethereum');
    assert.deepEqual(result.observations.map((o) => o.subject.canonicalCoin), ['ETH']);
  } finally { await owner.stop({ seal: false }); rmSync(root, { recursive: true, force: true }); }
});
