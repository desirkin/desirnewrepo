// C-WIDE drills: universe selection filters and per-pair staleness isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-universe-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { selectFromRaw, selectUniverse, readCurrentUniverse } = await import('../tape/universe.js');
const { classifyTape } = await import('../tape/health.js');
const { loadConfig } = await import('../lib/config.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const config = loadConfig();
const FLOOR = config.universeExpansion.minUsdVolume24h;

function ticker(usdVol, vwap = 2) {
  return { v: ['0', String(usdVol / vwap)], p: [String(vwap), String(vwap)] };
}

test('universe selection: online USD spot only, stables/fiat out, one floor and depth for every asset', () => {
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
  // Both assets are venue-observed and clear the same floor. Display seeds
  // absent from the venue response cannot be injected into subscriptions.
  assert.deepEqual(coins.sort(), ['LINK', 'SOL']);
  assert.ok(!coins.includes('USDT') && !coins.includes('DAI') && !coins.includes('EUR'));
  assert.ok(!coins.includes('DUST') && !coins.includes('HALT') && !coins.includes('POST'));
  const sol = selected.find((p) => p.coin === 'SOL');
  const link = selected.find((p) => p.coin === 'LINK');
  assert.equal(sol.major, false);
  assert.equal(sol.depth, config.universeExpansion.defaultDepth);
  assert.equal(link.major, false);
  assert.equal(link.depth, config.universeExpansion.defaultDepth);
});

test('named display seeds receive no floor exemption and missing ticker data grants no eligibility', () => {
  const assetPairs = { XBTUSD: { wsname: 'BTC/USD', quote: 'ZUSD', status: 'online' } };
  const selected = selectFromRaw(assetPairs, {}, config);
  assert.deepEqual(selected, []);
  assert.deepEqual(selectFromRaw(assetPairs, { XBTUSD: ticker(FLOOR - 1) }, config), []);
});

test('legacy aliases normalize with the same eligibility rules as every other asset', () => {
  const assetPairs = {
    XXBTZUSD: { wsname: 'XBT/USD', quote: 'ZUSD', status: 'online' },
    XDGUSD: { wsname: 'XDG/USD', quote: 'ZUSD', status: 'online' },
  };
  const selected = selectFromRaw(assetPairs, { XXBTZUSD: ticker(FLOOR * 10), XDGUSD: ticker(FLOOR * 2) }, config);
  const btc = selected.find((p) => p.coin === 'BTC');
  const doge = selected.find((p) => p.coin === 'DOGE');
  assert.equal(btc.symbol, 'BTC/USD'); // v2 symbol, not the legacy wsname
  assert.equal(btc.major, false);
  assert.equal(doge.major, false);
  assert.equal(doge.symbol, 'DOGE/USD');
});

test('empty venue data never fabricates a named-coin universe', () => {
  const selected = selectFromRaw({}, {}, config);
  assert.deepEqual(selected, []);
});

test('renaming display seeds cannot change deep eligibility, and malformed negative volume evidence is refused', () => {
  const raw = { SOLUSD: { wsname: 'SOL/USD', quote: 'USD', status: 'online' }, NEWUSD: { wsname: 'NEW/USD', quote: 'USD', status: 'online' } };
  const ticks = { SOLUSD: ticker(FLOOR * 2), NEWUSD: ticker(FLOOR * 3) };
  assert.deepEqual(selectFromRaw(raw, ticks, config), selectFromRaw(raw, ticks, { ...config, universe: ['NEW'] }));
  assert.deepEqual(selectFromRaw(raw, { SOLUSD: { v: ['0','-10000000'], p: ['-2','-2'] } }, config), []);
  assert.deepEqual(selectFromRaw({ BAD: { wsname: 'SOL/OTHER/USD', quote: 'USD', status: 'online' } }, { BAD: ticker(FLOOR * 3) }, config), []);
});

test('aliased pair keys dedupe to one wsname', () => {
  const assetPairs = {
    XXBTZUSD: { wsname: 'BTC/USD', quote: 'ZUSD', status: 'online' },
    XBTUSD: { wsname: 'BTC/USD', quote: 'ZUSD', status: 'online' },
  };
  const selected = selectFromRaw(assetPairs, { XXBTZUSD: ticker(FLOOR * 10), XBTUSD: ticker(FLOOR * 10) }, config);
  assert.equal(selected.filter((p) => p.symbol === 'BTC/USD').length, 1);
});

test('a failed venue refresh withdraws new admission truth without inventing fallback assets or deleting dated history', async () => {
  const raw = { NEWUSD: { wsname: 'NEW/USD', quote: 'USD', status: 'online' } };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ error: [], result: url.includes('AssetPairs') ? raw : { NEWUSD: ticker(FLOOR * 2) } }) });
  const first = await selectUniverse(config, { fetchImpl });
  assert.deepEqual(first.pairs.map((p) => p.coin), ['NEW']);
  assert.equal(readCurrentUniverse().selectionVersion, first.selectionVersion);
  const failed = await selectUniverse(config, { fetchImpl: async () => { throw new Error('FIXTURE_OFFLINE'); } });
  assert.deepEqual(failed.pairs, []);
  assert.equal(readCurrentUniverse(), null, 'stale current-file nominations do not remain eligible');
  assert.ok(existsSync(path.join(TEST_DATA, 'tape', 'universe', `${first.date}.json`)), 'prior dated evidence is preserved');
});

test('per-asset health is name-blind; stale held/pending exposure or no usable pair degrades overall health', () => {
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

  // A legacy major marker confers no special treatment. Its own data is stale.
  h = classifyTape({ ...base, lastMsgMs: { 'BTC/USD': now - 500, 'SOL/USD': now - 60_000, 'PEPE/USD': now - 500 } });
  assert.equal(h.state, 'LIVE');
  assert.equal(h.pairStates['SOL/USD'], 'STALE');
  assert.deepEqual(h.staleMajors, []);
  for (const symbol of ['SOL/USD','PEPE/USD']) {
    h = classifyTape({ ...base, requiredSymbols: new Set([symbol]), lastMsgMs: { 'BTC/USD': now - 500, [symbol]: now - 60_000 } });
    assert.equal(h.state, 'DEGRADED');
    assert.deepEqual(h.staleRequired, [symbol]);
  }
  h = classifyTape({ ...base, requiredSymbols: new Set(['HELD/USD']), lastMsgMs: { 'BTC/USD': now - 500 } });
  assert.equal(h.state, 'DEGRADED', 'a missing held subscription cannot be hidden');
  assert.deepEqual(h.staleRequired, ['HELD/USD']);
  h = classifyTape({ ...base, lastMsgMs: {} });
  assert.equal(h.state, 'DEGRADED', 'a heartbeat alone is not usable market coverage');

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
