// INFRA — the DARK infrastructure-observation registry (owner scope I01-I03): Cloudflare Radar, NOAA space weather
// (experimental), RIPE RIS / BGP. Authority NONE — no nomination, no attention, no Judge / Watch / execution input; a reader
// may look. Each source pins its https host, its documented route (URL, access date, what was verified), the exact
// measurement + units + clock it yields, and what it needs before ONE request may be sent: nothing (NOAA), a configured
// resource scope (RIPE: INFRA_RIPE_RESOURCES), or a credential (Cloudflare: CLOUDFLARE_API_TOKEN — the old "no key" claim
// is false: an unauthenticated call answers HTTP 400 code 9106). Pure module: no network, no timers.
export const INFRA_REGISTRY_VERSION = 'serpent-infra-registry-1';
export const INFRA_KINDS = Object.freeze(['SPACE_WEATHER', 'ROUTING', 'INTERNET_RADAR']);
const ACCESSED = '2026-09-12';
const doc = (url, note, status = 'VERIFIED') => Object.freeze({ url, accessedOn: ACCESSED, status, note });
export const INFRA_SOURCES = Object.freeze([
  Object.freeze({ id: 'NOAA_SWPC', name: 'NOAA SWPC space weather', kind: 'SPACE_WEATHER', host: 'services.swpc.noaa.gov', experimental: true, credentialEnv: null, configEnv: null, cadenceSec: 600,
    products: Object.freeze([
      Object.freeze({ id: 'KP', url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', measurement: 'planetary K-index per 3-hour interval', units: 'Kp (0-9, dimensionless)', clock: 'time_tag = UTC start of the 3-hour interval (SWPC: all times UTC)' }),
      Object.freeze({ id: 'SCALES', url: 'https://services.swpc.noaa.gov/products/noaa-scales.json', measurement: 'NOAA space weather scales R (radio blackout), S (solar radiation), G (geomagnetic) — the CURRENT observed entry "0" only; forecast entries are never recorded as observations', units: 'scale level 0-5 per axis', clock: 'DateStamp + TimeStamp, UTC' }),
    ]),
    docs: Object.freeze([doc('https://www.swpc.noaa.gov/content/data-access', 'HTTP 200: products live under services.swpc.noaa.gov/products; times are UTC'), doc('https://services.swpc.noaa.gov/products/', 'HTTP 200 index lists noaa-planetary-k-index.json and noaa-scales.json'), doc('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', 'HTTP 200 rows {time_tag, Kp, a_running, station_count}'), doc('https://services.swpc.noaa.gov/products/noaa-scales.json', 'HTTP 200 keyed entries "-1","0","1","2","3" with DateStamp / TimeStamp and R / S / G {Scale, Text}')]) }),
  Object.freeze({ id: 'RIPE_RIS', name: 'RIPE NCC RIPEstat (RIS routing status)', kind: 'ROUTING', host: 'stat.ripe.net', experimental: false, credentialEnv: null, configEnv: 'INFRA_RIPE_RESOURCES', cadenceSec: 900, maxResources: 16,
    route: 'https://stat.ripe.net/data/routing-status/data.json', measurement: 'per configured prefix / ASN: RIS peer visibility (peers seeing / total, v4 and v6), origins with route objects, first / last seen', units: 'peer counts (integers); origins (ASN); resource identity', clock: 'data.query_time (RIPEstat, day precision) + receipt',
    docs: Object.freeze([doc('https://stat.ripe.net/docs/02.data-api/', 'HTTP 200 (About the Data API): data calls answer JSON with status / data_call_status; callers identify themselves with sourceapp'), doc('https://stat.ripe.net/data/routing-status/data.json?resource=1.1.1.0/24', 'HTTP 200 status ok, data_call_status supported: data {resource, visibility.v4/v6 {ris_peers_seeing,total_ris_peers}, origins[{origin,route_objects}], first_seen, last_seen, query_time}'), doc('https://ris-live.ripe.net/', 'HTTP 200: RIS Live WebSocket is documented but NOT the bounded route chosen here (polling routing-status per configured resource)')]) }),
  Object.freeze({ id: 'CLOUDFLARE_RADAR', name: 'Cloudflare Radar (BGP update timeseries)', kind: 'INTERNET_RADAR', host: 'api.cloudflare.com', experimental: false, credentialEnv: 'CLOUDFLARE_API_TOKEN', configEnv: null, cadenceSec: 3600,
    route: 'https://api.cloudflare.com/client/v4/radar/bgp/timeseries', scopeEnv: Object.freeze({ asn: 'INFRA_CLOUDFLARE_ASN', prefix: 'INFRA_CLOUDFLARE_PREFIX', dateRange: 'INFRA_CLOUDFLARE_DATE_RANGE' }), defaults: Object.freeze({ dateRange: '1d', aggInterval: '1h' }),
    measurement: 'BGP update volume timeseries (announcements + withdrawals) per aggregation interval over the configured date range, optionally scoped to ASNs / a prefix', units: 'numeric strings (updates per interval) as served; parsed to numbers, never rounded', clock: 'serie_0.timestamps (UTC, interval start) + meta.lastUpdated + receipt',
    docs: Object.freeze([doc('https://developers.cloudflare.com/radar/get-started/first-request/', 'HTTP 200: an API token is required (Authorization: Bearer)'), doc('https://developers.cloudflare.com/api/resources/radar/subresources/bgp/methods/timeseries/', 'HTTP 200: GET /radar/bgp/timeseries; params aggInterval (15m|1h|1d|1w), name, dateRange, dateStart, dateEnd, prefix, updateType (ANNOUNCEMENT|WITHDRAWAL), asn, format'), doc('https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json', 'response {success, result:{meta:{aggInterval, confidenceInfo, dateRange, lastUpdated}, serie_0:{timestamps[date-time], values[numeric string]}}}'), doc('https://api.cloudflare.com/client/v4/radar/bgp/timeseries?dateRange=1d', 'unauthenticated -> HTTP 400 {"code":9106,"message":"Missing X-Auth-Key, X-Auth-Email or Authorization headers"}', 'CREDENTIAL_REQUIRED')]) }),
]);
export const INFRA_SOURCE_IDS = Object.freeze(INFRA_SOURCES.map((s) => s.id));
export const infraSource = (id) => INFRA_SOURCES.find((s) => s.id === id) ?? null;
export function infraRegistryError(list = INFRA_SOURCES) {
  const ids = new Set();
  for (const s of list) {
    if (typeof s.id !== 'string' || ids.has(s.id)) return `bad or duplicate id ${s.id}`; ids.add(s.id);
    if (!INFRA_KINDS.includes(s.kind) || typeof s.host !== 'string' || !Number.isSafeInteger(s.cadenceSec) || s.cadenceSec < 300) return `${s.id}: vocabulary / cadence floor 300 s`;
    if (!Array.isArray(s.docs) || !s.docs.length || s.docs.some((d) => !d.url?.startsWith('https://') || d.accessedOn !== ACCESSED)) return `${s.id}: documentation refs`;
    const urls = s.products ? s.products.map((p) => p.url) : [s.route]; for (const u of urls) { let x; try { x = new URL(u); } catch { return `${s.id}: url`; } if (x.protocol !== 'https:' || x.hostname !== s.host) return `${s.id}: route host must be the pinned host over https`; }
    if (!(s.credentialEnv === null || typeof s.credentialEnv === 'string') || !(s.configEnv === null || typeof s.configEnv === 'string')) return `${s.id}: gates`;
  }
  return null;
}
