import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedditClient } from '../rumor2/providers/reddit-client.js';
import { createYouTubeClient } from '../rumor2/providers/youtube-client.js';
import { createFarcasterClient } from '../rumor2/providers/farcaster-client.js';

const T = Date.parse('2026-09-12T10:00:01Z');
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(),
  async text() { return JSON.stringify(body); },
});
const redditThing = (id = 'abc123') => ({
  kind: 't3',
  data: {
    name: `t3_${id}`, id, subreddit: 'CryptoCurrency', author: 'fixture',
    author_fullname: 't2_fixture', title: 'BTC fixture', selftext: 'fixture body',
    created_utc: (T - 1000) / 1000, permalink: `/r/CryptoCurrency/comments/${id}/fixture/`,
  },
});

test('supported Reddit client performs OAuth + bounded listing and keeps unapproved content non-durable', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/access_token')) return response({ access_token: 'fixture-token', expires_in: 3600 });
    return response({ data: { children: [redditThing()], after: null } });
  };
  const client = createRedditClient({ fetch, clientId: 'client', clientSecret: 'secret', accessApproved: true, now: () => T });
  const out = await client.poll({ subreddit: 'CryptoCurrency', nowMs: T });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'OBSERVED');
  assert.equal(out.previews.length, 1);
  assert.deepEqual(out.durableItems, []);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /www\.reddit\.com\/api\/v1\/access_token/);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fixture-token');
  assert.equal(JSON.stringify(out).includes('fixture-token'), false);
});

test('Reddit client distinguishes failed from empty and requires both access and explicit retention for durable records', async () => {
  let calls = 0;
  const emptyFetch = async () => { calls += 1; return response({ data: { children: [], after: null } }); };
  const denied = createRedditClient({ fetch: emptyFetch, clientId: 'c', clientSecret: 's' });
  assert.equal((await denied.poll({ subreddit: 'CryptoCurrency', nowMs: T })).status, 'FAILED');
  assert.equal(calls, 0);
  const approved = createRedditClient({ fetch: async (url) => url.includes('access_token') ? response({ access_token: 't' }) : response({ data: { children: [redditThing()], after: null } }), clientId: 'c', clientSecret: 's', accessApproved: true, retentionApproved: true });
  const out = await approved.poll({ subreddit: 'CryptoCurrency', nowMs: T });
  assert.equal(out.status, 'OBSERVED');
  assert.equal(out.durableItems[0].nativeAuthorId, 't2_fixture');
});

test('YouTube client spends search quota for every request, dedupes IDs, and paginates by page token', async () => {
  const calls = [];
  const item = (id) => ({ kind: 'youtube#searchResult', id: { kind: 'youtube#video', videoId: id }, snippet: { publishedAt: '2026-09-12T10:00:00Z', channelId: 'UCfixture', channelTitle: 'Fixture', title: 'BTC', description: '' } });
  const fetch = async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get('pageToken');
    return response({ kind: 'youtube#searchListResponse', items: page ? [item('a'), item('b')] : [item('a')], ...(page ? {} : { nextPageToken: 'next' }) });
  };
  const client = createYouTubeClient({ fetch, apiKey: 'fixture-key', enabled: true, accessApproved: true, dailyRemainingUnits: 300, monthlyRemainingUnits: 300 });
  const out = await client.poll({ watchlist: { ok: true, scopeId: 'b'.repeat(40), tickers: ['BTC'] }, maxPages: 2, nowMs: T });
  assert.equal(out.status, 'OBSERVED');
  assert.deepEqual(out.observations.map((o) => o.nativePostId), ['a', 'b']);
  assert.equal(out.quotaUsed, 200);
  assert.equal(calls.length, 2);
  assert.equal((await createYouTubeClient({ fetch, apiKey: 'k', enabled: false, accessApproved: true, dailyRemainingUnits: 100, monthlyRemainingUnits: 100 }).poll({ watchlist: { ok: true, scopeId: 'b'.repeat(40), tickers: ['BTC'] }, nowMs: T })).status, 'FAILED');
});

test('Farcaster client requires Neynar key, maps search casts, and returns a cursor checkpoint', async () => {
  let seenInit;
  const fetch = async (url, init) => {
    seenInit = init;
    assert.match(url, /api\.neynar\.com\/v2\/farcaster\/cast\/search/);
    return response({ casts: [{ hash: '0xcast', author: { fid: 77, username: 'fixture' }, text: 'BTC fixture', timestamp: '2026-09-12T10:00:00Z' }], next: { cursor: 'next' } });
  };
  const missing = createFarcasterClient({ fetch, accessApproved: true, retentionApproved: true });
  assert.equal((await missing.poll({ q: 'BTC', nowMs: T })).error, 'NEYNAR_API_KEY_REQUIRED');
  const client = createFarcasterClient({ fetch, apiKey: 'fixture-key', accessApproved: true, retentionApproved: true });
  const out = await client.poll({ q: 'BTC', nowMs: T });
  assert.equal(out.status, 'OBSERVED');
  assert.equal(out.observations[0].nativePostId, '0xcast');
  assert.equal(out.nextCursor, 'next');
  assert.equal(seenInit.headers['x-api-key'], 'fixture-key');
});

test('clients turn injected abort/timeout into a failed outcome', async () => {
  const fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const client = createYouTubeClient({ fetch, apiKey: 'k', enabled: true, accessApproved: true, dailyRemainingUnits: 100, monthlyRemainingUnits: 100, timeoutMs: 5 });
  const out = await client.poll({ watchlist: { ok: true, scopeId: 'b'.repeat(40), tickers: ['BTC'] }, nowMs: T });
  assert.equal(out.status, 'FAILED');
  assert.equal(out.error, 'TIMEOUT');
});