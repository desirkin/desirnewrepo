// PRESS — pure mapping from a parsed feed item to ONE publisher observation (`press-observation-1`), plus the aggregator's
// per-item <source> extraction. Clocks: `publishedTs` is the feed's own publication clock (null when the feed gives none —
// never fabricated from receipt); `receiptTs` is when the bytes arrived; `knownAtTs` = receiptTs (what the app knew, when).
// Identity: sha256(sourceId | guid-or-link) — the same article through two publishers is two observations with two
// identities and is NEVER merged into corroboration here. Content is untrusted text: bounded, tags stripped by the shared
// parser, links accepted only as https URLs whose host is recorded; bodies are never fetched.
import { createHash } from 'node:crypto';

export const PRESS_OBSERVATION_VERSION = 'press-observation-1';
export const PRESS_LIMITS = Object.freeze({ maxTitleChars: 300, maxSummaryChars: 500, maxLinkChars: 2000, maxItemsPerPoll: 100 });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const bounded = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
const httpsHost = (link) => { try { const u = new URL(link); return u.protocol === 'https:' && u.hostname ? u.hostname.toLowerCase() : null; } catch { return null; } };

// Google News RSS items carry <source url="https://publisher.example">Publisher Name</source>; the shared parser keeps only
// title / summary / link / guid / pubDate, so the per-item publisher is recovered from the raw item block, keyed by link.
export function extractItemSources(text) {
  const out = new Map(); if (typeof text !== 'string') return out;
  for (const m of text.matchAll(/<item[\s>][\s\S]*?<\/item\s*>/gi)) {
    const block = m[0]; const link = (block.match(/<link>([^<]{1,2000})<\/link>/i) ?? [])[1]?.trim() ?? null;
    const s = block.match(/<source(?:\s+url="([^"]{0,500})")?[^>]*>([^<]{1,200})<\/source>/i); if (!link || !s) continue;
    out.set(link, { name: s[2].trim(), host: s[1] ? httpsHost(s[1]) : null });
  }
  return out;
}
// item -> observation, or { skip, reason }
export function itemToObservation(item, { source, receiptTs, feedKind, itemSources = null }) {
  if (!item || typeof item.title !== 'string' || !item.title.length) return { skip: true, reason: 'untitled item' };
  const link = typeof item.link === 'string' ? bounded(item.link, PRESS_LIMITS.maxLinkChars) : null; const linkHost = link ? httpsHost(link) : null;
  if (link && !linkHost) return { skip: true, reason: 'link is not an https URL' };
  const key = typeof item.guid === 'string' && item.guid.length ? `guid:${item.guid}` : link ? `link:${link}` : null; if (!key) return { skip: true, reason: 'no guid and no link: unidentifiable' };
  const publishedTs = Number.isSafeInteger(item.publishedTs) ? item.publishedTs : null;
  if (publishedTs !== null && publishedTs > receiptTs + 5 * 60_000) return { skip: true, reason: 'publication clock in the future beyond tolerance' };
  const agg = source.kind === 'AGGREGATOR'; const via = agg && link ? itemSources?.get(link) ?? null : null;
  return { observation: Object.freeze({
    v: PRESS_OBSERVATION_VERSION, observationId: sha256(`${source.id}|${key}`), itemKey: key, sourceId: source.id, sourceKind: source.kind,
    transport: agg ? source.id : 'DIRECT_FEED', publisher: agg ? (via?.name ?? null) : source.name, publisherHost: agg ? (via?.host ?? null) : source.host, publisherResolved: agg ? Boolean(via) : true,
    feedKind, title: bounded(item.title, PRESS_LIMITS.maxTitleChars), summary: bounded(item.summary ?? '', PRESS_LIMITS.maxSummaryChars), link, linkHost,
    publishedTs, receiptTs, knownAtTs: receiptTs, coverage: 'HEADLINE_LINK_ONLY', authority: 'NONE', bodyFetched: false,
  }) };
}
// closed shape check for reopened records (reader) and fresh writes (collector)
export const PRESS_OBSERVATION_KEYS = Object.freeze(['v', 'observationId', 'itemKey', 'sourceId', 'sourceKind', 'transport', 'publisher', 'publisherHost', 'publisherResolved', 'feedKind', 'title', 'summary', 'link', 'linkHost', 'publishedTs', 'receiptTs', 'knownAtTs', 'coverage', 'authority', 'bodyFetched']);
export function pressObservationError(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object'; if (o.v !== PRESS_OBSERVATION_VERSION) return 'version';
  const keys = Object.keys(o); if (keys.length !== PRESS_OBSERVATION_KEYS.length || !PRESS_OBSERVATION_KEYS.every((k) => k in o)) return `keys: exactly ${PRESS_OBSERVATION_KEYS.join(',')} (a body, a score or any extra field is refused)`;
  if (typeof o.itemKey !== 'string' || !/^(guid|link):./.test(o.itemKey) || o.itemKey.length > PRESS_LIMITS.maxLinkChars + 5) return 'itemKey';
  if (!/^[0-9a-f]{64}$/.test(o.observationId ?? '') || o.observationId !== sha256(`${o.sourceId}|${o.itemKey}`)) return 'observationId is not the derived identity'; if (typeof o.sourceId !== 'string' || !['PUBLISHER', 'AGGREGATOR'].includes(o.sourceKind)) return 'source';
  if (typeof o.title !== 'string' || !o.title.length || o.title.length > PRESS_LIMITS.maxTitleChars) return 'title'; if (typeof o.summary !== 'string' || o.summary.length > PRESS_LIMITS.maxSummaryChars) return 'summary';
  if (!(o.link === null || (typeof o.link === 'string' && typeof o.linkHost === 'string'))) return 'link'; if (!(o.publishedTs === null || Number.isSafeInteger(o.publishedTs))) return 'publishedTs';
  if (!Number.isSafeInteger(o.receiptTs) || o.knownAtTs !== o.receiptTs) return 'clocks'; if (o.coverage !== 'HEADLINE_LINK_ONLY' || o.authority !== 'NONE' || o.bodyFetched !== false) return 'law';
  if (typeof o.publisherResolved !== 'boolean' || !(o.publisher === null || typeof o.publisher === 'string')) return 'publisher';
  return null;
}
