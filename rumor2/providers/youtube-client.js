// YouTube Data API v3 search.list read client.
//
// This is intentionally a client, not a registry/runtime integration. A
// caller supplies fetch, the key, an explicit access decision, and bounded
// quota. The client never writes a checkpoint or a journal and never enables
// itself by default.
import {
  YOUTUBE_OFFICIAL,
  YOUTUBE_QUOTA_UNIT_COST,
  youtubeSearchRequest,
  youtubeSearchResponseToObservations,
  youtubeWatchlistFromSocialScope,
} from './youtube-official.js';
import {
  DEFAULT_CLIENT_BODY_BYTES,
  DEFAULT_CLIENT_TIMEOUT_MS,
  clientClock,
  failedPoll,
  fetchWithTimeout,
  readJsonBody,
} from './client-http.js';

const TOKEN_RE = /^[A-Za-z0-9_.~+/=-]{1,512}$/;
const MAX_PAGES = 10;
const MAX_RESULTS = 50;

const freeze = (v) => Object.freeze(v);
const usableKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const quotaValue = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;

function gateError({ enabled, accessApproved, apiKey, dailyRemainingUnits, monthlyRemainingUnits }) {
  if (enabled !== true) return 'DISABLED_BY_POLICY';
  if (!usableKey(apiKey)) return 'CREDENTIAL_MISSING';
  if (accessApproved !== true) return 'ACCESS_APPROVAL_REQUIRED';
  if (quotaValue(dailyRemainingUnits) === null || quotaValue(monthlyRemainingUnits) === null) return 'QUOTA_BUDGET_REQUIRED';
  if (dailyRemainingUnits < YOUTUBE_QUOTA_UNIT_COST) return 'DAILY_QUOTA_EXHAUSTED';
  if (monthlyRemainingUnits < YOUTUBE_QUOTA_UNIT_COST) return 'MONTHLY_QUOTA_EXHAUSTED';
  return null;
}

export function createYouTubeClient({
  fetch: fetchImpl,
  apiKey = null,
  enabled = false,
  accessApproved = false,
  dailyRemainingUnits = null,
  monthlyRemainingUnits = null,
  timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_CLIENT_BODY_BYTES,
  now = () => Date.now(),
} = {}) {
  let dailyRemaining = quotaValue(dailyRemainingUnits);
  let monthlyRemaining = quotaValue(monthlyRemainingUnits);
  let quotaUsed = 0;

  const gate = () => gateError({
    enabled, accessApproved, apiKey, dailyRemainingUnits: dailyRemaining, monthlyRemainingUnits: monthlyRemaining,
  });

  async function poll({
    watchlist,
    pageToken = null,
    publishedAfter = null,
    maxResults = 25,
    maxPages = 1,
    nowMs = null,
    signal = null,
  } = {}) {
    const retrievedTs = clientClock(nowMs ?? (typeof now === 'function' ? now() : null));
    if (retrievedTs === null) return failedPoll('ACQUISITION_CLOCK_REQUIRED', { provider: YOUTUBE_OFFICIAL.id, retrievedTs });
    const blocked = gate();
    if (blocked) return failedPoll(blocked, { provider: YOUTUBE_OFFICIAL.id, retrievedTs });
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) return failedPoll('MAX_PAGES_OUTSIDE_BOUNDED_RANGE', { provider: YOUTUBE_OFFICIAL.id, retrievedTs });
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) return failedPoll('MAX_RESULTS_OUTSIDE_BOUNDED_RANGE', { provider: YOUTUBE_OFFICIAL.id, retrievedTs });
    const scope = youtubeWatchlistFromSocialScope(watchlist);
    if (scope.error) return failedPoll(scope.error, { provider: YOUTUBE_OFFICIAL.id, retrievedTs });

    const observations = [];
    const seen = new Set();
    let cursor = pageToken;
    let requests = 0;
    let nextPageToken = null;
    for (let page = 0; page < maxPages; page += 1) {
      // search.list costs 100 units even when the provider returns no items.
      if (dailyRemaining < YOUTUBE_QUOTA_UNIT_COST || monthlyRemaining < YOUTUBE_QUOTA_UNIT_COST) {
        return failedPoll('QUOTA_EXHAUSTED_BEFORE_REQUEST', {
          provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests,
          checkpoint: freeze({ pageToken: cursor, seenIds: freeze([...seen]) }),
        });
      }
      const descriptor = youtubeSearchRequest({ watchlist: scope, pageToken: cursor, maxResults, publishedAfter });
      if (descriptor.error) return failedPoll(descriptor.error, { provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests });
      const params = new URLSearchParams({ ...descriptor.query, key: apiKey });
      const url = `https://${descriptor.host}${descriptor.path}?${params.toString()}`;
      dailyRemaining -= YOUTUBE_QUOTA_UNIT_COST;
      monthlyRemaining -= YOUTUBE_QUOTA_UNIT_COST;
      quotaUsed += YOUTUBE_QUOTA_UNIT_COST;
      requests += 1;
      const transport = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers: { Accept: 'application/json' } }, { timeoutMs, signal });
      if (!transport.ok) return failedPoll(transport.error, { provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests, checkpoint: freeze({ pageToken: cursor, seenIds: freeze([...seen]) }) });
      const parsed = await readJsonBody(transport.response, { maxBytes: maxBodyBytes });
      if (!parsed.ok) return failedPoll(parsed.error, { provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests, checkpoint: freeze({ pageToken: cursor, seenIds: freeze([...seen]) }) });
      if (transport.response.ok !== true && !(transport.response.status >= 200 && transport.response.status < 300)) {
        return failedPoll(`HTTP_${transport.response.status ?? 'ERROR'}`, { provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests });
      }
      const batch = youtubeSearchResponseToObservations(parsed.body, { receivedTs: retrievedTs });
      if (batch.error) return failedPoll(batch.error, { provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests });
      for (const observation of batch.observations) {
        const id = observation.nativePostId;
        if (seen.has(id)) continue;
        seen.add(id);
        observations.push(observation);
      }
      nextPageToken = batch.nextPageToken;
      if (!nextPageToken || page + 1 >= maxPages) break;
      if (!TOKEN_RE.test(nextPageToken)) return failedPoll('PAGE_TOKEN_MALFORMED', { provider: YOUTUBE_OFFICIAL.id, retrievedTs, requests });
      cursor = nextPageToken;
    }
    const checkpoint = freeze({
      pageToken: nextPageToken,
      seenIds: freeze([...seen]),
      retrievedTs,
    });
    const common = {
      ok: true,
      status: observations.length === 0 ? 'EMPTY' : 'OBSERVED',
      provider: YOUTUBE_OFFICIAL.id,
      observations: freeze(observations),
      items: freeze(observations),
      retrievedTs,
      nextPageToken,
      checkpoint,
      requests,
      quotaUsed,
      quotaRemaining: freeze({ daily: dailyRemaining, monthly: monthlyRemaining }),
    };
    return freeze(common);
  }

  return freeze({
    provider: YOUTUBE_OFFICIAL.id,
    poll,
    gate,
    quota: () => freeze({ dailyRemainingUnits: dailyRemaining, monthlyRemainingUnits: monthlyRemaining, usedUnits: quotaUsed }),
  });
}

export const youtubeClientConstants = freeze({
  maxPages: MAX_PAGES,
  maxResults: MAX_RESULTS,
  quotaUnitCost: YOUTUBE_QUOTA_UNIT_COST,
});