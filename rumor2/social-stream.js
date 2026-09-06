// SOCIAL-1 — bounded social stream engine. Two pieces:
//   socialIntake   — PURE pipeline: raw message -> mapCommit -> normalize ->
//                    universe filter -> dedupe/corruption -> bounded queue.
//   startSocialStream — the WebSocket lifecycle: exact host allowlist, one
//                    connection, bounded reconnect with exponential backoff,
//                    heartbeat/stall detection, max message size, closed JSON
//                    parse, backpressure, clean shutdown. A socketFactory is
//                    injected so tests drive a fake socket — NO network. (§23)
//
// A high-volume firehose must never OOM Serpent: the queue is bounded and the
// stream applies backpressure (drops with a counter) rather than growing without
// limit. Nothing here has trade authority; it only produces evidence
// observations for the durable RUMOR event root to settle under the writer fence.
import { normalizeSocialObservation, socialFilterMatches } from './social.js';

export const DEFAULTS = Object.freeze({
  maxQueue: 5_000,
  seenCap: 20_000, // bounded recent-identity memory for at-least-once dedupe
  maxMessageBytes: 64 * 1024, // §23 reject oversized frames
  heartbeatMs: 20_000, // Jetstream keep-alive cadence
  stallMs: 40_000, // no message for this long => reconnect
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  maxReconnects: 0, // 0 = unbounded (bounded backoff still applies); tests set small
});

// ---- pure intake pipeline --------------------------------------------------
export function socialIntake({ provider, mapCommit, filter, now = () => Date.now(), maxQueue = DEFAULTS.maxQueue, seenCap = DEFAULTS.seenCap } = {}) {
  const queue = [];
  const seen = new Map(); // socialSourceId -> metaHash (bounded, insertion-order LRU)
  const stats = { received: 0, enqueued: 0, deduped: 0, filtered: 0, skipped: 0, rejected: 0, corrupt: 0, dropped: 0 };

  const remember = (id, metaHash) => {
    seen.set(id, metaHash);
    if (seen.size > seenCap) { const oldest = seen.keys().next().value; seen.delete(oldest); }
  };

  // Offer ONE already-JSON-parsed message object. Returns the outcome so the
  // transport and tests can assert on it. Never throws on adversarial input.
  function offer(message) {
    stats.received += 1;
    let mapped;
    try { mapped = mapCommit(message, { provider: provider?.id }); }
    catch { stats.skipped += 1; return { outcome: 'skipped', reason: 'mapper threw' }; }
    if (!mapped || mapped.skip) { stats.skipped += 1; return { outcome: 'skipped', reason: mapped?.reason ?? 'skip' }; }
    const norm = normalizeSocialObservation(mapped.raw, { nowMs: now() });
    if (norm.reject) { stats.rejected += 1; return { outcome: 'rejected', reason: norm.reason }; }
    const o = norm.observation;
    // bounded universe filter — no silent all-network intake (§24)
    const fm = socialFilterMatches(filter, { text: o.text, nativeAuthorId: o.nativeAuthorId });
    if (!fm.match) { stats.filtered += 1; return { outcome: 'filtered' }; }
    // dedupe by VERSION identity: the same version re-delivered collapses to
    // one truth; a legitimate EDIT is a new version (new id) and is admitted; an
    // altered re-delivery of the SAME version (same id, different metaHash) is
    // CORRUPTION, never silently accepted (§10/§19/§22/§41).
    if (seen.has(o.socialVersionId)) {
      if (seen.get(o.socialVersionId) !== o.metaHash) { stats.corrupt += 1; return { outcome: 'corrupt', reason: 'same version, altered payload' }; }
      stats.deduped += 1; return { outcome: 'deduped' };
    }
    if (queue.length >= maxQueue) { stats.dropped += 1; return { outcome: 'dropped', reason: 'queue full (backpressure)' }; }
    remember(o.socialVersionId, o.metaHash);
    queue.push(o);
    stats.enqueued += 1;
    return { outcome: 'enqueued', observation: o, matchedBy: fm.reasons };
  }

  return {
    offer,
    // drain up to n observations for the durable writer to settle
    drain(n = queue.length) { return queue.splice(0, Math.max(0, Math.min(n, queue.length))); },
    size() { return queue.length; },
    seenSize() { return seen.size; },
    stats() { return { ...stats, queued: queue.length }; },
  };
}

// ---- transport lifecycle ---------------------------------------------------
// socketFactory({ url, subprotocol }) must return an object with:
//   on(event, cb) for 'open'|'message'|'close'|'error' (message cb gets a
//   string or Buffer), close(), and (optional) ping(). This matches both the
//   `ws` package and a thin wrapper over the global WebSocket; tests inject a
//   controllable fake.
export function startSocialStream({
  provider,
  intake,
  mode = 'LIVE',
  buildUrl, // ({ cursor }) => wss URL string
  socketFactory = null,
  fixtures = null, // REPLAY: array of raw message strings/objects
  now = () => Date.now(),
  log = () => {},
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
    mode, connected: false, stopped: false, reconnects: 0, cursor: null,
    lastMessageTs: null, lastEventTs: null, oversized: 0, badJson: 0, badHost: 0, connectErrors: 0, opens: 0,
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
    state.lastMessageTs = now();
    armStall();
    const text = typeof data === 'string' ? data : (data && typeof data.toString === 'function' ? data.toString('utf8') : '');
    if (text.length > maxMessageBytes) { state.oversized += 1; return; } // §23 drop oversized, never parse
    let obj;
    try { obj = JSON.parse(text); } catch { state.badJson += 1; return; } // closed parse, drop malformed
    if (obj && typeof obj === 'object') {
      const seq = obj.payload?.seq ?? obj.seq ?? null;
      if (Number.isFinite(seq)) state.cursor = seq; // inclusive resume cursor (dedupe handles at-least-once)
      state.lastEventTs = now();
    }
    intake.offer(obj);
  }

  function connect() {
    if (state.stopped) return;
    if (mode === 'REPLAY') { replay(); return; }
    if (typeof socketFactory !== 'function') { log('social-stream: no socketFactory; cannot connect'); return; }
    const url = buildUrl ? buildUrl({ cursor: state.cursor }) : null;
    const host = hostOf(url);
    if (!host || !hosts.includes(host)) { state.badHost += 1; log(`social-stream: refusing non-allowlisted host ${host}`); return; } // §23 exact host allowlist
    try {
      socket = socketFactory({ url, subprotocol: provider?.subprotocol ?? null });
    } catch (err) { state.connectErrors += 1; scheduleReconnect('connect-throw'); return; }
    socket.on('open', () => { state.connected = true; state.opens += 1; armStall(); log('social-stream: open'); });
    socket.on('message', (data) => handleRaw(data));
    socket.on('error', () => { state.connectErrors += 1; });
    socket.on('close', () => { state.connected = false; clearStall(); if (!state.stopped) scheduleReconnect('close'); });
  }

  function replay() {
    // deterministic fixture replay — feed every message once, in order, then
    // hold (no reconnect). Cutover to LIVE is the caller's concern.
    for (const m of Array.isArray(fixtures) ? fixtures : []) {
      if (state.stopped) return;
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
    try { socket?.close(); } catch { /* already closed */ }
    socket = null;
    state.connected = false;
    scheduleReconnect(why);
  }

  return {
    start() { connect(); return this; },
    stop() {
      state.stopped = true;
      clearStall();
      try { socket?.close(); } catch { /* noop */ }
      socket = null;
      state.connected = false;
    },
    // test/diagnostic hook: feed one raw frame as if it arrived on the socket
    _feed(data) { handleRaw(data); },
    status() {
      return {
        provider: provider?.id ?? null, mode: state.mode, connected: state.connected, stopped: state.stopped,
        reconnects: state.reconnects, cursor: state.cursor, lastMessageTs: state.lastMessageTs, lastEventTs: state.lastEventTs,
        oversized: state.oversized, badJson: state.badJson, badHost: state.badHost, connectErrors: state.connectErrors, opens: state.opens,
        intake: intake.stats(),
      };
    },
  };
}
