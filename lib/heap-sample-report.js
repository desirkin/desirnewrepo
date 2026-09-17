// lib/heap-sample-report.js — PUBLISH-FIX-15 diagnostic (2026-09-17): say WHAT is holding the heap.
//
// Production paper boot 2388a1c8 grew from 125 MB to 400 MB of heap in three minutes and the boot before it died at the
// 1400 MB ceiling ("Ineffective mark-compacts near heap limit") after an hour; the MEM line says how much, never what.
// V8's sampling heap profiler records, for a sample of allocations, the allocation stack and whether the object is
// STILL ALIVE — so `getSamplingProfile` is a live-retention profile by allocation site, at a cost of one sample per
// `samplingInterval` bytes allocated (128 KB here: negligible). Every five minutes this logs ONE line with the top
// retaining frames and the top retaining files. Opt-in via SERPENT_HEAP_SAMPLE=true; authority NONE; nothing here
// changes behaviour, and every failure is contained.
import { Session } from 'node:inspector';
import path from 'node:path';

export const HEAP_SAMPLE_INTERVAL_MS = 5 * 60_000;
export const HEAP_SAMPLE_BYTES = 128 * 1024;
export const HEAP_SAMPLE_TOP = 10;

const post = (session, method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`;

// Aggregate a sampling heap profile (the `head` node tree) into live bytes per frame and per file, sorted descending.
export function summarizeHeapProfile(profile, { top = HEAP_SAMPLE_TOP } = {}) {
  const byFrame = new Map(); const byFile = new Map(); let total = 0;
  const stack = [profile?.head].filter(Boolean);
  while (stack.length) {
    const n = stack.pop();
    const self = Number(n.selfSize) || 0;
    if (self > 0) {
      total += self;
      const cf = n.callFrame ?? {}; const fn = cf.functionName || '(anonymous)';
      const file = cf.url ? path.basename(cf.url.replace(/^file:\/\//, '')) : '(native)';
      const key = cf.url ? `${fn} ${file}:${(cf.lineNumber ?? -1) + 1}` : fn;
      byFrame.set(key, (byFrame.get(key) ?? 0) + self);
      byFile.set(file, (byFile.get(file) ?? 0) + self);
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, bytes]) => ({ key, bytes, pct: total > 0 ? Math.round((bytes / total) * 100) : 0 }));
  return { totalBytes: total, frames: sorted(byFrame), files: sorted(byFile) };
}

export function formatHeapSummary(s) {
  const frames = s.frames.map((f) => `${f.key} ${f.pct}% ${mb(f.bytes)}`).join(' · ');
  const files = s.files.slice(0, 5).map((f) => `${f.key} ${f.pct}%`).join(' · ');
  return `HEAP SAMPLE live ${mb(s.totalBytes)} sampled · top frames: ${frames || '(nothing sampled)'} · top files: ${files || '(none)'}`;
}

export function startHeapSampleReport({ log = () => {}, intervalMs = HEAP_SAMPLE_INTERVAL_MS, samplingInterval = HEAP_SAMPLE_BYTES, timers = globalThis, SessionImpl = Session } = {}) {
  let session = null; let timer = null; let stopped = false;
  const begin = async () => { session = new SessionImpl(); session.connect(); await post(session, 'HeapProfiler.enable'); await post(session, 'HeapProfiler.startSampling', { samplingInterval, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false }); };
  const cycle = async () => {
    if (stopped || !session) return;
    try { const { profile } = await post(session, 'HeapProfiler.getSamplingProfile'); log(formatHeapSummary(summarizeHeapProfile(profile))); }
    catch (err) { log(`HEAP SAMPLE report failed (contained): ${String(err?.message ?? err).slice(0, 120)}`); }
  };
  begin().then(() => {
    timer = timers.setInterval(() => { cycle().catch(() => {}); }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    log(`HEAP SAMPLE on (one sample per ${Math.round(samplingInterval / 1024)}KB allocated, live-retention report every ${Math.round(intervalMs / 1000)}s)`);
  }).catch((err) => log(`HEAP SAMPLE could not start (contained): ${String(err?.message ?? err).slice(0, 120)}`));
  return { stop: () => { stopped = true; if (timer !== null) timers.clearInterval(timer); try { session?.disconnect(); } catch { /* contained */ } } };
}
