// PUBLISH-FIX-50 — the EVENT-LOOP STALL clock. Production (4dd77a32, 17:13 local): 17 confirmed decisions, 10 cancelled by
// the scheduler's 100 ms queue rule before they ever ran ("scheduler queue-expired 10") — the 25 ms scheduler timer could
// not fire for over 100 ms, i.e. the main thread was blocked. This clock names those stalls: a 50 ms timer measures how
// late it fires; every lateness over `stallMs` is a stall (count, worst, total) and the histogram carries the p50 / p95
// / p99 of loop delay. Read-only; authority NONE; `snapshot(reset)` gives the numbers since the last read for a log line.
import { monitorEventLoopDelay } from 'node:perf_hooks';

export function startLoopLag({ intervalMs = 50, stallMs = 100, now = () => performance.now(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, histogram = null } = {}) {
  const h = histogram ?? (() => { try { const x = monitorEventLoopDelay({ resolution: 10 }); x.enable(); return x; } catch { return null; } })();
  let last = now(); let stalls = 0; let worst = 0; let total = 0; let ticks = 0;
  const observe = () => { const n = now(); const lag = Math.max(0, n - last - intervalMs); last = n; ticks += 1; if (lag > stallMs) { stalls += 1; total += lag; } if (lag > worst) worst = lag; };
  const timer = setIntervalImpl(observe, intervalMs); timer?.unref?.();
  const ms = (ns) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : null);
  function snapshot({ reset = true } = {}) {
    const out = { stalls, worstMs: Math.round(worst), totalMs: Math.round(total), ticks, delay: h ? { p50Ms: ms(h.percentile(50)), p95Ms: ms(h.percentile(95)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) } : null };
    if (reset) { stalls = 0; worst = 0; total = 0; ticks = 0; h?.reset?.(); }
    return out;
  }
  const line = (s = snapshot()) => `LOOP: ${s.stalls} stalls over ${stallMs} ms (worst ${s.worstMs} ms, ${s.totalMs} ms blocked)${s.delay ? `; loop delay p50 ${s.delay.p50Ms} / p95 ${s.delay.p95Ms} / p99 ${s.delay.p99Ms} / max ${s.delay.maxMs} ms` : ''}`;
  return { observe, snapshot, line, stop: () => { clearIntervalImpl(timer); h?.disable?.(); } };
}
