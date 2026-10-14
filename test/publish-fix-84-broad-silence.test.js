// PUBLISH-FIX-84 (reviewer finding, the owner's "it's not getting data") — the broad 613-pair stream's two ways back from a socket
// that reads OPEN while nothing arrives: (1) the idle watchdog drops the socket without waiting for a close the peer may never
// send; (2) reconnect() is a seam a consumer calls when its DATA has gone silent while the socket reads OPEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWsClient } from '../market-lab/transport.js';

// a fake socket whose close() never completes (a half-open link: CLOSING forever, onclose never fires)
class HalfOpenSocket {
  static instances = [];
  constructor() { this.readyState = 0; HalfOpenSocket.instances.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  send() {}
  close() { this.readyState = 2; this.closed = true; /* never 3, never onclose */ }
}

const untilOpen = async (ws, ms = 200) => { const t0 = Date.now(); while (ws.status().state !== 'OPEN' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 2)); return ws.status().state === 'OPEN'; };

test('FIX84-BS1. the idle watchdog detaches and reconnects on its own; a late close from the old socket is ignored; reconnect() forces the same drop while OPEN; stop() after all that still stops', async () => {
  HalfOpenSocket.instances = []; const opens = []; const closes = []; const logs = [];
  const ws = createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', url: 'ws://127.0.0.1:1/v2', WebSocketImpl: HalfOpenSocket, onMessage: () => {}, onOpen: (o) => opens.push(o.epochId), onClose: (c) => closes.push(c.reason), log: (l) => logs.push(String(l)), idleTimeoutMs: 40, reconnectBaseMs: 5, reconnectMaxMs: 10 });
  try {
    ws.start(); assert.ok(await untilOpen(ws)); assert.equal(opens.length, 1);
    await new Promise((r) => setTimeout(r, 80)); // idle fires at 40 ms; the old socket never completes its close
    assert.ok(HalfOpenSocket.instances[0].closed, 'the idle socket was closed (best effort)');
    assert.ok(closes.includes('IDLE'), `onClose saw the forced drop: ${closes.join(',')}`);
    assert.ok(opens.length >= 2, `a NEW socket opened without waiting for the old close (${opens.length} opens)`);
    assert.ok(ws.status().forcedDrops >= 1);
    assert.equal(HalfOpenSocket.instances[0].onclose, null, 'handlers detached: a late close on the old socket changes nothing');
    // the consumer's seam
    assert.ok(await untilOpen(ws)); const before = opens.length;
    assert.equal(ws.reconnect('DATA_SILENT'), true); assert.ok(await untilOpen(ws));
    assert.ok(closes.includes('DATA_SILENT')); assert.ok(opens.length > before, 'reconnect() opened a fresh socket');
  } finally { const keep = setInterval(() => {}, 20); await ws.stop({ graceMs: 5 }); clearInterval(keep); }
  assert.equal(ws.status().state, 'STOPPED');
  await new Promise((r) => setTimeout(r, 60)); assert.equal(ws.status().state, 'STOPPED', 'a socket opening after stop() never revives the client');
});

// ---- the collector's DATA-SILENCE law: markets subscribed, heartbeats flowing, no ticker or candle for dataSilenceMs -> reconnect
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogContentId } from '../survey/catalog.js';
import { startBroadKraken } from '../market-lab/broad-kraken.js';

const T = Date.UTC(2026, 8, 20, 12, 0, 0);
class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(text) { this.sent.push(JSON.parse(text)); }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 2; this.closed = true; /* a half-open peer: no onclose */ }
}
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const market = (base) => ({ pairKey: `${base}ZUSD`, nativeBase: base, nativeQuote: 'ZUSD', wsname: `${base}/USD`, base, quote: 'USD', status: 'online' });
const catalog = (rows) => { const c = { venue: 'kraken', quote: 'USD', policyVersion: 1, observedTs: T, counts: { observed: rows.length, supported: rows.length, excluded: 0, unresolved: 0 }, markets: rows, excluded: [], unresolved: [], duplicates: [], aliasesApplied: {}, excludeBases: [], responseOrder: rows.map((m) => m.pairKey), source: 'test' }; c.contentId = catalogContentId(c); return c; };
const ack = (socket, request, symbol = null) => socket.emit({ method: 'subscribe', req_id: request.req_id, success: true, result: { channel: request.params.channel, ...(symbol ? { symbol } : {}) } });
const ticker = (symbol) => ({ symbol, ask: 101, ask_qty: null, bid: 99, bid_qty: 2, change: 1, change_pct: 1, high: 105, last: 100, low: 90, volume: 123.5, vwap: 98.2, timestamp: new Date(T).toISOString() });

test('FIX84-BS2. the broad collector reconnects when its DATA goes silent while the socket reads OPEN (heartbeats keep flowing); a fresh socket gets its grace, and it does not fire again inside the silence window', async () => {
  FakeSocket.instances.length = 0; const dir = mkdtempSync(path.join(tmpdir(), 'cobra-broad-silence-')); let now = T; const logs = [];
  const c = catalog([market('AAA'), market('BBB')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, log: (l) => logs.push(String(l)), limits: { subscribeChunkSize: 2, subscribePaceMs: 1, latestSnapshotMs: 1, catalogPollMs: 60_000, dataSilenceMs: 180_000 } });
  try {
    const socket = FakeSocket.instances[0]; assert.ok(socket); socket.open();
    now += 20_000; assert.equal(handle._dataSilenceLaw(now), false, 'twenty seconds after open, nothing subscribed yet: the grace period');
    const instrumentRequest = socket.sent.find((r) => r.params.channel === 'instrument'); ack(socket, instrumentRequest);
    socket.emit({ channel: 'instrument', type: 'snapshot', data: { assets: [], pairs: [{ symbol: 'AAA/USD', base: 'AAA', quote: 'USD', status: 'online' }, { symbol: 'BBB/USD', base: 'BBB', quote: 'USD', status: 'online' }] } });
    await sleep(20);
    const subs = socket.sent.filter((r) => r.method === 'subscribe' && ['ticker', 'ohlc'].includes(r.params.channel)); assert.ok(subs.length >= 2);
    for (const request of subs) for (const symbol of request.params.symbol) ack(socket, request, symbol);
    socket.emit({ channel: 'ticker', type: 'update', data: [ticker('AAA/USD')] }); await sleep(5);
    const dataTs = now;
    now = dataTs + 120_000; socket.emit({ channel: 'heartbeat' }); assert.equal(handle._dataSilenceLaw(now), false, 'two minutes of heartbeats only: not yet');
    now = dataTs + 181_000; socket.emit({ channel: 'heartbeat' });
    assert.equal(handle._dataSilenceLaw(now), true, 'three minutes without a ticker or candle while OPEN: reconnect');
    assert.ok(socket.closed, 'the silent socket was dropped'); assert.equal(socket.onclose, null, 'detached');
    assert.ok(logs.some((l) => l.includes('DATA SILENCE')), logs.filter((l) => /SILENCE|reconnect/i.test(l)).join('\n'));
    assert.equal(handle._dataSilenceLaw(now + 1000), false, 'the socket is in back-off now: nothing to drop');
    assert.equal(handle.status().counters.dataSilentReconnects, 1);
  } finally { const keep = setInterval(() => {}, 20); await handle.stop(); clearInterval(keep); rmSync(dir, { recursive: true, force: true }); }
});
