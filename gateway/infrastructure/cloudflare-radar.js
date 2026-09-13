// Cloudflare Radar API source. Radar requires an API token even for endpoints
// which expose public aggregates; absence of a token is a failed acquisition,
// not an empty feed. Only documented, fixed Radar routes are addressable here.
import { requestJson, failed } from './http.js';

export const CLOUDFLARE_RADAR_BASE = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_RADAR_ROUTES = Object.freeze({
  trafficAnomalies: '/radar/traffic/anomalies',
  bgpRoutesStats: '/radar/bgp/routes/stats',
  bgpRoutes: '/radar/bgp/routes',
});

const empty = (value) => value === null || value === undefined
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const timestampOf = (value) => {
  const candidates = [value?.updatedAt, value?.updated_at, value?.timestamp, value?.dateTime, value?.datetime];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate > 2e10 ? candidate : candidate * 1000;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

function checkQuery(query) {
  if (query === null || query === undefined) return {};
  if (typeof query !== 'object' || Array.isArray(query)) return null;
  const keys = Object.keys(query);
  if (keys.length > 24) return null;
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(key)) return null;
    const value = query[key];
    if (typeof value === 'object' || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return null;
    if (String(value).length > 200) return null;
  }
  return query;
}

export async function fetchCloudflareRadar({
  token = process.env.CLOUDFLARE_API_TOKEN,
  route = 'trafficAnomalies',
  query = {},
  fetchImpl,
  clock,
  timeoutMs,
  maxBytes,
  signal,
} = {}) {
  const receivedTs = clock ? clock() : Date.now();
  const received = { receivedTs, receivedAt: new Date(receivedTs).toISOString() };
  const routePath = CLOUDFLARE_RADAR_ROUTES[route];
  const safeQuery = checkQuery(query);
  const provenance = { provider: 'CLOUDFLARE_RADAR', endpoint: routePath ?? null, ...received };
  if (typeof token !== 'string' || token.length === 0) return failed('CREDENTIAL_MISSING', 'Cloudflare Radar API token is required', provenance);
  if (!routePath) return failed('INVALID_ROUTE', 'Cloudflare Radar route is not supported', provenance);
  if (!safeQuery) return failed('INVALID_QUERY', 'Cloudflare Radar query is malformed', provenance);
  const url = new URL(`${CLOUDFLARE_RADAR_BASE}${routePath}`);
  for (const [key, value] of Object.entries(safeQuery)) url.searchParams.set(key, String(value));
  const result = await requestJson(url.toString(), {
    fetchImpl, clock, timeoutMs, maxBytes, signal,
    headers: { authorization: `Bearer ${token}` },
  });
  const finalProvenance = { ...provenance, ...result.provenance, sourceTimestamp: timestampOf(result.data?.result ?? result.data) };
  if (!result.ok) return { ...result, provenance: finalProvenance };
  // Cloudflare's envelope is authoritative. An unsuccessful envelope is not
  // silently treated as an empty result.
  if (result.data?.success !== true) return failed('UPSTREAM_REJECTED', 'Cloudflare Radar returned an unsuccessful response envelope', finalProvenance);
  const data = result.data.result ?? null;
  return { ok: true, status: empty(data) ? 'EMPTY' : 'DATA', data, provenance: finalProvenance };
}

export function createCloudflareRadarClient(options = {}) {
  return Object.freeze({
    fetch: (request = {}) => fetchCloudflareRadar({ ...options, ...request }),
    routes: CLOUDFLARE_RADAR_ROUTES,
    provider: 'CLOUDFLARE_RADAR',
  });
}