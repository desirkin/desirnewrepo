// lib/gc-report.js — PUBLISH-FIX-115 diagnostic (2026-09-21): say WHEN the garbage collector stopped the world, and for how long.
//
// Production 3047a8da (PUBLISH-FIX-114 live), steady state 55-67% busy with twenty candidates and ~940 order-book messages a
// second, still showed a 13 s block of the main thread about once every ten minutes:
//     01:33:18 CPU LOAD ... (67%)            <- the minute tick, on time
//     01:34:15 MAIN THREAD STALLED 5s: running JavaScript (CPU-bound on the main thread)
//     01:34:23 CPU LOAD ... (98%)            <- the same tick, 5.3 s late: the loop was held from ~01:34:10 to 01:34:23
//     01:34:23 MEM heap 1313/4144MB   ->   01:35:23 MEM heap 558/4144MB
// and at 01:45 the same shape ended in `RESOURCE_WARNING lag=3468ms (LAG_SUSTAINED) — shedding 6 LEAST-FIT pairs`. The heap
// climbs 560 -> 1300 MB and falls back in one step each time — the signature of a full mark-compact — but no line says so,
// and the watchdog's stack capture can only land AFTER the collector releases the thread, so it names ordinary work.
// This observer reports every garbage-collection pause at or above `minMs` (default 250 ms) from Node's own perf_hooks 'gc'
// entries — kind, duration, heap before/after — as ONE line, and a count of the small ones once a minute. Authority NONE; the
// observer changes nothing about collection; every failure is contained.
import { PerformanceObserver, constants } from 'node:perf_hooks';

export const GC_REPORT_MIN_MS = 250;
export const GC_REPORT_INTERVAL_MS = 60_000;
const KIND = { [constants.NODE_PERFORMANCE_GC_MAJOR]: 'MAJOR', [constants.NODE_PERFORMANCE_GC_MINOR]: 'MINOR', [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'INCREMENTAL', [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'WEAKCB' };
export const gcKindName = (kind) => KIND[kind] ?? `KIND_${kind}`;

export function formatPause(entry, heapMb) {
  const d = entry.detail ?? {}; const flags = Number.isSafeInteger(d.flags) && d.flags !== 0 ? ` flags ${d.flags}` : '';
  return `GC PAUSE ${Math.round(entry.duration)}ms ${gcKindName(d.kind)}${flags} · heap now ${heapMb}MB — the main thread was stopped for the whole pause`;
}

export function startGcReport({ log = () => {}, minMs = GC_REPORT_MIN_MS, intervalMs = GC_REPORT_INTERVAL_MS, timers = globalThis, ObserverImpl = PerformanceObserver, memory = () => process.memoryUsage() } = {}) {
  const counts = { major: 0, majorMs: 0, minor: 0, minorMs: 0, incremental: 0, incrementalMs: 0, weakcb: 0, longest: 0 };
  let observer = null; let timer = null;
  const onEntry = (entry) => {
    const kind = entry.detail?.kind; const ms = entry.duration;
    if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) { counts.major += 1; counts.majorMs += ms; } else if (kind === constants.NODE_PERFORMANCE_GC_MINOR) { counts.minor += 1; counts.minorMs += ms; } else if (kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) { counts.incremental += 1; counts.incrementalMs += ms; } else counts.weakcb += 1;
    if (ms > counts.longest) counts.longest = ms;
    if (ms >= minMs) { try { log(formatPause(entry, Math.round(memory().heapUsed / 1048576))); } catch { /* contained */ } }
  };
  try {
    observer = new ObserverImpl((list) => { for (const entry of list.getEntries()) { try { onEntry(entry); } catch { /* contained */ } } });
    observer.observe({ entryTypes: ['gc'] });
    timer = timers.setInterval(() => {
      const line = `GC 60s: major ${counts.major} (${Math.round(counts.majorMs)}ms) · minor ${counts.minor} (${Math.round(counts.minorMs)}ms) · incremental ${counts.incremental} (${Math.round(counts.incrementalMs)}ms) · longest pause ${Math.round(counts.longest)}ms`;
      counts.major = 0; counts.majorMs = 0; counts.minor = 0; counts.minorMs = 0; counts.incremental = 0; counts.incrementalMs = 0; counts.weakcb = 0; counts.longest = 0;
      try { log(line); } catch { /* contained */ }
    }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    log(`GC REPORT on (every pause >= ${minMs}ms on its own line; the minute's collections as one line every ${Math.round(intervalMs / 1000)}s)`);
  } catch (err) { log(`GC REPORT could not start (contained): ${String(err?.message ?? err).slice(0, 120)}`); }
  return { stop: () => { try { observer?.disconnect(); } catch { /* contained */ } if (timer !== null) timers.clearInterval(timer); }, counts };
}
