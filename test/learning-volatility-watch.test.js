// PUBLISH-FIX-66 (2026-09-18): the VOLATILITY WATCH — the owner's "volume and volatility, never BTC" as a bounded watch list.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rangeMeasures, rankByVolatility, selectPicks, createVolatilityWatch, readVolatilityWatchNow, volatilityFile, VOLATILITY_WATCH_SOURCE, VOLATILITY_WATCH_DEFAULTS } from '../learning/volatility-watch.js';

const MIN = 60_000; const T0 = Date.UTC(2026, 8, 18, 14, 0, 0); const NOW = T0 + 240 * MIN;
// a coin's last 240 closed minutes ending just before NOW: flat at `base`, with an hour-range of `rangePct` in the last hour
// (a dip to base*(1-r/2) then a climb to base*(1+r/2)), `usdPerMin` dollars traded per minute
function candles({ base = 1, rangePct = 0, usdPerMin = 5_000, minutes = 240, gapLastMin = 0, tradesPerMin = null }) {
  const out = []; const firstSec = (NOW - minutes * MIN) / 1000;
  for (let i = 0; i < minutes - gapLastMin; i += 1) {
    const inLastHour = i >= minutes - 60; let px = base;
    if (inLastHour && rangePct > 0) { const k = i - (minutes - 60); px = k < 30 ? base * (1 - (rangePct / 200) * (k / 30)) : base * (1 - rangePct / 200 + (rangePct / 100) * ((k - 30) / 30)); }
    const v = usdPerMin / px; out.push([firstSec + i * 60, px, px * 1.0002, px * 0.9998, px, v]);
  }
  if (tradesPerMin !== null) out.trades = out.map(() => tradesPerMin); // PUBLISH-FIX-83 item 14: print counts ride beside the candles
  return out;
}
const source = (map) => Object.assign((coin) => (map[coin] ? { symbol: coin, intervalSec: 60, candles: map[coin], trades: map[coin].trades ?? null } : null), { coins: () => Object.keys(map) });

test('VW-01. rangeMeasures: the hour range as a share of its low, the traded dollars, staleness and thin coverage', () => {
  const c = candles({ base: 2, rangePct: 4, usdPerMin: 3_000 });
  const h = rangeMeasures(c, { nowTs: NOW, windowMin: 60, minBars: 50, maxStaleMin: 5 });
  assert.equal(h.bars, 60); assert.ok(Math.abs(h.rangePct - 4.08) < 0.15, `range ${h.rangePct}`); assert.ok(Math.abs(h.usdVol - 180_000) < 2_000, `usd ${h.usdVol}`);
  assert.equal(rangeMeasures(c, { nowTs: NOW + 10 * MIN, windowMin: 60, minBars: 50, maxStaleMin: 5 }).stale, true, 'a stream 10 minutes behind is stale');
  assert.equal(rangeMeasures(candles({ minutes: 30 }), { nowTs: NOW, windowMin: 60, minBars: 50, maxStaleMin: 5 }).tooFew, true);
  assert.equal(rangeMeasures([], { nowTs: NOW, windowMin: 60, minBars: 50, maxStaleMin: 5 }), null);
});

test('VW-02. the ranking: the coins that MOVED this hour first, BTC-like coins that did not move are out, thin and stale coins are out, excluded bases are out', () => {
  const src = source({
    BTC: candles({ base: 60_000, rangePct: 0.4, usdPerMin: 500_000 }),   // huge volume, no range: quiet
    PEPE: candles({ base: 0.00001, rangePct: 9, usdPerMin: 40_000 }),     // moved, tradeable ($2.4M this hour)
    WIF: candles({ base: 1.2, rangePct: 5, usdPerMin: 25_000 }),          // moved, tradeable ($1.5M)
    ZZZ: candles({ base: 0.5, rangePct: 12, usdPerMin: 3_000 }),          // moved, but $180k traded: thin (PUBLISH-FIX-83 item 14: the floor is $1M)
    SPARSE: candles({ base: 0.5, rangePct: 6, usdPerMin: 30_000, tradesPerMin: 0 }), // $1.8M but 20 prints in the hour: a handful of prints, thin
    AVAX: candles({ base: 30, rangePct: 1.6, usdPerMin: 600_000, tradesPerMin: 40 }), // 1.6% on $36M: a real move that outranks a bigger range on thin money
    OLD: candles({ base: 3, rangePct: 7, usdPerMin: 5_000, gapLastMin: 20 }), // stream stale
    USDT: candles({ base: 1, rangePct: 6, usdPerMin: 9_000 }),            // excluded base
  });
  const { ranked, skipped } = rankByVolatility({ seriesSource: src, nowTs: NOW, exclude: new Set(['USDT']) });
  assert.deepEqual(ranked.map((r) => r.coin), ['PEPE', 'WIF', 'AVAX'], JSON.stringify(ranked.map((r) => [r.coin, r.score, r.range1hPct, r.usdVol1h, r.trades1h])));
  assert.equal(skipped.quiet, 1); assert.equal(skipped.thin, 2); assert.equal(skipped.stale, 1);
  assert.ok(ranked[0].range1hPct > 8 && ranked[0].usdVol1h > 2_000_000); assert.equal(ranked[0].symbol, 'PEPE/USD'); assert.ok(ranked[0].range4hPct !== null);
  // the rank is liquidity-weighted: PEPE 9% on $2.4M (weight ~0.69) scores ~6.2, WIF 5% on $1.5M (~0.59) ~3.0, AVAX 1.6% on $36M (weight 1, 2,400 prints over the 120 ref -> density 1) 1.6
  assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score); assert.equal(ranked[2].liquidityWeight, 1); assert.equal(ranked[2].trades1h, 2400);
  // a 3% "range" on barely $1.05M ranks BELOW AVAX's 1.6% on $36M: the raw range no longer wins on its own
  const thin = rankByVolatility({ seriesSource: source({ PEPE: candles({ base: 0.00001, rangePct: 3, usdPerMin: 17_500 }), AVAX: candles({ base: 30, rangePct: 1.6, usdPerMin: 600_000, tradesPerMin: 120 }) }), nowTs: NOW }).ranked; assert.deepEqual(thin.map((r) => r.coin), ['AVAX', 'PEPE'], JSON.stringify(thin.map((r) => [r.coin, r.score])));
});

test('VW-03. selectPicks: entrants get the clock they entered with and keep it while inside the band; a coin leaves only when it falls out of the band; the list never exceeds picks', () => {
  const r = (coin, range) => ({ coin, symbol: `${coin}/USD`, range1hPct: range, usdVol1h: 1e6 });
  const first = selectPicks([r('A', 9), r('B', 8), r('C', 7), r('D', 6)], [], { nowTs: T0, picks: 3, band: 6 });
  assert.deepEqual(first.map((p) => p.coin), ['A', 'B', 'C']); assert.ok(first.every((p) => p.sinceTs === T0));
  // B cools to 5th place but is still inside the band of 6: it stays with its original clock; E is new and enters
  const second = selectPicks([r('A', 9), r('E', 8.5), r('C', 7), r('D', 6), r('B', 5.5), r('F', 5)], first, { nowTs: T0 + 5 * MIN, picks: 3, band: 6 });
  assert.deepEqual(second.map((p) => p.coin).sort(), ['A', 'B', 'C'], 'kept coins fill the list before entrants'); assert.equal(second.find((p) => p.coin === 'B').sinceTs, T0);
  // B drops out of the band: it leaves, E enters with a fresh clock
  const third = selectPicks([r('A', 9), r('E', 8.5), r('C', 7), r('D', 6), r('F', 5), r('G', 4.5), r('H', 4), r('B', 3)], second, { nowTs: T0 + 10 * MIN, picks: 3, band: 6 });
  assert.deepEqual(third.map((p) => p.coin).sort(), ['A', 'C', 'E']); assert.equal(third.find((p) => p.coin === 'E').sinceTs, T0 + 10 * MIN); assert.equal(third.find((p) => p.coin === 'A').sinceTs, T0);
  assert.ok(third.every((p) => p.affirmedTs === T0 + 10 * MIN));
});

test('VW-04. end to end: the source writes current.json, nominates with the entry clock (newest wins a Judge slot) and the affirmation clock, logs entries and exits, and the hot lane reads the picks in its own shape; a stale file reads empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serpent-volatility-'));
  try {
    const map = { BTC: candles({ base: 60_000, rangePct: 0.3, usdPerMin: 500_000 }), PEPE: candles({ base: 0.00001, rangePct: 9, usdPerMin: 40_000 }), WIF: candles({ base: 1.2, rangePct: 5, usdPerMin: 25_000 }) };
    const log = []; let now = NOW;
    const watch = createVolatilityWatch({ seriesSource: source(map), dataDir: dir, clock: () => now, log: (m) => log.push(m), excludeBases: ['USDT'], options: { picks: 2 } });
    const cur = watch.refresh();
    assert.deepEqual(cur.picks.map((p) => p.coin), ['PEPE', 'WIF']); assert.ok(existsSync(volatilityFile(dir)));
    assert.ok(log.some((m) => /VOLATILITY WATCH: PEPE enters the Judge's watch/.test(m)), log.join(' | '));
    const noms = watch.nominations(); assert.equal(noms.length, 2); assert.equal(noms[0].source, VOLATILITY_WATCH_SOURCE); assert.equal(noms[0].assetId, 'PEPE'); assert.equal(noms[0].symbol, 'PEPE/USD'); assert.equal(noms[0].nominationKnownAtTs, NOW); assert.equal(noms[0].nominationLastSeenTs, NOW);
    assert.match(watch.line(), /VOLATILITY WATCH: PEPE 9/);
    const hot = readVolatilityWatchNow({ dataDir: dir, nowTs: NOW + MIN }); assert.equal(hot.length, 2); assert.equal(hot[0].coin, 'PEPE'); assert.match(hot[0].cause, /VOLATILITY_WATCH 9/); assert.equal(hot[0].ts, new Date(NOW).toISOString());
    assert.deepEqual(readVolatilityWatchNow({ dataDir: dir, nowTs: NOW + 20 * MIN }), [], 'a file older than 15 minutes is not trusted');
    // five minutes on, PEPE quiets down and drops out of the band; WIF stays with its clock; nothing else moved: the list shrinks
    now = NOW + 5 * MIN; map.PEPE = candles({ base: 0.00001, rangePct: 0.2, usdPerMin: 40_000, minutes: 245 }); map.WIF = candles({ base: 1.2, rangePct: 5, usdPerMin: 25_000, minutes: 245 }); map.BTC = candles({ base: 60_000, rangePct: 0.3, usdPerMin: 500_000, minutes: 245 });
    const next = watch.refresh();
    assert.deepEqual(next.picks.map((p) => p.coin), ['WIF']); assert.equal(next.picks[0].sinceTs, NOW); assert.equal(next.picks[0].affirmedTs, now);
    assert.ok(log.some((m) => /VOLATILITY WATCH: PEPE leaves the watch/.test(m)));
    assert.equal(JSON.parse(readFileSync(volatilityFile(dir), 'utf8')).picks.length, 1);
    assert.equal(watch.status().authority, 'NONE'); assert.equal(watch.status().counters.entered, 2); assert.equal(watch.status().counters.left, 1);
    assert.throws(() => createVolatilityWatch({ seriesSource: () => null, dataDir: dir }), /coins\(\)/);
    assert.ok(VOLATILITY_WATCH_DEFAULTS.picks === 6); assert.equal(VOLATILITY_WATCH_DEFAULTS.minBars, 30, 'PUBLISH-FIX-71: 30 of the last 60 minutes rank a coin (a republish leaves 15–30 min on disk)');
    // PUBLISH-FIX-71: a coin with 35 of the last 60 minutes on disk is ranked (was: not until 50)
    { const r35 = rankByVolatility({ seriesSource: source({ ZZ: candles({ base: 3, rangePct: 6, usdPerMin: 50_000, minutes: 35 }) }), nowTs: NOW }); assert.deepEqual(r35.ranked.map((x) => x.coin), ['ZZ']); const r25 = rankByVolatility({ seriesSource: source({ ZZ: candles({ base: 3, rangePct: 6, usdPerMin: 50_000, minutes: 25 }) }), nowTs: NOW }); assert.deepEqual(r25.ranked, []); assert.equal(r25.skipped.thin, 1); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
