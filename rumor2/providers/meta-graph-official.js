// Authorized Meta Graph/API read client for the explicitly reviewed Facebook
// and Instagram routes.  This is not a public-content scraper: every call is
// route-bound, bounded, read-only, and requires the operator's separate
// approval/retention record plus an explicit enable switch.  The HTTP
// transport is injected for tests and no response is written by this module.
import {
  META_PROVIDER_ID,
  META_ROUTES,
  metaRoute,
  evaluateMetaRouteAccess,
  metaPayloadToPreview,
} from '../social-meta.js';
import { contentHash, canonicalJson } from '../truth.js';

export const META_GRAPH_API = Object.freeze({
  id: META_PROVIDER_ID,
  host: 'graph.facebook.com',
  version: 'v23.0',
  readOnly: true,
  mutation: false,
  maxLimit: 100,
  supportedRoutes: Object.freeze([
    'FACEBOOK_PAGE_PUBLIC_CONTENT',
    'FACEBOOK_MANAGED_PAGES',
    'INSTAGRAM_LOGIN',
    'INSTAGRAM_FACEBOOK_LOGIN',
    'INSTAGRAM_HASHTAG_DISCOVERY',
  ]),
});
const DIGITS = /^\d{1,30}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const routeKind = (routeId) => routeId.startsWith('FACEBOOK_') ? 'PAGE_POST' : 'INSTAGRAM_MEDIA';
const routePath = (routeId, targetId) => routeId.startsWith('FACEBOOK_') ? `/${targetId}/feed` : `/${targetId}/media`;
const eventId = ({ route, nativeId, retrievedTs }) => `r2meta-${contentHash(canonicalJson({ provider: META_PROVIDER_ID, route, nativeId, retrievedTs }))}`;
const tokenPresent = (env, routeId) => {
  const r = metaRoute(routeId);
  return r?.credentialEnvs?.length > 0 && r.credentialEnvs.every((k) => typeof env?.[k] === 'string' && env[k].length > 0);
};

const fieldsFor = (routeId) => routeId.startsWith('FACEBOOK_')
  ? 'id,message,created_time,permalink_url,from,is_published,comment_count,like_count'
  : 'id,media_type,timestamp,permalink,username,comments_count,like_count,owner,caption,media_product_type';

export function metaGraphRequest({ routeId, targetId, limit = 25, after = null } = {}) {
  const r = metaRoute(routeId);
  if (!r || !META_GRAPH_API.supportedRoutes.includes(routeId)) return { error: 'ROUTE_NOT_SUPPORTED_BY_CLIENT' };
  if (r.platformPath === 'REMOVED' || r.previewSupport !== 'SUPPORTED') return { error: 'ROUTE_NOT_READABLE_BY_CLIENT' };
  if (typeof targetId !== 'string' || !DIGITS.test(targetId)) return { error: 'TARGET_ID_MALFORMED' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > META_GRAPH_API.maxLimit) return { error: 'LIMIT_OUT_OF_RANGE' };
  if (after !== null && (typeof after !== 'string' || after.length < 1 || after.length > 512 || !/^[A-Za-z0-9_.~+/=-]+$/.test(after))) return { error: 'PAGING_CURSOR_MALFORMED' };
  const params = new URLSearchParams({ fields: fieldsFor(routeId), limit: String(limit) });
  if (after !== null) params.set('after', after);
  return Object.freeze({
    method: 'GET',
    url: `https://${META_GRAPH_API.host}/${META_GRAPH_API.version}${routePath(routeId, targetId)}?${params}`,
    host: META_GRAPH_API.host,
    path: `/${META_GRAPH_API.version}${routePath(routeId, targetId)}`,
    query: Object.freeze({ fields: fieldsFor(routeId), limit, ...(after === null ? {} : { after }) }),
    headers: Object.freeze({ Accept: 'application/json', Authorization: 'BEARER_CREDENTIAL_INJECTED_AT_DISPATCH' }),
    route: routeId,
    readOnly: true,
    mutation: false,
  });
}

function gate({ env, routeId, accessRecord, nowMs, enabled }) {
  const evaluation = evaluateMetaRouteAccess({ routeId, record: accessRecord, env, nowMs });
  const blockers = [...evaluation.blockers];
  if (enabled !== true) blockers.push('DISABLED_BY_POLICY');
  return Object.freeze({ allowed: blockers.length === 0 && evaluation.activationPrerequisitesMet === true, enabled: enabled === true, credentialPresent: tokenPresent(env, routeId), evaluation, blockers: Object.freeze([...new Set(blockers)]), receiptClaim: 'NONE' });
}

export async function collectMetaGraph({
  env = process.env,
  routeId,
  accessRecord = null,
  targetId,
  enabled = false,
  nowMs = null,
  limit = 25,
  after = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const g = gate({ env, routeId, accessRecord, nowMs, enabled });
  if (!g.allowed) return { ok: false, status: enabled ? 'BLOCKED' : 'DISABLED', gate: g, records: [] };
  if (!Number.isSafeInteger(nowMs)) return { ok: false, status: 'BLOCKED', error: 'ACQUISITION_CLOCK_REQUIRED', gate: g, records: [] };
  const request = metaGraphRequest({ routeId, targetId, limit, after });
  if (request.error) return { ok: false, status: 'BLOCKED', error: request.error, gate: g, records: [] };
  if (typeof fetchImpl !== 'function') return { ok: false, status: 'FAILED', error: 'FETCH_TRANSPORT_REQUIRED', gate: g, records: [] };
  const tokenName = metaRoute(routeId).credentialEnvs[0];
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'GET',
      headers: { ...request.headers, Authorization: `Bearer ${env[tokenName]}` },
    });
  } catch (error) {
    return { ok: false, status: 'FAILED', error: String(error?.message ?? error).slice(0, 200), gate: g, records: [] };
  }
  if (!response || response.status < 200 || response.status >= 300) return { ok: false, status: 'FAILED', error: `META_HTTP_${response?.status ?? 'NO_STATUS'}`, gate: g, records: [] };
  let payload;
  try { payload = await response.json(); } catch { return { ok: false, status: 'FAILED', error: 'META_RESPONSE_NOT_JSON', gate: g, records: [] }; }
  if (!isObject(payload) || !Array.isArray(payload.data)) return { ok: false, status: 'FAILED', error: 'META_RESPONSE_MALFORMED', gate: g, records: [] };
  const records = []; const skipped = [];
  for (const item of payload.data.slice(0, META_GRAPH_API.maxLimit)) {
    const mapped = metaPayloadToPreview({ routeId, kind: routeKind(routeId), payload: item }, { retrievedTs: nowMs });
    if (!mapped.preview) { skipped.push(mapped.reason ?? mapped.unsupported?.reason ?? 'PAYLOAD_REFUSED'); continue; }
    records.push(Object.freeze({
      eventId: eventId({ route: routeId, nativeId: mapped.preview.nativeContentId, retrievedTs: nowMs }),
      provider: META_PROVIDER_ID,
      route: routeId,
      retrievedTs: nowMs,
      knownAtTs: nowMs,
      preview: mapped.preview,
      readOnly: true,
      mutation: false,
    }));
  }
  const next = payload.paging?.cursors?.after;
  return Object.freeze({
    ok: true,
    status: records.length === 0 ? 'EMPTY' : 'OBSERVED',
    records: Object.freeze(records),
    skipped: Object.freeze(skipped),
    nextAfter: typeof next === 'string' ? next.slice(0, 512) : null,
    retrievedTs: nowMs,
    gate: g,
  });
}

export const metaGraphClient = collectMetaGraph;