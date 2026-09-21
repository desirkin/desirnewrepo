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
// PUBLISH-FIX-94 (2026-09-21) — THE WATCH SEES THE RUNNERS. The artifact, learning/volatility/current.json at 2026-09-21 00:47 UTC:
// "ranked 27, skipped { stale 409, thin 121, quiet 0 }", picks SUI / NEAR / AVAX / ZEC. The same 24 hours, from Kraken's own ticker: 77
// USD pairs ran >= 10% from their open, 29 ran >= 20% (SYND +24, NOCK +22.6, B2 +22.3 on a 62% range, CTSI +22.1 on $192k/day, GNOT,
// LAPTOP) — 0 of the 77 in the Judge's boot universe, 1 of the 77 ever looked at, every one of them swept by the wide eye 5-26 times.
// Three rules in THIS file kept them from the Judge:
//   1. maxStaleMin 5 called a coin "stale" when it had not PRINTED for five minutes. The collector closes a candle only when the next trade
//      arrives, so on a quiet Sunday night 409 healthy thin coins read as dead feeds. A quiet coin is not a stale stream: stream liveness is
//      now judged ONCE for the whole source (the newest receipt across every coin), and a coin is rankable if it printed inside the window.
//   2. minUsdVol1h 150k / minTrades1h 60 / liquidityRefUsd 100k: the runners do $2k-$260k a DAY. $150k an HOUR is the majors' bar, and the
//      liquidity weight was ZERO below $100k an hour, so even a ranked runner scored 0. The floor is now the dust line for a $500 order
//      ($10k in the hour, ten prints); the weight is 0 at $10k, 0.5 at $100k, 1 at $1M — big moves on modest money outrank small moves on
//      huge money, which is the owner's directive ("volume and volatility, never BTC"), while dust nobody traded still scores 0.
//   3. minBars 30 needed half an hour of candles before it would measure a range, so a coin ten minutes into a run was invisible exactly
//      when the owner's son asked for it to be caught ("before the percentages run out"). Five minutes inside the window is enough to see a
//      run begin; the window is anchored at NOW (not at the coin's last candle), so an old spike on a coin that then went dead cannot rank.
// The Judge is unchanged and remains the real gate: every nominee still faces its frozen book-depth, cost and sizing law on the live book.
export const VOLATILITY_WATCH_DEFAULTS = Object.freeze({
  picks: 6,               // the Judge's preparation slots
  band: 12,               // a listed coin stays while it is still inside the top `band` (hysteresis against churn)
  windowMin: 60,          // the hour that is ranked (anchored at now)
  longWindowMin: 240,     // the four-hour range, reported beside it
  minBars: 5,             // PUBLISH-FIX-94: minutes with a candle inside the window before a range is measured (was 30: blind to the first half hour of a run)
  minUsdVol1h: 10_000,    // PUBLISH-FIX-94: the dust line for a $500 order (was 150k: the majors' bar; the runners do $2k-$260k a day)
  minTrades1h: 10,        // PUBLISH-FIX-94: ten prints in the window (was 60), else the range is a handful of prints
  liquidityRefUsd: 10_000, // PUBLISH-FIX-94: the liquidity weight min(1, log10(usdVol / ref) / 2) — $10k -> 0, $100k -> 0.5, $1M -> 1 (was 100k -> 0, so every runner scored 0)
  tradesRef1h: 60,        // PUBLISH-FIX-94: the print-density weight min(1, trades / ref) — a print a minute across the hour weighs 1 (was 120)
  minRange1hPct: 0.8,     // below this the window did not move enough to matter against fees; the list may be shorter than `picks`
  maxStaleMin: 20,        // PUBLISH-FIX-94: a coin must have printed within this many minutes to be ranked NOW (was 5, which read quiet coins as dead feeds)
  // PUBLISH-FIX-98 (2026-09-21, owner: "an ever living funnel as things boil up to fit what we're trying to do ... the one that fits
  // the most is the first one to be there"). Working backwards from the bite: the Judge sizes nothing unless the scenario target sits
  // roughly (roundTrip + stop) x REWARD_RISK_MIN above entry — about 5.5% on this account (1.6% round trip, 0.6% stop, RR 1.5). Raw
  // range said which coin moved MOST; it never said which coin could CLEAR THE HURDLE. The census of 2026-09-21 showed why that
  // matters: ARB passed every gate on 23.6x relative volume and 0.99 buying pressure and was refused at sizing because its ATR was
  // 0.318% — a third of one percent against a 1.6% fee. fitness = the window's range as a MULTIPLE of that hurdle, so a coin is
  // ranked by whether it can pay, not by whether it wiggled.
  hurdlePct: 5.5,
  sourceStaleMin: 5,      // PUBLISH-FIX-94: the SOURCE is stale when its newest receipt across every coin is older than this; then nothing is ranked
});
const MIN = 60_000;
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
export const volatilityDir = (dataDir) => path.join(path.resolve(dataDir), 'learning', 'volatility');
export const volatilityFile = (dataDir) => path.join(volatilityDir(dataDir), 'current.json');

// the measures of the last `windowMin` closed minutes of one coin's candles ([openSec, o, h, l, c, v] ascending).
// PUBLISH-FIX-94: the window is anchored at NOW — [now - windowMin, now) on the minute grid — not at the coin's last candle, so a spike an
// hour ago on a coin that then went quiet cannot be reported as "this hour". `stale` now means the coin has not printed within maxStaleMin
// (it is quiet NOW, not a candidate), never that its feed is dead; the source's own liveness is rankByVolatility's business.
export function rangeMeasures(candles, { nowTs, windowMin, minBars, maxStaleMin, trades: tradeCounts = null }) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const last = candles[candles.length - 1]; const lastEndMs = (last[0] + 60) * 1000;
  if (nowTs - lastEndMs > maxStaleMin * MIN) return { stale: true, ageMin: Math.round((nowTs - lastEndMs) / MIN) };
  const endSec = Math.floor(nowTs / MIN) * 60; const fromSec = endSec - windowMin * 60; let hi = -Infinity; let lo = Infinity; let usd = 0; let bars = 0; let first = null; let lastIn = null; let trades = null;
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i]; if (c[0] < fromSec) break; if (c[0] >= endSec) continue;
    if (!(c[2] > 0 && c[3] > 0 && c[4] > 0)) continue;
    if (!lastIn) lastIn = c;
    if (c[2] > hi) hi = c[2]; if (c[3] < lo) lo = c[3]; usd += (c[5] ?? 0) * c[4]; bars += 1; first = c; const tc = Array.isArray(tradeCounts) ? tradeCounts[i] : null; if (Number.isSafeInteger(tc)) trades = (trades ?? 0) + tc;
  }
  if (bars < minBars || !(lo > 0) || !first || !lastIn) return { bars, tooFew: true };
  return { bars, rangePct: (hi / lo - 1) * 100, retPct: (lastIn[4] / first[1] - 1) * 100, usdVol: usd, trades, lastClose: lastIn[4], lastOpenSec: lastIn[0] };
}

// pure: rank the coins of a series source; returns the ranked eligible list (best first)
export function rankByVolatility({ seriesSource, nowTs, cfg = VOLATILITY_WATCH_DEFAULTS, exclude = new Set() }) {
  const out = []; let stale = 0; let thin = 0; let quiet = 0;
  // PUBLISH-FIX-94: the SOURCE's liveness is one question for the whole stream — the newest receipt across every coin. A dead feed ranks
  // nothing and says so; a coin that merely has not printed for a while is judged by rangeMeasures as quiet-now, not as a dead feed.
  const gathered = []; let newestReceived = null;
  for (const coin of seriesSource.coins()) {
    if (exclude.has(coin)) continue;
    const series = seriesSource(coin); const candles = series?.candles; if (!Array.isArray(candles) || !candles.length) continue;
    if (Number.isSafeInteger(series.retrievedTsMs)) newestReceived = newestReceived === null ? series.retrievedTsMs : Math.max(newestReceived, series.retrievedTsMs);
    gathered.push([coin, series, candles]);
  }
  const sourceStaleMin = cfg.sourceStaleMin ?? VOLATILITY_WATCH_DEFAULTS.sourceStaleMin;
  if (newestReceived !== null && nowTs - newestReceived > sourceStaleMin * MIN) return { ranked: [], skipped: { stale: gathered.length, thin: 0, quiet: 0, streamStale: true, newestReceivedTs: newestReceived } };
  for (const [coin, series, candles] of gathered) {
    const h = rangeMeasures(candles, { nowTs, windowMin: cfg.windowMin, minBars: cfg.minBars, maxStaleMin: cfg.maxStaleMin, trades: Array.isArray(series.trades) && series.trades.length === candles.length ? series.trades : null });
    if (!h || h.stale) { stale += 1; continue; }
    if (h.tooFew || h.usdVol < cfg.minUsdVol1h || (h.trades !== null && h.trades < (cfg.minTrades1h ?? 0))) { thin += 1; continue; }
    if (h.rangePct < cfg.minRange1hPct) { quiet += 1; continue; }
    const l = rangeMeasures(candles, { nowTs, windowMin: cfg.longWindowMin, minBars: Math.min(cfg.minBars, cfg.longWindowMin), maxStaleMin: cfg.maxStaleMin });
    // PUBLISH-FIX-83 item 14: the rank is the range WEIGHTED by liquidity and print density, so a 3% "range" on $200k of alternating
    // bid/ask prints no longer outranks a 1.5% move on $20M; the raw range is still reported beside it
    const liquidityWeight = Math.min(1, Math.max(0, Math.log10(h.usdVol / (cfg.liquidityRefUsd ?? VOLATILITY_WATCH_DEFAULTS.liquidityRefUsd)) / 2)); const densityWeight = h.trades === null ? 1 : Math.min(1, h.trades / (cfg.tradesRef1h ?? VOLATILITY_WATCH_DEFAULTS.tradesRef1h));
    // PUBLISH-FIX-94: the weights are DISCOUNTS, never a veto — each can at most halve the score. With a plain product a 22% run on $60k in
    // the hour (weight 0.39) scored below a 3% wobble on $3M (weight 1); the dust line above is the veto, the weights only order what is above it.
    // PUBLISH-FIX-98: the ranked quantity is FITNESS — the range as a multiple of the cost hurdle the Judge's sizing must clear — so the
    // funnel is ordered by what can pay, not by what moved. A coin under 1.0 cannot produce the target however violently it wiggles.
    const hurdlePct = Number.isFinite(cfg.hurdlePct) && cfg.hurdlePct > 0 ? cfg.hurdlePct : VOLATILITY_WATCH_DEFAULTS.hurdlePct;
    const fitness = round3(h.rangePct / hurdlePct);
    const score = (h.rangePct / hurdlePct) * (0.5 + 0.5 * liquidityWeight) * (0.5 + 0.5 * densityWeight);
    out.push({ coin, symbol: `${coin}/USD`, range1hPct: round3(h.rangePct), fitness, hurdlePct, score: round3(score), liquidityWeight: round3(liquidityWeight), densityWeight: round3(densityWeight), trades1h: h.trades, ret1hPct: round3(h.retPct), usdVol1h: Math.round(h.usdVol), range4hPct: l && !l.stale && !l.tooFew ? round3(l.rangePct) : null, lastClose: h.lastClose, lastOpenSec: h.lastOpenSec });
  }
  out.sort((a, b) => b.score - a.score || b.range1hPct - a.range1hPct || b.usdVol1h - a.usdVol1h || a.coin.localeCompare(b.coin));
  return { ranked: out, skipped: { stale, thin, quiet, streamStale: false, newestReceivedTs: newestReceived } };
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
  const rank = (a, b) => (b.score ?? b.range1hPct) - (a.score ?? a.range1hPct) || b.range1hPct - a.range1hPct; list.sort(rank);
  const trimmed = list.length > picks ? [...list].sort((a, b) => a.sinceTs - b.sinceTs).slice(list.length - picks) : list;
  return trimmed.sort(rank).map((p) => ({ ...p, affirmedTs: nowTs }));
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
    current = { version: VOLATILITY_WATCH_VERSION, ts: nowTs, picks, ranked: ranked.length, skipped, top: ranked.slice(0, cfg.band).map((r) => ({ coin: r.coin, range1hPct: r.range1hPct, score: r.score, usdVol1h: r.usdVol1h, trades1h: r.trades1h })) };
    const keys = picks.map((p) => `${p.coin}|${p.sinceTs}`).join(',');
    if (keys !== lastKeys || counters.refreshes === 1) { lastKeys = keys; try { mkdirSync(volatilityDir(dataDir), { recursive: true }); atomicWriteJson(volatilityFile(dataDir), current, { pretty: true }); } catch (err) { counters.writesFailed += 1; log(`VOLATILITY WATCH: current.json not written (${String(err?.message ?? err).slice(0, 120)})`); } }
    return current;
  }
  // the Judge's nomination shape (judge/composition.js nominate()): the ENTRY clock ranks, the affirmation keeps the TTL alive
  const nominations = () => current.picks.map((p) => ({ symbol: p.symbol, assetId: p.coin, source: VOLATILITY_WATCH_SOURCE, nominationKnownAtTs: p.sinceTs, nominationLastSeenTs: p.affirmedTs ?? p.sinceTs, score: p.score ?? null, fitness: p.fitness ?? null })); // PUBLISH-FIX-98: the fit travels with the nomination
  const line = () => `VOLATILITY WATCH: ${current.skipped?.streamStale ? 'SOURCE STALE — nothing ranked (newest receipt ' + new Date(current.skipped.newestReceivedTs).toISOString() + ')' : current.picks.length ? current.picks.map((p) => `${p.coin} ${p.range1hPct}%`).join(', ') : 'no coin moved enough this hour'} (ranked ${current.ranked}${current.skipped ? `; quiet-now ${current.skipped.stale}, thin ${current.skipped.thin}, no-range ${current.skipped.quiet}` : ''})`;
  return { version: VOLATILITY_WATCH_VERSION, refresh, nominations, line, current: () => current, status: () => ({ version: VOLATILITY_WATCH_VERSION, picks: current.picks.slice(), ranked: current.ranked, skipped: current.skipped, counters: { ...counters }, config: { ...cfg }, authority: 'NONE' }) };
}

// the tape's hot lane reads the current picks in the wide-eye nomination shape ({ coin, ts, cause }); stale or malformed reads empty
export function readVolatilityWatchNow({ dataDir, nowTs = Date.now(), maxAgeMin = 15 } = {}) {
  try {
    const f = volatilityFile(dataDir); if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8')); if (!raw || raw.version !== VOLATILITY_WATCH_VERSION || !Number.isSafeInteger(raw.ts) || nowTs - raw.ts > maxAgeMin * MIN || !Array.isArray(raw.picks)) return [];
    return raw.picks.filter((p) => p && typeof p.coin === 'string' && Number.isSafeInteger(p.sinceTs)).map((p) => ({ coin: p.coin, ts: new Date(p.sinceTs).toISOString(), cause: `VOLATILITY_WATCH ${p.range1hPct}% 1h (fit ${p.fitness ?? '?'}x)`, score: p.score ?? null, fitness: p.fitness ?? null })); // PUBLISH-FIX-98
  } catch { return []; }
}
