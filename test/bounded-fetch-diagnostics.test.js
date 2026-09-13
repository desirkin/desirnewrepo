import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJsonBounded } from '../lib/bounded-fetch.js';

const url = 'https://sensor.example/feed';
const base = { host: 'sensor.example', timeoutMs: 100, maxBytes: 1024 };

test('bounded JSON transport distinguishes a request failure without exposing its message', async () => {
  const secretBearingError = new TypeError('fetch https://sensor.example/?token=do-not-echo failed');
  secretBearingError.cause = { code: 'UNKNOWN_do-not-echo', message: 'credential=do-not-echo' };
  const result = await fetchJsonBounded(url, {
    ...base,
    fetchImpl: async () => { throw secretBearingError; }
  });
  assert.deepEqual(result, { outcome: 'FAILED', reason: 'network request failed' });
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo/);
});

test('bounded JSON transport appends only allowlisted DNS, reset, TLS, and pre-response timeout cause codes', async () => {
  const cases = [
    ['ENOTFOUND', 'DNS'],
    ['ECONNRESET', 'reset'],
    ['CERT_HAS_EXPIRED', 'TLS'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ];
  for (const [code, label] of cases) {
    const error = new TypeError(`secret ${label} detail`); error.cause = { code, message: `token-${label}` };
    const result = await fetchJsonBounded(url, { ...base, fetchImpl: async () => { throw error; } });
    assert.deepEqual(result, { outcome: 'FAILED', reason: `network request failed (${code})` });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`secret|token-${label}`));
  }
});

test('the collector-owned deadline keeps its existing timeout reason instead of adopting a nested cause code', async () => {
  const result = await fetchJsonBounded(url, {
    ...base, timeoutMs: 10,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.deepEqual(result, { outcome: 'FAILED', reason: 'timeout after 10ms' });
});

test('bounded JSON transport distinguishes invalid UTF-8 from a network failure', async () => {
  const bytes = new Uint8Array([0xc3, 0x28]);
  const result = await fetchJsonBounded(url, {
    ...base,
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } })
  });
  assert.deepEqual(result, { outcome: 'FAILED', reason: 'response UTF-8 decoding failed' });
});

test('bounded JSON transport still rejects a successful HTML response without exposing its body', async () => {
  const result = await fetchJsonBounded(url, {
    ...base,
    fetchImpl: async () => new Response('<html>publisher error detail</html>', { headers: { 'content-type': 'text/html' } })
  });
  assert.deepEqual(result, { outcome: 'PARSE_FAILED', status: 200, reason: 'JSON content type required' });
  assert.doesNotMatch(JSON.stringify(result), /publisher error detail/);
});
