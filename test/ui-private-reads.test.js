// PUBLISH-FIX-20 (2026-09-17, independent review F7): read-only is not private. With control auth CONFIGURED, the read
// routes that disclose the account, the Judge's state, the ledger, the research cases, the hunt trail and the learning
// memory answer 401 OWNER_SESSION_REQUIRED without the owner session and serve normally with it; operational health
// stays public. The display-only harness (no password provisioned) is exercised by test/ui-endpoints.test.js unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-uipriv-')); process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39500 + Math.floor(Math.random() * 300); process.env.PORT = String(PORT);
delete process.env.DATABASE_URL; delete process.env.REPLIT_DEPLOYMENT; delete process.env.SERPENT_DURABLE_REQUIRED; delete process.env.JUDGE_ENABLED; delete process.env.ANTHROPIC_API_KEY;
const PW = 'private-reads-test-password-FAKE'; process.env.SERPENT_CONTROL_PASSWORD = PW;
const { server, PRIVATE_READ_ROUTES } = await import('../ui/server.js');
const base = `http://127.0.0.1:${PORT}`;
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
test.after(async () => { await new Promise((r) => server.close(r)); rmSync(TEST_DATA, { recursive: true, force: true }); });

const PRIVATE = ['/api/accounts', '/api/judge', '/api/ledger/summary', '/api/hunt-trail?coin=BTC', '/api/learning', '/api/market-research/case?dir=x'];
const PUBLIC = ['/api/status', '/api/sensors', '/api/ears', '/api/wideeye', '/api/rumor2', '/api/market-broad', '/api/market-research', '/api/attention', '/api/ask/status', '/api/auth/status'];

test('F7. without the owner session every private read route is 401 OWNER_SESSION_REQUIRED (no-store, no body data); the public health routes still answer', async () => {
  assert.deepEqual([...PRIVATE_READ_ROUTES].sort(), ['/api/accounts', '/api/hunt-trail', '/api/judge', '/api/learning', '/api/ledger/summary', '/api/market-research/case']);
  for (const p of PRIVATE) {
    const r = await fetch(`${base}${p}`); assert.equal(r.status, 401, p); assert.equal(r.headers.get('cache-control'), 'no-store', p);
    const d = await r.json(); assert.equal(d.error, 'OWNER_SESSION_REQUIRED'); assert.equal(Object.keys(d).sort().join(','), 'authority,error,route', `${p} discloses nothing but the refusal`);
  }
  for (const p of PUBLIC) { const r = await fetch(`${base}${p}`); assert.notEqual(r.status, 401, p); }
  const bogus = await fetch(`${base}/api/judge`, { headers: { cookie: 'serpent_session=not-a-session' } }); assert.equal(bogus.status, 401, 'a forged cookie is not a session');
});

test('F7. with the owner session the same routes serve their read-only views; logout locks them again', async () => {
  const login = await post('/api/auth/login', { password: PW }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0]; const { csrfToken } = await login.json();
  for (const p of ['/api/accounts', '/api/judge', '/api/ledger/summary', '/api/learning', '/api/hunt-trail?coin=BTC']) { const r = await fetch(`${base}${p}`, { headers: { cookie } }); assert.equal(r.status, 200, p); }
  const missingCase = await fetch(`${base}/api/market-research/case?dir=x`, { headers: { cookie } }); assert.equal(missingCase.status, 404, 'the session opens the route; the route still answers honestly');
  const out = await post('/api/auth/logout', {}, { cookie, 'x-serpent-csrf': csrfToken, origin: `http://127.0.0.1:${PORT}` }); assert.equal(out.status, 200);
  assert.equal((await fetch(`${base}/api/judge`, { headers: { cookie } })).status, 401, 'a logged-out session no longer opens the private reads');
});
