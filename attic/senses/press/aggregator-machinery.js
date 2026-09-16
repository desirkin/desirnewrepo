// ATTIC (LEAN PASS 4a) — the retired PRESS AGGREGATOR machinery, preserved verbatim, wired to nothing. It served only the
// Google News aggregator source (GOOGLE_NEWS_AGGREGATOR), which was retired with the other non-crypto publishers; the four
// kept crypto publishers (CoinDesk / The Block / Cointelegraph / Decrypt) are all plain RSS PUBLISHER feeds that never used
// it. Nothing in the living tree imports this file.
//
// 1) The per-item <source> extraction (was press/parse.js). Google News RSS items carry
//    <source url="https://publisher.example">Publisher Name</source>; the shared parser keeps only title / summary / link /
//    guid / pubDate, so the per-item publisher was recovered from the raw item block, keyed by link.
import { createHash } from 'node:crypto'; // eslint-disable-line no-unused-vars -- attic parity with the original module head

const httpsHost = (link) => { try { const u = new URL(link); return u.protocol === 'https:' && u.hostname ? u.hostname.toLowerCase() : null; } catch { return null; } };

export function extractItemSources(text) {
  const out = new Map(); if (typeof text !== 'string') return out;
  for (const m of text.matchAll(/<item[\s>][\s\S]*?<\/item\s*>/gi)) {
    const block = m[0]; const link = (block.match(/<link>([^<]{1,2000})<\/link>/i) ?? [])[1]?.trim() ?? null;
    const s = block.match(/<source(?:\s+url="([^"]{0,500})")?[^>]*>([^<]{1,200})<\/source>/i); if (!link || !s) continue;
    out.set(link, { name: s[2].trim(), host: s[1] ? httpsHost(s[1]) : null });
  }
  return out;
}

// 2) The publisher-vs-transport split (was inside press/parse.js itemToObservation). For an AGGREGATOR the transport was the
//    aggregator id and the publisher was resolved per item from extractItemSources; a direct PUBLISHER feed had no split
//    (transport === 'DIRECT_FEED', publisher === source.name, publisherResolved === true). Kept here for the record:
//      const agg = source.kind === 'AGGREGATOR'; const via = agg && link ? itemSources?.get(link) ?? null : null;
//      transport: agg ? source.id : 'DIRECT_FEED',
//      publisher: agg ? (via?.name ?? null) : source.name,
//      publisherHost: agg ? (via?.host ?? null) : source.host,
//      publisherResolved: agg ? Boolean(via) : true,
//
// 3) The LICENSED_INTERFACE_REQUIRED route/state (was press/registry.js + press/collector.js): a source the repository could
//    not implement (Reuters / Bloomberg / CNN — licensed distribution only) stayed in the registry with route
//    'LICENSED_INTERFACE_REQUIRED', feedUrl null, a named owner prerequisite, and NO client — zero requests, an explicit
//    LICENSED_INTERFACE_REQUIRED status. The registry law asserted a licensed route has no URL / no cadence / names its
//    prerequisite; the collector mapped that route to the LICENSED_INTERFACE_REQUIRED state and never polled it.
