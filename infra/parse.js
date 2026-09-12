// INFRA — pure validators / mappers from a provider payload to `infra-observation-1` records. Every measurement keeps its
// own clock: NOAA Kp = the 3-hour interval start (UTC); NOAA scales = DateStamp + TimeStamp (UTC), current entry only —
// forecast / previous-day entries are counted and EXCLUDED (a forecast is not an observation); RIPE = query_time (day
// precision, flagged); Cloudflare = the series' own timestamps + meta.lastUpdated. receiptTs is when the bytes arrived and
// knownAtTs = receiptTs. A missing source clock stays null, never invented from receipt. Values are validated, never
// coerced to zero: a non-finite or out-of-range value rejects that row with a reason.
import { createHash } from 'node:crypto';

export const INFRA_OBSERVATION_VERSION = 'infra-observation-1';
export const INFRA_OBSERVATION_KINDS = Object.freeze(['NOAA_KP', 'NOAA_SCALES', 'RIS_ROUTING_STATUS', 'CF_RADAR_BGP_TIMESERIES']);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const utcNoZone = (s) => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null; const ms = Date.parse(`${s}Z`); return Number.isFinite(ms) ? ms : null; };
const obs = (o) => Object.freeze({ v: INFRA_OBSERVATION_VERSION, observationId: sha256(`${o.sourceId}|${o.kind}|${o.dedupeKey}`), authority: 'NONE', ...o });

export function noaaKpObservations(json, { receiptTs, sourceId = 'NOAA_SWPC', maxRows = 64 } = {}) {
  if (!Array.isArray(json)) return { ok: false, reason: 'K-index payload is not an array' }; if (json.length === 0) return { ok: true, empty: true, observations: [], rejected: [] };
  const observations = []; const rejected = [];
  for (const row of json.slice(-maxRows)) {
    const ts = utcNoZone(row?.time_tag); const kp = typeof row?.Kp === 'number' ? row.Kp : Number.NaN; const a = row?.a_running; const n = row?.station_count;
    if (ts === null) { rejected.push({ row: String(row?.time_tag ?? '?').slice(0, 30), reason: 'time_tag not a UTC instant' }); continue; }
    if (!Number.isFinite(kp) || kp < 0 || kp > 9) { rejected.push({ row: row.time_tag, reason: 'Kp not finite in 0..9' }); continue; }
    if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(n) || n < 0) { rejected.push({ row: row.time_tag, reason: 'a_running / station_count not non-negative integers' }); continue; }
    if (ts > receiptTs + 3 * 3_600_000) { rejected.push({ row: row.time_tag, reason: 'interval start in the future' }); continue; }
    observations.push(obs({ sourceId, kind: 'NOAA_KP', dedupeKey: row.time_tag, experimental: true, measurement: 'planetary K-index (3-hour interval)', units: 'Kp 0-9', scope: 'planetary', sourceEventTs: ts, sourceClockPrecision: 'INTERVAL_START_3H', receiptTs, knownAtTs: receiptTs, values: { kp, aRunning: a, stationCount: n } }));
  }
  return { ok: true, empty: observations.length === 0 && rejected.length === 0, observations, rejected };
}
export function noaaScalesObservation(json, { receiptTs, sourceId = 'NOAA_SWPC' } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'scales payload is not a keyed object' };
  const cur = json['0']; const excluded = Object.keys(json).filter((k) => k !== '0'); if (!cur || typeof cur !== 'object') return { ok: false, reason: 'no current entry "0"', excludedForecasts: excluded.length };
  const ts = utcNoZone(`${cur.DateStamp}T${cur.TimeStamp}`); if (ts === null) return { ok: false, reason: 'DateStamp / TimeStamp not a UTC instant', excludedForecasts: excluded.length };
  const level = (axis) => { const v = cur?.[axis]?.Scale; const n = typeof v === 'string' && /^[0-5]$/.test(v) ? Number(v) : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5 ? v : null; return n; };
  const R = level('R'), S = level('S'), G = level('G'); if (R === null || S === null || G === null) return { ok: false, reason: 'R / S / G scale not an integer 0..5', excludedForecasts: excluded.length };
  const text = (axis) => (typeof cur?.[axis]?.Text === 'string' ? cur[axis].Text.slice(0, 40) : null);
  return { ok: true, excludedForecasts: excluded.length, observation: obs({ sourceId, kind: 'NOAA_SCALES', dedupeKey: `${cur.DateStamp}T${cur.TimeStamp}`, experimental: true, measurement: 'NOAA R / S / G scales (current)', units: 'level 0-5 per axis', scope: 'current', sourceEventTs: ts, sourceClockPrecision: 'SECOND', receiptTs, knownAtTs: receiptTs, values: { R, S, G, rText: text('R'), sText: text('S'), gText: text('G') } }) };
}
export const RIPE_RESOURCE_RE = /^(AS\d{1,10}|(\d{1,3}\.){3}\d{1,3}\/\d{1,2}|[0-9a-f:]+\/\d{1,3})$/i;
export function ripeRoutingStatusObservation(json, { resource, receiptTs, sourceId = 'RIPE_RIS' } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not an object' }; if (json.status !== 'ok') return { ok: false, reason: `RIPEstat status ${String(json.status).slice(0, 20)}` };
  if (json.data_call_status && !String(json.data_call_status).startsWith('supported')) return { ok: false, reason: `data call ${String(json.data_call_status).slice(0, 40)}` };
  const d = json.data; if (!d || typeof d !== 'object' || d.resource !== resource) return { ok: false, reason: 'data.resource does not match the requested resource' };
  const vis = (side) => { const v = d.visibility?.[side]; return v && Number.isSafeInteger(v.ris_peers_seeing) && Number.isSafeInteger(v.total_ris_peers) && v.ris_peers_seeing >= 0 && v.total_ris_peers >= v.ris_peers_seeing ? { seeing: v.ris_peers_seeing, total: v.total_ris_peers } : null; };
  const v4 = vis('v4'), v6 = vis('v6'); if (!v4 && !v6) return { ok: false, reason: 'visibility missing or inconsistent' };
  const qt = utcNoZone(d.query_time); const origins = Array.isArray(d.origins) ? d.origins.filter((o) => Number.isSafeInteger(o?.origin)).map((o) => ({ asn: o.origin, routeObjects: Array.isArray(o.route_objects) ? o.route_objects.filter((x) => typeof x === 'string').slice(0, 8) : [] })).slice(0, 16) : [];
  const seen = (x) => (x && typeof x === 'object' && utcNoZone(x.time) !== null ? { prefix: String(x.prefix ?? '').slice(0, 64), origin: String(x.origin ?? '').slice(0, 16), ts: utcNoZone(x.time) } : null);
  return { ok: true, observation: obs({ sourceId, kind: 'RIS_ROUTING_STATUS', dedupeKey: `${resource}|${d.query_time ?? 'na'}|${v4?.seeing ?? 'x'}/${v4?.total ?? 'x'}|${v6?.seeing ?? 'x'}/${v6?.total ?? 'x'}`, experimental: false, measurement: 'RIS routing status', units: 'peer counts', scope: resource, sourceEventTs: qt, sourceClockPrecision: qt === null ? 'UNKNOWN' : 'DAY', receiptTs, knownAtTs: receiptTs, values: { resource, visibility: { v4, v6 }, origins, firstSeen: seen(d.first_seen), lastSeen: seen(d.last_seen), moreSpecifics: Array.isArray(d.more_specifics) ? d.more_specifics.length : null, lessSpecifics: Array.isArray(d.less_specifics) ? d.less_specifics.length : null } }) };
}
export function cloudflareBgpTimeseriesObservation(json, { receiptTs, scope, sourceId = 'CLOUDFLARE_RADAR', maxPoints = 200 } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'not an object' };
  if (json.success !== true) { const e = Array.isArray(json.errors) && json.errors[0] ? json.errors[0] : null; return { ok: false, reason: e ? `code ${e.code}: ${String(e.message).slice(0, 80)}` : 'success false', errorCode: e?.code ?? null }; }
  const r = json.result; const s = r?.serie_0; if (!r || !s || !Array.isArray(s.timestamps) || !Array.isArray(s.values) || s.timestamps.length !== s.values.length) return { ok: false, reason: 'serie_0 timestamps / values missing or misaligned' };
  if (s.timestamps.length === 0) return { ok: true, empty: true, reason: 'empty series for the requested window' };
  const points = []; let invalid = 0;
  for (let i = 0; i < Math.min(s.timestamps.length, maxPoints); i += 1) { const ts = Date.parse(s.timestamps[i]); const raw = s.values[i]; const v = typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : typeof raw === 'number' && Number.isFinite(raw) ? raw : null; if (!Number.isFinite(ts) || v === null) { invalid += 1; continue; } points.push({ ts, value: v }); }
  if (!points.length) return { ok: false, reason: 'no valid points' };
  const lastUpdated = typeof r.meta?.lastUpdated === 'string' && Number.isFinite(Date.parse(r.meta.lastUpdated)) ? Date.parse(r.meta.lastUpdated) : null; const range = Array.isArray(r.meta?.dateRange) && r.meta.dateRange[0] ? { start: r.meta.dateRange[0].startTime ?? null, end: r.meta.dateRange[0].endTime ?? null } : null;
  return { ok: true, invalidPoints: invalid, truncated: s.timestamps.length > maxPoints, observation: obs({ sourceId, kind: 'CF_RADAR_BGP_TIMESERIES', dedupeKey: `${JSON.stringify(scope)}|${points[points.length - 1].ts}|${lastUpdated ?? 'na'}`, experimental: false, measurement: 'BGP update volume timeseries', units: 'updates per interval (numeric string as served)', scope, sourceEventTs: points[points.length - 1].ts, sourceClockPrecision: 'INTERVAL_START', receiptTs, knownAtTs: receiptTs, values: { aggInterval: r.meta?.aggInterval ?? null, dateRange: range, lastUpdatedTs: lastUpdated, points } }) };
}
export function infraObservationError(o) {
  if (!o || typeof o !== 'object' || o.v !== INFRA_OBSERVATION_VERSION) return 'version'; if (!/^[0-9a-f]{64}$/.test(o.observationId ?? '')) return 'observationId';
  if (typeof o.sourceId !== 'string' || !INFRA_OBSERVATION_KINDS.includes(o.kind)) return 'source / kind'; if (o.authority !== 'NONE' || typeof o.experimental !== 'boolean') return 'law';
  if (!(o.sourceEventTs === null || Number.isSafeInteger(o.sourceEventTs)) || !Number.isSafeInteger(o.receiptTs) || o.knownAtTs !== o.receiptTs) return 'clocks';
  if (!o.values || typeof o.values !== 'object' || typeof o.measurement !== 'string' || typeof o.units !== 'string') return 'values';
  if (typeof o.dedupeKey !== 'string' || !o.dedupeKey.length || o.observationId !== sha256(`${o.sourceId}|${o.kind}|${o.dedupeKey}`)) return 'observationId is not the derived identity';
  // kind laws: a value outside its physical / documented domain is a corrupt record, never a measurement
  const v = o.values; const nonNegInt = (x) => Number.isSafeInteger(x) && x >= 0; const level = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 5;
  if (o.kind === 'NOAA_KP' && !(typeof v.kp === 'number' && Number.isFinite(v.kp) && v.kp >= 0 && v.kp <= 9 && nonNegInt(v.aRunning) && nonNegInt(v.stationCount))) return 'NOAA_KP values';
  if (o.kind === 'NOAA_SCALES' && !(level(v.R) && level(v.S) && level(v.G))) return 'NOAA_SCALES values';
  if (o.kind === 'RIS_ROUTING_STATUS' && !(typeof v.resource === 'string' && RIPE_RESOURCE_RE.test(v.resource) && v.visibility && typeof v.visibility === 'object')) return 'RIS_ROUTING_STATUS values';
  if (o.kind === 'CF_RADAR_BGP_TIMESERIES' && !(Array.isArray(v.points) && v.points.every((pt) => Number.isSafeInteger(pt?.ts) && Number.isFinite(pt?.value)))) return 'CF_RADAR_BGP_TIMESERIES values';
  return null;
}
