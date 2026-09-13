// RUMOR-2A — strict bounded RSS/Atom item extraction. Feed XML is HOSTILE
// external input: this module never resolves entities, never honors a
// DOCTYPE, never fetches schemas or includes, never executes anything. It
// is deliberately NOT a general XML parser — it is a fail-closed scanner
// that extracts a fixed set of well-known elements from well-known feed
// shapes and REJECTS anything structurally hostile or unrecognizable.
// Zero dependencies by standing project constraint (`pg` is the only
// authorized package); the narrow scope plus outright rejection of
// DOCTYPE/entity machinery is what keeps a scanner safe here.
import { MAX_FEED_ITEMS, MAX_TITLE_CHARS, MAX_SUMMARY_CHARS, stripMarkup, boundedError } from './truth.js';

const HOSTILE_RE = /<!DOCTYPE|<!ENTITY|<!ELEMENT|<!ATTLIST|<xi:include/i;

// Extract the inner text of the FIRST occurrence of any of the named
// elements inside one bounded block. Handles CDATA and simple nested-free
// elements — feed metadata elements (title/link/guid/pubDate/description)
// are flat text carriers in every real RSS/Atom feed; a block where the
// close tag cannot be found yields null, never a guess.
function firstElementText(block, names) {
  for (const name of names) {
    const open = block.match(new RegExp(`<${name}(?:\\s[^>]{0,300})?>`, 'i'));
    if (!open) continue;
    const start = open.index + open[0].length;
    const close = block.slice(start).search(new RegExp(`</${name}\\s*>`, 'i'));
    if (close < 0) continue;
    let inner = block.slice(start, start + close);
    const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdata) inner = cdata[1];
    return inner;
  }
  return null;
}

// Atom links live in attributes: <link rel="alternate" href="..."/>
function atomLinkHref(block) {
  for (const m of block.matchAll(/<link\b([^>]{0,400})\/?>(?:<\/link>)?/gi)) {
    const attrs = m[1];
    const rel = attrs.match(/\brel\s*=\s*"([^"]{0,60})"/i)?.[1] ?? 'alternate';
    if (rel !== 'alternate') continue;
    const href = attrs.match(/\bhref\s*=\s*"([^"]{0,2000})"/i)?.[1];
    if (href) return href;
  }
  return null;
}

const parseDateMs = (s) => {
  if (typeof s !== 'string' || s.length === 0 || s.length > 80) return null;
  const ms = Date.parse(s.trim());
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

// parseFeed(xmlText) -> { ok: true, kind: 'RSS'|'ATOM', items: [...] }
//                    or { ok: false, reason }
// Every item: { title, summary, link, guid, publishedTs } — all bounded,
// markup stripped, timestamps parsed or null. Item count is hard-capped.
export function parseFeed(text) {
  try {
    if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty feed body' };
    if (HOSTILE_RE.test(text)) return { ok: false, reason: 'hostile XML construct rejected (DOCTYPE/ENTITY/XInclude)' };
    const body = text.replace(/<!--[\s\S]{0,10000}?-->/g, ''); // bounded comment removal
    const isRss = /<rss[\s>]/i.test(body) && /<channel[\s>]/i.test(body);
    const isAtom = !isRss && /<feed[\s>]/i.test(body);
    if (!isRss && !isAtom) return { ok: false, reason: 'not a recognizable RSS/Atom document' };
    const blockRe = isRss ? /<item[\s>][\s\S]*?<\/item\s*>/gi : /<entry[\s>][\s\S]*?<\/entry\s*>/gi;
    const items = [];
    let truncated = false;
    for (const m of body.matchAll(blockRe)) {
      if (items.length >= MAX_FEED_ITEMS) {
        truncated = true; // deterministic policy: first N document-order items, remainder counted
        break;
      }
      const block = m[0];
      const rawTitle = firstElementText(block, ['title']);
      const title = stripMarkup(rawTitle ?? '', MAX_TITLE_CHARS);
      if (!title) continue; // an untitled item is unidentifiable — skipped, counted by caller via items delta
      const rawSummary = firstElementText(block, isRss ? ['description', 'content:encoded'] : ['summary', 'content']);
      const summary = stripMarkup(rawSummary ?? '', MAX_SUMMARY_CHARS);
      const link = isRss ? stripMarkup(firstElementText(block, ['link']) ?? '', 2000) || null : atomLinkHref(block);
      const guid = stripMarkup(firstElementText(block, isRss ? ['guid'] : ['id']) ?? '', 500) || null;
      const publishedTs = parseDateMs(
        firstElementText(block, isRss ? ['pubDate', 'dc:date'] : ['published', 'updated']) ?? ''
      );
      items.push({ title, summary, link, guid, publishedTs });
    }
    if (items.length === 0 && !truncated) return { ok: false, reason: 'feed contained no parseable items' };
    return { ok: true, kind: isRss ? 'RSS' : 'ATOM', items, truncated };
  } catch (err) {
    return { ok: false, reason: boundedError(`feed parse rejected: ${err.message}`) };
  }
}
