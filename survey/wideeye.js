// E-1 — THE WIDE EYE. Notice-only surveying of the FULL Kraken USD universe.
// One public REST Ticker request sweeps every pair at once; no websockets,
// no L2, no volume floor. It can never trade and never widen the biteable
// set on its own: notice wide, verify deep, bite narrow. A RIPPLE or a
// NOMINATION may only feed candidate attention; strike evaluation reads
// nothing from here. See doctrine/WIDEEYE.md.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { nowIso, sessionDate, etHourKey } from '../lib/time.js';
import { readCurrentUniverse } from '../tape/universe.js';

const TICKER_URL = 'https://api.kraken.com/0/public/Ticker';
const ASSET_PAIRS_URL = 'https://api.kraken.com/0/public/AssetPairs';
const BASE_ALIASES = { XBT: 'BTC', XDG: 'DOGE' };

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

// ---------- pure math core (exported for tests) ----------

// Welford-style pooled aggregates per ET-hour bucket: {n, sum, sumSq}.
export function bucketAdd(bucket, x) {
  bucket.n += 1;
  bucket.sum += x;
  bucket.sumSq += x * x;
  return bucket;
}

export function pooledStats(buckets) {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (const b of Object.values(buckets)) {
    n += b.n;
    sum += b.sum;
    sumSq += b.sumSq;
  }
  if (n < 2) return { n, mean: null, std: null };
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { n, mean, std: Math.sqrt(variance) };
}

export function zScore(x, stats, minSamples) {
  if (x === null || stats.n < minSamples || !stats.std || stats.std <= 0) return null;
  return (x - stats.mean) / stats.std;
}

// RIPPLE vs MISSED vs null. Independent cheap measures must co-fire, and the
// move must still be FORMING: an already-extended symbol is a missed boat,
// not an invitation.
export function classifyRipple({ zVol, zRet5, ret15Pct }, cfg) {
  if (zVol === null || zRet5 === null || ret15Pct === null) return null;
  const cofire = zVol >= cfg.zVolThreshold && Math.abs(zRet5) >= cfg.zRetThreshold;
  if (!cofire) return null;
  return Math.abs(ret15Pct) <= cfg.extensionCapPct ? 'RIPPLE' : 'MISSED';
}

// (Deep-tape cap/shed lives in tape/universe.js mergeNominationsAndCap —
// the tape verifies; the wide eye only proposes.)

export function readNominations() {
  if (!existsSync(nominationsFile())) return [];
  return JSON.parse(readFileSync(nominationsFile(), 'utf8')).nominations ?? [];
}

// ---------- runtime ----------

export function startWideEye({ log = console.log } = {}) {
  const config = loadConfig();
  if (!wideeyeEnabled(config)) {
    log(`[${nowIso()}] WIDE EYE closed — surveying off, zero network`);
    return null;
  }
  const cfg = config.wideeye;
  const excluded = new Set((config.universeExpansion?.excludeBases ?? []).map((b) => b.toUpperCase()));

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

  function logEvent(type, detail = {}) {
    appendJsonl(eventsFile(), { ts: nowIso(), type, ...detail });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const body = await res.json();
    if (body.error?.length) throw new Error(body.error.join('; '));
    return body.result;
  }

  async function loadWideUniverse() {
    const assetPairs = await fetchJson(ASSET_PAIRS_URL);
    keyToCoin.clear();
    for (const [key, pair] of Object.entries(assetPairs)) {
      if (pair.status !== 'online') continue;
      if (pair.quote !== 'ZUSD' && pair.quote !== 'USD') continue;
      if (!pair.wsname || !pair.wsname.endsWith('/USD')) continue;
      const raw = pair.wsname.split('/')[0];
      const coin = BASE_ALIASES[raw] ?? raw;
      if (excluded.has(coin.toUpperCase())) continue;
      if (![...keyToCoin.values()].includes(coin)) keyToCoin.set(key, coin);
    }
    log(`[${nowIso()}] WIDE EYE open — surveying ${keyToCoin.size} USD pairs (1 request/sweep, every ${cfg.sweepSec}s)`);
    logEvent('WIDEEYE_UNIVERSE', { scanned: keyToCoin.size });
  }

  function pruneBuckets(metricBuckets, now) {
    const cutoffDate = sessionDate(new Date(now - 7 * 86_400_000));
    for (const key of Object.keys(metricBuckets)) {
      if (key.slice(0, 10) < cutoffDate) delete metricBuckets[key];
    }
  }

  function sweep(tickers) {
    const now = Date.now();
    const hourKey = etHourKey(new Date(now));
    const today = sessionDate(new Date(now));
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
      s.push({ t: now, price, cumVol });
      while (s.length > 16) s.shift();
      series.set(coin, s);
      if (s.length < 2) continue;

      const at = (minAgo) => s.findLast((p) => p.t <= now - minAgo * 60_000 + 5000);
      const p1 = at(1);
      const p5 = at(5);
      const p15 = at(15);
      const prev = s[s.length - 2];
      const ret1 = p1 ? Math.log(price / p1.price) : null;
      const ret5 = p5 ? Math.log(price / p5.price) : null;
      const ret15Pct = p15 ? (price / p15.price - 1) * 100 : null;
      // 24h-cumulative delta per sweep — a flow PROXY (roll-off included);
      // z-scored against its own baseline the proxy stays self-consistent.
      const volRate = Number.isFinite(cumVol) && Number.isFinite(prev.cumVol) ? Math.max(0, cumVol - prev.cumVol) : null;

      const b = (baselines[coin] ??= { ret1: {}, ret5: {}, volRate: {} });
      if (ret1 !== null) bucketAdd((b.ret1[hourKey] ??= { n: 0, sum: 0, sumSq: 0 }), ret1);
      if (ret5 !== null) bucketAdd((b.ret5[hourKey] ??= { n: 0, sum: 0, sumSq: 0 }), ret5);
      if (volRate !== null) bucketAdd((b.volRate[hourKey] ??= { n: 0, sum: 0, sumSq: 0 }), volRate);

      const zVol = zScore(volRate, pooledStats(b.volRate), cfg.minSamples);
      const zRet5 = zScore(ret5, pooledStats(b.ret5), cfg.minSamples);
      const verdict = classifyRipple({ zVol, zRet5, ret15Pct }, cfg);
      if (!verdict) continue;
      if (now - (lastRipple.get(coin) ?? 0) < cfg.rippleCooldownMin * 60_000) continue;
      lastRipple.set(coin, now);

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

    if (now - lastPersist > (cfg.persistSec ?? 600) * 1000) {
      lastPersist = now;
      for (const b of Object.values(baselines)) {
        pruneBuckets(b.ret1, now);
        pruneBuckets(b.ret5, now);
        pruneBuckets(b.volRate, now);
      }
      atomicWriteJson(baselinesFile(), baselines); // compact; ~minutes cadence by design
    }
    atomicWriteJson(statusFile(), {
      ts: nowIso(),
      tsMs: now,
      enabled: true,
      scanned: keyToCoin.size,
      ripplesToday,
      date: rippleDate,
    });
    return ripples;
  }

  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping || stopping || Date.now() < backoffUntil) return;
    sweeping = true;
    try {
      if (!keyToCoin.size) await loadWideUniverse();
      const tickers = await fetchJson(TICKER_URL); // ONE request covers the whole universe
      sweep(tickers);
      backoffMs = 60_000;
    } catch (err) {
      backoffUntil = Date.now() + backoffMs;
      logEvent('SWEEP_ERROR', { error: err.message, backoffSec: backoffMs / 1000 });
      log(`[${nowIso()}] WIDE EYE sweep failed (${err.message}) — backoff ${backoffMs / 1000}s`);
      backoffMs = Math.min(backoffMs * 2, 600_000);
    } finally {
      sweeping = false;
    }
  }, (cfg.sweepSec ?? 60) * 1000);
  const first = setTimeout(() => timer.refresh?.() ?? null, 0); // first sweep on schedule; no burst at boot

  logEvent('WIDEEYE_STARTED', { sweepSec: cfg.sweepSec });
  const stop = () => {
    stopping = true;
    clearInterval(timer);
    clearTimeout(first);
    try {
      atomicWriteJson(baselinesFile(), baselines);
    } catch {
      // disk refused the final flush; sweeps already logged what mattered
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { stop };
}
