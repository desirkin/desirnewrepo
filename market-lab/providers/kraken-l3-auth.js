// MARKET-EDGE-KRAKEN-1 (B) — the NARROW Kraken Spot private-read helper for the Level 3 data key. It can sign EXACTLY two
// documented read endpoints — GetApiKeyInfo and GetWebSocketsToken — and nothing else: there is no generic "sign any
// private request" function here, no order endpoint is reachable, and execution/kraken-adapter.js is never imported.
// Fail-closed permission fence (documented vocabulary checked 2026-09-10, docs.kraken.com/api-reference/account-data/
// get-api-key-info): the key must carry NO authority-capable permission (modify-trades, close-trades, add-funds,
// withdraw-funds, earn-funds, add-withdraw-address, update-withdraw-address) and NO permission outside the documented
// vocabulary (an unknown value fails closed). Two SEPARATE verdicts (W8): NON_AUTHORITY_KEY (safe from trading authority but
// unusable for L3: the documented token capability `create-ws-token` is absent -> blocker TOKEN_PERMISSION_MISSING) and
// SAFE_L3_DATA_KEY (no authority, no unknown permission, token capability present, probe succeeded). Only a proven
// SAFE_L3_DATA_KEY may fetch a WebSocket token; a NON_AUTHORITY_KEY keeps L3 blocked with its blocker named.
// Never logged, never persisted, never returned by status(): the key, the secret, the token, the signed payload, the nonce.
import { createHash, createHmac } from 'node:crypto';
import { deepFreeze, fail } from '../contracts.js';
import { num, int, obj, arr } from './base.js';

export const L3_AUTH_VERSION = 'kraken-l3-auth-1';
export const L3_AUTH_DOCS_CHECKED = '2026-09-10';
export const KRAKEN_KEY_PERMISSIONS = deepFreeze({
  KNOWN: ['query-funds', 'add-funds', 'withdraw-funds', 'earn-funds', 'query-open-trades', 'query-closed-trades', 'modify-trades', 'close-trades', 'query-ledger', 'export-data', 'create-ws-token', 'add-withdraw-address', 'update-withdraw-address'],
  AUTHORITY_CAPABLE: ['modify-trades', 'close-trades', 'add-funds', 'withdraw-funds', 'earn-funds', 'add-withdraw-address', 'update-withdraw-address'],
  DATA_ONLY: ['query-funds', 'query-open-trades', 'query-closed-trades', 'query-ledger', 'export-data', 'create-ws-token'],
  TOKEN: 'create-ws-token',
});
export const KEY_VERDICTS = Object.freeze(['SAFE_L3_DATA_KEY', 'NON_AUTHORITY_KEY', 'AUTHORITY_CAPABLE', 'UNKNOWN_PERMISSION', 'MALFORMED']);
export const L3_USABLE_VERDICT = 'SAFE_L3_DATA_KEY';
export const KEY_BLOCKERS = Object.freeze({ NON_AUTHORITY_KEY: 'TOKEN_PERMISSION_MISSING', AUTHORITY_CAPABLE: 'AUTHORITY_CAPABLE_PERMISSION', UNKNOWN_PERMISSION: 'UNDOCUMENTED_PERMISSION', MALFORMED: 'PERMISSION_PROBE_MALFORMED' });
export const keyBlockerOf = (verdict) => (verdict === L3_USABLE_VERDICT ? null : KEY_BLOCKERS[verdict] ?? verdict);
// the ONLY two signable endpoints (registry ids -> documented paths); the signer refuses everything else by construction
export const SIGNABLE_ENDPOINTS = deepFreeze({ 'rest-private-key-info': '/0/private/GetApiKeyInfo', 'rest-private-ws-token': '/0/private/GetWebSocketsToken' });
export const keyFingerprintOf = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

export function assessKeyPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length > 64 || permissions.some((p) => typeof p !== 'string')) return { verdict: 'MALFORMED', blocker: KEY_BLOCKERS.MALFORMED, forbidden: [], unknown: [], dataOnly: [], tokenPermission: false, l3Usable: false };
  const forbidden = permissions.filter((p) => KRAKEN_KEY_PERMISSIONS.AUTHORITY_CAPABLE.includes(p));
  const unknown = permissions.filter((p) => !KRAKEN_KEY_PERMISSIONS.KNOWN.includes(p)).map(() => 'UNDOCUMENTED'); // never echoed: counted by position only
  const dataOnly = permissions.filter((p) => KRAKEN_KEY_PERMISSIONS.DATA_ONLY.includes(p));
  const tokenPermission = permissions.includes(KRAKEN_KEY_PERMISSIONS.TOKEN);
  // authority first (fail closed), then the documented vocabulary, then the L3 capability: a key without the token permission is
  // NON_AUTHORITY_KEY — safe from trading authority yet NOT usable for L3
  const verdict = forbidden.length ? 'AUTHORITY_CAPABLE' : unknown.length ? 'UNKNOWN_PERMISSION' : tokenPermission ? 'SAFE_L3_DATA_KEY' : 'NON_AUTHORITY_KEY';
  return { verdict, blocker: keyBlockerOf(verdict), forbidden, unknown, dataOnly, tokenPermission, l3Usable: verdict === L3_USABLE_VERDICT };
}
// API-Sign = HMAC-SHA512(path + SHA256(nonce + postdata), base64decode(secret)) over the documented form body `nonce=<n>`
export function signNarrow({ endpointId, nonce, secret }) {
  const urlPath = SIGNABLE_ENDPOINTS[endpointId]; if (!urlPath) fail('PERMISSION_FAILURE', 'the L3 auth helper signs only GetApiKeyInfo and GetWebSocketsToken');
  if (!/^\d{1,24}$/.test(String(nonce)) || typeof secret !== 'string' || !secret.length) fail('INVALID_REQUEST', 'nonce/secret malformed');
  const body = `nonce=${nonce}`;
  const sha = createHash('sha256').update(`${nonce}${body}`).digest();
  const signature = createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(urlPath, 'utf8'), sha])).digest('base64');
  return { body, signature, path: urlPath };
}

export function createL3AuthHelper({ transport, clock = () => Date.now(), env = {}, keyEnv, secretEnv, log = () => {} } = {}) {
  if (!transport || typeof transport.request !== 'function') fail('INVALID_REQUEST', 'a transport is required');
  if (typeof keyEnv !== 'string' || typeof secretEnv !== 'string' || keyEnv === secretEnv) fail('INVALID_REQUEST', 'dedicated key/secret environment NAMES are required');
  let lastNonce = 0n; let proven = false; let verdict = null; let fingerprint = null; let lastProofTs = null; let tokensIssued = 0; let lastTokenTs = null; let lastFailure = null;
  const credentials = () => { const key = env[keyEnv]; const secret = env[secretEnv]; return typeof key === 'string' && key.length && typeof secret === 'string' && secret.length ? { key, secret } : null; };
  const nextNonce = () => { const candidate = BigInt(clock()) * 1000n; lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n; return lastNonce.toString(); };
  async function privateRead(endpointId, { signal = null } = {}) {
    const c = credentials(); if (!c) return { ok: false, reason: 'CREDENTIAL_MISSING' };
    const nonce = nextNonce(); const signed = signNarrow({ endpointId, nonce, secret: c.secret });
    const r = await transport.request({ providerId: 'KRAKEN_SPOT', endpointId, method: 'POST', body: signed.body, headers: { 'API-Key': c.key, 'API-Sign': signed.signature }, share: false, signal, purpose: 'PROBE' });
    if (!r.ok) { lastFailure = { kind: r.failure.kind, ts: clock() }; return { ok: false, reason: r.failure.kind, receivedTs: r.failure.receivedTs ?? clock() }; }
    const j = obj(r.json); const errors = arr(j?.error) ?? []; const result = obj(j?.result);
    if (errors.length || !result) { lastFailure = { kind: 'PROVIDER_REJECTED', ts: r.receivedTs }; return { ok: false, reason: 'PROVIDER_REJECTED', errorCount: errors.length, receivedTs: r.receivedTs }; }
    return { ok: true, result, receivedTs: r.receivedTs, requestId: r.requestId ?? null };
  }
  let blocker = null;
  // step 1: prove the key is an L3 DATA key. Anything but SAFE_L3_DATA_KEY blocks every later step (the blocker is named).
  async function proveDataKey({ signal = null } = {}) {
    proven = false; verdict = null; blocker = null;
    const c = credentials(); if (!c) { verdict = 'CREDENTIAL_MISSING'; blocker = 'CREDENTIAL_MISSING'; return { ok: false, verdict, blocker, keyFingerprint: null }; }
    fingerprint = keyFingerprintOf(c.key);
    const r = await privateRead('rest-private-key-info', { signal });
    if (!r.ok) { verdict = r.reason === 'PROVIDER_REJECTED' ? 'PROVIDER_REJECTED' : r.reason; blocker = 'PERMISSION_PROBE_FAILED'; return { ok: false, verdict, blocker, keyFingerprint: fingerprint, reason: r.reason }; }
    const a = assessKeyPermissions(r.result.permissions);
    verdict = a.verdict; blocker = a.blocker; lastProofTs = r.receivedTs; proven = a.l3Usable;
    if (!proven) log(`KRAKEN L3: data key ${fingerprint} refused (${a.verdict}: ${a.blocker}; ${a.forbidden.length} authority-capable, ${a.unknown.length} undocumented, token permission ${a.tokenPermission ? 'present' : 'missing'})`);
    return { ok: proven, verdict: a.verdict, blocker: a.blocker, l3Usable: a.l3Usable, keyFingerprint: fingerprint, forbidden: a.forbidden, unknownCount: a.unknown.length, dataOnly: a.dataOnly, tokenPermission: a.tokenPermission, validUntil: num(r.result.validUntil), nonceWindow: int(r.result.nonceWindow), provenTs: lastProofTs };
  }
  // step 2: only a proven data key fetches a token; the token is returned to the caller ONCE and never retained here
  async function fetchToken({ signal = null } = {}) {
    if (!proven) return { ok: false, reason: 'KEY_NOT_PROVEN', verdict, blocker };
    const r = await privateRead('rest-private-ws-token', { signal });
    if (!r.ok) return { ok: false, reason: r.reason };
    const token = typeof r.result.token === 'string' && r.result.token.length > 0 && r.result.token.length <= 512 ? r.result.token : null; const expires = int(r.result.expires);
    if (!token) return { ok: false, reason: 'SCHEMA' };
    tokensIssued += 1; lastTokenTs = r.receivedTs;
    return { ok: true, token, expiresTs: expires !== null ? r.receivedTs + expires * 1000 : r.receivedTs + 15 * 60_000, issuedTs: r.receivedTs };
  }
  return {
    version: L3_AUTH_VERSION, proveDataKey, fetchToken, credentialsPresent: () => credentials() !== null,
    status: () => deepFreeze({ version: L3_AUTH_VERSION, proven, verdict, blocker, l3Usable: proven, keyFingerprint: fingerprint, lastProofTs, tokensIssued, lastTokenTs, lastFailure, credentialsPresent: credentials() !== null, keyEnv, secretEnv, signable: Object.keys(SIGNABLE_ENDPOINTS) }),
  };
}
