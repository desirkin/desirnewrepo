// D17 — BITSTAMP public spot reference sense (Strategy 6 / IFR fallback). Mock only: one loopback trading-pairs-info fixture
// and a scripted order_book. No network, no credentials, no order verb. Bitstamp quotes USD directly, so the book mid is a
// clean USD basis with no stablecoin gate; the point of this sense is to be the reachable reference when Binance answers 451.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/market-lab.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createBitstampClient, BITSTAMP_VENUE, BITSTAMP_USD_ALIAS_GROUP } from '../market-lab/providers/bitstamp.js';
import { observationError } from '../market-lab/contracts.js';

const T0 = Date.parse('2026-09-15T12:00:00Z');
const PAIRS = [
  { name: 'BTC/USD', url_symbol: 'btcusd', base_decimals: 8, counter_decimals: 2, trading: 'Enabled', minimum_order: '10.0 USD', description: 'Bitcoin / U.S. dollar' },
  { name: 'ETH/USD', url_symbol: 'ethusd', base_decimals: 8, counter_decimals: 2, trading: 'Enabled', minimum_order: '10.0 USD', description: 'Ether / U.S. dollar' },
  { name: 'XRP/EUR', url_symbol: 'xrpeur', base_decimals: 8, counter_decimals: 5, trading: 'Enabled', minimum_order: '10.0 EUR', description: 'XRP / Euro' },
  { name: 'DOGE/USD', url_symbol: 'dogeusd', base_decimals: 5, counter_decimals: 5, trading: 'Disabled', minimum_order: '10.0 USD', description: 'Dogecoin / U.S. dollar' },
];
const BOOK = { timestamp: String(Math.floor(T0 / 1000)), microtimestamp: String(T0 * 1000), bids: [['99.50', '2'], ['99.00', '3'], ['0', '5']], asks: [['100.50', '2'], ['101.00', '3']] };

async function rig({ bookRoute } = {}) {
  const clock = () => T0;
  const routes = {
    'GET /api/v2/trading-pairs-info/': () => ({ json: PAIRS }),
    'GET /api/v2/order_book/btcusd/': bookRoute ?? (() => ({ json: BOOK })),
  };
  const fixture = await H.startHttpFixture(routes);
  const transport = createHttpTransport({ fetchImpl: H.fetchFor(fixture), clock });
  const c = createBitstampClient({ transport, clock, log: () => {} });
  return { c, fixture, clock, close: () => fixture.close() };
}

test('BST-1. the trading-pairs catalog resolves BTC -> btcusd on the USD quote (disabled + non-USD rows never resolve as USD); precision from the real decimals', async () => {
  const { c, fixture, close } = await rig();
  const cat = await c.loadProducts(); assert.equal(cat.ok, true); assert.equal(fixture.requests.at(-1).host, 'www.bitstamp.net'); assert.equal(fixture.requests.at(-1).path, '/api/v2/trading-pairs-info/');
  const btc = c.resolveProduct({ canonicalCoin: 'BTC' }); assert.equal(btc.ok, true); assert.equal(btc.market.urlSymbol, 'btcusd'); assert.equal(btc.market.subject.venue, BITSTAMP_VENUE); assert.equal(btc.market.subject.quote, 'USD'); assert.equal(btc.market.subject.quoteAliasGroup, BITSTAMP_USD_ALIAS_GROUP);
  assert.equal(btc.market.precision.pricePrecision, 2); assert.equal(btc.market.precision.qtyPrecision, 8);
  assert.equal(c.resolveProduct({ canonicalCoin: 'DOGE' }).reason, 'NOT_IN_CATALOG', 'a Disabled pair never resolves');
  assert.equal(c.resolveProduct({ canonicalCoin: 'SOL' }).reason, 'NOT_IN_CATALOG');
  const inst = c.instrumentObservation(btc.market, T0); assert.equal(observationError(inst), null); assert.equal(inst.payload.quote, 'USD'); assert.equal(inst.payload.contractSize, null);
  await close();
});

test('BST-2. the order book is a USD-native L2 snapshot: non-positive / malformed levels are dropped, and the size-aware executable bid walks the bid side for the requested notional', async () => {
  const { c, close } = await rig();
  await c.loadProducts(); const btc = c.resolveProduct({ canonicalCoin: 'BTC' }).market;
  const r = await c.book({ market: btc }); assert.equal(r.ok, true); assert.equal(observationError(r.observations[0]), null);
  const ob = r.observations[0]; assert.deepEqual(ob.payload.bids, [[99.5, 2], [99, 3]], 'the zero-price bid level is dropped'); assert.deepEqual(ob.payload.asks, [[100.5, 2], [101, 3]]);
  assert.equal(ob.payload.synchronized, true); assert.equal(ob.subject.quote, 'USD');
  // executable bid: $150 fills entirely at the top level (99.5 * 2 = 199 >= 150) -> the top price; a larger size walks deeper
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 150 }), 99.5);
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 250 }), 99, 'a size that exhausts the top level takes the next price');
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 999999 }), 99, 'a size past the whole book returns the deepest touched price, never a fabricated deeper fill');
  assert.equal(c.executableBid({ observation: ob, quoteNotional: 0 }), null);
  await close();
});

test('BST-3. an HTTP 451 (Unavailable For Legal Reasons) is classified GEO / ACCESS_BLOCKED and the client latches BLOCKED — reported honestly, never evaded, even for the normally-reachable Bitstamp', async () => {
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
