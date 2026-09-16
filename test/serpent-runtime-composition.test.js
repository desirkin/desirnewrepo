// RUNTIME COMPOSITION (runtime unification step 2, 2026-09-14). The spine is proven with injected starters: no database,
// no network, no real collector. What is pinned: the exact starter call ORDER and the options each starter receives in
// DATA_ONLY, the startup phases in order, the runtime-status.json shape, the reverse-order stop with checkpoints closed
// before persistence, the lock refusing a second instance on the same data dir, and the fail-closed path when the
// durable restore is unavailable (no collector that needs a quota is constructed; the governor refuses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startDataOnlyRuntime } from '../lib/serpent-runtime.js';

const CONFIG = { wideeye: { enabled: false }, gateway: { enabled: false }, universe: ['ZZZ'] };
const CATALOG = { contentId: 'cat-1', observedTs: 1_700_000_000_000, markets: [{ base: 'BBB' }, { base: 'AAA' }, { base: 'BBB' }] };

function fakes({ restored = true } = {}) {
  const calls = [];
  const stops = [];
  const rec = (name, options) => { calls.push({ name, options }); };
  const handle = (name, extra = {}) => ({ stop: async () => { stops.push(name); }, status: () => ({ state: 'OK', name }), ...extra });
  const checkpoints = { blockers: {}, budget: { id: 'budget' }, market: { id: 'market' }, video: { id: 'video' }, discovery: { id: 'discovery' }, status: () => ({ state: 'RESTORED' }), close: async () => { stops.push('checkpoints'); } };
  const governor = { fetch: async () => { throw new Error('offline'); }, status: () => ({ state: 'ACTIVE', estimatedMonthUsd: 0, lanes: { KRAKEN_STATUS: 1, COINBASE_STATUS: 2, OKX_STATUS: 3 } }) };
  const wideEye = handle('wideEye', {
    _refreshCatalog: async () => { calls.push({ name: '_refreshCatalog' }); },
    _sweepOnce: async () => { calls.push({ name: '_sweepOnce' }); },
    catalogSnapshot: () => ({ catalog: CATALOG }), researchNotices: () => [], sweepPopulationSnapshot: () => null,
  });
  const quotaStarters = {
    startPersistence: async (options) => { rec('startPersistence', options); return handle('persistence', { health: () => ({ databaseConfigured: restored, restored }) }); },
    openDataOnlyCheckpoints: async (options) => { rec('openDataOnlyCheckpoints', options); return checkpoints; },
    createDataOnlyFetch: (options) => { rec('createDataOnlyFetch', options); return governor; },
  };
  const collectorStarters = {
    startDataOnlyMarket: async (options) => { rec('startDataOnlyMarket', options); return handle('market'); },
    startWideEye: (options) => { rec('startWideEye', options); return wideEye; },
    startBroadKraken: async (options) => { rec('startBroadKraken', options); return handle('broadMarket'); },
    startVideo: (options) => { rec('startVideo', options); return handle('video', { gate: () => ({ ok: true }) }); },
    startPublicDiscovery: (options) => { rec('startPublicDiscovery', options); return handle('discovery'); },
    startGateway: (options) => { rec('startGateway', options); return handle('gateway'); },
    startRumor2: (options) => { rec('startRumor2', options); return handle('rumor2', { tickOnce: async () => { calls.push({ name: 'tickOnce' }); }, status: () => null }); },
  };
  return { calls, stops, checkpoints, governor, quotaStarters, collectorStarters };
}

const ENV = Object.freeze({ SOCIAL_VIDEO_ENABLED: 'true', SERPENT_HTTP_CONTACT: 'ops@example.test' });
const statusOf = (root) => JSON.parse(readFileSync(path.join(root, 'data-only', 'runtime-status.json'), 'utf8'));

test('RC-1. DATA_ONLY composes the starters in the published order with the published options, then reports ACTIVE', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-rc-'));
  const f = fakes();
  const phases = [];
  const log = (line) => { const m = /^\[DATA-ONLY [^\]]+\] (.*)$/.exec(line); assert.ok(m, `every log line carries the runtime stamp: ${line}`); phases.push(m[1]); };
  try {
    const rt = await startDataOnlyRuntime({ root, env: ENV, config: CONFIG, log, signals: false, quotaStarters: f.quotaStarters, collectorStarters: f.collectorStarters });
    assert.deepEqual(f.calls.map((c) => c.name), [
      'startPersistence', 'openDataOnlyCheckpoints', 'createDataOnlyFetch',
      'startDataOnlyMarket', 'startWideEye', '_refreshCatalog', '_sweepOnce', 'startBroadKraken', 'startVideo', 'startPublicDiscovery', 'startGateway', 'startRumor2', 'tickOnce',
    ]);
    const opt = (name) => f.calls.find((c) => c.name === name).options;
    assert.deepEqual(opt('startPersistence'), { log: opt('startPersistence').log, registerSignals: false });
    assert.equal(opt('openDataOnlyCheckpoints').dataDir, root); assert.equal(opt('openDataOnlyCheckpoints').env, ENV);
    assert.deepEqual(opt('createDataOnlyFetch'), { dataDir: root, maxMonthlyUsd: 0, durableCheckpoint: f.checkpoints.budget });
    assert.deepEqual(opt('startDataOnlyMarket'), { env: ENV, dataDir: root, log: opt('startDataOnlyMarket').log, quotaJournal: f.checkpoints.market });
    const we = opt('startWideEye');
    assert.equal(we.config, CONFIG); assert.equal(we.fetchImpl, f.governor.fetch); assert.equal(we.registerSignals, false); assert.equal(we.nominationEnabled, false); assert.deepEqual([...we.deepCoinsSource()], []);
    const broad = opt('startBroadKraken');
    assert.equal(broad.dataDir, root); assert.deepEqual(broad.catalogSource.snapshot(), { catalog: CATALOG });
    // LEAN PASS 4a: the infra observation tier is retired — startInfra is no longer composed.
    assert.equal(f.calls.find((c) => c.name === 'startInfra'), undefined);
    assert.deepEqual(opt('startVideo'), { env: ENV, dataDir: root, log: opt('startVideo').log, signals: false, durableCheckpoint: f.checkpoints.video });
    const disc = opt('startPublicDiscovery');
    assert.equal(disc.durableCheckpoint, f.checkpoints.discovery); assert.equal(disc.signals, false); assert.equal(disc.catalogSource, broad.catalogSource);
    assert.deepEqual(disc.env, { ...ENV, DISCOVERY_ENABLED: 'true', DISCOVERY_SOURCES: 'GDELT_NEWS_DISCOVERY,POLYMARKET_PUBLIC_DATA,KALSHI_PUBLIC_DATA', DISCOVERY_GDELT_MAX_DAILY_REQUESTS: '16', DISCOVERY_GDELT_RESULT_LIMIT: '50', DISCOVERY_GDELT_ASSETS_PER_QUERY: '12', DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS: '48', DISCOVERY_KALSHI_MAX_DAILY_REQUESTS: '48', DISCOVERY_POLYMARKET_PAGE_LIMIT: '100', DISCOVERY_KALSHI_PAGE_LIMIT: '1000' });
    const gw = opt('startGateway');
    assert.equal(gw.config, CONFIG); assert.equal(gw.fetchImpl, f.governor.fetch); assert.equal(gw.dataRoot, root); assert.equal(gw.universeSource, broad.catalogSource); assert.equal(gw.signals, false);
    const r2 = opt('startRumor2');
    assert.deepEqual(r2.config, { ...CONFIG, universe: ['AAA', 'BBB'] }, 'the social universe is the de-duplicated, sorted accepted catalog — never the config universe');
    assert.equal(r2.fetchImpl, f.governor.fetch);
    assert.deepEqual({ enabled: r2.enabled, contact: r2.contact, edgarEnabled: r2.edgarEnabled, ofacEnabled: r2.ofacEnabled, socialBlueskyEnabled: r2.socialBlueskyEnabled, socialXEnabled: r2.socialXEnabled, socialFarcasterEnabled: r2.socialFarcasterEnabled, socialCurrentEnabled: r2.socialCurrentEnabled, researchStrainer: r2.researchStrainer },
      { enabled: true, contact: 'ops@example.test', edgarEnabled: false, ofacEnabled: true, socialBlueskyEnabled: true, socialXEnabled: true, socialFarcasterEnabled: true, socialCurrentEnabled: false, researchStrainer: null });
    assert.deepEqual(r2.researchCatalogSource.snapshot(), { catalog: CATALOG }); assert.equal(r2.researchCatalogSource.deepObservation(), null); assert.deepEqual(r2.officialCatalogSource(), { catalog: CATALOG });
    assert.ok(typeof r2.checkpointStore.load === 'function' && typeof r2.journal === 'object', 'the durable stores are the persistence-backed ones');

    const status = statusOf(root);
    assert.equal(status.version, 'serpent-data-only-runtime-2'); assert.equal(status.runId, rt.runId); assert.equal(status.lifecycle, 'ACTIVE'); assert.equal(status.startupPhase, 'COMPLETE'); assert.equal(status.running, true); assert.equal(status.authority, 'NONE');
    assert.deepEqual(status.safety, { paperTrading: 'OFF', realTrading: 'OFF', judgeEnabled: false, privateAccess: false, ordersAllowed: false, marketResearchModels: false, wideEyeNominations: false, entrypoint: 'tools/data-only-runtime.mjs' });
    assert.deepEqual(status.catalog, { contentId: 'cat-1', observedTs: CATALOG.observedTs, markets: 3, policy: 'FULL_ACCEPTED_KRAKEN_USD_CATALOG_EQUAL_EVERY_SWEEP', namedPreference: false });
    assert.deepEqual(status.blockers, { PRESS: status.blockers.PRESS }, 'nothing blocked'); assert.match(status.blockers.PRESS, /Publisher RSS terms are unverified/);
    assert.deepEqual(status.collectors.market, { state: 'OK', name: 'market' }); assert.deepEqual(status.collectors.broadMarket, { state: 'OK', name: 'broadMarket' });
    assert.deepEqual(status.collectors.gateway.receipts, { KRAKEN_STATUS: 1, COINBASE_STATUS: 2, OKX_STATUS: 3 }); assert.deepEqual(status.collectors.quotaPersistence, { state: 'RESTORED' });
    assert.equal(status.collectors.news.state, 'BLOCKED', 'no provider status yet → official feeds BLOCKED_RUNTIME');
    assert.ok(existsSync(path.join(root, 'data-only', 'runtime.lock')));
    assert.match(phases.at(-1), /^active with 3 equally eligible Kraken catalog markets/);

    await rt.shutdown('TEST');
    assert.deepEqual(f.stops, ['rumor2', 'gateway', 'discovery', 'video', 'broadMarket', 'wideEye', 'market', 'checkpoints', 'persistence'], 'collectors stop in reverse start order, then the checkpoints close, then persistence stops');
    const stopped = statusOf(root);
    assert.equal(stopped.lifecycle, 'STOPPED'); assert.equal(stopped.running, false);
    assert.equal(existsSync(path.join(root, 'data-only', 'runtime.lock')), false, 'the lock is released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RC-2. the lock refuses a second instance on the same data dir and is recovered only from a dead pid', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-rc-'));
  const f = fakes();
  const start = () => startDataOnlyRuntime({ root, env: ENV, config: CONFIG, log: () => {}, signals: false, quotaStarters: f.quotaStarters, collectorStarters: f.collectorStarters });
  try {
    const first = await start();
    await assert.rejects(start, new RegExp(`data-only runtime already active as pid ${process.pid}`));
    assert.equal(f.calls.filter((c) => c.name === 'startPersistence').length, 1, 'the refused instance touched nothing');
    await first.shutdown('TEST');
    const lock = path.join(root, 'data-only', 'runtime.lock');
    writeFileSync(lock, JSON.stringify({ pid: 0 }));
    await assert.rejects(start, /lock has an invalid pid; manual review required/);
    writeFileSync(lock, '{not json');
    await assert.rejects(start, /lock is unreadable; manual review required/);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(lock, JSON.stringify({ pid: dead }));
    const second = await start();
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid, 'the stale lock of a stopped pid is recovered and re-owned');
    await second.shutdown('TEST');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RC-3. durable restore unavailable → fail closed: no quota-bearing collector is constructed, the governor refuses, RUMOR-2 is withheld, status says why', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-rc-'));
  const f = fakes({ restored: false });
  try {
    const rt = await startDataOnlyRuntime({ root, env: ENV, config: CONFIG, log: () => {}, signals: false, quotaStarters: f.quotaStarters, collectorStarters: f.collectorStarters });
    assert.deepEqual(f.calls.map((c) => c.name), ['startPersistence', 'startWideEye', '_refreshCatalog', '_sweepOnce', 'startBroadKraken', 'startGateway'], 'no checkpoints → no market catalogs, no YouTube (enabled without a quota), no discovery, no RUMOR-2; the free public collectors still run');
    const status = statusOf(root);
    assert.equal(status.blockers.PERSISTENCE, 'PERSISTENCE_RESTORE_FAILED'); assert.equal(status.blockers.BUDGET, 'DATA_ONLY_QUOTA_NOT_RESTORED'); assert.equal(status.blockers.MARKET, 'MARKET_QUOTA_NOT_RESTORED');
    assert.equal(status.blockers.YOUTUBE, 'YOUTUBE_QUOTA_NOT_RESTORED'); assert.equal(status.blockers.PUBLIC_DISCOVERY, 'DISCOVERY_QUOTA_NOT_RESTORED'); assert.match(status.blockers.RUMOR2, /durable PostgreSQL restore or quota ownership unavailable/);
    assert.equal(status.budget.state, 'DURABILITY_BLOCKED'); assert.deepEqual(status.collectors.quotaPersistence, { state: 'DURABILITY_BLOCKED' });
    assert.deepEqual(status.collectors.market, { state: 'BLOCKED', authority: 'NONE', reason: 'MARKET_QUOTA_NOT_RESTORED' });
    assert.equal(status.collectors.youtube.state, 'WITHHELD');
    await rt.shutdown('TEST');
    assert.deepEqual(f.stops, ['gateway', 'broadMarket', 'wideEye', 'persistence'], 'the started persistence handle is still stopped even though its restore failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
