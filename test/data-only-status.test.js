import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DATA_ONLY_BROAD_MARKET_MAX_ROWS,
  DATA_ONLY_HEARTBEAT_MAX_AGE_MS,
  evaluateDataOnlyRuntimeStatus,
  readDataOnlyRuntimeStatus,
  dataOnlyPublicStatus,
  dataOnlySensorSnapshot,
  dataOnlyMarketView,
} from '../lib/data-only-status.js';
import { sensorSnapshot } from '../paper/readiness.js';
import { loadProfile, profileEnvironment } from '../paper/profile.js';
import { loadConfig } from '../lib/config.js';

const NOW = Date.parse('2026-09-13T16:00:00.000Z');
const STARTED = NOW - 10_000;
const base = (overrides = {}) => ({
  version: 'serpent-data-only-runtime-2', tsMs: NOW - 1_000, pid: 4242,
  startedTs: STARTED, running: true, lifecycle: 'ACTIVE', startupPhase: 'READY',
  authority: 'NONE', safety: { realTrading: 'OFF' }, collectors: {}, ...overrides,
});
const lock = (overrides = {}) => ({ pid: 4242, openedTs: STARTED, authority: 'NONE', ...overrides });
const broadMarket = ({ markets = 70, state = 'ACTIVE', receivedTs = NOW - 1_000, overrides = {} } = {}) => {
  const perMarket = Array.from({ length: markets }, (_, index) => ({
    canonicalCoin: `COIN${index}`,
    pairKey: `COIN${index}/USD`,
    nativeBase: `XCOIN${index}`,
    catalogWsname: `COIN${index}/USD`,
    wsSymbol: `COIN${index}/USD`,
    mappingState: 'MAPPED',
    ticker: { state: 'FRESH', persisted: true, lastReceivedTs: receivedTs, sourceEventTs: receivedTs - 1, ageMs: 1_000, lastPrice: 10 + index, volume24hBase: 1_000 + index, vwap24h: 10 + index },
    candle: { state: 'PROVISIONAL_FRESH', persisted: true, periodStartTs: Math.floor(receivedTs / 60_000) * 60_000, periodEndTs: (Math.floor(receivedTs / 60_000) + 1) * 60_000, lastReceivedTs: receivedTs, ageMs: 1_000, quality: 'PROVISIONAL', close: 10 + index, volumeBase: 100 + index, learningEligible: false },
    channels: { ticker: 'SUBSCRIBED', ohlc: 'SUBSCRIBED' },
    lastError: null,
  }));
  return {
    version: 'broad-kraken-1', state, startedTs: STARTED,
    catalog: { state: 'ACCEPTED', contentId: 'b'.repeat(40), observedTs: NOW - 5_000, markets, attempted: markets, lastCheckedTs: NOW - 5_000, lastError: null, maxAgeMs: 900_000 },
    instrument: { state: 'READY', receivedTs: NOW - 4_000, pairs: markets, mapped: markets, unsupported: 0, ambiguous: 0, lastError: null },
    socket: { state: state === 'CONNECTING' ? 'CONNECTING' : 'OPEN', epoch: 1, messages: markets * 2, bytes: markets * 100, dropped: 0, invalidJson: 0, reconnects: 0, openedTs: NOW - 4_000, lastMessageTs: receivedTs },
    subscription: { queueDepth: 0, requestsSent: markets * 2, ackedTicker: markets, ackedOhlc: markets, failedTicker: 0, failedOhlc: 0 },
    recording: { state: 'ACTIVE', dir: 'C:/private/broad-capture', segment: 'private-name.jsonl', segments: 1, bytes: markets * 200, records: markets * 2, queued: 0, maxQueue: 10_000, unflushedRecords: 0, evictedSegments: 0, evictedBytes: 0, error: null, durability: 'LOCAL_FILESYSTEM_PERIODIC_FSYNC', retention: 'ROLLING_BOUNDED' },
    freshness: { tickerFreshMs: 90_000, candleFreshMs: 180_000, freshTicker: markets, staleTicker: 0, neverTicker: 0, freshCandle: markets, staleCandle: 0, neverCandle: 0, provisionalCandle: markets },
    counters: { tickerMessages: markets, candleMessages: markets },
    perMarket,
    ...overrides,
  };
};

test('data-only liveness requires a current heartbeat and matching runtime identity', () => {
  const active = evaluateDataOnlyRuntimeStatus(base(), { now: NOW, lock: lock(), isPidAlive: () => true });
  assert.equal(active.healthState, 'ACTIVE'); assert.equal(active.reportedRunning, true); assert.equal(active.effectiveRunning, true); assert.equal(active.heartbeatAgeMs, 1_000);

  const starting = evaluateDataOnlyRuntimeStatus(base({ lifecycle: 'STARTING', startupPhase: 'PERSISTENCE' }), { now: NOW, lock: lock() });
  assert.equal(starting.healthState, 'STARTING'); assert.equal(starting.effectiveRunning, true);

  const stale = evaluateDataOnlyRuntimeStatus(base({ tsMs: NOW - DATA_ONLY_HEARTBEAT_MAX_AGE_MS - 1 }), { now: NOW, lock: lock() });
  assert.equal(stale.healthState, 'STALE'); assert.equal(stale.statusReason, 'HEARTBEAT_STALE'); assert.equal(stale.reportedRunning, true); assert.equal(stale.running, false);

  const future = evaluateDataOnlyRuntimeStatus(base({ tsMs: NOW + 1 }), { now: NOW, lock: lock() });
  assert.equal(future.healthState, 'FUTURE'); assert.equal(future.statusReason, 'HEARTBEAT_IN_FUTURE'); assert.equal(future.effectiveRunning, false);

  const invalid = evaluateDataOnlyRuntimeStatus(base({ tsMs: 'recent' }), { now: NOW, lock: lock() });
  assert.equal(invalid.healthState, 'INVALID'); assert.equal(invalid.statusReason, 'HEARTBEAT_INVALID');

  const noLifecycle = evaluateDataOnlyRuntimeStatus(base({ lifecycle: undefined }), { now: NOW, lock: lock() });
  assert.equal(noLifecycle.healthState, 'INVALID'); assert.equal(noLifecycle.statusReason, 'LIFECYCLE_INVALID');

  const noStart = evaluateDataOnlyRuntimeStatus(base({ startedTs: undefined }), { now: NOW, lock: lock() });
  assert.equal(noStart.healthState, 'INVALID'); assert.equal(noStart.statusReason, 'START_TIMESTAMP_INVALID');

  const wrongAuthority = evaluateDataOnlyRuntimeStatus(base({ authority: 'PAPER' }), { now: NOW, lock: lock() });
  assert.equal(wrongAuthority.healthState, 'INVALID'); assert.equal(wrongAuthority.statusReason, 'AUTHORITY_INVALID');

  const stopped = evaluateDataOnlyRuntimeStatus(base({ running: false, lifecycle: 'STOPPED', tsMs: NOW - 10_000_000 }), { now: NOW, lock: null });
  assert.equal(stopped.healthState, 'STOPPED'); assert.equal(stopped.statusReason, 'REPORTED_STOPPED'); assert.equal(stopped.effectiveRunning, false);

  const mismatch = evaluateDataOnlyRuntimeStatus(base(), { now: NOW, lock: lock({ pid: 9999 }) });
  assert.equal(mismatch.healthState, 'STALE'); assert.equal(mismatch.statusReason, 'RUNTIME_LOCK_PID_MISMATCH');

  const startMismatch = evaluateDataOnlyRuntimeStatus(base(), { now: NOW, lock: lock({ openedTs: STARTED - 1 }) });
  assert.equal(startMismatch.healthState, 'STALE'); assert.equal(startMismatch.statusReason, 'RUNTIME_LOCK_START_MISMATCH');

  const dead = evaluateDataOnlyRuntimeStatus(base(), { now: NOW, lock: lock(), isPidAlive: () => false });
  assert.equal(dead.healthState, 'STALE'); assert.equal(dead.statusReason, 'PID_NOT_ALIVE');
  assert.throws(() => evaluateDataOnlyRuntimeStatus(base(), { now: NOW, maxHeartbeatAgeMs: DATA_ONLY_HEARTBEAT_MAX_AGE_MS - 1 }), /at least 150000ms/);
});

test('disk reader refuses a fresh running snapshot without its runtime lock', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'data-only-status-'));
  try {
    mkdirSync(path.join(root, 'data-only'), { recursive: true });
    writeFileSync(path.join(root, 'data-only', 'runtime-status.json'), JSON.stringify(base()));
    const missing = readDataOnlyRuntimeStatus({ root, now: NOW, checkPid: false });
    assert.equal(missing.healthState, 'STALE'); assert.equal(missing.statusReason, 'RUNTIME_LOCK_MISSING');
    writeFileSync(path.join(root, 'data-only', 'runtime.lock'), JSON.stringify(lock()));
    assert.equal(readDataOnlyRuntimeStatus({ root, now: NOW, checkPid: false }).healthState, 'ACTIVE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public market and sensor views keep capture scope separate from the wider catalog', () => {
  const status = base({
    catalog: { contentId: 'a'.repeat(40), observedTs: NOW - 2_000, markets: 612, policy: 'FULL_CATALOG' },
    collectors: {
      market: {
        state: 'ACTIVE', running: true, purpose: 'OBSERVATION_ONLY', root: 'C:/secret/server/path', segmentDir: 'C:/secret/server/path/segment',
        scope: { subjectCount: 3, subjects: ['BTC', 'ETH', 'SOL'], allAssetCoverageClaim: false, note: 'bounded' },
        families: ['SPOT_PRICE_CHART', 'SPOT_FLOW'], bootstrap: { running: false, initialState: 'COMPLETE' },
        counters: { observations: 27 }, persistence: { captures: 'FILE_BACKED_SAME_FILESYSTEM', quotaJournal: 'FILE_BACKED_SAME_FILESYSTEM', replitRepublish: 'NOT_GUARANTEED' },
        sources: { KRAKEN_SPOT: { desired: 'ON', state: 'OBSERVED', requests: 9, succeeded: 9, failed: 0, callsToday: 9, dailyCap: 1000 } },
        streams: {
          KRAKEN_SPOT: { state: 'OPEN', epoch: 1, messages: 90, bytes: 9000, dropped: 0, invalidJson: 0, reconnects: 0, openedTs: NOW - 9_000, lastMessageTs: NOW - 1_500 },
          COINBASE_SPOT: { state: 'OPEN', epoch: 1, messages: 80, bytes: 8000, dropped: 0, invalidJson: 0, reconnects: 0, openedTs: NOW - 9_000, lastMessageTs: NOW - 1_600 },
        },
        recording: { error: null, failedTs: null, where: null, segmentDir: 'C:/secret/server/path/segment' },
      },
      wideeye: { state: 'ACTIVE', tsMs: NOW - 500 },
      persistence: { status: 'HEALTHY', databaseConfigured: true, restored: true },
    },
  });
  const evaluated = evaluateDataOnlyRuntimeStatus(status, { now: NOW, lock: lock() });
  const pub = dataOnlyPublicStatus(evaluated);
  assert.equal(pub.healthState, 'ACTIVE'); assert.equal(pub.statusReason, null, 'healthy status preserves the evaluator\'s explicit null reason');
  assert.equal(pub.market.scope.subjectCount, 3); assert.deepEqual(pub.market.scope.subjects, ['BTC', 'ETH', 'SOL']); assert.equal(pub.catalog.markets, 612);
  assert.equal(pub.market.providerSources.KRAKEN_SPOT.succeeded, 9); assert.equal(pub.market.receipts.observations, 27);
  assert.equal(pub.market.streams.KRAKEN_SPOT.healthState, 'HEALTHY'); assert.equal(pub.market.streamHealth.state, 'HEALTHY'); assert.equal(pub.market.recording.state, 'HEALTHY');
  assert.equal(JSON.stringify(pub).includes('secret/server/path'), false, 'public status does not expose runtime filesystem paths');
  const sensors = dataOnlySensorSnapshot(evaluated, { now: NOW }); const market = sensors.rows.find((row) => row.id === 'MARKET_CAPTURE');
  assert.equal(market.name, 'Deep market capture (BTC/ETH/SOL)'); assert.match(market.coverage, /^deep capture scope 3 subjects/); assert.match(market.coverage, /broad catalog coverage is reported separately/);
  assert.equal(sensors.runtimeMode, 'DATA_ONLY'); assert.equal(sensors.authority.realMoney, 'DISABLED');
  const endpoint = dataOnlyMarketView(evaluated);
  assert.equal(endpoint.market.scope.subjectCount, 3); assert.equal(endpoint.market.providerSources.KRAKEN_SPOT.requests, 9); assert.equal(endpoint.market.streams.KRAKEN_SPOT.messages, 90); assert.equal(endpoint.status.mode, 'DATA_ONLY');
  assert.equal(endpoint.status.owner.counters.tapeTrades, null); assert.equal(endpoint.status.owner.counters.acquisitions, 27);

  const stale = evaluateDataOnlyRuntimeStatus({ ...status, tsMs: NOW - DATA_ONLY_HEARTBEAT_MAX_AGE_MS - 1 }, { now: NOW, lock: lock() });
  const stalePublic = dataOnlyPublicStatus(stale); const staleSensors = dataOnlySensorSnapshot(stale, { now: NOW });
  assert.equal(stalePublic.market.state, 'STALE'); assert.equal(stalePublic.market.reportedState, 'ACTIVE'); assert.equal(stalePublic.market.running, false);
  assert.equal(staleSensors.rows.find((row) => row.id === 'MARKET_KRAKEN_SPOT').state, 'STALE');
  assert.match(staleSensors.rows.find((row) => row.id === 'MARKET_KRAKEN_SPOT').blocker, /HEARTBEAT_STALE/);
});

test('public market downgrades failed, initializing, and stale required streams while preserving REST truth', () => {
  const market = { state: 'ACTIVE', running: true, purpose: 'OBSERVATION_ONLY', scope: { subjectCount: 1, subjects: ['BTC'], allAssetCoverageClaim: false }, families: ['SPOT_FLOW'], counters: { observations: 41 }, sources: { KRAKEN_SPOT: { desired: 'ON', state: 'OBSERVED', requests: 3, succeeded: 3, failed: 0 } }, streams: { KRAKEN_SPOT: { state: 'OPEN', epoch: 1, messages: 20, lastMessageTs: NOW - 1_000, openedTs: NOW - 10_000 }, COINBASE_SPOT: { state: 'OPEN', epoch: 1, messages: 15, lastMessageTs: NOW - 1_000, openedTs: NOW - 10_000 } }, recording: { error: null, failedTs: null, where: null } };
  const project = (next) => dataOnlyPublicStatus(evaluateDataOnlyRuntimeStatus(base({ collectors: { market: next } }), { now: NOW, lock: lock() })).market;
  const failed = project({ ...market, recording: { error: { kind: 'IO_FAILURE', message: 'private path omitted' }, failedTs: NOW - 5, where: 'APPEND' } });
  assert.equal(failed.state, 'RECORDING_FAILED'); assert.equal(failed.running, false); assert.equal(failed.recording.state, 'FAILED'); assert.equal(JSON.stringify(failed).includes('private path omitted'), false);
  const malformedRecording = project({ ...market, recording: { error: false, failedTs: null, where: null } });
  assert.equal(malformedRecording.state, 'DEGRADED'); assert.equal(malformedRecording.recording.state, 'UNKNOWN');
  const connecting = project({ ...market, streams: { ...market.streams, COINBASE_SPOT: { state: 'CONNECTING', epoch: 2, messages: 0, lastMessageTs: null, openedTs: null } } });
  assert.equal(connecting.state, 'STARTING'); assert.equal(connecting.streamHealth.state, 'STARTING'); assert.equal(connecting.running, true);
  const staleMarket = { ...market, streams: { ...market.streams, KRAKEN_SPOT: { ...market.streams.KRAKEN_SPOT, lastMessageTs: NOW - 91_001 } } };
  const stale = project(staleMarket);
  assert.equal(stale.state, 'DEGRADED'); assert.equal(stale.streams.KRAKEN_SPOT.healthState, 'STALE'); assert.equal(stale.running, true); assert.equal(stale.receipts.observations, 41); assert.equal(stale.providerSources.KRAKEN_SPOT.succeeded, 3);
  const oldHeartbeat = dataOnlyPublicStatus(evaluateDataOnlyRuntimeStatus(base({ tsMs: NOW - 100_000, collectors: { market: { ...market, streams: { ...market.streams, KRAKEN_SPOT: { ...market.streams.KRAKEN_SPOT, lastMessageTs: NOW - 150_000 } } } } }), { now: NOW, lock: lock() })).market;
  assert.equal(oldHeartbeat.state, 'DEGRADED'); assert.equal(oldHeartbeat.streams.KRAKEN_SPOT.healthState, 'STALE', 'WS age uses evaluation time, not the older saved heartbeat');
  const sensors = dataOnlySensorSnapshot(evaluateDataOnlyRuntimeStatus(base({ collectors: { market: staleMarket } }), { now: NOW, lock: lock() }), { now: NOW });
  assert.equal(sensors.rows.find((row) => row.id === 'MARKET_CAPTURE').state, 'DEGRADED'); assert.equal(sensors.rows.find((row) => row.id === 'MARKET_WS_KRAKEN_SPOT').state, 'DEGRADED'); assert.equal(sensors.rows.find((row) => row.id === 'MARKET_KRAKEN_SPOT').state, 'OBSERVED');
});

test('broad Kraken projection returns every bounded catalog market and requires mapped, subscribed, fresh, persisted observations', () => {
  const broad = broadMarket();
  const evaluated = evaluateDataOnlyRuntimeStatus(base({
    catalog: { contentId: 'b'.repeat(40), observedTs: NOW - 5_000, markets: 70, policy: 'FULL_CATALOG' },
    collectors: { broadMarket: broad },
  }), { now: NOW, lock: lock() });
  const pub = dataOnlyPublicStatus(evaluated);
  assert.equal(pub.broadMarket.state, 'ACTIVE');
  assert.equal(pub.broadMarket.scope.membership, 'ALL_ACCEPTED_CATALOG');
  assert.equal(pub.broadMarket.scope.namedPreference, false); assert.equal(pub.broadMarket.scope.topN, null);
  assert.equal(pub.broadMarket.perMarket.length, 70, 'public breadth is not silently sliced at the former 64-row UI bound');
  assert.equal(pub.broadMarket.coverage.denominator, 70); assert.equal(pub.broadMarket.coverage.ackedTicker, 70); assert.equal(pub.broadMarket.coverage.ackedOhlc, 70);
  assert.equal(pub.broadMarket.freshness.freshTicker, 70); assert.equal(pub.broadMarket.freshness.freshCandle, 0); assert.equal(pub.broadMarket.freshness.provisionalFreshCandle, 70); assert.equal(pub.broadMarket.freshness.completeCandle, 70); assert.equal(pub.broadMarket.recording.records, 140);
  assert.equal(pub.broadMarket.authority, 'NONE'); assert.equal(JSON.stringify(pub.broadMarket).includes('private/broad-capture'), false); assert.equal(JSON.stringify(pub.broadMarket).includes('private-name'), false);

  const row = dataOnlySensorSnapshot(evaluated, { now: NOW }).rows.find((entry) => entry.id === 'BROAD_KRAKEN_MARKET');
  assert.equal(row.state, 'ACTIVE'); assert.match(row.coverage, /all accepted Kraken USD markets 70\/70/); assert.match(row.coverage, /ticker\/24h-volume acked 70\/70, complete\+fresh 70\/70/); assert.match(row.coverage, /candles acked 70\/70, complete\+fresh 70\/70 \(closed 0, provisional 70\)/); assert.match(row.coverage, /persisted 140 records/); assert.equal(row.authority, 'NONE');
  const endpoint = dataOnlyMarketView(evaluated);
  assert.equal(endpoint.enabled, true); assert.equal(endpoint.broadMarket.perMarket.length, 70); assert.equal(endpoint.scopeLaw.includes('catalog membership alone'), true);
});

test('broad Kraken projection keeps startup, partial, stale, and writer failure states explicit', () => {
  const project = (broadMarketStatus) => dataOnlyPublicStatus(evaluateDataOnlyRuntimeStatus(base({ collectors: { broadMarket: broadMarketStatus } }), { now: NOW, lock: lock() })).broadMarket;

  const partialBase = broadMarket();
  const partial = project({ ...partialBase, subscription: { ...partialBase.subscription, ackedTicker: 69 } });
  assert.equal(partial.state, 'DEGRADED'); assert.equal(partial.reason, 'BROAD_MARKET_SUBSCRIPTIONS_INCOMPLETE'); assert.equal(partial.coverage.ackedTicker, 69);

  const startingBase = broadMarket({ markets: 0, state: 'CONNECTING' });
  const starting = project({ ...startingBase, socket: { state: 'CONNECTING', epoch: 1, messages: 0, bytes: 0, dropped: 0, invalidJson: 0, reconnects: 0 } });
  assert.equal(starting.state, 'STARTING'); assert.equal(starting.reason, 'BROAD_MARKET_CONNECTING'); assert.notEqual(starting.state, 'ACTIVE', 'a catalog or connecting socket alone is never active coverage');

  const staleBase = broadMarket({ receivedTs: NOW - 200_000 });
  const stale = project(staleBase);
  assert.equal(stale.state, 'DEGRADED'); assert.equal(stale.reason, 'BROAD_MARKET_OBSERVATIONS_NOT_FRESH'); assert.equal(stale.freshness.freshTicker, 0); assert.equal(stale.freshness.staleTicker, 70); assert.equal(stale.freshness.completeCandle, 0); assert.equal(stale.freshness.staleCandle, 70);
  assert.equal(stale.freshness.reported.freshTicker, 70, 'raw claims remain distinguishable from freshness recomputed at evaluation time');

  const failedBase = broadMarket();
  const writerFailure = project({ ...failedBase, recording: { ...failedBase.recording, state: 'RECORDING_FAILED', error: { code: 'WRITE_FAILED', message: 'C:/private/must-not-leak', ts: NOW } } });
  assert.equal(writerFailure.state, 'RECORDING_FAILED'); assert.equal(writerFailure.running, false); assert.equal(writerFailure.recording.error, 'PRESENT_REDACTED'); assert.equal(JSON.stringify(writerFailure).includes('must-not-leak'), false);
});

test('broad readiness recomputes clocks, price validity, persistence and unique identities rather than trusting raw ACTIVE', () => {
  const project = (raw) => dataOnlyPublicStatus(evaluateDataOnlyRuntimeStatus(base({ collectors: { broadMarket: raw } }), { now: NOW, lock: lock() })).broadMarket;
  const changes = [
    (b) => { b.perMarket[0].ticker.sourceEventTs = NOW - 200_000; },
    (b) => { b.perMarket[0].ticker.sourceEventTs = NOW + 1000; },
    (b) => { b.perMarket[0].ticker.lastPrice = 0; },
    (b) => { b.perMarket[0].candle.close = 0; },
    (b) => { b.perMarket[0].candle.periodStartTs = NOW - 600_000; b.perMarket[0].candle.periodEndTs = NOW - 540_000; },
    (b) => { b.perMarket[0].ticker.persisted = false; },
    (b) => { b.perMarket[0].channels.ohlc = 'GAP'; },
    (b) => { b.perMarket[0].canonicalCoin = b.perMarket[1].canonicalCoin; },
    (b) => { b.perMarket[0].wsSymbol = b.perMarket[1].wsSymbol; },
    (b) => { b.catalog.observedTs = NOW - 900_001; },
  ];
  for (const change of changes) { const b = broadMarket(); change(b); assert.notEqual(project(b).state, 'ACTIVE'); }
  const baseline = broadMarket(); baseline.perMarket[0].ticker.state = 'IDLE_SNAPSHOT_BASELINE'; baseline.perMarket[0].ticker.sourceEventTs = null;
  const idle = project(baseline);
  assert.equal(idle.freshness.idleTicker, 1); assert.equal(idle.perMarket[0].ticker.freshnessState, 'IDLE'); assert.equal(idle.coverage.allFresh, false);
  const metadata = broadMarket(); Object.assign(metadata.recording, { latestBytes: 10000, latestWrittenTs: NOW - 2000, latestSnapshotWrites: 8, latestSnapshotCadenceMs: 5000 }); metadata.counters.coalescedSnapshotRecords = 200;
  assert.equal(project(metadata).recording.latestSnapshotCadenceMs, 5000);
  assert.equal(project(metadata).recording.coalescedSnapshotRecords, 200);
});

test('public market diagnostics preserve monthly policy evidence without exposing arbitrary error text', () => {
  const raw = { state: 'ACTIVE', running: true, recording: { error: null }, sources: {
    COINGECKO: { state: 'POLICY_BLOCKED', callsMonth: 2, monthlyCap: 2, entitlementRemaining: 0,
      policyBlockReasons: ['MONTH_CAP', 'private/url?secret=value'],
      policyRefusals: { count: 1, lastTs: NOW - 1000, reasons: { MONTH_CAP: 1, 'private/url?secret=value': 1 }, lastReasons: ['MONTH_CAP', 'private/url?secret=value'] },
      catalogResolution: { state: 'PROVIDER_DISABLED', count: null, knownAtTs: null } },
  } };
  const source = dataOnlyPublicStatus(evaluateDataOnlyRuntimeStatus(base({ collectors: { market: raw } }), { now: NOW, lock: lock() })).market.providerSources.COINGECKO;
  assert.equal(source.callsMonth, 2); assert.equal(source.monthlyCap, 2); assert.equal(source.entitlementRemaining, 0);
  assert.deepEqual(source.policyBlockReasons, ['MONTH_CAP']); assert.deepEqual(source.policyRefusals.reasons, { MONTH_CAP: 1 });
  assert.equal(source.catalogResolution.state, 'PROVIDER_DISABLED'); assert.doesNotMatch(JSON.stringify(source), /private|secret/);
});

test('broad Kraken projection refuses over-bound rows instead of claiming a truncated catalog', () => {
  const tooMany = DATA_ONLY_BROAD_MARKET_MAX_ROWS + 1;
  const broad = broadMarket({ markets: tooMany });
  const projected = dataOnlyPublicStatus(evaluateDataOnlyRuntimeStatus(base({ collectors: { broadMarket: broad } }), { now: NOW, lock: lock() })).broadMarket;
  assert.equal(projected.state, 'INVALID'); assert.equal(projected.reason, 'BROAD_MARKET_ROW_BOUND_EXCEEDED');
  assert.equal(projected.validation.state, 'REFUSED'); assert.equal(projected.validation.reason, 'PER_MARKET_OVERFLOW'); assert.equal(projected.validation.reportedRows, tooMany);
  assert.deepEqual(projected.perMarket, []); assert.equal(projected.scope.allCatalogMarkets, false);
});

test('data-only UI routes branch to truthful runtime projections', async () => {
  const server = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../ui/server.js', import.meta.url), 'utf8'));
  assert.match(server, /if \(DATA_ONLY_MODE\) return dataOnlySensorSnapshot\(readDataOnlyRuntimeStatus/);
  assert.match(server, /paperFanged: false/);
  assert.match(server, /DATA_ONLY_MODE \? dataOnlyMarketView\(readDataOnlyRuntimeStatus/);
  assert.match(server, /DATA_ONLY_RUNTIME_\$\{runtime\.healthState\}/);
});

test('paper readiness accepts keyed Rumor2 providers and requires a fresh collector heartbeat', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'keyed-rumor-status-'));
  try {
    mkdirSync(path.join(root, 'rumor2'), { recursive: true });
    // Deployment shells deliberately carry COBRA_PROFILE=''. The test owns an
    // explicit fixture path so inherited runtime environment cannot redirect
    // loadProfile() to the repository directory.
    const profile = loadProfile('config/paper-runtime.json'); const env = { ...profileEnvironment(profile), SERPENT_HTTP_CONTACT: 'ops@example.com' };
    const write = (tsMs) => writeFileSync(path.join(root, 'rumor2', 'status.json'), JSON.stringify({
      tsMs, lifecycle: 'ACTIVE', durabilityMode: 'POSTGRES', writerAuthority: { state: 'ACTIVE' },
      providers: { CFTC_OFFICIAL: { enabled: true, coverage: { state: 'OBSERVED', checkedTs: tsMs, detail: null } } },
    }));
    write(NOW - 1_000);
    let snap = sensorSnapshot({ profile, env, config: loadConfig(), dataDir: root, now: NOW });
    let cftc = snap.rows.find((row) => row.id === 'CFTC_OFFICIAL');
    assert.equal(cftc.state, 'ACTIVE'); assert.equal(cftc.lastSuccessTs, NOW - 1_000); assert.match(cftc.coverage, /^OBSERVED/);

    write(NOW - 300_001);
    snap = sensorSnapshot({ profile, env, config: loadConfig(), dataDir: root, now: NOW }); cftc = snap.rows.find((row) => row.id === 'CFTC_OFFICIAL');
    assert.equal(cftc.state, 'ACTIVE_DEGRADED'); assert.equal(cftc.blocker, 'collector status stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
