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
import { openPositions } from '../ledger/ledger.js';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

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
      ageSec: c.lastMsgMs ? (Date.now() - c.lastMsgMs) / 1000 : null,
    };
  }
  return { effective, ageSec, staleFeedSec, coins };
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
    paperFanged: true,
  };
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

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(path.join(UI_DIR, 'index.html')));
    } else if (url.pathname === '/api/status') {
      json(res, 200, statusPayload());
    } else if (url.pathname.startsWith('/api/coin/')) {
      json(res, 200, coinPayload(url.pathname.split('/')[3]?.toUpperCase() ?? ''));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('COILED. Nothing here.');
    }
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`COBRA SHELL — http://localhost:${PORT}  (read-only cockpit; display may never cause trading)`);
});
