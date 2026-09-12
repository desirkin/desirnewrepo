import test from 'node:test';
import assert from 'node:assert/strict';
import { tallyGql } from '../governance/tally.js';

const env = { TALLY_API_KEY: 'fixture-tally-key' };

test('Tally refuses redirects before an API key can be forwarded', async () => {
  let calls = 0;
  await assert.rejects(() => tallyGql('{fixture}', {}, {
    env,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://other.example/query' } });
    },
  }), /redirect refused/);
  assert.equal(calls, 1);
});

test('Tally stops reading an oversized response before buffering the whole stream', async () => {
  let reads = 0, cancelled = false;
  await assert.rejects(() => tallyGql('{fixture}', {}, {
    env,
    fetchImpl: async () => ({
      status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({
        read: async () => { reads++; return { value: new Uint8Array(1024 * 1024), done: false }; },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }) },
    }),
  }), /body over 2097152 bytes/);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
});

test('Tally keeps the body-read deadline when a caller supplies a cancellation signal', async () => {
  let cancelled = false;
  await assert.rejects(() => tallyGql('{fixture}', {}, {
    env, timeoutMs: 10, signal: new AbortController().signal,
    fetchImpl: async () => ({
      status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }) },
    }),
  }), /timeout after 10ms/);
  assert.equal(cancelled, true);
});
