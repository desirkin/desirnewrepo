// SOCIAL-YOUTUBE — YouTube Data API v3, read-only search.list foundation.
//
// This module is deliberately PURE.  It builds bounded request DESCRIPTIONS and
// maps recorded search.list fixtures to the shared Social observation shape; it
// never imports a HTTP client, reads a credential value, or calls a provider.
// A future caller must pass the returned descriptor through the repository's
// durable quota/accounting guard before it can dispatch anything; this module's
// local gate intentionally never grants that admission.
//
// The only approved route is:
//   GET https://www.googleapis.com/youtube/v3/search
// with part=snippet and type=video.  Search.list costs 100 quota units per
// request (the unit is charged even when the response is empty).  No videos.list,
// channels.list, comments, uploads, OAuth mutation, or account operation is
// represented here.
import { temporalWitness, SOCIAL_TIME_POLICIES } from '../social-time.js';
import { MAX_SOCIAL_TEXT_CHARS, MAX_SOCIAL_URL_CHARS, normalizeSocialObservation } from '../social.js';

export const YOUTUBE_OFFICIAL = Object.freeze({
  id: 'YOUTUBE_OFFICIAL',
  providerKind: 'SOCIAL_MICROBLOG',
  organization: 'GOOGLE_YOUTUBE',
  transport: 'REST_SEARCH_LIST',
  hosts: Object.freeze(['www.googleapis.com']),
  searchPath: '/youtube/v3/search',
  credentialEnv: 'YOUTUBE_API_KEY', // NAME only; never a key value
  enableEnv: 'RUMOR2_SOCIAL_YOUTUBE_ENABLED',
  quota: Object.freeze({
    unitsPerSearchList: 100,
    dailyBudgetEnv: 'RUMOR2_SOCIAL_YOUTUBE_MAX_DAILY_QUOTA_UNITS',
    monthlyBudgetEnv: 'RUMOR2_SOCIAL_YOUTUBE_MAX_MONTHLY_QUOTA_UNITS',
    maxResults: 50,
    maxWatchlistAssets: 25,
  }),
  readOnly: true,
  deletionSupport: 'NOT_PROVIDED_BY_SEARCH_LIST',
  docUrl: 'https://developers.google.com/youtube/v3/docs/search/list',
});

export const YOUTUBE_QUOTA_UNIT_COST = YOUTUBE_OFFICIAL.quota.unitsPerSearchList;
export const YOUTUBE_QUOTA_ENV_NAMES = Object.freeze([
  YOUTUBE_OFFICIAL.quota.dailyBudgetEnv,
  YOUTUBE_OFFICIAL.quota.monthlyBudgetEnv,
]);
export const YOUTUBE_WATCHLIST_MAX_ASSETS = YOUTUBE_OFFICIAL.quota.maxWatchlistAssets;
export const YOUTUBE_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
export const YOUTUBE_PAGE_TOKEN_MAX_CHARS = 512;
export const YOUTUBE_QUERY_MAX_CHARS = 500;
export const YOUTUBE_TITLE_MAX_CHARS = 500;
export const YOUTUBE_DESCRIPTION_MAX_CHARS = 4_000;
const ENABLE_ENV = YOUTUBE_OFFICIAL.enableEnv;
const HOST = YOUTUBE_OFFICIAL.hosts[0];
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TICKER_RE = /^[A-Z0-9]{2,15}$/;
const ALIAS_RE = /^[a-z][a-z0-9]{2,20}$/;
const CONTENT_ID_RE = /^[0-9a-f]{40}$/;
const PAGE_TOKEN_RE = /^[A-Za-z0-9_.~+/=-]{1,512}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boundedInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v > 0 && v <= max;
const freeze = (v) => Object.freeze(v);
const providerIdentityError = (provider) => provider === undefined || provider === YOUTUBE_OFFICIAL.id ? null : 'PROVIDER_ID_OVERRIDE_FORBIDDEN';

// Presence is the only credential fact this module exposes.  No value is ever
// copied into a descriptor, error, status, or returned object.
export function youtubeCredentialPresent(env = process.env) {
  return typeof env?.[YOUTUBE_OFFICIAL.credentialEnv] === 'string' && env[YOUTUBE_OFFICIAL.credentialEnv].length > 0;
}

const readQuota = (env, name) => {
  const value = env?.[name];
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || value.length > 9) return null;
  const n = Number(value);
  return boundedInt(n, 10_000_000) ? n : null;
};

// A configured budget is never inferred from Google's published default quota.
// Missing, malformed, or too-small caps fail closed before a request can be
// considered dispatchable.
export function youtubeQuotaBudgetFromEnv(env = process.env) {
  const daily = readQuota(env, YOUTUBE_OFFICIAL.quota.dailyBudgetEnv);
  const monthly = readQuota(env, YOUTUBE_OFFICIAL.quota.monthlyBudgetEnv);
  const errors = [];
  if (daily === null) errors.push('DAILY_QUOTA_BUDGET_MISSING_OR_MALFORMED');
  if (monthly === null) errors.push('MONTHLY_QUOTA_BUDGET_MISSING_OR_MALFORMED');
  if (daily !== null && daily < YOUTUBE_QUOTA_UNIT_COST) errors.push('DAILY_QUOTA_BUDGET_BELOW_SEARCH_LIST_COST');
  if (monthly !== null && monthly < YOUTUBE_QUOTA_UNIT_COST) errors.push('MONTHLY_QUOTA_BUDGET_BELOW_SEARCH_LIST_COST');
  return freeze({
    configured: errors.length === 0,
    dailyUnits: daily,
    monthlyUnits: monthly,
    errors: freeze(errors),
    envNames: YOUTUBE_QUOTA_ENV_NAMES,
    unitCost: YOUTUBE_QUOTA_UNIT_COST,
  });
}

// Accept only a watchlist produced by the existing social scope machinery.
// A raw catalog, config.universe, wildcard, or an omitted scope is not a
// watchlist and cannot authorize a YouTube query.
export function youtubeWatchlistFromSocialScope(scope) {
  if (!isObj(scope) || scope.ok !== true || !Array.isArray(scope.tickers) || typeof scope.scopeId !== 'string' || scope.scopeId.length === 0) {
    return { error: 'WATCH_SCOPE_NOT_CONFIGURED_OR_NOT_FROM_SOCIAL_SCOPE' };
  }
  if (!CONTENT_ID_RE.test(scope.scopeId)) return { error: 'WATCH_SCOPE_ID_MALFORMED' };
  if (scope.catalogContentId !== undefined && scope.catalogContentId !== null && (typeof scope.catalogContentId !== 'string' || !CONTENT_ID_RE.test(scope.catalogContentId))) return { error: 'WATCH_SCOPE_CATALOG_CONTENT_ID_MALFORMED' };
  const tickers = [...new Set(scope.tickers.filter((x) => typeof x === 'string' && TICKER_RE.test(x)))].sort();
  const aliases = [...new Set((Array.isArray(scope.aliases) ? scope.aliases : []).filter((x) => typeof x === 'string' && ALIAS_RE.test(x.toLowerCase())).map((x) => x.toLowerCase()))].sort();
  if (tickers.length === 0) return { error: 'WATCH_SCOPE_EMPTY_AFTER_VERIFICATION' };
  if (tickers.length > YOUTUBE_WATCHLIST_MAX_ASSETS) return { error: 'WATCH_SCOPE_EXCEEDS_YOUTUBE_CAP' };
  return freeze({
    source: 'SOCIAL_SCOPE',
    scopeId: scope.scopeId,
    catalogContentId: typeof scope.catalogContentId === 'string' ? scope.catalogContentId : null,
    tickers: freeze(tickers),
    aliases: freeze(aliases),
    assetCount: tickers.length,
  });
}

const queryTerm = (s) => `"${s.replace(/["\\|]/g, '').slice(0, 64)}"`;

// Pure request descriptor.  It deliberately contains the credential ENV NAME,
// never `process.env[YOUTUBE_API_KEY]`, and `sent:false` is part of the shape.
export function youtubeSearchRequest({ watchlist, pageToken = null, maxResults = 25, publishedAfter = null } = {}) {
  if (!watchlist || watchlist.source !== 'SOCIAL_SCOPE' || !Array.isArray(watchlist.tickers) || watchlist.tickers.length === 0) {
    return { error: 'WATCH_SCOPE_NOT_CONFIGURED' };
  }
  if (watchlist.tickers.length > YOUTUBE_WATCHLIST_MAX_ASSETS) return { error: 'WATCH_SCOPE_EXCEEDS_YOUTUBE_CAP' };
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > YOUTUBE_OFFICIAL.quota.maxResults) return { error: 'MAX_RESULTS_OUTSIDE_BOUNDED_RANGE' };
  if (pageToken !== null && (typeof pageToken !== 'string' || !PAGE_TOKEN_RE.test(pageToken))) return { error: 'PAGE_TOKEN_MALFORMED' };
  if (publishedAfter !== null && (typeof publishedAfter !== 'string' || temporalWitness(publishedAfter, SOCIAL_TIME_POLICIES.RFC3339).projectionMs === null)) return { error: 'PUBLISHED_AFTER_MALFORMED' };
  const terms = [...new Set([...watchlist.tickers, ...(watchlist.aliases ?? [])])].sort();
  const q = terms.map(queryTerm).join(' | ');
  if (q.length === 0 || q.length > YOUTUBE_QUERY_MAX_CHARS) return { error: 'QUERY_OUTSIDE_BOUNDED_RANGE' };
  const query = Object.freeze({
    part: 'snippet', type: 'video', maxResults, q,
    ...(pageToken === null ? {} : { pageToken }),
    ...(publishedAfter === null ? {} : { publishedAfter }),
  });
  return freeze({
    method: 'GET',
    host: HOST,
    path: YOUTUBE_OFFICIAL.searchPath,
    query,
    credential: freeze({ env: YOUTUBE_OFFICIAL.credentialEnv, value: null }),
    quotaUnits: YOUTUBE_QUOTA_UNIT_COST,
    readOnly: true,
    sent: false,
  });
}

// This is the pre-dispatch fence.  It is intentionally separate from request
// construction so a valid descriptor cannot be mistaken for permission to
// spend quota.  There is no dispatch implementation in this module.
export function youtubeDispatchGate({ env = process.env, watchlist = null, enabled = env?.[ENABLE_ENV] === 'true' } = {}) {
  const blockers = [];
  const budget = youtubeQuotaBudgetFromEnv(env);
  if (!enabled) blockers.push('DISABLED_BY_POLICY');
  if (!youtubeCredentialPresent(env)) blockers.push('CREDENTIAL_MISSING');
  if (!budget.configured) blockers.push('BUDGET_NOT_CONFIGURED');
  const scope = youtubeWatchlistFromSocialScope(watchlist);
  if (scope.error) blockers.push(scope.error);
  // Configured caps are not durable accounting.  This adapter has no composed
  // collector or repository quota journal, so it must never authorize spend.
  blockers.push('DURABLE_QUOTA_ADMISSION_REQUIRED');
  return freeze({
    provider: YOUTUBE_OFFICIAL.id,
    enabled: enabled === true,
    credentialPresent: youtubeCredentialPresent(env),
    credentialEnv: YOUTUBE_OFFICIAL.credentialEnv,
    budget,
    watchlist: scope.error ? null : scope,
    dispatchAllowed: false,
    state: blockers.includes('DISABLED_BY_POLICY') ? 'DISABLED' : blockers.includes('CREDENTIAL_MISSING') ? 'BLOCKED_CREDENTIAL' : blockers.includes('BUDGET_NOT_CONFIGURED') ? 'BLOCKED_BUDGET' : scope.error ? 'BLOCKED_WATCH_SCOPE' : 'CODE_COMPLETE_NO_LIVE_COLLECTOR',
    blockers: freeze([...new Set(blockers)]),
    receiptClaim: 'NONE',
  });
}

// ---- fixture mapper -----------------------------------------------------------
const textOf = (snippet) => {
  const title = typeof snippet?.title === 'string' ? snippet.title.slice(0, YOUTUBE_TITLE_MAX_CHARS) : '';
  const description = typeof snippet?.description === 'string' ? snippet.description.slice(0, YOUTUBE_DESCRIPTION_MAX_CHARS) : '';
  return `${title}${title && description ? '\n' : ''}${description}`.slice(0, MAX_SOCIAL_TEXT_CHARS);
};

// Map one official search.list item. Search.list has no deletion stream: a
// missing/removed item is not converted into a fabricated tombstone. Deletion
// support therefore remains explicitly NOT_PROVIDED_BY_SEARCH_LIST.
export function youtubeSearchItemToRaw(item, { provider = YOUTUBE_OFFICIAL.id } = {}) {
  const identityError = providerIdentityError(provider);
  if (identityError) return { error: identityError };
  if (!isObj(item) || !isObj(item.id) || item.id.kind !== 'youtube#video' || !VIDEO_ID_RE.test(item.id.videoId ?? '')) return { skip: true, reason: 'search item is not a bounded video result' };
  const snippet = isObj(item.snippet) ? item.snippet : null;
  const channelId = snippet?.channelId;
  if (!CHANNEL_ID_RE.test(channelId ?? '')) return { skip: true, reason: 'video result has no bounded channel id' };
  const sourceClockWitness = temporalWitness(snippet.publishedAt, SOCIAL_TIME_POLICIES.RFC3339);
  const videoId = item.id.videoId;
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  if (canonicalUrl.length > MAX_SOCIAL_URL_CHARS) return { skip: true, reason: 'canonical URL exceeds bound' };
  return {
    raw: {
      provider, providerKind: YOUTUBE_OFFICIAL.providerKind,
      nativePostId: videoId, nativeAuthorId: channelId,
      text: textOf(snippet), relation: 'ORIGINAL', parentNativePostId: null,
      editState: 'ORIGINAL', canonicalUrl, threadId: videoId,
      nativeVersionId: null, providerEventSeq: null, providerEventTs: null, providerEventWitness: null,
      handle: typeof snippet.channelTitle === 'string' ? snippet.channelTitle.slice(0, 200) : null,
      sourceDeclaredTs: sourceClockWitness.projectionMs, sourceClockWitness,
      engagement: null, authorMeta: null,
    },
  };
}

export function youtubeSearchResponseToRaw(body, { provider = YOUTUBE_OFFICIAL.id, maxItems = YOUTUBE_OFFICIAL.quota.maxResults } = {}) {
  const identityError = providerIdentityError(provider);
  if (identityError) return { error: identityError };
  if (!isObj(body) || body.kind !== 'youtube#searchListResponse' || !Array.isArray(body.items)) return { error: 'SEARCH_RESPONSE_MALFORMED' };
  if (!youtubeSearchResponseWithinBounds(body)) return { error: 'SEARCH_RESPONSE_TOO_LARGE' };
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > YOUTUBE_OFFICIAL.quota.maxResults || body.items.length > maxItems) return { error: 'SEARCH_RESPONSE_ITEM_CAP_EXCEEDED' };
  const raws = [];
  const skipped = [];
  for (const item of body.items) {
    const mapped = youtubeSearchItemToRaw(item, { provider });
    if (mapped.skip) skipped.push(mapped.reason);
    else raws.push(mapped.raw);
  }
  if (body.nextPageToken !== undefined && (typeof body.nextPageToken !== 'string' || !PAGE_TOKEN_RE.test(body.nextPageToken))) return { error: 'SEARCH_RESPONSE_PAGE_TOKEN_MALFORMED' };
  const nextPageToken = body.nextPageToken === undefined ? null : body.nextPageToken;
  return freeze({ raws: freeze(raws), skipped: freeze(skipped.slice(0, maxItems)), nextPageToken, deletionSupport: YOUTUBE_OFFICIAL.deletionSupport });
}

// REST polling has no provider event sequence.  The caller supplies ONE receipt
// clock for the response; normalization then preserves it as retrieved/known
// (never as sourceCreatedTs).  This helper remains fixture-only and performs no
// request or cache operation.
export function youtubeSearchResponseToObservations(body, { receivedTs, provider = YOUTUBE_OFFICIAL.id } = {}) {
  if (!Number.isSafeInteger(receivedTs) || receivedTs < 0) return { error: 'RECEIPT_CLOCK_REQUIRED' };
  const identityError = providerIdentityError(provider);
  if (identityError) return { error: identityError };
  const parsed = youtubeSearchResponseToRaw(body, { provider });
  if (parsed.error) return parsed;
  const observations = []; const rejected = [];
  for (const raw of parsed.raws) {
    const out = normalizeSocialObservation(raw, { nowMs: receivedTs });
    if (out.reject) rejected.push(out.reason);
    else observations.push(out.observation);
  }
  return freeze({ observations: freeze(observations), rejected: freeze(rejected.slice(0, YOUTUBE_OFFICIAL.quota.maxResults)), receivedTs, nextPageToken: parsed.nextPageToken, deletionSupport: parsed.deletionSupport });
}

export function youtubeSearchResponseWithinBounds(body, { maxBytes = YOUTUBE_RESPONSE_MAX_BYTES } = {}) {
  if (!isObj(body) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return false;
  try { return Buffer.byteLength(JSON.stringify(body), 'utf8') <= maxBytes; } catch { return false; }
}