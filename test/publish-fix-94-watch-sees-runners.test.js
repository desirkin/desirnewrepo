// PUBLISH-FIX-94 (2026-09-21) — THE WATCH SEES THE RUNNERS.
//
// Artifact: learning/volatility/current.json, deployment f91b5e87, 2026-09-21 00:47 UTC — "ranked 27, skipped { stale 409, thin 121,
// quiet 0 }", picks SUI 6.3% / NEAR 4.7% / AVAX 4.3% / ZEC 2.0%. Kraken's ticker for the same 24 hours: 77 USD pairs ran >= 10% from the
// open, 29 ran >= 20% (SYND +24.0, NOCK +22.6, QUAI +22.3, B2 +22.3 on a 62% range, CTSI +22.1 on $192k/day and 26 wide-eye sweeps,
// GNOT +21.8, LAPTOP +20.7). 0 of the 77 were in the Judge's boot universe; 1 of the 77 was ever looked at. Three rules in the watch did it:
// a coin was "stale" if it had not printed in 5 minutes (a quiet coin is not a dead feed); the floor was $150k an HOUR and the liquidity
// weight was 0 below $100k an hour (the runners do $2k-$260k a DAY); and 30 minutes of candles were needed before a range was measured
// (blind to the first half hour of a run). The Judge itself is unchanged: its frozen book-depth, cost and sizing law is the real gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeMeasures, rankByVolatility, selectPicks, VOLATILITY_WATCH_DEFAULTS } from '../learning/volatility-watch.js';

const MIN = 60_000; const NOW = Date.UTC(2026, 8, 21, 0, 47, 0); // the artifact's clock
// candles for one coin: `prints` = [[minutesAgo, price, usd, tradesInThatMinute = 1]] (one 1-minute candle per entry, newest last); received = when the collector last heard from it
function coinSeries(prints, { received = NOW } = {}) {
  const rows = prints.map(([ago, px, usd, n = 1]) => ({ c: [Math.floor((NOW - ago * MIN) / MIN) * 60, px, px, px, px, usd / px], n })).sort((a, b) => a.c[0] - b.c[0]);
  return { symbol: 'X', intervalSec: 60, retrievedTsMs: received, candles: rows.map((r) => r.c), trades: rows.map((r) => r.n) };
}
const src = (map) => Object.assign((coin) => map[coin] ?? null, { coins: () => Object.keys(map) });
// a steady coin: one print a minute for the last `minutes` minutes at `px`, `usdPerMin` each
const steady = (px, usdPerMin, minutes = 60, { received = NOW, lastAgo = 1 } = {}) => coinSeries(Array.from({ length: minutes }, (_, i) => [lastAgo + i, px, usdPerMin]), { received });

test('FIX94-1 (the artifact): a thin coin that has not printed for ten minutes is quiet-now, not a dead feed — it is ranked when it moved, and the source is judged alive by its newest receipt', () => {
  // 25 thin coins, last print 6-14 minutes ago, each with a modest move inside the hour; two majors printing every minute
  const map = {};
  for (let i = 0; i < 25; i += 1) map[`THIN${i}`] = coinSeries([[55, 1.00, 1000, 2], [50, 1.00, 1000, 2], [45, 1.01, 1000, 2], [40, 1.01, 1000, 2], [35, 1.02, 1000, 2], [30, 1.02, 1000, 2], [25, 1.03, 1000, 2], [20, 1.04, 1000, 2], [16, 1.05, 1000, 2], [12 + (i % 3), 1.05, 1000, 2], [9 + (i % 3), 1.06, 1000, 2], [6 + (i % 3), 1.06, 1000, 2]], { received: NOW - (6 + (i % 3)) * MIN }); // $12k on 24 prints in the hour: above the dust line, a 6% drift
  map.SUI = steady(3.5, 50_000); map.NEAR = steady(6, 40_000);
  const { ranked, skipped } = rankByVolatility({ seriesSource: src(map), nowTs: NOW });
  assert.equal(skipped.streamStale, false, 'the newest receipt across the source is a minute old: the stream is alive');
  assert.equal(skipped.stale, 0, 'no coin that printed inside the last 20 minutes is called stale (before the fix: all 25)');
  const thin = ranked.filter((r) => r.coin.startsWith('THIN'));
  assert.equal(thin.length, 25, `every thin coin is ranked (before the fix: none) — thin ${skipped.thin}, quiet ${skipped.quiet}`);
  assert.ok(thin.every((r) => r.range1hPct > 5.9 && r.range1hPct < 6.1), 'the 6% move inside the hour is measured from a dozen sparse candles');
  // and the majors, printing $50k a minute with no range, are quiet-now: they do not crowd the list
  assert.ok(!ranked.some((r) => r.coin === 'SUI' || r.coin === 'NEAR'), JSON.stringify(ranked.map((r) => r.coin)));
  assert.equal(skipped.quiet, 2);
});

test('FIX94-2 (the early catch): a coin ten minutes into a run, after a quiet hour, ranks at the top of the list on its first refresh', () => {
  // CTSI-shaped: $8k an hour of background, sparse prints, then a run — 8 minutes of prints climbing 8% on $3k a minute
  const quietHour = [[58, 0.100, 400], [47, 0.100, 300], [36, 0.101, 500], [25, 0.100, 350]];
  const run = Array.from({ length: 8 }, (_, k) => [9 - k, 0.100 * (1 + 0.01 * (k + 1)), 3_000, 15]); // fifteen prints a minute once it runs
  const map = { CTSI: coinSeries([...quietHour, ...run]), SUI: steady(3.5, 50_000), NEAR: steady(6, 40_000), AVAX: steady(30, 30_000) };
  // the majors move a little
  map.SUI.candles[map.SUI.candles.length - 1][2] *= 1.02; map.SUI.candles[0][3] *= 0.99;
  const { ranked, skipped } = rankByVolatility({ seriesSource: src(map), nowTs: NOW });
  const ctsi = ranked.find((r) => r.coin === 'CTSI');
  assert.ok(ctsi, `CTSI is ranked on 12 candles in the hour (before the fix: tooFew under 30, and $25.5k in the hour was under the $150k floor) — ${JSON.stringify(skipped)}`);
  assert.ok(ctsi.range1hPct > 7.5 && ctsi.range1hPct < 8.5, `the run so far is the range: ${ctsi.range1hPct}%`);
  assert.equal(ranked[0].coin, 'CTSI', `an 8% run on $25k outranks a 3% wobble on $3M: ${JSON.stringify(ranked.map((r) => [r.coin, r.score]))}`);
  assert.ok(ctsi.liquidityWeight > 0.15 && ctsi.liquidityWeight < 0.3, `$25.5k in the hour weighs ~0.2 (was 0): ${ctsi.liquidityWeight}`);
  const picks = selectPicks(ranked, [], { nowTs: NOW, picks: 6, band: 12 });
  assert.equal(picks[0].coin, 'CTSI', 'and it takes the first Judge slot');
});

test('FIX94-3 (a dead feed is still a dead feed): when the newest receipt across the whole source is older than sourceStaleMin, nothing is ranked and the status says so', () => {
  const map = { A: steady(1, 20_000, 60, { received: NOW - 9 * MIN, lastAgo: 9 }), B: steady(2, 20_000, 60, { received: NOW - 12 * MIN, lastAgo: 12 }) };
  map.A.candles[0][3] *= 0.9; map.B.candles[0][3] *= 0.9; // both "moved" 10%
  const { ranked, skipped } = rankByVolatility({ seriesSource: src(map), nowTs: NOW });
  assert.deepEqual(ranked, []); assert.equal(skipped.streamStale, true); assert.equal(skipped.stale, 2); assert.equal(skipped.newestReceivedTs, NOW - 9 * MIN);
});

test('FIX94-4 (dust stays out): $3k in the hour on four prints is thin; a coin whose last print is 25 minutes old is quiet-now; a coin with no range is quiet', () => {
  const map = {
    DUST: coinSeries([[40, 0.01, 800], [30, 0.011, 700], [20, 0.012, 900], [5, 0.013, 600]]),          // 30% "range" on $3k: dust
    GONE: coinSeries([[58, 1, 5_000], [50, 1.1, 5_000], [40, 1.2, 5_000], [25, 1.25, 5_000]]),           // moved, but nothing for 25 minutes
    FLAT: steady(10, 5_000),                                                                            // $300k, no range
  };
  const { ranked, skipped } = rankByVolatility({ seriesSource: src(map), nowTs: NOW });
  assert.deepEqual(ranked, [], JSON.stringify(ranked)); assert.equal(skipped.thin, 1); assert.equal(skipped.stale, 1); assert.equal(skipped.quiet, 1);
});

test('FIX94-5 (the window is anchored at now): a spike an hour ago on a coin that then printed once does not read as this hour\'s range', () => {
  // a 20% spike 70-65 minutes ago, then flat prints inside the hour: before the fix the window hung off the last candle and could reach back into the spike
  const spike = [[70, 1.0, 5_000], [68, 1.2, 5_000], [66, 1.1, 5_000], [64, 1.0, 5_000]];
  const flat = [[50, 1.0, 5_000], [40, 1.0, 5_000], [30, 1.0, 5_000], [20, 1.0, 5_000], [10, 1.0, 5_000], [4, 1.0, 5_000]];
  const h = rangeMeasures(coinSeries([...spike, ...flat]).candles, { nowTs: NOW, windowMin: 60, minBars: 5, maxStaleMin: 20 });
  assert.equal(h.bars, 6); assert.ok(h.rangePct < 0.01, `the spike is outside the window: ${h.rangePct}%`);
  // and a coin whose only prints inside the window are old still measures only what is inside it
  const h2 = rangeMeasures(coinSeries([[59, 1.0, 5_000], [55, 1.1, 5_000], [50, 1.05, 5_000], [45, 1.05, 5_000], [40, 1.05, 5_000], [15, 1.05, 5_000]]).candles, { nowTs: NOW, windowMin: 60, minBars: 5, maxStaleMin: 20 });
  assert.ok(Math.abs(h2.rangePct - 10) < 0.01, `only the window counts: ${h2.rangePct}%`); assert.equal(h2.lastOpenSec, Math.floor((NOW - 15 * MIN) / MIN) * 60);
});

test('FIX94-6 (the shipped bars): the defaults are the $500-account floors, not the majors\' bar', () => {
  assert.equal(VOLATILITY_WATCH_DEFAULTS.minBars, 5); assert.equal(VOLATILITY_WATCH_DEFAULTS.minUsdVol1h, 10_000); assert.equal(VOLATILITY_WATCH_DEFAULTS.minTrades1h, 10);
  assert.equal(VOLATILITY_WATCH_DEFAULTS.liquidityRefUsd, 10_000); assert.equal(VOLATILITY_WATCH_DEFAULTS.tradesRef1h, 60);
  assert.equal(VOLATILITY_WATCH_DEFAULTS.maxStaleMin, 20); assert.equal(VOLATILITY_WATCH_DEFAULTS.sourceStaleMin, 5);
  assert.equal(VOLATILITY_WATCH_DEFAULTS.picks, 20, 'PUBLISH-FIX-99: the order-book stage widened 6 -> 20 on measured headroom (event-loop utilisation 88-91% -> 56-61% after FIX-97); the Judge still prepares six, now the best six OF TWENTY'); assert.equal(VOLATILITY_WATCH_DEFAULTS.band, 30); assert.equal(VOLATILITY_WATCH_DEFAULTS.minRange1hPct, 0.8);
});

// ---- PUBLISH-FIX-95 (2026-09-21): the nomination floor, the second door ------------------------------------------------------
// FIX-94 got the runners RANKED and PICKED. tape/universe.js then re-verifies each nominee against the venue and refuses anything
// under config.wideeye.nominationFloorUsd before the hot lane may adopt it. At $2,000,000 a day that refused almost every runner
// the watch had just picked: of the 77 Kraken USD pairs that ran >= 10% on 2026-09-20, the liquid ones traded $180k-$264k a DAY
// (CTSI $192k, GNOT $228k, LAPTOP $264k, B2 $180k) and only DRV ($2.06M) could pass. The floor is now $100k — the same line the
// runners study used for "tradable at $500 without moving the book" — and the deep tape stays bounded by the hot lane's six slots.
test('FIX95-1: tonight\'s runners clear the nomination floor and dust does not', async () => {
  const { loadConfig } = await import('../lib/config.js');
  const { mergeNominationsAndCap } = await import('../tape/universe.js');
  const config = loadConfig();
  assert.equal(config.wideeye.nominationFloorUsd, 100_000, 'the shipped floor');
  // the venue's own 24h dollar volume for the coins the watch picked or ranked on 2026-09-20/21
  const real = { DRV: 2_060_000, LAPTOP: 264_000, GNOT: 228_000, CTSI: 192_000, B2: 180_000, MYX: 220_000, SYND: 9_000, DUCK: 2_000, BLUE: 1_000 };
  const assetPairs = Object.fromEntries(Object.keys(real).map((c) => [`${c}USD`, { wsname: `${c}/USD`, quote: 'USD', status: 'online' }]));
  const tickers = Object.fromEntries(Object.entries(real).map(([c, usd]) => [`${c}USD`, { v: ['0', String(usd / 2)], p: ['2', '2'] }]));
  const { pairs } = mergeNominationsAndCap([], Object.keys(real).map((coin) => ({ coin })), assetPairs, tickers, config);
  const admitted = new Set(pairs.map((p) => p.coin));
  for (const c of ['DRV', 'LAPTOP', 'GNOT', 'CTSI', 'B2', 'MYX']) assert.ok(admitted.has(c), `${c} ($${real[c]}/day) is tradable at $500 and must be verifiable`);
  for (const c of ['SYND', 'DUCK', 'BLUE']) assert.ok(!admitted.has(c), `${c} ($${real[c]}/day) is dust — a $500 order would be the market`);
  // and at the OLD floor only DRV survived: this is what the fix changed
  const old = mergeNominationsAndCap([], Object.keys(real).map((coin) => ({ coin })), assetPairs, tickers, { ...config, wideeye: { ...config.wideeye, nominationFloorUsd: 2_000_000 } });
  assert.deepEqual(old.pairs.map((p) => p.coin), ['DRV'], 'at $2M a day, 5 of these 6 tradable runners were refused at the venue check');
});
