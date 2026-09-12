// Bounded transport for optional observation sources. The deadline includes streamed body reads;
// byte limits are enforced before buffering, and credentials never cross a redirect origin.
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?fe80:|\[?fc|\[?fd)/i;
export const BOUNDED_FETCH_DEFAULTS = Object.freeze({ timeoutMs: 10000, maxBytes: 2 * 1024 * 1024, maxRedirects: 2 });
export function pinnedUrlError(rawUrl, { host, redirectHosts = [] }) {
  let u; try { u = new URL(rawUrl); } catch { return 'unparseable URL'; }
  if (u.protocol !== 'https:') return 'https only';
  if (u.username || u.password || u.port) return 'URL credentials or non-default port rejected';
  if (PRIVATE_HOST_RE.test(u.hostname)) return 'loopback / private target rejected';
  if (![host, ...redirectHosts].includes(u.hostname)) return 'host outside pinned set';
  return null;
}
const header = (r, name) => r.headers?.get?.(name) ?? null;
const cancel = (body) => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch { /* already locked */ } };
export function retryAfterSeconds(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}
async function requestBounded(url, options, json) {
  const { host, redirectHosts = [], headers = {}, fetchImpl = fetch, timeoutMs = 10000, maxBytes = 2097152, maxRedirects = 2,
    etag = null, lastModified = null, signal = null, method = 'GET', body = undefined, jsonReviver = undefined } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5 || !['GET', 'POST'].includes(method)) return { outcome: 'FAILED', reason: 'invalid transport bounds or method' };
  if (signal?.aborted) return { outcome: 'FAILED', reason: 'request stopped' };
  const ctl = new AbortController(); let reader = null; let response = null; let timer;
  const abort = () => ctl.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const deadline = new Promise((_, reject) => {
    const fail = () => reject(new Error(signal?.aborted ? 'request stopped' : `timeout after ${timeoutMs}ms`));
    ctl.signal.addEventListener('abort', fail, { once: true });
    if (ctl.signal.aborted) fail(); else timer = setTimeout(abort, timeoutMs);
  });
  const race = (p) => Promise.race([p, deadline]);
  let current = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const bad = pinnedUrlError(current, { host, redirectHosts: json ? [] : redirectHosts });
      if (bad) return { outcome: 'FAILED', reason: bad };
      const h = { ...(json ? { accept: 'application/json' } : {}), ...headers };
      if (etag) h['if-none-match'] = etag; if (lastModified) h['if-modified-since'] = lastModified;
      response = await race(fetchImpl(current, { method, body, headers: h, redirect: 'manual', signal: ctl.signal }));
      const status = response.status;
      if (status === 304) return etag || lastModified ? { outcome: 'NOT_MODIFIED', status } : { outcome: 'FAILED', status, reason: 'unsolicited 304 without conditional request' };
      if (status === 429) return { outcome: 'RATE_LIMITED', status, retryAfterSec: retryAfterSeconds(header(response, 'retry-after')) };
      if (status >= 300 && status < 400) {
        if (json || method !== 'GET') return { outcome: 'FAILED', status, reason: 'redirect refused' };
        const location = header(response, 'location'); if (!location) return { outcome: 'FAILED', status, reason: 'redirect without location' };
        const next = new URL(location, current).toString();
        const credentials = Object.keys(h).some((k) => !['accept', 'user-agent', 'if-none-match', 'if-modified-since'].includes(k.toLowerCase()));
        if (credentials && new URL(next).origin !== new URL(current).origin) return { outcome: 'FAILED', status, reason: 'credential-bearing cross-origin redirect refused' };
        cancel(response.body); response = null; current = next; continue;
      }
      const contentType = header(response, 'content-type') ?? '';
      const declared = Number(header(response, 'content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) return { outcome: 'FAILED', status, reason: `body over ${maxBytes} bytes` };
      if (!response.body?.getReader) return { outcome: 'FAILED', status, reason: 'response has no readable body' };
      reader = response.body.getReader(); const parts = []; let size = 0;
      for (;;) {
        const { value, done } = await race(reader.read()); if (done) break;
        size += value.byteLength; if (size > maxBytes) return { outcome: 'FAILED', status, reason: `body over ${maxBytes} bytes` };
        parts.push(Buffer.from(value));
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      const result = { outcome: response.ok ? 'OK' : 'FAILED', status, contentType, etag: header(response, 'etag'), lastModified: header(response, 'last-modified') };
      result.rateHeaders = Object.fromEntries(['x-ratelimit-remaining','x-ratelimit-reset','x-ratelimit-used'].map(k => [k, header(response, k)]));
      if (!response.ok) result.reason = `HTTP ${status}`;
      if (json) {
        if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)) return { outcome: response.ok ? 'PARSE_FAILED' : 'FAILED', status, reason: 'JSON content type required' };
        try { result.json = JSON.parse(text, jsonReviver); } catch { return { outcome: response.ok ? 'PARSE_FAILED' : 'FAILED', status, reason: 'invalid JSON response' }; }
      } else result.text = text;
      return result;
    }
    return { outcome: 'FAILED', reason: `more than ${maxRedirects} redirects` };
  } catch (err) {
    // Neither URLs, response text, nor transport error messages may echo credentials into status.
    return { outcome: 'FAILED', reason: ctl.signal.aborted ? (signal?.aborted ? 'request stopped' : `timeout after ${timeoutMs}ms`) : err instanceof TypeError ? 'network or response decoding failed' : 'transport failed' };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (reader) { cancel(reader); try { reader.releaseLock(); } catch { /* pending read */ } }
    else cancel(response?.body);
  }
}
export const fetchTextBounded = (url, options = {}) => requestBounded(url, options, false);
export const fetchJsonBounded = (url, options = {}) => requestBounded(url, options, true);
