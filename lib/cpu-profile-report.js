// lib/cpu-profile-report.js — PUBLISH-FIX-10 diagnostic (2026-09-16): say WHAT the event loop was doing.
//
// Production paper boots 954229d8 / b88bca71 blocked the event loop for 9 s, 13 s and 57 s at a time with a tiny heap
// (RESOURCE_WARNING lag=57584ms heap=66MB), so the page and the database socket starved. Nothing in the log said which
// code was running. This module samples the main thread with V8's own profiler (a separate sampler thread, so it keeps
// sampling THROUGH a blocked loop) and, once a minute, logs the top self-time frames as ONE line. Opt-in via
// SERPENT_CPU_PROFILE=true; authority NONE; nothing here changes behaviour, and every failure is contained.
import { Session } from 'node:inspector';
import path from 'node:path';

export const CPU_PROFILE_INTERVAL_MS = 60_000;
export const CPU_PROFILE_TOP = 10;

const post = (session, method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));

// Aggregate a V8 .cpuprofile into self-time per frame (microseconds), sorted descending.
export function summarizeProfile(profile, { top = CPU_PROFILE_TOP } = {}) {
  const byId = new Map(); for (const n of profile.nodes ?? []) byId.set(n.id, n);
  const self = new Map(); let total = 0; let idle = 0;
  const samples = profile.samples ?? []; const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i += 1) {
    const dt = Math.max(0, deltas[i] ?? 0); total += dt;
    const n = byId.get(samples[i]); if (!n) continue;
    const cf = n.callFrame ?? {}; const fn = cf.functionName || '(anonymous)';
    if (fn === '(idle)') { idle += dt; continue; }
    const file = cf.url ? path.basename(cf.url.replace(/^file:\/\//, '')) : '';
    const key = file ? `${fn} ${file}:${(cf.lineNumber ?? -1) + 1}` : fn;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  const busy = total - idle;
  const frames = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, us]) => ({ key, ms: Math.round(us / 1000), pct: busy > 0 ? Math.round((us / busy) * 100) : 0 }));
  return { totalMs: Math.round(total / 1000), busyMs: Math.round(busy / 1000), idleMs: Math.round(idle / 1000), frames };
}

export function formatSummary(s) {
  const top = s.frames.map((f) => `${f.key} ${f.pct}% ${f.ms}ms`).join(' · ');
  return `CPU PROFILE ${Math.round(s.totalMs / 1000)}s: busy ${s.busyMs}ms idle ${s.idleMs}ms · top: ${top || '(nothing sampled)'}`;
}

export const CPU_PROFILE_SAMPLE_US = 25_000; // PUBLISH-FIX-26: 25 ms sampling — the 5 ms profiler itself cost 3-5% of a saturated main thread (boot 29e95c87)
export function startCpuProfileReport({ log = () => {}, intervalMs = CPU_PROFILE_INTERVAL_MS, sampleUs = CPU_PROFILE_SAMPLE_US, timers = globalThis, SessionImpl = Session } = {}) {
  let session = null; let timer = null; let stopped = false;
  const begin = async () => { session = new SessionImpl(); session.connect(); await post(session, 'Profiler.enable'); await post(session, 'Profiler.setSamplingInterval', { interval: sampleUs }); await post(session, 'Profiler.start'); };
  const cycle = async () => {
    if (stopped || !session) return;
    try {
      const { profile } = await post(session, 'Profiler.stop');
      log(formatSummary(summarizeProfile(profile)));
      await post(session, 'Profiler.start');
    } catch (err) { log(`CPU PROFILE report failed (contained): ${String(err?.message ?? err).slice(0, 120)}`); }
  };
  begin().then(() => {
    timer = timers.setInterval(() => { cycle().catch(() => {}); }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    log(`CPU PROFILE sampling on (${sampleUs / 1000}ms interval, report every ${Math.round(intervalMs / 1000)}s)`);
  }).catch((err) => log(`CPU PROFILE could not start (contained): ${String(err?.message ?? err).slice(0, 120)}`));
  return { stop: () => { stopped = true; if (timer !== null) timers.clearInterval(timer); try { session?.disconnect(); } catch { /* contained */ } } };
}
