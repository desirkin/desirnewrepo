// MARKET LAB — transport law over a REAL loopback HTTP server and a REAL loopback WebSocket server (A01, A03, A04, A06,
// A12): documented request construction (host, path, method, query, credential placement, redaction), the closed failure
// matrix (401/403/429/5xx, content type, malformed / duplicate-key JSON, oversized body, timeout, redirect refusal,
// cancellation, credential hold), in-flight coalescing with per-consumer cancellation, record / replay identity, and the
// Kraken v2 stream: snapshot / update / checksum mismatch -> resync / crossed book / reconnect epoch / idle gap. No provider
// is reached: the fixture records the intended host and never forwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequest, createHttpTransport, createReplayFetch, serializeExchange, createWsClient, parseRetryAfterMs, backoffMs, CREDENTIAL_HOLD_MS } from '../market-lab/transport.js';
import { createKrakenSpotClient } from '../market-lab/providers/kraken-spot.js';
import { startHttpFixture, startWsFixture, fetchFor, waitFor, clockAt, T0, KRAKEN_ASSET_PAIRS } from './helpers/market-lab.js';

test('A01. planRequest builds the documented request for every credential placement; secrets never enter the redacted url or request key', () => {
  const kr = planRequest({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', query: { pair: 'XXBTZUSD', interval: 1 } });
  assert.equal(kr.ok, true); assert.equal(kr.url, 'https://api.kraken.com/0/public/OHLC?interval=1&pair=XXBTZUSD', 'query keys are canonically sorted so the request key is stable'); assert.equal(kr.method, 'GET');
  const cg = planRequest({ providerId: 'COINGLASS', endpointId: 'coin-vesting', query: { symbol: 'SOL' }, credential: 'SECRET-CG' });
  assert.equal(cg.ok, true); assert.equal(cg.headers['CG-API-KEY'], 'SECRET-CG'); assert.ok(!cg.url.includes('SECRET')); assert.ok(!cg.redactedUrl.includes('SECRET')); assert.ok(!cg.requestKey.includes('SECRET'));
  const gecko = planRequest({ providerId: 'COINGECKO', endpointId: 'coins-list', query: { include_platform: 'true' }, credential: 'DEMO-KEY' });
  assert.equal(gecko.headers['x-cg-demo-api-key'], 'DEMO-KEY');
  const geckoPublic = planRequest({ providerId: 'COINGECKO', endpointId: 'coins-list', query: {}, credential: null });
  assert.equal(geckoPublic.ok, true, 'CoinGecko coins list is reachable keyless (demo key optional)');
  const cq = planRequest({ providerId: 'CRYPTOQUANT', endpointId: 'exchange-flows', pathParams: { asset: 'btc', metric: 'inflow' }, query: { window: 'day' }, credential: 'JWT' });
  assert.equal(cq.headers.authorization, 'Bearer JWT'); assert.equal(cq.url, 'https://api.cryptoquant.com/v1/btc/exchange-flows/inflow?window=day');
  const san = planRequest({ providerId: 'SANTIMENT', endpointId: 'graphql-get-metric', method: 'POST', body: { query: 'q' }, query: {}, credential: 'SAN' });
  assert.equal(san.headers.authorization, 'Apikey SAN'); assert.equal(san.method, 'POST'); assert.equal(typeof san.body, 'string');
  const td = planRequest({ providerId: 'TWELVEDATA', endpointId: 'quote', query: { symbol: 'SPY' }, credential: 'TD' });
  assert.equal(td.headers.authorization, 'apikey TD');
  const tk = planRequest({ providerId: 'TOKENOMIST', endpointId: 'unlock-events', pathParams: { tokenId: 'solana' }, query: { page: 1 }, credential: 'TK' });
  assert.equal(tk.headers['x-api-key'], 'TK'); assert.equal(tk.url, 'https://api.tokenomist.ai/v5/unlock/events/solana?page=1');
  const fred = planRequest({ providerId: 'FRED', endpointId: 'series', query: { series_id: 'CPIAUCSL', file_type: 'json' }, credential: 'FREDKEY' });
  assert.ok(fred.url.includes('api_key=FREDKEY'), 'FRED documents the api_key query parameter'); assert.ok(!fred.redactedUrl.includes('FREDKEY') && !fred.requestKey.includes('FREDKEY'), 'the query credential is redacted from every recorded identity');
  // missing credential on a keyed endpoint is refused BEFORE any dispatch; unknown endpoint / provider likewise
  assert.equal(planRequest({ providerId: 'COINGLASS', endpointId: 'coin-vesting', query: {}, credential: null }).ok, false);
  assert.equal(planRequest({ providerId: 'COINGLASS', endpointId: 'coin-vesting', query: {}, credential: null }).failure.kind, 'CREDENTIAL_MISSING');
  assert.equal(planRequest({ providerId: 'KRAKEN_SPOT', endpointId: 'nope', query: {} }).failure.kind, 'ENDPOINT_UNKNOWN');
  assert.equal(planRequest({ providerId: 'NOPE', endpointId: 'x', query: {} }).ok, false);
  // path params never escape their segment
  assert.throws(() => planRequest({ providerId: 'COINBASE_SPOT', endpointId: 'rest-trades', pathParams: { product_id: '../../admin?x=1' }, query: {} }), /malformed/, 'a hostile path parameter is refused, never interpolated');
});

test('A01/A03. the real HTTP transport over a loopback server: exact host / path / query / headers arrive; 401/403/429/5xx, content type, malformed JSON, duplicate keys, oversized body, timeout, redirect refusal and cancellation are DISTINCT closed failures; a rejected credential is held', async () => {
  const clock = clockAt(T0);
  const fx = await startHttpFixture({
    'GET /0/public/OHLC': { json: { error: [], result: { XXBTZUSD: [], last: 1 } } },
    'GET /api/coin/vesting': (req) => (req.headers['cg-api-key'] === 'GOOD' ? { json: { code: '0', data: {} } } : { status: 401, json: { code: '40001', msg: 'invalid key' } }),
    'GET /0/public/Ticker': { status: 403, body: 'blocked' },
    'GET /0/public/Trades': { status: 429, json: { error: ['rate'] }, headers: { 'retry-after': '7' } },
    'GET /0/public/AssetPairs': { status: 503, body: 'down' },
    'GET /products': { body: '<html>not json</html>', contentType: 'text/html' },
    'GET /products/BTC-USD/trades': { json: '{"a":1,,}' },
    'GET /products/BTC-USD/book': { json: '{"a":1,"a":2}' },
    'GET /products/BTC-USD/candles': { json: JSON.stringify([Array.from({ length: 20000 }, () => [1, 1, 1, 1, 1, 1])]) },
    'GET /derivatives/api/v3/instruments': { delayMs: 400, json: { result: 'success', instruments: [] } },
    'GET /derivatives/api/v3/tickers': { status: 302, headers: { location: 'https://evil.example/steal' }, body: '' },
  });
  try {
    const t = createHttpTransport({ fetchImpl: fetchFor(fx), clock, limits: { httpConcurrencyGlobal: 4, httpConcurrencyPerProvider: 1, httpTimeoutMs: 15_000, transportResponseBytes: 64 * 1024 } });
    const ok = await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', query: { pair: 'XXBTZUSD', interval: 1 } });
    assert.equal(ok.ok, true); assert.equal(ok.status, 200); assert.equal(typeof ok.sha256, 'string'); assert.ok(ok.requestId);
    const sent = fx.requests.at(-1); assert.equal(sent.host, 'api.kraken.com'); assert.equal(sent.path, '/0/public/OHLC'); assert.deepEqual(sent.query, { pair: 'XXBTZUSD', interval: '1' }); assert.equal(sent.method, 'GET');
    const bad = await t.request({ providerId: 'COINGLASS', endpointId: 'coin-vesting', query: { symbol: 'SOL' }, credential: 'BAD' });
    assert.equal(bad.failure.kind, 'HTTP_401'); assert.equal(fx.requests.at(-1).headers['cg-api-key'], 'BAD');
    const held = await t.request({ providerId: 'COINGLASS', endpointId: 'coin-vesting', query: { symbol: 'SOL' }, credential: 'GOOD' });
    assert.equal(held.failure.kind, 'CREDENTIAL_HOLD', 'a rejected credential is not retried automatically (six-hour hold)');
    clock.advance(CREDENTIAL_HOLD_MS + 1);
    const after = await t.request({ providerId: 'COINGLASS', endpointId: 'coin-vesting', query: { symbol: 'SOL' }, credential: 'GOOD' }); assert.equal(after.ok, true);
    assert.equal((await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ticker', query: { pair: 'X' } })).failure.kind, 'HTTP_403');
    const rl = await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-trades', query: { pair: 'X' } }); assert.equal(rl.failure.kind, 'HTTP_429'); assert.equal(rl.failure.retryAfterMs, 7000);
    const backoff = await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', query: { pair: 'XXBTZUSD', interval: 1 } }); assert.equal(backoff.failure.kind, 'BACKOFF_ACTIVE', 'Retry-After is honoured for the whole provider');
    clock.advance(8000);
    assert.equal((await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-asset-pairs', query: {} })).failure.kind, 'HTTP_5XX');
    clock.advance(120_000);
    assert.equal((await t.request({ providerId: 'COINBASE_SPOT', endpointId: 'rest-products', query: {} })).failure.kind, 'CONTENT_TYPE');
    assert.equal((await t.request({ providerId: 'COINBASE_SPOT', endpointId: 'rest-trades', pathParams: { product_id: 'BTC-USD' }, query: {} })).failure.kind, 'JSON_INVALID');
    assert.equal((await t.request({ providerId: 'COINBASE_SPOT', endpointId: 'rest-book', pathParams: { product_id: 'BTC-USD' }, query: {} })).failure.kind, 'JSON_INVALID', 'duplicate keys are a parse failure, never last-wins');
    assert.equal((await t.request({ providerId: 'COINBASE_SPOT', endpointId: 'rest-candles', pathParams: { product_id: 'BTC-USD' }, query: {} })).failure.kind, 'BODY_TOO_LARGE');
    assert.equal((await t.request({ providerId: 'KRAKEN_DERIVATIVES', endpointId: 'rest-instruments', query: {}, timeoutMs: 50 })).failure.kind, 'TIMEOUT');
    assert.equal((await t.request({ providerId: 'KRAKEN_DERIVATIVES', endpointId: 'rest-tickers', query: {} })).failure.kind, 'REDIRECT_REFUSED', 'a redirect to another host is never followed');
    const ac = new AbortController(); ac.abort();
    assert.equal((await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', query: { pair: 'XXBTZUSD', interval: 1 }, signal: ac.signal })).failure.kind, 'CANCELLED');
    const acct = t.accounting(); assert.ok(acct.KRAKEN_SPOT.requests >= 3); assert.ok(acct.COINGLASS.failed >= 1);
    t.stop(); assert.equal((await t.request({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', query: { pair: 'XXBTZUSD', interval: 1 } })).failure.kind, 'STOPPED');
  } finally { await fx.close(); }
});

test('A01/A09. in-flight coalescing shares ONE provider request between consumers; one consumer cancelling does not cancel the other; the recorder captures exact bytes and replay reproduces the identical parsed result without a network', async () => {
  const fx = await startHttpFixture({ 'GET /derivatives/api/v3/instruments': { delayMs: 120, json: { result: 'success', instruments: [{ symbol: 'PF_XBTUSD', type: 'flexible_futures', tradeable: true, contractSize: 1, tickSize: 0.5 }] } } });
  try {
    const exchanges = []; const t = createHttpTransport({ fetchImpl: fetchFor(fx), clock: () => Date.now(), recorder: (x) => exchanges.push(serializeExchange(x)) });
    const a1 = new AbortController();
    const p1 = t.request({ providerId: 'KRAKEN_DERIVATIVES', endpointId: 'rest-instruments', query: {}, signal: a1.signal });
    const p2 = t.request({ providerId: 'KRAKEN_DERIVATIVES', endpointId: 'rest-instruments', query: {} });
    a1.abort();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.failure.kind, 'CANCELLED'); assert.equal(r2.ok, true); assert.equal(fx.requests.length, 1, 'exactly one provider request for two consumers');
    assert.equal(exchanges.length, 1); assert.equal(exchanges[0].status, 200); assert.equal(typeof exchanges[0].bytes, 'string');
    const replay = createHttpTransport({ fetchImpl: createReplayFetch(exchanges), clock: () => Date.now() });
    const r3 = await replay.request({ providerId: 'KRAKEN_DERIVATIVES', endpointId: 'rest-instruments', query: {} });
    assert.equal(r3.ok, true); assert.equal(r3.sha256, r2.sha256, 'replayed bytes are the recorded bytes'); assert.deepEqual(r3.json, r2.json);
    const miss = await replay.request({ providerId: 'KRAKEN_DERIVATIVES', endpointId: 'rest-tickers', query: { symbol: 'PF_XBTUSD' } }); assert.equal(miss.ok, false); assert.equal(miss.failure.kind, 'NETWORK', 'an unrecorded exchange is a failure, never a live fetch');
    assert.equal(fx.requests.length, 1);
  } finally { await fx.close(); }
});

test('A06. Retry-After parsing (seconds and HTTP-date) is clamped; backoff is exponential and bounded', () => {
  assert.equal(parseRetryAfterMs('5', T0), 5000); assert.equal(parseRetryAfterMs('0', T0), 1000); assert.equal(parseRetryAfterMs('999999', T0), 3_600_000);
  assert.equal(parseRetryAfterMs(new Date(T0 + 30_000).toUTCString(), T0), 30_000); assert.equal(parseRetryAfterMs('garbage', T0), null, 'an unparseable header is null, never a guessed delay');
  assert.equal(backoffMs(0), 1000); assert.equal(backoffMs(3), 8000); assert.equal(backoffMs(40), 60_000);
});

// ---- Kraken WS v2 through the real client against the loopback WebSocket server ---------------------------------------------
function krakenFixtureBehaviour(conn, { checksum = null, crossed = false, dropOnFirstUpdate = false } = {}) {
  let subs = 0;
  conn.handlers.push((msg) => {
    if (msg.method !== 'subscribe') return;
    subs += 1;
    if (msg.params.channel === 'instrument') conn.send({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'BTC/USD', price_precision: 1, qty_precision: 8 }] } });
    if (msg.params.channel === 'book') {
      conn.send({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 99.5, qty: 2 }, { price: 99.0, qty: 3 }], asks: [{ price: 100.5, qty: 2 }, { price: 101.0, qty: 3 }] }] });
      setTimeout(() => { if (conn.closed) return; conn.send({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: 'buy', price: 100.5, qty: 0.4, ord_type: 'market', trade_id: 77, timestamp: new Date(T0).toISOString() }] });
        const upd = { symbol: 'BTC/USD', bids: [{ price: 99.6, qty: 1 }], asks: crossed ? [{ price: 99.4, qty: 1 }] : [{ price: 100.6, qty: 1 }] }; if (checksum !== null) upd.checksum = checksum;
        conn.send({ channel: 'book', type: 'update', data: [upd] }); if (dropOnFirstUpdate) conn.destroy(); }, 30);
    }
  });
  return () => subs;
}
test('A04. Kraken v2 stream: subscribe ack -> instrument precision -> book snapshot (OBSERVED coverage) -> trade + update; snapshot trades are never re-emitted; a wrong checksum resyncs (GAP coverage, unsubscribe + subscribe); a crossed book resyncs; a dropped socket reconnects into a NEW epoch; the client refuses a non-registry host', async () => {
  const fx = await startWsFixture({ path: '/v2' });
  const http = await startHttpFixture({ 'GET /0/public/AssetPairs': { json: KRAKEN_ASSET_PAIRS } });
  try {
    const transport = createHttpTransport({ fetchImpl: fetchFor(http), clock: () => Date.now() });
    const client = createKrakenSpotClient({ transport, clock: () => Date.now(), log: () => {} });
    assert.equal((await client.loadCatalog()).ok, true);
    const m = client.resolveMarket({ canonicalCoin: 'BTC' }); assert.equal(m.ok, true); assert.equal(m.market.wsname, 'BTC/USD'); assert.equal(m.market.restWsname, 'XBT/USD');
    // 1. clean session
    const trades = []; const books = []; const cov = []; let mode = { checksum: null };
    fx.connections.length = 0; const behaviours = [];
    const fx2 = await startWsFixture({ path: '/v2', onConnection: (c) => behaviours.push(krakenFixtureBehaviour(c, mode)) });
    const s = client.createStream({ markets: [m.market], depth: 10, WebSocketImpl: globalThis.WebSocket, url: fx2.url, onTrade: (o) => trades.push(o), onBook: (b) => books.push(b), onCoverage: (c) => cov.push(c) });
    s.start();
    await waitFor(() => trades.length >= 1 && books.length >= 2);
    assert.equal(trades[0].kind, 'TRADE'); assert.equal(trades[0].payload.takerSide, 'BUY'); assert.equal(trades[0].payload.sideConvention, 'TAKER_NATIVE'); assert.equal(trades[0].sourceEventTs, T0); assert.ok(trades[0].epochId.startsWith('KRAKEN_SPOT:ws-v2:'));
    assert.equal(cov.some((c) => c.state === 'OBSERVED' && c.kind === 'BOOK_COVERAGE'), true);
    const lv = books.at(-1).levels(); assert.deepEqual(lv.bids[0], [99.6, 1]); assert.equal(books.at(-1).checksumOk, null, 'no checksum in the update: unverified, not verified');
    const sub = fx2.connections[0].received.filter((x) => x.method === 'subscribe'); assert.deepEqual(sub.map((x) => x.params.channel), ['instrument', 'trade', 'book']); assert.equal(sub[1].params.snapshot, false, 'no snapshot trades are requested'); assert.equal(sub[2].params.depth, 10);
    // 2. wrong checksum -> resync: GAP coverage + unsubscribe/subscribe book; the fixture answers with a fresh snapshot
    const before = cov.length; const booksBefore = books.length; mode.checksum = 12345;
    fx2.connections[0].send({ channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: [{ price: 99.7, qty: 1 }], asks: [], checksum: 12345 }] });
    await waitFor(() => cov.slice(before).some((c) => c.state === 'GAP' && c.reasonCodes.includes('DESYNCHRONIZED')));
    await waitFor(() => fx2.connections[0].received.some((x) => x.method === 'unsubscribe' && x.params.channel === 'book'));
    await waitFor(() => books.length > booksBefore, { timeoutMs: 3000 }); assert.ok(s.status().resyncs >= 1);
    // 3. crossed book -> resync
    const c2 = cov.length; fx2.connections[0].send({ channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: [{ price: 200, qty: 1 }], asks: [] }] });
    await waitFor(() => cov.slice(c2).some((c) => c.state === 'GAP')); assert.ok(s.status().resyncs >= 2);
    // 4. dropped socket -> reconnect into a new epoch; stale-epoch coverage closes the old one
    const epoch1 = trades[0].epochId; fx2.connections[0].destroy();
    await waitFor(() => fx2.connections.length >= 2, { timeoutMs: 5000 }); await waitFor(() => trades.some((t) => t.epochId !== epoch1), { timeoutMs: 5000 });
    assert.ok(s.status().reconnects >= 1); assert.notEqual(trades.at(-1).epochId, epoch1);
    await s.stop(); assert.equal(s.status().state, 'STOPPED');
    await fx2.close();
    // 5. host law: only the registry host or a loopback test server
    assert.throws(() => createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', url: 'wss://evil.example/v2', onMessage: () => {} }), /registry host/);
    assert.throws(() => createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: 'rest-ohlc', onMessage: () => {} }), /websocket endpoint/);
  } finally { await fx.close(); await http.close(); }
});

test('A12. importing the transport / registry / policy performs no I/O and constructing a transport opens nothing; a stopped transport refuses; the WebSocket client is idle until start()', async () => {
  const t = createHttpTransport({ fetchImpl: async () => { throw new Error('must not be called'); }, clock: () => T0 });
  assert.deepEqual(Object.keys(t.accounting()), []);
  const ws = createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', url: 'ws://127.0.0.1:1/v2', WebSocketImpl: class { constructor() { throw new Error('must not connect before start'); } }, onMessage: () => {} });
  assert.equal(ws.status().state, 'STOPPED'); await ws.stop();
});
