#!/usr/bin/env node
// One bounded live verification against the normal configured data directory.
// It never starts fly.js, paper, recurring timers, trading, or a temporary store.
import { dataDir } from '../lib/config.js';
import { startWideEye } from '../survey/wideeye.js';
import { startPublicDiscovery } from '../discovery/collector.js';
import { DISCOVERY_SOURCE_IDS } from '../discovery/registry.js';
import { readDiscoveryObservations, readDiscoveryReceipts, readDiscoveryStatus } from '../discovery/reader.js';

const dir = dataDir(); const startedTs = Date.now(); const day = new Date(startedTs).toISOString().slice(0, 10);
const requestedSources = String(process.env.DISCOVERY_SMOKE_SOURCES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const smokeSourceIds = requestedSources.length ? requestedSources : [...DISCOVERY_SOURCE_IDS];
if (smokeSourceIds.some((id) => !DISCOVERY_SOURCE_IDS.includes(id)) || new Set(smokeSourceIds).size !== smokeSourceIds.length) throw new Error('DISCOVERY_SMOKE_SOURCES must be a unique subset of the public discovery registry');
const rounds = Number(process.env.DISCOVERY_SMOKE_ROUNDS ?? '1');
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('DISCOVERY_SMOKE_ROUNDS must be in 1..5');
const beforeReceipts = readDiscoveryReceipts(dir, { limit: 5000 });
const beforeObservations = readDiscoveryObservations(dir, { limit: 5000 });
const existingToday = Object.fromEntries(DISCOVERY_SOURCE_IDS.map((id) => [id, beforeReceipts.receipts.filter((r) => r.sourceId === id && r.phase === 'RESERVED' && r.day === day).length]));
const inertTimers = { setTimeout: () => ({}), clearTimeout() {}, setInterval: () => ({}), clearInterval() {} };
const wideEye = startWideEye({ log: () => {}, setIntervalImpl: inertTimers.setInterval, clearIntervalImpl: inertTimers.clearInterval, setTimeoutImpl: inertTimers.setTimeout, clearTimeoutImpl: inertTimers.clearTimeout, registerSignals: false });
if (!wideEye) throw new Error('WideEye is disabled; the current eligible Kraken catalog cannot be acquired');
let discovery;
try {
  const refreshed = await wideEye._refreshCatalog();
  const catalog = wideEye.catalogSnapshot();
  if (!refreshed?.ok || catalog.status !== 'ACCEPTED' || catalog.fresh !== true) throw new Error(`accepted fresh Kraken catalog unavailable: ${catalog.lastError ?? catalog.status}`);
  const env = {
    ...process.env,
    DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: smokeSourceIds.join(','),
    DISCOVERY_GDELT_MAX_DAILY_REQUESTS: String(existingToday.GDELT_NEWS_DISCOVERY + rounds), DISCOVERY_GDELT_RESULT_LIMIT: '50', DISCOVERY_GDELT_ASSETS_PER_QUERY: '12',
    DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS: String(existingToday.POLYMARKET_PUBLIC_DATA + rounds), DISCOVERY_POLYMARKET_PAGE_LIMIT: '100',
    DISCOVERY_KALSHI_MAX_DAILY_REQUESTS: String(existingToday.KALSHI_PUBLIC_DATA + rounds), DISCOVERY_KALSHI_PAGE_LIMIT: '1000',
  };
  discovery = startPublicDiscovery({ env, dataDir: dir, catalogSource: { snapshot: () => wideEye.catalogSnapshot() }, timers: inertTimers, firstDelayMs: 86_400_000, signals: false, log: () => {} });
  const polls = Object.fromEntries(smokeSourceIds.map((id) => [id, []]));
  for (let round = 0; round < rounds; round += 1) {
    for (const id of smokeSourceIds) polls[id].push(await discovery.pollOnce(id));
  }
  const afterReceipts = readDiscoveryReceipts(dir, { limit: 5000 }); const afterObservations = readDiscoveryObservations(dir, { limit: 5000 }); const status = readDiscoveryStatus(dir);
  const newSettled = afterReceipts.receipts.filter((r) => r.phase === 'SETTLED' && r.requestedTs >= startedTs);
  const newRecords = afterObservations.observations.filter((o) => o.receiptTs >= startedTs);
  console.log(JSON.stringify({
    smokeVersion: 'public-discovery-live-smoke-1', dataDir: dir, paperStarted: false, continuousPollingStarted: false, authority: 'NONE',
    catalog: { contentId: catalog.contentId, supportedMarkets: catalog.counts?.supported ?? null, observedTs: catalog.observedTs, source: catalog.source },
    polls, durableReadback: { observationsBefore: beforeObservations.observations.length, observationsAfter: afterObservations.observations.length, newRecords: newRecords.length, settledReceipts: newSettled.length, corruptObservations: afterObservations.corrupt, corruptReceipts: afterReceipts.corrupt },
    bySource: Object.fromEntries(DISCOVERY_SOURCE_IDS.map((id) => [id, { settled: newSettled.filter((r) => r.sourceId === id), records: newRecords.filter((o) => o.sourceId === id).map((o) => ({ observationId: o.observationId, title: o.title, urlHost: o.urlHost, acquisition: o.acquisition, matchedAssets: o.matchedAssets, publishedTs: o.publishedTs, sourceEventTs: o.sourceEventTs, discoveredTs: o.discoveredTs, receiptTs: o.receiptTs, publicationDelayMs: o.publicationDelayMs, discoveryDelayMs: o.discoveryDelayMs })) }])),
    coverage: Object.fromEntries(DISCOVERY_SOURCE_IDS.map((id) => [id, status?.sources?.[id] ?? null])),
  }, null, 2));
} finally {
  discovery?.stop(); wideEye.stop();
}
