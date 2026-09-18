// VOLATILITY WATCH (PUBLISH-FIX-66, 2026-09-18, owner directive): "I don't wanna trade BTC. I'm looking for other things,
// volatile ones. We should be looking at volume and volatility. We should never be looking at BTC almost ever."
//
// Before: the Judge's six preparation slots were filled from the tape universe in VOLUME order (BTC, ETH, SOL, XRP, DOGE…),
// the coins whose 20-minute ranges (0.2–0.8%) can never clear a 1.6% round-trip fee — the independent review of f32484ca
// named it "arithmetically inert". This module ranks every coin the broad-Kraken stream carries (learning/broad-kraken-
// series.js, closed 1-minute candles) by what actually MOVED in the last hour — the hour's high-low range as a share of
// its low — with a dollar-volume floor for that hour so the pick is tradeable, and keeps the top N as a bounded WATCH
// list: each pick joins the deep tape through the hot lane's own venue verification (tape/run.js) and the Judge's
// preparation slots through its own nomination law (judge/readiness.js: a newer nomination clock wins a slot, one hour
// TTL from its last affirmation). A pick keeps the clock it ENTERED with while it stays in the list (no churn), leaves when
// it falls out of the wider band, and is re-stamped only when it re-enters. No coin is named; BTC stays out only because it
// does not move. Watch only: every setup, gate, cost and risk rule is unchanged; authority NONE.
import path from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { atomicWriteJson } from '../lib/jsonl.js';

export const VOLATILITY_WATCH_VERSION = 'learning-volatility-watch-1';
export const VOLATILITY_WATCH_SOURCE = 'VOLATILITY_WATCH';
export const VOLATILITY_WATCH_DEFAULTS = Object.freeze({
  picks: 6,               // the Judge's preparation slots
  band: 12,               // a listed coin stays while it is still inside the top `band` (hysteresis against churn)
  windowMin: 60,          // the hour that is ranked
  longWindowMin: 240,     // the four-hour range, reported beside it
  minBars: 50,            // at least this many of the hour's minutes must be on disk
  minUsdVol1h: 100_000,   // the hour's traded dollars: a range nobody traded is not a move
  minRange1hPct: 0.8,     // below this the hour did not move enough to matter against fees; the list may be shorter than `picks`
  maxStaleMin: 5,         // the newest candle must be this fresh, else the coin's stream is stale and it is not ranked
});
const MIN = 60_000;
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
export const volatilityDir = (dataDir) => path.join(path.resolve(dataDir), 'learning', 'volatility');
export const volatilityFile = (dataDir) => path.join(volatilityDir(dataDir), 'current.json');

// the measures of the last `windowMin` closed minutes of one coin's candles ([openSec, o, h, l, c, v] ascending)
export function rangeMeasures(candles, { nowTs, windowMin, minBars, maxStaleMin }) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const last = candles[candles.length - 1]; const lastEndMs = (last[0] + 60) * 1000;
  if (nowTs - lastEndMs > maxStaleMin * MIN) return { stale: true };
  const fromSec = last[0] - (windowMin - 1) * 60; let hi = -Infinity; let lo = Infinity; let usd = 0; let bars = 0; let first = null;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i]; if (c[0] < fromSec) break;
    if (!(c[2] > 0 && c[3] > 0 && c[4] > 0)) continue;
    if (c[2] > hi) hi = c[2]; if (c[3] < lo) lo = c[3]; usd += (c[5] ?? 0) * c[4]; bars += 1; first = c;
  }
  if (bars < minBars || !(lo > 0) || !first) return { bars, tooFew: true };
  return { bars, rangePct: (hi / lo - 1) * 100, retPct: (last[4] / first[1] - 1) * 100, usdVol: usd, lastClose: last[4], lastOpenSec: last[0] };
}

// pure: rank the coins of a series source; returns the ranked eligible list (best first)
export function rankByVolatility({ seriesSource, nowTs, cfg = VOLATILITY_WATCH_DEFAULTS, exclude = new Set() }) {
  const out = []; let stale = 0; let thin = 0; let quiet = 0;
  for (const coin of seriesSource.coins()) {
    if (exclude.has(coin)) continue;
    const series = seriesSource(coin); const candles = series?.candles; if (!Array.isArray(candles) || !candles.length) continue;
    const h = rangeMeasures(candles, { nowTs, windowMin: cfg.windowMin, minBars: cfg.minBars, maxStaleMin: cfg.maxStaleMin });
    if (!h || h.stale) { stale += 1; continue; }
    if (h.tooFew || h.usdVol < cfg.minUsdVol1h) { thin += 1; continue; }
    if (h.rangePct < cfg.minRange1hPct) { quiet += 1; continue; }
    const l = rangeMeasures(candles, { nowTs, windowMin: cfg.longWindowMin, minBars: Math.min(cfg.minBars, cfg.longWindowMin), maxStaleMin: cfg.maxStaleMin });
    out.push({ coin, symbol: `${coin}/USD`, range1hPct: round3(h.rangePct), ret1hPct: round3(h.retPct), usdVol1h: Math.round(h.usdVol), range4hPct: l && !l.stale && !l.tooFew ? round3(l.rangePct) : null, lastClose: h.lastClose, lastOpenSec: h.lastOpenSec });
  }
  out.sort((a, b) => b.range1hPct - a.range1hPct || b.usdVol1h - a.usdVol1h || a.coin.localeCompare(b.coin));
  return { ranked: out, skipped: { stale, thin, quiet } };
}

// pure: the next list from the ranking and the previous list (hysteresis: a listed coin stays while inside the band)
export function selectPicks(ranked, previous, { nowTs, picks = VOLATILITY_WATCH_DEFAULTS.picks, band = VOLATILITY_WATCH_DEFAULTS.band }) {
  const prevBy = new Map((previous ?? []).map((p) => [p.coin, p]));
  const inBand = new Set(ranked.slice(0, band).map((r) => r.coin));
  const kept = ranked.filter((r) => prevBy.has(r.coin) && inBand.has(r.coin)); // keep their entry clocks
  const entrants = ranked.filter((r) => !prevBy.has(r.coin));
  const list = [];
  for (const r of kept) list.push({ ...r, sinceTs: prevBy.get(r.coin).sinceTs, entries: prevBy.get(r.coin).entries ?? 1 });
  for (const r of entrants) { if (list.length >= picks) break; list.push({ ...r, sinceTs: nowTs, entries: 1 }); }
  // more kept than picks can only happen while the band shrinks; the oldest leave first
  list.sort((a, b) => b.range1hPct - a.range1hPct);
  const trimmed = list.length > picks ? [...list].sort((a, b) => a.sinceTs - b.sinceTs).slice(list.length - picks) : list;
  return trimmed.sort((a, b) => b.range1hPct - a.range1hPct).map((p) => ({ ...p, affirmedTs: nowTs }));
}

export function createVolatilityWatch({ seriesSource, dataDir, clock = () => Date.now(), log = () => {}, excludeBases = [], options = {} } = {}) {
  if (typeof seriesSource !== 'function' || typeof seriesSource.coins !== 'function') throw new Error('createVolatilityWatch: a broad-Kraken series source (with coins()) is required');
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('createVolatilityWatch: dataDir required');
  const cfg = { ...VOLATILITY_WATCH_DEFAULTS, ...options }; const exclude = new Set(excludeBases.map((b) => String(b).toUpperCase()));
  let current = { version: VOLATILITY_WATCH_VERSION, ts: 0, picks: [], ranked: 0, skipped: null }; let lastKeys = ''; const counters = { refreshes: 0, entered: 0, left: 0, writesFailed: 0 };
  function refresh(nowTs = clock()) {
    counters.refreshes += 1;
    const { ranked, skipped } = rankByVolatility({ seriesSource, nowTs, cfg, exclude });
    const picks = selectPicks(ranked, current.picks, { nowTs, picks: cfg.picks, band: cfg.band });
    const before = new Set(current.picks.map((p) => p.coin)); const after = new Set(picks.map((p) => p.coin));
    for (const p of picks) if (!before.has(p.coin)) { counters.entered += 1; log(`VOLATILITY WATCH: ${p.coin} enters the Judge's watch — ${p.range1hPct}% range this hour (${p.ret1hPct >= 0 ? '+' : ''}${p.ret1hPct}% net, $${Math.round(p.usdVol1h / 1000)}k traded${p.range4hPct !== null ? `, ${p.range4hPct}% over four hours` : ''})`); }
    for (const p of current.picks) if (!after.has(p.coin)) { counters.left += 1; log(`VOLATILITY WATCH: ${p.coin} leaves the watch (no longer among the top ${cfg.band} movers)`); }
    current = { version: VOLATILITY_WATCH_VERSION, ts: nowTs, picks, ranked: ranked.length, skipped, top: ranked.slice(0, cfg.band).map((r) => ({ coin: r.coin, range1hPct: r.range1hPct, usdVol1h: r.usdVol1h })) };
    const keys = picks.map((p) => `${p.coin}|${p.sinceTs}`).join(',');
    if (keys !== lastKeys || counters.refreshes === 1) { lastKeys = keys; try { mkdirSync(volatilityDir(dataDir), { recursive: true }); atomicWriteJson(volatilityFile(dataDir), current, { pretty: true }); } catch (err) { counters.writesFailed += 1; log(`VOLATILITY WATCH: current.json not written (${String(err?.message ?? err).slice(0, 120)})`); } }
    return current;
  }
  // the Judge's nomination shape (judge/composition.js nominate()): the ENTRY clock ranks, the affirmation keeps the TTL alive
  const nominations = () => current.picks.map((p) => ({ symbol: p.symbol, assetId: p.coin, source: VOLATILITY_WATCH_SOURCE, nominationKnownAtTs: p.sinceTs, nominationLastSeenTs: p.affirmedTs ?? p.sinceTs }));
  const line = () => `VOLATILITY WATCH: ${current.picks.length ? current.picks.map((p) => `${p.coin} ${p.range1hPct}%`).join(', ') : 'no coin moved enough this hour'} (ranked ${current.ranked}${current.skipped ? `; stale ${current.skipped.stale}, thin ${current.skipped.thin}, quiet ${current.skipped.quiet}` : ''})`;
  return { version: VOLATILITY_WATCH_VERSION, refresh, nominations, line, current: () => current, status: () => ({ version: VOLATILITY_WATCH_VERSION, picks: current.picks.slice(), ranked: current.ranked, skipped: current.skipped, counters: { ...counters }, config: { ...cfg }, authority: 'NONE' }) };
}

// the tape's hot lane reads the current picks in the wide-eye nomination shape ({ coin, ts, cause }); stale or malformed reads empty
export function readVolatilityWatchNow({ dataDir, nowTs = Date.now(), maxAgeMin = 15 } = {}) {
  try {
    const f = volatilityFile(dataDir); if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8')); if (!raw || raw.version !== VOLATILITY_WATCH_VERSION || !Number.isSafeInteger(raw.ts) || nowTs - raw.ts > maxAgeMin * MIN || !Array.isArray(raw.picks)) return [];
    return raw.picks.filter((p) => p && typeof p.coin === 'string' && Number.isSafeInteger(p.sinceTs)).map((p) => ({ coin: p.coin, ts: new Date(p.sinceTs).toISOString(), cause: `VOLATILITY_WATCH ${p.range1hPct}% 1h` }));
  } catch { return []; }
}
