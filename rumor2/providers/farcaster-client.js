// Farcaster read polling through Neynar's hosted search-casts API.
//
// The key and fetch implementation are injected. There is no webhook,
// websocket, Kafka, hub, cache, or journal integration here. Every poll is a
// bounded, cursor-resumable read and requires an explicit access/retention
// decision in addition to the Neynar key.
import { FARCASTER_OFFICIAL, neynarEventToRaw } from './farcaster-official.js';
import { normalizeSocialObservation } from '../social.js';
import {
  DEFAULT_CLIENT_BODY_BYTES,
  DEFAULT_CLIENT_TIMEOUT_MS,
  clientClock,
  failedPoll,
  fetchWithTimeout,
  readJsonBody,
} from './client-http.js';

const MAX_PAGES = 10;
const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 500;
const MAX_CURSOR_CHARS = 500;
const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const isCursor = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= MAX_CURSOR_CHARS);
const freeze = (v) => Object.freeze(v);

export function createFarcasterClient({
  fetch: fetchImpl,
  apiKey = null,
  accessApproved = false,
  retentionApproved = false,
  timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_CLIENT_BODY_BYTES,
  now = () => Date.now(),
} = {}) {
  const gate = () => {
    if (!isKey(apiKey)) return 'NEYNAR_API_KEY_REQUIRED';
    if (accessApproved !== true) return 'ACCESS_APPROVAL_REQUIRED';
    if (retentionApproved !== true) return 'RETENTION_APPROVAL_REQUIRED';
    return null;
  };

  async function poll({
    q,
    limit = 25,
    cursor = null,
    sortType = 'desc_chron',
    maxPages = 1,
    nowMs = null,
    signal = null,
  } = {}) {
    const retrievedTs = clientClock(nowMs ?? (typeof now === 'function' ? now() : null));
    if (retrievedTs === null) return failedPoll('ACQUISITION_CLOCK_REQUIRED', { provider: FARCASTER_OFFICIAL.id, retrievedTs });
    const blocked = gate();
    if (blocked) return failedPoll(blocked, { provider: FARCASTER_OFFICIAL.id, retrievedTs });
    if (typeof q !== 'string' || q.length === 0 || q.length > MAX_QUERY_CHARS) return failedPoll('QUERY_REQUIRED_OR_TOO_LARGE', { provider: FARCASTER_OFFICIAL.id, retrievedTs });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return failedPoll('LIMIT_OUTSIDE_BOUNDED_RANGE', { provider: FARCASTER_OFFICIAL.id, retrievedTs });
    if (!isCursor(cursor)) return failedPoll('CURSOR_MALFORMED', { provider: FARCASTER_OFFICIAL.id, retrievedTs });
    if (!['desc_chron', 'chron'].includes(sortType)) return failedPoll('SORT_TYPE_UNDOCUMENTED', { provider: FARCASTER_OFFICIAL.id, retrievedTs });
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) return failedPoll('MAX_PAGES_OUTSIDE_BOUNDED_RANGE', { provider: FARCASTER_OFFICIAL.id, retrievedTs });

    const observations = [];
    const seenIds = new Set();
    let nextCursor = cursor;
    let requests = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ q, limit: String(limit), sort_type: sortType });
      if (nextCursor !== null) params.set('cursor', nextCursor);
      const url = `https://${FARCASTER_OFFICIAL.hosts[0]}/v2/farcaster/cast/search?${params}`;
      requests += 1;
      const transport = await fetchWithTimeout(fetchImpl, url, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      }, { timeoutMs, signal });
      if (!transport.ok) return failedPoll(transport.error, { provider: FARCASTER_OFFICIAL.id, retrievedTs, requests, checkpoint: freeze({ cursor: nextCursor, seenIds: freeze([...seenIds]) }) });
      const parsed = await readJsonBody(transport.response, { maxBytes: maxBodyBytes });
      if (!parsed.ok) return failedPoll(parsed.error, { provider: FARCASTER_OFFICIAL.id, retrievedTs, requests });
      if (transport.response.ok !== true && !(transport.response.status >= 200 && transport.response.status < 300)) {
        return failedPoll(`HTTP_${transport.response.status ?? 'ERROR'}`, { provider: FARCASTER_OFFICIAL.id, retrievedTs, requests });
      }
      const body = parsed.body;
      const result = body?.result && typeof body.result === 'object' ? body.result : body;
      if (!result || typeof result !== 'object' || !Array.isArray(result.casts)) {
        return failedPoll('SEARCH_RESPONSE_MALFORMED', { provider: FARCASTER_OFFICIAL.id, retrievedTs, requests });
      }
      if (result.casts.length > MAX_LIMIT) return failedPoll('SEARCH_RESPONSE_TOO_LARGE', { provider: FARCASTER_OFFICIAL.id, retrievedTs, requests });
      for (const cast of result.casts) {
        const mapped = neynarEventToRaw({ type: 'cast.created', data: cast });
        if (mapped.skip) continue;
        const normalized = normalizeSocialObservation(mapped.raw, { nowMs: retrievedTs });
        if (normalized.reject) continue;
        const id = normalized.observation.nativePostId;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        observations.push(normalized.observation);
      }
      const candidate = result.next?.cursor ?? result.nextCursor ?? null;
      nextCursor = typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_CURSOR_CHARS ? candidate : null;
      if (!nextCursor || page + 1 >= maxPages) break;
    }
    const checkpoint = freeze({ cursor: nextCursor, seenIds: freeze([...seenIds]), retrievedTs });
    return freeze({
      ok: true,
      status: observations.length === 0 ? 'EMPTY' : 'OBSERVED',
      provider: FARCASTER_OFFICIAL.id,
      observations: freeze(observations),
      items: freeze(observations),
      retrievedTs,
      checkpoint,
      nextCursor,
      requests,
      retentionApproved: true,
    });
  }

  return freeze({ provider: FARCASTER_OFFICIAL.id, poll, gate });
}

export const farcasterClientConstants = freeze({ maxPages: MAX_PAGES, maxLimit: MAX_LIMIT });