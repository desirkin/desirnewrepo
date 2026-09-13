import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUDFLARE_RADAR_BASE,
  fetchCloudflareRadar,
  fetchNoaaProduct,
  createRipeRisLiveStream,
  buildRisSubscription,
} from '../gateway/infrastructure/index.js';

const response = (body, status = 200, contentType = 'application/json') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => name === 'content-type' ? contentType : null },
  arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
});

test('Cloudflare Radar is token-gated and uses a fixed documented route', async () => {
  let calls = 0;
  const missing = await fetchCloudflareRadar({ token: '', fetchImpl: async () => { calls += 1; } });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'FAILED');
  assert.equal(missing.failure.code, 'CREDENTIAL_MISSING');
  assert.equal(calls, 0);

  let request;
  const got = await fetchCloudflareRadar({
    token: 'test-token',
    route: 'bgpRoutesStats',
    query: { location: 'US' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ success: true, result: {} });
    },
    clock: () => 1_700_000_000_000,
  });
  assert.equal(got.ok, true);
  assert.equal(got.status, 'EMPTY');
  assert.equal(request.url, `${CLOUDFLARE_RADAR_BASE}/radar/bgp/routes/stats?location=US`);
  assert.equal(request.options.headers.authorization, 'Bearer test-token');
  assert.equal(JSON.stringify(got).includes('test-token'), false);
  assert.equal(got.provenance.receivedTs, 1_700_000_000_000);
});

test('NOAA SWPC distinguishes an empty product and bounds table rows', async () => {
  const empty = await fetchNoaaProduct({
    product: 'alerts',
    fetchImpl: async () => response([]),
    clock: () => 1_700_000_000_000,
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.status, 'EMPTY');
  assert.deepEqual(empty.data.records, []);

  const rows = [
    ['time_tag', 'speed'],
    ['2024-01-01T00:00:00Z', '400'],
    ['2024-01-01T00:01:00Z', '401'],
  ];
  const limited = await fetchNoaaProduct({
    product: 'solarWindPlasma7Day',
    maxRecords: 1,
    fetchImpl: async () => response(rows),
    clock: () => 1_700_000_000_000,
  });
  assert.equal(limited.status, 'DATA');
  assert.equal(limited.data.rows.length, 1);
  assert.equal(limited.data.truncated, true);
  assert.equal(limited.provenance.sourceTimestamp, Date.parse('2024-01-01T00:00:00Z'));
});

test('RIS Live sends the official subscription and deduplicates updates', async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.onclose?.(); }
  }
  const events = [];
  const outcomes = [];
  const stream = createRipeRisLiveStream({
    WebSocketImpl: FakeSocket,
    onEvent: (event) => events.push(event),
    onOutcome: (event) => outcomes.push(event),
    clock: () => 1_700_000_000_000,
    setTimeoutImpl: (fn) => { fn(); return 1; },
    clearTimeoutImpl: () => {},
    random: () => 0,
  });
  assert.deepEqual(buildRisSubscription({ host: 'rrc00' }), { type: 'ris_subscribe', data: { host: 'rrc00', type: 'UPDATE' } });
  stream.start();
  sockets[0].onopen();
  assert.deepEqual(sockets[0].sent[0], stream.subscription);
  const message = {
    type: 'ris_message',
    data: {
      id: 'native-1', timestamp: 1_699_999_999, host: 'rrc00', peer: '192.0.2.1', peer_asn: 64500,
      attrs: { prefix: '203.0.113.0/24', announced: true, withdrawn: false, path: [64500, 64496] },
    },
  };
  await sockets[0].onmessage({ data: JSON.stringify(message) });
  await sockets[0].onmessage({ data: JSON.stringify(message) });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'BGP_UPDATE');
  assert.equal(events[0].sourceEventTs, 1_699_999_999_000);
  assert.ok(outcomes.some((item) => item.status === 'DEDUPED'));
  stream.stop();
  assert.equal(stream.status().state, 'STOPPED');
});