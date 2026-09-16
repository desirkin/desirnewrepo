// YouTube Social source: deterministic request / quota / fixture boundaries.
// No provider call is made by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_OFFICIAL, YOUTUBE_QUOTA_UNIT_COST,
  youtubeCredentialPresent, youtubeQuotaBudgetFromEnv,
  youtubeWatchlistFromSocialScope, youtubeSearchRequest,
  youtubeDispatchGate, youtubeSearchItemToRaw, youtubeSearchResponseToRaw,
  youtubeSearchResponseToObservations,
  youtubeSearchResponseWithinBounds,
} from '../rumor2/providers/youtube-official.js';
import { normalizeSocialObservation } from '../rumor2/social.js';
import { socialProviderById } from '../rumor2/social-registry.js';
import { providerReadinessRow } from '../rumor2/social-readiness.js';

const SCOPE = { ok: true, scopeId: 'b'.repeat(40), catalogContentId: 'a'.repeat(40), tickers: ['ETH', 'BTC'], aliases: ['bitcoin'] };
const ENV = {
  RUMOR2_SOCIAL_YOUTUBE_ENABLED: 'true',
  YOUTUBE_API_KEY: 'fixture-key-never-returned',
  RUMOR2_SOCIAL_YOUTUBE_MAX_DAILY_QUOTA_UNITS: '1000',
  RUMOR2_SOCIAL_YOUTUBE_MAX_MONTHLY_QUOTA_UNITS: '10000',
};
const ITEM = {
  kind: 'youtube#searchResult',
  id: { kind: 'youtube#video', videoId: 'abc_123' },
  snippet: {
    publishedAt: '2026-09-12T10:00:00Z',
    channelId: 'UCfixture123',
    channelTitle: 'Fixture Channel',
    title: 'BTC market listing research',
    description: 'A deterministic fixture, not a provider receipt.',
  },
};

test('YOUTUBE-1: registry is read-only, source-only, dark, and disabled by default', () => {
  const p = socialProviderById('YOUTUBE_OFFICIAL');
  assert.ok(p);
  assert.equal(p.accessState, 'AVAILABLE_REQUIRES_CREDENTIAL');
  assert.equal(p.implemented, true);
  assert.equal(p.durable, false);
  assert.equal(p.runtimeGated, true);
  assert.equal(p.credentialEnv, 'YOUTUBE_API_KEY');
  assert.equal(p.cost.searchListUnits, 100);
  assert.equal(p.cost.dailyBudgetEnv, 'RUMOR2_SOCIAL_YOUTUBE_MAX_DAILY_QUOTA_UNITS');
  assert.equal(p.cost.monthlyBudgetEnv, 'RUMOR2_SOCIAL_YOUTUBE_MAX_MONTHLY_QUOTA_UNITS');
  assert.equal(p.cost.maxWatchlistAssets, 25);
  assert.equal(socialProviderById('YOUTUBE_OFFICIAL').id, YOUTUBE_OFFICIAL.id);
});

test('YOUTUBE-2: only a verified bounded existing Social scope produces a request descriptor', () => {
  const watch = youtubeWatchlistFromSocialScope(SCOPE);
  assert.equal(watch.error, undefined);
  assert.deepEqual(watch.tickers, ['BTC', 'ETH']);
  const req = youtubeSearchRequest({ watchlist: watch, maxResults: 2 });
  assert.equal(req.error, undefined);
  assert.equal(req.method, 'GET');
  assert.equal(req.host, 'www.googleapis.com');
  assert.equal(req.path, '/youtube/v3/search');
  assert.equal(req.query.part, 'snippet');
  assert.equal(req.query.type, 'video');
  assert.equal(req.query.maxResults, 2);
  assert.match(req.query.q, /BTC/);
  assert.equal(req.quotaUnits, YOUTUBE_QUOTA_UNIT_COST);
  assert.deepEqual(req.credential, { env: 'YOUTUBE_API_KEY', value: null });
  assert.equal(req.sent, false);
  assert.deepEqual(youtubeSearchItemToRaw(ITEM, { provider: 'OTHER_PROVIDER' }), { error: 'PROVIDER_ID_OVERRIDE_FORBIDDEN' });
  assert.equal(youtubeSearchResponseToRaw({ kind: 'youtube#searchListResponse', items: [ITEM] }, { provider: 'OTHER_PROVIDER' }).error, 'PROVIDER_ID_OVERRIDE_FORBIDDEN');
  assert.equal(youtubeSearchResponseToObservations({ kind: 'youtube#searchListResponse', items: [ITEM] }, { receivedTs: Date.parse('2026-09-12T10:00:01Z'), provider: 'OTHER_PROVIDER' }).error, 'PROVIDER_ID_OVERRIDE_FORBIDDEN');
  assert.equal(youtubeSearchRequest({ watchlist: null }).error, 'WATCH_SCOPE_NOT_CONFIGURED');
  assert.equal(youtubeWatchlistFromSocialScope({ ok: true, tickers: ['BTC'] }).error, 'WATCH_SCOPE_NOT_CONFIGURED_OR_NOT_FROM_SOCIAL_SCOPE');
  assert.equal(youtubeWatchlistFromSocialScope({ ...SCOPE, scopeId: 'scope-fixture-1' }).error, 'WATCH_SCOPE_ID_MALFORMED');
  assert.equal(youtubeWatchlistFromSocialScope({ ...SCOPE, catalogContentId: 'not-a-content-id' }).error, 'WATCH_SCOPE_CATALOG_CONTENT_ID_MALFORMED');
  assert.equal(youtubeWatchlistFromSocialScope({ ...SCOPE, tickers: Array.from({ length: 26 }, (_, i) => `X${i}`) }).error, 'WATCH_SCOPE_EXCEEDS_YOUTUBE_CAP');
});

test('YOUTUBE-3: quota gate fails closed and exposes credential NAME, never its value', () => {
  assert.equal(youtubeCredentialPresent({ YOUTUBE_API_KEY: 'secret' }), true);
  const missing = youtubeDispatchGate({ env: { RUMOR2_SOCIAL_YOUTUBE_ENABLED: 'true' }, watchlist: SCOPE });
  assert.equal(missing.dispatchAllowed, false);
  assert.equal(missing.state, 'BLOCKED_CREDENTIAL');
  assert.ok(missing.blockers.includes('CREDENTIAL_MISSING'));
  assert.ok(missing.blockers.includes('BUDGET_NOT_CONFIGURED'));
  assert.equal(JSON.stringify(missing).includes('secret'), false);
  const ready = youtubeDispatchGate({ env: ENV, watchlist: SCOPE });
  assert.equal(ready.dispatchAllowed, false);
  assert.equal(ready.state, 'CODE_COMPLETE_NO_LIVE_COLLECTOR');
  assert.ok(ready.blockers.includes('DURABLE_QUOTA_ADMISSION_REQUIRED'));
  assert.deepEqual(youtubeQuotaBudgetFromEnv(ENV).errors, []);
  assert.deepEqual(youtubeQuotaBudgetFromEnv({ ...ENV, RUMOR2_SOCIAL_YOUTUBE_MAX_DAILY_QUOTA_UNITS: '99' }).errors, ['DAILY_QUOTA_BUDGET_BELOW_SEARCH_LIST_COST']);
  const disabled = youtubeDispatchGate({ env: { ...ENV, RUMOR2_SOCIAL_YOUTUBE_ENABLED: 'false' }, watchlist: SCOPE });
  assert.equal(disabled.state, 'DISABLED');
  assert.equal(disabled.dispatchAllowed, false);
});

test('YOUTUBE-4: search fixture maps stable native video/channel identity and all shared clocks without fabricating event clocks', () => {
  const mapped = youtubeSearchItemToRaw(ITEM);
  assert.equal(mapped.skip, undefined);
  assert.equal(mapped.raw.nativePostId, 'abc_123');
  assert.equal(mapped.raw.nativeAuthorId, 'UCfixture123');
  assert.equal(mapped.raw.providerEventTs, null);
  assert.equal(mapped.raw.providerEventSeq, null);
  assert.equal(mapped.raw.nativeVersionId, null);
  assert.equal(mapped.raw.relation, 'ORIGINAL');
  assert.equal(mapped.raw.editState, 'ORIGINAL');
  const normalized = normalizeSocialObservation(mapped.raw, { nowMs: Date.parse('2026-09-12T10:00:01Z') });
  assert.equal(normalized.ok, true, normalized.reason);
  assert.equal(normalized.observation.sourceCreatedTs, Date.parse('2026-09-12T10:00:00Z'));
  assert.equal(normalized.observation.retrievedTs, Date.parse('2026-09-12T10:00:01Z'));
  assert.equal(normalized.observation.knownAtTs, normalized.observation.retrievedTs);
  assert.equal(typeof normalized.observation.socialSourceId, 'string');
  assert.equal(youtubeSearchItemToRaw({ ...ITEM, id: { kind: 'youtube#channel', channelId: 'UCx' } }).skip, true);
  assert.equal(youtubeSearchItemToRaw({ ...ITEM, snippet: { ...ITEM.snippet, channelId: '' } }).skip, true);
  const batch = youtubeSearchResponseToObservations({ kind: 'youtube#searchListResponse', items: [ITEM] }, { receivedTs: Date.parse('2026-09-12T10:00:01Z') });
  assert.equal(batch.receivedTs, Date.parse('2026-09-12T10:00:01Z'));
  assert.equal(batch.observations[0].retrievedTs, batch.receivedTs);
  assert.equal(batch.observations[0].knownAtTs, batch.receivedTs);
  assert.equal(batch.observations[0].providerEventTs, null);
  assert.equal(youtubeSearchResponseToObservations({ kind: 'youtube#searchListResponse', items: [ITEM] }, {}).error, 'RECEIPT_CLOCK_REQUIRED');
});

test('YOUTUBE-5: response/resource bounds are deterministic and deletion support is honestly absent', () => {
  const parsed = youtubeSearchResponseToRaw({ kind: 'youtube#searchListResponse', items: [ITEM], nextPageToken: 'next_1' });
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.raws.length, 1);
  assert.equal(parsed.nextPageToken, 'next_1');
  assert.equal(parsed.deletionSupport, 'NOT_PROVIDED_BY_SEARCH_LIST');
  assert.equal(youtubeSearchResponseToRaw({ kind: 'youtube#searchListResponse', items: Array.from({ length: 51 }, () => ITEM) }).error, 'SEARCH_RESPONSE_ITEM_CAP_EXCEEDED');
  assert.equal(youtubeSearchResponseWithinBounds({ kind: 'youtube#searchListResponse', items: [ITEM] }, { maxBytes: 10 }), false);
});

test('YOUTUBE-6: readiness calls the code-complete boundary blocked, never a receipt', () => {
  const row = providerReadinessRow('YOUTUBE_OFFICIAL', { evaluation: { blockers: ['CREDENTIAL_MISSING', 'BUDGET_NOT_CONFIGURED'] } });
  assert.equal(row.readiness, 'NOT_CONFIGURED');
  assert.ok(row.blockers.includes('CREDENTIAL_MISSING'));
  assert.ok(row.blockers.includes('BUDGET_NOT_CONFIGURED'));
  assert.equal(row.transportImplemented, false, 'the fixture/request adapter is code-complete but no shared live transport is composed');
  assert.equal(row.durableRawContentAllowed, false);
  assert.equal(row.operationalEvidenceAvailable, false);
  assert.equal(row.liveSmokeState, 'NOT_PERFORMED');
  assert.equal(row.authority, 'NONE');
});