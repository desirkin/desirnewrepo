// MARKET LAB — the shared provider-client base. Every real client is built on these primitives, so fifteen providers
// are one transport, one observation envelope, one failure vocabulary and one runtime state machine — not fifteen
// frameworks. Clients accept an injected transport/clock for deterministic tests AND default to the real registry
// transport when explicitly started. Importing a provider module performs no I/O.
import { makeObservation, makeCoverage, quality, emptyProvenance, subjectId, isFiniteNum, isTs, deepFreeze, fail, FAMILIES } from '../contracts.js';
import { endpointOf } from '../registry.js';
import { clockConflict } from '../time.js';

export const RUNTIME_STATES = Object.freeze(['STOPPED', 'STARTING', 'ACTIVE', 'DEGRADED', 'BACKOFF', 'BLOCKED']);
// transport failure kind -> (coverage state, quality reason code, access state)
export const FAILURE_MAP = deepFreeze({
  CREDENTIAL_MISSING: ['ACCESS_BLOCKED', 'CREDENTIAL_MISSING', 'CREDENTIAL_MISSING'], CREDENTIAL_HOLD: ['ACCESS_BLOCKED', 'CREDENTIAL_MISSING', 'ENTITLEMENT_DENIED'],
  HTTP_401: ['ACCESS_BLOCKED', 'ENTITLEMENT_DENIED', 'ENTITLEMENT_DENIED'], HTTP_403: ['ACCESS_BLOCKED', 'ENTITLEMENT_DENIED', 'ENTITLEMENT_DENIED'],
  HTTP_429: ['FAILED', 'RATE_LIMITED', null], BACKOFF_ACTIVE: ['FAILED', 'RATE_LIMITED', null], HTTP_5XX: ['FAILED', 'PROVIDER_ERROR', null], HTTP_4XX: ['FAILED', 'PROVIDER_ERROR', null],
  NETWORK: ['FAILED', 'PROVIDER_ERROR', null], TIMEOUT: ['FAILED', 'PROVIDER_ERROR', null], CANCELLED: ['FAILED', 'PROVIDER_ERROR', null], REDIRECT_REFUSED: ['FAILED', 'PROVIDER_ERROR', null],
  CONTENT_TYPE: ['FAILED', 'PROVIDER_ERROR', null], BODY_TOO_LARGE: ['FAILED', 'PROVIDER_ERROR', null], JSON_INVALID: ['FAILED', 'PROVIDER_ERROR', null], SCHEMA: ['FAILED', 'PROVIDER_ERROR', null],
  HOST_NOT_ALLOWED: ['FAILED', 'PROVIDER_ERROR', null], ENDPOINT_UNKNOWN: ['FAILED', 'PROVIDER_ERROR', null], REPLAY_MISSING: ['NOT_QUERIED', 'NONE', null], STOPPED: ['NOT_QUERIED', 'NONE', null], GEO: ['ACCESS_BLOCKED', 'GEO_RESTRICTED', 'ENTITLEMENT_DENIED'],
  QUOTA_REFUSED: ['NOT_QUERIED', 'QUOTA_REFUSED', null], CONCURRENCY_REFUSED: ['NOT_QUERIED', 'QUOTA_REFUSED', null], ADMISSION_UNBOUND: ['NOT_QUERIED', 'QUOTA_REFUSED', null], ACCOUNTING_FAILED: ['FAILED', 'QUOTA_REFUSED', null],
});

// ---- strict native field readers: read the documented field, discard everything else ---------------------------
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()) && Number.isFinite(Number(v)) ? Number(v) : null);
export const int = (v) => { const n = num(v); return n !== null && Number.isSafeInteger(n) ? n : null; };
export const str = (v, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
export const bool = (v) => (typeof v === 'boolean' ? v : null);
export const tsFromSeconds = (v) => { const n = num(v); return n !== null && n > 0 ? Math.round(n * 1000) : null; };
export const tsFromMs = (v) => { const n = int(v); return n !== null && n > 0 ? n : null; };
export const tsFromIso = (v) => { if (typeof v !== 'string' || v.length > 40) return null; const ms = Date.parse(v); return Number.isFinite(ms) && ms > 0 ? ms : null; };
export const arr = (v) => (Array.isArray(v) ? v : null);
export const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);
export const pct = (v) => { const n = num(v); return n === null ? null : n / 100; }; // documented percent -> fraction
export const idSafe = (v, max = 120) => { const s = str(v, max); return s !== null && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/.test(s) ? s : null; };

export const isGeoBlock = (failure) => failure?.kind === 'HTTP_403' && failure.bytes && /country|region|geograph|cloudfront/i.test(failure.bytes.toString('utf8', 0, Math.min(400, failure.bytes.length)));

// ---- client base ----------------------------------------------------------------------------------------------
export function createClientBase({ providerId, transport, clock = () => Date.now(), credential = null, log = () => {} }) {
  if (!transport || typeof transport.request !== 'function') fail('INVALID_REQUEST', 'a transport is required');
  let seq = 0; let runtime = 'STOPPED'; let lastFailure = null; let lastOkTs = null; let consecutiveFailures = 0;
  const counters = { requests: 0, ok: 0, failed: 0, observations: 0, rejectedRecords: 0 };
  const setRuntime = (s) => { runtime = s; };
  // one bounded request through the registry endpoint; returns transport result + a closed failure summary
  // the native charge is derived by the accounting authority from the ACTUAL request, never supplied by a caller
  async function call({ endpointId, pathParams, query, signal, maxBytes, method, body, share = true, purpose = null }) {
    counters.requests += 1;
    const r = await transport.request({ providerId, endpointId, pathParams, query, credential, signal, maxBytes, method, body, share, purpose });
    if (r.ok) { counters.ok += 1; lastOkTs = r.receivedTs; consecutiveFailures = 0; if (runtime === 'STARTING' || runtime === 'DEGRADED' || runtime === 'BACKOFF') setRuntime('ACTIVE'); return r; }
    counters.failed += 1; consecutiveFailures += 1;
    const kind = isGeoBlock(r.failure) ? 'GEO' : r.failure.kind;
    const [coverageState, reasonCode, access] = FAILURE_MAP[kind] ?? ['FAILED', 'PROVIDER_ERROR', null];
    lastFailure = deepFreeze({ kind, reason: r.failure.reason, status: r.failure.status ?? null, ts: r.failure.receivedTs ?? clock(), coverageState, reasonCode, access, retryAfterMs: r.failure.retryAfterMs ?? null, redactedUrl: r.failure.redactedUrl ?? null, refusalReasons: Array.isArray(r.failure.reasons) ? r.failure.reasons.slice(0, 8) : null });
    if (coverageState === 'ACCESS_BLOCKED') setRuntime('BLOCKED'); else if (kind === 'HTTP_429' || kind === 'BACKOFF_ACTIVE') setRuntime('BACKOFF'); else if (runtime !== 'STOPPED') setRuntime('DEGRADED');
    return { ok: false, failure: lastFailure, endpointId };
  }
  function emit(body) {
    const receivedTs = body.receivedTs;
    const ahead = clockConflict(body.sourceEventTs ?? null, receivedTs);
    const q = ahead ? quality('CLOCK_CONFLICT', { ...body.quality, reasonCodes: [...new Set([...(body.quality?.reasonCodes ?? []), 'SOURCE_EVENT_AHEAD_OF_RECEIPT'])] }) : body.quality;
    const o = makeObservation({ provider: providerId, sequence: (seq += 1), epochId: null, sourceRevision: null, sourceEventTs: null, publishedTs: null, periodStartTs: null, periodEndTs: null, sourceKey: null, ...body, quality: q, knownAtTs: Math.max(body.knownAtTs ?? receivedTs, receivedTs) });
    counters.observations += 1;
    return o;
  }
  const tryEmit = (body, where = 'record') => { try { return emit(body); } catch (err) { counters.rejectedRecords += 1; log(`${providerId}: ${where} rejected (${String(err?.message ?? err).slice(0, 140)})`); return null; } };
  const coverage = ({ endpointId, subject, family, kind = null, state, reasonCodes = [], startTs, endTs = null, observationCount = 0, droppedCount = 0, epochId = null, sequenceStart = null, sequenceEnd = null }) => makeCoverage({ provider: providerId, endpointId, subjectId: subjectId(subject), family, kind, state, reasonCodes, startTs, endTs, observationCount, droppedCount, epochId, sequenceStart, sequenceEnd });
  const failureCoverage = (failure, { endpointId, subject, family, kind = null, startTs }) => coverage({ endpointId, subject, family, kind, state: failure.coverageState, reasonCodes: failure.reasonCode === 'NONE' ? [] : [failure.reasonCode], startTs, endTs: failure.ts });
  const provenance = (r, { nativeLocator = null, mappingId = null, specificationId = null, vintage = null } = {}) => ({ ...emptyProvenance(), requestId: r.requestId ?? null, bytesSha256: r.sha256 ?? null, nativeLocator, mappingId, specificationId, vintage });
  return {
    providerId, call, emit, tryEmit, coverage, failureCoverage, provenance, clock, log,
    start: () => { if (runtime === 'STOPPED') setRuntime('STARTING'); }, stop: () => setRuntime('STOPPED'),
    status: () => deepFreeze({ providerId, runtime, lastFailure, lastOkTs, consecutiveFailures, counters: { ...counters }, credentialConfigured: typeof credential === 'string' && credential.length > 0 }),
    setRuntime, endpoint: (id) => endpointOf(providerId, id), nextSequence: () => (seq += 1),
  };
}
export const marketSubject = ({ canonicalCoin, providerAssetId = null, venue, nativeSymbol, base, quote, marketType = 'SPOT', quoteAliasGroup = null }) => ({ subjectKind: 'MARKET', canonicalCoin, providerAssetId, venue, nativeSymbol, base, quote, marketType, quoteAliasGroup });
export const assetSubject = ({ canonicalCoin, providerAssetId = null }) => ({ subjectKind: 'ASSET', canonicalCoin, providerAssetId });
export const derivativeSubject = ({ canonicalCoin, providerAssetId = null, venue, instrumentId, specificationId, marketType }) => ({ subjectKind: 'DERIVATIVE', canonicalCoin, providerAssetId, venue, instrumentId, specificationId, marketType });
export const seriesSubject = ({ seriesId = null, instrumentId = null, providerAssetId = null }) => ({ subjectKind: 'SERIES', canonicalCoin: null, providerAssetId, seriesId, instrumentId });
export const tokenSubject = ({ canonicalCoin, providerAssetId = null, chain, contractAddress = null, nativeTokenId = null }) => ({ subjectKind: 'TOKEN', canonicalCoin, providerAssetId, chain, contractAddress, nativeTokenId });
export const poolSubject = ({ canonicalCoin, providerAssetId = null, chain, poolAddress, quoteToken }) => ({ subjectKind: 'POOL', canonicalCoin, providerAssetId, chain, poolAddress, quoteToken });
export const protocolSubject = ({ protocolId, chain = null, canonicalCoin = null, providerAssetId = null }) => ({ subjectKind: 'PROTOCOL', canonicalCoin, providerAssetId, protocolId, chain });
export const providerSubject = (providerId) => ({ subjectKind: 'PROVIDER', canonicalCoin: null, providerAssetId: null, providerId });
export const assertFamily = (f) => { if (!FAMILIES.includes(f)) fail('INTERNAL_FAILURE', 'unknown family'); return f; };
export { isFiniteNum, isTs };
