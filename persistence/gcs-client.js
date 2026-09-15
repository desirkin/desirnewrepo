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
  const authHeader = async () => ({ authorization: `Bearer ${await accessToken()}` });
  const objectUrl = (name) => `${GCS_STORAGE_HOST}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;

  async function putObject(name, bytes, { contentType = 'application/octet-stream' } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new GcsClientError('GCS_PAYLOAD_INVALID', 'put requires a Buffer');
    const url = `${GCS_STORAGE_HOST}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`;
    const headers = { ...(await authHeader()), 'content-type': contentType }; let res;
    try { res = await fetchImpl(url, { method: 'POST', headers, body: bytes }); }
    catch (e) { throw new GcsClientError('GCS_PUT_UNREACHABLE', e?.code ?? e?.message ?? 'put unreachable'); }
    if (!res.ok) throw new GcsClientError('GCS_PUT_FAILED', `put returned ${res.status}`, res.status);
    return { key: name, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  async function getObject(name) {
    const headers = await authHeader(); let res;
    try { res = await fetchImpl(`${objectUrl(name)}?alt=media`, { method: 'GET', headers }); }
    catch (e) { throw new GcsClientError('GCS_GET_UNREACHABLE', e?.code ?? e?.message ?? 'get unreachable'); }
    if (res.status === 404) return null;
    if (!res.ok) throw new GcsClientError('GCS_GET_FAILED', `get returned ${res.status}`, res.status);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_RESPONSE_BYTES) throw new GcsClientError('GCS_OBJECT_TOO_LARGE', `${ab.byteLength} bytes exceeds the response cap`);
    return Buffer.from(ab);
  }
  async function headObject(name) {
    const headers = await authHeader(); let res;
    try { res = await fetchImpl(objectUrl(name), { method: 'GET', headers }); }
    catch (e) { throw new GcsClientError('GCS_HEAD_UNREACHABLE', e?.code ?? e?.message ?? 'head unreachable'); }
    if (res.status === 404) return null;
    if (!res.ok) throw new GcsClientError('GCS_HEAD_FAILED', `head returned ${res.status}`, res.status);
    let json; try { json = await res.json(); } catch { throw new GcsClientError('GCS_HEAD_FAILED', 'metadata was not JSON'); }
    return { key: name, bytes: Number(json?.size) || 0 };
  }
  async function listObjects(prefix = '') {
    const out = []; let pageToken = null; let pages = 0;
    do {
      const params = new URLSearchParams(); if (prefix) params.set('prefix', prefix); if (pageToken) params.set('pageToken', pageToken);
      const headers = await authHeader(); let res;
      try { res = await fetchImpl(`${GCS_STORAGE_HOST}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params.toString()}`, { method: 'GET', headers }); }
      catch (e) { throw new GcsClientError('GCS_LIST_UNREACHABLE', e?.code ?? e?.message ?? 'list unreachable'); }
      if (!res.ok) throw new GcsClientError('GCS_LIST_FAILED', `list returned ${res.status}`, res.status);
      let json; try { json = await res.json(); } catch { throw new GcsClientError('GCS_LIST_FAILED', 'list response was not JSON'); }
      for (const item of Array.isArray(json?.items) ? json.items : []) { const key = typeof item?.name === 'string' ? item.name : null; if (key) out.push({ key, bytes: Number(item?.size) || 0 }); }
      pageToken = typeof json?.nextPageToken === 'string' ? json.nextPageToken : null;
      pages += 1;
    } while (pageToken && pages < 10_000);
    return out;
  }
  async function deleteObject(name) {
    const headers = await authHeader(); let res;
    try { res = await fetchImpl(objectUrl(name), { method: 'DELETE', headers }); }
    catch (e) { throw new GcsClientError('GCS_DELETE_UNREACHABLE', e?.code ?? e?.message ?? 'delete unreachable'); }
    if (res.status === 404) return false;
    if (!res.ok) throw new GcsClientError('GCS_DELETE_FAILED', `delete returned ${res.status}`, res.status);
    return true;
  }
  return Object.freeze({ provider: 'GCS', bucket, putObject, getObject, headObject, listObjects, deleteObject, _accessToken: accessToken, describe: () => ({ provider: 'GCS', bucket }) });
}
