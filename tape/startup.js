// PUBLISH-FIX-52 (2026-09-17) — the tape's startup law, pure and injectable so it can be tested without a socket.
// Production b1ec3c6a: the Judge, learning and the wide eye were live but the tape never got past its startup universe
// load (no UNIVERSE_SELECTED / UNIVERSE_REFRESH_FAILED, no 'tape starting', no socket) for 35 minutes, so the Judge saw
// zero books while the same REST call answered in 289 ms from the workspace. The venue is never guessed: a load that
// does not answer by the deadline is declared STALLED, the socket connects for the pairs carried, the load is retried
// on a timer (adopting only what the venue verifies), and TAPE DOWN prints every minute until the tape is LIVE.
export const STARTUP_UNIVERSE_DEADLINE_MS = 30_000;
export const UNIVERSE_RETRY_MS = 30_000;
export const TAPE_DOWN_AFTER_MS = 120_000;

// race a universe load against a deadline; the load's own promise is left running (a late answer still adopts pairs)
export async function raceUniverseLoad({ load, deadlineMs = STARTUP_UNIVERSE_DEADLINE_MS, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
  let timer = null;
  const deadline = new Promise((resolve) => { timer = setTimeoutImpl(() => resolve({ stalled: true, failed: false, error: null, added: [], removed: [] }), deadlineMs); });
  const attempt = Promise.resolve().then(load).then((r) => ({ stalled: false, failed: Boolean(r?.failed), error: r?.error ?? null, added: r?.added ?? [], removed: r?.removed ?? [] })).catch((err) => ({ stalled: false, failed: true, error: String(err?.message ?? err).slice(0, 200), added: [], removed: [] }));
  try { return await Promise.race([attempt, deadline]); } finally { clearTimeoutImpl(timer); }
}

// the outcome of a startup load, in one plain line
export function startupOutcomeLine(r, { reason, carried, deadlineMs = STARTUP_UNIVERSE_DEADLINE_MS, retryMs = UNIVERSE_RETRY_MS }) {
  if (r.stalled) return `TAPE STARTUP: the universe load (${reason}) has not answered after ${deadlineMs / 1000}s — connecting with the ${carried} pairs carried; retrying every ${retryMs / 1000}s`;
  if (r.failed) return `TAPE STARTUP: the universe load (${reason}) failed (${r.error ?? 'venue UNAVAILABLE'}) — connecting with the ${carried} pairs carried; retrying every ${retryMs / 1000}s`;
  return `TAPE STARTUP: universe loaded (${carried} pairs)`;
}
export const startupNeedsRetry = (r) => Boolean(r.stalled || r.failed);

// a bounded retry loop: `load` runs every `retryMs` until `done()` answers true or `stopped()`; every outcome is logged
export function createUniverseRetry({ load, done, stopped = () => false, log = () => {}, retryMs = UNIVERSE_RETRY_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, nowIso = () => new Date().toISOString() }) {
  let timer = null; let attempts = 0;
  const stop = () => { if (timer) { clearIntervalImpl(timer); timer = null; } };
  const tick = async () => {
    if (stopped() || done()) { stop(); return; }
    attempts += 1;
    try { const r = await load('startup-retry'); if (done()) { log(`[${nowIso()}] TAPE STARTUP: universe loaded on retry ${attempts}`); stop(); } else log(`[${nowIso()}] TAPE STARTUP: universe retry ${attempts} did not verify any pair (${r?.error ?? 'no error'}); next in ${retryMs / 1000}s`); }
    catch (err) { log(`[${nowIso()}] TAPE STARTUP: universe retry ${attempts} failed (${String(err?.message ?? err).slice(0, 120)}); next in ${retryMs / 1000}s`); }
  };
  return { start() { if (timer) return; timer = setIntervalImpl(() => { tick().catch(() => {}); }, retryMs); timer?.unref?.(); }, stop, tick, attempts: () => attempts, running: () => timer !== null };
}

// the TAPE DOWN line: printed every minute once the tape has been up `afterMs` without going LIVE
export function tapeDownLine({ upMs, state, pairs, universeLoaded, socketState, lastMessageAgeMs }) {
  return `TAPE DOWN: not LIVE ${Math.round(upMs / 1000)}s after start (state ${state}; ${pairs} pairs carried; universe ${universeLoaded ? 'loaded' : 'NOT loaded'}; socket ${socketState}; last message ${lastMessageAgeMs === null ? 'never' : `${Math.round(lastMessageAgeMs / 1000)}s ago`}) — the Judge sees no books until this is LIVE`;
}
export function createTapeDownWatchdog({ isLive, stopped = () => false, snapshot, log = () => {}, afterMs = TAPE_DOWN_AFTER_MS, intervalMs = 60_000, now = () => Date.now(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, nowIso = () => new Date().toISOString() }) {
  const startedAt = now(); let timer = null; let lines = 0;
  const stop = () => { if (timer) { clearIntervalImpl(timer); timer = null; } };
  const tick = () => { if (stopped()) { stop(); return null; } const upMs = now() - startedAt; if (upMs < afterMs) return null; if (isLive()) { stop(); return null; } const line = tapeDownLine({ upMs, ...snapshot() }); lines += 1; log(`[${nowIso()}] ${line}`); return line; };
  return { arm() { if (timer) return; timer = setIntervalImpl(tick, intervalMs); timer?.unref?.(); }, stop, tick, lines: () => lines };
}
