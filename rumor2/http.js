// RUMOR-2A — the guarded provider fetch. The collector may speak ONLY to
// the fixed official HTTPS hosts in the registry: no scheme but https, no
// IP-literal or loopback/private targets, no off-provider redirect, no
// unbounded body, no unbounded wait. A provider response can never
// instruct Serpent to fetch some other host.
import { HTTP_TIMEOUT_MS, MAX_FEED_BYTES, MAX_REDIRECTS, boundedError } from './truth.js';

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|\[?fe80:|\[?fc|\[?fd)/i;
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;

// Validate one URL against a provider's fixed allowlist. Returns a bounded
// reason string, or null when the URL is permitted. A provider may pin an
// explicit CLOSED list of additional redirect hosts (RUMOR-2B1: the OFAC
// Sanctions List Service serves downloads through one 302 to Treasury's own
// fixed publication bucket); anything outside the exact pinned set — https
// only, never private/loopback, never an IP literal — stays rejected, so a
// response can still never steer Serpent to an arbitrary host.
export function urlPolicyError(rawUrl, provider) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'unparseable URL';
  }
  if (u.protocol !== 'https:') return `scheme ${u.protocol} rejected — https only`;
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) return 'loopback/private/link-local target rejected';
  const allowedHosts = [provider.host, ...(Array.isArray(provider.redirectHosts) ? provider.redirectHosts : [])];
  if (IP_LITERAL_RE.test(host) && !allowedHosts.includes(host)) return 'IP-literal host rejected';
  if (!allowedHosts.includes(host)) return `host ${host} outside provider allowlist (${provider.host})`;
  return null;
}

const readHeader = (res, name) => {
  try {
    return res.headers?.get?.(name) ?? res.headers?.[name.toLowerCase()] ?? null;
  } catch {
    return null;
  }
};

// Bounded body read: honors Content-Length when present, streams with a
// hard cap when a reader exists, and length-checks the text fallback.
// Never allocates from an attacker-declared length.
async function boundedBody(res, maxBytes = MAX_FEED_BYTES) {
  const declared = Number(readHeader(res, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { error: `response ${declared} bytes exceeds ${maxBytes}` };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength ?? value.length ?? 0;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // stream already broken — the oversize rejection stands either way
        }
        return { error: `response stream exceeds ${maxBytes} bytes — aborted` };
      }
      chunks.push(Buffer.from(value));
    }
    return { text: Buffer.concat(chunks).toString('utf8') };
  }
  const text = await res.text();
  if (text.length > maxBytes) return { error: `response ${text.length} chars exceeds ${maxBytes}` };
  return { text };
}

// fetchProviderFeed — one guarded conditional GET of the provider's fixed
// feed URL. Returns exactly one of:
//   { outcome: 'NOT_MODIFIED', status: 304 }
//   { outcome: 'OK', status, text, etag, lastModified }
//   { outcome: 'RATE_LIMITED', status: 429, retryAfter }
//   { outcome: 'FAILED', reason, status? }
export async function fetchProviderFeed({ provider, fetchImpl = fetch, userAgent, etag = null, lastModified = null, timeoutMs = undefined, url: urlOverride = undefined }) {
  // per-provider bounds stay explicit and closed: a provider may declare a
  // larger (still hard-capped) body for an official bulk dataset and a
  // longer (still bounded) watchdog; the registry is frozen, so neither can
  // ever come from a response
  const effectiveTimeout = timeoutMs ?? provider.timeoutMs ?? HTTP_TIMEOUT_MS;
  const maxBytes = Number.isSafeInteger(provider.maxBytes) && provider.maxBytes > 0 ? provider.maxBytes : MAX_FEED_BYTES;
  let url = urlOverride ?? provider.feedUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const policyErr = urlPolicyError(url, provider);
    if (policyErr) return { outcome: 'FAILED', reason: boundedError(policyErr) };
    // the watchdog stays ref'd while a request is in flight: it is what
    // guarantees the wait is bounded even against a hung transport, and it
    // is always cleared on completion
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    let res;
    try {
      const headers = { 'user-agent': userAgent, accept: provider.accept ?? 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
      if (etag) headers['if-none-match'] = etag;
      if (lastModified) headers['if-modified-since'] = lastModified;
      res = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err?.name === 'AbortError' || controller.signal.aborted;
      return { outcome: 'FAILED', reason: boundedError(timedOut ? `timeout after ${effectiveTimeout}ms` : `network: ${err.message}`) };
    }
    clearTimeout(timer);
    const status = res.status;
    if (status === 304) return { outcome: 'NOT_MODIFIED', status };
    if (status >= 300 && status < 400) {
      const location = readHeader(res, 'location');
      if (!location) return { outcome: 'FAILED', reason: 'redirect without location', status };
      let next;
      try {
        next = new URL(location, url).toString();
      } catch {
        return { outcome: 'FAILED', reason: 'unparseable redirect location', status };
      }
      const redirectErr = urlPolicyError(next, provider);
      if (redirectErr) return { outcome: 'FAILED', reason: boundedError(`redirect blocked: ${redirectErr}`), status };
      if (hop === MAX_REDIRECTS) return { outcome: 'FAILED', reason: `redirect chain exceeds ${MAX_REDIRECTS}`, status };
      url = next;
      continue;
    }
    if (status === 429) return { outcome: 'RATE_LIMITED', status, retryAfter: readHeader(res, 'retry-after') };
    if (status !== 200) return { outcome: 'FAILED', reason: `http ${status}`, status };
    const body = await boundedBody(res, maxBytes);
    if (body.error) return { outcome: 'FAILED', reason: boundedError(body.error), status };
    return {
      outcome: 'OK',
      status,
      text: body.text,
      etag: readHeader(res, 'etag'),
      lastModified: readHeader(res, 'last-modified'),
    };
  }
  return { outcome: 'FAILED', reason: 'redirect loop' };
}
