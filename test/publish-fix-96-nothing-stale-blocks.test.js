// PUBLISH-FIX-96 (2026-09-21, owner directive: "Nothing should be blocking. Nothing stale should just sit there blocking").
//
// The hot lane is the six deep-tape slots that carry a coin's live order book to the Judge. Three rules in it held a slot against
// a coin that had stopped earning it, or refused a coin for ever on one bad look:
//   1. A hot pair was evicted ONLY to make room for a new nominee. With nothing new arriving, a coin whose run ended an hour ago
//      kept its slot — and its share of a main thread already at 88-91% — for ever.
//   2. `tenureMs` was a TWO-HOUR FLOOR: even with a fresh runner waiting, the stale pair held the slot until two hours were up.
//   3. NOT_VERIFIED_BY_VENUE_SELECTION was remembered in `seen`, so a coin refused once by the venue check was never looked at
//      again that session. A runner's 24-hour volume BUILDS WHILE IT RUNS: under the floor at 03:00 and well over it at 10:00 is
//      the normal shape of the thing we are hunting. That refusal is about right now, never about the rest of the day.
// Held or pending exposure (pinned) is never evicted. Authority NONE: this is which coins are WATCHED, never what may be traded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planHotAdoption, HOT_LANE_DEFAULTS } from '../tape/hot-lane.js';

const T = 1_789_000_000_000; const MIN = 60_000; const H = 60 * MIN;
const pair = (coin, extra = {}) => ({ coin, symbol: `${coin}/USD`, major: false, depth: 25, usdVol24h: 10_000_000, ...extra });
const hot = (coin, sinceMsAgo) => pair(coin, { hot: true, hotSinceTs: T - sinceMsAgo });

test('FIX96-1: a hot pair that is no longer among the movers yields its slot even though NOTHING is waiting for it', () => {
  // DEAD ran an hour ago and has fallen out of the watch's picks; LIVE is still nominated. No new nominee at all.
  const carried = [pair('BTC'), hot('DEAD', 40 * MIN), hot('LIVE', 40 * MIN)];
  const plan = planHotAdoption({ nominations: [{ coin: 'LIVE' }], carried, verified: carried, nowTs: T, slots: 6 });
  assert.deepEqual(plan.evict, ['DEAD/USD'], 'the slot is released the moment it stops being earned (before the fix: held for ever)');
  assert.deepEqual(plan.released, [{ coin: 'DEAD', symbol: 'DEAD/USD', reason: 'NO_LONGER_NOMINATED', heldMs: 40 * MIN }]);
  assert.deepEqual(plan.adopt, [], 'nothing was waiting — the release is the whole point');
  assert.equal(plan.seen.has('DEAD'), false, 'and it leaves `seen`, so it can come back the moment it runs again');
});

test('FIX96-2: the thrash guard is minutes, not a two-hour lease — a stale pair inside the guard is kept, past it it goes', () => {
  const carried = [hot('FRESH', 3 * MIN), hot('STALE', 12 * MIN)];
  const none = planHotAdoption({ nominations: [], carried, verified: carried, nowTs: T, slots: 6, minHoldMs: 10 * MIN });
  assert.deepEqual(none.evict, ['STALE/USD'], 'past the guard it yields; the three-minute-old pair is protected from churn');
  // and with a runner waiting, the lane full, the oldest yields at the guard — not after two hours
  const full = [hot('A', 30 * MIN), hot('B', 25 * MIN), hot('C', 20 * MIN)];
  const alive = [{ coin: 'A' }, { coin: 'B' }, { coin: 'C' }];
  const verified = [...full, pair('RUNNER')];
  const plan = planHotAdoption({ nominations: [...alive, { coin: 'RUNNER' }], carried: full, verified, nowTs: T, slots: 3, minHoldMs: 10 * MIN });
  assert.deepEqual(plan.evict, ['A/USD'], 'the oldest yields after the guard (before the fix: nothing moved for two hours)');
  assert.deepEqual(plan.adopt.map((p) => p.coin), ['RUNNER']);
  // the old law, expressed as the guard it used to be, still refuses — this is the exact behaviour that blocked the runners
  const oldLaw = planHotAdoption({ nominations: [...alive, { coin: 'RUNNER' }], carried: full, verified, nowTs: T, slots: 3, minHoldMs: 2 * H });
  assert.deepEqual(oldLaw.adopt, []); assert.deepEqual(oldLaw.skipped, [{ coin: 'RUNNER', reason: 'HOT_LANE_FULL', retry: true }]);
});

test('FIX96-3: a coin refused by the venue check is looked at again — its volume builds while it runs', () => {
  // 03:00 — CTSI has done $40k today and is under the $100k nomination floor: the venue selection does not verify it
  const carried = [pair('BTC')];
  const early = planHotAdoption({ nominations: [{ coin: 'CTSI' }], carried, verified: [pair('BTC')], nowTs: T, slots: 6 });
  assert.deepEqual(early.adopt, []);
  assert.deepEqual(early.skipped, [{ coin: 'CTSI', reason: 'NOT_VERIFIED_BY_VENUE_SELECTION', retry: true }]);
  assert.equal(early.seen.has('CTSI'), false, 'the refusal is NOT remembered (before the fix: never looked at again all session)');
  // 10:00 — the same coin has run 22% and now does $192k a day, so the venue verifies it. It must be adoptable.
  const later = planHotAdoption({ nominations: [{ coin: 'CTSI' }], carried, verified: [pair('BTC'), pair('CTSI', { usdVol24h: 192_000 })], seen: early.seen, nowTs: T + 7 * H, slots: 6 });
  assert.deepEqual(later.adopt.map((p) => p.coin), ['CTSI'], 'the runner gets in');
  assert.equal(later.adopt[0].hot, true);
});

test('FIX96-4: held or pending exposure is never released, however stale it looks', () => {
  const carried = [hot('HELD', 3 * H), hot('DEAD', 3 * H)];
  const plan = planHotAdoption({ nominations: [], carried, verified: carried, pinned: new Set(['HELD/USD']), nowTs: T, slots: 6 });
  assert.deepEqual(plan.evict, ['DEAD/USD'], 'the unheld stale pair goes');
  assert.ok(!plan.evict.includes('HELD/USD'), 'the pair carrying exposure stays, whatever the watch thinks of it');
});

test('FIX96-5: the shipped law — a thrash guard in minutes, and the config carries it', async () => {
  assert.deepEqual(HOT_LANE_DEFAULTS, { slots: 3, minHoldMs: 10 * MIN });
  assert.equal('tenureMs' in HOT_LANE_DEFAULTS, false, 'the two-hour lease is gone, not renamed');
  const { loadConfig } = await import('../lib/config.js');
  assert.deepEqual(loadConfig().universeExpansion.hotLane, { slots: 20, minHoldMs: 10 * MIN }); // PUBLISH-FIX-99: the order-book stage widened 6 -> 20 on measured headroom (event-loop utilisation 88-91% -> 56-61% after FIX-97); the Judge still prepares six, now the best six OF TWENTY
});
