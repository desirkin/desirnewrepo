#!/usr/bin/env node
// Bounded, data-only setup verification for the existing WideEye -> RUMOR2 ->
// Bluesky path. This never starts fly.js, paper, Judge, X, Farcaster, or any
// official-source poller. The admitted social scope is the full accepted
// catalog; no named coin is promoted ahead of another.
import { loadConfig } from '../lib/config.js';
import { startPersistence } from '../persistence/runtime.js';
import { rumor2CheckpointStore } from '../persistence/rumor2-checkpoint.js';
import { rumor2JournalStore } from '../persistence/rumor2-journal.js';
import { startWideEye } from '../survey/wideeye.js';
import { startRumor2 } from '../rumor2/collector.js';

const rawSeconds = process.argv[2] ?? '20';
if (!/^\d{1,2}$/.test(rawSeconds)) throw new Error('usage: node tools/bluesky-setup-smoke.mjs [5..60]');
const durationSeconds = Number(rawSeconds);
if (durationSeconds < 5 || durationSeconds > 60) throw new Error('duration must be in 5..60 seconds');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stderr.write(`${String(message).slice(0, 300)}\n`);
const inertInterval = () => ({ unref() {}, refresh() {} });

let persistence = null;
let wideEye = null;
let rumor = null;
try {
  const config = loadConfig();
  if (config.socialResearch?.localAdmission?.mode !== 'CATALOG_BACKED') {
    throw new Error('social local admission must be cATALOG_BACKED');
  }

  persistence = await startPersistence({ log });
  const health = persistence.health();
  if (!health.databaseConfigured || !health.restored) {
    throw new Error(`durable journal unavailable (${health.failureCategory ?? health.status})`);
  }

  // Construct the existing WideEye owner but suppress its continuous timers.
  // The explicit refresh below is exactly one public Kraken AssetPairs call.
  wideEye = startWideEye({
    config,
    log,
    setIntervalImpl: inertInterval,
    clearIntervalImpl: () => {},
    setTimeoutImpl: () => null,
    clearTimeoutImpl: () => {},
    registerSignals: false,
  });
  if (!wideEye) throw new Error('WideEye is disabled');
  await wideEye._refreshCatalog();
  const catalog = wideEye.catalogSnapshot();
  if (catalog.status !== 'ACCEPTED' || !catalog.fresh || !catalog.catalog) {
    throw new Error(`broad catalog unavailable (${catalog.lastError ?? catalog.status})`);
  }

  rumor = startRumor2({
    config,
    enabled: true,
    intervalMs: 3_600_000,
    checkpointStore: rumor2CheckpointStore(),
    journal: rumor2JournalStore(),
    allowLocalJournal: false,
    edgarEnabled: false,
    ofacEnabled: false,
    socialBlueskyEnabled: true,
    socialXEnabled: false,
    socialFarcasterEnabled: false,
    socialCurrentEnabled: false,
    researchCatalogSource: {
      snapshot: () => wideEye.catalogSnapshot(),
      notices: () => wideEye.researchNotices(),
      population: () => wideEye.sweepPopulationSnapshot(),
    },
    researchStrainer: null,
    log,
  });

  await rumor.tickOnce();
  await sleep(durationSeconds * 1000);
  await rumor.tickOnce();
  const status = rumor.status();
  const social = status.social;
  const intake = social?.stream?.intake ?? social?.stream?.stats ?? null;
  process.stdout.write(`${JSON.stringify({
    ok: social?.state === 'ACTIVE' && social?.scope?.active?.mode === 'CATALOG_BACKED',
    command: 'bluesky-setup-smoke',
    durationSeconds,
    paperStarted: false,
    continuousPollingStarted: false,
    authority: social?.authority ?? 'NONE',
    durabilityMode: status.durabilityMode,
    catalog: {
      contentId: catalog.contentId,
      counts: catalog.counts,
      maxMarkets: catalog.resource?.maxMarkets ?? null,
    },
    social: {
      state: social?.state ?? null,
      connected: social?.stream?.connected ?? false,
      scopeMode: social?.scope?.active?.mode ?? null,
      scopeTermCount: social?.scope?.active?.termCount ?? null,
      durableCursor: social?.durableCursor ?? null,
      received: intake?.received ?? null,
      enqueued: intake?.enqueued ?? null,
      filtered: intake?.filtered ?? null,
      appended: social?.stats?.appended ?? null,
      lastError: social?.lastError ?? null,
    },
  }, null, 2)}\n`);
} finally {
  if (rumor) await rumor.stop();
  if (wideEye) wideEye.stop();
  if (persistence) await persistence.stop();
}
