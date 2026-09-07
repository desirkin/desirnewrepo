// E-1 — THE WIDE EYE. Notice-only surveying of the FULL Kraken USD universe.
// One public REST Ticker request sweeps every pair at once; no websockets,
// no L2, no volume floor. It can never trade and never widen the biteable
// set on its own: notice wide, verify deep, bite narrow. A RIPPLE or a
// NOMINATION may only feed candidate attention; strike evaluation reads
// nothing from here. See doctrine/WIDEEYE.md.
//
// SOCIAL-4F — the wide eye's EXISTING AssetPairs acquisition is also the ONE
// upstream source of the DISCOVERY_CATALOG (survey/catalog.js): the accepted
// broad metadata is exposed as a DETACHED, read-only, deep-frozen snapshot
// (`catalogSnapshot()`), plus a bounded accessor for already-observed research
// notices (`researchNotices()`). The metadata is refreshed boundedly on the
// existing sweep tick (no second poller, no per-coin request): at most one
// AssetPairs request per `socialResearch.catalog.refreshSec` (>= 300 s), one
// refresh in flight, stop cancels ownership of late results, a refused or failed
// refresh keeps the previously accepted truth and states why. Sweep cadence and
// backoff are unchanged.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso, sessionDate, etHourKey } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';
import { krakenUsdSpotBase, normalizeKrakenAssetPairs, acceptCatalogCandidate, CATALOG_MAX_MARKETS_DEFAULT } from './catalog.js';

const TICKER_URL = 'https://api.kraken.com/0/public/Ticker';
const ASSET_PAIRS_URL = 'https://api.kraken.com/0/public/AssetPairs';
export const CATALOG_REFRESH_MIN_SEC = 300; // new observation-resource controls (SOCIAL-4F) — not trading thresholds
export const CATALOG_MAX_AGE_MAX_SEC = 900;
export const CATALOG_NOTICE_RING = 500;

const surveyDir = () => path.join(dataDir(), 'survey');
const baselinesFile = () => path.join(surveyDir(), 'baselines.json');
const statusFile = () => path.join(surveyDir(), 'status.json');
const eventsFile = () => path.join(surveyDir(), 'events.jsonl');
const nominationsFile = () => path.join(surveyDir(), 'nominations-current.json');
const nominationsLog = () => path.join(surveyDir(), 'nominations.jsonl');

export function wideeyeEnabled(config = loadConfig()) {
  if (process.env.WIDEEYE_ENABLED !== undefined) return process.env.WIDEEYE_ENABLED === 'true';
  return config.wideeye?.enabled === true;
}

// Effective catalog resource settings: explicit, named, bounded (never a trading threshold).
export function catalogResourceSettings(config = loadConfig()) {
  const c = config?.socialResearch?.catalog ?? {};
  const int = (v, d) => (Number.isSafeInteger(v) && v > 0 ? v : d);
  const refreshSec = Math.max(CATALOG_REFRESH_MIN_SEC, int(c.refreshSec, CATALOG_REFRESH_MIN_SEC));
  const maxAgeSec = Math.min(CATALOG_MAX_AGE_MAX_SEC, Math.max(refreshSec, int(c.maxAgeSec, CATALOG_MAX_AGE_MAX_SEC)));
  const maxMarkets = Math.min(CATALOG_MAX_MARKETS_DEFAULT, int(c.maxMarkets, CATALOG_MAX_MARKETS_DEFAULT));
  return Object.freeze({ refreshSec, maxAgeSec, maxMarkets });
}

// ---------- pure math core ----------
// Extracted VERBATIM to survey/eyecore.js (B-0B) so live and historical
// replay share one implementation and cannot drift. Re-exported here so
// every existing import path keeps working. Live behavior unchanged.
import { bucketAdd, pooledStats, zScore, classifyRipple, evaluateTick, pruneBaselineBuckets, logReturn, extensionPct, volumeRate } from './eyecore.js';
export { bucketAdd, pooledStats, zScore, classifyRipple, evaluateTick, pruneBaselineBuckets, logReturn, extensionPct, volumeRate };

// (Deep-tape cap/shed lives in tape/universe.js mergeNominationsAndCap —
// the tape verifies; the wide eye only proposes.)

export function readNominations() {
  if (!existsSync(nominationsFile())) return [];
  return JSON.parse(readFileSync(nominationsFile(), 'utf8')).nominations ?? [];
}

// ---------- runtime ----------

export function startWideEye({
  log = console.log,
  config = loadConfig(),
  // SOCIAL-4F seam: injected transport/clock/timers for exact boundary tests — defaults are the globals
  fetchImpl = null,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  registerSignals = true,
} = {}) {
  if (!wideeyeEnabled(config)) {
    log(`[${nowIso()}] WIDE EYE closed — surveying off, zero network`);
    return null;
  }
  const cfg = config.wideeye;
  const excluded = new Set((config.universeExpansion?.excludeBases ?? []).map((b) => b.toUpperCase()));
  const resource = catalogResourceSettings(config);

  const keyToCoin = new Map(); // Ticker result key -> normalized coin
  const series = new Map(); // coin -> [{t, price, cumVol}] (last ~16 sweeps)
  // baselines: {coin: {ret1:{hourKey:{n,sum,sumSq}}, ret5:{...}, volRate:{...}}}
  let baselines = existsSync(baselinesFile()) ? JSON.parse(readFileSync(baselinesFile(), 'utf8')) : {};
  const lastRipple = new Map();
  let ripplesToday = 0;
  let rippleDate = sessionDate();
  let backoffUntil = 0;
  let backoffMs = 60_000;
  let lastPersist = 0;
  let stopping = false;
  // SOCIAL-4F catalog state: previously ACCEPTED truth is retained across refusals/failures
  const catalog = { accepted: null, lastAttemptTs: null, lastSuccessTs: null, lastError: null, lastRefusal: null, refreshes: 0, refusals: 0, failures: 0, lastChange: null };
  let refreshToken = 0;
  const notices = []; // bounded ring of already-computed RIPPLE/MISSED records (research context only)

  function logEvent(type, detail = {}) {
    appendJsonl(eventsFile(), { ts: nowIso(), type, ...detail });
  }

  async function fetchJson(url) {
    const f = fetchImpl ?? fetch;
    const res = await f(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const body = await res.json();
    if (body.error?.length) throw new Error(body.error.join('; '));
    return body.result;
  }

  // The sweep map: exactly the historical selection (online, USD quote, /USD wsname, alias,
  // stable/fiat exclusion, first key per coin) through the ONE shared per-row primitive.
  function rebuildKeyToCoin(assetPairs) {
    keyToCoin.clear();
    for (const [key, pair] of Object.entries(assetPairs)) {
      const r = krakenUsdSpotBase(pair, excluded);
      if (!r.base) continue;
      if (![...keyToCoin.values()].includes(r.base)) keyToCoin.set(key, r.base);
    }
  }

  // ONE AssetPairs acquisition: rebuild the sweep map (initial load, or an accepted refresh) and
  // adopt/refuse the discovery catalog. `initial` keeps the historical throw-into-backoff path.
  async function loadWideUniverse({ initial = false } = {}) {
    const token = ++refreshToken;
    catalog.lastAttemptTs = now();
    let assetPairs;
    try {
      assetPairs = await fetchJson(ASSET_PAIRS_URL);
    } catch (err) {
      catalog.failures += 1; catalog.lastError = `REFRESH_FAILED: ${String(err.message).slice(0, 160)}`;
      logEvent('CATALOG_REFRESH_ERROR', { error: catalog.lastError, retainedContentId: catalog.accepted?.contentId ?? null });
      if (initial) throw err; // the historical first-load path: the sweep backs off exactly as before
      return { ok: false };
    }
    if (stopping || token !== refreshToken) return { ok: false, late: true }; // stop / a newer attempt owns the outcome
    const observedTs = now(); // the ACTUAL acquisition clock — never backdated, never a provider creation date
    if (initial || !keyToCoin.size) rebuildKeyToCoin(assetPairs);
    const n = normalizeKrakenAssetPairs(assetPairs, { excludeBases: [...excluded], observedTs, maxMarkets: resource.maxMarkets });
    if (!n.ok) {
      catalog.refusals += 1; catalog.lastError = `${n.reason}: ${n.detail}`; catalog.lastRefusal = { reason: n.reason, ts: observedTs };
      logEvent('CATALOG_REFUSED', { reason: n.reason, detail: String(n.detail).slice(0, 200), retainedContentId: catalog.accepted?.contentId ?? null });
    } else {
      const a = acceptCatalogCandidate(catalog.accepted, n.catalog);
      if (!a.ok) {
        catalog.refusals += 1; catalog.lastError = `${a.reason}: ${a.detail ?? ''}`; catalog.lastRefusal = { reason: a.reason, ts: observedTs };
        logEvent('CATALOG_REFUSED', { reason: a.reason, detail: String(a.detail ?? '').slice(0, 200), retainedContentId: catalog.accepted?.contentId ?? null });
      } else {
        catalog.accepted = n.catalog; catalog.lastSuccessTs = observedTs; catalog.lastError = null; catalog.refreshes += 1; catalog.lastChange = a.change;
        if (!initial) rebuildKeyToCoin(assetPairs); // an ACCEPTED refresh lets a new listing enter the sweep without a restart
        logEvent('CATALOG_ACCEPTED', { contentId: n.catalog.contentId, change: a.change, observedTs, counts: n.catalog.counts });
      }
    }
    if (initial || catalog.lastChange === 'INITIAL') {
      log(`[${nowIso()}] WIDE EYE open — surveying ${keyToCoin.size} USD pairs (1 request/sweep, every ${cfg.sweepSec}s)`);
      logEvent('WIDEEYE_UNIVERSE', { scanned: keyToCoin.size });
    }
    return { ok: true };
  }
  const catalogDue = (t) => catalog.lastAttemptTs === null || t - catalog.lastAttemptTs >= resource.refreshSec * 1000;

  // 7-day retention now lives in the shared core (same semantics, one home).
  const pruneBuckets = (metricBuckets, nowMs) => pruneBaselineBuckets(metricBuckets, nowMs, sessionDate);

  function sweep(tickers) {
    const nowMs = now();
    const hourKey = etHourKey(new Date(nowMs));
    const today = sessionDate(new Date(nowMs));
    if (today !== rippleDate) {
      rippleDate = today;
      ripplesToday = 0;
      atomicWriteJson(nominationsFile(), { date: today, nominations: [] }); // fresh proposals each session
    }
    const deep = new Set((readCurrentUniverse()?.pairs ?? []).map((p) => p.coin));
    let ripples = 0;

    for (const [key, coin] of keyToCoin) {
      const t = tickers[key];
      if (!t) continue;
      const price = Number(t.c?.[0]);
      const cumVol = Number(t.v?.[1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const s = series.get(coin) ?? [];
      s.push({ t: nowMs, price, cumVol });
      while (s.length > 16) s.shift();
      series.set(coin, s);
      if (s.length < 2) continue;

      const at = (minAgo) => s.findLast((p) => p.t <= nowMs - minAgo * 60_000 + 5000);
      const p1 = at(1);
      const p5 = at(5);
      const p15 = at(15);
      const prev = s[s.length - 2];
      // shared eyecore derivers (B-0B.1): the FORMULAS live in one place;
      // only sample selection (trailing wall-clock sweeps) is live's own.
      const ret1 = p1 ? logReturn(price, p1.price) : null;
      const ret5 = p5 ? logReturn(price, p5.price) : null;
      const ret15Pct = p15 ? extensionPct(price, p15.price) : null;
      // 24h-cumulative delta per sweep — a flow PROXY (roll-off included);
      // z-scored against its own baseline the proxy stays self-consistent.
      const volRate = volumeRate(cumVol, prev.cumVol);

      const b = (baselines[coin] ??= { ret1: {}, ret5: {}, volRate: {} });
      // shared core, live ordering: sample joins baseline, then z, then verdict
      const { zVol, zRet5, verdict } = evaluateTick({ ret1, ret5, ret15Pct, volRate }, b, cfg, hourKey);
      if (!verdict) continue;
      if (nowMs - (lastRipple.get(coin) ?? 0) < cfg.rippleCooldownMin * 60_000) continue;
      lastRipple.set(coin, nowMs);

      const usd24h = Number(t.v?.[1]) * Number(t.p?.[1]);
      const liquidityNote = Number.isFinite(usd24h)
        ? `$${(usd24h / 1e6).toFixed(2)}M 24h${usd24h >= cfg.nominationFloorUsd ? '' : ' (below nomination floor)'}`
        : 'volume unknown';
      const record = {
        ts: nowIso(),
        symbol: coin,
        verdict,
        zVol: Number(zVol.toFixed(2)),
        zRet: Number(zRet5.toFixed(2)),
        extension: Number(ret15Pct.toFixed(2)),
        liquidityNote,
        inDeepTape: deep.has(coin),
      };
      logEvent(verdict, record);
      // SOCIAL-4F: the same already-computed notice, retained in a bounded ring for the research
      // planner (context only — both dispositions; never a veto, never a trading score)
      notices.push(Object.freeze({ ...record, tsMs: nowMs, usdVol24h: Number.isFinite(usd24h) ? Math.round(usd24h) : null }));
      if (notices.length > CATALOG_NOTICE_RING) notices.shift();
      log(`[${nowIso()}] WIDE EYE ${verdict} ${coin} zVol=${record.zVol} zRet=${record.zRet} ext=${record.extension}%`);
      if (verdict === 'RIPPLE') {
        ripples++;
        ripplesToday++;
        if (!deep.has(coin) && Number.isFinite(usd24h) && usd24h >= cfg.nominationFloorUsd) {
          const cur = existsSync(nominationsFile()) ? JSON.parse(readFileSync(nominationsFile(), 'utf8')) : { date: today, nominations: [] };
          if (cur.date !== today) Object.assign(cur, { date: today, nominations: [] });
          if (!cur.nominations.some((n) => n.coin === coin)) {
            cur.nominations.push({ coin, ts: nowIso(), usdVol24h: Math.round(usd24h), cause: `RIPPLE zVol=${record.zVol}` });
            atomicWriteJson(nominationsFile(), cur, { pretty: true });
            appendJsonl(nominationsLog(), { ts: nowIso(), coin, usdVol24h: Math.round(usd24h), forSession: 'next' });
            log(`[${nowIso()}] WIDE EYE NOMINATION ${coin} -> proposed for next session's deep tape`);
          }
        }
      }
    }

    if (nowMs - lastPersist > (cfg.persistSec ?? 600) * 1000) {
      lastPersist = nowMs;
      for (const b of Object.values(baselines)) {
        pruneBuckets(b.ret1, nowMs);
        pruneBuckets(b.ret5, nowMs);
        pruneBuckets(b.volRate, nowMs);
      }
      atomicWriteJson(baselinesFile(), baselines); // compact; ~minutes cadence by design
    }
    atomicWriteJson(statusFile(), {
      ts: nowIso(),
      tsMs: nowMs,
      enabled: true,
      scanned: keyToCoin.size,
      ripplesToday,
      date: rippleDate,
      // SOCIAL-4F: catalog truth beside the sweep — discovery count, never the deep/legacy sets
      catalog: catalogStatus(nowMs),
    });
    return ripples;
  }

  function catalogStatus(nowMs) {
    const c = catalog.accepted;
    return {
      status: c ? 'ACCEPTED' : 'UNAVAILABLE', contentId: c?.contentId ?? null, observedTs: c?.observedTs ?? null,
      ageSec: c ? Math.max(0, Math.floor((nowMs - c.observedTs) / 1000)) : null, fresh: c ? nowMs - c.observedTs <= resource.maxAgeSec * 1000 : false,
      counts: c ? { ...c.counts } : null, lastAttemptTs: catalog.lastAttemptTs, lastSuccessTs: catalog.lastSuccessTs, lastError: catalog.lastError, lastRefusal: catalog.lastRefusal,
      refreshes: catalog.refreshes, refusals: catalog.refusals, failures: catalog.failures, resource: { ...resource },
    };
  }

  let sweeping = false;
  const timer = setIntervalImpl(async () => {
    if (sweeping || stopping || now() < backoffUntil) return;
    sweeping = true;
    try {
      if (!keyToCoin.size) await loadWideUniverse({ initial: true });
      else if (catalogDue(now())) await loadWideUniverse(); // bounded refresh on the existing tick; failures are recorded, never a sweep backoff
      const tickers = await fetchJson(TICKER_URL); // ONE request covers the whole universe
      sweep(tickers);
      backoffMs = 60_000;
    } catch (err) {
      backoffUntil = now() + backoffMs;
      logEvent('SWEEP_ERROR', { error: err.message, backoffSec: backoffMs / 1000 });
      log(`[${nowIso()}] WIDE EYE sweep failed (${err.message}) — backoff ${backoffMs / 1000}s`);
      backoffMs = Math.min(backoffMs * 2, 600_000);
    } finally {
      sweeping = false;
    }
  }, (cfg.sweepSec ?? 60) * 1000);
  const first = setTimeoutImpl(() => timer.refresh?.() ?? null, 0); // first sweep on schedule; no burst at boot

  logEvent('WIDEEYE_STARTED', { sweepSec: cfg.sweepSec, catalogRefreshSec: resource.refreshSec, catalogMaxAgeSec: resource.maxAgeSec, catalogMaxMarkets: resource.maxMarkets });
  const stop = () => {
    stopping = true;
    refreshToken += 1; // any in-flight AssetPairs result is disowned
    clearIntervalImpl(timer);
    clearTimeoutImpl(first);
    try {
      atomicWriteJson(baselinesFile(), baselines);
    } catch {
      // disk refused the final flush; sweeps already logged what mattered
    }
  };
  if (registerSignals) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
  return {
    stop,
    // SOCIAL-4F: the DETACHED read-only catalog snapshot — accepted truth (frozen) + how it got there
    catalogSnapshot: () => deepFreeze({ ...catalogStatus(now()), catalog: catalog.accepted, source: 'kraken REST AssetPairs (wide-eye acquisition)' }),
    // bounded, already-observed research notices (RIPPLE and MISSED alike) — context, never authority
    researchNotices: () => deepFreeze(notices.slice()),
    // test/diagnostic: drive one refresh attempt directly (still bounded by the same law)
    _refreshCatalog: () => loadWideUniverse({ initial: !keyToCoin.size }),
    _sweepOnce: async () => { if (!keyToCoin.size) await loadWideUniverse({ initial: true }); else if (catalogDue(now())) await loadWideUniverse(); sweep(await fetchJson(TICKER_URL)); },
  };
}
