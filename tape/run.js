// The cobra's tongue, wide: continuous market taste for every liquid
// USD-quoted Kraken pair, selected daily by the same liquidity rules. Broad
// catalog monitoring is separate from this bounded deep-book set. Named
// display seeds grant no special depth or seats. Only actual held/pending
// exposure receives protected resources; stale pairs cannot supply fresh data.
import { readLearnedRelooksToday } from '../learning/relook.js';
import { readVolatilityWatchNow } from '../learning/volatility-watch.js';
import { raceUniverseLoad, startupOutcomeLine, startupNeedsRetry, createUniverseRetry, createTapeDownWatchdog, STARTUP_UNIVERSE_DEADLINE_MS } from './startup.js';
import { loadConfig, coinFromSymbol, dataDir } from '../lib/config.js';
import { createResourceLaw } from './resource-law.js';
import { nowIso, sessionDate } from '../lib/time.js';
import { OrderBook, decimalsOf } from './book.js';
import { TradeFlow, bookFeatures } from './features.js';
import { classifyTape, PAIR_STATES, silentFeedDecision } from './health.js';
import { selectUniverse, readWideEyeNominationsToday, mergeCarriedIntoCurrentUniverse } from './universe.js';
import { planHotAdoption, HOT_LANE_DEFAULTS } from './hot-lane.js';
import {
  TAPE_STATES,
  writeTrade,
  writeSnapshot,
  writeEvent,
  writeCurrentBook,
  writeCurrentFeatureSnapshot,
  writeTapeStatus,
  stopTapeWrites,
} from './store.js';
import {
  MicrostructureTracker,
  readStalkingCoins,
  MICRO_LIMITS,
} from './microstructure.js';

// MARKET-LAB seam: an OPTIONAL observer receives copies of ACCEPTED trades and applied books (values only, plus the
// receipt clock). It is called after the tape has already written its own truth; an observer exception is counted and
// logged (bounded), never propagated — the tape's health, books, snapshots and features do not depend on it.
// EXECUTION-1 seam (ticket §4.2-4.3): an OPTIONAL execution feed receives the raw accepted socket text (exact lexemes) plus
// connect / disconnect epochs, may pin held / pending symbols (never shed, never dropped at the session refresh) and may ask
// for a bounded on-demand subscription of a symbol the tape already carries. It never mutates the tape's own books — with one
// declared exception: requestBookSnapshot, where the feed asks for the venue's book snapshot for a symbol it admitted AFTER
// the tape's subscription (the venue sends one snapshot per subscription, so a later admission has none). That is the
// documented resynchronisation path: the tape's own book desynchronises for the round trip and is re-established by the same
// venue snapshot. It never widens the venue, never raises depth and is rate-limited per symbol.
export const BOOK_SNAPSHOT_MIN_INTERVAL_MS = 15_000;
// pure: what a book-snapshot request may do right now, and the exact subscription messages it would send
export function bookSnapshotRequest({ symbol, pair, unavailable = false, socketOpen, lastRequestMs = null, nowMs, minIntervalMs = BOOK_SNAPSHOT_MIN_INTERVAL_MS }) {
  if (!pair) return { ok: false, reason: 'NOT_IN_TAPE_UNIVERSE' };
  if (unavailable) return { ok: false, reason: 'PAIR_UNAVAILABLE' };
  if (!socketOpen) return { ok: false, reason: 'SOCKET_NOT_OPEN' };
  if (lastRequestMs !== null && nowMs - lastRequestMs < minIntervalMs) return { ok: false, reason: 'RATE_LIMITED', retryAfterMs: minIntervalMs - (nowMs - lastRequestMs) };
  return { ok: true, requested: true, depth: pair.depth, messages: [
    { method: 'unsubscribe', params: { channel: 'book', symbol: [symbol], depth: pair.depth } },
    { method: 'subscribe', params: { channel: 'book', symbol: [symbol], depth: pair.depth, snapshot: true } },
  ] };
}
export async function runTape({ minutes = null, chaosAfterSec = null, log = console.log, executionFeed = null, observer = null } = {}) {
  const config = loadConfig();
  let observerErrors = 0; let feedErrors = 0;
  const feedGuard = (fn) => { if (!executionFeed) return; try { fn(); } catch (err) { feedErrors += 1; if (feedErrors <= 3) log(`execution feed error #${feedErrors} (ignored): ${err?.message ?? err}`); } };
  const pinnedSymbols = () => { try { return executionFeed ? executionFeed.pinned() : new Set(); } catch { return new Set(); } };
  const observe = (fn) => { if (!observer) return; try { fn(); } catch (err) { observerErrors += 1; if (observerErrors <= 3) log(`tape observer error #${observerErrors} (ignored): ${err?.message ?? err}`); } };
  const xp = config.universeExpansion ?? {};
  const staleMs = config.tape.staleFeedSec * 1000;
  const snapIntervalSec = config.tape.snapshotIntervalSec;
  const backgroundEvery = Math.max(1, Math.round((xp.minorsSnapshotIntervalSec ?? 30) / snapIntervalSec));
  const batchSize = xp.subscribeBatchSize ?? 50;

  // ---- universe (selected now, refreshed at ET session reset, never intraday)
  let universeDate = sessionDate();
  const pairs = new Map(); // symbol -> {coin, symbol, major, depth, usdVol24h}
  const books = new Map(); // symbol -> OrderBook
  const flows = new Map(); // symbol -> TradeFlow
  const lastMsgMs = {}; // symbol -> ms
  const unavailable = new Set(); // subscribe-failed or shed symbols
  const subFailures = new Map(); // symbol -> attempt count
  const subFailedUnavailable = new Set(); // PUBLISH-FIX-84: the subset of `unavailable` that a subscribe failure (not a resource shed) put there
  const bookSnapshotAsked = new Map(); // symbol -> clock of the last execution-feed book-snapshot request
  let lastAnyMsgMs = null;

  // MICRO-1: the dark microstructure sense. OBSERVES ONLY — nothing here
  // may influence posture, stalking, controls, ledger or eligibility. Every
  // call is failure-isolated: a tracker fault degrades MICRO, never tape.
  const micro = new MicrostructureTracker({ bookStaleMs: staleMs, log });
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
    resourceLaw.forget(symbol);
    pairs.delete(symbol);
    books.delete(symbol);
    flows.delete(symbol);
    delete lastMsgMs[symbol];
    unavailable.delete(symbol);
    subFailures.delete(symbol);
    bookSnapshotAsked.delete(symbol);
  }

  async function loadUniverse(reason) {
    const selection = await selectUniverse(config);
    if (selection.error) {
      // Retain already-observed subscriptions and protected exposure through a
      // catalog outage, but never adopt a guessed/fallback asset as fresh truth.
      writeEvent('UNIVERSE_REFRESH_FAILED', { reason, error: selection.error });
      return { added: [], removed: [], failed: true, error: selection.error };
    }
    const incoming = new Map(selection.pairs.map((p) => [p.symbol, p]));
    const added = [];
    const removed = [];
    const pinned = pinnedSymbols();
    for (const symbol of pairs.keys()) {
      if (!incoming.has(symbol) && !pinned.has(symbol)) removed.push(symbol); // a held / pending symbol is never dropped by a volume-rank refresh
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

  // ---- hot lane (PUBLISH-FIX-28): a WIDE EYE nominee joins the deep tape NOW, not next session -------------------------
  let hotSeen = new Set(); let hotLaneBusy = false; let hotLaneSkips = 0; const hotLane = { slots: xp.hotLane?.slots ?? HOT_LANE_DEFAULTS.slots, minHoldMs: xp.hotLane?.minHoldMs ?? HOT_LANE_DEFAULTS.minHoldMs }; // PUBLISH-FIX-96: a thrash guard, not a lease
  async function adoptHotNominations() {
    if (stopping || hotLaneBusy) return;
    // PUBLISH-FIX-54: the LEARNED RE-LOOK's coins ride the same hot lane and the same venue verification as the wide eye's
    // PUBLISH-FIX-66: the VOLATILITY WATCH's movers ride the same hot lane (the owner: volume and volatility, never BTC)
    // PUBLISH-FIX-96 (2026-09-21): the CURRENT full nomination set is passed to the planner (it applies `seen` itself) so it can
    // see which hot pairs are STILL nominated and release the ones that are not. Pre-filtering by `seen` here hid that from it.
    const nominations = [...readWideEyeNominationsToday(), ...readLearnedRelooksToday({ dataDir: dataDir() }), ...readVolatilityWatchNow({ dataDir: dataDir() })].filter((n) => n && typeof n.coin === 'string');
    const nominatedNow = new Set(nominations.map((n) => n.coin));
    // a hot pair no longer nominated must yield even when nothing new is waiting; that needs no venue verification, so it runs first
    const stale = [...pairs.values()].filter((p) => p.hot === true && !pinnedSymbols().has(p.symbol) && !nominatedNow.has(p.coin) && Date.now() - (p.hotSinceTs ?? 0) >= hotLane.minHoldMs);
    const freshNominees = nominations.filter((n) => !hotSeen.has(n.coin));
    if (!stale.length && !freshNominees.length) return;
    // review finding (PUBLISH-FIX-83 item 15): a nominee refused for a full lane is retried each minute now — but a full lane with no
    // tenure-eligible pair cannot adopt anything, so the venue verification (two REST fetches and a universe-record rewrite) is not run
    { const hotNow = [...pairs.values()].filter((p) => p.hot === true); const pinnedNow = pinnedSymbols(); const canYield = hotNow.some((p) => !pinnedNow.has(p.symbol) && Date.now() - (p.hotSinceTs ?? 0) >= hotLane.minHoldMs); const allCarried = freshNominees.every((n) => [...pairs.values()].some((p) => p.coin === n.coin)); if (!stale.length && hotNow.length >= hotLane.slots && !canYield && !allCarried) { hotLaneSkips += 1; return; } } // PUBLISH-FIX-96: a stale slot to release is always worth the pass
    hotLaneBusy = true;
    try {
      const selection = await selectUniverse(config); // the SAME venue verification as the daily selection (floor, status, exclusion, cap)
      if (selection.error) { writeEvent('HOT_LANE_VERIFY_FAILED', { error: selection.error, coins: nominations.map((n) => n.coin) }); return; }
      const plan = planHotAdoption({ nominations, carried: [...pairs.values()], verified: selection.verified ?? selection.pairs, pinned: pinnedSymbols(), seen: hotSeen, nowTs: Date.now(), slots: hotLane.slots, minHoldMs: hotLane.minHoldMs });
      hotSeen = plan.seen;
      for (const symbol of plan.evict) { const p = pairs.get(symbol); unsubscribePair(symbol); dropPair(symbol); writeEvent('PAIR_HOT_YIELDED', { symbol, hotForMs: Date.now() - (p?.hotSinceTs ?? Date.now()) }); log(`[${nowIso()}] HOT LANE: ${p?.coin ?? symbol} yields its hot slot after ${Math.round((Date.now() - (p?.hotSinceTs ?? Date.now())) / 60000)} min`); }
      for (const p of plan.adopt) {
        adoptPair(p); if (ws?.readyState === WebSocket.OPEN) subscribeSymbols([p.symbol]);
        writeEvent('PAIR_HOT_ADOPTED', { symbol: p.symbol, coin: p.coin, usdVol24h: p.usdVol24h ?? null, cause: p.cause, nominatedTs: p.nominatedTs });
        log(`[${nowIso()}] HOT LANE: ${p.coin} joins the deep tape now (${p.cause}; ${p.usdVol24h ? `$${(p.usdVol24h / 1e6).toFixed(1)}M 24h` : 'volume n/a'}; hot slots ${[...pairs.values()].filter((x) => x.hot).length}/${hotLane.slots}) — the Judge sees it on its next nomination pass`);
      }
      for (const r of plan.released ?? []) log(`[${nowIso()}] HOT LANE: ${r.coin} releases its hot slot — no longer among the movers (held ${Math.round(r.heldMs / 60000)} min)`); // PUBLISH-FIX-96
      for (const k of plan.skipped) { if (k.reason !== 'ALREADY_CARRIED' && k.retry !== true) log(`[${nowIso()}] HOT LANE: ${k.coin} not adopted (${k.reason})`); }
      { const m = mergeCarriedIntoCurrentUniverse([...pairs.values()].filter((x) => x.hot), { yielded: plan.evict }); if (!m.ok) log(`[${nowIso()}] HOT LANE: current-universe record not updated (${m.reason}); the Judge sees the newcomer at the next selection`); } // PUBLISH-FIX-83 item 15: yielded pairs leave the record; the carried hot pairs are re-merged after EVERY selection (selectUniverse rewrote the record without them — review finding)
    } catch (err) { log(`[${nowIso()}] HOT LANE degraded (tape unaffected): ${String(err?.message ?? err).slice(0, 160)}`); }
    finally { hotLaneBusy = false; }
  }
  // PUBLISH-FIX-102 (2026-09-21): the volatility watch writes its picks every 30 s; this lane adopted them every 60 s, so a coin that
  // started running could stand outside the deep tape for up to a minute while the Judge, nominated from the same picks, refused it
  // FEED_NOT_IN_TAPE_UNIVERSE (the top live refusal). Fifteen seconds closes the window to a quarter of what it was. The pass is cheap
  // when there is nothing to do: with no stale slot and no unseen nominee it returns above before any REST call or universe rewrite,
  // and `hotLaneBusy` still makes a slow pass skip rather than pile up.
  const hotLaneTimer = setInterval(() => { adoptHotNominations().catch(() => {}); }, 15_000);

  // ---- PUBLISH-FIX-52: startup universe deadline, retry, and the TAPE DOWN watchdog (tape/startup.js) ------------------
  let universeLoaded = false;
  async function loadUniverseOnce(reason) {
    const r = await loadUniverse(reason);
    if (r.added.length && ws?.readyState === WebSocket.OPEN) subscribeSymbols(r.added.map((p) => p.symbol).filter((s) => !unavailable.has(s)));
    if (!r.failed && pairs.size > 0) universeLoaded = true;
    return r;
  }
  const universeRetry = createUniverseRetry({ load: loadUniverseOnce, done: () => universeLoaded, stopped: () => stopping, log, nowIso });
  async function loadUniverseWithDeadline(reason) {
    log(`[${nowIso()}] TAPE STARTUP: loading the universe (${reason}; deadline ${STARTUP_UNIVERSE_DEADLINE_MS / 1000}s)`);
    const r = await raceUniverseLoad({ load: () => loadUniverseOnce(reason) });
    if (r.stalled) writeEvent('UNIVERSE_LOAD_STALLED', { reason, afterMs: STARTUP_UNIVERSE_DEADLINE_MS, carried: pairs.size });
    log(`[${nowIso()}] ${startupOutcomeLine(r, { reason, carried: pairs.size })}`);
    if (startupNeedsRetry(r)) universeRetry.start();
    return r;
  }
  const startupWatchdog = createTapeDownWatchdog({ isLive: () => tapeState === TAPE_STATES.LIVE, stopped: () => stopping, log, nowIso, snapshot: () => ({ state: tapeState, pairs: pairs.size, universeLoaded, socketState: ws ? (['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] ?? String(ws.readyState)) : 'none', lastMessageAgeMs: lastAnyMsgMs ? Date.now() - lastAnyMsgMs : null }) });

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
    // PUBLISH-FIX-84 (reviewer finding): a NEW connection gives every subscribe-failed pair another chance (a resource-SHED pair stays
    // out until the resource law re-admits it) — `unavailable` used to be a one-way door for the life of the process
    for (const symbol of [...unavailable]) { if (subFailedUnavailable.has(symbol)) { unavailable.delete(symbol); subFailedUnavailable.delete(symbol); subFailures.delete(symbol); writeEvent('PAIR_RETRIED_ON_RECONNECT', { symbol }); } }
    subscribeSymbols([...pairs.keys()].filter((s) => !unavailable.has(s)));
  }

  function onSubscribeFailure(symbol, channel, error) {
    const attempts = (subFailures.get(symbol) ?? 0) + 1;
    subFailures.set(symbol, attempts);
    writeEvent('SUBSCRIBE_FAILED', { symbol, channel, error, attempts });
    if (attempts >= 3) {
      unavailable.add(symbol); subFailedUnavailable.add(symbol);
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
    // PUBLISH-FIX-84 (reviewer finding): a subscribe ACK clears the pair's failure count — it accumulated over the process lifetime, so
    // the third transient refusal EVER (days apart, across reconnects) darkened a pair for good
    if (msg.method === 'subscribe' && msg.success === true) { const symbol = msg.result?.symbol ?? null; if (symbol && subFailures.has(symbol)) subFailures.delete(symbol); }
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
          observe(() => observer.onTrade({ coin: coinFromSymbol(t.symbol), symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, eventTs: Date.parse(t.timestamp), receivedTs: Date.now(), tradeId: t.trade_id ?? null, ordType: t.ord_type ?? null, snapshot: msg.type === 'snapshot' }));
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
          let checksumVerified = null;
          if (msg.type === 'snapshot') {
            book.applySnapshot(d);
          } else {
            if (!book.synced) continue;
            const check = book.applyUpdate(d);
            if (check.ok === false) {
              resyncBook(d.symbol, `checksum mismatch (computed=${check.computed} expected=${check.expected})`);
              continue;
            }
            checksumVerified = check.ok;
          }
          // MICRO-1: sample the applied book (rate-limited inside; local clock)
          microGuard(() => micro.onBook(d.symbol, book));
          observe(() => observer.onBook({ coin: coinFromSymbol(d.symbol), symbol: d.symbol, receivedTs: Date.now(), synced: book.synced, checksumVerified, pricePrecision: book.pricePrecision, qtyPrecision: book.qtyPrecision,
            levels: () => ({ bids: [...book.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 100).map(([price, qty]) => [price, qty]), asks: [...book.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 100).map(([price, qty]) => [price, qty]) }) }));
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
    feedGuard(() => executionFeed.ingest(raw, lastAnyMsgMs));
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
      requiredSymbols: pinnedSymbols(),
    });
    if (health.anyData) {
      if (health.state === 'DEGRADED') {
        setTapeState(TAPE_STATES.DEGRADED, {
          connectionDead: health.connectionDead,
          staleRequired: health.staleRequired,
        });
      } else {
        setTapeState(TAPE_STATES.LIVE);
      }
    }
    publishStatus(health);
    // PUBLISH-FIX-84 (reviewer finding, the owner's "it's not getting data"): a SILENT feed had no way back. The only path to a
    // reconnect was ws.onclose, which fires only when the peer completes the close handshake or TCP tears down — a half-open link
    // (NAT / balancer drop) stays "open" for ~12 minutes of kernel keep-alive, and a venue that keeps heart-beating while its
    // channels go quiet stays "open" forever: DEGRADED, every pair stale, the Judge blind, no recovery. Now: when no message at
    // all has arrived for 2x the stale bound, or messages arrive but NO pair is live for 2x the stale bound, the socket is torn
    // down without waiting for the peer (handlers detached first, so a late close cannot double-reconnect), books desync, the
    // execution feed sees a disconnect, and connect() runs on the normal back-off. At most once per SILENT_RECONNECT_COOLDOWN_MS.
    silentFeedLaw(health);

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

  // ---- snapshots: equal background cadence; held/pending exposure is faster
  let snapTick = 0;
  const snapshotTimer = setInterval(() => {
    snapTick++;
    const pinned = pinnedSymbols();
    for (const p of pairs.values()) {
      if (!pinned.has(p.symbol) && snapTick % backgroundEvery !== 0) continue;
      const book = books.get(p.symbol);
      if (!book?.synced) continue;
      const bf = bookFeatures(book);
      if (!bf) continue;
      // ONE captured owner clock per snapshot: the appended record, and the passive current
      // feature file (SOCIAL-5 §36.7 read-only bridge) carry the SAME computed object and instant
      const tsMs = Date.now();
      const snapshot = { ts: new Date(tsMs).toISOString(), coin: p.coin, tapeState, ...bf, ...flows.get(p.symbol).features(tsMs) };
      writeSnapshot(snapshot);
      writeCurrentBook(p.coin, book);
      writeCurrentFeatureSnapshot(p.coin, snapshot, { tsMs, session: sessionDate(new Date(tsMs)), symbol: p.symbol });
    }
  }, snapIntervalSec * 1000);

  // ---- MICRO-1A/1B evaluation tick: internal sensing stays fast; the
  // tracker decides what deserves PERMANENT memory (30s periodic baseline
  // + prompt latched transitions, capped at 36/min globally) and performs
  // the append ITSELF behind its acknowledgement boundary — counters and
  // clocks move only after a write truly lands. A write failure keeps the
  // record pending, degrades MICRO health only, and never blocks the
  // remaining symbols (evaluate never throws).
  const microTimer = setInterval(() => {
    microGuard(() => {
      for (const symbol of micro.tracked()) {
        const p = pairs.get(symbol);
        const book = books.get(symbol);
        if (!p || !book) continue;
        micro.evaluate(symbol, book, p.coin);
      }
      // MICRO-1C: symbols that left tracking still DRAIN their already-
      // prepared evidence (bounded) — leaving prey status never silently
      // discards what was observed
      micro.drain();
    });
  }, MICRO_LIMITS.evaluationIntervalMs);

  // ---- resource safety: lowest observed volume first; exposure is never shed. PUBLISH-FIX-27: the decision lives in
  // tape/resource-law.js — a lag breach must be sustained (two checks) before shedding, and a calm five minutes re-admits
  // one resource-shed pair (highest volume first); shed pairs no longer stay out for the whole session.
  const resourceLaw = createResourceLaw(xp.resource ?? {});
  let lastResourceCheck = Date.now();
  const resourceTimer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - lastResourceCheck - 15_000;
    lastResourceCheck = now;
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    const pinned = pinnedSymbols();
    const sheddable = [...pairs.values()].filter((p) => !unavailable.has(p.symbol) && !pinned.has(p.symbol)); // held / pending exposure is never shed; caps stay
    const d = resourceLaw.decide({ heapMb, lagMs, nowTs: now, sheddable: sheddable.map((p) => ({ symbol: p.symbol, coin: p.coin, usdVol24h: p.usdVol24h ?? 0 })) });
    if (d.action === 'SHED') {
      writeEvent('RESOURCE_WARNING', { heapMb: Math.round(heapMb), loopLagMs: Math.round(lagMs), reason: d.reason, shedding: d.shed.map((p) => p.symbol) });
      log(`[${nowIso()}] RESOURCE_WARNING heap=${heapMb.toFixed(0)}MB lag=${lagMs.toFixed(0)}ms (${d.reason}) — shedding ${d.shed.length} lowest-volume pairs: ${d.shed.map((p) => p.coin).join(' ')}`);
      for (const p of d.shed) {
        unsubscribePair(p.symbol);
        unavailable.add(p.symbol);
        writeEvent('PAIR_UNAVAILABLE', { symbol: p.symbol, reason: 'shed under resource pressure' });
      }
    } else if (d.action === 'READMIT') {
      if (!pairs.has(d.symbol)) { resourceLaw.forget(d.symbol); return; } // rotated out of the universe meanwhile: nothing to re-admit
      unavailable.delete(d.symbol); subFailures.delete(d.symbol);
      if (ws?.readyState === WebSocket.OPEN) subscribeSymbols([d.symbol]);
      writeEvent('PAIR_READMITTED', { symbol: d.symbol, heapMb: Math.round(heapMb), loopLagMs: Math.round(lagMs), shedForMs: d.shedForMs, remainingShed: d.remainingShed });
      log(`[${nowIso()}] RESOURCE CALM heap=${heapMb.toFixed(0)}MB lag=${lagMs.toFixed(0)}ms — re-admitting ${d.coin} after ${Math.round(d.shedForMs / 60000)} min shed (${d.remainingShed} still shed)`);
    } else if (d.reason === 'LAG_ONCE') {
      log(`[${nowIso()}] RESOURCE NOTE heap=${heapMb.toFixed(0)}MB lag=${lagMs.toFixed(0)}ms — one late check; shedding only if it repeats`);
    }
  }, 15_000);

  // PUBLISH-FIX-84: the silent-feed law (see the heartbeat).
  const SILENT_RECONNECT_COOLDOWN_MS = 30_000; let silentSinceMs = null; let lastSilentReconnectMs = 0; let silentReconnects = 0; let connectedAtMs = null;
  function silentFeedLaw(health, now = Date.now()) {
    if (stopping) return false;
    const d = silentFeedDecision({ health, now, wsOpen: Boolean(ws && ws.readyState === WebSocket.OPEN), connectedAtMs, silentSinceMs, lastSilentReconnectMs, staleMs, cooldownMs: SILENT_RECONNECT_COOLDOWN_MS });
    silentSinceMs = d.silentSinceMs; if (!d.act) return false;
    lastSilentReconnectMs = now; silentReconnects += 1;
    const why = d.reason === 'CONNECTION_DEAD' ? `no message for ${Math.round((now - (lastAnyMsgMs ?? now)) / 1000)}s` : `messages flow but no pair is live (${health.counts?.stale ?? '?'} stale)`;
    log(`[${nowIso()}] SILENT FEED — ${why}; tearing the socket down and reconnecting (${silentReconnects} so far)`);
    writeEvent('WS_SILENT_RECONNECT', { reason: d.reason, silentReconnects });
    const old = ws; ws = null; old.onclose = null; old.onmessage = null; old.onerror = () => {};
    try { old.close(); } catch { /* the peer may never answer; the handlers are detached */ }
    for (const book of books.values()) book.desync();
    feedGuard(() => executionFeed.onDisconnect(now));
    writeEvent('WS_DISCONNECTED', { forced: true });
    const delay = Math.max(reconnectDelayMs, Math.max(0, reconnectBlockedUntil - now));
    setTimeout(connect, delay);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    return true;
  }
  function connect() {
    if (stopping) return;
    ws = new WebSocket(config.tape.wsUrl);
    ws.onopen = () => {
      // PUBLISH-FIX-84 (reviewer finding): the back-off resets only once the connection has STAYED open (30 s) — a venue that accepts
      // and closes at once used to get a 1-second loop of full re-subscriptions (and a plausible IP ban)
      connectedAtMs = Date.now(); const openedAt = connectedAtMs; setTimeout(() => { if (ws && connectedAtMs === openedAt && ws.readyState === WebSocket.OPEN) reconnectDelayMs = 1000; }, 30_000).unref?.();
      writeEvent('WS_CONNECTED', { url: config.tape.wsUrl });
      log(`[${nowIso()}] connected ${config.tape.wsUrl}`);
      subscribeAll();
      feedGuard(() => executionFeed.onConnect(Date.now()));
    };
    ws.onmessage = (e) => onMessage(e.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (stopping) return;
      for (const book of books.values()) book.desync();
      feedGuard(() => executionFeed.onDisconnect(Date.now()));
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
      clearInterval(hotLaneTimer); universeRetry.stop(); startupWatchdog.stop();
      clearInterval(microTimer);
      if (chaosTimer) clearTimeout(chaosTimer);
      if (durationTimer) clearTimeout(durationTimer);
      setTapeState(TAPE_STATES.OFFLINE, { reason });
      writeTapeStatus({ state: TAPE_STATES.OFFLINE, staleFeedSec: config.tape.staleFeedSec, coins: {} });
      writeEvent('TAPE_STOPPED', { reason });
      stopTapeWrites(); // I/O LANE (Ticket B): drain any write-behind buffer so a clean stop loses nothing
      if (ws) ws.close();
      resolve(reason);
    };
    if (minutes !== null) durationTimer = setTimeout(() => stop(`duration ${minutes}m elapsed`), minutes * 60_000);
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  // PUBLISH-FIX-52 (2026-09-17): the startup universe load is raced against a deadline. Production b1ec3c6a booted with the
  // Judge, learning and the wide eye all live, but the tape never got past `await loadUniverse('startup')` — no
  // UNIVERSE_SELECTED / UNIVERSE_REFRESH_FAILED event, no 'tape starting', no socket — for 35 minutes, so the Judge saw 0
  // books while the same REST call answered in 289 ms from the workspace. The venue is never guessed: a stalled load is
  // logged and retried every 30 s (adopting and subscribing what it verifies), the socket connects for the pairs carried
  // (pinned exposure, hot-lane adoptions) meanwhile, and a TAPE DOWN line prints every minute until the tape is LIVE.
  await loadUniverseWithDeadline('startup');
  // bounded admission seam: the feed may ask for a symbol the tape already carries (or re-adopt a HELD symbol from its
  // recorded instrument identity); it cannot widen the venue, raise depth or lift resource caps
  feedGuard(() => executionFeed.bindTape({
    ensureSubscribed(symbol, entry) {
      if (pairs.has(symbol)) { if (unavailable.has(symbol) && (entry?.priority === 'HELD' || entry?.priority === 'PENDING')) { unavailable.delete(symbol); subFailures.delete(symbol); if (ws?.readyState === WebSocket.OPEN) subscribeSymbols([symbol]); } return { ok: true, carried: true }; }
      if (entry?.priority === 'HELD' || entry?.priority === 'PENDING') { adoptPair({ coin: coinFromSymbol(symbol), symbol, major: false, depth: entry.depth ?? xp.defaultDepth ?? 25, usdVol24h: null, pinned: true }); if (ws?.readyState === WebSocket.OPEN) subscribeSymbols([symbol]); writeEvent('PAIR_PINNED', { symbol, priority: entry.priority }); return { ok: true, adopted: true }; }
      return { ok: false, reason: 'NOT_IN_TAPE_UNIVERSE' };
    },
    // the venue answers a subscription with exactly one book snapshot: a symbol admitted after ours needs a real one
    requestBookSnapshot(symbol, reason = null) {
      const now = Date.now();
      const r = bookSnapshotRequest({ symbol, pair: pairs.get(symbol) ?? null, unavailable: unavailable.has(symbol), socketOpen: ws?.readyState === WebSocket.OPEN, lastRequestMs: bookSnapshotAsked.get(symbol) ?? null, nowMs: now });
      if (!r.ok) return r;
      bookSnapshotAsked.set(symbol, now);
      books.get(symbol)?.desync(); // the round trip loses updates: the tape's own book is not trusted until the snapshot lands
      writeEvent('BOOK_SNAPSHOT_REQUESTED', { symbol, depth: r.depth, reason: String(reason ?? '').slice(0, 120) });
      for (const m of r.messages) send(m);
      return { ok: true, requested: true, depth: r.depth };
    },
    depthOf: (symbol) => pairs.get(symbol)?.depth ?? null,
  }));
  writeEvent('TAPE_STARTED', { pairs: pairs.size, minutes, chaosAfterSec });
  log(`[${nowIso()}] tape starting: ${pairs.size} pairs (equal selected depth ${xp.defaultDepth ?? 25}; held/pending exposure protected)`);
  connect();
  startupWatchdog.arm();
  return done;
}
