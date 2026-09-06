// SOCIAL-2B — the bounded X Filtered Stream HTTP transport (§20/§36-§38). X is
// an HTTP streaming endpoint (newline-delimited JSON Posts + blank CRLF
// keepalives), NOT a WebSocket — Bluesky's transport is never reused here.
//   * exact host allowlist (api.x.com), bearer ONLY in the Authorization header,
//     never logged (only HTTP status codes are);
//   * ONE connection at a time — never two during reconnect overlap (§38);
//   * incremental bounded line parser: max line bytes, malformed/oversized lines
//     are rejected safely and TAINT the connection so a reconnect with backfill
//     redelivers what could not be processed (continuity never skips owed data);
//   * keepalive law: blank line = alive, costs zero Post reads; no data/keepalive
//     for stallMs (20 s) => reconnect with bounded backoff, never a storm;
//   * every (re)connect asks the governor `shouldConnect()` first and takes the
//     backfill window from `backfillMinutesFor()` — the runtime owns recovery;
//   * 401/403 => AUTH_REJECTED (stop), 429 => long backoff, 420/connection-limit
//     => CONNECTION_LIMIT (stop boundedly), other non-200 => bounded reconnect;
//   * pause() (backpressure) aborts the read and schedules nothing — the runtime
//     resumes through the governor. No credential is stored beyond the closure.
import { X_OFFICIAL, assertXHost } from './providers/x-official.js';

export const X_STREAM_DEFAULTS = Object.freeze({
  maxLineBytes: 64 * 1024,
  stallMs: 20_000, // official guidance: no Post/keepalive for 20 s => reconnect
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  rateLimitBackoffMs: 60_000,
  maxReconnects: 0, // 0 = unbounded (bounded backoff still applies)
});

export function startXStream({
  provider = X_OFFICIAL,
  bearer,
  fetchImpl,
  buildUrl, // ({ backfillMinutes }) => url (must be an approved X host)
  backfillMinutesFor = () => 0,
  shouldConnect = () => ({ ok: true }),
  onLine = () => {}, // (obj, { receivedTs })
  onKeepalive = () => {},
  onOpen = () => {},
  onClose = () => {},
  now = () => Date.now(),
  log = () => {},
  maxLineBytes = X_STREAM_DEFAULTS.maxLineBytes,
  stallMs = X_STREAM_DEFAULTS.stallMs,
  backoffBaseMs = X_STREAM_DEFAULTS.backoffBaseMs,
  backoffMaxMs = X_STREAM_DEFAULTS.backoffMaxMs,
  rateLimitBackoffMs = X_STREAM_DEFAULTS.rateLimitBackoffMs,
  maxReconnects = X_STREAM_DEFAULTS.maxReconnects,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof bearer !== 'string' || bearer.length === 0) throw new Error('x-stream: bearer credential required (never read here from env)');
  if (typeof fetchImpl !== 'function') throw new Error('x-stream: fetchImpl required');
  const state = {
    connected: false, connecting: false, stopped: false, paused: false, stopReason: null,
    reconnects: 0, opens: 0, lastHttpStatus: null, lastPostTs: null, lastKeepaliveTs: null, lastReceiptTs: null,
    backfillMinutes: 0, linesDelivered: 0, keepalives: 0, oversizedLines: 0, badJson: 0, stalls: 0, tainted: false,
    lastCloseReason: null, refusedReason: null, connectionLimitHits: 0,
  };
  let controller = null;
  let stallTimer = null;
  let reconnectTimer = null;

  const clearStall = () => { if (stallTimer) { clearTimeoutImpl(stallTimer); stallTimer = null; } };
  const armStall = () => { clearStall(); stallTimer = setTimeoutImpl(() => { if (!state.stopped && state.connected) { state.stalls += 1; log('x-stream: stall (no Post/keepalive for the stall window) — reconnecting'); abort('stall'); } }, stallMs); };
  const abort = (why) => { state.lastCloseReason = why; try { controller?.abort(); } catch { /* already aborted */ } };

  function scheduleReconnect(why, delayOverride = null) {
    if (state.stopped || state.paused) return;
    if (maxReconnects > 0 && state.reconnects >= maxReconnects) { state.stopReason = `max reconnects (${why})`; log(`x-stream: ${state.stopReason}`); return; }
    const delay = delayOverride ?? Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(state.reconnects, 16));
    state.reconnects += 1;
    reconnectTimer = setTimeoutImpl(() => { reconnectTimer = null; if (!state.stopped && !state.paused) connect(); }, delay);
  }

  // ONE CONNECTION ONLY (§38): a connect while connecting/connected is a no-op.
  async function connect() {
    if (state.stopped || state.paused || state.connecting || state.connected) return;
    const gate = shouldConnect();
    if (!gate?.ok) { state.refusedReason = gate?.reason ?? 'refused'; log(`x-stream: connect refused by governor (${state.refusedReason})`); return; }
    state.refusedReason = null;
    state.connecting = true;
    state.backfillMinutes = Math.max(0, Math.min(provider.limits.backfillMinutesMax, backfillMinutesFor() ?? 0));
    const url = assertXHost(buildUrl({ backfillMinutes: state.backfillMinutes }));
    controller = new AbortController();
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${bearer}` }, signal: controller.signal });
    } catch (err) {
      state.connecting = false;
      if (state.stopped || state.paused) return;
      state.lastCloseReason = 'connect-error';
      log('x-stream: connect failed (network) — bounded reconnect');
      scheduleReconnect('connect-error');
      return;
    }
    state.lastHttpStatus = response?.status ?? null;
    if (response?.status !== 200) {
      state.connecting = false;
      const status = response?.status;
      if (status === 401 || status === 403) { state.stopReason = 'AUTH_REJECTED'; state.stopped = true; log(`x-stream: http ${status} — credential rejected; stopped`); onClose({ reason: 'AUTH_REJECTED', status }); return; }
      if (status === 420 || status === 429) {
        // 429 = rate limited / 420 = enhance-your-calm (connection limit): never hammer
        state.connectionLimitHits += 1;
        if (state.connectionLimitHits >= 3) { state.stopReason = 'CONNECTION_LIMIT'; state.stopped = true; log(`x-stream: http ${status} repeated — connection limit; stopped boundedly`); onClose({ reason: 'CONNECTION_LIMIT', status }); return; }
        log(`x-stream: http ${status} — backing off`);
        onClose({ reason: 'RATE_LIMITED', status });
        scheduleReconnect('rate-limited', rateLimitBackoffMs);
        return;
      }
      log(`x-stream: http ${status} — bounded reconnect`);
      onClose({ reason: 'HTTP_ERROR', status });
      scheduleReconnect(`http-${status}`);
      return;
    }
    state.connecting = false;
    state.connected = true;
    state.opens += 1;
    state.tainted = false;
    state.connectionLimitHits = 0;
    onOpen({ status: 200, backfillMinutes: state.backfillMinutes });
    armStall();
    await readLoop(response);
  }

  async function readLoop(response) {
    const reader = response.body?.getReader ? response.body.getReader() : null;
    const decoder = new TextDecoder();
    let buffer = '';
    let overflow = false;
    const closeWith = (why) => { state.connected = false; clearStall(); onClose({ reason: why, status: 200 }); if (!state.stopped && !state.paused) scheduleReconnect(why); };
    if (!reader) { closeWith('no-body'); return; }
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (state.stopped || state.paused) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > maxLineBytes * 2) {
          // a line longer than the bound: drop up to the next newline, taint
          const nl = buffer.indexOf('\n');
          buffer = nl >= 0 ? buffer.slice(nl + 1) : '';
          overflow = true;
          state.oversizedLines += 1;
          state.tainted = true;
          abort('tainted'); // the dropped line is OWED: close so backfill redelivers it
          break;
        }
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          const receivedTs = now();
          state.lastReceiptTs = receivedTs;
          armStall();
          if (line.trim().length === 0) { state.keepalives += 1; state.lastKeepaliveTs = receivedTs; onKeepalive({ receivedTs }); continue; } // keepalive: zero Post reads
          if (line.length > maxLineBytes) { state.oversizedLines += 1; state.tainted = true; continue; }
          let obj;
          try { obj = JSON.parse(line); } catch { state.badJson += 1; state.tainted = true; continue; }
          state.linesDelivered += 1;
          state.lastPostTs = receivedTs;
          onLine(obj, { receivedTs });
        }
        if (state.tainted) { abort('tainted'); break; } // a lost line is owed: reconnect with backfill redelivers it
      }
    } catch (err) {
      // abort / network end
    } finally {
      try { reader.releaseLock?.(); } catch { /* noop */ }
    }
    const why = state.lastCloseReason ?? (overflow ? 'tainted' : 'ended');
    state.lastCloseReason = null;
    closeWith(why);
  }

  return {
    start() { connect(); return this; },
    // BACKPRESSURE (§37): abort the read; nothing is scheduled. resume() re-asks the governor.
    pause(reason = 'paused') { state.paused = true; abort(reason); if (reconnectTimer) { clearTimeoutImpl(reconnectTimer); reconnectTimer = null; } },
    resume() { if (state.stopped) return; state.paused = false; connect(); },
    stop(reason = 'stopped') {
      state.stopped = true; state.stopReason = state.stopReason ?? reason; clearStall();
      if (reconnectTimer) { clearTimeoutImpl(reconnectTimer); reconnectTimer = null; }
      abort(reason);
    },
    isConnected: () => state.connected,
    status() {
      return {
        provider: provider.id, connected: state.connected, connecting: state.connecting, stopped: state.stopped, paused: state.paused,
        stopReason: state.stopReason, refusedReason: state.refusedReason, reconnects: state.reconnects, opens: state.opens,
        lastHttpStatus: state.lastHttpStatus, lastPostTs: state.lastPostTs, lastKeepaliveTs: state.lastKeepaliveTs, lastReceiptTs: state.lastReceiptTs,
        backfillMinutes: state.backfillMinutes, linesDelivered: state.linesDelivered, keepalives: state.keepalives,
        oversizedLines: state.oversizedLines, badJson: state.badJson, stalls: state.stalls, tainted: state.tainted, lastCloseReason: state.lastCloseReason,
      };
    },
  };
}
