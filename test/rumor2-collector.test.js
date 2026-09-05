// RUMOR-2A drills — the collector and its guarded ears: SSRF/allowlist
// policy, bounded fetch/parse, cache validation, backoff independence,
// bootstrap point-in-time honesty, crash-window dedupe, and durability
// degradation that never touches any other sense.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startRumor2 } from '../rumor2/collector.js';
import { urlPolicyError, fetchProviderFeed } from '../rumor2/http.js';
import { parseFeed } from '../rumor2/feed.js';
import { KRAKEN_OFFICIAL } from '../rumor2/providers/kraken-official.js';
import { MAX_BOOTSTRAP_ITEMS, RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS } from '../rumor2/truth.js';
import { fromRumor2Event } from '../memory/adapters.js';
import { readJsonl } from '../lib/jsonl.js';

const dirs = [];
function seedDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'cobra-rumor2-'));
  dirs.push(d);
  process.env.COBRA_DATA_DIR = d;
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CONFIG = { universe: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'] };
const T0 = Date.parse('2026-09-05T12:00:00Z');

const mkRes = (status, body = '', headers = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n) => h[n.toLowerCase()] ?? null }, text: async () => body };
};

const rss = (items) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>feed</title>` +
  items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link ?? 'https://blog.kraken.com/post/x'}</link><guid>${i.guid ?? i.title}</guid>` +
        `<pubDate>${new Date(i.pub ?? T0 - 3_600_000).toUTCString()}</pubDate><description>${i.desc ?? ''}</description></item>`
    )
    .join('') +
  `</channel></rss>`;

function memStore() {
  const s = { saved: null, failLoad: null, failSave: false, saveCount: 0, saveIsNoop: false };
  return {
    state: s,
    async load() {
      if (s.failLoad) return s.failLoad;
      return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) };
    },
    async save(state) {
      s.saveCount++;
      if (s.failSave) return { durable: false, reason: 'UNAVAILABLE' };
      if (!s.saveIsNoop) s.saved = structuredClone(state);
      return { durable: true };
    },
  };
}

// scripted fetch by hostname; records every request
function scriptedFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const host = new URL(url).hostname;
    const h = handlers[host];
    if (!h) return mkRes(404, 'no handler');
    return typeof h === 'function' ? h(url, opts) : h;
  };
  fn.calls = calls;
  return fn;
}

function harness({ handlers = {}, contact = null, store = memStore(), appendEvent, startMs = T0 } = {}) {
  seedDir();
  const clock = { ms: startMs };
  const events = [];
  const fetchImpl = scriptedFetch(handlers);
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl,
    now: () => clock.ms,
    intervalMs: 2_147_000_000, // scheduler never fires in tests; ticks are manual
    checkpointStore: store,
    appendEvent:
      appendEvent ??
      ((rec) => {
        events.push(rec);
      }),
    contact,
    enabled: true,
    timeoutMs: 50,
  });
  return { c, clock, events, fetchImpl, store };
}
const tick = async (h, advanceMs = 121_000) => {
  h.clock.ms += advanceMs;
  await h.c.tickOnce();
};

// ---- provider security (mandates 1-9) --------------------------------------

test('R2P-1. official Kraken endpoint is allowlisted', () => {
  assert.equal(urlPolicyError('https://blog.kraken.com/feed', KRAKEN_OFFICIAL), null);
});

test('R2P-2. arbitrary host rejected', () => {
  assert.ok(urlPolicyError('https://evil.example.com/feed', KRAKEN_OFFICIAL).includes('outside provider allowlist'));
});

test('R2P-3. HTTP endpoint rejected', () => {
  assert.ok(urlPolicyError('http://blog.kraken.com/feed', KRAKEN_OFFICIAL).includes('https only'));
  assert.ok(urlPolicyError('file:///etc/passwd', KRAKEN_OFFICIAL).includes('https only'));
  assert.ok(urlPolicyError('ftp://blog.kraken.com/feed', KRAKEN_OFFICIAL).includes('https only'));
});

test('R2P-4. private/loopback targets rejected', () => {
  for (const u of ['https://localhost/feed', 'https://127.0.0.1/feed', 'https://10.0.0.8/feed', 'https://192.168.1.4/feed', 'https://169.254.1.1/feed', 'https://[::1]/feed'])
    assert.ok(urlPolicyError(u, KRAKEN_OFFICIAL) !== null, `${u} must be rejected`);
});

test('R2P-5. off-domain redirect rejected', async () => {
  const fetchImpl = scriptedFetch({ 'blog.kraken.com': mkRes(301, '', { location: 'https://evil.example.com/feed' }) });
  const r = await fetchProviderFeed({ provider: KRAKEN_OFFICIAL, fetchImpl, userAgent: 'x', timeoutMs: 50 });
  assert.equal(r.outcome, 'FAILED');
  assert.ok(r.reason.includes('redirect blocked'));
  assert.equal(fetchImpl.calls.length, 1, 'the off-domain hop is never requested');
});

test('R2P-6. timeout bounded', async () => {
  const fetchImpl = async (url, { signal }) =>
    new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r = await fetchProviderFeed({ provider: KRAKEN_OFFICIAL, fetchImpl, userAgent: 'x', timeoutMs: 20 });
  assert.equal(r.outcome, 'FAILED');
  assert.ok(r.reason.includes('timeout after 20ms'));
});

test('R2P-7. oversized response rejected', async () => {
  const declared = scriptedFetch({ 'blog.kraken.com': mkRes(200, 'x', { 'content-length': '2000000' }) });
  const r1 = await fetchProviderFeed({ provider: KRAKEN_OFFICIAL, fetchImpl: declared, userAgent: 'x', timeoutMs: 50 });
  assert.equal(r1.outcome, 'FAILED');
  assert.ok(r1.reason.includes('exceeds'));
  const huge = scriptedFetch({ 'blog.kraken.com': mkRes(200, 'y'.repeat(1_048_577)) });
  const r2 = await fetchProviderFeed({ provider: KRAKEN_OFFICIAL, fetchImpl: huge, userAgent: 'x', timeoutMs: 50 });
  assert.equal(r2.outcome, 'FAILED');
  assert.ok(r2.reason.includes('exceeds'));
});

test('R2P-8. malformed feed rejected', () => {
  assert.equal(parseFeed('this is not xml at all').ok, false);
  assert.equal(parseFeed('<html><body>404</body></html>').ok, false);
  assert.equal(parseFeed('').ok, false);
});

test('R2P-9. XML external entity / DOCTYPE rejected', () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel><item><title>&xxe;</title></item></channel></rss>`;
  const r = parseFeed(xxe);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('hostile XML construct'));
});

// ---- parsing bounds (mandates 10-14) ---------------------------------------

test('R2P-10. more than 100 feed items bounded per policy', () => {
  const r = parseFeed(rss(Array.from({ length: 120 }, (_, i) => ({ title: `item number ${i}`, guid: `g${i}` }))));
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 100, 'first 100 in document order');
  assert.equal(r.truncated, true, 'the cut is explicit, never silent');
});

test('R2P-11. valid RSS item parsed', () => {
  const r = parseFeed(rss([{ title: 'Kraken update', guid: 'g1', link: 'https://blog.kraken.com/post/1', desc: 'a summary here' }]));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'RSS');
  assert.equal(r.items[0].title, 'Kraken update');
  assert.equal(r.items[0].guid, 'g1');
  assert.equal(r.items[0].summary, 'a summary here');
  assert.ok(Number.isSafeInteger(r.items[0].publishedTs));
});

test('R2P-12. valid Atom item parsed', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
    <entry><title>Atom entry one</title><id>urn:a1</id><updated>2026-09-04T10:00:00Z</updated>
    <link rel="alternate" href="https://www.sec.gov/item/1"/><summary>press release summary</summary></entry></feed>`;
  const r = parseFeed(atom);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ATOM');
  assert.equal(r.items[0].title, 'Atom entry one');
  assert.equal(r.items[0].guid, 'urn:a1');
  assert.equal(r.items[0].link, 'https://www.sec.gov/item/1');
});

test('R2P-13. title bound enforced', () => {
  const r = parseFeed(rss([{ title: 'T'.repeat(400), guid: 'g' }]));
  assert.equal(r.items[0].title.length, 300);
});

test('R2P-14. summary/excerpt bound enforced', () => {
  const r = parseFeed(rss([{ title: 'bounded', guid: 'g', desc: 'd'.repeat(6000) }]));
  assert.equal(r.items[0].summary.length, 4000);
});

// ---- cache validation + backoff (mandates 15-20) ---------------------------

test('R2P-15+16+17. 304 is a successful observation; ETag/Last-Modified survive restart', async () => {
  const store = memStore();
  let mode = 'full';
  const kraken = () =>
    mode === 'full'
      ? mkRes(200, rss([{ title: 'plain post', guid: 'g1' }]), { etag: '"abc123"', 'last-modified': 'Fri, 05 Sep 2026 10:00:00 GMT' })
      : mkRes(304, '');
  const h = harness({ handlers: { 'blog.kraken.com': kraken, 'www.cftc.gov': mkRes(200, rss([{ title: 'cftc note', guid: 'c1' }])) }, store });
  await tick(h);
  mode = '304';
  await tick(h);
  const cps = h.c.internals.checkpoint.providers.KRAKEN_OFFICIAL;
  assert.equal(cps.etag, '"abc123"');
  assert.equal(cps.consecutiveFailures, 0);
  const cov = h.c.internals.coverageEntries(h.clock.ms).find((c) => c.provider === 'KRAKEN_OFFICIAL');
  assert.equal(cov.state, 'OBSERVED', 'zero changed bytes is still a successful observation');
  await h.c.stop();
  // restart: the conditional headers ride out of the durable checkpoint
  const h2 = harness({ handlers: { 'blog.kraken.com': () => mkRes(304, ''), 'www.cftc.gov': mkRes(304, '') }, store });
  await tick(h2);
  const krakenCall = h2.fetchImpl.calls.find((c) => c.url.includes('kraken'));
  assert.equal(krakenCall.opts.headers['if-none-match'], '"abc123"');
  assert.equal(krakenCall.opts.headers['if-modified-since'], 'Fri, 05 Sep 2026 10:00:00 GMT');
  await h2.c.stop();
});

test('R2P-18+19. 429 activates bounded backoff honoring Retry-After', async () => {
  const h = harness({ handlers: { 'blog.kraken.com': mkRes(429, '', { 'retry-after': '120' }), 'www.cftc.gov': mkRes(429, '', { 'retry-after': '999999' }) } });
  await tick(h);
  const k = h.c.internals.checkpoint.providers.KRAKEN_OFFICIAL;
  const c = h.c.internals.checkpoint.providers.CFTC_OFFICIAL;
  assert.equal(k.backoffUntil - h.clock.ms, 120_000, 'Retry-After honored exactly when within bounds');
  assert.equal(c.backoffUntil - h.clock.ms, RETRY_AFTER_MAX_MS, 'an absurd Retry-After is capped, never a week of silence');
  assert.ok(k.backoffUntil - h.clock.ms >= RETRY_AFTER_MIN_MS);
  await h.c.stop();
});

test('R2P-20. one provider backoff does not silence other providers', async () => {
  const h = harness({
    handlers: {
      'blog.kraken.com': mkRes(429, '', { 'retry-after': '1800' }),
      'www.cftc.gov': mkRes(200, rss([{ title: 'cftc item', guid: 'c1' }])),
    },
  });
  await tick(h);
  const cftcCalls1 = h.fetchImpl.calls.filter((c) => c.url.includes('cftc')).length;
  await tick(h); // kraken is backing off; CFTC keeps listening
  const krakenCalls = h.fetchImpl.calls.filter((c) => c.url.includes('kraken')).length;
  const cftcCalls2 = h.fetchImpl.calls.filter((c) => c.url.includes('cftc')).length;
  assert.equal(krakenCalls, 1, 'kraken respected its backoff');
  assert.ok(cftcCalls2 > cftcCalls1, 'the CFTC ear kept polling');
  await h.c.stop();
});

// ---- SEC identification ------------------------------------------------------

test('R2P-sec. SEC is NOT_QUERIED without a configured contact; queried with one', async () => {
  const h = harness({ handlers: { 'www.sec.gov': mkRes(200, rss([{ title: 'sec item', guid: 's1' }])) }, contact: null });
  await tick(h);
  assert.equal(h.fetchImpl.calls.filter((c) => c.url.includes('sec.gov')).length, 0, 'no invented contact, no query');
  const cov = h.c.internals.coverageEntries(h.clock.ms).find((c) => c.provider === 'SEC_OFFICIAL');
  assert.equal(cov.state, 'NOT_QUERIED');
  assert.ok(cov.detail.includes('contact not configured'));
  await h.c.stop();
  const h2 = harness({ handlers: { 'www.sec.gov': mkRes(200, rss([{ title: 'sec item', guid: 's1' }])) }, contact: 'ops@example.com' });
  await tick(h2);
  const call = h2.fetchImpl.calls.find((c) => c.url.includes('sec.gov'));
  assert.ok(call, 'SEC queried once a contact exists');
  assert.ok(call.opts.headers['user-agent'].includes('ops@example.com'));
  assert.ok(call.opts.headers['user-agent'].startsWith('SerpentResearch/'), 'a clear research agent, never a browser impersonation');
  await h2.c.stop();
});

// ---- bootstrap + restart (mandates 25-26) -----------------------------------

test('R2P-25. first bootstrap accepts a bounded slice and never claims prior knowledge', async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ title: `archive item ${i}`, guid: `a${i}`, pub: T0 - (i + 1) * 86_400_000 }));
  const h = harness({ handlers: { 'blog.kraken.com': mkRes(200, rss(items)), 'www.cftc.gov': mkRes(304, '') } });
  await tick(h);
  const observed = h.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  assert.equal(observed.length, MAX_BOOTSTRAP_ITEMS, 'historical bootstrap bounded to 50');
  for (const o of observed) {
    assert.equal(o.knownAtTs, h.clock.ms, 'knownAt is NOW — never backdated to publication');
    assert.ok(o.publishedTs < o.knownAtTs, 'the publisher clock stays old');
  }
  await h.c.stop();
});

test('R2P-26. restart preserves provider clocks and cursors', async () => {
  const store = memStore();
  const h = harness({ handlers: { 'blog.kraken.com': mkRes(200, rss([{ title: 'one post', guid: 'g1' }]), { etag: '"e1"' }), 'www.cftc.gov': mkRes(304, '') }, store });
  await tick(h);
  const before = structuredClone(h.c.internals.checkpoint.providers.KRAKEN_OFFICIAL);
  await h.c.stop();
  const h2 = harness({ handlers: { 'blog.kraken.com': mkRes(304, ''), 'www.cftc.gov': mkRes(304, '') }, store });
  await tick(h2);
  const after = h2.c.internals.checkpoint.providers.KRAKEN_OFFICIAL;
  assert.equal(after.etag, before.etag);
  assert.deepEqual(after.seenIds, before.seenIds);
  assert.equal(after.bootstrapped, true);
  await h2.c.stop();
});

// ---- identity / crash consistency (mandates 30-33) --------------------------

test('R2P-30. duplicate feed item does not duplicate Memory evidence', async () => {
  const feed = mkRes(200, rss([{ title: 'repeat post', guid: 'g1' }]));
  const h = harness({ handlers: { 'blog.kraken.com': () => feed, 'www.cftc.gov': mkRes(304, '') } });
  await tick(h);
  await tick(h);
  const observed = h.events.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  assert.equal(observed.length, 1, 'one item, one observation');
  assert.ok(h.c.internals.runtime.KRAKEN_OFFICIAL.duplicates >= 1);
  await h.c.stop();
});

test('R2P-31. crash after append before checkpoint: restart does not double-write semantic evidence', async () => {
  const store = memStore();
  store.state.saveIsNoop = true; // simulated crash window: appends land, checkpoint never persists
  const h = harness({ handlers: { 'blog.kraken.com': mkRes(200, rss([{ title: 'crashy post', guid: 'g1' }])), 'www.cftc.gov': mkRes(304, '') }, store });
  await tick(h);
  const line1 = h.events.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  await h.c.stop();
  store.state.saveIsNoop = false;
  const h2 = harness({ handlers: { 'blog.kraken.com': mkRes(200, rss([{ title: 'crashy post', guid: 'g1' }])), 'www.cftc.gov': mkRes(304, '') }, store });
  await tick(h2);
  const line2 = h2.events.find((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  assert.ok(line1 && line2, 'the replayed item is re-observed after the crash');
  assert.equal(line1.sourceEventId, line2.sourceEventId, 'exactly the same semantic identity');
  // canonical Memory collapses the replay: the adapted envelopes share one id
  assert.equal(fromRumor2Event(line1).id, fromRumor2Event(line2).id, 'one memory, not two');
  await h2.c.stop();
});

test('R2P-32+33. failed append never marks seen; the retry writes exactly once', async () => {
  let failAppends = true;
  const captured = [];
  const appendEvent = (rec) => {
    if (failAppends && rec.type === 'RUMOR2_SOURCE_OBSERVED') throw new Error('disk full');
    captured.push(rec);
  };
  const h = harness({ handlers: { 'blog.kraken.com': mkRes(200, rss([{ title: 'retry post', guid: 'g1' }])), 'www.cftc.gov': mkRes(304, '') }, appendEvent });
  await tick(h);
  assert.equal(h.c.internals.checkpoint.providers.KRAKEN_OFFICIAL.seenIds.length, 0, 'not durably acknowledged => not seen');
  assert.equal(h.c.internals.checkpoint.counters.sourcesObserved, 0);
  assert.ok(h.c.internals.runtime.KRAKEN_OFFICIAL.appendFailures >= 1);
  failAppends = false;
  await tick(h);
  const observed = captured.filter((e) => e.type === 'RUMOR2_SOURCE_OBSERVED');
  assert.equal(observed.length, 1, 'the exact observation writes once');
  assert.equal(h.c.internals.checkpoint.providers.KRAKEN_OFFICIAL.seenIds.length, 1);
  await h.c.stop();
});

// ---- durability outage (mandate 70) -----------------------------------------

test('R2P-70. database outage degrades RUMOR-2 without consuming sources', async () => {
  const store = memStore();
  store.state.failLoad = { outcome: 'UNAVAILABLE', error: 'connection refused' };
  const h = harness({ handlers: { 'blog.kraken.com': mkRes(200, rss([{ title: 'unreachable-era post', guid: 'g1' }])) }, store });
  await tick(h);
  assert.equal(h.c.internals.lifecycle, 'FAILED_DURABILITY');
  assert.equal(h.fetchImpl.calls.length, 0, 'no ear polls while durable truth cannot be represented');
  // the outage heals; observation resumes
  store.state.failLoad = null;
  await tick(h);
  assert.ok(h.fetchImpl.calls.length > 0, 'recovery resumes observation');
  await h.c.stop();
});

// ---- default event stream + claim/packet end-to-end -------------------------

test('R2P-e2e. a real listing item flows to claim, packet, and the events file', async () => {
  const d = seedDir();
  const clock = { ms: T0 };
  const store = memStore();
  const fetchImpl = scriptedFetch({
    'blog.kraken.com': mkRes(200, rss([{ title: 'BTC trading starts on Kraken', guid: 'listing-1', desc: 'Bitcoin (BTC) is now available for trading.' }])),
    'www.cftc.gov': mkRes(304, ''),
  });
  const c = startRumor2({
    log: () => {},
    config: CONFIG,
    fetchImpl,
    now: () => clock.ms,
    intervalMs: 2_147_000_000,
    checkpointStore: store,
    contact: null,
    enabled: true,
    timeoutMs: 50,
  });
  clock.ms += 121_000;
  await c.tickOnce();
  await c.stop();
  const events = readJsonl(path.join(d, 'rumor2', 'events.jsonl'));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('RUMOR2_STARTED'));
  assert.ok(types.includes('RUMOR2_SOURCE_OBSERVED'));
  assert.ok(types.includes('RUMOR2_CLAIM_OBSERVED'));
  assert.ok(types.includes('RUMOR2_PACKET'));
  const packetEvt = events.find((e) => e.type === 'RUMOR2_PACKET');
  assert.equal(packetEvt.symbol, 'BTC');
  assert.equal(packetEvt.packet.schemaVersion, 'serpent-evidence-1');
  assert.equal(packetEvt.packet.claims[0].status, 'PRIMARY_CONFIRMED');
  const claimEvt = events.find((e) => e.type === 'RUMOR2_CLAIM_OBSERVED');
  assert.equal(claimEvt.claimType, 'EXCHANGE_LISTING');
});
