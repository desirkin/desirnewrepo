// SOCIAL-1 / SOCIAL-2A — bounded social stream engine. Two pieces:
//   socialIntake   — PURE pipeline: raw message -> mapCommit -> normalize ->
//                    universe filter -> durable-aware dedupe -> bounded queue
//                    of cursor ENVELOPES, plus the received-vs-contiguous
//                    cursor ledger (§14/§18/§20).
//   startSocialStream — the WebSocket lifecycle: exact host allowlist, one
//                    connection, bounded reconnect with exponential backoff,
//                    heartbeat/stall detection, max message size, closed JSON
//                    parse, backpressure PAUSE (never a silent drop behind a
//                    cursor), clean shutdown. A socketFactory is injected so
//                    tests drive a fake socket — NO network. (§23)
//
// SOCIAL-2A CORE LAW: RECEIVED != DURABLE. This module never persists anything.
// It reports two cursors: `received` (diagnostic — the latest provider cursor
// seen on the wire) and `contiguous` (the highest provider cursor such that
// EVERY delivered frame at or below it reached an intentional terminal
// disposition: filtered / skipped / rejected / deduped / durably settled). Only
// the runtime, after a successful journal append under the current writer
// epoch, turns `contiguous` into the DURABLE resume cursor. A queue-full DROP
// is NOT terminal: it pins `contiguous` below the dropped frame until Jetstream
// replays it after the backpressure reconnect (§18/§19).
import { normalizeSocialObservation, socialFilterMatches } from './social.js';

export const DEFAULTS = Object.freeze({
  maxQueue: 5_000,
  seenCap: 20_000, // bounded recent-identity memory for at-least-once dedupe (NOT the keep-first authority)
  maxMessageBytes: 64 * 1024, // §23 reject oversized frames
  heartbeatMs: 20_000, // Jetstream keep-alive cadence
  stallMs: 40_000, // no message for this long => reconnect
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxReconnects: 0, // 0 = unbounded (bounded backoff still applies); tests set small
});

// ---- pure intake pipeline --------------------------------------------------
// isDurable(socialVersionId) -> boolean: the DURABLE version index (hydrated
// from the authoritative journal and maintained after every append). The
// process-local `seen` LRU is only a fast path; keep-first across restart and
// LRU eviction is owned by the durable index (§5/§6).
// cursorOf(message) -> provider cursor (Jetstream seq) or null.
export function socialIntake({
  provider, mapCommit, filter, now = () => Date.now(),
  maxQueue = DEFAULTS.maxQueue, seenCap = DEFAULTS.seenCap,
  cursorOf = null, isDurable = null,
} = {}) {
  const queue = []; // envelopes { providerCursor, observation }
  const seen = new Map(); // socialVersionId -> true (bounded, insertion-order LRU)
  const pending = new Map(); // providerCursor -> 'enqueued' | 'dropped' (non-terminal frames only)
  const cursor = { received: null, contiguous: null };
  const stats = {
    received: 0, enqueued: 0, deduped: 0, durableDeduped: 0, filtered: 0, skipped: 0, rejected: 0, corrupt: 0, dropped: 0, settled: 0,
    // SOURCE-CLOCK QUARANTINE SEAL (§25): observability counters over every
    // normalized observation (before the universe filter) — provider/client
    // clock quality during soaks; information only, never authority
    sourceClockTrusted: 0, sourceClockFutureQuarantined: 0, sourceClockUnknown: 0,
  };

  const remember = (id) => {
    seen.set(id, true);
    if (seen.size > seenCap) { const oldest = seen.keys().next().value; seen.delete(oldest); }
  };
  const minPending = () => { let m = null; for (const k of pending.keys()) if (m === null || k < m) m = k; return m; };
  // the contiguous cursor is MONOTONIC: it never regresses, even if a replayed
  // older frame re-enters pending (§24)
  const advance = () => {
    const mp = minPending();
    const candidate = mp === null ? cursor.received : mp - 1;
    if (candidate !== null && (cursor.contiguous === null || candidate > cursor.contiguous)) cursor.contiguous = candidate;
  };
  const terminal = (cur) => { if (cur !== null) pending.delete(cur); };

  // Offer ONE already-JSON-parsed message object. Returns the outcome so the
  // transport and tests can assert on it. Never throws on adversarial input.
  // An explicit `receivedTs` (the transport's receipt clock) lets a caller keep
  // evidence knownAt, the progress watermark, and any gap boundary on ONE clock.
  function offer(message, { receivedTs = null } = {}) {
    stats.received += 1;
    const nowMs = Number.isFinite(receivedTs) ? receivedTs : now();
    let cur = null;
    try { cur = typeof cursorOf === 'function' ? cursorOf(message) : null; } catch { cur = null; }
    if (cur !== null && (cursor.received === null || cur > cursor.received)) cursor.received = cur;
    const done = (outcome, extra = {}) => { terminal(cur); advance(); return { outcome, providerCursor: cur, ...extra }; };
    let mapped;
    try { mapped = mapCommit(message, { provider: provider?.id }); }
    catch { stats.skipped += 1; return done('skipped', { reason: 'mapper threw' }); }
    if (!mapped || mapped.skip) { stats.skipped += 1; return done('skipped', { reason: mapped?.reason ?? 'skip' }); }
    const norm = normalizeSocialObservation(mapped.raw, { nowMs });
    if (norm.reject) { stats.rejected += 1; return done('rejected', { reason: norm.reason }); }
    const o = norm.observation;
    if (o.sourceClockStatus === 'TRUSTED') stats.sourceClockTrusted += 1;
    else if (o.sourceClockStatus === 'FUTURE_QUARANTINED') stats.sourceClockFutureQuarantined += 1;
    else stats.sourceClockUnknown += 1;
    // bounded universe filter — no silent all-network intake (§24)
    const fm = socialFilterMatches(filter, { text: o.text, nativeAuthorId: o.nativeAuthorId });
    if (!fm.match) { stats.filtered += 1; return done('filtered'); }
    // KEEP-FIRST by VERSION identity (content facts only — a diagnostic-only
    // redelivery has the SAME id). The DURABLE index is authoritative: a version
    // already settled in the journal is a duplicate here whatever its current
    // handle/followers/engagement, so no altered payload can ever reach the
    // journal as a re-append (§4/§5). The local LRU is only the fast path.
    if (typeof isDurable === 'function' && isDurable(o.socialVersionId)) { stats.durableDeduped += 1; return done('deduped', { durable: true }); }
    if (seen.has(o.socialVersionId)) { stats.deduped += 1; return done('deduped'); }
    if (queue.length >= maxQueue) {
      // NOT terminal: the frame is pinned as pending so the contiguous cursor
      // can never pass it; the transport must PAUSE and replay it (§18/§19)
      stats.dropped += 1;
      if (cur !== null) pending.set(cur, 'dropped');
      advance();
      return { outcome: 'dropped', reason: 'queue full (backpressure)', providerCursor: cur };
    }
    remember(o.socialVersionId);
    if (cur !== null) pending.set(cur, 'enqueued');
    queue.push({ providerCursor: cur, observation: o });
    stats.enqueued += 1;
    advance();
    return { outcome: 'enqueued', observation: o, matchedBy: fm.reasons, providerCursor: cur };
  }

  return {
    offer,
    // drain up to n ENVELOPES for the durable writer to settle, in delivered
    // order. They stay PENDING (non-terminal) until settled() is called.
    drain(n = queue.length) { return queue.splice(0, Math.max(0, Math.min(n, queue.length))); },
    // the contiguous cursor IF these envelopes were terminal — pure projection,
    // used to build the cursor event BEFORE the append (§15)
    projectedCursor(envelopes) {
      const drop = new Set((envelopes ?? []).map((e) => e.providerCursor).filter((c) => c !== null));
      let m = null;
      for (const k of pending.keys()) if (!drop.has(k) && (m === null || k < m)) m = k;
      const candidate = m === null ? cursor.received : m - 1;
      if (candidate === null) return cursor.contiguous;
      return cursor.contiguous === null || candidate > cursor.contiguous ? candidate : cursor.contiguous;
    },
    // mark drained envelopes as DURABLY settled (or intentionally refused) —
    // the only way an enqueued frame becomes terminal
    settled(envelopes) {
      for (const e of envelopes ?? []) { terminal(e.providerCursor); stats.settled += 1; }
      advance();
    },
    // frames still owed a terminal disposition (enqueued or dropped)
    pendingCount() { return pending.size; },
    // SOCIAL-2B: knowledge clocks of the still-queued observations — the X
    // time-window progress law needs the oldest unsettled acquisition time
    _peekKnownAts() { return queue.map((e) => e.observation.knownAtTs); },
    hasDropped() { for (const v of pending.values()) if (v === 'dropped') return true; return false; },
    cursor() { return { ...cursor }; },
    // forget everything non-durable (writer loss / shutdown): frames are
    // redelivered from the durable cursor, never lost
    clear() { queue.length = 0; pending.clear(); },
    size() { return queue.length; },
    seenSize() { return seen.size; },
    stats() { return { ...stats, queued: queue.length, pending: pending.size, receivedCursor: cursor.received, contiguousCursor: cursor.contiguous }; },
  };
}

// ---- transport lifecycle ---------------------------------------------------
// socketFactory({ url, subprotocol }) must return an object with:
//   on(event, cb) for 'open'|'message'|'close'|'error' (message cb gets a
//   string or Buffer), close(), and (optional) ping(). This matches both the
//   `ws` package and a thin wrapper over the global WebSocket; tests inject a
//   controllable fake.
// resumeCursor() -> the DURABLE resume cursor (or null for live tail). When
// given, every (re)connect resumes from it — never from the receive-side
// cursor, which is diagnostic only (§14/§15).
export function startSocialStream({
  provider,
  intake,
  mode = 'LIVE',
  buildUrl, // ({ cursor }) => wss URL string
  socketFactory = null,
  fixtures = null, // REPLAY: array of raw message strings/objects
  now = () => Date.now(),
  log = () => {},
  resumeCursor = null,
  maxMessageBytes = DEFAULTS.maxMessageBytes,
  heartbeatMs = DEFAULTS.heartbeatMs,
  stallMs = DEFAULTS.stallMs,
  backoffBaseMs = DEFAULTS.backoffBaseMs,
  backoffMaxMs = DEFAULTS.backoffMaxMs,
  maxReconnects = DEFAULTS.maxReconnects,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const hosts = provider?.hosts ?? [];
  const state = {
    mode, connected: false, stopped: false, reconnects: 0, receivedCursor: null,
    lastMessageTs: null, lastEventTs: null, oversized: 0, badJson: 0, badHost: 0, connectErrors: 0, opens: 0,
    backpressureEvents: 0, paused: false,
    // CURSOR-RESUME LAW (§11): a connect attempted WITH a resume cursor that
    // fails before 'open' (e.g. the v2 endpoint refusing an old cursor —
    // CursorTooOld — as an HTTP 400 handshake failure) is recorded here and
    // the NEXT attempt still presents the SAME durable cursor. Never fall back
    // to an uncursored live tail, never drop the cursor, never skip the gap.
    // The global WebSocket API exposes no HTTP 400 body, so the XRPC error
    // name cannot be read here — the failure is surfaced structurally.
    cursorResumeFailures: 0, lastConnectCursor: null, lastCloseCode: null, lastCloseReason: null,
  };
  let socket = null;
  let stallTimer = null;

  const clearStall = () => { if (stallTimer) { clearTimeoutImpl(stallTimer); stallTimer = null; } };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeoutImpl(() => { if (!state.stopped) { log('social-stream: stall detected, reconnecting'); reconnect('stall'); } }, stallMs);
  };

  const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

  function handleRaw(data) {
    if (state.paused) return; // frames after a backpressure pause are replayed from the durable cursor
    state.lastMessageTs = now();
    armStall();
    const text = typeof data === 'string' ? data : (data && typeof data.toString === 'function' ? data.toString('utf8') : '');
    if (text.length > maxMessageBytes) { state.oversized += 1; return; } // §23 drop oversized, never parse
    let obj;
    try { obj = JSON.parse(text); } catch { state.badJson += 1; return; } // closed parse, drop malformed
    if (obj && typeof obj === 'object') {
      const seq = obj.payload?.seq ?? obj.seq ?? null;
      if (Number.isFinite(seq)) state.receivedCursor = seq; // DIAGNOSTIC receive-side cursor — never a resume watermark
      state.lastEventTs = now();
    }
    const r = intake.offer(obj);
    if (r?.outcome === 'dropped') {
      // BACKPRESSURE LAW (§19): never drop N and continue. Pause the ear so the
      // queued earlier work can settle; the reconnect resumes from the DURABLE
      // cursor and Jetstream replays the missed frame(s). Latency, not truth.
      state.backpressureEvents += 1;
      state.paused = true;
      log('social-stream: queue full — pausing stream; will resume from the durable cursor');
      reconnect('backpressure');
    }
  }

  function connect() {
    if (state.stopped) return;
    state.paused = false;
    if (mode === 'REPLAY') { replay(); return; }
    if (typeof socketFactory !== 'function') { log('social-stream: no socketFactory; cannot connect'); return; }
    const cursor = typeof resumeCursor === 'function' ? resumeCursor() : state.receivedCursor;
    state.lastConnectCursor = cursor ?? null;
    const url = buildUrl ? buildUrl({ cursor }) : null;
    const host = hostOf(url);
    if (!host || !hosts.includes(host)) { state.badHost += 1; log(`social-stream: refusing non-allowlisted host ${host}`); return; } // §23 exact host allowlist
    try {
      socket = socketFactory({ url, subprotocol: provider?.subprotocol ?? null });
    } catch (err) { state.connectErrors += 1; scheduleReconnect('connect-throw'); return; }
    const mine = socket;
    let opened = false;
    socket.on('open', () => { if (mine !== socket) return; opened = true; state.connected = true; state.opens += 1; armStall(); log('social-stream: open'); });
    socket.on('message', (data) => { if (mine === socket) handleRaw(data); });
    socket.on('error', () => { if (mine === socket) state.connectErrors += 1; });
    socket.on('close', (ev) => {
      if (mine !== socket) return;
      state.lastCloseCode = Number.isFinite(ev?.code) ? ev.code : null;
      state.lastCloseReason = typeof ev?.reason === 'string' && ev.reason.length > 0 ? ev.reason.slice(0, 200) : null;
      if (!opened && cursor !== null && cursor !== undefined) {
        // the handshake failed while presenting a resume cursor: fail closed —
        // the durable cursor is NOT advanced or dropped; the reconnect re-presents it
        state.cursorResumeFailures += 1;
        log(`social-stream: connect with resume cursor ${cursor} failed before open (${state.lastCloseReason ?? 'no reason exposed'}) — keeping the durable cursor, no live-tail fallback`);
      }
      state.connected = false; clearStall(); if (!state.stopped) scheduleReconnect('close');
    });
  }

  function replay() {
    // deterministic fixture replay — feed every message once, in order, then
    // hold (no reconnect). Cutover to LIVE is the caller's concern.
    for (const m of Array.isArray(fixtures) ? fixtures : []) {
      if (state.stopped || state.paused) return;
      handleRaw(typeof m === 'string' ? m : JSON.stringify(m));
    }
    clearStall();
  }

  function scheduleReconnect(why) {
    if (state.stopped) return;
    if (maxReconnects > 0 && state.reconnects >= maxReconnects) { log(`social-stream: max reconnects reached (${why})`); return; }
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(state.reconnects, 16));
    state.reconnects += 1;
    setTimeoutImpl(() => { if (!state.stopped) connect(); }, delay);
  }

  function reconnect(why) {
    const s = socket;
    socket = null; // detach first so the old socket's close handler is inert
    try { s?.close(); } catch { /* already closed */ }
    state.connected = false;
    clearStall();
    scheduleReconnect(why);
  }

  return {
    start() { connect(); return this; },
    stop() {
      state.stopped = true;
      clearStall();
      const s = socket;
      socket = null;
      try { s?.close(); } catch { /* noop */ }
      state.connected = false;
    },
    // test/diagnostic hook: feed one raw frame as if it arrived on the socket
    _feed(data) { handleRaw(data); },
    status() {
      return {
        provider: provider?.id ?? null, mode: state.mode, connected: state.connected, stopped: state.stopped, paused: state.paused,
        reconnects: state.reconnects, receivedCursor: state.receivedCursor,
        resumeCursor: typeof resumeCursor === 'function' ? resumeCursor() : null,
        lastMessageTs: state.lastMessageTs, lastEventTs: state.lastEventTs,
        oversized: state.oversized, badJson: state.badJson, badHost: state.badHost, connectErrors: state.connectErrors, opens: state.opens,
        backpressureEvents: state.backpressureEvents,
        cursorResumeFailures: state.cursorResumeFailures, lastConnectCursor: state.lastConnectCursor,
        lastCloseCode: state.lastCloseCode, lastCloseReason: state.lastCloseReason,
        intake: intake.stats(),
      };
    },
  };
}
