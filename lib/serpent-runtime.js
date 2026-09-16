// lib/serpent-runtime.js — the runtime spine (runtime unification steps 1–2, 2026-09-14).
// Owns what every mode shares and nothing else: the single-instance lock, runtime-status.json, the ordered shutdown and
// the process signals. Durable restore lives in ./external-quota.js, the collector set in ./collectors.js; both are
// injectable so test/serpent-runtime-composition.test.js proves the composition with no database and no network.
// Step 3 (docs/serpent/RUNTIME-UNIFICATION.md) folds the PAPER root onto this spine with a mode. This module still imports
// no trading composition: fly.js, paper/, judge/, execution/, watch/, tape/run.js, bin/cobra.js are absent from its import
// graph (test/data-only-runtime.test.mjs).
import path from 'node:path';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dataDir as resolveDataDir } from './config.js';
import { atomicWriteJson, readJsonBounded } from './jsonl.js';
import { readWideEyeStatus } from '../survey/reader.js';
import { readDiscoveryStatus } from '../discovery/reader.js';
import { getPersistence } from '../persistence/runtime.js';
import { restoreExternalQuota } from './external-quota.js';
import { startSharedCollectors, startPaperCollectorAdditions } from './collectors.js';
import { onceAsync, dataOnlySpending, bounded } from './data-only-lifecycle.js';
import { openObjectStore } from '../persistence/object-store.js';
import { restoreObjectStoreOnBoot } from '../persistence/object-restore.js';
import { createObjectUploader } from '../persistence/object-uploader.js';

// PERSIST-1 bulk durability, shared by every mode. Open the durable object store, RESTORE the backed bulk streams onto
// local disk BEFORE any collector or the tape reads them (a Replit republish wipes the container filesystem), then, when
// the store is ACTIVE, start the uploader mirroring on a timer and push a stoppable handle that drains one final sync on
// shutdown. A DISABLED / NOT_COMMISSIONED / MISCONFIGURED store is a dark no-op, never a boot failure. Authority NONE.
export const BULK_UPLOAD_INTERVAL_MS = 60_000;
async function openBulkDurability({ root, env, log, phase, handles, now = () => Date.now(), timers = { setInterval, clearInterval } }) {
  phase?.('BULK_RESTORE');
  const store = await openObjectStore({ env, log });
  const restore = await restoreObjectStoreOnBoot({ store, dataRoot: root, log, now });
  let uploader = null;
  if (store.state === 'ACTIVE') {
    uploader = createObjectUploader({ store, dataRoot: root, log, now });
    try { await uploader.syncOnce(); } catch (error) { log(`OBJECT UPLOADER initial sync failed: ${bounded(error?.message ?? error)}`); }
    const timer = timers.setInterval(() => { uploader.syncOnce().catch((error) => log(`OBJECT UPLOADER sync failed: ${bounded(error?.message ?? error)}`)); }, BULK_UPLOAD_INTERVAL_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    handles.push({ stop: async () => { timers.clearInterval(timer); try { await uploader.syncOnce(); } catch (error) { log(`OBJECT UPLOADER final sync failed: ${bounded(error?.message ?? error)}`); } } });
  }
  const status = () => Object.freeze({ provider: store.provider, state: store.state, restore, upload: uploader?.status?.() ?? null });
  return { store, restore, uploader, status };
}

// ONE stale-lock law for every mode: recover only a proven dead PID; an unreadable or live lock fails closed.
function recoverStaleLock(file, label, log) {
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

// Mode-agnostic runtime paths (runtime unification step 5, 2026-09-14): the canonical single-instance lock and status
// file live under serpent/ for EVERY mode. The old data-only/ paths are written as compatibility mirrors for one
// release — a pre-step-5 process is still refused through its legacy lock, and old tooling keeps reading its old
// paths — and the mirrors go at step 6.
function acquireRuntimeLock({ root, label, log, identity }) {
  mkdirSync(path.join(root, 'serpent'), { recursive: true });
  mkdirSync(path.join(root, 'data-only'), { recursive: true });
  const canonical = path.join(root, 'serpent', 'runtime.lock');
  const legacy = path.join(root, 'data-only', 'runtime.lock');
  recoverStaleLock(canonical, label, log);
  recoverStaleLock(legacy, label, log);
  const fd = openSync(canonical, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify(identity));
  writeFileSync(legacy, JSON.stringify(identity), { mode: 0o600 });
  let open = true;
  return {
    release() {
      if (!open) return;
      open = false;
      try { closeSync(fd); } finally { try { unlinkSync(canonical); } catch { } try { unlinkSync(legacy); } catch { } }
    },
  };
}
function writeRuntimeStatusFiles(root, status, opts) {
  atomicWriteJson(path.join(root, 'serpent', 'runtime-status.json'), status, opts);
  atomicWriteJson(path.join(root, 'data-only', 'runtime-status.json'), status, opts);
}

// Returns { runId, shutdown, writeRuntimeStatus }. `signals` (default true) binds SIGINT/SIGTERM and the fatal handlers to
// an exiting shutdown; the composition test passes false and drives `shutdown` itself.
export async function startDataOnlyRuntime({ root = resolveDataDir(), env = process.env, config, log: logImpl = console.log, signals = true, quotaStarters, collectorStarters, entrypoint = 'tools/data-only-runtime.mjs' } = {}) {
  const log = (message) => logImpl(`[DATA-ONLY ${new Date().toISOString()}] ${message}`);

  const startedTs = Date.now();
  const runId = `${startedTs}-${process.pid}`;
  const runtimeLock = acquireRuntimeLock({ root, label: 'data-only runtime', log, identity: { pid: process.pid, openedTs: startedTs, runId, authority: 'NONE' } });
  let lifecycle = 'STARTING';
  let startupPhase = 'LOCK_ACQUIRED';
  const phase = (name) => { startupPhase = name; };

  function writeStartupStatus() {
    writeRuntimeStatusFiles(root, {
      version: 'serpent-data-only-runtime-2', tsMs: Date.now(), pid: process.pid,
      startedTs, runId, running: true, lifecycle, startupPhase, authority: 'NONE',
      safety: { paperTrading: 'OFF', realTrading: 'OFF', judgeEnabled: false,
        privateAccess: false, ordersAllowed: false, marketResearchModels: false,
        wideEyeNominations: false, entrypoint },
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
  recoverStaleLock(path.join(root, 'public-discovery', 'writer.lock'), 'public discovery writer', log);

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
  let stopped = false;

  const { persistence, checkpoints, governor } = await restoreExternalQuota({ root, env, log, blockers, phase, starters: quotaStarters });
  // PERSIST-1: restore the durable bulk streams onto disk BEFORE the collectors read them, then keep them mirrored.
  const bulk = await openBulkDurability({ root, env, log, phase, handles });
  const { wideEye, rumor2, market, broadMarket, publicDiscovery, catalog } = await startSharedCollectors({ root, config, env, governor, checkpoints, blockers, handles, log, phase, starters: collectorStarters });

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
        entrypoint,
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
        discovery: discoveryStatus,
        gateway: { matrix: readIf(path.join(root, 'gateway', 'matrix.json')), receipts: Object.fromEntries(['KRAKEN_STATUS', 'COINBASE_STATUS', 'OKX_STATUS'].map((id) => [id, budget.lanes[id]])) },
        rumor2: rumorStatus,
        persistence: getPersistence().health(),
        quotaPersistence: checkpoints?.status?.() ?? { state: 'DURABILITY_BLOCKED' },
        objectStore: bulk.status(),
      },
      budget,
    };
    writeRuntimeStatusFiles(root, status, { pretty: true, sync: process.platform !== 'win32' });
    return status;
  }

  clearInterval(startupHeartbeat);
  lifecycle = 'ACTIVE';
  phase('COMPLETE');
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
    runtimeLock.release();
  });

  if (signals) {
    let terminalExitCode = 0;
    const requestShutdown = (signal, exitCode = 0) => {
      terminalExitCode = Math.max(terminalExitCode, exitCode);
      shutdown(signal).then(() => process.exit(terminalExitCode), () => process.exit(1));
    };
    process.once('SIGINT', () => requestShutdown('SIGINT'));
    process.once('SIGTERM', () => requestShutdown('SIGTERM'));
    process.once('uncaughtException', (error) => { log(`uncaught exception: ${bounded(error.message)}`); requestShutdown('UNCAUGHT_EXCEPTION', 1); });
    process.once('unhandledRejection', (error) => { log(`unhandled rejection: ${bounded(error?.message ?? error)}`); requestShutdown('UNHANDLED_REJECTION', 1); });
  }

  log(`active with ${catalog?.markets?.length ?? 0} equally eligible Kraken catalog markets; X post-read cap $15/month; trading imports absent`);
  return { runId, shutdown, writeRuntimeStatus };
}

// ---- PAPER spine (runtime unification step 3, 2026-09-14) ----------------------------------------------------------
// fly.js — the trading root — folds onto this SAME spine: one single-instance lock per data dir (any mode), one
// startup / ACTIVE / STOPPED status file, one durable external-quota restore, and the collector additions the
// two-process split kept away from the ship (market catalogs, broad Kraken capture, public discovery). This module
// still imports no trading tier: the wide eye's catalog arrives as a read-only accessor parameter, and every trading
// component stays in the root. Signals are NEVER bound here in PAPER — the Tape remains the signal owner, and the root
// drives `shutdown` after the tape has drained, so the ordered stop (additions in reverse, checkpoints closed,
// persistence stopped, lock released) runs last.
export async function openPaperRuntime({ root = resolveDataDir(), env = process.env, log: logImpl = console.log, entrypoint = 'fly.js', quotaStarters, additionStarters } = {}) {
  const log = (message) => logImpl(`[SERPENT PAPER ${new Date().toISOString()}] ${message}`);
  const startedTs = Date.now();
  const runId = `${startedTs}-${process.pid}`;
  const runtimeLock = acquireRuntimeLock({ root, label: 'serpent runtime', log, identity: { pid: process.pid, openedTs: startedTs, runId, mode: 'PAPER' } });
  let lifecycle = 'STARTING';
  let startupPhase = 'LOCK_ACQUIRED';
  let stopped = false;
  const phase = (name) => { startupPhase = name; };

  const handles = [];
  const blockers = {};
  let additions = { market: null, broadMarket: null, publicDiscovery: null, catalog: null };
  let statusTimer = null;
  // The durable restore has not run yet when the first identity status is written; until it does, the budget reports
  // DURABILITY_BLOCKED honestly rather than a fabricated zero.
  let persistence = null;
  let checkpoints = null;
  let governor = { fetch: async () => { throw new Error('DATA_ONLY_QUOTA_NOT_RESTORED'); }, status: () => ({ state: 'DURABILITY_BLOCKED', estimatedMonthUsd: null, lanes: {} }) };
  let bulk = null; // PERSIST-1 bulk durability; opened after the identity status, before the root reads any file

  function writeRuntimeStatus() {
    const status = {
      version: 'serpent-paper-runtime-1', mode: 'PAPER', tsMs: Date.now(), pid: process.pid,
      startedTs, runId, running: !stopped, lifecycle, startupPhase, authority: 'PAPER_TRADING_ONLY',
      safety: {
        paperTrading: 'ON', realTrading: 'OFF',
        judgeEnabled: env.JUDGE_ENABLED === 'true',
        privateAccess: env.JUDGE_ALLOW_PRIVATE === 'true',
        ordersAllowed: env.JUDGE_ALLOW_ORDERS === 'true',
        marketResearchModels: env.MARKET_RESEARCH_ENABLED === 'true',
        wideEyeNominations: true, entrypoint,
      },
      blockers,
      collectors: {
        market: additions.market?.status?.() ?? { state: 'BLOCKED', authority: 'NONE', reason: blockers.MARKET ?? 'market observation unavailable' },
        broadMarket: additions.broadMarket?.status?.() ?? { state: 'BLOCKED', authority: 'NONE', reason: blockers.BROAD_MARKET ?? blockers.KRAKEN_CATALOG ?? 'broad market capture unavailable' },
        persistence: getPersistence().health(),
        quotaPersistence: checkpoints?.status?.() ?? { state: 'DURABILITY_BLOCKED' },
        objectStore: bulk?.status?.() ?? { state: 'PENDING' },
      },
      budget: governor.status(),
    };
    writeRuntimeStatusFiles(root, status, { pretty: true, sync: process.platform !== 'win32' });
    return status;
  }
  // Publish this process's identity before database work, exactly like the data-only spine.
  writeRuntimeStatus();
  const startupHeartbeat = setInterval(() => {
    try { writeRuntimeStatus(); } catch (error) { log(`startup status write failed: ${bounded(error.message)}`); }
  }, 15_000);

  ({ persistence, checkpoints, governor } = await restoreExternalQuota({ root, env, log, blockers, phase, starters: quotaStarters }));
  // PERSIST-1: restore the durable bulk streams onto disk before the root starts the tape or any collector, then mirror.
  bulk = await openBulkDurability({ root, env, log, phase, handles });

  // The additions start only once the root's own wide eye exists (its catalog accessor gates broad capture and
  // discovery, exactly as in DATA_ONLY). Everything the root already starts — tape, cockpit, senses, Judge — stays
  // in the root; nothing here may construct it.
  async function startAdditions({ catalogAccessor = null } = {}) {
    additions = await startPaperCollectorAdditions({ root, env, governor, checkpoints, blockers, handles, log, phase, catalogAccessor, starters: additionStarters });
    return additions;
  }

  function markActive() {
    clearInterval(startupHeartbeat);
    lifecycle = 'ACTIVE';
    phase('COMPLETE');
    writeRuntimeStatus();
    statusTimer = setInterval(() => { try { writeRuntimeStatus(); } catch (error) { log(`status write failed: ${bounded(error.message)}`); } }, 60_000);
  }

  const shutdown = onceAsync(async (signal) => {
    stopped = true;
    lifecycle = 'STOPPING';
    clearInterval(startupHeartbeat);
    if (statusTimer) clearInterval(statusTimer);
    log(`shutdown requested (${signal})`);
    for (const handle of handles.reverse()) {
      try { await handle?.stop?.(); } catch (error) { log(`collector stop error: ${bounded(error.message)}`); }
    }
    try { await checkpoints?.close?.(); } catch (error) { log(`quota checkpoint stop error: ${error?.code ?? 'CHECKPOINT_CLOSE_FAILED'}`); }
    try { await persistence?.stop?.(); } catch (error) { log(`persistence stop error: ${bounded(error.message)}`); }
    lifecycle = 'STOPPED';
    try { writeRuntimeStatus(); } catch { }
    runtimeLock.release();
  });

  return { runId, blockers, persistence, checkpoints, governor, startAdditions, markActive, writeRuntimeStatus, shutdown, log };
}
