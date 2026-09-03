// CONTROL-0 endpoint drills against the REAL cockpit server: cookie flags,
// CSRF, per-route protection of every mutation, CLEAR's stronger intent,
// cross-origin refusal, unconfigured fail-closed, logout, rate limiting,
// and secret-free logs. Read-only routes stay open throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-ctl-http-'));
process.env.COBRA_DATA_DIR = TEST_DATA;
const PORT = 39000 + Math.floor(Math.random() * 500);
process.env.PORT = String(PORT);
const PW = 'http-test-owner-password-7715';
delete process.env.SERPENT_CONTROL_PASSWORD; // start UNCONFIGURED
// PERSIST-0B §16: this suite drills the AUTH layer in the documented
// local-only development mode — explicitly remove any ambient managed
// DATABASE_URL so the persistence gates behave identically on a bare
// machine and on Replit. Persistence-gate behavior has its own suites.
delete process.env.DATABASE_URL;
delete process.env.REPLIT_DEPLOYMENT;
delete process.env.SERPENT_DURABLE_REQUIRED;

const { server } = await import('../ui/server.js'); // listens on PORT
const BASE = `http://127.0.0.1:${PORT}`;

test.after(() => {
  server.close();
  rmSync(TEST_DATA, { recursive: true, force: true });
});

const post = (pathname, body, headers = {}) =>
  fetch(BASE + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const controlsFile = path.join(TEST_DATA, 'state', 'controls.json');
const controls = () => (existsSync(controlsFile) ? JSON.parse(readFileSync(controlsFile, 'utf8')) : {});
const authLog = () => {
  const f = path.join(TEST_DATA, 'state', 'control_auth_log.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
};

let cookie; // 'serpent_session=<id>'
let csrf;
const authed = (extra = {}) => ({ cookie, 'X-Serpent-CSRF': csrf, ...extra });

test('UNCONFIGURED: login 503; every control mutation fails closed; read-only untouched', async () => {
  const login = await post('/api/auth/login', { password: 'anything' });
  assert.equal(login.status, 503);
  assert.equal((await login.json()).reason, 'CONTROL_AUTH_UNCONFIGURED');
  const kill = await post('/api/control', { action: 'kill' });
  assert.equal(kill.status, 503);
  assert.equal((await kill.json()).reason, 'CONTROL_AUTH_UNCONFIGURED');
  assert.deepEqual(controls(), {}); // nothing executed
  const status = await fetch(BASE + '/api/status');
  assert.equal(status.status, 200); // observation never needs auth
  assert.equal((await status.json()).controlAuth, 'UNCONFIGURED');
  const as = await (await fetch(BASE + '/api/auth/status')).json();
  assert.equal(as.controlAuth, 'CONTROL_AUTH_UNCONFIGURED');
});

test('LOGIN: wrong password generic 401; correct password sets an HttpOnly SameSite=Strict cookie', async () => {
  process.env.SERPENT_CONTROL_PASSWORD = PW; // owner configures the Replit Secret
  const bad = await post('/api/auth/login', { password: 'nope' });
  assert.equal(bad.status, 401);
  const badBody = await bad.json();
  assert.equal(badBody.reason, 'AUTH_FAILED'); // no hints
  assert.ok(!JSON.stringify(badBody).includes('nope'));

  const ok = await post('/api/auth/login', { password: PW });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /serpent_session=[0-9a-f]{64}/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=28800/); // 8 hours
  assert.ok(!setCookie.includes('Secure')); // 127.0.0.1 plain-HTTP development: the intentional exception
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = await ok.json();
  assert.equal(body.authenticated, true);
  assert.match(body.csrfToken, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(body).includes(PW)); // password never echoed
  cookie = setCookie.split(';')[0];
  csrf = body.csrfToken;
  const st = await (await fetch(BASE + '/api/auth/status', { headers: { cookie } })).json();
  assert.equal(st.authenticated, true);
  assert.equal(st.controlAuth, 'CONTROL_AUTHENTICATED');
});

test('EVERY MUTATION GATED: no auth 401; cookie without CSRF 403; CSRF without cookie 401; wrong CSRF 403', async () => {
  for (const action of ['kill', 'cage', 'veto', 'clear']) {
    assert.equal((await post('/api/control', { action })).status, 401, `${action} unauthenticated`);
    assert.equal((await post('/api/control', { action }, { cookie })).status, 403, `${action} cookie-only`);
    assert.equal((await post('/api/control', { action }, { 'X-Serpent-CSRF': csrf })).status, 401, `${action} csrf-only`);
    assert.equal((await post('/api/control', { action }, { cookie, 'X-Serpent-CSRF': 'f'.repeat(64) })).status, 403, `${action} bad csrf`);
  }
  assert.deepEqual(controls(), {}); // still nothing executed
});

test('CROSS-ORIGIN: a foreign Origin is refused even with valid session+CSRF', async () => {
  const r = await post('/api/control', { action: 'kill' }, authed({ origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, 'CROSS_ORIGIN');
  assert.equal(r.headers.get('access-control-allow-origin'), null); // no permissive CORS, ever
  assert.deepEqual(controls(), {});
});

test('AUTHORIZED CONTROLS: KILL, CAGE, VETO work exactly as before once authorized', async () => {
  const kill = await post('/api/control', { action: 'kill' }, authed());
  assert.equal(kill.status, 200);
  const kd = await kill.json();
  assert.equal(kd.ok, true);
  assert.equal(kd.action, 'KILL'); // existing response shape preserved
  assert.ok(kd.status);
  assert.equal(controls().kill.active, true);
  assert.equal((await post('/api/control', { action: 'cage' }, authed())).status, 200);
  assert.equal(controls().cage.active, true);
  assert.equal((await post('/api/control', { action: 'veto', predictionId: 'pred-http-1' }, authed())).status, 200);
  assert.equal(controls().vetoes[0].prediction_id, 'pred-http-1');
});

test('CLEAR INTENT over HTTP: session+CSRF alone never clears; wrong password/phrase refused with state intact', async () => {
  const noPw = await post('/api/control', { action: 'clear' }, authed());
  assert.equal(noPw.status, 403);
  assert.equal((await noPw.json()).reason, 'CLEAR_REFUSED');
  const wrongPw = await post('/api/control', { action: 'clear', password: 'wrong', confirmPhrase: 'CLEAR SERPENT' }, authed());
  assert.equal(wrongPw.status, 403);
  const wrongPhrase = await post('/api/control', { action: 'clear', password: PW, confirmPhrase: 'CLEAR THE SERPENT' }, authed());
  assert.equal(wrongPhrase.status, 403);
  assert.equal(controls().kill.active, true); // protective state untouched by every refusal
  assert.equal(controls().cage.active, true);

  const ok = await post('/api/control', { action: 'clear', password: PW, confirmPhrase: 'CLEAR SERPENT' }, authed());
  assert.equal(ok.status, 200);
  assert.equal(controls().kill, null); // existing CLEAR semantics: latches drop,
  assert.equal(controls().cage, null);
  assert.equal(controls().vetoes.length, 1); // vetoes stay — a denied trade stays denied
});

test('DUPLICATE AUTH REQUESTS: more logins never create control actions', async () => {
  const before = JSON.stringify(controls());
  const a = await (await post('/api/auth/login', { password: PW })).json();
  const b = await (await post('/api/auth/login', { password: PW })).json();
  assert.notEqual(a.csrfToken, b.csrfToken); // distinct sessions
  assert.equal(JSON.stringify(controls()), before); // zero control side effects
});

test('LOGOUT: requires CSRF, invalidates the session, clears the cookie', async () => {
  assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 403); // logout is a mutation too
  const out = await post('/api/auth/logout', {}, authed());
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await post('/api/control', { action: 'kill' }, authed())).status, 401); // session gone
  const st = await (await fetch(BASE + '/api/auth/status', { headers: { cookie } })).json();
  assert.equal(st.authenticated, false);
  assert.equal(st.controlAuth, 'CONTROL_LOCKED');
});

test('SECRETS STAY OUT OF LOGS: the audit trail names events and tags, never credentials', async () => {
  const log = authLog();
  assert.ok(log.includes('AUTH_OK'));
  assert.ok(log.includes('CONTROL_AUTHORIZED'));
  assert.ok(log.includes('CONTROL_REFUSED'));
  assert.ok(log.includes('CLEAR_REFUSED'));
  assert.ok(log.includes('CLEAR_AUTHORIZED'));
  assert.ok(!log.includes(PW));
  assert.ok(!log.includes('nope'));
  assert.ok(!log.includes(csrf)); // no CSRF tokens
  assert.ok(!log.includes(cookie.split('=')[1])); // no full session id
});

// CONTROL-0A §G/H — creation and deletion cookies share ONE policy,
// Secure determination included, with every other attribute intact.
test('SECURE COOKIE over HTTP: forwarded https makes BOTH the login and logout cookies Secure', async () => {
  const proto = { 'x-forwarded-proto': 'https' };
  const login = await post('/api/auth/login', { password: PW }, proto);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=28800/);
  const body = await login.json();
  const c = setCookie.split(';')[0];
  const out = await post('/api/auth/logout', {}, { ...proto, cookie: c, 'X-Serpent-CSRF': body.csrfToken });
  const delCookie = out.headers.get('set-cookie');
  assert.match(delCookie, /Secure/); // same policy on deletion
  assert.match(delCookie, /HttpOnly/);
  assert.match(delCookie, /SameSite=Strict/);
  assert.match(delCookie, /Max-Age=0/);
});

// LAST on purpose: the limiter is process-wide and this locks it.
test('RATE LIMIT over HTTP: mixed failed CLEARs and logins lock out; a valid session cannot bypass', async () => {
  const login2 = await post('/api/auth/login', { password: PW }); // fresh session; success resets failures
  const freshCookie = login2.headers.get('set-cookie').split(';')[0];
  const fresh = await login2.json();
  const h = { cookie: freshCookie, 'X-Serpent-CSRF': fresh.csrfToken };
  // 3 failed CLEAR password re-entries + 2 failed logins = 5 failures
  for (let i = 0; i < 3; i++) {
    assert.equal((await post('/api/control', { action: 'clear', password: 'guess' + i, confirmPhrase: 'CLEAR SERPENT' }, h)).status, 403);
  }
  for (let i = 0; i < 2; i++) assert.equal((await post('/api/auth/login', { password: 'bad' + i })).status, 401);
  // locked: correct-password login refused
  const locked = await post('/api/auth/login', { password: PW });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).reason, 'RATE_LIMITED');
  // locked: CLEAR with the CORRECT password on a VALID session refused too
  const state = JSON.stringify(controls());
  const clearLocked = await post('/api/control', { action: 'clear', password: PW, confirmPhrase: 'CLEAR SERPENT' }, h);
  assert.equal(clearLocked.status, 429);
  assert.equal(JSON.stringify(controls()), state); // rate-limited CLEAR changes nothing
});
