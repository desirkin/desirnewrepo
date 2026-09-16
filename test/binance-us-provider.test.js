// D18 — BINANCE.US public spot reference sense (Strategy 6 / IFR third USD-direct reference). Mock only: one loopback
// exchangeInfo fixture and a scripted depth snapshot. No network, no credentials, no order verb. Binance.US quotes USD
// directly (BTCUSD), so the book mid is a clean USD basis with no stablecoin gate; the point of this sense is to be a
// reachable USD reference alongside Coinbase and Bitstamp (api.binance.us answers where api.binance.com returns 451).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/market-lab.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createBinanceUsClient, BINANCE_US_VENUE, BINANCE_US_USD_ALIAS_GROUP } from '../market-lab/providers/binance-us.js';
import { observationError } from '../market-lab/contracts.js';

const T0 = Date.parse('2026-09-16T12:00:00Z');
const priceFilter = (tick) => ({ filterType: 'PRICE_FILTER', tickSize: tick });
const lotFilter = (step) => ({ filterType: 'LOT_SIZE', stepSize: step });
const EXCHANGE_INFO = {
  timezone: 'UTC', serverTime: T0,
  symbols: [
    { symbol: 'BTCUSD', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USD', isSpotTradingAllowed: true, filters: [priceFilter('0.01'), lotFilter('0.00000001')] },
    { symbol: 'ETHUSD', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USD', isSpotTradingAllowed: true, filters: [priceFilter('0.01'), lotFilter('0.0001')] },
    { symbol: 'XRPUSDT', status: 'TRADING', baseAsset: 'XRP', quoteAsset: 'USDT', isSpotTradingAllowed: true, filters: [priceFilter('0.0001'), lotFilter('1')] },
    { symbol: 'DOGEUSD', status: 'BREAK', baseAsset: 'DOGE', quoteAsset: 'USD', isSpotTradingAllowed: false, filters: [priceFilter('0.00001'), lotFilter('1')] },
  ],
};
const BOOK = { lastUpdateId: 4587480734, bids: [['99.50', '2'], ['99.00', '3'], ['0', '5']], asks: [['100.50', '2'], ['101.00', '3']] };

async function rig({ bookRoute } = {}) {
  const clock = () => T0;
  const routes = {
    'GET /api/v3/exchangeInfo': () => ({ json: EXCHANGE_INFO }),
    'GET /api/v3/depth': bookRoute ?? (() => ({ json: BOOK })),
  };
  const fixture = await H.startHttpFixture(routes);
  const transport = createHttpTransport({ fetchImpl: H.fetchFor(fixture), clock });
  const c = createBinanceUsClient({ transport, clock, log: () => {} });
  return { c, fixture, clock, close: () => fixture.close() };
}

test('BUS-1. exchangeInfo resolves BTC -> BTCUSD on the USD quote (a USDT-quoted or non-TRADING row never resolves as USD); precision from the real filter increments', async () => {
  const { c, fixture, close } = await rig();
  const cat = await c.loadProducts(); assert.equal(cat.ok, true); assert.equal(fixture.requests.at(-1).host, 'api.binance.us'); assert.equal(fixture.requests.at(-1).path, '/api/v3/exchangeInfo');
  const btc = c.resolveProduct({ canonicalCoin: 'BTC' }); assert.equal(btc.ok, true); assert.equal(btc.market.symbol, 'BTCUSD'); assert.equal(btc.market.subject.venue, BINANCE_US_VENUE); assert.equal(btc.market.subject.quote, 'USD'); assert.equal(btc.market.subject.quoteAliasGroup, BINANCE_US_USD_ALIAS_GROUP);
  assert.equal(btc.market.precision.pricePrecision, 2); assert.equal(btc.market.precision.qtyPrecision, 8);
  assert.equal(c.resolveProduct({ canonicalCoin: 'XRP' }).reason, 'NOT_IN_CATALOG', 'a USDT-only pair never resolves on the USD quote');
  assert.equal(c.resolveProduct({ canonicalCoin: 'DOGE' }).reason, 'NOT_IN_CATALOG', 'a non-TRADING pair never resolves');
  assert.equal(c.resolveProduct({ canonicalCoin: 'SOL' }).reason, 'NOT_IN_CATALOG');
  const inst = c.instrumentObservation(btc.market, T0); assert.equal(observationError(inst), null); assert.equal(inst.payload.quote, 'USD'); assert.equal(inst.payload.contractSize, null);
  await close();
});

test('BUS-2. the depth book is a USD-native L2 snapshot carried on ?symbol&limit: non-positive levels are dropped, no fabricated event clock, and the size-aware executable bid walks the bid side for the requested notional', async () => {
  const { c, fixture, close } = await rig();
  await c.loadProducts(); const btc = c.resolveProduct({ canonicalCoin: 'BTC' }).market;
  const r = await c.book({ market: btc }); assert.equal(r.ok, true); assert.equal(observationError(r.observations[0]), null);
  const depthReq = fixture.requests.at(-1); assert.equal(depthReq.path, '/api/v3/depth'); assert.equal(depthReq.query.symbol, 'BTCUSD'); assert.equal(depthReq.query.limit, '200');
  const ob = r.observations[0]; assert.deepEqual(ob.payload.bids, [[99.5, 2], [99, 3]], 'the zero-price bid level is dropped'); assert.deepEqual(ob.payload.asks, [[100.5, 2], [101, 3]]);
  assert.equal(ob.payload.synchronized, true); assert.equal(ob.subject.quote, 'USD'); assert.equal(ob.sourceEventTs, null, 'a REST depth snapshot carries no fabricated event clock');
  // executable bid: $150 fills entirely at the top level (99.5 * 2 = 199 >= 150) -> the top price; a larger size walks deeper
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 150 }), 99.5);
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 250 }), 99, 'a size that exhausts the top level takes the next price');
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 999999 }), 99, 'a size past the whole book returns the deepest touched price, never a fabricated deeper fill');
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 0 }), null);
  await close();
});

test('BUS-3. an HTTP 451 (Unavailable For Legal Reasons) is classified GEO / ACCESS_BLOCKED and the client latches BLOCKED — reported honestly, never evaded', async () => {
  const { c, close } = await rig({ bookRoute: () => ({ status: 451, json: { error: 'Unavailable for legal reasons' } }) });
  await c.loadProducts(); const btc = c.resolveProduct({ canonicalCoin: 'BTC' }).market;
  const r = await c.book({ market: btc });
  assert.equal(r.ok, false);
  assert.equal(r.failure.coverageState, 'ACCESS_BLOCKED', '451 maps to ACCESS_BLOCKED');
  assert.equal(r.failure.reasonCode, 'GEO_RESTRICTED', '451 is a geographic/legal block');
  assert.equal(r.coverage[0].state, 'ACCESS_BLOCKED');
  assert.equal(c.status().runtime, 'BLOCKED', 'the client latches BLOCKED on a geo denial');
  await close();
});
