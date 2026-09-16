// PRESS — the crypto PUBLISHER observation registry (owner scope P05-P08). Deliberately SEPARATE from the frozen
// official-primary registry (rumor2/registry.js): a publisher headline is a PUBLISHER OBSERVATION with authority NONE — never
// an official claim, never a packet input. Each entry records the primary documentation checked (URL, access date, what was
// verified), and declares exactly what the route yields: HEADLINE_LINK_ONLY — the feed's own title / summary / link; linked
// article bodies are never fetched. Pure module: no network, no timers.
// LEAN PASS 4a: the non-crypto publishers (Reuters / Bloomberg / CNN — licensed-only; CNBC / FT / Google News aggregator)
// were retired with the AGGREGATOR and LICENSED_INTERFACE_REQUIRED machinery; what remains is the plain RSS PUBLISHER path.
export const PRESS_REGISTRY_VERSION = 'serpent-press-registry-1';
export const PRESS_KINDS = Object.freeze(['PUBLISHER']);
export const PRESS_ROUTES = Object.freeze(['RSS']);
export const PRESS_COVERAGE = 'HEADLINE_LINK_ONLY';
const ACCESSED = '2026-09-12';
const doc = (url, note, status = 'VERIFIED') => Object.freeze({ url, accessedOn: ACCESSED, status, note });
const src = (o) => Object.freeze({ kind: 'PUBLISHER', route: 'RSS', coverage: PRESS_COVERAGE, cadenceSec: 600, redirectHosts: [], accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', terms: 'UNVERIFIED', ...o, docs: Object.freeze(o.docs ?? []) });
export const PRESS_SOURCES = Object.freeze([
  src({ id: 'COINDESK_NEWS', name: 'CoinDesk', host: 'www.coindesk.com', feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/', terms: 'UNVERIFIED',
    docs: [doc('https://www.coindesk.com/arc/outboundfeeds/rss/', 'HTTP 200 application/xml, 25 items (outbound RSS)'), doc('https://www.coindesk.com/rss', 'HTTP 429 security checkpoint on access', 'UNVERIFIED_FROM_THIS_ENVIRONMENT')] }),
  src({ id: 'THEBLOCK_NEWS', name: 'The Block', host: 'www.theblock.co', feedUrl: 'https://www.theblock.co/rss.xml', docs: [doc('https://www.theblock.co/rss.xml', 'HTTP 200 text/xml, 20 items')] }),
  src({ id: 'COINTELEGRAPH_NEWS', name: 'Cointelegraph', host: 'cointelegraph.com', feedUrl: 'https://cointelegraph.com/rss', docs: [doc('https://cointelegraph.com/rss', 'HTTP 200 application/xml, 30 items')] }),
  src({ id: 'DECRYPT_NEWS', name: 'Decrypt', host: 'decrypt.co', feedUrl: 'https://decrypt.co/feed', docs: [doc('https://decrypt.co/feed', 'HTTP 200 application/xml, 55 items')] }),
]);
export const PRESS_SOURCE_IDS = Object.freeze(PRESS_SOURCES.map((s) => s.id));
export const pressSource = (id) => PRESS_SOURCES.find((s) => s.id === id) ?? null;
// registry law, checked by tests: closed kinds / routes, https-only feed hosts that match the pinned host, a cadence floor
export function pressRegistryError(list = PRESS_SOURCES) {
  const ids = new Set();
  for (const s of list) {
    if (typeof s.id !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(s.id) || ids.has(s.id)) return `bad or duplicate id ${s.id}`; ids.add(s.id);
    if (!PRESS_KINDS.includes(s.kind) || !PRESS_ROUTES.includes(s.route) || s.coverage !== PRESS_COVERAGE) return `${s.id}: vocabulary`;
    if (!Array.isArray(s.docs) || s.docs.length === 0 || s.docs.some((d) => typeof d.url !== 'string' || !d.url.startsWith('https://') || d.accessedOn !== ACCESSED)) return `${s.id}: documentation refs`;
    let u; try { u = new URL(s.feedUrl); } catch { return `${s.id}: feedUrl`; }
    if (u.protocol !== 'https:' || u.hostname !== s.host) return `${s.id}: feed host must be the pinned host over https`;
    if (!Number.isSafeInteger(s.cadenceSec) || s.cadenceSec < 300) return `${s.id}: cadence floor is 300 s (polite polling)`;
  }
  return null;
}
