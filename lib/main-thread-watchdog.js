// lib/main-thread-watchdog.js — PUBLISH-FIX-10 diagnostic (2026-09-16): say what the MAIN THREAD is stuck in, from outside it.
//
// Production boot 54576519 froze solid for 9+ minutes after TAPE LIVE with no log line at all — a blocked event loop cannot
// report on itself, and a CPU profile is only delivered when the loop runs again. This watchdog is a worker thread that
// shares one counter with the main loop; the main loop bumps it every second. When the bump stops, the worker reads the
// kernel's view of the main thread (/proc/<pid>/task/<pid>/{stat,syscall,wchan}) and writes ONE line straight to fd 1
// (fs.writeSync — never through the main loop): state R means running JavaScript (a CPU-bound loop), state D/S with a
// syscall means stuck in a system call (a hung disk write, an fsync). Opt-in via SERPENT_STALL_WATCHDOG=true; authority
// NONE; the worker touches nothing else and never throws into the boot.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { readFileSync, writeSync } from 'node:fs';

export const STALL_AFTER_MS = 5_000;
export const STALL_REPEAT_MS = 30_000;

const SYSCALL_NAMES = { 0: 'read', 1: 'write', 4: 'stat', 5: 'fstat', 6: 'lstat', 7: 'poll', 17: 'pread64', 18: 'pwrite64', 20: 'writev', 74: 'fsync', 75: 'fdatasync', 83: 'mkdir', 202: 'futex', 232: 'epoll_wait', 257: 'openat', 262: 'newfstatat', 281: 'epoll_pwait' };

export function readMainThreadState(pid = process.pid) {
  const rd = (f) => { try { return readFileSync(`/proc/${pid}/task/${pid}/${f}`, 'utf8').trim(); } catch (err) { return `unreadable(${err?.code ?? 'ERR'})`; } };
  const stat = rd('stat'); const m = /\)\s+(\S)\s/.exec(stat); const state = m ? m[1] : '?';
  const syscallRaw = rd('syscall'); const nr = syscallRaw.split(/\s+/)[0]; const syscall = syscallRaw === 'running' ? 'running' : nr && /^\d+$/.test(nr) ? (SYSCALL_NAMES[Number(nr)] ?? `nr${nr}`) : syscallRaw.slice(0, 40);
  return { state, syscall, wchan: rd('wchan').slice(0, 40) };
}

export function describeStall({ stalledMs, state, syscall, wchan }) {
  const meaning = state === 'R' && syscall === 'running' ? 'running JavaScript (CPU-bound on the main thread)'
    : state === 'D' ? 'uninterruptible I/O wait (a system call on the disk or a mount)'
      : syscall !== 'running' ? `blocked in the ${syscall} system call` : `state ${state}`;
  return `MAIN THREAD STALLED ${Math.round(stalledMs / 1000)}s: ${meaning} · state=${state} syscall=${syscall} wchan=${wchan}`;
}

// ---- worker side ---------------------------------------------------------------------------------------------------------
function runWorker() {
  const { shared, stallAfterMs, repeatMs, pid } = workerData; const counter = new Int32Array(shared);
  let last = Atomics.load(counter, 0); let lastChangeAt = Date.now(); let lastReportAt = 0;
  const tick = () => {
    const cur = Atomics.load(counter, 0); const now = Date.now();
    if (cur !== last) { last = cur; lastChangeAt = now; return; }
    const stalledMs = now - lastChangeAt;
    if (stalledMs >= stallAfterMs && now - lastReportAt >= repeatMs) {
      lastReportAt = now;
      try { writeSync(1, `${describeStall({ stalledMs, ...readMainThreadState(pid) })}\n`); } catch { /* fd 1 gone: nothing to do */ }
    }
  };
  const t = setInterval(tick, 1000); parentPort?.once('message', (m) => { if (m === 'stop') { clearInterval(t); process.exit(0); } });
}

// ---- main side -----------------------------------------------------------------------------------------------------------
export function startMainThreadWatchdog({ stallAfterMs = STALL_AFTER_MS, repeatMs = STALL_REPEAT_MS, log = () => {} } = {}) {
  if (!isMainThread) return { stop: () => {} };
  const shared = new SharedArrayBuffer(4); const counter = new Int32Array(shared);
  let worker = null;
  try {
    worker = new Worker(new URL(import.meta.url), { workerData: { shared, stallAfterMs, repeatMs, pid: process.pid } });
    worker.on('error', (err) => log(`stall watchdog worker failed (contained): ${String(err?.message ?? err).slice(0, 120)}`));
    worker.unref();
  } catch (err) { log(`stall watchdog could not start (contained): ${String(err?.message ?? err).slice(0, 120)}`); return { stop: () => {} }; }
  const heartbeat = setInterval(() => { Atomics.add(counter, 0, 1); }, 1000); if (typeof heartbeat.unref === 'function') heartbeat.unref();
  log(`MAIN THREAD WATCHDOG on (reports after ${Math.round(stallAfterMs / 1000)}s of no heartbeat, then every ${Math.round(repeatMs / 1000)}s)`);
  return { stop: () => { clearInterval(heartbeat); try { worker?.postMessage('stop'); } catch { /* contained */ } } };
}

if (!isMainThread && workerData && workerData.shared) runWorker();
