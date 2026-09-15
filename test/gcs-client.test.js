// PERSIST-1 GCS object client (2026-09-15). Offline: an INJECTED fetch stub (a function, never a real socket) records the
// requests and returns canned responses; a real RSA keypair is generated in-process so the minted JWT can be verified with
// its public half. No network, no real credential, no leak of the private key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createGcsObjectClient, parseServiceAccount, buildAssertion, GcsClientError, GCS_SCOPE, GCS_TOKEN_URL, createReplitObjectClient, fetchReplitDefaultBucket, REPLIT_CREDENTIAL_URL, REPLIT_TOKEN_URL, REPLIT_DEFAULT_BUCKET_URL } from '../persistence/gcs-client.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const SA = JSON.stringify({ client_email: 'serpent@project.iam.gserviceaccount.com', private_key: PRIVATE_PEM, token_uri: GCS_TOKEN_URL });
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// a fetch stub: an in-memory bucket behind the GCS JSON API surface, recording every request
function stubFetch({ store = new Map(), token = 'ACCESS-TOKEN-VALUE', onToken = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (url === GCS_TOKEN_URL) { if (onToken) onToken(init); return { ok: true, status: 200, json: async () => ({ access_token: token, expires_in: 3600, token_type: 'Bearer' }) }; }
    const u = new URL(url);
    const isUpload = u.pathname.startsWith('/upload/');
    if (isUpload) { const name = u.searchParams.get('name'); store.set(name, Buffer.from(init.body)); return { ok: true, status: 200, json: async () => ({ name, size: String(Buffer.from(init.body).byteLength) }) }; }
    if (u.pathname.endsWith('/o')) { // list
      const prefix = u.searchParams.get('prefix') ?? '';
      const items = [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ name: k, size: String(v.byteLength) }));
      return { ok: true, status: 200, json: async () => ({ items }) };
    }
    // object-scoped: /storage/v1/b/{bucket}/o/{name}
    const name = decodeURIComponent(u.pathname.split('/o/')[1] ?? '');
    if (init.method === 'DELETE') { const had = store.delete(name); return { ok: had, status: had ? 204 : 404 }; }
    if (u.searchParams.get('alt') === 'media') { const v = store.get(name); return v ? { ok: true, status: 200, arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : { ok: false, status: 404 }; }
    const v = store.get(name); return v ? { ok: true, status: 200, json: async () => ({ name, size: String(v.byteLength) }) } : { ok: false, status: 404 };
  };
  return { fetchImpl, calls, store };
}

test('GCS-1. parseServiceAccount validates shape and never echoes the key; buildAssertion mints a JWT that verifies with the public key and carries the storage scope', () => {
  assert.throws(() => parseServiceAccount('{not json'), GcsClientError);
  assert.throws(() => parseServiceAccount(JSON.stringify({ private_key: PRIVATE_PEM })), /client_email/);
  const badKey = parseServiceAccount.bind(null, JSON.stringify({ client_email: 'x@y', private_key: 'not-a-pem' }));
  assert.throws(badKey, /PEM private_key/);
  const sa = parseServiceAccount(SA); assert.equal(sa.clientEmail, 'serpent@project.iam.gserviceaccount.com');
  const jwt = buildAssertion({ ...sa, nowMs: 1_700_000_000_000 });
  const [h, c, sig] = jwt.split('.');
  const header = JSON.parse(b64urlDecode(h)); const claim = JSON.parse(b64urlDecode(c));
  assert.equal(header.alg, 'RS256'); assert.equal(claim.iss, sa.clientEmail); assert.equal(claim.scope, GCS_SCOPE); assert.equal(claim.aud, GCS_TOKEN_URL);
  assert.equal(claim.exp - claim.iat, 3600);
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`); v.end();
  assert.equal(v.verify(PUBLIC_PEM, b64urlDecode(sig)), true, 'the assertion is a real RS256 signature over header.claim');
});

test('GCS-2. put/get/head/list/delete round-trip through the JSON API; the token is minted once and reused; the private key never appears in a request', async () => {
  const { fetchImpl, calls } = stubFetch();
  const c = createGcsObjectClient({ serviceAccount: SA, bucket: 'serpent-bucket', fetchImpl, clock: () => 1_700_000_000_000, log: () => {} });
  await c.putObject('serpent/bulk/tape/a.jsonl', Buffer.from('hello'), { contentType: 'application/x-ndjson' });
  const got = await c.getObject('serpent/bulk/tape/a.jsonl');
  assert.equal(got.toString(), 'hello');
  const head = await c.headObject('serpent/bulk/tape/a.jsonl'); assert.equal(head.bytes, 5);
  assert.equal(await c.getObject('serpent/bulk/missing'), null, '404 -> null');
  assert.equal(await c.headObject('serpent/bulk/missing'), null);
  const list = await c.listObjects('serpent/bulk/'); assert.deepEqual(list, [{ key: 'serpent/bulk/tape/a.jsonl', bytes: 5 }]);
  assert.equal(await c.deleteObject('serpent/bulk/tape/a.jsonl'), true);
  assert.equal(await c.deleteObject('serpent/bulk/tape/a.jsonl'), false, 'a second delete is a 404 -> false');
  // exactly one token exchange for all of the above (cached), and the Authorization header is a Bearer, never the key
  const tokenCalls = calls.filter((k) => k.url === GCS_TOKEN_URL); assert.equal(tokenCalls.length, 1);
  const blob = JSON.stringify(calls);
  assert.ok(!blob.includes('PRIVATE KEY'), 'the PEM private key never appears in any request');
  assert.ok(calls.some((k) => String(k.headers.authorization ?? '').startsWith('Bearer ')));
});

test('GCS-3. a refused token exchange and a failed put are closed errors carrying the status only; a bad service account fails at construction', async () => {
  const refused = { fetchImpl: async (url) => (url === GCS_TOKEN_URL ? { ok: false, status: 401 } : { ok: true, status: 200 }) };
  const c = createGcsObjectClient({ serviceAccount: SA, bucket: 'b', fetchImpl: refused.fetchImpl, clock: () => 1 });
  await assert.rejects(() => c.putObject('serpent/bulk/x', Buffer.from('x')), /GCS_TOKEN_REFUSED: token exchange returned 401/);
  const { fetchImpl } = stubFetch();
  const putFail = createGcsObjectClient({ serviceAccount: SA, bucket: 'b', fetchImpl: async (url, init) => (url === GCS_TOKEN_URL ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } : { ok: false, status: 500 }), clock: () => 1 });
  await assert.rejects(() => putFail.putObject('serpent/bulk/x', Buffer.from('x')), /GCS_PUT_FAILED: put returned 500/);
  assert.throws(() => createGcsObjectClient({ serviceAccount: '{"client_email":"x@y"}', bucket: 'b', fetchImpl }), /PEM private_key/);
  assert.throws(() => createGcsObjectClient({ serviceAccount: SA, bucket: '', fetchImpl }), /bucket is required/);
  void fetchImpl;
});

// PERSIST-1 step 5 — the Replit App Storage sidecar auth mode. Same fetch-stub discipline: no socket, no real token. The
// sidecar (127.0.0.1:1106) hands out a subject access_token that the token endpoint exchanges (STS) for a Google token.
function stubReplit({ store = new Map(), subject = 'SUBJECT-TOKEN', google = 'GOOGLE-TOKEN', ttl = 3600, bucketId = 'replit-default-bucket' } = {}) {
  const calls = []; let credHits = 0; let tokenHits = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (url === REPLIT_CREDENTIAL_URL) { credHits += 1; return { ok: true, status: 200, json: async () => ({ access_token: subject }) }; }
    if (url === REPLIT_TOKEN_URL) { tokenHits += 1; return { ok: true, status: 200, json: async () => ({ access_token: google, expires_in: ttl, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer' }) }; }
    if (url === REPLIT_DEFAULT_BUCKET_URL) return { ok: true, status: 200, json: async () => ({ bucketId }) };
    const u = new URL(url);
    if (u.pathname.startsWith('/upload/')) { const name = u.searchParams.get('name'); store.set(name, Buffer.from(init.body)); return { ok: true, status: 200, json: async () => ({ name, size: String(Buffer.from(init.body).byteLength) }) }; }
    const name = decodeURIComponent(u.pathname.split('/o/')[1] ?? '');
    if (u.searchParams.get('alt') === 'media') { const v = store.get(name); return v ? { ok: true, status: 200, arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : { ok: false, status: 404 }; }
    const v = store.get(name); return v ? { ok: true, status: 200, json: async () => ({ name, size: String(v.byteLength) }) } : { ok: false, status: 404 };
  };
  return { fetchImpl, calls, store, credHits: () => credHits, tokenHits: () => tokenHits };
}

test('REP-1. the Replit client exchanges the sidecar subject token (STS token-exchange, audience replit, scope devstorage) for a Google Bearer, minted once and reused; the storage round-trip uses it; no token is ever the private request body key', async () => {
  const s = stubReplit();
  const c = createReplitObjectClient({ bucket: 'serpent-bucket', fetchImpl: s.fetchImpl, clock: () => 1_700_000_000_000, log: () => {} });
  assert.equal(c.provider, 'REPLIT');
  await c.putObject('serpent/bulk/a.jsonl', Buffer.from('hello'));
  assert.equal((await c.getObject('serpent/bulk/a.jsonl')).toString(), 'hello');
  // exactly one credential fetch + one token exchange for both ops (cached)
  assert.equal(s.credHits(), 1); assert.equal(s.tokenHits(), 1);
  // the token-exchange body carries the exact identity-pool params (mirrors replit-object-storage REPLIT_ADC)
  const tokenCall = s.calls.find((k) => k.url === REPLIT_TOKEN_URL); const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(form.get('audience'), 'replit');
  assert.equal(form.get('subject_token_type'), 'access_token');
  assert.equal(form.get('requested_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(form.get('scope'), GCS_SCOPE);
  assert.equal(form.get('subject_token'), 'SUBJECT-TOKEN');
  // the exchanged Google token rides as a Bearer on the storage call, never the subject token
  assert.ok(s.calls.some((k) => String(k.headers.authorization ?? '') === 'Bearer GOOGLE-TOKEN'));
  assert.ok(!s.calls.some((k) => String(k.headers.authorization ?? '').includes('SUBJECT-TOKEN')), 'the subject token never authorizes a storage call');
});

test('REP-2. the token refreshes on expiry with the same 60 s skew: a second op inside the window reuses, one past (ttl − skew) re-exchanges', async () => {
  const s = stubReplit({ ttl: 3600 });
  let now = 1_000_000; const c = createReplitObjectClient({ bucket: 'b', fetchImpl: s.fetchImpl, clock: () => now, log: () => {} });
  await c.putObject('k1', Buffer.from('a')); assert.equal(s.tokenHits(), 1);
  now += 3_000_000; await c.putObject('k2', Buffer.from('b')); assert.equal(s.tokenHits(), 1, 'inside the token window (3600 s − 60 s skew), the cached token is reused');
  now += 600_000; await c.putObject('k3', Buffer.from('c')); assert.equal(s.tokenHits(), 2, 'past ttl − skew, the client re-fetches the credential and re-exchanges');
  assert.equal(s.credHits(), 2);
});

test('REP-3. an unreachable sidecar and a refused exchange fail closed (REPLIT_SIDECAR_UNREACHABLE / REPLIT_TOKEN_REFUSED), never a crash loop; a missing bucket fails at construction', async () => {
  const unreachable = createReplitObjectClient({ bucket: 'b', fetchImpl: async () => { const e = new Error('ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }, clock: () => 1 });
  await assert.rejects(() => unreachable.putObject('k', Buffer.from('x')), /REPLIT_SIDECAR_UNREACHABLE/);
  const tokenRefused = createReplitObjectClient({ bucket: 'b', clock: () => 1, fetchImpl: async (url) => (url === REPLIT_CREDENTIAL_URL ? { ok: true, status: 200, json: async () => ({ access_token: 's' }) } : url === REPLIT_TOKEN_URL ? { ok: false, status: 403 } : { ok: true, status: 200 }) });
  await assert.rejects(() => tokenRefused.putObject('k', Buffer.from('x')), /REPLIT_TOKEN_REFUSED: token exchange returned 403/);
  const credRefused = createReplitObjectClient({ bucket: 'b', clock: () => 1, fetchImpl: async (url) => (url === REPLIT_CREDENTIAL_URL ? { ok: true, status: 200, json: async () => ({}) } : { ok: true, status: 200 }) });
  await assert.rejects(() => credRefused.putObject('k', Buffer.from('x')), /REPLIT_CREDENTIAL_REFUSED: credential response missing access_token/);
  assert.throws(() => createReplitObjectClient({ bucket: '', fetchImpl: async () => ({}) }), /bucket is required/);
});

test('REP-4. the default bucket comes from the sidecar when the NAME is unset (bucketId); an unreachable sidecar or a missing bucketId fails closed; no token is ever logged', async () => {
  const s = stubReplit({ bucketId: 'app-storage-xyz' });
  assert.equal(await fetchReplitDefaultBucket(s.fetchImpl), 'app-storage-xyz');
  await assert.rejects(() => fetchReplitDefaultBucket(async () => { throw new Error('down'); }), /REPLIT_SIDECAR_UNREACHABLE/);
  await assert.rejects(() => fetchReplitDefaultBucket(async () => ({ ok: true, status: 200, json: async () => ({}) })), /REPLIT_BUCKET_REFUSED: default-bucket response missing bucketId/);
  // the subject token and the exchanged token never reach the log sink
  const logged = []; const s2 = stubReplit();
  const c = createReplitObjectClient({ bucket: 'b', fetchImpl: s2.fetchImpl, clock: () => 1, log: (m) => logged.push(String(m)) });
  await c.putObject('k', Buffer.from('x')); await c.getObject('k');
  const blob = logged.join('\n');
  assert.ok(!blob.includes('SUBJECT-TOKEN') && !blob.includes('GOOGLE-TOKEN'), 'neither the subject nor the exchanged token is ever logged');
});
