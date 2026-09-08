// MARKET LAB — THE MARKET RESEARCH OWNER (§5, closeout R01/R02/R03/R05): one owner per provider / subject / channel that
// owns acquisition, normalized observations, bounded hot state, bounded retained prefix and immutable local segments.
//  * Every HTTP dispatch crosses ONE admission guard (market-lab/quota.js) bound to the shared transport before the wire:
//    enablement, permitted endpoint, credential, replay / lifecycle, day + month caps, concurrency, native charge,
//    remaining entitlement, probe / smoke ceilings and billing class — reserved atomically in the research accounting
//    journal at a STABLE location (<researchRoot>/accounting), never in a per-run output directory. Paid dispatch needs
//    that durable journal; FREE public providers may run process-local accounting when no research root exists.
//  * Recording: an open segment fills only to segmentBytes, then is sealed and rotated into a sibling segment within the
//    run / root quotas; a real I/O / validation / quota failure is an explicit RECORDING_FAILED stop whose first error is
//    preserved; no completion manifest is ever written for a failed segment. Every retained collection is bounded.
//  * Prefix: snapshotPrefix() seals the current segment and returns a versioned immutable prefix descriptor (sealed
//    segments, ordinals, membership chain, retention facts, resource state) that a case cites and an offline reopen resolves.
//  * fly.js attaches through an optional observer (copies bounded accepted values; never a shared mutable OrderBook; queue
//    saturation = measured drop). Standalone commands use the research-only streams — never the trading application.
//    Additional research collection never broadens execution permission. Real-time activation is explicit; shipped: STOPPED.
import path from 'node:path';
import { deepFreeze, subjectId, fail, MarketLabError, PROVIDER_IDS, isTs, canonicalDigest, makeCoverage } from './contracts.js';
import { credentialPresence, providerEnabled, endpointPermitted, policyDigest } from './policy.js';
import { createHttpTransport } from './transport.js';
import { createHotState, createIntakeQueue } from './hot-state.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, publishManifest, directoryBytes, quotaState } from './store.js';
import { codeIdentity } from './identity.js';
import { resolveSubjects } from './subject-catalog.js';
import { providerReadiness } from './readiness.js';
import { createDispatchGuard, openQuotaJournal, createMemoryQuotaJournal } from './quota.js';
import { createRetainedStore } from './retention.js';
import { admitOptions, RECIPE_SET_VERSION } from './recipes.js';
import { createKrakenSpotClient } from './providers/kraken-spot.js';
import { createCoinbaseClient } from './providers/coinbase.js';
import { createKrakenDerivativesClient } from './providers/kraken-derivatives.js';
import { createDeribitClient } from './providers/deribit.js';
import { createBybitClient } from './providers/bybit.js';
import { createCoinGeckoClient, createGeckoTerminalClient } from './providers/coingecko.js';
import { createDefiLlamaClient } from './providers/defillama.js';
import { createCoinGlassClient } from './providers/coinglass.js';
import { createCryptoQuantClient, CRYPTOQUANT_METRICS } from './providers/cryptoquant.js';
import { createSantimentClient, SANTIMENT_METRICS } from './providers/santiment.js';
import { createCoinMetricsClient, COINMETRICS_METRICS } from './providers/coinmetrics.js';
import { createFredClient } from './providers/fred.js';
import { createTwelveDataClient } from './providers/twelvedata.js';
import { createSettledProjection } from './providers/settled.js';
import { createTokenomistClient } from './providers/tokenomist.js';
import { ENDPOINTS } from './registry.js';
import { DAY_MS, HOUR_MS } from './time.js';

export const OWNER_VERSION = 'market-research-owner-2';
export const PREFIX_VERSION = 'market-capture-prefix-1';
export const OWNER_MODES = Object.freeze(['STANDALONE', 'INTEGRATED']);
export const OWNER_LIFECYCLE = Object.freeze(['CREATED', 'ACTIVE', 'STOPPING', 'STOPPED', 'RECORDING_FAILED']);
export const ACCOUNTING_DIR = 'accounting';
// closeout P3: the bounded shutdown drain — in-flight acquisitions get this long to finish after abort before their continuations are
// fenced (same bound as the Socrates runtime's CLOSE_DRAIN_MS; not imported: the market owner never depends on Socrates)
export const CLOSE_DRAIN_MS = 10_000;
const FACTORIES = { KRAKEN_SPOT: createKrakenSpotClient, COINBASE_SPOT: createCoinbaseClient, KRAKEN_DERIVATIVES: createKrakenDerivativesClient, DERIBIT: createDeribitClient, BYBIT: createBybitClient, COINGECKO: createCoinGeckoClient, GECKOTERMINAL: createGeckoTerminalClient, DEFILLAMA: createDefiLlamaClient, COINGLASS: createCoinGlassClient, CRYPTOQUANT: createCryptoQuantClient, SANTIMENT: createSantimentClient, COINMETRICS: createCoinMetricsClient, FRED: createFredClient, TWELVEDATA: createTwelveDataClient, TOKENOMIST: createTokenomistClient };
export const DEFAULT_SWEEP_FAMILIES = Object.freeze(['SPOT_PRICE_CHART', 'DERIVATIVES_FUNDING_OI', 'OPTIONS_TERM_SKEW', 'SUPPLY_UNLOCKS', 'DEX_DEFI', 'ONCHAIN_ENTITY_FLOW', 'NETWORK_ACTIVITY', 'STABLECOIN_LIQUIDITY', 'ETF_FLOWS', 'MACRO_RELEASES', 'CROSS_ASSET', 'LIQUIDATIONS', 'OFFICIAL_SOCIAL_EVENTS', 'INFRASTRUCTURE_STATUS', 'CROSS_VENUE']);
// bars of history requested per interval (minutes -> bars): enough for every §7 indicator window (SMA/Bollinger 20, RSI 14,
// prior-day/week ranges) without pulling a provider's whole 720-bar tail on every sweep
export const BAR_DEPTH = Object.freeze({ 1: 180, 5: 288, 15: 192, 60: 168, 240: 180, 1440: 120 });
// the native network metrics the owner may request per route (registry metric -> native ids); closed, never invented
export const NETWORK_NATIVE_IDS = deepFreeze({ active_addresses: ['active_addresses'], transaction_count: ['transaction_count'], transfer_volume: ['transfer_volume'], network_fees: ['fees_total'], realized_value_metrics: ['mvrv', 'sopr', 'realized_price'], whale_transaction_count_100k_usd_to_inf: ['whale_transaction_count_100k_usd_to_inf'], whale_transaction_count_1m_usd_to_inf: ['whale_transaction_count_1m_usd_to_inf'], whale_transaction_volume_100k_usd_to_inf: ['whale_transaction_volume_100k_usd_to_inf'], whale_transaction_volume_1m_usd_to_inf: ['whale_transaction_volume_1m_usd_to_inf'] });
// JUDGE-1 §5.2: the whale metrics are requested at their documented 5m native interval over a bounded recent window (never aliased to a day / hour)
const WHALE_NATIVE = new Set(['whale_transaction_count_100k_usd_to_inf', 'whale_transaction_count_1m_usd_to_inf', 'whale_transaction_volume_100k_usd_to_inf', 'whale_transaction_volume_1m_usd_to_inf']);
const WHALE_5M_LOOKBACK_MS = 6 * HOUR_MS;
export const ALL_NETWORK_NATIVE = Object.freeze([...new Set(Object.values(NETWORK_NATIVE_IDS).flat()), 'supply_circulating']);
const SEEN_CAP = 262_144; // dedup keys retained (bounded ring)
const toJsonError = (err) => (err instanceof MarketLabError ? err.toJSON() : { code: err?.code === 'RESOURCE_LIMIT_EXCEEDED' ? 'RESOURCE_LIMIT_EXCEEDED' : 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) });

export function createResearchOwner({ policy, subjects, env = {}, researchRoot = null, mode = 'STANDALONE', clock = () => Date.now(), log = () => {}, transport = null, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wsUrls = {}, settledAccessors = {}, socialProjection = null, timers = { setInterval, clearInterval, setTimeout, clearTimeout }, recorder = null, quotaJournal = null, onRecordingFailure = null, closeDrainMs = CLOSE_DRAIN_MS } = {}) {
  if (!(Number.isSafeInteger(closeDrainMs) && closeDrainMs >= 0)) fail('INVALID_REQUEST', 'closeDrainMs must be a non-negative integer (ms)');
  if (!OWNER_MODES.includes(mode)) fail('INVALID_REQUEST', 'unknown owner mode');
  const limits = policy.resources; const presence = credentialPresence(policy, env); const pd = policyDigest(policy);
  let lifecycle = 'CREATED'; let stopped = true; let started = false; const recording = { error: null, failedTs: null, where: null, segmentDir: null };
  // closeout P3: ownership fence — every acquisition runs under the owned abort signal and a generation; after the bounded drain the
  // generation advances, `fenced` is set, and no late continuation can record, ingest, cache or claim admitted work
  const owned = new AbortController(); let generation = 0; let fenced = false; const inFlightAcquisitions = new Set(); const drainStats = { outcome: null, detachedAcquisitions: 0, detachedRequests: 0, fencedRequests: [] };
  const lifecycleForGuard = () => (lifecycle === 'STOPPED' || lifecycle === 'STOPPING' || lifecycle === 'RECORDING_FAILED' ? 'STOPPED' : 'ACTIVE');
  // ---- accounting authority: durable at the stable research root; process-local ONLY for free public providers -------------
  const accountingDir = researchRoot ? path.join(path.resolve(researchRoot), ACCOUNTING_DIR) : null;
  const journal = quotaJournal ?? (accountingDir ? openQuotaJournal({ dir: accountingDir, clock }) : createMemoryQuotaJournal({ clock })); const ownsJournal = quotaJournal === null;
  const guard = createDispatchGuard({ policy, env, journal, clock, mode: policy.mode, lifecycle: lifecycleForGuard, log });
  let http;
  if (transport) { if (typeof transport.bindAdmission !== 'function') fail('INVALID_REQUEST', 'an injected transport must accept the admission guard (bindAdmission)'); transport.bindAdmission(guard); http = transport; }
  else http = createHttpTransport({ fetchImpl, clock, limits, recorder, log, admission: guard, requireAdmission: true });
  // clients: constructed for every provider so readiness can describe them; only ENABLED providers ever start or request
  const clients = {};
  for (const id of PROVIDER_IDS) { if (id === 'SETTLED_RECORDS') { clients[id] = createSettledProjection({ clock, log, accessors: settledAccessors }); continue; } const env_ = policy.providers[id]?.credentialEnv ?? ENDPOINTS.find((e) => e.providerId === id && e.authEnv)?.authEnv ?? null; const credential = env_ && typeof env[env_] === 'string' && env[env_].length ? env[env_] : null; clients[id] = FACTORIES[id]({ transport: http, clock, log, credential, limits }); }
  const enabled = (id) => providerEnabled(policy, id);
  const mayCall = (id, endpointId) => guard.precheck({ providerId: id, endpointId }).ok;
  const hot = createHotState({ limits, log }); const queue = createIntakeQueue({ limits }); const retained = createRetainedStore({ limits, clock });
  const counters = { observations: 0, coverageRecords: 0, duplicateRecords: 0, tapeTrades: 0, tapeBooks: 0, tapeDropped: 0, observerErrors: 0, acquisitions: 0, acquisitionFailures: 0, rotations: 0, segmentRotations: 0, recordingRejected: 0, evictedObservations: 0 };
  const markets = new Map(); // canonicalCoin -> { kraken, coinbase, coingecko }
  let resolution = null; const streams = {}; const schedules = [];
  const shared = new Map(); // bounded shared cross-subject cache: key -> { ts, observations }
  const sharedPut = (k, v) => { shared.delete(k); shared.set(k, v); if (shared.size > limits.sharedCacheEntries) shared.delete(shared.keys().next().value); };
  const bySubjectCoin = (coin) => subjects.subjects.find((s) => s.canonicalCoin === coin) ?? null;
  // content dedup (A02): identical provider / endpoint / subject / kind / sourceKey / revision AND payload is not a new observation
  const seenKeys = new Set(); const seenOrder = [];
  const duplicate = (o) => { if (o.sourceKey === null || o.sourceKey === undefined) return false; const key = `${o.provider}|${o.endpointId}|${subjectId(o.subject)}|${o.kind}|${o.sourceKey}|${o.sourceRevision ?? ''}|${canonicalDigest(o.payload)}`; if (seenKeys.has(key)) return true; seenKeys.add(key); seenOrder.push(key); if (seenOrder.length > SEEN_CAP) seenKeys.delete(seenOrder.shift()); return false; };
  // ---- segments: bounded immutable rotation, explicit recording failure ---------------------------------------------------------
  let segment = null; let segmentBase = null; let segmentOrdinal = 0; const sealed = []; let sealedCount = 0; let runBytes = 0; let policyNonsecretForSeal = null;
  const rootQuota = () => { if (!researchRoot) return null; try { return quotaState(directoryBytes(path.resolve(researchRoot)), limits.researchRootQuotaBytes); } catch (err) { return { exhausted: true, error: String(err?.message ?? err).slice(0, 120) }; } };
  function recordingFailure(err, where) {
    if (recording.error) return; recording.error = toJsonError(err); recording.failedTs = clock(); recording.where = where; recording.segmentDir = segment?.dir ?? null;
    log(`recording failed (${where}): ${recording.error.message} — capture stopped, no seal for the failed segment`);
    if (segment) { try { segment.obs.release(); segment.cov.release(); } catch { /* best effort */ } try { segment.reservation.cleanup(); } catch { /* only this run's unsealed files */ } segment = null; }
    lifecycle = 'RECORDING_FAILED'; stopped = true;
    stopPromise = stopPromise ?? stopInternal({ seal: false, policyNonsecret: null, reason: 'RECORDING_FAILED' }); stopPromise.catch(() => {});
    if (typeof onRecordingFailure === 'function') { try { onRecordingFailure(deepFreeze({ ...recording })); } catch (cbErr) { log(`recording failure callback failed: ${String(cbErr?.message ?? cbErr).slice(0, 120)}`); } }
  }
  function openSegment(dir) {
    const real = prepareOutputTarget(dir); const reservation = reserveOutputDir(real); segmentOrdinal += 1;
    segment = { reservation, dir: real, ordinal: segmentOrdinal, obs: jsonlWriter(reservation, 'observations.jsonl', { lineBytes: limits.observationLineBytes, fileBytes: limits.segmentBytes }), cov: jsonlWriter(reservation, 'coverage.jsonl', { lineBytes: limits.coverageLineBytes, fileBytes: limits.segmentBytes }), openedTs: clock(), ordinalStart: retained.ordinal() + 1, stats: { observations: 0, coverage: 0, providers: new Set(), kinds: {}, subjects: new Set(), firstReceivedTs: null, lastReceivedTs: null } };
    return real;
  }
  const nextSegmentDir = () => `${segmentBase}-s${String(segmentOrdinal + 1).padStart(4, '0')}`;
  function sealSegment() {
    if (!segment) fail('INTERNAL_FAILURE', 'no open segment');
    const s = segment; segment = null; const st = s.stats;
    try {
      const obsD = s.obs.close(); const covD = s.cov.close();
      const catD = writeJsonFile(s.reservation, 'catalog.json', { catalogVersion: 'market-capture-catalog-1', resolution, population: resolution?.population ?? [], hot: hot.status() }, { maxBytes: limits.contextBytes });
      const polD = writeJsonFile(s.reservation, 'policy.json', policyNonsecretForSeal ?? policy, { maxBytes: limits.manifestBytes });
      const identity = codeIdentity(); const idD = writeJsonFile(s.reservation, 'code-identity.json', identity, { maxBytes: limits.manifestBytes });
      const pub = publishManifest(s.reservation, { kind: 'CAPTURE', createdTs: clock(), summary: { ownerVersion: OWNER_VERSION, mode, observations: st.observations, coverageRecords: st.coverage, providers: [...st.providers].sort(), kinds: st.kinds, subjects: [...st.subjects].sort(), firstReceivedTs: st.firstReceivedTs, lastReceivedTs: st.lastReceivedTs, hot: { subjects: hot.status().subjects, totalBytes: hot.status().totalBytes, evictions: hot.status().evictions }, queueDropped: counters.tapeDropped, openedTs: s.openedTs, segment: { ordinal: s.ordinal, ordinalStart: s.ordinalStart, ordinalEnd: retained.ordinal(), prefixVersion: PREFIX_VERSION, policyDigest: pd, recipeSetVersion: RECIPE_SET_VERSION } }, limits, identity: { sourceTreeSha256: identity.sourceTreeSha256, law: identity.law, gitCommit: identity.gitCommit }, members: [obsD, covD, catD, polD, idD] });
      const bytes = obsD.bytes + covD.bytes + catD.bytes + polD.bytes + idD.bytes + pub.manifestBytes; runBytes += bytes;
      const d = deepFreeze({ dir: s.dir, ordinal: s.ordinal, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256, observationsSha256: obsD.sha256, coverageSha256: covD.sha256, observations: st.observations, coverageRecords: st.coverage, ordinalStart: s.ordinalStart, ordinalEnd: retained.ordinal(), bytes, sealedTs: pub.manifest.createdTs });
      sealed.push(d); sealedCount += 1; if (sealed.length > limits.sealedSegmentIndex) sealed.shift();
      return { dir: s.dir, ...pub, descriptor: d };
    } catch (err) { try { s.obs.release(); s.cov.release(); } catch { /* ignore */ } s.reservation.cleanup(); throw err; }
  }
  // rotate: seal the lawful current segment and open the next one within the run / root quotas (a real failure stops recording)
  function rotate(reason) {
    if (!segment) return false;
    try {
      sealSegment(); counters.segmentRotations += 1;
      if (runBytes >= limits.runBytes) throw new MarketLabError('RESOURCE_LIMIT_EXCEEDED', `run bytes ${runBytes} reached the run bound ${limits.runBytes} (${policy.retention.onQuotaExhausted})`);
      const q = rootQuota(); if (q && q.exhausted) throw new MarketLabError('RESOURCE_LIMIT_EXCEEDED', `research root quota exhausted (${policy.retention.onQuotaExhausted})`);
      openSegment(nextSegmentDir());
      return true;
    } catch (err) { recordingFailure(err, `ROTATE_${reason}`); return false; }
  }
  // append one record to the open segment, rotating BEFORE a bound is crossed; an oversized single row is rejected (counted)
  function persist(writerName, rec) {
    if (!segment) return true;
    const w = segment[writerName]; const buf = w.encode(rec); const f = w.fits(buf);
    if (!f.line) { counters.recordingRejected += 1; return false; }
    if (!f.file) { if (segment.stats.observations + segment.stats.coverage === 0) { counters.recordingRejected += 1; return false; } if (!rotate('SIZE')) return false; }
    try { segment[writerName].appendBuffer(buf); if (runBytes + segment.obs.stats().bytes + segment.cov.stats().bytes > limits.runBytes) { recordingFailure(new MarketLabError('RESOURCE_LIMIT_EXCEEDED', `run bytes exceed the run bound ${limits.runBytes}`), 'RUN_BOUND'); return false; } return true; }
    catch (err) { recordingFailure(err, 'APPEND'); return false; }
  }
  const noteSegmentObs = (o) => { const st = segment.stats; st.observations += 1; st.providers.add(o.provider); st.kinds[o.kind] = (st.kinds[o.kind] ?? 0) + 1; if (o.subject.canonicalCoin) st.subjects.add(o.subject.canonicalCoin); st.firstReceivedTs = st.firstReceivedTs === null ? o.receivedTs : Math.min(st.firstReceivedTs, o.receivedTs); st.lastReceivedTs = st.lastReceivedTs === null ? o.receivedTs : Math.max(st.lastReceivedTs, o.receivedTs); };
  // record: a row is admitted to the retained prefix ONLY once its required recording succeeded (never healthy context without it)
  const record = (obs) => { for (const o of obs) { if (recording.error || fenced) return; if (duplicate(o)) { counters.duplicateRecords += 1; continue; } if (!persist('obs', o)) { if (recording.error) return; continue; } if (segment) noteSegmentObs(o); counters.observations += 1; const evictions = retained.push(o); if (evictions.length) { counters.evictedObservations += evictions.reduce((n, c) => n + c.droppedCount, 0); recordCoverage(evictions); } } };
  const recordCoverage = (cov) => { for (const c of cov) { if (recording.error || fenced) return; if (!persist('cov', c)) continue; if (segment) segment.stats.coverage += 1; counters.coverageRecords += 1; retained.pushCoverage(c); } };
  function ingestTrade(o) { if (fenced) return; const r = hot.addTrade(subjectId(o.subject), o.subject, o); if (r.admitted) record([o]); }
  function ingestBook(client, market, ev, sampleReason = 'INTERVAL') { if (fenced) return; const sid = subjectId(market.subject); if (!hot.shouldSampleBook(sid, ev.receivedTs)) return; const levels = ev.levels(); const o = client.bookSnapshotObservation({ market, levels, receivedTs: ev.receivedTs, epochId: ev.epochId ?? null, synced: ev.synced, checksumOk: ev.checksumOk ?? null, sampleReason, pricePrecision: ev.pricePrecision ?? null, qtyPrecision: ev.qtyPrecision ?? null }); if (!o) return; const r = hot.addBookSample(sid, market.subject, { receivedTs: o.receivedTs, bids: o.payload.bids, asks: o.payload.asks, synced: o.payload.synchronized, checksumOk: o.payload.checksumVerified, epochId: o.epochId, observationId: o.observationId }); if (r.admitted) record([o]); }
  // ---- the immutable prefix a case cites (R05): seal the current segment, then describe exactly what is retained --------------
  function snapshotPrefix() {
    if (segment && segment.stats.observations + segment.stats.coverage > 0) rotate('CASE_SNAPSHOT');
    const m = retained.membership(); const last = sealed[sealed.length - 1] ?? null; const durable = !!last && !recording.error && last.ordinalEnd >= m.lastOrdinal;
    const prefix = { prefixVersion: PREFIX_VERSION, prefixId: 'mpx-x', bundleId: last?.bundleId ?? null, manifestSha256: last?.manifestSha256 ?? null, ownerVersion: OWNER_VERSION, mode, policyDigest: pd, recipeSetVersion: RECIPE_SET_VERSION, snapshotTs: last?.sealedTs ?? clock(), durable, segmentCount: sealedCount, segments: sealed.slice(-64).map((d) => ({ dir: d.dir, ordinal: d.ordinal, bundleId: d.bundleId, manifestSha256: d.manifestSha256, observationsSha256: d.observationsSha256, coverageSha256: d.coverageSha256, observations: d.observations, coverageRecords: d.coverageRecords, ordinalStart: d.ordinalStart, ordinalEnd: d.ordinalEnd })), membership: m, limits: { retainedObservations: limits.retainedObservations, retainedCoverage: limits.retainedCoverage }, resourceState: hot.status(), recording: recording.error ? { error: recording.error, failedTs: recording.failedTs, where: recording.where } : null };
    prefix.prefixId = `mpx-${canonicalDigest({ ...prefix, prefixId: null, snapshotTs: null })}`; // same identity law as prefix.js prefixIdentity (no import: prefix.js reaches the owner through commands.js)
    return deepFreeze({ prefix, observations: retained.observations(), coverage: retained.coverage(), resourceState: prefix.resourceState });
  }
  // ---- Tape observer (INTEGRATED): copies accepted values; a failing observer never reaches the tape -------------------------
  const observer = {
    onTrade(ev) { try { if (stopped || !clients.KRAKEN_SPOT || ev.snapshot) return; const m = markets.get(ev.coin)?.kraken; if (!m) return; if (!queue.push({ t: 'trade', ev, m })) { counters.tapeDropped += 1; } } catch { counters.observerErrors += 1; } },
    onBook(ev) { try { if (stopped) return; const m = markets.get(ev.coin)?.kraken; if (!m) return; const sid = subjectId(m.subject); if (!hot.shouldSampleBook(sid, ev.receivedTs)) return; const levels = ev.levels(); if (!queue.push({ t: 'book', ev: { receivedTs: ev.receivedTs, synced: ev.synced, checksumOk: ev.checksumVerified ?? null, pricePrecision: ev.pricePrecision ?? null, qtyPrecision: ev.qtyPrecision ?? null, levels: () => levels }, m })) counters.tapeDropped += 1; } catch { counters.observerErrors += 1; } },
    onInstrument() {},
  };
  function drainQueue() { const dropped = queue.takeDropped(); if (dropped) { recordCoverage([clients.KRAKEN_SPOT.coverage({ endpointId: 'ws-v2', subject: markets.values().next().value?.kraken?.subject ?? { subjectKind: 'PROVIDER', canonicalCoin: null, providerAssetId: null, providerId: 'KRAKEN_SPOT' }, family: 'SPOT_FLOW', kind: 'TRADE', state: 'DROPPED', reasonCodes: ['QUEUE_DROPPED'], startTs: clock(), endTs: clock(), droppedCount: dropped })]); } for (const item of queue.drain(2048)) { if (stopped) return; if (item.t === 'trade') { const o = clients.KRAKEN_SPOT.tapeTradeObservation({ market: item.m, ...item.ev }); if (o) { counters.tapeTrades += 1; ingestTrade(o); } } else { counters.tapeBooks += 1; ingestBook(clients.KRAKEN_SPOT, item.m, item.ev); } } }
  // ---- acquisition (native cadence; shared daily data cached by identity; every call through the guard) -------------------------
  const usageSnapshot = () => { const c = guard.snapshot().counters; return { dispatched: c.dispatched, credits: c.credits, refused: c.refused, unresolved: c.unresolved }; };
  const optionEnrichmentTargets = (ticks, cap) => { const byExpiry = new Map(); for (const t of ticks) { const k = t.payload.expiryTs; if (!byExpiry.has(k)) byExpiry.set(k, []); byExpiry.get(k).push(t); } const out = []; for (const [, list] of [...byExpiry.entries()].sort((a, b) => a[0] - b[0])) { const idx = list.find((t) => t.payload.underlyingPrice)?.payload.underlyingPrice ?? null; if (!idx) continue; const dist = (t) => Math.abs(Math.log(t.payload.strike / idx)); const calls = list.filter((t) => t.payload.optionType === 'CALL'); const puts = list.filter((t) => t.payload.optionType === 'PUT'); const atmC = [...calls].sort((a, b) => dist(a) - dist(b))[0]; const atmP = [...puts].sort((a, b) => dist(a) - dist(b))[0]; const above = calls.filter((t) => t.payload.strike > idx).sort((a, b) => a.payload.strike - b.payload.strike).slice(0, 2); const below = puts.filter((t) => t.payload.strike < idx).sort((a, b) => b.payload.strike - a.payload.strike).slice(0, 2); for (const t of [atmC, atmP, ...above, ...below]) { if (t && !out.includes(t)) out.push(t); if (out.length >= cap) return out; } } return out; };
  function acquire(family, coin, opts = {}) { const p = acquireInternal(family, coin, opts); inFlightAcquisitions.add(p); p.then(() => inFlightAcquisitions.delete(p), () => inFlightAcquisitions.delete(p)); return p; }
  async function acquireInternal(family, coin, { signal: callerSignal = null, force = false, metricIds = null, windowStartTs = null, windowEndTs = null } = {}) {
    const signal = callerSignal ? AbortSignal.any([owned.signal, callerSignal]) : owned.signal; const gen = generation;
    const s = bySubjectCoin(coin); const m = markets.get(coin) ?? {}; const before = usageSnapshot(); const refusals = {}; let preRefused = 0; // closeout Q04: refusals BEFORE queueing are usage too
    const out = { family, coin, observations: [], coverage: [], results: [], usage: null };
    if (lifecycleForGuard() !== 'ACTIVE') { out.results.push({ providerId: null, endpointId: null, state: 'OWNER_STOPPED' }); out.usage = { dispatched: 0, credits: 0, refused: 0, unresolved: 0, reasons: { OWNER_STOPPED: 1 } }; return deepFreeze(out); }
    // closeout E04: a refusal at the guard that is an ACCESS / ENTITLEMENT fact (missing credential, exhausted or unknown entitlement,
    // unauthorised paid dispatch, a consumed cap) is recorded as coverage for this family / subject, so the context, packet and
    // case see the limitation; a disabled provider or unknown endpoint is simply not queried (no record)
    const ACCESS_REASONS = ['CREDENTIAL_MISSING', 'ENTITLEMENT_EXHAUSTED', 'ENTITLEMENT_UNKNOWN', 'SMOKE_NOT_AUTHORIZED', 'METERED_AUTHORIZATION_ABSENT', 'OVERAGE_NOT_AUTHORIZED', 'PLAN_CONFLICT', 'BILLING_UNKNOWN', 'ACCOUNTING_UNAVAILABLE'];
    const CAP_REASONS = ['DAY_CAP', 'MONTH_CAP', 'DAY_CAP_ZERO', 'MONTH_CAP_ZERO', 'METERED_CALL_CAP', 'METERED_USD_CAP', 'SMOKE_CALL_CAP', 'SMOKE_USD_CAP', 'JOURNAL_LIMIT'];
    const NOT_QUERIED_REASONS = ['PROVIDER_DISABLED', 'ENDPOINT_UNKNOWN', 'ENDPOINT_NOT_PERMITTED', 'OWNER_STOPPED', 'NETWORK_OFF'];
    const refusalCoverage = (id, endpointId, reasons) => { if (reasons.some((r) => NOT_QUERIED_REASONS.includes(r))) return null; const access = reasons.some((r) => ACCESS_REASONS.includes(r)); const cap = reasons.some((r) => CAP_REASONS.includes(r)); if (!access && !cap) return null; try { return makeCoverage({ provider: id, endpointId, subjectId: subjectId({ subjectKind: 'ASSET', canonicalCoin: coin, providerAssetId: null }), family, kind: null, state: access ? 'ACCESS_BLOCKED' : 'NOT_QUERIED', reasonCodes: [access ? (reasons.includes('CREDENTIAL_MISSING') ? 'CREDENTIAL_MISSING' : 'ENTITLEMENT_DENIED') : 'QUOTA_REFUSED'], startTs: clock(), endTs: clock(), observationCount: 0, droppedCount: 0, epochId: null, sequenceStart: null, sequenceEnd: null }); } catch { return null; } };
    const run = async (id, endpointId, key, fn, { ttlMs = null } = {}) => {
      const pre = guard.precheck({ providerId: id, endpointId });
      if (!pre.ok) { preRefused += 1; for (const r of pre.reasons) refusals[r] = (refusals[r] ?? 0) + 1; out.results.push({ providerId: id, endpointId, state: enabled(id) ? 'POLICY_REJECTED' : 'PROVIDER_DISABLED', reasons: pre.reasons }); const rc = refusalCoverage(id, endpointId, pre.reasons); if (rc) out.coverage.push(rc); return null; }
      if (ttlMs && !force && shared.has(key) && clock() - shared.get(key).ts < ttlMs) { out.observations.push(...shared.get(key).observations); out.results.push({ providerId: id, endpointId, state: 'CACHED', cachedTs: shared.get(key).ts }); return shared.get(key).result ?? null; }
      counters.acquisitions += 1; let r; const u0 = usageSnapshot(); const f0 = guard.failureCount();
      try { r = await fn(); } catch (err) { counters.acquisitionFailures += 1; out.results.push({ providerId: id, endpointId, state: 'FAILED', reason: String(err?.message ?? err).slice(0, 120) }); return null; }
      // P3: a continuation returning after the owner fenced (generation advanced) has no authority — honest cancellation, nothing admitted
      if (gen !== generation || fenced) { counters.acquisitionFailures += 1; out.results.push({ providerId: id, endpointId, state: 'CANCELLED', reason: 'OWNER_STOPPED_DURING_ACQUISITION' }); refusals.OWNER_STOPPED = (refusals.OWNER_STOPPED ?? 0) + 1; return null; }
      // P2: an acquisition whose durable accounting transition failed is not a recorded acquisition — no data is admitted from it
      if (guard.failureCount() > f0) { counters.acquisitionFailures += 1; out.results.push({ providerId: id, endpointId, state: 'ACCOUNTING_FAILED', reason: guard.accountingFailure()?.message ?? 'accounting transition failed', accounting: guard.accountingFailure() }); refusals.ACCOUNTING_UNAVAILABLE = (refusals.ACCOUNTING_UNAVAILABLE ?? 0) + 1; return null; }
      const u1 = usageSnapshot(); const used = { dispatched: u1.dispatched - u0.dispatched, credits: u1.credits - u0.credits, refused: u1.refused - u0.refused };
      if (r.ok) { out.observations.push(...(r.observations ?? [])); out.coverage.push(...(r.coverage ?? [])); out.results.push({ providerId: id, endpointId, state: 'OK', count: r.observations?.length ?? 0, requestId: r.meta?.requestId ?? null, usage: used }); if (ttlMs) sharedPut(key, { ts: clock(), observations: r.observations ?? [], result: r }); return r; }
      counters.acquisitionFailures += 1; out.coverage.push(...(r.coverage ?? []));
      const refused = r.failure?.kind === 'QUOTA_REFUSED' || r.failure?.kind === 'CONCURRENCY_REFUSED' || r.failure?.kind === 'ADMISSION_UNBOUND'; if (refused) for (const x of r.failure.refusalReasons ?? ['QUOTA_REFUSED']) refusals[x] = (refusals[x] ?? 0) + 1;
      out.results.push({ providerId: id, endpointId, state: refused ? 'QUOTA_REFUSED' : r.failure?.coverageState ?? 'FAILED', failure: r.failure ? { kind: r.failure.kind, reasonCode: r.failure.reasonCode, reasons: r.failure.refusalReasons ?? null } : null, usage: used }); return null;
    };
    const wantedNetwork = (metricIds ?? Object.keys(NETWORK_NATIVE_IDS)).flatMap((id) => NETWORK_NATIVE_IDS[id] ?? []);
    const histFrom = windowStartTs ?? clock() - 30 * DAY_MS; const histTo = windowEndTs ?? clock();
    switch (family) {
      case 'SPOT_PRICE_CHART': if (m.kraken) for (const iv of [1, 5, 15, 60, 240, 1440]) await run('KRAKEN_SPOT', 'rest-ohlc', `ohlc:${coin}:${iv}`, () => clients.KRAKEN_SPOT.ohlc({ market: m.kraken, intervalMin: iv, sinceTs: clock() - BAR_DEPTH[iv] * iv * 60_000, signal })); if (m.coinbase) await run('COINBASE_SPOT', 'rest-candles', `cbc:${coin}`, () => clients.COINBASE_SPOT.candles({ market: m.coinbase, granularitySec: 3600, startTs: clock() - BAR_DEPTH[60] * 3_600_000, signal })); break;
      case 'SPOT_FLOW': if (m.kraken) await run('KRAKEN_SPOT', 'rest-trades', `ktr:${coin}`, () => clients.KRAKEN_SPOT.trades({ market: m.kraken, maxPages: 1, signal })); if (m.coinbase) await run('COINBASE_SPOT', 'rest-trades', `ctr:${coin}`, () => clients.COINBASE_SPOT.trades({ market: m.coinbase, limit: 200, signal })); break;
      case 'DISPLAYED_LIQUIDITY': case 'CROSS_VENUE': if (m.kraken) await run('KRAKEN_SPOT', 'rest-ticker', `ktk:${coin}`, () => clients.KRAKEN_SPOT.ticker({ markets: [m.kraken], signal })); if (m.coinbase) await run('COINBASE_SPOT', 'rest-book', `cbk:${coin}`, () => clients.COINBASE_SPOT.book({ market: m.coinbase, signal })); break;
      case 'DERIVATIVES_FUNDING_OI': if (s?.krakenDerivatives) { await run('KRAKEN_DERIVATIVES', 'rest-tickers', `kft:${coin}`, () => clients.KRAKEN_DERIVATIVES.tickers({ symbols: [s.krakenDerivatives], signal })); await run('KRAKEN_DERIVATIVES', 'rest-funding-history', `kfh:${coin}`, () => clients.KRAKEN_DERIVATIVES.fundingHistory({ symbol: s.krakenDerivatives, maxRates: 48, signal }), { ttlMs: HOUR_MS }); } if (s?.deribit) { await run('DERIBIT', 'get-instruments', `dfi:${s.deribit}`, () => clients.DERIBIT.loadInstruments({ currency: s.deribit, kind: 'future', signal }), { ttlMs: HOUR_MS }); await run('DERIBIT', 'ticker', `dpt:${s.deribit}`, () => clients.DERIBIT.ticker({ instrumentName: `${s.deribit}-PERPETUAL`, signal })); } if (s?.bybit) await run('BYBIT', 'rest-tickers', `byt:${coin}`, () => clients.BYBIT.tickers({ symbols: [s.bybit], signal })); if (s?.coinglass) { await run('COINGLASS', 'oi-exchange-list', `cgoi:${coin}`, () => clients.COINGLASS.openInterest({ symbol: s.coinglass, canonicalCoin: coin, signal })); await run('COINGLASS', 'funding-exchange-list', 'cgfr', () => clients.COINGLASS.funding({ symbol: s.coinglass, canonicalCoin: coin, signal }), { ttlMs: 300_000 }); } break;
      case 'LIQUIDATIONS': if (s?.coinglass) await run('COINGLASS', 'liquidation-aggregated-history', `cgl:${coin}`, () => clients.COINGLASS.liquidations({ symbol: s.coinglass, canonicalCoin: coin, signal })); break;
      case 'OPTIONS_TERM_SKEW': if (s?.deribit) {
        await run('DERIBIT', 'get-instruments', `doi:${s.deribit}`, () => clients.DERIBIT.loadInstruments({ currency: s.deribit, kind: 'option', signal }), { ttlMs: 300_000 });
        const sum = await run('DERIBIT', 'get-book-summary-by-currency', `dbs:${s.deribit}`, () => clients.DERIBIT.bookSummaries({ currency: s.deribit, kind: 'option', signal }));
        // R03: bounded ticker enrichment of the deterministically admitted subset (Greeks / bid-ask IV), each call under the guard
        if (sum?.ok) { const ticks = (sum.observations ?? []).filter((o) => o.kind === 'OPTION_TICK'); const adm = admitOptions(ticks, { cap: limits.optionsAdmittedPerCase, nowTs: clock() }); for (const t of optionEnrichmentTargets(adm.admitted, limits.optionsTickerEnrichmentPerSweep)) { if (signal?.aborted || lifecycleForGuard() !== 'ACTIVE') break; const r = await run('DERIBIT', 'ticker', `dtk:${t.subject.instrumentId}`, () => clients.DERIBIT.ticker({ instrumentName: t.subject.instrumentId, signal })); if (r === null && out.results[out.results.length - 1]?.state === 'QUOTA_REFUSED') break; } }
      } break;
      case 'SUPPLY_UNLOCKS': if (s?.coingecko && m.coingecko) await run('COINGECKO', 'coins-markets', `cgm:${coin}`, () => clients.COINGECKO.markets({ assets: [m.coingecko], signal })); if (s?.coinglass) await run('COINGLASS', 'coin-vesting', `cgv:${coin}`, () => clients.COINGLASS.vesting({ symbol: s.coinglass, canonicalCoin: coin, signal }), { ttlMs: DAY_MS }); if (s?.tokenomist) await run('TOKENOMIST', 'upcoming-unlock-events', 'tku', () => clients.TOKENOMIST.upcoming({ subjects: subjects.subjects.filter((x) => x.tokenomist).map((x) => ({ slug: x.tokenomist, canonicalCoin: x.canonicalCoin })), signal }), { ttlMs: DAY_MS }); break;
      case 'DEX_DEFI': for (const p of s?.pools ?? []) await run('GECKOTERMINAL', 'pool', `gtp:${p.network}:${p.poolAddress}`, () => clients.GECKOTERMINAL.pool({ network: p.network, address: p.poolAddress, canonicalCoin: coin, signal })); for (const slug of s?.protocols ?? []) { await run('DEFILLAMA', 'tvl', `dlt:${slug}`, () => clients.DEFILLAMA.protocol({ slug, canonicalCoin: coin, signal }), { ttlMs: HOUR_MS }); await run('DEFILLAMA', 'fees-summary', `dlf:${slug}`, () => clients.DEFILLAMA.summary({ slug, kind: 'fees', canonicalCoin: coin, signal }), { ttlMs: HOUR_MS }); } break;
      case 'ONCHAIN_ENTITY_FLOW': { const ids = (metricIds ?? ['exchange_net_flow', 'exchange_reserve']).flatMap((x) => (x === 'exchange_net_flow' ? ['exchange_inflow', 'exchange_outflow'] : x === 'exchange_reserve' ? ['exchange_reserve'] : x === 'holder_cohorts' ? ['holder_age_cohort'] : [])); if (s?.cryptoquant && enabled('CRYPTOQUANT')) { for (const mid of ids.filter((x) => CRYPTOQUANT_METRICS[x])) await run('CRYPTOQUANT', CRYPTOQUANT_METRICS[mid].endpointId, `cq:${coin}:${mid}:${windowStartTs ?? ''}`, () => clients.CRYPTOQUANT.series({ asset: s.cryptoquant, canonicalCoin: coin, metricId: mid, limit: 30, fromTs: windowStartTs, toTs: windowEndTs, signal }), { ttlMs: HOUR_MS }); } else if (s?.santiment && enabled('SANTIMENT')) { for (const mid of ids.filter((x) => SANTIMENT_METRICS[x])) await run('SANTIMENT', 'graphql-get-metric', `san:${coin}:${mid}:${windowStartTs ?? ''}`, () => clients.SANTIMENT.series({ slug: s.santiment, canonicalCoin: coin, metricId: mid, fromTs: histFrom, toTs: histTo, signal }), { ttlMs: HOUR_MS }); } break; }
      case 'NETWORK_ACTIVITY': {
        // lawful free route first (Coin Metrics community, catalog-gated); the policy-selected entitled paid source fills what is missing;
        // never both paid alternatives by default; requested metrics / window are forwarded, never a family-only refresh
        let covered = new Set();
        if (s?.coinmetrics && enabled('COINMETRICS')) { await run('COINMETRICS', 'catalog-asset-metrics', `cmc:${s.coinmetrics}`, () => clients.COINMETRICS.loadCatalog({ asset: s.coinmetrics, signal }), { ttlMs: DAY_MS }); const cmIds = wantedNetwork.filter((id) => COINMETRICS_METRICS[id]); const r = cmIds.length ? await run('COINMETRICS', 'timeseries-asset-metrics', `cms:${coin}:${cmIds.join(',')}:${windowStartTs ?? ''}`, () => clients.COINMETRICS.series({ asset: s.coinmetrics, canonicalCoin: coin, metricIds: cmIds, startTs: windowStartTs, endTs: windowEndTs, pageSize: 30, maxPages: 1, signal }), { ttlMs: HOUR_MS }) : null; if (r?.ok) covered = new Set(cmIds.filter((id) => !(r.meta?.unsupported ?? []).includes(id) && clients.COINMETRICS.supports(s.coinmetrics, id))); }
        const missing = wantedNetwork.filter((id) => !covered.has(id));
        if (missing.length && s?.cryptoquant && enabled('CRYPTOQUANT')) { for (const mid of missing.filter((x) => CRYPTOQUANT_METRICS[x] && CRYPTOQUANT_METRICS[x].endpointId !== 'exchange-flows')) { const r = await run('CRYPTOQUANT', CRYPTOQUANT_METRICS[mid].endpointId, `cqn:${coin}:${mid}:${windowStartTs ?? ''}`, () => clients.CRYPTOQUANT.series({ asset: s.cryptoquant, canonicalCoin: coin, metricId: mid, limit: 30, fromTs: windowStartTs, toTs: windowEndTs, signal }), { ttlMs: HOUR_MS }); if (r === null && out.results[out.results.length - 1]?.state === 'QUOTA_REFUSED') break; } }
        else if (missing.length && s?.santiment && enabled('SANTIMENT')) { for (const mid of missing.filter((x) => SANTIMENT_METRICS[x] && SANTIMENT_METRICS[x].family === 'NETWORK_ACTIVITY')) { const whale = WHALE_NATIVE.has(mid); const r = await run('SANTIMENT', 'graphql-get-metric', `sann:${coin}:${mid}:${whale ? '5m' : '1d'}:${windowStartTs ?? ''}`, () => clients.SANTIMENT.series({ slug: s.santiment, canonicalCoin: coin, metricId: mid, fromTs: whale ? (windowStartTs ?? clock() - WHALE_5M_LOOKBACK_MS) : histFrom, toTs: histTo, interval: whale ? '5m' : '1d', signal }), { ttlMs: whale ? 300_000 : HOUR_MS }); if (r === null && out.results[out.results.length - 1]?.state === 'QUOTA_REFUSED') break; } }
        break; }
      case 'STABLECOIN_LIQUIDITY': await run('DEFILLAMA', 'stablecoins', 'dls', () => clients.DEFILLAMA.stablecoins({ wanted: subjects.stablecoins, signal }), { ttlMs: HOUR_MS }); break;
      case 'ETF_FLOWS': if (coin === 'BTC' || coin === 'ETH') await run('COINGLASS', coin === 'ETH' ? 'etf-ethereum-flow-history' : 'etf-bitcoin-flow-history', `etf:${coin}`, () => clients.COINGLASS.etfFlows({ asset: coin, canonicalCoin: coin, signal }), { ttlMs: HOUR_MS }); break;
      case 'MACRO_RELEASES': for (const sid of subjects.macroSeries) { await run('FRED', 'series', `fs:${sid}`, () => clients.FRED.seriesMeta({ seriesId: sid, signal }), { ttlMs: DAY_MS }); await run('FRED', 'series-observations', `fo:${sid}`, () => clients.FRED.observations({ seriesId: sid, limit: 30, signal }), { ttlMs: HOUR_MS }); } await run('COINGLASS', 'economic-data', 'cge', () => clients.COINGLASS.economicCalendar({ startTs: clock() - DAY_MS, endTs: clock() + 7 * DAY_MS, signal }), { ttlMs: 600_000 }); break;
      case 'CROSS_ASSET': for (const x of subjects.crossAsset) { await run('TWELVEDATA', 'symbol-search', `tds:${x.symbol}`, () => clients.TWELVEDATA.resolve({ symbol: x.symbol, exchange: x.exchange, proxyFor: x.proxyFor, signal }), { ttlMs: DAY_MS }); await run('TWELVEDATA', 'time-series', `tdb:${x.symbol}`, () => clients.TWELVEDATA.bars({ symbol: x.symbol, interval: '1h', outputsize: 100, signal }), { ttlMs: 300_000 }); } break;
      case 'OFFICIAL_SOCIAL_EVENTS': case 'INFRASTRUCTURE_STATUS': if (enabled('SETTLED_RECORDS')) { const r = clients.SETTLED_RECORDS.project({ canonicalCoin: coin, asOfTs: clock(), receivedTs: clock() }); out.observations.push(...r.observations); out.coverage.push(...r.coverage); out.results.push({ providerId: 'SETTLED_RECORDS', endpointId: family === 'INFRASTRUCTURE_STATUS' ? 'gateway-status' : 'official-claims', state: 'OK', count: r.observations.length }); } if (family === 'OFFICIAL_SOCIAL_EVENTS' && s?.coinglass) await run('COINGLASS', 'article-list', 'cgn', () => clients.COINGLASS.headlines({ signal }), { ttlMs: 600_000 }); break;
      default: fail('INVALID_REQUEST', 'unknown family');
    }
    for (const o of out.observations) { if (o.kind === 'TRADE') { hot.addTrade(subjectId(o.subject), o.subject, o); } else if (o.kind === 'CANDLE') hot.addBar(subjectId(o.subject), o.subject, o); }
    record(out.observations.filter((o) => !retained.has(o))); recordCoverage(out.coverage);
    const after = usageSnapshot(); out.usage = { dispatched: after.dispatched - before.dispatched, credits: after.credits - before.credits, refused: after.refused - before.refused + preRefused, unresolved: after.unresolved - before.unresolved, reasons: refusals };
    return deepFreeze(out);
  }
  // ---- lifecycle -----------------------------------------------------------------------------------------------------
  async function start({ outDir = null, families = null, rotation = null } = {}) {
    if (started) fail('INVALID_REQUEST', 'owner already started'); if (lifecycle !== 'CREATED') fail('INVALID_REQUEST', `owner cannot start from ${lifecycle}`);
    started = true; stopped = false; lifecycle = 'ACTIVE';
    if (outDir) { const q = rootQuota(); if (q && q.exhausted) { lifecycle = 'RECORDING_FAILED'; stopped = true; recording.error = { code: 'RESOURCE_LIMIT_EXCEEDED', message: 'research root quota exhausted before start' }; recording.failedTs = clock(); recording.where = 'START'; fail('RESOURCE_LIMIT_EXCEEDED', 'research root quota exhausted'); } segmentBase = path.resolve(outDir); openSegment(outDir); }
    resolution = await guard.withPurpose('CATALOG', () => resolveSubjects({ subjects, clients, enabled: (id) => enabled(id) && mayCall(id, ENDPOINTS.find((e) => e.providerId === id && e.method !== 'WS')?.endpointId ?? ''), log }));
    for (const r of resolution.results) { const k = r.providers.KRAKEN_SPOT; const c = r.providers.COINBASE_SPOT; const g = r.providers.COINGECKO; markets.set(r.canonicalCoin, { kraken: k?.state === 'RESOLVED' ? k.market : null, coinbase: c?.state === 'RESOLVED' ? c.market : null, coingecko: g?.state === 'RESOLVED' ? g.asset : null }); if (k?.state === 'RESOLVED') { const o = clients.KRAKEN_SPOT.instrumentObservation(k.market, clock()); if (o) record([o]); } if (c?.state === 'RESOLVED') { const o = clients.COINBASE_SPOT.instrumentObservation(c.market, clock()); if (o) record([o]); } }
    if (mode === 'STANDALONE') {
      const km = [...markets.values()].map((m) => m.kraken).filter(Boolean); const cm = [...markets.values()].map((m) => m.coinbase).filter(Boolean);
      if (km.length && guard.mayStream('KRAKEN_SPOT', 'ws-v2').ok) { streams.KRAKEN_SPOT = clients.KRAKEN_SPOT.createStream({ markets: km, depth: Math.min(100, limits.bookLevelsPerSide), WebSocketImpl, url: wsUrls.KRAKEN_SPOT ?? null, onTrade: (o) => ingestTrade(o), onBook: (ev) => ingestBook(clients.KRAKEN_SPOT, ev.market, ev), onCoverage: (c) => recordCoverage([c]) }); streams.KRAKEN_SPOT.start(); }
      if (cm.length && guard.mayStream('COINBASE_SPOT', 'ws-feed').ok) { streams.COINBASE_SPOT = clients.COINBASE_SPOT.createStream({ markets: cm, WebSocketImpl, url: wsUrls.COINBASE_SPOT ?? null, onTrade: (o) => ingestTrade(o), onBook: (ev) => ingestBook(clients.COINBASE_SPOT, ev.market, ev), onCoverage: (c) => recordCoverage([c]) }); streams.COINBASE_SPOT.start(); }
      const bybitSymbols = subjects.subjects.map((s) => s.bybit).filter(Boolean).filter((sym) => clients.BYBIT.resolveInstrument(sym).ok);
      if (bybitSymbols.length && guard.mayStream('BYBIT', 'ws-public-linear').ok) { streams.BYBIT = clients.BYBIT.createStream({ symbols: bybitSymbols, WebSocketImpl, url: wsUrls.BYBIT ?? null, onObservation: (o) => record([o]), onCoverage: (c) => recordCoverage([c]) }); streams.BYBIT.start(); }
      // round-robin: bounded rotation through eligible catalog subjects outside the explicit list (opt-in)
      if (rotation && rotation.enabled && streams.KRAKEN_SPOT && clients.KRAKEN_SPOT.catalog()) { const explicit = new Set(subjects.subjects.map((s) => s.canonicalCoin)); const pool = clients.KRAKEN_SPOT.catalog().markets.map((m) => m.base).filter((b) => !explicit.has(b)); let idx = 0; const active = []; const slots = Math.max(1, Math.min(rotation.slots ?? 4, limits.hotSubjects - subjects.subjects.length)); const rotateSubjects = () => { if (stopped) return; while (active.length >= slots) { const old = active.shift(); streams.KRAKEN_SPOT.remove(old.wsname); hot.release(subjectId(old.subject), clock(), 'ROTATION'); } for (let n = 0; n < slots && pool.length; n += 1) { const base = pool[idx % pool.length]; idx += 1; const r = clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: base }); if (r.ok && !active.some((a) => a.wsname === r.market.wsname)) { streams.KRAKEN_SPOT.add(r.market); active.push(r.market); counters.rotations += 1; if (active.length >= slots) break; } } }; rotateSubjects(); const t = timers.setInterval(rotateSubjects, rotation.dwellMs ?? 600_000); t.unref?.(); schedules.push(t); }
    }
    const fams = families ?? DEFAULT_SWEEP_FAMILIES;
    const sweep = async () => { for (const coin of subjects.subjects.map((s) => s.canonicalCoin)) { if (stopped) return; for (const fam of fams) { if (stopped) return; try { await acquire(fam, coin); } catch (err) { counters.acquisitionFailures += 1; log(`acquire ${fam}/${coin} failed: ${String(err?.message ?? err).slice(0, 120)}`); } } } };
    const drain = timers.setInterval(() => { try { drainQueue(); } catch (err) { counters.observerErrors += 1; } }, 250); drain.unref?.(); schedules.push(drain);
    await sweep();
    if (!stopped) { const sweepTimer = timers.setInterval(() => { sweep().catch(() => {}); }, 300_000); sweepTimer.unref?.(); schedules.push(sweepTimer); }
    return { resolution, segmentDir: segment?.dir ?? null };
  }
  let stopPromise = null; let stopResult = null;
  // the bounded drain: resolves DRAINED when every in-flight acquisition and wire request completed, TIMEOUT at the deadline
  async function drainInFlight() {
    if (!inFlightAcquisitions.size && !http.inFlight()) return 'DRAINED';
    let timer = null; const deadline = new Promise((resolve) => { timer = timers.setTimeout(() => resolve('TIMEOUT'), closeDrainMs); timer.unref?.(); });
    const all = Promise.all([Promise.allSettled([...inFlightAcquisitions]), http.drained()]).then(() => 'DRAINED');
    const outcome = await Promise.race([all, deadline]); timers.clearTimeout(timer); return outcome;
  }
  async function stopInternal({ seal, policyNonsecret, reason }) {
    if (lifecycle !== 'RECORDING_FAILED') lifecycle = 'STOPPING'; stopped = true;
    for (const t of schedules) timers.clearInterval(t); schedules.length = 0;
    const streamStops = {};
    for (const [id, s] of Object.entries(streams)) { try { await s.stop(); streamStops[id] = s.status().state; } catch (err) { streamStops[id] = `FAILED:${String(err?.message ?? err).slice(0, 60)}`; } }
    try { drainQueue(); } catch { /* best effort */ }
    // closeout P3: abort every owned request, drain within the bounded deadline (injected timers), then fence: open reservations are
    // preserved as UNRESOLVED while the journal is still owned, every late continuation is detached, nothing more can be admitted
    owned.abort(Object.assign(new Error('owner stopping'), { kind: 'OWNER_STOPPED' })); http.stop();
    drainStats.outcome = await drainInFlight(); generation += 1; fenced = true;
    drainStats.detachedAcquisitions = inFlightAcquisitions.size; drainStats.detachedRequests = http.inFlight();
    try { drainStats.fencedRequests = http.fence('DETACHED_AT_STOP'); } catch (err) { log(`fence failed: ${String(err?.message ?? err).slice(0, 120)}`); }
    let sealedNow = null;
    // an EMPTY segment opened after a rotation (e.g. a case snapshot) is released, never sealed as a vacuous bundle; a run that observed
    // nothing at all still seals its one (empty) segment so the absence is recorded honestly
    const emptyAfterRotation = segment && sealed.length > 0 && segment.stats.observations + segment.stats.coverage === 0;
    if (segment && !recording.error) { if (seal && !emptyAfterRotation) { policyNonsecretForSeal = policyNonsecret ?? policy; try { sealedNow = sealSegment(); } catch (err) { recording.error = toJsonError(err); recording.failedTs = clock(); recording.where = 'SEAL'; } } else { try { segment.obs.release(); segment.cov.release(); } catch { /* ignore */ } segment.reservation.cleanup(); segment = null; } }
    if (ownsJournal) journal.close();
    if (lifecycle !== 'RECORDING_FAILED') lifecycle = 'STOPPED';
    stopResult = { sealed: sealedNow, segments: sealed.slice(), error: recording.error ? { ...recording.error, where: recording.where, failedTs: recording.failedTs } : null, streams: streamStops, reason: reason ?? null, drain: { ...drainStats, deadlineMs: closeDrainMs, accounting: guard.accountingFailure() } };
    return stopResult;
  }
  // idempotent: the first stop drives the shutdown; every later stop returns the same result (the first error preserved)
  function stop({ seal = true, policyNonsecret = null } = {}) { if (!stopPromise) { policyNonsecretForSeal = policyNonsecret ?? policy; stopPromise = stopInternal({ seal, policyNonsecret, reason: 'STOP' }); } return stopPromise.then(() => (recording.error && stopResult && !stopResult.error ? { ...stopResult, sealed: null, error: { ...recording.error, where: recording.where, failedTs: recording.failedTs } } : stopResult)); }
  const status = () => deepFreeze({ ownerVersion: OWNER_VERSION, mode, lifecycle, started, stopped, fenced, drain: { ...drainStats, deadlineMs: closeDrainMs, inFlightAcquisitions: inFlightAcquisitions.size, inFlightRequests: http.inFlight() }, counters: { ...counters }, recording: { error: recording.error, failedTs: recording.failedTs, where: recording.where, segmentDir: recording.segmentDir }, retained: retained.counters(), membership: retained.membership(), limits: { retainedObservations: limits.retainedObservations, retainedCoverage: limits.retainedCoverage, sealedSegmentIndex: limits.sealedSegmentIndex, segmentBytes: limits.segmentBytes, runBytes: limits.runBytes, sharedCacheEntries: limits.sharedCacheEntries }, hot: hot.status(), queue: queue.status(), streams: Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, s.status()])), clients: Object.fromEntries(PROVIDER_IDS.map((id) => [id, clients[id].status()])), transport: http.accounting(), accounting: guard.snapshot(), sealed: sealed.slice(), sealedCount, runBytes, segment: segment ? { dir: segment.dir, ordinal: segment.ordinal, ...segment.obs.stats(), coverageLines: segment.cov.stats().lines } : null, observations: retained.counters().retainedObservations, coverageRecords: retained.counters().retainedCoverage, sharedCache: shared.size, resolution: resolution ? { population: resolution.population, catalogs: resolution.catalogs } : null, readiness: providerReadiness({ policy, env, clientStatus: Object.fromEntries(PROVIDER_IDS.map((id) => [id, clients[id].status()])) }), quota: rootQuota() });
  return { observer, start, stop, acquire, status, clients, hot, guard, journal, snapshotPrefix, probe: (fn) => guard.withPurpose('PROBE', fn), markets: () => markets, subjectsOf: (coin) => markets.get(coin) ?? null, observations: () => retained.observations(), coverage: () => retained.coverage(), resolution: () => resolution, socialProjection, view: (coin) => { const m = markets.get(coin)?.kraken; return m ? hot.view(subjectId(m.subject)) : null; }, lifecycle: () => lifecycle, isTs };
}
