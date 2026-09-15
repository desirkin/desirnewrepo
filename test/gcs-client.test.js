// PERSIST-1 GCS object client (2026-09-15). Offline: an INJECTED fetch stub (a function, never a real socket) records the
// requests and returns canned responses; a real RSA keypair is generated in-process so the minted JWT can be verified with
// its public half. No network, no real credential, no leak of the private key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createGcsObjectClient, parseServiceAccount, buildAssertion, GcsClientError, GCS_SCOPE, GCS_TOKEN_URL } from '../persistence/gcs-client.js';

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
