import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarcasterRuntime } from '../rumor2/social-farcaster-runtime.js';
import { FARCASTER_APPLICATION_ID, FARCASTER_USE_CASE_VERSION } from '../rumor2/social-farcaster-access.js';
import { buildSocialFilter } from '../rumor2/social.js';
import { replaySocialHistory, SOCIAL_OBSERVATION_TYPES } from '../rumor2/social-settle.js';
import { FARCASTER_REQUEST_TYPE } from '../rumor2/social-farcaster-meter.js';
import { buildFarcasterCatalogQuery } from '../rumor2/social-farcaster-query.js';
const T = Date.parse('2026-09-12T10:00:00Z');
const record = () => ({ approvalRef: 'fixture-only', status: 'ATTESTED', application: FARCASTER_APPLICATION_ID, useCaseVersion: FARCASTER_USE_CASE_VERSION, plan: 'FREE', credits: 'AVAILABLE', termsReview: 'REVIEWED_PERMITS', permittedUses: ['RETRIEVAL', 'DERIVED_FEATURES'], acquisitionPath: 'SEARCH_POLLING', acquisitionApproved: true, additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01' });
const cast = id => ({ object: 'cast', hash: `0x${id}`, author: { fid: 42, username: 'fixture' }, text: '$BTC fixture cast', timestamp: new Date(T - 10000).toISOString(), parent_hash: null });
function harness(extra = {}) {
  const events = []; let t = T, calls = 0, fail = false, reservationFail = false; let fence = true;
  const options = { env: { NEYNAR_API_KEY: 'fixture-key' }, config: { enabled: true, queries: ['$BTC'], maxDailyRequests: 3, resultLimit: 10, intervalMs: 60000 }, accountRecord: record(), now: () => t, filter: buildSocialFilter({ terms: ['BTC'] }), fetchImpl: async (url, init) => { calls++; assert.ok(!url.includes('fixture-key')); assert.equal(init.headers['x-api-key'], 'fixture-key'); assert.equal(new URL(url).searchParams.get('limit'), '10'); const token = new URL(url).searchParams.get('cursor'); return Response.json({ result: { casts: [cast(token ? 'second' : 'first')], next: { cursor: token ? null : 'opaque-next' } } }); }, ...extra };
  const append = async batch => { if (reservationFail && batch.some(e => e.type === FARCASTER_REQUEST_TYPE)) return { ok: false, reason: 'reservation storage unavailable' }; if (fail && batch.some(e => SOCIAL_OBSERVATION_TYPES.includes(e.type))) return { ok: false, reason: 'disk unavailable' }; for (const e of batch) if (!events.some(x => x.sourceEventId === e.sourceEventId)) events.push(e); return { ok: true, lastSeq: events.length }; };
  const hooks = { append, fenceHeld: () => fence };
  const make = () => { const rt = createFarcasterRuntime(options); assert.equal(rt.hydrate(events).ok, true); return rt; };
  return { make, hooks, events, advance: () => { t += 60000; }, calls: () => calls, fail: v => { fail = v; }, reservationFail: v => { reservationFail = v; }, fence: v => { fence = v; } };
}
test('Farcaster composes documented REST -> normalized social journal -> replay; restart repeats safely with the spent budget intact', async () => {
  const h = harness(); let r = h.make(); assert.equal(r.start().ok, true);
  assert.equal((await r.settle(h.hooks)).ok, true); assert.equal(h.calls(), 1); assert.equal(h.events[0].type, FARCASTER_REQUEST_TYPE);
  let history = replaySocialHistory(h.events); assert.equal(history.ok, true); assert.equal(history.observed, 1); assert.equal(history.cursors.FARCASTER_OFFICIAL, undefined, 'opaque search cursor is never invented as a source clock');
  await r.settle(h.hooks); h.advance(); await r.settle(h.hooks); await r.settle(h.hooks); assert.equal(h.calls(), 2); assert.equal(replaySocialHistory(h.events).observed, 2);
  r.stop(); r = h.make(); assert.equal(r.status().quota.requests, 2); r.start(); await r.settle(h.hooks); await r.settle(h.hooks); assert.equal(h.calls(), 3); assert.equal(replaySocialHistory(h.events).observed, 2, 'restart redelivery is logically idempotent');
  h.advance(); await r.settle(h.hooks); assert.equal(h.calls(), 3); assert.equal(r.status().gateReason, 'BUDGET_STOPPED'); r.stop();
});
test('Farcaster does not fetch the next page ahead of failed evidence storage and contains writer loss', async () => {
  const h = harness(); const r = h.make(); r.start(); h.fail(true); const failed = await r.settle(h.hooks); assert.equal(failed.ok, false); assert.equal(failed.committed.events[0].type, FARCASTER_REQUEST_TYPE);
  h.advance(); await r.settle(h.hooks); assert.equal(h.calls(), 1); h.fail(false); await r.settle(h.hooks); assert.equal(replaySocialHistory(h.events).observed, 1);
  await r.settle(h.hooks); assert.equal(h.calls(), 2); h.fence(false); assert.equal((await r.settle(h.hooks)).reason, 'WRITER_FENCE_LOST'); const n = h.events.length; await r.settle(h.hooks); assert.equal(h.events.length, n); r.stop();
});
test('Farcaster exposes request-reservation append failures and retries the same unspent reservation', async () => {
  const h = harness(); const r = h.make(); assert.equal(r.start().ok, true);
  h.reservationFail(true);
  assert.deepEqual(await r.settle(h.hooks), { ok: false, reason: 'reservation storage unavailable' });
  let status = r.status();
  assert.equal(h.calls(), 0, 'a request is never made before its durable quota reservation');
  assert.equal(status.quota.requests, 0, 'a failed reservation is not counted as durably spent');
  assert.equal(status.counters.reservationAppendFailures, 1);
  assert.equal(status.stats.appendFailures, 1, 'the provider status aggregate includes reservation append failures');
  assert.equal(status.lastError, 'reservation storage unavailable');
  h.reservationFail(false);
  assert.equal((await r.settle(h.hooks)).ok, true);
  status = r.status();
  assert.equal(h.calls(), 1);
  assert.equal(status.quota.requests, 1);
  assert.equal(h.events.filter(e => e.type === FARCASTER_REQUEST_TYPE).length, 1);
  r.stop();
});
test('Farcaster checks scoped access, explicit queries and caps independently; blocked gates make zero calls', () => {
  for (const extra of [{ accountRecord: null }, { env: {} }, { config: { enabled: true, queries: [], maxDailyRequests: 1, resultLimit: 10, intervalMs: 60000 } }, { config: { enabled: true, queries: ['BTC'], maxDailyRequests: null, resultLimit: 10, intervalMs: 60000 } }, { config: { enabled: true, queries: ['BTC'], maxDailyRequests: 1, resultLimit: 101, intervalMs: 60000 } }, { accountRecord: { ...record(), acquisitionPath: 'WEBHOOK' } }, { accountRecord: { ...record(), permittedUses: ['RETRIEVAL'] } }]) {
    const h = harness(extra); const r = h.make(); assert.equal(r.start().ok, false); assert.equal(h.calls(), 0); r.stop();
  }
});
test('Farcaster sends and enforces the configured per-search result cap', async () => {
  let requestedLimit = null;
  const h = harness({
    config: { enabled: true, queries: ['$BTC'], maxDailyRequests: 3, resultLimit: 1, intervalMs: 60000 },
    fetchImpl: async url => { requestedLimit = new URL(url).searchParams.get('limit'); return Response.json({ result: { casts: [cast('first'), cast('overflow')], next: {} } }); },
  });
  const r = h.make(); assert.equal(r.start().ok, true); await r.settle(h.hooks);
  assert.equal(requestedLimit, '1'); assert.equal(r.status().quota.resultLimit, 1); assert.equal(r.status().coverage, 'PARSE_FAILED');
  assert.equal(replaySocialHistory(h.events).observed, 0); r.stop();
});
test('catalog query planning rotates every accepted asset under one identical deterministic rule', () => {
  const bases = ['123', 'AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'];
  const contentId = 'a'.repeat(40);
  const candidate = { status: 'CATALOG_BACKED', catalog: { contentId, markets: bases.map(base => ({ base })) }, scope: { mode: 'CATALOG_BACKED', catalogContentId: contentId, terms: bases } };
  assert.deepEqual(buildFarcasterCatalogQuery({ candidate, requestOrdinal: 0, assetsPerQuery: 3 }).bases, ['123', 'AAA', 'BBB']);
  assert.deepEqual(buildFarcasterCatalogQuery({ candidate, requestOrdinal: 1, assetsPerQuery: 3 }).bases, ['CCC', 'DDD', 'EEE']);
  const wrapped = buildFarcasterCatalogQuery({ candidate, requestOrdinal: 2, assetsPerQuery: 3 });
  assert.deepEqual(wrapped.bases, ['FFF', 'GGG', '123']);
  assert.equal(wrapped.query, '$FFF OR $GGG OR "123/USD"');
  assert.match(buildFarcasterCatalogQuery({ candidate: { ...candidate, status: 'STALE' } }).error, /fresh accepted catalog/);
});
test('catalog rotation is wired to the existing runtime and resumes from durable request receipts', async () => {
  const bases = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']; const contentId = 'b'.repeat(40); const urls = [];
  const candidate = { status: 'CATALOG_BACKED', catalog: { contentId, markets: bases.map(base => ({ base })) }, scope: { mode: 'CATALOG_BACKED', catalogContentId: contentId, terms: bases } };
  const h = harness({
    config: { enabled: true, queryMode: 'CATALOG_ROTATION', queries: null, assetsPerQuery: 2, maxDailyRequests: 4, resultLimit: 1, intervalMs: 60000 },
    catalogQuerySource: { candidate: () => candidate }, filter: buildSocialFilter({ terms: bases }),
    fetchImpl: async url => { urls.push(new URL(url).searchParams.get('q')); return Response.json({ result: { casts: [], next: {} } }); },
  });
  let r = h.make(); assert.equal(r.start().ok, true); await r.settle(h.hooks); await r.settle(h.hooks);
  h.advance(); await r.settle(h.hooks); await r.settle(h.hooks); assert.deepEqual(urls, ['$AAA OR $BBB', '$CCC OR $DDD']);
  r.stop(); r = h.make(); assert.equal(r.start().ok, true); await r.settle(h.hooks);
  assert.deepEqual(urls, ['$AAA OR $BBB', '$CCC OR $DDD', '$EEE OR $AAA']);
  assert.equal(r.status().queryPolicy.totalRequestReservations, 3); r.stop();
});
test('catalog rotation samples one page per asset window so a busy query cannot starve later assets', async () => {
  const bases = ['AAA', 'BBB', 'CCC', 'DDD']; const contentId = 'c'.repeat(40); const requests = [];
  const candidate = { status: 'CATALOG_BACKED', catalog: { contentId, markets: bases.map(base => ({ base })) }, scope: { mode: 'CATALOG_BACKED', catalogContentId: contentId, terms: bases } };
  const h = harness({
    config: { enabled: true, queryMode: 'CATALOG_ROTATION', queries: null, assetsPerQuery: 2, maxDailyRequests: 4, resultLimit: 1, intervalMs: 60000 },
    catalogQuerySource: { candidate: () => candidate }, filter: buildSocialFilter({ terms: bases }),
    fetchImpl: async url => { const parsed = new URL(url); requests.push({ q: parsed.searchParams.get('q'), cursor: parsed.searchParams.get('cursor') }); return Response.json({ result: { casts: [], next: { cursor: 'more-results' } } }); },
  });
  const r = h.make(); assert.equal(r.start().ok, true); await r.settle(h.hooks); await r.settle(h.hooks);
  h.advance(); await r.settle(h.hooks);
  assert.deepEqual(requests, [{ q: '$AAA OR $BBB', cursor: null }, { q: '$CCC OR $DDD', cursor: null }]);
  assert.equal(r.status().coverage, 'SEARCH_PAGE_PARTIAL'); r.stop();
});
test('Farcaster rejects malformed pages, rate limits and HTTP error data; reservations remain spent', async () => {
  for (const response of [() => Response.json({ result: { casts: [], next: {} } }, { status: 403 }), () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }), () => Response.json({ result: { casts: [null], next: {} } })]) {
    const h = harness({ fetchImpl: async () => response() }); const r = h.make(); r.start(); await r.settle(h.hooks); assert.equal(r.status().quota.requests, 1); assert.equal(replaySocialHistory(h.events).observed, 0); r.stop();
  }
});
test('Farcaster stop during response makes the late body inert', async () => {
  let release; const h = harness({ fetchImpl: () => new Promise(resolve => { release = resolve; }) }); const r = h.make(); r.start(); const pending = r.settle(h.hooks); await new Promise(resolve => setImmediate(resolve)); r.stop(); release(Response.json({ result: { casts: [cast('late')], next: {} } })); await pending; assert.equal(replaySocialHistory(h.events).observed, 0);
});
