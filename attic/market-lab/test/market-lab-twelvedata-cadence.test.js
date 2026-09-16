// Twelve Data's cadence is provider-specific: slower cross-asset polling must not slow the faster venue chart/flow lanes.
// Cache hits preserve the original receipt/knowledge clocks so a 15-minute refresh fence never pretends old data is new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchOwner } from '../market-lab/owner.js';
import { loadPolicy, samplePolicy, sampleSubjects } from '../market-lab/policy.js';
import { TWELVEDATA_BAR_REFRESH_MS } from '../market-lab/providers/twelvedata.js';
import * as H from './helpers/market-lab.js';

const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-09-08T12:00:00Z');

function twelveDataPolicy() {
  const p = structuredClone(samplePolicy()); const td = p.providers.TWELVEDATA;
  td.enabled = true;
  td.plan = { name: 'Basic 8 fixture', billing: 'FREE', includedCallsPerMonth: null, remainingCalls: null, incrementalUsdPerCall: 0, attestation: 'fixture free plan', verifiedDate: '2026-09-08', quoteUsdPerMonth: 0 };
  td.limits = { maxCallsPerDay: 600, maxCallsPerMonth: 18_000, maxConcurrency: 1 };
  td.permittedEndpoints = ['symbol-search', 'quote', 'time-series'];
  return loadPolicy(p);
}

test('Twelve Data cross-asset polling is quota-safe for the five paper proxies and cached rows keep their original clocks until the 15-minute provider refresh', async () => {
  const subjects = sampleSubjects(); const clock = H.clockAt(T0);
  const fixture = await H.startHttpFixture({
    'GET /symbol_search': (req) => ({ json: { status: 'ok', data: [{ symbol: req.query.symbol, instrument_name: `${req.query.symbol} fixture`, exchange: 'TEST', mic_code: 'TEST', instrument_type: req.query.symbol.includes('/') ? 'Forex' : 'ETF', currency: 'USD' }] } }),
    'GET /time_series': (req) => ({ json: { status: 'ok', meta: { symbol: req.query.symbol, interval: '1h', currency: 'USD', exchange: 'TEST', type: req.query.symbol.includes('/') ? 'Forex' : 'ETF' }, values: [{ datetime: '2026-09-08 10:00:00', open: '100', high: '102', low: '99', close: '101', volume: '10' }] } }),
  });
  const owner = createResearchOwner({ policy: twelveDataPolicy(), subjects, env: { TWELVEDATA_API_KEY: 'TDKEY' }, mode: 'INTEGRATED', clock, fetchImpl: H.fetchFor(fixture), log: () => {} });
  try {
    await owner.start({ families: ['CROSS_ASSET'] });
    const pathCount = (pathname) => fixture.requests.filter((r) => r.path === pathname).length;
    assert.equal(pathCount('/symbol_search'), subjects.crossAsset.length);
    assert.equal(pathCount('/time_series'), subjects.crossAsset.length);

    clock.advance(TWELVEDATA_BAR_REFRESH_MS - 1);
    const cached = await owner.acquire('CROSS_ASSET', 'BTC');
    assert.equal(pathCount('/time_series'), subjects.crossAsset.length, 'the provider is not repolled before its own cadence');
    assert.ok(cached.results.filter((r) => r.endpointId === 'time-series').every((r) => r.state === 'CACHED'));
    assert.ok(cached.observations.length > 0 && cached.observations.every((o) => o.receivedTs === T0 && o.knownAtTs === T0), 'cache hits keep source receipt/knowledge time; they are never restamped as fresh');

    clock.advance(1);
    const refreshed = await owner.acquire('CROSS_ASSET', 'BTC');
    assert.equal(pathCount('/time_series'), subjects.crossAsset.length * 2);
    assert.ok(refreshed.results.filter((r) => r.endpointId === 'time-series').every((r) => r.state === 'OK'));
    assert.ok(refreshed.observations.length > 0 && refreshed.observations.every((o) => o.receivedTs === clock() && o.knownAtTs === clock()), 'a new clock appears only after a real provider response');
    assert.ok(owner.observations().filter((o) => o.provider === 'TWELVEDATA').every((o) => o.receivedTs === T0 && o.knownAtTs === T0), 'an identical refetch is semantically deduplicated instead of restamping retained evidence as newer');

    const maximumDailyCalls = subjects.crossAsset.length + subjects.crossAsset.length * Math.ceil(DAY_MS / TWELVEDATA_BAR_REFRESH_MS);
    assert.equal(maximumDailyCalls, 485, 'five daily resolutions plus 96 five-symbol bar polls');
    assert.ok(maximumDailyCalls <= twelveDataPolicy().providers.TWELVEDATA.limits.maxCallsPerDay);
  } finally {
    await owner.stop({ seal: false });
    await fixture.close();
  }
});
