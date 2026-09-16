// VIDEO — the SOCIAL-VIDEO observation tier (owner scope S10: YouTube). A SEPARATE, explicitly classified social-observation
// path OUTSIDE the frozen RUMOR-2 social core: rumor2/social-registry.js is a sealed, closed registry whose durable validators
// refuse any provider it does not name (social-settle.js validateSocialEvent), so a YouTube ear can never write RUMOR2_SOCIAL
// truth without an owner doctrine change — that is not a code repair, and this tier does not pretend otherwise. What it DOES:
// public video METADATA only (title, description snippet, channel identity, publish clock, public counters) through the
// documented YouTube Data API v3 under an explicit operator-stated daily search budget. Never captions, transcripts, comments,
// media, watch history or any viewer identity. Authority NONE. Every fact below was read from the cited documentation on the
// stated date; the quota defaults are Google's and subject to change — the collector never assumes them.
export const VIDEO_REGISTRY_VERSION = 'serpent-video-registry-1';
export const VIDEO_KINDS = Object.freeze(['SOCIAL_VIDEO']);
const doc = (url, note, status = 'VERIFIED') => Object.freeze({ url, accessedOn: '2026-09-12', status, note });
export const YOUTUBE_DATA_API = Object.freeze({
  id: 'YOUTUBE_DATA_API', name: 'YouTube Data API v3 (public video metadata)', kind: 'SOCIAL_VIDEO', host: 'www.googleapis.com',
  enableEnv: 'SOCIAL_VIDEO_ENABLED', credentialEnv: 'YOUTUBE_API_KEY', queriesEnv: 'SOCIAL_VIDEO_YOUTUBE_QUERIES', budgetEnv: 'SOCIAL_VIDEO_YOUTUBE_MAX_DAILY_SEARCHES',
  credentialTransport: 'the documented Google API-key request header only — never the query string, never a log line, never a status file',
  endpoints: Object.freeze({ search: 'https://www.googleapis.com/youtube/v3/search', videos: 'https://www.googleapis.com/youtube/v3/videos' }),
  limits: Object.freeze({ maxQueries: 8, maxQueryChars: 120, maxResultsPerSearch: 25, minIntervalSec: 900, maxIdsPerVideosList: 50, maxDailySearchesCap: 10_000 }),
  quota: Object.freeze({ defaultDailySearchCalls: 100, defaultDailyUnitsOtherEndpoints: 10_000, videosListUnits: 1, accountingDay: 'America/Los_Angeles calendar day (the API Console reports quota per Pacific day)', note: 'documented defaults on 2026-09-12, subject to change; the owner states the daily search budget explicitly and the collector stops at it' }),
  coverage: 'METADATA_ONLY',
  docs: Object.freeze([
    doc('https://developers.google.com/youtube/v3/getting-started', 'HTTP 200: "default quota allocation of 100 search.list calls, 100 videos.insert calls, and 10,000 units per day combined for all other endpoints"; every request incurs at least one unit'),
    doc('https://developers.google.com/youtube/v3/docs/search/list', 'HTTP 200: search.list — quota impact 100 calls per day (Search Queries bucket); parameters part=snippet, q, type=video, order=date, maxResults, publishedAfter'),
    doc('https://developers.google.com/youtube/v3/docs/videos/list', 'HTTP 200: videos.list — quota cost 1 unit; part=statistics returns public viewCount / likeCount / commentCount as strings'),
    doc('https://cloud.google.com/docs/authentication/api-keys-use', 'HTTP 200: an API key may be supplied in the documented request header instead of the query string (used here so the key never enters a URL)'),
    doc('https://developers.google.com/youtube/terms/api-services-terms-of-service', 'HTTP 200: YouTube API Services Terms of Service — the owner accepts them when the key is issued; this tier stores public metadata only'),
    doc('https://www.googleapis.com/youtube/v3/search?part=snippet&q=bitcoin&type=video&maxResults=1', 'unauthenticated request answers HTTP 403 "Method doesn\'t allow unregistered callers"; a malformed key in the header answers HTTP 400 — the credential gate is real and the denied path is closed', 'DENIED_PATH_OBSERVED'),
  ]),
  terms: 'YouTube API Services Terms of Service; metadata use only; no captions / transcripts / comments / media; no viewer identity',
  authority: 'NONE',
});
export const VIDEO_SOURCES = Object.freeze([YOUTUBE_DATA_API]);
export const VIDEO_SOURCE_IDS = Object.freeze(VIDEO_SOURCES.map((s) => s.id));
export function videoRegistryError(list = VIDEO_SOURCES) {
  if (!Array.isArray(list) || !list.length) return 'no video sources';
  const ids = new Set();
  for (const s of list) {
    if (!s || typeof s !== 'object') return 'source must be an object';
    if (typeof s.id !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(s.id)) return 'source id invalid'; if (ids.has(s.id)) return `duplicate source ${s.id}`; ids.add(s.id);
    if (!VIDEO_KINDS.includes(s.kind)) return `${s.id}: kind`; if (typeof s.host !== 'string' || !s.host.length) return `${s.id}: host`;
    for (const k of ['enableEnv', 'credentialEnv', 'queriesEnv', 'budgetEnv']) if (typeof s[k] !== 'string' || !/^[A-Z0-9_]+$/.test(s[k])) return `${s.id}: ${k}`;
    for (const u of Object.values(s.endpoints ?? {})) { let url; try { url = new URL(u); } catch { return `${s.id}: endpoint url`; } if (url.protocol !== 'https:' || url.hostname !== s.host) return `${s.id}: endpoint must be https on ${s.host}`; }
    if (!Array.isArray(s.docs) || !s.docs.length || !s.docs.every((d) => d && /^https:\/\//.test(d.url) && /^\d{4}-\d{2}-\d{2}$/.test(d.accessedOn) && typeof d.note === 'string')) return `${s.id}: docs`;
    if (!(s.limits?.minIntervalSec >= 60) || !(s.limits?.maxQueries >= 1) || !(s.limits?.maxResultsPerSearch >= 1 && s.limits.maxResultsPerSearch <= 50)) return `${s.id}: limits`;
    if (s.coverage !== 'METADATA_ONLY' || s.authority !== 'NONE') return `${s.id}: coverage / authority`;
  }
  return null;
}
