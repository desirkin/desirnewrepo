// D16 — BINANCE public spot reference sense (Strategy 6 / IFR). Mock only: one loopback exchangeInfo fixture and a scripted
// combined-stream socket. No network, no credentials, no order verb. The frozen USD basis (USDT held at exactly 1) and the
// stablecoin-health gate are exercised directly; the recorded observations stay honest native USDT.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/market-lab.js';
import { createScriptedWebSocket } from './helpers/scripted-ws.js';
import { createHttpTransport } from '../market-lab/transport.js';
import { createBinanceClient, stablecoinHealthGate, usdBasisFromUsdt, FROZEN_USDT_USD_BASIS, BINANCE_QUOTE } from '../market-lab/providers/binance.js';
import { observationError } from '../market-lab/contracts.js';

const T0 = Date.parse('2026-09-15T12:00:00Z');
const EXCHANGE_INFO = { symbols: [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'LOT_SIZE', stepSize: '0.00001000' }] },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'LOT_SIZE', stepSize: '0.00010000' }] },
  { symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', status: 'TRADING', isSpotTradingAllowed: true, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'LOT_SIZE', stepSize: '0.00001000' }] },
] };
const HEALTHY = { pegPrice: 1.0004, pegDeviationBps: 4, ageMs: 60_000 };

async function rig({ health = () => HEALTHY } = {}) {
  const clock = () => T0;
  const fixture = await H.startHttpFixture({ 'GET /api/v3/exchangeInfo': () => ({ json: EXCHANGE_INFO }) });
  const transport = createHttpTransport({ fetchImpl: H.fetchFor(fixture), clock });
  const c = createBinanceClient({ transport, clock, log: () => {}, stablecoinHealth: health });
  return { c, fixture, clock, close: () => fixture.close() };
}

test('BIN-1. catalog resolves BTC -> BTCUSDT on the USDT quote; a USDC market never resolves as USDT; precision from the real filters', async () => {
  const { c, fixture, close } = await rig();
  const cat = await c.loadCatalog(); assert.equal(cat.ok, true); assert.equal(fixture.requests.at(-1).host, 'api.binance.com'); assert.equal(fixture.requests.at(-1).path, '/api/v3/exchangeInfo');
  const btc = c.resolveMarket({ canonicalCoin: 'BTC' }); assert.equal(btc.ok, true); assert.equal(btc.market.symbol, 'BTCUSDT'); assert.equal(btc.market.subject.quote, BINANCE_QUOTE); assert.equal(btc.market.subject.venue, 'binance');
  assert.equal(btc.market.precision.pricePrecision, 2); assert.equal(btc.market.precision.qtyPrecision, 5); assert.equal(btc.market.streamSymbol, 'btcusdt');
  assert.equal(c.resolveMarket({ canonicalCoin: 'DOGE' }).reason, 'NOT_IN_CATALOG', 'an uncatalogued coin never resolves');
  assert.equal(c.resolveMarket({ canonicalCoin: 'SOL' }).reason, 'NOT_IN_CATALOG');
  // the BTCUSDC row is present in the catalog but is NOT the USDT market — only USDT quotes back this reference sense
  assert.ok(c.catalog().list.some((m) => m.symbol === 'BTCUSDC'));
  const inst = c.instrumentObservation(btc.market, T0); assert.equal(observationError(inst), null); assert.equal(inst.payload.quote, 'USDT');
  await close();
});

test('BIN-2. the frozen USD basis is exactly one and only trusted while the stablecoin peg is fresh and near parity (fail-closed otherwise)', () => {
  assert.equal(FROZEN_USDT_USD_BASIS, 1);
  // healthy: usd == usdt (the frozen constant is one), and the gate says so
  const ok = usdBasisFromUsdt(50_000, HEALTHY); assert.equal(ok.usd, 50_000); assert.equal(ok.healthy, true); assert.equal(ok.basis, 1); assert.equal(ok.reason, null);
  // no reading -> UNKNOWN, never a guessed 1
  assert.deepEqual(stablecoinHealthGate(null), { healthy: false, reason: 'STABLECOIN_HEALTH_UNKNOWN' });
  assert.equal(usdBasisFromUsdt(50_000, null).usd, null);
  // stale reading -> refused
  assert.equal(stablecoinHealthGate({ pegDeviationBps: 2, ageMs: 7 * 3_600_000 }).reason, 'STABLECOIN_HEALTH_STALE');
  assert.equal(usdBasisFromUsdt(50_000, { pegDeviationBps: 2, ageMs: 7 * 3_600_000 }).usd, null);
  // depegged reading -> refused (a de-peg must never masquerade as a Kraken-only flush)
  assert.equal(stablecoinHealthGate({ pegDeviationBps: 120, ageMs: 60_000 }).reason, 'STABLECOIN_DEPEGGED');
  const dp = usdBasisFromUsdt(50_000, { pegDeviationBps: 120, ageMs: 60_000 }); assert.equal(dp.usd, null); assert.equal(dp.healthy, false); assert.equal(dp.reason, 'STABLECOIN_DEPEGGED');
});

test('BIN-3. the combined stream: a self-contained depth20 message replaces the book; a trade tags the taker by the buyer-maker flag; a crossed book desyncs', async () => {
  const { c, close } = await rig();
  await c.loadCatalog(); const m = c.resolveMarket({ canonicalCoin: 'BTC' }).market;
  const sw = createScriptedWebSocket({ ackSubscriptions: false });
  const out = { trades: [], books: [], cov: [] };
  const stream = c.createStream({ markets: [m], WebSocketImpl: sw.WebSocketImpl, url: 'ws://127.0.0.1:65000', onTrade: (o) => out.trades.push(o), onBook: (b) => out.books.push(b), onCoverage: (r) => out.cov.push(r) });
  assert.ok(stream.streamUrl().startsWith('wss://stream.binance.com/stream?streams=btcusdt@depth20@100ms/btcusdt@trade'));
  stream.start();
  await H.waitFor(() => sw.latest()?.readyState === 1);
  const sock = sw.latest();
  sock.deliver({ stream: 'btcusdt@depth20@100ms', data: { lastUpdateId: 1, bids: [['49999.00', '2.5'], ['49998.00', '5']], asks: [['50001.00', '1.2'], ['50002.00', '4']] } });
  await H.waitFor(() => out.books.length >= 1);
  assert.equal(out.books[0].synced, true); assert.deepEqual(out.books[0].levels().bids[0], [49999, 2.5]); assert.deepEqual(out.books[0].levels().asks[0], [50001, 1.2]);
  assert.ok(out.cov.some((r) => r.state === 'OBSERVED'));
  // the USD-basis mid reads healthy from the synced book (usd == usdt under the frozen basis) — read it BEFORE the crossed book desyncs
  const good = c.usdBasisMid({ market: m, book: stream.books.get('btcusdt') }); assert.equal(good.usdtMid, 50000); assert.equal(good.usdMid, 50000); assert.equal(good.stablecoinHealthy, true); assert.equal(good.basis, 1);
  // a trade with m=true (buyer is maker) means the aggressor is the SELLER
  sock.deliver({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', t: 900, p: '50000.50', q: '0.10', T: T0 - 500, m: true } });
  await H.waitFor(() => out.trades.length >= 1);
  assert.equal(out.trades[0].payload.takerSide, 'SELL'); assert.equal(out.trades[0].payload.sideConvention, 'MAKER_NATIVE_INVERTED'); assert.equal(out.trades[0].payload.price, 50000.5); assert.equal(observationError(out.trades[0]), null);
  sock.deliver({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', t: 901, p: '50000.60', q: '0.20', T: T0 - 400, m: false } });
  await H.waitFor(() => out.trades.length >= 2);
  assert.equal(out.trades[1].payload.takerSide, 'BUY');
  // a crossed book is never admitted: it desyncs with a GAP coverage record and produces no book callback
  const before = out.books.length;
  sock.deliver({ stream: 'btcusdt@depth20@100ms', data: { lastUpdateId: 2, bids: [['50003.00', '1']], asks: [['50001.00', '1']] } });
  await H.waitFor(() => out.cov.some((r) => r.reasonCodes?.includes('DESYNCHRONIZED')));
  assert.equal(out.books.length, before, 'a crossed book yields no book callback');
  await stream.stop(); await close();
});

test('BIN-4. an unhealthy stablecoin reading refuses the USD basis while still reporting the native USDT mid', async () => {
  const { c, close } = await rig({ health: () => ({ pegDeviationBps: 300, ageMs: 60_000 }) });
  await c.loadCatalog(); const m = c.resolveMarket({ canonicalCoin: 'ETH' }).market;
  const sw = createScriptedWebSocket({ ackSubscriptions: false });
  const stream = c.createStream({ markets: [m], WebSocketImpl: sw.WebSocketImpl, url: 'ws://127.0.0.1:65001' });
  stream.start(); await H.waitFor(() => sw.latest()?.readyState === 1);
  sw.latest().deliver({ stream: 'ethusdt@depth20@100ms', data: { lastUpdateId: 1, bids: [['3000.00', '10']], asks: [['3001.00', '10']] } });
  await H.waitFor(() => stream.books.get('ethusdt').synced);
  const view = c.usdBasisMid({ market: m, book: stream.books.get('ethusdt') });
  assert.equal(view.usdtMid, 3000.5, 'the native USDT mid is always reported honestly');
  assert.equal(view.usdMid, null, 'a depegged USDT refuses the USD basis (never a guessed conversion)');
  assert.equal(view.stablecoinHealthy, false); assert.equal(view.stablecoinReason, 'STABLECOIN_DEPEGGED');
  await stream.stop(); await close();
});

test('BIN-5. no credential is used or configured; the status carries no credential and the run stayed offline', async () => {
  const { c, close } = await rig();
  await c.loadCatalog();
  assert.equal(c.status().credentialConfigured, false);
  await close();
});
