// lib/main-thread-watchdog.js — PUBLISH-FIX-10 diagnostic (2026-09-16): say what the MAIN THREAD is stuck in, from outside it.
//
// Production boot 54576519 froze solid for 9+ minutes after TAPE LIVE with no log line at all — a blocked event loop cannot
// report on itself, and a CPU profile is only delivered when the loop runs again. This watchdog is a worker thread that
// shares one counter with the main loop; the main loop bumps it every second. When the bump stops, the worker
//   1. reads the kernel's view of the main thread (/proc/<pid>/task/<pid>/{stat,syscall,wchan}): state R means running
//      JavaScript (a CPU-bound loop), state D/S with a syscall means stuck in a system call (a hung disk write, an fsync);
//   2. PUBLISH-FIX-10d: if the main thread is running JavaScript, attaches to the process's own inspector over the
//      loopback socket (opened at boot on 127.0.0.1, random port, never exposed), sends Debugger.pause — V8 honours that as
//      an interrupt even inside a tight loop — logs the JavaScript STACK it is paused in, and resumes it at once. Boot
//      351d3e48 reported "running JavaScript (CPU-bound)" for 155 s and nothing more; the stack is the missing fact.
// Every line goes straight to fd 1 (fs.writeSync — never through the main loop). Opt-in via SERPENT_STALL_WATCHDOG=true;
// authority NONE; the worker changes nothing about the program and never throws into the boot.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { readFileSync, writeSync } from 'node:fs';
import inspector from 'node:inspector';

export const STALL_AFTER_MS = 5_000;
// PUBLISH-FIX-116 (2026-09-21): one stack at 5 s and the next at 35 s told nothing about a 13-second block (deployment 3047a8da
// held the loop ~13 s about once every ten minutes, at 55-67% average load, with GC pauses under 150 ms — FIX-115 measured that).
// Now a stalled thread is sampled every STALL_REPEAT_MS (3 s) up to STALL_CAPTURES_PER_STALL times, so a 13-second block yields
// three or four stacks and the frames they share name the loop; and the moment the heartbeat returns the watchdog says exactly how
// long the thread was held: `MAIN THREAD RESUMED after 13.2s (4 samples)`.
export const STALL_REPEAT_MS = 3_000;
export const STALL_CAPTURES_PER_STALL = 5;
export const STACK_FRAMES = 24;
const PAUSE_TIMEOUT_MS = 8_000;

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

// One Debugger.paused payload → one line: innermost frame first, "fn file:line:col".
export function formatStack(callFrames, { frames = STACK_FRAMES, scripts = new Map() } = {}) {
  const shortUrl = (u) => { const parts = String(u ?? '').replace(/^file:\/\//, '').split('/'); return parts.slice(-2).join('/'); };
  const urlOf = (f) => f.url || scripts.get(f.location?.scriptId) || '';
  const out = (callFrames ?? []).slice(0, frames).map((f) => `${f.functionName || '(anonymous)'} ${shortUrl(urlOf(f))}:${(f.location?.lineNumber ?? -1) + 1}:${(f.location?.columnNumber ?? -1) + 1}`);
  return out.length ? out.join(' <- ') : '(no JavaScript frames)';
}

// ---- worker side ---------------------------------------------------------------------------------------------------------
// Pause the main isolate through its inspector socket, read the stack, resume. Resolves to a line; never rejects.
function captureMainStack(wsUrl) {
  return new Promise((resolve) => {
    let ws = null; let id = 0; const pending = new Map(); let done = false; const scripts = new Map();
    const finish = (line) => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch { /* contained */ } resolve(line); };
    const timer = setTimeout(() => finish(`MAIN THREAD STACK: pause did not take within ${PAUSE_TIMEOUT_MS / 1000}s (main thread not interruptible right now)`), PAUSE_TIMEOUT_MS);
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); try { ws.send(JSON.stringify({ id: i, method, params })); } catch (err) { pending.delete(i); res({ error: { message: String(err?.message ?? err) } }); } });
    try { ws = new WebSocket(wsUrl); } catch (err) { finish(`MAIN THREAD STACK: inspector socket refused (${String(err?.message ?? err).slice(0, 80)})`); return; }
    ws.onerror = () => finish('MAIN THREAD STACK: inspector socket error');
    ws.onmessage = async (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Debugger.scriptParsed' && m.params?.scriptId) { scripts.set(m.params.scriptId, m.params.url ?? ''); return; }
      if (m.method === 'Debugger.paused') {
        const line = `MAIN THREAD STACK (paused, reason ${m.params?.reason ?? '?'}): ${formatStack(m.params?.callFrames, { scripts })}`;
        await send('Debugger.resume'); await send('Debugger.disable');
        finish(line);
      }
    };
    ws.onopen = async () => { await send('Debugger.enable'); await send('Debugger.pause'); };
  });
}

function runWorker() {
  const { shared, stallAfterMs, repeatMs, pid, inspectorUrl } = workerData; const counter = new Int32Array(shared);
  let last = Atomics.load(counter, 0); let lastChangeAt = Date.now(); let lastReportAt = 0; let capturing = false; let reported = false; let captures = 0;
  const say = (line) => { try { writeSync(1, `${line}\n`); } catch { /* fd 1 gone: nothing to do */ } };
  const tick = () => {
    const cur = Atomics.load(counter, 0); const now = Date.now();
    if (cur !== last) {
      // PUBLISH-FIX-116: the heartbeat is back — say how long it was gone (the stall's true length, not the report cadence)
      if (reported) { say(`MAIN THREAD RESUMED after ${((now - lastChangeAt) / 1000).toFixed(1)}s (${captures} sample${captures === 1 ? '' : 's'})`); reported = false; captures = 0; }
      last = cur; lastChangeAt = now; return;
    }
    const stalledMs = now - lastChangeAt;
    if (stalledMs >= stallAfterMs && now - lastReportAt >= repeatMs && !capturing && captures < STALL_CAPTURES_PER_STALL) {
      lastReportAt = now; reported = true; captures += 1; // bounded per stall: at most STALL_CAPTURES_PER_STALL reports (and stacks)
      const st = readMainThreadState(pid);
      say(describeStall({ stalledMs, ...st }));
      if (inspectorUrl && st.state === 'R') {
        capturing = true;
        captureMainStack(inspectorUrl).then((line) => { say(line); capturing = false; });
      }
    }
  };
  const t = setInterval(tick, 1000); parentPort?.once('message', (m) => { if (m === 'stop') { clearInterval(t); process.exit(0); } });
}

// ---- main side -----------------------------------------------------------------------------------------------------------
export function startMainThreadWatchdog({ stallAfterMs = STALL_AFTER_MS, repeatMs = STALL_REPEAT_MS, log = () => {}, openInspector = true } = {}) {
  if (!isMainThread) return { stop: () => {} };
  const shared = new SharedArrayBuffer(4); const counter = new Int32Array(shared);
  let inspectorUrl = null;
  if (openInspector) {
    // loopback only, random port, no wait: the worker is the only client, and it only ever pauses/resumes.
    try { if (!inspector.url()) inspector.open(0, '127.0.0.1', false); inspectorUrl = inspector.url() ?? null; }
    catch (err) { log(`stall watchdog: inspector not opened (contained): ${String(err?.message ?? err).slice(0, 120)}`); }
  }
  let worker = null;
  try {
    worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { shared, stallAfterMs, repeatMs, pid: process.pid, inspectorUrl } });
    worker.on('error', (err) => log(`stall watchdog worker failed (contained): ${String(err?.message ?? err).slice(0, 120)}`));
    worker.unref();
  } catch (err) { log(`stall watchdog could not start (contained): ${String(err?.message ?? err).slice(0, 120)}`); return { stop: () => {} }; }
  const heartbeat = setInterval(() => { Atomics.add(counter, 0, 1); }, 1000); if (typeof heartbeat.unref === 'function') heartbeat.unref();
  log(`MAIN THREAD WATCHDOG on (reports after ${Math.round(stallAfterMs / 1000)}s of no heartbeat, then every ${Math.round(repeatMs / 1000)}s up to ${STALL_CAPTURES_PER_STALL} times per stall, and RESUMED with the stall's length; stack capture ${inspectorUrl ? 'via loopback inspector' : 'off'})`);
  return { stop: () => { clearInterval(heartbeat); try { worker?.postMessage('stop'); } catch { /* contained */ } } };
}

if (!isMainThread && workerData && workerData.shared) runWorker();
