// PERSIST-1 GCS object client (2026-09-15). The dependency-free Google Cloud Storage JSON-API client that commissions the
// GCS provider of persistence/object-store.js — the durable substrate behind Replit App Storage (App Storage is a
// GCS-backed bucket). It speaks the JSON API over an INJECTED fetch (the real global fetch in production, a recording
// stub in tests), authenticating with a service-account JWT it mints and caches itself (RS256 via node:crypto). It reads
// ONLY env NAMES upstream (object-store.js resolves them); the service-account private key it receives is used to sign and
// is NEVER logged, returned, or embedded in an error. Bounded object bytes, bounded response bytes, 404 -> null/false,
// every other non-2xx -> a closed error carrying the status and provider message only. Authority NONE.
import { createSign, createHash } from 'node:crypto';

export const GCS_CLIENT_VERSION = 'serpent-gcs-client-1';
export const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
export const GCS_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GCS_STORAGE_HOST = 'https://storage.googleapis.com';
// PERSIST-1 step 5 — the Replit App Storage sidecar (identity-pool ADC). Replit does NOT expose a service-account JSON;
// credentials come from a local sidecar on 127.0.0.1:1106. These mirror replit-object-storage-python's REPLIT_ADC config
// (src/replit/object_storage/_config.py): the credential endpoint yields a subject access_token, which the token endpoint
// exchanges (STS token-exchange, audience "replit") for a Google access token scoped to devstorage.read_write.
export const REPLIT_SIDECAR_ORIGIN = 'http://127.0.0.1:1106';
export const REPLIT_CREDENTIAL_URL = `${REPLIT_SIDECAR_ORIGIN}/credential`;
export const REPLIT_TOKEN_URL = `${REPLIT_SIDECAR_ORIGIN}/token`;
export const REPLIT_DEFAULT_BUCKET_URL = `${REPLIT_SIDECAR_ORIGIN}/object-storage/default-bucket`;
const MAX_RESPONSE_BYTES = 300 * 1024 * 1024;
const TOKEN_SKEW_MS = 60_000; // refresh a minute before expiry; never ride a token to its edge

const bounded = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class GcsClientError extends Error {
  constructor(code, message, status = null) { super(`${code}: ${bounded(message)}`); this.name = 'GcsClientError'; this.code = code; this.status = status; }
}

// Parse a service-account JSON (the value of the credential env NAME) into the two fields we sign with. It validates the
// shape and NEVER echoes the private key: an error names the missing field, not its value.
export function parseServiceAccount(raw) {
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new GcsClientError('GCS_CREDENTIAL_INVALID', 'service account is not valid JSON'); }
  if (!obj || typeof obj !== 'object') throw new GcsClientError('GCS_CREDENTIAL_INVALID', 'service account must be a JSON object');
  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email.trim() : '';
  const privateKey = typeof obj.private_key === 'string' ? obj.private_key : '';
  if (!clientEmail) throw new GcsClientError('GCS_CREDENTIAL_INVALID', 'service account is missing client_email');
  if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) throw new GcsClientError('GCS_CREDENTIAL_INVALID', 'service account is missing a PEM private_key');
  return { clientEmail, privateKey, tokenUri: typeof obj.token_uri === 'string' && obj.token_uri.startsWith('https://') ? obj.token_uri : GCS_TOKEN_URL };
}

// Mint a signed JWT assertion for the token exchange. Pure but for the injected clock; never logs the key.
export function buildAssertion({ clientEmail, privateKey, tokenUri, nowMs, scope = GCS_SCOPE }) {
  const iat = Math.floor(nowMs / 1000); const exp = iat + 3600;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: clientEmail, scope, aud: tokenUri, iat, exp }));
  const signingInput = `${header}.${claim}`;
  let signature;
  try { const signer = createSign('RSA-SHA256'); signer.update(signingInput); signer.end(); signature = b64url(signer.sign(privateKey)); }
  catch { throw new GcsClientError('GCS_CREDENTIAL_INVALID', 'service-account private key could not sign (malformed PEM)'); }
  return `${signingInput}.${signature}`;
}

// The storage.googleapis.com JSON-API methods, identical for every auth mode: they take a Bearer token from the injected
// `accessToken` (JWT for GCS, sidecar-exchanged for REPLIT) and speak full object names within the bucket. Error codes carry
// the provider prefix (GCS_* / REPLIT_*) so a caller can tell the two modes apart; the token is never logged or returned.
function createStorageMethods({ provider, bucket, fetchImpl, accessToken }) {
  const E = (suffix) => `${provider}_${suffix}`;
  const authHeader = async () => ({ authorization: `Bearer ${await accessToken()}` });
  const objectUrl = (name) => `${GCS_STORAGE_HOST}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;

  async function putObject(name, bytes, { contentType = 'application/octet-stream' } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new GcsClientError(E('PAYLOAD_INVALID'), 'put requires a Buffer');
    const url = `${GCS_STORAGE_HOST}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`;
    const headers = { ...(await authHeader()), 'content-type': contentType }; let res;
    try { res = await fetchImpl(url, { method: 'POST', headers, body: bytes }); }
    catch (e) { throw new GcsClientError(E('PUT_UNREACHABLE'), e?.code ?? e?.message ?? 'put unreachable'); }
    if (!res.ok) throw new GcsClientError(E('PUT_FAILED'), `put returned ${res.status}`, res.status);
    return { key: name, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  async function getObject(name) {
    const headers = await authHeader(); let res;
    try { res = await fetchImpl(`${objectUrl(name)}?alt=media`, { method: 'GET', headers }); }
    catch (e) { throw new GcsClientError(E('GET_UNREACHABLE'), e?.code ?? e?.message ?? 'get unreachable'); }
    if (res.status === 404) return null;
    if (!res.ok) throw new GcsClientError(E('GET_FAILED'), `get returned ${res.status}`, res.status);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_RESPONSE_BYTES) throw new GcsClientError(E('OBJECT_TOO_LARGE'), `${ab.byteLength} bytes exceeds the response cap`);
    return Buffer.from(ab);
  }
  async function headObject(name) {
    const headers = await authHeader(); let res;
    try { res = await fetchImpl(objectUrl(name), { method: 'GET', headers }); }
    catch (e) { throw new GcsClientError(E('HEAD_UNREACHABLE'), e?.code ?? e?.message ?? 'head unreachable'); }
    if (res.status === 404) return null;
    if (!res.ok) throw new GcsClientError(E('HEAD_FAILED'), `head returned ${res.status}`, res.status);
    let json; try { json = await res.json(); } catch { throw new GcsClientError(E('HEAD_FAILED'), 'metadata was not JSON'); }
    return { key: name, bytes: Number(json?.size) || 0 };
  }
  async function listObjects(prefix = '') {
    const out = []; let pageToken = null; let pages = 0;
    do {
      const params = new URLSearchParams(); if (prefix) params.set('prefix', prefix); if (pageToken) params.set('pageToken', pageToken);
      const headers = await authHeader(); let res;
      try { res = await fetchImpl(`${GCS_STORAGE_HOST}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params.toString()}`, { method: 'GET', headers }); }
      catch (e) { throw new GcsClientError(E('LIST_UNREACHABLE'), e?.code ?? e?.message ?? 'list unreachable'); }
      if (!res.ok) throw new GcsClientError(E('LIST_FAILED'), `list returned ${res.status}`, res.status);
      let json; try { json = await res.json(); } catch { throw new GcsClientError(E('LIST_FAILED'), 'list response was not JSON'); }
      for (const item of Array.isArray(json?.items) ? json.items : []) { const key = typeof item?.name === 'string' ? item.name : null; if (key) out.push({ key, bytes: Number(item?.size) || 0 }); }
      pageToken = typeof json?.nextPageToken === 'string' ? json.nextPageToken : null;
      pages += 1;
    } while (pageToken && pages < 10_000);
    return out;
  }
  async function deleteObject(name) {
    const headers = await authHeader(); let res;
    try { res = await fetchImpl(objectUrl(name), { method: 'DELETE', headers }); }
    catch (e) { throw new GcsClientError(E('DELETE_UNREACHABLE'), e?.code ?? e?.message ?? 'delete unreachable'); }
    if (res.status === 404) return false;
    if (!res.ok) throw new GcsClientError(E('DELETE_FAILED'), `delete returned ${res.status}`, res.status);
    return true;
  }
  return { putObject, getObject, headObject, listObjects, deleteObject };
}

export function createGcsObjectClient({ serviceAccount, bucket, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new GcsClientError('GCS_CLIENT_MISCONFIGURED', 'a fetch implementation is required');
  if (typeof bucket !== 'string' || !bucket.length) throw new GcsClientError('GCS_CLIENT_MISCONFIGURED', 'a bucket is required');
  const sa = parseServiceAccount(serviceAccount);
  let token = null; let tokenExpiresMs = 0;

  async function accessToken() {
    const nowMs = clock();
    if (token && nowMs < tokenExpiresMs - TOKEN_SKEW_MS) return token;
    const assertion = buildAssertion({ ...sa, nowMs });
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    let res;
    try { res = await fetchImpl(sa.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }); }
    catch (e) { throw new GcsClientError('GCS_TOKEN_UNREACHABLE', e?.code ?? e?.message ?? 'token endpoint unreachable'); }
    if (!res.ok) throw new GcsClientError('GCS_TOKEN_REFUSED', `token exchange returned ${res.status}`, res.status);
    let json;
    try { json = await res.json(); } catch { throw new GcsClientError('GCS_TOKEN_REFUSED', 'token response was not JSON'); }
    const at = typeof json?.access_token === 'string' ? json.access_token : '';
    const ttl = Number(json?.expires_in);
    if (!at || !Number.isFinite(ttl) || ttl <= 0) throw new GcsClientError('GCS_TOKEN_REFUSED', 'token response missing access_token / expires_in');
    token = at; tokenExpiresMs = nowMs + ttl * 1000;
    return token;
  }
  const methods = createStorageMethods({ provider: 'GCS', bucket, fetchImpl, accessToken });
  return Object.freeze({ provider: 'GCS', bucket, ...methods, _accessToken: accessToken, describe: () => ({ provider: 'GCS', bucket }) });
}

// Fetch the Replit App Storage default bucket from the sidecar (used when SERPENT_OBJECT_STORE_BUCKET is unset). Returns the
// bucketId string; a sidecar that is unreachable or answers without a bucketId fails closed with a REPLIT_* error.
export async function fetchReplitDefaultBucket(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new GcsClientError('REPLIT_CLIENT_MISCONFIGURED', 'a fetch implementation is required');
  let res;
  try { res = await fetchImpl(REPLIT_DEFAULT_BUCKET_URL, { method: 'GET' }); }
  catch (e) { throw new GcsClientError('REPLIT_SIDECAR_UNREACHABLE', e?.code ?? e?.message ?? 'default-bucket unreachable'); }
  if (!res.ok) throw new GcsClientError('REPLIT_BUCKET_REFUSED', `default-bucket returned ${res.status}`, res.status);
  let json; try { json = await res.json(); } catch { throw new GcsClientError('REPLIT_BUCKET_REFUSED', 'default-bucket response was not JSON'); }
  const bucket = typeof json?.bucketId === 'string' ? json.bucketId.trim() : '';
  if (!bucket) throw new GcsClientError('REPLIT_BUCKET_REFUSED', 'default-bucket response missing bucketId');
  return bucket;
}

// PERSIST-1 step 5 — the Replit App Storage client. Same storage.googleapis.com JSON API as GCS, but the Bearer token comes
// from the Replit sidecar (no service-account JSON): GET /credential yields a subject access_token, POST /token exchanges it
// (STS token-exchange, audience "replit", scope devstorage.read_write) for a Google token with the same 60 s refresh skew.
// The sidecar being unreachable fails closed (REPLIT_SIDECAR_UNREACHABLE) — the caller reports the provider unavailable,
// exactly as GCS does, never a crash loop. The subject token and the exchanged token are never logged or returned.
export function createReplitObjectClient({ bucket, fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new GcsClientError('REPLIT_CLIENT_MISCONFIGURED', 'a fetch implementation is required');
  if (typeof bucket !== 'string' || !bucket.length) throw new GcsClientError('REPLIT_CLIENT_MISCONFIGURED', 'a bucket is required');
  let token = null; let tokenExpiresMs = 0;

  async function accessToken() {
    const nowMs = clock();
    if (token && nowMs < tokenExpiresMs - TOKEN_SKEW_MS) return token;
    // 1. subject token from the sidecar credential endpoint
    let credRes;
    try { credRes = await fetchImpl(REPLIT_CREDENTIAL_URL, { method: 'GET' }); }
    catch (e) { throw new GcsClientError('REPLIT_SIDECAR_UNREACHABLE', e?.code ?? e?.message ?? 'credential endpoint unreachable'); }
    if (!credRes.ok) throw new GcsClientError('REPLIT_CREDENTIAL_REFUSED', `credential returned ${credRes.status}`, credRes.status);
    let credJson; try { credJson = await credRes.json(); } catch { throw new GcsClientError('REPLIT_CREDENTIAL_REFUSED', 'credential response was not JSON'); }
    const subjectToken = typeof credJson?.access_token === 'string' ? credJson.access_token : '';
    if (!subjectToken) throw new GcsClientError('REPLIT_CREDENTIAL_REFUSED', 'credential response missing access_token');
    // 2. STS token-exchange at the sidecar token endpoint (mirrors replit-object-storage REPLIT_ADC identity-pool config)
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: 'replit',
      scope: GCS_SCOPE,
      subject_token_type: 'access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: subjectToken,
    }).toString();
    let res;
    try { res = await fetchImpl(REPLIT_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }); }
    catch (e) { throw new GcsClientError('REPLIT_SIDECAR_UNREACHABLE', e?.code ?? e?.message ?? 'token endpoint unreachable'); }
    if (!res.ok) throw new GcsClientError('REPLIT_TOKEN_REFUSED', `token exchange returned ${res.status}`, res.status);
    let json; try { json = await res.json(); } catch { throw new GcsClientError('REPLIT_TOKEN_REFUSED', 'token response was not JSON'); }
    const at = typeof json?.access_token === 'string' ? json.access_token : '';
    const ttl = Number(json?.expires_in);
    if (!at || !Number.isFinite(ttl) || ttl <= 0) throw new GcsClientError('REPLIT_TOKEN_REFUSED', 'token response missing access_token / expires_in');
    token = at; tokenExpiresMs = nowMs + ttl * 1000;
    return token;
  }
  const methods = createStorageMethods({ provider: 'REPLIT', bucket, fetchImpl, accessToken });
  return Object.freeze({ provider: 'REPLIT', bucket, ...methods, _accessToken: accessToken, describe: () => ({ provider: 'REPLIT', bucket }) });
}
