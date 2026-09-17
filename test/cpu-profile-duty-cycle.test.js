// PUBLISH-FIX-33 (2026-09-17): the CPU profiler is duty-cycled — the exact event-loop load line every minute, the sampled
// top-frames line one minute in five (the inspector round-trip cost 3-5% of the main thread when taken every minute).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCpuProfileReport, formatLoad, summarizeProfile } from '../lib/cpu-profile-report.js';

const fakeProfile = () => ({ nodes: [{ id: 1, callFrame: { functionName: 'work', url: 'file:///x/y.js', lineNumber: 9 } }, { id: 2, callFrame: { functionName: '(idle)' } }], samples: [1, 2, 1], timeDeltas: [10_000, 5_000, 10_000] });

test('one profiled minute in five; the other minutes log the exact event-loop load; the profiler is only running during a profiled minute', async () => {
  const calls = []; const lines = [];
  const SessionImpl = function () { this.connect = () => {}; this.disconnect = () => {}; this.post = (m, p, cb) => { calls.push(m); cb(null, m === 'Profiler.stop' ? { profile: fakeProfile() } : {}); }; };
  let tick = null; const timers = { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => {} };
  let t = 0; const elu = () => { t += 1; return { active: 40_000 * t, idle: 20_000 * t, utilization: 2 / 3 }; };
  const r = startCpuProfileReport({ log: (l) => lines.push(l), timers, SessionImpl, elu, profileEvery: 5 });
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(lines[0].startsWith('CPU PROFILE sampling on'));
  assert.deepEqual(calls, ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'], 'the first (boot) minute is profiled');
  for (let i = 0; i < 10; i += 1) { await tick(); }
  const kinds = lines.slice(1).map((l) => l.split(' ')[1]);
  assert.deepEqual(kinds, ['PROFILE', 'LOAD', 'LOAD', 'LOAD', 'PROFILE', 'LOAD', 'LOAD', 'LOAD', 'LOAD', 'PROFILE']);
  assert.equal(calls.filter((m) => m === 'Profiler.stop').length, 3); assert.equal(calls.filter((m) => m === 'Profiler.start').length, 3);
  assert.match(lines[2], /^CPU LOAD 60s: busy 40000ms idle 20000ms \(event-loop utilization 67%\)$/);
  assert.match(lines[1], /^CPU PROFILE 0s: busy 20ms idle 5ms · top: work y\.js:10 100% 20ms$/);
  r.stop();
});

test('formatLoad and summarizeProfile are plain formatting', () => {
  assert.equal(formatLoad({ active: 30_000, idle: 30_000 }), 'CPU LOAD 60s: busy 30000ms idle 30000ms (event-loop utilization 50%)');
  const s = summarizeProfile(fakeProfile()); assert.equal(s.busyMs, 20); assert.equal(s.idleMs, 5);
});
