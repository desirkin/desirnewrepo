// PUBLISH-FIX-52 — the tape's startup law (tape/startup.js): a universe load that does not answer by the deadline is
// STALLED (the socket still connects, the load is retried on a timer, a late answer is not lost), a failed load is
// retried, a good load is not; TAPE DOWN prints every minute after the grace period until LIVE; run.js is wired to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { raceUniverseLoad, startupOutcomeLine, startupNeedsRetry, createUniverseRetry, createTapeDownWatchdog, tapeDownLine, STARTUP_UNIVERSE_DEADLINE_MS, UNIVERSE_RETRY_MS, TAPE_DOWN_AFTER_MS } from '../tape/startup.js';

const fakeTimers = () => { const timers = []; return { timers, setTimeoutImpl: (fn, ms) => { const t = { fn, ms, kind: 'timeout', cleared: false, unref() {} }; timers.push(t); return t; }, clearTimeoutImpl: (t) => { if (t) t.cleared = true; }, setIntervalImpl: (fn, ms) => { const t = { fn, ms, kind: 'interval', cleared: false, unref() {} }; timers.push(t); return t; }, clearIntervalImpl: (t) => { if (t) t.cleared = true; } }; };

test('TS-01. a load that answers in time is not stalled; a load that throws is failed; a load that never answers is STALLED at the deadline and its late answer is left running', async () => {
  const ft = fakeTimers();
  const ok = await raceUniverseLoad({ load: async () => ({ added: [{ symbol: 'BTC/USD' }], removed: [] }), ...ft });
  assert.deepEqual(ok, { stalled: false, failed: false, error: null, added: [{ symbol: 'BTC/USD' }], removed: [] }); assert.equal(ft.timers[0].cleared, true, 'the deadline timer is cleared');
  const failed = await raceUniverseLoad({ load: async () => { throw new Error('kraken -> HTTP 429'); }, ...ft });
  assert.equal(failed.failed, true); assert.equal(failed.error, 'kraken -> HTTP 429'); assert.equal(failed.stalled, false);
  const venue = await raceUniverseLoad({ load: async () => ({ added: [], removed: [], failed: true, error: 'UNAVAILABLE' }), ...ft });
  assert.equal(venue.failed, true); assert.equal(venue.error, 'UNAVAILABLE');
  let late = null; const never = new Promise((r) => { late = r; });
  const p = raceUniverseLoad({ load: () => never, deadlineMs: 30_000, ...ft });
  const deadline = ft.timers.at(-1); assert.equal(deadline.kind, 'timeout'); assert.equal(deadline.ms, 30_000); deadline.fn();
  const stalled = await p; assert.equal(stalled.stalled, true); assert.equal(stalled.failed, false);
  late({ added: [], removed: [] }); // the original promise settling later is harmless
  assert.equal(STARTUP_UNIVERSE_DEADLINE_MS, 30_000);
});

test('TS-02. the outcome lines are plain and name the pairs carried; only stalled or failed loads need the retry', () => {
  assert.equal(startupOutcomeLine({ stalled: true }, { reason: 'startup', carried: 3 }), 'TAPE STARTUP: the universe load (startup) has not answered after 30s — connecting with the 3 pairs carried; retrying every 30s');
  assert.equal(startupOutcomeLine({ stalled: false, failed: true, error: 'kraken -> HTTP 503' }, { reason: 'startup', carried: 0 }), 'TAPE STARTUP: the universe load (startup) failed (kraken -> HTTP 503) — connecting with the 0 pairs carried; retrying every 30s');
  assert.equal(startupOutcomeLine({ stalled: false, failed: false }, { reason: 'startup', carried: 24 }), 'TAPE STARTUP: universe loaded (24 pairs)');
  assert.equal(startupNeedsRetry({ stalled: true }), true); assert.equal(startupNeedsRetry({ failed: true }), true); assert.equal(startupNeedsRetry({ stalled: false, failed: false }), false);
});

test('TS-03. the retry loop runs every 30 s until the universe is loaded, logs each attempt, and stops itself (also on stop / done before its first tick)', async () => {
  const ft = fakeTimers(); const logs = []; let loaded = false; let calls = 0;
  const retry = createUniverseRetry({ load: async () => { calls += 1; if (calls === 3) { loaded = true; return { added: [{ symbol: 'ETH/USD' }] }; } if (calls === 2) throw new Error('boom'); return { added: [], error: 'UNAVAILABLE' }; }, done: () => loaded, log: (m) => logs.push(m), nowIso: () => 'T', ...ft });
  retry.start(); retry.start(); const t = ft.timers[0]; assert.equal(t.kind, 'interval'); assert.equal(t.ms, UNIVERSE_RETRY_MS); assert.equal(ft.timers.length, 1, 'start is idempotent');
  await retry.tick(); await retry.tick(); assert.equal(loaded, false); await retry.tick(); assert.equal(loaded, true); assert.equal(t.cleared, true, 'stops itself once loaded');
  assert.deepEqual(logs, ['[T] TAPE STARTUP: universe retry 1 did not verify any pair (UNAVAILABLE); next in 30s', '[T] TAPE STARTUP: universe retry 2 failed (boom); next in 30s', '[T] TAPE STARTUP: universe loaded on retry 3']);
  await retry.tick(); assert.equal(calls, 3, 'no load once done'); assert.equal(retry.running(), false);
  const ft2 = fakeTimers(); let stopped = false; const r2 = createUniverseRetry({ load: async () => ({}), done: () => false, stopped: () => stopped, ...ft2 }); r2.start(); stopped = true; await r2.tick(); assert.equal(ft2.timers[0].cleared, true); assert.equal(r2.attempts(), 0);
});

test('TS-04. TAPE DOWN: silent inside the 2-minute grace, then one plain line per tick naming state / pairs / universe / socket / last message until LIVE; stops when LIVE or stopped', () => {
  const ft = fakeTimers(); const logs = []; let t = 1_000_000; let live = false; let stopped = false;
  const wd = createTapeDownWatchdog({ isLive: () => live, stopped: () => stopped, log: (m) => logs.push(m), nowIso: () => 'T', now: () => t, snapshot: () => ({ state: 'OFFLINE', pairs: 3, universeLoaded: false, socketState: 'none', lastMessageAgeMs: null }), ...ft });
  wd.arm(); assert.equal(ft.timers[0].kind, 'interval'); assert.equal(ft.timers[0].ms, 60_000);
  t += 60_000; assert.equal(wd.tick(), null, 'inside the grace period'); assert.equal(logs.length, 0);
  t += 60_000; const line = wd.tick(); assert.equal(line, 'TAPE DOWN: not LIVE 120s after start (state OFFLINE; 3 pairs carried; universe NOT loaded; socket none; last message never) — the Judge sees no books until this is LIVE'); assert.equal(logs[0], `[T] ${line}`);
  assert.equal(tapeDownLine({ upMs: 181_000, state: 'DEGRADED', pairs: 24, universeLoaded: true, socketState: 'OPEN', lastMessageAgeMs: 12_400 }), 'TAPE DOWN: not LIVE 181s after start (state DEGRADED; 24 pairs carried; universe loaded; socket OPEN; last message 12s ago) — the Judge sees no books until this is LIVE');
  live = true; t += 60_000; assert.equal(wd.tick(), null); assert.equal(ft.timers[0].cleared, true, 'stops once LIVE'); assert.equal(wd.lines(), 1);
  const ft2 = fakeTimers(); const wd2 = createTapeDownWatchdog({ isLive: () => false, stopped: () => true, snapshot: () => ({}), now: () => 0, ...ft2 }); wd2.arm(); wd2.tick(); assert.equal(ft2.timers[0].cleared, true);
  assert.equal(TAPE_DOWN_AFTER_MS, 120_000);
});

test('TS-05. fence: tape/run.js starts through the deadline race, arms the watchdog after connect(), starts the retry when needed, and clears both on stop', () => {
  const run = readFileSync('tape/run.js', 'utf8');
  assert.ok(run.includes("await loadUniverseWithDeadline('startup');"), 'startup goes through the deadline race');
  assert.ok(!run.includes("await loadUniverse('startup');"), 'the bare startup await is gone');
  assert.ok(run.indexOf('connect();\n  startupWatchdog.arm();') > 0, 'the watchdog is armed right after connect()');
  assert.ok(run.includes('if (startupNeedsRetry(r)) universeRetry.start();'), 'stalled / failed loads schedule the retry');
  assert.ok(run.includes("writeEvent('UNIVERSE_LOAD_STALLED'"), 'a stall is an event on the tape');
  assert.ok(run.includes('universeRetry.stop(); startupWatchdog.stop();'), 'stop clears both');
  assert.ok(run.includes("return { added: [], removed: [], failed: true, error: selection.error };"), 'a venue-unavailable load reports failed');
});
