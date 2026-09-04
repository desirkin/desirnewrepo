// The cobra's tongue, wide: continuous market taste for every liquid
// USD-quoted Kraken pair, selected daily by the liquidity floor. Majors keep
// deep books (engine-grade); minors run shallow. One pair going quiet marks
// itself STALE/UNAVAILABLE and never blocks the rest of the tape; the
// engine's NO TRADE — DATA INTEGRITY stays tied to the connection and the
// majors, which are the only pairs the engine may ever trade.
import { loadConfig, coinFromSymbol } from '../lib/config.js';
import { nowIso, sessionDate } from '../lib/time.js';
import { OrderBook, decimalsOf } from './book.js';
import { TradeFlow, bookFeatures } from './features.js';
import { classifyTape, PAIR_STATES } from './health.js';
import { selectUniverse } from './universe.js';
import {
  TAPE_STATES,
  writeTrade,
  writeSnapshot,
  writeEvent,
  writeCurrentBook,
  writeTapeStatus,
} from './store.js';
import {
  MicrostructureTracker,
  readStalkingCoins,
  writeMicroObservation,
  MICRO_LIMITS,
} from './microstructure.js';

export async function runTape({ minutes = null, chaosAfterSec = null, log = console.log } = {}) {
  const config = loadConfig();
  const xp = config.universeExpansion ?? {};
  const staleMs = config.tape.staleFeedSec * 1000;
  const snapIntervalSec = config.tape.snapshotIntervalSec;
  const minorEvery = Math.max(1, Math.round((xp.minorsSnapshotIntervalSec ?? 30) / snapIntervalSec));
  const batchSize = xp.subscribeBatchSize ?? 50;

  // ---- universe (selected now, refreshed at ET session reset, never intraday)
  let universeDate = sessionDate();
  const pairs = new Map(); // symbol -> {coin, symbol, major, depth, usdVol24h}
  const books = new Map(); // symbol -> OrderBook
  const flows = new Map(); // symbol -> TradeFlow
  const lastMsgMs = {}; // symbol -> ms
  const unavailable = new Set(); // subscribe-failed or shed symbols
  const subFailures = new Map(); // symbol -> attempt count
  let lastAnyMsgMs = null;

  // MICRO-1: the dark microstructure sense. OBSERVES ONLY — nothing here
  // may influence posture, stalking, controls, ledger or eligibility. Every
  // call is failure-isolated: a tracker fault degrades MICRO, never tape.
  const micro = new MicrostructureTracker({ bookStaleMs: staleMs, log });
  let microEmitsThisMinute = 0;
  let microMinuteStart = Date.now();
  let microLastErrLogMs = 0;
  const microGuard = (fn) => {
    try {
      fn();
    } catch (err) {
      if (Date.now() - microLastErrLogMs > 60_000) {
        microLastErrLogMs = Date.now();
        log(`[${nowIso()}] MICRO degraded (tape unaffected): ${err.message}`);
      }
    }
  };

  function adoptPair(p) {
    pairs.set(p.symbol, p);
    books.set(p.symbol, new OrderBook(p.symbol, p.depth));
    flows.set(p.symbol, new TradeFlow());
    lastMsgMs[p.symbol] = null;
  }

  function dropPair(symbol) {
    pairs.delete(symbol);
    books.delete(symbol);
    flows.delete(symbol);
    delete lastMsgMs[symbol];
    unavailable.delete(symbol);
    subFailures.delete(symbol);
  }

  async function loadUniverse(reason) {
    const selection = await selectUniverse(config);
    const incoming = new Map(selection.pairs.map((p) => [p.symbol, p]));
    const added = [];
    const removed = [];
    for (const symbol of pairs.keys()) {
      if (!incoming.has(symbol)) removed.push(symbol);
    }
    for (const [symbol, p] of incoming) {
      if (!pairs.has(symbol)) added.push(p);
    }
    for (const s of removed) {
      unsubscribePair(s);
      dropPair(s);
    }
    for (const p of added) adoptPair(p);
    writeEvent('UNIVERSE_SELECTED', {
      reason,
      date: selection.date,
      source: selection.source,
      count: pairs.size,
      floorUsd: xp.minUsdVolume24h ?? null,
    });
    log(`[${nowIso()}] universe (${reason}): ${pairs.size} pairs via ${selection.source}`);
    log(`  ${[...pairs.values()].map((p) => p.coin + (p.major ? '*' : '')).join(' ')}`);
    return { added, removed };
  }

  // ---- websocket
  let ws = null;
  let tapeState = TAPE_STATES.OFFLINE;
  let reconnectDelayMs = 1000;
  let reconnectBlockedUntil = 0;
  let stopping = false;
  let lastErrorLogMs = 0;

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function batches(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function subscribeSymbols(symbolList) {
    if (!symbolList.length) return;
    for (const b of batches(symbolList, batchSize)) {
      send({ method: 'subscribe', params: { channel: 'ticker', symbol: b } });
      send({ method: 'subscribe', params: { channel: 'trade', symbol: b } });
    }
    // book subscriptions are grouped by depth (depth is a subscription param)
    const byDepth = new Map();
    for (const s of symbolList) {
      const p = pairs.get(s);
      if (!p) continue;
      if (!byDepth.has(p.depth)) byDepth.set(p.depth, []);
      byDepth.get(p.depth).push(s);
    }
    for (const [depth, syms] of byDepth) {
      for (const b of batches(syms, batchSize)) {
        send({ method: 'subscribe', params: { channel: 'book', symbol: b, depth, snapshot: true } });
      }
    }
  }

  function unsubscribePair(symbol) {
    const p = pairs.get(symbol);
    if (!p) return;
    send({ method: 'unsubscribe', params: { channel: 'ticker', symbol: [symbol] } });
    send({ method: 'unsubscribe', params: { channel: 'trade', symbol: [symbol] } });
    send({ method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: p.depth } });
  }

  function subscribeAll() {
    send({ method: 'subscribe', params: { channel: 'instrument' } });
    subscribeSymbols([...pairs.keys()].filter((s) => !unavailable.has(s)));
  }

  function onSubscribeFailure(symbol, channel, error) {
    const attempts = (subFailures.get(symbol) ?? 0) + 1;
    subFailures.set(symbol, attempts);
    writeEvent('SUBSCRIBE_FAILED', { symbol, channel, error, attempts });
    if (attempts >= 3) {
      unavailable.add(symbol);
      writeEvent('PAIR_UNAVAILABLE', { symbol, reason: `subscribe failed ${attempts}x: ${error}` });
      log(`[${nowIso()}] ${symbol} UNAVAILABLE after ${attempts} subscribe failures — no invented data`);
      return;
    }
    const delay = 5000 * 3 ** (attempts - 1); // 5s / 15s / 45s
    setTimeout(() => {
      if (!stopping && pairs.has(symbol) && !unavailable.has(symbol)) subscribeSymbols([symbol]);
    }, delay);
  }

  function resyncBook(symbol, reason) {
    const book = books.get(symbol);
    if (!book) return;
    book.desync();
    writeEvent('TAPE_INTEGRITY', { symbol, reason });
    log(`[${nowIso()}] TAPE_INTEGRITY ${symbol}: ${reason} — resyncing`);
    const p = pairs.get(symbol);
    send({ method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: p.depth } });
    send({ method: 'subscribe', params: { channel: 'book', symbol: [symbol], depth: p.depth, snapshot: true } });
  }

  function touch(symbol) {
    if (symbol in lastMsgMs) lastMsgMs[symbol] = Date.now();
  }

  function handleMessage(msg) {
    if (msg.method === 'subscribe' && msg.success === false) {
      const symbol = msg.result?.symbol ?? msg.symbol ?? null;
      if (symbol) onSubscribeFailure(symbol, msg.result?.channel ?? '?', msg.error ?? 'unknown');
      else writeEvent('SUBSCRIBE_FAILED', { result: msg });
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
          const flow = flows.get(t.symbol);
          if (!flow) continue;
          flow.add({ ts: Date.parse(t.timestamp), side: t.side, qty: t.qty, price: t.price });
          // MICRO-1: direct Kraken taker side, verbatim — never re-inferred
          microGuard(() => micro.onTrade(t.symbol, { ts: Date.parse(t.timestamp), side: t.side, qty: t.qty, price: t.price }));
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
            if (!book.synced) continue;
            const check = book.applyUpdate(d);
            if (check.ok === false) {
              resyncBook(d.symbol, `checksum mismatch (computed=${check.computed} expected=${check.expected})`);
              continue;
            }
          }
          // MICRO-1: sample the applied book (rate-limited inside; local clock)
          microGuard(() => micro.onBook(d.symbol, book));
        }
        break;
      }
      default:
        break; // heartbeat / status / acks
    }
  }

  function onMessage(raw) {
    lastAnyMsgMs = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      handleMessage(msg);
    } catch (err) {
      // Never crash the tape on one bad message — log (rate-limited) and keep
      // tasting. The event write itself may fail on a broken disk; that must
      // not take the socket handler down either.
      if (Date.now() - lastErrorLogMs > 60_000) {
        lastErrorLogMs = Date.now();
        try {
          writeEvent('TAPE_ERROR', { error: err.message, channel: msg?.channel ?? null });
        } catch {
          // disk refused the log — the console line below is the record
        }
        log(`[${nowIso()}] tape error (non-fatal, ${err.constructor.name}): ${err.message}`);
      }
    }
  }

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
  }

  function publishStatus(health) {
    writeTapeStatus({
      state: tapeState,
      staleFeedSec: config.tape.staleFeedSec,
      universe: { date: universeDate, ...health.counts },
      coins: Object.fromEntries(
        [...pairs.values()].map((p) => [
          p.coin,
          {
            lastMsgMs: lastMsgMs[p.symbol],
            synced: books.get(p.symbol)?.synced ?? false,
            state: health.pairStates[p.symbol],
            major: p.major,
          },
        ])
      ),
    });
  }

  // ---- heartbeat: connection + per-pair health, daily universe refresh
  let refreshing = false;
  const heartbeatTimer = setInterval(() => {
    const health = classifyTape({
      pairs: [...pairs.values()],
      lastMsgMs,
      unavailable,
      lastAnyMsgMs,
      now: Date.now(),
      staleMs,
    });
    if (health.anyData) {
      if (health.state === 'DEGRADED') {
        setTapeState(TAPE_STATES.DEGRADED, {
          connectionDead: health.connectionDead,
          staleMajors: health.staleMajors,
        });
      } else {
        setTapeState(TAPE_STATES.LIVE);
      }
    }
    publishStatus(health);

    // MICRO-1 tracking bound: ACTIVE STALKING ∩ SUBSCRIBED ∩ SYNCED — all
    // three or nothing. Not a UI attention set; fallback majors on screen
    // are never MICRO targets. Grace/discard handled inside the tracker.
    microGuard(() => {
      const stalkCoins = readStalkingCoins();
      const eligible = new Set();
      for (const p of pairs.values()) {
        if (!stalkCoins.has(p.coin)) continue;
        if (unavailable.has(p.symbol)) continue; // not subscribed
        if (!books.get(p.symbol)?.synced) continue; // not synchronized
        eligible.add(p.symbol);
      }
      micro.setTrackingSet(eligible);
    });

    const today = sessionDate();
    if (today !== universeDate && !refreshing && !stopping) {
      refreshing = true;
      universeDate = today;
      loadUniverse('ET session reset')
        .then(({ added }) => {
          if (ws?.readyState === WebSocket.OPEN) subscribeSymbols(added.map((p) => p.symbol));
        })
        .catch((err) => writeEvent('UNIVERSE_REFRESH_FAILED', { error: err.message }))
        .finally(() => {
          refreshing = false;
        });
    }
  }, 1000);

  // ---- snapshots: majors every tick, minors on a slower cadence
  let snapTick = 0;
  const snapshotTimer = setInterval(() => {
    snapTick++;
    for (const p of pairs.values()) {
      if (!p.major && snapTick % minorEvery !== 0) continue;
      const book = books.get(p.symbol);
      if (!book?.synced) continue;
      const bf = bookFeatures(book);
      if (!bf) continue;
      writeSnapshot({ ts: nowIso(), coin: p.coin, tapeState, ...bf, ...flows.get(p.symbol).features() });
      writeCurrentBook(p.coin, book);
    }
  }, snapIntervalSec * 1000);

  // ---- MICRO-1 emission: one observation per tracked symbol per ~5s,
  // hard-capped per minute. A write failure degrades MICRO, never tape.
  const microTimer = setInterval(() => {
    microGuard(() => {
      const now = Date.now();
      if (now - microMinuteStart >= 60_000) {
        microMinuteStart = now;
        microEmitsThisMinute = 0;
      }
      for (const symbol of micro.tracked()) {
        if (microEmitsThisMinute >= MICRO_LIMITS.maxObservationsPerMinute) break; // documented hard cap
        const p = pairs.get(symbol);
        const book = books.get(symbol);
        if (!p || !book?.synced) continue;
        const obs = micro.observe(symbol, book, p.coin, now);
        if (obs) {
          writeMicroObservation(obs);
          microEmitsThisMinute++;
        }
      }
    });
  }, MICRO_LIMITS.emitIntervalMs);

  // ---- resource safety: shed lowest-volume minors before ever falling over
  let lastResourceCheck = Date.now();
  const resourceTimer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - lastResourceCheck - 15_000;
    lastResourceCheck = now;
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    const limits = xp.resource ?? {};
    if (heapMb > (limits.maxHeapMb ?? 512) || lagMs > (limits.maxLoopLagMs ?? 1000)) {
      const sheddable = [...pairs.values()]
        .filter((p) => !p.major && !unavailable.has(p.symbol))
        .sort((a, b) => (a.usdVol24h ?? 0) - (b.usdVol24h ?? 0));
      const count = Math.max(1, Math.ceil(sheddable.length * (limits.shedFraction ?? 0.15)));
      const shed = sheddable.slice(0, count);
      writeEvent('RESOURCE_WARNING', {
        heapMb: Math.round(heapMb),
        loopLagMs: Math.round(lagMs),
        shedding: shed.map((p) => p.symbol),
      });
      log(`[${nowIso()}] RESOURCE_WARNING heap=${heapMb.toFixed(0)}MB lag=${lagMs.toFixed(0)}ms — shedding ${shed.length} lowest-volume pairs: ${shed.map((p) => p.coin).join(' ')}`);
      for (const p of shed) {
        unsubscribePair(p.symbol);
        unavailable.add(p.symbol);
        writeEvent('PAIR_UNAVAILABLE', { symbol: p.symbol, reason: 'shed under resource pressure' });
      }
    }
  }, 15_000);

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
    ws.onerror = () => {};
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

  let chaosTimer = null;
  if (chaosAfterSec !== null) {
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
      clearInterval(resourceTimer);
      clearInterval(microTimer);
      if (chaosTimer) clearTimeout(chaosTimer);
      if (durationTimer) clearTimeout(durationTimer);
      setTapeState(TAPE_STATES.OFFLINE, { reason });
      writeTapeStatus({ state: TAPE_STATES.OFFLINE, staleFeedSec: config.tape.staleFeedSec, coins: {} });
      writeEvent('TAPE_STOPPED', { reason });
      if (ws) ws.close();
      resolve(reason);
    };
    if (minutes !== null) durationTimer = setTimeout(() => stop(`duration ${minutes}m elapsed`), minutes * 60_000);
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  await loadUniverse('startup');
  writeEvent('TAPE_STARTED', { pairs: pairs.size, minutes, chaosAfterSec });
  log(`[${nowIso()}] tape starting: ${pairs.size} pairs (majors at depth ${xp.majorsDepth ?? config.tape.bookDepth}, minors at ${xp.defaultDepth ?? 25})`);
  connect();
  return done;
}
