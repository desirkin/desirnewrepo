// Small, provider-neutral HTTP boundary for infrastructure feeds.
// URLs are supplied by the source modules (never by provider payloads), response
// bodies are byte bounded, redirects are not followed, and failures are data.

export const DEFAULT_HTTP_LIMITS = Object.freeze({
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
});

const failure = (code, message, extra = {}) => ({
  ok: false,
  status: 'FAILED',
  failure: { code, message: String(message).slice(0, 200), ...extra },
});

export async function requestJson(url, {
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  timeoutMs = DEFAULT_HTTP_LIMITS.timeoutMs,
  maxBytes = DEFAULT_HTTP_LIMITS.maxBytes,
  headers = {},
  signal = null,
} = {}) {
  const receivedAt = () => {
    const ts = clock();
    return { receivedTs: ts, receivedAt: new Date(ts).toISOString() };
  };
  const provenance = { ...receivedAt(), url };
  if (typeof fetchImpl !== 'function') return { ...failure('FETCH_UNAVAILABLE', 'fetch is unavailable'), provenance };
  if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0) || !(Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    return { ...failure('INVALID_LIMIT', 'request limits are invalid'), provenance };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return { ...failure('CANCELLED', 'request cancelled'), provenance };
    signal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      return { ...failure(signal?.aborted ? 'CANCELLED' : 'NETWORK', signal?.aborted ? 'request cancelled' : (error?.name ?? 'network failure')), provenance: { ...provenance, ...receivedAt() } };
    }
    const got = { ...provenance, ...receivedAt(), httpStatus: response.status };
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      return { ...failure('REDIRECT_REFUSED', 'redirects are not followed', { httpStatus: response.status }), provenance: got };
    }
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UPSTREAM_ERROR' : 'HTTP_ERROR';
      return { ...failure(code, `upstream HTTP ${response.status}`, { httpStatus: response.status }), provenance: got };
    }
    const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
    if (contentType && !/json|javascript|text\/plain/.test(contentType)) {
      try { await response.body?.cancel?.(); } catch { /* best effort */ }
      return { ...failure('CONTENT_TYPE', 'upstream did not return a JSON-compatible content type'), provenance: got };
    }
    let bytes;
    try {
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return { ...failure('BODY_TOO_LARGE', `response exceeds ${maxBytes} bytes`), provenance: got };
          }
          chunks.push(Buffer.from(part.value.buffer, part.value.byteOffset, part.value.byteLength));
        }
        bytes = Buffer.concat(chunks, total);
      } else {
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) return { ...failure('BODY_TOO_LARGE', `response exceeds ${maxBytes} bytes`), provenance: got };
      }
    } catch (error) {
      return { ...failure(controller.signal.aborted ? 'TIMEOUT' : 'BODY_READ', controller.signal.aborted ? 'response timed out' : (error?.name ?? 'response body could not be read')), provenance: got };
    }
    let data;
    try {
      data = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { ...failure('INVALID_JSON', 'upstream JSON could not be parsed'), provenance: got };
    }
    return { ok: true, status: 'DATA', data, provenance: got };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

export const failed = (code, message, provenance = {}) => ({ ...failure(code, message), provenance });