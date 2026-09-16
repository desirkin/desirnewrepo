// lib/collectors.js — the shared collector set (runtime unification step 2, 2026-09-14). Moved verbatim from
// lib/serpent-runtime.js: market catalogs, wide eye + Kraken catalog, broad Kraken capture, YouTube, public
// gateway, RUMOR-2 — in that order, each behind its own fail-closed gate, each pushed onto `handles` so the
// spine stops them in reverse. Step 3 runs this same set under the PAPER root. `starters` are injectable so the
// composition test (test/serpent-runtime-composition.test.js) proves the exact call order and options with no network.
import { loadConfig } from './config.js';
import { bounded } from './data-only-lifecycle.js';
import { startWideEye } from '../survey/wideeye.js';
import { startGateway } from '../gateway/collector.js';
import { rumor2CheckpointStore } from '../persistence/rumor2-checkpoint.js';
import { rumor2JournalStore } from '../persistence/rumor2-journal.js';
import { startRumor2 } from '../rumor2/collector.js';
import { startDataOnlyMarket } from '../tools/data-only-market.mjs';
import { startBroadKraken } from '../market-lab/broad-kraken.js';
import { createBroadDayArchiveSink, broadDayArchiveEnabled } from '../market-lab/broad-day-archive-sink.js';
import { sessionDate } from './time.js';

// The ET trading-day label the day archive rolls on (the same civil day every other rollup uses).
const etDayLabelOf = (t) => sessionDate(new Date(t));

export const DEFAULT_STARTERS = Object.freeze({ startDataOnlyMarket, startWideEye, startBroadKraken, startGateway, startRumor2 });

// The collector overlay on the loaded config: wide eye and gateway always on at the published cadence.
export function collectorConfig(base = loadConfig()) {
  return {
    ...base,
    wideeye: { ...base.wideeye, enabled: true, sweepSec: 60 },
    gateway: { ...base.gateway, enabled: true, pollSec: 300, sources: { kraken: true, krakenSystem: true, coinbase: true, okx: true } },
  };
}

export async function startSharedCollectors({ root, config = collectorConfig(), env = process.env, governor, checkpoints, blockers, handles, log, phase, starters = DEFAULT_STARTERS }) {
  const { startDataOnlyMarket, startWideEye, startBroadKraken, startGateway, startRumor2 } = starters;
  let wideEye = null;
  let rumor2 = null;
  let market = null;
  let broadMarket = null;

  try {
    phase('MARKET_CATALOGS');
    // Market observation has a separate closed host allowlist, zero-paid policy,
    // and per-provider quota guard. The news/infra governor is not its transport.
    if (!checkpoints?.market) throw new Error(blockers.MARKET ?? 'MARKET_QUOTA_NOT_RESTORED');
    market = await startDataOnlyMarket({ env, dataDir: root, log, quotaJournal: checkpoints.market });
    handles.push(market);
  } catch (error) {
    blockers.MARKET = bounded(error.message);
    log(`MARKET blocked: ${blockers.MARKET}`);
  }

  try {
    phase('KRAKEN_CATALOG');
    wideEye = startWideEye({
      config,
      fetchImpl: governor.fetch,
      registerSignals: false,
      nominationEnabled: false,
      deepCoinsSource: () => new Set(),
      log,
    });
    if (!wideEye) throw new Error('WideEye did not start');
    handles.push(wideEye);
    await wideEye._refreshCatalog();
    // The catalog gates downstream scopes; the broad first sweep does not.
    // WideEye already owns recurring polling. Do not serialize startup behind it.
    void wideEye._sweepOnce().catch((error) => { blockers.WIDEEYE = bounded(error.message); log(`WIDEEYE sweep blocked: ${blockers.WIDEEYE}`); });
  } catch (error) {
    blockers.WIDEEYE = bounded(error.message);
    log(`WIDEEYE blocked: ${blockers.WIDEEYE}`);
  }

  const catalogSource = wideEye ? { snapshot: () => wideEye.catalogSnapshot() } : null;
  const catalog = catalogSource?.snapshot?.()?.catalog ?? null;
  if (!Array.isArray(catalog?.markets) || catalog.markets.length === 0) {
    blockers.KRAKEN_CATALOG = 'no accepted full Kraken USD catalog; catalog-dependent collectors withheld (no named fallback)';
  }

  // The outer funnel is independent of the small, deeper research-subject set.
  // Every accepted catalog market gets the same public price/volume/candle
  // subscription opportunity. Observed coverage is reported by the collector,
  // never inferred from catalog size or from the deep collector's health.
  // Construct the waiting collector even if the first catalog request failed.
  // Public WS collection has no dependency on the separate deep REST quota.
  // Catalog acquisition itself still uses its existing budget/checkpoint gate.
  let broadDayArchive = null;
  if (catalogSource) {
    // DATA-1 (opt-in): open the day archive first so it is stopped (finalized) AFTER broad capture stops emitting.
    if (broadDayArchiveEnabled(env)) {
      try {
        broadDayArchive = createBroadDayArchiveSink({ root, catalogSource, dayLabelOf: etDayLabelOf, log });
        handles.push(broadDayArchive);
      } catch (error) { blockers.BROAD_DAY_ARCHIVE = bounded(error.message); log(`BROAD DAY ARCHIVE blocked: ${blockers.BROAD_DAY_ARCHIVE}`); }
    }
    try {
      phase('BROAD_MARKET_CAPTURE');
      const broadOpts = { catalogSource, dataDir: root, log };
      if (broadDayArchive) broadOpts.onRecord = broadDayArchive.onRecord; // feed every record into the day archive
      broadMarket = await startBroadKraken(broadOpts);
      handles.push(broadMarket);
    } catch (error) {
      blockers.BROAD_MARKET = bounded(error.message);
      log(`BROAD MARKET blocked: ${blockers.BROAD_MARKET}`);
    }
  }


  if (catalog) {
    try {
      const handle = startGateway({ config, fetchImpl: governor.fetch, dataRoot: root, universeSource: catalogSource, log, signals: false });
      if (handle) handles.push(handle);
    } catch (error) { blockers.GATEWAY = bounded(error.message); log(`GATEWAY blocked: ${blockers.GATEWAY}`); }
  }

  if (!blockers.RUMOR2 && catalog) {
    try {
      phase('SOCIAL_JOURNAL_REPLAY');
      const allBases = [...new Set(catalog.markets.map((market) => market.base))].sort();
      const neutralConfig = { ...config, universe: allBases };
      rumor2 = startRumor2({
        config: neutralConfig,
        fetchImpl: governor.fetch,
        checkpointStore: rumor2CheckpointStore(),
        journal: rumor2JournalStore(),
        researchCatalogSource: { snapshot: () => wideEye.catalogSnapshot(), notices: () => wideEye.researchNotices(), population: () => wideEye.sweepPopulationSnapshot(), deepObservation: () => null },
        officialCatalogSource: () => wideEye.catalogSnapshot(),
        enabled: true,
        contact: env.SERPENT_HTTP_CONTACT ?? null,
        edgarEnabled: false,
        ofacEnabled: true,
        socialBlueskyEnabled: true,
        socialXEnabled: true,
        socialFarcasterEnabled: true,
        socialCurrentEnabled: false,
        researchStrainer: null,
        log,
      });
      handles.push(rumor2);
      await rumor2.tickOnce();
    } catch (error) { blockers.RUMOR2 = bounded(error.message); log(`RUMOR2 blocked: ${blockers.RUMOR2}`); }
  }

  return { wideEye, rumor2, market, broadMarket, broadDayArchive, catalogSource, catalog };
}

// ---- PAPER additions (runtime unification step 3, 2026-09-14) ------------------------------------------------------
// The three collectors the ship never ran while the split existed: market catalogs (durable quota journal), broad
// Kraken capture. Everything else in PAPER — wide eye, gateway, RUMOR-2 — is
// already composed by the root with its proven options, so it is NOT restarted here; the root passes its wide eye's
// read-only catalog accessor instead. Same fail-closed gates and blocker names as the shared set above.
export async function startPaperCollectorAdditions({ root, env = process.env, governor, checkpoints, blockers, handles, log, phase, catalogAccessor, starters = DEFAULT_STARTERS }) {
  const { startDataOnlyMarket, startBroadKraken } = starters;
  let market = null;
  let broadMarket = null;
  void governor; // the additions carry their own transports and durable quotas; the news governor is not theirs

  try {
    phase('MARKET_CATALOGS');
    if (!checkpoints?.market) throw new Error(blockers.MARKET ?? 'MARKET_QUOTA_NOT_RESTORED');
    market = await startDataOnlyMarket({ env, dataDir: root, log, quotaJournal: checkpoints.market });
    handles.push(market);
  } catch (error) {
    blockers.MARKET = bounded(error.message);
    log(`MARKET blocked: ${blockers.MARKET}`);
  }

  const catalog = catalogAccessor?.snapshot?.()?.catalog ?? null;
  if (!Array.isArray(catalog?.markets) || catalog.markets.length === 0) {
    blockers.KRAKEN_CATALOG = 'no accepted full Kraken USD catalog; catalog-dependent collectors withheld (no named fallback)';
  }

  let broadDayArchive = null;
  if (catalogAccessor) {
    if (broadDayArchiveEnabled(env)) {
      try {
        broadDayArchive = createBroadDayArchiveSink({ root, catalogSource: catalogAccessor, dayLabelOf: etDayLabelOf, log });
        handles.push(broadDayArchive);
      } catch (error) { blockers.BROAD_DAY_ARCHIVE = bounded(error.message); log(`BROAD DAY ARCHIVE blocked: ${blockers.BROAD_DAY_ARCHIVE}`); }
    }
    try {
      phase('BROAD_MARKET_CAPTURE');
      const broadOpts = { catalogSource: catalogAccessor, dataDir: root, log };
      if (broadDayArchive) broadOpts.onRecord = broadDayArchive.onRecord;
      broadMarket = await startBroadKraken(broadOpts);
      handles.push(broadMarket);
    } catch (error) {
      blockers.BROAD_MARKET = bounded(error.message);
      log(`BROAD MARKET blocked: ${blockers.BROAD_MARKET}`);
    }
  }

  return { market, broadMarket, broadDayArchive, catalog };
}
