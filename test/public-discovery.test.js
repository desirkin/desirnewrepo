import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { DISCOVERY_SOURCES, discoveryRegistryError } from '../discovery/registry.js';
import { discoveryCatalogContext, gdeltCatalogQuery } from '../discovery/query.js';
import { mapGdeltArticles, mapPolymarketMarkets, mapKalshiMarkets, discoveryObservationError } from '../discovery/parse.js';
import { startPublicDiscovery, discoverySelectedIds } from '../discovery/collector.js';
import { emptyDiscoveryCheckpoint, loadDiscoveryCheckpoint, validateDiscoveryCheckpoint } from '../discovery/external-checkpoint.js';
import { readDiscoveryObservations, readDiscoveryReceipts, readDiscoveryStatus } from '../discovery/reader.js';

const T0 = Date.parse('2026-09-12T20:00:00Z');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'public-discovery-'));
const timers = { setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} };
function snapshot(bases = ['ADA', 'ALGO', 'AVAX', 'BTC', 'DOGE', 'DOT', 'ETH', 'LINK', 'SOL', 'XRP']) {
  const pairs = {};
  for (const base of bases) pairs[`${base}USD`] = { base: `X${base}`, quote: 'ZUSD', wsname: `${base}/USD`, status: 'online' };
  const normalized = normalizeKrakenAssetPairs(pairs, { observedTs: T0 - 1000 });
  assert.equal(normalized.ok, true);
  return { status: 'ACCEPTED', fresh: true, catalog: normalized.catalog };
}
const context = discoveryCatalogContext(snapshot(), { nowTs: T0 });
function memoryDurable(now = T0, events = []) {
  let state = emptyDiscoveryCheckpoint({ now }); let revision = 1; let failure = null;
  return {
    snapshot: () => structuredClone(state), revision: () => revision, failed: () => failure,
    update: async (reducer, meta) => { events.push(meta?.phase ?? 'UPDATE'); state = reducer(structuredClone(state)); revision += 1; return structuredClone(state); },
    fail: (code = 'TEST_FAILURE') => { failure = { code }; },
  };
}

test('public registry and fair GDELT planner use the entire eligible catalog without a named seed or unequal frequency', () => {
  assert.equal(discoveryRegistryError(), null); assert.equal(DISCOVERY_SOURCES.length, 3);
  assert.deepEqual(discoverySelectedIds({ DISCOVERY_SOURCES: 'GDELT_NEWS_DISCOVERY,POLYMARKET_PUBLIC_DATA,GDELT_NEWS_DISCOVERY' }), ['GDELT_NEWS_DISCOVERY', 'POLYMARKET_PUBLIC_DATA']);
  const windows = Array.from({ length: 5 }, (_, requestOrdinal) => gdeltCatalogQuery(context, { requestOrdinal, assetsPerQuery: 2 }));
  assert.ok(windows.every((plan) => !plan.error && plan.population === 10 && plan.sweepRequests === 5));
  assert.deepEqual(windows.flatMap((plan) => plan.bases).sort(), context.bases, 'one complete sweep covers every catalog base exactly once');
  assert.deepEqual(gdeltCatalogQuery(context, { requestOrdinal: 5, assetsPerQuery: 2 }).bases, windows[0].bases, 'wraparound is deterministic and equal');
  assert.ok(!windows.map((plan) => plan.query).join(' ').includes('Bitcoin'), 'planner has no named-coin prose seed');
});

test('GDELT mapping keeps publication/discovery/receipt clocks distinct, labels indexed links correctly, and deduplicates syndicated headlines', () => {
  const plan = gdeltCatalogQuery(context, { requestOrdinal: 0, assetsPerQuery: 8 });
  const rows = [
    { title: 'ADA crypto market update', url: 'https://www.cnn.com/story?utm_source=x', domain: 'cnn.com', seendate: '20260912T195500Z' },
    { title: 'ADA crypto market update', url: 'https://www.reuters.com/world/story', domain: 'reuters.com', seendate: '20260912T195501Z' },
    { title: 'ETH token outlook', url: 'https://www.bloomberg.com/news/a', domain: 'bloomberg.com', seendate: '20260912T195400Z', publicationdate: '2026-09-12T19:50:00Z' },
  ];
  const mapped = mapGdeltArticles({ articles: rows }, { context, plan, receiptTs: T0, limit: 50 });
  assert.equal(mapped.observations.length, 3);
  for (const observation of mapped.observations) {
    assert.equal(discoveryObservationError(observation), null); assert.equal(observation.acquisition, 'INDEXED_DISCOVERY');
    assert.equal(observation.bodyFetched, false); assert.equal(observation.authority, 'NONE'); assert.equal(observation.receiptTs, T0);
  }
  assert.equal(mapped.observations[0].observationId, mapped.observations[1].observationId, 'same syndicated headline/day has one observation identity across outlets');
  assert.equal(mapped.observations[0].publishedTs, null, 'GDELT seendate is not invented as publication time');
  assert.equal(mapped.observations[0].discoveredTs, Date.parse('2026-09-12T19:55:00Z'));
  assert.equal(mapped.observations[2].publishedTs, Date.parse('2026-09-12T19:50:00Z'));
});

test('Polymarket and Kalshi map public metadata through the full catalog scope and preserve provider event clocks', () => {
  const poly = mapPolymarketMarkets({ markets: [{ id: 'p1', question: 'Will $ADA trade above $1?', description: 'Cardano token market', slug: 'ada-one', active: true, closed: false, createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-12T19:59:00Z', outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', volumeNum: 10 }, { id: 'p2', question: 'Will the president NOT resign?', description: 'Political prediction market', slug: 'not-resign' }] }, { context: discoveryCatalogContext(snapshot(['ADA', 'NOT']), { nowTs: T0 }), receiptTs: T0 });
  assert.equal(poly.observations.length, 1); assert.deepEqual(poly.observations[0].matchedAssets, ['ADA']); assert.equal(poly.observations[0].publishedTs, Date.parse('2026-09-10T00:00:00Z')); assert.equal(poly.observations[0].sourceEventTs, Date.parse('2026-09-12T19:59:00Z')); assert.equal(poly.observations[0].discoveredTs, T0); assert.equal(poly.observations[0].receiptTs, T0); assert.equal(discoveryObservationError(poly.observations[0]), null);
  assert.equal(poly.unmatched, 1, 'an ordinary uppercase word that collides with a catalog ticker is not asset identity');
  const kalshi = mapKalshiMarkets({ markets: [{ ticker: 'KXETH-1', title: 'Will $ETH reach a new high?', status: 'active', created_time: '2026-09-01T00:00:00Z', updated_time: '2026-09-12T19:58:00Z', yes_bid_dollars: '0.50', yes_ask_dollars: '0.52' }, { ticker: 'KXWBT-1', title: 'Will WBT Academy win map 2?', rules_primary: 'Esports market' }] }, { context: discoveryCatalogContext(snapshot(['ETH', 'WBT']), { nowTs: T0 }), receiptTs: T0 });
  assert.equal(kalshi.observations.length, 1); assert.deepEqual(kalshi.observations[0].matchedAssets, ['ETH']); assert.equal(kalshi.observations[0].acquisition, 'DIRECT_PUBLIC_METADATA'); assert.equal(discoveryObservationError(kalshi.observations[0]), null);
  assert.equal(kalshi.unmatched, 1, 'an event acronym that collides with a catalog ticker is not asset identity');
  assert.equal(mapPolymarketMarkets({ markets: [{ id: 'x', question: 'Will it rain?', slug: 'rain' }] }, { context, receiptTs: T0 }).unmatched, 1);
});

test('composed collector is dark by default, reserves budget before requests, persists observations, deduplicates replay, and stops at the explicit cap', async () => {
  const dir = tmp(); let now = T0; const calls = []; const events = []; const durableCheckpoint = memoryDurable(T0, events);
  const fetchImpl = async (url, init) => {
    calls.push({ url, userAgent: init?.headers?.['user-agent'] }); events.push('WIRE');
    if (url.includes('gdeltproject')) return new Response(JSON.stringify({ articles: [{ title: 'ADA crypto market update', url: 'https://www.cnn.com/story', domain: 'cnn.com', seendate: '20260912T195500Z' }, { title: 'ADA crypto market update', url: 'https://www.reuters.com/story', domain: 'reuters.com', seendate: '20260912T195501Z' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('polymarket')) return new Response(JSON.stringify({ markets: [{ id: 'p1', question: 'Will $ADA rise?', slug: 'ada', active: true, updatedAt: '2026-09-12T19:59:00Z' }], next_cursor: 'next' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ markets: [{ ticker: 'KXETH-1', title: 'Will $ETH rise?', status: 'active', updated_time: '2026-09-12T19:59:00Z' }], cursor: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const base = { dataDir: dir, catalogSource: { snapshot: () => snapshot() }, fetchImpl, clock: () => now, log: () => {}, timers, signals: false, durableCheckpoint };
  assert.equal(startPublicDiscovery({ ...base, env: {} }), null); assert.equal(calls.length, 0);
  const env = { DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: DISCOVERY_SOURCES.map((s) => s.id).join(','), DISCOVERY_GDELT_MAX_DAILY_REQUESTS: '1', DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS: '1', DISCOVERY_KALSHI_MAX_DAILY_REQUESTS: '1', SERPENT_HTTP_CONTACT: 'password-like-not-an-email' };
  const handle = startPublicDiscovery({ ...base, env });
  assert.equal((await handle.pollOnce('GDELT_NEWS_DISCOVERY')).admitted, 1, 'syndicated copies dedupe within the same response');
  assert.equal((await handle.pollOnce('POLYMARKET_PUBLIC_DATA')).admitted, 1);
  assert.equal((await handle.pollOnce('KALSHI_PUBLIC_DATA')).admitted, 1);
  assert.equal((await handle.pollOnce('GDELT_NEWS_DISCOVERY')).outcome, 'BUDGET_STOPPED'); assert.equal(calls.length, 3);
  assert.deepEqual(events.slice(0, 3), ['RESERVE:GDELT_NEWS_DISCOVERY', 'WIRE', 'SETTLE:GDELT_NEWS_DISCOVERY'], 'durable reserve precedes wire and durable settle precedes success');
  assert.ok(calls.every((call) => !call.userAgent.includes(env.SERPENT_HTTP_CONTACT) && !call.userAgent.includes('contact:')), 'invalid contact is never transmitted');
  const observations = readDiscoveryObservations(dir); assert.equal(observations.observations.length, 3); assert.equal(observations.corrupt, 0); assert.ok(observations.observations.every((o) => discoveryObservationError(o) === null));
  const receipts = readDiscoveryReceipts(dir); assert.equal(receipts.receipts.filter((r) => r.phase === 'RESERVED').length, 3); assert.equal(receipts.receipts.filter((r) => r.phase === 'SETTLED').length, 3);
  const rawReceipts = readFileSync(path.join(dir, 'public-discovery', 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.equal(rawReceipts[0].phase, 'RESERVED'); assert.equal(rawReceipts[1].phase, 'SETTLED', 'reservation is durable before settlement');
  const status = readDiscoveryStatus(dir); assert.equal(status.paperStarted, false); assert.equal(status.tradingRoutesUsed, false); assert.equal(status.authority, 'NONE'); assert.equal(status.sources.GDELT_NEWS_DISCOVERY.catalog.population, 10); assert.match(status.sources.GDELT_NEWS_DISCOVERY.coverageGap, /index, not a direct or licensed/i); assert.equal(status.sources.POLYMARKET_PUBLIC_DATA.pagination.cursorPending, true);
  await handle.stop();
  const replay = startPublicDiscovery({ ...base, env: { ...env, DISCOVERY_GDELT_MAX_DAILY_REQUESTS: '2' } }); now += 1000; assert.equal((await replay.pollOnce('GDELT_NEWS_DISCOVERY')).admitted, 0); assert.equal(readDiscoveryObservations(dir).observations.length, 3); await replay.stop();
  const imported = loadDiscoveryCheckpoint(dir, { now });
  assert.equal(validateDiscoveryCheckpoint(imported).ok, true); assert.equal(imported.sources.GDELT_NEWS_DISCOVERY.reservationsToday, 2); assert.equal(imported.sources.GDELT_NEWS_DISCOVERY.queryOrdinal, 2); assert.equal(imported.sources.GDELT_NEWS_DISCOVERY.seenIds.length, 1);
  const writer = path.join(dir, 'public-discovery', 'writer.lock'); writeFileSync(writer, '{}');
  assert.throws(() => loadDiscoveryCheckpoint(dir, { now }), /writer\.lock exists/); unlinkSync(writer);
});

test('commissioning import refuses a missing receipt history instead of resetting quota to zero', () => {
  const dir = tmp(); const root = path.join(dir, 'public-discovery'); mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify({ v: 'public-discovery-checkpoint-1', writtenTs: T0, sources: {} }));
  assert.throws(() => loadDiscoveryCheckpoint(dir, { now: T0 }), /receipt history is missing; zero usage is refused/);
});

test('commissioning requires an exact filesystem fingerprint before preserving a bounded unknown-history gap', async () => {
  const dir = tmp();
  const handle = startPublicDiscovery({
    env: { DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: 'KALSHI_PUBLIC_DATA', DISCOVERY_KALSHI_MAX_DAILY_REQUESTS: '1' },
    dataDir: dir, catalogSource: { snapshot: () => snapshot() }, clock: () => T0, log: () => {}, timers, signals: false,
    durableCheckpoint: memoryDurable(),
    fetchImpl: async () => new Response(JSON.stringify({ markets: [{ ticker: 'KXETH-1', title: 'Will $ETH rise?', status: 'active', updated_time: '2026-09-12T19:59:00Z' }], cursor: '' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal((await handle.pollOnce('KALSHI_PUBLIC_DATA')).admitted, 1); await handle.stop();
  writeFileSync(path.join(dir, 'public-discovery', 'observations.jsonl'), '');
  let required;
  assert.throws(() => loadDiscoveryCheckpoint(dir, { now: T0 }), (error) => {
    required = error.message.match(/explicit allowance required: (v1:1:[0-9a-f]{64})/)?.[1];
    return Boolean(required);
  });
  assert.throws(() => loadDiscoveryCheckpoint(dir, { now: T0, integrityGapAllowance: `${required}0` }), /explicit allowance required/);
  const imported = loadDiscoveryCheckpoint(dir, { now: T0, integrityGapAllowance: required });
  assert.equal(validateDiscoveryCheckpoint(imported).ok, true);
  assert.equal(imported.sources.KALSHI_PUBLIC_DATA.totalReservations, 1, 'the charged request is preserved');
  assert.equal(imported.sources.KALSHI_PUBLIC_DATA.sweepsCompleted, 1, 'the last durable cursor checkpoint is preserved');
  assert.deepEqual(imported.sources.KALSHI_PUBLIC_DATA.seenIds, [], 'missing identities are not invented');
  assert.deepEqual(imported.importIntegrity, {
    v: 'public-discovery-import-integrity-1', status: 'UNKNOWN_HISTORY', policy: 'FORWARD_ONLY_PRESENT_OBSERVATIONS',
    fingerprint: required.split(':')[2], explicitAllowance: true,
    reservations: 1, settlements: 1, recordedAdmissions: 1, presentObservations: 0, missingAdmissions: 1, pendingReservations: 0,
    sources: {
      GDELT_NEWS_DISCOVERY: { reservations: 0, settlements: 0, recordedAdmissions: 0, presentObservations: 0, missingAdmissions: 0, pendingReservations: 0 },
      KALSHI_PUBLIC_DATA: { reservations: 1, settlements: 1, recordedAdmissions: 1, presentObservations: 0, missingAdmissions: 1, pendingReservations: 0 },
      POLYMARKET_PUBLIC_DATA: { reservations: 0, settlements: 0, recordedAdmissions: 0, presentObservations: 0, missingAdmissions: 0, pendingReservations: 0 },
    },
    gaps: [{ sourceId: 'KALSHI_PUBLIC_DATA', requestOrdinal: 0, requestedTs: T0, receiptTs: T0, outcome: 'OK', recordedAdmissions: 1, presentObservations: 0 }],
  });
});

test('a durable settlement fault latches discovery and prevents every later wire request', async () => {
  const dir = tmp(); const durableCheckpoint = memoryDurable(); const update = durableCheckpoint.update; let calls = 0;
  durableCheckpoint.update = async (reducer, meta) => {
    if (meta?.phase === 'SETTLE:GDELT_NEWS_DISCOVERY') throw Object.assign(new Error('database unavailable'), { code: 'CHECKPOINT_WRITE_FAILED' });
    return update(reducer, meta);
  };
  const handle = startPublicDiscovery({
    env: { DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: 'GDELT_NEWS_DISCOVERY', DISCOVERY_GDELT_MAX_DAILY_REQUESTS: '24' },
    dataDir: dir, catalogSource: { snapshot: () => snapshot() }, clock: () => T0, log: () => {}, timers, signals: false, durableCheckpoint,
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ articles: [{ title: 'ADA crypto market update', url: 'https://example.com/a', domain: 'example.com', seendate: '20260912T195500Z' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  assert.equal((await handle.pollOnce('GDELT_NEWS_DISCOVERY')).outcome, 'DURABILITY_BLOCKED'); assert.equal(calls, 1);
  assert.equal((await handle.pollOnce('GDELT_NEWS_DISCOVERY')).outcome, 'DURABILITY_BLOCKED'); assert.equal(calls, 1, 'fault latch prevents a second wire');
  assert.equal(handle.status().durability.deployment, 'FAULT_LATCHED'); assert.equal(handle.status().sources.GDELT_NEWS_DISCOVERY.state, 'DURABILITY_BLOCKED');
  await handle.stop();
});

test('stop awaits an in-flight poll before it releases the single-writer lock', async () => {
  const dir = tmp(); let releaseWire; let markWire;
  const wireStarted = new Promise((resolve) => { markWire = resolve; });
  const handle = startPublicDiscovery({
    env: { DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: 'GDELT_NEWS_DISCOVERY', DISCOVERY_GDELT_MAX_DAILY_REQUESTS: '24' },
    dataDir: dir, catalogSource: { snapshot: () => snapshot() }, clock: () => T0, log: () => {}, timers, signals: false, durableCheckpoint: memoryDurable(),
    fetchImpl: async () => { markWire(); return new Promise((resolve) => { releaseWire = () => resolve(new Response(JSON.stringify({ articles: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); }); },
  });
  const poll = handle.pollOnce('GDELT_NEWS_DISCOVERY'); await wireStarted;
  const stopping = handle.stop(); const writer = path.join(dir, 'public-discovery', 'writer.lock');
  assert.equal(existsSync(writer), true, 'writer lock remains held while a poll owns durable settlement work');
  releaseWire(); await poll; await stopping;
  assert.equal(existsSync(writer), false);
});
