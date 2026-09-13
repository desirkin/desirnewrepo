import path from 'node:path';
import { existsSync } from 'node:fs';
import { dataDir as defaultDataDir } from './config.js';
import { readJsonBounded } from './jsonl.js';

export const DATA_ONLY_HEARTBEAT_MAX_AGE_MS = 150_000;
export const DATA_ONLY_RUNTIME_STATUS_VERSION = 'serpent-data-only-runtime-2';
export const DATA_ONLY_MARKET_STREAM_MAX_AGE_MS = 90_000;
export const DATA_ONLY_MARKET_REQUIRED_STREAMS = Object.freeze(['KRAKEN_SPOT', 'COINBASE_SPOT']);
export const DATA_ONLY_BROAD_MARKET_MAX_ROWS = 5_000;
const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const LIFECYCLES = new Set(['STARTING', 'ACTIVE', 'STOPPING', 'STOPPED']);

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const positivePid = (value) => Number.isSafeInteger(value) && value > 0;
const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const finitePositive = (value) => Number.isFinite(value) && value > 0 ? value : null;
const diagnosticCode = (value) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

// A saved `running: true` is only the writer's last report. Effective liveness
// additionally requires a current heartbeat and, when read from disk, the
// identity of the current runtime lock. This function performs no I/O so every
// edge is deterministic in tests.
export function evaluateDataOnlyRuntimeStatus(raw, {
  now = Date.now(),
  maxHeartbeatAgeMs = DATA_ONLY_HEARTBEAT_MAX_AGE_MS,
  lock = undefined,
  isPidAlive = undefined,
} = {}) {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('data-only status: now must be a positive safe integer');
  if (!Number.isSafeInteger(maxHeartbeatAgeMs) || maxHeartbeatAgeMs < DATA_ONLY_HEARTBEAT_MAX_AGE_MS) throw new Error(`data-only status: heartbeat bound must be at least ${DATA_ONLY_HEARTBEAT_MAX_AGE_MS}ms`);

  if (!object(raw)) return Object.freeze({
    available: false, reportedRunning: false, effectiveRunning: false, running: false,
    healthState: 'UNAVAILABLE', statusReason: 'STATUS_UNAVAILABLE', heartbeatAgeMs: null,
    heartbeatMaxAgeMs: maxHeartbeatAgeMs, lifecycle: 'UNAVAILABLE', startupPhase: null,
    tsMs: null, evaluatedAtTs: now, pid: null, startedTs: null, authority: 'NONE', status: null,
  });

  const reportedRunning = raw.running === true;
  const lifecycle = typeof raw.lifecycle === 'string' ? raw.lifecycle : null;
  const heartbeatAgeMs = timestamp(raw.tsMs) && raw.tsMs <= now ? now - raw.tsMs : null;
  let healthState = lifecycle;
  let statusReason = null;

  if (raw.running === false || lifecycle === 'STOPPED') {
    healthState = 'STOPPED'; statusReason = 'REPORTED_STOPPED';
  } else if (raw.running !== true) {
    healthState = 'INVALID'; statusReason = 'RUNNING_FLAG_INVALID';
  } else if (!timestamp(raw.tsMs)) {
    healthState = 'INVALID'; statusReason = 'HEARTBEAT_INVALID';
  } else if (raw.tsMs > now) {
    healthState = 'FUTURE'; statusReason = 'HEARTBEAT_IN_FUTURE';
  } else if (heartbeatAgeMs > maxHeartbeatAgeMs) {
    healthState = 'STALE'; statusReason = 'HEARTBEAT_STALE';
  } else if (!positivePid(raw.pid)) {
    healthState = 'INVALID'; statusReason = 'PID_INVALID';
  } else if (!timestamp(raw.startedTs)) {
    healthState = 'INVALID'; statusReason = 'START_TIMESTAMP_INVALID';
  } else if (!LIFECYCLES.has(lifecycle)) {
    healthState = 'INVALID'; statusReason = 'LIFECYCLE_INVALID';
  } else if (raw.authority !== 'NONE') {
    healthState = 'INVALID'; statusReason = 'AUTHORITY_INVALID';
  } else if (lifecycle === 'STOPPING') {
    healthState = 'STOPPING'; statusReason = 'REPORTED_STOPPING';
  } else if (lock !== undefined && !object(lock)) {
    healthState = 'STALE'; statusReason = 'RUNTIME_LOCK_MISSING';
  } else if (object(lock) && !positivePid(lock.pid)) {
    healthState = 'INVALID'; statusReason = 'RUNTIME_LOCK_INVALID';
  } else if (object(lock) && (!timestamp(lock.openedTs) || lock.authority !== 'NONE')) {
    healthState = 'INVALID'; statusReason = 'RUNTIME_LOCK_INVALID';
  } else if (object(lock) && lock.pid !== raw.pid) {
    healthState = 'STALE'; statusReason = 'RUNTIME_LOCK_PID_MISMATCH';
  } else if (object(lock) && raw.startedTs !== lock.openedTs) {
    healthState = 'STALE'; statusReason = 'RUNTIME_LOCK_START_MISMATCH';
  } else if (object(lock) && typeof raw.runId === 'string' && typeof lock.runId === 'string' && raw.runId !== lock.runId) {
    healthState = 'STALE'; statusReason = 'RUNTIME_LOCK_RUN_ID_MISMATCH';
  } else if (typeof isPidAlive === 'function' && isPidAlive(raw.pid) === false) {
    healthState = 'STALE'; statusReason = 'PID_NOT_ALIVE';
  } else {
    healthState = lifecycle;
  }

  const effectiveRunning = reportedRunning && (healthState === 'STARTING' || healthState === 'ACTIVE');
  return Object.freeze({
    ...raw,
    available: true,
    reportedRunning,
    effectiveRunning,
    running: effectiveRunning,
    healthState,
    statusReason,
    heartbeatAgeMs,
    heartbeatMaxAgeMs: maxHeartbeatAgeMs,
    evaluatedAtTs: now,
    lifecycle: lifecycle ?? 'INVALID',
    startupPhase: typeof raw.startupPhase === 'string' ? text(raw.startupPhase, 80) : null,
    status: raw,
  });
}

export function readDataOnlyRuntimeStatus({
  root = defaultDataDir(),
  now = Date.now(),
  maxHeartbeatAgeMs = DATA_ONLY_HEARTBEAT_MAX_AGE_MS,
  checkPid = true,
} = {}) {
  const statusFile = path.join(root, 'data-only', 'runtime-status.json');
  const lockFile = path.join(root, 'data-only', 'runtime.lock');
  let raw = null; let lock = null;
  try { raw = readJsonBounded(statusFile, MAX_STATUS_BYTES); } catch { /* unavailable is explicit below */ }
  try { if (existsSync(lockFile)) lock = readJsonBounded(lockFile, MAX_LOCK_BYTES); } catch { lock = {}; }
  return evaluateDataOnlyRuntimeStatus(raw, {
    now, maxHeartbeatAgeMs, lock,
    ...(checkPid ? { isPidAlive: pidAlive } : {}),
  });
}

function publicMarketStream(stream, snapshotTs) {
  if (!object(stream)) return null;
  const state = text(stream.state, 24) || 'UNKNOWN';
  const lastMessageTs = timestamp(stream.lastMessageTs) ? stream.lastMessageTs : null;
  const openedTs = timestamp(stream.openedTs) ? stream.openedTs : null;
  const lastMessageAgeMs = lastMessageTs !== null && timestamp(snapshotTs) && lastMessageTs <= snapshotTs ? snapshotTs - lastMessageTs : null;
  const openedAgeMs = openedTs !== null && timestamp(snapshotTs) && openedTs <= snapshotTs ? snapshotTs - openedTs : null;
  let healthState = 'DEGRADED'; let reason = `WS_${state}`;
  if (state === 'CONNECTING') { healthState = 'STARTING'; reason = 'WS_CONNECTING'; }
  else if (state === 'OPEN' && lastMessageAgeMs !== null && lastMessageAgeMs <= DATA_ONLY_MARKET_STREAM_MAX_AGE_MS) { healthState = 'HEALTHY'; reason = null; }
  else if (state === 'OPEN' && lastMessageTs === null && openedAgeMs !== null && openedAgeMs <= DATA_ONLY_MARKET_STREAM_MAX_AGE_MS) { healthState = 'STARTING'; reason = 'WS_OPEN_AWAITING_FIRST_MESSAGE'; }
  else if (state === 'OPEN') { healthState = 'STALE'; reason = lastMessageTs !== null && lastMessageAgeMs === null ? 'WS_MESSAGE_TIMESTAMP_INVALID' : 'WS_MESSAGE_STALE'; }
  return { state, healthState, reason, epoch: finiteNonnegative(stream.epoch), messages: finiteNonnegative(stream.messages), bytes: finiteNonnegative(stream.bytes), dropped: finiteNonnegative(stream.dropped), invalidJson: finiteNonnegative(stream.invalidJson), reconnects: finiteNonnegative(stream.reconnects), lastMessageTs, lastMessageAgeMs, openedTs };
}

function publicMarket(market, snapshotTs) {
  if (!object(market)) return null;
  const sources = {};
  for (const [id, source] of Object.entries(object(market.sources) ? market.sources : {})) {
    if (!object(source)) continue;
    sources[text(id, 64)] = {
      desired: text(source.desired, 16) || null,
      state: text(source.state, 64) || 'NOT_OBSERVED',
      reason: source.reason ? text(source.reason) : null,
      credentialPresent: typeof source.credentialPresent === 'boolean' ? source.credentialPresent : null,
      requests: finiteNonnegative(source.requests), succeeded: finiteNonnegative(source.succeeded), failed: finiteNonnegative(source.failed),
      callsToday: finiteNonnegative(source.callsToday), dailyCap: finiteNonnegative(source.dailyCap),
      callsMonth: count(source.callsMonth), monthlyCap: count(source.monthlyCap),
      entitlementRemaining: count(source.entitlementRemaining),
      policyBlockReasons: Array.isArray(source.policyBlockReasons) ? source.policyBlockReasons.filter(diagnosticCode).slice(0, 32) : [],
      policyRefusals: object(source.policyRefusals) ? {
        count: count(source.policyRefusals.count),
        lastTs: timestamp(source.policyRefusals.lastTs) ? source.policyRefusals.lastTs : null,
        reasons: Object.fromEntries(Object.entries(object(source.policyRefusals.reasons) ? source.policyRefusals.reasons : {}).filter(([key, value]) => diagnosticCode(key) && count(value) !== null).slice(0, 32)),
        lastReasons: Array.isArray(source.policyRefusals.lastReasons) ? source.policyRefusals.lastReasons.filter(diagnosticCode).slice(0, 16) : [],
      } : null,
      catalogResolution: object(source.catalogResolution) ? {
        state: diagnosticCode(source.catalogResolution.state) ? source.catalogResolution.state : 'UNKNOWN',
        count: count(source.catalogResolution.count),
        knownAtTs: timestamp(source.catalogResolution.knownAtTs) ? source.catalogResolution.knownAtTs : null,
      } : null,
    };
  }
  const streams = {};
  for (const [id, stream] of Object.entries(object(market.streams) ? market.streams : {})) { const visible = publicMarketStream(stream, snapshotTs); if (visible) streams[text(id, 64)] = visible; }
  const required = Object.fromEntries(DATA_ONLY_MARKET_REQUIRED_STREAMS.map((id) => [id, streams[id]?.healthState ?? 'MISSING']));
  const requiredStates = Object.values(required);
  const streamHealth = requiredStates.every((state) => state === 'HEALTHY') ? { state: 'HEALTHY', reason: null, required }
    : requiredStates.every((state) => state === 'HEALTHY' || state === 'STARTING') ? { state: 'STARTING', reason: 'REQUIRED_WS_INITIALIZING', required }
      : { state: 'DEGRADED', reason: 'REQUIRED_WS_NOT_HEALTHY', required };
  const recordingError = object(market.recording?.error) || typeof market.recording?.error === 'string';
  const recordingHealthy = object(market.recording) && market.recording.error === null;
  const recording = { state: recordingError ? 'FAILED' : recordingHealthy ? 'HEALTHY' : 'UNKNOWN', healthy: recordingHealthy, failedTs: timestamp(market.recording?.failedTs) ? market.recording.failedTs : null, where: market.recording?.where ? text(market.recording.where, 80) : null };
  const reportedState = text(market.state, 64) || 'NOT_OBSERVED'; const reportedRunning = market.running === true;
  let state = reportedState; let running = reportedRunning;
  if (recording.state === 'FAILED') { state = 'RECORDING_FAILED'; running = false; }
  else if (reportedState === 'ACTIVE' && recording.state !== 'HEALTHY') state = 'DEGRADED';
  else if (reportedState === 'ACTIVE' && streamHealth.state === 'STARTING') state = 'STARTING';
  else if (reportedState === 'ACTIVE' && streamHealth.state !== 'HEALTHY') state = 'DEGRADED';
  const subjects = Array.isArray(market.scope?.subjects) ? market.scope.subjects.filter((v) => typeof v === 'string').map((v) => text(v, 24)).slice(0, 64) : [];
  return {
    state, running, reportedState, reportedRunning,
    purpose: text(market.purpose, 40) || 'OBSERVATION_ONLY',
    scope: {
      subjectCount: Number.isSafeInteger(market.scope?.subjectCount) && market.scope.subjectCount >= 0 ? market.scope.subjectCount : subjects.length,
      subjects, allAssetCoverageClaim: market.scope?.allAssetCoverageClaim === true,
      note: market.scope?.note ? text(market.scope.note) : null,
    },
    families: Array.isArray(market.families) ? market.families.filter((v) => typeof v === 'string').map((v) => text(v, 64)).slice(0, 32) : [],
    bootstrap: object(market.bootstrap) ? {
      running: market.bootstrap.running === true,
      initialState: market.bootstrap.initialState ? text(market.bootstrap.initialState, 64) : null,
      lastError: market.bootstrap.lastError ? text(market.bootstrap.lastError) : null,
    } : null,
    receipts: object(market.counters) ? Object.fromEntries(Object.entries(market.counters).filter(([, value]) => Number.isFinite(value) && value >= 0).slice(0, 24)) : {},
    providerSources: sources,
    streams,
    streamHealth,
    recording,
    persistence: object(market.persistence) ? {
      captures: text(market.persistence.captures, 80) || null,
      quotaJournal: text(market.persistence.quotaJournal, 80) || null,
      replitRepublish: text(market.persistence.replitRepublish, 80) || null,
    } : null,
  };
}

function publicBroadChannel(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value, 32) || null;
  return null;
}

function broadObservation(observation, snapshotTs, freshMs, { candle = false } = {}) {
  const source = object(observation) ? observation : {};
  const lastReceivedTs = timestamp(source.lastReceivedTs) ? source.lastReceivedTs : null;
  const sourceEventTs = timestamp(source.sourceEventTs) ? source.sourceEventTs : null;
  const periodStartTs = timestamp(source.periodStartTs) ? source.periodStartTs : null;
  const periodEndTs = timestamp(source.periodEndTs ?? source.lastPeriodEndTs) ? (source.periodEndTs ?? source.lastPeriodEndTs) : null;
  const future = lastReceivedTs !== null && timestamp(snapshotTs) && lastReceivedTs > snapshotTs;
  const receiptAgeMs = lastReceivedTs !== null && timestamp(snapshotTs) && !future ? snapshotTs - lastReceivedTs : null;
  const ageMs = receiptAgeMs === null ? null : candle && periodEndTs !== null ? Math.max(receiptAgeMs, snapshotTs - periodEndTs, 0)
    : !candle && sourceEventTs !== null ? Math.max(receiptAgeMs, snapshotTs - sourceEventTs, 0) : receiptAgeMs;
  const reportedState = text(source.state, 40) || 'NOT_OBSERVED';
  const validValues = candle ? finitePositive(source.close) !== null && finiteNonnegative(source.volumeBase) !== null
    : finitePositive(source.lastPrice) !== null && finiteNonnegative(source.volume24hBase) !== null;
  const validPeriod = periodStartTs !== null && periodEndTs !== null && periodEndTs - periodStartTs === 60_000 && periodStartTs <= snapshotTs;
  const idle = ['IDLE_SNAPSHOT_BASELINE', 'IDLE_NO_RECENT_TRADE'].includes(reportedState);
  let freshnessState;
  if (lastReceivedTs === null || reportedState === 'NEVER_OBSERVED') freshnessState = 'NEVER';
  else if (future || !Number.isSafeInteger(freshMs) || freshMs <= 0 || !validValues || (candle && !validPeriod) || (!candle && sourceEventTs !== null && sourceEventTs > snapshotTs)) freshnessState = 'INVALID';
  else if (source.persisted !== true || reportedState === 'PENDING_PERSIST') freshnessState = 'PENDING';
  else if (idle) freshnessState = 'IDLE';
  else if (ageMs > freshMs || ['STALE', 'CLOSED_STALE', 'PROVISIONAL_STALE', 'EPOCH_STALE'].includes(reportedState) || (candle && reportedState === 'PROVISIONAL_FRESH' && periodEndTs < snapshotTs)) freshnessState = 'STALE';
  else if (candle && reportedState === 'PROVISIONAL_FRESH') freshnessState = 'PROVISIONAL_FRESH';
  else if (candle && reportedState === 'CLOSED_FRESH' && periodEndTs <= snapshotTs) freshnessState = 'CLOSED_FRESH';
  else if (!candle && reportedState === 'FRESH' && sourceEventTs !== null) freshnessState = 'FRESH';
  else freshnessState = 'INVALID';
  return {
    state: reportedState, persisted: source.persisted === true,
    ...(candle ? {
      periodStartTs, periodEndTs,
      quality: source.quality ? text(source.quality, 48) : null,
      close: finitePositive(source.close),
      volumeBase: finiteNonnegative(source.volumeBase),
      learningEligible: false,
    } : {
      sourceEventTs,
      lastPrice: finitePositive(source.lastPrice),
      volume24hBase: finiteNonnegative(source.volume24hBase),
      vwap24h: finiteNonnegative(source.vwap24h),
    }),
    lastReceivedTs,
    ageMs,
    freshnessState,
  };
}

// Broad market status is deliberately projected independently of the deep
// BTC/ETH/SOL capture. Every accepted catalog row is either returned or the
// entire over-bound list is refused; this view never silently samples rows.
function publicBroadMarket(raw, snapshotTs) {
  if (!object(raw)) return null;
  const catalogMarkets = count(raw.catalog?.markets);
  const attempted = count(raw.catalog?.attempted);
  const tickerFreshMs = count(raw.freshness?.tickerFreshMs);
  const candleFreshMs = count(raw.freshness?.candleFreshMs);
  const inputRows = Array.isArray(raw.perMarket) ? raw.perMarket : null;
  const overflow = inputRows !== null && inputRows.length > DATA_ONLY_BROAD_MARKET_MAX_ROWS;
  const rows = overflow || inputRows === null ? [] : inputRows.map((entry, index) => {
    const source = object(entry) ? entry : {};
    const canonicalCoin = typeof source.canonicalCoin === 'string' ? text(source.canonicalCoin, 32) : '';
    const pairKey = typeof source.pairKey === 'string' ? text(source.pairKey, 80) : '';
    const nativeBase = typeof source.nativeBase === 'string' ? text(source.nativeBase, 80) : '';
    const catalogWsname = typeof source.catalogWsname === 'string' ? text(source.catalogWsname, 80) : '';
    const nativeSymbol = typeof source.nativeSymbol === 'string' ? text(source.nativeSymbol, 80) : (catalogWsname || nativeBase);
    const wsSymbol = typeof source.wsSymbol === 'string' ? text(source.wsSymbol, 80) : '';
    const mappingState = text(source.mappingState, 32) || 'NOT_OBSERVED';
    const validMapping = ['MAPPED', 'UNSUPPORTED', 'AMBIGUOUS', 'AWAITING_INSTRUMENT'].includes(mappingState);
    return {
      index,
      valid: canonicalCoin.length > 0 && pairKey.length > 0 && nativeSymbol.length > 0 && validMapping && (mappingState !== 'MAPPED' || wsSymbol.length > 0),
      canonicalCoin: canonicalCoin || null,
      pairKey: pairKey || null,
      nativeSymbol: nativeSymbol || null,
      nativeBase: nativeBase || null,
      catalogWsname: catalogWsname || null,
      wsSymbol: wsSymbol || null,
      mappingState,
      ticker: broadObservation(source.ticker, snapshotTs, tickerFreshMs),
      candle: broadObservation(source.candle, snapshotTs, candleFreshMs, { candle: true }),
      channels: {
        ticker: publicBroadChannel(source.channels?.ticker),
        ohlc: publicBroadChannel(source.channels?.ohlc),
      },
      lastError: source.lastError ? 'PRESENT_REDACTED' : null,
    };
  });

  const uniquePairKeys = new Set(rows.map((row) => row.pairKey).filter(Boolean));
  const duplicateCoins = rows.length - new Set(rows.map((row) => row.canonicalCoin).filter(Boolean)).size;
  const mappedSymbols = rows.filter((row) => row.mappingState === 'MAPPED').map((row) => row.wsSymbol);
  const duplicateWsSymbols = mappedSymbols.length - new Set(mappedSymbols).size;
  const invalidRows = rows.filter((row) => !row.valid).length;
  const duplicatePairKeys = rows.length - uniquePairKeys.size;
  const duplicateIdentities = duplicatePairKeys + duplicateCoins + duplicateWsSymbols;
  const summarize = (kind) => ({
    fresh: rows.filter((row) => row[kind].freshnessState === 'FRESH' || row[kind].freshnessState === 'CLOSED_FRESH').length,
    provisionalFresh: rows.filter((row) => row[kind].freshnessState === 'PROVISIONAL_FRESH').length,
    stale: rows.filter((row) => row[kind].freshnessState === 'STALE').length,
    never: rows.filter((row) => row[kind].freshnessState === 'NEVER').length,
    invalid: rows.filter((row) => row[kind].freshnessState === 'INVALID').length,
    idle: rows.filter((row) => row[kind].freshnessState === 'IDLE').length,
    pending: rows.filter((row) => row[kind].freshnessState === 'PENDING').length,
  });
  const ticker = summarize('ticker');
  const candle = summarize('candle');
  const completeTicker = rows.filter((row) => row.ticker.freshnessState === 'FRESH' && row.ticker.lastPrice !== null && row.ticker.volume24hBase !== null).length;
  const completeCandle = rows.filter((row) => ['CLOSED_FRESH', 'PROVISIONAL_FRESH'].includes(row.candle.freshnessState) && row.candle.close !== null && row.candle.volumeBase !== null).length;

  const subscription = object(raw.subscription) ? raw.subscription : {};
  const ackedTicker = count(subscription.ackedTicker);
  const ackedOhlc = count(subscription.ackedOhlc);
  const failedTicker = count(subscription.failedTicker) ?? 0;
  const failedOhlc = count(subscription.failedOhlc) ?? 0;
  const failedLegacy = count(subscription.failed) ?? 0;
  const failed = failedTicker + failedOhlc + failedLegacy;
  const instrument = object(raw.instrument) ? raw.instrument : {};
  const mapped = count(instrument.mapped);
  const unsupported = count(instrument.unsupported) ?? 0;
  const ambiguous = count(instrument.ambiguous) ?? 0;
  const recordingError = object(raw.recording?.error) || typeof raw.recording?.error === 'string';
  const recordingKnownHealthy = object(raw.recording) && raw.recording.error === null;
  const records = count(raw.recording?.records);
  const segments = count(raw.recording?.segments);
  const recordedBytes = count(raw.recording?.bytes);
  const recordingState = recordingError ? 'FAILED' : recordingKnownHealthy ? (text(raw.recording?.state, 32) || 'HEALTHY') : 'UNKNOWN';
  const socket = publicMarketStream(raw.socket, snapshotTs);
  const catalogFresh = raw.catalog?.state === 'ACCEPTED' && timestamp(raw.catalog?.observedTs) && raw.catalog.observedTs <= snapshotTs && snapshotTs - raw.catalog.observedTs <= (count(raw.catalog.maxAgeMs) ?? 900_000) && raw.catalog.lastError === null;
  const fullCatalogRows = catalogMarkets !== null && catalogMarkets > 0 && rows.length === catalogMarkets && attempted === catalogMarkets && !overflow && inputRows !== null && invalidRows === 0 && duplicateIdentities === 0;
  const allMapped = mapped !== null && catalogMarkets !== null && mapped === catalogMarkets && unsupported === 0 && ambiguous === 0 && rows.every((row) => row.mappingState === 'MAPPED');
  const allSubscribed = allMapped && ackedTicker === mapped && ackedOhlc === mapped && failed === 0 && rows.every((row) => row.channels.ticker === 'SUBSCRIBED' && row.channels.ohlc === 'SUBSCRIBED');
  const allFresh = allMapped && completeTicker === mapped && completeCandle === mapped && ticker.stale === 0 && candle.stale === 0 && ticker.never === 0 && candle.never === 0 && ticker.invalid === 0 && candle.invalid === 0;
  const reportedState = text(raw.state, 40) || 'NOT_OBSERVED';
  const recordingOperational = recordingState === 'ACTIVE' || recordingState === 'HEALTHY';
  const persisted = recordingKnownHealthy && recordingOperational && records !== null && records > 0 && segments !== null && segments > 0 && recordedBytes !== null && recordedBytes > 0;
  const complete = reportedState === 'ACTIVE' && catalogFresh && fullCatalogRows && allSubscribed && allFresh && persisted && socket?.healthState === 'HEALTHY';
  const terminalState = ['BLOCKED', 'FAILED', 'STOPPING', 'STOPPED', 'RECORDING_FAILED'].includes(reportedState);
  let state;
  let reason;
  if (recordingError || reportedState === 'RECORDING_FAILED') { state = 'RECORDING_FAILED'; reason = 'BROAD_MARKET_RECORDING_FAILED'; }
  else if (overflow) { state = 'INVALID'; reason = 'BROAD_MARKET_ROW_BOUND_EXCEEDED'; }
  else if (terminalState) { state = reportedState; reason = `BROAD_MARKET_${reportedState}`; }
  else if (complete) { state = 'ACTIVE'; reason = null; }
  else if (['WAITING_CATALOG', 'CONNECTING', 'AWAITING_INSTRUMENT', 'SUBSCRIBING', 'STARTING'].includes(reportedState)) { state = 'STARTING'; reason = `BROAD_MARKET_${reportedState}`; }
  else { state = 'DEGRADED'; reason = !fullCatalogRows ? 'BROAD_MARKET_CATALOG_INCOMPLETE' : !catalogFresh ? 'BROAD_MARKET_CATALOG_NOT_FRESH' : !allMapped ? 'BROAD_MARKET_MAPPING_INCOMPLETE' : !allSubscribed ? 'BROAD_MARKET_SUBSCRIPTIONS_INCOMPLETE' : !allFresh ? 'BROAD_MARKET_OBSERVATIONS_NOT_FRESH' : !persisted ? 'BROAD_MARKET_NOT_PERSISTED' : 'BROAD_MARKET_SOCKET_NOT_OPEN'; }

  return {
    state,
    reportedState,
    running: state === 'ACTIVE' || state === 'STARTING' || state === 'DEGRADED',
    reason,
    authority: 'NONE',
    purpose: 'BROAD_OBSERVATION_ONLY',
    scope: {
      venue: 'KRAKEN', quote: 'USD', membership: 'ALL_ACCEPTED_CATALOG',
      catalogMarkets, projectedMarkets: rows.length, allCatalogMarkets: fullCatalogRows,
      namedPreference: false, topN: null, omittedByRank: 0, authority: 'NONE',
    },
    catalog: object(raw.catalog) ? {
      state: text(raw.catalog.state, 32) || null,
      contentId: typeof raw.catalog.contentId === 'string' ? text(raw.catalog.contentId, 80) : null,
      observedTs: timestamp(raw.catalog.observedTs) ? raw.catalog.observedTs : null,
      markets: catalogMarkets,
      attempted,
      lastCheckedTs: timestamp(raw.catalog.lastCheckedTs) ? raw.catalog.lastCheckedTs : null,
      lastError: raw.catalog.lastError ? 'PRESENT_REDACTED' : null,
    } : null,
    instrument: object(raw.instrument) ? {
      state: text(instrument.state, 32) || null,
      receivedTs: timestamp(instrument.receivedTs) ? instrument.receivedTs : null,
      pairs: count(instrument.pairs), mapped, unsupported, ambiguous,
      lastError: instrument.lastError ? 'PRESENT_REDACTED' : null,
    } : null,
    socket,
    subscription: {
      queueDepth: count(subscription.queueDepth ?? subscription.queued),
      requestsSent: count(subscription.requestsSent ?? subscription.sent),
      ackedTicker, ackedOhlc, failedTicker, failedOhlc, failed,
    },
    recording: object(raw.recording) ? {
      state: recordingState,
      directoryConfigured: typeof raw.recording.dir === 'string' && raw.recording.dir.length > 0,
      segments, bytes: recordedBytes, records,
      latestBytes: count(raw.recording.latestBytes),
      latestWrittenTs: timestamp(raw.recording.latestWrittenTs) ? raw.recording.latestWrittenTs : null,
      latestSnapshotWrites: count(raw.recording.latestSnapshotWrites ?? raw.recording.latestWrites),
      latestSnapshotCadenceMs: count(raw.recording.latestSnapshotCadenceMs),
      coalescedSnapshotRecords: count(raw.counters?.coalescedSnapshotRecords),
      queued: count(raw.recording.queued), maxQueue: count(raw.recording.maxQueue),
      unflushedRecords: count(raw.recording.unflushedRecords),
      evictedSegments: count(raw.recording.evictedSegments), evictedBytes: count(raw.recording.evictedBytes),
      error: recordingError ? 'PRESENT_REDACTED' : raw.recording.error === null ? null : 'UNKNOWN',
      durability: raw.recording.durability ? text(raw.recording.durability, 80) : null,
      retention: raw.recording.retention ? text(raw.recording.retention, 80) : null,
    } : { state: 'UNKNOWN', directoryConfigured: false, segments: null, bytes: null, records: null, queued: null, maxQueue: null, unflushedRecords: null, evictedSegments: null, evictedBytes: null, error: 'UNKNOWN', durability: null, retention: null },
    freshness: {
      tickerFreshMs, candleFreshMs,
      freshTicker: ticker.fresh, completeTicker, staleTicker: ticker.stale, neverTicker: ticker.never, invalidTicker: ticker.invalid,
      idleTicker: ticker.idle, pendingTicker: ticker.pending, pendingCandle: candle.pending,
      freshCandle: candle.fresh, provisionalFreshCandle: candle.provisionalFresh, completeCandle,
      staleCandle: candle.stale, neverCandle: candle.never, invalidCandle: candle.invalid,
      provisionalCandle: rows.filter((row) => row.candle.state === 'PROVISIONAL_FRESH' || row.candle.state === 'PROVISIONAL_STALE').length,
      reported: object(raw.freshness) ? {
        freshTicker: count(raw.freshness.freshTicker), staleTicker: count(raw.freshness.staleTicker), neverTicker: count(raw.freshness.neverTicker),
        freshCandle: count(raw.freshness.freshCandle), staleCandle: count(raw.freshness.staleCandle), neverCandle: count(raw.freshness.neverCandle), provisionalCandle: count(raw.freshness.provisionalCandle),
      } : null,
    },
    coverage: {
      denominator: catalogMarkets,
      mapped, unsupported, ambiguous,
      ackedTicker, ackedOhlc, failed,
      persistedRecords: records,
      fullCatalogRows, catalogFresh, allMapped, allSubscribed, allFresh, persisted,
    },
    validation: {
      state: overflow || inputRows === null || invalidRows > 0 || duplicateIdentities > 0 ? 'REFUSED' : 'ACCEPTED',
      reason: overflow ? 'PER_MARKET_OVERFLOW' : inputRows === null ? 'PER_MARKET_MISSING' : invalidRows > 0 ? 'PER_MARKET_INVALID' : duplicatePairKeys > 0 ? 'PAIR_KEY_DUPLICATE' : duplicateCoins > 0 ? 'CANONICAL_COIN_DUPLICATE' : duplicateWsSymbols > 0 ? 'WS_SYMBOL_DUPLICATE' : null,
      reportedRows: inputRows?.length ?? null,
      maxRows: DATA_ONLY_BROAD_MARKET_MAX_ROWS,
      invalidRows,
      duplicatePairKeys,
      duplicateCoins, duplicateWsSymbols,
    },
    perMarket: rows,
  };
}

export function dataOnlyPublicStatus(evaluated) {
  const source = object(evaluated?.status) ? evaluated.status : {};
  const persistence = source.collectors?.persistence;
  const observedMarket = publicMarket(source.collectors?.market, evaluated?.evaluatedAtTs);
  const observedBroadMarket = publicBroadMarket(source.collectors?.broadMarket, evaluated?.evaluatedAtTs);
  const market = observedMarket && evaluated?.effectiveRunning !== true
    ? { ...observedMarket, reportedState: observedMarket.state, state: evaluated?.healthState ?? 'STALE', running: false }
    : observedMarket;
  const broadMarket = observedBroadMarket && evaluated?.effectiveRunning !== true
    ? { ...observedBroadMarket, reportedState: observedBroadMarket.state, state: evaluated?.healthState ?? 'STALE', running: false, reason: `RUNTIME_${evaluated?.statusReason ?? 'NOT_LIVE'}` }
    : observedBroadMarket;
  return {
    mode: 'DATA_ONLY', version: source.version ?? DATA_ONLY_RUNTIME_STATUS_VERSION,
    healthState: evaluated?.healthState ?? 'UNAVAILABLE', statusReason: evaluated?.statusReason === undefined ? 'STATUS_UNAVAILABLE' : evaluated.statusReason,
    running: evaluated?.effectiveRunning === true, reportedRunning: evaluated?.reportedRunning === true,
    lifecycle: evaluated?.lifecycle ?? 'UNAVAILABLE', startupPhase: evaluated?.startupPhase ?? null,
    tsMs: timestamp(source.tsMs) ? source.tsMs : null, heartbeatAgeMs: evaluated?.heartbeatAgeMs ?? null,
    heartbeatMaxAgeMs: evaluated?.heartbeatMaxAgeMs ?? DATA_ONLY_HEARTBEAT_MAX_AGE_MS,
    pid: positivePid(source.pid) ? source.pid : null, startedTs: timestamp(source.startedTs) ? source.startedTs : null,
    authority: 'NONE', safety: object(source.safety) ? source.safety : {},
    catalog: object(source.catalog) ? {
      contentId: typeof source.catalog.contentId === 'string' ? text(source.catalog.contentId, 64) : null,
      observedTs: timestamp(source.catalog.observedTs) ? source.catalog.observedTs : null,
      markets: Number.isSafeInteger(source.catalog.markets) && source.catalog.markets >= 0 ? source.catalog.markets : null,
      policy: source.catalog.policy ? text(source.catalog.policy, 120) : null,
    } : null,
    spending: object(source.spending) ? source.spending : null,
    blockers: object(source.blockers) ? Object.fromEntries(Object.entries(source.blockers).slice(0, 64).map(([key, value]) => [text(key, 64), text(value)])) : {},
    market, broadMarket,
    persistence: object(persistence) ? {
      status: persistence.status ? text(persistence.status, 64) : null,
      databaseConfigured: persistence.databaseConfigured === true,
      restored: persistence.restored === true,
      failureCategory: persistence.failureCategory ? text(persistence.failureCategory, 80) : null,
    } : null,
  };
}

const rowState = (value) => text(value, 64) || 'NOT_OBSERVED';
const lastTs = (value) => timestamp(value) ? value : null;
const age = (ts, now) => ts === null ? null : Math.max(0, now - ts);

export function dataOnlySensorSnapshot(evaluated, { now = Date.now() } = {}) {
  const source = object(evaluated?.status) ? evaluated.status : {};
  const collectors = object(source.collectors) ? source.collectors : {};
  const rows = []; const groups = { RUNTIME: [], MARKET: [], NEWS: [], SOCIAL: [], INFRASTRUCTURE: [], STORAGE: [] };
  const add = (group, values) => {
    const ts = lastTs(values.lastSuccessTs);
    const reportedState = rowState(values.state);
    const state = group !== 'RUNTIME' && evaluated?.effectiveRunning !== true && ['STARTING', 'ACTIVE', 'OBSERVED', 'EMPTY', 'CURRENT_VIEW'].includes(reportedState) ? (evaluated?.healthState ?? 'STALE') : reportedState;
    const row = { id: values.id, name: values.name, group, state, desiredState: values.desiredState ?? 'ON', lastSuccessTs: ts, ageMs: age(ts, now), coverage: values.coverage ?? 'NOT_OBSERVED', blocker: state !== reportedState ? `runtime ${evaluated?.healthState ?? 'STALE'}: ${evaluated?.statusReason ?? 'not live'}` : values.blocker ?? null, detail: values.detail ?? null, authority: 'NONE' };
    rows.push(row); groups[group].push(row.id);
  };

  add('RUNTIME', { id: 'DATA_ONLY_RUNTIME', name: 'Data-only collector runtime', state: evaluated?.healthState ?? 'UNAVAILABLE', lastSuccessTs: lastTs(source.tsMs), coverage: `${evaluated?.lifecycle ?? 'UNAVAILABLE'}${evaluated?.startupPhase ? `; phase ${evaluated.startupPhase}` : ''}; heartbeat ${evaluated?.heartbeatAgeMs ?? 'n/a'} ms`, blocker: evaluated?.effectiveRunning ? null : evaluated?.statusReason ?? 'STATUS_UNAVAILABLE' });

  const publicStatus = dataOnlyPublicStatus(evaluated);
  const market = collectors.market;
  if (object(market)) {
    const publishedMarket = publicStatus.market;
    const subjects = Array.isArray(market.scope?.subjects) ? market.scope.subjects.slice(0, 64) : [];
    const count = Number.isSafeInteger(market.scope?.subjectCount) ? market.scope.subjectCount : subjects.length;
    const receipts = Number.isFinite(market.counters?.observations) ? market.counters.observations : 0;
    const marketBlocker = publishedMarket?.recording?.state === 'FAILED' ? `recording failed${publishedMarket.recording.where ? ` at ${publishedMarket.recording.where}` : ''}` : publishedMarket?.streamHealth?.state !== 'HEALTHY' ? publishedMarket?.streamHealth?.reason : market.stopped?.reason ?? null;
    add('MARKET', { id: 'MARKET_CAPTURE', name: 'Deep market capture (BTC/ETH/SOL)', state: publishedMarket?.state ?? market.state, coverage: `deep capture scope ${count} subjects (${subjects.join(', ') || 'none'}); ${receipts} observations; broad catalog coverage is reported separately`, blocker: marketBlocker, detail: 'High-detail bounded subject capture; it is not the all-market breadth collector.' });
    for (const [id, provider] of Object.entries(object(market.sources) ? market.sources : {})) add('MARKET', { id: `MARKET_${id}`, name: `Market provider: ${id}`, state: provider.state, coverage: `requests ${provider.requests ?? 0}; succeeded ${provider.succeeded ?? 0}; failed ${provider.failed ?? 0}; today ${provider.callsToday ?? 0}/${provider.dailyCap ?? 0}`, blocker: provider.reason ?? null });
    for (const [id, stream] of Object.entries(publishedMarket?.streams ?? {})) add('MARKET', { id: `MARKET_WS_${id}`, name: `Market WebSocket: ${id}`, state: stream.healthState === 'HEALTHY' ? 'ACTIVE' : stream.healthState === 'STARTING' ? 'STARTING' : 'DEGRADED', lastSuccessTs: stream.lastMessageTs, coverage: `${stream.state}; ${stream.messages ?? 0} messages; ${stream.reconnects ?? 0} reconnects`, blocker: stream.reason });
  } else add('MARKET', { id: 'MARKET_CAPTURE', name: 'Deep market capture (BTC/ETH/SOL)', state: 'NOT_OBSERVED', coverage: 'NO_RUNTIME_STATUS', blocker: source.blockers?.MARKET ?? 'market runtime unavailable' });

  const broad = publicStatus.broadMarket;
  if (broad) {
    const denominator = broad.coverage.denominator ?? 'unknown';
    const lastSuccessTs = Math.max(0, ...broad.perMarket.flatMap((row) => [row.ticker.lastReceivedTs ?? 0, row.candle.lastReceivedTs ?? 0])) || null;
    add('MARKET', {
      id: 'BROAD_KRAKEN_MARKET', name: 'Broad Kraken market observations', state: broad.state, lastSuccessTs,
      coverage: `all accepted Kraken USD markets ${broad.scope.projectedMarkets}/${denominator}; ticker/24h-volume acked ${broad.coverage.ackedTicker ?? 0}/${denominator}, complete+fresh ${broad.freshness.completeTicker}/${denominator}; candles acked ${broad.coverage.ackedOhlc ?? 0}/${denominator}, complete+fresh ${broad.freshness.completeCandle}/${denominator} (closed ${broad.freshness.freshCandle}, provisional ${broad.freshness.provisionalFreshCandle}); persisted ${broad.recording.records ?? 0} records in ${broad.recording.segments ?? 0} segments`,
      blocker: broad.state === 'ACTIVE' ? null : broad.reason,
      detail: 'Shallow ticker/24h-volume and OHLC observations for every accepted Kraken USD catalog market; no named-asset or top-N filter.',
    });
  } else add('MARKET', { id: 'BROAD_KRAKEN_MARKET', name: 'Broad Kraken market observations', state: 'NOT_OBSERVED', coverage: `0/${source.catalog?.markets ?? 'unknown'} accepted Kraken USD markets`, blocker: source.blockers?.BROAD_KRAKEN_MARKET ?? 'broad market runtime unavailable', detail: 'No all-catalog coverage is inferred from catalog membership alone.' });

  const eye = collectors.wideeye;
  add('MARKET', { id: 'WIDEEYE', name: 'Wide eye discovery catalog', state: source.catalog ? 'ACTIVE' : rowState(eye?.state), lastSuccessTs: lastTs(eye?.tsMs ?? eye?.lastSuccessTs), coverage: source.catalog ? `${source.catalog.markets} accepted Kraken USD markets (discovery universe, not capture scope)` : 'NO_ACCEPTED_CATALOG', blocker: source.blockers?.WIDEEYE ?? source.blockers?.KRAKEN_CATALOG ?? null });

  const discovery = collectors.discovery;
  for (const [id, entry] of Object.entries(object(discovery?.sources) ? discovery.sources : {})) {
    const group = id === 'GDELT_NEWS_DISCOVERY' ? 'NEWS' : 'MARKET';
    add(group, { id, name: id.replaceAll('_', ' '), state: entry.state, lastSuccessTs: lastTs(entry.clocks?.lastSuccessTs ?? entry.lastSuccessTs), coverage: entry.coverage ?? `${entry.counters?.admitted ?? 0} admitted`, blocker: entry.lastError ?? entry.gateDetail ?? null });
  }

  const news = collectors.news;
  for (const [id, entry] of Object.entries(object(news?.sources) ? news.sources : {})) add('NEWS', { id, name: id.replaceAll('_', ' '), state: entry.state, lastSuccessTs: lastTs(entry.checkedTs), coverage: entry.enabled ? 'official/indexed observation route enabled' : 'route not enabled', blocker: entry.gateDetail ?? null });
  if (object(collectors.press)) add('NEWS', { id: 'PUBLISHER_NEWS', name: 'Publisher news content', state: collectors.press.state, coverage: collectors.press.coverage ?? 'NO_PUBLISHER_CONTENT', blocker: collectors.press.gateDetail ?? null, desiredState: collectors.press.desired ?? 'OFF' });

  const r2 = collectors.rumor2;
  if (object(r2)) {
    for (const [id, entry] of [['BLUESKY_OFFICIAL', r2.social], ['X_OFFICIAL', r2.socialX], ['FARCASTER_OFFICIAL', r2.socialFarcaster]]) if (object(entry)) add('SOCIAL', { id, name: id.replaceAll('_', ' '), state: entry.state, lastSuccessTs: lastTs(entry.lastSuccessTs ?? entry.stream?.lastEventTs ?? entry.lastEventTs), coverage: entry.coverage ?? entry.scope?.coverage?.state ?? 'NOT_OBSERVED', blocker: entry.gateReason ?? entry.gateDetail ?? entry.lastError ?? null });
    for (const [id, entry] of Object.entries(object(r2.socialCurrent?.sources) ? r2.socialCurrent.sources : {})) add('SOCIAL', { id, name: id.replaceAll('_', ' '), state: entry.state, lastSuccessTs: lastTs(entry.lastSuccessTs), coverage: entry.coverage ?? 'CURRENT_VIEW_ONLY', blocker: entry.gateReason ?? entry.lastError ?? null });
  } else add('SOCIAL', { id: 'RUMOR2_SOCIAL', name: 'Rumor2 social collectors', state: 'NOT_OBSERVED', coverage: 'NO_RUNTIME_STATUS', blocker: source.blockers?.RUMOR2 ?? 'Rumor2 runtime unavailable' });
  const video = collectors.youtube;
  if (object(video)) add('SOCIAL', { id: 'YOUTUBE_DATA_API', name: 'YouTube metadata', state: video.state, lastSuccessTs: lastTs(video.lastSuccessTs), coverage: video.coverage ?? 'METADATA_ONLY', blocker: video.gateDetail ?? video.lastError ?? null });

  const infra = collectors.infra;
  for (const [id, entry] of Object.entries(object(infra?.sources) ? infra.sources : {})) add('INFRASTRUCTURE', { id: `INFRA_${id}`, name: id.replaceAll('_', ' '), state: entry.state, lastSuccessTs: lastTs(entry.lastSuccessTs), coverage: entry.coverage ?? `${entry.counters?.admitted ?? 0} admitted`, blocker: entry.gateDetail ?? entry.lastError ?? null });
  const persistence = collectors.persistence;
  add('STORAGE', { id: 'PERSISTENCE', name: 'Durable PostgreSQL journal', state: persistence?.restored ? 'ACTIVE' : 'BLOCKED', lastSuccessTs: lastTs(persistence?.lastSuccessfulWriteTs ?? persistence?.lastSuccessfulReadTs), coverage: persistence?.databaseConfigured ? `configured; ${persistence.status ?? 'unavailable'}` : 'DATABASE_URL not configured', blocker: persistence?.restored ? null : persistence?.failureCategory ?? 'NOT_RESTORED' });

  return {
    enabled: true, profileApplied: true, profile: 'data-only', runtimeMode: 'DATA_ONLY', generatedTs: now,
    authority: { realMoney: 'DISABLED', liveOrders: 'DISABLED', withdrawFunding: 'DISABLED', judgeMode: 'OFF' },
    groups, rows, counts: Object.fromEntries([...new Set(rows.map((row) => row.state))].map((state) => [state, rows.filter((row) => row.state === state).length])),
    controls: { kill: false, cage: false }, locks: null,
    persistence: publicStatus.persistence,
    dataOnly: publicStatus,
    law: 'DATA_ONLY: liveness requires a current heartbeat and matching runtime lock; collector observations retain their own explicit observed, blocked, disabled, or starting state; deep capture and all-catalog broad observation are reported separately, and catalog membership alone never implies live coverage.',
  };
}

export function dataOnlyMarketView(evaluated) {
  const published = dataOnlyPublicStatus(evaluated);
  const market = published.market;
  const broadMarket = published.broadMarket;
  const observations = Number(market?.receipts?.observations ?? 0);
  return {
    enabled: market !== null || broadMarket !== null,
    dataOnly: true,
    status: market ? {
      state: market.state, mode: 'DATA_ONLY', policyMode: 'OBSERVATION_ONLY', nowTs: published.tsMs,
      model: { model: null, enabled: false, credentialPresent: false, credentialEnv: null, caps: { perCase: 0, perDay: 0, perMonth: 0 } },
      owner: { counters: { tapeTrades: null, tapeBooks: null, tapeDropped: null, acquisitions: observations } },
      runtime: { cacheSize: 0, budget: { dayUsd: 0, monthUsd: 0, unresolvedUsd: 0 } },
      cases: { queued: 0, running: 0 }, quota: { usedBytes: null, quotaBytes: null },
    } : null,
    market, broadMarket,
    cases: [], authority: 'NONE', purpose: 'OBSERVATION_ONLY',
    scopeLaw: 'market.scope is deep capture; broadMarket.scope is separately verified all-catalog breadth; catalog membership alone never substitutes for live, fresh, persisted observations',
  };
}
