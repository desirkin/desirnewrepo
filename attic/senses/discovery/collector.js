// Public discovery collectors: account-free, read-only metadata only. DARK unless
// DISCOVERY_ENABLED=true, named sources are selected, and every selected source has
// an explicit positive daily request budget. A durable reservation is appended before
// every wire request, so a crash can never erase consumed budget. Authority is NONE.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { appendJsonl, atomicWriteJson, readJsonBounded, readJsonlTail } from '../lib/jsonl.js';
import { dataDir as defaultDataDir } from '../lib/config.js';
import { fetchJsonBounded } from '../lib/bounded-fetch.js';
import { DISCOVERY_SOURCES, discoveryRegistryError } from './registry.js';
import { validateDiscoveryCheckpoint } from './external-checkpoint.js';
import { discoveryCatalogContext, gdeltCatalogQuery } from './query.js';
import { mapGdeltArticles, mapPolymarketMarkets, mapKalshiMarkets, discoveryObservationError } from './parse.js';
import { normalizeHttpContact } from '../rumor2/registry.js';
import {
  DISCOVERY_STATUS_VERSION, discoveryDir, discoveryStatusFile, discoveryObservationsFile,
  discoveryReceiptsFile, discoveryCheckpointFile, discoveryWriterFile,
} from './reader.js';

// Windows does not permit fsync on a directory handle; Linux production gets
// the full file+directory sync path used by the other durable collectors.
const writeAtomicDurable = (file, value) => atomicWriteJson(file, value, { sync: process.platform !== 'win32' });

export const DISCOVERY_CHECKPOINT_VERSION = 'public-discovery-checkpoint-1';
export const DISCOVERY_RECEIPT_VERSION = 'public-discovery-receipt-1';
export const DISCOVERY_RUNTIME = Object.freeze({
  timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, maxObservationsBytes: 64 * 1024 * 1024,
  maxReceiptsBytes: 16 * 1024 * 1024, firstDelayMs: 5_000, staggerMs: 2_000,
  backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, rateLimitFloorMs: 60_000,
});
const STATES = Object.freeze(['DISABLED', 'CONFIG_REQUIRED', 'CATALOG_REQUIRED', 'IDLE', 'OBSERVED', 'EMPTY', 'RATE_LIMITED', 'FAILED', 'RETENTION_CAP', 'BUDGET_STOPPED', 'DURABILITY_BLOCKED']);
const active = new Map();
const boundedErr = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 240);
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const strictInt = (value, min, max) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value); return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};
const pageBound = (source) => source.id === 'GDELT_NEWS_DISCOVERY' ? [1, 250] : source.id === 'POLYMARKET_PUBLIC_DATA' ? [1, 100] : [1, 1000];
const defaultPage = (source) => source.id === 'GDELT_NEWS_DISCOVERY' ? 50 : source.id === 'POLYMARKET_PUBLIC_DATA' ? 100 : 1000;
const fullSweepGap = (source, checkpoint) => {
  if (source.id === 'GDELT_NEWS_DISCOVERY') return 'GDELT is an index, not a direct or licensed publisher feed; article bodies and guaranteed publication timestamps are unavailable.';
  const cursor = checkpoint.cursor ?? null;
  return cursor ? `Provider catalog pagination is partial; next cursor is pending (${source.coverage}).` : `Public market metadata only; no order placement, account data, wallet data, or guaranteed full historical archive (${source.coverage}).`;
};

export const discoveryEnabled = (env = process.env) => env.DISCOVERY_ENABLED === 'true';
export const discoverySelectedIds = (env = process.env) => [...new Set(String(env.DISCOVERY_SOURCES ?? '').split(',').map((x) => x.trim()).filter(Boolean))];

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

function endpointFor(source, st, context) {
  if (source.id === 'GDELT_NEWS_DISCOVERY') {
    const plan = gdeltCatalogQuery(context, { requestOrdinal: st.queryOrdinal, assetsPerQuery: st.assetsPerQuery });
    if (plan.error) return plan;
    const q = new URLSearchParams({ query: plan.query, mode: 'artlist', maxrecords: String(st.pageLimit), timespan: '1d', sort: 'datedesc', format: 'json' });
    return { url: `${source.baseUrl}?${q}`, plan };
  }
  if (source.id === 'POLYMARKET_PUBLIC_DATA') {
    const q = new URLSearchParams({ limit: String(st.pageLimit), closed: 'false' });
    if (st.cursor) q.set('after_cursor', st.cursor);
    return { url: `${source.baseUrl}?${q}`, plan: null };
  }
  const q = new URLSearchParams({ limit: String(st.pageLimit), status: 'open', mve_filter: 'exclude' });
  if (st.cursor) q.set('cursor', st.cursor);
  return { url: `${source.baseUrl}?${q}`, plan: null };
}

function normalizeProviderEnvelope(sourceId, json, { pageLimit, currentCursor } = {}) {
  if (sourceId === 'POLYMARKET_PUBLIC_DATA') {
    // The pinned /markets/keyset contract is cursor based. In particular, a
    // full page must carry next_cursor; treating a malformed/legacy array as
    // the end of a sweep would silently keep restarting at page one.
    const rows = Array.isArray(json?.markets) ? json.markets : null;
    if (!rows) return { error: 'Polymarket keyset response has no markets array' };
    if (rows.length > pageLimit) return { error: 'Polymarket keyset response exceeds the requested page limit' };
    const raw = json.next_cursor;
    if (!(raw === undefined || raw === null || typeof raw === 'string')) return { error: 'Polymarket next cursor is malformed' };
    if (typeof raw === 'string' && raw.length > 4096) return { error: 'Polymarket next cursor exceeds the durable bound' };
    const nextCursor = typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (rows.length === pageLimit && nextCursor === null) return { error: 'Polymarket full keyset page is missing next cursor' };
    if (nextCursor !== null && nextCursor === currentCursor) return { error: 'Polymarket next cursor did not advance' };
    return { markets: rows, next_cursor: nextCursor };
  }
  if (sourceId === 'KALSHI_PUBLIC_DATA') {
    if (!Array.isArray(json?.markets)) return { error: 'Kalshi response has no markets array' };
    if (json.markets.length > pageLimit) return { error: 'Kalshi response exceeds the requested page limit' };
    if (typeof json.cursor !== 'string') return { error: 'Kalshi response cursor is missing or malformed' };
    if (json.cursor.length > 4096) return { error: 'Kalshi next cursor exceeds the durable bound' };
    const nextCursor = json.cursor.length > 0 ? json.cursor : null;
    if (nextCursor !== null && nextCursor === currentCursor) return { error: 'Kalshi next cursor did not advance' };
    return { ...json, cursor: nextCursor };
  }
  return json;
}

export function startPublicDiscovery({
  env = process.env, dataDir = defaultDataDir(), catalogSource = null, fetchImpl = fetch,
  clock = () => Date.now(), log = console.log, sources = DISCOVERY_SOURCES,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval }, firstDelayMs = DISCOVERY_RUNTIME.firstDelayMs,
  signals = true, durableCheckpoint = null,
} = {}) {
  if (!discoveryEnabled(env)) { log('[discovery] dark — DISCOVERY_ENABLED is not true; zero network'); return null; }
  if (active.has(dataDir)) { log('[discovery] already running for this data dir — not started twice'); return active.get(dataDir); }
  const registryError = discoveryRegistryError(sources); if (registryError) throw new Error(`discovery registry: ${registryError}`);
  mkdirSync(discoveryDir(dataDir), { recursive: true });
  const selected = new Set(discoverySelectedIds(env));
  const knownIds = new Set(sources.map((source) => source.id));
  const unknown = [...selected].filter((id) => !knownIds.has(id));
  if (unknown.length) throw new Error(`discovery sources unknown: ${unknown.join(', ')}`);
  if (!durableCheckpoint || typeof durableCheckpoint.snapshot !== 'function' || typeof durableCheckpoint.update !== 'function' || typeof durableCheckpoint.failed !== 'function') throw new Error('public discovery deployment-durable checkpoint binding is required; collection withheld');
  const checkpoint = durableCheckpoint.snapshot();
  const checkpointValidation = validateDiscoveryCheckpoint(checkpoint, { sources });
  if (!checkpointValidation.ok) throw new Error(`public discovery durable checkpoint invalid: ${checkpointValidation.error}`);
  if (durableCheckpoint.failed()) throw new Error('public discovery durable checkpoint is fault-latched; collection withheld');
  const S = new Map(); let stopping = false; let checkpointFailure = null; const timerSet = new Set(); const pendingPolls = new Set();
  let writerFd;
  try { writerFd = openSync(discoveryWriterFile(dataDir), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('public discovery writer already locked; stop the existing collector first'); throw error; }

  let stopPromise = null;
  const finishStop = () => {
    active.delete(dataDir); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (writerFd !== null) { try { closeSync(writerFd); } finally { writerFd = null; try { unlinkSync(discoveryWriterFile(dataDir)); } catch {} } }
  };
  function stop() {
    if (stopPromise) return stopPromise; stopping = true;
    for (const timer of timerSet) { timers.clearTimeout(timer); timers.clearInterval(timer); }
    timerSet.clear();
    const pending = [...pendingPolls];
    if (!pending.length) { finishStop(); stopPromise = Promise.resolve(); return stopPromise; }
    stopPromise = Promise.allSettled(pending).then(finishStop);
    return stopPromise;
  }

  try {
    writeFileSync(writerFd, JSON.stringify({ pid: process.pid, openedTs: clock(), authority: 'NONE' }));
    for (const source of sources) {
      const cp = checkpoint.sources[source.id] ?? {};
      const maxDaily = strictInt(env[source.maxDailyEnv], 1, 10_000);
      const [pageMin, pageMax] = pageBound(source);
      const pageLimit = env[source.pageLimitEnv] === undefined ? defaultPage(source) : strictInt(env[source.pageLimitEnv], pageMin, pageMax);
      const assetsPerQuery = source.assetsPerQueryEnv ? (env[source.assetsPerQueryEnv] === undefined ? 8 : strictInt(env[source.assetsPerQueryEnv], 1, 12)) : null;
      const chosen = selected.has(source.id);
      const configError = chosen && maxDaily === null ? `${source.maxDailyEnv} must be an explicit integer in 1..10000`
        : chosen && pageLimit === null ? `${source.pageLimitEnv} must be an integer in ${pageMin}..${pageMax}`
        : chosen && source.assetsPerQueryEnv && assetsPerQuery === null ? `${source.assetsPerQueryEnv} must be an integer in 1..12` : null;
      S.set(source.id, {
        source, selected: chosen, maxDaily, pageLimit, assetsPerQuery, configError,
        state: !chosen ? 'DISABLED' : configError ? 'CONFIG_REQUIRED' : 'IDLE', running: false,
        cursor: cp.cursor,
        queryOrdinal: cp.queryOrdinal,
        sweepsCompleted: cp.sweepsCompleted,
        day: cp.day, reservationsToday: cp.reservationsToday, totalReservations: cp.totalReservations,
        lastReceiptTs: null, lastSuccessTs: Number.isSafeInteger(cp.lastSuccessTs) ? cp.lastSuccessTs : null,
        lastOutcome: null, lastError: configError, lastPlan: null, backoffUntil: null, backoffMs: 0,
        delays: [], coverageGap: fullSweepGap(source, cp),
        counters: { requests: 0, pages: 0, rows: 0, admitted: 0, duplicates: 0, unmatched: 0, invalid: 0, failed: 0, rateLimited: 0, empty: 0 },
      });
    }

    const seen = new Set();
    for (const [id, cp] of Object.entries(checkpoint.sources)) for (const observationId of cp.seenIds) seen.add(observationId);
    // Local observations are a mirror, not restart authority. They may be absent
    // on a clean VM; when present and complete, retain only their delay samples.
    if (existsSync(discoveryObservationsFile(dataDir))) {
      const mirror = readJsonlTail(discoveryObservationsFile(dataDir), { maxBytes: DISCOVERY_RUNTIME.maxObservationsBytes });
      if (!mirror.truncated && !mirror.torn) for (const line of mirror.lines) {
        if (!line.trim()) continue;
        try {
          const observation = JSON.parse(line); const st = S.get(observation.sourceId);
          if (!discoveryObservationError(observation) && seen.has(observation.observationId) && st && Number.isFinite(observation.discoveryDelayMs)) st.delays.push(observation.discoveryDelayMs);
        } catch { /* non-authoritative local mirror cannot advance durable truth */ }
      }
    }

    const failureCode = (error) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'CHECKPOINT_IO_FAILED';
    const latchCheckpoint = (error) => {
      if (!checkpointFailure) checkpointFailure = { code: failureCode(error), ts: clock() };
      for (const st of S.values()) if (st.selected) { st.state = 'DURABILITY_BLOCKED'; st.lastOutcome = 'DURABILITY_BLOCKED'; st.lastError = `deployment-durable checkpoint unavailable (${checkpointFailure.code})`; }
      return checkpointFailure;
    };
    const adoptDurable = (confirmed) => {
      for (const [id, durable] of Object.entries(confirmed.sources)) {
        const st = S.get(id); if (!st) continue;
        st.day = durable.day; st.reservationsToday = durable.reservationsToday; st.totalReservations = durable.totalReservations;
        st.cursor = durable.cursor; st.queryOrdinal = durable.queryOrdinal; st.sweepsCompleted = durable.sweepsCompleted; st.lastSuccessTs = durable.lastSuccessTs;
      }
    };
    async function updateDurable(reducer, phase) {
      const existingFailure = durableCheckpoint.failed();
      if (checkpointFailure || existingFailure) {
        const error = Object.assign(new Error('discovery durable checkpoint is fault-latched'), { code: existingFailure?.code ?? checkpointFailure?.code ?? 'CHECKPOINT_LATCHED' });
        latchCheckpoint(error); throw error;
      }
      let confirmed;
      try {
        confirmed = await durableCheckpoint.update((current) => {
          const before = validateDiscoveryCheckpoint(current, { sources });
          if (!before.ok) throw Object.assign(new Error(before.error), { code: 'CHECKPOINT_INVALID' });
          const next = reducer(current); next.writtenTs = clock();
          const after = validateDiscoveryCheckpoint(next, { sources });
          if (!after.ok) throw Object.assign(new Error(after.error), { code: 'CHECKPOINT_INVALID' });
          return next;
        }, { phase, authority: 'NONE' });
        const result = validateDiscoveryCheckpoint(confirmed, { sources });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: 'CHECKPOINT_CONFIRMATION_INVALID' });
      } catch (error) { latchCheckpoint(error); throw error; }
      adoptDurable(confirmed); return confirmed;
    }

    function writeCheckpoint() {
      const out = {};
      for (const [id, st] of S) out[id] = { cursor: st.cursor, queryOrdinal: st.queryOrdinal, sweepsCompleted: st.sweepsCompleted, lastSuccessTs: st.lastSuccessTs };
      writeAtomicDurable(discoveryCheckpointFile(dataDir), { v: DISCOVERY_CHECKPOINT_VERSION, writtenTs: clock(), sources: out });
    }
    function writeStatus() {
      const now = clock(); const out = {};
      for (const [id, st] of S) {
        const sweepRequests = st.lastPlan?.sweepRequests ?? null;
        const rotationDelaySec = id === 'GDELT_NEWS_DISCOVERY' && sweepRequests ? sweepRequests * st.source.cadenceSec : null;
        out[id] = {
          kind: st.source.kind, desired: st.selected ? 'ON' : 'OFF', state: st.state, authority: 'NONE', cadenceSec: st.source.cadenceSec,
          coverage: st.source.coverage, coverageGap: st.coverageGap, credentialRequired: false, paidPlanRequired: false,
          budget: { env: st.source.maxDailyEnv, day: st.day, reservations: st.reservationsToday, maxDailyRequests: st.maxDaily },
          pagination: { cursorPending: Boolean(st.cursor), pages: st.counters.pages, sweepsCompleted: st.sweepsCompleted },
          catalog: st.lastPlan ? { contentId: st.lastPlan.catalogContentId, population: st.lastPlan.population, lastQueryBases: st.lastPlan.bases, assetsPerQuery: st.lastPlan.assetsPerQuery, nextWindowOrdinal: st.queryOrdinal, fullRotationRequests: sweepRequests, maximumScheduledRotationDelaySec: rotationDelaySec } : null,
          clocks: { lastReceiptTs: st.lastReceiptTs, lastSuccessTs: st.lastSuccessTs, discoveryToReceiptMedianMs: median(st.delays), discoveryToReceiptMaxMs: st.delays.length ? Math.max(...st.delays) : null },
          lastOutcome: st.lastOutcome, lastError: st.lastError, backoffUntil: st.backoffUntil, counters: { ...st.counters },
        };
      }
      writeAtomicDurable(discoveryStatusFile(dataDir), { v: DISCOVERY_STATUS_VERSION, tsMs: now, enabled: true, authority: 'NONE', paperStarted: false, tradingRoutesUsed: false,
        durability: { deployment: checkpointFailure ? 'FAULT_LATCHED' : 'DURABLE', checkpointRevision: typeof durableCheckpoint.revision === 'function' ? durableCheckpoint.revision() : null, failure: checkpointFailure, importIntegrity: checkpoint.importIntegrity ?? null }, sources: out });
    }

    async function pollInternal(id) {
      const st = S.get(id); if (!st || stopping || checkpointFailure || durableCheckpoint.failed() || !st.selected || st.running || st.configError) {
        if (st && (checkpointFailure || durableCheckpoint.failed())) { latchCheckpoint(Object.assign(new Error('durable checkpoint fault latch'), { code: 'CHECKPOINT_LATCHED' })); writeStatus(); return { outcome: 'DURABILITY_BLOCKED', admitted: 0 }; }
        return null;
      }
      const now = clock();
      if (st.backoffUntil !== null && now < st.backoffUntil) return null;
      const day = utcDay(now); if (day !== st.day) { st.day = day; st.reservationsToday = 0; }
      if (st.reservationsToday >= st.maxDaily) { st.state = 'BUDGET_STOPPED'; st.lastOutcome = 'BUDGET_STOPPED'; writeStatus(); return { outcome: 'BUDGET_STOPPED', admitted: 0 }; }
      let snapshot; try { snapshot = catalogSource?.snapshot?.(); } catch (error) { snapshot = null; }
      const context = discoveryCatalogContext(snapshot, { nowTs: now });
      if (context.error) { st.state = 'CATALOG_REQUIRED'; st.lastError = boundedErr(context.error); st.lastOutcome = 'CATALOG_REQUIRED'; writeStatus(); return { outcome: 'CATALOG_REQUIRED', admitted: 0 }; }
      const endpoint = endpointFor(st.source, st, context);
      if (endpoint.error) { st.state = 'CONFIG_REQUIRED'; st.lastError = boundedErr(endpoint.error); st.lastOutcome = 'CONFIG_REQUIRED'; writeStatus(); return { outcome: 'CONFIG_REQUIRED', admitted: 0 }; }
      st.running = true; const requestedTs = clock(); const requestOrdinal = st.totalReservations;
      const requestId = sha256(`${id}|${requestedTs}|${requestOrdinal}|${endpoint.url}`);
      const reservation = { v: DISCOVERY_RECEIPT_VERSION, phase: 'RESERVED', requestId, sourceId: id, day: st.day, requestOrdinal, queryOrdinal: st.queryOrdinal, requestedTs, authority: 'NONE' };
      let reservationRecorded = false;
      try {
        if (existsSync(discoveryReceiptsFile(dataDir)) && statSync(discoveryReceiptsFile(dataDir)).size >= DISCOVERY_RUNTIME.maxReceiptsBytes) { st.state = 'RETENTION_CAP'; st.lastError = 'receipt storage cap reached'; return { outcome: 'RETENTION_CAP', admitted: 0 }; }
        // The externally durable quota is reserved before either the local
        // audit mirror or the wire can advance. A crash may overcount, never
        // reset or undercount a provider request.
        await updateDurable((current) => {
          const durable = current.sources[id];
          const reservationsToday = durable.day === reservation.day ? durable.reservationsToday : 0;
          current.sources[id] = { ...durable, day: reservation.day, reservationsToday: reservationsToday + 1, totalReservations: durable.totalReservations + 1 };
          return current;
        }, `RESERVE:${id}`);
        try { appendJsonl(discoveryReceiptsFile(dataDir), reservation, { sync: true }); reservationRecorded = true; }
        catch (error) { latchCheckpoint(Object.assign(new Error('local reservation audit write failed'), { code: 'LOCAL_RECEIPT_WRITE_FAILED', cause: error })); throw error; }
        st.counters.requests += 1;
        const normalizedContact = normalizeHttpContact(env.SERPENT_HTTP_CONTACT);
        const researchUserAgent = normalizedContact
          ? `SerpentCobra/public-discovery/1.0 (read-only metadata research; contact: ${normalizedContact})`
          : 'SerpentCobra/public-discovery/1.0 (read-only metadata research)';
        const result = await fetchJsonBounded(endpoint.url, { host: st.source.host, fetchImpl, timeoutMs: DISCOVERY_RUNTIME.timeoutMs, maxBytes: DISCOVERY_RUNTIME.maxBytes, maxRedirects: 0, headers: { 'user-agent': researchUserAgent } });
        const receiptTs = clock(); st.lastReceiptTs = receiptTs; let mapped = null; let outcome = result.outcome;
        if (result.outcome === 'OK') {
          const envelope = normalizeProviderEnvelope(id, result.json, { pageLimit: st.pageLimit, currentCursor: st.cursor });
          mapped = envelope?.error ? envelope
            : id === 'GDELT_NEWS_DISCOVERY' ? mapGdeltArticles(envelope, { context, plan: endpoint.plan, receiptTs, limit: st.pageLimit })
              : id === 'POLYMARKET_PUBLIC_DATA' ? mapPolymarketMarkets(envelope, { context, receiptTs })
                : mapKalshiMarkets(envelope, { context, receiptTs });
          if (mapped.error) outcome = 'PARSE_FAILED';
        }
        let admitted = 0; let duplicates = 0; const admittedIds = [];
        if (outcome === 'OK') {
          const file = discoveryObservationsFile(dataDir);
          for (const observation of mapped.observations) {
            const invalid = discoveryObservationError(observation); if (invalid) { mapped.invalid = (mapped.invalid ?? 0) + 1; continue; }
            if (seen.has(observation.observationId)) { duplicates += 1; continue; }
            if ((existsSync(file) ? statSync(file).size : 0) + Buffer.byteLength(JSON.stringify(observation)) + 1 > DISCOVERY_RUNTIME.maxObservationsBytes) { outcome = 'RETENTION_CAP'; break; }
            appendJsonl(file, observation, { sync: true }); seen.add(observation.observationId); admittedIds.push(observation.observationId); admitted += 1;
            if (Number.isFinite(observation.discoveryDelayMs)) { st.delays.push(observation.discoveryDelayMs); if (st.delays.length > 2000) st.delays.shift(); }
          }
          st.counters.rows += mapped.observed ?? 0; st.counters.admitted += admitted; st.counters.duplicates += duplicates;
          st.counters.unmatched += mapped.unmatched ?? 0; st.counters.invalid += mapped.invalid ?? 0; st.counters.pages += 1;
          if (outcome === 'OK') {
            // Pagination and exact dedupe identities settle in the same
            // externally durable row before the status/return can say success.
            await updateDurable((current) => {
              const durable = current.sources[id]; const ids = new Set(durable.seenIds);
              for (const observationId of admittedIds) ids.add(observationId);
              let queryOrdinal = durable.queryOrdinal; let sweepsCompleted = durable.sweepsCompleted; let cursor = durable.cursor;
              if (id === 'GDELT_NEWS_DISCOVERY') { queryOrdinal += 1; if (queryOrdinal % endpoint.plan.sweepRequests === 0) sweepsCompleted += 1; }
              else { cursor = mapped.nextCursor; if (!cursor) sweepsCompleted += 1; }
              current.sources[id] = { ...durable, cursor, queryOrdinal, sweepsCompleted, lastSuccessTs: receiptTs, seenIds: [...ids].sort() };
              return current;
            }, `SETTLE:${id}`);
            if (id === 'GDELT_NEWS_DISCOVERY') st.lastPlan = endpoint.plan;
            st.state = admitted ? 'OBSERVED' : 'EMPTY'; st.counters.empty += admitted ? 0 : 1; st.lastError = null; st.backoffUntil = null; st.backoffMs = 0;
            st.coverageGap = fullSweepGap(st.source, st);
            writeCheckpoint();
          } else { st.state = 'RETENTION_CAP'; st.lastError = 'observation storage cap reached'; }
        } else if (result.outcome === 'RATE_LIMITED') {
          const wait = Math.max(DISCOVERY_RUNTIME.rateLimitFloorMs, Math.min(DISCOVERY_RUNTIME.backoffMaxMs, Number(result.retryAfterSec ?? 60) * 1000));
          st.state = 'RATE_LIMITED'; st.counters.rateLimited += 1; st.backoffUntil = receiptTs + wait; st.lastError = `HTTP 429; retry after ${Math.round(wait / 1000)}s`;
        } else {
          st.state = 'FAILED'; st.counters.failed += 1; st.backoffMs = Math.min(st.backoffMs ? st.backoffMs * 2 : DISCOVERY_RUNTIME.backoffBaseMs, DISCOVERY_RUNTIME.backoffMaxMs); st.backoffUntil = receiptTs + st.backoffMs;
          st.lastError = boundedErr(mapped?.error ?? result.reason ?? result.outcome); outcome = mapped?.error ? 'PARSE_FAILED' : result.outcome;
        }
        st.lastOutcome = outcome;
        appendJsonl(discoveryReceiptsFile(dataDir), { v: DISCOVERY_RECEIPT_VERSION, phase: 'SETTLED', requestId, sourceId: id, day: st.day, requestOrdinal, queryOrdinal: reservation.queryOrdinal, requestedTs, receiptTs, outcome, httpStatus: result.status ?? null, observed: mapped?.observed ?? 0, admitted, duplicates, unmatched: mapped?.unmatched ?? 0, invalid: mapped?.invalid ?? 0, nextCursor: mapped?.nextCursor ? true : false, catalogContentId: context.catalog.contentId, queryBases: endpoint.plan?.bases ?? [], acquisition: id === 'GDELT_NEWS_DISCOVERY' ? 'INDEXED_DISCOVERY' : 'DIRECT_PUBLIC_METADATA', authority: 'NONE', error: st.lastError }, { sync: true });
        return { outcome, admitted, observed: mapped?.observed ?? 0, duplicates, unmatched: mapped?.unmatched ?? 0 };
      } catch (error) {
        const durableBlocked = Boolean(checkpointFailure);
        st.state = durableBlocked ? 'DURABILITY_BLOCKED' : 'FAILED'; st.counters.failed += 1; st.lastOutcome = durableBlocked ? 'DURABILITY_BLOCKED' : 'FAILED'; st.lastError = durableBlocked ? `deployment-durable checkpoint unavailable (${checkpointFailure.code})` : boundedErr(error?.message ?? error);
        st.backoffMs = Math.min(st.backoffMs ? st.backoffMs * 2 : DISCOVERY_RUNTIME.backoffBaseMs, DISCOVERY_RUNTIME.backoffMaxMs); st.backoffUntil = clock() + st.backoffMs;
        if (reservationRecorded) { try { appendJsonl(discoveryReceiptsFile(dataDir), { v: DISCOVERY_RECEIPT_VERSION, phase: 'SETTLED', requestId, sourceId: id, day: reservation.day, requestOrdinal, queryOrdinal: reservation.queryOrdinal, requestedTs, receiptTs: clock(), outcome: st.lastOutcome, httpStatus: null, observed: 0, admitted: 0, duplicates: 0, unmatched: 0, invalid: 0, nextCursor: false, catalogContentId: context.catalog.contentId, queryBases: endpoint.plan?.bases ?? [], acquisition: id === 'GDELT_NEWS_DISCOVERY' ? 'INDEXED_DISCOVERY' : 'DIRECT_PUBLIC_METADATA', authority: 'NONE', error: st.lastError }, { sync: true }); } catch {} }
        return { outcome: st.lastOutcome, admitted: 0 };
      } finally { st.running = false; if (!stopping) { try { writeStatus(); } catch (error) { log(`[discovery] status write failed: ${boundedErr(error.message)}`); } } }
    }

    function poll(id) {
      const work = pollInternal(id); pendingPolls.add(work);
      work.then(() => pendingPolls.delete(work), () => pendingPolls.delete(work));
      return work;
    }

    let index = 0;
    for (const [id, st] of S) {
      if (!st.selected || st.configError) continue;
      const first = timers.setTimeout(() => { timerSet.delete(first); poll(id).catch(() => {}); }, firstDelayMs + index * DISCOVERY_RUNTIME.staggerMs); timerSet.add(first);
      const interval = timers.setInterval(() => { poll(id).catch(() => {}); }, st.source.cadenceSec * 1000); timerSet.add(interval); index += 1;
    }
    writeStatus(); if (signals) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
    const handle = { stop, pollOnce: poll, status: () => readJsonBounded(discoveryStatusFile(dataDir)), sourceIds: [...S.keys()] };
    active.set(dataDir, handle);
    log(`[discovery] ready: ${[...S.values()].filter((st) => st.selected && !st.configError).length} public read-only source(s), authority NONE; paper not started`);
    return handle;
  } catch (error) { stop(); throw error; }
}

export function discoveryStates() { return STATES.slice(); }
