// D12 — FRED / ALFRED: series metadata (units / frequency from metadata, never assumed), observations with real-time
// (vintage) bounds, vintage dates and release dates. The api_key is a QUERY parameter by provider design; the transport
// redacts it from every diagnostic. Daily revised data is not a real-time release feed: a release DATE never proves the
// instant a value appeared on FRED, so knowledge floors stay at receipt (G14) and vintage dates are revision context.
import { createClientBase, num, int, str, arr, obj, seriesSubject } from './base.js';
import { quality, deepFreeze, isDateOnly } from '../contracts.js';
import { dayStartTs } from '../time.js';

export const FRED_MAPPING_ID = 'fred-series-id-v1';
const SERIES_RE = /^[A-Z0-9]{1,30}$/;
const unitOf = (u) => { const s = (u ?? '').toLowerCase(); if (s.includes('percent')) return 'PERCENT'; if (s.includes('index')) return 'INDEX'; if (s.includes('billions')) return 'BILLIONS_USD'; if (s.includes('millions')) return 'MILLIONS_USD'; if (s.includes('dollar')) return 'USD'; return 'NATIVE'; };
export function createFredClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'FRED', transport, clock, log, credential });
  const meta = new Map();
  async function seriesMeta({ seriesId, signal }) {
    if (!SERIES_RE.test(seriesId ?? '')) return { ok: false, failure: { kind: 'SCHEMA', reason: 'series id malformed', coverageState: 'NOT_SUPPORTED', reasonCode: 'NONE', ts: base.clock() } };
    const r = await base.call({ endpointId: 'series', query: { series_id: seriesId, file_type: 'json' }, signal });
    if (!r.ok) return r;
    const s = (arr(obj(r.json)?.seriess) ?? []).map(obj).find((x) => x && x.id === seriesId); if (!s) return { ok: false, failure: { kind: 'SCHEMA', reason: 'series not returned', coverageState: 'NOT_SUPPORTED', reasonCode: 'NOT_IN_CATALOG', ts: r.receivedTs } };
    const m = { id: seriesId, title: str(s.title, 200), units: str(s.units, 120), unitsShort: str(s.units_short, 40), frequency: str(s.frequency_short, 8), lastUpdated: str(s.last_updated, 40), observationStart: str(s.observation_start, 10), observationEnd: str(s.observation_end, 10), knownAtTs: r.receivedTs };
    meta.set(seriesId, deepFreeze(m));
    return { ok: true, meta: m, meta2: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function observations({ seriesId, observationStart = null, realtimeStart = null, realtimeEnd = null, limit = 100, signal }) {
    const subject = seriesSubject({ seriesId: `FRED:${seriesId}` }); const m = meta.get(seriesId);
    if (!m) return { ok: false, failure: { kind: 'SCHEMA', reason: 'series metadata required first (units come from metadata)', coverageState: 'NOT_QUERIED', reasonCode: 'NONE', ts: base.clock() }, coverage: [] };
    const query = { series_id: seriesId, file_type: 'json', sort_order: 'desc', limit: Math.min(1000, Math.max(1, limit)) }; if (observationStart) query.observation_start = observationStart; if (realtimeStart) query.realtime_start = realtimeStart; if (realtimeEnd) query.realtime_end = realtimeEnd;
    const r = await base.call({ endpointId: 'series-observations', query, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'series-observations', subject, family: 'MACRO_RELEASES', kind: 'MACRO_OBSERVATION', startTs: base.clock() })] };
    const rows = (arr(obj(r.json)?.observations) ?? []).map(obj).filter(Boolean); const out = []; const unit = unitOf(m.units);
    for (const row of rows) { const date = str(row.date, 10); if (!isDateOnly(date)) continue; const v = row.value === '.' ? null : num(row.value); const rs = str(row.realtime_start, 10); const re = str(row.realtime_end, 10);
      const ob = base.tryEmit({ endpointId: 'series-observations', subject, kind: 'MACRO_OBSERVATION', sourceKey: `${seriesId}:${date}:${rs ?? 'na'}`, periodStartTs: dayStartTs(date), periodEndTs: dayStartTs(date), receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(v === null ? 'MISSING' : 'KNOWN', { reasonCodes: v === null ? ['FIELD_MISSING_AT_SOURCE'] : ['DATE_ONLY_PRECISION'], methodologyId: 'fred-series-observations-v1', originalUnit: m.unitsShort ?? m.units }), provenance: base.provenance(r, { nativeLocator: `${seriesId}/${date}`, mappingId: FRED_MAPPING_ID, vintage: rs }), payload: { seriesId, value: v, unit, observationDate: date, realtimeStart: isDateOnly(rs) ? rs : null, realtimeEnd: isDateOnly(re) ? re : null, frequency: m.frequency, vintageDate: isDateOnly(rs) ? rs : null, unitLabel: m.units } });
      if (ob) out.push(ob); }
    out.sort((a, b) => a.periodStartTs - b.periodStartTs);
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'series-observations', subject, family: 'MACRO_RELEASES', kind: 'MACRO_OBSERVATION', state: out.length ? 'OBSERVED' : 'GAP', reasonCodes: rows.length >= limit ? ['PAGINATION_INCOMPLETE'] : [], startTs: out.length ? out[0].periodStartTs : r.receivedTs, endTs: out.length ? out[out.length - 1].periodStartTs : r.receivedTs, observationCount: out.length })], meta: { requestId: r.requestId, receivedTs: r.receivedTs, rows: rows.length } };
  }
  async function vintageDates({ seriesId, limit = 50, signal }) {
    const r = await base.call({ endpointId: 'series-vintagedates', query: { series_id: seriesId, file_type: 'json', sort_order: 'desc', limit }, signal });
    if (!r.ok) return r;
    return { ok: true, vintageDates: (arr(obj(r.json)?.vintage_dates) ?? []).filter(isDateOnly), meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  async function releaseDates({ startDate, endDate, limit = 200, signal }) {
    const subject = seriesSubject({ seriesId: 'FRED:releases' });
    const r = await base.call({ endpointId: 'releases-dates', query: { file_type: 'json', realtime_start: startDate, realtime_end: endDate, include_release_dates_with_no_data: 'true', limit }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'releases-dates', subject, family: 'MACRO_RELEASES', kind: 'ECONOMIC_EVENT', startTs: base.clock() })] };
    const out = [];
    for (const row of (arr(obj(r.json)?.release_dates) ?? []).map(obj).filter(Boolean)) { const date = str(row.date, 10); const name = str(row.release_name, 200); const id = int(row.release_id); if (!isDateOnly(date) || !name || id === null) continue;
      const ob = base.tryEmit({ endpointId: 'releases-dates', subject: seriesSubject({ seriesId: `FRED:release:${id}` }), kind: 'ECONOMIC_EVENT', sourceKey: `${id}:${date}`, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['DATE_ONLY_PRECISION', 'FIELD_MISSING_AT_SOURCE'], methodologyId: 'fred-releases-dates-v1' }), provenance: base.provenance(r, { nativeLocator: `${id}/${date}`, mappingId: FRED_MAPPING_ID }), payload: { eventName: name, countryCode: 'US', scheduledTs: dayStartTs(date), timePrecision: 'DAY', forecastRaw: null, actualRaw: null, previousRaw: null, revisedPreviousRaw: null, forecastValue: null, actualValue: null, previousValue: null, unit: null, importance: null, forecastKnownAtTs: null, actualKnownAtTs: null } });
      if (ob) out.push(ob); }
    return { ok: true, observations: out, coverage: [], meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  return { ...base, seriesMeta, observations, vintageDates, releaseDates, metaOf: (id) => meta.get(id) ?? null };
}
