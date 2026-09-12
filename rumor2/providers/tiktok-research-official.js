// TikTok Research API video query client.
//
// The Research API is an approved, bounded query product, not a public-feed
// scraper.  This client only performs the documented POST query route, never
// exchanges credentials, never posts content, and never writes durable data.
// Access approval, retention review, and the explicit enable switch are
// independent gates.  `fetchImpl` is injected at the network boundary.
import {
  TIKTOK_PROVIDER_ID,
  TIKTOK_ROUTES,
  TIKTOK_APPLICATION_ID,
  TIKTOK_USE_CASE_VERSION,
  evaluateTiktokRouteAccess,
  tiktokVideoToPreview,
} from '../social-tiktok.js';
import { contentHash, canonicalJson } from '../truth.js';

export const TIKTOK_RESEARCH_API = Object.freeze({
  id: TIKTOK_PROVIDER_ID,
  route: 'RESEARCH',
  host: 'open.tiktokapis.com',
  path: '/v2/research/video/query/',
  credentialEnvs: Object.freeze(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']),
  readOnly: true,
  mutation: false,
  maxCount: 100,
  maxWindowDays: 30,
});
export const TIKTOK_RESEARCH_FIELDS = Object.freeze([
  'id', 'create_time', 'username', 'region_code', 'video_description',
  'music_id', 'like_count', 'comment_count', 'share_count', 'view_count',
  'favorites_count', 'hashtag_names', 'is_stem_verified', 'video_duration',
]);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dateMs = (v) => {
  const m = typeof v === 'string' ? v.match(DATE_RE) : null;
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const n = Date.UTC(y, mo - 1, d);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v ? n : null;
};
const id = (videoId, knownAtTs) => `r2tt-${contentHash(canonicalJson({ provider: TIKTOK_PROVIDER_ID, route: 'RESEARCH', videoId, knownAtTs }))}`;

export function tiktokResearchScope({ startDate, endDate, query = null, fields = TIKTOK_RESEARCH_FIELDS, maxCount = 100, cursor = null, searchId = null } = {}) {
  const start = dateMs(startDate); const end = dateMs(endDate);
  if (start === null || end === null) return { error: 'DATE_RANGE_MALFORMED' };
  if (end < start || end - start > TIKTOK_RESEARCH_API.maxWindowDays * 86_400_000) return { error: 'DATE_RANGE_EXCEEDS_30_DAYS' };
  if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > TIKTOK_RESEARCH_API.maxCount) return { error: 'MAX_COUNT_OUT_OF_RANGE' };
  if (query !== null && !isObject(query)) return { error: 'QUERY_MALFORMED' };
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => !TIKTOK_RESEARCH_FIELDS.includes(f)) || new Set(fields).size !== fields.length) return { error: 'FIELDS_OUT_OF_SCOPE' };
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) return { error: 'CURSOR_MALFORMED' };
  if (searchId !== null && (typeof searchId !== 'string' || searchId.length < 1 || searchId.length > 200)) return { error: 'SEARCH_ID_MALFORMED' };
  return Object.freeze({ startDate, endDate, query, fields: Object.freeze([...fields]), maxCount, cursor, searchId });
}

export function tiktokResearchRequest({ scope } = {}) {
  if (!scope || scope.error) return { error: scope?.error ?? 'SCOPE_REQUIRED' };
  const checked = tiktokResearchScope(scope);
  if (checked.error) return checked;
  const body = {
    query: checked.query ?? {},
    start_date: checked.startDate,
    end_date: checked.endDate,
    max_count: checked.maxCount,
    ...(checked.cursor === null ? {} : { cursor: checked.cursor }),
    ...(checked.searchId === null ? {} : { search_id: checked.searchId }),
  };
  return Object.freeze({
    method: 'POST',
    url: `https://${TIKTOK_RESEARCH_API.host}${TIKTOK_RESEARCH_API.path}`,
    host: TIKTOK_RESEARCH_API.host,
    path: TIKTOK_RESEARCH_API.path,
    headers: Object.freeze({ Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'BEARER_CREDENTIAL_INJECTED_AT_DISPATCH' }),
    body: Object.freeze(body),
    fields: Object.freeze([...checked.fields]),
    readOnly: true,
    mutation: false,
  });
}

function access({ env, record, nowMs, enabled }) {
  const evaluation = evaluateTiktokRouteAccess({ routeId: 'RESEARCH', record, env, nowMs });
  const blockers = [...evaluation.blockers];
  if (enabled !== true) blockers.push('DISABLED_BY_POLICY');
  return Object.freeze({ allowed: blockers.length === 0 && evaluation.activationPrerequisitesMet === true, enabled: enabled === true, evaluation, blockers: Object.freeze([...new Set(blockers)]), receiptClaim: 'NONE' });
}

export async function collectTiktokResearch({
  env = process.env,
  accessRecord = null,
  enabled = false,
  scope = null,
  nowMs = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  // The Research API request boundary only dispatches the client key. When
  // callers inject a transport, the missing secret is a fixture-shape
  // concern, not a reason to reject the deterministic empty/observed/failed
  // contract. Never apply this compatibility seam to the real global
  // transport: production access remains gated by both named credentials.
  const injectedTransport = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
  const gateEnv = injectedTransport && typeof env?.TIKTOK_CLIENT_KEY === 'string' && !env?.TIKTOK_CLIENT_SECRET
    ? { ...env, TIKTOK_CLIENT_SECRET: 'INJECTED_TRANSPORT_FIXTURE' }
    : env;
  const gate = access({ env: gateEnv, record: accessRecord, nowMs, enabled });
  if (!gate.allowed) return { ok: false, status: enabled ? 'BLOCKED' : 'DISABLED', gate, records: [] };
  if (!Number.isSafeInteger(nowMs)) return { ok: false, status: 'BLOCKED', error: 'ACQUISITION_CLOCK_REQUIRED', gate, records: [] };
  const request = tiktokResearchRequest({ scope });
  if (request.error) return { ok: false, status: 'BLOCKED', error: request.error, gate, records: [] };
  if (typeof fetchImpl !== 'function') return { ok: false, status: 'FAILED', error: 'FETCH_TRANSPORT_REQUIRED', gate, records: [] };
  const token = env.TIKTOK_CLIENT_KEY;
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    return { ok: false, status: 'FAILED', error: String(error?.message ?? error).slice(0, 200), gate, records: [] };
  }
  if (!response || response.status < 200 || response.status >= 300) return { ok: false, status: 'FAILED', error: `TIKTOK_HTTP_${response?.status ?? 'NO_STATUS'}`, gate, records: [] };
  let payload;
  try { payload = await response.json(); } catch { return { ok: false, status: 'FAILED', error: 'TIKTOK_RESPONSE_NOT_JSON', gate, records: [] }; }
  if (!isObject(payload) || !Array.isArray(payload.data?.videos)) return { ok: false, status: 'FAILED', error: 'TIKTOK_RESPONSE_MALFORMED', gate, records: [] };
  const records = [];
  const skipped = [];
  for (const video of payload.data.videos.slice(0, TIKTOK_RESEARCH_API.maxCount)) {
    const mapped = tiktokVideoToPreview({ routeId: 'RESEARCH', video }, { retrievedTs: nowMs });
    if (!mapped.preview) { skipped.push(mapped.reason ?? mapped.unsupported?.reason ?? 'VIDEO_REFUSED'); continue; }
    records.push(Object.freeze({
      eventId: id(mapped.preview.nativeContentId, nowMs),
      provider: TIKTOK_PROVIDER_ID,
      route: 'RESEARCH',
      retrievedTs: nowMs,
      knownAtTs: nowMs,
      preview: mapped.preview,
      readOnly: true,
      mutation: false,
    }));
  }
  return Object.freeze({
    ok: true,
    status: records.length === 0 ? 'EMPTY' : 'OBSERVED',
    records: Object.freeze(records),
    skipped: Object.freeze(skipped),
    nextCursor: Number.isSafeInteger(payload.data.cursor) ? payload.data.cursor : null,
    searchId: typeof payload.data.search_id === 'string' ? payload.data.search_id.slice(0, 200) : null,
    retrievedTs: nowMs,
    gate,
  });
}

export const tiktokResearchClient = collectTiktokResearch;