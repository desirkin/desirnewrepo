// I/O LANE (Ticket B, 2026-09-15) — the write-behind buffer. The tape's per-trade / per-snapshot / per-event appends and
// the current-book / status / feature snapshots are disk writes that, done synchronously, block the same event loop that
// carries the bite. This buffer moves them off the loop: the bite lane ENQUEUES (memory only) and returns; a background
// flusher (and the shutdown seam) writes them. Two shapes: APPEND (every JSONL line is kept and appended in order) and
// LATEST (a per-file value coalesced to the newest — the current book / status). FAIL-CLOSED and non-throwing: a flush
// error is caught and counted (never thrown into the bite lane); the append queue is bounded, and an overflow DROPS the
// oldest lines with a counted coverage loss rather than growing without bound (research capture, never a decision input).
// Authority NONE. The IO is injected for tests; production uses the real fs.
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './jsonl.js';

export const WRITE_BEHIND_VERSION = 'serpent-write-behind-1';
export const WRITE_BEHIND_DEFAULT_FLUSH_MS = 200;
export const WRITE_BEHIND_DEFAULT_MAX_APPEND = 200_000; // lines buffered across all append files before the oldest are dropped

const DEFAULT_IO = Object.freeze({
  appendLines: (file, lines) => { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, lines); },
  writeLatest: (file, obj) => atomicWriteJson(file, obj),
});

export function createWriteBehind({ flushIntervalMs = WRITE_BEHIND_DEFAULT_FLUSH_MS, maxAppendQueue = WRITE_BEHIND_DEFAULT_MAX_APPEND, io = DEFAULT_IO, now = () => Date.now(), timers = { setInterval, clearInterval }, log = () => {}, meter = null } = {}) {
  const appends = new Map(); // file -> string[] (JSONL lines, in order)
  const latest = new Map();  // file -> obj (coalesced, newest wins)
  let queued = 0; let timer = null; let stopped = false;
  const stats = { enqueuedAppend: 0, enqueuedLatest: 0, flushedAppend: 0, flushedLatest: 0, droppedAppend: 0, flushes: 0, flushFailures: 0, lastFlushMs: 0, maxFlushMs: 0 };

  function enqueueAppend(file, obj) {
    if (stopped) { try { io.appendLines(file, JSON.stringify(obj) + '\n'); } catch { /* post-stop fallback */ } return; }
    let arr = appends.get(file); if (!arr) { arr = []; appends.set(file, arr); }
    arr.push(JSON.stringify(obj) + '\n'); queued += 1; stats.enqueuedAppend += 1;
    if (queued > maxAppendQueue) { // overflow: drop the OLDEST lines (bounded memory), counted — never a silent unbounded grow
      let over = queued - maxAppendQueue;
      for (const [, lines] of appends) { while (over > 0 && lines.length) { lines.shift(); over -= 1; queued -= 1; stats.droppedAppend += 1; } if (over <= 0) break; }
    }
    ensureTimer();
  }
  function enqueueLatest(file, obj) {
    if (stopped) { try { io.writeLatest(file, obj); } catch { /* post-stop fallback */ } return; }
    latest.set(file, obj); stats.enqueuedLatest += 1; ensureTimer();
  }
  function ensureTimer() { if (timer === null && !stopped) { timer = timers.setInterval(() => { try { flush(); } catch { /* contained */ } }, flushIntervalMs); if (typeof timer?.unref === 'function') timer.unref(); } }

  function flush() {
    const t0 = now();
    for (const [file, lines] of appends) {
      if (!lines.length) continue;
      const batch = lines.join(''); const n = lines.length;
      try { io.appendLines(file, batch); lines.length = 0; queued -= n; stats.flushedAppend += n; }
      catch (err) { stats.flushFailures += 1; log(`write-behind append flush failed (${path.basename(file)}): ${String(err?.message ?? err).slice(0, 100)}`); } // keep the lines buffered; retry next flush
    }
    for (const [file, obj] of [...latest]) {
      try { io.writeLatest(file, obj); latest.delete(file); stats.flushedLatest += 1; }
      catch (err) { stats.flushFailures += 1; log(`write-behind latest flush failed (${path.basename(file)}): ${String(err?.message ?? err).slice(0, 100)}`); } // keep the coalesced value; retry next flush
    }
    const dt = now() - t0; stats.flushes += 1; stats.lastFlushMs = dt; if (dt > stats.maxFlushMs) stats.maxFlushMs = dt;
    if (meter) try { meter.record('writeBehindFlush', dt); } catch { /* meter is best-effort */ }
  }

  function stop() { if (stopped) return; if (timer !== null) { timers.clearInterval(timer); timer = null; } flush(); stopped = true; } // final drain; further enqueues fall back to a direct write
  const status = () => Object.freeze({ version: WRITE_BEHIND_VERSION, stopped, flushIntervalMs, queuedAppendLines: queued, pendingLatestFiles: latest.size, ...stats });
  return Object.freeze({ enqueueAppend, enqueueLatest, flush, stop, status });
}
