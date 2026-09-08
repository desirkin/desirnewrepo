// MARKET LAB — bounded HTTP and WebSocket transport (§4). One implementation shared by every provider client.
//  * URLs are built ONLY from registry endpoints (fixed host + path template); the host must be in the provider's allowlist.
//  * Redirects are never followed (manual) — a 3xx is REDIRECT_REFUSED.
//  * Credentials travel by the endpoint's documented placement (header / bearer / query) and are REDACTED from every
//    diagnostic, request id and recording key; a query credential never appears in an error or a log.
//  * Responses are consumed through a byte cap; the exact bytes parsed are hashed; JSON goes through the strict parser.
//  * 429 honours Retry-After (bounded) as a per-provider backoff; 401/403 put a credential HOLD on the provider so a
//    rejected credential is never retried indefinitely; 5xx / network failures are reported, retries belong to callers.
//  * Concurrency: a global limiter and a per-provider limiter; identical in-flight requests (same sharedKey) share one
//    acquisition; one consumer's cancellation never cancels another consumer's shared work.
//  * A recorder hook captures every exchange (redacted request + response bytes) so a replay transport can serve the
//    same bytes network-free; replay never fetches.
//  * Closeout R01: an ADMISSION guard (market-lab/quota.js) is bound once; every dispatch is prechecked before queueing
//    and reserved atomically at the dispatch boundary; a refused or unreserved request never touches the wire; the
//    outcome settles / stays unresolved / is released (proven non-dispatch only). A transport constructed for
//    production (requireAdmission) refuses every request until a guard is bound; a plain transport is a TEST SEAM.
import { createHash } from 'node:crypto';
import { parseStrictJson, sha256Hex, isTs, isCount, deepFreeze, fail } from './contracts.js';
import { PROVIDERS, endpointOf } from './registry.js';
import { RESOURCE_DEFAULTS } from './policy.js';

export const FAILURE_KINDS = Object.freeze(['HOST_NOT_ALLOWED', 'ENDPOINT_UNKNOWN', 'CREDENTIAL_MISSING', 'CREDENTIAL_HOLD', 'BACKOFF_ACTIVE', 'TIMEOUT', 'NETWORK', 'CANCELLED', 'REDIRECT_REFUSED', 'HTTP_401', 'HTTP_403', 'HTTP_429', 'HTTP_4XX', 'HTTP_5XX', 'CONTENT_TYPE', 'BODY_TOO_LARGE', 'JSON_INVALID', 'SCHEMA', 'REPLAY_MISSING', 'STOPPED', 'QUOTA_REFUSED', 'CONCURRENCY_REFUSED', 'ADMISSION_UNBOUND']);
// dispatched-with-unknown-outcome kinds: the provider may have served (and billed) the request; never a proof of no charge
export const AMBIGUOUS_FAILURE_KINDS = Object.freeze(['TIMEOUT', 'NETWORK', 'BODY_TOO_LARGE']);
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 3_600_000;
export const DEFAULT_BACKOFF_MS = 60_000;
export const CREDENTIAL_HOLD_MS = 6 * 3_600_000; // a rejected credential is not retried for six hours unless an operator resets it
const REDACTED = '<redacted>';

export function parseRetryAfterMs(header, nowMs) {
  if (typeof header !== 'string' || header.length === 0 || header.length > 64) return null;
  const secs = Number(header);
  let ms = null;
  if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
  else { const at = Date.parse(header); if (Number.isFinite(at) && isTs(nowMs)) ms = at - nowMs; }
  if (ms === null) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round(ms)));
}
export const backoffMs = (attempt, { baseMs = 1_000, maxMs = 60_000 } = {}) => Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(20, attempt)));

const encodePath = (template, params = {}) => template.replace(/\{([a-zA-Z_]+)\}/g, (_, k) => { const v = params[k]; if (typeof v !== 'string' || v.length === 0 || v.length > 200 || /[\/?#]/.test(v)) fail('INVALID_REQUEST', `path parameter ${k} malformed`); return encodeURIComponent(v); });
const sortedQuery = (query = {}) => Object.keys(query).filter((k) => query[k] !== undefined && query[k] !== null).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`).join('&');

// Build the request plan for a registry endpoint: real URL (with credential where the provider demands a query key),
// redacted URL for identity/diagnostics, and headers. Never returns the credential in the redacted form.
export function planRequest({ providerId, endpointId, pathParams = {}, query = {}, credential = null, method = null, body = null, headers = {} }) {
  const e = endpointOf(providerId, endpointId);
  if (!e) return { ok: false, failure: { kind: 'ENDPOINT_UNKNOWN', reason: 'endpoint not in registry' } };
  if (!e.host || !PROVIDERS[providerId].hosts.includes(e.host)) return { ok: false, failure: { kind: 'HOST_NOT_ALLOWED', reason: 'host outside the provider allowlist' } };
  const path = encodePath(e.path, pathParams);
  const q = sortedQuery(query);
  const redactedUrl = `https://${e.host}${path}${q ? `?${q}` : ''}`;
  let url = redactedUrl;
  const h = { accept: 'application/json', 'user-agent': 'cobra-market-lab/1 (research; contact via repository)', ...headers };
  const needsCredential = e.authEnv !== null && e.authPlacement !== 'HEADER_OPTIONAL';
  if (needsCredential && !(typeof credential === 'string' && credential.length > 0)) return { ok: false, failure: { kind: 'CREDENTIAL_MISSING', reason: `credential ${e.authEnv} absent` }, redactedUrl };
  if (typeof credential === 'string' && credential.length > 0) {
    if (e.authPlacement === 'BEARER') h.authorization = `Bearer ${credential}`;
    else if (e.authPlacement === 'HEADER_APIKEY') h.authorization = `Apikey ${credential}`;
    else if (e.authPlacement === 'HEADER' || e.authPlacement === 'HEADER_OPTIONAL') h[providerId === 'COINGLASS' ? 'CG-API-KEY' : providerId === 'COINGECKO' ? 'x-cg-demo-api-key' : 'x-api-key'] = credential;
    else if (e.authPlacement === 'QUERY') { const qq = `${q ? `${q}&` : ''}api_key=${encodeURIComponent(credential)}`; url = `https://${e.host}${path}?${qq}`; }
    if (providerId === 'TWELVEDATA') { delete h.authorization; h.authorization = `apikey ${credential}`; }
  }
  const m = method ?? e.method;
  if (m === 'POST') h['content-type'] = 'application/json';
  return { ok: true, endpoint: e, method: m, url, redactedUrl, headers: h, body: body === null ? null : JSON.stringify(body), requestKey: `${m} ${redactedUrl}${body === null ? '' : ` ${sha256Hex(JSON.stringify(body)).slice(0, 16)}`}` };
}
const redactHeaders = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, /authorization|api-key|apikey/i.test(k) ? REDACTED : v]));

// ---- limiter ---------------------------------------------------------------------------------------------------
function createLimiter(max) {
  let active = 0; const waiters = [];
  if (!(Number.isSafeInteger(max) && max > 0)) return { acquire: () => Promise.reject(Object.assign(new Error('zero concurrency slots'), { kind: 'CONCURRENCY_REFUSED' })), release: () => {}, snapshot: () => ({ active: 0, queued: 0, max: 0 }) };
  const next = () => { while (active < max && waiters.length) { const w = waiters.shift(); if (w.signal?.aborted) { w.reject(Object.assign(new Error('cancelled'), { kind: 'CANCELLED' })); continue; } active += 1; w.resolve(); } };
  return {
    acquire: (signal) => new Promise((resolve, reject) => { if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { kind: 'CANCELLED' })); waiters.push({ resolve, reject, signal }); signal?.addEventListener?.('abort', () => { const i = waiters.findIndex((w) => w.resolve === resolve); if (i >= 0) { waiters.splice(i, 1); reject(Object.assign(new Error('cancelled'), { kind: 'CANCELLED' })); } }, { once: true }); next(); }),
    release: () => { active = Math.max(0, active - 1); next(); },
    snapshot: () => ({ active, queued: waiters.length, max }),
  };
}

// ---- HTTP transport ---------------------------------------------------------------------------------------------
export function createHttpTransport({ fetchImpl = globalThis.fetch, clock = () => Date.now(), limits = RESOURCE_DEFAULTS, recorder = null, log = () => {}, credentialHoldMs = CREDENTIAL_HOLD_MS, admission = null, requireAdmission = false } = {}) {
  if (typeof fetchImpl !== 'function') fail('INVALID_REQUEST', 'a fetch implementation is required');
  let guard = admission; // bound at most once; a production transport refuses until bound
  const bindAdmission = (g) => { if (guard) fail('INVALID_REQUEST', 'an admission guard is already bound'); if (!g || typeof g.admit !== 'function' || typeof g.precheck !== 'function') fail('INVALID_REQUEST', 'admission guard malformed'); guard = g; };
  const global = createLimiter(limits.httpConcurrencyGlobal);
  const perProvider = new Map();
  const state = new Map(); // providerId -> { backoffUntil, credentialHoldUntil, counters }
  const inFlight = new Map(); // requestKey -> { promise, consumers, controller }
  let stopped = false; let seq = 0;
  const st = (id) => { if (!state.has(id)) state.set(id, { backoffUntil: 0, credentialHoldUntil: 0, counters: { requests: 0, ok: 0, failed: 0, bytes: 0, credits: 0, shared: 0, refused: 0, lastRequestTs: null, byKind: {} } }); return state.get(id); };
  const lim = (id, max) => { if (!perProvider.has(id)) perProvider.set(id, createLimiter(max)); return perProvider.get(id); };
  const failure = (kind, reason, extra = {}) => ({ ok: false, failure: { kind, reason: String(reason ?? kind).slice(0, 160), ...extra } });

  async function perform(plan, { signal, timeoutMs, maxBytes, expectJson, requestId, providerId }) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) return failure('CANCELLED', 'cancelled before dispatch', { requestId }); signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { kind: 'TIMEOUT' })), timeoutMs);
    const startedTs = clock();
    try {
      let res;
      try { res = await fetchImpl(plan.url, { method: plan.method, headers: plan.headers, body: plan.body, signal: controller.signal, redirect: 'manual' }); }
      catch (err) { if (signal?.aborted) return failure('CANCELLED', 'cancelled', { requestId }); if (controller.signal.aborted) return failure('TIMEOUT', `no response within ${timeoutMs} ms`, { requestId }); return failure('NETWORK', err?.code ?? err?.name ?? 'fetch failed', { requestId }); }
      const status = res.status;
      const retryAfterMs = status === 429 || status === 503 ? parseRetryAfterMs(res.headers.get('retry-after'), clock()) : null;
      if (status >= 300 && status < 400) { try { await res.body?.cancel?.(); } catch { /* best effort */ } return failure('REDIRECT_REFUSED', 'redirect not followed', { status, requestId }); }
      // bounded body consumption — the exact bytes are hashed
      const chunks = []; let total = 0;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) { try { await reader.cancel(); } catch { /* best effort */ } return failure('BODY_TOO_LARGE', `body exceeds ${maxBytes} bytes`, { status, requestId }); }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      } else { const ab = Buffer.from(await res.arrayBuffer()); total = ab.byteLength; if (total > maxBytes) return failure('BODY_TOO_LARGE', `body exceeds ${maxBytes} bytes`, { status, requestId }); chunks.push(ab); }
      const bytes = Buffer.concat(chunks, total);
      const receivedTs = clock();
      const sha256 = sha256Hex(bytes);
      const contentType = String(res.headers.get('content-type') ?? '').toLowerCase();
      const base = { status, bytes, sha256, receivedTs, startedTs, durationMs: receivedTs - startedTs, requestId, retryAfterMs, contentType: contentType.slice(0, 80), redactedUrl: plan.redactedUrl };
      if (status === 401) return failure('HTTP_401', 'credential rejected', base);
      if (status === 403) return failure('HTTP_403', 'forbidden / plan or geographic denial', base);
      if (status === 429) return failure('HTTP_429', 'rate limited', base);
      if (status >= 500) return failure('HTTP_5XX', `provider error ${status}`, base);
      if (status >= 400) return failure('HTTP_4XX', `client error ${status}`, base);
      if (!expectJson) return { ok: true, ...base, json: null };
      if (!/application\/json|text\/json|\+json/.test(contentType)) return failure('CONTENT_TYPE', 'unexpected content type', base);
      const parsed = parseStrictJson(bytes, { maxBytes });
      if (!parsed.ok) return failure('JSON_INVALID', parsed.error, base);
      return { ok: true, ...base, json: parsed.value };
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }

  async function request({ providerId, endpointId, pathParams, query, credential = null, method = null, body = null, headers = {}, signal = null, timeoutMs = limits.httpTimeoutMs, maxBytes = limits.transportResponseBytes, expectJson = true, share = true, maxConcurrency = limits.httpConcurrencyPerProvider, purpose = null }) {
    if (stopped) return failure('STOPPED', 'transport stopped');
    if (requireAdmission && !guard) return failure('ADMISSION_UNBOUND', 'production transport has no admission guard bound — no dispatch');
    const plan = planRequest({ providerId, endpointId, pathParams, query, credential, method, body, headers });
    if (!plan.ok) return plan;
    const s = st(providerId); const now = clock();
    if (s.credentialHoldUntil > now) return failure('CREDENTIAL_HOLD', 'a rejected credential is not retried', { holdUntilTs: s.credentialHoldUntil, redactedUrl: plan.redactedUrl });
    if (s.backoffUntil > now) return failure('BACKOFF_ACTIVE', 'provider backoff in force', { backoffUntilTs: s.backoffUntil, redactedUrl: plan.redactedUrl });
    // in-flight coalescing: same redacted request key => one acquisition AND one reservation; cancellation is per consumer
    if (share && inFlight.has(plan.requestKey)) { const f = inFlight.get(plan.requestKey); f.consumers += 1; s.counters.shared += 1; return waitShared(f, signal); }
    // cheap refusal BEFORE queueing: disabled / zero / unknown conditions never wait in a limiter (no reservation yet)
    const adm = { providerId, endpointId, query: query ?? null, requestKey: plan.requestKey, purpose: purpose ?? undefined };
    if (guard) { const pre = guard.precheck(adm); if (!pre.ok) { s.counters.refused += 1; return failure('QUOTA_REFUSED', `admission refused: ${pre.reasons.join(',')}`, { reasons: pre.reasons, redactedUrl: plan.redactedUrl }); } maxConcurrency = Number.isSafeInteger(pre.maxConcurrency) ? pre.maxConcurrency : maxConcurrency; }
    if (!(Number.isSafeInteger(maxConcurrency) && maxConcurrency > 0)) { s.counters.refused += 1; return failure('CONCURRENCY_REFUSED', 'zero concurrency slots for this provider', { redactedUrl: plan.redactedUrl }); }
    const entry = { consumers: 1, controller: new AbortController(), promise: null };
    if (share) inFlight.set(plan.requestKey, entry);
    entry.promise = (async () => {
      const requestId = `req-${(seq += 1).toString(36)}-${sha256Hex(plan.requestKey).slice(0, 12)}`;
      let gotGlobal = false; let gotProv = false; const pl = lim(providerId, maxConcurrency); let reservationId = null;
      try {
        await global.acquire(entry.controller.signal); gotGlobal = true;
        await pl.acquire(entry.controller.signal); gotProv = true;
        // the atomic admission at the dispatch boundary: recheck + durable reservation, THEN the wire (never the reverse)
        let charge = null;
        if (guard) { const a = guard.admit(adm); if (!a.ok) { s.counters.refused += 1; return failure('QUOTA_REFUSED', `admission refused: ${a.reasons.join(',')}`, { reasons: a.reasons, redactedUrl: plan.redactedUrl, requestId }); } reservationId = a.reservationId; charge = a.charge; }
        if (entry.controller.signal.aborted) { if (reservationId) { guard.release(reservationId, 'CANCELLED_BEFORE_DISPATCH'); reservationId = null; } return failure('CANCELLED', 'cancelled before dispatch', { requestId }); }
        s.counters.requests += 1; s.counters.credits += charge ? charge.credits : 0; s.counters.lastRequestTs = clock();
        const r = await perform(plan, { signal: entry.controller.signal, timeoutMs, maxBytes, expectJson, requestId, providerId });
        const kind = r.ok ? 'OK' : r.failure.kind; s.counters.byKind[kind] = (s.counters.byKind[kind] ?? 0) + 1;
        if (reservationId) { if (r.ok) guard.settle(reservationId, { ok: true, status: r.status }); else if (r.failure.kind === 'CANCELLED' && r.failure.reason === 'cancelled before dispatch') guard.release(reservationId, 'CANCELLED_BEFORE_DISPATCH'); else if (AMBIGUOUS_FAILURE_KINDS.includes(r.failure.kind) || r.failure.kind === 'CANCELLED') guard.unresolved(reservationId, r.failure.kind); else guard.settle(reservationId, { ok: false, status: r.failure.status ?? null }); reservationId = null; }
        if (r.ok) { s.counters.ok += 1; s.counters.bytes += r.bytes.byteLength; }
        else {
          s.counters.failed += 1;
          if (r.failure.kind === 'HTTP_429' || (r.failure.kind === 'HTTP_5XX' && r.failure.retryAfterMs)) s.backoffUntil = clock() + (r.failure.retryAfterMs ?? DEFAULT_BACKOFF_MS);
          if (r.failure.kind === 'HTTP_401' || (r.failure.kind === 'HTTP_403' && credential)) s.credentialHoldUntil = clock() + credentialHoldMs;
        }
        if (recorder) { try { recorder({ requestKey: plan.requestKey, providerId, endpointId, method: plan.method, redactedUrl: plan.redactedUrl, headers: redactHeaders(plan.headers), body: plan.body, ok: r.ok, status: r.status ?? r.failure?.status ?? null, failureKind: r.ok ? null : r.failure.kind, bytesSha256: r.sha256 ?? r.failure?.sha256 ?? null, bytes: r.bytes ?? r.failure?.bytes ?? null, contentType: r.contentType ?? r.failure?.contentType ?? null, receivedTs: r.receivedTs ?? r.failure?.receivedTs ?? clock(), requestId }); } catch (err) { log(`recorder failed (contained): ${String(err?.message ?? err).slice(0, 120)}`); } }
        return Object.freeze(r); // shallow: the body Buffer cannot be frozen
      } catch (err) { if (reservationId) { guard.unresolved(reservationId, 'INTERNAL'); reservationId = null; } s.counters.failed += 1; return failure(err?.kind === 'CANCELLED' ? 'CANCELLED' : err?.kind === 'CONCURRENCY_REFUSED' ? 'CONCURRENCY_REFUSED' : 'NETWORK', err?.kind ?? err?.name ?? 'failure'); }
      finally { if (gotProv) pl.release(); if (gotGlobal) global.release(); if (share) inFlight.delete(plan.requestKey); }
    })();
    return waitShared(entry, signal);
  }
  // one consumer's abort resolves ITS wait as CANCELLED; the shared work is aborted only when the last consumer leaves
  function waitShared(entry, signal) {
    if (!signal) return entry.promise;
    if (signal.aborted) { leave(entry); return Promise.resolve(failure('CANCELLED', 'cancelled')); }
    return new Promise((resolve) => { const onAbort = () => { leave(entry); resolve(failure('CANCELLED', 'cancelled')); }; signal.addEventListener('abort', onAbort, { once: true }); entry.promise.then((r) => { signal.removeEventListener('abort', onAbort); resolve(r); }); });
  }
  function leave(entry) { entry.consumers -= 1; if (entry.consumers <= 0) entry.controller.abort(); }

  return {
    request, bindAdmission, guarded: () => guard !== null,
    accounting: () => deepFreeze(Object.fromEntries([...state.entries()].map(([id, s]) => [id, { ...s.counters, byKind: { ...s.counters.byKind }, backoffUntilTs: s.backoffUntil || null, credentialHoldUntilTs: s.credentialHoldUntil || null }]))),
    resetCredentialHold: (providerId) => { st(providerId).credentialHoldUntil = 0; },
    limiter: () => ({ global: global.snapshot(), providers: Object.fromEntries([...perProvider.entries()].map(([k, v]) => [k, v.snapshot()])) }),
    inFlight: () => inFlight.size,
    stop: () => { stopped = true; for (const e of inFlight.values()) e.controller.abort(); },
  };
}

// ---- record / replay --------------------------------------------------------------------------------------------
// A recording is a list of exchanges as emitted by the recorder hook (bytes kept as base64 when serialized).
export const serializeExchange = (x) => ({ ...x, bytes: x.bytes ? Buffer.from(x.bytes).toString('base64') : null });
export const deserializeExchange = (x) => ({ ...x, bytes: typeof x.bytes === 'string' ? Buffer.from(x.bytes, 'base64') : null });
// A fetch-shaped function that serves recorded exchanges by redacted URL + method, network-free. Missing => REPLAY_MISSING (a 599 status the transport maps to HTTP_5XX would lie; instead throw a typed error the transport reports as NETWORK with the replay kind).
export function createReplayFetch(exchanges) {
  const byKey = new Map();
  for (const x of exchanges) { const d = deserializeExchange(x); const key = `${d.method} ${d.redactedUrl}`; if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(d); }
  return async function replayFetch(url, init) {
    const redacted = url.replace(/([?&])api_key=[^&]*/, '$1api_key=<redacted>').replace(/api_key=<redacted>&?/, '').replace(/\?$/, '');
    const key = `${init?.method ?? 'GET'} ${redacted}`;
    const list = byKey.get(key);
    if (!list || list.length === 0) throw Object.assign(new Error('no recorded exchange'), { kind: 'REPLAY_MISSING', code: 'REPLAY_MISSING' });
    const d = list.length > 1 ? list.shift() : list[0];
    const body = d.bytes ?? Buffer.alloc(0);
    return new Response(body, { status: d.status ?? 200, headers: { 'content-type': d.contentType ?? 'application/json' } });
  };
}

// ---- WebSocket client ---------------------------------------------------------------------------------------------
export const WS_STATES = Object.freeze(['STOPPED', 'CONNECTING', 'OPEN', 'BACKOFF', 'STOPPING']);
export function createWsClient({ providerId, endpointId, WebSocketImpl = globalThis.WebSocket, clock = () => Date.now(), onMessage, onOpen = () => {}, onClose = () => {}, log = () => {}, idleTimeoutMs = RESOURCE_DEFAULTS.wsIdleTimeoutMs, maxMessageBytes = RESOURCE_DEFAULTS.transportResponseBytes, reconnectBaseMs = 1_000, reconnectMaxMs = 30_000, url = null } = {}) {
  const e = endpointOf(providerId, endpointId);
  if (!e || e.method !== 'WS') fail('INVALID_REQUEST', 'unknown websocket endpoint');
  if (!PROVIDERS[providerId].hosts.includes(e.host)) fail('INVALID_REQUEST', 'websocket host outside allowlist');
  const target = url ?? `wss://${e.host}${e.path}`;
  if (!target.startsWith(`wss://${e.host}`) && !/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(target)) fail('INVALID_REQUEST', 'websocket url must be the registry host (or a loopback test server)');
  let ws = null; let state = 'STOPPED'; let epoch = 0; let attempt = 0; let idleTimer = null; let reconnectTimer = null;
  const counters = { messages: 0, bytes: 0, dropped: 0, invalidJson: 0, reconnects: 0, lastMessageTs: null, openedTs: null };
  const epochId = () => `${providerId}:${endpoint()}:${epoch}`; const endpoint = () => endpointId;
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (ws && state === 'OPEN') { log(`ws idle ${idleTimeoutMs} ms — reconnecting`); try { ws.close(); } catch { /* best effort */ } } }, idleTimeoutMs); };
  function connect() {
    if (state === 'STOPPING' || state === 'STOPPED' && epoch > 0 && !reconnectTimer) return;
    state = 'CONNECTING'; epoch += 1;
    let sock;
    try { sock = new WebSocketImpl(target); } catch (err) { state = 'BACKOFF'; schedule(); return; }
    ws = sock;
    sock.onopen = () => { state = 'OPEN'; attempt = 0; counters.openedTs = clock(); armIdle(); try { onOpen({ epochId: epochId(), send }); } catch (err) { log(`ws onOpen failed: ${String(err?.message).slice(0, 120)}`); } };
    sock.onmessage = (ev) => {
      const receivedTs = clock(); counters.lastMessageTs = receivedTs; armIdle();
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data);
      const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
      counters.messages += 1; counters.bytes += size;
      if (size > maxMessageBytes) { counters.dropped += 1; return; }
      const parsed = parseStrictJson(raw, { maxBytes: maxMessageBytes });
      if (!parsed.ok) { counters.invalidJson += 1; return; }
      try { onMessage(parsed.value, { receivedTs, epochId: epochId(), bytesSha256: sha256Hex(typeof raw === 'string' ? Buffer.from(raw) : raw), bytes: size }); } catch (err) { log(`ws consumer failed (contained): ${String(err?.message).slice(0, 120)}`); }
    };
    sock.onerror = () => {};
    sock.onclose = () => { clearTimeout(idleTimer); const was = state; ws = null; try { onClose({ epochId: epochId(), reason: was === 'STOPPING' ? 'STOPPED' : 'CLOSED' }); } catch { /* contained */ } if (was === 'STOPPING') { state = 'STOPPED'; return; } state = 'BACKOFF'; counters.reconnects += 1; schedule(); };
  }
  function schedule() { const delay = backoffMs(attempt, { baseMs: reconnectBaseMs, maxMs: reconnectMaxMs }); attempt += 1; reconnectTimer = setTimeout(() => { reconnectTimer = null; if (state !== 'STOPPING' && state !== 'STOPPED') connect(); }, delay); }
  function send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }
  return {
    start: () => { if (state !== 'STOPPED') return; connect(); },
    // stop never hangs: a peer that ignores the close handshake is cut after a bounded grace period
    stop: ({ graceMs = 2000 } = {}) => new Promise((resolve) => { if (state === 'STOPPED') return resolve(); clearTimeout(reconnectTimer); reconnectTimer = null; clearTimeout(idleTimer); if (!ws) { state = 'STOPPED'; return resolve(); } state = 'STOPPING'; const sock = ws; let done = false; const finish = () => { if (done) return; done = true; clearTimeout(grace); state = 'STOPPED'; ws = null; resolve(); }; const prev = sock.onclose; sock.onclose = (ev) => { try { prev?.(ev); } catch { /* contained */ } finish(); }; const grace = setTimeout(() => { log('ws close handshake timed out — terminating'); try { sock.onclose = null; sock.close(); } catch { /* ignore */ } try { onClose({ epochId: epochId(), reason: 'STOPPED' }); } catch { /* contained */ } finish(); }, graceMs); grace.unref?.(); try { sock.close(); } catch { finish(); } }),
    send,
    status: () => deepFreeze({ state, epoch, epochId: epochId(), attempt, ...counters }),
  };
}
export const sha256OfString = (s) => createHash('sha256').update(s).digest('hex');
export { isCount };
