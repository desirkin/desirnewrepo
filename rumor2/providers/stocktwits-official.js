// StockTwits Firestream client.
//
// This is intentionally separate from the legacy symbol REST RUMINT ear.  It
// only speaks the documented Firestream messages route, is read-only, and
// emits transient, point-in-time envelopes.  Durable adoption is owned by a
// caller.  The transport is injected so this module can be tested without
// credentials or an internet connection.
import {
  STOCKTWITS_OFFICIAL,
  STOCKTWITS_ROUTES,
  evaluateStocktwitsAccess,
  firestreamEnvelopeToPreview,
  opaqueSeqId,
  canonicalDecimalId,
  isSupportedClock,
} from '../social-stocktwits.js';
import { contentHash, canonicalJson } from '../truth.js';

export const STOCKTWITS_FIRESTREAM = Object.freeze({
  id: STOCKTWITS_OFFICIAL.id,
  host: 'firestream.stocktwits.com',
  path: '/stream',
  route: 'FIRESTREAM_MESSAGES',
  credentialEnvs: STOCKTWITS_OFFICIAL.credentialEnvs,
  readOnly: true,
  mutation: false,
  maxSymbols: 16,
  maxFrameBytes: 256 * 1024,
});

const SYMBOL_RE = /^[A-Za-z0-9._-]{1,20}$/;
const MAX_EVENT_ID_CHARS = 64;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const boundedSymbols = (scope) => {
  const values = Array.isArray(scope) ? scope : scope?.symbols;
  if (!Array.isArray(values) || values.length === 0 || values.length > STOCKTWITS_FIRESTREAM.maxSymbols) return null;
  const out = [...new Set(values.filter((s) => typeof s === 'string' && SYMBOL_RE.test(s)).map((s) => s.toUpperCase()))];
  return out.length === values.length ? out.sort() : null;
};
const credentialPresent = (env) => STOCKTWITS_OFFICIAL.credentialEnvs.every((k) => typeof env?.[k] === 'string' && env[k].length > 0);
const eventId = ({ object, action, nativeId, versionId, seqId }) =>
  `r2st-${contentHash(canonicalJson({ object, action, nativeId, versionId: versionId ?? null, seqId: seqId ?? null }))}`.slice(0, MAX_EVENT_ID_CHARS);

function firestreamSymbols(data) {
  if (!Array.isArray(data?.symbols)) return [];
  return data.symbols.map((s) => (typeof s?.symbol === 'string' ? s.symbol.toUpperCase() : null)).filter(Boolean);
}

export function stocktwitsFirestreamRequest({ cursor = null } = {}) {
  const seq = opaqueSeqId(cursor);
  const query = seq === null ? '' : `?seq_id=${encodeURIComponent(seq)}`;
  return Object.freeze({
    method: 'GET',
    url: `https://${STOCKTWITS_FIRESTREAM.host}${STOCKTWITS_FIRESTREAM.path}${query}`,
    host: STOCKTWITS_FIRESTREAM.host,
    path: STOCKTWITS_FIRESTREAM.path,
    query: seq === null ? Object.freeze({}) : Object.freeze({ seq_id: seq }),
    headers: Object.freeze({ Accept: 'text/event-stream, application/x-ndjson', Authorization: 'BASIC_CREDENTIAL_INJECTED_AT_DISPATCH' }),
    cursor: seq,
    readOnly: true,
    mutation: false,
  });
}

export function stocktwitsFirestreamAccess({ env = process.env, record = null, nowMs = null, enabled = false } = {}) {
  const evaluation = evaluateStocktwitsAccess({ record, env, nowMs });
  const blockers = [...evaluation.blockers];
  if (enabled !== true) blockers.push('DISABLED_BY_POLICY');
  if (!isSupportedClock(nowMs)) blockers.push('ACQUISITION_CLOCK_REQUIRED');
  if (!credentialPresent(env)) blockers.push('CREDENTIAL_MISSING');
  // An operator attestation is necessary but is never silently treated as
  // platform proof.  The explicit enable switch remains an independent gate.
  return Object.freeze({
    allowed: blockers.length === 0 && evaluation.activationPrerequisitesMet === true,
    enabled: enabled === true,
    credentialPresent: credentialPresent(env),
    evaluation,
    blockers: Object.freeze([...new Set(blockers)]),
    receiptClaim: 'NONE',
  });
}

// Convert one official lifecycle envelope into a bounded transient event.
// Unknown objects are ignored by the caller but never mistaken for messages.
export function stocktwitsFirestreamEnvelope(envelope, { retrievedTs, symbols = null } = {}) {
  if (!isSupportedClock(retrievedTs)) return { status: 'SKIPPED', reason: 'ACQUISITION_CLOCK_REQUIRED' };
  if (!isObject(envelope) || !['create', 'destroy'].includes(envelope.action) || typeof envelope.object !== 'string') {
    return { status: 'SKIPPED', reason: 'ENVELOPE_MALFORMED' };
  }
  if (envelope.object !== 'Message') return { status: 'UNSUPPORTED', reason: 'OBJECT_NOT_MESSAGE' };
  if (!isObject(envelope.data)) return { status: 'SKIPPED', reason: 'MESSAGE_DATA_MISSING' };
  const nativeId = canonicalDecimalId(envelope.data.id);
  if (nativeId === null) return { status: 'SKIPPED', reason: 'MESSAGE_ID_MALFORMED' };
  const wanted = boundedSymbols(symbols);
  if (wanted === null) return { status: 'SKIPPED', reason: 'SYMBOL_SCOPE_REQUIRED' };
  if (!firestreamSymbols(envelope.data).some((s) => wanted.includes(s))) return { status: 'FILTERED', reason: 'OUT_OF_SCOPE' };
  const seqId = opaqueSeqId(envelope.seq_id);
  const mapped = firestreamEnvelopeToPreview(envelope, { retrievedTs });
  if (mapped.skip || mapped.unsupported) return { status: mapped.unsupported ? 'UNSUPPORTED' : 'SKIPPED', reason: mapped.unsupported?.reason ?? mapped.reason, preview: mapped.preview ?? null };
  const preview = mapped.preview;
  return {
    status: 'EVENT',
    eventId: eventId({ object: envelope.object, action: envelope.action, nativeId, versionId: preview?.nativeVersionId, seqId }),
    provider: STOCKTWITS_OFFICIAL.id,
    route: STOCKTWITS_FIRESTREAM.route,
    nativeId,
    seqId,
    action: envelope.action,
    retrievedTs: Math.floor(retrievedTs),
    knownAtTs: Math.floor(retrievedTs),
    preview,
    readOnly: true,
    mutation: false,
  };
}

function parseLines(chunk, carry) {
  const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  const all = carry + text;
  const lines = all.split(/\r?\n/);
  return { lines: lines.slice(0, -1), carry: lines.at(-1) ?? '' };
}

// Firestream is documented as a lifecycle stream.  Accept both SSE data lines
// and NDJSON in the transport boundary; neither path permits arbitrary URLs.
export function createStocktwitsFirestreamClient({
  env = process.env,
  accessRecord = null,
  enabled = false,
  scope = null,
  now = () => Date.now(),
  transport = null,
  onEvent = () => {},
  maxReconnects = 3,
  backoffBaseMs = 250,
  backoffMaxMs = 10_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const symbols = boundedSymbols(scope);
  let cursor = null;
  let carry = '';
  let stopped = false;
  const state = { reconnects: 0, connects: 0, events: 0, filtered: 0, skipped: 0, failures: 0, lastError: null, lastStatus: 'DISABLED' };
  const emitLine = (line, receiptTs) => {
    const raw = line.trim();
    if (!raw || raw.startsWith(':') || raw.startsWith('event:')) return null;
    const json = raw.startsWith('data:') ? raw.slice(5).trim() : raw;
    if (!json) return null;
    if (Buffer.byteLength(json, 'utf8') > STOCKTWITS_FIRESTREAM.maxFrameBytes) { state.skipped += 1; return { status: 'SKIPPED', reason: 'FRAME_TOO_LARGE' }; }
    let envelope;
    try { envelope = JSON.parse(json); } catch { state.skipped += 1; return { status: 'SKIPPED', reason: 'INVALID_JSON' }; }
    const result = stocktwitsFirestreamEnvelope(envelope, { retrievedTs: receiptTs, symbols });
    if (result.seqId !== null) cursor = result.seqId;
    if (result.status === 'EVENT') { state.events += 1; onEvent(result); }
    else if (result.status === 'FILTERED') state.filtered += 1;
    else state.skipped += 1;
    return result;
  };
  async function consume(response) {
    const body = response?.body ?? response;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('FIRESTREAM_TRANSPORT_BODY_NOT_ASYNC_ITERABLE');
    for await (const chunk of body) {
      if (stopped) break;
      const parsed = parseLines(chunk, carry); carry = parsed.carry;
      for (const line of parsed.lines) if (!stopped) emitLine(line, Math.floor(now()));
    }
    if (carry.trim()) emitLine(carry, Math.floor(now()));
  }
  const connect = async () => {
    if (typeof transport !== 'function' && typeof transport?.connect !== 'function') throw new Error('FIRESTREAM_TRANSPORT_REQUIRED');
    const req = stocktwitsFirestreamRequest({ cursor });
    const user = env[STOCKTWITS_OFFICIAL.credentialEnvs[0]];
    const pass = env[STOCKTWITS_OFFICIAL.credentialEnvs[1]];
    const headers = { ...req.headers, Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
    const call = typeof transport === 'function' ? transport : transport.connect.bind(transport);
    const response = await call({ ...req, headers });
    if (!response || response.status < 200 || response.status >= 300) throw new Error(`FIRESTREAM_HTTP_${response?.status ?? 'NO_STATUS'}`);
    state.connects += 1; state.lastStatus = 'CONNECTED';
    await consume(response);
  };
  async function run() {
    const access = stocktwitsFirestreamAccess({ env, record: accessRecord, nowMs: Math.floor(now()), enabled });
    if (!access.allowed) { state.lastStatus = enabled ? 'BLOCKED' : 'DISABLED'; return { ok: false, status: state.lastStatus, access, state: { ...state } }; }
    if (symbols === null) { state.lastStatus = 'BLOCKED'; state.lastError = 'SYMBOL_SCOPE_REQUIRED'; return { ok: false, status: state.lastStatus, access, state: { ...state } }; }
    if (typeof transport !== 'function' && typeof transport?.connect !== 'function') { state.lastStatus = 'FAILED'; state.lastError = 'FIRESTREAM_TRANSPORT_REQUIRED'; return { ok: false, status: state.lastStatus, error: state.lastError, access, state: { ...state } }; }
    stopped = false; state.lastStatus = 'RUNNING';
    while (!stopped) {
      try { await connect(); state.reconnects = 0; if (stopped) break; }
      catch (error) {
        state.failures += 1; state.lastError = String(error?.message ?? error).slice(0, 200); state.lastStatus = 'FAILED';
        if (state.reconnects >= maxReconnects) return { ok: false, status: 'FAILED', error: state.lastError, access, state: { ...state } };
        const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** state.reconnects); state.reconnects += 1; await sleep(delay);
      }
    }
    return { ok: true, status: state.events === 0 ? 'EMPTY' : 'OBSERVED', cursor, access, state: { ...state } };
  }
  return {
    run,
    stop() { stopped = true; state.lastStatus = 'STOPPED'; },
    cursor: () => cursor,
    status: () => ({ ...state, cursor, symbols: symbols ? [...symbols] : null, readOnly: true, mutation: false }),
  };
}

export const stocktwitsFirestreamClient = createStocktwitsFirestreamClient;