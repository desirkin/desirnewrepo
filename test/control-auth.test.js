// CONTROL-0 unit drills: the ControlAuth authority — fail-closed
// configuration, constant-shape password checks, opaque sessions with
// 8-hour expiry and bounded pruning, CSRF, the shared failed-auth limiter
// (login AND CLEAR re-entry), stronger CLEAR intent, and the fail-closed
// request gate. No secret ever reaches audit output.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SERPENT_CONTROL_PASSWORD; // this file controls its own configuration

const { ControlAuth, gateControl, parseCookies, SESSION_LIFETIME_MS, CLEAR_PHRASE, RATE_LIMIT } = await import('../ui/auth.js');

const PW = 'test-owner-password-9182';
const mk = (over = {}) => {
  let t = 1_000_000_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const events = [];
  const auth = new ControlAuth({ password: PW, now: clock.now, audit: (e) => events.push(e), ...over });
  return { auth, clock, events };
};

test('UNCONFIGURED: no password, no defaults — controls fail closed with a stable reason', () => {
  const { auth } = mk({ password: undefined }); // env var is deleted above: truly unconfigured
  assert.equal(auth.configured(), false);
  assert.equal(auth.login('anything').reason, 'CONTROL_AUTH_UNCONFIGURED');
  const a = auth.authorize('some-session', 'some-csrf');
  assert.equal(a.ok, false);
  assert.equal(a.code, 503);
  assert.equal(a.reason, 'CONTROL_AUTH_UNCONFIGURED');
  assert.equal(gateControl(auth, { body: { action: 'kill' } }).reason, 'CONTROL_AUTH_UNCONFIGURED');
});

test('LOGIN: correct password issues an opaque session; wrong password fails generically', () => {
  const { auth } = mk();
  const bad = auth.login('wrong');
  assert.equal(bad.authenticated, false);
  assert.equal(bad.reason, 'AUTH_FAILED'); // no length/content hints
  assert.equal(bad.sessionId, undefined);
  const ok = auth.login(PW);
  assert.equal(ok.authenticated, true);
  assert.match(ok.sessionId, /^[0-9a-f]{64}$/); // 256-bit opaque
  assert.match(ok.csrfToken, /^[0-9a-f]{64}$/);
  assert.notEqual(ok.sessionId, ok.csrfToken);
  assert.equal(auth.authorize(ok.sessionId, ok.csrfToken).ok, true);
});

test('CSRF: cookie and token are independently required', () => {
  const { auth } = mk();
  const s = auth.login(PW);
  assert.equal(auth.authorize(s.sessionId, undefined).ok, false); // cookie without CSRF
  assert.equal(auth.authorize(s.sessionId, 'not-the-token').code, 403);
  assert.equal(auth.authorize(undefined, s.csrfToken).code, 401); // CSRF without session
  assert.equal(auth.authorize('0'.repeat(64), s.csrfToken).code, 401);
});

test('EXPIRY + PRUNING: 8-hour absolute lifetime; expired sessions cannot authorize and do not accumulate', () => {
  const { auth, clock } = mk();
  const old = [];
  for (let i = 0; i < 30; i++) old.push(auth.login(PW));
  assert.equal(auth.sessionCount(), 30);
  clock.advance(SESSION_LIFETIME_MS + 1);
  // expired sessions cannot authorize mutations
  assert.equal(auth.authorize(old[0].sessionId, old[0].csrfToken).code, 401);
  const fresh = auth.login(PW);
  assert.equal(auth.authorize(fresh.sessionId, fresh.csrfToken).ok, true);
  assert.equal(auth.sessionCount(), 1); // stale sessions swept; the active one preserved
  // repeated login/logout/expiry cycles stay bounded
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 20; i++) auth.login(PW);
    clock.advance(SESSION_LIFETIME_MS + 1);
  }
  assert.equal(auth.sessionCount(), 0);
});

test('LOGOUT: requires session+CSRF, removes the session immediately; a new manager invalidates old sessions', () => {
  const { auth } = mk();
  const s = auth.login(PW);
  assert.equal(auth.logout(s.sessionId, 'wrong-csrf').ok, false); // logout is a mutation too
  assert.equal(auth.logout(s.sessionId, s.csrfToken).ok, true);
  assert.equal(auth.authorize(s.sessionId, s.csrfToken).code, 401);
  assert.equal(auth.sessionCount(), 0);
  // restart semantics: a fresh in-memory manager knows no old session
  const restarted = new ControlAuth({ password: PW });
  assert.equal(restarted.authorize(s.sessionId, s.csrfToken).code, 401);
});

test('RATE LIMIT: 5 failures in 5 minutes lock for 15; lockout refuses even the correct password', () => {
  const { auth, clock } = mk();
  for (let i = 0; i < RATE_LIMIT.maxFailures; i++) assert.equal(auth.login('wrong-' + i).authenticated, false);
  const locked = auth.login(PW); // correct password during lockout
  assert.equal(locked.authenticated, false);
  assert.equal(locked.reason, 'RATE_LIMITED'); // never even verified — no oracle
  assert.ok(locked.retryAfterSec > 0);
  clock.advance(RATE_LIMIT.lockoutMs + 1);
  assert.equal(auth.login(PW).authenticated, true); // limiter permits again
});

test('CLEAR SHARES THE LIMITER: an authenticated session cannot turn CLEAR into a password oracle', () => {
  const { auth, clock } = mk();
  const s = auth.login(PW);
  // failed CLEAR password attempts count against the SAME limiter
  for (let i = 0; i < RATE_LIMIT.maxFailures; i++) {
    const r = auth.authorizeClear(s.sessionId, s.csrfToken, 'guess-' + i, CLEAR_PHRASE);
    assert.equal(r.ok, false);
  }
  // now locked: a fresh LOGIN with the correct password is refused
  assert.equal(auth.login(PW).reason, 'RATE_LIMITED');
  // and a CLEAR with the CORRECT password is refused too — session is no bypass
  const during = auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE);
  assert.equal(during.ok, false);
  assert.equal(during.code, 429);
  // after the lockout window, correctly authenticated CLEAR works
  clock.advance(RATE_LIMIT.lockoutMs + 1);
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE).ok, true);
});

test('CLEAR INTENT: fresh password AND the exact phrase, both server-verified, refusals undisclosed', () => {
  const { auth } = mk();
  const s = auth.login(PW);
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, undefined, CLEAR_PHRASE).ok, false); // no fresh password
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, 'wrong', CLEAR_PHRASE).reason, 'CLEAR_REFUSED');
  const badPhrase = auth.authorizeClear(s.sessionId, s.csrfToken, PW, 'clear serpent'); // case matters: exact phrase
  assert.equal(badPhrase.ok, false);
  assert.equal(badPhrase.reason, 'CLEAR_REFUSED'); // same reason either way — nothing disclosed
  // wrong PHRASE with a correct password never feeds the limiter
  for (let i = 0; i < RATE_LIMIT.maxFailures + 2; i++) {
    assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, PW, 'NOT THE PHRASE').ok, false);
  }
  assert.equal(auth.login(PW).authenticated, true); // not locked out
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, PW, 'CLEAR SERPENT').ok, true);
});

test('GATE: fail-closed on auth-subsystem failure; same-origin enforced when Origin is present', () => {
  const { auth } = mk();
  const s = auth.login(PW);
  const req = (over = {}) => ({
    cookieHeader: `serpent_session=${s.sessionId}`,
    csrfHeader: s.csrfToken,
    hostHeader: 'cobra.example:3000',
    body: { action: 'kill' },
    ...over,
  });
  assert.equal(gateControl(auth, req()).allow, true);
  assert.equal(gateControl(auth, req({ originHeader: 'https://evil.example' })).reason, 'CROSS_ORIGIN');
  assert.equal(gateControl(auth, req({ originHeader: 'not a url' })).reason, 'CROSS_ORIGIN');
  assert.equal(gateControl(auth, req({ originHeader: 'http://cobra.example:3000' })).allow, true); // own origin
  // a throwing auth subsystem REFUSES — the control action can never run first
  const poisoned = { configured() { throw new Error('auth exploded'); } };
  const r = gateControl(poisoned, req());
  assert.equal(r.allow, false);
  assert.equal(r.code, 500);
  assert.equal(r.reason, 'CONTROL_AUTH_ERROR');
});

test('AUDIT SECRECY: no password, session id, or CSRF token ever reaches audit events', () => {
  const { auth, events } = mk();
  auth.login('wrong-guess-hunter2');
  const s = auth.login(PW);
  auth.authorizeClear(s.sessionId, s.csrfToken, 'bad-clear-guess', CLEAR_PHRASE);
  auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE);
  auth.logout(s.sessionId, s.csrfToken);
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(PW));
  assert.ok(!dump.includes('hunter2'));
  assert.ok(!dump.includes('bad-clear-guess'));
  assert.ok(!dump.includes(s.sessionId));
  assert.ok(!dump.includes(s.csrfToken));
  assert.ok(events.some((e) => e.event === 'AUTH_OK' && /^[0-9a-f]{8}$/.test(e.sessionTag))); // short non-reversible tag only
  assert.ok(events.some((e) => e.event === 'CLEAR_AUTHORIZED'));
});

test('cookie parsing is boring and exact', () => {
  assert.deepEqual(parseCookies('a=1; serpent_session=abc; b=2'), { a: '1', serpent_session: 'abc', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});
