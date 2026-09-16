// B-11 — the WebSocket idle watchdog logs a stall line at the idle timeout. During the EXPECTED pre-subscribe quiet
// window (connected, subscribe sent, first ack/data not yet back) that line is noise, not a stall. The one predicate
// `messagedSinceOpen` gates ONLY the log: the watchdog still reconnects in both cases, but the alarming idle line is
// emitted only once data has flowed (a genuine post-subscribe stall). Pure: a fake WebSocket + node:test mock timers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createWsClient } from '../market-lab/transport.js';

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.closed = false; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null; FakeSocket.instances.push(this); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.({}); }
  // test drivers
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const idleLines = (logs) => logs.filter((l) => /ws idle \d+ ms/.test(l));

test('B-11. the idle line is emitted only for a post-subscribe idle, never the expected pre-subscribe one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances.length = 0;
  const logs = [];
  const client = createWsClient({
    providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', url: 'ws://127.0.0.1:1/v2',
    WebSocketImpl: FakeSocket, onMessage: () => {}, log: (m) => logs.push(String(m)), idleTimeoutMs: 30_000,
  });

  // connect → OPEN, subscribe would be sent in onOpen; no ack/data yet (the expected pre-subscribe gap)
  client.start();
  const s1 = FakeSocket.instances.at(-1);
  s1.open();

  // PRE-SUBSCRIBE idle fires: the watchdog closes/reconnects, but the line is SILENT (not a stall)
  t.mock.timers.tick(30_000);
  assert.equal(idleLines(logs).length, 0, 'a pre-subscribe idle prints no alarming line');
  assert.equal(s1.closed, true, 'the idle watchdog still closed the socket to reconnect');

  // the reconnect timer fires → a fresh connection
  t.mock.timers.tick(60_000);
  const s2 = FakeSocket.instances.at(-1);
  assert.notEqual(s2, s1, 'it reconnected after the pre-subscribe idle');
  s2.open();

  // subscription ACK / first data arrives → the connection is live
  s2.deliver({ channel: 'subscribe', success: true, result: { channel: 'ticker' } });

  // POST-SUBSCRIBE idle fires: data flowed then went silent — a real stall the operator must see
  t.mock.timers.tick(30_000);
  const post = idleLines(logs);
  assert.equal(post.length, 1, 'a post-subscribe idle logs exactly one stall line');
  assert.match(post[0], /ws idle 30000 ms/);
  assert.equal(s2.closed, true, 'and still reconnects');

  client.stop();
});

test('B-11. a connection that receives data then never opens again keeps the log gated per-connection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeSocket.instances.length = 0;
  const logs = [];
  const client = createWsClient({
    providerId: 'KRAKEN_SPOT', endpointId: 'ws-v2', url: 'ws://127.0.0.1:1/v2',
    WebSocketImpl: FakeSocket, onMessage: () => {}, log: (m) => logs.push(String(m)), idleTimeoutMs: 10_000,
  });
  client.start();
  const s1 = FakeSocket.instances.at(-1);
  s1.open();
  s1.deliver({ hello: 1 }); // this connection saw data → its idle is a real stall
  t.mock.timers.tick(10_000);
  assert.equal(idleLines(logs).length, 1, 'post-data idle logs');
  // reconnect → the NEW connection starts pre-subscribe again: its idle is silent until it, too, sees data
  t.mock.timers.tick(60_000);
  const s2 = FakeSocket.instances.at(-1);
  s2.open();
  t.mock.timers.tick(10_000);
  assert.equal(idleLines(logs).length, 1, 'the fresh connection\'s pre-subscribe idle stays silent (the flag reset per connection)');
  client.stop();
});
