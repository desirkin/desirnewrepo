// PUBLISH-FIX-126 — the blind eye. Oct 12 05:43 and Oct 13 10:31 ET: Kraken dropped the socket, the client reconnected, the markets
// never came back on the new socket (instrument snapshot / subscribe acks lost), and the DATA-SILENCE law stood down because nothing
// was subscribed. The broad eye stayed blind through a whole day shift with no log line. Two laws close it:
//   1. the collector's silence law fires on a socket that has been OPEN for dataSilenceMs with no ticker or candle, whatever the
//      subscription count, says so, and keeps firing every dataSilenceMs until data flows;
//   2. the transport cuts a connect attempt that never completes (no onopen, no onclose) after connectTimeoutMs and backs off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { catalogContentId } from '../survey/catalog.js';
import { startBroadKraken } from '../market-lab/broad-kraken.js';
import { createWsClient } from '../market-lab/transport.js';

const T = Date.UTC(2026, 9, 13, 14, 31, 0);
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

test('FIX126-1. a reopened socket whose markets never come back (instrument snapshot lost) is dropped after dataSilenceMs with a line that says NOTHING was subscribed — and dropped again every dataSilenceMs until data flows', async () => {
  FakeSocket.instances.length = 0; const dir = mkdtempSync(path.join(tmpdir(), 'cobra-blind-eye-')); let now = T; const logs = [];
  const c = catalog([market('AAA'), market('BBB')]);
  const handle = startBroadKraken({ catalogSource: { snapshot: () => ({ catalog: c, fresh: true }) }, dataDir: dir, WebSocketImpl: FakeSocket, clock: () => now, log: (l) => logs.push(String(l)), limits: { subscribeChunkSize: 2, subscribePaceMs: 1, latestSnapshotMs: 1, catalogPollMs: 60_000, dataSilenceMs: 180_000 } });
  try {
    // the first socket: healthy — instrument, acks, a ticker
    const first = FakeSocket.instances[0]; first.open();
    ack(first, first.sent.find((r) => r.params.channel === 'instrument'));
    first.emit({ channel: 'instrument', type: 'snapshot', data: { assets: [], pairs: [{ symbol: 'AAA/USD', base: 'AAA', quote: 'USD', status: 'online' }, { symbol: 'BBB/USD', base: 'BBB', quote: 'USD', status: 'online' }] } });
    await sleep(20);
    for (const request of first.sent.filter((r) => r.method === 'subscribe' && ['ticker', 'ohlc'].includes(r.params.channel))) for (const symbol of request.params.symbol) ack(first, request, symbol);
    first.emit({ channel: 'ticker', type: 'update', data: [ticker('AAA/USD')] }); await sleep(5);
    assert.equal(handle._dataSilenceLaw(now + 60_000), false, 'data flowed a minute ago: healthy');
    // the venue drops the socket; the client reconnects; the instrument subscribe goes out and NOTHING comes back
    first.onclose(); now += 2_000; await sleep(1_200);
    const second = FakeSocket.instances[1]; assert.ok(second, 'a second socket was opened'); second.open();
    assert.ok(second.sent.some((r) => r.params.channel === 'instrument'), 'the instrument subscribe went out on the new socket');
    assert.equal(handle._dataSilenceLaw(now + 60_000), false, 'one minute into the new socket: the grace period');
    now += 181_000;
    assert.equal(handle._dataSilenceLaw(now), true, 'three minutes OPEN with nothing subscribed and no data: dropped');
    assert.ok(second.closed, 'the blind socket was dropped');
    const line = logs.find((l) => l.includes('DATA SILENCE') && l.includes('NOTHING subscribed')); assert.ok(line, logs.join('\n')); assert.match(line, /instrument PENDING, 2 markets/);
    assert.equal(handle.status().counters.dataSilentReconnects, 1);
    // the third socket is just as blind: the law fires again after the next window, not before
    await sleep(1_200); const third = FakeSocket.instances[2]; assert.ok(third, 'a third socket was opened'); third.open();
    assert.equal(handle._dataSilenceLaw(now + 100_000), false, 'inside the window: not again');
    now += 181_000; assert.equal(handle._dataSilenceLaw(now), true, 'still blind after another window: dropped again');
    assert.equal(handle.status().counters.dataSilentReconnects, 2);
  } finally { const keep = setInterval(() => {}, 20); await handle.stop(); clearInterval(keep); rmSync(dir, { recursive: true, force: true }); }
});

test('FIX126-2. the transport cuts a connect attempt that never completes after connectTimeoutMs and backs off to the next attempt', async () => {
  FakeSocket.instances.length = 0; const logs = [];
  const client = createWsClient({ providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', WebSocketImpl: FakeSocket, log: (l) => logs.push(String(l)), connectTimeoutMs: 30, reconnectBaseMs: 10, reconnectMaxMs: 10, onMessage: () => {} });
  try {
    client.start();
    const hung = FakeSocket.instances[0]; assert.ok(hung); assert.equal(client.status().state, 'CONNECTING');
    await sleep(60);
    assert.ok(hung.closed, 'the hung attempt was closed'); assert.equal(hung.onopen, null, 'and detached');
    assert.ok(logs.some((l) => l.includes('connect timed out')), logs.join('\n'));
    assert.equal(client.status().connectTimeouts, 1);
    const next = FakeSocket.instances[1]; assert.ok(next, 'a fresh attempt followed'); next.open();
    assert.equal(client.status().state, 'OPEN', 'the fresh attempt opens normally');
    hung.onopen?.(); assert.equal(client.status().state, 'OPEN', 'a late open from the cut attempt changes nothing');
  } finally { const keep = setInterval(() => {}, 20); await client.stop({ graceMs: 20 }); clearInterval(keep); }
});
