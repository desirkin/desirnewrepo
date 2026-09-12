// RUMOR-2 bounded publisher adapter.  It intentionally has no search,
// discovery, HTML fallback, or article fetch path: only a caller-supplied
// descriptor's fixed official RSS/Atom route is contacted.  Item parsing is
// the same hostile-input-safe parser used by the ordinary rumor collector.
import { createHash } from 'node:crypto';
import { fetchProviderFeed } from './http.js';
import { parseFeed } from './feed.js';
import { COINDESK_OFFICIAL } from './providers/coindesk-official.js';
import { THE_BLOCK_OFFICIAL } from './providers/the-block-official.js';
import { COINTELEGRAPH_OFFICIAL } from './providers/cointelegraph-official.js';
import { DECRYPT_OFFICIAL } from './providers/decrypt-official.js';

const MAX_ITEM_ID_CHARS = 500;

function itemId(provider, item) {
  const native = item.guid || item.link;
  if (!native) return null;
  return `news-${createHash('sha1').update(JSON.stringify([provider.id, native])).digest('hex')}`;
}

function validDescriptor(provider) {
  return provider &&
    typeof provider.id === 'string' &&
    typeof provider.host === 'string' &&
    typeof provider.feedUrl === 'string' &&
    provider.providerKind === 'NEWS_RSS' &&
    provider.sourceType === 'NEWS_PUBLISHER';
}

// Result is deliberately transport/parse evidence, not a claim or a packet.
// `items` is bounded by parseFeed's hard item cap and each item retains the
// provider clock as parsed; missing provider clocks remain null.
export async function collectOfficialNewsFeed({
  provider,
  fetchImpl = fetch,
  userAgent = 'SerpentResearch/1.0 (automated public-feed research; read-only)',
  etag = null,
  lastModified = null,
  timeoutMs = undefined,
} = {}) {
  if (!validDescriptor(provider)) return { outcome: 'FAILED', reason: 'invalid news provider descriptor' };
  const fetched = await fetchProviderFeed({
    provider,
    fetchImpl,
    userAgent,
    etag,
    lastModified,
    timeoutMs,
  });
  if (fetched.outcome === 'NOT_MODIFIED') return { outcome: 'NOT_MODIFIED', provider: provider.id, status: 304 };
  if (fetched.outcome !== 'OK') return { outcome: 'FAILED', provider: provider.id, ...fetched };

  const parsed = parseFeed(fetched.text);
  if (!parsed.ok) return { outcome: 'FAILED', provider: provider.id, reason: parsed.reason, status: fetched.status };
  const items = [];
  const seen = new Set();
  for (const item of parsed.items) {
    const nativeId = item.guid || item.link;
    if (!nativeId || nativeId.length > MAX_ITEM_ID_CHARS) continue;
    const sourceEventId = itemId(provider, item);
    if (!sourceEventId || seen.has(sourceEventId)) continue;
    seen.add(sourceEventId);
    items.push(Object.freeze({
      provider: provider.id,
      providerKind: provider.providerKind,
      sourceType: provider.sourceType,
      authorityClass: provider.authorityClass,
      sourceEventId,
      nativeId,
      title: item.title,
      summary: item.summary,
      link: item.link,
      guid: item.guid,
      publishedTs: item.publishedTs,
    }));
  }
  return {
    outcome: 'OK',
    provider: provider.id,
    status: fetched.status,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    kind: parsed.kind,
    truncated: parsed.truncated,
    items,
  };
}

export const NEWS_PUBLISHERS = Object.freeze([
  COINDESK_OFFICIAL,
  THE_BLOCK_OFFICIAL,
  COINTELEGRAPH_OFFICIAL,
  DECRYPT_OFFICIAL,
]);