// C-WIDE drills: universe selection filters and per-pair staleness isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-universe-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { selectFromRaw } = await import('../tape/universe.js');
const { classifyTape } = await import('../tape/health.js');
const { loadConfig } = await import('../lib/config.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const config = loadConfig();
const FLOOR = config.universeExpansion.minUsdVolume24h;

function ticker(usdVol, vwap = 2) {
  return { v: ['0', String(usdVol / vwap)], p: [String(vwap), String(vwap)] };
}

test('universe selection: online USD spot only, stables/fiat out, floor enforced, majors always in', () => {
  const assetPairs = {
    SOLUSD: { wsname: 'SOL/USD', quote: 'ZUSD', status: 'online' }, // major, always in
    LINKUSD: { wsname: 'LINK/USD', quote: 'USD', status: 'online' }, // clears floor -> in
    DUSTUSD: { wsname: 'DUST/USD', quote: 'USD', status: 'online' }, // below floor -> out
    USDTUSD: { wsname: 'USDT/USD', quote: 'ZUSD', status: 'online' }, // stable base -> out
    DAIUSD: { wsname: 'DAI/USD', quote: 'USD', status: 'online' }, // stable base -> out
    EURUSD: { wsname: 'EUR/USD', quote: 'ZUSD', status: 'online' }, // fiat base -> out
    HALTUSD: { wsname: 'HALT/USD', quote: 'USD', status: 'cancel_only' }, // not online -> out
    POSTUSD: { wsname: 'POST/USD', quote: 'USD', status: 'post_only' }, // not online -> out
    LINKEUR: { wsname: 'LINK/EUR', quote: 'ZEUR', status: 'online' }, // not USD-quoted -> out
    'XBTUSD.d': { quote: 'ZUSD', status: 'online' }, // no wsname (dark pool / index) -> out
    NOVOLUSD: { wsname: 'NOVOL/USD', quote: 'USD', status: 'online' }, // no ticker data -> out (no invented volume)
  };
  const tickers = {
    SOLUSD: ticker(FLOOR * 10),
    LINKUSD: ticker(FLOOR * 2),
    DUSTUSD: ticker(FLOOR - 1),
    USDTUSD: ticker(FLOOR * 100),
    DAIUSD: ticker(FLOOR * 50),
    EURUSD: ticker(FLOOR * 100),
    HALTUSD: ticker(FLOOR * 100),
    POSTUSD: ticker(FLOOR * 100),
    LINKEUR: ticker(FLOOR * 100),
  };
  const selected = selectFromRaw(assetPairs, tickers, config);
  const coins = selected.map((p) => p.coin);
  // LINK cleared the floor; the excluded/halted/foreign pairs are out; all
  // five majors ride (SOL from the payload, the rest injected).
  assert.deepEqual(coins.sort(), ['BTC', 'DOGE', 'ETH', 'LINK', 'SOL', 'XRP']);
  assert.ok(!coins.includes('USDT') && !coins.includes('DAI') && !coins.includes('EUR'));
  assert.ok(!coins.includes('DUST') && !coins.includes('HALT') && !coins.includes('POST'));
  const sol = selected.find((p) => p.coin === 'SOL');
  const link = selected.find((p) => p.coin === 'LINK');
  assert.equal(sol.major, true);
  assert.equal(sol.depth, config.universeExpansion.majorsDepth);
  assert.equal(link.major, false);
  assert.equal(link.depth, config.universeExpansion.defaultDepth);
});

test('majors stay in even below the floor or without ticker data (they are the trading universe)', () => {
  const assetPairs = { XBTUSD: { wsname: 'BTC/USD', quote: 'ZUSD', status: 'online' } };
  const selected = selectFromRaw(assetPairs, {}, config);
  assert.deepEqual(selected.map((p) => p.coin).sort(), [...config.universe].sort());
  const btc = selected.find((p) => p.coin === 'BTC');
  assert.equal(btc.usdVol24h, null); // unknown volume stays null, never invented
  assert.ok(selected.every((p) => p.major));
});

test('legacy aliases normalize: XBT->BTC and XDG->DOGE ride as majors on v2 symbols', () => {
  const assetPairs = {
    XXBTZUSD: { wsname: 'XBT/USD', quote: 'ZUSD', status: 'online' },
    XDGUSD: { wsname: 'XDG/USD', quote: 'ZUSD', status: 'online' },
  };
  const selected = selectFromRaw(assetPairs, { XXBTZUSD: ticker(FLOOR * 10), XDGUSD: ticker(FLOOR / 100) }, config);
  const btc = selected.find((p) => p.coin === 'BTC');
  const doge = selected.find((p) => p.coin === 'DOGE');
  assert.equal(btc.symbol, 'BTC/USD'); // v2 symbol, not the legacy wsname
  assert.equal(btc.major, true);
  assert.equal(doge.major, true); // major rides even below the floor
});

test('a major missing from the venue payload entirely is still injected', () => {
  const selected = selectFromRaw({}, {}, config);
  assert.deepEqual(selected.map((p) => p.coin).sort(), [...config.universe].sort());
  assert.ok(selected.every((p) => p.major && p.usdVol24h === null));
});

test('aliased pair keys dedupe to one wsname', () => {
  const assetPairs = {
    XXBTZUSD: { wsname: 'BTC/USD', quote: 'ZUSD', status: 'online' },
    XBTUSD: { wsname: 'BTC/USD', quote: 'ZUSD', status: 'online' },
  };
  const selected = selectFromRaw(assetPairs, { XXBTZUSD: ticker(FLOOR * 10), XBTUSD: ticker(FLOOR * 10) }, config);
  assert.equal(selected.filter((p) => p.symbol === 'BTC/USD').length, 1);
});

test('a stale minor never degrades the tape; a stale major always does', () => {
  const now = 100_000;
  const staleMs = 10_000;
  const pairs = [
    { symbol: 'BTC/USD', major: true },
    { symbol: 'SOL/USD', major: true },
    { symbol: 'PEPE/USD', major: false },
  ];
  const base = { pairs, unavailable: new Set(), lastAnyMsgMs: now - 1000, now, staleMs };

  // quiet minor: stale on its own, tape stays LIVE
  let h = classifyTape({ ...base, lastMsgMs: { 'BTC/USD': now - 500, 'SOL/USD': now - 500, 'PEPE/USD': now - 60_000 } });
  assert.equal(h.state, 'LIVE');
  assert.equal(h.pairStates['PEPE/USD'], 'STALE');
  assert.deepEqual(h.counts, { total: 3, live: 2, stale: 1, unavailable: 0 });

  // stale major: DEGRADED, and named
  h = classifyTape({ ...base, lastMsgMs: { 'BTC/USD': now - 500, 'SOL/USD': now - 60_000, 'PEPE/USD': now - 500 } });
  assert.equal(h.state, 'DEGRADED');
  assert.deepEqual(h.staleMajors, ['SOL/USD']);

  // dead connection: DEGRADED regardless of per-pair stamps
  h = classifyTape({ ...base, lastAnyMsgMs: now - 60_000, lastMsgMs: { 'BTC/USD': now - 500, 'SOL/USD': now - 500, 'PEPE/USD': now - 500 } });
  assert.equal(h.state, 'DEGRADED');
  assert.equal(h.connectionDead, true);

  // unavailable minor (subscribe failed / shed): counted, not degrading
  h = classifyTape({ ...base, unavailable: new Set(['PEPE/USD']), lastMsgMs: { 'BTC/USD': now - 500, 'SOL/USD': now - 500 } });
  assert.equal(h.state, 'LIVE');
  assert.equal(h.pairStates['PEPE/USD'], 'UNAVAILABLE');
  assert.equal(h.counts.unavailable, 1);

  // no data at all yet (fresh boot): not DEGRADED, just not LIVE-with-data
  h = classifyTape({ ...base, lastAnyMsgMs: null, lastMsgMs: {} });
  assert.equal(h.anyData, false);
});
