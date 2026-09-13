import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeKrakenAssetPairs } from '../survey/catalog.js';
import { startRumor2 } from '../rumor2/collector.js';
import { normalizeHttpContact, userAgentFor } from '../rumor2/registry.js';
import { memJournal } from './helpers/rumor2-journal.js';
import { DISCOVERY_SOURCES, discoveryRegistryError } from '../discovery/registry.js';
import { discoveryCatalogContext, gdeltCatalogQuery } from '../discovery/query.js';
import { DISCOVERY_CLOCK_SKEW_MS, discoveryObservationError, mapGdeltArticles } from '../discovery/parse.js';

const T0 = Date.parse('2026-09-12T20:00:00Z');

function catalogContext() {
  const normalized = normalizeKrakenAssetPairs({
    ADAUSD: { base: 'XADA', quote: 'ZUSD', wsname: 'ADA/USD', status: 'online' },
    ETHUSD: { base: 'XETH', quote: 'ZUSD', wsname: 'ETH/USD', status: 'online' },
  }, { observedTs: T0 - 1000 });
  assert.equal(normalized.ok, true);
  return discoveryCatalogContext({ status: 'ACCEPTED', fresh: true, catalog: normalized.catalog }, { nowTs: T0 });
}

test('contact-gated official providers accept normalized operator e-mail identity and reject unsafe header material', async () => {
  assert.equal(normalizeHttpContact('  Operator <ops@example.com>  '), 'Operator <ops@example.com>');
  for (const bad of [null, '', '   ', 'operator only', 'ops@example.com\r\nX-Injected: yes', `${'a'.repeat(196)}@x.io`]) {
    assert.equal(normalizeHttpContact(bad), null);
    assert.doesNotMatch(userAgentFor({}, bad), /contact:/);
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'news-contact-gate-'));
  const previousDataDir = process.env.COBRA_DATA_DIR;
  process.env.COBRA_DATA_DIR = dir;
  const calls = [];
  const checkpointStore = {
    async load() { return { outcome: 'NOT_FOUND' }; },
    async save() { return { durable: true }; },
  };
  const collector = startRumor2({
    enabled: true,
    contact: 'ops@example.com\r\nX-Injected: yes',
    config: { universe: ['BTC'] },
    now: () => T0,
    intervalMs: 2_147_000_000,
    checkpointStore,
    journal: memJournal([]),
    fetchImpl: async (url) => { calls.push(String(url)); return new Response('', { status: 304 }); },
    log: () => {},
  });
  try {
    await collector.tickOnce();
    assert.equal(calls.some((url) => url.includes('sec.gov')), false, 'unsafe contact must not activate the SEC ear');
    const sec = collector.internals.coverageEntries(T0).find((entry) => entry.provider === 'SEC_OFFICIAL');
    assert.equal(sec.state, 'NOT_QUERIED');
    assert.match(sec.detail, /SERPENT_HTTP_CONTACT/);
  } finally {
    await collector.stop();
    if (previousDataDir === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery registry pins every provider id to its exact audited HTTPS endpoint', () => {
  assert.equal(discoveryRegistryError(), null);
  const altered = (patch) => DISCOVERY_SOURCES.map((source) => source.id === 'GDELT_NEWS_DISCOVERY' ? { ...source, ...patch } : source);
  assert.match(discoveryRegistryError(altered({ baseUrl: 'https://api.gdeltproject.org/api/v2/doc/other' })), /transport/);
  assert.match(discoveryRegistryError(altered({ baseUrl: 'https://api.gdeltproject.org:8443/api/v2/doc/doc' })), /transport/);
  assert.match(discoveryRegistryError(altered({ baseUrl: 'https://operator@api.gdeltproject.org/api/v2/doc/doc' })), /transport/);
  assert.match(discoveryRegistryError(altered({ kind: 'PREDICTION_MARKET', route: 'CURSOR_JSON' })), /kind|route/);
});

test('GDELT parser refuses future causal clocks and never retains publisher body or fulltext fields', () => {
  const context = catalogContext();
  const plan = gdeltCatalogQuery(context, { requestOrdinal: 0, assetsPerQuery: 2 });
  const future = new Date(T0 + DISCOVERY_CLOCK_SKEW_MS + 1000).toISOString();
  const mapped = mapGdeltArticles({ articles: [
    { title: 'ADA market update', url: 'https://publisher.example/valid', seendate: '20260912T200400Z', summary: 'feed excerpt', description: 'article description', content: 'unlicensed full article', body: 'unlicensed full article' },
    { title: 'ETH future discovery', url: 'https://publisher.example/future-seen', seendate: '20260912T200501Z' },
    { title: 'ETH future publication', url: 'https://publisher.example/future-published', seendate: '20260912T195900Z', publicationdate: future },
  ] }, { context, plan, receiptTs: T0, limit: 50 });

  assert.equal(mapped.invalid, 2);
  assert.equal(mapped.observations.length, 1);
  const observation = mapped.observations[0];
  assert.equal(observation.summary, '');
  assert.equal(observation.bodyFetched, false);
  assert.equal('body' in observation, false);
  assert.equal('content' in observation, false);
  assert.equal('description' in observation, false);
  assert.equal(discoveryObservationError(observation), null);

  const forgedFuture = { ...observation, discoveredTs: T0 + DISCOVERY_CLOCK_SKEW_MS + 1 };
  assert.equal(discoveryObservationError(forgedFuture), 'GDELT discovery law');
});

test('GDELT parser fails closed on missing or mismatched catalog provenance instead of throwing', () => {
  const context = catalogContext();
  const plan = gdeltCatalogQuery(context, { requestOrdinal: 0, assetsPerQuery: 2 });
  const json = { articles: [{ title: 'ADA update', url: 'https://publisher.example/item' }] };
  assert.match(mapGdeltArticles(json, {}).error, /catalog context/);
  assert.match(mapGdeltArticles(json, { context, plan: { ...plan, catalogContentId: 'wrong' }, receiptTs: T0 }).error, /does not match/);
  assert.match(mapGdeltArticles(json, { context, plan, receiptTs: NaN }).error, /receipt clock/);
});
