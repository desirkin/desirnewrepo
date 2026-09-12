// Reddit official OAuth read client.
//
// The transport is deliberately separate from social-reddit.js, whose
// retention foundation remains fixture-only. This client is usable only when
// both operator gates below are explicit. It has no cache or journal writer.
import {
  REDDIT_OFFICIAL,
  redditThingToPreview,
} from '../social-reddit.js';
import {
  DEFAULT_CLIENT_BODY_BYTES,
  DEFAULT_CLIENT_TIMEOUT_MS,
  clientClock,
  failedPoll,
  fetchWithTimeout,
  readJsonBody,
} from './client-http.js';

const MAX_PAGES = 10;
const MAX_ITEMS = 100;
const AFTER_RE = /^t[1-6]_[a-z0-9]{1,20}$/;
const isSecret = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const freeze = (v) => Object.freeze(v);

function basicCredentials(clientId, clientSecret) {
  try { return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`; } catch { return null; }
}

function gateError({ accessApproved, retentionApproved, clientId, clientSecret, userAgent }) {
  if (accessApproved !== true) return 'ACCESS_APPROVAL_REQUIRED';
  if (!isSecret(clientId) || !isSecret(clientSecret)) return 'OAUTH_CREDENTIALS_MISSING';
  if (typeof userAgent !== 'string' || !/^[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{1,64} \(by \/u\/[A-Za-z0-9._-]{1,64}\)$/.test(userAgent)) return 'USER_AGENT_REQUIRED';
  if (retentionApproved !== true) return null;
  return null;
}

export function createRedditClient({
  fetch: fetchImpl,
  clientId = null,
  clientSecret = null,
  userAgent = 'nodejs:rumor2:1 (by /u/rumor2)',
  accessApproved = false,
  retentionApproved = false,
  timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_CLIENT_BODY_BYTES,
  now = () => Date.now(),
} = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  const gate = () => gateError({ accessApproved, retentionApproved, clientId, clientSecret, userAgent });

  async function oauthToken({ signal = null, nowMs = null } = {}) {
    const blocked = gate();
    if (blocked) return { ok: false, error: blocked };
    const auth = basicCredentials(clientId, clientSecret);
    if (!auth) return { ok: false, error: 'OAUTH_CREDENTIALS_INVALID' };
    const transport = await fetchWithTimeout(
      fetchImpl,
      `https://${REDDIT_OFFICIAL.tokenHost}${REDDIT_OFFICIAL.tokenPath}`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': userAgent },
        body: 'grant_type=client_credentials',
      },
      { timeoutMs, signal },
    );
    if (!transport.ok) return transport;
    const parsed = await readJsonBody(transport.response, { maxBytes: maxBodyBytes });
    if (!parsed.ok) return parsed;
    if (transport.response.ok !== true && !(transport.response.status >= 200 && transport.response.status < 300)) {
      return { ok: false, error: `HTTP_${transport.response.status ?? 'ERROR'}` };
    }
    const value = parsed.body?.access_token;
    if (!isSecret(value)) return { ok: false, error: 'OAUTH_TOKEN_MISSING' };
    const expires = Number(parsed.body?.expires_in);
    token = value;
    tokenExpiresAt = (Number.isSafeInteger(nowMs) ? nowMs : 0) + (Number.isFinite(expires) && expires > 0 ? expires * 1000 : 3_600_000);
    return { ok: true };
  }

  async function poll({
    subreddit,
    listing = 'new',
    after = null,
    limit = 25,
    maxPages = 1,
    nowMs = null,
    signal = null,
  } = {}) {
    const retrievedTs = clientClock(nowMs ?? (typeof now === 'function' ? now() : null));
    if (retrievedTs === null) return failedPoll('ACQUISITION_CLOCK_REQUIRED', { provider: REDDIT_OFFICIAL.id, retrievedTs });
    const blocked = gate();
    if (blocked) return failedPoll(blocked, { provider: REDDIT_OFFICIAL.id, retrievedTs });
    if (typeof subreddit !== 'string' || !/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) return failedPoll('SUBREDDIT_INVALID', { provider: REDDIT_OFFICIAL.id, retrievedTs });
    if (!['new', 'hot', 'top', 'rising', 'comments'].includes(listing)) return failedPoll('LISTING_INVALID', { provider: REDDIT_OFFICIAL.id, retrievedTs });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS) return failedPoll('LIMIT_OUTSIDE_BOUNDED_RANGE', { provider: REDDIT_OFFICIAL.id, retrievedTs });
    if (after !== null && (typeof after !== 'string' || !AFTER_RE.test(after))) return failedPoll('AFTER_MALFORMED', { provider: REDDIT_OFFICIAL.id, retrievedTs });
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) return failedPoll('MAX_PAGES_OUTSIDE_BOUNDED_RANGE', { provider: REDDIT_OFFICIAL.id, retrievedTs });

    if (token === null || retrievedTs >= tokenExpiresAt) {
      const auth = await oauthToken({ signal, nowMs: retrievedTs });
      if (!auth.ok) return failedPoll(auth.error, { provider: REDDIT_OFFICIAL.id, retrievedTs });
    }
    const previews = [];
    const durableItems = [];
    const seenIds = new Set();
    let cursor = after;
    let requests = 0;
    let nextAfter = null;
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({ limit: String(limit), raw_json: '1' });
      if (cursor) query.set('after', cursor);
      const url = `https://${REDDIT_OFFICIAL.apiHost}/r/${encodeURIComponent(subreddit)}/${listing}?${query}`;
      requests += 1;
      const transport = await fetchWithTimeout(fetchImpl, url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent, Accept: 'application/json' },
      }, { timeoutMs, signal });
      if (!transport.ok) return failedPoll(transport.error, { provider: REDDIT_OFFICIAL.id, retrievedTs, requests, checkpoint: freeze({ after: cursor, seenIds: freeze([...seenIds]) }) });
      const parsed = await readJsonBody(transport.response, { maxBytes: maxBodyBytes });
      if (!parsed.ok) return failedPoll(parsed.error, { provider: REDDIT_OFFICIAL.id, retrievedTs, requests });
      if (transport.response.ok !== true && !(transport.response.status >= 200 && transport.response.status < 300)) {
        return failedPoll(`HTTP_${transport.response.status ?? 'ERROR'}`, { provider: REDDIT_OFFICIAL.id, retrievedTs, requests });
      }
      const body = parsed.body;
      if (!body || typeof body !== 'object' || !body.data || !Array.isArray(body.data.children)) {
        return failedPoll('LISTING_RESPONSE_MALFORMED', { provider: REDDIT_OFFICIAL.id, retrievedTs, requests });
      }
      if (body.data.children.length > MAX_ITEMS) return failedPoll('LISTING_RESPONSE_TOO_LARGE', { provider: REDDIT_OFFICIAL.id, retrievedTs, requests });
      for (const thing of body.data.children) {
        const mapped = redditThingToPreview(thing, { retrievedTs });
        if (mapped.skip || seenIds.has(mapped.preview.nativeThingId)) continue;
        seenIds.add(mapped.preview.nativeThingId);
        previews.push(mapped.preview);
        // This is the sole path that may return content/author data as a
        // durable candidate. Without the explicit retention gate it remains
        // a transient preview only.
        if (retentionApproved === true) durableItems.push(freeze({
          provider: REDDIT_OFFICIAL.id,
          nativeThingId: mapped.preview.nativeThingId,
          nativeAuthorId: mapped.preview.author.nativeAuthorId,
          text: mapped.preview.originalText,
          title: mapped.preview.title,
          sourceDeclaredTs: mapped.preview.sourceDeclaredTs,
          retrievedTs,
          knownAtTs: retrievedTs,
        }));
      }
      nextAfter = typeof body.data.after === 'string' && AFTER_RE.test(body.data.after) ? body.data.after : null;
      if (!nextAfter || page + 1 >= maxPages) break;
      cursor = nextAfter;
    }
    const checkpoint = freeze({ after: nextAfter, seenIds: freeze([...seenIds]), retrievedTs });
    return freeze({
      ok: true,
      status: previews.length === 0 ? 'EMPTY' : 'OBSERVED',
      provider: REDDIT_OFFICIAL.id,
      previews: freeze(previews),
      // `items` is intentionally the ephemeral view, while `durableItems`
      // is empty unless retention approval was explicit.
      items: freeze(previews),
      durableItems: freeze(durableItems),
      retentionApproved,
      retrievedTs,
      checkpoint,
      nextAfter,
      requests,
    });
  }

  return freeze({ provider: REDDIT_OFFICIAL.id, poll, gate, oauthToken });
}