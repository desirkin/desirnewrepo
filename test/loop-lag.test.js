// PUBLISH-FIX-50 — the event-loop stall clock (lib/loop-lag.js): stalls counted only over the threshold, worst / total kept,
// the snapshot resets for the next log line, the histogram is optional, and a real blocked thread is seen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLoopLag } from '../lib/loop-lag.js';

test('LL-01. a fake clock: lateness over the threshold is a stall; worst and total are kept; snapshot resets; the line reads plainly', () => {
  let t = 0; const timers = []; const lag = startLoopLag({ intervalMs: 50, stallMs: 100, now: () => t, setIntervalImpl: (fn) => { timers.push(fn); return { unref() {} }; }, clearIntervalImpl: () => {}, histogram: { percentile: (p) => (p === 50 ? 2e6 : p === 95 ? 30e6 : 400e6), max: 900e6, reset() { this.wasReset = true; }, disable() {} } });
  assert.equal(timers.length, 1);
  t = 50; lag.observe(); // on time: lag 0
  t = 130; lag.observe(); // 30 ms late: not a stall
  t = 400; lag.observe(); // 220 ms late: stall
  t = 1000; lag.observe(); // 550 ms late: stall
  const s = lag.snapshot();
  assert.equal(s.stalls, 2); assert.equal(s.worstMs, 550); assert.equal(s.totalMs, 770); assert.equal(s.ticks, 4);
  assert.deepEqual(s.delay, { p50Ms: 2, p95Ms: 30, p99Ms: 400, maxMs: 900 });
  assert.equal(lag.line(s), 'LOOP: 2 stalls over 100 ms (worst 550 ms, 770 ms blocked); loop delay p50 2 / p95 30 / p99 400 / max 900 ms');
  const after = lag.snapshot(); assert.equal(after.stalls, 0); assert.equal(after.worstMs, 0); assert.equal(after.ticks, 0);
  const noHist = startLoopLag({ now: () => 0, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {}, histogram: undefined });
  assert.ok(noHist.line().startsWith('LOOP: 0 stalls over 100 ms'));
});

test('LL-02. a real blocked main thread is counted', async () => {
  const lag = startLoopLag({ intervalMs: 20, stallMs: 100 });
  await new Promise((r) => setTimeout(r, 60));
  const until = performance.now() + 180; while (performance.now() < until) { /* block */ }
  await new Promise((r) => setTimeout(r, 60));
  const s = lag.snapshot(); lag.stop();
  assert.ok(s.stalls >= 1, `expected a stall, got ${JSON.stringify(s)}`); assert.ok(s.worstMs >= 150, `worst ${s.worstMs}`);
  assert.ok(s.delay === null || s.delay.maxMs >= 100, JSON.stringify(s.delay));
});
