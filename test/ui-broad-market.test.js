import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { catalogContentId } from '../survey/catalog.js';
import { startBroadKraken } from '../market-lab/broad-kraken.js';

const root = mkdtempSync(path.join(tmpdir(), 'cobra-ui-broad-'));
process.env.COBRA_DATA_DIR = root;
process.env.PORT = '0';
process.env.SERPENT_DATA_ONLY = 'true';
for (const key of ['DATABASE_URL', 'REPLIT_DEPLOYMENT', 'SERPENT_DURABLE_REQUIRED', 'SERPENT_CONTROL_PASSWORD']) delete process.env[key];
const { server } = await import('../ui/server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const tree = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? tree(full) : [[path.relative(root, full), readFileSync(full).toString('base64')]];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

test('broad-market endpoint is read-only, uncached, and never invents a three-coin fallback', async () => {
  const before = tree(root);
  const response = await fetch(`${base}/api/market-broad?path=../../outside`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.equal(value.authority, 'NONE');
  assert.notEqual(value.available, true);
  assert.equal(Object.hasOwn(value, 'records'), false, 'the endpoint must not duplicate its full per-market record payload');
  assert.doesNotMatch(JSON.stringify(value), /\b(?:BTC|ETH|SOL)\b/);
  assert.deepEqual(tree(root), before, 'GET must not start a collector or create files');
});

test('broad-market read route rejects every mutation method', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${base}/api/market-broad`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET');
  }
});

test('broad-market endpoint serves an actually persisted non-major candle and volume without claiming a live runtime', async () => {
  const now = Date.now();
  const catalog = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: now,
    markets: [{ pairKey: 'DOGEUSD', nativeBase: 'XDG', nativeQuote: 'ZUSD', wsname: 'XDG/USD', base: 'DOGE', quote: 'USD', status: 'online' }] };
  catalog.contentId = catalogContentId(catalog);
  let socket;
  class FakeSocket {
    constructor() { this.readyState = 0; this.sent = []; socket = this; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog, fresh: true }) }, dataDir: root,
    WebSocketImpl: FakeSocket, clock: () => now, limits: { subscribePaceMs: 1, latestSnapshotMs: 1 } });
  try {
    socket.readyState = 1; socket.onopen();
    const instrument = socket.sent[0];
    socket.emit({ method: 'subscribe', req_id: instrument.req_id, success: true, result: { channel: 'instrument' } });
    socket.emit({ channel: 'instrument', type: 'snapshot', data: { pairs: [{ symbol: 'DOGE/USD', base: 'DOGE', quote: 'USD', status: 'online' }] } });
    for (let tries = 0; socket.sent.length < 3 && tries < 100; tries += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(socket.sent.length, 3);
    for (const request of socket.sent.slice(1)) socket.emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: request.params.channel, symbol: 'DOGE/USD' } });
    socket.emit({ channel: 'ticker', type: 'update', data: [{ symbol: 'DOGE/USD', last: 0.2, volume: 12345, vwap: 0.19, timestamp: new Date(now).toISOString() }] });
    socket.emit({ channel: 'ohlc', type: 'update', data: [{ symbol: 'DOGE/USD', interval: 1, interval_begin: new Date(Math.floor(now / 60000) * 60000).toISOString(), open: 0.19, high: 0.21, low: 0.18, close: 0.2, volume: 123, trades: 3, vwap: 0.195 }] });
    await handle.drain();
    const before = tree(root);
    const response = await fetch(`${base}/api/market-broad`);
    const value = await response.json();
    assert.equal(response.status, 200);
    assert.equal(value.available, true);
    assert.equal(value.runtimeRunning, false, 'the test never starts the trading or data-only composition');
    assert.equal(value.authority, 'NONE');
    assert.equal(value.markets.length, 1);
    assert.equal(value.markets[0].canonicalCoin, 'DOGE');
    assert.equal(value.markets[0].ticker.record.payload.volume24hBase, 12345);
    assert.equal(value.markets[0].candle.provisional.payload.volumeBase, 123);
    assert.equal(value.markets[0].candle.provisional.payload.close, 0.2);
    assert.equal(Object.hasOwn(value, 'records'), false);
    assert.deepEqual(tree(root), before);
  } finally { await handle.stop(); }
});
