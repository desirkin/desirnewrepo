# CONTROL DOCTRINE — the cockpit is secured (CONTROL-0)

> **Defensive controls are authority, not convenience.**
>
> **The browser UI is never itself proof of authorization. Every control
> mutation is authenticated and authorized again on the server.**
>
> **KILL/CAGE may be easy for an authenticated owner to engage.
> CLEAR / RE-ARM must require stronger fresh human intent.**
>
> **Missing authentication configuration means controls fail closed.**
>
> **Secrets never enter source control, client JavaScript, logs, Memory,
> Childhood, control history, or API responses.**
>
> **CONTROL-0 secures authority. PERSIST-0 will make control state durable.**

The interface is not authority. Possession of the URL is not authority. A
browser button is not authority. And restoring permission after a
defensive lock always requires more deliberate human intent than engaging
the lock.

## THE SECRET

`SERPENT_CONTROL_PASSWORD` comes ONLY from the process environment (Replit
Secrets in deployment). There is no default, no development fallback, no
generated hidden value. When it is absent: read-only observation still
works, every control mutation fails closed with
`CONTROL_AUTH_UNCONFIGURED` (HTTP 503), and startup logs
`CONTROL AUTH: UNCONFIGURED` — never a secret. Passwords are compared as
fixed-length SHA-256 digests via `crypto.timingSafeEqual` (constant-shape;
node builtins only), and a supplied password is never logged, echoed,
stored, or forwarded past the gate.

## SESSION

A successful login creates an opaque 256-bit random session id held in a
server-side in-memory Map — no credentials inside the cookie. Cookie:
`serpent_session`, HttpOnly, **SameSite=Strict**, Path=/, Max-Age 8h.
**Serpent control-session cookies fail toward Secure transport
(CONTROL-0A):** reverse-proxy headers may strengthen the determination but
are not the sole evidence that a non-local browser session requires Secure
— an encrypted socket, an https forwarded-proto, OR any non-loopback Host
each independently force Secure. The one intentional development
exception: defensible loopback forms (`localhost`, `127.0.0.1`, `[::1]`,
with or without a port) over plain HTTP stay non-Secure so local testing
works; an absent or arbitrary Host is never treated as local, and a
spoofed non-local Host over plain HTTP just yields a cookie the browser
refuses to send insecurely — fail-closed. One cookie-policy helper serves
both creation and deletion. Absolute lifetime: **8 hours**.
Sessions are deliberately ephemeral: a restart/redeploy invalidates them
(preferred over pretending they persist), and PERSIST-0 must NOT later
make auth sessions durable. Expired sessions are pruned on access and
swept opportunistically; logout removes its session immediately — the Map
never accumulates stale sessions unbounded.

## CSRF

Each session carries its own cryptographically random CSRF token, returned
to the same-origin client at login (and via `/api/auth/status` for an
authenticated session). Every mutation — controls AND logout — requires
BOTH the valid session cookie AND the token in the `X-Serpent-CSRF`
header, independently verified. Tokens never appear in URLs or logs; the
client keeps the token in ephemeral page memory only (never localStorage).

**The one deliberate exception: `POST /api/auth/login` requires no CSRF
token**, because no authenticated session exists yet from which a token
could be obtained. Login is protected instead by same-origin policy,
SameSite=Strict cookie behavior, the password itself, the failed-auth rate
limiter, and the absence of permissive CORS. This exception is never
generalized to any other mutation endpoint.

## SAME-ORIGIN

Control routes send no CORS headers — there is no
`Access-Control-Allow-Origin` anywhere, so browsers refuse cross-origin
reads and non-simple requests. Additionally, when a browser supplies an
`Origin` header on a control mutation it must match the request's own
host, else HTTP 403 `CROSS_ORIGIN`. When Origin is absent (legitimate
non-browser test client), SameSite=Strict + CSRF remain controlling.

## RATE LIMITING (documented policy)

Process-wide failed-auth limiter (single-owner cockpit; client-supplied IP
headers are never trusted as a security key): **max 5 failed password
verifications within 5 minutes → 15-minute lockout.** While locked, no
password is even verified (no oracle). A successful login resets the
failure count. **CLEAR's fresh password re-entry counts against this SAME
limiter** — a valid authenticated session does not exempt CLEAR guesses,
so CLEAR can never become a second unlimited password oracle. Limiter
state is in-memory and resets on restart, by design.

## THE CONTROL SURFACE

The application's only mutation route is `POST /api/control` with actions
KILL, CAGE, VETO, CLEAR — all four gated identically: configured auth +
valid session + valid CSRF, authorized BEFORE the existing control
implementation is invoked, whose semantics CONTROL-0 does not change.
Responses: 401 unauthenticated · 403 failed CSRF/authorization/origin ·
429 rate-limited · 503 `CONTROL_AUTH_UNCONFIGURED`. If the auth subsystem
itself throws, the action is REFUSED (500 `CONTROL_AUTH_ERROR`) — never
executed first. Read-only observation never requires auth, and a broken
auth subsystem never crashes tape or sensors.

## CLEAR / RE-ARM

KILL/CAGE/VETO protect Serpent; CLEAR potentially restores permission.
CLEAR therefore requires, server-verified, IN ADDITION to session + CSRF:
the current `SERPENT_CONTROL_PASSWORD` entered again, AND the exact
confirmation phrase **`CLEAR SERPENT`**. Wrong password or wrong phrase:
CLEAR is refused, existing control state is untouched, safe audit metadata
is recorded, and the response never discloses which part was wrong. The
client modal is convenience; the server check is the authority.

## AUDIT

`data/state/control_auth_log.jsonl` (local/ephemeral until PERSIST-0
decides durability) records: auth success/failure/lockout, logout,
authorized control actions, refused control actions with reason category,
CLEAR attempted/authorized/refused — each with at most a short
non-reversible session tag (sha256 prefix). NEVER recorded: passwords,
CSRF tokens, cookies, full session ids. Authorized control actions also
continue through the existing `controls_log.jsonl` conventions unchanged.

## AUTH STATE VISIBILITY

`CONTROL LOCKED` · `CONTROL AUTHENTICATED` · `CONTROL AUTH UNCONFIGURED` —
control-auth states only, shown as a subtle chip. Authentication NEVER
implies Serpent is armed to trade; nothing here touches posture, risk, or
STRIKE permissions.

## RESPONSES & CACHING

All API responses carry `Cache-Control: no-store` (site-wide already, auth
included). No broader CSP redesign in CONTROL-0; UI-1 owns future browser
polish.

## TESTING ENVIRONMENT NOTE (Replit)

The embedded Replit Preview pane can run the app in an iframe context
where SameSite=Strict cookies are intentionally not sent. That is the
cookie doing its job, not an application defect — the cookie is NEVER
weakened (no SameSite=None) to make the embedded pane convenient.
Authenticated control behavior is smoke-tested in the Preview opened in
its OWN top-level browser tab; the embedded pane remains fine for
read-only inspection.
