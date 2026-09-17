// PUBLISH-FIX-37 (2026-09-17): the wide eye's sweep watchdog. On 2026-09-17 the sweeper went silent for over an hour
// twice — an in-flight Ticker request that never settled left `sweeping` true forever, no failure line, no status write,
// the cockpit tile reading OFF. A sweep now runs under a hard deadline: a stalled attempt is counted, logged, disowned
// (its late completion may not write status) and the next tick sweeps again; a silence guard re-arms whatever the cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'serpent-wideeye-watchdog-'));
process.env.COBRA_DATA_DIR = root;
process.env.WIDEEYE_ENABLED = 'true';
const { startWideEye } = await import('../survey/wideeye.js');
const { loadConfig } = await import('../lib/config.js');
test.after(() => { delete process.env.WIDEEYE_ENABLED; rmSync(root, { recursive: true, force: true }); });

const pairs = Object.fromEntries(['AAA', 'BBB', 'CCC'].map((coin) => [`${coin}USD`, { base: coin, quote: 'USD', wsname: `${coin}/USD`, altname: `${coin}USD`, status: 'online' }]));
const tickers = { AAAUSD: { c: ['10'], v: ['1', '1'], p: ['10', '10'] }, BBBUSD: { c: ['11'], v: ['2', '2'], p: ['11', '11'] }, CCCUSD: { c: ['12'], v: ['3', '3'], p: ['12', '12'] } };
const statusFile = () => path.join(root, 'survey', 'status.json');
const readStatus = () => (existsSync(statusFile()) ? JSON.parse(readFileSync(statusFile(), 'utf8')) : null);

// a fake timer world: intervals and timeouts fire when the test advances the clock
function fakeTimers() {
  let now = Date.UTC(2026, 8, 17, 13, 30);
  const timers = []; let id = 0;
  const setIntervalImpl = (fn, ms) => { const t = { id: ++id, fn, ms, at: now + ms, interval: true, refresh() { this.at = now + ms; } }; timers.push(t); return t; };
  const setTimeoutImpl = (fn, ms) => { const t = { id: ++id, fn, ms, at: now + ms, interval: false }; timers.push(t); return t; };
  const clear = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.interval) due.at = now + due.ms; else clear(due);
      void due.fn(); // never awaited: a sweep may be waiting on a timer this loop has yet to fire
      for (let i = 0; i < 12; i++) await Promise.resolve(); // let the sweep's continuations run
    }
    now = target;
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
  return { now: () => now, setIntervalImpl, setTimeoutImpl, clearIntervalImpl: clear, clearTimeoutImpl: clear, advance };
}

test('a sweep that never settles is STALLED at the deadline, disowned, and the next tick sweeps again', async () => {
  const clock = fakeTimers(); const lines = []; let tickerCalls = 0; let hangResolve = null;
  const eye = startWideEye({
    config: loadConfig(), log: (l) => lines.push(l), now: clock.now, registerSignals: false, nominationEnabled: false, deepCoinsSource: () => new Set(),
    setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
    fetchImpl: async (url) => {
      if (url.includes('AssetPairs')) return { ok: true, json: async () => ({ error: [], result: pairs }) };
      tickerCalls += 1;
      if (tickerCalls === 1) return new Promise((resolve) => { hangResolve = () => resolve({ ok: true, json: async () => ({ error: [], result: tickers }) }); }); // the first Ticker request never settles
      return { ok: true, json: async () => ({ error: [], result: tickers }) };
    },
  });
  assert.ok(eye, 'the eye opens');
  await clock.advance(60_000); // tick 1: catalog loads, the Ticker request hangs
  assert.equal(tickerCalls, 1); assert.equal(eye.health().sweeping, true); assert.equal(eye.health().stalls, 0);
  await clock.advance(60_000); // the deadline (55 s) passes inside this minute, then tick 2 is due
  assert.equal(eye.health().stalls, 1, 'the hung sweep was counted as a stall');
  assert.ok(lines.some((l) => /WIDE EYE sweep stalled \(no completion in 55s\)/.test(l)), lines.join('\n'));
  assert.equal(tickerCalls, 2, 'tick 2 swept again — the stalled attempt did not hold the sweeper');
  assert.equal(eye.health().sweeping, false);
  assert.ok(Number.isSafeInteger(eye.health().lastSweepCompletedTs), 'the second attempt completed');
  const s1 = readStatus(); assert.ok(s1 && s1.enabled === true && s1.watchdog.stalls === 1, 'status.json carries the stall count');
  // the disowned attempt finally settles: it may not touch status or population
  const before = JSON.stringify(readStatus()); hangResolve(); for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(JSON.stringify(readStatus()), before, 'a late completion of a disowned attempt writes nothing');
  eye.stop();
});

test('the silence guard re-arms an eye that has completed no sweep for five minutes, whatever the cause', async () => {
  const clock = fakeTimers(); const lines = []; let tickerCalls = 0;
  const eye = startWideEye({
    config: loadConfig(), log: (l) => lines.push(l), now: clock.now, registerSignals: false, nominationEnabled: false, deepCoinsSource: () => new Set(),
    setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl,
    fetchImpl: async (url) => {
      if (url.includes('AssetPairs')) return { ok: true, json: async () => ({ error: [], result: pairs }) };
      tickerCalls += 1; return { ok: true, json: async () => ({ error: [], result: tickers }) };
    },
  });
  await clock.advance(60_000); assert.equal(tickerCalls, 1);
  // simulate an unknown cause: something set a far-future backoff so no tick sweeps
  eye._internals.setBackoffUntil(clock.now() + 3_600_000);
  await clock.advance(4 * 60_000); assert.equal(tickerCalls, 1, 'no sweeps while the backoff stands');
  await clock.advance(2 * 60_000);
  assert.ok(lines.some((l) => /WIDE EYE silent: no completed sweep for/.test(l)), lines.join('\n'));
  assert.ok(tickerCalls >= 2, 'the guard cleared the backoff and the eye swept again');
  eye.stop();
});
