import test from 'node:test';
import assert from 'node:assert/strict';

import { collectOfficialNewsFeed, NEWS_PUBLISHERS } from '../rumor2/news-collector.js';
import { COINDESK_OFFICIAL } from '../rumor2/providers/coindesk-official.js';
import { THE_BLOCK_OFFICIAL } from '../rumor2/providers/the-block-official.js';
import { COINTELEGRAPH_OFFICIAL } from '../rumor2/providers/cointelegraph-official.js';
import { DECRYPT_OFFICIAL } from '../rumor2/providers/decrypt-official.js';

const response = (status, text, headers = {}) => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => text,
});

const rss = (items) => `<rss><channel>${items.map((i) =>
  `<item><title>${i.title}</title><guid>${i.guid}</guid><link>${i.link}</link><pubDate>${i.date}</pubDate><description>${i.summary ?? ''}</description></item>`
).join('')}</channel></rss>`;

test('publisher composition exposes only the four fixed first-party RSS descriptors', () => {
  assert.deepEqual(NEWS_PUBLISHERS.map((p) => p.id), [
    'COINDESK_OFFICIAL',
    'THE_BLOCK_OFFICIAL',
    'COINTELEGRAPH_OFFICIAL',
    'DECRYPT_OFFICIAL',
  ]);
  for (const provider of NEWS_PUBLISHERS) {
    assert.equal(new URL(provider.feedUrl).protocol, 'https:');
    assert.equal(new URL(provider.feedUrl).hostname, provider.host);
  }
});

test('publisher adapter uses the fixed route, parses bounded feed items, and dedupes native ids', async () => {
  const calls = [];
  const result = await collectOfficialNewsFeed({
    provider: COINDESK_OFFICIAL,
    fetchImpl: async (url) => {
      calls.push(url);
      return response(200, rss([
        { title: 'One', guid: 'a', link: 'https://www.coindesk.com/a', date: 'Tue, 01 Jan 2030 00:00:00 GMT' },
        { title: 'Duplicate', guid: 'a', link: 'https://www.coindesk.com/a-2', date: 'Tue, 01 Jan 2030 00:00:00 GMT' },
        { title: 'Two', guid: 'b', link: 'https://www.coindesk.com/b', date: 'Tue, 01 Jan 2030 00:00:00 GMT' },
      ]), { etag: '"feed-v1"' });
    },
  });
  assert.deepEqual(calls, [COINDESK_OFFICIAL.feedUrl]);
  assert.equal(result.outcome, 'OK');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].provider, 'COINDESK_OFFICIAL');
  assert.equal(result.items[0].publishedTs, Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(result.etag, '"feed-v1"');
});

test('publisher adapter remains fail-closed for arbitrary descriptors and malformed feeds', async () => {
  const malformed = await collectOfficialNewsFeed({
    provider: DECRYPT_OFFICIAL,
    fetchImpl: async () => response(200, '<html>not a feed</html>'),
  });
  assert.equal(malformed.outcome, 'FAILED');
  assert.match(malformed.reason, /recognizable RSS\/Atom/);
  const blocked = await collectOfficialNewsFeed({
    provider: { ...THE_BLOCK_OFFICIAL, feedUrl: 'https://evil.example/feed' },
    fetchImpl: async () => response(200, ''),
  });
  assert.equal(blocked.outcome, 'FAILED');
  assert.match(blocked.reason, /outside provider allowlist/);
  const notModified = await collectOfficialNewsFeed({
    provider: COINTELEGRAPH_OFFICIAL,
    fetchImpl: async () => response(304, ''),
  });
  assert.deepEqual(notModified, { outcome: 'NOT_MODIFIED', provider: 'COINTELEGRAPH_OFFICIAL', status: 304 });
});