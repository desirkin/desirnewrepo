import test from 'node:test';
import assert from 'node:assert/strict';
import { SNAPSHOT_HUB, Retry429, snapshotGql, fetchProposalsPage, fetchVotesPage } from '../governance/snapshot.js';

test('Snapshot preserves proposal/vote response semantics on a pinned JSON POST', async () => {
  const queries = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, SNAPSHOT_HUB);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return Response.json({ data: query.includes('{ votes(') ? { votes: [{ voter: 'fixture', vp: 1 }] } : { proposals: [] } });
  };
  assert.deepEqual(await fetchProposalsPage({ spaceIds: ['aave.eth'], state: 'active', first: 1 }, { fetchImpl }), []);
  assert.deepEqual(await fetchVotesPage({ proposalId: 'fixture-proposal', first: 1 }, { fetchImpl }), [{ voter: 'fixture', vp: 1 }]);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /first: 1/);
  assert.match(queries[0], /aave\.eth/);
});

test('Snapshot refuses redirects and never requests the redirect target', async () => {
  let calls = 0;
  await assert.rejects(() => snapshotGql('{fixture}', {
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 307, headers: { location: 'https://other.example/query' } });
    },
  }), /redirect refused/);
  assert.equal(calls, 1);
});

test('Snapshot cancels an oversized streamed response at its two MiB bound', async () => {
  let reads = 0, cancelled = false;
  await assert.rejects(() => snapshotGql('{fixture}', {
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

test('Snapshot deadline includes body reads even with an external cancellation signal', async () => {
  let cancelled = false;
  await assert.rejects(() => snapshotGql('{fixture}', {
    timeoutMs: 10, signal: new AbortController().signal,
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

test('Snapshot external cancellation stops an in-flight read and pre-cancellation makes zero requests', async () => {
  const ctl = new AbortController();
  let cancelled = false;
  await assert.rejects(() => snapshotGql('{fixture}', {
    signal: ctl.signal,
    fetchImpl: async () => ({
      status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader: () => ({
        read: () => { queueMicrotask(() => ctl.abort()); return new Promise(() => {}); },
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      }) },
    }),
  }), /request stopped/);
  assert.equal(cancelled, true);
  let calls = 0;
  await assert.rejects(() => snapshotGql('{fixture}', {
    signal: ctl.signal,
    fetchImpl: async () => { calls++; return Response.json({ data: {} }); },
  }), /request stopped/);
  assert.equal(calls, 0);
});

test('Snapshot keeps typed 429 backoff and HTTP/GraphQL failures without retries', async () => {
  let calls = 0;
  await assert.rejects(() => snapshotGql('{fixture}', {
    fetchImpl: async () => { calls++; return Response.json({}, { status: 429, headers: { 'retry-after': '7' } }); },
  }), (error) => error instanceof Retry429 && error.retryAfterSec === 7);
  assert.equal(calls, 1);
  await assert.rejects(() => snapshotGql('{fixture}', { fetchImpl: async () => Response.json({}, { status: 503 }) }), /snapshot HTTP 503/);
  await assert.rejects(() => snapshotGql('{fixture}', { fetchImpl: async () => Response.json({ errors: [{ message: 'fixture GraphQL error' }] }) }), /snapshot graphql: fixture GraphQL error/);
  await assert.rejects(() => snapshotGql('{fixture}', { fetchImpl: async () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }) }), /JSON content type required/);
});
