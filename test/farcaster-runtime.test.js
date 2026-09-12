import test from 'node:test';
import assert from 'node:assert/strict';
import { createFarcasterRuntime } from '../rumor2/social-farcaster-runtime.js';
import { FARCASTER_APPLICATION_ID, FARCASTER_USE_CASE_VERSION } from '../rumor2/social-farcaster-access.js';
import { buildSocialFilter } from '../rumor2/social.js';
import { replaySocialHistory, SOCIAL_OBSERVATION_TYPES } from '../rumor2/social-settle.js';
import { FARCASTER_REQUEST_TYPE } from '../rumor2/social-farcaster-meter.js';
const T = Date.parse('2026-09-12T10:00:00Z');
const record = () => ({ approvalRef: 'fixture-only', status: 'ATTESTED', application: FARCASTER_APPLICATION_ID, useCaseVersion: FARCASTER_USE_CASE_VERSION, plan: 'FREE', credits: 'AVAILABLE', termsReview: 'REVIEWED_PERMITS', permittedUses: ['RETRIEVAL', 'DERIVED_FEATURES'], acquisitionPath: 'SEARCH_POLLING', acquisitionApproved: true, additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false, validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01' });
const cast = id => ({ object: 'cast', hash: `0x${id}`, author: { fid: 42, username: 'fixture' }, text: '$BTC fixture cast', timestamp: new Date(T - 10000).toISOString(), parent_hash: null });
function harness(extra = {}) {
  const events = []; let t = T, calls = 0, fail = false; let fence = true;
  const options = { env: { NEYNAR_API_KEY: 'fixture-key' }, config: { enabled: true, queries: ['$BTC'], maxDailyRequests: 3, intervalMs: 60000 }, accountRecord: record(), now: () => t, filter: buildSocialFilter({ terms: ['BTC'] }), fetchImpl: async (url, init) => { calls++; assert.ok(!url.includes('fixture-key')); assert.equal(init.headers['x-api-key'], 'fixture-key'); const token = new URL(url).searchParams.get('cursor'); return Response.json({ result: { casts: [cast(token ? 'second' : 'first')], next: { cursor: token ? null : 'opaque-next' } } }); }, ...extra };
  const append = async batch => { if (fail && batch.some(e => SOCIAL_OBSERVATION_TYPES.includes(e.type))) return { ok: false, reason: 'disk unavailable' }; for (const e of batch) if (!events.some(x => x.sourceEventId === e.sourceEventId)) events.push(e); return { ok: true, lastSeq: events.length }; };
  const hooks = { append, fenceHeld: () => fence };
  const make = () => { const rt = createFarcasterRuntime(options); assert.equal(rt.hydrate(events).ok, true); return rt; };
  return { make, hooks, events, advance: () => { t += 60000; }, calls: () => calls, fail: v => { fail = v; }, fence: v => { fence = v; } };
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
test('Farcaster checks scoped access, explicit queries and caps independently; blocked gates make zero calls', () => {
  for (const extra of [{ accountRecord: null }, { env: {} }, { config: { enabled: true, queries: [], maxDailyRequests: 1, intervalMs: 60000 } }, { config: { enabled: true, queries: ['BTC'], maxDailyRequests: null, intervalMs: 60000 } }, { accountRecord: { ...record(), acquisitionPath: 'WEBHOOK' } }, { accountRecord: { ...record(), permittedUses: ['RETRIEVAL'] } }]) {
    const h = harness(extra); const r = h.make(); assert.equal(r.start().ok, false); assert.equal(h.calls(), 0); r.stop();
  }
});
test('Farcaster rejects malformed pages, rate limits and HTTP error data; reservations remain spent', async () => {
  for (const response of [() => Response.json({ result: { casts: [], next: {} } }, { status: 403 }), () => new Response(null, { status: 429, headers: { 'retry-after': '3600' } }), () => Response.json({ result: { casts: [null], next: {} } })]) {
    const h = harness({ fetchImpl: async () => response() }); const r = h.make(); r.start(); await r.settle(h.hooks); assert.equal(r.status().quota.requests, 1); assert.equal(replaySocialHistory(h.events).observed, 0); r.stop();
  }
});
test('Farcaster stop during response makes the late body inert', async () => {
  let release; const h = harness({ fetchImpl: () => new Promise(resolve => { release = resolve; }) }); const r = h.make(); r.start(); const pending = r.settle(h.hooks); await new Promise(resolve => setImmediate(resolve)); r.stop(); release(Response.json({ result: { casts: [cast('late')], next: {} } })); await pending; assert.equal(replaySocialHistory(h.events).observed, 0);
});
