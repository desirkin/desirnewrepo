// SHARED bounded fetch for the dark observation tiers (press/, infra/): https only, ONE pinned host (plus an explicit closed
// redirect set for text feeds), no credentials or ports in the URL, a deadline over the whole attempt, a body byte cap,
// conditional GET headers where offered, Retry-After surfaced. A response can never steer a collector to another host and a
// stalled body is terminated like a hung connection. Deliberately separate from rumor2/http.js: the official-ear transport
// stays the one LIVE rumor2 wiring point; this module is shared plumbing with no authority of its own.
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|\[?fe80:|\[?fc|\[?fd)/i;
const boundedErr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
export const BOUNDED_FETCH_DEFAULTS = Object.freeze({ timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 2 });
export function pinnedUrlError(rawUrl, { host, redirectHosts = [] }) {
  let u; try { u = new URL(rawUrl); } catch { return 'unparseable URL'; }
  if (u.protocol !== 'https:') return `scheme ${u.protocol} rejected — https only`; if (u.username || u.password) return 'URL credentials rejected'; if (u.port) return `non-default port ${u.port} rejected`;
  const h = u.hostname.toLowerCase(); if (PRIVATE_HOST_RE.test(h)) return 'loopback / private target rejected'; if (![host, ...redirectHosts].includes(h)) return `host ${h} outside the pinned set (${host})`;
  return null;
}
const readHeader = (res, name) => { try { return res.headers?.get?.(name) ?? null; } catch { return null; } };
// GET returning text: { outcome: 'OK', status, text, etag, lastModified } | { outcome: 'NOT_MODIFIED' } | { outcome: 'RATE_LIMITED', retryAfterSec } | { outcome: 'FAILED', reason, status? }
export async function fetchTextBounded(url, { host, redirectHosts = [], headers = {}, fetchImpl = fetch, timeoutMs = BOUNDED_FETCH_DEFAULTS.timeoutMs, maxBytes = BOUNDED_FETCH_DEFAULTS.maxBytes, maxRedirects = BOUNDED_FETCH_DEFAULTS.maxRedirects, etag = null, lastModified = null } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); let current = url;
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const policy = pinnedUrlError(current, { host, redirectHosts }); if (policy) return { outcome: 'FAILED', reason: policy };
      const h = { ...headers }; if (etag) h['if-none-match'] = etag; if (lastModified) h['if-modified-since'] = lastModified;
      let res; try { res = await fetchImpl(current, { headers: h, redirect: 'manual', signal: controller.signal }); } catch (err) { return { outcome: 'FAILED', reason: boundedErr(controller.signal.aborted ? `timeout after ${timeoutMs}ms` : `network: ${err.message}`) }; }
      if (res.status === 304) return { outcome: 'NOT_MODIFIED', status: 304 };
      if (res.status >= 300 && res.status < 400) { const loc = readHeader(res, 'location'); if (!loc) return { outcome: 'FAILED', reason: 'redirect without location', status: res.status }; try { current = new URL(loc, current).toString(); } catch { return { outcome: 'FAILED', reason: 'unparseable redirect', status: res.status }; } continue; }
      if (res.status === 429) { const ra = Number(readHeader(res, 'retry-after')); return { outcome: 'RATE_LIMITED', status: 429, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null }; }
      if (!res.ok) return { outcome: 'FAILED', reason: `HTTP ${res.status}`, status: res.status };
      const text = await res.text(); if (text.length > maxBytes) return { outcome: 'FAILED', reason: `body over ${maxBytes} bytes`, status: res.status };
      return { outcome: 'OK', status: res.status, text, etag: readHeader(res, 'etag'), lastModified: readHeader(res, 'last-modified'), contentType: readHeader(res, 'content-type') };
    }
    return { outcome: 'FAILED', reason: `more than ${maxRedirects} redirects` };
  } finally { clearTimeout(timer); }
}
// GET returning parsed JSON (no redirects followed; a 400 with a JSON body is returned as OK so the caller reads the provider's error envelope)
export async function fetchJsonBounded(url, { host, headers = {}, fetchImpl = fetch, timeoutMs = BOUNDED_FETCH_DEFAULTS.timeoutMs, maxBytes = BOUNDED_FETCH_DEFAULTS.maxBytes } = {}) {
  const policy = pinnedUrlError(url, { host }); if (policy) return { outcome: 'FAILED', reason: policy };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res; try { res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, redirect: 'manual', signal: controller.signal }); } catch (err) { return { outcome: 'FAILED', reason: boundedErr(controller.signal.aborted ? `timeout after ${timeoutMs}ms` : `network: ${err.message}`) }; }
    if (res.status === 429) { const ra = Number(readHeader(res, 'retry-after')); return { outcome: 'RATE_LIMITED', status: 429, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null }; }
    if (res.status >= 300 && res.status < 400) return { outcome: 'FAILED', reason: 'redirect refused (pinned host only)', status: res.status };
    const text = await res.text(); if (text.length > maxBytes) return { outcome: 'FAILED', reason: `body over ${maxBytes} bytes`, status: res.status };
    let json; try { json = JSON.parse(text); } catch { return res.ok ? { outcome: 'PARSE_FAILED', reason: 'body is not JSON', status: res.status } : { outcome: 'FAILED', reason: `HTTP ${res.status}`, status: res.status }; }
    if (!res.ok && !(res.status === 400 && json && typeof json === 'object')) return { outcome: 'FAILED', reason: `HTTP ${res.status}`, status: res.status, json };
    return { outcome: 'OK', status: res.status, json };
  } finally { clearTimeout(timer); }
}
