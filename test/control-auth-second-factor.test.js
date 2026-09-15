// CONTROL-0B — the acting controls' second factor, at the ControlAuth seam.
// Acting authority is granted only with password + TOTP; the second factor
// rides the SAME failed-auth limiter (no TOTP brute-force oracle); CLEAR and
// ARM re-verify BOTH factors fresh; a code never reaches audit. Backward
// compatible: with no secret provisioned the checks are exactly password-only.
// No network; an injected clock drives both the session lifetime and TOTP.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SERPENT_CONTROL_PASSWORD;
delete process.env.SERPENT_CONTROL_TOTP_SECRET; // this file owns its configuration

const { ControlAuth, gateControl, CLEAR_PHRASE, RATE_LIMIT } = await import('../ui/auth.js');
const { verifyTotp } = await import('../lib/totp.js');

const PW = 'test-owner-password-9182';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of ASCII "12345678901234567890"
const T0 = 1_000_000_000_000; // ms

// The valid 6-digit code at a given ms clock — recovered by asking verifyTotp
// (window 0) which candidate matches, so the test never re-implements HOTP.
function codeAt(ms) {
  const now = () => ms;
  for (let n = 0; n < 1_000_000; n++) {
    const c = String(n).padStart(6, '0');
    if (verifyTotp(SECRET, c, { now, window: 0 })) return c;
  }
  throw new Error('no code found');
}

const mk = (over = {}) => {
  let t = T0;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const events = [];
  const auth = new ControlAuth({ password: PW, now: clock.now, audit: (e) => events.push(e), ...over });
  return { auth, clock, events };
};

test('SF-1. no secret provisioned: password-only, exactly as before; status says DISABLED', () => {
  const { auth } = mk(); // no totpSecret
  assert.equal(auth.secondFactorConfigured(), false);
  assert.equal(auth.status(undefined).secondFactor, 'DISABLED');
  assert.equal(auth.login(PW).authenticated, true); // password alone still admits
  assert.equal(auth.login(PW, 'ignored-code').authenticated, true); // a code is simply ignored
  assert.equal(auth.login('wrong').authenticated, false);
});

test('SF-2. secret provisioned: login REQUIRES password + a valid current code', () => {
  const { auth, clock } = mk({ totpSecret: SECRET });
  assert.equal(auth.secondFactorConfigured(), true);
  assert.equal(auth.status(undefined).secondFactor, 'REQUIRED');
  assert.equal(auth.login(PW).authenticated, false, 'password alone is no longer enough');
  assert.equal(auth.login(PW).reason, 'AUTH_FAILED'); // generic — never says which factor
  assert.equal(auth.login(PW, '000000').authenticated, false, 'wrong code refused');
  assert.equal(auth.login('wrong', codeAt(clock.now())).authenticated, false, 'wrong password refused even with a valid code');
  const ok = auth.login(PW, codeAt(clock.now()));
  assert.equal(ok.authenticated, true);
  assert.match(ok.sessionId, /^[0-9a-f]{64}$/);
  assert.equal(auth.authorize(ok.sessionId, ok.csrfToken).ok, true); // the 2FA'd session then acts (KILL/CAGE/toggles ride it)
});

test('SF-3. a present-but-garbage secret is treated as DISABLED (checklist catches it), never a brick', () => {
  const { auth } = mk({ totpSecret: '!!! not base32 !!!' });
  assert.equal(auth.secondFactorConfigured(), false); // not usable -> not "configured"
  assert.equal(auth.status(undefined).secondFactor, 'DISABLED');
  assert.equal(auth.login(PW).authenticated, true); // falls back to today's password-only; the readiness checklist requires REQUIRED
});

test('SF-4. the second factor rides the SAME limiter — no TOTP brute-force oracle', () => {
  const { auth, clock } = mk({ totpSecret: SECRET });
  // correct password, wrong code, repeated: each counts a failure (limiter is not reset until BOTH pass)
  for (let i = 0; i < RATE_LIMIT.maxFailures; i++) assert.equal(auth.login(PW, String(i).padStart(6, '0')).authenticated, false);
  const locked = auth.login(PW, codeAt(clock.now())); // now a fully-correct attempt
  assert.equal(locked.authenticated, false);
  assert.equal(locked.reason, 'RATE_LIMITED'); // refused without even verifying
  clock.advance(RATE_LIMIT.lockoutMs + 1);
  assert.equal(auth.login(PW, codeAt(clock.now())).authenticated, true); // limiter permits again
});

test('SF-5. CLEAR and ARM re-verify BOTH factors fresh at the instant they act', () => {
  const { auth, clock } = mk({ totpSecret: SECRET });
  const s = auth.login(PW, codeAt(clock.now()));
  assert.equal(s.authenticated, true);
  // CLEAR: correct password + exact phrase but NO / WRONG code -> refused (these fail, so they spend no code)
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE).ok, false);
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE, '000000').ok, false);
  clock.advance(30_000); // next TOTP step: the replay guard needs a FRESH code, not the one the login already spent
  assert.equal(auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE, codeAt(clock.now())).ok, true);
  // ARM: same — a valid session is necessary but never sufficient
  assert.equal(auth.authorizeArm(s.sessionId, s.csrfToken, PW).ok, false);
  assert.equal(auth.authorizeArm(s.sessionId, s.csrfToken, PW, '000000').ok, false);
  clock.advance(30_000);
  assert.equal(auth.authorizeArm(s.sessionId, s.csrfToken, PW, codeAt(clock.now())).ok, true);
});

test('SF-6. gateControl carries the code on the CLEAR path; a KILL rides the 2FA session', () => {
  const { auth, clock } = mk({ totpSecret: SECRET });
  const s = auth.login(PW, codeAt(clock.now()));
  const base = { cookieHeader: `serpent_session=${s.sessionId}`, csrfHeader: s.csrfToken, hostHeader: 'cobra.example:3000' };
  // KILL: session+CSRF (granted with 2FA) is the authority — no per-action code
  assert.equal(gateControl(auth, { ...base, body: { action: 'kill' } }).allow, true);
  // CLEAR through the gate: needs the fresh code too
  assert.equal(gateControl(auth, { ...base, body: { action: 'clear', password: PW, confirmPhrase: CLEAR_PHRASE } }).allow, false);
  clock.advance(30_000); // a fresh step: the login already spent the current code (replay guard)
  assert.equal(gateControl(auth, { ...base, body: { action: 'clear', password: PW, confirmPhrase: CLEAR_PHRASE, totp: codeAt(clock.now()) } }).allow, true);
});

test('SF-8. replay guard: a code is single-use — the spent step is refused even while still current; a failed login does not spend it; the durable floor survives a restart', () => {
  const store = (() => { let floor = null; return { get: () => floor, set: (n) => { floor = n; } }; })(); // a durable {get,set}
  let t = T0; const clock = { now: () => t, advance: (ms) => (t += ms) };
  const auth = new ControlAuth({ password: PW, totpSecret: SECRET, totpReplayStore: store, now: clock.now });
  const c0 = codeAt(t);
  assert.equal(auth.login(PW, c0).authenticated, true, 'first use of the current-step code works');
  assert.equal(auth.login(PW, c0).authenticated, false, 'immediate replay of the SAME code is refused (still the current step, but spent)');
  assert.equal(auth.login(PW, codeAt(t)).authenticated, false, 'any code for the spent step is refused, even freshly recomputed');
  // a WRONG-password attempt carrying the fresh valid code must NOT spend that step
  clock.advance(30_000);
  const fresh = codeAt(clock.now());
  assert.equal(auth.login('wrong', fresh).authenticated, false, 'wrong password refused');
  assert.equal(auth.login(PW, fresh).authenticated, true, 'the fresh step was not burned by the failed attempt — it still logs in');
  assert.equal(auth.login(PW, fresh).authenticated, false, 'and now that step is spent too');
  // durability: a fresh manager (a process restart) sharing the same durable store still refuses the CURRENT spent
  // step — this isolates the persisted floor from the ±window (the code is otherwise perfectly valid right now)
  const restarted = new ControlAuth({ password: PW, totpSecret: SECRET, totpReplayStore: store, now: clock.now });
  assert.equal(restarted.login(PW, codeAt(clock.now())).authenticated, false, 'after a restart the durable floor still blocks the current spent step');
  clock.advance(30_000);
  assert.equal(restarted.login(PW, codeAt(clock.now())).authenticated, true, 'a fresh step still works after the restart');
});

test('SF-7. audit secrecy: neither the password nor the TOTP code ever reaches audit output', () => {
  const { auth, clock, events } = mk({ totpSecret: SECRET });
  const code = codeAt(clock.now());
  auth.login(PW, code);
  clock.advance(30_000); // fresh step per accepted op (replay guard)
  const s = auth.login(PW, codeAt(clock.now()));
  clock.advance(30_000);
  auth.authorizeClear(s.sessionId, s.csrfToken, PW, CLEAR_PHRASE, codeAt(clock.now()));
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(PW));
  assert.ok(!dump.includes(SECRET));
  assert.ok(!dump.includes(code));
});
