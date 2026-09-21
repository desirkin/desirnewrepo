// PUBLISH-FIX-98 (2026-09-21, owner directive): "There should absolutely not be a hot list. It should be an ever living funnel as
// things boil up to fit what we're trying to do ... the one that fits the most is the first one to be there. Work backwards."
//
// Working backwards from the bite: judge/size-ladder.js sizes nothing unless the scenario target sits about
// (roundTrip + stop) x REWARD_RISK_MIN above entry — ~5.5% on this account (1.6% round trip, 0.6% stop, RR 1.5). The wall census
// of 2026-09-21 proved that is where every qualified look died: 71 looks passed every gate in four days, 38 were refused at sizing,
// and the decisive one (ARB, 2026-09-20 16:27) had relative volume 23.6x and buying pressure 0.99 but an ATR of 0.318% — a third
// of one percent against a 1.6% fee. It could not produce the target however violently it moved.
//
// So the funnel is ordered by FITNESS — the window's range as a multiple of that hurdle — not by raw range; and a slot is not a
// place in a queue: the fittest coin alive holds it, and a fitter nominee DISPLACES a weaker incumbent instead of waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankByVolatility, VOLATILITY_WATCH_DEFAULTS } from '../learning/volatility-watch.js';
import { planHotAdoption } from '../tape/hot-lane.js';

const MIN = 60_000; const NOW = Date.UTC(2026, 8, 21, 3, 0, 0);
function coinSeries(prints, { received = NOW } = {}) {
  const rows = prints.map(([ago, px, usd, n = 1]) => ({ c: [Math.floor((NOW - ago * MIN) / MIN) * 60, px, px, px, px, usd / px], n })).sort((a, b) => a.c[0] - b.c[0]);
  return { symbol: 'X', intervalSec: 60, retrievedTsMs: received, candles: rows.map((r) => r.c), trades: rows.map((r) => r.n) };
}
const src = (map) => Object.assign((coin) => map[coin] ?? null, { coins: () => Object.keys(map) });
// a coin that ranges `pct` across the hour on `usdPerMin` dollars a minute, printing every minute
function mover(pct, usdPerMin, { prints = 4 } = {}) {
  const out = []; const lo = 1; const hi = 1 + pct / 100;
  for (let i = 59; i >= 0; i -= 1) out.push([i, i > 30 ? lo : hi, usdPerMin, prints]);
  return coinSeries(out);
}
const pair = (coin, extra = {}) => ({ coin, symbol: `${coin}/USD`, major: false, depth: 25, usdVol24h: 10_000_000, ...extra });
const hot = (coin, sinceMsAgo, extra = {}) => pair(coin, { hot: true, hotSinceTs: NOW - sinceMsAgo, ...extra });

test('FIX98-1: the funnel ranks by FITNESS to the cost hurdle — a coin that cannot clear it is reported under 1.0 however hard it moved', () => {
  const map = {
    RUNNER: mover(11, 4_000),   // 11% in the hour on $240k: two hurdles' worth
    ARBLIKE: mover(0.32, 60_000), // the census coin: a third of a percent on $3.6M — it cannot pay the fee
    MID: mover(5.5, 20_000),     // exactly one hurdle
  };
  const { ranked } = rankByVolatility({ seriesSource: src(map), nowTs: NOW });
  const by = Object.fromEntries(ranked.map((r) => [r.coin, r]));
  assert.equal(VOLATILITY_WATCH_DEFAULTS.hurdlePct, 5.5, 'the hurdle is the account round trip + stop at RR 1.5');
  assert.ok(by.RUNNER, 'the runner is ranked');
  assert.ok(by.RUNNER.fitness > 1.9 && by.RUNNER.fitness < 2.1, `11% / 5.5% ~ 2.0x, got ${by.RUNNER.fitness}`);
  assert.ok(by.MID && Math.abs(by.MID.fitness - 1) < 0.02, `5.5% is exactly 1.0x, got ${by.MID?.fitness}`);
  // ARBLIKE is ranked or filtered as too quiet, but either way it must never read as able to pay
  if (by.ARBLIKE) assert.ok(by.ARBLIKE.fitness < 0.1, `0.32% cannot clear a 5.5% hurdle, got ${by.ARBLIKE.fitness}`);
  assert.equal(ranked[0].coin, 'RUNNER', `the fittest is first: ${JSON.stringify(ranked.map((r) => [r.coin, r.fitness, r.score]))}`);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('FIX98-2: a fitter nominee DISPLACES the weakest incumbent — it does not wait for a slot to age out', () => {
  const carried = [hot('WEAK', 30 * MIN), hot('MIDDLING', 12 * MIN), hot('STRONG', 11 * MIN)];
  const nominations = [
    { coin: 'WEAK', score: 0.9 }, { coin: 'MIDDLING', score: 2.0 }, { coin: 'STRONG', score: 3.0 },
    { coin: 'FITTER', score: 2.5 },
  ];
  const verified = [...carried, pair('FITTER')];
  const plan = planHotAdoption({ nominations, carried, verified, nowTs: NOW, slots: 3, minHoldMs: 10 * MIN });
  assert.deepEqual(plan.adopt.map((p) => p.coin), ['FITTER']);
  assert.deepEqual(plan.evict, ['WEAK/USD'], 'the WEAKEST yields — not the oldest by accident, the weakest by fit');
  const rel = plan.released.find((r) => r.coin === 'WEAK');
  assert.equal(rel.reason, 'DISPLACED_BY_BETTER_FIT'); assert.equal(rel.by, 'FITTER'); assert.equal(rel.wasFit, 0.9); assert.equal(rel.fit, 2.5);
  assert.equal(plan.adopt[0].hotScore, 2.5, 'the pair remembers the fit it entered with');
});

test('FIX98-3: a nominee that fits WORSE than every incumbent does not evict anyone', () => {
  const carried = [hot('A', 30 * MIN), hot('B', 30 * MIN), hot('C', 30 * MIN)];
  const nominations = [{ coin: 'A', score: 3 }, { coin: 'B', score: 4 }, { coin: 'C', score: 5 }, { coin: 'WORSE', score: 1.2 }];
  const plan = planHotAdoption({ nominations, carried, verified: [...carried, pair('WORSE')], nowTs: NOW, slots: 3, minHoldMs: 10 * MIN });
  assert.deepEqual(plan.adopt, []); assert.deepEqual(plan.evict, []);
  assert.deepEqual(plan.skipped, [{ coin: 'WORSE', reason: 'FITS_LESS_THAN_EVERY_INCUMBENT', retry: true }], 'and it is RETRIED — its fit changes minute to minute');
});

test('FIX98-4: with free slots the fittest nominee is adopted FIRST, so the best coin reaches the Judge first', () => {
  const nominations = [{ coin: 'OK', score: 1.1 }, { coin: 'BEST', score: 4.4 }, { coin: 'GOOD', score: 2.2 }];
  const verified = [pair('OK'), pair('BEST'), pair('GOOD')];
  const plan = planHotAdoption({ nominations, carried: [], verified, nowTs: NOW, slots: 2, minHoldMs: 10 * MIN });
  assert.deepEqual(plan.adopt.map((p) => p.coin), ['BEST', 'GOOD'], 'fittest first; the weakest waits and is retried');
  assert.deepEqual(plan.skipped, [{ coin: 'OK', reason: 'HOT_LANE_FULL', retry: true }]);
});

test('FIX98-5: an unscored incumbent is weaker than any scored one — a pair the watch has dropped is the first to go', () => {
  const carried = [hot('SCORED', 30 * MIN), hot('DROPPED_BY_WATCH', 30 * MIN)];
  // DROPPED_BY_WATCH is still nominated by another source (so not released), but carries no fit
  const nominations = [{ coin: 'SCORED', score: 2.0 }, { coin: 'DROPPED_BY_WATCH' }, { coin: 'NEW', score: 1.0 }];
  const plan = planHotAdoption({ nominations, carried, verified: [...carried, pair('NEW')], nowTs: NOW, slots: 2, minHoldMs: 10 * MIN });
  assert.deepEqual(plan.evict, ['DROPPED_BY_WATCH/USD']);
  assert.deepEqual(plan.adopt.map((p) => p.coin), ['NEW']);
});

test('FIX98-6: with no fitness anywhere the PUBLISH-FIX-96 order stands — oldest first, nothing regresses', () => {
  const carried = [hot('OLD', 40 * MIN), hot('NEWER', 20 * MIN)];
  const nominations = [{ coin: 'OLD' }, { coin: 'NEWER' }, { coin: 'X' }];
  const plan = planHotAdoption({ nominations, carried, verified: [...carried, pair('X')], nowTs: NOW, slots: 2, minHoldMs: 10 * MIN });
  assert.deepEqual(plan.evict, ['OLD/USD']); assert.deepEqual(plan.adopt.map((p) => p.coin), ['X']);
});
