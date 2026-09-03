// COBRA spaceship shell — local HTTP server. Zero dependencies.
// Serves the cockpit page and two read-only JSON endpoints. Nothing here can
// originate a trading decision, write a ledger row, or move the state machine
// anywhere the CLI couldn't; /api/status syncs posture exactly like `cobra
// status` does. Real data only: every number is read from disk or refused.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { sessionDate } from '../lib/time.js';
import { getEngineState } from '../state/machine.js';
import { readCurrentBook, readTapeStatus, TAPE_STATES } from '../tape/store.js';
import { bookFeatures } from '../tape/features.js';
import { openPositions, allPredictions, allFills } from '../ledger/ledger.js';
import { ledgerSummary } from '../ledger/summary.js';
import { kill, cage, veto, clearLatches, isVetoed, readControls } from '../state/controls.js';
import { existsSync, readFileSync as readFs } from 'node:fs';
import { dataDir } from '../lib/config.js';
import { appendJsonl } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';
import { ControlAuth, gateControl, parseCookies, cookieSecure, SESSION_LIFETIME_MS } from './auth.js';
import { getPersistence } from '../persistence/runtime.js';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

// CONTROL-0: server-side authority for every control mutation. Audit
// events carry categories and non-reversible session tags — never a
// password, CSRF token, cookie, or full session id (doctrine/CONTROL.md).
const authLogFile = () => path.join(dataDir(), 'state', 'control_auth_log.jsonl');
const auth = new ControlAuth({
  audit: (event) => {
    try {
      appendJsonl(authLogFile(), { ts: nowIso(), ...event });
    } catch {
      // audit write failure never blocks the auth decision itself
    }
  },
});
console.log(auth.configured() ? 'CONTROL AUTH: CONFIGURED' : 'CONTROL AUTH: UNCONFIGURED — control mutations fail closed');

const SESSION_COOKIE = 'serpent_session';
// ONE cookie policy for creation AND deletion (CONTROL-0A): Secure is
// decided defensively (encrypted socket, https forwarded-proto, or any
// non-local Host), never by an unverified proxy header alone.
const setSessionCookie = (req, id, maxAgeSec) => {
  const secure = cookieSecure({
    encrypted: req.socket?.encrypted === true,
    forwardedProto: req.headers['x-forwarded-proto'],
    host: req.headers.host,
  })
    ? '; Secure'
    : '';
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure}`;
};

// Effective tape state, staleness included: a dead tape process leaves a
// frozen LIVE file behind, and frozen is not LIVE.
function tapeReport() {
  const status = readTapeStatus();
  if (!status) return { effective: 'ABSENT', ageSec: null, coins: {} };
  const ageSec = (Date.now() - status.tsMs) / 1000;
  const staleFeedSec = status.staleFeedSec ?? config.tape.staleFeedSec;
  let effective = status.state;
  if (status.state === TAPE_STATES.LIVE && ageSec > staleFeedSec * 2) effective = 'FROZEN';
  const coins = {};
  for (const [coin, c] of Object.entries(status.coins ?? {})) {
    coins[coin] = {
      synced: c.synced,
      state: c.state ?? null,
      major: c.major ?? true,
      ageSec: c.lastMsgMs ? (Date.now() - c.lastMsgMs) / 1000 : null,
    };
  }
  return { effective, ageSec, staleFeedSec, coins, universe: status.universe ?? null };
}

const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function sessionClock() {
  const parts = Object.fromEntries(ET_CLOCK.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24;
  const secondsIntoDay = h * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return {
    etDate: sessionDate(),
    etTime: `${String(h).padStart(2, '0')}:${parts.minute}`,
    dayFraction: secondsIntoDay / 86400,
  };
}

// Predictions persisted but not yet entered: the only trades VETO can deny.
function pendingStrikes() {
  try {
    const filled = new Set(allFills().map((f) => f.prediction_id));
    return allPredictions()
      .filter((p) => !filled.has(p.prediction_id) && !isVetoed(p.prediction_id))
      .map((p) => ({ id: p.prediction_id, coin: p.coin, sizeUsd: p.size_usd }));
  } catch {
    return [];
  }
}

// RUMINT poller status (read-only passthrough of its atomic status file).
function rumintReport() {
  const file = path.join(dataDir(), 'rumint', 'status.json');
  if (!existsSync(file)) return { enabled: false };
  try {
    const s = JSON.parse(readFs(file, 'utf8'));
    return {
      enabled: s.enabled === true,
      symbolsPolled: s.symbolsPolled ?? 0,
      hourCount: s.hourCount ?? 0,
      backoff: Boolean(s.backoffUntil && s.backoffUntil > Date.now()),
      hyped: s.hyped ?? [],
      fresh: Date.now() - (s.tsMs ?? 0) < 30_000,
    };
  } catch {
    return { enabled: false };
  }
}

// Wide-eye survey status (read-only passthrough; notice-only tier).
function wideeyeReport() {
  const file = path.join(dataDir(), 'survey', 'status.json');
  if (!existsSync(file)) return { enabled: false };
  try {
    const s = JSON.parse(readFs(file, 'utf8'));
    return {
      enabled: s.enabled === true,
      scanned: s.scanned ?? 0,
      ripplesToday: s.ripplesToday ?? 0,
      fresh: Date.now() - (s.tsMs ?? 0) < 180_000,
    };
  } catch {
    return { enabled: false };
  }
}

function statusPayload() {
  const engine = getEngineState(); // syncs + logs posture transitions
  let open = 0;
  try {
    open = openPositions().length;
  } catch {
    // no ledger yet
  }
  return {
    posture: engine.state,
    retreatCauses: engine.retreatCauses.map((c) => ({ key: c.key, detail: c.detail })),
    advisories: engine.reasons.slice(engine.retreatCauses.length),
    locks: engine.locks
      ? {
          level: engine.locks.level,
          pnlPct: engine.locks.pnl_pct,
          simulated: engine.locks.simulated,
          thresholds: engine.locks.thresholds,
        }
      : null,
    tape: tapeReport(),
    session: sessionClock(),
    universe: config.universe,
    openPositions: open,
    pendingStrikes: pendingStrikes(),
    stalking: Object.keys(engine.stalking ?? {}),
    rumint: rumintReport(),
    wideeye: wideeyeReport(),
    controls: {
      kill: readControls().kill?.active ?? false,
      cage: readControls().cage?.active ?? false,
    },
    // CONTROL AUTH configuration state only — never implies armed-to-trade
    controlAuth: auth.configured() ? 'CONFIGURED' : 'UNCONFIGURED',
    // PERSIST-0: safe persistence-health summary only (no URLs, no secrets)
    persistence: (() => {
      const p = getPersistence();
      if (!p) return { status: 'UNAVAILABLE', permissionLock: false, databaseConfigured: false };
      const h = p.health();
      return { status: h.status, permissionLock: h.permissionLock, databaseConfigured: h.databaseConfigured };
    })(),
    paperFanged: true,
  };
}

// The three human controls (plus the human-only latch clear). Persisted
// atomically, every action appended to the control log with source 'ui'.
// This is the ONLY write path the server exposes, and it can only ever
// remove permission to trade — it cannot originate a strike.
function handleControl(body) {
  const action = String(body.action ?? '').toLowerCase();
  switch (action) {
    case 'kill':
      kill('ui');
      break;
    case 'cage':
      cage('ui');
      break;
    case 'veto': {
      const id = String(body.predictionId ?? '');
      if (!id) return { ok: false, error: 'veto requires predictionId' };
      veto(id, 'ui');
      break;
    }
    case 'clear':
      clearLatches('ui');
      break;
    default:
      return { ok: false, error: `unknown control action "${body.action}"` };
  }
  return { ok: true, action: action.toUpperCase(), status: statusPayload() };
}

function coinPayload(coin) {
  if (!config.universe.includes(coin)) return { available: false, reason: `UNAVAILABLE — ${coin} not in universe` };
  const tape = tapeReport();
  if (tape.effective !== TAPE_STATES.LIVE) {
    return { available: false, coin, reason: `UNAVAILABLE — NO TRADE (tape ${tape.effective})` };
  }
  const book = readCurrentBook(coin);
  if (!book || !book.synced) return { available: false, coin, reason: `UNAVAILABLE — no synced book` };
  const ageSec = (Date.now() - book.tsMs) / 1000;
  if (ageSec > config.cost.maxBookAgeSec) {
    return { available: false, coin, reason: `UNAVAILABLE — book stale ${ageSec.toFixed(1)}s` };
  }
  // Adapt the persisted plain-JSON book (already sorted) to bookFeatures.
  const f = bookFeatures({
    bestBid: () => book.bids[0] ?? null,
    bestAsk: () => book.asks[0] ?? null,
    sortedBids: () => book.bids,
    sortedAsks: () => book.asks,
  });
  if (!f) return { available: false, coin, reason: 'UNAVAILABLE — empty book' };
  return {
    available: true,
    coin,
    ageSec,
    bookTs: book.ts,
    mid: f.mid,
    bestBid: f.bestBid,
    bestAsk: f.bestAsk,
    spreadBps: f.spreadBps,
    depthUsd: f.depthUsd,
    levels: { bids: book.bids.length, asks: book.asks.length },
  };
}

function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}

function readBody(req, res, cb) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 4096) req.destroy(); // auth/control bodies are tiny
  });
  req.on('end', () => {
    try {
      cb(JSON.parse(raw || '{}'));
    } catch {
      json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- CONTROL-0 auth endpoints ----
    // LOGIN is the one deliberate CSRF exception: no session exists yet to
    // carry a token. It is protected by SameSite=Strict cookie scoping,
    // no permissive CORS, the password itself, and the failed-auth limiter.
    // Every OTHER mutation (logout and controls included) needs session+CSRF.
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      readBody(req, res, (body) => {
        const r = auth.login(body.password);
        if (!r.authenticated) {
          const code = r.reason === 'RATE_LIMITED' ? 429 : r.reason === 'CONTROL_AUTH_UNCONFIGURED' ? 503 : 401;
          json(res, code, { authenticated: false, reason: r.reason, ...(r.retryAfterSec ? { retryAfterSec: r.retryAfterSec } : {}) });
          return;
        }
        json(
          res,
          200,
          { authenticated: true, csrfToken: r.csrfToken, expiresAt: r.expiresAt },
          { 'set-cookie': setSessionCookie(req, r.sessionId, SESSION_LIFETIME_MS / 1000) }
        );
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const s = auth.status(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      json(res, 200, {
        ...s,
        controlAuth: !s.configured ? 'CONTROL_AUTH_UNCONFIGURED' : s.authenticated ? 'CONTROL_AUTHENTICATED' : 'CONTROL_LOCKED',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const r = auth.logout(parseCookies(req.headers.cookie)[SESSION_COOKIE], req.headers['x-serpent-csrf']);
      if (!r.ok) {
        json(res, r.code, { ok: false, reason: r.reason });
        return;
      }
      json(res, 200, { ok: true }, { 'set-cookie': setSessionCookie(req, '', 0) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      readBody(req, res, (body) => {
        // AUTHORIZE FIRST, fail closed — the control implementation is
        // never invoked before the gate answers (doctrine/CONTROL.md).
        const gate = gateControl(auth, {
          cookieHeader: req.headers.cookie,
          csrfHeader: req.headers['x-serpent-csrf'],
          originHeader: req.headers.origin,
          hostHeader: req.headers.host,
          body,
        });
        if (!gate.allow) {
          try {
            appendJsonl(authLogFile(), {
              ts: nowIso(),
              event: 'CONTROL_REFUSED',
              action: String(body.action ?? '').toUpperCase().slice(0, 16),
              reason: gate.reason,
            });
          } catch {
            // audit best-effort; the refusal stands regardless
          }
          json(res, gate.code, { ok: false, reason: gate.reason, ...(gate.retryAfterSec ? { retryAfterSec: gate.retryAfterSec } : {}) });
          return;
        }
        try {
          appendJsonl(authLogFile(), {
            ts: nowIso(),
            event: 'CONTROL_AUTHORIZED',
            action: String(body.action ?? '').toUpperCase().slice(0, 16),
            sessionTag: gate.sessionTag,
          });
        } catch {
          // audit best-effort
        }
        // secrets never travel past the gate: the control layer sees only
        // the action fields it always saw
        const { password, confirmPhrase, ...controlBody } = body;
        (async () => {
          const p = getPersistence();
          const action = String(controlBody.action ?? '').toLowerCase();
          // PERSIST-0 asymmetry: CLEAR is permission-INCREASING — the
          // durable transaction must succeed BEFORE the local latch drops.
          if (action === 'clear' && p) {
            const durable = await p.durableClearOrRefuse();
            if (!durable.allow) {
              json(res, 503, { ok: false, reason: durable.reason });
              return;
            }
          }
          const result = handleControl(controlBody);
          // permission-REDUCING actions applied locally above; persist the
          // snapshot durably now — a failure leaves the restriction active
          // and is reported through persistence health, never as fake success
          if (result.ok && p && action !== 'clear') {
            p.persistControlSnapshot(readControls()).catch(() => {});
          }
          json(res, result.ok ? 200 : 400, result);
        })().catch((err) => {
          console.error(`[api/control] ${err.constructor.name}: ${err.message}`);
          json(res, 500, { ok: false, reason: 'CONTROL_PERSISTENCE_ERROR' });
        });
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(path.join(UI_DIR, 'index.html')));
    } else if (url.pathname === '/api/status') {
      json(res, 200, statusPayload());
    } else if (url.pathname === '/api/ledger/summary') {
      // Read-only, computed from disk; an empty or missing ledger is a valid
      // empty-state summary, never an error. Real failures get logged with
      // their class and stack so the deployment logs name the truth.
      try {
        json(res, 200, ledgerSummary());
      } catch (err) {
        console.error(`[ledger/summary] ${err.constructor.name}: ${err.message}\n${err.stack}`);
        json(res, 500, { error: err.message, errorClass: err.constructor.name });
      }
    } else if (url.pathname.startsWith('/api/coin/')) {
      json(res, 200, coinPayload(url.pathname.split('/')[3]?.toUpperCase() ?? ''));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('COILED. Nothing here.');
    }
  } catch (err) {
    console.error(`[${url.pathname}] ${err.constructor.name}: ${err.message}\n${err.stack}`);
    json(res, 500, { error: err.message, errorClass: err.constructor.name });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`COBRA SHELL — http://localhost:${PORT}  (cockpit; controls can only remove permission to trade)`);
});

// Graceful shutdown: stop accepting connections; the tape (when co-running
// via fly.js) handles its own websocket close and final status write.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => server.close());
}

export { server }; // for endpoint tests; fly.js keeps the side-effect import
