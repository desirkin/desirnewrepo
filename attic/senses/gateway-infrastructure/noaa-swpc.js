// NOAA Space Weather Prediction Center public products. No credentials are
// accepted or required. Product names map to fixed official routes so a caller
// cannot turn this collector into an arbitrary URL fetcher.
import { requestJson } from './http.js';

export const NOAA_SWPC_BASE = 'https://services.swpc.noaa.gov';
export const NOAA_SWPC_PRODUCTS = Object.freeze({
  solarWindPlasma7Day: { path: '/products/solar-wind/plasma-7-day.json', shape: 'table' },
  solarWindMag7Day: { path: '/products/solar-wind/mag-7-day.json', shape: 'table' },
  alerts: { path: '/products/alerts.json', shape: 'records' },
  goesXray7Day: { path: '/json/goes/primary/xrays-7-day.json', shape: 'records' },
});

const finiteTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 2e10 ? value : value * 1000;
  if (typeof value !== 'string') return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
};

const sourceTimestamp = (data) => {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') return null;
  for (const key of ['time_tag', 'timeTag', 'timestamp', 'event_timestamp', 'issue_datetime']) {
    const ts = finiteTimestamp(Array.isArray(first) ? null : first[key]);
    if (ts !== null) return ts;
  }
  return null;
};

function normalize(body, shape, maxRecords) {
  if (shape === 'table') {
    if (!Array.isArray(body)) return { invalid: true };
    if (body.length === 0) return { rows: [], headers: [], truncated: false };
    const header = Array.isArray(body[0]) && body[0].length > 0 ? body[0].slice(0, 64).map(String) : null;
    if (!header || body.slice(1).some((row) => !Array.isArray(row))) return { invalid: true };
    const rows = body.slice(1, maxRecords + 1).filter((row) => Array.isArray(row)).map((row) => row.slice(0, header.length));
    return { headers: header, rows, truncated: body.length - 1 > maxRecords };
  }
  if (!Array.isArray(body)) return { invalid: true };
  return { records: body.slice(0, maxRecords), truncated: body.length > maxRecords };
}

export async function fetchNoaaProduct({
  product = 'solarWindPlasma7Day',
  fetchImpl,
  clock,
  timeoutMs,
  maxBytes = 4 * 1024 * 1024,
  maxRecords = 10_000,
  signal,
} = {}) {
  const spec = NOAA_SWPC_PRODUCTS[product];
  const receivedTs = clock ? clock() : Date.now();
  const provenance = { provider: 'NOAA_SWPC', endpoint: spec?.path ?? null, receivedTs, receivedAt: new Date(receivedTs).toISOString() };
  if (!spec) return { ok: false, status: 'FAILED', failure: { code: 'INVALID_PRODUCT', message: 'NOAA product is not supported' }, provenance };
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) return { ok: false, status: 'FAILED', failure: { code: 'INVALID_LIMIT', message: 'record limit is invalid' }, provenance };
  const result = await requestJson(`${NOAA_SWPC_BASE}${spec.path}`, { fetchImpl, clock, timeoutMs, maxBytes, signal });
  if (!result.ok) return { ...result, provenance: { ...provenance, ...result.provenance } };
  const normalized = normalize(result.data, spec.shape, maxRecords);
  if (normalized.invalid) return {
    ok: false,
    status: 'FAILED',
    failure: { code: 'SCHEMA', message: 'NOAA product shape was not recognized' },
    provenance: { ...provenance, ...result.provenance },
  };
  const records = normalized.rows ?? normalized.records ?? [];
  const firstRecord = spec.shape === 'table' && normalized.rows.length
    ? Object.fromEntries(normalized.headers.map((key, index) => [key, normalized.rows[0][index]]))
    : normalized.records?.[0];
  const finalProvenance = { ...provenance, ...result.provenance, sourceTimestamp: sourceTimestamp(firstRecord) };
  return {
    ok: true,
    status: records.length ? 'DATA' : 'EMPTY',
    data: normalized,
    provenance: finalProvenance,
  };
}

export function createNoaaSwpcClient(options = {}) {
  return Object.freeze({
    fetch: (request = {}) => fetchNoaaProduct({ ...options, ...request }),
    products: NOAA_SWPC_PRODUCTS,
    provider: 'NOAA_SWPC',
  });
}