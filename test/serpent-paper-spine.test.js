// RUNTIME COMPOSITION — PAPER spine (runtime unification step 3, 2026-09-14). The trading root folds onto the same
// spine the data-only mode runs: one single-instance lock per data dir (any mode), one status file, one durable
// external-quota restore, and the collector ADDITIONS the two-process split kept away from the ship (market catalogs,
// broad Kraken, public discovery). Proven with injected starters: no database, no network, no real collector. Pinned:
// the quota restore order and options, the additions' exact call set and options, the honest safety block, that NO
// process signal is bound by the spine in PAPER (the Tape stays the signal owner), the reverse-order stop with
// checkpoints closed before persistence, the one-lock law against a second instance in EITHER mode, and the
// fail-closed path when the durable restore is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPaperRuntime, startDataOnlyRuntime } from '../lib/serpent-runtime.js';
import { PAPER_DISCOVERY_ENV } from '../lib/collectors.js';
import { readDataOnlyRuntimeStatus } from '../lib/data-only-status.js';

const CATALOG = { contentId: 'cat-1', observedTs: 1_700_000_000_000, markets: [{ base: 'BBB' }, { base: 'AAA' }] };

function fakes({ restored = true } = {}) {
  const calls = [];
  const stops = [];
  const rec = (name, options) => { calls.push({ name, options }); };
  const handle = (name) => ({ stop: async () => { stops.push(name); }, status: () => ({ state: 'OK', name }) });
  const checkpoints = { blockers: {}, budget: { id: 'budget' }, market: { id: 'market' }, video: { id: 'video' }, discovery: { id: 'discovery' }, status: () => ({ state: 'RESTORED' }), close: async () => { stops.push('checkpoints'); } };
  const governor = { fetch: async () => { throw new Error('offline'); }, status: () => ({ state: 'ACTIVE', estimatedMonthUsd: 0, lanes: {} }) };
  const quotaStarters = {
    startPersistence: async (options) => { rec('startPersistence', options); return { health: () => ({ databaseConfigured: restored, restored }), stop: async () => { stops.push('persistence'); } }; },
    openDataOnlyCheckpoints: async (options) => { rec('openDataOnlyCheckpoints', options); return checkpoints; },
    createDataOnlyFetch: (options) => { rec('createDataOnlyFetch', options); return governor; },
  };
  const additionStarters = {
    startDataOnlyMarket: async (options) => { rec('startDataOnlyMarket', options); return handle('market'); },
    startBroadKraken: async (options) => { rec('startBroadKraken', options); return handle('broadMarket'); },
    startPublicDiscovery: (options) => { rec('startPublicDiscovery', options); return handle('discovery'); },
  };
  return { calls, stops, checkpoints, governor, quotaStarters, additionStarters };
}

const ENV = Object.freeze({ JUDGE_ENABLED: 'true', JUDGE_ALLOW_PRIVATE: 'false', JUDGE_ALLOW_ORDERS: 'false', MARKET_RESEARCH_ENABLED: 'true' });
const statusOf = (root) => JSON.parse(readFileSync(path.join(root, 'data-only', 'runtime-status.json'), 'utf8'));
const signalCounts = () => ({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM'), unc: process.listenerCount('uncaughtException'), rej: process.listenerCount('unhandledRejection') });

test('PR-1. PAPER folds onto the spine: lock, honest status, quota restore order, exact addition set, no signals, reverse stop', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-pr-'));
  const f = fakes();
  const before = signalCounts();
  try {
    const rt = await openPaperRuntime({ root, env: ENV, log: () => {}, quotaStarters: f.quotaStarters, additionStarters: f.additionStarters });
    assert.deepEqual(signalCounts(), before, 'the PAPER spine binds no process signal — the Tape stays the signal owner');
    assert.deepEqual(f.calls.map((c) => c.name), ['startPersistence', 'openDataOnlyCheckpoints', 'createDataOnlyFetch'], 'durable restore precedes every addition');
    const opt = (name) => f.calls.find((c) => c.name === name).options;
    assert.equal(opt('startPersistence').registerSignals, false, 'the spine owns persistence lifecycle, not persistence itself');
    assert.deepEqual(opt('createDataOnlyFetch'), { dataDir: root, maxMonthlyUsd: 0, durableCheckpoint: f.checkpoints.budget });

    const lockFile = path.join(root, 'data-only', 'runtime.lock');
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).mode, 'PAPER');

    const catalogAccessor = { snapshot: () => ({ catalog: CATALOG }) };
    const additions = await rt.startAdditions({ catalogAccessor });
    assert.deepEqual(f.calls.map((c) => c.name), ['startPersistence', 'openDataOnlyCheckpoints', 'createDataOnlyFetch', 'startDataOnlyMarket', 'startBroadKraken', 'startPublicDiscovery']);
    assert.deepEqual(opt('startDataOnlyMarket'), { env: ENV, dataDir: root, log: opt('startDataOnlyMarket').log, quotaJournal: f.checkpoints.market });
    assert.equal(opt('startBroadKraken').catalogSource, catalogAccessor); assert.equal(opt('startBroadKraken').dataDir, root);
    const disc = opt('startPublicDiscovery');
    assert.equal(disc.durableCheckpoint, f.checkpoints.discovery); assert.equal(disc.signals, false); assert.equal(disc.catalogSource, catalogAccessor);
    assert.deepEqual(disc.env, { ...ENV, ...PAPER_DISCOVERY_ENV }, 'the discovery additions run under the same bounded env as DATA_ONLY');
    assert.equal(additions.catalog, CATALOG);

    rt.markActive();
    const status = statusOf(root);
    assert.equal(status.version, 'serpent-paper-runtime-1'); assert.equal(status.mode, 'PAPER'); assert.equal(status.runId, rt.runId);
    assert.equal(status.lifecycle, 'ACTIVE'); assert.equal(status.startupPhase, 'COMPLETE'); assert.equal(status.running, true);
    assert.deepEqual(status.safety, { paperTrading: 'ON', realTrading: 'OFF', judgeEnabled: true, privateAccess: false, ordersAllowed: false, marketResearchModels: true, wideEyeNominations: true, entrypoint: 'fly.js' });
    assert.deepEqual(status.collectors.market, { state: 'OK', name: 'market' }); assert.deepEqual(status.collectors.broadMarket, { state: 'OK', name: 'broadMarket' });
    assert.deepEqual(status.collectors.quotaPersistence, { state: 'RESTORED' });

    await rt.shutdown('TEST');
    assert.deepEqual(f.stops, ['discovery', 'broadMarket', 'market', 'checkpoints', 'persistence'], 'additions stop in reverse start order, then the checkpoints close, then persistence stops');
    const stopped = statusOf(root);
    assert.equal(stopped.lifecycle, 'STOPPED'); assert.equal(stopped.running, false);
    assert.equal(existsSync(lockFile), false, 'the lock is released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PR-2. one instance per data dir in ANY mode: PAPER refuses a second PAPER, and refuses over a live DATA_ONLY lock', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-pr-'));
  const f = fakes();
  const startPaper = () => openPaperRuntime({ root, env: ENV, log: () => {}, quotaStarters: f.quotaStarters, additionStarters: f.additionStarters });
  try {
    const first = await startPaper();
    await assert.rejects(startPaper, /serpent runtime already active as pid/);
    // the DATA_ONLY spine on the SAME dir refuses too — one lock file, one instance, whatever the mode
    const g = fakes();
    await assert.rejects(
      () => startDataOnlyRuntime({ root, env: {}, config: { wideeye: { enabled: false }, gateway: { enabled: false }, universe: ['ZZZ'] }, log: () => {}, signals: false, quotaStarters: g.quotaStarters, collectorStarters: {} }),
      new RegExp(`data-only runtime already active as pid ${process.pid}`)
    );
    await first.shutdown('TEST');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PR-3. durable restore unavailable → fail closed: no quota-bearing addition is constructed, the free public capture still runs, status says why', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-pr-'));
  const f = fakes({ restored: false });
  try {
    const rt = await openPaperRuntime({ root, env: ENV, log: () => {}, quotaStarters: f.quotaStarters, additionStarters: f.additionStarters });
    await rt.startAdditions({ catalogAccessor: { snapshot: () => ({ catalog: CATALOG }) } });
    assert.deepEqual(f.calls.map((c) => c.name), ['startPersistence', 'startBroadKraken'], 'no checkpoints → no market catalogs, no discovery; the free public capture still runs');
    rt.markActive();
    const status = statusOf(root);
    assert.equal(status.blockers.PERSISTENCE, 'PERSISTENCE_RESTORE_FAILED'); assert.equal(status.blockers.MARKET, 'MARKET_QUOTA_NOT_RESTORED'); assert.equal(status.blockers.PUBLIC_DISCOVERY, 'DISCOVERY_QUOTA_NOT_RESTORED');
    assert.equal(status.budget.state, 'DURABILITY_BLOCKED'); assert.deepEqual(status.collectors.quotaPersistence, { state: 'DURABILITY_BLOCKED' });
    assert.deepEqual(status.collectors.market, { state: 'BLOCKED', authority: 'NONE', reason: 'MARKET_QUOTA_NOT_RESTORED' });
    await rt.shutdown('TEST');
    assert.deepEqual(f.stops, ['broadMarket', 'persistence'], 'the started persistence handle is still stopped even though its restore failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PR-4 (step 5). mode-agnostic paths: canonical serpent/ lock + status with byte-equal data-only/ mirrors in BOTH modes; a pre-step-5 legacy lock still refuses; readers prefer the canonical file', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'serpent-pr-'));
  const canonicalLock = path.join(root, 'serpent', 'runtime.lock');
  const legacyLock = path.join(root, 'data-only', 'runtime.lock');
  const canonicalStatus = path.join(root, 'serpent', 'runtime-status.json');
  const legacyStatus = path.join(root, 'data-only', 'runtime-status.json');
  try {
    // PAPER: canonical + mirror exist and agree; both are gone on release
    const f = fakes();
    const rt = await openPaperRuntime({ root, env: ENV, log: () => {}, quotaStarters: f.quotaStarters, additionStarters: f.additionStarters });
    for (const file of [canonicalLock, legacyLock, canonicalStatus, legacyStatus]) assert.ok(existsSync(file), `${path.basename(path.dirname(file))}/${path.basename(file)} exists`);
    assert.equal(readFileSync(canonicalLock, 'utf8'), readFileSync(legacyLock, 'utf8'), 'the legacy lock mirrors the canonical identity');
    assert.equal(readFileSync(canonicalStatus, 'utf8'), readFileSync(legacyStatus, 'utf8'), 'the legacy status mirrors the canonical one');
    // the status reader prefers the canonical file: corrupt the mirror, the evaluation still sees the real run
    writeFileSync(legacyStatus, '{not json');
    const read = readDataOnlyRuntimeStatus({ root, checkPid: false });
    assert.equal(read.status?.runId, rt.runId, 'the reader evaluated the canonical serpent/ status');
    await rt.shutdown('TEST');
    for (const file of [canonicalLock, legacyLock]) assert.equal(existsSync(file), false, 'both locks released');

    // DATA_ONLY on the same helpers: canonical + mirror as well
    const g = fakes();
    const rt2 = await startDataOnlyRuntime({ root, env: {}, config: { wideeye: { enabled: false }, gateway: { enabled: false }, universe: ['ZZZ'] }, log: () => {}, signals: false, quotaStarters: g.quotaStarters, collectorStarters: { startDataOnlyMarket: async () => null, startWideEye: () => null, startBroadKraken: async () => null, startInfra: () => null, startVideo: () => null, startPublicDiscovery: () => null, startGateway: () => null, startRumor2: () => null } });
    assert.ok(existsSync(canonicalLock) && existsSync(legacyLock), 'DATA_ONLY writes both locks');
    assert.equal(readFileSync(canonicalStatus, 'utf8'), readFileSync(legacyStatus, 'utf8'), 'DATA_ONLY mirrors the status');
    await rt2.shutdown('TEST');

    // a pre-step-5 process announced only through the LEGACY lock is still refused while alive, recovered when dead
    mkdirSync(path.join(root, 'data-only'), { recursive: true });
    writeFileSync(legacyLock, JSON.stringify({ pid: process.pid }));
    await assert.rejects(() => openPaperRuntime({ root, env: ENV, log: () => {}, quotaStarters: fakes().quotaStarters }), /serpent runtime already active as pid/);
    assert.equal(existsSync(canonicalLock), false, 'the refused instance left nothing behind');
    unlinkSync(legacyLock);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
