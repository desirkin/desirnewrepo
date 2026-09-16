// VIDEO — pure mapping from YouTube Data API v3 payloads to the closed video-metadata observation shape. A measurement exists
// only from a parsed payload: a connected socket, an empty page or an error envelope never becomes an observation. Metadata
// only — no captions, transcripts, comments or media fields are read even when the payload carries more.
import { createHash } from 'node:crypto';

export const VIDEO_OBSERVATION_VERSION = 'video-observation-1';
export const VIDEO_LIMITS = Object.freeze({ maxTitleChars: 300, maxDescriptionChars: 500, maxChannelChars: 200, maxIdChars: 64, maxQueryChars: 120, futureSkewMs: 5 * 60_000 });
export const LIVE_BROADCAST_STATES = Object.freeze(['none', 'live', 'upcoming', 'unknown']);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const tsOf = (v) => { if (typeof v !== 'string') return null; const ms = Date.parse(v); return Number.isFinite(ms) ? ms : null; };
const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const count = (v) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : Number.isSafeInteger(v) && v >= 0 ? v : null);
export const videoObservationId = (videoId) => sha(`YOUTUBE_DATA_API|video:${videoId}`);

// search.list payload -> { observations, rejected, reason, errorCode, errorReason }
export function searchItemsToObservations(json, { query, receiptTs }) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { observations: [], rejected: 0, reason: 'not an object', errorCode: null, errorReason: null };
  if (json.error && typeof json.error === 'object') return { observations: [], rejected: 0, reason: `provider error ${json.error.code ?? '?'}: ${clip(json.error.message, 120)}`, errorCode: Number.isSafeInteger(json.error.code) ? json.error.code : null, errorReason: clip(json.error.errors?.[0]?.reason, 60) || null };
  if (!Array.isArray(json.items)) return { observations: [], rejected: 0, reason: 'items missing', errorCode: null, errorReason: null };
  const out = []; let rejected = 0;
  for (const it of json.items) {
    const videoId = it?.id?.videoId; const sn = it?.snippet; const publishedTs = tsOf(sn?.publishedAt);
    if (!isStr(videoId, VIDEO_LIMITS.maxIdChars) || !ID_RE.test(videoId) || !sn || typeof sn !== 'object' || publishedTs === null || !isStr(sn.channelId, VIDEO_LIMITS.maxIdChars) || !ID_RE.test(sn.channelId) || publishedTs > receiptTs + VIDEO_LIMITS.futureSkewMs) { rejected += 1; continue; }
    const title = clip(sn.title, VIDEO_LIMITS.maxTitleChars); if (!title) { rejected += 1; continue; }
    out.push(Object.freeze({ v: VIDEO_OBSERVATION_VERSION, observationId: videoObservationId(videoId), provider: 'YOUTUBE_DATA_API', kind: 'VIDEO_METADATA', videoId, channelId: sn.channelId, channelTitle: clip(sn.channelTitle, VIDEO_LIMITS.maxChannelChars), title, description: clip(sn.description, VIDEO_LIMITS.maxDescriptionChars), publishedTs, liveBroadcastContent: LIVE_BROADCAST_STATES.includes(sn.liveBroadcastContent) ? sn.liveBroadcastContent : 'unknown', query: clip(query, VIDEO_LIMITS.maxQueryChars), statistics: null, receiptTs, knownAtTs: receiptTs, coverage: 'METADATA_ONLY', transcript: false, authority: 'NONE' }));
  }
  return { observations: out, rejected, reason: null, errorCode: null, errorReason: null };
}
// videos.list (part=statistics) payload -> Map videoId -> { viewCount, likeCount, commentCount } (each a non-negative integer or null)
export function videoStatisticsById(json) {
  const m = new Map(); if (!json || typeof json !== 'object' || !Array.isArray(json.items)) return m;
  for (const it of json.items) { if (!isStr(it?.id, VIDEO_LIMITS.maxIdChars) || !it.statistics || typeof it.statistics !== 'object') continue; m.set(it.id, Object.freeze({ viewCount: count(it.statistics.viewCount), likeCount: count(it.statistics.likeCount), commentCount: count(it.statistics.commentCount) })); }
  return m;
}
export const withStatistics = (o, stats) => Object.freeze({ ...o, statistics: stats ? Object.freeze({ viewCount: stats.viewCount ?? null, likeCount: stats.likeCount ?? null, commentCount: stats.commentCount ?? null }) : null });
export const VIDEO_OBSERVATION_KEYS = Object.freeze(['v', 'observationId', 'provider', 'kind', 'videoId', 'channelId', 'channelTitle', 'title', 'description', 'publishedTs', 'liveBroadcastContent', 'query', 'statistics', 'receiptTs', 'knownAtTs', 'coverage', 'transcript', 'authority']);
export function videoObservationError(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  const keys = Object.keys(o); if (keys.length !== VIDEO_OBSERVATION_KEYS.length || !VIDEO_OBSERVATION_KEYS.every((k) => k in o)) return `keys: exactly ${VIDEO_OBSERVATION_KEYS.join(',')} (captions, transcripts, comments, media or any extra field are refused)`;
  if (o.v !== VIDEO_OBSERVATION_VERSION) return 'version'; if (o.provider !== 'YOUTUBE_DATA_API' || o.kind !== 'VIDEO_METADATA') return 'provider / kind';
  if (!isStr(o.videoId, VIDEO_LIMITS.maxIdChars) || !ID_RE.test(o.videoId) || o.observationId !== videoObservationId(o.videoId)) return 'identity';
  if (!isStr(o.channelId, VIDEO_LIMITS.maxIdChars) || !ID_RE.test(o.channelId)) return 'channelId'; if (typeof o.channelTitle !== 'string' || o.channelTitle.length > VIDEO_LIMITS.maxChannelChars) return 'channelTitle';
  if (!isStr(o.title, VIDEO_LIMITS.maxTitleChars)) return 'title'; if (typeof o.description !== 'string' || o.description.length > VIDEO_LIMITS.maxDescriptionChars) return 'description';
  if (!Number.isSafeInteger(o.publishedTs) || o.publishedTs <= 0 || !Number.isSafeInteger(o.receiptTs) || o.receiptTs <= 0 || o.knownAtTs !== o.receiptTs) return 'clocks';
  if (o.publishedTs > o.receiptTs + VIDEO_LIMITS.futureSkewMs) return 'published in the future';
  if (!LIVE_BROADCAST_STATES.includes(o.liveBroadcastContent)) return 'liveBroadcastContent'; if (typeof o.query !== 'string' || o.query.length > VIDEO_LIMITS.maxQueryChars) return 'query';
  if (o.statistics !== null && (typeof o.statistics !== 'object' || !['viewCount', 'likeCount', 'commentCount'].every((k) => o.statistics[k] === null || (Number.isSafeInteger(o.statistics[k]) && o.statistics[k] >= 0)))) return 'statistics';
  if (o.coverage !== 'METADATA_ONLY' || o.transcript !== false || o.authority !== 'NONE') return 'coverage / transcript / authority';
  return null;
}
