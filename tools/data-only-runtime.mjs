// Serpent DATA-ONLY composition root. This file deliberately does not import
// fly.js, Tape, Paper, Judge, Watch, execution, UI controls, or any order
// client. It collects and stores observations only.
import path from 'node:path';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// Establish the safety posture before any project module is evaluated.
delete process.env.COBRA_PROFILE;
Object.assign(process.env, {
  SERPENT_DATA_ONLY: 'true',
  JUDGE_ENABLED: 'false',
  JUDGE_ALLOW_PRIVATE: 'false',
  JUDGE_ALLOW_ORDERS: 'false',
  MARKET_RESEARCH_ENABLED: 'false',
  RUMINT_ENABLED: 'false',
  // Paid X stays disabled during broad-market rollout; existing caps are not
  // authorization to create stream rules or consume the funded account.
  RUMOR2_SOCIAL_X_ENABLED: 'false',
  RUMOR2_SOCIAL_X_MAX_DAILY_POST_READS: '100',
  RUMOR2_SOCIAL_X_MAX_MONTHLY_POST_READS: '3000',
  RUMOR2_SOCIAL_X_MAX_ESTIMATED_DAILY_USD: '0.50',
  RUMOR2_SOCIAL_X_MAX_SESSION_POST_READS: '100',
  RUMOR2_SOCIAL_X_LIVE_SMOKE_TARGET_POST_READS: '10',
  RUMOR2_SOCIAL_X_LIVE_SMOKE_MAX_POST_READS: '35',
  RUMOR2_SOCIAL_X_LIVE_SMOKE_RUN_ID: 'serpent-x-smoke-2026-09-13-v1',
  RUMOR2_SOCIAL_FARCASTER_ENABLED: 'true',
  RUMOR2_SOCIAL_FARCASTER_QUERY_MODE: 'CATALOG_ROTATION',
  RUMOR2_SOCIAL_FARCASTER_MAX_DAILY_REQUESTS: '96',
  RUMOR2_SOCIAL_FARCASTER_RESULT_LIMIT: '10',
  RUMOR2_SOCIAL_FARCASTER_INTERVAL_SEC: '900',
  RUMOR2_SOCIAL_FARCASTER_ASSETS_PER_QUERY: '6',
  RUMOR2_SOCIAL_CURRENT_ENABLED: 'false',
  // YouTube is opt-in even in DATA-ONLY mode. Preserve only an exact explicit
  // enable; absent, malformed, or differently-cased values stay fail-closed.
  SOCIAL_VIDEO_ENABLED: process.env.SOCIAL_VIDEO_ENABLED === 'true' ? 'true' : 'false',
  RUMOR2_EDGAR_ENABLED: 'false',
  RUMOR2_OFAC_ENABLED: 'true',
});

const log = (message) => console.log(`[DATA-ONLY ${new Date().toISOString()}] ${message}`);
const bounded = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 240);

const { loadConfig, dataDir: resolveDataDir } = await import('../lib/config.js');
const { atomicWriteJson, readJsonBounded } = await import('../lib/jsonl.js');
const { createDataOnlyFetch } = await import('../lib/data-only-budget.js');
const { startWideEye } = await import('../survey/wideeye.js');
const { readWideEyeStatus } = await import('../survey/reader.js');
const { startInfra } = await import('../infra/collector.js');
const { readInfraStatus } = await import('../infra/reader.js');
const { startPublicDiscovery } = await import('../discovery/collector.js');
const { readDiscoveryStatus } = await import('../discovery/reader.js');
const { startGateway } = await import('../gateway/collector.js');
const { startVideo } = await import('../video/collector.js');
const { readVideoStatus } = await import('../video/reader.js');
const { startPersistence, getPersistence } = await import('../persistence/runtime.js');
const { rumor2CheckpointStore } = await import('../persistence/rumor2-checkpoint.js');
const { rumor2JournalStore } = await import('../persistence/rumor2-journal.js');
const { startRumor2 } = await import('../rumor2/collector.js');
const { startDataOnlyMarket } = await import('./data-only-market.mjs');
const { startBroadKraken } = await import('../market-lab/broad-kraken.js');
const { openDataOnlyCheckpoints } = await import('./data-only-checkpoints.mjs');
const { onceAsync, dataOnlySpending } = await import('../lib/data-only-lifecycle.js');

const root = resolveDataDir();
mkdirSync(path.join(root, 'data-only'), { recursive: true });

function recoverStaleLock(file, label) {
  if (!existsSync(file)) return;
  let pid;
  try { pid = JSON.parse(readFileSync(file, 'utf8')).pid; } catch { throw new Error(`${label} lock is unreadable; manual review required: ${file}`); }
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`${label} lock has an invalid pid; manual review required: ${file}`);
  try { process.kill(pid, 0); throw new Error(`${label} already active as pid ${pid}`); }
  catch (error) {
    if (error.message?.startsWith(`${label} already active`)) throw error;
    if (error.code !== 'ESRCH') throw new Error(`${label} lock owner could not be verified: ${bounded(error.message)}`);
  }
  unlinkSync(file);
  log(`recovered stale ${label} lock from stopped pid ${pid}`);
}

const runtimeLock = path.join(root, 'data-only', 'runtime.lock');
recoverStaleLock(runtimeLock, 'data-only runtime');
let runtimeFd = openSync(runtimeLock, 'wx', 0o600);
const startedTs = Date.now();
const runId = `${startedTs}-${process.pid}`;
let lifecycle = 'STARTING';
let startupPhase = 'LOCK_ACQUIRED';
writeFileSync(runtimeFd, JSON.stringify({ pid: process.pid, openedTs: startedTs, runId, authority: 'NONE' }));

function writeStartupStatus() {
  atomicWriteJson(path.join(root, 'data-only', 'runtime-status.json'), {
    version: 'serpent-data-only-runtime-2', tsMs: Date.now(), pid: process.pid,
    startedTs, runId, running: true, lifecycle, startupPhase, authority: 'NONE',
    safety: { paperTrading: 'OFF', realTrading: 'OFF', judgeEnabled: false,
      privateAccess: false, ordersAllowed: false, marketResearchModels: false,
      wideEyeNominations: false, entrypoint: 'tools/data-only-runtime.mjs' },
    collectors: {}, blockers: {},
  }, { pretty: true, sync: true });
}
// Publish this process's identity before network/database work, so old ACTIVE
// files cannot masquerade as the new process during a slow startup.
writeStartupStatus();
const startupHeartbeat = setInterval(() => {
  try { writeStartupStatus(); } catch (error) { log(`startup status write failed: ${bounded(error.message)}`); }
}, 15_000);

// These collectors own explicit single-writer files. Recover only a proven
// dead PID; an unreadable or live lock fails closed.
recoverStaleLock(path.join(root, 'public-discovery', 'writer.lock'), 'public discovery writer');

const base = loadConfig();
const config = {
  ...base,
  wideeye: { ...base.wideeye, enabled: true, sweepSec: 60 },
  gateway: { ...base.gateway, enabled: true, pollSec: 300, sources: { kraken: true, krakenSystem: true, coinbase: true, okx: true } },
};
const handles = [];
const blockers = {};
const publisherNewsPolicy = Object.freeze({
  enabled: false,
  desired: 'OFF',
  state: 'WITHHELD_TERMS_UNVERIFIED',
  selectedSources: Object.freeze([]),
  authority: 'NONE',
  coverage: 'NO_PUBLISHER_CONTENT',
  bodyFetched: false,
  excerptsStored: false,
  gateDetail: 'Publisher RSS terms are unverified; publisher requests, excerpts, and article bodies are withheld. Official CFTC/SEC feeds and GDELT link metadata provide the news path.',
});
blockers.PRESS = publisherNewsPolicy.gateDetail;
let wideEye = null;
let rumor2 = null;
let video = null;
let market = null;
let broadMarket = null;
let publicDiscovery = null;
let persistence = null;
let checkpoints = null;
let stopped = false;

// Database restore and quota ownership precede construction of every provider.
startupPhase = 'DATABASE_RESTORE';
try {
  persistence = await startPersistence({ log, registerSignals: false });
  const health = persistence.health();
  if (!health.databaseConfigured || !health.restored) throw new Error('PostgreSQL restore unavailable');
  startupPhase = 'EXTERNAL_QUOTA_RESTORE';
  checkpoints = await openDataOnlyCheckpoints({ persistence, dataDir: root, env: process.env, log });
  Object.assign(blockers, checkpoints.blockers);
} catch (error) {
  blockers.PERSISTENCE = error?.code ?? 'PERSISTENCE_RESTORE_FAILED';
  blockers.RUMOR2 = 'durable PostgreSQL restore or quota ownership unavailable';
}
const governor = checkpoints?.budget
  ? createDataOnlyFetch({ dataDir: root, maxMonthlyUsd: 0, durableCheckpoint: checkpoints.budget })
  : { fetch: async () => { throw new Error('DATA_ONLY_QUOTA_NOT_RESTORED'); },
    status: () => ({ state: 'DURABILITY_BLOCKED', estimatedMonthUsd: null, lanes: {} }) };
if (!checkpoints?.budget) blockers.BUDGET ??= 'DATA_ONLY_QUOTA_NOT_RESTORED';

try {
  startupPhase = 'MARKET_CATALOGS';
  // Market observation has a separate closed host allowlist, zero-paid policy,
  // and per-provider quota guard. The news/infra governor is not its transport.
  if (!checkpoints?.market) throw new Error(blockers.MARKET ?? 'MARKET_QUOTA_NOT_RESTORED');
  market = await startDataOnlyMarket({ env: process.env, dataDir: root, log, quotaJournal: checkpoints.market });
  handles.push(market);
} catch (error) {
  blockers.MARKET = bounded(error.message);
  log(`MARKET blocked: ${blockers.MARKET}`);
}

try {
  startupPhase = 'KRAKEN_CATALOG';
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
if (catalog) {
  try {
    startupPhase = 'BROAD_MARKET_CAPTURE';
    if (!checkpoints?.market) throw new Error(blockers.MARKET ?? 'MARKET_QUOTA_NOT_RESTORED');
    broadMarket = await startBroadKraken({ catalogSource, dataDir: root, log });
    handles.push(broadMarket);
  } catch (error) {
    blockers.BROAD_MARKET = bounded(error.message);
    log(`BROAD MARKET blocked: ${blockers.BROAD_MARKET}`);
  }
}

try {
  const env = { ...process.env, INFRA_OBS_ENABLED: 'true', INFRA_SOURCES: 'NOAA_SWPC,CLOUDFLARE_RADAR', INFRA_CLOUDFLARE_GLOBAL: 'true' };
  const handle = startInfra({ env, dataDir: root, fetchImpl: governor.fetch, log, signals: false });
  if (handle) handles.push(handle);
} catch (error) { blockers.INFRA = bounded(error.message); log(`INFRA blocked: ${blockers.INFRA}`); }

try {
  // The source owns its key/query/quota gates and durable checkpoint. Passing
  // the deployment environment does not invent any defaults: a missing exact
  // enable, key, query list, or daily budget causes zero YouTube requests.
  if (process.env.SOCIAL_VIDEO_ENABLED === 'true' && !checkpoints?.video) throw new Error(blockers.YOUTUBE ?? 'YOUTUBE_QUOTA_NOT_RESTORED');
  video = startVideo({ env: process.env, dataDir: root, log, signals: false, durableCheckpoint: checkpoints?.video ?? null });
  if (video) {
    handles.push(video);
    const gate = video.gate();
    if (!gate.ok) blockers.YOUTUBE = `${gate.reason}: ${gate.detail}`;
  } else {
    blockers.YOUTUBE = 'DISABLED: SOCIAL_VIDEO_ENABLED is not true';
  }
} catch (error) {
  blockers.YOUTUBE = bounded(error.message);
  log(`YOUTUBE blocked: ${blockers.YOUTUBE}`);
}

if (catalog) {
  try {
    if (!checkpoints?.discovery) throw new Error(blockers.PUBLIC_DISCOVERY ?? 'DISCOVERY_QUOTA_NOT_RESTORED');
    const env = {
      ...process.env,
      DISCOVERY_ENABLED: 'true',
      DISCOVERY_SOURCES: 'GDELT_NEWS_DISCOVERY,POLYMARKET_PUBLIC_DATA,KALSHI_PUBLIC_DATA',
      DISCOVERY_GDELT_MAX_DAILY_REQUESTS: '16',
      DISCOVERY_GDELT_RESULT_LIMIT: '50',
      DISCOVERY_GDELT_ASSETS_PER_QUERY: '12',
      // Local free-read ceilings, not provider entitlements. Hourly scheduling
      // remains unchanged; 48 leaves bounded maintenance-restart headroom.
      // Existing charged reservations are restored, never reset by this change.
      DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS: '48',
      DISCOVERY_KALSHI_MAX_DAILY_REQUESTS: '48',
      DISCOVERY_POLYMARKET_PAGE_LIMIT: '100',
      DISCOVERY_KALSHI_PAGE_LIMIT: '1000',
    };
    const handle = startPublicDiscovery({ env, dataDir: root, catalogSource, log, signals: false, durableCheckpoint: checkpoints.discovery });
    publicDiscovery = handle;
    if (handle) handles.push(handle);
  } catch (error) { blockers.PUBLIC_DISCOVERY = bounded(error.message); log(`PUBLIC DISCOVERY blocked: ${blockers.PUBLIC_DISCOVERY}`); }
}

if (catalog) {
  try {
    const handle = startGateway({ config, fetchImpl: governor.fetch, dataRoot: root, universeSource: catalogSource, log, signals: false });
    if (handle) handles.push(handle);
  } catch (error) { blockers.GATEWAY = bounded(error.message); log(`GATEWAY blocked: ${blockers.GATEWAY}`); }
}

if (!blockers.RUMOR2 && catalog) {
  try {
    startupPhase = 'SOCIAL_JOURNAL_REPLAY';
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
      contact: process.env.SERPENT_HTTP_CONTACT ?? null,
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

function readIf(file) { try { return readJsonBounded(file, 8 * 1024 * 1024); } catch { return null; } }
function writeRuntimeStatus() {
  const budget = governor.status();
  const currentCatalog = wideEye?.catalogSnapshot?.()?.catalog ?? null;
  const rumorStatus = rumor2?.status?.() ?? null;
  const discoveryStatus = publicDiscovery ? readDiscoveryStatus(root) : null;
  const officialFeed = (id) => {
    const provider = rumorStatus?.providers?.[id] ?? null;
    return provider ? {
      desired: 'ON', enabled: provider.enabled === true, state: provider.coverage?.state ?? 'STARTING',
      gateDetail: provider.gateDetail ?? provider.coverage?.detail ?? null, checkedTs: provider.coverage?.checkedTs ?? null,
    } : { desired: 'ON', enabled: false, state: 'BLOCKED_RUNTIME', gateDetail: blockers.RUMOR2 ?? 'official feed runtime unavailable', checkedTs: null };
  };
  const gdelt = discoveryStatus?.sources?.GDELT_NEWS_DISCOVERY ?? null;
  const newsSources = {
    CFTC_OFFICIAL: officialFeed('CFTC_OFFICIAL'),
    SEC_OFFICIAL: officialFeed('SEC_OFFICIAL'),
    GDELT_NEWS_DISCOVERY: gdelt ? { desired: gdelt.desired, enabled: gdelt.desired === 'ON' && gdelt.state !== 'CONFIG_REQUIRED', state: gdelt.state, gateDetail: gdelt.lastError, checkedTs: gdelt.clocks?.lastSuccessTs ?? null } : { desired: 'ON', enabled: false, state: 'BLOCKED_RUNTIME', gateDetail: blockers.PUBLIC_DISCOVERY ?? blockers.KRAKEN_CATALOG ?? 'GDELT runtime unavailable', checkedTs: null },
  };
  const newsStates = Object.values(newsSources).map((source) => source.state);
  const officialNewsState = newsStates.every((state) => ['OBSERVED', 'EMPTY'].includes(state)) ? 'ACTIVE'
    : newsStates.some((state) => state === 'IDLE') ? 'STARTING'
      : Object.values(newsSources).some((source) => source.enabled) ? 'DEGRADED' : 'BLOCKED';
  const status = {
    version: 'serpent-data-only-runtime-2',
    tsMs: Date.now(),
    pid: process.pid,
    startedTs,
    runId,
    lifecycle,
    startupPhase,
    running: !stopped,
    authority: 'NONE',
    safety: {
      paperTrading: 'OFF',
      realTrading: 'OFF',
      judgeEnabled: false,
      privateAccess: false,
      ordersAllowed: false,
      marketResearchModels: false,
      wideEyeNominations: false,
      entrypoint: 'tools/data-only-runtime.mjs',
    },
    catalog: currentCatalog ? { contentId: currentCatalog.contentId, observedTs: currentCatalog.observedTs, markets: currentCatalog.markets.length, policy: 'FULL_ACCEPTED_KRAKEN_USD_CATALOG_EQUAL_EVERY_SWEEP', namedPreference: false } : null,
    spending: dataOnlySpending(budget, rumorStatus?.socialX),
    blockers,
    collectors: {
      market: market?.status?.() ?? { state: 'BLOCKED', authority: 'NONE', reason: blockers.MARKET ?? 'market observation unavailable' },
      broadMarket: broadMarket?.status?.() ?? { state: 'BLOCKED', authority: 'NONE', reason: blockers.BROAD_MARKET ?? blockers.KRAKEN_CATALOG ?? 'broad market capture unavailable' },
      wideeye: readWideEyeStatus(root),
      press: publisherNewsPolicy,
      news: {
        enabled: officialNewsState !== 'BLOCKED', state: officialNewsState, authority: 'NONE',
        contentPolicy: 'OFFICIAL_FEEDS_AND_INDEXED_LINK_METADATA_ONLY', publisherFulltextStored: false, publisherExcerptsStored: false,
        sources: newsSources,
      },
      infra: readInfraStatus(root),
      discovery: discoveryStatus,
      youtube: video ? readVideoStatus(root) : {
        enabled: process.env.SOCIAL_VIDEO_ENABLED === 'true',
        state: process.env.SOCIAL_VIDEO_ENABLED === 'true' ? 'WITHHELD' : 'DISABLED',
        gate: process.env.SOCIAL_VIDEO_ENABLED === 'true' ? 'WITHHELD' : 'DISABLED',
        gateDetail: blockers.YOUTUBE ?? 'SOCIAL_VIDEO_ENABLED is not true',
        authority: 'NONE',
      },
      gateway: { matrix: readIf(path.join(root, 'gateway', 'matrix.json')), receipts: Object.fromEntries(['KRAKEN_STATUS', 'COINBASE_STATUS', 'OKX_STATUS'].map((id) => [id, budget.lanes[id]])) },
      rumor2: rumorStatus,
      persistence: getPersistence().health(),
      quotaPersistence: checkpoints?.status?.() ?? { state: 'DURABILITY_BLOCKED' },
    },
    budget,
  };
  atomicWriteJson(path.join(root, 'data-only', 'runtime-status.json'), status, { pretty: true, sync: process.platform !== 'win32' });
  return status;
}

clearInterval(startupHeartbeat);
lifecycle = 'ACTIVE';
startupPhase = 'COMPLETE';
writeRuntimeStatus();
const statusTimer = setInterval(() => { try { writeRuntimeStatus(); } catch (error) { log(`status write failed: ${bounded(error.message)}`); } }, 60_000);

const shutdown = onceAsync(async (signal) => {
  stopped = true;
  lifecycle = 'STOPPING';
  clearInterval(statusTimer);
  log(`shutdown requested (${signal})`);
  for (const handle of handles.reverse()) {
    try { await handle?.stop?.(); } catch (error) { log(`collector stop error: ${bounded(error.message)}`); }
  }
  try { await checkpoints?.close?.(); } catch (error) { log(`quota checkpoint stop error: ${error?.code ?? 'CHECKPOINT_CLOSE_FAILED'}`); }
  try { await persistence?.stop?.(); } catch (error) { log(`persistence stop error: ${bounded(error.message)}`); }
  lifecycle = 'STOPPED';
  try { writeRuntimeStatus(); } catch { }
  if (runtimeFd !== null) {
    try { closeSync(runtimeFd); } finally { runtimeFd = null; try { unlinkSync(runtimeLock); } catch { } }
  }
});

let terminalExitCode = 0;
function requestShutdown(signal, exitCode = 0) {
  terminalExitCode = Math.max(terminalExitCode, exitCode);
  shutdown(signal).then(() => process.exit(terminalExitCode), () => process.exit(1));
}
process.once('SIGINT', () => requestShutdown('SIGINT'));
process.once('SIGTERM', () => requestShutdown('SIGTERM'));
process.once('uncaughtException', (error) => { log(`uncaught exception: ${bounded(error.message)}`); requestShutdown('UNCAUGHT_EXCEPTION', 1); });
process.once('unhandledRejection', (error) => { log(`unhandled rejection: ${bounded(error?.message ?? error)}`); requestShutdown('UNHANDLED_REJECTION', 1); });

log(`active with ${catalog?.markets?.length ?? 0} equally eligible Kraken catalog markets; X post-read cap $15/month; trading imports absent`);
