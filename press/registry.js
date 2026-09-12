// PRESS — the PUBLISHER / NEWS-AGGREGATOR observation registry (owner scope P01-P09). Deliberately SEPARATE from the frozen
// official-primary registry (rumor2/registry.js): a publisher headline is a PUBLISHER OBSERVATION with authority NONE — never
// an official claim, never a packet input, never corroboration merely because an aggregator repeats it. Each entry keeps its
// publisher identity and its transport identity apart (an aggregator item names Google as the transport and the publisher
// per item), records the primary documentation checked (URL, access date, what was verified), and declares exactly what the
// route yields: HEADLINE_LINK_ONLY — the feed's own title / summary / link; linked article bodies are never fetched.
// A route the repository cannot implement (licensed distribution only) stays in the registry as LICENSED_INTERFACE_REQUIRED
// with NO client: zero requests, an explicit status, an explicit owner prerequisite. Pure module: no network, no timers.
export const PRESS_REGISTRY_VERSION = 'serpent-press-registry-1';
export const PRESS_KINDS = Object.freeze(['PUBLISHER', 'AGGREGATOR']);
export const PRESS_ROUTES = Object.freeze(['RSS', 'LICENSED_INTERFACE_REQUIRED']);
export const PRESS_COVERAGE = 'HEADLINE_LINK_ONLY';
const ACCESSED = '2026-09-12';
const doc = (url, note, status = 'VERIFIED') => Object.freeze({ url, accessedOn: ACCESSED, status, note });
const src = (o) => Object.freeze({ kind: 'PUBLISHER', route: 'RSS', coverage: PRESS_COVERAGE, cadenceSec: 600, redirectHosts: [], accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', terms: 'UNVERIFIED', ...o, docs: Object.freeze(o.docs ?? []) });
export const PRESS_SOURCES = Object.freeze([
  src({ id: 'REUTERS_NEWS', name: 'Reuters', host: 'www.reuters.com', route: 'LICENSED_INTERFACE_REQUIRED', feedUrl: null, cadenceSec: null,
    docs: [doc('https://www.reuters.com/tools/rss', 'HTTP 401 on access: no public feed offered', 'NO_PUBLIC_ROUTE'), doc('https://www.reutersagency.com/en/products/', 'HTTP 404 on access; Reuters distributes through licensed products (Reuters Connect)', 'NO_PUBLIC_ROUTE')],
    prerequisite: 'a licensed Reuters interface (contract + documented payload) — no client is built around an unknown endpoint' }),
  src({ id: 'BLOOMBERG_NEWS', name: 'Bloomberg', host: 'www.bloomberg.com', route: 'LICENSED_INTERFACE_REQUIRED', feedUrl: null, cadenceSec: null,
    docs: [doc('https://www.bloomberg.com/feeds/', 'HTTP 403 anti-bot page on access; no public feed documented', 'NO_PUBLIC_ROUTE'), doc('https://www.bloomberg.com/professional/products/data/', 'HTTP 403 on access; licensed distribution (Terminal / B-PIPE / Enterprise)', 'NO_PUBLIC_ROUTE')],
    prerequisite: 'a licensed Bloomberg data interface (contract + documented payload)' }),
  src({ id: 'CNBC_NEWS', name: 'CNBC', host: 'www.cnbc.com', feedUrl: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', terms: 'UNVERIFIED',
    docs: [doc('https://www.cnbc.com/rss-feeds/', 'HTTP 403 from the build environment: the RSS index could not be read here; the Top News feed id is CNBC\'s published convention and must be confirmed from the host before enabling', 'UNVERIFIED_FROM_THIS_ENVIRONMENT')] }),
  src({ id: 'FT_NEWS', name: 'Financial Times', host: 'www.ft.com', feedUrl: 'https://www.ft.com/rss/home', terms: 'UNVERIFIED',
    docs: [doc('https://www.ft.com/rss/home', 'HTTP 200 text/xml (301 to /rss/home/international on the same host); headlines and links, article bodies paywalled'), doc('https://www.ft.com/rss', 'redirect loop on access; the FT RSS terms page could not be read here', 'UNVERIFIED_FROM_THIS_ENVIRONMENT')] }),
  src({ id: 'COINDESK_NEWS', name: 'CoinDesk', host: 'www.coindesk.com', feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/', terms: 'UNVERIFIED',
    docs: [doc('https://www.coindesk.com/arc/outboundfeeds/rss/', 'HTTP 200 application/xml, 25 items (outbound RSS)'), doc('https://www.coindesk.com/rss', 'HTTP 429 security checkpoint on access', 'UNVERIFIED_FROM_THIS_ENVIRONMENT')] }),
  src({ id: 'THEBLOCK_NEWS', name: 'The Block', host: 'www.theblock.co', feedUrl: 'https://www.theblock.co/rss.xml', docs: [doc('https://www.theblock.co/rss.xml', 'HTTP 200 text/xml, 20 items')] }),
  src({ id: 'COINTELEGRAPH_NEWS', name: 'Cointelegraph', host: 'cointelegraph.com', feedUrl: 'https://cointelegraph.com/rss', docs: [doc('https://cointelegraph.com/rss', 'HTTP 200 application/xml, 30 items')] }),
  src({ id: 'DECRYPT_NEWS', name: 'Decrypt', host: 'decrypt.co', feedUrl: 'https://decrypt.co/feed', docs: [doc('https://decrypt.co/feed', 'HTTP 200 application/xml, 55 items')] }),
  src({ id: 'GOOGLE_NEWS_AGGREGATOR', name: 'Google News (aggregator)', kind: 'AGGREGATOR', host: 'news.google.com', feedUrl: 'https://news.google.com/rss/search?q=bitcoin%20OR%20crypto%20OR%20ethereum&hl=en-US&gl=US&ceid=US:en', terms: 'UNVERIFIED',
    docs: [doc('https://news.google.com/rss/search?q=bitcoin&hl=en-US&gl=US&ceid=US:en', 'HTTP 200 application/xml; each item carries its own <source> publisher — transport identity is GOOGLE_NEWS, publisher identity per item, never a direct publisher licence'), doc('https://support.google.com/news/publisher-center/answer/9545420', 'Publisher Center documentation describes publisher onboarding, not a consumer feed contract', 'NO_CONSUMER_CONTRACT')] }),
]);
export const PRESS_SOURCE_IDS = Object.freeze(PRESS_SOURCES.map((s) => s.id));
export const pressSource = (id) => PRESS_SOURCES.find((s) => s.id === id) ?? null;
// registry law, checked by tests: closed kinds / routes, https-only feed hosts that match the pinned host, a licensed route has no URL
export function pressRegistryError(list = PRESS_SOURCES) {
  const ids = new Set();
  for (const s of list) {
    if (typeof s.id !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(s.id) || ids.has(s.id)) return `bad or duplicate id ${s.id}`; ids.add(s.id);
    if (!PRESS_KINDS.includes(s.kind) || !PRESS_ROUTES.includes(s.route) || s.coverage !== PRESS_COVERAGE) return `${s.id}: vocabulary`;
    if (!Array.isArray(s.docs) || s.docs.length === 0 || s.docs.some((d) => typeof d.url !== 'string' || !d.url.startsWith('https://') || d.accessedOn !== ACCESSED)) return `${s.id}: documentation refs`;
    if (s.route === 'LICENSED_INTERFACE_REQUIRED') { if (s.feedUrl !== null || s.cadenceSec !== null || typeof s.prerequisite !== 'string') return `${s.id}: a licensed route has no URL, no cadence, and names its prerequisite`; continue; }
    let u; try { u = new URL(s.feedUrl); } catch { return `${s.id}: feedUrl`; }
    if (u.protocol !== 'https:' || u.hostname !== s.host) return `${s.id}: feed host must be the pinned host over https`;
    if (!Number.isSafeInteger(s.cadenceSec) || s.cadenceSec < 300) return `${s.id}: cadence floor is 300 s (polite polling)`;
  }
  return null;
}
