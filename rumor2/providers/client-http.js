// Small transport helpers shared by the supported, injected-fetch clients.
// This file deliberately has no provider knowledge and never reads credentials.

export const DEFAULT_CLIENT_TIMEOUT_MS = 5_000;
export const DEFAULT_CLIENT_BODY_BYTES = 1_048_576;

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

export function clientClock(nowMs) {
  return Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : null;
}

export function boundedClientError(error, max = 200) {
  const text = typeof error === 'string' ? error : String(error?.message ?? error ?? 'unknown error');
  return text.replace(/\s+/g, ' ').slice(0, max);
}

export function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) ?? null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value == null ? null : String(value);
  }
  return null;
}

export async function readJsonBody(response, { maxBytes = DEFAULT_CLIENT_BODY_BYTES } = {}) {
  if (!response || typeof response !== 'object') return { ok: false, error: 'RESPONSE_INVALID' };
  let text;
  try {
    if (typeof response.text === 'function') text = await response.text();
    else if (typeof response.json === 'function') return { ok: true, body: await response.json() };
    else return { ok: false, error: 'RESPONSE_BODY_UNREADABLE' };
  } catch (error) {
    return { ok: false, error: `RESPONSE_BODY_READ_FAILED: ${boundedClientError(error)}` };
  }
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, error: 'RESPONSE_BODY_TOO_LARGE' };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'RESPONSE_JSON_MALFORMED' };
  }
}

// A fetch-compatible call with both caller cancellation and a bounded timeout.
// The fetch implementation is always supplied by the caller; this helper never
// reaches the global network transport.
export async function fetchWithTimeout(fetchImpl, url, init = {}, {
  timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'FETCH_NOT_INJECTED' };
  if (!isPositiveInt(timeoutMs)) return { ok: false, error: 'TIMEOUT_INVALID' };
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timer = null;
  const abort = () => {
    callerAborted = true;
    try { controller.abort(signal?.reason); } catch { controller.abort(); }
  };
  if (signal) {
    if (signal.aborted) abort();
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, { once: true });
  }
  timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort('timeout'); } catch { controller.abort(); }
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { ok: true, response, timedOut: false, callerAborted: false };
  } catch (error) {
    const reason = timedOut ? 'TIMEOUT' : callerAborted || signal?.aborted ? 'ABORTED' : `NETWORK_FAILED: ${boundedClientError(error)}`;
    return { ok: false, error: reason, timedOut, callerAborted };
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abort);
  }
}

export function failedPoll(error, { provider, retrievedTs = null, checkpoint = null, requests = 0 } = {}) {
  return Object.freeze({
    ok: false,
    status: 'FAILED',
    provider,
    error: boundedClientError(error),
    items: Object.freeze([]),
    observations: Object.freeze([]),
    retrievedTs,
    checkpoint,
    requests,
  });
}

export function emptyPoll({ provider, retrievedTs, checkpoint = null, requests = 0, ...extra } = {}) {
  return Object.freeze({
    ok: true,
    status: 'EMPTY',
    provider,
    items: Object.freeze([]),
    observations: Object.freeze([]),
    retrievedTs,
    checkpoint,
    requests,
    ...extra,
  });
}