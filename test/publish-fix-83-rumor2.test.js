// PUBLISH-FIX-83 — review findings in the RUMOR-2 collector (rumor2/collector.js): a WITHHELD / FAILED_DURABILITY collector no
// longer re-runs its whole initialization (checkpoint load + full journal read + social replay) every tick — the retry backs off
// 15 s -> 5 min; and the scheduler never queues a tick behind a tick that is still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRumor2 } from '../rumor2/collector.js';
import { memJournal } from './helpers/rumor2-journal.js';

const dirs = [];
const seedDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cobra-fix83-rumor2-')); dirs.push(d); process.env.COBRA_DATA_DIR = d; return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const CONFIG = { universe: ['BTC', 'ETH'] };
const T0 = Date.parse('2026-09-05T12:00:00Z');
const mkRes = (status, body = '') => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) });

function memStore({ saveDelayMs = 0 } = {}) {
  const s = { saved: null, failLoad: null, loads: 0, saves: 0 };
  return {
    state: s,
    async load() { s.loads += 1; if (s.failLoad) return s.failLoad; return s.saved === null ? { outcome: 'NOT_FOUND' } : { outcome: 'LOADED', state: structuredClone(s.saved) }; },
    async save(state) { s.saves += 1; if (saveDelayMs) await new Promise((r) => setTimeout(r, saveDelayMs)); s.saved = structuredClone(state); return { durable: true }; },
  };
}

test('FIX83-S1. a FAILED_DURABILITY collector retries its initialization on a back-off (15 s, 30 s, 60 s ... 5 min) instead of every tick, logs the withheld state once, and resumes on the first successful retry', async () => {
  seedDir(); const clock = { ms: T0 }; const store = memStore(); store.state.failLoad = { outcome: 'UNAVAILABLE', error: 'connection refused' }; const logs = [];
  const c = startRumor2({ log: (m) => logs.push(String(m)), config: CONFIG, fetchImpl: async () => mkRes(404, 'no'), now: () => clock.ms, intervalMs: 2_147_000_000, checkpointStore: store, journal: memJournal([]), contact: null, enabled: true, timeoutMs: 50 });
  try {
    await c.tickOnce(); assert.equal(c.internals.lifecycle, 'FAILED_DURABILITY'); assert.equal(store.state.loads, 1);
    for (let i = 0; i < 14; i += 1) { clock.ms += 1000; await c.tickOnce(); } assert.equal(store.state.loads, 1, 'no re-initialization inside the first 15 s');
    clock.ms += 1000; await c.tickOnce(); assert.equal(store.state.loads, 2, 'retried at 15 s');
    clock.ms += 29_000; await c.tickOnce(); assert.equal(store.state.loads, 2, 'the second wait is 30 s'); clock.ms += 1000; await c.tickOnce(); assert.equal(store.state.loads, 3);
    for (let i = 0; i < 5; i += 1) { clock.ms += 600_000; await c.tickOnce(); } assert.equal(store.state.loads, 8, 'the cap is 5 minutes: ticks 10 minutes apart each retry');
    assert.equal(logs.filter((l) => l.includes('FAILED_DURABILITY — connection refused')).length, 1, 'logged once, not per retry');
    store.state.failLoad = null; clock.ms += 300_000; await c.tickOnce();
    assert.notEqual(c.internals.lifecycle, 'FAILED_DURABILITY'); assert.equal(c.internals.lifecycle, 'FRESH_START');
  } finally { await c.stop(); }
});

test('FIX83-S2. an interval firing while a tick is still running is skipped, never queued: a slow tick cannot build an unbounded chain, and stop() returns promptly', async () => {
  seedDir(); const store = memStore({ saveDelayMs: 40 }); const logs = [];
  const c = startRumor2({ log: (m) => logs.push(String(m)), config: CONFIG, fetchImpl: async () => mkRes(404, 'no'), now: () => Date.now(), intervalMs: 5, checkpointStore: store, journal: memJournal([]), contact: null, enabled: true, timeoutMs: 50 });
  await new Promise((r) => setTimeout(r, 250)); // ~50 interval firings against ~40 ms ticks
  const t0 = Date.now(); await c.stop(); const stopMs = Date.now() - t0;
  assert.ok(store.state.saves <= 12, `ticks ran back to back, not 50 deep: ${store.state.saves} saves`);
  assert.ok(stopMs < 400, `stop() waited only for the running tick: ${stopMs} ms`);
  assert.ok(logs.some((l) => l.includes('tick still running')), 'the skipped firings are named');
});
