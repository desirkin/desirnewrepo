import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { startPublicDiscovery } from '../discovery/collector.js';
import { emptyDiscoveryCheckpoint } from '../discovery/external-checkpoint.js';
import { readDiscoveryReceipts } from '../discovery/reader.js';

const T0 = Date.parse('2026-09-13T12:00:00.000Z');
const timers = { setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'discovery-pagination-'));

function catalogSnapshot() {
  const normalized = normalizeKrakenAssetPairs({
    XBTUSD: { base: 'XXBT', quote: 'ZUSD', wsname: 'XBT/USD', status: 'online' },
    ETHUSD: { base: 'XETH', quote: 'ZUSD', wsname: 'ETH/USD', status: 'online' },
  }, { observedTs: T0 - 1_000 });
  assert.equal(normalized.ok, true);
  return { status: 'ACCEPTED', fresh: true, catalog: normalized.catalog };
}

function memoryDurable({ sourceId = null, cursor = null } = {}) {
  let state = emptyDiscoveryCheckpoint({ now: T0 });
  if (sourceId) state.sources[sourceId].cursor = cursor;
  let revision = 1;
  let failure = null;
  return {
    snapshot: () => structuredClone(state),
    revision: () => revision,
    failed: () => failure,
    update: async (reducer) => {
      state = reducer(structuredClone(state));
      revision += 1;
      return structuredClone(state);
    },
    fail: (code = 'TEST_FAILURE') => { failure = { code }; },
  };
}

function envFor(sourceId) {
  const env = { DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: sourceId };
  if (sourceId === 'POLYMARKET_PUBLIC_DATA') {
    env.DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS = '48';
    env.DISCOVERY_POLYMARKET_PAGE_LIMIT = '2';
  } else {
    env.DISCOVERY_KALSHI_MAX_DAILY_REQUESTS = '48';
    env.DISCOVERY_KALSHI_PAGE_LIMIT = '2';
  }
  return env;
}

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

function options({ dir, sourceId, durableCheckpoint, fetchImpl }) {
  return {
    env: envFor(sourceId), dataDir: dir, durableCheckpoint, fetchImpl,
    catalogSource: { snapshot: catalogSnapshot }, clock: () => T0,
    timers, signals: false, log: () => {},
  };
}

test('Polymarket keyset cursor advances durably, survives restart, and an empty terminal page completes the sweep', async () => {
  const dir = tmp();
  const durableCheckpoint = memoryDurable();
  const urls = [];
  let handle = startPublicDiscovery(options({
    dir, sourceId: 'POLYMARKET_PUBLIC_DATA', durableCheckpoint,
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({
        markets: [
          { id: 'p1', question: 'Will $BTC rise?', slug: 'btc-rise' },
          { id: 'p2', question: 'Will $ETH rise?', slug: 'eth-rise' },
        ],
        next_cursor: 'cursor-1',
      });
    },
  }));
  assert.equal((await handle.pollOnce('POLYMARKET_PUBLIC_DATA')).outcome, 'OK');
  assert.equal(durableCheckpoint.snapshot().sources.POLYMARKET_PUBLIC_DATA.cursor, 'cursor-1');
  assert.equal(durableCheckpoint.snapshot().sources.POLYMARKET_PUBLIC_DATA.sweepsCompleted, 0);
  await handle.stop();

  handle = startPublicDiscovery(options({
    dir, sourceId: 'POLYMARKET_PUBLIC_DATA', durableCheckpoint,
    fetchImpl: async (url) => { urls.push(url); return jsonResponse({ markets: [] }); },
  }));
  assert.equal((await handle.pollOnce('POLYMARKET_PUBLIC_DATA')).outcome, 'OK');
  assert.equal(new URL(urls[1]).searchParams.get('after_cursor'), 'cursor-1');
  const settled = durableCheckpoint.snapshot().sources.POLYMARKET_PUBLIC_DATA;
  assert.equal(settled.cursor, null);
  assert.equal(settled.sweepsCompleted, 1);
  assert.equal(settled.totalReservations, 2);
  await handle.stop();
});

test('Kalshi accepts its documented empty-string terminal cursor without inventing another page', async () => {
  const dir = tmp();
  const durableCheckpoint = memoryDurable();
  const handle = startPublicDiscovery(options({
    dir, sourceId: 'KALSHI_PUBLIC_DATA', durableCheckpoint,
    fetchImpl: async () => jsonResponse({ markets: [], cursor: '' }),
  }));
  assert.equal((await handle.pollOnce('KALSHI_PUBLIC_DATA')).outcome, 'OK');
  const settled = durableCheckpoint.snapshot().sources.KALSHI_PUBLIC_DATA;
  assert.equal(settled.cursor, null);
  assert.equal(settled.sweepsCompleted, 1);
  await handle.stop();
});

test('malformed, false-terminal, repeated, and oversized provider cursors fail locally without advancing durable coverage', async (t) => {
  const cases = [
    {
      name: 'Polymarket legacy bare array', sourceId: 'POLYMARKET_PUBLIC_DATA', cursor: null,
      body: [], error: /no markets array/i,
    },
    {
      name: 'Polymarket legacy data wrapper even with cursor', sourceId: 'POLYMARKET_PUBLIC_DATA', cursor: null,
      body: { data: [], next_cursor: 'legacy' }, error: /no markets array/i,
    },
    {
      name: 'Polymarket full page without next cursor', sourceId: 'POLYMARKET_PUBLIC_DATA', cursor: null,
      body: { markets: [{ id: 'p1' }, { id: 'p2' }] }, error: /full keyset page is missing next cursor/i,
    },
    {
      name: 'Polymarket repeated cursor', sourceId: 'POLYMARKET_PUBLIC_DATA', cursor: 'stay',
      body: { markets: [{ id: 'p1' }, { id: 'p2' }], next_cursor: 'stay' }, error: /did not advance/i,
    },
    {
      name: 'Kalshi missing cursor', sourceId: 'KALSHI_PUBLIC_DATA', cursor: null,
      body: { markets: [] }, error: /cursor is missing or malformed/i,
    },
    {
      name: 'Kalshi repeated cursor', sourceId: 'KALSHI_PUBLIC_DATA', cursor: 'stay',
      body: { markets: [], cursor: 'stay' }, error: /did not advance/i,
    },
    {
      name: 'Kalshi oversized cursor', sourceId: 'KALSHI_PUBLIC_DATA', cursor: null,
      body: { markets: [], cursor: 'x'.repeat(4097) }, error: /exceeds the durable bound/i,
    },
  ];

  for (const fixture of cases) await t.test(fixture.name, async () => {
    const dir = tmp();
    const durableCheckpoint = memoryDurable({ sourceId: fixture.sourceId, cursor: fixture.cursor });
    const before = durableCheckpoint.snapshot().sources[fixture.sourceId];
    const handle = startPublicDiscovery(options({
      dir, sourceId: fixture.sourceId, durableCheckpoint,
      fetchImpl: async () => jsonResponse(fixture.body),
    }));
    assert.equal((await handle.pollOnce(fixture.sourceId)).outcome, 'PARSE_FAILED');
    const after = durableCheckpoint.snapshot().sources[fixture.sourceId];
    assert.equal(after.cursor, before.cursor, 'the last proven cursor remains authoritative');
    assert.equal(after.sweepsCompleted, before.sweepsCompleted, 'malformed input cannot declare a sweep complete');
    assert.equal(after.totalReservations, before.totalReservations + 1, 'the attempted wire request stays charged');
    assert.equal(durableCheckpoint.failed(), null, 'a provider parse failure must not fault-latch checkpoint storage');
    const receipts = readDiscoveryReceipts(dir).receipts;
    const settlement = receipts.find((receipt) => receipt.phase === 'SETTLED');
    assert.equal(settlement.outcome, 'PARSE_FAILED');
    assert.match(settlement.error, fixture.error);
    await handle.stop();
  });
});
