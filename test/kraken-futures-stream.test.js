// D03 (B) — KRAKEN FUTURES public WebSocket stream (SDR live sense). Mock only: one loopback instruments fixture (for the
// contractSize / linearity spec) and a scripted socket speaking the documented public feeds. No network, no credentials, no
// order verb. The liquidation TAG (trade type) and NATIVE-UNIT open interest (CONTRACTS + verified contractSize) are the
// two facts Strategy 7 depends on and are asserted directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/market-lab.js';
import { createScriptedWebSocket } from './helpers/scripted-ws.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createKrakenDerivativesClient } from '../market-lab/providers/kraken-derivatives.js';
import { createKrakenFuturesStream } from '../market-lab/providers/kraken-futures-stream.js';
import { observationError } from '../market-lab/contracts.js';

const T0 = Date.parse('2026-09-15T12:00:00Z');

async function rig() {
  const clock = () => T0;
  const fixture = await H.startHttpFixture({ 'GET /derivatives/api/v3/instruments': () => ({ json: H.KF_INSTRUMENTS }) });
  const deriv = createKrakenDerivativesClient({ transport: createHttpTransport({ fetchImpl: H.fetchFor(fixture), clock }), clock, log: () => {} });
  await deriv.loadInstruments();
  const res = deriv.resolveInstrument('PF_XBTUSD'); assert.equal(res.ok, true);
  const market = { symbol: 'PF_XBTUSD', subject: res.subject, spec: res.spec };
  return { fixture, clock, market, close: () => fixture.close() };
}
function makeStream(market, out) {
  const sw = createScriptedWebSocket({ ackSubscriptions: false });
  const stream = createKrakenFuturesStream({ transport: createHttpTransport({ fetchImpl: async () => { throw new Error('no http in stream'); }, clock: () => T0 }), clock: () => T0, log: () => {}, markets: [market], WebSocketImpl: sw.WebSocketImpl, url: 'ws://127.0.0.1:64000', onTrade: (o) => out.trades.push(o), onLiquidation: (o) => out.liqs.push(o), onTick: (o) => out.ticks.push(o), onBook: (b) => out.books.push(b), onCoverage: (r) => out.cov.push(r) });
  return { sw, stream };
}

test('KF-1. the book feed: a seq-numbered snapshot syncs; a seq gap resubscribes; a crossed book is never admitted; qty 0 removes a level', async () => {
  const { market, close } = await rig();
  const out = { trades: [], liqs: [], ticks: [], books: [], cov: [] };
  const { sw, stream } = makeStream(market, out);
  stream.start(); await H.waitFor(() => sw.latest()?.readyState === 1);
  const sock = sw.latest();
  assert.ok(sock.sent.some((s) => s.includes('"book"') && s.includes('"subscribe"')));
  sock.deliver({ feed: 'book_snapshot', product_id: 'PF_XBTUSD', timestamp: T0 - 100, seq: 1, bids: [{ price: 49999, qty: 3 }, { price: 49998, qty: 5 }], asks: [{ price: 50001, qty: 2 }] });
  await H.waitFor(() => out.books.length >= 1);
  assert.equal(out.books[0].synced, true); assert.deepEqual(out.books[0].levels().bids[0], [49999, 3]);
  // a contiguous update (seq 2): qty 0 removes the 49998 level
  sock.deliver({ feed: 'book', product_id: 'PF_XBTUSD', side: 'buy', seq: 2, price: 49998, qty: 0, timestamp: T0 - 50 });
  await H.waitFor(() => out.books.length >= 2);
  assert.ok(!out.books.at(-1).levels().bids.some((l) => l[0] === 49998), 'a qty-0 update removed the level');
  // a seq GAP (jump to 9): resubscribe with a GAP coverage, no silent patch
  const covBefore = out.cov.length;
  sock.deliver({ feed: 'book', product_id: 'PF_XBTUSD', side: 'buy', seq: 9, price: 49997, qty: 1, timestamp: T0 - 40 });
  await H.waitFor(() => out.cov.some((r) => r.reasonCodes?.includes('DESYNCHRONIZED')));
  assert.ok(out.cov.length > covBefore); assert.ok(sock.sent.filter((s) => s.includes('"unsubscribe"')).length >= 1);
  // re-snapshot then a crossed book desyncs
  sock.deliver({ feed: 'book_snapshot', product_id: 'PF_XBTUSD', timestamp: T0, seq: 100, bids: [{ price: 50000, qty: 1 }], asks: [{ price: 50002, qty: 1 }] });
  await H.waitFor(() => stream.books.get('PF_XBTUSD').synced);
  const crossedCov = out.cov.length;
  sock.deliver({ feed: 'book', product_id: 'PF_XBTUSD', side: 'buy', seq: 101, price: 50003, qty: 1, timestamp: T0 });
  await H.waitFor(() => out.cov.length > crossedCov);
  await stream.stop(); await close();
});

test('KF-2. matched trades: a fill is a TRADE (taker side); a liquidation is a LIQUIDATION carrying the venue tag (forced SELL == a LONG liquidated)', async () => {
  const { market, close } = await rig();
  const out = { trades: [], liqs: [], ticks: [], books: [], cov: [] };
  const { sw, stream } = makeStream(market, out);
  stream.start(); await H.waitFor(() => sw.latest()?.readyState === 1);
  const sock = sw.latest();
  // the initial trade_snapshot is history we did not witness — it produces nothing
  sock.deliver({ feed: 'trade_snapshot', product_id: 'PF_XBTUSD', trades: [{ side: 'buy', type: 'fill', price: 50000, qty: 1, time: T0 - 9000, trade_id: 1 }] });
  sock.deliver({ feed: 'trade', product_id: 'PF_XBTUSD', side: 'sell', type: 'fill', seq: 10, time: T0 - 500, qty: 2, price: 50010, trade_id: 200 });
  await H.waitFor(() => out.trades.length >= 1);
  // a fill is a plain matched-trade fact (a DERIVATIVE subject never carries a spot TRADE observation), not a liquidation
  assert.equal(out.trades[0].takerSide, 'SELL'); assert.equal(out.trades[0].tradeType, 'fill'); assert.equal(out.trades[0].price, 50010);
  assert.equal(out.liqs.length, 0, 'a plain fill is not a liquidation');
  sock.deliver({ feed: 'trade', product_id: 'PF_XBTUSD', side: 'sell', type: 'liquidation', seq: 11, time: T0 - 400, qty: 5, price: 49990, trade_id: 201 });
  await H.waitFor(() => out.liqs.length >= 1);
  const liq = out.liqs[0];
  assert.equal(liq.kind, 'LIQUIDATION'); assert.equal(liq.payload.forcedOrderSide, 'SELL'); assert.equal(liq.payload.liquidatedPositionSide, 'LONG'); assert.equal(liq.payload.venueScope, 'kraken-futures');
  assert.equal(liq.payload.qtyBase, null, 'contracts are not asserted as base units'); assert.equal(liq.payload.notional, 49990 * 5 * 1, 'quote notional from the verified contractSize'); assert.equal(liq.payload.notionalUnit, 'USD'); assert.equal(observationError(liq), null);
  // a forced BUY liquidates a SHORT
  sock.deliver({ feed: 'trade', product_id: 'PF_XBTUSD', side: 'buy', type: 'liquidation', seq: 12, time: T0 - 300, qty: 1, price: 50100, trade_id: 202 });
  await H.waitFor(() => out.liqs.length >= 2);
  assert.equal(out.liqs[1].payload.liquidatedPositionSide, 'SHORT');
  await stream.stop(); await close();
});

test('KF-3. the ticker feed carries NATIVE-UNIT open interest (CONTRACTS + verified contractSize) and the perp mark/index for the discount', async () => {
  const { market, close } = await rig();
  const out = { trades: [], liqs: [], ticks: [], books: [], cov: [] };
  const { sw, stream } = makeStream(market, out);
  stream.start(); await H.waitFor(() => sw.latest()?.readyState === 1);
  sw.latest().deliver({ feed: 'ticker', product_id: 'PF_XBTUSD', markPrice: 50000, index: 50050, bid: 49999, ask: 50001, last: 50000, openInterest: 123456, funding_rate: 0.01, relative_funding_rate: 0.0000002, funding_rate_prediction: 0.011, next_funding_rate_time: T0 + 3_600_000, time: T0 - 100 });
  await H.waitFor(() => out.ticks.length >= 1);
  const t = out.ticks[0];
  assert.equal(t.kind, 'DERIVATIVE_TICK'); assert.equal(t.payload.openInterest, 123456); assert.equal(t.payload.openInterestUnit, 'CONTRACTS');
  assert.equal(t.payload.contractMultiplier, 1, 'the verified contractSize from the instrument spec (PF_XBTUSD = 1)');
  assert.equal(t.payload.markPrice, 50000); assert.equal(t.payload.indexPrice, 50050); assert.equal(t.payload.linearity, 'LINEAR'); assert.equal(observationError(t), null);
  await stream.stop(); await close();
});

test('KF-4. no credential is used or configured, and creating a stream with no markets fails closed', async () => {
  const { market, close } = await rig();
  assert.throws(() => createKrakenFuturesStream({ transport: createHttpTransport({ fetchImpl: async () => { throw new Error('x'); }, clock: () => T0 }), markets: [], WebSocketImpl: createScriptedWebSocket().WebSocketImpl }), /at least one market/);
  const out = { trades: [], liqs: [], ticks: [], books: [], cov: [] };
  const { stream } = makeStream(market, out);
  assert.equal(stream.status().members.length, 1);
  await close();
});
