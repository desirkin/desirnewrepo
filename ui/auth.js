// CONTROL-0 — control authentication and authorization. Zero dependencies.
// Defensive controls are authority, not convenience: the browser UI is never
// itself proof of authorization — every control mutation is authenticated
// and authorized again HERE, on the server. Missing configuration fails
// closed. Secrets never enter source, logs, Memory, control history, or
// API responses. See doctrine/CONTROL.md.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_LIFETIME_MS = 8 * 3600 * 1000; // absolute; restart invalidates — by design
export const CLEAR_PHRASE = 'CLEAR SERPENT';
// Failed-auth rate limit (documented policy): max 5 failed password
// verifications inside 5 minutes -> 15-minute lockout. Process-wide by
// design (single-owner cockpit; client IP headers are not trusted as a
// security key). Login failures and CLEAR re-entry failures count against
// the SAME limiter — CLEAR must never become a second password oracle.
export const RATE_LIMIT = Object.freeze({ maxFailures: 5, windowMs: 5 * 60_000, lockoutMs: 15 * 60_000 });
const SWEEP_EVERY = 50; // opportunistic expired-session sweep cadence (accesses)

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest();
const digestEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b)); // fixed-length, constant-shape

export class ControlAuth {
  #fixedPassword; // tests may inject; production reads the environment lazily
  #sessions = new Map(); // sessionId -> { csrf, expiresAt, tag }
  #failures = []; // failed password-verification timestamps (ms)
  #lockedUntil = 0;
  #accesses = 0;

  constructor({ password, now = Date.now, audit = () => {} } = {}) {
    this.#fixedPassword = password;
    this.now = now;
    this.audit = audit; // receives non-secret event objects only
  }

  #password() {
    return this.#fixedPassword ?? process.env.SERPENT_CONTROL_PASSWORD;
  }

  configured() {
    const p = this.#password();
    return typeof p === 'string' && p.length > 0;
  }

  // ---- failed-auth rate limiter (shared by login AND CLEAR re-entry) ----
  #locked() {
    return this.now() < this.#lockedUntil;
  }

  lockRemainingSec() {
    return this.#locked() ? Math.ceil((this.#lockedUntil - this.now()) / 1000) : 0;
  }

  #recordFailure() {
    const t = this.now();
    this.#failures = this.#failures.filter((f) => t - f < RATE_LIMIT.windowMs);
    this.#failures.push(t);
    if (this.#failures.length >= RATE_LIMIT.maxFailures) {
      this.#lockedUntil = t + RATE_LIMIT.lockoutMs;
      this.audit({ event: 'AUTH_RATE_LIMITED', lockoutSec: RATE_LIMIT.lockoutMs / 1000 });
    }
  }

  // One password verification, limiter-governed. NEVER logs the supplied
  // value; refuses without verifying while locked out.
  #verifyPassword(supplied) {
    if (!this.configured()) return { ok: false, reason: 'CONTROL_AUTH_UNCONFIGURED' };
    if (this.#locked()) return { ok: false, reason: 'RATE_LIMITED', retryAfterSec: this.lockRemainingSec() };
    if (typeof supplied !== 'string' || !digestEqual(supplied, this.#password())) {
      this.#recordFailure();
      return { ok: false, reason: 'AUTH_FAILED' }; // generic — no length/content hints
    }
    this.#failures = [];
    return { ok: true };
  }

  #sweep() {
    const t = this.now();
    for (const [id, s] of this.#sessions) if (t >= s.expiresAt) this.#sessions.delete(id);
  }

  #session(id) {
    if (++this.#accesses % SWEEP_EVERY === 0) this.#sweep(); // bounded opportunistic cleanup
    if (typeof id !== 'string' || !id) return null;
    const s = this.#sessions.get(id);
    if (!s) return null;
    if (this.now() >= s.expiresAt) {
      this.#sessions.delete(id); // expired-on-access removal
      return null;
    }
    return s;
  }

  sessionCount() {
    this.#sweep();
    return this.#sessions.size;
  }

  // ---- login: the ONLY endpoint exempt from CSRF (no session exists yet
  // to carry a token); protected instead by SameSite=Strict cookies,
  // same-origin policy, the password itself, and the rate limiter.
  login(password) {
    const v = this.#verifyPassword(password);
    if (!v.ok) {
      this.audit({ event: v.reason === 'AUTH_FAILED' ? 'AUTH_FAIL' : `AUTH_${v.reason}` });
      return { authenticated: false, ...v };
    }
    const sessionId = randomBytes(32).toString('hex'); // 256-bit opaque
    const csrf = randomBytes(32).toString('hex');
    const expiresAt = this.now() + SESSION_LIFETIME_MS;
    const tag = createHash('sha256').update(sessionId).digest('hex').slice(0, 8); // non-reversible correlation tag
    this.#sessions.set(sessionId, { csrf, expiresAt, tag });
    this.audit({ event: 'AUTH_OK', sessionTag: tag, expiresAt });
    return { authenticated: true, sessionId, csrfToken: csrf, expiresAt };
  }

  // ---- session + CSRF authorization for every mutation (login excepted)
  authorize(sessionId, csrfHeader) {
    if (!this.configured()) return { ok: false, code: 503, reason: 'CONTROL_AUTH_UNCONFIGURED' };
    const s = this.#session(sessionId);
    if (!s) return { ok: false, code: 401, reason: 'UNAUTHENTICATED' };
    if (typeof csrfHeader !== 'string' || !csrfHeader || !digestEqual(csrfHeader, s.csrf)) {
      return { ok: false, code: 403, reason: 'CSRF_INVALID', sessionTag: s.tag };
    }
    return { ok: true, sessionTag: s.tag };
  }

  status(sessionId) {
    const s = this.#session(sessionId);
    return {
      configured: this.configured(),
      authenticated: Boolean(s),
      ...(s ? { csrfToken: s.csrf, expiresAt: s.expiresAt } : {}),
    };
  }

  logout(sessionId, csrfHeader) {
    const a = this.authorize(sessionId, csrfHeader);
    if (!a.ok) return a;
    this.#sessions.delete(sessionId);
    this.audit({ event: 'LOGOUT', sessionTag: a.sessionTag });
    return { ok: true };
  }

  // ---- CLEAR / RE-ARM: restoring permission demands MORE deliberate human
  // intent than engaging a lock — a valid session does NOT exempt the fresh
  // password from the limiter, and both password and exact phrase are
  // verified server-side. Refusals never disclose which part was wrong.
  authorizeClear(sessionId, csrfHeader, password, phrase) {
    const a = this.authorize(sessionId, csrfHeader);
    if (!a.ok) return a;
    const v = this.#verifyPassword(password);
    if (!v.ok) {
      const code = v.reason === 'RATE_LIMITED' ? 429 : 403;
      this.audit({ event: 'CLEAR_REFUSED', category: v.reason, sessionTag: a.sessionTag });
      return { ok: false, code, reason: v.reason === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'CLEAR_REFUSED', ...(v.retryAfterSec ? { retryAfterSec: v.retryAfterSec } : {}) };
    }
    if (phrase !== CLEAR_PHRASE) {
      this.audit({ event: 'CLEAR_REFUSED', category: 'BAD_PHRASE', sessionTag: a.sessionTag });
      return { ok: false, code: 403, reason: 'CLEAR_REFUSED' };
    }
    this.audit({ event: 'CLEAR_AUTHORIZED', sessionTag: a.sessionTag });
    return { ok: true, sessionTag: a.sessionTag };
  }
}

// ---- request-level helpers (pure; the server wires them) ----

// CONTROL-0A: control-session cookies FAIL TOWARD Secure transport. A
// reverse-proxy header may strengthen the determination but is never the
// sole evidence: an encrypted socket, a defensible https forwarded-proto,
// OR simply a non-local Host each force Secure. Only defensible loopback
// development hosts stay non-Secure so plain-HTTP local testing works. A
// spoofed non-local Host over plain HTTP yields a Secure cookie the
// browser will refuse to send insecurely — acceptable fail-closed behavior.
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export function cookieSecure({ encrypted = false, forwardedProto, host } = {}) {
  if (encrypted === true) return true;
  if (String(forwardedProto ?? '').toLowerCase().includes('https')) return true;
  return !LOCAL_HOST_RE.test(String(host ?? '')); // unknown or non-local host -> Secure
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// The full control-mutation gate. FAIL CLOSED: any unexpected auth-subsystem
// throw refuses the action — the control implementation is never invoked
// before authorization completes. Same-origin: when a browser supplies an
// Origin header it must match our own host (no permissive CORS anywhere);
// when Origin is absent (non-browser client), SameSite=Strict cookies and
// CSRF remain controlling.
export function gateControl(auth, { cookieHeader, csrfHeader, originHeader, hostHeader, body }) {
  try {
    if (!auth.configured()) return { allow: false, code: 503, reason: 'CONTROL_AUTH_UNCONFIGURED' };
    if (originHeader) {
      let originHost = null;
      try {
        originHost = new URL(originHeader).host;
      } catch {
        return { allow: false, code: 403, reason: 'CROSS_ORIGIN' };
      }
      if (!hostHeader || originHost !== hostHeader) return { allow: false, code: 403, reason: 'CROSS_ORIGIN' };
    }
    const sessionId = parseCookies(cookieHeader).serpent_session;
    const action = String(body?.action ?? '').toLowerCase();
    if (action === 'clear') {
      const r = auth.authorizeClear(sessionId, csrfHeader, body?.password, body?.confirmPhrase);
      return r.ok ? { allow: true, sessionTag: r.sessionTag } : { allow: false, code: r.code, reason: r.reason, retryAfterSec: r.retryAfterSec };
    }
    const r = auth.authorize(sessionId, csrfHeader);
    return r.ok ? { allow: true, sessionTag: r.sessionTag } : { allow: false, code: r.code, reason: r.reason };
  } catch (err) {
    // fail closed, loudly, without executing anything
    return { allow: false, code: 500, reason: 'CONTROL_AUTH_ERROR', detail: err.constructor?.name ?? 'Error' };
  }
}
