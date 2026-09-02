// The cobra's tongue: continuous market taste from Kraken WebSocket v2.
// Subscribes ticker + trades + L2 book for the coin universe, maintains live
// books with checksum validation, persists trades/snapshots/events, and
// forces NO TRADE — DATA INTEGRITY whenever the feed goes stale.
import { loadConfig, venueSymbol, coinFromSymbol } from '../lib/config.js';
import { nowIso } from '../lib/time.js';
import { OrderBook, decimalsOf } from './book.js';
import { TradeFlow, bookFeatures } from './features.js';
import {
  TAPE_STATES,
  writeTrade,
  writeSnapshot,
  writeEvent,
  writeCurrentBook,
  writeTapeStatus,
} from './store.js';

export function runTape({ minutes = null, chaosAfterSec = null, log = console.log } = {}) {
  const config = loadConfig();
  const symbols = config.universe.map((c) => venueSymbol(c, config));
  const books = new Map(symbols.map((s) => [s, new OrderBook(s, config.tape.bookDepth)]));
  const flows = new Map(symbols.map((s) => [s, new TradeFlow()]));
  const lastMsgMs = new Map(symbols.map((s) => [s, null]));

  let ws = null;
  let tapeState = TAPE_STATES.OFFLINE;
  let reconnectDelayMs = 1000;
  let reconnectBlockedUntil = 0; // chaos mode holds reconnection to prove DEGRADED fires
  let stopping = false;
  let chaosArmed = chaosAfterSec !== null;

  const staleMs = config.tape.staleFeedSec * 1000;

  function setTapeState(next, detail = {}) {
    if (next === tapeState) return;
    const prev = tapeState;
    tapeState = next;
    writeEvent('TAPE_STATE', { from: prev, to: next, ...detail });
    if (next === TAPE_STATES.DEGRADED) {
      writeEvent('ENGINE_FORCED', { reason: 'NO TRADE — DATA INTEGRITY' });
      log(`[${nowIso()}] TAPE ${next} — NO TRADE — DATA INTEGRITY`);
    } else {
      log(`[${nowIso()}] TAPE ${next}`);
    }
    publishStatus();
  }

  function publishStatus() {
    writeTapeStatus({
      state: tapeState,
      staleFeedSec: config.tape.staleFeedSec,
      coins: Object.fromEntries(
        symbols.map((s) => [
          coinFromSymbol(s),
          { lastMsgMs: lastMsgMs.get(s), synced: books.get(s).synced },
        ])
      ),
    });
  }

  function touch(symbol) {
    if (lastMsgMs.has(symbol)) lastMsgMs.set(symbol, Date.now());
  }

  function subscribeAll() {
    send({ method: 'subscribe', params: { channel: 'instrument' } });
    send({ method: 'subscribe', params: { channel: 'ticker', symbol: symbols } });
    send({ method: 'subscribe', params: { channel: 'trade', symbol: symbols } });
    send({
      method: 'subscribe',
      params: { channel: 'book', symbol: symbols, depth: config.tape.bookDepth, snapshot: true },
    });
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function resyncBook(symbol, reason) {
    const book = books.get(symbol);
    book.desync();
    writeEvent('TAPE_INTEGRITY', { symbol, reason });
    log(`[${nowIso()}] TAPE_INTEGRITY ${symbol}: ${reason} — resyncing`);
    send({ method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: config.tape.bookDepth } });
    send({
      method: 'subscribe',
      params: { channel: 'book', symbol: [symbol], depth: config.tape.bookDepth, snapshot: true },
    });
  }

  function onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method === 'subscribe' && msg.success === false) {
      writeEvent('SUBSCRIBE_FAILED', { result: msg });
      log(`[${nowIso()}] subscribe failed: ${JSON.stringify(msg)}`);
      return;
    }
    switch (msg.channel) {
      case 'instrument': {
        for (const pair of msg.data?.pairs ?? []) {
          const book = books.get(pair.symbol);
          if (!book) continue;
          const pricePrec = pair.price_precision ?? decimalsOf(pair.price_increment);
          const qtyPrec = pair.qty_precision ?? decimalsOf(pair.qty_increment);
          if (pricePrec !== null && qtyPrec !== null) book.setPrecision(pricePrec, qtyPrec);
        }
        break;
      }
      case 'ticker': {
        for (const t of msg.data ?? []) touch(t.symbol);
        break;
      }
      case 'trade': {
        for (const t of msg.data ?? []) {
          touch(t.symbol);
          if (!books.has(t.symbol)) continue;
          const ts = Date.parse(t.timestamp);
          flows.get(t.symbol).add({ ts, side: t.side, qty: t.qty, price: t.price });
          if (msg.type !== 'snapshot') {
            writeTrade({
              ts: t.timestamp,
              coin: coinFromSymbol(t.symbol),
              side: t.side,
              price: t.price,
              qty: t.qty,
              ordType: t.ord_type ?? null,
              tradeId: t.trade_id ?? null,
            });
          }
        }
        break;
      }
      case 'book': {
        for (const d of msg.data ?? []) {
          const book = books.get(d.symbol);
          if (!book) continue;
          touch(d.symbol);
          if (msg.type === 'snapshot') {
            book.applySnapshot(d);
          } else {
            if (!book.synced) continue; // ignore updates until a fresh snapshot arrives
            const check = book.applyUpdate(d);
            if (check.ok === false) {
              resyncBook(d.symbol, `checksum mismatch (computed=${check.computed} expected=${check.expected})`);
            }
          }
        }
        break;
      }
      default:
        break; // heartbeat / status / acks
    }
  }

  function connect() {
    if (stopping) return;
    ws = new WebSocket(config.tape.wsUrl);
    ws.onopen = () => {
      reconnectDelayMs = 1000;
      writeEvent('WS_CONNECTED', { url: config.tape.wsUrl });
      log(`[${nowIso()}] connected ${config.tape.wsUrl}`);
      subscribeAll();
    };
    ws.onmessage = (e) => onMessage(e.data);
    ws.onerror = () => {}; // close handler owns recovery
    ws.onclose = () => {
      if (stopping) return;
      for (const book of books.values()) book.desync();
      writeEvent('WS_DISCONNECTED', {});
      const holdMs = Math.max(0, reconnectBlockedUntil - Date.now());
      const delay = Math.max(reconnectDelayMs, holdMs);
      log(`[${nowIso()}] socket closed — reconnecting in ${(delay / 1000).toFixed(0)}s`);
      setTimeout(connect, delay);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    };
  }

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const stamps = symbols.map((s) => lastMsgMs.get(s));
    const anyData = stamps.some((t) => t !== null);
    const allFresh = stamps.every((t) => t !== null && now - t <= staleMs);
    if (allFresh) {
      setTapeState(TAPE_STATES.LIVE);
    } else if (anyData) {
      const staleCoins = symbols.filter((s) => {
        const t = lastMsgMs.get(s);
        return t === null || now - t > staleMs;
      });
      if (staleCoins.length) setTapeState(TAPE_STATES.DEGRADED, { staleCoins });
    }
    publishStatus();
  }, 1000);

  const snapshotTimer = setInterval(() => {
    for (const symbol of symbols) {
      const book = books.get(symbol);
      if (!book.synced) continue;
      const bf = bookFeatures(book);
      if (!bf) continue;
      writeSnapshot({
        ts: nowIso(),
        coin: coinFromSymbol(symbol),
        tapeState,
        ...bf,
        ...flows.get(symbol).features(),
      });
      writeCurrentBook(coinFromSymbol(symbol), book);
    }
  }, config.tape.snapshotIntervalSec * 1000);

  let chaosTimer = null;
  if (chaosArmed) {
    chaosTimer = setTimeout(() => {
      log(`[${nowIso()}] CHAOS DRILL — killing socket, holding reconnect ${config.tape.staleFeedSec + 5}s`);
      writeEvent('CHAOS_DRILL', { action: 'socket kill' });
      reconnectBlockedUntil = Date.now() + (config.tape.staleFeedSec + 5) * 1000;
      if (ws) ws.close();
    }, chaosAfterSec * 1000);
  }

  let durationTimer = null;
  const done = new Promise((resolve) => {
    const stop = (reason) => {
      if (stopping) return;
      stopping = true;
      clearInterval(heartbeatTimer);
      clearInterval(snapshotTimer);
      if (chaosTimer) clearTimeout(chaosTimer);
      if (durationTimer) clearTimeout(durationTimer);
      setTapeState(TAPE_STATES.OFFLINE, { reason });
      writeEvent('TAPE_STOPPED', { reason });
      if (ws) ws.close();
      resolve(reason);
    };
    if (minutes !== null) durationTimer = setTimeout(() => stop(`duration ${minutes}m elapsed`), minutes * 60_000);
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  writeEvent('TAPE_STARTED', { symbols, depth: config.tape.bookDepth, minutes, chaosAfterSec });
  log(`[${nowIso()}] tape starting: ${symbols.join(', ')} depth=${config.tape.bookDepth}`);
  connect();
  return done;
}
