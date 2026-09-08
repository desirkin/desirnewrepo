// MARKET LAB — THE MARKET RESEARCH OWNER (§5): one owner per provider / subject / channel that owns acquisition,
// normalized observations, bounded hot state and immutable local segments. In fly.js it attaches to already ACCEPTED
// Tape trades / books through an optional observer (copies bounded values + the capture clock; never a shared mutable
// OrderBook; queue saturation = measured drop). Standalone commands use the research-only Kraken / Coinbase streams and
// the REST clients — never the trading application. Additional research collection never broadens execution permission.
// Real-time activation is explicit (policy + env); the shipped default is STOPPED.
import path from 'node:path';
import { deepFreeze, subjectId, fail, MarketLabError, PROVIDER_IDS, isTs, canonicalDigest } from './contracts.js';
import { RESOURCE_DEFAULTS, credentialPresence, providerEnabled, endpointPermitted, paidCallAuthorized } from './policy.js';
import { createHttpTransport } from './transport.js';
import { createHotState, createIntakeQueue } from './hot-state.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile, publishManifest, directoryBytes, quotaState } from './store.js';
import { codeIdentity } from './identity.js';
import { resolveSubjects } from './subject-catalog.js';
import { providerReadiness } from './readiness.js';
import { createKrakenSpotClient } from './providers/kraken-spot.js';
import { createCoinbaseClient } from './providers/coinbase.js';
import { createKrakenDerivativesClient } from './providers/kraken-derivatives.js';
import { createDeribitClient } from './providers/deribit.js';
import { createBybitClient } from './providers/bybit.js';
import { createCoinGeckoClient, createGeckoTerminalClient } from './providers/coingecko.js';
import { createDefiLlamaClient } from './providers/defillama.js';
import { createCoinGlassClient } from './providers/coinglass.js';
import { createCryptoQuantClient } from './providers/cryptoquant.js';
import { createSantimentClient } from './providers/santiment.js';
import { createCoinMetricsClient } from './providers/coinmetrics.js';
import { createFredClient } from './providers/fred.js';
import { createTwelveDataClient } from './providers/twelvedata.js';
import { createSettledProjection } from './providers/settled.js';
import { createTokenomistClient } from './providers/tokenomist.js';
import { ENDPOINTS } from './registry.js';
import { DAY_MS, HOUR_MS } from './time.js';

export const OWNER_VERSION = 'market-research-owner-1';
export const OWNER_MODES = Object.freeze(['STANDALONE', 'INTEGRATED']);
const FACTORIES = { KRAKEN_SPOT: createKrakenSpotClient, COINBASE_SPOT: createCoinbaseClient, KRAKEN_DERIVATIVES: createKrakenDerivativesClient, DERIBIT: createDeribitClient, BYBIT: createBybitClient, COINGECKO: createCoinGeckoClient, GECKOTERMINAL: createGeckoTerminalClient, DEFILLAMA: createDefiLlamaClient, COINGLASS: createCoinGlassClient, CRYPTOQUANT: createCryptoQuantClient, SANTIMENT: createSantimentClient, COINMETRICS: createCoinMetricsClient, FRED: createFredClient, TWELVEDATA: createTwelveDataClient, TOKENOMIST: createTokenomistClient };

// bars of history requested per interval (minutes -> bars): enough for every §7 indicator window (SMA/Bollinger 20, RSI 14,
// prior-day/week ranges) without pulling a provider's whole 720-bar tail on every sweep
export const BAR_DEPTH = Object.freeze({ 1: 180, 5: 288, 15: 192, 60: 168, 240: 180, 1440: 120 });
export function createResearchOwner({ policy, subjects, env = {}, researchRoot = null, mode = 'STANDALONE', clock = () => Date.now(), log = () => {}, transport = null, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wsUrls = {}, settledAccessors = {}, socialProjection = null, timers = { setInterval, clearInterval, setTimeout, clearTimeout }, recorder = null } = {}) {
  if (!OWNER_MODES.includes(mode)) fail('INVALID_REQUEST', 'unknown owner mode');
  const limits = policy.resources; const presence = credentialPresence(policy, env);
  const http = transport ?? createHttpTransport({ fetchImpl, clock, limits, recorder, log });
  // clients: constructed for every provider so readiness can describe them; only ENABLED providers ever start or request
  const clients = {};
  for (const id of PROVIDER_IDS) { if (id === 'SETTLED_RECORDS') { clients[id] = createSettledProjection({ clock, log, accessors: settledAccessors }); continue; } const env_ = policy.providers[id]?.credentialEnv ?? ENDPOINTS.find((e) => e.providerId === id && e.authEnv)?.authEnv ?? null; const credential = env_ && typeof env[env_] === 'string' && env[env_].length ? env[env_] : null; clients[id] = FACTORIES[id]({ transport: http, clock, log, credential, limits }); }
  const enabled = (id) => providerEnabled(policy, id);
  const mayCall = (id, endpointId) => enabled(id) && endpointPermitted(policy, id, endpointId) && (policy.providers[id].plan.billing === 'FREE' || paidCallAuthorized(policy, id));
  const hot = createHotState({ limits, log }); const queue = createIntakeQueue({ limits });
  const observations = []; const coverage = []; let segment = null; const sealed = []; let stopped = true; let started = false;
  const counters = { observations: 0, coverageRecords: 0, duplicateRecords: 0, tapeTrades: 0, tapeBooks: 0, tapeDropped: 0, observerErrors: 0, acquisitions: 0, acquisitionFailures: 0, rotations: 0 };
  const markets = new Map(); // canonicalCoin -> { kraken, coinbase }
  let resolution = null; const streams = {}; const schedules = []; const shared = new Map(); // shared cross-subject cache: key -> { ts, observations }
  const bySubjectCoin = (coin) => subjects.subjects.find((s) => s.canonicalCoin === coin) ?? null;
  // content dedup (A02): a REST re-poll returns the same source records again (720 committed bars per OHLC call, an
  // instrument census, a funding history). A record whose provider / endpoint / subject / kind / sourceKey / revision
  // AND payload are identical to one already recorded is NOT a new observation: it is counted and dropped. A changed
  // payload under the same sourceKey (a provider revision) is recorded. Keyless records (book samples) are never deduped.
  const seenKeys = new Set(); const seenOrder = []; const SEEN_CAP = limits.dedupKeys ?? 262_144;
  const duplicate = (o) => { if (o.sourceKey === null || o.sourceKey === undefined) return false; const key = `${o.provider}|${o.endpointId}|${subjectId(o.subject)}|${o.kind}|${o.sourceKey}|${o.sourceRevision ?? ''}|${canonicalDigest(o.payload)}`; if (seenKeys.has(key)) return true; seenKeys.add(key); seenOrder.push(key); if (seenOrder.length > SEEN_CAP) seenKeys.delete(seenOrder.shift()); return false; };
  const record = (obs) => { for (const o of obs) { if (duplicate(o)) { counters.duplicateRecords += 1; continue; } observations.push(o); counters.observations += 1; if (segment) { try { segment.obs.append(o); } catch (err) { segmentFailure(err); return; } } } };
  const recordCoverage = (cov) => { for (const c of cov) { coverage.push(c); counters.coverageRecords += 1; } };
  function ingestTrade(o) { const r = hot.addTrade(subjectId(o.subject), o.subject, o); if (r.admitted) record([o]); }
  function ingestBook(client, market, ev, sampleReason = 'INTERVAL') { const sid = subjectId(market.subject); if (!hot.shouldSampleBook(sid, ev.receivedTs)) return; const levels = ev.levels(); const o = client.bookSnapshotObservation({ market, levels, receivedTs: ev.receivedTs, epochId: ev.epochId ?? null, synced: ev.synced, checksumOk: ev.checksumOk ?? null, sampleReason, pricePrecision: ev.pricePrecision ?? null, qtyPrecision: ev.qtyPrecision ?? null }); if (!o) return; const r = hot.addBookSample(sid, market.subject, { receivedTs: o.receivedTs, bids: o.payload.bids, asks: o.payload.asks, synced: o.payload.synchronized, checksumOk: o.payload.checksumVerified, epochId: o.epochId, observationId: o.observationId }); if (r.admitted) record([o]); }
  // ---- segments ----------------------------------------------------------------------------------------------------
  let segmentError = null;
  function segmentFailure(err) { segmentError = err instanceof MarketLabError ? err.toJSON() : { code: 'IO_FAILURE', message: String(err?.message ?? err).slice(0, 160) }; log(`segment write failed: ${segmentError.message} — capture stopped, no seal`); try { segment?.obs.release(); segment?.cov.release(); } catch { /* best effort */ } segment = null; }
  function openSegment(outDir) { const real = prepareOutputTarget(outDir); const reservation = reserveOutputDir(real); segment = { reservation, dir: real, obs: jsonlWriter(reservation, 'observations.jsonl', { lineBytes: limits.observationLineBytes, fileBytes: limits.segmentBytes }), cov: null, openedTs: clock(), firstReceivedTs: null }; return real; }
  function sealSegment({ policyNonsecret }) {
    if (!segment) fail('INTERNAL_FAILURE', 'no open segment');
    const s = segment; segment = null;
    try {
      const obsD = s.obs.close();
      const covW = jsonlWriter(s.reservation, 'coverage.jsonl', { lineBytes: limits.coverageLineBytes, fileBytes: limits.segmentBytes }); for (const c of coverage) covW.append(c); const covD = covW.close();
      const catD = writeJsonFile(s.reservation, 'catalog.json', { catalogVersion: 'market-capture-catalog-1', resolution, population: resolution?.population ?? [], hot: hot.status() }, { maxBytes: limits.contextBytes });
      const polD = writeJsonFile(s.reservation, 'policy.json', policyNonsecret, { maxBytes: limits.manifestBytes });
      const identity = codeIdentity(); const idD = writeJsonFile(s.reservation, 'code-identity.json', identity, { maxBytes: limits.manifestBytes });
      const receipts = observations.map((o) => o.receivedTs); const providers = [...new Set(observations.map((o) => o.provider))].sort(); const kinds = {}; for (const o of observations) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
      const pub = publishManifest(s.reservation, { kind: 'CAPTURE', createdTs: clock(), summary: { ownerVersion: OWNER_VERSION, mode, observations: observations.length, coverageRecords: coverage.length, providers, kinds, subjects: [...new Set(observations.map((o) => o.subject.canonicalCoin).filter(Boolean))].sort(), firstReceivedTs: receipts.length ? Math.min(...receipts) : null, lastReceivedTs: receipts.length ? Math.max(...receipts) : null, hot: { subjects: hot.status().subjects, totalBytes: hot.status().totalBytes, evictions: hot.status().evictions }, queueDropped: counters.tapeDropped, openedTs: s.openedTs }, limits, identity: { sourceTreeSha256: identity.sourceTreeSha256, law: identity.law, gitCommit: identity.gitCommit }, members: [obsD, covD, catD, polD, idD] });
      sealed.push({ dir: s.dir, bundleId: pub.manifest.bundleId, manifestSha256: pub.manifestSha256, observations: observations.length });
      return { dir: s.dir, ...pub };
    } catch (err) { try { s.obs.release(); } catch { /* ignore */ } s.reservation.cleanup(); throw err; }
  }
  // ---- Tape observer (INTEGRATED): copies accepted values; a failing observer never reaches the tape ---------------------
  const observer = {
    onTrade(ev) { try { if (stopped || !clients.KRAKEN_SPOT || ev.snapshot) return; const m = markets.get(ev.coin)?.kraken; if (!m) return; if (!queue.push({ t: 'trade', ev, m })) { counters.tapeDropped += 1; } } catch { counters.observerErrors += 1; } },
    onBook(ev) { try { if (stopped) return; const m = markets.get(ev.coin)?.kraken; if (!m) return; const sid = subjectId(m.subject); if (!hot.shouldSampleBook(sid, ev.receivedTs)) return; const levels = ev.levels(); if (!queue.push({ t: 'book', ev: { receivedTs: ev.receivedTs, synced: ev.synced, checksumOk: ev.checksumVerified ?? null, pricePrecision: ev.pricePrecision ?? null, qtyPrecision: ev.qtyPrecision ?? null, levels: () => levels }, m })) counters.tapeDropped += 1; } catch { counters.observerErrors += 1; } },
    onInstrument() {},
  };
  function drainQueue() { const dropped = queue.takeDropped(); if (dropped) { recordCoverage([clients.KRAKEN_SPOT.coverage({ endpointId: 'ws-v2', subject: markets.values().next().value?.kraken?.subject ?? { subjectKind: 'PROVIDER', canonicalCoin: null, providerAssetId: null, providerId: 'KRAKEN_SPOT' }, family: 'SPOT_FLOW', state: 'DROPPED', reasonCodes: ['QUEUE_DROPPED'], startTs: clock(), endTs: clock(), droppedCount: dropped })]); } for (const item of queue.drain(2048)) { if (item.t === 'trade') { const o = clients.KRAKEN_SPOT.tapeTradeObservation({ market: item.m, ...item.ev }); if (o) { counters.tapeTrades += 1; ingestTrade(o); } } else { counters.tapeBooks += 1; ingestBook(clients.KRAKEN_SPOT, item.m, item.ev); } } }
  // ---- acquisition schedule (native cadence; shared daily data cached by identity) -------------------------------------------
  async function acquire(family, coin, { signal = null, force = false } = {}) {
    const s = bySubjectCoin(coin); const m = markets.get(coin) ?? {}; const out = { family, coin, observations: [], coverage: [], results: [] };
    const run = async (id, endpointId, key, fn, { ttlMs = null } = {}) => { if (!mayCall(id, endpointId)) { out.results.push({ providerId: id, endpointId, state: enabled(id) ? 'POLICY_REJECTED' : 'PROVIDER_DISABLED' }); return; } if (ttlMs && !force && shared.has(key) && clock() - shared.get(key).ts < ttlMs) { out.observations.push(...shared.get(key).observations); out.results.push({ providerId: id, endpointId, state: 'CACHED', cachedTs: shared.get(key).ts }); return; } counters.acquisitions += 1; let r; try { r = await fn(); } catch (err) { counters.acquisitionFailures += 1; out.results.push({ providerId: id, endpointId, state: 'FAILED', reason: String(err?.message ?? err).slice(0, 120) }); return; } if (r.ok) { out.observations.push(...(r.observations ?? [])); out.coverage.push(...(r.coverage ?? [])); out.results.push({ providerId: id, endpointId, state: 'OK', count: r.observations?.length ?? 0, requestId: r.meta?.requestId ?? null }); if (ttlMs) shared.set(key, { ts: clock(), observations: r.observations ?? [] }); } else { counters.acquisitionFailures += 1; out.coverage.push(...(r.coverage ?? [])); out.results.push({ providerId: id, endpointId, state: r.failure?.coverageState ?? 'FAILED', failure: r.failure ? { kind: r.failure.kind, reasonCode: r.failure.reasonCode } : null }); } };
    switch (family) {
      case 'SPOT_PRICE_CHART': if (m.kraken) for (const iv of [1, 5, 15, 60, 240, 1440]) await run('KRAKEN_SPOT', 'rest-ohlc', `ohlc:${coin}:${iv}`, () => clients.KRAKEN_SPOT.ohlc({ market: m.kraken, intervalMin: iv, sinceTs: clock() - BAR_DEPTH[iv] * iv * 60_000, signal })); if (m.coinbase) await run('COINBASE_SPOT', 'rest-candles', `cbc:${coin}`, () => clients.COINBASE_SPOT.candles({ market: m.coinbase, granularitySec: 3600, startTs: clock() - BAR_DEPTH[60] * 3_600_000, signal })); break;
      case 'SPOT_FLOW': if (m.kraken) await run('KRAKEN_SPOT', 'rest-trades', `ktr:${coin}`, () => clients.KRAKEN_SPOT.trades({ market: m.kraken, maxPages: 1, signal })); if (m.coinbase) await run('COINBASE_SPOT', 'rest-trades', `ctr:${coin}`, () => clients.COINBASE_SPOT.trades({ market: m.coinbase, limit: 200, signal })); break;
      case 'DISPLAYED_LIQUIDITY': case 'CROSS_VENUE': if (m.kraken) await run('KRAKEN_SPOT', 'rest-ticker', `ktk:${coin}`, () => clients.KRAKEN_SPOT.ticker({ markets: [m.kraken], signal })); if (m.coinbase) await run('COINBASE_SPOT', 'rest-book', `cbk:${coin}`, () => clients.COINBASE_SPOT.book({ market: m.coinbase, signal })); break;
      case 'DERIVATIVES_FUNDING_OI': if (s?.krakenDerivatives) { await run('KRAKEN_DERIVATIVES', 'rest-tickers', `kft:${coin}`, () => clients.KRAKEN_DERIVATIVES.tickers({ symbols: [s.krakenDerivatives], signal })); await run('KRAKEN_DERIVATIVES', 'rest-funding-history', `kfh:${coin}`, () => clients.KRAKEN_DERIVATIVES.fundingHistory({ symbol: s.krakenDerivatives, maxRates: 48, signal }), { ttlMs: HOUR_MS }); } if (s?.deribit) { await run('DERIBIT', 'get-instruments', `dfi:${s.deribit}`, () => clients.DERIBIT.loadInstruments({ currency: s.deribit, kind: 'future', signal }), { ttlMs: HOUR_MS }); await run('DERIBIT', 'ticker', `dpt:${s.deribit}`, () => clients.DERIBIT.ticker({ instrumentName: `${s.deribit}-PERPETUAL`, signal })); } if (s?.bybit) await run('BYBIT', 'rest-tickers', `byt:${coin}`, () => clients.BYBIT.tickers({ symbols: [s.bybit], signal })); if (s?.coinglass) { await run('COINGLASS', 'oi-exchange-list', `cgoi:${coin}`, () => clients.COINGLASS.openInterest({ symbol: s.coinglass, canonicalCoin: coin, signal })); await run('COINGLASS', 'funding-exchange-list', 'cgfr', () => clients.COINGLASS.funding({ symbol: s.coinglass, canonicalCoin: coin, signal }), { ttlMs: 300_000 }); } break;
      case 'LIQUIDATIONS': if (s?.coinglass) await run('COINGLASS', 'liquidation-aggregated-history', `cgl:${coin}`, () => clients.COINGLASS.liquidations({ symbol: s.coinglass, canonicalCoin: coin, signal })); break;
      case 'OPTIONS_TERM_SKEW': if (s?.deribit) { await run('DERIBIT', 'get-instruments', `doi:${s.deribit}`, () => clients.DERIBIT.loadInstruments({ currency: s.deribit, kind: 'option', signal }), { ttlMs: 300_000 }); await run('DERIBIT', 'get-book-summary-by-currency', `dbs:${s.deribit}`, () => clients.DERIBIT.bookSummaries({ currency: s.deribit, kind: 'option', signal })); } break;
      case 'SUPPLY_UNLOCKS': if (s?.coingecko && m.coingecko) await run('COINGECKO', 'coins-markets', `cgm:${coin}`, () => clients.COINGECKO.markets({ assets: [m.coingecko], signal })); if (s?.coinglass) await run('COINGLASS', 'coin-vesting', `cgv:${coin}`, () => clients.COINGLASS.vesting({ symbol: s.coinglass, canonicalCoin: coin, signal }), { ttlMs: DAY_MS }); if (s?.tokenomist) await run('TOKENOMIST', 'upcoming-unlock-events', 'tku', () => clients.TOKENOMIST.upcoming({ subjects: subjects.subjects.filter((x) => x.tokenomist).map((x) => ({ slug: x.tokenomist, canonicalCoin: x.canonicalCoin })), signal }), { ttlMs: DAY_MS }); break;
      case 'DEX_DEFI': for (const p of s?.pools ?? []) await run('GECKOTERMINAL', 'pool', `gtp:${p.network}:${p.poolAddress}`, () => clients.GECKOTERMINAL.pool({ network: p.network, address: p.poolAddress, canonicalCoin: coin, signal })); for (const slug of s?.protocols ?? []) { await run('DEFILLAMA', 'tvl', `dlt:${slug}`, () => clients.DEFILLAMA.protocol({ slug, canonicalCoin: coin, signal }), { ttlMs: HOUR_MS }); await run('DEFILLAMA', 'fees-summary', `dlf:${slug}`, () => clients.DEFILLAMA.summary({ slug, kind: 'fees', canonicalCoin: coin, signal }), { ttlMs: HOUR_MS }); } break;
      case 'ONCHAIN_ENTITY_FLOW': if (s?.cryptoquant) for (const mid of ['exchange_inflow', 'exchange_outflow', 'exchange_reserve']) await run('CRYPTOQUANT', 'exchange-flows', `cq:${coin}:${mid}`, () => clients.CRYPTOQUANT.series({ asset: s.cryptoquant, canonicalCoin: coin, metricId: mid, limit: 30, signal }), { ttlMs: HOUR_MS }); else if (s?.santiment) for (const mid of ['exchange_inflow', 'exchange_outflow', 'exchange_reserve']) await run('SANTIMENT', 'graphql-get-metric', `san:${coin}:${mid}`, () => clients.SANTIMENT.series({ slug: s.santiment, canonicalCoin: coin, metricId: mid, fromTs: clock() - 30 * DAY_MS, toTs: clock(), signal }), { ttlMs: HOUR_MS }); break;
      case 'NETWORK_ACTIVITY': if (s?.coinmetrics) { await run('COINMETRICS', 'catalog-asset-metrics', `cmc:${s.coinmetrics}`, () => clients.COINMETRICS.loadCatalog({ asset: s.coinmetrics, signal }), { ttlMs: DAY_MS }); await run('COINMETRICS', 'timeseries-asset-metrics', `cms:${coin}`, () => clients.COINMETRICS.series({ asset: s.coinmetrics, canonicalCoin: coin, metricIds: ['active_addresses', 'transaction_count', 'transfer_volume', 'fees_total', 'supply_circulating', 'realized_price', 'mvrv'], pageSize: 30, maxPages: 1, signal }), { ttlMs: HOUR_MS }); } break;
      case 'STABLECOIN_LIQUIDITY': await run('DEFILLAMA', 'stablecoins', 'dls', () => clients.DEFILLAMA.stablecoins({ wanted: subjects.stablecoins, signal }), { ttlMs: HOUR_MS }); break;
      case 'ETF_FLOWS': if (coin === 'BTC' || coin === 'ETH') await run('COINGLASS', coin === 'ETH' ? 'etf-ethereum-flow-history' : 'etf-bitcoin-flow-history', `etf:${coin}`, () => clients.COINGLASS.etfFlows({ asset: coin, canonicalCoin: coin, signal }), { ttlMs: HOUR_MS }); break;
      case 'MACRO_RELEASES': for (const sid of subjects.macroSeries) { await run('FRED', 'series', `fs:${sid}`, () => clients.FRED.seriesMeta({ seriesId: sid, signal }), { ttlMs: DAY_MS }); await run('FRED', 'series-observations', `fo:${sid}`, () => clients.FRED.observations({ seriesId: sid, limit: 30, signal }), { ttlMs: HOUR_MS }); } await run('COINGLASS', 'economic-data', 'cge', () => clients.COINGLASS.economicCalendar({ startTs: clock() - DAY_MS, endTs: clock() + 7 * DAY_MS, signal }), { ttlMs: 600_000 }); break;
      case 'CROSS_ASSET': for (const x of subjects.crossAsset) { await run('TWELVEDATA', 'symbol-search', `tds:${x.symbol}`, () => clients.TWELVEDATA.resolve({ symbol: x.symbol, exchange: x.exchange, proxyFor: x.proxyFor, signal }), { ttlMs: DAY_MS }); await run('TWELVEDATA', 'time-series', `tdb:${x.symbol}`, () => clients.TWELVEDATA.bars({ symbol: x.symbol, interval: '1h', outputsize: 100, signal }), { ttlMs: 300_000 }); } break;
      case 'OFFICIAL_SOCIAL_EVENTS': case 'INFRASTRUCTURE_STATUS': if (enabled('SETTLED_RECORDS')) { const r = clients.SETTLED_RECORDS.project({ canonicalCoin: coin, asOfTs: clock(), receivedTs: clock() }); out.observations.push(...r.observations); out.coverage.push(...r.coverage); out.results.push({ providerId: 'SETTLED_RECORDS', endpointId: family === 'INFRASTRUCTURE_STATUS' ? 'gateway-status' : 'official-claims', state: 'OK', count: r.observations.length }); } if (family === 'OFFICIAL_SOCIAL_EVENTS' && s?.coinglass) await run('COINGLASS', 'article-list', 'cgn', () => clients.COINGLASS.headlines({ signal }), { ttlMs: 600_000 }); break;
      default: fail('INVALID_REQUEST', 'unknown family');
    }
    for (const o of out.observations) { if (o.kind === 'TRADE') { hot.addTrade(subjectId(o.subject), o.subject, o); } else if (o.kind === 'CANDLE') hot.addBar(subjectId(o.subject), o.subject, o); }
    record(out.observations.filter((o) => !observations.includes(o))); recordCoverage(out.coverage);
    return deepFreeze(out);
  }
  // ---- lifecycle -----------------------------------------------------------------------------------------------------
  async function start({ outDir = null, families = null, rotation = null } = {}) {
    if (started) fail('INVALID_REQUEST', 'owner already started'); started = true; stopped = false;
    if (outDir) openSegment(outDir);
    resolution = await resolveSubjects({ subjects, clients, enabled: (id) => enabled(id) && mayCall(id, ENDPOINTS.find((e) => e.providerId === id)?.endpointId ?? ''), log });
    for (const r of resolution.results) { const k = r.providers.KRAKEN_SPOT; const c = r.providers.COINBASE_SPOT; const g = r.providers.COINGECKO; markets.set(r.canonicalCoin, { kraken: k?.state === 'RESOLVED' ? k.market : null, coinbase: c?.state === 'RESOLVED' ? c.market : null, coingecko: g?.state === 'RESOLVED' ? g.asset : null }); if (k?.state === 'RESOLVED') { const o = clients.KRAKEN_SPOT.instrumentObservation(k.market, clock()); if (o) record([o]); } if (c?.state === 'RESOLVED') { const o = clients.COINBASE_SPOT.instrumentObservation(c.market, clock()); if (o) record([o]); } }
    if (mode === 'STANDALONE') {
      const km = [...markets.values()].map((m) => m.kraken).filter(Boolean); const cm = [...markets.values()].map((m) => m.coinbase).filter(Boolean);
      if (km.length && mayCall('KRAKEN_SPOT', 'ws-v2')) { streams.KRAKEN_SPOT = clients.KRAKEN_SPOT.createStream({ markets: km, depth: Math.min(100, limits.bookLevelsPerSide), WebSocketImpl, url: wsUrls.KRAKEN_SPOT ?? null, onTrade: (o) => ingestTrade(o), onBook: (ev) => ingestBook(clients.KRAKEN_SPOT, ev.market, ev), onCoverage: (c) => recordCoverage([c]) }); streams.KRAKEN_SPOT.start(); }
      if (cm.length && mayCall('COINBASE_SPOT', 'ws-feed')) { streams.COINBASE_SPOT = clients.COINBASE_SPOT.createStream({ markets: cm, WebSocketImpl, url: wsUrls.COINBASE_SPOT ?? null, onTrade: (o) => ingestTrade(o), onBook: (ev) => ingestBook(clients.COINBASE_SPOT, ev.market, ev), onCoverage: (c) => recordCoverage([c]) }); streams.COINBASE_SPOT.start(); }
      const bybitSymbols = subjects.subjects.map((s) => s.bybit).filter(Boolean).filter((sym) => clients.BYBIT.resolveInstrument(sym).ok);
      if (bybitSymbols.length && mayCall('BYBIT', 'ws-public-linear')) { streams.BYBIT = clients.BYBIT.createStream({ symbols: bybitSymbols, WebSocketImpl, url: wsUrls.BYBIT ?? null, onObservation: (o) => record([o]), onCoverage: (c) => recordCoverage([c]) }); streams.BYBIT.start(); }
      // round-robin: bounded rotation through eligible catalog subjects outside the explicit list (opt-in)
      if (rotation && rotation.enabled && streams.KRAKEN_SPOT && clients.KRAKEN_SPOT.catalog()) { const explicit = new Set(subjects.subjects.map((s) => s.canonicalCoin)); const pool = clients.KRAKEN_SPOT.catalog().markets.map((m) => m.base).filter((b) => !explicit.has(b)); let idx = 0; const active = []; const slots = Math.max(1, Math.min(rotation.slots ?? 4, limits.hotSubjects - subjects.subjects.length)); const rotate = () => { if (stopped) return; while (active.length >= slots) { const old = active.shift(); streams.KRAKEN_SPOT.remove(old.wsname); hot.release(subjectId(old.subject), clock(), 'ROTATION'); } for (let n = 0; n < slots && pool.length; n += 1) { const base = pool[idx % pool.length]; idx += 1; const r = clients.KRAKEN_SPOT.resolveMarket({ canonicalCoin: base }); if (r.ok && !active.some((a) => a.wsname === r.market.wsname)) { streams.KRAKEN_SPOT.add(r.market); active.push(r.market); counters.rotations += 1; if (active.length >= slots) break; } } }; rotate(); const t = timers.setInterval(rotate, rotation.dwellMs ?? 600_000); t.unref?.(); schedules.push(t); }
    }
    const fams = families ?? ['SPOT_PRICE_CHART', 'DERIVATIVES_FUNDING_OI', 'OPTIONS_TERM_SKEW', 'SUPPLY_UNLOCKS', 'DEX_DEFI', 'ONCHAIN_ENTITY_FLOW', 'NETWORK_ACTIVITY', 'STABLECOIN_LIQUIDITY', 'ETF_FLOWS', 'MACRO_RELEASES', 'CROSS_ASSET', 'LIQUIDATIONS', 'OFFICIAL_SOCIAL_EVENTS', 'INFRASTRUCTURE_STATUS', 'CROSS_VENUE'];
    const sweep = async () => { for (const coin of subjects.subjects.map((s) => s.canonicalCoin)) { if (stopped) return; for (const fam of fams) { if (stopped) return; try { await acquire(fam, coin); } catch (err) { counters.acquisitionFailures += 1; log(`acquire ${fam}/${coin} failed: ${String(err?.message ?? err).slice(0, 120)}`); } } } };
    const drain = timers.setInterval(() => { try { drainQueue(); } catch (err) { counters.observerErrors += 1; } }, 250); drain.unref?.(); schedules.push(drain);
    await sweep();
    const sweepTimer = timers.setInterval(() => { sweep().catch(() => {}); }, 300_000); sweepTimer.unref?.(); schedules.push(sweepTimer);
    return { resolution, segmentDir: segment?.dir ?? null };
  }
  async function stop({ seal = true, policyNonsecret = null } = {}) {
    if (stopped && !segment) return { sealed: null };
    stopped = true; for (const t of schedules) timers.clearInterval(t); schedules.length = 0;
    for (const s of Object.values(streams)) { try { await s.stop(); } catch { /* best effort */ } }
    try { drainQueue(); } catch { /* best effort */ }
    http.stop();
    if (segment && seal) { if (segmentError) { segment.reservation.cleanup(); segment = null; return { sealed: null, error: segmentError }; } return { sealed: sealSegment({ policyNonsecret: policyNonsecret ?? policy }) }; }
    if (segment) { segment.obs.release(); segment.reservation.cleanup(); segment = null; }
    return { sealed: null };
  }
  const status = () => deepFreeze({ ownerVersion: OWNER_VERSION, mode, started, stopped, counters: { ...counters }, hot: hot.status(), queue: queue.status(), streams: Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, s.status()])), clients: Object.fromEntries(PROVIDER_IDS.map((id) => [id, clients[id].status()])), transport: http.accounting(), sealed: sealed.slice(), segment: segment ? { dir: segment.dir, ...segment.obs.stats(), error: segmentError } : null, observations: observations.length, coverageRecords: coverage.length, resolution: resolution ? { population: resolution.population, catalogs: resolution.catalogs } : null, readiness: providerReadiness({ policy, env, clientStatus: Object.fromEntries(PROVIDER_IDS.map((id) => [id, clients[id].status()])) }), quota: researchRoot ? (() => { try { return quotaState(directoryBytes(researchRoot), limits.researchRootQuotaBytes); } catch { return null; } })() : null });
  return { observer, start, stop, acquire, status, clients, hot, markets: () => markets, subjectsOf: (coin) => markets.get(coin) ?? null, observations: () => observations.slice(), coverage: () => coverage.slice(), resolution: () => resolution, socialProjection, view: (coin) => { const m = markets.get(coin)?.kraken; return m ? hot.view(subjectId(m.subject)) : null; }, isTs };
}
