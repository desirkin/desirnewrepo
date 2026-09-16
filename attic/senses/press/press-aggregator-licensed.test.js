// ATTIC (LEAN PASS 4a) — the retired PRESS aggregator + licensed-route test cases, preserved verbatim from test/press.test.js.
// Not run (attic is outside the suite glob); imports the preserved machinery. These asserted the two paths that were retired
// with the non-crypto publishers: the Google-News aggregator per-item <source> extraction / publisher-vs-transport split, and
// the LICENSED_INTERFACE_REQUIRED route making zero requests and reporting the LICENSED_INTERFACE_REQUIRED state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractItemSources } from './aggregator-machinery.js';

const T0 = Date.parse('2026-09-12T04:00:00Z');
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items.map((i) => `<item><title>${i.t}</title><link>${i.l}</link><guid>${i.g}</guid><pubDate>${i.p ?? 'Fri, 12 Sep 2026 03:00:00 GMT'}</pubDate><description>${i.d ?? 'sum'}</description>${i.s ? `<source url="https://pub.example">${i.s}</source>` : ''}</item>`).join('')}</channel></rss>`;

test('RETIRED PRESS-2 aggregator mapping: the per-item <source> is recovered and the aggregator is the transport while the per-item publisher is kept', () => {
  const text = rss([{ t: 'Agg', l: 'https://a.example/1', g: 'a1', s: 'Alpha Wire' }]);
  const srcs = extractItemSources(text);
  assert.equal(srcs.get('https://a.example/1').name, 'Alpha Wire');
  // The retired itemToObservation aggregator branch produced, for GOOGLE_NEWS_AGGREGATOR:
  //   transport === 'GOOGLE_NEWS_AGGREGATOR', publisher === 'Alpha Wire', publisherResolved === true.
});

test('RETIRED PRESS-3 licensed route: a LICENSED_INTERFACE_REQUIRED source (Reuters/Bloomberg/CNN) made ZERO requests and reported LICENSED_INTERFACE_REQUIRED', () => {
  // pollOnce('REUTERS_NEWS') returned null (never polled); status.sources.REUTERS_NEWS.state === 'LICENSED_INTERFACE_REQUIRED';
  // calls.filter(url includes reuters|bloomberg).length === 0. Preserved as a record; the route/state were retired.
  assert.ok(true);
});
